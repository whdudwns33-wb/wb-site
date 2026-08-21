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

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

test('관리자 기본 정보 목록과 선생님 내 학생 목록의 이름이 정보 팝업을 연다', () => {
  const view = block('function viewRoster()', '/* ── 직원 관리');
  assert.equal((view.match(/data-act="rosterstudentinfo"/g) || []).length, 2);
  assert.match(view, /managed\.map\(student =>[\s\S]*data-act="rosterstudentinfo" data-id="' \+ esc\(student\.id\)/);
  assert.match(view, /mineActive\.map\(s =>[\s\S]*data-act="rosterstudentinfo" data-id="' \+ esc\(s\.id\)/);
  assert.match(view, /aria-label="' \+ esc\(student\.name\) \+ ' 학생 정보 보기"/);
  assert.match(view, /aria-label="' \+ esc\(s\.name\) \+ ' 학생 정보 보기"/);
  assert.match(source, /case 'rosterstudentinfo': showRosterStudentInfo\(String\(id \|\| ''\)\)/);
});

test('학생 정보 팝업은 학교·연락처·등록일을 포함하고 모든 값을 escape한다', () => {
  const code = block('function rosterStudentTransition(', 'function showRosterStudentInfo(');
  const render = new Function('today', 'esc', `${code}\nreturn rosterStudentInfoHtml;`)(
    () => '2026-08-18', escapeHtml
  );
  const attack = '<img src=x onerror=alert(1)>';
  const html = render({
    id: 'student-safe', name: attack, school: attack, grade: attack, subject: attack, teacher: attack,
    phoneSelf: attack, phoneFather: attack, phoneMother: attack,
    registrationDate: '2026-08-18', firstClassDate: '2026-08-19',
    start: '2026-08', end: '', reason: '', memo: attack
  }, [attack]);
  assert.doesNotMatch(html, /<img\b/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  for (const label of ['학교', '학년', '연락처\\(본인\\)', '연락처\\(부\\)', '연락처\\(모\\)',
    '등록과목', '신규 등록일', '첫 수업 시작일', '담당 선생님', '재원 기간', '내부 메모', '수업 참고']) {
    assert.match(html, new RegExp(label));
  }
});

test('원생 탭은 휴원생과 퇴원생을 한 줄 요약의 접힌 목록으로 분리한다', () => {
  const transition = block('function rosterStudentTransition(', 'function activeIn(');
  const lists = block('function rosterTransitionListsHtml(', 'function showRosterStudentInfo(');
  const view = block('function viewRoster()', '/* ── 직원 관리');
  assert.match(transition, /\^\(휴원\|퇴원\)/);
  assert.match(lists, /section\('leave', '휴원생'/);
  assert.match(lists, /section\('withdrawal', '퇴원생'/);
  assert.match(lists, /<details class="roster-transition-item"><summary>/);
  assert.match(lists, /roster-transition-summary/);
  assert.doesNotMatch(lists, /<details class="roster-transition-item" open/);
  assert.match(view, /h \+= rosterTransitionListsHtml\(rosterDb\.students\)/);
  assert.match(source, /function studentLinkCandidates[\s\S]{0,420}!rosterStudentTransition\(student\)/);
  assert.match(source, /const curActive = activeIn\(cur\)\.filter\(student => !rosterStudentTransition\(student\)\)/);
});

test('관리자 신규 원생 추가와 고정 등록과목 중복 선택을 제공하고 교사 목록은 이름·학년만 표시한다', () => {
  const view = block('function viewRoster()', '/* ── 직원 관리');
  const editor = block('const ROSTER_SUBJECT_OPTIONS', '/* ── 신규 학생 30일 적응 관리');
  assert.match(view, /data-act="rosterstudentadd">기존 원생 추가<\/[\s\S]*data-act="rosterstudentnew">신규 원생 추가/);
  for (const field of ['data-rse-name', 'data-rse-school', 'data-rse-grade', 'data-rse-phone-self',
    'data-rse-phone-father', 'data-rse-phone-mother', 'data-rse-registration-date', 'data-rse-first-class-date']) {
    assert.match(editor, new RegExp(field));
  }
  for (const subject of ['국어', '영어', '수학', '사회', '과학', '독해사고력', '독해력수업', '독해력훈련', '사고력수학', '질답', '클리닉']) {
    assert.match(editor, new RegExp(subject));
  }
  assert.match(editor, /data-rse-subject/);
  assert.match(editor, /이름·학교·학년만 입력하면 내부 연결용 studentId를 서버가 8자리 숫자로 자동 발급합니다/);
  assert.match(editor, /showRosterStudentEditor\(\{[\s\S]{0,180}id: ''/);
  assert.doesNotMatch(editor, /id: 'student_' \+ uid\(\)/);
  assert.match(editor, /if \(!student\.name \|\| !student\.school \|\| !student\.grade\)/);
  assert.match(editor, /registrationDate\.slice\(0, 7\) \|\| today\(\)\.slice\(0, 7\)/);
  assert.doesNotMatch(editor, /isNew && \(!registrationDate \|\| !firstClassDate\)/);
  for (const label of ['이름 · 필수', '학교 · 필수', '학년 · 필수', '신규 등록일 (선택)', '첫 수업 시작일 (선택)']) {
    assert.match(editor, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  const mineList = view.slice(view.indexOf('if (myName)'), view.indexOf('if (session.isStaffLink && !session.isAdmin)'));
  assert.match(mineList, /mineActive\.map[\s\S]*s\.name[\s\S]*s\.grade/);
  assert.doesNotMatch(mineList, /s\.subject|s\.memo|sessionModeBadgesForStudent/);
});

test('관리자 원생 수정은 승인 없는 휴원·퇴원·복귀와 복귀 수업 지정을 제공한다', () => {
  const editor = block('let rosterStudentEditor = null;', '/* ── 신규 학생 30일 적응 관리');
  assert.match(editor, /data-act="rostertransitionopen" data-operation="leave">휴원/);
  assert.match(editor, /data-act="rostertransitionopen" data-operation="withdrawal">퇴원/);
  assert.match(editor, /data-act="rostertransitionopen" data-operation="return">복귀/);
  assert.match(editor, /if \(!session\.isAdmin/);
  assert.match(editor, /data-roster-transition-staff/);
  assert.match(editor, /data-roster-return-subject/);
  assert.match(editor, /data-roster-return-hours/);
  assert.match(editor, /data-roster-return-day/);
  assert.match(editor, /data-roster-return-time="startTime"/);
  assert.match(editor, /data-roster-return-time="endTime"/);
  assert.match(editor, /action: 'student_transition'/);
  assert.match(editor, /if \(result\.task\) applyCreatedLesson\(result\.task\)/);
  assert.match(source, /case 'rostertransitionsubmit': submitRosterTransition\(el\)/);
  assert.match(source, /event\.details\.operation === 'return'/);
  assert.match(source, /eventLabel === '복귀'/);
});

test('이름·학교·학년 외 정보가 없는 원생만 관리자 완전 삭제를 요청할 수 있다', () => {
  const editor = block('let rosterStudentEditor = null;', '/* ── 신규 학생 30일 적응 관리');
  assert.match(editor, /function rosterStudentCanDelete\(student\)/);
  assert.match(editor, /\(student\.teacherIds \|\| \[\]\)\.length \|\| rosterStudentSubjects\(student\)\.length/);
  assert.match(editor, /data-act="rosterstudentdelete">원생 완전 삭제/);
  assert.match(editor, /action: 'student_delete'/);
  assert.match(editor, /계속하려면 학생 이름을 입력해 주세요/);
  assert.match(source, /case 'rosterstudentdelete': deleteRosterStudent\(el\)/);
});

test('재원생 목록은 수업 미지정 학생을 가나다순으로 먼저 표시한다', () => {
  const view = block('function viewRoster()', '/* ── 직원 관리');
  assert.match(view, /<summary><b>재원생 ' \+ managed\.length \+ '명 · 기본 정보 수정/);
  assert.match(view, /const hasAssignedLesson = student =>/);
  assert.match(view, /Number\(hasAssignedLesson\(a\)\) - Number\(hasAssignedLesson\(b\)\)/);
  assert.match(view, /localeCompare\(String\(b\.name \|\| ''\), 'ko'\)/);
  assert.match(view, /!assigned \? '<span class="tag warn">수업 미지정<\/span>/);
  assert.doesNotMatch(view, /등록 원생/);
});

test('동명이인은 이름을 바꾸지 않고 학교·학년과 필요한 경우 마스킹 보호자 번호로 구분한다', () => {
  const identity = block('function rosterIdentityPart(', 'function studentLinkCandidates(');
  assert.match(identity, /student\.school/);
  assert.match(identity, /student\.grade/);
  assert.match(identity, /digits\.slice\(-4\)/);
  assert.match(identity, /rosterStudentIdentityLabel/);
  assert.match(source, /selectableStudents\.map\(student =>[\s\S]{0,220}rosterStudentIdentityLabel\(student\)/);
});

test('관리자 원생 탭의 연락·온라인 프로그램·정기 평가 현황은 기본 접힘 상태다', () => {
  const view = block('function viewRoster()', '/* ── 직원 관리');
  for (const [className, title] of [
    ['roster-contact-status', '연락 현황'],
    ['roster-online-program', '온라인 프로그램'],
    ['roster-regular-exam', '정기 평가']
  ]) {
    assert.match(view, new RegExp(`<details class="card admin-collapsible ${className}"><summary>[\\s\\S]{0,120}${title}`));
    assert.doesNotMatch(view, new RegExp(`<details class="card admin-collapsible ${className}" open`));
  }
  assert.match(source, /\.admin-collapsible > summary::after \{ content: '펼치기'/);
  assert.match(source, /\.admin-collapsible\[open\] > summary::after \{ content: '접기'/);
});

test('학생별 수업 참고는 stable studentId로 모으고 같은 내용은 한 번만 남긴다', () => {
  const code = block('function studentLessonReferenceItems(', 'function rosterStudentInfoHtml(');
  const tasks = [
    { id: 'lesson-a', studentId: 'student-safe', guide: '숙제  루틴: 매일\n학생 특징: 꼼꼼함', refs: [
      { label: '교재 진도 확인' }, { label: '학생 특징: 꼼꼼함' }
    ] },
    { id: 'lesson-b', studentId: 'student-safe', guide: '숙제 루틴: 매일\n지금 목표: 독해', refs: [
      { label: '교재 진도 확인' }, { label: '오답 확인' }
    ] },
    { id: 'lesson-deleted', studentId: 'student-safe', guide: '삭제된 참고', refs: [], deleted: true },
    { id: 'lesson-other', studentId: 'student-other', guide: '다른 학생 참고', refs: [] }
  ];
  const collect = new Function('state', 'isLesson', 'lessonReferenceSteps',
    `${code}\nreturn studentLessonReferenceItems;`)(
      { tasks }, () => true, task => task.refs || []
    );
  assert.deepEqual(collect('student-safe'), [
    '숙제 루틴: 매일', '학생 특징: 꼼꼼함', '교재 진도 확인', '지금 목표: 독해', '오답 확인'
  ]);
  assert.deepEqual(collect(''), []);
});

test('관리자는 학생 정보 아래에서 stable studentId의 기존 수업을 확인하고 수정할 수 있다', () => {
  const code = block('function rosterStudentLessonTasks(', 'function rosterStudentInfoHtml(');
  const tasks = [
    { id: 'lesson-math', studentId: 'student-safe', subject: '수학', lessonHours: '2T', staffId: 'teacher-a', scheduleSlots: [{ days: [1, 3], startTime: '18:00', endTime: '19:50' }], start: '2026-08-21', lessonFormVersion: 1 },
    { id: 'lesson-eng', studentId: 'student-safe', subject: '영어', staffId: 'teacher-b', scheduleText: '금 19:00-19:50', lessonFormVersion: 1 },
    { id: 'lesson-deleted', studentId: 'student-safe', subject: '국어', staffId: 'teacher-a', deleted: true, lessonFormVersion: 1 },
    { id: 'lesson-other', studentId: 'student-other', subject: '과학', staffId: 'teacher-a', lessonFormVersion: 1 },
    { id: 'general-task', studentId: 'student-safe', subject: '사회', staffId: 'teacher-a' }
  ];
  const staff = { 'teacher-a': { name: '김남기' }, 'teacher-b': { name: '김혜지' } };
  const helpers = new Function('state', 'isLesson', 'staffById', 'lessonAssignmentScheduleText', 'lessonHoursValue', 'canEditLessonTask', 'esc',
    `${code}\nreturn { rosterStudentLessonTasks, rosterStudentLessonsHtml };`)(
      { tasks }, task => !!task.lessonFormVersion, id => staff[id] || null,
      slots => (slots || []).map(slot => slot.days.join('·') + ' ' + slot.startTime + '-' + slot.endTime).join(' / '),
      value => value || '', task => !!task.lessonFormVersion, escapeHtml
    );
  assert.deepEqual(helpers.rosterStudentLessonTasks('student-safe').map(task => task.id), ['lesson-math', 'lesson-eng']);
  assert.deepEqual(helpers.rosterStudentLessonTasks(''), []);
  const rendered = helpers.rosterStudentLessonsHtml({ id: 'student-safe' });
  assert.match(rendered, /수학/);
  assert.match(rendered, /김남기 선생님/);
  assert.match(rendered, /2T/);
  assert.match(rendered, /1·3 18:00-19:50/);
  assert.match(rendered, /data-act="lessonedit" data-id="lesson-math">이 수업 정보 수정/);
  assert.doesNotMatch(rendered, /lesson-deleted|lesson-other|general-task/);

  const popup = block('function showRosterStudentInfo(', 'let studentInfoRequestContext');
  assert.ok(popup.indexOf('>기본 정보 수정</button>') < popup.indexOf('>수업 정보 확인 및 수정</button>'));
  assert.match(popup, /data-act="rosterstudentlessons" data-id="' \+ esc\(student\.id\)/);
  assert.match(popup, /function showRosterStudentLessons\(studentId\)/);
  assert.match(popup, /rosterDb\.students\.find\(item => String\(item\.id\) === String\(studentId\)\)/);
  assert.doesNotMatch(popup, /find\([^\n]*name|student\.name\s*===/);
  assert.match(source, /case 'rosterstudentlessons': showRosterStudentLessons\(String\(id \|\| ''\)\)/);
});

test('팝업은 이름 추측 없이 현재 권한 범위의 stable studentId만 조회한다', () => {
  const code = block('function showRosterStudentInfo(', 'let rosterStudentEditor');
  assert.match(code, /rosterDb\.students\.find\(item => String\(item\.id\) === String\(studentId\)\)/);
  assert.doesNotMatch(code, /find\([^\n]*name|student\.name\s*===/);
  assert.match(code, /studentLessonReferenceItems\(student\.id\)/);
  assert.match(code, /session\.isAdmin[\s\S]*data-act="rosterstudentedit"/);
  assert.match(source, /\.student-info-name \{[^}]*min-height: 44px/);
  assert.match(source, /\.student-info-name:focus-visible/);
  assert.match(source, /@media\(max-width:430px\) \{[\s\S]*\.student-info-grid \{ grid-template-columns: 1fr; \}/);
});
