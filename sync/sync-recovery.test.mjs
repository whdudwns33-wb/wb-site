import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import worker from './worker-core.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const admin = { mode: 'admin', secret: 'admin-secret' };
const person = id => ({ mode: 'person', id, token: id + '-token' });

class ReadOnlyStatement {
  constructor(owner, sql) { this.owner = owner; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  first() { return this.owner.database.prepare(this.sql).get(...this.args) || null; }
  all() { return { results: this.owner.database.prepare(this.sql).all(...this.args) }; }
  run() { throw new Error('복구 조회에서 run을 호출할 수 없습니다'); }
}

class ReadOnlyD1 {
  constructor(t) {
    this.database = new DatabaseSync(':memory:');
    this.database.exec(schema);
    this.reads = [];
    t.after(() => this.database.close());
  }
  prepare(sql) {
    assert.match(sql.trim(), /^SELECT\b/i, '복구 요청은 SELECT만 실행한다');
    this.reads.push(sql);
    return new ReadOnlyStatement(this, sql);
  }
  batch() { throw new Error('복구 조회에서 batch를 호출할 수 없습니다'); }
  changes() { return this.database.prepare('SELECT total_changes() AS count').get().count; }
}

function seedRow(db, table, key, owner, stamp = 100, data = {}, app = 'task') {
  const idCol = table === 'checks' ? 'k' : 'id';
  db.database.prepare('INSERT INTO ' + table + '(app,' + idCol + ',owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .run(app, key, owner, JSON.stringify({ id: key, staffId: owner, deleted: false, ...data }), stamp, stamp);
}

function seedAuth(db, ids = ['teacher-a', 'teacher-b'], stamp = 100) {
  for (const id of ids) {
    seedRow(db, 'staff', id, id, stamp);
    db.database.prepare('INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)')
      .run('task', id + '-token', id, stamp);
  }
}

function seedRevocation(db, taskId, owner, generation = 0) {
  db.database.prepare(
    'INSERT INTO task_revocations(app,data_generation,task_id,former_owner,revoked_at) VALUES(?,?,?,?,?)'
  ).run('task', generation, taskId, owner, 100);
}

async function sync(db, auth = admin, body = {}, env = {}) {
  const response = await worker.fetch(new Request('https://worker.example/sync', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app: 'task', auth, dataGeneration: 0, since: 0,
      changes: [], recoveryPull: {}, ...body })
  }), { DB: db, TASK_ADMIN_SECRET: 'admin-secret', CONSULT_ADMIN_SECRET: 'admin-secret', ...env });
  return { status: response.status, body: await response.json() };
}

test('recovery uses the normal staff, manager, admin and generation-scoped revocation permissions without writes', async t => {
  const db = new ReadOnlyD1(t);
  seedAuth(db);
  for (const owner of ['teacher-a', 'teacher-b']) {
    seedRow(db, 'tasks', owner + '-task', owner);
    seedRow(db, 'checks', owner + '-task|2026-09-08', owner);
    seedRevocation(db, owner + '-deleted', owner);
  }
  seedRow(db, 'tasks', 'unassigned-task', null);
  seedRow(db, 'tasks', 'consult-private', 'teacher-a', 100, {}, 'consult');
  seedRevocation(db, 'different-generation', 'teacher-a', 1);
  const before = db.changes();

  const own = await sync(db, person('teacher-a'), { capabilities: { taskRevocations: 1 } });
  assert.equal(own.status, 200);
  assert.equal(own.body.authRole, 'staff');
  assert.equal(own.body.dataGeneration, 0);
  assert.equal(own.body.recoveryPull.complete, true);
  assert.deepEqual(own.body.changes.map(row => row.key),
    ['teacher-a', 'teacher-a-task', 'teacher-a-task|2026-09-08']);
  assert.ok(own.body.changes.every(row => row.owner === 'teacher-a'));
  assert.deepEqual(own.body.taskRevocations.rows.map(row => row.taskId), ['teacher-a-deleted']);

  const manager = await sync(db, person('teacher-a'), { capabilities: { taskRevocations: 1 } },
    { TASK_MANAGER_STAFF_IDS_CONFIG: 'teacher-a' });
  const full = await sync(db, admin, { capabilities: { taskRevocations: 1 } });
  assert.equal(manager.body.authRole, 'manager');
  assert.equal(full.body.authRole, 'admin');
  assert.deepEqual(manager.body.changes, full.body.changes);
  assert.equal(full.body.changes.length, 7);
  assert.ok(!full.body.changes.some(row => row.key === 'consult-private'));
  assert.deepEqual(full.body.taskRevocations.rows.map(row => row.taskId),
    ['teacher-a-deleted', 'teacher-b-deleted']);
  assert.equal(db.changes(), before);
  assert.ok(db.reads.every(sql => /FROM (?:staff|tasks|checks|tokens|app_data_generations|task_revocations)\b/.test(sql)),
    '저장 검증이나 보조 원장을 조회하지 않고 정본만 읽는다');
});

