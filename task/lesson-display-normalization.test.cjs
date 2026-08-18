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

test('structured lesson cards derive a short summary instead of repeating the nine-field intake', () => {
  const core = displayCore();
  const detail = core.taskCardDetail({
    title: '[수업] 학생 — 영어', taskKind: 'lesson_instruction', grade: '중1', subject: '영어',
    className: '블렌디드', scheduleText: '월·수·금 18:00-20:00', onlineProgram: '클래스카드',
    detail: '1. 이름 / 학년: 학생 / 중1\n2. 과목·반: 블렌디드\n3. 아주 긴 이전 입력'
  });
  assert.equal(detail, '중1 · 영어 · 블렌디드 · 월·수·금 18:00-20:00 · 클래스카드');
  assert.doesNotMatch(detail, /1\. 이름/);
  assert.ok(detail.length <= 160);
});

test('lesson references leave the lesson panel and every editable lesson button uses the same wording', () => {
  const panel = block('function taskPanel(t, date, c, editable)', '/** 수업 출결 표시용 */');
  assert.doesNotMatch(panel, /학생별 수업 참고 열기|lessonReferenceSteps\(t\)/);
  assert.match(panel, /!usesStandardLessonDisplay\(t\) && t\.guide/,
    '일반 업무 안내는 수업 참고 이동과 무관하므로 유지한다');
  assert.match(panel, /isLesson\(t\) \? '수업 정보 수정' : '업무 수정'/);
  const editor = block('function editTaskModal(id)', 'function saveEditedTask()');
  assert.match(editor, /isLesson\(t\) \? '수업 정보 수정' : '업무 수정'/);
  const order = block('function orderText(staffId, date)', '/** 방금 추가한 한 건을');
  const feedback = block('function computeFeedbackFields(t, date, fbCtx)', '/** 실제 발송');
  assert.match(order, /taskCardDetail\(t\)/);
  assert.match(feedback, /taskCardDetail\(t\)/);
});
