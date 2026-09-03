import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { handleWeekendVisit, weekendVisitInternals } from './weekend-visit.js';

const migration = fs.readFileSync(new URL('./migrations/050_weekend_actual_visits.sql', import.meta.url), 'utf8');
const sourceDateMigration = fs.readFileSync(new URL('./migrations/058_weekend_visit_source_date.sql', import.meta.url), 'utf8');
const multiVisitMigration = fs.readFileSync(new URL('./migrations/059_weekend_multi_visits.sql', import.meta.url), 'utf8');
const studentChangeMigration = fs.readFileSync(new URL('./migrations/045_student_change_history.sql', import.meta.url), 'utf8');
const taskWriteCasMigration = fs.readFileSync(new URL('./migrations/055_task_write_cas_guards.sql', import.meta.url), 'utf8');
const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('./worker-core.js', import.meta.url), 'utf8');
const readme = fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8');

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' }
});

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  async first() { return this.db.prepareNative(this.sql).get(...this.args) || null; }
  async all() { return { results: this.db.prepareNative(this.sql).all(...this.args) }; }
  async run() {
    if (this.sql.startsWith('INSERT OR IGNORE INTO weekend_actual_visits') && this.db.beforeVisitInsert) {
      const hook = this.db.beforeVisitInsert;
      this.db.beforeVisitInsert = null;
      await hook();
    }
    const result = this.db.prepareNative(this.sql).run(...this.args);
    return { meta: { changes: Number(result.changes || 0) } };
  }
}

class D1Database {
  constructor(options = {}) {
    this.sqlite = new DatabaseSync(':memory:');
    this.beforeVisitInsert = null;
    this.beforeBatch = null;
    this.sqlite.exec('PRAGMA foreign_keys=ON; CREATE TABLE tasks (app TEXT NOT NULL,id TEXT NOT NULL,owner TEXT,data TEXT NOT NULL,updated_at INTEGER NOT NULL,srv_at INTEGER NOT NULL,PRIMARY KEY(app,id)); CREATE TABLE private_rosters (app TEXT NOT NULL PRIMARY KEY,data TEXT NOT NULL,updated_at INTEGER NOT NULL);');
    this.sqlite.exec(studentChangeMigration);
    this.sqlite.exec(taskWriteCasMigration);
    this.sqlite.exec(migration);
    this.sqlite.exec(sourceDateMigration);
    if (options.multiVisit !== false) this.sqlite.exec('BEGIN;\n' + multiVisitMigration + '\nCOMMIT;');
  }
  prepareNative(sql) { return this.sqlite.prepare(sql); }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    if (this.beforeBatch) {
      const hook = this.beforeBatch;
      this.beforeBatch = null;
      await hook();
    }
    this.sqlite.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
  seed() {
    const roster = { roster: { students: [
      { id: 'student-a', name: '학생A', teacherIds: ['teacher-1'] },
      { id: 'student-b', name: '학생B', teacherIds: ['teacher-2'] }
    ] }, bookStudents: [] };
    this.sqlite.prepare('INSERT INTO private_rosters (app,data,updated_at) VALUES (?,?,?)')
      .run('task', JSON.stringify(roster), 1);
    this.seedTask({
      id: 'lesson-a', staffId: 'teacher-1', studentId: 'student-a', studentName: '학생A',
      title: '[수업] 학생A — 어떤 과목도 가능', taskKind: 'lesson_instruction',
      scheduleSlots: [{ days: [0], startTime: '12:00', endTime: '13:20' }], start: '2026-08-01'
    });
    this.seedTask({
      id: 'lesson-b', staffId: 'teacher-2', studentId: 'student-b', studentName: '학생B',
      title: '[수업] 학생B — 수학', taskKind: 'lesson_instruction',
      scheduleSlots: [{ days: [6], startTime: '14:00', endTime: '15:00' }], start: '2026-08-01'
    });
  }
  seedTask(task) {
    task = { lessonRevision: 1, updatedAt: 1, ...task };
    this.sqlite.prepare('INSERT INTO tasks (app,id,owner,data,updated_at,srv_at) VALUES (?,?,?,?,?,?)')
      .run('task', task.id, task.staffId, JSON.stringify(task), 1, 1);
  }
}

const own = { scope: 'own', id: 'teacher-1' };
const nextTeacher = { scope: 'own', id: 'teacher-2' };
const admin = { scope: 'all', id: 'manager-1', role: 'manager' };
const saturday = Date.parse('2026-08-22T10:00:00+09:00');

async function call(db, body, auth = own) {
  const response = await handleWeekendVisit({ DB: db }, 'task', body, '*', auth, json);
  return { status: response.status, body: await response.json() };
}

