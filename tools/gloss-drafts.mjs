'use strict';
/* 뜻풀이 초안 — API 키 없이 운영하는 경로
 *
 * 서버가 자동으로 AI를 부르는 대신, 검수 대기 낱말을 내려받아 밖에서(예: Claude Code)
 * 초안을 만들고 다시 올린다. 올린 초안은 여전히 강사 검수함에서 승인해야 학생에게 나간다.
 *
 *   node tools/gloss-drafts.mjs pull  > /tmp/gloss.json     # 대기 낱말 내려받기
 *   (초안을 채운다 — 채우는 방법은 아래 "프롬프트")
 *   node tools/gloss-drafts.mjs push  < /tmp/gloss.json     # 초안 올리기
 *   node tools/gloss-drafts.mjs prompt                      # 초안 만들 때 쓸 지시문 출력
 *
 * 환경변수: WB_BASE (기본 http://localhost:8787), WB_ADMIN_PIN (필수)
 */

const BASE = (process.env.WB_BASE || 'http://localhost:8787').replace(/\/$/, '');
const PIN = process.env.WB_ADMIN_PIN || '';

const PROMPT = `아래 JSON은 학생이 글을 읽다가 몰라서 담아 온 낱말들이다. 각 항목의 draft를 채워라.

낱말마다 먼저 판정한다 — 온전한 낱말인가?
학생 앱은 어절에서 조사를 떼어 내며 낱말을 뽑는다. 그 과정에서 "스스"(스스로에서 '로'를 잘못 뗌),
"나르"(나르는)처럼 잘린 조각이 올 수 있다. 조각이면 draft를 {"valid":false,"word":"바른 형태","note":"이유"}로 한다.
사람 이름·지명·상표처럼 뜻풀이가 필요 없는 고유명사도 같다.

온전하면 draft를 이렇게 채운다:
{"valid":true,"word":"사전에 실리는 형태","type":"hanja|native|english","easy":"뜻","hanja":"…또는 null","example":"예문 또는 null"}

- word: 용언은 기본형("나르는"→"나르다"), 체언은 조사를 뗀 형태("연구자들이"→"연구자").
- easy: 한 문장, 40자 이내. 그 학년이 이미 아는 말로만. 뜻풀이 안에 그 낱말보다 어려운 말을 쓰지 않는다.
  (나쁜 예: "관측 — 천체를 관찰하여 측정함")
- context가 있으면 여러 뜻 중 그 문맥에 맞는 뜻 하나만 쓴다.
- type이 hanja면 hanja에 "觀(볼 관)+測(잴 측)" 형식으로 분해를 적는다. 확실하지 않으면 null.
- example: 학생 눈높이의 짧은 예문 하나. context 문장을 그대로 베끼지 않는다.

key는 그대로 두고, items 배열만 채운 같은 모양의 JSON으로 출력한다.`;

async function login() {
  if (!PIN) { console.error('WB_ADMIN_PIN 환경변수가 필요합니다.'); process.exit(1); }
  const r = await fetch(BASE + '/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: PIN }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.token) { console.error('관리자 로그인 실패:', j.error || r.status); process.exit(1); }
  return j.token;
}
const api = (token, path, opt) => fetch(BASE + path, Object.assign({
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
}, opt || {})).then(async (r) => {
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('요청 실패:', j.error || r.status); process.exit(1); }
  return j;
});

const readStdin = async () => {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
};

const cmd = process.argv[2];

if (cmd === 'prompt') {
  console.log(PROMPT);
} else if (cmd === 'pull') {
  const token = await login();
  const j = await api(token, '/api/vocab/admin/gloss');
  /* 초안이 아직 없는 대기 항목만 — 이미 초안이 있으면 검수함에서 바로 보면 된다 */
  const items = (j.items || [])
    .filter((it) => it.status === 'pending' && !it.draft)
    .map((it) => ({ key: it.key, word: it.word, context: it.context || '', grade: it.grade || '', draft: null }));
  console.log(JSON.stringify({ items }, null, 2));
  console.error(`대기 ${items.length}건을 내려받았습니다.` + (items.length ? '' : ' (채울 것이 없습니다)'));
} else if (cmd === 'push') {
  const raw = await readStdin();
  let data;
  try { data = JSON.parse(raw); } catch (e) { console.error('JSON을 읽지 못했습니다:', e.message); process.exit(1); }
  const items = (Array.isArray(data.items) ? data.items : []).filter((it) => it && it.key && it.draft);
  if (!items.length) { console.error('올릴 초안이 없습니다. draft를 채웠는지 확인하세요.'); process.exit(1); }
  const token = await login();
  const out = [];
  for (let i = 0; i < items.length; i += 100) {
    const j = await api(token, '/api/vocab/admin/gloss/draft', {
      method: 'POST', body: JSON.stringify({ items: items.slice(i, i + 100) }),
    });
    out.push(j);
  }
  const drafted = out.flatMap((j) => j.drafted || []);
  const skipped = out.flatMap((j) => j.skipped || []);
  console.error(`초안 ${drafted.length}건을 올렸습니다. 검수함에서 확인하고 승인해 주세요.`);
  if (skipped.length) console.error('건너뜀:', skipped.map((s) => `${s.key}(${s.why})`).join(', '));
} else {
  console.error(`사용법:
  node tools/gloss-drafts.mjs pull   > gloss.json    대기 낱말 내려받기
  node tools/gloss-drafts.mjs prompt                 초안 만들 때 쓸 지시문
  node tools/gloss-drafts.mjs push   < gloss.json    채운 초안 올리기

환경변수: WB_BASE (기본 ${BASE}), WB_ADMIN_PIN (필수)`);
  process.exit(1);
}
