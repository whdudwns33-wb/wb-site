const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function block(start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  assert.ok(from >= 0, start + ' starts');
  assert.ok(to > from, end + ' ends');
  return html.slice(from, to);
}

function lastBlock(start, end) {
  const from = html.lastIndexOf(start);
  const to = html.indexOf(end, from + start.length);
  assert.ok(from >= 0, start + ' starts');
  assert.ok(to > from, end + ' ends');
  return html.slice(from, to);
}

function dateHelpers() {
  const parse = value => {
    const [year, month, day] = String(value).split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day));
  };
  const ymd = value => value.toISOString().slice(0, 10);
  return {
    addDays(value, amount) { const date = parse(value); date.setUTCDate(date.getUTCDate() + amount); return ymd(date); },
    dowOf(value) { return parse(value).getUTCDay(); },
    isWeekendVisitDate(value) { const day = parse(value).getUTCDay(); return day === 0 || day === 6; }
  };
}

function sourceRecordHarness() {
  const source = block('function weekendPairDates(', 'function rememberWeekendVisitScope(');
  const dates = dateHelpers();
  const cache = new Map(), loading = new Map(), errors = new Map(), checks = {};
  const state = { tasks: [] };
  const api = new Function(
    'addDays', 'dowOf', 'isWeekendVisitDate', 'plannedOccursOn', 'isLesson', 'taskHasWeekendSchedule',
    'weekendVisitScopeKey', 'weekendVisitScopeCache', 'weekendVisitScheduleLoadingKeys', 'weekendVisitScheduleErrors', 'getCheck',
    'isFlexibleWeekendLesson', 'state', 'isBookOrderWorkTask', 'occursOn', 'statusOf', 'taskProgress',
    'mondayOf', 'loadWeekendVisitScheduleScope', 'WEEKEND_VISIT_SCOPE_TTL_MS',
    source + '; return { weekendPairDates, plannedWeekendOccurrence, weekendVisitSourceDate, ' +
      'weekendVisitPairScope, lessonCheckHasMeaningfulData, lessonRecordContext, teacherTaskCardOccursOn };'
  )(
    dates.addDays, dates.dowOf, dates.isWeekendVisitDate,
    (task, date) => !task.deleted && (!task.start || task.start <= date) && (!task.end || task.end >= date) &&
      (task.days || []).map(Number).includes(dates.dowOf(date)),
    task => !!task && task.taskKind === 'lesson_instruction',
    task => (task.scheduleSlots || []).some(slot => (slot.days || []).map(Number).some(day => day === 0 || day === 6)),
    (date, staffId) => date + '|' + staffId,
    cache, loading, errors,
    (taskId, date) => checks[taskId + '|' + date] || null,
    (task, date) => task.weekendAttendanceMode === 'flexible' && date >= task.weekendFlexibleFrom,
    state, () => false, () => false, () => 'todo', () => ({ done: 0, total: 5 }), value => value, () => {}, 15000
  );
  return { api, cache, errors, checks };
}

function lessonTask(overrides = {}) {
  return Object.assign({
    id: 'lesson-a', studentId: 'student-a', staffId: 'teacher-a', taskKind: 'lesson_instruction',
    repeat: 'days', days: [6], start: '2026-08-01', end: '2026-12-31',
    scheduleSlots: [{ slotId: 'slot-a', days: [6], startTime: '12:00', endTime: '13:20' }],
    weekendAttendanceMode: 'flexible', weekendFlexibleFrom: '2026-08-01'
  }, overrides);
}

function visit(overrides = {}) {
  return Object.assign({
    visitId: 'wv_a', lessonTaskId: 'lesson-a', studentId: 'student-a', staffId: 'teacher-a',
    sourceDate: '2026-08-29', visitDate: '2026-08-30', status: 'completed'
  }, overrides);
}

function loadWeekendPair(harness, saturdayRows, sundayRows) {
  harness.cache.set('2026-08-29|teacher-a', { rows: saturdayRows || [], fetchedAt: Date.now() });
  harness.cache.set('2026-08-30|teacher-a', { rows: sundayRows || [], fetchedAt: Date.now() });
}

