import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import worker from './worker-core.js';

class D1Statement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.args = [];
  }

  bind(...args) {
    this.args = args;
    return this;
  }

  first() {
    return this.database.prepare(this.sql).get(...this.args) || null;
  }

  all() {
    return { results: this.database.prepare(this.sql).all(...this.args) };
  }

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
        updated_at INTEGER NOT NULL, srv_at INTEGER NOT NULL,
        PRIMARY KEY (app, id)
      );
      CREATE TABLE tasks (
        app TEXT NOT NULL, id TEXT NOT NULL, owner TEXT, data TEXT NOT NULL,
        updated_at INTEGER NOT NULL, srv_at INTEGER NOT NULL,
        PRIMARY KEY (app, id)
      );
      CREATE TABLE checks (
        app TEXT NOT NULL, k TEXT NOT NULL, owner TEXT, data TEXT NOT NULL,
        updated_at INTEGER NOT NULL, srv_at INTEGER NOT NULL,
        PRIMARY KEY (app, k)
      );
      CREATE TABLE tokens (
        app TEXT NOT NULL, token TEXT NOT NULL, staff_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (app, token)
      );
      CREATE TABLE bootstrap_codes (
        app TEXT NOT NULL, code_hash TEXT NOT NULL, staff_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        consumed_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (app, code_hash)
      );
    `);
  }

  prepare(sql) {
    return new D1Statement(this.database, sql);
  }

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

  seedStaff(id = 'teacher-1') {
    this.database.prepare(
      'INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)'
    ).run('task', id, id, JSON.stringify({ id, name: '교사', deleted: false }), 1, 1);
  }

  count(sql, ...args) {
    return Number(this.database.prepare(sql).get(...args).n);
  }
}

const envFor = (database, overrides = {}) => ({
  DB: database,
  TASK_ADMIN_SECRET: 'admin-secret',
  CONSULT_ADMIN_SECRET: 'consult-secret',
  ...overrides
});

async function postApp(database, app, path, body, envOverrides = {}) {
  const response = await worker.fetch(new Request('https://worker.example' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app, ...body })
  }), envFor(database, envOverrides));
  return { status: response.status, body: await response.json() };
}

async function post(database, path, body, envOverrides = {}) {
  return postApp(database, 'task', path, body, envOverrides);
}

const admin = { mode: 'admin', secret: 'admin-secret' };

async function bootstrap(database, staffId = 'teacher-1') {
  return post(database, '/bootstrap', { auth: admin, staffId });
}

async function exchange(database, code, staffId = 'teacher-1') {
  return post(database, '/exchange', { staffId, code });
}

async function hashForStorage(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return 'sha256:' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

test('allowlisted task manager personal auth can issue another teacher QR link', async () => {
  const db = new TestD1();
  const now = Date.now();
  db.prepare('INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', 'manager-1', 'manager-1', JSON.stringify({ id: 'manager-1', name: '관리자선생님', deleted: false }), now, now).run();
  db.seedStaff('teacher-2');
  db.prepare('INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)')
    .bind('task', 'manager-token', 'manager-1', now).run();

  const result = await post(db, '/bootstrap', {
    auth: { mode: 'person', id: 'manager-1', token: 'manager-token' }, staffId: 'teacher-2'
  }, { TASK_MANAGER_STAFF_IDS: ' other-manager , manager-1 ' });
  assert.equal(result.status, 200);
  assert.match(result.body.code, /^[a-f0-9]{48}$/);
  assert.equal(result.body.authRole, 'staff');
});

test('staff.manager metadata and an allowlist substring cannot elevate personal auth', async () => {
  const db = new TestD1();
  const now = Date.now();
  db.prepare('INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', 'teacher-1', 'teacher-1', JSON.stringify({ id: 'teacher-1', manager: true, deleted: false }), now, now).run();
  db.seedStaff('teacher-2');
  db.prepare('INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)')
    .bind('task', 'teacher-token', 'teacher-1', now).run();

  const result = await post(db, '/bootstrap', {
    auth: { mode: 'person', id: 'teacher-1', token: 'teacher-token' }, staffId: 'teacher-2'
  }, { TASK_MANAGER_STAFF_IDS: 'teacher-10' });
  assert.equal(result.status, 401);
});

test('consult personal auth stays owner scoped even when metadata and task allowlist say manager', async () => {
  const db = new TestD1();
  const now = Date.now();
  db.prepare('INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('consult', 'manager-1', 'manager-1', JSON.stringify({ id: 'manager-1', manager: true, deleted: false }), now, now).run();
  db.prepare('INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('consult', 'teacher-2', 'teacher-2', JSON.stringify({ id: 'teacher-2', deleted: false }), now, now).run();
  db.prepare('INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)')
    .bind('consult', 'manager-token', 'manager-1', now).run();

  const result = await postApp(db, 'consult', '/bootstrap', {
    auth: { mode: 'person', id: 'manager-1', token: 'manager-token' }, staffId: 'teacher-2'
  }, { TASK_MANAGER_STAFF_IDS: 'manager-1' });
  assert.equal(result.status, 401);
});

test('allowlisted task manager handoff issues a code only for the same staff id', async () => {
  const db = new TestD1();
  const now = Date.now();
  db.seedStaff('manager-1');
  db.seedStaff('teacher-2');
  db.prepare('INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)')
    .bind('task', 'manager-token', 'manager-1', now).run();
  const auth = { mode: 'person', id: 'manager-1', token: 'manager-token' };
  const managerEnv = { TASK_MANAGER_STAFF_IDS: 'manager-1' };

  const issued = await post(db, '/handoff', { auth, staffId: 'teacher-2' }, managerEnv);
  assert.equal(issued.status, 200);
  assert.match(issued.body.code, /^[a-f0-9]{48}$/);
  assert.equal(issued.body.authRole, 'manager');
  assert.ok(issued.body.expiresAt <= Date.now() + 10 * 60 * 1000);
  assert.equal(db.count(
    'SELECT count(*) AS n FROM bootstrap_codes WHERE app=? AND staff_id=?', 'task', 'manager-1'
  ), 1);
  assert.equal(db.count(
    'SELECT count(*) AS n FROM bootstrap_codes WHERE app=? AND staff_id=?', 'task', 'teacher-2'
  ), 0);
  assert.equal((await exchange(db, issued.body.code, 'manager-1')).status, 200);
});

test('manager task sync server-stamps audit fields and preserves an existing origin', async () => {
  const db = new TestD1();
  const now = Date.now();
  db.seedStaff('manager-1');
  db.prepare('INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)')
    .bind('task', 'manager-token', 'manager-1', now).run();
  db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', 'existing-task', 'teacher-2', JSON.stringify({
      id: 'existing-task', staffId: 'teacher-2', origin: 'admin', lastEditBy: 'admin', title: 'existing'
    }), 1, 1).run();
  const auth = { mode: 'person', id: 'manager-1', token: 'manager-token' };
  const result = await post(db, '/sync', { auth, since: now, changes: [
    { table: 'tasks', id: 'existing-task', owner: 'teacher-2', updated_at: 2,
      data: { id: 'existing-task', staffId: 'teacher-2', origin: 'staff', lastEditBy: 'forged', title: 'updated' } },
    { table: 'tasks', id: 'new-task', owner: 'teacher-2', updated_at: 2,
      data: { id: 'new-task', staffId: 'teacher-2', origin: 'staff', lastEditBy: 'forged', title: 'new' } }
  ] }, { TASK_MANAGER_STAFF_IDS: 'manager-1' });
  assert.equal(result.status, 200);
  assert.equal(result.body.authRole, 'manager');

  const existing = JSON.parse(db.database.prepare(
    'SELECT data FROM tasks WHERE app=? AND id=?'
  ).get('task', 'existing-task').data);
  const created = JSON.parse(db.database.prepare(
    'SELECT data FROM tasks WHERE app=? AND id=?'
  ).get('task', 'new-task').data);
  assert.equal(existing.origin, 'admin');
  assert.equal(existing.lastEditBy, 'manager');
  assert.equal(created.origin, 'manager');
  assert.equal(created.lastEditBy, 'manager');

  const malformed = await post(db, '/sync', { auth, since: now, changes: [
    { table: 'tasks', id: 'malformed-task', owner: 'teacher-2', updated_at: 3, data: 'not-an-object' }
  ] }, { TASK_MANAGER_STAFF_IDS: 'manager-1' });
  assert.equal(malformed.status, 403);
  assert.equal(db.count('SELECT count(*) AS n FROM tasks WHERE app=? AND id=?', 'task', 'malformed-task'), 0);
});

test('issuing a second link leaves the first unused link exchangeable', async () => {
  const db = new TestD1();
  db.seedStaff();
  const first = await bootstrap(db);
  const second = await bootstrap(db);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal((await exchange(db, first.body.code)).status, 200);
  assert.equal((await exchange(db, second.body.code)).status, 200);
  assert.equal(db.count(
    'SELECT count(*) AS n FROM tokens WHERE app=? AND staff_id=? AND revoked=0',
    'task', 'teacher-1'
  ), 2);
});

test('only the three newest unused links remain valid', async () => {
  const db = new TestD1();
  db.seedStaff();
  const originalNow = Date.now;
  let now = 2_000_000_000_000;
  Date.now = () => now;
  try {
    const issued = [];
    for (let index = 0; index < 4; index += 1) {
      issued.push(await bootstrap(db));
      now += 1_000;
    }
    assert.equal(db.count(
      'SELECT count(*) AS n FROM bootstrap_codes WHERE app=? AND staff_id=? AND revoked=0 AND consumed_at IS NULL',
      'task', 'teacher-1'
    ), 3);

    const oldest = await exchange(db, issued[0].body.code);
    assert.equal(oldest.status, 410);
    assert.equal(oldest.body.code, 'LINK_REPLACED');
    assert.equal((await exchange(db, issued[1].body.code)).status, 200);
  } finally {
    Date.now = originalNow;
  }
});

test('four device exchanges keep the newest three bearer sessions', async () => {
  const db = new TestD1();
  db.seedStaff();
  const originalNow = Date.now;
  let now = 2_000_000_000_000;
  Date.now = () => now;
  try {
    const sessions = [];
    for (let index = 0; index < 4; index += 1) {
      const issued = await bootstrap(db);
      now += 1_000;
      const result = await exchange(db, issued.body.code);
      assert.equal(result.status, 200);
      assert.equal(result.body.activeSessionLimit, 3);
      sessions.push(result.body.token);
      now += 1_000;
    }

    assert.equal(db.count(
      'SELECT count(*) AS n FROM tokens WHERE app=? AND staff_id=? AND revoked=0',
      'task', 'teacher-1'
    ), 3);
    assert.equal(db.count(
      'SELECT count(*) AS n FROM tokens WHERE app=? AND staff_id=? AND revoked=1',
      'task', 'teacher-1'
    ), 1);

    const firstSync = await post(db, '/sync', {
      auth: { mode: 'person', id: 'teacher-1', token: sessions[0] }, since: now, changes: []
    });
    const secondSync = await post(db, '/sync', {
      auth: { mode: 'person', id: 'teacher-1', token: sessions[1] }, since: now, changes: []
    });
    assert.equal(firstSync.status, 401);
    assert.equal(secondSync.status, 200);
  } finally {
    Date.now = originalNow;
  }
});

test('a successful exchange revokes an expired bearer without revoking recent sessions', async () => {
  const db = new TestD1();
  db.seedStaff();
  const now = 2_000_000_000_000;
  const ninetyDays = 90 * 24 * 60 * 60 * 1000;
  db.database.prepare(
    'INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)'
  ).run('task', 'legacy-expired', 'teacher-1', now - ninetyDays - 1);
  db.database.prepare(
    'INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)'
  ).run('task', 'legacy-recent', 'teacher-1', now - 1_000);

  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const issued = await bootstrap(db);
    const result = await exchange(db, issued.body.code);
    assert.equal(result.status, 200);
    assert.equal(db.count(
      'SELECT count(*) AS n FROM tokens WHERE app=? AND token=? AND revoked=1',
      'task', 'legacy-expired'
    ), 1);
    assert.equal(db.count(
      'SELECT count(*) AS n FROM tokens WHERE app=? AND token=? AND revoked=0',
      'task', 'legacy-recent'
    ), 1);
  } finally {
    Date.now = originalNow;
  }
});

test('exchange failures return stable machine-readable link codes', async () => {
  const db = new TestD1();
  db.seedStaff();
  const now = Date.now();
  const samples = [
    { raw: '1'.repeat(48), consumedAt: now - 1_000, revoked: 0, expiresAt: now + 10_000, want: 'LINK_USED' },
    { raw: '2'.repeat(48), consumedAt: null, revoked: 0, expiresAt: now - 1, want: 'LINK_EXPIRED' },
    { raw: '3'.repeat(48), consumedAt: null, revoked: 1, expiresAt: now + 10_000, want: 'LINK_REPLACED' }
  ];
  for (const sample of samples) {
    db.database.prepare(
      'INSERT INTO bootstrap_codes(app,code_hash,staff_id,created_at,expires_at,consumed_at,revoked) ' +
      'VALUES(?,?,?,?,?,?,?)'
    ).run('task', await hashForStorage(sample.raw), 'teacher-1', now - 2_000,
      sample.expiresAt, sample.consumedAt, sample.revoked);
    const result = await exchange(db, sample.raw);
    assert.equal(result.status, 410);
    assert.equal(result.body.code, sample.want);
  }

  const missing = await exchange(db, '4'.repeat(48));
  assert.equal(missing.status, 410);
  assert.equal(missing.body.code, 'LINK_INVALID');

  const malformed = await exchange(db, 'not-a-code');
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.code, 'LINK_INVALID');
});

test('a deleted staff member cannot use an otherwise active bearer', async () => {
  const db = new TestD1();
  db.seedStaff();
  const issued = await bootstrap(db);
  const connected = await exchange(db, issued.body.code);
  assert.equal(connected.status, 200);

  db.database.prepare('UPDATE staff SET data=? WHERE app=? AND id=?').run(
    JSON.stringify({ id: 'teacher-1', name: '교사', deleted: true }), 'task', 'teacher-1'
  );
  const auth = { mode: 'person', id: 'teacher-1', token: connected.body.token };
  const managerEnv = { TASK_MANAGER_STAFF_IDS: 'teacher-1' };
  const syncResult = await post(db, '/sync', { auth, since: Date.now(), changes: [] }, managerEnv);
  const handoffResult = await post(db, '/handoff', { auth }, managerEnv);

  assert.equal(syncResult.status, 401);
  assert.equal(handoffResult.status, 401);
  assert.equal(handoffResult.body.code, 'AUTH_REQUIRED');
});

test('handoff without a valid bearer returns AUTH_REQUIRED and creates no code', async () => {
  const db = new TestD1();
  db.seedStaff();
  const result = await post(db, '/handoff', {
    auth: { mode: 'person', id: 'teacher-1', token: 'missing-token' }
  });
  assert.equal(result.status, 401);
  assert.equal(result.body.code, 'AUTH_REQUIRED');
  assert.equal(db.count('SELECT count(*) AS n FROM bootstrap_codes'), 0);
});

test('consult admin can connect one new device with a ten-minute one-time link', async () => {
  const db = new TestD1();
  const issued = await post(db, '/admin-handoff', {
    app: 'consult', auth: { mode: 'admin', secret: 'consult-secret' }
  });
  assert.equal(issued.status, 200);
  assert.match(issued.body.code, /^[a-f0-9]{48}$/);
  assert.ok(issued.body.expiresAt <= Date.now() + 10 * 60 * 1000);

  const connected = await post(db, '/exchange', {
    app: 'consult', staffId: '__admin__', code: issued.body.code
  });
  assert.equal(connected.status, 200);

  const auth = { mode: 'admin_device', token: connected.body.token };
  assert.equal((await post(db, '/sync', { app: 'consult', auth, since: 0, changes: [] })).status, 200);
  assert.equal((await post(db, '/sync', { app: 'task', auth, since: 0, changes: [] })).status, 401);

  const reused = await post(db, '/exchange', {
    app: 'consult', staffId: '__admin__', code: issued.body.code
  });
  assert.equal(reused.status, 410);
  assert.equal(reused.body.code, 'LINK_USED');
});

test('admin device handoff is consult-only and requires valid admin auth', async () => {
  const db = new TestD1();
  const task = await post(db, '/admin-handoff', { auth: admin });
  const unauthenticated = await post(db, '/admin-handoff', {
    app: 'consult', auth: { mode: 'admin', secret: 'wrong' }
  });
  assert.equal(task.status, 400);
  assert.equal(unauthenticated.status, 401);
});
