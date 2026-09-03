const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function block(from, to) {
  const start = html.indexOf(from);
  const end = html.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `${from} 블록을 찾을 수 없습니다`);
  return html.slice(start, end);
}

test('관리자와 개인 인증 선생님 보강 탭에 보강생성 진입점을 표시한다', () => {
  const view = block('function viewMakeups()', 'async function refreshMakeupsAfterConflict');

  assert.match(view, /session\.isAdmin \|\| \(session\.isStaffLink && session\.staffId\)/);
  assert.match(view, /data-act="mumanualopen">보강생성<\/button>/);
  assert.match(view, /관리자·선생님이 직접 생성한 보강/);
  assert.match(view, /위 보강생성 버튼을 사용하거나 수업 카드에서 결석을 기록해 주세요/);
  assert.match(view, /!rosterDb && !rosterErr && !rosterLoading/);
  assert.match(view, /loadRoster\(\)/);

  const modal = block('function openManualMakeupModal()', 'async function submitManualMakeup');
  assert.match(modal, /if \(!\(session\.isAdmin \|\| \(session\.isStaffLink && session\.staffId\)\)\) return/);
});

test('수동 보강은 원생을 먼저 고르고 권한 범위의 현재 정규수업만 고른다', () => {
  const lessonSource = block('function manualMakeupStudents()', 'function manualMakeupSourceLessonLabel');
  const modal = block('function openManualMakeupModal()', 'async function submitManualMakeup');
  const change = block("document.addEventListener('change', ev => {\n  const manualMakeupStudent", "document.addEventListener('toggle'");

  assert.match(lessonSource, /studentLinkCandidates\(today\(\)\.slice\(0, 7\), false\)/);
  assert.match(lessonSource, /filter\(student =>\s*allowedIds\.has\(String\(student\.id \|\| ''\)\)\)/);
  assert.match(lessonSource, /isRegularLessonTask\(task\)/);
  assert.match(lessonSource, /!stableId \|\| String\(task\.studentId \|\| ''\) === stableId/);
  assert.match(lessonSource, /session\.isAdmin \|\| \(session\.isStaffLink && String\(task\.staffId \|\| ''\) === String\(session\.staffId \|\| ''\)\)/);
  assert.match(lessonSource, /String\(task\.start\) <= reference/);
  assert.match(lessonSource, /String\(task\.end\) >= reference/);
  assert.ok(modal.indexOf('id="muManualStudent"') < modal.indexOf('id="muManualSourceTask"'));
  assert.match(modal, /id="muManualSourceTask" disabled/);
  assert.match(change, /updateManualMakeupLessonSelect\(String\(manualMakeupStudent\.value \|\| ''\)\)/);
  assert.doesNotMatch(change.slice(0, change.indexOf('const teacherLiveRequestLesson')), /render\(/,
    '원생을 고를 때 모달이나 전체 화면을 다시 그리지 않는다');
});

test('관리자는 모든 담당 수업을, 선생님은 자신의 stable staffId 수업만 선택한다', () => {
  const source = block('function manualMakeupSourceLessons(studentId)', 'function manualMakeupSourceLessonLabel');
  const tasks = [
    { id: 'mine', studentId: 'student-1', staffId: 'staff-1', start: '2026-01-01', end: '', subject: '수학' },
    { id: 'other', studentId: 'student-1', staffId: 'staff-2', start: '2026-01-01', end: '', subject: '영어' },
    { id: 'future', studentId: 'student-1', staffId: 'staff-1', start: '2026-10-01', end: '', subject: '과학' }
  ];
  const make = session => new Function('state', 'session', 'today', 'isRegularLessonTask', 'staffById',
    `${source}\nreturn manualMakeupSourceLessons;`)(
      { tasks }, session, () => '2026-09-03', () => true,
      id => ({ id, name: id === 'staff-1' ? '내선생님' : '다른선생님' })
    );

  assert.deepEqual(make({ isAdmin: true, isStaffLink: false })('student-1').map(task => task.id).sort(), ['mine', 'other']);
  assert.deepEqual(make({ isAdmin: false, isStaffLink: true, staffId: 'staff-1' })('student-1').map(task => task.id), ['mine']);
  assert.deepEqual(make({ isAdmin: false, isStaffLink: true, staffId: 'staff-2' })('student-1').map(task => task.id), ['other']);
});

test('관리자도 선택 가능한 현재 정규수업이 있는 원생만 후보로 본다', () => {
  const source = block('function manualMakeupStudents()', 'function manualMakeupSourceLessons(studentId)');
  const students = new Function('manualMakeupSourceLessons', 'studentLinkCandidates', 'today',
    `${source}\nreturn manualMakeupStudents;`)(
      () => [{ studentId: 'student-1' }],
      () => [{ id: 'student-1', name: '연결원생' }, { id: 'student-2', name: '수업없는원생' }],
      () => '2026-09-03'
    );

  assert.deepEqual(students().map(student => student.id), ['student-1']);
});

test('수동 보강 모달은 고정 사유와 날짜·시작·종료 입력을 제공한다', () => {
  const reasons = block('const MANUAL_MAKEUP_REASON_OPTIONS', 'function makeupCaseForSource');
  const modal = block('function openManualMakeupModal()', 'async function submitManualMakeup');

  for (const [code, label] of [
    ['manual_absence', '결석보강'], ['manual_exam', '시험보강'], ['manual_other', '기타보강']
  ]) {
    assert.match(reasons, new RegExp(`\\['${code}', '${label}'\\]`));
  }
  assert.match(modal, /id="muManualReason"/);
  assert.match(modal, /id="muManualDate" type="date"/);
  assert.match(modal, /id="muManualStart" type="time"/);
  assert.match(modal, /id="muManualEnd" type="time"/);
  assert.match(modal, /원 수업의 출결은 바꾸지 않습니다/);
  assert.match(modal, /결석보강만 회차를 1회 차감/);
  assert.match(modal, /시험보강·기타보강은 회차를 추가 차감하지 않습니다/);
  assert.doesNotMatch(modal, /<textarea|prompt\s*\(/i);
});

test('확인은 create_manual의 정확한 식별자·사유·일시만 전송한다', async () => {
  const source = block('async function submitManualMakeup(button)', 'function makeupCanComplete');
  const elements = {
    muManualStudent: { value: 'student-8' }, muManualSourceTask: { value: 'lesson-3' },
    muManualReason: { value: 'manual_exam' }, muManualDate: { value: '2026-09-06' },
    muManualStart: { value: '14:00' }, muManualEnd: { value: '14:50' }
  };
  const calls = [];
  const submit = new Function('$', 'session', 'manualMakeupSourceLessons', 'MANUAL_MAKEUP_REASON_LABELS',
    'today', 'toast', 'mutateMakeup', `${source}\nreturn submitManualMakeup;`)(
      id => elements[id.slice(1)] || null,
      { isAdmin: false, isStaffLink: true, staffId: 'staff-1' },
      studentId => studentId === 'student-8' ? [{ id: 'lesson-3' }] : [],
      { manual_exam: '시험보강' },
      () => '2026-09-03',
      message => calls.push({ toast: message }),
      async (payload, button, successText, focusAct, closeOnSuccess) => {
        calls.push({ payload, button, successText, focusAct, closeOnSuccess });
      }
    );
  const button = { disabled: false };
  await submit(button);

  assert.deepEqual(calls, [{
    payload: {
      action: 'create_manual', studentId: 'student-8', sourceTaskId: 'lesson-3',
      reason: 'manual_exam', date: '2026-09-06', startTime: '14:00', endTime: '14:50'
    },
    button,
    successText: '보강수업을 생성했습니다',
    focusAct: '',
    closeOnSuccess: true
  }]);
});

test('수동 생성 카드에는 결석 원 수업 표현 대신 생성 사유를 표시한다', () => {
  const card = block('function makeupCard(row)', 'function makeupKpis(rows)');

  assert.match(card, /row\.creationType === 'manual'/);
  assert.match(card, /MANUAL_MAKEUP_REASON_LABELS\[row\.manualReason\]/);
  assert.match(card, /직접 생성 ·/);
  assert.match(card, /: '원 수업 ' \+ esc\(row\.sourceDate\)/);
});

test('수동 보강은 정규수업 결석 카드의 연결·완료 상태를 가로채지 않는다', () => {
  const lookup = block('function makeupCaseForSource(taskId, date)', 'function makeupCompletionTagHtml');
  const findCase = new Function('makeupRows', `${lookup}\nreturn makeupCaseForSource;`)([
    { caseId: 'manual-1', creationType: 'manual', sourceTaskId: 'lesson-1', sourceDate: '2026-09-06', status: 'completed' },
    { caseId: 'absence-1', creationType: 'absence', sourceTaskId: 'lesson-1', sourceDate: '2026-09-06', status: 'review_pending' }
  ]);

  assert.equal(findCase('lesson-1', '2026-09-06').caseId, 'absence-1');
  assert.equal(new Function('makeupRows', `${lookup}\nreturn makeupCaseForSource;`)([
    { caseId: 'manual-only', creationType: 'manual', sourceTaskId: 'lesson-2', sourceDate: '2026-09-06' }
  ])('lesson-2', '2026-09-06'), null);
  assert.equal(new Function('makeupRows', `${lookup}\nreturn makeupCaseForSource;`)([
    { caseId: 'unproven', creationType: 'unknown', sourceTaskId: 'lesson-3', sourceDate: '2026-09-06' }
  ])('lesson-3', '2026-09-06'), null, '출처가 입증되지 않은 레거시 행도 결석 보강으로 추정하지 않는다');
});

test('클릭 라우팅과 서버 정본 수업 즉시 반영에 수동 생성이 연결된다', () => {
  const clicks = block("case 'murefresh':", '/* 날짜 */');
  const mutation = block('async function mutateMakeup', 'async function createMakeupFromAbsence');

  assert.match(clicks, /case 'mumanualopen': openManualMakeupModal\(\)/);
  assert.match(clicks, /case 'mumanualsubmit': submitManualMakeup\(el\)/);
  assert.match(mutation, /result\.lessonTask && result\.lessonTask\.id/);
  assert.match(mutation, /payload\.action === 'create_manual'/);
});