async function atNow(value, callback) {
  const original = Date.now;
  Date.now = () => value;
  try { return await callback(); } finally { Date.now = original; }
}

function transferLesson(db, taskId, staffId) {
  const row = db.sqlite.prepare('SELECT data,updated_at FROM tasks WHERE app=? AND id=?').get('task', taskId);
  const task = JSON.parse(row.data);
  task.staffId = staffId;
  task.updatedAt = Number(row.updated_at) + 1;
  db.sqlite.prepare('UPDATE tasks SET owner=?,data=?,updated_at=?,srv_at=? WHERE app=? AND id=?')
    .run(staffId, JSON.stringify(task), task.updatedAt, task.updatedAt, 'task', taskId);
}

test('050, 058, and 059 are mirrored in schema and wired before deployment', () => {
  assert.doesNotMatch(migration, /DROP TABLE|DELETE FROM|UPDATE tokens/i);
  assert.doesNotMatch(sourceDateMigration, /DROP TABLE|DELETE FROM|UPDATE tokens/i);
  assert.match(multiVisitMigration, /visit_sequence\s+INTEGER NOT NULL DEFAULT 1/);
  assert.match(multiVisitMigration, /UNIQUE \(app, student_id, lesson_task_id, visit_date, visit_sequence\)/);
  assert.match(multiVisitMigration, /DROP TABLE weekend_actual_visit_events;[\s\S]*DROP TABLE weekend_actual_visits;/);
  for (const name of ['weekend_actual_visits', 'weekend_actual_visit_events', 'trg_weekend_actual_visits_no_delete']) {
    assert.match(migration, new RegExp(name));
    assert.match(schema, new RegExp(name));
  }
  assert.match(sourceDateMigration, /ADD COLUMN source_date TEXT/);
  assert.match(sourceDateMigration, /NEW\.source_date IS NOT OLD\.source_date/);
  assert.match(sourceDateMigration, /trg_weekend_actual_visits_source_date_guard/);
  assert.doesNotMatch(sourceDateMigration, /DROP TRIGGER/i);
  assert.match(schema, /source_date\s+TEXT\s+CHECK/);
  assert.match(schema, /visit_sequence\s+INTEGER NOT NULL DEFAULT 1/);
  assert.match(schema, /UNIQUE \(app, student_id, lesson_task_id, visit_date, visit_sequence\)/);
  assert.match(schema, /idx_weekend_actual_visits_lesson_day/);
  assert.match(schema, /trg_weekend_actual_visits_source_date_insert_guard/);
  assert.match(schema, /trg_weekend_actual_visits_time_update_guard/);
  assert.match(schema, /trg_weekend_actual_visits_source_date_guard/);
  assert.match(worker, /import \{ handleWeekendVisit \} from '\.\/weekend-visit\.js'/);
  assert.match(worker, /url\.pathname === '\/weekend-visit'/);
  assert.match(readme, /050_weekend_actual_visits\.sql[\s\S]*058_weekend_visit_source_date\.sql[\s\S]*059_weekend_multi_visits\.sql[\s\S]*Worker[\s\S]*task Pages/);
});

