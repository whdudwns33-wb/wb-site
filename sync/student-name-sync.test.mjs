import assert from 'node:assert/strict';
import test from 'node:test';
import { renamedLessonTask } from './student-name-sync.js';
test('rename changes only the same-ID lesson name snapshot, preserving records and schedule', () => {
  const task = { id: 'lesson-a', studentId: '12345678', studentName: '가학생',
    title: '[수업] 가학생 (초3) — 수학', taskKind: 'lesson_instruction', staffId: 'teacher-a',
    start: '2026-01-01', time: '10:00', memo: '가학생 이전 기록', updatedAt: 1 };
  const renamed = renamedLessonTask(task, '12345678', '가학생', '나학생', 2);
  assert.deepEqual(renamed, { ...task, studentName: '나학생', title: '[수업] 나학생 (초3) — 수학', updatedAt: 2 });
  assert.equal(task.studentName, '가학생');
  assert.equal(renamedLessonTask(task, '99999999', '가학생', '나학생', 2), null);
  assert.equal(renamedLessonTask({ ...task, deleted: true }, '12345678', '가학생', '나학생', 2), null);
  assert.equal(renamedLessonTask({ ...task, taskKind: 'general' }, '12345678', '가학생', '나학생', 2), null);
  const prefix = renamedLessonTask({ ...task, title: '[수업] 가학생동명 — 수학' }, '12345678', '가학생', '나학생', 2);
  assert.equal(prefix.title, '[수업] 가학생동명 — 수학');
});
