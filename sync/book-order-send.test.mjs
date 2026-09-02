import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

import worker from './worker-core.js';
import {
  handleScheduledBookOrders,
  handleScheduledBookOrderStatusRefresh,
  isRetryCronWindow
} from './book-order-send.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/013_book_order_sends.sql', import.meta.url), 'utf8');
const batchMigration = fs.readFileSync(new URL('./migrations/018_book_order_batch_items.sql', import.meta.url), 'utf8');
const lockMigration = fs.readFileSync(new URL('./migrations/020_book_order_dispatch_lock.sql', import.meta.url), 'utf8');
const entry = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('./wrangler.toml', import.meta.url), 'utf8');

class D1Statement {
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
  constructor() { this.database = new DatabaseSync(':memory:'); this.database.exec(schema); }
  prepare(sql) { return new D1Statement(this.database, sql); }
  batch(statements) {
    this.database.exec('BEGIN');
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

const admin = { mode: 'admin', secret: 'director-secret' };
const person = (id, token) => ({ mode: 'person', id, token });

const fullEnvBase = {
  TASK_ADMIN_SECRET: 'director-secret',
  CONSULT_ADMIN_SECRET: 'consult-secret',
  WB_BOOK_ORDER_SEND_ENABLED: 'true',
  SOLAPI_API_KEY: 'test-key',
  SOLAPI_API_SECRET: 'test-secret',
  SOLAPI_SENDER_NUMBER: '0212345678',
  BOOK_VENDOR_PHONES: JSON.stringify({ '천재출판사': '01099998888' })
};

const sampleEnvBase = {
  WB_SEND_MODE: 'test',
  WB_TEST_RECIPIENT_ID: 'TEST-SMS-001',
  WB_ACTUAL_TEST_SEND_APPROVED: 'true',
  WB_BOOK_ORDER_SAMPLE_ENABLED: 'true',
  SOLAPI_TEST_RECIPIENT_PHONE: '01011112222'
};

function acceptedPayload(index = 1) {
  return {
    groupInfo: { groupId: 'GROUP_' + index },
    messageList: [{ messageId: 'MSG_' + index, statusCode: '2000' }]
  };
}

function acceptedResponse(index = 1) {
  return new Response(JSON.stringify(acceptedPayload(index)), {
    status: 200, headers: { 'content-type': 'application/json' }
  });
}

async function withFetch(stub, action) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await action(); } finally { globalThis.fetch = original; }
}

async function withNow(value, action) {
  const original = Date.now;
  Date.now = () => value;
  try { return await action(); } finally { Date.now = original; }
}

async function call(db, body, envPatch = {}) {
  const response = await worker.fetch(new Request('https://worker.example/book-order-send', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app: 'task', ...body })
  }), { DB: db, ...fullEnvBase, ...envPatch });
  return { status: response.status, body: await response.json() };
}

const seededStaff = new WeakSet();
function ensureKimStaff(db) {
  if (seededStaff.has(db)) return;
  seededStaff.add(db);
  const now = Date.now();
  db.prepare("INSERT INTO staff (app,id,owner,data,updated_at,srv_at) VALUES ('task','S-kim','S-kim',?,?,?)")
    .bind(JSON.stringify({ id: 'S-kim', name: '김남기', deleted: false }), now, now).run();
  db.prepare("INSERT INTO tokens (app,token,staff_id,created_at,revoked) VALUES ('task','tok-kim','S-kim',?,0)").bind(now).run();
}

function seedOrderTask(db, overrides = {}) {
  ensureKimStaff(db);
  const now = Date.now();
  const task = {
    id: 'order-1', staffId: 'S-kim', title: '[주문] 개념원리 미적분Ⅰ',
    orderVendor: '천재출판사', orderItems: [{ title: '개념원리 미적분Ⅰ', qty: '3권' }],
    orderDelivery: 'scheduled_batch_v1',
    createdAt: now, deleted: false, ...overrides
  };
  db.prepare('INSERT INTO tasks (app,id,owner,data,updated_at,srv_at) VALUES (?,?,?,?,?,?)')
    .bind('task', task.id, task.staffId, JSON.stringify(task), now, now).run();
  return task;
}

function seedMappedSend(db, taskId, sendId, status, itemCount = 1) {
  const now = Date.now() - 1000;
  db.prepare(
    'INSERT INTO book_order_sends ' +
    '(app,send_id,idempotency_key,task_id,vendor_name,item_count,message_hash,status,created_at,updated_at) ' +
    "VALUES ('task',?,?,?,?,?,?,?, ?,?)"
  ).bind(
    sendId, 'key_' + sendId, 'batch_' + sendId, '천재출판사', itemCount,
    'a'.repeat(64), status, now, now
  ).run();
  db.prepare(
    "INSERT INTO book_order_batch_items(app,task_id,send_id,created_at) VALUES('task',?,?,?)"
  ).bind(taskId, sendId, now).run();
}

function seedProviderSend(db, sendId, statusCode, options = {}) {
  const now = Number(options.createdAt) || Date.now() - 1000;
  db.prepare(
    'INSERT INTO book_order_sends ' +
    '(app,send_id,idempotency_key,task_id,vendor_name,item_count,message_hash,status,' +
    'provider_group_id,provider_message_id,provider_status_code,safe_error_code,created_at,updated_at) ' +
    "VALUES ('task',?,?,?,?,1,?,?,?,?,?,?,?,?)"
  ).bind(
    sendId, 'key_' + sendId, 'batch_' + sendId, '천재출판사', 'b'.repeat(64), options.status || 'accepted',
    options.groupId || 'GROUP_' + sendId, options.messageId || 'MSG_' + sendId, statusCode,
    options.safeErrorCode || null, now, now
  ).run();
}

test('schema and migration are additive, and the send ledger itself stores no phone or message body', () => {
  for (const sql of [schema, migration]) {
    const match = sql.match(/CREATE TABLE IF NOT EXISTS book_order_sends\s*\([\s\S]*?\);/);
    assert.ok(match, 'book_order_sends 테이블 정의를 찾을 수 없습니다');
    assert.doesNotMatch(match[0], /phone|message_body/i);
    assert.doesNotMatch(match[0], /DROP TABLE|DELETE FROM/i);
  }
});

test('20:00 KST book cron remains configured with the 23:50 session cutoff cron', () => {
  assert.match(wrangler, /\[triggers\][\s\S]*crons\s*=\s*\["0 11 \* \* \*", "50 14 \* \* \*", "\*\/10 \* \* \* \*"\]/);
  assert.equal((wrangler.match(/"\*\/10 \* \* \* \*"/g) || []).length, 1,
    '교재와 피드백 상태조회는 별도 중복 cron이 아니라 동일한 10분 cron을 공유한다');
  assert.match(entry, /async scheduled\(controller, env, ctx\)/);
  assert.match(entry, /controller\.cron === BOOK_ORDER_CRON/);
  assert.match(entry, /handleScheduledBookOrders\(env, controller\.scheduledTime\)/);
  assert.match(entry, /controller\.cron === BOOK_ORDER_STATUS_CRON/);
  assert.match(entry, /handleScheduledBookOrderStatusRefresh\(env, controller\.scheduledTime\)/);
  assert.match(entry,
    /controller\.cron === BOOK_ORDER_STATUS_CRON[\s\S]*?ctx\.waitUntil\(Promise\.all\(\[\s*handleScheduledBookOrderStatusRefresh\(env, controller\.scheduledTime\),\s*handleScheduledParentFeedbackStatusRefresh\(env, controller\.scheduledTime\)\s*\]\)\)/,
    '같은 10분 cron 분기에서 교재와 피드백 상태조회를 Promise.all로 함께 실행해야 한다');
  assert.match(batchMigration, /CREATE TABLE IF NOT EXISTS book_order_batch_items/);
  assert.doesNotMatch(batchMigration, /phone|message_body|DROP TABLE|DELETE FROM/i);
  for (const sql of [schema, lockMigration]) {
    const definition = sql.match(/CREATE TABLE IF NOT EXISTS book_order_dispatch_lock\s*\([\s\S]*?\);/);
    assert.ok(definition);
    assert.match(definition[0], /PRIMARY KEY \(app\)/);
    assert.match(definition[0], /owner\s+TEXT\s+NOT NULL/);
    assert.match(definition[0], /lease_until\s+INTEGER NOT NULL/);
    assert.doesNotMatch(definition[0], /phone|message_body|DROP TABLE/i);
  }
});

