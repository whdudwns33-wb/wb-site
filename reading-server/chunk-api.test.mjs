'use strict';
/* 청크브레인 서버 라우트 검증 (node reading-server/chunk-api.test.mjs) */
import assert from 'node:assert';
import SC from '../chunk/sched.js';
import { handleChunk, normalizeChunkSummary, normalizeAssign, normalizePassage, chunkOverviewRow, dropStudentChunk, pushDueChunk } from './chunk-api.mjs';

let passed = 0;
const t = async (name, fn) => { await fn(); passed += 1; console.log('  ✓ ' + name); };

function memStore() {
  const states = {}, summaries = {}, assigns = {}, parents = {}, pushes = {}; let customs = null;
  const students = { 'st-1': { code: 'st-1', name: '김지우', cls: '초4 A반' }, 'st-2': { code: 'st-2', name: '박서준', cls: '초4 A반' } };
  return {
    getState: (c) => states[c] || null, putState: (c, rec) => { states[c] = rec; }, deleteState: (c) => { delete states[c]; },
    getSummary: (c) => summaries[c] || null, putSummary: (c, rec) => { summaries[c] = rec; }, deleteSummary: (c) => { delete summaries[c]; },
    listSummaryCodes: () => Object.keys(summaries), getStudent: (c) => students[c] || null,
    getAssign: (c) => assigns[c] || null, putAssign: (c, rec) => { assigns[c] = rec; }, deleteAssign: (c) => { delete assigns[c]; },
    listAssignCodes: () => Object.keys(assigns),
    getCustoms: () => customs, putCustoms: (rec) => { customs = rec; },
    getParentCode: (t) => parents[t] || null, putParent: (t, c) => { parents[t] = c; }, putStudent: (c, rec) => { students[c] = rec; },
    listStudentCodes: () => Object.keys(students),
    getPush: (k) => pushes[k] || null, putPush: (k, rec) => { pushes[k] = rec; }, delPush: (k) => { delete pushes[k]; }, listPushKeys: () => Object.keys(pushes),
    _raw: { states, summaries, assigns, parents, students, pushes },
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

await t('학생·가족 저장은 기준 버전이 오래되면 원본과 요약을 덮지 않는다', async () => {
  const s = memStore(), token = 'family1234567890abcd';
  s._raw.parents[token] = 'st-1';
  const query = new URLSearchParams({ t: token });
  const first = await call(s, { method: 'PUT', getBody: async () => ({ state: { log: ['center'] }, summary: { attempts: 1 }, baseUpdatedAt: null }) });
  assert.equal(first.status, 200);
  const family = await call(s, { path: '/api/chunk/parent/state', method: 'PUT', who: null, query, getBody: async () => ({ state: { log: ['center', 'home'] }, summary: { attempts: 2 }, baseUpdatedAt: first.body.updatedAt }) });
  assert.equal(family.status, 200); assert.notEqual(family.body.updatedAt, first.body.updatedAt);
  for (const route of [{ who: STU }, { path: '/api/chunk/parent/state', who: null, query }]) {
    const stale = await call(s, { ...route, method: 'PUT', getBody: async () => ({ state: { log: ['old'] }, summary: { attempts: 99 }, baseUpdatedAt: first.body.updatedAt }) });
    assert.equal(stale.status, 409);
    assert.deepEqual(s._raw.states['st-1'].state.log, ['center', 'home']);
    assert.equal(s._raw.summaries['st-1'].summary.attempts, 2);
  }
  const puts = s._raw.states['st-1'].puts.n;
  await call(s, { method: 'PUT', getBody: async () => ({ state: { log: ['center', 'home', 'center-again'] }, baseUpdatedAt: family.body.updatedAt }) });
  assert.equal(s._raw.states['st-1'].puts.n, puts, '학생 저장으로 가족 저장 한도를 초기화하지 않는다');
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
  assert.deepStrictEqual(n, { band: null, attempts: 0, practiced: 0, graduated: 0, avg: 100, recentAvg: null, qRate: null, wpmRecent: null, streak: 2, lessonsDone: 0, assignDone: 2, index: null, weak: [{ tag: 'extra:adn', n: 3 }], lastAt: null });
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
  /* 과제만 있고 기록이 없는 학생도 overview 에 오른다(명단 전체가 오르므로 st-2 는 미시작 행) */
  const ov = await call(s, { path: '/api/chunk/admin/overview', who: ADMIN });
  assert.strictEqual(ov.body.rows.length, 2); assert.deepStrictEqual(ov.body.rows.find((r) => r.code === 'st-1').assign, { band: 'G4', passages: 1, lessons: 0, due: null, note: '', updatedAt: put.body.updatedAt });
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

await t('가족 링크 — 토큰이 자격, 자녀 기록과 같은 키를 읽고 쓰며 요약도 올라간다', async () => {
  const s = memStore(); const T = 'tok1234567890abcdef'; s._raw.parents[T] = 'st-1';
  const q = (t) => new URLSearchParams(t ? { t } : {});
  let r = await call(s, { path: '/api/chunk/parent', who: null, query: q(T) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(Object.keys(r.body), ['parent', 'assign', 'assignUpdatedAt', 'custom', 'updatedAt']);
  assert.deepStrictEqual(r.body.parent, { name: '김지우', cls: '초4 A반', band: null }); assert.strictEqual(r.body.assign, null); assert.deepStrictEqual(r.body.custom, []);
  assert.strictEqual((await call(s, { path: '/api/chunk/parent', who: null, query: q('nope') })).status, 404, '모르는 토큰');
  assert.strictEqual((await call(s, { path: '/api/chunk/parent', who: null, query: q() })).status, 404, '토큰 없음');
  assert.strictEqual((await call(s, { path: '/api/chunk/parent', who: null })).status, 404, 'query 없음');
  r = await call(s, { path: '/api/chunk/parent/state', who: null, query: q(T) });
  assert.deepStrictEqual(r.body, { state: null, updatedAt: null });
  r = await call(s, { path: '/api/chunk/parent/state', method: 'PUT', who: null, query: q(T), getBody: async () => ({ state: { v: 1, band: 'G3', log: [] }, summary: { band: 'G3', attempts: 1, recentAvg: 90 } }) });
  assert.strictEqual(r.status, 200); assert.ok(r.body.ok && r.body.updatedAt);
  const stu = await call(s, { path: '/api/chunk/state', who: STU });
  assert.strictEqual(stu.body.state.band, 'G3', '학생 토큰으로 읽어도 같은 기록');
  assert.strictEqual(s._raw.summaries['st-1'].summary.recentAvg, 90, '요약이 관리 화면 키에');
  /* 과제·단계가 있으면 parent.band 가 그것 */
  s._raw.assigns['st-1'] = { assign: { band: 'G4', passages: ['g4-01'], lessons: [], note: '', due: null }, updatedAt: '2026-09-21T00:00:00.000Z' };
  r = await call(s, { path: '/api/chunk/parent', who: null, query: q(T) });
  assert.strictEqual(r.body.parent.band, 'G4'); assert.strictEqual(r.body.assign.passages[0], 'g4-01'); assert.strictEqual(r.body.assignUpdatedAt, '2026-09-21T00:00:00.000Z');
  /* 하루 상한 */
  s._raw.states['st-1'].puts = { d: new Date().toISOString().slice(0, 10), n: 60 };
  r = await call(s, { path: '/api/chunk/parent/state', method: 'PUT', who: null, query: q(T), getBody: async () => ({ state: { v: 1 } }) });
  assert.strictEqual(r.status, 429);
  /* apps 게이트 — 외부 학생은 chunk 가 목록에 있어야 */
  s._raw.students['st-2'].apps = ['haru']; s._raw.parents['tok2234567890abcdef'] = 'st-2';
  assert.strictEqual((await call(s, { path: '/api/chunk/parent', who: null, query: q('tok2234567890abcdef') })).status, 403);
  assert.strictEqual((await call(s, { path: '/api/chunk/parent/nope', who: null, query: q(T) })).status, 404);
});

await t('관리 — 가족 링크 발급은 한 번, 다음부터 같은 토큰(브레인레터·진로독서와 공용)', async () => {
  const s = memStore();
  let r = await call(s, { path: '/api/chunk/admin/parentlink/st-1', method: 'POST', who: ADMIN });
  assert.strictEqual(r.status, 200); assert.ok(/^[a-f0-9]{32}$/.test(r.body.ptoken)); assert.strictEqual(r.body.path, '/chunk/?t=' + r.body.ptoken); assert.strictEqual(r.body.created, true);
  assert.strictEqual(s._raw.parents[r.body.ptoken], 'st-1'); assert.strictEqual(s._raw.students['st-1'].ptoken, r.body.ptoken);
  const again = await call(s, { path: '/api/chunk/admin/parentlink/st-1', method: 'POST', who: ADMIN });
  assert.strictEqual(again.body.ptoken, r.body.ptoken); assert.strictEqual(again.body.created, false);
  assert.strictEqual((await call(s, { path: '/api/chunk/admin/parentlink/st-9', method: 'POST', who: ADMIN })).status, 404);
  assert.strictEqual((await call(s, { path: '/api/chunk/admin/parentlink/st-1', method: 'POST', who: STU })).status, 403);
  /* 발급된 링크로 바로 열린다 */
  const open = await call(s, { path: '/api/chunk/parent', who: null, query: new URLSearchParams({ t: r.body.ptoken }) });
  assert.strictEqual(open.status, 200); assert.strictEqual(open.body.parent.name, '김지우');
});

await t('센터 학습 — 가족 링크의 과제 완료가 학생·관리 현황에 이어지고 새 과제는 다시 센다', async () => {
  const s = memStore(), before = Date.now() - 120_000;
  const link = await call(s, { path: '/api/chunk/admin/parentlink/st-1', method: 'POST', who: ADMIN });
  const family = { who: null, query: new URLSearchParams({ t: link.body.ptoken }) };
  const assign = { band: 'G3', passages: ['g3-01'], lessons: ['g3-1'], note: '센터 확인용', due: null };
  const putAssign = () => call(s, { path: '/api/chunk/admin/assign/st-1', method: 'PUT', who: ADMIN, getBody: async () => assign });
  assert.equal((await putAssign()).status, 200);
  s._raw.assigns['st-1'].updatedAt = new Date(before).toISOString();
  const opened = await call(s, { ...family, path: '/api/chunk/parent' });
  assert.deepEqual(opened.body.assign, assign); assert.equal(opened.body.parent.band, 'G3');
  const state = SC.blank(before); state.band = 'G3';
  state.assign = { ...opened.body.assign, updatedAt: opened.body.assignUpdatedAt };
  SC.lessonDone(state, 'g3-1', before + 1000, 100);
  SC.record(state, 'g3-01', { band: 'G3', score: 90, qOk: true }, before + 2000);
  const put = await call(s, { ...family, path: '/api/chunk/parent/state', method: 'PUT', getBody: async () => ({ state, summary: SC.forTeacher(state, before + 2000), baseUpdatedAt: null }) });
  assert.equal(put.status, 200);
  const student = await call(s, {});
  assert.deepEqual(student.body.state, state); assert.equal(student.body.updatedAt, put.body.updatedAt);
  const overview = async () => (await call(s, { path: '/api/chunk/admin/overview', who: ADMIN })).body.rows.find((r) => r.code === 'st-1');
  assert.equal((await overview()).assignDone, 2); assert.equal((await overview()).attempts, 1);

  const next = await putAssign();
  assert.equal((await overview()).assignDone, 0, '같은 글·카드를 다시 내도 이전 완료는 새 과제에 세지 않는다');
  let version = put.body.updatedAt;
  for (const route of [{ ...family, path: '/api/chunk/parent/state' }, { who: STU }]) {
    const late = await call(s, { ...route, method: 'PUT', getBody: async () => ({ state, summary: SC.forTeacher(state, before + 2000), baseUpdatedAt: version }) });
    assert.equal(late.status, 200); version = late.body.updatedAt;
    assert.equal((await overview()).assignDone, 0, '옛 과제를 기억한 학생·가족 기기의 요약을 그대로 믿지 않는다');
  }
  const after = Date.parse(next.body.updatedAt) + 1;
  state.assign = { ...next.body.assign, updatedAt: next.body.updatedAt };
  SC.lessonDone(state, 'g3-1', after, 100);
  SC.record(state, 'g3-01', { band: 'G3', score: 95, qOk: true }, after);
  const done = await call(s, { ...family, path: '/api/chunk/parent/state', method: 'PUT', getBody: async () => ({ state, summary: { ...SC.forTeacher(state, after), assignDone: 99 }, baseUpdatedAt: version }) });
  assert.equal(done.status, 200); assert.equal((await overview()).assignDone, 2, '서버도 현재 과제 뒤의 학습 시각으로 센다');
  assert.equal((await overview()).attempts, 2);
  await call(s, { path: '/api/chunk/admin/assign/st-1', method: 'PUT', who: ADMIN, getBody: async () => ({}) });
  assert.equal((await overview()).assign, null); assert.equal((await overview()).assignDone, 0);
});

await t('요약 지수 화이트리스트 · overview 는 명단 전체(미시작 포함), 외부 학생은 apps 에 chunk 가 있어야', async () => {
  assert.strictEqual(normalizeChunkSummary({ index: 73.4 }).index, 73);
  assert.strictEqual(normalizeChunkSummary({}).index, null);
  const s = memStore();
  s._raw.summaries['st-1'] = { summary: normalizeChunkSummary({ band: 'G3', attempts: 2, recentAvg: 80, index: 60 }), updatedAt: '2026-09-21T00:00:00.000Z' };
  s._raw.students['st-3'] = { code: 'st-3', name: '외부', cls: '외부', apps: ['haru'] };
  const r = await call(s, { path: '/api/chunk/admin/overview', who: ADMIN });
  const codes = r.body.rows.map((x) => x.code).sort();
  assert.deepStrictEqual(codes, ['st-1', 'st-2'], '명단의 st-2 는 미시작으로 올라오고, 외부 st-3 은 빠진다');
  const st2 = r.body.rows.find((x) => x.code === 'st-2');
  assert.strictEqual(st2.attempts, 0); assert.strictEqual(st2.index, null); assert.strictEqual(st2.lastAt, null);
  assert.strictEqual(r.body.rows.find((x) => x.code === 'st-1').index, 60);
});

/* ── 가족 알림 ── */
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const PUSH = { publicKey: 'BPUB', privateJwk: JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey)), subject: 'mailto:t@wb' };
const fakePush = (statusFor) => { const calls = []; const f = async (url) => { calls.push(url); return { status: statusFor ? statusFor(url) : 201 }; }; f.calls = calls; return f; };

await t('가족 알림 구독 — 링크 토큰이 자격, 키가 없으면 no-vapid, 끝점 모양 검사', async () => {
  const s = memStore(); const T = 'tok1234567890abcdef'; s._raw.parents[T] = 'st-1';
  const Q = (t) => new URLSearchParams({ t });
  assert.deepStrictEqual((await call(s, { path: '/api/chunk/parent/push/key', who: null, query: Q(T) })).body, { ok: false, reason: 'no-vapid' });
  assert.deepStrictEqual((await call(s, { path: '/api/chunk/parent/push/key', who: null, query: Q(T), push: PUSH })).body, { ok: true, key: 'BPUB' });
  assert.strictEqual((await call(s, { path: '/api/chunk/parent/push/key', who: null, query: Q('z'.repeat(32)) })).status, 404, '모르는 토큰');
  const sub = { subscription: { endpoint: 'https://push.example/abc' } };
  assert.strictEqual((await call(s, { path: '/api/chunk/parent/push/subscribe', method: 'POST', who: null, query: Q(T), getBody: async () => sub })).status, 200);
  assert.strictEqual(s._raw.pushes['f:' + T].endpoint, 'https://push.example/abc');
  assert.strictEqual((await call(s, { path: '/api/chunk/parent/push/subscribe', method: 'POST', who: null, query: Q(T), getBody: async () => ({ subscription: { endpoint: 'http://insecure' } }) })).status, 400);
  assert.strictEqual((await call(s, { path: '/api/chunk/parent/push/unsubscribe', method: 'POST', who: null, query: Q(T), getBody: async () => ({}) })).status, 200);
  assert.strictEqual(s._raw.pushes['f:' + T], undefined);
  assert.strictEqual((await call(s, { path: '/api/chunk/parent/push/nope', who: null, query: Q(T) })).status, 404);
});

await t('가족 알림 보내기 — 복습할 글이 있는 가정에만, 죽은 구독·끊긴 링크는 정리', async () => {
  const s = memStore(); const now = Date.parse('2026-09-21T09:00:00Z');
  const T1 = 'aaa1234567890abcdef', T2 = 'bbb1234567890abcdef', T3 = 'ccc1234567890abcdef';
  s._raw.parents[T1] = 'st-1'; s._raw.parents[T2] = 'st-2';
  /* st-1 은 어제가 복습일, st-2 는 한참 뒤 */
  s._raw.states['st-1'] = { state: { v: 1, band: 'G3', items: { 'g3-01': { id: 'g3-01', n: 1, last: now - 2 * 86400000, lastScore: 90, best: 90, step: 1, due: now - 86400000, graduated: false, band: 'G3' } }, log: [], lessons: {}, updatedAt: now } };
  s._raw.states['st-2'] = { state: { v: 1, band: 'G3', items: { 'g3-01': { id: 'g3-01', n: 1, last: now, lastScore: 90, best: 90, step: 1, due: now + 30 * 86400000, graduated: false, band: 'G3' } }, log: [], lessons: {}, updatedAt: now } };
  s._raw.pushes['f:' + T1] = { endpoint: 'https://push.example/one' };
  s._raw.pushes['f:' + T2] = { endpoint: 'https://push.example/two' };
  s._raw.pushes['f:' + T3] = { endpoint: 'https://push.example/gone' };   /* 링크가 학생과 이어지지 않는다(퇴원·토큰 교체) */
  const f = fakePush();
  const r = await pushDueChunk({ store: s, push: PUSH, fetchFn: f, now });
  assert.deepStrictEqual({ sent: r.sent, skipped: r.skipped, removed: r.removed }, { sent: 1, skipped: 1, removed: 1 });
  assert.deepStrictEqual(f.calls, ['https://push.example/one'], '복습이 밀린 가정에만');
  assert.strictEqual(s._raw.pushes['f:' + T3], undefined, '끊긴 링크는 지운다');
  /* 410 이면 구독을 지운다 */
  const gone = fakePush(() => 410);
  const r2 = await pushDueChunk({ store: s, push: PUSH, fetchFn: gone, now });
  assert.strictEqual(r2.removed, 1); assert.strictEqual(s._raw.pushes['f:' + T1], undefined);
  /* VAPID 키가 없으면 아무것도 보내지 않는다 */
  assert.strictEqual((await pushDueChunk({ store: s, push: {}, fetchFn: f, now })).reason, 'no-vapid');
});

await t('퇴원 — 가족 알림 구독도 함께 지운다', async () => {
  const s = memStore(); const T = 'ddd1234567890abcdef';
  s._raw.pushes['f:' + T] = { endpoint: 'https://push.example/x' };
  s._raw.states['st-1'] = { state: { v: 1 }, updatedAt: 'x' };
  await dropStudentChunk(s, 'st-1', T);
  assert.strictEqual(s._raw.states['st-1'], undefined);
  assert.strictEqual(s._raw.pushes['f:' + T], undefined);
});

console.log('\n' + passed + '건 통과 — reading-server/chunk-api.mjs');
