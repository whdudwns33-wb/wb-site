'use strict';
/* 내신 서버 라우트 검증 (node reading-server/naesin-api.test.mjs) */
import assert from 'node:assert';
import { handleNaesin, naesinSummary } from './naesin-api.mjs';

let passed = 0;
const t = async (name, fn) => { await fn(); passed += 1; console.log('  ✓ ' + name); };

/* 메모리 어댑터 (worker KV·로컬 파일 어댑터와 동일 계약) */
function memStore() {
  const packs = {}, states = {}, exams = {};
  let packIds = null;
  const students = { 'st-1': { code: 'st-1', name: '김지우', cls: '중2 A반' }, 'st-2': { code: 'st-2', name: '박서준', cls: '중2 A반' } };
  return {
    getPack: (id) => packs[id] || null,
    putPack: (id, rec) => { packs[id] = rec; },
    getPackIds: () => packIds,
    putPackIds: (ids) => { packIds = ids; },
    getState: (c) => states[c] || null,
    putState: (c, rec) => { states[c] = rec; },
    listStateCodes: () => Object.keys(states),
    getExam: (s) => exams[s] || null,
    putExam: (s, rec) => { exams[s] = rec; },
    getStudent: (c) => students[c] || null,
    _raw: { packs, states, exams, ids: () => packIds },
  };
}
const call = (store, over) => handleNaesin({
  path: '/api/naesin/state', method: 'GET', who: { code: 'st-1', admin: false },
  query: new URLSearchParams(), getBody: async () => ({}), store,
  ...over,
});
const ADMIN = { code: '__admin__', admin: true };

/* 시드는 자체 제작 더미다 — 기획서 §9.3: 교과서·이그잼포유 문구를 테스트에 쓰지 않는다 */
const PACK = {
  packId: 'dummy-e2-mid1',
  school: '더미중', gradeSem: '2-1', exam: '중간',
  words: [{ word: 'observe', meaning: '관찰하다' }, { word: 'orbit', meaning: '궤도' }],
  sentences: [{ en: 'Dummy sentence one.', ko: '더미 문장 하나.' }],
};

await t('인증 없으면 401 — 팩·기록·시험 어느 것도 내용이 나가지 않는다(§10)', async () => {
  const store = memStore();
  store.putPack('dummy-e2-mid1', { pack: PACK, updatedAt: 'x' });
  const pack = await call(store, { who: null, path: '/api/naesin/pack', query: new URLSearchParams('id=dummy-e2-mid1') });
  assert.strictEqual(pack.status, 401);
  assert.strictEqual(pack.body.pack, undefined, '401에 콘텐츠가 실려 나가면 안 된다');
  assert.strictEqual((await call(store, { who: null })).status, 401);
  assert.strictEqual((await call(store, { who: null, path: '/api/naesin/exam' })).status, 401);
  assert.strictEqual((await call(store, { who: null, path: '/api/naesin/admin/pack', method: 'POST' })).status, 401);
});

await t('학생이 관리자 라우트를 부르면 403', async () => {
  const store = memStore();
  for (const [path, method] of [
    ['/api/naesin/admin/pack', 'POST'],
    ['/api/naesin/admin/packs', 'GET'],
    ['/api/naesin/admin/exam', 'POST'],
    ['/api/naesin/admin/overview', 'GET'],
  ]) {
    const r = await call(store, { path, method });
    assert.strictEqual(r.status, 403, path + ' — 학생에게 열리면 안 된다');
  }
});

await t('팩 저장 → 조회 왕복 — 관리자가 올리고 학생이 받고, 목록에 id가 남는다', async () => {
  const store = memStore();
  const up = await call(store, {
    path: '/api/naesin/admin/pack', method: 'POST', who: ADMIN,
    getBody: async () => ({ id: 'dummy-e2-mid1', pack: PACK }),
  });
  assert.strictEqual(up.status, 200);
  assert.strictEqual(up.body.ok, true);
  assert.deepStrictEqual(store._raw.ids(), ['dummy-e2-mid1'], 'naesin:packs 목록 유지');

  const got = await call(store, { path: '/api/naesin/pack', query: new URLSearchParams('id=dummy-e2-mid1') });
  assert.strictEqual(got.status, 200);
  assert.deepStrictEqual(got.body.pack, PACK, '올린 그대로 돌아와야 한다');
  assert.ok(got.body.updatedAt, '저장 시각이 붙는다');

  /* 강사 검수 화면도 같은 라우트로 확인한다 */
  const preview = await call(store, { path: '/api/naesin/pack', who: ADMIN, query: new URLSearchParams('id=dummy-e2-mid1') });
  assert.strictEqual(preview.status, 200);
});

