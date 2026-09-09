'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const core = require('./staff-work-session-core.js');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const source = html.slice(html.indexOf('const staffWork = {'), html.indexOf('const sync = {'));
const date = '2030-04-05';
function result(extra = {}) {
  return { ok: true, required: true, authRole: 'teacher', staffId: 'staff-example', staffName: '창작 선생님',
    configured: true, active: false, workDate: date, clockedOut: false, ...extra };
}
function attendance(out) {
  return { key: '__att__staff-example|' + date, owner: 'staff-example',
    record: { taskId: '__att__staff-example', date, done: true, at: 1234, ...(out ? { out: 2345 } : {}) } };
}
function runtime(options = {}) {
  const nodes = new Map(), storage = new Map(), calls = [], saves = [], notices = [];
  let responder = options.respond || (async (path, body) => result());
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', hidden: true, inert: false, innerHTML: '' });
    return nodes.get(id);
  };
  const context = vm.createContext({ window: { WBStaffWorkSessionCore: core },
    document: { querySelectorAll: () => [] }, sessionStorage: {
      getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)
    }, setTimeout, clearTimeout, Date, $: get, esc: String,
    confirm: () => options.confirm !== false, toast: value => notices.push(value),
    __post: async (path, body) => { calls.push({ path, body }); return responder(path, body); },
    __save: value => saves.push(JSON.stringify(value)), __syncOK: options.syncOK !== false
  });
  vm.runInContext(`
    const SAFE_SCOPE_ID = 'staff-example', SYNC_APP = 'task';
    const session = { isStaffLink: true, staffId: SAFE_SCOPE_ID, isAdmin: false };
    const state = { settings: { myToken: 'synthetic-device', pushAt: 1 }, tasks: [], checks: {} };
    let personAccessProblem = null, pendingBootstrapCode = '', inputTimer = null, fbCtx = null;
    const seoulNowParts = () => ({ date: '${date}' });
    const stats = { renders: 0, syncs: 0, flushes: 0 };
    const render = () => stats.renders++;
    const setModalBackgroundInert = () => {};
    const lessonHandoffMemoDrafts = new Map(), lessonHandoffSourceDrafts = new Map();
    const captureLessonHandoffInput = () => {};
    const setCheck = () => {};
    const lessonMemoText = () => '';
    const flushReportInputs = () => stats.flushes++;
    const save = () => __save(state);
    const startSyncSession = async () => { stats.syncs++; return true; };
    ${source}
    const sync = { busy: false, err: '', problem: null, auth() {
      return { mode: 'person', id: SAFE_SCOPE_ID, token: state.settings.myToken,
        ...(staffWorkToken() ? { workSession: staffWorkToken() } : {}) };
      }, post: __post, run: async () => { stats.syncs++; return __syncOK; }, collect: () => [] };
  `, context);
  return { calls, storage, nodes, saves, notices, get, context,
    eval: expression => vm.runInContext(expression, context),
    respond(fn) { responder = fn; },
    seedActive() { this.eval(`applyStaffWorkResponse(${JSON.stringify(result({ active: true, workSession: 'synthetic-work', expiresAt: Date.now() + 86400000, attendance: attendance() }))}, sync.auth())`); },
  };
}
test('startup blocks cached data, status is read-only, and login records server attendance without storing PIN', async () => {
  const app = runtime();
  assert.equal(app.eval('shouldGateStaffWork()'), true);
  assert.equal(await app.eval('ensureStaffWorkStatus(false)'), false);
  assert.equal(app.calls[0].body.action, 'status');
  assert.match(app.eval('viewStaffWorkLogin()'), /출근하고 로그인/);
  app.respond(async () => result({ active: true, workSession: 'synthetic-work', expiresAt: Date.now() + 10000, attendance: attendance() }));
  app.get('#staffWorkPin').value = '0123';
  await app.eval('loginStaffWork(null)');
  assert.equal(app.eval('shouldGateStaffWork()'), false);
  assert.equal(app.eval('state.checks["__att__staff-example|2030-04-05"].at'), 1234);
  assert.equal(app.eval('state.settings.myToken'), 'synthetic-device');
  assert.equal(app.get('#staffWorkPin').value, '');
  assert.ok(app.storage.has('wb_staff_work_session_v1_staff-example'));
  for (const saved of app.saves) assert.doesNotMatch(saved, /0123|synthetic-work|phone|pin/i);
});
test('manager bypass is accepted only from a valid server identity and never grants local manager authority', async () => {
  const app = runtime({ respond: async () => result({ required: false, authRole: 'manager' }) });
  assert.equal(await app.eval('ensureStaffWorkStatus(false)'), true);
  assert.equal(app.eval('session.isAdmin'), false);
  assert.equal(app.calls.length, 1);
  app.respond(async () => result({ staffId: 'different-person' }));
  assert.equal(await app.eval('ensureStaffWorkStatus(true)'), false);
  assert.equal(app.eval('shouldGateStaffWork()'), true);
});
test('wrong PIN keeps the durable device and pending records untouched', async () => {
  const app = runtime(); await app.eval('ensureStaffWorkStatus(false)');
  app.eval('state.checks.pending = { note: "창작 미전송 메모" }');
  app.respond(async () => { throw Object.assign(new Error('비밀번호가 일치하지 않습니다'), { status: 400, code: 'STAFF_WORK_PIN_INCORRECT' }); });
  app.get('#staffWorkPin').value = '0123'; await app.eval('loginStaffWork(null)');
  assert.equal(app.eval('state.settings.myToken'), 'synthetic-device');
  assert.equal(app.eval('state.checks.pending.note'), '창작 미전송 메모');
  assert.equal(app.eval('shouldGateStaffWork()'), true);
});
test('logout saves and flushes before punching out, clears only daily token and preserves old records', async () => {
  const app = runtime(); app.seedActive();
  app.eval('state.checks.pending = { note: "보존한 창작 메모" }');
  app.respond(async () => result({ attendance: attendance(true), clockedOut: true }));
  await app.eval('logoutStaffWork(null)');
  assert.equal(app.eval('stats.flushes'), 1);
  assert.equal(app.eval('stats.syncs'), 1);
  assert.equal(app.calls.at(-1).body.action, 'logout');
  assert.equal(app.eval('state.settings.myToken'), 'synthetic-device');
  assert.equal(app.eval('state.checks.pending.note'), '보존한 창작 메모');
  assert.equal(app.eval('shouldGateStaffWork()'), true);
  assert.equal(app.storage.size, 0);
});
test('failed pending sync or cancelled confirmation never logs out or drops the daily session', async () => {
  for (const options of [{ syncOK: false }, { confirm: false }]) {
    const app = runtime(options); app.seedActive();
    await app.eval('logoutStaffWork(null)');
    assert.equal(app.calls.length, 0);
    assert.equal(app.eval('staffWork.token'), 'synthetic-work');
    assert.equal(app.eval('shouldGateStaffWork()'), false);
  }
});
test('canonical recovery during logout is not mistaken for uploading the preserved pending changes', async () => {
  const app = runtime(); app.seedActive();
  app.eval('sync.run = async () => { sync.recoverySequence = 1; return true; }');
  await app.eval('logoutStaffWork(null)');
  assert.equal(app.calls.length, 0);
  assert.equal(app.eval('staffWork.token'), 'synthetic-work');
  assert.ok(app.notices.some(value => value.includes('보존 안내')));
});
test('a stale status response cannot clear a newer successful login token', async () => {
  const app = runtime(); await app.eval('ensureStaffWorkStatus(false)');
  let resolveStatus;
  app.respond(async (path, body) => body.action === 'status' ? new Promise(resolve => { resolveStatus = resolve; }) :
    result({ active: true, workSession: 'newer-session', expiresAt: Date.now() + 10000, attendance: attendance() }));
  const pending = app.eval('ensureStaffWorkStatus(true)');
  app.get('#staffWorkPin').value = '0123'; await app.eval('loginStaffWork(null)');
  resolveStatus(result()); await pending;
  assert.equal(app.eval('staffWork.token'), 'newer-session');
  assert.equal(app.eval('shouldGateStaffWork()'), false);
});
test('new work lock keeps recovery and lesson data, hides popups, and never revokes the device', () => {
  const app = runtime(); app.seedActive();
  app.eval('state.checks.pending = { note: "창작 메모" }');
  app.get('#modalHost').hidden = false;
  app.eval('lockStaffWork("출근 로그인 필요")');
  assert.equal(app.eval('state.settings.myToken'), 'synthetic-device');
  assert.equal(app.eval('state.checks.pending.note'), '창작 메모');
  assert.equal(app.get('#modalHost').hidden, true);
  assert.equal(app.eval('shouldGateStaffWork()'), true);
});
test('all business requests carry the work token, daily lock precedes generic conflict recovery, and private profiles are separate', () => {
  const post = html.slice(html.indexOf('  async post(path, body)'), html.indexOf('  async run()'));
  assert.match(post, /lockStaffWork\(error.message\)/);
  assert.match(post, /STAFF_WORK_LOGIN_REQUIRED/);
  assert.match(post, /body.auth.workSession/);
  const catchPart = html.slice(html.indexOf("console.warn('sync failed'"), html.indexOf('async issueBootstrap'));
  assert.ok(catchPart.indexOf('staffWorkCore.isLoginRequired(e)') < catchPart.indexOf('recoverSyncConflict'));
  const profile = html.slice(html.indexOf('let staffPrivateProfileEditor'), html.indexOf('function viewStaffAdmin'));
  assert.match(profile, /sync.post\('\/staff-profile'/);
  assert.doesNotMatch(profile, /localStorage|state\.staff.*phone|queueSync\(|\.adminPin\s*=/);
  assert.match(html, /if \(!\$\('#staffWorkPin'\)\) render\(\)/);
});
