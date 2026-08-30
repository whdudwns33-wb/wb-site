import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import worker from './worker-core.js';
import { lessonHandoffCheckoutGrant } from './lesson-handoff.js';
import { handleScheduledSessionPackAttendance } from './session-pack.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/060_lesson_handoffs.sql', import.meta.url), 'utf8');
const DATE = '2026-08-30';
const HANDOFF_ID = 'lh_' + 'a'.repeat(32);
const SOURCE = 'teacher-a';
const RECIPIENT = 'teacher-b';
const OTHER = 'teacher-c';
const SOURCE_MEMO = Object.freeze({
  contentProgress: 'Original first half', homework: 'Original homework',
  comment: 'Original attendance remains late', otherNotes: 'Original note'
});
const RECIPIENT_MEMO = Object.freeze({
  contentProgress: 'Remaining second half', homework: 'Recipient homework',
  comment: 'Recipient completion note', otherNotes: 'Separate handoff note'
});

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

/** Execute real SQLite constraints and roll back the whole D1 batch on failure. */
class TestD1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys=ON');
    this.sqlite.exec(schema);
    this.sqlite.exec(migration);
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
  seed() {
    for (const id of [SOURCE, RECIPIENT, OTHER]) {
      this.sqlite.prepare('INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
        .run('task', id, id, JSON.stringify({ id, name: id, deleted: false }), 1, 1);
      this.sqlite.prepare('INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)')
        .run('task', 'test-token-' + id, id, 1);
    }
    const students = [
      { id: 'student-a', teacher: SOURCE, teacherIds: [SOURCE] },
      { id: 'student-b', teacher: OTHER, teacherIds: [OTHER] }
    ].map(student => ({
      ...student, name: 'Synthetic student', grade: '초2', subject: '수학',
      start: '2026-01', end: '', reason: ''
    }));
    this.sqlite.prepare('INSERT INTO private_rosters(app,data,updated_at) VALUES(?,?,?)')
      .run('task', JSON.stringify({
        roster: { updated: DATE, baseline: '2026-08', students }, bookStudents: []
      }), 1);
    for (const [id, studentId, staffId] of [
      ['lesson-a', 'student-a', SOURCE], ['lesson-b', 'student-b', OTHER]
    ]) {
      const task = {
        id, studentId, staffId, studentName: 'Synthetic student', grade: '초2',
        subject: '수학', className: 'Synthetic class', lessonRole: '수학',
        taskKind: 'lesson_instruction', lessonFormVersion: 1, lessonRevision: 1,
        lessonAssignmentKey: 'sha256:' + id, lessonHours: '2T',
        scheduleStatus: 'confirmed', scheduleText: 'Sunday 14:00-15:50',
        scheduleSlots: [{ slotId: 'slot-a', days: [0], startTime: '14:00', endTime: '15:50',
          lessonHours: '2T', validFrom: '2026-08-01' }],
        start: '2026-08-01', end: '', repeat: 'days', days: [0],
        origin: 'admin', updatedAt: 1, deleted: false,
        studentTraits: 'source-only-private-traits', parentRequest: 'source-only-parent-request'
      };
      this.sqlite.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
        .run('task', id, staffId, JSON.stringify(task), 1, 1);
    }
  }
}

const person = id => ({ mode: 'person', id, token: 'test-token-' + id });
const admin = { mode: 'admin', secret: 'integration-only-admin' };
const envFor = db => ({ DB: db, TASK_ADMIN_SECRET: admin.secret });
const kst = (time, date = DATE) => Date.parse(date + 'T' + time + ':00+09:00');

async function at(timestamp, callback) {
  const originalNow = Date.now;
  Date.now = () => timestamp;
  try { return await callback(); } finally { Date.now = originalNow; }
}

async function post(db, path, body, staffId = SOURCE) {
  const auth = typeof staffId === 'string' ? person(staffId) : staffId;
  const response = await worker.fetch(new Request('https://worker.example' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app: 'task', auth, dataGeneration: 0, ...body })
  }), envFor(db));
  return { status: response.status, body: await response.json() };
}