test('recovery authenticates and checks the data generation again on every page', async t => {
  const db = new ReadOnlyD1(t);
  seedAuth(db, ['teacher-a']);
  const invalidAuth = await sync(db, { mode: 'person', id: 'teacher-a', token: 'invalid' },
    { recoveryPull: null });
  assert.equal(invalidAuth.status, 401);
  const invalidGeneration = await sync(db, person('teacher-a'), { dataGeneration: 1, recoveryPull: null });
  assert.equal(invalidGeneration.status, 409);
  assert.equal(invalidGeneration.body.code, 'DATA_GENERATION_MISMATCH');
  const first = await sync(db, person('teacher-a'));
  assert.equal(first.status, 200);
  db.database.prepare('UPDATE app_data_generations SET generation=1 WHERE app=?').run('task');
  const second = await sync(db, person('teacher-a'), { recoveryPull: first.body.recoveryPull });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'DATA_GENERATION_MISMATCH');
  assert.equal(second.body.dataGeneration, 1);
  db.database.prepare('UPDATE tokens SET revoked=1 WHERE app=?').run('task');
  const revoked = await sync(db, person('teacher-a'), { dataGeneration: 1, recoveryPull: first.body.recoveryPull });
  assert.equal(revoked.status, 401);
});

test('independent key cursors exhaust more than 2000 equal-timestamp rows per table without omissions', async t => {
  const db = new ReadOnlyD1(t);
  const counts = { staff: 2001, tasks: 4501, checks: 2001 };
  const stamps = { staff: 9000, tasks: 100, checks: 5000 };
  const expected = new Set();
  db.database.exec('BEGIN');
  for (const table of ['staff', 'tasks', 'checks']) {
    for (let index = counts[table] - 1; index >= 0; index -= 1) {
      const key = table + '-' + String(index).padStart(5, '0');
      seedRow(db, table, key, 'teacher-a', stamps[table]);
      expected.add(table + ':' + key);
    }
  }
  db.database.exec('COMMIT');
  const before = db.changes();
  let position = { snapshotAt: 10000 };
  const received = [];
  for (let page = 0; page < 3; page += 1) {
    const response = await sync(db, admin, { recoveryPull: position, since: Date.now() });
    assert.equal(response.status, 200);
    assert.equal(response.body.now, 10000);
    assert.equal(response.body.recoveryPull.snapshotAt, 10000);
    assert.equal(response.body.more, page < 2);
    assert.equal(response.body.recoveryPull.complete, page === 2);
    for (const table of ['staff', 'tasks', 'checks']) {
      const rows = response.body.changes.filter(row => row.table === table);
      assert.ok(rows.length <= 2000);
      assert.deepEqual(rows.map(row => row.key), rows.map(row => row.key).sort());
    }
    received.push(...response.body.changes.map(row => row.table + ':' + row.key));
    position = response.body.recoveryPull;
  }
  assert.equal(received.length, expected.size);
  assert.deepEqual(new Set(received), expected);
  assert.equal(db.changes(), before);
  const exhausted = await sync(db, admin, { recoveryPull: position });
  assert.deepEqual(exhausted.body.changes, []);
  assert.deepEqual(exhausted.body.recoveryPull, position);
});

test('exactly 2000 rows and empty snapshots finish without a false overflow', async t => {
  const db = new ReadOnlyD1(t);
  const empty = await sync(db);
  assert.equal(empty.body.more, false);
  assert.equal(empty.body.recoveryPull.complete, true);
  assert.deepEqual(empty.body.recoveryPull.cursors, { staff: '', tasks: '', checks: '' });
  assert.deepEqual(empty.body.changes, []);
  for (let index = 0; index < 2000; index += 1) {
    seedRow(db, 'tasks', 'task-' + String(index).padStart(5, '0'), 'teacher-a');
  }
  const full = await sync(db);
  assert.equal(full.body.changes.length, 2000);
  assert.equal(full.body.more, false);
  assert.equal(full.body.recoveryPull.complete, true);
});

test('recovery rejects changes before the normal write validation and cannot alter server records', async t => {
  const db = new ReadOnlyD1(t);
  seedAuth(db, ['teacher-a']);
  seedRow(db, 'tasks', 'server-task', 'teacher-a', 100, { title: '서버 정본' });
  const before = db.changes();
  for (const changes of [undefined, null, {}, 'not-an-array', [{
    table: 'tasks', id: 'server-task', owner: 'teacher-a', updated_at: Date.now(),
    data: { id: 'server-task', staffId: 'teacher-a', lessonInstanceType: 'makeup', title: '오래된 기기' }
  }]]) {
    const response = await sync(db, person('teacher-a'), { changes });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'RECOVERY_PULL_READ_ONLY');
  }
  assert.equal(db.changes(), before);
  assert.equal(JSON.parse(db.database.prepare('SELECT data FROM tasks WHERE id=?').get('server-task').data).title,
    '서버 정본');
});

