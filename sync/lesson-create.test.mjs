import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { buildLessonTask, handleLessonCreate, handleLessonCreateBatch } from './lesson-create.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' }
});

function validLesson(overrides = {}) {
  return Object.assign({
    studentName: '테스트학생',
    grade: '초4',
    subject: '국어',
    className: '비문학',
    lessonRole: '독해력',
    lessonHours: '2T',
    scheduleText: '월·수 17:00–19:00 / 일 12:00–14:00',
    scheduleSlots: [
      { days: [1, 3], startTime: '17:00', endTime: '19:00' },
      { days: [0], startTime: '12:00', endTime: '14:00' }
    ],
    scheduleStatus: 'normal',
    start: '2026-08-04',
    materials: '초등 문해력 독해가 힘이다 5A',
    onlineProgram: '없음',
    homework: '없음',
    studentTraits: '질문을 잘함',
    goal: '교재 마무리',
    parentRequest: '없음',
    adminRequest: '수업 후 진도표 확인'
  }, overrides);
}

function assignedLesson(overrides = {}) {
  return validLesson(Object.assign({ studentId: 'student-a' }, overrides));
}

class FakeDB {
  constructor() {
    this.staff = new Map([
      ['teacher-1', { id: 'teacher-1', name: '가선생', deleted: false }],
      ['teacher-2', { id: 'teacher-2', name: '나선생', deleted: false }],
      ['inactive', { id: 'inactive', deleted: true }]
    ]);
    this.tasks = new Map();
    this.failBatchAt = -1;
    this.privateRoster = {
      roster: { students: [
        { id: 'student-a', name: '테스트학생', grade: '초4', teacherIds: ['teacher-1'] },
        { id: 'student-b', name: '테스트학생', grade: '초4', teacherIds: ['teacher-2'] }
      ] },
      bookStudents: []
    };
    this.privateRosterUpdatedAt = 100;
  }

  prepare(sql) {
    const db = this;
    return {
      args: [],
      bind(...args) { this.args = args; return this; },
      async first() {
        if (sql.startsWith('SELECT data,updated_at FROM private_rosters')) {
          return db.privateRoster ? { data: JSON.stringify(db.privateRoster), updated_at: db.privateRosterUpdatedAt } : null;
        }
        if (sql.startsWith('SELECT data FROM private_rosters')) {
          return db.privateRoster ? { data: JSON.stringify(db.privateRoster) } : null;
        }
        if (sql.startsWith('SELECT data FROM staff')) {
          const row = db.staff.get(this.args[1]);
          return row ? { data: JSON.stringify(row) } : null;
        }
        if (sql.startsWith('SELECT data,updated_at FROM tasks')) {
          const row = db.tasks.get(this.args[1]);
          const requestedOwner = sql.includes('owner=?') ? this.args[2] : null;
          if (!row || (requestedOwner !== null && row.owner !== requestedOwner)) return null;
          return { data: row.data, updated_at: row.updatedAt };
        }
        throw new Error('unexpected first SQL: ' + sql);
      },
      async all() {
        if (!sql.startsWith('SELECT data,updated_at FROM tasks')) throw new Error('unexpected all SQL: ' + sql);
        const owner = this.args[1];
        return {
          results: [...db.tasks.values()]
            .filter(row => row.owner === owner)
            .map(row => ({ data: row.data, updated_at: row.updatedAt }))
        };
      },
      async run() {
        if (sql.startsWith('UPDATE private_rosters SET data=')) {
          const [data, updatedAt, , expectedUpdatedAt] = this.args;
          if (db.privateRosterUpdatedAt !== expectedUpdatedAt) return { meta: { changes: 0 } };
          db.privateRoster = JSON.parse(data);
          db.privateRosterUpdatedAt = updatedAt;
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith('INSERT INTO tasks')) {
          const [, id, owner, data, updatedAt, srvAt] = this.args;
          if (db.tasks.has(id)) throw new Error('task conflict');
          db.tasks.set(id, { owner, data, updatedAt, srvAt });
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith('INSERT OR IGNORE INTO tasks')) {
          const [, id, owner, data, updatedAt, srvAt] = this.args;
          if (db.tasks.has(id)) return { meta: { changes: 0 } };
          db.tasks.set(id, { owner, data, updatedAt, srvAt });
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith('UPDATE tasks SET data=')) {
          const [data, updatedAt, srvAt, , id, owner, expectedUpdatedAt] = this.args;
          const current = db.tasks.get(id);
          if (!current || current.owner !== owner || current.updatedAt !== expectedUpdatedAt) {
            return { meta: { changes: 0 } };
          }
          db.tasks.set(id, { owner, data, updatedAt, srvAt });
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith('INSERT OR IGNORE INTO student_change_events')) {
          return { meta: { changes: 1 } };
        }
        throw new Error('unexpected run SQL: ' + sql);
      }
    };
  }

