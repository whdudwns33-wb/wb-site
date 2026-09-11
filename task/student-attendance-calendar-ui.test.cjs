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

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

test('회차제 학생 정보는 동적 시작일 다음에 현재 4회 중 출석 횟수를 표시한다', () => {
  const source = block('function rosterStudentInfoHtml(student, lessonReferences, taskId)', 'function rosterTransitionListsHtml(');
  const start = source.indexOf('data-student-cycle-start');
  const count = source.indexOf('data-student-cycle-count');

  assert.ok(start >= 0 && count > start, '회차 시작일 바로 다음에 현재 회차 출석이 있어야 한다');
  assert.match(source, /data-fallback="' \+ esc\(student\.sessionCycleStartDate \|\| '미지정'\)/);
  assert.match(source, /<b>현재 회차 출석<\/b>/);
  assert.match(html, /element\.textContent = '현재 ' \+ size \+ '회 중 ' \+ count \+ '회 출석'/);
  assert.match(html, /element\.textContent = String\(result\.cycleStartDate \|\| element\.dataset\.fallback \|\| '미지정'\)/);
});

test('학생 정보의 출결 달력은 월 이동과 출석·지각·결석·조퇴 색상 및 같은 날 다중 기록을 제공한다', () => {
  const calendarSource = block('const STUDENT_ATTENDANCE_STATUS = {', 'function rosterStudentLessonsHtml(student)');
  const api = new Function('today', 'parseYmd', 'ymd', 'esc', 'state', 'staffById',
    `${calendarSource}\nreturn { studentAttendanceMonthShift, studentAttendanceCalendarHtml };`)(
      () => '2026-09-04', value => {
        const [year, month, day] = value.split('-').map(Number);
        return new Date(year, month - 1, day);
      }, date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
      escapeHtml,
      { tasks: [
        { id: 'lesson-a', subject: '수학', staffId: 'staff-a' },
        { id: 'lesson-b', subject: '영어', staffId: 'staff-b' }
      ] }, id => ({ 'staff-a': { name: '김남기' }, 'staff-b': { name: '김혜지' } }[id] || null)
    );

  assert.equal(api.studentAttendanceMonthShift('2026-01', -1), '2025-12');
  assert.equal(api.studentAttendanceMonthShift('2026-12', 1), '2027-01');
  const rendered = api.studentAttendanceCalendarHtml({
    studentId: '12345678',
    attendance: [
      { date: '2026-09-04', status: 'P', taskId: 'lesson-a' },
      { date: '2026-09-04', status: 'A', taskId: 'lesson-b' },
      { date: '2026-09-08', status: 'L', taskId: 'lesson-a' },
      { date: '2026-09-09', status: 'E', taskId: 'lesson-b' },
      { date: '2026-08-31', status: 'P', taskId: 'lesson-a' }
    ]
  }, '2026-09');

  assert.match(rendered, /2026년 9월 출결/);
  assert.match(rendered, /has-mixed is-today/);
  assert.equal((rendered.match(/student-attendance-mark is-present/g) || []).length >= 2, true);
  for (const state of ['is-present', 'is-late', 'is-absent', 'is-early']) assert.match(rendered, new RegExp(state));
  assert.match(rendered, /수학 · 김남기 선생님/);
  assert.match(rendered, /영어 · 김혜지 선생님/);
  assert.doesNotMatch(rendered, /08\/31/);
  assert.match(rendered, /data-act="studentattendancemonth"/);
});

test('관리자와 담당 선생님 학생 정보 진입점 모두 stable studentId로 서버 달력을 불러온다', () => {
  const rosterPopup = block('function showRosterStudentInfo(studentId)', 'function showRosterStudentLessons(studentId)');
  const lessonPopup = block('function showTodayLessonBriefing(taskId, lessonDate)', 'let lessonBriefingEditor');
  const loader = block('async function loadStudentAttendance(studentId, month)', 'function rosterStudentLessonsHtml(student)');

  assert.match(rosterPopup, /loadStudentAttendance\(student\.id, today\(\)\.slice\(0, 7\)\)/);
  assert.match(lessonPopup, /if \(student\) loadStudentAttendance\(student\.id, today\(\)\.slice\(0, 7\)\)/);
  assert.match(loader, /sync\.post\('\/student-attendance'/);
  assert.match(loader, /action: 'get', studentId: String\(studentId\), month: selectedMonth/);
  assert.match(loader, /data-act="studentattendanceretry"/);
  assert.match(html, /querySelectorAll\('\[data-student-attendance-calendar\]:not\(\[data-loaded="true"\]\)'\)/);
});

test('회차제 결석은 자동 보강을 건너뛰고 직접 요청은 manual 모드로 유지한다', () => {
  const request = block('function makeupCreateKey(taskId, date)', 'function makeupIsDelayed(row, date)');
  const create = block('async function createMakeupFromAbsence(taskId, date, button, options)', 'function manualMakeupStudents()');
  const click = block('/* 보강 */', '/* 날짜 */');
  const attendanceClick = block("case 'latt':", "case 'fbtext':");

  assert.match(request, /taskUsesSession4Billing\(task, date\)/);
  assert.match(request, /회차제 결석은 자동 생성하지 않습니다/);
  assert.match(create, /automatic && typeof taskUsesSession4Billing === 'function' && taskUsesSession4Billing\(task, date\)/);
  assert.match(create, /creationMode: automatic \? 'automatic' : 'manual'/);
  assert.match(create, /SESSION4_AUTOMATIC_MAKEUP_DISABLED/);
  assert.match(click, /\{ automatic: false \}/);
  assert.match(attendanceClick, /next === 'A' && taskUsesSession4Billing\(t, date\)/);
  assert.match(attendanceClick, /회차제는 보강을 자동 생성하지 않습니다/);
});

test('회차 탭 최상단 원장은 roster에서 회차제로 분류된 학생만 표시하고 기존 수업별 원장을 보존한다', () => {
  const ledger = block('function session4LedgerStudents()', 'function viewSessionPacks()');
  const view = block('function viewSessionPacks()', 'async function createSessionPack(button)');

  assert.match(ledger, /String\(student && student\.billingMode \|\| 'monthly'\) === 'session4'/);
  assert.match(ledger, /!rosterStudentTransition\(student\)/);
  assert.match(ledger, /String\(student\.start\) <= currentMonth/);
  assert.match(ledger, /String\(student\.end\) > currentMonth/);
  assert.match(ledger, /sync\.post\('\/student-attendance'/);
  assert.match(ledger, /action: 'list'/);
  assert.match(ledger, /result && result\.students/);
  assert.doesNotMatch(ledger, /Promise\.all\(students\.map/);
  assert.doesNotMatch(ledger, /throughDate/);
  assert.match(ledger, /회차제 학생 원장/);
  assert.match(ledger, /월제 원생은 포함하지 않습니다/);
  assert.match(ledger, /현재 회차 시작일/);
  assert.match(ledger, /완료된 지난 회차/);
  assert.ok(view.indexOf('session4StudentLedgerHtml()') < view.indexOf('회차제 수업'), '학생 원장이 기존 수업별 원장보다 위에 있어야 한다');
  assert.match(view, /sessionPackCreateHtml\(\)/);
  assert.match(view, /sessionPackKpis\(rows\)/);
  assert.match(view, /rows\.map\(sessionPackCard\)/);
});

test('회차제 학생 원장 카드는 학교·학년과 현재 횟수 및 회차 출석일을 표시한다', () => {
  const ledger = block('function session4LedgerAttendanceHtml(rows)', 'function viewSessionPacks()');

  assert.match(ledger, /studentSchoolGradeDetailLabel\(student\)/);
  assert.ok(ledger.includes("count + '/' + size + '회"));
  assert.match(ledger, /현재 ' \+\s*size \+ '회 중 출석/);
  for (const state of ["P: { label: '출석'", "L: { label: '지각'", "A: { label: '결석'", "E: { label: '조퇴'"]) {
    assert.match(html, new RegExp(state.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(ledger, /session4LedgerAttendanceHtml\(currentAttendance\)/);
  assert.match(ledger, /session4LedgerHistoryHtml\(summary\)/);
  assert.match(ledger, /const currentCycle = cycles\.at\(-1\) \|\| null/);
  assert.match(ledger, /cycles\.slice\(0, -1\)\.filter\(cycle => cycle\.complete\)/);
  assert.match(ledger, /cycle\.status === 'complete'/);
  assert.match(ledger, /cycle\.completedAt/);
  assert.match(html, /case 'session4ledgerrefresh'/);
});

test('수업별 회차권이 없어도 roster 회차제 학생은 23시 50분 이후 출결이 잠긴다', () => {
  const attendanceState = block('function sessionPackAttendanceState(task, date)', 'function sessionPackAttendanceHintHtml(task, date, check, attendanceState)');

  assert.match(attendanceState, /const rosterSession4 = typeof taskUsesSession4Billing === 'function' && taskUsesSession4Billing\(task, date\)/);
  assert.match(attendanceState, /if \(!pack && !rosterSession4\) return null/);
  assert.match(attendanceState, /date < current\.date \|\| \(date === current\.date && current\.minute >= SESSION_PACK_ATTENDANCE_CUTOFF_MINUTE\)/);
  assert.match(attendanceState, /locked: reflected \|\| cutoffReached/);
  const attendanceClick = block("case 'latt':", "case 'fbtext':");
  assert.match(attendanceClick, /attendanceState && attendanceState\.locked/);
  assert.match(attendanceClick, /회차제 출결은 당일 23:50에 마감되어 변경할 수 없습니다/);
});

test('학생 단위 4회제는 설정 시작일 당일부터만 적용되고 그 전 수업은 월제 또는 legacy 규칙을 따른다', () => {
  const source = block('function taskUsesSession4Billing(task, referenceDate)', 'function makeupRequestHtml(task, date, check)');
  const student = { id: '12345678', billingMode: 'session4', sessionCycleStartDate: '2026-09-01' };
  const usesSession4 = new Function('rosterStudentByStableId', 'today', `${source}\nreturn taskUsesSession4Billing;`)(
    id => id === student.id ? student : null,
    () => '2026-09-04'
  );

  assert.equal(usesSession4({ studentId: student.id }, '2026-08-31'), false);
  assert.equal(usesSession4({ studentId: student.id }, '2026-09-01'), true);
  assert.equal(usesSession4({ studentId: student.id }, '2026-09-04'), true);
  assert.equal(usesSession4({ studentId: student.id }), true, '날짜 생략 시 오늘 기준으로 판단한다');
  assert.equal(usesSession4({ studentId: 'other' }, '2026-09-04'), false);
  assert.equal(usesSession4({ studentId: student.id }, 'invalid-date'), true, '잘못된 선택값은 오늘로 안전하게 대체한다');

  student.sessionCycleStartDate = '';
  assert.equal(usesSession4({ studentId: student.id }, '2026-09-04'), false, '유효한 시작일이 없으면 4회제로 추정하지 않는다');
});
