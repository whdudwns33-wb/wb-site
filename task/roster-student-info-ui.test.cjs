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
  const code = block('function rosterStudentInfoStatus(', 'function showRosterStudentInfo(');
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

test('관리자 신규 원생 추가와 고정 등록과목 중복 선택을 제공하고 교사 목록은 이름·학년만 표시한다', () => {
  const view = block('function viewRoster()', '/* ── 직원 관리');
  const editor = block('const ROSTER_SUBJECT_OPTIONS', '/* ── 신규 학생 30일 적응 관리');
  assert.match(view, /data-act="rosterstudentadd">기존 원생 추가<\/[\s\S]*data-act="rosterstudentnew">신규 원생 추가/);
  for (const field of ['data-rse-name', 'data-rse-school', 'data-rse-grade', 'data-rse-phone-self',
    'data-rse-phone-father', 'data-rse-phone-mother', 'data-rse-registration-date', 'data-rse-first-class-date']) {
    assert.match(editor, new RegExp(field));
  }
  for (const subject of ['국어', '영어', '수학', '사회', '과학', '독해사고력', '독해력수업', '독해력훈련', '사고력수학', '질답']) {
    assert.match(editor, new RegExp(subject));
  }
  assert.match(editor, /data-rse-subject/);
  const mineList = view.slice(view.indexOf('if (myName)'), view.indexOf('if (session.isStaffLink && !session.isAdmin)'));
  assert.match(mineList, /mineActive\.map[\s\S]*s\.name[\s\S]*s\.grade/);
  assert.doesNotMatch(mineList, /s\.subject|s\.memo|sessionModeBadgesForStudent/);
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
