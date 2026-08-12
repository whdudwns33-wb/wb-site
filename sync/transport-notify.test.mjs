import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import {
  TRANSPORT_TEMPLATE_TEXT, TRANSPORT_TEMPLATE_VARIABLES, addOwnDriverContacts,
  getTransportGuardian, sendTransportNotification, setTransportGuardian
} from './transport-notify.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/029_transport_notifications.sql', import.meta.url), 'utf8');
class Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  first() { return this.database.prepare(this.sql).get(...this.args) || null; }
  all() { return { results: this.database.prepare(this.sql).all(...this.args) }; }
  run() { const result = this.database.prepare(this.sql).run(...this.args); return { meta: { changes: Number(result.changes || 0) } }; }
}
class D1 {
  constructor() { this.database = new DatabaseSync(':memory:'); this.database.exec(schema); }
  prepare(sql) { return new Statement(this.database, sql); }
}
const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date());
const month = today.slice(0, 7), todayDay = new Date(today + 'T00:00:00Z').getUTCDay();
const admin = { scope: 'all' }, driver = { scope: 'own', id: 'driver-a' };
const envSend = {
  WB_TRANSPORT_NOTIFY_ENABLED: 'true', SOLAPI_KAKAO_API_KEY: 'key', SOLAPI_KAKAO_API_SECRET: 'secret',
  SOLAPI_KAKAO_PF_ID: 'PF_TEST', SOLAPI_KAKAO_TRANSPORT_BOARDED_APPROVED_TEMPLATE_ID: 'TPL_BOARD',
  SOLAPI_KAKAO_TRANSPORT_DROPPED_APPROVED_TEMPLATE_ID: 'TPL_DROP', SOLAPI_SENDER_NUMBER: '0212345678'
};
function config(direction = 'pickup') {
  return { vehicles: [{ id: 'van-a', name: '1호차', plate: '12가3456', capacity: 10 }], routes: [{
    id: 'route-a', name: '아침 노선', direction, vehicleId: 'van-a', driverId: 'driver-a', days: [todayDay],
    startTime: '08:00', active: true,
    stops: [{ id: 'stop-a', name: '중앙공원', time: '08:10', studentIds: ['student-a'] }]
  }] };
}
function seed(db, direction = 'pickup') {
  const now = Date.now();
  db.prepare('INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', 'driver-a', 'driver-a', JSON.stringify({ id: 'driver-a', name: '기사', deleted: false }), now, now).run();
  db.prepare('INSERT INTO private_rosters(app,data,updated_at) VALUES(?,?,?)').bind('task', JSON.stringify({
    roster: { updated: today, baseline: month, students: [{ id: 'student-a', name: '가학생', grade: '초3',
      teacher: '선생님', subject: '수학', teacherIds: ['driver-a'], start: month, end: '', reason: '' }] }, bookStudents: []
  }), now).run();
  db.prepare('INSERT INTO transport_configs(app,data,updated_at,updated_by) VALUES(?,?,?,?)')
    .bind('task', JSON.stringify(config(direction)), now, 'director').run();
}
async function setGuardian(db, patch = {}) {
  return setTransportGuardian({ DB: db }, {
    app: 'task', auth: {}, action: 'guardian_set', studentId: 'student-a', phone: '01012345678',
    confirmNewIdentity: true, callAllowed: true, boardedConsent: true, droppedConsent: true,
    expectedContactUpdatedAt: 0, expectedConsentUpdatedAt: 0, ...patch
  }, admin);
}
function seedState(db, state, revision = 1) {
  const now = Date.now();
  db.prepare(
    'INSERT INTO transport_states(app,date,route_id,student_id,status,revision,boarded_at,boarded_by,' +
    'dropped_at,dropped_by,absent_at,absent_by,history,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).bind('task', today, 'route-a', 'student-a', state, revision, now, 'driver-a',
    state === 'dropped' ? now : null, state === 'dropped' ? 'driver-a' : null, null, null, '[]', now).run();
}
function accepted() {
  return Response.json({ groupInfo: { groupId: 'group_1' }, messageList: [{ messageId: 'message_1', statusCode: '2000' }] });
}

