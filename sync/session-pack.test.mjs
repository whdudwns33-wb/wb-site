import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { handleScheduledSessionPackAttendance, handleSessionPack } from './session-pack.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const makeupMigration = fs.readFileSync(new URL('./migrations/025_makeup.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/026_session_packs.sql', import.meta.url), 'utf8');
const workerEntry = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('./wrangler.toml', import.meta.url), 'utf8');
const admin = { scope: 'all' };
const own = id => ({ scope: 'own', id });
const manager = id => ({ scope: 'all', id, role: 'manager' });
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' }
});

async function withNow(value, action) {
  const original = Date.now;
  Date.now = () => value;
  try { return await action(); } finally { Date.now = original; }
}

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  first() { return this.db.prepare(this.sql).get(...this.args) || null; }
  all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  run() { const result = this.db.prepare(this.sql).run(...this.args); return { meta: { changes: Number(result.changes || 0) } }; }
}

class TestD1 {
  constructor() {
    this.database = new DatabaseSync(':memory:');
    this.database.exec(schema);
    this.database.exec(makeupMigration);
    this.database.exec(migration);
  }
  prepare(sql) { return new Statement(this.database, sql); }
}

function student(id, teacherId, start = '2026-01') {
  return {
    id, name: '동명이학생', grade: '초2', teacher: teacherId, subject: '독해', start, end: '', reason: '',
    teacherIds: [teacherId]
  };
}

function lesson(id, studentId, teacherId, start = '2026-01-01') {
  return {
    id, staffId: teacherId, studentId, studentName: '동명이학생', grade: '초2', subject: '국어', className: '독해력',
    lessonRole: '독해력', taskKind: 'lesson_instruction', lessonFormVersion: 1,
    lessonAssignmentKey: 'sha256:' + id, start, end: '', repeat: 'daily', days: [], deleted: false,
    studentTraits: '응답에 노출되면 안 되는 내부 관찰', parentRequest: '응답에 노출되면 안 되는 보호자 요청'
  };
}

function seed() {
  const db = new TestD1();
  const now = Date.now();
  const students = [
    student('student-a', 'teacher-a'),
    student('student-b', 'teacher-b'),
    student('student-monthly', 'teacher-a'),
    student('student-old', 'teacher-a', '1999-01')
  ];
  const tasks = [
    lesson('lesson-a', 'student-a', 'teacher-a'),
    lesson('lesson-b', 'student-b', 'teacher-b'),
    lesson('lesson-monthly', 'student-monthly', 'teacher-a'),
    lesson('lesson-old', 'student-old', 'teacher-a', '1999-01-01')
  ];
  for (const id of ['teacher-a', 'teacher-b']) {
    db.prepare('INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
      .bind('task', id, id, JSON.stringify({ id, name: id, deleted: false }), now, now).run();
  }
  for (const task of tasks) {
    db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
      .bind('task', task.id, task.staffId, JSON.stringify(task), now, now).run();
  }
  db.prepare('INSERT INTO private_rosters(app,data,updated_at) VALUES(?,?,?)').bind('task', JSON.stringify({
    roster: { updated: '2026-08-11', baseline: '2026-08', students }, bookStudents: []
  }), now).run();
  return db;
}

async function call(db, body, auth = admin) {
  const response = await handleSessionPack({ DB: db }, 'task', body, '*', auth, json);
  return { status: response.status, body: await response.json() };
}

async function create(db, overrides = {}, auth = admin) {
  return await call(db, {
    action: 'create', studentId: 'student-a', lessonTaskId: 'lesson-a', totalSessions: 8,
    validFrom: '2026-08-01', expiresOn: '2026-12-31', deductionPolicy: 'recommended_v1', ...overrides
  }, auth);
}

function putCheck(db, taskId, ownerId, date, att, absenceType) {
  const data = { taskId, date, att };
  if (absenceType) data.absenceType = absenceType;
  db.prepare('INSERT INTO checks(app,k,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', taskId + '|' + date, ownerId, JSON.stringify(data), Date.now(), Date.now()).run();
}

function makeFlexible(db, taskId = 'lesson-a') {
  const row = db.database.prepare('SELECT data FROM tasks WHERE app=? AND id=?').get('task', taskId);
  const task = JSON.parse(row.data);
  Object.assign(task, {
    repeat: 'days', days: [6], weekendAttendanceMode: 'flexible', weekendAllowedDays: [0],
    weekendMonthlyTarget: 2, weekendFlexibleFrom: '2026-08-01'
  });
  db.prepare('UPDATE tasks SET data=? WHERE app=? AND id=?').bind(JSON.stringify(task), 'task', taskId).run();
}

function putWeekendVisit(db, date, status = 'completed', studentId = 'student-a', taskId = 'lesson-a') {
  const now = Date.parse(date + 'T01:00:00Z');
  db.prepare(
    'INSERT INTO weekend_actual_visits ' +
    '(app,visit_id,student_id,lesson_task_id,staff_id,visit_date,check_in_at,check_out_at,status,revision,' +
    'created_at,updated_at,created_by,updated_by) VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?,?)'
  ).bind('task', 'wv_' + 'a'.repeat(32), studentId, taskId, 'teacher-a', date, now,
    status === 'active' ? null : now + 3600000, status, now, now, 'teacher-a', 'teacher-a').run();
}

async function hash(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function group(taskId, date) {
  return 'mc_' + (await hash('task\n' + taskId + '\n' + date)).slice(0, 48);
}

async function caseId(taskId, date) {
  return 'mu_' + (await hash('task\n' + taskId + '\n' + date)).slice(0, 48);
}

async function record(db, pack, taskId, date, auth = own('teacher-a'), extra = {}) {
  return await call(db, {
    action: 'record', packId: pack.packId, revision: pack.revision, sourceType: 'regular',
    sourceKey: taskId + '|' + date, consumptionGroupId: await group(taskId, date), ...extra
  }, auth);
}

test('migration is additive, append-only, and stores no name, contact, payment, or free memo', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS session_packs/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS session_pack_usage/);
  assert.match(migration, /SESSION_PACK_LEDGER_APPEND_ONLY/);
  assert.match(migration, /idx_session_pack_usage_one_consumption/);
  assert.match(migration, /lesson_assignment_key/);
  assert.match(migration, /SESSION_PACK_IDENTITY_MISMATCH/);
  assert.doesNotMatch(migration, /DROP TABLE|DELETE FROM/i);
  const definitions = migration.match(/CREATE TABLE IF NOT EXISTS session_(?:packs|pack_usage)\s*\([\s\S]*?\);/g).join('\n');
  assert.doesNotMatch(definitions, /student_name|phone|contact|address|price|payment|amount|fee|receipt|memo|note/i);
});

