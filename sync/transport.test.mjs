import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

import worker from './worker-core.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/023_transport.sql', import.meta.url), 'utf8');
const integrityMigration = fs.readFileSync(new URL('./migrations/024_transport_integrity.sql', import.meta.url), 'utf8');

class D1Statement {
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
  constructor() { this.database = new DatabaseSync(':memory:'); this.database.exec(schema); }
  prepare(sql) { return new D1Statement(this.database, sql); }
  batch(statements) { return Promise.all(statements.map(statement => statement.run())); }
  withoutIntegrity(callback) {
    const names = this.database.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_transport_%'"
    ).all().map(row => row.name);
    for (const name of names) this.database.exec('DROP TRIGGER ' + name);
    try { return callback(); }
    finally { this.database.exec(integrityMigration); }
  }
}

const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date());
const month = today.slice(0, 7);
const todayDay = new Date(today + 'T00:00:00Z').getUTCDay();
const admin = { mode: 'admin', secret: 'director-secret' };
const person = (id, token) => ({ mode: 'person', id, token });

function plusDays(date, amount) {
  const parsed = new Date(date + 'T00:00:00Z');
  parsed.setUTCDate(parsed.getUTCDate() + amount);
  return parsed.toISOString().slice(0, 10);
}

function configFixture() {
  return {
    vehicles: [
      { id: 'van-a', name: '1호차', plate: '12가3456', capacity: 2 },
      { id: 'van-b', name: '2호차', plate: '34나5678', capacity: 2 }
    ],
    routes: [
      {
        id: 'route-a', name: 'A 귀가', direction: 'dropoff', vehicleId: 'van-a', driverId: 'driver-a',
        days: [todayDay], startTime: '19:00', active: true,
        stops: [{ id: 'stop-a', name: '중앙공원', time: '19:15', studentIds: ['student-a'] }]
      },
      {
        id: 'route-b', name: 'B 귀가', direction: 'dropoff', vehicleId: 'van-b', driverId: 'driver-b',
        days: [todayDay], startTime: '20:00', active: true,
        stops: [{ id: 'stop-b', name: '시청', time: '20:10', studentIds: ['student-b'] }]
      }
    ]
  };
}

function seed(db) {
  const now = Date.now();
  for (const [id, name, token] of [
    ['driver-a', '김기사', 'token-a'], ['driver-b', '이기사', 'token-b']
  ]) {
    db.prepare('INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
      .bind('task', id, id, JSON.stringify({ id, name, phone: '010-SECRET', deleted: false }), now, now).run();
    db.prepare('INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)')
      .bind('task', token, id, now).run();
  }
  const students = [
    { id: 'student-a', name: '가학생', grade: '초3', teacher: '가선생', subject: '수학',
      start: month, end: '', reason: '', memo: 'SECRET ADDRESS', teacherIds: ['driver-a'] },
    { id: 'student-b', name: '나학생', grade: '초4', teacher: '나선생', subject: '영어',
      start: month, end: '', reason: '', memo: 'GUARDIAN SECRET', teacherIds: ['driver-b'] }
  ];
  db.prepare('INSERT INTO private_rosters(app,data,updated_at) VALUES(?,?,?)')
    .bind('task', JSON.stringify({ roster: { updated: today, baseline: month, students }, bookStudents: [] }), now).run();
}

async function call(db, body, app = 'task') {
  return callPath(db, '/transport', body, app);
}

async function callPath(db, path, body, app = 'task') {
  const response = await worker.fetch(new Request('https://worker.example' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app, ...body })
  }), { DB: db, TASK_ADMIN_SECRET: 'director-secret', CONSULT_ADMIN_SECRET: 'consult-secret' });
  return { status: response.status, body: await response.json() };
}

async function replace(db, config = configFixture(), revision = 0) {
  return call(db, { auth: admin, action: 'replace', config, revision });
}

