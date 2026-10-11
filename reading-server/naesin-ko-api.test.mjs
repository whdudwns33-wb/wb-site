'use strict';
/* 국어브레인 서버 라우트 검증 (node reading-server/naesin-ko-api.test.mjs)
   정본: 국어 기획서 §9.2 라우트·§8 저장 예산·§10-4 접근 통제 */
import assert from 'node:assert';
import { handleNaesinKo, naesinKoSummary, naesinKoBodyLimit } from './naesin-ko-api.mjs';

let passed = 0;
const t = async (name, fn) => { await fn(); passed += 1; console.log('  ✓ ' + name); };

/* 메모리 어댑터 (worker KV·로컬 파일 어댑터와 동일 계약) */
function memStore() {
  const packs = {}, states = {}, summaries = {}, reviews = {}, overlays = {}, exams = {}, tasks = {}, pendings = {};
  let packIds = null;
  const students = { 'st-1': { code: 'st-1', name: '김지우', cls: '중2 A반' }, 'st-2': { code: 'st-2', name: '박서준', cls: '중2 A반' } };
  return {
    getPack: (id) => packs[id] || null,
    putPack: (id, rec) => { packs[id] = rec; },
    getPackIds: () => packIds,
    putPackIds: (ids) => { packIds = ids; },
    getState: (c) => states[c] || null,
    putState: (c, rec) => { states[c] = rec; },
    getSummary: (c) => summaries[c] || null,
    putSummary: (c, rec) => { summaries[c] = rec; },
    listSummaryCodes: () => Object.keys(summaries),
    listStateCodes: () => Object.keys(states),
    getReviews: (c) => reviews[c] || null,
    putReviews: (c, rec) => { reviews[c] = rec; },
    getOverlay: (s) => overlays[s] || null,
    putOverlay: (s, rec) => { overlays[s] = rec; },
    getExam: (s) => exams[s] || null,
    putExam: (s, rec) => { exams[s] = rec; },
    getTask: (s) => tasks[s] || null,
    putTask: (s, rec) => { tasks[s] = rec; },
    getPending: (id) => pendings[id] || null,
    putPending: (id, rec) => { pendings[id] = rec; },
    getStudent: (c) => students[c] || null,
    _raw: { packs, states, summaries, reviews, overlays, exams, pendings },
  };
}
const STU = { code: 'st-1', admin: false };
const ADMIN = { code: '__admin__', admin: true };
const call = (store, over) => handleNaesinKo({
  path: '/api/naesin-ko/state', method: 'GET', who: STU,
  query: new URLSearchParams(), getBody: async () => ({}), store, ...over,
});

/* 시드는 자체 제작 더미다 — 기획서 §9.3: 구매 자료 문구를 테스트에 쓰지 않는다 */
const PACK = { packId: 'dummy-ko-u1', revision: '데모', works: [{ workId: 'w-1', title: '더미 작품' }] };

await t('인증 없으면 401 — 팩·기록 어느 것도 나가지 않는다(§10-4)', async () => {
  const s = memStore();
  for (const p of ['/api/naesin-ko/pack', '/api/naesin-ko/state', '/api/naesin-ko/exam',
    '/api/naesin-ko/overlay', '/api/naesin-ko/review', '/api/naesin-ko/admin/overview']) {
    const r = await call(s, { path: p, who: null });
    assert.strictEqual(r.status, 401, p);
  }
});

await t('학생 토큰으로 관리 라우트는 403', async () => {
  const s = memStore();
  const r = await call(s, { path: '/api/naesin-ko/admin/overview', method: 'GET' });
  assert.strictEqual(r.status, 403);
});

await t('팩 업로드는 id와 pack.packId가 같아야 한다 — 덮어쓰기 사고 방어선', async () => {
  const s = memStore();
  const bad = await call(s, { path: '/api/naesin-ko/admin/pack', method: 'POST', who: ADMIN,
    getBody: async () => ({ id: 'other-id', pack: PACK }) });
  assert.strictEqual(bad.status, 400);
  const ok = await call(s, { path: '/api/naesin-ko/admin/pack', method: 'POST', who: ADMIN,
    getBody: async () => ({ id: PACK.packId, pack: PACK }) });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(await s.getPackIds(), [PACK.packId]);
});

await t('같은 팩 재업로드는 id 목록을 중복시키지 않는다', async () => {
  const s = memStore();
  const body = async () => ({ id: PACK.packId, pack: PACK });
  await call(s, { path: '/api/naesin-ko/admin/pack', method: 'POST', who: ADMIN, getBody: body });
  await call(s, { path: '/api/naesin-ko/admin/pack', method: 'POST', who: ADMIN, getBody: body });
  assert.deepStrictEqual(await s.getPackIds(), [PACK.packId]);
});