function successful(result, label) {
  assert.equal(result.status, 200, label + ': ' + JSON.stringify(result.body));
  assert.equal(result.body.ok, true, label);
  return result.body;
}

function denied(result, label) {
  assert.ok([401, 403, 404, 409, 422].includes(result.status),
    label + ': ' + JSON.stringify(result));
  assert.equal(result.body.ok, false, label);
}

function originalSnapshot(db) {
  return {
    tasks: db.sqlite.prepare('SELECT * FROM tasks ORDER BY app,id').all(),
    checks: db.sqlite.prepare('SELECT * FROM checks ORDER BY app,k').all(),
    packs: db.sqlite.prepare('SELECT * FROM session_packs ORDER BY app,pack_id').all(),
    usage: db.sqlite.prepare('SELECT * FROM session_pack_usage ORDER BY app,entry_id').all()
  };
}

function visitRow(db, visitId) {
  return db.sqlite.prepare('SELECT * FROM weekend_actual_visits WHERE app=? AND visit_id=?')
    .get('task', visitId);
}

function visitEvents(db, visitId) {
  return db.sqlite.prepare('SELECT * FROM weekend_actual_visit_events WHERE app=? AND visit_id=? ORDER BY created_at,event_id')
    .all('task', visitId);
}

function createBody(overrides = {}) {
  return {
    action: 'create', handoffId: HANDOFF_ID, lessonTaskId: 'lesson-a', studentId: 'student-a',
    sourceDate: DATE, recordDate: DATE, slotId: 'slot-a', recipientStaffId: RECIPIENT,
    startTime: '15:00', completedHours: '1T', remainingHours: '1T', note: 'Finish remaining lesson',
    ...overrides
  };
}

async function fixture(t, options = {}) {
  const db = new TestD1();
  t.after(() => db.sqlite.close());
  db.seed();
  const recordDate = options.recordDate || DATE;
  const checkIn = successful(await at(kst('14:10', recordDate), () => post(db, '/weekend-visit', {
    action: 'check_in', visitDate: recordDate, sourceDate: DATE,
    lessonTaskId: 'lesson-a', studentId: 'student-a', visitSequence: 1
  })), 'source check-in');
  const checkKey = 'lesson-a|' + recordDate;
  const attendance = successful(await at(kst('14:11', recordDate), () => post(db, '/sync', {
    since: 0, changes: [{ table: 'checks', k: checkKey, owner: SOURCE, updated_at: kst('14:11', recordDate),
      data: { taskId: 'lesson-a', date: recordDate, att: 'L', lessonMemo: SOURCE_MEMO, note: 'Original note' } }]
  })), 'source late attendance');
  assert.equal(attendance.changes.filter(change => change.table === 'checks').length, 1);
  const pack = successful(await at(kst('14:12', recordDate), () => post(db, '/session-pack', {
    action: 'create', studentId: 'student-a', lessonTaskId: 'lesson-a', totalSessions: 8,
    validFrom: '2026-08-01', expiresOn: '2026-12-31', deductionPolicy: 'recommended_v1'
  }, admin)), 'source session pack').pack;
  return { db, recordDate, checkKey, visit: checkIn.visit, pack };
}

async function acceptedFixture(t, options = {}) {
  const context = await fixture(t, options);
  const { db, recordDate } = context;
  const created = successful(await at(kst('14:50', recordDate), () => post(db, '/lesson-handoff',
    createBody({ recordDate }))), 'create handoff').handoff;
  const handoff = successful(await at(kst('14:55', recordDate), () => post(db, '/lesson-handoff', {
    action: 'accept', handoffId: created.handoffId, revision: created.revision
  }, RECIPIENT)), 'accept handoff').handoff;
  assert.equal(handoff.status, 'accepted');
  return { ...context, handoff };
}

async function checkout(db, visit, staffId = RECIPIENT) {
  return post(db, '/weekend-visit', {
    action: 'check_out', visitId: visit.visitId, revision: visit.revision
  }, staffId);
}

