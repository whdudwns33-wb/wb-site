'use strict';
/* 브레인레터 서버 라우트 검증 (node reading-server/letter-api.test.mjs) — 실제 API 를 부르지 않는다(fetch 를 갈아 끼운다) */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { handleLetter, normalizeState, familyMessage, dropStudentLetter, dumpLetter, tierFor, letterBodyLimit, readLetterAiLimit,
  draftUserPrompt, SAMPLE_PARTS, ISSUE_BODY_LIMIT, STATE_BODY_LIMIT, PUTS_PER_DAY, LETTER_AI_DAILY_DEFAULT, DEFAULT_TIER } from './letter-api.mjs';
const require = createRequire(import.meta.url);
const SAMPLE = require('../letter/issue-sample.json');
const L = require('../letter/letter.js');
let passed = 0;
const t = async (name, fn) => { await fn(); passed += 1; console.log('  ✓ ' + name); };
const clone = (v) => JSON.parse(JSON.stringify(v));

/* 메모리 어댑터 — 워커 KV(letter: 접두)·로컬 db.letter 와 같은 계약 */
function memStore() {
  const issues = {}, states = {}, students = {}, parents = {};
  let ids = null, aiUse = null;
  return {
    getIssue: (id) => issues[id] || null, putIssue: (id, rec) => { issues[id] = rec; }, deleteIssue: (id) => { delete issues[id]; },
    getIssueIds: () => ids, putIssueIds: (x) => { ids = x; },
    getState: (c) => states[c] || null, putState: (c, rec) => { states[c] = rec; }, deleteState: (c) => { delete states[c]; }, listStateCodes: () => Object.keys(states),
    getStudent: (c) => students[c] || null, putStudent: (c, rec) => { students[c] = rec; }, listStudentCodes: () => Object.keys(students),
    getParentCode: (tk) => parents[tk] || null, putParent: (tk, c) => { parents[tk] = c; },
    getAiUse: () => aiUse, putAiUse: (rec) => { aiUse = rec; },
    _raw: { issues, states, students, parents },
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
  assert.equal(letterBodyLimit('/api/letter/admin/issue'), ISSUE_BODY_LIMIT); assert.equal(letterBodyLimit('/api/letter/state'), STATE_BODY_LIMIT);
  assert.equal(readLetterAiLimit({}).total, LETTER_AI_DAILY_DEFAULT); assert.equal(readLetterAiLimit({ LETTER_AI_DAILY: '5' }).total, 5);
});

await t('학생 목록·호 — 발행된 호만, 자기 학년대 섹션만, 발행일 전이면 404', async () => {
  const store = memStore(); seed(store);
  const list = await call(store, { path: '/api/letter/issues' });
  assert.equal(list.status, 200); assert.equal(list.body.tier, 'E2'); assert.equal(list.body.issues.length, 1); assert.equal(list.body.issues[0].id, SAMPLE.id);
  assert.equal(typeof list.body.issues[0].sections, 'number', '목록은 요약(brief)만 — 섹션은 개수'); assert.ok(list.body.issues[0].title);
  const one = await call(store, { path: '/api/letter/issue', query: Q('id=' + SAMPLE.id) });
  assert.equal(one.status, 200);
  assert.deepEqual(one.body.issue.sections.map((s) => s.id), ['read-e2', 'words', 'brain-e2', 'mission', 'column', 'coach-e2', 'notice']);
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
  assert.deepEqual(n, { v: 1, issues: { '2026-W39': { openedAt: '2026-09-22T01:00:00Z', doneAt: '', quiz: { 'read-e2:0': 1 }, reveal: { 'brain-e2:0': true }, checks: { 'mission:0': true } } } });
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
  assert.deepEqual(stats.body.stats.byTier.E2, { total: 1, opened: 1, done: 1 });
  assert.deepEqual(stats.body.stats.byTier.M, { total: 1, opened: 0, done: 0 });
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
  assert.equal((await admin({ path: '/api/letter/admin/draft', method: 'POST', getBody: async () => ({ ...body, theme: ' ' }) })).status, 400);
  /* 정상 — 샘플의 E2 조각을 그대로 돌려주는 가짜 모델 */
  const parts = SAMPLE_PARTS();
  const f = fakeFetch({ text: '```json\n' + JSON.stringify(parts.E2) + '\n```' });
  const ok = await admin({ path: '/api/letter/admin/draft', method: 'POST', getBody: async () => body, ai: { apiKey: 'k', env: {}, fetchImpl: f } });
  assert.equal(ok.status, 200); assert.equal(ok.body.ok, true); assert.equal(ok.body.part, 'E2');
  assert.deepEqual(ok.body.sections.map((s) => s.id), ['read-e2', 'brain-e2', 'coach-e2']);
  assert.deepEqual(ok.body.errors, []); assert.equal(ok.body.aiLeft, LETTER_AI_DAILY_DEFAULT - 1); assert.equal(ok.body.aiCap, LETTER_AI_DAILY_DEFAULT);
  assert.equal(store.getAiUse().count, 1, '장부에 남는다');
  const c = f.calls[0];
  assert.equal(c.headers['x-api-key'], 'k'); assert.equal(c.headers['anthropic-version'], '2023-06-01'); assert.equal(c.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(c.body.model, 'claude-opus-5'); assert.equal(c.body.fallbacks, 'default'); assert.ok(c.body.max_tokens >= 8000);
  const user = c.body.messages[0].content;
  assert.ok(/가을 곤충의 겨울나기/.test(user) && /2026-W40/.test(user) && /WMI/.test(user) && /10월 3일 휴원/.test(user) && /read-e2/.test(user));
  assert.ok(/자체 창작|창작/.test(c.body.system) && /K-WISC-V/.test(c.body.system));
  /* 공통 조각은 head 를 같이 돌려준다 */
  const fs2 = fakeFetch({ text: JSON.stringify(parts.shared) });
  const sh = await admin({ path: '/api/letter/admin/draft', method: 'POST', getBody: async () => ({ ...body, part: 'shared', brainIndex: { K: 'PSI' } }), ai: { apiKey: 'k', env: {}, fetchImpl: fs2 } });
  assert.equal(sh.body.ok, true); assert.equal(sh.body.head.title, SAMPLE.title); assert.deepEqual(sh.body.sections.map((s) => s.id).sort(), ['column', 'mission', 'notice', 'words']);
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
  await dropStudentLetter(store, 'st-1');
  assert.equal(store.getState('st-1'), null); assert.ok(store.getIssue(SAMPLE.id));
  store.putState('st-2', { state: { v: 1, issues: {} }, updatedAt: 'y' });
  const d = await dumpLetter(store);
  assert.deepEqual(Object.keys(d.issues), [SAMPLE.id]); assert.equal(d.issues[SAMPLE.id].issue.title, SAMPLE.title);
  assert.deepEqual(Object.keys(d.states), ['st-2']);
  assert.equal((await call(store, { who: ADMIN, path: '/api/letter/nope' })).status, 404);
});

console.log(`\nOK — ${passed}개 통과`);