await t('팩 서빙 — 배정된 학생과 관리자가 열고, 없는 팩은 404', async () => {
  const s = memStore();
  await call(s, { path: '/api/naesin-ko/admin/pack', method: 'POST', who: ADMIN,
    getBody: async () => ({ id: PACK.packId, pack: PACK }) });
  await call(s, { path: '/api/naesin-ko/admin/exam', method: 'POST', who: ADMIN,
    getBody: async () => ({ scope: 'default', examDate: '2099-12-31', packIds: [PACK.packId] }) });
  const q = new URLSearchParams({ id: PACK.packId });
  const stu = await call(s, { path: '/api/naesin-ko/pack', method: 'GET', query: q });
  assert.strictEqual(stu.status, 200);
  assert.strictEqual(stu.body.pack.packId, PACK.packId);
  /* 없는 팩은 404 — 관리자 기준이다. 학생에게는 범위 게이트가 먼저 걸려 403 이 되는데,
     그게 맞다: 없는 팩의 존재 여부를 학생에게 알려 줄 이유가 없다. */
  const none = await call(s, { path: '/api/naesin-ko/pack', method: 'GET', who: ADMIN,
    query: new URLSearchParams({ id: 'no-such-pack' }) });
  assert.strictEqual(none.status, 404);
});

await t('시험은 내 것 → 반 공통 → 빈 값 순으로 폴백하고, 빈 값도 200이다', async () => {
  const s = memStore();
  const none = await call(s, { path: '/api/naesin-ko/exam' });
  assert.strictEqual(none.status, 200);
  assert.strictEqual(none.body.scope, null);
  await s.putExam('default', { examDate: '2026-12-10', packIds: [PACK.packId] });
  assert.strictEqual((await call(s, { path: '/api/naesin-ko/exam' })).body.scope, 'default');
  await s.putExam('st-1', { examDate: '2026-12-11', packIds: [PACK.packId] });
  assert.strictEqual((await call(s, { path: '/api/naesin-ko/exam' })).body.scope, 'student');
});

await t('없는 팩을 시험 범위로 배정하면 저장 전에 거절한다', async () => {
  const s = memStore();
  const r = await call(s, { path: '/api/naesin-ko/admin/exam', method: 'POST', who: ADMIN,
    getBody: async () => ({ scope: 'default', examDate: '2026-12-10', packIds: ['ghost-pack'] }) });
  assert.strictEqual(r.status, 400);
  assert.ok(r.body.error.indexOf('없는 팩') >= 0);
});

await t('시험 프로파일은 범위를 벗어나면 null로 떨군다', async () => {
  const s = memStore();
  await call(s, { path: '/api/naesin-ko/admin/pack', method: 'POST', who: ADMIN,
    getBody: async () => ({ id: PACK.packId, pack: PACK }) });
  const r = await call(s, { path: '/api/naesin-ko/admin/exam', method: 'POST', who: ADMIN,
    getBody: async () => ({ scope: 'default', examDate: '2026-12-10', packIds: [PACK.packId],
      profile: { mcCount: 21, essayCount: 5, essayWeight: 9 } }) });
  assert.strictEqual(r.body.exam.profile.essayWeight, null, '0~1 밖의 비율은 버린다');
  assert.strictEqual(r.body.exam.profile.mcCount, 21);
});

await t('요약은 state와 별도 키에 저장되고, overview는 요약만 읽는다(§8 저장 예산)', async () => {
  const s = memStore();
  await call(s, { path: '/api/naesin-ko/state', method: 'PUT',
    getBody: async () => ({ state: { v: 1, big: 'x'.repeat(1000) }, summary: { works: 3, complete: 1 } }) });
  assert.ok(s._raw.states['st-1'], 'state 저장');
  assert.deepStrictEqual(s._raw.summaries['st-1'].summary, { works: 3, complete: 1 });
  const ov = await call(s, { path: '/api/naesin-ko/admin/overview', method: 'GET', who: ADMIN });
  assert.strictEqual(ov.body.students.length, 1);
  assert.deepStrictEqual(ov.body.students[0].summary, { works: 3, complete: 1 });
  assert.ok(!JSON.stringify(ov.body).includes('xxxxx'), 'overview에 state 본문이 새면 안 된다');
});

await t('state가 256KB를 넘으면 413 — 조용히 실패하지 않는다', async () => {
  const s = memStore();
  const r = await call(s, { path: '/api/naesin-ko/state', method: 'PUT',
    getBody: async () => ({ state: { v: 1, blob: 'x'.repeat(300000) } }) });
  assert.strictEqual(r.status, 413);
  assert.ok(!s._raw.states['st-1'], '거절된 기록은 저장되지 않는다');
});

await t('서술형 제출은 별도 레코드로 쌓이고 같은 문항은 덮어쓴다', async () => {
  const s = memStore();
  const submit = (answer) => call(s, { path: '/api/naesin-ko/review', method: 'POST',
    getBody: async () => ({ review: { itemId: 'it-1', packId: PACK.packId, answer, verdict: 'hold' } }) });
  await submit('첫 답안');
  await submit('고쳐 쓴 답안');
  const mine = await call(s, { path: '/api/naesin-ko/review', method: 'GET' });
  assert.strictEqual(mine.body.reviews.length, 1, '재제출은 덮어쓴다');
  assert.strictEqual(mine.body.reviews[0].answer, '고쳐 쓴 답안');
});

