import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(
  new URL('./migrations/069_student_lesson_time_overlap.sql', import.meta.url), 'utf8'
);

function database(freshSchema = false) {
  const db = new DatabaseSync(':memory:');
  assert.ok(schema.includes(migration), 'schema.sql은 069 migration과 같은 SQL을 포함해야 합니다');
  db.exec(freshSchema ? schema : schema.replace(migration, ''));
  if (!freshSchema) db.exec(migration);
  // Wrangler가 재시도해도 기존 트리거 의미나 설치 결과가 달라지지 않아야 한다.
  db.exec(migration);
  return db;
}

function lesson(id, overrides = {}) {
  return {
    id,
    staffId: 'teacher-a',
    studentId: 'student-a',
    studentName: '테스트학생',
    subject: '수학',
    taskKind: 'lesson_instruction',
    lessonFormVersion: 1,
    scheduleStatus: 'confirmed',
    start: '2026-09-01',
    end: '',
    repeat: 'days',
    scheduleSlots: [{ days: [1], startTime: '10:00', endTime: '11:00' }],
    deleted: false,
    ...overrides
  };
}

function insertLesson(db, task) {
  db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .run('task', task.id, task.staffId || '', JSON.stringify(task), 1, 1);
}

function updateLesson(db, id, transform) {
  const row = db.prepare("SELECT data FROM tasks WHERE app='task' AND id=?").get(id);
  const next = transform(JSON.parse(row.data));
  db.prepare("UPDATE tasks SET data=?,updated_at=updated_at+1,srv_at=srv_at+1 WHERE app='task' AND id=?")
    .run(JSON.stringify(next), id);
}

function insertMakeup(db, caseId, overrides = {}) {
  const row = {
    studentId: 'student-a',
    sourceTaskId: 'source-' + caseId,
    sourceDate: '2026-09-09',
    sourceTeacherId: 'teacher-a',
    consumptionGroupId: 'group-' + caseId,
    status: 'confirmed',
    startAt: '2026-09-09T10:00:00+09:00',
    endAt: '2026-09-09T11:00:00+09:00',
    staffId: 'teacher-a',
    completedAt: null,
    completedBy: null,
    ...overrides
  };
  db.prepare(
    'INSERT INTO makeup_cases(' +
      'app,case_id,student_id,source_task_id,source_date,source_teacher_id,consumption_group_id,' +
      'status,revision,confirmed_start_at,confirmed_end_at,confirmed_staff_id,' +
      'completed_at,completed_by,history,created_at,updated_at' +
    ') VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(
    'task', caseId, row.studentId, row.sourceTaskId, row.sourceDate, row.sourceTeacherId,
    row.consumptionGroupId, row.status, 1, row.startAt, row.endAt, row.staffId,
    row.completedAt, row.completedBy, '[]', 1, 1
  );
}

test('069 migration은 기존 DB 업그레이드와 신규 schema에 동일한 view·trigger를 설치한다', () => {
  for (const db of [database(), database(true)]) {
    const objects = db.prepare(
      "SELECT type,name FROM sqlite_master WHERE name IN (" +
      "'active_regular_lesson_tasks_v1','active_regular_lesson_slots_v1'," +
      "'trg_regular_lesson_time_insert','trg_regular_lesson_time_update'," +
      "'trg_makeup_regular_time_insert','trg_makeup_regular_time_update') ORDER BY name"
    ).all();
    assert.equal(objects.length, 6);
    db.close();
  }
});

test('정규 수업끼리는 담당자와 과목이 달라도 같은 studentId의 반개구간 겹침을 차단한다', () => {
  const db = database();
  insertLesson(db, lesson('lesson-a'));

  assert.throws(() => insertLesson(db, lesson('lesson-b', {
    staffId: 'teacher-b', subject: '영어',
    scheduleSlots: [{ days: [1], startTime: '10:30', endTime: '11:30' }]
  })), /STUDENT_SCHEDULE_CONFLICT/);

  insertLesson(db, lesson('lesson-touch', {
    staffId: 'teacher-b', subject: '영어',
    scheduleSlots: [{ days: [1], startTime: '11:00', endTime: '12:00' }]
  }));
  insertLesson(db, lesson('lesson-other-student', {
    studentId: 'student-b', staffId: 'teacher-c',
    scheduleSlots: [{ days: [1], startTime: '10:30', endTime: '11:30' }]
  }));

  assert.equal(db.prepare("SELECT count(*) AS count FROM tasks WHERE app='task'").get().count, 3);
  db.close();
});

