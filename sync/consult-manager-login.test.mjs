import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import worker from './worker-core.js';

class Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  first() { return this.database.prepare(this.sql).get(...this.args) || null; }
  all() { return { results: this.database.prepare(this.sql).all(...this.args) }; }
  run() {
    const result = this.database.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(result.changes || 0) } };
  }
}

class TestD1 {
  constructor() {
    this.database = new DatabaseSync(':memory:');
    this.database.exec(`
      CREATE TABLE staff (
        app TEXT NOT NULL,id TEXT NOT NULL,owner TEXT,data TEXT NOT NULL,
        updated_at INTEGER NOT NULL,srv_at INTEGER NOT NULL,PRIMARY KEY(app,id)
      );
      CREATE TABLE tasks (
        app TEXT NOT NULL,id TEXT NOT NULL,owner TEXT,data TEXT NOT NULL,
        updated_at INTEGER NOT NULL,srv_at INTEGER NOT NULL,PRIMARY KEY(app,id)
      );
      CREATE TABLE checks (
        app TEXT NOT NULL,k TEXT NOT NULL,owner TEXT,data TEXT NOT NULL,
        updated_at INTEGER NOT NULL,srv_at INTEGER NOT NULL,PRIMARY KEY(app,k)
      );
      CREATE TABLE tokens (
        app TEXT NOT NULL,token TEXT NOT NULL,staff_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(app,token)
      );
      CREATE TABLE admin_accounts (
        app TEXT NOT NULL PRIMARY KEY CHECK(app='consult'),login_id TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_salt TEXT NOT NULL,password_hash TEXT NOT NULL,password_iterations INTEGER NOT NULL,
        failed_attempts INTEGER NOT NULL DEFAULT 0,locked_until INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL
      );
      CREATE TABLE consult_manager_accounts (
        account_id TEXT NOT NULL PRIMARY KEY,login_id TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,password_salt TEXT NOT NULL,password_hash TEXT NOT NULL,
        password_iterations INTEGER NOT NULL,failed_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1,
        last_login_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
      );
      CREATE TABLE book_order_student_snapshots (
        app TEXT NOT NULL,task_id TEXT NOT NULL
      );
    `);
  }
  prepare(sql) { return new Statement(this.database, sql); }
  batch(statements) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (this.beforeBatch) {
        const callback = this.beforeBatch;
        this.beforeBatch = null;
        callback();
      }
      const results = statements.map(statement => statement.run());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

const envFor = DB => ({ DB, CONSULT_ADMIN_SECRET: 'consult-secret', TASK_ADMIN_SECRET: 'task-secret' });
const director = { mode: 'admin', secret: 'consult-secret' };

async function post(DB, path, body, app = 'consult') {
  const response = await worker.fetch(new Request('https://worker.example' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app, ...body })
  }), envFor(DB));
  return { status: response.status, body: await response.json() };
}

async function createManager(DB, values = {}) {
  const response = await post(DB, '/manager-account', {
    auth: director, action: 'save', displayName: values.displayName || '김선생',
    loginId: values.loginId || 'teacher.kim', password: values.password || 'teacher-password!'
  });
  assert.equal(response.status, 200);
  return response.body.accountId;
}

async function loginManager(DB, loginId = 'teacher.kim', password = 'teacher-password!') {
  return post(DB, '/admin-login', { loginId, password });
}

test('director creates a hashed manager account and manager receives its own five-device session', async () => {
  const db = new TestD1();
  const accountId = await createManager(db);
  const stored = db.database.prepare('SELECT * FROM consult_manager_accounts WHERE account_id=?').get(accountId);
  assert.equal(stored.login_id, 'teacher.kim');
  assert.equal(stored.display_name, '김선생');
  assert.equal(stored.password_iterations, 100000);
  assert.notEqual(stored.password_hash, 'teacher-password!');
  assert.equal(stored.password_hash.length, 64);
  assert.equal(stored.password_salt.length, 48);

  let latest;
  for (let index = 0; index < 6; index++) {
    const loggedIn = await loginManager(db, index % 2 ? 'TEACHER.KIM' : 'teacher.kim');
    assert.equal(loggedIn.status, 200);
    assert.equal(loggedIn.body.authRole, 'manager');
    assert.equal(loggedIn.body.accountId, accountId);
    assert.equal(loggedIn.body.displayName, '김선생');
    assert.equal(loggedIn.body.activeSessionLimit, 5);
    assert.match(loggedIn.body.token, /^[a-f0-9]{48}$/);
    latest = loggedIn.body.token;
  }
  const deviceId = '__cm__' + accountId;
  const active = db.database.prepare(
    "SELECT count(*) AS n FROM tokens WHERE app='consult' AND staff_id=? AND revoked=0"
  ).get(deviceId).n;
  assert.equal(Number(active), 5);
  assert.ok(db.database.prepare(
    "SELECT token FROM tokens WHERE app='consult' AND staff_id=? LIMIT 1"
  ).get(deviceId).token.startsWith('sha256:'));

  const list = await post(db, '/manager-account', { auth: director, action: 'list' });
  assert.equal(list.status, 200);
  assert.deepEqual(Object.keys(list.body.accounts[0]).sort(), [
    'accountId', 'active', 'createdAt', 'deviceCount', 'displayName', 'lastLoginAt', 'loginId', 'updatedAt'
  ]);
  assert.equal(list.body.accounts[0].deviceCount, 5);
  assert.equal(JSON.stringify(list.body).includes('password'), false);

  const synced = await post(db, '/sync', {
    auth: { mode: 'manager_device', token: latest }, since: 0, changes: []
  });
  assert.equal(synced.status, 200);
  assert.equal(synced.body.authRole, 'manager');
});

