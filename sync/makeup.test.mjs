import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handleMakeup } from './makeup.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/025_makeup.sql', import.meta.url), 'utf8');
const sessionMigration = fs.readFileSync(new URL('./migrations/026_session_packs.sql', import.meta.url), 'utf8');
const portalMigration = fs.readFileSync(new URL('./migrations/027_parent_portal.sql', import.meta.url), 'utf8');
const taskWriteCasMigration = fs.readFileSync(new URL('./migrations/055_task_write_cas_guards.sql', import.meta.url), 'utf8');

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
    this.database.exec(migration);
    this.database.exec(sessionMigration);
    this.database.exec(taskWriteCasMigration);
    this.beforeBatch = null;
    this.failGuardianReads = false;
    this.taskBulkReads = 0;
  }
  prepare(sql) {
    if (/SELECT id,owner,data,updated_at FROM tasks WHERE app=\? AND id IN/i.test(sql)) this.taskBulkReads++;
    if (this.failGuardianReads && /FROM guardian_portal_responses/i.test(sql) &&
        (this.failGuardianReads !== 'current' || /revision=\?/.test(sql))) {
      throw new Error('guardian response query failed');
    }
    return new Statement(this.database, sql);
  }
  batch(statements) {
    if (this.beforeBatch) { const hook = this.beforeBatch; this.beforeBatch = null; hook(); }
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

const own = id => ({ scope: 'own', id });
const manager = id => ({ scope: 'all', id, role: 'manager' });
const all = { scope: 'all' };
const responseJson = (object, status) => new Response(JSON.stringify(object), {
  status: status || 200, headers: { 'content-type': 'application/json' }
});
const realDateNow = Date.now;

async function call(db, auth, body) {
  const useFixtureClock = Date.now === realDateNow;
  if (useFixtureClock) Date.now = () => Date.parse('2026-08-11T12:00:00+09:00');
  try {
    const response = await handleMakeup({ DB: db }, 'task', body, '*', auth, responseJson);
    return { status: response.status, body: await response.json() };
  } finally {
    if (useFixtureClock) Date.now = realDateNow;
  }
}

async function callAt(db, auth, body, iso) {
  const original = Date.now;
  Date.now = () => Date.parse(iso);
  try { return await call(db, auth, body); }
  finally { Date.now = original; }
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function roster(overrides = {}) {
  const document = {
    roster: { updated: '2026-08-11', baseline: '2026-08', students: [
      { id: 'student-a', name: '가학생', grade: '중1', teacher: '가선생', subject: '영어', start: '2026-01', end: '', reason: '', teacherIds: ['teacher-a'] },
      { id: 'student-b', name: '나학생', grade: '중2', teacher: '나선생', subject: '국어', start: '2026-01', end: '', reason: '', teacherIds: ['teacher-b'] }
    ] },
    bookStudents: []
  };
  return Object.assign(document, overrides);
}

function lesson(id, studentId, owner, days, startTime, endTime, extra = {}) {
  return {
    id, staffId: owner, title: '[수업] 테스트', taskKind: 'lesson_instruction', studentId,
    subject: '영어', className: '테스트반', start: '2026-01-01', end: '', repeat: 'days', days,
    scheduleStatus: 'confirmed', scheduleSlots: [{ days, startTime, endTime }], deleted: false, ...extra
  };
}

function insertTask(db, task, owner = task.staffId) {
  db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', task.id, owner, JSON.stringify(task), 1, 1).run();
}

function absence(db, taskId, owner, date) {
  db.prepare('INSERT INTO checks(app,k,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', taskId + '|' + date, owner, JSON.stringify({ taskId, date, att: 'A' }), 1, 1).run();
}

function seed(db) {
  for (const id of ['teacher-a', 'teacher-b', 'teacher-inactive']) {
    const deleted = id === 'teacher-inactive';
    db.prepare('INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
      .bind('task', id, id, JSON.stringify({ id, name: id, deleted }), 1, 1).run();
  }
  db.prepare('INSERT INTO private_rosters(app,data,updated_at) VALUES(?,?,?)')
    .bind('task', JSON.stringify(roster()), 1).run();
  insertTask(db, lesson('lesson-a', 'student-a', 'teacher-a', [1], '18:00', '19:00'));
  insertTask(db, lesson('lesson-b', 'student-b', 'teacher-b', [2], '18:00', '19:00'));
  absence(db, 'lesson-a', 'teacher-a', '2026-08-10');
  absence(db, 'lesson-b', 'teacher-b', '2026-08-11');
}

async function insertPack(db, overrides = {}) {
  const pack = {
    packId: 'pack-a', totalSessions: 8, validFrom: '2026-08-01', expiresOn: '2026-08-31',
    revision: 1, ...overrides
  };
  const taskRow = db.database.prepare("SELECT owner,data FROM tasks WHERE app='task' AND id='lesson-a'").get();
  const task = JSON.parse(taskRow.data);
  const studentIdentityHash = await sha256('student-id\nstudent-a');
  const taskIdentityHash = await sha256([
    'lesson-task', task.id, taskRow.owner, task.studentId,
    task.lessonAssignmentKey || task.lessonDedupeKey || task.id
  ].join('\n'));
  db.prepare(
    'INSERT INTO session_packs(app,pack_id,student_id,lesson_task_id,task_owner,lesson_assignment_key,' +
    'student_identity_hash,task_identity_hash,total_sessions,valid_from,expires_on,deduction_policy,status,revision,' +
    "created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,'recommended_v1','active',?,?,?,?,?)"
  ).bind('task', pack.packId, 'student-a', 'lesson-a', 'teacher-a',
    task.lessonAssignmentKey || task.lessonDedupeKey || task.id, studentIdentityHash, taskIdentityHash,
    pack.totalSessions, pack.validFrom, pack.expiresOn, pack.revision, 1, 'director', 1, 'director').run();
  return pack;
}

function insertUsage(db, packId, revision, sourceRef, date, delta, groupId) {
  db.prepare(
    'INSERT INTO session_pack_usage(app,entry_id,pack_id,expected_revision,source_type,source_ref,source_date,' +
    'attendance_event,delta,consumption_group_id,reason_code,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).bind('task', 'seed_' + sourceRef, packId, revision, 'regular', sourceRef, date, 'present', delta,
    groupId, null, 'teacher-a', 2).run();
}

async function createAndReview(db, sourceTaskId = 'lesson-a', sourceDate = '2026-08-10', auth = own('teacher-a')) {
  const created = await call(db, auth, { action: 'create_from_absence', sourceTaskId, sourceDate });
  assert.equal(created.status, 200);
  const reviewed = await call(db, all, { action: 'review', caseId: created.body.case.caseId,
    revision: created.body.case.revision, decision: 'required', reason: '' });
  assert.equal(reviewed.status, 200);
  return reviewed.body.case;
}

async function proposeAndConfirm(db, reviewed, staffId = 'teacher-b') {
  const proposed = await callAt(db, all, { action: 'propose', caseId: reviewed.caseId, revision: reviewed.revision,
    date: '2026-08-12', startTime: '20:00', endTime: '21:00', staffId }, '2026-08-11T12:00:00+09:00');
  assert.equal(proposed.status, 200);
  const confirmed = await callAt(db, all, { action: 'confirm', caseId: reviewed.caseId,
    revision: proposed.body.case.revision }, '2026-08-11T12:01:00+09:00');
  assert.equal(confirmed.status, 200);
  return confirmed.body.case;
}

test('migration is additive and stores stable IDs, not names or contact fields', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS makeup_cases/);
  assert.match(migration, /MAKEUP_COMPLETE_ASSIGNEE/);
  assert.match(sessionMigration, /trg_session_pack_makeup_usage_guard/);
  assert.match(sessionMigration, /MAKEUP_REVISION_CONFLICT/);
  assert.match(sessionMigration, /SESSION_PACK_IDENTITY_MISMATCH/);
  assert.doesNotMatch(migration, /DROP TABLE|DELETE FROM/i);
  const table = migration.slice(migration.indexOf('CREATE TABLE'), migration.indexOf(');') + 2);
  assert.doesNotMatch(table, /student_name|phone|guardian|contact|memo/i);
  for (const status of ['review_pending', 'reviewed', 'awaiting_parent', 'confirmed', 'completed', 'cancelled']) {
    assert.ok(table.includes("'" + status + "'"));
  }
});

test('create requires a real A check, stable roster assignment, active source staff, and deduplicates source lesson/date', async () => {
  const db = new TestD1(); seed(db);
  const denied = await call(db, own('teacher-b'), { action: 'create_from_absence', sourceTaskId: 'lesson-a', sourceDate: '2026-08-10' });
  assert.equal(denied.status, 403);
  const missing = await call(db, own('teacher-a'), { action: 'create_from_absence', sourceTaskId: 'lesson-a', sourceDate: '2026-08-17' });
  assert.equal(missing.status, 409);
  assert.equal(missing.body.code, 'ABSENCE_REQUIRED');

  const first = await call(db, own('teacher-a'), { action: 'create_from_absence', sourceTaskId: 'lesson-a', sourceDate: '2026-08-10' });
  assert.equal(first.status, 200);
  assert.equal(first.body.idempotent, false);
  assert.equal(first.body.case.status, 'review_pending');
  assert.match(first.body.case.caseId, /^mu_[a-f0-9]{48}$/);
  assert.match(first.body.case.consumptionGroupId, /^mc_[a-f0-9]{48}$/);
  const duplicate = await call(db, own('teacher-a'), { action: 'create_from_absence', sourceTaskId: 'lesson-a', sourceDate: '2026-08-10' });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.idempotent, true);
  assert.equal(db.database.prepare('SELECT count(*) AS n FROM makeup_cases').get().n, 1);

  db.prepare("UPDATE staff SET data=? WHERE app='task' AND id='teacher-b'")
    .bind(JSON.stringify({ id: 'teacher-b', deleted: true })).run();
  const inactive = await call(db, own('teacher-b'), { action: 'create_from_absence', sourceTaskId: 'lesson-b', sourceDate: '2026-08-11' });
  assert.equal(inactive.status, 409);
});