test('task와 slot 유효기간의 교집합에 해당 요일이 실제로 있을 때만 충돌한다', () => {
  const db = database();
  insertLesson(db, lesson('september', {
    start: '2026-09-01', end: '2026-09-30',
    scheduleSlots: [{
      days: [1], startTime: '10:00', endTime: '11:00',
      validFrom: '2026-09-01', validTo: '2026-09-30'
    }]
  }));
  insertLesson(db, lesson('october', {
    start: '2026-10-01', end: '2026-10-31',
    scheduleSlots: [{
      days: [1], startTime: '10:30', endTime: '11:30',
      startDate: '2026-10-01', endDate: '2026-10-31'
    }]
  }));

  // 2026-09-01은 화요일이므로 월요일 slot은 이 하루짜리 범위에서 발생하지 않는다.
  insertLesson(db, lesson('no-monday-in-range-a', {
    studentId: 'student-c', start: '2026-09-01', end: '2026-09-01',
    scheduleSlots: [{ days: [1], startTime: '10:00', endTime: '11:00' }]
  }));
  insertLesson(db, lesson('no-monday-in-range-b', {
    studentId: 'student-c', start: '2026-09-01', end: '2026-09-01',
    scheduleSlots: [{ days: [1], startTime: '10:30', endTime: '11:30' }]
  }));

  insertLesson(db, lesson('task-date-alias-a', {
    studentId: 'student-d', start: '', end: '', startDate: '2026-09-01', endDate: '2026-09-30'
  }));
  insertLesson(db, lesson('task-date-alias-b', {
    studentId: 'student-d', start: '', end: '', startDate: '2026-10-01', endDate: '2026-10-31',
    scheduleSlots: [{ days: [1], startTime: '10:30', endTime: '11:30' }]
  }));

  assert.equal(db.prepare("SELECT count(*) AS count FROM tasks WHERE app='task'").get().count, 6);
  db.close();
});

test('1회 수업은 start 당일만 활성이고 삭제·기간 종료 정규 수업은 충돌 대상이 아니다', () => {
  const db = database();
  insertLesson(db, lesson('once-before', {
    repeat: 'once', start: '2026-09-07', end: '',
    scheduleSlots: [{ days: [1], startTime: '10:00', endTime: '11:00' }]
  }));
  insertLesson(db, lesson('week-after', {
    start: '2026-09-14',
    scheduleSlots: [{ days: [1], startTime: '10:30', endTime: '11:30' }]
  }));
  insertLesson(db, lesson('deleted', {
    studentId: 'student-b', deleted: true,
    scheduleSlots: [{ days: [1], startTime: '10:00', endTime: '11:00' }]
  }));
  insertLesson(db, lesson('after-deleted', {
    studentId: 'student-b',
    scheduleSlots: [{ days: [1], startTime: '10:30', endTime: '11:30' }]
  }));
  insertLesson(db, lesson('ended', {
    studentId: 'student-c', start: '2026-08-01', end: '2026-08-31',
    scheduleSlots: [{ days: [1], startTime: '10:00', endTime: '11:00' }]
  }));
  insertLesson(db, lesson('after-ended', {
    studentId: 'student-c', start: '2026-09-01',
    scheduleSlots: [{ days: [1], startTime: '10:30', endTime: '11:30' }]
  }));

  assert.equal(db.prepare("SELECT count(*) AS count FROM tasks WHERE app='task'").get().count, 6);
  db.close();
});

test('정규 수업을 기존 정규 수업과 겹치도록 수정하면 UPDATE 전체가 롤백된다', () => {
  const db = database();
  insertLesson(db, lesson('lesson-a'));
  insertLesson(db, lesson('lesson-b', {
    staffId: 'teacher-b',
    scheduleSlots: [{ days: [1], startTime: '12:00', endTime: '13:00' }]
  }));

  assert.throws(() => updateLesson(db, 'lesson-b', task => ({
    ...task,
    scheduleSlots: [{ days: [1], startTime: '10:30', endTime: '11:30' }]
  })), /STUDENT_SCHEDULE_CONFLICT/);
  const stored = JSON.parse(db.prepare("SELECT data FROM tasks WHERE app='task' AND id='lesson-b'").get().data);
  assert.equal(stored.scheduleSlots[0].startTime, '12:00');
  db.close();
});

