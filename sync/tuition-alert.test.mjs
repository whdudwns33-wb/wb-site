import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

import {
  handleScheduledTuitionAlerts, handleTuitionAlert, handleStudentAttendance, sessionCycles,
  syncStudentSessionLedgers, reconcileStudentSessionLedger
} from './tuition-alert.js';

const source = fs.readFileSync(new URL('./tuition-alert.js', import.meta.url), 'utf8');
const workerSource = fs.readFileSync(new URL('./worker-core.js', import.meta.url), 'utf8');
const ledgerMigration = fs.readFileSync(new URL('./migrations/063_student_session_cycles.sql', import.meta.url), 'utf8');
const generationMigration = fs.readFileSync(
  new URL('./migrations/064_student_session_ledger_generations.sql', import.meta.url), 'utf8'
);
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
  completed_at INTEGER,completed_by TEXT,revision INTEGER NOT NULL DEFAULT 1,
  history TEXT NOT NULL,PRIMARY KEY(app,case_id)
);
CREATE TABLE makeup_direct_completion_attestations(
  app TEXT NOT NULL,case_id TEXT NOT NULL,case_revision INTEGER NOT NULL,
  lesson_task_id TEXT NOT NULL,check_key TEXT NOT NULL,student_id TEXT NOT NULL,
  staff_id TEXT NOT NULL,attendance_date TEXT NOT NULL,start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,attendance_status TEXT NOT NULL,actor_id TEXT NOT NULL,
  provenance TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(app,case_id),UNIQUE(app,check_key)
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
  constructor(database, sql, beforeExecute) {
    this.database = database; this.sql = sql; this.beforeExecute = beforeExecute; this.args = [];
  }
  bind(...args) { this.args = args; return this; }
  before() { if (this.beforeExecute) this.beforeExecute(this.sql, this.args); }
  first() { this.before(); return this.database.prepare(this.sql).get(...this.args) || null; }
  all() { this.before(); return { results: this.database.prepare(this.sql).all(...this.args) }; }
  run() {
    this.before();
    const result = this.database.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(result.changes || 0) } };
  }
}

