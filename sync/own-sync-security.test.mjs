import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './worker-core.js';

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql.replace(/\s+/g, ' ').trim(); this.args = []; }
  bind(...args) { this.args = args; return this; }
  first() { return this.db.first(this.sql, this.args); }
  all() { return this.db.all(this.sql, this.args); }
  run() { return this.db.run(this.sql, this.args); }
}

class FakeDB {
  constructor(staffData = { deleted: false }) {
    this.tasks = new Map();
    this.checks = new Map();
    this.makeupCases = new Map();
    this.batchCalls = 0;
    this.staffData = staffData;
  }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    this.batchCalls += 1;
    return Promise.all(statements.map(statement => statement.run()));
  }
  seedTask(data, owner = data.staffId, updatedAt = 100) {
    this.tasks.set(data.id, { owner, data: JSON.stringify(data), updatedAt, srvAt: updatedAt });
  }
  seedCheck(key, data, owner = 'teacher-1', updatedAt = 100) {
    this.checks.set(key, { owner, data: JSON.stringify(data), updatedAt, srvAt: updatedAt });
  }
  seedMakeupCase(data) { this.makeupCases.set(String(data.case_id), { ...data }); }
  task(id) { return JSON.parse(this.tasks.get(id).data); }
  async first(sql, args) {
    if (sql.startsWith('SELECT generation FROM app_data_generations')) {
      return { generation: 0 };
    }
    if (sql.startsWith('SELECT staff_id FROM tokens')) {
      if (args[2] === 'teacher-token') return { staff_id: 'teacher-1' };
      if (args[2] === 'teacher-2-token') return { staff_id: 'teacher-2' };
      return null;
    }
    if (sql.startsWith('SELECT data FROM staff')) {
      return ['teacher-1', 'teacher-2'].includes(String(args[1]))
        ? { data: JSON.stringify(this.staffData) } : null;
    }
    if (sql.startsWith('SELECT data FROM private_rosters')) {
      return { data: JSON.stringify({ roster: { students: [] } }) };
    }
    if (sql.startsWith('SELECT owner,data,updated_at,srv_at FROM checks')) {
      const row = this.checks.get(String(args[1]));
      return row ? { owner: row.owner, data: row.data, updated_at: row.updatedAt, srv_at: row.srvAt } : null;
    }
    throw new Error('Unhandled first SQL: ' + sql);
  }
  async all(sql, args) {
    if (sql.startsWith('SELECT DISTINCT snapshot.task_id,task.data FROM book_order_student_snapshots')) {
      return { results: [] };
    }
    if (sql.startsWith('SELECT check_key FROM student_session_attendance_events')) {
      return { results: [] };
    }
    if (sql.startsWith('SELECT check_key FROM student_session_ledger_events')) {
      return { results: [] };
    }
    if (sql.startsWith('SELECT id,owner,data,updated_at,srv_at FROM tasks WHERE app=? AND id IN')) {
      const ids = new Set(args.slice(1).map(String));
      return { results: [...this.tasks.entries()]
        .filter(([id]) => ids.has(id))
        .map(([id, row]) => ({ id, owner: row.owner, data: row.data,
          updated_at: row.updatedAt, srv_at: row.srvAt })) };
    }
    if (sql.startsWith('SELECT id,owner,data FROM tasks WHERE app=? AND id IN')) {
      const ids = new Set(args.slice(1).map(String));
      return { results: [...this.tasks.entries()]
        .filter(([id]) => ids.has(id))
        .map(([id, row]) => ({ id, owner: row.owner, data: row.data })) };
    }
    if (sql.startsWith('SELECT id,data FROM tasks WHERE app=? AND id IN')) {
      const ids = new Set(args.slice(1).map(String));
      return { results: [...this.tasks.entries()]
        .filter(([id]) => ids.has(id))
        .map(([id, row]) => ({ id, data: row.data })) };
    }
    if (sql.startsWith('SELECT id,data FROM tasks WHERE app=? AND owner=?')) {
      const owner = args[1];
      const ids = new Set(args.slice(2).map(String));
      return { results: [...this.tasks.entries()]
        .filter(([id, row]) => ids.has(id) && row.owner === owner)
        .map(([id, row]) => ({ id, data: row.data })) };
    }
    if (sql.startsWith('SELECT id,owner FROM tasks WHERE app=? AND id IN')) {
      const ids = new Set(args.slice(1).map(String));
      return { results: [...this.tasks.entries()]
        .filter(([id]) => ids.has(id))
        .map(([id, row]) => ({ id, owner: row.owner })) };
    }
    if (sql.startsWith('SELECT id FROM tasks WHERE app=? AND owner=? AND id IN')) {
      const owner = args[1];
      const ids = new Set(args.slice(2).map(String));
      return { results: [...this.tasks.entries()]
        .filter(([id, row]) => ids.has(id) && row.owner === owner)
        .map(([id]) => ({ id })) };
    }
    if (sql.startsWith('SELECT k,owner,data,updated_at,srv_at FROM checks WHERE app=? AND k IN')) {
      const keys = new Set(args.slice(1).map(String));
      return { results: [...this.checks.entries()]
        .filter(([key]) => keys.has(key))
        .map(([k, row]) => ({ k, owner: row.owner, data: row.data,
          updated_at: row.updatedAt, srv_at: row.srvAt })) };
    }
    if (sql.includes('FROM makeup_cases WHERE app=? AND case_id IN')) {
      const ids = new Set(args.slice(1).map(String));
      return { results: [...this.makeupCases.entries()]
        .filter(([id]) => ids.has(id))
        .map(([, row]) => ({ ...row })) };
    }
    const pull = sql.match(/^SELECT (id|k) AS key, owner, data, updated_at, srv_at FROM (staff|tasks|checks)/);
    if (pull) {
      const table = pull[2];
      const source = table === 'tasks' ? this.tasks : table === 'checks' ? this.checks : new Map();
      const since = Number(args[1]);
      const owner = args[2];
      return { results: [...source.entries()]
        .filter(([, row]) => row.srvAt > since && (!owner || row.owner === owner))
        .map(([key, row]) => ({ key, owner: row.owner, data: row.data,
          updated_at: row.updatedAt, srv_at: row.srvAt })) };
    }
    throw new Error('Unhandled all SQL: ' + sql);
  }
  async run(sql, args) {
    const match = sql.match(/^INSERT INTO (staff|tasks|checks)/);
    if (!match) throw new Error('Unhandled run SQL: ' + sql);
    const table = match[1];
    const [, key, owner, data, updatedAt, srvAt] = args;
    const target = table === 'tasks' ? this.tasks : this.checks;
    const current = target.get(key);
    if (!current) {
      target.set(key, { owner, data, updatedAt, srvAt });
      return { meta: { changes: 1 } };
    }
    const currentData = JSON.parse(current.data);
    const guarded = current.owner === owner && (table !== 'tasks' || currentData.origin === 'staff');
    if (guarded && Number(updatedAt) > Number(current.updatedAt)) {
      target.set(key, { owner, data, updatedAt, srvAt });
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }
}

