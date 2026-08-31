'use strict';
/* 워드브레인 서버 라우트 검증 (node reading-server/vocab-api.test.mjs) */
import assert from 'node:assert';
import { handleVocab, parseCandidates, parseVerdict, parseWordList, parseHanjaSpec, vocabSummary, dumpVocab, vapidJwt, sendNightPushes } from './vocab-api.mjs';

let passed = 0;
const t = async (name, fn) => { await fn(); passed += 1; console.log('  ✓ ' + name); };

/* 메모리 어댑터 (worker KV·로컬 파일 어댑터와 동일 계약) */
function memStore() {
  const states = {}, mnemos = {}, push = {}, assigns = {};
  const students = { s1: { code: 's1', name: '김지우', cls: '월수반' }, s2: { code: 's2', name: '박서준', cls: '월수반' } };
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
    getAssign: (c) => assigns[c] || null,
    putAssign: (c, rec) => { assigns[c] = rec; },
    listAssignCodes: () => Object.keys(assigns),
    _raw: { states, mnemos, push, assigns },
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

await t('문장 짓기 — 판정 왕복, 빈 문장·과길이·키없음 처리', async () => {
  const store = memStore();
  const judge = async ({ sentence }) => ({ ok: true, verdict: sentence.includes('별') ? 'good' : 'ok', feedback: '잘 썼어요.', better: '천문대에서 별을 관측했다.' });
  const call2 = (body, ai) => call(store, {
    path: '/api/vocab/sentence', method: 'POST', getBody: async () => body,
    ai: Object.assign({ apiKey: 'k', judge }, ai || {}),
  });
  const r = await call2({ word: '관측', meaning: '살펴 재기', type: 'hanja', sentence: '밤하늘의 별을 관측했다.' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.verdict, 'good');
  assert.ok(r.body.better.length > 0);
  assert.strictEqual((await call2({ word: '관측', meaning: 'm', type: 'hanja', sentence: '' })).status, 400, '빈 문장 400');
  assert.strictEqual((await call2({ word: '관측', meaning: 'm', type: 'hanja', sentence: 'x'.repeat(400) })).status, 400, '과길이 400');
  assert.strictEqual((await call2({ word: '관측', meaning: 'm', type: 'zzz', sentence: '가' })).status, 400, '잘못된 어종 400');
  const noKey = await call(store, {
    path: '/api/vocab/sentence', method: 'POST',
    getBody: async () => ({ word: '관측', meaning: 'm', type: 'hanja', sentence: '별을 관측했다.' }),
    ai: { apiKey: null },
  });
  assert.strictEqual(noKey.body.ok, false);
  assert.strictEqual(noKey.body.reason, 'no-key');
});

await t('parseVerdict — 펜스·잡음 견디고 불량은 null', () => {
  const v = parseVerdict('설명\n```json\n{"verdict":"ok","feedback":"좋아요","better":"예문"}\n```');
  assert.deepStrictEqual(v, { verdict: 'ok', feedback: '좋아요', better: '예문' });
  assert.strictEqual(parseVerdict('{"verdict":"nope","feedback":"x"}'), null, '허용 안 된 verdict');
  assert.strictEqual(parseVerdict('{"verdict":"good"}'), null, 'feedback 없음');
  assert.strictEqual(parseVerdict('그냥 텍스트'), null);
});

await t('막대로 나눈 줄에서는 쉼표가 뜻의 일부다', () => {
  /* 교재 낱말 상당수가 뜻 안에 쉼표를 지닌다 — 「종이, 옷, 비닐봉지처럼 얇은 것을…」.
     쉼표까지 칸 구분으로 보면 뜻이 「종이」로 잘리고 나머지가 예문 칸으로 밀려
     학생은 「찢다 = 종이」를 외우게 된다. 검수 화면의 「배정칸에 넣기」가 막대를 쓴다. */
  const { words } = parseWordList('찢다 | 종이, 옷, 비닐봉지처럼 얇은 것 | 종이를 찢다');
  assert.strictEqual(words.length, 1);
  assert.strictEqual(words[0].meaning, '종이, 옷, 비닐봉지처럼 얇은 것');
  assert.strictEqual(words[0].example, '종이를 찢다');
  /* 막대가 없으면 쉼표가 칸을 나눈다 — 빠르게 붙여 넣는 형식은 그대로 살린다 */
  assert.strictEqual(parseWordList('사과, 빨갛고 둥근 과일').words[0].meaning, '빨갛고 둥근 과일');
});

await t('단어 목록 파싱 — 구분자·어종 자동 판별·한자 분해·중복·오류행', () => {
  const { words, errors } = parseWordList([
    '# 주석은 무시',
    '관측 | 보고 재는 것 | 觀(볼 관)+測(잴 측) | 별을 관측했다.',
    'observe, 관찰하다',
    '드넓다\t활짝 트여 아주 넓다',
    '분석 | 잘게 나눠 살핌 | 分析',
    '관측 | 중복이라 무시됨',
    '뜻없는말',
    '',
  ].join('\n'));
  assert.strictEqual(words.length, 4);
  const [a, b, c, d] = words;
  assert.strictEqual(a.type, 'hanja');
  assert.strictEqual(a.hanja, '觀測');
  assert.deepStrictEqual(a.parts[0], { ch: '觀', hun: '볼', eum: '관' });
  assert.strictEqual(a.literal, '볼 · 잴');
  assert.strictEqual(a.example, '별을 관측했다.');
  assert.strictEqual(b.type, 'english');
  assert.strictEqual(b.meaning, '관찰하다');
  assert.strictEqual(c.type, 'native');
  assert.strictEqual(d.hanja, '分析', '훈음 없는 한자만 있어도 한자어로');
  assert.strictEqual(errors.length, 1, '뜻 없는 행만 오류: ' + JSON.stringify(errors));
  assert.ok(errors[0].includes('뜻이 없어요'));
});

await t('한자 표기 파싱 — 훈음 있는 형식과 한자만 있는 형식', () => {
  assert.deepStrictEqual(parseHanjaSpec('觀(볼 관)+測(잴 측)').map(p => p.ch), ['觀', '測']);
  assert.deepStrictEqual(parseHanjaSpec('軌(바퀴 자국 궤)')[0], { ch: '軌', hun: '바퀴 자국', eum: '궤' });
  assert.deepStrictEqual(parseHanjaSpec('分析').map(p => p.ch), ['分', '析']);
  assert.strictEqual(parseHanjaSpec('한글만'), null);
  assert.strictEqual(parseHanjaSpec(''), null);
});

await t('배정 — 미리보기는 저장 안 함, 배정은 학생별 배정함에 들어감', async () => {
  const store = memStore();
  const admin = { code: '__admin__', admin: true };
  const text = '관측 | 보고 재는 것 | 觀(볼 관)+測(잴 측)\nobserve, 관찰하다';
  const dry = await call(store, {
    path: '/api/vocab/admin/assign', method: 'POST', who: admin,
    getBody: async () => ({ codes: ['s1'], text, dryRun: true }),
  });
  assert.strictEqual(dry.body.preview, true);
  assert.strictEqual(dry.body.words.length, 2);
  assert.strictEqual(store.getAssign('s1'), null, '미리보기는 저장하지 않는다');

  const r = await call(store, {
    path: '/api/vocab/admin/assign', method: 'POST', who: admin,
    getBody: async () => ({ codes: ['s1', 's2', '없는학생'], title: '3주차 단어', text }),
  });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.assigned, ['s1', 's2'], '등록된 학생에게만');
  assert.strictEqual(r.body.count, 2);
  assert.strictEqual(store.getAssign('s1').items[0].title, '3주차 단어');
  assert.strictEqual(store.getAssign('s1').items[0].words.length, 2);
});

await t('배정 — 학생이 받아보고 심으면 완료 처리', async () => {
  const store = memStore();
  const admin = { code: '__admin__', admin: true };
  await call(store, {
    path: '/api/vocab/admin/assign', method: 'POST', who: admin,
    getBody: async () => ({ codes: ['s1'], title: '1주차', text: '관측 | 보고 재는 것' }),
  });
  const got = await call(store, { path: '/api/vocab/assignments' });
  assert.strictEqual(got.body.items.length, 1);
  const id = got.body.items[0].id;
  assert.strictEqual(got.body.items[0].words[0].word, '관측');

  const ack = await call(store, {
    path: '/api/vocab/assignments/ack', method: 'POST', getBody: async () => ({ id }),
  });
  assert.strictEqual(ack.body.ok, true);
  const after = await call(store, { path: '/api/vocab/assignments' });
  assert.strictEqual(after.body.items.length, 0, '심은 배정은 목록에서 사라진다');

  const bad = await call(store, {
    path: '/api/vocab/assignments/ack', method: 'POST', getBody: async () => ({ id: 'zzz' }),
  });
  assert.strictEqual(bad.status, 404);
});

await t('배정 — 학생 간 격리, 관리 목록에 수행 여부 표시', async () => {
  const store = memStore();
  const admin = { code: '__admin__', admin: true };
  await call(store, {
    path: '/api/vocab/admin/assign', method: 'POST', who: admin,
    getBody: async () => ({ codes: ['s1'], title: 'A반', text: '관측 | 보고 재는 것' }),
  });
  const other = await call(store, { path: '/api/vocab/assignments', who: { code: 's2', admin: false } });
  assert.strictEqual(other.body.items.length, 0, '다른 학생 배정이 보이면 안 된다');
  const list = await call(store, { path: '/api/vocab/admin/assign', who: admin });
  assert.strictEqual(list.body.items.length, 1);
  assert.strictEqual(list.body.items[0].name, '김지우');
  assert.strictEqual(list.body.items[0].done, false);
});

await t('배정 — 학생 미선택·빈 단어·과다 배정 거절', async () => {
  const store = memStore();
  const admin = { code: '__admin__', admin: true };
  const mk = (body) => call(store, { path: '/api/vocab/admin/assign', method: 'POST', who: admin, getBody: async () => body });
  assert.strictEqual((await mk({ codes: [], text: '관측 | 뜻' })).status, 400);
  assert.strictEqual((await mk({ codes: ['s1'], text: '' })).status, 400);
  const many = Array.from({ length: 101 }, (_, i) => 'word' + i + ' | 뜻' + i).join('\n');
  assert.strictEqual((await mk({ codes: ['s1'], text: many })).status, 400, '100개 초과 거절');
  const student = await call(store, { path: '/api/vocab/admin/assign', method: 'POST', getBody: async () => ({ codes: ['s1'], text: 'x | y' }) });
  assert.strictEqual(student.status, 403, '학생은 배정 못 함');
});

await t('AI 키가 없으면 연상 요청이 no-key로 돌아온다', async () => {
  /* 앱은 이걸 보고 버튼을 감춘다. 여기서 200 + ok:false 를 지켜야
     학생 화면이 오류처럼 보이지 않는다. */
  const store = memStore();
  const out = await call(store, {
    path: '/api/vocab/mnemonic', method: 'POST', who: { code: 's1' },
    getBody: async () => ({ word: '관측', meaning: '보고 재는 것', type: 'hanja' }),
    ai: { apiKey: '', model: '' },
  });
  assert.strictEqual(out.status, 200, '키가 없다고 오류를 내면 안 된다');
  assert.strictEqual(out.body.ok, false);
  assert.strictEqual(out.body.reason, 'no-key');
});

console.log('\n통과 ' + passed + '개 — vocab-api 서버 라우트 검증 완료');
