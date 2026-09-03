'use strict';
/* 내신 서버 라우트 검증 (node reading-server/naesin-api.test.mjs) */
import assert from 'node:assert';
import fs from 'node:fs';
import { handleNaesin, naesinSummary, normalizeSummary, resolveExam, isValidDate, todayKst,
  TASK_TYPE_KEYS, isTaskTypeKey, isReservedCode, dropReservedRows, naesinBodyLimit, BODY_LIMIT_PACK, BODY_LIMIT_STATE } from './naesin-api.mjs';

let passed = 0;
const t = async (name, fn) => { await fn(); passed += 1; console.log('  ✓ ' + name); };

/* 메모리 어댑터 (worker KV·로컬 파일 어댑터와 동일 계약) */
function memStore() {
  const packs = {}, states = {}, exams = {}, tasks = {}, results = {}, reports = {}, live = {}, votes = {};
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
    getReports: (id) => reports[id] || null,
    putReports: (id, list) => { reports[id] = list; },
    /* 수업 라이브 세션 (계약 L1) — 워커는 naesin:live:/naesin:livevote:, 로컬은 db.naesin.live/votes */
    getLive: (sc) => live[sc] || null,
    putLive: (sc, rec) => { live[sc] = rec; },
    deleteLive: (sc) => { delete live[sc]; delete votes[sc]; },
    getVotes: (sc) => votes[sc] || null,
    putVotes: (sc, rec) => { votes[sc] = rec; },
    getStudent: (c) => students[c] || null,
    _raw: { packs, states, exams, results, reports, live, votes, ids: () => packIds },
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

/* ── R1 범위 요약 · R2 시험 결과 회고 ── */

await t('[R1] normalizeSummary range — 범위 합계도 화이트리스트(팩 id 형식·개수 상한·숫자 강제)', () => {
  const xss = '<img src=x onerror=alert(1)>';
  const n = normalizeSummary({
    packId: 'dummy-e2-mid1',
    word: { total: 5 }, sentence: { total: 5 },
    range: {
      packIds: ['dummy-e2-mid1', 'dummy-e2-mid2', xss, 42, 'a!b'],
      word: { total: '154', reached: 90.9, stable: -3, risky: xss, needsSpellCheck: 1, hack: xss },
      sentence: { total: 50, interpreted: '20', memorized: null, byStage: { 1: '5', 2: xss, 6: 3, 9: 7 }, evil: xss },
      packs: {
        'dummy-e2-mid1': { word: { total: 77, reached: 50, stable: 30, risky: 9 }, sentence: { total: 25, interpreted: 10, memorized: 4 }, junk: xss },
        'dummy-e2-mid2': { word: 'x', sentence: null },
        '나쁜팩!': { word: { total: 99 } },
      },
      extra: xss,
    },
  });
  assert.deepStrictEqual(Object.keys(n.range).sort(), ['packIds', 'packs', 'sentence', 'word'], '계약 R1 키만 남는다');
  assert.deepStrictEqual(n.range.packIds, ['dummy-e2-mid1', 'dummy-e2-mid2'], '팩 id 형식 밖은 버리고 순서는 유지');
  assert.deepStrictEqual(n.range.word, { total: 154, reached: 90, stable: 0, risky: 0, needsSpellCheck: 1 });
  assert.deepStrictEqual(n.range.sentence, { total: 50, interpreted: 20, memorized: 0, byStage: { 1: 5, 2: 0, 3: 0, 4: 0, 5: 0, 6: 3 } });
  assert.deepStrictEqual(Object.keys(n.range.packs), ['dummy-e2-mid1', 'dummy-e2-mid2'], 'packs 키도 팩 id 형식만');
  assert.deepStrictEqual(n.range.packs['dummy-e2-mid1'], {
    word: { total: 77, reached: 50, stable: 30 }, sentence: { total: 25, interpreted: 10, memorized: 4 },
  }, '팩별 값은 계약의 여섯 숫자만(risky·junk 는 버린다)');
  assert.deepStrictEqual(n.range.packs['dummy-e2-mid2'], { word: { total: 0, reached: 0, stable: 0 }, sentence: { total: 0, interpreted: 0, memorized: 0 } });
  assert.ok(!JSON.stringify(n).includes('hack') && !JSON.stringify(n).includes('evil') && !JSON.stringify(n).includes('extra'));

  /* 범위 상한 — 시험 하나에 담기는 팩 수(EXAM_PACKS_MAX=20)까지만 */
  const many = normalizeSummary({ range: { packIds: Array.from({ length: 30 }, (_, i) => 'dummy-pack-' + i),
    packs: Object.fromEntries(Array.from({ length: 30 }, (_, i) => ['dummy-pack-' + i, { word: {}, sentence: {} }])) } });
  assert.strictEqual(many.range.packIds.length, 20);
  assert.strictEqual(Object.keys(many.range.packs).length, 20);

  /* 기존 동작 그대로 — range 가 없으면 키 자체가 없다(옛 클라이언트 저장본에 빈 칸을 만들지 않는다) */
  assert.strictEqual('range' in normalizeSummary({ packId: 'dummy-e2-mid1' }), false);
  assert.strictEqual('range' in normalizeSummary({ range: 'x' }), false);
  assert.strictEqual('range' in normalizeSummary({ range: [1, 2] }), false);
  const clean = { packId: 'dummy-e2-mid1', word: { total: 77, reached: 41, stable: 12, risky: 3, needsSpellCheck: 2 },
    sentence: { total: 25, interpreted: 10, memorized: 4, byStage: { 1: 5, 2: 6, 3: 4, 4: 3, 5: 3, 6: 4 } },
    range: { packIds: ['dummy-e2-mid1', 'dummy-e2-mid2'],
      word: { total: 154, reached: 82, stable: 24, risky: 6, needsSpellCheck: 4 },
      sentence: { total: 50, interpreted: 20, memorized: 8, byStage: { 1: 10, 2: 12, 3: 8, 4: 6, 5: 6, 6: 8 } },
      packs: { 'dummy-e2-mid1': { word: { total: 77, reached: 41, stable: 12 }, sentence: { total: 25, interpreted: 10, memorized: 4 } } } },
    task: null, updatedAt: '2026-09-20T05:00:00.000Z' };
  assert.deepStrictEqual(normalizeSummary(clean), clean, '계약대로 온 값은 한 글자도 안 바뀐다');
});

await t('[R1] PUT /state → overview 까지 range 가 살아서 간다 (관리 현황판의 범위 합계 원천)', async () => {
  const store = memStore();
  const range = { packIds: ['dummy-e2-mid1', 'dummy-e2-mid2'],
    word: { total: 154, reached: 82, stable: 24, risky: 6, needsSpellCheck: 4 },
    sentence: { total: 50, interpreted: 20, memorized: 8, byStage: { 1: 10, 2: 12, 3: 8, 4: 6, 5: 6, 6: 8 } },
    packs: { 'dummy-e2-mid2': { word: { total: 77, reached: 41, stable: 12 }, sentence: { total: 25, interpreted: 10, memorized: 4 } } } };
  await call(store, { method: 'PUT', getBody: async () => ({ state: { summary: { packId: 'dummy-e2-mid2', word: { total: 77 }, sentence: { total: 25 }, range } } }) });
  assert.deepStrictEqual(store.getState('st-1').state.summary.range, range, '저장본에 범위 합계가 그대로 남는다');
  const r = await call(store, { path: '/api/naesin/admin/overview', who: ADMIN });
  assert.deepStrictEqual(r.body.students[0].summary.range, range, 'overview 출력에도 실려 나간다');
});

await t('[P1] normalizeSummary passage — 본문 3트랙 진행(계약 3.6) 화이트리스트·정수 강제·check 두 키', () => {
  const xss = '<img src=x onerror=alert(1)>';
  const n = normalizeSummary({
    packId: 'dummy-e2-mid1',
    passage: { chunkDone: '2', chunkTotal: 3.9, paraBlank: -1, paraTotal: Infinity, cumulative: xss,
      check: { correct: '31', total: 40, hack: xss }, senMiss: { 3: 2 }, evil: xss },
  });
  assert.deepStrictEqual(Object.keys(n.passage).sort(), ['check', 'chunkDone', 'chunkTotal', 'cumulative', 'paraBlank', 'paraTotal'].sort(),
    '계약 3.6 키만 남는다 — senMiss·evil 같은 팩 저장소 기록은 요약에 실려 오지 않는다');
  assert.deepStrictEqual(n.passage, { chunkDone: 2, chunkTotal: 3, paraBlank: 0, paraTotal: 0, cumulative: 0, check: { correct: 31, total: 40 } },
    '문자열 XSS→0, 소수→정수, 음수→0, 비유한→0');
  assert.deepStrictEqual(Object.keys(n.passage.check).sort(), ['correct', 'total'], 'check 는 두 키뿐');
  assert.ok(!JSON.stringify(n).includes('senMiss') && !JSON.stringify(n).includes('evil') && !JSON.stringify(n).includes('hack'),
    '모르는 키는 어디에도 남지 않는다 — 관리 화면에 학생 기기의 문자열이 새 칸으로 끼어들 길이 없다');

  /* 종합 Check 는 '아직 안 봤다'(null)와 '0점'이 다르다 — 화면이 '—'와 0을 가를 수 있어야 한다 */
  assert.strictEqual(normalizeSummary({ passage: { chunkDone: 1 } }).passage.check, null, 'check 없으면 null');
  assert.strictEqual(normalizeSummary({ passage: { check: 'x' } }).passage.check, null, 'check 가 객체가 아니면 null');
  assert.strictEqual(normalizeSummary({ passage: { check: [1, 2] } }).passage.check, null, 'check 가 배열이면 null');
  assert.deepStrictEqual(normalizeSummary({ passage: { check: { correct: 0, total: 40 } } }).passage.check, { correct: 0, total: 40 }, '0점은 0점으로 남는다');

  /* 옛 저장본 무해 — passage 를 모르던 클라이언트의 요약에 빈 칸을 만들지 않는다(range 와 같은 결) */
  assert.strictEqual('passage' in normalizeSummary({ packId: 'dummy-e2-mid1' }), false);
  assert.strictEqual('passage' in normalizeSummary({ passage: 'x' }), false);
  assert.strictEqual('passage' in normalizeSummary({ passage: [1, 2] }), false);
  assert.strictEqual('passage' in normalizeSummary({ passage: null }), false);
  assert.strictEqual('passage' in normalizeSummary({ range: { packIds: [] } }).range, false, '범위 합계도 마찬가지');

  const clean = { packId: 'dummy-e2-mid1', word: { total: 77, reached: 41, stable: 12, risky: 3, needsSpellCheck: 2 },
    sentence: { total: 25, interpreted: 10, memorized: 4, byStage: { 1: 5, 2: 6, 3: 4, 4: 3, 5: 3, 6: 4 } },
    passage: { chunkDone: 2, chunkTotal: 3, paraBlank: 1, paraTotal: 3, cumulative: 2, check: { correct: 31, total: 40 } },
    task: null, updatedAt: '2026-09-20T05:00:00.000Z' };
  assert.deepStrictEqual(normalizeSummary(clean), clean, '계약대로 온 값은 한 글자도 안 바뀐다');
});

await t('[P1] range.passage — 범위 전체 본문 진행 합계도 같은 화이트리스트를 탄다', () => {
  const xss = '<img src=x onerror=alert(1)>';
  const n = normalizeSummary({
    range: { packIds: ['dummy-e2-mid1', 'dummy-e2-mid2'],
      passage: { chunkDone: '5', chunkTotal: 6, paraBlank: 2.7, paraTotal: '6', cumulative: 4, check: { correct: xss, total: '40' }, extra: xss } },
  });
  assert.deepStrictEqual(Object.keys(n.range).sort(), ['packIds', 'packs', 'passage', 'sentence', 'word'], 'range 에 passage 가 더해진다');
  assert.deepStrictEqual(n.range.passage, { chunkDone: 5, chunkTotal: 6, paraBlank: 2, paraTotal: 6, cumulative: 4, check: { correct: 0, total: 40 } });
  assert.ok(!JSON.stringify(n.range).includes('extra'));
});

await t('[P1] PUT /state → overview 까지 passage 가 살아서 간다 (관리 현황판 「본문 진행」의 원천)', async () => {
  const store = memStore();
  const xss = '<img src=x onerror=alert(1)>';
  const passage = { chunkDone: 2, chunkTotal: 3, paraBlank: 1, paraTotal: 3, cumulative: 2, check: { correct: 31, total: 40 } };
  const rangePassage = { chunkDone: 5, chunkTotal: 6, paraBlank: 3, paraTotal: 6, cumulative: 4, check: { correct: 33, total: 40 } };
  await call(store, { method: 'PUT', getBody: async () => ({ state: { summary: {
    packId: 'dummy-e2-mid1', word: { total: 77 }, sentence: { total: 25 },
    passage: { ...passage, script: xss },
    range: { packIds: ['dummy-e2-mid1', 'dummy-e2-mid2'], passage: rangePassage },
  } } }) });
  const saved = store.getState('st-1').state.summary;
  assert.deepStrictEqual(saved.passage, passage, '저장본에 본문 진행이 정규화된 모양으로 남는다');
  assert.deepStrictEqual(saved.range.passage, rangePassage, '범위 합계도 함께 남는다');
  assert.ok(!JSON.stringify(saved).includes('script'), '저장본에 화이트리스트 밖 키가 없다');

  /* 정규화 이전에 들어온(혹은 손으로 넣은) 저장본도 출력 때 다시 걸린다 */
  store.putState('st-2', { state: { summary: { passage: { chunkDone: xss, check: { correct: xss, total: xss, evil: xss } } } }, updatedAt: '2026-09-01T09:00:00Z' });
  const r = await call(store, { path: '/api/naesin/admin/overview', who: ADMIN });
  const a = r.body.students.find((s) => s.code === 'st-1');
  assert.deepStrictEqual(a.summary.passage, passage, 'overview 출력에도 실려 나간다');
  assert.deepStrictEqual(a.summary.range.passage, rangePassage);
  const b = r.body.students.find((s) => s.code === 'st-2');
  assert.deepStrictEqual(b.summary.passage, { chunkDone: 0, chunkTotal: 0, paraBlank: 0, paraTotal: 0, cumulative: 0, check: { correct: 0, total: 0 } },
    '출력 시 다시 정규화 — 강사 화면에 문자열이 그대로 흘러가지 않는다');
});

/* 결과 픽스처 — 단어 10·문장 10짜리 요약. m = 0.04·안정화 + 0.03·해석 + 0.03·백지 */
const snap = (stable, interpreted, memorized) => ({
  packId: 'dummy-e2-mid1', word: { total: 10, reached: stable, stable, risky: 0, needsSpellCheck: 0 },
  sentence: { total: 10, interpreted, memorized, byStage: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: memorized } },
  task: null, updatedAt: '',
});
const postResult = (store, body) => call(store, { path: '/api/naesin/admin/result', method: 'POST', who: ADMIN, getBody: async () => body });

