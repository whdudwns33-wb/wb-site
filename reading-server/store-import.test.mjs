#!/usr/bin/env node
/* 가져오기 ↔ 스냅샷 ↔ 워커 dump 의 **칸 대조** (node reading-server/store-import.test.mjs)
 *
 * 세 목록이 각자 자라면 조용히 자료가 사라진다. 실제로 그랬다 — 워커 fullDump 는 국어브레인
 * (naesinKo: 학생 기록·서술형 확정·**강사가 손으로 만든 학교 오버레이**)과 청크브레인
 * (chunk: 기록·배정·선생님 지문)을 담는데, 가져오기는 그 두 칸을 모르고 `ok: true` 를
 * 돌려주면서 버렸다. applied 에도, skipped 에도, absent 에도 없었다.
 *
 * 그래서 이 테스트가 세 가지를 못 박는다. 전부 사람 눈으로는 못 잡는 종류다:
 *
 *  ① **되돌릴 수 있는가.** 가져오기가 덮는 칸은 전부 스냅샷에 있어야 한다. 하나라도 빠지면
 *     「덮기 전에 스냅샷을 만든다」가 그 칸에 대해 거짓이고, 되돌릴 수 있다고 안내받은 뒤
 *     되돌릴 수 없는 상태가 가장 나쁘다.
 *  ② **조용히 버리지 않는가.** 워커 dump 의 최상위 칸은 전부 DIRECT·MERGE·SKIP 중 하나에
 *     있어야 한다. 아니면 unknown 으로라도 나와야 한다.
 *  ③ **되돌릴 자리를 서로 덮지 않는가.** 같은 날 두 번 가져와도 두 되돌림 지점이 다 남아야
 *     하고, 일일 백업 슬롯은 건드리지 않아야 한다.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'wbr-si-'));
process.env.DATA_DIR = data;                 // store.mjs 는 불릴 때 이 값을 읽는다
const store = await import('./store.mjs');

let fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { fail += 1; console.error('  ✗ ' + name + '\n     ' + e.message); }
};

/* ── 워커 fullDump 가 내보내는 최상위 칸 이름을 **소스에서** 읽는다 ──
   값을 베껴 적으면 워커가 칸을 늘릴 때 이 테스트가 같이 늙는다. */
function workerDumpKeys() {
  const src = fs.readFileSync(path.join(DIR, 'worker.mjs'), 'utf8');
  const start = src.indexOf('async function fullDump(env) {');
  assert.ok(start > 0, 'worker.mjs 에서 fullDump 를 찾지 못했다 — 이름이 바뀌었으면 이 테스트도 고친다');
  const end = src.indexOf('\n}', start);
  const body = src.slice(start, end);
  const r = body.lastIndexOf('return {');
  assert.ok(r > 0, 'fullDump 의 return 객체를 찾지 못했다');
  const objEnd = body.indexOf('};', r);
  const inner = body.slice(r + 'return {'.length, objEnd);
  /* 깊이 0 의 쉼표로만 쪼갠다 — 중첩된 객체·호출 안의 쉼표에 걸리지 않게 */
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of inner) {
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((x) => x.split(':')[0].trim()).filter(Boolean);
}

t('① 가져오기가 덮는 칸은 전부 스냅샷에 있다 — 되돌릴 수 없는 칸을 만들지 않는다', () => {
  const sec = store.importSections();
  const writes = sec.direct.concat(Object.keys(sec.merge));
  const snap = store.snapshotSections();
  const missing = writes.filter((k) => !snap.includes(k));
  assert.deepStrictEqual(missing, [],
    '스냅샷에 없는 칸을 가져오기가 덮는다 — 「덮기 전에 스냅샷」이 그 칸에 대해 거짓이 된다: ' + missing.join(','));
});

t('② 워커 dump 의 모든 칸이 세 목록 중 하나에 있다 — 조용히 버려지는 칸이 없다', () => {
  const sec = store.importSections();
  const known = new Set(sec.direct.concat(Object.keys(sec.merge), Object.keys(sec.skip),
    ['service', 'savedAt']));
  const keys = workerDumpKeys();
  assert.ok(keys.length >= 10, '워커 dump 칸을 제대로 못 읽었다: ' + JSON.stringify(keys));
  const orphan = keys.filter((k) => !known.has(k));
  assert.deepStrictEqual(orphan, [],
    '워커 dump 에 있는데 가져오기가 모르는 칸: ' + orphan.join(',') + ' — DIRECT·MERGE·SKIP 중 하나에 넣는다');
});

