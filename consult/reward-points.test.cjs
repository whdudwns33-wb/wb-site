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
  for (let index = open; index < html.length; index++) {
    const char = html[index];
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return html.slice(start, index + 1);
  }
  assert.fail(name + ' function is incomplete');
}

function accountHarness({ earned = 0, requests = [], decisions = [], cutoffAt = 1000 } = {}) {
  const build = Function('rewardPointEvents', 'pointExchangeDecisions', 'pointRequestsOf', 'ymOf', 'today', 'pointAsOfContext', 'POINT_EXCHANGE_COST',
    functionSource('pointAccount') + '; return pointAccount;');
  const eventRows = earned ? [{ id: 'earned', type: 'day', date: '2026-09-01', at: 1, label: '적립', points: earned }] : [];
  return build(() => eventRows, () => decisions, () => requests, value => value.slice(0, 7), () => '2026-09-01',
    () => ({ throughDate: '2026-09-01', cutoffAt }), 5000)('s1', '2026-09-01');
}

function rewardEventHarness() {
  const dayStates = new Map();
  const dayBreakdowns = new Map();
  const weekCloses = new Map();
  const monthCloses = new Map();
  const monthSummaries = new Map();
  const parseYmd = value => {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day);
  };
  const ymd = date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  const addDays = (value, amount) => {
    const date = parseYmd(value);
    date.setDate(date.getDate() + amount);
    return ymd(date);
  };
  const mondayOf = value => addDays(value, -((parseYmd(value).getDay() + 6) % 7));
  const weekCloseDays = mon => Array.from({ length: 7 }, (_, index) => addDays(mon, index));
  const ymOf = value => value.slice(0, 7);
  const ymAdd = (ym, amount) => {
    const date = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + amount, 1);
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
  };
  const monthLastDate = ym => addDays(ymAdd(ym, 1) + '-01', -1);
  const pointAsOfContext = asOf => {
    const cutoff = parseYmd(asOf);
    cutoff.setHours(23, 59, 59, 999);
    return { throughDate: asOf, cutoffAt: cutoff.getTime() };
  };
  const engagementDayState = (_staffId, date) => Object.assign(
    { date, eligible: false, stamped: false, finalizedAt: 0 }, dayStates.get(date) || {}
  );
  const dailyCloseOf = (_staffId, date) => ({ finalizedAt: Number(engagementDayState('', date).finalizedAt) || 0 });
  const weekCloseOf = (_staffId, mon) => weekCloses.get(mon) || { status: '', completedAt: 0 };
  const monthCloseOf = (_staffId, ym) => monthCloses.get(ym) || { status: '', completedAt: 0 };
  const engagementMonthSummary = (_staffId, ym) => monthSummaries.get(ym) || { plannedDays: 0, stampTargetMet: false };
  const pointRuleFor = Function('POINT_RULE_V2_START_DATE', 'POINT_RULE_VERSION', 'POINT_DAILY', 'POINT_ONLINE_DAILY', 'POINT_WEEKLY', 'POINT_MONTHLY',
    functionSource('pointRuleFor') + '; return pointRuleFor;')('2026-10-01', 'v2', 100, 30, 500, 1000);
  const pointDayBreakdown = (_staffId, date, rule) => dayBreakdowns.get(date) || {
    closePoints: rule.daily, onlineRows: [], onlineEarned: 0
  };
  const learningSources = {
    brain_letter: { label: '브레인레터' }, chunk_brain: { label: '청크브레인' },
    vocabulary: { label: '어휘브레인' }, leaders_eye: { label: '리더스아이' }, metamath: { label: '메타수학' }
  };
  const build = Function(
    'pointAsOfContext', 'POINT_REWARD_START_DATE', 'addDays', 'engagementDayState', 'pointRuleFor', 'pointDayBreakdown', 'LEARNING_SOURCES',
    'dailyCloseOf', 'parseYmd', 'mondayOf', 'weekCloseDays', 'ENGAGEMENT_REWARD_RATE', 'POINT_WEEKLY_MIN_DAYS',
    'weekCloseOf', 'ymOf', 'monthLastDate', 'ymAdd', 'engagementMonthSummary', 'monthCloseOf',
    'POINT_MONTHLY_MIN_DAYS',
    functionSource('pointWeekSummary') + '\n' + functionSource('pointMonthSummary') + '\n' + functionSource('rewardPointEvents') +
      '; return { pointWeekSummary, pointMonthSummary, rewardPointEvents };'
  );
  const api = build(
    pointAsOfContext, '2026-09-01', addDays, engagementDayState, pointRuleFor, pointDayBreakdown, learningSources,
    dailyCloseOf, parseYmd, mondayOf, weekCloseDays, 80, 3,
    weekCloseOf, ymOf, monthLastDate, ymAdd, engagementMonthSummary, monthCloseOf,
    12
  );
  return {
    api, dayStates, dayBreakdowns, weekCloses, monthCloses, monthSummaries,
    at: value => new Date(value).getTime()
  };
}