await t('[R2] 결과 저장 — 그 시점의 summary 를 snapshot 으로, 유효 시험 범위를 packIds 로 함께 박는다', async () => {
  const store = memStore();
  await seedAssigned(store, ['dummy-e2-mid1', 'dummy-e2-mid2']);
  store.putState('st-1', { state: { summary: snap(8, 6, 4) }, updatedAt: 'x' });
  const r = await postResult(store, { code: 'st-1', examDate: '2026-10-05', score: 88,
    wrongTypes: { word: 2, grammar: '3', passage: 0 }, memo: '  단어에서 두 개  ' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  const rec = r.body.result;
  assert.strictEqual(rec.code, 'st-1');
  assert.strictEqual(rec.examDate, '2026-10-05');
  assert.strictEqual(rec.score, 88);
  assert.deepStrictEqual(rec.wrongTypes, { word: 2, grammar: 3, passage: 0, writing: 0 }, '빈 칸은 0, 문자열 숫자는 정수');
  assert.strictEqual(rec.memo, '단어에서 두 개', '앞뒤 공백은 잘라 저장');
  assert.deepStrictEqual(rec.packIds, ['dummy-e2-mid1', 'dummy-e2-mid2'], '저장 시점의 유효 시험 범위');
  assert.deepStrictEqual(rec.snapshot, normalizeSummary(snap(8, 6, 4)), '그때의 도달률이 통째로 남는다');
  assert.ok(rec.at, '저장 시각');
  assert.deepStrictEqual(store._raw.results['st-1']['2026-10-05'], rec, '저장소에도 같은 값');

  /* 나중에 학생이 더 공부해 요약이 올라가도, 이미 저장된 결과의 snapshot 은 그대로여야 한다 */
  store.putState('st-1', { state: { summary: snap(10, 10, 10) }, updatedAt: 'y' });
  const list = await call(store, { path: '/api/naesin/admin/results', who: ADMIN });
  assert.deepStrictEqual(list.body.results[0].snapshot, normalizeSummary(snap(8, 6, 4)), '지난 시험의 도달률은 사후에 다시 계산되지 않는다');

  /* 같은 학생·같은 시험일에 다시 넣으면 덮어쓴다(강사가 점수를 고친다) */
  const again = await postResult(store, { code: 'st-1', examDate: '2026-10-05', score: 90 });
  assert.strictEqual(again.body.result.score, 90);
  assert.strictEqual(again.body.result.memo, undefined, '메모를 비우면 필드가 없다');
  assert.strictEqual(again.body.result.wrongTypes, undefined, 'wrongTypes 도 선택 필드');
  assert.strictEqual(Object.keys(store._raw.results['st-1']).length, 1, '덮어쓰기지 새 줄이 아니다');

  /* 요약이 없는 학생(미연동)도 결과는 남길 수 있다 — snapshot 만 null */
  const r2 = await postResult(store, { code: 'st-2', examDate: '2026-10-05', score: 70 });
  assert.strictEqual(r2.body.result.snapshot, null);
});

await t('[R2] 결과 저장 검증 — 학생 존재·실제 달력 날짜·0~100 정수·wrongTypes 0~50 정수·메모 200자', async () => {
  const store = memStore();
  const ok = { code: 'st-1', examDate: '2026-10-05', score: 80 };
  assert.strictEqual((await postResult(store, { ...ok, code: '한글' })).status, 400, 'code 형식');
  assert.strictEqual((await postResult(store, { ...ok, code: 'ghost-9' })).status, 404, '등록 안 된 학생');
  assert.strictEqual((await postResult(store, { ...ok, examDate: '2026-10-5' })).status, 400, '날짜 형식');
  assert.strictEqual((await postResult(store, { ...ok, examDate: '2026-02-30' })).status, 400, '달력에 없는 날');
  assert.strictEqual((await postResult(store, { ...ok, score: 101 })).status, 400, '100 초과');
  assert.strictEqual((await postResult(store, { ...ok, score: -1 })).status, 400, '음수');
  assert.strictEqual((await postResult(store, { ...ok, score: 88.5 })).status, 400, '정수만');
  assert.strictEqual((await postResult(store, { ...ok, score: 'x' })).status, 400, '숫자가 아니면 거절');
  assert.strictEqual((await postResult(store, { ...ok, score: undefined })).status, 400, 'score 필수');
  assert.strictEqual((await postResult(store, { ...ok, score: '' })).status, 400, '빈 칸이 0점으로 저장되면 안 된다');
  assert.strictEqual((await postResult(store, { ...ok, score: null })).status, 400);
  assert.strictEqual((await postResult(store, { ...ok, score: true })).status, 400);
  assert.strictEqual((await postResult(store, { ...ok, wrongTypes: 'x' })).status, 400, 'wrongTypes 객체 아님');
  assert.strictEqual((await postResult(store, { ...ok, wrongTypes: { word: 51 } })).status, 400, '한 유형 50문항 초과');
  assert.strictEqual((await postResult(store, { ...ok, wrongTypes: { word: -1 } })).status, 400);
  assert.strictEqual((await postResult(store, { ...ok, wrongTypes: { word: 1.5 } })).status, 400);
  assert.strictEqual(Object.keys(store._raw.results).length, 0, '거절된 결과는 저장되지 않는다');
  assert.strictEqual((await postResult(store, { ...ok, score: '90' })).body.result.score, 90, '입력칸에서 온 문자열 숫자는 정수로 저장');
  assert.strictEqual((await postResult(store, { ...ok, wrongTypes: { word: '' } })).body.result.wrongTypes.word, 0, '빈 칸은 0');
  const r = await postResult(store, { ...ok, score: 0, wrongTypes: { word: 0, hack: 99 }, memo: '가'.repeat(300) });
  assert.strictEqual(r.status, 200, '0점도 정상 값');
  assert.deepStrictEqual(r.body.result.wrongTypes, { word: 0, grammar: 0, passage: 0, writing: 0 }, '모르는 유형 키는 버린다');
  assert.strictEqual(r.body.result.memo.length, 200, '메모는 200자');
  assert.deepStrictEqual(r.body.result.packIds, [], '시험 배정이 없으면 빈 범위');
  const bad = await call(store, { path: '/api/naesin/admin/result', method: 'POST', who: ADMIN, getBody: async () => { throw new Error('bad json'); } });
  assert.strictEqual(bad.status, 400, '파싱 실패는 400');
});

await t('[R2] 결과 삭제 — 두 번 눌러도 ok, 형식 검증, 퇴원한 학생 것도 지울 수 있다', async () => {
  const store = memStore();
  await postResult(store, { code: 'st-1', examDate: '2026-10-05', score: 80 });
  const del = (body) => call(store, { path: '/api/naesin/admin/result', method: 'DELETE', who: ADMIN, getBody: async () => body });
  assert.strictEqual((await del({ code: '한글', examDate: '2026-10-05' })).status, 400);
  assert.strictEqual((await del({ code: 'st-1', examDate: '2026-13-01' })).status, 400);
  const r = await del({ code: 'st-1', examDate: '2026-10-05' });
  assert.deepStrictEqual(r.body, { ok: true, code: 'st-1', examDate: '2026-10-05' });
  assert.strictEqual(store.getResult('st-1', '2026-10-05'), null);
  assert.strictEqual((await del({ code: 'st-1', examDate: '2026-10-05' })).status, 200, '없어도 ok');
  assert.strictEqual((await del({ code: 'gone-99', examDate: '2026-10-05' })).status, 200, '학생 존재는 보지 않는다(퇴원생 정리)');
});

await t('[R2] GET /admin/results — 시험일 필터·정렬·이름·도달률(reach)·성과 분석(analysis)', async () => {
  const store = memStore();
  /* (m, score) = (.2,60) (.4,70) (.6,80) (.8,90) (1,100) → 완전 직선, r = 1 */
  const seed = [['st-1', 60, snap(5, 0, 0)], ['st-2', 70, snap(10, 0, 0)], ['st-3', 80, snap(6, 8, 4)],
    ['st-4', 90, snap(8, 10, 6)], ['st-5', 100, snap(10, 10, 10)]];
  for (const [code, score, s] of seed) store.putResult(code, '2026-10-05', { code, examDate: '2026-10-05', score, packIds: ['dummy-e2-mid1'], snapshot: s, at: '2026-10-06T00:00:00.000Z' });
  store.putResult('st-1', '2026-05-01', { code: 'st-1', examDate: '2026-05-01', score: 55, packIds: [], snapshot: null, at: '2026-05-02T00:00:00.000Z' });

  const all = await call(store, { path: '/api/naesin/admin/results', who: ADMIN });
  assert.strictEqual(all.status, 200);
  assert.strictEqual(all.body.results.length, 6);
  assert.deepStrictEqual(all.body.results.map((r) => r.examDate + '/' + r.code).slice(0, 6),
    ['2026-10-05/st-1', '2026-10-05/st-2', '2026-10-05/st-3', '2026-10-05/st-4', '2026-10-05/st-5', '2026-05-01/st-1'],
    '최근 시험이 위, 같은 시험이면 코드순');
  assert.strictEqual(all.body.results[0].name, '김지우', '관리 표가 쓸 이름');
  assert.strictEqual(all.body.results[0].cls, '중2 A반');
  assert.strictEqual(all.body.results[2].name, '', '명부에 없는 코드도 줄은 나온다');
  assert.deepStrictEqual(all.body.results[0].reach, { m: 0.2, stable: 0.5, interpret: 0, blank: 0 }, '산점도 x축 — 서버가 계산해서 준다');
  assert.strictEqual(all.body.results[5].reach, null, 'snapshot 없는 옛 결과는 그릴 점이 없다');
  assert.strictEqual(all.body.analysis.n, 6);
  assert.strictEqual(all.body.analysis.r, 1, '도달률과 점수가 같이 움직인다');
  assert.deepStrictEqual(all.body.analysis.groups.highBlank, { n: 1, mean: 100 }, '백지 80% 이상 그룹');
  assert.deepStrictEqual(all.body.analysis.groups.lowBlank, { n: 4, mean: 75 });
  assert.deepStrictEqual(Object.keys(all.body.analysis.byDate), ['2026-05-01', '2026-10-05']);
  assert.deepStrictEqual(all.body.analysis.byDate['2026-10-05'], { n: 5, meanScore: 80, r: 1 });

  const one = await call(store, { path: '/api/naesin/admin/results', who: ADMIN, query: new URLSearchParams('examDate=2026-05-01') });
  assert.strictEqual(one.body.results.length, 1, '시험일 필터');
  assert.strictEqual(one.body.analysis.n, 1);
  assert.strictEqual(one.body.analysis.r, null, '한 건으로는 상관을 내지 않는다');
  assert.strictEqual((await call(store, { path: '/api/naesin/admin/results', who: ADMIN, query: new URLSearchParams('examDate=2026-13-01') })).status, 400, '날짜 형식 오류');
  assert.deepStrictEqual((await call(store, { path: '/api/naesin/admin/results', who: ADMIN })).body.results.length, 6);

  /* 손으로 고쳐진 저장본(형식 밖 줄)은 목록에서 아예 빠진다 — 셈에 끼면 통계가 조용히 틀어진다 */
  store.putResult('한글코드', '2026-10-05', { score: 100 });
  store.putResult('st-9', '엉터리', { code: 'st-9', examDate: '엉터리', score: 100 });
  const clean = await call(store, { path: '/api/naesin/admin/results', who: ADMIN });
  assert.strictEqual(clean.body.results.length, 6, '모양이 아닌 줄은 버린다');
  assert.strictEqual(clean.body.analysis.n, 6);
});

await t('[R2] 학생 GET /result — 내 것만 최신순, prediction 은 표본 5건부터(참고용 숫자)', async () => {
  const store = memStore();
  const seed = [['st-1', 60, snap(5, 0, 0)], ['st-2', 70, snap(10, 0, 0)], ['st-3', 80, snap(6, 8, 4)], ['st-4', 90, snap(8, 10, 6)]];
  for (const [code, score, s] of seed) store.putResult(code, '2026-10-05', { code, examDate: '2026-10-05', score, packIds: ['dummy-e2-mid1'], snapshot: s, at: 'x' });
  store.putState('st-1', { state: { summary: snap(5, 6, 4) }, updatedAt: 'x' });   // m = 0.5

  let r = await call(store, { path: '/api/naesin/result' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.results.length, 1, '남의 결과는 한 줄도 안 나간다');
  assert.strictEqual(r.body.results[0].code, 'st-1');
  assert.strictEqual(r.body.results[0].score, 60);
  assert.deepStrictEqual(r.body.results[0].reach, { m: 0.2, stable: 0.5, interpret: 0, blank: 0 }, '그때의 도달률(회고 칩의 근거)');
  assert.strictEqual(r.body.prediction, null, '표본 4건으로는 예상 점수대를 말하지 않는다');

  /* 다섯 번째 결과가 들어오면 직선이 선다 — score = 50 + 50m, 내 m = 0.5 → 75, RMSE 0 → ±5 */
  store.putResult('st-5', '2026-10-05', { code: 'st-5', examDate: '2026-10-05', score: 100, packIds: [], snapshot: snap(10, 10, 10), at: 'x' });
  r = await call(store, { path: '/api/naesin/result' });
  assert.deepStrictEqual(r.body.prediction, { score: 75, low: 70, high: 80, n: 5 });
  assert.strictEqual(r.body.results.length, 1, '예측은 원내 전체로 계산해도 결과는 내 것만');

  /* 내 결과가 여러 건이면 최신 시험이 위 */
  store.putResult('st-1', '2026-05-01', { code: 'st-1', examDate: '2026-05-01', score: 55, packIds: [], snapshot: null, at: 'x' });
  store.putResult('st-1', '2026-12-10', { code: 'st-1', examDate: '2026-12-10', score: 95, packIds: [], snapshot: null, at: 'x' });
  r = await call(store, { path: '/api/naesin/result' });
  assert.deepStrictEqual(r.body.results.map((x) => x.examDate), ['2026-12-10', '2026-10-05', '2026-05-01']);

  /* 요약이 없는 학생에게는 예측이 없다 — 넣을 도달률이 없다 */
  const s2 = await call(store, { path: '/api/naesin/result', who: { code: 'st-2', admin: false } });
  assert.strictEqual(s2.body.prediction, null);
  assert.strictEqual(s2.body.results.length, 1);
  assert.strictEqual(s2.body.results[0].code, 'st-2');
});

await t('[R2] 결과 라우트 권한 — 미인증 401, 학생은 관리 라우트 403, 관리자는 학생 /result 로 남의 것을 못 본다', async () => {
  const store = memStore();
  store.putResult('st-1', '2026-10-05', { code: 'st-1', examDate: '2026-10-05', score: 80, packIds: [], snapshot: null, at: 'x' });
  for (const [path, method] of [['/api/naesin/result', 'GET'], ['/api/naesin/admin/result', 'POST'],
    ['/api/naesin/admin/result', 'DELETE'], ['/api/naesin/admin/results', 'GET']]) {
    const un = await call(store, { path, method, who: null });
    assert.strictEqual(un.status, 401, path + ' ' + method + ' — 인증 없이는 아무것도 나가지 않는다');
    assert.strictEqual(un.body.results, undefined);
  }
  for (const [path, method] of [['/api/naesin/admin/result', 'POST'], ['/api/naesin/admin/result', 'DELETE'], ['/api/naesin/admin/results', 'GET']]) {
    const r = await call(store, { path, method, getBody: async () => ({ code: 'st-1', examDate: '2026-10-05', score: 100 }) });
    assert.strictEqual(r.status, 403, path + ' ' + method + ' — 학생에게 열리면 안 된다');
  }
  assert.strictEqual(store.getResult('st-1', '2026-10-05').score, 80, '학생 요청은 저장을 못 건드린다');
  assert.strictEqual((await call(store, { path: '/api/naesin/result', who: ADMIN })).status, 404, '학생 라우트는 학생 토큰 전용');
});

await t('[R2] 퇴원(학생 삭제) 처리에 시험 결과 삭제가 들어 있다 — 워커·로컬 서버 양쪽', () => {
  const src = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
  const worker = src('./worker.mjs'), server = src('./server.mjs');
  /* 퇴원 처리 블록만 잘라 본다 — 다른 곳에 있는 삭제로 통과하지 않게 */
  const wDel = worker.split("p === '/api/admin/students' && req.method === 'DELETE'")[1] || '';
  const sDel = server.split("p === '/api/admin/students' && req.method === 'DELETE'")[1] || '';
  assert.ok(wDel.includes("naesin:state:' + c") && wDel.includes("naesin:exam:' + c"), '워커 퇴원 처리가 바뀌었다 — 이 검사를 다시 맞춰야 한다');
  assert.ok(/naesin:result:' \+ c \+ ':'/.test(wDel.slice(0, 2000)),
    '워커 퇴원 처리에 내신 시험 결과 삭제가 없다 — 같은 코드의 새 학생에게 앞 학생 점수가 따라온다');
  assert.ok(sDel.includes('naesinRoot().states') && sDel.includes('naesinRoot().exams'), '로컬 서버 퇴원 처리가 바뀌었다');
  assert.ok(sDel.slice(0, 2000).includes('drop(naesinRoot().results, c)'),
    '로컬 서버 퇴원 처리에 내신 시험 결과 삭제가 없다 — 워커와 한쪽만 고치면 운영에서만 다르게 돈다');
  /* 저장소 어댑터 계약(getResult/putResult/deleteResult/listResults)이 양쪽에 다 있어야 한다 */
  for (const [name, txt] of [['worker.mjs', worker], ['server.mjs', server]]) {
    for (const fn of ['getResult', 'putResult', 'deleteResult', 'listResults'])
      assert.ok(txt.includes(fn + ':'), name + ' 의 내신 저장소 어댑터에 ' + fn + ' 이 없다');
  }
});

await t('[L3] 관리 팩 단건 조회 — 강사 화면이 즉석 문제를 만들려면 팩을 읽어야 한다', async () => {
  const store = memStore();
  store.putPack('ne-m2-L6', { pack: { packId: 'ne-m2-L6', words: [{ id: 'w1', headword: 'apple' }] }, updatedAt: 'x' });
  const r = await call(store, { path: '/api/naesin/admin/pack', who: ADMIN, query: new URLSearchParams('id=ne-m2-L6') });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.pack.words[0].headword, 'apple');
  assert.strictEqual((await call(store, { path: '/api/naesin/admin/pack', who: ADMIN, query: new URLSearchParams('id=nope') })).status, 404);
  assert.strictEqual((await call(store, { path: '/api/naesin/admin/pack', who: ADMIN, query: new URLSearchParams('id=x') })).status, 400, '형식 오류는 400');
  assert.strictEqual((await call(store, { path: '/api/naesin/admin/pack', query: new URLSearchParams('id=ne-m2-L6') })).status, 403,
    '학생은 이 경로로 배정 밖 팩을 읽을 수 없다');
});

/* ── 수업 라이브 세션 (계약 L1 · 기획서 §15-3) ── */
const PJ_ITEMS = [
  { ref: 'q1', prompt: 'apple 의 뜻은?', choices: [{ key: 'a', text: '사과' }, { key: 'b', text: '바나나' }], answerKey: 'a' },
  { ref: 'q2', prompt: 'run 의 과거형은?', choices: [{ key: 'a', text: 'runned' }, { key: 'b', text: 'ran' }], answerKey: 'b' },
];
const setPhase = (store, phase) => call(store, { path: '/api/naesin/admin/live/phase', method: 'POST', who: ADMIN, getBody: async () => ({ phase }) });
const setProj = (store, b) => call(store, { path: '/api/naesin/admin/live/projector', method: 'POST', who: ADMIN, getBody: async () => b });
const getLive = (store, over) => call(store, { path: '/api/naesin/live', ...over });

await t('[L1] 단계는 강사만 세우고, 학생은 읽는다 — endsAt 은 서버가 계산한다', async () => {
  const store = memStore();
  assert.strictEqual((await setPhase(store, { key: 'words', label: '단어 10분', minutes: 10 })).status, 200);
  assert.strictEqual((await call(store, { path: '/api/naesin/admin/live/phase', method: 'POST', getBody: async () => ({ phase: { key: 'words' } }) })).status, 403,
    '학생이 단계를 세울 수 있으면 수업 신호가 학생 손에 넘어간다');
  const r = await getLive(store);
  assert.strictEqual(r.body.live.phase.key, 'words');
  assert.strictEqual(r.body.live.phase.label, '단어 10분');
  assert.ok(r.body.live.phase.remainSec > 9 * 60 && r.body.live.phase.remainSec <= 10 * 60, r.body.live.phase.remainSec);
});

await t('[L1] 모르는 단계는 400 — 학생 앱이 못 따라가는 단계를 만들지 않는다', async () => {
  const store = memStore();
  assert.strictEqual((await setPhase(store, { key: 'hack' })).status, 400);
});

await t('[L1] 세션이 없으면 학생에게 live:null (빈 껍데기를 주지 않는다)', async () => {
  const r = await getLive(memStore());
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.live, null);
});

await t('[L1] 4시간 넘게 방치된 단계는 학생 화면에 남지 않는다', async () => {
  const store = memStore();
  await setPhase(store, { key: 'words', minutes: 10 });
  const later = Date.now() + 5 * 3600e3;
  assert.strictEqual((await getLive(store, { now: later })).body.live, null, '어제 단계가 오늘 아침 화면에 남는다');
  assert.strictEqual((await call(store, { path: '/api/naesin/admin/live', who: ADMIN, now: later })).body.live, null,
    '강사 화면도 끝난 수업을 진행 중으로 보여 주면 안 된다');
});

await t('[L1] 투사 문제에서 정답이 학생 응답에 섞이지 않는다', async () => {
  const store = memStore();
  assert.strictEqual((await setProj(store, { items: PJ_ITEMS })).status, 200);
  const r = await getLive(store);
  assert.strictEqual(JSON.stringify(r.body).indexOf('answerKey'), -1, JSON.stringify(r.body));
  assert.strictEqual(JSON.stringify(r.body).indexOf('ran'), -1, '다음 문제의 보기까지 내려가면 미리 풀어 버린다');
  assert.strictEqual(r.body.live.projector.item.ref, 'q1');
  assert.strictEqual(r.body.live.projector.count, 2);
});

await t('[L1] 공개하면 그 문제의 정답만 붙는다', async () => {
  const store = memStore();
  await setProj(store, { items: PJ_ITEMS });
  await setProj(store, { revealed: true });
  const r = await getLive(store);
  assert.strictEqual(r.body.live.projector.item.answerKey, 'a');
  assert.strictEqual((JSON.stringify(r.body).match(/answerKey/g) || []).length, 1);
});

await t('[L1] 응답은 지금 띄운 문제만 받는다 — 뒤 문제를 미리 찍을 수 없다', async () => {
  const store = memStore();
  await setProj(store, { items: PJ_ITEMS });
  const post = (b, who) => call(store, { path: '/api/naesin/live/answer', method: 'POST', getBody: async () => b, ...(who ? { who } : {}) });
  assert.strictEqual((await post({ ref: 'q1', key: 'a' })).status, 200);
  assert.strictEqual((await post({ ref: 'q2', key: 'b' })).status, 409, '다음 문제에 미리 답하면 TV 진행이 무의미해진다');
  assert.strictEqual((await post({ ref: 'q1', key: 'zz' })).status, 400, '보기에 없는 답');
  assert.strictEqual((await post({ ref: 'nope', key: 'a' })).status, 400);
  assert.strictEqual((await post({ ref: 'q1', key: 'a' }, ADMIN)).status, 404,
    '학생 라우트는 학생 토큰 전용 — 강사 토큰이 응답을 넣으면 분포에 강사가 섞인다');
  assert.deepStrictEqual(store._raw.votes.default, { q1: { 'st-1': 'a' } });
});

await t('[L1] 응답은 정답 여부를 돌려주지 않는다 (강사가 공개할 때 다 같이 본다)', async () => {
  const store = memStore();
  await setProj(store, { items: PJ_ITEMS });
  const r = await call(store, { path: '/api/naesin/live/answer', method: 'POST', getBody: async () => ({ ref: 'q1', key: 'b' }) });
  assert.deepStrictEqual(r.body, { ok: true }, '틀렸다는 것을 알려 주면 바로 고쳐 내 분포가 무의미해진다');
});

await t('[L1] 투사가 없으면 응답은 409', async () => {
  const store = memStore();
  assert.strictEqual((await call(store, { path: '/api/naesin/live/answer', method: 'POST', getBody: async () => ({ ref: 'q1', key: 'a' }) })).status, 409);
});

await t('[L1] 새 문제 세트를 띄우면 앞 응답이 남지 않는다', async () => {
  const store = memStore();
  await setProj(store, { items: PJ_ITEMS });
  await call(store, { path: '/api/naesin/live/answer', method: 'POST', getBody: async () => ({ ref: 'q1', key: 'a' }) });
  await setProj(store, { items: PJ_ITEMS });
  assert.deepStrictEqual(store._raw.votes.default, {}, '지난 쪽지시험 응답이 새 시험 분포에 섞인다');
});

await t('[L1] 단계와 투사는 서로를 지우지 않는다', async () => {
  const store = memStore();
  await setPhase(store, { key: 'quiz', minutes: 5 });
  await setProj(store, { items: PJ_ITEMS });
  const r1 = await getLive(store);
  assert.strictEqual(r1.body.live.phase.key, 'quiz');
  assert.ok(r1.body.live.projector);
  await setProj(store, { items: null });
  const r2 = await getLive(store);
  assert.strictEqual(r2.body.live.phase.key, 'quiz', '투사를 끝내면 단계도 사라지면 수업이 끊긴다');
  assert.strictEqual(r2.body.live.projector, null);
  await setPhase(store, null);
  assert.strictEqual((await getLive(store)).body.live.phase, null);
});

await t('[L2] 강사 화면은 폴링 한 번으로 세션·응답 분포·반 현황을 받는다', async () => {
  const store = memStore();
  const at = new Date().toISOString();
  store.putState('st-1', { state: { summary: { live: { at, where: 'runner', label: '본문 3단계', idleSec: 400, todayDone: 3 }, sentence: { total: 25, memorized: 4 } } }, updatedAt: at });
  store.putState('st-2', { state: { summary: { live: { at, where: 'words', label: '단어', idleSec: 5, todayDone: 9 }, sentence: { total: 25, memorized: 20 } } }, updatedAt: at });
  await setProj(store, { items: PJ_ITEMS });
  await call(store, { path: '/api/naesin/live/answer', method: 'POST', getBody: async () => ({ ref: 'q1', key: 'b' }) });
  const r = await call(store, { path: '/api/naesin/admin/live', who: ADMIN });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.board.map((x) => x.code), ['st-1', 'st-2'], '정체 오래된 학생이 위로 와야 화면을 볼 이유가 생긴다');
  assert.strictEqual(r.body.board[0].label, '본문 3단계');
  assert.ok(r.body.board[0].idleSec >= 400);
  assert.deepStrictEqual(r.body.weakest, ['st-1', 'st-2']);
  assert.strictEqual(r.body.votes[0].answered, 1);
  assert.deepStrictEqual(r.body.votes[0].wrong, ['st-1']);
  assert.strictEqual(r.body.votes[0].answerKey, 'a', '강사 화면에는 정답이 있어야 한다');
  assert.strictEqual((await call(store, { path: '/api/naesin/admin/live' })).status, 403, '학생은 강사 폴링을 못 쓴다');
});