await t('강사 확정은 규칙 판정을 뒤집었는지 기록한다 — 파일럿 뒤집기율 지표(§11)', async () => {
  const s = memStore();
  await call(s, { path: '/api/naesin-ko/review', method: 'POST',
    getBody: async () => ({ review: { itemId: 'it-1', packId: PACK.packId, answer: '답안',
      rule: { verdict: 'hold', score: 1, total: 2 }, verdict: 'hold' } }) });
  const r = await call(s, { path: '/api/naesin-ko/admin/review', method: 'POST', who: ADMIN,
    getBody: async () => ({ code: 'st-1', itemId: 'it-1', verdict: 'pass', points: 2, comment: '좋아요' }) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.review.teacher.flipped, true);
  assert.strictEqual(r.body.review.teacher.points, 2);
});

await t('같은 판정으로 확정하면 뒤집기가 아니다', async () => {
  const s = memStore();
  await call(s, { path: '/api/naesin-ko/review', method: 'POST',
    getBody: async () => ({ review: { itemId: 'it-1', packId: PACK.packId, answer: 'x',
      rule: { verdict: 'pass' }, verdict: 'pass' } }) });
  const r = await call(s, { path: '/api/naesin-ko/admin/review', method: 'POST', who: ADMIN,
    getBody: async () => ({ code: 'st-1', itemId: 'it-1', verdict: 'pass' }) });
  assert.strictEqual(r.body.review.teacher.flipped, false);
});

await t('알 수 없는 verdict는 거절한다', async () => {
  const s = memStore();
  const r = await call(s, { path: '/api/naesin-ko/admin/review', method: 'POST', who: ADMIN,
    getBody: async () => ({ code: 'st-1', itemId: 'it-1', verdict: '통과' }) });
  assert.strictEqual(r.status, 400);
});

await t('오버레이는 형식이 맞는 항목만 남긴다', async () => {
  const s = memStore();
  const r = await call(s, { path: '/api/naesin-ko/admin/overlay', method: 'POST', who: ADMIN,
    getBody: async () => ({ scope: 'default',
      overrides: [{ targetRef: 'b-bl-09', answers: ['의인법', '활유법'] },
        { targetRef: '', answers: ['버려짐'] }, { targetRef: 'b-x', answers: [] }],
      notes: [{ workId: 'w-1', text: '강조점' }, { workId: '', text: '버려짐' }] }) });
  assert.strictEqual(r.body.overlay.overrides.length, 1);
  assert.strictEqual(r.body.overlay.notes.length, 1);
});

await t('학생은 오버레이를 내 것 → 반 공통 순으로 받는다', async () => {
  const s = memStore();
  await s.putOverlay('default', { overrides: [{ targetRef: 'b-1', answers: ['공통'] }], notes: [] });
  assert.strictEqual((await call(s, { path: '/api/naesin-ko/overlay' })).body.scope, 'default');
  await s.putOverlay('st-1', { overrides: [{ targetRef: 'b-1', answers: ['내것'] }], notes: [] });
  const mine = await call(s, { path: '/api/naesin-ko/overlay' });
  assert.strictEqual(mine.body.scope, 'student');
  assert.strictEqual(mine.body.overlay.overrides[0].answers[0], '내것');
});

await t('수업 과제는 유형이 하나 이상이어야 하고 없는 팩은 거절한다', async () => {
  const s = memStore();
  const noType = await call(s, { path: '/api/naesin-ko/admin/task', method: 'POST', who: ADMIN,
    getBody: async () => ({ date: '2026-12-01', title: '오늘 과제', typeKeys: [] }) });
  assert.strictEqual(noType.status, 400);
  const ghost = await call(s, { path: '/api/naesin-ko/admin/task', method: 'POST', who: ADMIN,
    getBody: async () => ({ date: '2026-12-01', title: '오늘 과제', typeKeys: ['구절 적용'], packId: 'ghost' }) });
  assert.strictEqual(ghost.status, 400);
});

await t('검수 대기 목록은 팩과 다른 키에 산다 — 학생 라우트로 새지 않는다(§7[3])', async () => {
  const s = memStore();
  const row = { itemId: 'w-1:it-1', stem: '화자의 태도를 쓰시오.', model: ['모범답안'] };
  const put = await call(s, { path: '/api/naesin-ko/admin/pending', method: 'POST', who: ADMIN,
    getBody: async () => ({ id: PACK.packId, pending: [row] }) });
  assert.strictEqual(put.status, 200);
  assert.strictEqual(put.body.count, 1);
  const got = await call(s, { path: '/api/naesin-ko/admin/pending', method: 'GET', who: ADMIN,
    query: new URLSearchParams({ id: PACK.packId }) });
  assert.deepStrictEqual(got.body.pending, [row]);
  /* 검수본을 넣어도 팩은 그대로다 — 초안이 학생 /pack 응답에 섞이면 안 된다 */
  assert.strictEqual(await s.getPack(PACK.packId), null);
});

await t('검수 목록은 관리자만, 배열만, 1MB까지', async () => {
  const s = memStore();
  const asStudent = await call(s, { path: '/api/naesin-ko/admin/pending', method: 'GET',
    query: new URLSearchParams({ id: PACK.packId }) });
  assert.strictEqual(asStudent.status, 403);
  const noAuth = await call(s, { path: '/api/naesin-ko/admin/pending', method: 'GET', who: null,
    query: new URLSearchParams({ id: PACK.packId }) });
  assert.strictEqual(noAuth.status, 401);
  const badId = await call(s, { path: '/api/naesin-ko/admin/pending', method: 'POST', who: ADMIN,
    getBody: async () => ({ id: '나쁜 아이디', pending: [] }) });
  assert.strictEqual(badId.status, 400);
  const notArray = await call(s, { path: '/api/naesin-ko/admin/pending', method: 'POST', who: ADMIN,
    getBody: async () => ({ id: PACK.packId, pending: { itemId: 'x' } }) });
  assert.strictEqual(notArray.status, 400);
  const huge = await call(s, { path: '/api/naesin-ko/admin/pending', method: 'POST', who: ADMIN,
    getBody: async () => ({ id: PACK.packId, pending: [{ stem: 'ㄱ'.repeat(1100000) }] }) });
  assert.strictEqual(huge.status, 413);
  /* 거절된 요청은 아무것도 남기지 않는다 */
  const empty = await call(s, { path: '/api/naesin-ko/admin/pending', method: 'GET', who: ADMIN,
    query: new URLSearchParams({ id: PACK.packId }) });
  assert.deepStrictEqual(empty.body.pending, []);
  assert.strictEqual(empty.body.updatedAt, null);
});

await t('루브릭 반영은 팩 추가와 대기 제거를 한 요청으로 한다 — 서술형 아닌 검수 레코드는 그대로 둔다', async () => {
  const s = memStore();
  const item = { id: 'it-essay-1', format: 'essay', stem: '쓰시오.', rubric: [{ element: 'ㄱ', keywords: ['ㄴ'] }] };
  const withItem = Object.assign({}, PACK, { items: [item] });
  await call(s, { path: '/api/naesin-ko/admin/pack', method: 'POST', who: ADMIN,
    getBody: async () => ({ id: PACK.packId, pack: PACK }) });
  await call(s, { path: '/api/naesin-ko/admin/pending', method: 'POST', who: ADMIN,
    getBody: async () => ({ id: PACK.packId, pending: [
      { kind: 'item', item: { id: 'it-essay-1' } },
      { kind: 'item', item: { id: 'it-essay-2' } },
      { kind: 'set', why: '좌우 대조 미달' },
    ] }) });
  const r = await call(s, { path: '/api/naesin-ko/admin/rubric', method: 'POST', who: ADMIN,
    getBody: async () => ({ id: PACK.packId, pack: withItem, doneItemId: 'it-essay-1' }) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.removed, 1);
  const left = (await s.getPending(PACK.packId)).pending;
  assert.deepStrictEqual(left.map((x) => (x.item && x.item.id) || x.kind), ['it-essay-2', 'set']);
  assert.strictEqual((await s.getPack(PACK.packId)).pack.items.length, 1);
});

await t('팩에 없는 문항은 대기 목록에서 빼지 않는다 — 양쪽 어디에도 없는 상태를 만들지 않는다', async () => {
  const s = memStore();
  await call(s, { path: '/api/naesin-ko/admin/pack', method: 'POST', who: ADMIN,
    getBody: async () => ({ id: PACK.packId, pack: PACK }) });
  await call(s, { path: '/api/naesin-ko/admin/pending', method: 'POST', who: ADMIN,
    getBody: async () => ({ id: PACK.packId, pending: [{ kind: 'item', item: { id: 'it-ghost' } }] }) });
  const r = await call(s, { path: '/api/naesin-ko/admin/rubric', method: 'POST', who: ADMIN,
    getBody: async () => ({ id: PACK.packId, pack: PACK, doneItemId: 'it-ghost' }) });
  assert.strictEqual(r.status, 400);
  assert.strictEqual((await s.getPending(PACK.packId)).pending.length, 1);
});

await t('불러온 뒤 팩이 바뀌었으면 409 — 같이 저작해도 앞 사람 것을 덮지 않는다', async () => {
  const s = memStore();
  const A = { id: 'it-a', format: 'essay', rubric: [{ element: 'ㄱ', keywords: ['ㄴ'] }] };
  const B = { id: 'it-b', format: 'essay', rubric: [{ element: 'ㄷ', keywords: ['ㄹ'] }] };
  await call(s, { path: '/api/naesin-ko/admin/pack', method: 'POST', who: ADMIN,
    getBody: async () => ({ id: PACK.packId, pack: PACK }) });
  /* 두 사람이 같은 팩(문항 0개)을 불러온 뒤 각자 자기 문항만 더해서 보낸다 */
  const first = await call(s, { path: '/api/naesin-ko/admin/rubric', method: 'POST', who: ADMIN,
    getBody: async () => ({ id: PACK.packId, pack: Object.assign({}, PACK, { items: [A] }), doneItemId: 'it-a' }) });
  assert.strictEqual(first.status, 200);
  const second = await call(s, { path: '/api/naesin-ko/admin/rubric', method: 'POST', who: ADMIN,
    getBody: async () => ({ id: PACK.packId, pack: Object.assign({}, PACK, { items: [B] }), doneItemId: 'it-b' }) });
  assert.strictEqual(second.status, 409);
  assert.deepStrictEqual(second.body.lost, ['items:it-a']);
  /* 앞 사람 문항이 살아 있다 — 덮어썼다면 여기서 it-b 만 남는다 */
  assert.deepStrictEqual((await s.getPack(PACK.packId)).pack.items.map((x) => x.id), ['it-a']);
});

await t('이미 팩에 든 문항은 pack 없이 대기 목록에서만 뺄 수 있다 — 막힌 카드의 퇴로', async () => {
  const s = memStore();
  const item = { id: 'it-dup', format: 'essay', rubric: [{ element: 'ㄱ', keywords: ['ㄴ'] }] };
  await call(s, { path: '/api/naesin-ko/admin/pack', method: 'POST', who: ADMIN,
    getBody: async () => ({ id: PACK.packId, pack: Object.assign({}, PACK, { items: [item] }) }) });
  await call(s, { path: '/api/naesin-ko/admin/pending', method: 'POST', who: ADMIN,
    getBody: async () => ({ id: PACK.packId, pending: [{ kind: 'item', item: { id: 'it-dup' } }] }) });
  const r = await call(s, { path: '/api/naesin-ko/admin/rubric', method: 'POST', who: ADMIN,
    getBody: async () => ({ id: PACK.packId, doneItemId: 'it-dup' }) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await s.getPending(PACK.packId)).pending.length, 0);
});

await t('루브릭 반영도 관리자만', async () => {
  const s = memStore();
  const r = await call(s, { path: '/api/naesin-ko/admin/rubric', method: 'POST',
    getBody: async () => ({ id: PACK.packId, doneItemId: 'it-a' }) });
  assert.strictEqual(r.status, 403);
  const anon = await call(s, { path: '/api/naesin-ko/admin/rubric', method: 'POST', who: null,
    getBody: async () => ({ id: PACK.packId, doneItemId: 'it-a' }) });
  assert.strictEqual(anon.status, 401);
});

await t('루브릭 없는 서술형은 서버가 막는다 — 게이트가 화면에만 있으면 API 직통으로 뚫린다', async () => {
  const s = memStore();
  const noRubric = Object.assign({}, PACK, { items: [{ id: 'it-1', format: 'essay', stem: '쓰시오.' }] });
  const r = await call(s, { path: '/api/naesin-ko/admin/pack', method: 'POST', who: ADMIN,
    getBody: async () => ({ id: PACK.packId, pack: noRubric }) });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /rubric/);
  assert.strictEqual(await s.getPack(PACK.packId), null);
  /* 요소만 있고 키워드가 없는 것도 같다 — 채점기가 아무것도 못 찾는다 */
  const noKw = Object.assign({}, PACK, { items: [{ id: 'it-1', format: 'essay', rubric: [{ element: 'ㄱ', keywords: [] }] }] });
  assert.strictEqual((await call(s, { path: '/api/naesin-ko/admin/pack', method: 'POST', who: ADMIN,
    getBody: async () => ({ id: PACK.packId, pack: noKw }) })).status, 400);
  /* 제대로 된 것은 지나간다 */
  const ok = Object.assign({}, PACK, { items: [{ id: 'it-1', format: 'essay', rubric: [{ element: 'ㄱ', keywords: ['ㄴ'] }] }] });
  assert.strictEqual((await call(s, { path: '/api/naesin-ko/admin/pack', method: 'POST', who: ADMIN,
    getBody: async () => ({ id: PACK.packId, pack: ok }) })).status, 200);
});

await t('문항 id가 겹치는 팩도 서버가 막는다 — 학생 기록이 한 칸에 섞인다', async () => {
  const s = memStore();
  const dup = Object.assign({}, PACK, { items: [
    { id: 'it-1', format: 'mc5' }, { id: 'it-1', format: 'ox' }] });
  const r = await call(s, { path: '/api/naesin-ko/admin/pack', method: 'POST', who: ADMIN,
    getBody: async () => ({ id: PACK.packId, pack: dup }) });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /겹/);
});

