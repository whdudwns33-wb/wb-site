const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const section = (start, end) => {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  return from >= 0 && to > from ? html.slice(from, to) : '';
};

test('study subjects use the requested fixed pastel palette including gray other', () => {
  const css = section('<style>', '</style>');
  const subjects = section('const STUDY_SUBJECTS', 'const STUDY_SUBJECT_KEYS');

  assert.match(css, /--subject-korean:\s+#7FB3F4/);
  assert.match(css, /--subject-english:\s+#F49ABC/);
  assert.match(css, /--subject-math:\s+#82CFA2/);
  assert.match(css, /--subject-explore:\s+#E7C85C/);
  assert.match(css, /--subject-other:\s+#A8AFB8/);
  [['korean', '국어'], ['english', '영어'], ['math', '수학'], ['explore', '탐구'], ['other', '기타']]
    .forEach(([key, label]) => {
      assert.match(subjects, new RegExp('\\b' + key + ":\\s+\\{ label: '" + label + "'"));
    });
});

test('today places distributed study before the planner and quick add', () => {
  const today = section('function viewToday()', 'function studyOffersCard(');
  const offerAt = today.indexOf('studyOffersCard(me, cursor, offers)');
  const plannerAt = today.indexOf('studyPlannerCard(me, cursor, list, carry, editable)');
  const quickAt = today.indexOf('id="qSubject"');

  assert.ok(offerAt >= 0, 'distributed study card must render');
  assert.ok(plannerAt > offerAt, 'planner must follow distributed study');
  assert.ok(quickAt > plannerAt, 'quick add must follow the planner');
});

test('director study stays outside the checklist until the student claims it', () => {
  const filters = section('const isStudyOffer', 'const getCheck');
  const claim = section("case 'studyclaim':", "case 'toggle':");
  const quick = section("case 'qadd':", '/* 카톡 문장 붙여넣기 */');

  assert.match(filters, /task\.requiresClaim/);
  assert.match(filters, /filter\(task => isStudyClaimed\(task, date\)\)/);
  assert.match(claim, /session\.isStaffLink/);
  assert.match(claim, /t\.staffId !== session\.staffId/);
  assert.match(claim, /setCheck\(id, date, \{ claimed: true, claimedAt: now\(\) \}\)/);
  assert.match(quick, /requiresClaim: actor\(\) !== 'staff'/);
});

test('quick add, task edit, and batch issue require and persist a subject', () => {
  const today = section('function viewToday()', 'function studyOffersCard(');
  const modal = section('function editTaskModal(', 'function saveEditedTask(');
  const saveEdit = section('function saveEditedTask()', '8-1. 말로 쓴 지시를 업무로');
  const write = section('function viewWrite()', 'function draftCard(');
  const quick = section("case 'qadd':", '/* 카톡 문장 붙여넣기 */');
  const batch = section("case 'wadd':", '/* 설정 */');

  assert.match(today, /id="qSubject"/);
  assert.match(modal, /id="eSubject"/);
  assert.match(write, /id="wSubject"/);
  [saveEdit, quick, batch].forEach(source => {
    assert.match(source, /과목 카테고리를 선택해 주세요/);
    assert.match(source, /studySubject/);
  });
});

test('planner combines the checklist with fixed-category study-time bars', () => {
  const planner = section('function studyPlannerCard(', 'function taskRow(');
  const timer = section('function studyTimePanel(', 'function stCard(');
  const css = section('<style>', '</style>');

  assert.match(planner, /aria-label="오늘 공부 체크리스트"/);
  assert.match(planner, /aria-label="과목별 순공시간"/);
  assert.match(planner, /TODAY STUDY PLANNER/);
  assert.match(planner, /PURE STUDY TIME/);
  assert.match(planner, /studyTimePanel\(me, editable, true\)/);
  assert.match(timer, /STUDY_SUBJECT_KEYS\.map/);
  assert.match(timer, /data-stbar=/);
  assert.match(timer, /chartMax \/ 600/);
  assert.match(timer, /10분 단위 순공시간 기록/);
  assert.match(css, /\.study-paper-head/);
  assert.match(css, /background-size: calc\(100% \/ var\(--planner-slots, 18\)\) 100%/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.study-planner \{ grid-template-columns: 1fr/);
});

test('consult storage and sync app identity remain unchanged', () => {
  assert.match(html, /wb_consult_v1/);
  assert.match(html, /const SYNC_APP = 'consult'/);
});
