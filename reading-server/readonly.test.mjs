#!/usr/bin/env node
/* 읽기 전용 모드 — node reading-server/readonly.test.mjs
 *
 * 터널 문서의 결정 ㄱ(docs/로컬-서버-외부공개-터널.md §1): 이 PC 서버는 운영(KV)에서 뜬 자료를
 * 가져와 **보기만** 하는 자리다. 그 결정이 문서에만 있으면 지켜지지 않는다 — 원장·강사도
 * 이 주소에서 팩을 하나 올리는 순간 운영과 db.json 이 갈리고, 어느 쪽이 정본인지 아무도 모르게
 * 된다. WB_ADMIN_ONLY 가 '누가 들어오나'를 좁히고, WB_READONLY 가 '무엇을 할 수 있나'를 좁힌다.
 *
 * 이 테스트가 지키는 것 다섯:
 *  ① 모드를 안 켜면 쓰기가 된다 — 게이트를 시험하는 것이지 고장 난 서버를 시험하는 게 아니다.
 *  ② 모드를 켜면 쓰기 메서드가 403 이다. 라우트별이 아니라 **메서드**로 막으므로, 나중에
 *     새 쓰기 라우트가 생겨도 저절로 막힌다(그 빠뜨림이 이 모드가 생긴 이유다).
 *  ③ 두 자리는 열려 있다 — 관리 로그인(열지 않으면 화면을 볼 수 없다)과 가져오기(모드의 목적).
 *  ④ 가져오기는 **디스크까지** 간다. 재기동해도 남아야 한다 — persist() 가 모드에 잠겨 있어서
 *     "가져왔다는데 재기동하니 없다"가 가장 그럴듯한 고장이다.
 *  ⑤ 읽기는 그대로 된다. 보기 위해 켠 모드가 보기를 막으면 뜻이 없다.
 *
 * 그리고 HTTP 밖의 한 겹 — store 의 persist() 자체가 잠기는지도 본다. GET 이면서 쓰는 라우트
 * (연동 nonce 정리 같은)가 있어 메서드 게이트만으로는 db.json 이 안 바뀐다고 말할 수 없다.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PIN = 'test-pin-not-a-real-secret';
const errors = [];
const ok = (c, m) => { if (!c) errors.push(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 빈 포트를 OS 에서 받는다 — 테스트마다 포트 띠를 손으로 나누면 언젠가 겹친다.
   실제로 겹쳤다: 이 파일이 쓰던 8700·8740·8780 띠가 sec-headers.test.mjs 의 8700+(pid%90)
   안에 있어서, 같은 pid 로 두 테스트가 동시에 돌면 늦게 bind 한 자식이 EADDRINUSE 로 죽고 —
   둘 다 stdio:'ignore' 라 기동 실패를 확인하지 않으므로 — **상대 테스트의 서버에 붙어**
   엉뚱한 결과를 냈다(ADMIN_PIN 이 같아 로그인까지 통과한다. 읽기 전용 아닌 서버에 붙으면
   이 파일의 403 단정이 전부 깨지고, 반대로 붙으면 상대가 깨진다). check.mjs 가 8레인
   병렬이라 두 파일은 거의 항상 동시에 산다. */
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

async function boot(extra, data) {
  const port = await freePort();
  const dir = data || fs.mkdtempSync(path.join(os.tmpdir(), 'wbr-ro-'));
  const env = { ...process.env, PORT: String(port), DATA_DIR: dir, ADMIN_PIN: PIN, ...extra };
  delete env.WB_ADMIN_ONLY;
  if (!extra || !extra.WB_READONLY) delete env.WB_READONLY;
  const srv = spawn(process.execPath, [path.join(DIR, 'server.mjs')], { env, stdio: 'ignore' });
  /* 자식이 조기 종료하면 **침묵하지 않는다** — 안 보면 남의 서버에 붙어 시험이 거짓으로 통과한다 */
  let died = null;
  srv.on('exit', (code, sig) => { died = `code=${code} signal=${sig}`; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (died) throw new Error('서버가 기동 중에 죽었다: ' + died);
    try { await fetch(base + '/api/health'); break; } catch { await sleep(100); }
  }
  return { srv, base, dir, stop() { srv.kill(); } };
}
const hdr = (t) => ({ 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) });
const send = (base, m, p, body, t) => fetch(base + p, { method: m, headers: hdr(t), body: body === undefined ? undefined : JSON.stringify(body) });
const login = async (base) => (await (await send(base, 'POST', '/api/admin/login', { pin: PIN })).json()).token;

