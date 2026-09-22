'use strict';
/* 브레인레터 서버 라우트 검증 (node reading-server/letter-api.test.mjs) — 실제 API 를 부르지 않는다(fetch 를 갈아 끼운다) */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { handleLetter, normalizeState, familyMessage, dropStudentLetter, dumpLetter, tierFor, letterBodyLimit, readLetterAiLimit,
  draftUserPrompt, SAMPLE_PARTS, ISSUE_BODY_LIMIT, STATE_BODY_LIMIT, IMG_BODY_LIMIT, PUTS_PER_DAY, LETTER_AI_DAILY_DEFAULT, DEFAULT_TIER,
  sniffImage, sendLetterPushes, pushDueIssues } from './letter-api.mjs';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const SAMPLE = require('../letter/issue-sample.json');
const L = require('../letter/letter.js');
let passed = 0;
const t = async (name, fn) => { await fn(); passed += 1; console.log('  ✓ ' + name); };
const clone = (v) => JSON.parse(JSON.stringify(v));

/* 메모리 어댑터 — 워커 KV(letter: 접두)·로컬 db.letter 와 같은 계약 */
function memStore() {
  const issues = {}, states = {}, students = {}, parents = {}, images = {}, push = {};
  let ids = null, aiUse = null, calendar = null;
  return {
    getImage: (id) => images[id] || null, putImage: (id, bytes, meta) => { images[id] = { bytes, meta }; }, deleteImage: (id) => { delete images[id]; }, listImages: () => Object.values(images).map((r) => r.meta),
    getPush: (k) => push[k] || null, putPush: (k, rec) => { push[k] = rec; }, delPush: (k) => { delete push[k]; }, listPushKeys: () => Object.keys(push),
    getCalendar: () => calendar, putCalendar: (rec) => { calendar = rec; },
    getIssue: (id) => issues[id] || null, putIssue: (id, rec) => { issues[id] = rec; }, deleteIssue: (id) => { delete issues[id]; },
    getIssueIds: () => ids, putIssueIds: (x) => { ids = x; },
    getState: (c) => states[c] || null, putState: (c, rec) => { states[c] = rec; }, deleteState: (c) => { delete states[c]; }, listStateCodes: () => Object.keys(states),
    getStudent: (c) => students[c] || null, putStudent: (c, rec) => { students[c] = rec; }, listStudentCodes: () => Object.keys(students),
    getParentCode: (tk) => parents[tk] || null, putParent: (tk, c) => { parents[tk] = c; },
    getAiUse: () => aiUse, putAiUse: (rec) => { aiUse = rec; },
    _raw: { issues, states, students, parents, images, push },
  };
}
const NOW = Date.parse('2026-09-22T01:00:00Z');   // 9/22 10:00 KST (화요일, 39주)
const ADMIN = { code: '__admin__', admin: true };
const STU = { code: 'st-1', admin: false };
const Q = (s) => new URLSearchParams(s);
/* 토큰 흉내 — 학생마다 달라야 한다(같은 값이면 뒤 학생이 앞 학생의 가족 링크를 덮어쓴다) */
let tokN = 0;
const nextToken = () => 'p'.repeat(31) + String.fromCharCode(97 + (tokN++ % 26));
const call = (store, over) => handleLetter({ path: '/api/letter/issues', method: 'GET', who: STU, query: Q(''), getBody: async () => ({}), store, now: NOW, origin: 'https://wb.test', randomToken: nextToken, ...over });
function seed(store, opts = {}) {
  store.putStudent('st-1', { code: 'st-1', name: '김초등', grade: '초3', cls: '독해A', level: 'L2' });
  store.putStudent('st-2', { code: 'st-2', name: '이중등', grade: '중2', cls: '독해B', ptoken: 'q'.repeat(32) });
  store.putStudent('st-3', { code: 'st-3', name: '박유치', grade: '7세', cls: '유치' });
  store._raw.parents['q'.repeat(32)] = 'st-2';
  if (opts.issue !== false) { store.putIssue(SAMPLE.id, { issue: clone(SAMPLE), updatedAt: '2026-09-20T00:00:00Z' }); store.putIssueIds([SAMPLE.id]); }
}
/* 모델 응답을 흉내내는 fetch */
function fakeFetch(reply) {
  const calls = [];
  const f = async (url, opt) => {
    calls.push({ url, body: JSON.parse(opt.body), headers: opt.headers });
    const r = typeof reply === 'function' ? reply(calls.length) : reply;
    if (r instanceof Error) throw r;
    if (r.status && r.status >= 400) return { ok: false, status: r.status };
    return { ok: true, status: 200, json: async () => (r.raw !== undefined ? r.raw : { model: 'claude-opus-5', stop_reason: r.stop_reason || 'end_turn', content: [{ type: 'text', text: r.text }] }) };
  };
  f.calls = calls;
  return f;
}

console.log('letter-api — 브레인레터 라우트');

await t('인증 없으면 401 — 호·기록·관리 어느 것도 나가지 않는다 (가족 링크만 예외)', async () => {
  const store = memStore(); seed(store);
  for (const path of ['/api/letter/issues', '/api/letter/issue', '/api/letter/state', '/api/letter/admin/issues']) {
    const r = await call(store, { who: null, path, query: Q('id=' + SAMPLE.id) });
    assert.equal(r.status, 401, path); assert.equal(r.body.issue, undefined);
  }
});

await t('학년대 판정 — 명부 학년, 못 읽으면 기본 학년대 + guess 표시', async () => {
  assert.deepEqual(tierFor({ grade: '초3' }), { tier: 'E2', guess: false });
  assert.deepEqual(tierFor({ grade: '?' }), { tier: DEFAULT_TIER, guess: true });
  assert.deepEqual(tierFor({ grade: '', letterTier: 'K' }), { tier: 'K', guess: false });
  assert.equal(letterBodyLimit('/api/letter/admin/issue'), ISSUE_BODY_LIMIT); assert.equal(letterBodyLimit('/api/letter/state'), STATE_BODY_LIMIT); assert.equal(letterBodyLimit('/api/letter/admin/img'), IMG_BODY_LIMIT);
  assert.equal(readLetterAiLimit({}).total, LETTER_AI_DAILY_DEFAULT); assert.equal(readLetterAiLimit({ LETTER_AI_DAILY: '5' }).total, 5);
});

await t('학생 목록·호 — 발행된 호만, 자기 학년대 섹션만, 발행일 전이면 404', async () => {
  const store = memStore(); seed(store);
  const list = await call(store, { path: '/api/letter/issues' });
  assert.equal(list.status, 200); assert.equal(list.body.tier, 'E2'); assert.equal(list.body.issues.length, 1); assert.equal(list.body.issues[0].id, SAMPLE.id);
  assert.equal(typeof list.body.issues[0].sections, 'number', '목록은 요약(brief)만 — 섹션은 개수'); assert.ok(list.body.issues[0].title);
  const one = await call(store, { path: '/api/letter/issue', query: Q('id=' + SAMPLE.id) });
  assert.equal(one.status, 200);
  assert.deepEqual(one.body.issue.sections.map((s) => s.id), ['read-e2', 'words', 'brain-e2', 'mission', 'column', 'coach-e2', 'poem', 'talk', 'write-e2', 'books', 'voices', 'news']);
  assert.equal(one.body.issue.tier, 'E2');
  /* 초안·미래 발행일은 학생에게 없다 */
  store.putIssue(SAMPLE.id, { issue: { ...clone(SAMPLE), status: 'draft' }, updatedAt: 'x' });
  assert.equal((await call(store, { path: '/api/letter/issue', query: Q('id=' + SAMPLE.id) })).status, 404);
  assert.equal((await call(store, { path: '/api/letter/issues' })).body.issues.length, 0);
  store.putIssue(SAMPLE.id, { issue: { ...clone(SAMPLE), publishAt: '2026-09-28' }, updatedAt: 'x' });
  assert.equal((await call(store, { path: '/api/letter/issue', query: Q('id=' + SAMPLE.id) })).status, 404, '발행일 전');
  assert.equal((await call(store, { path: '/api/letter/issue', query: Q('id=zzz') })).status, 400);
  assert.equal((await call(store, { path: '/api/letter/issue', query: Q('id=2026-W10') })).status, 404);
  /* 유치부 전용이 아닌 호 — 그 학년대 섹션이 하나도 없으면 목록에도 안 뜬다 */
  const onlyM = { ...clone(SAMPLE), sections: clone(SAMPLE).sections.filter((s) => Array.isArray(s.tiers) && s.tiers.length === 1 && s.tiers[0] === 'M') };
  store.putIssue(SAMPLE.id, { issue: onlyM, updatedAt: 'x' });
  assert.equal((await call(store, { path: '/api/letter/issues' })).body.issues.length, 0);
});