t('모르는 칸은 unknown 으로 돌려준다 — 다음에 칸이 늘어도 묻히지 않는다', () => {
  store.load();
  const out = store.importSnapshot({ service: 'wb-reading', students: {}, 새로운칸: { x: 1 } });
  assert.ok(out.ok, JSON.stringify(out));
  assert.ok((out.unknown || []).includes('새로운칸'),
    '모르는 칸을 조용히 버렸다: ' + JSON.stringify(out.unknown));
  /* 머리 칸은 unknown 이 아니다 — 매번 거짓 경고가 되면 아무도 안 본다 */
  const clean = store.importSnapshot({ service: 'wb-reading', savedAt: 'x', confirm: 'replace', students: {} });
  assert.deepStrictEqual(clean.unknown, [], '머리 칸을 모르는 칸으로 셌다: ' + JSON.stringify(clean.unknown));
});

t('③ 같은 날 두 번 가져와도 두 되돌림 지점이 다 남는다 — 일일 슬롯은 안 건드린다', () => {
  store.load();
  const db = store.getDb();
  /* 일일 슬롯을 먼저 만들어 둔다(자동 스냅샷이 이미 있는 평소 상태) */
  db.students = { AA1: { code: 'AA1', name: '가학생' } };
  const day = store.snapshotNow();
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(day), '일일 슬롯을 못 만들었다: ' + day);

  const b1 = store.snapshotBeforeImport();         // 1차 가져오기 전
  store.importSnapshot({ service: 'wb-reading', students: { BB2: { code: 'BB2', name: '나학생' } } });
  const b2 = store.snapshotBeforeImport();         // 2차 가져오기 전
  store.importSnapshot({ service: 'wb-reading', students: { CC3: { code: 'CC3', name: '다학생' } } });

  assert.ok(b1 && b2 && b1 !== b2, `두 되돌림 지점이 같은 파일이다: ${b1} / ${b2}`);
  assert.deepStrictEqual(Object.keys(store.getBackup(b1).students), ['AA1'],
    '1차 되돌림 지점이 바뀌었다 — 2차가 덮었다');
  assert.deepStrictEqual(Object.keys(store.getBackup(b2).students), ['BB2'],
    '2차 되돌림 지점이 1차 결과를 담지 않았다');
  assert.deepStrictEqual(Object.keys(store.getBackup(day).students), ['AA1'],
    '가져오기가 일일 백업 슬롯을 덮었다 — 하루치 되돌림 지점이 사라진다');
  const list = store.listBackups();
  assert.ok(list.includes(day) && list.includes(b1) && list.includes(b2),
    '목록에 안 나오는 되돌림 지점이 있다: ' + JSON.stringify(list));
  assert.strictEqual(list[0], day, '일일 슬롯이 목록 앞에 와야 한다(평소 보는 순서)');
});

t('검증이 스냅샷보다 먼저 — 받지 않을 파일로 되돌림 지점을 쓰지 않는다', () => {
  const pre = store.importPrecheck({ service: 'wb-desk', students: {} });
  assert.strictEqual(pre.ok, false, '다른 서비스의 스냅샷을 통과시켰다');
  assert.ok(/스냅샷이 아닙니다/.test(pre.error || ''), pre.error);
  /* precheck 는 아무것도 고치지 않는다 */
  store.load();
  const db = store.getDb();
  db.students = { KEEP1: { code: 'KEEP1' } };
  store.importPrecheck({ service: 'wb-desk', students: { GONE: {} } });
  assert.deepStrictEqual(Object.keys(db.students), ['KEEP1'], 'precheck 가 db 를 고쳤다');
  [null, 7, 'nope', []].forEach((bad) => {
    assert.strictEqual(store.importPrecheck(bad).ok, false, '망가진 입력: ' + JSON.stringify(bad));
  });
});

