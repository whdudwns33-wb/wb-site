import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertStudentScheduleSnapshot,
  isRegularLessonScheduleTask,
  studentScheduleConflictPayload
} from './student-schedule-conflict.js';

function lesson(overrides = {}) {
  return {
    id: 'lesson-a', staffId: 'teacher-a', studentId: 'student-a', taskKind: 'lesson_instruction',
    lessonFormVersion: 1, deleted: false, repeat: 'days', days: [1], start: '2026-09-01', end: '',
    scheduleStatus: 'confirmed',
    scheduleSlots: [{ days: [1], startTime: '16:00', endTime: '17:00', validFrom: '2026-09-01' }],
    ...overrides
  };
}

function stored(task) {
  return { id: task.id, owner: task.staffId, data: JSON.stringify(task) };
}

function makeup(overrides = {}) {
  return {
    case_id: 'mu-a', student_id: 'student-a', status: 'confirmed',
    confirmed_start_at: '2026-09-07T16:30:00+09:00',
    confirmed_end_at: '2026-09-07T17:30:00+09:00',
    ...overrides
  };
}

function conflictCode(callback) {
  try { callback(); }
  catch (error) {
    assert.equal(error.status, 409);
    return error.code;
  }
  assert.fail('충돌 오류가 필요합니다');
}

test('같은 studentId의 정규수업은 담당자·과목과 무관하게 실제 겹치는 시간만 차단한다', () => {
  const candidate = lesson({ id: 'lesson-new', staffId: 'teacher-new', subject: '영어' });
  const current = lesson({ id: 'lesson-old', staffId: 'teacher-old', subject: '수학',
    scheduleSlots: [{ days: [1], startTime: '16:30', endTime: '17:30', validFrom: '2026-09-01' }] });
  assert.equal(conflictCode(() => assertStudentScheduleSnapshot([candidate], [stored(current)], [])),
    'STUDENT_SCHEDULE_CONFLICT');

  assert.doesNotThrow(() => assertStudentScheduleSnapshot([
    lesson({ id: 'touching', scheduleSlots: [{ days: [1], startTime: '17:30', endTime: '18:30' }] })
  ], [stored(current)], []), '종료와 시작이 맞닿기만 하면 허용한다');
  assert.doesNotThrow(() => assertStudentScheduleSnapshot([
    lesson({ id: 'other-day', scheduleSlots: [{ days: [2], startTime: '16:30', endTime: '17:30' }] })
  ], [stored(current)], []), '요일이 다르면 허용한다');
});

test('정규수업 시간 겹침은 수업 및 slot 적용 기간이 실제로 겹칠 때만 차단한다', () => {
  const current = lesson({ id: 'old', start: '2026-01-01', end: '2026-08-31',
    scheduleSlots: [{ days: [1], startTime: '16:00', endTime: '18:00', validFrom: '2026-01-01' }] });
  assert.doesNotThrow(() => assertStudentScheduleSnapshot([
    lesson({ id: 'new', start: '2026-09-01' })
  ], [stored(current)], []));

  const slotHistory = lesson({ id: 'history', start: '2026-01-01',
    scheduleSlots: [{ days: [1], startTime: '16:00', endTime: '18:00',
      validFrom: '2026-01-01', validTo: '2026-08-31' }] });
  assert.doesNotThrow(() => assertStudentScheduleSnapshot([
    lesson({ id: 'new-slot', start: '2026-09-01' })
  ], [stored(slotHistory)], []));

  const once = lesson({ id: 'once', repeat: 'once', start: '2026-09-07',
    scheduleSlots: [{ days: [1], startTime: '16:00', endTime: '18:00' }] });
  assert.doesNotThrow(() => assertStudentScheduleSnapshot([
    lesson({ id: 'later', start: '2026-09-14' })
  ], [stored(once)], []), '1회 수업은 시작일 이후 매주 반복되는 것으로 보지 않는다');
});

test('같은 task id를 고치는 것과 담당자만 넘기는 것은 자기 자신과 충돌하지 않는다', () => {
  const before = lesson({ id: 'same', staffId: 'teacher-old' });
  const after = lesson({ id: 'same', staffId: 'teacher-new' });
  assert.doesNotThrow(() => assertStudentScheduleSnapshot([after], [stored(before)], []));
});

