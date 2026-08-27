import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import worker from './worker-core.js';
import { handleScheduledBookOrders } from './book-order-send.js';
import { readPublicBookStatus } from './public-book-status.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/037_book_order_identity_snapshots.sql', import.meta.url), 'utf8');
const admin = { mode: 'admin', secret: 'director-secret' };
const person = { mode: 'person', id: 'teacher-a', token: 'token-a' };
const vendorPhones = JSON.stringify({ '문자출판사': '010-1234-5678' });

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  first() { return this.db.prepare(this.sql).get(...this.args) || null; }
  all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  run() { const result = this.db.prepare(this.sql).run(...this.args); return { meta: { changes: Number(result.changes || 0) } }; }
}
class TestD1 {
  constructor() { this.database = new DatabaseSync(':memory:'); this.database.exec(schema); }
  prepare(sql) { return new Statement(this.database, sql); }
  batch(statements) {
    this.database.exec('BEGIN');
    try {
      const results = statements.map(statement => statement.run());
      this.database.exec('COMMIT');
      return Promise.resolve(results);
    } catch (error) {
      this.database.exec('ROLLBACK');
      return Promise.reject(error);
    }
  }
}

function roster(name = '가학생') {
  return {
    roster: { updated: '2026-08-17', baseline: '2026-08', students: [
      { id: 'student-a', name, grade: '중1', teacher: '가선생', subject: '영어', start: '2026-08', end: '', reason: '', teacherIds: ['teacher-a'] },
      { id: 'student-b', name: '나학생', grade: '중2', teacher: '나선생', subject: '영어', start: '2026-08', end: '', reason: '', teacherIds: ['teacher-b'] },
      { id: 'student-old', name: '종료학생', grade: '중3', teacher: '가선생', subject: '영어', start: '2026-01', end: '2026-08', reason: '', teacherIds: ['teacher-a'] }
    ] },
    bookStudents: []
  };
}

function seed(db) {
  const now = Date.now();
  db.prepare('INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', 'teacher-a', 'teacher-a', JSON.stringify({ id: 'teacher-a', name: '가선생', deleted: false }), now, now).run();
  db.prepare('INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', 'teacher-b', 'teacher-b', JSON.stringify({ id: 'teacher-b', name: '나선생', deleted: false }), now, now).run();
  db.prepare('INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)')
    .bind('task', 'token-a', 'teacher-a', now).run();
  db.prepare('INSERT INTO private_rosters(app,data,updated_at) VALUES(?,?,?)')
    .bind('task', JSON.stringify(roster()), now).run();
}

function env(db, extra = {}) {
  return { DB: db, TASK_ADMIN_SECRET: 'director-secret', CONSULT_ADMIN_SECRET: 'consult-secret',
    BOOK_VENDOR_PHONES: vendorPhones, ...extra };
}

async function call(db, body, path = '/book-order', extra = {}) {
  const response = await worker.fetch(new Request('https://worker.example' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app: 'task', ...body })
  }), env(db, extra));
  return { status: response.status, body: await response.json() };
}

function createBody(taskId = 'ord_safe_a123') {
  return { auth: person, action: 'create', taskId, vendorName: '문자출판사', items: [
    { bookId: 'BK01', title: '리딩바이트 Grade 2', studentIds: ['student-a'], unitPrice: 15000 }
  ] };
}

function boundBody(taskId = 'ord_bound_a123', productCode = 'pages_1_30') {
  return { auth: person, action: 'create_bound', taskId, productCode,
    title: '가학생 수학 제본', studentIds: ['student-a'] };
}

test('037 is additive, append-only, and stores no student display name, contact, or raw book title', () => {
  for (const sql of [schema, migration]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS book_order_student_snapshots/);
    assert.match(sql, /public_title\s+TEXT\s+NOT NULL CHECK \(public_title = '주문 교재'\)/);
    assert.match(sql, /BOOK_ORDER_SNAPSHOT_APPEND_ONLY/);
    assert.doesNotMatch(sql, /DROP TABLE/i);
    const start = sql.indexOf('CREATE TABLE IF NOT EXISTS book_order_student_snapshots');
    const table = sql.slice(start, sql.indexOf(');', start) + 2);
    assert.doesNotMatch(table, /student_name|phone|address|memo/i);
  }
});

test('create atomically writes a canonical task and immutable per-student identity snapshots', async () => {
  const db = new TestD1(); seed(db);
  const result = await call(db, createBody());
  assert.equal(result.status, 201);
  assert.equal(result.body.task.orderIdentityVersion, 1);
  assert.equal(result.body.task.origin, 'staff');
  assert.equal(result.body.task.staffId, 'teacher-a');
  assert.equal(result.body.task.orderItems[0].qty, '1권');
  assert.equal(result.body.task.orderItems[0].unitPrice, 15000);
  const rows = db.database.prepare('SELECT * FROM book_order_student_snapshots').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].public_title, '주문 교재');
  assert.equal(rows[0].student_id, 'student-a');
  assert.equal(rows[0].student_identity_hash.length, 64);
  assert.equal(JSON.stringify(rows).includes('가학생'), false);
  assert.equal(JSON.stringify(rows).includes('리딩바이트'), false);
  assert.throws(() => db.database.prepare('UPDATE book_order_student_snapshots SET book_id=?').run('BK99'), /APPEND_ONLY/);
  assert.throws(() => db.database.prepare('UPDATE book_order_active_targets SET book_id=?').run('BK99'), /APPEND_ONLY/);
  assert.throws(() => db.database.prepare('DELETE FROM book_order_active_targets').run(), /APPEND_ONLY/);
});