function onlinePointHarness(itemsByDate, { liveItemsByDate = itemsByDate, closeByDate = {} } = {}) {
  const sourceKeys = ['brain_letter', 'chunk_brain', 'vocabulary', 'leaders_eye', 'metamath'];
  const rowsFor = date => itemsByDate[date] || [];
  const build = Function(
    'dailyCloseOf', 'dailyCloseStudyItems', 'POINT_ONLINE_SOURCE_KEYS', 'hasLearningResult', 'getCheck',
    functionSource('pointOnlineLearningRows') + '\n' + functionSource('pointDayBreakdown') +
      '; return { pointOnlineLearningRows, pointDayBreakdown };'
  );
  const api = build(
    (_staffId, date) => Object.assign({ status: 'open', itemSnapshot: rowsFor(date) }, closeByDate[date] || {}),
    (_staffId, date) => liveItemsByDate[date] || [], sourceKeys, () => false, () => null
  );
  return {
    rows: (date, pool = 30) => api.pointOnlineLearningRows('s1', date, pool),
    breakdown: (date, rule = { daily: 100, dailyClose: 70, online: 30 }) => api.pointDayBreakdown('s1', date, rule)
  };
}

function onlineItem(source, { id = source, done = true, result = true, carriedFromDate = '' } = {}) {
  return {
    key: 'task:' + id, type: 'task', id, source, done,
    learningResultReady: result, carriedFromDate
  };
}

test('5,000P is the exact exchange boundary and pending requests reserve the balance', () => {
  assert.equal(accountHarness({ earned: 4999 }).canRequest, false);
  const ready = accountHarness({ earned: 5000 });
  assert.equal(ready.canRequest, true);
  assert.equal(ready.pct, 100);

  const pending = accountHarness({ earned: 5000, requests: [{ id: 'request_1234', status: 'requested', requestedAt: 10 }] });
  assert.equal(pending.canRequest, false);
  assert.equal(pending.reserved, 5000);
  assert.equal(pending.available, 0);

  const fulfilled = accountHarness({
    earned: 5500,
    requests: [{ id: 'request_1234', status: 'requested', requestedAt: 10 }],
    decisions: [{ pointRequestId: 'request_1234', exchangeStatus: 'fulfilled' }]
  });
  assert.equal(fulfilled.pending, null);
  assert.equal(fulfilled.spent, 5000);
  assert.equal(fulfilled.balance, 500);
  assert.equal(fulfilled.pct, 10);

  const cancelled = accountHarness({
    earned: 5000,
    requests: [{ id: 'request_1234', status: 'requested', requestedAt: 10 }],
    decisions: [{ pointRequestId: 'request_1234', exchangeStatus: 'cancelled' }]
  });
  assert.equal(cancelled.pending, null);
  assert.equal(cancelled.spent, 0);
  assert.equal(cancelled.canRequest, true);
});