await t('학년을 못 읽는 학생 — 기본 학년대로 받고 guess:true', async () => {
  const store = memStore(); seed(store);
  store.putStudent('st-1', { code: 'st-1', name: '누구', grade: '기타' });
  const r = await call(store, { path: '/api/letter/issues' });
  assert.equal(r.body.tier, 'E2'); assert.equal(r.body.guess, true);
  assert.equal((await call(store, { who: { code: 'nobody', admin: false }, path: '/api/letter/issues' })).status, 404);
});

await t('학생 기록 — 화이트리스트 정규화, 하루 저장 상한, 크기 상한', async () => {
  const n = normalizeState({ issues: { '2026-W39': { openedAt: '2026-09-22T01:00:00Z', quiz: { 'read-e2:0': 1, 'read-e2:1': 9, 'bad key': 0, 'read-e2:2': 'x' }, reveal: { 'brain-e2:0': true, 'brain-e2:1': 'yes' }, checks: { 'mission:0': true }, junk: 1 }, 'nope': { quiz: {} } }, extra: true });
  assert.deepEqual(n, { v: 1, issues: { '2026-W39': { openedAt: '2026-09-22T01:00:00Z', doneAt: '', quiz: { 'read-e2:0': 1 }, reveal: { 'brain-e2:0': true }, checks: { 'mission:0': true }, days: {}, trace: {}, write: {} } } });
  /* 하루 한 장·따라쓰기 — 요일은 1~7 의 시각 문자열만, 따라쓰기는 섹션 id 별 0~30 회차만 */
  const n2 = normalizeState({ issues: { '2026-W39': { openedAt: 'x', days: { 1: '2026-09-21T01:00:00Z', 8: 'no', 2: 5, 7: '' }, trace: { words: 3, 'bad key!': 1, w2: 99, w3: -1 } } } }).issues['2026-W39'];
  assert.deepEqual(n2.days, { 1: '2026-09-21T01:00:00Z' }); assert.deepEqual(n2.trace, { words: 3 });
  const n3 = normalizeState({ issues: { '2026-W39': { write: { 'write-e2:0': ' 한 문장 ', 'write-e2:1': '   ', 'bad key': 'x', 'write-e2:2': 'a'.repeat(301) } } } }).issues['2026-W39'];
  assert.deepEqual(n3.write, { 'write-e2:0': ' 한 문장 ' }, '쓴 글은 300자·형만 본다');
  assert.equal(normalizeState(null), null); assert.equal(normalizeState([]), null);
  const store = memStore(); seed(store);
  const g0 = await call(store, { path: '/api/letter/state' });
  assert.deepEqual(g0.body, { state: { v: 1, issues: {} }, updatedAt: null });
  const put = (state) => call(store, { path: '/api/letter/state', method: 'PUT', getBody: async () => ({ state }) });
  const r1 = await put({ issues: { '2026-W39': { openedAt: 'x', quiz: { 'read-e2:0': 0 } } } });
  assert.equal(r1.status, 200); assert.ok(r1.body.updatedAt);
  const g1 = await call(store, { path: '/api/letter/state' });
  assert.equal(g1.body.state.issues['2026-W39'].quiz['read-e2:0'], 0);
  assert.equal((await put({})).status, 200, '빈 기록도 저장된다');
  assert.equal((await put('x')).status, 400);
  assert.equal((await call(store, { path: '/api/letter/state', method: 'PUT', getBody: async () => { const e = new Error('big'); e.status = 413; throw e; } })).status, 413);
  for (let i = 2; i < PUTS_PER_DAY; i += 1) assert.equal((await put({})).status, 200, 'put ' + i);
  assert.equal((await put({})).status, 429, '하루 상한');
  const big = { issues: {} };
  for (let i = 0; i < 60; i += 1) { const id = '2026-W' + String((i % 50) + 1).padStart(2, '0') + '-x' + i.toString(36); big.issues[id] = { quiz: {} }; for (let k = 0; k < 200; k += 1) big.issues[id].quiz['section-' + k + ':' + (k % 10)] = 1; }
  const s2 = memStore(); seed(s2);
  const rb = await call(s2, { path: '/api/letter/state', method: 'PUT', getBody: async () => ({ state: big }) });
  assert.equal(rb.status, 413, '150KB 상한');
  /* 관리자 토큰으로는 학생 기록을 쓰지 않는다 */
  assert.equal((await call(store, { who: ADMIN, path: '/api/letter/state', method: 'PUT', getBody: async () => ({ state: {} }) })).status, 404);
});

await t('가족 링크 — 토큰으로 자기 학년대 호, 없는 토큰 404, 학년 오류 없이 이름만', async () => {
  const store = memStore(); seed(store);
  const r = await call(store, { who: null, path: '/api/letter/parent', query: Q('t=' + 'q'.repeat(32)) });
  assert.equal(r.status, 200); assert.equal(r.body.parent.name, '이중등'); assert.equal(r.body.parent.tier, 'M');
  assert.ok(r.body.issue.sections.some((s) => s.id === 'read-m') && !r.body.issue.sections.some((s) => s.id === 'read-k'));
  assert.equal(r.body.issues.length, 1);
  assert.equal((await call(store, { who: null, path: '/api/letter/parent', query: Q('t=' + 'z'.repeat(32)) })).status, 404);
  assert.equal((await call(store, { who: null, path: '/api/letter/parent', query: Q('t=short') })).status, 404);
  assert.equal((await call(store, { who: null, path: '/api/letter/parent', query: Q('t=' + 'q'.repeat(32) + '&id=2026-W10') })).status, 404);
  const draft = memStore(); seed(draft); draft.putIssue(SAMPLE.id, { issue: { ...clone(SAMPLE), status: 'draft' }, updatedAt: 'x' });
  const r2 = await call(draft, { who: null, path: '/api/letter/parent', query: Q('t=' + 'q'.repeat(32)) });
  assert.equal(r2.status, 200); assert.equal(r2.body.issue, null); assert.deepEqual(r2.body.issues, []);
  /* 학생 토큰의 who 로 부모 경로를 쳐도 같은 답(무인증 경로) — 부모 경로에 학생 기록은 없다 */
  assert.equal(JSON.stringify(r.body).includes('"quiz"'), false);
});

