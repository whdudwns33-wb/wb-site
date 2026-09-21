'use strict';
/* 청크브레인 서버 라우트 검증 (node reading-server/chunk-api.test.mjs) */
import assert from 'node:assert';
import { handleChunk, normalizeChunkSummary, chunkOverviewRow, dropStudentChunk } from './chunk-api.mjs';

let passed = 0;
const t = async (name, fn) => { await fn(); passed += 1; console.log('  ✓ ' + name); };

function memStore() {
  const states = {}, summaries = {};
  const students = { 'st-1': { code: 'st-1', name: '김지우', cls: '초4 A반' }, 'st-2': { code: 'st-2', name: '박서준', cls: '초4 A반' } };
  return {
    getState: (c) => states[c] || null, putState: (c, rec) => { states[c] = rec; }, deleteState: (c) => { delete states[c]; },
    getSummary: (c) => summaries[c] || null, putSummary: (c, rec) => { summaries[c] = rec; }, deleteSummary: (c) => { delete summaries[c]; },
    listSummaryCodes: () => Object.keys(summaries), getStudent: (c) => students[c] || null,
    _raw: { states, summaries },
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
  const state = { v: 1, band: 'E2', items: { 'e2-01': { n: 1 } }, log: [{ t: 1, id: 'e2-01', score: 90 }], updatedAt: 1000 };
  const summary = { band: 'E2', attempts: 3, avg: 88.4, recentAvg: 91, qRate: 67, wpmRecent: 130.6, streak: 2, lessonsDone: 1, lastAt: 1700000000000, evil: '<script>' };
  const put = await call(s, { method: 'PUT', getBody: async () => ({ state, summary }) });
  assert.strictEqual(put.status, 200); assert.ok(put.body.ok && put.body.updatedAt);
  const get = await call(s, {});
  assert.deepStrictEqual(get.body.state, state); assert.strictEqual(get.body.updatedAt, put.body.updatedAt);
  const sum = s._raw.summaries['st-1'].summary;
  assert.strictEqual(sum.evil, undefined, '모르는 키는 버린다');
  assert.strictEqual(sum.avg, 88); assert.strictEqual(sum.wpmRecent, 131); assert.strictEqual(sum.band, 'E2'); assert.strictEqual(sum.lastAt, 1700000000000);
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
  const n = normalizeChunkSummary({ band: 'ZZ', attempts: -5, avg: 140, qRate: 'abc', streak: 2.4, lastAt: 'x' });
  assert.deepStrictEqual(n, { band: null, attempts: 0, practiced: 0, graduated: 0, avg: 100, recentAvg: null, qRate: null, wpmRecent: null, streak: 2, lessonsDone: 0, lastAt: null });
});

await t('관리 overview — 명단에 있는 학생만, 최근 활동 순', async () => {
  const s = memStore();
  await call(s, { method: 'PUT', getBody: async () => ({ state: { v: 1 }, summary: { band: 'E2', attempts: 2, lastAt: 100 } }) });
  await call(s, { who: { code: 'st-2', admin: false }, method: 'PUT', getBody: async () => ({ state: { v: 1 }, summary: { band: 'E3', attempts: 5, lastAt: 200 } }) });
  await call(s, { who: { code: 'gone', admin: false }, method: 'PUT', getBody: async () => ({ state: { v: 1 }, summary: { band: 'E3', attempts: 9, lastAt: 999 } }) });
  const r = await call(s, { path: '/api/chunk/admin/overview', who: ADMIN });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.rows.map((x) => x.code), ['st-2', 'st-1'], '명단에 없는 gone 은 빠지고 최근 순');
  assert.strictEqual(r.body.rows[0].name, '박서준'); assert.strictEqual(r.body.rows[0].band, 'E3');
  const one = await call(s, { path: '/api/chunk/admin/student/st-1', who: ADMIN });
  assert.strictEqual(one.status, 200); assert.deepStrictEqual(one.body.state, { v: 1 });
  assert.strictEqual((await call(s, { path: '/api/chunk/admin/student/none', who: ADMIN })).status, 404);
  assert.strictEqual(chunkOverviewRow('x', null, null).attempts, 0);
});

await t('퇴원 — 기록·요약 키를 지운다', async () => {
  const s = memStore();
  await call(s, { method: 'PUT', getBody: async () => ({ state: { v: 1 }, summary: { attempts: 1 } }) });
  await dropStudentChunk(s, 'st-1');
  assert.strictEqual(s._raw.states['st-1'], undefined); assert.strictEqual(s._raw.summaries['st-1'], undefined);
});

console.log('\n' + passed + '건 통과 — reading-server/chunk-api.mjs');