/* 자체 창작 스냅샷 — 실명·실제 학교명 없이(절대 규칙 1) */
const snapshot = () => ({
  service: 'wb-reading', savedAt: '2026-10-12T00:00:00.000Z',
  /* ptoken 이 **없는** 학생이다 — 가족 링크를 찍어내는 GET 라우트를 시험하려면 그래야 한다 */
  students: { RR1: { code: 'RR1', name: '가학생', grade: '중2', cls: 'A' } },
  states: { RR1: { state: { note: '앱 연동' }, updatedAt: '2026-10-11T00:00:00.000Z' } },
  vocab: { states: {}, mnemos: {}, push: {}, assigns: {} },
  portalFamilies: {}, textbook: {}, pubmap: {}, textbookSrc: {},
  naesin: { packIds: [], states: {}, exams: {}, tasks: {}, results: {} },
  hanja: { index: [], states: {}, summaries: {}, assigns: {}, tasks: {}, remaps: {}, strokes: null },
});

/* 쓰기 라우트 표본 — 메서드가 섞여 있어야 메서드 게이트를 제대로 시험한다.
   본문이 유효하지 않아도 403 이어야 한다(아래 textbook-src 가 그 경우다) — 게이트가 본문 검증보다
   앞에 있어야 한다는 뜻이다. 400 이 돌아오면 라우트가 이미 돌았다는 말이라 그것도 실패다. */
const WRITES = [
  ['POST', '/api/admin/students', { code: 'ZZ9', name: '다학생', grade: '중2' }],
  ['DELETE', '/api/admin/students', { code: 'ZZ9' }],
  ['PUT', '/api/admin/textbook-src', { id: 'x', text: 'y' }],
  ['POST', '/api/naesin/admin/pack', { id: '2022-ne-kimgitaek-m2-L6', pack: { packId: '2022-ne-kimgitaek-m2-L6', words: [], sentences: [] } }],
  ['POST', '/api/naesin/admin/exam', { scope: 'default', examDate: '2026-11-01', packIds: ['2022-ne-kimgitaek-m2-L6'] }],
];