test('each bound product uses the server price map and starts at teacher-received without an SMS send', async () => {
  const db = new TestD1(); seed(db);
  const products = [
    ['pages_1_30', 4000],
    ['pages_31_60', 7000],
    ['pages_61_90', 9000],
    ['exam_upto_30', 9000],
    ['exam_over_30', 15000]
  ];
  const taskIds = [];
  for (let index = 0; index < products.length; index++) {
    const [productCode, unitPrice] = products[index];
    const taskId = 'ord_bound_' + String(index).padStart(4, '0');
    const body = boundBody(taskId, productCode);
    body.title = '제본 교재 ' + (index + 1);
    const result = await call(db, body);
    assert.equal(result.status, 201, productCode);
    assert.equal(result.body.task.orderDelivery, 'bound_print_v1');
    assert.equal(result.body.task.orderIdentityVersion, 1);
    assert.equal(result.body.task.staffId, 'teacher-a');
    assert.equal(result.body.task.orderItems.length, 1);
    assert.equal(result.body.task.orderItems[0].title, body.title);
    assert.equal(result.body.task.orderItems[0].unitPrice, unitPrice);
    assert.deepEqual(result.body.task.orderItems[0].studentIds, ['student-a']);
    assert.match(result.body.task.orderItems[0].bookId, /^[A-Za-z0-9_-]{1,128}$/);
    taskIds.push(taskId);
  }

  assert.equal(new Set(db.database.prepare('SELECT book_id FROM book_order_student_snapshots').all()
    .map(row => row.book_id)).size, 5, '각 제본 상품 코드는 서로 다른 서버 bookId로 봉인한다');
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM book_order_student_snapshots').get().count, 5);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM book_order_fulfillments').get().count, 5);
  assert.equal(db.database.prepare("SELECT COUNT(*) AS count FROM book_order_fulfillments WHERE status='teacher_received' AND revision=1").get().count, 5);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM book_order_sends').get().count, 0);

  const listed = await call(db, { auth: person, action: 'list' }, '/book-issue');
  for (const [index, taskId] of taskIds.entries()) {
    const row = listed.body.orders.find(order => order.taskId === taskId);
    assert.ok(row, taskId);
    assert.equal(row.stage, 'teacher_received');
    assert.equal(row.unitPrice, products[index][1]);
    assert.equal(row.owner, 'teacher-a');
    assert.deepEqual(row.students.map(student => student.id), ['student-a']);
    assert.ok(row.teacherReceivedAt);
  }
});

test('bound create is idempotent, rejects client prices and invalid products, and enforces roster scope', async () => {
  const db = new TestD1(); seed(db);
  const first = await call(db, boundBody());
  assert.equal(first.status, 201);
  const retry = await call(db, boundBody());
  assert.equal(retry.status, 200);
  assert.equal(retry.body.idempotent, true);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 1);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM book_order_student_snapshots').get().count, 1);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM book_order_fulfillments').get().count, 1);

  for (const [taskId, change] of [
    ['ord_bound_bad_option', body => { body.productCode = 'custom_price'; }],
    ['ord_bound_bad_price', body => { body.unitPrice = 1; }],
    ['ord_bound_bad_key', body => { body.optionId = 'pages_1_30'; }],
    ['ord_bound_bad_title', body => { body.title = ' '; }],
    ['ord_bound_bad_student', body => { body.studentIds = []; }]
  ]) {
    const body = boundBody(taskId);
    change(body);
    const result = await call(db, body);
    assert.equal(result.status, 400, taskId);
    assert.equal(result.body.code, 'ORDER_INVALID', taskId);
  }
  const changedRetry = boundBody(); changedRetry.title = '다른 제본명';
  assert.equal((await call(db, changedRetry)).body.code, 'ORDER_ID_CONFLICT');
  const outOfScope = boundBody('ord_bound_scope'); outOfScope.studentIds = ['student-b'];
  assert.equal((await call(db, outOfScope)).body.code, 'ORDER_STUDENT_SCOPE');
  const inactive = boundBody('ord_bound_inactive'); inactive.studentIds = ['student-old'];
  assert.equal((await call(db, inactive)).body.code, 'ORDER_STUDENT_INACTIVE');
  const missing = boundBody('ord_bound_missing'); missing.studentIds = ['student-missing'];
  assert.equal((await call(db, missing)).body.code, 'ORDER_STUDENT_MISSING');
});

