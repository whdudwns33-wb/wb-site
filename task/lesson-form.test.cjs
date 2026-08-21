const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('./lesson-form-core.js');

function validInput(overrides = {}) {
  return Object.assign({
    staffId: 'teacher-1',
    studentName: '테스트학생',
    grade: '초4',
    subject: '국어',
    className: '비문학',
    lessonRole: '독해력',
    lessonHours: '2T',
    scheduleText: '월, 수 17:00-19:00 / 일요일 12:00-14:00',
    materials: '초등 문해력 독해가 힘이다 / 3주 4일',
    onlineProgram: '없음',
    homework: '없음',
    studentTraits: '궁금한 점을 잘 질문함',
    goal: '교재 빠르게 마무리',
    parentRequest: '없음',
    adminRequest: '수업 후 진도표 확인'
  }, overrides);
}

test('exports a CommonJS/browser-friendly lesson form core', () => {
  assert.equal(typeof core.validateLessonInput, 'function');
  assert.equal(typeof core.resolveSchedule, 'function');
  assert.equal(typeof core.buildLessonTaskBody, 'function');
});

test('validates every teacher-input group including hours on each confirmed time without treating 없음 as blank', () => {
  const valid = core.validateLessonInput(validInput());
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.errors, []);

  const cases = [
    [{ studentName: '' }, 'student'],
    [{ grade: '' }, 'student'],
    [{ subject: '', className: '' }, 'subjectClass'],
    [{ scheduleText: '', scheduleSlots: [] }, 'schedule'],
    [{ materials: '' }, 'materials'],
    [{ onlineProgram: '' }, 'onlineProgram'],
    [{ homework: '' }, 'homework'],
    [{ studentTraits: '' }, 'studentTraits'],
    [{ goal: '' }, 'goal'],
    [{ parentRequest: '' }, 'parentRequest']
  ];
  cases.forEach(([overrides, field]) => {
    const result = core.validateLessonInput(validInput(overrides));
    assert.equal(result.valid, false, field);
    assert.ok(result.errors.some(item => item.field === field), field);
  });

  const missingHours = core.validateLessonInput(validInput({
    lessonHours: '', scheduleText: '',
    scheduleSlots: [{ days: [1], startTime: '17:00', endTime: '19:00', lessonHours: '' }]
  }));
  assert.equal(missingHours.valid, false);
  assert.ok(missingHours.errors.some(item => item.field === 'schedule'));
});

test('accepts only the fixed lesson-hour choices on each confirmed time', () => {
  for (const lessonHours of core.LESSON_HOURS) {
    assert.equal(core.validateLessonInput(validInput({
      lessonHours: '', scheduleText: '',
      scheduleSlots: [{ days: [1], startTime: '17:00', endTime: '19:00', lessonHours }]
    })).valid, true, lessonHours);
  }
  for (const lessonHours of ['50분', '1.6T', '2시간', '7T']) {
    const result = core.validateLessonInput(validInput({
      lessonHours: '', scheduleText: '',
      scheduleSlots: [{ days: [1], startTime: '17:00', endTime: '19:00', lessonHours }]
    }));
    assert.equal(result.valid, false, lessonHours);
    assert.ok(result.errors.some(item => item.field === 'schedule'), lessonHours);
  }
});

test('parses only unambiguous free-text day and clock ranges', () => {
  const result = core.resolveSchedule(validInput());
  assert.equal(result.scheduleStatus, 'normal');
  assert.deepEqual(result.scheduleSlots, [
    {
      slotId: 'slot-2', days: [0], startTime: '12:00', endTime: '14:00',
      lessonHours: '2T', lessonRole: '', validFrom: '', validTo: ''
    },
    {
      slotId: 'slot-1', days: [1, 3], startTime: '17:00', endTime: '19:00',
      lessonHours: '2T', lessonRole: '', validFrom: '', validTo: ''
    }
  ]);
});

test('holds incomplete or conflicting prose schedules for review instead of guessing', () => {
  const ambiguous = [
    '월수금 18:00-19:50, 월수 2시간/ 금 1시간',
    '월화수목금 18:00-20:50, 월',
    '일요일 10시, 2시간'
  ];
  ambiguous.forEach(scheduleText => {
    const result = core.resolveSchedule(validInput({ scheduleText }));
    assert.equal(result.scheduleStatus, 'needs_review', scheduleText);
    assert.deepEqual(result.scheduleSlots, [], scheduleText);
    assert.ok(result.issues.length > 0, scheduleText);
  });
});

