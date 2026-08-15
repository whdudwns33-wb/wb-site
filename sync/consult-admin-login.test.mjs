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
        app TEXT NOT NULL, id TEXT NOT NULL, owner TEXT, data TEXT NOT NULL,
        updated_at INTEGER NOT NULL, srv_at INTEGER NOT NULL, PRIMARY KEY (app,id)
      );
      CREATE TABLE tasks (
        app TEXT NOT NULL, id TEXT NOT NULL, owner TEXT, data TEXT NOT NULL,
        updated_at INTEGER NOT NULL, srv_at INTEGER NOT NULL, PRIMARY KEY (app,id)
      );
      CREATE TABLE checks (
        app TEXT NOT NULL, k TEXT NOT NULL, owner TEXT, data TEXT NOT NULL,
        updated_at INTEGER NOT NULL, srv_at INTEGER NOT NULL, PRIMARY KEY (app,k)
      );
      CREATE TABLE tokens (
        app TEXT NOT NULL, token TEXT NOT NULL, staff_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (app,token)
      );
      CREATE TABLE admin_accounts (
        app TEXT NOT NULL PRIMARY KEY CHECK (app='consult'),
        login_id TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
        password_iterations INTEGER NOT NULL, failed_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
      );
    `);
  }
  prepare(sql) { return new Statement(this.database, sql); }
  batch(statements) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => statement.run());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
  countActiveAdminTokens() {
    return Number(this.database.prepare(
      "SELECT count(*) AS n FROM tokens WHERE app='consult' AND staff_id='__admin__' AND revoked=0"
    ).get().n);
  }
}

const envFor = DB => ({ DB, CONSULT_ADMIN_SECRET: 'consult-secret', TASK_ADMIN_SECRET: 'task-secret' });

async function post(DB, path, body, app = 'consult') {
  const response = await worker.fetch(new Request('https://worker.example' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app, ...body })
  }), envFor(DB));
  return { status: response.status, body: await response.json() };
}

const secretAuth = { mode: 'admin', secret: 'consult-secret' };

test('consult account setup hashes the password and login returns a reusable device token', async () => {
  const db = new TestD1();
  const setup = await post(db, '/admin-account', {
    auth: secretAuth, action: 'set', loginId: 'Director.WB', password: 'safe-password-123!'
  });
  assert.equal(setup.status, 200);
  assert.equal(setup.body.loginId, 'director.wb');
  assert.equal(setup.body.activeSessionLimit, 5);
  assert.match(setup.body.token, /^[a-f0-9]{48}$/);

  const account = db.database.prepare('SELECT * FROM admin_accounts WHERE app=?').get('consult');
  assert.equal(account.login_id, 'director.wb');
  assert.notEqual(account.password_hash, 'safe-password-123!');
  assert.equal(account.password_hash.length, 64);
  assert.equal(account.password_salt.length, 48);
  assert.equal(db.database.prepare("SELECT token FROM tokens WHERE app='consult'").get().token.startsWith('sha256:'), true);

  const failed = await post(db, '/admin-login', {
    loginId: 'director.wb', password: 'wrong-password'
  });
  assert.equal(failed.status, 401);
  assert.equal(failed.body.code, 'LOGIN_FAILED');

  const login = await post(db, '/admin-login', {
    loginId: 'DIRECTOR.WB', password: 'safe-password-123!'
  });
  assert.equal(login.status, 200);
  assert.match(login.body.token, /^[a-f0-9]{48}$/);

  const synced = await post(db, '/sync', {
    auth: { mode: 'admin_device', token: login.body.token }, since: 0, changes: []
  });
  assert.equal(synced.status, 200);
  assert.equal(synced.body.authRole, 'admin');
});

test('consult keeps only five active admin devices and password changes revoke the old ones', async () => {
  const db = new TestD1();
  const setup = await post(db, '/admin-account', {
    auth: secretAuth, action: 'set', loginId: 'director', password: 'first-password!'
  });
  let latest = setup.body.token;
  for (let i = 0; i < 5; i++) {
    const login = await post(db, '/admin-login', { loginId: 'director', password: 'first-password!' });
    assert.equal(login.status, 200);
    latest = login.body.token;
  }
  assert.equal(db.countActiveAdminTokens(), 5);

  const changed = await post(db, '/admin-account', {
    auth: { mode: 'admin_device', token: latest }, action: 'set',
    loginId: 'director', password: 'second-password!'
  });
  assert.equal(changed.status, 200);
  assert.equal(db.countActiveAdminTokens(), 1);

  const oldToken = await post(db, '/sync', {
    auth: { mode: 'admin_device', token: latest }, since: 0, changes: []
  });
  assert.equal(oldToken.status, 401);
  const newToken = await post(db, '/sync', {
    auth: { mode: 'admin_device', token: changed.body.token }, since: 0, changes: []
  });
  assert.equal(newToken.status, 200);
});

test('task cannot use consult account endpoints', async () => {
  const db = new TestD1();
  const login = await post(db, '/admin-login', { loginId: 'director', password: 'password' }, 'task');
  const setup = await post(db, '/admin-account', {
    auth: { mode: 'admin', secret: 'task-secret' }, action: 'set',
    loginId: 'director', password: 'password-123'
  }, 'task');
  assert.equal(login.status, 400);
  assert.equal(setup.status, 400);
  assert.equal(db.database.prepare('SELECT count(*) AS n FROM admin_accounts').get().n, 0);
});
