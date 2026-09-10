'use strict';
/* WB 워드브레인 — /api/vocab/* 라우트 (server.mjs·worker.mjs 공용, "분리 가능한 A" 구조)
   격리 원칙: 라우트는 /api/vocab/* 아래, 데이터는 vocab 전용 저장소(워커: vocab: 접두 키, 로컬: db.vocab)만 쓴다.
   인증은 호스트(진로독서)의 토큰 검증 결과(who)를 그대로 받는다 — 학생은 연동 한 번으로 두 앱을 쓴다.
   나중에 단독 서비스로 분리할 때는 이 모듈 + vocab 저장소만 들어내면 된다. */

const STATE_MAX_BYTES = 400_000; // 워드브레인 기록 1건 최대 크기
const nowIso = () => new Date().toISOString();

/* ── AI 찰떡 연상 생성 (Claude API, raw fetch — 무의존성·Workers/Node 공용) ──
   기본 모델 claude-opus-5 + 서버측 refusal fallback 기본 활성. */
const AI_SYSTEM = `너는 WB 독해력학원의 어휘 연상(암기 고리) 작가다. 초등 고학년~중학생이 단어를 오래 기억하도록 짧고 선명한 연상을 만든다.

어종별 방식:
- english: 발음과 비슷한 우리말 키워드를 찾아 뜻과 이어지는 장면을 만든다(키워드 연상법). cue에 그 키워드 고리를 담는다.
- hanja: 제공된 한자의 훈(뜻)을 살려 글자들이 조립되어 뜻이 되는 이야기를 만든다.
- native: 뜻이 눈앞에 그려지는 구체적인 장면 하나를 만든다.

규칙:
- cue는 20자 안팎의 한 줄 연상 고리, scene은 1~2문장의 그림이 그려지는 장면.
- 약간 엉뚱하고 과장되게(기억에 남게), 그러나 밝고 유쾌하게.
- 금지: 폭력·공포·선정성·비하·놀림·특정 인물 조롱. 학생 관심사가 주어지면 자연스러울 때만 활용.
- 출력은 JSON 하나만. 형식: {"candidates":[{"cue":"...","scene":"..."},{"cue":"...","scene":"..."},{"cue":"...","scene":"..."}]}
- candidates는 서로 다른 접근의 연상 3개. JSON 밖에 다른 텍스트를 쓰지 않는다.`;

export function parseCandidates(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const d = JSON.parse(t.slice(start, end + 1));
    const arr = Array.isArray(d.candidates) ? d.candidates : null;
    if (!arr) return null;
    const out = arr
      .filter(c => c && typeof c.cue === 'string' && typeof c.scene === 'string')
      .map(c => ({ cue: c.cue.trim().slice(0, 120), scene: c.scene.trim().slice(0, 300) }))
      .filter(c => c.cue.length >= 2 && c.scene.length >= 4)
      .slice(0, 3);
    return out.length ? out : null;
  } catch (e) { return null; }
}

export async function aiMnemonic({ word, meaning, type, hanja, interests, apiKey, model }) {
  if (!apiKey) return { ok: false, reason: 'no-key' };
  const user = [
    '어종: ' + type,
    '단어: ' + word,
    '뜻: ' + meaning,
    hanja ? '한자: ' + hanja : null,
    interests ? '학생 관심사: ' + interests : null,
  ].filter(Boolean).join('\n');
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'server-side-fallback-2026-07-01',
      },
      body: JSON.stringify({
        model: model || 'claude-opus-5',
        max_tokens: 2000,
        fallbacks: 'default',
        system: AI_SYSTEM,
        messages: [{ role: 'user', content: user }],
      }),
    });
  } catch (e) { return { ok: false, reason: 'network' }; }
  if (!r.ok) return { ok: false, reason: 'api-' + r.status };
  const d = await r.json();
  if (d.stop_reason === 'refusal') return { ok: false, reason: 'refused' };
  const text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const candidates = parseCandidates(text);
  if (!candidates) return { ok: false, reason: 'parse' };
  return { ok: true, candidates, model: d.model };
}

/* ── AI 뜻풀이 (진로독서에서 밑줄 없이 담아 온 낱말) ──
   밑줄 낱말은 지문 데이터에 뜻이 붙어 있지만, 학생이 직접 담은 낱말에는 없다.
   AI가 초안을 만들고 강사가 승인해야 학생에게 나간다.

   연상(mnemonic)과 달리 pending 초안을 학생에게 내보내지 않는다 — 어긋난 연상은
   그냥 안 외워지지만, 어긋난 뜻은 그대로 외워진다. 검수 전 뜻은 학생 화면에 없다. */
