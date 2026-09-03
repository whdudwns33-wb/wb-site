'use strict';
/* 내신 서버 라우트 검증 (node reading-server/naesin-api.test.mjs) */
import assert from 'node:assert';
import { handleNaesin, naesinSummary, normalizeSummary, resolveExam, isValidDate, todayKst,
  TASK_TYPE_KEYS, isTaskTypeKey, isReservedCode, dropReservedRows, naesinBodyLimit, BODY_LIMIT_PACK, BODY_LIMIT_STATE } from './naesin-api.mjs';

let passed = 0;
const t = async (name, fn) => { await fn(); passed += 1; console.log('  ✓ ' + name); };

/* 메모리 어댑터 (worker KV·로컬 파일 어댑터와 동일 계약) */
function memStore() {
  const packs = {}, states = {}, exams = {}, tasks = {}, results = {};
  let packIds = null;
  const students = { 'st-1': { code: 'st-1', name: '김지우', cls: '중2 A반' }, 'st-2': { code: 'st-2', name: '박서준', cls: '중2 A반' } };
  return {
    getPack: (id) => packs[id] || null,
    putPack: (id, rec) => { packs[id] = rec; },
    deletePack: (id) => { delete packs[id]; },
    getPackIds: () => packIds,
    putPackIds: (ids) => { packIds = ids; },
    getState: (c) => states[c] || null,
    putState: (c, rec) => { states[c] = rec; },
    listStateCodes: () => Object.keys(states),
    getExam: (s) => exams[s] || null,
    putExam: (s, rec) => { exams[s] = rec; },
    deleteExam: (s) => { delete exams[s]; },
    listExamScopes: () => Object.keys(exams),
    getTask: (s) => tasks[s] || null,
    putTask: (s, rec) => { tasks[s] = rec; },
    /* 시험 결과 — 워커는 naesin:result:<코드>:<시험일>, 로컬은 db.naesin.results[코드][시험일] */
    getResult: (c, d) => (results[c] || {})[d] || null,
    putResult: (c, d, rec) => { (results[c] = results[c] || {})[d] = rec; },
    deleteResult: (c, d) => { if (results[c]) { delete results[c][d]; if (!Object.keys(results[c]).length) delete results[c]; } },
    listResults: () => Object.entries(results).flatMap(([c, byDate]) =>
      Object.entries(byDate).map(([d, rec]) => ({ ...rec, code: c, examDate: d }))),
    getStudent: (c) => students[c] || null,
    _raw: { packs, states, exams, results, ids: () => packIds },
  };
}
const call = (store, over) => handleNaesin({
  path: '/api/naesin/state', method: 'GET', who: { code: 'st-1', admin: false },
  query: new URLSearchParams(), getBody: async () => ({}), store,
  ...over,
});
const ADMIN = { code: '__admin__', admin: true };
/* 날짜 픽스처 — 오늘(KST) 기준으로 어제·내일을 만든다. 만료 판정은 이 값들로 고정한다. */
const NOW = Date.now();
const kstDay = (off) => todayKst(NOW + off * 86400e3);
const YESTERDAY = kstDay(-1), TOMORROW = kstDay(1), TODAY = kstDay(0);

/* 시드는 자체 제작 더미다 — 기획서 §9.3: 교과서·이그잼포유 문구를 테스트에 쓰지 않는다 */
const PACK = {
  packId: 'dummy-e2-mid1',
  school: '더미중', gradeSem: '2-1', exam: '중간',
  words: [{ word: 'observe', meaning: '관찰하다' }, { word: 'orbit', meaning: '궤도' }],
  sentences: [{ en: 'Dummy sentence one.', ko: '더미 문장 하나.' }],
};
/* 팩을 올리고 반 공통 시험으로 배정한다 — 학생이 팩을 받으려면 이 둘이 먼저다 */
async function seedAssigned(store, ids = ['dummy-e2-mid1'], scope = 'default', examDate = TOMORROW) {
  for (const id of ids) store.putPack(id, { pack: { ...PACK, packId: id }, updatedAt: 'x' });
  store.putPackIds(ids.slice());
  const r = await call(store, { path: '/api/naesin/admin/exam', method: 'POST', who: ADMIN,
    getBody: async () => ({ scope, examDate, packIds: ids }) });
  assert.strictEqual(r.status, 200, '시드 배정 실패: ' + JSON.stringify(r.body));
}

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
    ['/api/naesin/admin/pack', 'DELETE'],
    ['/api/naesin/admin/packs', 'GET'],
    ['/api/naesin/admin/exam', 'POST'],
    ['/api/naesin/admin/exam', 'DELETE'],
    ['/api/naesin/admin/exams', 'GET'],
    ['/api/naesin/admin/overview', 'GET'],
  ]) {
    const r = await call(store, { path, method });
    assert.strictEqual(r.status, 403, path + ' ' + method + ' — 학생에게 열리면 안 된다');
  }
});

