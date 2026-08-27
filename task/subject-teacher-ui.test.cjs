const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function block(startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, `${startText} 구간을 찾을 수 있어야 한다`);
  return source.slice(start, end);
}

test('원생 공통 정보 편집기는 학생 단위 담당 선생님을 입력받지 않는다', () => {
  const briefing = block('function lessonBriefingEditorHtml(', 'function lessonBriefingLessonPayload(');
  const roster = block('function rosterStudentEditorHtml(', 'function showRosterStudentEditor(');
  assert.doesNotMatch(briefing, /data-lesson-briefing-teacher|학생 공통 담당/);
  assert.doesNotMatch(roster, /data-rse-teacher|담당 선생님<\/span><div class="chips"/);
  assert.match(briefing, /과목별 수업 담당/);
  assert.match(roster, /과목별 수업 담당/);
});

test('수업 등록은 roster teacherIds를 새 담당자로 합성하지 않는다', () => {
  const single = block('function lessonRosterStudentPayload(', 'function lessonRosterStudentChanged(');
  const batch = block('function lessonStudentBatchRosterPayload(', 'function previewLessonStudentBatchRegistration(');
  const event = block("const field = ev.target.closest('[data-lesson-field]')", "document.addEventListener('toggle'");
  assert.doesNotMatch(single, /teacherIds|teacherTransfer|teacher:\s*teacherIds/);
  assert.doesNotMatch(batch, /teacherIds|teacher:\s*teacherIds/);
  assert.doesNotMatch(event, /lessonRosterDraft\.teacherIds|teacherIds\.push/);
  assert.match(source, /담당 선생님은 수업마다 따로 지정됩니다/);
  assert.match(source, /이번 수업 담당 선생님/);
  assert.doesNotMatch(source, /공통 담당 선생님/);
});

test('원생 정보의 담당 표시는 종료되지 않은 현재·예정 수업 task.staffId에서 과목별로 파생한다', () => {
  const helpers = block('function rosterStudentLessonTasks(', 'function rosterStudentLessonsHtml(');
  const info = block('function rosterStudentInfoHtml(', 'function rosterTransitionListsHtml(');
  assert.match(helpers, /String\(task\.staffId \|\| ''\)/);
  assert.match(helpers, /task\.subject \|\| task\.className \|\| task\.lessonRole/);
  assert.doesNotMatch(helpers, /String\(task\.start\) <= reference/);
  assert.match(helpers, /!task\.end \|\| String\(task\.end\) >= reference/);
  assert.match(info, /field\('과목별 수업 담당', rosterStudentSubjectTeacherText\(student\.id\)/);
  assert.doesNotMatch(info, /field\('담당 선생님', student\.teacher/);
});

test('원생 정보 저장 payload에는 legacy 공통 담당 필드를 다시 넣지 않는다', () => {
  const briefing = block('function lessonBriefingStudentPayload()', 'function lessonBriefingLessonPayload(');
  const save = block('async function saveRosterStudent(', 'async function deleteRosterStudent(');
  assert.doesNotMatch(briefing, /teacherIds|teacher:\s*String/);
  assert.doesNotMatch(save, /teacherIds|teacher:\s*String/);
});

test('추가 과목 수업 요청은 이미 다른 수업이 있는 학생도 막지 않는다', () => {
  const request = block('function assignmentCandidateLabel(', 'function lessonAssignmentReviewHtml(');
  assert.match(request, /const candidates = lessonAssignmentCandidates\.slice\(\)/);
  assert.doesNotMatch(request, /filter\(student => !student\.assigned\)|selected\.assigned/);
  assert.match(request, /등록 수업 있음/);
});