const GLOSS_SYSTEM = `너는 WB 독해력학원의 어휘 뜻풀이 작가다. 학생이 글을 읽다가 몰라서 담아 온 낱말에, 그 아이가 바로 알아들을 뜻풀이를 붙인다.

먼저 판정한다 — 온전한 낱말인가?
학생 앱은 어절에서 조사를 떼어 내며 낱말을 뽑는다. 그 과정에서 "스스"(스스로에서 '로'를 잘못 뗌), "나르"(나르는)처럼 잘린 조각이 올 수 있다. 이런 조각이면 valid를 false로 하고 word에 바른 형태를 적는다.
온전하면 valid는 true이고, word에는 사전에 실리는 형태를 적는다 — 용언은 기본형("나르는"→"나르다"), 체언은 조사를 뗀 형태("연구자들이"→"연구자").
사람 이름·지명·상표처럼 뜻풀이가 필요 없는 고유명사도 valid를 false로 하고 note에 이유를 적는다.

뜻풀이 규칙:
- easy는 한 문장, 40자 이내. 그 학년이 이미 아는 말로만 쓴다.
- 뜻풀이 안에 그 낱말보다 어려운 말을 쓰지 않는다. (X: "관측 — 천체를 관찰하여 측정함")
- 문맥 문장이 주어지면, 여러 뜻 중 그 문맥에 맞는 뜻 하나만 쓴다.
- example은 학생 눈높이의 짧은 예문 하나. 문맥 문장을 그대로 베끼지 않는다.
- type: 한자로 쓰는 한자어면 hanja, 영어면 english, 그 밖은 native.
- type이 hanja면 hanja에 "觀(볼 관)+測(잴 측)" 형식으로 분해를 적는다. 확실하지 않으면 null.

출력은 JSON 하나만: {"valid":true,"word":"...","type":"hanja|native|english","easy":"...","hanja":"...|null","example":"...|null","note":""}
JSON 밖에 다른 텍스트를 쓰지 않는다.`;

export function parseGloss(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const d = JSON.parse(t.slice(a, b + 1));
    if (typeof d.valid !== 'boolean') return null;
    const word = typeof d.word === 'string' ? d.word.trim().slice(0, 40) : '';
    if (!word) return null;
    if (!d.valid) return { valid: false, word, note: (typeof d.note === 'string' ? d.note : '').trim().slice(0, 200) };
    if (!['hanja', 'native', 'english'].includes(d.type)) return null;
    const easy = typeof d.easy === 'string' ? d.easy.trim().slice(0, 200) : '';
    if (easy.length < 2) return null;
    return {
      valid: true, word, type: d.type, easy,
      hanja: typeof d.hanja === 'string' && d.hanja.trim() ? d.hanja.trim().slice(0, 120) : null,
      example: typeof d.example === 'string' && d.example.trim() ? d.example.trim().slice(0, 200) : null,
      note: (typeof d.note === 'string' ? d.note : '').trim().slice(0, 200),
    };
  } catch (e) { return null; }
}

export async function aiGloss({ word, context, grade, apiKey, model }) {
  if (!apiKey) return { ok: false, reason: 'no-key' };
  const user = [
    '학생이 담은 낱말: ' + word,
    context ? '그 낱말이 나온 문장: ' + context : null,
    grade ? '학생 학년: ' + grade : null,
  ].filter(Boolean).join('\n');
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'server-side-fallback-2026-07-01',
      },
      body: JSON.stringify({
        /* Opus 5는 thinking이 기본으로 켜지고 그 토큰도 max_tokens에 들어간다 —
           짧은 JSON이지만 잘리지 않게 넉넉히 잡는다 */
        model: model || 'claude-opus-5',
        max_tokens: 4000,
        fallbacks: 'default',
        system: GLOSS_SYSTEM,
        messages: [{ role: 'user', content: user }],
      }),
    });
  } catch (e) { return { ok: false, reason: 'network' }; }
  if (!r.ok) return { ok: false, reason: 'api-' + r.status };
  const d = await r.json();
  if (d.stop_reason === 'refusal') return { ok: false, reason: 'refused' };
  const text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const gloss = parseGloss(text);
  if (!gloss) return { ok: false, reason: 'parse' };
  return { ok: true, gloss, model: d.model };
}