test('059 preserves legacy visits and events while assigning sequence one', () => {
  const db = new D1Database({ multiVisit: false });
  const at = Date.parse('2026-08-22T10:00:00+09:00');
  const visitId = 'wv_' + 'a'.repeat(32);
  const eventId = 'wve_' + 'b'.repeat(32);
  db.sqlite.prepare(
    'INSERT INTO weekend_actual_visits ' +
    '(app,visit_id,student_id,lesson_task_id,staff_id,visit_date,check_in_at,check_out_at,status,revision,' +
    'created_at,updated_at,created_by,updated_by,source_date) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run('task', visitId, 'student-a', 'lesson-a', 'teacher-1', '2026-08-22', at, at + 3600000,
    'completed', 2, at, at + 3600000, 'teacher-1', 'teacher-1', '2026-08-23');
  db.sqlite.prepare(
    'INSERT INTO weekend_actual_visit_events (app,event_id,visit_id,event_type,event_data,actor_id,created_at) ' +
    'VALUES (?,?,?,?,?,?,?)'
  ).run('task', eventId, visitId, 'check_in', '{"version":1}', 'teacher-1', at);

  db.sqlite.exec('BEGIN;\n' + multiVisitMigration + '\nCOMMIT;');

  const row = db.sqlite.prepare('SELECT * FROM weekend_actual_visits WHERE visit_id=?').get(visitId);
  assert.equal(row.visit_sequence, 1);
  assert.equal(row.source_date, '2026-08-23');
  assert.equal(row.status, 'completed');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) count FROM weekend_actual_visit_events').get().count, 1);
  assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  assert.throws(() => db.sqlite.prepare(
    'UPDATE weekend_actual_visits SET visit_sequence=2,revision=3,updated_at=? WHERE app=? AND visit_id=?'
  ).run(at + 3600001, 'task', visitId), /WEEKEND_VISIT_IMMUTABLE/);
  assert.throws(() => db.sqlite.prepare('DELETE FROM weekend_actual_visits WHERE visit_id=?').run(visitId),
    /WEEKEND_VISIT_NO_DELETE/);
  assert.throws(() => db.sqlite.prepare(
    'INSERT INTO weekend_actual_visits ' +
    '(app,visit_id,student_id,lesson_task_id,staff_id,visit_date,source_date,visit_sequence,check_in_at,check_out_at,status,' +
    'revision,created_at,updated_at,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run('task', 'wv_' + 'c'.repeat(32), 'student-a', 'lesson-a', 'teacher-1', '2026-08-23', '2026-08-23', 1,
    at + 86400000, null, 'active', 1, at + 86400000, at + 86400000, 'teacher-1', 'teacher-1'),
  /WEEKEND_SOURCE_DATE_ALREADY_LINKED/);
  db.sqlite.prepare(
    'INSERT INTO weekend_actual_visits ' +
    '(app,visit_id,student_id,lesson_task_id,staff_id,visit_date,source_date,visit_sequence,check_in_at,check_out_at,status,' +
    'revision,created_at,updated_at,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run('task', 'wv_' + 'd'.repeat(32), 'student-a', 'lesson-a', 'teacher-1', '2026-08-22', '2026-08-23', 2,
    at + 7200000, at + 10800000, 'completed', 1, at + 7200000, at + 10800000, 'teacher-1', 'teacher-1');
  assert.throws(() => db.sqlite.prepare(
    'UPDATE weekend_actual_visits SET check_out_at=?,revision=3,updated_at=? WHERE app=? AND visit_id=?'
  ).run(at + 9000000, at + 10800001, 'task', visitId), /WEEKEND_VISIT_TIME_OVERLAP/);
});

test('all subjects qualify and a Sunday timetable may check in on Saturday', async () => {
  assert.equal(weekendVisitInternals.hasWeekendSchedule({ subject: '임의과목', scheduleSlots: [{ days: [0] }] }), true);
  const db = new D1Database(); db.seed();
  const checked = await atNow(saturday, () => call(db, {
    action: 'check_in', visitDate: '2026-08-22', lessonTaskId: 'lesson-a', studentId: 'student-a'
  }));
  assert.equal(checked.status, 200);
  assert.equal(checked.body.visit.status, 'active');
  assert.equal(checked.body.visit.lessonTaskId, 'lesson-a');
  assert.equal(checked.body.visit.visitDate, '2026-08-22');
  assert.equal(checked.body.visit.sourceDate, '2026-08-23');

  const listed = await call(db, { action: 'list', visitDate: '2026-08-22' });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.visits.length, 1);
  assert.equal(listed.body.visits[0].sourceDate, '2026-08-23');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) count FROM weekend_actual_visit_events').get().count, 1);
});

test('projected makeup lessons cannot be configured or used as recurring weekend visits', async () => {
  const db = new D1Database(); db.seed();
  db.seedTask({
    id: 'makeup_lesson_mu_weekend', staffId: 'teacher-1', studentId: 'student-a', studentName: '학생A',
    title: '[수업] 보강', taskKind: 'lesson_instruction', lessonFormVersion: 1,
    lessonInstanceType: 'makeup', makeupCaseId: 'mu_weekend', repeat: 'once',
    scheduleSlots: [{ days: [6], startTime: '10:00', endTime: '11:00' }],
    start: '2026-08-22', end: '2026-08-22'
  });
  const configured = await atNow(saturday, () => call(db, {
    action: 'configure', taskId: 'makeup_lesson_mu_weekend', studentId: 'student-a', expectedUpdatedAt: 1,
    weekendAttendanceMode: 'flexible', weekendAllowedDays: [6], weekendMonthlyTarget: 1,
    weekendFlexibleFrom: '2026-08-22'
  }, admin));
  assert.equal(configured.status, 409);

  const checked = await atNow(saturday, () => call(db, {
    action: 'check_in', visitDate: '2026-08-22', sourceDate: '2026-08-22',
    lessonTaskId: 'makeup_lesson_mu_weekend', studentId: 'student-a'
  }));
  assert.equal(checked.status, 422);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) count FROM weekend_actual_visits').get().count, 0);
});

