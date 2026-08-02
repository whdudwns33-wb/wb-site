import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import worker from './worker-core.js';

const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
const learningMigration = await readFile(new URL('./migrations/002_learning_platform_v2.sql', import.meta.url), 'utf8');
const tokenMigration = await readFile(new URL('./migrations/003_token_hash_prefix.sql', import.meta.url), 'utf8');
const ORIGIN = 'https://whdudwns33-wb.github.io';

class D1StatementMock {
  constructor(database, sql, bindings = []) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
  }
  bind(...bindings) { return new D1StatementMock(this.database, this.sql, bindings); }
  first() { return this.database.prepare(this.sql).get(...this.bindings); }
  all() { return { results: this.database.prepare(this.sql).all(...this.bindings) }; }
  run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { success: true, meta: { changes: Number(result.changes || 0) } };
  }
}

class D1DatabaseMock {
  constructor(database) { this.database = database; }
  prepare(sql) { return new D1StatementMock(this.database, sql); }
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
}

async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function createHarness() {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  const now = Date.now() - 10_000;
  const insertStaff = database.prepare(
    'INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)'
  );
  const insertTask = database.prepare(
    'INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)'
  );
  const insertToken = database.prepare(
    'INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)'
  );
  const people = [
    ['A', false], ['B', false], ['M', true]
  ];
  for (const app of ['task', 'consult']) {
    for (const [id, manager] of people) {
      insertStaff.run(app, id, id, JSON.stringify({ id, name: id, manager, updatedAt: now }), now, now);
      insertToken.run(app, 'sha256:' + await digest(`${app}-${id}-token`), id, now);
    }
  }
  insertTask.run('task', 'TASK-A', 'A', JSON.stringify({
    id: 'TASK-A', staffId: 'A', title: 'A 업무', origin: '', updatedAt: now
  }), now, now + 1);
  insertTask.run('task', 'TASK-B', 'B', JSON.stringify({
    id: 'TASK-B', staffId: 'B', title: 'B 업무', origin: '', updatedAt: now
  }), now, now + 2);
  insertTask.run('consult', 'PLAN-A', 'A', JSON.stringify({
    id: 'PLAN-A', staffId: 'A', title: 'A 계획', origin: '', updatedAt: now
  }), now, now + 1);

  return {
    database,
    env: {
      DB: new D1DatabaseMock(database),
      ALLOW_ORIGIN: ORIGIN,
      TASK_ADMIN_SECRET: 'task-admin',
      CONSULT_ADMIN_SECRET: 'consult-admin'
    }
  };
}

function auth(app, id) {
  return { mode: 'person', id, token: `${app}-${id}-token` };
}

async function call(env, path, body) {
  const response = await worker.fetch(new Request('https://worker.test' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify(body)
  }), env, {});
  return { response, data: await response.json() };
}

test('일반 task 개인 토큰은 자기 소유 행만 읽고 토큰 관리와 타인 쓰기는 못 한다', async () => {
  const { database, env } = await createHarness();
  const insertCheck = database.prepare(
    'INSERT INTO checks(app,k,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)'
  );
  const sharedAt = Date.now() - 1000;
  for (const kind of ['ct', 'exam', 'op', 'opset']) {
    insertCheck.run('task', '__' + kind + '__STUDENT-X|all', 'STUDENT-X', JSON.stringify({
      taskId: '__' + kind + '__STUDENT-X', date: 'all', done: true, updatedAt: sharedAt
    }), sharedAt, sharedAt);
  }
  insertCheck.run('task', '__att__B|2026-08-03', 'B', JSON.stringify({
    taskId: '__att__B', date: '2026-08-03', done: true, updatedAt: sharedAt
  }), sharedAt, sharedAt);
  const pulled = await call(env, '/sync', { app: 'task', auth: auth('task', 'A'), since: 0, changes: [] });
  assert.equal(pulled.response.status, 200);
  assert.ok(pulled.data.changes.some(change => change.table === 'staff' && change.key === 'A'));
  assert.equal(pulled.data.changes.some(change => change.table === 'staff' && change.key === 'B'), false);
  assert.equal(pulled.data.changes.some(change => change.table === 'tasks' && change.key === 'TASK-B'), false);
  for (const kind of ['ct', 'exam', 'op', 'opset']) {
    assert.ok(pulled.data.changes.some(change => change.table === 'checks' &&
      change.key === '__' + kind + '__STUDENT-X|all'));
  }
  assert.equal(pulled.data.changes.some(change => change.key === '__att__B|2026-08-03'), false);

  const issued = await call(env, '/token', { app: 'task', auth: auth('task', 'A'), staffId: 'B' });
  assert.equal(issued.response.status, 401);

  const now = Date.now();
  const rejected = await call(env, '/sync', {
    app: 'task', auth: auth('task', 'A'), since: 0,
    changes: [
      {
        table: 'checks', k: 'TASK-A|2026-08-03', owner: 'A', updated_at: now,
        data: { taskId: 'TASK-A', date: '2026-08-03', done: true, updatedAt: now }
      },
      {
        table: 'tasks', id: 'TASK-B', owner: 'B', updated_at: now,
        data: { id: 'TASK-B', staffId: 'B', title: '위조', origin: 'staff', updatedAt: now }
      }
    ]
  });
  assert.equal(rejected.response.status, 422);
  assert.equal(rejected.data.code, 'change_validation_failed');
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM checks WHERE app='task'").get().n, 5);
  database.close();
});

