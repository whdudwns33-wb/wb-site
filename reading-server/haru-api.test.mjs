'use strict';
/* 하루브레인 서버 라우트 검증 (node reading-server/haru-api.test.mjs) */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { handleHaru, allowedApp, appOfPath, normalizeSummary, haruBodyLimit, BODY_LIMIT_PACK, BODY_LIMIT_STATE, PUTS_PER_DAY, dropStudentHaru } from './haru-api.mjs';
import { paperKeyFrom } from '../haru/sheet-build.mjs';
const require = createRequire(import.meta.url);
const ATOMS = require('../haru/atoms.json');
const PLAN = require('../haru/plans/2027-pilot.json');
const SAMPLE = require('../haru/pack-sample.json');
let passed = 0;
const t = async (name, fn) => { await fn(); passed += 1; console.log('  ✓ ' + name); };

/* 메모리 어댑터 — 워커 KV(haru: 접두)·로컬 db.haru 와 같은 계약 */
function memStore() {
  const packs = {}, keys = {}, plans = {}, states = {}, mocks = {}, paper = {}, parents = {}, dists = {}, reports = {}, students = {};
  let packIds = null, keyIds = null, planIds = null, atoms = null;
  return {
    getPack: (id) => packs[id] || null, putPack: (id, rec) => { packs[id] = rec; }, deletePack: (id) => { delete packs[id]; }, getPackIds: () => packIds, putPackIds: (ids) => { packIds = ids; },
    getPaperKey: (id) => keys[id] || null, putPaperKey: (id, rec) => { keys[id] = rec; }, getPaperKeyIds: () => keyIds, putPaperKeyIds: (ids) => { keyIds = ids; },
    getPlan: (c) => plans[c] || null, putPlan: (c, rec) => { plans[c] = rec; }, deletePlan: (c) => { delete plans[c]; }, getPlanIds: () => planIds, putPlanIds: (ids) => { planIds = ids; },
    getAtoms: () => atoms, putAtoms: (rec) => { atoms = rec; },
    getState: (c) => states[c] || null, putState: (c, rec) => { states[c] = rec; }, deleteState: (c) => { delete states[c]; }, listStateCodes: () => Object.keys(states),
    getMock: (c) => mocks[c] || null, putMock: (c, rec) => { mocks[c] = rec; }, deleteMock: (c) => { delete mocks[c]; },
    getPaper: (c) => paper[c] || null, putPaper: (c, rec) => { paper[c] = rec; }, deletePaper: (c) => { delete paper[c]; },
    getParent: (tk) => parents[tk] || null, putParent: (tk, rec) => { parents[tk] = rec; }, deleteParent: (tk) => { delete parents[tk]; },
    getDist: (c, k) => dists[c + ':' + k] || null, putDist: (c, k, rec) => { dists[c + ':' + k] = rec; },
    getReports: (id) => reports[id] || null, putReports: (id, list) => { reports[id] = list; },
    getStudent: (c) => students[c] || null, putStudent: (c, rec) => { students[c] = rec; }, listStudentCodes: () => Object.keys(students),
    _raw: { packs, keys, plans, states, mocks, paper, parents, dists, reports, students },
  };
}
const NOW = Date.parse('2026-09-16T01:00:00Z');   // 9/16 10:00 KST · D-39
const ADMIN = { code: '__admin__', admin: true };
const STU = { code: 'st-1', admin: false };
const call = (store, over) => handleHaru({ path: '/api/haru/state', method: 'GET', who: STU, query: new URLSearchParams(), getBody: async () => ({}), store, now: NOW,
  atomsFallback: async () => ATOMS, randomToken: () => 'a'.repeat(32), ...over });