test('a completed weekend lesson can check in again with an explicit next visit sequence', async () => {
  const db = new D1Database(); db.seed();
  const first = await atNow(saturday, () => call(db, {
    action: 'check_in', visitDate: '2026-08-22', sourceDate: '2026-08-23', visitSequence: 1,
    lessonTaskId: 'lesson-a', studentId: 'student-a'
  }));
  assert.equal(first.status, 200);
  assert.equal(first.body.visit.visitSequence, 1);

  const whileOpen = await atNow(saturday + 1000, () => call(db, {
    action: 'check_in', visitDate: '2026-08-22', sourceDate: '2026-08-23', visitSequence: 2,
    lessonTaskId: 'lesson-a', studentId: 'student-a'
  }));
  assert.equal(whileOpen.status, 409);
  assert.equal(whileOpen.body.code, 'VISIT_ALREADY_OPEN');

  const firstOut = await atNow(saturday + 3600000, () => call(db, {
    action: 'check_out', visitId: first.body.visit.visitId, revision: first.body.visit.revision
  }));
  assert.equal(firstOut.status, 200);

  const legacyRetry = await atNow(saturday + 3601000, () => call(db, {
    action: 'check_in', visitDate: '2026-08-22', sourceDate: '2026-08-23',
    lessonTaskId: 'lesson-a', studentId: 'student-a'
  }));
  assert.equal(legacyRetry.status, 409);
  assert.equal(legacyRetry.body.code, 'VISIT_ALREADY_COMPLETED');

  const gap = await atNow(saturday + 3602000, () => call(db, {
    action: 'check_in', visitDate: '2026-08-22', sourceDate: '2026-08-23', visitSequence: 3,
    lessonTaskId: 'lesson-a', studentId: 'student-a'
  }));
  assert.equal(gap.status, 409);
  assert.equal(gap.body.code, 'VISIT_SEQUENCE_MISMATCH');
  assert.equal(gap.body.nextVisitSequence, 2);

  const second = await atNow(saturday + 7200000, () => call(db, {
    action: 'check_in', visitDate: '2026-08-22', sourceDate: '2026-08-23', visitSequence: 2,
    lessonTaskId: 'lesson-a', studentId: 'student-a'
  }));
  assert.equal(second.status, 200);
  assert.equal(second.body.visit.visitSequence, 2);
  assert.notEqual(second.body.visit.visitId, first.body.visit.visitId);

  const activeRetry = await atNow(saturday + 7201000, () => call(db, {
    action: 'check_in', visitDate: '2026-08-22', sourceDate: '2026-08-23', visitSequence: 2,
    lessonTaskId: 'lesson-a', studentId: 'student-a'
  }));
  assert.equal(activeRetry.status, 200);
  assert.equal(activeRetry.body.idempotent, true);
  assert.equal(activeRetry.body.visit.visitId, second.body.visit.visitId);

  const secondOut = await atNow(saturday + 10800000, () => call(db, {
    action: 'check_out', visitId: second.body.visit.visitId, revision: second.body.visit.revision
  }));
  assert.equal(secondOut.status, 200);

  const completedRetry = await atNow(saturday + 10801000, () => call(db, {
    action: 'check_in', visitDate: '2026-08-22', sourceDate: '2026-08-23', visitSequence: 2,
    lessonTaskId: 'lesson-a', studentId: 'student-a'
  }));
  assert.equal(completedRetry.status, 409);
  assert.equal(completedRetry.body.code, 'VISIT_ALREADY_COMPLETED');

  const overlapCorrection = await atNow(saturday + 10802000, () => call(db, {
    action: 'correct', visitId: first.body.visit.visitId, revision: firstOut.body.visit.revision,
    checkInAt: saturday, checkOutAt: saturday + 9000000, reason: '두 번째 방문 시간과 겹치는 잘못된 정정'
  }, admin));
  assert.equal(overlapCorrection.status, 409);
  assert.equal(overlapCorrection.body.code, 'VISIT_TIME_OVERLAP');

  const listed = await call(db, { action: 'list', visitDate: '2026-08-22' });
  assert.deepEqual(listed.body.visits.map(row => row.visitSequence), [1, 2]);
  assert.deepEqual(listed.body.nextVisitSequences, [{
    lessonTaskId: 'lesson-a', studentId: 'student-a', visitDate: '2026-08-22', next: 3
  }]);
  assert.equal(listed.body.monthlyCounts[0].count, 1, '같은 날 복수 방문은 월 회차를 중복 차감하지 않는다');
});

