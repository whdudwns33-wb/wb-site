const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function block(from, to) {
  const start = html.indexOf(from);
  const end = html.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `${from} 블록을 찾을 수 없습니다`);
  return html.slice(start, end);
}

function syncApply(state) {
  const methods = block('collect(since) {', 'async post(path, body)');
  return new Function('state', `
    const ownerOfCheck = () => null;
    const isContactCheckKey = () => false;
    const onboardingServerConfirmedAt = new Map();
    const sync = { ${methods} };
    return sync.apply.bind(sync);
  `)(state);
}

test('forced canonical makeup tombstone replaces a locally newer active makeup task', () => {
  const local = {
    id: 'makeup_lesson_mu-1', title: '[수업] 로컬 변조 보강', updatedAt: 9999, deleted: false,
    lessonInstanceType: 'makeup', makeupCaseId: 'mu-1', makeupSourceTaskId: 'lesson-1'
  };
  const canonical = {
    ...local, title: '[수업] 서버 정본 보강', updatedAt: 100, deleted: true
  };
  const state = { staff: [], checks: {}, tasks: [local] };
  const apply = syncApply(state);

  assert.equal(apply([{
    table: 'tasks', key: canonical.id, data: canonical, updated_at: 100, authoritative: true
  }]), 1);
  assert.deepEqual(state.tasks[0], canonical);
  assert.equal(state.tasks[0].deleted, true, 'server tombstone must hide the stale local makeup lesson');
});

test('timestamp override is limited to an authoritative envelope carrying a same-id makeup marker', () => {
  const regularLocal = { id: 'regular-1', title: '일반 업무', updatedAt: 9999 };
  const regularOlder = { ...regularLocal, title: '서버 일반 업무', updatedAt: 100 };
  const staffLocal = { id: 'staff-1', name: '직원 로컬', updatedAt: 9999 };
  const state = { staff: [staffLocal], checks: {}, tasks: [regularLocal] };
  const apply = syncApply(state);

  assert.equal(apply([{ table: 'tasks', key: regularOlder.id, data: regularOlder,
    updated_at: 100, authoritative: true }]), 0, 'ordinary authoritative tasks keep normal LWW');
  assert.equal(state.tasks[0].title, '일반 업무');

  const dataFlagOnly = { ...regularOlder, authoritative: true, lessonInstanceType: 'makeup' };
  assert.equal(apply([{ table: 'tasks', key: dataFlagOnly.id, data: dataFlagOnly, updated_at: 100 }]), 0,
    'a flag inside client-controlled data is not an authoritative envelope');
  assert.equal(state.tasks[0].title, '일반 업무');

  const mismatched = { ...dataFlagOnly, id: 'different-id' };
  assert.equal(apply([{ table: 'tasks', key: regularLocal.id, data: mismatched,
    updated_at: 100, authoritative: true }]), 0, 'the canonical data id must match its envelope key');
  assert.equal(state.tasks[0].id, regularLocal.id);

  assert.equal(apply([{ table: 'staff', key: staffLocal.id,
    data: { ...staffLocal, name: '서버 직원', updatedAt: 100 }, updated_at: 100, authoritative: true }]), 0);
  assert.equal(state.staff[0].name, '직원 로컬');
});

test('all three persisted makeup identity markers can authorize a forced tombstone independently of deleted state', () => {
  for (const marker of [
    { lessonInstanceType: 'makeup' },
    { makeupCaseId: 'mu-2' },
    { makeupSourceTaskId: 'lesson-2' }
  ]) {
    const local = { id: 'makeup-marker', title: '로컬', updatedAt: 9999 };
    const canonical = { id: local.id, title: '서버', updatedAt: 1, deleted: true, ...marker };
    const state = { staff: [], checks: {}, tasks: [local] };
    assert.equal(syncApply(state)([{
      table: 'tasks', key: local.id, data: canonical, updated_at: 1, authoritative: true
    }]), 1);
    assert.deepEqual(state.tasks[0], canonical);
  }
});

function makeupListReconciler(state, session, save) {
  const source = block('function serverManagedMakeupTaskCaseId(task)', 'async function loadMakeups(force)');
  return new Function('state', 'session', 'save',
    `${source}\nreturn reconcilePersonalMakeupLessonTasks;`)(state, session, save);
}