test('bound orders continue through existing handoff and academy registration and expose history fields', async () => {
  const db = new TestD1(); seed(db);
  const created = await call(db, boundBody('ord_bound_flow1', 'exam_over_30'));
  assert.equal(created.status, 201);
  const handed = await call(db, { auth: person, action: 'order_transition', taskId: created.body.task.id,
    itemIndex: 0, next: 'hand', revision: 1 }, '/book-issue');
  assert.equal(handed.status, 200);
  assert.equal(handed.body.status, 'student_handed');
  const academy = await call(db, { auth: admin, action: 'order_transition', taskId: created.body.task.id,
    itemIndex: 0, next: 'academy_register', revision: 2 }, '/book-issue');
  assert.equal(academy.status, 200);
  assert.equal(academy.body.status, 'academy_registered');

  const listed = await call(db, { auth: admin, action: 'list' }, '/book-issue');
  const record = listed.body.orders.find(row => row.taskId === created.body.task.id);
  assert.equal(record.title, '가학생 수학 제본');
  assert.equal(record.owner, 'teacher-a');
  assert.equal(record.teacherName, '가선생');
  assert.equal(record.unitPrice, 15000);
  assert.equal(record.quantity, 1);
  assert.deepEqual(record.students.map(student => student.name), ['가학생']);
  assert.ok(record.studentHandedAt);
  assert.ok(record.academyRegisteredAt);
});

test('new orders require a positive whole-won unit price within the supported range', async () => {
  const db = new TestD1(); seed(db);
  for (const [taskId, unitPrice] of [
    ['ord_price_missing', undefined], ['ord_price_zero', 0], ['ord_price_decimal', 15000.5],
    ['ord_price_large', 10000001], ['ord_price_text', '15000']
  ]) {
    const body = createBody(taskId);
    if (unitPrice === undefined) delete body.items[0].unitPrice;
    else body.items[0].unitPrice = unitPrice;
    const result = await call(db, body);
    assert.equal(result.status, 400, taskId);
    assert.equal(result.body.code, 'ORDER_INVALID', taskId);
  }
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 0);
});

test('same taskId and exact payload is idempotent; collision, tampering, and races fail closed', async () => {
  const db = new TestD1(); seed(db);
  const [first, second] = await Promise.all([call(db, createBody()), call(db, createBody())]);
  assert.deepEqual([first.status, second.status].sort(), [200, 201]);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 1);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM book_order_student_snapshots').get().count, 1);
  const conflict = createBody(); conflict.items[0].title = '다른 교재';
  assert.equal((await call(db, conflict)).body.code, 'ORDER_ID_CONFLICT');
  const priceConflict = createBody(); priceConflict.items[0].unitPrice = 16000;
  assert.equal((await call(db, priceConflict)).body.code, 'ORDER_ID_CONFLICT');

  const taskRow = db.database.prepare("SELECT data,updated_at FROM tasks WHERE app='task' AND id='ord_safe_a123'").get();
  const task = JSON.parse(taskRow.data); task.orderItems[0].studentIds = ['student-b']; task.updatedAt += 1;
  const sync = await call(db, { auth: person, since: 0, changes: [{ table: 'tasks', id: task.id,
    owner: 'teacher-a', data: task, updated_at: task.updatedAt }] }, '/sync');
  assert.equal(sync.status, 409);
  assert.equal(sync.body.code, 'BOOK_ORDER_SEALED');
});

test('an exact response-loss retry stays idempotent after enrollment month ends, but a new order does not', async () => {
  const db = new TestD1(); seed(db);
  const row = db.database.prepare("SELECT data,updated_at FROM private_rosters WHERE app='task'").get();
  const document = JSON.parse(row.data);
  document.roster.students.find(student => student.id === 'student-a').end = '2026-09';
  db.database.prepare("UPDATE private_rosters SET data=?,updated_at=? WHERE app='task'")
    .run(JSON.stringify(document), Number(row.updated_at) + 1);
  const originalNow = Date.now;
  try {
    Date.now = () => Date.parse('2026-08-20T00:00:00Z');
    assert.equal((await call(db, createBody('ord_month_retry'))).status, 201);
    Date.now = () => Date.parse('2026-09-02T00:00:00Z');
    const retry = await call(db, createBody('ord_month_retry'));
    assert.equal(retry.status, 200);
    assert.equal(retry.body.idempotent, true);
    const fresh = await call(db, createBody('ord_month_fresh'));
    assert.equal(fresh.status, 409);
    assert.equal(fresh.body.code, 'ORDER_STUDENT_INACTIVE');
  } finally { Date.now = originalNow; }
});

test('accepted group fulfillment and an active peer public view survive another student month-end', async () => {
  const db = new TestD1(); seed(db);
  const row = db.database.prepare("SELECT data,updated_at FROM private_rosters WHERE app='task'").get();
  const document = JSON.parse(row.data);
  document.roster.students.find(student => student.id === 'student-a').end = '2026-09';
  db.database.prepare("UPDATE private_rosters SET data=?,updated_at=? WHERE app='task'")
    .run(JSON.stringify(document), Number(row.updated_at) + 1);
  const originalNow = Date.now;
  try {
    Date.now = () => Date.parse('2026-08-20T00:00:00Z');
    const body = createBody('ord_month_group');
    body.auth = admin;
    body.items[0].studentIds = ['student-a', 'student-b'];
    const created = await call(db, body);
    assert.equal(created.status, 201);
    const sentAt = Date.now() + 1;
    db.prepare('INSERT INTO book_order_sends(app,send_id,idempotency_key,task_id,vendor_name,item_count,' +
      "message_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'accepted',?,?)")
      .bind('task', 'month-group-send', 'month-group-key', 'batch_month_group', '문자출판사', 1,
        'c'.repeat(64), sentAt, sentAt).run();
    db.prepare('INSERT INTO book_order_batch_items(app,task_id,send_id,created_at) VALUES(?,?,?,?)')
      .bind('task', created.body.task.id, 'month-group-send', sentAt).run();

    Date.now = () => Date.parse('2026-09-02T00:00:00Z');
    const received = await call(db, { auth: admin, action: 'order_transition', taskId: created.body.task.id,
      itemIndex: 0, next: 'receive', revision: 0 }, '/book-issue');
    assert.equal(received.status, 200);
    const publicView = await readPublicBookStatus({ DB: db }, 'student-b', Date.now());
    assert.equal(publicView.rows.find(item => item.kind === 'order').stage, 'academy_received');
  } finally { Date.now = originalNow; }
});