test('historical balances respect request and decision timestamps and expose a deficit', () => {
  const beforeCancel = accountHarness({
    earned: 5000, cutoffAt: 100,
    requests: [{ id: 'request_1234', status: 'cancelled', requestedAt: 10, cancelledAt: 500 }]
  });
  assert.equal(beforeCancel.pending.id, 'request_1234');
  const afterCancel = accountHarness({
    earned: 5000, cutoffAt: 600,
    requests: [{ id: 'request_1234', status: 'cancelled', requestedAt: 10, cancelledAt: 500 }]
  });
  assert.equal(afterCancel.pending, null);

  const beforeDecision = accountHarness({
    earned: 5000, cutoffAt: 100,
    decisions: [{ pointRequestId: 'request_1234', exchangeStatus: 'fulfilled', updatedAt: 500 }]
  });
  assert.equal(beforeDecision.spent, 0);

  const deficit = accountHarness({
    earned: 4000,
    decisions: [{ pointRequestId: 'request_1234', exchangeStatus: 'fulfilled', updatedAt: 500 }]
  });
  assert.equal(deficit.rawBalance, -1000);
  assert.equal(deficit.deficit, 1000);
  assert.equal(deficit.canRequest, false);
});

test('a server processing decision is selected before an older extra pending request', () => {
  const account = accountHarness({
    earned: 10000,
    requests: [
      { id: 'request_first', status: 'requested', requestedAt: 10, cancelledAt: 0 },
      { id: 'request_second', status: 'requested', requestedAt: 20, cancelledAt: 0 }
    ],
    decisions: [{ pointRequestId: 'request_second', exchangeStatus: 'processing', updatedAt: 100 }]
  });
  assert.equal(account.processing.pointRequestId, 'request_second');
  assert.equal(account.pending.id, 'request_second');
});

test('weekly bonus uses exact 80 percent and only a student-completed weekly close', () => {
  const build = Function('weekCloseDays', 'engagementDayState', 'weekCloseOf', 'addDays', 'ENGAGEMENT_REWARD_RATE', 'POINT_WEEKLY_MIN_DAYS', 'POINT_REWARD_START_DATE',
    functionSource('pointWeekSummary') + '; return pointWeekSummary;');
  const addDays = (value, amount) => {
    const date = new Date(value + 'T00:00:00');
    date.setDate(date.getDate() + amount);
    return date.toISOString().slice(0, 10);
  };
  const read = (stamped, status, eligibleDays = 5) => build(
    mon => Array.from({ length: 7 }, (_, index) => addDays(mon, index)),
    (_sid, date) => ({ date, eligible: Number(date.slice(8)) <= eligibleDays, stamped: Number(date.slice(8)) <= stamped }),
    () => ({ status }), addDays, 80, 3, '2026-09-01'
  )('s1', '2026-09-01', '2026-09-07');
  assert.equal(read(4, 'complete').qualified, true);
  assert.equal(read(3, 'complete').qualified, false);
  assert.equal(read(5, 'overridden').qualified, false);
  assert.equal(read(1, 'complete', 1).qualified, false, 'one isolated day cannot earn the weekly bonus');
});

test('monthly bonus needs twelve planned learning days, 80 percent and a student close', () => {
  const build = Function('monthLastDate', 'engagementMonthSummary', 'monthCloseOf', 'POINT_MONTHLY_MIN_DAYS',
    functionSource('pointMonthSummary') + '; return pointMonthSummary;');
  const read = (plannedDays, stampTargetMet, status) => build(
    () => '2026-09-30',
    () => ({ plannedDays, stampTargetMet }),
    () => ({ status }), 12
  )('s1', '2026-09', '2026-09-30');
  assert.equal(read(12, true, 'complete').qualified, true);
  assert.equal(read(11, true, 'complete').qualified, false);
  assert.equal(read(12, false, 'complete').qualified, false);
  assert.equal(read(12, true, 'overridden').qualified, false);
});

