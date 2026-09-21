'use strict';
/* 청크브레인 서버 라우트 검증 (node reading-server/chunk-api.test.mjs) */
import assert from 'node:assert';
import { handleChunk, normalizeChunkSummary, normalizeAssign, normalizePassage, chunkOverviewRow, dropStudentChunk } from './chunk-api.mjs';

let passed = 0;
const t = async (name, fn) => { await fn(); passed += 1; console.log('  ✓ ' + name); };

function memStore() {
  const states = {}, summaries = {}, assigns = {}; let customs = null;
  const students = { 'st-1': { code: 'st-1', name: '김지우', cls: '초4 A반' }, 'st-2': { code: 'st-2', name: '박서준', cls: '초4 A반' } };
  return {
    getState: (c) => states[c] || null, putState: (c, rec) => { states[c] = rec; }, deleteState: (c) => { delete states[c]; },
    getSummary: (c) => summaries[c] || null, putSummary: (c, rec) => { summaries[c] = rec; }, deleteSummary: (c) => { delete summaries[c]; },
    listSummaryCodes: () => Object.keys(summaries), getStudent: (c) => students[c] || null,
    getAssign: (c) => assigns[c] || null, putAssign: (c, rec) => { assigns[c] = rec; }, deleteAssign: (c) => { delete assigns[c]; },
    listAssignCodes: () => Object.keys(assigns),
    getCustoms: () => customs, putCustoms: (rec) => { customs = rec; },
    _raw: { states, summaries, assigns },
  };
}
const STU = { code: 'st-1', admin: false };
const ADMIN = { code: '__admin__', admin: true };
const call = (store, over) => handleChunk({ path: '/api/chunk/state', method: 'GET', who: STU, getBody: async () => ({}), store, ...over });

await t('인증 없으면 401', async () => {
  const s = memStore();
  for (const p of ['/api/chunk/state', '/api/chunk/admin/overview']) assert.strictEqual((await call(s, { path: p, who: null })).status, 401, p);
});

await t('학생 토큰으로 관리 라우트는 403, 모르는 경로는 404', async () => {
  const s = memStore();
  assert.strictEqual((await call(s, { path: '/api/chunk/admin/overview' })).status, 403);
  assert.strictEqual((await call(s, { path: '/api/chunk/nope' })).status, 404);
  assert.strictEqual((await call(s, { path: '/api/chunk/admin/nope', who: ADMIN })).status, 404);
});

await t('GET /state — 처음이면 {state:null, updatedAt:null} 래핑 계약', async () => {
  const r = await call(memStore(), {});
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, { state: null, updatedAt: null });
});

await t('PUT /state — 저장 뒤 GET 에서 같은 기록, 요약은 화이트리스트로 따로', async () => {
  const s = memStore();
  const state = { v: 1, band: 'G3', items: { 'e2-01': { n: 1 } }, log: [{ t: 1, id: 'e2-01', score: 90 }], updatedAt: 1000 };
  const summary = { band: 'G3', attempts: 3, avg: 88.4, recentAvg: 91, qRate: 67, wpmRecent: 130.6, streak: 2, lessonsDone: 1, lastAt: 1700000000000, evil: '<script>' };
  const put = await call(s, { method: 'PUT', getBody: async () => ({ state, summary }) });
  assert.strictEqual(put.status, 200); assert.ok(put.body.ok && put.body.updatedAt);
  const get = await call(s, {});
  assert.deepStrictEqual(get.body.state, state); assert.strictEqual(get.body.updatedAt, put.body.updatedAt);
  const sum = s._raw.summaries['st-1'].summary;
  assert.strictEqual(sum.evil, undefined, '모르는 키는 버린다');
  assert.strictEqual(sum.avg, 88); assert.strictEqual(sum.wpmRecent, 131); assert.strictEqual(sum.band, 'G3'); assert.strictEqual(sum.lastAt, 1700000000000);
});