function transferSource(db, staffId = OTHER) {
  const row = db.sqlite.prepare("SELECT * FROM tasks WHERE app='task' AND id='lesson-a'").get();
  const task = JSON.parse(row.data);
  Object.assign(task, { staffId, updatedAt: Number(row.updated_at) + 1 });
  db.sqlite.prepare("UPDATE tasks SET owner=?,data=?,updated_at=?,srv_at=? WHERE app='task' AND id='lesson-a'")
    .run(staffId, JSON.stringify(task), task.updatedAt, task.updatedAt);
}

function changeSourceLesson(db, change) {
  const row = db.sqlite.prepare("SELECT * FROM tasks WHERE app='task' AND id='lesson-a'").get();
  const task = JSON.parse(row.data);
  change(task);
  task.updatedAt = Number(row.updated_at) + 1;
  task.lessonRevision = Number(task.lessonRevision || 1) + 1;
  db.sqlite.prepare("UPDATE tasks SET data=?,updated_at=?,srv_at=? WHERE app='task' AND id='lesson-a'")
    .run(JSON.stringify(task), task.updatedAt, task.updatedAt);
}

test('SQLite D1 batches roll back prior writes if a later statement fails', async t => {
  const db = new TestD1();
  t.after(() => db.sqlite.close());
  await assert.rejects(db.batch([
    db.prepare("UPDATE app_data_generations SET generation=5 WHERE app='task'"),
    db.prepare("INSERT INTO app_data_generations(app,generation,updated_at) VALUES('task',6,1)")
  ]), /UNIQUE constraint failed/);
  assert.equal(db.sqlite.prepare("SELECT generation FROM app_data_generations WHERE app='task'").get().generation, 0);
});

test('late 2T lesson is split 1T + 1T without moving the task, check, or pack; cron consumes exactly once', async t => {
  const { db, visit, pack, checkKey } = await fixture(t);
  const before = originalSnapshot(db);
  let handoff = successful(await at(kst('14:50'), () => post(db, '/lesson-handoff', createBody())),
    'create split').handoff;
  assert.equal(handoff.completedHours, '1T');
  assert.equal(handoff.remainingHours, '1T');
  assert.equal(handoff.lessonTaskId, 'lesson-a');
  assert.equal(handoff.studentId, 'student-a');
  assert.equal(handoff.recordDate, DATE);
  const replay = successful(await at(kst('14:51'), () => post(db, '/lesson-handoff', createBody())),
    'create retry');
  assert.equal(replay.handoff.handoffId, handoff.handoffId);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM lesson_handoffs').get().n, 1);

  handoff = successful(await at(kst('14:55'), () => post(db, '/lesson-handoff', {
    action: 'accept', handoffId: handoff.handoffId, revision: handoff.revision
  }, RECIPIENT)), 'recipient accepts').handoff;
  handoff = successful(await at(kst('15:30'), () => post(db, '/lesson-handoff', {
    action: 'save', handoffId: handoff.handoffId, revision: handoff.revision, memo: RECIPIENT_MEMO
  }, RECIPIENT)), 'recipient separate memo').handoff;
  assert.deepEqual(handoff.memo, RECIPIENT_MEMO);
  handoff = successful(await at(kst('15:45'), () => post(db, '/lesson-handoff', {
    action: 'complete', handoffId: handoff.handoffId, revision: handoff.revision
  }, RECIPIENT)), 'recipient completes').handoff;
  assert.equal(handoff.status, 'completed');
  assert.deepEqual(handoff.memo, RECIPIENT_MEMO, 'completion preserves the separately saved memo');
  assert.deepEqual(originalSnapshot(db), before, 'the sidecar never mutates or duplicates source data');

  const out = successful(await at(kst('15:46'), () => checkout(db, visit)), 'recipient final checkout').visit;
  assert.equal(out.visitId, visit.visitId, 'recipient closes the existing visit without re-entry');
  assert.equal(out.staffId, SOURCE, 'original visit owner remains an audit field');
  assert.equal(out.checkInAt, visit.checkInAt);
  assert.equal(out.status, 'completed');
  assert.deepEqual(visitEvents(db, visit.visitId).map(row => [row.event_type, row.actor_id]),
    [['check_in', SOURCE], ['check_out', RECIPIENT]]);
  const retry = successful(await at(kst('15:47'), () => checkout(db, out)), 'checkout retry');
  assert.equal(retry.idempotent, true);
  assert.equal(visitEvents(db, visit.visitId).length, 2);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM weekend_actual_visits').get().n, 1);
  assert.deepEqual(originalSnapshot(db), before);

  const finalized = await at(kst('23:50'), () => handleScheduledSessionPackAttendance(envFor(db), kst('23:50')));
  assert.deepEqual(finalized, { ok: true, sourceDate: DATE, processed: 1, idempotent: 0, skipped: 0, failed: 0 });
  const duplicate = await at(kst('23:50'), () => handleScheduledSessionPackAttendance(envFor(db), kst('23:50')));
  assert.deepEqual(duplicate, { ok: true, sourceDate: DATE, processed: 0, idempotent: 1, skipped: 0, failed: 0 });
  const usage = db.sqlite.prepare('SELECT pack_id,source_ref,source_date,attendance_event,delta,actor_id FROM session_pack_usage').all();
  assert.deepEqual(usage.map(row => ({ ...row })), [{
    pack_id: pack.packId, source_ref: checkKey, source_date: DATE, attendance_event: 'late',
    delta: 1, actor_id: 'system-session-cutoff'
  }]);
  const listedPack = successful(await post(db, '/session-pack', { action: 'list' }), 'source pack list').packs[0];
  assert.equal(listedPack.usedSessions, 1);
  assert.equal(listedPack.remainingSessions, 7);
  assert.deepEqual(originalSnapshot(db).tasks, before.tasks);
  assert.deepEqual(originalSnapshot(db).checks, before.checks);
  assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
});