test('different task IDs cannot race the same active student/book target, while cancel releases it', async () => {
  const db = new TestD1(); seed(db);
  const [first, second] = await Promise.all([
    call(db, createBody('ord_active_race1')),
    call(db, createBody('ord_active_race2'))
  ]);
  assert.deepEqual([first.status, second.status].sort(), [201, 409]);
  assert.equal([first, second].find(result => result.status === 409).body.code, 'ORDER_ALREADY_ACTIVE');
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM book_order_active_targets').get().count, 1);
  const winner = [first, second].find(result => result.status === 201).body.task;
  const cancelled = await call(db, { auth: person, action: 'cancel', taskId: winner.id,
    expectedUpdatedAt: winner.updatedAt });
  assert.equal(cancelled.status, 200);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM book_order_active_targets WHERE active=1').get().count, 0);
  assert.throws(() => db.database.prepare('UPDATE book_order_active_targets SET active=1 WHERE active=0').run(), /APPEND_ONLY/);
  const afterCancel = await call(db, createBody('ord_after_cancel'));
  assert.equal(afterCancel.status, 201);
  const handedAt = Date.now();
  db.prepare('INSERT INTO book_order_fulfillments(app,task_id,item_index,book_id,student_ids,status,revision,' +
    'teacher_received_at,teacher_received_by,student_handed_at,student_handed_by,created_at,updated_at) ' +
    'VALUES(?,?,?,?,?,?,1,?,?,?,?,?,?)')
    .bind('task', afterCancel.body.task.id, 0, 'BK01', JSON.stringify(['student-a']), 'student_handed',
      handedAt, 'teacher-a', handedAt, 'teacher-a', handedAt, handedAt).run();
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM book_order_active_targets WHERE active=1').get().count, 0);
  assert.equal((await call(db, createBody('ord_after_handed'))).status, 201);
});

test('generic sync cannot create or convert an unsealed scheduled order, but exact legacy upload and cancel remain compatible', async () => {
  const db = new TestD1(); seed(db);
  const now = Date.now();
  const scheduled = { id: 'legacy-new', staffId: 'teacher-a', title: '[주문] 우회', origin: 'staff',
    orderVendor: '문자출판사', orderItems: [{ title: '우회 교재', qty: '1권' }],
    orderDelivery: 'scheduled_batch_v1', createdAt: now, updatedAt: now, deleted: false };
  const newOrder = await call(db, { auth: admin, since: 0, changes: [{ table: 'tasks', id: scheduled.id,
    owner: 'teacher-a', data: scheduled, updated_at: now }] }, '/sync');
  assert.equal(newOrder.status, 409);
  assert.equal(newOrder.body.code, 'BOOK_ORDER_CREATE_REQUIRED');

  const bound = { id: 'ord_bound_bypass', staffId: 'teacher-a', title: '[주문] 제본 우회', origin: 'staff',
    orderItems: [{ bookId: 'bound_pages_1_30', title: '제본 우회', qty: '1권',
      studentIds: ['student-a'], unitPrice: 4000 }],
    orderDelivery: 'bound_print_v1', orderIdentityVersion: 1, createdAt: now, updatedAt: now, deleted: false };
  const boundCreate = await call(db, { auth: admin, since: 0, changes: [{ table: 'tasks', id: bound.id,
    owner: 'teacher-a', data: bound, updated_at: now }] }, '/sync');
  assert.equal(boundCreate.status, 409);
  assert.equal(boundCreate.body.code, 'BOOK_ORDER_CREATE_REQUIRED');

  const ordinary = { ...scheduled, id: 'ordinary-task', title: '일반 업무', orderDelivery: undefined };
  db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', ordinary.id, 'teacher-a', JSON.stringify(ordinary), now, now).run();
  const converted = { ...ordinary, orderDelivery: 'scheduled_batch_v1', updatedAt: now + 1 };
  const conversion = await call(db, { auth: admin, since: 0, changes: [{ table: 'tasks', id: ordinary.id,
    owner: 'teacher-a', data: converted, updated_at: now + 1 }] }, '/sync');
  assert.equal(conversion.body.code, 'BOOK_ORDER_CREATE_REQUIRED');

  db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', 'legacy-existing', 'teacher-a', JSON.stringify({ ...scheduled, id: 'legacy-existing' }), now, now).run();
  const exact = await call(db, { auth: admin, since: 0, changes: [{ table: 'tasks', id: 'legacy-existing',
    owner: 'teacher-a', data: { ...scheduled, id: 'legacy-existing' }, updated_at: now }] }, '/sync');
  assert.equal(exact.status, 200);
  const legacyCancel = { ...scheduled, id: 'legacy-existing', deleted: true, updatedAt: now + 2 };
  const cancelled = await call(db, { auth: admin, since: 0, changes: [{ table: 'tasks', id: 'legacy-existing',
    owner: 'teacher-a', data: legacyCancel, updated_at: now + 2 }] }, '/sync');
  assert.equal(cancelled.status, 200);
  assert.equal(JSON.parse(db.database.prepare("SELECT data FROM tasks WHERE id='legacy-existing'").get().data).deleted, true);
});