await t('관리 — 저장은 검증기를 통과해야, 목록·상세·삭제, 발행/내리기는 다시 검증', async () => {
  const store = memStore(); seed(store, { issue: false });
  const admin = (over) => call(store, { who: ADMIN, ...over });
  const bad = clone(SAMPLE); bad.sections[0].questions[0].answer = 7;
  const rb = await admin({ path: '/api/letter/admin/issue', method: 'PUT', getBody: async () => ({ issue: bad }) });
  assert.equal(rb.status, 400); assert.ok(rb.body.errors.length >= 1);
  assert.equal((await store.getIssueIds()), null, '실패한 저장은 흔적이 없다');
  const ok = await admin({ path: '/api/letter/admin/issue', method: 'PUT', getBody: async () => ({ issue: clone(SAMPLE) }) });
  assert.equal(ok.status, 200); assert.equal(ok.body.id, SAMPLE.id); assert.deepEqual(ok.body.warnings, []);
  assert.deepEqual(await store.getIssueIds(), [SAMPLE.id]);
  const again = await admin({ path: '/api/letter/admin/issue', method: 'PUT', getBody: async () => ({ issue: { ...clone(SAMPLE), title: '고침' } }) });
  assert.equal(again.status, 200); assert.deepEqual(await store.getIssueIds(), [SAMPLE.id], '같은 id 는 덮어쓴다');
  const list = await admin({ path: '/api/letter/admin/issues' });
  assert.equal(list.body.issues.length, 1); assert.equal(list.body.issues[0].title, '고침'); assert.equal(list.body.issues[0].opened, 0); assert.equal(list.body.issues[0].visible, true);
  const one = await admin({ path: '/api/letter/admin/issue', query: Q('id=' + SAMPLE.id) });
  assert.equal(one.status, 200); assert.equal(one.body.issue.sections.length, SAMPLE.sections.length, '관리자는 전체');
  /* 관리자 미리보기 — tier 로 걸러 본다, 초안도 본다 */
  const pv = await admin({ path: '/api/letter/issue', query: Q('id=' + SAMPLE.id + '&tier=K') });
  assert.equal(pv.status, 200); assert.equal(pv.body.tier, 'K'); assert.ok(pv.body.issue.sections.every((s) => s.tiers === 'all' || s.tiers.includes('K')));
  assert.equal((await admin({ path: '/api/letter/issue', query: Q('id=' + SAMPLE.id) })).body.issue.sections.length, SAMPLE.sections.length);
  /* 내리기 → 학생에게 사라진다 → 다시 발행(발행일 지정) */
  const down = await admin({ path: '/api/letter/admin/publish', method: 'POST', getBody: async () => ({ id: SAMPLE.id, status: 'draft' }) });
  assert.equal(down.status, 200); assert.equal(down.body.status, 'draft');
  assert.equal((await call(store, { path: '/api/letter/issues' })).body.issues.length, 0);
  const up = await admin({ path: '/api/letter/admin/publish', method: 'POST', getBody: async () => ({ id: SAMPLE.id, status: 'published', publishAt: '2026-09-28' }) });
  assert.equal(up.status, 200); assert.equal(up.body.visible, false, '발행일이 미래면 아직 안 보인다');
  assert.equal((await admin({ path: '/api/letter/admin/publish', method: 'POST', getBody: async () => ({ id: SAMPLE.id, status: 'live' }) })).status, 400);
  assert.equal((await admin({ path: '/api/letter/admin/publish', method: 'POST', getBody: async () => ({ id: SAMPLE.id, status: 'published', publishAt: '2026-13-01' }) })).status, 400);
  /* 규칙이 바뀌어 옛 초안이 깨졌다면 발행이 막힌다 — 저장소에 직접 넣은 깨진 호로 흉내 */
  store.putIssue('2026-W40', { issue: { ...bad, id: '2026-W40', week: '2026-W40', status: 'draft' }, updatedAt: 'x' }); store.putIssueIds([SAMPLE.id, '2026-W40']);
  assert.equal((await admin({ path: '/api/letter/admin/publish', method: 'POST', getBody: async () => ({ id: '2026-W40', status: 'published' }) })).status, 400);
  assert.equal((await admin({ path: '/api/letter/admin/publish', method: 'POST', getBody: async () => ({ id: '2026-W40', status: 'draft' }) })).status, 200, '초안으로 두는 것은 된다');
  const del = await admin({ path: '/api/letter/admin/issue', method: 'DELETE', getBody: async () => ({ id: '2026-W40' }) });
  assert.equal(del.status, 200); assert.deepEqual(await store.getIssueIds(), [SAMPLE.id]);
  assert.equal((await admin({ path: '/api/letter/admin/issue', method: 'DELETE', getBody: async () => ({ id: '2026-W40' }) })).status, 404);
  /* 학생 토큰으로 관리 라우트는 403 */
  assert.equal((await call(store, { path: '/api/letter/admin/issues' })).status, 403);
});

await t('관리 — 학생 목록·학년대 지정·발송 문구(가족 링크 자동 발급)·열람 현황', async () => {
  const store = memStore(); seed(store);
  const admin = (over) => call(store, { who: ADMIN, ...over });
  const st = await admin({ path: '/api/letter/admin/students' });
  assert.equal(st.body.students.length, 3);
  assert.deepEqual(st.body.students.map((s) => s.tier), ['K', 'E2', 'M'], '학년대 순 정렬');
  assert.equal(st.body.students.find((s) => s.code === 'st-2').hasLink, true);
  const tier = await admin({ path: '/api/letter/admin/tier', method: 'POST', getBody: async () => ({ code: 'st-1', tier: 'E3' }) });
  assert.equal(tier.status, 200); assert.equal(tier.body.tier, 'E3'); assert.equal(store.getStudent('st-1').letterTier, 'E3'); assert.equal(store.getStudent('st-1').level, 'L2', '다른 필드는 그대로');
  assert.equal((await admin({ path: '/api/letter/admin/tier', method: 'POST', getBody: async () => ({ code: 'st-1', tier: 'H' }) })).status, 400);
  assert.equal((await admin({ path: '/api/letter/admin/tier', method: 'POST', getBody: async () => ({ code: 'st-1', tier: '' }) })).body.tier, 'E2', '빈 값이면 자동으로 돌아간다');
  assert.equal((await admin({ path: '/api/letter/admin/tier', method: 'POST', getBody: async () => ({ code: 'ghost', tier: 'K' }) })).status, 404);
  const msg = await admin({ path: '/api/letter/admin/messages', query: Q('id=' + SAMPLE.id) });
  assert.equal(msg.status, 200); assert.equal(msg.body.messages.length, 3);
  const m1 = msg.body.messages.find((m) => m.code === 'st-1');
  const tok1 = store.getStudent('st-1').ptoken;
  assert.ok(/^p{31}[a-z]$/.test(tok1), '링크 없던 학생은 새로 발급');
  assert.equal(m1.link, 'https://wb.test/letter/?t=' + tok1);
  assert.equal(store._raw.parents[tok1], 'st-1');
  assert.notEqual(store.getStudent('st-3').ptoken, tok1, '학생마다 다른 토큰');
  assert.equal(store._raw.parents[store.getStudent('st-3').ptoken], 'st-3');
  const m2 = msg.body.messages.find((m) => m.code === 'st-2');
  assert.equal(m2.link, 'https://wb.test/letter/?t=' + 'q'.repeat(32), '있던 링크는 그대로');
  assert.ok(/브레인레터/.test(m2.text) && /2026년 39호/.test(m2.text) && m2.text.includes(m2.link) && /중등/.test(m2.text));
  assert.equal(familyMessage({ name: 'x' }, SAMPLE, 'L', 'K').split('\n').length, 5);
  /* 열람 현황 — 기록에 openedAt 이 있으면 열람, 문항별 정답 집계 */
  store.putState('st-1', { state: { v: 1, issues: { [SAMPLE.id]: { openedAt: 'x', doneAt: 'y', quiz: { 'read-e2:0': 0, 'read-e2:1': 3 }, reveal: {}, checks: {} } } }, updatedAt: 'x' });
  const stats = await admin({ path: '/api/letter/admin/stats', query: Q('id=' + SAMPLE.id) });
  assert.equal(stats.status, 200);
  assert.deepEqual(stats.body.stats.byTier.E2, { total: 1, opened: 1, done: 1, days: 0 });
  assert.deepEqual(stats.body.stats.byTier.M, { total: 1, opened: 0, done: 0, days: 0 });
  assert.equal(stats.body.stats.total, 3); assert.equal(stats.body.stats.opened, 1);
  assert.deepEqual(stats.body.stats.unopened.map((u) => u.code).sort(), ['st-2', 'st-3']);
  const q0 = stats.body.stats.quiz.find((r) => r.section === 'read-e2' && r.qi === 0), q1 = stats.body.stats.quiz.find((r) => r.section === 'read-e2' && r.qi === 1);
  assert.deepEqual([q0.n, q0.correct, q1.n, q1.correct], [1, 1, 1, 0]);
  const list = await admin({ path: '/api/letter/admin/issues' });
  assert.equal(list.body.issues[0].opened, 1);
  assert.equal((await admin({ path: '/api/letter/admin/stats', query: Q('id=2026-W01') })).status, 404);
});

