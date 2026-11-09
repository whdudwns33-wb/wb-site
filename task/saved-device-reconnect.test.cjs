'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const html = require('node:fs').readFileSync(__dirname + '/index.html', 'utf8');
const extract = name => html.match(new RegExp('(?:async )?function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n}'))[0];
function setup() {
  const calls = { status: 0, sync: 0, timers: [] };
  const c = vm.createContext({
    session: { isStaffLink: true }, hasStoredPersonToken: () => true,
    pendingBootstrapCode: '', personAccessProblem: null, linkExchangeBusy: false,
    sync: { busy: false, personVerified: false }, staffWork: { busy: false, checked: false },
    savedDeviceReconnectPromise: null, savedDeviceRetryTimer: null, savedDeviceRetryCount: 0, savedDeviceLastAttempt: 0,
    navigator: { onLine: true }, document: { visibilityState: 'visible' }, $: () => null,
    Date, shouldGateStaffWork: () => false,
    ensureStaffWorkStatus: async force => { assert.equal(force, true); calls.status++; return true; },
    startSyncSession: async () => { calls.sync++; return true; },
    setTimeout: (fn, delay) => { calls.timers.push({fn, delay}); return calls.timers.length; }, clearTimeout: () => {}
  });
  vm.runInContext(['reconnectSavedDevice', 'scheduleSavedDeviceRetry', 'resumeSavedDevice'].map(extract).join('\n'), c);
  return { c, calls };
}
test('saved bearer reconnect verifies status then sync without exchange or attendance writes', async () => {
  const {c, calls} = setup();
  assert.equal(await c.reconnectSavedDevice(), true);
  assert.equal(calls.status, 1); assert.equal(calls.sync, 1);
  assert.equal(c.sync.personVerified, false); // only real server sync may grant access
});
test('simultaneous reconnects share verification', async () => {
  const {c, calls} = setup();
  await Promise.all([c.reconnectSavedDevice(), c.reconnectSavedDevice()]);
  assert.equal(calls.status, 1); assert.equal(calls.sync, 1);
});
test('missing, revoked and pending new link never reconnect automatically', async () => {
  for (const change of [c => c.hasStoredPersonToken = () => false, c => c.personAccessProblem = {kind:'session_revoked'},
    c => c.pendingBootstrapCode = 'new-code', c => c.session.isStaffLink = false]) {
    const {c, calls} = setup(); change(c);
    assert.equal(await c.reconnectSavedDevice(), false);
    c.scheduleSavedDeviceRetry(); assert.equal(calls.status, 0); assert.equal(calls.timers.length, 0);
  }
});
test('work login is never bypassed and retry does not record attendance', async () => {
  const {c, calls} = setup();
  c.staffWork.checked = true; c.shouldGateStaffWork = () => true;
  c.ensureStaffWorkStatus = async () => false;
  assert.equal(await c.reconnectSavedDevice(), false);
  assert.equal(calls.sync, 0); assert.equal(calls.timers.length, 0);
});
test('network retry is bounded and stops while hidden or offline', () => {
  const {c, calls} = setup();
  for (let i=0;i<5;i++) { c.savedDeviceRetryTimer = null; c.scheduleSavedDeviceRetry(); }
  assert.deepEqual(calls.timers.map(t => t.delay), [5000,15000,30000]);
  for (const change of [c => c.navigator.onLine = false, c => c.document.visibilityState = 'hidden']) {
    const x = setup(); change(x.c); x.c.scheduleSavedDeviceRetry(); assert.equal(x.calls.timers.length,0);
  }
});
test('resume preserves PIN entry and reconnects on network return without QR', async () => {
  const {c, calls} = setup(); c.$ = () => ({}); c.resumeSavedDevice(); assert.equal(calls.status,0);
  c.$ = () => null; c.resumeSavedDevice(); await c.savedDeviceReconnectPromise;
  assert.equal(calls.status,1); assert.equal(calls.sync,1);
  assert.match(html, /addEventListener\('online', resumeSavedDevice\)/);
  assert.match(html, /addEventListener\('pageshow', resumeSavedDevice\)/);
});