test('one source lesson cannot be linked to both weekend dates', async () => {
  const db = new D1Database(); db.seed();
  const first = await atNow(saturday, () => call(db, {
    action: 'check_in', visitDate: '2026-08-22', sourceDate: '2026-08-23', visitSequence: 1,
    lessonTaskId: 'lesson-a', studentId: 'student-a'
  }));
  assert.equal(first.status, 200);
  const firstOut = await atNow(saturday + 3600000, () => call(db, {
    action: 'check_out', visitId: first.body.visit.visitId, revision: first.body.visit.revision
  }));
  assert.equal(firstOut.status, 200);

  const sunday = Date.parse('2026-08-23T10:00:00+09:00');
  const split = await atNow(sunday, () => call(db, {
    action: 'check_in', visitDate: '2026-08-23', sourceDate: '2026-08-23', visitSequence: 1,
    lessonTaskId: 'lesson-a', studentId: 'student-a'
  }));
  assert.equal(split.status, 409);
  assert.equal(split.body.code, 'SOURCE_DATE_ALREADY_LINKED');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) count FROM weekend_actual_visits').get().count, 1);
});

test('explicit sourceDate is schedule-validated and legacy derivation prioritizes the actual scheduled day', async () => {
  const explicitDb = new D1Database(); explicitDb.seed();
  const explicit = await atNow(saturday, () => call(explicitDb, {
    action: 'check_in', visitDate: '2026-08-22', sourceDate: '2026-08-23',
    lessonTaskId: 'lesson-a', studentId: 'student-a'
  }));
  assert.equal(explicit.status, 200);
  assert.equal(explicit.body.visit.sourceDate, '2026-08-23');
  assert.equal(explicitDb.sqlite.prepare(
    "SELECT source_date FROM weekend_actual_visits WHERE app='task' AND lesson_task_id='lesson-a'"
  ).get().source_date, '2026-08-23');

  for (const sourceDate of ['2026-08-22', '2026-08-24', '', 'not-a-date']) {
    const invalidDb = new D1Database(); invalidDb.seed();
    const invalid = await atNow(saturday, () => call(invalidDb, {
      action: 'check_in', visitDate: '2026-08-22', sourceDate,
      lessonTaskId: 'lesson-a', studentId: 'student-a'
    }));
    assert.equal(invalid.status, 422, sourceDate);
    assert.equal(invalid.body.code, 'SOURCE_DATE_INVALID', sourceDate);
  }

  const actualPriorityDb = new D1Database(); actualPriorityDb.seed();
  const row = actualPriorityDb.sqlite.prepare(
    "SELECT data FROM tasks WHERE app='task' AND id='lesson-a'"
  ).get();
  const task = JSON.parse(row.data);
  task.scheduleSlots[0].days = [0, 6];
  actualPriorityDb.sqlite.prepare("UPDATE tasks SET data=? WHERE app='task' AND id='lesson-a'")
    .run(JSON.stringify(task));
  const derived = await atNow(saturday, () => call(actualPriorityDb, {
    action: 'check_in', visitDate: '2026-08-22', lessonTaskId: 'lesson-a', studentId: 'student-a'
  }));
  assert.equal(derived.status, 200);
  assert.equal(derived.body.visit.sourceDate, '2026-08-22');
});

test('sourceDate is nullable for legacy rows but immutable after creation', () => {
  const db = new D1Database();
  const at = Date.parse('2026-08-22T10:00:00+09:00');
  db.sqlite.prepare(
    'INSERT INTO weekend_actual_visits ' +
    '(app,visit_id,student_id,lesson_task_id,staff_id,visit_date,source_date,check_in_at,check_out_at,status,revision,' +
    'created_at,updated_at,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run('task', 'wv_' + '9'.repeat(32), 'student-a', 'lesson-a', 'teacher-1', '2026-08-22', null,
    at, null, 'active', 1, at, at, 'teacher-1', 'teacher-1');
  assert.equal(db.sqlite.prepare('SELECT source_date FROM weekend_actual_visits').get().source_date, null);
  assert.throws(() => db.sqlite.prepare(
    'UPDATE weekend_actual_visits SET source_date=?,revision=2,updated_at=? WHERE app=? AND visit_id=?'
  ).run('2026-08-23', at + 1, 'task', 'wv_' + '9'.repeat(32)), /WEEKEND_VISIT_IMMUTABLE/);
});

test('a future flexible effective date keeps the existing weekend check-in path active', async () => {
  const db = new D1Database(); db.seed();
  const configured = await atNow(saturday, () => call(db, {
    action: 'configure', taskId: 'lesson-a', studentId: 'student-a', expectedUpdatedAt: 1,
    weekendAttendanceMode: 'flexible', weekendAllowedDays: [0], weekendMonthlyTarget: 2,
    weekendFlexibleFrom: '2026-08-23'
  }, admin));
  assert.equal(configured.status, 200);
  const checked = await atNow(saturday, () => call(db, {
    action: 'check_in', visitDate: '2026-08-22', lessonTaskId: 'lesson-a', studentId: 'student-a'
  }));
  assert.equal(checked.status, 200);
  assert.equal(checked.body.visit.status, 'active');
});

