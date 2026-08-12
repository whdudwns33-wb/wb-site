const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const source = fs.readFileSync(require('node:path').join(__dirname, 'index.html'), 'utf8');

test('personal lesson entry requires selecting an assigned stable student', () => {
  assert.match(source, /function assignedLessonStudents\(\)/);
  assert.match(source, /data-lesson-student/);
  assert.match(source, /내 담당 학생을 선택해 주세요/);
  assert.match(source, /draft\.studentId = student \? student\.id : ''/);
});

test('empty personal roster offers a director-approved assignment request', () => {
  assert.match(source, /담당 학생 배정 요청/);
  assert.match(source, /\/lesson-assignment-request/);
  assert.match(source, /\/lesson-assignment-review/);
  assert.match(source, /data-lar-student/);
  assert.match(source, /담당 학생을 연결했습니다/);
});

test('review shows teacher names and every active roster student with explicit mismatch confirmation', () => {
  assert.match(source, /요청 선생님: /);
  assert.doesNotMatch(source, /요청 선생님 ID:/);
  assert.match(source, /그 외 현재 재원생/);
  assert.match(source, /body\.confirmIdentityMismatch = true/);
  assert.match(source, /같은 학생이 맞습니까/);
});