async function syncStaff(db, id, data, updatedAt) {
  const response = await worker.fetch(new Request('https://worker.example/sync', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      app: 'task', auth: admin, since: 0,
      changes: [{ table: 'staff', id, owner: id, data, updated_at: updatedAt }]
    })
  }), { DB: db, TASK_ADMIN_SECRET: 'director-secret', CONSULT_ADMIN_SECRET: 'consult-secret' });
  return { status: response.status, body: await response.json() };
}

function seedBoarded(db, date, routeId = 'route-a', studentId = 'student-a', revision = 1) {
  const now = Date.now();
  db.prepare(
    'INSERT INTO transport_states ' +
    '(app,date,route_id,student_id,status,revision,boarded_at,boarded_by,dropped_at,dropped_by,absent_at,absent_by,history,updated_at) ' +
    "VALUES(?,?,?,?, 'boarded',?,?,?,NULL,NULL,NULL,NULL,?,?)"
  ).bind('task', date, routeId, studentId, revision, now, 'director',
    JSON.stringify([{ from: 'scheduled', to: 'boarded', at: now, by: 'director' }]), now).run();
}

test('schema and migration add non-destructive vehicle tables with constrained states', () => {
  for (const sql of [schema, migration]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS transport_configs/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS transport_states/);
    assert.match(sql, /'scheduled','boarded','dropped','absent'/);
    assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM/i);
  }
  assert.match(schema, /trg_transport_boarded_insert_guard/);
  assert.match(integrityMigration, /RAISE\(ABORT, 'BOARDING_LOCK'\)/);
  assert.doesNotMatch(integrityMigration, /DROP TABLE|DELETE FROM/i);
});

test('only all-scope replaces config and validation rejects capacity, inactive refs, and duplicates', async () => {
  const db = new TestD1(); seed(db);
  assert.equal((await call(db, {
    auth: person('driver-a', 'token-a'), action: 'replace', config: configFixture(), revision: 0
  })).status, 403);

  const overCapacity = configFixture();
  overCapacity.vehicles[0].capacity = 1;
  overCapacity.routes[0].stops[0].studentIds.push('student-b');
  assert.match((await replace(db, overCapacity)).body.error, /정원|중복/);

  const missingDriver = configFixture();
  missingDriver.routes[0].driverId = 'missing-driver';
  assert.match((await replace(db, missingDriver)).body.error, /활성 운전/);

  const duplicate = configFixture();
  duplicate.routes[0].stops.push({ id: 'stop-a2', name: '두 번째', time: '19:20', studentIds: ['student-a'] });
  assert.match((await replace(db, duplicate)).body.error, /중복 배정/);

  assert.equal((await replace(db)).status, 200);
});

test('roster end month is exclusive when validating route students', async () => {
  const db = new TestD1(); seed(db);
  const row = db.prepare("SELECT data FROM private_rosters WHERE app='task'").first();
  const document = JSON.parse(row.data);
  document.roster.students.find(student => student.id === 'student-a').end = month;
  db.prepare("UPDATE private_rosters SET data=? WHERE app='task'").bind(JSON.stringify(document)).run();
  const result = await replace(db);
  assert.equal(result.status, 400);
  assert.match(result.body.error, /현재 원생이 아닌 학생/);
});

test('driver list is scoped to own route and emits only safe student fields', async () => {
  const db = new TestD1(); seed(db); await replace(db);
  const result = await call(db, { auth: person('driver-a', 'token-a'), action: 'list', date: today });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.routes.map(route => route.id), ['route-a']);
  assert.deepEqual(result.body.config.routes.map(route => route.id), ['route-a']);
  assert.deepEqual(Object.keys(result.body.routes[0].students[0]).sort(),
    ['grade', 'id', 'name', 'revision', 'status', 'stop']);
  const serialized = JSON.stringify(result.body);
  assert.doesNotMatch(serialized, /SECRET|GUARDIAN|010-|address|phone|memo/i);
});

