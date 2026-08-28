import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

import worker from './worker-core.js';
import { allocateNewStudentId } from './roster.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/019_private_roster.sql', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('./roster.js', import.meta.url), 'utf8');

class D1Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  first() { return this.database.prepare(this.sql).get(...this.args) || null; }
  all() { return { results: this.database.prepare(this.sql).all(...this.args) }; }
  run() {
    const result = this.database.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(result.changes || 0) } };
  }
}

class TestD1 {
  constructor() {
    this.database = new DatabaseSync(':memory:');
    this.database.exec(schema);
    this.beforeBatch = null;
  }
  prepare(sql) { return new D1Statement(this.database, sql); }
  batch(statements) {
    if (this.beforeBatch) {
      const beforeBatch = this.beforeBatch;
      this.beforeBatch = null;
      beforeBatch(this.database);
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

const admin = { mode: 'admin', secret: 'director-secret' };
const person = (id, token) => ({ mode: 'person', id, token });
const clone = value => JSON.parse(JSON.stringify(value));
const taskManagers = [
  ['84349fea-f2f0-4fc3-b32a-aaef1e466d54', 'manager-token-a'],
  ['ef0af47e-f9d2-4dfc-bd95-887991ee9479', 'manager-token-b']
];

function documentFixture() {
  return {
    roster: {
      updated: '2026-08-10', baseline: '2026-08', note: '비공개 원생 명단',
      students: [
        {
          id: 'student-a', name: '가학생', grade: '중1', teacher: '가선생', subject: '수학',
          start: '2026-08', end: '', reason: '', teacherIds: ['teacher-a']
        },
        {
          id: 'student-b', name: '나학생', grade: '중2', teacher: '나선생', subject: '국어',
          start: '2026-08', end: '', reason: '', memo: '관찰', teacherIds: ['teacher-b']
        },
        {
          id: 'student-shared', name: '겸임학생', grade: '고1', teacher: '가선생·나선생', subject: '수학·국어',
          start: '2026-08', end: '', reason: '', teacherIds: ['teacher-a', 'teacher-b']
        }
      ]
    },
    bookStudents: [
      {
        id: 'book-row-a', studentId: 'student-a', name: '가학생', teacher: '가선생', bookId: 'BK01',
        at: '1단원', perWeek: 2, goal: '1회독', teacherIds: ['teacher-a']
      },
      {
        id: 'book-row-a-2', studentId: 'student-a', name: '가학생', teacher: '가선생', bookId: 'BK04',
        at: '3단원', perWeek: 1, goal: '복습', teacherIds: ['teacher-a']
      },
      {
        id: 'book-row-b', studentId: 'student-b', name: '나학생', teacher: '나선생', bookId: 'BK02',
        at: '', perWeek: 1, goal: '', teacherIds: ['teacher-b']
      },
      {
        id: 'book-row-shared', studentId: 'student-shared', name: '겸임학생', teacher: '가선생·나선생', bookId: 'BK03',
        at: '2단원', perWeek: 2, goal: '복습', teacherIds: ['teacher-a', 'teacher-b']
      }
    ]
  };
}

function seedAuth(db) {
  const now = Date.now();
  for (const [id, name, deleted, token] of [
    ['teacher-a', '가선생', false, 'token-a'],
    ['teacher-b', '나선생', false, 'token-b'],
    ['teacher-deleted', '퇴사선생', true, 'token-deleted'],
    [taskManagers[0][0], '관리담당A', false, taskManagers[0][1]],
    [taskManagers[1][0], '관리담당B', false, taskManagers[1][1]]
  ]) {
    db.prepare('INSERT INTO staff (app,id,owner,data,updated_at,srv_at) VALUES (?,?,?,?,?,?)')
      .bind('task', id, id, JSON.stringify({ id, name, deleted }), now, now).run();
    db.prepare('INSERT INTO tokens (app,token,staff_id,created_at,revoked) VALUES (?,?,?,?,0)')
      .bind('task', token, id, now).run();
  }
}

function seedLesson(db, id, staffId, studentId, overrides = {}) {
  const now = Date.now();
  const task = {
    id, staffId, studentId, taskKind: 'lesson_instruction', title: '[수업] 테스트',
    lessonFormVersion: 1, intakeVersion: 1,
    start: '2026-01-01', end: '', deleted: false, ...overrides
  };
  db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
      .bind('task', id, overrides.owner || staffId, JSON.stringify(task), now, now).run();
}

function seedTransitionEvent(db, eventId, studentId, eventType, effectiveDate, audienceStaffIds) {
  db.prepare(
    "INSERT INTO student_change_events(app,event_id,student_id,task_id,event_type,changed_fields,details," +
    "audience_staff_ids,effective_date,requires_ack,request_key,request_revision,changed_at,changed_by) " +
    "VALUES('task',?,?,NULL,?,'[]','{}',?,?,1,NULL,NULL,?,'director')"
  ).bind(eventId, studentId, eventType, JSON.stringify(audienceStaffIds), effectiveDate, Date.now()).run();
}

async function call(db, body, app = 'task', envOverrides = {}) {
  const response = await worker.fetch(new Request('https://worker.example/roster', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app, ...body })
  }), { DB: db, TASK_ADMIN_SECRET: 'director-secret', CONSULT_ADMIN_SECRET: 'consult-secret', ...envOverrides });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

async function replace(db, document = documentFixture()) {
  return call(db, { auth: admin, action: 'replace', document });
}

test('schema and migration add one private JSON document table without destructive SQL', () => {
  for (const sql of [schema, migration]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS private_rosters/);
    assert.match(sql, /CHECK \(app = 'task'\)/);
    assert.match(sql, /json_valid\(data\)/);
    assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM/i);
  }
  assert.doesNotMatch(source, /fetch\s*\(|roster\.json|textbooks\.json/);
});

