import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import worker from './worker-core.js';
import { syncStudentSessionLedgers } from './tuition-alert.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const TEACHER = 'teacher-session-lock';
const TOKEN = 'session-lock-token';
const PAST_DATE = '2026-08-20';

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  first() { return this.db.sqlite.prepare(this.sql).get(...this.args) || null; }
  all() { return { results: this.db.sqlite.prepare(this.sql).all(...this.args) }; }
  run() {
    const result = this.db.sqlite.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(result.changes || 0) } };
  }
}

class TestD1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys=ON');
    this.sqlite.exec(schema);
    this.beforeBatch = null;
  }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    if (this.beforeBatch) {
      const hook = this.beforeBatch;
      this.beforeBatch = null;
      await hook();
    }
    this.sqlite.exec('BEGIN IMMEDIATE');
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
  close() { this.sqlite.close(); }
}

function student(id, mode = 'session4', start = '2026-08-01') {
  return {
    id, name: 'Synthetic', school: 'Test', grade: '중1', teacher: TEACHER,
    teacherIds: [TEACHER], start: '2026-01', end: '', billingMode: mode,
    sessionCycleStartDate: mode === 'session4' ? start : ''
  };
}

function saveRoster(db, students) {
  db.sqlite.prepare(
    "INSERT INTO private_rosters(app,data,updated_at) VALUES('task',?,1) " +
    'ON CONFLICT(app) DO UPDATE SET data=excluded.data,updated_at=updated_at+1'
  ).run(JSON.stringify({ roster: { students }, bookStudents: [] }));
}

function saveTask(db, id, studentId, overrides = {}) {
  const data = {
    id, staffId: TEACHER, studentId, taskKind: 'lesson_instruction', lessonFormVersion: 1,
    origin: 'admin', start: '2026-01-01', end: '', repeat: 'daily', days: [],
    deleted: false, updatedAt: 1, ...overrides
  };
  db.sqlite.prepare(
    "INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES('task',?,?,?,?,1)"
  ).run(id, TEACHER, JSON.stringify(data), 1);
}

function saveExistingCheck(db, taskId, date, att = 'P', note = '') {
  const data = { taskId, date, att, note, updatedAt: 1 };
  db.sqlite.prepare(
    "INSERT INTO checks(app,k,owner,data,updated_at,srv_at) VALUES('task',?,?,?,?,1)"
  ).run(taskId + '|' + date, TEACHER, JSON.stringify(data), 1);
}

function saveMakeupCase(db, caseId, studentId, taskDate, options = {}) {
  const status = options.status || 'confirmed';
  const confirmedDate = options.confirmedDate || taskDate;
  const history = options.history || [
    { action: 'create_from_absence' },
    ...(status === 'completed' ? [{ action: 'complete' }] : [])
  ];
  db.sqlite.prepare(
    'INSERT INTO makeup_cases(app,case_id,student_id,source_task_id,source_date,source_teacher_id,' +
    'consumption_group_id,status,revision,confirmed_start_at,confirmed_end_at,confirmed_staff_id,' +
    'completed_at,completed_by,notification_needed,notification_event_revision,history,created_at,updated_at) ' +
    "VALUES('task',?,?,?,?,?,?,?,1,?,?,?,?,?,0,0,?,1,1)"
  ).run(caseId, studentId, 'source_' + caseId, taskDate, TEACHER, 'group_' + caseId, status,
    confirmedDate + 'T10:00:00+09:00', confirmedDate + 'T11:00:00+09:00', TEACHER,
    status === 'completed' ? 1 : null, status === 'completed' ? TEACHER : null,
    JSON.stringify(history));
}

function change(taskId, date, att, updatedAt, note = '') {
  return {
    table: 'checks', k: taskId + '|' + date, owner: TEACHER, updated_at: updatedAt,
    data: { taskId, date, att, note, updatedAt }
  };
}

async function sync(db, changes) {
  const response = await worker.fetch(new Request('https://worker.example/sync', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      app: 'task', dataGeneration: 0,
      auth: { mode: 'person', id: TEACHER, token: TOKEN }, since: 0, changes
    })
  }), { DB: db });
  return { status: response.status, body: await response.json() };
}

async function syncAsAdmin(db, changes) {
  const response = await worker.fetch(new Request('https://worker.example/sync', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      app: 'task', dataGeneration: 0,
      auth: { mode: 'admin', secret: 'admin-secret' }, since: 0, changes
    })
  }), { DB: db, TASK_ADMIN_SECRET: 'admin-secret' });
  return { status: response.status, body: await response.json() };
}

