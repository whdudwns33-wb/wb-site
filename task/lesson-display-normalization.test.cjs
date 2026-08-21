const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function block(from, to) {
  const start = html.indexOf(from);
  const end = html.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `${from} block`);
  return html.slice(start, end);
}

function displayCore() {
  const source = block('const LESSON_OPERATIONAL_STEP_LABELS = [', '/** 단계·수량을 고려한 개별 업무 진행률 */');
  return new Function(`${source}\nreturn { LESSON_OPERATIONAL_STEP_LABELS, taskSteps, lessonReferenceSteps, taskCardDetail };`)();
}

function scheduleDisplayCore() {
  const source = block('function daysForDisplay(days)', 'const initials =');
  return new Function('DOW_DISPLAY_RANK', 'LESSON_HOURS', 'DOW',
    `${source}\nreturn { groupedScheduleSlotsForDisplay, lessonScheduleSlotLabel };`)(
      { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 0: 6 },
      ['1T', '1.5T', '2T', '3T', '4T', '5T', '6T'],
      ['일', '월', '화', '수', '목', '금', '토']
    );
}

function titleDisplayCore() {
  const source = block('/** 제목 말머리는 데이터 판별용으로 보존하고 화면에서만 감춘다. */', '/* ── 인터뷰형 코멘트 생성 ──');
  return new Function(`let rosterDb = null;\n${source}\nreturn {
    schoolGradeDisplayLabel, taskTitlePrefix, taskTitleWithoutPrefix, taskDisplayTitle,
    setRoster(value) { rosterDb = value; }
  };`)();
}

const legacyLesson = () => ({
  id: 'legacy-lesson', title: '[수업] 학생 (중1) — 영어',
  steps: [1, 2, 3].map(index => ({ id: `legacy-${index}`, label: `기존 맞춤 ${index}` }))
});

test('new lesson dates use one five-step operation while historical checked dates remain intact', () => {
  const core = displayCore();
  const lesson = legacyLesson();
  const normalized = core.taskSteps(lesson, null);
  assert.deepEqual(normalized.map(step => step.label), core.LESSON_OPERATIONAL_STEP_LABELS);
  assert.equal(normalized.length, 5);
  assert.match(normalized[0].id, /-standard-step-1$/);

  const historical = core.taskSteps(lesson, { steps: { 'legacy-2': true } });
  assert.equal(historical, lesson.steps);
  assert.deepEqual(core.lessonReferenceSteps(lesson), lesson.steps);

  const ordinary = { id: 'work', title: '일반 업무', steps: [{ id: 'one', label: '한 단계' }] };
  assert.equal(core.taskSteps(ordinary, null), ordinary.steps);
  const consulting = { id: 'consulting', title: '[컨설팅] 학생', steps: [{ id: 'talk', label: '상담' }] };
  assert.equal(core.taskSteps(consulting, null), consulting.steps);
});

test('already standard lessons preserve their stored IDs and do not duplicate reference guidance', () => {
  const core = displayCore();
  const lesson = {
    id: 'new-lesson', title: '[수업] 학생 — 수학',
    steps: core.LESSON_OPERATIONAL_STEP_LABELS.map((label, index) => ({ id: `stored-${index}`, label }))
  };
  assert.equal(core.taskSteps(lesson, null), lesson.steps);
  assert.deepEqual(core.lessonReferenceSteps(lesson), []);
});

test('structured lesson cards omit title and schedule duplicates from the second line', () => {
  const core = displayCore();
  const detail = core.taskCardDetail({
    title: '[수업] 학생 — 영어', taskKind: 'lesson_instruction', grade: '중1', subject: '영어',
    className: '블렌디드', scheduleText: '월·수·금 18:00-20:00', onlineProgram: '클래스카드',
    detail: '1. 이름 / 학년: 학생 / 중1\n2. 과목·반: 블렌디드\n3. 아주 긴 이전 입력'
  });
  assert.equal(detail, '클래스카드');
  assert.doesNotMatch(detail, /중1|영어|블렌디드|월·수·금|18:00/);
  assert.doesNotMatch(detail, /1\. 이름/);
  assert.ok(detail.length <= 160);
  assert.equal(core.taskCardDetail({ taskKind: 'lesson_instruction', detail: '기존 입력', onlineProgram: '없음' }), '');
});

test('lesson metadata groups equal time and hours while separating different schedules', () => {
  const core = scheduleDisplayCore();
  const grouped = core.groupedScheduleSlotsForDisplay([
    { days: [3], startTime: '18:00', endTime: '19:50', lessonHours: '2T' },
    { days: [1], startTime: '18:00', endTime: '19:50', lessonHours: '2T' },
    { days: [5], startTime: '20:00', endTime: '20:50', lessonHours: '1T' }
  ]);
  assert.deepEqual(grouped, [
    { days: [1, 3], startTime: '18:00', endTime: '19:50', lessonHours: '2T' },
    { days: [5], startTime: '20:00', endTime: '20:50', lessonHours: '1T' }
  ]);
  assert.deepEqual(grouped.map(core.lessonScheduleSlotLabel), [
    '월·수 18:00–19:50 · 2T', '금 20:00–20:50 · 1T'
  ]);
});

