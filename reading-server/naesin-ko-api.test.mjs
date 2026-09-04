'use strict';
/* 국어브레인 서버 라우트 검증 (node reading-server/naesin-ko-api.test.mjs)
   정본: 국어 기획서 §9.2 라우트·§8 저장 예산·§10-4 접근 통제 */
import assert from 'node:assert';
import { handleNaesinKo, naesinKoSummary } from './naesin-ko-api.mjs';

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

await t('팩 서빙은 학생·관리자 모두 열 수 있고, 없는 팩은 404', async () => {
  const s = memStore();
  await call(s, { path: '/api/naesin-ko/admin/pack', method: 'POST', who: ADMIN,
    getBody: async () => ({ id: PACK.packId, pack: PACK }) });
  const q = new URLSearchParams({ id: PACK.packId });
  const stu = await call(s, { path: '/api/naesin-ko/pack', method: 'GET', query: q });
  assert.strictEqual(stu.status, 200);
  assert.strictEqual(stu.body.pack.packId, PACK.packId);
  const none = await call(s, { path: '/api/naesin-ko/pack', method: 'GET', query: new URLSearchParams({ id: 'no-such-pack' }) });
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

await t('모르는 경로는 404', async () => {
  const s = memStore();
  assert.strictEqual((await call(s, { path: '/api/naesin-ko/nope', who: ADMIN })).status, 404);
});

console.log('\n통과 ' + passed + '개 — 국어브레인 서버 라우트 검증 완료');
