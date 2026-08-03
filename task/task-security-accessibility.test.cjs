const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('manager password fields accept letters and symbols without a numeric keyboard hint', () => {
  const loginTag = html.match(/<input class="in" id="pin"[^>]*>/);
  const changeTag = html.match(/<input class="in" id="newPin"[^>]*>/);
  assert.ok(loginTag && changeTag);
  for (const tag of [loginTag[0], changeTag[0]]) {
    assert.match(tag, /type="password"/);
    assert.match(tag, /inputmode="text"/);
    assert.match(tag, /autocapitalize="none"/);
    assert.match(tag, /spellcheck="false"/);
    assert.doesNotMatch(tag, /inputmode="numeric"/);
  }
});

test('manager authentication is visibly distinguished from operating-data sync', () => {
  const status = html.slice(html.indexOf('function paintStatus()'), html.indexOf('function currentStaff()'));
  const render = html.slice(html.indexOf('function render()'), html.indexOf('function renderTabs()'));
  const syncRun = html.slice(html.indexOf('const sync = {'), html.indexOf('function queueSync()'));
  assert.match(status, /원장 로그인됨/);
  assert.match(status, /로컬 모드/);
  assert.match(status, /관리 비밀번호와 운영 데이터 연결키는 보안상 별개/);
  assert.match(status, /운영 데이터 연결 오류/);
  assert.match(status, /aria-labelledby="adminLocalModeTitle"/);
  assert.doesNotMatch(status, /role="(?:status|alert)"/);
  assert.ok(render.includes('id="adminConnectionNotice"'));
  assert.ok(html.includes("case 'syncsettings': go('settings')"));
  assert.match(html, /운영 데이터 연결을 확인합니다/);
  assert.ok(html.includes('if (syncReady) startSyncSession();'));
  assert.match(syncRun, /paintAdminConnectionNotice/);
});

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem(key) { return data.has(String(key)) ? data.get(String(key)) : null; },
    setItem(key, value) { data.set(String(key), String(value)); },
    removeItem(key) { data.delete(String(key)); },
    parsed(key) { const raw = data.get(String(key)); return raw ? JSON.parse(raw) : null; }
  };
}

test('legacy persistent admin secrets move to session storage once and are removed from every saved state', () => {
  const start = html.indexOf("const TASK_ADMIN_SECRET_SESSION_KEY = 'wb_task_admin_secret_v1';");
  const end = html.indexOf('\nconst uid =', start);
  assert.ok(start >= 0 && end > start);
  const block = html.slice(start, end);
  const context = { sessionStorage: memoryStorage(), console: { warn() {} } };
  vm.createContext(context);
  vm.runInContext(block + '\nthis.__api = { getTaskAdminSecret, setTaskAdminSecret, removeAdminSecretFromState, scrubPersistentAdminSecrets };', context);

  const persistent = memoryStorage({
    scoped: JSON.stringify({ settings: { syncSecret: 'scoped-value', centerName: 'WB' }, tasks: [] }),
    legacy: JSON.stringify({ settings: { syncSecret: 'legacy-value' }, checks: {} })
  });
  const moved = context.__api.scrubPersistentAdminSecrets(persistent, context.sessionStorage, ['scoped', 'legacy'], true);
  assert.equal(moved, true);
  assert.equal(context.__api.getTaskAdminSecret(context.sessionStorage), 'scoped-value');
  assert.equal(Object.hasOwn(persistent.parsed('scoped').settings, 'syncSecret'), false);
  assert.equal(Object.hasOwn(persistent.parsed('legacy').settings, 'syncSecret'), false);

  const state = { settings: { syncSecret: 'must-not-persist', myToken: 'personal-bearer', centerName: 'WB' } };
  context.__api.removeAdminSecretFromState(state);
  assert.equal(Object.hasOwn(state.settings, 'syncSecret'), false);
  assert.equal(state.settings.myToken, 'personal-bearer', 'personal bearer behavior must stay unchanged');

  const personalSession = memoryStorage();
  const personalPersistent = memoryStorage({ person: JSON.stringify({ settings: { syncSecret: 'legacy-admin', myToken: 'bearer' } }) });
  const personalMoved = context.__api.scrubPersistentAdminSecrets(personalPersistent, personalSession, ['person'], false);
  assert.equal(personalMoved, false, 'personal scope must never migrate an admin secret into its session');
  assert.equal(context.__api.getTaskAdminSecret(personalSession), '');
  assert.equal(personalPersistent.parsed('person').settings.myToken, 'bearer');
  assert.equal(Object.hasOwn(personalPersistent.parsed('person').settings, 'syncSecret'), false);
});

