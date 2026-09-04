import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { handleStaffAttendance, staffAttendanceDate, staffAttendanceKey } from './staff-attendance.js';

class Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  first() { return this.database.prepare(this.sql).get(...this.args) || null; }
  run() {
    const result = this.database.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(result.changes || 0) } };
  }
}

class TestD1 {
  constructor() {
    this.database = new DatabaseSync(':memory:');
    this.database.exec(`
      CREATE TABLE checks (
        app TEXT NOT NULL,
        k TEXT NOT NULL,
        owner TEXT,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        srv_at INTEGER NOT NULL,
        PRIMARY KEY (app,k)
      );
    `);
  }
  prepare(sql) { return new Statement(this.database, sql); }
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' }
});
const teacher = { scope: 'own', id: 'teacher-1' };

async function atNow(value, action) {
  const original = Date.now;
  Date.now = () => value;
  try { return await action(); } finally { Date.now = original; }
}

async function call(db, action, auth = teacher, extras = {}) {
  const response = await handleStaffAttendance({ DB: db }, 'task', { action, ...extras }, '*', auth, json);
  return { status: response.status, body: await response.json() };
}

test('teacher clock-in and clock-out use immutable server timestamps', async () => {
  const db = new TestD1();
  const clockInAt = Date.parse('2026-09-04T09:07:00+09:00');
  const clockOutAt = Date.parse('2026-09-04T18:11:00+09:00');
  const date = staffAttendanceDate(clockInAt);
  const key = staffAttendanceKey('teacher-1', date);

  const clockIn = await atNow(clockInAt, () => call(db, 'clock_in', teacher, {
    date: '2000-01-01', at: 1, out: 2
  }));
  assert.equal(clockIn.status, 200);
  assert.equal(clockIn.body.key, key);
  assert.equal(clockIn.body.record.at, clockInAt);
  assert.equal(clockIn.body.record.out, null);
  assert.equal(clockIn.body.record.date, date);

  const repeatedIn = await atNow(clockInAt + 60000, () => call(db, 'clock_in'));
  assert.equal(repeatedIn.status, 200);
  assert.equal(repeatedIn.body.idempotent, true);
  assert.equal(repeatedIn.body.record.at, clockInAt);

  const clockOut = await atNow(clockOutAt, () => call(db, 'clock_out'));
  assert.equal(clockOut.status, 200);
  assert.equal(clockOut.body.record.at, clockInAt);
  assert.equal(clockOut.body.record.out, clockOutAt);

  const repeatedOut = await atNow(clockOutAt + 60000, () => call(db, 'clock_out'));
  assert.equal(repeatedOut.status, 200);
  assert.equal(repeatedOut.body.idempotent, true);
  assert.equal(repeatedOut.body.record.out, clockOutAt);
});

test('clock-out requires clock-in and root admin without a personal staff id cannot create a punch', async () => {
  const db = new TestD1();
  const missing = await call(db, 'clock_out');
  assert.equal(missing.status, 409);
  assert.equal(missing.body.code, 'STAFF_ATTENDANCE_CLOCK_IN_REQUIRED');

  const rootAdmin = await call(db, 'clock_in', { scope: 'all' });
  assert.equal(rootAdmin.status, 403);
  assert.equal(rootAdmin.body.code, 'STAFF_ATTENDANCE_PERSON_REQUIRED');
  assert.equal(db.database.prepare('SELECT COUNT(*) count FROM checks').get().count, 0);
});

test('a manager personal account can still record its own initial attendance', async () => {
  const db = new TestD1();
  const managerAt = Date.parse('2026-09-04T08:55:00+09:00');
  const result = await atNow(managerAt, () => call(db, 'clock_in', {
    scope: 'all', id: 'manager-1', role: 'manager'
  }));
  assert.equal(result.status, 200);
  assert.equal(result.body.owner, 'manager-1');
  assert.equal(result.body.record.at, managerAt);
});
