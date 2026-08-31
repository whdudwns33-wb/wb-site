const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function functionSource(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, name + ' function must exist');
  const open = html.indexOf('{', start);
  let depth = 0, quote = '', escaped = false;
  for (let i = open; i < html.length; i++) {
    const char = html[i];
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  assert.fail(name + ' function is incomplete');
}

const parseYmd = value => new Date(value + 'T00:00:00');
const addDays = (value, amount) => {
  const date = parseYmd(value);
  date.setDate(date.getDate() + amount);
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
};

function dayHarness(options = {}) {
  const day = '2026-09-08';
  const deadline = parseYmd(addDays(day, 1));
  deadline.setHours(12, 0, 0, 0);
  const close = Object.assign({ status: 'complete', finalizedAt: deadline.getTime() - 1, itemSnapshot: [] }, options.close || {});
  const items = options.items || [{ key: 'task:t1', done: true }];
  const closeState = {
    close,
    items,
    running: options.running || null,
    unresolved: options.unresolved || [],
    unconfirmedEvents: options.unconfirmedEvents || [],
    complete: options.complete !== false
  };
  const build = Function('dailyCloseState', 'tasksFor', 'ingPlan', 'stTotal', 'today', 'parseYmd', 'addDays',
    'DAILY_CLOSE_START', 'ENGAGEMENT_MIN_STUDY_SECONDS',
    functionSource('engagementDayState') + '; return engagementDayState;');
  return build(
    () => closeState,
    () => options.tasks === undefined ? [{ id: 't1' }] : options.tasks,
    () => options.lectures || [],
    () => options.seconds || 0,
    () => '2026-09-08', parseYmd, addDays, '2026-08-18', 600
  )('s1', day);
}

test('a valid day needs tracked study, real activity, current self-close, and on-time reporting', () => {
  assert.equal(dayHarness().stamped, true);
  assert.equal(dayHarness({ items: [{ key: 'task:t1', done: false }], seconds: 599 }).stamped, false);
  assert.equal(dayHarness({ items: [{ key: 'task:t1', done: false }], seconds: 600 }).stamped, true);
  const timerOnly = dayHarness({ tasks: [], items: [], seconds: 600 });
  assert.equal(timerOnly.eligible, true, 'planner-free students can earn a study day with the timer');
  assert.equal(timerOnly.stamped, true);
  assert.equal(dayHarness({ close: { status: 'overridden' } }).stamped, false, 'director override is excluded');
  assert.equal(dayHarness({ unresolved: [{ key: 'task:t2' }] }).stamped, false);
  assert.equal(dayHarness({ complete: false }).stamped, false);

  const late = parseYmd('2026-09-09');
  late.setHours(12, 0, 0, 1);
  assert.equal(dayHarness({ close: { finalizedAt: late.getTime() } }).stamped, false, 'bulk late closeout is excluded');
});

test('August closeouts stay complete while the stronger lecture rule applies to new closeouts', () => {
  const build = Function('dailyCloseOf', 'dailyCloseStudyItems', 'dailyCloseEventRefs', 'stRunning', 'today',
    'dailyCloseSignature', 'DAILY_CLOSE_LECTURE_RULE_START', 'DAILY_CLOSE_SCHEMA_VERSION',
    functionSource('dailyCloseState') + '; return dailyCloseState;');
  const read = (date, close) => build(
    () => Object.assign({ resolutions: {}, eventProgress: {} }, close),
    () => [{ key: 'lecture:c1:1', done: false }],
    () => [], () => null, () => '2026-09-02',
    (_sid, _date, _close, legacyClaimedLecturesOnly) => legacyClaimedLecturesOnly ? 'legacy-signature' : 'current-signature',
    '2026-09-01', 2
  )('s1', date);

  const legacy = { status: 'complete', signature: 'legacy-signature', resolutions: { 'lecture:c1:1': { type: 'closed' } } };
  assert.equal(read('2026-08-31', legacy).complete, true, 'an already-finalized August day must not relock Today');
  assert.equal(read('2026-09-01', legacy).complete, false, 'September uses the stronger unclaimed-lecture rule');
  assert.equal(read('2026-08-31', Object.assign({}, legacy, { schemaVersion: 2 })).complete, false,
    'a new-schema closeout cannot use the compatibility fallback');
  assert.equal(read('2026-09-01', { status: 'complete', schemaVersion: 2, signature: 'current-signature' }).complete, true);

  const save = html.slice(html.indexOf("case 'dailyclosesave':"), html.indexOf("case 'report':"));
  assert.match(save, /schemaVersion: DAILY_CLOSE_SCHEMA_VERSION/);
});

