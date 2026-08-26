'use strict';
/* 워드브레인 서버 라우트 검증 (node reading-server/vocab-api.test.mjs) */
import assert from 'node:assert';
import { handleVocab, parseCandidates, vocabSummary, dumpVocab } from './vocab-api.mjs';

let passed = 0;
const t = async (name, fn) => { await fn(); passed += 1; console.log('  ✓ ' + name); };

/* 메모리 어댑터 (worker KV·로컬 파일 어댑터와 동일 계약) */
function memStore() {
  const states = {}, mnemos = {}, students = { s1: { code: 's1', name: '김지우', cls: '월수반' } };
  return {
    getState: (c) => states[c] || null,
    putState: (c, rec) => { states[c] = rec; },
    listStateCodes: () => Object.keys(states),
    getStudent: (c) => students[c] || null,
    getMnemo: (k) => mnemos[k] || null,
    putMnemo: (k, rec) => { mnemos[k] = rec; },
    listMnemos: () => Object.values(mnemos),
    _raw: { states, mnemos },
  };
}
const call = (store, over) => handleVocab({
  path: '/api/vocab/pull', method: 'GET', who: { code: 's1', admin: false },
  getBody: async () => ({}), store, ai: { apiKey: null, model: null },
  ...over,
});

await t('인증 없으면 401, 학생이 관리자 라우트 호출 시 403', async () => {
  const store = memStore();
  assert.strictEqual((await call(store, { who: null })).status, 401);
  const r = await call(store, { path: '/api/vocab/admin/review', who: { code: 's1', admin: false } });
  assert.strictEqual(r.status, 403);
});

await t('상태 저장/복원 왕복 + 학생 간 격리', async () => {
  const store = memStore();
  const st = { states: { 'h-1': { step: 2 } }, log: [1, 2] };
  const put = await call(store, { path: '/api/vocab/state', method: 'PUT', getBody: async () => ({ state: st }) });
  assert.strictEqual(put.status, 200);
  const pull = await call(store, {});
  assert.deepStrictEqual(pull.body.state, st);
  const other = await call(store, { who: { code: 's2', admin: false } });
  assert.strictEqual(other.body.state, null, '다른 학생 기록이 보이면 안 된다');
});

await t('상태 크기 제한 413', async () => {
  const store = memStore();
  const big = { blob: 'x'.repeat(500_000) };
  const r = await call(store, { path: '/api/vocab/state', method: 'PUT', getBody: async () => ({ state: big }) });
  assert.strictEqual(r.status, 413);
});