  async batch(statements) {
    const snapshot = new Map(this.tasks);
    const rosterSnapshot = JSON.parse(JSON.stringify(this.privateRoster));
    const rosterUpdatedAtSnapshot = this.privateRosterUpdatedAt;
    const results = [];
    try {
      for (let index = 0; index < statements.length; index += 1) {
        if (this.failBatchAt === index) throw new Error('simulated batch failure');
        results.push(await statements[index].run());
      }
      return results;
    } catch (error) {
      this.tasks = snapshot;
      this.privateRoster = rosterSnapshot;
      this.privateRosterUpdatedAt = rosterUpdatedAtSnapshot;
      throw error;
    }
  }
}

async function call(db, body, auth) {
  const response = await handleLessonCreate({ DB: db }, 'task', body, '*', auth, json);
  return { response, data: await response.json() };
}

async function callBatch(db, lessons, auth = { scope: 'all', role: 'admin' }) {
  const response = await handleLessonCreateBatch({ DB: db }, 'task', { lessons }, '*', auth, json);
  return { response, data: await response.json() };
}

async function callStudentBatch(db, lessons, auth = { scope: 'all', role: 'admin' }) {
  const response = await handleLessonCreateBatch({ DB: db }, 'task', { batchKind: 'students', lessons }, '*', auth, json);
  return { response, data: await response.json() };
}

function seed(db, task) {
  db.tasks.set(task.id, {
    owner: task.staffId,
    data: JSON.stringify(task),
    updatedAt: task.updatedAt,
    srvAt: task.updatedAt
  });
}

test('server builds an owned lesson with stable assignment and audit fields', async () => {
  const task = await buildLessonTask(validLesson(), 'teacher-1', 'staff', 1234);
  assert.match(task.id, /^lesson-[a-f0-9]{32}$/);
  assert.equal(task.staffId, 'teacher-1');
  assert.equal(task.origin, 'staff');
  assert.deepEqual(task.days, [0, 1, 3]);
  assert.equal(task.repeat, 'days');
  assert.equal(task.lessonFormVersion, 1);
  assert.equal(task.lessonRevision, 1);
  assert.equal(task.lessonHours, '2T');
  assert.match(task.lessonAssignmentKey, /^sha256:/);
  assert.match(task.lessonContentHash, /^sha256:/);
  assert.equal(task.scheduleStatus, 'confirmed');
  assert.equal(task.createdAt, 1234);
});

test('assignment identity includes grade and ignores schedule, start, and lesson details', async () => {
  const first = await buildLessonTask(validLesson(), 'teacher-1', 'staff', 1);
  const corrected = await buildLessonTask(validLesson({
    start: '2026-09-01',
    scheduleText: '금 18:00-19:00',
    scheduleSlots: [{ days: [5], startTime: '18:00', endTime: '19:00' }],
    materials: '새 교재'
  }), 'teacher-1', 'staff', 2);
  assert.equal(first.id, corrected.id);
  assert.equal(first.lessonAssignmentKey, corrected.lessonAssignmentKey);
  assert.notEqual(first.lessonContentHash, corrected.lessonContentHash);

  const nextGrade = await buildLessonTask(validLesson({ grade: '초5' }), 'teacher-1', 'staff', 3);
  assert.notEqual(first.id, nextGrade.id);
  assert.notEqual(first.lessonAssignmentKey, nextGrade.lessonAssignmentKey);

  const spacingOnly = await buildLessonTask(validLesson({
    studentName: '테 스 트 학 생', subject: '국 어', className: '비 문학', lessonRole: '독 해력'
  }), 'teacher-1', 'staff', 4);
  assert.equal(first.id, spacingOnly.id);
});

test('stable student id survives the server path and keeps assignment across renames', async () => {
  const first = await buildLessonTask(validLesson({ studentId: ' student_123-A ' }), 'teacher-1', 'staff', 1);
  const renamed = await buildLessonTask(validLesson({
    studentId: 'student_123-A', studentName: '개명학생', grade: '중2'
  }), 'teacher-1', 'staff', 2);
  const otherStudent = await buildLessonTask(validLesson({ studentId: 'student_124-A' }), 'teacher-1', 'staff', 3);

  assert.equal(first.studentId, 'student_123-A');
  assert.equal(first.id, renamed.id);
  assert.equal(first.lessonAssignmentKey, renamed.lessonAssignmentKey);
  assert.notEqual(first.lessonContentHash, renamed.lessonContentHash);
  assert.notEqual(first.id, otherStudent.id);
  const caseDistinct = await buildLessonTask(validLesson({ studentId: 'Student_123-A' }), 'teacher-1', 'staff', 4);
  assert.notEqual(first.id, caseDistinct.id);
});

test('student id is an explicitly validated input field, not a server-owned field', async () => {
  const accepted = await buildLessonTask(validLesson({ studentId: 'student_123-A' }), 'teacher-1', 'staff', 1);
  assert.equal(accepted.studentId, 'student_123-A');
  await assert.rejects(
    () => buildLessonTask(validLesson({ studentId: 'student id!' }), 'teacher-1', 'staff', 1),
    /학생 식별자/
  );
  await assert.rejects(
    () => buildLessonTask(validLesson({ studentId: 'a'.repeat(129) }), 'teacher-1', 'staff', 1),
    /학생 식별자/
  );
});

