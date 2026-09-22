'use strict';
/* 어휘브레인 서버 라우트 검증 (node reading-server/hanja-api.test.mjs)
 *
 * 단어장은 라이선스 자료라 인증 없이·배정 밖으로 나가면 안 되고, 학생 기록은 학생끼리 섞이면 안 된다.
 * 메모리 어댑터(워커 KV·로컬 파일 어댑터와 같은 계약)로 라우트를 통째로 돌린다. */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleHanja, hanjaSummary, dumpHanja, dropStudentHanja, hanjaBodyLimit, BODY_LIMIT_BOOK, BODY_LIMIT_DEFAULT, buildRemap, hanjaNightDue, resolveTask, unitItemIds, unitProgress, normCheck, checkList, unitCheck } from './hanja-api.mjs';
import { sendNightPushes } from './vocab-api.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
const t = async (name, fn) => { await fn(); passed += 1; console.log('  ✓ ' + name); };
const sample = () => JSON.parse(fs.readFileSync(path.join(DIR, '..', 'hanja', 'book-sample.json'), 'utf8'));

function memStore() {
  const books = {}, states = {}, assigns = {}, summaries = {}, tasks = {}, push = {}, remaps = {};
  let index = null, strokes = null;
  const students = { s1: { code: 's1', name: '김지우', cls: '월수반' }, s2: { code: 's2', name: '박서준', cls: '화목반' }, s3: { code: 's3', name: '이하늘', cls: '월수반' } };
  return {
    getSummary: (c) => summaries[c] || null, putSummary: (c, rec) => { summaries[c] = rec; }, deleteSummary: (c) => { delete summaries[c]; }, listSummaryCodes: () => Object.keys(summaries),
    getTask: (k) => tasks[k] || null, putTask: (k, rec) => { tasks[k] = rec; }, deleteTask: (k) => { delete tasks[k]; }, listTaskScopes: () => Object.keys(tasks),
    getStrokes: () => strokes, putStrokes: (rec) => { strokes = rec; },
    getPush: (c) => push[c] || null, putPush: (c, rec) => { push[c] = rec; }, delPush: (c) => { delete push[c]; }, listPushCodes: () => Object.keys(push),
    getRemap: (id) => remaps[id] || null, putRemap: (id, rec) => { remaps[id] = rec; }, deleteRemap: (id) => { delete remaps[id]; },
    listStudentCodes: () => Object.keys(students),
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
    _raw: { books, states, assigns, summaries, tasks, push, remaps, index: () => index, strokes: () => strokes },
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
  assert.deepStrictEqual(Object.keys(ok.body).sort(), ['book', 'remap', 'updatedAt'], '래핑 계약 {book, updatedAt, remap}');
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
  assert.deepStrictEqual(Object.keys(dump).sort(), ['assigns', 'bookIds', 'index', 'remaps', 'states', 'strokes', 'summaries', 'tasks']);
  assert.deepStrictEqual(dump.bookIds, ['wb-hanja-starter']);
  assert.ok(!JSON.stringify(dump).includes('천문대에서'), '덤프에 낱말 본문이 실렸다');
  assert.ok(dump.states.s1 && dump.assigns.s1);
  assert.ok(store._raw.summaries.s1, '기록 저장 때 요약 키가 안 생겼다');
  await dropStudentHanja(store, 's1');
  assert.strictEqual(store._raw.states.s1, undefined);
  assert.strictEqual(store._raw.summaries.s1, undefined);
  assert.strictEqual(store._raw.assigns.s1, undefined);
  assert.ok(store._raw.books['wb-hanja-starter'], '퇴원이 단어장을 지웠다');
});

await t('몸통 상한 — 단어장 업로드만 2MB, 나머지는 450KB', async () => {
  assert.strictEqual(hanjaBodyLimit('/api/hanja/admin/book'), BODY_LIMIT_BOOK);
  assert.ok(hanjaBodyLimit('/api/hanja/admin/strokes') > BODY_LIMIT_BOOK);
  assert.strictEqual(hanjaBodyLimit('/api/hanja/state'), BODY_LIMIT_DEFAULT);
  assert.ok(BODY_LIMIT_BOOK > 1_572_864 && BODY_LIMIT_DEFAULT > 400_000);
});

