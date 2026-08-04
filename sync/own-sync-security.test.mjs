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
  constructor() {
    this.tasks = new Map();
    this.checks = new Map();
    this.batchCalls = 0;
  }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    this.batchCalls += 1;
    return Promise.all(statements.map(statement => statement.run()));
  }
  seedTask(data, owner = data.staffId, updatedAt = 100) {
    this.tasks.set(data.id, { owner, data: JSON.stringify(data), updatedAt, srvAt: updatedAt });
  }
  task(id) { return JSON.parse(this.tasks.get(id).data); }
  async first(sql, args) {
    if (sql.startsWith('SELECT staff_id FROM tokens')) {
      return args[2] === 'teacher-token' ? { staff_id: 'teacher-1' } : null;
    }
    throw new Error('Unhandled first SQL: ' + sql);
  }
  async all(sql, args) {
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
const change = (data, updatedAt = 200) => ({
  table: 'tasks', id: data.id, owner: 'teacher-1', data, updated_at: updatedAt
});

async function sync(db, changes) {
  const response = await worker.fetch(new Request('https://worker.example/sync', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app: 'task', auth, since: 0, changes })
  }), { DB: db, TASK_ADMIN_SECRET: 'admin-secret', CONSULT_ADMIN_SECRET: 'consult-secret' });
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
  assert.equal(db.batchCalls, 0);
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
  let result = await sync(db, [{
    table: 'checks', k: 'staff-1|2026-08-04', owner: 'teacher-1',
    data: { taskId: 'staff-1', date: '2026-08-04', done: true, steps: { 'step-1': true }, updatedAt: 200 },
    updated_at: 200
  }]);
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(db.checks.get('staff-1|2026-08-04').data).done, true);

  result = await sync(db, [{
    table: 'checks', k: '__att__teacher-1|2026-08-04', owner: 'teacher-1',
    data: { taskId: '__att__teacher-1', date: '2026-08-04', done: true, updatedAt: 300 }, updated_at: 300
  }]);
  assert.equal(result.status, 200);
  assert.equal(db.checks.has('__att__teacher-1|2026-08-04'), true);
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
