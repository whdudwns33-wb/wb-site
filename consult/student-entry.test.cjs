const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

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

function studentConnectionHarness({ existing, exchangeFails, initialRoute }) {
  const source = between('function studentCacheScopedTo(staffId) {', '\nasync function connectAdminDevice()');
  const state = existing ? {
    staff: [{ id: 'student-a', name: '김학생' }],
    tasks: [{ id: 'task-a', staffId: 'student-a' }],
    checks: {},
    settings: { myToken: 'valid-student-token', pushAt: 100 }
  } : {
    staff: [], tasks: [], checks: {}, settings: { myToken: '', pushAt: 0 }
  };

  return new Function('state', 'existing', 'exchangeFails', 'initialRoute', `
    const STUDENT_LINK_BLOCK_KEY = 'wb_consult_student_link_blocked';
    const store = new Map([[STUDENT_LINK_BLOCK_KEY, 'old blocked error']]);
    const sessionStorage = {
      getItem(key) { return store.has(key) ? store.get(key) : null; },
      setItem(key, value) { store.set(key, String(value)); },
      removeItem(key) { store.delete(key); }
    };
    const session = { staffId: 'student-a', isStaffLink: true };
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
    let syncRuns = 0;
    let resetCalls = 0;
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
      async exchangeBootstrap() {
        exchangeCalls++;
        if (exchangeFails) { const error = new Error('already used'); error.status = 410; throw error; }
        return { token: 'new-student-token' };
      },
      async run() { syncRuns++; }
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
    function save() { return true; }
    function clearConsultLinkContacts() {}
    function resetStudentLinkCache() { resetCalls++; return true; }
    function clearStudentCodeHash() { hashClears++; }
    function isEmbeddedStudentBrowser() { return false; }
    const location = { hash: '' };
    function go(next) { route = next; routes.push(next); }
    function toast(message) { toasts.push(String(message)); }
    function now() { return Date.now(); }

    ${source}

    return {
      run: connectStudentLink,
      snapshot() {
        return {
          route, routes: routes.slice(), toasts: toasts.slice(), exchangeCalls, syncRuns,
          resetCalls, hashClears, pendingStudentCode, studentConnectError,
          blocked: sessionStorage.getItem(STUDENT_LINK_BLOCK_KEY)
        };
      }
    };
  `)(state, existing, exchangeFails, initialRoute);
}

function learningSources() {
  const source = between('const LEARNING_SOURCES = Object.freeze(', '\nconst DOW =');
  return new Function(
    'LEADERS_EYE_URL', 'METAMATH_CENTER_URL', 'METAMATH_STUDENT_URL', 'STUDYFORCE_URL',
    'NELT_EXAM_URL', 'DAILY_NONFICTION_URL',
    source + '; return LEARNING_SOURCES;'
  )(
    'https://leaders.example/login', 'https://math-center.example', 'https://math-student.example',
    'https://studyforce.example', 'https://nelt.example', 'https://reading.example'
  );
}

function renderLearningSourceCard(studentName, state) {
  const source = between('function learningExamOptions(staffId, selected) {', '\n/* ── 학습 탭');
  const renderCard = new Function(
    'LEARNING_SOURCES', 'ONLINE_LEARNING_SOURCE_KEYS', 'state', 'session', 'isManager', 'isDone', 'learningTaskDate',
    'learningDueDate', 'today', 'esc', 'classcardAppUrl', 'navigator', 'taskRow',
    source + '; return learningSourceCard;'
  )(
    learningSources(), ['leaders_eye', 'metamath', 'classcard', 'studyforce', 'nelt_exam', 'daily_nonfiction'],
    state, { isAdmin: false, isStaffLink: true, staffId: 'student-a' }, () => false,
    () => false, task => task.start || '', task => task.dueDate || '', () => '2026-08-31',
    value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]),
    () => '', { userAgent: '', maxTouchPoints: 0 }, () => ''
  );
  return renderCard({ id: 'student-a', name: studentName }, true, 'leaders_eye');
}

