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

test('요일 일부 담당 변경 이력은 월요일부터 일요일 순서로 적용 요일을 표시한다', () => {
  const start = source.indexOf('function studentChangeEffectiveDaysText(');
  const end = source.indexOf('function studentChangeHistoryHtml(', start);
  assert.ok(start >= 0 && end > start);
  const formatDays = new Function(source.slice(start, end) + '\nreturn studentChangeEffectiveDaysText;')();
  assert.equal(formatDays([5, 3, 1, 2, 1]), ' · 적용 요일 월·화·수·금');
  assert.equal(formatDays([]), '');
  assert.match(source, /studentChangeEffectiveDaysText\(detail\.effectiveDays\)/);
});

test('요일 분리 이력은 이전 check 키의 로컬 사본을 지워 재업로드와 중복 출결을 막는다', () => {
  const start = source.indexOf('function reconcileStudentChangeCheckKeyMoves(');
  const end = source.indexOf('function studentChangeHistoryHtml(', start);
  assert.ok(start >= 0 && end > start);
  const state = { checks: {
    'lesson-old|2026-09-04': { taskId: 'lesson-old', date: '2026-09-04', updatedAt: 100 },
    'lesson-new|2026-09-04': { taskId: 'lesson-new', date: '2026-09-04', updatedAt: 100 },
    'lesson-keep|2026-09-05': { taskId: 'lesson-keep', date: '2026-09-05' }
  } };
  const studentChangeMovedCheckKeys = new Set();
  const reconcile = new Function('state', 'studentChangeMovedCheckKeys', source.slice(start, end) + '\nreturn reconcileStudentChangeCheckKeyMoves;')(state, studentChangeMovedCheckKeys);
  const result = reconcile([{ details: { checkKeyMoves: [
    { oldKey: 'lesson-old|2026-09-04', newKey: 'lesson-new|2026-09-04', oldUpdatedAt: 100 },
    { oldKey: 'bad key', newKey: 'lesson-new|2026-09-05' }
  ] } }]);
  assert.equal(result.removed, 1);
  assert.equal(result.conflicts, 0);
  assert.equal(state.checks['lesson-old|2026-09-04'], undefined);
  assert.ok(state.checks['lesson-keep|2026-09-05']);
  assert.match(source, /reconcileStudentChangeCheckKeyMoves\(studentChangeEvents\)/);
  assert.match(source, /studentChangeMovedCheckKeys\.has\(k\)/);
});

test('요일 분리 직전의 더 최신 로컬 check는 삭제하지 않고 재전송을 보류한다', () => {
  const start = source.indexOf('function reconcileStudentChangeCheckKeyMoves(');
  const end = source.indexOf('function studentChangeHistoryHtml(', start);
  const state = { checks: {
    'lesson-old|2026-09-04': { taskId: 'lesson-old', date: '2026-09-04', note: '미전송 메모', updatedAt: 101 },
    'lesson-new|2026-09-04': { taskId: 'lesson-new', date: '2026-09-04', updatedAt: 100 }
  } };
  const blocked = new Set();
  const reconcile = new Function('state', 'studentChangeMovedCheckKeys', source.slice(start, end) + '\nreturn reconcileStudentChangeCheckKeyMoves;')(state, blocked);
  const result = reconcile([{ details: { checkKeyMoves: [{
    oldKey: 'lesson-old|2026-09-04', newKey: 'lesson-new|2026-09-04', oldUpdatedAt: 100
  }] } }]);
  assert.equal(result.removed, 0);
  assert.equal(result.conflicts, 1);
  assert.equal(state.checks['lesson-old|2026-09-04'].note, '미전송 메모');
  assert.equal(blocked.has('lesson-old|2026-09-04'), true);
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

test('task-scoped N stays on its exact lesson while common student information stays shared', () => {
  const start = source.indexOf('function pendingStudentChanges(');
  const end = source.indexOf('function studentChangedFieldSet(', start);
  assert.ok(start >= 0 && end > start);
  const events = [
    { eventId: 'task-a', studentId: 'student-a', taskId: 'lesson-a', requiresAck: true, acknowledged: false },
    { eventId: 'task-b', studentId: 'student-a', taskId: 'lesson-b', requiresAck: true, acknowledged: false },
    { eventId: 'common', studentId: 'student-a', taskId: '', requiresAck: true, acknowledged: false }
  ];
  const pending = new Function('studentChangeEvents', source.slice(start, end) + '\nreturn pendingStudentChanges;')(events);
  assert.deepEqual(pending('student-a', 'lesson-a').map(event => event.eventId), ['task-a', 'common']);
  assert.deepEqual(pending('student-a', 'lesson-b').map(event => event.eventId), ['task-b', 'common']);
  assert.deepEqual(pending('student-a', 'lesson-c').map(event => event.eventId), ['common']);
});

test('approved lesson deletions are absent from the teacher request history UI', () => {
  assert.match(source, /item\.status === 'approved' && item\.changes && item\.changes\.operation === 'lesson_delete'/);
});
