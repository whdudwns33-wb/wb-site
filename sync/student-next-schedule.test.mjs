import assert from 'node:assert/strict';
import test from 'node:test';
import {
  lessonOccurrencesOnDate, findNextStudentLesson, projectNextStudentLesson
} from './student-next-schedule.js';

const day = '2026-09-10'; // 목요일
const regular = (id, studentId, staffId, subject, startTime, endTime = '13:50') => ({
  id, studentId, staffId, subject, taskKind: 'lesson_instruction', start: '2026-09-01',
  scheduleSlots: [{ days: [4], startTime, endTime, lessonHours: '2T' }]
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