test('the 30P online pool is split by assigned service and requires a saved learning result', () => {
  const one = onlinePointHarness({
    '2026-10-01': [onlineItem('leaders_eye')]
  });
  assert.deepEqual(one.rows('2026-10-01'), [{ source: 'leaders_eye', done: true, points: 30 }]);

  const two = onlinePointHarness({
    '2026-10-01': [onlineItem('brain_letter'), onlineItem('metamath', { done: false })]
  });
  assert.deepEqual(two.rows('2026-10-01'), [
    { source: 'brain_letter', done: true, points: 15 },
    { source: 'metamath', done: false, points: 15 }
  ]);
  assert.deepEqual(two.breakdown('2026-10-01'), {
    closePoints: 70,
    onlineRows: two.rows('2026-10-01'),
    onlineEarned: 15
  });

  const duplicate = onlinePointHarness({
    '2026-10-01': [
      onlineItem('brain_letter', { id: 'letter-a', done: false, result: false }),
      onlineItem('brain_letter', { id: 'letter-b' }),
      onlineItem('classcard')
    ]
  });
  assert.deepEqual(duplicate.rows('2026-10-01'), [
    { source: 'brain_letter', done: true, points: 30 }
  ], 'the same service earns at most once and non-reward services are ignored');

  const missingResult = onlinePointHarness({
    '2026-10-01': [onlineItem('chunk_brain', { result: false })]
  });
  assert.equal(missingResult.rows('2026-10-01')[0].done, false,
    'opening a site or checking done without a learning result earns nothing');
});

test('online point shares remain integer and carried study belongs only to its completion date', () => {
  const four = onlinePointHarness({
    '2026-10-01': ['brain_letter', 'chunk_brain', 'vocabulary', 'leaders_eye'].map(source => onlineItem(source))
  });
  assert.deepEqual(four.rows('2026-10-01').map(row => row.points), [8, 8, 7, 7]);
  assert.equal(four.rows('2026-10-01').reduce((sum, row) => sum + row.points, 0), 30);

  const five = onlinePointHarness({
    '2026-10-01': ['brain_letter', 'chunk_brain', 'vocabulary', 'leaders_eye', 'metamath'].map(source => onlineItem(source))
  });
  assert.deepEqual(five.rows('2026-10-01').map(row => row.points), [6, 6, 6, 6, 6]);

  const carry = onlinePointHarness({
    '2026-10-01': [],
    '2026-10-02': [onlineItem('metamath', { carriedFromDate: '2026-10-01' })]
  });
  assert.deepEqual(carry.rows('2026-10-01'), []);
  assert.deepEqual(carry.rows('2026-10-02'), [{ source: 'metamath', done: true, points: 30 }]);
  assert.deepEqual(carry.breakdown('2026-09-30', { daily: 50, dailyClose: 50, online: 0 }), {
    closePoints: 50, onlineRows: [], onlineEarned: 0
  }, 'September v1 remains unchanged');

  assert.match(functionSource('pointOnlineLearningRows'), /snapshotReady \? close\.itemSnapshot/,
    'a finalized day must keep the service split even if schedules change later');
  assert.match(html, /const snapshot = data\.items\.map[\s\S]*source: item\.source[\s\S]*learningResultReady:/,
    'daily close snapshots must preserve the service and verified result state');

  const frozenEmpty = onlinePointHarness({ '2026-10-03': [] }, {
    liveItemsByDate: { '2026-10-03': [onlineItem('brain_letter')] },
    closeByDate: { '2026-10-03': { status: 'complete', finalizedAt: 1 } }
  });
  assert.deepEqual(frozenEmpty.rows('2026-10-03'), [],
    'an intentionally empty finalized snapshot must not be replaced by a later schedule change');
});

