import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

import worker from './worker-core.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/023_transport.sql', import.meta.url), 'utf8');
const integrityMigration = fs.readFileSync(new URL('./migrations/024_transport_integrity.sql', import.meta.url), 'utf8');
const notificationMigration = fs.readFileSync(new URL('./migrations/029_transport_notifications.sql', import.meta.url), 'utf8');

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

async function call(db, body, app = 'task', envOverrides = {}) {
  return callPath(db, '/transport', body, app, envOverrides);
}

async function callPath(db, path, body, app = 'task', envOverrides = {}) {
  const response = await worker.fetch(new Request('https://worker.example' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app, ...body })
  }), { DB: db, TASK_ADMIN_SECRET: 'director-secret', CONSULT_ADMIN_SECRET: 'consult-secret', ...envOverrides });
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

function planRequest(overrides = {}) {
  return {
    auth: admin, action: 'plan', baseAddress: '서울 학원로 1', direction: 'dropoff',
    startTime: '18:00', dwellMinutes: 2,
    stops: [
      { id: 'stop-a', name: '첫 정류장', address: '서울 정류장로 10' },
      { id: 'stop-b', name: '둘째 정류장', address: '서울 정류장로 20' }
    ],
    ...overrides
  };
}

function mapsFetchMock({ geocode = {}, legs = [], status = 200 } = {}) {
  let legIndex = 0;
  return async function mockedFetch(input, options) {
    const url = new URL(input);
    assert.equal(options.headers['x-ncp-apigw-api-key-id'], 'maps-id');
    assert.equal(options.headers['x-ncp-apigw-api-key'], 'maps-secret');
    if (status !== 200) return Response.json({ privateProviderError: 'must-not-leak' }, { status });
    if (url.pathname.includes('/geocode')) {
      const query = url.searchParams.get('query');
      const item = geocode[query];
      return Response.json(item ? { status: 'OK', addresses: [{
        x: String(item.x), y: String(item.y), roadAddress: item.address, jibunAddress: ''
      }] } : { status: 'OK', addresses: [] });
    }
    const leg = legs[legIndex++];
    return Response.json(leg ? { code: 0, route: { traoptimal: [{ summary: {
      distance: leg.distance, duration: leg.minutes * 60000
    } }] } } : { code: 3, route: {} });
  };
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

test('transport notification migration is additive, append-only, and rejects malformed dates', () => {
  assert.match(notificationMigration, /transport_notification_sends/);
  assert.match(notificationMigration, /COALESCE\(length\(transport_date\)/);
  assert.doesNotMatch(notificationMigration, /DROP TABLE|DELETE FROM/i);
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  assert.throws(() => database.prepare(
    'INSERT INTO transport_notification_sends ' +
    '(app,send_id,idempotency_key,event_state,transport_date,route_id,student_id,source_revision,' +
    'variables_hash,template_id,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run('task', 'send-bad', 'a'.repeat(64), 'boarded', '2026-xx-12', 'route-a', 'student-a', 1,
    'b'.repeat(64), 'TPL', Date.now(), 'director'));
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

test('config accepts optional route-planning fields and rejects unsafe schedules and duplicate plates', async () => {
  const db = new TestD1(); seed(db);
  const valid = configFixture();
  valid.baseAddress = '서울 학원로 1';
  valid.routes[0].stops[0].address = '서울 정류장로 10';
  valid.routes[0].plan = {
    provider: 'naver', distanceMeters: 3200, driveMinutes: 12, serviceMinutes: 15, dwellMinutes: 2, plannedAt: Date.now()
  };
  const saved = await replace(db, valid);
  assert.equal(saved.status, 200);

  const duplicatePlate = configFixture();
  duplicatePlate.vehicles[1].plate = '12가-3456';
  assert.match((await replace(db, duplicatePlate, saved.body.revision)).body.error, /중복 차량번호/);

  const earlyStop = configFixture();
  earlyStop.routes[0].stops[0].time = '18:59';
  assert.match((await replace(db, earlyStop, saved.body.revision)).body.error, /출발시간부터/);

  const backwards = configFixture();
  backwards.routes[0].stops.push({ id: 'stop-a2', name: '두 번째', time: '19:14', studentIds: [] });
  assert.match((await replace(db, backwards, saved.body.revision)).body.error, /운행 순서/);

  const stalePlan = configFixture();
  stalePlan.routes[0].plan = {
    provider: 'naver', distanceMeters: 1000, driveMinutes: 5, serviceMinutes: 10, dwellMinutes: 2, plannedAt: Date.now()
  };
  assert.match((await replace(db, stalePlan, saved.body.revision)).body.error, /마지막 정류장 시간/);

  const driverOverlap = configFixture();
  driverOverlap.routes[1].driverId = 'driver-a';
  driverOverlap.routes[1].startTime = '19:10';
  driverOverlap.routes[1].stops[0].time = '19:20';
  assert.match((await replace(db, driverOverlap, saved.body.revision)).body.error, /한 기사/);

  const vehicleOverlap = configFixture();
  vehicleOverlap.routes[1].vehicleId = 'van-a';
  vehicleOverlap.routes[1].startTime = '19:10';
  vehicleOverlap.routes[1].stops[0].time = '19:20';
  assert.match((await replace(db, vehicleOverlap, saved.body.revision)).body.error, /한 차량/);
});

test('route plan is all-scope only and validates an exact bounded request', async () => {
  const db = new TestD1(); seed(db);
  assert.equal((await call(db, planRequest({ auth: person('driver-a', 'token-a') }))).status, 403);
  assert.equal((await call(db, planRequest({ extra: true }))).status, 400);
  assert.equal((await call(db, planRequest({ stops: [] }))).status, 400);
  assert.equal((await call(db, planRequest({ stops: Array.from({ length: 16 }, (_, index) => ({
    id: 'stop-' + index, name: '정류장 ' + index, address: '서울 테스트로 ' + index
  })) }))).status, 400);
  assert.equal((await call(db, planRequest({ dwellMinutes: 61 }))).status, 400);
  const missingKeys = await call(db, planRequest(), 'task');
  assert.equal(missingKeys.status, 503);
  assert.equal(missingKeys.body.code, 'MAPS_NOT_CONFIGURED');
});

test('admin list reports only whether dedicated maps credentials are ready', async () => {
  const db = new TestD1(); seed(db); await replace(db);
  const missing = await call(db, { auth: admin, action: 'list', date: today }, 'task', {
    NAVER_ID: 'search-only-id', NAVER_SECRET: 'search-only-secret'
  });
  assert.deepEqual(missing.body.capabilities, { mapsPlanning: false });
  const ready = await call(db, { auth: admin, action: 'list', date: today }, 'task', {
    NAVER_MAPS_ID: 'maps-id', NAVER_MAPS_SECRET: 'maps-secret'
  });
  assert.deepEqual(ready.body.capabilities, { mapsPlanning: true });
  assert.doesNotMatch(JSON.stringify(ready.body.capabilities), /maps-id|maps-secret/);
});

test('dropoff plan geocodes public addresses and calculates traffic times sequentially', async t => {
  const db = new TestD1(); seed(db);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mapsFetchMock({
    geocode: {
      '서울 학원로 1': { x: 127.0, y: 37.0, address: '서울 학원로 1' },
      '서울 정류장로 10': { x: 127.1, y: 37.1, address: '서울 정류장로 10 (공개)' },
      '서울 정류장로 20': { x: 127.2, y: 37.2, address: '서울 정류장로 20 (공개)' }
    },
    legs: [{ distance: 1000, minutes: 7 }, { distance: 2200, minutes: 8 }]
  });
  t.after(() => { globalThis.fetch = originalFetch; });
  const result = await call(db, planRequest(), 'task', {
    NAVER_MAPS_ID: 'maps-id', NAVER_MAPS_SECRET: 'maps-secret',
    NAVER_ID: 'fallback-id', NAVER_SECRET: 'fallback-secret'
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.plan, {
    provider: 'naver', distanceMeters: 3200, driveMinutes: 15, serviceMinutes: 19, dwellMinutes: 2,
    plannedAt: result.body.plan.plannedAt
  });
  assert.deepEqual(result.body.suggestedStops, [
    { id: 'stop-a', time: '18:07', address: '서울 정류장로 10 (공개)' },
    { id: 'stop-b', time: '18:17', address: '서울 정류장로 20 (공개)' }
  ]);
  assert.equal(result.body.trafficBased, true);
});

test('pickup plan includes academy departure, every stop, and final academy return', async t => {
  const db = new TestD1(); seed(db);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mapsFetchMock({
    geocode: {
      '서울 학원로 1': { x: 127.0, y: 37.0, address: '서울 학원로 1' },
      '서울 정류장로 10': { x: 127.1, y: 37.1, address: '서울 정류장로 10' },
      '서울 정류장로 20': { x: 127.2, y: 37.2, address: '서울 정류장로 20' }
    },
    legs: [
      { distance: 700, minutes: 4 },
      { distance: 900, minutes: 5 },
      { distance: 1800, minutes: 9 }
    ]
  });
  t.after(() => { globalThis.fetch = originalFetch; });
  const result = await call(db, planRequest({ direction: 'pickup', startTime: '07:30', dwellMinutes: 3 }),
    'task', { NAVER_MAPS_ID: 'maps-id', NAVER_MAPS_SECRET: 'maps-secret' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.suggestedStops.map(item => item.time), ['07:34', '07:42']);
  assert.equal(result.body.plan.distanceMeters, 3400);
  assert.equal(result.body.plan.driveMinutes, 18);
  assert.equal(result.body.plan.serviceMinutes, 24);
});

test('route plan returns safe provider error codes without leaking provider bodies or keys', async t => {
  const db = new TestD1(); seed(db);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mapsFetchMock({ status: 429 });
  t.after(() => { globalThis.fetch = originalFetch; });
  const result = await call(db, planRequest(), 'task', {
    NAVER_MAPS_ID: 'maps-id', NAVER_MAPS_SECRET: 'maps-secret'
  });
  assert.equal(result.status, 502);
  assert.equal(result.body.code, 'MAPS_NOT_ENABLED');
  assert.doesNotMatch(JSON.stringify(result.body), /must-not-leak|maps-secret|maps-id/);
});

test('route plan limits provider response bodies', async t => {
  const db = new TestD1(); seed(db);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, options) => {
    assert.equal(options.headers['x-ncp-apigw-api-key-id'], 'maps-id');
    return new Response('x', { status: 200, headers: { 'content-length': '300000' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const result = await call(db, planRequest(), 'task', {
    NAVER_MAPS_ID: 'maps-id', NAVER_MAPS_SECRET: 'maps-secret'
  });
  assert.equal(result.status, 502);
  assert.equal(result.body.code, 'MAPS_INVALID_RESPONSE');
});

test('route plan hides coded provider stream failures', async t => {
  const db = new TestD1(); seed(db);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) {
      const error = new Error('upstream private ECONNRESET detail');
      error.code = 'ECONNRESET';
      controller.error(error);
    }
  }), { status: 200 });
  t.after(() => { globalThis.fetch = originalFetch; });
  const result = await call(db, planRequest(), 'task', {
    NAVER_MAPS_ID: 'maps-id', NAVER_MAPS_SECRET: 'maps-secret'
  });
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'MAPS_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(result.body), /ECONNRESET|upstream private/);
});

test('route plan aborts a stalled provider call and reports only a safe timeout code', async t => {
  const db = new TestD1(); seed(db);
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback,
    delay === 25000 ? 0 : delay, ...args);
  globalThis.fetch = async (_input, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('provider secret timeout', 'AbortError')),
      { once: true });
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  });
  const result = await call(db, planRequest(), 'task', {
    NAVER_MAPS_ID: 'maps-id', NAVER_MAPS_SECRET: 'maps-secret'
  });
  assert.equal(result.status, 504);
  assert.equal(result.body.code, 'MAPS_TIMEOUT');
  assert.doesNotMatch(JSON.stringify(result.body), /provider secret|maps-secret/);
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
  const db = new TestD1(); seed(db);
  const config = configFixture();
  config.baseAddress = '공개 학원 주소';
  config.routes[0].stops[0].address = '공개 정류장 주소';
  config.routes[0].plan = {
    provider: 'naver', distanceMeters: 1000, driveMinutes: 5, serviceMinutes: 15, dwellMinutes: 2, plannedAt: Date.now()
  };
  await replace(db, config);
  const result = await call(db, { auth: person('driver-a', 'token-a'), action: 'list', date: today });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.routes.map(route => route.id), ['route-a']);
  assert.deepEqual(result.body.config.routes.map(route => route.id), ['route-a']);
  assert.deepEqual(Object.keys(result.body.routes[0].students[0]).sort(),
    ['callReady', 'grade', 'guardianPhone', 'id', 'name', 'notification', 'revision', 'status', 'stop']);
  assert.equal(result.body.routes[0].students[0].guardianPhone, null);
  assert.equal(result.body.routes[0].students[0].callReady, false);
  assert.equal(Object.hasOwn(result.body.config, 'baseAddress'), false);
  assert.equal(Object.hasOwn(result.body.config.routes[0], 'plan'), false);
  assert.equal(Object.hasOwn(result.body.config.routes[0].stops[0], 'address'), false);
  assert.equal(Object.hasOwn(result.body.routes[0], 'plan'), false);
  assert.equal(Object.hasOwn(result.body.routes[0].stops[0], 'address'), false);
  const serialized = JSON.stringify(result.body);
  assert.doesNotMatch(serialized, /SECRET|GUARDIAN SECRET|010\d|010-|공개 학원 주소|공개 정류장 주소|"address"|"memo"/i);
  const adminView = await call(db, { auth: admin, action: 'list', date: today });
  assert.equal(Object.hasOwn(adminView.body.routes[0].students[0], 'guardianPhone'), false);
  assert.equal(Object.hasOwn(adminView.body.routes[0].students[0], 'callReady'), false);
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

test('state defaults to notification attempt and stays HTTP 200 when the provider result ledger cannot be written', async () => {
  const db = new TestD1(); seed(db); await replace(db);
  const guardian = await call(db, { auth: admin, action: 'guardian_set', studentId: 'student-a',
    phone: '01012345678', confirmNewIdentity: true, callAllowed: true,
    boardedConsent: true, droppedConsent: true, expectedContactUpdatedAt: 0, expectedConsentUpdatedAt: 0 });
  assert.equal(guardian.status, 200);
  const originalPrepare = db.prepare.bind(db);
  db.prepare = sql => {
    if (String(sql).startsWith('INSERT OR IGNORE INTO transport_notification_send_events ')) {
      return { bind() { return this; }, run() { throw new Error('private persistence failure'); } };
    }
    return originalPrepare(sql);
  };
  let fetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetches += 1;
    return Response.json({ groupInfo: { groupId: 'group_1' },
      messageList: [{ messageId: 'message_1', statusCode: '2000' }] });
  };
  try {
    const result = await call(db, { auth: person('driver-a', 'token-a'), action: 'state', date: today,
      routeId: 'route-a', studentId: 'student-a', next: 'boarded', revision: 0 }, 'task', {
      WB_TRANSPORT_NOTIFY_ENABLED: 'true', SOLAPI_KAKAO_API_KEY: 'key', SOLAPI_KAKAO_API_SECRET: 'secret',
      SOLAPI_KAKAO_PF_ID: 'PF_TEST', SOLAPI_KAKAO_TRANSPORT_BOARDED_APPROVED_TEMPLATE_ID: 'TPL_BOARD',
      SOLAPI_SENDER_NUMBER: '0212345678'
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.state.status, 'boarded');
    assert.equal(result.body.notification.status, 'unknown');
    assert.equal(result.body.notification.code, 'SEND_RESULT_NOT_RECORDED');
    assert.equal(result.body.notification.retryAllowed, false);
    assert.equal(fetches, 1);
    db.prepare = originalPrepare;
    const refreshed = await call(db, { auth: admin, action: 'list', date: today });
    const student = refreshed.body.routes.find(route => route.id === 'route-a').students[0];
    assert.equal(student.notification.status, 'unknown');
    assert.equal(student.notification.code, 'PRIOR_SEND_UNCERTAIN');
    assert.equal(student.notification.retryAllowed, false);
  } finally { globalThis.fetch = originalFetch; }
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
