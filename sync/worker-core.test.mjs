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
  constructor(owner, sql, bindings = []) {
    this.owner = owner;
    this.database = owner.database;
    this.sql = sql;
    this.bindings = bindings;
  }
  bind(...bindings) { return new D1StatementMock(this.owner, this.sql, bindings); }
  first() {
    const value = this.database.prepare(this.sql).get(...this.bindings);
    return this.owner.coordinatePlanRead(this.sql, this.bindings, value);
  }
  all() { return { results: this.database.prepare(this.sql).all(...this.bindings) }; }
  run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    const changes = Number(result.changes || 0);
    if (changes === 0 && this.sql.startsWith('UPDATE checks SET owner=?,data=?,updated_at=?,srv_at=?')) {
      this.owner.planCasMisses += 1;
    }
    return { success: true, meta: { changes } };
  }
}

class D1DatabaseMock {
  constructor(database) {
    this.database = database;
    this.planCasMisses = 0;
    this.planReadBarrierRemaining = 0;
    this.planReadWaiters = [];
  }
  prepare(sql) { return new D1StatementMock(this, sql); }
  armPlanCasRace() { this.planReadBarrierRemaining = 4; }
  coordinatePlanRead(sql, bindings, value) {
    const isPlanRead = sql.includes('SELECT data,updated_at,srv_at FROM checks') &&
      String(bindings[1] || '').startsWith('__lpplan__');
    if (!isPlanRead || this.planReadBarrierRemaining <= 0) return value;
    this.planReadBarrierRemaining -= 1;
    return new Promise(resolve => {
      this.planReadWaiters.push({ resolve, value });
      if (this.planReadWaiters.length === 2) {
        const pair = this.planReadWaiters.splice(0, 2);
        pair.forEach(waiter => waiter.resolve(waiter.value));
      }
    });
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


test('003 이전 bare SHA-256 저장행은 raw bearer로 인증되고 접두 형식으로 지연 이전된다', async () => {
  const { database, env } = await createHarness();
  const raw = 'pre-prefix-issued-bearer';
  const bareHash = (await digest(raw)).toUpperCase();
  database.prepare('DELETE FROM tokens WHERE app=? AND staff_id=?').run('consult', 'A');
  database.prepare(
    'INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)'
  ).run('consult', bareHash, 'A', Date.now());

  const result = await call(env, '/sync', {
    app: 'consult', auth: { mode: 'person', id: 'A', token: raw }, since: 0, changes: []
  });
  assert.equal(result.response.status, 200);
  const migrated = database.prepare('SELECT token FROM tokens WHERE app=? AND staff_id=? AND revoked=0')
    .all('consult', 'A').map(row => row.token);
  assert.deepEqual(migrated, ['sha256:' + await digest(raw)]);

  const hashAsBearer = await call(env, '/sync', {
    app: 'consult', auth: { mode: 'person', id: 'A', token: bareHash }, since: 0, changes: []
  });
  assert.equal(hashAsBearer.response.status, 401);
  database.close();
});

test('bare digest 지연 이전은 stale prefixed 충돌에서 fail-close하고 정리 뒤 회복한다', async () => {
  const { database, env } = await createHarness();
  const raw = 'bare-conflict-issued-bearer';
  const bareHash = await digest(raw);
  database.prepare('DELETE FROM tokens WHERE app=? AND staff_id=?').run('consult', 'A');
  database.prepare(
    'INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)'
  ).run('consult', bareHash, 'A', Date.now());
  database.prepare(
    'INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,1)'
  ).run('consult', 'sha256:' + bareHash, 'A', 1);

  const blocked = await call(env, '/sync', {
    app: 'consult', auth: { mode: 'person', id: 'A', token: raw }, since: 0, changes: []
  });
  assert.equal(blocked.response.status, 401);
  const beforeCleanup = database.prepare('SELECT token,revoked FROM tokens WHERE app=? AND staff_id=? ORDER BY token')
    .all('consult', 'A');
  assert.equal(beforeCleanup.find(row => row.token === bareHash).revoked, 0);
  assert.equal(beforeCleanup.find(row => row.token === 'sha256:' + bareHash).revoked, 1);

  database.prepare('DELETE FROM tokens WHERE app=? AND token=? AND revoked=1')
    .run('consult', 'sha256:' + bareHash);
  const recovered = await call(env, '/sync', {
    app: 'consult', auth: { mode: 'person', id: 'A', token: raw }, since: 0, changes: []
  });
  assert.equal(recovered.response.status, 200);
  const active = database.prepare('SELECT token FROM tokens WHERE app=? AND staff_id=? AND revoked=0')
    .all('consult', 'A').map(row => row.token);
  assert.deepEqual(active, ['sha256:' + bareHash]);
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


test('003은 active bare와 stale prefixed 충돌에서 유효 bearer를 삭제하지 않고 실패한다', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  database.exec(learningMigration);
  const bareHash = (await digest('active-conflict-issued-bearer')).toUpperCase();
  database.prepare(
    'INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)'
  ).run('consult', bareHash, 'A', Date.now());
  database.prepare(
    'INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,1)'
  ).run('consult', 'sha256:' + bareHash.toLowerCase(), 'A', 1);

  assert.throws(() => database.exec(tokenMigration));
  const rows = database.prepare('SELECT token,revoked FROM tokens WHERE app=? ORDER BY token')
    .all('consult');
  assert.equal(rows.find(row => row.token === bareHash).revoked, 0);
  assert.equal(rows.find(row => row.token === 'sha256:' + bareHash.toLowerCase()).revoked, 1);
  assert.equal(database.prepare('SELECT 1 FROM lp_schema_migrations WHERE version=3').get(), undefined);
  database.close();
});

test('003은 대소문자만 다른 bare digest 중복을 원본 보존 상태로 실패한다', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  database.exec(learningMigration);
  const lowerHash = await digest('case-variant-bare-conflict');
  const upperHash = lowerHash.toUpperCase();
  assert.notEqual(lowerHash, upperHash);
  database.prepare(
    'INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)'
  ).run('consult', lowerHash, 'A', Date.now());
  database.prepare(
    'INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)'
  ).run('consult', upperHash, 'B', Date.now());

  assert.throws(() => database.exec(tokenMigration));
  const tokens = database.prepare('SELECT token FROM tokens WHERE app=? ORDER BY token')
    .all('consult').map(row => row.token).sort();
  assert.deepEqual(tokens, [lowerHash, upperHash].sort());
  assert.equal(database.prepare('SELECT 1 FROM lp_schema_migrations WHERE version=3').get(), undefined);
  database.close();
});

function planItem(itemId, overrides = {}) {
  return Object.assign({
    itemId,
    studentCode: 'A',
    date: '2026-08-03',
    title: itemId === 'plan_alpha' ? '알파 계획' : '베타 계획',
    sourceType: 'personal',
    status: 'planned',
    revision: 1,
    createdAt: '2026-08-01T00:00:00.000Z',
    createdBy: 'manager'
  }, overrides);
}

function planMutationChange(items, mutation, updatedAt = Date.now()) {
  return {
    table: 'checks',
    k: '__lpplan__A|all',
    owner: 'A',
    updated_at: updatedAt,
    data: {
      taskId: '__lpplan__A',
      date: 'all',
      done: true,
      value: items,
      planMutation: mutation,
      updatedAt
    }
  };
}

function seedPlan(database, items, updatedAt = Date.now() - 1000) {
  database.prepare(
    'INSERT INTO checks(app,k,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)'
  ).run('consult', '__lpplan__A|all', 'A', JSON.stringify({
    taskId: '__lpplan__A', date: 'all', done: true, value: items, updatedAt
  }), updatedAt, updatedAt);
}

function savedPlan(database) {
  const row = database.prepare("SELECT data FROM checks WHERE app='consult' AND k='__lpplan__A|all'").get();
  return JSON.parse(row.data).value;
}

function adminSync(env, change) {
  return call(env, '/sync', {
    app: 'consult',
    auth: { mode: 'admin', secret: 'consult-admin' },
    since: 0,
    changes: [change]
  });
}

function stablePlannerId(prefix, ...values) {
  const input = values.map(value => value == null ? '' : String(value)).join('|');
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return String(prefix) + '_' + (hash >>> 0).toString(36);
}

test('lpplan CAS는 같은 base의 서로 다른 항목 동시 수정을 재시도해 모두 보존한다', async () => {
  const { database, env } = await createHarness();
  const alpha = planItem('plan_alpha');
  const beta = planItem('plan_beta');
  seedPlan(database, [alpha, beta]);
  env.DB.armPlanCasRace();

  const results = await Promise.all([
    adminSync(env, planMutationChange([
      planItem('plan_alpha', { title: '알파 수정', revision: 2 }), beta
    ], { id: 'mut_alpha_2', items: [{ itemId: 'plan_alpha', baseRevision: 1, nextRevision: 2 }] })),
    adminSync(env, planMutationChange([
      alpha, planItem('plan_beta', { title: '베타 수정', revision: 2 })
    ], { id: 'mut_beta_2', items: [{ itemId: 'plan_beta', baseRevision: 1, nextRevision: 2 }] }))
  ]);

  assert.deepEqual(results.map(result => result.response.status), [200, 200]);
  assert.ok(env.DB.planCasMisses >= 1, 'CAS compare miss 뒤 재조회·재시도가 실제 발생해야 한다');
  const byId = new Map(savedPlan(database).map(item => [item.itemId, item]));
  assert.equal(byId.get('plan_alpha').revision, 2);
  assert.equal(byId.get('plan_alpha').title, '알파 수정');
  assert.equal(byId.get('plan_beta').revision, 2);
  assert.equal(byId.get('plan_beta').title, '베타 수정');
  database.close();
});

test('lpplan CAS는 같은 항목의 divergent 동시 수정 중 두 번째를 409로 거절한다', async () => {
  const { database, env } = await createHarness();
  const alpha = planItem('plan_alpha');
  seedPlan(database, [alpha]);
  env.DB.armPlanCasRace();

  const results = await Promise.all(['기기 1 수정', '기기 2 수정'].map((title, index) =>
    adminSync(env, planMutationChange([
      planItem('plan_alpha', { title, revision: 2 })
    ], {
      id: 'mut_divergent_' + index,
      items: [{ itemId: 'plan_alpha', baseRevision: 1, nextRevision: 2 }]
    }))
  ));

  assert.deepEqual(results.map(result => result.response.status).sort((a, b) => a - b), [200, 409]);
  const conflict = results.find(result => result.response.status === 409);
  assert.equal(conflict.data.code, 'learning_plan_revision_conflict');
  assert.ok(env.DB.planCasMisses >= 1);
  assert.ok(['기기 1 수정', '기기 2 수정'].includes(savedPlan(database)[0].title));
  database.close();
});

test('동일 lpplan mutation 재시도는 멱등 성공하고 이미 판정 가능한 divergent stale 요청은 409다', async () => {
  const { database, env } = await createHarness();
  seedPlan(database, [planItem('plan_alpha')]);
  const updated = planItem('plan_alpha', { title: '확정 수정', revision: 2 });
  const mutation = { id: 'mut_retry_same', items: [{ itemId: 'plan_alpha', baseRevision: 1, nextRevision: 2 }] };
  const change = planMutationChange([updated], mutation);

  const first = await adminSync(env, change);
  const retry = await adminSync(env, change);
  assert.equal(first.response.status, 200);
  assert.equal(retry.response.status, 200);
  assert.equal(savedPlan(database).length, 1);
  assert.equal(savedPlan(database)[0].revision, 2);
  assert.equal(savedPlan(database)[0].title, '확정 수정');

  const staleDivergent = await adminSync(env, planMutationChange([
    planItem('plan_alpha', { title: '충돌 수정', revision: 2 })
  ], { id: 'mut_stale_divergent', items: [{ itemId: 'plan_alpha', baseRevision: 1, nextRevision: 2 }] }));
  assert.equal(staleDivergent.response.status, 409);
  assert.equal(staleDivergent.data.code, 'learning_plan_revision_conflict');
  database.close();
});

test('lpplan incoming snapshot에서 빠진 기존 항목은 삭제하지 않는다', async () => {
  const { database, env } = await createHarness();
  seedPlan(database, [planItem('plan_alpha'), planItem('plan_beta')]);
  const result = await adminSync(env, planMutationChange([
    planItem('plan_alpha', { title: '알파만 전송', revision: 2 })
  ], { id: 'mut_missing_preserve', items: [{ itemId: 'plan_alpha', baseRevision: 1, nextRevision: 2 }] }));

  assert.equal(result.response.status, 200);
  const byId = new Map(savedPlan(database).map(item => [item.itemId, item]));
  assert.equal(byId.size, 2);
  assert.equal(byId.get('plan_alpha').title, '알파만 전송');
  assert.equal(byId.get('plan_beta').revision, 1);
  database.close();
});

test('lpplan verbose 기본값과 compact 항목은 같은 revision에서 의미상 동일하다', async () => {
  const { database, env } = await createHarness();
  const compact = planItem('plan_alpha');
  seedPlan(database, [compact]);
  const verbose = Object.assign({}, compact, {
    planId: stablePlannerId('daily', compact.studentCode, compact.date),
    detail: '',
    providerId: '',
    minutes: 0,
    priority: 1,
    verificationRequired: true,
    evidenceRefs: [],
    verificationEvidenceRefs: [],
    updatedAt: compact.createdAt,
    updatedBy: compact.createdBy,
    history: [{
      action: 'created', fromStatus: '', toStatus: compact.status,
      at: compact.createdAt, actor: compact.createdBy
    }],
    historyRetention: {
      maxEntries: 30, droppedCount: 0,
      oldestRetainedAt: compact.createdAt, newestRetainedAt: compact.createdAt
    }
  });
  const result = await adminSync(env, planMutationChange([verbose], {
    id: 'mut_semantic_equal', items: []
  }));

  assert.equal(result.response.status, 200);
  assert.equal(savedPlan(database)[0].revision, 1);
  assert.equal(savedPlan(database)[0].title, compact.title);
  database.close();
});

test('lpclaim은 병합된 lpplan의 최신 date revision status만 허용한다', async () => {
  const { database, env } = await createHarness();
  seedPlan(database, [planItem('plan_alpha')]);
  const moved = planItem('plan_alpha', {
    date: '2026-08-04', status: 'in_progress', revision: 2
  });
  const merged = await adminSync(env, planMutationChange([moved], {
    id: 'mut_claim_move', items: [{ itemId: 'plan_alpha', baseRevision: 1, nextRevision: 2 }]
  }));
  assert.equal(merged.response.status, 200);

  const claim = (date, expectedRevision, updatedAt) => ({
    table: 'checks', k: '__lpclaim__A|all', owner: 'A', updated_at: updatedAt,
    data: {
      taskId: '__lpclaim__A', date: 'all', done: true, updatedAt,
      value: { claims: [{
        itemId: 'plan_alpha', date, expectedRevision,
        claimedAt: new Date(updatedAt - 1).toISOString()
      }] }
    }
  });
  const staleDate = await adminSync(env, claim('2026-08-03', 2, Date.now()));
  const staleRevision = await adminSync(env, claim('2026-08-04', 1, Date.now() + 1));
  const current = await adminSync(env, claim('2026-08-04', 2, Date.now() + 2));
  assert.equal(staleDate.response.status, 422);
  assert.equal(staleRevision.response.status, 422);
  assert.equal(current.response.status, 200);

  const terminal = planItem('plan_alpha', {
    date: '2026-08-04', status: 'completed', revision: 3
  });
  const completed = await adminSync(env, planMutationChange([terminal], {
    id: 'mut_claim_terminal', items: [{ itemId: 'plan_alpha', baseRevision: 2, nextRevision: 3 }]
  }));
  assert.equal(completed.response.status, 200);
  const terminalClaim = await adminSync(env, claim('2026-08-04', 3, Date.now() + 3));
  assert.equal(terminalClaim.response.status, 422);
  assert.equal(terminalClaim.data.details[0].code, 'invalid_learning_claim');
  database.close();
});

test('lpplan 신규·마이그레이션 항목은 baseRevision 0에서 기존 revision을 보존한다', async () => {
  const { database, env } = await createHarness();
  const migrated = planItem('plan_alpha', { title: '마이그레이션 이력', revision: 7 });
  const result = await adminSync(env, planMutationChange([migrated], {
    id: 'mut_migrated_initial', items: [{ itemId: 'plan_alpha', baseRevision: 0, nextRevision: 7 }]
  }));
  assert.equal(result.response.status, 200);
  assert.equal(savedPlan(database)[0].revision, 7);
  database.close();
});


test('같은 배치의 lpclaim은 입력 순서와 무관하게 병합된 lpplan을 검증한다', async () => {
  const { database, env } = await createHarness();
  seedPlan(database, [planItem('plan_alpha')]);
  const now = Date.now();
  const moved = planMutationChange([
    planItem('plan_alpha', { date: '2026-08-04', status: 'in_progress', revision: 2 })
  ], { id: 'mut_batch_claim_move', items: [{ itemId: 'plan_alpha', baseRevision: 1, nextRevision: 2 }] }, now);
  const claim = {
    table: 'checks', k: '__lpclaim__A|all', owner: 'A', updated_at: now,
    data: {
      taskId: '__lpclaim__A', date: 'all', done: true, updatedAt: now,
      value: { claims: [{
        itemId: 'plan_alpha', date: '2026-08-04', expectedRevision: 2,
        claimedAt: new Date(now - 1).toISOString()
      }] }
    }
  };
  const accepted = await call(env, '/sync', {
    app: 'consult', auth: { mode: 'admin', secret: 'consult-admin' }, since: 0,
    changes: [claim, moved]
  });
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.data.accepted, 2);
  const savedClaim = JSON.parse(database.prepare(
    "SELECT data FROM checks WHERE app='consult' AND k='__lpclaim__A|all'"
  ).get().data).value.claims[0];
  assert.equal(savedClaim.date, '2026-08-04');
  assert.equal(savedClaim.expectedRevision, 2);

  const terminal = planMutationChange([
    planItem('plan_alpha', { date: '2026-08-04', status: 'completed', revision: 3 })
  ], { id: 'mut_batch_claim_terminal', items: [{ itemId: 'plan_alpha', baseRevision: 2, nextRevision: 3 }] }, now + 1);
  const rejected = await call(env, '/sync', {
    app: 'consult', auth: { mode: 'admin', secret: 'consult-admin' }, since: 0,
    changes: [claim, terminal]
  });
  assert.equal(rejected.response.status, 422);
  assert.equal(rejected.data.details[0].code, 'invalid_learning_claim');
  assert.equal(savedPlan(database)[0].revision, 2, '검증 실패 배치는 lpplan도 일부 저장하면 안 된다');
  assert.equal(savedPlan(database)[0].status, 'in_progress');
  database.close();
});


test('lpplan 같은 revision의 보존 필드 차이는 compact 기본값으로 숨기지 않는다', async () => {
  const { database, env } = await createHarness();
  seedPlan(database, [planItem('plan_alpha', { audit: { note: '', refs: [] } })]);
  const divergent = planItem('plan_alpha', { audit: { note: '', refs: ['evidence-1'] } });
  const result = await adminSync(env, planMutationChange([divergent], {
    id: 'mut_nested_audit_divergent', items: []
  }));
  assert.equal(result.response.status, 409);
  assert.equal(result.data.code, 'learning_plan_revision_conflict');
  assert.deepEqual(savedPlan(database)[0].audit, { note: '', refs: [] });
  database.close();
});

test('consult managed learning rows reject nested foreign student codes atomically', async () => {
  const { database, env } = await createHarness();
  const now = Date.now();
  const variants = [
    ['lp', { platformState: { programStates: [{ history: [{ student_code: 'B' }] }] } }],
    ['lpcore', { value: { programStates: [{ latestSnapshot: { studentCode: 'B' } }] } }],
    ['lpplan', { value: [Object.assign(planItem('plan_scope'), { history: [{ student_code: 'B' }] })] }],
    ['lpassess', { value: { schedules: [], occurrences: [{ studentCode: 'B' }] } }],
    ['lpcampaign', { value: [{ student_code: 'B' }] }],
    ['lpwrong', { value: [{ attempts: [{ studentCode: 'B' }] }] }],
    ['lpimport', { value: { history: [{ student_code: 'B' }], keys: [] } }]
  ];
  for (let index = 0; index < variants.length; index += 1) {
    const [kind, payload] = variants[index];
    const taskId = '__' + kind + '__A';
    const result = await call(env, '/sync', {
      app: 'consult', auth: { mode: 'admin', secret: 'consult-admin' }, since: 0,
      changes: [{
        table: 'checks', k: taskId + '|all', owner: 'A', updated_at: now + index,
        data: Object.assign({ taskId, date: 'all', done: true, updatedAt: now + index }, payload)
      }]
    });
    assert.equal(result.response.status, 422, kind);
    assert.equal(result.data.details[0].code, 'learning_student_mismatch', kind);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM checks WHERE app=? AND k=?').get('consult', taskId + '|all').n, 0, kind);
  }
  const accepted = await call(env, '/sync', {
    app: 'consult', auth: { mode: 'admin', secret: 'consult-admin' }, since: 0,
    changes: [{
      table: 'checks', k: '__lpcore__A|all', owner: 'A', updated_at: now + 20,
      data: {
        taskId: '__lpcore__A', date: 'all', done: true, updatedAt: now + 20,
        value: { programStates: [{ studentCode: 'A', history: [{ student_code: 'A' }, {}] }] }
      }
    }]
  });
  assert.equal(accepted.response.status, 200);
  database.close();
});