test('monthly is the default with no row; only all scope creates and own list is assignment-scoped', async () => {
  const db = seed();
  assert.equal((await call(db, { action: 'list' }, null)).status, 401);
  assert.deepEqual((await call(db, { action: 'list' }, own('teacher-a'))).body.packs, []);
  assert.equal((await create(db, {}, own('teacher-a'))).status, 403);
  const made = await create(db);
  assert.equal(made.status, 200);
  assert.equal(made.body.pack.remainingSessions, 8);
  assert.equal((await call(db, { action: 'list' }, own('teacher-a'))).body.packs.length, 1);
  assert.equal((await call(db, { action: 'list' }, own('teacher-b'))).body.packs.length, 0);
  assert.equal((await call(db, { action: 'list', studentId: 'student-monthly' }, admin)).body.packs.length, 0);
});

test('a projected one-time makeup lesson cannot become a separate session pack assignment', async () => {
  const db = seed();
  const task = lesson('makeup_lesson_mu_pack', 'student-a', 'teacher-a', '2026-08-30');
  Object.assign(task, {
    lessonInstanceType: 'makeup', makeupCaseId: 'mu_pack', repeat: 'once', end: '2026-08-30'
  });
  db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', task.id, task.staffId, JSON.stringify(task), Date.now(), Date.now()).run();
  const result = await create(db, {
    lessonTaskId: task.id, validFrom: '2026-08-30', expiresOn: '2026-08-30'
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'TASK_IDENTITY_MISMATCH');
  assert.equal(db.database.prepare('SELECT COUNT(*) count FROM session_packs WHERE lesson_task_id=?')
    .get(task.id).count, 0);
});

test('same-name students remain separate by stable student and lesson IDs', async () => {
  const db = seed();
  const first = await create(db);
  const second = await create(db, { studentId: 'student-b', lessonTaskId: 'lesson-b' });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.notEqual(first.body.pack.studentId, second.body.pack.studentId);
  putCheck(db, 'lesson-a', 'teacher-a', '2026-08-03', 'P');
  const forbidden = await record(db, first.body.pack, 'lesson-a', '2026-08-03', own('teacher-b'));
  assert.equal(forbidden.status, 403);
});

test('record requires the assigned person even with all scope; root admin adjusts instead', async () => {
  const db = seed();
  const pack = (await create(db)).body.pack;
  putCheck(db, 'lesson-a', 'teacher-a', '2026-08-03', 'P');
  assert.equal((await record(db, pack, 'lesson-a', '2026-08-03', admin)).status, 403);
  assert.equal((await record(db, pack, 'lesson-a', '2026-08-03', { scope: 'all', id: 'teacher-a', role: 'admin' })).status, 403);
  assert.equal((await record(db, pack, 'lesson-a', '2026-08-03', manager('teacher-b'))).status, 403);
  const recorded = await record(db, pack, 'lesson-a', '2026-08-03', manager('teacher-a'));
  assert.equal(recorded.status, 200);
  assert.equal(recorded.body.pack.usedSessions, 1);
  const adjusted = await call(db, {
    action: 'adjust', packId: pack.packId, revision: recorded.body.pack.revision, delta: -1,
    sourceKey: 'admin-correction', reasonCode: 'correction'
  }, admin);
  assert.equal(adjusted.status, 200);
  assert.equal(adjusted.body.pack.usedSessions, 0);
});

test('legacy roster teacherIds do not revoke an exact lesson owner session record', async () => {
  const db = seed();
  const pack = (await create(db)).body.pack;
  const row = db.database.prepare("SELECT data FROM private_rosters WHERE app='task'").get();
  const document = JSON.parse(row.data);
  document.roster.students.find(item => item.id === 'student-a').teacherIds = ['teacher-b'];
  db.prepare("UPDATE private_rosters SET data=? WHERE app='task'").bind(JSON.stringify(document)).run();
  putCheck(db, 'lesson-a', 'teacher-a', '2026-08-03', 'P');
  const recorded = await record(db, pack, 'lesson-a', '2026-08-03', own('teacher-a'));
  assert.equal(recorded.status, 200);
  assert.equal(recorded.body.pack.usedSessions, 1);
});

test('present, late, early leave, and absence policies use actual checks and CAS; duplicate source is idempotent', async () => {
  const db = seed();
  let pack = (await create(db, { totalSessions: 6 })).body.pack;
  putCheck(db, 'lesson-a', 'teacher-a', '2026-08-03', 'P');
  let result = await record(db, pack, 'lesson-a', '2026-08-03');
  assert.equal(result.body.pack.usedSessions, 1);
  assert.equal(result.body.pack.remainingSessions, 5);
  assert.equal(result.body.pack.revision, 2);
  const duplicate = await record(db, pack, 'lesson-a', '2026-08-03');
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.idempotent, true);

  putCheck(db, 'lesson-a', 'teacher-a', '2026-08-04', 'L');
  const stale = await record(db, pack, 'lesson-a', '2026-08-04');
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'REVISION_CONFLICT');
  pack = result.body.pack;
  result = await record(db, pack, 'lesson-a', '2026-08-04');
  assert.equal(result.body.pack.usedSessions, 2);

  pack = result.body.pack;
  putCheck(db, 'lesson-a', 'teacher-a', '2026-08-05', 'E');
  result = await record(db, pack, 'lesson-a', '2026-08-05');
  assert.equal(result.body.pack.usedSessions, 3);
  assert.equal(result.body.pack.usage.at(-1).event, 'present');
  assert.equal(result.body.pack.usage.at(-1).reasonCode, 'early_leave');

  pack = result.body.pack;
  putCheck(db, 'lesson-a', 'teacher-a', '2026-08-06', 'A', 'approved_absence');
  result = await record(db, pack, 'lesson-a', '2026-08-06');
  assert.equal(result.body.pack.usedSessions, 3);
  assert.equal(result.body.pack.usage.at(-1).delta, 0);

  pack = result.body.pack;
  putCheck(db, 'lesson-a', 'teacher-a', '2026-08-07', 'A', 'same_day');
  result = await record(db, pack, 'lesson-a', '2026-08-07');
  assert.equal(result.body.pack.usedSessions, 4);
  assert.equal(result.body.pack.usage.at(-1).event, 'same_day');
});