const auth = { mode: 'person', id: 'teacher-1', token: 'teacher-token' };
const task = (id, origin, title) => ({ id, staffId: 'teacher-1', origin, title, deleted: false, updatedAt: 100 });
const kstDate = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
const kstStamp = (date, time) => Date.parse(date + 'T' + time + ':00+09:00');
const attendance = (date, at, out = null, updatedAt = at) => ({
  taskId: '__att__teacher-1', date, done: true, note: '', steps: {}, count: 0, blocked: false,
  at, out, updatedAt
});
const change = (data, updatedAt = 200) => ({
  table: 'tasks', id: data.id, owner: 'teacher-1', data, updated_at: updatedAt
});

function seedReassignedMakeup(db, overrides = {}) {
  const caseId = overrides.caseId || 'mu_reassigned';
  const taskId = 'makeup_lesson_' + caseId;
  const priorDate = overrides.priorDate || '2026-09-06';
  const currentDate = overrides.currentDate || '2026-09-07';
  const sourceDate = overrides.sourceDate || '2026-09-01';
  const sourceTaskId = overrides.sourceTaskId || 'source-lesson';
  const currentOwner = overrides.currentOwner || 'teacher-2';
  const formerOwner = overrides.formerOwner || 'teacher-1';
  const taskData = {
    id: taskId, staffId: currentOwner, origin: 'makeup', title: '[수업] 보강', deleted: false,
    taskKind: 'lesson_instruction', lessonFormVersion: 1, studentId: 'student-a',
    lessonInstanceType: 'makeup', makeupCaseId: caseId, makeupSourceTaskId: sourceTaskId,
    makeupSourceDate: sourceDate, repeat: 'once', start: currentDate, end: currentDate
  };
  Object.assign(taskData, overrides.taskData || {});
  db.seedTask(taskData, currentOwner);
  const history = overrides.history || [
    { action: 'schedule', staffId: formerOwner, date: priorDate, startTime: '13:00', endTime: '13:50', revision: 2 },
    { action: 'reschedule', previousStaffId: formerOwner, previousDate: priorDate,
      previousStartTime: '13:00', previousEndTime: '13:50', staffId: currentOwner,
      date: currentDate, startTime: '14:00', endTime: '14:50', revision: 3 }
  ];
  db.seedMakeupCase({
    case_id: caseId, student_id: 'student-a', source_task_id: sourceTaskId, source_date: sourceDate,
    status: 'confirmed', revision: 3, confirmed_staff_id: currentOwner,
    confirmed_start_at: currentDate + 'T14:00:00+09:00',
    confirmed_end_at: currentDate + 'T14:50:00+09:00', history: JSON.stringify(history)
  });
  return { caseId, taskId, priorDate, currentDate };
}

function cancelCanonicalMakeup(db, action = 'no_makeup') {
  const makeup = seedReassignedMakeup(db, {
    caseId: 'mu_cancelled_' + action,
    currentOwner: 'teacher-1', formerOwner: 'teacher-1'
  });
  const taskRow = db.tasks.get(makeup.taskId);
  const taskData = JSON.parse(taskRow.data);
  taskData.deleted = true;
  taskRow.data = JSON.stringify(taskData);
  const row = db.makeupCases.get(makeup.caseId);
  const history = JSON.parse(row.history);
  history.push({ action, from: 'confirmed', to: 'cancelled', actorId: 'director', revision: 4 });
  Object.assign(row, {
    status: 'cancelled', revision: 4, completed_at: null, completed_by: null,
    cancelled_at: 400, cancelled_by: 'director', history: JSON.stringify(history)
  });
  return makeup;
}

function completeCanonicalMakeup(db, options = {}) {
  const makeup = seedReassignedMakeup(db, {
    caseId: options.caseId || 'mu_completed',
    currentOwner: 'teacher-1', formerOwner: 'teacher-1'
  });
  const row = db.makeupCases.get(makeup.caseId);
  const history = JSON.parse(row.history);
  history.push({ action: 'complete', from: 'confirmed', to: 'completed', staffId: 'teacher-1',
    date: makeup.currentDate, actorId: 'teacher-1', revision: 4 });
  Object.assign(row, {
    status: 'completed', revision: 4, completed_at: 400, completed_by: 'teacher-1',
    history: JSON.stringify(history)
  });
  if (options.deleted) {
    const taskRow = db.tasks.get(makeup.taskId);
    const taskData = JSON.parse(taskRow.data);
    taskData.deleted = true;
    taskRow.data = JSON.stringify(taskData);
  }
  if (options.check !== false) {
    db.seedCheck(makeup.taskId + '|' + makeup.currentDate, {
      taskId: makeup.taskId, date: makeup.currentDate, done: true,
      att: options.serverAtt || 'P', note: 'server note', updatedAt: 200
    }, options.serverOwner || 'teacher-1', 200);
  }
  return makeup;
}

async function sync(db, changes, envOverrides = {}, requestAuth = auth, since = 0) {
  const response = await worker.fetch(new Request('https://worker.example/sync', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app: 'task', auth: requestAuth, since, changes })
  }), { DB: db, TASK_ADMIN_SECRET: 'admin-secret', CONSULT_ADMIN_SECRET: 'consult-secret', ...envOverrides });
  return { status: response.status, body: await response.json() };
}