test('rewardPointEvents preserves September v1 and switches daily, weekly and monthly events to v2 on October 1', () => {
  const harness = rewardEventHarness();
  const { api, dayStates, dayBreakdowns, weekCloses, monthCloses, monthSummaries, at } = harness;
  assert.deepEqual(api.rewardPointEvents('s1', '2026-08-31'), [], 'nothing accrues before the 9/1 launch');

  dayStates.set('2026-09-01', { eligible: true, stamped: true, finalizedAt: at('2026-09-02T10:00:00') });
  dayStates.set('2026-09-02', { eligible: true, stamped: true, finalizedAt: at('2026-09-02T20:00:00') });
  dayStates.set('2026-09-03', { eligible: true, stamped: true, finalizedAt: at('2026-09-03T20:00:00') });
  assert.equal(api.rewardPointEvents('s1', '2026-09-01').some(event => event.id === 'v1:day:2026-09-01'), false,
    'a stamp finalized after the as-of cutoff must stay hidden');
  assert.equal(api.rewardPointEvents('s1', '2026-09-02').some(event => event.id === 'v1:day:2026-09-01'), true,
    'the same stamp appears once its finalization is inside the as-of cutoff');

  weekCloses.set('2026-08-31', { status: 'complete', completedAt: at('2026-09-05T20:00:00') });
  const firstPartialWeek = api.pointWeekSummary('s1', '2026-08-31', '2026-09-06');
  assert.deepEqual(firstPartialWeek.days.map(day => day.date), ['2026-09-01', '2026-09-02', '2026-09-03'],
    'the launch partial week excludes 8/31 and counts only planned learning days');
  assert.equal(api.rewardPointEvents('s1', '2026-09-05').some(event => event.id === 'v1:week:2026-08-31'), false,
    'a week cannot accrue before its Sunday period end');
  assert.equal(api.rewardPointEvents('s1', '2026-09-06').some(event => event.id === 'v1:week:2026-08-31'), true);

  monthSummaries.set('2026-09', { plannedDays: 12, stampTargetMet: true });
  monthCloses.set('2026-09', { status: 'complete', completedAt: at('2026-09-30T20:00:00') });
  assert.equal(api.rewardPointEvents('s1', '2026-09-29').some(event => event.id === 'v1:month:2026-09'), false,
    'a month cannot accrue before its last date');
  const finalEvents = api.rewardPointEvents('s1', '2026-09-30');
  assert.equal(finalEvents.some(event => event.id === 'v1:month:2026-09'), true);
  assert.equal(new Set(finalEvents.map(event => event.id)).size, finalEvents.length, 'v1 ledger ids must be unique');
  assert.equal(finalEvents.reduce((sum, event) => sum + event.points, 0), 900, '3 days + 1 week + 1 month');

  ['2026-10-01', '2026-10-02', '2026-10-03'].forEach(date => {
    dayStates.set(date, { eligible: true, stamped: true, finalizedAt: at(date + 'T20:00:00') });
  });
  dayBreakdowns.set('2026-10-01', {
    closePoints: 70,
    onlineRows: [
      { source: 'brain_letter', done: true, points: 15 },
      { source: 'metamath', done: false, points: 15 }
    ],
    onlineEarned: 15
  });
  weekCloses.set('2026-09-28', { status: 'complete', completedAt: at('2026-10-04T20:00:00') });
  monthSummaries.set('2026-10', { plannedDays: 12, stampTargetMet: true });
  monthCloses.set('2026-10', { status: 'complete', completedAt: at('2026-10-31T20:00:00') });
  const octoberEvents = api.rewardPointEvents('s1', '2026-10-31');
  assert.equal(octoberEvents.find(event => event.id === 'v2:day:2026-10-01').points, 70);
  assert.equal(octoberEvents.find(event => event.id === 'v2:online:2026-10-01:brain_letter').points, 15);
  assert.equal(octoberEvents.some(event => event.id === 'v2:online:2026-10-01:metamath'), false,
    'an assigned but unfinished service forfeits only its own share');
  assert.equal(octoberEvents.find(event => event.id === 'v2:day:2026-10-02').points, 100,
    'a day without assigned online learning keeps the full daily award');
  assert.equal(octoberEvents.find(event => event.id === 'v2:week:2026-09-28').points, 500,
    'the boundary week uses its Sunday award date');
  assert.equal(octoberEvents.find(event => event.id === 'v2:month:2026-10').points, 1000);
  assert.equal(new Set(octoberEvents.map(event => event.id)).size, octoberEvents.length, 'v1 and v2 ledger ids stay unique');

  dayStates.set('2026-11-01', { eligible: true, stamped: false, finalizedAt: at('2026-11-01T20:00:00') });
  dayBreakdowns.set('2026-11-01', {
    closePoints: 70, onlineRows: [{ source: 'leaders_eye', done: true, points: 30 }], onlineEarned: 30
  });
  const unclosed = api.rewardPointEvents('s1', '2026-11-01');
  assert.equal(unclosed.some(event => event.date === '2026-11-01'), false,
    'online completion stays unearned until the whole day is a valid student close');
});