const Q = (s) => new URLSearchParams(s);
function seed(store, opts = {}) {
  store.putStudent('st-1', { code: 'st-1', name: '김하루', grade: '초6', cls: '삼육A', apps: ['haru'], cohort: '2027-pilot', consent: opts.consent === false ? null : { at: '2026-09-10', via: 'paper' }, expiresAt: opts.expiresAt || '2026-11-24' });
  if (opts.plan !== false) { store.putPlan('2027-pilot', { plan: PLAN, updatedAt: 'x' }); store.putPlanIds(['2027-pilot']); }
  if (opts.pack !== false) { store.putPack(SAMPLE.packId, { pack: SAMPLE, updatedAt: 'x' }); store.putPackIds([SAMPLE.packId]); }
}
/* 3교시 대응표 — 국어는 체험 팩에서, 수학·영어는 최소 자작 대응표 */
const KOR = paperKeyFrom(SAMPLE, 'own-mock-t-kor', { frozen: true, label: '테스트 국어' });
const mini = (id, subject) => ({ id, label: id, subject, n: 4, timeLimitSec: 2400, origin: 'own', holder: 'academy', frozen: false,
  sets: { q1: [1], q2: [2], q3: [3], q4: [4] }, map: { 1: subject === 'math' ? 'm-ratio-base' : 'e-vocab-300', 2: subject === 'math' ? 'm-frac-div' : 'e-form-26', 3: subject === 'math' ? 'm-unit-vol' : 'e-3sg-past', 4: subject === 'math' ? 'm-avg-inverse' : 'e-read-skip' }, answer: { 1: '1', 2: '2', 3: '3', 4: '4' } });
function seedKeys(store) {
  store.putPaperKey(KOR.id, { key: KOR, updatedAt: 'x' }); store.putPaperKey('own-mock-t-math', { key: mini('own-mock-t-math', 'math'), updatedAt: 'x' }); store.putPaperKey('own-mock-t-eng', { key: mini('own-mock-t-eng', 'eng'), updatedAt: 'x' });
  store.putPaperKeyIds([KOR.id, 'own-mock-t-math', 'own-mock-t-eng']);
}
const period = (subject, keyId, marks, t0) => ({ subject, keyId, marks, openedAt: t0, closedAt: t0 + 30 * 60e3,
  events: Object.keys(marks).map((no, i) => ({ type: 'mark', no: +no, key: marks[no], at: t0 + (i + 1) * 60e3 })) });