test('scheduled status refresh advances the same provider message from queued to carrier to delivered', async () => {
  const db = new TestD1();
  const now = Date.parse('2026-09-02T03:00:00Z');
  seedProviderSend(db, 'status-progress', '2000', {
    createdAt: now - 60_000, groupId: 'GROUP_STATUS', messageId: 'MSG_STATUS'
  });
  const requested = [];
  await withFetch(async (url, options) => {
    requested.push({ url: String(url), options });
    const statusCode = requested.length === 1 ? '3000' : '4000';
    return new Response(JSON.stringify({ messageList: {
      MSG_STATUS: { messageId: 'MSG_STATUS', groupId: 'GROUP_STATUS', statusCode }
    } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }, async () => {
    const carrier = await handleScheduledBookOrderStatusRefresh({ DB: db, ...fullEnvBase }, now);
    assert.equal(carrier.ok, true);
    assert.equal(carrier.checked, 1);
    assert.equal(carrier.updated, 1);
    let row = db.prepare("SELECT status,provider_status_code,safe_error_code FROM book_order_sends WHERE send_id='status-progress'").first();
    assert.deepEqual({ ...row }, { status: 'accepted', provider_status_code: '3000', safe_error_code: null });

    const delivered = await handleScheduledBookOrderStatusRefresh({ DB: db, ...fullEnvBase }, now + 10 * 60_000);
    assert.equal(delivered.ok, true);
    assert.equal(delivered.updated, 1);
    row = db.prepare("SELECT status,provider_status_code,safe_error_code FROM book_order_sends WHERE send_id='status-progress'").first();
    assert.deepEqual({ ...row }, { status: 'accepted', provider_status_code: '4000', safe_error_code: null });
  });
  assert.equal(requested.length, 2);
  for (const request of requested) {
    const url = new URL(request.url);
    assert.equal(url.origin + url.pathname, 'https://api.solapi.com/messages/v4/list');
    assert.deepEqual(JSON.parse(url.searchParams.get('messageIds')), ['MSG_STATUS']);
    assert.equal(request.options.method, 'GET');
    assert.match(request.options.headers.Authorization, /^HMAC-SHA256 /);
  }
});

test('status refresh records terminal failure but skips phone-completed orders and never sends a message', async () => {
  const db = new TestD1();
  const now = Date.parse('2026-09-02T03:00:00Z');
  seedProviderSend(db, 'status-failed', '3000', {
    createdAt: now - 60_000, groupId: 'GROUP_FAILED', messageId: 'MSG_FAILED'
  });
  seedProviderSend(db, 'status-phone', '2000', {
    createdAt: now - 60_000, groupId: 'GROUP_PHONE', messageId: 'MSG_PHONE',
    safeErrorCode: 'MANUAL_PHONE_ORDERED'
  });
  let fetches = 0;
  await withFetch(async (url, options) => {
    fetches += 1;
    assert.equal(options.method, 'GET');
    assert.deepEqual(JSON.parse(new URL(url).searchParams.get('messageIds')), ['MSG_FAILED']);
    return new Response(JSON.stringify({ messageList: {
      MSG_FAILED: { messageId: 'MSG_FAILED', groupId: 'GROUP_FAILED', statusCode: '3010' }
    } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }, async () => {
    const result = await handleScheduledBookOrderStatusRefresh({ DB: db, ...fullEnvBase }, now);
    assert.equal(result.ok, true);
    assert.equal(result.checked, 1);
    assert.equal(result.updated, 1);
  });
  assert.equal(fetches, 1);
  assert.deepEqual(
    { ...db.prepare("SELECT status,provider_status_code,safe_error_code FROM book_order_sends WHERE send_id='status-failed'").first() },
    { status: 'rejected', provider_status_code: '3010', safe_error_code: 'SOLAPI_STATUS_3010' }
  );
  assert.deepEqual(
    { ...db.prepare("SELECT status,provider_status_code,safe_error_code FROM book_order_sends WHERE send_id='status-phone'").first() },
    { status: 'accepted', provider_status_code: '2000', safe_error_code: 'MANUAL_PHONE_ORDERED' }
  );
});

test('stale queued or carrier states become non-retriable confirmation-needed outcomes', async () => {
  const db = new TestD1();
  const now = Date.parse('2026-09-02T03:00:00Z');
  seedProviderSend(db, 'stale-queued', '2000', {
    createdAt: now - 24 * 60 * 60 * 1000, messageId: 'MSG_STALE_QUEUED'
  });
  seedProviderSend(db, 'stale-carrier', '3000', {
    createdAt: now - 72 * 60 * 60 * 1000, groupId: 'GROUP_STALE_CARRIER', messageId: 'MSG_STALE_CARRIER'
  });
  seedProviderSend(db, 'stale-but-delivered', '2000', {
    createdAt: now - 24 * 60 * 60 * 1000, groupId: 'GROUP_STALE_DELIVERED', messageId: 'MSG_STALE_DELIVERED'
  });
  let fetches = 0;
  await withFetch(async () => {
    fetches += 1;
    return new Response(JSON.stringify({ messageList: {
      MSG_STALE_CARRIER: {
        messageId: 'MSG_STALE_CARRIER', groupId: 'GROUP_STALE_CARRIER', statusCode: '3000'
      },
      MSG_STALE_DELIVERED: {
        messageId: 'MSG_STALE_DELIVERED', groupId: 'GROUP_STALE_DELIVERED', statusCode: '4000'
      }
    } }), { status: 200 });
  }, async () => {
    const result = await handleScheduledBookOrderStatusRefresh({ DB: db, ...fullEnvBase }, now);
    assert.equal(result.ok, true);
    assert.equal(result.checked, 3);
    assert.equal(result.updated, 3);
  });
  assert.equal(fetches, 1);
  assert.deepEqual({ ...db.prepare(
    "SELECT status,provider_status_code,safe_error_code FROM book_order_sends WHERE send_id='stale-queued'"
  ).first() }, { status: 'unknown', provider_status_code: '2000', safe_error_code: 'SOLAPI_STATUS_STALE_2000' });
  assert.deepEqual({ ...db.prepare(
    "SELECT status,provider_status_code,safe_error_code FROM book_order_sends WHERE send_id='stale-carrier'"
  ).first() }, { status: 'unknown', provider_status_code: '3000', safe_error_code: 'SOLAPI_STATUS_STALE_3000' });
  assert.deepEqual({ ...db.prepare(
    "SELECT status,provider_status_code,safe_error_code FROM book_order_sends WHERE send_id='stale-but-delivered'"
  ).first() }, { status: 'accepted', provider_status_code: '4000', safe_error_code: null });
});

test('status refresh is monotonic and CAS prevents a delayed poll from overwriting newer state', async () => {
  const db = new TestD1();
  const now = Date.parse('2026-09-02T03:00:00Z');
  seedProviderSend(db, 'no-regression', '3000', {
    createdAt: now - 60_000, groupId: 'GROUP_NO_REGRESSION', messageId: 'MSG_NO_REGRESSION'
  });
  await withFetch(async () => new Response(JSON.stringify({ messageList: {
    MSG_NO_REGRESSION: { messageId: 'MSG_NO_REGRESSION', groupId: 'GROUP_NO_REGRESSION', statusCode: '2000' }
  } }), { status: 200 }), async () => {
    const result = await handleScheduledBookOrderStatusRefresh({ DB: db, ...fullEnvBase }, now);
    assert.equal(result.checked, 1);
    assert.equal(result.updated, 0);
  });
  assert.equal(db.prepare("SELECT provider_status_code FROM book_order_sends WHERE send_id='no-regression'").first().provider_status_code, '3000');

  seedProviderSend(db, 'cas-race', '2000', {
    createdAt: now - 60_000, groupId: 'GROUP_CAS', messageId: 'MSG_CAS'
  });
  const originalPrepare = db.prepare.bind(db);
  let raced = false;
  db.prepare = sql => {
    const statement = originalPrepare(sql);
    if (!raced && String(sql).startsWith('UPDATE book_order_sends SET status=?')) {
      const originalRun = statement.run.bind(statement);
      statement.run = () => {
        raced = true;
        db.database.prepare(
          "UPDATE book_order_sends SET provider_status_code='3000',updated_at=updated_at+1 WHERE send_id='cas-race'"
        ).run();
        return originalRun();
      };
    }
    return statement;
  };
  await withFetch(async url => {
    const ids = JSON.parse(new URL(url).searchParams.get('messageIds'));
    const messageList = {};
    for (const id of ids) messageList[id] = {
      messageId: id,
      groupId: id === 'MSG_CAS' ? 'GROUP_CAS' : 'GROUP_NO_REGRESSION',
      statusCode: id === 'MSG_CAS' ? '4000' : '3000'
    };
    return new Response(JSON.stringify({ messageList }), { status: 200 });
  }, async () => {
    const result = await handleScheduledBookOrderStatusRefresh({ DB: db, ...fullEnvBase }, now + 10 * 60_000);
    assert.equal(raced, true);
    assert.equal(result.updated, 0);
  });
  assert.equal(db.prepare("SELECT provider_status_code FROM book_order_sends WHERE send_id='cas-race'").first().provider_status_code, '3000');
});

test('client cannot specify phone, recipient, or message — request is rejected before any fetch', async () => {
  const db = new TestD1(); seedOrderTask(db);
  let fetches = 0;
  await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
    for (const bad of [{ phone: '01000000000' }, { message: 'hi' }, { to: '010' }, { vendor: 'x' }]) {
      const r = await call(db, { auth: admin, taskId: 'order-1', ...bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
  });
  assert.equal(fetches, 0);
});

test('sample rejects ordinary staff, admin-device auth, and request-controlled recipient, text, or task data', async () => {
  const db = new TestD1(); seedOrderTask(db, { orderDelivery: 'scheduled_batch_v1' });
  let fetches = 0;
  await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
    const staff = await call(db, { auth: person('S-kim', 'tok-kim'), action: 'sample' }, sampleEnvBase);
    assert.equal(staff.status, 403);
    const adminDevice = await call(db, { auth: { mode: 'admin_device', token: 'device-token' }, action: 'sample' }, sampleEnvBase);
    assert.equal(adminDevice.status, 401);
    const withTask = await call(db, { auth: admin, action: 'sample', taskId: 'order-1' }, sampleEnvBase);
    assert.equal(withTask.status, 400);
    for (const bad of [
      { phone: '01000000000' }, { recipient: 'someone' }, { message: 'hi' },
      { to: '01000000000' }, { vendor: '천재출판사' }
    ]) {
      const result = await call(db, { auth: admin, action: 'sample', ...bad }, sampleEnvBase);
      assert.equal(result.status, 400, JSON.stringify(bad));
    }
  });
  assert.equal(fetches, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM book_order_sends').first().count, 0);
});

test('sample requires every explicit test gate and a valid fixed server recipient', async () => {
  const db = new TestD1();
  let fetches = 0;
  await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
    for (const [key, value] of [
      ['WB_SEND_MODE', 'live'],
      ['WB_TEST_RECIPIENT_ID', 'OTHER'],
      ['WB_ACTUAL_TEST_SEND_APPROVED', 'false'],
      ['WB_BOOK_ORDER_SAMPLE_ENABLED', 'false'],
      ['SOLAPI_TEST_RECIPIENT_PHONE', '']
    ]) {
      const result = await call(db, { auth: admin, action: 'sample' }, { ...sampleEnvBase, [key]: value });
      assert.equal(result.status, 503, key);
      assert.equal(result.body.code, 'SAMPLE_SEND_DISABLED', key);
    }
  });
  assert.equal(fetches, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM book_order_sends').first().count, 0);
});

test('root sample uses only the fixed test phone, is daily-idempotent, and never consumes a real order', async () => {
  const db = new TestD1();
  const cutoff = Date.now() + 1000;
  seedOrderTask(db, { orderDelivery: 'scheduled_batch_v1' });
  for (let i = 0; i < 29; i++) {
    db.prepare(
      'INSERT INTO book_order_sends (app,send_id,idempotency_key,task_id,vendor_name,item_count,message_hash,status,created_at,updated_at) ' +
      "VALUES ('task',?,?,?,?,1,?, 'accepted',?,?)"
    ).bind('bos_prior' + i, 'prior-key-' + i, 'prior-task-' + i, '천재출판사', 'a'.repeat(64), cutoff - 1000, cutoff - 1000).run();
  }
  const payloads = [];
  let first;
  let again;
  let scheduled;
  await withFetch(async (url, opts) => {
    payloads.push(JSON.parse(opts.body));
    return acceptedResponse(payloads.length);
  }, async () => {
    const sampleEnv = { ...sampleEnvBase, WB_BOOK_ORDER_SEND_ENABLED: 'false' };
    first = await call(db, { auth: admin, action: 'sample' }, sampleEnv);
    again = await call(db, { auth: person('S-kim', 'tok-kim'), action: 'sample' }, {
      ...sampleEnv, TASK_MANAGER_STAFF_IDS: 'S-kim'
    });
    scheduled = await handleScheduledBookOrders({ DB: db, ...fullEnvBase, ...sampleEnvBase }, cutoff);
  });

  assert.equal(first.status, 200);
  assert.equal(first.body.sample, true);
  assert.equal(first.body.recipientLabel, '원장님 본인');
  assert.equal(Object.hasOwn(first.body, 'vendorName'), false);
  assert.equal(again.body.idempotent, true);
  assert.equal(first.body.send.sendId, again.body.send.sendId);
  assert.equal(again.status, 200, '서버 allowlist manager도 고정 본인 샘플만 요청할 수 있다');
  assert.match(first.body.send.sendId, /^boss_[a-f0-9]{48}$/);
  assert.equal(payloads.length, 2,
    '샘플은 실제 주문 30건 한도와 분리되어 샘플 1회와 30번째 실제 주문이 각각 접수된다');

  const sampleMessage = payloads[0].messages[0];
  assert.equal(sampleMessage.to, sampleEnvBase.SOLAPI_TEST_RECIPIENT_PHONE);
  assert.notEqual(sampleMessage.to, JSON.parse(fullEnvBase.BOOK_VENDOR_PHONES)['천재출판사']);
  assert.match(sampleMessage.text, /^\[테스트 발송 · 실제 주문 아님\]/);
  assert.match(sampleMessage.text, /교재 주문 부탁드립니다/);
  assert.match(sampleMessage.text, /실제 주문 아님/);
  assert.equal(sampleMessage.subject, 'WB 교재 주문');

  const sampleRow = db.prepare("SELECT * FROM book_order_sends WHERE task_id LIKE 'sample:book-order:%'").first();
  assert.ok(sampleRow);
  assert.equal(sampleRow.vendor_name, '__BOOK_ORDER_SAMPLE__');
  assert.equal(sampleRow.status, 'accepted');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM book_order_batch_items').first().count, 1,
    '샘플은 batch mapping을 만들지 않고 실제 예약 주문만 mapping한다');
  assert.equal(scheduled.ok, true);
  assert.equal(scheduled.results.length, 1);
  assert.equal(scheduled.results[0].taskCount, 1);
  assert.match(payloads[1].messages[0].text, /개념원리 미적분Ⅰ/);
});

test('rejected-only retry groups each vendor once and excludes accepted or unknown mappings', async () => {
  const db = new TestD1();
  seedOrderTask(db, { id: 'failed-1', orderDelivery: 'scheduled_batch_v1' });
  seedOrderTask(db, {
    id: 'failed-2', title: '[주문] 같은 출판사 두 번째', orderDelivery: 'scheduled_batch_v1',
    orderItems: [{ title: '같은 출판사 두 번째', qty: '2권' }]
  });
  seedOrderTask(db, {
    id: 'failed-other', title: '[주문] 다른 출판사', orderDelivery: 'scheduled_batch_v1',
    orderVendor: '상형출판사', orderItems: [{ title: '다른 출판사 교재', qty: '1권' }]
  });
  seedOrderTask(db, {
    id: 'already-accepted', title: '[주문] 접수 완료', orderDelivery: 'scheduled_batch_v1',
    orderItems: [{ title: '접수 완료 교재', qty: '1권' }]
  });
  seedOrderTask(db, {
    id: 'already-unknown', title: '[주문] 결과 불명', orderDelivery: 'scheduled_batch_v1',
    orderItems: [{ title: '결과 불명 교재', qty: '1권' }]
  });
  seedMappedSend(db, 'failed-1', 'old-rejected-1', 'rejected');
  seedMappedSend(db, 'failed-2', 'old-rejected-2', 'rejected');
  seedMappedSend(db, 'failed-other', 'old-rejected-3', 'rejected');
  seedMappedSend(db, 'already-accepted', 'old-accepted', 'accepted');
  seedMappedSend(db, 'already-unknown', 'old-unknown', 'unknown');

  const payloads = [];
  const env = {
    TASK_MANAGER_STAFF_IDS: 'S-kim',
    BOOK_VENDOR_PHONES: JSON.stringify({ '천재출판사': '01099998888', '상형출판사': '01077776666' })
  };
  let first;
  let again;
  const nextKstMorning = Date.parse(new Date(Date.now() + 9 * 60 * 60 * 1000 + 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10) + 'T00:00:00Z');
  await withNow(nextKstMorning, () => withFetch(async (url, opts) => {
    payloads.push(JSON.parse(opts.body));
    return acceptedResponse(payloads.length);
  }, async () => {
    first = await call(db, { auth: person('S-kim', 'tok-kim'), action: 'retry-rejected' }, env);
    again = await call(db, { auth: admin, action: 'retry-rejected' }, env);
  }));

  assert.equal(first.status, 200);
  assert.equal(first.body.results.length, 2);
  assert.equal(payloads.length, 2, '거래처별 정확히 한 통만 실제 호출한다');
  const grouped = first.body.results.find(result => result.vendorName === '천재출판사');
  assert.equal(grouped.taskCount, 2);
  assert.equal(grouped.itemCount, 2);
  const groupedMessage = payloads.find(payload => payload.messages[0].to === '01099998888').messages[0].text;
  assert.match(groupedMessage, /개념원리 미적분Ⅰ/);
  assert.match(groupedMessage, /같은 출판사 두 번째/);
  for (const payload of payloads) {
    assert.doesNotMatch(payload.messages[0].text, /접수 완료 교재|결과 불명 교재/);
  }
  assert.equal(again.status, 200);
  assert.equal(again.body.idempotent, true);
  assert.deepEqual(again.body.results, []);
  assert.equal(payloads.length, 2, 'accepted mapping 뒤 반복 호출은 provider를 다시 부르지 않는다');
});

test('전화로 주문 완료한 배치는 후속 상태가 거절로 바뀌어도 재발송하지 않는다', async () => {
  const db = new TestD1();
  seedOrderTask(db, { id: 'phone-completed', orderDelivery: 'scheduled_batch_v1' });
  seedMappedSend(db, 'phone-completed', 'phone-completed-send', 'rejected');
  db.prepare("UPDATE book_order_sends SET safe_error_code='MANUAL_PHONE_ORDERED' WHERE send_id='phone-completed-send'").run();
  let fetches = 0;
  await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
    const result = await call(db, { auth: admin, action: 'retry-rejected' });
    assert.equal(result.status, 200);
    assert.equal(result.body.idempotent, true);
    assert.deepEqual(result.body.results, []);
  });
  assert.equal(fetches, 0);
});

test('retry processes up to the daily chunk limit and leaves overflow rejected for the next day', async () => {
  const db = new TestD1();
  const vendors = {};
  const dayOne = Date.parse('2026-09-01T00:00:00Z');
  await withNow(dayOne - 25 * 60 * 60 * 1000, () => {
    for (let index = 0; index < 31; index++) {
      const vendor = '출판사-' + index;
      const taskId = 'failed-limit-' + index;
      vendors[vendor] = '01099998888';
      seedOrderTask(db, { id: taskId, title: '[주문] 교재-' + index,
        orderVendor: vendor, orderDelivery: 'scheduled_batch_v1',
        orderItems: [{ title: '교재-' + index, qty: '1권' }] });
      seedMappedSend(db, taskId, 'old-limit-' + index, 'rejected');
    }
  });
  const env = { BOOK_VENDOR_PHONES: JSON.stringify(vendors) };
  let fetches = 0;
  await withFetch(async () => { fetches += 1; return acceptedResponse(fetches); }, async () => {
    const first = await withNow(dayOne, () => call(db, { auth: admin, action: 'retry-rejected' }, env));
    assert.equal(first.status, 429);
    assert.equal(first.body.code, 'DAILY_SEND_LIMIT');
    assert.equal(fetches, 30);
    assert.equal(first.body.results.at(-1).status, 'DAILY_SEND_LIMIT');
    const states = db.prepare(
      'SELECT s.status,COUNT(*) AS count FROM book_order_batch_items i JOIN book_order_sends s ' +
      'ON s.app=i.app AND s.send_id=i.send_id GROUP BY s.status ORDER BY s.status'
    ).all().results.map(row => ({ status: row.status, count: row.count }));
    assert.deepEqual(states, [{ status: 'accepted', count: 30 }, { status: 'rejected', count: 1 }]);

    const second = await withNow(dayOne + 25 * 60 * 60 * 1000, () =>
      call(db, { auth: admin, action: 'retry-rejected' }, env));
    assert.equal(second.status, 200);
    assert.equal(fetches, 31);
    assert.equal(db.prepare(
      "SELECT COUNT(*) AS count FROM book_order_batch_items i JOIN book_order_sends s " +
      "ON s.app=i.app AND s.send_id=i.send_id WHERE s.status='accepted'"
    ).first().count, 31);
  });
});

test('rejected-only retry is root/allowlist-manager only, once per KST day, and reopens next day', async () => {
  const db = new TestD1();
  const dayOne = Date.parse('2026-08-11T00:00:00Z');
  const dayTwo = Date.parse('2026-08-12T00:00:00Z');
  const task = seedOrderTask(db, {
    id: 'failed-1', orderDelivery: 'scheduled_batch_v1', createdAt: dayOne - 60_000
  });
  seedMappedSend(db, 'failed-1', 'old-rejected-1', 'rejected');
  let fetches = 0;
  await withFetch(async () => {
    fetches += 1;
    return new Response(JSON.stringify({ errorCode: 'InvalidSenderNumber' }), { status: 400 });
  }, async () => {
    const staff = await call(db, { auth: person('S-kim', 'tok-kim'), action: 'retry-rejected' });
    assert.equal(staff.status, 403);
    const first = await withNow(dayOne, () => call(db, { auth: admin, action: 'retry-rejected' }));
    assert.equal(first.status, 502);
    assert.equal(first.body.results[0].status, 'rejected');

    task.orderVendor = '상형출판사';
    task.orderItems = [{ title: '변경된 주문 교재', qty: '2권' }];
    task.updatedAt = dayOne + 60_000;
    db.prepare("UPDATE tasks SET data=?,updated_at=? WHERE app='task' AND id=?")
      .bind(JSON.stringify(task), task.updatedAt, task.id).run();

    const env = { BOOK_VENDOR_PHONES: JSON.stringify({ '천재출판사': '01099998888', '상형출판사': '01077776666' }) };
    const sameDay = await withNow(dayOne + 60_000, () =>
      call(db, { auth: admin, action: 'retry-rejected' }, env));
    assert.equal(sameDay.status, 502);
    assert.equal(sameDay.body.ok, false);
    assert.equal(sameDay.body.code, 'ALREADY_RETRIED_TODAY');
    assert.equal(sameDay.body.results[0].idempotent, true);
    assert.equal(sameDay.body.results[0].status, 'rejected');
    assert.equal(sameDay.body.results[0].errorCode, 'SOLAPI_HTTP_400_INVALIDSENDERNUMBER');

    const nextDay = await withNow(dayTwo, () =>
      call(db, { auth: admin, action: 'retry-rejected' }, env));
    assert.equal(nextDay.status, 502);
    assert.equal(nextDay.body.results[0].status, 'rejected');
  });
  assert.equal(fetches, 2, '당일 내용·거래처 변경은 재발송하지 않고 다음 KST 날짜에만 다시 시도한다');
});

test('an already retried task is skipped without blocking a different newly rejected task', async () => {
  const db = new TestD1();
  const sendAt = Date.parse('2026-08-11T00:00:00Z');
  seedOrderTask(db, {
    id: 'failed-old', orderDelivery: 'scheduled_batch_v1', createdAt: sendAt - 120_000
  });
  seedMappedSend(db, 'failed-old', 'old-rejected', 'rejected');
  let fetches = 0;
  await withNow(sendAt, async () => {
    await withFetch(async () => {
      fetches += 1;
      if (fetches === 1) {
        return new Response(JSON.stringify({ errorCode: 'InvalidSenderNumber' }), { status: 400 });
      }
      return acceptedResponse(fetches);
    }, async () => {
      const first = await call(db, { auth: admin, action: 'retry-rejected' });
      assert.equal(first.status, 502);

      seedOrderTask(db, {
        id: 'failed-new', title: '[주문] 새로 거절된 주문', orderDelivery: 'scheduled_batch_v1',
        orderItems: [{ title: '새로 거절된 주문', qty: '1권' }], createdAt: sendAt - 60_000
      });
      seedMappedSend(db, 'failed-new', 'new-rejected', 'rejected');

      const second = await call(db, { auth: admin, action: 'retry-rejected' });
      assert.equal(second.status, 502, '기존 당일 거절 결과를 숨기지 않는다');
      assert.equal(second.body.ok, false);
      assert.equal(second.body.code, 'ALREADY_RETRIED_TODAY');
      assert.deepEqual(second.body.results.map(result => result.status).sort(), ['accepted', 'rejected']);
    });
  });
  assert.equal(fetches, 2, '기존 task는 건너뛰고 새 task만 한 번 provider에 보낸다');
});

test('rejected retry reports an uncertain provider result as outer ok false with HTTP 202', async () => {
  const db = new TestD1();
  const sendAt = Date.parse('2026-08-11T00:00:00Z');
  seedOrderTask(db, { id: 'failed-1', orderDelivery: 'scheduled_batch_v1', createdAt: sendAt - 60_000 });
  seedMappedSend(db, 'failed-1', 'old-rejected-1', 'rejected');
  await withFetch(async () => { throw new Error('network down'); }, async () => {
    const result = await withNow(sendAt, () =>
      call(db, { auth: admin, action: 'retry-rejected' }));
    assert.equal(result.status, 202);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.results[0].status, 'unknown');
  });
});

test('rejected retry blocks the inclusive 19:45-20:30 KST cron window before DB selection or fetch', async () => {
  const at = time => Date.parse('2026-08-11T' + time + ':00Z');
  assert.equal(isRetryCronWindow(at('10:44')), false, '19:44 KST는 허용');
  assert.equal(isRetryCronWindow(at('10:45')), true, '19:45 KST부터 차단');
  assert.equal(isRetryCronWindow(at('11:30')), true, '20:30 KST까지 차단');
  assert.equal(isRetryCronWindow(at('11:31')), false, '20:31 KST부터 허용');

  let dbQueries = 0;
  let fetches = 0;
  const db = {
    prepare() {
      dbQueries += 1;
      throw new Error('cron window must return before querying D1');
    }
  };
  await withNow(at('10:45'), async () => {
    await withFetch(async () => {
      fetches += 1;
      return acceptedResponse();
    }, async () => {
      const result = await call(db, { auth: admin, action: 'retry-rejected' });
      assert.equal(result.status, 409);
      assert.equal(result.body.code, 'RETRY_CRON_WINDOW');
      assert.match(result.body.error, /20:30 이후/);
    });
  });
  assert.equal(dbQueries, 0);
  assert.equal(fetches, 0);
});

test('retry lease blocks an overlapping scheduler until the response body finishes, then releases', async () => {
  const db = new TestD1();
  const sendAt = Date.parse('2026-08-11T00:00:00Z');
  seedOrderTask(db, {
    id: 'failed-1', orderDelivery: 'scheduled_batch_v1', createdAt: sendAt - 120_000
  });
  seedMappedSend(db, 'failed-1', 'old-rejected-1', 'rejected');
  seedOrderTask(db, {
    id: 'fresh-1', title: '[주문] 새 예약 주문', orderDelivery: 'scheduled_batch_v1',
    orderItems: [{ title: '새 예약 주문', qty: '1권' }], createdAt: sendAt - 60_000
  });

  let fetches = 0;
  let releaseBody;
  let markBodyStarted;
  const bodyStarted = new Promise(resolve => { markBodyStarted = resolve; });
  await withNow(sendAt, async () => {
    await withFetch(async () => {
      fetches += 1;
      if (fetches !== 1) return acceptedResponse(fetches);
      return {
        ok: true,
        status: 200,
        text() {
          markBodyStarted();
          return new Promise(resolve => { releaseBody = () => resolve(JSON.stringify(acceptedPayload(1))); });
        }
      };
    }, async () => {
      const retryPromise = call(db, { auth: admin, action: 'retry-rejected' });
      await bodyStarted;
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM book_order_dispatch_lock WHERE app='task'").first().count, 1);

      const busy = await handleScheduledBookOrders({ DB: db, ...fullEnvBase }, sendAt);
      assert.equal(busy.ok, false);
      assert.equal(busy.code, 'BOOK_ORDER_SEND_BUSY');
      assert.equal(fetches, 1, '겹친 scheduler는 provider를 호출하지 않는다');

      releaseBody();
      const retried = await retryPromise;
      assert.equal(retried.status, 200);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM book_order_dispatch_lock WHERE app='task'").first().count, 0);

      const afterRelease = await handleScheduledBookOrders({ DB: db, ...fullEnvBase }, sendAt);
      assert.equal(afterRelease.ok, true);
      assert.equal(fetches, 2, 'lease 해제 뒤 새 예약 주문은 실행할 수 있다');
    });
  });
});

test('direct task send and scheduler share the same lease and cannot fetch concurrently', async () => {
  const db = new TestD1();
  const sendAt = Date.parse('2026-08-11T00:00:00Z');
  seedOrderTask(db, {
    id: 'direct-1', orderDelivery: 'scheduled_batch_v1', createdAt: sendAt - 120_000
  });
  seedOrderTask(db, {
    id: 'fresh-1', title: '[주문] 두 번째 예약 주문', orderDelivery: 'scheduled_batch_v1',
    orderItems: [{ title: '두 번째 예약 주문', qty: '1권' }], createdAt: sendAt - 60_000
  });

  let fetches = 0;
  let releaseBody;
  let markBodyStarted;
  const bodyStarted = new Promise(resolve => { markBodyStarted = resolve; });
  await withNow(sendAt, async () => {
    await withFetch(async () => {
      fetches += 1;
      if (fetches !== 1) return acceptedResponse(fetches);
      return {
        ok: true,
        status: 200,
        text() {
          markBodyStarted();
          return new Promise(resolve => { releaseBody = () => resolve(JSON.stringify(acceptedPayload(1))); });
        }
      };
    }, async () => {
      const directPromise = call(db, { auth: admin, taskId: 'direct-1' });
      await bodyStarted;
      const busy = await handleScheduledBookOrders({ DB: db, ...fullEnvBase }, sendAt);
      assert.equal(busy.code, 'BOOK_ORDER_SEND_BUSY');
      assert.equal(fetches, 1);

      releaseBody();
      const direct = await directPromise;
      assert.equal(direct.status, 200);
      const afterRelease = await handleScheduledBookOrders({ DB: db, ...fullEnvBase }, sendAt);
      assert.equal(afterRelease.ok, true);
      assert.equal(fetches, 2, '직접 발송된 주문은 제외하고 새 주문만 scheduler가 보낸다');
    });
  });
});

test('live lease returns busy, while an expired-at-now lease is atomically taken over and released', async () => {
  const db = new TestD1();
  const sendAt = Date.parse('2026-08-11T00:00:00Z');
  seedOrderTask(db, {
    id: 'failed-1', orderDelivery: 'scheduled_batch_v1', createdAt: sendAt - 60_000
  });
  seedMappedSend(db, 'failed-1', 'old-rejected-1', 'rejected');
  db.prepare(
    "INSERT INTO book_order_dispatch_lock(app,owner,lease_until,updated_at) VALUES('task','live-owner',?,?)"
  ).bind(sendAt + 1, sendAt).run();

  let fetches = 0;
  await withNow(sendAt, async () => {
    await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
      const busy = await call(db, { auth: admin, action: 'retry-rejected' });
      assert.equal(busy.status, 409);
      assert.equal(busy.body.code, 'BOOK_ORDER_SEND_BUSY');
      assert.equal(fetches, 0);

      db.prepare("UPDATE book_order_dispatch_lock SET lease_until=? WHERE app='task'").bind(sendAt).run();
      const takenOver = await call(db, { auth: admin, action: 'retry-rejected' });
      assert.equal(takenOver.status, 200);
      assert.equal(fetches, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM book_order_dispatch_lock WHERE app='task'").first().count, 0);
    });
  });
});