test('snapshot rows use one JSON expansion statement and the entire D1 batch rolls back on failure', async () => {
  const db = new TestD1(); seed(db);
  const originalBatch = db.batch.bind(db);
  let statementCount = 0;
  db.batch = statements => {
    statementCount = statements.length;
    db.database.exec('BEGIN');
    try {
      statements[0].run();
      throw new Error('injected batch failure');
    } catch (error) {
      db.database.exec('ROLLBACK');
      return Promise.reject(error);
    }
  };
  const failed = await call(db, createBody('ord_rollback12'));
  assert.equal(failed.status, 500);
  assert.equal(statementCount, 2, '학생 수와 무관하게 task+JSON snapshot 두 statement만 쓴다');
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 0);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM book_order_student_snapshots').get().count, 0);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM book_order_active_targets WHERE active=1').get().count, 0);
  db.batch = originalBatch;
});

test('bound task, identity snapshot, and initial receipt roll back as one three-statement batch', async () => {
  const db = new TestD1(); seed(db);
  const originalBatch = db.batch.bind(db);
  let statementCount = 0;
  db.batch = statements => {
    statementCount = statements.length;
    db.database.exec('BEGIN');
    try {
      statements[0].run();
      statements[1].run();
      throw new Error('injected bound fulfillment failure');
    } catch (error) {
      db.database.exec('ROLLBACK');
      return Promise.reject(error);
    }
  };
  const failed = await call(db, boundBody('ord_bound_rollback'));
  assert.equal(failed.status, 500);
  assert.equal(statementCount, 3);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 0);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM book_order_student_snapshots').get().count, 0);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM book_order_fulfillments').get().count, 0);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM book_order_active_targets WHERE active=1').get().count, 0);
  db.batch = originalBatch;
});

test('bound orders are never picked up by direct or scheduled SMS delivery', async () => {
  const db = new TestD1(); seed(db);
  const created = await call(db, boundBody('ord_bound_no_sms'));
  assert.equal(created.status, 201);
  let fetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetches += 1; throw new Error('must not fetch'); };
  try {
    const direct = await call(db, { auth: admin, taskId: created.body.task.id }, '/book-order-send', {
      WB_BOOK_ORDER_SEND_ENABLED: 'true', SOLAPI_API_KEY: 'key', SOLAPI_API_SECRET: 'secret',
      SOLAPI_SENDER_NUMBER: '0212345678'
    });
    assert.equal(direct.status, 409);
    assert.equal(direct.body.code, 'ORDER_DELIVERY_UNSUPPORTED');
    const scheduled = await handleScheduledBookOrders(env(db, {
      WB_BOOK_ORDER_SEND_ENABLED: 'true', SOLAPI_API_KEY: 'key', SOLAPI_API_SECRET: 'secret',
      SOLAPI_SENDER_NUMBER: '0212345678'
    }), Date.now() + 1000);
    assert.deepEqual(scheduled.results, []);
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(fetches, 0);
});

test('create CAS rejects a roster revision that changes after identity validation without leaving a partial seal', async () => {
  const db = new TestD1(); seed(db);
  const originalBatch = db.batch.bind(db);
  let raced = false;
  db.batch = statements => {
    if (!raced) {
      raced = true;
      const row = db.database.prepare("SELECT data,updated_at FROM private_rosters WHERE app='task'").get();
      const document = JSON.parse(row.data);
      document.roster.students.find(student => student.id === 'student-a').name = '경합학생';
      db.database.prepare("UPDATE private_rosters SET data=?,updated_at=? WHERE app='task'")
        .run(JSON.stringify(document), Number(row.updated_at) + 1);
    }
    return originalBatch(statements);
  };
  const result = await call(db, createBody('ord_roster_race'));
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'ROSTER_REVISION_CONFLICT');
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 0);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM book_order_student_snapshots').get().count, 0);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM book_order_active_targets').get().count, 0);
});

test('the documented 200-student ceiling is stored with only two D1 batch statements', async () => {
  const db = new TestD1(); seed(db);
  const students = Array.from({ length: 200 }, (_, index) => ({
    id: 'bulk-' + String(index).padStart(3, '0'), name: '학생' + index, grade: '중1', teacher: '가선생',
    subject: '영어', start: '2026-08', end: '', reason: '', teacherIds: ['teacher-a']
  }));
  db.prepare('UPDATE private_rosters SET data=?,updated_at=? WHERE app=?')
    .bind(JSON.stringify({ roster: { updated: '2026-08-17', baseline: '2026-08', students }, bookStudents: [] }),
      Date.now(), 'task').run();
  const originalBatch = db.batch.bind(db);
  let statementCount = 0;
  db.batch = statements => { statementCount = statements.length; return originalBatch(statements); };
  const result = await call(db, { auth: person, action: 'create', taskId: 'ord_bulk_200x',
    vendorName: '문자출판사', items: [{ bookId: 'BK-BULK', title: '단체 교재',
      studentIds: students.map(item => item.id), unitPrice: 12000 }] });
  assert.equal(result.status, 201);
  assert.equal(statementCount, 2);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM book_order_student_snapshots').get().count, 200);
});

