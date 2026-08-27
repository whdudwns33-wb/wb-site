import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { taskWriteCasGuardStatement } from './task-write-cas.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/055_task_write_cas_guards.sql', import.meta.url), 'utf8');

class Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  run() {
    const result = this.database.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(result.changes || 0) } };
  }
}

class TestD1 {
  constructor() {
    this.database = new DatabaseSync(':memory:');
    this.database.exec(schema);
  }
  prepare(sql) { return new Statement(this.database, sql); }
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

test('055 CAS guard migration is additive, append-only, and matches the schema contract', () => {
  for (const sql of [schema, migration]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS task_write_cas_guards/);
    assert.match(sql, /TASK_WRITE_CAS_CONFLICT/);
    assert.match(sql, /TASK_WRITE_CAS_GUARD_APPEND_ONLY/);
    assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM/i);
  }
  const isolated = new DatabaseSync(':memory:');
  isolated.exec(migration);
  assert.equal(isolated.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='task_write_cas_guards'"
  ).get().count, 1);
});

test('a zero-row optimistic update aborts and rolls back every earlier statement in the D1 batch', async () => {
  const db = new TestD1();
  db.database.exec('CREATE TABLE cas_probe(id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.database.prepare("INSERT INTO cas_probe(id,value) VALUES('winner','current')").run();
  const guard = await taskWriteCasGuardStatement({ DB: db }, 'task', 'test_probe', 'missing\n0\n1', Date.now());
  assert.throws(() => db.batch([
    db.prepare("INSERT INTO cas_probe(id,value) VALUES('loser-side-effect','must-rollback')"),
    db.prepare("UPDATE cas_probe SET value='stale' WHERE id='missing'"),
    guard
  ]), /TASK_WRITE_CAS_CONFLICT/);
  assert.equal(db.database.prepare("SELECT COUNT(*) AS count FROM cas_probe WHERE id='loser-side-effect'").get().count, 0);
  assert.equal(db.database.prepare("SELECT value FROM cas_probe WHERE id='winner'").get().value, 'current');
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM task_write_cas_guards').get().count, 0);
});

test('a successful guard records only non-sensitive audit metadata and stays append-only', async () => {
  const db = new TestD1();
  db.database.exec("CREATE TABLE cas_probe(id TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO cas_probe VALUES('a','old')");
  const guard = await taskWriteCasGuardStatement({ DB: db }, 'task', 'test_probe', 'a\nold\nnew', Date.now());
  db.batch([
    db.prepare("UPDATE cas_probe SET value='new' WHERE id='a' AND value='old'"),
    guard
  ]);
  const row = db.database.prepare('SELECT * FROM task_write_cas_guards').get();
  assert.equal(row.operation, 'test_probe');
  assert.equal(row.previous_changes, 1);
  assert.deepEqual(Object.keys(row).sort(), ['app', 'created_at', 'guard_id', 'operation', 'previous_changes']);
  assert.throws(() => db.database.prepare("UPDATE task_write_cas_guards SET operation='changed'").run(),
    /TASK_WRITE_CAS_GUARD_APPEND_ONLY/);
  assert.throws(() => db.database.prepare('DELETE FROM task_write_cas_guards').run(),
    /TASK_WRITE_CAS_GUARD_APPEND_ONLY/);
});
