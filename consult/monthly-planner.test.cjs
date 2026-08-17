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
    '시험·중요 일정',
    '이달의 목표',
    '월간 공부 달력',
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

test('monthly subject goals and analysis reuse real timer and checklist data', () => {
  const helpers = section('const monthPlanKey', 'function monthBacklog(');
  const month = section('function viewMonth()', '/* ── 지시서 작성 ── */');
  const handlers = section("case 'monthgoal':", "case 'montheventadd':");

  assert.match(helpers, /stCategorySecs\(stSecs\(staffId, date\)\)/);
  assert.match(helpers, /checklistTasksFor\(staffId, date\)/);
  assert.match(month, /monthSubjectStats\(me\.id, ymAdd\(ym, -1\)\)/);
  assert.match(month, /지난달보다/);
  assert.match(month, /전체 순공시간의/);
  assert.match(handlers, /data-monthgoal/);
  assert.match(handlers, /setCheck\(monthPlanKey\(me\.id\), ym/);
});

test('monthly calendar paints study-time intensity and opens the selected day', () => {
  const month = section('function viewMonth()', '/* ── 지시서 작성 ── */');

  assert.match(month, /maxStudySecs/);
  assert.match(month, /stTotal\(me\.id, d\)/);
  assert.match(month, /rgba\(127,179,244,/);
  assert.match(month, /data-act="daypick"/);
  assert.match(month, /파란색이 진할수록 실제 순공시간이 깁니다/);
});

test('monthly important events include D-day, scope, score, and preparation progress', () => {
  const helpers = section('const monthPlanKey', 'function viewMonth()');
  const month = section('function viewMonth()', '/* ── 지시서 작성 ── */');
  const handlers = section("case 'montheventadd':", "case 'monthmove':");

  assert.match(helpers, /function monthDday/);
  assert.match(helpers, /mEventRange/);
  assert.match(helpers, /mEventScore/);
  assert.match(month, /준비 ' \+ progressValue \+ '%/);
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