test('create validates configured message vendor, exact current membership, active state, and teacher scope', async () => {
  const db = new TestD1(); seed(db);
  const reserved = createBody('batch_collision123');
  assert.equal((await call(db, reserved)).body.code, 'ORDER_INVALID');
  const noVendor = createBody('ord_no_vendor1'); noVendor.vendorName = '쿠팡';
  assert.equal((await call(db, noVendor)).body.code, 'ORDER_VENDOR_NOT_CONFIGURED');
  const duplicate = createBody('ord_duplicate1'); duplicate.items[0].studentIds = ['student-a', 'student-a'];
  assert.equal((await call(db, duplicate)).body.code, 'ORDER_INVALID');
  const duplicateBook = createBody('ord_duplicate2'); duplicateBook.items.push({
    bookId: 'BK01', title: '같은 교재', studentIds: ['student-a'], unitPrice: 15000
  });
  assert.equal((await call(db, duplicateBook)).body.code, 'ORDER_INVALID');
  const tooLarge = createBody('ord_too_large1');
  tooLarge.items = Array.from({ length: 50 }, (_, index) => ({
    bookId: 'BK' + index, title: '가'.repeat(160), studentIds: ['student-a'], unitPrice: 15000
  }));
  const oversized = await call(db, tooLarge);
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.code, 'ORDER_MESSAGE_TOO_LARGE');
  const inactive = createBody('ord_inactive1'); inactive.items[0].studentIds = ['student-old'];
  assert.equal((await call(db, inactive)).body.code, 'ORDER_STUDENT_INACTIVE');
  const other = createBody('ord_other1234'); other.items[0].studentIds = ['student-b'];
  assert.equal((await call(db, other)).body.code, 'ORDER_STUDENT_SCOPE');
  const missing = createBody('ord_missing12'); missing.items[0].studentIds = ['student-missing'];
  assert.equal((await call(db, missing)).body.code, 'ORDER_STUDENT_MISSING');
});

test('manager and root use the same sealed create contract while ordinary staff remains scoped', async () => {
  const db = new TestD1(); seed(db);
  const now = Date.now();
  db.prepare('INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', 'manager-a', 'manager-a', JSON.stringify({ id: 'manager-a', name: '관리자', deleted: false }), now, now).run();
  db.prepare('INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)')
    .bind('task', 'token-manager', 'manager-a', now).run();
  const managerBody = createBody('ord_manager12');
  managerBody.auth = { mode: 'person', id: 'manager-a', token: 'token-manager' };
  managerBody.items[0] = { bookId: 'BK-MANAGER', title: '관리 교재', studentIds: ['student-b'], unitPrice: 17000 };
  const manager = await call(db, managerBody, '/book-order', { TASK_MANAGER_STAFF_IDS: 'manager-a' });
  assert.equal(manager.status, 201);
  assert.equal(manager.body.task.origin, 'manager');
  assert.equal(manager.body.task.staffId, 'manager-a');

  const rootBody = createBody('ord_root_1234');
  rootBody.auth = admin;
  rootBody.items[0] = { bookId: 'BK-ROOT', title: '원장 교재', studentIds: ['student-a'], unitPrice: 18000 };
  const root = await call(db, rootBody);
  assert.equal(root.status, 201);
  assert.equal(root.body.task.origin, 'admin');
  assert.equal(root.body.task.staffId, null);
});

test('sealed cancel is CAS/idempotent, append-only, and cannot race or follow an active send', async () => {
  const db = new TestD1(); seed(db);
  const created = await call(db, createBody('ord_cancel123'));
  const at = created.body.task.updatedAt;
  db.prepare('INSERT INTO book_order_dispatch_lock(app,owner,lease_until,updated_at) VALUES(?,?,?,?)')
    .bind('task', 'cron-live', Date.now() + 60_000, Date.now()).run();
  assert.equal((await call(db, { auth: person, action: 'cancel', taskId: 'ord_cancel123', expectedUpdatedAt: at })).body.code,
    'ORDER_CANCEL_SEND_ACTIVE');
  db.database.prepare("DELETE FROM book_order_dispatch_lock WHERE app='task'").run();
  const cancelled = await call(db, { auth: person, action: 'cancel', taskId: 'ord_cancel123', expectedUpdatedAt: at });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.task.deleted, true);
  assert.ok(cancelled.body.task.orderCancelledAt > 0);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM book_order_cancellations').get().count, 1);
  const again = await call(db, { auth: person, action: 'cancel', taskId: 'ord_cancel123', expectedUpdatedAt: at });
  assert.equal(again.body.idempotent, true);

  const active = await call(db, createBody('ord_active123'));
  const now = Date.now();
  db.prepare('INSERT INTO book_order_sends(app,send_id,idempotency_key,task_id,vendor_name,item_count,message_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .bind('task', 'send-active', 'key-active', 'ord_active123', '문자출판사', 1, 'a'.repeat(64), 'accepted', now, now).run();
  const blocked = await call(db, { auth: person, action: 'cancel', taskId: 'ord_active123', expectedUpdatedAt: active.body.task.updatedAt });
  assert.equal(blocked.body.code, 'ORDER_CANCEL_SEND_ACTIVE');
  assert.equal(JSON.parse(db.database.prepare("SELECT data FROM tasks WHERE id='ord_active123'").get().data).deleted, false);
});