test('정규 수업 뒤 확정·완료 보강 INSERT와 UPDATE를 모두 차단한다', () => {
  for (const status of ['confirmed', 'completed']) {
    const db = database();
    insertLesson(db, lesson('regular', {
      scheduleSlots: [{ days: [3], startTime: '10:00', endTime: '11:00' }]
    }));
    assert.throws(() => insertMakeup(db, 'makeup-' + status, {
      status,
      completedAt: status === 'completed' ? 2 : null,
      completedBy: status === 'completed' ? 'teacher-a' : null
    }), /STUDENT_SCHEDULE_CONFLICT/);
    db.close();
  }

  const db = database();
  insertLesson(db, lesson('regular', {
    scheduleSlots: [{ days: [3], startTime: '10:00', endTime: '11:00' }]
  }));
  insertMakeup(db, 'reviewed', { status: 'reviewed' });
  assert.throws(() => db.prepare(
    "UPDATE makeup_cases SET status='confirmed' WHERE app='task' AND case_id='reviewed'"
  ).run(), /STUDENT_SCHEDULE_CONFLICT/);
  db.close();
});

test('확정·완료 보강 뒤 정규 수업 INSERT도 차단하고 제안 단계 보강은 제외한다', () => {
  const db = database();
  insertMakeup(db, 'confirmed');
  assert.throws(() => insertLesson(db, lesson('regular', {
    scheduleSlots: [{ days: [3], startTime: '10:30', endTime: '11:30' }]
  })), /STUDENT_MAKEUP_CONFLICT/);

  insertMakeup(db, 'reviewed', {
    studentId: 'student-b', status: 'reviewed', sourceTaskId: 'source-reviewed'
  });
  insertLesson(db, lesson('regular-for-reviewed', {
    studentId: 'student-b',
    scheduleSlots: [{ days: [3], startTime: '10:30', endTime: '11:30' }]
  }));
  db.close();
});

test('needs_review·빈·손상 slot은 겹치는 같은 학생 원장이 있으면 fail-closed 한다', () => {
  for (const uncertain of [
    { scheduleStatus: 'needs_review', scheduleSlots: [] },
    { scheduleStatus: 'confirmed', scheduleSlots: [] },
    { scheduleStatus: 'confirmed', scheduleSlots: [{ days: [1], startTime: '잘못', endTime: '11:00' }] },
    { scheduleStatus: 'confirmed', scheduleSlots: [{
      days: [1], startTime: '10:00', endTime: '11:00', validFrom: '2026-02-30'
    }] },
    { scheduleStatus: 'confirmed', scheduleSlots: [{
      days: [1], startTime: '10:00', endTime: '11:00', status: 'needs_review'
    }] }
  ]) {
    const db = database();
    insertLesson(db, lesson('confirmed'));
    assert.throws(() => insertLesson(db, lesson('uncertain', {
      staffId: 'teacher-b', subject: '영어', ...uncertain
    })), /SCHEDULE_UNCONFIRMED/);
    db.close();
  }

  const reverse = database();
  insertLesson(reverse, lesson('uncertain-first', {
    scheduleStatus: 'needs_review', scheduleSlots: []
  }));
  assert.throws(() => insertLesson(reverse, lesson('confirmed-after', {
    staffId: 'teacher-b', subject: '영어'
  })), /SCHEDULE_UNCONFIRMED/);
  reverse.close();

  const disjoint = database();
  insertLesson(disjoint, lesson('ended-uncertain', {
    start: '2026-08-01', end: '2026-08-31', scheduleStatus: 'needs_review', scheduleSlots: []
  }));
  insertLesson(disjoint, lesson('later-confirmed', { start: '2026-09-01' }));
  disjoint.close();
});

test('scheduleStatus 변경도 UPDATE signature에 포함되어 미확정 우회를 롤백한다', () => {
  const db = database();
  insertLesson(db, lesson('morning'));
  insertLesson(db, lesson('afternoon', {
    scheduleSlots: [{ days: [1], startTime: '12:00', endTime: '13:00' }]
  }));

  assert.throws(() => updateLesson(db, 'afternoon', task => ({
    ...task, scheduleStatus: 'needs_review'
  })), /SCHEDULE_UNCONFIRMED/);
  assert.equal(JSON.parse(db.prepare("SELECT data FROM tasks WHERE id='afternoon'").get().data).scheduleStatus,
    'confirmed');
  db.close();
});

