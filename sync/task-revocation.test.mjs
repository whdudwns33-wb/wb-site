import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import worker from './worker-core.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/071_task_revocations.sql', import.meta.url), 'utf8');

class Statement {
  constructor(owner, sql) { this.owner = owner; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  first() { return this.owner.database.prepare(this.sql).get(...this.args) || null; }
  all() { return { results: this.owner.database.prepare(this.sql).all(...this.args) }; }
  run() {
    const result = this.owner.database.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(result.changes || 0) } };
  }
}

class TestD1 {
  constructor() {
    this.database = new DatabaseSync(':memory:');
    this.database.exec(schema);
  }
  prepare(sql) { return new Statement(this, sql); }
  batch(statements) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => statement.run());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

const admin = { mode: 'admin', secret: 'admin-secret' };
const person = id => ({ mode: 'person', id, token: id + '-token' });

function seedAuth(db, ids = ['teacher-a', 'teacher-b']) {
  const now = Date.now();
  for (const id of ids) {
    db.database.prepare(
      'INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)'
    ).run('task', id, id, JSON.stringify({ id, name: '교사', deleted: false }), now, now);
    db.database.prepare(
      'INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)'
    ).run('task', id + '-token', id, now);
  }
}

function insertRevocation(db, taskId, formerOwner, generation = 0, revokedAt = Date.now()) {
  db.database.prepare(
    'INSERT INTO task_revocations(app,data_generation,task_id,former_owner,revoked_at) VALUES(?,?,?,?,?)'
  ).run('task', generation, taskId, formerOwner, revokedAt);
  return Number(db.database.prepare(
    'SELECT revocation_seq FROM task_revocations WHERE app=? AND data_generation=? AND task_id=? AND former_owner=?'
  ).get('task', generation, taskId, formerOwner).revocation_seq);
}

async function sync(db, auth, body = {}, env = {}) {
  const response = await worker.fetch(new Request('https://worker.example/sync', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app: 'task', auth, dataGeneration: 0, since: 0, changes: [], ...body })
  }), { DB: db, TASK_ADMIN_SECRET: 'admin-secret', CONSULT_ADMIN_SECRET: 'consult-secret', ...env });
  return { status: response.status, body: await response.json() };
}

test('071 is additive, generation-scoped, append-only, and reproducible in schema.sql', () => {
  for (const source of [schema, migration]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS task_revocations/);
    assert.match(source, /data_generation INTEGER NOT NULL/);
    assert.match(source, /UNIQUE \(app, data_generation, task_id, former_owner\)/);
    assert.match(source, /TASK_REVOCATION_APPEND_ONLY/);
    assert.match(source, /trg_tasks_capture_revocation_delete/);
    assert.match(source, /trg_tasks_ignore_revoked_insert/);
    assert.match(source, /trg_checks_ignore_revoked_task_insert/);
    assert.doesNotMatch(source, /DROP TABLE|DELETE FROM task_revocations/i);
  }

  const isolated = new DatabaseSync(':memory:');
  isolated.exec(`
    CREATE TABLE app_data_generations(app TEXT PRIMARY KEY,generation INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    INSERT INTO app_data_generations VALUES('task',0,0);
    CREATE TABLE tasks(app TEXT NOT NULL,id TEXT NOT NULL,owner TEXT,data TEXT NOT NULL,updated_at INTEGER NOT NULL,srv_at INTEGER NOT NULL,PRIMARY KEY(app,id));
    CREATE TABLE checks(app TEXT NOT NULL,k TEXT NOT NULL,owner TEXT,data TEXT NOT NULL,updated_at INTEGER NOT NULL,srv_at INTEGER NOT NULL,PRIMARY KEY(app,k));
  `);
  isolated.exec(migration);
  assert.equal(isolated.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='task_revocations'"
  ).get().count, 1);
  isolated.close();
});