test('23:50 KST cron records the latest attendance once after teachers can revise it beforehand', async () => {
  const db = seed();
  const pack = (await create(db)).body.pack;
  const sourceDate = new Date(Date.now() + 2 * 86400000 + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  putCheck(db, 'lesson-a', 'teacher-a', sourceDate, 'A', 'same_day');
  const corrected = { taskId: 'lesson-a', date: sourceDate, att: 'P', absenceType: '' };
  db.prepare("UPDATE checks SET data=?,updated_at=updated_at+1,srv_at=srv_at+1 WHERE app='task' AND k=?")
    .bind(JSON.stringify(corrected), 'lesson-a|' + sourceDate).run();

  const scheduledTime = Date.parse(sourceDate + 'T14:50:00Z');
  const first = await handleScheduledSessionPackAttendance({ DB: db }, scheduledTime);
  assert.deepEqual(first, { ok: true, sourceDate, processed: 1, idempotent: 0, skipped: 0, failed: 0 });
  const usage = db.database.prepare(
    "SELECT attendance_event,delta,actor_id,source_date FROM session_pack_usage WHERE app='task' AND pack_id=?"
  ).get(pack.packId);
  assert.deepEqual({ ...usage }, { attendance_event: 'present', delta: 1, actor_id: 'system-session-cutoff', source_date: sourceDate });

  const duplicate = await handleScheduledSessionPackAttendance({ DB: db }, scheduledTime);
  assert.equal(duplicate.processed, 0);
  assert.equal(duplicate.idempotent, 1);
  assert.equal(db.database.prepare("SELECT COUNT(*) count FROM session_pack_usage WHERE app='task'").get().count, 1);
});

test('flexible weekend attendance requires an exact non-cancelled actual visit before session use', async () => {
  const date = '2026-08-30';
  for (const status of [null, 'cancelled', 'completed']) {
    const db = seed();
    makeFlexible(db);
    const pack = (await create(db)).body.pack;
    putCheck(db, 'lesson-a', 'teacher-a', date, 'P');
    if (status) putWeekendVisit(db, date, status);
    if (status === 'completed') {
      const row = db.database.prepare("SELECT data FROM tasks WHERE app='task' AND id='lesson-a'").get();
      const task = JSON.parse(row.data);
      task.weekendAllowedDays = [6];
      db.prepare("UPDATE tasks SET data=? WHERE app='task' AND id='lesson-a'").bind(JSON.stringify(task)).run();
    }
    const result = await record(db, pack, 'lesson-a', date);
    if (status === 'completed') {
      assert.equal(result.status, 200);
      assert.equal(result.body.pack.usedSessions, 1);
    } else {
      assert.equal(result.status, 409);
      assert.equal(result.body.code, 'CHECK_IDENTITY_MISMATCH');
    }
  }
});

test('fixed weekend attendance accepts its recurrence or an exact cross-day actual visit only', async () => {
  const actualDate = '2026-08-30';
  for (const status of [null, 'cancelled', 'completed']) {
    const db = seed();
    const row = db.database.prepare("SELECT data FROM tasks WHERE app='task' AND id='lesson-a'").get();
    const task = JSON.parse(row.data);
    Object.assign(task, { repeat: 'days', days: [6], weekendAttendanceMode: 'fixed' });
    db.prepare("UPDATE tasks SET data=? WHERE app='task' AND id='lesson-a'").bind(JSON.stringify(task)).run();
    const pack = (await create(db)).body.pack;
    putCheck(db, 'lesson-a', 'teacher-a', actualDate, 'P');
    if (status) putWeekendVisit(db, actualDate, status);
    const result = await record(db, pack, 'lesson-a', actualDate);
    if (status === 'completed') {
      assert.equal(result.status, 200);
      assert.equal(result.body.pack.usedSessions, 1);
    } else {
      assert.equal(result.status, 409);
      assert.equal(result.body.code, 'CHECK_IDENTITY_MISMATCH');
    }
  }

  const scheduledAt = Date.parse(actualDate + 'T14:50:00Z');
  const finalized = await withNow(scheduledAt - 60 * 60 * 1000, async () => {
    const scheduledDb = seed();
    const scheduledRow = scheduledDb.database.prepare(
      "SELECT data FROM tasks WHERE app='task' AND id='lesson-a'"
    ).get();
    const scheduledTask = JSON.parse(scheduledRow.data);
    Object.assign(scheduledTask, { repeat: 'days', days: [6], weekendAttendanceMode: 'fixed' });
    scheduledDb.prepare("UPDATE tasks SET data=? WHERE app='task' AND id='lesson-a'")
      .bind(JSON.stringify(scheduledTask)).run();
    await create(scheduledDb);
    putWeekendVisit(scheduledDb, actualDate, 'completed');
    putCheck(scheduledDb, 'lesson-a', 'teacher-a', actualDate, 'P');
    return await handleScheduledSessionPackAttendance({ DB: scheduledDb }, scheduledAt);
  });
  assert.deepEqual(finalized,
    { ok: true, sourceDate: actualDate, processed: 1, idempotent: 0, skipped: 0, failed: 0 });
});

test('a future flexible effective date keeps the existing weekend recurrence until transition', async () => {
  const date = '2026-08-29';
  const db = seed();
  makeFlexible(db);
  const row = db.database.prepare("SELECT data FROM tasks WHERE app='task' AND id='lesson-a'").get();
  const task = JSON.parse(row.data);
  task.weekendFlexibleFrom = '2026-08-30';
  db.prepare("UPDATE tasks SET data=? WHERE app='task' AND id='lesson-a'").bind(JSON.stringify(task)).run();
  const pack = (await create(db)).body.pack;
  putCheck(db, 'lesson-a', 'teacher-a', date, 'P');
  const result = await record(db, pack, 'lesson-a', date);
  assert.equal(result.status, 200);
  assert.equal(result.body.pack.usedSessions, 1);
});

test('23:50 KST cron accepts a flexible Sunday visit even when the reference recurrence is Saturday', async () => {
  const date = '2026-08-30';
  const scheduledAt = Date.parse(date + 'T14:50:00Z');
  const result = await withNow(scheduledAt - 60 * 60 * 1000, async () => {
    const db = seed();
    makeFlexible(db);
    await create(db);
    putWeekendVisit(db, date, 'completed');
    putCheck(db, 'lesson-a', 'teacher-a', date, 'P');
    return await handleScheduledSessionPackAttendance({ DB: db }, scheduledAt);
  });
  assert.deepEqual(result, { ok: true, sourceDate: date, processed: 1, idempotent: 0, skipped: 0, failed: 0 });
});

test('Worker schedules book orders at 20:00 and session attendance finalization at 23:50 KST', () => {
  assert.match(wrangler, /crons\s*=\s*\["0 11 \* \* \*", "50 14 \* \* \*", "\*\/10 \* \* \* \*"\]/);
  assert.match(workerEntry, /controller\.cron === SESSION_PACK_ATTENDANCE_CRON[\s\S]{0,160}handleScheduledSessionPackAttendance/);
  assert.match(workerEntry, /controller\.cron === BOOK_ORDER_CRON[\s\S]{0,160}handleScheduledBookOrders/);
});

test('an absence without a structured policy or a fabricated check fails closed', async () => {
  const db = seed();
  const pack = (await create(db)).body.pack;
  putCheck(db, 'lesson-a', 'teacher-a', '2026-08-03', 'A');
  const undecided = await record(db, pack, 'lesson-a', '2026-08-03');
  assert.equal(undecided.status, 409);
  assert.equal(undecided.body.code, 'ABSENCE_POLICY_REQUIRED');
  const missing = await record(db, pack, 'lesson-a', '2026-08-04');
  assert.equal(missing.status, 409);
  assert.equal(missing.body.code, 'CHECK_NOT_FOUND');
});

test('completed makeup shares one consumption group with its original absence', async () => {
  const db = seed();
  let pack = (await create(db)).body.pack;
  const date = '2026-08-03';
  const consumptionGroupId = await group('lesson-a', date);
  const makeupCaseId = await caseId('lesson-a', date);
  putCheck(db, 'lesson-a', 'teacher-a', date, 'A', 'same_day');
  let result = await record(db, pack, 'lesson-a', date);
  assert.equal(result.body.pack.usedSessions, 1);
  pack = result.body.pack;
  db.prepare(
    'INSERT INTO makeup_cases(app,case_id,student_id,source_task_id,source_date,source_teacher_id,consumption_group_id,' +
    'status,revision,completed_at,completed_by,reason,history,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).bind('task', makeupCaseId, 'student-a', 'lesson-a', date, 'teacher-a', consumptionGroupId,
    'completed', 2, Date.now(), 'teacher-a', null,
    JSON.stringify([{ action: 'create_from_absence', actorId: 'teacher-a', at: Date.now() }]),
    Date.now(), Date.now()).run();
  result = await call(db, {
    action: 'record', packId: pack.packId, revision: pack.revision, sourceType: 'makeup', sourceKey: makeupCaseId,
    checkKey: 'lesson-a|' + date, consumptionGroupId
  }, own('teacher-a'));
  assert.equal(result.status, 200);
  assert.equal(result.body.pack.usedSessions, 1);
  assert.equal(result.body.pack.usage.at(-1).event, 'makeup_completed');
  assert.equal(result.body.pack.usage.at(-1).delta, 0);
  const duplicate = await call(db, {
    action: 'record', packId: pack.packId, revision: pack.revision, sourceType: 'makeup', sourceKey: makeupCaseId,
    checkKey: 'lesson-a|' + date, consumptionGroupId
  }, own('teacher-a'));
  assert.equal(duplicate.body.idempotent, true);
});

test('only canonical absence/manual-absence origins can charge; exam, other, invalid, and unknown origins fail closed', async () => {
  const db = seed();
  let pack = (await create(db)).body.pack;
  const date = '2026-08-05';
  const consumptionGroupId = await group('lesson-a', date);
  const makeupCaseId = await caseId('lesson-a', date);
  const now = Date.now();
  db.prepare(
    'INSERT INTO makeup_cases(app,case_id,student_id,source_task_id,source_date,source_teacher_id,consumption_group_id,' +
    'status,revision,completed_at,completed_by,reason,history,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).bind('task', makeupCaseId, 'student-a', 'lesson-a', date, 'teacher-a', consumptionGroupId,
    'completed', 2, now, 'teacher-a', null,
    JSON.stringify([{ action: 'create_manual', reason: 'manual_absence', actorId: 'teacher-a', actorScope: 'own', at: now }]),
    now, now).run();
  let result = await call(db, {
    action: 'record', packId: pack.packId, revision: pack.revision, sourceType: 'makeup', sourceKey: makeupCaseId,
    consumptionGroupId
  }, own('teacher-a'));
  assert.equal(result.status, 200);
  assert.equal(result.body.pack.usedSessions, 1);
  pack = result.body.pack;
  const duplicate = await call(db, {
    action: 'record', packId: pack.packId, revision: pack.revision, sourceType: 'makeup', sourceKey: makeupCaseId,
    consumptionGroupId
  }, own('teacher-a'));
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.idempotent, true);

  for (const [index, reason] of ['manual_exam', 'manual_other'].entries()) {
    const blockedDate = '2026-08-' + String(6 + index).padStart(2, '0');
    const blockedGroup = await group('lesson-a', blockedDate);
    const blockedCase = await caseId('lesson-a', blockedDate);
    db.prepare(
      'INSERT INTO makeup_cases(app,case_id,student_id,source_task_id,source_date,source_teacher_id,consumption_group_id,' +
      'status,revision,completed_at,completed_by,reason,history,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind('task', blockedCase, 'student-a', 'lesson-a', blockedDate, 'teacher-a', blockedGroup,
      'completed', 2, now, 'teacher-a', null,
      JSON.stringify([{ action: 'create_manual', reason, actorId: 'teacher-a', actorScope: 'own', at: now }]),
      now, now).run();
    const blocked = await call(db, {
      action: 'record', packId: pack.packId, revision: pack.revision, sourceType: 'makeup', sourceKey: blockedCase,
      consumptionGroupId: blockedGroup
    }, own('teacher-a'));
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'MANUAL_MAKEUP_NO_CHARGE');
  }
  for (const [index, history] of [
    [{ action: 'create_manual', reason: 'tampered_type', actorId: 'teacher-a', at: now }],
    { action: 'create_from_absence', actorId: 'teacher-a', at: now }
  ].entries()) {
    const blockedDate = '2026-08-' + String(8 + index).padStart(2, '0');
    const blockedGroup = await group('lesson-a', blockedDate);
    const blockedCase = await caseId('lesson-a', blockedDate);
    db.prepare(
      'INSERT INTO makeup_cases(app,case_id,student_id,source_task_id,source_date,source_teacher_id,consumption_group_id,' +
      'status,revision,completed_at,completed_by,reason,history,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind('task', blockedCase, 'student-a', 'lesson-a', blockedDate, 'teacher-a', blockedGroup,
      'completed', 2, now, 'teacher-a', null, JSON.stringify(history), now, now).run();
    const blocked = await call(db, {
      action: 'record', packId: pack.packId, revision: pack.revision, sourceType: 'makeup', sourceKey: blockedCase,
      consumptionGroupId: blockedGroup
    }, own('teacher-a'));
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, index === 0 ? 'MANUAL_MAKEUP_NO_CHARGE' : 'MAKEUP_ORIGIN_NO_CHARGE');
  }
  assert.equal(db.database.prepare('SELECT count(*) AS n FROM session_pack_usage').get().n, 1);
});

