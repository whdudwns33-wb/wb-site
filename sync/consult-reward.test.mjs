import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import worker from './worker-core.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const workerSource = fs.readFileSync(new URL('./worker-core.js', import.meta.url), 'utf8');
const migration061 = fs.readFileSync(
  new URL('./migrations/061_consult_reward_processing_guard.sql', import.meta.url), 'utf8'
);
const LEGACY_ADMIN = { mode: 'admin', secret: 'consult-secret' };
const TASK_ADMIN = { mode: 'admin', secret: 'task-secret' };
const DEVICE_A_TOKEN = 'a'.repeat(48);
const DEVICE_B_TOKEN = 'b'.repeat(48);
const DEVICE_A = { mode: 'admin_device', token: DEVICE_A_TOKEN };
const DEVICE_B = { mode: 'admin_device', token: DEVICE_B_TOKEN };
const STUDENT_ID = 'student-a';
const REQUEST_A = 'request_12345678';
const REQUEST_B = 'request_87654321';
const TAKEOVER_MS = 30 * 60 * 1000;

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
    this.database.exec(schema);
  }
  prepare(sql) { return new Statement(this.database, sql); }
  async batch(statements) {
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

function environment(db) {
  return { DB: db, CONSULT_ADMIN_SECRET: 'consult-secret', TASK_ADMIN_SECRET: 'task-secret' };
}

function seedStaff(db, id, overrides = {}, app = 'consult') {
  const stamp = Date.now() - 1000;
  const data = { id, name: id, deleted: false, owner: false, manager: false, ...overrides };
  db.prepare('INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind(app, id, id, JSON.stringify(data), stamp, stamp).run();
}

function seedToken(db, token, staffId, app = 'consult') {
  db.prepare('INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)')
    .bind(app, token, staffId, Date.now()).run();
}

function seedDirectorDevices(db) {
  seedToken(db, DEVICE_A_TOKEN, '__admin__');
  seedToken(db, DEVICE_B_TOKEN, '__admin__');
}

function requestItem(id, overrides = {}) {
  return { id, status: 'requested', requestedAt: Date.now() - 250, cancelledAt: 0, ...overrides };
}

function seedPointRequests(db, staffId, requests) {
  const stamp = Date.now() - 500;
  const taskId = '__pointrequest__' + staffId;
  const data = { taskId, date: 'all', requests, done: true, updatedAt: stamp };
  db.prepare('INSERT INTO checks(app,k,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('consult', taskId + '|all', staffId, JSON.stringify(data), stamp, stamp).run();
}

function seedStudent(db, requests = [requestItem(REQUEST_A)]) {
  seedStaff(db, STUDENT_ID);
  seedDirectorDevices(db);
  seedPointRequests(db, STUDENT_ID, requests);
}

function rewardKey(staffId = STUDENT_ID, requestId = REQUEST_A) {
  return '__rewardtx__' + staffId + '|' + requestId;
}

function checkRow(db, key, app = 'consult') {
  return db.prepare('SELECT owner,data,updated_at,srv_at FROM checks WHERE app=? AND k=? LIMIT 1')
    .bind(app, key).first();
}

function rewardData(db, requestId = REQUEST_A) {
  const row = checkRow(db, rewardKey(STUDENT_ID, requestId));
  return row ? JSON.parse(row.data) : null;
}

function storedStaff(db, id = STUDENT_ID, app = 'consult') {
  const row = db.prepare('SELECT data FROM staff WHERE app=? AND id=? LIMIT 1').bind(app, id).first();
  return row ? JSON.parse(row.data) : null;
}

function processingRows(db) {
  return db.database.prepare(
    "SELECT k,data FROM checks WHERE app='consult' AND k GLOB '__rewardtx__*' " +
    "AND json_extract(data,'$.status')='processing'"
  ).all();
}

async function post(db, path, body, app = 'consult') {
  const response = await worker.fetch(new Request('https://worker.example' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app, ...body })
  }), environment(db));
  return { status: response.status, body: await response.json() };
}

async function action(db, name, requestId = REQUEST_A, auth = DEVICE_A) {
  return post(db, '/consult-reward', { auth, action: name, staffId: STUDENT_ID, requestId });
}

