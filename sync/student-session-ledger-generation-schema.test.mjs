import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const migration = fs.readFileSync(
  new URL('./migrations/064_student_session_ledger_generations.sql', import.meta.url),
  'utf8'
);
const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

function createLegacyDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE tasks (
      app TEXT NOT NULL, id TEXT NOT NULL, owner TEXT NOT NULL, data TEXT NOT NULL,
      updated_at INTEGER NOT NULL, srv_at INTEGER NOT NULL,
      PRIMARY KEY (app, id)
    );
    CREATE TABLE checks (
      app TEXT NOT NULL, k TEXT NOT NULL, owner TEXT NOT NULL, data TEXT NOT NULL,
      updated_at INTEGER NOT NULL, srv_at INTEGER NOT NULL,
      PRIMARY KEY (app, k)
    );
    CREATE TABLE tuition_generation_alerts (
      app TEXT NOT NULL, alert_id TEXT NOT NULL, student_id TEXT NOT NULL,
      cycle_start_date TEXT NOT NULL, threshold_count INTEGER NOT NULL,
      trigger_task_id TEXT NOT NULL, trigger_date TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (app, alert_id), UNIQUE (app, student_id, cycle_start_date)
    );
    CREATE TABLE tuition_generation_alert_confirmations (
      app TEXT NOT NULL, confirmation_id TEXT NOT NULL, alert_id TEXT NOT NULL,
      confirmed_at INTEGER NOT NULL, confirmed_by TEXT NOT NULL,
      PRIMARY KEY (app, confirmation_id), UNIQUE (app, alert_id),
      FOREIGN KEY (app, alert_id) REFERENCES tuition_generation_alerts(app, alert_id)
    );
    CREATE TABLE makeup_cases (
      app TEXT NOT NULL, case_id TEXT NOT NULL, student_id TEXT NOT NULL,
      status TEXT NOT NULL, history TEXT NOT NULL,
      PRIMARY KEY (app, case_id)
    );
    CREATE TABLE student_session_cycles (
      app TEXT NOT NULL, student_id TEXT NOT NULL, configured_start_date TEXT NOT NULL,
      cycle_number INTEGER NOT NULL, cycle_start_date TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (app, student_id, configured_start_date, cycle_number)
    );
    CREATE TABLE student_session_attendance_events (
      app TEXT NOT NULL, student_id TEXT NOT NULL, configured_start_date TEXT NOT NULL,
      cycle_number INTEGER NOT NULL, session_number INTEGER NOT NULL,
      lesson_task_id TEXT NOT NULL, attendance_date TEXT NOT NULL,
      attendance_status TEXT NOT NULL, check_key TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (app, student_id, configured_start_date, lesson_task_id, attendance_date),
      UNIQUE (app, student_id, configured_start_date, cycle_number, session_number)
    );
  `);
  return database;
}

function saveTask(database, taskId, studentId) {
  const data = JSON.stringify({
    id: taskId,
    studentId,
    staffId: 'teacher-1',
    taskKind: 'lesson_instruction',
    lessonFormVersion: 1
  });
  database.prepare(
    "INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES('task',?,'teacher-1',?,1,1)"
  ).run(taskId, data);
}

function saveMakeupTask(database, taskId, studentId, caseId) {
  const data = JSON.stringify({
    id: taskId,
    studentId,
    staffId: 'teacher-1',
    taskKind: 'lesson_instruction',
    lessonFormVersion: 1,
    lessonInstanceType: 'makeup',
    makeupCaseId: caseId
  });
  database.prepare(
    "INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES('task',?,'teacher-1',?,1,1)"
  ).run(taskId, data);
}

function saveCheck(database, taskId, date, status = 'P') {
  const data = JSON.stringify({ taskId, date, att: status });
  database.prepare(
    "INSERT INTO checks(app,k,owner,data,updated_at,srv_at) VALUES('task',?,'teacher-1',?,1,1)"
  ).run(`${taskId}|${date}`, data);
}

test('064 migrates legacy rows into generation 1 and is rerunnable', () => {
  const database = createLegacyDatabase();
  const studentId = 'student-a';
  const taskId = 'lesson-a';
  saveTask(database, taskId, studentId);
  saveCheck(database, taskId, '2026-08-09');
  database.prepare(
    "INSERT INTO student_session_cycles VALUES('task',?,'2026-08-01',1,'2026-08-01',10)"
  ).run(studentId);
  database.prepare(
    'INSERT INTO student_session_attendance_events VALUES' +
      "('task',?,'2026-08-01',1,1,?,'2026-08-09','P',?,11)"
  ).run(studentId, taskId, `${taskId}|2026-08-09`);

  database.exec(migration);
  database.exec(migration);

  assert.deepEqual({ ...database.prepare(
    'SELECT generation,source_cutoff_date,kind,supersedes_generation,' +
      'supersedes_event_count,reason_code,actor FROM student_session_ledger_generations'
  ).get() }, {
    generation: 1,
    source_cutoff_date: '2026-08-09',
    kind: 'system_backfill',
    supersedes_generation: null,
    supersedes_event_count: 0,
    reason_code: 'legacy_063_migration',
    actor: 'system:migration:064'
  });
  assert.equal(database.prepare('SELECT COUNT(*) count FROM student_session_ledger_cycles').get().count, 1);
  assert.deepEqual({ ...database.prepare(
    'SELECT generation,cycle_number,session_number,source_kind,check_key ' +
      'FROM student_session_ledger_events'
  ).get() }, {
    generation: 1,
    cycle_number: 1,
    session_number: 1,
    source_kind: 'check',
    check_key: `${taskId}|2026-08-09`
  });
  database.close();
});

test('admin reconciliation is append-only, source-bound, and supersedes with event-count CAS', () => {
  const database = createLegacyDatabase();
  const studentId = 'student-b';
  const taskId = 'lesson-b';
  saveTask(database, taskId, studentId);
  saveCheck(database, taskId, '2026-08-09');
  database.prepare(
    "INSERT INTO student_session_cycles VALUES('task',?,'2026-08-01',1,'2026-08-01',10)"
  ).run(studentId);
  database.prepare(
    'INSERT INTO student_session_attendance_events VALUES' +
      "('task',?,'2026-08-01',1,1,?,'2026-08-09','P',?,11)"
  ).run(studentId, taskId, `${taskId}|2026-08-09`);
  database.exec(migration);

  assert.throws(() => database.prepare(
    'INSERT INTO student_session_ledger_generations VALUES' +
      "('task',?,'2026-08-01',2,'2026-08-30','admin_reconciliation',1,0," +
      "'attendance_date_correction','admin-1',20)"
  ).run(studentId), /GENERATION_CONFLICT/);

  database.prepare(
    'INSERT INTO student_session_ledger_generations VALUES' +
      "('task',?,'2026-08-01',2,'2026-08-30','admin_reconciliation',1,1," +
      "'attendance_date_correction','admin-1',20)"
  ).run(studentId);
  database.prepare(
    'INSERT INTO student_session_ledger_cycles VALUES' +
      "('task',?,'2026-08-01',2,1,'2026-08-01',20)"
  ).run(studentId);
  database.prepare(
    'INSERT INTO student_session_ledger_events VALUES' +
      "('task',?,'2026-08-01',2,1,1,?,'2026-08-16','P','admin_attested',?,21)"
  ).run(studentId, taskId, `${taskId}|2026-08-16`);

  assert.throws(() => database.prepare(
    'INSERT INTO student_session_ledger_events VALUES' +
      "('task',?,'2026-08-01',1,1,2,?,'2026-08-10','P','admin_attested',?,22)"
  ).run(studentId, taskId, `${taskId}|2026-08-10`), /EVENT_SEQUENCE/);
  assert.throws(() => database.prepare(
    'INSERT INTO student_session_ledger_events VALUES' +
      "('task',?,'2026-08-01',2,1,2,'missing-task','2026-08-23','P'," +
      "'admin_attested','missing-task|2026-08-23',22)"
  ).run(studentId), /EVENT_SOURCE/);
  assert.throws(() => database.prepare(
    "INSERT INTO checks(app,k,owner,data,updated_at,srv_at) VALUES('task',?,'teacher-1',?,2,2)"
  ).run(`${taskId}|2026-08-16`, JSON.stringify({ taskId, date: '2026-08-16', att: 'P' })),
  /SESSION4_ATTENDANCE_LOCKED/);

  saveCheck(database, taskId, '2026-09-06');
  database.prepare(
    'INSERT INTO student_session_ledger_events VALUES' +
      "('task',?,'2026-08-01',2,1,2,?,'2026-09-06','P','check',?,23)"
  ).run(studentId, taskId, `${taskId}|2026-09-06`);
  saveCheck(database, taskId, '2026-08-23');
  assert.throws(() => database.prepare(
    'INSERT INTO student_session_ledger_events VALUES' +
      "('task',?,'2026-08-01',2,1,3,?,'2026-08-23','P','check',?,24)"
  ).run(studentId, taskId, `${taskId}|2026-08-23`), /EVENT_SEQUENCE/);
  assert.throws(() => database.prepare(
    'INSERT INTO student_session_ledger_events VALUES' +
      "('task',?,'2026-08-01',2,1,3,?,'2026-09-13','P','admin_attested',?,24)"
  ).run(studentId, taskId, `${taskId}|2026-09-13`), /EVENT_SEQUENCE/);

  database.prepare(
    "INSERT INTO student_session_cycles VALUES('task',?,'2026-08-01',2,'2026-09-13',30)"
  ).run(studentId);
  database.prepare(
    'INSERT INTO student_session_attendance_events VALUES' +
      "('task',?,'2026-08-01',2,1,?,'2026-09-13','P',?,31)"
  ).run(studentId, taskId, `${taskId}|2026-09-13`);
  database.exec(migration);
  assert.equal(database.prepare(
    'SELECT COUNT(*) count FROM student_session_ledger_cycles WHERE generation=1'
  ).get().count, 1);
  assert.throws(() => database.prepare(
    "UPDATE student_session_ledger_generations SET reason_code='changed'"
  ).run(), /APPEND_ONLY/);
  assert.throws(() => database.prepare(
    'DELETE FROM student_session_ledger_events'
  ).run(), /APPEND_ONLY/);
  database.close();
});

test('schema.sql carries the complete 064 generation ledger contract', () => {
  const normalizedSchema = schema.replaceAll('\r\n', '\n');
  const normalizedMigration = migration.replaceAll('\r\n', '\n').trim();
  assert.ok(normalizedSchema.includes(normalizedMigration));
  for (const field of [
    'source_cutoff_date', 'kind', 'supersedes_generation', 'supersedes_event_count',
    'reason_code', 'actor', 'source_kind', 'state_revision', 'state_sequence', 'effective_status'
  ]) {
    assert.match(migration, new RegExp(`\\b${field}\\b`));
  }
});

test('tuition alert states follow the latest ledger generation and exact third attendance', () => {
  const database = createLegacyDatabase();
  const studentId = 'student-alert';
  const taskId = 'lesson-alert';
  const alertId = 'tga_' + 'a'.repeat(52);
  saveTask(database, taskId, studentId);
  for (const date of ['2026-08-09', '2026-08-16', '2026-08-23']) saveCheck(database, taskId, date);
  database.prepare(
    "INSERT INTO student_session_cycles VALUES('task',?,'2026-08-01',1,'2026-08-01',10)"
  ).run(studentId);
  for (const [index, date] of ['2026-08-09', '2026-08-16', '2026-08-23'].entries()) {
    database.prepare(
      'INSERT INTO student_session_attendance_events VALUES' +
        "('task',?,'2026-08-01',1,?,?,?,'P',?,?)"
    ).run(studentId, index + 1, taskId, date, `${taskId}|${date}`, 11 + index);
  }
  database.exec(migration);
  database.prepare(
    'INSERT INTO tuition_generation_alerts VALUES' +
      "('task',?,?,'2026-08-01',3,?,'2026-08-23',30)"
  ).run(alertId, studentId, taskId);
  database.prepare(
    'INSERT INTO tuition_generation_alert_states VALUES' +
      "('task',?,?, '2026-08-01',1,1,1,'2026-08-01','active',?,'2026-08-23'," +
      "'threshold_reached','system',31)"
  ).run(alertId, studentId, taskId);

  assert.throws(() => database.prepare(
    'INSERT INTO tuition_generation_alert_states VALUES' +
      "('task',?,?, '2026-08-01',1,3,2,'2026-08-01','active',?,'2026-08-23'," +
      "'bad_revision','system',32)"
  ).run(alertId, studentId, taskId), /STATE_IDENTITY/);
  assert.throws(() => database.prepare(
    'INSERT INTO tuition_generation_alert_states VALUES' +
      "('task',?,?, '2026-08-01',1,2,2,'2026-08-01','suppressed',NULL,NULL," +
      "'still_active','admin-1',32)"
  ).run(alertId, studentId), /STATE_EFFECTIVE/);

  database.prepare(
    'INSERT INTO student_session_ledger_generations VALUES' +
      "('task',?,'2026-08-01',2,'2026-08-30','admin_reconciliation',1,3," +
      "'attendance_date_correction','admin-1',40)"
  ).run(studentId);
  database.prepare(
    'INSERT INTO student_session_ledger_cycles VALUES' +
      "('task',?,'2026-08-01',2,1,'2026-08-01',40)"
  ).run(studentId);
  for (const [index, date] of ['2026-08-09', '2026-08-16'].entries()) {
    database.prepare(
      'INSERT INTO student_session_ledger_events VALUES' +
        "('task',?,'2026-08-01',2,1,?,?,?,'P','admin_attested',?,?)"
    ).run(studentId, index + 1, taskId, date, `${taskId}|${date}`, 41 + index);
  }
  database.prepare(
    'INSERT INTO tuition_generation_alert_states VALUES' +
      "('task',?,?, '2026-08-01',2,1,2,'2026-08-01','suppressed',NULL,NULL," +
      "'threshold_no_longer_reached','admin-1',43)"
  ).run(alertId, studentId);
  assert.throws(() => database.prepare(
    "INSERT INTO tuition_generation_alert_confirmations VALUES('task','confirmation-blocked',?,50,'admin-1')"
  ).run(alertId), /TUITION_ALERT_SUPPRESSED/);

  saveCheck(database, taskId, '2026-09-06');
  database.prepare(
    'INSERT INTO student_session_ledger_events VALUES' +
      "('task',?,'2026-08-01',2,1,3,?,'2026-09-06','P','check',?,44)"
  ).run(studentId, taskId, `${taskId}|2026-09-06`);
  database.prepare(
    'INSERT INTO tuition_generation_alert_states VALUES' +
      "('task',?,?, '2026-08-01',2,2,3,'2026-08-01','active',?,'2026-09-06'," +
      "'threshold_reached','system',32)"
  ).run(alertId, studentId, taskId);
  database.prepare(
    "INSERT INTO tuition_generation_alert_confirmations VALUES('task','confirmation-active',?,50,'admin-1')"
  ).run(alertId);

  const legacyAlertId = 'tga_' + 'b'.repeat(52);
  database.prepare(
    'INSERT INTO tuition_generation_alerts VALUES' +
      "('task',?,'legacy-student','2026-07-01',3,'legacy-task','2026-07-15',30)"
  ).run(legacyAlertId);
  database.prepare(
    "INSERT INTO tuition_generation_alert_confirmations VALUES('task','confirmation-legacy',?,50,'admin-1')"
  ).run(legacyAlertId);

  assert.deepEqual({ ...database.prepare(
    'SELECT ledger_generation,state_revision,state_sequence,effective_status ' +
      'FROM tuition_generation_alert_states WHERE alert_id=? ORDER BY state_sequence DESC LIMIT 1'
  ).get(alertId) }, { ledger_generation: 2, state_revision: 2, state_sequence: 3,
    effective_status: 'active' });
  assert.throws(() => database.prepare(
    "UPDATE tuition_generation_alert_states SET reason_code='changed'"
  ).run(), /APPEND_ONLY/);
  assert.throws(() => database.prepare(
    'DELETE FROM tuition_generation_alert_states'
  ).run(), /APPEND_ONLY/);
  database.close();
});

test('generation cycles cannot skip, reverse dates, or accept an unverified makeup task', () => {
  const database = createLegacyDatabase();
  const studentId = 'student-invariants';
  const taskId = 'lesson-invariants';
  const secondTaskId = 'lesson-invariants-second';
  saveTask(database, taskId, studentId);
  saveTask(database, secondTaskId, studentId);
  for (const date of [
    '2026-08-08', '2026-08-09', '2026-08-16', '2026-08-23', '2026-08-30'
  ]) saveCheck(database, taskId, date);
  for (const date of ['2026-08-30', '2026-08-31']) saveCheck(database, secondTaskId, date);
  database.exec(migration);
  database.prepare(
    'INSERT INTO student_session_ledger_generations VALUES' +
      "('task',?,'2026-08-01',1,'2026-08-30','system_backfill',NULL,0," +
      "'initial_backfill','system',10)"
  ).run(studentId);
  assert.throws(() => database.prepare(
    'INSERT INTO student_session_ledger_cycles VALUES' +
      "('task',?,'2026-08-01',1,1,'2026-08-02',10)"
  ).run(studentId), /CYCLE_SEQUENCE/);
  database.prepare(
    'INSERT INTO student_session_ledger_cycles VALUES' +
      "('task',?,'2026-08-01',1,1,'2026-08-01',10)"
  ).run(studentId);
  assert.throws(() => database.prepare(
    'INSERT INTO student_session_ledger_events VALUES' +
      "('task',?,'2026-08-01',1,1,1,?,'2026-08-02','P','admin_attested',?,11)"
  ).run(studentId, taskId, `${taskId}|2026-08-02`), /EVENT_SEQUENCE/);
  database.prepare(
    'INSERT INTO student_session_ledger_events VALUES' +
      "('task',?,'2026-08-01',1,1,1,?,'2026-08-09','P','check',?,11)"
  ).run(studentId, taskId, `${taskId}|2026-08-09`);
  assert.throws(() => database.prepare(
    'INSERT INTO student_session_ledger_events VALUES' +
      "('task',?,'2026-08-01',1,1,2,?,'2026-08-08','P','check',?,12)"
  ).run(studentId, taskId, `${taskId}|2026-08-08`), /EVENT_SEQUENCE/);
  for (const [session, date] of [[2, '2026-08-16'], [3, '2026-08-23'], [4, '2026-08-30']]) {
    database.prepare(
      'INSERT INTO student_session_ledger_events VALUES' +
        "('task',?,'2026-08-01',1,1,?,?,?,'P','check',?,?)"
    ).run(studentId, session, taskId, date, `${taskId}|${date}`, 10 + session);
  }
  assert.throws(() => database.prepare(
    'INSERT INTO student_session_ledger_cycles VALUES' +
      "('task',?,'2026-08-01',1,3,'2026-08-30',20)"
  ).run(studentId), /CYCLE_SEQUENCE/);
  assert.throws(() => database.prepare(
    'INSERT INTO student_session_ledger_cycles VALUES' +
      "('task',?,'2026-08-01',1,2,'2026-08-29',20)"
  ).run(studentId), /CYCLE_SEQUENCE/);
  database.prepare(
    'INSERT INTO student_session_ledger_cycles VALUES' +
      "('task',?,'2026-08-01',1,2,'2026-08-30',20)"
  ).run(studentId);
  assert.throws(() => database.prepare(
    'INSERT INTO student_session_ledger_events VALUES' +
      "('task',?,'2026-08-01',1,2,1,?,'2026-08-31','P','check',?,21)"
  ).run(studentId, secondTaskId, `${secondTaskId}|2026-08-31`), /EVENT_SEQUENCE/);
  database.prepare(
    'INSERT INTO student_session_ledger_events VALUES' +
      "('task',?,'2026-08-01',1,2,1,?,'2026-08-30','P','check',?,21)"
  ).run(studentId, secondTaskId, `${secondTaskId}|2026-08-30`);

  const caseId = 'case-a';
  const makeupTaskId = `makeup_lesson_${caseId}`;
  saveMakeupTask(database, makeupTaskId, studentId, caseId);
  saveCheck(database, makeupTaskId, '2026-09-06');
  assert.throws(() => database.prepare(
    'INSERT INTO student_session_ledger_events VALUES' +
      "('task',?,'2026-08-01',1,2,2,?,'2026-09-06','P','check',?,22)"
  ).run(studentId, makeupTaskId, `${makeupTaskId}|2026-09-06`), /EVENT_SOURCE/);
  database.prepare(
    "INSERT INTO makeup_cases VALUES('task',?,?,'confirmed',?)"
  ).run(caseId, studentId, JSON.stringify([{ action: 'create_manual', reason: 'manual_absence' }]));
  database.prepare(
    'INSERT INTO student_session_ledger_events VALUES' +
      "('task',?,'2026-08-01',1,2,2,?,'2026-09-06','P','check',?,22)"
  ).run(studentId, makeupTaskId, `${makeupTaskId}|2026-09-06`);
  assert.equal(database.prepare(
    'SELECT COUNT(*) count FROM student_session_ledger_events WHERE cycle_number=2'
  ).get().count, 2);
  database.close();
});

test('confirmation rejects an active state after its ledger generation becomes stale', () => {
  const database = createLegacyDatabase();
  const studentId = 'student-stale-alert';
  const taskId = 'lesson-stale-alert';
  const alertId = 'tga_' + 'c'.repeat(52);
  saveTask(database, taskId, studentId);
  for (const date of ['2026-08-09', '2026-08-16', '2026-08-23']) {
    saveCheck(database, taskId, date);
  }
  database.exec(migration);
  database.prepare(
    'INSERT INTO student_session_ledger_generations VALUES' +
      "('task',?,'2026-08-01',1,'2026-08-23','system_backfill',NULL,0," +
      "'initial_backfill','system',10)"
  ).run(studentId);
  database.prepare(
    'INSERT INTO student_session_ledger_cycles VALUES' +
      "('task',?,'2026-08-01',1,1,'2026-08-01',10)"
  ).run(studentId);
  for (const [index, date] of ['2026-08-09', '2026-08-16', '2026-08-23'].entries()) {
    database.prepare(
      'INSERT INTO student_session_ledger_events VALUES' +
        "('task',?,'2026-08-01',1,1,?,?,?,'P','check',?,?)"
    ).run(studentId, index + 1, taskId, date, `${taskId}|${date}`, 11 + index);
  }
  database.prepare(
    'INSERT INTO tuition_generation_alerts VALUES' +
      "('task',?,?,'2026-08-01',3,?,'2026-08-23',20)"
  ).run(alertId, studentId, taskId);
  database.prepare(
    'INSERT INTO tuition_generation_alert_states VALUES' +
      "('task',?,?,'2026-08-01',1,1,1,'2026-08-01','active',?,'2026-08-23'," +
      "'threshold_reached','system',21)"
  ).run(alertId, studentId, taskId);
  database.prepare(
    'INSERT INTO student_session_ledger_generations VALUES' +
      "('task',?,'2026-08-01',2,'2026-08-23','admin_reconciliation',1,3," +
      "'attendance_date_correction','admin-1',22)"
  ).run(studentId);

  assert.throws(() => database.prepare(
    "INSERT INTO tuition_generation_alert_confirmations VALUES('task','confirmation-stale',?,30,'admin-1')"
  ).run(alertId), /TUITION_ALERT_SUPPRESSED/);
  database.close();
});
