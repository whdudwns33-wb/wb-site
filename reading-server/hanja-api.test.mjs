'use strict';
/* 한자브레인 서버 라우트 검증 (node reading-server/hanja-api.test.mjs)
 *
 * 단어장은 라이선스 자료라 인증 없이·배정 밖으로 나가면 안 되고, 학생 기록은 학생끼리 섞이면 안 된다.
 * 메모리 어댑터(워커 KV·로컬 파일 어댑터와 같은 계약)로 라우트를 통째로 돌린다. */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleHanja, hanjaSummary, dumpHanja, dropStudentHanja, hanjaBodyLimit, BODY_LIMIT_BOOK, BODY_LIMIT_DEFAULT } from './hanja-api.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
const t = async (name, fn) => { await fn(); passed += 1; console.log('  ✓ ' + name); };
const sample = () => JSON.parse(fs.readFileSync(path.join(DIR, '..', 'hanja', 'book-sample.json'), 'utf8'));

function memStore() {
  const books = {}, states = {}, assigns = {};
  let index = null;
  const students = { s1: { code: 's1', name: '김지우', cls: '월수반' }, s2: { code: 's2', name: '박서준', cls: '화목반' } };
  return {
    getBook: (id) => books[id] || null,
    putBook: (id, rec) => { books[id] = rec; },
    deleteBook: (id) => { delete books[id]; },
    getBookIds: () => index,
    putBookIds: (list) => { index = list; },
    getState: (c) => states[c] || null,
    putState: (c, rec) => { states[c] = rec; },
    deleteState: (c) => { delete states[c]; },
    listStateCodes: () => Object.keys(states),
    getAssign: (c) => assigns[c] || null,
    putAssign: (c, rec) => { assigns[c] = rec; },
    deleteAssign: (c) => { delete assigns[c]; },
    listAssignCodes: () => Object.keys(assigns),
    getStudent: (c) => students[c] || null,
    _raw: { books, states, assigns, index: () => index },
  };
}
const ADMIN = { code: '__admin__', admin: true };
const S1 = { code: 's1', admin: false }, S2 = { code: 's2', admin: false };
const call = (store, over) => handleHanja({
  path: '/api/hanja/pull', method: 'GET', who: S1, getBody: async () => ({}), store,
  query: new URLSearchParams(over && over.qs ? over.qs : ''), ...over,
});
const upload = (store, book, extra) => call(store, { path: '/api/hanja/admin/book', method: 'POST', who: ADMIN, getBody: async () => ({ book, ...(extra || {}) }) });

await t('인증 없으면 401, 학생이 관리자 라우트를 부르면 403, 모르는 경로는 404', async () => {
  const store = memStore();
  assert.strictEqual((await call(store, { who: null })).status, 401);
  assert.strictEqual((await call(store, { path: '/api/hanja/admin/books' })).status, 403);
  assert.strictEqual((await call(store, { path: '/api/hanja/nope' })).status, 404);
  assert.strictEqual((await call(store, { path: '/api/hanja/nope', who: ADMIN })).status, 404);
});

await t('기록 저장/복원 왕복 + 학생 간 격리 + 400KB 상한', async () => {
  const store = memStore();
  const st = { v: 1, states: { 'c:觀': { step: 2, due: 1 } }, trace: { '觀': { reps: 3 } } };
  const put = await call(store, { path: '/api/hanja/state', method: 'PUT', getBody: async () => ({ state: st }) });
  assert.strictEqual(put.status, 200);
  assert.ok(put.body.ok && put.body.updatedAt);
  const pull = await call(store, {});
  assert.deepStrictEqual(pull.body.state, st);
  assert.strictEqual(pull.body.updatedAt, put.body.updatedAt);
  assert.strictEqual((await call(store, { who: S2 })).body.state, null, '다른 학생 기록이 보이면 안 된다');
  assert.strictEqual((await call(store, { path: '/api/hanja/state', method: 'PUT', getBody: async () => ({ state: 'x' }) })).status, 400);
  assert.strictEqual((await call(store, { path: '/api/hanja/state', method: 'PUT', getBody: async () => ({ state: { blob: 'x'.repeat(500_000) } }) })).status, 413);
});