test('approved absence consumes once when its completed makeup is recorded', async () => {
  const db = seed();
  let pack = (await create(db)).body.pack;
  const date = '2026-08-03';
  const consumptionGroupId = await group('lesson-a', date);
  const makeupCaseId = await caseId('lesson-a', date);
  putCheck(db, 'lesson-a', 'teacher-a', date, 'A', 'approved_absence');
  let result = await record(db, pack, 'lesson-a', date);
  assert.equal(result.body.pack.usedSessions, 0);
  pack = result.body.pack;
  db.prepare(
    'INSERT INTO makeup_cases(app,case_id,student_id,source_task_id,source_date,source_teacher_id,consumption_group_id,' +
    'status,revision,completed_at,completed_by,reason,history,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).bind('task', makeupCaseId, 'student-a', 'lesson-a', date, 'teacher-a', consumptionGroupId,
    'completed', 2, Date.now(), 'teacher-a', null,
    JSON.stringify([{ action: 'create_from_absence', actorId: 'teacher-a', at: Date.now() }]),
    Date.now(), Date.now()).run();
  result = await call(db, {
    action: 'record', packId: pack.packId, revision: pack.revision, sourceType: 'makeup', sourceKey: makeupCaseId,
    consumptionGroupId
  }, own('teacher-a'));
  assert.equal(result.body.pack.usedSessions, 1);
  assert.equal(result.body.pack.remainingSessions, 7);
});