test('state uses strict transitions and CAS blocks double click', async () => {
  const db = new TestD1(); seed(db); await replace(db);
  const request = { auth: person('driver-a', 'token-a'), action: 'state', date: today,
    routeId: 'route-a', studentId: 'student-a', next: 'boarded', revision: 0 };
  const boarded = await call(db, request);
  assert.equal(boarded.status, 200);
  assert.equal(boarded.body.state.status, 'boarded');
  assert.equal(boarded.body.state.revision, 1);
  assert.equal((await call(db, request)).status, 409);

  const invalid = await call(db, { ...request, next: 'absent', revision: 1 });
  assert.equal(invalid.status, 409);
  assert.equal(invalid.body.code, 'INVALID_TRANSITION');

  const dropped = await call(db, { ...request, next: 'dropped', revision: 1 });
  assert.equal(dropped.status, 200);
  assert.equal(dropped.body.state.status, 'dropped');
  assert.equal(dropped.body.state.revision, 2);
});

test('own driver cannot modify another route or a non-KST-today record', async () => {
  const db = new TestD1(); seed(db); await replace(db);
  const other = await call(db, { auth: person('driver-a', 'token-a'), action: 'state', date: today,
    routeId: 'route-b', studentId: 'student-b', next: 'boarded', revision: 0 });
  assert.equal(other.status, 403);
  assert.equal(other.body.code, 'FORBIDDEN');

  const yesterday = await call(db, { auth: person('driver-a', 'token-a'), action: 'state', date: plusDays(today, -1),
    routeId: 'route-a', studentId: 'student-a', next: 'boarded', revision: 0 });
  assert.equal(yesterday.status, 403);
  assert.equal(yesterday.body.code, 'DATE_FORBIDDEN');
  assert.equal((await call(db, { auth: admin, action: 'list', date: plusDays(today, 32) })).status, 400);
});

test('today boarded state locks route, vehicle, driver, and student config changes', async () => {
  const db = new TestD1(); seed(db);
  const saved = await replace(db);
  await call(db, { auth: person('driver-a', 'token-a'), action: 'state', date: today,
    routeId: 'route-a', studentId: 'student-a', next: 'boarded', revision: 0 });
  const changed = configFixture();
  changed.routes[0].name = '바뀐 노선';
  const result = await replace(db, changed, saved.body.revision);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'BOARDING_LOCK');
});

test('a boarded row from a previous date still locks config replacement', async () => {
  const db = new TestD1(); seed(db);
  const saved = await replace(db);
  db.withoutIntegrity(() => seedBoarded(db, plusDays(today, -1)));
  const changed = configFixture();
  changed.routes[0].name = '자정 뒤 변경 시도';
  const result = await replace(db, changed, saved.body.revision);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'BOARDING_LOCK');
});

test('generic staff sync cannot deactivate a driver with an unresolved boarded student', async () => {
  const db = new TestD1(); seed(db); await replace(db);
  seedBoarded(db, today, 'route-a', 'student-a');
  const current = db.prepare("SELECT data,updated_at FROM staff WHERE app='task' AND id='driver-a'").first();
  const deleted = { ...JSON.parse(current.data), deleted: true, updatedAt: Number(current.updated_at) + 1 };

  let result = await syncStaff(db, 'driver-a', null, Number(current.updated_at) + 1);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'BOARDING_LOCK');

  result = await syncStaff(db, 'driver-a', deleted, Number(current.updated_at) + 1);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'BOARDING_LOCK');
  assert.equal(JSON.parse(db.prepare(
    "SELECT data FROM staff WHERE app='task' AND id='driver-a'"
  ).first().data).deleted, false);

  db.prepare(
    "UPDATE transport_states SET status='dropped',revision=revision+1,updated_at=? " +
    "WHERE app='task' AND route_id='route-a' AND student_id='student-a'"
  ).bind(Date.now()).run();
  result = await syncStaff(db, 'driver-a', deleted, Number(current.updated_at) + 1);
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(db.prepare(
    "SELECT data FROM staff WHERE app='task' AND id='driver-a'"
  ).first().data).deleted, true);
});

