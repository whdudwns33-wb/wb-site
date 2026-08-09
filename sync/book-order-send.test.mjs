import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

import worker from './worker-core.js';
import { handleScheduledBookOrders } from './book-order-send.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/013_book_order_sends.sql', import.meta.url), 'utf8');
const batchMigration = fs.readFileSync(new URL('./migrations/018_book_order_batch_items.sql', import.meta.url), 'utf8');
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
  batch(statements) { return statements.map(s => s.run()); }
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

function acceptedResponse(index = 1) {
  return new Response(JSON.stringify({
    groupInfo: { groupId: 'GROUP_' + index },
    messageList: [{ messageId: 'MSG_' + index, statusCode: '2000' }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function withFetch(stub, action) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await action(); } finally { globalThis.fetch = original; }
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
    createdAt: now, deleted: false, ...overrides
  };
  db.prepare('INSERT INTO tasks (app,id,owner,data,updated_at,srv_at) VALUES (?,?,?,?,?,?)')
    .bind('task', task.id, task.staffId, JSON.stringify(task), now, now).run();
  return task;
}

test('schema and migration are additive, and the send ledger itself stores no phone or message body', () => {
  for (const sql of [schema, migration]) {
    const match = sql.match(/CREATE TABLE IF NOT EXISTS book_order_sends\s*\([\s\S]*?\);/);
    assert.ok(match, 'book_order_sends 테이블 정의를 찾을 수 없습니다');
    assert.doesNotMatch(match[0], /phone|message_body/i);
    assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM/i);
  }
});

test('20:00 KST cron and additive batch mapping are configured without storing phone or message text', () => {
  assert.match(wrangler, /\[triggers\][\s\S]*crons\s*=\s*\["0 11 \* \* \*"\]/);
  assert.match(entry, /async scheduled\(controller, env, ctx\)/);
  assert.match(entry, /handleScheduledBookOrders\(env, controller\.scheduledTime\)/);
  assert.match(batchMigration, /CREATE TABLE IF NOT EXISTS book_order_batch_items/);
  assert.doesNotMatch(batchMigration, /phone|message_body|DROP TABLE|DELETE FROM/i);
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
    const payload = JSON.parse(opts.body);
    assert.equal(payload.messages[0].to, '01099998888', '거래처 번호로만 보내진다');
    assert.match(payload.messages[0].text, /개념원리 미적분Ⅰ/);
    assert.match(payload.messages[0].text, /3권/);
    return acceptedResponse(fetches);
  }, async () => {
    first = await call(db, { auth: admin, taskId: 'order-1' });
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

test('provider rejection and network failure are both recorded without throwing', async () => {
  const dbRej = new TestD1(); seedOrderTask(dbRej);
  await withFetch(async () => new Response(JSON.stringify({
    groupInfo: { groupId: 'G' }, messageList: [{ messageId: 'M', statusCode: '9999' }]
  }), { status: 200 }), async () => {
    const r = await call(dbRej, { auth: admin, taskId: 'order-1' });
    assert.equal(r.status, 502);
    assert.equal(r.body.send.status, 'rejected');
  });

  const dbNet = new TestD1(); seedOrderTask(dbNet);
  await withFetch(async () => { throw new Error('network down'); }, async () => {
    const r = await call(dbNet, { auth: admin, taskId: 'order-1' });
    assert.equal(r.status, 202);
    assert.equal(r.body.send.status, 'unknown');
  });
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