t('어댑터 기본 꼴을 통과시킨다 — db.naesin 을 packs 없이 만들지 않는다', () => {
  store.load();
  const db = store.getDb();
  /* server.mjs 의 naesinRoot 와 같은 일을 하는 가짜 어댑터 */
  const naesinRoot = () => {
    db.naesin = db.naesin || { packs: {}, packIds: [], states: {}, exams: {} };
    return db.naesin;
  };
  const snap = { service: 'wb-reading',
    naesin: { packIds: ['2022-ne-kimgitaek-m2-L6'], states: {}, exams: {}, tasks: {}, results: {} } };
  store.importSnapshot(snap, { roots: { naesin: naesinRoot } });
  assert.ok(db.naesin.packs && typeof db.naesin.packs === 'object',
    'db.naesin.packs 가 없다 — 팩 라우트가 db.naesin.packs[id] 에서 영구 500 이 된다');
  assert.deepStrictEqual(db.naesin.packIds, ['2022-ne-kimgitaek-m2-L6']);
  /* 어댑터를 안 넘기면(옛 호출) 적어도 맵은 되게 — 그래도 packs 는 어댑터가 정본이다 */
  store.load();
  store.importSnapshot(snap);
  assert.ok(store.getDb().naesin && typeof store.getDb().naesin === 'object');
});

t('본문·이 기기 것을 지우지 않는다 — 팩 본문과 밤 알림 구독', () => {
  store.load();
  const db = store.getDb();
  db.naesin = { packs: { P1: { packId: 'P1' } }, packIds: ['P1'], states: {}, exams: {} };
  db.vocab = { states: { S1: { a: 1 } }, mnemos: {}, assigns: {},
    push: { S1: { endpoint: 'https://example.invalid/x' } }, usage: { S1: 3 } };
  store.importSnapshot({ service: 'wb-reading',
    naesin: { packIds: ['P2'], states: {}, exams: {}, tasks: {}, results: {} },
    /* 워커 dumpVocab 은 states·mnemos·assigns 만 만든다 — 통째로 갈면 push 가 사라진다 */
    vocab: { states: { S9: { b: 2 } }, mnemos: {}, assigns: {} } });
  assert.ok(db.naesin.packs.P1, '올려 둔 팩 본문이 사라졌다');
  assert.deepStrictEqual(db.naesin.packIds, ['P2'], '팩 id 목록은 덮어야 한다');
  assert.ok(db.vocab.push && db.vocab.push.S1,
    '밤 알림 구독(vocab.push)이 사라졌다 — dump 에 없는 칸을 통째로 갈았다');
  assert.strictEqual(db.vocab.usage.S1, 3, 'vocab.usage 가 사라졌다');
  assert.ok(db.vocab.states.S9, '학생 기록은 덮어야 한다');
});

t('가족 링크 역맵을 다시 세운다 — 스냅샷에 db.parents 가 없어서다', () => {
  store.load();
  const db = store.getDb();
  db.parents = { oldtoken: 'ZZ9' };               // 이 기기에만 있던 링크
  const out = store.importSnapshot({ service: 'wb-reading',
    students: { S1: { code: 'S1', name: '가학생', ptoken: 'a'.repeat(32) },
                S2: { code: 'S2', name: '나학생' } } });
  assert.strictEqual(db.parents['a'.repeat(32)], 'S1',
    '학생 레코드에 ptoken 이 있는데 역맵이 비었다 — 가정에 나간 링크가 전부 404 가 된다');
  assert.strictEqual(out.parentsLinked, 1, '몇 개를 이었는지 알려 주지 않는다: ' + out.parentsLinked);
  assert.strictEqual(db.parents.oldtoken, 'ZZ9', '이 기기에만 있던 링크를 끊었다');
});

t('읽기 전용 자물쇠가 가져오기를 막지 않는다 — 그 모드의 목적이다', () => {
  store.load();
  store.setReadOnly(true);
  const out = store.importSnapshot({ service: 'wb-reading', students: { RR1: { code: 'RR1' } } });
  assert.ok(out.ok, JSON.stringify(out));
  const file = path.join(data, 'db.json');
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).students.RR1,
    '읽기 전용에서 가져오기가 디스크에 닿지 않았다');
  store.setReadOnly(false);
});

try { fs.rmSync(data, { recursive: true, force: true }); } catch { /* 지우기 실패는 시험 결과가 아니다 */ }
if (fail) { console.error('\n실패 ' + fail + '건'); process.exit(1); }
console.log('OK — 되돌림 가능성·칸 누락 없음·되돌림 지점 분리·어댑터 기본 꼴·본문 보존·가족 역맵까지 통과');
