const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const WBQR = require('../shared/qr.js');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function between(start, end) {
  const from = html.indexOf(start);
  assert.notEqual(from, -1, 'start marker missing: ' + start);
  const to = html.indexOf(end, from);
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

function studentConnectionHarness({ existing, exchangeFails, initialRoute, linkStaffId = 'student-a', storageFails = false }) {
  const source = between('function studentCacheScopedTo(staffId) {', '\nasync function connectAdminDevice()');
  const state = existing ? {
    staff: [{ id: 'student-a', name: '김학생' }],
    tasks: [{ id: 'task-a', staffId: 'student-a' }],
    checks: {},
    settings: { myToken: 'valid-student-token', pushAt: 100 }
  } : {
    staff: [], tasks: [], checks: {}, settings: { myToken: '', pushAt: 0 }
  };

  return new Function('state', 'existing', 'exchangeFails', 'initialRoute', 'initialLinkStaffId', 'storageFails', `
    const STUDENT_LINK_BLOCK_KEY = 'wb_consult_student_link_blocked';
    const store = new Map([[STUDENT_LINK_BLOCK_KEY, 'old blocked error']]);
    const sessionStorage = {
      getItem(key) { return store.has(key) ? store.get(key) : null; },
      setItem(key, value) { store.set(key, String(value)); },
      removeItem(key) { store.delete(key); }
    };
    let linkStaffId = initialLinkStaffId;
    const location = {
      href: 'https://example.com/consult/' + (linkStaffId ? '?u=' + linkStaffId : '') + '#c=used-bootstrap-code',
      pathname: '/consult/', search: linkStaffId ? '?u=' + linkStaffId : '', hash: '#c=used-bootstrap-code'
    };
    const historyUrls = [];
    const history = { replaceState(_state, _title, value) {
      const next = new URL(value, location.href);
      location.href = next.href; location.pathname = next.pathname; location.search = next.search; location.hash = next.hash;
      linkStaffId = next.searchParams.get('u') || '';
      historyUrls.push(value);
    } };
    const session = {
      get staffId() { return linkStaffId; },
      get isStaffLink() { return !!linkStaffId; }
    };
    let pendingStudentCode = 'used-bootstrap-code';
    let pendingStudentWelcome = false;
    let pendingAdminCode = '';
    let pendingAdd = null;
    let studentConnectNeedsApproval = false;
    let studentConnectBusy = false;
    let studentConnectError = 'old blocked error';
    let viewStaff = '';
    let route = initialRoute;
    let exchangeCalls = 0;
    let exchangeStaffId = null;
    let syncRuns = 0;
    let syncStaffId = '';
    let resetCalls = 0;
    let resetStaffId = '';
    let hashClears = 0;
    const routes = [];
    const toasts = [];

    const sync = {
      busy: false,
      err: '',
      loud: false,
      collect() { return []; },
      auth() { return existing ? { mode: 'person', id: 'student-a', token: state.settings.myToken } : null; },
      enabled() { return existing; },
      async exchangeBootstrap(staffId) {
        exchangeCalls++;
        exchangeStaffId = staffId;
        if (exchangeFails) { const error = new Error('already used'); error.status = 410; throw error; }
        return { token: 'new-student-token', staffId: 'student-a' };
      },
      async run() { syncRuns++; syncStaffId = session.staffId; }
    };
    function staffById(id) { return state.staff.find(row => row.id === id) || null; }
    function currentStaff() { return staffById(session.staffId); }
    function ownerOfCheck(key) {
      const taskId = String(key).split('|')[0];
      const special = taskId.match(/^__[a-zA-Z]+__(.+)$/);
      if (special) return special[1];
      const task = state.tasks.find(row => row.id === taskId);
      return task ? task.staffId : null;
    }
    function render() {}
    function save() { return !storageFails; }
    function clearConsultLinkContacts() {}
    function resetStudentLinkCache() { resetCalls++; resetStaffId = session.staffId; return true; }
    function clearStudentCodeHash() { hashClears++; }
    function go(next) { route = next; routes.push(next); }
    function toast(message) { toasts.push(String(message)); }
    function now() { return Date.now(); }

    ${source}

    return {
      run: connectStudentLink,
      snapshot() {
        return {
          route, routes: routes.slice(), toasts: toasts.slice(), exchangeCalls, syncRuns,
          exchangeStaffId, syncStaffId, resetCalls, resetStaffId, hashClears, historyUrls: historyUrls.slice(),
          linkedStaffId: session.staffId, pendingStudentCode, studentConnectError, studentConnectNeedsApproval,
          blocked: sessionStorage.getItem(STUDENT_LINK_BLOCK_KEY)
        };
      }
    };
  `)(state, existing, exchangeFails, initialRoute, linkStaffId, storageFails);
}

function learningSources() {
  const source = between('const LEARNING_SOURCES = Object.freeze(', '\nconst DOW =');
  return new Function(
    'LEADERS_EYE_URL', 'METAMATH_CENTER_URL', 'METAMATH_STUDENT_URL', 'STUDYFORCE_URL',
    'NELT_EXAM_URL', 'DAILY_NONFICTION_URL', 'BRAIN_LETTER_URL', 'CHUNK_BRAIN_URL',
    source + '; return LEARNING_SOURCES;'
  )(
    'https://leaders.example/login', 'https://math-center.example', 'https://math-student.example',
    'https://studyforce.example', 'https://nelt.example', 'https://reading.example',
    'https://letter.example', 'https://chunk.example'
  );
}

function renderLearningSourceCard(studentName, state, sourceKey = 'leaders_eye') {
  const source = between('function learningExamOptions(staffId, selected) {', '\n/* ── 학습 탭');
  const renderCard = new Function(
    'LEARNING_SOURCES', 'ONLINE_LEARNING_SOURCE_KEYS', 'state', 'session', 'isManager', 'isDone', 'learningTaskDate',
    'learningDueDate', 'today', 'esc', 'classcardAppUrl', 'navigator', 'taskRow',
    'CHECKLIST_ONLINE_SOURCE_DEFAULTS', 'isRepeatingTask', 'effectiveOccursOn', 'learningOccurrenceDate', 'repeatLabel',
    source + '; return learningSourceCard;'
  )(
    learningSources(), ['leaders_eye', 'metamath', 'brain_letter', 'chunk_brain', 'vocabulary', 'classcard', 'studyforce', 'nelt_exam', 'daily_nonfiction'],
    state, { isAdmin: false, isStaffLink: true, staffId: 'student-a' }, () => false,
    () => false, task => task.start || '', task => task.dueDate || '', () => '2026-08-31',
    value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]),
    () => '', { userAgent: '', maxTouchPoints: 0 }, () => '',
    {
      leaders_eye: { title: '리더스아이 오늘 학습', subject: 'english', minutes: 20 },
      daily_nonfiction: { title: '하루 비문학 독서', subject: 'korean', minutes: 20 }
    },
    task => !!(task && ['daily', 'weekday', 'days'].includes(task.repeat)),
    (task, date) => !task.deleted && (!task.start || date >= task.start) && (!task.end || date <= task.end) &&
      (task.repeat === 'daily' || (task.repeat === 'weekday' && [1, 2, 3, 4, 5].includes(new Date(date + 'T00:00:00').getDay())) ||
       (task.repeat === 'days' && (task.days || []).includes(new Date(date + 'T00:00:00').getDay())) ||
       (task.repeat === 'once' && task.start === date)),
    (task, date) => ['daily', 'weekday', 'days'].includes(task.repeat) ? date : task.start,
    task => task.repeat === 'weekday' ? '평일(월~금)' : task.repeat || ''
  );
  return renderCard({ id: 'student-a', name: studentName }, true, sourceKey);
}