test('API sourceDate wins and legacy visits derive only from the exact confirmed weekend schedule', () => {
  const { api } = sourceRecordHarness();
  const saturday = lessonTask();
  assert.equal(api.weekendVisitSourceDate(saturday, visit()), '2026-08-29');
  assert.equal(api.weekendVisitSourceDate(saturday, visit({ sourceDate: '2026-08-28' })), '');

  assert.equal(api.weekendVisitSourceDate(saturday, visit({ sourceDate: '' })), '2026-08-29',
    'a Sunday legacy visit maps to the sole Saturday scheduled source');
  const bothDays = lessonTask({ days: [6, 0], scheduleSlots: [{ days: [6, 0], startTime: '12:00', endTime: '13:20' }] });
  assert.equal(api.weekendVisitSourceDate(bothDays, visit({ sourceDate: '' })), '2026-08-30',
    'when actual day is scheduled it wins over the opposite weekend day');
  assert.equal(api.weekendVisitSourceDate(saturday, visit({ sourceDate: '', studentId: 'student-b' })), '',
    'student identity never falls back to a name');
});

test('source card reads and writes one actual visit-date check and fails closed on unsafe state', () => {
  const harness = sourceRecordHarness();
  const task = lessonTask();
  loadWeekendPair(harness, [], [visit()]);
  let context = harness.api.lessonRecordContext(task, '2026-08-29');
  assert.equal(context.sourceDate, '2026-08-29');
  assert.equal(context.recordDate, '2026-08-30');
  assert.equal(context.inputEnabled, true);
  assert.equal(context.visible, true);

  context = harness.api.lessonRecordContext(task, '2026-08-30');
  assert.equal(context.visible, false, 'the flexible visit must not create a second card on its actual day');

  harness.checks['lesson-a|2026-08-29'] = { att: 'P' };
  context = harness.api.lessonRecordContext(task, '2026-08-29');
  assert.equal(context.recordDate, '');
  assert.equal(context.inputEnabled, false);
  assert.match(context.issue, /기존 기록/);
  delete harness.checks['lesson-a|2026-08-29'];

  loadWeekendPair(harness, [], [
    visit({ visitId: 'wv_first', visitSequence: 1, checkInAt: 100, status: 'completed' }),
    visit({ visitId: 'wv_second', visitSequence: 2, checkInAt: 200, status: 'active' })
  ]);
  context = harness.api.lessonRecordContext(task, '2026-08-29');
  assert.equal(context.recordDate, '2026-08-30');
  assert.equal(context.inputEnabled, true, 'multiple visits on one actual date share one lesson record');
  assert.equal(context.visitCount, 2);
  assert.deepEqual(context.visits.map(row => row.visitId), ['wv_first', 'wv_second']);
  assert.equal(context.visit.visitId, 'wv_second', 'the active visit is the representative visit');

  loadWeekendPair(harness, [visit({ visitId: 'wv_b', visitDate: '2026-08-29' })], [visit()]);
  context = harness.api.lessonRecordContext(task, '2026-08-29');
  assert.equal(context.inputEnabled, false);
  assert.match(context.issue, /여러 개/);

  harness.cache.delete('2026-08-30|teacher-a');
  context = harness.api.lessonRecordContext(task, '2026-08-29');
  assert.equal(context.ready, false);
  assert.equal(context.inputEnabled, false);
  assert.match(context.issue, /확인하는 중/);
});

test('fixed weekend lessons keep their source key unless an exact cross-day visit exists', () => {
  const harness = sourceRecordHarness();
  const task = lessonTask({ weekendAttendanceMode: 'fixed', weekendFlexibleFrom: '' });
  let context = harness.api.lessonRecordContext(task, '2026-08-29');
  assert.equal(context.ready, false, 'fixed lessons also fail closed until both weekend scopes are known');
  assert.equal(context.recordDate, '');
  assert.equal(context.inputEnabled, false,
    'writing to sourceDate before a remote cross-day visit is ruled out could split one lesson record');

  loadWeekendPair(harness, [], []);
  context = harness.api.lessonRecordContext(task, '2026-08-29');
  assert.equal(context.recordDate, '2026-08-29');
  assert.equal(context.inputEnabled, true);

  loadWeekendPair(harness, [], [visit()]);
  context = harness.api.lessonRecordContext(task, '2026-08-29');
  assert.equal(context.recordDate, '2026-08-30');
  assert.equal(context.inputEnabled, true);
});

test('cancelled visits do not move a flexible card, while a checked-in visit already owns the actual-date record', () => {
  const harness = sourceRecordHarness();
  const task = lessonTask();
  loadWeekendPair(harness, [], [visit({ status: 'cancelled' })]);
  let context = harness.api.lessonRecordContext(task, '2026-08-29');
  assert.equal(context.visible, false);
  assert.equal(context.recordDate, '');
  assert.equal(context.inputEnabled, false);

  loadWeekendPair(harness, [], [visit({ status: 'checked_in', endTime: '', checkOutAt: null })]);
  context = harness.api.lessonRecordContext(task, '2026-08-29');
  assert.equal(context.visible, true);
  assert.equal(context.recordDate, '2026-08-30');
  assert.equal(context.inputEnabled, true,
    'memo and attendance may be entered after check-in without waiting for check-out');

  loadWeekendPair(harness, [], [visit({ status: 'cancelled' })]);
  context = harness.api.lessonRecordContext(task, '2026-08-29');
  assert.equal(context.visible, false, 'a cancellation refreshed from another tablet removes the flexible card');
  assert.equal(context.recordDate, '');
});