await t('팩 저장 → 조회 왕복 — 관리자가 올리고, 배정된 학생이 받고, 목록에 id가 남는다', async () => {
  const store = memStore();
  const up = await call(store, {
    path: '/api/naesin/admin/pack', method: 'POST', who: ADMIN,
    getBody: async () => ({ id: 'dummy-e2-mid1', pack: PACK }),
  });
  assert.strictEqual(up.status, 200);
  assert.strictEqual(up.body.ok, true);
  assert.deepStrictEqual(store._raw.ids(), ['dummy-e2-mid1'], 'naesin:packs 목록 유지');

  /* 강사 검수 화면은 배정 전에도 같은 라우트로 확인한다 — 관리자는 제한 없음 */
  const preview = await call(store, { path: '/api/naesin/pack', who: ADMIN, query: new URLSearchParams('id=dummy-e2-mid1') });
  assert.strictEqual(preview.status, 200);

  await seedAssigned(store);
  const got = await call(store, { path: '/api/naesin/pack', query: new URLSearchParams('id=dummy-e2-mid1') });
  assert.strictEqual(got.status, 200);
  assert.deepStrictEqual(got.body.pack, PACK, '올린 그대로 돌아와야 한다');
  assert.ok(got.body.updatedAt, '저장 시각이 붙는다');
});

await t('[B5] 학생 GET /pack 은 자기 유효 시험의 packIds 만 — 아니면 403(존재 여부도 안 알려 준다)', async () => {
  const store = memStore();
  store.putPack('dummy-e2-mid1', { pack: PACK, updatedAt: 'x' });
  store.putPack('dummy-e2-fin1', { pack: { ...PACK, packId: 'dummy-e2-fin1' }, updatedAt: 'x' });
  const get = (id, who) => call(store, { path: '/api/naesin/pack', ...(who ? { who } : {}), query: new URLSearchParams('id=' + id) });
  let r = await get('dummy-e2-mid1');
  assert.strictEqual(r.status, 403, '배정이 하나도 없으면 403');
  assert.strictEqual(r.body.error, '배정되지 않은 교재예요.');
  assert.strictEqual(r.body.pack, undefined);

  await seedAssigned(store, ['dummy-e2-mid1']);
  assert.strictEqual((await get('dummy-e2-mid1')).status, 200, '반 공통 배정 팩은 200');
  assert.strictEqual((await get('dummy-e2-fin1')).status, 403, '배정 밖 팩은 있어도 403');
  assert.strictEqual((await get('no-such-pack')).status, 403, '없는 팩도 배정 밖이면 403 — 404로 존재를 새지 않는다');
  assert.strictEqual((await get('dummy-e2-fin1', ADMIN)).status, 200, '관리자는 제한 없음');
  assert.strictEqual((await get('no-such-pack', ADMIN)).status, 404, '관리자에게는 없는 팩이 404');

  /* 학생별 배정이 있으면 그 packIds 를 따른다 — 반 공통 팩은 이제 403 */
  store.putExam('st-1', { examDate: TOMORROW, packIds: ['dummy-e2-fin1'], updatedAt: 'x' });
  assert.strictEqual((await get('dummy-e2-fin1')).status, 200);
  assert.strictEqual((await get('dummy-e2-mid1')).status, 403, '개별 배정이 있으면 반 공통 팩은 범위 밖');
  /* 개별 배정이 만료되면 다시 반 공통 범위 */
  store.putExam('st-1', { examDate: YESTERDAY, packIds: ['dummy-e2-fin1'], updatedAt: 'x' });
  assert.strictEqual((await get('dummy-e2-mid1')).status, 200, '만료된 개별 배정은 무시 → 반 공통');
  assert.strictEqual((await get('dummy-e2-fin1')).status, 403);
});

await t('팩 없음 404(관리자), id 형식 오류 400', async () => {
  const store = memStore();
  const get = (q, who) => call(store, { path: '/api/naesin/pack', ...(who ? { who } : {}), query: new URLSearchParams(q) });
  assert.strictEqual((await get('id=no-such-pack', ADMIN)).status, 404);
  assert.strictEqual((await get('')).status, 400, 'id 없음');
  assert.strictEqual((await get('id=ab')).status, 400, '3자 미만');
  assert.strictEqual((await get('id=a!b')).status, 400, '허용 밖 문자');
});

