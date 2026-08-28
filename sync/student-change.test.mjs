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
  for (const [id, name] of [['teacher-a', '가선생'], ['teacher-b', '나선생'], ['teacher-c', '옛선생']]) {
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
    taskKind: 'lesson_instruction', lessonFormVersion: 1,
    title: '[수업] 학생A (중1) — 영어', detail: '교재', guide: '업무지시', steps: [], target: 0,
    unit: '회', time: '18:00', repeat: 'days', days: [1, 3], start: '2026-08-01', end: '',
    createdAt: now, updatedAt: now, deleted: false, origin: 'admin'
  };
  db.prepare("INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES('task','lesson-a','teacher-a',?,?,?)")
    .bind(JSON.stringify(task), now, now).run();
  const history = { taskId: 'lesson-a', date: '2026-08-20', att: 'L', note: '담당 변경 전 메모', updatedAt: now - 1000 };
  db.prepare("INSERT INTO checks(app,k,owner,data,updated_at,srv_at) VALUES('task','lesson-a|2026-08-20','teacher-a',?,?,?)")
    .bind(JSON.stringify(history), history.updatedAt, history.updatedAt).run();
  const second = { ...task, id: 'lesson-b', title: '[수업] 학생A (중1) — 수학', subject: '수학', days: [2, 4] };
  db.prepare("INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES('task','lesson-b','teacher-a',?,?,?)")
    .bind(JSON.stringify(second), now, now).run();
  for (const [id, end] of [['lesson-ended-c', '2026-08-01'], ['lesson-malformed-c', '종료일오류']]) {
    const oldLesson = { ...task, id, staffId: 'teacher-c', end };
    db.prepare("INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES('task',?,'teacher-c',?,?,?)")
      .bind(id, JSON.stringify(oldLesson), now, now).run();
  }
}

function seedStudentChangeEvent(db, {
  eventId, studentId = 'student-a', taskId = 'lesson-a', eventType = 'work_instruction',
  audienceStaffIds = ['teacher-a'], changedAt = Date.now(), requiresAck = true
}) {
  db.prepare(
    'INSERT INTO student_change_events ' +
    '(app,event_id,student_id,task_id,event_type,changed_fields,details,audience_staff_ids,effective_date,' +
      'requires_ack,request_key,request_revision,changed_at,changed_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).bind(
    'task', eventId, studentId, taskId, eventType, JSON.stringify(['guide']), JSON.stringify({}),
    JSON.stringify(audienceStaffIds), null, requiresAck ? 1 : 0, null, null, changedAt, 'director'
  ).run();
}

function seedStudentChangeAcknowledgement(db, { acknowledgementId, eventId, actorKey, acknowledgedAt }) {
  db.prepare(
    'INSERT INTO student_change_acknowledgements ' +
    '(app,acknowledgement_id,event_id,actor_key,acknowledged_at) VALUES (?,?,?,?,?)'
  ).bind('task', acknowledgementId, eventId, actorKey, acknowledgedAt).run();
}

test('migration is additive, append-only, and keeps deletion audit rows private by contract', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS student_change_events/);
  assert.match(migration, /student_change_acknowledgements/);
  assert.match(migration, /APPEND_ONLY/);
  assert.doesNotMatch(migration, /DROP TABLE|DELETE FROM/i);
});

test('admin resolution clears the addressed teacher marker without forging a teacher acknowledgement', async () => {
  const db = new TestD1(); seed(db);
  const eventId = 'sce_admin_resolution_001';
  const resolvedAt = Date.now() + 100;
  seedStudentChangeEvent(db, { eventId });
  seedStudentChangeAcknowledgement(db, {
    acknowledgementId: 'sca_admin_resolution_001', eventId,
    actorKey: 'admin_resolved:teacher-a', acknowledgedAt: resolvedAt
  });

  const teacher = await call(db, '/student-change', { auth: person('teacher-a'), action: 'list' });
  assert.equal(teacher.status, 200);
  assert.equal(teacher.body.events[0].eventId, eventId);
  assert.equal(teacher.body.events[0].acknowledged, true,
    '관리자 읽음 처리는 해당 선생님의 N과 확인 버튼을 함께 해소한다');

  const idempotent = await call(db, '/student-change', {
    auth: person('teacher-a'), action: 'acknowledge', studentId: 'student-a'
  });
  assert.equal(idempotent.status, 200);
  assert.equal(idempotent.body.idempotent, true);
  assert.equal(idempotent.body.acknowledged, 0);
  assert.equal(db.prepare(
    "SELECT COUNT(*) AS count FROM student_change_acknowledgements WHERE actor_key='staff:teacher-a'"
  ).first().count, 0, '관리자 처리를 실제 선생님 확인으로 위조하지 않는다');

  const director = await call(db, '/student-change', { auth: admin, action: 'list' });
  const event = director.body.events.find(row => row.eventId === eventId);
  assert.equal(event.acknowledged, false,
    '원장 본인의 독립된 확인 상태는 교사 대상 관리자 읽음 처리와 섞지 않는다');
  const status = event.audienceStatus.find(row => row.staffId === 'teacher-a');
  assert.equal(status.acknowledgedAt, resolvedAt);
  assert.equal(status.resolvedByAdminAt, resolvedAt);
});

