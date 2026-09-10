import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  applyTestStaffNextDayAttendance,
  findTestStaffIds,
  isTestStaffId,
  occursOnDate
} from './test-staff-attendance.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  run() { const result = this.db.prepare(this.sql).run(...this.args); return { meta: { changes: Number(result.changes || 0) } }; }
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

const now = Date.parse('2026-09-10T00:10:00+09:00');
const previousDate = '2026-09-09';

function staff(db, id, name, deleted = false) {
  const data = { id, name, deleted };
  db.prepare('INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', id, id, JSON.stringify(data), now, now).run();
}

function lesson(db, id, staffId, overrides = {}) {
  const data = {
    id, staffId, taskKind: 'lesson_instruction', lessonFormVersion: 1,
    start: '2026-01-01', end: '', repeat: 'daily', days: [], deleted: false,
    studentId: 'student-' + id, subject: '수학', ...overrides
  };
  db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', id, staffId, JSON.stringify(data), now, now).run();
}

function check(db, taskId, date, owner, data, updatedAt = now - 1000) {
  db.prepare('INSERT INTO checks(app,k,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', taskId + '|' + date, owner, JSON.stringify({ taskId, date, ...data }), updatedAt, updatedAt).run();
}

test('exactly one active 테스트쌤 is resolved to a stable staff id', async () => {
  const db = new TestD1();
  staff(db, 'staff-test', '테스트쌤');
  staff(db, 'staff-normal', '일반쌤');
  assert.deepEqual([...await findTestStaffIds({ DB: db }, 'task')], ['staff-test']);
  assert.equal(await isTestStaffId({ DB: db }, 'task', 'staff-test'), true);
  assert.equal(await isTestStaffId({ DB: db }, 'task', 'staff-normal'), false);
});

test('duplicate exact names fail closed instead of guessing a staff id', async () => {
  const db = new TestD1();
  staff(db, 'staff-test-a', '테스트쌤');
  staff(db, 'staff-test-b', '테스트쌤');
  assert.deepEqual([...await findTestStaffIds({ DB: db }, 'task')], []);
});

test('the rollover marks only previous-day regular test-teacher lessons present and preserves memo data', async () => {
  const db = new TestD1();
  staff(db, 'staff-test', '테스트쌤');
  staff(db, 'staff-normal', '일반쌤');
  lesson(db, 'lesson-existing', 'staff-test');
  lesson(db, 'lesson-missing', 'staff-test');
  lesson(db, 'lesson-normal', 'staff-normal');
  lesson(db, 'lesson-makeup', 'staff-test', { lessonInstanceType: 'makeup', makeupCaseId: 'makeup-1' });
  lesson(db, 'lesson-other-day', 'staff-test', { repeat: 'days', days: [2] });
  check(db, 'lesson-existing', previousDate, 'staff-test', { att: 'A', comment: '메모 유지', extra: '값 유지' });
  check(db, 'lesson-normal', previousDate, 'staff-normal', { att: 'A' });
  check(db, 'lesson-makeup', previousDate, 'staff-test', { att: 'A' });

  const result = await applyTestStaffNextDayAttendance({ DB: db }, 'task', now);
  assert.equal(result.date, previousDate);
  assert.equal(result.candidates, 2);
  assert.equal(result.updated, 1);
  assert.equal(result.inserted, 1);

  const existing = db.database.prepare("SELECT data FROM checks WHERE app='task' AND k='lesson-existing|2026-09-09'").get();
  const missing = db.database.prepare("SELECT data FROM checks WHERE app='task' AND k='lesson-missing|2026-09-09'").get();
  const normal = db.database.prepare("SELECT data FROM checks WHERE app='task' AND k='lesson-normal|2026-09-09'").get();
  const makeup = db.database.prepare("SELECT data FROM checks WHERE app='task' AND k='lesson-makeup|2026-09-09'").get();
  const otherDay = db.database.prepare("SELECT data FROM checks WHERE app='task' AND k='lesson-other-day|2026-09-09'").get();
  assert.deepEqual(JSON.parse(existing.data), {
    taskId: 'lesson-existing', date: previousDate, att: 'P', absenceType: '',
    comment: '메모 유지', extra: '값 유지', autoAttendance: 'next_day_test_staff', updatedAt: now
  });
  assert.equal(JSON.parse(missing.data).att, 'P');
  assert.equal(JSON.parse(missing.data).autoAttendance, 'next_day_test_staff');
  assert.equal(JSON.parse(normal.data).att, 'A');
  assert.equal(JSON.parse(makeup.data).att, 'A');
  assert.equal(otherDay, undefined);
  assert.equal((await applyTestStaffNextDayAttendance({ DB: db }, 'task', now)).skipped >= 2, true);
});

test('schedule helpers reject deleted, makeup, out-of-range, and other-day lessons', () => {
  const base = { taskKind: 'lesson_instruction', lessonFormVersion: 1, repeat: 'daily', start: '2026-01-01', end: '' };
  assert.equal(occursOnDate(base, previousDate), true);
  assert.equal(occursOnDate({ ...base, deleted: true }, previousDate), false);
  assert.equal(occursOnDate({ ...base, lessonInstanceType: 'makeup' }, previousDate), false);
  assert.equal(occursOnDate({ ...base, start: '2026-09-10' }, previousDate), false);
  assert.equal(occursOnDate({ ...base, repeat: 'days', days: [0] }, previousDate), false);
});