test('makeup list removes only the previous assignee generated card and preserves tasks and records', () => {
  const generatedA = {
    id: 'makeup_lesson_mu-transfer', staffId: 'staff-a', studentId: 'student-1',
    lessonInstanceType: 'makeup', makeupCaseId: 'mu-transfer',
    makeupSourceTaskId: 'lesson-1', makeupSourceDate: '2026-09-06', deleted: false
  };
  const regular = { id: 'lesson-1', staffId: 'staff-a', studentId: 'student-1', title: '[수업] 정규수업' };
  const markerSpoof = {
    id: 'ordinary-with-marker', staffId: 'staff-a', studentId: 'student-1',
    lessonInstanceType: 'makeup', makeupCaseId: 'mu-transfer',
    makeupSourceTaskId: 'lesson-1', makeupSourceDate: '2026-09-06'
  };
  const identityMismatch = {
    ...generatedA, id: 'makeup_lesson_mu-other', makeupCaseId: 'mu-other'
  };
  const checks = {
    'makeup_lesson_mu-transfer|2026-09-06': { att: 'P', note: '보존할 수업 메모', updatedAt: 90 }
  };
  const row = {
    caseId: 'mu-transfer', sourceTaskId: 'lesson-1', sourceDate: '2026-09-06', studentId: 'student-1',
    status: 'confirmed', hasLessonTask: true, confirmedStaffId: 'staff-b'
  };
  const state = { tasks: [generatedA, regular, markerSpoof, identityMismatch], checks };
  let saves = 0;
  const reconcile = makeupListReconciler(state,
    { isStaffLink: true, isAdmin: false, staffId: 'staff-a' }, () => { saves++; });

  assert.equal(reconcile([row]), 1);
  assert.deepEqual(state.tasks.map(task => task.id), ['lesson-1', 'ordinary-with-marker', 'makeup_lesson_mu-other']);
  assert.equal(state.checks, checks, 'attendance and memo records must not be touched');
  assert.equal(state.checks['makeup_lesson_mu-transfer|2026-09-06'].note, '보존할 수업 메모');
  assert.equal(saves, 1);
});

test('the new assignee keeps the canonical card while absent cases and admin caches stay untouched', () => {
  const generatedB = {
    id: 'makeup_lesson_mu-transfer', staffId: 'staff-b', studentId: 'student-1',
    lessonInstanceType: 'makeup', makeupCaseId: 'mu-transfer',
    makeupSourceTaskId: 'lesson-1', makeupSourceDate: '2026-09-06', deleted: false
  };
  const unseenGenerated = {
    id: 'makeup_lesson_mu-not-returned', staffId: 'staff-b', studentId: 'student-2',
    lessonInstanceType: 'makeup', makeupCaseId: 'mu-not-returned',
    makeupSourceTaskId: 'lesson-2', makeupSourceDate: '2026-09-07', deleted: false
  };
  const row = {
    caseId: 'mu-transfer', sourceTaskId: 'lesson-1', sourceDate: '2026-09-06', studentId: 'student-1',
    status: 'confirmed', hasLessonTask: true, confirmedStaffId: 'staff-b'
  };

  const staffState = { tasks: [generatedB, unseenGenerated], checks: {} };
  assert.equal(makeupListReconciler(staffState,
    { isStaffLink: true, isAdmin: false, staffId: 'staff-b' }, () => assert.fail('must not save'))([row]), 0);
  assert.deepEqual(staffState.tasks, [generatedB, unseenGenerated],
    'the new owner keeps their card and cases omitted from the authoritative response fail closed');

  const managerState = { tasks: [generatedB], checks: {} };
  assert.equal(makeupListReconciler(managerState,
    { isStaffLink: true, isAdmin: true, staffId: 'staff-manager' }, () => assert.fail('must not save'))([row]), 0);
  assert.deepEqual(managerState.tasks, [generatedB], 'all-scope manager cache is not owner-reconciled');
});