test('scheduler releases its lease when candidate selection throws', async () => {
  const db = new TestD1();
  const originalPrepare = db.prepare.bind(db);
  let failSelection = true;
  db.prepare = sql => {
    if (failSelection && String(sql).startsWith("SELECT t.id,t.owner,t.data FROM tasks t WHERE t.app='task'")) {
      failSelection = false;
      throw new Error('candidate read failed');
    }
    return originalPrepare(sql);
  };
  await assert.rejects(
    handleScheduledBookOrders({ DB: db, ...fullEnvBase }, Date.now()),
    /candidate read failed/
  );
  assert.equal(originalPrepare("SELECT COUNT(*) AS count FROM book_order_dispatch_lock WHERE app='task'").first().count, 0);
});

test('Solapi timeout covers a hanging response body and remains unknown/idempotent', async () => {
  const db = new TestD1();
  seedOrderTask(db, { id: 'order-timeout' });
  let fetches = 0;
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) =>
    nativeSetTimeout(callback, delay === 8000 ? 5 : delay, ...args);
  try {
    await withFetch(async (url, options) => {
      fetches += 1;
      return {
        ok: true,
        status: 200,
        text() {
          return new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        }
      };
    }, async () => {
      const first = await call(db, { auth: admin, taskId: 'order-timeout' });
      assert.equal(first.status, 202);
      assert.equal(first.body.send.status, 'unknown');
      assert.equal(first.body.send.errorCode, 'SOLAPI_TIMEOUT');

      const again = await call(db, { auth: admin, taskId: 'order-timeout' });
      assert.equal(again.status, 202);
      assert.equal(again.body.idempotent, true);
    });
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
  }
  assert.equal(fetches, 1, 'timeout 결과는 provider를 다시 호출하지 않는다');
});

