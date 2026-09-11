'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('./staff-work-session-core.js');
test('four digit PIN preserves leading zeroes and rejects other lengths', () => {
  for (const pin of ['0123', '4567', '9999']) assert.equal(core.validPin(pin), true);
  for (const pin of ['123', '12345', ' 1234', '１２３４', 'abcd', null]) assert.equal(core.validPin(pin), false);
});
test('daily session expires without changing the durable device identity', () => {
  const status = { checked: true, required: true, active: true, workDate: '2030-01-01', expiresAt: 300 };
  assert.equal(core.isActive(status, '2030-01-01', 200), true);
  assert.equal(core.isActive(status, '2030-01-02', 200), false);
  assert.equal(core.isActive(status, '2030-01-01', 300), false);
  assert.equal(core.isActive({ checked: false, required: false }, '2030-01-01', 200), false);
  assert.equal(core.isActive({ checked: true, required: false }, '2030-01-01', 200), true);
  assert.equal(core.sameIdentity({ mode: 'person', id: 't1', token: 'device', workSession: 'old' },
    { mode: 'person', id: 't1', token: 'device', workSession: 'new' }), true);
  assert.equal(core.sameIdentity({ mode: 'person', id: 't1', token: 'old' }, { mode: 'person', id: 't1', token: 'new' }), false);
});
test('server identity and privileged role must be validated', () => {
  const row = { ok: true, staffId: 't1', authRole: 'teacher', required: true, configured: true,
    active: false, workDate: '2030-01-01' };
  assert.equal(core.validateStatus(row, 't1'), row);
  assert.throws(() => core.validateStatus(row, 'other'));
  assert.throws(() => core.validateStatus({ ...row, authRole: 'manager' }, 't1'));
  assert.throws(() => core.validateStatus({ ...row, active: 'true' }, 't1'));
  assert.equal(core.isLoginRequired({ status: 409, code: 'STAFF_WORK_LOGIN_REQUIRED' }), true);
  assert.equal(core.isLoginRequired({ status: 409, code: 'TASK_CONFLICT' }), false);
});
test('attendance response is bound to exact staff and record date', () => {
  const row = { key: '__att__t1|2030-01-01', owner: 't1', record: { taskId: '__att__t1', date: '2030-01-01', done: true, at: 1 } };
  assert.equal(core.attendance(row, 't1').record, row.record);
  assert.throws(() => core.attendance(row, 't2'));
  assert.throws(() => core.attendance({ ...row, key: '__att__t1|2030-01-02' }, 't1'));
});
