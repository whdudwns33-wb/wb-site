import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import worker from './worker-core.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const FIXTURE_NOW = Date.parse('2026-09-08T16:00:00+09:00');
const STORED_AT = FIXTURE_NOW - 1000;
const admin = { mode: 'admin', secret: 'test-director-secret' };
const person = id => ({ mode: 'person', id, token: 'token-' + id });

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  first() {
    this.db.reads.push(this.sql);
    return this.db.database.prepare(this.sql).get(...this.args) || null;
  }
  all() {
    this.db.reads.push(this.sql);
    return { results: this.db.database.prepare(this.sql).all(...this.args) };
  }
  run() {
    const result = this.db.database.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(result.changes || 0) } };
  }
}

class TestD1 {
  constructor() {
    this.database = new DatabaseSync(':memory:');
    this.database.exec(schema);
    this.beforeBatch = null;
    this.reads = [];
    this.batches = [];
  }
  prepare(sql) { return new Statement(this, sql); }
  batch(statements) {
    this.batches.push(statements.map(statement => statement.sql));
    if (this.beforeBatch) {
      const hook = this.beforeBatch; this.beforeBatch = null; hook();
    }
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

async function call(db, path, body) {
  const previousNow = Date.now;
  Date.now = () => FIXTURE_NOW;
  try {
    const response = await worker.fetch(new Request('https://worker.example' + path, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: 'task', ...body })
    }), { DB: db, TASK_ADMIN_SECRET: 'test-director-secret', TASK_MANAGER_STAFF_IDS: 'manager-a' });
    return { status: response.status, body: await response.json() };
  } finally { Date.now = previousNow; }
}