test('handoff access stays participant-only and never authorizes generic source task or attendance writes', async t => {
  const { db, handoff, visit, checkKey } = await acceptedFixture(t);
  const before = originalSnapshot(db);
  for (const staffId of [SOURCE, RECIPIENT]) {
    const listed = successful(await at(kst('15:05'), () => post(db, '/lesson-handoff', {
      action: 'list', date: DATE
    }, staffId)), 'participant list');
    assert.deepEqual(listed.handoffs.map(row => row.handoffId), [handoff.handoffId]);
    assert.doesNotMatch(JSON.stringify(listed), /source-only-private-traits|source-only-parent-request/);
  }
  const outsider = successful(await at(kst('15:05'), () => post(db, '/lesson-handoff', {
    action: 'list', date: DATE
  }, OTHER)), 'unrelated list');
  assert.deepEqual(outsider.handoffs, []);
  for (const action of ['accept', 'save', 'complete', 'cancel']) {
    denied(await at(kst('15:05'), () => post(db, '/lesson-handoff', {
      action, handoffId: handoff.handoffId, revision: handoff.revision,
      ...(action === 'save' ? { memo: RECIPIENT_MEMO } : {})
    }, OTHER)), 'unrelated ' + action);
  }
  denied(await at(kst('15:05'), () => post(db, '/lesson-handoff', {
    action: 'save', handoffId: handoff.handoffId, revision: handoff.revision, memo: RECIPIENT_MEMO
  }, SOURCE)), 'source cannot overwrite recipient memo');
  denied(await at(kst('15:05'), () => checkout(db, visit, OTHER)), 'unrelated checkout');
  for (const staffId of [RECIPIENT, OTHER]) {
    const pulled = successful(await post(db, '/sync', { since: 0, changes: [] }, staffId), 'scoped sync');
    assert.ok(!pulled.changes.some(change => ['lesson-a', checkKey].includes(change.key)));
    for (const owner of [SOURCE, staffId]) {
      const result = await post(db, '/sync', { since: 0, changes: [{
        table: 'checks', k: checkKey, owner, updated_at: kst('15:10'),
        data: { taskId: 'lesson-a', date: DATE, att: 'P', lessonMemo: RECIPIENT_MEMO }
      }] }, staffId);
      assert.equal(result.status, 403, 'handoff is not a check ownership transfer');
    }
    const originalTask = JSON.parse(before.tasks.find(row => row.id === 'lesson-a').data);
    assert.equal((await post(db, '/sync', { since: 0, changes: [{
      table: 'tasks', id: 'lesson-a', owner: staffId, updated_at: kst('15:11'),
      data: { ...originalTask, staffId, origin: 'staff' }
    }] }, staffId)).status, 403);
    assert.deepEqual(successful(await post(db, '/session-pack', { action: 'list' }, staffId),
      'non-owner pack list').packs, []);
  }
  assert.deepEqual(originalSnapshot(db), before);
});

