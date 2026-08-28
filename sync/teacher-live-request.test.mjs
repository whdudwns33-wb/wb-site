import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { handleTeacherLiveRequest } from './teacher-live-request.js';

const TABLE_SQL = `
CREATE TABLE staff (
  app TEXT NOT NULL,
  id TEXT NOT NULL,
  owner TEXT,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  srv_at INTEGER NOT NULL,
  PRIMARY KEY (app,id)
);
CREATE TABLE tasks (
  app TEXT NOT NULL,
  id TEXT NOT NULL,
  owner TEXT,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  srv_at INTEGER NOT NULL,
  PRIMARY KEY (app,id)
);
CREATE TABLE weekend_actual_visits (
  app TEXT NOT NULL,
  visit_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  lesson_task_id TEXT NOT NULL,
  visit_date TEXT NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (app,visit_id)
);
CREATE TABLE teacher_live_requests (
  app TEXT NOT NULL CHECK (app='task'),
  request_id TEXT NOT NULL CHECK (request_id LIKE 'tlr_%'),
  lesson_task_id TEXT NOT NULL,
  lesson_date TEXT NOT NULL,
  student_id TEXT NOT NULL,
  sender_staff_id TEXT NOT NULL,
  recipient_admin_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 2000),
  created_at INTEGER NOT NULL CHECK (created_at>0),
  PRIMARY KEY (app,request_id)
);
CREATE TABLE teacher_live_request_receipt_events (
  app TEXT NOT NULL CHECK (app='task'),
  receipt_event_id TEXT NOT NULL CHECK (receipt_event_id LIKE 'tlre_%'),
  request_id TEXT NOT NULL,
  admin_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('opened','acknowledged')),
  created_at INTEGER NOT NULL CHECK (created_at>0),
  PRIMARY KEY (app,receipt_event_id),
  UNIQUE (app,request_id,admin_id,event_type),
  FOREIGN KEY (app,request_id) REFERENCES teacher_live_requests(app,request_id)
);
CREATE TRIGGER teacher_live_requests_no_update BEFORE UPDATE ON teacher_live_requests
BEGIN SELECT RAISE(ABORT,'TEACHER_LIVE_REQUEST_APPEND_ONLY'); END;
CREATE TRIGGER teacher_live_requests_no_delete BEFORE DELETE ON teacher_live_requests
BEGIN SELECT RAISE(ABORT,'TEACHER_LIVE_REQUEST_APPEND_ONLY'); END;
CREATE TRIGGER teacher_live_request_receipts_no_update BEFORE UPDATE ON teacher_live_request_receipt_events
BEGIN SELECT RAISE(ABORT,'TEACHER_LIVE_REQUEST_RECEIPT_APPEND_ONLY'); END;
CREATE TRIGGER teacher_live_request_receipts_no_delete BEFORE DELETE ON teacher_live_request_receipt_events
BEGIN SELECT RAISE(ABORT,'TEACHER_LIVE_REQUEST_RECEIPT_APPEND_ONLY'); END;
`;

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
  constructor(ready = true) {
    this.database = new DatabaseSync(':memory:');
    this.database.exec(TABLE_SQL.slice(0, ready ? undefined : TABLE_SQL.indexOf('CREATE TABLE teacher_live_requests')));
  }
  prepare(sql) { return new Statement(this.database, sql); }
  batch(statements) { return Promise.resolve(statements.map(statement => statement.run())); }
}

const teacher = id => ({ scope: 'own', id });
const manager = id => ({ scope: 'all', id, role: 'manager' });
const director = { scope: 'all' };
const json = (body, status) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' }
});
const today = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

async function atNow(value, action) {
  const original = Date.now;
  Date.now = () => value;
  try { return await action(); } finally { Date.now = original; }
}

function dateOffset(value) {
  return new Date(Date.parse(today() + 'T00:00:00.000Z') + value * 86400000).toISOString().slice(0, 10);
}