test('pending sealed orders block roster rename/removal through handoff and release only after academy registration', async () => {
  const db = new TestD1(); seed(db);
  const created = await call(db, createBody('ord_roster_lock'));
  assert.equal(created.status, 201);
  const detail = await call(db, { auth: admin, action: 'student_get', studentId: 'student-a' }, '/roster');
  const renamed = { ...detail.body.student, name: '이름변경' };
  let result = await call(db, { auth: admin, action: 'student_update',
    expectedUpdatedAt: detail.body.updatedAt, student: renamed }, '/roster');
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'ACTIVE_BOOK_ORDER_CONFLICT');

  const removed = roster();
  removed.roster.students = removed.roster.students.filter(student => student.id !== 'student-a');
  result = await call(db, { auth: admin, action: 'replace', document: removed }, '/roster');
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'ACTIVE_BOOK_ORDER_CONFLICT');
  assert.throws(() => db.database.prepare("UPDATE private_rosters SET data=? WHERE app='task'")
    .run(JSON.stringify(removed)), /ACTIVE_BOOK_ORDER_CONFLICT/);

  const now = Date.now();
  db.prepare('INSERT INTO book_order_fulfillments(app,task_id,item_index,book_id,student_ids,status,revision,' +
    'teacher_received_at,teacher_received_by,student_handed_at,student_handed_by,created_at,updated_at) ' +
    'VALUES(?,?,?,?,?,?,1,?,?,?,?,?,?)')
    .bind('task', created.body.task.id, 0, 'BK01', JSON.stringify(['student-a']), 'student_handed',
      now, 'teacher-a', now, 'teacher-a', now, now).run();
  result = await call(db, { auth: admin, action: 'student_update',
    expectedUpdatedAt: detail.body.updatedAt, student: renamed }, '/roster');
  assert.equal(result.body.code, 'ACTIVE_BOOK_ORDER_CONFLICT');

  db.prepare("UPDATE book_order_fulfillments SET status='academy_registered',revision=2," +
    'academy_registered_at=?,academy_registered_by=?,updated_at=? WHERE app=? AND task_id=? AND item_index=0')
    .bind(now + 1, 'director', now + 1, 'task', created.body.task.id).run();
  result = await call(db, { auth: admin, action: 'student_update',
    expectedUpdatedAt: detail.body.updatedAt, student: renamed }, '/roster');
  assert.equal(result.status, 200);
});

test('ord namespace or seal marker without snapshots is partial state and never a legacy send', async () => {
  const db = new TestD1(); seed(db);
  const now = Date.now();
  const task = {
    id: 'ord_partial12', staffId: 'teacher-a', title: '[주문] 부분 봉인', orderVendor: '문자출판사',
    orderItems: [{ bookId: 'BK01', title: '부분 봉인 교재', studentIds: ['student-a'], qty: '1권' }],
    orderDelivery: 'scheduled_batch_v1', orderIdentityVersion: 1,
    createdAt: now, updatedAt: now, deleted: false
  };
  db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', task.id, 'teacher-a', JSON.stringify(task), now, now).run();
  let fetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetches += 1; throw new Error('must not fetch'); };
  try {
    const direct = await call(db, { auth: admin, taskId: task.id }, '/book-order-send', {
      WB_BOOK_ORDER_SEND_ENABLED: 'true', SOLAPI_API_KEY: 'key', SOLAPI_API_SECRET: 'secret',
      SOLAPI_SENDER_NUMBER: '0212345678'
    });
    assert.equal(direct.status, 409);
    assert.equal(direct.body.code, 'ORDER_IDENTITY_MISMATCH');
    const scheduled = await handleScheduledBookOrders(env(db, {
      WB_BOOK_ORDER_SEND_ENABLED: 'true', SOLAPI_API_KEY: 'key', SOLAPI_API_SECRET: 'secret',
      SOLAPI_SENDER_NUMBER: '0212345678'
    }), now + 1);
    assert.equal(scheduled.results[0].status, 'ORDER_IDENTITY_MISMATCH');
    assert.equal((await call(db, createBody(task.id))).body.code, 'ORDER_ID_CONFLICT');
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(fetches, 0);
});