test('recipient checkout grant is exact to the bound visit, source date, student, lesson, and current day', async t => {
  const { db, handoff, visit } = await acceptedFixture(t);
  const row = visitRow(db, visit.visitId);
  const auth = { scope: 'own', id: RECIPIENT };
  const grant = await at(kst('15:05'), () => lessonHandoffCheckoutGrant(envFor(db), 'task', auth, row));
  assert.equal(grant.handoffId, handoff.handoffId);
  assert.equal(grant.revision, handoff.revision);
  for (const changes of [
    { visit_id: 'wv_' + 'f'.repeat(32) }, { student_id: 'student-b' },
    { lesson_task_id: 'lesson-b' }, { staff_id: OTHER },
    { source_date: '2026-08-29' }, { source_date: null }, { visit_date: '2026-08-29' }
  ]) {
    assert.equal(await at(kst('15:05'), () => lessonHandoffCheckoutGrant(envFor(db), 'task', auth,
      { ...row, ...changes })), null, Object.keys(changes).join(','));
  }
  assert.equal(await at(kst('15:05'), () => lessonHandoffCheckoutGrant(envFor(db), 'task',
    { scope: 'own', id: OTHER }, row)), null);
  assert.equal(await at(kst('15:05', '2026-08-31'), () => lessonHandoffCheckoutGrant(envFor(db), 'task', auth, row)), null);
});

test('recipient may only close the current visit, never check in, correct, cancel, or obtain a new visit', async t => {
  const { db, visit } = await acceptedFixture(t);
  const before = visitRow(db, visit.visitId);
  const events = visitEvents(db, visit.visitId);
  for (const body of [
    { action: 'check_in', visitDate: DATE, sourceDate: DATE, lessonTaskId: 'lesson-a', studentId: 'student-a' },
    { action: 'correct', visitId: visit.visitId, revision: visit.revision,
      checkInAt: kst('14:00'), checkOutAt: kst('15:05'), reason: 'Synthetic correction' },
    { action: 'cancel', visitId: visit.visitId, revision: visit.revision, reason: 'Synthetic cancellation' }
  ]) denied(await at(kst('15:05'), () => post(db, '/weekend-visit', body, RECIPIENT)), 'recipient ' + body.action);
  assert.deepEqual(visitRow(db, visit.visitId), before);
  assert.deepEqual(visitEvents(db, visit.visitId), events);
  successful(await at(kst('15:06'), () => checkout(db, visit)), 'allowed final checkout');
  denied(await at(kst('15:10'), () => post(db, '/weekend-visit', {
    action: 'check_in', visitDate: DATE, sourceDate: DATE, visitSequence: 2,
    lessonTaskId: 'lesson-a', studentId: 'student-a'
  }, RECIPIENT)), 'recipient cannot open re-entry');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM weekend_actual_visits').get().n, 1);
  const nextVisit = successful(await at(kst('16:00'), () => post(db, '/weekend-visit', {
    action: 'check_in', visitDate: DATE, sourceDate: DATE, visitSequence: 2,
    lessonTaskId: 'lesson-a', studentId: 'student-a'
  })), 'source can record a later real re-entry').visit;
  denied(await at(kst('16:01'), () => checkout(db, nextVisit)), 'old handoff cannot close another visit sequence');
  assert.equal(visitRow(db, nextVisit.visitId).status, 'active');
  assert.equal(visitEvents(db, nextVisit.visitId).length, 1);
});