test('physical task deletion records one minimal marker and blocks stale task/check resurrection', () => {
  const db = new TestD1();
  const task = {
    id: 'lesson-deleted', staffId: 'teacher-a', studentId: 'student-private',
    taskKind: 'lesson_instruction', deleted: false, updatedAt: 100
  };
  db.database.prepare(
    'INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)'
  ).run('task', task.id, task.staffId, JSON.stringify(task), 100, 100);
  db.database.prepare(
    'INSERT INTO checks(app,k,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)'
  ).run('task', task.id + '|2026-09-06', task.staffId,
    JSON.stringify({ taskId: task.id, date: '2026-09-06', note: '비공개' }), 100, 100);

  db.database.prepare('DELETE FROM checks WHERE app=? AND k=?').run('task', task.id + '|2026-09-06');
  db.database.prepare('DELETE FROM tasks WHERE app=? AND id=?').run('task', task.id);
  const marker = db.database.prepare(
    'SELECT app,data_generation,task_id,former_owner,revoked_at FROM task_revocations'
  ).get();
  assert.deepEqual(Object.keys(marker).sort(),
    ['app', 'data_generation', 'former_owner', 'revoked_at', 'task_id'].sort());
  assert.equal(marker.task_id, task.id);
  assert.equal(marker.former_owner, task.staffId);
  assert.equal(marker.data_generation, 0);
  assert.ok(marker.revoked_at >= 100);

  assert.equal(db.database.prepare(
    'INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)'
  ).run('task', task.id, task.staffId, JSON.stringify({ ...task, updatedAt: 999 }), 999, 999).changes, 0);
  assert.equal(db.database.prepare(
    'INSERT INTO checks(app,k,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)'
  ).run('task', task.id + '|2026-09-06', task.staffId,
    JSON.stringify({ taskId: task.id, date: '2026-09-06', note: '재전송' }), 999, 999).changes, 0);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM tasks WHERE id=?').get(task.id).count, 0);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM checks WHERE k LIKE ?').get(task.id + '|%').count, 0);
  assert.throws(() => db.database.prepare('UPDATE task_revocations SET revoked_at=revoked_at+1').run(),
    /TASK_REVOCATION_APPEND_ONLY/);
  assert.throws(() => db.database.prepare('DELETE FROM task_revocations').run(),
    /TASK_REVOCATION_APPEND_ONLY/);
});

test('sync capability returns only the authorized generation through its independent cursor', async () => {
  const db = new TestD1(); seedAuth(db);
  const a1 = insertRevocation(db, 'deleted-a-1', 'teacher-a', 0, 101);
  const a2 = insertRevocation(db, 'deleted-a-2', 'teacher-a', 0, 102);
  insertRevocation(db, 'deleted-b-1', 'teacher-b', 0, 103);
  insertRevocation(db, 'old-generation', 'teacher-a', 1, 104);

  const legacy = await sync(db, person('teacher-a'));
  assert.equal(legacy.status, 200);
  assert.equal(Object.hasOwn(legacy.body, 'taskRevocations'), false,
    '구형 client의 일반 cursor 계약에 새 필드를 강제하지 않는다');

  const own = await sync(db, person('teacher-a'), {
    capabilities: { taskRevocations: 1 }, taskRevocationCursor: 0
  });
  assert.equal(own.status, 200);
  assert.equal(own.body.taskRevocations.version, 1);
  assert.equal(own.body.taskRevocations.more, false);
  assert.equal(own.body.taskRevocations.cursor, a2);
  assert.deepEqual(own.body.taskRevocations.rows.map(row => row.taskId), ['deleted-a-1', 'deleted-a-2']);
  assert.deepEqual(Object.keys(own.body.taskRevocations.rows[0]).sort(),
    ['formerOwner', 'revokedAt', 'taskId'].sort());
  assert.doesNotMatch(JSON.stringify(own.body.taskRevocations), /student|name|grade|note|비공개/i);

  const afterFirst = await sync(db, person('teacher-a'), {
    capabilities: { taskRevocations: 1 }, taskRevocationCursor: a1
  });
  assert.deepEqual(afterFirst.body.taskRevocations.rows.map(row => row.taskId), ['deleted-a-2']);
  assert.equal(afterFirst.body.taskRevocations.cursor, a2);

  const all = await sync(db, admin, { capabilities: { taskRevocations: 1 }, taskRevocationCursor: 0 });
  assert.deepEqual(all.body.taskRevocations.rows.map(row => row.taskId),
    ['deleted-a-1', 'deleted-a-2', 'deleted-b-1']);
  assert.equal(all.body.now >= 0, true);
  assert.equal(all.body.more, false, '일반 changes의 more는 삭제 커서와 분리된다');
});

