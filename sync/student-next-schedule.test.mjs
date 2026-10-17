import assert from 'node:assert/strict';
import test from 'node:test';
import {
  lessonOccurrencesOnDate, findNextStudentLesson, findPreviousStudentLesson, projectNextStudentLesson
} from './student-next-schedule.js';

const day = '2026-09-10'; // 목요일
const regular = (id, studentId, staffId, subject, startTime, endTime = '13:50') => ({
  id, studentId, staffId, subject, taskKind: 'lesson_instruction', start: '2026-09-01',
  scheduleSlots: [{ days: [4], startTime, endTime, lessonHours: '2T' }]
});

test('previous lesson is the closest ended same-day lesson, not another student, overlapping or expired slot', () => {
  const current = regular('current', 'student-1', 'teacher-a', '수학', '14:00', '15:00');
  const previous = regular('previous', 'student-1', 'teacher-b', '국어', '12:00', '13:50');
  const tasks = [current, previous,
    regular('earlier', 'student-1', 'teacher-c', '영어', '10:00', '11:00'),
    regular('overlap', 'student-1', 'teacher-c', '과학', '13:30', '14:30'),
    regular('other', 'student-2', 'teacher-c', '과학', '13:00', '14:00'),
    { ...previous, id: 'deleted', deleted: true },
    { ...previous, id: 'stopped', end: '2026-09-09' },
    { ...previous, id: 'future', start: '2026-09-11' },
    { ...previous, id: 'expired', scheduleSlots: [{ days: [4], startTime: '13:00', endTime: '14:00', validTo: '2026-09-09' }] }
  ];
  const result = findPreviousStudentLesson(tasks, current.id, day, { 'teacher-b': '가상 선생님' });
  assert.equal(result.taskId, 'previous');
  assert.equal(result.teacherName, '가상 선생님');
  assert.equal(findPreviousStudentLesson(tasks, 'earlier', day), null);
  assert.equal(findPreviousStudentLesson(tasks, current.id, '2026-09-11'), null);
  assert.equal(findNextStudentLesson(tasks, 'stopped', day), null);
});

test('confirmed makeup is included both ways only on its authoritative date and for matching student and teacher', () => {
  const current = regular('regular', 'student-1', 'teacher-a', '수학', '14:00', '15:00');
  const makeup = { ...regular('makeup', 'student-1', 'teacher-b', '국어', '12:00', '13:00'),
    lessonInstanceType: 'makeup', makeupCaseId: 'case-1' };
  const row = { case_id: 'case-1', student_id: 'student-1', confirmed_staff_id: 'teacher-b', status: 'confirmed',
    confirmed_start_at: day + 'T12:00:00+09:00', confirmed_end_at: day + 'T13:00:00+09:00' };
  for (const status of ['confirmed', 'completed']) {
    assert.equal(findPreviousStudentLesson([current, makeup], current.id, day, {}, [{ ...row, status }]).taskId, 'makeup');
    assert.equal(findNextStudentLesson([current, makeup], makeup.id, day, {}, [{ ...row, status }]).taskId, 'regular');
  }
  for (const change of [{ status: 'cancelled' }, { student_id: 'student-2' }, { confirmed_staff_id: 'teacher-c' },
    { confirmed_start_at: '2026-09-11T12:00:00+09:00' }]) {
    assert.equal(findPreviousStudentLesson([current, makeup], current.id, day, {}, [{ ...row, ...change }]), null);
  }
});

test('structured slots select only the requested weekday and respect validity dates', () => {
  const task = {
    id: 'lesson-1', studentId: 'student-1', taskKind: 'lesson_instruction', start: '2026-09-01',
    scheduleSlots: [
      { days: [4], startTime: '12:00', endTime: '13:20', lessonHours: '1.5T', validFrom: '2026-09-01' },
      { days: [5], startTime: '14:00', endTime: '15:50', lessonHours: '2T' }
    ]
  };
  assert.deepEqual(lessonOccurrencesOnDate(task, day), [{
    slotId: '', startTime: '12:00', endTime: '13:20', lessonHours: '1.5T'
  }]);
  assert.deepEqual(lessonOccurrencesOnDate(task, '2026-09-11'), [{
    slotId: '', startTime: '14:00', endTime: '15:50', lessonHours: '2T'
  }]);
});

test('findNextStudentLesson matches stable studentId across teachers and picks the closest later class', () => {
  const tasks = [
    regular('korean', 'student-1', 'teacher-a', '국어', '12:00', '13:20'),
    regular('math-late', 'student-1', 'teacher-c', '수학', '16:00', '17:50'),
    regular('math', 'student-1', 'teacher-b', '수학', '14:00', '15:50'),
    regular('other-student', 'student-2', 'teacher-z', '영어', '13:00', '14:50'),
    regular('earlier', 'student-1', 'teacher-b', '사회', '11:00', '11:50')
  ];
  const next = findNextStudentLesson(tasks, 'korean', day, {
    'teacher-b': '김혜지', 'teacher-c': '김남기'
  });
  assert.equal(next.taskId, 'math');
  assert.equal(next.studentId, 'student-1');
  assert.equal(next.subject, '수학');
  assert.equal(next.teacherName, '김혜지');
});

test('a later slot in the same lesson is also available as the next schedule', () => {
  const task = {
    id: 'two-slots', studentId: 'student-1', staffId: 'teacher-a', subject: '국어',
    taskKind: 'lesson_instruction', start: '2026-09-01', scheduleSlots: [
      { days: [4], startTime: '12:00', endTime: '13:20', lessonHours: '1.5T' },
      { days: [4], startTime: '14:00', endTime: '15:20', lessonHours: '1.5T' }
    ]
  };
  const next = findNextStudentLesson([task], task.id, day, { 'teacher-a': '담당' });
  assert.equal(next.taskId, task.id);
  assert.equal(next.startTime, '14:00');
});

test('legacy name-only rows and makeup rows are fail-closed', () => {
  const tasks = [
    { id: 'current', studentId: 'student-1', taskKind: 'lesson_instruction', start: day,
      repeat: 'once', time: '12:00' },
    { id: 'no-id', studentName: '같은 이름', taskKind: 'lesson_instruction', start: day,
      repeat: 'once', time: '14:00' },
    { id: 'makeup', studentId: 'student-1', taskKind: 'lesson_instruction', lessonInstanceType: 'makeup',
      start: day, scheduleSlots: [{ days: [4], startTime: '14:00', endTime: '15:00', lessonHours: '1T' }] }
  ];
  assert.equal(findNextStudentLesson(tasks, 'current', day, {}), null);
  assert.equal(findNextStudentLesson(tasks, 'missing', day, {}), null);
});

test('projectNextStudentLesson emits only the allowlisted schedule fields', () => {
  const value = projectNextStudentLesson({
    taskId: 'lesson-2', studentId: 'student-1', subject: '수학', className: '중2',
    startTime: '14:00', endTime: '15:50', lessonHours: '2T', staffId: 'teacher-b', teacherName: '김혜지',
    note: '절대 내보내면 안 됨', lessonInstanceType: 'regular'
  }, day);
  assert.deepEqual(value, {
    taskId: 'lesson-2', studentId: 'student-1', lessonDate: day, subject: '수학', className: '중2',
    startTime: '14:00', endTime: '15:50', lessonHours: '2T', staffId: 'teacher-b', teacherName: '김혜지',
    lessonInstanceType: 'regular'
  });
  assert.equal(Object.prototype.hasOwnProperty.call(value, 'note'), false);
});