test('a pending handoff does not authorize the named recipient until they accept it', async t => {
  const { db, visit } = await fixture(t);
  const handoff = successful(await at(kst('14:50'), () => post(db, '/lesson-handoff', createBody())),
    'pending handoff').handoff;
  denied(await at(kst('15:05'), () => checkout(db, visit)), 'pending recipient checkout');
  assert.equal(visitEvents(db, visit.visitId).length, 1);
  successful(await at(kst('15:06'), () => post(db, '/lesson-handoff', {
    action: 'accept', handoffId: handoff.handoffId, revision: handoff.revision
  }, RECIPIENT)), 'recipient accepts');
  successful(await at(kst('15:07'), () => checkout(db, visit)), 'accepted recipient checkout');
});

test('checkout waits for handoff start and is allowed after 23:50 but never on the next actual day', async t => {
  const { db, handoff, visit } = await acceptedFixture(t);
  const before = visitRow(db, visit.visitId);
  denied(await at(kst('14:59'), () => checkout(db, visit)), 'checkout before handoff start');
  denied(await at(kst('14:59'), () => post(db, '/lesson-handoff', {
    action: 'complete', handoffId: handoff.handoffId, revision: handoff.revision
  }, RECIPIENT)), 'complete before handoff start');
  assert.deepEqual(visitRow(db, visit.visitId), before);
  for (const action of ['save', 'complete']) {
    denied(await at(kst('23:50'), () => post(db, '/lesson-handoff', {
      action, handoffId: handoff.handoffId, revision: handoff.revision,
      ...(action === 'save' ? { memo: RECIPIENT_MEMO } : {})
    }, RECIPIENT)), action + ' at attendance cutoff');
  }
  const out = successful(await at(kst('23:55'), () => checkout(db, visit)), 'late final physical checkout').visit;
  assert.equal(out.checkOutAt, kst('23:55'));
  denied(await at(kst('00:01', '2026-08-31'), () => checkout(db, out)), 'next-day retry cannot reuse grant');
  assert.equal(visitEvents(db, visit.visitId).length, 2);
});

test('cross-weekend handoff preserves the planned date but charges only its actual-day canonical check', async t => {
  const recordDate = '2026-08-29';
  const { db, handoff, visit, checkKey } = await acceptedFixture(t, { recordDate });
  assert.equal(handoff.sourceDate, DATE);
  assert.equal(handoff.recordDate, recordDate);
  assert.equal(visit.sourceDate, DATE);
  assert.equal(visit.visitDate, recordDate);
  successful(await at(kst('15:45', recordDate), () => checkout(db, visit)), 'cross-day recipient checkout');
  const result = await at(kst('23:50', recordDate), () =>
    handleScheduledSessionPackAttendance(envFor(db), kst('23:50', recordDate)));
  assert.equal(result.processed, 1);
  const next = await at(kst('23:50'), () => handleScheduledSessionPackAttendance(envFor(db), kst('23:50')));
  assert.equal(next.processed, 0);
  assert.deepEqual(db.sqlite.prepare('SELECT k,owner FROM checks').all().map(row => ({ ...row })),
    [{ k: checkKey, owner: SOURCE }]);
  assert.deepEqual(db.sqlite.prepare('SELECT source_ref,delta FROM session_pack_usage').all().map(row => ({ ...row })),
    [{ source_ref: checkKey, delta: 1 }]);
});

test('a new remaining-lesson handoff cannot begin after an already completed physical visit', async t => {
  const { db, visit } = await fixture(t);
  successful(await at(kst('14:40'), () => checkout(db, visit, SOURCE)), 'source records actual departure');
  denied(await at(kst('14:50'), () => post(db, '/lesson-handoff', createBody({ startTime: '15:00' }))),
    'a student who has already left cannot have a future remaining-lesson handoff');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM lesson_handoffs').get().n, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM lesson_handoff_events').get().n, 0);
});

