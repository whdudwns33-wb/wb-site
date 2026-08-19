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

test('study subjects use the requested pastel palette with separate social and science', () => {
  const css = section('<style>', '</style>');
  const subjects = section('const STUDY_SUBJECTS', 'const STUDY_SUBJECT_KEYS');

  assert.match(css, /--subject-korean:\s+#7FB3F4/);
  assert.match(css, /--subject-english:\s+#F49ABC/);
  assert.match(css, /--subject-math:\s+#82CFA2/);
  assert.match(css, /--subject-social:\s+#E7C85C/);
  assert.match(css, /--subject-science:\s+#B9A7F5/);
  assert.match(css, /--subject-other:\s+#A8AFB8/);
  [['korean', '국어'], ['english', '영어'], ['math', '수학'], ['social', '사회'], ['science', '과학'], ['other', '기타']]
    .forEach(([key, label]) => {
      assert.match(subjects, new RegExp('\\b' + key + ":\\s+\\{ label: '" + label + "'"));
    });
});

test('today places collapsible lectures directly below collapsible distributed study', () => {
  const state = section('let route =', 'function go(');
  const today = section('function viewToday()', 'function studyOffersCard(');
  const totalAt = today.indexOf('studyTotalHeroCard(me, cursor)');
  const offerAt = today.indexOf('studyOffersCard(me, cursor, offers)');
  const lectureAt = today.indexOf('ingTodayCard(me, editable)');
  const plannerAt = today.indexOf('studyPlannerCard(me, cursor, list, carry, editable)');
  const quickAt = today.indexOf('id="qSubject"');

  assert.ok(totalAt >= 0, 'large total study time must render');
  assert.ok(offerAt > totalAt, 'distributed study must follow total study time');
  assert.ok(lectureAt > offerAt, 'lectures must immediately follow distributed study');
  assert.ok(quickAt > lectureAt, 'quick add must follow lectures');
  assert.ok(plannerAt > quickAt, 'planner must follow quick add');

  const offers = section('function studyOffersCard(', 'function studyPlannerCard(');
  const lectures = section('function ingTodayCard(', '/* ── 인강 탭 ── */');
  const handler = section("case 'todayfold':", "case 'studyclaim':");
  const css = section('<style>', '</style>');
  [offers, lectures].forEach(source => {
    assert.match(source, /today-fold-card/);
    assert.match(source, /data-act="todayfold"/);
    assert.match(source, /aria-expanded/);
  });
  assert.match(state, /const todayFoldState = \{ studyOffers: true, lectures: true \}/);
  assert.match(handler, /todayFoldState\[section\] = !todayFoldState\[section\]/);
  assert.match(html, /setCheck\(id, date, \{ claimed: true, claimedAt: now\(\) \}\);\s+todayFoldState\.studyOffers = true/);
  assert.match(html, /ingPatchItem\(me\.id, planDate, item\.cid, Number\(item\.seq\), \{ claimed: true, claimedAt: now\(\) \}\);\s+todayFoldState\.lectures = true/);
  assert.match(css, /\.today-fold-head/);
});

test('today restores a large live total study time between student summary and distributed study', () => {
  const today = section('function viewToday()', 'function studyOffersCard(');
  const hero = section('function studyTotalHeroCard(', 'function studyOffersCard(');
  const ticker = section('let lastTimelineMinute', '/* ── 새 버전 감지 ──');
  const css = section('<style>', '</style>');

  assert.ok(today.indexOf('studyTotalHeroCard(me, cursor)') < today.indexOf('studyOffersCard(me, cursor, offers)'));
  assert.match(hero, /TOTAL PURE STUDY TIME/);
  assert.match(hero, /data-st-total/);
  assert.match(hero, /fmtHMS\(total\)/);
  assert.match(css, /\.study-total-hero \.study-time-total \{ font-size: clamp\(38px, 10vw, 54px\)/);
  assert.match(ticker, /querySelectorAll\('\[data-st-total\]\[data-st-date=/);
  assert.match(ticker, /totalEls\.forEach/);
});

test('legacy explore remains compatible while tasks split into social and science', () => {
  const subjects = section('function studySubjectKey(', 'function studySubjectOptions(');
  const timer = section('const ST_DEFAULT', 'const stGoalMin');
  const stats = section('function monthSubjectStats(', 'function monthReport(');
  const handler = section("case 'sttask':", "case 'stsubjadd':");

  assert.match(subjects, /raw === 'explore' \|\| raw === '탐구'/);
  assert.match(subjects, /return 'social'/);
  assert.match(subjects, /과학\|과탐\|물리\|화학\|생명\|생물\|지구과학/);
  assert.match(subjects, /\? 'science' : 'social'/);
  assert.match(timer, /\['국어', '영어', '수학', '사회', '과학', '기타'\]/);
  assert.match(timer, /split\.push\('사회', '과학'\)/);
  assert.match(stats, /taskStudySubjectKey\(task\)/);
  assert.match(handler, /taskStudySubject\(t\)\.label/);
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

test('completed distributed study is crossed out in both the offer list and checklist', () => {
  const offers = section('function studyOffersCard(', 'function studyPlannerCard(');
  const css = section('<style>', '</style>');

  assert.match(offers, /subject\.className \+ \(done \? ' done' : ''\)/);
  assert.match(css, /\.study-offer\.done \.task-t, \.study-offer\.done \.task-d \{[^}]*text-decoration: line-through/);
  assert.match(css, /\.planner-task-row\.done \.planner-task-title \{[^}]*text-decoration: line-through/);
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

test('learning distribution replaces the legacy employee form with a focused study workflow', () => {
  const write = section('function viewWrite()', 'function draftCard(');
  const draft = section('function draftCard()', 'function writePublishedResult(');
  const publish = section("case 'wadd':", '/* 설정 */');
  const tabs = section('function renderTabs()', 'function viewPendingAdd');
  const permissions = section('function canEditTask(', 'function paintStatus(');
  const deleteCase = section("case 'deltask':", '/* AI 가져오기 */');

  assert.match(tabs, /\['write', '학습 배부'/);
  assert.match(write, /📚 학습 배부/);
  assert.match(write, /빠른 학습 배부/);
  assert.match(write, /id="wEstimatedMin"/);
  assert.match(write, /write-advanced/);
  assert.match(write, /data-go="academic"/);
  assert.match(write, /data-go="ingang"/);
  assert.match(write, /data-go="study"/);
  assert.doesNotMatch(write, /스터디포스 구독 CS 전화|받는 직원|업무 지시 직접 추가/);
  assert.match(draft, /writeDraftLoadRows\(\)/);
  assert.match(draft, /가능시간 미설정/);
  assert.match(draft, /data-act="wedit"/);
  assert.match(draft, /data-act="wcopy"/);
  assert.match(publish, /estimatedMin: estimatedMin/);
  assert.match(publish, /origin: session\.isStaffLink \? 'manager' : 'admin'/);
  assert.match(publish, /requiresClaim: true/);
  assert.match(publish, /writePublishedResult\(published\)/);
  assert.match(permissions, /isManager\(\).*t\.origin === 'manager'/);
  assert.match(deleteCase, /if \(!canEditTask\(t\)\)/);
});

test('AI and Kakao study imports enter the same reviewed distribution draft', () => {
  const parser = section('function matchDuration(', '/* ══════════════════════════════════════════════════════\n   9. AI 지시서');
  const importer = section('function applyAssignments(', '/* ══════════════════════════════════════════════════════\n   10. 이벤트');

  assert.match(parser, /estimatedMin: duration \? duration\.minutes : 50/);
  assert.match(parser, /studySubject: inferStudySubjectFromText/);
  assert.match(importer, /등록된 학생 이름을 확인해 주세요/);
  assert.match(importer, /studySubjectKey\(item\.studySubject \|\| item\.subject \|\| inferStudySubjectFromText/);
  assert.match(importer, /estimatedMin/);
  assert.match(importer, /staffIds: \[student\.id\]/);
  assert.match(importer, /draft\.push\(\.\.\.queued\)/);
  assert.doesNotMatch(importer, /state\.tasks\.push|save\(\)|queueSync\(\)/);
  assert.match(html, /"studySubject": "수학"/);
  assert.match(html, /"estimatedMin": 50/);
  assert.doesNotMatch(html, /"staff": "김선생"|구독 CS 전화/);

  const source = html.match(/function applyAssignments\(input, preConfirmed\) \{[\s\S]*?\n\}/)?.[0] || '';
  const queued = [];
  const messages = [];
  const apply = Function('draft', 'messages', `
    let route = 'write';
    const session = { isAdmin: true };
    const students = [{ id: 'student-1', name: '김민준', owner: false }];
    const staffByName = name => students.find(student => student.name === name);
    const studySubjectKey = value => value === '수학' ? 'math' : value || 'other';
    const inferStudySubjectFromText = () => 'other';
    const uid = (() => { let n = 0; return () => 'id-' + (++n); })();
    const today = () => '2026-08-19';
    const closeModal = () => {};
    const render = () => {};
    const toast = message => messages.push(message);
    ${source}
    return applyAssignments;
  `)(queued, messages);
  apply({ assignments: [{ staff: '김민준', studySubject: '수학', title: '5단원 문제', estimatedMin: 40,
    steps: ['개념 확인', '문제 풀기'], repeat: 'once' }] });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].studySubject, 'math');
  assert.equal(queued[0].estimatedMin, 40);
  assert.deepEqual(queued[0].staffIds, ['student-1']);
  assert.deepEqual(queued[0].steps.map(step => step.label), ['개념 확인', '문제 풀기']);
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
  assert.match(planner, /계획·실제 · 10분 단위/);
  assert.match(planner, /studyTimePanel\(me, editable, true, date\)/);
  assert.match(planner, /ingChecklistItems\(me\.id, date\)/);
  assert.match(planner, /lectures\.map\(item => plannerLectureRow\(me\.id, item, editable\)\)/);
  assert.match(compactRow, /planner-task-subject/);
  assert.match(compactRow, /planner-task-detail/);
  assert.match(compactRow, /planner-check-wrap/);
  assert.match(compactRow, /data-act="sttask"/);
  assert.match(compactRow, /plannerTaskMark\(t, date, c, isCarry\)/);
  assert.match(css, /\.study-paper-head/);
  assert.match(css, /grid-template-columns: 62px minmax\(0, 1fr\) 38px/);
  assert.match(css, /\.planner-task-row \{[^}]*background: var\(--subject-bg/);
  assert.match(css, /\.planner-task-subject \{[^}]*background: var\(--subject-bg\)/);
  assert.match(css, /\.planner-task-row\.done \.planner-check, \.planner-check\.is-done \{[^}]*background: var\(--subject-bg\)/);
  assert.match(css, /\.planner-check\.is-carry \{[^}]*background: var\(--subject-bg\)/);
  assert.match(css, /\.planner-check\.is-negative \{[^}]*background: #FFF3F3/);
  assert.match(css, /\.study-timeline-plan \{[^}]*border: 1px dashed var\(--subject-color\)[^}]*background: var\(--subject-bg\)/);
  assert.match(css, /\.study-timeline-actual \{[^}]*border: 2px solid var\(--subject-color\)[^}]*background: var\(--subject-bg\)/);
  assert.match(css, /\.study-timeline-row \{[^}]*repeat\(6,/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.study-planner \{ grid-template-columns: 1fr/);
});

test('student claims a scheduled lecture into the study planner with shared progress and timer data', () => {
  const lectureData = section('function ingCourseSubjectKey(', 'function ingStats(');
  const lectureToggle = section('function ingToggle(', '/** 오늘 이전 미완료를 전부 오늘로');
  const lectureRow = section('function plannerLectureRow(', 'function taskRow(');
  const todayLecture = section('function ingRow(', '/** 오늘 화면에 붙는 인강 카드 */');
  const handlers = section("case 'ingclaim':", "case 'ingreview':");
  const timer = section("case 'ingsttask':", "case 'sttask':");
  const today = section('function viewToday()', 'function studyOffersCard(');

  assert.match(lectureData, /const ingIsClaimed = item => !!\(item && \(item\.claimed \|\| item\.done\)\)/);
  assert.match(lectureData, /ingPlan\(sid, date\)\.filter\(ingIsClaimed\)/);
  assert.match(lectureData, /const ingTimerTaskId = \(cid, seq\) => 'ing:'/);
  assert.match(lectureToggle, /claimed: true, claimedAt: now\(\)/);
  assert.match(todayLecture, /내 체크리스트로 가져오기/);
  assert.match(todayLecture, /오늘 체크리스트로 가져오기/);
  assert.match(todayLecture, /data-act="ingclaim"/);
  assert.doesNotMatch(todayLecture, /class="box"|data-act="ingcheck"/);
  assert.match(handlers, /session\.isStaffLink/);
  assert.match(handlers, /planDate > today\(\)/);
  assert.match(handlers, /ingPatchItem[\s\S]*?claimed: true, claimedAt: now\(\)/);
  assert.match(handlers, /planDate < today\(\)[\s\S]*?ingSavePlan\(me\.id, planDate/);
  assert.match(handlers, /밀린 인강을 오늘 스터디 플래너로 옮겼습니다/);
  assert.match(lectureRow, /data-act="ingsttask"/);
  assert.match(lectureRow, /data-act="ingcheck"/);
  assert.match(lectureRow, /ingCourseSubject\(found\.course\)/);
  assert.match(timer, /stStart\(me\.id, today\(\), subject, taskId\)/);
  assert.match(timer, /ingIsClaimed\(item\)/);
  assert.match(handlers, /running\.taskId === ingTimerTaskId\(item\.cid, item\.seq\)/);
  assert.match(today, /checklistTotal = p\.total \+ lectureChecklist\.length/);
  assert.match(today, /checklistDone = p\.done \+ lectureChecklist\.filter\(item => item\.done\)\.length/);
});

test('timer closes real start-end segments and paints six ten-minute cells per hour', () => {
  const timerData = section('function stStoredSegments(', 'function studyTimePanel(');
  const timerPanel = section('function studyTimePanel(', 'function stCard(');
  const planPanel = section('function studyPlanPanel(', 'function tbAddModal(');
  const today = section('function viewToday()', 'function studyTotalHeroCard(');
  const handlers = section("case 'sttask':", '/* 날짜 */');

  assert.match(timerData, /segments\.push\(\{ subj: r\.subj, taskId: r\.taskId \|\| '', start: Number\(r\.since\), end: end \}\)/);
  assert.match(timerData, /segments: stFreezeSegments\(sid, date\)/);
  assert.match(timerData, /\[0, 10, 20, 30, 40, 50\]/);
  assert.match(timerData, /for \(let hour = ST_TIMELINE_START; hour < ST_TIMELINE_END; hour\+\+\)/);
  assert.match(timerData, /study-timeline-cell/);
  assert.match(timerData, /const plans = tbOf\(sid, date\)/);
  assert.match(timerData, /studyPlanCell\(plans, hour, minute\)/);
  assert.match(timerData, /study-timeline-plan/);
  assert.match(timerData, /study-timeline-actual/);
  assert.match(timerPanel, /id="studyTimeline"/);
  assert.match(timerPanel, /const date = dateOverride \|\| today\(\)/);
  assert.match(timerPanel, /studyPlanPanel\(me, date, editable\)/);
  assert.match(planPanel, /data-act="tbadd"/);
  assert.match(planPanel, /data-act="tbstart"/);
  assert.match(planPanel, /data-act="tbdel"/);
  assert.doesNotMatch(today, /tbCard\(/);
  assert.match(handlers, /stStart\(me\.id, today\(\), subj, t\.id\)/);
  assert.match(handlers, /if \(stRunning\(me\.id, today\(\)\)\) stStop/);
  assert.match(html, /if \(turnOn && running && running\.taskId === t\.id\) stStop\(t\.staffId, date\)/);
});

test('today ends with a mandatory closeout funnel instead of a standalone report shortcut', () => {
  const today = section('function viewToday()', 'function studyTotalHeroCard(');
  const closeCard = section('function dailyClosureCard(', 'function dailyResolutionOptions(');

  assert.match(today, /cursor >= DAILY_CLOSE_START && cursor <= today\(\)[\s\S]*?dailyClosureCard\(me, cursor\)/);
  assert.doesNotMatch(today, /오늘 수행 보고 문자 만들기/);
  assert.match(closeCard, /1 · 공부 종료/);
  assert.match(closeCard, /2 · 미완료 정리/);
  assert.match(closeCard, /3 · 일정 준비율/);
  assert.match(closeCard, /이전 미마감[\s\S]*?먼저 마무리/);
  assert.match(closeCard, /data-act="report"/);
  assert.match(today, /오늘 학습은 잠시 잠겨 있습니다/);
  assert.match(today, /priorCloseDates\.length[\s\S]*?return h/);
});

test('past dates show the full planner read-only and return to today after closeout', () => {
  const today = section('function viewToday()', 'function studyTotalHeroCard(');
  const history = section('/** 과거 플래너는', 'const ckey');
  const finish = section("case 'dailyreportfinish':", "case 'brief':");

  assert.match(today, /const pastDate = cursor < today\(\)/);
  assert.match(today, /pastDate \? historicalPlannerTasks\(me\.id, cursor\) : checklistTasksFor\(me\.id, cursor\)/);
  assert.match(today, /const lectureChecklist = ingChecklistItems\(me\.id, cursor\)/);
  assert.match(today, /else \{[\s\S]*?studyPlannerCard\(me, cursor, list, \[\], false\)/);
  assert.doesNotMatch(today, /tbCard\(/);
  assert.match(today, /editable && cursor === today\(\)/);
  assert.doesNotMatch(today, /list\.map\(t => taskRow\(t, cursor, editable, false\)\)/);
  assert.match(history, /new Map\(tasksFor\(staffId, date\)/);
  assert.match(history, /weekMovesFor\(staffId, date\)\.filter\(move => move\.from === date\)/);
  assert.match(history, /dailyCloseOf\(staffId, date\)\.itemSnapshot/);
  assert.match(history, /item\.type === 'task'/);
  assert.match(finish, /const closedPastDate = cursor < today\(\)/);
  assert.match(finish, /if \(closedPastDate\) \{ cursor = today\(\); cursorPinned = false; \}/);
});

test('planner completion cell distinguishes completed, carried, blocked, and closed study', () => {
  const rowAndMark = section('function plannerTaskRow(', 'function plannerLectureRow(');

  assert.match(rowAndMark, /check && check\.done[\s\S]*?symbol: '✓'/);
  assert.match(rowAndMark, /resolution\.type === 'carry' \|\| isCarry \|\| task\.dailyCarrySourceDate[\s\S]*?symbol: '→'/);
  assert.match(rowAndMark, /resolution\.type === 'closed' \|\| \(check && check\.dropped\)[\s\S]*?symbol: '×'/);
  assert.match(rowAndMark, /resolution\.type === 'blocked' \|\| \(check && check\.blocked\)[\s\S]*?symbol: '×'/);
  assert.match(rowAndMark, /aria-label="' \+ mark\.label/);
});

test('daily closeout requires every unfinished item and event to be reviewed after the timer stops', () => {
  const data = section('const DAILY_CLOSE_START', 'function dailyCloseStatusLabel(');
  const modal = section('function dailyResolutionOptions(', 'function dailyCarryTask(');
  const save = section("case 'dailyclosesave':", "case 'report':");

  assert.match(data, /const dailyCloseKey = staffId => '__dailyclose__' \+ staffId/);
  assert.match(data, /const DAILY_CLOSE_START = '2026-08-18'/);
  assert.match(data, /incomplete = items\.filter\(item => !item\.done\)/);
  assert.match(data, /unresolved = incomplete\.filter/);
  assert.match(data, /unconfirmedEvents = events\.filter/);
  assert.match(data, /canReport: !running && !unresolved\.length && !unconfirmedEvents\.length && reviewCurrent/);
  assert.match(modal, /내일로 이월/);
  assert.match(modal, /막힘 · 사유 남기기/);
  assert.match(modal, /오늘 종료 · 사유 남기기/);
  assert.match(modal, /data-daily-note/);
  assert.match(modal, /data-daily-event/);
  assert.match(save, /공부 타이머를 먼저 정지해 주세요/);
  assert.match(save, /처리 방법을 선택해 주세요/);
  assert.match(save, /사유를 입력해 주세요/);
});

test('unclaimed distributed study is mandatory in daily closeout and the report', () => {
  const items = section('function dailyCloseStudyItems(', 'function dailyCloseEventRefs(');
  const modal = section('function dailyCloseModal(', 'function dailyCarryTask(');
  const save = section("case 'dailyclosesave':", "case 'report':");
  const report = section('function reportText(', 'function briefText(');

  assert.match(items, /const tasks = tasksFor\(staffId, date\)\.map/);
  assert.doesNotMatch(items, /filter\(task => isStudyClaimed/);
  assert.match(items, /claimed: claimed/);
  assert.match(modal, /가져오지 않음/);
  assert.match(save, /claimed: item\.claimed !== false/);
  assert.match(report, /\[미수락 · 내일로 이월\]/);
  assert.match(report, /\[미수락 · 막힘\]/);
  assert.match(report, /\[미수락 · 오늘 종료\]/);
  assert.match(report, /학습 수행 보고/);

  const source = html.match(/function dailyCloseStudyItems\(staffId, date\) \{[\s\S]*?\n\}/)?.[0] || '';
  const run = Function(`
    const tasksFor = () => [{ id: 'task-1', title: '수학 5단원', detail: '', dailyCarrySourceDate: '' }];
    const getCheck = () => null;
    const isStudyClaimed = () => false;
    const taskStudySubjectKey = () => 'math';
    const ingChecklistItems = () => [];
    const ingLec = () => null;
    const ingCourseSubjectKey = () => 'other';
    ${source}
    return dailyCloseStudyItems;
  `)();
  const result = run('student-1', '2026-08-19');
  assert.equal(result.length, 1);
  assert.equal(result[0].claimed, false);
  assert.equal(result[0].done, false);
});

test('student report contains closeout results and cannot finish until a successful copy', () => {
  const report = section('function reportText(', 'function briefText(');
  const handlers = section("case 'report':", "case 'brief':");

  assert.match(report, /순공시간/);
  assert.match(report, /dailyCloseStudyItems/);
  assert.match(report, /\[미완료 · 내일로 이월\]/);
  assert.match(report, /\[미완료 · 막힘\]/);
  assert.match(report, /\[미완료 · 오늘 종료\]/);
  assert.match(report, /이월 완료/);
  assert.match(report, /시험·중요 일정 준비율/);
  assert.match(handlers, /dailyUnclosedDates\(me\.id, cursor\)/);
  assert.match(handlers, /이전 미마감 날짜를 먼저 마무리해 주세요/);
  assert.match(handlers, /copy\(\$\('#mText'\)\.value\)\.then\(copied/);
  assert.match(handlers, /if \(!copied\) return/);
  assert.match(handlers, /copySignature !== data\.signature/);
  assert.match(handlers, /status: 'complete', finalizedAt: now\(\), signature: data\.signature/);
});

test('carried study becomes a unique next-day task and appears in both daily reports correctly', () => {
  const source = html.match(/function dailyCarryTask\(task, date, targetDate\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(source, 'dailyCarryTask function must exist');
  const state = { tasks: [] };
  const dailyCarryTask = Function('state', 'today', 'addDays', 'now',
    source + '\nreturn dailyCarryTask;')(state, () => '2026-08-19', (_date, _days) => '2026-08-20', () => 1234);
  const original = {
    id: 'task-a', groupId: 'group-a', staffId: 'student-a', title: '수학 오답 20문제',
    repeat: 'once', days: [], start: '2026-08-18', carry: true, createdAt: 100, updatedAt: 100
  };
  const carried = dailyCarryTask(original, '2026-08-18', '2026-08-19');
  assert.equal(state.tasks.length, 1);
  assert.notEqual(carried.id, original.id);
  assert.equal(carried.start, '2026-08-19');
  assert.equal(carried.dailyCarryFrom, 'task-a|2026-08-18');
  assert.equal(carried.dailyCarrySourceDate, '2026-08-18');
  assert.equal(carried.requiresClaim, false);
  assert.equal(dailyCarryTask(original, '2026-08-18', '2026-08-19'), carried);
  assert.equal(state.tasks.length, 1);

  const dailyItems = section('function dailyCloseStudyItems(', 'function dailyCloseEventRefs(');
  const save = section("case 'dailyclosesave':", "case 'report':");
  const report = section('function reportText(', 'function briefText(');
  assert.match(dailyItems, /carriedFromDate: task\.dailyCarrySourceDate/);
  assert.match(save, /dailyCarryTask\(item\.task, cursor\)/);
  assert.match(save, /carriedFromDate: item\.carriedFromDate/);
  assert.match(report, /shortDate\(item\.carriedFromDate\).*이월 완료/);
  assert.match(report, /미완료 · 다시 이월/);
});

test('recent legacy carry completions migrate from the original date to the actual completion date', () => {
  const migration = section('function ensureRecentDailyCarryTasks(', 'function dailyCarryLecture(');
  assert.match(migration, /resolution\.type !== 'carry'/);
  assert.match(migration, /candidate > sourceDate && candidate <= today\(\)/);
  assert.match(migration, /dailyCarryTask\(task, sourceDate, completedDate \|\| today\(\)\)/);
  assert.match(migration, /migratedFromCarry: true/);
  assert.match(migration, /done: false, at: null/);
  assert.match(html, /load\(\);\nif \(ensureRecentDailyCarryTasks\(\)\) \{ save\(\); queueSync\(\); \}/);
});

test('weekly planner leads with daily closeout outcomes and keeps detailed placement secondary', () => {
  const week = section('function viewWeek()', '/* ── 월간 플래너 ── */');

  assert.match(week, /✅ 월~일 학습·마감/);
  assert.match(week, /class="week-close-table"/);
  assert.match(week, /<th>마감<\/th><th>공부 완료<\/th><th>순공시간<\/th><th>시험 준비 확인<\/th>/);
  assert.match(week, /dailyCloseStatusLabel\(me\.id, date\)/);
  assert.match(week, /closeData\.close\.eventProgress/);
  assert.match(week, /<details class="card week-detail-card">/);
  assert.match(week, /📅 상세 공부 배치 보기/);
  assert.ok(week.indexOf('✅ 월~일 학습·마감') < week.indexOf('📅 상세 공부 배치 보기'));
});

test('Sunday daily closeout continues into a required weekly closeout step', () => {
  const closeCard = section('function dailyClosureCard(', 'function dailyResolutionOptions(');
  const dailyReport = section('function dailyReportModal(', '/* ── 발행형 주간·월간 리포트');
  const finish = section("case 'dailyreportfinish':", "case 'brief':");

  assert.match(closeCard, /4 · 주간 마무리/);
  assert.match(closeCard, /weekCloseAvailable\(weekMon\)/);
  assert.match(closeCard, /weekHadActivity\(student\.id, weekMon\)/);
  assert.match(closeCard, /data-act="weekcloseopen"/);
  assert.match(dailyReport, /일요일 최종 마감/);
  assert.match(finish, /needsWeeklyClose/);
  assert.match(finish, /weekCloseModal\(me\.id, weekMon\)/);
});

test('an unfinished previous week locks the next Today screen before study begins', () => {
  const helpers = section('const WEEK_CLOSE_START', 'function weekSubjectActual(');
  const today = section('function viewToday()', 'function studyTotalHeroCard(');

  assert.match(helpers, /const weekCloseKey = staffId => '__weekclose__' \+ staffId/);
  assert.match(helpers, /function previousUnclosedWeek/);
  assert.match(helpers, /weekHadActivity\(staffId, mon\) && !weekCloseComplete\(staffId, mon\)/);
  assert.match(today, /previousUnclosedWeek\(me\.id, cursor\)/);
  assert.match(today, /지난주 마무리가 필요합니다/);
  assert.match(today, /주간 회고와 보고 발송까지 완료해야 오늘 학습을 시작할 수 있습니다/);
  assert.match(today, /data-act="weekcloseopen" data-mon=/);
  assert.match(today, /priorWeekMon[\s\S]*?return h/);
});

test('weekly closeout requires reflection, difficulty, next focus, and unfinished-study decisions', () => {
  const modal = section('function weekResolutionOptions(', 'function weekReportText(');
  const save = section("case 'weekclosesave':", "case 'weekreportopen':");

  assert.match(modal, /다음 주 계속/);
  assert.match(modal, /원장 도움 요청/);
  assert.match(modal, /이번 주에서 종료/);
  assert.match(modal, /id="weekCloseReflection"/);
  assert.match(modal, /id="weekCloseDifficulty"/);
  assert.match(modal, /id="weekCloseStudentFocus"/);
  assert.match(modal, /data-week-resolution/);
  assert.match(save, /이번 주 잘한 점을 입력해 주세요/);
  assert.match(save, /이번 주 어려웠던 점을 입력해 주세요/);
  assert.match(save, /다음 주 집중할 것을 입력해 주세요/);
  assert.match(save, /다음 주 처리를 선택해 주세요/);
  assert.match(save, /status: 'reviewed'/);
});

test('weekly report copy acknowledgement completes the week and director override requires a reason', () => {
  const report = section('function weekReportText(', 'function weekOverrideModal(');
  const handlers = section("case 'weekreportcopy':", '/* 발행형 주간·월간 리포트 */');
  const week = section('function viewWeek()', '/* ── 월간 플래너 ── */');

  assert.match(report, /주간 수행 보고/);
  assert.match(report, /주간 순공시간/);
  assert.match(report, /학생 주간 회고/);
  assert.match(report, /미완료 공부 정리/);
  assert.match(handlers, /copyToken: fresh\.reviewToken/);
  assert.match(handlers, /close\.copyToken !== close\.reviewToken/);
  assert.match(handlers, /status: 'complete'/);
  assert.match(handlers, /if \(!session\.isAdmin\) break/);
  assert.match(handlers, /대신 처리 사유를 입력해 주세요/);
  assert.match(handlers, /status: 'overridden'/);
  assert.match(week, /weekCloseCard\(me, mon\)/);
  assert.match(week, /학생이 어려웠던 점/);
  assert.match(week, /학생의 다음 주 집중/);
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
  assert.match(week, /<details class="week-key"><summary>표시 설명<\/summary>/);
  assert.match(week, /<details class="card week-action-card">/);
  assert.match(week, /이번 주 정리할 공부/);
  assert.ok(week.indexOf('week-key') < week.indexOf('<table class="week">'), 'the legend belongs to the weekly placement card');
  assert.ok(week.indexOf('week-action-card') < week.indexOf('weekCloseCard(me, mon)'), 'weekly action items belong immediately before the forced closeout');
  assert.doesNotMatch(week, /<div class="hint">🔵 완료/);
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
