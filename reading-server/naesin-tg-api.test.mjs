'use strict';
/* 탐구브레인 서버 라우트 검증 (node reading-server/naesin-tg-api.test.mjs)
   지키는 것: 인증 없이는 아무것도 안 나간다 · 정답은 제출 전에 새지 않는다 · 채점 · 오답은 다른 날 맞혀야 지워진다 */
import assert from 'node:assert';
import fs from 'node:fs';
import { handleNaesinTg, isRight, normalizeSheet, naesinTgBodyLimit } from './naesin-tg-api.mjs';

let passed = 0;
const t = async (name, fn) => { await fn(); passed += 1; console.log('  ✓ ' + name); };

function memStore() {
  const sheets = {}, pages = {}, states = {}, exams = {};
  let ids = null;
  let tasks = null;
  const students = { 'st-1': { code: 'st-1', name: '김지우', cls: '중2 A반' }, 'st-2': { code: 'st-2', name: '박서준', cls: '중2 A반' },
    'st-3': { code: 'st-3', name: '이하은', cls: '중2 B반' } };
  return {
    getSheet: (id) => sheets[id] || null, putSheet: (id, rec) => { sheets[id] = rec; }, delSheet: (id) => { delete sheets[id]; },
    getSheetIds: () => ids, putSheetIds: (v) => { ids = v; },
    getPage: (id, n) => pages[id + ':' + n] || null, putPage: (id, n, d) => { pages[id + ':' + n] = d; }, delPage: (id, n) => { delete pages[id + ':' + n]; },
    getState: (c) => states[c] || null, putState: (c, rec) => { states[c] = JSON.parse(JSON.stringify(rec)); }, listStateCodes: () => Object.keys(states),
    getExam: (s) => exams[s] || null, putExam: (s, rec) => { exams[s] = rec; },
    getTasks: () => tasks, putTasks: (v) => { tasks = JSON.parse(JSON.stringify(v)); },
    getStudent: (c) => students[c] || null, listStudentCodes: () => Object.keys(students),
    _raw: { sheets, pages, states, exams },
  };
}

const store = memStore();
let clock = Date.parse('2026-11-12T03:00:00Z');     // 한국 11월 12일 낮
const call = (who, method, path, bodyOrQuery) => {
  const [p, qs] = path.split('?');
  return handleNaesinTg({ path: '/api/naesin-tg' + p, method, who, store, now: () => clock,
    query: new URLSearchParams(qs || ''), getBody: async () => bodyOrQuery });
};
const ADMIN = { admin: true }, S1 = { code: 'st-1' }, S2 = { code: 'st-2' }, S3 = { code: 'st-3' };
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const SHEET = { title: '7-1 전기 1회', subject: 'science', grade: '중2', unit: '7-1', step: 3, kind: 'test', pages: 3, answerFrom: 3,
  questions: [
    { no: 1, type: 'choice', page: 1, answer: '3' }, { no: 2, type: 'choice', page: 1, answer: '2,4' },
    { no: 3, type: 'short', page: 2, answer: '도체|전도체' }, { no: 4, type: 'essay', page: 2, answer: '' },
  ] };

console.log('탐구브레인 API');

await t('답 맞추기 — 객관식은 번호 집합, 단답은 띄어쓰기·기호 무시', () => {
  assert.strictEqual(isRight({ type: 'choice', answer: '2,4' }, '④②'), true);
  assert.strictEqual(isRight({ type: 'choice', answer: '3' }, '2'), false);
  assert.strictEqual(isRight({ type: 'choice', answer: '3' }, ''), false);
  assert.strictEqual(isRight({ type: 'short', answer: '도체|전도체' }, ' 전 도체.'), true);
  assert.strictEqual(isRight({ type: 'short', answer: '도체' }, '부도체'), false);
  assert.strictEqual(isRight({ type: 'essay', answer: '' }, '아무 말'), null);
});

await t('문제지 다듬기 — 정답이 비면 열 수 없다', () => {
  const bad = normalizeSheet('x-1', { ...SHEET, open: true, questions: [{ no: 1, type: 'choice', page: 1, answer: '' }] });
  assert.match(bad, /정답이 빈/);
  assert.match(normalizeSheet('x-1', { ...SHEET, questions: [SHEET.questions[0], SHEET.questions[0]] }), /두 번/);
  assert.strictEqual(normalizeSheet('x-1', { ...SHEET, kind: 'note' }).questions.length, 0);
});