await t('재업로드 — 낱말 텍스트가 같으면 옛 id 를 새 id 로 잇고(remap), 학생 앱이 /book 에서 받는다', async () => {
  const store = memStore();
  /* 옛 단어장: 순번 id (예전 파서가 만들던 모양) */
  const old = { id: 'remap-book', title: '책', words: [{ id: 'w001', word: '관측', meaning: '뜻', hanja: '觀測' }, { id: 'w002', word: '여태', meaning: '지금까지' }] };
  assert.strictEqual((await upload(store, old)).status, 200);
  assert.strictEqual((await call(store, { path: '/api/hanja/book', qs: 'id=remap-book' })).body.remap, null, '처음 올린 단어장에 대응이 있다');
  /* 다시 올리기: id 를 안 적어 내용 기반 id 가 되고, 낱말 하나를 앞에 끼웠다 */
  const next = { id: 'remap-book', title: '책', words: [{ word: '관점', meaning: '뜻', hanja: '觀點' }, { word: '관측', meaning: '뜻', hanja: '觀測' }, { word: '여태', meaning: '지금까지' }] };
  const r = await upload(store, next);
  assert.strictEqual(r.body.remapped, 2, JSON.stringify(r.body));
  const got = await call(store, { path: '/api/hanja/book', qs: 'id=remap-book' });
  assert.deepStrictEqual(got.body.remap, { w001: '관측|觀測', w002: '여태' });
  /* 한 번 더 바꾸면(명시 id) 옛 대응이 새 목적지로 이어진다 */
  const third = { id: 'remap-book', title: '책', words: [{ id: 'gwan', word: '관측', meaning: '뜻', hanja: '觀測' }, { word: '여태', meaning: '지금까지' }] };
  await upload(store, third);
  const got3 = await call(store, { path: '/api/hanja/book', qs: 'id=remap-book' });
  assert.deepStrictEqual(got3.body.remap, { w001: 'gwan', '관측|觀測': 'gwan', w002: '여태' });
  assert.deepStrictEqual(buildRemap({ words: [{ id: 'a', word: 'x', hanja: '' }] }, { words: [{ id: 'a', word: 'x', hanja: '' }] }, null), {}, 'id 가 그대로면 대응이 없다');
});

await t('기록 저장 시 요약 키가 생기고 현황은 그 키를 읽는다 (본문을 안 읽어도 같은 숫자)', async () => {
  const store = memStore();
  const now = Date.now();
  await call(store, { path: '/api/hanja/state', method: 'PUT', getBody: async () => ({ state: { states: { 'c:觀': { step: 1, due: now - 86400000 }, 'w:b:x': { step: 6, due: now, graduated: true } }, trace: { '觀': {} }, streak: { count: 2 } } }) });
  const sum = store._raw.summaries.s1;
  assert.ok(sum && sum.total === 2 && sum.graduated === 1 && sum.due === 1 && sum.traced === 1 && sum.streak === 2 && sum.updatedAt, JSON.stringify(sum));
  /* 본문을 지워도 현황이 요약으로 나온다 */
  delete store._raw.states.s1;
  const ov = await call(store, { path: '/api/hanja/admin/overview', who: ADMIN });
  const me = ov.body.students.find((s) => s.code === 's1');
  assert.ok(me && me.total === 2 && me.graduated === 1, JSON.stringify(me));
});