test('legacy student-name assignment identity stays byte compatible while schedule text is canonicalized', async () => {
  const task = await buildLessonTask(validLesson({ adminRequest: '없음' }), 'teacher-1', 'staff', 1234);
  assert.equal(task.id, 'lesson-1eb0da14754100ea367b49314a88594d');
  assert.equal(task.lessonAssignmentKey, 'sha256:1eb0da14754100ea367b49314a88594d7dfeaffe0300f61c9a8d84bce05c508e');
  assert.equal(task.scheduleText, '월·수 17:00-19:00 · 2T / 일 12:00-14:00 · 2T');
  assert.match(task.lessonContentHash, /^sha256:[a-f0-9]{64}$/);
});
test('structured schedule alone is canonicalized and produces schedule text', async () => {
  const task = await buildLessonTask(validLesson({
    scheduleText: '',
    scheduleSlots: [
      { days: [3], startTime: '9:00', endTime: '10:00' },
      { days: [1], startTime: '12:00', endTime: '13:00' },
      { days: [3], startTime: '09:00', endTime: '10:00' }
    ]
  }), 'teacher-1', 'staff', 1);
  assert.equal(task.scheduleText, '월 12:00-13:00 · 2T / 수 09:00-10:00 · 2T');
  assert.equal(task.scheduleSlots.length, 2);
  assert.deepEqual(task.scheduleSlots.map(slot => slot.slotId), ['slot-1', 'slot-2']);
});

test('all lesson form groups including hours on every confirmed time are enforced and literal 없음 is accepted', async () => {
  await assert.rejects(
    () => buildLessonTask(validLesson({ lessonHours: '' }), 'teacher-1', 'staff', 1),
    /수업시수/
  );
  await assert.rejects(
    () => buildLessonTask(validLesson({ lessonHours: '110분' }), 'teacher-1', 'staff', 1),
    /수업시수/
  );
  for (const field of ['materials', 'onlineProgram', 'homework', 'studentTraits', 'goal', 'parentRequest']) {
    await assert.rejects(
      () => buildLessonTask(validLesson({ [field]: '' }), 'teacher-1', 'staff', 1),
      /필수 항목/
    );
  }
  const task = await buildLessonTask(validLesson({
    materials: '없음', onlineProgram: '없음', homework: '없음',
    studentTraits: '없음', goal: '없음', parentRequest: '없음'
  }), 'teacher-1', 'staff', 1);
  assert.equal(task.goal, '없음');
  assert.equal((await buildLessonTask(validLesson({ adminRequest: '' }), 'teacher-1', 'staff', 1)).adminRequest, '없음');
  assert.match((await buildLessonTask(validLesson(), 'teacher-1', 'staff', 1)).guide, /■ 관리자 요청사항\n수업 후 진도표 확인/);
});

test('equal confirmed times are grouped and different times keep their own lesson hours', async () => {
  const task = await buildLessonTask(validLesson({
    lessonHours: '', scheduleText: '',
    scheduleSlots: [
      { days: [3], startTime: '18:00', endTime: '19:50', lessonHours: '2T' },
      { days: [1], startTime: '18:00', endTime: '19:50', lessonHours: '2T' },
      { days: [5], startTime: '20:00', endTime: '20:50', lessonHours: '1T' }
    ]
  }), 'teacher-1', 'staff', 1);
  assert.equal(task.scheduleText, '월·수 18:00-19:50 · 2T / 금 20:00-20:50 · 1T');
  assert.equal(task.lessonHours, '');
  assert.deepEqual(task.scheduleSlots.map(slot => [slot.days, slot.lessonHours]), [
    [[1], '2T'], [[3], '2T'], [[5], '1T']
  ]);
});

test('person auth cannot target another teacher', async () => {
  const db = new FakeDB();
  const { response } = await call(db, { staffId: 'teacher-2', lesson: assignedLesson() }, { scope: 'own', id: 'teacher-1' });
  assert.equal(response.status, 403);
  assert.equal(db.tasks.size, 0);
});

test('student id must exist and person auth is limited to assigned students', async () => {
  const db = new FakeDB();
  const own = await call(db, { lesson: validLesson({ studentId: 'student-a' }) }, { scope: 'own', id: 'teacher-1' });
  assert.equal(own.response.status, 200);

  const other = await call(db, { lesson: validLesson({ studentId: 'student-b' }) }, { scope: 'own', id: 'teacher-1' });
  assert.equal(other.response.status, 403);

  const unknown = await call(db, { lesson: validLesson({ studentId: 'student-missing' }) }, { scope: 'own', id: 'teacher-1' });
  assert.equal(unknown.response.status, 409);

  const admin = await call(db, {
    staffId: 'teacher-1', lesson: validLesson({ studentId: 'student-b' })
  }, { scope: 'all' });
  assert.equal(admin.response.status, 200);
});