test('admin list keeps orphan boarded records visible and cannot report completed', async () => {
  const db = new TestD1(); seed(db);
  const saved = await replace(db);
  await call(db, { auth: person('driver-a', 'token-a'), action: 'state', date: today,
    routeId: 'route-a', studentId: 'student-a', next: 'boarded', revision: 0 });
  const empty = { vehicles: [], routes: [] };
  db.withoutIntegrity(() => db.prepare('UPDATE transport_configs SET data=?,updated_at=? WHERE app=?')
    .bind(JSON.stringify(empty), saved.body.revision + 1, 'task').run());
  const result = await call(db, { auth: admin, action: 'list', date: today });
  assert.equal(result.status, 200);
  assert.equal(result.body.states.some(item => item.routeId === 'route-a' && item.status === 'boarded'), true);
  assert.equal(result.body.warnings.some(item => item.code === 'ORPHAN_BOARDED'), true);
  assert.equal(result.body.summary.boarded, 1);
  assert.equal(result.body.summary.completed, false);
});

test('admin warns when a boarded student disappears from the current roster', async () => {
  const db = new TestD1(); seed(db); await replace(db);
  await call(db, { auth: person('driver-a', 'token-a'), action: 'state', date: today,
    routeId: 'route-a', studentId: 'student-a', next: 'boarded', revision: 0 });
  const row = db.prepare("SELECT data FROM private_rosters WHERE app='task'").first();
  const document = JSON.parse(row.data);
  document.roster.students = document.roster.students.filter(student => student.id !== 'student-a');
  db.withoutIntegrity(() => db.prepare("UPDATE private_rosters SET data=? WHERE app='task'")
    .bind(JSON.stringify(document)).run());
  const result = await call(db, { auth: admin, action: 'list', date: today });
  assert.equal(result.body.states.some(item => item.studentId === 'student-a' && item.status === 'boarded'), true);
  assert.equal(result.body.warnings.some(item => item.code === 'ORPHAN_BOARDED'), true);
  assert.equal(result.body.summary.completed, false);
});

test('admin list returns all-date unresolved rows without PII and caps them at 100', async () => {
  const db = new TestD1(); seed(db); await replace(db);
  db.withoutIntegrity(() => {
    for (let index = 0; index < 101; index += 1) {
      seedBoarded(db, plusDays(today, -index), 'orphan-route-' + index, 'orphan-student-' + index);
    }
  });
  const result = await call(db, { auth: admin, action: 'list', date: today });
  assert.equal(result.status, 200);
  assert.equal(result.body.unresolved.length, 100);
  assert.equal(result.body.unresolved.every(item => item.status === 'boarded'), true);
  assert.equal(result.body.warnings.some(item => item.code === 'UNRESOLVED_TRUNCATED'), true);
  assert.deepEqual(Object.keys(result.body.unresolved[0]).sort(),
    ['date', 'revision', 'routeId', 'routeName', 'status', 'studentId', 'studentName']);
  assert.doesNotMatch(JSON.stringify(result.body.unresolved), /SECRET|GUARDIAN|010-|address|phone|memo/i);
});

test('summary deduplicates a projected boarded row that is also an invalid-route warning', async () => {
  const db = new TestD1(); seed(db); await replace(db);
  await call(db, { auth: person('driver-a', 'token-a'), action: 'state', date: today,
    routeId: 'route-a', studentId: 'student-a', next: 'boarded', revision: 0 });
  db.withoutIntegrity(() => db.prepare("UPDATE staff SET data=? WHERE app='task' AND id='driver-a'")
    .bind(JSON.stringify({ id: 'driver-a', name: '김기사', deleted: true, phone: '010-SECRET' })).run());
  const result = await call(db, { auth: admin, action: 'list', date: today });
  assert.equal(result.body.warnings.some(item => item.code === 'ORPHAN_BOARDED'), true);
  assert.equal(result.body.routes.some(route => route.id === 'route-a' &&
    route.students.some(student => student.status === 'boarded')), true);
  assert.equal(result.body.summary.boarded, 1);
});