await t('PUT /state — 몸통이 없거나 state 가 객체가 아니면 400, 너무 크면 413', async () => {
  const s = memStore();
  assert.strictEqual((await call(s, { method: 'PUT', getBody: async () => { throw new Error('bad json'); } })).status, 400);
  assert.strictEqual((await call(s, { method: 'PUT', getBody: async () => ({ state: 'x' }) })).status, 400);
  assert.strictEqual((await call(s, { method: 'PUT', getBody: async () => ({ state: [] }) })).status, 400);
  const big = { pad: 'x'.repeat(270_000) };
  assert.strictEqual((await call(s, { method: 'PUT', getBody: async () => ({ state: big }) })).status, 413);
  assert.strictEqual(s._raw.states['st-1'], undefined, '413 이면 아무것도 저장하지 않는다');
});

await t('요약 정규화 — 모양만 강제, 범위 밖은 자른다', async () => {
  assert.strictEqual(normalizeChunkSummary(null), null);
  assert.strictEqual(normalizeChunkSummary([]), null);
  const n = normalizeChunkSummary({ band: 'ZZ', attempts: -5, avg: 140, qRate: 'abc', streak: 2.4, lastAt: 'x', weak: [{ tag: 'extra:adn', n: 3 }, { tag: '<b>', n: 1 }, 'x'], assignDone: 2 });
  assert.deepStrictEqual(n, { band: null, attempts: 0, practiced: 0, graduated: 0, avg: 100, recentAvg: null, qRate: null, wpmRecent: null, streak: 2, lessonsDone: 0, assignDone: 2, weak: [{ tag: 'extra:adn', n: 3 }], lastAt: null });
});

await t('관리 overview — 명단에 있는 학생만, 최근 활동 순', async () => {
  const s = memStore();
  await call(s, { method: 'PUT', getBody: async () => ({ state: { v: 1 }, summary: { band: 'G3', attempts: 2, lastAt: 100 } }) });
  await call(s, { who: { code: 'st-2', admin: false }, method: 'PUT', getBody: async () => ({ state: { v: 1 }, summary: { band: 'G5', attempts: 5, lastAt: 200 } }) });
  await call(s, { who: { code: 'gone', admin: false }, method: 'PUT', getBody: async () => ({ state: { v: 1 }, summary: { band: 'G5', attempts: 9, lastAt: 999 } }) });
  const r = await call(s, { path: '/api/chunk/admin/overview', who: ADMIN });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.rows.map((x) => x.code), ['st-2', 'st-1'], '명단에 없는 gone 은 빠지고 최근 순');
  assert.strictEqual(r.body.rows[0].assign, null); assert.deepStrictEqual(r.body.rows[0].weak, []);
  assert.strictEqual(r.body.rows[0].name, '박서준'); assert.strictEqual(r.body.rows[0].band, 'G5');
  const one = await call(s, { path: '/api/chunk/admin/student/st-1', who: ADMIN });
  assert.strictEqual(one.status, 200); assert.deepStrictEqual(one.body.state, { v: 1 });
  assert.strictEqual((await call(s, { path: '/api/chunk/admin/student/none', who: ADMIN })).status, 404);
  assert.strictEqual(chunkOverviewRow('x', null, null, null).attempts, 0);
});

await t('과제 정규화 — 단계·글·카드·메모·마감, 셋 다 비면 null', async () => {
  assert.deepStrictEqual(normalizeAssign({}), { assign: null });
  assert.deepStrictEqual(normalizeAssign({ band: 'G4', passages: ['g4-01', 'g4-01', 'g4-02'], lessons: ['g4-1'], note: ' 주말까지 ', due: '2026-10-01' }),
    { assign: { band: 'G4', passages: ['g4-01', 'g4-02'], lessons: ['g4-1'], note: '주말까지', due: '2026-10-01' } });
  assert.ok(normalizeAssign({ band: 'X' }).error); assert.ok(normalizeAssign({ passages: 'g4-01' }).error);
  assert.ok(normalizeAssign({ passages: ['<script>'] }).error); assert.ok(normalizeAssign({ due: '10/1' }).error);
  assert.ok(normalizeAssign({ passages: Array.from({ length: 21 }, (_, i) => 'g4-' + i) }).error, '20개 상한');
  assert.strictEqual(normalizeAssign({ note: 'x'.repeat(300) }).assign.note.length, 200);
});