await t('단어장 업로드 — dryRun 은 저장하지 않고 검사 결과만, 실제 업로드는 목록(메타)과 본문을 나눠 둔다', async () => {
  const store = memStore();
  const dry = await upload(store, sample(), { dryRun: true });
  assert.strictEqual(dry.status, 200);
  assert.ok(dry.body.ok && dry.body.preview && dry.body.meta.id === 'wb-hanja-starter');
  assert.strictEqual(store._raw.index(), null, 'dryRun 이 저장했다');
  const up = await upload(store, sample());
  assert.strictEqual(up.status, 200);
  assert.ok(up.body.ok && up.body.id === 'wb-hanja-starter' && !up.body.replaced);
  assert.strictEqual(up.body.counts.words, 48);
  const idx = store._raw.index();
  assert.strictEqual(idx.length, 1);
  assert.strictEqual(idx[0].scope, 'all');
  assert.ok(!('words' in idx[0]) && !('chars' in idx[0]), '목록에 본문이 실렸다');
  assert.strictEqual(idx[0].counts.chars, 66);
  assert.strictEqual(store._raw.books['wb-hanja-starter'].book.words.length, 48);
  /* 재업로드는 덮어쓰되 공개 범위는 지킨다 */
  await call(store, { path: '/api/hanja/admin/scope', method: 'POST', who: ADMIN, getBody: async () => ({ id: 'wb-hanja-starter', scope: 'assigned' }) });
  const again = await upload(store, { ...sample(), title: '고친 제목' });
  assert.ok(again.body.replaced);
  assert.strictEqual(store._raw.index().length, 1);
  assert.strictEqual(store._raw.index()[0].title, '고친 제목');
  assert.strictEqual(store._raw.index()[0].scope, 'assigned', '재업로드가 공개 범위를 되돌렸다');
});

await t('단어장 업로드 — 오류가 있으면 400 과 함께 위치·이유를 돌려주고, 너무 크면 413', async () => {
  const store = memStore();
  const bad = await upload(store, { id: 'bad', title: 'x', words: [{ word: 'observe', meaning: '관찰하다' }] });
  assert.strictEqual(bad.status, 400);
  assert.ok(Array.isArray(bad.body.errors) && /워드브레인/.test(bad.body.errors[0].message), JSON.stringify(bad.body));
  assert.strictEqual(store._raw.index(), null);
  const words = []; for (let i = 0; i < 2999; i++) words.push({ word: '낱말' + i, meaning: '뜻'.repeat(199), example: '낱말' + i + ' ' + '예'.repeat(180) });
  const big = await upload(store, { id: 'big-book', title: '큰 책', words });
  assert.strictEqual(big.status, 413, JSON.stringify(big.body).slice(0, 200));
  assert.strictEqual((await call(store, { path: '/api/hanja/admin/book', method: 'POST', who: ADMIN, getBody: async () => ({}) })).status, 400);
  assert.strictEqual((await call(store, { path: '/api/hanja/admin/book', method: 'POST', who: ADMIN, getBody: async () => { throw new Error('bad json'); } })).status, 400);
});