test('today cards, lesson panel, week toggles, and visit rows preserve source UI but use recordDate', () => {
  const carry = block('function carryOver(', '/** 그 주에 직원이 스스로 추가한 업무 */');
  assert.match(carry, /lessonRecordContext\(t, d\)/);
  assert.match(carry, /!context\.ready \|\| !context\.recordDate/,
    'an unloaded past weekend must not become a false carry-over');

  const today = block('function viewToday()', 'function taskRow(');
  assert.match(today, /ensureWeekendVisitScheduleDates\(weekendVisitCarryScopeDates\(cursor\), me\.id\)/);
  const carryScopeSource = block('function weekendVisitCarryScopeDates(', 'function visibleWeekendVisitScopes(');
  const dates = dateHelpers();
  const { api } = sourceRecordHarness();
  const carryScopeDates = new Function('weekendPairDates', 'addDays',
    carryScopeSource + '; return weekendVisitCarryScopeDates;')(api.weekendPairDates, dates.addDays);
  const sundayScopes = carryScopeDates('2026-08-30');
  assert.ok(sundayScopes.includes('2026-08-22'),
    'Sunday carry-over must preload the Saturday pair of the Sunday seven days ago');
  assert.ok(sundayScopes.includes('2026-08-23'));

  const taskRow = block('function taskRow(', 'const LESSON_MEMO_FIELDS');
  assert.match(taskRow, /openPanels\.has\(t\.id \+ '\|' \+ date\)/);
  assert.match(taskRow, /recordDate \? getCheck\(t\.id, recordDate\)/);
  assert.match(taskRow, /taskPanel\(t, recordDate \|\| date/);
  assert.match(taskRow, /원 수업[\s\S]*실제 기록/);

  const panel = block('function taskPanel(t, date, c, editable)', '/** 수업 출결 표시용 */');
  assert.match(panel, /실제 등원일/);
  assert.match(panel, /recordContext\.issue/);
  assert.match(panel, /data-act="latt"[\s\S]*data-date="' \+ date/);
  assert.match(panel, /taskMemoEditorHtml\(t, date, c, editable\)/);

  const week = block('function viewWeek()', '/* ── 지시서 작성 ──');
  assert.match(week, /teacherTaskCardsFor\(me\.id, d\)/);
  assert.match(week, /teacherWeekCardProgress\(me\.id, cursor\)/);
  assert.match(week, /const recordDate = context \? context\.recordDate : d/);
  assert.match(week, /data-date="' \+ recordDate/);

  const visitUi = block('function weekendVisitRowHtml(', 'function weekendVisitEditModal(');
  assert.match(visitUi, /weekendVisitSourceDate\(task, row\)/);
  assert.match(visitUi, /data-act="weekendopensource"/);
  assert.match(visitUi, /원래 수업 화면 열기/);

  const actions = block("case 'weekendflexcheckin':", "case 'attcheck':");
  assert.match(actions, /sourceDate:\s*sourceDate/);
  assert.match(actions, /case 'weekendopensource'/);
  assert.match(actions, /openPanels\.add\(taskId \+ '\|' \+ sourceDate\)/);
});

test('remote weekend visit changes force-refresh source scopes every 15 seconds and on browser return', () => {
  const loader = block('async function loadWeekendVisitScheduleScope(', 'function ensureWeekendVisitScheduleDates(');
  assert.match(loader, /loadWeekendVisitScheduleScope\(date, staffId, force\)/,
    'the lightweight source-scope loader needs an explicit force mode');
  assert.match(loader, /!force[^\n;]*(?:weekendVisitScopeIsFresh\(key\)|weekendVisitScopeCache\.has\(key\))/,
    'force mode must bypass a browser-cached visit scope');

  const visibility = block("document.addEventListener('visibilitychange'", '/* ══════════════════════════════════════════════════════');
  const periodic = lastBlock('startSyncSession();', '/* ── 새 버전 감지 ──');
  const refreshCall = source =>
    /loadWeekendVisitScheduleScope\([^)]*,\s*true\)/s.test(source) ||
    /(?:refresh|reload)\w*WeekendVisit\w*\(/i.test(source);
  assert.equal(refreshCall(visibility), true,
    'returning to a visible tablet must refresh remote weekend check-in/cancellation state');
  assert.match(periodic, /15000/);
  assert.equal(refreshCall(periodic), true,
    'the visible-tablet 15-second loop must refresh remote weekend check-in/cancellation state');
});

test('an older weekend visit response cannot overwrite the newest response for the same scope', () => {
  const source = block('function weekendVisitScopeIsFresh(', 'function weekendVisitRowsForTaskDate(');
  const cache = new Map(), loading = new Map(), retryAt = new Map(), errors = new Map(), generations = new Map();
  const api = new Function(
    'weekendVisitScopeCache', 'weekendVisitScheduleLoadingKeys', 'weekendVisitScheduleRetryAt',
    'weekendVisitScheduleErrors', 'weekendVisitScopeRequestGeneration', 'WEEKEND_VISIT_SCOPE_TTL_MS',
    'weekendVisitScopeKey', 'weekendVisitScopeRequestSerial', 'weekendVisitScopeRevision',
    source + '; return { beginWeekendVisitScopeRequest, finishWeekendVisitScopeRequest, rememberWeekendVisitScope };'
  )(cache, loading, retryAt, errors, generations, 15000,
    (date, staffId) => date + '|' + staffId, 0, 0);
  const key = '2026-08-30|teacher-a';
  const older = api.beginWeekendVisitScopeRequest(key);
  const newer = api.beginWeekendVisitScopeRequest(key);
  assert.equal(api.rememberWeekendVisitScope('2026-08-30', 'teacher-a',
    { visits: [{ visitId: 'newer' }], nextVisitSequences: [{ lessonTaskId: 'lesson-a', studentId: 'student-a', visitDate: '2026-08-30', next: 3 }] }, newer), true);
  assert.equal(api.rememberWeekendVisitScope('2026-08-30', 'teacher-a',
    { visits: [{ visitId: 'older' }] }, older), false);
  assert.equal(cache.get(key).rows[0].visitId, 'newer');
  assert.equal(cache.get(key).nextVisitSequences[0].next, 3,
    'the server-computed next sequence must survive the scope cache');
  api.finishWeekendVisitScopeRequest(key, older);
  assert.equal(loading.get(key), newer, 'an old finally block must not clear the current request marker');
  api.finishWeekendVisitScopeRequest(key, newer);
  assert.equal(loading.has(key), false);
});

test('a cached scope stays usable during its same-key refresh, but an error fails closed', () => {
  const source = block('function weekendVisitScopeIsFresh(', 'function weekendVisitRowsForTaskDate(');
  const cache = new Map(), loading = new Map(), retryAt = new Map(), errors = new Map(), generations = new Map();
  const api = new Function(
    'weekendVisitScopeCache', 'weekendVisitScheduleLoadingKeys', 'weekendVisitScheduleRetryAt',
    'weekendVisitScheduleErrors', 'weekendVisitScopeRequestGeneration', 'WEEKEND_VISIT_SCOPE_TTL_MS',
    'weekendVisitScopeKey', 'weekendVisitScopeRequestSerial', 'weekendVisitScopeRevision',
    source + '; return { weekendVisitScopeIsFresh, beginWeekendVisitScopeRequest, finishWeekendVisitScopeRequest };'
  )(cache, loading, retryAt, errors, generations, 15000,
    (date, staffId) => date + '|' + staffId, 0, 0);
  const key = '2026-08-30|teacher-a';
  const fetchedAt = 100000;
  cache.set(key, { rows: [{ visitId: 'known' }], fetchedAt });
  assert.equal(api.weekendVisitScopeIsFresh(key, fetchedAt + 14999), true);
  assert.equal(api.weekendVisitScopeIsFresh(key, fetchedAt + 15000), false);

  const generation = api.beginWeekendVisitScopeRequest(key);
  assert.equal(api.weekendVisitScopeIsFresh(key, fetchedAt + 60000), true,
    'the prior confirmed rows remain available while a forced refresh is in flight');
  errors.set(key, 'network failed');
  assert.equal(api.weekendVisitScopeIsFresh(key, fetchedAt + 60000), false,
    'a known refresh error must lock the actual-date mapping rather than trust stale rows');
  api.finishWeekendVisitScopeRequest(key, generation);
});

test('a disabled actual-date lesson panel never exposes guardian-publication editing', () => {
  const panel = block('function taskPanel(t, date, c, editable)', '/** 수업 출결 표시용 */');
  assert.match(panel, /const canEditPublication\s*=\s*editable\s*&&\s*canEditGuardianPublication\(t, date\)/,
    'recordContext.inputEnabled=false must also lock guardian-publication fields');
});