function seedAuth(db) {
  db.sqlite.prepare(
    "INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES('task',?,?,?,?,1)"
  ).run(TEACHER, TEACHER, JSON.stringify({ id: TEACHER, name: 'Synthetic teacher', deleted: false }), 1);
  db.sqlite.prepare(
    "INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES('task',?,?,?,0)"
  ).run(TOKEN, TEACHER, Date.now());
}

test('generic sync locks session4 attendance after 23:50 but permits a same-att memo update', async t => {
  const db = new TestD1(); t.after(() => db.close()); seedAuth(db);
  const roster = [student('student-session')];
  // 이미 존재하던 운영 check를 재현한 뒤 migration 대상 설정으로 전환한다.
  saveRoster(db, [student('student-session', 'monthly')]);
  saveTask(db, 'lesson-session', 'student-session');
  saveExistingCheck(db, 'lesson-session', PAST_DATE, 'P', 'old');
  saveRoster(db, roster);

  const changed = await sync(db, [change('lesson-session', PAST_DATE, 'A', 2)]);
  assert.equal(changed.status, 409);
  assert.equal(changed.body.code, 'SESSION4_ATTENDANCE_LOCKED');
  assert.match(changed.body.error, /23시 50분/);

  const memo = await sync(db, [change('lesson-session', PAST_DATE, 'P', 3, 'saved memo')]);
  assert.equal(memo.status, 200, JSON.stringify(memo.body));
  const stored = JSON.parse(db.sqlite.prepare("SELECT data FROM checks WHERE app='task' AND k=?")
    .get('lesson-session|' + PAST_DATE).data);
  assert.equal(stored.att, 'P');
  assert.equal(stored.note, 'saved memo');

  const created = await sync(db, [change('lesson-session', '2026-08-21', 'P', 4)]);
  assert.equal(created.status, 409);
  assert.equal(created.body.code, 'SESSION4_ATTENDANCE_LOCKED');

  const stale = await sync(db, [change('lesson-session', PAST_DATE, 'A', 1)]);
  assert.equal(stale.status, 200, JSON.stringify(stale.body));
  const afterStale = JSON.parse(db.sqlite.prepare("SELECT data FROM checks WHERE app='task' AND k=?")
    .get('lesson-session|' + PAST_DATE).data);
  assert.equal(afterStale.att, 'P');
  assert.equal(afterStale.note, 'saved memo');

  const beforeConfiguredStart = await sync(db, [change('lesson-session', '2026-07-31', 'P', 5)]);
  assert.equal(beforeConfiguredStart.status, 200, JSON.stringify(beforeConfiguredStart.body));
});

test('23:49 remains editable and the same date becomes immutable at 23:50 KST', async t => {
  const db = new TestD1(); t.after(() => db.close()); seedAuth(db);
  const date = '2099-01-05';
  saveRoster(db, [student('student-future', 'session4', date)]);
  saveTask(db, 'lesson-future', 'student-future', { start: date });
  const originalNow = Date.now;
  try {
    Date.now = () => Date.parse(date + 'T23:49:00+09:00');
    const before = await sync(db, [change('lesson-future', date, 'P', Date.now())]);
    assert.equal(before.status, 200, JSON.stringify(before.body));

    Date.now = () => Date.parse(date + 'T23:50:00+09:00');
    const after = await sync(db, [change('lesson-future', date, 'A', Date.now() + 1)]);
    assert.equal(after.status, 409);
    assert.equal(after.body.code, 'SESSION4_ATTENDANCE_LOCKED');
  } finally {
    Date.now = originalNow;
  }
});

test('database trigger closes a roster-mode race and directly enforces new/change while allowing same att', async t => {
  const db = new TestD1(); t.after(() => db.close()); seedAuth(db);
  const monthly = student('student-race', 'monthly');
  const session = student('student-race');
  saveRoster(db, [monthly]);
  saveTask(db, 'lesson-race', 'student-race');
  db.beforeBatch = () => saveRoster(db, [session]);
  const raced = await sync(db, [change('lesson-race', PAST_DATE, 'P', 2)]);
  assert.equal(raced.status, 409);
  assert.equal(raced.body.code, 'SESSION4_ATTENDANCE_LOCKED');
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) count FROM checks WHERE k=?")
    .get('lesson-race|' + PAST_DATE).count, 0);

  saveRoster(db, [monthly]);
  saveExistingCheck(db, 'lesson-race', PAST_DATE, 'P', 'before');
  saveRoster(db, [session]);
  assert.doesNotThrow(() => db.sqlite.prepare(
    "UPDATE checks SET data=? WHERE app='task' AND k=?"
  ).run(JSON.stringify({ taskId: 'lesson-race', date: PAST_DATE, att: 'P', note: 'after' }),
    'lesson-race|' + PAST_DATE));
  assert.throws(() => db.sqlite.prepare(
    "UPDATE checks SET data=? WHERE app='task' AND k=?"
  ).run(JSON.stringify({ taskId: 'lesson-race', date: PAST_DATE, att: 'A' }),
    'lesson-race|' + PAST_DATE), /SESSION4_ATTENDANCE_LOCKED/);
  assert.throws(() => saveExistingCheck(db, 'lesson-race', '2026-08-21', 'P'),
    /SESSION4_ATTENDANCE_LOCKED/);
});