test('manager can publish manager tasks and checks but cannot alter staff, director tasks, or protected ledgers', async () => {
  const db = new TestD1();
  const accountId = await createManager(db);
  const login = await loginManager(db);
  const auth = { mode: 'manager_device', token: login.body.token };
  const stamp = Date.now() - 1000;
  db.database.prepare('INSERT INTO staff VALUES(?,?,?,?,?,?)').run(
    'consult', 'student-a', 'student-a', JSON.stringify({ id: 'student-a', name: '학생', updatedAt: stamp }), stamp, stamp
  );
  db.database.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run(
    'consult', 'director-task', 'student-a', JSON.stringify({ id: 'director-task', staffId: 'student-a', origin: 'admin', updatedAt: stamp }), stamp, stamp
  );
  const protectedKeys = ['__subscription__!director|student-a', '__subscriptionpayment__!director|student-a@2026-10',
    '__pointrequest__student-a|all', '__rewardtx__student-a|request-123'];
  for (const key of protectedKeys) {
    db.database.prepare('INSERT INTO checks VALUES(?,?,?,?,?,?)').run(
      'consult', key, 'student-a', JSON.stringify({ done: true, updatedAt: stamp }), stamp, stamp
    );
  }

  const read = await post(db, '/sync', { auth, since: 0, changes: [] });
  assert.equal(read.status, 200);
  assert.ok(read.body.changes.some(row => row.table === 'staff' && row.key === 'student-a'));
  assert.equal(read.body.changes.some(row => protectedKeys.includes(row.key)), false);
  const recovery = await post(db, '/sync', { auth, since: 0, changes: [], recoveryPull: {} });
  assert.equal(recovery.status, 200);
  assert.equal(recovery.body.changes.some(row => protectedKeys.includes(row.key)), false);

  const createdAt = stamp + 100;
  const write = await post(db, '/sync', { auth, since: stamp + 1, changes: [
    { table: 'tasks', id: 'manager-task', owner: 'student-a', updated_at: createdAt,
      data: { id: 'manager-task', staffId: 'student-a', title: '관리 공부', origin: 'admin', updatedAt: createdAt } },
    { table: 'checks', k: 'manager-task|2026-10-21', owner: 'student-a', updated_at: createdAt,
      data: { done: false, updatedAt: createdAt } }
  ] });
  assert.equal(write.status, 200, JSON.stringify(write.body));
  const task = JSON.parse(db.database.prepare("SELECT data FROM tasks WHERE app='consult' AND id='manager-task'").get().data);
  assert.equal(task.origin, 'manager');
  assert.equal(task.lastEditBy, 'manager');
  assert.equal(task.lastEditByManagerId, accountId);
  assert.equal(task.lastEditByManagerName, '김선생');

  const staffWrite = await post(db, '/sync', { auth, since: 0, changes: [
    { table: 'staff', id: 'student-a', owner: 'student-a', updated_at: createdAt + 1,
      data: { id: 'student-a', name: '변경', updatedAt: createdAt + 1 } }
  ] });
  assert.equal(staffWrite.status, 403);
  assert.equal(JSON.parse(db.database.prepare("SELECT data FROM staff WHERE app='consult' AND id='student-a'").get().data).name, '학생');

  const directorTaskWrite = await post(db, '/sync', { auth, since: 0, changes: [
    { table: 'tasks', id: 'director-task', owner: 'student-a', updated_at: createdAt + 2,
      data: { id: 'director-task', staffId: 'student-a', origin: 'admin', title: '변경', updatedAt: createdAt + 2 } }
  ] });
  assert.equal(directorTaskWrite.status, 403);

  const reportWrite = await post(db, '/sync', { auth, since: 0, changes: [
    { table: 'tasks', id: 'manager-report', owner: 'student-a', updated_at: createdAt + 3,
      data: { id: 'manager-report', staffId: 'student-a', kind: 'report_snapshot', origin: 'manager',
        reportStatus: 'published', updatedAt: createdAt + 3 } }
  ] });
  assert.equal(reportWrite.status, 403);
  assert.equal(reportWrite.body.code, 'MANAGER_WRITE_FORBIDDEN');
  assert.equal(db.database.prepare("SELECT id FROM tasks WHERE app='consult' AND id='manager-report'").get(), undefined);

  db.beforeBatch = () => db.database.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run(
    'consult', 'race-task', 'student-a',
    JSON.stringify({ id: 'race-task', staffId: 'student-a', origin: 'admin', title: '원장 업무', updatedAt: createdAt }),
    createdAt, createdAt
  );
  const raced = await post(db, '/sync', { auth, since: createdAt, changes: [
    { table: 'tasks', id: 'race-task', owner: 'student-a', updated_at: createdAt + 10,
      data: { id: 'race-task', staffId: 'student-a', origin: 'manager', title: '덮어쓰기', updatedAt: createdAt + 10 } }
  ] });
  assert.equal(raced.status, 200);
  const racedTask = JSON.parse(db.database.prepare("SELECT data FROM tasks WHERE app='consult' AND id='race-task'").get().data);
  assert.equal(racedTask.origin, 'admin');
  assert.equal(racedTask.title, '원장 업무');

  for (const key of protectedKeys) {
    const denied = await post(db, '/sync', { auth, since: 0, changes: [
      { table: 'checks', k: key, owner: 'student-a', updated_at: createdAt + 3,
        data: { done: true, updatedAt: createdAt + 3 } }
    ] });
    assert.equal(denied.status, 403, key);
  }
});