await t('AI 초안 — 키 없으면 no-key, 조각별 호출·검증 결과 동봉, 한도·실패 사유', async () => {
  const store = memStore(); seed(store);
  const admin = (over) => call(store, { who: ADMIN, ...over });
  const body = { part: 'E2', theme: '가을 곤충의 겨울나기', week: '2026-W40', brainIndex: 'WMI', notes: '10월 3일 휴원' };
  const nokey = await admin({ path: '/api/letter/admin/draft', method: 'POST', getBody: async () => body });
  assert.equal(nokey.status, 200); assert.deepEqual(nokey.body, { ok: false, reason: 'no-key', part: 'E2' });
  assert.equal((await admin({ path: '/api/letter/admin/draft', method: 'POST', getBody: async () => ({ ...body, part: 'HS' }) })).status, 400);
  assert.equal((await admin({ path: '/api/letter/admin/draft', method: 'POST', getBody: async () => ({ ...body, theme: ' ', week: '2031-W10' }) })).status, 400, '달력에도 없는 주차');
  assert.equal((await admin({ path: '/api/letter/admin/draft', method: 'POST', getBody: async () => ({ ...body, theme: ' ' }) })).body.reason, 'no-key', '주제를 비우면 달력 주제로 진행한다');
  /* 정상 — 샘플의 E2 조각을 그대로 돌려주는 가짜 모델 */
  const parts = SAMPLE_PARTS();
  const f = fakeFetch({ text: '```json\n' + JSON.stringify(parts.E2) + '\n```' });
  const ok = await admin({ path: '/api/letter/admin/draft', method: 'POST', getBody: async () => body, ai: { apiKey: 'k', env: {}, fetchImpl: f } });
  assert.equal(ok.status, 200); assert.equal(ok.body.ok, true); assert.equal(ok.body.part, 'E2');
  assert.deepEqual(ok.body.sections.map((s) => s.id), ['read-e2', 'brain-e2', 'coach-e2', 'write-e2']);
  assert.deepEqual(ok.body.errors, []); assert.equal(ok.body.aiLeft, LETTER_AI_DAILY_DEFAULT - 1); assert.equal(ok.body.aiCap, LETTER_AI_DAILY_DEFAULT);
  assert.equal(store.getAiUse().count, 1, '장부에 남는다');
  const c = f.calls[0];
  assert.equal(c.headers['x-api-key'], 'k'); assert.equal(c.headers['anthropic-version'], '2023-06-01'); assert.equal(c.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(c.body.model, 'claude-opus-5'); assert.equal(c.body.fallbacks, 'default'); assert.ok(c.body.max_tokens >= 8000);
  const user = c.body.messages[0].content;
  assert.ok(/가을 곤충의 겨울나기/.test(user) && /2026-W40/.test(user) && /WMI/.test(user) && /10월 3일 휴원/.test(user) && /read-e2/.test(user) && /write-e2/.test(user));
  assert.ok(/drill/.test(c.body.system) && /poem\(/.test(c.body.system), '고정 코너·5분 놀이 규격이 시스템 프롬프트에');
  assert.ok(/자체 창작|창작/.test(c.body.system) && /K-WISC-V/.test(c.body.system));
  /* 공통 조각은 head 를 같이 돌려준다 */
  const fs2 = fakeFetch({ text: JSON.stringify(parts.shared) });
  const sh = await admin({ path: '/api/letter/admin/draft', method: 'POST', getBody: async () => ({ ...body, part: 'shared', brainIndex: { K: 'PSI' } }), ai: { apiKey: 'k', env: {}, fetchImpl: fs2 } });
  assert.equal(sh.body.ok, true); assert.equal(sh.body.head.title, SAMPLE.title); assert.deepEqual(sh.body.sections.map((s) => s.id).sort(), ['books', 'column', 'mission', 'poem', 'talk', 'words']);
  assert.ok(/PSI/.test(fs2.calls[0].body.messages[0].content));
  /* 깨진 조각 — 정답 번호가 보기 밖 → 초안은 돌려주되 errors 에 적힌다(원장이 편집기에서 고친다) */
  const broken = clone(parts.E2); broken.sections[0].questions[0].answer = 9;
  const fb = fakeFetch({ text: JSON.stringify(broken) });
  const rb = await admin({ path: '/api/letter/admin/draft', method: 'POST', getBody: async () => body, ai: { apiKey: 'k', env: {}, fetchImpl: fb } });
  assert.equal(rb.body.ok, true); assert.ok(rb.body.errors.length >= 1); assert.ok(!rb.body.warnings.some((w) => w.where === 'coverage'), '조각 검증에 커버리지 경고는 없다');
  /* 실패 사유 — 거절·잘림·모양·네트워크·API 오류 */
  for (const [rep, reason] of [[{ text: 'x', stop_reason: 'refusal' }, 'refused'], [{ text: '{"sections":[]}', stop_reason: 'max_tokens' }, 'truncated'], [{ text: '{"nope":1}' }, 'shape'], [{ text: 'not json' }, 'parse'], [new Error('net'), 'network'], [{ status: 529 }, 'api-529']]) {
    const r = await admin({ path: '/api/letter/admin/draft', method: 'POST', getBody: async () => body, ai: { apiKey: 'k', env: {}, fetchImpl: fakeFetch(rep) } });
    assert.equal(r.body.ok, false, reason); assert.equal(r.body.reason, reason);
  }
  /* 한도 — 실패한 호출도 셌으니 남은 수가 줄어 있고, 상한이 되면 부르지 않는다 */
  const fq = fakeFetch({ text: JSON.stringify(parts.E2) });
  const s2 = memStore(); seed(s2);
  const a2 = (over) => call(s2, { who: ADMIN, ...over });
  for (let i = 0; i < 2; i += 1) assert.equal((await a2({ path: '/api/letter/admin/draft', method: 'POST', getBody: async () => body, ai: { apiKey: 'k', env: { LETTER_AI_DAILY: '2' }, fetchImpl: fq } })).body.ok, true);
  const over = await a2({ path: '/api/letter/admin/draft', method: 'POST', getBody: async () => body, ai: { apiKey: 'k', env: { LETTER_AI_DAILY: '2' }, fetchImpl: fq } });
  assert.equal(over.body.ok, false); assert.equal(over.body.reason, 'quota'); assert.equal(fq.calls.length, 2, '한도를 넘긴 호출은 나가지 않는다');
  /* 프롬프트 도우미 */
  assert.ok(/형식 예시/.test(draftUserPrompt({ part: 'K', theme: 't', week: '2026-W40', publishAt: '2026-09-28', brainIndex: 'PSI', notes: '' })));
});

await t('퇴원·백업 — 기록만 지우고 호는 남는다 / 덤프에 호 본문과 기록이 담긴다', async () => {
  const store = memStore(); seed(store);
  store.putState('st-1', { state: { v: 1, issues: {} }, updatedAt: 'x' });
  store.putPush('s:st-1', { endpoint: 'https://p/1' }); store.putPush('f:' + 'q'.repeat(32), { endpoint: 'https://p/2' }); store.putPush('s:st-2', { endpoint: 'https://p/3' });
  await dropStudentLetter(store, 'st-1', 'q'.repeat(32));
  assert.equal(store.getState('st-1'), null); assert.ok(store.getIssue(SAMPLE.id));
  assert.deepEqual(store.listPushKeys(), ['s:st-2'], '학생 기기·가족 링크 구독을 함께 지운다');
  store.putState('st-2', { state: { v: 1, issues: {} }, updatedAt: 'y' });
  const d = await dumpLetter(store);
  assert.deepEqual(Object.keys(d.issues), [SAMPLE.id]); assert.equal(d.issues[SAMPLE.id].issue.title, SAMPLE.title);
  assert.deepEqual(Object.keys(d.states), ['st-2']);
  assert.deepEqual(Object.keys(d.push), ['s:st-2']); assert.ok('calendar' in d && Array.isArray(d.images));
  assert.equal((await call(store, { who: ADMIN, path: '/api/letter/nope' })).status, 404);
});

/* ── 사진 ── */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(50, 2)]);
await t('사진 — base64 로 올리면 매직 바이트로 종류를 정하고, id 로 누구나(링크를 아는 사람만) 받는다; SVG·큰 파일은 거절', async () => {
  const store = memStore(); seed(store);
  const admin = (over) => call(store, { who: ADMIN, ...over });
  assert.equal(sniffImage(JPEG), 'image/jpeg'); assert.equal(sniffImage(PNG), 'image/png'); assert.equal(sniffImage(Buffer.from('<svg xmlns="x"></svg>')), null);
  /* 사진 id 는 16진수 32자(crypto.randomUUID) — 가짜 토큰 생성기 대신 16진수를 준다 */
  const up = await admin({ path: '/api/letter/admin/img', method: 'POST', randomToken: () => 'c'.repeat(31) + 'd', getBody: async () => ({ name: '단풍.jpg', type: 'image/svg+xml', data: 'data:image/jpeg;base64,' + JPEG.toString('base64'), w: 1200, h: 800 }) });
  assert.equal(up.status, 200); assert.ok(/^[a-f0-9]{32}$/.test(up.body.id) && up.body.url === '/api/letter/img/' + up.body.id); assert.equal(up.body.type, 'image/jpeg', '보낸 type 이 아니라 바이트로 정한다');
  const get = await call(store, { who: null, path: '/api/letter/img/' + up.body.id });
  assert.equal(get.status, 200); assert.ok(get.bytes && get.bytes.length === JPEG.length); assert.equal(get.headers['Content-Type'], 'image/jpeg'); assert.ok(/immutable/.test(get.headers['Cache-Control']));
  assert.equal((await call(store, { who: null, path: '/api/letter/img/' + 'b'.repeat(32) })).status, 404);
  assert.equal((await call(store, { who: null, path: '/api/letter/img/short' })).status, 401, '형식이 다르면 사진 경로가 아니다');
  const list = await admin({ path: '/api/letter/admin/imgs' });
  assert.equal(list.body.images.length, 1); assert.equal(list.body.images[0].name, '단풍.jpg'); assert.equal(list.body.images[0].w, 1200); assert.ok(!('bytes' in list.body.images[0]));
  assert.equal((await admin({ path: '/api/letter/admin/img', method: 'POST', getBody: async () => ({ data: Buffer.from('<svg></svg>').toString('base64') }) })).status, 400, 'SVG 거절');
  assert.equal((await admin({ path: '/api/letter/admin/img', method: 'POST', getBody: async () => ({ data: '' }) })).status, 400);
  assert.equal((await admin({ path: '/api/letter/admin/img', method: 'POST', getBody: async () => ({ data: Buffer.concat([JPEG, Buffer.alloc(1_600_000)]).toString('base64') }) })).status, 413, '1.5MB 상한');
  assert.equal((await call(store, { path: '/api/letter/admin/img', method: 'POST', getBody: async () => ({ data: JPEG.toString('base64') }) })).status, 403, '학생은 못 올린다');
  const del = await admin({ path: '/api/letter/admin/img', method: 'DELETE', getBody: async () => ({ id: up.body.id }) });
  assert.equal(del.status, 200); assert.equal((await call(store, { who: null, path: '/api/letter/img/' + up.body.id })).status, 404);
  assert.equal((await admin({ path: '/api/letter/admin/img', method: 'DELETE', getBody: async () => ({ id: up.body.id }) })).status, 404);
});