function makeStale(db, requestId = REQUEST_A) {
  const row = checkRow(db, rewardKey(STUDENT_ID, requestId));
  const data = JSON.parse(row.data);
  const stamp = Date.now() - TAKEOVER_MS - 1000;
  data.updatedAt = stamp;
  db.prepare('UPDATE checks SET data=?,updated_at=?,srv_at=? WHERE app=? AND k=?')
    .bind(JSON.stringify(data), stamp, stamp, 'consult', rewardKey(STUDENT_ID, requestId)).run();
}

test('migration 061 is additive, executable, and mirrored by the fresh schema', () => {
  assert.doesNotMatch(migration061, /\bDROP\b|DELETE\s+FROM/i);
  for (const trigger of [
    'trg_consult_reward_staff_update_guard',
    'trg_consult_reward_staff_delete_guard'
  ]) {
    assert.match(migration061, new RegExp(trigger));
    assert.match(schema, new RegExp(trigger));
  }
  assert.match(migration061, /RAISE\(ABORT, 'REWARD_PROCESSING_LOCK'\)/);
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE staff(app TEXT NOT NULL,id TEXT NOT NULL,owner TEXT,data TEXT NOT NULL,
      updated_at INTEGER NOT NULL,srv_at INTEGER NOT NULL,PRIMARY KEY(app,id));
    CREATE TABLE checks(app TEXT NOT NULL,k TEXT NOT NULL,owner TEXT,data TEXT NOT NULL,
      updated_at INTEGER NOT NULL,srv_at INTEGER NOT NULL,PRIMARY KEY(app,k));
  `);
  database.exec(migration061);
  const triggers = database.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_consult_reward_staff_%' ORDER BY name"
  ).all();
  assert.deepEqual(triggers.map(row => row.name), [
    'trg_consult_reward_staff_delete_guard',
    'trg_consult_reward_staff_update_guard'
  ]);
});

test('reward ownership is a stable admin-device actor and same-device retry enters recovery without a raw secret', async () => {
  assert.doesNotMatch(workerSource, /claimToken/);
  const db = new TestD1();
  seedStudent(db);

  let result = await action(db, 'claim', REQUEST_A, LEGACY_ADMIN);
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'ADMIN_DEVICE_REQUIRED');

  result = await action(db, 'claim', REQUEST_A, DEVICE_A);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.status, 'processing');
  assert.equal(result.body.claimed, true);
  assert.equal(result.body.owned, true);
  assert.equal(result.body.resumed, false);
  assert.equal(Object.hasOwn(result.body, 'claimActorHash'), false);
  const stored = rewardData(db);
  assert.match(stored.claimActorHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(stored).includes(DEVICE_A_TOKEN), false);
  assert.equal(JSON.stringify(stored).includes(DEVICE_B_TOKEN), false);

  const afterReload = await action(db, 'claim', REQUEST_A, DEVICE_A);
  assert.equal(afterReload.status, 200);
  assert.equal(afterReload.body.claimed, true);
  assert.equal(afterReload.body.owned, true);
  assert.equal(afterReload.body.resumed, true);
  assert.equal(afterReload.body.updatedAt, result.body.updatedAt);

  const otherDevice = await action(db, 'claim', REQUEST_A, DEVICE_B);
  assert.equal(otherDevice.status, 200);
  assert.equal(otherDevice.body.claimed, false);
  assert.equal(otherDevice.body.owned, false);
  assert.equal(otherDevice.body.resumed, false);
  assert.equal(Object.hasOwn(otherDevice.body, 'claimActorHash'), false);
});

test('two director devices cannot fulfill or cancel each other processing lease', async () => {
  const fulfillDb = new TestD1();
  seedStudent(fulfillDb);
  await action(fulfillDb, 'claim');

  let result = await action(fulfillDb, 'fulfill', REQUEST_A, DEVICE_B);
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'REWARD_NOT_OWNER');
  result = await action(fulfillDb, 'cancel', REQUEST_A, DEVICE_B);
  assert.equal(result.status, 403);
  assert.equal(rewardData(fulfillDb).status, 'processing');

  result = await action(fulfillDb, 'fulfill', REQUEST_A, DEVICE_A);
  assert.equal(result.status, 200);
  assert.equal(result.body.changed, true);
  assert.equal(result.body.owned, true);
  assert.equal(rewardData(fulfillDb).status, 'fulfilled');
  assert.equal((await action(fulfillDb, 'fulfill', REQUEST_A, DEVICE_A)).body.changed, false);
  assert.equal((await action(fulfillDb, 'cancel', REQUEST_A, DEVICE_A)).status, 409);

  const cancelDb = new TestD1();
  seedStudent(cancelDb);
  await action(cancelDb, 'claim');
  result = await action(cancelDb, 'cancel', REQUEST_A, DEVICE_A);
  assert.equal(result.status, 200);
  assert.equal(result.body.changed, true);
  assert.equal(rewardData(cancelDb).status, 'cancelled');
  assert.equal((await action(cancelDb, 'cancel', REQUEST_A, DEVICE_A)).body.changed, false);
  assert.equal((await action(cancelDb, 'fulfill', REQUEST_A, DEVICE_A)).status, 409);
});

test('takeover is blocked before 30 minutes and transfers terminal authority after staleness', async () => {
  const db = new TestD1();
  seedStudent(db);
  await action(db, 'claim', REQUEST_A, DEVICE_A);

  let result = await action(db, 'takeover', REQUEST_A, DEVICE_B);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'REWARD_TAKEOVER_NOT_READY');
  assert.ok(result.body.availableAt > Date.now());
  assert.equal((await action(db, 'fulfill', REQUEST_A, DEVICE_B)).status, 403);

  makeStale(db);
  result = await action(db, 'takeover', REQUEST_A, DEVICE_B);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.changed, true);
  assert.equal(result.body.owned, true);
  assert.ok(result.body.takenOverAt > 0);
  assert.equal(rewardData(db).takenOverAt, result.body.takenOverAt);
  assert.equal((await action(db, 'cancel', REQUEST_A, DEVICE_A)).status, 403);

  const recovered = await action(db, 'claim', REQUEST_A, DEVICE_B);
  assert.equal(recovered.body.claimed, true);
  assert.equal(recovered.body.owned, true);
  assert.equal(recovered.body.resumed, true);
  assert.equal(recovered.body.takenOverAt, result.body.takenOverAt);
  const fulfilled = await action(db, 'fulfill', REQUEST_A, DEVICE_B);
  assert.equal(fulfilled.status, 200);
  assert.equal(fulfilled.body.status, 'fulfilled');
});

test('one student can have only one processing request even when different request ids race', async () => {
  const db = new TestD1();
  seedStudent(db, [requestItem(REQUEST_A), requestItem(REQUEST_B)]);
  const results = await Promise.all([
    action(db, 'claim', REQUEST_A, DEVICE_A),
    action(db, 'claim', REQUEST_B, DEVICE_B)
  ]);
  assert.deepEqual(results.map(item => item.status).sort(), [200, 409]);
  assert.equal(processingRows(db).length, 1);
  assert.equal(results.find(item => item.status === 409).body.code, 'REWARD_ALREADY_PROCESSING');

  const winnerRequest = results[0].status === 200 ? REQUEST_A : REQUEST_B;
  const winnerDevice = winnerRequest === REQUEST_A ? DEVICE_A : DEVICE_B;
  const loserRequest = winnerRequest === REQUEST_A ? REQUEST_B : REQUEST_A;
  await action(db, 'cancel', winnerRequest, winnerDevice);
  const next = await action(db, 'claim', loserRequest, winnerRequest === REQUEST_A ? DEVICE_B : DEVICE_A);
  assert.equal(next.status, 200);
  assert.equal(next.body.owned, true);
  assert.equal(processingRows(db).length, 1);
});

test('director device may reject pending without spending points but cannot reverse processing or fulfilled', async () => {
  const db = new TestD1();
  seedStudent(db);
  let result = await action(db, 'reject', REQUEST_A, DEVICE_A);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.status, 'cancelled');
  assert.equal(result.body.changed, true);
  const stored = rewardData(db);
  assert.equal(stored.status, 'cancelled');
  assert.equal(stored.fulfilledAt, undefined);
  assert.ok(stored.rejectedAt > 0);

  result = await action(db, 'reject', REQUEST_A, DEVICE_B);
  assert.equal(result.status, 200);
  assert.equal(result.body.changed, false);
  result = await action(db, 'claim', REQUEST_A, DEVICE_A);
  assert.equal(result.body.status, 'cancelled');
  assert.equal(result.body.claimed, false);

  const processingDb = new TestD1();
  seedStudent(processingDb);
  await action(processingDb, 'claim');
  assert.equal((await action(processingDb, 'reject', REQUEST_A, DEVICE_A)).status, 409);
  await action(processingDb, 'fulfill');
  assert.equal((await action(processingDb, 'reject', REQUEST_A, DEVICE_A)).status, 409);
});

test('new ledgers require canonical active students while an existing lease stays terminally actionable', async () => {
  for (const request of [
    null,
    requestItem(REQUEST_A, { status: 'cancelled', cancelledAt: Date.now() }),
    requestItem(REQUEST_A, { requestedAt: 0 }),
    requestItem(REQUEST_A, { cancelledAt: Date.now() })
  ]) {
    const db = new TestD1();
    seedStaff(db, STUDENT_ID);
    seedDirectorDevices(db);
    if (request) seedPointRequests(db, STUDENT_ID, [request]);
    assert.equal((await action(db, 'claim')).status, 409);
    assert.equal(rewardData(db), null);
  }

  for (const flags of [{ deleted: true }, { owner: true }, { manager: true }, { id: 'wrong-id' }]) {
    const db = new TestD1();
    seedStaff(db, STUDENT_ID, flags);
    seedDirectorDevices(db);
    seedPointRequests(db, STUDENT_ID, [requestItem(REQUEST_A)]);
    assert.equal((await action(db, 'claim')).status, 404);
  }

  const db = new TestD1();
  seedStudent(db);
  await action(db, 'claim');
  assert.throws(() => db.prepare("DELETE FROM staff WHERE app='consult' AND id=?").bind(STUDENT_ID).run(),
    /REWARD_PROCESSING_LOCK/);
  assert.equal((await action(db, 'claim')).body.owned, true);
  assert.equal((await action(db, 'cancel')).status, 200);

  // 과거 데이터에서 학생 행만 이미 사라진 processing 원장은 활성 학생 검사를 다시 요구하지 않고 종결한다.
  const orphanDb = new TestD1();
  seedStudent(orphanDb);
  await action(orphanDb, 'claim');
  const orphanRow = checkRow(orphanDb, rewardKey());
  orphanDb.prepare("DELETE FROM checks WHERE app='consult' AND k=?").bind(rewardKey()).run();
  orphanDb.prepare("DELETE FROM staff WHERE app='consult' AND id=?").bind(STUDENT_ID).run();
  orphanDb.prepare('INSERT INTO checks(app,k,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('consult', rewardKey(), STUDENT_ID, orphanRow.data, orphanRow.updated_at, orphanRow.srv_at).run();
  assert.equal((await action(orphanDb, 'claim')).body.owned, true);
  assert.equal((await action(orphanDb, 'cancel')).body.status, 'cancelled');

  for (const requestId of ['short', 'unsafe.request', 'x'.repeat(129)]) {
    assert.equal((await action(db, 'claim', requestId)).status, 400);
  }
});

test('generic sync hides actor identity and cannot create or overwrite reward ledgers', async () => {
  const db = new TestD1();
  seedStudent(db);
  seedToken(db, 'student-token', STUDENT_ID);
  await action(db, 'claim');
  const original = rewardData(db);
  const forged = { ...original, status: 'fulfilled', updatedAt: Date.now() + 100000 };

  let result = await post(db, '/sync', {
    auth: { mode: 'person', id: STUDENT_ID, token: 'student-token' }, since: 0,
    changes: [{ table: 'checks', k: rewardKey(), owner: STUDENT_ID, data: forged, updated_at: forged.updatedAt }]
  });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'REWARD_TX_ENDPOINT_REQUIRED');
  assert.deepEqual(rewardData(db), original);

  result = await post(db, '/sync', {
    auth: LEGACY_ADMIN, since: 0,
    changes: [
      { table: 'checks', k: rewardKey(), owner: STUDENT_ID, data: forged, updated_at: forged.updatedAt },
      { table: 'checks', k: rewardKey(STUDENT_ID, REQUEST_B), owner: STUDENT_ID,
        data: { ...forged, requestId: REQUEST_B }, updated_at: forged.updatedAt }
    ]
  });
  assert.equal(result.status, 200);
  assert.deepEqual(rewardData(db), original);
  assert.equal(rewardData(db, REQUEST_B), null);
  const pulled = result.body.changes.find(change => change.key === rewardKey());
  assert.ok(pulled);
  assert.equal(Object.hasOwn(pulled.data, 'claimActorHash'), false);
  assert.equal(JSON.stringify(result.body).includes(original.claimActorHash), false);
});

test('generic consult staff writes cannot hide a processing reward entry, but terminal rows release the lock', async () => {
  const db = new TestD1();
  seedStudent(db);
  await action(db, 'claim', REQUEST_A, DEVICE_A);
  const original = storedStaff(db);
  for (const patch of [{ deleted: true }, { owner: true }, { manager: true }]) {
    const changed = { ...original, ...patch, updatedAt: Date.now() + 1000 };
    const result = await post(db, '/sync', {
      auth: DEVICE_B, since: 0,
      changes: [{ table: 'staff', id: STUDENT_ID, owner: STUDENT_ID,
        data: changed, updated_at: changed.updatedAt }]
    });
    assert.equal(result.status, 409, JSON.stringify(patch));
    assert.equal(result.body.code, 'REWARD_PROCESSING_LOCK');
    assert.deepEqual(result.body.conflictStaffIds, [STUDENT_ID]);
    assert.equal(result.body.authoritativeStaff.length, 1);
    assert.equal(result.body.authoritativeStaff[0].authoritative, true);
    assert.deepEqual(result.body.authoritativeStaff[0].data, original);
    assert.equal(result.body.authoritativeRewardChecks.length, 1);
    assert.equal(result.body.authoritativeRewardChecks[0].authoritative, true);
    assert.equal(result.body.authoritativeRewardChecks[0].data.status, 'processing');
    assert.equal(Object.hasOwn(result.body.authoritativeRewardChecks[0].data, 'claimActorHash'), false);
    assert.deepEqual(storedStaff(db), original);
  }

  await action(db, 'cancel', REQUEST_A, DEVICE_A);
  const deleted = { ...original, deleted: true, updatedAt: Date.now() + 2000 };
  let result = await post(db, '/sync', {
    auth: DEVICE_B, since: 0,
    changes: [{ table: 'staff', id: STUDENT_ID, owner: STUDENT_ID,
      data: deleted, updated_at: deleted.updatedAt }]
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(storedStaff(db).deleted, true);

  const fulfilledDb = new TestD1();
  seedStudent(fulfilledDb);
  await action(fulfilledDb, 'claim', REQUEST_A, DEVICE_A);
  await action(fulfilledDb, 'fulfill', REQUEST_A, DEVICE_A);
  const manager = { ...storedStaff(fulfilledDb), manager: true, updatedAt: Date.now() + 2000 };
  result = await post(fulfilledDb, '/sync', {
    auth: DEVICE_B, since: 0,
    changes: [{ table: 'staff', id: STUDENT_ID, owner: STUDENT_ID,
      data: manager, updated_at: manager.updatedAt }]
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(storedStaff(fulfilledDb).manager, true);
});

test('a claim committed after the sync precheck is still mapped to a 409 with canonical recovery rows', async () => {
  const db = new TestD1();
  seedStudent(db);
  const original = storedStaff(db);
  const baseBatch = db.batch.bind(db);
  let injected = false;
  db.batch = async statements => {
    if (!injected) {
      injected = true;
      const stamp = Date.now();
      const data = {
        kind: 'consult_reward_redemption', version: 1, ledgerVersion: 'v1',
        staffId: STUDENT_ID, requestId: REQUEST_A, status: 'processing',
        claimActorHash: 'sha256:' + '0'.repeat(64), claimedAt: stamp, updatedAt: stamp
      };
      db.prepare('INSERT INTO checks(app,k,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
        .bind('consult', rewardKey(), STUDENT_ID, JSON.stringify(data), stamp, stamp).run();
    }
    return baseBatch(statements);
  };

  const changed = { ...original, deleted: true, updatedAt: Date.now() + 1000 };
  const result = await post(db, '/sync', {
    auth: DEVICE_B, since: 0,
    changes: [{ table: 'staff', id: STUDENT_ID, owner: STUDENT_ID,
      data: changed, updated_at: changed.updatedAt }]
  });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.code, 'REWARD_PROCESSING_LOCK');
  assert.deepEqual(result.body.conflictStaffIds, [STUDENT_ID]);
  assert.deepEqual(result.body.authoritativeStaff[0].data, original);
  assert.equal(result.body.authoritativeRewardChecks[0].data.status, 'processing');
  assert.equal(Object.hasOwn(result.body.authoritativeRewardChecks[0].data, 'claimActorHash'), false);
  assert.deepEqual(storedStaff(db), original);
});

test('D1 reward guard atomically blocks direct staff update/delete and releases after terminal status', async () => {
  const db = new TestD1();
  seedStudent(db);
  await action(db, 'claim', REQUEST_A, DEVICE_A);
  const original = storedStaff(db);

  for (const patch of [{ deleted: true }, { owner: true }, { manager: true }]) {
    const changed = { ...original, ...patch, updatedAt: Date.now() + 1000 };
    assert.throws(() => db.prepare(
      "UPDATE staff SET data=?,updated_at=?,srv_at=? WHERE app='consult' AND id=?"
    ).bind(JSON.stringify(changed), changed.updatedAt, changed.updatedAt, STUDENT_ID).run(),
    /REWARD_PROCESSING_LOCK/, JSON.stringify(patch));
    assert.deepEqual(storedStaff(db), original, JSON.stringify(patch));
  }
  assert.throws(() => db.prepare("DELETE FROM staff WHERE app='consult' AND id=?")
    .bind(STUDENT_ID).run(), /REWARD_PROCESSING_LOCK/);
  assert.deepEqual(storedStaff(db), original);

  await action(db, 'cancel', REQUEST_A, DEVICE_A);
  const deleted = { ...original, deleted: true, updatedAt: Date.now() + 2000 };
  db.prepare("UPDATE staff SET data=?,updated_at=?,srv_at=? WHERE app='consult' AND id=?")
    .bind(JSON.stringify(deleted), deleted.updatedAt, deleted.updatedAt, STUDENT_ID).run();
  assert.equal(storedStaff(db).deleted, true);
  db.prepare("DELETE FROM staff WHERE app='consult' AND id=?").bind(STUDENT_ID).run();
  assert.equal(storedStaff(db), null);
});

test('strict payload, consult-only routing, and normal consult/task sync remain compatible', async () => {
  const db = new TestD1();
  seedStudent(db);
  seedToken(db, 'student-token', STUDENT_ID);
  let result = await post(db, '/consult-reward', {
    auth: DEVICE_A, action: 'claim', staffId: STUDENT_ID, requestId: REQUEST_A,
    giftUrl: 'https://gift.example/private'
  });
  assert.equal(result.status, 400);
  assert.equal(rewardData(db), null);
  result = await action(db, 'claim', REQUEST_A, { mode: 'person', id: STUDENT_ID, token: 'student-token' });
  assert.equal(result.status, 403);
  result = await post(db, '/consult-reward', {
    auth: TASK_ADMIN, action: 'claim', staffId: STUDENT_ID, requestId: REQUEST_A
  }, 'task');
  assert.equal(result.status, 400);

  const consultKey = '__dailyclose__' + STUDENT_ID + '|2026-09-01';
  result = await post(db, '/sync', {
    auth: { mode: 'person', id: STUDENT_ID, token: 'student-token' }, since: 0,
    changes: [{ table: 'checks', k: consultKey, owner: STUDENT_ID,
      data: { taskId: '__dailyclose__' + STUDENT_ID, date: '2026-09-01', done: true },
      updated_at: Date.now() }]
  });
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(checkRow(db, consultKey).data).done, true);

  const taskDb = new TestD1();
  seedStaff(taskDb, 'teacher-a', {}, 'task');
  seedToken(taskDb, 'teacher-token', 'teacher-a', 'task');
  const taskKey = '__att__teacher-a|2026-09-01';
  result = await post(taskDb, '/sync', {
    auth: { mode: 'person', id: 'teacher-a', token: 'teacher-token' }, since: 0,
    changes: [{ table: 'checks', k: taskKey, owner: 'teacher-a',
      data: { taskId: '__att__teacher-a', date: '2026-09-01', done: true }, updated_at: Date.now() }]
  }, 'task');
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(checkRow(taskDb, taskKey, 'task').data).done, true);
});
