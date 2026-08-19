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
  assert.match(handler, /todayFoldState\[section\] = !todayFoldState\[section\]/);
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
  assert.match(planner, /ingChecklistItems\(me\.id, date\)/);
  assert.match(planner, /lectures\.map\(item => plannerLectureRow\(me\.id, item, editable\)\)/);
  assert.match(compactRow, /planner-task-subject/);
  assert.match(compactRow, /planner-task-detail/);
  assert.match(compactRow, /planner-check-wrap/);
  assert.match(compactRow, /data-act="sttask"/);
  assert.match(css, /\.study-paper-head/);
  assert.match(css, /grid-template-columns: 62px minmax\(0, 1fr\) 38px/);
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
});

test('daily closeout requires every unfinished item and event to be reviewed after the timer stops', () => {
  const data = section('const DAILY_CLOSE_START', 'function dailyCloseStatusLabel(');
  const modal = section('function dailyResolutionOptions(', 'function dailyCarryTask(');
  const save = section("case 'dailyclosesave':", "case 'report':");

  assert.match(data, /const dailyCloseKey = staffId => '__dailyclose__' \+ staffId/);
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

test('student report contains closeout results and cannot finish until a successful copy', () => {
  const report = section('function reportText(', 'function briefText(');
  const handlers = section("case 'report':", "case 'brief':");

  assert.match(report, /순공시간/);
  assert.match(report, /dailyCloseStudyItems/);
  assert.match(report, /\[내일로 이월\]/);
  assert.match(report, /\[막힘\]/);
  assert.match(report, /\[오늘 종료\]/);
  assert.match(report, /시험·중요 일정 준비율/);
  assert.match(handlers, /dailyUnclosedDates\(me\.id, cursor\)/);
  assert.match(handlers, /이전 미마감 날짜를 먼저 마무리해 주세요/);
  assert.match(handlers, /copy\(\$\('#mText'\)\.value\)\.then\(copied/);
  assert.match(handlers, /if \(!copied\) return/);
  assert.match(handlers, /copySignature !== data\.signature/);
  assert.match(handlers, /status: 'complete', finalizedAt: now\(\), signature: data\.signature/);
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
  assert.ok(week.indexOf('week-action-card') < week.indexOf('📝 주간 마무리'), 'weekly action items belong immediately before the wrap-up');
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