await t('팩 없음 404, id 형식 오류 400', async () => {
  const store = memStore();
  assert.strictEqual((await call(store, { path: '/api/naesin/pack', query: new URLSearchParams('id=no-such-pack') })).status, 404);
  assert.strictEqual((await call(store, { path: '/api/naesin/pack' })).status, 400, 'id 없음');
  assert.strictEqual((await call(store, { path: '/api/naesin/pack', query: new URLSearchParams('id=ab') })).status, 400, '3자 미만');
  assert.strictEqual((await call(store, { path: '/api/naesin/pack', query: new URLSearchParams('id=a!b') })).status, 400, '허용 밖 문자');
});

await t('팩 저장 검증 — packId 불일치·형식·pack 누락·크기 상한 4MB', async () => {
  const store = memStore();
  const up = (body) => call(store, { path: '/api/naesin/admin/pack', method: 'POST', who: ADMIN, getBody: async () => body });
  assert.strictEqual((await up({ id: 'dummy-e2-mid1', pack: { ...PACK, packId: '다른팩' } })).status, 400, 'packId 불일치 — 다른 팩을 덮어쓰는 사고 방어');
  assert.strictEqual((await up({ id: 'x!', pack: PACK })).status, 400, 'id 형식');
  assert.strictEqual((await up({ id: 'dummy-e2-mid1' })).status, 400, 'pack 누락');
  assert.strictEqual((await up({ id: 'dummy-e2-mid1', pack: [PACK] })).status, 400, 'pack이 배열이면 안 된다');
  const big = await up({ id: 'dummy-e2-mid1', pack: { packId: 'dummy-e2-mid1', blob: 'x'.repeat(4_300_000) } });
  assert.strictEqual(big.status, 413, '4MB 초과 413');
  assert.strictEqual(store.getPack('dummy-e2-mid1'), null, '거절된 팩은 저장되지 않는다');
});

await t('팩 목록 — 비어 있으면 빈 배열, 같은 id 재업로드는 중복으로 안 쌓인다', async () => {
  const store = memStore();
  const empty = await call(store, { path: '/api/naesin/admin/packs', who: ADMIN });
  assert.deepStrictEqual(empty.body.packs, []);
  const up = (id) => call(store, {
    path: '/api/naesin/admin/pack', method: 'POST', who: ADMIN,
    getBody: async () => ({ id, pack: { ...PACK, packId: id } }),
  });
  await up('dummy-e2-mid1');
  await up('dummy-e2-fin1');
  await up('dummy-e2-mid1');   // 검수 후 재업로드 — 목록에는 한 번만
  const list = await call(store, { path: '/api/naesin/admin/packs', who: ADMIN });
  assert.deepStrictEqual(list.body.packs, ['dummy-e2-mid1', 'dummy-e2-fin1'], '재업로드는 중복으로 안 쌓인다');
});

await t('state 왕복 + 학생 간 격리 — 없으면 {}', async () => {
  const store = memStore();
  const before = await call(store, {});
  assert.strictEqual(before.status, 200);
  assert.deepStrictEqual(before.body.state, {}, '기록이 없으면 빈 객체');
  assert.strictEqual(before.body.updatedAt, null);

  const st = { mastery: { observe: { step: 2 } }, summary: { wordsReached: 1 } };
  const put = await call(store, { method: 'PUT', getBody: async () => ({ state: st }) });
  assert.strictEqual(put.status, 200);
  assert.ok(put.body.updatedAt);
  const after = await call(store, {});
  assert.deepStrictEqual(after.body.state, st);
  const other = await call(store, { who: { code: 'st-2', admin: false } });
  assert.deepStrictEqual(other.body.state, {}, '다른 학생 기록이 보이면 안 된다');
});

await t('state 저장 — 크기 상한 256KB(413)·형식 오류·JSON 파싱 실패 400', async () => {
  const store = memStore();
  const big = await call(store, { method: 'PUT', getBody: async () => ({ state: { blob: 'x'.repeat(300_000) } }) });
  assert.strictEqual(big.status, 413);
  assert.strictEqual(store.getState('st-1'), null, '거절된 기록은 저장되지 않는다');
  assert.strictEqual((await call(store, { method: 'PUT', getBody: async () => ({}) })).status, 400, 'state 없음');
  assert.strictEqual((await call(store, { method: 'PUT', getBody: async () => ({ state: '문자열' }) })).status, 400, 'state가 객체가 아님');
  const badJson = await call(store, { method: 'PUT', getBody: async () => { throw new Error('bad json'); } });
  assert.strictEqual(badJson.status, 400, '파싱 실패는 500이 아니라 400');
});