test('admin configures a flexible assignment with stable ids, CAS, and an append-only audit event', async () => {
  const db = new D1Database(); db.seed();
  const configured = await atNow(saturday, () => call(db, {
    action: 'configure', taskId: 'lesson-a', studentId: 'student-a', expectedUpdatedAt: 1,
    weekendAttendanceMode: 'flexible', weekendAllowedDays: [0], weekendMonthlyTarget: 2,
    weekendFlexibleFrom: '2026-08-22'
  }, admin));
  assert.equal(configured.status, 200);
  assert.equal(configured.body.task.id, 'lesson-a');
  assert.equal(configured.body.task.studentId, 'student-a');
  assert.equal(configured.body.updatedAt, configured.body.task.updatedAt);
  assert.deepEqual(configured.body.config, {
    mode: 'flexible', allowedDays: [0], monthlyTarget: 2, flexibleFrom: '2026-08-22'
  });
  const stored = JSON.parse(db.sqlite.prepare("SELECT data FROM tasks WHERE app='task' AND id='lesson-a'").get().data);
  assert.equal(stored.weekendAttendanceMode, 'flexible');
  assert.deepEqual(stored.weekendAllowedDays, [0]);
  assert.equal(stored.weekendMonthlyTarget, 2);
  assert.equal(stored.weekendFlexibleFrom, '2026-08-22');
  assert.equal(stored.lastEditBy, 'manager');
  const audit = db.sqlite.prepare(
    "SELECT event_type,changed_fields,effective_date,changed_by FROM student_change_events WHERE app='task' AND task_id='lesson-a'"
  ).get();
  assert.equal(audit.event_type, 'work_instruction');
  assert.deepEqual(JSON.parse(audit.changed_fields), [
    'weekendAttendanceMode', 'weekendAllowedDays', 'weekendMonthlyTarget', 'weekendFlexibleFrom'
  ]);
  assert.equal(audit.effective_date, '2026-08-22');
  assert.equal(audit.changed_by, 'manager:manager-1');

  const exactRetry = await call(db, {
    action: 'configure', taskId: 'lesson-a', studentId: 'student-a', expectedUpdatedAt: configured.body.updatedAt,
    weekendAttendanceMode: 'flexible', weekendAllowedDays: [0], weekendMonthlyTarget: 2,
    weekendFlexibleFrom: '2026-08-22'
  }, admin);
  assert.equal(exactRetry.status, 200);
  assert.equal(exactRetry.body.idempotent, true);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) count FROM student_change_events WHERE task_id='lesson-a'").get().count, 1);

  const stale = await call(db, {
    action: 'configure', taskId: 'lesson-a', studentId: 'student-a', expectedUpdatedAt: 1,
    weekendAttendanceMode: 'fixed', weekendAllowedDays: [], weekendMonthlyTarget: null, weekendFlexibleFrom: ''
  }, admin);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'WEEKEND_CONFIG_STALE');
});

test('flexible configuration is admin-only and fails closed on forged ids or invalid policy values', async () => {
  const db = new D1Database(); db.seed();
  const base = {
    action: 'configure', taskId: 'lesson-a', studentId: 'student-a', expectedUpdatedAt: 1,
    weekendAttendanceMode: 'flexible', weekendAllowedDays: [0, 6], weekendMonthlyTarget: null,
    weekendFlexibleFrom: '2026-08-22'
  };
  assert.equal((await call(db, base, own)).status, 403);
  assert.equal((await call(db, { ...base, studentId: 'student-b' }, admin)).status, 409);
  assert.equal((await call(db, { ...base, weekendAllowedDays: [1] }, admin)).status, 422);
  assert.equal((await call(db, { ...base, weekendAllowedDays: ['0'] }, admin)).status, 422);
  assert.equal((await call(db, { ...base, weekendMonthlyTarget: 0 }, admin)).status, 422);
  assert.equal((await call(db, { ...base, weekendMonthlyTarget: '2' }, admin)).status, 422);
  assert.equal((await call(db, { ...base, weekendFlexibleFrom: '2026-07-01' }, admin)).status, 422);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) count FROM student_change_events').get().count, 0);
});