test('own list is roster scoped and only all scope can review, propose, confirm, or cancel', async () => {
  const db = new TestD1(); seed(db);
  await call(db, own('teacher-a'), { action: 'create_from_absence', sourceTaskId: 'lesson-a', sourceDate: '2026-08-10' });
  await call(db, own('teacher-b'), { action: 'create_from_absence', sourceTaskId: 'lesson-b', sourceDate: '2026-08-11' });
  const listA = await call(db, own('teacher-a'), { action: 'list' });
  assert.deepEqual(listA.body.cases.map(item => item.studentId), ['student-a']);
  assert.equal(JSON.stringify(listA.body).includes('teacherIds'), false);
  assert.equal(JSON.stringify(listA.body).includes('phone'), false);
  assert.equal((await call(db, own('teacher-a'), { action: 'review', caseId: listA.body.cases[0].caseId,
    revision: 1, decision: 'required', reason: '' })).status, 403);
  assert.equal((await call(db, all, { action: 'list' })).body.cases.length, 2);
});

test('own list follows the source lesson current owner after teacher transfer and fails closed on identity mismatch', async () => {
  const db = new TestD1(); seed(db);
  await call(db, own('teacher-a'), { action: 'create_from_absence', sourceTaskId: 'lesson-a', sourceDate: '2026-08-10' });
  const row = db.database.prepare("SELECT data FROM tasks WHERE app='task' AND id='lesson-a'").get();
  const task = JSON.parse(row.data);
  task.staffId = 'teacher-b';
  db.prepare("UPDATE tasks SET owner='teacher-b',data=? WHERE app='task' AND id='lesson-a'")
    .bind(JSON.stringify(task)).run();

  assert.deepEqual((await call(db, own('teacher-a'), { action: 'list' })).body.cases, []);
  assert.deepEqual((await call(db, own('teacher-b'), { action: 'list' })).body.cases.map(item => item.studentId), ['student-a']);

  task.staffId = 'teacher-a';
  db.prepare("UPDATE tasks SET data=? WHERE app='task' AND id='lesson-a'").bind(JSON.stringify(task)).run();
  assert.deepEqual((await call(db, own('teacher-b'), { action: 'list' })).body.cases, []);
  assert.deepEqual((await call(db, all, { action: 'list' })).body.cases, []);
});

test('state machine uses CAS and emits parent-notification markers for proposal and confirmation', async () => {
  const db = new TestD1(); seed(db);
  const reviewed = await createAndReview(db);
  assert.equal(reviewed.status, 'reviewed');
  const stale = await call(db, all, { action: 'review', caseId: reviewed.caseId, revision: 1,
    decision: 'required', reason: '' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'REVISION_CONFLICT');
  const invalid = await call(db, all, { action: 'confirm', caseId: reviewed.caseId, revision: reviewed.revision });
  assert.equal(invalid.status, 409);
  assert.equal(invalid.body.code, 'INVALID_TRANSITION');

  const proposed = await call(db, all, { action: 'propose', caseId: reviewed.caseId, revision: reviewed.revision,
    date: '2026-08-12', startTime: '20:00', endTime: '21:00', staffId: 'teacher-b' });
  assert.equal(proposed.status, 200);
  assert.equal(proposed.body.case.proposedDate, '2026-08-12');
  assert.equal(proposed.body.case.status, 'awaiting_parent');
  assert.equal(proposed.body.case.notificationNeeded, true);
  assert.equal(proposed.body.case.notificationEvent, 'proposal');
  const confirmed = await call(db, all, { action: 'confirm', caseId: reviewed.caseId,
    revision: proposed.body.case.revision });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.case.status, 'confirmed');
  assert.equal(confirmed.body.case.notificationNeeded, true);
  assert.equal(confirmed.body.case.notificationEvent, 'confirmed');
  assert.equal(confirmed.body.case.notificationEventRevision, confirmed.body.case.revision);
  assert.throws(() => db.prepare(
    "UPDATE makeup_cases SET status='completed',revision=revision+1,confirmed_staff_id='director'," +
    "completed_at=?,completed_by='director',updated_at=updated_at+1 " +
    "WHERE app='task' AND case_id=?"
  ).bind(Date.now(), reviewed.caseId).run(), /MAKEUP_COMPLETE_ASSIGNEE/);
  const assignedList = await call(db, own('teacher-b'), { action: 'list' });
  assert.deepEqual(assignedList.body.cases.map(item => item.caseId), [reviewed.caseId]);
  const wrongTeacher = await callAt(db, own('teacher-a'), { action: 'complete', caseId: reviewed.caseId,
    revision: confirmed.body.case.revision }, '2026-08-12T20:55:00+09:00');
  assert.equal(wrongTeacher.status, 403);
  const rootAdmin = await callAt(db, all, { action: 'complete', caseId: reviewed.caseId,
    revision: confirmed.body.case.revision }, '2026-08-12T20:54:59+09:00');
  assert.equal(rootAdmin.status, 409);
  assert.equal(rootAdmin.body.code, 'MAKEUP_NOT_ENDED');
  const tooEarly = await callAt(db, manager('teacher-b'), { action: 'complete', caseId: reviewed.caseId,
    revision: confirmed.body.case.revision }, '2026-08-12T20:54:59+09:00');
  assert.equal(tooEarly.status, 409);
  assert.equal(tooEarly.body.code, 'MAKEUP_NOT_ENDED');
  const completed = await callAt(db, manager('teacher-b'), { action: 'complete', caseId: reviewed.caseId,
    revision: confirmed.body.case.revision }, '2026-08-12T20:55:00+09:00');
  assert.equal(completed.status, 200);
  assert.equal(completed.body.case.status, 'completed');
  assert.ok(completed.body.case.completedAt);
  assert.deepEqual(completed.body.sessionPackImpact,
    { status: 'not_applicable', reason: 'no_active_pack', refreshNeeded: false });
  assert.deepEqual(completed.body.case.history.map(item => item.action),
    ['create_from_absence', 'review', 'propose', 'confirm', 'complete']);
});

test('create atomically rejects an A-to-P correction that wins after its initial absence check', async () => {
  const db = new TestD1(); seed(db);
  db.beforeBatch = () => db.prepare("UPDATE checks SET data=? WHERE k='lesson-a|2026-08-10'")
    .bind(JSON.stringify({ taskId: 'lesson-a', date: '2026-08-10', att: 'P' })).run();
  const result = await call(db, own('teacher-a'), {
    action: 'create_from_absence', sourceTaskId: 'lesson-a', sourceDate: '2026-08-10'
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'ABSENCE_REQUIRED');
  assert.equal(db.database.prepare('SELECT count(*) AS n FROM makeup_cases').get().n, 0);
});

test('schedule immediately confirms with the source teacher and atomically creates one makeup lesson task', async () => {
  const db = new TestD1(); seed(db);
  const created = await call(db, own('teacher-a'), {
    action: 'create_from_absence', sourceTaskId: 'lesson-a', sourceDate: '2026-08-10'
  });
  const row = created.body.case;
  const forbidden = await callAt(db, own('teacher-a'), {
    action: 'schedule', caseId: row.caseId, revision: row.revision,
    date: '2026-08-12', startTime: '20:00', endTime: '21:00'
  }, '2026-08-11T12:00:00+09:00');
  assert.equal(forbidden.status, 403);
  const ended = await callAt(db, all, {
    action: 'schedule', caseId: row.caseId, revision: row.revision,
    date: '2026-08-11', startTime: '10:00', endTime: '11:00'
  }, '2026-08-11T12:00:00+09:00');
  assert.equal(ended.status, 409);
  assert.equal(ended.body.code, 'MAKEUP_SLOT_ENDED');

  const scheduled = await callAt(db, all, {
    action: 'schedule', caseId: row.caseId, revision: row.revision,
    date: '2026-08-12', startTime: '20:00', endTime: '21:00'
  }, '2026-08-11T12:00:00+09:00');
  assert.equal(scheduled.status, 200);
  assert.equal(scheduled.body.case.status, 'confirmed');
  assert.equal(scheduled.body.case.confirmedStaffId, 'teacher-a');
  assert.equal(scheduled.body.case.notificationNeeded, false);
  assert.deepEqual(scheduled.body.case.history.map(item => item.action), ['create_from_absence', 'schedule']);
  assert.equal(scheduled.body.lessonTask.id, 'makeup_lesson_' + row.caseId);
  assert.equal(scheduled.body.lessonTask.deleted, false);

  const taskId = 'makeup_lesson_' + row.caseId;
  const stored = db.database.prepare("SELECT owner,data FROM tasks WHERE app='task' AND id=?").get(taskId);
  assert.equal(stored.owner, 'teacher-a');
  const task = JSON.parse(stored.data);
  assert.equal(task.lessonInstanceType, 'makeup');
  assert.equal(task.makeupCaseId, row.caseId);
  assert.equal(task.makeupSourceTaskId, 'lesson-a');
  assert.equal(task.makeupSourceDate, '2026-08-10');
  assert.equal(task.studentId, 'student-a');
  assert.equal(task.repeat, 'once');
  assert.equal(task.start, '2026-08-12');
  assert.equal(task.end, '2026-08-12');
  assert.deepEqual(task.scheduleSlots.map(slot => [slot.days, slot.startTime, slot.endTime]),
    [[[3], '20:00', '21:00']]);
  assert.match(task.title, /^\[수업\]/);

  absence(db, taskId, 'teacher-a', '2026-08-12');
  const recursive = await call(db, own('teacher-a'), {
    action: 'create_from_absence', sourceTaskId: taskId, sourceDate: '2026-08-12'
  });
  assert.equal(recursive.status, 404);
  assert.equal(recursive.body.code, 'LESSON_MISSING');
});

test('schedule CAS failure rolls back its generated task', async () => {
  const db = new TestD1(); seed(db);
  const created = await call(db, own('teacher-a'), {
    action: 'create_from_absence', sourceTaskId: 'lesson-a', sourceDate: '2026-08-10'
  });
  const row = created.body.case;
  db.beforeBatch = () => db.prepare(
    "UPDATE makeup_cases SET revision=revision+1,updated_at=updated_at+1 WHERE app='task' AND case_id=?"
  ).bind(row.caseId).run();
  const result = await callAt(db, all, {
    action: 'schedule', caseId: row.caseId, revision: row.revision,
    date: '2026-08-12', startTime: '20:00', endTime: '21:00'
  }, '2026-08-11T12:00:00+09:00');
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'REVISION_CONFLICT');
  assert.equal(db.database.prepare("SELECT count(*) AS n FROM tasks WHERE id LIKE 'makeup_lesson_%'").get().n, 0);
});