test('manager는 타인에게 manager 업무를 발행하지만 토큰은 발급하지 못 한다', async () => {
  const { database, env } = await createHarness();
  const now = Date.now();
  const result = await call(env, '/sync', {
    app: 'task', auth: auth('task', 'M'), since: 0,
    changes: [{
      table: 'tasks', id: 'MANAGER-1', owner: 'B', updated_at: now,
      data: { id: 'MANAGER-1', staffId: 'B', title: '관리자 발행', origin: 'manager', updatedAt: now }
    }]
  });
  assert.equal(result.response.status, 200);
  assert.ok(result.data.changes.some(change => change.table === 'staff' && change.key === 'B'));
  const stored = JSON.parse(database.prepare("SELECT data FROM tasks WHERE app='task' AND id='MANAGER-1'").get().data);
  assert.equal(stored.origin, 'manager');
  assert.equal(stored.staffId, 'B');
  const issued = await call(env, '/token', { app: 'task', auth: auth('task', 'M'), staffId: 'B' });
  assert.equal(issued.response.status, 401);
  database.close();
});

test('체크가 새 업무보다 먼저 와도 원자적으로 검증하고 함께 저장한다', async () => {
  const { database, env } = await createHarness();
  const now = Date.now();
  const result = await call(env, '/sync', {
    app: 'consult', auth: auth('consult', 'A'), since: 0,
    changes: [
      {
        table: 'checks', k: 'OWN-NEW|2026-08-03', owner: 'A', updated_at: now,
        data: { taskId: 'OWN-NEW', date: '2026-08-03', done: true, updatedAt: now }
      },
      {
        table: 'tasks', id: 'OWN-NEW', owner: 'A', updated_at: now,
        data: { id: 'OWN-NEW', staffId: 'A', title: '내 계획', origin: 'staff', updatedAt: now }
      }
    ]
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.accepted, 2);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM checks WHERE app='consult' AND k='OWN-NEW|2026-08-03'").get().n, 1);
  database.close();
});

test('consult의 날짜·all 특수 키와 task 공유 운영 키를 호환한다', async () => {
  const { database, env } = await createHarness();
  const now = Date.now();
  const consult = await call(env, '/sync', {
    app: 'consult', auth: auth('consult', 'A'), since: 0,
    changes: [{
      table: 'checks', k: '__stsubj__A|all', owner: 'A', updated_at: now,
      data: { taskId: '__stsubj__A', date: 'all', list: ['수학'], done: true, updatedAt: now }
    }]
  });
  assert.equal(consult.response.status, 200);

  const task = await call(env, '/sync', {
    app: 'task', auth: auth('task', 'A'), since: 0,
    changes: [{
      table: 'checks', k: '__ct__홍길동|2026-08-03', owner: '홍길동', updated_at: now + 1,
      data: { taskId: '__ct__홍길동', date: '2026-08-03', done: true, updatedAt: now + 1 }
    }]
  });
  assert.equal(task.response.status, 200);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM checks WHERE app='task' AND k='__ct__홍길동|2026-08-03'").get().n, 1);
  database.close();
});

test('학생은 학습 원장 blob을 쓸 수 없고 현재 플래너와 일치하는 자기 완료요청만 쓴다', async () => {
  const { database, env } = await createHarness();
  const now = Date.now();
  database.prepare(
    'INSERT INTO checks(app,k,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)'
  ).run('consult', '__lpplan__A|all', 'A', JSON.stringify({
    taskId: '__lpplan__A', date: 'all', done: true,
    value: [{
      itemId: 'plan_abc123', studentCode: 'A', date: '2026-08-03',
      revision: 3, status: 'planned', title: '현재 계획'
    }], updatedAt: now
  }), now, now);

  const blocked = await call(env, '/sync', {
    app: 'consult', auth: auth('consult', 'A'), since: 0,
    changes: [{ table: 'checks', k: '__lpcore__A|all', owner: 'A', updated_at: now,
      data: { taskId: '__lpcore__A', date: 'all', value: { prepCampaigns: [{ status: 'completed' }] }, done: true, updatedAt: now } }]
  });
  assert.equal(blocked.response.status, 422);
  assert.equal(blocked.data.details[0].code, 'learning_state_write_forbidden');

  const accepted = await call(env, '/sync', {
    app: 'consult', auth: auth('consult', 'A'), since: 0,
    changes: [{ table: 'checks', k: '__lpclaim__A|all', owner: 'A', updated_at: now + 1,
      data: { taskId: '__lpclaim__A', date: 'all', value: { claims: [{
        itemId: 'plan_abc123', date: '2026-08-03', expectedRevision: 3,
        claimedAt: new Date(now).toISOString(), injected: 'drop-me'
      }] }, done: true, ignored: 'drop-me', updatedAt: now + 1 } }]
  });
  assert.equal(accepted.response.status, 200);
  const row = database.prepare("SELECT data FROM checks WHERE app='consult' AND k='__lpclaim__A|all'").get();
  const saved = JSON.parse(row.data);
  assert.deepEqual(Object.keys(saved).sort(), ['date', 'done', 'taskId', 'updatedAt', 'value']);
  assert.deepEqual(Object.keys(saved.value.claims[0]).sort(), ['claimedAt', 'date', 'expectedRevision', 'itemId']);

  const stale = await call(env, '/sync', {
    app: 'consult', auth: auth('consult', 'A'), since: 0,
    changes: [{ table: 'checks', k: '__lpclaim__A|all', owner: 'A', updated_at: now + 2,
      data: { taskId: '__lpclaim__A', date: 'all', value: { claims: [{
        itemId: 'plan_abc123', date: '2026-08-03', expectedRevision: 2,
        claimedAt: new Date(now).toISOString()
      }] }, done: true, updatedAt: now + 2 } }]
  });
  assert.equal(stale.response.status, 422);
  assert.equal(stale.data.details[0].code, 'invalid_learning_claim');
  database.close();
});

test('staff의 평문 token은 저장·응답되지 않고 미래 updatedAt은 서버 시각으로 교정된다', async () => {
  const { database, env } = await createHarness();
  const before = Date.now();
  const future = before + 86_400_000;
  const result = await call(env, '/sync', {
    app: 'consult',
    auth: { mode: 'admin', secret: 'consult-admin' }, since: 0,
    changes: [{
      table: 'staff', id: 'A', owner: 'A', updated_at: future,
      data: { id: 'A', name: 'A', token: 'DO-NOT-STORE', updatedAt: future }
    }]
  });
  assert.equal(result.response.status, 200);
  const row = database.prepare("SELECT data,updated_at FROM staff WHERE app='consult' AND id='A'").get();
  assert.equal(JSON.parse(row.data).token, undefined);
  assert.ok(row.updated_at >= before && row.updated_at <= Date.now());
  const returned = result.data.changes.find(change => change.table === 'staff' && change.key === 'A');
  assert.equal(returned.data.token, undefined);
  database.close();
});

test('구형 평문 개인 토큰은 성공 인증 때 SHA-256으로 지연 이전된다', async () => {
  const { database, env } = await createHarness();
  const legacy = 'legacy-plain-token';
  database.prepare(
    'INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)'
  ).run('consult', legacy, 'A', Date.now());
  const result = await call(env, '/sync', {
    app: 'consult', auth: { mode: 'person', id: 'A', token: legacy }, since: 0, changes: []
  });
  assert.equal(result.response.status, 200);
  const migrated = database.prepare('SELECT token FROM tokens WHERE app=? AND staff_id=? AND revoked=0')
    .all('consult', 'A').map(row => row.token);
  assert.ok(migrated.includes('sha256:' + await digest(legacy)));
  assert.equal(migrated.includes(legacy), false);
  database.close();
});


test('DB 해시 문자열은 bearer로 인증되지 않고 원문 bearer만 인증된다', async () => {
  const { database, env } = await createHarness();
  const raw = 'task-A-token';
  const bareHash = await digest(raw);
  const storedHash = 'sha256:' + bareHash;
  const valid = await call(env, '/sync', {
    app: 'task', auth: { mode: 'person', id: 'A', token: raw }, since: 0, changes: []
  });
  assert.equal(valid.response.status, 200);
  for (const bearer of [bareHash, storedHash]) {
    const rejected = await call(env, '/sync', {
      app: 'task', auth: { mode: 'person', id: 'A', token: bearer }, since: 0, changes: []
    });
    assert.equal(rejected.response.status, 401);
  }
  database.prepare('UPDATE tokens SET created_at=? WHERE app=? AND staff_id=? AND revoked=0')
    .run(Date.now() - 91 * 24 * 60 * 60 * 1000, 'task', 'A');
  const expired = await call(env, '/sync', {
    app: 'task', auth: { mode: 'person', id: 'A', token: raw }, since: 0, changes: []
  });
  assert.equal(expired.response.status, 401);
  database.close();
});

test('1회 bootstrap은 교환 성공 순간에만 bearer를 원자 회전하고 staff 단위로 해지한다', async () => {
  const { database, env } = await createHarness();
  const admin = { mode: 'admin', secret: 'consult-admin' };
  const existingRaw = 'consult-B-token';

  const first = await call(env, '/token', { app: 'consult', auth: admin, staffId: 'B' });
  assert.equal(first.response.status, 200);
  assert.match(first.data.code, /^[a-f0-9]{48}$/);
  assert.equal(first.data.token, undefined);
  const storedFirstCode = database.prepare(
    'SELECT code_hash,expires_at,consumed_at,revoked FROM bootstrap_codes WHERE app=? AND staff_id=?'
  ).get('consult', 'B');
  assert.match(storedFirstCode.code_hash, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(storedFirstCode.code_hash, first.data.code);
  assert.equal(storedFirstCode.consumed_at, null);
  assert.ok(storedFirstCode.expires_at > Date.now() + 23 * 60 * 60 * 1000);
  assert.ok(storedFirstCode.expires_at <= Date.now() + 24 * 60 * 60 * 1000);

  // 링크를 만들기만 해서는 기존 기기 bearer가 끊기지 않는다.
  const beforeExchange = await call(env, '/sync', {
    app: 'consult', auth: { mode: 'person', id: 'B', token: existingRaw }, since: 0, changes: []
  });
  assert.equal(beforeExchange.response.status, 200);

  const second = await call(env, '/token', { app: 'consult', auth: admin, staffId: 'B' });
  assert.equal(second.response.status, 200);
  assert.notEqual(first.data.code, second.data.code);
  const oldCode = await call(env, '/exchange', {
    app: 'consult', staffId: 'B', code: first.data.code
  });
  assert.equal(oldCode.response.status, 410);
  const stillActive = await call(env, '/sync', {
    app: 'consult', auth: { mode: 'person', id: 'B', token: existingRaw }, since: 0, changes: []
  });
  assert.equal(stillActive.response.status, 200);

  const exchanges = await Promise.all([
    call(env, '/exchange', { app: 'consult', staffId: 'B', code: second.data.code }),
    call(env, '/exchange', { app: 'consult', staffId: 'B', code: second.data.code })
  ]);
  assert.deepEqual(exchanges.map(item => item.response.status).sort((a, b) => a - b), [200, 410]);
  const exchanged = exchanges.find(item => item.response.status === 200);
  assert.match(exchanged.data.token, /^[a-f0-9]{48}$/);
  assert.ok(exchanged.data.expiresAt > Date.now() + 89 * 24 * 60 * 60 * 1000);

  const codeAsBearer = await call(env, '/sync', {
    app: 'consult', auth: { mode: 'person', id: 'B', token: second.data.code }, since: 0, changes: []
  });
  assert.equal(codeAsBearer.response.status, 401);
  const oldBearer = await call(env, '/sync', {
    app: 'consult', auth: { mode: 'person', id: 'B', token: existingRaw }, since: 0, changes: []
  });
  assert.equal(oldBearer.response.status, 401);
  const currentBearer = await call(env, '/sync', {
    app: 'consult', auth: { mode: 'person', id: 'B', token: exchanged.data.token }, since: 0, changes: []
  });
  assert.equal(currentBearer.response.status, 200);
  const active = database.prepare(
    'SELECT token FROM tokens WHERE app=? AND staff_id=? AND revoked=0'
  ).all('consult', 'B');
  assert.equal(active.length, 1);
  assert.match(active[0].token, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(active[0].token, exchanged.data.token);

  const third = await call(env, '/token', { app: 'consult', auth: admin, staffId: 'B' });
  assert.equal(third.response.status, 200);
  const survivesNewLink = await call(env, '/sync', {
    app: 'consult', auth: { mode: 'person', id: 'B', token: exchanged.data.token }, since: 0, changes: []
  });
  assert.equal(survivesNewLink.response.status, 200);

  const revoked = await call(env, '/revoke', { app: 'consult', auth: admin, staffId: 'B' });
  assert.equal(revoked.response.status, 200);
  const afterRevoke = await call(env, '/sync', {
    app: 'consult', auth: { mode: 'person', id: 'B', token: exchanged.data.token }, since: 0, changes: []
  });
  assert.equal(afterRevoke.response.status, 401);
  const revokedCode = await call(env, '/exchange', {
    app: 'consult', staffId: 'B', code: third.data.code
  });
  assert.equal(revokedCode.response.status, 410);
  database.close();
});

test('003 migration은 bootstrap schema를 만들고 bare SHA-256을 충돌 없이 멱등 이전한다', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  database.exec(learningMigration);
  const bareHash = (await digest('old-issued-token')).toUpperCase();
  const duplicateBare = (await digest('duplicate-issued-token')).toUpperCase();
  database.prepare(
    'INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)'
  ).run('consult', bareHash, 'A', 1);
  database.prepare(
    'INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)'
  ).run('consult', 'legacy-raw-token', 'B', 1);
  database.prepare(
    'INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)'
  ).run('consult', duplicateBare, 'C', 1);
  database.prepare(
    'INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)'
  ).run('consult', 'sha256:' + duplicateBare.toLowerCase(), 'D', 1);
  database.exec(tokenMigration);
  database.exec(tokenMigration);
  const tokens = database.prepare('SELECT token FROM tokens ORDER BY token').all().map(row => row.token);
  assert.ok(tokens.includes('sha256:' + bareHash.toLowerCase()));
  assert.ok(tokens.includes('legacy-raw-token'));
  assert.equal(tokens.filter(token => token === 'sha256:' + duplicateBare.toLowerCase()).length, 1);
  assert.equal(tokens.some(token => /^[A-Fa-f0-9]{64}$/.test(token)), false);
  const bootstrapColumns = database.prepare('PRAGMA table_info(bootstrap_codes)').all().map(row => row.name);
  assert.deepEqual(bootstrapColumns, [
    'app', 'code_hash', 'staff_id', 'created_at', 'expires_at', 'consumed_at', 'revoked'
  ]);
  const migrationRow = database.prepare(
    'SELECT name, applied_at FROM lp_schema_migrations WHERE version=3'
  ).get();
  assert.equal(migrationRow.name, 'token_bootstrap_hardening');
  assert.ok(migrationRow.applied_at > 0);
  database.close();
});