test('migration and templates are immutable-safe and use only the five approved variables', () => {
  assert.doesNotMatch(migration, /phone|message_body|DROP TABLE|DELETE FROM/i);
  assert.deepEqual(TRANSPORT_TEMPLATE_VARIABLES,
    ['#{학생명}', '#{운행일}', '#{확인시각}', '#{노선명}', '#{확인지점}']);
  for (const value of Object.values(TRANSPORT_TEMPLATE_TEXT)) {
    assert.doesNotMatch(value, /기사명|기사번호|주소/);
    for (const variable of TRANSPORT_TEMPLATE_VARIABLES) assert.match(value, new RegExp(variable.replace(/[{}#$]/g, '\\$&')));
  }
});

test('guardian CAS hides raw phone, resets feedback consent on number change, and needs explicit new identity confirmation', async () => {
  const db = new D1(); seed(db);
  const first = await setGuardian(db);
  assert.equal(first.guardian.maskedPhone, '010****5678');
  assert.equal(Object.hasOwn(first.guardian, 'phone'), false);
  const row = db.prepare("SELECT * FROM guardian_contacts_by_student WHERE app='task' AND student_id='student-a'").first();
  db.prepare("UPDATE guardian_contacts_by_student SET consent=1 WHERE app='task' AND student_id='student-a'").run();
  await assert.rejects(() => setTransportGuardian({ DB: db }, {
    app: 'task', auth: {}, action: 'guardian_set', studentId: 'student-a', phone: '01087654321',
    callAllowed: true, boardedConsent: true, droppedConsent: true,
    expectedContactUpdatedAt: Number(row.updated_at), expectedConsentUpdatedAt: Number(row.transport_updated_at)
  }, admin), error => error.code === 'CONFIRM_NEW_IDENTITY_REQUIRED');
  const changed = await setTransportGuardian({ DB: db }, {
    app: 'task', auth: {}, action: 'guardian_set', studentId: 'student-a', phone: '01087654321', confirmNewIdentity: true,
    callAllowed: true, boardedConsent: true, droppedConsent: true,
    expectedContactUpdatedAt: Number(row.updated_at), expectedConsentUpdatedAt: Number(row.transport_updated_at)
  }, admin);
  assert.equal(changed.guardian.feedbackConsentReset, true);
  assert.equal(db.prepare("SELECT consent FROM guardian_contacts_by_student WHERE app='task'").first().consent, 0);
  const got = await getTransportGuardian({ DB: db }, { app: 'task', auth: {}, action: 'guardian_get', studentId: 'student-a' }, admin);
  assert.equal(got.guardian.callAllowed, true);
  // 기존 연락처 관리 화면이 번호를 먼저 바꾼 뒤 blank=현재 번호 유지로 차량 동의를 켜도
  // identity 불일치 상태에서는 새 보호자 직접 확인 없이는 승계할 수 없다.
  db.prepare("UPDATE guardian_contacts_by_student SET phone='01099998888',updated_at=updated_at+1 " +
    "WHERE app='task' AND student_id='student-a'").run();
  const externallyChanged = db.prepare("SELECT updated_at,transport_updated_at FROM guardian_contacts_by_student " +
    "WHERE app='task' AND student_id='student-a'").first();
  await assert.rejects(() => setTransportGuardian({ DB: db }, {
    app: 'task', auth: {}, action: 'guardian_set', studentId: 'student-a', phone: '',
    callAllowed: true, boardedConsent: true, droppedConsent: true,
    expectedContactUpdatedAt: Number(externallyChanged.updated_at),
    expectedConsentUpdatedAt: Number(externallyChanged.transport_updated_at)
  }, admin), error => error.code === 'CONFIRM_NEW_IDENTITY_REQUIRED');
  await assert.rejects(() => setTransportGuardian({ DB: db }, {
    app: 'task', auth: {}, action: 'guardian_set', studentId: 'student-a', callAllowed: false,
    boardedConsent: false, droppedConsent: false, expectedContactUpdatedAt: 0,
    expectedConsentUpdatedAt: changed.guardian.consentUpdatedAt
  }, admin), error => error.code === 'GUARDIAN_REVISION_CONFLICT');
});

test('existing feedback phone needs explicit confirmation on first transport consent setup', async () => {
  const db = new D1(); seed(db);
  const now = Date.now();
  db.prepare('INSERT INTO guardian_contacts_by_student(app,student_id,student_name,phone,consent,updated_at,updated_by) ' +
    'VALUES(?,?,?,?,?,?,?)').bind('task', 'student-a', '가학생', '01012345678', 1, now, 'director').run();
  const view = await getTransportGuardian({ DB: db },
    { app: 'task', auth: {}, action: 'guardian_get', studentId: 'student-a' }, admin);
  assert.equal(view.guardian.needsReconsent, true);
  await assert.rejects(() => setTransportGuardian({ DB: db }, {
    app: 'task', auth: {}, action: 'guardian_set', studentId: 'student-a', phone: '', callAllowed: true,
    boardedConsent: true, droppedConsent: true, expectedContactUpdatedAt: now, expectedConsentUpdatedAt: 0
  }, admin), error => error.code === 'CONFIRM_NEW_IDENTITY_REQUIRED');
});

test('all-false transport settings never pre-confirm later call or notification consent', async () => {
  const db = new D1(); seed(db);
  const disabled = await setTransportGuardian({ DB: db }, {
    app: 'task', auth: {}, action: 'guardian_set', studentId: 'student-a', phone: '01012345678',
    callAllowed: false, boardedConsent: false, droppedConsent: false,
    expectedContactUpdatedAt: 0, expectedConsentUpdatedAt: 0
  }, admin);
  assert.equal(disabled.guardian.needsReconsent, true);
  assert.equal(db.prepare("SELECT transport_guardian_identity_hash AS hash FROM guardian_contacts_by_student " +
    "WHERE app='task' AND student_id='student-a'").first().hash, null);
  await assert.rejects(() => setTransportGuardian({ DB: db }, {
    app: 'task', auth: {}, action: 'guardian_set', studentId: 'student-a', phone: '',
    callAllowed: true, boardedConsent: true, droppedConsent: true,
    expectedContactUpdatedAt: disabled.guardian.contactUpdatedAt,
    expectedConsentUpdatedAt: disabled.guardian.consentUpdatedAt
  }, admin), error => error.code === 'CONFIRM_NEW_IDENTITY_REQUIRED');
});

test('driver phone is exposed only for KST today, exact driver route, call consent and current identity', async () => {
  const db = new D1(); seed(db); await setGuardian(db);
  const routes = config().routes.map(route => ({ ...route, students: [{ id: 'student-a', name: '가학생' }] }));
  await addOwnDriverContacts({ DB: db }, today, driver, routes);
  assert.equal(routes[0].students[0].guardianPhone, '01012345678');
  const other = config().routes.map(route => ({ ...route, driverId: 'driver-b', students: [{ id: 'student-a', name: '가학생' }] }));
  await addOwnDriverContacts({ DB: db }, today, driver, other);
  assert.equal(Object.hasOwn(other[0].students[0], 'guardianPhone'), false);
  const manager = config().routes.map(route => ({ ...route, students: [{ id: 'student-a', name: '가학생' }] }));
  await addOwnDriverContacts({ DB: db }, today, { scope: 'all', role: 'manager', id: 'driver-a' }, manager);
  assert.equal(manager[0].students[0].guardianPhone, '01012345678');
  const tomorrow = new Date(today + 'T00:00:00Z'); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const future = config().routes.map(route => ({ ...route, students: [{ id: 'student-a', name: '가학생' }] }));
  await addOwnDriverContacts({ DB: db }, tomorrow.toISOString().slice(0, 10), driver, future);
  assert.equal(Object.hasOwn(future[0].students[0], 'guardianPhone'), false);
});

test('notification is fail-closed before fetch when gate is off and blocks non-today admin sends', async () => {
  const db = new D1(); seed(db); await setGuardian(db); seedState(db, 'boarded');
  let fetches = 0; const original = globalThis.fetch; globalThis.fetch = async () => { fetches += 1; return accepted(); };
  try {
    const gated = await sendTransportNotification({ DB: db }, { date: today, routeId: 'route-a',
      studentId: 'student-a', state: 'boarded', revision: 1 }, driver);
    assert.equal(gated.status, 'blocked'); assert.equal(gated.code, 'SEND_DISABLED');
    const yesterday = new Date(today + 'T00:00:00Z'); yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const historical = await sendTransportNotification({ DB: db, ...envSend }, {
      date: yesterday.toISOString().slice(0, 10), routeId: 'route-a', studentId: 'student-a', state: 'boarded', revision: 1
    }, admin);
    assert.equal(historical.code, 'DATE_FORBIDDEN'); assert.equal(fetches, 0);
  } finally { globalThis.fetch = original; }
});

test('pickup/dropoff messages use stop vs academy event location and exactly-once ledger', async () => {
  for (const [direction, event, expected] of [
    ['pickup', 'boarded', '중앙공원'], ['pickup', 'dropped', '학원'],
    ['dropoff', 'boarded', '학원'], ['dropoff', 'dropped', '중앙공원']
  ]) {
    const db = new D1(); seed(db, direction); await setGuardian(db); seedState(db, event);
    const payloads = [], original = globalThis.fetch;
    globalThis.fetch = async (_url, options) => { payloads.push(JSON.parse(options.body)); return accepted(); };
    try {
      const input = { date: today, routeId: 'route-a', studentId: 'student-a', state: event, revision: 1 };
      const first = await sendTransportNotification({ DB: db, ...envSend }, input, driver);
      const second = await sendTransportNotification({ DB: db, ...envSend }, input, driver);
      assert.equal(first.status, 'accepted'); assert.equal(second.idempotent, true); assert.equal(payloads.length, 1);
      assert.equal(payloads[0].messages[0].kakaoOptions.variables['#{확인지점}'], expected);
      assert.equal(payloads[0].messages[0].kakaoOptions.disableSms, true);
      assert.equal(Object.hasOwn(payloads[0].messages[0].kakaoOptions.variables, '#{정류장명}'), false);
    } finally { globalThis.fetch = original; }
  }
});

test('provider rejection and ambiguous body are distinct and never expose provider body', async () => {
  for (const [response, expected] of [
    [() => Response.json({ private: 'hidden' }, { status: 400 }), 'rejected'],
    [() => Response.json({ private: 'hidden' }), 'unknown']
  ]) {
    const db = new D1(); seed(db); await setGuardian(db); seedState(db, 'boarded');
    let fetches = 0;
    const original = globalThis.fetch; globalThis.fetch = async () => { fetches += 1; return response(); };
    try {
      const input = { date: today, routeId: 'route-a', studentId: 'student-a', state: 'boarded', revision: 1 };
      const result = await sendTransportNotification({ DB: db, ...envSend }, input, driver);
      assert.equal(result.status, expected); assert.doesNotMatch(JSON.stringify(result), /private|hidden/);
      assert.equal(result.retryAllowed, false);
      const repeated = await sendTransportNotification({ DB: db, ...envSend }, input, driver);
      assert.equal(repeated.status, expected); assert.equal(repeated.idempotent, true); assert.equal(fetches, 1);
    } finally { globalThis.fetch = original; }
  }
});

test('contact mutation after reservation is rejected before provider fetch', async () => {
  const db = new D1(); seed(db); await setGuardian(db); seedState(db, 'boarded');
  const originalPrepare = db.prepare.bind(db);
  let changed = false;
  db.prepare = sql => {
    const statement = originalPrepare(sql);
    if (!changed && String(sql).startsWith('INSERT OR IGNORE INTO transport_notification_sends ')) {
      const originalRun = statement.run.bind(statement);
      statement.run = () => {
        const result = originalRun();
        changed = true;
        db.database.prepare(
          "UPDATE guardian_contacts_by_student SET phone='01099998888',updated_at=updated_at+1 " +
          "WHERE app='task' AND student_id='student-a'"
        ).run();
        return result;
      };
    }
    return statement;
  };
  let fetches = 0, originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetches += 1; return accepted(); };
  try {
    const result = await sendTransportNotification({ DB: db, ...envSend }, { date: today, routeId: 'route-a',
      studentId: 'student-a', state: 'boarded', revision: 1 }, driver);
    assert.equal(result.status, 'rejected');
    assert.equal(result.code, 'SOURCE_CHANGED_BEFORE_DISPATCH');
    assert.equal(fetches, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('oversized and hanging provider bodies become unknown and are never retried', async () => {
  for (const kind of ['oversized', 'hanging']) {
    const db = new D1(); seed(db); await setGuardian(db); seedState(db, 'boarded');
    let fetches = 0;
    const originalFetch = globalThis.fetch, originalSetTimeout = globalThis.setTimeout;
    globalThis.fetch = async () => {
      fetches += 1;
      return kind === 'oversized'
        ? new Response('x', { status: 200, headers: { 'content-length': '70000' } })
        : new Response(new ReadableStream({ start() {} }), { status: 200 });
    };
    if (kind === 'hanging') {
      globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback,
        delay === 8000 ? 0 : delay, ...args);
    }
    try {
      const input = { date: today, routeId: 'route-a', studentId: 'student-a', state: 'boarded', revision: 1 };
      const result = await sendTransportNotification({ DB: db, ...envSend }, input, driver);
      assert.equal(result.status, 'unknown');
      assert.equal(result.code, kind === 'oversized' ? 'SOLAPI_RESPONSE_TOO_LARGE' : 'SOLAPI_TIMEOUT');
      const repeated = await sendTransportNotification({ DB: db, ...envSend }, input, driver);
      assert.equal(repeated.status, 'unknown'); assert.equal(repeated.idempotent, true); assert.equal(fetches, 1);
    } finally {
      globalThis.fetch = originalFetch; globalThis.setTimeout = originalSetTimeout;
    }
  }
});