test('schedule atomically rejects a regular lesson inserted after its initial conflict check', async () => {
  const db = new TestD1(); seed(db);
  const created = await call(db, own('teacher-a'), {
    action: 'create_from_absence', sourceTaskId: 'lesson-a', sourceDate: '2026-08-10'
  });
  db.beforeBatch = () => insertTask(db,
    lesson('lesson-race', 'student-a', 'teacher-b', [3], '20:30', '21:30'));
  const result = await callAt(db, all, {
    action: 'schedule', caseId: created.body.case.caseId, revision: created.body.case.revision,
    date: '2026-08-12', startTime: '20:00', endTime: '21:00'
  }, '2026-08-11T12:00:00+09:00');
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'STUDENT_SCHEDULE_CONFLICT');
  assert.equal(db.database.prepare("SELECT count(*) AS n FROM tasks WHERE id LIKE 'makeup_lesson_%'").get().n, 0);
  assert.equal(db.database.prepare('SELECT status FROM makeup_cases WHERE case_id=?')
    .get(created.body.case.caseId).status, 'review_pending');
});

test('schedule atomically rejects a source-teacher transfer after authorization', async () => {
  const db = new TestD1(); seed(db);
  const created = await call(db, own('teacher-a'), {
    action: 'create_from_absence', sourceTaskId: 'lesson-a', sourceDate: '2026-08-10'
  });
  db.beforeBatch = () => {
    const row = db.database.prepare("SELECT data FROM tasks WHERE id='lesson-a'").get();
    db.prepare("UPDATE tasks SET owner='teacher-b',data=?,updated_at=updated_at+1 WHERE id='lesson-a'")
      .bind(JSON.stringify({ ...JSON.parse(row.data), staffId: 'teacher-b' })).run();
  };
  const result = await callAt(db, all, {
    action: 'schedule', caseId: created.body.case.caseId, revision: created.body.case.revision,
    date: '2026-08-12', startTime: '20:00', endTime: '21:00'
  }, '2026-08-11T12:00:00+09:00');
  assert.equal(result.status, 409);
  assert.equal(db.database.prepare("SELECT count(*) AS n FROM tasks WHERE id LIKE 'makeup_lesson_%'").get().n, 0);
});

test('generated makeup lesson copies the source-date slot hours and rejects ambiguous hours', async () => {
  const db = new TestD1(); seed(db);
  const sourceRow = db.database.prepare("SELECT data FROM tasks WHERE id='lesson-a'").get();
  const source = JSON.parse(sourceRow.data);
  source.lessonHours = '';
  source.scheduleSlots = [{ days: [1], startTime: '18:00', endTime: '19:50', lessonHours: '2T' }];
  db.prepare("UPDATE tasks SET data=?,updated_at=2,srv_at=2 WHERE id='lesson-a'").bind(JSON.stringify(source)).run();
  const created = await call(db, own('teacher-a'), {
    action: 'create_from_absence', sourceTaskId: 'lesson-a', sourceDate: '2026-08-10'
  });
  const scheduled = await callAt(db, all, {
    action: 'schedule', caseId: created.body.case.caseId, revision: created.body.case.revision,
    date: '2026-08-12', startTime: '20:00', endTime: '21:00'
  }, '2026-08-11T12:00:00+09:00');
  assert.equal(scheduled.status, 200);
  assert.equal(scheduled.body.lessonTask.lessonHours, '2T');
  assert.equal(scheduled.body.lessonTask.scheduleSlots[0].lessonHours, '2T');

  const ambiguousDb = new TestD1(); seed(ambiguousDb);
  const ambiguousRow = ambiguousDb.database.prepare("SELECT data FROM tasks WHERE id='lesson-a'").get();
  const ambiguous = JSON.parse(ambiguousRow.data);
  ambiguous.lessonHours = '';
  ambiguous.scheduleSlots = [
    { days: [1], startTime: '18:00', endTime: '18:50', lessonHours: '1T' },
    { days: [1], startTime: '19:00', endTime: '20:50', lessonHours: '2T' }
  ];
  ambiguousDb.prepare("UPDATE tasks SET data=?,updated_at=2,srv_at=2 WHERE id='lesson-a'")
    .bind(JSON.stringify(ambiguous)).run();
  const ambiguousCreated = await call(ambiguousDb, own('teacher-a'), {
    action: 'create_from_absence', sourceTaskId: 'lesson-a', sourceDate: '2026-08-10'
  });
  const rejected = await callAt(ambiguousDb, all, {
    action: 'schedule', caseId: ambiguousCreated.body.case.caseId, revision: ambiguousCreated.body.case.revision,
    date: '2026-08-12', startTime: '20:00', endTime: '21:00'
  }, '2026-08-11T12:00:00+09:00');
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.code, 'MAKEUP_LESSON_HOURS_AMBIGUOUS');
});

test('one complete action records an unscheduled past makeup, creates its lesson, and lets an administrator act', async () => {
  const db = new TestD1(); seed(db); await insertPack(db);
  const created = await call(db, own('teacher-a'), {
    action: 'create_from_absence', sourceTaskId: 'lesson-a', sourceDate: '2026-08-10'
  });
  const row = created.body.case;
  const completed = await callAt(db, all, {
    action: 'complete', caseId: row.caseId, revision: row.revision,
    date: '2026-08-11', startTime: '10:00', endTime: '11:00'
  }, '2026-08-11T12:00:00+09:00');
  assert.equal(completed.status, 200);
  assert.equal(completed.body.case.status, 'completed');
  assert.equal(completed.body.case.revision, 3);
  assert.equal(completed.body.case.completedDate, '2026-08-11');
  assert.equal(completed.body.case.completedStartTime, '10:00');
  assert.equal(completed.body.case.completedEndTime, '11:00');
  assert.equal(completed.body.case.completedStaffId, 'teacher-a');
  assert.deepEqual(completed.body.case.history.map(item => item.action),
    ['create_from_absence', 'schedule_for_completion', 'complete']);
  assert.equal(completed.body.case.history.at(-1).actorId, 'director');
  assert.deepEqual(completed.body.sessionPackImpact,
    { status: 'recorded', packId: 'pack-a', delta: 1, packRevision: 2, refreshNeeded: true });
  const task = JSON.parse(db.database.prepare(
    "SELECT data FROM tasks WHERE app='task' AND id=?"
  ).get('makeup_lesson_' + row.caseId).data);
  assert.equal(task.start, '2026-08-11');
  assert.equal(task.scheduleSlots[0].startTime, '10:00');
});

test('direct complete closes a legacy awaiting-parent case even when its old proposal was declined', async () => {
  const db = new TestD1(); db.database.exec(portalMigration); seed(db);
  const reviewed = await createAndReview(db);
  const proposed = await callAt(db, all, {
    action: 'propose', caseId: reviewed.caseId, revision: reviewed.revision,
    date: '2026-08-12', startTime: '20:00', endTime: '21:00', staffId: 'teacher-b'
  }, '2026-08-11T12:00:00+09:00');
  db.prepare(
    'INSERT INTO guardian_portal_responses(app,response_id,student_id,object_type,object_id,revision,response,created_at) ' +
    'VALUES(?,?,?,?,?,?,?,?)'
  ).bind('task', 'legacy-decline', 'student-a', 'makeup', reviewed.caseId,
    proposed.body.case.revision, 'decline', 10).run();
  const completed = await callAt(db, all, {
    action: 'complete', caseId: reviewed.caseId, revision: proposed.body.case.revision,
    date: '2026-08-11', startTime: '10:00', endTime: '11:00'
  }, '2026-08-11T12:00:00+09:00');
  assert.equal(completed.status, 200);
  assert.equal(completed.body.case.status, 'completed');
  assert.deepEqual(completed.body.case.history.map(item => item.action), [
    'create_from_absence', 'review', 'propose', 'supersede_parent_process_for_completion',
    'schedule_for_completion', 'complete'
  ]);
  assert.equal(completed.body.lessonTask.staffId, 'teacher-a');
  assert.equal(completed.body.case.completedDate, '2026-08-11');
});

