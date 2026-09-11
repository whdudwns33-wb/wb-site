'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/* desk-core.js 원문·동작 검사. app.js(DOM 런타임)는 읽지 않는다 — 통합 담당의 헤드리스 검사가 본다. */
const src = fs.readFileSync(path.join(__dirname, 'desk-core.js'), 'utf8');
const C = require('./desk-core.js');

const D = '2026-09-09'; // 수요일

function mkTask(over) {
  return Object.assign({ id: 't1', staffId: 's1', title: '일반 업무', repeat: 'daily', start: '2026-09-01', end: '', steps: [], target: 0, deleted: false }, over || {});
}

/* ── 정적 검사 ── */

test('house style: IIFE, single global, module.exports guard, no top-level leaks, no external deps', () => {
  assert.ok(/root\.WBDeskCore = api/.test(src));
  assert.ok(/module\.exports = api/.test(src));
  assert.ok(src.includes("'use strict'"));
  const topLevel = src.replace(/\/\*[\s\S]*?\*\//g, '').match(/^(?:const|let|var|function)\s+\w+/gm) || [];
  assert.deepEqual(topLevel, []);
  assert.ok(!/require\(|import\s|fetch\(|document\.|localStorage/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'pure module');
  const urls = src.match(/https?:\/\/[^\s'"]+/g) || [];
  assert.deepEqual(urls, []);
});

/* ── 날짜 ── */

test('date helpers', () => {
  assert.equal(C.dowOf(D), 3);
  assert.equal(C.addDays(D, 1), '2026-09-10');
  assert.equal(C.addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(C.mondayOf(D), '2026-09-07');
  assert.equal(C.mondayOf('2026-09-06'), '2026-08-31');
  assert.equal(C.label(D), '9월 9일 (수)');
  assert.equal(C.shortDate(D), '9/9');
  assert.ok(C.validYmd(D) && !C.validYmd('2026-02-30') && !C.validYmd('2026-9-9'));
  assert.ok(C.validYm('2026-09') && !C.validYm('2026-13') && !C.validYm('2026-09-09'));
  assert.equal(C.hmToMin('09:30'), 570);
  assert.equal(C.minToHM(570), '09:30');
  assert.equal(C.repeatLabel({ repeat: 'days', days: [1, 3] }), '매주 월·수');
  assert.equal(C.repeatLabel({ repeat: 'once', start: D }), '9월 9일 (수) 1회');
});

/* ── occursOn / tasksFor ── */

test('occursOn: once/daily/weekday/days + start/end + deleted', () => {
  assert.ok(C.occursOn(mkTask({ repeat: 'once', start: D }), D));
  assert.ok(!C.occursOn(mkTask({ repeat: 'once', start: D }), '2026-09-10'));
  assert.ok(C.occursOn(mkTask({ repeat: 'daily' }), '2026-09-13'));
  assert.ok(C.occursOn(mkTask({ repeat: 'weekday' }), D));
  assert.ok(!C.occursOn(mkTask({ repeat: 'weekday' }), '2026-09-13'), 'sunday');
  assert.ok(C.occursOn(mkTask({ repeat: 'days', days: [3, 5] }), D));
  assert.ok(!C.occursOn(mkTask({ repeat: 'days', days: [1] }), D));
  assert.ok(!C.occursOn(mkTask({ start: '2026-09-10' }), D), 'before start');
  assert.ok(!C.occursOn(mkTask({ end: '2026-09-08' }), D), 'after end');
  assert.ok(!C.occursOn(mkTask({ deleted: true }), D));
  assert.ok(!C.occursOn(mkTask({ repeat: 'weird' }), D));
  assert.ok(!C.occursOn(mkTask(), 'nope'));
  assert.ok(!C.occursOn(null, D));
});

test('tasksFor filters by staff and sorts time → high priority → createdAt', () => {
  const tasks = [
    mkTask({ id: 'a', time: '15:00', createdAt: 3 }),
    mkTask({ id: 'b', time: '', createdAt: 1 }),
    mkTask({ id: 'c', time: '09:00', createdAt: 2 }),
    mkTask({ id: 'd', time: '09:00', priority: 'high', createdAt: 9 }),
    mkTask({ id: 'e', staffId: 's2', time: '08:00' }),
    mkTask({ id: 'f', deleted: true, time: '07:00' })
  ];
  assert.deepEqual(C.tasksFor(tasks, 's1', D).map(t => t.id), ['d', 'c', 'a', 'b']);
  assert.deepEqual(C.tasksFor(tasks, 's2', D).map(t => t.id), ['e']);
  assert.deepEqual(C.tasksFor(null, 's1', D), []);
});

/* ── 진행·상태 ── */

test('taskSteps normalizes labels/ids/ext', () => {
  const t = mkTask({ steps: ['문자열', { label: '객체', ext: 'studyforce_admin' }, { id: 'x', label: '' }, { id: 'k', label: '아이디 있음' }] });
  const s = C.taskSteps(t);
  assert.deepEqual(s.map(x => x.label), ['문자열', '객체', '아이디 있음']);
  assert.equal(s[0].id, 't1-s1');
  assert.equal(s[1].ext, 'studyforce_admin');
  assert.equal(s[2].id, 'k');
  assert.deepEqual(C.taskSteps(null), []);
});

test('taskProgress / statusOf / isDone / autoDone', () => {
  const steps = mkTask({ steps: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] });
  assert.deepEqual(C.taskProgress(steps, null), { done: 0, total: 2, unit: '단계', pct: 0 });
  assert.deepEqual(C.taskProgress(steps, { steps: { a: true } }), { done: 1, total: 2, unit: '단계', pct: 50 });
  assert.equal(C.statusOf(steps, { steps: { a: true } }), 'doing');
  assert.equal(C.statusOf(steps, { blocked: true, steps: { a: true } }), 'blocked');
  assert.equal(C.statusOf(steps, { done: true }), 'done');
  assert.equal(C.statusOf(steps, null), 'todo');
  assert.equal(C.autoDone(steps, { steps: { a: true } }), false);
  assert.equal(C.autoDone(steps, { steps: { a: true, b: true } }), true);

  const count = mkTask({ target: 3, unit: '건' });
  assert.deepEqual(C.taskProgress(count, { count: 2 }), { done: 2, total: 3, unit: '건', pct: 67 });
  assert.equal(C.autoDone(count, { count: 3 }), true);
  assert.equal(C.statusOf(count, { count: 1 }), 'doing');

  const plain = mkTask();
  assert.deepEqual(C.taskProgress(plain, { done: true }), { done: 1, total: 1, unit: '', pct: 100 });
  assert.equal(C.autoDone(plain, {}), null, 'manual-only task never auto-completes');
  assert.ok(!C.isDone(plain, null) && C.isDone(plain, { done: true }));
});

test('carriedTasks lists unfinished past occurrences within lookback, skipping carry:false', () => {
  const tasks = [mkTask({ id: 'c1', repeat: 'daily', start: '2026-09-01' }), mkTask({ id: 'c2', repeat: 'daily', start: '2026-09-01', carry: false })];
  const checks = { 'c1|2026-09-08': { done: true }, 'c1|2026-09-06': { steps: {} } };
  const out = C.carriedTasks(tasks, checks, 's1', D, 3);
  assert.deepEqual(out.map(x => x.date), ['2026-09-07', '2026-09-06']);
  assert.equal(out[0].daysAgo, 2);
  assert.equal(out[1].status, 'todo');
});

/* ── 지시서 변환 ── */

test('parseAssignments accepts JSON string, array or {assignments}', () => {
  assert.equal(C.parseAssignments('{bad').error, 'JSON 형식이 잘못되었습니다');
  assert.equal(C.parseAssignments('[{"staff":"a"}]').list.length, 1);
  assert.equal(C.parseAssignments({ assignments: [{}, null, 'x'] }).list.length, 1);
  assert.equal(C.parseAssignments(42).list.length, 0);
});

test('applyAssignmentsPure: name match, field rules, ext filtering, runbook passthrough, skipped unknown staff', () => {
  let n = 0;
  const opts = { uid: () => 'u' + (++n), now: () => 1000, today: () => D, linkFor: k => (k === 'studyforce_admin' ? { key: k } : null) };
  const staff = [{ id: 's1', name: '김직원' }, { id: 's2', name: '박 직원' }];
  const list = [
    { staff: ' 김직원 ', title: '[R-1300-SF] 점검', detail: 'd', guide: 'g', steps: ['한 줄', { label: '링크', ext: 'studyforce_admin' }, { label: '모르는 키', ext: 'nope_key' }, { label: '형식 위반', ext: 'Bad-Key1' }],
      time: '13:00', priority: 'high', repeat: 'weekday', runbookSlotId: 'R-1300-SF', runbookPackVersion: '2026.09-1', window: 45, carry: true },
    { staff: '박직원', title: '요일', repeat: 'days', days: [1, 3, 9, -1], start: '2026-09-10', end: '2026-12-31', target: '4', unit: '반', time: '9:00' },
    { staffId: 's2', title: 'id로 지정', repeat: 'bogus' },
    { staff: '없는사람', title: '건너뜀' }
  ];
  const r = C.applyAssignmentsPure(list, staff, opts);
  assert.equal(r.tasks.length, 3);
  assert.deepEqual(r.skipped, [{ staff: '없는사람', title: '건너뜀' }]);
  const t = r.tasks[0];
  assert.equal(t.staffId, 's1');
  assert.equal(t.title, '[R-1300-SF] 점검');
  assert.deepEqual(t.steps.map(s => s.label), ['한 줄', '링크', '모르는 키', '형식 위반']);
  assert.equal(t.steps[1].ext, 'studyforce_admin');
  assert.ok(!('ext' in t.steps[2]) && !('ext' in t.steps[3]), 'unknown / malformed ext keys are dropped');
  assert.equal(t.runbookSlotId, 'R-1300-SF');
  assert.equal(t.runbookPackVersion, '2026.09-1');
  assert.equal(t.window, 45);
  assert.equal(t.priority, 'high');
  assert.equal(t.start, D, 'start defaults to today');
  assert.equal(t.carry, true);
  assert.equal(t.createdAt, 1000);
  assert.equal(t.groupId, 'ai-1000');
  const u = r.tasks[1];
  assert.equal(u.staffId, 's2', 'whitespace-insensitive name match');
  assert.deepEqual(u.days, [1, 3]);
  assert.equal(u.target, 4);
  assert.equal(u.unit, '반');
  assert.equal(u.time, '', 'HH:MM only');
  assert.equal(u.end, '2026-12-31');
  assert.equal(r.tasks[2].repeat, 'once');
  assert.ok(!('runbookSlotId' in r.tasks[2]));
  assert.ok(r.tasks.every(x => C.DOC_ID_RE.test(x.id)));
});

/* ── roster ── */

test('studentsToRoster: start from since or earliest program since; end for ended/paused', () => {
  const students = [
    { id: 'a', name: 'A', grade: '중2', since: '2026-03', status: 'active', programs: { studyforce: { since: '2026-05-01' } } },
    { id: 'b', name: 'B', status: 'active', programs: { studyforce: { since: '2026-05-01' }, classcard: { since: '2026-04-15' } } },
    { id: 'c', name: 'C', status: 'ended', programs: { studyforce: { since: '2026-01-01', until: '2026-06-30' } } },
    { id: 'd', name: 'D', status: 'ended', programs: { nelt: { until: '2026-12-01' } } },
    { id: 'e', name: 'E', status: 'paused' },
    { id: 'f', name: 'F', deleted: true },
    { id: '', name: 'no id' }
  ];
  const r = C.studentsToRoster(students, '2026-09');
  assert.deepEqual(r.map(x => x.id), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(r[0], { id: 'a', name: 'A', grade: '중2', start: '2026-03' });
  assert.equal(r[1].start, '2026-04');
  assert.equal(r[2].end, '2026-06', 'ended with a past until → that month');
  assert.equal(r[3].end, '2026-09', 'ended with a future until → this month');
  assert.equal(r[4].end, '2026-09', 'paused → excluded from this month');
  assert.ok(!('end' in r[0]));
});

test('searchStudents filters by name/code/grade and status, sorted by name', () => {
  const students = [
    { id: '1', name: '홍길동', code: 'SF-012', grade: '중2', status: 'active' },
    { id: '2', name: '김영희', code: 'SF-020', grade: '고1', status: 'paused' },
    { id: '3', name: '박철수', status: 'ended' },
    { id: '4', name: '삭제', deleted: true }
  ];
  assert.deepEqual(C.searchStudents(students, '', 'all').map(s => s.id), ['2', '3', '1']);
  assert.deepEqual(C.searchStudents(students, 'sf-0', '').map(s => s.id), ['2', '1']);
  assert.deepEqual(C.searchStudents(students, '고1', 'paused').map(s => s.id), ['2']);
  assert.deepEqual(C.searchStudents(students, '', 'ended').map(s => s.id), ['3']);
});

/* ── 문서 병합·큐 ── */

test('mergeDocs applies server docs per collection, honors pending keys, drops deleted, ignores older', () => {
  const local = {
    staff: [], tasks: [{ id: 't1', title: 'old' }], checks: { 'k|d': { done: false } }, students: [], contacts: [], settings: {},
    meta: { 'tasks|t1': 100, 'checks|k|d': 100 }
  };
  const docs = [
    { c: 'tasks', id: 't1', data: { title: 'new' }, updatedAt: 200 },
    { c: 'checks', id: 'k|d', data: { done: true }, updatedAt: 50 },           // older → ignored
    { c: 'checks', id: 'p|d', data: { done: true }, updatedAt: 300 },          // pending → skipped
    { c: 'students', id: 's1', data: { name: '학생' }, updatedAt: 300 },
    { c: 'students', id: 's2', data: { name: '지움' }, updatedAt: 300, deleted: 1 },
    { c: 'contacts', id: 'c1', data: { studentId: 's1' }, updatedAt: 300 },
    { c: 'staff', id: 'st1', data: { name: '직원', role: 'staff', active: 1 }, updatedAt: 300 },
    { c: 'settings', id: 'main', data: { orgName: 'WB' }, updatedAt: 300 },
    { c: 'unknown', id: 'x', data: {}, updatedAt: 300 },
    { c: 'tasks', id: 't9', data: { title: 'flag-deleted', deleted: true }, updatedAt: 300 },
    null
  ];
  const r = C.mergeDocs(local, docs, ['checks|p|d']);
  assert.equal(r.skipped, 1);
  assert.equal(r.changed, 7);
  assert.equal(r.local.tasks[0].title, 'new');
  assert.equal(r.local.checks['k|d'].done, false);
  assert.ok(!('p|d' in r.local.checks));
  assert.deepEqual(r.local.students, [{ name: '학생', id: 's1' }]);
  assert.equal(r.local.contacts.length, 1);
  assert.equal(r.local.staff[0].name, '직원');
  assert.equal(r.local.settings.orgName, 'WB');
  assert.equal(r.local.meta['tasks|t1'], 200);
  assert.equal(r.local.meta['students|s1'], 300);
  assert.ok(!r.local.tasks.some(t => t.id === 't9'));
  assert.equal(local.tasks[0].title, 'old', 'input untouched');
  assert.deepEqual(r.local.base['tasks|t1'], { title: 'new' }, 'base keeps the last server value');
  assert.equal(r.local.base['students|s2'], null, 'deleted → null base');
  assert.ok(!('checks|p|d' in r.local.base), 'pending docs do not touch base');
});

test('revertDoc: base value when known, delete document when the server never had it', () => {
  const local = { base: { 'students|s1': { name: '서버값' } }, meta: { 'students|s1': 300, 'students|new': 0 } };
  assert.deepEqual(C.revertDoc(local, 'students|s1'), { c: 'students', id: 's1', data: { name: '서버값' }, updatedAt: 300, deleted: false });
  assert.deepEqual(C.revertDoc(local, 'students|new'), { c: 'students', id: 'new', data: {}, updatedAt: 0, deleted: true });
  assert.deepEqual(C.revertDoc(local, 'checks|a|b'), { c: 'checks', id: 'a|b', data: {}, updatedAt: 0, deleted: true }, 'id may contain |');
  assert.equal(C.revertDoc(local, 'nokey'), null);
});

test('slug: lowercase alnum of the requested length, deterministic with a fixed rand', () => {
  assert.match(C.slug(12), /^[a-z0-9]{12}$/);
  assert.equal(C.slug(4, () => 0), 'aaaa');
  assert.equal(C.slug(3, () => 0.999), '999');
  assert.ok(/^[A-Za-z0-9_-]{1,64}$/.test('stu_' + C.slug(12)), 'fits the requests targetRef rule');
});

test('outbox: coalesces per key, ack removes settled entries only, splits ok/stale/failed', () => {
  const ob = C.createOutbox();
  ob.put('checks', 'a|d', { done: false });
  ob.put('checks', 'a|d', { done: true });
  ob.put('students', 's1', { name: 'x' });
  ob.put('students', 's2', { name: 'y' }, true);
  assert.equal(ob.size(), 3);
  assert.deepEqual(ob.keys(), ['checks|a|d', 'students|s1', 'students|s2']);
  const sent = ob.snapshot(200);
  assert.equal(sent[0].data.done, true);
  assert.equal(sent[2].deleted, true);
  ob.put('checks', 'a|d', { done: false });   // 전송 중 다시 바뀜
  const r = ob.ack(sent, [
    { c: 'checks', id: 'a|d', updatedAt: 10 },
    { c: 'students', id: 's1', error: 'stale', code: 'STALE', current: { data: { name: 'server' }, updatedAt: 9 } },
    { c: 'students', id: 's2', error: 'forbidden', code: 'FORBIDDEN' }
  ]);
  assert.deepEqual(r.ok, [{ key: 'checks|a|d', c: 'checks', id: 'a|d', updatedAt: 10 }]);
  assert.equal(r.stale[0].current.data.name, 'server');
  assert.equal(r.failed[0].code, 'FORBIDDEN');
  assert.ok(ob.has('checks|a|d'), 'changed during flight → stays queued');
  assert.equal(ob.snapshot()[0].data.done, false);
  assert.ok(!ob.has('students|s1') && !ob.has('students|s2'));
  ob.clear();
  assert.equal(ob.size(), 0);
});

/* ── 전화·검증 ── */

test('normalizePhone / maskPhone', () => {
  assert.equal(C.normalizePhone('01012345678'), '010-1234-5678');
  assert.equal(C.normalizePhone('010 1234 5678'), '010-1234-5678');
  assert.equal(C.normalizePhone('0212345678'), '02-1234-5678');
  assert.equal(C.normalizePhone('021234567'), '02-123-4567');
  assert.equal(C.normalizePhone('0311234567'), '031-123-4567');
  assert.equal(C.normalizePhone('12345678'), '1234-5678');
  assert.equal(C.normalizePhone('123456'), '123456');
  assert.equal(C.normalizePhone(''), '');
  assert.equal(C.maskPhone('01012345678'), '010-****-5678');
  assert.equal(C.maskPhone('02-123-4567'), '02-***-4567');
  assert.equal(C.maskPhone('12345678'), '****-5678');
  assert.equal(C.maskPhone('123456'), '**3456');
  assert.equal(C.maskPhone(''), '');
});

test('hasPII catches phone, email, RRN; leaves codes alone', () => {
  assert.ok(C.hasPII('연락 010-1234-5678 부탁'));
  assert.ok(C.hasPII('a.b@c.kr'));
  assert.ok(C.hasPII('900101-1234567'));
  assert.ok(!C.hasPII('SF-012 2단계') && !C.hasPII('MAT-0001') && !C.hasPII(''));
});

test('validateStudent: normalizes value and rejects PII outside guardian.phone', () => {
  const ok = C.validateStudent({
    name: ' 홍길동 ', grade: '중2', code: 'SF-012', status: 'active', since: '2026-03', memo: '붉은 책 2단계',
    programs: { studyforce: { active: true, plan: '월 구독', since: '2026-03-02', account: 'issued' }, nelt: { active: false } },
    guardian: { relation: '모', phone: '010 1234 5678', consent: true }
  });
  assert.ok(ok.ok, JSON.stringify(ok.errors));
  assert.equal(ok.value.name, '홍길동');
  assert.equal(ok.value.guardian.phone, '010-1234-5678');
  assert.deepEqual(Object.keys(ok.value.programs), ['studyforce', 'classcard', 'metamath', 'nelt']);
  assert.deepEqual(ok.value.programs.classcard, { active: false, account: 'none' });
  assert.equal(ok.value.programs.studyforce.since, '2026-03-02');
  assert.ok(!('until' in ok.value.programs.studyforce), 'empty optionals omitted');

  const bad = C.validateStudent({
    name: '', grade: '너무긴학년표기입니다열자넘김', code: 'x'.repeat(21), status: 'gone', since: '2026-3', memo: '엄마 01012345678',
    programs: { classcard: { plan: 'p'.repeat(41), since: '2026-13-01', account: 'weird' } },
    guardian: { relation: '관계가열자를넘어갑니다요', phone: '123' }
  });
  assert.ok(!bad.ok);
  const fields = bad.errors.map(e => e.field);
  ['name', 'grade', 'code', 'status', 'since', 'memo', 'programs.classcard.plan', 'programs.classcard.since', 'programs.classcard.account', 'guardian.relation', 'guardian.phone']
    .forEach(f => assert.ok(fields.includes(f), 'flags ' + f));
  assert.ok(!C.validateStudent({ name: '홍길동', guardian: { phone: '010-1234-5678x' } }).ok, 'letters in phone');
  assert.ok(C.validateStudent({ name: '홍길동' }).ok, 'name alone is enough');
});

test('validateContact', () => {
  const ok = C.validateContact({ studentId: 's1', type: 'call', result: 'reached', note: ' 통화 완료 ' });
  assert.deepEqual(ok, { ok: true, errors: [], value: { studentId: 's1', type: 'call', result: 'reached', note: '통화 완료' } });
  const bad = C.validateContact({ type: 'fax', result: 'meh', note: '010-1234-5678' });
  assert.deepEqual(bad.errors.map(e => e.field), ['studentId', 'type', 'result', 'note']);
  assert.ok(!C.validateContact({ studentId: 's1', type: 'msg', result: 'note', note: 'x'.repeat(201) }).ok);
});

/* ── 요약 ── */

test('alertsToday counts done/late/blocked with a dueLimit function', () => {
  const tasks = [
    mkTask({ id: 'a', time: '09:00' }),
    mkTask({ id: 'b', time: '10:00' }),
    mkTask({ id: 'c', time: '' }),
    mkTask({ id: 'd', time: '08:00', staffId: 's2' }),
    mkTask({ id: 'e', time: '20:00' })
  ];
  const checks = { ['a|' + D]: { done: true }, ['d|' + D]: { blocked: true, note: '사이트 점검' }, ['b|' + D]: { steps: {}, count: 1 } };
  const r = C.alertsToday(tasks, checks, ['s1', 's2'], D, '12:00', t => (t.time ? C.minToHM(C.hmToMin(t.time) + 30) : ''));
  assert.equal(r.total, 5);
  assert.equal(r.done, 1);
  assert.deepEqual(r.late.map(l => l.taskId), ['b']);
  assert.equal(r.late[0].dueLimit, '10:30');
  assert.deepEqual(r.blocked.map(b => b.taskId), ['d']);
  assert.equal(r.blocked[0].note, '사이트 점검');
  assert.equal(r.todo, 3, 'b·c·e');
  assert.equal(r.doing, 0, 'count without target is not doing');
  const def = C.alertsToday(tasks, checks, ['s1'], D, '10:30');
  assert.deepEqual(def.late.map(l => l.taskId), [], 'default window is 60 min');
});

test('briefText: one paragraph with done/pending/blocked and no student identifiers', () => {
  const staff = [{ id: 's1', name: '김직원' }, { id: 's2', name: '박직원' }];
  const tasks = [mkTask({ id: 'a', title: '명단 점검', time: '13:00' }), mkTask({ id: 'b', title: '세트 배정', staffId: 's2' }), mkTask({ id: 'c', title: '막힌 일', staffId: 's2' })];
  const checks = { ['a|' + D]: { done: true }, ['c|' + D]: { blocked: true, note: '사이트 점검 중' } };
  const txt = C.briefText({ date: D, staff, tasks, checks, nowHM: '21:00' });
  assert.ok(txt.startsWith('📊 9월 9일 (수) 프로그램데스크 마감 브리핑\n전체 3건 중 1건 완료 (33%)'));
  assert.ok(txt.includes('🚧 막힘 1건'));
  assert.ok(txt.includes('· 박직원 — 막힌 일'));
  assert.ok(txt.includes('“사이트 점검 중”'));
  assert.ok(txt.includes('⚠️ 미완료 1건'));
  assert.ok(txt.includes('· 박직원 — 세트 배정'));
  assert.ok(txt.includes('✅ 전원 완료: 김직원'));
  const empty = C.briefText({ date: D, staff: [], tasks: [], checks: {} });
  assert.ok(empty.includes('전체 0건 중 0건 완료 (0%)') && empty.includes('✅ 미완료 없음'));
});

/* ── 라우트 ── */

test('routeOf / inviteLink', () => {
  assert.deepEqual(C.routeOf('#/students'), { route: 'students', room: '', code: '' });
  assert.deepEqual(C.routeOf('#/students/extra?x'), { route: 'students', room: '', code: '' });
  assert.deepEqual(C.routeOf('#c=AbC-123_x'), { route: 'today', room: '', code: 'AbC-123_x' });
  assert.deepEqual(C.routeOf('#/nope'), { route: 'today', room: '', code: '' });
  assert.deepEqual(C.routeOf(''), { route: 'today', room: '', code: '' });
  assert.deepEqual(C.routeOf('#c=<script>'), { route: 'today', room: '', code: '' });
  assert.equal(C.inviteLink('https://wb-desk.example', '/index.html', 'abc'), 'https://wb-desk.example/#c=abc');
  assert.equal(C.inviteLink('https://wb-desk.example', '/', 'abc'), 'https://wb-desk.example/#c=abc');
});

test('seedPerfsets derives program setup from student records without overriding saved rows', () => {
  const students = [
    { id: 'stu_a', name: '학생A', status: 'active', programs: { studyforce: { active: true }, classcard: { active: false }, metamath: { active: true } } },
    { id: 'stu_b', name: '학생B', status: 'active', programs: { classcard: { active: true } } },
    { id: 'stu_c', name: '학생C', status: 'ended', programs: { studyforce: { active: true } } },
    { id: 'stu_d', name: '학생D', status: 'active', programs: {} }
  ];
  const saved = { '__perfset__stu_b|all': { studentId: 'stu_b', progs: ['studyforce'], dueDays: { studyforce: [1, 3] }, target: null, from: 'bulk' } };
  const r = C.seedPerfsets(students, saved, { perfsetKey: id => '__perfset__' + id + '|all', dueDays: [1, 2, 3, 4, 5] });
  assert.deepEqual(r.checks['__perfset__stu_a|all'].progs, ['studyforce'], '메타수학은 수행 판정 대상이 아니다');
  assert.equal(r.checks['__perfset__stu_a|all'].from, 'students');
  assert.deepEqual(r.checks['__perfset__stu_b|all'].progs, ['studyforce'], '사람이 저장한 행은 학생 문서가 덮지 않는다');
  assert.ok(!r.checks['__perfset__stu_c|all'] && !r.checks['__perfset__stu_d|all']);
  const again = C.seedPerfsets([students[1]], r.checks, {});
  assert.ok(!again.checks['__perfset__stu_a|all'], '학생이 사라지면 파생 행도 사라진다');
  assert.ok(again.checks['__perfset__stu_b|all']);
});

/* ── 배정 카드·템플릿·앱·매뉴얼 (기획서 v1.1) ── */

test('routeOf: 프로그램 방(#/p/<room>)·매뉴얼·매트릭스·모르는 방은 today', () => {
  assert.deepEqual(C.routeOf('#/p/classcard'), { route: 'room', room: 'classcard', code: '' });
  assert.deepEqual(C.routeOf('#/p/nope'), { route: 'today', room: '', code: '' });
  assert.equal(C.routeOf('#/manuals').route, 'manuals');
  assert.equal(C.routeOf('#/matrix').route, 'matrix');
  assert.equal(C.routeOf('#/room').route, 'today');
  assert.deepEqual(C.routeOf('#c=abcd'), { route: 'today', room: '', code: 'abcd' });
  assert.deepEqual(C.ROOMS, ['studyforce', 'classcard', 'metamath', 'nelt', 'exam4you', 'jokbo']);
});

const STUDENTS = [
  { id: 'st1', name: '학생A', grade: '중2', status: 'active', programs: { studyforce: { active: true }, classcard: { active: false } } },
  { id: 'st2', name: '학생B', status: 'active', programs: { studyforce: { active: true } } },
  { id: 'st3', name: '학생C', status: 'ended', programs: { studyforce: { active: true } } },
  { id: 'st4', name: '학생D', status: 'active', deleted: true, programs: { studyforce: { active: true } } }
];
const APPS = [{ id: 'app1', name: '국어 내신 앱', active: true }, { id: 'app2', name: '옛 앱', active: false }];

test('deriveCards: 요일·대상 4종·비활성 앱·종료 학생·기간·중복(삭제된 id 포함)·결정적 id', () => {
  const plans = [
    { id: 'pl1', kind: 'recurring', program: 'studyforce', days: [1, 2, 3, 4, 5], target: { type: 'each' }, what: '오늘 수행 확인', where: '관리자 수행 화면' },
    { id: 'pl2', kind: 'recurring', program: 'classcard', days: [1], target: { type: 'text', label: '중2A반' }, what: '주간 세트 배정' },
    { id: 'pl3', kind: 'recurring', program: 'exam4you', days: [3], target: { type: 'app', id: 'app1' }, what: '중2 국어 3단원 기출', manualId: 'm-up' },
    { id: 'pl4', kind: 'recurring', program: 'exam4you', days: [3], target: { type: 'app', id: 'app2' }, what: '비활성 앱' },
    { id: 'pl5', kind: 'recurring', program: 'nelt', days: [3], target: { type: 'student', id: 'st3' }, what: '종료 학생' },
    { id: 'pl6', kind: 'recurring', program: 'metamath', days: [3], target: { type: 'student', id: 'st1' }, what: '꺼진 템플릿', active: false },
    { id: 'pl7', kind: 'recurring', program: 'metamath', days: [3], target: { type: 'student', id: 'st1' }, what: '기간 밖', start: '2026-09-10' },
    { id: 'pl8', kind: 'apprange', appId: 'app1', unit: '3단원' },
    { id: 'pl9', kind: 'recurring', program: 'studyforce', days: [3], target: { type: 'each' }, what: '지난 템플릿', end: '2026-09-08' }
  ];
  const r = C.deriveCards(plans, STUDENTS, APPS, [], D, 1000);
  assert.deepEqual(r.cards.map(c => c.id).sort(), ['p:pl1:2026-09-09:st1', 'p:pl1:2026-09-09:st2', 'p:pl3:2026-09-09:app1']);
  assert.deepEqual(r.cards.find(c => c.id === 'p:pl1:2026-09-09:st1'),
    { id: 'p:pl1:2026-09-09:st1', program: 'studyforce', target: { type: 'student', id: 'st1' }, what: '오늘 수행 확인', status: 'todo', due: D, source: 'plan:pl1', createdAt: 1000, where: '관리자 수행 화면' });
  assert.equal(r.cards.find(c => c.id === 'p:pl3:2026-09-09:app1').manualId, 'm-up');
  const again = C.deriveCards(plans, STUDENTS, APPS, r.cards.slice(0, 2), D, 2000, ['p:pl3:2026-09-09:app1']);
  assert.deepEqual([again.cards.length, again.skipped], [0, 3], '있는 카드·서버가 아는(지운) id 는 다시 만들지 않는다');
  const mon = C.deriveCards(plans, STUDENTS, APPS, [], '2026-09-07', 0);
  const text = mon.cards.find(c => c.program === 'classcard');
  assert.deepEqual([text.id, text.target], ['p:pl2:2026-09-07:중2a반', { type: 'text', label: '중2A반' }]);
  assert.equal(C.planCardId('pl1', D, ''), 'p:pl1:2026-09-09:-');
});

const CARDS = [
  { id: 'c1', program: 'studyforce', target: { type: 'student', id: 'st1' }, what: 'a', status: 'todo', due: D, createdAt: 5 },
  { id: 'c2', program: 'studyforce', target: { type: 'student', id: 'st1' }, what: 'b', status: 'doing', due: '2026-09-08' },
  { id: 'c3', program: 'classcard', target: { type: 'text', label: '중2A' }, what: 'c', status: 'blocked', blockedReason: 'x', due: D },
  { id: 'c4', program: 'metamath', target: { type: 'student', id: 'st2' }, what: 'd', status: 'done', due: D, doneAt: new Date(2026, 8, 9, 10).getTime() },
  { id: 'c5', program: 'nelt', target: { type: 'student', id: 'st2' }, what: 'e', status: 'done', due: '2026-09-01', doneAt: new Date(2026, 8, 1, 10).getTime() },
  { id: 'c6', program: 'exam4you', target: { type: 'app', id: 'app1' }, what: 'f', status: 'todo', due: '2026-09-10' },
  { id: 'c7', program: 'jokbo', target: { type: 'text', label: 'x' }, what: 'g', status: 'todo' },
  { id: 'c8', program: 'studyforce', target: { type: 'student', id: 'st1' }, what: 'h', status: 'todo', due: D, deleted: true }
];

test('cardsOn: 막힘 → 지연 → 오늘 → 기한 없음, 예정은 따로, 오늘 완료만, 삭제·옛 완료 제외 · daysUntil', () => {
  const on = C.cardsOn(CARDS, D);
  assert.deepEqual(on.open.map(c => c.id), ['c3', 'c2', 'c1', 'c7']);
  assert.deepEqual(on.upcoming.map(c => c.id), ['c6']);
  assert.deepEqual(on.done.map(c => c.id), ['c4']);
  assert.deepEqual([C.daysUntil(CARDS[5], D), C.daysUntil(CARDS[0], D), C.daysUntil(CARDS[1], D), C.daysUntil({ due: '2026-09-30' }, D), C.daysUntil({}, D)], [1, null, null, 21, null]);
  assert.deepEqual([C.cardLate(CARDS[1], D), C.cardLate(CARDS[0], D), C.cardLate(CARDS[4], D)], [true, false, false]);
  const g = C.groupByRoom(on.open);
  assert.deepEqual(Object.keys(g), C.ROOMS);
  assert.deepEqual([g.studyforce.map(c => c.id), g.classcard.map(c => c.id), g.jokbo.map(c => c.id), g.nelt], [['c2', 'c1'], ['c3'], ['c7'], []]);
});

test('matrixOf: 이용 중 학생 × 방, 칸 = 구독 + 마지막 카드 · coverageOf: 앱 × 범위 상태 건수', () => {
  const m = C.matrixOf(STUDENTS, CARDS, D);
  assert.deepEqual(m.map(r => r.id), ['st1', 'st2']);
  assert.deepEqual(m[0].cells.studyforce, { sub: true, status: 'todo', due: D, late: false, what: 'a' });
  assert.deepEqual(m[0].cells.classcard, { sub: false, status: '', due: '', late: false, what: '' });
  assert.deepEqual([m[0].cells.exam4you.sub, m[1].cells.metamath.status, m[1].cells.nelt.status], [null, 'done', 'done']);
  const cov = C.coverageOf(APPS, [
    { id: 'r1', kind: 'apprange', appId: 'app1', subject: '국어', grade: '중2', unit: '3단원', status: 'need' },
    { id: 'r2', kind: 'apprange', appId: 'app1', subject: '국어', grade: '중2', unit: '1단원', status: 'have' },
    { id: 'r3', kind: 'apprange', appId: 'app9', unit: '없는 앱', status: 'need' },
    { id: 'pl', kind: 'recurring', program: 'nelt', days: [1], target: { type: 'each' }, what: 'x' }
  ]);
  assert.deepEqual(cov.map(c => [c.app.id, c.total, c.counts]), [['app1', 2, { need: 1, buying: 0, uploading: 0, have: 1 }], ['app2', 0, { need: 0, buying: 0, uploading: 0, have: 0 }]]);
  assert.deepEqual(cov[0].rows.map(r => r.unit), ['1단원', '3단원']);
});

test('deriveCards(exam): 시험 leadDays 전부터 학교·학년이 맞는 학생 × 자료마다 한 번, 창 밖·꺼짐·학교 불일치 제외', () => {
  const students = [
    { id: 's1', name: '학생A', grade: '중2', school: 'OO중', status: 'active' },
    { id: 's2', name: '학생B', grade: '중2', school: 'OO 중', status: 'active' },     // 공백 차이는 같은 학교
    { id: 's3', name: '학생C', grade: '중3', school: 'OO중', status: 'active' },      // 학년 다름
    { id: 's4', name: '학생D', grade: '중2', school: 'XX중', status: 'active' },      // 학교 다름
    { id: 's5', name: '학생E', grade: '중2', school: 'OO중', status: 'ended' }
  ];
  const exam = { id: 'ex1', kind: 'exam', school: 'OO중', grade: '중2', subject: '영어', examName: '2학기 중간', examDate: '2026-09-30', scope: '3~4과', leadDays: 21, dueDaysBefore: 7,
    materials: [{ source: 'exam4you', what: '교과서 변형 3~4과', where: '학생 폴더' }, { source: 'jokbo', what: '기출 3개년' }, { source: 'other', what: '무시' }] };
  const r = C.deriveCards([exam], students, [], [], D, 7);   // D = 9/9 = 시험 21일 전 → 창이 열리는 첫날
  assert.deepEqual(r.cards.map(c => c.id).sort(), ['p:ex1:m0:s1', 'p:ex1:m0:s2', 'p:ex1:m1:s1', 'p:ex1:m1:s2']);
  const first = r.cards.find(c => c.id === 'p:ex1:m0:s1');
  assert.deepEqual(first, { id: 'p:ex1:m0:s1', program: 'exam4you', target: { type: 'student', id: 's1' }, what: '교과서 변형 3~4과', status: 'todo', due: '2026-09-23', source: 'plan:ex1', createdAt: 7,
    note: 'OO중 · 중2 · 영어 · 2학기 중간 · 2026-09-30 · 3~4과', where: '학생 폴더' });
  assert.equal(r.cards.find(c => c.id === 'p:ex1:m1:s2').program, 'jokbo');
  assert.deepEqual([C.deriveCards([exam], students, [], [], '2026-09-08', 0).cards.length, C.deriveCards([exam], students, [], [], '2026-10-01', 0).cards.length,
    C.deriveCards([Object.assign({}, exam, { active: false })], students, [], [], D, 0).cards.length], [0, 0, 0]);
  const again = C.deriveCards([exam], students, [], r.cards, '2026-09-10', 0);
  assert.deepEqual([again.cards.length, again.skipped], [0, 4], '다음 날엔 같은 카드를 다시 만들지 않는다');
  const anyGrade = C.deriveCards([Object.assign({}, exam, { grade: '' })], students, [], [], D, 0);
  assert.equal(anyGrade.cards.length, 6, '학년을 비우면 그 학교 이용 중 학생 전체');
});

test('staffStats: 기간 안 완료 건수·기한 넘김·처리 시간(중앙값·평균), doneBy 별', () => {
  const t = (y, m, d, h) => new Date(y, m - 1, d, h).getTime();
  const cards = [
    { id: 'a', program: 'nelt', target: { type: 'text', label: 'x' }, what: 'a', status: 'done', due: '2026-09-08', doneBy: 'st1', createdAt: t(2026, 9, 8, 9), doneAt: t(2026, 9, 8, 10) },    // 60분
    { id: 'b', program: 'nelt', target: { type: 'text', label: 'x' }, what: 'b', status: 'done', due: '2026-09-07', doneBy: 'st1', createdAt: t(2026, 9, 9, 9), doneAt: t(2026, 9, 9, 12) },    // 180분, 기한 넘김
    { id: 'c', program: 'nelt', target: { type: 'text', label: 'x' }, what: 'c', status: 'done', doneBy: 'st1', createdAt: t(2026, 9, 9, 9), doneAt: t(2026, 9, 9, 9, 0) },                   // 0분
    { id: 'd', program: 'nelt', target: { type: 'text', label: 'x' }, what: 'd', status: 'done', doneBy: 'st2', createdAt: 0, doneAt: t(2026, 9, 9, 9) },                                     // 시간 없음
    { id: 'e', program: 'nelt', target: { type: 'text', label: 'x' }, what: 'e', status: 'done', doneBy: 'st2', createdAt: t(2026, 8, 1, 9), doneAt: t(2026, 8, 1, 10) },                    // 기간 밖
    { id: 'f', program: 'nelt', target: { type: 'text', label: 'x' }, what: 'f', status: 'todo', due: D }
  ];
  const rows = C.staffStats(cards, D, 7);
  assert.deepEqual(rows, [
    { staffId: 'st1', done: 3, lateDone: 1, timed: 3, avgMinutes: 80, medianMinutes: 60 },
    { staffId: 'st2', done: 1, lateDone: 0, timed: 0, avgMinutes: null, medianMinutes: null }
  ]);
  assert.equal(C.staffStats(cards, D, 30).find(r => r.staffId === 'st2').done, 1, '8/1 완료는 30일 창 밖');
  assert.equal(C.staffStats(cards, D, 60).find(r => r.staffId === 'st2').done, 2, '60일 창엔 들어온다');
});

test('validateExam: 필수·범위·자료 줄 파싱·PII · validateStudent school', () => {
  assert.equal(C.validateExam({ school: '' }).error, '학교을(를) 입력하세요');
  assert.equal(C.validateExam({ school: 'OO중', examDate: '2026-9-30' }).error, '시험일은 YYYY-MM-DD 형식입니다');
  assert.equal(C.validateExam({ school: 'OO중', examDate: '2026-09-30', materialsText: '' }).error, '자료를 한 줄 이상 적으세요 (출처 | 무엇을 | 어디에)');
  assert.ok(/시작해야/.test(C.validateExam({ school: 'OO중', examDate: '2026-09-30', materialsText: '네이버 | 자료' }).error));
  assert.ok(/앞설 수 없습니다/.test(C.validateExam({ school: 'OO중', examDate: '2026-09-30', leadDays: '7', dueDaysBefore: '7', materialsText: '이그잼포유 | 자료' }).error));
  assert.deepEqual(C.validateExam({ school: ' OO중 ', grade: '중2', subject: '영어', examName: '2학기 중간', examDate: '2026-09-30', scope: '3~4과', leadDays: '', dueDaysBefore: '',
    materialsText: '이그잼포유 | 교과서 변형 3~4과 | 학생 폴더\n\n족보닷컴 | 기출 3개년\nJokbo | 변형 문제' }), {
    value: { kind: 'exam', school: 'OO중', examDate: '2026-09-30', leadDays: 21, dueDaysBefore: 7, active: true,
      materials: [{ source: 'exam4you', what: '교과서 변형 3~4과', where: '학생 폴더' }, { source: 'jokbo', what: '기출 3개년' }, { source: 'jokbo', what: '변형 문제' }],
      grade: '중2', subject: '영어', examName: '2학기 중간', scope: '3~4과' }, error: '' });
  assert.ok(/개인정보/.test(C.validateExam({ school: 'OO중', examDate: '2026-09-30', materialsText: '이그잼포유 | 자료 | 010-0000-0000' }).error));
  const st = C.validateStudent({ name: '학생A', grade: '중2', school: ' OO중 ', programs: {}, guardian: {} });
  assert.equal(st.value.school, 'OO중');
  assert.ok(C.validateStudent({ name: '학생A', school: '학교 010-0000-0000', programs: {}, guardian: {} }).errors.some(e => e.field === 'school'));
  assert.deepEqual(C.searchStudents([{ id: '1', name: '학생A', school: 'OO중' }, { id: '2', name: '학생B', school: 'XX중' }], 'OO', 'all').map(s => s.id), ['1']);
});

test('manualFor·manualsFor: manualId 우선, 앱 카드는 app 범위, 방은 assign 우선', () => {
  const manuals = [
    { id: 'm1', scope: 'classcard', task: 'check', title: '결과 확인' },
    { id: 'm2', scope: 'classcard', task: 'assign', title: '세트 배정' },
    { id: 'm3', scope: 'app', task: 'upload', title: '앱 업로드', appId: 'app1' },
    { id: 'm4', scope: 'app', task: 'upload', title: '다른 앱', appId: 'app2' },
    { id: 'm5', scope: 'exam4you', task: 'download', title: '다운로드', deleted: true }
  ];
  assert.equal(C.manualFor(manuals, { program: 'classcard', target: { type: 'text', label: 'x' } }).id, 'm2');
  assert.equal(C.manualFor(manuals, { program: 'classcard', target: { type: 'text', label: 'x' }, manualId: 'm1' }).id, 'm1');
  assert.equal(C.manualFor(manuals, { program: 'exam4you', target: { type: 'app', id: 'app1' } }).id, 'm3');
  assert.equal(C.manualFor(manuals, { program: 'exam4you', target: { type: 'student', id: 'st1' } }), null);
  assert.deepEqual(C.manualsFor(manuals, 'classcard').map(m => m.id), ['m2', 'm1']);
  assert.deepEqual(C.manualsFor(manuals, 'app', 'app2').map(m => m.id), ['m4']);
});

test('validateCard·validateRecurring·validateRange·validateApp·validateManual', () => {
  assert.equal(C.validateCard({ program: 'kakao' }).error, '프로그램을 고르세요');
  assert.equal(C.validateCard({ program: 'classcard', targetType: 'student', targetId: '' }).error, '학생을 고르세요');
  assert.equal(C.validateCard({ program: 'classcard', targetType: 'text', targetLabel: '중2A', what: '' }).error, '무엇을을(를) 입력하세요');
  assert.ok(/개인정보/.test(C.validateCard({ program: 'classcard', targetType: 'text', targetLabel: '중2A', what: '엄마 010-0000-0000' }).error));
  assert.equal(C.validateCard({ program: 'classcard', targetType: 'text', targetLabel: '중2A', what: '세트', due: '2026-9-9' }).error, '기한은 YYYY-MM-DD 형식입니다');
  assert.deepEqual(C.validateCard({ program: 'exam4you', targetType: 'app', targetId: 'app1', what: '3단원 기출', where: '관리 웹', due: D, note: '', manualId: 'm3' }),
    { value: { program: 'exam4you', target: { type: 'app', id: 'app1' }, what: '3단원 기출', status: 'todo', source: 'order', where: '관리 웹', due: D, manualId: 'm3' }, error: '' });

  assert.equal(C.validateRecurring({ program: 'nelt', days: [] }).error, '요일을 하나 이상 고르세요');
  assert.deepEqual(C.validateRecurring({ program: 'studyforce', days: ['5', 1, 1, 9], targetType: 'each', what: '수행 확인', where: '', start: '' }),
    { value: { kind: 'recurring', program: 'studyforce', days: [1, 5], target: { type: 'each' }, what: '수행 확인', active: true }, error: '' });
  assert.equal(C.validateRecurring({ program: 'studyforce', days: [1], targetType: 'app', targetId: '' }).error, '앱을 고르세요');

  assert.equal(C.validateRange({ appId: '' }).error, '앱을 고르세요');
  assert.deepEqual(C.validateRange({ appId: 'app1', unit: ' 3단원 ', subject: '국어', grade: '중2', status: '', source: 'jokbo' }),
    { value: { kind: 'apprange', appId: 'app1', unit: '3단원', status: 'need', source: 'jokbo', subject: '국어', grade: '중2' }, error: '' });

  assert.equal(C.validateApp({ name: '앱', adminUrl: 'http://x' }).error, '관리 웹 주소는 https:// 로 시작해야 합니다');
  assert.deepEqual(C.validateApp({ name: '국어 내신 앱', adminUrl: 'https://example.invalid/admin/' }), { value: { name: '국어 내신 앱', active: true, adminUrl: 'https://example.invalid/admin/' }, error: '' });

  const man = C.validateManual({ scope: 'classcard', task: 'assign', title: '세트 배정', purpose: '', stepsText: '반을 연다\n\n세트를 고른다 ', cautionsText: '이름 금지', linksText: '클래스카드 | https://www.classcard.net/Login' });
  assert.deepEqual(man, { value: { scope: 'classcard', task: 'assign', title: '세트 배정', steps: [{ text: '반을 연다' }, { text: '세트를 고른다' }], cautions: ['이름 금지'], links: [{ label: '클래스카드', url: 'https://www.classcard.net/Login' }], version: 1 }, error: '' });
  assert.ok(/형식/.test(C.validateManual({ scope: 'classcard', task: 'a', title: 't', linksText: 'x http://x' }).error));
  assert.equal(C.validateManual({ scope: 'x', task: 'a', title: 't' }).error, '어느 방의 매뉴얼인지 고르세요');
});