await t('로그인 없이는 401, 학생은 관리 라우트 403', async () => {
  assert.strictEqual((await call(null, 'GET', '/sheets')).status, 401);
  assert.strictEqual((await call(S1, 'GET', '/admin/sheets')).status, 403);
  assert.strictEqual((await call(S1, 'POST', '/admin/sheet', { id: 'sc-1', sheet: SHEET })).status, 403);
});

await t('올리기 — 쪽 그림이 다 있어야 열린다', async () => {
  assert.strictEqual((await call(ADMIN, 'POST', '/admin/sheet', { id: 'sc-1', sheet: SHEET })).status, 200);
  assert.match((await call(ADMIN, 'POST', '/admin/sheet', { id: 'sc-1', sheet: { ...SHEET, open: true } })).body.error, /1쪽 그림/);
  assert.strictEqual((await call(ADMIN, 'POST', '/admin/page', { id: 'sc-1', n: 1, data: 'data:text/html;base64,AAAA' })).status, 400);
  for (const n of [1, 2, 3]) assert.strictEqual((await call(ADMIN, 'POST', '/admin/page', { id: 'sc-1', n, data: PNG })).status, 200);
  assert.strictEqual((await call(ADMIN, 'POST', '/admin/sheet', { id: 'sc-1', sheet: { ...SHEET, open: true } })).status, 200);
  assert.strictEqual((await call(ADMIN, 'GET', '/admin/sheets')).body.sheets.length, 1);
  assert.ok(naesinTgBodyLimit('/api/naesin-tg/admin/page') > naesinTgBodyLimit('/api/naesin-tg/submit'));
});

await t('배정 전에는 학생에게 안 보인다', async () => {
  assert.deepStrictEqual((await call(S1, 'GET', '/sheets')).body.sheets, []);
  assert.strictEqual((await call(S1, 'GET', '/sheet?id=sc-1')).status, 403);
  assert.strictEqual((await call(S1, 'GET', '/page?id=sc-1&n=1')).status, 403);
  assert.strictEqual((await call(ADMIN, 'POST', '/admin/exam', { scope: 'default', examDate: '2026-12-08', sheetIds: ['nope'] })).status, 400);
  assert.strictEqual((await call(ADMIN, 'POST', '/admin/exam', { scope: 'default', examDate: '2026-12-08', title: '2학기 기말', sheetIds: ['sc-1'] })).status, 200);
  const r = await call(S1, 'GET', '/sheets');
  assert.strictEqual(r.body.sheets[0].id, 'sc-1');
  assert.strictEqual(r.body.exam.examDate, '2026-12-08');
  assert.strictEqual(r.body.progress['sc-1'].submitted, false);
});

await t('제출 전에는 정답도 해설 쪽도 나가지 않는다', async () => {
  const r = await call(S1, 'GET', '/sheet?id=sc-1');
  assert.strictEqual(r.status, 200);
  assert.ok(!JSON.stringify(r.body).includes('도체'), '정답 문자열이 응답에 있다');
  assert.ok(!('answers' in r.body));
  assert.ok(r.body.sheet.questions.every((x) => !('answer' in x)));
  assert.strictEqual((await call(S1, 'GET', '/page?id=sc-1&n=2')).status, 200);
  assert.strictEqual((await call(S1, 'GET', '/page?id=sc-1&n=3')).status, 403);
  assert.strictEqual((await call(ADMIN, 'GET', '/page?id=sc-1&n=3')).status, 200);
});

await t('쓰다 만 답은 서버에 남는다', async () => {
  assert.strictEqual((await call(S1, 'PUT', '/draft', { id: 'sc-1', answers: { 1: '3', 99: 'x' } })).status, 200);
  assert.deepStrictEqual((await call(S1, 'GET', '/sheet?id=sc-1')).body.my.draft, { 1: '3' });
});

