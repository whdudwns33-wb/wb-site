const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const source = fs.readFileSync(require('node:path').join(__dirname, 'index.html'), 'utf8');

test('personal lesson entry only edits an exact source task and new subjects use approval requests', () => {
  assert.match(source, /function assignedLessonStudents\(\)/);
  assert.match(source, /data-lesson-student/);
  assert.match(source, /내 수업 학생을 선택해 주세요/);
  assert.match(source, /draft\.studentId = student \? student\.id : ''/);
  assert.match(source, /if \(!draft\._sourceTaskId\) return lessonAssignmentRequestHtml\(\)/);
  assert.match(source, /기존 수업 수정/);
  assert.match(source, /새 과목은 학생 수업 등록 요청으로 보내 주세요/);
  assert.match(source, /기존 수업의 학생 연결은 변경할 수 없습니다/);
  assert.match(source, /학생·과목 배정 변경은 원장님께 수업 변경을 요청해 주세요/);
  assert.doesNotMatch(source, /내 수업에 연결된 학생의 과목별 수업 정보를 등록합니다/);
});

test('empty personal roster offers a director-approved assignment request', () => {
  assert.match(source, /학생 수업 등록 요청/);
  assert.match(source, /\/lesson-assignment-request/);
  assert.match(source, /\/lesson-assignment-review/);
  assert.match(source, /data-lar-student/);
  assert.match(source, /학생 수업을 생성했습니다/);
});

test('teachers select an active stable student and request a complete lesson assignment', () => {
  assert.match(source, /data-assignment-request-student/);
  assert.match(source, /data-assignment-search/);
  assert.match(source, /data-assignment-subject/);
  assert.match(source, /type="radio" name="lesson-assignment-subject" data-assignment-subject/);
  assert.match(source, /draft\.subjects\.length !== 1/);
  assert.match(source, /data-assignment-slot="lessonHours"/);
  assert.match(source, /data-assignment-start/);
  assert.match(source, /data-assignment-reason/);
  assert.match(source, /studentId: selected\.id/);
  assert.match(source, /subjects: draft\.subjects, scheduleSlots: draft\.scheduleSlots, startDate: draft\.startDate/);
  assert.match(source, /<div class="sect">3\. 수업 요일·시간·시수/);
  assert.match(source, /승인되면 이 과목의 수업이 요청한 선생님에게 생성됩니다/);
  assert.match(source, /if \(personal\) \{[\s\S]{0,500}lessonAssignmentRequestHtml\(\)/);
  assert.match(source, /const registration =[\s\S]{0,700}lessonAssignmentReviewHtml\(\)/);
  assert.match(source, /const existingChange =[\s\S]{0,1000}viewLessonChangeReview\(\)/);
  assert.doesNotMatch(source, /data-assignment-request-name/);
  const entry = source.match(/function viewLessonEntry\(\)[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(entry.indexOf('loadLessonAssignmentRequests(false)') < entry.indexOf('if (personal && !personalStudents.length)'));
});

test('teachers can send a separate missing-roster request without creating a student', () => {
  assert.match(source, /원생 명단에 없음/);
  assert.match(source, /data-assignment-missing="missingName"/);
  assert.match(source, /data-assignment-missing="missingSchool"/);
  assert.match(source, /data-assignment-missing="missingGrade"/);
  assert.match(source, /action: 'submit_missing'/);
});

test('review shows teacher names, exact matches first, and every other active roster student', () => {
  assert.match(source, /요청 선생님: /);
  assert.doesNotMatch(source, /요청 선생님 ID:/);
  assert.match(source, /학생 수업 등록 승인/);
  assert.match(source, /if \(details\)/);
  assert.match(source, /요청과 일치하는 원생/);
  assert.match(source, /const others = students\.filter\(student => !matchIds\.has\(String\(student\.id\)\)\)/);
  assert.match(source, /<optgroup label="재원생 전체">/);
  assert.match(source, /body\.confirmIdentityMismatch = true/);
  assert.match(source, /같은 학생이 맞습니까/);
});

test('student-link selectors use lesson-derived stable ids and book ordering has a server-scoped list', () => {
  assert.match(source, /let rosterStudentSelectionScope = 'lesson_students'/);
  assert.match(source, /result\.studentSelectionScope === 'all_active' \? 'all_active' : 'lesson_students'/);
  assert.match(source, /function studentLinkCandidates\(referenceMonth, includeFuture\)/);
  assert.match(source, /student && student\.id/);
  assert.match(source, /!student\.end \|\| student\.end > month/);
  assert.match(source, /function assignedLessonStudents\(\) \{\s*return studentLinkCandidates/);
  assert.match(source, /function lessonFormStudents\(\) \{\s*return studentLinkCandidates/);
  assert.match(source, /function orderStudentCandidates\(\)[\s\S]{0,240}privateBookOrderStudents/);
  assert.match(source, /privateBookOrderStudents = Array\.isArray\(result\.bookOrderStudents\)/);
  assert.doesNotMatch(source.match(/function orderStudentCandidates\(\)[\s\S]*?\n\}/)?.[0] || '', /studentLinkCandidates/);
  assert.match(source, /const liveStudents = studentLinkCandidates\(today\(\)\.slice\(0, 7\)\)/);
});

test('a missing roster student can be added and linked before a separate lesson request', () => {
  assert.match(source, /data-act="lessonassignmentaddexisting"/);
  assert.match(source, /기존 원생 추가 후 명단 연결/);
  assert.match(source, /entryType: entryType === 'new' \? 'new' : 'existing'/);
  assert.match(source, /신규 학생 30일 관리는 첫 수업 시작일을 입력한 뒤 시작합니다/);
  assert.match(source, /action: editor\.student\._editing \? 'student_update' : 'student_create'/);
  assert.match(source, /action: 'approve', requestKey: assignment\.requestKey/);
  assert.match(source, /기존 원생 등록과 studentId 명단 연결을 완료했습니다/);
  assert.match(source, /과목·시간표를 포함한 수업 등록 요청을 새로/);
});

test('a student with another registered lesson stays selectable for a different subject request', () => {
  const request = source.slice(source.indexOf('function assignmentCandidateLabel('), source.indexOf('function lessonAssignmentReviewHtml('));
  assert.match(request, /student\.assigned \? ' · 등록 수업 있음'/);
  assert.match(request, /const candidates = lessonAssignmentCandidates\.slice\(\)/);
  assert.match(request, /if \(!selected\) return toast\('수업을 등록할 재원생을 선택해 주세요'\)/);
  assert.doesNotMatch(request, /filter\(student => !student\.assigned\)|selected\.assigned/);
});

test('roster tab exposes separate new-student maintenance with private contact fields', () => {
  assert.match(source, /원생 기본 정보 관리/);
  assert.match(source, /data-act="rosterstudentadd"/);
  assert.match(source, /data-act="rosterstudentnew"/);
  assert.match(source, /data-act="rosterstudentedit"/);
  assert.match(source, /action: 'student_get'/);
  assert.match(source, /expectedUpdatedAt: Number\(rosterDb\.updatedAt\)/);
  const editor = source.match(/function rosterStudentEditorHtml\([\s\S]*?\n\}/);
  assert.ok(editor);
  assert.match(editor[0], /data-rse-school/);
  assert.match(editor[0], /data-rse-phone-self/);
  assert.match(editor[0], /data-rse-phone-father/);
  assert.match(editor[0], /data-rse-phone-mother/);
  assert.match(editor[0], /data-rse-registration-date/);
  assert.match(editor[0], /data-rse-first-class-date/);
  assert.doesNotMatch(editor[0], /address|주소 입력/);
});