await t('AI 삽화 — 키 없으면 no-key; Gemini 응답의 inlineData 를 바이트로 확인해 돌려주고 AI 장부에 남긴다; 비율·장면 검사·거절·한도', async () => {
  const store = memStore(); seed(store);
  const admin = (over) => call(store, { who: ADMIN, ...over });
  const body = { prompt: '보름달 아래 감나무와 아이', ratio: '16:9' };
  const gen = (over) => admin({ path: '/api/letter/admin/img/gen', method: 'POST', getBody: async () => body, ...over });
  assert.deepEqual((await gen({ ai: { apiKey: 'anthropic-only' } })).body, { ok: false, reason: 'no-key' }, 'Anthropic 키만으로는 그림을 못 만든다');
  assert.equal((await call(store, { path: '/api/letter/admin/img/gen', method: 'POST', getBody: async () => body })).status, 403, '학생은 못 만든다');
  const gemini = { raw: { candidates: [{ content: { parts: [{ text: '설명' }, { inlineData: { mimeType: 'image/jpeg', data: PNG.toString('base64') } }] }, finishReason: 'STOP' }] } };
  const fq = fakeFetch(gemini);
  const ai = { imageKey: 'g-key', fetchImpl: fq, env: {} };
  const ok = await gen({ ai });
  assert.equal(ok.status, 200); assert.equal(ok.body.ok, true);
  assert.equal(ok.body.type, 'image/png', '보낸 mimeType 이 아니라 바이트로 정한다'); assert.equal(ok.body.size, PNG.length); assert.equal(ok.body.data, PNG.toString('base64'));
  assert.equal(ok.body.model, 'gemini-2.5-flash-image'); assert.equal(ok.body.ratio, '16:9'); assert.equal(ok.body.prompt, body.prompt);
  assert.equal(ok.body.aiLeft, LETTER_AI_DAILY_DEFAULT - 1); assert.equal(ok.body.aiCap, LETTER_AI_DAILY_DEFAULT);
  assert.equal(fq.calls.length, 1);
  const c = fq.calls[0];
  assert.equal(c.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent');
  assert.equal(c.headers['x-goog-api-key'], 'g-key'); assert.equal(c.headers['x-api-key'], undefined, 'Anthropic 헤더가 섞이지 않는다');
  assert.deepEqual(c.body.generationConfig, { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9' } });
  const text = c.body.contents[0].parts[0].text;
  assert.ok(text.includes('장면: 보름달 아래 감나무와 아이') && /No text/.test(text) && /글자/.test(text), '장면 + 글자 없음 규칙');
  assert.equal(store.getAiUse().count, 1, 'AI 초안과 같은 장부');
  /* 모델 이름은 ctx 로 바꾼다, 비율을 안 주면 4:3 */
  const fq2 = fakeFetch(gemini);
  await gen({ getBody: async () => ({ prompt: '가을 잎' }), ai: { ...ai, fetchImpl: fq2, imageModel: 'gemini-3-pro-image-preview' } });
  assert.ok(fq2.calls[0].url.includes('/gemini-3-pro-image-preview:generateContent')); assert.equal(fq2.calls[0].body.generationConfig.imageConfig.aspectRatio, '4:3');
  /* 입력 검사 — 호출 전에 막는다 */
  assert.equal((await gen({ getBody: async () => ({ prompt: ' ' }), ai })).status, 400);
  assert.equal((await gen({ getBody: async () => ({ prompt: '달', ratio: '16:10' }), ai })).status, 400, '모델이 모르는 비율');
  assert.equal(fq.calls.length, 1);
  /* 실패 사유 — 실패한 호출도 장부에 남는다 */
  const reason = async (reply) => (await gen({ ai: { ...ai, fetchImpl: fakeFetch(reply) } })).body.reason;
  assert.equal(await reason({ raw: { promptFeedback: { blockReason: 'SAFETY' } } }), 'refused');
  assert.equal(await reason({ raw: { candidates: [{ content: { parts: [{ text: '못 그려요' }] }, finishReason: 'IMAGE_SAFETY' }] } }), 'refused');
  assert.equal(await reason({ raw: { candidates: [{ content: { parts: [{ text: '설명만' }] }, finishReason: 'STOP' }] } }), 'shape');
  assert.equal(await reason({ raw: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: Buffer.from('<svg/>').toString('base64') } }] } }] } }), 'shape', '그림 바이트가 아니면 돌려주지 않는다');
  assert.equal(await reason({ status: 429 }), 'api-429');
  assert.equal(await reason(new Error('down')), 'network');
  assert.equal(store.getAiUse().count, 8);
  /* 한도 — 넘긴 호출은 나가지 않는다 */
  const fq3 = fakeFetch(gemini);
  const over = await gen({ ai: { ...ai, fetchImpl: fq3, quota: { take: () => false, left: () => 0 } } });
  assert.equal(over.body.ok, false); assert.equal(over.body.reason, 'quota'); assert.equal(fq3.calls.length, 0);
  /* 올릴 때 src:'ai' 를 붙이면 목록에 남는다 — 스니펫의 출처 표시가 여기서 갈린다 */
  await admin({ path: '/api/letter/admin/img', method: 'POST', randomToken: () => 'a'.repeat(32), getBody: async () => ({ name: 'AI 삽화 · 달', data: PNG.toString('base64'), src: 'ai' }) });
  await admin({ path: '/api/letter/admin/img', method: 'POST', randomToken: () => 'b'.repeat(32), getBody: async () => ({ name: '단풍.jpg', data: JPEG.toString('base64'), src: 'hacked' }) });
  const list = (await admin({ path: '/api/letter/admin/imgs' })).body.images;
  assert.deepEqual(list.map((m) => [m.name, m.src]).sort(), [['AI 삽화 · 달', 'ai'], ['단풍.jpg', 'upload']]);
});

