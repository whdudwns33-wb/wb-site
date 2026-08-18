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

test('teachers can request another student even after one student is assigned', () => {
  assert.match(source, /다른 학생 배정 요청/);
  assert.match(source, /personal \? lessonAssignmentRequestHtml\(\) : publicationReadinessHtml\(\) \+ viewLessonChangeReview\(\) \+ lessonAssignmentReviewHtml\(\)/);
  assert.match(source, /data-assignment-request-name/);
  assert.match(source, /data-assignment-request-grade/);
  const entry = source.match(/function viewLessonEntry\(\)[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(entry.indexOf('loadLessonAssignmentRequests(false)') < entry.indexOf('if (personal && !personalStudents.length)'));
});

test('review shows teacher names, exact matches first, and every other active roster student', () => {
  assert.match(source, /요청 선생님: /);
  assert.doesNotMatch(source, /요청 선생님 ID:/);
  assert.match(source, /요청과 일치하는 원생/);
  assert.match(source, /const others = students\.filter\(student => !matchIds\.has\(String\(student\.id\)\)\)/);
  assert.match(source, /<optgroup label="재원생 전체">/);
  assert.match(source, /body\.confirmIdentityMismatch = true/);
  assert.match(source, /같은 학생이 맞습니까/);
});

test('student-link selectors share one active stable-id candidate list', () => {
  assert.match(source, /let rosterStudentSelectionScope = 'assigned'/);
  assert.match(source, /result\.studentSelectionScope === 'all_active' \? 'all_active' : 'assigned'/);
  assert.match(source, /function studentLinkCandidates\(referenceMonth, includeFuture\)/);
  assert.match(source, /student && student\.id/);
  assert.match(source, /!student\.end \|\| student\.end > month/);
  assert.match(source, /function assignedLessonStudents\(\) \{\s*return studentLinkCandidates/);
  assert.match(source, /function lessonFormStudents\(\) \{\s*return studentLinkCandidates/);
  assert.match(source, /function orderStudentCandidates\(\) \{\s*return studentLinkCandidates/);
  assert.match(source, /const liveStudents = studentLinkCandidates\(today\(\)\.slice\(0, 7\)\)/);
});

test('a missing roster student can be added as an existing student and approved', () => {
  assert.match(source, /data-act="lessonassignmentaddexisting"/);
  assert.match(source, /기존 원생으로 추가 후 승인/);
  assert.match(source, /entryType: 'existing'/);
  assert.match(source, /신규 학생 30일 관리에는 자동으로 등록되지 않습니다/);
  assert.match(source, /action: editor\.student\._editing \? 'student_update' : 'student_create'/);
  assert.match(source, /action: 'approve', requestKey: assignment\.requestKey/);
  assert.match(source, /기존 원생 등록과 담당 연결을 완료했습니다/);
});

test('roster tab exposes basic student maintenance without storing contacts', () => {
  assert.match(source, /원생 기본 정보 관리/);
  assert.match(source, /data-act="rosterstudentadd"/);
  assert.match(source, /data-act="rosterstudentedit"/);
  assert.match(source, /action: 'student_get'/);
  assert.match(source, /expectedUpdatedAt: Number\(rosterDb\.updatedAt\)/);
  const editor = source.match(/function rosterStudentEditorHtml\([\s\S]*?\n\}/);
  assert.ok(editor);
  assert.doesNotMatch(editor[0], /phone|address|연락처 입력|주소 입력/);
});
