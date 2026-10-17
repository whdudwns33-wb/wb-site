const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

function between(start, end) {
  const from = html.indexOf(start);
  assert.notEqual(from, -1, 'start marker missing: ' + start);
  const to = html.indexOf(end, from + start.length);
  assert.notEqual(to, -1, 'end marker missing: ' + end);
  return html.slice(from, to);
}

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

function asyncFunctionSource(name) {
  const source = functionSource(name);
  const marker = 'async function ' + name + '(';
  assert.notEqual(html.indexOf(marker), -1, name + ' must stay asynchronous');
  return 'async ' + source;
}

function dateMath() {
  const parse = value => new Date(value + 'T00:00:00Z');
  const ymd = date => date.toISOString().slice(0, 10);
  const addDays = (value, amount) => {
    const date = parse(value);
    date.setUTCDate(date.getUTCDate() + Number(amount));
    return ymd(date);
  };
  const mondayOf = value => {
    const date = parse(value);
    const dow = date.getUTCDay();
    return addDays(value, dow === 0 ? -6 : 1 - dow);
  };
  return { addDays, mondayOf };
}

test('each student activation date excludes older daily, weekly, and monthly closeouts', () => {
  const state = { checks: {
    '__closeactive__student-new|all': { activatedOn: '2026-10-17' },
    '__closeactive__student-old|all': { activatedOn: '2026-09-01' }
  } };
  const getCheck = (taskId, date) => state.checks[taskId + '|' + date] || null;
  const { addDays, mondayOf } = dateMath();
  const activationSource = between('const closeoutActivationKey =', '\nconst weekCloseKey =');
  const closeout = new Function(
    'getCheck', 'addDays', 'mondayOf',
    activationSource + '; return { closeoutActivationDate, closeoutDateApplies, closeoutWeekApplies };'
  )(getCheck, addDays, mondayOf);
  const closeoutMonthApplies = new Function(
    'closeoutDateApplies', 'monthLastDate',
    functionSource('closeoutMonthApplies') + '; return closeoutMonthApplies;'
  )(
    closeout.closeoutDateApplies,
    ym => addDays(addDays(ym + '-01', 32).slice(0, 7) + '-01', -1)
  );

  assert.equal(closeout.closeoutActivationDate('student-new'), '2026-10-17');
  assert.equal(closeout.closeoutDateApplies('student-new', '2026-10-16'), false);
  assert.equal(closeout.closeoutDateApplies('student-new', '2026-10-17'), true);
  assert.equal(closeout.closeoutWeekApplies('student-new', '2026-10-05'), false,
    'a week that ended before activation must not become a retroactive requirement');
  assert.equal(closeout.closeoutWeekApplies('student-new', '2026-10-12'), true,
    'the first week containing active dates is eligible for closeout');
  assert.equal(closeoutMonthApplies('student-new', '2026-09'), false,
    'a month ending before activation must stay outside the closeout gate');
  assert.equal(closeoutMonthApplies('student-new', '2026-10'), true);
  assert.equal(closeoutMonthApplies('student-old', '2026-09'), true,
    'activation is scoped per student instead of being a global cutover');

  assert.match(functionSource('dailyUnclosedDates'), /closeoutDateApplies\(staffId, target\)/);
  assert.match(functionSource('previousUnclosedWeek'), /closeoutWeekApplies\(staffId, mon\)/);
  assert.match(functionSource('previousUnclosedMonth'), /closeoutMonthApplies\(staffId, ym\)/);
});