await t('이번 주 단원 — 학생 → 반 → default 폴백, 없는 단원·날짜는 거절, 진도는 단원 항목만 센다', async () => {
  const store = memStore();
  await upload(store, sample());
  const post = (b) => call(store, { path: '/api/hanja/admin/task', method: 'POST', who: ADMIN, getBody: async () => b });
  assert.strictEqual((await post({ scope: 'default', bookId: 'wb-hanja-starter', unitId: 'u99' })).status, 400, '없는 단원이 통과했다');
  assert.strictEqual((await post({ scope: 'default', bookId: 'nope-book', unitId: 'u03' })).status, 404);
  assert.strictEqual((await post({ scope: 'default', bookId: 'wb-hanja-starter', unitId: 'u03', due: '2026-02-30' })).status, 400, '가짜 날짜가 통과했다');
  assert.strictEqual((await post({ scope: 'default', bookId: 'wb-hanja-starter', unitId: 'u03', due: '2026-10-05' })).status, 200);
  assert.strictEqual((await post({ scope: '월수반', bookId: 'wb-hanja-starter', unitId: 'u04', title: '이번 주는 4단원' })).status, 200);
  assert.strictEqual((await post({ scope: 's2', bookId: 'wb-hanja-starter', unitId: 'u01' })).status, 400, '어휘 교재의 보조 한자 단원을 과제로 지정하면 안 된다');
  assert.strictEqual((await post({ scope: 's2', bookId: 'wb-hanja-starter', unitId: 'u05' })).status, 200);
  const t1 = await call(store, { path: '/api/hanja/task' });                      // s1: 월수반 → 반 지정
  assert.deepStrictEqual([t1.body.scope, t1.body.task.unitId, t1.body.task.title], ['class', 'u04', '이번 주는 4단원']);
  const t2 = await call(store, { path: '/api/hanja/task', who: S2 });             // s2: 개인 지정
  assert.deepStrictEqual([t2.body.scope, t2.body.task.unitId], ['student', 'u05']);
  store._raw.tasks['월수반'] = undefined; delete store._raw.tasks['월수반'];
  const t3 = await call(store, { path: '/api/hanja/task' });                      // 반 지정이 없으면 default
  assert.deepStrictEqual([t3.body.scope, t3.body.task.unitId, t3.body.task.due], ['default', 'u03', '2026-10-05']);
  assert.ok(/보고 생각하기/.test(t3.body.task.title), '기본 제목은 단어장·단원 제목');
  const list = await call(store, { path: '/api/hanja/admin/tasks', who: ADMIN });
  assert.deepStrictEqual(list.body.tasks.map((x) => x.scope), ['default', 's2']);
  /* 진도 — u03 낱말 12개 중 s1 이 3개 심고 1개 졸업 */
  const book = store._raw.books['wb-hanja-starter'].book;
  const ids = unitItemIds(book, 'u03');
  assert.strictEqual(ids.length, 12, '끌어낸 한자가 단원 항목에 섞였다: ' + ids.length);
  const now = Date.now();
  const st = { states: {} };
  st.states[ids[0]] = { step: 2, due: now + 86400000 }; st.states[ids[1]] = { step: 6, due: now, graduated: true }; st.states[ids[2]] = { step: 1, due: now - 1 }; st.states['c:觀'] = { step: 1, due: now - 1 };
  await call(store, { path: '/api/hanja/state', method: 'PUT', getBody: async () => ({ state: st }) });
  const pr = await call(store, { path: '/api/hanja/admin/progress', who: ADMIN, qs: 'scope=default' });
  assert.strictEqual(pr.status, 200);
  const row = pr.body.rows.find((r) => r.code === 's1');
  assert.deepStrictEqual([pr.body.unit.total, row.planted, row.graduated, row.due], [12, 3, 1, 1], JSON.stringify(row));
  assert.deepStrictEqual(pr.body.rows.map((r) => r.code).sort(), ['s1', 's3'], '개별 과제를 받은 학생을 전체 과제의 미이행자로 세면 안 된다');
  assert.strictEqual((await call(store, { path: '/api/hanja/admin/progress', who: ADMIN, qs: 'scope=s2' })).body.rows.length, 1);
  assert.strictEqual((await call(store, { path: '/api/hanja/admin/progress', who: ADMIN, qs: 'scope=없는반' })).status, 404);
  /* 단어장을 지우면 그 단어장의 지정도 지운다 */
  const del = await call(store, { path: '/api/hanja/admin/book', method: 'DELETE', who: ADMIN, getBody: async () => ({ id: 'wb-hanja-starter' }) });
  assert.strictEqual(del.body.untasked, 2);
  assert.strictEqual((await call(store, { path: '/api/hanja/task' })).body.scope, null);
  assert.strictEqual((await call(store, { path: '/api/hanja/admin/task', method: 'DELETE', who: ADMIN, getBody: async () => ({ scope: 'default' }) })).status, 404);
});

await t('공용 획순 사전 — 검사해서 덧쓰고, 학생은 토큰으로 받는다', async () => {
  const store = memStore();
  const post = (b) => call(store, { path: '/api/hanja/admin/strokes', method: 'POST', who: ADMIN, getBody: async () => b });
  const ok = await post({ strokes: { '十': { medians: [[[0.1, 0.5], [0.9, 0.5]], [[0.5, 0.1], [0.5, 0.9]]] }, '一': { strokes: 1 } } });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  assert.strictEqual(ok.body.count, 2);
  const bad = await post({ strokes: { '관': { strokes: 2 }, '山': { strokes: 3, medians: [[[0.1, 0.5], [0.9, 0.5]]] } } });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.body.errors.length, 2, JSON.stringify(bad.body.errors));
  assert.strictEqual(store._raw.strokes().strokes['一'].strokes, 1, '오류 난 업로드가 사전을 건드렸다');
  await post({ strokes: { '山': { strokes: 3 } } });
  const got = await call(store, { path: '/api/hanja/strokes' });
  assert.deepStrictEqual(Object.keys(got.body.strokes).sort(), ['一', '十', '山']);
  assert.strictEqual(got.body.strokes['十'].strokes, 2, '획순 데이터에서 획수가 안 나왔다');
  await post({ strokes: { '山': { strokes: 3 } }, replace: true });
  assert.deepStrictEqual(Object.keys((await call(store, { path: '/api/hanja/admin/strokes', who: ADMIN })).body.strokes), ['山']);
  assert.ok(JSON.stringify(await dumpHanja(store)).includes('"山"'), '덤프에 획순 사전이 빠졌다');
});