test('manager credentials cannot enter director endpoints or the task app', async () => {
  const db = new TestD1();
  await createManager(db);
  const login = await loginManager(db);
  const auth = { mode: 'manager_device', token: login.body.token };
  for (const [path, body] of [
    ['/admin-account', { auth, action: 'get' }], ['/admin-handoff', { auth }],
    ['/manager-account', { auth, action: 'list' }], ['/bootstrap', { auth, staffId: 'student-a' }],
    ['/revoke', { auth, staffId: 'student-a' }], ['/consult-reward', { auth, action: 'claim' }],
    ['/consult-result', { auth, action: 'list', staffId: 'student-a' }],
    ['/consult-guardian', { auth, action: 'access_list' }],
    ['/consult-link-send', { auth, action: 'list' }]
  ]) {
    const denied = await post(db, path, body);
    assert.equal(denied.status, 403, path);
    assert.equal(denied.body.code, 'DIRECTOR_REQUIRED', path);
  }
  const taskSync = await post(db, '/sync', { auth, since: 0, changes: [] }, 'task');
  assert.equal(taskSync.status, 401);
  const taskLogin = await post(db, '/admin-login', { loginId: 'teacher.kim', password: 'teacher-password!' }, 'task');
  assert.equal(taskLogin.status, 400);
});

test('manager password reset and deactivation revoke only that manager sessions', async () => {
  const db = new TestD1();
  const firstId = await createManager(db);
  const secondId = await createManager(db, { displayName: '이선생', loginId: 'teacher.lee', password: 'lee-password!' });
  const first = await loginManager(db);
  const second = await loginManager(db, 'teacher.lee', 'lee-password!');

  const changed = await post(db, '/manager-account', {
    auth: director, action: 'save', accountId: firstId, displayName: '김선생',
    loginId: 'teacher.kim', password: 'new-password!'
  });
  assert.equal(changed.status, 200);
  assert.equal((await post(db, '/sync', { auth: { mode: 'manager_device', token: first.body.token }, since: 0, changes: [] })).status, 401);
  assert.equal((await post(db, '/sync', { auth: { mode: 'manager_device', token: second.body.token }, since: 0, changes: [] })).status, 200);
  assert.equal((await loginManager(db, 'teacher.kim', 'new-password!')).status, 200);

  const disabled = await post(db, '/manager-account', {
    auth: director, action: 'set_active', accountId: secondId, active: false
  });
  assert.equal(disabled.status, 200);
  assert.equal((await post(db, '/sync', { auth: { mode: 'manager_device', token: second.body.token }, since: 0, changes: [] })).status, 401);
  assert.equal((await loginManager(db, 'teacher.lee', 'lee-password!')).status, 401);
});