await t('과제 — 관리자가 넣고, 학생이 /assign 으로 받고, 비우면 지워진다', async () => {
  const s = memStore();
  assert.deepStrictEqual((await call(s, { path: '/api/chunk/assign' })).body, { assign: null, updatedAt: null });
  const put = await call(s, { path: '/api/chunk/admin/assign/st-1', method: 'PUT', who: ADMIN, getBody: async () => ({ band: 'G4', passages: ['g4-01'], lessons: [], note: '', due: null }) });
  assert.strictEqual(put.status, 200); assert.strictEqual(put.body.assign.band, 'G4'); assert.ok(put.body.updatedAt);
  const got = await call(s, { path: '/api/chunk/assign' });
  assert.deepStrictEqual(got.body.assign, { band: 'G4', passages: ['g4-01'], lessons: [], note: '', due: null }); assert.strictEqual(got.body.updatedAt, put.body.updatedAt);
  const adm = await call(s, { path: '/api/chunk/admin/assign/st-1', who: ADMIN });
  assert.strictEqual(adm.body.assign.band, 'G4');
  assert.strictEqual((await call(s, { path: '/api/chunk/admin/assign/nobody', method: 'PUT', who: ADMIN, getBody: async () => ({ band: 'G4' }) })).status, 404, '명단에 없는 학생');
  assert.strictEqual((await call(s, { path: '/api/chunk/admin/assign/st-1', method: 'PUT', who: ADMIN, getBody: async () => ({ band: 'ZZ' }) })).status, 400);
  assert.strictEqual((await call(s, { path: '/api/chunk/admin/assign/st-1', method: 'PUT' })).status, 403, '학생은 과제를 못 정한다');
  /* 과제만 있고 기록이 없는 학생도 overview 에 오른다 */
  const ov = await call(s, { path: '/api/chunk/admin/overview', who: ADMIN });
  assert.strictEqual(ov.body.rows.length, 1); assert.deepStrictEqual(ov.body.rows[0].assign, { band: 'G4', passages: 1, lessons: 0, due: null, note: '', updatedAt: put.body.updatedAt });
  const clr = await call(s, { path: '/api/chunk/admin/assign/st-1', method: 'PUT', who: ADMIN, getBody: async () => ({}) });
  assert.deepStrictEqual(clr.body, { ok: true, assign: null, updatedAt: null });
  assert.strictEqual(s._raw.assigns['st-1'], undefined);
});

await t('퇴원 — 기록·요약·과제 키를 지운다', async () => {
  const s = memStore();
  await call(s, { method: 'PUT', getBody: async () => ({ state: { v: 1 }, summary: { attempts: 1 } }) });
  await call(s, { path: '/api/chunk/admin/assign/st-1', method: 'PUT', who: ADMIN, getBody: async () => ({ band: 'G4' }) });
  await dropStudentChunk(s, 'st-1');
  assert.strictEqual(s._raw.states['st-1'], undefined); assert.strictEqual(s._raw.summaries['st-1'], undefined); assert.strictEqual(s._raw.assigns['st-1'], undefined);
});