await t('밤 9시 알림 — 만기가 있고 오늘 안 한 구독자에게만, 죽은 끝점은 지운다', async () => {
  const store = memStore();
  const yesterday = new Date(Date.now() - 86400000).toISOString();
  store.putState('s1', { state: { states: { 'c:觀': { step: 1, due: 1 } } }, updatedAt: yesterday });           // 만기 있음, 어제 저장
  store.putState('s2', { state: { states: { 'c:觀': { step: 1, due: 1 } } }, updatedAt: new Date().toISOString() }); // 오늘 이미 함
  store.putState('s3', { state: { states: { 'c:觀': { step: 1, due: Date.now() + 86400000 } } }, updatedAt: yesterday }); // 만기 없음
  assert.strictEqual(hanjaNightDue(store.getState('s1')).due, true);
  assert.strictEqual(hanjaNightDue(store.getState('s2')).reason, 'studied-today');
  assert.strictEqual(hanjaNightDue(store.getState('s3')).reason, 'done');
  for (const c of ['s1', 's2', 's3']) assert.strictEqual((await call(store, { path: '/api/hanja/push/subscribe', method: 'POST', who: { code: c, admin: false }, getBody: async () => ({ subscription: { endpoint: 'https://push.example/' + c } }) })).status, 200);
  assert.strictEqual((await call(store, { path: '/api/hanja/push/subscribe', method: 'POST', getBody: async () => ({ subscription: { endpoint: 'http://insecure' } }) })).status, 400);
  const hit = [];
  const fetchFn = async (url) => { hit.push(url); return { status: url.endsWith('/s1') ? 201 : 410 }; };
  const vocabStore = { listPushCodes: () => [], getPush: () => null, getState: () => null, delPush: () => {} };
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const key = { publicKey: 'BPub', privateJwk: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey)), subject: 'mailto:t@t' };
  const r = await sendNightPushes({ store: vocabStore, push: key, fetchFn, hanja: store });
  assert.strictEqual(r.hanjaSent, 1, JSON.stringify(r));
  assert.strictEqual(r.skipped, 2, '오늘 한 학생·만기 없는 학생은 건너뛴다');
  assert.deepStrictEqual(hit, ['https://push.example/s1']);
  assert.strictEqual((await call(store, { path: '/api/hanja/push/key' })).body.ok, false, 'VAPID 없이 ok 가 나왔다');
  assert.strictEqual((await call(store, { path: '/api/hanja/push/key', push: { publicKey: 'BPub' } })).body.key, 'BPub');
  await call(store, { path: '/api/hanja/push/unsubscribe', method: 'POST', who: S2 });
  assert.strictEqual(store._raw.push.s2, undefined);
});

await t('단원 진도 셈 — 심은 것·졸업·만기만 세고 없는 항목은 0', () => {
  const now = Date.now();
  const p = unitProgress({ state: { states: { a: { step: 1, due: now - 1 }, b: { graduated: true, due: 0 }, c: 'junk' } } }, ['a', 'b', 'c', 'd'], now);
  assert.deepStrictEqual(p, { total: 4, planted: 2, graduated: 1, due: 1 });
  assert.deepStrictEqual(unitProgress(null, ['a'], now), { total: 1, planted: 0, graduated: 0, due: 0 });
});

