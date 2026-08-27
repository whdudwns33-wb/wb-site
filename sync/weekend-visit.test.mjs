import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { handleWeekendVisit, weekendVisitInternals } from './weekend-visit.js';

const migration = fs.readFileSync(new URL('./migrations/050_weekend_actual_visits.sql', import.meta.url), 'utf8');
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
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.beforeVisitInsert = null;
    this.sqlite.exec('PRAGMA foreign_keys=ON; CREATE TABLE tasks (app TEXT NOT NULL,id TEXT NOT NULL,owner TEXT,data TEXT NOT NULL,updated_at INTEGER NOT NULL,srv_at INTEGER NOT NULL,PRIMARY KEY(app,id)); CREATE TABLE private_rosters (app TEXT NOT NULL PRIMARY KEY,data TEXT NOT NULL,updated_at INTEGER NOT NULL);');
    this.sqlite.exec(migration);
  }
  prepareNative(sql) { return this.sqlite.prepare(sql); }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
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

test('050 migration is additive, mirrored in schema, and wired before deployment', () => {
  assert.doesNotMatch(migration, /DROP TABLE|DELETE FROM|UPDATE tokens/i);
  for (const name of ['weekend_actual_visits', 'weekend_actual_visit_events', 'trg_weekend_actual_visits_no_delete']) {
    assert.match(migration, new RegExp(name));
    assert.match(schema, new RegExp(name));
  }
  assert.match(worker, /import \{ handleWeekendVisit \} from '\.\/weekend-visit\.js'/);
  assert.match(worker, /url\.pathname === '\/weekend-visit'/);
  assert.match(readme, /050_weekend_actual_visits\.sql[\s\S]*Worker[\s\S]*task Pages/);
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

  const listed = await call(db, { action: 'list', visitDate: '2026-08-22' });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.visits.length, 1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) count FROM weekend_actual_visit_events').get().count, 1);
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