test('a newly exchanged #c student opens Today and reaches the guide only from the student tab', async () => {
  const harness = studentConnectionHarness({ existing: false, exchangeFails: false, initialRoute: 'guide' });
  await harness.run();
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

test('re-tapping the same #c link reuses a valid same-student session without exchange or blocking', async () => {
  const harness = studentConnectionHarness({ existing: true, exchangeFails: true, initialRoute: 'today' });
  await harness.run();
  const result = harness.snapshot();

  assert.equal(result.exchangeCalls, 0, 'a consumed bootstrap code must not be exchanged again');
  assert.equal(result.resetCalls, 0, 'valid same-student cache must not be reset');
  assert.equal(result.hashClears, 1, 'the repeated #c hash must be removed');
  assert.equal(result.pendingStudentCode, '', 'the repeated bootstrap code must be discarded in memory');
  assert.equal(result.route, 'today');
  assert.equal(result.studentConnectError, '');
  assert.equal(result.blocked, null, 'a valid same-student revisit must clear stale blocked-link errors');
});

test('student management distinguishes the student app link from guardian read-only access', () => {
  const view = functionSource('viewStaffAdmin') + '\n' + functionSource('staffAccessPanels');
  assert.match(view, /data-act="copylink"[^>]*>학생용 링크(?: 복사)?<\/button>/);
  assert.match(view, /보호자 열람[\s\S]*?data-act="guardianopen"/);
});

test('the usage guide explains connection scope and the complete daily closing order', () => {
  const guide = functionSource('studentSetupWizard') + '\n' + functionSource('viewStudentGuide');
  assert.match(guide, /처음 연결/);
  assert.match(guide, /같은 브라우저/);
  assert.match(guide, /학생용 화면/);
  assert.match(guide,
    /타이머 정지[\s\S]*?미완료 공부 정리[\s\S]*?시험·중요 일정 준비율 확인[\s\S]*?마무리 내용 저장[\s\S]*?보고 문자 복사[\s\S]*?보호자에게 전송[\s\S]*?발송했어요/,
    'the guide must preserve the exact daily closing sequence');
});

test('the Leaders Eye student card renders shared login guidance with the current student name', () => {
  const state = { tasks: [], checks: {}, settings: {} };
  const before = JSON.stringify(state);
  const first = renderLearningSourceCard('김민준', state);
  const second = renderLearningSourceCard('이서연', state);

  for (const card of [first, second]) {
    assert.match(card, /Agency ID[\s\S]*?wbbrain/);
    assert.match(card, /Student PW[\s\S]*?0000/);
    assert.match(card, /1주일마다 자동으로 레벨이 조정됩니다/);
    assert.match(card, /오늘 미기록/);
    assert.match(card, /data-act="learningdailyopen"[\s\S]*?오늘 학습 완료 기록/);
    assert.match(card, /회차나 별도 과제 배정은 필요하지 않습니다/);
  }
  assert.match(first, /Student ID[\s\S]*?김민준/);
  assert.doesNotMatch(first, /이서연/);
  assert.match(second, /Student ID[\s\S]*?이서연/);
  assert.doesNotMatch(second, /김민준/);
  assert.equal(JSON.stringify(state), before, 'rendering login guidance must not persist credentials');
});

test('Leaders Eye login values stay out of persisted task and settings records', () => {
  const blankState = functionSource('blankState');
  const taskSave = between("case 'learnsave':", "\n    /* 학사관리 · 시험대비 자료 요청 */");
  const persistence = blankState + '\n' + taskSave;

  assert.doesNotMatch(persistence, /wbbrain|0000/);
  assert.doesNotMatch(persistence, /\b(?:agencyId|studentId|studentPw|studentPassword|leadersEyePassword)\s*:/i);
});