await t('단어장 종류 — 기본은 교재, 붙여넣기·JSON 모두 받고, /admin/source 로 바꾸면 본문·목록이 같이 바뀐다', async () => {
  const store = memStore();
  const text = '# 1일차\n관측 | 보고 재는 것 | 觀測\n';
  const post = (bodyObj) => call(store, { path: '/api/hanja/admin/book', method: 'POST', who: ADMIN, getBody: async () => bodyObj });
  const up = await post({ text, id: 'src-text', title: '교재' });
  assert.ok(up.body.ok, JSON.stringify(up.body));
  assert.strictEqual(up.body.meta.source, 'textbook', '종류를 안 적으면 교재');
  assert.strictEqual((await store.getBook('src-text')).book.source, 'textbook');
  const own = await post({ text, id: 'src-own', title: '자체', source: 'own' });
  assert.strictEqual(own.body.meta.source, 'own');
  /* JSON — 파일에 적힌 값이 먼저, 없으면 관리 웹 선택값 */
  const s1 = sample(); s1.id = 'src-json-1'; delete s1.source;
  assert.strictEqual((await upload(store, s1, { source: 'own' })).body.meta.source, 'own');
  const s2 = sample(); s2.id = 'src-json-2'; s2.source = 'textbook';
  assert.strictEqual((await upload(store, s2, { source: 'own' })).body.meta.source, 'textbook');
  assert.strictEqual(store._raw.index().find((e) => e.id === 'src-own').source, 'own', '목록에 종류가 실린다');
  /* 종류 바꾸기 */
  const chg = (id, source) => call(store, { path: '/api/hanja/admin/source', method: 'POST', who: ADMIN, getBody: async () => ({ id, source }) });
  assert.strictEqual((await chg('src-text', 'weird')).status, 400);
  assert.strictEqual((await chg('nope-1', 'own')).status, 404);
  const ok = await chg('src-text', 'own');
  assert.strictEqual(ok.status, 200);
  assert.ok(ok.body.updatedAt);
  assert.strictEqual((await store.getBook('src-text')).book.source, 'own', '본문도 바뀌어야 학생 앱의 AI 버튼 판정이 따라온다');
  assert.strictEqual(store._raw.index().find((e) => e.id === 'src-text').source, 'own');
  const stu = await call(store, { path: '/api/hanja/book', qs: 'id=src-text' });
  assert.strictEqual(stu.body.book.source, 'own');
  assert.strictEqual((await call(store, { path: '/api/hanja/admin/source', method: 'POST', getBody: async () => ({ id: 'src-text', source: 'own' }) })).status, 403, '학생은 못 바꾼다');
});

await t('공개 범위 — ids 로 여러 권을 한 번의 쓰기로 바꾸고, 확인이 늦으면 되쓰지 않고 알린다', async () => {
  const store = memStore();
  const ids = [];
  for (const n of [1, 2, 3, 4]) {
    const bk = sample(); bk.id = 'bulk-' + n; ids.push(bk.id);
    assert.ok((await upload(store, bk)).body.ok);
  }
  const post = (bodyObj) => call(store, { path: '/api/hanja/admin/scope', method: 'POST', who: ADMIN, getBody: async () => bodyObj });
  /* 옛 클라이언트의 {id} 한 건도 그대로 */
  const one = await post({ id: 'bulk-1', scope: 'assigned' });
  assert.strictEqual(one.status, 200);
  assert.strictEqual(one.body.id, 'bulk-1');
  assert.strictEqual(one.body.applied, true);
  assert.strictEqual(store._raw.index().find((e) => e.id === 'bulk-1').scope, 'assigned');
  /* 목록 쓰기 횟수를 센다 — 여러 권이 한 번의 쓰기로 가는지 */
  let writes = 0;
  const putBookIds = store.putBookIds;
  store.putBookIds = (list) => { writes += 1; return putBookIds(list); };
  const many = await post({ ids, scope: 'assigned' });
  assert.strictEqual(many.status, 200);
  assert.deepStrictEqual(many.body.ids, ids);
  assert.strictEqual(many.body.applied, true);
  assert.strictEqual(writes, 1, '여러 권을 한 번의 쓰기로 고쳐야 연달아 바꿀 때 변경이 사라지지 않는다 (쓰기 ' + writes + '회)');
  assert.ok(store._raw.index().every((e) => !ids.includes(e.id) || e.scope === 'assigned'));
  store.putBookIds = putBookIds;
  /* 없는 id·나쁜 범위·상한 */
  assert.strictEqual((await post({ ids: ['bulk-1', 'nope-9'], scope: 'all' })).status, 404);
  assert.strictEqual((await post({ ids, scope: 'weird' })).status, 400);
  assert.strictEqual((await post({ scope: 'all' })).status, 400);
  assert.strictEqual((await post({ ids: Array.from({ length: 51 }, (_, i) => 'x-' + i), scope: 'all' })).status, 400);
  /* KV 가 쓰기 직후 옛 목록을 돌려주는 상황 — 확인만 하고 되쓰지 않는다.
     옛 값 위에 한 번 더 쓰면 그 사이 다른 사람이 바꾼 것을 지운다(잃는 쪽이 더 나쁘다). */
  const stale = memStore();
  const bk = sample(); bk.id = 'stale-1';
  assert.ok((await upload(stale, bk)).body.ok);
  const fresh = stale.getBookIds;
  const realPut = stale.putBookIds;
  let writes2 = 0, reads = 0;
  stale.putBookIds = (list) => { writes2 += 1; return realPut(list); };
  /* 라우트가 한 번(없는 id 확인), editIndex 가 한 번 읽고, 세 번째가 쓴 뒤의 확인 읽기다 — 그 세 번째만 옛 값으로 만든다 */
  stale.getBookIds = () => { reads += 1; return reads === 3 ? JSON.parse(JSON.stringify(fresh())).map((e) => ({ ...e, scope: 'all' })) : fresh(); };
  const res = await call(stale, { path: '/api/hanja/admin/scope', method: 'POST', who: ADMIN, getBody: async () => ({ id: 'stale-1', scope: 'assigned' }) });
  stale.getBookIds = fresh; stale.putBookIds = realPut;
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.applied, false, '옛 값을 읽었으면 「확인 못 했다」로 알린다');
  assert.strictEqual(writes2, 1, '확인이 늦다고 다시 쓰면 안 된다 — 그것이 남의 변경을 지우는 경로다 (쓰기 ' + writes2 + '회)');
  assert.strictEqual(stale._raw.index().find((e) => e.id === 'stale-1').scope, 'assigned', '실제 저장된 값은 맞다');
});