await t('인증 없으면 401 — 팩·오늘 카드·기록 어느 것도 내용이 나가지 않는다', async () => {
  const store = memStore(); seed(store);
  for (const path of ['/api/haru/pack', '/api/haru/today', '/api/haru/state', '/api/haru/gen', '/api/haru/admin/board']) {
    const r = await call(store, { who: null, path, query: Q('id=' + SAMPLE.packId + '&atomId=m-ratio-base') });
    assert.equal(r.status, 401, path); assert.equal(r.body.pack, undefined); assert.equal(r.body.item, undefined);
  }
});
await t('보호자 동의 없는 코드는 403 — 만료 뒤에는 회고·플랜만 열린다', async () => {
  const store = memStore(); seed(store, { consent: false });
  assert.equal((await call(store, { path: '/api/haru/today' })).status, 403);
  const s2 = memStore(); seed(s2, { expiresAt: '2026-09-01' });
  assert.equal((await call(s2, { path: '/api/haru/today' })).status, 403);
  assert.equal((await call(s2, { path: '/api/haru/retro' })).status, 200);
  assert.equal((await call(s2, { path: '/api/haru/plan' })).status, 200);
});
await t('apps 게이트 헬퍼 — apps null 은 재원생(전부), 배열은 그 목록만', () => {
  assert.equal(allowedApp({ apps: null }, 'reading'), true);
  assert.equal(allowedApp({ apps: ['haru'] }, 'reading'), false);
  assert.equal(allowedApp({ apps: ['haru'] }, 'haru'), true);
  assert.equal(allowedApp(null, 'haru'), false);
  assert.equal(appOfPath('/api/pull'), 'reading'); assert.equal(appOfPath('/api/haru/today'), 'haru'); assert.equal(appOfPath('/api/naesin/pack'), 'naesin');
  assert.equal(haruBodyLimit('/api/haru/admin/pack'), BODY_LIMIT_PACK); assert.equal(haruBodyLimit('/api/haru/state'), BODY_LIMIT_STATE);
});
await t('플랜 — 오늘±3일·학생용 마일스톤만(aud parent 제외)·잠금·D-day', async () => {
  const store = memStore(); seed(store);
  const r = await call(store, { path: '/api/haru/plan' });
  assert.equal(r.status, 200); assert.equal(r.body.plan.dday, 39); assert.equal(r.body.plan.locked, false);
  assert.ok(r.body.plan.days.length <= 7 && r.body.plan.days.every((d) => Math.abs(Date.parse(d.d) - Date.parse('2026-09-16')) <= 3 * 86400e3));
  assert.ok(r.body.plan.milestones.every((m) => !/서류|원서|수험표|발표/.test(m.text)), '부모용 마일스톤이 학생에게 내려갔다');
  assert.equal((await call(memStore(), { path: '/api/haru/plan', store: (() => { const s = memStore(); seed(s, { plan: false }); return s; })() })).status, 409);
});
await t('오늘 카드 — 공급 있는 코어만 슬롯에, 생성기/팩 출처 표시, 잠금이면 slots 빈 배열', async () => {
  const store = memStore(); seed(store);
  const r = await call(store, { path: '/api/haru/today' });
  assert.equal(r.status, 200);
  assert.ok(r.body.today.slots.length >= 1, JSON.stringify(r.body.today));
  r.body.today.slots.forEach((s) => { assert.ok(['gen', 'pack'].includes(s.source)); assert.ok(!/구멍|오답/.test(s.label + s.why)); });
  assert.ok(!r.body.today.slots.some((s) => s.atomId === 'e-vocab-300'), '공급 없는 영어 원자가 슬롯에 올랐다');
  const locked = await call(store, { path: '/api/haru/today', now: Date.parse('2026-10-25T04:00:00Z') });
  assert.deepEqual(locked.body.today.slots, []);
});
await t('생성기 문항 — 정답·해설·오답 태그 0회, 같은 seed 로 채점, 오답이면 원인', async () => {
  const store = memStore(); seed(store);
  const g = await call(store, { path: '/api/haru/gen', query: Q('atomId=m-ratio-base&seed=7') });
  assert.equal(g.status, 200);
  const txt = JSON.stringify(g.body);
  ['answerKey', 'explanationKo', 'errKind', 'answerValue', 'params', '"atomId":"m-pct'].forEach((k) => assert.ok(!txt.includes(k), k));
  assert.equal(g.body.item.gid, 'g:m-ratio-base:7'); assert.equal(g.body.item.choices.length, 4);
  const k = await call(store, { path: '/api/haru/gen', query: Q('atomId=k-word-build&seed=3') });
  assert.equal(k.status, 200); assert.ok(!JSON.stringify(k.body).includes('errKind'));
  /* 정답을 알려면 /answer 뿐 — 서버가 seed 로 다시 만든다 */
  let right = null;
  for (const key of ['1', '2', '3', '4']) { const a = await call(store, { path: '/api/haru/answer', method: 'POST', getBody: async () => ({ gid: 'g:m-ratio-base:7', picked: key, ms: 30000 }) }); if (a.body.result.ok) right = key; else assert.ok(['gap', 'exec', 'confuse', 'misread', 'time'].includes(a.body.result.cause)); }
  assert.ok(right, '네 키 중 하나는 정답이어야 한다');
  const skip = await call(store, { path: '/api/haru/answer', method: 'POST', getBody: async () => ({ gid: 'g:m-ratio-base:7', picked: 'skip', ms: 5000 }) });
  assert.equal(skip.body.result.cause, 'time');
  assert.equal((await call(store, { path: '/api/haru/gen', query: Q('atomId=nope&seed=1') })).status, 404);
});
await t('팩 — 학생에게는 정답 제거본, 배정 밖은 403(존재도 안 알림), 관리자는 원본', async () => {
  const store = memStore(); seed(store);
  const r = await call(store, { path: '/api/haru/pack', query: Q('id=' + SAMPLE.packId) });
  assert.equal(r.status, 200);
  const txt = JSON.stringify(r.body);
  ['answerKey', 'cueSteps', 'explanationKo', 'errKind', 'provenance'].forEach((k) => assert.ok(!txt.includes(k), k));
  store.putPack('other-pack', { pack: { ...SAMPLE, packId: 'other-pack', cohort: ['2028'] }, updatedAt: 'x' });
  assert.equal((await call(store, { path: '/api/haru/pack', query: Q('id=other-pack') })).status, 403);
  assert.equal((await call(store, { path: '/api/haru/pack', query: Q('id=no-such-pack') })).status, 403);
  assert.ok(JSON.stringify((await call(store, { path: '/api/haru/pack', who: ADMIN, query: Q('id=' + SAMPLE.packId) })).body).includes('answerKey'));
  const a = await call(store, { path: '/api/haru/answer', method: 'POST', getBody: async () => ({ packId: SAMPLE.packId, no: 1, picked: '2', ms: 40000 }) });
  assert.equal(a.body.result.ok, true); assert.ok(a.body.result.explanationKo);
  const cue = await call(store, { path: '/api/haru/cue', query: Q('packId=' + SAMPLE.packId + '&no=1') });
  assert.equal(cue.status, 200); assert.ok(cue.body.cue.text);
});
await t('기록 PUT — mocks·paper 키 400, weekly 서버 append, 하루 3회 상한, GET 은 3키 합성', async () => {
  const store = memStore(); seed(store);
  const put = (state, now) => call(store, { path: '/api/haru/state', method: 'PUT', now: now || NOW, getBody: async () => ({ state }) });
  assert.equal((await put({ mocks: [] })).status, 400);
  assert.equal((await put({ paper: [] })).status, 400);
  const r1 = await put({ v: 2, days: { '2026-09-16': { sat: true, min: 14 } }, atoms: { 'm-ratio-base': { a: 6, b: 2, obs: 6, ok: 5, ctx: ['mixed'], seen: {} } }, weekly: [{ w: 'fake' }], summary: { doneDays: 3, gained: { carry: ['x'.repeat(100)] }, evil: '<script>' } });
  assert.equal(r1.status, 200);
  const st = store._raw.states['st-1'].state;
  assert.equal(st.weekly.length, 1); assert.notEqual(st.weekly[0].w, 'fake'); assert.equal(st.weekly[0].byAtom['m-ratio-base'] != null, true);
  assert.equal(st.summary.evil, undefined); assert.equal(st.summary.gained.carry[0].length, 40);
  assert.equal((await put({ v: 2 })).status, 200); assert.equal((await put({ v: 2 })).status, 200);
  assert.equal((await put({ v: 2 })).status, 429, PUTS_PER_DAY + '회 뒤에는 429');
  assert.equal((await put({ v: 2 }, NOW + 86400e3)).status, 200, '다음 날은 다시 열린다');
  store.putMock('st-1', { mocks: [{ keyId: 'own-mock-01', at: '2026-09-13T00:04:00Z', retake: false, bySubject: { kor: { n: 25, ok: 18 } }, blank: 2, pct: 72 }] });
  store.putPaper('st-1', { paper: [{ keyId: 'own-drill', at: '2026-09-14', wrongNos: [3] }] });
  const g = await call(store, { path: '/api/haru/state' });
  assert.equal(g.body.state.mocks.length, 1); assert.equal(g.body.state.mocks[0].bySubject.kor.ok, 18); assert.equal(g.body.state.paper.length, 1);
  assert.ok(!('pct' in g.body.state.mocks[0]), '백분율은 학생에게 내려가지 않는다');
});
await t('답안지 — full 인데 3교시 미만이면 409, 3교시면 채점·skills·blank·sets, 분포 갱신, 동결 세트 두 번째는 retake', async () => {
  const store = memStore(); seed(store); seedKeys(store);
  const T0 = NOW;
  const post = (b) => call(store, { path: '/api/haru/attempt', method: 'POST', getBody: async () => b });
  assert.equal((await post({ kind: 'full', periods: [period('kor', KOR.id, { 1: '2' }, T0)] })).status, 409);
  const korMarks = {}; [1, 2, 3, 4, 5, 6].forEach((no) => { korMarks[no] = KOR.answer[no]; });   // 7번은 무응답
  const r = await post({ kind: 'full', keyId: 'own-mock-t', periods: [period('kor', KOR.id, korMarks, T0), period('math', 'own-mock-t-math', { 1: '1', 2: '2', 3: '3', 4: '1' }, T0 + 41 * 60e3), period('eng', 'own-mock-t-eng', { 1: '1', 2: '2', 3: '3', 4: '4' }, T0 + 82 * 60e3)] });
  assert.equal(r.status, 200); assert.equal(r.body.accepted, true); assert.equal(r.body.retake, false);
  assert.ok(!('score' in r.body) && !('ok' in r.body), '채점 결과는 응답에 없다(다음 날 카드에서)');
  const m = store._raw.mocks['st-1'].mocks[0];
  assert.equal(m.bySubject.kor.ok, 6); assert.equal(m.bySubject.kor.blank, 1); assert.equal(m.blank, 1); assert.equal(m.retake, false);
  assert.ok(m.skills && 'markImmediate' in m.skills); assert.ok(m.sets.some((s) => s.setId === 'p-01'));
  assert.equal(store._raw.dists['2027-pilot:own-mock-t'].n, 1);
  /* 같은 동결 세트 재응시 → retake:true, 분포에는 안 들어간다 */
  const r2 = await post({ kind: 'full', keyId: 'own-mock-t', periods: [period('kor', KOR.id, korMarks, T0 + 7 * 86400e3), period('math', 'own-mock-t-math', {}, T0), period('eng', 'own-mock-t-eng', {}, T0)] });
  assert.equal(r2.body.retake, true);
  assert.equal(store._raw.mocks['st-1'].mocks.length, 2); assert.equal(store._raw.dists['2027-pilot:own-mock-t'].n, 1);
  /* 과목 불일치·미등록 회차 */
  assert.equal((await post({ kind: 'single', periods: [period('math', KOR.id, {}, T0)] })).status, 400);
  assert.equal((await post({ kind: 'single', periods: [period('kor', 'no-such-key', {}, T0)] })).status, 404);
  const sheet = await call(store, { path: '/api/haru/sheet', query: Q('keyId=' + KOR.id) });
  assert.equal(sheet.body.sheet.n, 7); assert.ok(!JSON.stringify(sheet.body).includes('answer'));
});
await t('회고 — 숫자는 시험일+7일 16:00 KST 뒤에만', async () => {
  const store = memStore(); seed(store);
  store.putState('st-1', { state: { days: { '2026-09-16': { sat: true, min: 14 } }, atoms: {} }, updatedAt: 'x' });
  const before = await call(store, { path: '/api/haru/retro', now: Date.parse('2026-11-01T06:59:00Z') });
  assert.equal(before.body.retro.sat, 1); assert.equal(before.body.retro.gained, undefined);
  const after = await call(store, { path: '/api/haru/retro', now: Date.parse('2026-11-01T07:00:00Z') });
  assert.ok(after.body.retro.gained); assert.equal(after.body.retro.gained.minutes, 14);
});
await t('관리 — 등록은 동의일 필수, 팩·대응표는 검증기 통과해야, 종이 회수 두 경로, 플랜 검증', async () => {
  const store = memStore(); seed(store);
  const adm = (r, method, b, qs) => call(store, { path: '/api/haru/admin/' + r, method: method || 'GET', who: ADMIN, getBody: async () => b || {}, query: Q(qs || '') });
  assert.equal((await adm('enroll', 'POST', { code: 'st-9', name: '새학생', cohort: '2027-pilot' })).status, 400);
  const e = await adm('enroll', 'POST', { code: 'st-9', name: '새학생', grade: '초6', cohort: '2027-pilot', consent: { at: '2026-09-15', via: 'paper', guardian: { name: '보호자', rel: '모' } } });
  assert.equal(e.status, 200); assert.deepEqual(e.body.student.apps, ['haru']); assert.equal(e.body.student.expiresAt, '2026-11-24');
  assert.equal((await adm('enroll', 'POST', { code: 'default', name: 'x', cohort: '2027-pilot', consent: { at: '2026-09-15' } })).status, 400);
  const badPack = await adm('pack', 'POST', { pack: { ...SAMPLE, packId: 'bad-pack', origin: 'commercial' } });
  assert.equal(badPack.status, 400); assert.ok(badPack.body.errors.length);
  assert.equal((await adm('pack', 'POST', { pack: { ...SAMPLE, packId: 'good-pack' } })).status, 200);
  assert.ok((await adm('packs')).body.packs.some((p) => p.id === 'good-pack'));
  assert.equal((await adm('paperkey', 'POST', { key: { ...KOR, id: 'cm-x', origin: 'commercial', holder: 'student' } })).status, 400, '시판인데 정답 표 → 거부');
  assert.equal((await adm('paperkey', 'POST', { key: KOR })).status, 200);
  const cm = { id: 'cm-stu-1', label: '학생 소지 시판', subject: 'math', n: 3, origin: 'commercial', holder: 'student', map: { 1: 'm-ratio-base', 2: 'm-frac-div', 3: 'm-unit-vol' } };
  assert.equal((await adm('paperkey', 'POST', { key: cm })).status, 200);
  const p1 = await adm('paper', 'POST', { code: 'st-1', keyId: KOR.id, wrongNos: [3, 3, 99] });
  assert.equal(p1.status, 200); assert.deepEqual(p1.body.entry.wrongNos, [3]); assert.deepEqual(p1.body.entry.atomIds, ['k-main-sentence']);
  assert.equal((await adm('paper', 'POST', { code: 'st-1', keyId: 'cm-stu-1', wrongNos: [1] })).status, 400);
  assert.equal((await adm('paper', 'POST', { code: 'st-1', keyId: 'cm-stu-1', correctBySubject: { math: 2 } })).status, 200);
  assert.equal(store._raw.paper['st-1'].paper.length, 2);
  assert.equal((await adm('plan', 'POST', { cohort: '2028', plan: { examDate: '2027-13-40', days: [], phases: [] } })).status, 400);
  assert.equal((await adm('plan', 'POST', { cohort: '2028', plan: { examDate: '2027-10-24', days: [{ d: '2026-10-12', kind: 'card' }], phases: [{ id: 'p2', from: '2026-10-05', to: '2027-02-28' }] } })).status, 200);
  assert.equal((await adm('plans')).body.plans.length, 2);
  assert.equal((await adm('atoms', 'POST', { atoms: { atoms: [{ id: 'x' }] } })).status, 400);
  assert.equal((await adm('atoms', 'POST', { atoms: ATOMS })).status, 200);
});
await t('코치 보드·좌표·부모 링크·파기 — 점수 열 없음, ptoken 으로 부모 화면, 파기 뒤 4계열 0 + 대응표 생존', async () => {
  const store = memStore(); seed(store); seedKeys(store);
  const adm = (r, method, b, qs) => call(store, { path: '/api/haru/admin/' + r, method: method || 'GET', who: ADMIN, getBody: async () => b || {}, query: Q(qs || '') });
  store.putState('st-1', { state: { days: { '2026-09-15': { sat: true, min: 12 } }, atoms: { 'm-ratio-base': { a: 30, b: 4, obs: 12, ok: 11, ctx: ['mixed'], seen: {}, lastAt: NOW } }, envelope: { items: [{ atomId: 'm-solid-cut', label: '입체' }] } }, updatedAt: '2026-09-15T12:00:00Z' });
  store.putMock('st-1', { mocks: [{ keyId: 'own-mock-t', at: '2026-09-13T00:04:00Z', retake: false, completed: true, blank: 2, bySubject: { kor: { n: 25, ok: 18 } }, skills: { markImmediate: true, passUsedAndRecovered: true, blank0: false, noBreakGrade: true }, pct: 72 }] });
  const b = await adm('board');
  assert.equal(b.status, 200); assert.equal(b.body.rows.length, 1); assert.equal(b.body.rows[0].confirmed, 1); assert.equal(b.body.coreMap.length, 16);
  assert.ok(!/"pct"|"score"|정답률|순위/.test(JSON.stringify(b.body.rows)));
  const map = await adm('map', 'GET', null, 'code=st-1');
  assert.equal(map.body.map.core.find((r) => r.id === 'm-ratio-base').stateLabel, '유창');
  const pl = await adm('parentlink', 'POST', { code: 'st-1' });
  assert.equal(pl.status, 200); assert.equal(pl.body.ptoken.length, 32);
  const par = await call(store, { who: null, path: '/api/haru/parent', query: Q('t=' + pl.body.ptoken) });
  assert.equal(par.status, 200); assert.equal(par.body.parent.name, '김하루'); assert.equal(par.body.parent.week.done, 1);
  assert.equal(par.body.parent.lastMock.completed, true); assert.equal(par.body.parent.lastMock.blank, 2); assert.equal(par.body.parent.dist, null, 'n<30 이면 분포 없음');
  assert.ok(par.body.parent.milestones.some((m) => /서류/.test(m.text)), '부모에게는 어른 일정이 보인다');
  const txt = JSON.stringify(par.body);
  ['pct', 'ok":', '점수', '정답률', '아직', '밀렸'].forEach((w) => assert.ok(!txt.includes(w), w));
  assert.equal((await call(store, { who: null, path: '/api/haru/parent', query: Q('t=' + pl.body.ptoken), now: Date.parse('2026-12-01T00:00:00Z') })).status, 410);
  assert.equal((await call(store, { who: null, path: '/api/haru/parent', query: Q('t=' + 'f'.repeat(32)) })).status, 404);
  assert.equal((await adm('export', 'GET', null, 'code=st-1')).status, 409, '숫자 개방 전 export 는 409');
  assert.equal((await call(store, { path: '/api/haru/admin/export', who: ADMIN, query: Q('code=st-1'), now: Date.parse('2026-11-02T00:00:00Z') })).status, 200);
  const pg = await adm('purge', 'POST', { cohort: '2027-pilot' });
  assert.equal(pg.body.purged, 1);
  assert.equal(store._raw.states['st-1'], undefined); assert.equal(store._raw.mocks['st-1'], undefined); assert.equal(store._raw.paper['st-1'], undefined);
  assert.equal(store._raw.parents[pl.body.ptoken], undefined);
  assert.ok(store._raw.keys[KOR.id], '파기가 대응표를 삼켰다'); assert.ok(store._raw.students['st-1'], '학생 레코드는 남는다');
  await dropStudentHaru(store, 'st-1');
});
await t('summary 정규화 — 화이트리스트 밖 키 제거·상한', () => {
  const s = normalizeSummary({ doneDays: '7', bySubject: { kor: { fluent: 3 } }, gained: { oneReadRate: 4 }, phase: 'p9', hack: 1 });
  assert.equal(s.doneDays, 7); assert.equal(s.bySubject.kor.fluent, 3); assert.equal(s.gained.oneReadRate, 1); assert.equal(s.phase, ''); assert.equal(s.hack, undefined);
  assert.equal(normalizeSummary('x'), null);
});
console.log(`\nOK — ${passed}개 통과`);