test('completed canonical tasks stay with the actual teacher while prior owners and cancelled cases are removed', () => {
  const generated = (caseId, studentId, sourceTaskId, sourceDate, staffId = 'staff-b') => ({
    id: 'makeup_lesson_' + caseId, staffId, studentId,
    lessonInstanceType: 'makeup', makeupCaseId: caseId,
    makeupSourceTaskId: sourceTaskId, makeupSourceDate: sourceDate, deleted: false
  });
  const cases = [
    {
      caseId: 'mu-completed-b', sourceTaskId: 'lesson-1', sourceDate: '2026-09-01', studentId: 'student-1',
      status: 'completed', hasLessonTask: true, confirmedStaffId: 'staff-a', completedStaffId: 'staff-b'
    },
    {
      caseId: 'mu-completed-fallback', sourceTaskId: 'lesson-2', sourceDate: '2026-09-02', studentId: 'student-2',
      status: 'completed', hasLessonTask: true, confirmedStaffId: 'staff-b', completedStaffId: ''
    },
    {
      caseId: 'mu-completed-a', sourceTaskId: 'lesson-3', sourceDate: '2026-09-03', studentId: 'student-3',
      status: 'completed', hasLessonTask: true, confirmedStaffId: 'staff-b', completedStaffId: 'staff-a'
    },
    {
      caseId: 'mu-cancelled', sourceTaskId: 'lesson-4', sourceDate: '2026-09-04', studentId: 'student-4',
      status: 'cancelled', hasLessonTask: true, confirmedStaffId: 'staff-b', completedStaffId: 'staff-b',
      hiddenByAttendanceCorrection: true
    }
  ];
  const checks = {
    'makeup_lesson_mu-completed-b|2026-09-01': { att: 'P', note: '완료 메모' },
    'makeup_lesson_mu-cancelled|2026-09-04': { att: 'P', note: '취소 전 메모' }
  };
  const state = {
    tasks: cases.map(row => generated(row.caseId, row.studentId, row.sourceTaskId, row.sourceDate)), checks
  };
  let saves = 0;
  const removed = makeupListReconciler(state,
    { isStaffLink: true, isAdmin: false, staffId: 'staff-b' }, () => { saves++; })(cases);

  assert.equal(removed, 2);
  assert.deepEqual(state.tasks.map(task => task.id), [
    'makeup_lesson_mu-completed-b', 'makeup_lesson_mu-completed-fallback'
  ]);
  assert.equal(state.checks, checks, 'completed and cancelled lesson records remain archived in checks');
  assert.equal(state.checks['makeup_lesson_mu-completed-b|2026-09-01'].note, '완료 메모');
  assert.equal(saves, 1);
});

test('minimal revocation removes an intermediate assignee card only when every identity matches', () => {
  const generated = {
    id: 'makeup_lesson_mu-private', staffId: 'staff-b', studentId: 'student-7',
    lessonInstanceType: 'makeup', makeupCaseId: 'mu-private',
    makeupSourceTaskId: 'lesson-7', makeupSourceDate: '2026-09-07', deleted: false
  };
  const revocation = {
    caseId: 'mu-private', lessonTaskId: 'makeup_lesson_mu-private', sourceTaskId: 'lesson-7',
    sourceDate: '2026-09-07', studentId: 'student-7'
  };
  assert.deepEqual(Object.keys(revocation).sort(),
    ['caseId', 'lessonTaskId', 'sourceDate', 'sourceTaskId', 'studentId'].sort(),
    'revocation does not expose name, grade, status, history, or parent response');

  const checks = { 'makeup_lesson_mu-private|2026-09-07': { att: 'P', note: '보존 기록' } };
  const exactState = { tasks: [generated], checks };
  let saves = 0;
  assert.equal(makeupListReconciler(exactState,
    { isStaffLink: true, isAdmin: false, staffId: 'staff-b' }, () => { saves++; })([], [revocation]), 1);
  assert.deepEqual(exactState.tasks, []);
  assert.equal(exactState.checks, checks);
  assert.equal(saves, 1);

  for (const [field, wrong] of [
    ['caseId', 'mu-other'], ['lessonTaskId', 'makeup_lesson_mu-other'], ['sourceTaskId', 'lesson-other'],
    ['sourceDate', '2026-09-08'], ['studentId', 'student-other']
  ]) {
    const state = { tasks: [{ ...generated }], checks: {} };
    const mismatched = { ...revocation, [field]: wrong };
    assert.equal(makeupListReconciler(state,
      { isStaffLink: true, isAdmin: false, staffId: 'staff-b' }, () => assert.fail('must not save'))([], [mismatched]), 0,
    `${field} mismatch must fail closed`);
    assert.equal(state.tasks.length, 1);
  }
});

test('loadMakeups passes accepted cases and transient minimal revocations into reconciliation', () => {
  const load = block('async function loadMakeups(force)', 'function makeupReasonSelect');
  assert.ok(load.indexOf('makeupRows = Array.isArray(result.cases) ? result.cases : []') <
    load.indexOf('const revocations = Array.isArray(result.revocations) ? result.revocations : []'));
  assert.match(load, /reconcilePersonalMakeupLessonTasks\(makeupRows, revocations\)/);
  assert.doesNotMatch(load, /makeupRows\s*=\s*makeupRows\.concat\(revocations\)|makeupRows\.push\([^)]*revocation/);
});