test('admin adjustment is append-only, changes derived remaining, and enforces balance', async () => {
  const db = seed();
  let pack = (await create(db, { totalSessions: 2 })).body.pack;
  putCheck(db, 'lesson-a', 'teacher-a', '2026-08-03', 'P');
  let result = await record(db, pack, 'lesson-a', '2026-08-03');
  pack = result.body.pack;
  assert.equal((await call(db, {
    action: 'adjust', packId: pack.packId, revision: pack.revision, delta: -1,
    sourceKey: 'adjust-1', reasonCode: 'correction'
  }, own('teacher-a'))).status, 403);
  result = await call(db, {
    action: 'adjust', packId: pack.packId, revision: pack.revision, delta: -1,
    sourceKey: 'adjust-1', reasonCode: 'correction'
  });
  assert.equal(result.body.pack.usedSessions, 0);
  assert.equal(result.body.pack.remainingSessions, 2);
  assert.equal(result.body.pack.usage.length, 2);
  const duplicate = await call(db, {
    action: 'adjust', packId: pack.packId, revision: pack.revision, delta: -1,
    sourceKey: 'adjust-1', reasonCode: 'correction'
  });
  assert.equal(duplicate.body.idempotent, true);
  const belowZero = await call(db, {
    action: 'adjust', packId: pack.packId, revision: result.body.pack.revision, delta: -1,
    sourceKey: 'adjust-2', reasonCode: 'correction'
  });
  assert.equal(belowZero.status, 409);
  assert.equal(belowZero.body.code, 'BALANCE_INVALID');
});