function seed(db) {
  for (const id of ['teacher-a', 'teacher-b', 'manager-a']) {
    db.prepare('INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
      .bind('task', id, id, JSON.stringify({ id, name: id, deleted: false, manager: id === 'manager-a' }), STORED_AT, STORED_AT).run();
    db.prepare('INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)')
      .bind('task', 'token-' + id, id, STORED_AT).run();
  }
  db.prepare('INSERT INTO private_rosters(app,data,updated_at) VALUES(?,?,?)').bind('task', JSON.stringify({
    roster: { updated: '2026-09-08', baseline: '2026-08', students: [
      { id: 'student-a', name: '예시학생', grade: '초6', teacher: '예시선생', subject: '수학',
        start: '2026-08', end: '', reason: '', teacherIds: ['teacher-a'] }
    ] }, bookStudents: []
  }), STORED_AT).run();
  const task = {
    id: 'lesson-a', staffId: 'teacher-a', studentId: 'student-a',
    title: '[수업] 예시학생', taskKind: 'lesson_instruction', lessonFormVersion: 1,
    origin: 'staff', lessonRevision: 3, repeat: 'days', days: [6],
    start: '2026-08-01', end: '', time: '10:00', deleted: false,
    scheduleStatus: 'confirmed', scheduleSlots: [{ days: [6], startTime: '10:00', endTime: '11:00' }],
    guide: '자체 창작 수업 안내', createdAt: STORED_AT, updatedAt: STORED_AT
  };
  insertTask(db, task);
  insertTask(db, { ...task, id: 'lesson-unrelated', staffId: 'teacher-b', days: [5],
    scheduleSlots: [{ days: [5], startTime: '18:00', endTime: '19:00' }] });
  insertCheck(db, 'lesson-a', 'teacher-a', '2026-08-29', 'P');
  return task;
}

function insertTask(db, task) {
  db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', task.id, task.staffId, JSON.stringify(task), STORED_AT, STORED_AT).run();
}

function insertCheck(db, taskId, staffId, date, att) {
  db.prepare('INSERT INTO checks(app,k,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', taskId + '|' + date, staffId,
      JSON.stringify({ taskId, date, att, note: '보존해야 할 자체 창작 수업 메모' }), STORED_AT, STORED_AT).run();
}

function stopRequest(overrides = {}) {
  return { auth: admin, taskId: 'lesson-a', studentId: 'student-a', staffId: 'teacher-a',
    expectedUpdatedAt: STORED_AT, ...overrides };
}

function taskData(db, id = 'lesson-a') {
  return JSON.parse(db.prepare('SELECT data FROM tasks WHERE app=? AND id=?').bind('task', id).first().data);
}

function seedMakeup(db, caseId = 'mu_stop', sourceTaskId = 'lesson-a', status = 'confirmed') {
  const taskId = 'makeup_lesson_' + caseId;
  db.prepare('INSERT INTO makeup_cases(app,case_id,student_id,source_task_id,source_date,source_teacher_id,' +
    'consumption_group_id,status,revision,confirmed_start_at,confirmed_end_at,confirmed_staff_id,history,created_at,updated_at) ' +
    'VALUES(?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)')
    .bind('task', caseId, 'student-a', sourceTaskId, '2026-08-29', 'teacher-a', 'mc_' + caseId,
      status,
      '2026-09-13T20:00:00+09:00', '2026-09-13T21:00:00+09:00', 'teacher-a',
      JSON.stringify([{ action: 'create_from_absence', revision: 1, at: STORED_AT }]), STORED_AT, STORED_AT).run();
  insertTask(db, {
    id: taskId, staffId: 'teacher-a', studentId: 'student-a', taskKind: 'lesson_instruction', lessonFormVersion: 1,
    lessonInstanceType: 'makeup', makeupCaseId: caseId, makeupSourceTaskId: sourceTaskId, makeupSourceDate: '2026-08-29',
    repeat: 'once', start: '2026-09-13', end: '2026-09-13', days: [0], deleted: false, updatedAt: STORED_AT
  });
  insertCheck(db, taskId, 'teacher-a', '2026-09-13', 'P');
  return taskId;
}

test('lesson stop requires administrator authentication and exact target identity and version', async () => {
  const db = new TestD1(); seed(db);
  const denied = [
    [stopRequest({ auth: undefined }), 401],
    [stopRequest({ auth: person('teacher-a') }), 403],
    [stopRequest({ auth: person('teacher-b') }), 403],
    [stopRequest({ studentId: 'student-b' }), 409],
    [stopRequest({ staffId: 'teacher-b' }), 409],
    [stopRequest({ expectedUpdatedAt: STORED_AT - 1 }), 409],
    [stopRequest({ expectedUpdatedAt: String(STORED_AT) }), 400],
    [stopRequest({ taskId: '../lesson-a' }), 400],
    [stopRequest({ deleted: true }), 400]
  ];
  for (const [request, status] of denied) {
    const response = await call(db, '/lesson-stop', request);
    assert.equal(response.status, status, JSON.stringify(response.body));
  }
  assert.equal(taskData(db).deleted, false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM student_change_events').first().n, 0);
  assert.equal(db.batches.length, 0);
});

test('administrator stop publishes a tombstone, keeps records, and retries without duplicate audit or revision', async () => {
  const db = new TestD1(); const original = seed(db);
  const records = db.prepare('SELECT * FROM checks').all().results;
  const stopped = await call(db, '/lesson-stop', stopRequest());
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  assert.equal(stopped.body.idempotent, false);
  assert.equal(stopped.body.task.deleted, true);
  assert.equal(stopped.body.task.end, '2026-09-08');
  assert.equal(stopped.body.task.updatedAt, FIXTURE_NOW);
  assert.equal(stopped.body.task.lessonRevision, 4);
  assert.equal(stopped.body.task.guide, original.guide);
  assert.equal(stopped.body.studentScheduleRevision, 1);
  assert.equal(taskData(db, 'lesson-unrelated').deleted, false);
  assert.deepEqual(db.prepare('SELECT * FROM checks').all().results, records);
  const event = db.prepare('SELECT * FROM student_change_events').first();
  assert.equal(event.event_type, 'lesson_delete');
  assert.equal(event.changed_by, 'director');
  assert.equal(event.requires_ack, 0);
  assert.equal(JSON.parse(event.details).source, 'instruction_list_stop');
  const retry = await call(db, '/lesson-stop', stopRequest());
  assert.equal(retry.status, 200);
  assert.equal(retry.body.idempotent, true);
  assert.equal(retry.body.studentScheduleRevision, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM student_change_events').first().n, 1);
  const revisionRead = db.reads.findIndex(sql => sql.startsWith('SELECT student_id,revision FROM student_schedule_revisions'));
  const taskRead = db.reads.findIndex(sql => sql.startsWith('SELECT owner,data,updated_at FROM tasks'));
  assert.ok(revisionRead >= 0 && taskRead > revisionRead);
  assert.match(db.batches[0][0], /^INSERT OR IGNORE INTO student_schedule_revisions/);
  assert.match(db.batches[0][1], /^UPDATE student_schedule_revisions SET revision=revision\+1/);
});

test('manager stop records the authenticated manager and cannot directly stop generated makeups', async () => {
  const db = new TestD1(); seed(db);
  const taskId = seedMakeup(db, 'mu_stop', 'lesson-unrelated');
  const forbidden = await call(db, '/lesson-stop', stopRequest({ taskId, auth: person('manager-a') }));
  assert.equal(forbidden.status, 409);
  assert.equal(forbidden.body.code, 'LESSON_IDENTITY_MISMATCH');
  const stopped = await call(db, '/lesson-stop', stopRequest({ auth: person('manager-a') }));
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  assert.equal(stopped.body.task.lastEditBy, 'manager');
  assert.equal(db.prepare('SELECT changed_by FROM student_change_events').first().changed_by, 'manager:manager-a');
});

test('each active linked makeup blocks stop without changing the regular lesson, makeup, attendance, or notes', async () => {
  for (const status of ['review_pending', 'reviewed', 'awaiting_parent', 'confirmed']) {
    const db = new TestD1(); seed(db);
    const generatedTaskId = seedMakeup(db, 'mu_stop', 'lesson-a', status);
    const records = db.prepare('SELECT * FROM checks ORDER BY k').all().results;
    const makeups = db.prepare('SELECT * FROM makeup_cases').all().results;
    const stopped = await call(db, '/lesson-stop', stopRequest());
    assert.equal(stopped.status, 409, JSON.stringify(stopped.body));
    assert.equal(stopped.body.code, 'LESSON_HAS_ACTIVE_MAKEUPS');
    assert.equal(stopped.body.activeMakeupCount, 1);
    assert.match(stopped.body.error, /연결된 보강을 먼저 완료하거나 보강없음/);
    assert.equal(taskData(db).deleted, false);
    assert.equal(taskData(db, generatedTaskId).deleted, false);
    assert.deepEqual(db.prepare('SELECT * FROM makeup_cases').all().results, makeups);
    assert.deepEqual(db.prepare('SELECT * FROM checks ORDER BY k').all().results, records);
    assert.equal(db.batches.length, 0);
  }
});

test('completed and cancelled linked makeups, their lessons, and their records survive stopping the regular lesson', async () => {
  for (const status of ['completed', 'cancelled']) {
    const db = new TestD1(); seed(db);
    seedMakeup(db);
    db.prepare('UPDATE makeup_cases SET status=?,completed_by=?,completed_at=?,cancelled_by=?,cancelled_at=? WHERE case_id=?')
      .bind(status, status === 'completed' ? 'teacher-a' : null, status === 'completed' ? FIXTURE_NOW : null,
        status === 'cancelled' ? 'director' : null, status === 'cancelled' ? FIXTURE_NOW : null, 'mu_stop').run();
    const before = db.prepare('SELECT * FROM makeup_cases').all().results;
    const taskBefore = taskData(db, 'makeup_lesson_mu_stop');
    const records = db.prepare('SELECT * FROM checks ORDER BY k').all().results;
    const stopped = await call(db, '/lesson-stop', stopRequest());
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
    assert.deepEqual(db.prepare('SELECT * FROM makeup_cases').all().results, before);
    assert.deepEqual(taskData(db, 'makeup_lesson_mu_stop'), taskBefore);
    assert.deepEqual(db.prepare('SELECT * FROM checks ORDER BY k').all().results, records);
  }
});

test('task and student schedule races roll back stop and audit together', async () => {
  for (const kind of ['task', 'schedule']) {
    const db = new TestD1(); seed(db);
    db.beforeBatch = () => {
      if (kind === 'task') {
        db.prepare("UPDATE tasks SET data=json_set(data,'$.guide','먼저 저장된 안내'),updated_at=updated_at+1 WHERE id='lesson-a'").run();
      } else if (kind === 'schedule') {
        db.prepare("INSERT INTO student_schedule_revisions(app,student_id,revision,updated_at) VALUES('task','student-a',1,?)")
          .bind(FIXTURE_NOW).run();
      }
    };
    const stopped = await call(db, '/lesson-stop', stopRequest());
    assert.equal(stopped.status, 409, kind + ': ' + JSON.stringify(stopped.body));
    assert.equal(stopped.body.code, 'REVISION_CONFLICT');
    assert.equal(taskData(db).deleted, false);
    assert.equal(db.prepare('SELECT count(*) AS n FROM student_change_events').first().n, 0);
    const revision = db.prepare("SELECT revision FROM student_schedule_revisions WHERE student_id='student-a'").first();
    assert.equal(revision && revision.revision, kind === 'schedule' ? 1 : null);
  }
});

test('a new pending or confirmed linked makeup after the snapshot rolls back the stop', async () => {
  for (const status of ['review_pending', 'confirmed']) {
    const db = new TestD1(); seed(db);
    db.beforeBatch = () => seedMakeup(db, 'mu_stop', 'lesson-a', status);
    const stopped = await call(db, '/lesson-stop', stopRequest());
    assert.equal(stopped.status, 409, JSON.stringify(stopped.body));
    assert.equal(stopped.body.code, 'LESSON_HAS_ACTIVE_MAKEUPS');
    assert.equal(stopped.body.activeMakeupCount, 1);
    assert.equal(taskData(db).deleted, false);
    assert.equal(db.prepare("SELECT status FROM makeup_cases WHERE case_id='mu_stop'").first().status, status);
    assert.equal(db.prepare('SELECT count(*) AS n FROM student_change_events').first().n, 0);
  }
});

test('teacher sync receives the stopped task and stale teacher or administrator copies cannot resurrect it', async () => {
  const db = new TestD1(); const original = seed(db);
  const stopped = await call(db, '/lesson-stop', stopRequest());
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  const pulled = await call(db, '/sync', { auth: person('teacher-a'), since: STORED_AT, changes: [] });
  assert.equal(pulled.status, 200, JSON.stringify(pulled.body));
  const ownTask = pulled.body.changes.find(change => change.table === 'tasks' && change.key === 'lesson-a');
  assert.ok(ownTask, JSON.stringify(pulled.body));
  assert.equal(ownTask.data.deleted, true);
  for (const auth of [person('teacher-a'), admin, person('manager-a')]) {
    const incoming = { ...original, updatedAt: FIXTURE_NOW + 1000 };
    const stale = await call(db, '/sync', { auth, since: 0, changes: [{
      table: 'tasks', id: incoming.id, owner: incoming.staffId, data: incoming, updated_at: incoming.updatedAt
    }] });
    assert.equal(stale.status, auth.id === 'teacher-a' ? 403 : 409, JSON.stringify(stale.body));
    if (auth.id !== 'teacher-a') assert.equal(stale.body.code, 'LESSON_SCHEDULE_ENDPOINT_REQUIRED');
    assert.equal(taskData(db).deleted, true);
  }
});

test('a future client timestamp stays monotonic without putting the sync cursor in the future', async () => {
  const db = new TestD1(); seed(db);
  const future = FIXTURE_NOW + 86400000;
  db.prepare("UPDATE tasks SET data=json_set(data,'$.updatedAt',?),updated_at=? WHERE id='lesson-a'")
    .bind(future, future).run();
  const stopped = await call(db, '/lesson-stop', stopRequest({ expectedUpdatedAt: future }));
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  assert.equal(stopped.body.task.updatedAt, future + 1);
  const row = db.prepare("SELECT updated_at,srv_at FROM tasks WHERE id='lesson-a'").first();
  assert.equal(row.updated_at, future + 1);
  assert.equal(row.srv_at, FIXTURE_NOW);
});
