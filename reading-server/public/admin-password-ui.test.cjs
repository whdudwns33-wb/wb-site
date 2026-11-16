const assert = require('node:assert/strict');
const Login = require('./admin-login.js');
const els = {};
const host = {
  set innerHTML(s) {
    for (const k of Object.keys(els)) delete els[k];
    for (const m of s.matchAll(/id="([^"]+)"/g)) els['#' + m[1]] = { value: '', focus() {} };
  },
  querySelector(k) { return els[k]; },
};
let callbackCount = 0;
const requests = [];
Login.mount({ host, onToken(token) { assert.equal(token, 'normal-session'); callbackCount++; }, fetchFn: async (url, opt) => {
  requests.push({ url, opt });
  return { ok: true, json: async () => url === '/api/admin/login'
    ? { passwordChangeRequired: true, changeToken: 'rotation-only-ticket' }
    : { token: 'normal-session', via: 'account' } };
} });
const event = { preventDefault() {} };
const settle = () => new Promise(r => setImmediate(r));
(async () => {
  els['#wbaId'].value = 'fixture-admin'; els['#wbaPw'].value = '0000';
  els['#wbaForm'].onsubmit(event); await settle();
  assert.equal(callbackCount, 0, 'rotation ticket never reaches normal session storage');
  assert.ok(els['#wbaChangeForm']);
  els['#wbaNew'].value = 'synthetic-password'; els['#wbaConfirm'].value = 'mismatch';
  els['#wbaChangeForm'].onsubmit(event); await settle(); assert.equal(requests.length, 1);
  els['#wbaConfirm'].value = 'synthetic-password'; els['#wbaChangeForm'].onsubmit(event); await settle();
  assert.equal(requests[1].url, '/api/admin/password');
  assert.equal(requests[1].opt.headers.Authorization, 'Bearer rotation-only-ticket');
  assert.equal(callbackCount, 1); assert.equal(els['#wbaNew'].value, ''); assert.equal(els['#wbaConfirm'].value, '');
  console.log('PASS: shared login UI waits for password change before storing session and clears new password fields');
})().catch(e => { console.error(e); process.exitCode = 1; });