test('확정·완료 보강과 같은 학생의 정규수업이 겹치면 차단하고 다른 학생 및 취소 보강은 허용한다', () => {
  const candidate = lesson({ id: 'lesson-new' });
  assert.equal(conflictCode(() => assertStudentScheduleSnapshot([candidate], [], [makeup()])),
    'STUDENT_MAKEUP_CONFLICT');
  assert.equal(conflictCode(() => assertStudentScheduleSnapshot([candidate], [], [makeup({ status: 'completed' })])),
    'STUDENT_MAKEUP_CONFLICT');
  assert.doesNotThrow(() => assertStudentScheduleSnapshot([candidate], [], [makeup({ student_id: 'student-b' })]));
  assert.doesNotThrow(() => assertStudentScheduleSnapshot([candidate], [], [makeup({ status: 'cancelled' })]));
});

test('겹칠 수 있는 문장형·미확정 수업은 추측하지 않고 fail-closed 한다', () => {
  const candidate = lesson({ id: 'new' });
  const unknown = lesson({ id: 'legacy', scheduleStatus: 'needs_review', scheduleSlots: [],
    repeat: 'once', scheduleText: '월요일 오후' });
  assert.equal(conflictCode(() => assertStudentScheduleSnapshot([candidate], [stored(unknown)], [])),
    'SCHEDULE_UNCONFIRMED');

  const endedUnknown = { ...unknown, start: '2026-01-01', end: '2026-08-31' };
  assert.doesNotThrow(() => assertStudentScheduleSnapshot([candidate], [stored(endedUnknown)], []));
});

test('한 batch 안에서 다른 담당자로 만든 같은 학생 수업도 서로 검사한다', () => {
  const first = lesson({ id: 'first', staffId: 'teacher-a' });
  const second = lesson({ id: 'second', staffId: 'teacher-b', subject: '영어',
    scheduleSlots: [{ days: [1], startTime: '16:30', endTime: '17:30' }] });
  assert.equal(conflictCode(() => assertStudentScheduleSnapshot([first, second], [], [])),
    'STUDENT_SCHEDULE_CONFLICT');
});

test('slot 자체의 미확정 상태와 candidate 내부 겹침도 우회시키지 않는다', () => {
  const uncertain = lesson({ id: 'uncertain', scheduleSlots: [
    { days: [1], startTime: '16:00', endTime: '17:00', status: 'needs_review' }
  ] });
  assert.equal(conflictCode(() => assertStudentScheduleSnapshot([
    lesson({ id: 'other' })
  ], [stored(uncertain)], [])), 'SCHEDULE_UNCONFIRMED');

  const selfOverlap = lesson({ id: 'self-overlap', scheduleSlots: [
    { days: [1], startTime: '16:00', endTime: '17:00' },
    { days: [1], startTime: '16:30', endTime: '17:30' }
  ] });
  assert.equal(conflictCode(() => assertStudentScheduleSnapshot([selfOverlap], [], [])),
    'STUDENT_SCHEDULE_CONFLICT');
});

test('생성된 보강 task는 정규수업으로 중복 판정하지 않고 오류 문자열은 안전한 409 payload로 매핑한다', () => {
  const generated = lesson({ id: 'makeup-task', lessonInstanceType: 'makeup', makeupCaseId: 'mu-a' });
  assert.equal(isRegularLessonScheduleTask(generated), false);
  assert.doesNotThrow(() => assertStudentScheduleSnapshot([lesson({ id: 'new' })], [stored(generated)], []));

  assert.deepEqual(studentScheduleConflictPayload(new Error('D1_ERROR: STUDENT_SCHEDULE_CONFLICT')), {
    ok: false,
    code: 'STUDENT_SCHEDULE_CONFLICT',
    error: '같은 학생의 정규 수업과 시간이 겹칩니다. 기존 수업 시간을 확인해 주세요'
  });
  assert.equal(studentScheduleConflictPayload(new Error('unrelated')), null);
});

test('0 버전이나 제목 접두어만 있는 일반 task는 구조화 수업으로 가장할 수 없다', () => {
  const markerless = lesson({
    taskKind: '', lessonFormVersion: 0, intakeVersion: '0', intakeSource: '', title: '[수업] 위조'
  });
  assert.equal(isRegularLessonScheduleTask(markerless), false);
});