await t('루브릭 반영 경로도 같은 게이트를 지난다', async () => {
  const s = memStore();
  await call(s, { path: '/api/naesin-ko/admin/pack', method: 'POST', who: ADMIN,
    getBody: async () => ({ id: PACK.packId, pack: PACK }) });
  const empty = Object.assign({}, PACK, { items: [{ id: 'it-x', format: 'essay', rubric: [] }] });
  const r = await call(s, { path: '/api/naesin-ko/admin/rubric', method: 'POST', who: ADMIN,
    getBody: async () => ({ id: PACK.packId, pack: empty, doneItemId: 'it-x' }) });
  assert.strictEqual(r.status, 400);
  assert.deepStrictEqual((await s.getPack(PACK.packId)).pack.items, undefined);
});

await t('회복 편성 안전판은 기한이 있어야 저장된다 — 기한 없는 안전판은 게이트를 있으나 마나로 만든다', async () => {
  const s = memStore();
  const noUntil = await call(s, { path: '/api/naesin-ko/admin/overlay', method: 'POST', who: ADMIN,
    getBody: async () => ({ scope: 'st-1', recovery: { parallel: true } }) });
  assert.strictEqual(noUntil.status, 400);
  const ok = await call(s, { path: '/api/naesin-ko/admin/overlay', method: 'POST', who: ADMIN,
    getBody: async () => ({ scope: 'st-1', recovery: { parallel: true, opens: ['w-1'], until: '2026-10-15', why: '범위가 넓어 순차로는 못 끝냅니다' } }) });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(ok.body.overlay.recovery,
    { parallel: true, opens: ['w-1'], until: '2026-10-15', why: '범위가 넓어 순차로는 못 끝냅니다' });
  /* 학생이 자기 오버레이로 받아 간다 — 게이트를 여는 것은 학생 앱이다 */
  const mine = await call(s, { path: '/api/naesin-ko/overlay', method: 'GET' });
  assert.strictEqual(mine.body.overlay.recovery.parallel, true);
});

