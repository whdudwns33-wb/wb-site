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

test('monthly planner follows the agreed information order', () => {
  const month = section('function viewMonth()', '/* ── 지시서 작성 ── */');
  const labels = [
    'agendaCalendarCard(me, ym)',
    '시험·중요 일정',
    '이달의 목표',
    '과목별 분석',
    '이번 달 미완료 공부',
    '월간 리포트'
  ];
  let previous = -1;
  labels.forEach(label => {
    const at = month.indexOf(label);
    assert.ok(at > previous, `${label} must follow the previous monthly section`);
    previous = at;
  });
});

test('monthly information is split into three focused transient views', () => {
  const month = section('function viewMonth()', '/* ══════════════════════════════════════════════════════\n   학사관리');
  const nav = section('const MONTH_SECTIONS', 'function viewMonth()');
  const handlers = section("case 'monthsection':", "case 'agendapick':");

  assert.match(html, /let monthSection = 'calendar'/);
  assert.match(nav, /calendar: \{ label: '캘린더'/);
  assert.match(nav, /plan: \{ label: '월간 계획'/);
  assert.match(nav, /report: \{ label: '분석·리포트'/);
  assert.match(nav, /role="tablist"/);
  assert.match(nav, /aria-selected=/);
  assert.match(month, /monthSectionNav\(backlog\.length\)/);
  assert.match(month, /monthSection === 'calendar'[\s\S]*?agendaCalendarCard\(me, ym\)[\s\S]*?return h/);
  assert.ok((month.match(/monthSection === 'plan'/g) || []).length >= 2,
    'planning cards and unfinished work must share the planning view');
  assert.ok((month.match(/monthSection === 'report'/g) || []).length >= 2,
    'analysis and report cards must share the report view');
  assert.match(handlers, /hasOwnProperty\.call\(MONTH_SECTIONS, nextSection\)/);
  assert.match(handlers, /monthSection = nextSection/);
  assert.doesNotMatch(handlers, /save\(|setCheck\(|queueSync\(/,
    'switching the presentation must not mutate consult data');
});

test('monthly subject goals and analysis reuse real timer and checklist data', () => {
  const helpers = section('const monthPlanKey', 'function monthBacklog(');
  const month = section('function viewMonth()', '/* ── 지시서 작성 ── */');
  const handlers = section("case 'monthgoal':", "case 'montheventadd':");

  assert.match(helpers, /stCategorySecs\(stSecs\(staffId, date\)\)/);
  assert.match(helpers, /checklistTasksFor\(staffId, date\)/);
  assert.match(month, /monthSubjectStats\(me\.id, ymAdd\(ym, -1\)\)/);
  assert.match(month, /previousStats\[key\]\.secs/);
  assert.match(month, /전체 순공시간의/);
  assert.match(handlers, /data-monthgoal/);
  assert.match(handlers, /setCheck\(monthPlanKey\(me\.id\), ym/);
});

test('monthly analysis uses a distribution summary and comparison table instead of goal progress rows', () => {
  const analysis = section('/* 과목별 분석 */', '/* 미완료 공부 */');

  assert.match(analysis, /month-share-track/);
  assert.match(analysis, /이번 달 과목 비중/);
  assert.match(analysis, /100 - subjectReportRows\.reduce/,
    'displayed whole-number subject shares must add up to 100%');
  assert.match(analysis, /과목별 월간 비교표/);
  ['과목', '이번 달', '지난달', '증감', '완료율'].forEach(label =>
    assert.match(analysis, new RegExp('<th>' + label + '<\\/th>')));
  assert.match(analysis, /row\.completion \+ '% · ' \+ row\.current\.done \+ '\/' \+ row\.current\.total \+ '건'/);
  assert.doesNotMatch(analysis, /month-subject-(?:grid|row|track)/,
    'analysis must not visually reuse the goal progress component');
});

test('monthly calendar focuses on important dates and opens the selected day', () => {
  const month = section('function viewMonth()', '/* ── 지시서 작성 ── */');
  const agenda = section('function agendaCalendarCard(', 'function monthSubjectGoalModal(');

  assert.match(month, /agendaCalendarCard\(me, ym\)/);
  assert.match(agenda, /const monthItems = agendaImportantItemsFor/);
  assert.match(agenda, /agendaUpcomingImportantItems/);
  assert.doesNotMatch(agenda, /maxStudySecs|stTotal\(me\.id, date\)|rgba\(127,179,244,|agendaFilter/);
  assert.match(agenda, /data-act="agendapick"/);
  assert.match(agenda, /중요한 일정/);
  assert.match(agenda, /시험·수행평가·원장이 지정한 중요 일정만/);
  assert.match(agenda, /다가오는 일정/);
  assert.match(agenda, /캘린더 색상 안내/);
  assert.match(agenda, /class="exam"><\/i>시험/);
  assert.match(agenda, /class="performance"><\/i>수행평가/);
  assert.match(agenda, /class="important"><\/i>중요 일정/);
  assert.match(agenda, /const editable = session\.isStaffLink \|\| session\.isAdmin/);
  assert.match(agenda, /data-act="montheventadd" data-date="' \+ agendaDate/);
  assert.match(agenda, /<details class="agenda-more">/);
});

test('monthly important events include D-day, scope, score, and preparation progress', () => {
  const helpers = section('const monthPlanKey', 'function viewMonth()');
  const month = section('function viewMonth()', '/* ── 지시서 작성 ── */');
  const handlers = section("case 'montheventadd':", "case 'monthmove':");

  assert.match(helpers, /function monthDday/);
  assert.match(helpers, /mEventRange/);
  assert.match(helpers, /mEventScore/);
  assert.match(helpers, /function monthEventModal\(ym, selectedDate\)/);
  assert.match(helpers, /ymOf\(selectedDate\) === ym \? selectedDate : ym \+ '-01'/);
  assert.match(month, /준비 ' \+ progressValue \+ '%/);
  assert.match(handlers, /monthEventModal\(ymCursor, el\.dataset\.date \|\| ''\)/);
  assert.match(handlers, /event\.progress = Math\.max\(0, Math\.min\(100/);
  assert.match(handlers, /plan\.events\.push/);
});

test('unfinished carried study can move, roll forward, or close without deletion', () => {
  const filters = section('const isStudyOffer', 'const studyOffersFor');
  const helpers = section('function monthBacklog(', 'function viewMonth()');
  const month = section('function viewMonth()', '/* ── 지시서 작성 ── */');
  const handlers = section("case 'monthmove':", "case 'monthreviewsave':");

  assert.match(filters, /\.dropped/);
  assert.match(helpers, /task\.carry && !isDone\(task\.id, date\)/);
  assert.match(helpers, /task\.repeat === 'once'/);
  assert.match(helpers, /groupId: 'month-carry-'/);
  assert.match(helpers, /dropReason: 'rescheduled'/);
  assert.match(month, /data-act="monthmove"/);
  assert.match(month, /data-act="monthnext"/);
  assert.match(month, /data-act="monthdrop"/);
  assert.match(handlers, /dropReason: 'monthly-close'/);
});

test('monthly report separates student reflection from director guidance', () => {
  const month = section('function viewMonth()', '/* ── 지시서 작성 ── */');
  const handlers = section("case 'monthreviewsave':", '/* 날짜 */');

  assert.match(month, /총 순공시간/);
  assert.match(month, /하루 평균/);
  assert.match(month, /목표 달성일/);
  assert.match(month, /완료한 공부/);
  assert.match(month, /id="monthReflection"[\s\S]*?session\.isStaffLink/);
  assert.match(month, /id="monthDirectorNote"[\s\S]*?session\.isAdmin/);
  assert.match(month, /id="monthNextFocus"[\s\S]*?session\.isAdmin/);
  assert.match(handlers, /reflection: session\.isAdmin \? plan\.reflection/);
  assert.match(handlers, /nextFocus: session\.isAdmin/);
});

test('new monthly progress goals require and persist a subject', () => {
  const month = section('function viewMonth()', '/* ── 지시서 작성 ── */');
  const add = section("case 'gadd':", "case 'gdel':");

  assert.match(month, /id="gSubject"/);
  assert.match(add, /과목을 선택해 주세요/);
  assert.match(add, /studySubject: subjectKey/);
});

test('monthly data stays in consult checks and keeps the existing storage identity', () => {
  assert.match(html, /const monthPlanKey = staffId => '__monthplan__' \+ staffId/);
  assert.match(html, /wb_consult_v1/);
  assert.match(html, /const SYNC_APP = 'consult'/);
});