let open = null, ro = null;
try {
  /* ── ① 모드를 안 켜면 쓰기가 된다 ── */
  open = await boot();
  const t0 = await login(open.base);
  ok(!!t0, '모드를 끈 서버에서 관리 로그인을 못 했다');
  const made = await send(open.base, 'POST', '/api/admin/students', { code: 'ZZ9', name: '다학생', grade: '중2' }, t0);
  ok(made.ok, `모드를 끈 서버에서 학생 등록이 안 된다 (${made.status}) — 게이트가 아니라 서버가 고장이다`);
  const h0 = await (await fetch(open.base + '/api/health')).json();
  ok(h0.readonly === undefined, '모드를 끄면 health 에 readonly 가 없어야 한다');
  open.stop(); open = null;

  /* ── 모드를 켠 서버 ── */
  ro = await boot({ WB_READONLY: '1' });
  const h1 = await (await fetch(ro.base + '/api/health')).json();
  ok(h1.readonly === true, 'health 가 읽기 전용임을 알리지 않는다 — 어느 주소인지 사람이 가릴 수 없다');

  /* ── ③ 관리 로그인은 열려 있다 ── */
  const t = await login(ro.base);
  ok(!!t, '읽기 전용 모드에서 관리 로그인이 막혔다 — 열지 않으면 화면을 볼 수 없다');

  /* ── ② 쓰기 메서드는 403 ── */
  for (const [m, p, body] of WRITES) {
    const r = await send(ro.base, m, p, body, t);
    ok(r.status === 403, `읽기 전용인데 ${m} ${p} 가 통과했다 (${r.status})`);
    if (r.status === 403) {
      const j = await r.json().catch(() => ({}));
      ok(/읽기 전용/.test(j.error || ''), `${m} ${p}: 왜 막혔는지 말해 주지 않는다: ${JSON.stringify(j)}`);
    }
  }
  /* 인증 없는 쓰기도 당연히 막힌다 — 게이트가 인증보다 앞이라 403 이다 */
  const anon = await send(ro.base, 'POST', '/api/admin/students', { code: 'ZZ8', name: '라학생' });
  ok(anon.status === 403, `인증 없는 쓰기가 통과했다 (${anon.status})`);

  /* ── 예외로 열어 둔 가져오기가 **인증을 우회하지 않는가** ──
     읽기 전용 게이트는 인증보다 앞이라 /api/admin/import 를 그냥 통과시킨다. 그 뒤의 관리
     게이트가 받아야 한다 — 안 받으면 터널 주소를 아는 누구나 검토용 자료를 덮어쓸 수 있다.
     터널에 생길 수 있는 구멍 중 가장 큰 자리라 세 가지 토큰 꼴로 모두 확인한다. */
  const forged = [['토큰 없음', undefined], ['엉뚱한 토큰', 'deadbeefdeadbeefdeadbeefdeadbeef'], ['빈 토큰', '']];
  for (const [label, tok] of forged) {
    const r = await send(ro.base, 'POST', '/api/admin/import',
      { confirm: 'replace', snapshot: snapshot() }, tok);
    ok(r.status === 401 || r.status === 403,
      `읽기 전용 예외가 인증까지 열었다 — ${label}: ${r.status}`);
  }
  /* 관리 로그인 예외도 같다 — 틀린 PIN 은 받지 않는다 */
  const badPin = await send(ro.base, 'POST', '/api/admin/login', { pin: 'wrong-pin' });
  ok(badPin.status === 401 || badPin.status === 403, `틀린 PIN 이 통과했다 (${badPin.status})`);

  /* ── ⑤ 읽기는 그대로 ── */
  const ovr = await send(ro.base, 'GET', '/api/admin/overview', undefined, t);
  ok(ovr.status === 200, `읽기 전용 모드에서 읽기가 막혔다 (${ovr.status}) — 보기 위해 켠 모드다`);

  /* ── ③·④ 가져오기는 열려 있고, 디스크까지 간다 ── */
  const imp = await send(ro.base, 'POST', '/api/admin/import', { confirm: 'replace', snapshot: snapshot() }, t);
  ok(imp.status === 200, `읽기 전용 모드에서 가져오기가 막혔다 (${imp.status}) — 이 모드의 목적이다`);
  const codes = ((await (await send(ro.base, 'GET', '/api/admin/overview', undefined, t)).json()).students || []).map((x) => x.code);
  ok(codes.includes('RR1'), `가져온 학생이 안 보인다: ${JSON.stringify(codes)}`);

  /* ── GET 이 가족 링크 토큰을 **찍어내지 않는가** ──
     메서드 게이트는 GET 을 통과시킨다. 이 라우트는 ptoken 이 없는 학생마다 새 토큰을 만들어
     db.parents 에 넣는데, 검토용 서버에서 찍은 토큰은 다음 가져오기의 persistNow() 가 디스크에
     영구 기록한다 — 가정에 나갈 링크를 검토용 서버가 새로 만드는 것은 결정 ㄱ 밖이다. */
  const pm = await send(ro.base, 'GET', '/api/admin/parent-messages', undefined, t);
  ok(pm.status === 200, `학부모 문구 라우트가 막혔다 (${pm.status}) — 읽기는 되어야 한다`);
  const pmBody = await pm.json();
  ok((pmBody.noLink || []).includes('RR1'),
    `링크 없는 학생을 알려 주지 않는다: ${JSON.stringify(pmBody.noLink)}`);
  ok(!(pmBody.messages || []).some((m) => /\?t=/.test(m.text || '')),
    `읽기 전용인데 가족 링크를 새로 찍었다: ${JSON.stringify(pmBody.messages).slice(0, 200)}`);

  /* ── 밖으로 아무것도 보내지 않는가 ── 타이머는 요청이 아니라 시계가 깨우므로 게이트가 못 본다.
     등록 자체를 막았는지 소스로 확인한다(시각을 조작해 21:00 을 만들 수는 없다). */
  const srvSrc = fs.readFileSync(path.join(DIR, 'server.mjs'), 'utf8');
  ok(/if \(!READONLY\) \{\s*\nsetInterval/.test(srvSrc),
    '푸시 타이머가 읽기 전용 모드에서도 등록된다 — 가져온 운영 구독자에게 중복 알림이 나간다');

  /* 재기동해도 남아야 한다 — persist() 가 모드에 잠겨 있어 가장 그럴듯한 고장이 여기다 */
  ro.stop();
  const again = await boot({ WB_READONLY: '1' }, ro.dir);
  const t2 = await login(again.base);
  const after = ((await (await send(again.base, 'GET', '/api/admin/overview', undefined, t2)).json()).students || []).map((x) => x.code);
  again.stop();
  ok(after.includes('RR1'), `재기동하니 가져온 자료가 사라졌다 — 가져오기가 디스크에 닿지 않았다: ${JSON.stringify(after)}`);
} finally {
  if (open) open.stop();
  if (ro) { try { fs.rmSync(ro.dir, { recursive: true, force: true }); } catch { /* 지우기 실패는 시험 결과가 아니다 */ } }
}

/* ── HTTP 밖의 한 겹 — persist() 자체가 잠기는가 ──
   메서드 게이트는 GET 라우트가 쓰는 길을 못 막는다(연동 nonce 정리처럼 GET 이면서 persist() 를
   부르는 자리가 있다). 그래서 store 를 직접 불러 확인한다. */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbr-ro-store-'));
  process.env.DATA_DIR = dir;          // store.mjs 는 불릴 때 이 값을 읽는다
  const store = await import('./store.mjs');
  store.load();
  const db = store.getDb();
  const file = path.join(dir, 'db.json');

  db.students.AA1 = { code: 'AA1', name: '마학생' };
  store.persist();
  await sleep(500);                    // 디바운스 300ms
  ok(fs.existsSync(file), '모드를 켜기 전에는 저장돼야 한다 — 저장 자체가 고장이면 아래 시험이 무의미하다');
  const before = fs.readFileSync(file, 'utf8');

  store.setReadOnly(true);
  ok(store.isReadOnly() === true, 'setReadOnly 가 먹지 않는다');
  db.students.BB2 = { code: 'BB2', name: '바학생' };   // 화면 조작이 남긴 메모리 변경
  store.persist();
  await sleep(500);
  ok(fs.readFileSync(file, 'utf8') === before,
    '읽기 전용인데 persist() 가 db.json 을 바꿨다 — GET 라우트가 쓰는 길이 열려 있다');
  ok(JSON.parse(before).students.BB2 === undefined, '시험 전제가 깨졌다(BB2 가 이미 파일에 있다)');

  /* 가져오기는 이 모드에서도 써야 한다 */
  const out = store.importSnapshot(snapshot());
  ok(out && out.ok, `읽기 전용 모드에서 importSnapshot 이 실패했다: ${JSON.stringify(out)}`);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(saved.students && saved.students.RR1, '읽기 전용 모드에서 가져오기가 디스크에 닿지 않았다');
  ok(saved.students.BB2 === undefined,
    '가져오기가 메모리에 떠 있던 변경까지 디스크로 밀어 넣었다 — 검토용 서버의 자료가 더럽혀진다');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 위와 같다 */ }
}

if (errors.length) { console.error('실패:\n - ' + errors.join('\n - ')); process.exit(1); }
console.log('OK — 쓰기 메서드 차단 · 로그인·가져오기 예외 · 읽기 유지 · 디스크까지 간 가져오기, 그리고 persist() 자체 잠금까지 통과');