test('save, auth, import, export and settings copy never persist the admin secret', () => {
  const blank = html.slice(html.indexOf('function blankState()'), html.indexOf('\nlet state = blankState()'));
  const save = html.slice(html.indexOf('function save()'), html.indexOf('\nfunction linkCodeFor'));
  const auth = html.slice(html.indexOf('  auth() {'), html.indexOf('\n  enabled()', html.indexOf('  auth() {')));
  const settings = html.slice(html.indexOf('function viewSettings()'), html.indexOf('\n/* ═', html.indexOf('function viewSettings()')));
  const exported = html.slice(html.indexOf("case 'export':"), html.indexOf("case 'import':"));
  const imported = html.slice(html.indexOf("case 'import':"), html.indexOf("case 'closemodal':"));
  assert.doesNotMatch(blank, /syncSecret/);
  assert.match(save, /removeAdminSecretFromState\(state\)/);
  assert.doesNotMatch(auth, /state\.settings\.syncSecret/);
  assert.match(auth, /getTaskAdminSecret\(\)/);
  assert.doesNotMatch(exported, /syncSecret/);
  assert.match(imported, /delete secureSettings\.syncSecret/);
  assert.match(settings, /현재 브라우저 탭 세션에만/);
  assert.match(settings, /탭을 닫거나 화면을 잠그면/);
  assert.doesNotMatch(settings, /저장됨 · 변경할 때만/);
});

function focusNode(document, name) {
  return {
    name,
    tabIndex: 0,
    focus() { document.activeElement = this; this.focusCount = (this.focusCount || 0) + 1; },
    getAttribute() { return null; },
    hasAttribute() { return false; }
  };
}

test('dialog runtime applies semantics, initial focus, tab trap, Escape close and return focus', () => {
  const start = html.indexOf('let modalReturnFocus = null;');
  const end = html.indexOf('\nfunction b64(', start);
  assert.ok(start >= 0 && end > start);
  const block = html.slice(start, end);
  const listeners = new Map();
  const document = {
    activeElement: null,
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type, handler) { if (listeners.get(type) === handler) listeners.delete(type); },
    contains(node) { return Boolean(node && node.connected !== false); }
  };
  const returnButton = focusNode(document, 'return');
  const first = focusNode(document, 'first');
  const last = focusNode(document, 'last');
  const box = focusNode(document, 'box');
  box.querySelectorAll = () => [first, last];
  box.querySelector = () => null;
  box.contains = node => node === first || node === last || node === box;
  const host = { innerHTML: '' };
  document.activeElement = returnButton;
  const context = {
    document,
    requestAnimationFrame(callback) { callback(); },
    esc(value) { return String(value); },
    $: selector => selector === '#modalHost' ? host : (selector === '#modalHost .modal-box' && host.innerHTML ? box : null)
  };
  vm.createContext(context);
  vm.runInContext(block + '\nthis.__modal = { modal, closeModal, handleModalKeydown };', context);

  context.__modal.modal('시험 대화상자', '<input>', '');
  assert.match(host.innerHTML, /role="dialog"/);
  assert.match(host.innerHTML, /aria-modal="true"/);
  assert.match(host.innerHTML, /aria-labelledby="wb-modal-title-1"/);
  assert.equal(document.activeElement, first, 'first focusable control receives initial focus');
  assert.equal(typeof listeners.get('keydown'), 'function');

  document.activeElement = last;
  let prevented = false;
  listeners.get('keydown')({ key: 'Tab', shiftKey: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(document.activeElement, first);

  document.activeElement = first;
  prevented = false;
  listeners.get('keydown')({ key: 'Tab', shiftKey: true, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(document.activeElement, last);

  prevented = false;
  listeners.get('keydown')({ key: 'Escape', shiftKey: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(host.innerHTML, '');
  assert.equal(document.activeElement, returnButton, 'focus returns to the opener');
  assert.equal(listeners.has('keydown'), false);
});

test('toast, overlay click contract, warning contrast and mobile wrapping stay present', () => {
  assert.match(html, /id="toast" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(html, /class="modal" data-act="closemodal"/);
  assert.match(html, /ev\.target\.closest\('\.modal-box'\)/);
  assert.match(html, /\.btn-warn \{[^}]*color: #9A3412/);
  assert.match(html, /\.pill\.warn \{[^}]*color: #9A3412/);
  assert.match(html, /@media \(max-width: 520px\)/);
  assert.match(html, /#view \.card \.row, \.modal-box \.row \{ flex-wrap: wrap; \}/);
  assert.match(html, /min-width: 0/);
});