await t('교재 점검 — 학생이 올린 점수를 서버가 조여 요약·진도표에 싣는다', async () => {
  /* 이 점수는 학생 기기가 올린 값이다. 관리 화면이 그대로 그리는 자리라 서버에서 화이트리스트로 조인다 */
  assert.strictEqual(normCheck(null), null);
  assert.strictEqual(normCheck({ n: 0, right: 3 }), null, '문항 수 0은 점검이 아니다');
  assert.strictEqual(normCheck({ n: 5000, right: 1 }), null, '문항 수 상한을 넘겼다');
  assert.strictEqual(normCheck({ n: 'abc', right: 1 }), null);
  const tidy = normCheck({ book: 'b1', unit: 'u03', title: 'ㄱ'.repeat(120), n: '12', right: 99, at: 1700000000000, evil: '<script>' });
  assert.deepStrictEqual([tidy.n, tidy.right, tidy.title.length], [12, 12, 60], '정답 수는 문항 수를 못 넘고 제목은 잘린다');
  assert.strictEqual(tidy.evil, undefined, '모르는 키가 그대로 따라 나갔다 — 화면까지 간다');
  assert.strictEqual(normCheck({ n: 10, right: -3 }).right, 0);
  assert.strictEqual(normCheck({ n: 10, right: 5, at: 'x' }).at, null);
  assert.deepStrictEqual(checkList(null), []);

  const store = memStore();
  await upload(store, sample());
  assert.strictEqual((await call(store, { path: '/api/hanja/admin/task', method: 'POST', who: ADMIN, getBody: async () => ({ scope: 'default', bookId: 'wb-hanja-starter', unitId: 'u03' }) })).status, 200);
  const st = { states: {}, checks: {
    'wb-hanja-starter|u03': { book: 'wb-hanja-starter', unit: 'u03', title: '3단원', n: 12, right: 9, at: 1700000000000 },
    'wb-hanja-starter|u04': { book: 'wb-hanja-starter', unit: 'u04', title: '4단원', n: 10, right: 4, at: 1700000900000 },
    'wb-hanja-starter|u09': { n: 0 },          /* 망가진 칸은 세지 않는다 */
  } };
  assert.strictEqual((await call(store, { path: '/api/hanja/state', method: 'PUT', getBody: async () => ({ state: st }) })).status, 200);
  const sum = hanjaSummary(store._raw.states.s1);
  assert.strictEqual(sum.checks, 2, '망가진 칸이 세어졌다');
  assert.deepStrictEqual([sum.lastCheck.title, sum.lastCheck.right, sum.lastCheck.n], ['4단원', 4, 10], '가장 최근 점검이 아니다');
  assert.strictEqual(store._raw.summaries.s1.lastCheck.title, '4단원', '요약 키에 점검이 안 실렸다 — 현황판이 못 본다');
  /* 진도표는 '이번 주 단원'의 점수를 본다 — 가장 최근 점검이 아니라 그 단원 것 */
  const pr = await call(store, { path: '/api/hanja/admin/progress', who: ADMIN, qs: 'scope=default' });
  const row = pr.body.rows.find((r) => r.code === 's1');
  assert.strictEqual(row.check, null, '과제 지정 전 점수를 이번 과제 결과로 보여 주면 안 된다');
  assert.deepStrictEqual([row.previousCheck.n, row.previousCheck.right, row.checkStatus], [12, 9, 'previous']);
  assert.strictEqual(pr.body.rows.find((r) => r.code === 's2').check, null, '점검 안 한 학생은 null');
  assert.strictEqual(unitCheck(store._raw.states.s1, 'wb-hanja-starter', 'u99'), null);
});