test('point exchange decisions use the server CAS ledger and never become learning activity', () => {
  const action = functionSource('runPointExchangeAdminAction');
  assert.match(action, /session\.isAdmin/);
  assert.match(action, /sync\.post\('\/consult-reward'/);
  assert.match(action, /ownedRequests/);
  assert.match(action, /recoveryRequests/);
  assert.match(action, /response\.resumed/);
  assert.match(action, /state\.settings\.adminToken/);
  assert.doesNotMatch(action, /claimToken/);
  assert.doesNotMatch(html, /claimToken/);
  assert.doesNotMatch(action, /state\.tasks\.push/);
  assert.match(html, /startsWith\('__rewardtx__'\)\) return/);
  assert.match(functionSource('isStudentActivityCheck'), /__pointrequest__.*__rewardtx__/s);
  assert.match(functionSource('cachePointExchangeResponse'), /consult_reward_redemption/);
});

test('existing processing can be fulfilled or cancelled after the student is deleted, but a new claim cannot', async () => {
  const build = Function(
    'session', 'pointExchangeUi', 'staffById', 'state', 'sync', 'toast', 'pointAccount', 'today', 'POINT_EXCHANGE_COST',
    'pointOwnedRequestKey', 'cachePointExchangeResponse', 'SYNC_APP', 'render', 'pointHistoryModal',
    functionSource('runPointExchangeAdminAction').replace(/^function /, 'async function ') + '; return runPointExchangeAdminAction;'
  );
  const run = async (action, student, balance = 5000) => {
    const posts = [];
    const toasts = [];
    const pointExchangeUi = {
      busy: '', ownedRequests: new Set(['s1|request_1234']), recoveryRequests: new Set()
    };
    const sync = {
      busy: false, err: '', auth: () => ({ mode: 'admin_device', token: 'device-token' }), run: async () => {},
      post: async (endpoint, payload) => {
        posts.push({ endpoint, payload });
        return { key: '__rewardtx__s1|request_1234', status: action === 'fulfill' ? 'fulfilled' : 'cancelled',
          claimedAt: 1, takenOverAt: 0, updatedAt: 2, owned: true };
      }
    };
    const actionFn = build(
      { isAdmin: true, isStaffLink: false }, pointExchangeUi, () => student, { settings: { adminToken: 'device-token' } },
      sync, message => toasts.push(message),
      () => ({ pending: { id: 'request_1234' }, processing: { updatedAt: 1, takenOverAt: 0 },
        deficit: balance < 0 ? -balance : 0, balance: Math.max(0, balance) }),
      () => '2026-09-01', 5000, (staffId, requestId) => staffId + '|' + requestId,
      () => true, 'consult', () => {}, () => {}
    );
    const result = await actionFn('s1', 'request_1234', action);
    return { result, posts, toasts };
  };

  const cancelled = await run('cancel', null);
  assert.equal(cancelled.posts[0].payload.action, 'cancel', 'an existing server processing row is enough to cancel');
  const fulfilled = await run('fulfill', { id: 's1', deleted: true });
  assert.equal(fulfilled.posts[0].payload.action, 'fulfill', 'deletion must not strand an already claimed exchange');
  const fulfilledAfterShortfall = await run('fulfill', { id: 's1' }, 1000);
  assert.equal(fulfilledAfterShortfall.posts[0].payload.action, 'fulfill',
    'an already-sent voucher must still reach the terminal ledger after a last-second shortfall');
  const claim = await run('claim', { id: 's1', deleted: true });
  assert.equal(claim.result, null);
  assert.equal(claim.posts.length, 0, 'deleted/non-student records still cannot start a new claim');
  assert.equal(claim.toasts.length, 1);
});

