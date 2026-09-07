import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  normalizeStudentScheduleRevisionIds,
  readStudentScheduleRevisionSnapshot,
  studentScheduleRevisionCasStatements
} from './student-schedule-revision.js';

class D1Statement {
  constructor(owner, sql) { this.owner = owner; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  async all() {
    this.owner.readSql.push(this.sql);
    return { results: this.owner.database.prepare(this.sql).all(...this.args) };
  }
  async run() {
    const result = this.owner.database.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(result.changes || 0) } };
  }
}

class TestD1 {
  constructor() {
    this.database = new DatabaseSync(':memory:');
    this.readSql = [];
    this.database.exec(`
      CREATE TABLE student_schedule_revisions (
        app TEXT NOT NULL,
        student_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at > 0),
        PRIMARY KEY (app, student_id)
      );
      CREATE TABLE task_write_cas_guards (
        app TEXT NOT NULL,
        guard_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        previous_changes INTEGER NOT NULL CHECK (previous_changes = 1),
        created_at INTEGER NOT NULL CHECK (created_at > 0),
        PRIMARY KEY (app, guard_id)
      );
      CREATE TRIGGER trg_task_write_cas_guard
      BEFORE INSERT ON task_write_cas_guards
      WHEN NEW.previous_changes <> 1
      BEGIN
        SELECT RAISE(ABORT, 'TASK_WRITE_CAS_CONFLICT');
      END;
      CREATE TABLE writes (id TEXT PRIMARY KEY);
    `);
  }
  prepare(sql) { return new D1Statement(this, sql); }
  async batch(statements) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function env(db) { return { DB: db }; }

test('stable studentId를 중복 제거하고 항상 같은 순서로 정렬한다', () => {
  assert.deepEqual(normalizeStudentScheduleRevisionIds([
    'student-z', '10000002', 'student-a', '10000002'
  ]), ['10000002', 'student-a', 'student-z']);
  assert.throws(() => normalizeStudentScheduleRevisionIds(['학생']), error =>
    error && error.code === 'STUDENT_SCHEDULE_REVISION_ID_INVALID');
  assert.throws(() => normalizeStudentScheduleRevisionIds('student-a'), error =>
    error && error.code === 'STUDENT_SCHEDULE_REVISION_IDS_INVALID');
});

test('revision snapshot은 정렬된 ID를 반환하고 아직 없는 lock은 revision 0으로 본다', async () => {
  const db = new TestD1();
  db.database.prepare(
    "INSERT INTO student_schedule_revisions(app,student_id,revision,updated_at) VALUES('task','student-b',4,1)"
  ).run();
  const snapshot = await readStudentScheduleRevisionSnapshot(env(db), 'task', [
    'student-b', 'student-a', 'student-b'
  ]);
  assert.deepEqual(snapshot, {
    app: 'task',
    revisions: [
      { studentId: 'student-a', revision: 0 },
      { studentId: 'student-b', revision: 4 }
    ]
  });
  assert.equal(db.readSql.length, 1);
  assert.match(db.readSql[0], /^SELECT student_id,revision FROM student_schedule_revisions/);
});

test('CAS 문장은 학생마다 insert, update, changes guard 순으로 원자 적용된다', async () => {
  const db = new TestD1();
  db.database.prepare(
    "INSERT INTO student_schedule_revisions(app,student_id,revision,updated_at) VALUES('task','student-b',2,1)"
  ).run();
  const snapshot = await readStudentScheduleRevisionSnapshot(env(db), 'task', ['student-b', 'student-a']);
  const statements = await studentScheduleRevisionCasStatements(env(db), 'task', snapshot, {
    operation: 'schedule_test', source: 'request-1', updatedAt: 100
  });
  assert.equal(statements.length, 6);
  assert.match(statements[0].sql, /^INSERT OR IGNORE INTO student_schedule_revisions/);
  assert.match(statements[1].sql, /^UPDATE student_schedule_revisions SET revision=revision\+1/);
  assert.match(statements[2].sql, /^INSERT INTO task_write_cas_guards/);
  assert.match(statements[3].sql, /^INSERT OR IGNORE INTO student_schedule_revisions/);

  statements.push(db.prepare('INSERT INTO writes(id) VALUES(?)').bind('domain-write'));
  await db.batch(statements);
  assert.deepEqual(db.database.prepare(
    "SELECT student_id,revision,updated_at FROM student_schedule_revisions WHERE app='task' ORDER BY student_id"
  ).all().map(row => ({ ...row })), [
    { student_id: 'student-a', revision: 1, updated_at: 100 },
    { student_id: 'student-b', revision: 3, updated_at: 100 }
  ]);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM task_write_cas_guards').get().count, 2);
  assert.equal(db.database.prepare('SELECT operation FROM task_write_cas_guards LIMIT 1').get().operation,
    'schedule_test');
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM writes').get().count, 1);
});

test('snapshot 뒤 revision이 바뀌면 guard가 domain write와 lock 변경을 함께 롤백한다', async () => {
  const db = new TestD1();
  const snapshot = await readStudentScheduleRevisionSnapshot(env(db), 'task', ['student-a']);
  db.database.prepare(
    "INSERT INTO student_schedule_revisions(app,student_id,revision,updated_at) VALUES('task','student-a',1,2)"
  ).run();
  const statements = await studentScheduleRevisionCasStatements(env(db), 'task', snapshot, {
    operation: 'schedule_race', source: 'request-race', updatedAt: 200
  });
  statements.push(db.prepare('INSERT INTO writes(id) VALUES(?)').bind('must-rollback'));
  await assert.rejects(() => db.batch(statements), /TASK_WRITE_CAS_CONFLICT/);
  assert.deepEqual({ ...db.database.prepare(
    "SELECT revision,updated_at FROM student_schedule_revisions WHERE app='task' AND student_id='student-a'"
  ).get() }, { revision: 1, updated_at: 2 });
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM task_write_cas_guards').get().count, 0);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM writes').get().count, 0);
});

test('빈 snapshot은 DB 문장을 만들지 않고 손상된 snapshot과 timestamp는 거부한다', async () => {
  const db = new TestD1();
  const empty = await readStudentScheduleRevisionSnapshot(env(db), 'task', []);
  assert.deepEqual(empty, { app: 'task', revisions: [] });
  assert.equal(db.readSql.length, 0);
  assert.deepEqual(await studentScheduleRevisionCasStatements(env(db), 'task', empty), []);

  await assert.rejects(() => studentScheduleRevisionCasStatements(env(db), 'task', {
    app: 'task', revisions: [{ studentId: 'student-b', revision: 0 }, { studentId: 'student-a', revision: 0 }]
  }), /STUDENT_SCHEDULE_REVISION_SNAPSHOT_INVALID/);
  await assert.rejects(() => studentScheduleRevisionCasStatements(env(db), 'task', {
    app: 'task', revisions: [{ studentId: 'student-a', revision: 0 }]
  }, { updatedAt: 0 }), /STUDENT_SCHEDULE_REVISION_TIMESTAMP_INVALID/);
});