test('invalid Solapi response body is unknown and cannot be retried', async () => {
  const db = new TestD1();
  seedOrderTask(db, { id: 'order-invalid-body' });
  let fetches = 0;
  await withFetch(async () => {
    fetches += 1;
    return new Response('{not-json', { status: 200 });
  }, async () => {
    const first = await call(db, { auth: admin, taskId: 'order-invalid-body' });
    assert.equal(first.status, 202);
    assert.equal(first.body.send.status, 'unknown');
    assert.equal(first.body.send.errorCode, 'SOLAPI_INVALID_RESPONSE');
    const again = await call(db, { auth: admin, taskId: 'order-invalid-body' });
    assert.equal(again.status, 202);
    assert.equal(again.body.idempotent, true);
  });
  assert.equal(fetches, 1);
});

test('send is disabled by default even with valid credentials unless the explicit switch is on', async () => {
  const db = new TestD1(); seedOrderTask(db);
  let fetches = 0;
  await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
    const r = await call(db, { auth: admin, taskId: 'order-1' }, { WB_BOOK_ORDER_SEND_ENABLED: 'false' });
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'SEND_DISABLED');
  });
  assert.equal(fetches, 0);
});

test('unknown vendor or vendor missing from the phone allowlist is rejected before any fetch', async () => {
  const db = new TestD1(); seedOrderTask(db, { orderVendor: '알수없는출판사' });
  let fetches = 0;
  await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
    const r = await call(db, { auth: admin, taskId: 'order-1' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'VENDOR_PHONE_MISSING');
  });
  assert.equal(fetches, 0);
});

