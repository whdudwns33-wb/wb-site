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
  task(id) { return JSON.parse(this.tasks.get(id).data); }
  async first(sql, args) {
    if (sql.startsWith('SELECT generation FROM app_data_generations')) {
      return { generation: 0 };
    }
    if (sql.startsWith('SELECT staff_id FROM tokens')) {
      return args[2] === 'teacher-token' ? { staff_id: 'teacher-1' } : null;
    }
    if (sql.startsWith('SELECT data FROM staff')) {
      return args[1] === 'teacher-1' ? { data: JSON.stringify(this.staffData) } : null;
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
    if (sql.startsWith('SELECT id,owner,data,updated_at,srv_at FROM tasks WHERE app=? AND id IN')) {
      const ids = new Set(args.slice(1).map(String));
      return { results: [...this.tasks.entries()]
        .filter(([id]) => ids.has(id))
        .map(([id, row]) => ({ id, owner: row.owner, data: row.data,
          updated_at: row.updatedAt, srv_at: row.srvAt })) };
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