function envFor(db) {
  return {
    DB: db,
    TASK_MANAGER_STAFF_IDS: 'manager-a,manager-deleted',
    TASK_MANAGER_STAFF_IDS_CONFIG: 'manager-b,manager-a'
  };
}

function putStaff(db, id, data) {
  const now = Date.now();
  db.prepare('INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', id, id, JSON.stringify({ id, name: id, deleted: false, ...data }), now, now).run();
}

function putTask(db, id, owner, overrides = {}) {
  const now = Date.now();
  const task = {
    id, staffId: owner, studentId: '12345678', taskKind: 'lesson_instruction',
    repeat: 'daily', days: [], start: dateOffset(-10), end: '', deleted: false,
    title: '[수업] 테스트 학생 — 수학', ...overrides
  };
  db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', id, owner, JSON.stringify(task), now, now).run();
  return task;
}

function putWeekendVisit(db, taskId, studentId, visitDate, status = 'completed') {
  db.prepare(
    'INSERT INTO weekend_actual_visits(app,visit_id,student_id,lesson_task_id,visit_date,status) VALUES(?,?,?,?,?,?)'
  ).bind('task', 'wv_' + 'a'.repeat(32), studentId, taskId, visitDate, status).run();
}

function seed(db) {
  putStaff(db, 'teacher-a', {});
  putStaff(db, 'teacher-b', {});
  putStaff(db, 'manager-a', { phone: '01000000000' });
  putStaff(db, 'manager-b', {});
  putStaff(db, 'manager-deleted', { deleted: true });
  putStaff(db, 'forged-manager', { manager: true });
  putTask(db, 'lesson-a', 'teacher-a');
  putTask(db, 'lesson-b', 'teacher-b');
}

async function call(db, payload, auth = teacher('teacher-a'), env = envFor(db)) {
  const response = await handleTeacherLiveRequest(env, 'task', { app: 'task', ...payload },
    'https://worker.example', auth, json);
  return { status: response.status, body: await response.json() };
}

function request(overrides = {}) {
  return {
    action: 'send', requestId: 'tlr_request_001', lessonTaskId: 'lesson-a',
    lessonDate: today(), recipientAdminId: 'manager-a', body: '수업 중 확인이 필요합니다.',
    ...overrides
  };
}