await t('시험 폴백 — 학생별 → default → 빈 값', async () => {
  const store = memStore();
  const none = await call(store, { path: '/api/naesin/exam' });
  assert.strictEqual(none.status, 200, '시험이 안 잡힌 것은 오류가 아니다');
  assert.deepStrictEqual(none.body, { exam: {}, scope: null });

  store.putPack('dummy-e2-mid1', { pack: PACK, updatedAt: 'x' });
  const set = (scope) => call(store, {
    path: '/api/naesin/admin/exam', method: 'POST', who: ADMIN,
    getBody: async () => ({ scope, examDate: scope === 'default' ? '2026-10-05' : '2026-10-12', packIds: ['dummy-e2-mid1'] }),
  });
  assert.strictEqual((await set('default')).status, 200);
  const def = await call(store, { path: '/api/naesin/exam' });
  assert.strictEqual(def.body.scope, 'default');
  assert.strictEqual(def.body.exam.examDate, '2026-10-05');

  assert.strictEqual((await set('st-1')).status, 200);
  const mine = await call(store, { path: '/api/naesin/exam' });
  assert.strictEqual(mine.body.scope, 'student', '학생별 설정이 default를 이긴다');
  assert.strictEqual(mine.body.exam.examDate, '2026-10-12');
  const s2 = await call(store, { path: '/api/naesin/exam', who: { code: 'st-2', admin: false } });
  assert.strictEqual(s2.body.scope, 'default', '다른 학생은 여전히 반 공통');
});

await t('시험 등록 검증 — scope·학생 존재·날짜·팩 존재', async () => {
  const store = memStore();
  store.putPack('dummy-e2-mid1', { pack: PACK, updatedAt: 'x' });
  const set = (body) => call(store, { path: '/api/naesin/admin/exam', method: 'POST', who: ADMIN, getBody: async () => body });
  const ok = { scope: 'default', examDate: '2026-10-05', packIds: ['dummy-e2-mid1'] };
  assert.strictEqual((await set({ ...ok, scope: '한글반' })).status, 400, 'scope 형식');
  assert.strictEqual((await set({ ...ok, scope: 'ghost-9' })).status, 404, '등록 안 된 학생 코드');
  assert.strictEqual((await set({ ...ok, examDate: '10월 5일' })).status, 400, '날짜 형식');
  assert.strictEqual((await set({ ...ok, packIds: [] })).status, 400, '빈 packIds');
  assert.strictEqual((await set({ ...ok, packIds: ['no-such-pack'] })).status, 400, '없는 팩은 배정 전에 걸러 준다');
  const saved = await set(ok);
  assert.strictEqual(saved.status, 200);
  assert.deepStrictEqual(saved.body.exam.packIds, ['dummy-e2-mid1']);
  assert.strictEqual((await set({ ...ok, scope: 'st-2' })).status, 200, '등록된 학생 코드는 통과');
});

await t('overview — summary 있으면 그대로, 없으면 신원 정보만', async () => {
  const store = memStore();
  const summary = { wordsReached: 41, wordsStable: 12, sentenceStages: { seen: 3, blank: 6 }, lastStudied: '2026-09-01T13:00:00Z' };
  store.putState('st-1', { state: { mastery: {}, summary }, updatedAt: '2026-09-01T13:00:00Z' });
  store.putState('st-2', { state: { mastery: {} }, updatedAt: '2026-09-01T09:00:00Z' });   // summary 없는 옛 클라이언트
  const r = await call(store, { path: '/api/naesin/admin/overview', who: ADMIN });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.students.length, 2, '기록 있는 학생만');
  const [a, b] = r.body.students;
  assert.strictEqual(a.name, '김지우');
  assert.deepStrictEqual(a.summary, summary, 'state.summary는 해석하지 않고 그대로 내보낸다');
  assert.strictEqual(a.lastActive, '2026-09-01T13:00:00Z');
  assert.strictEqual(b.summary, undefined, 'summary가 없으면 신원 정보만');
  assert.strictEqual(b.code, 'st-2');
  assert.ok(r.body.time);
});

await t('naesinSummary — 기록 없음·불량 summary도 셈이 깨지지 않는다', () => {
  const none = naesinSummary('st-9', null, null);
  assert.deepStrictEqual(none, { code: 'st-9', name: '', cls: '', linked: false, lastActive: null });
  const arr = naesinSummary('st-1', { name: '김지우', cls: 'A' }, { state: { summary: [1, 2] }, updatedAt: 'x' });
  assert.strictEqual(arr.summary, undefined, '배열 summary는 요약이 아니다');
  assert.strictEqual(arr.linked, true);
});

await t('모르는 경로는 404', async () => {
  const store = memStore();
  assert.strictEqual((await call(store, { path: '/api/naesin/zzz', who: ADMIN })).status, 404);
  assert.strictEqual((await call(store, { path: '/api/naesin/pack', method: 'POST' })).status, 403, '학생에게 모르는 경로는 관리자 벽(403)에서 끝난다');
});

console.log('\n통과 ' + passed + '개 — naesin-api 서버 라우트 검증 완료');