test('expired state is derived from the validity date and record rejects dates outside it', async () => {
  const db = seed();
  const old = await create(db, {
    studentId: 'student-old', lessonTaskId: 'lesson-old', validFrom: '2000-01-01', expiresOn: '2000-01-31'
  });
  assert.equal(old.body.pack.expired, true);
  putCheck(db, 'lesson-old', 'teacher-a', '2000-02-01', 'P');
  const outside = await record(db, old.body.pack, 'lesson-old', '2000-02-01');
  assert.equal(outside.status, 409);
  assert.equal(outside.body.code, 'DATE_OUT_OF_RANGE');
});

test('close is all-scope CAS and blocks later records', async () => {
  const db = seed();
  const pack = (await create(db)).body.pack;
  assert.equal((await call(db, { action: 'close', packId: pack.packId, revision: pack.revision }, own('teacher-a'))).status, 403);
  assert.equal((await call(db, { action: 'close', packId: pack.packId, revision: 99 })).status, 409);
  const closed = await call(db, { action: 'close', packId: pack.packId, revision: pack.revision });
  assert.equal(closed.body.pack.status, 'closed');
  putCheck(db, 'lesson-a', 'teacher-a', '2026-08-03', 'P');
  const blocked = await record(db, closed.body.pack, 'lesson-a', '2026-08-03');
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'PACK_NOT_ACTIVE');
});