/* ── 문장 짓기 판정 (산출 훈련) ── */
const SENT_SYSTEM = `너는 초등 고학년~중학생의 어휘 사용을 봐 주는 다정한 국어·영어 선생님이다.
학생이 방금 배운 낱말로 만든 문장이 그 낱말을 "뜻에 맞게, 자연스럽게" 썼는지 판정한다.

판정 기준:
- good : 뜻에 맞고 문장도 자연스럽다.
- ok   : 뜻은 맞지만 어색하거나 너무 단순하다(예: "나는 관측을 했다").
- wrong: 뜻에 맞지 않거나, 낱말이 문장에 없다.

규칙:
- feedback은 1~2문장, 반말이 아닌 친근한 존댓말. 잘한 점을 먼저 말하고 고칠 점을 짚는다.
- 절대 비난하지 않는다. 틀려도 다음에 어떻게 쓰면 되는지 알려 준다.
- better는 그 낱말을 잘 살린 예문 하나(학생 문장을 살려서 다듬으면 더 좋다).
- 영어 낱말이면 문장도 영어로 판정하고 better도 영어로 쓴다. feedback은 한국어.
- 출력은 JSON 하나만: {"verdict":"good|ok|wrong","feedback":"...","better":"..."}
- JSON 밖에 다른 텍스트를 쓰지 않는다.`;

export function parseVerdict(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const d = JSON.parse(t.slice(a, b + 1));
    if (!['good', 'ok', 'wrong'].includes(d.verdict)) return null;
    if (typeof d.feedback !== 'string' || !d.feedback.trim()) return null;
    return {
      verdict: d.verdict,
      feedback: d.feedback.trim().slice(0, 300),
      better: typeof d.better === 'string' ? d.better.trim().slice(0, 200) : '',
    };
  } catch (e) { return null; }
}

export async function aiSentence({ word, meaning, type, sentence, apiKey, model }) {
  if (!apiKey) return { ok: false, reason: 'no-key' };
  const user = ['어종: ' + type, '낱말: ' + word, '뜻: ' + meaning, '학생이 만든 문장: ' + sentence].join('\n');
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'server-side-fallback-2026-07-01',
      },
      body: JSON.stringify({
        model: model || 'claude-opus-5',
        max_tokens: 1000,
        fallbacks: 'default',
        system: SENT_SYSTEM,
        messages: [{ role: 'user', content: user }],
      }),
    });
  } catch (e) { return { ok: false, reason: 'network' }; }
  if (!r.ok) return { ok: false, reason: 'api-' + r.status };
  const d = await r.json();
  if (d.stop_reason === 'refusal') return { ok: false, reason: 'refused' };
  const text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const v = parseVerdict(text);
  if (!v) return { ok: false, reason: 'parse' };
  return { ok: true, ...v };
}

/* ── 강사 단어 배정 ──
   강사가 붙여넣은 단어 목록을 파싱해 학생별 배정함에 넣는다.
   한 줄 = 단어 | 뜻 | 한자(선택) | 예문(선택)   — 구분자는 | 또는 탭 또는 쉼표 */
const HANJA_RE = /[一-鿿]/;

export function parseWordList(text) {
  const out = [], seen = new Set(), errors = [];
  const lines = String(text || '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const cols = line.split(/\s*[|\t]\s*|\s*,\s*/).map(c => c.trim()).filter((c, k) => c || k === 0);
    const word = cols[0], meaning = cols[1];
    if (!word) return;
    if (!meaning) { errors.push((i + 1) + '행: 뜻이 없어요 — "' + line.slice(0, 24) + '"'); return; }
    if (word.length > 40 || meaning.length > 200) { errors.push((i + 1) + '행: 너무 길어요'); return; }
    const key = word.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    const rest = cols.slice(2);
    const hanjaCol = rest.find(c => HANJA_RE.test(c)) || '';
    const example = rest.find(c => c && c !== hanjaCol) || '';
    const parts = parseHanjaSpec(hanjaCol);
    const type = /^[A-Za-z][A-Za-z\s'-]*$/.test(word) ? 'english' : (parts ? 'hanja' : 'native');

    const w = { word, meaning, type };
    if (parts) {
      w.parts = parts;
      w.hanja = parts.map(p => p.ch).join('');
      w.literal = parts.map(p => p.hun).join(' · ');
    }
    if (example) w.example = example.slice(0, 200);
    out.push(w);
  });
  return { words: out, errors };
}

/* '觀(볼 관)+測(잴 측)' 또는 '觀測' 둘 다 받는다 */
export function parseHanjaSpec(str) {
  if (!str) return null;
  const withGloss = [];
  const re = /([一-鿿])\s*\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(str))) {
    const inner = m[2].trim(), sp = inner.lastIndexOf(' ');
    withGloss.push(sp < 0 ? { ch: m[1], hun: inner, eum: inner } : { ch: m[1], hun: inner.slice(0, sp), eum: inner.slice(sp + 1) });
  }
  if (withGloss.length) return withGloss;
  const bare = String(str).match(/[一-鿿]/g);
  if (!bare || !bare.length) return null;
  return bare.map(ch => ({ ch, hun: '', eum: '' }));   // 훈음 미상 — 화면에서 한자만 보여 준다
}