/* ── 푸시 ── */
const PUSH = { publicKey: 'BPUB', privateJwk: JSON.stringify({ kty: 'EC', crv: 'P-256', d: 'x', x: 'y', y: 'z' }), subject: 'mailto:t@wb' };
function fakePush(statusFor) { const calls = []; const f = async (url) => { calls.push(url); return { status: statusFor ? statusFor(url) : 201 }; }; f.calls = calls; return f; }
/* vapidJwt 는 WebCrypto 로 서명한다 — 가짜 키로는 실패하니 여기서는 실제 키 하나를 만들어 쓴다 */
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
PUSH.privateJwk = JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey));
await t('알림 구독 — 학생은 토큰으로, 가족은 링크 토큰으로; 키가 없으면 no-vapid', async () => {
  const store = memStore(); seed(store);
  assert.deepEqual((await call(store, { path: '/api/letter/push/key' })).body, { ok: false, reason: 'no-vapid' });
  assert.deepEqual((await call(store, { path: '/api/letter/push/key', push: PUSH })).body, { ok: true, key: 'BPUB' });
  const sub = { subscription: { endpoint: 'https://push.example/abc', keys: { p256dh: 'x', auth: 'y' } } };
  assert.equal((await call(store, { path: '/api/letter/push/subscribe', method: 'POST', getBody: async () => sub })).status, 200);
  assert.equal(store.getPush('s:st-1').endpoint, 'https://push.example/abc');
  assert.equal((await call(store, { path: '/api/letter/push/subscribe', method: 'POST', getBody: async () => ({ subscription: { endpoint: 'http://insecure' } }) })).status, 400);
  const fam = 'q'.repeat(32);
  assert.deepEqual((await call(store, { who: null, path: '/api/letter/parent/push/key', query: Q('t=' + fam), push: PUSH })).body, { ok: true, key: 'BPUB' });
  assert.equal((await call(store, { who: null, path: '/api/letter/parent/push/key', query: Q('t=' + 'z'.repeat(32)) })).status, 404);
  assert.equal((await call(store, { who: null, path: '/api/letter/parent/push/subscribe', method: 'POST', query: Q('t=' + fam), getBody: async () => sub })).status, 200);
  assert.equal(store.getPush('f:' + fam).endpoint, 'https://push.example/abc');
  assert.equal((await call(store, { who: null, path: '/api/letter/parent/push/unsubscribe', method: 'POST', query: Q('t=' + fam), getBody: async () => ({}) })).status, 200);
  assert.equal(store.getPush('f:' + fam), null);
  assert.equal((await call(store, { path: '/api/letter/push/unsubscribe', method: 'POST', getBody: async () => ({}) })).status, 200);
  assert.equal(store.getPush('s:st-1'), null);
  const st = await call(store, { who: ADMIN, path: '/api/letter/admin/push/status', push: PUSH });
  assert.deepEqual(st.body, { subscribers: 0, byKind: { student: 0, family: 0 }, vapid: true });
});

await t('발송 — 그 호의 학년대가 있는 가정만, 410 이면 구독 정리, 주인 없는 구독은 지운다', async () => {
  const store = memStore(); seed(store);
  store.putPush('s:st-1', { endpoint: 'https://p/e2' });           // 초3 → E2
  store.putPush('f:' + 'q'.repeat(32), { endpoint: 'https://p/m' }); // 가족 링크 → st-2 중1 → M
  store.putPush('s:ghost', { endpoint: 'https://p/ghost' });
  store.putPush('s:st-3', { endpoint: 'https://p/gone' });          // 7세 → K, 410 응답
  const f = fakePush((u) => (u === 'https://p/gone' ? 410 : 201));
  const r = await sendLetterPushes({ store, push: PUSH, fetchFn: f, issue: SAMPLE, now: NOW });
  assert.deepEqual(r, { sent: 2, skipped: 0, removed: 2, failed: 0 });
  assert.deepEqual(f.calls.sort(), ['https://p/e2', 'https://p/gone', 'https://p/m']);
  assert.equal(store.getPush('s:ghost'), null); assert.equal(store.getPush('s:st-3'), null);
  /* 중등 전용 호 — 초3 가정에는 안 간다 */
  const onlyM = { ...clone(SAMPLE), sections: clone(SAMPLE).sections.filter((s) => Array.isArray(s.tiers) && s.tiers.length === 1 && s.tiers[0] === 'M') };
  const f2 = fakePush();
  assert.deepEqual(await sendLetterPushes({ store, push: PUSH, fetchFn: f2, issue: onlyM, now: NOW }), { sent: 1, skipped: 1, removed: 0, failed: 0 });
  assert.deepEqual(f2.calls, ['https://p/m']);
  assert.equal((await sendLetterPushes({ store, push: {}, fetchFn: f2, issue: SAMPLE })).reason, 'no-vapid');
});

await t('발행 즉시 알림 — 지금 보이는 호를 처음 발행할 때 한 번만; 예약 발행분은 07시 크론이; 다시 보내기·no-vapid', async () => {
  const store = memStore(); seed(store, { issue: false });
  store.putPush('s:st-1', { endpoint: 'https://p/e2' });
  const admin = (over) => call(store, { who: ADMIN, push: PUSH, ...over });
  const f = fakePush();
  const draft = { ...clone(SAMPLE), status: 'draft' };
  await admin({ path: '/api/letter/admin/issue', method: 'PUT', getBody: async () => ({ issue: draft }) });
  const pub = await admin({ path: '/api/letter/admin/publish', method: 'POST', getBody: async () => ({ id: SAMPLE.id, status: 'published' }), pushFetch: f });
  assert.equal(pub.status, 200); assert.deepEqual(pub.body.push, { sent: 1, skipped: 0, removed: 0, failed: 0 });
  assert.ok(store.getIssue(SAMPLE.id).pushedAt, 'pushedAt 이 남는다');
  const notified = clone(store.getIssue(SAMPLE.id));
  await admin({ path: '/api/letter/admin/issue', method: 'PUT', getBody: async () => ({ issue: { ...notified.issue, title: '발행 후 제목 수정' } }) });
  assert.equal(store.getIssue(SAMPLE.id).pushedAt, notified.pushedAt, '본문 저장은 발송 이력을 보존한다');
  assert.deepEqual(store.getIssue(SAMPLE.id).pushResult, notified.pushResult);
  assert.deepEqual((await pushDueIssues({ store, push: PUSH, fetchFn: f, now: NOW })).pushed, [], '편집 때문에 같은 호를 다시 알리지 않는다');
  const listed = (await admin({ path: '/api/letter/admin/issues' })).body.issues[0];
  assert.equal(listed.pushedAt, notified.pushedAt); assert.deepEqual(listed.pushResult, notified.pushResult, '목록에서도 발송 결과를 확인한다');
  /* 내렸다 다시 올려도 두 번 보내지 않는다 */
  await admin({ path: '/api/letter/admin/publish', method: 'POST', getBody: async () => ({ id: SAMPLE.id, status: 'draft' }) });
  const again = await admin({ path: '/api/letter/admin/publish', method: 'POST', getBody: async () => ({ id: SAMPLE.id, status: 'published' }), pushFetch: f });
  assert.equal(again.body.push, null); assert.equal(f.calls.length, 1);
  /* after 훅이 있으면(워커 waitUntil) 응답은 queued, 발송은 뒤에서 */
  const s2 = memStore(); seed(s2, { issue: false }); s2.putPush('s:st-1', { endpoint: 'https://p/e2' });
  await call(s2, { who: ADMIN, path: '/api/letter/admin/issue', method: 'PUT', getBody: async () => ({ issue: draft }) });
  const pending = [];
  const f2 = fakePush();
  const q2 = await call(s2, { who: ADMIN, push: PUSH, pushFetch: f2, after: (pr) => pending.push(pr), path: '/api/letter/admin/publish', method: 'POST', getBody: async () => ({ id: SAMPLE.id, status: 'published' }) });
  assert.deepEqual(q2.body.push, { queued: true }); assert.equal(pending.length, 1);
  await Promise.all(pending); assert.equal(f2.calls.length, 1); assert.ok(s2.getIssue(SAMPLE.id).pushedAt);
  /* 예약 발행 — 발행일이 미래면 지금 안 보내고, 그날 크론이 보낸다 */
  const s3 = memStore(); seed(s3, { issue: false }); s3.putPush('s:st-1', { endpoint: 'https://p/e2' });
  await call(s3, { who: ADMIN, path: '/api/letter/admin/issue', method: 'PUT', getBody: async () => ({ issue: draft }) });
  const f3 = fakePush();
  const fut = await call(s3, { who: ADMIN, push: PUSH, pushFetch: f3, path: '/api/letter/admin/publish', method: 'POST', getBody: async () => ({ id: SAMPLE.id, status: 'published', publishAt: '2026-09-28' }) });
  assert.equal(fut.body.push, null); assert.equal(f3.calls.length, 0);
  assert.deepEqual((await pushDueIssues({ store: s3, push: PUSH, fetchFn: f3, now: NOW })).pushed, [], '아직 발행일 전');
  const due = await pushDueIssues({ store: s3, push: PUSH, fetchFn: f3, now: Date.parse('2026-09-27T22:30:00Z') });   // 9/28 07:30 KST
  assert.deepEqual(due.pushed, [{ id: SAMPLE.id, sent: 1, skipped: 0, removed: 0, failed: 0 }]);
  assert.deepEqual((await pushDueIssues({ store: s3, push: PUSH, fetchFn: f3, now: Date.parse('2026-09-28T22:30:00Z') })).pushed, [], '다음 날 다시 안 보낸다');
  assert.equal((await pushDueIssues({ store: s3, push: {}, fetchFn: f3, now: NOW })).reason, 'no-vapid');
  /* 다시 보내기 */
  const re = await admin({ path: '/api/letter/admin/push', method: 'POST', getBody: async () => ({ id: SAMPLE.id }), pushFetch: f });
  assert.equal(re.status, 200); assert.equal(re.body.sent, 1); assert.equal(f.calls.length, 2);
  assert.equal((await call(s3, { who: ADMIN, push: PUSH, pushFetch: f3, path: '/api/letter/admin/push', method: 'POST', getBody: async () => ({ id: SAMPLE.id }), now: NOW })).status, 409, '발행일 전에는 못 보낸다');
  assert.deepEqual((await admin({ path: '/api/letter/admin/push', method: 'POST', getBody: async () => ({ id: SAMPLE.id }), push: {} })).body, { ok: false, reason: 'no-vapid' });
});