await t('제출하면 채점되고 정답·해설이 열린다. 두 번은 못 낸다', async () => {
  const r = await call(S1, 'POST', '/submit', { id: 'sc-1', answers: { 1: '3', 2: '2', 3: '전도체', 4: '전류가 흐르기 때문이다.' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.result.score, 2);
  assert.strictEqual(r.body.result.total, 3);            // 서술형은 점수에서 뺀다
  assert.deepStrictEqual(r.body.result.marks, { 1: true, 2: false, 3: true, 4: null });
  assert.strictEqual(r.body.result.answers[2], '2,4');
  assert.strictEqual((await call(S1, 'GET', '/page?id=sc-1&n=3')).status, 200);
  const s = (await call(S1, 'GET', '/sheet?id=sc-1')).body;
  assert.strictEqual(s.answers[1], '3');
  assert.deepStrictEqual(Object.keys(s.my.wrong), ['2']);
  assert.strictEqual((await call(S1, 'POST', '/submit', { id: 'sc-1', answers: {} })).status, 409);
  assert.strictEqual((await call(S1, 'PUT', '/draft', { id: 'sc-1', answers: {} })).status, 409);
  assert.strictEqual((await call(S2, 'GET', '/page?id=sc-1&n=3')).status, 403, '남이 제출해도 내 해설은 안 열린다');
});

await t('오답은 다른 날 맞혀야 지워진다', async () => {
  assert.strictEqual((await call(S1, 'POST', '/retry', { id: 'sc-1', no: 2, answer: '2,4' })).status, 409);
  assert.strictEqual((await call(S1, 'POST', '/retry', { id: 'sc-1', no: 1, answer: '3' })).status, 404);
  clock += 24 * 3600_000;
  assert.deepStrictEqual((await call(S1, 'POST', '/retry', { id: 'sc-1', no: 2, answer: '1' })).body.retry, { ok: false, cleared: false });
  assert.strictEqual((await call(S1, 'POST', '/retry', { id: 'sc-1', no: 2, answer: '2,4' })).status, 409, '오늘 또 틀렸으니 내일');
  clock += 24 * 3600_000;
  assert.deepStrictEqual((await call(S1, 'POST', '/retry', { id: 'sc-1', no: 2, answer: '④②' })).body.retry, { ok: true, cleared: true });
  assert.strictEqual((await call(S1, 'GET', '/sheets')).body.progress['sc-1'].wrongOpen, 0);
});

await t('서술형 — 학생이 스스로 표시, 강사가 확정', async () => {
  assert.strictEqual((await call(S1, 'POST', '/essay', { id: 'sc-1', no: 4, self: 'ok' })).status, 200);
  assert.strictEqual((await call(S1, 'POST', '/essay', { id: 'sc-1', no: 1, self: 'ok' })).status, 404);
  const ov = (await call(ADMIN, 'GET', '/admin/overview')).body;
  assert.strictEqual(ov.students[0].name, '김지우');
  assert.strictEqual(ov.students[0].sheets['sc-1'].essayHold, 1);
  assert.ok(!JSON.stringify(ov).includes('전류가 흐르기'), '현황에 답안 원문이 실린다');
  assert.strictEqual((await call(ADMIN, 'GET', '/admin/student?code=st-1&id=sc-1')).body.student.essays[4].self, 'ok');
  assert.strictEqual((await call(ADMIN, 'POST', '/admin/essay', { code: 'st-1', id: 'sc-1', no: 4, verdict: 'pass' })).status, 200);
  assert.strictEqual((await call(ADMIN, 'GET', '/admin/overview')).body.students[0].sheets['sc-1'].essayHold, 0);
});

await t('과제 — 시험 범위 밖 문제지도 대상 학생에게만 열리고, 현황에 안 낸 학생이 보인다', async () => {
  const saved = clock;
  await call(ADMIN, 'POST', '/admin/sheet', { id: 'sc-2', sheet: { ...SHEET, title: '7-2 숙제', pages: 2, answerFrom: 0 } });
  for (const n of [1, 2]) await call(ADMIN, 'POST', '/admin/page', { id: 'sc-2', n, data: PNG });
  assert.strictEqual((await call(ADMIN, 'POST', '/admin/sheet', { id: 'sc-2', sheet: { ...SHEET, title: '7-2 숙제', pages: 2, answerFrom: 0, open: true } })).status, 200);
  const A = { title: '7-2 숙제', due: '2026-11-20', sheetIds: ['sc-2'], target: { kind: 'cls', cls: '중2 A반' } };
  assert.strictEqual((await call(S1, 'POST', '/admin/task', A)).status, 403);
  assert.strictEqual((await call(ADMIN, 'POST', '/admin/task', { ...A, title: '' })).status, 400);
  assert.strictEqual((await call(ADMIN, 'POST', '/admin/task', { ...A, due: '11/20' })).status, 400);
  assert.strictEqual((await call(ADMIN, 'POST', '/admin/task', { ...A, sheetIds: ['nope'] })).status, 400);
  assert.strictEqual((await call(ADMIN, 'POST', '/admin/task', { ...A, target: { kind: 'codes', codes: ['ghost'] } })).status, 404);
  assert.strictEqual((await call(ADMIN, 'POST', '/admin/task', { ...A, target: { kind: 'x' } })).status, 400);
  const id = (await call(ADMIN, 'POST', '/admin/task', A)).body.task.id;

  const h = (await call(S2, 'GET', '/sheets')).body;
  assert.deepStrictEqual(h.tasks.map((x) => x.id), [id]);
  assert.deepStrictEqual(h.examIds, ['sc-1']);
  assert.ok(h.sheets.some((e) => e.id === 'sc-2'));
  assert.strictEqual((await call(S2, 'GET', '/sheet?id=sc-2')).status, 200);
  assert.deepStrictEqual((await call(S3, 'GET', '/sheets')).body.tasks, [], '다른 반에는 안 보인다');
  assert.strictEqual((await call(S3, 'GET', '/sheet?id=sc-2')).status, 403);

  let st = (await call(ADMIN, 'GET', '/admin/tasks')).body.tasks[0].status;
  assert.deepStrictEqual([st.targets, st.submitted, st.missing.length], [2, 0, 2]);
  assert.strictEqual((await call(S2, 'POST', '/submit', { id: 'sc-2', answers: { 1: '3' } })).status, 200);
  st = (await call(ADMIN, 'GET', '/admin/tasks')).body.tasks[0].status;
  assert.deepStrictEqual([st.submitted, st.missing.map((m) => m.name)], [1, ['김지우']]);

  /* 학생 코드 대상 · 고치기 */
  assert.strictEqual((await call(ADMIN, 'POST', '/admin/task', { ...A, id, target: { kind: 'codes', codes: ['st-3'] } })).status, 200);
  assert.strictEqual((await call(S3, 'GET', '/sheets')).body.tasks.length, 1);
  assert.strictEqual((await call(S2, 'GET', '/sheets')).body.tasks.length, 0);
  assert.strictEqual((await call(ADMIN, 'POST', '/admin/task', { ...A, id: 't-none' })).status, 404);

  /* 전체 대상은 탐구브레인을 연 학생만 센다(st-3 은 아직 기록이 없다) */
  await call(ADMIN, 'POST', '/admin/task', { ...A, id, target: { kind: 'all' } });
  assert.strictEqual((await call(ADMIN, 'GET', '/admin/tasks')).body.tasks[0].status.targets, 2);

  /* 마감 7일 뒤에는 화면에서 숨지만, 지우기 전까지 문제지는 열린다 */
  clock = Date.parse('2026-11-27T03:00:00Z');
  assert.strictEqual((await call(S2, 'GET', '/sheets')).body.tasks.length, 1);
  clock = Date.parse('2026-11-28T03:00:00Z');
  assert.strictEqual((await call(S2, 'GET', '/sheets')).body.tasks.length, 0);
  assert.strictEqual((await call(S2, 'GET', '/sheet?id=sc-2')).status, 200);

  /* 지우면 닫히지만 풀이 기록은 남는다 */
  assert.strictEqual((await call(ADMIN, 'POST', '/admin/task-delete', { id })).status, 200);
  assert.strictEqual((await call(ADMIN, 'POST', '/admin/task-delete', { id })).status, 404);
  assert.strictEqual((await call(S2, 'GET', '/sheet?id=sc-2')).status, 403);
  assert.ok(store._raw.states['st-2'].state.sheets['sc-2'].done);
  await call(ADMIN, 'POST', '/admin/sheet-delete', { id: 'sc-2' });
  clock = saved;
});

await t('반별 현황 — 반 전원이 분모, 번호별 오답률은 처음 제출 기준', async () => {
  assert.strictEqual((await call(S1, 'GET', '/admin/class?cls=중2 A반')).status, 403);
  assert.deepStrictEqual((await call(ADMIN, 'GET', '/admin/class')).body, { class: null, classes: ['중2 A반', '중2 B반'] });
  const c = (await call(ADMIN, 'GET', '/admin/class?cls=' + encodeURIComponent('중2 A반'))).body.class;
  assert.strictEqual(c.members, 2);
  const s = c.sheets.find((x) => x.id === 'sc-1');
  /* st-1 만 냈다: 1·3번 맞고 2번 틀림(뒤에 다시 맞혔어도 처음 틀린 것으로 센다), 4번 서술형은 뺀다 */
  assert.deepStrictEqual([s.members, s.submitted, s.rate], [2, 1, 67]);
  assert.deepStrictEqual(s.wrongByNo, [{ no: 2, wrong: 1, rate: 100 }]);
  assert.strictEqual((await call(ADMIN, 'GET', '/admin/class?cls=' + encodeURIComponent('중2 B반'))).body.class.sheets[0].submitted, 0);
  assert.ok(!JSON.stringify(c).includes('전류가 흐르기'), '반 현황에 답안 원문이 실린다');
});

await t('문항 영역(crops) — 저장·학생에게 전달, 정답 쪽·쪽 밖은 거절', async () => {
  const R = (p, y) => [{ p, x: 0.05, y, w: 0.45, h: 0.2 }];
  const crops = { 1: R(1, 0.1), 2: R(1, 0.4), 3: R(2, 0.1), 4: R(2, 0.4) };
  const base = (await call(ADMIN, 'GET', '/sheet?id=sc-1')).body.sheet;
  assert.match((await call(ADMIN, 'POST', '/admin/sheet', { id: 'sc-1', sheet: { ...base, crops: { ...crops, 4: R(3, 0.1) } } })).body.error, /문제 쪽을 벗어나/, '정답·해설 쪽(3쪽)을 가리키면 거절');
  assert.match((await call(ADMIN, 'POST', '/admin/sheet', { id: 'sc-1', sheet: { ...base, crops: { 1: [{ p: 1, x: 0.8, y: 0, w: 0.5, h: 0.1 }] } } })).body.error, /좌표가 쪽을 벗어나/);
  assert.strictEqual((await call(ADMIN, 'POST', '/admin/sheet', { id: 'sc-1', sheet: { ...base, crops: { ...crops, 99: R(1, 0.1) } } })).status, 200);
  const got = (await call(S1, 'GET', '/sheet?id=sc-1')).body;
  assert.deepStrictEqual(Object.keys(got.sheet.crops), ['1', '2', '3', '4'], '없는 문항(99번)의 영역은 버린다');
  const fresh = (await call(S2, 'GET', '/sheet?id=sc-1')).body;
  assert.ok(fresh.sheet.crops[1] && !('answers' in fresh) && fresh.sheet.questions.every((x) => !('answer' in x)), '영역은 나가도 정답은 제출 전에 안 나간다');
});

await t('닫으면 학생에게서 사라지고, 지우면 쪽 그림도 지워진다', async () => {
  await call(ADMIN, 'POST', '/admin/sheet', { id: 'sc-1', sheet: { ...SHEET, open: false } });
  assert.deepStrictEqual((await call(S2, 'GET', '/sheets')).body.sheets, []);
  assert.strictEqual((await call(S2, 'GET', '/page?id=sc-1&n=1')).status, 403);
  assert.strictEqual((await call(ADMIN, 'POST', '/admin/sheet-delete', { id: 'sc-1' })).status, 200);
  assert.deepStrictEqual(Object.keys(store._raw.pages), []);
  assert.deepStrictEqual((await call(ADMIN, 'GET', '/admin/sheets')).body.sheets, []);
});

await t('저장소의 체험 문제지는 올리기 규칙을 통과한다(자체 창작)', async () => {
  const s = JSON.parse(fs.readFileSync(new URL('../naesin-tg/sheet-sample.json', import.meta.url), 'utf8'));
  assert.strictEqual((await call(ADMIN, 'POST', '/admin/sheet', { id: s.id, sheet: { ...s.sheet, open: false } })).status, 200);
  assert.strictEqual(s.pages.length, s.sheet.pages);
  for (let i = 0; i < s.pages.length; i += 1) assert.strictEqual((await call(ADMIN, 'POST', '/admin/page', { id: s.id, n: i + 1, data: s.pages[i] })).status, 200);
  assert.strictEqual((await call(ADMIN, 'POST', '/admin/sheet', { id: s.id, sheet: { ...s.sheet, open: true } })).status, 200);
});

console.log(`\n${passed}개 통과`);
