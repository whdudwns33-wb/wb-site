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
    this.scopeTasks = [
      { id: 'scope-lesson-a', owner: 'teacher-1', data: JSON.stringify({ id: 'scope-lesson-a',
        staffId: 'teacher-1', studentId: 'student-a', taskKind: 'lesson_instruction', start: '2020-01-01',
        end: '', deleted: false }) },
      { id: 'scope-lesson-b', owner: 'teacher-2', data: JSON.stringify({ id: 'scope-lesson-b',
        staffId: 'teacher-2', studentId: 'student-b', taskKind: 'lesson_instruction', start: '2020-01-01',
        end: '', deleted: false }) }
    ];
    this.checks = new Map();
    this.failBatchAt = -1;
    this.beforeBatch = null;
    this.lastChanges = 0;
    this.privateRoster = {
      roster: { students: [
        { id: 'student-a', name: '테스트학생', grade: '초4', teacherIds: ['teacher-1'] },
        { id: 'student-b', name: '테스트학생', grade: '초4', teacherIds: ['teacher-2'] }
      ] },
      bookStudents: []
    };
    this.privateRosterUpdatedAt = 100;
    this.studentChangeEvents = [];
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
        if (sql.startsWith('SELECT * FROM session_packs')) return null;
        if (sql.startsWith('SELECT owner,data,updated_at FROM tasks')) {
          const row = db.tasks.get(this.args[1]);
          return row ? { owner: row.owner, data: row.data, updated_at: row.updatedAt } : null;
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
        if (sql.startsWith('SELECT id,owner,data FROM tasks')) {
          const owner = String(this.args[1]);
          const stored = [...db.tasks.entries()].map(([id, row]) => ({ id, owner: row.owner, data: row.data }));
          return { results: db.scopeTasks.concat(stored).filter(row => row.owner === owner) };
        }
        if (sql.startsWith('SELECT id,data FROM tasks')) {
          const [, owner, excludedId, studentId] = this.args;
          return {
            results: [...db.tasks.entries()]
              .filter(([id, row]) => id !== excludedId && row.owner === owner)
              .map(([id, row]) => ({ id, data: row.data }))
              .filter(row => {
                const data = JSON.parse(row.data);
                return data.studentId === studentId && !data.deleted;
              })
          };
        }
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
          if (db.privateRosterUpdatedAt !== expectedUpdatedAt) {
            db.lastChanges = 0;
            return { meta: { changes: 0 } };
          }
          db.privateRoster = JSON.parse(data);
          db.privateRosterUpdatedAt = updatedAt;
          db.lastChanges = 1;
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith('INSERT INTO task_write_cas_guards')) {
          if (db.lastChanges !== 1) throw new Error('TASK_WRITE_CAS_CONFLICT');
          db.lastChanges = 1;
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith('INSERT INTO tasks')) {
          const [, id, owner, data, updatedAt, srvAt] = this.args;
          if (db.tasks.has(id)) throw new Error('task conflict');
          db.tasks.set(id, { owner, data, updatedAt, srvAt });
          db.lastChanges = 1;
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
        if (sql.startsWith('UPDATE tasks SET owner=')) {
          const [nextOwner, data, updatedAt, srvAt, , id, owner, expectedUpdatedAt] = this.args;
          const current = db.tasks.get(id);
          if (!current || current.owner !== owner || current.updatedAt !== expectedUpdatedAt) {
            return { meta: { changes: 0 } };
          }
          db.tasks.set(id, { owner: nextOwner, data, updatedAt, srvAt });
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith('UPDATE checks SET owner=')) {
          const [nextOwner, srvAt, , owner, taskId] = this.args;
          let changes = 0;
          for (const [key, row] of db.checks) {
            const data = JSON.parse(row.data);
            if (row.owner !== owner || data.taskId !== taskId) continue;
            db.checks.set(key, { ...row, owner: nextOwner, srvAt });
            changes += 1;
          }
          return { meta: { changes } };
        }
        if (sql.startsWith('INSERT OR IGNORE INTO student_change_events')) {
          db.studentChangeEvents.push({
            eventId: this.args[1], studentId: this.args[2], taskId: this.args[3], eventType: this.args[4],
            changedFields: JSON.parse(this.args[5]), details: JSON.parse(this.args[6]),
            audienceStaffIds: JSON.parse(this.args[7])
          });
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith('INSERT INTO session_pack_transfer_guards')) {
          return { meta: { changes: 1 } };
        }
        throw new Error('unexpected run SQL: ' + sql);
      }
    };
  }

  async batch(statements) {
    if (typeof this.beforeBatch === 'function') {
      const beforeBatch = this.beforeBatch;
      this.beforeBatch = null;
      await beforeBatch(this);
    }
    const snapshot = new Map(this.tasks);
    const checksSnapshot = new Map(this.checks);
    const rosterSnapshot = JSON.parse(JSON.stringify(this.privateRoster));
    const rosterUpdatedAtSnapshot = this.privateRosterUpdatedAt;
    const lastChangesSnapshot = this.lastChanges;
    const results = [];
    try {
      for (let index = 0; index < statements.length; index += 1) {
        if (this.failBatchAt === index) throw new Error('simulated batch failure');
        results.push(await statements[index].run());
      }
      return results;
    } catch (error) {
      this.tasks = snapshot;
      this.checks = checksSnapshot;
      this.privateRoster = rosterSnapshot;
      this.privateRosterUpdatedAt = rosterUpdatedAtSnapshot;
      this.lastChanges = lastChangesSnapshot;
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

async function seedOwnLesson(db, overrides = {}, updatedAt = 100) {
  const task = await buildLessonTask(assignedLesson(overrides), 'teacher-1', 'staff', updatedAt);
  seed(db, task);
  return task;
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

test('person auth cannot create an additional subject without an exact approved source task', async () => {
  const db = new FakeDB();
  const existing = await seedOwnLesson(db, { subject: '국어', lessonRole: '국어' });
  const result = await call(db, {
    lesson: assignedLesson({ subject: '영어', lessonRole: '영어', className: '영어' })
  }, { scope: 'own', id: 'teacher-1' });

  assert.equal(result.response.status, 403);
  assert.equal(result.data.code, 'lesson_assignment_approval_required');
  assert.equal(db.tasks.size, 1);
  assert.equal(JSON.parse(db.tasks.get(existing.id).data).subject, '국어');
});

test('person auth cannot repurpose an exact source task as another student or subject assignment', async () => {
  const db = new FakeDB();
  const source = await seedOwnLesson(db, { subject: '국어', lessonRole: '국어' });
  db.scopeTasks.push({ id: 'scope-lesson-b-for-teacher-1', owner: 'teacher-1', data: JSON.stringify({
    id: 'scope-lesson-b-for-teacher-1', staffId: 'teacher-1', studentId: 'student-b',
    taskKind: 'lesson_instruction', start: '2020-01-01', end: '', deleted: false
  }) });
  for (const lesson of [
    assignedLesson({ subject: '영어', lessonRole: '영어', className: '영어' }),
    assignedLesson({ studentId: 'student-b' })
  ]) {
    const result = await call(db, {
      sourceTaskId: source.id, expectedUpdatedAt: source.updatedAt, lesson
    }, { scope: 'own', id: 'teacher-1' });
    assert.equal(result.response.status, 403);
    assert.equal(result.data.code, 'lesson_assignment_identity_locked');
  }
  assert.equal(db.tasks.size, 1);
  assert.equal(JSON.parse(db.tasks.get(source.id).data).studentId, 'student-a');
});

test('student id must exist and person auth is limited to assigned students', async () => {
  const db = new FakeDB();
  const source = await seedOwnLesson(db);
  const own = await call(db, {
    sourceTaskId: source.id, expectedUpdatedAt: source.updatedAt,
    lesson: validLesson({ studentId: 'student-a', materials: '수정 교재' })
  }, { scope: 'own', id: 'teacher-1' });
  assert.equal(own.response.status, 200);

  const other = await call(db, {
    sourceTaskId: source.id, expectedUpdatedAt: own.data.task.updatedAt,
    lesson: validLesson({ studentId: 'student-b' })
  }, { scope: 'own', id: 'teacher-1' });
  assert.equal(other.response.status, 403);

  const unknown = await call(db, {
    sourceTaskId: source.id, expectedUpdatedAt: own.data.task.updatedAt,
    lesson: validLesson({ studentId: 'student-missing' })
  }, { scope: 'own', id: 'teacher-1' });
  assert.equal(unknown.response.status, 409);

  const admin = await call(db, {
    staffId: 'teacher-1', lesson: validLesson({ studentId: 'student-b' })
  }, { scope: 'all' });
  assert.equal(admin.response.status, 200);
});

test('person submissions require a roster id and matching roster identity', async () => {
  const db = new FakeDB();
  const source = await seedOwnLesson(db);
  const common = { sourceTaskId: source.id, expectedUpdatedAt: source.updatedAt };
  const missing = await call(db, { ...common, lesson: validLesson() }, { scope: 'own', id: 'teacher-1' });
  assert.equal(missing.response.status, 400);

  const wrongName = await call(db, {
    ...common,
    lesson: assignedLesson({ studentName: '다른학생' })
  }, { scope: 'own', id: 'teacher-1' });
  assert.equal(wrongName.response.status, 409);

  const wrongGrade = await call(db, {
    ...common,
    lesson: assignedLesson({ grade: '초5' })
  }, { scope: 'own', id: 'teacher-1' });
  assert.equal(wrongGrade.response.status, 409);
  assert.equal(db.tasks.size, 1);
  assert.equal(JSON.parse(db.tasks.get(source.id).data).studentName, source.studentName);
});

test('new lessons cannot start before the roster first class date while existing corrections stay editable', async () => {
  const db = new FakeDB();
  db.privateRoster.roster.students[0].firstClassDate = '2026-09-05';
  const early = await call(db, {
    staffId: 'teacher-1', lesson: assignedLesson({ start: '2026-08-29' })
  }, { scope: 'all', role: 'admin' });
  assert.equal(early.response.status, 409);
  assert.match(early.data.error, /첫 수업 시작일 2026-09-05 이후/);
  assert.equal(db.tasks.size, 0);

  const exact = await call(db, {
    staffId: 'teacher-1', lesson: assignedLesson({ start: '2026-09-05' })
  }, { scope: 'all', role: 'admin' });
  assert.equal(exact.response.status, 200);
  assert.equal(exact.data.task.start, '2026-09-05');
  assert.equal(exact.data.task.scheduleSlots.every(slot => slot.validFrom === '2026-09-05'), true);
  db.privateRoster.roster.students[0].firstClassDate = '2026-09-10';
  const exactRetry = await call(db, {
    staffId: 'teacher-1', lesson: assignedLesson({ start: '2026-09-05' })
  }, { scope: 'all', role: 'admin' });
  assert.equal(exactRetry.response.status, 200);
  assert.equal(exactRetry.data.idempotent, true);

  const legacyDb = new FakeDB();
  const legacy = await seedOwnLesson(legacyDb, { start: '2026-08-29' });
  legacyDb.privateRoster.roster.students[0].firstClassDate = '2026-09-05';
  const corrected = await call(legacyDb, {
    sourceTaskId: legacy.id, expectedUpdatedAt: legacy.updatedAt,
    lesson: assignedLesson({ start: '2026-08-29', materials: '기존 수업의 다른 정보만 정정' })
  }, { scope: 'own', id: 'teacher-1' });
  assert.equal(corrected.response.status, 200);
  assert.equal(corrected.data.task.start, '2026-08-29');

  const reassignmentDb = new FakeDB();
  const source = await seedOwnLesson(reassignmentDb, { start: '2026-08-29' });
  reassignmentDb.privateRoster.roster.students[1].firstClassDate = '2026-09-05';
  const reassignedTooEarly = await call(reassignmentDb, {
    staffId: 'teacher-1', sourceTaskId: source.id, expectedUpdatedAt: source.updatedAt,
    lesson: assignedLesson({ studentId: 'student-b', start: '2026-08-29' })
  }, { scope: 'all', role: 'admin' });
  assert.equal(reassignedTooEarly.response.status, 409);
  assert.match(reassignedTooEarly.data.error, /첫 수업 시작일 2026-09-05 이후/);
  assert.equal(JSON.parse(reassignmentDb.tasks.get(source.id).data).studentId, 'student-a');
});

test('student id submissions fail closed until the private roster is seeded', async () => {
  const db = new FakeDB();
  const source = await seedOwnLesson(db);
  db.privateRoster = null;
  const result = await call(db, {
    sourceTaskId: source.id, expectedUpdatedAt: source.updatedAt,
    lesson: validLesson({ studentId: 'student-a' })
  }, { scope: 'own', id: 'teacher-1' });
  assert.equal(result.response.status, 409);
  assert.equal(db.tasks.size, 1);
});

test('client cannot inject server-owned task fields', async () => {
  const db = new FakeDB();
  const source = await seedOwnLesson(db);
  const lesson = assignedLesson({ origin: 'manager' });
  const { response } = await call(db, {
    sourceTaskId: source.id, expectedUpdatedAt: source.updatedAt, lesson
  }, { scope: 'own', id: 'teacher-1' });
  assert.equal(response.status, 403);
  assert.equal(db.tasks.size, 1);
});

test('general lesson input cannot inject weekend flexible policy fields', async () => {
  for (const [key, value] of [
    ['weekendAttendanceMode', 'flexible'],
    ['weekendAllowedDays', [0, 6]],
    ['weekendMonthlyTarget', 2],
    ['weekendFlexibleFrom', '2026-08-22']
  ]) {
    await assert.rejects(
      () => buildLessonTask(assignedLesson({ [key]: value }), 'teacher-1', 'staff', 100),
      error => error && error.status === 403 && /서버가 정하는 필드/.test(error.message),
      key
    );
  }
});

test('ordinary lesson correction preserves server-managed weekend flexible metadata', async () => {
  const db = new FakeDB();
  const source = await buildLessonTask(assignedLesson(), 'teacher-1', 'staff', 100);
  Object.assign(source, {
    weekendAttendanceMode: 'flexible', weekendAllowedDays: [0], weekendMonthlyTarget: 2,
    weekendFlexibleFrom: '2026-08-22'
  });
  seed(db, source);
  const corrected = await call(db, {
    sourceTaskId: source.id, expectedUpdatedAt: source.updatedAt,
    lesson: assignedLesson({ materials: '수정된 교재' })
  }, { scope: 'own', id: 'teacher-1' });
  assert.equal(corrected.response.status, 200);
  assert.equal(corrected.data.updated, true);
  assert.equal(corrected.data.task.id, source.id);
  assert.equal(corrected.data.task.weekendAttendanceMode, 'flexible');
  assert.deepEqual(corrected.data.task.weekendAllowedDays, [0]);
  assert.equal(corrected.data.task.weekendMonthlyTarget, 2);
  assert.equal(corrected.data.task.weekendFlexibleFrom, '2026-08-22');
});

test('admin lesson correction notifies only the exact lesson owner for a multi-subject student', async () => {
  const db = new FakeDB();
  const source = await buildLessonTask(assignedLesson({ subject: '국어', lessonRole: '국어' }),
    'teacher-1', 'admin', 100);
  seed(db, source);
  db.scopeTasks.push({
    id: 'scope-student-a-other-subject', owner: 'teacher-2',
    data: JSON.stringify({
      id: 'scope-student-a-other-subject', staffId: 'teacher-2', studentId: 'student-a',
      subject: '수학', taskKind: 'lesson_instruction', start: '2020-01-01', end: '', deleted: false
    })
  });
  const corrected = await call(db, {
    staffId: 'teacher-1', sourceTaskId: source.id, expectedUpdatedAt: source.updatedAt,
    lesson: assignedLesson({ subject: '국어', lessonRole: '국어', materials: '수정된 교재' })
  }, { scope: 'all', role: 'admin' });
  assert.equal(corrected.response.status, 200);
  assert.equal(db.studentChangeEvents.length, 1);
  assert.equal(db.studentChangeEvents[0].taskId, source.id);
  assert.equal(db.studentChangeEvents[0].eventType, 'work_instruction');
  assert.deepEqual(db.studentChangeEvents[0].changedFields, ['materials', 'guide']);
  assert.deepEqual(db.studentChangeEvents[0].audienceStaffIds, ['teacher-1']);
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

test('admin duplicate submissions are idempotent with explicit response flags', async () => {
  const db = new FakeDB();
  const body = { staffId: 'teacher-1', lesson: assignedLesson() };
  const first = await call(db, body, { scope: 'all', role: 'admin' });
  const second = await call(db, body, { scope: 'all', role: 'admin' });
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

test('one-time makeup tasks never satisfy or block a regular lesson assignment', async () => {
  const db = new FakeDB();
  const copied = await buildLessonTask(assignedLesson(), 'teacher-1', 'admin', 100);
  seed(db, {
    ...copied,
    id: 'makeup_lesson_mu_assignment_copy',
    groupId: 'makeup_lesson_mu_assignment_copy',
    lessonInstanceType: 'makeup',
    makeupCaseId: 'mu_assignment_copy',
    start: '2026-08-30', end: '2026-08-30', repeat: 'once'
  });

  const created = await call(db, { staffId: 'teacher-1', lesson: assignedLesson() },
    { scope: 'all', role: 'admin' });
  assert.equal(created.response.status, 200);
  assert.equal(created.data.created, true);
  assert.equal(created.data.task.id, copied.id);
  assert.equal(db.tasks.size, 2);
});

test('changed grade, schedule, and start update the same task with a revision', async () => {
  const db = new FakeDB();
  const firstTask = await seedOwnLesson(db);
  const first = { data: { task: firstTask } };
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

test('admin transfers the exact lesson while preserving history and leaving legacy roster ownership untouched', async () => {
  const db = new FakeDB();
  db.privateRoster.bookStudents = [{ studentId: 'student-a', teacherIds: ['teacher-1'] }];
  const created = await call(db, {
    staffId: 'teacher-1', lesson: assignedLesson()
  }, { scope: 'all', role: 'admin' });
  const history = { taskId: created.data.task.id, date: '2026-08-20', att: 'A', note: '기존 수업 메모', updatedAt: 123 };
  db.checks.set(created.data.task.id + '|2026-08-20', {
    owner: 'teacher-1', data: JSON.stringify(history), updatedAt: 123, srvAt: 123
  });
  const transferred = await call(db, {
    staffId: 'teacher-2', sourceTaskId: created.data.task.id,
    expectedUpdatedAt: created.data.task.updatedAt,
    lesson: assignedLesson()
  }, { scope: 'all', role: 'admin' });

  assert.equal(transferred.response.status, 200);
  assert.equal(transferred.data.updated, true);
  assert.equal(transferred.data.task.id, created.data.task.id);
  assert.equal(transferred.data.task.staffId, 'teacher-2');
  assert.equal(db.tasks.get(created.data.task.id).owner, 'teacher-2');
  assert.deepEqual(db.privateRoster.roster.students[0].teacherIds, ['teacher-1']);
  assert.deepEqual(db.privateRoster.bookStudents[0].teacherIds, ['teacher-1']);
  const movedHistory = db.checks.get(created.data.task.id + '|2026-08-20');
  assert.equal(movedHistory.owner, 'teacher-2');
  assert.deepEqual(JSON.parse(movedHistory.data), history);
  assert.equal(movedHistory.updatedAt, 123);
  assert.ok(movedHistory.srvAt > 123);
  assert.equal(db.studentChangeEvents.at(-1).eventType, 'teacher_assignment');
  assert.deepEqual(db.studentChangeEvents.at(-1).audienceStaffIds.sort(), ['teacher-1', 'teacher-2']);
});

test('teacher transfer ignores a stale deterministic target id occupied by a different assignment', async () => {
  const db = new FakeDB();
  const source = await buildLessonTask(assignedLesson(), 'teacher-1', 'manager', 100);
  seed(db, source);

  const targetCandidate = await buildLessonTask(assignedLesson(), 'teacher-2', 'manager', 101);
  const staleOccupant = await buildLessonTask(assignedLesson({
    subject: '클리닉', className: '', lessonRole: '클리닉'
  }), 'teacher-2', 'manager', 102);
  staleOccupant.id = targetCandidate.id;
  staleOccupant.groupId = 'stale-target-assignment';
  staleOccupant.steps = staleOccupant.steps.map((step, index) => ({
    ...step, id: staleOccupant.id + '-step-' + (index + 1)
  }));
  seed(db, staleOccupant);

  const transferred = await call(db, {
    staffId: 'teacher-2', sourceTaskId: source.id,
    expectedUpdatedAt: source.updatedAt, lesson: assignedLesson()
  }, { scope: 'all', role: 'admin' });

  assert.equal(transferred.response.status, 200);
  assert.equal(transferred.data.updated, true);
  assert.equal(transferred.data.task.id, source.id);
  assert.equal(transferred.data.task.staffId, 'teacher-2');
  assert.equal(db.tasks.get(source.id).owner, 'teacher-2');
  const untouched = JSON.parse(db.tasks.get(targetCandidate.id).data);
  assert.equal(untouched.subject, '클리닉');
  assert.equal(untouched.id, targetCandidate.id);
  assert.equal(db.tasks.size, 2);
});

test('new lesson insert fails closed when a different assignment occupies its deterministic id', async () => {
  const db = new FakeDB();
  const candidate = await buildLessonTask(assignedLesson(), 'teacher-1', 'manager', 100);
  const staleOccupant = await buildLessonTask(assignedLesson({
    subject: '클리닉', className: '', lessonRole: '클리닉'
  }), 'teacher-1', 'manager', 101);
  staleOccupant.id = candidate.id;
  staleOccupant.groupId = 'stale-existing-assignment';
  staleOccupant.steps = staleOccupant.steps.map((step, index) => ({
    ...step, id: staleOccupant.id + '-step-' + (index + 1)
  }));
  seed(db, staleOccupant);

  const created = await call(db, {
    staffId: 'teacher-1', lesson: assignedLesson()
  }, { scope: 'all', role: 'admin' });

  assert.equal(created.response.status, 409);
  assert.equal(created.data.code, 'lesson_revision_conflict');
  assert.equal(created.data.created, undefined);
  const persisted = JSON.parse(db.tasks.get(candidate.id).data);
  assert.equal(persisted.subject, '클리닉');
  assert.equal(db.tasks.size, 1);
});

test('teacher transfer never rewrites legacy aggregate roster assignment', async () => {
  const db = new FakeDB();
  const first = await call(db, {
    staffId: 'teacher-1', lesson: assignedLesson()
  }, { scope: 'all', role: 'admin' });
  const second = await call(db, {
    staffId: 'teacher-1', lesson: assignedLesson({ subject: '영어', lessonRole: '영어' })
  }, { scope: 'all', role: 'admin' });
  assert.equal(second.response.status, 200);

  const transferred = await call(db, {
    staffId: 'teacher-2', sourceTaskId: first.data.task.id,
    expectedUpdatedAt: first.data.task.updatedAt,
    lesson: assignedLesson()
  }, { scope: 'all', role: 'admin' });

  assert.equal(transferred.response.status, 200);
  assert.deepEqual(db.privateRoster.roster.students[0].teacherIds, ['teacher-1']);
});

test('a changed submission without an expected version cannot overwrite', async () => {
  const db = new FakeDB();
  const firstTask = await seedOwnLesson(db);
  const first = { data: { task: firstTask } };
  const unsafe = await call(db, {
    sourceTaskId: first.data.task.id,
    lesson: assignedLesson({ materials: '기준 없이 덮어쓰기' })
  }, { scope: 'own', id: 'teacher-1' });
  assert.equal(unsafe.response.status, 409);
  assert.equal(unsafe.data.code, 'lesson_revision_conflict');
  assert.equal(unsafe.data.task.updatedAt, first.data.task.updatedAt);
  assert.equal(JSON.parse(db.tasks.get(first.data.task.id).data).materials, first.data.task.materials);
});

test('stale expectedUpdatedAt returns an optimistic conflict without overwrite', async () => {
  const db = new FakeDB();
  const firstTask = await seedOwnLesson(db);
  const first = { data: { task: firstTask } };
  const second = await call(db, {
    sourceTaskId: first.data.task.id,
    lesson: assignedLesson({ materials: '수정 교재 1' }),
    expectedUpdatedAt: first.data.task.updatedAt
  }, { scope: 'own', id: 'teacher-1' });
  const stale = await call(db, {
    sourceTaskId: first.data.task.id,
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
    sourceTaskId: managed.id,
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
  const result = await call(db, {
    sourceTaskId: deleted.id, expectedUpdatedAt: deleted.updatedAt, lesson: assignedLesson()
  }, { scope: 'own', id: 'teacher-1' });
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
  assert.equal(result.response.status, 403);
  assert.equal(result.data.code, 'lesson_assignment_approval_required');
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
  assert.deepEqual(db.privateRoster.roster.students[0].teacherIds, ['teacher-1']);
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
  assert.deepEqual(db.privateRoster.roster.students[1].teacherIds, ['teacher-2']);
  assert.deepEqual(db.privateRoster.roster.students[0].subjects, ['국어']);
  assert.deepEqual(db.privateRoster.roster.students[1].subjects, ['국어']);
});

test('multi-student registration uses a common start no earlier than every selected first class date', async () => {
  const db = new FakeDB();
  db.privateRoster.roster.students[0].name = '가학생';
  db.privateRoster.roster.students[0].firstClassDate = '2026-09-01';
  db.privateRoster.roster.students[1].name = '나학생';
  db.privateRoster.roster.students[1].grade = '초5';
  db.privateRoster.roster.students[1].firstClassDate = '2026-09-05';
  const lessonFor = (studentId, studentName, grade, start) => ({
    staffId: 'teacher-1', lesson: assignedLesson({ studentId, studentName, grade, start })
  });
  const early = await callStudentBatch(db, [
    lessonFor('student-a', '가학생', '초4', '2026-09-04'),
    lessonFor('student-b', '나학생', '초5', '2026-09-04')
  ]);
  assert.equal(early.response.status, 409);
  assert.match(early.data.error, /첫 수업 시작일 2026-09-05 이후/);
  assert.equal(db.tasks.size, 0);

  const valid = await callStudentBatch(db, [
    lessonFor('student-a', '가학생', '초4', '2026-09-05'),
    lessonFor('student-b', '나학생', '초5', '2026-09-05')
  ]);
  assert.equal(valid.response.status, 200);
  assert.equal(valid.data.tasks.every(task => task.start === '2026-09-05'), true);
  db.privateRoster.roster.students.forEach(student => { student.firstClassDate = '2026-09-10'; });
  const retry = await callStudentBatch(db, [
    lessonFor('student-a', '가학생', '초4', '2026-09-05'),
    lessonFor('student-b', '나학생', '초5', '2026-09-05')
  ]);
  assert.equal(retry.response.status, 200);
  assert.equal(retry.data.duplicateCount, 2);
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
  assert.deepEqual(db.privateRoster.roster.students.map(student => student.teacherIds), [['teacher-1'], ['teacher-2'], []]);
  assert.equal(db.privateRoster.roster.students.every(student => student.subjects.includes('국어')), true);
});

test('an exact retry repairs registered subjects without recreating existing lessons or main-teacher links', async () => {
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
  assert.deepEqual(db.privateRoster.roster.students[1].teacherIds, ['teacher-2']);
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

test('a roster CAS race aborts the batch before any lesson can be partially committed', async () => {
  const db = new FakeDB();
  db.beforeBatch = current => {
    current.privateRosterUpdatedAt += 1;
    current.privateRoster.roster.note = 'concurrent roster update';
  };
  const result = await callBatch(db, [
    { staffId: 'teacher-1', lesson: assignedLesson({ subject: '수학', className: '', lessonRole: '수학' }) },
    { staffId: 'teacher-2', lesson: assignedLesson({ subject: '영어', className: '', lessonRole: '영어' }) }
  ]);
  assert.equal(result.response.status, 409);
  assert.match(result.data.error, /원생 명단/);
  assert.equal(db.tasks.size, 0);
  assert.equal(db.privateRosterUpdatedAt, 101);
  assert.equal(db.privateRoster.roster.note, 'concurrent roster update');
  assert.equal(db.privateRoster.roster.students[0].subjects, undefined);
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