test('person submissions require a roster id and matching roster identity', async () => {
  const db = new FakeDB();
  const missing = await call(db, { lesson: validLesson() }, { scope: 'own', id: 'teacher-1' });
  assert.equal(missing.response.status, 400);

  const wrongName = await call(db, {
    lesson: assignedLesson({ studentName: '다른학생' })
  }, { scope: 'own', id: 'teacher-1' });
  assert.equal(wrongName.response.status, 409);

  const wrongGrade = await call(db, {
    lesson: assignedLesson({ grade: '초5' })
  }, { scope: 'own', id: 'teacher-1' });
  assert.equal(wrongGrade.response.status, 409);
  assert.equal(db.tasks.size, 0);
});

test('student id submissions fail closed until the private roster is seeded', async () => {
  const db = new FakeDB();
  db.privateRoster = null;
  const result = await call(db, { lesson: validLesson({ studentId: 'student-a' }) }, { scope: 'own', id: 'teacher-1' });
  assert.equal(result.response.status, 409);
  assert.equal(db.tasks.size, 0);
});

test('client cannot inject server-owned task fields', async () => {
  const db = new FakeDB();
  const lesson = assignedLesson({ origin: 'manager' });
  const { response } = await call(db, { lesson }, { scope: 'own', id: 'teacher-1' });
  assert.equal(response.status, 403);
  assert.equal(db.tasks.size, 0);
});

test('admin must choose an active teacher and uses admin origin', async () => {
  const db = new FakeDB();
  const missing = await call(db, { lesson: validLesson() }, { scope: 'all' });
  assert.equal(missing.response.status, 409);
  const inactive = await call(db, { staffId: 'inactive', lesson: validLesson() }, { scope: 'all' });
  assert.equal(inactive.response.status, 409);
  const valid = await call(db, { staffId: 'teacher-2', lesson: validLesson() }, { scope: 'all' });
  assert.equal(valid.response.status, 200);
  assert.equal(valid.data.task.staffId, 'teacher-2');
  assert.equal(valid.data.task.origin, 'admin');
});

test('duplicate submissions are idempotent with explicit response flags', async () => {
  const db = new FakeDB();
  const body = { lesson: assignedLesson() };
  const first = await call(db, body, { scope: 'own', id: 'teacher-1' });
  const second = await call(db, body, { scope: 'own', id: 'teacher-1' });
  assert.deepEqual(
    [first.data.created, first.data.updated, first.data.idempotent],
    [true, false, false]
  );
  assert.deepEqual(
    [second.data.created, second.data.updated, second.data.idempotent],
    [false, false, true]
  );
  assert.equal(first.data.task.id, second.data.task.id);
  assert.equal(db.tasks.size, 1);
});

test('changed grade, schedule, and start update the same task with a revision', async () => {
  const db = new FakeDB();
  const first = await call(db, { lesson: assignedLesson() }, { scope: 'own', id: 'teacher-1' });
  db.privateRoster.roster.students[0].grade = '초5';
  const correctedLesson = assignedLesson({
    grade: '초5',
    start: '2026-09-01',
    scheduleText: '금 18:00-19:00',
    scheduleSlots: [{ days: [5], startTime: '18:00', endTime: '19:00' }]
  });
  const corrected = await call(db, {
    sourceTaskId: first.data.task.id,
    lesson: correctedLesson,
    expectedUpdatedAt: first.data.task.updatedAt
  }, { scope: 'own', id: 'teacher-1' });
  assert.equal(corrected.response.status, 200);
  assert.equal(corrected.data.created, false);
  assert.equal(corrected.data.updated, true);
  assert.equal(corrected.data.idempotent, false);
  assert.equal(corrected.data.task.id, first.data.task.id);
  assert.equal(corrected.data.task.createdAt, first.data.task.createdAt);
  assert.equal(corrected.data.task.origin, 'staff');
  assert.equal(corrected.data.task.lessonRevision, 2);
  assert.equal(corrected.data.task.grade, '초5');
  assert.equal(db.tasks.size, 1);
});

test('root admin and allowlisted manager lesson writes keep distinct server attribution', async () => {
  for (const [auth, expectedActor] of [
    [{ scope: 'all' }, 'admin'],
    [{ scope: 'all', id: 'manager-1', role: 'manager' }, 'manager']
  ]) {
    const db = new FakeDB();
    const created = await call(db, {
      staffId: 'teacher-1', lesson: assignedLesson()
    }, auth);
    assert.equal(created.response.status, 200);
    assert.equal(created.data.task.origin, expectedActor);

    const updated = await call(db, {
      staffId: 'teacher-1', sourceTaskId: created.data.task.id,
      expectedUpdatedAt: created.data.task.updatedAt,
      lesson: assignedLesson({ materials: '감사 주체 구분 수정' })
    }, auth);
    assert.equal(updated.response.status, 200);
    assert.equal(updated.data.task.origin, expectedActor);
    assert.equal(updated.data.task.updatedByScope, expectedActor);
  }
});

