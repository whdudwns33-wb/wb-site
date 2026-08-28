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
  const cache = new Map(), errors = new Map(), checks = {};
  const state = { tasks: [] };
  const api = new Function(
    'addDays', 'dowOf', 'isWeekendVisitDate', 'plannedOccursOn', 'isLesson', 'taskHasWeekendSchedule',
    'weekendVisitScopeKey', 'weekendVisitScopeCache', 'weekendVisitScheduleErrors', 'getCheck',
    'isFlexibleWeekendLesson', 'state', 'isBookOrderWorkTask', 'occursOn', 'statusOf', 'taskProgress',
    'mondayOf', 'loadWeekendVisitScheduleScope',
    source + '; return { weekendPairDates, plannedWeekendOccurrence, weekendVisitSourceDate, ' +
      'weekendVisitPairScope, lessonCheckHasMeaningfulData, lessonRecordContext, teacherTaskCardOccursOn };'
  )(
    dates.addDays, dates.dowOf, dates.isWeekendVisitDate,
    (task, date) => !task.deleted && (!task.start || task.start <= date) && (!task.end || task.end >= date) &&
      (task.days || []).map(Number).includes(dates.dowOf(date)),
    task => !!task && task.taskKind === 'lesson_instruction',
    task => (task.scheduleSlots || []).some(slot => (slot.days || []).map(Number).some(day => day === 0 || day === 6)),
    (date, staffId) => date + '|' + staffId,
    cache, errors,
    (taskId, date) => checks[taskId + '|' + date] || null,
    (task, date) => task.weekendAttendanceMode === 'flexible' && date >= task.weekendFlexibleFrom,
    state, () => false, () => false, () => 'todo', () => ({ done: 0, total: 5 }), value => value, () => {}
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
  harness.cache.set('2026-08-29|teacher-a', { rows: saturdayRows || [] });
  harness.cache.set('2026-08-30|teacher-a', { rows: sundayRows || [] });
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
  loadWeekendPair(harness, [], []);
  let context = harness.api.lessonRecordContext(task, '2026-08-29');
  assert.equal(context.recordDate, '2026-08-29');
  assert.equal(context.inputEnabled, true);

  loadWeekendPair(harness, [], [visit()]);
  context = harness.api.lessonRecordContext(task, '2026-08-29');
  assert.equal(context.recordDate, '2026-08-30');
  assert.equal(context.inputEnabled, true);
});

test('today cards, lesson panel, week toggles, and visit rows preserve source UI but use recordDate', () => {
  const carry = block('function carryOver(', '/** 그 주에 직원이 스스로 추가한 업무 */');
  assert.match(carry, /lessonRecordContext\(t, d\)/);
  assert.match(carry, /!context\.ready \|\| !context\.recordDate/,
    'an unloaded past weekend must not become a false carry-over');

  const today = block('function viewToday()', 'function taskRow(');
  assert.match(today, /ensureWeekendVisitScheduleDates\(Array\.from\(\{ length: 8 \}/,
    'today view preloads the weekend scopes needed by seven-day carry-over');

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