test('a ledger event permanently locks att across billing changes while same-att notes and stale replay remain safe', async t => {
  const db = new TestD1(); t.after(() => db.close()); seedAuth(db);
  saveRoster(db, [student('student-ledger', 'monthly')]);
  saveTask(db, 'lesson-ledger', 'student-ledger');
  saveExistingCheck(db, 'lesson-ledger', PAST_DATE, 'P', 'before');
  saveRoster(db, [student('student-ledger')]);
  const ledger = await syncStudentSessionLedgers(
    { DB: db }, Date.parse(PAST_DATE + 'T23:50:00+09:00')
  );
  assert.equal(ledger.createdEvents, 1, JSON.stringify(ledger));

  saveRoster(db, [student('student-ledger', 'monthly')]);
  const memo = await sync(db, [change('lesson-ledger', PAST_DATE, 'P', 2, 'after')]);
  assert.equal(memo.status, 200, JSON.stringify(memo.body));
  const stale = await sync(db, [change('lesson-ledger', PAST_DATE, 'A', 1)]);
  assert.equal(stale.status, 200, JSON.stringify(stale.body));
  const changedMonthly = await sync(db, [change('lesson-ledger', PAST_DATE, 'A', 3)]);
  assert.equal(changedMonthly.status, 409);
  assert.equal(changedMonthly.body.code, 'SESSION4_ATTENDANCE_LOCKED');

  saveRoster(db, [student('student-ledger', 'session4', '2026-08-21')]);
  const changedStart = await sync(db, [change('lesson-ledger', PAST_DATE, 'A', 4)]);
  assert.equal(changedStart.status, 409);
  assert.throws(() => db.sqlite.prepare(
    "UPDATE checks SET data=? WHERE app='task' AND k=?"
  ).run(JSON.stringify({ taskId: 'lesson-ledger', date: PAST_DATE, att: 'A' }),
    'lesson-ledger|' + PAST_DATE), /SESSION4_ATTENDANCE_LOCKED/);
});

test('an admin-attested generation event locks a missing raw check against stale device recreation', async t => {
  const db = new TestD1(); t.after(() => db.close()); seedAuth(db);
  const studentId = 'student-attested';
  const taskId = 'lesson-attested';
  const configured = '2026-08-01';
  saveRoster(db, [student(studentId, 'monthly')]);
  saveTask(db, taskId, studentId);
  db.sqlite.prepare(
    'INSERT INTO student_session_ledger_generations ' +
    '(app,student_id,configured_start_date,generation,source_cutoff_date,kind,' +
      'supersedes_generation,supersedes_event_count,reason_code,actor,created_at) ' +
    "VALUES('task',?,?,1,?,'system_backfill',NULL,0,'initial_backfill','system',1)"
  ).run(studentId, configured, configured);
  db.sqlite.prepare(
    'INSERT INTO student_session_ledger_generations ' +
    '(app,student_id,configured_start_date,generation,source_cutoff_date,kind,' +
      'supersedes_generation,supersedes_event_count,reason_code,actor,created_at) ' +
    "VALUES('task',?,?,2,?,'admin_reconciliation',1,0," +
      "'attendance_date_correction','admin:test',2)"
  ).run(studentId, configured, PAST_DATE);
  db.sqlite.prepare(
    'INSERT INTO student_session_ledger_cycles ' +
    '(app,student_id,configured_start_date,generation,cycle_number,cycle_start_date,created_at) ' +
    "VALUES('task',?,?,2,1,?,2)"
  ).run(studentId, configured, configured);
  db.sqlite.prepare(
    'INSERT INTO student_session_ledger_events ' +
    '(app,student_id,configured_start_date,generation,cycle_number,session_number,' +
      'lesson_task_id,attendance_date,attendance_status,source_kind,check_key,created_at) ' +
    "VALUES('task',?,?,2,1,1,?,?,'P','admin_attested',?,2)"
  ).run(studentId, configured, taskId, PAST_DATE, taskId + '|' + PAST_DATE);

  const replay = await sync(db, [change(taskId, PAST_DATE, 'P', 3)]);
  assert.equal(replay.status, 409, JSON.stringify(replay.body));
  assert.equal(replay.body.code, 'SESSION4_ATTENDANCE_LOCKED');
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) count FROM checks WHERE app='task' AND k=?")
    .get(taskId + '|' + PAST_DATE).count, 0);
});

