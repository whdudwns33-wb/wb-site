import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import worker from './worker-core.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/045_student_change_history.sql', import.meta.url), 'utf8');

class Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  first() { return this.database.prepare(this.sql).get(...this.args) || null; }
  all() { return { results: this.database.prepare(this.sql).all(...this.args) }; }
  run() { const result = this.database.prepare(this.sql).run(...this.args); return { meta: { changes: Number(result.changes || 0) } }; }
}
class TestD1 {
  constructor() { this.database = new DatabaseSync(':memory:'); this.database.exec(schema); }
  prepare(sql) { return new Statement(this.database, sql); }
  batch(statements) { return statements.map(statement => statement.run()); }
}

const admin = { mode: 'admin', secret: 'director-secret' };
const person = id => ({ mode: 'person', id, token: 'tok-' + id });
async function call(db, path, body) {
  const response = await worker.fetch(new Request('https://worker.example' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app: 'task', ...body })
  }), { DB: db, TASK_ADMIN_SECRET: 'director-secret', CONSULT_ADMIN_SECRET: 'consult-secret' });
  return { status: response.status, body: await response.json() };
}

function seed(db) {
  const now = Date.now();
  for (const [id, name] of [['teacher-a', '가선생'], ['teacher-b', '나선생']]) {
    db.prepare("INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES('task',?,?,?, ?, ?)")
      .bind(id, id, JSON.stringify({ id, name, deleted: false }), now, now).run();
    db.prepare("INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES('task',?,?,?,0)")
      .bind('tok-' + id, id, now).run();
  }
  const roster = {
    roster: { updated: '2026-08-19', baseline: '2026-08', students: [{
      id: 'student-a', name: '학생A', grade: '중1', teacher: '가선생', subject: '영어',
      start: '2026-08', end: '', reason: '', memo: '', entryType: 'existing', teacherIds: ['teacher-a']
    }] },
    bookStudents: []
  };
  db.prepare("INSERT INTO private_rosters(app,data,updated_at) VALUES('task',?,?)").bind(JSON.stringify(roster), now).run();
  const task = {
    id: 'lesson-a', staffId: 'teacher-a', studentId: 'student-a', studentName: '학생A', grade: '중1',
    title: '[수업] 학생A (중1) — 영어', detail: '교재', guide: '업무지시', steps: [], target: 0,
    unit: '회', time: '18:00', repeat: 'days', days: [1, 3], start: '2026-08-01', end: '',
    createdAt: now, updatedAt: now, deleted: false, origin: 'admin'
  };
  db.prepare("INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES('task','lesson-a','teacher-a',?,?,?)")
    .bind(JSON.stringify(task), now, now).run();
}

test('migration is additive, append-only, and keeps deletion audit rows private by contract', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS student_change_events/);
  assert.match(migration, /student_change_acknowledgements/);
  assert.match(migration, /APPEND_ONLY/);
  assert.doesNotMatch(migration, /DROP TABLE|DELETE FROM/i);
});

test('teacher change is admin-selected, recorded by stable student id, and acknowledged independently', async () => {
  const db = new TestD1(); seed(db);
  const submit = await call(db, '/lesson-change-request', {
    auth: person('teacher-a'), action: 'submit', taskId: 'lesson-a',
    changes: { operation: 'teacher_assignment', effectiveDate: '2026-08-24' }, note: '담당 변경 요청'
  });
  assert.equal(submit.status, 200);
  const missing = await call(db, '/lesson-change-review', {
    auth: admin, action: 'approve', requestKey: submit.body.request.requestKey, revision: 1
  });
  assert.equal(missing.status, 400);
  const approve = await call(db, '/lesson-change-review', {
    auth: admin, action: 'approve', requestKey: submit.body.request.requestKey, revision: 1,
    selectedStaffId: 'teacher-b'
  });
  assert.equal(approve.status, 200);

  const taskRow = db.prepare("SELECT owner,data FROM tasks WHERE app='task' AND id='lesson-a'").first();
  assert.equal(taskRow.owner, 'teacher-b');
  assert.equal(JSON.parse(taskRow.data).staffId, 'teacher-b');
  const roster = JSON.parse(db.prepare("SELECT data FROM private_rosters WHERE app='task'").first().data);
  assert.ok(roster.roster.students[0].teacherIds.includes('teacher-b'));

  const oldTeacher = await call(db, '/student-change', { auth: person('teacher-a'), action: 'list' });
  const newTeacher = await call(db, '/student-change', { auth: person('teacher-b'), action: 'list' });
  const director = await call(db, '/student-change', { auth: admin, action: 'list' });
  for (const result of [oldTeacher, newTeacher, director]) {
    assert.equal(result.status, 200);
    assert.equal(result.body.events[0].studentId, 'student-a');
    assert.equal(result.body.events[0].eventType, 'teacher_assignment');
    assert.equal(result.body.events[0].effectiveDate, '2026-08-24');
    assert.equal(result.body.events[0].acknowledged, false);
  }
  await call(db, '/student-change', { auth: person('teacher-a'), action: 'acknowledge', studentId: 'student-a' });
  const oldAfter = await call(db, '/student-change', { auth: person('teacher-a'), action: 'list' });
  const directorAfter = await call(db, '/student-change', { auth: admin, action: 'list' });
  assert.equal(oldAfter.body.events[0].acknowledged, true);
  assert.equal(directorAfter.body.events[0].acknowledged, false);
});

test('withdrawal updates roster history date while approved lesson deletion remains only in storage', async () => {
  const db = new TestD1(); seed(db);
  const withdrawal = await call(db, '/lesson-change-request', {
    auth: person('teacher-a'), action: 'submit', taskId: 'lesson-a',
    changes: { operation: 'withdrawal', effectiveDate: '2026-08-25' }, note: '퇴원'
  });
  assert.equal(withdrawal.status, 200);
  assert.equal((await call(db, '/lesson-change-review', {
    auth: admin, action: 'approve', requestKey: withdrawal.body.request.requestKey, revision: 1
  })).status, 200);
  const roster = JSON.parse(db.prepare("SELECT data FROM private_rosters WHERE app='task'").first().data);
  assert.equal(roster.roster.students[0].end, '2026-09');
  assert.match(roster.roster.students[0].reason, /2026-08-25/);

  const deletion = await call(db, '/lesson-change-request', {
    auth: person('teacher-a'), action: 'submit', taskId: 'lesson-a',
    changes: { operation: 'lesson_delete', effectiveDate: '2026-08-26' }, note: '수업 종료'
  });
  assert.equal(deletion.status, 200);
  assert.equal((await call(db, '/lesson-change-review', {
    auth: admin, action: 'approve', requestKey: deletion.body.request.requestKey, revision: 2
  })).status, 200);
  assert.equal(JSON.parse(db.prepare("SELECT data FROM tasks WHERE id='lesson-a'").first().data).deleted, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM student_change_events WHERE event_type='lesson_delete'").first().count, 1);
  const visible = await call(db, '/student-change', { auth: admin, action: 'list' });
  assert.equal(visible.body.events.some(event => event.eventType === 'lesson_delete'), false);
});
