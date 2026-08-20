const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('teacher lesson request exposes assignment, withdrawal, leave, and deletion choices with dates', () => {
  const start = source.indexOf('function lessonChangeModal(');
  const end = source.indexOf('async function submitLessonChange', start);
  const block = source.slice(start, end);
  for (const text of ['담당선생님 변경', '퇴원', '휴원', '수업삭제', 'lcEffectiveDate']) assert.match(block, new RegExp(text));
  assert.match(source, /case 'lcoperation': setLessonChangeOperation/);
  assert.match(source, /\['teacher_assignment', 'withdrawal', 'leave', 'lesson_delete'\]\.includes\(lcForm\.operation\)/);
  assert.match(source, /data-lc-date-label/);
  assert.match(source, /변경 시작일/);
});

test('담당선생님 변경 이력은 선택한 변경 시작일을 학생 정보에 표시한다', () => {
  assert.match(source, /event\.effectiveDate \? event\.effectiveDate \+ '부터 · '/);
  assert.match(source, /변경 시작일: ' \+/);
});

test('admin review selects an active teacher and sends selectedStaffId only on approval', () => {
  assert.match(source, /data-lc-teacher data-key=/);
  assert.match(source, /liveStaff\(\)\.filter/);
  assert.match(source, /body\.selectedStaffId/);
  assert.match(source, /변경할 담당 선생님을 선택해 주세요/);
});

test('student information request and independent change acknowledgement are available from the popup', () => {
  assert.match(source, /data-act="studentinforequest"/);
  assert.match(source, /data-student-info-request/);
  assert.match(source, /operation: 'information_request'/);
  assert.match(source, /data-act="studentchangeack"/);
  assert.match(source, /수정내용확인/);
  assert.match(source, /action: 'acknowledge', studentId: String\(studentId\)/);
});

test('plain red N is rendered for pending student or work-instruction fields and disappears without pending events', () => {
  assert.match(source, /\.new-marker \{[^}]*color:#D92D20/);
  assert.doesNotMatch(source, /\.new-marker \{[^}]*border-radius:50%/);
  assert.doesNotMatch(source, /\.new-marker \{[^}]*background:#D92D20/);
  assert.match(source, /\.lesson-card-tab\.has-new::after \{[^}]*content:'N'[^}]*color:#D92D20/);
  assert.doesNotMatch(source, /\.lesson-card-tab\.has-new::after \{[^}]*border-radius:50%/);
  assert.match(source, /\.student-info-field \.new-marker, \.card-title \.new-marker \{[^}]*display:inline;[^}]*color:#D92D20/);
  assert.match(source, /pendingStudentChanges\(lessonStudentId, t\.id\)\.length/);
  assert.match(source, /studentChangedFieldSet\(task\.studentId, task\.id\)/);
  assert.match(source, /requiresAck && !event\.acknowledged/);
});

test('approved lesson deletions are absent from the teacher request history UI', () => {
  assert.match(source, /item\.status === 'approved' && item\.changes && item\.changes\.operation === 'lesson_delete'/);
});