function monthHarness({ stamped = 4, directWeeks = 3, monthStatus = 'complete', ym = '2026-09' } = {}) {
  const year = Number(ym.slice(0, 4));
  const month = Number(ym.slice(5));
  const last = new Date(year, month, 0).getDate();
  const dates = Array.from({ length: last }, (_, index) => ym + '-' + String(index + 1).padStart(2, '0'));
  const eligible = new Set(dates.slice(0, 5));
  const earned = new Set(dates.slice(0, stamped));
  const sundays = dates.filter(date => parseYmd(date).getDay() === 0);
  const direct = new Set(sundays.slice(0, directWeeks).map(date => {
    const dow = parseYmd(date).getDay();
    return addDays(date, -((dow + 6) % 7));
  }));
  const build = Function('today', 'monthLastDate', 'monthDates', 'engagementDayState', 'dowOf', 'mondayOf', 'addDays',
    'weekHadActivity', 'weekCloseOf', 'monthCloseOf', 'DAILY_CLOSE_START', 'WEEK_CLOSE_START',
    'ENGAGEMENT_REWARD_START', 'ENGAGEMENT_REWARD_RATE', 'ENGAGEMENT_WEEKLY_TARGET',
    functionSource('engagementMonthSummary') + '; return engagementMonthSummary;');
  const summary = build(
    () => ym + '-' + String(last).padStart(2, '0'),
    () => ym + '-' + String(last).padStart(2, '0'),
    () => dates,
    (_sid, date) => ({ date, eligible: eligible.has(date), stamped: earned.has(date) }),
    date => parseYmd(date).getDay(),
    date => addDays(date, -((parseYmd(date).getDay() + 6) % 7)), addDays,
    () => true,
    (_sid, mon) => ({ status: direct.has(mon) ? 'complete' : 'overridden' }),
    () => ({ status: monthStatus }),
    '2026-08-18', '2026-08-17', '2026-09', 80, 3
  );
  return summary('s1', ym);
}

test('monthly reward uses exact 80 percent, three student week closes, and student month close', () => {
  const passed = monthHarness();
  assert.equal(passed.rate, 80);
  assert.equal(passed.weeklyDone, 3);
  assert.equal(passed.qualified, true);

  assert.equal(monthHarness({ stamped: 3 }).qualified, false);
  assert.equal(monthHarness({ directWeeks: 2 }).qualified, false, 'overridden weeks do not count');
  assert.equal(monthHarness({ monthStatus: 'overridden' }).qualified, false, 'overridden month does not count');
  assert.equal(monthHarness({ ym: '2026-08' }).trial, true);
  assert.equal(monthHarness({ ym: '2026-08' }).qualified, false, 'partial launch month is trial-only');
});

test('engagement helpers derive data without storing a score or touching sync', () => {
  const day = functionSource('engagementDayState');
  const month = functionSource('engagementMonthSummary');
  [day, month].forEach(source => {
    assert.doesNotMatch(source, /setCheck|save\(|queueSync|localStorage|state\.checks\s*\[/);
  });
  assert.match(day, /closeState\.close\.status === 'complete'/);
  assert.match(month, /weekCloseOf\(staffId, mon\)\.status === 'complete'/);
  assert.match(month, /monthCloseOf\(staffId, ym\)\.status === 'complete'/);
});

test('Today starts with concrete next actions and keeps optional online links collapsed', () => {
  const todayView = functionSource('viewToday');
  const next = functionSource('todayNextActionItems');
  const optional = functionSource('todayOptionalStudyLinks');
  const card = functionSource('todayNextActionCard');
  assert.ok(todayView.indexOf('todayNextActionCard(') < todayView.indexOf('<div class="card"><div class="prog">'));
  assert.match(next, /stRunning/);
  assert.match(next, /carry\.filter/);
  assert.match(next, /LEARNING_SOURCES\[task\.source\]/);
  assert.match(next, /ingTodayItems/);
  assert.match(next, /wnDue/);
  assert.match(next, /rdDue/);
  assert.match(optional, /\['leaders_eye', 'metamath'\]/);
  assert.match(optional, /<details class="optional-study-links">/);
  assert.match(card, /오늘 해야 할 일/);
  assert.match(card, /오늘 체크리스트를 정리했어요/);
  assert.doesNotMatch(card, /data-target="dailyCloseCard"/);
  assert.match(card, /close\.canReport \|\| close\.complete \? \[\] : todayNextActionItems/);
  assert.match(functionSource('engagementStampDots'), /pending \? '마감 전' : '미획득'/);
});

test('director sees per-student automatic reward progress without changing consult identity', () => {
  const admin = functionSource('viewStaffAdmin');
  const line = functionSource('studentEngagementLine');
  assert.match(admin, /유효 학습일 · 월간 꾸준함상/);
  assert.match(admin, /studentEngagementLine\(s,/);
  assert.match(line, /이번 달 스탬프/);
  assert.match(line, /지난달 최종/);
  assert.match(html, /const LS_KEY = 'wb_consult_v1'/);
  assert.match(html, /const SYNC_APP = 'consult'/);
});
