const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

function between(start, end) {
  const a = html.indexOf(start);
  const b = html.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, 'source block not found: ' + start);
  return html.slice(a, b);
}

test('manager credentials stay separate from director and backups', () => {
  const state = between('function blankState() {', '\nlet state = blankState();');
  const auth = between('  auth() {', '\n  enabled()');
  const studentReset = between('function resetStudentLinkCache(token) {', '\n\n/** 학생으로 쓰던 패드를');
  const directorReset = between('function resetAdminDeviceCache(token) {', '\n\nfunction resetManagerDeviceCache');
  const managerReset = between('function resetManagerDeviceCache(login) {', '\n\nfunction studentCacheScopedTo');

  for (const key of ['managerToken', 'managerAccountId', 'managerLoginId', 'managerName']) {
    assert.match(state, new RegExp("'" + key + "'"), key + ' must be excluded from exported backups');
  }
  assert.ok(auth.indexOf("mode: 'manager_device'") < auth.indexOf("mode: 'admin_device'"));
  assert.match(studentReset, /managerToken: ''[\s\S]*managerAccountId: ''[\s\S]*managerLoginId: ''[\s\S]*managerName: ''/);
  assert.match(directorReset, /managerToken: ''[\s\S]*managerAccountId: ''[\s\S]*managerLoginId: ''[\s\S]*managerName: ''/);
  assert.match(managerReset, /adminToken: ''[\s\S]*syncSecret: ''[\s\S]*myToken: ''/);
  assert.match(managerReset, /managerToken: String\(login\.token \|\| ''\)/);
});