await t('[L2] summary.live 는 화이트리스트로 정규화된다 — 강사 화면에 그려지는 학생 입력', () => {
  const sum = normalizeSummary({ live: { at: 'nope', where: 'DROP', label: '<img src=x onerror=1>'.repeat(9), idleSec: -3, todayDone: 1e9 } });
  assert.strictEqual(sum.live.where, 'home');
  assert.strictEqual(sum.live.at, null);
  assert.strictEqual(sum.live.label.length, 40);
  assert.strictEqual(sum.live.idleSec, 0);
  assert.strictEqual(sum.live.todayDone, 9999);
  assert.ok(sum.live.label.indexOf('<img') === 0, '값은 지우지 않는다 — 화면이 이스케이프한다');
  assert.strictEqual(normalizeSummary({}).live, undefined, '옛 저장본에 빈 칸을 만들지 않는다');
});

await t('[L1] 세션 삭제는 응답까지 함께 지운다', async () => {
  const store = memStore();
  await setProj(store, { items: PJ_ITEMS });
  await call(store, { path: '/api/naesin/live/answer', method: 'POST', getBody: async () => ({ ref: 'q1', key: 'a' }) });
  assert.strictEqual((await call(store, { path: '/api/naesin/admin/live', method: 'DELETE', who: ADMIN })).status, 200);
  assert.strictEqual(store._raw.live.default, undefined);
  assert.strictEqual(store._raw.votes.default, undefined, '지운 수업의 응답이 남으면 다음 수업 분포에 섞인다');
});

await t('[L1] 저장소 어댑터 계약이 워커·로컬 양쪽에 있다', () => {
  const src = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
  for (const [name, txt] of [['worker.mjs', src('./worker.mjs')], ['server.mjs', src('./server.mjs')]]) {
    for (const fn of ['getLive', 'putLive', 'deleteLive', 'getVotes', 'putVotes'])
      assert.ok(txt.includes(fn + ':'), name + ' 의 내신 저장소 어댑터에 ' + fn + ' 이 없다 — 한쪽만 고치면 운영에서만 다르게 돈다');
  }
});

await t('모르는 경로는 404', async () => {
  const store = memStore();
  assert.strictEqual((await call(store, { path: '/api/naesin/zzz', who: ADMIN })).status, 404);
  assert.strictEqual((await call(store, { path: '/api/naesin/pack', method: 'POST' })).status, 403, '학생에게 모르는 경로는 관리자 벽(403)에서 끝난다');
});

console.log('\n통과 ' + passed + '개 — naesin-api 서버 라우트 검증 완료');