test('own sync treats every personal staff-row upload as a no-op', async () => {
  const db = new FakeDB();
  const result = await sync(db, [
    { table: 'staff', id: 'teacher-1', owner: 'teacher-1', updated_at: 999,
      data: { id: 'teacher-1', name: 'forged', manager: true, owner: true, deleted: true } },
    { table: 'staff', id: 'teacher-2', owner: 'teacher-2', updated_at: 999,
      data: { id: 'teacher-2', manager: true, deleted: true } }
  ]);
  assert.equal(result.status, 200);
  assert.equal(result.body.authRole, 'staff');
  assert.equal(db.batchCalls, 0);
});

test('staff.manager metadata alone does not elevate personal auth', async () => {
  const db = new FakeDB({ deleted: false, manager: true });
  db.seedTask({ id: 'other-task', staffId: 'teacher-2', origin: 'admin', title: 'other' }, 'teacher-2');
  const result = await sync(db, []);
  assert.equal(result.status, 200);
  assert.equal(result.body.authRole, 'staff');
  assert.equal(result.body.changes.some(item => item.key === 'other-task'), false);
});

test('task manager allowlist grants all-scope sync and reports the server role', async () => {
  const db = new FakeDB({ deleted: false, manager: false });
  db.seedTask({ id: 'other-task', staffId: 'teacher-2', origin: 'admin', title: 'other' }, 'teacher-2');
  const result = await sync(db, [], { TASK_MANAGER_STAFF_IDS: 'teacher-10, teacher-1 ' });
  assert.equal(result.status, 200);
  assert.equal(result.body.authRole, 'manager');
  assert.equal(result.body.changes.some(item => item.key === 'other-task'), true);
});

test('auditable config manager allowlist is additive to the existing secret allowlist', async () => {
  const db = new FakeDB({ deleted: false, manager: false });
  db.seedTask({ id: 'other-task', staffId: 'teacher-2', origin: 'admin', title: 'other' }, 'teacher-2');
  const result = await sync(db, [], {
    TASK_MANAGER_STAFF_IDS: 'other-manager',
    TASK_MANAGER_STAFF_IDS_CONFIG: ' teacher-1 '
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.authRole, 'manager');
  assert.equal(result.body.changes.some(item => item.key === 'other-task'), true);
});

test('root admin sync reports the server admin role', async () => {
  const db = new FakeDB();
  const result = await sync(db, [], {}, { mode: 'admin', secret: 'admin-secret' });
  assert.equal(result.status, 200);
  assert.equal(result.body.authRole, 'admin');
});

test('own sync rejects edits, deletes, and origin forgery against manager rows', async () => {
  for (const mutate of [
    current => ({ ...current, title: 'forged edit' }),
    current => ({ ...current, deleted: true }),
    current => ({ ...current, origin: 'staff', title: 'forged staff edit' })
  ]) {
    const db = new FakeDB();
    const managed = task('managed-1', 'manager', 'director task');
    db.seedTask(managed);
    const result = await sync(db, [change(mutate(managed))]);
    assert.equal(result.status, 403);
    assert.deepEqual(db.task('managed-1'), managed);
  }
});

test('semantic-identical manager task upload is an accepted no-op', async () => {
  const db = new FakeDB();
  const managed = task('managed-1', 'admin', 'director task');
  db.seedTask(managed);
  const reordered = { title: managed.title, updatedAt: 100, deleted: false,
    origin: 'admin', staffId: 'teacher-1', id: 'managed-1' };
  const result = await sync(db, [change(reordered, 999)]);
  assert.equal(result.status, 200);
  assert.equal(db.tasks.get('managed-1').updatedAt, 100);
  assert.deepEqual(db.task('managed-1'), managed);
});

test('staff-origin own task creation and editing remain allowed', async () => {
  const db = new FakeDB();
  const existing = task('staff-1', 'staff', 'old title');
  db.seedTask(existing);
  let result = await sync(db, [change({ ...existing, title: 'new title', updatedAt: 200 })]);
  assert.equal(result.status, 200);
  assert.equal(db.task('staff-1').title, 'new title');

  const created = task('staff-2', 'staff', 'created by staff');
  result = await sync(db, [change(created, 300)]);
  assert.equal(result.status, 200);
  assert.equal(db.task('staff-2').origin, 'staff');
});

test('generic own sync cannot mint or mutate lesson authorization and permits only an exact replay', async () => {
  const forged = [
    { taskKind: 'lesson_instruction', studentId: 'student-a' },
    { lessonFormVersion: 1, studentId: 'student-a' },
    { intakeVersion: 1, studentId: 'student-a' },
    { studentId: 'student-a' },
    { title: '[수업] 위조 수업' }
  ];
  for (let index = 0; index < forged.length; index += 1) {
    const db = new FakeDB();
    const candidate = { ...task('forged-' + index, 'staff', '일반 업무'), ...forged[index] };
    const result = await sync(db, [change(candidate, 300)]);
    assert.equal(result.status, 403);
    assert.equal(db.tasks.size, 0);
  }

  const db = new FakeDB();
  const lesson = { ...task('server-lesson', 'staff', '[수업] 서버 수업'),
    taskKind: 'lesson_instruction', lessonFormVersion: 2, studentId: 'student-a' };
  db.seedTask(lesson);
  const replay = await sync(db, [change({ ...lesson }, 999)]);
  assert.equal(replay.status, 200);
  assert.equal(db.tasks.get(lesson.id).updatedAt, 100, 'exact replay는 서버 정본을 다시 쓰지 않는다');

  const changedStudent = await sync(db, [change({ ...lesson, studentId: 'student-b', updatedAt: 999 }, 999)]);
  assert.equal(changedStudent.status, 403);
  assert.deepEqual(db.task(lesson.id), lesson);

  const plain = task('plain-task', 'staff', '일반 업무');
  db.seedTask(plain);
  const converted = await sync(db, [change({ ...plain, studentId: 'student-a', updatedAt: 400 }, 400)]);
  assert.equal(converted.status, 403);
  assert.deepEqual(db.task(plain.id), plain);
});

test('generic sync skips every stale server-authored makeup copy but cannot mint a makeup task', async () => {
  const adminAuth = { mode: 'admin', secret: 'admin-secret' };
  const db = new FakeDB();
  const makeup = {
    ...task('makeup_mu_a', 'admin', '[수업] 보강 수업'),
    taskKind: 'lesson_instruction', lessonFormVersion: 2, studentId: 'student-a',
    lessonInstanceType: 'makeup', makeupCaseId: 'mu_a', makeupSourceTaskId: 'lesson-a'
  };
  db.seedTask(makeup);

  const replay = await sync(db, [change({ ...makeup }, 999)], {}, adminAuth);
  assert.equal(replay.status, 200);
  assert.equal(db.batchCalls, 0, '서버 정본의 동일 재전송은 쓰지 않는다');
  assert.equal(replay.body.changes.filter(item => item.table === 'tasks' && item.key === makeup.id).length, 1,
    'forced 정본과 일반 pull은 같은 task를 중복 반환하지 않는다');

  for (const mutated of [
    { ...makeup, title: '[수업] 임의 수정', updatedAt: 999 },
    { ...makeup, deleted: true, updatedAt: 1, lessonRevision: 1 },
    { id: makeup.id, staffId: makeup.staffId, origin: makeup.origin, title: '일반 업무로 위장', deleted: true, updatedAt: 999 }
  ]) {
    const result = await sync(db, [change(mutated, 999)], {}, adminAuth);
    assert.equal(result.status, 200);
    assert.equal(db.batchCalls, 0, '서버에 존재하는 보강 task의 stale copy는 쓰지 않는다');
    assert.deepEqual(db.task(makeup.id), makeup);
  }

  const ownStale = await sync(db, [change({ ...makeup, title: '오래된 개인기기 사본', updatedAt: 1,
    lessonRevision: 1 }, 1)]);
  assert.equal(ownStale.status, 200);
  assert.deepEqual(db.task(makeup.id), makeup);
  const ownNewerMutation = await sync(db, [change({ ...makeup, title: '서버보다 최신으로 보이는 변조 사본',
    updatedAt: 9999, lessonRevision: 999 }, 9999)], {}, auth, 500);
  assert.equal(ownNewerMutation.status, 200);
  assert.equal(db.batchCalls, 0);
  assert.deepEqual(db.task(makeup.id), makeup);
  const canonical = ownNewerMutation.body.changes.filter(item => item.table === 'tasks' && item.key === makeup.id);
  assert.equal(canonical.length, 1);
  assert.equal(canonical[0].authoritative, true);
  assert.deepEqual(canonical[0].data, makeup);

  const forged = { ...makeup, id: 'makeup_mu_forged', makeupCaseId: 'mu_forged' };
  const created = await sync(db, [{ table: 'tasks', id: forged.id, owner: forged.staffId,
    data: forged, updated_at: 999 }], {}, adminAuth);
  assert.equal(created.status, 409);
  assert.equal(created.body.code, 'MAKEUP_ENDPOINT_REQUIRED');
  assert.equal(db.tasks.has(forged.id), false);

  const regular = task('regular-existing', 'staff', '일반 업무');
  db.seedTask(regular);
  const converted = await sync(db, [change({ ...regular, lessonInstanceType: 'makeup',
    makeupCaseId: 'mu_convert', updatedAt: 999 }, 999)], {}, adminAuth);
  assert.equal(converted.status, 409);
  assert.equal(converted.body.code, 'MAKEUP_ENDPOINT_REQUIRED');
  assert.deepEqual(db.task(regular.id), regular);
});

test('task envelope id, staffId, and origin are server-validated', async () => {
  const cases = [
    { ...task('task-1', 'staff', 'x'), id: 'inner-other' },
    { ...task('task-2', 'staff', 'x'), staffId: 'teacher-2' },
    task('task-3', 'manager', 'x')
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const db = new FakeDB();
    const outerId = 'task-' + (index + 1);
    const result = await sync(db, [{ table: 'tasks', id: outerId, owner: 'teacher-1', data: cases[index], updated_at: 200 }]);
    assert.equal(result.status, 403);
    assert.equal(db.tasks.size, 0);
  }
});

test('staff progress checks still sync normally', async () => {
  const db = new FakeDB();
  db.seedTask(task('staff-1', 'manager', 'assigned task'));
  const result = await sync(db, [{
    table: 'checks', k: 'staff-1|2026-08-04', owner: 'teacher-1',
    data: { taskId: 'staff-1', date: '2026-08-04', done: true, steps: { 'step-1': true }, updatedAt: 200 },
    updated_at: 200
  }]);
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(db.checks.get('staff-1|2026-08-04').data).done, true);
});