test('manager login locks for five failures and login ids cannot collide across roles', async () => {
  const db = new TestD1();
  const setup = await post(db, '/admin-account', {
    auth: director, action: 'set', loginId: 'director', password: 'director-password!'
  });
  assert.equal(setup.status, 200);
  const collision = await post(db, '/manager-account', {
    auth: director, action: 'save', displayName: '충돌', loginId: 'DIRECTOR', password: 'teacher-password!'
  });
  assert.equal(collision.status, 409);

  await createManager(db);
  const adminCollision = await post(db, '/admin-account', {
    auth: director, action: 'set', loginId: 'TEACHER.KIM', password: 'director-password!'
  });
  assert.equal(adminCollision.status, 409);

  for (let index = 0; index < 5; index++) {
    const failed = await loginManager(db, 'teacher.kim', 'wrong-password');
    assert.equal(failed.status, 401);
    assert.equal(failed.body.code, 'LOGIN_FAILED');
  }
  const locked = await loginManager(db);
  assert.equal(locked.status, 429);
  assert.equal(locked.body.code, 'LOGIN_LOCKED');
});

test('parallel failed logins atomically lock both director and manager accounts', async () => {
  const db = new TestD1();
  const setup = await post(db, '/admin-account', {
    auth: director, action: 'set', loginId: 'director', password: 'director-password!'
  });
  assert.equal(setup.status, 200);
  await createManager(db);

  const directorFailures = await Promise.all(Array.from({ length: 5 }, () =>
    post(db, '/admin-login', { loginId: 'director', password: 'wrong-password' })));
  assert.ok(directorFailures.every(result => result.status === 401));
  const directorLocked = await post(db, '/admin-login', {
    loginId: 'director', password: 'director-password!'
  });
  assert.equal(directorLocked.status, 429);
  assert.equal(directorLocked.body.code, 'LOGIN_LOCKED');

  const managerFailures = await Promise.all(Array.from({ length: 5 }, () =>
    loginManager(db, 'teacher.kim', 'wrong-password')));
  assert.ok(managerFailures.every(result => result.status === 401));
  const managerLocked = await loginManager(db);
  assert.equal(managerLocked.status, 429);
  assert.equal(managerLocked.body.code, 'LOGIN_LOCKED');
});

test('password changes and manager deactivation racing login cannot leave a live token', async () => {
  const adminDb = new TestD1();
  const setup = await post(adminDb, '/admin-account', {
    auth: director, action: 'set', loginId: 'director', password: 'director-password!'
  });
  assert.equal(setup.status, 200);
  adminDb.beforeBatch = () => {
    adminDb.database.prepare(
      "UPDATE admin_accounts SET password_hash='changed-admin-hash',updated_at=updated_at+1 WHERE app='consult'"
    ).run();
    adminDb.database.prepare(
      "UPDATE tokens SET revoked=1 WHERE app='consult' AND staff_id='__admin__' AND revoked=0"
    ).run();
  };
  const staleDirector = await post(adminDb, '/admin-login', {
    loginId: 'director', password: 'director-password!'
  });
  assert.equal(staleDirector.status, 409);
  assert.equal(staleDirector.body.code, 'LOGIN_RETRY');
  assert.equal(Number(adminDb.database.prepare(
    "SELECT count(*) AS n FROM tokens WHERE app='consult' AND staff_id='__admin__' AND revoked=0"
  ).get().n), 0);

  const passwordDb = new TestD1();
  const passwordAccountId = await createManager(passwordDb);
  passwordDb.beforeBatch = () => passwordDb.database.prepare(
    "UPDATE consult_manager_accounts SET password_hash='changed-manager-hash',updated_at=updated_at+1 " +
    'WHERE account_id=?'
  ).run(passwordAccountId);
  const staleManager = await loginManager(passwordDb);
  assert.equal(staleManager.status, 409);
  assert.equal(staleManager.body.code, 'LOGIN_RETRY');
  assert.equal(Number(passwordDb.database.prepare(
    "SELECT count(*) AS n FROM tokens WHERE app='consult' AND staff_id=? AND revoked=0"
  ).get('__cm__' + passwordAccountId).n), 0);

  const inactiveDb = new TestD1();
  const inactiveAccountId = await createManager(inactiveDb);
  inactiveDb.beforeBatch = () => inactiveDb.database.prepare(
    'UPDATE consult_manager_accounts SET active=0,updated_at=updated_at+1 WHERE account_id=?'
  ).run(inactiveAccountId);
  const deactivatedManager = await loginManager(inactiveDb);
  assert.equal(deactivatedManager.status, 409);
  assert.equal(deactivatedManager.body.code, 'LOGIN_RETRY');
  assert.equal(Number(inactiveDb.database.prepare(
    "SELECT count(*) AS n FROM tokens WHERE app='consult' AND staff_id=? AND revoked=0"
  ).get('__cm__' + inactiveAccountId).n), 0);
});