const ASSIGN_KEEP = 20;   // 학생당 보관하는 배정 묶음 수

/* ── 학생별 워드브레인 요약 (강사 현황판·검수 페이지용) ── */
const INTERVAL_DAYS = [0, 1, 3, 7, 14, 30, 90];
export function vocabSummary(stateRec) {
  const base = { linked: !!stateRec, total: 0, graduated: 0, due: 0, emergency: 0, streak: 0, msAvg: null, lastActive: stateRec ? stateRec.updatedAt : null };
  const S = stateRec && stateRec.state;
  if (!S || !S.states) return base;
  const now = Date.now();
  let msSum = 0, msN = 0;
  for (const s of Object.values(S.states)) {
    base.total += 1;
    if (s.emaMs) { msSum += s.emaMs; msN += 1; }
    if (s.graduated) { base.graduated += 1; continue; }
    if (s.due <= now) {
      base.due += 1;
      const iv = Math.max(INTERVAL_DAYS[Math.min(s.step || 0, 6)] || 0, 0.5) * 86400000;
      if ((now - s.due) / iv >= 1.25) base.emergency += 1;
    }
  }
  if (msN) base.msAvg = Math.round(msSum / msN);
  base.streak = (S.streak && S.streak.count) || 0;
  return base;
}

const mnemoKey = (word) => String(word || '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 60);
const glossKey = mnemoKey;
/* AI 호출은 돈이 든다. 클라이언트 상한(하루 15개)은 우회할 수 있으므로 서버에서도 막는다.
   캐시 적중은 세지 않는다 — 같은 낱말은 학원 전체가 한 번만 생성한다. */
const GLOSS_DAILY_MAX = 20;
const dayKey = () => new Date().toISOString().slice(0, 10);

/* ── 밤 9시 물주기 푸시 (페이로드 없는 Web Push — VAPID 서명만, 암호화·의존성 불필요) ── */
function b64u(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  const b64 = (typeof btoa === 'function') ? btoa(s) : Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function vapidJwt({ audience, subject, privateJwk }) {
  const enc = new TextEncoder();
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64u(enc.encode(JSON.stringify({
    aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject,
  })));
  const key = await crypto.subtle.importKey('jwk', JSON.parse(privateJwk), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(header + '.' + payload));
  return header + '.' + payload + '.' + b64u(sig);
}

function dueCountOf(stateRec) {
  const S = stateRec && stateRec.state;
  if (!S || !S.states) return 0;
  const now = Date.now();
  let n = 0;
  for (const s of Object.values(S.states)) if (!s.graduated && s.due <= now) n += 1;
  return n;
}

/* 구독자 중 "물 줄 단어가 있는" 학생에게만 발송. 404/410 응답이면 구독 정리. */
export async function sendNightPushes({ store, push, fetchFn }) {
  if (!push || !push.publicKey || !push.privateJwk) return { sent: 0, skipped: 0, removed: 0, reason: 'no-vapid' };
  const f = fetchFn || fetch;
  let sent = 0, skipped = 0, removed = 0;
  for (const code of await store.listPushCodes()) {
    const sub = await store.getPush(code);
    if (!sub || !sub.endpoint) continue;
    if (!dueCountOf(await store.getState(code))) { skipped += 1; continue; }
    try {
      const jwt = await vapidJwt({
        audience: new URL(sub.endpoint).origin,
        subject: push.subject || 'mailto:admin@wb.local',
        privateJwk: push.privateJwk,
      });
      const r = await f(sub.endpoint, {
        method: 'POST',
        headers: { TTL: '86400', Urgency: 'normal', Authorization: 'vapid t=' + jwt + ', k=' + push.publicKey },
      });
      if (r.status === 404 || r.status === 410) { await store.delPush(code); removed += 1; }
      else sent += 1;
    } catch (e) { /* 이 학생은 내일 재시도 */ }
  }
  return { sent, skipped, removed };
}

/* ── 라우터 ──
   ctx = {
     path, method, who,                    // who: {code, admin} | null — 호스트가 검증한 토큰
     getBody: async () => object,
     store: {                              // vocab 전용 저장소 어댑터 (전부 async 허용)
       getState(code), putState(code, rec),
       listStateCodes(), getStudent(code),
       getMnemo(key), putMnemo(key, rec), listMnemos(),
       getGloss(key), putGloss(key, rec), listGlosses(),
       getGlossQuota(code), putGlossQuota(code, rec),
       getPush(code), putPush(code, rec), delPush(code), listPushCodes(),
       getAssign(code), putAssign(code, rec), listAssignCodes(),
     },
     ai: { apiKey, model, generate? },     // generate는 테스트 주입용 (기본 aiMnemonic)
     push: { publicKey, privateJwk, subject },  // VAPID (없으면 알림 기능만 비활성)
   }
   반환: { status, body } — /api/vocab/* 이 아닌 경로는 호출 전에 호스트가 거른다. */
export async function handleVocab(ctx) {
  const { path: p, method, who, store } = ctx;
  const j = (status, body) => ({ status, body });
  if (!who) return j(401, { error: '로그인이 필요합니다.' });

  /* ── 학생 ── */
  if (p === '/api/vocab/pull' && method === 'GET' && !who.admin) {
    const st = await store.getState(who.code);
    return j(200, { state: st ? st.state : null, updatedAt: st ? st.updatedAt : null });
  }
  if (p === '/api/vocab/state' && method === 'PUT' && !who.admin) {
    const { state } = await ctx.getBody();
    if (!state || typeof state !== 'object') return j(400, { error: 'state 필요' });
    const rec = { state, updatedAt: nowIso() };
    if (JSON.stringify(rec).length > STATE_MAX_BYTES) return j(413, { error: '기록이 너무 커서 저장할 수 없어요.' });
    await store.putState(who.code, rec);
    return j(200, { ok: true, updatedAt: rec.updatedAt });
  }
  if (p === '/api/vocab/mnemonic' && method === 'POST' && !who.admin) {
    const b = await ctx.getBody();
    const word = String(b.word || '').trim();
    const meaning = String(b.meaning || '').trim();
    const type = String(b.type || '').trim();
    if (!word || word.length > 80 || !meaning || meaning.length > 300) return j(400, { error: '단어와 뜻이 필요해요.' });
    if (!['english', 'hanja', 'native'].includes(type)) return j(400, { error: '어종은 english/hanja/native' });
    const key = mnemoKey(word);
    const prev = await store.getMnemo(key);
    if (prev && prev.status === 'approved' && prev.approved) {
      return j(200, { ok: true, status: 'approved', candidates: [prev.approved] });
    }
    if (prev && prev.status === 'pending' && prev.candidates) {
      return j(200, { ok: true, status: 'pending', candidates: prev.candidates });
    }
    const generate = ctx.ai.generate || aiMnemonic;
    const out = await generate({
      word, meaning, type,
      hanja: b.hanja ? String(b.hanja).slice(0, 200) : undefined,
      interests: b.interests ? String(b.interests).slice(0, 100) : undefined,
      apiKey: ctx.ai.apiKey, model: ctx.ai.model,
    });
    if (!out.ok) return j(200, { ok: false, reason: out.reason });
    await store.putMnemo(key, {
      key, word, meaning, type, candidates: out.candidates,
      requestedBy: who.code, at: nowIso(), status: 'pending', model: out.model || null,
    });
    return j(200, { ok: true, status: 'pending', candidates: out.candidates });
  }
  /* 검수 결과 확인 (AI 재호출 없음) — 학생 앱이 부팅 시 pending 단어의 승인/반려를 반영 */
  if (p === '/api/vocab/mnemonic/check' && method === 'POST' && !who.admin) {
    const b = await ctx.getBody();
    const words = (Array.isArray(b.words) ? b.words : []).slice(0, 50);
    const items = [];
    for (const wRaw of words) {
      const word = String(wRaw || '').trim();
      if (!word) continue;
      const rec = await store.getMnemo(mnemoKey(word));
      items.push({
        word,
        status: rec ? rec.status : 'none',
        approved: rec && rec.status === 'approved' ? rec.approved : undefined,
      });
    }
    return j(200, { items });
  }

  /* 뜻풀이 요청 — 진로독서에서 담아 온 낱말. 승인된 뜻만 학생에게 나간다. */
  if (p === '/api/vocab/gloss' && method === 'POST' && !who.admin) {
    const b = await ctx.getBody();
    const word = String(b.word || '').trim();
    if (!word || word.length > 30) return j(400, { error: '낱말이 필요해요 (30자 이내).' });
    const key = glossKey(word);
    const prev = await store.getGloss(key);
    if (prev && prev.status === 'approved' && prev.approved) {
      return j(200, { ok: true, status: 'approved', gloss: prev.approved });
    }
    /* 검수 전에는 초안을 내보내지 않는다 — 어긋난 뜻은 그대로 외워진다 */
    if (prev && (prev.status === 'pending' || prev.status === 'rejected')) {
      return j(200, { ok: true, status: prev.status });
    }
    const context = b.context ? String(b.context).slice(0, 300) : '';
    const queue = (draft, model) => store.putGloss(key, {
      key, word, draft: draft || null, context,
      requestedBy: who.code, grade: b.grade ? String(b.grade).slice(0, 20) : '',
      at: nowIso(), status: 'pending', approved: null, model: model || null,
    });
    /* AI 초안은 거들 뿐이다 — 키가 없거나 생성이 실패해도 낱말은 검수함에 올린다.
       그래야 강사가 뜻을 직접 채우거나 밖에서 만든 초안을 올릴 수 있다.
       (구독으로 운영할 때의 기본 경로: tools/gloss-drafts.mjs) */
    if (!ctx.ai.apiKey && !ctx.ai.gloss) { await queue(null); return j(200, { ok: true, status: 'pending', drafted: false }); }
    const quota = (await store.getGlossQuota(who.code)) || { day: '', n: 0 };
    if (quota.day !== dayKey()) { quota.day = dayKey(); quota.n = 0; }
    if (quota.n >= GLOSS_DAILY_MAX) { await queue(null); return j(200, { ok: true, status: 'pending', drafted: false, reason: 'quota' }); }
    const generate = ctx.ai.gloss || aiGloss;
    const out = await generate({
      word, context: context || undefined,
      grade: b.grade ? String(b.grade).slice(0, 20) : undefined,
      apiKey: ctx.ai.apiKey, model: ctx.ai.model,
    });
    if (!out.ok) { await queue(null); return j(200, { ok: true, status: 'pending', drafted: false, reason: out.reason }); }
    quota.n += 1;
    await store.putGlossQuota(who.code, quota);
    await queue(out.gloss, out.model);
    return j(200, { ok: true, status: 'pending', drafted: true });
  }
  /* 검수 결과 확인 (AI 재호출 없음) — 학생 앱이 부팅 시 담아 둔 낱말의 승인을 반영 */
  if (p === '/api/vocab/gloss/check' && method === 'POST' && !who.admin) {
    const b = await ctx.getBody();
    const words = (Array.isArray(b.words) ? b.words : []).slice(0, 50);
    const items = [];
    for (const wRaw of words) {
      const word = String(wRaw || '').trim();
      if (!word) continue;
      const rec = await store.getGloss(glossKey(word));
      items.push({
        word,
        status: rec ? rec.status : 'none',
        gloss: rec && rec.status === 'approved' ? rec.approved : undefined,
      });
    }
    return j(200, { items });
  }

  /* 문장 짓기 — 산출 훈련 (AI 판정) */
  if (p === '/api/vocab/sentence' && method === 'POST' && !who.admin) {
    const b = await ctx.getBody();
    const word = String(b.word || '').trim();
    const meaning = String(b.meaning || '').trim();
    const type = String(b.type || '').trim();
    const sentence = String(b.sentence || '').trim();
    if (!word || !meaning || !sentence) return j(400, { error: '낱말과 문장이 필요해요.' });
    if (sentence.length > 300) return j(400, { error: '문장이 너무 길어요 (300자 이내).' });
    if (!['english', 'hanja', 'native'].includes(type)) return j(400, { error: '어종은 english/hanja/native' });
    const judge = ctx.ai.judge || aiSentence;
    const out = await judge({ word, meaning, type, sentence, apiKey: ctx.ai.apiKey, model: ctx.ai.model });
    if (!out.ok) return j(200, { ok: false, reason: out.reason });
    return j(200, { ok: true, verdict: out.verdict, feedback: out.feedback, better: out.better });
  }

  /* 선생님이 내주신 단어 */
  if (p === '/api/vocab/assignments' && method === 'GET' && !who.admin) {
    const rec = await store.getAssign(who.code);
    const items = ((rec && rec.items) || []).filter(a => !a.done);
    return j(200, { items });
  }
  if (p === '/api/vocab/assignments/ack' && method === 'POST' && !who.admin) {
    const { id } = await ctx.getBody();
    const rec = (await store.getAssign(who.code)) || { items: [] };
    const hit = (rec.items || []).filter(a => a.id === id)[0];
    if (!hit) return j(404, { error: '배정을 찾을 수 없어요.' });
    hit.done = true;
    hit.doneAt = nowIso();
    await store.putAssign(who.code, rec);
    return j(200, { ok: true });
  }

  /* 밤 9시 알림 (Web Push 구독) */
  if (p === '/api/vocab/push/key' && method === 'GET' && !who.admin) {
    const key = ctx.push && ctx.push.publicKey;
    return j(200, key ? { ok: true, key } : { ok: false, reason: 'no-vapid' });
  }
  if (p === '/api/vocab/push/subscribe' && method === 'POST' && !who.admin) {
    const { subscription } = await ctx.getBody();
    const ep = subscription && String(subscription.endpoint || '');
    if (!ep || ep.length > 500 || !/^https:\/\//.test(ep)) return j(400, { error: '유효한 구독이 아니에요.' });
    await store.putPush(who.code, { endpoint: ep, at: nowIso() });
    return j(200, { ok: true });
  }
  if (p === '/api/vocab/push/unsubscribe' && method === 'POST' && !who.admin) {
    await store.delPush(who.code);
    return j(200, { ok: true });
  }

  /* ── 관리자 (강사) ── */
  if (!who.admin) return j(403, { error: '권한이 없습니다.' });

  if (p === '/api/vocab/admin/review' && method === 'GET') {
    const items = await store.listMnemos();
    items.sort((a, b) => (a.status === 'pending') === (b.status === 'pending') ? (a.at < b.at ? 1 : -1) : (a.status === 'pending' ? -1 : 1));
    return j(200, { items, time: nowIso() });
  }
  if (p === '/api/vocab/admin/review' && method === 'POST') {
    const { key, action, cue, scene } = await ctx.getBody();
    const rec = key && await store.getMnemo(mnemoKey(key));
    if (!rec) return j(404, { error: '검수 항목 없음' });
    if (action === 'approve') {
      if (!cue || !scene) return j(400, { error: '승인할 연상(cue·scene)이 필요해요.' });
      rec.status = 'approved';
      rec.approved = { cue: String(cue).slice(0, 120), scene: String(scene).slice(0, 300) };
      rec.decidedAt = nowIso();
    } else if (action === 'reject') {
      rec.status = 'rejected';
      rec.approved = null;
      rec.decidedAt = nowIso();
    } else return j(400, { error: 'action은 approve/reject' });
    await store.putMnemo(rec.key, rec);
    return j(200, { ok: true, item: rec });
  }
  if (p === '/api/vocab/admin/gloss' && method === 'GET') {
    const items = await store.listGlosses();
    items.sort((a, b) => (a.status === 'pending') === (b.status === 'pending') ? (a.at < b.at ? 1 : -1) : (a.status === 'pending' ? -1 : 1));
    return j(200, { items, time: nowIso() });
  }
  /* 초안 채워 넣기 — API 대신 구독(Claude Code 등)으로 만든 뜻풀이를 올리는 경로.
     승인이 아니다. 올린 뒤에도 강사가 검수함에서 확인하고 승인해야 학생에게 나간다. */
  if (p === '/api/vocab/admin/gloss/draft' && method === 'POST') {
    const b = await ctx.getBody();
    const list = Array.isArray(b.items) ? b.items.slice(0, 100) : [];
    if (!list.length) return j(400, { error: '올릴 초안이 없어요.' });
    const done = [], skipped = [];
    for (const it of list) {
      const rec = it && it.key && await store.getGloss(glossKey(it.key));
      if (!rec) { skipped.push({ key: it && it.key, why: 'not-found' }); continue; }
      if (rec.status !== 'pending') { skipped.push({ key: rec.key, why: rec.status }); continue; }
      const d = it.draft || {};
      if (d.valid === false) {
        rec.draft = { valid: false, word: String(d.word || rec.word).trim().slice(0, 40),
                      note: String(d.note || '').trim().slice(0, 200) };
      } else {
        const easy = String(d.easy || '').trim().slice(0, 200);
        if (easy.length < 2) { skipped.push({ key: rec.key, why: 'no-easy' }); continue; }
        rec.draft = {
          valid: true,
          word: String(d.word || rec.word).trim().slice(0, 40),
          type: ['hanja', 'native', 'english'].includes(d.type) ? d.type : 'native',
          easy,
          hanja: d.hanja ? String(d.hanja).trim().slice(0, 120) : null,
          example: d.example ? String(d.example).trim().slice(0, 200) : null,
          note: String(d.note || '').trim().slice(0, 200),
        };
      }
      rec.draftedAt = nowIso();
      rec.model = it.model ? String(it.model).slice(0, 60) : (rec.model || null);
      await store.putGloss(rec.key, rec);
      done.push(rec.key);
    }
    return j(200, { ok: true, drafted: done, skipped });
  }
  if (p === '/api/vocab/admin/gloss' && method === 'POST') {
    const { key, action, word, easy, hanja, example, type } = await ctx.getBody();
    const rec = key && await store.getGloss(glossKey(key));
    if (!rec) return j(404, { error: '검수 항목 없음' });
    if (action === 'approve') {
      /* 강사가 고친 값이 오면 그것을, 없으면 초안을 그대로 승인한다 */
      const d = rec.draft || {};
      const finalWord = String(word || d.word || rec.word).trim().slice(0, 40);
      const finalEasy = String(easy || d.easy || '').trim().slice(0, 200);
      if (!finalWord || finalEasy.length < 2) return j(400, { error: '승인할 낱말과 뜻이 필요해요.' });
      const t = ['hanja', 'native', 'english'].includes(type) ? type : (d.type || 'native');
      rec.status = 'approved';
      rec.approved = {
        word: finalWord, easy: finalEasy, type: t,
        hanja: (hanja !== undefined ? hanja : d.hanja) ? String(hanja !== undefined ? hanja : d.hanja).trim().slice(0, 120) : null,
        example: (example !== undefined ? example : d.example) ? String(example !== undefined ? example : d.example).trim().slice(0, 200) : null,
      };
      rec.decidedAt = nowIso();
    } else if (action === 'reject') {
      rec.status = 'rejected';
      rec.approved = null;
      rec.decidedAt = nowIso();
    } else return j(400, { error: 'action은 approve/reject' });
    await store.putGloss(rec.key, rec);
    return j(200, { ok: true, item: rec });
  }
  if (p === '/api/vocab/admin/assign' && method === 'POST') {
    const b = await ctx.getBody();
    const codes = (Array.isArray(b.codes) ? b.codes : []).map(c => String(c || '').trim()).filter(Boolean).slice(0, 200);
    const title = String(b.title || '').trim().slice(0, 60) || '선생님 배정 단어';
    const parsed = parseWordList(b.text);
    if (b.dryRun) return j(200, { ok: true, preview: true, words: parsed.words, errors: parsed.errors });
    if (!codes.length) return j(400, { error: '배정할 학생을 골라 주세요.' });
    if (!parsed.words.length) return j(400, { error: '배정할 단어가 없어요.', errors: parsed.errors });
    if (parsed.words.length > 100) return j(400, { error: '한 번에 100개까지 배정할 수 있어요.' });
    const id = 'a' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
    const at = nowIso();
    const assigned = [];
    for (const code of codes) {
      const stu = await store.getStudent(code);
      if (!stu) continue;
      const rec = (await store.getAssign(code)) || { items: [] };
      rec.items = [{ id, title, at, words: parsed.words, done: false }].concat(rec.items || []).slice(0, ASSIGN_KEEP);
      await store.putAssign(code, rec);
      assigned.push(code);
    }
    if (!assigned.length) return j(404, { error: '등록된 학생이 없어요.' });
    return j(200, { ok: true, id, assigned, count: parsed.words.length, errors: parsed.errors });
  }
  if (p === '/api/vocab/admin/assign' && method === 'GET') {
    const out = [];
    for (const code of await store.listAssignCodes()) {
      const rec = await store.getAssign(code);
      const stu = await store.getStudent(code);
      ((rec && rec.items) || []).forEach(a => {
        out.push({ code, name: (stu && stu.name) || '', id: a.id, title: a.title, at: a.at, n: (a.words || []).length, done: !!a.done, doneAt: a.doneAt || null });
      });
    }
    out.sort((x, y) => (x.at < y.at ? 1 : -1));
    return j(200, { items: out.slice(0, 200) });
  }
  if (p === '/api/vocab/admin/overview' && method === 'GET') {
    const codes = await store.listStateCodes();
    const students = [];
    for (const code of codes) {
      const [stu, st] = await Promise.all([store.getStudent(code), store.getState(code)]);
      students.push({ code, name: (stu && stu.name) || '', cls: (stu && stu.cls) || '', ...vocabSummary(st) });
    }
    return j(200, { students, time: nowIso() });
  }
  return j(404, { error: 'unknown api' });
}

/* 백업 스냅샷용 전체 덤프 */
export async function dumpVocab(store) {
  const states = {};
  for (const code of await store.listStateCodes()) states[code] = await store.getState(code);
  const mnemos = {};
  for (const m of await store.listMnemos()) mnemos[m.key] = m;
  const glosses = {};
  for (const g of await store.listGlosses()) glosses[g.key] = g;
  const assigns = {};
  for (const code of await store.listAssignCodes()) assigns[code] = await store.getAssign(code);
  return { states, mnemos, glosses, assigns };
}