test('new student ids are unique eight-digit numbers without a leading zero', () => {
  const reserved = new Set(['12345678']);
  const candidates = ['12345678', '01234567', '87654321'];
  const studentId = allocateNewStudentId(reserved, () => candidates.shift());
  assert.equal(studentId, '87654321');
  assert.equal(reserved.has(studentId), true);
});

test('unauthenticated and consult requests are rejected', async () => {
  const db = new TestD1(); seedAuth(db);
  assert.equal((await call(db, { action: 'get' })).status, 401);
  assert.equal((await call(db, {
    auth: { mode: 'admin', secret: 'consult-secret' }, action: 'get'
  }, 'consult')).status, 400);
});

test('director replaces and reads the full document without exposing teacherIds', async () => {
  const db = new TestD1(); seedAuth(db);
  const saved = await replace(db);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.rosterCount, 3);
  assert.equal(saved.body.bookStudentCount, 4);
  assert.equal(saved.headers.get('cache-control'), 'no-store');

  const result = await call(db, { auth: admin, action: 'get' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.roster.students.map(item => item.id), ['student-a', 'student-b', 'student-shared']);
  assert.deepEqual(result.body.bookStudents.map(item => item.id), ['book-row-a', 'book-row-a-2', 'book-row-b', 'book-row-shared']);
  assert.equal(result.body.studentSelectionScope, 'all_active');
  assert.deepEqual(result.body.bookOrderStudents.map(item => item.id), ['student-a', 'student-shared', 'student-b']);
  assert.deepEqual(Object.keys(result.body.bookOrderStudents[0]).sort(), ['grade', 'id', 'name', 'school']);
  assert.equal(JSON.stringify(result.body).includes('teacherIds'), false);
  assert.equal(result.body.roster.students.some(item => Object.prototype.hasOwnProperty.call(item, 'teacher')), false);
  assert.equal(result.headers.get('cache-control'), 'no-store');
});

