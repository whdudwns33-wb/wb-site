import assert from 'node:assert/strict';

const base = process.env.WB_TEST_URL || 'http://127.0.0.1:8792';
const origin = process.env.WB_TEST_ORIGIN || 'https://whdudwns33-wb.github.io';
const initialCode = process.env.WB_TEST_ADMIN_CODE;
const taskSecret = process.env.WB_TEST_TASK_SECRET;
if (!initialCode || !taskSecret) throw new Error('WB_TEST_ADMIN_CODE와 WB_TEST_TASK_SECRET가 필요합니다.');

async function post(path, body) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  return { status: response.status, data };
}

const invalid = await post('/admin-exchange', { app: 'task', code: 'short' });
assert.equal(invalid.status, 400);
const crossApp = await post('/admin-exchange', { app: 'consult', code: initialCode });
assert.equal(crossApp.status, 404);

const invalidRecovery = await post('/admin-recover', {
  app: 'task', auth: { mode: 'admin', secret: 'not-the-secret' }
});
assert.equal(invalidRecovery.status, 401);
const crossAppRecovery = await post('/admin-recover', {
  app: 'consult', auth: { mode: 'admin', secret: taskSecret }
});
assert.equal(crossAppRecovery.status, 404);
const first = await post('/admin-exchange', { app: 'task', code: initialCode });
assert.equal(first.status, 200);
assert.match(first.data.token, /^[a-f0-9]{48}$/);
const reused = await post('/admin-exchange', { app: 'task', code: initialCode });
assert.equal(reused.status, 410);

const adminAuth = { mode: 'admin_session', token: first.data.token };
const fullSync = await post('/sync', { app: 'task', auth: adminAuth, since: 0, changes: [] });
assert.equal(fullSync.status, 200);
assert.equal(fullSync.data.changes.filter(change => change.table === 'staff').length, 2);
assert.equal(fullSync.data.changes.filter(change => change.table === 'tasks').length, 2);
const fullRoster = await post('/private-asset', { app: 'task', auth: adminAuth, key: 'roster' });
assert.equal(fullRoster.status, 200);
assert.equal(fullRoster.data.data.students.length, 35);

const adminAsPerson = await post('/sync', {
  app: 'task', auth: { mode: 'person', id: 'staff_a', token: first.data.token }, since: 0, changes: []
});
assert.equal(adminAsPerson.status, 401);

const staffBootstrap = await post('/bootstrap', {
  app: 'task', auth: { mode: 'admin', secret: taskSecret }, staffId: 'staff_a'
});
assert.equal(staffBootstrap.status, 200);
const staffExchange = await post('/exchange', { app: 'task', staffId: 'staff_a', code: staffBootstrap.data.code });
assert.equal(staffExchange.status, 200);
const staffAsAdmin = await post('/sync', {
  app: 'task', auth: { mode: 'admin_session', token: staffExchange.data.token }, since: 0, changes: []
});
assert.equal(staffAsAdmin.status, 401);

const rootHandoff = await post('/admin-handoff', {
  app: 'task', auth: { mode: 'admin', secret: taskSecret }
});
assert.equal(rootHandoff.status, 401);
const handoff = await post('/admin-handoff', { app: 'task', auth: adminAuth });
assert.equal(handoff.status, 200);

const race = await Promise.all([
  post('/admin-exchange', { app: 'task', code: handoff.data.code }),
  post('/admin-exchange', { app: 'task', code: handoff.data.code })
]);
assert.deepEqual(race.map(result => result.status).sort(), [200, 410]);
const winner = race.find(result => result.status === 200);
const oldAfterHandoff = await post('/sync', { app: 'task', auth: adminAuth, since: 0, changes: [] });
assert.equal(oldAfterHandoff.status, 401);

const winnerAuth = { mode: 'admin_session', token: winner.data.token };
const revoke = await post('/admin-revoke', { app: 'task', auth: winnerAuth });
assert.equal(revoke.status, 200);
const afterRevoke = await post('/sync', { app: 'task', auth: winnerAuth, since: 0, changes: [] });
assert.equal(afterRevoke.status, 401);

const recovered = await post('/admin-recover', {
  app: 'task', auth: { mode: 'admin', secret: taskSecret }
});
assert.equal(recovered.status, 200);
assert.match(recovered.data.token, /^[a-f0-9]{48}$/);
const staleHandoff = await post('/admin-handoff', { app: 'task', auth: { mode: 'admin_session', token: recovered.data.token } });
assert.equal(staleHandoff.status, 200);
const recoveredAgain = await post('/admin-recover', {
  app: 'task', auth: { mode: 'admin', secret: taskSecret }
});
assert.equal(recoveredAgain.status, 200);
const recoveredAuth = { mode: 'admin_session', token: recovered.data.token };
const oldRecovered = await post('/sync', { app: 'task', auth: recoveredAuth, since: 0, changes: [] });
assert.equal(oldRecovered.status, 401);
const staleRecoveryExchange = await post('/admin-exchange', { app: 'task', code: staleHandoff.data.code });
assert.equal(staleRecoveryExchange.status, 410);
const recoveredSync = await post('/sync', { app: 'task', auth: { mode: 'admin_session', token: recoveredAgain.data.token }, since: 0, changes: [] });
assert.equal(recoveredSync.status, 200);
console.log(JSON.stringify({
  invalid: invalid.status,
  reused: reused.status,
  fullStaff: 2,
  fullTasks: 2,
  adminAsPerson: adminAsPerson.status,
  staffAsAdmin: staffAsAdmin.status,
  race: race.map(result => result.status).sort(),
  oldAfterHandoff: oldAfterHandoff.status,
  afterRevoke: afterRevoke.status
}));