await t('알림 키가 없어도 즉시 발행은 저장된다 — 로컬과 after 훅 모두', async () => {
  for (const queued of [false, true]) {
    const store = memStore(); seed(store, { issue: false });
    store.putIssue(SAMPLE.id, { issue: { ...clone(SAMPLE), status: 'draft' } }); store.putIssueIds([SAMPLE.id]);
    const pending = [];
    const r = await call(store, { who: ADMIN, path: '/api/letter/admin/publish', method: 'POST', push: {},
      getBody: async () => ({ id: SAMPLE.id, status: 'published' }), ...(queued ? { after: (pr) => pending.push(pr) } : {}) });
    assert.equal(r.status, 200); assert.equal(r.body.status, 'published');
    assert.equal(store.getIssue(SAMPLE.id).issue.status, 'published', '응답 전에 발행이 저장된다');
    await Promise.all(pending);
    assert.equal(store.getIssue(SAMPLE.id).pushedAt, undefined, '키 없는 호출을 발송 완료로 기록하지 않는다');
    assert.equal((await call(store, { path: '/api/letter/issues' })).body.issues.length, 1);
  }
});

await t('KV 초당 1회 제한 — 저장 직후 발행과 after 결과를 재시도하고 대기 중 편집을 보존한다', async () => {
  for (const queued of [false, true]) {
    const store = memStore(); seed(store, { issue: false });
    store.putPush('s:st-1', { endpoint: 'https://p/e2' });
    const put = store.putIssue;
    let lastWrite = -Infinity, limited = 0;
    store.putIssue = (id, rec) => {
      const time = Date.now();
      if (time - lastWrite < 1000) {
        limited += 1;
        if (queued && rec.pushResult) {
          const current = store.getIssue(id);
          put(id, { ...current, issue: { ...current.issue, title: '재시도 대기 중 수정', status: 'draft' } });
        }
        throw new Error('KV PUT failed: 429 Too Many Requests');
      }
      lastWrite = time; put(id, rec);
    };
    await call(store, { who: ADMIN, path: '/api/letter/admin/issue', method: 'PUT', getBody: async () => ({ issue: { ...clone(SAMPLE), status: 'draft' } }) });
    const pending = [], f = fakePush();
    const r = await call(store, { who: ADMIN, path: '/api/letter/admin/publish', method: 'POST', push: PUSH, pushFetch: f,
      getBody: async () => ({ id: SAMPLE.id, status: 'published' }), ...(queued ? { after: (pr) => pending.push(pr) } : {}) });
    assert.equal(r.status, 200); assert.equal(r.body.status, 'published');
    await Promise.all(pending);
    const saved = store.getIssue(SAMPLE.id);
    assert.equal(limited, 2, '저장→발행과 발행→결과 저장 모두 제한을 거쳤다');
    assert.equal(f.calls.length, 1, '저장 재시도가 푸시를 다시 보내지는 않는다');
    assert.ok(saved.pushedAt); assert.equal(saved.pushResult.sent, 1);
    assert.equal(saved.issue.status, queued ? 'draft' : 'published');
    if (queued) assert.equal(saved.issue.title, '재시도 대기 중 수정');
  }
  for (const message of ['KV PUT failed: 429 Too Many Requests', 'KV PUT failed: 500 Internal Server Error']) {
    const store = memStore(); let attempts = 0;
    store.putIssue = () => { attempts += 1; throw new Error(message); };
    await assert.rejects(call(store, { who: ADMIN, path: '/api/letter/admin/issue', method: 'PUT', getBody: async () => ({ issue: clone(SAMPLE) }) }), (error) => error.message === message);
    assert.equal(attempts, message.includes('429') ? 2 : 1, '429만 한 번 재시도하고 나머지 오류는 그대로 전달한다');
  }
});

await t('알림 429·503·통신 오류는 실패로 표시하고 기존 다시 보내기로 재발송한다', async () => {
  for (const status of [429, 503, 'network']) {
    const store = memStore(); seed(store);
    store.putPush('s:st-1', { endpoint: 'https://p/e2' });
    const failed = async () => { if (status === 'network') throw new Error('offline'); return { status }; };
    const r = await pushDueIssues({ store, push: PUSH, fetchFn: failed, now: NOW });
    assert.equal(r.pushed[0].sent, 0); assert.equal(r.pushed[0].failed, 1);
    assert.ok(store.getPush('s:st-1'), '일시 실패 구독은 삭제하지 않는다');
    const list = await call(store, { who: ADMIN, path: '/api/letter/admin/issues' });
    assert.equal(list.body.issues[0].pushResult.failed, 1);
    const retry = await call(store, { who: ADMIN, path: '/api/letter/admin/push', method: 'POST', getBody: async () => ({ id: SAMPLE.id }), push: PUSH, pushFetch: fakePush() });
    assert.equal(retry.body.sent, 1); assert.equal(retry.body.failed, 0);
  }
});

await t('알림이 끝나기 전에 수정·내린 본문을 발송 결과 저장이 덮지 않는다', async () => {
  const store = memStore(); seed(store);
  store.putPush('s:st-1', { endpoint: 'https://p/e2' });
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const pending = [];
  await call(store, { who: ADMIN, path: '/api/letter/admin/publish', method: 'POST', getBody: async () => ({ id: SAMPLE.id, status: 'published' }),
    push: PUSH, pushFetch: async () => { await gate; return { status: 201 }; }, after: (pr) => pending.push(pr) });
  await call(store, { who: ADMIN, path: '/api/letter/admin/issue', method: 'PUT', getBody: async () => ({ issue: { ...clone(SAMPLE), title: '발송 중 수정', status: 'draft' } }) });
  release(); await Promise.all(pending);
  assert.equal(store.getIssue(SAMPLE.id).issue.title, '발송 중 수정');
  assert.equal(store.getIssue(SAMPLE.id).issue.status, 'draft');
  assert.equal(store.getIssue(SAMPLE.id).pushResult.sent, 1);
});