test('identity reuse blocks send/fulfillment/public while verified ledgers expose only safe stages', async () => {
  const db = new TestD1(); seed(db);
  const created = await call(db, createBody('ord_public12'));
  let publicView = await readPublicBookStatus({ DB: db }, 'student-a', Date.now());
  assert.deepEqual(publicView.rows.map(row => [row.kind, row.title, row.stage]), [
    ['order', '주문 교재', 'order_waiting']
  ]);

  const now = Date.now();
  for (const [sendId, taskId, status, createdAt] of [
    ['send-old', 'ord_public12', 'rejected', now],
    ['send-new', 'retry-batch', 'accepted', now + 1]
  ]) db.prepare('INSERT INTO book_order_sends(app,send_id,idempotency_key,task_id,vendor_name,item_count,message_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .bind('task', sendId, 'key-' + sendId, taskId, '문자출판사', 1, 'b'.repeat(64), status, createdAt, createdAt).run();
  db.prepare('INSERT INTO book_order_batch_items(app,task_id,send_id,created_at) VALUES(?,?,?,?)')
    .bind('task', 'ord_public12', 'send-new', now + 1).run();
  publicView = await readPublicBookStatus({ DB: db }, 'student-a', now + 2);
  assert.equal(publicView.rows[0].stage, 'ordered');

  db.prepare('INSERT INTO book_order_fulfillments(app,task_id,item_index,book_id,student_ids,status,revision,' +
    'teacher_received_at,teacher_received_by,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?,?,?)')
    .bind('task', 'ord_public12', 0, 'BK01', JSON.stringify(['student-a']), 'teacher_received', now + 2,
      'teacher-a', now + 2, now + 2).run();
  publicView = await readPublicBookStatus({ DB: db }, 'student-a', now + 3);
  assert.equal(publicView.rows[0].stage, 'academy_received');
  assert.deepEqual(Object.keys(publicView.rows[0]).sort(), ['kind', 'label', 'stage', 'title', 'updatedAt']);
  assert.doesNotMatch(JSON.stringify(publicView), /student-a|teacher-a|BK01|문자출판사|send-new/);

  assert.throws(() => db.prepare('UPDATE private_rosters SET data=?,updated_at=? WHERE app=?')
    .bind(JSON.stringify(roster('새학생')), now + 4, 'task').run(), /ACTIVE_BOOK_ORDER_CONFLICT/);
  db.database.exec('DROP TRIGGER trg_book_order_roster_identity_update');
  db.prepare('UPDATE private_rosters SET data=?,updated_at=? WHERE app=?')
    .bind(JSON.stringify(roster('새학생')), now + 4, 'task').run();
  publicView = await readPublicBookStatus({ DB: db }, 'student-a', now + 5);
  assert.deepEqual(publicView.rows, []);
  const send = await call(db, { auth: person, taskId: created.body.task.id }, '/book-order-send', {
    WB_BOOK_ORDER_SEND_ENABLED: 'false'
  });
  assert.equal(send.status, 409);
  assert.equal(send.body.code, 'ORDER_STUDENT_IDENTITY_CHANGED');
});

test('manual online orders are never accepted by the direct SMS endpoint', async () => {
  const db = new TestD1(); seed(db);
  const now = Date.now();
  const task = { id: 'manual-online', staffId: 'teacher-a', title: '[주문] 온라인 교재',
    orderVendor: '문자출판사', orderItems: [{ title: '온라인 교재', qty: '1권' }],
    orderDelivery: 'manual_online_v1', createdAt: now, updatedAt: now, deleted: false };
  db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', task.id, 'teacher-a', JSON.stringify(task), now, now).run();
  const result = await call(db, { auth: person, taskId: task.id }, '/book-order-send', {
    WB_BOOK_ORDER_SEND_ENABLED: 'true'
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'ORDER_DELIVERY_UNSUPPORTED');
});

test('sealed orders cannot bypass the 20:00 batch through direct send, even for root', async () => {
  const db = new TestD1(); seed(db);
  const created = await call(db, createBody('ord_scheduled1'));
  let fetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetches += 1; throw new Error('must not fetch'); };
  try {
    const result = await call(db, { auth: admin, taskId: created.body.task.id }, '/book-order-send', {
      WB_BOOK_ORDER_SEND_ENABLED: 'true', SOLAPI_API_KEY: 'key', SOLAPI_API_SECRET: 'secret',
      SOLAPI_SENDER_NUMBER: '0212345678'
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'ORDER_SCHEDULED_ONLY');
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(fetches, 0);
});

test('scheduled dispatch lease serializes cancel through provider acceptance', async () => {
  const db = new TestD1(); seed(db);
  const created = await call(db, createBody('ord_race1234'));
  let releaseText;
  let enteredFetch;
  const entered = new Promise(resolve => { enteredFetch = resolve; });
  const text = new Promise(resolve => { releaseText = resolve; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    enteredFetch();
    return { ok: true, status: 200, text: () => text };
  };
  try {
    const sendPromise = handleScheduledBookOrders(env(db, {
      WB_BOOK_ORDER_SEND_ENABLED: 'true', SOLAPI_API_KEY: 'key', SOLAPI_API_SECRET: 'secret',
      SOLAPI_SENDER_NUMBER: '0212345678'
    }), Date.now() + 1000);
    await entered;
    const blocked = await call(db, { auth: person, action: 'cancel', taskId: 'ord_race1234',
      expectedUpdatedAt: created.body.task.updatedAt });
    assert.equal(blocked.body.code, 'ORDER_CANCEL_SEND_ACTIVE');
    releaseText(JSON.stringify({ groupInfo: { groupId: 'group-safe' },
      messageList: [{ messageId: 'message-safe', statusCode: '2000' }] }));
    const sent = await sendPromise;
    assert.equal(sent.results[0].status, 'accepted');
    const after = await call(db, { auth: person, action: 'cancel', taskId: 'ord_race1234',
      expectedUpdatedAt: created.body.task.updatedAt });
    assert.equal(after.body.code, 'ORDER_CANCEL_SEND_ACTIVE');
  } finally { globalThis.fetch = originalFetch; }
});
