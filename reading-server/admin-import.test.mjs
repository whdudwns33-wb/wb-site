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
   실제로 겹쳤다: 이 파일들이 쓰던 띠가 admin-only.test.mjs·sec-headers.test.mjs 의 띠 안에
   있어서, 같은 pid 로 두 테스트가 동시에 돌면 늦게 bind 한 자식이 EADDRINUSE 로 죽고 —
   둘 다 stdio:'ignore' 라 기동 실패를 확인하지 않으므로 — **상대 테스트의 서버에 붙어**
   엉뚱한 결과를 냈다(ADMIN_PIN 이 같아 로그인까지 통과한다). check.mjs 가 8레인 병렬이라
   두 파일은 거의 항상 동시에 산다. */
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

async function boot() {
  const port = await freePort();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'wbr-imp-'));
  const env = { ...process.env, PORT: String(port), DATA_DIR: data, ADMIN_PIN: PIN };
  delete env.WB_ADMIN_ONLY;
  delete env.WB_READONLY;
  const srv = spawn(process.execPath, [path.join(DIR, 'server.mjs')], { env, stdio: 'ignore' });
  /* 자식이 조기 종료하면 **침묵하지 않는다** — 안 보면 남의 서버에 붙어 시험이 거짓으로 통과한다 */
  let died = null;
  srv.on('exit', (code, sig) => { died = `code=${code} signal=${sig}`; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (died) throw new Error('서버가 기동 중에 죽었다: ' + died);
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
  /* S1 에는 가족 링크 토큰이 있다 — 역맵(db.parents)은 스냅샷에 없어서 다시 세워야 한다 */
  students: { S1: { code: 'S1', name: '가학생', grade: '중2', cls: 'A', ptoken: 'a'.repeat(32) },
              S2: { code: 'S2', name: '나학생', grade: '중3', cls: 'B' } },
  states: { S1: { state: { note: '가져온 기록' }, updatedAt: '2026-10-11T00:00:00.000Z' } },
  vocab: { states: { S1: { x: 1 } }, mnemos: {}, push: {}, assigns: {} },
  portalFamilies: {}, textbook: { books: [] }, pubmap: {}, textbookSrc: { a: 'b' },
  naesin: { packIds: ['2022-ne-kimgitaek-m2-L6'], states: { S1: { s: 1 } },
            exams: { default: { examDate: '2026-11-01', packIds: ['2022-ne-kimgitaek-m2-L6'] } },
            tasks: {}, results: { S1: { '2026-11-01': { score: 88 } } } },
  hanja: { bookIds: ['bk1'], index: [{ id: 'bk1', title: '체험' }], states: {}, summaries: {}, assigns: {}, tasks: {}, remaps: {}, strokes: null },
  /* 국어브레인·청크 — 워커 fullDump 에는 있는데 전에는 가져오기가 몰랐다 */
  naesinKo: { packIds: ['ko-1'], states: { S1: { k: 1 } }, summaries: {}, reviews: {},
              overlays: { 'KO-SCHOOL': { note: '학교 오버레이' } }, exams: {}, tasks: {} },
  chunk: { states: { S1: { c: 1 } }, summaries: {}, assigns: {}, customs: null },
  /* 되읽을 수 없는 칸 — skipped 로 나와야 한다 */
  haru: { packIds: [], paperkeys: {}, plans: {}, states: {}, mocks: {}, paper: {}, atoms: null },
  letter: { issues: {}, states: {}, push: {}, calendar: null, images: [] },
});