test('schedule supersedes a legacy declined parent proposal before confirming the new simple schedule', async () => {
  const db = new TestD1(); db.database.exec(portalMigration); seed(db);
  const reviewed = await createAndReview(db);
  const proposed = await callAt(db, all, {
    action: 'propose', caseId: reviewed.caseId, revision: reviewed.revision,
    date: '2026-08-12', startTime: '19:00', endTime: '20:00', staffId: 'teacher-b'
  }, '2026-08-11T12:00:00+09:00');
  db.prepare(
    'INSERT INTO guardian_portal_responses(app,response_id,student_id,object_type,object_id,revision,response,created_at) ' +
    'VALUES(?,?,?,?,?,?,?,?)'
  ).bind('task', 'legacy-schedule-decline', 'student-a', 'makeup', reviewed.caseId,
    proposed.body.case.revision, 'decline', 10).run();
  const scheduled = await callAt(db, all, {
    action: 'schedule', caseId: reviewed.caseId, revision: proposed.body.case.revision,
    date: '2026-08-13', startTime: '20:00', endTime: '21:00'
  }, '2026-08-11T12:05:00+09:00');
  assert.equal(scheduled.status, 200);
  assert.equal(scheduled.body.case.status, 'confirmed');
  assert.equal(scheduled.body.case.confirmedStaffId, 'teacher-a');
  assert.equal(scheduled.body.case.notificationNeeded, false);
  assert.deepEqual(scheduled.body.case.history.slice(-2).map(item => item.action),
    ['supersede_parent_process_for_schedule', 'schedule']);
});

test('scheduled complete moves a record-free generated lesson to the different actual time', async () => {
  const db = new TestD1(); seed(db);
  const created = await call(db, own('teacher-a'), {
    action: 'create_from_absence', sourceTaskId: 'lesson-a', sourceDate: '2026-08-10'
  });
  const scheduled = await callAt(db, all, {
    action: 'schedule', caseId: created.body.case.caseId, revision: created.body.case.revision,
    date: '2026-08-12', startTime: '20:00', endTime: '21:00'
  }, '2026-08-11T12:00:00+09:00');
  const completed = await callAt(db, own('teacher-a'), {
    action: 'complete', caseId: scheduled.body.case.caseId, revision: scheduled.body.case.revision,
    date: '2026-08-13', startTime: '19:00', endTime: '20:00'
  }, '2026-08-13T20:00:00+09:00');
  assert.equal(completed.status, 200);
  assert.equal(completed.body.case.confirmedDate, '2026-08-12');
  assert.equal(completed.body.case.confirmedStartTime, '20:00');
  assert.equal(completed.body.case.completedDate, '2026-08-13');
  assert.equal(completed.body.case.completedStartTime, '19:00');
  assert.equal(completed.body.lessonTask.start, '2026-08-13');
  const task = JSON.parse(db.database.prepare(
    "SELECT data FROM tasks WHERE app='task' AND id=?"
  ).get('makeup_lesson_' + created.body.case.caseId).data);
  assert.equal(task.start, '2026-08-13');
  assert.equal(task.end, '2026-08-13');
  assert.equal(task.scheduleSlots[0].startTime, '19:00');
  assert.equal(task.scheduleSlots[0].endTime, '20:00');
});

test('scheduled complete preserves its planned lesson when a check already references that task and date', async () => {
  const db = new TestD1(); seed(db);
  const created = await call(db, own('teacher-a'), {
    action: 'create_from_absence', sourceTaskId: 'lesson-a', sourceDate: '2026-08-10'
  });
  const scheduled = await callAt(db, all, {
    action: 'schedule', caseId: created.body.case.caseId, revision: created.body.case.revision,
    date: '2026-08-12', startTime: '20:00', endTime: '21:00'
  }, '2026-08-11T12:00:00+09:00');
  const taskId = 'makeup_lesson_' + created.body.case.caseId;
  db.prepare('INSERT INTO checks(app,k,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', taskId + '|2026-08-12', 'teacher-a',
      JSON.stringify({ taskId, date: '2026-08-12', att: 'P' }), 2, 2).run();
  const completed = await callAt(db, own('teacher-a'), {
    action: 'complete', caseId: scheduled.body.case.caseId, revision: scheduled.body.case.revision,
    date: '2026-08-13', startTime: '19:00', endTime: '20:00'
  }, '2026-08-13T20:00:00+09:00');
  assert.equal(completed.status, 200);
  assert.equal(completed.body.case.completedDate, '2026-08-13');
  assert.equal(completed.body.case.completedStartTime, '19:00');
  assert.equal(completed.body.lessonTask.start, '2026-08-12');
  const task = JSON.parse(db.database.prepare('SELECT data FROM tasks WHERE id=?').get(taskId).data);
  assert.equal(task.start, '2026-08-12');
  assert.equal(task.scheduleSlots[0].startTime, '20:00');
});

test('completion hides a future planned lesson with records when actual time differs without deleting its records', async () => {
  const db = new TestD1(); seed(db);
  const created = await call(db, own('teacher-a'), {
    action: 'create_from_absence', sourceTaskId: 'lesson-a', sourceDate: '2026-08-10'
  });
  const scheduled = await callAt(db, all, {
    action: 'schedule', caseId: created.body.case.caseId, revision: created.body.case.revision,
    date: '2026-08-15', startTime: '20:00', endTime: '21:00'
  }, '2026-08-11T12:00:00+09:00');
  const taskId = 'makeup_lesson_' + created.body.case.caseId;
  const checkKey = taskId + '|2026-08-15';
  db.prepare('INSERT INTO checks(app,k,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', checkKey, 'teacher-a',
      JSON.stringify({ taskId, date: '2026-08-15', note: '보존할 기존 기록' }), 2, 2).run();
  const completed = await callAt(db, own('teacher-a'), {
    action: 'complete', caseId: scheduled.body.case.caseId, revision: scheduled.body.case.revision,
    date: '2026-08-13', startTime: '19:00', endTime: '20:00'
  }, '2026-08-13T20:00:00+09:00');
  assert.equal(completed.status, 200);
  assert.equal(completed.body.case.status, 'completed');
  assert.equal(completed.body.case.completedDate, '2026-08-13');
  assert.equal(completed.body.lessonTask.deleted, true);
  assert.equal(completed.body.lessonTask.makeupCompleted, true);
  assert.equal(completed.body.lessonTask.makeupCompletedActualDate, '2026-08-13');
  assert.equal(db.database.prepare('SELECT count(*) AS n FROM checks WHERE k=?').get(checkKey).n, 1);
  const list = await call(db, all, { action: 'list', status: 'completed' });
  assert.equal(list.body.cases[0].hasLessonTask, false);
  assert.equal(list.body.cases[0].completedDate, '2026-08-13');
});

test('confirmed completion atomically rejects another makeup confirmed at its actual time', async () => {
  const db = new TestD1(); seed(db);
  const first = await call(db, own('teacher-a'), {
    action: 'create_from_absence', sourceTaskId: 'lesson-a', sourceDate: '2026-08-10'
  });
  const firstScheduled = await callAt(db, all, {
    action: 'schedule', caseId: first.body.case.caseId, revision: first.body.case.revision,
    date: '2026-08-12', startTime: '20:00', endTime: '21:00'
  }, '2026-08-11T12:00:00+09:00');
  const secondReviewed = await createAndReview(db, 'lesson-b', '2026-08-11', own('teacher-b'));
  db.beforeBatch = () => db.prepare(
    "UPDATE makeup_cases SET status='confirmed',confirmed_start_at=?,confirmed_end_at=?,confirmed_staff_id='teacher-a'," +
    'revision=revision+1,updated_at=updated_at+1 WHERE case_id=?'
  ).bind('2026-08-13T20:00:00+09:00', '2026-08-13T21:00:00+09:00', secondReviewed.caseId).run();
  const blocked = await callAt(db, own('teacher-a'), {
    action: 'complete', caseId: first.body.case.caseId, revision: firstScheduled.body.case.revision,
    date: '2026-08-13', startTime: '20:00', endTime: '21:00'
  }, '2026-08-13T21:00:00+09:00');
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'STAFF_MAKEUP_CONFLICT');
  assert.equal(db.database.prepare('SELECT status FROM makeup_cases WHERE case_id=?').get(first.body.case.caseId).status,
    'confirmed');
});