test('reusing a positional slot ID for different timing invalidates the original handoff', async t => {
  const { db, handoff, visit } = await acceptedFixture(t);
  changeSourceLesson(db, task => {
    // The lesson editor regenerates slot IDs by position, so this remains slot-a.
    task.scheduleSlots[0].startTime = '18:00';
    task.scheduleSlots[0].endTime = '19:50';
    task.scheduleText = 'Sunday 18:00-19:50';
  });
  denied(await at(kst('15:05'), () => post(db, '/lesson-handoff', {
    action: 'complete', handoffId: handoff.handoffId, revision: handoff.revision
  }, RECIPIENT)), 'completion cannot silently use a repurposed slot ID');
  denied(await at(kst('15:05'), () => checkout(db, visit)), 'repurposed source slot must revoke checkout grant');
  assert.equal(visitEvents(db, visit.visitId).length, 1);
});

test('an assignment identity change with the same owner, student, and lesson ID invalidates the handoff', async t => {
  const { db, handoff, visit } = await acceptedFixture(t);
  changeSourceLesson(db, task => {
    task.subject = '영어';
    task.lessonRole = '영어';
    task.lessonAssignmentKey = 'sha256:new-subject-assignment';
  });
  denied(await at(kst('15:05'), () => post(db, '/lesson-handoff', {
    action: 'complete', handoffId: handoff.handoffId, revision: handoff.revision
  }, RECIPIENT)), 'completion must stay bound to the original subject assignment');
  denied(await at(kst('15:05'), () => checkout(db, visit)), 'replacement subject assignment cannot inherit a grant');
  assert.equal(visitEvents(db, visit.visitId).length, 1);
});

test('cancelled or retargeted handoffs immediately revoke the former recipient checkout grant', async t => {
  const { db, handoff, visit } = await acceptedFixture(t);
  assert.equal((await at(kst('15:04'), () => post(db, '/lesson-handoff', {
    action: 'cancel', handoffId: handoff.handoffId, revision: handoff.revision,
    reason: 'Source cannot revoke a previously accepted handoff'
  }))).status, 403);
  successful(await at(kst('15:05'), () => post(db, '/lesson-handoff', {
    action: 'cancel', handoffId: handoff.handoffId, revision: handoff.revision,
    reason: 'Administrator changes the remaining lesson recipient'
  }, admin)), 'admin cancels accepted handoff');
  denied(await at(kst('15:06'), () => checkout(db, visit)), 'cancelled recipient checkout');
  const replacement = successful(await at(kst('15:07'), () => post(db, '/lesson-handoff', createBody({
    handoffId: 'lh_' + 'b'.repeat(32), recipientStaffId: OTHER
  }))), 'create replacement recipient').handoff;
  successful(await at(kst('15:08'), () => post(db, '/lesson-handoff', {
    action: 'accept', handoffId: replacement.handoffId, revision: replacement.revision
  }, OTHER)), 'replacement accepts');
  denied(await at(kst('15:09'), () => checkout(db, visit)), 'old recipient after retarget');
  assert.equal(visitEvents(db, visit.visitId).length, 1);
  successful(await at(kst('15:10'), () => checkout(db, visit, OTHER)), 'new exact recipient checks out');
});

test('revoked personal tokens and changed source assignments cannot use a previous handoff', async t => {
  const revoked = await acceptedFixture(t);
  revoked.db.sqlite.prepare('UPDATE tokens SET revoked=1 WHERE app=? AND staff_id=?').run('task', RECIPIENT);
  assert.equal((await at(kst('15:05'), () => checkout(revoked.db, revoked.visit))).status, 401);
  assert.equal(visitEvents(revoked.db, revoked.visit.visitId).length, 1);

  const transferred = await acceptedFixture(t);
  transferSource(transferred.db);
  denied(await at(kst('15:05'), () => checkout(transferred.db, transferred.visit)), 'source assignment changed');
  assert.equal(visitRow(transferred.db, transferred.visit.visitId).status, 'active');
  assert.equal(visitEvents(transferred.db, transferred.visit.visitId).length, 1);
});