test('same-device owner recovery is tracked only as a non-secret request key and never reopens blind sending', async () => {
  const build = Function(
    'session', 'pointExchangeUi', 'staffById', 'state', 'sync', 'toast', 'pointAccount', 'today', 'POINT_EXCHANGE_COST',
    'pointOwnedRequestKey', 'cachePointExchangeResponse', 'SYNC_APP', 'render', 'pointHistoryModal',
    functionSource('runPointExchangeAdminAction').replace(/^function /, 'async function ') + '; return runPointExchangeAdminAction;'
  );
  const invoke = async (processing, resumed) => {
    const pointExchangeUi = { busy: '', ownedRequests: new Set(), recoveryRequests: new Set() };
    const sync = {
      busy: false, err: '', auth: () => ({ mode: 'admin_device', token: 'not-persisted-here' }), run: async () => {},
      post: async () => ({ key: '__rewardtx__s1|request_1234', status: 'processing', claimedAt: 1,
        takenOverAt: 0, updatedAt: 2, claimed: true, owned: true, resumed })
    };
    const actionFn = build(
      { isAdmin: true, isStaffLink: false }, pointExchangeUi, () => ({ id: 's1' }),
      { settings: { adminToken: 'device-token' } }, sync, () => {},
      () => ({ pending: { id: 'request_1234' }, processing, deficit: 0, balance: 5000 }),
      () => '2026-09-01', 5000, (staffId, requestId) => staffId + '|' + requestId,
      () => true, 'consult', () => {}, () => {}
    );
    await actionFn('s1', 'request_1234', 'claim');
    return pointExchangeUi;
  };

  const first = await invoke(null, false);
  assert.deepEqual([...first.ownedRequests], ['s1|request_1234']);
  assert.equal(first.recoveryRequests.size, 0, 'a first successful claim may show the normal send flow');
  const resumed = await invoke({ updatedAt: 1, takenOverAt: 0 }, true);
  assert.deepEqual([...resumed.recoveryRequests], ['s1|request_1234'],
    'response-loss or reload recovery must use the previous-send verification flow');
});

test('Today shows a 5,000P gauge, rules and history while the director gets fulfil and cancel controls', () => {
  const gauge = functionSource('pointGaugeHtml');
  const modal = functionSource('pointHistoryModal');
  const card = functionSource('todayNextActionCard');
  assert.match(gauge, /기프트 카드 포인트/);
  assert.match(gauge, /role="progressbar"/);
  assert.match(gauge, /유효 학습일/);
  assert.match(gauge, /오늘 온라인 학습/);
  assert.match(gauge, /온라인 완료 최대/);
  assert.match(gauge, /pointrequest/);
  assert.match(gauge, /student\.owner \|\| student\.manager/);
  assert.match(card, /pointGaugeHtml\(me\.id\)/);
  assert.match(modal, /적립 방법/);
  assert.match(modal, /실제 발송 완료/);
  assert.match(modal, /하루 마감 70P/);
  assert.match(modal, /링크만 여는 것은 인정되지 않으며/);
  assert.match(modal, /기프트 카드 번호·링크는 앱에 저장하지 않습니다/);
  assert.match(modal, /row\.points > 0 \? '\+' : row\.points < 0 \? '-' : ''/,
    'fulfilled exchanges must render as -5,000P instead of an unsigned amount');
  assert.match(modal, /처리 기기 확인/);
  assert.match(modal, /30분 지난 처리 인계/);
  assert.match(modal, /새 기프트 카드를 발송하지 마세요/);
  assert.match(modal, /이미 발송됨 · 완료·차감/);
  assert.match(modal, /processingRecovery \|\| processingShortfall/,
    'recovered and shortfall leases must use the prior-send verification choices');
  assert.match(modal, /account\.pending[\s\S]*account\.deficit[\s\S]*data-act="pointcancel"/,
    'a pending student request remains cancellable even if its balance later falls');
  assert.match(modal, /신청 잔액이 부족합니다[\s\S]*data-act="pointreject"/,
    'the director may terminate a pre-claim shortfall without spending points');
  assert.match(html, /case 'pointfulfill'/);
  assert.match(html, /case 'pointadmincancel'/);
  assert.match(html, /case 'pointclaim'/);
  assert.match(html, /case 'pointownercheck'/);
  assert.match(html, /case 'pointtakeover'/);
  assert.match(html, /새 기프트 카드를 발송하지 말고, 이전 기기에서 이미 발송했는지 먼저 확인/);
  assert.match(html, /인계 완료 · 새 기프트 카드를 발송하지 말고 이전 발송 여부를 확인/);
  assert.doesNotMatch(html, /문화상품권|상품권/);
  assert.match(html, /case 'pointreject'[\s\S]*'reject'/);
  assert.match(html, /const LS_KEY = 'wb_consult_v1'/);
  assert.match(html, /const SYNC_APP = 'consult'/);
  const sourceCard = functionSource('learningSourceCard');
  assert.match(sourceCard, /POINT_ONLINE_SOURCE_KEYS/);
  assert.match(sourceCard, /오늘 미학습/);
  assert.match(sourceCard, /마감 대기/);
});