test('a changed submission without an expected version cannot overwrite', async () => {
  const db = new FakeDB();
  const first = await call(db, { lesson: assignedLesson() }, { scope: 'own', id: 'teacher-1' });
  const unsafe = await call(db, {
    lesson: assignedLesson({ materials: '기준 없이 덮어쓰기' })
  }, { scope: 'own', id: 'teacher-1' });
  assert.equal(unsafe.response.status, 409);
  assert.equal(unsafe.data.code, 'lesson_revision_conflict');
  assert.equal(unsafe.data.task.updatedAt, first.data.task.updatedAt);
  assert.equal(JSON.parse(db.tasks.get(first.data.task.id).data).materials, first.data.task.materials);
});

test('stale expectedUpdatedAt returns an optimistic conflict without overwrite', async () => {
  const db = new FakeDB();
  const first = await call(db, { lesson: assignedLesson() }, { scope: 'own', id: 'teacher-1' });
  const second = await call(db, {
    lesson: assignedLesson({ materials: '수정 교재 1' }),
    expectedUpdatedAt: first.data.task.updatedAt
  }, { scope: 'own', id: 'teacher-1' });
  const stale = await call(db, {
    lesson: assignedLesson({ materials: '수정 교재 2' }),
    expectedUpdatedAt: first.data.task.updatedAt
  }, { scope: 'own', id: 'teacher-1' });
  assert.equal(second.response.status, 200);
  assert.equal(stale.response.status, 409);
  assert.equal(stale.data.code, 'lesson_revision_conflict');
  assert.equal(stale.data.task.materials, '수정 교재 1');
});

test('a legacy nine-field task is corrected in place instead of duplicated', async () => {
  const db = new FakeDB();
  const legacy = await buildLessonTask(validLesson(), 'teacher-1', 'manager', 100);
  legacy.id = 'legacy-lesson-id';
  legacy.groupId = 'legacy-group';
  legacy.steps = legacy.steps.map((step, index) => ({ ...step, id: legacy.id + '-step-' + (index + 1) }));
  delete legacy.lessonAssignmentKey;
  delete legacy.lessonContentHash;
  delete legacy.lessonRevision;
  seed(db, legacy);

  const corrected = await call(db, {
    staffId: 'teacher-1',
    sourceTaskId: legacy.id,
    lesson: validLesson({ grade: '초5' }),
    expectedUpdatedAt: legacy.updatedAt
  }, { scope: 'all' });
  assert.equal(corrected.response.status, 200);
  assert.equal(corrected.data.updated, true);
  assert.equal(corrected.data.task.id, 'legacy-lesson-id');
  assert.equal(corrected.data.task.groupId, 'legacy-group');
  assert.equal(db.tasks.size, 1);
});

test('admin can convert an owner-scoped legacy lesson and restore its missing staff id', async () => {
  const db = new FakeDB();
  const legacy = {
    id: 'legacy-title-lesson', title: '[수업] 기존 학생 수업', staffId: '', origin: 'admin',
    createdAt: 50, updatedAt: 100, deleted: false, steps: [], groupId: 'legacy-title-group'
  };
  db.tasks.set(legacy.id, {
    owner: 'teacher-1', data: JSON.stringify(legacy), updatedAt: legacy.updatedAt, srvAt: legacy.updatedAt
  });
  const result = await call(db, {
    staffId: 'teacher-1', sourceTaskId: legacy.id,
    lesson: validLesson({ studentId: 'student-a' }), expectedUpdatedAt: legacy.updatedAt
  }, { scope: 'all' });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.task.id, legacy.id);
  assert.equal(result.data.task.staffId, 'teacher-1');
  assert.equal(result.data.task.studentId, 'student-a');
  assert.equal(result.data.task.taskKind, 'lesson_instruction');
  assert.equal(result.data.task.scheduleStatus, 'confirmed');
});

test('staff cannot overwrite a manager-created assignment', async () => {
  const db = new FakeDB();
  const managed = await buildLessonTask(assignedLesson(), 'teacher-1', 'manager', 100);
  seed(db, managed);
  const result = await call(db, {
    lesson: assignedLesson({ materials: '직원 임의 수정' }),
    expectedUpdatedAt: managed.updatedAt
  }, { scope: 'own', id: 'teacher-1' });
  assert.equal(result.response.status, 403);
  assert.equal(result.data.code, 'lesson_update_forbidden');
  assert.equal(JSON.parse(db.tasks.get(managed.id).data).materials, managed.materials);
});

test('a deleted matching assignment returns 409 instead of a hidden success', async () => {
  const db = new FakeDB();
  const deleted = await buildLessonTask(assignedLesson(), 'teacher-1', 'staff', 100);
  deleted.deleted = true;
  seed(db, deleted);
  const result = await call(db, { lesson: assignedLesson() }, { scope: 'own', id: 'teacher-1' });
  assert.equal(result.response.status, 409);
  assert.match(result.data.error, /삭제된 수업/);
});