test('malformed positions and revocation cursors fail closed', async t => {
  const db = new ReadOnlyD1(t);
  for (const recoveryPull of [null, [], true, 'all', { unexpected: 1 },
    { cursors: null }, { cursors: [] }, { cursors: { other: 'key' } },
    { cursors: { tasks: 1 } }, { cursors: { tasks: null } }, { cursors: { tasks: {} } },
    { cursors: { tasks: 'x'.repeat(1025) } }, { cursors: { tasks: 'key\n' }, snapshotAt: 100 },
    { cursors: { tasks: 'previous-key' } }, { complete: 'true' },
    { snapshotAt: null }, { snapshotAt: '100' }, { snapshotAt: -1 }, { snapshotAt: 0.5 },
    { snapshotAt: Number.MAX_SAFE_INTEGER + 1 }, { snapshotAt: Date.now() + 60000 }]) {
    const response = await sync(db, admin, { recoveryPull });
    assert.equal(response.status, 400, JSON.stringify(recoveryPull));
    assert.equal(response.body.code, 'INVALID_RECOVERY_PULL');
  }
  const invalidRevocation = await sync(db, admin, {
    capabilities: { taskRevocations: 1 }, taskRevocationCursor: -1
  });
  assert.equal(invalidRevocation.status, 400);
  assert.equal(invalidRevocation.body.code, 'INVALID_TASK_REVOCATION_CURSOR');
});

test('snapshot boundary stays fixed and the following delta includes concurrent lower-key updates', async t => {
  const db = new ReadOnlyD1(t);
  const clock = 1800000000000;
  t.mock.method(Date, 'now', () => clock);
  seedRow(db, 'tasks', 'task-z', 'teacher-a', clock - 10, { title: '기존 업무' });
  seedRow(db, 'checks', 'same-millisecond', 'teacher-a', clock);
  const first = await sync(db);
  assert.equal(first.body.now, clock - 1);
  assert.deepEqual(first.body.changes.map(row => row.key), ['task-z']);

  seedRow(db, 'tasks', 'task-a', 'teacher-a', clock, { title: '동시 생성' });
  db.database.prepare('UPDATE tasks SET srv_at=?,data=? WHERE id=?')
    .run(clock, JSON.stringify({ id: 'task-z', title: '동시 수정' }), 'task-z');
  const continued = await sync(db, admin, { recoveryPull: first.body.recoveryPull });
  assert.equal(continued.body.now, first.body.now);
  assert.deepEqual(continued.body.changes, []);
  const delta = await sync(db, admin, { recoveryPull: undefined, since: first.body.now });
  assert.equal(delta.status, 200);
  assert.deepEqual(delta.body.changes.map(row => row.key).sort(), ['same-millisecond', 'task-a', 'task-z']);
  assert.equal(delta.body.changes.find(row => row.key === 'task-z').data.title, '동시 수정');
});

test('revocations page independently and remain available for deletion during a snapshot', async t => {
  const db = new ReadOnlyD1(t);
  seedAuth(db, ['teacher-a']);
  seedRow(db, 'tasks', 'task-to-delete', 'teacher-a');
  for (let index = 0; index < 501; index += 1) seedRevocation(db, 'deleted-' + index, 'teacher-a');
  const first = await sync(db, person('teacher-a'), { capabilities: { taskRevocations: 1 } });
  assert.equal(first.body.recoveryPull.complete, true);
  assert.equal(first.body.taskRevocations.more, true);
  assert.equal(first.body.taskRevocations.rows.length, 500);
  db.database.prepare('DELETE FROM tasks WHERE app=? AND id=?').run('task', 'task-to-delete');
  const second = await sync(db, person('teacher-a'), { recoveryPull: first.body.recoveryPull,
    capabilities: { taskRevocations: 1 }, taskRevocationCursor: first.body.taskRevocations.cursor });
  assert.equal(second.status, 200);
  assert.equal(second.body.taskRevocations.more, false);
  assert.deepEqual(second.body.taskRevocations.rows.map(row => row.taskId), ['deleted-500', 'task-to-delete']);
  assert.equal(second.body.now, first.body.now);
});

test('consult recovery preserves the internal reward claim hash redaction', async t => {
  const db = new ReadOnlyD1(t);
  seedRow(db, 'checks', '__rewardtx__student-a|request-a', 'student-a', 100,
    { claimActorHash: 'server-secret-hash', status: 'processing' }, 'consult');
  const result = await sync(db, admin, { app: 'consult' });
  assert.equal(result.status, 200);
  assert.equal(result.body.changes.length, 1);
  assert.equal(result.body.changes[0].data.status, 'processing');
  assert.equal(Object.hasOwn(result.body.changes[0].data, 'claimActorHash'), false);
  assert.equal(JSON.stringify(result.body).includes('server-secret-hash'), false);
});