test('수신자는 director와 배포 allowlist의 활성 stable staffId만 반환한다', async () => {
  const db = new TestD1(); seed(db);
  const result = await call(db, { action: 'recipients' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.recipientAdminIds, ['director', 'manager-a', 'manager-b']);
  assert.deepEqual(result.body.recipientAdmins.map(item => [item.adminId, item.displayName]), [
    ['director', '원장님'], ['manager-a', 'manager-a'], ['manager-b', 'manager-b']
  ]);
  assert.doesNotMatch(JSON.stringify(result.body), /01000000000|forged-manager|manager-deleted/);

  const anonymous = await call(db, { action: 'recipients' }, director);
  assert.equal(anonymous.status, 403);
});

test('담당 교사는 오늘 진행되는 자신의 활성 수업 요청만 stable ID로 멱등 저장한다', async () => {
  const db = new TestD1(); seed(db);
  const before = Date.now();
  const first = await call(db, request());
  const after = Date.now();
  assert.equal(first.status, 200);
  assert.equal(first.body.idempotent, false);
  assert.deepEqual({
    requestId: first.body.request.requestId,
    lessonTaskId: first.body.request.lessonTaskId,
    studentId: first.body.request.studentId,
    senderStaffId: first.body.request.senderStaffId,
    recipientAdminId: first.body.request.recipientAdminId
  }, {
    requestId: 'tlr_request_001', lessonTaskId: 'lesson-a', studentId: '12345678',
    senderStaffId: 'teacher-a', recipientAdminId: 'manager-a'
  });
  assert.doesNotMatch(JSON.stringify(first.body), /테스트 학생|01000000000/);
  assert.ok(first.body.request.createdAt >= before && first.body.request.createdAt <= after);
  assert.equal(db.database.prepare(
    "SELECT created_at FROM teacher_live_requests WHERE request_id='tlr_request_001'"
  ).get().created_at, first.body.request.createdAt);
  assert.equal(db.database.prepare('SELECT COUNT(*) count FROM teacher_live_requests').get().count, 1);

  const retry = await call(db, request());
  assert.equal(retry.status, 200);
  assert.equal(retry.body.idempotent, true);
  assert.equal(retry.body.request.createdAt, first.body.request.createdAt);
  assert.equal(db.database.prepare('SELECT COUNT(*) count FROM teacher_live_requests').get().count, 1);

  const collision = await call(db, request({ body: '서로 다른 요청입니다.' }));
  assert.equal(collision.status, 409);
  assert.equal(collision.body.code, 'REQUEST_ID_CONFLICT');
});

test('비정기 수업은 오늘의 exact 실제 등원 기록이 있을 때만 실시간 요청을 보낸다', async () => {
  const sunday = Date.parse('2026-08-30T10:00:00+09:00');
  await atNow(sunday, async () => {
    for (const status of [null, 'cancelled', 'completed']) {
      const db = new TestD1(); seed(db);
      putTask(db, 'lesson-flex', 'teacher-a', {
        repeat: 'days', days: [6], weekendAttendanceMode: 'flexible', weekendAllowedDays: [0],
        weekendMonthlyTarget: null, weekendFlexibleFrom: '2026-08-01'
      });
      if (status) putWeekendVisit(db, 'lesson-flex', '12345678', today(), status);
      const result = await call(db, request({
        requestId: 'tlr_flexible_' + (status || 'missing'), lessonTaskId: 'lesson-flex'
      }));
      assert.equal(result.status, status === 'completed' ? 200 : 422);
    }
  });
});

test('비정기 적용 시작일 전에는 기존 정기 요일에서 실제 방문 없이 요청할 수 있다', async () => {
  const saturday = Date.parse('2026-08-29T10:00:00+09:00');
  await atNow(saturday, async () => {
    const db = new TestD1(); seed(db);
    putTask(db, 'lesson-future-flex', 'teacher-a', {
      repeat: 'days', days: [6], weekendAttendanceMode: 'flexible', weekendAllowedDays: [0],
      weekendMonthlyTarget: 2, weekendFlexibleFrom: '2026-08-30'
    });
    const result = await call(db, request({
      requestId: 'tlr_future_flexible', lessonTaskId: 'lesson-future-flex'
    }));
    assert.equal(result.status, 200);
  });
});

test('다른 담당자·과거 날짜·오늘 일정이 아닌 수업·위조 수신자를 거부한다', async () => {
  const db = new TestD1(); seed(db);
  assert.equal((await call(db, request(), teacher('teacher-b'))).status, 403);
  assert.equal((await call(db, request({ requestId: 'tlr_request_002', lessonDate: dateOffset(-1) }))).status, 422);

  const otherDay = (new Date(today() + 'T00:00:00.000Z').getUTCDay() + 1) % 7;
  putTask(db, 'lesson-other-day', 'teacher-a', { repeat: 'days', days: [otherDay] });
  assert.equal((await call(db, request({ requestId: 'tlr_request_003', lessonTaskId: 'lesson-other-day' }))).status, 422);
  assert.equal((await call(db, request({ requestId: 'tlr_request_004', recipientAdminId: 'forged-manager' }))).status, 422);
  assert.equal(db.database.prepare('SELECT COUNT(*) count FROM teacher_live_requests').get().count, 0);
});

test('본문과 요청 ID를 검증하고 정규화된 본문만 저장한다', async () => {
  const db = new TestD1(); seed(db);
  assert.equal((await call(db, request({ requestId: 'bad id' }))).status, 400);
  assert.equal((await call(db, request({ requestId: 'tlr_request_005', body: '   ' }))).status, 400);
  assert.equal((await call(db, request({ requestId: 'tlr_request_006', body: '가'.repeat(2001) }))).status, 400);
  const cleaned = await call(db, request({ requestId: 'tlr_request_007', body: '첫 줄  \r\n\r\n\r\n둘째 줄' }));
  assert.equal(cleaned.status, 200);
  assert.equal(cleaned.body.request.body, '첫 줄\n\n둘째 줄');
});

test('모든 scope=all 관리자는 수신자와 무관하게 같은 전체 요청 목록을 본다', async () => {
  const db = new TestD1(); seed(db);
  await call(db, request());
  await call(db, request({ requestId: 'tlr_request_008', recipientAdminId: 'director', body: '원장 확인 요청입니다.' }));

  const byDirector = await call(db, { action: 'list' }, director);
  const byManagerA = await call(db, { action: 'list' }, manager('manager-a'));
  const byManagerB = await call(db, { action: 'list' }, manager('manager-b'));
  assert.equal(byDirector.status, 200);
  assert.equal(byManagerA.status, 200);
  assert.equal(byManagerB.status, 200);
  assert.deepEqual(byDirector.body.requests, byManagerA.body.requests);
  assert.deepEqual(byManagerA.body.requests, byManagerB.body.requests);
  assert.deepEqual([byDirector.body.viewerAdminId, byManagerA.body.viewerAdminId, byManagerB.body.viewerAdminId],
    ['director', 'manager-a', 'manager-b']);
  assert.deepEqual(new Set(byDirector.body.requests.map(row => row.recipientAdminId)), new Set(['director', 'manager-a']));
  assert.equal((await call(db, { action: 'list' }, teacher('teacher-a'))).status, 403);
});

test('opened와 acknowledge는 지정 수신자와 무관하게 관리자별 append-only로 독립 저장한다', async () => {
  const db = new TestD1(); seed(db);
  await call(db, request());
  assert.equal((await call(db, { action: 'opened', requestId: 'tlr_request_001' }, director)).status, 200);
  const ackA = await call(db, { action: 'acknowledge', requestId: 'tlr_request_001' }, manager('manager-a'));
  assert.equal(ackA.status, 200);
  assert.equal(ackA.body.idempotent, false);
  assert.equal((await call(db, { action: 'acknowledge', requestId: 'tlr_request_001' }, manager('manager-a'))).body.idempotent, true);

  const listed = await call(db, { action: 'list' }, manager('manager-b'));
  const status = new Map(listed.body.requests[0].receiptStatus.map(row => [row.adminId, row]));
  assert.ok(status.get('director').openedAt);
  assert.equal(status.get('director').acknowledgedAt, null);
  assert.ok(status.get('manager-a').openedAt);
  assert.ok(status.get('manager-a').acknowledgedAt);
  assert.equal(status.get('manager-b').openedAt, null);
  assert.equal(status.get('manager-b').acknowledgedAt, null);
  assert.equal(db.database.prepare(
    "SELECT COUNT(*) count FROM teacher_live_request_receipt_events WHERE request_id='tlr_request_001'"
  ).get().count, 3);
  assert.throws(() => db.database.prepare(
    "UPDATE teacher_live_request_receipt_events SET created_at=created_at+1 WHERE request_id='tlr_request_001'"
  ).run(), /APPEND_ONLY/);
  assert.throws(() => db.database.prepare(
    "DELETE FROM teacher_live_requests WHERE request_id='tlr_request_001'"
  ).run(), /APPEND_ONLY/);
});

test('테이블 미준비와 비관리자 receipt 요청은 fail-closed 처리한다', async () => {
  const missing = new TestD1(false);
  const unavailable = await call(missing, { action: 'recipients' });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.code, 'TEACHER_LIVE_REQUEST_NOT_READY');

  const db = new TestD1(); seed(db); await call(db, request());
  assert.equal((await call(db, { action: 'opened', requestId: 'tlr_request_001' }, teacher('teacher-a'))).status, 403);
  assert.equal((await call(db, { action: 'acknowledge', requestId: 'tlr_missing_001' }, director)).status, 404);
});