test('wrong-owner deterministic id is neither returned nor modified', async () => {
  const db = new FakeDB();
  const candidate = await buildLessonTask(assignedLesson(), 'teacher-1', 'staff', 100);
  const foreign = {
    ...candidate,
    staffId: 'teacher-2',
    origin: 'staff',
    materials: '다른 담당자 전용 내용'
  };
  db.tasks.set(candidate.id, {
    owner: 'teacher-2', data: JSON.stringify(foreign),
    updatedAt: foreign.updatedAt, srvAt: foreign.updatedAt
  });

  const result = await call(db, { lesson: assignedLesson() }, { scope: 'own', id: 'teacher-1' });
  assert.equal(result.response.status, 409);
  assert.notEqual(result.data.task && result.data.task.materials, foreign.materials);
  const persisted = JSON.parse(db.tasks.get(candidate.id).data);
  assert.equal(persisted.staffId, 'teacher-2');
  assert.equal(persisted.materials, foreign.materials);
});

test('sourceTaskId is owner scoped', async () => {
  const db = new FakeDB();
  const foreign = await buildLessonTask(assignedLesson(), 'teacher-2', 'staff', 100);
  seed(db, foreign);
  const result = await call(db, {
    sourceTaskId: foreign.id,
    lesson: assignedLesson(),
    expectedUpdatedAt: foreign.updatedAt
  }, { scope: 'own', id: 'teacher-1' });
  assert.equal(result.response.status, 404);
  assert.equal(result.data.task, undefined);
});

test('sourceTaskId cannot change identity onto an existing assignment', async () => {
  const db = new FakeDB();
  const grade4 = await buildLessonTask(validLesson(), 'teacher-1', 'manager', 100);
  const grade5 = await buildLessonTask(validLesson({ grade: '초5' }), 'teacher-1', 'manager', 101);
  seed(db, grade4);
  seed(db, grade5);
  const result = await call(db, {
    staffId: 'teacher-1',
    sourceTaskId: grade4.id,
    lesson: validLesson({ grade: '초5' }),
    expectedUpdatedAt: grade4.updatedAt
  }, { scope: 'all' });
  assert.equal(result.response.status, 409);
  assert.equal(db.tasks.size, 2);
});

test('structured slots replace stale prose schedule text', async () => {
  const task = await buildLessonTask(validLesson({
    scheduleText: '화 18:00-19:00',
    scheduleReviewReason: '입력자 메모'
  }), 'teacher-1', 'staff', 100);
  assert.equal(task.scheduleStatus, 'confirmed');
  assert.equal(task.scheduleSlots.length, 2);
  assert.equal(task.repeat, 'days');
  assert.equal(task.scheduleText, '월·수 17:00-19:00 · 2T / 일 12:00-14:00 · 2T');
  assert.equal(task.scheduleReviewReason, '');
});

test('unconfirmed schedules cannot leak partial structured slots', async () => {
  const task = await buildLessonTask(validLesson({
    scheduleText: '월수금 18:00-19:50, 월수 2시간/금 1시간',
    scheduleSlots: [],
    scheduleStatus: 'needs_review',
    scheduleReviewReason: '금요일 종료시각 확인 필요'
  }), 'teacher-1', 'staff', 1234);
  assert.equal(task.scheduleStatus, 'needs_review');
  assert.deepEqual(task.scheduleSlots, []);
  assert.equal(task.repeat, 'once');
});

test('admin atomically creates multiple independent lessons for one stable student', async () => {
  const db = new FakeDB();
  const result = await callBatch(db, [
    { staffId: 'teacher-1', lesson: assignedLesson({ subject: '수학', className: '', lessonRole: '수학' }) },
    { staffId: 'teacher-2', lesson: assignedLesson({ subject: '영어', className: '', lessonRole: '영어',
      scheduleText: '화·목 18:00-19:50 / 금 19:00-19:50',
      scheduleSlots: [
        { days: [2, 4], startTime: '18:00', endTime: '19:50' },
        { days: [5], startTime: '19:00', endTime: '19:50' }
      ] }) }
  ]);
  assert.equal(result.response.status, 200);
  assert.equal(result.data.createdCount, 2);
  assert.equal(result.data.rosterUpdated, true);
  assert.equal(result.data.rosterUpdatedCount, 1);
  assert.equal(result.data.duplicateCount, 0);
  assert.equal(result.data.tasks.length, 2);
  assert.equal(db.tasks.size, 2);
  assert.deepEqual(new Set(result.data.tasks.map(task => task.studentId)), new Set(['student-a']));
  assert.deepEqual(new Set(result.data.tasks.map(task => task.subject)), new Set(['수학', '영어']));
  assert.deepEqual(db.privateRoster.roster.students[0].teacherIds, ['teacher-1', 'teacher-2']);
  assert.deepEqual(db.privateRoster.roster.students[0].subjects, ['수학', '영어']);
});