test('한 후보 task 내부의 실제로 겹치는 slot 쌍을 차단하고 경계·기간 분리는 허용한다', () => {
  const blocked = database();
  assert.throws(() => insertLesson(blocked, lesson('self-overlap', {
    scheduleSlots: [
      { days: [1], startTime: '10:00', endTime: '11:00' },
      { days: [1], startTime: '10:30', endTime: '11:30' }
    ]
  })), /STUDENT_SCHEDULE_CONFLICT/);
  blocked.close();

  const allowed = database();
  insertLesson(allowed, lesson('self-touch', {
    scheduleSlots: [
      { days: [1], startTime: '10:00', endTime: '11:00' },
      { days: [1], startTime: '11:00', endTime: '12:00' }
    ]
  }));
  insertLesson(allowed, lesson('self-disjoint-validity', {
    studentId: 'student-b',
    scheduleSlots: [
      { days: [1], startTime: '10:00', endTime: '11:00', validTo: '2026-09-30' },
      { days: [1], startTime: '10:30', endTime: '11:30', validFrom: '2026-10-01' }
    ]
  }));
  allowed.close();
});

test('확정 보강과 미확정 정규 수업의 양방향 등록을 SCHEDULE_UNCONFIRMED로 차단한다', () => {
  const regularFirst = database();
  insertLesson(regularFirst, lesson('unknown', {
    scheduleStatus: 'needs_review', scheduleSlots: []
  }));
  assert.throws(() => insertMakeup(regularFirst, 'blocked-makeup'), /SCHEDULE_UNCONFIRMED/);
  regularFirst.close();

  const makeupFirst = database();
  insertMakeup(makeupFirst, 'existing-makeup');
  assert.throws(() => insertLesson(makeupFirst, lesson('blocked-regular', {
    scheduleStatus: 'needs_review', scheduleSlots: []
  })), /SCHEDULE_UNCONFIRMED/);
  makeupFirst.close();
});

test('정규 수업과 보강도 끝 시간이 시작 시간에 닿는 경계는 허용한다', () => {
  const db = database();
  insertLesson(db, lesson('regular', {
    scheduleSlots: [{ days: [3], startTime: '10:00', endTime: '11:00' }]
  }));
  insertMakeup(db, 'touch-after', {
    startAt: '2026-09-09T11:00:00+09:00',
    endAt: '2026-09-09T12:00:00+09:00'
  });
  insertMakeup(db, 'touch-before', {
    studentId: 'student-b',
    startAt: '2026-09-09T09:00:00+09:00',
    endAt: '2026-09-09T10:00:00+09:00'
  });
  insertLesson(db, lesson('regular-student-b', {
    studentId: 'student-b',
    scheduleSlots: [{ days: [3], startTime: '10:00', endTime: '11:00' }]
  }));
  db.close();
});

test('생성된 보강 task는 정규 수업으로 이중 계산하지 않는다', () => {
  const db = database();
  insertMakeup(db, 'projection');
  insertLesson(db, lesson('makeup_lesson_projection', {
    lessonInstanceType: 'makeup',
    makeupCaseId: 'projection',
    repeat: 'once',
    start: '2026-09-09',
    end: '',
    scheduleSlots: [{
      days: [3], startTime: '10:00', endTime: '11:00',
      validFrom: '2026-09-09', validTo: '2026-09-09'
    }]
  }));

  const slots = db.prepare(
    "SELECT count(*) AS count FROM active_regular_lesson_slots_v1 WHERE task_id='makeup_lesson_projection'"
  ).get();
  assert.equal(slots.count, 0);
  db.close();
});

test('0 버전이나 제목 접두어만 있는 일반 task는 DB의 구조화 수업 판정을 가장하지 못한다', () => {
  const db = database();
  insertLesson(db, lesson('markerless', {
    taskKind: '', lessonFormVersion: 0, intakeVersion: '0', intakeSource: '', title: '[수업] 위조'
  }));
  insertLesson(db, lesson('real-lesson'));
  assert.equal(db.prepare(
    "SELECT count(*) AS count FROM active_regular_lesson_tasks_v1 WHERE task_id='markerless'"
  ).get().count, 0);
  db.close();
});

test('migration 066의 같은 학생 보강↔보강 차단과 다른 학생 허용 의미를 유지한다', () => {
  const db = database();
  insertMakeup(db, 'makeup-a');
  assert.throws(() => insertMakeup(db, 'makeup-b', {
    staffId: 'teacher-b', sourceTaskId: 'source-b'
  }), /MAKEUP_TIME_CONFLICT/);
  insertMakeup(db, 'makeup-other-student', {
    studentId: 'student-b', staffId: 'teacher-a', sourceTaskId: 'source-other'
  });
  insertMakeup(db, 'makeup-touch', {
    staffId: 'teacher-b', sourceTaskId: 'source-touch',
    startAt: '2026-09-09T11:00:00+09:00',
    endAt: '2026-09-09T12:00:00+09:00'
  });
  db.close();
});