test('supports explicit multi-slot UI rows and derives legacy repeat fields', () => {
  const input = validInput({
    scheduleText: '월수 18:00-19:50 / 금 18:00-19:00',
    scheduleSlots: [
      { days: [1, 3], startTime: '18:00', endTime: '19:50', lessonRole: '블렌디드' },
      { days: [5], startTime: '18:00', endTime: '19:00', lessonRole: '블렌디드' }
    ]
  });
  const body = core.buildLessonTaskBody(input, { start: '2026-08-04' });

  assert.equal(body.scheduleStatus, 'normal');
  assert.equal(body.scheduleSlots.length, 2);
  assert.deepEqual(body.days, [1, 3, 5]);
  assert.equal(body.repeat, 'days');
  assert.equal(body.time, '18:00');
  assert.equal(body.start, '2026-08-04');
});

test('structured rows are authoritative over legacy schedule text', () => {
  const mismatch = core.resolveSchedule(validInput({
    scheduleText: '월수 18:00-19:50 / 금 18:00-19:00',
    scheduleSlots: [{ days: [1, 3], startTime: '18:00', endTime: '19:50' }]
  }));
  assert.equal(mismatch.scheduleStatus, 'normal');
  assert.deepEqual(mismatch.scheduleSlots.map(slot => [slot.days, slot.startTime, slot.endTime]), [
    [[1, 3], '18:00', '19:50']
  ]);
  assert.deepEqual(mismatch.issues, []);

  const ambiguous = core.resolveSchedule(validInput({
    scheduleText: '월수금 18:00-19:50, 월수 2시간/ 금 1시간',
    scheduleSlots: [
      { days: [1, 3], startTime: '18:00', endTime: '19:50' },
      { days: [5], startTime: '18:00', endTime: '19:00' }
    ]
  }));
  assert.equal(ambiguous.scheduleStatus, 'normal');
  assert.equal(ambiguous.scheduleSlots.length, 2);

  const body = core.buildLessonTaskBody(validInput({
    scheduleText: '토 10:00-11:50',
    scheduleSlots: [{ days: [0, 6], startTime: '10:00', endTime: '11:50' }]
  }), { start: '2026-08-21' });
  assert.equal(body.scheduleText, '토·일 10:00-11:50 · 2T');
  assert.equal(body.scheduleStatus, 'normal');
});

test('structured-only schedule derives a readable schedule text', () => {
  const body = core.buildLessonTaskBody(validInput({
    scheduleText: '',
    scheduleSlots: [{ days: [1, 3], startTime: '17:00', endTime: '19:00' }]
  }), { start: '2026-08-04' });
  assert.equal(body.scheduleStatus, 'normal');
  assert.equal(body.scheduleText, '월·수 17:00-19:00 · 2T');
  assert.match(body.detail, /월·수 17:00-19:00 · 2T/);
});

test('groups equal confirmed times and separates different times with their own lesson hours', () => {
  const body = core.buildLessonTaskBody(validInput({
    lessonHours: '', scheduleText: '',
    scheduleSlots: [
      { days: [1], startTime: '18:00', endTime: '19:50', lessonHours: '2T' },
      { days: [3], startTime: '18:00', endTime: '19:50', lessonHours: '2T' },
      { days: [5], startTime: '20:00', endTime: '20:50', lessonHours: '1T' }
    ]
  }), { start: '2026-08-21' });

  assert.equal(body.scheduleText, '월·수 18:00-19:50 · 2T / 금 20:00-20:50 · 1T');
  assert.equal(body.lessonHours, '');
  assert.deepEqual(body.scheduleSlots.map(slot => [slot.days, slot.lessonHours]), [
    [[1], '2T'], [[3], '2T'], [[5], '1T']
  ]);
});