class TestD1 {
  constructor(withAlertTables = true, withGenerationTables = false) {
    this.database = new DatabaseSync(':memory:');
    this.database.exec(withAlertTables ? tables : tables.slice(0, tables.indexOf('CREATE TABLE tuition_generation_alerts')));
    this.database.exec(ledgerMigration);
    if (withGenerationTables) this.database.exec(generationMigration);
  }
  prepare(sql) {
    return new Statement(this.database, sql, (statementSql, args) => {
      if (this.beforeExecute) this.beforeExecute(statementSql, args);
    });
  }
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

function seedDirectCompletedMakeup(db, caseId, date, reason = 'manual_absence') {
  const taskId = 'makeup_lesson_' + caseId;
  db.database.prepare(
    'INSERT INTO makeup_cases(app,case_id,student_id,status,confirmed_start_at,confirmed_end_at,' +
      'confirmed_staff_id,completed_at,completed_by,revision,history) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
  ).run('task', caseId, 'student-a', 'completed', date + 'T18:00:00+09:00',
    date + 'T19:00:00+09:00', 'teacher-a', CUTOFF, 'teacher-a', 3,
    JSON.stringify([{ action: 'create_manual', reason }, { action: 'schedule_for_completion' },
      { action: 'complete' }]));
  seedTask(db, taskId, 'student-a', 'teacher-a', {
    lessonInstanceType: 'makeup', makeupCaseId: caseId, repeat: 'once', start: date, end: date
  });
  db.database.prepare(
    'INSERT INTO makeup_direct_completion_attestations(app,case_id,case_revision,lesson_task_id,' +
      'check_key,student_id,staff_id,attendance_date,start_time,end_time,attendance_status,' +
      'actor_id,provenance,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run('task', caseId, 2, taskId, taskId + '|' + date, 'student-a', 'teacher-a', date,
    '18:00', '19:00', 'P', 'director', 'makeup_direct_completion_v1', CUTOFF);
  seedCheck(db, taskId, date, 'P', { source: 'makeup_direct_completion_v1' });
}

function response(body, status = 200) { return { body, status }; }

async function api(db, body, auth = { scope: 'all' }) {
  return await handleTuitionAlert({ DB: db }, 'task', { app: 'task', auth: {}, ...body }, '', auth, response);
}

async function attendanceApi(db, body, auth = { scope: 'all' }, now = CUTOFF) {
  const original = Date.now;
  Date.now = () => now;
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
    db.database.prepare(
      'INSERT INTO makeup_cases(app,case_id,student_id,status,confirmed_staff_id,history) VALUES(?,?,?,?,?,?)'
    ).run('task', caseId, 'student-a', 'completed', 'teacher-a', JSON.stringify([first]));
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

test('makeup assignee mismatch stays visible in the calendar but is diagnosed and skipped by the ledger', async () => {
  const db = new TestD1(true, true);
  seedRoster(db, [rosterStudent('student-a', '담당불일치')]);
  db.database.prepare(
    'INSERT INTO makeup_cases(app,case_id,student_id,status,confirmed_staff_id,history) VALUES(?,?,?,?,?,?)'
  ).run('task', 'mu_mismatch', 'student-a', 'completed', 'teacher-b', JSON.stringify([
    { action: 'create_manual', reason: 'manual_absence' }
  ]));
  seedTask(db, 'makeup_lesson_mu_mismatch', 'student-a', 'teacher-a', {
    lessonInstanceType: 'makeup', makeupCaseId: 'mu_mismatch', repeat: 'once',
    start: '2026-08-10', end: '2026-08-10'
  });
  seedCheck(db, 'makeup_lesson_mu_mismatch', '2026-08-10', 'P');

  const synced = await syncStudentSessionLedgers({ DB: db }, CUTOFF);
  assert.equal(synced.ok, true);
  assert.equal(synced.createdEvents, 0);
  assert.equal(synced.makeupAssigneeMismatches, 1);
  assert.equal(db.database.prepare('SELECT COUNT(*) count FROM student_session_ledger_events').get().count, 0);

  const calendar = await attendanceApi(db, {
    studentId: 'student-a', month: '2026-08'
  });
  assert.deepEqual(calendar.body.attendance, [
    { date: '2026-08-10', status: 'P', taskId: 'makeup_lesson_mu_mismatch' }
  ]);
  assert.equal(calendar.body.attendanceCount, 0);
});

test('confirmed absence makeup is finalized on its attendance date before a delayed complete action', async () => {
  const db = new TestD1();
  seedRoster(db, [rosterStudent('student-a', '지연완료')]);
  db.database.prepare(
    'INSERT INTO makeup_cases(app,case_id,student_id,status,confirmed_staff_id,history) VALUES(?,?,?,?,?,?)'
  ).run('task', 'mu_delayed', 'student-a', 'confirmed', 'teacher-a', JSON.stringify([
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

test('generation ledger is preferred after migration and starts cycle two only on attendance five', async () => {
  const db = new TestD1(true, true);
  seedRoster(db, [rosterStudent('student-a', '회차학생')]);
  seedTask(db, 'lesson-a', 'student-a');
  for (const date of ['2026-08-01', '2026-08-05', '2026-08-09', '2026-08-13']) {
    seedCheck(db, 'lesson-a', date, 'P');
  }

  const first = await syncStudentSessionLedgers({ DB: db }, CUTOFF);
  assert.equal(first.createdEvents, 4);
  assert.equal(db.database.prepare('SELECT COUNT(*) count FROM student_session_attendance_events').get().count, 0);
  assert.equal(db.database.prepare('SELECT COUNT(*) count FROM student_session_ledger_events').get().count, 4);
  let view = await attendanceApi(db, { studentId: 'student-a', month: '2026-08' });
  assert.deepEqual({ start: view.body.cycleStartDate, count: view.body.attendanceCount,
    complete: view.body.cycleComplete }, { start: '2026-08-01', count: 4, complete: true });

  seedCheck(db, 'lesson-a', '2026-08-17', 'P');
  const second = await syncStudentSessionLedgers({ DB: db }, CUTOFF);
  assert.equal(second.createdCycles, 1);
  assert.equal(second.createdEvents, 1);
  view = await attendanceApi(db, { studentId: 'student-a', month: '2026-08' });
  assert.deepEqual({ start: view.body.cycleStartDate, count: view.body.attendanceCount,
    complete: view.body.cycleComplete }, { start: '2026-08-17', count: 1, complete: false });
});

test('past direct absence remains attested after a same-att memo update and rebuilds once while exam stays at zero', async () => {
  const db = new TestD1(true, true);
  const now = Date.parse('2026-09-05T14:50:00Z');
  seedRoster(db, [rosterStudent('student-a', '과거보강학생')]);
  seedTask(db, 'lesson-a', 'student-a');
  seedCheck(db, 'lesson-a', '2026-08-25', 'P');
  seedCheck(db, 'lesson-a', '2026-08-30', 'L');
  const initial = await syncStudentSessionLedgers({ DB: db }, now);
  assert.equal(initial.createdEvents, 2);

  seedDirectCompletedMakeup(db, 'mu_direct_absence', '2026-08-20', 'manual_absence');
  seedDirectCompletedMakeup(db, 'mu_direct_exam', '2026-08-15', 'manual_exam');
  const directKey = 'makeup_lesson_mu_direct_absence|2026-08-20';
  const directCheck = JSON.parse(db.database.prepare('SELECT data FROM checks WHERE app=? AND k=?')
    .get('task', directKey).data);
  delete directCheck.source;
  directCheck.note = '같은 출결 상태에서 저장한 자체 작성 메모';
  db.database.prepare('UPDATE checks SET data=?,updated_at=updated_at+1,srv_at=srv_at+1 WHERE app=? AND k=?')
    .run(JSON.stringify(directCheck), 'task', directKey);
  assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(db.database.prepare(
    'SELECT data FROM checks WHERE app=? AND k=?').get('task', directKey).data), 'source'), false);
  const reconciled = await syncStudentSessionLedgers({ DB: db }, now);
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.reconciliations, 1);
  assert.equal(reconciled.reconciliationsPending, 0);
  assert.equal(reconciled.createdEvents, 1);
  assert.deepEqual(db.database.prepare(
    'SELECT generation,source_cutoff_date,kind,reason_code,actor FROM student_session_ledger_generations ' +
      'ORDER BY generation'
  ).all().map(row => ({ ...row })), [
    { generation: 1, source_cutoff_date: '2026-08-01', kind: 'system_backfill',
      reason_code: 'initial_backfill', actor: 'system' },
    { generation: 2, source_cutoff_date: '2026-08-20', kind: 'admin_reconciliation',
      reason_code: 'makeup_direct_completion_backfill', actor: 'system:makeup_direct_completion' }
  ]);
  assert.deepEqual(db.database.prepare(
    'SELECT lesson_task_id,attendance_date,attendance_status,source_kind FROM student_session_ledger_events ' +
      'WHERE generation=2 ORDER BY cycle_number,session_number'
  ).all().map(row => ({ ...row })), [
    { lesson_task_id: 'makeup_lesson_mu_direct_absence', attendance_date: '2026-08-20',
      attendance_status: 'P', source_kind: 'admin_attested' },
    { lesson_task_id: 'lesson-a', attendance_date: '2026-08-25',
      attendance_status: 'P', source_kind: 'check' },
    { lesson_task_id: 'lesson-a', attendance_date: '2026-08-30',
      attendance_status: 'L', source_kind: 'check' }
  ]);
  assert.equal(db.database.prepare(
    "SELECT COUNT(*) count FROM student_session_ledger_events WHERE lesson_task_id='makeup_lesson_mu_direct_exam'"
  ).get().count, 0);

  const retry = await syncStudentSessionLedgers({ DB: db }, now);
  assert.equal(retry.reconciliations, 0);
  assert.equal(retry.createdEvents, 0);
  assert.equal(db.database.prepare(
    "SELECT COUNT(*) count FROM student_session_ledger_events WHERE generation=2 " +
      "AND lesson_task_id='makeup_lesson_mu_direct_absence'"
  ).get().count, 1);

  const alerts = await handleScheduledTuitionAlerts({ DB: db }, now);
  assert.equal(alerts.qualifyingAttendances, 3);
  assert.equal(alerts.created, 0);
  assert.equal(alerts.idempotent, 1);
  assert.deepEqual({ ...db.database.prepare(
    'SELECT cycle_start_date,trigger_date FROM tuition_generation_alerts'
  ).get() }, { cycle_start_date: '2026-08-01', trigger_date: '2026-08-30' });
});

test('past direct completion attestation survives a reconciliation CAS race and retries on the next sync', async () => {
  const db = new TestD1(true, true);
  const now = Date.parse('2026-09-05T14:50:00Z');
  seedRoster(db, [rosterStudent('student-a', '경합보강학생')]);
  seedTask(db, 'lesson-a', 'student-a');
  seedCheck(db, 'lesson-a', '2026-08-30', 'P');
  assert.equal((await syncStudentSessionLedgers({ DB: db }, now)).createdEvents, 1);
  seedDirectCompletedMakeup(db, 'mu_direct_race', '2026-08-20');

  let injected = false;
  db.beforeExecute = sql => {
    if (injected || !sql.startsWith('INSERT INTO student_session_ledger_generations')) return;
    injected = true;
    db.database.prepare(
      'INSERT INTO student_session_ledger_generations(app,student_id,configured_start_date,generation,' +
        'source_cutoff_date,kind,supersedes_generation,supersedes_event_count,reason_code,actor,created_at) ' +
        "VALUES('task',?,?,?,?,'admin_reconciliation',?,?,?,?,?)"
    ).run('student-a', '2026-08-01', 2, '2026-08-20', 1, 1,
      'competing_reconciliation', 'manager:race', now);
  };
  const pending = await syncStudentSessionLedgers({ DB: db }, now);
  db.beforeExecute = null;
  assert.equal(injected, true);
  assert.equal(pending.ok, true);
  assert.equal(pending.reconciliations, 0);
  assert.equal(pending.reconciliationsPending, 1);
  assert.equal(db.database.prepare('SELECT MAX(generation) generation FROM student_session_ledger_generations')
    .get().generation, 1);

  const retried = await syncStudentSessionLedgers({ DB: db }, now);
  assert.equal(retried.reconciliations, 1);
  assert.equal(retried.createdEvents, 1);
  assert.equal(db.database.prepare(
    "SELECT COUNT(*) count FROM student_session_ledger_events WHERE generation=2 " +
      "AND lesson_task_id='makeup_lesson_mu_direct_race'"
  ).get().count, 1);
});

test('admin reconciliation supersedes the historical calendar and later checks append to only the latest generation', async () => {
  const db = new TestD1(true, true);
  const now = Date.parse('2026-09-05T14:50:00Z');
  seedRoster(db, [rosterStudent('student-a', '정정학생', { sessionCycleStartDate: '2026-08-09' })]);
  // 운영 이관 task의 현재 start보다 앞선 실제 출석도 관리자 증빙 정정에는 포함할 수 있다.
  seedTask(db, 'lesson-a', 'student-a', 'teacher-a', { start: '2026-08-22' });
  seedTask(db, 'lesson-old', 'student-a');
  seedCheck(db, 'lesson-old', '2026-08-02', 'P'); // 회차 시작 전 달력 기록은 유지
  db.database.prepare(
    'INSERT INTO makeup_cases(app,case_id,student_id,status,confirmed_staff_id,history) VALUES(?,?,?,?,?,?)'
  ).run('task', 'mu_exam_calendar', 'student-a', 'completed', 'teacher-a', JSON.stringify([
      { action: 'create_manual', reason: 'manual_exam' }
    ]));
  seedTask(db, 'makeup_lesson_mu_exam_calendar', 'student-a', 'teacher-a', {
    lessonInstanceType: 'makeup', makeupCaseId: 'mu_exam_calendar', repeat: 'once',
    start: '2026-08-24', end: '2026-08-24'
  });
  seedCheck(db, 'makeup_lesson_mu_exam_calendar', '2026-08-24', 'P');
  for (const [date, status] of [
    ['2026-08-09', 'P'], ['2026-08-16', 'P'], ['2026-08-23', 'A'], ['2026-08-30', 'P']
  ]) seedCheck(db, 'lesson-a', date, status);
  assert.equal((await syncStudentSessionLedgers({ DB: db }, now)).createdEvents, 1);

  const reconciled = await reconcileStudentSessionLedger({ DB: db }, {
    studentId: 'student-a', configuredStartDate: '2026-08-09',
    sourceCutoffDate: '2026-08-30', expectedGeneration: 1,
    reasonCode: 'verified_attendance_dates', actor: 'manager:director', now,
    entries: ['2026-08-09', '2026-08-16', '2026-08-22', '2026-08-29'].map(date => ({
      taskId: 'lesson-a', date, status: 'P'
    }))
  });
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.generation, 2);
  assert.equal(reconciled.eventCount, 4);
  assert.deepEqual(db.database.prepare(
    'SELECT generation,COUNT(*) count FROM student_session_ledger_events GROUP BY generation ORDER BY generation'
  ).all().map(row => ({ ...row })), [
    { generation: 1, count: 1 }, { generation: 2, count: 4 }
  ]);

  let august = await attendanceApi(db, { studentId: 'student-a', month: '2026-08' }, { scope: 'all' }, now);
  assert.deepEqual(august.body.attendance.map(item => [item.date, item.status]), [
    ['2026-08-02', 'P'], ['2026-08-09', 'P'], ['2026-08-16', 'P'], ['2026-08-22', 'P'],
    ['2026-08-23', 'A'], ['2026-08-24', 'P'], ['2026-08-29', 'P']
  ]);
  assert.deepEqual({ start: august.body.cycleStartDate, count: august.body.attendanceCount,
    complete: august.body.cycleComplete }, { start: '2026-08-09', count: 4, complete: true });

  seedCheck(db, 'lesson-a', '2026-09-01', 'A');
  seedCheck(db, 'lesson-a', '2026-09-02', 'P');
  const tentative = await attendanceApi(db, { studentId: 'student-a', month: '2026-09' },
    { scope: 'all' }, Date.parse('2026-09-02T14:49:00Z'));
  assert.deepEqual(tentative.body.attendance.map(item => [item.date, item.status]), [
    ['2026-09-01', 'A'], ['2026-09-02', 'P']
  ]);
  const appended = await syncStudentSessionLedgers({ DB: db }, now);
  assert.equal(appended.createdEvents, 1);
  assert.equal(db.database.prepare(
    'SELECT COUNT(*) count FROM student_session_ledger_events WHERE generation=1'
  ).get().count, 1);
  const september = await attendanceApi(db, { studentId: 'student-a', month: '2026-09' }, { scope: 'all' }, now);
  assert.deepEqual(september.body.attendance.map(item => [item.date, item.status]), [
    ['2026-09-01', 'A'], ['2026-09-02', 'P']
  ]);
  assert.deepEqual({ start: september.body.cycleStartDate, count: september.body.attendanceCount,
    complete: september.body.cycleComplete }, { start: '2026-09-02', count: 1, complete: false });

  const alerts = await handleScheduledTuitionAlerts({ DB: db }, now);
  assert.equal(alerts.qualifyingAttendances, 5);
  const alert = db.database.prepare(
    'SELECT cycle_start_date,trigger_date FROM tuition_generation_alerts ORDER BY created_at LIMIT 1'
  ).get();
  assert.deepEqual({ ...alert }, { cycle_start_date: '2026-08-09', trigger_date: '2026-08-22' });
});

test('admin reconciliation validates task ownership and generation CAS without changing prior audit rows', async () => {
  const db = new TestD1(true, true);
  const now = Date.parse('2026-09-05T14:50:00Z');
  seedRoster(db, [rosterStudent('student-a', '정정학생'), rosterStudent('student-b', '다른학생')]);
  seedTask(db, 'lesson-a', 'student-a');
  seedTask(db, 'lesson-b', 'student-b');
  for (const date of ['2026-08-01', '2026-08-08', '2026-08-15']) {
    seedCheck(db, 'lesson-a', date, 'P');
  }
  assert.equal((await handleScheduledTuitionAlerts({ DB: db }, now)).created, 1);

  const wrongTask = await reconcileStudentSessionLedger({ DB: db }, {
    studentId: 'student-a', configuredStartDate: '2026-08-01', sourceCutoffDate: '2026-08-30',
    expectedGeneration: 1, reasonCode: 'verified_attendance_dates', actor: 'manager:director', now,
    entries: [{ taskId: 'lesson-b', date: '2026-08-09', status: 'P' }]
  });
  assert.equal(wrongTask.code, 'STUDENT_SESSION_RECONCILIATION_TASK');
  const stale = await reconcileStudentSessionLedger({ DB: db }, {
    studentId: 'student-a', configuredStartDate: '2026-08-01', sourceCutoffDate: '2026-08-30',
    expectedGeneration: 2, reasonCode: 'verified_attendance_dates', actor: 'manager:director', now,
    entries: [{ taskId: 'lesson-a', date: '2026-08-09', status: 'P' }]
  });
  assert.equal(stale.code, 'STUDENT_SESSION_RECONCILIATION_CONFLICT');
  const changedTrigger = await reconcileStudentSessionLedger({ DB: db }, {
    studentId: 'student-a', configuredStartDate: '2026-08-01', sourceCutoffDate: '2026-08-30',
    expectedGeneration: 1, reasonCode: 'verified_attendance_dates', actor: 'manager:director', now,
    entries: ['2026-08-01', '2026-08-08', '2026-08-16'].map(date => ({
      taskId: 'lesson-a', date, status: 'P'
    }))
  });
  assert.equal(changedTrigger.ok, true);
  assert.equal(db.database.prepare(
    'SELECT COUNT(*) count FROM student_session_ledger_generations WHERE student_id=?'
  ).get('student-a').count, 2);
  assert.equal(db.database.prepare(
    'SELECT COUNT(*) count FROM student_session_ledger_events WHERE student_id=?'
  ).get('student-a').count, 6); // 세대 1도 감사 기록으로 유지
  assert.equal(db.database.prepare(
    'SELECT COUNT(*) count FROM tuition_generation_alerts WHERE student_id=?'
  ).get('student-a').count, 1);
  const listed = await api(db, { action: 'list' });
  assert.equal(listed.body.alerts[0].triggerDate, '2026-08-16');
});

test('ledger read retries when cycle and event counts change during a same-generation read', async () => {
  const db = new TestD1(true, true);
  seedRoster(db, [rosterStudent('student-a', '동시조회학생')]);
  seedTask(db, 'lesson-a', 'student-a');
  for (const date of ['2026-08-01', '2026-08-05', '2026-08-09', '2026-08-13']) {
    seedCheck(db, 'lesson-a', date, 'P');
  }
  await syncStudentSessionLedgers({ DB: db }, CUTOFF);
  seedCheck(db, 'lesson-a', '2026-08-17', 'P');

  let injected = false;
  let markerReads = 0;
  db.beforeExecute = sql => {
    if (sql.includes('FROM student_session_ledger_generations AS ledger')) markerReads++;
    if (injected || !sql.startsWith('SELECT cycle_number,cycle_start_date,created_at FROM student_session_ledger_cycles')) {
      return;
    }
    injected = true;
    db.database.prepare(
      'INSERT INTO student_session_ledger_cycles(app,student_id,configured_start_date,generation,' +
        'cycle_number,cycle_start_date,created_at) VALUES(?,?,?,?,?,?,?)'
    ).run('task', 'student-a', '2026-08-01', 1, 2, '2026-08-17', CUTOFF);
    db.database.prepare(
      'INSERT INTO student_session_ledger_events(app,student_id,configured_start_date,generation,' +
        'cycle_number,session_number,lesson_task_id,attendance_date,attendance_status,source_kind,' +
        'check_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run('task', 'student-a', '2026-08-01', 1, 2, 1, 'lesson-a', '2026-08-17', 'P',
      'check', 'lesson-a|2026-08-17', CUTOFF);
  };
  const view = await attendanceApi(db, { studentId: 'student-a', month: '2026-08' });
  db.beforeExecute = null;
  assert.equal(injected, true);
  assert.ok(markerReads >= 4);
  assert.deepEqual({ start: view.body.cycleStartDate, count: view.body.attendanceCount },
    { start: '2026-08-17', count: 1 });
});

test('reconciliation suppresses a disappeared cycle even after roster mode changes and blocks stale confirmation', async () => {
  const db = new TestD1(true, true);
  const now = Date.parse('2026-09-05T14:50:00Z');
  seedRoster(db, [rosterStudent('student-a', '알림정정학생')]);
  seedTask(db, 'lesson-a', 'student-a');
  const dates = ['2026-08-01', '2026-08-05', '2026-08-09', '2026-08-13',
    '2026-08-17', '2026-08-21', '2026-08-25'];
  for (const date of dates) seedCheck(db, 'lesson-a', date, 'P');
  assert.equal((await handleScheduledTuitionAlerts({ DB: db }, now)).created, 2);

  const corrected = await reconcileStudentSessionLedger({ DB: db }, {
    studentId: 'student-a', configuredStartDate: '2026-08-01', sourceCutoffDate: '2026-08-30',
    expectedGeneration: 1, reasonCode: 'verified_attendance_dates', actor: 'manager:director', now,
    entries: dates.slice(0, 4).map(date => ({ taskId: 'lesson-a', date, status: 'P' }))
  });
  assert.equal(corrected.ok, true);
  assert.deepEqual(db.database.prepare(
    'SELECT cycle_start_date,effective_status FROM tuition_generation_alert_states ' +
      'WHERE ledger_generation=2 ORDER BY cycle_start_date'
  ).all().map(row => ({ ...row })), [
    { cycle_start_date: '2026-08-01', effective_status: 'active' },
    { cycle_start_date: '2026-08-17', effective_status: 'suppressed' }
  ]);
  let listed = await api(db, { action: 'list' });
  assert.deepEqual(listed.body.alerts.map(item => item.cycleStartDate), ['2026-08-01']);

  seedRoster(db, [rosterStudent('student-a', '알림정정학생', {
    billingMode: 'monthly', sessionCycleStartDate: ''
  })]);
  listed = await api(db, { action: 'list' });
  assert.deepEqual(listed.body.alerts.map(item => item.cycleStartDate), ['2026-08-01']);
  const suppressedId = db.database.prepare(
    "SELECT alert_id FROM tuition_generation_alerts WHERE cycle_start_date='2026-08-17'"
  ).get().alert_id;
  const denied = await api(db, { action: 'confirm', alertId: suppressedId });
  assert.equal(denied.status, 409);
  assert.equal(denied.body.code, 'TUITION_ALERT_NOT_EFFECTIVE');
});

test('a delayed Cron reactivates a suppressed cycle by logical sequence instead of its older clock', async () => {
  const db = new TestD1(true, true);
  const reconciliationTime = Date.parse('2026-09-05T14:50:00Z');
  const delayedCronTime = Date.parse('2026-09-02T14:50:00Z');
  seedRoster(db, [rosterStudent('student-a', '지연크론학생')]);
  seedTask(db, 'lesson-a', 'student-a');
  const originalDates = ['2026-08-01', '2026-08-05', '2026-08-09', '2026-08-13',
    '2026-08-17', '2026-08-21', '2026-08-25'];
  for (const date of originalDates) seedCheck(db, 'lesson-a', date, 'P');
  assert.equal((await handleScheduledTuitionAlerts({ DB: db }, reconciliationTime)).created, 2);

  const corrected = await reconcileStudentSessionLedger({ DB: db }, {
    studentId: 'student-a', configuredStartDate: '2026-08-01', sourceCutoffDate: '2026-08-30',
    expectedGeneration: 1, reasonCode: 'verified_attendance_dates', actor: 'manager:director',
    now: reconciliationTime,
    entries: originalDates.slice(0, 6).map(date => ({ taskId: 'lesson-a', date, status: 'P' }))
  });
  assert.equal(corrected.ok, true);
  const secondAlertId = db.database.prepare(
    "SELECT alert_id FROM tuition_generation_alerts WHERE cycle_start_date='2026-08-17'"
  ).get().alert_id;

  seedCheck(db, 'lesson-a', '2026-09-02', 'P');
  const delayed = await handleScheduledTuitionAlerts({ DB: db }, delayedCronTime);
  assert.equal(delayed.ok, true);
  const states = db.database.prepare(
    'SELECT state_revision,state_sequence,effective_status,created_at ' +
      'FROM tuition_generation_alert_states WHERE alert_id=? AND ledger_generation=2 ' +
      'ORDER BY state_revision'
  ).all(secondAlertId).map(row => ({ ...row }));
  assert.deepEqual(states, [
    { state_revision: 1, state_sequence: 2, effective_status: 'suppressed',
      created_at: reconciliationTime },
    { state_revision: 2, state_sequence: 3, effective_status: 'active',
      created_at: delayedCronTime }
  ]);

  const listed = await api(db, { action: 'list' });
  const second = listed.body.alerts.find(item => item.alertId === secondAlertId);
  assert.equal(second.triggerDate, '2026-09-02');
  const confirmed = await api(db, { action: 'confirm', alertId: secondAlertId });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.ok, true);
});

test('an alert state from an older ledger generation is hidden and cannot be confirmed', async () => {
  const db = new TestD1(true, true);
  const now = Date.parse('2026-09-05T14:50:00Z');
  seedRoster(db, [rosterStudent('student-a', '구세대알림학생')]);
  seedTask(db, 'lesson-a', 'student-a');
  const dates = ['2026-08-01', '2026-08-08', '2026-08-15'];
  for (const date of dates) seedCheck(db, 'lesson-a', date, 'P');
  assert.equal((await handleScheduledTuitionAlerts({ DB: db }, now)).created, 1);

  // 정정 세대와 알림 상태가 서로 다른 요청으로 노출되는 극단적인 race를 재현한다.
  // 소비 경로는 gen1 active 상태가 남아 있어도 현재 원장이 gen2이면 fail-closed 해야 한다.
  db.database.prepare(
    'INSERT INTO student_session_ledger_generations(app,student_id,configured_start_date,generation,' +
      'source_cutoff_date,kind,supersedes_generation,supersedes_event_count,reason_code,actor,created_at) ' +
      "VALUES('task',?,?,?,?,'admin_reconciliation',?,?,?,?,?)"
  ).run('student-a', '2026-08-01', 2, '2026-08-30', 1, 3,
    'test_stale_alert_state', 'manager:test', now + 1);
  db.database.prepare(
    'INSERT INTO student_session_ledger_cycles(app,student_id,configured_start_date,generation,' +
      "cycle_number,cycle_start_date,created_at) VALUES('task',?,?,?,?,?,?)"
  ).run('student-a', '2026-08-01', 2, 1, '2026-08-01', now + 1);
  for (const [index, date] of dates.entries()) {
    db.database.prepare(
      'INSERT INTO student_session_ledger_events(app,student_id,configured_start_date,generation,' +
        'cycle_number,session_number,lesson_task_id,attendance_date,attendance_status,source_kind,' +
        "check_key,created_at) VALUES('task',?,?,?,?,?,?,?,?,?,?,?)"
    ).run('student-a', '2026-08-01', 2, 1, index + 1, 'lesson-a', date, 'P',
      'admin_attested', 'lesson-a|' + date, now + 1);
  }

  const alertId = db.database.prepare(
    "SELECT alert_id FROM tuition_generation_alerts WHERE student_id='student-a'"
  ).get().alert_id;
  const listed = await api(db, { action: 'list' });
  assert.deepEqual(listed.body.alerts, []);
  const denied = await api(db, { action: 'confirm', alertId });
  assert.equal(denied.status, 409);
  assert.equal(denied.body.code, 'TUITION_ALERT_NOT_EFFECTIVE');
});

test('reconciliation batch rolls back generation, events, base alert and state together', async () => {
  const db = new TestD1(true, true);
  const now = Date.parse('2026-09-05T14:50:00Z');
  seedRoster(db, [rosterStudent('student-a', '원자성학생')]);
  seedTask(db, 'lesson-a', 'student-a');
  await syncStudentSessionLedgers({ DB: db }, now);
  db.database.exec(`
    CREATE TRIGGER test_alert_state_abort
    BEFORE INSERT ON tuition_generation_alert_states
    WHEN NEW.ledger_generation=2
    BEGIN SELECT RAISE(ABORT,'TEST_ALERT_STATE_ABORT'); END;
  `);
  const failed = await reconcileStudentSessionLedger({ DB: db }, {
    studentId: 'student-a', configuredStartDate: '2026-08-01', sourceCutoffDate: '2026-08-30',
    expectedGeneration: 1, reasonCode: 'verified_attendance_dates', actor: 'manager:director', now,
    entries: ['2026-08-01', '2026-08-08', '2026-08-15'].map(date => ({
      taskId: 'lesson-a', date, status: 'P'
    }))
  });
  assert.equal(failed.code, 'STUDENT_SESSION_RECONCILIATION_CONFLICT');
  assert.equal(db.database.prepare('SELECT COUNT(*) count FROM student_session_ledger_generations').get().count, 1);
  assert.equal(db.database.prepare('SELECT COUNT(*) count FROM student_session_ledger_events').get().count, 0);
  assert.equal(db.database.prepare('SELECT COUNT(*) count FROM tuition_generation_alerts').get().count, 0);
  assert.equal(db.database.prepare('SELECT COUNT(*) count FROM tuition_generation_alert_states').get().count, 0);
});

test('admin attestation accepts only regular lessons or exact qualifying absence makeups', async () => {
  const db = new TestD1(true, true);
  const now = Date.parse('2026-09-05T14:50:00Z');
  seedRoster(db, [rosterStudent('student-a', '보강검증학생')]);
  seedTask(db, 'lesson-a', 'student-a', 'teacher-a', { start: '2026-08-22' });
  for (const [caseId, reason] of [
    ['mu_exam', 'manual_exam'], ['mu_other', 'manual_other'], ['mu_absence', 'manual_absence']
  ]) {
    db.database.prepare(
      'INSERT INTO makeup_cases(app,case_id,student_id,status,confirmed_staff_id,history) VALUES(?,?,?,?,?,?)'
    ).run('task', caseId, 'student-a', 'completed', 'teacher-a', JSON.stringify([
        { action: 'create_manual', reason }
      ]));
    seedTask(db, 'makeup_lesson_' + caseId, 'student-a', 'teacher-a', {
      lessonInstanceType: 'makeup', makeupCaseId: caseId, repeat: 'once',
      start: '2026-08-20', end: '2026-08-20'
    });
  }
  seedTask(db, 'makeup_lesson_mu_missing', 'student-a', 'teacher-a', {
    lessonInstanceType: 'makeup', makeupCaseId: 'mu_missing', repeat: 'once',
    start: '2026-08-20', end: '2026-08-20'
  });
  await syncStudentSessionLedgers({ DB: db }, now);
  for (const taskId of ['makeup_lesson_mu_exam', 'makeup_lesson_mu_other', 'makeup_lesson_mu_missing']) {
    const rejected = await reconcileStudentSessionLedger({ DB: db }, {
      studentId: 'student-a', configuredStartDate: '2026-08-01', sourceCutoffDate: '2026-08-30',
      expectedGeneration: 1, reasonCode: 'verified_attendance_dates', actor: 'manager:director', now,
      entries: [{ taskId, date: '2026-08-09', status: 'P' }]
    });
    assert.equal(rejected.code, 'STUDENT_SESSION_RECONCILIATION_TASK');
  }
  const accepted = await reconcileStudentSessionLedger({ DB: db }, {
    studentId: 'student-a', configuredStartDate: '2026-08-01', sourceCutoffDate: '2026-08-30',
    expectedGeneration: 1, reasonCode: 'verified_attendance_dates', actor: 'manager:director', now,
    entries: [
      { taskId: 'lesson-a', date: '2026-08-09', status: 'P' },
      { taskId: 'makeup_lesson_mu_absence', date: '2026-08-16', status: 'P' }
    ]
  });
  assert.equal(accepted.ok, true);
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