test('checkout CAS rechecks handoff cancellation between authorization and the transaction', async t => {
  const { db, handoff, visit } = await acceptedFixture(t);
  const before = visitRow(db, visit.visitId);
  const events = visitEvents(db, visit.visitId);
  db.beforeBatch = async () => {
    successful(await post(db, '/lesson-handoff', {
      action: 'cancel', handoffId: handoff.handoffId, revision: handoff.revision,
      reason: 'Administrator cancellation concurrent with checkout'
    }, admin), 'concurrent handoff cancellation');
  };
  const response = await at(kst('15:05'), () => checkout(db, visit));
  assert.equal(response.status, 409);
  assert.deepEqual(visitRow(db, visit.visitId), before);
  assert.deepEqual(visitEvents(db, visit.visitId), events, 'failed CAS must not append a checkout audit event');
});

test('checkout CAS rechecks source assignment after authorization and before the transaction', async t => {
  const { db, visit } = await acceptedFixture(t);
  const before = visitRow(db, visit.visitId);
  const events = visitEvents(db, visit.visitId);
  db.beforeBatch = () => transferSource(db);
  const response = await at(kst('15:05'), () => checkout(db, visit));
  assert.equal(response.status, 409);
  assert.deepEqual(visitRow(db, visit.visitId), before);
  assert.deepEqual(visitEvents(db, visit.visitId), events);
});

test('checkout CAS also rejects a newly inactive recipient or a generation change during the write', async t => {
  for (const changed of ['recipient', 'generation']) {
    const { db, visit } = await acceptedFixture(t);
    const before = visitRow(db, visit.visitId);
    const events = visitEvents(db, visit.visitId);
    db.beforeBatch = () => {
      if (changed === 'recipient') {
        const row = db.sqlite.prepare('SELECT data FROM staff WHERE app=? AND id=?').get('task', RECIPIENT);
        db.sqlite.prepare('UPDATE staff SET data=?,updated_at=2,srv_at=2 WHERE app=? AND id=?')
          .run(JSON.stringify({ ...JSON.parse(row.data), deleted: true }), 'task', RECIPIENT);
      } else {
        db.sqlite.prepare("UPDATE app_data_generations SET generation=1,updated_at=? WHERE app='task'")
          .run(kst('15:05'));
      }
    };
    const response = await at(kst('15:05'), () => checkout(db, visit));
    assert.equal(response.status, 409, changed);
    assert.deepEqual(visitRow(db, visit.visitId), before, changed);
    assert.deepEqual(visitEvents(db, visit.visitId), events, changed);
  }
});

test('stale data generations reject handoff writes and cannot keep an old checkout grant alive', async t => {
  const { db, handoff, visit } = await acceptedFixture(t);
  const before = originalSnapshot(db);
  db.sqlite.prepare("UPDATE app_data_generations SET generation=1,updated_at=? WHERE app='task'").run(kst('15:00'));
  for (const body of [
    createBody({ handoffId: 'lh_' + 'c'.repeat(32) }),
    ...['accept', 'save', 'complete', 'cancel'].map(action => ({
      action, handoffId: handoff.handoffId, revision: handoff.revision,
      ...(action === 'save' ? { memo: RECIPIENT_MEMO } : {})
    }))
  ]) {
    const response = await at(kst('15:05'), () => post(db, '/lesson-handoff', body,
      body.action === 'create' || body.action === 'cancel' ? SOURCE : RECIPIENT));
    assert.equal(response.status, 409, body.action);
    assert.equal(response.body.code, 'DATA_GENERATION_MISMATCH', body.action);
  }
  denied(await at(kst('15:05'), () => checkout(db, visit)), 'old-generation checkout grant');
  assert.equal(visitRow(db, visit.visitId).status, 'active');
  assert.equal(visitEvents(db, visit.visitId).length, 1);
  assert.deepEqual(originalSnapshot(db), before);
});
