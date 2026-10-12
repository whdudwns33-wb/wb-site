#!/usr/bin/env node
/* 관리 가져오기(import) — node reading-server/admin-import.test.mjs
 *
 * 운영(KV)에서 뜬 export 를 이 PC 서버로 되읽는 길이다. 터널 문서의 결정 ㄱ
 * (docs/로컬-서버-외부공개-터널.md §1) — 이 서버는 **읽기 전용 검토용**이고, 그러려면
 * 운영 자료를 가져올 수단이 있어야 한다. export 는 양쪽에 있는데 되읽는 길이 없었다.
 *
 * 이 테스트가 지키는 것 넷. 전부 "조용히 틀리는" 종류라 사람 눈으로는 못 잡는다:
 *
 *  ① **제자리에서 고치는가.** server.mjs 가 기동 때 `const db = getDb()` 로 저장소 객체의
 *     참조를 붙들고, haruRoot()·letterRoot() 어댑터도 그 참조를 닫아 둔다. import 가 db 를
 *     재할당하면 모듈 안만 새 객체가 되고 서버는 옛 객체를 계속 본다 — "가져왔다"고 200 을
 *     받는데 화면은 그대로인, 가장 알아채기 어려운 고장이다. 그래서 가져온 뒤 **다른 라우트로**
 *     읽어 실제로 바뀌었는지 본다.
 *  ② **되돌릴 자리를 먼저 만드는가.** 덮어쓰기는 되돌릴 수 없다. 스냅샷을 못 만들면 덮지 않는다.
 *  ③ **되읽을 수 없는 칸을 조용히 넘기지 않는가.** haru·letter 는 dump 꼴이 저장 꼴과 달라
 *     그대로 넣으면 그 앱이 깨진다. skipped 로 돌려줘야 한다.
 *  ④ **본문(팩·단어장)을 지우지 않는가.** 스냅샷은 라이선스 본문을 일부러 뺀다. 그 자리를
 *     빈 값으로 덮으면 올려 둔 팩이 사라진다.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PIN = 'test-pin-not-a-real-secret';
const errors = [];
const ok = (c, m) => { if (!c) errors.push(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(port) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'wbr-imp-'));
  const env = { ...process.env, PORT: String(port), DATA_DIR: data, ADMIN_PIN: PIN };
  delete env.WB_ADMIN_ONLY;
  const srv = spawn(process.execPath, [path.join(DIR, 'server.mjs')], { env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { await fetch(base + '/api/health'); break; } catch { await sleep(100); }
  }
  return { srv, base, data, stop() { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); } };
}
const hdr = (t) => ({ 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) });
const post = (base, p, body, t) => fetch(base + p, { method: 'POST', headers: hdr(t), body: JSON.stringify(body) });
const get = (base, p, t) => fetch(base + p, { headers: hdr(t) });

/* 자체 창작 스냅샷 — 실명·실제 학교명 없이(절대 규칙 1) export 와 같은 꼴로 만든다 */
const snapshot = () => ({
  service: 'wb-reading', savedAt: '2026-10-12T00:00:00.000Z',
  students: { S1: { code: 'S1', name: '가학생', grade: '중2', cls: 'A' },
              S2: { code: 'S2', name: '나학생', grade: '중3', cls: 'B' } },
  states: { S1: { state: { note: '가져온 기록' }, updatedAt: '2026-10-11T00:00:00.000Z' } },
  vocab: { states: { S1: { x: 1 } }, mnemos: {}, push: {}, assigns: {} },
  portalFamilies: {}, textbook: { books: [] }, pubmap: {}, textbookSrc: { a: 'b' },
  naesin: { packIds: ['2022-ne-kimgitaek-m2-L6'], states: { S1: { s: 1 } },
            exams: { default: { examDate: '2026-11-01', packIds: ['2022-ne-kimgitaek-m2-L6'] } },
            tasks: {}, results: { S1: { '2026-11-01': { score: 88 } } } },
  hanja: { bookIds: ['bk1'], index: [{ id: 'bk1', title: '체험' }], states: {}, summaries: {}, assigns: {}, tasks: {}, remaps: {}, strokes: null },
  /* 되읽을 수 없는 칸 — skipped 로 나와야 한다 */
  haru: { packIds: [], paperkeys: {}, plans: {}, states: {}, mocks: {}, paper: {}, atoms: null },
  letter: { issues: {}, states: {}, push: {}, calendar: null, images: [] },
});