test('dedicated revocation paging has no gaps and an invalid cursor is rejected before writes', async () => {
  const db = new TestD1(); seedAuth(db, ['teacher-a']);
  for (let index = 0; index < 501; index += 1) {
    insertRevocation(db, 'deleted-' + String(index).padStart(4, '0'), 'teacher-a', 0, index + 1);
  }
  const first = await sync(db, person('teacher-a'), {
    capabilities: { taskRevocations: 1 }, taskRevocationCursor: 0
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.taskRevocations.rows.length, 500);
  assert.equal(first.body.taskRevocations.more, true);
  const second = await sync(db, person('teacher-a'), {
    capabilities: { taskRevocations: 1 }, taskRevocationCursor: first.body.taskRevocations.cursor
  });
  assert.equal(second.body.taskRevocations.rows.length, 1);
  assert.equal(second.body.taskRevocations.more, false);
  assert.equal(new Set(first.body.taskRevocations.rows.concat(second.body.taskRevocations.rows)
    .map(row => row.taskId)).size, 501);

  const invalid = await sync(db, person('teacher-a'), {
    capabilities: { taskRevocations: 1 }, taskRevocationCursor: -1,
    changes: [{ table: 'tasks', id: 'must-not-write', owner: 'teacher-a', updated_at: 999,
      data: { id: 'must-not-write', staffId: 'teacher-a', origin: 'staff', deleted: false, updatedAt: 999 } }]
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, 'INVALID_TASK_REVOCATION_CURSOR');
  assert.equal(db.database.prepare("SELECT COUNT(*) AS count FROM tasks WHERE id='must-not-write'").get().count, 0);
});

test('generic sync silently drops stale revoked rows while preserving unrelated changes', async () => {
  const db = new TestD1(); seedAuth(db, ['teacher-a']);
  insertRevocation(db, 'deleted-lesson', 'teacher-a');
  const deleted = {
    id: 'deleted-lesson', staffId: 'teacher-a', studentId: 'student-private',
    taskKind: 'lesson_instruction', lessonFormVersion: 1, origin: 'staff', deleted: false, updatedAt: 900
  };
  const ordinary = {
    id: 'ordinary-task', staffId: 'teacher-a', origin: 'staff', title: '일반 업무', deleted: false, updatedAt: 901
  };
  const result = await sync(db, person('teacher-a'), {
    changes: [
      { table: 'tasks', id: deleted.id, owner: 'teacher-a', data: deleted, updated_at: 900 },
      { table: 'checks', k: deleted.id + '|2026-09-06', owner: 'teacher-a', updated_at: 900,
        data: { taskId: deleted.id, date: '2026-09-06', note: '재전송', updatedAt: 900 } },
      { table: 'tasks', id: ordinary.id, owner: 'teacher-a', data: ordinary, updated_at: 901 }
    ]
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(db.database.prepare("SELECT COUNT(*) AS count FROM tasks WHERE id='deleted-lesson'").get().count, 0);
  assert.equal(db.database.prepare("SELECT COUNT(*) AS count FROM checks WHERE k LIKE 'deleted-lesson|%'").get().count, 0);
  assert.equal(db.database.prepare("SELECT COUNT(*) AS count FROM tasks WHERE id='ordinary-task'").get().count, 1);
});