test('configure CAS rolls back its audit event when the lesson changes after verification', async () => {
  const db = new D1Database(); db.seed();
  db.beforeBatch = async () => {
    const row = db.sqlite.prepare("SELECT data FROM tasks WHERE app='task' AND id='lesson-a'").get();
    const task = JSON.parse(row.data);
    task.updatedAt = 2;
    task.materials = '다른 관리자 수정';
    db.sqlite.prepare("UPDATE tasks SET data=?,updated_at=2,srv_at=2 WHERE app='task' AND id='lesson-a'")
      .run(JSON.stringify(task));
  };
  const result = await atNow(saturday, () => call(db, {
    action: 'configure', taskId: 'lesson-a', studentId: 'student-a', expectedUpdatedAt: 1,
    weekendAttendanceMode: 'flexible', weekendAllowedDays: [0], weekendMonthlyTarget: 2,
    weekendFlexibleFrom: '2026-08-22'
  }, admin));
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'WEEKEND_CONFIG_STALE');
  const stored = JSON.parse(db.sqlite.prepare("SELECT data FROM tasks WHERE app='task' AND id='lesson-a'").get().data);
  assert.equal(stored.materials, '다른 관리자 수정');
  assert.equal(stored.weekendAttendanceMode, undefined);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) count FROM student_change_events').get().count, 0);
});

test('flexible check-in honors its allowed weekday and effective date while fixed cross-weekend behavior remains', async () => {
  const db = new D1Database(); db.seed();
  const configured = await atNow(saturday, () => call(db, {
    action: 'configure', taskId: 'lesson-a', studentId: 'student-a', expectedUpdatedAt: 1,
    weekendAttendanceMode: 'flexible', weekendAllowedDays: [0], weekendMonthlyTarget: 2,
    weekendFlexibleFrom: '2026-08-22'
  }, admin));
  assert.equal(configured.status, 200);
  const saturdayDenied = await atNow(saturday, () => call(db, {
    action: 'check_in', visitDate: '2026-08-22', lessonTaskId: 'lesson-a', studentId: 'student-a'
  }));
  assert.equal(saturdayDenied.status, 422);
  const sunday = Date.parse('2026-08-23T10:00:00+09:00');
  const sundayAllowed = await atNow(sunday, () => call(db, {
    action: 'check_in', visitDate: '2026-08-23', lessonTaskId: 'lesson-a', studentId: 'student-a'
  }));
  assert.equal(sundayAllowed.status, 200);
  assert.equal(sundayAllowed.body.visit.lessonTaskId, 'lesson-a');
});

test('list returns non-cancelled monthly visit counts in the current teacher scope', async () => {
  const db = new D1Database(); db.seed();
  const insert = db.sqlite.prepare(
    'INSERT INTO weekend_actual_visits (app,visit_id,student_id,lesson_task_id,staff_id,visit_date,check_in_at,check_out_at,status,revision,created_at,updated_at,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  );
  const rows = [
    ['wv_' + '1'.repeat(32), 'student-a', 'lesson-a', 'teacher-1', '2026-08-02', 'completed'],
    ['wv_' + '2'.repeat(32), 'student-a', 'lesson-a', 'teacher-1', '2026-08-09', 'active'],
    ['wv_' + '3'.repeat(32), 'student-a', 'lesson-a', 'teacher-1', '2026-08-16', 'cancelled'],
    ['wv_' + '4'.repeat(32), 'student-b', 'lesson-b', 'teacher-2', '2026-08-08', 'completed']
  ];
  rows.forEach((row, index) => {
    const at = Date.parse(row[4] + 'T10:00:00+09:00') + index;
    insert.run('task', row[0], row[1], row[2], row[3], row[4], at,
      row[5] === 'completed' ? at + 3600000 : null, row[5], 1, at, at, row[3], row[3]);
  });
  const listed = await call(db, { action: 'list', visitDate: '2026-08-22' }, own);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.monthlyCounts, [
    { lessonTaskId: 'lesson-a', studentId: 'student-a', month: '2026-08', count: 2 }
  ]);
});