test('admin can CAS-close an identity-stale active pack and then create its replacement', async () => {
  const db = seed();
  const pack = (await create(db)).body.pack;
  const row = db.database.prepare("SELECT data FROM tasks WHERE app='task' AND id='lesson-a'").get();
  const task = JSON.parse(row.data);
  task.lessonAssignmentKey = 'sha256:replacement-assignment';
  db.prepare("UPDATE tasks SET data=? WHERE app='task' AND id='lesson-a'").bind(JSON.stringify(task)).run();

  const blockedAdjustment = await call(db, {
    action: 'adjust', packId: pack.packId, revision: pack.revision, delta: 1,
    sourceKey: 'stale-adjustment', reasonCode: 'correction'
  });
  assert.equal(blockedAdjustment.status, 409);
  assert.equal(blockedAdjustment.body.code, 'PACK_IDENTITY_MISMATCH');
  assert.equal((await call(db, { action: 'close', packId: pack.packId, revision: 99 })).status, 409);

  const closed = await call(db, { action: 'close', packId: pack.packId, revision: pack.revision });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.pack.status, 'closed');
  assert.equal(closed.body.pack.integrity, 'PACK_IDENTITY_MISMATCH');
  const audit = db.database.prepare(
    "SELECT revision,closed_at,closed_by,updated_by FROM session_packs WHERE app='task' AND pack_id=?"
  ).get(pack.packId);
  assert.equal(audit.revision, pack.revision + 1);
  assert.ok(audit.closed_at);
  assert.equal(audit.closed_by, 'director');
  assert.equal(audit.updated_by, 'director');

  const replacement = await create(db);
  assert.equal(replacement.status, 200);
  assert.notEqual(replacement.body.pack.packId, pack.packId);
  assert.equal(db.database.prepare(
    "SELECT count(*) AS n FROM session_packs WHERE app='task' AND student_id='student-a' " +
    "AND lesson_task_id='lesson-a' AND status='active'"
  ).get().n, 1);
});