test('a reviewed closeout returns to its report step after refresh', () => {
  const dailyCloseState = new Function(
    'dailyCloseOf', 'dailyCloseStudyItems', 'dailyCloseEventRefs', 'today', 'stRunning',
    'dailyCloseSignature', 'DAILY_CLOSE_LECTURE_RULE_START', 'DAILY_CLOSE_SCHEMA_VERSION',
    functionSource('dailyCloseState') + '; return dailyCloseState;'
  )(
    () => ({
      status: 'reviewed', reviewedAt: 100, reviewSignature: 'current-signature',
      resolutions: {}, eventProgress: {}, signature: '', schemaVersion: 2
    }),
    () => [], () => [], () => '2026-10-17', () => null, () => 'current-signature',
    '2026-09-01', 2
  );
  assert.equal(dailyCloseState('student-a', '2026-10-17').canReport, true,
    'a current reviewed snapshot must reopen at the daily report step');

  const dailyCard = functionSource('dailyClosureCard');
  assert.match(dailyCard, /data\.canReport[\s\S]*?data-act="report"/);

  const weekOpen = between("    case 'weekcloseopen':", "    case 'weekclosesave':");
  const weekReviewed = weekOpen.indexOf("status === 'reviewed'");
  assert.ok(weekReviewed >= 0 && weekReviewed < weekOpen.indexOf('weekCloseUnclosedDays'),
    'reviewed weekly closeouts must reopen the report before prerequisite routing');
  assert.ok(weekOpen.indexOf('weekReportModal', weekReviewed) >= 0);

  const monthOpen = between("    case 'monthcloseopen':", "    case 'monthclosesave':");
  const monthReviewed = monthOpen.indexOf("status === 'reviewed'");
  assert.ok(monthReviewed >= 0 && monthReviewed < monthOpen.indexOf('monthCloseUnclosedDays'),
    'reviewed monthly closeouts must reopen the report before prerequisite routing');
  assert.ok(monthOpen.indexOf('monthCloseReportModal', monthReviewed) >= 0);
});

test('final closeout waits for server confirmation and rolls back when verification fails', async () => {
  const calls = [];
  const toasts = [];
  const previousClose = { status: 'reviewed', reviewToken: 'review-1' };
  const nextClose = { status: 'complete', reviewToken: 'review-1' };
  let currentClose = structuredClone(previousClose);
  const state = { settings: { pushAt: 499 } };
  const sync = {
    timer: null,
    err: '',
    confirmed: new Map(),
    enabled: () => true,
    async run() { await Promise.resolve(); }
  };
  const saveStudentCloseout = new Function(
    'setCheck', 'getCheck', 'ckey', 'sync', 'waitForSyncIdle', 'state', 'toast',
    asyncFunctionSource('saveStudentCloseout') + '; return saveStudentCloseout;'
  )(
    (taskId, date, patch) => {
      calls.push({ taskId, date, patch: structuredClone(patch) });
      currentClose = structuredClone(patch.close);
      return { updatedAt: 500 };
    },
    () => ({ close: structuredClone(currentClose) }), (taskId, date) => taskId + '|' + date,
    sync, async () => true, state, message => toasts.push(String(message))
  );

  const saved = await saveStudentCloseout('__dayclose__student-a', '2026-10-17', nextClose, previousClose, '하루 마감');
  assert.equal(saved, false);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].patch.close, nextClose);
  assert.deepEqual(calls[1].patch.close, previousClose,
    'the local complete state must be restored to reviewed when the server cursor did not confirm it');
  assert.match(toasts.at(-1), /서버에 저장하지 못했습니다/);

  const successState = { settings: { pushAt: 499 } };
  let successClose = structuredClone(previousClose);
  let successRuns = 0;
  const successSync = {
    timer: null, err: '', confirmed: new Map(), enabled: () => true,
    async run() {
      successRuns++;
      if (successRuns === 2) {
        successState.settings.pushAt = 500;
        this.confirmed.set('checks\n__dayclose__student-a|2026-10-17', 500);
      }
    }
  };
  const confirmedSave = new Function(
    'setCheck', 'getCheck', 'ckey', 'sync', 'waitForSyncIdle', 'state', 'toast',
    asyncFunctionSource('saveStudentCloseout') + '; return saveStudentCloseout;'
  )(
    (_taskId, _date, patch) => { successClose = structuredClone(patch.close); return { updatedAt: 500 }; },
    () => ({ close: structuredClone(successClose) }), (taskId, date) => taskId + '|' + date,
    successSync, async () => true, successState, () => {}
  );
  assert.equal(await confirmedSave('__dayclose__student-a', '2026-10-17', nextClose, previousClose, '하루 마감'), true);
  assert.deepEqual(successClose, nextClose, 'a server-confirmed completion must remain complete');

  const finishCases = [
    between("    case 'dailyreportfinish':", "    case 'brief':"),
    between("    case 'weekclosefinish':", "    case 'weekoverrideopen':"),
    between("    case 'monthclosefinish':", "    case 'monthoverrideopen':")
  ];
  finishCases.forEach(source => {
    assert.match(source, /if \(!\(await saveStudentCloseout\([\s\S]*?\)\)\) break;/,
      'daily, weekly, and monthly completion must await the verified save before advancing');
  });
  const saveSource = functionSource('saveStudentCloseout');
  assert.match(saveSource, /await sync\.run\(\)/);
  assert.match(saveSource, /sync\.confirmed\.get\(confirmKey\)/);
  assert.match(saveSource, /pushAt[\s\S]*?>=[\s\S]*?saved\.updatedAt/);
});