test('a newly exchanged #c student opens Today and reaches the guide only from the student tab', async () => {
  const harness = studentConnectionHarness({ existing: false, exchangeFails: false, initialRoute: 'guide' });
  await harness.run(true);
  const result = harness.snapshot();

  assert.equal(result.exchangeCalls, 1);
  assert.equal(result.resetCalls, 1);
  assert.equal(result.hashClears, 1);
  assert.equal(result.syncRuns, 1);
  assert.equal(result.route, 'today', 'successful student connection must open Today, not the guide');

  const tabs = functionSource('renderTabs');
  assert.match(tabs, /\['guide', '사용 안내'\]/, 'the guide must remain available as a student tab');
  const startup = between('load();', '\nrender();');
  assert.doesNotMatch(startup, /pendingStudentWelcome[\s\S]*?route\s*=\s*'guide'/,
    'startup must not force the guide over the Today default');
});

test('a code-only #c link restores the returned student ID before storing and syncing', async () => {
  const harness = studentConnectionHarness({
    existing: false, exchangeFails: false, initialRoute: 'today', linkStaffId: ''
  });
  await harness.run(true);
  const result = harness.snapshot();

  assert.equal(result.exchangeStaffId, '', 'code-only exchange must omit a guessed student ID');
  assert.equal(result.linkedStaffId, 'student-a');
  assert.equal(result.resetStaffId, 'student-a', 'the returned student ID must be in the URL before token storage');
  assert.equal(result.syncStaffId, 'student-a', 'the first sync must use the returned student scope');
  assert.ok(result.historyUrls.some(url => /[?&]u=student-a(?:[&#]|$)/.test(url)));
  assert.equal(result.route, 'today');
});

test('a code-only link is not consumed when Safari cannot persist the student session', async () => {
  const harness = studentConnectionHarness({
    existing: false, exchangeFails: false, initialRoute: 'today', linkStaffId: '', storageFails: true
  });
  await harness.run(true);
  const result = harness.snapshot();

  assert.equal(result.exchangeCalls, 0);
  assert.equal(result.pendingStudentCode, 'used-bootstrap-code');
  assert.match(result.studentConnectError, /Safari 또는 Chrome의 일반 탭/);
});

test('opening a fresh student link on a parent phone waits for explicit device confirmation', async () => {
  const harness = studentConnectionHarness({
    existing: false, exchangeFails: false, initialRoute: 'today', linkStaffId: ''
  });
  await harness.run();
  const waiting = harness.snapshot();

  assert.equal(waiting.exchangeCalls, 0);
  assert.equal(waiting.pendingStudentCode, 'used-bootstrap-code');
  assert.equal(waiting.studentConnectNeedsApproval, true);

  await harness.run(true);
  assert.equal(harness.snapshot().exchangeCalls, 1);
});

test('re-tapping the same #c link reuses a valid same-student session without exchange or blocking', async () => {
  const harness = studentConnectionHarness({ existing: true, exchangeFails: true, initialRoute: 'today' });
  await harness.run();
  const result = harness.snapshot();

  assert.equal(result.exchangeCalls, 0, 'a consumed bootstrap code must not be exchanged again');
  assert.equal(result.resetCalls, 0, 'valid same-student cache must not be reset');
  assert.equal(result.hashClears, 1, 'the repeated #c hash must be removed');
  assert.equal(result.pendingStudentCode, '', 'the repeated bootstrap code must be discarded in memory');
  assert.equal(result.studentConnectNeedsApproval, false);
  assert.equal(result.route, 'today');
  assert.equal(result.studentConnectError, '');
  assert.equal(result.blocked, null, 'a valid same-student revisit must clear stale blocked-link errors');
});

test('student management distinguishes the student app link from guardian read-only access', () => {
  const view = functionSource('viewStaffAdmin') + '\n' + functionSource('staffAccessPanels');
  assert.match(view, /data-act="copylink"[^>]*>학생용 링크(?: 복사)?<\/button>/);
  assert.match(view, /data-act="studentqr"[^>]*>QR 코드 만들기<\/button>/);
  assert.match(view, /24시간 안에 한 번만 연결[\s\S]*?가장 최근 링크/);
  assert.match(view, /보호자 열람[\s\S]*?data-act="guardianopen"/);
});

test('director creates the one-time student QR locally without sending its code to a third party', () => {
  const qrModal = functionSource('studentQrModal');
  const actions = between("    case 'copylink':", "    case 'alllinks':");
  const link = 'https://whdudwns33-wb.github.io/wb-site/consult/#c=' + 'a'.repeat(48);
  const svg = WBQR.svg(link, { size: 280 });

  assert.match(html, /<script src="\.\.\/shared\/qr\.js\?v=2026-09-20\.2"><\/script>/);
  assert.match(qrModal, /WBQR\.svg\(link, \{ size: 280 \}\)/);
  assert.match(qrModal, /실제 사용할 휴대폰이나 태블릿[\s\S]*?24시간 안에 한 기기에서 한 번만 연결/);
  assert.doesNotMatch(qrModal, /google|qrserver|chart\.api/i);
  assert.match(actions, /case 'studentqr':[\s\S]*?session\.isAdmin[\s\S]*?createStudentLink\(id\)[\s\S]*?studentQrModal\(id, link\)/);
  assert.match(svg, /^<svg[\s\S]*<\/svg>$/);
});

test('student link confirmation tells a parent to connect only on the daily-use device', () => {
  const view = functionSource('viewStudentLinkConnect');
  const actions = between("    case 'studentretry':", "    case 'studentsetupstart':");
  assert.match(view, /엄마 휴대폰에서 확인 중이라면/);
  assert.match(view, /받은 카카오톡 메시지를 아이패드로 전달/);
  assert.match(view, /페이지를 열기만 해서는 링크가 사용되지 않습니다/);
  assert.match(view, /data-act="studentconnect"[^>]*>이 기기에 학생 플래너 연결/);
  assert.match(actions, /case 'studentconnect':[\s\S]*?connectStudentLink\(true\)/);
});

test('the usage guide explains connection scope and the complete daily closing order', () => {
  const guide = functionSource('studentSetupWizard') + '\n' + functionSource('viewStudentGuide');
  assert.match(guide, /처음 연결/);
  assert.match(guide, /같은 브라우저/);
  assert.match(guide, /학생용 화면/);
  assert.match(guide,
    /타이머 정지[\s\S]*?미완료 공부 정리[\s\S]*?시험·중요 일정 준비율 확인[\s\S]*?마무리 내용 저장[\s\S]*?보고 문자 복사[\s\S]*?보호자에게 전송[\s\S]*?발송했어요/,
    'the guide must preserve the exact daily closing sequence');
  assert.match(guide, /온라인 학습 사용 매뉴얼/);
  assert.match(guide, /Agency ID[\s\S]*?wbbrain[\s\S]*?Student ID·PW는 본인이 입력/);
  assert.match(guide, /메타수학[\s\S]*?본인 아이디·비밀번호/);
  assert.match(guide, /사이트를 닫는 것만으로는 완료 처리되지 않습니다/);
  assert.match(guide, /현재 학생 기기에만 저장되고 서버·원장 화면·백업으로 전송되지 않습니다/);
});

test('Leaders Eye keeps only wbbrain fixed and both services start with blank student login memo fields', () => {
  const state = { tasks: [], checks: {}, settings: { localLearningLogins: {} } };
  const before = JSON.stringify(state);
  const leaders = renderLearningSourceCard('김민준', state, 'leaders_eye');
  const metamath = renderLearningSourceCard('김민준', state, 'metamath');

  assert.match(leaders, /Agency ID[\s\S]*?wbbrain/);
  assert.match(leaders, /id="learningLoginId_leaders_eye"[^>]*value=""/);
  assert.match(leaders, /id="learningLoginPw_leaders_eye"[^>]*type="password"[^>]*value=""/);
  assert.doesNotMatch(leaders, /value="김민준"|0000/);
  assert.match(leaders, /1주일마다 레벨이 자동으로 조정됩니다/);
  assert.match(leaders, /오늘 미기록/);
  assert.match(leaders, /data-act="learningdailyopen"[\s\S]*?오늘 학습 완료 기록/);
  assert.match(metamath, /메타수학 로그인 메모/);
  assert.match(metamath, /id="learningLoginId_metamath"[^>]*value=""/);
  assert.match(metamath, /id="learningLoginPw_metamath"[^>]*type="password"[^>]*value=""/);
  assert.doesNotMatch(metamath, /Agency ID|wbbrain|0000/);
  assert.equal(JSON.stringify(state), before, 'rendering login guidance must not persist credentials');
});

test('student-entered login memos remain device-local and are excluded from sync and backup', () => {
  const state = { settings: { localLearningLogins: {} } };
  let saves = 0;
  const saveMemo = Function('state', 'save', 'LEARNING_LOGIN_MEMO_SOURCES',
    functionSource('saveLearningLoginMemo') + '; return saveLearningLoginMemo;')(
    state, () => { saves++; return true; }, ['leaders_eye', 'metamath']
  );
  assert.equal(saveMemo('student-a', 'leaders_eye', 'my-id', 'my-password'), true);
  assert.deepEqual(state.settings.localLearningLogins, {
    'student-a': { leaders_eye: { loginId: 'my-id', password: 'my-password' } }
  });
  assert.equal(saves, 1);
  assert.equal(saveMemo('student-a', 'unknown', 'bad', 'bad'), false);

  const memoSave = functionSource('saveLearningLoginMemo');
  const syncCollect = functionSource('sanitizedBackupState') + '\n' + between('  collect(since) {', '\n  /** 받은 변경을 반영한다.');
  assert.doesNotMatch(memoSave, /setCheck|queueSync|state\.tasks/);
  assert.match(between('const LOCAL_AUTH_SETTINGS', 'function sanitizedBackupState'), /localLearningLogins/);
  assert.doesNotMatch(syncCollect, /out\.push\(\{ table: 'settings'/);
  assert.doesNotMatch(html, /Student PW[\s\S]{0,100}0000/);
});