let s = null;
try {
  s = await boot();
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

  /* ── 남의 스냅샷은 거절, 그리고 **되돌림 지점을 쓰지 않는다** ──
     검증이 스냅샷보다 뒤에 있으면, 받지도 않을 파일(다른 서비스의 export 를 잘못 고르는 일이
     가장 흔하다) 하나로 되돌림 지점이 하나 소모된다. 순서가 맞는지는 백업 목록으로 본다. */
  const before = ((await (await get(s.base, '/api/admin/backups', token)).json()).backups || []).length;
  const wrong = await post(s.base, '/api/admin/import',
    { confirm: 'replace', snapshot: { service: 'wb-desk', students: {} } }, token);
  ok(wrong.status === 400, `다른 서비스의 스냅샷을 받았다 (${wrong.status})`);
  const after = ((await (await get(s.base, '/api/admin/backups', token)).json()).backups || []).length;
  ok(after === before, `거절한 스냅샷 때문에 되돌림 지점을 썼다 (${before} → ${after}) — 검증이 스냅샷보다 앞이어야 한다`);

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

  /* ② 되돌릴 스냅샷을 먼저 만들었는가 — **일일 슬롯이 아닌 전용 파일**이어야 한다.
     같은 날 두 번 가져오면 슬롯 하나를 서로 덮어 첫 되돌림 지점이 사라진다. */
  ok(/^pre-import-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(-\d{1,3})?$/.test(out.backup || ''),
    `되돌릴 스냅샷이 가져오기 전용 파일이 아니다: ${out.backup}`);
  const back = await get(s.base, '/api/admin/export?backup=' + out.backup, token);
  ok(back.status === 200, '되돌릴 스냅샷을 받을 수 없다 — 되돌릴 길 없이 덮었다');
  const backBody = await back.json();
  ok(backBody && backBody.students && !backBody.students.S1,
    '되돌릴 스냅샷이 가져오기 **뒤** 상태다 — 되돌릴 자리가 아니다');
  /* 목록에도 나와야 한다 — 안 나오면 원장이 되돌림 지점을 찾을 수 없다 */
  const bks = await get(s.base, '/api/admin/backups', token);
  ok(((await bks.json()).backups || []).includes(out.backup),
    '되돌림 지점이 백업 목록에 없다');

  /* ③ 되읽을 수 없는 칸을 조용히 넘기지 않았는가 */
  const skipped = (out.skipped || []).map((x) => x.section).sort();
  ok(skipped.join(',') === 'haru,letter', `건너뛴 칸을 안 알려 준다: ${JSON.stringify(out.skipped)}`);
  ok((out.skipped || []).every((x) => x.why && x.why.length > 10), '왜 건너뛰었는지 적지 않았다');
  ok((out.applied || []).includes('students') && (out.applied || []).includes('naesin'),
    `적용한 칸 목록이 이상하다: ${JSON.stringify(out.applied)}`);
  /* 워커 dump 에만 있던 칸 — 전에는 applied·skipped·absent 어디에도 없이 조용히 사라졌다 */
  ['naesinKo', 'chunk'].forEach((k) => {
    ok((out.applied || []).includes(k), `${k} 칸을 되읽지 않았다: ${JSON.stringify(out.applied)}`);
  });
  ok(Array.isArray(out.unknown) && !out.unknown.length,
    `운영 스냅샷에 모르는 칸이 있다고 한다: ${JSON.stringify(out.unknown)}`);
  ok(out.parentsLinked === 1, `가족 링크 역맵을 다시 세우지 않았다: ${out.parentsLinked}`);

  /* ── ① 제자리에서 고쳤는가 — **다른 라우트로** 읽어 확인한다 ── */
  const ovr = await get(s.base, '/api/admin/overview', token);
  const codes = ((await ovr.json()).students || []).map((x) => x.code).sort();
  ok(codes.includes('S1') && codes.includes('S2'),
    `가져온 학생이 명부에 없다 — db 를 재할당해 서버가 옛 객체를 보고 있다: ${JSON.stringify(codes)}`);

  const ex = await get(s.base, '/api/naesin/admin/exams', token);
  const scopes = ((await ex.json()).exams || []).map((x) => x.scope);
  ok(scopes.includes('default'), `가져온 시험 배정이 안 보인다: ${JSON.stringify(scopes)}`);

  /* 국어 오버레이가 실제로 보이는가 — applied 보고만 믿지 않는다 */
  const ovl = await get(s.base, '/api/naesin-ko/admin/overlay?scope=KO-SCHOOL', token);
  const ovlBody = await ovl.json().catch(() => ({}));
  ok(ovl.status === 200 && ovlBody.overlay && ovlBody.overlay.note === '학교 오버레이',
    `가져온 국어 오버레이가 안 보인다 (${ovl.status}): ${JSON.stringify(ovlBody).slice(0, 160)}`);

  /* 가져온 칸이 **어댑터 기본 꼴**을 갖췄는가 — db.naesin 을 packs 없이 만들면 팩 라우트가
     영구 500 이 된다(재기동·재가져오기로도 안 낫는다). 500 이 아니라 404 여야 한다. */
  const freshPack = await get(s.base, '/api/naesin/admin/pack?id=2022-ne-kimgitaek-m2-L9', token);
  ok(freshPack.status !== 500,
    `가져오기가 db.naesin 을 packs 없이 만들었다 — 팩 라우트가 ${freshPack.status} 다`);

  /* 가족 링크가 살아났는가 — 역맵이 비면 가정에 나간 링크 전부가 404 다 */
  const fam = await fetch(s.base + '/api/parent/summary?t=' + 'a'.repeat(32));
  ok(fam.status === 200, `가져온 뒤 가족 링크가 404 다 (${fam.status}) — db.parents 를 다시 세우지 않았다`);

  /* ④ 팩 본문을 지우지 않았는가 — 스냅샷에 packs 가 없다고 올려 둔 팩을 날리면 안 된다 */
  const packs = await get(s.base, '/api/naesin/admin/packs', token);
  const ids = ((await packs.json()).packs || []).map(String);
  ok(ids.includes(packId), `가져오기가 올려 둔 팩 본문을 지웠다: ${JSON.stringify(ids)}`);

  /* ── 망가진 입력에 500 을 내지 않는다 ── */
  for (const bad of [null, 7, 'nope', []]) {
    const br = await post(s.base, '/api/admin/import', { confirm: 'replace', snapshot: bad }, token);
    ok(br.status === 400 || br.status === 200, `망가진 스냅샷에 ${br.status} 를 냈다: ${JSON.stringify(bad)}`);
  }

  /* ── ⑤ 칸 하나의 꼴이 다르면 그 칸만 거절하고 **덮지 않는다** ──
     잘린 파일·손으로 만든 파일에서 students 가 문자열·배열로 올 수 있다. 그대로 넣으면
     db.students 가 맵이 아니게 되고, 그 상태가 디스크에 저장돼 **재기동으로도 안 돌아온다**.
     관리 인증은 사람이 잘못된 파일을 고르는 일을 막아 주지 않는다. */
  for (const junk of ['문자열', [1, 2], 42, true]) {
    const bad = { ...snapshot(), students: junk };
    const r2 = await post(s.base, '/api/admin/import', { confirm: 'replace', snapshot: bad }, token);
    ok(r2.status === 200, `꼴이 다른 칸에 ${r2.status} 를 냈다: ${JSON.stringify(junk)}`);
    const j2 = await r2.json();
    ok(!(j2.applied || []).includes('students'),
      `꼴이 다른 students 를 적용했다고 보고한다: ${JSON.stringify(junk)}`);
    ok((j2.skipped || []).some((x) => x.section === 'students' && /꼴/.test(x.why || '')),
      `꼴이 다른 칸을 조용히 넘겼다: ${JSON.stringify(junk)} → ${JSON.stringify(j2.skipped)}`);
    /* 명부가 살아 있어야 한다 — **다른 라우트로** 읽어 확인한다 */
    const ov2 = await get(s.base, '/api/admin/overview', token);
    ok(ov2.status === 200, `꼴이 다른 칸을 받은 뒤 명부 라우트가 깨졌다 (${ov2.status}): ${JSON.stringify(junk)}`);
    const list2 = (await ov2.json()).students;
    ok(Array.isArray(list2) && list2.some((x) => x.code === 'S1'),
      `꼴이 다른 칸이 명부를 덮었다: ${JSON.stringify(junk)} → ${JSON.stringify(list2).slice(0, 120)}`);
  }
  /* 하위 칸(naesin)도 같다 — 맵이 아니면 거절하고 본문·기존 값을 지키지 않는다 */
  const koJunk = await post(s.base, '/api/admin/import',
    { confirm: 'replace', snapshot: { ...snapshot(), naesin: '아니다' } }, token);
  ok(koJunk.status === 200, `하위 칸 꼴 오류에 ${koJunk.status} 를 냈다`);
  const kj = await koJunk.json();
  ok((kj.skipped || []).some((x) => x.section === 'naesin'), '꼴이 다른 naesin 을 조용히 넘겼다');
  const ex2 = await get(s.base, '/api/naesin/admin/exams', token);
  ok(ex2.status === 200 && ((await ex2.json()).exams || []).some((x) => x.scope === 'default'),
    '꼴이 다른 naesin 이 기존 시험 배정을 지웠다');

  /* ── **빈 서버에 가져오기를 먼저** 했을 때 어댑터 기본 꼴이 서는가 ──
     위 본 가져오기는 팩을 미리 올려 db.naesin 이 이미 packs 를 갖고 있었다. 실제 운영 흐름은
     그 반대다 — 새 DATA_DIR 로 띄워 운영 스냅샷을 먼저 넣는다. 그때 db.naesin 이 packs 없이
     만들어지면 `db.naesin.packs[id]` 에서 팩 라우트가 **영구 500** 이 된다(재기동으로도
     안 낫는다. 디스크에 그 꼴로 저장되기 때문이다). 가져오기 직후와 재기동 뒤 둘 다 본다. */
  {
    const f = await boot();
    try {
      const ft = (await (await post(f.base, '/api/admin/login', { pin: PIN })).json()).token;
      const fr = await post(f.base, '/api/admin/import', { confirm: 'replace', snapshot: snapshot() }, ft);
      ok(fr.status === 200, `빈 서버 가져오기 실패 (${fr.status})`);
      for (const [label, path_] of [
        ['팩 읽기', '/api/naesin/admin/pack?id=2022-ne-kimgitaek-m2-L6'],
        ['국어 팩 읽기', '/api/naesin-ko/admin/pack?id=ko-1'],
      ]) {
        const r2 = await get(f.base, path_, ft);
        ok(r2.status !== 500, `빈 서버에 가져온 뒤 ${label} 가 500 이다 — 어댑터 기본 꼴이 없다`);
      }
      /* 팩을 **올리는** 쪽도 깨진다 — `Cannot set properties of undefined` */
      const upAfter = await post(f.base, '/api/naesin/admin/pack',
        { id: packId, pack: { packId, words: [], sentences: [] } }, ft);
      ok(upAfter.status === 200, `빈 서버에 가져온 뒤 팩 업로드가 ${upAfter.status} 다`);
    } finally { f.stop(); }
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