/* ── 주제 달력 ── */
await t('주제 달력 — 기본값은 배포본, 저장하면 KV 가 이긴다, 검증 실패는 400; AI 초안이 주제·지표를 달력에서 가져온다', async () => {
  const store = memStore(); seed(store);
  const admin = (over) => call(store, { who: ADMIN, ...over });
  const g0 = await admin({ path: '/api/letter/admin/calendar' });
  assert.equal(g0.body.source, 'default'); assert.ok(g0.body.calendar.weeks['2026-W40'].theme); assert.deepEqual(g0.body.rotation, L.rotationFor(L.weekId(NOW)));
  const bad = await admin({ path: '/api/letter/admin/calendar', method: 'PUT', getBody: async () => ({ calendar: { weeks: { 'W1': { theme: 'x' } } } }) });
  assert.equal(bad.status, 400); assert.ok(bad.body.errors.length);
  const ok = await admin({ path: '/api/letter/admin/calendar', method: 'PUT', getBody: async () => ({ calendar: { version: 1, weeks: { '2026-W40': { theme: '가을 곤충의 겨울나기', notes: '10월 3일 휴원', indices: { E2: 'VSI' } } } } }) });
  assert.equal(ok.status, 200);
  const g1 = await admin({ path: '/api/letter/admin/calendar' });
  assert.equal(g1.body.source, 'kv'); assert.equal(g1.body.calendar.weeks['2026-W40'].theme, '가을 곤충의 겨울나기');
  assert.equal((await call(store, { path: '/api/letter/admin/calendar' })).status, 403);
  /* AI 초안 — theme 을 비우면 달력 주제, 지표는 달력 지정 > 순환 */
  const parts = SAMPLE_PARTS();
  const f = fakeFetch({ text: JSON.stringify(parts.E2) });
  const r = await admin({ path: '/api/letter/admin/draft', method: 'POST', getBody: async () => ({ part: 'E2', week: '2026-W40' }), ai: { apiKey: 'k', env: {}, fetchImpl: f } });
  assert.equal(r.body.ok, true);
  const user = f.calls[0].body.messages[0].content;
  assert.ok(/가을 곤충의 겨울나기/.test(user) && /VSI/.test(user) && /달력 메모: 10월 3일 휴원/.test(user), user.slice(0, 300));
  /* 저장본은 배포본 기본값을 통째로 대신한다 — 저장본에 없는 주차(W41)는 주제가 없다 */
  const f2 = fakeFetch({ text: JSON.stringify(parts.K) });
  assert.equal((await admin({ path: '/api/letter/admin/draft', method: 'POST', getBody: async () => ({ part: 'K', week: '2026-W41' }), ai: { apiKey: 'k', env: {}, fetchImpl: f2 } })).status, 400, '저장본에 없는 주차');
  await admin({ path: '/api/letter/admin/draft', method: 'POST', getBody: async () => ({ part: 'K', week: '2026-W40' }), ai: { apiKey: 'k', env: {}, fetchImpl: f2 } });
  assert.ok(new RegExp('지표: ' + L.rotationFor('2026-W40').K).test(f2.calls[0].body.messages[0].content), '달력에 그 학년대 지표 지정이 없으면 순환값');
  const none = await admin({ path: '/api/letter/admin/draft', method: 'POST', getBody: async () => ({ part: 'K', week: '2031-W10' }), ai: { apiKey: 'k', env: {}, fetchImpl: f2 } });
  assert.equal(none.status, 400, '달력에도 없는 주차면 주제가 필요하다');
});


await t('가족 링크 기록 — 링크 토큰으로 GET/PUT, 학생 코드 자리에 저장돼 열람 현황의 요일 진행에 잡힌다', async () => {
  const store = memStore(); seed(store);
  const fam = (over) => call(store, { who: null, query: Q('t=' + 'q'.repeat(32)), ...over });
  const g0 = await fam({ path: '/api/letter/parent/state' });
  assert.equal(g0.status, 200); assert.deepEqual(g0.body, { state: { v: 1, issues: {} }, updatedAt: null });
  const r1 = await fam({ path: '/api/letter/parent/state', method: 'PUT', getBody: async () => ({ state: { issues: { [SAMPLE.id]: { openedAt: 'x', days: { 1: '2026-09-21T01:00:00Z', 2: '2026-09-22T01:00:00Z' }, trace: { words: 2 }, quiz: { 'read-m:0': 0 }, write: { 'write-m:0': '두 가설은 <원인>이 다르다' } } } } }) });
  assert.equal(r1.status, 200); assert.ok(r1.body.updatedAt);
  assert.deepEqual(store.getState('st-2').state.issues[SAMPLE.id].days, { 1: '2026-09-21T01:00:00Z', 2: '2026-09-22T01:00:00Z' }, '학생 코드(st-2) 자리에 저장');
  const g1 = await fam({ path: '/api/letter/parent/state' });
  assert.equal(g1.body.state.issues[SAMPLE.id].trace.words, 2);
  assert.equal((await fam({ path: '/api/letter/parent/state', method: 'PUT', getBody: async () => ({ state: 'x' }) })).status, 400);
  assert.equal((await call(store, { who: null, query: Q('t=' + 'z'.repeat(32)), path: '/api/letter/parent/state' })).status, 404, '모르는 토큰');
  assert.equal((await call(store, { who: null, query: Q(''), path: '/api/letter/parent/state', method: 'PUT', getBody: async () => ({ state: {} }) })).status, 404, '토큰 없이는 못 쓴다');
  /* 열람 현황 — 가족 링크로 올라온 기록도 요일 7칸으로 보인다 */
  const stats = await call(store, { who: ADMIN, path: '/api/letter/admin/stats', query: Q('id=' + SAMPLE.id) });
  const pr = stats.body.stats.progress.find((r) => r.code === 'st-2');
  assert.deepEqual(pr.days, [true, true, false, false, false, false, false]); assert.equal(pr.done, false); assert.equal(pr.tier, 'M'); assert.equal(pr.writes, 1);
  assert.deepEqual(stats.body.stats.writes, [{ code: 'st-2', name: '이중등', tier: 'M', key: 'write-m:0', text: '두 가설은 <원인>이 다르다' }], '원장이 독자의 답을 고를 목록');
  assert.equal(stats.body.stats.byTier.M.days, 2);
  assert.ok(!stats.body.stats.unopened.some((u) => u.code === 'st-2'));
});

await t('AI 초안 — 교육·입시 이슈 조각은 웹 검색 도구를 켜고, 주제 없이도 돌며, 검색 블록이 섞인 응답에서 JSON 을 찾는다', async () => {
  const store = memStore(); seed(store);
  const admin = (over) => call(store, { who: ADMIN, ...over });
  const parts = SAMPLE_PARTS();
  assert.equal(parts.news.sections.length, 1);
  const raw = { model: 'claude-opus-5', stop_reason: 'end_turn', content: [
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: '교육부 보도자료' } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://example.org/a', title: 'a', encrypted_content: 'x', page_age: null }] },
    { type: 'text', text: '이번 주 소식입니다.\n' },
    { type: 'text', text: JSON.stringify(parts.news), citations: [{ type: 'web_search_result_location', url: 'https://example.org/a', title: 'a', cited_text: 'x', encrypted_index: 'y' }] },
  ] };
  const f = fakeFetch({ raw });
  const r = await admin({ path: '/api/letter/admin/draft', method: 'POST', getBody: async () => ({ part: 'news', theme: '', week: '2031-W10' }), ai: { apiKey: 'k', env: {}, fetchImpl: f } });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.ok, true); assert.equal(r.body.part, 'news');
  assert.deepEqual(r.body.sections.map((s) => s.type), ['news']); assert.deepEqual(r.body.errors, []);
  const c = f.calls[0];
  assert.equal(c.body.tools.length, 1); assert.equal(c.body.tools[0].type, 'web_search_20250305'); assert.equal(c.body.tools[0].user_location.country, 'KR'); assert.ok(c.body.tools[0].max_uses <= 6);
  assert.ok(/최근 7일/.test(c.body.messages[0].content) && /교육부/.test(c.body.messages[0].content) && /https/.test(c.body.messages[0].content));
  assert.ok(/news\) 조각은 웹 검색 결과를 간추린다/.test(c.body.system), '창작 규칙의 예외가 시스템 프롬프트에 적혀 있다');
  /* 다른 조각은 검색을 켜지 않는다 */
  const f2 = fakeFetch({ text: JSON.stringify(parts.E2) });
  await admin({ path: '/api/letter/admin/draft', method: 'POST', getBody: async () => ({ part: 'E2', theme: 'x', week: '2026-W40', brainIndex: 'WMI' }), ai: { apiKey: 'k', env: {}, fetchImpl: f2 } });
  assert.equal(f2.calls[0].body.tools, undefined);
  /* 검색이 길어져 멈춘 응답(pause_turn)에 JSON 이 없으면 사유를 남긴다 */
  const f3 = fakeFetch({ raw: { model: 'm', stop_reason: 'pause_turn', content: [{ type: 'text', text: '검색 중' }] } });
  const r3 = await admin({ path: '/api/letter/admin/draft', method: 'POST', getBody: async () => ({ part: 'news', week: '2026-W40' }), ai: { apiKey: 'k', env: {}, fetchImpl: f3 } });
  assert.equal(r3.body.ok, false); assert.equal(r3.body.reason, 'paused');
});

console.log(`\nOK — ${passed}개 통과`);
