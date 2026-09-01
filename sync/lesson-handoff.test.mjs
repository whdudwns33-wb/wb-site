import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { handleLessonHandoff, lessonHandoffCheckoutGrant, lessonHandoffInternals } from './lesson-handoff.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/060_lesson_handoffs.sql', import.meta.url), 'utf8');
const moduleSource = fs.readFileSync(new URL('./lesson-handoff.js', import.meta.url), 'utf8');
const source = { scope: 'own', id: 'teacher-a' };
const recipient = { scope: 'own', id: 'teacher-b' };
const stranger = { scope: 'own', id: 'teacher-c' };
const admin = { scope: 'all', role: 'director' };
const date = '2026-08-30';
const id = 'lh_' + 'a'.repeat(32);
const visitId = 'wv_' + 'a'.repeat(32);
const at = (time, day = date) => Date.parse(day + 'T' + time + ':00+09:00');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const blankMemo = () => ({ contentProgress: '', homework: '', comment: '', otherNotes: '' });

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  async first() { return this.db.sqlite.prepare(this.sql).get(...this.args) || null; }
  async all() { return { results: this.db.sqlite.prepare(this.sql).all(...this.args) }; }
  async run() {
    if (this.sql.startsWith('INSERT INTO lesson_handoff_events') && this.db.failEventOnce) {
      this.db.failEventOnce = false;
      throw new Error('synthetic append failure');
    }
    const result = this.db.sqlite.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(result.changes) } };
  }
}
class D1Database {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys=ON');
    this.sqlite.exec(schema);
    this.beforeBatch = null;
    this.failEventOnce = false;
  }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    if (this.beforeBatch) {
      const hook = this.beforeBatch; this.beforeBatch = null; await hook();
    }
    this.sqlite.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec('COMMIT'); return results;
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  staff(staffId, changes = {}) {
    const data = { id: staffId, name: staffId, privateField: 'staff-private-marker', ...changes };
    this.sqlite.prepare('INSERT OR REPLACE INTO staff (app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
      .run('task', staffId, staffId, JSON.stringify(data), 1, 1);
  }
  task(changes = {}) {
    const data = {
      id: 'lesson-a', staffId: 'teacher-a', studentId: 'student-a', title: '수업', subject: '수학',
      taskKind: 'lesson_instruction', start: '2026-08-01', repeat: 'days', days: [0],
      scheduleStatus: 'normal', scheduleSlots: [{ slotId: 'slot-a', days: [0], startTime: '13:00', endTime: '14:50', lessonHours: '2T' }],
      privateField: 'task-private-marker', ...changes
    };
    this.sqlite.prepare('INSERT OR REPLACE INTO tasks (app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
      .run('task', data.id, data.staffId, JSON.stringify(data), 1, 1);
    return data;
  }
  roster(changes = {}) {
    const data = { roster: { students: [{ id: 'student-a', name: '학생', school: '학교', grade: '중1',
      teacherIds: ['teacher-a'], guardianPhone: 'phone-private-marker', privateNotes: 'student-private-marker', ...changes }] } };
    this.sqlite.prepare('INSERT OR REPLACE INTO private_rosters (app,data,updated_at) VALUES(?,?,?)').run('task', JSON.stringify(data), 1);
  }
  check(changes = {}, checkDate = date) {
    const data = { taskId: 'lesson-a', date: checkDate, att: 'L', done: false,
      lessonMemo: { contentProgress: '원 교사 진도', homework: '원 교사 과제', comment: '원 코멘트', otherNotes: '원 내부 메모' },
      privateField: 'check-private-marker', ...changes };
    this.sqlite.prepare('INSERT OR REPLACE INTO checks (app,k,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
      .run('task', data.taskId + '|' + checkDate, 'teacher-a', JSON.stringify(data), 1, 1);
    return data;
  }
  visit(changes = {}) {
    const row = { visitId, taskId: 'lesson-a', studentId: 'student-a', staffId: 'teacher-a', visitDate: date,
      sourceDate: date, sequence: 1, checkInAt: at('14:00'), checkOutAt: null, status: 'active', ...changes };
    this.sqlite.prepare('INSERT INTO weekend_actual_visits ' +
      '(app,visit_id,student_id,lesson_task_id,staff_id,visit_date,source_date,visit_sequence,check_in_at,check_out_at,status,' +
      'revision,created_at,updated_at,created_by,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('task', row.visitId, row.studentId, row.taskId, row.staffId, row.visitDate, row.sourceDate, row.sequence,
        row.checkInAt, row.checkOutAt, row.status, 1, row.checkInAt, row.checkInAt, row.staffId, row.staffId);
  }
  count(table) { return this.sqlite.prepare('SELECT COUNT(*) n FROM ' + table).get().n; }
  handoff() { return this.sqlite.prepare('SELECT * FROM lesson_handoffs WHERE handoff_id=?').get(id); }
  physical() { return this.sqlite.prepare('SELECT * FROM weekend_actual_visits WHERE visit_id=?').get(visitId); }
}

function fixture(t, { physical = true } = {}) {
  const db = new D1Database(); t.after(() => db.sqlite.close());
  ['teacher-a', 'teacher-b', 'teacher-c'].forEach(id => db.staff(id));
  db.staff('teacher-inactive', { deleted: true });
  db.task(); db.roster(); db.check(); if (physical) db.visit();
  return db;
}
function createBody(changes = {}) {
  return { action: 'create', dataGeneration: 0, handoffId: id, lessonTaskId: 'lesson-a', studentId: 'student-a',
    sourceDate: date, recordDate: date, slotId: 'slot-a', recipientStaffId: 'teacher-b',
    startTime: '15:00', completedHours: '1T', remainingHours: '1T', note: '15시부터 이어서 수업', ...changes };
}
async function atNow(time, callback) {
  const original = Date.now; Date.now = () => time;
  try { return await callback(); } finally { Date.now = original; }
}
async function call(db, body, auth = source, now = at('14:50')) {
  return atNow(now, async () => {
    const response = await handleLessonHandoff({ DB: db }, 'task', body, '*', auth, json);
    return { status: response.status, body: await response.json() };
  });
}
async function createOk(db, changes = {}) {
  const response = await call(db, createBody(changes));
  assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.handoff;
}
async function acceptOk(db, revision = 1) {
  const response = await call(db, { action: 'accept', handoffId: id, revision, dataGeneration: 0 }, recipient, at('14:55'));
  assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.handoff;
}
async function grant(db, auth = recipient, time = at('15:10'), physical = db.physical()) {
  return atNow(time, () => lessonHandoffCheckoutGrant({ DB: db }, 'task', auth, physical));
}

test('060 is additive, idempotent, mirrored in schema, and never mutates canonical lesson/attendance/pack rows', () => {
  const normalizedSchema = schema.replace(/\r\n/g, '\n');
  const normalizedMigration = migration.replace(/\r\n/g, '\n').trim();
  assert.ok(normalizedSchema.includes(normalizedMigration));
  assert.doesNotMatch(migration, /DROP TABLE|DELETE FROM|UPDATE (?:tasks|checks|session_packs|session_pack_usage)\b/i);
  assert.doesNotMatch(moduleSource, /(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+(?:tasks|checks|session_packs|session_pack_usage|weekend_actual_visits)\b/i);
  const db = new DatabaseSync(':memory:');
  try { db.exec(migration); db.exec(migration); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); }
  finally { db.close(); }
});

test('half-T validation does not derive configured 2T from a 110-minute source slot', t => {
  const db = fixture(t);
  assert.equal(lessonHandoffInternals.halfUnits('0.5T'), 1);
  assert.equal(lessonHandoffInternals.halfUnits('1.5T'), 3);
  for (const value of ['0T', '0.25T', '1.25T', '1', 1, '1.0T', '7T', '-1T']) assert.equal(lessonHandoffInternals.halfUnits(value), null);
  return createOk(db).then(row => { assert.equal(row.totalHours, '2T'); assert.equal(row.remainingHours, '1T'); });
});

test('full handoff freezes source memo and keeps teacher-specific receiver memo separate without canonical writes', async t => {
  const db = fixture(t);
  const canonicalBefore = db.sqlite.prepare('SELECT owner,data FROM tasks').get();
  const checkBefore = db.sqlite.prepare('SELECT owner,data FROM checks').get();
  const visitBefore = db.physical();
  const created = await createOk(db);
  assert.equal(created.status, 'pending'); assert.equal(created.revision, 1);
  assert.equal(created.sourceMemo.contentProgress, '원 교사 진도');
  assert.deepEqual(created.memo, blankMemo()); assert.equal(created.visit.visitId, visitId);
  await acceptOk(db);
  const memo = { contentProgress: '후반 진도', homework: '후반 과제', comment: '수신 교사 코멘트', otherNotes: '인계 내부 메모' };
  const saved = await call(db, { action: 'save', handoffId: id, revision: 2, dataGeneration: 0, memo }, recipient, at('15:20'));
  assert.equal(saved.status, 200); assert.deepEqual(saved.body.handoff.memo, memo);
  const finished = await call(db, { action: 'complete', handoffId: id, revision: 3, dataGeneration: 0,
    completedAt: at('22:00') }, recipient, at('15:55'));
  assert.equal(finished.status, 200); assert.equal(finished.body.handoff.completedAt, at('15:55'));
  assert.equal(finished.body.handoff.status, 'completed'); assert.equal(db.count('lesson_handoff_events'), 4);
  assert.deepEqual(db.sqlite.prepare('SELECT owner,data FROM tasks').get(), canonicalBefore);
  assert.deepEqual(db.sqlite.prepare('SELECT owner,data FROM checks').get(), checkBefore);
  assert.deepEqual(db.physical(), visitBefore);
  assert.equal(db.count('session_pack_usage'), 0); assert.equal(db.count('session_packs'), 0);
  assert.deepEqual(finished.body.handoff.sourceMemo, created.sourceMemo);
});

test('list scopes source/recipient, includes minimal recipients only, and never discloses full source records', async t => {
  const db = fixture(t); await createOk(db);
  for (const auth of [source, recipient, admin]) {
    const response = await call(db, { action: 'list', date, dataGeneration: 0 }, auth);
    assert.equal(response.status, 200); assert.equal(response.body.handoffs.length, 1);
    assert.deepEqual(response.body.handoffs[0].student, { id: 'student-a', name: '학생', school: '학교', grade: '중1' });
    assert.ok(response.body.recipients.every(staff => Object.keys(staff).sort().join(',') === 'name,staffId'));
    assert.ok(!response.body.recipients.some(staff => staff.staffId === 'teacher-inactive'));
    assert.doesNotMatch(JSON.stringify(response.body), /private-marker|guardianPhone|privateField|teacherIds/);
  }
  const unrelated = await call(db, { action: 'list', date, dataGeneration: 0 }, stranger);
  assert.equal(unrelated.body.handoffs.length, 0);
  const otherDate = await call(db, { action: 'list', date: '2026-08-29', dataGeneration: 0 });
  assert.equal(otherDate.body.handoffs.length, 0);
});

test('create is idempotent only for the same identity and payload; one active handoff per source day', async t => {
  const db = fixture(t); await createOk(db);
  const retry = await call(db, createBody()); assert.equal(retry.status, 200); assert.equal(retry.body.idempotent, true);
  assert.equal(db.count('lesson_handoff_events'), 1);
  const changed = await call(db, createBody({ note: 'changed' }));
  assert.equal(changed.status, 409); assert.equal(changed.body.code, 'HANDOFF_ID_CONFLICT');
  const duplicate = await call(db, createBody({ handoffId: 'lh_' + 'b'.repeat(32) }));
  assert.equal(duplicate.status, 409); assert.equal(duplicate.body.code, 'HANDOFF_ALREADY_EXISTS');
  assert.equal(db.count('lesson_handoffs'), 1);
});

test('source memo snapshot remains unchanged after later source memo edits, including legacy notes', async t => {
  const db = fixture(t);
  db.check({ lessonMemo: undefined, note: 'legacy source note' });
  const row = await createOk(db); assert.equal(row.sourceMemo.contentProgress, 'legacy source note');
  db.check({ lessonMemo: { ...blankMemo(), contentProgress: 'edited later' } });
  const accepted = await acceptOk(db);
  assert.equal(accepted.sourceMemo.contentProgress, 'legacy source note');
  assert.equal(JSON.parse(db.handoff().source_memo_json).contentProgress, 'legacy source note');
});

test('half-T split accepts 1.5T+0.5T and rejects mismatched, empty, negative and quarter-T parts', async t => {
  const db = fixture(t);
  for (const [completedHours, remainingHours] of [['1T', '0.5T'], ['0T', '2T'], ['-1T', '3T'], ['1.25T', '0.75T'], ['', '2T']]) {
    const response = await call(db, createBody({ completedHours, remainingHours })); assert.equal(response.status, 422);
  }
  const row = await createOk(db, { completedHours: '1.5T', remainingHours: '0.5T' });
  assert.equal(row.totalHours, '2T'); assert.equal(row.remainingHours, '0.5T');
});

test('multiple same-day slots require an exact explicit id and use that slot hours', async t => {
  const db = fixture(t);
  db.task({ scheduleSlots: [
    { slotId: 'slot-a', days: [0], startTime: '13:00', endTime: '14:50', lessonHours: '2T' },
    { slotId: 'slot-b', days: [0], startTime: '16:00', endTime: '17:20', lessonHours: '1.5T' }
  ] });
  let response = await call(db, createBody({ slotId: undefined })); assert.equal(response.body.code, 'HANDOFF_SLOT_REQUIRED');
  response = await call(db, createBody({ slotId: 'not-a-slot' })); assert.equal(response.body.code, 'HANDOFF_SLOT_INVALID');
  response = await call(db, createBody({ slotId: 'slot-b' })); assert.equal(response.body.code, 'HANDOFF_HOURS_MISMATCH');
  const row = await createOk(db, { slotId: 'slot-b', remainingHours: '0.5T' }); assert.equal(row.totalHours, '1.5T');
});

test('single legacy slot without slotId is accepted without inventing an identifier', async t => {
  const db = fixture(t);
  db.task({ scheduleSlots: [{ days: [0], startTime: '13:00', endTime: '14:50', lessonHours: '2T' }] });
  const row = await createOk(db, { slotId: undefined }); assert.equal(row.slotId, null);
  await acceptOk(db); assert.ok(await grant(db));
});

for (const [label, change] of [
  ['deleted task', { deleted: true }],
  ['future task', { start: '2026-09-01' }],
  ['expired task', { end: '2026-08-29' }],
  ['wrong source day', { scheduleSlots: [{ slotId: 'slot-a', days: [6], startTime: '13:00', endTime: '14:50', lessonHours: '2T' }] }],
  ['future slot validity', { scheduleSlots: [{ slotId: 'slot-a', days: [0], startTime: '13:00', endTime: '14:50', lessonHours: '2T', validFrom: '2026-09-01' }] }],
  ['review schedule', { scheduleStatus: 'needs_review' }],
  ['missing explicit T', { lessonHours: '2T', scheduleSlots: [{ slotId: 'slot-a', days: [0], startTime: '13:00', endTime: '15:00' }] }],
  ['non-lesson task', { taskKind: 'other' }]
]) test('create rejects ' + label, async t => {
  const db = fixture(t); db.task(change);
  const response = await call(db, createBody()); assert.ok(response.status >= 400); assert.equal(db.count('lesson_handoffs'), 0);
});

test('create rejects absent, early-leave, mismatched-owner or missing canonical attendance', async t => {
  const db = fixture(t);
  for (const att of ['', 'A', 'E']) {
    db.check({ att });
    const response = await call(db, createBody()); assert.equal(response.body.code, 'HANDOFF_ATTENDANCE_REQUIRED');
  }
  db.check(); db.sqlite.prepare("UPDATE checks SET owner='teacher-b'").run();
  assert.equal((await call(db, createBody())).body.code, 'HANDOFF_ATTENDANCE_REQUIRED');
  db.sqlite.exec('DELETE FROM checks');
  assert.equal((await call(db, createBody())).body.code, 'HANDOFF_ATTENDANCE_REQUIRED');
  assert.equal(db.count('lesson_handoffs'), 0);
});

test('create requires exact stable student identity and active distinct teachers', async t => {
  const db = fixture(t);
  for (const changes of [ { studentId: 'student-other' }, { recipientStaffId: 'teacher-a' },
    { recipientStaffId: 'teacher-inactive' }, { recipientStaffId: 'teacher-missing' } ]) {
    assert.ok((await call(db, createBody(changes))).status >= 400);
  }
  assert.equal((await call(db, createBody(), stranger)).status, 403);
  db.roster({ deleted: true }); assert.equal((await call(db, createBody())).body.code, 'HANDOFF_STUDENT_IDENTITY');
  db.roster({ end: '2026-08' }); assert.equal((await call(db, createBody())).body.code, 'HANDOFF_STUDENT_INACTIVE');
  assert.equal(db.count('lesson_handoffs'), 0);
});

test('date/cutoff rules allow future start today but not future record dates, invalid dates or post-cutoff edits', async t => {
  const db = fixture(t);
  assert.equal((await call(db, createBody({ recordDate: '2026-08-31' }))).body.code, 'HANDOFF_DATE_CLOSED');
  assert.equal((await call(db, createBody({ sourceDate: '2026-02-30' }))).body.code, 'HANDOFF_INPUT_INVALID');
  assert.equal((await call(db, createBody({ startTime: '23:50' }))).body.code, 'HANDOFF_INPUT_INVALID');
  assert.equal((await call(db, createBody({ startTime: '13:59' }))).body.code, 'HANDOFF_START_BEFORE_ARRIVAL');
  assert.equal((await call(db, createBody(), source, at('23:50'))).body.code, 'HANDOFF_CUTOFF');
  await createOk(db); await acceptOk(db);
  const beforeStart = await call(db, { action: 'complete', handoffId: id, revision: 2, dataGeneration: 0 }, recipient, at('14:59'));
  assert.equal(beforeStart.body.code, 'HANDOFF_NOT_STARTED');
  const late = await call(db, { action: 'save', handoffId: id, revision: 2, dataGeneration: 0, memo: blankMemo() }, recipient, at('23:50'));
  assert.equal(late.body.code, 'HANDOFF_CUTOFF');
  const tomorrow = await call(db, { action: 'complete', handoffId: id, revision: 2, dataGeneration: 0 }, recipient, at('00:00', '2026-08-31'));
  assert.equal(tomorrow.body.code, 'HANDOFF_DATE_CLOSED');
});

test('recipient/admin are the only accept/save/complete actors, and completion requires acceptance', async t => {
  const db = fixture(t); await createOk(db);
  const update = { handoffId: id, revision: 1, dataGeneration: 0 };
  assert.equal((await call(db, { ...update, action: 'accept' }, source)).status, 403);
  assert.equal((await call(db, { ...update, action: 'accept' }, stranger)).status, 404);
  assert.equal((await call(db, { ...update, action: 'complete' }, recipient)).body.code, 'HANDOFF_STATUS_INVALID');
  const accepted = await call(db, { ...update, action: 'accept' }, admin); assert.equal(accepted.status, 200);
  assert.equal((await call(db, { ...update, revision: 2, action: 'save', memo: blankMemo() }, source)).status, 403);
});

test('source pending cancellation needs a reason, preserves history, and permits a fresh corrected handoff', async t => {
  const db = fixture(t); await createOk(db);
  const input = { action: 'cancel', handoffId: id, revision: 1, dataGeneration: 0 };
  assert.equal((await call(db, input)).body.code, 'HANDOFF_CANCEL_REASON_REQUIRED');
  assert.equal((await call(db, { ...input, reason: 'source correction' }, recipient)).status, 403);
  const canceled = await call(db, { ...input, reason: 'source correction' }); assert.equal(canceled.status, 200);
  assert.equal(canceled.body.handoff.status, 'cancelled'); assert.equal(db.count('lesson_handoff_events'), 2);
  const recreated = await call(db, createBody({ handoffId: 'lh_' + 'b'.repeat(32) }));
  assert.equal(recreated.status, 200); assert.equal(db.count('lesson_handoffs'), 2);
});

test('accepted/completed cancellation is admin-only and administrator history correction works after cutoff', async t => {
  const db = fixture(t); await createOk(db); await acceptOk(db);
  const input = { action: 'cancel', handoffId: id, revision: 2, dataGeneration: 0, reason: '관리자 정정' };
  assert.equal((await call(db, input, source)).status, 403);
  const response = await call(db, input, admin, at('23:55')); assert.equal(response.status, 200);
  assert.equal(response.body.handoff.acceptedAt, at('14:55')); assert.equal(response.body.handoff.cancelReason, '관리자 정정');
  assert.equal(await grant(db), null);
});

test('generation mismatch rejects stale reads/writes and hides retained old-generation histories', async t => {
  const db = fixture(t); await createOk(db);
  db.sqlite.exec("UPDATE app_data_generations SET generation=1 WHERE app='task'");
  assert.equal((await call(db, { action: 'list', date, dataGeneration: 0 })).body.code, 'DATA_GENERATION_MISMATCH');
  assert.equal((await call(db, { action: 'list', date, dataGeneration: 1 })).body.handoffs.length, 0);
  assert.equal((await call(db, { action: 'accept', handoffId: id, revision: 1, dataGeneration: 1 }, recipient)).body.code, 'DATA_GENERATION_MISMATCH');
  assert.equal(await grant(db), null);
});

test('legacy local fixture without generation table is compatible only with generation zero', async t => {
  const db = fixture(t); db.sqlite.exec('DROP TABLE app_data_generations');
  assert.equal((await call(db, createBody({ dataGeneration: 1 }))).body.code, 'DATA_GENERATION_MISMATCH');
  await createOk(db); await acceptOk(db); assert.ok(await grant(db));
});

for (const [label, race] of [
  ['task owner', db => db.task({ staffId: 'teacher-c' })],
  ['canonical attendance', db => db.check({ att: 'A' })],
  ['student roster', db => db.roster({ deleted: true })],
  ['recipient staff', db => db.staff('teacher-b', { deleted: true })],
  ['source staff', db => db.staff('teacher-a', { deleted: true })],
  ['data generation', db => db.sqlite.exec("UPDATE app_data_generations SET generation=1 WHERE app='task'")],
  ['physical visit', db => db.sqlite.prepare("UPDATE weekend_actual_visits SET status='cancelled',revision=2,updated_at=? WHERE visit_id=?").run(at('14:51'), visitId)]
]) test('create atomically refuses a concurrent ' + label + ' change without orphan events', async t => {
  const db = fixture(t); db.beforeBatch = () => race(db);
  const response = await call(db, createBody());
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(db.count('lesson_handoffs'), 0); assert.equal(db.count('lesson_handoff_events'), 0);
  assert.equal(db.count('task_write_cas_guards'), 0);
});

test('same-id concurrent create retries are idempotent without duplicate audit events', async t => {
  const db = fixture(t);
  db.beforeBatch = async () => { assert.equal((await call(db, createBody())).status, 200); };
  const response = await call(db, createBody()); assert.equal(response.status, 200); assert.equal(response.body.idempotent, true);
  assert.equal(db.count('lesson_handoffs'), 1); assert.equal(db.count('lesson_handoff_events'), 1);
});

test('same-id concurrent payload mismatch returns a conflict, not a partial write or server failure', async t => {
  const db = fixture(t);
  db.beforeBatch = async () => { assert.equal((await call(db, createBody({ note: 'other client' }))).status, 200); };
  const response = await call(db, createBody()); assert.equal(response.status, 409); assert.equal(response.body.code, 'HANDOFF_ID_CONFLICT');
  assert.equal(db.count('lesson_handoffs'), 1); assert.equal(db.count('lesson_handoff_events'), 1);
});

test('revision CAS prevents two recipients from overwriting state and rolls back the losing event', async t => {
  const db = fixture(t); await createOk(db);
  db.beforeBatch = async () => { await acceptOk(db); };
  const response = await call(db, { action: 'accept', handoffId: id, revision: 1, dataGeneration: 0 }, recipient, at('14:55'));
  assert.equal(response.status, 409); assert.equal(db.handoff().status, 'accepted');
  assert.equal(db.handoff().revision, 2); assert.equal(db.count('lesson_handoff_events'), 2);
  const stale = await call(db, { action: 'save', handoffId: id, revision: 1, dataGeneration: 0, memo: blankMemo() }, recipient);
  assert.equal(stale.body.code, 'HANDOFF_REVISION_CONFLICT');
});

test('audit insert failure rolls back both sidecar row and successful CAS guard', async t => {
  const db = fixture(t); db.failEventOnce = true;
  const response = await call(db, createBody()); assert.equal(response.status, 500);
  assert.equal(db.count('lesson_handoffs'), 0); assert.equal(db.count('lesson_handoff_events'), 0);
  assert.equal(db.count('task_write_cas_guards'), 0);
});

test('ledger identity and source memo are immutable and events can never be updated/deleted', async t => {
  const db = fixture(t); await createOk(db);
  for (const assignment of ["source_staff_id='teacher-c'", "recipient_staff_id='teacher-c'", "source_date='2026-08-29'",
    "source_memo_json='{}'", "student_id='student-b'", 'total_half_units=6', "visit_id=NULL"]) {
    assert.throws(() => db.sqlite.prepare('UPDATE lesson_handoffs SET ' + assignment + ',revision=revision+1,updated_at=updated_at+1 WHERE handoff_id=?').run(id));
  }
  assert.throws(() => db.sqlite.exec("DELETE FROM lesson_handoffs"), /LESSON_HANDOFF_NO_DELETE/);
  assert.throws(() => db.sqlite.exec("UPDATE lesson_handoff_events SET event_data='{}'"), /LESSON_HANDOFF_EVENT_IMMUTABLE/);
  assert.throws(() => db.sqlite.exec('DELETE FROM lesson_handoff_events'), /LESSON_HANDOFF_EVENT_IMMUTABLE/);
  assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
});

test('weekend cross-day mapping uses the bound actual visit and actual canonical check; list is actual-date scoped', async t => {
  const db = fixture(t, { physical: false });
  db.task({ days: [6], scheduleSlots: [{ slotId: 'slot-a', days: [6], startTime: '13:00', endTime: '14:50', lessonHours: '2T' }] });
  db.visit({ sourceDate: '2026-08-29' });
  const created = await createOk(db, { sourceDate: '2026-08-29' });
  assert.equal(created.sourceDate, '2026-08-29'); assert.equal(created.recordDate, date); assert.equal(created.attendance.att, 'L');
  assert.equal((await call(db, { action: 'list', date: '2026-08-29' })).body.handoffs.length, 0);
  assert.equal((await call(db, { action: 'list', date })).body.handoffs.length, 1);
  await acceptOk(db); assert.equal((await grant(db)).sourceDate, '2026-08-29');
});

test('legacy NULL-source weekend visit maps only deterministically, not to an arbitrary opposite-day slot', async t => {
  const db = fixture(t, { physical: false });
  db.visit({ sourceDate: null });
  const created = await createOk(db); assert.equal(created.visit.sourceDate, null);
  await acceptOk(db); assert.ok(await grant(db));
});

test('cross-day mapping rejects meaningful original-day checks and accepts an empty legacy placeholder', async t => {
  const db = fixture(t, { physical: false });
  db.task({ days: [6], scheduleSlots: [{ slotId: 'slot-a', days: [6], startTime: '13:00', endTime: '14:50', lessonHours: '2T' }] });
  db.visit({ sourceDate: '2026-08-29' });
  db.check({ att: 'L' }, '2026-08-29');
  assert.equal((await call(db, createBody({ sourceDate: '2026-08-29' }))).body.code, 'HANDOFF_DATE_MAPPING');
  db.check({ att: '', done: false, lessonMemo: blankMemo(), note: '' }, '2026-08-29');
  await createOk(db, { sourceDate: '2026-08-29' });
});

test('cross-day source-check race is caught even when the late change is only checked items', async t => {
  const db = fixture(t, { physical: false });
  db.task({ days: [6], scheduleSlots: [{ slotId: 'slot-a', days: [6], startTime: '13:00', endTime: '14:50', lessonHours: '2T' }] });
  db.visit({ sourceDate: '2026-08-29' });
  db.beforeBatch = () => db.check({ att: '', done: false, lessonMemo: blankMemo(), note: '', items: [true] }, '2026-08-29');
  assert.equal((await call(db, createBody({ sourceDate: '2026-08-29' }))).status, 409);
  assert.equal(db.count('lesson_handoffs'), 0);
});

test('fixed same-day lesson works without a visit but flexible attendance requires a physical record', async t => {
  const db = fixture(t, { physical: false });
  db.task({ weekendAttendanceMode: 'flexible', weekendAllowedDays: [0], weekendMonthlyTarget: 4, weekendFlexibleFrom: '2026-08-01' });
  assert.equal((await call(db, createBody())).body.code, 'HANDOFF_DATE_MAPPING');
  db.task(); const row = await createOk(db); assert.equal(row.visit, null);
});

test('weekday lesson uses the same source/record date and never fabricates a weekend visit', async t => {
  const db = fixture(t, { physical: false });
  const weekday = '2026-08-31';
  db.task({ days: [1], scheduleSlots: [{ slotId: 'slot-a', days: [1], startTime: '13:00', endTime: '14:50', lessonHours: '2T' }] });
  db.check({}, weekday);
  const response = await call(db, createBody({ sourceDate: weekday, recordDate: weekday }), source, at('14:50', weekday));
  assert.equal(response.status, 200); assert.equal(response.body.handoff.visit, null);
});

test('checkout grant is recipient-only, starts at the handoff time, expires at midnight but not 23:50', async t => {
  const db = fixture(t); await createOk(db);
  assert.equal(await grant(db), null);
  await acceptOk(db);
  assert.equal(await grant(db, recipient, at('14:59')), null);
  assert.equal(await grant(db, source), null); assert.equal(await grant(db, stranger), null);
  assert.deepEqual(await grant(db), { handoffId: id, revision: 2, sourceDate: date });
  assert.ok(await grant(db, recipient, at('23:59')));
  assert.equal(await grant(db, recipient, at('00:00', '2026-08-31')), null);
});

test('checkout grant accepts exact completed visit retry but rejects other visits, stale physical revisions and cancelled visits', async t => {
  const db = fixture(t); await createOk(db); await acceptOk(db);
  const physicalBefore = db.physical();
  db.sqlite.prepare("UPDATE weekend_actual_visits SET status='completed',check_out_at=?,revision=2,updated_at=? WHERE visit_id=?")
    .run(at('16:00'), at('16:00'), visitId);
  assert.ok(await grant(db, recipient, at('16:01')));
  assert.equal(await grant(db, recipient, at('16:01'), physicalBefore), null);
  db.visit({ visitId: 'wv_' + 'b'.repeat(32), sequence: 2, checkInAt: at('17:00') });
  const newer = db.sqlite.prepare('SELECT * FROM weekend_actual_visits WHERE visit_sequence=2').get();
  assert.equal(await grant(db, recipient, at('17:10'), newer), null);
  db.sqlite.prepare("UPDATE weekend_actual_visits SET status='cancelled',revision=3,updated_at=? WHERE visit_id=?").run(at('17:20'), visitId);
  assert.equal(await grant(db, recipient, at('17:21')), null);
});

test('checkout grant fails closed when source ownership, slot identity, target employment or generation changes', async t => {
  const db = fixture(t); await createOk(db); await acceptOk(db);
  db.task({ staffId: 'teacher-c' }); assert.equal(await grant(db), null);
  db.task({ scheduleSlots: [{ slotId: 'changed-slot', days: [0], startTime: '13:00', endTime: '14:50', lessonHours: '2T' }] });
  assert.equal(await grant(db), null);
  db.task(); db.staff('teacher-b', { deleted: true }); assert.equal(await grant(db), null);
  db.staff('teacher-b'); db.sqlite.exec("UPDATE app_data_generations SET generation=1 WHERE app='task'"); assert.equal(await grant(db), null);
});

test('mutable memo validates shape, rejects extra fields/oversize data, and cannot replace source memo', async t => {
  const db = fixture(t); await createOk(db); await acceptOk(db);
  const input = { action: 'save', handoffId: id, revision: 2, dataGeneration: 0 };
  for (const memo of [null, [], { arbitrary: 'field' }, { contentProgress: 'x'.repeat(4001) }, { homework: 7 }]) {
    assert.equal((await call(db, { ...input, memo }, recipient)).body.code, 'HANDOFF_MEMO_INVALID');
  }
  const saved = await call(db, { ...input, memo: { contentProgress: 'receiver' }, sourceMemo: { contentProgress: 'forged source' } }, recipient);
  assert.equal(saved.status, 200); assert.equal(saved.body.handoff.sourceMemo.contentProgress, '원 교사 진도');
  assert.equal(saved.body.handoff.memo.contentProgress, 'receiver');
});

test('disabled schema and invalid authentication fail without exposing internal data', async t => {
  const db = fixture(t);
  const response = await atNow(at('14:50'), () => handleLessonHandoff({ DB: db }, 'consult', createBody(), '*', source, json));
  assert.equal(response.status, 400);
  assert.equal((await call(db, createBody(), null)).status, 401);
  db.sqlite.exec('DROP TABLE lesson_handoff_events');
  assert.equal((await call(db, createBody())).body.code, 'LESSON_HANDOFF_NOT_READY');
  assert.equal(db.count('lesson_handoffs'), 0);
});

test('new create rejects a checked-out visit but existing handoff completion and memo correction remain allowed', async t => {
  const db = fixture(t);
  const created = await createOk(db); await acceptOk(db);
  db.sqlite.prepare("UPDATE weekend_actual_visits SET status='completed',check_out_at=?,revision=2,updated_at=? WHERE visit_id=?")
    .run(at('16:00'), at('16:00'), visitId);
  const completed = await call(db, { action: 'complete', handoffId: id, revision: 2, dataGeneration: 0 }, recipient, at('16:01'));
  assert.equal(completed.status, 200);
  const saved = await call(db, { action: 'save', handoffId: id, revision: 3, dataGeneration: 0,
    memo: { contentProgress: '하원 후 실제 진도 기록' } }, recipient, at('16:02'));
  assert.equal(saved.status, 200); assert.deepEqual(saved.body.handoff.sourceMemo, created.sourceMemo);
  const retry = await call(db, createBody(), source, at('16:03'));
  assert.equal(retry.status, 200); assert.equal(retry.body.idempotent, true);
  const cancelled = await call(db, { action: 'cancel', handoffId: id, revision: 4, dataGeneration: 0, reason: 'test correction' }, admin, at('16:04'));
  assert.equal(cancelled.status, 200);
  const newRecord = await call(db, createBody({ handoffId: 'lh_' + 'b'.repeat(32) }), source, at('16:05'));
  assert.equal(newRecord.body.code, 'HANDOFF_VISIT_COMPLETED');
});

for (const [label, taskChanges] of [
  ['slot timing', { scheduleSlots: [{ slotId: 'slot-a', days: [0], startTime: '18:00', endTime: '19:50', lessonHours: '2T' }] }],
  ['slot validity', { scheduleSlots: [{ slotId: 'slot-a', days: [0], startTime: '13:00', endTime: '14:50', lessonHours: '2T', validFrom: '2026-08-02' }] }],
  ['slot role', { scheduleSlots: [{ slotId: 'slot-a', days: [0], startTime: '13:00', endTime: '14:50', lessonHours: '2T', lessonRole: 'new-role' }] }],
  ['assignment key', { lessonAssignmentKey: 'new-assignment' }],
  ['subject', { subject: '영어' }],
  ['class scope', { className: '다른 반' }],
  ['lesson role', { lessonRole: 'replacement-role' }]
]) test('semantic identity prevents positional slot reuse after ' + label + ' changes and disables stale UI actions', async t => {
  const db = fixture(t); await createOk(db); await acceptOk(db); db.task(taskChanges);
  const result = await call(db, { action: 'complete', handoffId: id, revision: 2, dataGeneration: 0 }, recipient, at('16:00'));
  assert.equal(result.body.code, 'HANDOFF_CONTEXT_CHANGED');
  const listed = await call(db, { action: 'list', date, dataGeneration: 0 }, recipient, at('16:00'));
  const view = listed.body.handoffs[0];
  assert.equal(view.editable.accept, false); assert.equal(view.editable.save, false); assert.equal(view.editable.complete, false);
  assert.deepEqual(Object.keys(view.lesson).sort(), ['subject', 'title']);
  assert.equal(await grant(db, recipient, at('16:00')), null);
});

test('incidental title/instruction edits do not change the assigned lesson identity', async t => {
  const db = fixture(t); await createOk(db); await acceptOk(db);
  db.task({ title: '수업 표기 정정', materials: 'same lesson new book instructions' });
  const result = await call(db, { action: 'complete', handoffId: id, revision: 2, dataGeneration: 0 }, recipient, at('16:00'));
  assert.equal(result.status, 200); assert.ok(await grant(db));
});

test('source-day blocked/checklist/absence/count metadata is never silently remapped to an actual-day handoff', async t => {
  const db = fixture(t, { physical: false });
  db.task({ days: [6], scheduleSlots: [{ slotId: 'slot-a', days: [6], startTime: '13:00', endTime: '14:50', lessonHours: '2T' }] });
  db.visit({ sourceDate: '2026-08-29' });
  for (const meaningful of [{ blocked: true }, { at: 123 }, { absenceType: 'approved_absence' }, { count: 1 }, { steps: { first: true } }]) {
    db.check({ att: '', done: false, lessonMemo: blankMemo(), note: '', ...meaningful }, '2026-08-29');
    assert.equal((await call(db, createBody({ sourceDate: '2026-08-29' }))).body.code, 'HANDOFF_DATE_MAPPING');
  }
});

test('pending cancellation CAS rechecks the source employment state', async t => {
  const db = fixture(t); await createOk(db);
  db.beforeBatch = () => db.staff('teacher-a', { deleted: true });
  const result = await call(db, { action: 'cancel', handoffId: id, revision: 1, dataGeneration: 0, reason: 'change' });
  assert.equal(result.status, 409); assert.equal(db.handoff().status, 'pending'); assert.equal(db.count('lesson_handoff_events'), 1);
});

test('save CAS rechecks source semantics and keeps the previous receiver memo on concurrent reassignment', async t => {
  const db = fixture(t); await createOk(db); await acceptOk(db);
  db.beforeBatch = () => db.task({ lessonAssignmentKey: 'changed-concurrently' });
  const result = await call(db, { action: 'save', handoffId: id, revision: 2, dataGeneration: 0,
    memo: { contentProgress: 'must not commit' } }, recipient, at('15:30'));
  assert.equal(result.status, 409); assert.deepEqual(JSON.parse(db.handoff().memo_json), blankMemo());
  assert.equal(db.handoff().revision, 2); assert.equal(db.count('lesson_handoff_events'), 2);
});