await t('과제 이행 — 개별·반 우선순위, 미시작 학생, 범위·힌트·보충 결과를 구분한다', async () => {
  const store = memStore();
  await upload(store, sample());
  const bookId = 'wb-hanja-starter', at = Date.parse('2026-09-22T00:00:00Z');
  const task = { bookId, unitId: 'u03', updatedAt: new Date(at).toISOString() };
  store._raw.tasks.default = task;
  store._raw.tasks['월수반'] = { ...task, unitId: 'u04' };
  store._raw.tasks.s1 = task;
  const progress = (scope) => call(store, { path: '/api/hanja/admin/progress', who: ADMIN, qs: 'scope=' + encodeURIComponent(scope) });
  assert.deepStrictEqual((await progress('default')).body.rows.map((r) => r.code), ['s2']);
  assert.deepStrictEqual((await progress('월수반')).body.rows.map((r) => r.code), ['s3']);
  assert.strictEqual((await progress('s1')).body.rows[0].checkStatus, 'unlinked');
  store._raw.states.s1 = { state: { states: {} }, updatedAt: new Date(at).toISOString() };
  assert.strictEqual((await progress('s1')).body.rows[0].checkStatus, 'unchecked');
  const count = unitItemIds(store._raw.books[bookId].book, 'u03').length;
  const check = { book: bookId, unit: 'u03', title: '3단원', n: count, right: count, total: count, hinted: 0, at: at + 1, wrongIds: [] };
  store._raw.states.s1.state.checks = { [bookId + '|u03']: check };
  assert.strictEqual((await progress('s1')).body.rows[0].checkStatus, 'checked');
  for (const updatedAt of [at + 2, new Date(at + 2).toISOString()]) {
    task.updatedAt = updatedAt;
    assert.strictEqual((await progress('s1')).body.rows[0].checkStatus, 'previous', '숫자·문자열 과제 시각 모두 지정 전 점수를 제외해야 한다');
  }
  task.updatedAt = at;
  check.n = count - 1; check.right = check.n;
  assert.strictEqual((await progress('s1')).body.rows[0].checkStatus, 'partial', '일부만 만점이면 전체 점검으로 보이면 안 된다');
  check.n = count; check.right = count; check.hinted = 1; check.wrongIds = ['w:' + bookId + ':w1'];
  assert.strictEqual((await progress('s1')).body.rows[0].checkStatus, 'review', '힌트 정답을 혼자 정답으로 세면 안 된다');
  check.retry = { at: at + 2, total: 1, right: 1, wrongIds: [] };
  assert.strictEqual((await progress('s1')).body.rows[0].checkStatus, 'rechecked');
  check.hinted = 2; check.wrongIds.push('w:' + bookId + ':w2');
  assert.strictEqual((await progress('s1')).body.rows[0].checkStatus, 'rechecked', '여러 번 보충해 마지막 한 항목만 남았던 경우도 완료로 본다');
  delete check.total;
  assert.strictEqual((await progress('s1')).body.rows[0].checkStatus, 'unknown', '옛 점검 기록의 전체 범위를 추정하면 안 된다');
  const overview = await call(store, { path: '/api/hanja/admin/overview', who: ADMIN });
  assert.strictEqual(overview.body.students.length, 3);
  assert.strictEqual(overview.body.students.find((s) => s.code === 's2').linked, false, '앱을 안 연 등록 학생이 빠졌다');
  const mixed = { id: 'mixed', words: [{ id: 'one', unit: 'u1' }], chars: [{ ch: '一', unit: 'u1' }] };
  assert.deepStrictEqual(unitItemIds(mixed, 'u1'), ['w:mixed:one'], '어휘 교재의 보조 한자가 이행 항목에 섞였다');
  assert.deepStrictEqual(unitItemIds({ ...mixed, words: [] }, 'u1'), ['c:一'], '글자 전용 교재 점검은 유지해야 한다');
  task.unitId = 'u01';
  store._raw.states.s1.state.checks[bookId + '|u01'] = { ...check, unit: 'u01', total: count, right: count, hinted: 0 };
  const empty = (await progress('s1')).body;
  assert.strictEqual(empty.unit.total, 0);
  assert.strictEqual(empty.rows[0].checkStatus, 'empty', '기존 보조 한자 과제는 미이행 또는 점검 완료 대신 재지정 대상으로 표시해야 한다');
});