let s = null;
try {
  s = await boot(8660 + (process.pid % 40));
  const login = await post(s.base, '/api/admin/login', { pin: PIN });
  const token = (await login.json()).token;
  ok(!!token, '관리 로그인 토큰을 못 받았다');

  /* ── 인증 ── */
  const noAuth = await post(s.base, '/api/admin/import', { confirm: 'replace', snapshot: snapshot() });
  ok(noAuth.status === 401 || noAuth.status === 403, `인증 없는 가져오기가 통과했다 (${noAuth.status})`);

  /* ── ② 확인 없는 덮어쓰기는 거절 ── */
  const noConfirm = await post(s.base, '/api/admin/import', { snapshot: snapshot() }, token);
  ok(noConfirm.status === 400, `confirm 없이 덮어썼다 (${noConfirm.status})`);
  const nc = await noConfirm.json();
  ok(/confirm/.test(nc.error || ''), 'confirm 을 요구한다고 말해 주지 않는다');
  ok(nc.sections && Array.isArray(nc.sections.direct), '어떤 칸을 되읽는지 알려 주지 않는다');

  /* ── 남의 스냅샷은 거절 ── */
  const wrong = await post(s.base, '/api/admin/import',
    { confirm: 'replace', snapshot: { service: 'wb-desk', students: {} } }, token);
  ok(wrong.status === 400, `다른 서비스의 스냅샷을 받았다 (${wrong.status})`);

  /* ── 가져오기 전에 팩 본문을 하나 올려 둔다 (④ 검증용) ── */
  const packId = '2022-ne-kimgitaek-m2-L6';
  const up = await post(s.base, '/api/naesin/admin/pack',
    { id: packId, pack: { packId, words: [], sentences: [] } }, token);
  ok(up.ok, `팩 업로드 실패 (${up.status})`);

  /* ── 본 가져오기 ── */
  const r = await post(s.base, '/api/admin/import', { confirm: 'replace', snapshot: snapshot() }, token);
  ok(r.status === 200, `가져오기 실패 (${r.status})`);
  const out = await r.json();
  ok(out.ok === true, '가져오기가 ok 를 주지 않았다');

  /* ② 되돌릴 스냅샷을 먼저 만들었는가 */
  ok(/^\d{4}-\d{2}-\d{2}$/.test(out.backupDay || ''), `되돌릴 스냅샷 날짜가 없다: ${out.backupDay}`);
  const back = await get(s.base, '/api/admin/export?backup=' + out.backupDay, token);
  ok(back.status === 200, '되돌릴 스냅샷을 받을 수 없다 — 되돌릴 길 없이 덮었다');

  /* ③ 되읽을 수 없는 칸을 조용히 넘기지 않았는가 */
  const skipped = (out.skipped || []).map((x) => x.section).sort();
  ok(skipped.join(',') === 'haru,letter', `건너뛴 칸을 안 알려 준다: ${JSON.stringify(out.skipped)}`);
  ok((out.skipped || []).every((x) => x.why && x.why.length > 10), '왜 건너뛰었는지 적지 않았다');
  ok((out.applied || []).includes('students') && (out.applied || []).includes('naesin'),
    `적용한 칸 목록이 이상하다: ${JSON.stringify(out.applied)}`);

  /* ── ① 제자리에서 고쳤는가 — **다른 라우트로** 읽어 확인한다 ── */
  const ovr = await get(s.base, '/api/admin/overview', token);
  const codes = ((await ovr.json()).students || []).map((x) => x.code).sort();
  ok(codes.includes('S1') && codes.includes('S2'),
    `가져온 학생이 명부에 없다 — db 를 재할당해 서버가 옛 객체를 보고 있다: ${JSON.stringify(codes)}`);

  const ex = await get(s.base, '/api/naesin/admin/exams', token);
  const scopes = ((await ex.json()).exams || []).map((x) => x.scope);
  ok(scopes.includes('default'), `가져온 시험 배정이 안 보인다: ${JSON.stringify(scopes)}`);

  /* ④ 팩 본문을 지우지 않았는가 — 스냅샷에 packs 가 없다고 올려 둔 팩을 날리면 안 된다 */
  const packs = await get(s.base, '/api/naesin/admin/packs', token);
  const ids = ((await packs.json()).packs || []).map(String);
  ok(ids.includes(packId), `가져오기가 올려 둔 팩 본문을 지웠다: ${JSON.stringify(ids)}`);

  /* ── 망가진 입력에 500 을 내지 않는다 ── */
  for (const bad of [null, 7, 'nope', []]) {
    const br = await post(s.base, '/api/admin/import', { confirm: 'replace', snapshot: bad }, token);
    ok(br.status === 400 || br.status === 200, `망가진 스냅샷에 ${br.status} 를 냈다: ${JSON.stringify(bad)}`);
  }

  /* ── 워커에는 이 라우트가 없어야 한다 ── */
  const worker = fs.readFileSync(path.join(DIR, 'worker.mjs'), 'utf8');
  ok(!/\/api\/admin\/import/.test(worker),
    '워커에 가져오기 라우트가 생겼다 — 운영 데이터를 덮어쓰는 길이다. 로컬 서버 전용이어야 한다');
} finally {
  if (s) s.stop();
}

if (errors.length) { console.error('실패:\n - ' + errors.join('\n - ')); process.exit(1); }
console.log('OK — 인증·확인·되돌릴 스냅샷·건너뛴 칸 보고·제자리 수정·팩 본문 보존, 그리고 워커에 없는 것까지 통과');