test('processing identity stays reachable and blocks student deletion or role conversion', () => {
  const staffView = functionSource('staffAccessPanels');
  assert.match(staffView, /hasProcessingPointExchange/);
  assert.match(staffView, /학생 삭제·대표·관리자 전환/);
  ['delstaff', 'toggleowner', 'togglemanager'].forEach(action => {
    const marker = "case '" + action + "'";
    const start = html.indexOf(marker);
    assert.notEqual(start, -1);
    assert.match(html.slice(start, start + 800), /hasProcessingPointExchange/);
  });
});

test('a stale device rolls back deleted and role changes to authoritative staff plus the processing entry', () => {
  const build = Function('state', functionSource('restoreRewardProcessingLock') + '; return restoreRewardProcessingLock;');
  const canonical = { id: 's1', name: '학생', deleted: false, owner: false, manager: false, updatedAt: 100 };
  const reward = {
    kind: 'consult_reward_redemption', version: 1, staffId: 's1', requestId: 'request_1234',
    status: 'processing', claimedAt: 10, updatedAt: 20, claimActorHash: 'must-not-reach-client'
  };
  for (const stalePatch of [{ deleted: true }, { owner: true }, { manager: true }]) {
    const state = { staff: [{ ...canonical, ...stalePatch, updatedAt: 999 }], checks: {} };
    const restore = build(state);
    const restored = restore(
      [{ table: 'staff', key: 's1', data: canonical, authoritative: true }],
      [{ table: 'checks', key: '__rewardtx__s1|request_1234', data: reward, authoritative: true }]
    );
    assert.equal(restored, 2, JSON.stringify(stalePatch));
    assert.deepEqual(state.staff[0], canonical, JSON.stringify(stalePatch));
    assert.equal(state.checks['__rewardtx__s1|request_1234'].status, 'processing');
    assert.equal(Object.hasOwn(state.checks['__rewardtx__s1|request_1234'], 'claimActorHash'), false);
  }
  assert.match(html, /e\.code === 'REWARD_PROCESSING_LOCK'/);
  assert.match(html, /authoritativeRewardChecks/);
  assert.match(html, /queueSync\(\); \/\/ 이어서 processing 원장을 받아 정산 화면을 다시 연다/);
});

test('locked Today states keep the main point gauge before each early return', () => {
  const source = functionSource('viewToday');
  ['if (priorCloseDates.length)', 'if (priorWeekMon)', 'if (priorMonthYm)'].forEach(marker => {
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, marker + ' branch must exist');
    const end = source.indexOf('return h;', start);
    assert.notEqual(end, -1, marker + ' branch must return');
    assert.match(source.slice(start, end), /pointGaugeHtml\(me\.id\)/, marker + ' must render the gauge before locking Today');
  });
});