await t('붙여넣기 텍스트 업로드 — 관리 웹 textarea 그대로', async () => {
  const store = memStore();
  const text = '# 1일차\n관측 | 보고 재는 것 | 觀(볼 관)+測(잴 측) | 별을 관측했다.\n觀 | 볼 관 | 25\n# 2일차\n여태 | 지금까지';
  const r = await call(store, { path: '/api/hanja/admin/book', method: 'POST', who: ADMIN, getBody: async () => ({ text, id: 'paste-1', title: '붙여넣기 책', level: 'L2' }) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const rec = store._raw.books['paste-1'];
  assert.strictEqual(rec.book.units.length, 2);
  assert.strictEqual(rec.book.words.length, 2);
  assert.strictEqual(rec.book.chars.find((c) => c.ch === '觀').strokes, 25);
  const bad = await call(store, { path: '/api/hanja/admin/book', method: 'POST', who: ADMIN, getBody: async () => ({ text: '관측', id: 'paste-2', title: 'x' }) });
  assert.strictEqual(bad.status, 400);
  assert.ok(/1행/.test(bad.body.errors[0].message));
});

await t('학생 목록·본문 — 공개 범위 all 은 모두, assigned 는 배정된 학생만 (403), 배정본은 mine 으로 앞에', async () => {
  const store = memStore();
  await upload(store, sample());
  await upload(store, { ...sample(), id: 'restricted-book', title: '산 학생만' });
  await call(store, { path: '/api/hanja/admin/scope', method: 'POST', who: ADMIN, getBody: async () => ({ id: 'restricted-book', scope: 'assigned' }) });
  let list = await call(store, { path: '/api/hanja/books' });
  assert.strictEqual(list.status, 200);
  assert.deepStrictEqual(list.body.books.map((b) => b.id), ['wb-hanja-starter'], '배정 안 된 학생에게 assigned 단어장이 보인다');
  assert.ok(list.body.updatedAt);
  assert.strictEqual((await call(store, { path: '/api/hanja/book', qs: 'id=restricted-book' })).status, 403);
  assert.strictEqual((await call(store, { path: '/api/hanja/book', qs: 'id=nope-book' })).status, 404);
  assert.strictEqual((await call(store, { path: '/api/hanja/book', qs: 'id=한글' })).status, 400);
  const ok = await call(store, { path: '/api/hanja/book', qs: 'id=wb-hanja-starter' });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(Object.keys(ok.body).sort(), ['book', 'updatedAt'], '래핑 계약 {book, updatedAt}');
  assert.strictEqual(ok.body.book.words.length, 48);

  const as = await call(store, { path: '/api/hanja/admin/assign', method: 'POST', who: ADMIN, getBody: async () => ({ codes: ['s1', 'ghost'], bookIds: ['restricted-book'] }) });
  assert.strictEqual(as.status, 200);
  assert.deepStrictEqual(as.body.assigned, ['s1']);
  list = await call(store, { path: '/api/hanja/books' });
  assert.deepStrictEqual(list.body.books.map((b) => b.id + ':' + b.mine), ['restricted-book:true', 'wb-hanja-starter:false']);
  assert.strictEqual((await call(store, { path: '/api/hanja/book', qs: 'id=restricted-book' })).status, 200);
  assert.strictEqual((await call(store, { path: '/api/hanja/book', qs: 'id=restricted-book', who: S2 })).status, 403, '배정 안 된 다른 학생이 열었다');
  /* 배정 해제 */
  await call(store, { path: '/api/hanja/admin/assign', method: 'POST', who: ADMIN, getBody: async () => ({ codes: ['s1'], bookIds: ['restricted-book'], action: 'remove' }) });
  assert.strictEqual((await call(store, { path: '/api/hanja/book', qs: 'id=restricted-book' })).status, 403);
  assert.strictEqual(store._raw.assigns.s1, undefined, '빈 배정 칸이 남았다');
  /* 없는 단어장 배정은 거절 */
  assert.strictEqual((await call(store, { path: '/api/hanja/admin/assign', method: 'POST', who: ADMIN, getBody: async () => ({ codes: ['s1'], bookIds: ['nope-book'] }) })).status, 400);
  assert.strictEqual((await call(store, { path: '/api/hanja/admin/scope', method: 'POST', who: ADMIN, getBody: async () => ({ id: 'wb-hanja-starter', scope: 'secret' }) })).status, 400);
});

await t('삭제 — 본문·목록·모든 학생의 배정에서 빠지고, 학생 기록은 남는다', async () => {
  const store = memStore();
  await upload(store, sample());
  await upload(store, { ...sample(), id: 'second-book' });
  await call(store, { path: '/api/hanja/admin/assign', method: 'POST', who: ADMIN, getBody: async () => ({ codes: ['s1', 's2'], bookIds: ['wb-hanja-starter', 'second-book'] }) });
  await call(store, { path: '/api/hanja/state', method: 'PUT', getBody: async () => ({ state: { states: { 'w:wb-hanja-starter:w001': { step: 1 } } } }) });
  const del = await call(store, { path: '/api/hanja/admin/book', method: 'DELETE', who: ADMIN, getBody: async () => ({ id: 'wb-hanja-starter' }) });
  assert.strictEqual(del.status, 200);
  assert.strictEqual(del.body.unassigned, 2);
  assert.strictEqual(store._raw.books['wb-hanja-starter'], undefined);
  assert.deepStrictEqual(store._raw.index().map((e) => e.id), ['second-book']);
  assert.deepStrictEqual(store._raw.assigns.s1.bookIds, ['second-book']);
  assert.ok(store._raw.states.s1, '단어장을 지웠다고 학생 기록까지 지웠다');
  assert.strictEqual((await call(store, { path: '/api/hanja/admin/book', method: 'DELETE', who: ADMIN, getBody: async () => ({ id: 'wb-hanja-starter' }) })).status, 404);
  const ga = await call(store, { path: '/api/hanja/admin/assign', method: 'GET', who: ADMIN });
  assert.deepStrictEqual(ga.body.items.map((i) => i.code + ':' + i.bookIds.join('+')), ['s1:second-book', 's2:second-book']);
  assert.strictEqual(ga.body.items[0].name, '김지우');
});

await t('관리 현황 — 학생 기록에서 숫자만 뽑고, 배정 목록을 붙인다', async () => {
  const store = memStore();
  await upload(store, sample());
  const now = Date.now();
  const st = {
    states: {
      'c:觀': { step: 1, due: now - 3 * 86400000 },          // 1일 간격에 3일 방치 → 응급
      'w:wb-hanja-starter:w001': { step: 3, due: now + 86400000 },
      'w:wb-hanja-starter:w002': { step: 6, due: now, graduated: true },
    },
    trace: { '觀': { reps: 3 }, '十': { reps: 1 } }, streak: { count: 4, last: now },
  };
  await call(store, { path: '/api/hanja/state', method: 'PUT', getBody: async () => ({ state: st }) });
  await call(store, { path: '/api/hanja/admin/assign', method: 'POST', who: ADMIN, getBody: async () => ({ codes: ['s1'], bookIds: ['wb-hanja-starter'] }) });
  const ov = await call(store, { path: '/api/hanja/admin/overview', who: ADMIN });
  assert.strictEqual(ov.status, 200);
  const me = ov.body.students.find((s) => s.code === 's1');
  assert.ok(me.linked && me.total === 3 && me.words === 2 && me.chars === 1 && me.graduated === 1 && me.due === 1 && me.emergency === 1, JSON.stringify(me));
  assert.strictEqual(me.traced, 2);
  assert.strictEqual(me.streak, 4);
  assert.deepStrictEqual(me.books, ['wb-hanja-starter']);
  assert.deepStrictEqual(me.assigned, ['wb-hanja-starter']);
  assert.strictEqual(me.name, '김지우');
  /* 학생 기기가 이상한 값을 올려도 숫자만 남는다 */
  const weird = hanjaSummary({ state: { states: { 'c:x': 'not-an-object', 'w:b:1': { step: 'a', due: 'b' } }, streak: { count: '12' }, trace: 'x' }, updatedAt: 'now' });
  assert.strictEqual(weird.total, 1);
  assert.strictEqual(weird.streak, 12);
  assert.strictEqual(weird.traced, 0);
  assert.strictEqual(hanjaSummary(null).linked, false);
});

await t('백업 덤프에는 단어장 본문이 없고, 퇴원은 기록·배정만 지운다', async () => {
  const store = memStore();
  await upload(store, sample());
  await call(store, { path: '/api/hanja/state', method: 'PUT', getBody: async () => ({ state: { states: {} } }) });
  await call(store, { path: '/api/hanja/admin/assign', method: 'POST', who: ADMIN, getBody: async () => ({ codes: ['s1'], bookIds: ['wb-hanja-starter'] }) });
  const dump = await dumpHanja(store);
  assert.deepStrictEqual(Object.keys(dump).sort(), ['assigns', 'bookIds', 'index', 'states']);
  assert.deepStrictEqual(dump.bookIds, ['wb-hanja-starter']);
  assert.ok(!JSON.stringify(dump).includes('천문대에서'), '덤프에 낱말 본문이 실렸다');
  assert.ok(dump.states.s1 && dump.assigns.s1);
  await dropStudentHanja(store, 's1');
  assert.strictEqual(store._raw.states.s1, undefined);
  assert.strictEqual(store._raw.assigns.s1, undefined);
  assert.ok(store._raw.books['wb-hanja-starter'], '퇴원이 단어장을 지웠다');
});

await t('몸통 상한 — 단어장 업로드만 2MB, 나머지는 450KB', async () => {
  assert.strictEqual(hanjaBodyLimit('/api/hanja/admin/book'), BODY_LIMIT_BOOK);
  assert.strictEqual(hanjaBodyLimit('/api/hanja/state'), BODY_LIMIT_DEFAULT);
  assert.ok(BODY_LIMIT_BOOK > 1_572_864 && BODY_LIMIT_DEFAULT > 400_000);
});

console.log(`\nOK — ${passed}개 통과`);