test('checkout and correction use CAS and keep append-only events', async () => {
  const db = new D1Database(); db.seed();
  const checked = await atNow(saturday, () => call(db, {
    action: 'check_in', visitDate: '2026-08-22', lessonTaskId: 'lesson-a', studentId: 'student-a'
  }));
  const visit = checked.body.visit;
  const outAt = Date.parse('2026-08-22T12:10:00+09:00');
  const checkedOut = await atNow(outAt, () => call(db, {
    action: 'check_out', visitId: visit.visitId, revision: visit.revision
  }));
  assert.equal(checkedOut.status, 200);
  assert.equal(checkedOut.body.visit.status, 'completed');

  const corrected = await atNow(outAt, () => call(db, {
    action: 'correct', visitId: visit.visitId, revision: checkedOut.body.visit.revision,
    checkInAt: Date.parse('2026-08-22T09:55:00+09:00'),
    checkOutAt: Date.parse('2026-08-22T12:05:00+09:00'), reason: '버튼 입력 시간 정정'
  }, admin));
  assert.equal(corrected.status, 200);
  assert.equal(corrected.body.visit.revision, 3);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) count FROM weekend_actual_visit_events').get().count, 3);

  const stale = await call(db, {
    action: 'cancel', visitId: visit.visitId, revision: 1, reason: '오래 열린 화면'
  }, admin);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'VISIT_STALE');
});

test('weekday, another teacher, and an unlinked student fail closed', async () => {
  const weekdayDb = new D1Database(); weekdayDb.seed();
  const weekday = await atNow(Date.parse('2026-08-24T10:00:00+09:00'), () => call(weekdayDb, {
    action: 'check_in', visitDate: '2026-08-24', lessonTaskId: 'lesson-a', studentId: 'student-a'
  }));
  assert.equal(weekday.status, 422);

  const otherDb = new D1Database(); otherDb.seed();
  const other = await atNow(saturday, () => call(otherDb, {
    action: 'check_in', visitDate: '2026-08-22', lessonTaskId: 'lesson-b', studentId: 'student-b'
  }));
  assert.equal(other.status, 422);

  const forgedDb = new D1Database(); forgedDb.seed();
  const forged = await atNow(saturday, () => call(forgedDb, {
    action: 'check_in', visitDate: '2026-08-22', lessonTaskId: 'lesson-a', studentId: 'student-b'
  }, admin));
  assert.equal(forged.status, 422);
  assert.equal(forgedDb.sqlite.prepare('SELECT COUNT(*) count FROM weekend_actual_visits').get().count, 0);
});

test('a transferred lesson moves open-visit access to the current exact teacher while preserving audit staff', async () => {
  const db = new D1Database(); db.seed();
  const checked = await atNow(saturday, () => call(db, {
    action: 'check_in', visitDate: '2026-08-22', lessonTaskId: 'lesson-a', studentId: 'student-a'
  }));
  transferLesson(db, 'lesson-a', 'teacher-2');

  const oldList = await call(db, { action: 'list', visitDate: '2026-08-22' }, own);
  const newList = await call(db, { action: 'list', visitDate: '2026-08-22' }, nextTeacher);
  assert.equal(oldList.body.visits.length, 0);
  assert.equal(newList.body.visits.length, 1);
  assert.equal(newList.body.visits[0].staffId, 'teacher-1', '저장 당시 담당자는 감사 필드로 보존한다');

  const denied = await atNow(Date.parse('2026-08-22T12:10:00+09:00'), () => call(db, {
    action: 'check_out', visitId: checked.body.visit.visitId, revision: checked.body.visit.revision
  }, own));
  assert.equal(denied.status, 422);

  const checkedOut = await atNow(Date.parse('2026-08-22T12:10:00+09:00'), () => call(db, {
    action: 'check_out', visitId: checked.body.visit.visitId, revision: checked.body.visit.revision
  }, nextTeacher));
  assert.equal(checkedOut.status, 200);
  const corrected = await atNow(Date.parse('2026-08-22T12:20:00+09:00'), () => call(db, {
    action: 'correct', visitId: checked.body.visit.visitId, revision: checkedOut.body.visit.revision,
    checkInAt: Date.parse('2026-08-22T09:55:00+09:00'),
    checkOutAt: Date.parse('2026-08-22T12:05:00+09:00'), reason: '새 담당자 실제 시간 정정'
  }, nextTeacher));
  assert.equal(corrected.status, 200);
  const oldCancel = await atNow(Date.parse('2026-08-22T12:30:00+09:00'), () => call(db, {
    action: 'cancel', visitId: checked.body.visit.visitId, revision: corrected.body.visit.revision, reason: '구 담당자 취소 시도'
  }, own));
  assert.equal(oldCancel.status, 422);
});

test('check-in atomically rejects a lesson transfer after authorization but before insert', async () => {
  const db = new D1Database(); db.seed();
  db.beforeVisitInsert = async () => transferLesson(db, 'lesson-a', 'teacher-2');
  const result = await atNow(saturday, () => call(db, {
    action: 'check_in', visitDate: '2026-08-22', lessonTaskId: 'lesson-a', studentId: 'student-a'
  }, own));

  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'VISIT_CONFLICT');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) count FROM weekend_actual_visits').get().count, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) count FROM weekend_actual_visit_events').get().count, 0);
});
