const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function block(start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  assert.ok(from >= 0, start + ' block starts');
  assert.ok(to > from, end + ' block ends');
  return html.slice(from, to);
}

test('flexible weekend lesson fields stay on the exact lesson task and stable student id', () => {
  for (const field of [
    'weekendAttendanceMode', 'weekendAllowedDays', 'weekendMonthlyTarget', 'weekendFlexibleFrom'
  ]) {
    assert.match(html, new RegExp(field), field + ' must be represented in the task UI');
  }

  const settings = block('function weekendFlexibleSettingsSummary(', 'function weekendVisitTimestamp(');
  assert.match(settings, /task\.id/);
  assert.match(settings, /task\.studentId/);
  assert.match(settings, /weekendAttendanceMode/);
  assert.match(settings, /weekendAllowedDays/);
  assert.match(settings, /weekendMonthlyTarget/);
  assert.match(settings, /weekendFlexibleFrom/);
  assert.doesNotMatch(settings, /find\([^\n]*(?:studentName|\.name)/,
    'a flexible lesson must never be selected by a mutable student name');
});

test('admin configures a roster lesson with weekend days, optional monthly target, effective date, and CAS', () => {
  const rosterLessons = block('function rosterStudentLessonsHtml(', 'function rosterStudentInfoHtml(');
  assert.match(rosterLessons, /data-act="weekendflexsettings"/);
  assert.match(rosterLessons, /비정기 (?:등원|수업) 설정/);

  const modalSource = block('function openWeekendFlexibleSettings(', 'async function saveWeekendFlexibleSettings(');
  assert.match(modalSource, /session\.isAdmin/);
  assert.match(modalSource, /주말 비정기 (?:등원|수업) 설정/);
  assert.match(modalSource, /data-weekend-flex-day[^>]*value="6"/);
  assert.match(modalSource, /data-weekend-flex-day[^>]*value="0"/);
  assert.match(modalSource, /토요일/);
  assert.match(modalSource, /일요일/);
  assert.match(modalSource, /id="weekendFlexTarget"/);
  assert.match(modalSource, /월 목표 횟수[^<]*(?:선택|선택 사항|선택 입력)/);
  assert.match(modalSource, /id="weekendFlexFrom"/);
  assert.match(modalSource, /적용 시작일/);
  assert.match(modalSource, /data-act="weekendflexsave"/);
  assert.match(modalSource, /expectedUpdatedAt:\s*Number\(task\.updatedAt/);

  const saveSource = block('async function saveWeekendFlexibleSettings(', 'function weekendVisitTimestamp(');
  assert.match(saveSource, /sync\.post\('\/weekend-visit'/);
  assert.match(saveSource, /action:\s*'configure'/);
  for (const field of [
    'taskId', 'studentId', 'expectedUpdatedAt', 'weekendAttendanceMode',
    'weekendAllowedDays', 'weekendMonthlyTarget', 'weekendFlexibleFrom'
  ]) {
    assert.match(saveSource, new RegExp('(?:^|[^A-Za-z])' + field + '(?:[^A-Za-z]|$)'), field);
  }
  assert.match(saveSource, /expectedUpdatedAt:\s*editor\.expectedUpdatedAt/);
  assert.match(saveSource, /result\.task/,
    'the server-authored task returned by configure must replace the local task');
  assert.doesNotMatch(saveSource, /studentName\s*:/,
    'configure must be bound to studentId, not a name supplied by the browser');
});

test('teacher weekend panel has one flexible check-in chooser filtered by allowed day with monthly progress', () => {
  const weekendSource = block('/* ── 토·일 실제 등·하원 ──', '/* ── 오늘 ──');
  assert.match(weekendSource, /function weekendFlexibleLessonCandidates\(staffId, date\)/);
  const candidates = block('function weekendFlexibleLessonCandidates(', 'function weekendVisitRosterStudent(');
  assert.match(candidates, /String\(task\.staffId/);
  assert.match(candidates, /String\(task\.studentId/);
  assert.match(candidates, /!isScheduledMakeupTask\(task\)/,
    'generated makeup lessons must not be offered as flexible weekend visits');
  assert.match(candidates, /flexibleWeekendAllowedOn\(task, date\)/);
  const allowedOn = block('function flexibleWeekendAllowedOn(', 'function hasFlexibleWeekendOccurrence(');
  assert.match(allowedOn, /isFlexibleWeekendLesson\(task, date\)/);
  assert.match(allowedOn, /isWeekendVisitDate\(date\)/);
  assert.match(allowedOn, /flexibleWeekendAllowedDays\(task\)\.includes\(dowOf\(date\)\)/);
  assert.doesNotMatch(candidates, /(?:find|filter)\([^\n]*(?:studentName|\.name\s*===|\.name\s*==)/,
    'names may sort the display but must not decide candidate identity');

  const chooser = block('function openWeekendFlexibleCheckIn(', 'function weekendFlexibleSettingsSummary(');
  assert.match(chooser, /비정기 등원/);
  assert.match(chooser, /weekendFlexibleLessonCandidates/);
  assert.match(chooser, /data-task=/);
  assert.match(chooser, /data-student-id=/);
  assert.match(chooser, /weekendVisitStudentLabel/);
  assert.match(chooser, /flexibleWeekendProgressText/);
  assert.match(chooser, /data-act="weekendflexcheckin"/);

  const monthlyProgress = block('function flexibleWeekendMonthlyCount(', 'function weekendVisitScopeKey(');
  assert.match(monthlyProgress, /weekendVisitMonthlyCounts/);
  assert.match(monthlyProgress, /lessonTaskId/);
  assert.match(monthlyProgress, /studentId/);
  assert.match(monthlyProgress, /weekendMonthlyTarget/);
  assert.match(monthlyProgress, /월 실제 등원/);

  const teacherPanel = block('function weekendVisitTeacherHtml(', 'function weekendVisitBoardHtml(');
  assert.match(teacherPanel, /data-act="weekendflexopen"/);
  assert.match(teacherPanel, />비정기 등원 ·/);

  const actions = block("case 'weekendflexsettings':", "case 'attcheck':");
  assert.match(actions, /case 'weekendflexopen'/);
  assert.match(actions, /case 'weekendflexcheckin'/);
  assert.match(actions, /submitWeekendVisit\([\s\S]*action:\s*'check_in'/);
  assert.match(actions, /lessonTaskId/);
  assert.match(actions, /studentId/);
});

test('scheduled makeup lessons stay out of both regular and flexible weekend check-in candidates', () => {
  const candidatesSource = block('function weekendLessonCandidates(', 'function weekendVisitRosterStudent(');
  const tasks = [
    { id: 'regular', staffId: 'teacher-a', studentId: 'student-a', studentName: '가학생' },
    { id: 'makeup-regular', staffId: 'teacher-a', studentId: 'student-b', studentName: '나학생',
      lessonInstanceType: 'makeup', makeupCaseId: 'mu-a' },
    { id: 'flexible', staffId: 'teacher-a', studentId: 'student-c', studentName: '다학생', flexible: true },
    { id: 'makeup-flexible', staffId: 'teacher-a', studentId: 'student-d', studentName: '라학생', flexible: true,
      lessonInstanceType: 'makeup', makeupCaseId: 'mu-b' }
  ];
  const api = new Function('state', 'isLesson', 'isScheduledMakeupTask', 'isFlexibleWeekendLesson',
    'taskHasWeekendSchedule', 'flexibleWeekendAllowedOn', 'studentOf',
    `${candidatesSource}\nreturn { weekendLessonCandidates, weekendFlexibleLessonCandidates };`)(
      { tasks }, () => true,
      task => task.lessonInstanceType === 'makeup' || !!task.makeupCaseId,
      task => !!task.flexible, () => true, task => !!task.flexible,
      task => task.studentName || ''
    );

  assert.deepEqual(api.weekendLessonCandidates('teacher-a', '2026-09-05').map(task => task.id), ['regular']);
  assert.deepEqual(api.weekendFlexibleLessonCandidates('teacher-a', '2026-09-05').map(task => task.id), ['flexible']);
});

test('a flexible lesson becomes a today task only for its exact non-cancelled visit date', () => {
  const occurrence = block('function hasFlexibleWeekendOccurrence(', 'function flexibleWeekendDayText(');
  assert.match(occurrence, /isFlexibleWeekendLesson\(task, date\)/);
  assert.match(occurrence, /isWeekendVisitDate\(date\)/);
  assert.match(occurrence, /row\.visitDate[^\n]*date/);
  assert.match(occurrence, /row\.lessonTaskId[^\n]*task\.id/);
  assert.match(occurrence, /row\.studentId[^\n]*task\.studentId/);
  assert.match(occurrence, /row\.status[^\n]*cancelled/);

  const occurrenceRouter = block('function occursOn(', 'function isBookOrderWorkTask(');
  assert.match(occurrenceRouter, /occursOn|isFlexibleWeekendLesson/);
  assert.match(occurrenceRouter, /hasFlexibleWeekendOccurrence\(task, date\)/);
  const tasksFor = block('function tasksFor(', 'const ckey');
  assert.match(tasksFor, /occursOn\(t, date\)/,
    'fixed and ordinary repeating work must retain the existing occurrence path');

  const loader = block('async function loadWeekendVisits(', 'function weekendLessonCandidates(');
  assert.match(loader, /weekendVisitRows\s*=\s*result\.visits\s*\|\|\s*\[\]/);
  assert.match(loader, /weekendVisitMonthlyCounts\s*=\s*result\.monthlyCounts\s*\|\|\s*\[\]/);

  const submit = block('async function submitWeekendVisit(', '/* ── 오늘 ──');
  assert.match(submit, /await loadWeekendVisits\(cursor, staffId, true\)/,
    'check-in must reload the exact visit before today tasks are rendered');
});

test('week and manager schedules preload both weekend dates into a scope-aware visit cache after refresh', () => {
  const cache = block('function rememberWeekendVisitScope(', 'function hasFlexibleWeekendOccurrence(');
  assert.match(cache, /weekendVisitScopeKey\(date, staffId\)/);
  assert.match(cache, /weekendVisitScopeCache\.set\(key/);
  assert.match(cache, /weekendVisitScopeKey\(date, task && task\.staffId/,
    'teacher scope must stay attached to the stable lesson task');

  const loader = block('async function loadWeekendVisitScheduleScope(', 'async function loadWeekendVisits(');
  assert.match(loader, /action:\s*'list'/);
  assert.match(loader, /visitDate:\s*date/);
  assert.match(loader, /staffId:\s*staffId \|\| ''/);
  assert.match(loader, /rememberWeekendVisitScope\(date, staffId, result\)/);
  assert.match(loader, /filter\(isWeekendVisitDate\)/,
    'the week loader should request only Saturday and Sunday');
  assert.match(loader, /weekendVisitScheduleRetryAt\.set\(key, Date\.now\(\) \+ 15000\)/,
    'a transient list failure gets a bounded retry instead of becoming an empty permanent cache hit');
  assert.match(loader, /loadWeekendVisitScheduleScope\(date, staffId\)/,
    'the visible week retries the same date and stable staff scope');

  const week = block('function viewWeek(', '/* ── 지시서 작성 ──');
  assert.match(week, /ensureWeekendVisitScheduleDates\(days, me\.id\)/,
    'the teacher planner reloads its own stable scope after a browser refresh');

  const schedule = block('function viewSchedule(', '/* ── 기기 대장 ──');
  assert.match(schedule, /ensureWeekendVisitScheduleDates\(scheduleVisitDates, ''\)/,
    'the manager schedule reloads the all-teacher scope');
  assert.match(schedule, /Array\.from\(\{ length: 7 \}/,
    'weekly manager views cover the entire visible week');
});

test('manager schedule passes only an exact actual visit slot for flexible lessons', () => {
  const actualSlot = block('function flexibleWeekendVisitScheduleSlot(', 'function flexibleWeekendDayText(');
  assert.match(actualSlot, /flexibleWeekendVisit\(task, date\)/);
  assert.match(actualSlot, /lessonTaskId:\s*String\(visit\.lessonTaskId/);
  assert.match(actualSlot, /studentId:\s*String\(visit\.studentId/);
  assert.match(actualSlot, /visitDate:\s*String\(visit\.visitDate/);
  assert.match(actualSlot, /const projectedEnd\s*=\s*!/);
  assert.match(actualSlot, /projectedEnd:\s*projectedEnd/,
    'an active check-in keeps its projected timeline end separate from the user-visible label');
  assert.doesNotMatch(actualSlot, /studentName|\.name|phone|contact|guardian|연락처/i);

  const daily = block('function dailyLessonSchedule(', 'function scheduleAttendance(');
  assert.match(daily, /occurs:\s*occursOn\(t, date\)/);
  assert.match(daily, /flexibleVisit:\s*flexibleWeekendVisitScheduleSlot\(t, date\)/);

  const dashboard = block('function viewSchedule(', '/* ── 기기 대장 ──');
  assert.match(dashboard, /timelineOptions\s*=\s*\{\s*date:\s*cursor,\s*todayDate:\s*nowKst\.date,\s*nowMinute:\s*nowKst\.minute\s*\}/);
  assert.match(dashboard, /core\.timelineRows\(daily\.entries, timelineOptions\)/);
  assert.match(dashboard, /core\.timelineRange\(daily\.entries, timelineOptions\)/);
});

test('flexible lesson controls do not infer students by name or expose guardian contacts', () => {
  const candidates = block('function weekendFlexibleLessonCandidates(', 'function weekendVisitRosterStudent(');
  const chooser = block('function openWeekendFlexibleCheckIn(', 'function weekendFlexibleSettingsSummary(');
  const source = candidates + chooser;
  assert.match(source, /task\.id/);
  assert.match(source, /task\.studentId/);
  assert.doesNotMatch(source, /rosterStudentIdentityLabel/,
    'that helper intentionally includes parent-contact suffixes and must not be used here');
  assert.doesNotMatch(source, /phone|contact|guardian|연락처/i);
  assert.doesNotMatch(source, /find\([^\n]*(?:studentName|\.name)/);
});