await t('아무것도 열지 않는 안전판은 저장하지 않는다 — 기록만 남고 효과가 없으면 읽는 사람을 속인다', async () => {
  const s = memStore();
  const r = await call(s, { path: '/api/naesin-ko/admin/overlay', method: 'POST', who: ADMIN,
    getBody: async () => ({ scope: 'st-1', recovery: { parallel: false, opens: [], until: '2026-10-15' } }) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.overlay.recovery, undefined);
});

await t('몸통이 JSON이 아니면 저장 전에 400', async () => {
  const s = memStore();
  const r = await call(s, { path: '/api/naesin-ko/state', method: 'PUT',
    getBody: async () => { throw new Error('bad json'); } });
  assert.strictEqual(r.status, 400);
});

await t('naesinKoSummary는 요약이 객체일 때만 실어 보낸다', async () => {
  const row = naesinKoSummary('st-1', { name: '김지우', cls: '중2 A반' }, { summary: { works: 2 }, updatedAt: 'x' });
  assert.strictEqual(row.name, '김지우');
  assert.deepStrictEqual(row.summary, { works: 2 });
  const bad = naesinKoSummary('st-2', null, { summary: ['배열은 안 됨'], updatedAt: 'x' });
  assert.strictEqual(bad.summary, undefined);
  assert.strictEqual(bad.linked, true);
});

await t('학생은 배정된 단원만 받는다 — 팩 id 는 교과서 좌표라 추측이 된다(§10-4)', async () => {
  const s = memStore();
  await call(s, { path: '/api/naesin-ko/admin/pack', method: 'POST', who: ADMIN,
    getBody: async () => ({ id: PACK.packId, pack: PACK }) });
  const q = new URLSearchParams({ id: PACK.packId });

  /* 범위가 없으면 막힌다 — 예전에는 인증만 있으면 누구에게나 나갔다 */
  assert.strictEqual((await call(s, { path: '/api/naesin-ko/pack', query: q })).status, 403);

  /* 내 범위에 들어오면 받는다 */
  await call(s, { path: '/api/naesin-ko/admin/exam', method: 'POST', who: ADMIN,
    getBody: async () => ({ scope: 'st-1', examDate: '2099-12-31', packIds: [PACK.packId] }) });
  assert.strictEqual((await call(s, { path: '/api/naesin-ko/pack', query: q })).status, 200);

  /* 남의 범위에만 있는 단원은 여전히 막힌다 */
  const other = new URLSearchParams({ id: 'other-ko-u9' });
  assert.strictEqual((await call(s, { path: '/api/naesin-ko/pack', query: other })).status, 403);
});

await t('반 공통(default) 범위도 통과하고, 관리자는 범위와 무관하게 받는다', async () => {
  const s = memStore();
  await call(s, { path: '/api/naesin-ko/admin/pack', method: 'POST', who: ADMIN,
    getBody: async () => ({ id: PACK.packId, pack: PACK }) });
  const q = new URLSearchParams({ id: PACK.packId });

  /* 관리자는 게이트를 지난다 — 검수 화면·루브릭 저작이 방금 올린 팩을 같은 라우트로 되읽는다 */
  assert.strictEqual((await call(s, { path: '/api/naesin-ko/pack', who: ADMIN, query: q })).status, 200);

  /* 학생은 아직 403 */
  assert.strictEqual((await call(s, { path: '/api/naesin-ko/pack', query: q })).status, 403);

  /* 반 공통으로 걸면 열린다 — /exam 라우트의 폴백 순서와 같아야 한다 */
  await call(s, { path: '/api/naesin-ko/admin/exam', method: 'POST', who: ADMIN,
    getBody: async () => ({ scope: 'default', examDate: '2099-12-31', packIds: [PACK.packId] }) });
  assert.strictEqual((await call(s, { path: '/api/naesin-ko/pack', query: q })).status, 200);

  /* 내 범위가 따로 있으면 그것이 이긴다 — 반 공통에만 있는 단원은 막힌다.
     (/admin/exam 은 없는 팩 id 를 400 으로 막으므로 2단원 팩을 먼저 올린다) */
  const U2 = { packId: 'mine-ko-u2', revision: '데모', works: [{ workId: 'w-2', title: '더미 2단원' }] };
  await call(s, { path: '/api/naesin-ko/admin/pack', method: 'POST', who: ADMIN,
    getBody: async () => ({ id: U2.packId, pack: U2 }) });
  const put = await call(s, { path: '/api/naesin-ko/admin/exam', method: 'POST', who: ADMIN,
    getBody: async () => ({ scope: 'st-1', examDate: '2099-12-31', packIds: [U2.packId] }) });
  assert.strictEqual(put.status, 200, '학생 범위 저장 실패: ' + JSON.stringify(put.body));
  assert.strictEqual((await call(s, { path: '/api/naesin-ko/pack', query: q })).status, 403);
});

await t('몸통 상한은 관리 경로만 크다 — 형제 앱과 같은 모양', async () => {
  assert.strictEqual(naesinKoBodyLimit('/api/naesin-ko/admin/pack'), 4_500_000);
  assert.strictEqual(naesinKoBodyLimit('/api/naesin-ko/admin/rubric'), 4_500_000);
  assert.strictEqual(naesinKoBodyLimit('/api/naesin-ko/admin/pending'), 4_500_000);
  /* 학생 기록·서술형 제출은 작다 — 기기 하나가 수십 MB 를 밀어 넣지 못하게 */
  assert.strictEqual(naesinKoBodyLimit('/api/naesin-ko/state'), 300_000);
  assert.strictEqual(naesinKoBodyLimit('/api/naesin-ko/review'), 300_000);
  assert.strictEqual(naesinKoBodyLimit('/api/naesin-ko/admin/exam'), 300_000);
});

await t('모르는 경로는 404', async () => {
  const s = memStore();
  assert.strictEqual((await call(s, { path: '/api/naesin-ko/nope', who: ADMIN })).status, 404);
});

/* ── 라이선스 자료가 학생 기록을 타고 KV·야간 백업에 눕지 않는가 ──
   오답노트가 발문 원문을 담고 있었다(2026-10-11 발견). 앱은 이제 좌표만 적지만, 서비스 워커에
   옛 버전이 남은 태블릿이 한동안 계속 발문을 올려 보낸다. 서버가 쓸 때·읽을 때 모두 떼어 낸다.
   자료는 금고(원장 PC)에만 둔다는 결정의 전제가 "자료는 라이선스 칸에만 있다"이고,
   이 가드가 그 전제를 지킨다. */
const STEM = '이 시의 화자가 처한 상황으로 가장 적절한 것은?';
const dirtyState = () => ({
  v: 1, savedAt: 1, packs: {
    'dummy-ko-u1': {
      states: {}, essays: {}, dump: [], log: [],
      wrong: {
        'item-a': { key: 'item-a', label: STEM, n: 2, cleared: false, dates: [] },
        'rt-b': { key: 'rt-b', label: '㉠ ‘죽는 날까지’의 함축적 의미', n: 1, cleared: false, dates: [] },
        'apply-c': { key: 'apply-c', workId: 'w-1', kind: 'apply', no: 7, n: 1, cleared: false, dates: [] },
      },
    },
  },
});
const stemsIn = (o) => JSON.stringify(o).includes(STEM);

await t('학생이 올린 발문은 저장되지 않는다 — 좌표는 남는다', async () => {
  const s = memStore();
  const r = await call(s, { path: '/api/naesin-ko/state', method: 'PUT',
    getBody: async () => ({ state: dirtyState() }) });
  assert.strictEqual(r.status, 200);
  const saved = s._raw.states['st-1'];
  assert.ok(saved, '기록이 저장되지 않았다');
  assert.ok(!stemsIn(saved), '발문이 저장소에 들어갔다 — KV·야간 백업까지 복제된다');
  const w = saved.state.packs['dummy-ko-u1'].wrong;
  /* 지우는 것은 글뿐이다 — 오답노트 자체(횟수·해결 여부)는 학생의 공부 기록이라 남는다 */
  assert.strictEqual(w['item-a'].n, 2);
  assert.strictEqual(w['item-a'].cleared, false);
  assert.ok(!('label' in w['item-a']), 'label 이 남아 있다');
  assert.ok(!('label' in w['rt-b']), '주석 복원 쪽 label 이 남아 있다');
  /* 좌표만 적은 새 앱의 기록은 손대지 않는다 */
  assert.strictEqual(w['apply-c'].workId, 'w-1');
  assert.strictEqual(w['apply-c'].no, 7);
});

await t('발문을 뺀 뒤의 크기로 상한을 잰다 — 옛 기기가 기록을 아예 못 올리면 안 된다', async () => {
  const s = memStore();
  const st = dirtyState();
  /* 상한(300KB)을 넘기는 것은 발문뿐이게 만든다 */
  st.packs['dummy-ko-u1'].wrong['item-big'] = { key: 'item-big', label: '가'.repeat(200_000), n: 1, cleared: false, dates: [] };
  const r = await call(s, { path: '/api/naesin-ko/state', method: 'PUT', getBody: async () => ({ state: st }) });
  assert.strictEqual(r.status, 200, '발문을 떼면 상한 안인데 413 이 났다');
  assert.ok(!('label' in s._raw.states['st-1'].state.packs['dummy-ko-u1'].wrong['item-big']));
});

await t('이미 저장된 발문은 내보내지 않는다 — 기기를 바꿔도 다시 퍼지지 않는다', async () => {
  const s = memStore();
  /* 가드가 생기기 전에 들어간 기록을 직접 심는다 */
  s._raw.states['st-1'] = { state: dirtyState(), updatedAt: '2026-10-01T00:00:00.000Z' };
  const r = await call(s, { path: '/api/naesin-ko/state', method: 'GET' });
  assert.strictEqual(r.status, 200);
  assert.ok(!stemsIn(r.body), '응답에 발문이 실려 나갔다');
});

await t('관리 청소 — GET 은 세어만 보고 POST 가 지운다', async () => {
  const s = memStore();
  s._raw.states['st-1'] = { state: dirtyState(), updatedAt: '2026-10-01T00:00:00.000Z' };
  s._raw.states['st-2'] = { state: dirtyState(), updatedAt: '2026-10-02T00:00:00.000Z' };
  const dry = await call(s, { path: '/api/naesin-ko/admin/scrub', method: 'GET', who: ADMIN });
  assert.strictEqual(dry.status, 200);
  assert.strictEqual(dry.body.dryRun, true);
  assert.strictEqual(dry.body.records, 2);
  assert.strictEqual(dry.body.touched, 2);
  assert.strictEqual(dry.body.labels, 4, '학생 2명 × 발문 2개를 세야 한다');
  /* 세어만 봤으니 아직 저장소에는 남아 있다 */
  assert.ok(stemsIn(s._raw.states['st-1']));

  const wet = await call(s, { path: '/api/naesin-ko/admin/scrub', method: 'POST', who: ADMIN });
  assert.strictEqual(wet.body.dryRun, false);
  assert.strictEqual(wet.body.labels, 4);
  assert.ok(!stemsIn(s._raw.states['st-1']), '청소 뒤에도 발문이 남아 있다');
  assert.ok(!stemsIn(s._raw.states['st-2']));
  /* updatedAt 은 올리지 않는다 — 올리면 학생 기기의 더 새 기록이 서버 것에 밀려 진도가 되돌아간다 */
  assert.strictEqual(s._raw.states['st-1'].updatedAt, '2026-10-01T00:00:00.000Z');
  /* 두 번 돌려도 탈이 없다 */
  assert.strictEqual((await call(s, { path: '/api/naesin-ko/admin/scrub', method: 'POST', who: ADMIN })).body.labels, 0);
});

await t('청소는 관리자만 — 학생 토큰은 403, 기록도 손대지 않는다', async () => {
  const s = memStore();
  /* 관리 경로는 naesin-ko-api.mjs 의 한 줄 관문(`if (!who.admin) return 403`)이 전부 막는다 */
  assert.strictEqual((await call(s, { path: '/api/naesin-ko/admin/scrub', method: 'GET' })).status, 403);
  assert.strictEqual((await call(s, { path: '/api/naesin-ko/admin/scrub', method: 'POST' })).status, 403);
  /* 남의 기록을 훑는 라우트라 막혔을 때 저장소에 손이 가지 않았는지까지 본다 */
  s._raw.states['st-2'] = { state: dirtyState(), updatedAt: '2026-10-02T00:00:00.000Z' };
  await call(s, { path: '/api/naesin-ko/admin/scrub', method: 'POST' });
  assert.ok(stemsIn(s._raw.states['st-2']), '권한 없는 호출이 남의 기록을 고쳤다');
});

console.log('\n통과 ' + passed + '개 — 국어브레인 서버 라우트 검증 완료');