test('task without structured orderVendor/orderItems cannot be sent', async () => {
  const db = new TestD1(); seedOrderTask(db, { orderVendor: '', orderItems: [] });
  const r = await call(db, { auth: admin, taskId: 'order-1' });
  assert.equal(r.status, 409);
});

test('staff can send their own assigned order but not someone else\'s', async () => {
  const db = new TestD1(); seedOrderTask(db);
  await withFetch(async () => acceptedResponse(), async () => {
    const ok = await call(db, { auth: person('S-kim', 'tok-kim'), taskId: 'order-1' });
    assert.equal(ok.status, 200);
  });

  db.prepare("INSERT INTO staff (app,id,owner,data,updated_at,srv_at) VALUES ('task','S-other','S-other',?,?,?)")
    .bind(JSON.stringify({ id: 'S-other', name: '다른쌤', deleted: false }), Date.now(), Date.now()).run();
  db.prepare("INSERT INTO tokens (app,token,staff_id,created_at,revoked) VALUES ('task','tok-other','S-other',?,0)").bind(Date.now()).run();
  seedOrderTask(db, { id: 'order-2', title: '[주문] 다른 책', orderItems: [{ title: '다른 책', qty: '1권' }] });
  const forbidden = await call(db, { auth: person('S-other', 'tok-other'), taskId: 'order-2' });
  assert.equal(forbidden.status, 403);
});