test('database usage guard rejects a stale assignment snapshot without changing the ledger or revision', async () => {
  const db = seed();
  const pack = (await create(db)).body.pack;
  const row = db.database.prepare("SELECT data FROM tasks WHERE app='task' AND id='lesson-a'").get();
  const task = JSON.parse(row.data);
  task.lessonAssignmentKey = 'sha256:changed-after-verification';
  db.prepare("UPDATE tasks SET data=? WHERE app='task' AND id='lesson-a'").bind(JSON.stringify(task)).run();
  assert.throws(() => db.prepare(
    'INSERT INTO session_pack_usage(app,entry_id,pack_id,expected_revision,source_type,source_ref,source_date,' +
    'attendance_event,delta,consumption_group_id,reason_code,actor_id,created_at) ' +
    "VALUES('task','stale-direct',?,?,'adjustment','stale-direct',NULL,'manual_adjustment',1,NULL," +
    "'correction','director',?)"
  ).bind(pack.packId, pack.revision, Date.now()).run(), /SESSION_PACK_IDENTITY_MISMATCH/);
  assert.equal(db.database.prepare('SELECT count(*) AS n FROM session_pack_usage WHERE pack_id=?')
    .get(pack.packId).n, 0);
  assert.equal(db.database.prepare('SELECT revision FROM session_packs WHERE pack_id=?').get(pack.packId).revision,
    pack.revision);
});

test('sensitive and financial fields are rejected and never appear in safe responses', async () => {
  const db = seed();
  for (const extra of [{ phone: '01000000000' }, { paymentAmount: 10000 }, { sensitiveMemo: '상담 내용' }]) {
    const result = await create(db, extra);
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'SENSITIVE_FIELD_FORBIDDEN');
  }
  const made = await create(db);
  const text = JSON.stringify(made.body);
  assert.doesNotMatch(text, /phone|payment|내부 관찰|보호자 요청/i);
});

test('database CAS and append-only triggers protect direct writes too', async () => {
  const db = seed();
  const pack = (await create(db)).body.pack;
  assert.throws(() => db.prepare(
    "UPDATE session_packs SET lesson_assignment_key='changed',revision=revision+1,updated_at=updated_at+1 " +
    'WHERE app=? AND pack_id=?'
  ).bind('task', pack.packId).run(), /SESSION_PACK_IMMUTABLE/);
  assert.throws(() => db.prepare(
    'UPDATE session_packs SET total_sessions=99,revision=revision+1,updated_at=updated_at+1 WHERE app=? AND pack_id=?'
  ).bind('task', pack.packId).run(), /SESSION_PACK_IMMUTABLE/);
  putCheck(db, 'lesson-a', 'teacher-a', '2026-08-03', 'P');
  const used = await record(db, pack, 'lesson-a', '2026-08-03');
  const entryId = used.body.pack.usage[0].entryId;
  assert.throws(() => db.prepare('DELETE FROM session_pack_usage WHERE app=? AND entry_id=?')
    .bind('task', entryId).run(), /SESSION_PACK_LEDGER_APPEND_ONLY/);
});