test('lesson and order prefixes stay in stored data but are hidden from display titles', () => {
  const core = titleDisplayCore();
  const lesson = { title: '[수업] 학생 (2) — 수학', grade: '2' };
  const order = { title: '[주문] 수학 교재' };
  assert.equal(core.taskDisplayTitle(lesson), '학생 (2) — 수학');
  assert.equal(core.taskDisplayTitle(order), '수학 교재');
  assert.equal(lesson.title, '[수업] 학생 (2) — 수학');
  assert.equal(order.title, '[주문] 수학 교재');
  assert.equal(core.taskTitlePrefix(lesson), '[수업]');
  assert.equal(core.taskTitlePrefix(order), '[주문]');
  assert.equal(core.taskDisplayTitle({ title: '[컨설팅] 학생' }), '[컨설팅] 학생');
});

test('lesson display grade uses the stable student roster school without changing original values', () => {
  const core = titleDisplayCore();
  const roster = { students: [
    { id: '10000001', school: '치평중', grade: '2' },
    { id: '10000002', school: '서석고등학교', grade: '1학년' },
    { id: '10000003', school: '유안초', grade: '초 4학년' }
  ] };
  core.setRoster(roster);
  assert.equal(core.taskDisplayTitle({
    title: '[수업] 가학생 (2) — 수학', studentId: '10000001', grade: '2'
  }), '가학생 (중2) — 수학');
  assert.equal(core.taskDisplayTitle({
    title: '[수업] 나학생 (1) — 영어', studentId: '10000002', grade: '1'
  }), '나학생 (고1) — 영어');
  assert.equal(core.taskDisplayTitle({
    title: '[수업] 다학생 — 국어', studentId: '10000003', grade: '4'
  }), '다학생 (초4) — 국어');
  assert.deepEqual(roster.students.map(student => student.grade), ['2', '1학년', '초 4학년']);
});

test('grade display does not guess a school level when school information is unavailable', () => {
  const core = titleDisplayCore();
  assert.equal(core.schoolGradeDisplayLabel('', '2'), '2');
  assert.equal(core.schoolGradeDisplayLabel('학교급 확인 필요', '2'), '2');
  assert.equal(core.schoolGradeDisplayLabel('치평중', '중 2학년'), '중2');
});

test('lesson references leave the lesson panel and every editable lesson button uses the same wording', () => {
  const panel = block('function taskPanel(t, date, c, editable)', '/** 수업 출결 표시용 */');
  assert.doesNotMatch(panel, /학생별 수업 참고 열기|lessonReferenceSteps\(t\)/);
  assert.match(panel, /!usesStandardLessonDisplay\(t\) && t\.guide/,
    '일반 업무 안내는 수업 참고 이동과 무관하므로 유지한다');
  assert.doesNotMatch(panel, /data-act="lessonedit"/,
    '수업 정보 수정은 학생정보 · 업무지시 팝업으로 이동한다');
  assert.match(panel, /data-act="etask"[\s\S]{0,120}업무 수정/,
    '일반 업무 수정은 기존 수업진행 외 업무 패널에 유지한다');
  const briefing = block('function showTodayLessonBriefing(taskId, lessonDate)', '/* 보호자 공개 내용은');
  assert.match(briefing, /data-act="lessonedit"[\s\S]{0,120}수업 정보 수정/);
  const editor = block('function editTaskModal(id)', 'function saveEditedTask()');
  assert.match(editor, /isLesson\(t\) \? '수업 정보 수정' : '업무 수정'/);
  assert.match(editor, /titlePrefix: taskTitlePrefix\(t\)/);
  assert.match(editor, /taskTitleWithoutPrefix\(t\)/);
  const saveEditor = block('function saveEditedTask()', '/* ══════════════════════════════════════════════════════');
  assert.match(saveEditor, /eForm\.titlePrefix && !visibleTitle\.startsWith\(eForm\.titlePrefix\)/);
  assert.match(saveEditor, /eForm\.titlePrefix \+ ' ' \+ visibleTitle : visibleTitle/);
  const order = block('function orderText(staffId, date)', '/** 방금 추가한 한 건을');
  const feedback = block('function computeFeedbackFields(t, date, fbCtx)', '/** 실제 발송');
  assert.match(order, /taskCardDetail\(t\)/);
  assert.match(feedback, /taskCardDetail\(t\)/);
});