test('a successful send is recorded and resending the same order is idempotent (no second fetch)', async () => {
  const db = new TestD1(); seedOrderTask(db);
  let fetches = 0;
  let first, second;
  await withFetch(async (url, opts) => {
    fetches += 1;
    assert.match(opts.headers.Authorization, /^HMAC-SHA256 apiKey=test-key, /);
    const payload = JSON.parse(opts.body);
    assert.equal(payload.messages[0].to, '01099998888', '거래처 번호로만 보내진다');
    assert.equal(payload.messages[0].subject, 'WB 교재 주문');
    assert.match(payload.messages[0].text, /개념원리 미적분Ⅰ/);
    assert.match(payload.messages[0].text, /3권/);
    return acceptedResponse(fetches);
  }, async () => {
    first = await call(db, { auth: admin, taskId: 'order-1' }, {
      SOLAPI_API_KEY: '  test-key  ',
      SOLAPI_API_SECRET: '  test-secret\n'
    });
    second = await call(db, { auth: admin, taskId: 'order-1' });
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.send.status, 'accepted');
  assert.equal(second.body.idempotent, true, '같은 주문을 다시 보내도 문자가 또 나가지 않는다');
  assert.equal(fetches, 1);

  const row = db.prepare("SELECT * FROM book_order_sends WHERE app='task'").first();
  assert.equal(row.vendor_name, '천재출판사');
  assert.equal(row.status, 'accepted');
});

test('books from one publisher in a batch order are sent in one message', async () => {
  const db = new TestD1();
  seedOrderTask(db, {
    orderItems: [
      { title: '팩토사고력 Lv3 B 기본', qty: '2권' },
      { title: '팩토사고력 Lv3 B 응용', qty: '1권' }
    ]
  });
  let fetches = 0;
  await withFetch(async (url, opts) => {
    fetches += 1;
    const message = JSON.parse(opts.body).messages[0];
    assert.match(message.text, /팩토사고력 Lv3 B 기본: 2권/);
    assert.match(message.text, /팩토사고력 Lv3 B 응용: 1권/);
    return acceptedResponse();
  }, async () => {
    const result = await call(db, { auth: admin, taskId: 'order-1' });
    assert.equal(result.status, 200);
    assert.equal(result.body.itemCount, 2);
  });
  assert.equal(fetches, 1);
});

test('scheduled orders from the same publisher are grouped once and cannot be sent again individually', async () => {
  const db = new TestD1();
  const cutoff = Date.now() + 1000;
  seedOrderTask(db, { orderDelivery: 'scheduled_batch_v1' });
  seedOrderTask(db, {
    id: 'order-2', title: '[주문] 팩토사고력 Lv3 B 응용', orderDelivery: 'scheduled_batch_v1',
    orderItems: [{ title: '팩토사고력 Lv3 B 응용', qty: '2권' }]
  });
  seedOrderTask(db, {
    id: 'legacy-order', title: '[주문] 기존 미발송 주문',
    orderDelivery: undefined,
    orderItems: [{ title: '기존 미발송 주문', qty: '99권' }]
  });
  let fetches = 0;
  await withFetch(async (url, opts) => {
    fetches += 1;
    const message = JSON.parse(opts.body).messages[0];
    assert.match(message.text, /개념원리 미적분Ⅰ: 3권/);
    assert.match(message.text, /팩토사고력 Lv3 B 응용: 2권/);
    assert.doesNotMatch(message.text, /기존 미발송 주문/);
    return acceptedResponse();
  }, async () => {
    const first = await handleScheduledBookOrders({ DB: db, ...fullEnvBase }, cutoff);
    assert.equal(first.ok, true);
    assert.equal(first.results.length, 1);
    assert.equal(first.results[0].taskCount, 2);
    assert.equal(first.results[0].itemCount, 2);

    const again = await handleScheduledBookOrders({ DB: db, ...fullEnvBase }, cutoff);
    assert.deepEqual(again.results, []);

    const manual = await call(db, { auth: admin, taskId: 'order-1' });
    assert.equal(manual.status, 200);
    assert.equal(manual.body.idempotent, true);
  });
  assert.equal(fetches, 1, '같은 출판사 묶음과 재시도까지 실제 문자는 한 번만 보낸다');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM book_order_batch_items WHERE app='task'").first().count, 2);
});

test('scheduler splits one vendor at whole-task boundaries before the 2000-byte provider limit', async () => {
  const db = new TestD1();
  const cutoff = Date.now() + 1000;
  for (let index = 0; index < 20; index++) {
    seedOrderTask(db, { id: 'chunk-order-' + index, title: '[주문] 단체-' + index,
      orderDelivery: 'scheduled_batch_v1', orderItems: [{ title: '가'.repeat(100) + index, qty: '1권' }] });
  }
  const payloads = [];
  await withFetch(async (url, options) => {
    const payload = JSON.parse(options.body);
    payloads.push(payload);
    assert.ok(new TextEncoder().encode(payload.messages[0].text).byteLength <= 2000);
    return acceptedResponse(payloads.length);
  }, async () => {
    const result = await handleScheduledBookOrders({ DB: db, ...fullEnvBase }, cutoff);
    assert.equal(result.ok, true);
    assert.ok(result.results.length > 1);
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM book_order_batch_items').first().count, 20);
});

test('a short 150-task chunk reserves its send and all mappings in exactly two D1 statements', async () => {
  const db = new TestD1();
  const cutoff = Date.now() + 1000;
  for (let index = 0; index < 150; index++) {
    seedOrderTask(db, { id: 'bulk-map-' + index, title: '[주문] A', orderDelivery: 'scheduled_batch_v1',
      orderItems: [{ title: 'A', qty: '1' }] });
  }
  const originalBatch = db.batch.bind(db);
  const reservationBatchSizes = [];
  db.batch = statements => {
    if (statements.some(statement => /INSERT OR IGNORE INTO book_order_sends/.test(statement.sql))) {
      reservationBatchSizes.push(statements.length);
    }
    return originalBatch(statements);
  };
  await withFetch(async () => acceptedResponse(), async () => {
    const result = await handleScheduledBookOrders({ DB: db, ...fullEnvBase }, cutoff);
    assert.equal(result.ok, true);
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM book_order_batch_items').first().count, 150);
  assert.ok(db.prepare(
    'SELECT MAX(task_count) AS count FROM (SELECT COUNT(*) AS task_count FROM book_order_batch_items GROUP BY send_id)'
  ).first().count >= 100);
  assert.ok(reservationBatchSizes.length >= 1);
  assert.deepEqual(new Set(reservationBatchSizes), new Set([2]));
});

test('processed scheduled rows are filtered before LIMIT so 2000 old rows cannot starve a new order', async () => {
  const db = new TestD1();
  const base = Date.now();
  for (let index = 0; index < 2000; index++) {
    const taskId = 'done-' + index;
    seedOrderTask(db, { id: taskId, orderDelivery: 'scheduled_batch_v1', createdAt: base - 1000 });
    seedMappedSend(db, taskId, 'done-send-' + index, 'accepted');
  }
  seedOrderTask(db, { id: 'fresh-after-2000', title: '[주문] 신규',
    orderDelivery: 'scheduled_batch_v1', orderItems: [{ title: '신규 교재', qty: '1권' }], createdAt: base });
  let fetches = 0;
  await withNow(base + 2 * 24 * 60 * 60 * 1000, () => withFetch(async () => {
    fetches += 1;
    return acceptedResponse();
  }, async () => {
    const result = await handleScheduledBookOrders({ DB: db, ...fullEnvBase }, base + 1);
    assert.equal(result.results[0].taskCount, 1);
    assert.equal(result.results[0].status, 'accepted');
  }));
  assert.equal(fetches, 1);
});

test('send reservation and batch mappings roll back together, and a later cron can safely retry', async () => {
  const db = new TestD1();
  const cutoff = Date.now() + 1000;
  seedOrderTask(db, { id: 'atomic-order', orderDelivery: 'scheduled_batch_v1' });
  const originalBatch = db.batch.bind(db);
  let failOnce = true;
  db.batch = statements => {
    if (!failOnce || !statements.some(statement => /INSERT OR IGNORE INTO book_order_sends/.test(statement.sql))) {
      return originalBatch(statements);
    }
    failOnce = false;
    db.database.exec('BEGIN');
    try {
      statements[0].run();
      throw new Error('injected mapping failure');
    } catch (error) {
      db.database.exec('ROLLBACK');
      throw error;
    }
  };
  let fetches = 0;
  await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
    const failed = await handleScheduledBookOrders({ DB: db, ...fullEnvBase }, cutoff);
    assert.equal(failed.results[0].status, 'ORDER_MAPPING_CONFLICT');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM book_order_sends').first().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM book_order_batch_items').first().count, 0);

    const retried = await handleScheduledBookOrders({ DB: db, ...fullEnvBase }, cutoff + 1);
    assert.equal(retried.results[0].status, 'accepted');
  });
  assert.equal(fetches, 1);
});

test('crash residues are reported without automatically sending again', async () => {
  for (const mapped of [false, true]) {
    const db = new TestD1();
    seedOrderTask(db, { id: mapped ? 'mapped-crash' : 'orphan-crash', orderDelivery: 'scheduled_batch_v1' });
    const now = Date.now();
    db.prepare('INSERT INTO book_order_sends(app,send_id,idempotency_key,task_id,vendor_name,item_count,' +
      "message_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'reserved',?,?)")
      .bind('task', 'crash-send', 'crash-key', 'batch_crash', '천재출판사', 1, 'a'.repeat(64), now, now).run();
    if (mapped) db.prepare('INSERT INTO book_order_batch_items(app,task_id,send_id,created_at) VALUES(?,?,?,?)')
      .bind('task', 'mapped-crash', 'crash-send', now).run();
    let fetches = 0;
    await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
      const result = await handleScheduledBookOrders({ DB: db, ...fullEnvBase }, now + 1);
      assert.equal(result.code, mapped ? 'BOOK_ORDER_SEND_RESERVED' : 'BOOK_ORDER_LEDGER_PARTIAL');
    });
    assert.equal(fetches, 0);
  }
});