test('admin can reset an old orphan boarded row before config and roster validation', async () => {
  const db = new TestD1(); seed(db); await replace(db);
  const oldDate = plusDays(today, -40);
  db.withoutIntegrity(() => seedBoarded(db, oldDate, 'removed-route', 'removed-student'));
  const reset = await call(db, { auth: admin, action: 'state', date: oldDate,
    routeId: 'removed-route', studentId: 'removed-student', next: 'scheduled', revision: 1,
    reason: '과거 미하차 정정' });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.state.status, 'scheduled');
  assert.equal(reset.body.state.revision, 2);
  assert.equal(reset.body.state.boardedAt, null);
  assert.equal(reset.body.state.history.at(-1).reason, '과거 미하차 정정');
  const stale = await call(db, { auth: admin, action: 'state', date: oldDate,
    routeId: 'removed-route', studentId: 'removed-student', next: 'scheduled', revision: 1,
    reason: '중복 정정' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'STALE_REVISION');
});

test('only all-scope resets with a reason', async () => {
  const db = new TestD1(); seed(db); await replace(db);
  await call(db, { auth: person('driver-a', 'token-a'), action: 'state', date: today,
    routeId: 'route-a', studentId: 'student-a', next: 'absent', revision: 0 });
  const denied = await call(db, { auth: person('driver-a', 'token-a'), action: 'state', date: today,
    routeId: 'route-a', studentId: 'student-a', next: 'scheduled', revision: 1, reason: '오입력' });
  assert.equal(denied.status, 403);
  assert.equal((await call(db, { auth: admin, action: 'state', date: today,
    routeId: 'route-a', studentId: 'student-a', next: 'scheduled', revision: 1 })).status, 400);
  const reset = await call(db, { auth: admin, action: 'state', date: today,
    routeId: 'route-a', studentId: 'student-a', next: 'scheduled', revision: 1, reason: '오입력 수정' });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.state.status, 'scheduled');
  assert.equal(reset.body.state.revision, 2);
  assert.equal(reset.body.state.boardedAt, null);
  assert.equal(reset.body.state.droppedAt, null);
  assert.equal(reset.body.state.absentAt, null);
  assert.equal(reset.body.state.history.at(-1).reason, '오입력 수정');
  assert.equal(reset.body.state.history.at(-1).to, 'scheduled');
  assert.equal(db.prepare("SELECT count(*) AS count FROM transport_states").first().count, 1);

  const reboarded = await call(db, { auth: person('driver-a', 'token-a'), action: 'state', date: today,
    routeId: 'route-a', studentId: 'student-a', next: 'boarded', revision: 2 });
  assert.equal(reboarded.status, 200);
  assert.equal(reboarded.body.state.status, 'boarded');
  assert.equal(reboarded.body.state.revision, 3);
  assert.notEqual(reboarded.body.state.boardedAt, null);
  assert.equal(reboarded.body.state.absentAt, null);
  assert.equal((await call(db, { auth: person('driver-a', 'token-a'), action: 'state', date: today,
    routeId: 'route-a', studentId: 'student-a', next: 'boarded', revision: 2 })).status, 409);

  const row = db.prepare("SELECT history FROM transport_states WHERE app='task' AND student_id='student-a'").first();
  const history = JSON.parse(row.history);
  assert.equal(history.length, 3);
  assert.equal(history[1].reason, '오입력 수정');
  assert.deepEqual(history.map(event => event.to), ['absent', 'scheduled', 'boarded']);
});