test('admin audience status is scoped to returned events and keeps an older acknowledgement beyond 5000 unrelated rows', async () => {
  const db = new TestD1(); seed(db);
  const targetEventId = 'sce_target_ack_older_001';
  const hiddenEventId = 'sce_hidden_ack_noise_001';
  seedStudentChangeEvent(db, { eventId: targetEventId, changedAt: 10 });
  seedStudentChangeEvent(db, {
    eventId: hiddenEventId, taskId: null, eventType: 'lesson_delete', audienceStaffIds: [],
    changedAt: 20, requiresAck: false
  });
  seedStudentChangeAcknowledgement(db, {
    acknowledgementId: 'sca_target_ack_older_001', eventId: targetEventId,
    actorKey: 'staff:teacher-a', acknowledgedAt: 1
  });
  db.database.exec('BEGIN');
  try {
    for (let index = 0; index < 5001; index++) {
      const suffix = String(index).padStart(4, '0');
      seedStudentChangeAcknowledgement(db, {
        acknowledgementId: 'sca_hidden_noise_' + suffix,
        eventId: hiddenEventId,
        actorKey: 'staff:noise-' + suffix,
        acknowledgedAt: 100 + index
      });
    }
    db.database.exec('COMMIT');
  } catch (error) {
    db.database.exec('ROLLBACK');
    throw error;
  }

  const director = await call(db, '/student-change', { auth: admin, action: 'list' });
  assert.equal(director.status, 200);
  assert.equal(director.body.events.some(event => event.eventId === hiddenEventId), false,
    '화면에서 숨기는 삭제 이벤트는 반환 범위에 포함하지 않는다');
  const target = director.body.events.find(event => event.eventId === targetEventId);
  assert.ok(target);
  const status = target.audienceStatus.find(row => row.staffId === 'teacher-a');
  assert.equal(status.acknowledgedAt, 1,
    '반환 이벤트의 ACK는 전역 최근 5000행 밖에 있어도 누락하지 않는다');
  assert.equal(status.resolvedByAdminAt, null);
});

test('teacher change is admin-selected, recorded by stable student id, and acknowledged independently', async () => {
  const db = new TestD1(); seed(db);
  const historyBefore = db.prepare("SELECT data,updated_at FROM checks WHERE app='task' AND k='lesson-a|2026-08-20'").first();
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
  const historyRow = db.prepare("SELECT owner,data,updated_at,srv_at FROM checks WHERE app='task' AND k='lesson-a|2026-08-20'").first();
  assert.equal(historyRow.owner, 'teacher-b');
  assert.deepEqual(JSON.parse(historyRow.data), {
    taskId: 'lesson-a', date: '2026-08-20', att: 'L', note: '담당 변경 전 메모', updatedAt: historyRow.updated_at
  });
  assert.equal(historyRow.updated_at, historyBefore.updated_at);
  assert.equal(historyRow.data, historyBefore.data);
  assert.ok(historyRow.srv_at > historyRow.updated_at);
  const roster = JSON.parse(db.prepare("SELECT data FROM private_rosters WHERE app='task'").first().data);
  assert.deepEqual(roster.roster.students[0].teacherIds, ['teacher-a'],
    'legacy roster 담당 집계는 변경하지 않고 수업 task만 이동한다');
  const eventRow = db.prepare("SELECT changed_fields,audience_staff_ids FROM student_change_events WHERE app='task' AND student_id='student-a'").first();
  assert.deepEqual(JSON.parse(eventRow.changed_fields), ['staffId']);
  assert.deepEqual(JSON.parse(eventRow.audience_staff_ids).sort(), ['teacher-a', 'teacher-b'],
    '종료됐거나 종료일이 잘못된 옛 수업 담당자는 변경 알림 대상이 아니다');
  const newTeacherSync = await call(db, '/sync', { auth: person('teacher-b'), since: 0, changes: [] });
  assert.equal(newTeacherSync.status, 200);
  assert.ok(newTeacherSync.body.changes.some(change => change.table === 'tasks' && change.key === 'lesson-a'));
  assert.ok(newTeacherSync.body.changes.some(change => change.table === 'checks' &&
    change.key === 'lesson-a|2026-08-20' && change.data.att === 'L' && change.data.note === '담당 변경 전 메모'));

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
  assert.ok(directorAfter.body.events[0].audienceStatus.find(row =>
    row.staffId === 'teacher-a' && row.acknowledgedAt));
  assert.equal(directorAfter.body.events[0].audienceStatus.find(row =>
    row.staffId === 'teacher-b').acknowledgedAt, null);
});