test('staff attendance creation and first clock-out require the dedicated endpoint', async () => {
  const db = new FakeDB();
  const date = kstDate();
  const key = '__att__teacher-1|' + date;
  const at = kstStamp(date, '09:00');
  const out = kstStamp(date, '18:00');

  let result = await sync(db, [{ table: 'checks', k: key, owner: 'teacher-1',
    data: attendance(date, at), updated_at: at }]);
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'STAFF_ATTENDANCE_ADMIN_ONLY');
  assert.equal(db.checks.has(key), false);

  db.seedCheck(key, attendance(date, at), 'teacher-1', at);
  result = await sync(db, [{ table: 'checks', k: key, owner: 'teacher-1',
    data: attendance(date, at, out, out), updated_at: out }]);
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'STAFF_ATTENDANCE_ADMIN_ONLY');
  assert.equal(JSON.parse(db.checks.get(key).data).out, null);
});

test('an exact cached attendance replay is accepted as a no-op without changing its revision', async () => {
  const db = new FakeDB();
  const date = kstDate();
  const key = '__att__teacher-1|' + date;
  const at = kstStamp(date, '09:00');
  const out = kstStamp(date, '18:00');
  const stored = attendance(date, at, out, out);
  db.seedCheck(key, stored, 'teacher-1', out);
  const replay = { ...stored, updatedAt: out + 60000 };
  const result = await sync(db, [{ table: 'checks', k: key, owner: 'teacher-1',
    data: replay, updated_at: replay.updatedAt }]);
  assert.equal(result.status, 200);
  assert.equal(db.batchCalls, 0);
  assert.equal(db.checks.get(key).updatedAt, out);
  assert.deepEqual(JSON.parse(db.checks.get(key).data), stored);
});