test('no_makeup keeps a history record, needs no free-text reason, and remains administrator-only', async () => {
  const db = new TestD1(); seed(db);
  const created = await call(db, own('teacher-a'), {
    action: 'create_from_absence', sourceTaskId: 'lesson-a', sourceDate: '2026-08-10'
  });
  const row = created.body.case;
  const forbidden = await call(db, own('teacher-a'), {
    action: 'no_makeup', caseId: row.caseId, revision: row.revision
  });
  assert.equal(forbidden.status, 403);
  const cancelled = await call(db, all, {
    action: 'no_makeup', caseId: row.caseId, revision: row.revision
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.case.status, 'cancelled');
  assert.equal(cancelled.body.case.reason, 'policy_ineligible');
  assert.equal(cancelled.body.case.notificationNeeded, false);
  assert.equal(cancelled.body.case.history.at(-1).action, 'no_makeup');

  const scheduledDb = new TestD1(); seed(scheduledDb);
  const scheduledCreated = await call(scheduledDb, own('teacher-a'), {
    action: 'create_from_absence', sourceTaskId: 'lesson-a', sourceDate: '2026-08-10'
  });
  const scheduled = await callAt(scheduledDb, all, {
    action: 'schedule', caseId: scheduledCreated.body.case.caseId, revision: scheduledCreated.body.case.revision,
    date: '2026-08-12', startTime: '20:00', endTime: '21:00'
  }, '2026-08-11T12:00:00+09:00');
  const taskId = 'makeup_lesson_' + scheduled.body.case.caseId;
  const removed = await call(scheduledDb, all, {
    action: 'no_makeup', caseId: scheduled.body.case.caseId, revision: scheduled.body.case.revision
  });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.lessonTask.deleted, true);
  assert.equal(JSON.parse(scheduledDb.database.prepare('SELECT data FROM tasks WHERE id=?').get(taskId).data).deleted, true);

  const protectedDb = new TestD1(); seed(protectedDb);
  const protectedCreated = await call(protectedDb, own('teacher-a'), {
    action: 'create_from_absence', sourceTaskId: 'lesson-a', sourceDate: '2026-08-10'
  });
  const protectedScheduled = await callAt(protectedDb, all, {
    action: 'schedule', caseId: protectedCreated.body.case.caseId, revision: protectedCreated.body.case.revision,
    date: '2026-08-12', startTime: '20:00', endTime: '21:00'
  }, '2026-08-11T12:00:00+09:00');
  const protectedTaskId = 'makeup_lesson_' + protectedScheduled.body.case.caseId;
  protectedDb.prepare('INSERT INTO checks(app,k,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', protectedTaskId + '|2026-08-12', 'teacher-a',
      JSON.stringify({ taskId: protectedTaskId, date: '2026-08-12', att: 'P' }), 2, 2).run();
  const blocked = await call(protectedDb, all, {
    action: 'no_makeup', caseId: protectedScheduled.body.case.caseId,
    revision: protectedScheduled.body.case.revision
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'MAKEUP_LESSON_HAS_RECORDS');
  assert.equal(protectedDb.database.prepare('SELECT status FROM makeup_cases WHERE case_id=?')
    .get(protectedScheduled.body.case.caseId).status, 'confirmed');
  assert.equal(JSON.parse(protectedDb.database.prepare('SELECT data FROM tasks WHERE id=?').get(protectedTaskId).data).deleted,
    false);

  const legacyDb = new TestD1(); seed(legacyDb);
  const legacyReviewed = await createAndReview(legacyDb);
  const legacyProposed = await callAt(legacyDb, all, {
    action: 'propose', caseId: legacyReviewed.caseId, revision: legacyReviewed.revision,
    date: '2026-08-12', startTime: '20:00', endTime: '21:00', staffId: 'teacher-b'
  }, '2026-08-11T12:00:00+09:00');
  assert.equal(legacyProposed.body.case.notificationNeeded, true);
  const legacyRemoved = await call(legacyDb, all, {
    action: 'no_makeup', caseId: legacyReviewed.caseId, revision: legacyProposed.body.case.revision
  });
  assert.equal(legacyRemoved.status, 200);
  assert.equal(legacyRemoved.body.case.notificationNeeded, false);
  assert.equal(legacyRemoved.body.case.notificationEvent, null);
  assert.equal(legacyRemoved.body.case.notificationEventRevision, 0);

  const raceDb = new TestD1(); seed(raceDb);
  const raceCreated = await call(raceDb, own('teacher-a'), {
    action: 'create_from_absence', sourceTaskId: 'lesson-a', sourceDate: '2026-08-10'
  });
  const raceScheduled = await callAt(raceDb, all, {
    action: 'schedule', caseId: raceCreated.body.case.caseId, revision: raceCreated.body.case.revision,
    date: '2026-08-12', startTime: '20:00', endTime: '21:00'
  }, '2026-08-11T12:00:00+09:00');
  const raceTaskId = 'makeup_lesson_' + raceCreated.body.case.caseId;
  raceDb.beforeBatch = () => raceDb.prepare(
    'INSERT INTO checks(app,k,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)'
  ).bind('task', raceTaskId + '|2026-08-12', 'teacher-a',
    JSON.stringify({ taskId: raceTaskId, date: '2026-08-12', att: 'P' }), 3, 3).run();
  const raced = await call(raceDb, all, {
    action: 'no_makeup', caseId: raceCreated.body.case.caseId, revision: raceScheduled.body.case.revision
  });
  assert.equal(raced.status, 409);
  assert.equal(raced.body.code, 'MAKEUP_LESSON_HAS_RECORDS');
  assert.equal(raceDb.database.prepare('SELECT status FROM makeup_cases WHERE case_id=?')
    .get(raceCreated.body.case.caseId).status, 'confirmed');

  const publicDb = new TestD1(); seed(publicDb);
  const publicCreated = await call(publicDb, own('teacher-a'), {
    action: 'create_from_absence', sourceTaskId: 'lesson-a', sourceDate: '2026-08-10'
  });
  const publicScheduled = await callAt(publicDb, all, {
    action: 'schedule', caseId: publicCreated.body.case.caseId, revision: publicCreated.body.case.revision,
    date: '2026-08-12', startTime: '20:00', endTime: '21:00'
  }, '2026-08-11T12:00:00+09:00');
  const publicTaskId = 'makeup_lesson_' + publicCreated.body.case.caseId;
  publicDb.prepare('INSERT INTO guardian_lesson_publications(app,publication_id,source_task_id,task_owner,student_id,' +
    'student_identity_hash,task_identity_hash,lesson_date,status,public_homework,public_readiness,revision,updated_at,updated_by) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind('task', 'publication-makeup', publicTaskId, 'teacher-a', 'student-a',
    'a'.repeat(64), 'b'.repeat(64), '2026-08-12', 'published', '숙제', '', 1, 2, 'teacher-a').run();
  const publicBlocked = await call(publicDb, all, {
    action: 'no_makeup', caseId: publicCreated.body.case.caseId, revision: publicScheduled.body.case.revision
  });
  assert.equal(publicBlocked.status, 409);
  assert.equal(publicBlocked.body.code, 'MAKEUP_LESSON_HAS_RECORDS');
});

test('attendance P correction cancels its active makeup and hides the corrected history', async () => {
  const db = new TestD1(); seed(db);
  const created = await call(db, own('teacher-a'), {
    action: 'create_from_absence', sourceTaskId: 'lesson-a', sourceDate: '2026-08-10'
  });
  const scheduled = await callAt(db, all, {
    action: 'schedule', caseId: created.body.case.caseId, revision: created.body.case.revision,
    date: '2026-08-12', startTime: '20:00', endTime: '21:00'
  }, '2026-08-11T12:00:00+09:00');
  db.prepare("UPDATE checks SET data=? WHERE k='lesson-a|2026-08-10'")
    .bind(JSON.stringify({ taskId: 'lesson-a', date: '2026-08-10', att: 'P' })).run();
  const reconciled = await call(db, own('teacher-a'), {
    action: 'reconcile_attendance', sourceTaskId: 'lesson-a', sourceDate: '2026-08-10'
  });
  assert.equal(reconciled.status, 200);
  assert.equal(reconciled.body.case.status, 'cancelled');
  assert.equal(reconciled.body.case.reason, 'already_resolved');
  assert.equal(reconciled.body.case.hiddenByAttendanceCorrection, true);
  assert.equal(reconciled.body.lessonTask.deleted, true);
  assert.equal(reconciled.body.case.history.at(-1).action, 'reconcile_attendance');
  assert.equal(scheduled.body.case.hiddenByAttendanceCorrection, false);

  db.prepare("UPDATE checks SET data=? WHERE k='lesson-a|2026-08-10'")
    .bind(JSON.stringify({ taskId: 'lesson-a', date: '2026-08-10', att: 'L' })).run();
  const rejected = await call(db, own('teacher-a'), {
    action: 'reconcile_attendance', sourceTaskId: 'lesson-a', sourceDate: '2026-08-10'
  });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.code, 'ATTENDANCE_CORRECTION_REQUIRED');

  db.prepare("UPDATE checks SET data=? WHERE k='lesson-a|2026-08-10'")
    .bind(JSON.stringify({ taskId: 'lesson-a', date: '2026-08-10', att: 'A' })).run();
  const reopened = await call(db, own('teacher-a'), {
    action: 'create_from_absence', sourceTaskId: 'lesson-a', sourceDate: '2026-08-10'
  });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.idempotent, false);
  assert.equal(reopened.body.case.status, 'review_pending');
  assert.equal(reopened.body.case.hiddenByAttendanceCorrection, false);
  assert.equal(reopened.body.case.history.at(-1).action, 'reopen_after_attendance_correction');
  assert.equal(reopened.body.lessonTask.deleted, true);
  const manuallyCancelled = await call(db, all, {
    action: 'no_makeup', caseId: reopened.body.case.caseId, revision: reopened.body.case.revision
  });
  assert.equal(manuallyCancelled.status, 200);
  assert.equal(manuallyCancelled.body.case.hiddenByAttendanceCorrection, false);
  const notReopened = await call(db, own('teacher-a'), {
    action: 'create_from_absence', sourceTaskId: 'lesson-a', sourceDate: '2026-08-10'
  });
  assert.equal(notReopened.status, 200);
  assert.equal(notReopened.body.idempotent, true);
  assert.equal(notReopened.body.case.status, 'cancelled');
  assert.equal(notReopened.body.case.hiddenByAttendanceCorrection, false);
});

test('attendance reconciliation cannot race a missing-task restore into an orphan active lesson', async () => {
  const db = new TestD1(); seed(db);
  const created = await call(db, own('teacher-a'), {
    action: 'create_from_absence', sourceTaskId: 'lesson-a', sourceDate: '2026-08-10'
  });
  db.prepare("UPDATE checks SET data=? WHERE k='lesson-a|2026-08-10'")
    .bind(JSON.stringify({ taskId: 'lesson-a', date: '2026-08-10', att: 'P' })).run();
  const taskId = 'makeup_lesson_' + created.body.case.caseId;
  db.beforeBatch = () => insertTask(db, lesson(taskId, 'student-a', 'teacher-a', [3], '20:00', '21:00', {
    repeat: 'once', start: '2026-08-12', end: '2026-08-12', lessonInstanceType: 'makeup',
    makeupCaseId: created.body.case.caseId, makeupSourceTaskId: 'lesson-a', makeupSourceDate: '2026-08-10'
  }));
  const raced = await call(db, own('teacher-a'), {
    action: 'reconcile_attendance', sourceTaskId: 'lesson-a', sourceDate: '2026-08-10'
  });
  assert.equal(raced.status, 409);
  assert.equal(raced.body.code, 'REVISION_CONFLICT');
  assert.equal(db.database.prepare('SELECT status FROM makeup_cases WHERE case_id=?').get(created.body.case.caseId).status,
    'review_pending');
  assert.equal(JSON.parse(db.database.prepare('SELECT data FROM tasks WHERE id=?').get(taskId).data).deleted, false);
});