await t('팩 저장 검증 — packId 불일치·형식·pack 누락·크기 상한 4MB(바이트)', async () => {
  const store = memStore();
  const up = (body) => call(store, { path: '/api/naesin/admin/pack', method: 'POST', who: ADMIN, getBody: async () => body });
  assert.strictEqual((await up({ id: 'dummy-e2-mid1', pack: { ...PACK, packId: '다른팩' } })).status, 400, 'packId 불일치 — 다른 팩을 덮어쓰는 사고 방어');
  assert.strictEqual((await up({ id: 'x!', pack: PACK })).status, 400, 'id 형식');
  assert.strictEqual((await up({ id: 'dummy-e2-mid1' })).status, 400, 'pack 누락');
  assert.strictEqual((await up({ id: 'dummy-e2-mid1', pack: [PACK] })).status, 400, 'pack이 배열이면 안 된다');
  const big = await up({ id: 'dummy-e2-mid1', pack: { packId: 'dummy-e2-mid1', blob: 'x'.repeat(4_300_000) } });
  assert.strictEqual(big.status, 413, '4MB 초과 413');
  /* 한글 1.5M자 = 4.5MB — 글자 수로 재면 통과하고 바이트로 재야 걸린다 */
  const hangul = await up({ id: 'dummy-e2-mid1', pack: { packId: 'dummy-e2-mid1', blob: '가'.repeat(1_500_000) } });
  assert.strictEqual(hangul.status, 413, '크기는 UTF-8 바이트로 잰다');
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

await t('[B7] 팩 삭제 — 배정 중이면 409(참조 scope 목록), 아니면 삭제 + 목록에서 제거, 없어도 ok', async () => {
  const store = memStore();
  await seedAssigned(store, ['dummy-e2-mid1', 'dummy-e2-fin1']);
  store.putExam('st-2', { examDate: TOMORROW, packIds: ['dummy-e2-fin1'], updatedAt: 'x' });
  const del = (id) => call(store, { path: '/api/naesin/admin/pack', method: 'DELETE', who: ADMIN, getBody: async () => ({ id }) });
  let r = await del('dummy-e2-fin1');
  assert.strictEqual(r.status, 409, '반 공통·학생별 어느 쪽이든 참조 중이면 거절');
  assert.deepStrictEqual(r.body.scopes.sort(), ['default', 'st-2'], '어느 배정이 붙잡고 있는지 알려 준다');
  assert.ok(store.getPack('dummy-e2-fin1'), '409면 팩이 남아 있다');
  assert.strictEqual((await del('x!')).status, 400, 'id 형식');

  /* 배정을 해제하면 지워진다 */
  await call(store, { path: '/api/naesin/admin/exam', method: 'DELETE', who: ADMIN, getBody: async () => ({ scope: 'st-2' }) });
  store.putExam('default', { examDate: TOMORROW, packIds: ['dummy-e2-mid1'], updatedAt: 'x' });
  r = await del('dummy-e2-fin1');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(store.getPack('dummy-e2-fin1'), null, '팩 본문이 지워진다');
  assert.deepStrictEqual(store._raw.ids(), ['dummy-e2-mid1'], 'naesin:packs 목록에서도 빠진다');
  assert.strictEqual((await del('dummy-e2-fin1')).status, 200, '두 번 눌러도 ok');
});

await t('state 왕복 + 학생 간 격리 — 없으면 {}, summary 는 정규화된 모양으로 저장', async () => {
  const store = memStore();
  const before = await call(store, {});
  assert.strictEqual(before.status, 200);
  assert.deepStrictEqual(before.body.state, {}, '기록이 없으면 빈 객체');
  assert.strictEqual(before.body.updatedAt, null);

  const st = { mastery: { observe: { step: 2 } }, summary: { packId: 'dummy-e2-mid1', word: { total: 77, reached: 41 } } };
  const put = await call(store, { method: 'PUT', getBody: async () => ({ state: st }) });
  assert.strictEqual(put.status, 200);
  assert.ok(put.body.updatedAt);
  const after = await call(store, {});
  assert.deepStrictEqual(after.body.state.mastery, st.mastery, 'summary 밖은 손대지 않는다');
  assert.deepStrictEqual(after.body.state.summary, normalizeSummary(st.summary), '저장본의 summary 는 정규화된 모양');
  assert.strictEqual(after.body.state.summary.word.reached, 41);
  const other = await call(store, { who: { code: 'st-2', admin: false } });
  assert.deepStrictEqual(other.body.state, {}, '다른 학생 기록이 보이면 안 된다');
});

await t('state 저장 — 크기 상한 256KB(413, 바이트 기준)·형식 오류·JSON 파싱 실패 400·호스트 413 전달', async () => {
  const store = memStore();
  const big = await call(store, { method: 'PUT', getBody: async () => ({ state: { blob: 'x'.repeat(300_000) } }) });
  assert.strictEqual(big.status, 413);
  assert.strictEqual(store.getState('st-1'), null, '거절된 기록은 저장되지 않는다');
  /* [B9] 한글 100K자 = 300KB — 글자 수(100K)로 재면 통과해 KV 값 상한 근처에서 터진다 */
  const hangul = await call(store, { method: 'PUT', getBody: async () => ({ state: { blob: '가'.repeat(100_000) } }) });
  assert.strictEqual(hangul.status, 413, '크기는 UTF-8 바이트로 잰다');
  assert.strictEqual((await call(store, { method: 'PUT', getBody: async () => ({}) })).status, 400, 'state 없음');
  assert.strictEqual((await call(store, { method: 'PUT', getBody: async () => ({ state: '문자열' }) })).status, 400, 'state가 객체가 아님');
  assert.strictEqual((await call(store, { method: 'PUT', getBody: async () => ({ state: [1] }) })).status, 400, 'state가 배열');
  const badJson = await call(store, { method: 'PUT', getBody: async () => { throw new Error('bad json'); } });
  assert.strictEqual(badJson.status, 400, '파싱 실패는 500이 아니라 400');
  /* [B4] 로컬 호스트가 스트림 상한 초과를 status 413 오류로 알리면 400이 아니라 413 */
  const tooLarge = await call(store, { method: 'PUT', getBody: async () => { const e = new Error('too large'); e.status = 413; throw e; } });
  assert.strictEqual(tooLarge.status, 413, '호스트의 크기 초과는 413으로 나간다');
});

await t('[B1] normalizeSummary — 화이트리스트 밖 키 삭제, 숫자 강제, 문자열 형식·길이 제한 (저장형 XSS 차단)', () => {
  const xss = '<img src=x onerror=alert(1)>';
  const dirty = {
    packId: xss, extra: xss,
    word: { total: xss, reached: '41', stable: 12.7, risky: -3, needsSpellCheck: Infinity, hack: xss },
    sentence: { total: '25', interpreted: null, memorized: undefined, byStage: { 1: '5', 2: xss, 6: 2, 9: 1 } },
    task: { date: xss, taskAt: xss, title: xss + 'x'.repeat(200), correct: '7', total: '10', script: xss },
    updatedAt: xss,
  };
  const n = normalizeSummary(dirty);
  assert.deepStrictEqual(Object.keys(n).sort(), ['packId', 'sentence', 'task', 'updatedAt', 'word'].sort(), '계약 0.1 키만 남는다');
  assert.strictEqual(n.packId, '', 'PACK_ID_RE 밖 packId 는 비운다');
  assert.deepStrictEqual(n.word, { total: 0, reached: 41, stable: 12, risky: 0, needsSpellCheck: 0 }, '숫자 필드: 문자열 XSS→0, 소수→정수, 음수→0, 비유한→0');
  assert.deepStrictEqual(n.sentence, { total: 25, interpreted: 0, memorized: 0, byStage: { 1: 5, 2: 0, 3: 0, 4: 0, 5: 0, 6: 2 } });
  assert.strictEqual(n.task.date, '', '날짜 형식이 아니면 비운다');
  assert.strictEqual(n.task.taskAt, '', 'ISO 형식이 아니면 비운다');
  assert.strictEqual(n.task.title.length, 80, '제목은 80자');
  assert.ok(n.task.title.startsWith(xss), '문자열은 자르기만 한다 — 이스케이프는 화면(esc()) 몫');
  assert.deepStrictEqual([n.task.correct, n.task.total], [7, 10]);
  assert.strictEqual(n.updatedAt, '');
  assert.ok(!JSON.stringify(n).includes('extra') && !JSON.stringify(n).includes('hack') && !JSON.stringify(n).includes('script'), '모르는 키는 어디에도 남지 않는다');

  /* 정상 값은 그대로 — taskAt 은 과제 updatedAt 과 문자열 비교되므로 손대지 않는다 */
  const clean = { packId: 'dummy-e2-mid1', word: { total: 77, reached: 41, stable: 12, risky: 3, needsSpellCheck: 2 },
    sentence: { total: 25, interpreted: 10, memorized: 4, byStage: { 1: 5, 2: 6, 3: 4, 4: 3, 5: 3, 6: 4 } },
    task: { date: '2026-09-20', taskAt: '2026-09-20T03:00:00.000Z', title: '4교시 과제', correct: 8, total: 10 },
    updatedAt: '2026-09-20T05:00:00.000Z' };
  assert.deepStrictEqual(normalizeSummary(clean), clean, '계약대로 온 값은 한 글자도 안 바뀐다');
  assert.strictEqual(normalizeSummary({ packId: 'dummy-e2-mid1' }).task, null, 'task 없으면 null');
  assert.strictEqual(normalizeSummary({ task: 'x' }).task, null, 'task 가 객체가 아니면 null');
  assert.strictEqual(normalizeSummary([1, 2]), null, '배열은 요약이 아니다');
  assert.strictEqual(normalizeSummary('x'), null);
  assert.strictEqual(normalizeSummary(null), null);
});

await t('[B1] PUT /state 저장 시 + overview 출력 시 둘 다 정규화 — 옛 저장본(직접 넣은 것)도 깨끗하게 나간다', async () => {
  const store = memStore();
  const xss = '<img src=x onerror=alert(1)>';
  const put = await call(store, { method: 'PUT', getBody: async () => ({ state: { summary: { packId: 'dummy-e2-mid1', word: { reached: xss, total: 5 }, evil: xss } } }) });
  assert.strictEqual(put.status, 200);
  const saved = store.getState('st-1').state.summary;
  assert.strictEqual(saved.word.reached, 0);
  assert.strictEqual(saved.evil, undefined, '저장본에 화이트리스트 밖 키가 없다');
  /* 정규화 전에 저장된(혹은 다른 경로로 들어온) 기록 */
  store.putState('st-2', { state: { summary: { word: { total: xss }, task: { title: xss, taskAt: xss } } }, updatedAt: '2026-09-01T09:00:00Z' });
  const r = await call(store, { path: '/api/naesin/admin/overview', who: ADMIN });
  const b = r.body.students.find((s) => s.code === 'st-2');
  assert.strictEqual(b.summary.word.total, 0, '출력 시 다시 정규화');
  assert.strictEqual(b.summary.task.taskAt, '');
  assert.strictEqual(b.summary.task.title, xss, '문자열 자체는 남는다(화면이 esc) — 길이만 제한');
  /* summary 를 아예 안 보내면 저장본에도 없다; 불량이면 지운다 */
  await call(store, { method: 'PUT', getBody: async () => ({ state: { mastery: {} } }) });
  assert.strictEqual(store.getState('st-1').state.summary, undefined);
  await call(store, { method: 'PUT', getBody: async () => ({ state: { summary: 'garbage' } }) });
  assert.strictEqual(store.getState('st-1').state.summary, undefined, '객체가 아닌 summary 는 버린다');
});

await t('시험 폴백 — 학생별 → default → 빈 값', async () => {
  const store = memStore();
  const none = await call(store, { path: '/api/naesin/exam' });
  assert.strictEqual(none.status, 200, '시험이 안 잡힌 것은 오류가 아니다');
  assert.deepStrictEqual(none.body, { exam: {}, scope: null });

  store.putPack('dummy-e2-mid1', { pack: PACK, updatedAt: 'x' });
  const set = (scope) => call(store, {
    path: '/api/naesin/admin/exam', method: 'POST', who: ADMIN,
    getBody: async () => ({ scope, examDate: scope === 'default' ? '2099-10-05' : '2099-10-12', packIds: ['dummy-e2-mid1'] }),
  });
  assert.strictEqual((await set('default')).status, 200);
  const def = await call(store, { path: '/api/naesin/exam' });
  assert.strictEqual(def.body.scope, 'default');
  assert.strictEqual(def.body.exam.examDate, '2099-10-05');

  assert.strictEqual((await set('st-1')).status, 200);
  const mine = await call(store, { path: '/api/naesin/exam' });
  assert.strictEqual(mine.body.scope, 'student', '학생별 설정이 default를 이긴다');
  assert.strictEqual(mine.body.exam.examDate, '2099-10-12');
  const s2 = await call(store, { path: '/api/naesin/exam', who: { code: 'st-2', admin: false } });
  assert.strictEqual(s2.body.scope, 'default', '다른 학생은 여전히 반 공통');
});

await t('[B2] resolveExam — 만료된 개별 배정은 반 공통에 진다, 반 공통은 지나도 그대로(시험 종료 표시는 앱 몫)', async () => {
  const store = memStore();
  store.putExam('st-1', { examDate: YESTERDAY, packIds: ['dummy-e2-old'], updatedAt: 'x' });
  assert.deepStrictEqual(await resolveExam(store, 'st-1', NOW), { exam: {}, scope: null }, '만료된 개별 배정만 있으면 빈 값');
  store.putExam('default', { examDate: TOMORROW, packIds: ['dummy-e2-mid1'], updatedAt: 'x' });
  let r = await resolveExam(store, 'st-1', NOW);
  assert.strictEqual(r.scope, 'default', '지난 학기 개별 배정이 반의 새 시험을 가리지 않는다');
  assert.deepStrictEqual(r.exam.packIds, ['dummy-e2-mid1']);
  store.putExam('st-1', { examDate: TODAY, packIds: ['dummy-e2-old'], updatedAt: 'x' });
  assert.strictEqual((await resolveExam(store, 'st-1', NOW)).scope, 'student', '시험 당일까지는 유효(examDate < 오늘 만 만료)');
  store.putExam('default', { examDate: YESTERDAY, packIds: ['dummy-e2-mid1'], updatedAt: 'x' });
  store.deleteExam('st-1');
  r = await resolveExam(store, 'st-1', NOW);
  assert.strictEqual(r.scope, 'default', '반 공통은 지난 날짜여도 준다');
  assert.strictEqual(r.exam.examDate, YESTERDAY);
  /* 라우트도 같은 해석 — ctx.now 로 고정 */
  store.putExam('st-1', { examDate: YESTERDAY, packIds: ['dummy-e2-old'], updatedAt: 'x' });
  const via = await call(store, { path: '/api/naesin/exam', now: NOW });
  assert.strictEqual(via.body.scope, 'default');
  assert.deepStrictEqual(await resolveExam(store, '__admin__x!', NOW), { exam: store.getExam('default'), scope: 'default' }, '코드 형식 밖이면 개별 조회를 건너뛴다');
});

await t('시험 등록 검증 — scope·학생 존재·실제 달력 날짜·팩 존재·wordDeadlineDays', async () => {
  const store = memStore();
  store.putPack('dummy-e2-mid1', { pack: PACK, updatedAt: 'x' });
  const set = (body) => call(store, { path: '/api/naesin/admin/exam', method: 'POST', who: ADMIN, getBody: async () => body });
  const ok = { scope: 'default', examDate: '2099-10-05', packIds: ['dummy-e2-mid1'] };
  assert.strictEqual((await set({ ...ok, scope: '한글반' })).status, 400, 'scope 형식');
  assert.strictEqual((await set({ ...ok, scope: 'ghost-9' })).status, 404, '등록 안 된 학생 코드');
  assert.strictEqual((await set({ ...ok, examDate: '10월 5일' })).status, 400, '날짜 형식');
  assert.strictEqual((await set({ ...ok, examDate: '2026-13-45' })).status, 400, '[B2] 모양만 맞는 날짜는 실제 달력으로 거른다');
  assert.strictEqual((await set({ ...ok, examDate: '2026-02-30' })).status, 400, '2월 30일');
  assert.strictEqual((await set({ ...ok, examDate: '2028-02-29' })).status, 200, '윤년 2월 29일은 통과');
  assert.strictEqual((await set({ ...ok, packIds: [] })).status, 400, '빈 packIds');
  assert.strictEqual((await set({ ...ok, packIds: ['no-such-pack'] })).status, 400, '없는 팩은 배정 전에 걸러 준다');
  assert.strictEqual((await set({ ...ok, examDate: YESTERDAY })).status, 200, '지난 날짜도 저장은 한다(관리 웹이 경고)');
  const saved = await set(ok);
  assert.strictEqual(saved.status, 200);
  assert.deepStrictEqual(saved.body.exam.packIds, ['dummy-e2-mid1']);
  assert.strictEqual(saved.body.exam.wordDeadlineDays, undefined, '비우면 필드 생략 → 클라이언트 기본 7');
  assert.strictEqual((await set({ ...ok, scope: 'st-2' })).status, 200, '등록된 학생 코드는 통과');

  assert.strictEqual((await set({ ...ok, wordDeadlineDays: 2 })).status, 400, '3 미만');
  assert.strictEqual((await set({ ...ok, wordDeadlineDays: 31 })).status, 400, '30 초과');
  assert.strictEqual((await set({ ...ok, wordDeadlineDays: 7.5 })).status, 400, '정수만');
  assert.strictEqual((await set({ ...ok, wordDeadlineDays: 'x' })).status, 400, '숫자 아님');
  const w = await set({ ...ok, wordDeadlineDays: '10' });
  assert.strictEqual(w.status, 200);
  assert.strictEqual(w.body.exam.wordDeadlineDays, 10, '문자열 숫자는 정수로 저장');
  assert.strictEqual((await set({ ...ok, wordDeadlineDays: '' })).body.exam.wordDeadlineDays, undefined, '빈 문자열은 생략과 같다');
  const mine = await call(store, { path: '/api/naesin/exam' });
  assert.strictEqual(mine.body.exam.wordDeadlineDays, undefined, '학생 응답에도 생략된 채로 내려간다');
});

await t('[B2] GET /admin/exams 목록(default 먼저·만료 표시·이름) + DELETE /admin/exam 해제', async () => {
  const store = memStore();
  let r = await call(store, { path: '/api/naesin/admin/exams', who: ADMIN, now: NOW });
  assert.deepStrictEqual(r.body.exams, [], '비어 있으면 빈 배열');
  assert.strictEqual(r.body.today, TODAY);
  await seedAssigned(store, ['dummy-e2-mid1'], 'st-2', YESTERDAY);
  await seedAssigned(store, ['dummy-e2-mid1'], 'st-1', TOMORROW);
  store.putExam('default', { examDate: TOMORROW, packIds: ['dummy-e2-mid1'], wordDeadlineDays: 10, updatedAt: 'x' });
  r = await call(store, { path: '/api/naesin/admin/exams', who: ADMIN, now: NOW });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.exams.map((e) => e.scope), ['default', 'st-1', 'st-2'], '반 공통이 맨 위, 학생별은 코드순');
  const [def, s1, s2] = r.body.exams;
  assert.deepStrictEqual(def, { scope: 'default', examDate: TOMORROW, packIds: ['dummy-e2-mid1'], wordDeadlineDays: 10, updatedAt: 'x', expired: false, name: '' });
  assert.strictEqual(s1.wordDeadlineDays, undefined, '없으면 생략');
  assert.strictEqual(s1.name, '김지우', '학생 이름을 같이 준다');
  assert.strictEqual(s2.expired, true, '만료된 개별 배정은 expired');
  assert.strictEqual(s1.expired, false);

  const del = (scope) => call(store, { path: '/api/naesin/admin/exam', method: 'DELETE', who: ADMIN, getBody: async () => ({ scope }) });
  assert.strictEqual((await del('한글')).status, 400, 'scope 형식');
  r = await del('st-2');
  assert.deepStrictEqual(r.body, { ok: true, scope: 'st-2' });
  assert.strictEqual(store.getExam('st-2'), null);
  assert.strictEqual((await del('st-2')).status, 200, '없어도 ok');
  assert.strictEqual((await del('default')).status, 200);
  r = await call(store, { path: '/api/naesin/admin/exams', who: ADMIN, now: NOW });
  assert.deepStrictEqual(r.body.exams.map((e) => e.scope), ['st-1']);
  assert.deepStrictEqual((await call(store, { path: '/api/naesin/exam', who: { code: 'st-2', admin: false } })).body, { exam: {}, scope: null }, '해제되면 학생에게도 빈 값');
});

await t('[B8] isValidDate·TASK_TYPE_KEYS·isReservedCode·naesinBodyLimit 헬퍼', () => {
  assert.ok(isValidDate('2026-09-03'));
  assert.ok(isValidDate('2028-02-29'), '윤년');
  assert.ok(!isValidDate('2027-02-29'), '평년 2/29');
  assert.ok(!isValidDate('2026-13-45'));
  assert.ok(!isValidDate('2026-00-10'));
  assert.ok(!isValidDate('2026-9-3'), '자릿수');
  assert.ok(!isValidDate(20260903));
  assert.ok(!isValidDate(''));
  assert.strictEqual(todayKst(Date.UTC(2026, 8, 3, 15, 30)), '2026-09-04', 'UTC 15:30 은 KST 다음날 00:30');
  assert.strictEqual(todayKst(Date.UTC(2026, 8, 3, 14, 59)), '2026-09-03');

  /* 학생 앱 quizTypes()·관리 웹 TYPE_LIST 의 고정 키 전부가 들어 있어야 한다 */
  for (const k of ['w-e2k', 'w-k2e', 'w-spell', 'w-cloze', 'w-def', 'w-poly', 'w-syn', 's-gram', 's-verb', 's-order', 's-kw', 'i-mcq', 'i-multi', 'mock'])
    assert.ok(TASK_TYPE_KEYS.includes(k) && isTaskTypeKey(k), k);
  assert.ok(isTaskTypeKey('g-1') && isTaskTypeKey('g-12'), '문법 패턴 동적 키');
  assert.ok(!isTaskTypeKey('g-') && !isTaskTypeKey('g-x') && !isTaskTypeKey('x-e2k') && !isTaskTypeKey(''));

  assert.ok(isReservedCode('default') && isReservedCode('DEFAULT') && isReservedCode(' Default '));
  assert.ok(!isReservedCode('default1') && !isReservedCode('st-1') && !isReservedCode(null));
  const dr = dropReservedRows({ rows: [{ code: 'wb-101', name: '가' }, { code: 'Default', name: '나' }], errors: ['기존'] });
  assert.deepStrictEqual(dr.rows.map((r) => r.code), ['wb-101'], '[B6] 예약어 코드 줄은 등록에서 빠진다');
  assert.strictEqual(dr.errors.length, 2);
  assert.ok(dr.errors[1].includes('Default'), '어느 줄이 왜 빠졌는지 알려 준다');
  assert.deepStrictEqual(dropReservedRows({ rows: [{ code: 'wb-1', name: 'x' }], errors: [] }).rows.length, 1, '예약어가 없으면 그대로');

  assert.strictEqual(naesinBodyLimit('/api/naesin/admin/pack'), BODY_LIMIT_PACK);
  assert.strictEqual(naesinBodyLimit('/api/naesin/state'), BODY_LIMIT_STATE);
  assert.strictEqual(naesinBodyLimit('/api/naesin/admin/exam'), BODY_LIMIT_STATE);
  assert.ok(BODY_LIMIT_PACK > 4_194_304 && BODY_LIMIT_STATE > 262_144, '선검사 상한은 저장 상한보다 커야 JSON 래핑 여유가 있다');
});

await t('overview — summary 있으면 정규화해서, 없으면 신원 정보만', async () => {
  const store = memStore();
  const summary = { packId: 'dummy-e2-mid1', word: { total: 77, reached: 41, stable: 12, risky: 0, needsSpellCheck: 0 },
    sentence: { total: 25, interpreted: 3, memorized: 6, byStage: { 1: 10, 2: 6, 3: 3, 4: 0, 5: 0, 6: 6 } },
    task: null, updatedAt: '2026-09-01T13:00:00Z' };
  store.putState('st-1', { state: { mastery: {}, summary }, updatedAt: '2026-09-01T13:00:00Z' });
  store.putState('st-2', { state: { mastery: {} }, updatedAt: '2026-09-01T09:00:00Z' });   // summary 없는 옛 클라이언트
  const r = await call(store, { path: '/api/naesin/admin/overview', who: ADMIN });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.students.length, 2, '기록 있는 학생만');
  const [a, b] = r.body.students;
  assert.strictEqual(a.name, '김지우');
  assert.deepStrictEqual(a.summary, summary, '계약대로 온 summary 는 그대로 나간다');
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

await t('수업 과제 — 없으면 빈 값, 등록·조회 왕복, 검증(실제 날짜·[B8] 유형 화이트리스트)', async () => {
  const store = memStore();
  let r = await call(store, { path: '/api/naesin/task' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.task, {}, '과제가 없으면 빈 값 — 평시는 오류가 아니다');
  assert.strictEqual(r.body.scope, null);

  const post = (body) => call(store, { path: '/api/naesin/admin/task', method: 'POST', who: ADMIN, getBody: async () => body });
  assert.strictEqual((await post({ date: '2026-9-20', title: 'x', typeKeys: ['w-e2k'] })).status, 400, '날짜 형식 오류는 저장 전에 거른다');
  assert.strictEqual((await post({ date: '2026-09-31', title: 'x', typeKeys: ['w-e2k'] })).status, 400, '9월 31일은 없다');
  assert.strictEqual((await post({ date: '2026-09-20', title: '4교시 과제', typeKeys: [] })).status, 400, '유형 없는 과제는 거절');
  r = await post({ date: '2026-09-20', title: '4교시 과제', typeKeys: ['w-e2k', 'zzz-hack'] });
  assert.strictEqual(r.status, 400, '모르는 유형 키는 거절 — 학생 화면에서 조용히 빠지는 대신 등록 단계에서 드러난다');
  assert.ok(r.body.error.includes('zzz-hack'));
  r = await post({ date: '2026-09-20', title: '4교시 과제', typeKeys: ['w-e2k', 's-gram', 'g-2', 'w-e2k'], seqFrom: 11, seqTo: 19 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.task.seqFrom, 11);
  assert.deepStrictEqual(r.body.task.typeKeys, ['w-e2k', 's-gram', 'g-2'], '중복 제거, 문법 패턴 키 허용');

  r = await call(store, { path: '/api/naesin/task' });
  assert.strictEqual(r.body.task.title, '4교시 과제');
  assert.strictEqual(r.body.scope, 'default');
  r = await call(store, { path: '/api/naesin/admin/task', who: ADMIN });
  assert.strictEqual(r.body.task.typeKeys.length, 3, '관리자 조회로 현재 과제를 확인한다');

  r = await call(store, { path: '/api/naesin/admin/task', method: 'POST',
    getBody: async () => ({ date: '2026-09-20', title: 'x', typeKeys: ['w-e2k'] }) });
  assert.strictEqual(r.status, 403, '학생은 과제를 등록할 수 없다');
});

await t('모르는 경로는 404', async () => {
  const store = memStore();
  assert.strictEqual((await call(store, { path: '/api/naesin/zzz', who: ADMIN })).status, 404);
  assert.strictEqual((await call(store, { path: '/api/naesin/pack', method: 'POST' })).status, 403, '학생에게 모르는 경로는 관리자 벽(403)에서 끝난다');
});

console.log('\n통과 ' + passed + '개 — naesin-api 서버 라우트 검증 완료');
