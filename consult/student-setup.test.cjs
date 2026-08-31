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

function setupHarness() {
  const state = { checks: {} };
  let timetable = false;
  let clock = 1000;
  const core = between("const studentSetupKey = sid =>", '\nfunction studentSetupNav(');
  const api = new Function('state', 'ingAvail', 'setCheck', 'now', core + `
    return { key: studentSetupKey, read: studentSetupOf, status: studentSetupStatus,
      save: saveStudentSetup, start: startStudentSetup };`
  )(
    state,
    () => ({ configured: timetable }),
    (taskId, date, patch) => {
      const key = taskId + '|' + date;
      state.checks[key] = Object.assign({}, state.checks[key] || {}, patch, { updatedAt: ++clock });
      return state.checks[key];
    },
    () => ++clock
  );
  return { state, api, setTimetable(value) { timetable = value; } };
}

test('first-use setup derives each step from real timetable and goal data', () => {
  const h = setupHarness();
  assert.equal(h.api.key('s1'), '__studentsetup__s1');
  assert.deepEqual(
    { started: h.api.status('s1').started, step: h.api.status('s1').step, done: h.api.status('s1').done },
    { started: false, step: 1, done: 0 }
  );

  h.api.start('s1');
  assert.equal(h.api.status('s1').started, true);
  h.setTimetable(true);
  assert.equal(h.api.status('s1').step, 2);

  h.state.checks['__stgoal__s1|all'] = { mins: 0 };
  assert.equal(h.api.status('s1').step, 3, 'zero minutes must mean checklist-only was explicitly chosen');
  assert.equal(h.api.status('s1').done, 2);

  h.api.save('s1', { guideConfirmedAt: 2000, completedAt: 2000 });
  assert.equal(h.api.status('s1').complete, true);
  assert.equal(h.api.status('s1').done, 3);
});

test('setup record stays in consult checks and is owned by the current student', () => {
  const h = setupHarness();
  h.api.start('student-a');
  assert.ok(h.state.checks['__studentsetup__student-a|all']);
  assert.equal('__studentsetup__student-a'.match(/^__[a-zA-Z]+__(.+)$/)[1], 'student-a');

  const activity = functionSource('isStudentActivityCheck');
  const isStudentActivityCheck = new Function(activity + '; return isStudentActivityCheck;')();
  assert.equal(isStudentActivityCheck('__studentsetup__student-a|all', { done: true, updatedAt: 1 }), false);
});

test('wizard reuses the existing timetable and study-goal records', () => {
  const wizard = functionSource('studentSetupWizard');
  const summary = functionSource('studentSetupSummary');
  assert.match(wizard, /data-act="ingavopen"/);
  assert.match(wizard, /data-act="studentsetuptimetableskip"/);
  assert.match(wizard, /자동배치 없이 사용/);
  assert.match(wizard, /data-act="studentsetupgoal" data-min="0"/);
  assert.match(wizard, /id="studentSetupGoal" type="number" min="10" max="1440"[\s\S]*?aria-label="하루 순공 목표 분 단위"/);
  assert.match(wizard, /오늘 배부된 공부[\s\S]*?내 체크리스트로 가져오기/);
  assert.match(wizard, /원장님이 강좌를 등록하면 자동으로 나타납니다/);
  assert.match(summary, /ingAvail\(me\.id\)/);
  assert.match(summary, /stGoalMin\(me\.id\)/);
  assert.match(summary, /ingCourses\(me\.id\)\.length/);
});

test('student setup actions are scoped and completion validates required steps', () => {
  const actions = between("case 'studentsetupstart':", "case 'login':");
  assert.match(actions, /!session\.isStaffLink \|\| isManager\(\)/);
  assert.match(actions, /setCheck\('__stgoal__' \+ me\.id, 'all'/);
  assert.match(actions, /mins < 10 \|\| mins > 1440/);
  assert.match(actions, /if \(!status\.timetable\) return toast\('주간 시간표를 먼저 입력해 주세요'\)/);
  assert.match(actions, /if \(!status\.goal\) return toast\('하루 순공 목표 또는 체크리스트만 사용을 선택해 주세요'\)/);
  assert.match(actions, /saveStudentSetup\(me\.id, \{ guideConfirmedAt: at, completedAt: at \}\)/);
});

test('new links open Today without forcing setup, while manually started setup only reminds', () => {
  const connect = functionSource('connectStudentLink');
  assert.doesNotMatch(connect, /startStudentSetup/);
  assert.doesNotMatch(connect, /go\('guide'\)/);
  assert.match(connect, /await sync\.run\(true\)[\s\S]*?route = 'today'[\s\S]*?location\.hash = '#\/today'/);
  assert.doesNotMatch(html, /pendingStudentWelcome/);
  const startAction = between("case 'studentsetupstart':", "case 'studentsetuptimetableskip':");
  assert.match(startAction, /startStudentSetup\(me\.id\)/);

  const reminder = functionSource('studentSetupReminder');
  assert.match(reminder, /!status\.started \|\| status\.complete/);
  assert.match(reminder, /data-go="guide"/);
  assert.match(reminder, /설정은 오늘 학습을 막지 않습니다/);
  const today = functionSource('viewToday');
  assert.match(today, /if \(cursor === today\(\)\) h \+= studentSetupReminder\(me\)/);
  assert.doesNotMatch(reminder, /잠겨|disabled|lock\s*\(/i);
});

test('mobile setup layout stays readable and exposes the current step', () => {
  assert.match(functionSource('studentSetupNav'), /aria-current="step"/);
  assert.match(html, /@media \(max-width: 600px\)[\s\S]*?\.student-setup-summary \{ grid-template-columns: 1fr; \}/);
  assert.match(html, /@media \(max-width: 600px\)[\s\S]*?\.student-setup-goals \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
});
