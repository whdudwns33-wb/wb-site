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
  assert.match(filters, /filter\(task => isStudyClaimed\(task, date\) && !\(getCheck\(task\.id, date\) \|\| \{\}\)\.dropped\)/);
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

test('paper planner separates subject, study detail, completion, and the daily timetable', () => {
  const planner = section('function studyPlannerCard(', 'function taskRow(');
  const compactRow = section('function plannerTaskRow(', 'function taskRow(');
  const css = section('<style>', '</style>');

  assert.match(planner, /aria-label="오늘 공부 체크리스트"/);
  assert.match(planner, /aria-label="과목별 순공시간"/);
  assert.match(planner, /TODAY STUDY PLANNER/);
  assert.match(planner, /PURE STUDY TIME/);
  assert.match(planner, /<span>과목<\/span><span>세부 공부내용<\/span><span>완료<\/span>/);
  assert.match(planner, /TIME TABLE/);
  assert.match(planner, /05–24시 · 10분 단위/);
  assert.match(planner, /studyTimePanel\(me, editable, true\)/);
  assert.match(compactRow, /planner-task-subject/);
  assert.match(compactRow, /planner-task-detail/);
  assert.match(compactRow, /planner-check-wrap/);
  assert.match(compactRow, /data-act="sttask"/);
  assert.match(css, /\.study-paper-head/);
  assert.match(css, /grid-template-columns: 62px minmax\(0, 1fr\) 38px/);
  assert.match(css, /\.study-timeline-row \{[^}]*repeat\(6,/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.study-planner \{ grid-template-columns: 1fr/);
});

test('timer closes real start-end segments and paints six ten-minute cells per hour', () => {
  const timerData = section('function stStoredSegments(', 'function studyTimePanel(');
  const timerPanel = section('function studyTimePanel(', 'function stCard(');
  const handlers = section("case 'sttask':", '/* 날짜 */');

  assert.match(timerData, /segments\.push\(\{ subj: r\.subj, taskId: r\.taskId \|\| '', start: Number\(r\.since\), end: end \}\)/);
  assert.match(timerData, /segments: stFreezeSegments\(sid, date\)/);
  assert.match(timerData, /\[0, 10, 20, 30, 40, 50\]/);
  assert.match(timerData, /for \(let hour = ST_TIMELINE_START; hour < ST_TIMELINE_END; hour\+\+\)/);
  assert.match(timerData, /study-timeline-cell/);
  assert.match(timerPanel, /id="studyTimeline"/);
  assert.match(handlers, /stStart\(me\.id, today\(\), subj, t\.id\)/);
  assert.match(handlers, /if \(stRunning\(me\.id, today\(\)\)\) stStop/);
  assert.match(html, /if \(turnOn && running && running\.taskId === t\.id\) stStop\(t\.staffId, today\(\)\)/);
});

test('weekly planner compares subject goals with recorded study time', () => {
  const helpers = section('const weekPlanKey', 'function weekBacklog(');
  const week = section('function viewWeek()', '/* ── 월간 플래너 ── */');
  const handlers = section("case 'weekgoal':", "case 'weekmove':");

  assert.match(helpers, /subjectGoals: \{\}, reflection: '', directorNote: ''/);
  assert.match(helpers, /stCategorySecs\(stSecs\(staffId, date\)\)/);
  assert.match(week, /과목별 목표시간/);
  assert.match(week, /actualSec \/ goalSec/);
  assert.match(week, /stWeekCard\(me, days\)/);
  assert.match(handlers, /data-weekgoal/);
  assert.match(handlers, /setCheck\(weekPlanKey\(me\.id\), mon/);
});

test('weekly planner uses the daily checklist and supports one-time task rescheduling', () => {
  const occurrence = section('const weekMoveKey', '/** 새 배부 공부만');
  const week = section('function viewWeek()', '/* ── 월간 플래너 ── */');
  const handlers = section("case 'weekmove':", "case 'weekreviewsave':");

  assert.match(occurrence, /function effectiveOccursOn/);
  assert.match(occurrence, /filter\(t => t\.staffId === staffId && effectiveOccursOn\(t, date\)\)/);
  assert.match(week, /<th class="subj">과목<\/th><th class="n">세부 공부내용<\/th>/);
  assert.match(week, /data-act="toggle"/);
  assert.match(week, /data-act="weekmove"/);
  assert.match(handlers, /t\.repeat !== 'once'/);
  assert.match(handlers, /setCheck\(weekMoveKey\(me\.id\), 'all'/);
});

test('weekly planner separates rollover work from unclaimed distributed study', () => {
  const helpers = section('function weekUnclaimedOffers(', 'let weekMoveDraft');
  const week = section('function viewWeek()', '/* ── 월간 플래너 ── */');

  assert.match(helpers, /studyOffersFor\(staffId, date\)/);
  assert.match(helpers, /carryOver\(staffId, days\[0\]\)/);
  assert.match(helpers, /move\.from === item\.date/);
  assert.match(week, /밀린 공부/);
  assert.match(week, /아직 가져오지 않은 배부 공부/);
  assert.match(week, /data-act="studyclaim"/);
});

test('student reflection and director feedback keep separate edit permissions', () => {
  const week = section('function viewWeek()', '/* ── 월간 플래너 ── */');
  const handlers = section("case 'weekreviewsave':", '/* 날짜 */');

  assert.match(week, /id="weekReflection"[\s\S]*?session\.isStaffLink/);
  assert.match(week, /id="weekDirectorNote"[\s\S]*?session\.isAdmin/);
  assert.match(handlers, /reflection: session\.isAdmin \? plan\.reflection/);
  assert.match(handlers, /directorNote: session\.isAdmin/);
});

test('consult storage and sync app identity remain unchanged', () => {
  assert.match(html, /wb_consult_v1/);
  assert.match(html, /const SYNC_APP = 'consult'/);
});