function sameStudentRecoveryHarness() {
  const state = {
    staff: [{ id: 'student-a', name: '윤지우' }],
    checks: {
      'task-unsent|2026-10-17': { done: true, updatedAt: 700, origin: 'student-a' }
    },
    settings: { myToken: 'old-token', pushAt: 100 }
  };
  const source = asyncFunctionSource('connectStudentLink');
  return new Function('state', `
    let pendingStudentCode = 'fresh-bootstrap-code';
    let studentConnectBusy = false;
    let studentConnectError = '';
    let studentConnectNeedsApproval = false;
    let route = 'today';
    let resetCalls = 0;
    let exchangeCalls = 0;
    let syncRuns = 0;
    let activationCalls = 0;
    const toasts = [];
    const STUDENT_LINK_BLOCK_KEY = 'blocked-student-link';
    const sessionStore = new Map();
    const sessionStorage = {
      setItem(key, value) { sessionStore.set(key, String(value)); },
      removeItem(key) { sessionStore.delete(key); }
    };
    const session = { isStaffLink: true, get staffId() { return 'student-a'; } };
    const location = {
      href: 'https://example.com/consult/?u=student-a#c=fresh-bootstrap-code',
      pathname: '/consult/', search: '?u=student-a', hash: '#c=fresh-bootstrap-code'
    };
    const history = { replaceState() {} };
    const sync = {
      err: '', loud: false,
      async run() {
        syncRuns++;
        if (syncRuns === 1) this.err = 'offline';
        else this.err = '';
      },
      collect() { return Object.values(state.checks).filter(row => row.updatedAt > state.settings.pushAt); },
      async exchangeBootstrap(staffId, code) {
        exchangeCalls++;
        return { staffId, token: 'new-token' };
      }
    };
    function staffById(id) { return state.staff.find(row => row.id === id) || null; }
    function studentCacheScopedTo(id) {
      return id === 'student-a' && Object.keys(state.checks).includes('task-unsent|2026-10-17');
    }
    function save() { return true; }
    function resetStudentLinkCache(token) {
      resetCalls++;
      state.checks = {};
      state.settings.myToken = token;
      return true;
    }
    function clearStudentCodeHash() { location.hash = ''; }
    function render() {}
    function toast(message) { toasts.push(String(message)); }
    async function waitForSyncIdle() { return true; }
    async function ensureCloseoutActivation() { activationCalls++; return '2026-10-17'; }

    ${source}

    return {
      run: connectStudentLink,
      snapshot() {
        return {
          state: JSON.parse(JSON.stringify(state)), pendingStudentCode, route, resetCalls,
          exchangeCalls, syncRuns, activationCalls, toasts: toasts.slice()
        };
      }
    };
  `)(state);
}

test('same-student reauthentication keeps unsent records instead of resetting the cache', async () => {
  const harness = sameStudentRecoveryHarness();
  await harness.run(true);
  const result = harness.snapshot();

  assert.equal(result.exchangeCalls, 1, 'the expired same-student token should be exchanged once');
  assert.equal(result.resetCalls, 0, 'same-student recovery must not clear the local student cache');
  assert.deepEqual(result.state.checks, {
    'task-unsent|2026-10-17': { done: true, updatedAt: 700, origin: 'student-a' }
  });
  assert.equal(result.state.settings.myToken, 'new-token');
  assert.equal(result.pendingStudentCode, '');
  assert.equal(result.route, 'today');
  assert.equal(result.syncRuns, 2, 'recovery retries sync after replacing the expired token');
  assert.equal(result.activationCalls, 1);
});