test('attendance reconciliation atomically rejects a source-teacher transfer', async () => {
  const db = new TestD1(); seed(db);
  const created = await call(db, own('teacher-a'), {
    action: 'create_from_absence', sourceTaskId: 'lesson-a', sourceDate: '2026-08-10'
  });
  db.prepare("UPDATE checks SET data=? WHERE k='lesson-a|2026-08-10'")
    .bind(JSON.stringify({ taskId: 'lesson-a', date: '2026-08-10', att: 'P' })).run();
  db.beforeBatch = () => {
    const row = db.database.prepare("SELECT data FROM tasks WHERE id='lesson-a'").get();
    db.prepare("UPDATE tasks SET owner='teacher-b',data=?,updated_at=updated_at+1 WHERE id='lesson-a'")
      .bind(JSON.stringify({ ...JSON.parse(row.data), staffId: 'teacher-b' })).run();
  };
  const result = await call(db, own('teacher-a'), {
    action: 'reconcile_attendance', sourceTaskId: 'lesson-a', sourceDate: '2026-08-10'
  });
  assert.equal(result.status, 409);
  assert.equal(db.database.prepare('SELECT status FROM makeup_cases WHERE case_id=?').get(created.body.case.caseId).status,
    'review_pending');
});

test('legacy confirmed case exposes missing lesson and restores its deterministic task idempotently', async () => {
  const db = new TestD1(); seed(db);
  const reviewed = await createAndReview(db);
  const proposed = await callAt(db, all, {
    action: 'propose', caseId: reviewed.caseId, revision: reviewed.revision,
    date: '2026-08-12', startTime: '20:00', endTime: '21:00', staffId: 'teacher-b'
  }, '2026-08-11T12:00:00+09:00');
  db.prepare("UPDATE makeup_cases SET status='confirmed',confirmed_start_at=proposed_start_at," +
    "confirmed_end_at=proposed_end_at,confirmed_staff_id=proposed_staff_id WHERE case_id=?")
    .bind(reviewed.caseId).run();
  const listed = await call(db, all, { action: 'list' });
  assert.equal(listed.body.cases[0].hasLessonTask, false);
  const restored = await call(db, all, {
    action: 'restore_schedule', caseId: reviewed.caseId, revision: proposed.body.case.revision
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.case.hasLessonTask, true);
  assert.equal(restored.body.case.revision, proposed.body.case.revision);
  assert.equal(restored.body.lessonTask.staffId, 'teacher-b');
  const retry = await call(db, all, {
    action: 'restore_schedule', caseId: reviewed.caseId, revision: proposed.body.case.revision
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.idempotent, true);

  const taskId = 'makeup_lesson_' + reviewed.caseId;
  const taskRow = db.database.prepare('SELECT data FROM tasks WHERE id=?').get(taskId);
  db.prepare('UPDATE tasks SET data=?,updated_at=updated_at+1,srv_at=srv_at+1 WHERE id=?')
    .bind(JSON.stringify({ ...JSON.parse(taskRow.data), deleted: true }), taskId).run();
  const revived = await call(db, all, {
    action: 'restore_schedule', caseId: reviewed.caseId, revision: proposed.body.case.revision
  });
  assert.equal(revived.status, 200);
  assert.equal(revived.body.idempotent, false);
  assert.equal(revived.body.lessonTask.deleted, false);
  assert.equal(revived.body.case.hasLessonTask, true);

  const revivedRow = db.database.prepare('SELECT data FROM tasks WHERE id=?').get(taskId);
  db.prepare('UPDATE tasks SET data=?,updated_at=updated_at+1,srv_at=srv_at+1 WHERE id=?')
    .bind(JSON.stringify({ ...JSON.parse(revivedRow.data), deleted: true }), taskId).run();
  db.prepare('INSERT INTO checks(app,k,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', taskId + '|2026-08-12', 'teacher-b',
      JSON.stringify({ taskId, date: '2026-08-12', att: 'P' }), 3, 3).run();
  const blocked = await call(db, all, {
    action: 'restore_schedule', caseId: reviewed.caseId, revision: proposed.body.case.revision
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'MAKEUP_LESSON_HAS_RECORDS');
  const blockedRow = db.database.prepare('SELECT data FROM tasks WHERE id=?').get(taskId);
  db.prepare('UPDATE tasks SET data=?,updated_at=updated_at+1,srv_at=srv_at+1 WHERE id=?')
    .bind(JSON.stringify({ ...JSON.parse(blockedRow.data), deleted: false, makeupSourceDate: '2026-08-09' }), taskId).run();
  const collisionList = await call(db, all, { action: 'list' });
  assert.equal(collisionList.body.cases[0].hasLessonTask, false);
});

test('legacy restore atomically rejects a regular lesson inserted after its initial check', async () => {
  const db = new TestD1(); seed(db);
  const reviewed = await createAndReview(db);
  const proposed = await callAt(db, all, {
    action: 'propose', caseId: reviewed.caseId, revision: reviewed.revision,
    date: '2026-08-12', startTime: '20:00', endTime: '21:00', staffId: 'teacher-b'
  }, '2026-08-11T12:00:00+09:00');
  db.prepare("UPDATE makeup_cases SET status='confirmed',confirmed_start_at=proposed_start_at," +
    "confirmed_end_at=proposed_end_at,confirmed_staff_id=proposed_staff_id WHERE case_id=?")
    .bind(reviewed.caseId).run();
  db.beforeBatch = () => insertTask(db,
    lesson('restore-race', 'student-a', 'teacher-a', [3], '20:30', '21:30'));
  const blocked = await call(db, all, {
    action: 'restore_schedule', caseId: reviewed.caseId, revision: proposed.body.case.revision
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'STUDENT_SCHEDULE_CONFLICT');
  assert.equal(db.database.prepare("SELECT count(*) AS n FROM tasks WHERE id LIKE 'makeup_lesson_%'").get().n, 0);
});

test('unconfirmed operations follow the source lesson current owner while retaining historical source teacher', async () => {
  const db = new TestD1(); seed(db);
  const created = await call(db, own('teacher-a'), {
    action: 'create_from_absence', sourceTaskId: 'lesson-a', sourceDate: '2026-08-10'
  });
  const original = db.database.prepare("SELECT data FROM tasks WHERE id='lesson-a'").get();
  const transferred = { ...JSON.parse(original.data), staffId: 'teacher-b' };
  db.prepare("UPDATE tasks SET owner='teacher-b',data=?,updated_at=2,srv_at=2 WHERE id='lesson-a'")
    .bind(JSON.stringify(transferred)).run();
  const listed = await call(db, own('teacher-b'), { action: 'list' });
  assert.equal(listed.body.cases[0].sourceTeacherId, 'teacher-a');
  assert.equal(listed.body.cases[0].currentTeacherId, 'teacher-b');
  const completed = await callAt(db, own('teacher-b'), {
    action: 'complete', caseId: created.body.case.caseId, revision: created.body.case.revision,
    date: '2026-08-11', startTime: '10:00', endTime: '11:00'
  }, '2026-08-11T12:00:00+09:00');
  assert.equal(completed.status, 200);
  assert.equal(completed.body.lessonTask.staffId, 'teacher-b');
});

test('list bulk-loads source and generated lessons in bounded chunks', async () => {
  const db = new TestD1(); seed(db);
  for (let index = 0; index < 161; index++) {
    const taskId = 'bulk-' + index;
    insertTask(db, lesson(taskId, 'student-a', 'teacher-a', [1], '18:00', '19:00'));
    const digest = await sha256('task\n' + taskId + '\n2026-08-10');
    db.prepare('INSERT INTO makeup_cases(app,case_id,student_id,source_task_id,source_date,source_teacher_id,' +
      'consumption_group_id,status,revision,notification_needed,notification_event_revision,history,created_at,updated_at) ' +
      "VALUES(?,?,?,?,?,?,?,'review_pending',1,0,0,'[]',1,1)")
      .bind('task', 'mu_' + digest.slice(0, 48), 'student-a', taskId, '2026-08-10', 'teacher-a',
        'mc_' + digest.slice(0, 48)).run();
  }
  db.taskBulkReads = 0;
  const listed = await call(db, all, { action: 'list', limit: 200 });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.cases.length, 161);
  assert.equal(db.taskBulkReads, 6);
});

test('latest parent response is visible and a same-revision decline blocks confirmation', async () => {
  const db = new TestD1(); db.database.exec(portalMigration); seed(db);
  const reviewed = await createAndReview(db);
  const proposed = await call(db, all, { action: 'propose', caseId: reviewed.caseId, revision: reviewed.revision,
    date: '2026-08-12', startTime: '20:00', endTime: '21:00', staffId: 'teacher-b' });
  const revision = proposed.body.case.revision;
  db.prepare(
    'INSERT INTO guardian_portal_responses(app,response_id,student_id,object_type,object_id,revision,response,created_at) ' +
    'VALUES(?,?,?,?,?,?,?,?)'
  ).bind('task', 'response-a', 'student-a', 'makeup', reviewed.caseId, revision, 'decline', 10).run();
  const listed = await call(db, own('teacher-a'), { action: 'list' });
  assert.equal(listed.body.cases[0].parentResponse, 'decline');
  assert.equal(listed.body.cases[0].parentResponseRevision, revision);
  assert.equal(listed.body.cases[0].parentRespondedAt, 10);
  const declined = await call(db, all, { action: 'confirm', caseId: reviewed.caseId, revision });
  assert.equal(declined.status, 409);
  assert.equal(declined.body.code, 'PARENT_DECLINED');
  assert.throws(() => db.prepare(
    "UPDATE makeup_cases SET status='confirmed',revision=revision+1,confirmed_start_at=proposed_start_at," +
    "confirmed_end_at=proposed_end_at,confirmed_staff_id=proposed_staff_id WHERE app='task' AND case_id=?"
  ).bind(reviewed.caseId).run(), /PARENT_DECLINED/,
  '사전 조회 뒤 decline이 들어오는 경합도 DB trigger가 막아야 한다');
});

test('list and confirm fail closed when guardian response operations are unavailable', async () => {
  const missing = new TestD1(); seed(missing);
  await call(missing, own('teacher-a'), { action: 'create_from_absence', sourceTaskId: 'lesson-a', sourceDate: '2026-08-10' });
  missing.database.exec('DROP TABLE guardian_portal_responses');
  const list = await call(missing, own('teacher-a'), { action: 'list' });
  assert.equal(list.status, 503);
  assert.equal(list.body.code, 'OPERATIONS_NOT_READY');

  const failed = new TestD1(); seed(failed);
  const reviewed = await createAndReview(failed);
  const proposed = await callAt(failed, all, { action: 'propose', caseId: reviewed.caseId, revision: reviewed.revision,
    date: '2026-08-12', startTime: '20:00', endTime: '21:00', staffId: 'teacher-b' },
  '2026-08-11T12:00:00+09:00');
  assert.equal(proposed.status, 200);
  failed.failGuardianReads = 'current';
  const confirm = await callAt(failed, all, { action: 'confirm', caseId: reviewed.caseId,
    revision: proposed.body.case.revision }, '2026-08-11T12:01:00+09:00');
  assert.equal(confirm.status, 503);
  assert.equal(confirm.body.code, 'OPERATIONS_NOT_READY');
  assert.equal(failed.database.prepare('SELECT status FROM makeup_cases WHERE case_id=?').get(reviewed.caseId).status,
    'awaiting_parent');
});

test('proposal and confirmation reject a slot whose end time already passed', async () => {
  const proposeDb = new TestD1(); seed(proposeDb);
  const reviewed = await createAndReview(proposeDb);
  const endedProposal = await callAt(proposeDb, all, { action: 'propose', caseId: reviewed.caseId,
    revision: reviewed.revision, date: '2026-08-12', startTime: '20:00', endTime: '21:00',
    staffId: 'teacher-b' }, '2026-08-12T21:00:00+09:00');
  assert.equal(endedProposal.status, 409);
  assert.equal(endedProposal.body.code, 'MAKEUP_SLOT_ENDED');

  const confirmDb = new TestD1(); seed(confirmDb);
  const ready = await createAndReview(confirmDb);
  const proposed = await callAt(confirmDb, all, { action: 'propose', caseId: ready.caseId,
    revision: ready.revision, date: '2026-08-12', startTime: '20:00', endTime: '21:00',
    staffId: 'teacher-b' }, '2026-08-11T12:00:00+09:00');
  assert.equal(proposed.status, 200);
  const endedConfirmation = await callAt(confirmDb, all, { action: 'confirm', caseId: ready.caseId,
    revision: proposed.body.case.revision }, '2026-08-12T21:00:00+09:00');
  assert.equal(endedConfirmation.status, 409);
  assert.equal(endedConfirmation.body.code, 'MAKEUP_SLOT_ENDED');
});

test('complete atomically appends a delta-one active-pack usage and a retry cannot duplicate it', async () => {
  const db = new TestD1(); seed(db); await insertPack(db);
  const reviewed = await createAndReview(db);
  const confirmed = await proposeAndConfirm(db, reviewed);
  const completed = await callAt(db, manager('teacher-b'), { action: 'complete', caseId: confirmed.caseId,
    revision: confirmed.revision }, '2026-08-12T20:55:00+09:00');
  assert.equal(completed.status, 200);
  assert.deepEqual(completed.body.sessionPackImpact,
    { status: 'recorded', packId: 'pack-a', delta: 1, packRevision: 2, refreshNeeded: true });
  assert.deepEqual(completed.body.case.history.at(-1).sessionPackImpact, completed.body.sessionPackImpact);
  const storedHistory = JSON.parse(db.database.prepare(
    "SELECT history FROM makeup_cases WHERE app='task' AND case_id=?"
  ).get(confirmed.caseId).history);
  assert.deepEqual(storedHistory.at(-1).sessionPackImpact, completed.body.sessionPackImpact);
  const usage = db.database.prepare(
    "SELECT source_type,source_ref,attendance_event,delta,consumption_group_id,reason_code FROM session_pack_usage WHERE app='task'"
  ).all();
  assert.equal(usage.length, 1);
  assert.equal(usage[0].source_type, 'makeup');
  assert.equal(usage[0].source_ref, confirmed.caseId);
  assert.equal(usage[0].attendance_event, 'makeup_completed');
  assert.equal(usage[0].delta, 1);
  assert.equal(usage[0].consumption_group_id, confirmed.consumptionGroupId);
  assert.equal(usage[0].reason_code, 'makeup_atomic_v1');
  assert.equal(db.database.prepare("SELECT revision FROM session_packs WHERE pack_id='pack-a'").get().revision, 2);

  const retry = await callAt(db, manager('teacher-b'), { action: 'complete', caseId: confirmed.caseId,
    revision: confirmed.revision }, '2026-08-12T20:56:00+09:00');
  assert.equal(retry.status, 409);
  assert.equal(retry.body.code, 'REVISION_CONFLICT');
  assert.equal(db.database.prepare("SELECT count(*) AS n FROM session_pack_usage WHERE source_ref=?")
    .get(confirmed.caseId).n, 1);
});

test('complete appends delta zero when the original absence already consumed the same group', async () => {
  const db = new TestD1(); seed(db); await insertPack(db);
  const reviewed = await createAndReview(db);
  insertUsage(db, 'pack-a', 1, 'lesson-a|2026-08-10', '2026-08-10', 1, reviewed.consumptionGroupId);
  const confirmed = await proposeAndConfirm(db, reviewed);
  const completed = await callAt(db, own('teacher-b'), { action: 'complete', caseId: confirmed.caseId,
    revision: confirmed.revision }, '2026-08-12T20:55:00+09:00');
  assert.equal(completed.status, 200);
  assert.equal(completed.body.sessionPackImpact.delta, 0);
  assert.equal(completed.body.sessionPackImpact.packRevision, 3);
  const rows = db.database.prepare(
    "SELECT source_type,delta FROM session_pack_usage WHERE pack_id='pack-a' ORDER BY created_at,entry_id"
  ).all();
  assert.deepEqual(rows.map(row => [row.source_type, row.delta]), [['regular', 1], ['makeup', 0]]);
  assert.equal(db.database.prepare(
    "SELECT COALESCE(SUM(delta),0) AS used FROM session_pack_usage WHERE pack_id='pack-a'"
  ).get().used, 1);
});

test('complete preserves the makeup but skips automatic usage when the active pack identity is stale', async () => {
  for (const mismatch of ['assignment_key', 'task_teacher_transfer']) {
    const db = new TestD1(); seed(db); await insertPack(db);
    const reviewed = await createAndReview(db);
    const confirmed = await proposeAndConfirm(db, reviewed);
    if (mismatch === 'assignment_key') {
      const row = db.database.prepare("SELECT data FROM tasks WHERE app='task' AND id='lesson-a'").get();
      const task = JSON.parse(row.data);
      task.lessonAssignmentKey = 'sha256:changed-assignment';
      db.prepare("UPDATE tasks SET data=? WHERE app='task' AND id='lesson-a'").bind(JSON.stringify(task)).run();
    } else {
      const row = db.database.prepare("SELECT data FROM tasks WHERE app='task' AND id='lesson-a'").get();
      const task = JSON.parse(row.data);
      task.staffId = 'teacher-b';
      db.prepare("UPDATE tasks SET owner='teacher-b',data=? WHERE app='task' AND id='lesson-a'")
        .bind(JSON.stringify(task)).run();
    }

    const completed = await callAt(db, manager('teacher-b'), { action: 'complete', caseId: confirmed.caseId,
      revision: confirmed.revision }, '2026-08-12T20:55:00+09:00');
    assert.equal(completed.status, 200, mismatch);
    assert.equal(completed.body.case.status, 'completed', mismatch);
    assert.deepEqual(completed.body.sessionPackImpact,
      { status: 'not_applicable', reason: 'pack_identity_mismatch', refreshNeeded: false }, mismatch);
    assert.equal(db.database.prepare("SELECT count(*) AS n FROM session_pack_usage WHERE pack_id='pack-a'").get().n,
      0, mismatch);
    assert.equal(db.database.prepare("SELECT revision FROM session_packs WHERE pack_id='pack-a'").get().revision,
      1, mismatch);
  }
});

test('transaction-time source assignment or teacher races block completion without charging the stale pack', async () => {
  for (const race of ['assignment_key', 'task_teacher_transfer']) {
    const db = new TestD1(); seed(db); await insertPack(db);
    const reviewed = await createAndReview(db);
    const confirmed = await proposeAndConfirm(db, reviewed);
    db.beforeBatch = () => {
      if (race === 'assignment_key') {
        const row = db.database.prepare("SELECT data FROM tasks WHERE app='task' AND id='lesson-a'").get();
        const task = JSON.parse(row.data);
        task.lessonAssignmentKey = 'sha256:raced-assignment';
        db.prepare("UPDATE tasks SET data=? WHERE app='task' AND id='lesson-a'").bind(JSON.stringify(task)).run();
      } else {
        const row = db.database.prepare("SELECT data FROM tasks WHERE app='task' AND id='lesson-a'").get();
        const task = JSON.parse(row.data);
        task.staffId = 'teacher-b';
        db.prepare("UPDATE tasks SET owner='teacher-b',data=? WHERE app='task' AND id='lesson-a'")
          .bind(JSON.stringify(task)).run();
      }
    };

    const completed = await callAt(db, manager('teacher-b'), { action: 'complete', caseId: confirmed.caseId,
      revision: confirmed.revision }, '2026-08-12T20:55:00+09:00');
    assert.equal(completed.status, 409, race);
    assert.equal(db.database.prepare("SELECT status FROM makeup_cases WHERE case_id=?").get(confirmed.caseId).status,
      'confirmed', race);
    assert.equal(db.database.prepare("SELECT count(*) AS n FROM session_pack_usage WHERE pack_id='pack-a'").get().n,
      0, race);
    assert.equal(db.database.prepare("SELECT revision FROM session_packs WHERE pack_id='pack-a'").get().revision,
      1, race);
  }
});

test('makeup CAS, pack revision, and balance failures roll back both complete and automatic usage', async () => {
  for (const failure of ['makeup_revision', 'pack_revision', 'balance']) {
    const db = new TestD1(); seed(db); await insertPack(db, { totalSessions: 1 });
    const reviewed = await createAndReview(db);
    const confirmed = await proposeAndConfirm(db, reviewed);
    if (failure === 'makeup_revision') {
      db.beforeBatch = () => db.prepare(
        "UPDATE makeup_cases SET revision=revision+1,updated_at=updated_at+1 WHERE app='task' AND case_id=?"
      ).bind(confirmed.caseId).run();
    } else if (failure === 'pack_revision') {
      db.beforeBatch = () => db.prepare(
        "UPDATE session_packs SET revision=revision+1,updated_at=updated_at+1,updated_by='race' WHERE app='task' AND pack_id='pack-a'"
      ).run();
    } else {
      insertUsage(db, 'pack-a', 1, 'other-source', '2026-08-09', 1, 'mc_' + 'f'.repeat(48));
    }
    const result = await callAt(db, manager('teacher-b'), { action: 'complete', caseId: confirmed.caseId,
      revision: confirmed.revision }, '2026-08-12T20:55:00+09:00');
    assert.equal(result.status, 409, failure);
    assert.equal(result.body.code, failure === 'makeup_revision' ? 'REVISION_CONFLICT' :
      failure === 'pack_revision' ? 'SESSION_PACK_REVISION_CONFLICT' : 'BALANCE_INVALID');
    const current = db.database.prepare('SELECT status,revision FROM makeup_cases WHERE case_id=?').get(confirmed.caseId);
    assert.equal(current.status, 'confirmed', failure);
    assert.equal(current.revision, confirmed.revision + (failure === 'makeup_revision' ? 1 : 0), failure);
    assert.equal(db.database.prepare("SELECT count(*) AS n FROM session_pack_usage WHERE source_ref=?")
      .get(confirmed.caseId).n, 0, failure);
  }
});

test('active pack outside the source date is explicitly not applicable', async () => {
  const db = new TestD1(); seed(db);
  await insertPack(db, { validFrom: '2026-08-11', expiresOn: '2026-08-31' });
  const reviewed = await createAndReview(db);
  const confirmed = await proposeAndConfirm(db, reviewed);
  const completed = await callAt(db, own('teacher-b'), { action: 'complete', caseId: confirmed.caseId,
    revision: confirmed.revision }, '2026-08-12T20:55:00+09:00');
  assert.equal(completed.status, 200);
  assert.deepEqual(completed.body.sessionPackImpact,
    { status: 'not_applicable', reason: 'source_date_out_of_range', refreshNeeded: false });
  assert.equal(db.database.prepare('SELECT count(*) AS n FROM session_pack_usage').get().n, 0);
});

test('confirm maps a database-time parent decline race to PARENT_DECLINED', async () => {
  const db = new TestD1(); db.database.exec(portalMigration); seed(db);
  const reviewed = await createAndReview(db);
  const proposed = await call(db, all, { action: 'propose', caseId: reviewed.caseId, revision: reviewed.revision,
    date: '2026-08-12', startTime: '20:00', endTime: '21:00', staffId: 'teacher-b' });
  db.database.exec("CREATE TRIGGER test_parent_decline_race BEFORE UPDATE OF status ON makeup_cases " +
    "WHEN NEW.status='confirmed' BEGIN SELECT RAISE(ABORT,'PARENT_DECLINED'); END;");
  const result = await call(db, all, { action: 'confirm', caseId: reviewed.caseId,
    revision: proposed.body.case.revision });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'PARENT_DECLINED');
});

test('proposal validates KST date/time, active roster/staff, and regular student/teacher conflicts', async () => {
  const db = new TestD1(); seed(db);
  insertTask(db, lesson('student-conflict', 'student-a', 'teacher-a', [3], '16:00', '17:00'));
  insertTask(db, lesson('teacher-conflict', 'student-b', 'teacher-b', [3], '18:00', '19:00'));
  const reviewed = await createAndReview(db);
  const invalidIso = await call(db, all, { action: 'propose', caseId: reviewed.caseId, revision: reviewed.revision,
    date: '2026-02-30', startTime: '16:30', endTime: '17:30', staffId: 'teacher-b' });
  assert.equal(invalidIso.status, 400);
  const studentConflict = await call(db, all, { action: 'propose', caseId: reviewed.caseId, revision: reviewed.revision,
    date: '2026-08-12', startTime: '16:30', endTime: '17:30', staffId: 'teacher-b' });
  assert.equal(studentConflict.status, 409);
  assert.equal(studentConflict.body.code, 'STUDENT_SCHEDULE_CONFLICT');
  const staffConflict = await call(db, all, { action: 'propose', caseId: reviewed.caseId, revision: reviewed.revision,
    date: '2026-08-12', startTime: '18:30', endTime: '19:30', staffId: 'teacher-b' });
  assert.equal(staffConflict.status, 409);
  assert.equal(staffConflict.body.code, 'STAFF_SCHEDULE_CONFLICT');
  const inactiveStaff = await call(db, all, { action: 'propose', caseId: reviewed.caseId, revision: reviewed.revision,
    date: '2026-08-12', startTime: '20:00', endTime: '21:00', staffId: 'teacher-inactive' });
  assert.equal(inactiveStaff.status, 409);
  assert.equal(inactiveStaff.body.code, 'STAFF_INACTIVE');

  const ended = roster(); ended.roster.students[0].end = '2026-08';
  db.prepare("UPDATE private_rosters SET data=? WHERE app='task'").bind(JSON.stringify(ended)).run();
  const inactiveStudent = await call(db, all, { action: 'propose', caseId: reviewed.caseId, revision: reviewed.revision,
    date: '2026-08-12', startTime: '20:00', endTime: '21:00', staffId: 'teacher-b' });
  assert.equal(inactiveStudent.status, 409);
  assert.equal(inactiveStudent.body.code, 'STUDENT_INACTIVE');
});

test('confirmed makeup conflicts are rechecked and cancel needs a reason', async () => {
  const db = new TestD1(); seed(db);
  const caseB = await createAndReview(db, 'lesson-b', '2026-08-11', own('teacher-b'));
  const proposedB = await call(db, all, { action: 'propose', caseId: caseB.caseId, revision: caseB.revision,
    date: '2026-08-12', startTime: '20:00', endTime: '21:00', staffId: 'teacher-b' });
  const confirmedB = await call(db, all, { action: 'confirm', caseId: caseB.caseId, revision: proposedB.body.case.revision });
  assert.equal(confirmedB.status, 200);
  const caseA = await createAndReview(db);
  const conflict = await call(db, all, { action: 'propose', caseId: caseA.caseId, revision: caseA.revision,
    date: '2026-08-12', startTime: '20:30', endTime: '21:30', staffId: 'teacher-b' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'STAFF_MAKEUP_CONFLICT');
  const noReason = await call(db, all, { action: 'cancel', caseId: caseA.caseId, revision: caseA.revision, reason: '' });
  assert.equal(noReason.status, 400);
  const sensitiveFreeText = await call(db, all, { action: 'cancel', caseId: caseA.caseId,
    revision: caseA.revision, reason: '건강 관련 상세 사유' });
  assert.equal(sensitiveFreeText.status, 400);
  const coded = await call(db, all, { action: 'cancel', caseId: caseA.caseId,
    revision: caseA.revision, reason: 'schedule_unavailable' });
  assert.equal(coded.status, 200);
});

test('database trigger closes the concurrent-confirmation race between different cases', async () => {
  const db = new TestD1(); seed(db);
  const caseA = await createAndReview(db);
  const caseB = await createAndReview(db, 'lesson-b', '2026-08-11', own('teacher-b'));
  for (const item of [caseA, caseB]) {
    const proposed = await call(db, all, { action: 'propose', caseId: item.caseId, revision: item.revision,
      date: '2026-08-12', startTime: '20:00', endTime: '21:00', staffId: 'teacher-b' });
    assert.equal(proposed.status, 200);
  }
  const sql = "UPDATE makeup_cases SET status='confirmed',confirmed_start_at=proposed_start_at," +
    "confirmed_end_at=proposed_end_at,confirmed_staff_id=proposed_staff_id WHERE app='task' AND case_id=?";
  db.prepare(sql).bind(caseA.caseId).run();
  assert.throws(() => db.prepare(sql).bind(caseB.caseId).run(), /MAKEUP_TIME_CONFLICT/);
});

test('unknown and PII-shaped fields are rejected and never stored', async () => {
  const db = new TestD1(); seed(db);
  const rejected = await call(db, own('teacher-a'), { action: 'create_from_absence', sourceTaskId: 'lesson-a',
    sourceDate: '2026-08-10', phone: '01012345678' });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /허용되지 않은/);
  assert.equal(db.database.prepare('SELECT count(*) AS n FROM makeup_cases').get().n, 0);
});