test('rejects overlapping structured rows as one needs-review schedule', () => {
  const result = core.resolveSchedule(validInput({
    scheduleSlots: [
      { days: [1], startTime: '18:00', endTime: '19:00' },
      { days: [1], startTime: '18:30', endTime: '19:30' }
    ]
  }));
  assert.equal(result.scheduleStatus, 'needs_review');
  assert.deepEqual(result.scheduleSlots, []);
  assert.ok(result.issues.some(item => item.code === 'overlapping_slots'));
});

test('dedupe identity ignores harmless whitespace but separates grades and teachers', () => {
  const first = core.buildDedupeIdentity(validInput(), { staffId: 'teacher-1' });
  const spacingOnly = core.buildDedupeIdentity(validInput({
    studentName: ' 테 스 트 학 생 ',
    grade: ' 초 4 ',
    subject: ' 국어 '
  }), { staffId: 'teacher-1' });
  const otherGrade = core.buildDedupeIdentity(validInput({ grade: '초5' }), { staffId: 'teacher-1' });
  const otherTeacher = core.buildDedupeIdentity(validInput(), { staffId: 'teacher-2' });

  assert.equal(first, spacingOnly);
  assert.notEqual(first, otherGrade);
  assert.notEqual(first, otherTeacher);
  assert.equal(first, 'lesson:v1:82baa8dd85f36413');
  assert.match(first, /^lesson:v1:[a-f0-9]{16}$/);
});

test('stable student id survives normalization and replaces mutable name-grade identity', () => {
  const input = validInput({ studentId: ' student_123-A ' });
  const normalized = core.normalizeLessonInput(input);
  const first = core.buildDedupeIdentity(input, { staffId: 'teacher-1' });
  const renamed = core.buildDedupeIdentity(validInput({
    studentId: 'student_123-A', studentName: '개명학생', grade: '중2'
  }), { staffId: 'teacher-1' });
  const otherStudent = core.buildDedupeIdentity(validInput({ studentId: 'student_124-A' }), { staffId: 'teacher-1' });
  const body = core.buildLessonTaskBody(input, { staffId: 'teacher-1', start: '2026-08-04' });

  assert.equal(normalized.studentId, 'student_123-A');
  assert.equal(body.studentId, 'student_123-A');
  assert.equal(first, renamed);
  assert.notEqual(first, otherStudent);
});

test('optional student id must be a safe id when supplied', () => {
  const validation = core.validateLessonInput(validInput({ studentId: 'student id!' }));
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(item => item.field === 'studentId'));
  assert.throws(
    () => core.buildLessonTaskBody(validInput({ studentId: 'student id!' }), { start: '2026-08-04' }),
    error => error && error.code === 'LESSON_FORM_INVALID' &&
      error.validationErrors.some(item => item.field === 'studentId')
  );
});

test('builds a deterministic task body with current task-app compatibility fields', () => {
  const input = validInput();
  const first = core.buildLessonTaskBody(input, { staffId: 'teacher-1', start: '2026-08-04' });
  const second = core.buildLessonTaskBody(input, { staffId: 'teacher-1', start: '2026-08-04' });

  assert.deepEqual(first, second);
  assert.equal(first.title, '[수업] 테스트학생 (초4) — 국어 · 비문학');
  assert.equal(first.lessonHours, '2T');
  assert.match(first.detail, /교재와 현재 진도:/);
  assert.match(first.guide, /특이사항·학부모 요청:/);
  assert.match(first.guide, /관리자 요청사항: 수업 후 진도표 확인/);
  assert.equal(first.adminRequest, '수업 후 진도표 확인');
  assert.deepEqual(first.steps.map(step => step.id), ['lesson-progress', 'lesson-homework', 'lesson-goal']);
  assert.equal(first.repeat, 'days');
  assert.deepEqual(first.days, [0, 1, 3]);
  assert.equal(first.time, '');
  assert.equal(first.carry, true);
  assert.equal(first.intakeSource, 'teacher_9_field_form');
  assert.equal(first.intakeVersion, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(first, 'createdAt'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(first, 'updatedAt'), false);
});

test('invalid forms fail before a task body can be created', () => {
  assert.throws(
    () => core.buildLessonTaskBody(validInput({ studentTraits: '' })),
    error => error && error.code === 'LESSON_FORM_INVALID' &&
      error.validationErrors.some(item => item.field === 'studentTraits')
  );
});