test('confirmed absence makeup is locked at cutoff and stays locked after it enters the ledger', async t => {
  const db = new TestD1(); t.after(() => db.close()); seedAuth(db);
  const caseId = 'case_absence_lock';
  const taskId = 'makeup_lesson_' + caseId;
  saveRoster(db, [student('student-makeup', 'monthly')]);
  saveMakeupCase(db, caseId, 'student-makeup', PAST_DATE);
  saveTask(db, taskId, 'student-makeup', {
    lessonInstanceType: 'makeup', makeupCaseId: caseId, repeat: 'once',
    start: PAST_DATE, end: PAST_DATE
  });
  saveExistingCheck(db, taskId, PAST_DATE, 'P');
  saveRoster(db, [student('student-makeup')]);

  const beforeLedger = await sync(db, [change(taskId, PAST_DATE, 'A', 2)]);
  assert.equal(beforeLedger.status, 409);
  assert.equal(beforeLedger.body.code, 'SESSION4_ATTENDANCE_LOCKED');
  assert.throws(() => db.sqlite.prepare(
    "UPDATE checks SET data=? WHERE app='task' AND k=?"
  ).run(JSON.stringify({ taskId, date: PAST_DATE, att: 'A' }), taskId + '|' + PAST_DATE),
  /SESSION4_ATTENDANCE_LOCKED/);
  const ledger = await syncStudentSessionLedgers(
    { DB: db }, Date.parse(PAST_DATE + 'T23:50:00+09:00')
  );
  assert.equal(ledger.createdEvents, 1, JSON.stringify(ledger));

  saveRoster(db, [student('student-makeup', 'monthly')]);
  const afterLedger = await sync(db, [change(taskId, PAST_DATE, 'A', 3)]);
  assert.equal(afterLedger.status, 409);
  assert.equal(afterLedger.body.code, 'SESSION4_ATTENDANCE_LOCKED');
});

test('completed absence makeup locks its authoritative actual day even when the confirmed day differs', async t => {
  const db = new TestD1(); t.after(() => db.close()); seedAuth(db);
  const caseId = 'case_actual_day';
  const taskId = 'makeup_lesson_' + caseId;
  saveRoster(db, [student('student-actual', 'monthly')]);
  saveMakeupCase(db, caseId, 'student-actual', PAST_DATE, {
    status: 'completed', confirmedDate: '2026-08-19'
  });
  saveTask(db, taskId, 'student-actual', {
    lessonInstanceType: 'makeup', makeupCaseId: caseId, repeat: 'once',
    start: PAST_DATE, end: PAST_DATE
  });
  saveExistingCheck(db, taskId, PAST_DATE, 'P');
  saveRoster(db, [student('student-actual')]);

  const changed = await sync(db, [change(taskId, PAST_DATE, 'A', 2)]);
  assert.equal(changed.status, 409);
  assert.equal(changed.body.code, 'SESSION4_ATTENDANCE_LOCKED');
  assert.throws(() => db.sqlite.prepare(
    "UPDATE checks SET data=? WHERE app='task' AND k=?"
  ).run(JSON.stringify({ taskId, date: PAST_DATE, att: 'A' }), taskId + '|' + PAST_DATE),
  /SESSION4_ATTENDANCE_LOCKED/);
  const ledger = await syncStudentSessionLedgers(
    { DB: db }, Date.parse(PAST_DATE + 'T23:50:00+09:00')
  );
  assert.equal(ledger.createdEvents, 1, JSON.stringify(ledger));
});

test('all-scope preflight rejects a new past session4 task and check in the same batch even when check comes first', async t => {
  const db = new TestD1(); t.after(() => db.close()); seedAuth(db);
  saveRoster(db, [student('student-batch')]);
  const taskId = 'lesson-batch-new';
  const data = {
    id: taskId, staffId: TEACHER, studentId: 'student-batch', taskKind: 'lesson_instruction',
    lessonFormVersion: 1, origin: 'admin', start: '2026-01-01', end: '', repeat: 'daily',
    days: [], deleted: false, updatedAt: 2
  };
  const result = await syncAsAdmin(db, [
    change(taskId, PAST_DATE, 'P', 2),
    { table: 'tasks', id: taskId, owner: TEACHER, data, updated_at: 2 }
  ]);
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.code, 'SESSION4_ATTENDANCE_LOCKED');
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) count FROM tasks WHERE id=?").get(taskId).count, 0);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) count FROM checks WHERE k=?")
    .get(taskId + '|' + PAST_DATE).count, 0);
});
