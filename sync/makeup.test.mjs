import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handleMakeup } from './makeup.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/025_makeup.sql', import.meta.url), 'utf8');
const sessionMigration = fs.readFileSync(new URL('./migrations/026_session_packs.sql', import.meta.url), 'utf8');
const portalMigration = fs.readFileSync(new URL('./migrations/027_parent_portal.sql', import.meta.url), 'utf8');

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
    this.beforeBatch = null;
    this.failGuardianReads = false;
  }
  prepare(sql) {
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
    revision: confirmed.body.case.revision }, '2026-08-12T20:55:00+09:00');
  assert.equal(rootAdmin.status, 403);
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

test('transaction-time assignment or task teacher identity races complete without charging the stale pack', async () => {
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
    assert.equal(completed.status, 200, race);
    assert.equal(completed.body.case.status, 'completed', race);
    assert.deepEqual(completed.body.sessionPackImpact,
      { status: 'not_applicable', reason: 'pack_identity_mismatch', refreshNeeded: false }, race);
    assert.deepEqual(completed.body.case.history.at(-1).sessionPackImpact,
      { status: 'not_applicable', reason: 'pack_identity_mismatch', refreshNeeded: false }, race);
    const storedHistory = JSON.parse(db.database.prepare(
      "SELECT history FROM makeup_cases WHERE app='task' AND case_id=?"
    ).get(confirmed.caseId).history);
    assert.deepEqual(storedHistory.at(-1).sessionPackImpact,
      { status: 'not_applicable', reason: 'pack_identity_mismatch', refreshNeeded: false }, race);
    assert.equal(JSON.stringify(completed.body).includes('"status":"recorded"'), false, race);
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