test('admin atomically registers one shared lesson for multiple stable students', async () => {
  const db = new FakeDB();
  db.privateRoster.roster.students[0].name = '가학생';
  db.privateRoster.roster.students[1].name = '나학생';
  db.privateRoster.roster.students[1].grade = '초5';
  const result = await callStudentBatch(db, [
    { staffId: 'teacher-1', lesson: assignedLesson({ studentId: 'student-a', studentName: '가학생', grade: '초4' }) },
    { staffId: 'teacher-1', lesson: assignedLesson({ studentId: 'student-b', studentName: '나학생', grade: '초5' }) }
  ]);
  assert.equal(result.response.status, 200);
  assert.equal(result.data.batchKind, 'students');
  assert.equal(result.data.createdCount, 2);
  assert.equal(result.data.rosterUpdated, true);
  assert.equal(result.data.rosterUpdatedCount, 2);
  assert.equal(result.data.tasks.length, 2);
  assert.deepEqual(new Set(result.data.tasks.map(task => task.studentId)), new Set(['student-a', 'student-b']));
  assert.deepEqual(new Set(result.data.tasks.map(task => task.staffId)), new Set(['teacher-1']));
  assert.deepEqual(db.privateRoster.roster.students[0].teacherIds, ['teacher-1']);
  assert.deepEqual(db.privateRoster.roster.students[1].teacherIds, ['teacher-2', 'teacher-1']);
  assert.deepEqual(db.privateRoster.roster.students[0].subjects, ['국어']);
  assert.deepEqual(db.privateRoster.roster.students[1].subjects, ['국어']);
});

test('server safely recognizes multiple students even when a stale client sends the old batch kind', async () => {
  const db = new FakeDB();
  db.privateRoster.roster.students[0].name = '가학생';
  db.privateRoster.roster.students[1].name = '나학생';
  db.privateRoster.roster.students[1].grade = '초5';
  db.privateRoster.roster.students.push({ id: 'student-c', name: '다학생', grade: '초6', teacherIds: [] });
  const sharedClass = {
    lessonHours: '1.5T',
    scheduleText: '토 12:00-13:20 · 1.5T',
    scheduleSlots: [{ days: [6], startTime: '12:00', endTime: '13:20', lessonHours: '1.5T' }]
  };
  const response = await handleLessonCreateBatch({ DB: db }, 'task', {
    batchKind: 'lessons',
    lessons: [
      { staffId: 'teacher-1', lesson: assignedLesson({ ...sharedClass, studentId: 'student-a', studentName: '가학생', grade: '초4' }) },
      { staffId: 'teacher-1', lesson: assignedLesson({ ...sharedClass, studentId: 'student-b', studentName: '나학생', grade: '초5' }) },
      { staffId: 'teacher-1', lesson: assignedLesson({ ...sharedClass, studentId: 'student-c', studentName: '다학생', grade: '초6' }) }
    ]
  }, '*', { scope: 'all', role: 'admin' }, json);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.batchKind, 'students');
  assert.equal(data.createdCount, 3);
  assert.equal(db.tasks.size, 3);
  assert.equal(data.rosterUpdatedCount, 3);
  assert.equal(db.privateRoster.roster.students.every(student => student.teacherIds.includes('teacher-1')), true);
  assert.equal(db.privateRoster.roster.students.every(student => student.subjects.includes('국어')), true);
});

test('an exact retry repairs missing roster links without recreating existing lessons', async () => {
  const db = new FakeDB();
  db.privateRoster.roster.students[0].name = '가학생';
  db.privateRoster.roster.students[1].name = '나학생';
  db.privateRoster.roster.students[1].grade = '초5';
  const lessons = [
    { staffId: 'teacher-1', lesson: assignedLesson({ studentId: 'student-a', studentName: '가학생', grade: '초4' }) },
    { staffId: 'teacher-1', lesson: assignedLesson({ studentId: 'student-b', studentName: '나학생', grade: '초5' }) }
  ];
  for (let index = 0; index < lessons.length; index += 1) {
    seed(db, await buildLessonTask(lessons[index].lesson, lessons[index].staffId, 'admin', 1000 + index));
  }
  const result = await callStudentBatch(db, lessons);
  assert.equal(result.response.status, 200);
  assert.equal(result.data.createdCount, 0);
  assert.equal(result.data.duplicateCount, 2);
  assert.equal(result.data.rosterUpdated, true);
  assert.equal(result.data.rosterUpdatedCount, 2);
  assert.equal(result.data.idempotent, false);
  assert.equal(db.tasks.size, 2);
  assert.deepEqual(db.privateRoster.roster.students[0].teacherIds, ['teacher-1']);
  assert.deepEqual(db.privateRoster.roster.students[1].teacherIds, ['teacher-2', 'teacher-1']);
});