test('director adds an existing student and edits one record with roster CAS', async () => {
  const db = new TestD1(); seedAuth(db); await replace(db);
  const before = await call(db, { auth: admin, action: 'get' });
  const created = await call(db, {
    auth: admin, action: 'student_create', expectedUpdatedAt: before.body.updatedAt,
    student: {
      id: 'student-existing', name: '기존학생', school: '기존초', grade: '초5', teacher: '가선생', subject: '영어',
      start: '2026-08', end: '', reason: '', memo: '', entryType: 'existing', teacherIds: ['teacher-a']
    }
  });
  assert.equal(created.status, 200);
  assert.match(created.body.student.id, /^[1-9]\d{7}$/);
  assert.notEqual(created.body.student.id, 'student-existing');
  assert.equal(created.body.student.entryType, 'existing');
  const createdId = created.body.student.id;
  const stored = JSON.parse(db.prepare("SELECT data FROM private_rosters WHERE app='task'").first().data);
  const storedCreated = stored.roster.students.find(item => item.id === createdId);
  assert.equal(storedCreated.entryType, 'existing');
  assert.equal('teacher' in storedCreated || 'teacherIds' in storedCreated, false);

  const detail = await call(db, { auth: admin, action: 'student_get', studentId: createdId });
  assert.equal(detail.body.student.teacherIds, undefined);
  assert.equal(detail.body.student.teacher, undefined);
  const updated = await call(db, {
    auth: admin, action: 'student_update', expectedUpdatedAt: detail.body.updatedAt,
    student: { ...detail.body.student, grade: '초6', subject: '영어·독해' }
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.student.grade, '초6');
  assert.equal(JSON.parse(db.prepare("SELECT data FROM private_rosters WHERE app='task'").first().data)
    .roster.students.find(item => item.id === createdId).subject, '영어·독해');

  const stale = await call(db, {
    auth: admin, action: 'student_update', expectedUpdatedAt: detail.body.updatedAt,
    student: detail.body.student
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'ROSTER_REVISION_CONFLICT');
});

test('student billing mode is validated, legacy updates preserve it, and monthly clears the cycle date', async () => {
  const db = new TestD1(); seedAuth(db); await replace(db);
  let current = await call(db, { auth: admin, action: 'get' });
  const missingCycleStart = await call(db, {
    auth: admin, action: 'student_create', expectedUpdatedAt: current.body.updatedAt,
    student: {
      id: 'client-id', name: '회차날짜누락', grade: '', subject: '', start: '2026-08', end: '', reason: '',
      billingMode: 'session4', sessionCycleStartDate: ''
    }
  });
  assert.equal(missingCycleStart.status, 400);
  assert.match(missingCycleStart.body.error, /회차제 시작일/);

  const created = await call(db, {
    auth: admin, action: 'student_create', expectedUpdatedAt: current.body.updatedAt,
    student: {
      id: 'client-id', name: '회차학생', grade: '', subject: '', start: '2026-08', end: '', reason: '',
      billingMode: 'session4', sessionCycleStartDate: '2026-08-28'
    }
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.student.billingMode, 'session4');
  assert.equal(created.body.student.sessionCycleStartDate, '2026-08-28');

  const legacyPayload = { ...created.body.student, memo: '구버전 수정 경로' };
  delete legacyPayload.billingMode;
  delete legacyPayload.sessionCycleStartDate;
  const preserved = await call(db, {
    auth: admin, action: 'student_update', expectedUpdatedAt: created.body.updatedAt, student: legacyPayload
  });
  assert.equal(preserved.status, 200);
  assert.equal(preserved.body.student.billingMode, 'session4');
  assert.equal(preserved.body.student.sessionCycleStartDate, '2026-08-28');

  const monthly = await call(db, {
    auth: admin, action: 'student_update', expectedUpdatedAt: preserved.body.updatedAt,
    student: { ...preserved.body.student, billingMode: 'monthly', sessionCycleStartDate: '2026-09-01' }
  });
  assert.equal(monthly.status, 200);
  assert.equal(monthly.body.student.billingMode, 'monthly');
  assert.equal(monthly.body.student.sessionCycleStartDate, '');
});

test('legacy roster defaults materialized by a lesson form do not notify every subject teacher', async () => {
  const db = new TestD1(); seedAuth(db); await replace(db);
  seedLesson(db, 'lesson-shared-math', 'teacher-a', 'student-shared', { subject: '수학' });
  seedLesson(db, 'lesson-shared-korean', 'teacher-b', 'student-shared', { subject: '국어' });
  const before = await call(db, { auth: admin, action: 'student_get', studentId: 'student-shared' });
  assert.equal(before.status, 200);
  const normalized = await call(db, {
    auth: admin, action: 'student_update', expectedUpdatedAt: before.body.updatedAt,
    student: {
      ...before.body.student,
      subject: '국어·수학', subjects: ['국어', '수학'],
      billingMode: 'monthly', sessionCycleStartDate: ''
    }
  });
  assert.equal(normalized.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM student_change_events WHERE app='task'").first().count, 0,
    '누락 기본값을 명시한 것만으로 공통 N 이벤트를 만들면 안 된다');

  const actualChange = await call(db, {
    auth: admin, action: 'student_update', expectedUpdatedAt: normalized.body.updatedAt,
    student: { ...normalized.body.student, memo: '실제 공통 정보 수정' }
  });
  assert.equal(actualChange.status, 200);
  const event = db.prepare(
    "SELECT task_id,event_type,changed_fields,audience_staff_ids FROM student_change_events WHERE app='task'"
  ).first();
  assert.equal(event.task_id, null);
  assert.equal(event.event_type, 'student_information');
  assert.deepEqual(JSON.parse(event.changed_fields), ['memo']);
  assert.deepEqual(JSON.parse(event.audience_staff_ids).sort(), ['teacher-a', 'teacher-b']);
});

test('director stores new-student school, contacts, dates, and fixed multi-subject choices for assigned staff', async () => {
  const db = new TestD1(); seedAuth(db); await replace(db);
  const before = await call(db, { auth: admin, action: 'get' });
  const created = await call(db, {
    auth: admin, action: 'student_create', expectedUpdatedAt: before.body.updatedAt,
    student: {
      id: 'student-new', name: '신규학생', school: '새학교', grade: '초6',
      phoneSelf: '010-1111-2222', phoneFather: '010-2222-3333', phoneMother: '010-3333-4444',
      registrationDate: '2026-08-19', firstClassDate: '2026-08-21',
      teacher: '가선생', subject: '영어·독해력수업·클리닉', subjects: ['영어', '독해력수업', '클리닉'],
      start: '2026-08', end: '', reason: '', memo: '', entryType: 'new', teacherIds: ['teacher-a']
    }
  });
  assert.equal(created.status, 200);
  assert.match(created.body.student.id, /^[1-9]\d{7}$/);
  assert.notEqual(created.body.student.id, 'student-new');
  assert.equal(created.body.student.entryType, 'new');
  assert.deepEqual(created.body.student.subjects, ['영어', '독해력수업', '클리닉']);
  assert.equal(created.body.student.subject, '영어·독해력수업·클리닉');
  assert.equal(created.body.student.school, '새학교');
  assert.equal(created.body.student.firstClassDate, '2026-08-21');

  seedLesson(db, 'lesson-new-student', 'teacher-a', created.body.student.id);
  const stored = JSON.parse(db.prepare("SELECT data FROM private_rosters WHERE app='task'").first().data)
    .roster.students.find(item => item.id === created.body.student.id);
  assert.equal('teacher' in stored || 'teacherIds' in stored, false);
  const teacher = await call(db, { auth: person('teacher-a', 'token-a'), action: 'get' });
  const visible = teacher.body.roster.students.find(item => item.id === created.body.student.id);
  assert.equal(visible.phoneMother, '010-3333-4444');
  assert.equal('teacherIds' in visible, false);

  const invalid = await call(db, {
    auth: admin, action: 'student_update', expectedUpdatedAt: created.body.updatedAt,
    student: { ...created.body.student, subjects: ['영어', '코딩'], subject: '영어·코딩', teacherIds: ['teacher-a'] }
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /등록할 수 없는 과목/);
});

test('director creates a stable eight-digit student from name only and can delete that untouched record', async () => {
  const db = new TestD1(); seedAuth(db); await replace(db);
  const before = await call(db, { auth: admin, action: 'get' });
  const missingName = await call(db, {
    auth: admin, action: 'student_create', expectedUpdatedAt: before.body.updatedAt,
    student: {
      id: 'ignored-by-server', name: '', school: '', grade: '',
      teacher: '', subject: '', start: '2026-08', end: '', reason: '', entryType: 'new', teacherIds: []
    }
  });
  assert.equal(missingName.status, 400);
  assert.equal(missingName.body.code, 'STUDENT_REQUIRED_FIELDS');
  const created = await call(db, {
    auth: admin, action: 'student_create', expectedUpdatedAt: before.body.updatedAt,
    student: {
      id: 'ignored-by-server', name: '최소원생', school: '', grade: '',
      teacher: '', subject: '', start: '2026-08', end: '', reason: '', entryType: 'new', teacherIds: []
    }
  });
  assert.equal(created.status, 200);
  assert.match(created.body.student.id, /^[1-9]\d{7}$/);
  assert.equal(created.body.student.school, '');
  assert.equal(created.body.student.grade, '');

  const duplicate = await call(db, {
    auth: admin, action: 'student_create', expectedUpdatedAt: created.body.updatedAt,
    student: {
      id: 'ignored-by-server', name: '최소원생', school: '', grade: '',
      teacher: '', subject: '', start: '2026-08', end: '', reason: '', entryType: 'new', teacherIds: []
    }
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, 'STUDENT_ALREADY_EXISTS');

  const forbidden = await call(db, {
    auth: person('teacher-a', 'token-a'), action: 'student_delete', expectedUpdatedAt: created.body.updatedAt,
    studentId: created.body.student.id
  });
  assert.equal(forbidden.status, 403);

  const deleted = await call(db, {
    auth: admin, action: 'student_delete', expectedUpdatedAt: created.body.updatedAt,
    studentId: created.body.student.id
  });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.deletedStudentId, created.body.student.id);
  const after = await call(db, { auth: admin, action: 'get' });
  assert.equal(after.body.roster.students.some(student => student.id === created.body.student.id), false);
});

test('minimal student deletion fails closed for extra profile data or any stable-id operation link', async () => {
  const db = new TestD1(); seedAuth(db); await replace(db);
  const create = async (expectedUpdatedAt, name, extra = {}) => await call(db, {
    auth: admin, action: 'student_create', expectedUpdatedAt,
    student: {
      id: 'ignored-by-server', name, school: '치평초', grade: '초3', teacher: '', subject: '',
      start: '2026-08', end: '', reason: '', entryType: 'new', teacherIds: [], ...extra
    }
  });
  let current = await call(db, { auth: admin, action: 'get' });
  const withMemo = await create(current.body.updatedAt, '메모원생', { memo: '추가 정보' });
  const profileBlocked = await call(db, {
    auth: admin, action: 'student_delete', expectedUpdatedAt: withMemo.body.updatedAt, studentId: withMemo.body.student.id
  });
  assert.equal(profileBlocked.status, 409);
  assert.equal(profileBlocked.body.code, 'STUDENT_DELETE_NOT_MINIMAL');

  const linked = await create(withMemo.body.updatedAt, '연결원생');
  db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', 'linked-minimal-task', 'teacher-a', JSON.stringify({ studentId: linked.body.student.id }), 1, 1).run();
  const taskBlocked = await call(db, {
    auth: admin, action: 'student_delete', expectedUpdatedAt: linked.body.updatedAt, studentId: linked.body.student.id
  });
  assert.equal(taskBlocked.status, 409);
  assert.equal(taskBlocked.body.code, 'STUDENT_DELETE_LINKED');

  const contacted = await create(linked.body.updatedAt, '연락원생');
  db.prepare('INSERT INTO guardian_contacts_by_student(app,student_id,student_name,phone,consent,updated_at,updated_by) VALUES(?,?,?,?,?,?,?)')
    .bind('task', contacted.body.student.id, contacted.body.student.name, '', 0, 1, 'director').run();
  const contactBlocked = await call(db, {
    auth: admin, action: 'student_delete', expectedUpdatedAt: contacted.body.updatedAt, studentId: contacted.body.student.id
  });
  assert.equal(contactBlocked.status, 409);
  assert.equal(contactBlocked.body.code, 'STUDENT_DELETE_LINKED');
});

test('student maintenance is admin-only and refuses a duplicate name, school, and grade', async () => {
  const db = new TestD1(); seedAuth(db);
  const document = documentFixture();
  document.roster.students[0].school = '기존중';
  await replace(db, document);
  const current = await call(db, { auth: admin, action: 'get' });
  const student = {
    id: 'duplicate-id', name: '가학생', school: '기존중', grade: '중1', teacher: '가선생', subject: '수학',
    start: '2026-08', end: '', reason: '', entryType: 'existing', teacherIds: ['teacher-a']
  };
  assert.equal((await call(db, { auth: person('teacher-a', 'token-a'), action: 'student_create',
    expectedUpdatedAt: current.body.updatedAt, student })).status, 403);
  const duplicate = await call(db, { auth: admin, action: 'student_create',
    expectedUpdatedAt: current.body.updatedAt, student });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, 'STUDENT_ALREADY_EXISTS');
});

test('admin directly moves a student to leave and returns them with a newly assigned lesson', async () => {
  const db = new TestD1(); seedAuth(db); await replace(db);
  const initial = await call(db, { auth: admin, action: 'get' });
  const oldTask = {
    id: 'old-lesson-a', staffId: 'teacher-a', studentId: 'student-a', studentName: '가학생', grade: '중1',
    title: '[수업] 가학생 (중1) — 수학', taskKind: 'lesson_instruction', deleted: false, start: '2026-08-01',
    updatedAt: 100, createdAt: 100, steps: []
  };
  db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', oldTask.id, 'teacher-a', JSON.stringify(oldTask), 100, 100).run();

  const forbidden = await call(db, {
    auth: person('teacher-a', 'token-a'), action: 'student_transition', expectedUpdatedAt: initial.body.updatedAt,
    studentId: 'student-a', operation: 'leave', effectiveDate: '2026-08-20'
  });
  assert.equal(forbidden.status, 403);

  const leave = await call(db, {
    auth: admin, action: 'student_transition', expectedUpdatedAt: initial.body.updatedAt,
    studentId: 'student-a', operation: 'leave', effectiveDate: '2026-08-20', note: '가정 일정'
  });
  assert.equal(leave.status, 200);
  assert.equal(leave.body.student.end, '2026-09');
  assert.match(leave.body.student.reason, /^휴원 2026-08-20/);
  assert.equal(JSON.parse(db.prepare("SELECT data FROM tasks WHERE app='task' AND id='old-lesson-a'").first().data).deleted, true);
  const leaveEvent = db.prepare("SELECT event_type,details FROM student_change_events WHERE app='task' AND student_id='student-a' ORDER BY changed_at DESC LIMIT 1").first();
  assert.equal(leaveEvent.event_type, 'leave');
  assert.equal(JSON.parse(leaveEvent.details).direct, true);
  const priorTeacherView = await call(db, { auth: person('teacher-a', 'token-a'), action: 'get' });
  assert.deepEqual(priorTeacherView.body.roster.students.map(student => student.id), ['student-a'],
    '전환 이벤트의 당시 담당자는 휴원 이력을 계속 확인할 수 있다');

  const combined = await call(db, {
    auth: admin, action: 'student_transition', expectedUpdatedAt: leave.body.updatedAt,
    studentId: 'student-a', operation: 'return', effectiveDate: '2026-08-25', staffId: 'teacher-b',
    subjects: ['수학', '영어'], scheduleSlots: [
      { days: [1], startTime: '16:00', endTime: '17:00', lessonHours: '1.5T' }
    ]
  });
  assert.equal(combined.status, 400);
  assert.match(combined.body.error, /정확히 한 개/);
  assert.equal((await call(db, { auth: admin, action: 'get' })).body.updatedAt, leave.body.updatedAt);

  const returned = await call(db, {
    auth: admin, action: 'student_transition', expectedUpdatedAt: leave.body.updatedAt,
    studentId: 'student-a', operation: 'return', effectiveDate: '2026-08-25', staffId: 'teacher-b',
    subjects: ['수학'], scheduleSlots: [
      { days: [1, 3], startTime: '16:00', endTime: '17:00', lessonHours: '1.5T' },
      { days: [5], startTime: '18:00', endTime: '18:50', lessonHours: '1T' }
    ]
  });
  assert.equal(returned.status, 200);
  assert.equal(returned.body.student.end, '');
  assert.equal(returned.body.student.reason, '');
  assert.equal(returned.body.student.teacher, undefined, '복귀 담당은 생성 수업 staffId에만 저장한다');
  assert.equal(returned.body.task.staffId, 'teacher-b');
  assert.equal(returned.body.task.lessonHours, '');
  assert.deepEqual(returned.body.task.scheduleSlots.map(slot => slot.lessonHours), ['1.5T', '1T']);
  assert.equal(returned.body.task.deleted, false);
  assert.deepEqual(returned.body.task.days, [1, 3, 5]);
  const activeTask = db.prepare("SELECT owner,data FROM tasks WHERE app='task' AND id=?").bind(returned.body.task.id).first();
  assert.equal(activeTask.owner, 'teacher-b');
  assert.equal(JSON.parse(activeTask.data).studentId, 'student-a');
  const returnEvent = db.prepare("SELECT event_type,details FROM student_change_events WHERE app='task' AND student_id='student-a' ORDER BY changed_at DESC LIMIT 1").first();
  assert.equal(returnEvent.event_type, 'student_information');
  assert.equal(JSON.parse(returnEvent.details).operation, 'return');
  assert.equal(JSON.parse(returnEvent.details).lessonHours, '');
  assert.equal(JSON.parse(returnEvent.details).scheduleText, '월·수 16:00-17:00 · 1.5T / 금 18:00-18:50 · 1T');
  const teacherView = await call(db, { auth: person('teacher-b', 'token-b'), action: 'get' });
  assert.deepEqual(teacherView.body.roster.students.map(student => student.id), ['student-a']);
});

test('direct leave only retires lessons that still reach the effective date and records that exact audience', async () => {
  const db = new TestD1(); seedAuth(db); await replace(db);
  seedLesson(db, 'lesson-direct-current', 'teacher-a', 'student-a', { start: '2026-08-01', end: '' });
  seedLesson(db, 'lesson-direct-ended', 'teacher-b', 'student-a', { start: '2026-01-01', end: '2026-08-19' });
  seedLesson(db, 'lesson-direct-bad-end', 'teacher-b', 'student-a', { start: '2026-01-01', end: '종료일오류' });
  const initial = await call(db, { auth: admin, action: 'get' });
  const leave = await call(db, {
    auth: admin, action: 'student_transition', expectedUpdatedAt: initial.body.updatedAt,
    studentId: 'student-a', operation: 'leave', effectiveDate: '2026-08-20'
  });
  assert.equal(leave.status, 200);
  assert.equal(JSON.parse(db.prepare("SELECT data FROM tasks WHERE id='lesson-direct-current'").first().data).deleted, true);
  for (const id of ['lesson-direct-ended', 'lesson-direct-bad-end']) {
    assert.equal(JSON.parse(db.prepare('SELECT data FROM tasks WHERE id=?').bind(id).first().data).deleted, false);
  }
  const event = db.prepare(
    "SELECT audience_staff_ids FROM student_change_events WHERE event_type='leave' AND student_id='student-a'"
  ).first();
  assert.deepEqual(JSON.parse(event.audience_staff_ids), ['teacher-a']);
  const oldUnrelatedTeacher = await call(db, { auth: person('teacher-b', 'token-b'), action: 'get' });
  assert.equal(oldUnrelatedTeacher.body.roster.students.some(student => student.id === 'student-a'), false);
});

test('a lesson CAS race aborts the whole direct transition without changing roster or history', async () => {
  const db = new TestD1(); seedAuth(db); await replace(db);
  seedLesson(db, 'lesson-direct-race', 'teacher-a', 'student-a', { start: '2026-08-01', end: '' });
  const initial = await call(db, { auth: admin, action: 'get' });
  db.beforeBatch = database => database.prepare(
    "UPDATE tasks SET updated_at=updated_at+1,srv_at=srv_at+1 WHERE app='task' AND id='lesson-direct-race'"
  ).run();
  const leave = await call(db, {
    auth: admin, action: 'student_transition', expectedUpdatedAt: initial.body.updatedAt,
    studentId: 'student-a', operation: 'leave', effectiveDate: '2026-08-20'
  });
  assert.equal(leave.status, 409);
  assert.equal(leave.body.code, 'ROSTER_REVISION_CONFLICT');
  const student = JSON.parse(db.prepare("SELECT data FROM private_rosters WHERE app='task'").first().data)
    .roster.students.find(item => item.id === 'student-a');
  assert.equal(student.reason, '');
  assert.equal(JSON.parse(db.prepare("SELECT data FROM tasks WHERE id='lesson-direct-race'").first().data).deleted, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM student_change_events WHERE student_id='student-a'").first().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_write_cas_guards").first().count, 0);
});

test('unassigned students may omit school, grade, subjects, and teachers before lesson placement', async () => {
  const db = new TestD1(); seedAuth(db);
  const document = documentFixture();
  document.roster.students = [{
    id: '10000001', name: '미배정학생', school: '', grade: '', teacher: '', subject: '', subjects: [],
    phoneSelf: '', phoneFather: '', phoneMother: '010-1111-2222', start: '2026-08', end: '', reason: '',
    entryType: 'existing', teacherIds: []
  }];
  document.bookStudents = [];
  const saved = await replace(db, document);
  assert.equal(saved.status, 200);
  const director = await call(db, { auth: admin, action: 'get' });
  assert.equal(director.body.roster.students[0].grade, '');
  const teacher = await call(db, { auth: person('teacher-a', 'token-a'), action: 'get' });
  assert.equal(teacher.body.roster.students.length, 0);
});

test('same-name students are separated by school and grade, then by parent contacts', async () => {
  const db = new TestD1(); seedAuth(db); await replace(db);
  let current = await call(db, { auth: admin, action: 'get' });
  const create = async student => call(db, {
    auth: admin, action: 'student_create', expectedUpdatedAt: current.body.updatedAt,
    student: { id: 'client-id', teacher: '', subject: '', start: '2026-08', end: '', reason: '', teacherIds: [], ...student }
  });
  const first = await create({ name: '김예린', school: '초', grade: '6', phoneMother: '010-1111-1111' });
  assert.equal(first.status, 200);
  current = first;
  const second = await create({ name: '김예린', school: '치평초', grade: '3', phoneMother: '010-2222-2222' });
  assert.equal(second.status, 200);
  current = second;
  const third = await create({ name: '김예린', school: '치평초', grade: '3', phoneMother: '010-3333-3333' });
  assert.equal(third.status, 200);
  current = third;
  const duplicate = await create({ name: '김예린', school: '치평초', grade: '3', phoneMother: '010-3333-3333' });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, 'STUDENT_ALREADY_EXISTS');
  const ambiguousWithoutPhone = await create({ name: '김예린', school: '치평초', grade: '3' });
  assert.equal(ambiguousWithoutPhone.status, 409);
  assert.equal(ambiguousWithoutPhone.body.code, 'STUDENT_ALREADY_EXISTS');
});

test('person roster and book candidates follow current lesson stable ids instead of roster teacherIds', async () => {
  const db = new TestD1(); seedAuth(db); await replace(db);
  seedLesson(db, 'lesson-a-b', 'teacher-a', 'student-b');
  seedLesson(db, 'lesson-b-shared', 'teacher-b', 'student-shared');
  const teacherA = await call(db, { auth: person('teacher-a', 'token-a'), action: 'get' });
  assert.equal(teacherA.status, 200);
  assert.deepEqual(teacherA.body.roster.students.map(item => item.id), ['student-b']);
  assert.deepEqual(teacherA.body.bookStudents.map(item => item.id), [],
    '같은 학생의 다른 과목 수업만으로 legacy 교재 배정을 볼 수 없다');
  assert.deepEqual(teacherA.body.bookOrderStudents.map(item => item.id), ['student-b']);
  assert.equal(teacherA.body.studentSelectionScope, 'lesson_students');
  assert.equal(JSON.stringify(teacherA.body).includes('teacherIds'), false);

  const teacherB = await call(db, { auth: person('teacher-b', 'token-b'), action: 'get' });
  assert.deepEqual(teacherB.body.roster.students.map(item => item.id), ['student-shared']);
  assert.deepEqual(teacherB.body.bookStudents.map(item => item.id), ['book-row-shared']);
  assert.deepEqual(teacherB.body.bookOrderStudents.map(item => item.id), ['student-shared']);
});

test('lesson-derived candidates preserve duplicate ids, retain assigned transition history, and fail closed for invalid lessons', async () => {
  const db = new TestD1(); seedAuth(db);
  const document = documentFixture();
  document.roster.students.push(
    { id: 'same-a', name: '동명이인', school: '같은학교', grade: '중1', phoneMother: '010-1111-2222',
      teacher: '나선생', subject: '수학', start: '2020-01', end: '', reason: '', teacherIds: ['teacher-b'] },
    { id: 'same-b', name: '동명이인', school: '같은학교', grade: '중1', phoneMother: '010-3333-4444',
      teacher: '나선생', subject: '영어', start: '2020-01', end: '', reason: '', teacherIds: ['teacher-b'] },
    { id: 'leave-a', name: '휴원학생', grade: '중1', teacher: '가선생', subject: '수학',
      start: '2020-01', end: '2099-01', reason: '휴원 2026-08-27', teacherIds: ['teacher-a'] },
    { id: 'withdraw-a', name: '퇴원학생', grade: '중1', teacher: '가선생', subject: '수학',
      start: '2020-01', end: '2099-01', reason: '퇴원 2026-08-27', teacherIds: ['teacher-a'] },
    { id: 'eventless-leave', name: '옛담당비공개', grade: '중1', teacher: '가선생', subject: '수학',
      start: '2020-01', end: '2099-01', reason: '휴원 2026-08-27', teacherIds: ['teacher-a'] },
    { id: 'ended-a', name: '종료학생', grade: '중1', teacher: '가선생', subject: '수학',
      start: '2020-01', end: '2020-02', reason: '', teacherIds: ['teacher-a'] }
  );
  await replace(db, document);
  seedLesson(db, 'lesson-same-a', 'teacher-a', 'same-a');
  seedLesson(db, 'lesson-same-b', 'teacher-a', 'same-b');
  seedLesson(db, 'lesson-leave', 'teacher-a', 'leave-a', { deleted: true, end: '2026-08-27' });
  seedLesson(db, 'lesson-withdraw', 'teacher-a', 'withdraw-a', { deleted: true, end: '2026-08-27' });
  seedLesson(db, 'lesson-eventless-leave', 'teacher-a', 'eventless-leave', { deleted: true, end: '2026-08-27' });
  seedTransitionEvent(db, 'sce_leave_a', 'leave-a', 'leave', '2026-08-27', ['teacher-a']);
  seedTransitionEvent(db, 'sce_withdraw_a', 'withdraw-a', 'withdrawal', '2026-08-27', ['teacher-a']);
  seedLesson(db, 'lesson-ended', 'teacher-a', 'ended-a');
  seedLesson(db, 'lesson-deleted', 'teacher-a', 'student-a', { deleted: true });
  seedLesson(db, 'lesson-future', 'teacher-a', 'student-a', { start: '2099-01-01' });
  seedLesson(db, 'lesson-owner-mismatch', 'teacher-a', 'student-shared', { owner: 'teacher-b' });
  seedLesson(db, 'lesson-title-only-forgery', 'teacher-a', 'student-shared', {
    taskKind: '', lessonFormVersion: 0, intakeVersion: 0, title: '[수업] 제목만 위조'
  });
  seedLesson(db, 'lesson-no-stable-id', 'teacher-a', '', { studentId: '' });

  const result = await call(db, { auth: person('teacher-a', 'token-a'), action: 'get' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.roster.students.map(item => item.id),
    ['student-a', 'same-a', 'same-b', 'leave-a', 'withdraw-a']);
  assert.equal(result.body.roster.students.some(item => item.id === 'eventless-leave'), false,
    '전환 이벤트가 없는 과거 수업만으로는 보호자 연락처가 포함된 원생 이력을 다시 노출하지 않는다');
  assert.deepEqual(result.body.bookOrderStudents.map(item => item.id), ['student-a', 'same-a', 'same-b']);
  assert.equal(result.body.bookOrderStudents.some(item => ['leave-a', 'withdraw-a'].includes(item.id)), false);
  assert.equal(result.body.bookOrderStudents.some(item => item.id === 'student-shared'), false,
    '제목만 [수업]인 일반 task는 학생 범위 권한을 만들지 못한다');
  assert.deepEqual(result.body.bookOrderStudents.filter(item => item.name === '동명이인').map(item => item.id), ['same-a', 'same-b']);
  assert.equal(result.body.bookOrderStudents.some(item => 'phoneMother' in item || 'teacher' in item), false);
});

test('both configured task managers receive the full roster for stable-id student selection', async () => {
  const db = new TestD1(); seedAuth(db); await replace(db);
  const managerConfig = { TASK_MANAGER_STAFF_IDS_CONFIG: taskManagers.map(([id]) => id).join(',') };
  for (const [managerId, token] of taskManagers) {
    const result = await call(db, { auth: person(managerId, token), action: 'get' }, 'task', managerConfig);
    assert.equal(result.status, 200);
    assert.equal(result.body.studentSelectionScope, 'all_active');
    assert.deepEqual(result.body.roster.students.map(item => item.id), ['student-a', 'student-b', 'student-shared']);
    assert.deepEqual(result.body.bookStudents.map(item => item.id), ['book-row-a', 'book-row-a-2', 'book-row-b', 'book-row-shared']);
    assert.equal(JSON.stringify(result.body).includes('teacherIds'), false);
  }
});

test('person cannot replace, forge another id, or use a deleted staff session', async () => {
  const db = new TestD1(); seedAuth(db); await replace(db);
  assert.equal((await call(db, {
    auth: person('teacher-a', 'token-a'), action: 'replace', document: documentFixture()
  })).status, 403);
  assert.equal((await call(db, { auth: person('teacher-a', 'token-b'), action: 'get' })).status, 401);
  assert.equal((await call(db, {
    auth: person('teacher-deleted', 'token-deleted'), action: 'get'
  })).status, 401);
});

test('replace accepts optional legacy roster teachers and rejects duplicate ids, bad references, and unknown fields', async () => {
  const db = new TestD1(); seedAuth(db);

  const missingTeacherIds = documentFixture();
  delete missingTeacherIds.roster.students[0].teacherIds;
  delete missingTeacherIds.roster.students[0].teacher;
  assert.equal((await replace(db, missingTeacherIds)).status, 200);

  const duplicateRosterId = documentFixture();
  duplicateRosterId.roster.students[1].id = 'student-a';
  assert.match((await replace(db, duplicateRosterId)).body.error, /중복 id/);

  const duplicateBookId = documentFixture();
  duplicateBookId.bookStudents[2].id = 'book-row-a';
  assert.match((await replace(db, duplicateBookId)).body.error, /중복 id/);

  const badReference = documentFixture();
  badReference.bookStudents[0].studentId = 'missing-student';
  assert.equal((await replace(db, badReference)).status, 400);

  const unknown = documentFixture();
  unknown.roster.students[0].phone = '01012345678';
  assert.match((await replace(db, unknown)).body.error, /허용되지 않은 항목/);

  const invalidDate = documentFixture();
  invalidDate.roster.updated = '2026-02-31';
  assert.equal((await replace(db, invalidDate)).status, 400);

  const unknownTeacher = documentFixture();
  unknownTeacher.roster.students[0].teacherIds.push('teacher-unknown');
  assert.equal((await replace(db, unknownTeacher)).status, 200, 'legacy roster teacherIds는 권한 정본이 아니다');

  const deletedTeacher = documentFixture();
  deletedTeacher.roster.students[0].teacherIds.push('teacher-deleted');
  assert.equal((await replace(db, deletedTeacher)).status, 200, '비활성 legacy roster 담당도 새 수업 권한을 부여하지 않는다');
});

test('replace keeps unresolved boarded students active until transport is completed or reset', async () => {
  const db = new TestD1(); seedAuth(db); await replace(db);
  db.prepare('INSERT INTO transport_configs(app,data,updated_at,updated_by) VALUES(?,?,?,?)')
    .bind('task', JSON.stringify({
      vehicles: [{ id: 'van-a', name: '1호차', plate: '12가3456', capacity: 10 }],
      routes: [{
        id: 'route-a', name: 'A노선', direction: 'dropoff', vehicleId: 'van-a', driverId: 'teacher-a',
        days: [1], startTime: '19:00', active: true,
        stops: [{ id: 'stop-a', name: '정류장', time: '19:10', studentIds: ['student-a'] }]
      }]
    }), Date.now(), 'director').run();
  db.prepare(
    "INSERT INTO transport_states(app,date,route_id,student_id,status,revision,history,updated_at) " +
    "VALUES(?,?,?,?, 'boarded',1,'[]',?)"
  ).bind('task', '2026-08-10', 'route-a', 'student-a', Date.now()).run();

  const removed = clone(documentFixture());
  removed.roster.students = removed.roster.students.filter(item => item.id !== 'student-a');
  removed.bookStudents = removed.bookStudents.filter(item => item.studentId !== 'student-a');
  let result = await replace(db, removed);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'BOARDING_LOCK');

  const ended = clone(documentFixture());
  ended.roster.students.find(item => item.id === 'student-a').end = '2026-08';
  result = await replace(db, ended);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'BOARDING_LOCK');
  assert.equal(db.prepare(
    "SELECT json_array_length(data,'$.roster.students') AS count FROM private_rosters WHERE app='task'"
  ).first().count, 3);

  db.prepare(
    "UPDATE transport_states SET status='dropped',revision=revision+1,updated_at=? " +
    "WHERE app='task' AND route_id='route-a' AND student_id='student-a'"
  ).bind(Date.now()).run();
  result = await replace(db, removed);
  assert.equal(result.status, 200);
});

test('replace is an upsert and malformed stored data fails closed', async () => {
  const db = new TestD1(); seedAuth(db); await replace(db);
  const changed = clone(documentFixture());
  changed.roster.note = '교체됨';
  await replace(db, changed);
  assert.equal(db.prepare("SELECT count(*) AS count FROM private_rosters WHERE app='task'").first().count, 1);

  db.prepare("UPDATE private_rosters SET data=? WHERE app='task'")
    .bind(JSON.stringify({ roster: {}, bookStudents: [] })).run();
  const result = await call(db, { auth: admin, action: 'get' });
  assert.equal(result.status, 500);
  assert.equal(result.body.error, '저장된 원생 데이터 형식이 올바르지 않습니다');
});
