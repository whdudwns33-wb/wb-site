import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { handleStaffAttendance, staffAttendanceDate, staffAttendanceKey } from './staff-attendance.js';

class Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  first() { return this.database.prepare(this.sql).get(...this.args) || null; }
  all() { return { results: this.database.prepare(this.sql).all(...this.args) }; }
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

  const secondInAt = clockOutAt + 3600000;
  const secondIn = await atNow(secondInAt, () => call(db, 'clock_in'));
  assert.equal(secondIn.status, 200);
  assert.equal(secondIn.body.record.at, clockInAt);
  assert.equal(secondIn.body.record.out, null);
  assert.equal(secondIn.body.record.sessions.length, 2);

  const secondOutAt = secondInAt + 1800000;
  const secondOut = await atNow(secondOutAt, () => call(db, 'clock_out'));
  assert.equal(secondOut.status, 200);
  assert.equal(secondOut.body.record.at, clockInAt);
  assert.equal(secondOut.body.record.out, secondOutAt);
  assert.equal(secondOut.body.record.sessions[0].out, clockOutAt);
  assert.equal(secondOut.body.record.sessions[1].out, secondOutAt);

  const repeatedOut = await atNow(secondOutAt + 60000, () => call(db, 'clock_out'));
  assert.equal(repeatedOut.status, 200);
  assert.equal(repeatedOut.body.idempotent, true);
  assert.equal(repeatedOut.body.record.out, secondOutAt);
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

test('admin can read one selected month plus the full-history month bounds', async () => {
  const db = new TestD1();
  const insert = db.database.prepare(
    'INSERT INTO checks(app,k,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)'
  );
  const firstAt = Date.parse('2025-01-03T09:00:00+09:00');
  const latestAt = Date.parse('2026-09-21T10:00:00+09:00');
  insert.run('task', '__att__teacher-1|2025-01-03', 'teacher-1', JSON.stringify({
    done: true, at: firstAt, out: firstAt + 3600000, note: '노출 금지', phone: '01000000000'
  }), firstAt, firstAt);
  insert.run('task', '__att__teacher-2|2026-09-21', 'teacher-2', JSON.stringify({
    done: true, at: latestAt, out: null, sessions: [{ in: latestAt, out: null }], secret: '노출 금지'
  }), latestAt, latestAt);

  const result = await atNow(Date.parse('2026-09-23T12:00:00+09:00'), () =>
    call(db, 'history', { scope: 'all' }, { month: '2026-09' }));
  assert.equal(result.status, 200);
  assert.equal(result.body.month, '2026-09');
  assert.equal(result.body.records.length, 1);
  assert.deepEqual(result.body.bounds, {
    earliestMonth: '2025-01', latestMonth: '2026-09', currentMonth: '2026-09'
  });
  assert.equal(result.body.records[0].staffId, 'teacher-2');
  assert.equal(result.body.records[0].record.at, latestAt);
  assert.equal(result.body.records[0].record.out, null);
  assert.equal('secret' in result.body.records[0].record, false);
  assert.equal('phone' in result.body.records[0].record, false);
});

test('monthly history is admin-only and rejects invalid or future months', async () => {
  const db = new TestD1();
  const denied = await call(db, 'history', teacher, { month: '2026-09' });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'STAFF_ATTENDANCE_ADMIN_REQUIRED');

  const invalid = await call(db, 'history', { scope: 'all' }, { month: '2026-13' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, 'STAFF_ATTENDANCE_MONTH_INVALID');

  const future = await atNow(Date.parse('2026-09-23T12:00:00+09:00'), () =>
    call(db, 'history', { scope: 'all' }, { month: '2026-10' }));
  assert.equal(future.status, 400);
  assert.equal(future.body.code, 'STAFF_ATTENDANCE_MONTH_INVALID');
});