await t('AI 연상 — 키 없으면 ok:false(no-key), 실발송 안 함', async () => {
  const store = memStore();
  const r = await call(store, {
    path: '/api/vocab/mnemonic', method: 'POST',
    getBody: async () => ({ word: 'orbit', meaning: '궤도', type: 'english' }),
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, false);
  assert.strictEqual(r.body.reason, 'no-key');
});

await t('AI 연상 — 생성→pending 저장→재요청은 캐시(재생성 안 함)', async () => {
  const store = memStore();
  let calls = 0;
  const fake = async () => { calls += 1; return { ok: true, candidates: [{ cue: '오! 빛!', scene: '위성이 빛나는 길을 따라 돈다.' }], model: 'test' }; };
  const mk = () => call(store, {
    path: '/api/vocab/mnemonic', method: 'POST',
    getBody: async () => ({ word: 'orbit', meaning: '궤도', type: 'english' }),
    ai: { apiKey: 'k', model: null, generate: fake },
  });
  const r1 = await mk();
  assert.strictEqual(r1.body.ok, true);
  assert.strictEqual(r1.body.status, 'pending');
  const r2 = await mk();
  assert.strictEqual(r2.body.status, 'pending');
  assert.strictEqual(calls, 1, '두 번째 요청은 캐시에서');
});

await t('검수 — 승인하면 이후 학생은 승인본 1개만, 반려하면 재생성', async () => {
  const store = memStore();
  let calls = 0;
  const fake = async () => { calls += 1; return { ok: true, candidates: [{ cue: 'c' + calls, scene: 'scene-' + calls + ' 장면' }] }; };
  const mk = () => call(store, {
    path: '/api/vocab/mnemonic', method: 'POST',
    getBody: async () => ({ word: '드넓다', meaning: '활짝 트여 아주 넓다', type: 'native' }),
    ai: { apiKey: 'k', generate: fake },
  });
  await mk();
  const admin = { code: '__admin__', admin: true };
  const ap = await call(store, {
    path: '/api/vocab/admin/review', method: 'POST', who: admin,
    getBody: async () => ({ key: '드넓다', action: 'approve', cue: '검수된 고리', scene: '검수된 장면입니다.' }),
  });
  assert.strictEqual(ap.status, 200);
  const r2 = await mk();
  assert.strictEqual(r2.body.status, 'approved');
  assert.deepStrictEqual(r2.body.candidates, [{ cue: '검수된 고리', scene: '검수된 장면입니다.' }]);
  assert.strictEqual(calls, 1);
  await call(store, {
    path: '/api/vocab/admin/review', method: 'POST', who: admin,
    getBody: async () => ({ key: '드넓다', action: 'reject' }),
  });
  const r3 = await mk();
  assert.strictEqual(r3.body.status, 'pending');
  assert.strictEqual(calls, 2, '반려 후에는 재생성');
});

await t('검수 목록 — pending 우선 정렬', async () => {
  const store = memStore();
  store.putMnemo('a', { key: 'a', word: 'a', status: 'approved', at: '2026-08-26T10:00:00Z' });
  store.putMnemo('b', { key: 'b', word: 'b', status: 'pending', at: '2026-08-25T10:00:00Z' });
  const r = await call(store, { path: '/api/vocab/admin/review', who: { code: '__admin__', admin: true } });
  assert.strictEqual(r.body.items[0].key, 'b');
});

await t('관리자 현황 — 학생 이름 + 워드브레인 요약', async () => {
  const store = memStore();
  const now = Date.now();
  store.putState('s1', {
    updatedAt: '2026-08-26T10:00:00Z',
    state: {
      streak: { count: 4 },
      states: {
        a: { step: 1, due: now + 86400000, emaMs: 1500 },
        b: { step: 1, due: now - 5 * 86400000 },            // 1일 간격 5일 연체 → 응급
        c: { graduated: true, due: now + 9e9 },
      },
    },
  });
  const r = await call(store, { path: '/api/vocab/admin/overview', who: { code: '__admin__', admin: true } });
  const s = r.body.students[0];
  assert.strictEqual(s.name, '김지우');
  assert.strictEqual(s.total, 3);
  assert.strictEqual(s.graduated, 1);
  assert.strictEqual(s.due, 1);
  assert.strictEqual(s.emergency, 1);
  assert.strictEqual(s.streak, 4);
  assert.strictEqual(s.msAvg, 1500);
});

await t('parseCandidates — 펜스·잡음 견디고, 불량은 null', () => {
  const ok = parseCandidates('설명입니다\n```json\n{"candidates":[{"cue":"고리","scene":"장면이 그려진다."},{"cue":"둘째 고리","scene":"두 번째 장면."}]}\n```');
  assert.strictEqual(ok.length, 2);
  assert.strictEqual(parseCandidates('그냥 텍스트'), null);
  assert.strictEqual(parseCandidates('{"candidates":[]}'), null);
  assert.strictEqual(parseCandidates(null), null);
});

await t('dumpVocab — 백업 덤프에 상태·검수함 포함', async () => {
  const store = memStore();
  store.putState('s1', { state: { states: {} }, updatedAt: 'x' });
  store.putMnemo('w', { key: 'w', word: 'w', status: 'pending', at: 'y' });
  const d = await dumpVocab(store);
  assert.ok(d.states.s1 && d.mnemos.w);
});

await t('vocabSummary — 기록 없으면 linked:false 기본값', () => {
  const s = vocabSummary(null);
  assert.strictEqual(s.linked, false);
  assert.strictEqual(s.total, 0);
});

console.log('\n통과 ' + passed + '개 — vocab-api 서버 라우트 검증 완료');