await t('점검 추가 필드 — 제한된 범위·힌트·오답 ID·재확인만 보존하며 옛 기록과 호환된다', async () => {
  const base = { book: 'b', unit: 'u', title: '단원', n: 8, right: 6, at: 1700000000000 };
  assert.deepStrictEqual(normCheck(base), base);
  const c = normCheck({ ...base, total: 24, hinted: 99, wrongIds: ['w:b:a', 'w:b:a', 'bad', null, 'w:b:\n', ...Array.from({ length: 25 }, (_, i) => 'w:b:' + i)], retry: { at: base.at + 1, total: 2, right: 99, wrongIds: ['w:b:a'], evil: true } });
  assert.deepStrictEqual([c.total, c.hinted, c.wrongIds.length, c.retry.right], [24, 6, 20, 2]);
  assert.strictEqual(c.retry.evil, undefined);
  assert.strictEqual(normCheck({ ...base, total: 3 }).total, undefined);
  assert.strictEqual(normCheck({ ...base, at: Infinity }).at, null);
  assert.strictEqual(normCheck({ ...base, at: 9e15 }).at, null);
  assert.strictEqual(normCheck({ ...base, retry: { at: base.at - 1, total: 2, right: 2 } }).retry, undefined);
  assert.strictEqual(normCheck({ ...base, retry: { at: base.at + 1, total: 21, right: 2 } }).retry, undefined);
  for (const wrongIds of [undefined, ['bad'], ['w:b:\n']]) {
    assert.strictEqual(normCheck({ ...base, retry: { at: base.at + 1, total: 2, right: 2, wrongIds } }).retry, undefined, '누락·손상된 오답 목록을 전부 해결한 빈 목록으로 바꾸면 안 된다');
  }
});

await t('관리 표시·인쇄 — 교재명과 혼자 정답을 표시하고 어휘 교재는 뜻 쓰기를 기본으로 낸다', async () => {
  const admin = fs.readFileSync(path.join(DIR, 'public', 'hanja-admin.html'), 'utf8');
  const fn = admin.slice(admin.indexOf('function checkCell('), admin.indexOf('/* ── 현황 ── */'));
  const esc = (v) => String(v).replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const render = new Function('esc', 'bookTitle', 'fmt', fn + '; return checkCell;')(esc, () => '자체 교재', () => '9/22');
  const html = render({ book: 'b', unit: 'u', title: '<img>', n: 8, total: 24, right: 7, hinted: 2, wrongIds: ['w:b:a'], retry: { at: 1, total: 3, right: 2, wrongIds: ['w:b:a'] } });
  assert.ok(html.includes('자체 교재') && html.includes('혼자 정답 5 / 8') && html.includes('점검 범위 8 / 24'));
  assert.ok(html.includes('오답 재확인: 혼자 정답 2 / 3') && html.includes('보충할 낱말·한자 1개'));
  assert.ok(html.includes('&lt;img&gt;') && !html.includes('<img>'));
  assert.ok(render({ book: 'b', n: 8, right: 8 }).includes('전체 범위 미확인'));
  const fill = admin.slice(admin.indexOf('function fillUnits()'), admin.indexOf("$('#tkBook').addEventListener"));
  for (const vocabulary of [true, false]) {
    const elements = { '#tkBook': { value: 'b' }, '#tkUnit': { innerHTML: '' } };
    const book = { id: 'b', counts: { words: vocabulary ? 2 : 0 }, units: [{ id: 'chars', title: '보조 글자', words: 0, chars: 3 }, { id: 'words', title: '<자체 단원>', words: vocabulary ? 2 : 0, chars: 4 }] };
    new Function('BOOKS', '$', 'esc', fill + '; fillUnits();')([book], (id) => elements[id], esc);
    const html = elements['#tkUnit'].innerHTML;
    assert.strictEqual(html.includes('value="chars"'), !vocabulary);
    assert.ok(html.includes(vocabulary ? '(2낱말)' : '(4자)'));
    assert.ok(html.includes('&lt;자체 단원&gt;') && !html.includes('<자체 단원>'));
  }
  const print = fs.readFileSync(path.join(DIR, 'public', 'hanja-print.html'), 'utf8');
  const load = print.slice(print.indexOf('async function loadBook()'), print.indexOf("$('#book').addEventListener"));
  for (const vocabulary of [true, false]) {
    const elements = Object.fromEntries(['book', 'unit', 'tMeaning', 'tHun', 'tWrite', 'tCharWord', 'tHanja'].map((id) => ['#' + id, { value: 'b', checked: false, innerHTML: '' }]));
    const book = { units: [{ id: 'u', title: '자체 단원' }], words: vocabulary ? [{ unit: 'u' }] : [], chars: [{ ch: '一', unit: 'u' }] };
    await new Function('api', '$', 'BOOK', 'esc', load + '; return loadBook();')(async () => ({ book }), (id) => elements[id], null, esc);
    assert.strictEqual(elements['#tMeaning'].checked, vocabulary);
    for (const id of ['#tHun', '#tWrite', '#tCharWord']) assert.strictEqual(elements[id].checked, !vocabulary);
    assert.strictEqual(elements['#tHanja'].checked, false);
  }
});

console.log(`\nOK — ${passed}개 통과`);