test('database triggers close boarding races across roster, config, and staff writes', async () => {
  const db = new TestD1(); seed(db);
  assert.throws(() => seedBoarded(db, today), /BOARDING_LOCK/);

  await replace(db);
  assert.throws(() => seedBoarded(db, '2026-xx-11'), /BOARDING_LOCK/);
  seedBoarded(db, today);
  const rosterRow = db.prepare("SELECT data FROM private_rosters WHERE app='task'").first();
  const roster = JSON.parse(rosterRow.data);
  roster.roster.students = roster.roster.students.filter(item => item.id !== 'student-a');
  assert.throws(() => db.prepare("UPDATE private_rosters SET data=? WHERE app='task'")
    .bind(JSON.stringify(roster)).run(), /BOARDING_LOCK/);

  assert.throws(() => db.prepare("UPDATE transport_configs SET updated_at=updated_at+1 WHERE app='task'").run(),
    /BOARDING_LOCK/);
  const staffRow = db.prepare("SELECT data FROM staff WHERE app='task' AND id='driver-a'").first();
  assert.throws(() => db.prepare("UPDATE staff SET data=? WHERE app='task' AND id='driver-a'")
    .bind(JSON.stringify({ ...JSON.parse(staffRow.data), deleted: true })).run(), /BOARDING_LOCK/);
});

