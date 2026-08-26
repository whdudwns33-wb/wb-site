'use strict';
/* 워드브레인 서버 라우트 검증 (node reading-server/vocab-api.test.mjs) */
import assert from 'node:assert';
import { handleVocab, parseCandidates, vocabSummary, dumpVocab, vapidJwt, sendNightPushes } from './vocab-api.mjs';

let passed = 0;
const t = async (name, fn) => { await fn(); passed += 1; console.log('  ✓ ' + name); };

/* 메모리 어댑터 (worker KV·로컬 파일 어댑터와 동일 계약) */
function memStore() {
  const states = {}, mnemos = {}, push = {}, students = { s1: { code: 's1', name: '김지우', cls: '월수반' } };
  return {
    getState: (c) => states[c] || null,
    putState: (c, rec) => { states[c] = rec; },
    listStateCodes: () => Object.keys(states),
    getStudent: (c) => students[c] || null,
    getMnemo: (k) => mnemos[k] || null,
    putMnemo: (k, rec) => { mnemos[k] = rec; },
    listMnemos: () => Object.values(mnemos),
    getPush: (c) => push[c] || null,
    putPush: (c, rec) => { push[c] = rec; },
    delPush: (c) => { delete push[c]; },
    listPushCodes: () => Object.keys(push),
    _raw: { states, mnemos, push },
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

await t('검수 확인(check) — AI 재호출 없이 상태만, 승인본 포함', async () => {
  const store = memStore();
  store.putMnemo('orbit', { key: 'orbit', word: 'orbit', status: 'approved', approved: { cue: '오! 빛', scene: '빛나는 길.' } });
  store.putMnemo('드넓다', { key: '드넓다', word: '드넓다', status: 'pending', candidates: [] });
  const r = await call(store, {
    path: '/api/vocab/mnemonic/check', method: 'POST',
    getBody: async () => ({ words: ['orbit', '드넓다', '없는단어'] }),
  });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.items.map((i) => i.status), ['approved', 'pending', 'none']);
  assert.deepStrictEqual(r.body.items[0].approved, { cue: '오! 빛', scene: '빛나는 길.' });
});

await t('푸시 — 키 없으면 ok:false, 구독 저장/해지, 불량 endpoint 400', async () => {
  const store = memStore();
  const noKey = await call(store, { path: '/api/vocab/push/key' });
  assert.strictEqual(noKey.body.ok, false);
  const withKey = await call(store, { path: '/api/vocab/push/key', push: { publicKey: 'PUB', privateJwk: '{}' } });
  assert.deepStrictEqual(withKey.body, { ok: true, key: 'PUB' });
  const bad = await call(store, {
    path: '/api/vocab/push/subscribe', method: 'POST',
    getBody: async () => ({ subscription: { endpoint: 'http://insecure' } }),
  });
  assert.strictEqual(bad.status, 400);
  const okSub = await call(store, {
    path: '/api/vocab/push/subscribe', method: 'POST',
    getBody: async () => ({ subscription: { endpoint: 'https://push.example/ep1' } }),
  });
  assert.strictEqual(okSub.body.ok, true);
  assert.strictEqual(store.getPush('s1').endpoint, 'https://push.example/ep1');
  await call(store, { path: '/api/vocab/push/unsubscribe', method: 'POST' });
  assert.strictEqual(store.getPush('s1'), null);
});

await t('VAPID JWT — ES256 서명이 공개키로 검증되고 aud/sub/exp 포함', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey));
  const jwt = await vapidJwt({ audience: 'https://push.example', subject: 'mailto:t@wb.local', privateJwk: jwk });
  const [h, p, s] = jwt.split('.');
  const dec = (x) => JSON.parse(Buffer.from(x.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  assert.strictEqual(dec(h).alg, 'ES256');
  const claims = dec(p);
  assert.strictEqual(claims.aud, 'https://push.example');
  assert.strictEqual(claims.sub, 'mailto:t@wb.local');
  assert.ok(claims.exp > Date.now() / 1000);
  const sig = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, sig, new TextEncoder().encode(h + '.' + p)
  );
  assert.ok(valid, '서명 검증');
});

await t('야간 발송 — 물 줄 단어 있는 구독자만, 410은 구독 정리, 키 없으면 no-vapid', async () => {
  const store = memStore();
  const now = Date.now();
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const push = { publicKey: 'PUB', privateJwk: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey)), subject: 'mailto:t@wb.local' };
  store.putPush('due1', { endpoint: 'https://push.example/a' });
  store.putState('due1', { state: { states: { w: { step: 1, due: now - 1000 } } } });
  store.putPush('clean', { endpoint: 'https://push.example/b' });
  store.putState('clean', { state: { states: { w: { step: 1, due: now + 9e9 } } } });
  store.putPush('gone', { endpoint: 'https://push.example/gone' });
  store.putState('gone', { state: { states: { w: { step: 1, due: now - 1000 } } } });
  const calls = [];
  const fakeFetch = async (url, opt) => {
    calls.push({ url, auth: opt.headers.Authorization });
    return { status: url.endsWith('/gone') ? 410 : 201 };
  };
  const r = await sendNightPushes({ store, push, fetchFn: fakeFetch });
  assert.deepStrictEqual({ sent: r.sent, skipped: r.skipped, removed: r.removed }, { sent: 1, skipped: 1, removed: 1 });
  assert.strictEqual(calls.length, 2, '만기 없는 학생에겐 발송 안 함');
  assert.ok(calls[0].auth.startsWith('vapid t='), 'VAPID 헤더');
  assert.strictEqual(store.getPush('gone'), null, '410 → 구독 정리');
  const noVapid = await sendNightPushes({ store, push: { publicKey: '', privateJwk: '' } });
  assert.strictEqual(noVapid.reason, 'no-vapid');
});

console.log('\n통과 ' + passed + '개 — vocab-api 서버 라우트 검증 완료');