test('manager login uses the shared form and stores the returned role profile', () => {
  const lock = between('function viewLock() {', '\n\nfunction viewStudentLinkConnect');
  const login = html.match(/case 'login': \{[\s\S]*?\n\s*break;\n\s*}/)?.[0] || '';

  assert.match(lock, /원장 또는 관리 선생님 아이디/);
  assert.match(lock, /90일간 자동으로 연결/);
  assert.match(login, /sync\.loginAdmin\(loginId, password\)/);
  assert.match(login, /runAuthSwitch\(async \(\) => \{[\s\S]*prepareAuthSwitch\(\)[\s\S]*sync\.loginAdmin\(loginId, password\)/);
  assert.match(login, /d\.authRole === 'manager'[\s\S]*resetManagerDeviceCache\(d\)/);
  assert.match(login, /resetAdminDeviceCache\(d\.token\)/);
  assert.match(login, /d\.displayName \+ ' 선생님/);
});

test('manager route and tabs expose operations but not director-only screens', () => {
  const session = between('const session = {', '\n\nlet route =');
  const render = between('function render() {', '\n\nfunction renderTabs()');
  const tabs = between('function renderTabs() {', '\n\n/* ── 링크로 들어온');
  const managerTabList = tabs.match(/: session\.isManagerAccount\n\s*\? \[([\s\S]*?)\]\n\s*: session\.isDirector/)?.[1] || '';

  assert.match(session, /get isDirector\(\)[\s\S]*!state\.settings\.managerToken/);
  assert.match(session, /get isManagerAccount\(\)[\s\S]*!!state\.settings\.managerToken/);
  assert.match(session, /get isAdmin\(\)[\s\S]*this\.isDirector \|\| this\.isManagerAccount/);
  assert.match(render, /session\.isManagerAccount && !\['today', 'week', 'roadmap', 'month', 'academic', 'ingang', 'study', 'write', 'board'\]\.includes\(route\)/);
  for (const tab of ['today', 'week', 'month', 'academic', 'ingang', 'study', 'write', 'board']) {
    assert.match(managerTabList, new RegExp("'" + tab + "'"));
  }
  assert.match(managerTabList, /\.\.\.roadmapTab/);
  for (const tab of ['guide', 'results', 'staff', 'settings']) {
    assert.doesNotMatch(managerTabList, new RegExp("'" + tab + "'"));
  }
});

test('director-only screens and mutations are blocked centrally', () => {
  const actions = between('const DIRECTOR_ONLY_ACTIONS = new Set([', '\n]);');

  for (const action of [
    'saveadminaccount', 'manageraccountnew', 'manageraccountsave', 'manageraccountactive',
    'manageraccountrevoke', 'adminqr', 'savecfg', 'export', 'import', 'copylink',
    'studentqr', 'addstaff', 'delstaff', 'subscriptionopen', 'linksend', 'resultupload',
    'guardianinvite', 'pointfulfill', 'reportpublish', 'reportwithdraw'
  ]) assert.match(actions, new RegExp("'" + action + "'"));

  assert.match(html, /DIRECTOR_ONLY_ACTIONS\.has\(act\) && !session\.isDirector/);
  assert.match(html, /이 기능은 원장 계정에서만 사용할 수 있습니다/);
  assert.match(html, /function viewSettings\(\) \{\n  if \(!session\.isDirector\) return ''/);
  assert.match(html, /function viewResults\(\) \{\n  if \(!session\.isDirector\) return ''/);
  assert.match(html, /function viewStaffAdmin\(\) \{\n  if \(!session\.isDirector\) return ''/);
});

test('director can create, update, suspend, and revoke manager accounts', () => {
  const card = between('function managerAccountsCard() {', '\n\nfunction managerAccountModal');
  const modal = between('function managerAccountModal(account) {', '\n\nfunction viewSettings()');
  const handlers = between("    case 'manageraccountsretry':", '\n\n    /* 타임블록 */');

  assert.match(html, /async managerAccounts\(action, values\)[\s\S]*post\('\/manager-account'/);
  assert.match(card, /관리 선생님 계정/);
  assert.match(card, /연결 기기 '[\s\S]*'\/5/);
  assert.match(card, /data-act="manageraccountnew"/);
  assert.match(card, /data-act="manageraccountedit"/);
  assert.match(card, /data-act="manageraccountactive"/);
  assert.match(card, /data-act="manageraccountrevoke"/);
  assert.match(modal, /id="managerName"/);
  assert.match(modal, /id="managerLoginId"/);
  assert.match(modal, /id="managerPassword" type="password"/);
  assert.match(modal, /비밀번호는 서버에 원문으로 저장되지 않습니다/);
  assert.match(handlers, /managerAccounts\('save'/);
  assert.match(handlers, /managerAccounts\('set_active'/);
  assert.match(handlers, /managerAccounts\('revoke_devices'/);
  assert.match(handlers, /password\.length < 8/);
});

test('manager edits are attributed to the account and limited to manager-origin tasks', () => {
  const canEdit = between('function canEditTask(t) {', '\n\nfunction paintStatus');
  const collect = between('  collect(since) {', '\n\n  /** 받은 변경');

  assert.match(html, /const actor = \(\) => session\.isManagerAccount[\s\S]{0,120}\? 'manager'/);
  assert.match(canEdit, /session\.isDirector \|\| \(session\.isManagerAccount && t && t\.origin === 'manager'\)/);
  assert.match(collect, /const managerMode = !!state\.settings\.managerToken/);
  assert.match(collect, /if \(managerMode\) return/);
  assert.match(collect, /if \(managerMode && t\.origin !== 'manager'\) return/);
  assert.match(collect, /'__subscription__', '__subscriptionpayment__', '__pointrequest__'/);
});

test('role switches invalidate in-flight sync before replacing the shared cache', () => {
  const syncBlock = between('const sync = {', '\n\nfunction queueSync()');
  const studentReset = between('function resetStudentLinkCache(token) {', '\n\n/** 학생으로 쓰던 패드를');
  const directorReset = between('function resetAdminDeviceCache(token) {', '\n\nfunction resetManagerDeviceCache');
  const managerReset = between('function resetManagerDeviceCache(login) {', '\n\nfunction studentCacheScopedTo');
  const prepare = between('async function prepareAuthSwitch(duringAdminConnect) {', '\n\nasync function runAuthSwitch');
  const authSwitch = between('async function runAuthSwitch(work) {', '\n\n/** 마감 완료는');
  const adminConnect = between('async function connectAdminDevice() {', '\n\n/* ═══');
  const recover = html.match(/case 'recoverpinsave': \{[\s\S]*?\n\s*break;\n\s*}/)?.[0] || '';
  const changeDirector = html.match(/case 'saveadminaccount': \{[\s\S]*?\n\s*break;\n\s*}/)?.[0] || '';

  assert.match(syncBlock, /authEpoch: 0/);
  assert.match(syncBlock, /const runEpoch = this\.authEpoch/);
  assert.match(syncBlock, /await this\.post\('\/sync'[\s\S]*if \(runEpoch !== this\.authEpoch\) return/);
  assert.match(syncBlock, /catch \(e\) \{\n\s*if \(runEpoch !== this\.authEpoch\) return/);
  assert.match(syncBlock, /staleAuth && this\.enabled\(\)/);
  for (const reset of [studentReset, directorReset, managerReset]) {
    assert.match(reset, /sync\.invalidateAuthSession\(\)/);
  }
  assert.match(prepare, /waitForSyncIdle\(20000\)/);
  assert.match(prepare, /sync\.collect\(Number\(state\.settings\.pushAt\) \|\| 0\)/);
  assert.match(prepare, /await sync\.run\(false, !!duringAdminConnect\)/);
  assert.match(authSwitch, /authSwitchBusy = true[\s\S]*return await work\(\)[\s\S]*finally[\s\S]*authSwitchBusy = false/);
  assert.match(adminConnect, /await runAuthSwitch\(async \(\) => \{[\s\S]*await prepareAuthSwitch\(true\)[\s\S]*await sync\.exchangeAdmin\(code\)/);
  assert.match(adminConnect, /resetAdminDeviceCache\(d\.token\)/);
  assert.match(recover, /runAuthSwitch\(async \(\) => \{[\s\S]*prepareAuthSwitch\(\)[\s\S]*sync\.saveAdminAccount[\s\S]*resetAdminDeviceCache\(d\.token\)/);
  assert.match(changeDirector, /runAuthSwitch\(async \(\) => \{[\s\S]*prepareAuthSwitch\(\)[\s\S]*sync\.saveAdminAccount[\s\S]*resetAdminDeviceCache\(d\.token\)/);
  for (const accountSwitch of [recover, changeDirector]) {
    assert.ok(accountSwitch.indexOf('resetAdminDeviceCache(d.token)') < accountSwitch.indexOf('await sync.run()'),
      '새 원장 토큰으로 캐시를 교체한 뒤 서버 전체 데이터를 다시 받는다');
  }
});

test('auth switch blocks UI mutations until the new-role sync finishes', () => {
  const authSwitch = between('async function runAuthSwitch(work) {', '\n\n/** 마감 완료는');
  const login = html.match(/case 'login': \{[\s\S]*?\n\s*break;\n\s*}/)?.[0] || '';
  const recover = html.match(/case 'recoverpinsave': \{[\s\S]*?\n\s*break;\n\s*}/)?.[0] || '';
  const changeDirector = html.match(/case 'saveadminaccount': \{[\s\S]*?\n\s*break;\n\s*}/)?.[0] || '';
  const adminConnect = between('async function connectAdminDevice() {', '\n\n/* ═══');
  const clickStart = html.indexOf("document.addEventListener('click', async ev => {");
  const clickAction = html.indexOf("const goEl = ev.target.closest('[data-go]');", clickStart);

  assert.ok(clickStart >= 0 && clickAction > clickStart);
  assert.match(authSwitch, /authSwitchBusy = true[\s\S]*clearTimeout\(inputTimer\)[\s\S]*inputTimer = null[\s\S]*return await work\(\)[\s\S]*finally[\s\S]*authSwitchBusy = false/);
  assert.ok(html.indexOf('if (authSwitchBusy) {', clickStart) < clickAction,
    '클릭은 라우팅이나 data-act 처리 전에 차단한다');
  assert.match(html.slice(clickStart, clickAction), /preventDefault\(\)[\s\S]*stopImmediatePropagation\(\)/);
  for (const event of ['change', 'input', 'keydown']) {
    assert.match(html, new RegExp("document\\.addEventListener\\('" + event + "', (?:async )?ev => \\{\\n\\s*if \\(authSwitchBusy\\) \\{ ev\\.preventDefault\\(\\); ev\\.stopImmediatePropagation\\(\\); return; \\}"));
  }
  for (const flow of [login, recover, changeDirector]) {
    assert.match(flow, /runAuthSwitch\(async \(\) => \{/);
    assert.ok(flow.indexOf('await sync.run()') < flow.indexOf('}).catch'),
      '새 자격으로 전체 데이터를 받은 뒤에만 입력 잠금을 푼다');
  }
  assert.match(adminConnect, /await runAuthSwitch\(async \(\) => \{[\s\S]*await sync\.exchangeAdmin\(code\)[\s\S]*await sync\.run\(\)[\s\S]*\n\s*}\);/);
});