test('teacher change refuses an exact target assignment even when its stored assignment key is missing', async () => {
  const db = new TestD1(); seed(db);
  const sourceRow = db.prepare("SELECT data FROM tasks WHERE app='task' AND id='lesson-a'").first();
  const source = JSON.parse(sourceRow.data);
  const duplicate = {
    ...source, id: 'lesson-target-duplicate', staffId: 'teacher-b'
  };
  const now = Date.now();
  db.prepare("INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES('task',?,'teacher-b',?,?,?)")
    .bind(duplicate.id, JSON.stringify(duplicate), now, now).run();
  const submit = await call(db, '/lesson-change-request', {
    auth: person('teacher-a'), action: 'submit', taskId: 'lesson-a',
    changes: { operation: 'teacher_assignment', effectiveDate: '2026-08-24' }
  });
  const approve = await call(db, '/lesson-change-review', {
    auth: admin, action: 'approve', requestKey: submit.body.request.requestKey, revision: 1,
    selectedStaffId: 'teacher-b'
  });
  assert.equal(approve.status, 409);
  assert.match(approve.body.error, /같은 학생·과목 수업/);
  assert.equal(db.prepare("SELECT owner FROM tasks WHERE app='task' AND id='lesson-a'").first().owner, 'teacher-a');
  assert.equal(db.prepare("SELECT status FROM lesson_change_requests WHERE app='task' AND request_key=?")
    .bind(submit.body.request.requestKey).first().status, 'approval_waiting');
});

test('teacher change still allows the target teacher to keep another subject for the same student', async () => {
  const db = new TestD1(); seed(db);
  const source = JSON.parse(db.prepare("SELECT data FROM tasks WHERE app='task' AND id='lesson-a'").first().data);
  const otherSubject = {
    ...source, id: 'lesson-target-other-subject', staffId: 'teacher-b',
    subject: '수학', className: '', lessonRole: '수학'
  };
  const now = Date.now();
  db.prepare("INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES('task',?,'teacher-b',?,?,?)")
    .bind(otherSubject.id, JSON.stringify(otherSubject), now, now).run();
  const submit = await call(db, '/lesson-change-request', {
    auth: person('teacher-a'), action: 'submit', taskId: 'lesson-a',
    changes: { operation: 'teacher_assignment', effectiveDate: '2026-08-24' }
  });
  const approve = await call(db, '/lesson-change-review', {
    auth: admin, action: 'approve', requestKey: submit.body.request.requestKey, revision: 1,
    selectedStaffId: 'teacher-b'
  });
  assert.equal(approve.status, 200);
  assert.equal(db.prepare("SELECT owner FROM tasks WHERE app='task' AND id='lesson-a'").first().owner, 'teacher-b');
  assert.equal(db.prepare("SELECT owner FROM tasks WHERE app='task' AND id='lesson-target-other-subject'").first().owner, 'teacher-b');
});

