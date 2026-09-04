import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

import {
  handleScheduledTuitionAlerts, handleTuitionAlert, handleStudentAttendance, sessionCycles,
  syncStudentSessionLedgers
} from './tuition-alert.js';

const source = fs.readFileSync(new URL('./tuition-alert.js', import.meta.url), 'utf8');
const workerSource = fs.readFileSync(new URL('./worker-core.js', import.meta.url), 'utf8');
const ledgerMigration = fs.readFileSync(new URL('./migrations/063_student_session_cycles.sql', import.meta.url), 'utf8');
const CUTOFF = Date.parse('2026-08-28T14:50:00Z'); // 2026-08-28 23:50 KST

const tables = `
CREATE TABLE private_rosters(app TEXT PRIMARY KEY,data TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE tasks(app TEXT NOT NULL,id TEXT NOT NULL,owner TEXT,data TEXT NOT NULL,updated_at INTEGER NOT NULL,srv_at INTEGER NOT NULL,PRIMARY KEY(app,id));
CREATE TABLE checks(app TEXT NOT NULL,k TEXT NOT NULL,owner TEXT,data TEXT NOT NULL,updated_at INTEGER NOT NULL,srv_at INTEGER NOT NULL,PRIMARY KEY(app,k));
CREATE TABLE weekend_actual_visits(
  app TEXT NOT NULL,visit_id TEXT NOT NULL,student_id TEXT NOT NULL,lesson_task_id TEXT NOT NULL,
  visit_date TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(app,visit_id),
  UNIQUE(app,student_id,lesson_task_id,visit_date)
);
CREATE TABLE makeup_cases(
  app TEXT NOT NULL,case_id TEXT NOT NULL,student_id TEXT NOT NULL,status TEXT NOT NULL,
  confirmed_start_at TEXT,confirmed_end_at TEXT,confirmed_staff_id TEXT,
  completed_at INTEGER,completed_by TEXT,history TEXT NOT NULL,PRIMARY KEY(app,case_id)
);
CREATE TABLE tuition_generation_alerts(
  app TEXT NOT NULL CHECK(app='task'),
  alert_id TEXT NOT NULL CHECK(alert_id LIKE 'tga_%'),
  student_id TEXT NOT NULL,
  cycle_start_date TEXT NOT NULL CHECK(length(cycle_start_date)=10),
  threshold_count INTEGER NOT NULL CHECK(threshold_count=3),
  trigger_task_id TEXT NOT NULL,
  trigger_date TEXT NOT NULL CHECK(length(trigger_date)=10),
  created_at INTEGER NOT NULL CHECK(created_at>0),
  PRIMARY KEY(app,alert_id),
  UNIQUE(app,student_id,cycle_start_date)
);
CREATE TABLE tuition_generation_alert_confirmations(
  app TEXT NOT NULL CHECK(app='task'),
  confirmation_id TEXT NOT NULL CHECK(confirmation_id LIKE 'tgc_%'),
  alert_id TEXT NOT NULL,
  confirmed_at INTEGER NOT NULL CHECK(confirmed_at>0),
  confirmed_by TEXT NOT NULL,
  PRIMARY KEY(app,confirmation_id),
  UNIQUE(app,alert_id),
  FOREIGN KEY(app,alert_id) REFERENCES tuition_generation_alerts(app,alert_id)
);
CREATE TRIGGER tuition_generation_alerts_no_update BEFORE UPDATE ON tuition_generation_alerts BEGIN SELECT RAISE(ABORT,'TUITION_ALERT_APPEND_ONLY'); END;
CREATE TRIGGER tuition_generation_alerts_no_delete BEFORE DELETE ON tuition_generation_alerts BEGIN SELECT RAISE(ABORT,'TUITION_ALERT_APPEND_ONLY'); END;
CREATE TRIGGER tuition_generation_confirmations_no_update BEFORE UPDATE ON tuition_generation_alert_confirmations BEGIN SELECT RAISE(ABORT,'TUITION_CONFIRMATION_APPEND_ONLY'); END;
CREATE TRIGGER tuition_generation_confirmations_no_delete BEFORE DELETE ON tuition_generation_alert_confirmations BEGIN SELECT RAISE(ABORT,'TUITION_CONFIRMATION_APPEND_ONLY'); END;
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
  constructor(withAlertTables = true) {
    this.database = new DatabaseSync(':memory:');
    this.database.exec(withAlertTables ? tables : tables.slice(0, tables.indexOf('CREATE TABLE tuition_generation_alerts')));
    this.database.exec(ledgerMigration);
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

function rosterStudent(id, name, overrides = {}) {
  return {
    id, name, school: '테스트학교', grade: '중1', billingMode: 'session4',
    sessionCycleStartDate: '2026-08-01', ...overrides
  };
}

function seedRoster(db, students) {
  const document = { roster: { students } };
  db.database.prepare('INSERT OR REPLACE INTO private_rosters(app,data,updated_at) VALUES(?,?,?)')
    .run('task', JSON.stringify(document), CUTOFF);
}

function seedTask(db, id, studentId, owner = 'teacher-a', overrides = {}) {
  const task = {
    id, staffId: owner, studentId, taskKind: 'lesson_instruction', lessonFormVersion: 1,
    title: '[수업] 테스트', start: '2026-01-01', end: '', repeat: 'daily', days: [], ...overrides
  };
  db.database.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .run('task', id, owner, JSON.stringify(task), CUTOFF, CUTOFF);
}

function seedCheck(db, taskId, date, att, overrides = {}) {
  const check = { taskId, date, att, updatedAt: CUTOFF, ...overrides };
  const key = Object.prototype.hasOwnProperty.call(overrides, 'key') ? overrides.key : taskId + '|' + date;
  delete check.key;
  // 이 파일의 check들은 migration 이전부터 존재한 운영 근거를 재현한다. 실제 시계가
  // 고정 fixture 날짜보다 뒤여도 신규 23:50 잠금 trigger가 fixture 준비를 막지 않게 한다.
  const rosterRow = db.database.prepare("SELECT data FROM private_rosters WHERE app='task'").get();
  const originalRoster = rosterRow && String(rosterRow.data || '');
  if (originalRoster) {
    const unlocked = JSON.parse(originalRoster);
    for (const student of unlocked.roster.students || []) student.billingMode = 'monthly';
    db.database.prepare("UPDATE private_rosters SET data=? WHERE app='task'").run(JSON.stringify(unlocked));
  }
  try {
    db.database.prepare('INSERT OR REPLACE INTO checks(app,k,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
      .run('task', key, 'teacher-a', JSON.stringify(check), CUTOFF, CUTOFF);
  } finally {
    if (originalRoster) db.database.prepare("UPDATE private_rosters SET data=? WHERE app='task'").run(originalRoster);
  }
}

function seedWeekendVisit(db, taskId, studentId, date, status = 'completed', suffix = '') {
  db.database.prepare(
    'INSERT INTO weekend_actual_visits(app,visit_id,student_id,lesson_task_id,visit_date,status) VALUES(?,?,?,?,?,?)'
  ).run('task', 'visit-' + taskId + '-' + date + suffix, studentId, taskId, date, status);
}

function response(body, status = 200) { return { body, status }; }

async function api(db, body, auth = { scope: 'all' }) {
  return await handleTuitionAlert({ DB: db }, 'task', { app: 'task', auth: {}, ...body }, '', auth, response);
}

async function attendanceApi(db, body, auth = { scope: 'all' }) {
  const original = Date.now;
  Date.now = () => CUTOFF;
  try {
    return await handleStudentAttendance(
      { DB: db }, 'task', { app: 'task', auth: {}, ...body }, '', auth, response
    );
  } finally {
    Date.now = original;
  }
}

test('23:50 aggregation counts only final P/L/E across subjects and creates the third-attendance alert once', async () => {
  const db = new TestD1();
  seedRoster(db, [rosterStudent('student-a', '김학생')]);
  seedTask(db, 'lesson-math', 'student-a');
  seedTask(db, 'lesson-english', 'student-a');
  seedCheck(db, 'lesson-math', '2026-07-31', 'P'); // cycle start 이전
  seedCheck(db, 'lesson-math', '2026-08-03', 'P');
  seedCheck(db, 'lesson-math', '2026-08-10', 'A'); // 결석 제외
  seedCheck(db, 'lesson-english', '2026-08-17', 'L');
  seedCheck(db, 'lesson-math', '2026-08-24', 'E');
  seedCheck(db, 'lesson-math', '2026-08-29', 'P'); // cutoff 이후 제외
  seedCheck(db, 'lesson-math', '2026-08-25', 'P', { key: 'wrong-key' }); // exact task/date 불일치

  const first = await handleScheduledTuitionAlerts({ DB: db }, CUTOFF);
  assert.equal(first.ok, true);
  assert.equal(first.eligibleStudents, 1);
  assert.equal(first.qualifyingAttendances, 3);
  assert.equal(first.created, 1);
  const row = db.database.prepare('SELECT * FROM tuition_generation_alerts').get();
  assert.equal(row.student_id, 'student-a');
  assert.equal(row.cycle_start_date, '2026-08-01');
  assert.equal(row.threshold_count, 3);
  assert.equal(row.trigger_task_id, 'lesson-math');
  assert.equal(row.trigger_date, '2026-08-24');

  const again = await handleScheduledTuitionAlerts({ DB: db }, CUTOFF);
  assert.equal(again.created, 0);
  assert.equal(again.idempotent, 1);
  assert.equal(db.database.prepare('SELECT COUNT(*) count FROM tuition_generation_alerts').get().count, 1);
});

test('same-name students stay separate by stable id and one task/date is counted at most once', async () => {
  const db = new TestD1();
  seedRoster(db, [
    rosterStudent('student-a', '김예린', { school: '가초', grade: '초3' }),
    rosterStudent('student-b', '김예린', { school: '나초', grade: '초5' }),
    rosterStudent('student-monthly', '월결제', { billingMode: 'monthly', sessionCycleStartDate: '' })
  ]);
  for (const studentId of ['student-a', 'student-b', 'student-monthly']) seedTask(db, 'lesson-' + studentId, studentId);
  for (const date of ['2026-08-01', '2026-08-08', '2026-08-15']) seedCheck(db, 'lesson-student-a', date, 'P');
  for (const date of ['2026-08-02', '2026-08-09']) seedCheck(db, 'lesson-student-b', date, 'P');
  for (const date of ['2026-08-03', '2026-08-10', '2026-08-17']) seedCheck(db, 'lesson-student-monthly', date, 'P');

  const result = await handleScheduledTuitionAlerts({ DB: db }, CUTOFF);
  assert.equal(result.eligibleStudents, 2);
  assert.equal(result.created, 1);
  const alerts = db.database.prepare('SELECT student_id FROM tuition_generation_alerts').all();
  assert.deepEqual(alerts.map(row => row.student_id), ['student-a']);
});

test('attendance checks on projected makeup tasks do not create tuition alerts', async () => {
  const db = new TestD1();
  seedRoster(db, [rosterStudent('student-a', '보강학생')]);
  seedTask(db, 'makeup_lesson_mu_tuition', 'student-a', 'teacher-a', {
    lessonInstanceType: 'makeup', makeupCaseId: 'mu_tuition',
    repeat: 'once', start: '2026-08-03', end: '2026-08-03'
  });
  for (const date of ['2026-08-03', '2026-08-10', '2026-08-17']) {
    seedCheck(db, 'makeup_lesson_mu_tuition', date, 'P');
  }
  const result = await handleScheduledTuitionAlerts({ DB: db }, CUTOFF);
  assert.equal(result.qualifyingAttendances, 0);
  assert.equal(result.created, 0);
});

test('weekend tuition counts require recurrence or an exact non-cancelled actual visit', async () => {
  for (const status of ['cancelled', 'completed']) {
    const db = new TestD1();
    seedRoster(db, [rosterStudent('student-fixed', '고정주말')]);
    seedTask(db, 'lesson-fixed', 'student-fixed', 'teacher-a', {
      repeat: 'days', days: [6], weekendAttendanceMode: 'fixed'
    });
    for (const date of ['2026-08-01', '2026-08-08']) seedCheck(db, 'lesson-fixed', date, 'P');
    seedCheck(db, 'lesson-fixed', '2026-08-09', 'P');
    seedWeekendVisit(db, 'lesson-fixed', 'student-fixed', '2026-08-09', status);
    const result = await handleScheduledTuitionAlerts({ DB: db }, CUTOFF);
    assert.equal(result.qualifyingAttendances, status === 'completed' ? 3 : 2);
    assert.equal(result.created, status === 'completed' ? 1 : 0);
  }

  const flexibleDb = new TestD1();
  seedRoster(flexibleDb, [rosterStudent('student-flex', '비정기주말')]);
  seedTask(flexibleDb, 'lesson-flex', 'student-flex', 'teacher-a', {
    repeat: 'days', days: [6], weekendAttendanceMode: 'flexible', weekendAllowedDays: [0],
    weekendMonthlyTarget: 2, weekendFlexibleFrom: '2026-08-01'
  });
  for (const date of ['2026-08-02', '2026-08-09', '2026-08-16']) {
    seedCheck(flexibleDb, 'lesson-flex', date, 'P');
  }
  const withoutVisits = await handleScheduledTuitionAlerts({ DB: flexibleDb }, CUTOFF);
  assert.equal(withoutVisits.qualifyingAttendances, 0);
  assert.equal(withoutVisits.created, 0);
  for (const date of ['2026-08-02', '2026-08-09', '2026-08-16']) {
    seedWeekendVisit(flexibleDb, 'lesson-flex', 'student-flex', date);
  }
  const withVisits = await handleScheduledTuitionAlerts({ DB: flexibleDb }, CUTOFF);
  assert.equal(withVisits.qualifyingAttendances, 3);
  assert.equal(withVisits.created, 1);
});

test('inactive roster rows and owner-mismatched lesson checks fail closed', async () => {
  const db = new TestD1();
  seedRoster(db, [
    rosterStudent('student-forged', '위조연결'),
    rosterStudent('student-ended', '종료학생', { end: '2026-08' }),
    rosterStudent('student-future', '예정학생', { start: '2026-09' })
  ]);
  seedTask(db, 'lesson-forged', 'student-forged', 'teacher-b', { staffId: 'teacher-a' });
  seedTask(db, 'lesson-ended', 'student-ended');
  seedTask(db, 'lesson-future', 'student-future');
  for (const date of ['2026-08-01', '2026-08-08', '2026-08-15']) {
    seedCheck(db, 'lesson-forged', date, 'P');
    seedCheck(db, 'lesson-ended', date, 'P');
    seedCheck(db, 'lesson-future', date, 'P');
  }
  const result = await handleScheduledTuitionAlerts({ DB: db }, CUTOFF);
  assert.equal(result.eligibleStudents, 1);
  assert.equal(result.qualifyingAttendances, 0);
  assert.equal(result.created, 0);
});

test('changing the session cycle start creates a new alert while preserving the prior cycle', async () => {
  const db = new TestD1();
  seedRoster(db, [rosterStudent('student-a', '회차학생')]);
  seedTask(db, 'lesson-a', 'student-a');
  for (const date of ['2026-08-01', '2026-08-08', '2026-08-15', '2026-08-22']) seedCheck(db, 'lesson-a', date, 'P');
  assert.equal((await handleScheduledTuitionAlerts({ DB: db }, CUTOFF)).created, 1);

  seedRoster(db, [rosterStudent('student-a', '회차학생', { sessionCycleStartDate: '2026-08-08' })]);
  assert.equal((await handleScheduledTuitionAlerts({ DB: db }, CUTOFF)).created, 1);
  const starts = db.database.prepare('SELECT cycle_start_date FROM tuition_generation_alerts ORDER BY cycle_start_date').all();
  assert.deepEqual(starts.map(row => row.cycle_start_date), ['2026-08-01', '2026-08-08']);
});

test('four-session cycles keep 4/4 until the next attendance and alert again on each third session', async () => {
  const db = new TestD1();
  seedRoster(db, [rosterStudent('student-a', '회차학생')]);
  seedTask(db, 'lesson-a', 'student-a');
  const firstFour = ['2026-08-01', '2026-08-05', '2026-08-09', '2026-08-13'];
  for (const date of firstFour) seedCheck(db, 'lesson-a', date, 'P');

  let cycles = sessionCycles(firstFour.map(date => ({
    studentId: 'student-a', taskId: 'lesson-a', date, status: 'P'
  })), '2026-08-01');
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].cycleStartDate, '2026-08-01');
  assert.equal(cycles[0].attendance.length, 4);

  let result = await handleScheduledTuitionAlerts({ DB: db }, CUTOFF);
  assert.equal(result.created, 1);
  for (const date of ['2026-08-17', '2026-08-21', '2026-08-25']) seedCheck(db, 'lesson-a', date, 'P');
  result = await handleScheduledTuitionAlerts({ DB: db }, CUTOFF);
  assert.equal(result.created, 1);
  assert.equal(result.idempotent, 1);
  const alerts = db.database.prepare(
    'SELECT cycle_start_date,trigger_date FROM tuition_generation_alerts ORDER BY cycle_start_date'
  ).all();
  assert.deepEqual(alerts.map(row => ({ ...row })), [
    { cycle_start_date: '2026-08-01', trigger_date: '2026-08-09' },
    { cycle_start_date: '2026-08-17', trigger_date: '2026-08-25' }
  ]);
});

test('student attendance returns safe monthly records and current cycle only to admin or assigned teacher', async () => {
  const db = new TestD1();
  seedRoster(db, [rosterStudent('student-a', '비공개학생', { phoneMother: '010-0000-0000' })]);
  seedTask(db, 'lesson-a', 'student-a', 'teacher-a');
  seedTask(db, 'lesson-other', 'student-other', 'teacher-b');
  for (const [date, status] of [
    ['2026-08-01', 'P'], ['2026-08-05', 'L'], ['2026-08-09', 'A'],
    ['2026-08-13', 'E'], ['2026-08-17', 'P'], ['2026-08-21', 'P']
  ]) seedCheck(db, 'lesson-a', date, status);
  assert.equal((await attendanceApi(db, { action: 'backfill' })).status, 200);

  const admin = await attendanceApi(db, { studentId: 'student-a', month: '2026-08' });
  assert.equal(admin.status, 200);
  assert.deepEqual({
    start: admin.body.cycleStartDate, count: admin.body.attendanceCount,
    size: admin.body.cycleSize, complete: admin.body.cycleComplete
  }, { start: '2026-08-21', count: 1, size: 4, complete: false });
  assert.deepEqual(admin.body.attendance.map(item => item.status), ['P', 'L', 'A', 'E', 'P', 'P']);
  assert.deepEqual(Object.keys(admin.body.attendance[0]).sort(), ['date', 'status', 'taskId']);
  assert.equal(JSON.stringify(admin.body).includes('비공개학생'), false);
  assert.equal(JSON.stringify(admin.body).includes('010-0000-0000'), false);

  const teacher = await attendanceApi(db, { studentId: 'student-a', month: '2026-08' },
    { scope: 'own', id: 'teacher-a' });
  assert.equal(teacher.status, 200);
  const denied = await attendanceApi(db, { studentId: 'student-a', month: '2026-08' },
    { scope: 'own', id: 'teacher-b' });
  assert.equal(denied.status, 403);
  const extra = await attendanceApi(db, { studentId: 'student-a', month: '2026-08', phone: 'x' });
  assert.equal(extra.status, 400);
});

test('student attendance holds a completed cycle at 4/4 until session five starts the next cycle', async () => {
  const db = new TestD1();
  seedRoster(db, [rosterStudent('student-a', '회차학생')]);
  seedTask(db, 'lesson-a', 'student-a');
  for (const date of ['2026-08-01', '2026-08-05', '2026-08-09', '2026-08-13']) {
    seedCheck(db, 'lesson-a', date, 'P');
  }
  assert.equal((await attendanceApi(db, { action: 'backfill' })).status, 200);
  let summary = await attendanceApi(db, { studentId: 'student-a', month: '2026-08' });
  assert.equal(summary.body.cycleStartDate, '2026-08-01');
  assert.equal(summary.body.attendanceCount, 4);
  assert.equal(summary.body.cycleComplete, true);

  seedCheck(db, 'lesson-a', '2026-08-17', 'P');
  assert.equal((await attendanceApi(db, { action: 'backfill' })).status, 200);
  summary = await attendanceApi(db, { studentId: 'student-a', month: '2026-08' });
  assert.equal(summary.body.cycleStartDate, '2026-08-17');
  assert.equal(summary.body.attendanceCount, 1);
  assert.equal(summary.body.cycleComplete, false);
});

test('ledger finalizes today only at 23:50 KST and read actions never finalize attendance', async () => {
  const db = new TestD1();
  seedRoster(db, [rosterStudent('student-a', '회차학생')]);
  seedTask(db, 'lesson-a', 'student-a');
  seedCheck(db, 'lesson-a', '2026-08-28', 'P');

  const before = await syncStudentSessionLedgers({ DB: db }, Date.parse('2026-08-28T14:49:00Z'));
  assert.equal(before.sourceDate, '2026-08-27');
  assert.equal(before.createdEvents, 0);
  const readOnly = await attendanceApi(db, { action: 'get', studentId: 'student-a', month: '2026-08' });
  assert.equal(readOnly.body.attendanceCount, 0);
  assert.equal(db.database.prepare('SELECT COUNT(*) count FROM student_session_attendance_events').get().count, 0);

  const finalized = await syncStudentSessionLedgers({ DB: db }, Date.parse('2026-08-28T14:50:00Z'));
  assert.equal(finalized.sourceDate, '2026-08-28');
  assert.equal(finalized.createdEvents, 1);
});

test('session ledger list is one scoped query contract and excludes monthly students', async () => {
  const db = new TestD1();
  seedRoster(db, [
    rosterStudent('student-a', '가학생'),
    rosterStudent('student-b', '나학생', { sessionCycleStartDate: '2026-08-02' }),
    rosterStudent('student-monthly', '월제학생', { billingMode: 'monthly', sessionCycleStartDate: '' })
  ]);
  seedTask(db, 'lesson-a', 'student-a', 'teacher-a');
  seedTask(db, 'lesson-b', 'student-b', 'teacher-b');
  seedTask(db, 'lesson-monthly', 'student-monthly', 'teacher-a');
  seedCheck(db, 'lesson-a', '2026-08-03', 'P');
  await attendanceApi(db, { action: 'backfill' });

  const admin = await attendanceApi(db, { action: 'list' });
  assert.equal(admin.status, 200);
  assert.deepEqual(admin.body.students.map(item => item.studentId).sort(), ['student-a', 'student-b']);
  assert.equal(admin.body.students[0].cycles.length, 1);
  assert.deepEqual(Object.keys(admin.body.students[0].cycles[0]).sort(),
    ['attendanceCount', 'completedAt', 'cycleNo', 'cycleStartDate', 'entries', 'status']);
  const teacherA = await attendanceApi(db, { action: 'list' }, { scope: 'own', id: 'teacher-a' });
  assert.deepEqual(teacherA.body.students.map(item => item.studentId), ['student-a']);
  const teacherB = await attendanceApi(db, { action: 'list' }, { scope: 'own', id: 'teacher-b' });
  assert.deepEqual(teacherB.body.students.map(item => item.studentId), ['student-b']);
});

test('scheduleSlots valid ranges are authoritative over stale repeat days for historical attendance', async () => {
  const db = new TestD1();
  seedRoster(db, [rosterStudent('student-a', '시간표변경학생')]);
  seedTask(db, 'lesson-a', 'student-a', 'teacher-a', {
    repeat: 'days', days: [1], scheduleSlots: [
      { days: [1], startTime: '18:00', endTime: '19:00', validTo: '2026-08-10' },
      { days: [2], startTime: '18:00', endTime: '19:00', validFrom: '2026-08-11' }
    ]
  });
  seedCheck(db, 'lesson-a', '2026-08-03', 'P'); // 이전 월요일 슬롯
  seedCheck(db, 'lesson-a', '2026-08-18', 'P'); // 변경 뒤 화요일 슬롯
  seedCheck(db, 'lesson-a', '2026-08-17', 'P'); // stale repeat 월요일 — 제외
  const synced = await syncStudentSessionLedgers({ DB: db }, CUTOFF);
  assert.equal(synced.createdEvents, 2);
  const events = db.database.prepare(
    'SELECT attendance_date FROM student_session_attendance_events ORDER BY attendance_date'
  ).all();
  assert.deepEqual(events.map(row => row.attendance_date), ['2026-08-03', '2026-08-18']);
});

test('deleted lessons retain checks through their effective end for admin backfill but do not extend teacher scope', async () => {
  const db = new TestD1();
  seedRoster(db, [rosterStudent('student-a', '종료학생', { end: '2026-08' })]);
  seedTask(db, 'lesson-ended', 'student-a', 'teacher-a', {
    deleted: true, end: '2026-08-17', repeat: 'daily'
  });
  seedCheck(db, 'lesson-ended', '2026-08-17', 'P');
  seedCheck(db, 'lesson-ended', '2026-08-18', 'P');

  const synced = await syncStudentSessionLedgers({ DB: db }, CUTOFF);
  assert.equal(synced.createdEvents, 1);
  assert.deepEqual(db.database.prepare(
    'SELECT attendance_date FROM student_session_attendance_events ORDER BY attendance_date'
  ).all().map(row => row.attendance_date), ['2026-08-17']);

  const adminView = await attendanceApi(db, {
    action: 'get', studentId: 'student-a', month: '2026-08'
  });
  assert.equal(adminView.status, 200);
  assert.deepEqual(adminView.body.attendance, [
    { date: '2026-08-17', status: 'P', taskId: 'lesson-ended' }
  ]);
  const oldTeacher = await attendanceApi(db, {
    action: 'get', studentId: 'student-a', month: '2026-08'
  }, { scope: 'own', id: 'teacher-a' });
  assert.equal(oldTeacher.status, 403);
});

test('completed absence makeup counts once while exam/other makeup stays out of the session ledger', async () => {
  const db = new TestD1();
  seedRoster(db, [rosterStudent('student-a', '보강학생')]);
  for (const [suffix, date, first] of [
    ['absence', '2026-08-10', { action: 'create_manual', reason: 'manual_absence' }],
    ['exam', '2026-08-11', { action: 'create_manual', reason: 'manual_exam' }]
  ]) {
    const caseId = 'mu_' + suffix;
    const taskId = 'makeup_lesson_' + caseId;
    db.database.prepare('INSERT INTO makeup_cases(app,case_id,student_id,status,history) VALUES(?,?,?,?,?)')
      .run('task', caseId, 'student-a', 'completed', JSON.stringify([first]));
    seedTask(db, taskId, 'student-a', 'teacher-a', {
      lessonInstanceType: 'makeup', makeupCaseId: caseId, repeat: 'once', start: date, end: date
    });
    seedCheck(db, taskId, date, 'P');
  }
  const synced = await syncStudentSessionLedgers({ DB: db }, CUTOFF);
  assert.equal(synced.createdEvents, 1);
  const event = db.database.prepare('SELECT lesson_task_id FROM student_session_attendance_events').get();
  assert.equal(event.lesson_task_id, 'makeup_lesson_mu_absence');

  assert.throws(() => db.database.prepare(
    "INSERT INTO student_session_attendance_events " +
    "(app,student_id,configured_start_date,cycle_number,session_number,lesson_task_id," +
    "attendance_date,attendance_status,check_key,created_at) VALUES('task',?,?,?,?,?,?,?,?,?)"
  ).run('student-a', '2026-08-01', 1, 2, 'makeup_lesson_mu_exam', '2026-08-11', 'P',
    'makeup_lesson_mu_exam|2026-08-11', CUTOFF), /STUDENT_SESSION_ATTENDANCE_SOURCE/);

  seedCheck(db, 'makeup_lesson_mu_absence', '2026-08-12', 'P');
  assert.throws(() => db.database.prepare(
    "INSERT INTO student_session_attendance_events " +
    "(app,student_id,configured_start_date,cycle_number,session_number,lesson_task_id," +
    "attendance_date,attendance_status,check_key,created_at) VALUES('task',?,?,?,?,?,?,?,?,?)"
  ).run('student-a', '2026-08-01', 1, 2, 'makeup_lesson_mu_absence', '2026-08-12', 'P',
    'makeup_lesson_mu_absence|2026-08-12', CUTOFF), /STUDENT_SESSION_ATTENDANCE_SOURCE/);
});

test('confirmed absence makeup is finalized on its attendance date before a delayed complete action', async () => {
  const db = new TestD1();
  seedRoster(db, [rosterStudent('student-a', '지연완료')]);
  db.database.prepare('INSERT INTO makeup_cases(app,case_id,student_id,status,history) VALUES(?,?,?,?,?)')
    .run('task', 'mu_delayed', 'student-a', 'confirmed', JSON.stringify([
      { action: 'create_manual', reason: 'manual_absence' }
    ]));
  seedTask(db, 'makeup_lesson_mu_delayed', 'student-a', 'teacher-a', {
    lessonInstanceType: 'makeup', makeupCaseId: 'mu_delayed', repeat: 'once',
    start: '2026-08-10', end: '2026-08-10'
  });
  seedTask(db, 'lesson-next', 'student-a');
  seedCheck(db, 'makeup_lesson_mu_delayed', '2026-08-10', 'P');
  seedCheck(db, 'lesson-next', '2026-08-11', 'P');
  for (const [status, date] of [['review_pending', '2026-08-12'], ['cancelled', '2026-08-13']]) {
    const caseId = 'mu_' + status;
    db.database.prepare('INSERT INTO makeup_cases(app,case_id,student_id,status,history) VALUES(?,?,?,?,?)')
      .run('task', caseId, 'student-a', status, JSON.stringify([{ action: 'create_from_absence' }]));
    seedTask(db, 'makeup_lesson_' + caseId, 'student-a', 'teacher-a', {
      lessonInstanceType: 'makeup', makeupCaseId: caseId, repeat: 'once', start: date, end: date,
      deleted: status === 'cancelled'
    });
    seedCheck(db, 'makeup_lesson_' + caseId, date, 'P');
  }

  const first = await syncStudentSessionLedgers({ DB: db }, CUTOFF);
  assert.equal(first.createdEvents, 2);
  assert.deepEqual(db.database.prepare(
    'SELECT lesson_task_id,attendance_date FROM student_session_attendance_events ORDER BY session_number'
  ).all().map(row => ({ lesson_task_id: row.lesson_task_id, attendance_date: row.attendance_date })), [
    { lesson_task_id: 'makeup_lesson_mu_delayed', attendance_date: '2026-08-10' },
    { lesson_task_id: 'lesson-next', attendance_date: '2026-08-11' }
  ]);
  const beforeComplete = await attendanceApi(db, {
    action: 'get', studentId: 'student-a', month: '2026-08'
  });
  assert.deepEqual(beforeComplete.body.attendance, [
    { date: '2026-08-10', status: 'P', taskId: 'makeup_lesson_mu_delayed' },
    { date: '2026-08-11', status: 'P', taskId: 'lesson-next' }
  ]);

  db.database.prepare("UPDATE makeup_cases SET status='completed' WHERE case_id='mu_delayed'").run();
  const completedLater = await syncStudentSessionLedgers({ DB: db }, CUTOFF);
  assert.equal(completedLater.createdEvents, 0);
  assert.equal(db.database.prepare('SELECT COUNT(*) count FROM student_session_attendance_events').get().count, 2);
});

test('database guards reject monthly ledgers and keep cycle/event history append-only', async () => {
  const monthly = new TestD1();
  seedRoster(monthly, [rosterStudent('student-monthly', '월제', {
    billingMode: 'monthly', sessionCycleStartDate: ''
  })]);
  assert.throws(() => monthly.database.prepare(
    "INSERT INTO student_session_cycles(app,student_id,configured_start_date,cycle_number,cycle_start_date,created_at) " +
    "VALUES('task',?,?,1,?,?)"
  ).run('student-monthly', '2026-08-01', '2026-08-01', CUTOFF), /STUDENT_SESSION_NOT_ELIGIBLE/);

  const db = new TestD1();
  seedRoster(db, [rosterStudent('student-a', '회차')]);
  seedTask(db, 'lesson-a', 'student-a');
  seedCheck(db, 'lesson-a', '2026-08-03', 'P');
  await syncStudentSessionLedgers({ DB: db }, CUTOFF);
  assert.throws(() => db.database.prepare(
    'UPDATE student_session_cycles SET cycle_start_date=?'
  ).run('2026-08-02'), /STUDENT_SESSION_CYCLE_APPEND_ONLY/);
  assert.throws(() => db.database.prepare(
    'DELETE FROM student_session_attendance_events'
  ).run(), /STUDENT_SESSION_EVENT_APPEND_ONLY/);
});

test('063 migration generically backfills only current session4 roster rows at 0/4 without PII', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(tables);
  database.prepare('INSERT INTO private_rosters(app,data,updated_at) VALUES(?,?,?)').run('task', JSON.stringify({
    roster: { students: [
      rosterStudent('student-a', '이름A', { phoneMother: 'private-a' }),
      rosterStudent('student-b', '이름B', { phoneFather: 'private-b', sessionCycleStartDate: '2026-08-02' }),
      rosterStudent('student-monthly', '이름C', { billingMode: 'monthly', sessionCycleStartDate: '' })
    ] }
  }), CUTOFF);
  database.exec(ledgerMigration);
  const cycles = database.prepare(
    'SELECT student_id,configured_start_date,cycle_number FROM student_session_cycles ORDER BY student_id'
  ).all().map(row => ({ ...row }));
  assert.deepEqual(cycles, [
    { student_id: 'student-a', configured_start_date: '2026-08-01', cycle_number: 1 },
    { student_id: 'student-b', configured_start_date: '2026-08-02', cycle_number: 1 }
  ]);
  assert.equal(database.prepare('SELECT COUNT(*) count FROM student_session_attendance_events').get().count, 0);
  const columns = database.prepare('PRAGMA table_info(student_session_cycles)').all().map(row => row.name);
  assert.equal(columns.some(name => /name|phone|contact/i.test(name)), false);
});

test('admin list derives identity at read time and global confirmation is a single append-only row', async () => {
  const db = new TestD1();
  seedRoster(db, [rosterStudent('student-a', '표시이름', { school: '표시학교', grade: '중2', phoneMother: '010-0000-0000' })]);
  seedTask(db, 'lesson-a', 'student-a');
  for (const date of ['2026-08-01', '2026-08-08', '2026-08-15']) seedCheck(db, 'lesson-a', date, 'P');
  await handleScheduledTuitionAlerts({ DB: db }, CUTOFF);
  // 결제 방식을 나중에 월결제로 바꿔도 기존 알림의 표시는 현재 roster에서 stable id로 파생한다.
  seedRoster(db, [rosterStudent('student-a', '표시이름', {
    school: '표시학교', grade: '중2', phoneMother: '010-0000-0000',
    billingMode: 'monthly', sessionCycleStartDate: ''
  })]);

  const denied = await api(db, { action: 'list' }, { scope: 'own', id: 'teacher-a' });
  assert.equal(denied.status, 403);
  const listed = await api(db, { action: 'list' });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.alerts.length, 1);
  assert.deepEqual({
    id: listed.body.alerts[0].studentId, name: listed.body.alerts[0].studentName,
    school: listed.body.alerts[0].school, grade: listed.body.alerts[0].grade,
    message: listed.body.alerts[0].message
  }, { id: 'student-a', name: '표시이름', school: '표시학교', grade: '중2', message: '수강료 생성필요' });
  assert.equal(JSON.stringify(listed.body).includes('010-0000-0000'), false);
  const storedAlert = db.database.prepare('SELECT * FROM tuition_generation_alerts').get();
  assert.equal(Object.keys(storedAlert).some(key => /name|phone|contact/i.test(key)), false);

  const confirmed = await api(db, { action: 'confirm', alertId: listed.body.alerts[0].alertId },
    { scope: 'all', role: 'manager', id: 'manager-a' });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.idempotent, false);
  const repeated = await api(db, { action: 'confirm', alertId: listed.body.alerts[0].alertId }, { scope: 'all' });
  assert.equal(repeated.body.idempotent, true);
  assert.equal(db.database.prepare('SELECT COUNT(*) count FROM tuition_generation_alert_confirmations').get().count, 1);
  assert.equal((await api(db, { action: 'list' })).body.alerts.length, 0);
  const history = await api(db, { action: 'list', includeConfirmed: true });
  assert.equal(history.body.alerts[0].status, 'confirmed');
  assert.ok(history.body.alerts[0].confirmedAt > 0);
  assert.throws(() => db.database.prepare('UPDATE tuition_generation_alert_confirmations SET confirmed_at=1').run(), /APPEND_ONLY/);
  assert.throws(() => db.database.prepare('DELETE FROM tuition_generation_alerts').run(), /APPEND_ONLY/);
});

test('handler rejects extra fields and missing ledger fails closed without exposing roster values', async () => {
  const db = new TestD1();
  seedRoster(db, [rosterStudent('student-a', '비공개학생')]);
  const extra = await api(db, { action: 'list', phone: '01000000000' });
  assert.equal(extra.status, 400);

  const missing = new TestD1(false);
  seedRoster(missing, [rosterStudent('student-a', '비공개학생')]);
  const listed = await api(missing, { action: 'list' });
  assert.equal(listed.status, 503);
  assert.equal(listed.body.code, 'TUITION_ALERT_LEDGER_NOT_READY');
  assert.equal(JSON.stringify(listed.body).includes('비공개학생'), false);
});

test('source contract never writes names or contacts and exports separate Cron and HTTP entry points', () => {
  const insert = source.slice(source.indexOf('INSERT OR IGNORE INTO tuition_generation_alerts'),
    source.indexOf('function alertView'));
  assert.doesNotMatch(insert, /student_name|school|grade|phone|contact/i);
  assert.match(source, /export async function handleScheduledTuitionAlerts/);
  assert.match(source, /export async function handleTuitionAlert/);
  assert.match(source, /export async function handleStudentAttendance/);
  assert.match(source, /export async function syncStudentSessionLedgers/);
  assert.match(workerSource, /url\.pathname === '\/student-attendance'/);
  assert.match(source, /QUALIFYING_ATTENDANCE = new Set\(\['P', 'L', 'E'\]\)/);
  assert.doesNotMatch(source.match(/const QUALIFYING_ATTENDANCE[^;]+;/)[0], /'A'/);
});