test('staff deactivate uses CAS and revokes tokens and bootstrap codes after the tombstone', async () => {
  const db = new TestD1(); seed(db);
  const current = db.prepare("SELECT updated_at FROM staff WHERE app='task' AND id='driver-b'").first();
  db.prepare(
    'INSERT INTO bootstrap_codes(app,code_hash,staff_id,created_at,expires_at,consumed_at,revoked) ' +
    'VALUES(?,?,?,?,?,NULL,0)'
  ).bind('task', 'sha256:test-bootstrap', 'driver-b', Date.now(), Date.now() + 10000).run();

  const result = await callPath(db, '/staff-deactivate', {
    auth: admin, staffId: 'driver-b', expectedUpdatedAt: Number(current.updated_at)
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.staff.authoritative, true);
  assert.equal(result.body.staff.data.deleted, true);
  assert.equal(result.body.updatedAt, result.body.staff.updated_at);
  assert.equal(db.prepare(
    "SELECT revoked FROM tokens WHERE app='task' AND staff_id='driver-b'"
  ).first().revoked, 1);
  assert.equal(db.prepare(
    "SELECT revoked FROM bootstrap_codes WHERE app='task' AND staff_id='driver-b'"
  ).first().revoked, 1);
});

test('staff deactivate stale CAS is not success and does not revoke access', async () => {
  const db = new TestD1(); seed(db);
  const current = db.prepare("SELECT updated_at FROM staff WHERE app='task' AND id='driver-b'").first();
  const result = await callPath(db, '/staff-deactivate', {
    auth: admin, staffId: 'driver-b', expectedUpdatedAt: Number(current.updated_at) - 1
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'STALE_REVISION');
  assert.equal(result.body.staff.authoritative, true);
  assert.equal(result.body.staff.data.deleted, false);
  assert.equal(db.prepare(
    "SELECT revoked FROM tokens WHERE app='task' AND staff_id='driver-b'"
  ).first().revoked, 0);
});

test('staff deactivate is BOARDING_LOCKed for a boarded driver and fail-closed for an orphan route', async () => {
  const db = new TestD1(); seed(db); await replace(db); seedBoarded(db, today);
  const driverA = db.prepare("SELECT updated_at FROM staff WHERE app='task' AND id='driver-a'").first();
  let result = await callPath(db, '/staff-deactivate', {
    auth: admin, staffId: 'driver-a', expectedUpdatedAt: Number(driverA.updated_at)
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'BOARDING_LOCK');
  assert.equal(db.prepare(
    "SELECT revoked FROM tokens WHERE app='task' AND staff_id='driver-a'"
  ).first().revoked, 0);

  db.withoutIntegrity(() => db.prepare("UPDATE transport_configs SET data=? WHERE app='task'")
    .bind(JSON.stringify({ vehicles: [], routes: [] })).run());
  const driverB = db.prepare("SELECT updated_at FROM staff WHERE app='task' AND id='driver-b'").first();
  result = await callPath(db, '/staff-deactivate', {
    auth: admin, staffId: 'driver-b', expectedUpdatedAt: Number(driverB.updated_at)
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'BOARDING_LOCK');
});

test('generic staff sync folds duplicate IDs to the final highest timestamp state', async () => {
  const db = new TestD1(); seed(db); await replace(db); seedBoarded(db, today);
  const current = db.prepare("SELECT data,updated_at FROM staff WHERE app='task' AND id='driver-a'").first();
  const active = JSON.parse(current.data);
  const deletedAt = Number(current.updated_at) + 1;
  const activeAt = deletedAt + 1;
  const result = await callPath(db, '/sync', {
    auth: admin, since: 0,
    changes: [
      { table: 'staff', id: 'driver-a', owner: 'driver-a',
        data: { ...active, deleted: true, updatedAt: deletedAt }, updated_at: deletedAt },
      { table: 'staff', id: 'driver-a', owner: 'driver-a',
        data: { ...active, deleted: false, updatedAt: activeAt }, updated_at: activeAt }
    ]
  });
  assert.equal(result.status, 200);
  const saved = db.prepare("SELECT data,updated_at FROM staff WHERE app='task' AND id='driver-a'").first();
  assert.equal(JSON.parse(saved.data).deleted, false);
  assert.equal(saved.updated_at, activeAt);
  assert.equal(db.prepare(
    "SELECT revoked FROM tokens WHERE app='task' AND staff_id='driver-a'"
  ).first().revoked, 0);
});

test('generic null staff deactivation atomically revokes old personal links', async () => {
  const db = new TestD1(); seed(db);
  const current = db.prepare("SELECT data,updated_at FROM staff WHERE app='task' AND id='driver-b'").first();
  const nextAt = Number(current.updated_at) + 1;
  db.prepare(
    'INSERT INTO bootstrap_codes(app,code_hash,staff_id,created_at,expires_at,consumed_at,revoked) ' +
    'VALUES(?,?,?,?,?,NULL,0)'
  ).bind('task', 'sha256:generic-bootstrap', 'driver-b', Date.now(), Date.now() + 10000).run();
  const result = await callPath(db, '/sync', {
    auth: admin, since: 0,
    changes: [{ table: 'staff', id: 'driver-b', owner: 'driver-b',
      data: null, updated_at: nextAt }]
  });
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(db.prepare(
    "SELECT data FROM staff WHERE app='task' AND id='driver-b'"
  ).first().data), null);
  assert.equal(db.prepare(
    "SELECT revoked FROM tokens WHERE app='task' AND staff_id='driver-b'"
  ).first().revoked, 1);
  assert.equal(db.prepare(
    "SELECT revoked FROM bootstrap_codes WHERE app='task' AND staff_id='driver-b'"
  ).first().revoked, 1);
});

test('admin can exactly reset a bounded malformed legacy date key while preserving history', async () => {
  const db = new TestD1(); seed(db); await replace(db);
  db.withoutIntegrity(() => seedBoarded(db, 'legacy:bad-date', 'removed-route', 'removed-student'));
  const result = await call(db, {
    auth: admin, action: 'state', date: 'legacy:bad-date', routeId: 'removed-route',
    studentId: 'removed-student', next: 'scheduled', revision: 1, reason: '과거 잘못된 날짜 키 정정'
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.state.status, 'scheduled');
  assert.equal(result.body.state.history.at(-1).reason, '과거 잘못된 날짜 키 정정');
  assert.equal((await call(db, {
    auth: admin, action: 'state', date: 'x'.repeat(41), routeId: 'removed-route',
    studentId: 'removed-student', next: 'scheduled', revision: 1, reason: '범위 밖 키'
  })).status, 400);
});