test('teacher change fails closed when a target teacher lesson row has a forged inner owner', async () => {
  const db = new TestD1(); seed(db);
  const source = JSON.parse(db.prepare("SELECT data FROM tasks WHERE app='task' AND id='lesson-a'").first().data);
  const corrupt = { ...source, id: 'lesson-target-corrupt', staffId: 'teacher-a' };
  const now = Date.now();
  db.prepare("INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES('task',?,'teacher-b',?,?,?)")
    .bind(corrupt.id, JSON.stringify(corrupt), now, now).run();
  const submit = await call(db, '/lesson-change-request', {
    auth: person('teacher-a'), action: 'submit', taskId: 'lesson-a',
    changes: { operation: 'teacher_assignment', effectiveDate: '2026-08-24' }
  });
  const approve = await call(db, '/lesson-change-review', {
    auth: admin, action: 'approve', requestKey: submit.body.request.requestKey, revision: 1,
    selectedStaffId: 'teacher-b'
  });
  assert.equal(approve.status, 409);
  assert.match(approve.body.error, /손상/);
  assert.equal(db.prepare("SELECT owner FROM tasks WHERE app='task' AND id='lesson-a'").first().owner, 'teacher-a');
});

test('withdrawal moves the student to roster history and hides every linked lesson while keeping rows', async () => {
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
  assert.match(roster.roster.students[0].reason, /퇴원/);
  for (const id of ['lesson-a', 'lesson-b']) {
    const row = db.prepare('SELECT data FROM tasks WHERE id=?').bind(id).first();
    const task = JSON.parse(row.data);
    assert.equal(task.deleted, true);
    assert.equal(task.end, '2026-08-25');
  }
  for (const id of ['lesson-ended-c', 'lesson-malformed-c']) {
    const task = JSON.parse(db.prepare('SELECT data FROM tasks WHERE id=?').bind(id).first().data);
    assert.equal(task.deleted, false, '적용일 전에 이미 끝났거나 종료일이 잘못된 수업은 다시 전환하지 않는다');
  }
  const withdrawalEvent = db.prepare(
    "SELECT audience_staff_ids FROM student_change_events WHERE event_type='withdrawal'"
  ).first();
  assert.deepEqual(JSON.parse(withdrawalEvent.audience_staff_ids), ['teacher-a']);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE app='task'").first().count, 4,
    '수업 행은 삭제하지 않고 이력으로 보존한다');
});

test('approved lesson deletion is hidden from screens but remains in private storage', async () => {
  const db = new TestD1(); seed(db);
  const deletion = await call(db, '/lesson-change-request', {
    auth: person('teacher-a'), action: 'submit', taskId: 'lesson-a',
    changes: { operation: 'lesson_delete', effectiveDate: '2026-08-26' }, note: '수업 종료'
  });
  assert.equal(deletion.status, 200);
  assert.equal((await call(db, '/lesson-change-review', {
    auth: admin, action: 'approve', requestKey: deletion.body.request.requestKey, revision: 1
  })).status, 200);
  assert.equal(JSON.parse(db.prepare("SELECT data FROM tasks WHERE id='lesson-a'").first().data).deleted, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM student_change_events WHERE event_type='lesson_delete'").first().count, 1);
  const visible = await call(db, '/student-change', { auth: admin, action: 'list' });
  assert.equal(visible.body.events.some(event => event.eventType === 'lesson_delete'), false);
});

test('leave uses the same approval flow and records a separate leave roster state', async () => {
  const db = new TestD1(); seed(db);
  const leave = await call(db, '/lesson-change-request', {
    auth: person('teacher-a'), action: 'submit', taskId: 'lesson-a',
    changes: { operation: 'leave', effectiveDate: '2026-08-27' }, note: '한 달 휴원 요청'
  });
  assert.equal(leave.status, 200);
  assert.equal((await call(db, '/lesson-change-review', {
    auth: admin, action: 'approve', requestKey: leave.body.request.requestKey, revision: 1
  })).status, 200);
  const roster = JSON.parse(db.prepare("SELECT data FROM private_rosters WHERE app='task'").first().data);
  assert.match(roster.roster.students[0].reason, /^휴원 2026-08-27/);
  assert.match(roster.roster.students[0].reason, /한 달 휴원 요청/);
  assert.equal(JSON.parse(db.prepare("SELECT data FROM tasks WHERE id='lesson-a'").first().data).deleted, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM student_change_events WHERE event_type='leave'").first().count, 1);
});