test('multi-student batch rejects duplicate students or differing class templates', async () => {
  const duplicateDb = new FakeDB();
  const duplicate = await callStudentBatch(duplicateDb, [
    { staffId: 'teacher-1', lesson: assignedLesson({ studentId: 'student-a' }) },
    { staffId: 'teacher-1', lesson: assignedLesson({ studentId: 'student-a' }) }
  ]);
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicateDb.tasks.size, 0);

  const mixedDb = new FakeDB();
  const mixed = await callStudentBatch(mixedDb, [
    { staffId: 'teacher-1', lesson: assignedLesson({ studentId: 'student-a', subject: '수학', lessonRole: '수학' }) },
    { staffId: 'teacher-1', lesson: assignedLesson({ studentId: 'student-b', subject: '영어', lessonRole: '영어' }) }
  ]);
  assert.equal(mixed.response.status, 400);
  assert.match(mixed.data.error, /같은 수업/);
  assert.equal(mixedDb.tasks.size, 0);
});

test('batch validation failure creates no lesson and rejects mixed students or duplicate assignments', async () => {
  const db = new FakeDB();
  const invalid = await callBatch(db, [
    { staffId: 'teacher-1', lesson: assignedLesson({ subject: '수학', className: '', lessonRole: '수학' }) },
    { staffId: 'teacher-2', lesson: assignedLesson({ subject: '영어', className: '', lessonRole: '영어', scheduleText: '', scheduleSlots: [] }) }
  ]);
  assert.equal(invalid.response.status, 400);
  assert.equal(db.tasks.size, 0);

  const mixed = await callBatch(db, [
    { staffId: 'teacher-1', lesson: assignedLesson({ subject: '수학', className: '', lessonRole: '수학' }) },
    { staffId: 'teacher-2', lesson: assignedLesson({ studentId: 'student-b', subject: '영어', className: '', lessonRole: '영어' }) }
  ]);
  assert.equal(mixed.response.status, 400);
  assert.equal(db.tasks.size, 0);

  const duplicateLesson = assignedLesson({ subject: '수학', className: '', lessonRole: '수학' });
  const duplicate = await callBatch(db, [
    { staffId: 'teacher-1', lesson: duplicateLesson },
    { staffId: 'teacher-1', lesson: duplicateLesson }
  ]);
  assert.equal(duplicate.response.status, 409);
  assert.equal(db.tasks.size, 0);
});

test('batch database failure rolls every lesson back and an exact retry is idempotent', async () => {
  const lessons = [
    { staffId: 'teacher-1', lesson: assignedLesson({ subject: '수학', className: '', lessonRole: '수학' }) },
    { staffId: 'teacher-2', lesson: assignedLesson({ subject: '영어', className: '', lessonRole: '영어' }) }
  ];
  const failingDb = new FakeDB();
  failingDb.failBatchAt = 1;
  const failed = await callBatch(failingDb, lessons);
  assert.equal(failed.response.status, 409);
  assert.equal(failingDb.tasks.size, 0);
  assert.deepEqual(failingDb.privateRoster.roster.students[0].teacherIds, ['teacher-1']);
  assert.equal(failingDb.privateRoster.roster.students[0].subjects, undefined);

  const db = new FakeDB();
  const first = await callBatch(db, lessons);
  assert.equal(first.response.status, 200);
  assert.equal(first.data.createdCount, 2);
  const retried = await callBatch(db, lessons);
  assert.equal(retried.response.status, 200);
  assert.equal(retried.data.createdCount, 0);
  assert.equal(retried.data.duplicateCount, 2);
  assert.equal(retried.data.idempotent, true);
  assert.equal(db.tasks.size, 2);
});

test('teachers cannot use the multi-teacher batch registration endpoint', async () => {
  const db = new FakeDB();
  const result = await callBatch(db, [
    { staffId: 'teacher-1', lesson: assignedLesson() }
  ], { scope: 'own', id: 'teacher-1' });
  assert.equal(result.response.status, 403);
  assert.equal(db.tasks.size, 0);
});

test('invalid, overlapping, and excessive structured slots are rejected', async () => {
  await assert.rejects(
    () => buildLessonTask(validLesson({ scheduleSlots: [{ days: [1], startTime: '19:00', endTime: '18:00' }] }), 'teacher-1', 'staff', 1),
    /요일·시작·종료/
  );
  await assert.rejects(
    () => buildLessonTask(validLesson({ scheduleSlots: [
      { days: [1], startTime: '18:00', endTime: '19:00' },
      { days: [1], startTime: '18:30', endTime: '19:30' }
    ] }), 'teacher-1', 'staff', 1),
    /겹치는 확정 시간/
  );
  await assert.rejects(
    () => buildLessonTask(validLesson({
      scheduleSlots: Array.from({ length: 21 }, (_, index) => ({
        days: [index % 7], startTime: '10:00', endTime: '11:00'
      }))
    }), 'teacher-1', 'staff', 1),
    /최대 20개/
  );
});

test('route is wired and no Solapi send code is introduced', () => {
  const worker = fs.readFileSync(new URL('./worker-core.js', import.meta.url), 'utf8');
  const source = fs.readFileSync(new URL('./lesson-create.js', import.meta.url), 'utf8');
  assert.match(worker, /\/lesson-create/);
  assert.match(worker, /\/lesson-create-batch/);
  assert.doesNotMatch(source, /api\.solapi\.com|SOLAPI_SECRET|phone|recipient/i);
});