await t('선생님 지문 정규화 — 조각 규칙·문제 형식만 강제, 뜻은 보지 않는다', async () => {
  const ok = normalizePassage({ band: 'G3', title: ' 텃밭 ', paragraphs: [['우리 반은 ', '상추를 심었다.']], q: { q: '무엇을 심었나?', choices: ['상추', '배추', '', '무'], answer: 0, explain: '첫 문장' } }, 'c-1');
  assert.deepStrictEqual(Object.keys(ok.passage), ['id', 'band', 'title', 'genre', 'paragraphs', 'q', 'source']);
  assert.strictEqual(ok.passage.title, '텃밭'); assert.strictEqual(ok.passage.genre, '선생님 글'); assert.deepStrictEqual(ok.passage.q.choices, ['상추', '배추', '무']);
  assert.strictEqual(ok.passage.source.kind, 'teacher');
  assert.ok(normalizePassage({ band: 'E2', title: 'x', paragraphs: [['a']] }, 'c').error, '옛 단계 id');
  assert.ok(normalizePassage({ band: 'G3', title: '', paragraphs: [['a']] }, 'c').error, '제목 없음');
  assert.ok(/공백/.test(normalizePassage({ band: 'G3', title: 'x', paragraphs: [['우리 반은', '상추를 심었다.']] }, 'c').error), '조각 끝 공백');
  assert.ok(normalizePassage({ band: 'G3', title: 'x', paragraphs: [['a ', ' ']] }, 'c').error, '빈 조각');
  assert.ok(normalizePassage({ band: 'G3', title: 'x', paragraphs: [['a']], q: { q: '?', choices: ['1'], answer: 0 } }, 'c').error, '보기 하나');
  assert.strictEqual(normalizePassage({ band: 'G3', title: 'x', paragraphs: [['a']], q: '' }, 'c').passage.q, null, '문제 없음은 null');
  assert.ok(normalizePassage({ band: 'G3', title: 'x', paragraphs: [['가'.repeat(4001)]] }, 'c').error, '길이 상한');
});

await t('선생님 지문 — 관리자가 만들고 고치고 지우며, 학생은 /custom 으로 목록을 받는다', async () => {
  const s = memStore();
  const body = { band: 'G4', title: '소금쟁이', genre: '설명', paragraphs: [['소금쟁이는 ', '물 위를 걷는다.']], q: null, source: { kind: 'reading', ref: 'water-strider|L2' } };
  let r = await call(s, { path: '/api/chunk/admin/custom', method: 'POST', who: ADMIN, getBody: async () => body });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body)); const id = r.body.passage.id;
  assert.ok(/^c-[a-z0-9]+$/.test(id) && id.length <= 24, id);
  assert.deepStrictEqual(r.body.passage.source, { kind: 'reading', ref: 'water-strider|L2' });
  r = await call(s, { path: '/api/chunk/custom', method: 'GET', who: STU });
  assert.deepStrictEqual(Object.keys(r.body), ['custom', 'updatedAt']); assert.strictEqual(r.body.custom.length, 1); assert.strictEqual(r.body.custom[0].id, id);
  r = await call(s, { path: '/api/chunk/admin/custom/' + id, method: 'PUT', who: ADMIN, getBody: async () => ({ ...body, title: '소금쟁이 2' }) });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.passage.id, id); assert.strictEqual(r.body.passage.title, '소금쟁이 2');
  r = await call(s, { path: '/api/chunk/admin/custom', method: 'GET', who: ADMIN });
  assert.strictEqual(r.body.custom[0].title, '소금쟁이 2');
  assert.strictEqual((await call(s, { path: '/api/chunk/admin/custom/c-nope', method: 'PUT', who: ADMIN, getBody: async () => body })).status, 404);
  assert.strictEqual((await call(s, { path: '/api/chunk/admin/custom', method: 'POST', who: ADMIN, getBody: async () => ({ band: 'G4', title: '', paragraphs: [] }) })).status, 400);
  assert.strictEqual((await call(s, { path: '/api/chunk/admin/custom', method: 'POST', who: STU, getBody: async () => body })).status, 403);
  r = await call(s, { path: '/api/chunk/admin/custom/' + id, method: 'DELETE', who: ADMIN });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await call(s, { path: '/api/chunk/custom', method: 'GET', who: STU })).body.custom.length, 0);
  assert.strictEqual((await call(s, { path: '/api/chunk/admin/custom/' + id, method: 'DELETE', who: ADMIN })).status, 404);
});

console.log('\n' + passed + '건 통과 — reading-server/chunk-api.mjs');