test('provider rejection and network failure are both recorded without throwing', async () => {
  const dbRej = new TestD1(); seedOrderTask(dbRej);
  await withFetch(async () => new Response(JSON.stringify({
    groupInfo: { groupId: 'G' },
    failedMessageList: [{ messageId: 'FAILED', statusCode: '1010', statusMessage: 'raw provider detail' }],
    messageList: [{ messageId: 'M', statusCode: '2000' }]
  }), { status: 200 }), async () => {
    const r = await call(dbRej, { auth: admin, taskId: 'order-1' });
    assert.equal(r.status, 502);
    assert.equal(r.body.send.status, 'rejected');
    assert.equal(r.body.send.errorCode, 'SOLAPI_STATUS_1010');
  });

  const dbNet = new TestD1(); seedOrderTask(dbNet);
  await withFetch(async () => { throw new Error('network down'); }, async () => {
    const r = await call(dbNet, { auth: admin, taskId: 'order-1' });
    assert.equal(r.status, 202);
    assert.equal(r.body.send.status, 'unknown');
  });
});

test('rejected scheduled batch is never retried by a later cron and only explicit retry can resend it', async () => {
  const db = new TestD1();
  const cutoff = Date.now() + 1000;
  seedOrderTask(db, { orderDelivery: 'scheduled_batch_v1' });
  let fetches = 0;
  await withFetch(async () => {
    fetches += 1;
    if (fetches === 1) {
      return new Response(JSON.stringify({ errorCode: 'InvalidSenderNumber' }), { status: 400 });
    }
    return acceptedResponse(fetches);
  }, async () => {
    const failed = await handleScheduledBookOrders({ DB: db, ...fullEnvBase }, cutoff);
    assert.equal(failed.ok, false);
    assert.equal(failed.results[0].status, 'rejected');
    assert.equal(
      db.prepare("SELECT safe_error_code FROM book_order_sends WHERE app='task' ORDER BY created_at LIMIT 1").first().safe_error_code,
      'SOLAPI_HTTP_400_INVALIDSENDERNUMBER'
    );

    const laterCron = await handleScheduledBookOrders({ DB: db, ...fullEnvBase }, cutoff + 24 * 60 * 60 * 1000);
    assert.deepEqual(laterCron.results, []);
    assert.equal(fetches, 1, '거절 주문은 다음 cron이 자동 재발송하지 않는다');

    const cutoffKstDate = new Date(cutoff + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const retryAt = Date.parse(cutoffKstDate + 'T00:00:00Z') + 24 * 60 * 60 * 1000;
    const retried = await withNow(retryAt, () => call(db, { auth: admin, action: 'retry-rejected' }));
    assert.equal(retried.status, 200);
    assert.equal(retried.body.results[0].status, 'accepted');
  });
  assert.equal(fetches, 2);
  const mapped = db.prepare(
    "SELECT s.status FROM book_order_batch_items i JOIN book_order_sends s ON s.app=i.app AND s.send_id=i.send_id " +
    "WHERE i.app='task' AND i.task_id='order-1'"
  ).first();
  assert.equal(mapped.status, 'accepted');
});

test('global daily send limit (30) blocks further sends without calling the provider', async () => {
  const db = new TestD1(); seedOrderTask(db);
  const now = Date.now();
  // 오늘 이미 30건 보낸 것처럼 직접 채워둔다 (한도 검증용 — 실제 발송 없이)
  for (let i = 0; i < 30; i++) {
    db.prepare(
      'INSERT INTO book_order_sends (app,send_id,idempotency_key,task_id,vendor_name,item_count,message_hash,status,created_at,updated_at) ' +
      "VALUES ('task',?,?,?,?,1,?, 'accepted',?,?)"
    ).bind('bos_fill' + i, 'fillkey' + i, 'order-1', '천재출판사', 'a'.repeat(64), now, now).run();
  }
  let fetches = 0;
  await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
    const r = await call(db, { auth: admin, taskId: 'order-1' });
    assert.equal(r.status, 429);
    assert.equal(r.body.code, 'DAILY_SEND_LIMIT');
  });
  assert.equal(fetches, 0, '한도에 걸리면 발송 시도 자체를 안 한다');
});