test('staff attendance rejects clock-in edits, clock-out cancellation, and completed-record changes', async () => {
  const date = kstDate();
  const key = '__att__teacher-1|' + date;
  const at = kstStamp(date, '09:00');
  const out = kstStamp(date, '18:00');
  const cases = [
    current => ({ ...current, at: at + 60000, updatedAt: out + 1 }),
    current => ({ ...current, done: false, at: null, out: null, updatedAt: out + 1 }),
    current => ({ ...current, out: null, updatedAt: out + 1 }),
    current => ({ ...current, out: out + 60000, updatedAt: out + 60001 })
  ];
  for (const mutate of cases) {
    const db = new FakeDB();
    const stored = attendance(date, at, out, out);
    db.seedCheck(key, stored, 'teacher-1', out);
    const incoming = mutate(stored);
    const result = await sync(db, [{ table: 'checks', k: key, owner: 'teacher-1',
      data: incoming, updated_at: incoming.updatedAt }]);
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'STAFF_ATTENDANCE_ADMIN_ONLY');
    assert.deepEqual(JSON.parse(db.checks.get(key).data), stored);
  }
});

test('staff cannot backdate attendance but admin can correct an existing record', async () => {
  const date = kstDate();
  const priorDate = new Date(Date.parse(date + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
  const priorAt = kstStamp(priorDate, '09:00');
  const db = new FakeDB();
  const priorKey = '__att__teacher-1|' + priorDate;
  let result = await sync(db, [{ table: 'checks', k: priorKey, owner: 'teacher-1',
    data: attendance(priorDate, priorAt), updated_at: priorAt }]);
  assert.equal(result.status, 403);

  const key = '__att__teacher-1|' + date;
  const at = kstStamp(date, '09:00');
  const correctedAt = kstStamp(date, '09:15');
  db.seedCheck(key, attendance(date, at), 'teacher-1', at);
  result = await sync(db, [{ table: 'checks', k: key, owner: 'teacher-1',
    data: attendance(date, correctedAt, null, correctedAt), updated_at: correctedAt }], {},
  { mode: 'admin', secret: 'admin-secret' });
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(db.checks.get(key).data).at, correctedAt);
});

test('generic sync ignores server-authored contact rows instead of overwriting them', async () => {
  const db = new FakeDB();
  const result = await sync(db, [{
    table: 'checks', k: '__contact__server-key|2026-08-14', owner: 'teacher-1',
    data: { taskId: '__contact__server-key', date: '2026-08-14', done: true, updatedAt: 999 },
    updated_at: 999
  }]);
  assert.equal(result.status, 200);
  assert.equal(db.checks.size, 0);
  assert.equal(db.batchCalls, 0);
});

test('server-authored contact rows pull to the same teacher on a new device', async () => {
  const db = new FakeDB();
  const key = '__contact__server-key|2026-08-14';
  db.checks.set(key, { owner: 'teacher-1', data: JSON.stringify({
    taskId: '__contact__server-key', date: '2026-08-14', updatedAt: 200,
    contact: { version: 1, studentId: 'student-a', sourceTaskId: 'lesson-1', date: '2026-08-14',
      type: 'call', note: '', by: '담당교사', byStaffId: 'teacher-1', at: 200 }
  }), updatedAt: 200, srvAt: 200 });
  const result = await sync(db, []);
  assert.equal(result.status, 200);
  assert.equal(result.body.changes.some(item => item.table === 'checks' && item.key === key), true);
});

test('own sync rejects checks for another task or embedded special owner', async () => {
  for (const forged of [
    { k: 'victim-task|2026-08-04', data: { taskId: 'victim-task', date: '2026-08-04', done: true } },
    { k: '__att__teacher-2|2026-08-04', data: { taskId: '__att__teacher-2', date: '2026-08-04', done: true } }
  ]) {
    const db = new FakeDB();
    db.seedTask({ id: 'victim-task', staffId: 'teacher-2', origin: 'manager' }, 'teacher-2');
    const result = await sync(db, [{ table: 'checks', owner: 'teacher-1', updated_at: 200, ...forged }]);
    assert.equal(result.status, 403);
    assert.equal(db.checks.size, 0);
  }
});

test('former makeup assignee stale check is skipped while an ordinary same-batch change still syncs', async () => {
  const db = new FakeDB();
  const makeup = seedReassignedMakeup(db);
  db.seedTask(task('ordinary-task', 'manager', '일반 업무'));
  const staleTask = { ...db.task(makeup.taskId), staffId: 'teacher-1',
    start: makeup.priorDate, end: makeup.priorDate, updatedAt: 250 };

  const result = await sync(db, [
    { table: 'tasks', id: makeup.taskId, owner: 'teacher-1', data: staleTask, updated_at: 250 },
    { table: 'checks', k: makeup.taskId + '|' + makeup.priorDate, owner: 'teacher-1',
      data: { taskId: makeup.taskId, date: makeup.priorDate, done: true, att: 'P', updatedAt: 300 },
      updated_at: 300 },
    { table: 'checks', k: 'ordinary-task|2026-09-06', owner: 'teacher-1',
      data: { taskId: 'ordinary-task', date: '2026-09-06', done: true, updatedAt: 301 },
      updated_at: 301 }
  ]);

  assert.equal(result.status, 200);
  assert.equal(db.checks.has(makeup.taskId + '|' + makeup.priorDate), false,
    '철회된 과거 담당자의 오프라인 출결은 서버에 쓰지 않는다');
  assert.equal(db.checks.has('ordinary-task|2026-09-06'), true,
    '같은 batch의 정상 업무 체크는 poison되지 않고 저장한다');
  assert.equal(result.body.changes.some(item => item.key === makeup.taskId), false,
    '과거 담당자에게 현재 담당 보강 task나 학생 정보를 반환하지 않는다');
});

test('same assignee date-only reschedule drops the exact stale date without poisoning the batch', async () => {
  const db = new FakeDB();
  const makeup = seedReassignedMakeup(db, { currentOwner: 'teacher-1', formerOwner: 'teacher-1' });
  db.seedTask(task('ordinary-task', 'manager', '일반 업무'));
  const result = await sync(db, [
    { table: 'checks', k: makeup.taskId + '|' + makeup.priorDate, owner: 'teacher-1',
      data: { taskId: makeup.taskId, date: makeup.priorDate, done: true, att: 'P' }, updated_at: 300 },
    { table: 'checks', k: 'ordinary-task|2026-09-06', owner: 'teacher-1',
      data: { taskId: 'ordinary-task', date: '2026-09-06', done: true }, updated_at: 301 }
  ]);

  assert.equal(result.status, 200);
  assert.equal(db.checks.has(makeup.taskId + '|' + makeup.priorDate), false);
  assert.equal(db.checks.has('ordinary-task|2026-09-06'), true);
});

test('same assignee stale-date quarantine requires the exact prior assignment history', async () => {
  for (const mutate of [
    context => { context.attemptDate = '2026-09-05'; },
    context => {
      const row = context.db.makeupCases.get(context.makeup.caseId);
      const history = JSON.parse(row.history);
      history[1].previousDate = '2026-09-04';
      row.history = JSON.stringify(history);
    }
  ]) {
    const db = new FakeDB();
    const makeup = seedReassignedMakeup(db, { currentOwner: 'teacher-1', formerOwner: 'teacher-1' });
    db.seedTask(task('ordinary-task', 'manager', '일반 업무'));
    const context = { db, makeup, attemptDate: makeup.priorDate };
    mutate(context);
    const result = await sync(db, [
      { table: 'checks', k: makeup.taskId + '|' + context.attemptDate, owner: 'teacher-1',
        data: { taskId: makeup.taskId, date: context.attemptDate, done: true, att: 'P' }, updated_at: 300 },
      { table: 'checks', k: 'ordinary-task|2026-09-06', owner: 'teacher-1',
        data: { taskId: 'ordinary-task', date: '2026-09-06', done: true }, updated_at: 301 }
    ]);
    assert.equal(result.status, 403);
    assert.equal(db.batchCalls, 0);
    assert.equal(db.checks.size, 0);
  }
});

test('all-scope makeup check validation fails closed for unrelated, forged, or wrong-date identities', async () => {
  for (const mutate of [
    context => {
      const row = context.db.makeupCases.get(context.makeup.caseId);
      row.history = JSON.stringify([{ action: 'reschedule', previousStaffId: 'teacher-9',
        previousDate: context.makeup.priorDate, staffId: 'teacher-2', revision: 3 }]);
    },
    context => {
      const row = context.db.makeupCases.get(context.makeup.caseId);
      row.source_task_id = 'different-source-lesson';
    },
    context => { context.attemptDate = '2026-09-05'; },
    context => { context.attemptDate = '2099-09-05'; context.attemptOwner = 'teacher-2'; },
    context => { context.attemptDate = context.makeup.currentDate; context.attemptOwner = 'teacher-9'; }
  ]) {
    const db = new FakeDB();
    const makeup = seedReassignedMakeup(db);
    db.seedTask(task('ordinary-task', 'manager', '일반 업무'));
    const context = { db, makeup, attemptDate: makeup.priorDate, attemptOwner: 'teacher-1' };
    mutate(context);
    const result = await sync(db, [
      { table: 'checks', k: makeup.taskId + '|' + context.attemptDate, owner: context.attemptOwner,
        data: { taskId: makeup.taskId, date: context.attemptDate, done: true, att: 'P' }, updated_at: 300 },
      { table: 'checks', k: 'ordinary-task|2026-09-06', owner: 'teacher-1',
        data: { taskId: 'ordinary-task', date: '2026-09-06', done: true }, updated_at: 301 }
    ], {}, { mode: 'admin', secret: 'admin-secret' });
    assert.equal(result.status, 403);
    assert.equal(db.batchCalls, 0, '위조가 섞인 batch는 정상 변경까지 원자적으로 거부한다');
    assert.equal(db.checks.size, 0);
  }
});

test('all-scope stale admin makeup check is skipped without poisoning an ordinary same-batch check', async () => {
  const db = new FakeDB();
  const makeup = seedReassignedMakeup(db);
  db.seedTask(task('ordinary-task', 'manager', '일반 업무'));
  const staleTask = { ...db.task(makeup.taskId), staffId: 'teacher-1',
    start: makeup.priorDate, end: makeup.priorDate, updatedAt: 250 };
  const result = await sync(db, [
    { table: 'tasks', id: makeup.taskId, owner: 'teacher-1', data: staleTask, updated_at: 250 },
    { table: 'checks', k: makeup.taskId + '|' + makeup.priorDate, owner: 'teacher-1',
      data: { taskId: makeup.taskId, date: makeup.priorDate, done: true, att: 'P' }, updated_at: 300 },
    { table: 'checks', k: 'ordinary-task|2026-09-06', owner: 'teacher-1',
      data: { taskId: 'ordinary-task', date: '2026-09-06', done: true }, updated_at: 301 }
  ], {}, { mode: 'admin', secret: 'admin-secret' });

  assert.equal(result.status, 200);
  assert.equal(db.checks.has(makeup.taskId + '|' + makeup.priorDate), false);
  assert.equal(db.checks.has('ordinary-task|2026-09-06'), true);
});

test('every superseded assignee/date remains quarantined after repeated reschedules and completion', async () => {
  const db = new FakeDB();
  const history = [
    { action: 'schedule', staffId: 'teacher-1', date: '2026-09-05', revision: 2 },
    { action: 'reschedule', previousStaffId: 'teacher-1', previousDate: '2026-09-05',
      staffId: 'teacher-2', date: '2026-09-06', revision: 3 },
    { action: 'reschedule', previousStaffId: 'teacher-2', previousDate: '2026-09-06',
      staffId: 'teacher-3', date: '2026-09-07', revision: 4 },
    { action: 'complete', staffId: 'teacher-3', date: '2026-09-07', revision: 5 }
  ];
  const makeup = seedReassignedMakeup(db, {
    currentOwner: 'teacher-3', formerOwner: 'teacher-1', priorDate: '2026-09-05',
    currentDate: '2026-09-07', history
  });
  Object.assign(db.makeupCases.get(makeup.caseId), {
    status: 'completed', revision: 5, completed_at: 500, completed_by: 'teacher-3'
  });
  db.seedTask(task('ordinary-task', 'manager', '일반 업무'));

  const result = await sync(db, [
    { table: 'checks', k: makeup.taskId + '|2026-09-05', owner: 'teacher-1',
      data: { taskId: makeup.taskId, date: '2026-09-05', done: true, att: 'P' }, updated_at: 300 },
    { table: 'checks', k: makeup.taskId + '|2026-09-06', owner: 'teacher-2',
      data: { taskId: makeup.taskId, date: '2026-09-06', done: true, att: 'L' }, updated_at: 301 },
    { table: 'checks', k: 'ordinary-task|2026-09-06', owner: 'teacher-1',
      data: { taskId: 'ordinary-task', date: '2026-09-06', done: true }, updated_at: 302 }
  ], {}, { mode: 'admin', secret: 'admin-secret' });

  assert.equal(result.status, 200);
  assert.equal(db.checks.has(makeup.taskId + '|2026-09-05'), false);
  assert.equal(db.checks.has(makeup.taskId + '|2026-09-06'), false);
  assert.equal(db.checks.has('ordinary-task|2026-09-06'), true);
});

test('current makeup assignee can sync the canonical task check normally', async () => {
  const db = new FakeDB();
  const makeup = seedReassignedMakeup(db);
  const result = await sync(db, [{
    table: 'checks', k: makeup.taskId + '|' + makeup.currentDate, owner: 'teacher-2',
    data: { taskId: makeup.taskId, date: makeup.currentDate, done: true, att: 'P', updatedAt: 400 },
    updated_at: 400
  }], {}, { mode: 'person', id: 'teacher-2', token: 'teacher-2-token' });

  assert.equal(result.status, 200);
  assert.equal(db.checks.has(makeup.taskId + '|' + makeup.currentDate), true);
  assert.equal(JSON.parse(db.checks.get(makeup.taskId + '|' + makeup.currentDate).data).att, 'P');
});

test('cancelled canonical makeup drops the exact offline check for every supported cancellation action', async () => {
  for (const action of ['cancel', 'no_makeup', 'reconcile_attendance']) {
    const db = new FakeDB();
    const makeup = cancelCanonicalMakeup(db, action);
    db.seedTask(task('ordinary-task', 'manager', '일반 업무'));
    const result = await sync(db, [
      { table: 'checks', k: makeup.taskId + '|' + makeup.currentDate, owner: 'teacher-1',
        data: { taskId: makeup.taskId, date: makeup.currentDate, done: true, att: 'P' },
        updated_at: 500 },
      { table: 'checks', k: 'ordinary-task|2026-09-06', owner: 'teacher-1',
        data: { taskId: 'ordinary-task', date: '2026-09-06', done: true }, updated_at: 501 }
    ]);

    assert.equal(result.status, 200, action + ': ' + JSON.stringify(result.body));
    assert.equal(db.checks.has(makeup.taskId + '|' + makeup.currentDate), false);
    assert.equal(db.checks.has('ordinary-task|2026-09-06'), true);
  }
});

test('cancelled makeup quarantine fails closed for a forged tombstone, history, identity, or existing record', async () => {
  const cases = [
    context => {
      const taskRow = context.db.tasks.get(context.makeup.taskId);
      const data = JSON.parse(taskRow.data); data.deleted = false; taskRow.data = JSON.stringify(data);
    },
    context => {
      const row = context.db.makeupCases.get(context.makeup.caseId);
      const history = JSON.parse(row.history); history.at(-1).action = 'forged';
      row.history = JSON.stringify(history);
    },
    context => { context.owner = 'teacher-9'; },
    context => { context.date = '2026-09-09'; },
    context => {
      context.db.seedCheck(context.makeup.taskId + '|' + context.makeup.currentDate, {
        taskId: context.makeup.taskId, date: context.makeup.currentDate, att: 'P'
      }, 'teacher-1', 200);
    }
  ];
  for (const mutate of cases) {
    const db = new FakeDB();
    const makeup = cancelCanonicalMakeup(db);
    db.seedTask(task('ordinary-task', 'manager', '일반 업무'));
    const context = { db, makeup, owner: 'teacher-1', date: makeup.currentDate };
    mutate(context);
    const result = await sync(db, [
      { table: 'checks', k: makeup.taskId + '|' + context.date, owner: context.owner,
        data: { taskId: makeup.taskId, date: context.date, done: true, att: 'P' }, updated_at: 500 },
      { table: 'checks', k: 'ordinary-task|2026-09-06', owner: 'teacher-1',
        data: { taskId: 'ordinary-task', date: '2026-09-06', done: true }, updated_at: 501 }
    ], {}, { mode: 'admin', secret: 'admin-secret' });

    assert.equal(result.status, 403, JSON.stringify(result.body));
    assert.equal(db.batchCalls, 0);
    assert.equal(db.checks.has('ordinary-task|2026-09-06'), false);
  }
});

test('completed active makeup permits only exact same-att memo updates', async () => {
  const db = new FakeDB();
  const makeup = completeCanonicalMakeup(db);
  const key = makeup.taskId + '|' + makeup.currentDate;
  const result = await sync(db, [{
    table: 'checks', k: key, owner: 'teacher-1', updated_at: 300,
    data: { taskId: makeup.taskId, date: makeup.currentDate, done: true,
      att: 'P', note: 'updated note', updatedAt: 300 }
  }]);

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(JSON.parse(db.checks.get(key).data).att, 'P');
  assert.equal(JSON.parse(db.checks.get(key).data).note, 'updated note');
});

test('completed active makeup drops different or blank attendance without poisoning the batch', async () => {
  for (const incomingAtt of ['A', '']) {
    const db = new FakeDB();
    const makeup = completeCanonicalMakeup(db, { caseId: 'mu_completed_' + (incomingAtt || 'blank') });
    const key = makeup.taskId + '|' + makeup.currentDate;
    db.seedTask(task('ordinary-task', 'manager', '일반 업무'));
    const incoming = { taskId: makeup.taskId, date: makeup.currentDate, done: true, updatedAt: 300 };
    if (incomingAtt) incoming.att = incomingAtt;
    const result = await sync(db, [
      { table: 'checks', k: key, owner: 'teacher-1', data: incoming, updated_at: 300 },
      { table: 'checks', k: 'ordinary-task|2026-09-06', owner: 'teacher-1',
        data: { taskId: 'ordinary-task', date: '2026-09-06', done: true }, updated_at: 301 }
    ]);

    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(JSON.parse(db.checks.get(key).data).att, 'P');
    assert.equal(JSON.parse(db.checks.get(key).data).note, 'server note');
    assert.equal(db.checks.has('ordinary-task|2026-09-06'), true);
  }
});

test('completed active makeup requires an exact canonical server attendance identity', async () => {
  const cases = [
    context => { context.db.checks.delete(context.key); },
    context => {
      const row = context.db.checks.get(context.key);
      row.data = JSON.stringify({ taskId: context.makeup.taskId, date: '2026-09-09', att: 'P' });
    },
    context => { context.db.checks.get(context.key).owner = 'teacher-2'; }
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const db = new FakeDB();
    const makeup = completeCanonicalMakeup(db, { caseId: 'mu_completed_invalid_' + index });
    const key = makeup.taskId + '|' + makeup.currentDate;
    const context = { db, makeup, key,
      incoming: { taskId: makeup.taskId, date: makeup.currentDate, att: 'P', note: 'new' } };
    cases[index](context);
    const result = await sync(db, [{ table: 'checks', k: key, owner: 'teacher-1',
      data: context.incoming, updated_at: 300 }]);
    assert.equal(result.status, 403, JSON.stringify(result.body));
    assert.equal(db.batchCalls, 0);
  }
});

test('legacy cancelled and completed makeup checks with an omitted embedded identity are quarantined per row', async () => {
  for (const status of ['cancelled', 'completed']) {
    for (const omitted of ['taskId', 'date']) {
      const db = new FakeDB();
      const makeup = status === 'cancelled'
        ? cancelCanonicalMakeup(db)
        : completeCanonicalMakeup(db, { caseId: 'mu_completed_legacy_' + omitted });
      const key = makeup.taskId + '|' + makeup.currentDate;
      db.seedTask(task('ordinary-task', 'manager', '일반 업무'));
      const data = { taskId: makeup.taskId, date: makeup.currentDate, att: 'P', note: 'legacy row' };
      delete data[omitted];
      const result = await sync(db, [
        { table: 'checks', k: key, owner: 'teacher-1', data, updated_at: 300 },
        { table: 'checks', k: 'ordinary-task|2026-09-06', owner: 'teacher-1',
          data: { taskId: 'ordinary-task', date: '2026-09-06', done: true }, updated_at: 301 }
      ]);

      assert.equal(result.status, 200, status + '/' + omitted + ': ' + JSON.stringify(result.body));
      if (status === 'cancelled') assert.equal(db.checks.has(key), false);
      else {
        assert.equal(JSON.parse(db.checks.get(key).data).att, 'P');
        assert.equal(JSON.parse(db.checks.get(key).data).note, 'server note');
      }
      assert.equal(db.checks.has('ordinary-task|2026-09-06'), true);
    }
  }
});

test('legacy quarantine still rejects an explicitly conflicting makeup task or date identity', async () => {
  for (const status of ['cancelled', 'completed']) {
    for (const conflicting of ['taskId', 'date']) {
      const db = new FakeDB();
      const makeup = status === 'cancelled'
        ? cancelCanonicalMakeup(db)
        : completeCanonicalMakeup(db, { caseId: 'mu_completed_conflict_' + conflicting });
      const data = { taskId: makeup.taskId, date: makeup.currentDate, att: 'P' };
      data[conflicting] = conflicting === 'taskId' ? 'different-task' : '2026-09-09';
      const result = await sync(db, [{
        table: 'checks', k: makeup.taskId + '|' + makeup.currentDate,
        owner: 'teacher-1', data, updated_at: 300
      }]);
      assert.equal(result.status, 403, status + '/' + conflicting);
      assert.equal(db.batchCalls, 0);
    }
  }
});

test('completed hidden makeup drops all exact-key offline rows while preserving canonical attendance', async () => {
  for (const incomingAtt of ['P', 'A']) {
    const db = new FakeDB();
    const makeup = completeCanonicalMakeup(db, {
      caseId: 'mu_completed_deleted_' + incomingAtt, deleted: true
    });
    const key = makeup.taskId + '|' + makeup.currentDate;
    db.seedTask(task('ordinary-task', 'manager', '일반 업무'));
    const result = await sync(db, [
      { table: 'checks', k: key, owner: 'teacher-1',
        data: { taskId: makeup.taskId, date: makeup.currentDate, att: incomingAtt,
          note: 'offline note' }, updated_at: 300 },
      { table: 'checks', k: 'ordinary-task|2026-09-06', owner: 'teacher-1',
        data: { taskId: 'ordinary-task', date: '2026-09-06', done: true }, updated_at: 301 }
    ]);

    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(JSON.parse(db.checks.get(key).data).att, 'P');
    assert.equal(JSON.parse(db.checks.get(key).data).note, 'server note');
    assert.equal(db.checks.has('ordinary-task|2026-09-06'), true);
  }
});

test('all-scope admin can sync a check only for the current canonical makeup assignee and date', async () => {
  const db = new FakeDB();
  const makeup = seedReassignedMakeup(db);
  const result = await sync(db, [{
    table: 'checks', k: makeup.taskId + '|' + makeup.currentDate, owner: 'teacher-2',
    data: { taskId: makeup.taskId, date: makeup.currentDate, done: true, att: 'L', updatedAt: 410 },
    updated_at: 410
  }], {}, { mode: 'admin', secret: 'admin-secret' });

  assert.equal(result.status, 200);
  assert.equal(JSON.parse(db.checks.get(makeup.taskId + '|' + makeup.currentDate).data).att, 'L');
});

test('check data taskId and date must match its key', async () => {
  const db = new FakeDB();
  db.seedTask(task('staff-1', 'manager', 'assigned task'));
  for (const data of [
    { taskId: 'other-task', date: '2026-08-04', done: true },
    { taskId: 'staff-1', date: '2026-08-05', done: true }
  ]) {
    const result = await sync(db, [{
      table: 'checks', k: 'staff-1|2026-08-04', owner: 'teacher-1', data, updated_at: 200
    }]);
    assert.equal(result.status, 403);
    assert.equal(db.checks.size, 0);
  }
});

test('a safe same-batch staff task can receive its first progress check', async () => {
  const db = new FakeDB();
  const created = task('new-staff-task', 'staff', 'new task');
  const result = await sync(db, [
    change(created, 200),
    { table: 'checks', k: 'new-staff-task|2026-08-04', owner: 'teacher-1',
      data: { taskId: 'new-staff-task', date: '2026-08-04', done: true }, updated_at: 200 }
  ]);
  assert.equal(result.status, 200);
  assert.equal(db.task('new-staff-task').origin, 'staff');
  assert.equal(db.checks.has('new-staff-task|2026-08-04'), true);
});
