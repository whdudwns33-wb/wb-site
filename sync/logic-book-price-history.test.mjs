import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import worker from './worker-core.js';
import { verifyOrderTaskSnapshotRows } from './book-order-create.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const administrator = { mode: 'admin', secret: 'synthetic-history-admin' };
const teacher = { mode: 'person', id: 'history-teacher-a', token: 'synthetic-history-token-a' };
const otherTeacher = { mode: 'person', id: 'history-teacher-b', token: 'synthetic-history-token-b' };
const HISTORICAL_TASK_ID = 'ord_history_logic_leap_01';
const HISTORICAL_PRICE = 26000;
const CURRENT_PRICE = 28000;

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
  constructor() { this.database = new DatabaseSync(':memory:'); this.database.exec(schema); }
  prepare(sql) { return new Statement(this.database, sql); }
  batch(statements) {
    this.database.exec('BEGIN');
    try {
      const result = statements.map(statement => statement.run());
      this.database.exec('COMMIT');
      return Promise.resolve(result);
    } catch (error) {
      this.database.exec('ROLLBACK');
      return Promise.reject(error);
    }
  }
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function roster() {
  return {
    roster: {
      updated: '2026-08-31', baseline: '2026-08', students: [
        { id: '10000001', name: '가격보존학생', school: '예제초등학교', grade: '초3',
          teacher: '예제선생가', teacherIds: [teacher.id], subject: '국어',
          start: '2000-01', end: '', reason: '' },
        { id: '10000002', name: '다른예제학생', school: '예제초등학교', grade: '초4',
          teacher: '예제선생나', teacherIds: [otherTeacher.id], subject: '국어',
          start: '2000-01', end: '', reason: '' }
      ]
    },
    bookStudents: []
  };
}

function seedPeople(database) {
  const now = Date.now();
  for (const [auth, name, studentId] of [
    [teacher, '예제선생가', '10000001'], [otherTeacher, '예제선생나', '10000002']
  ]) {
    database.prepare('INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
      .run('task', auth.id, auth.id, JSON.stringify({ id: auth.id, name, deleted: false }), now, now);
    database.prepare('INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)')
      .run('task', auth.token, auth.id, now);
    const id = 'lesson-' + auth.id;
    database.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
      .run('task', id, auth.id, JSON.stringify({ id, staffId: auth.id, studentId,
        taskKind: 'lesson_instruction', lessonFormVersion: 1, intakeVersion: 1,
        title: '[수업] 가격 검증용 수업', start: '2000-01-01', end: '', deleted: false }), now, now);
  }
  database.prepare('INSERT INTO private_rosters(app,data,updated_at) VALUES(?,?,?)')
    .run('task', JSON.stringify(roster()), now);
}

function seedHistoricalOrder(database) {
  // Model an order made by an older server catalog. Insert its canonical task,
  // then its genuine hashes and receipt in creation order; never disable or
  // remove the production append-only/sealed-order triggers.
  const now = Date.now() - 3 * 24 * 60 * 60 * 1000;
  const productCode = 'logic_leap';
  const volume = 1;
  const title = '논리와 상상 도약 1권';
  const label = '도약 1권';
  const studentIds = ['10000001'];
  const bookId = 'INTERNAL_' + sha256(JSON.stringify(['internal_book_v1', productCode, volume])).slice(0, 45);
  const studentSetHash = sha256(JSON.stringify(studentIds));
  const itemIdentityHash = sha256(JSON.stringify([bookId, title, '1권', studentSetHash, HISTORICAL_PRICE]));
  const taskIdentityHash = sha256(JSON.stringify([HISTORICAL_TASK_ID, teacher.id, '내부교재', [itemIdentityHash]]));
  const studentIdentityHash = sha256(studentIds[0] + '\n' + roster().roster.students[0].name);
  const task = {
    id: HISTORICAL_TASK_ID, groupId: 'internal-order-' + now, staffId: teacher.id,
    title: '[주문] ' + title, detail: title + ': 1권 · ' + label,
    guide: '내부 교재 주문입니다.\n1) 주문 즉시 선생님 수령 단계로 등록\n2) 배부 후 아카등록 완료 처리',
    steps: [{ id: 'synthetic-historical-step', label: '배부 후 아카등록' }],
    target: 0, unit: '건', time: '', priority: 'normal', repeat: 'once', days: [],
    start: new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10), end: '', carry: true,
    orderVendor: '내부교재', orderItems: [{ bookId, title, studentIds, qty: '1권', unitPrice: HISTORICAL_PRICE }],
    orderDelivery: 'internal_book_v1', orderIdentityVersion: 1,
    internalProductCode: productCode, internalProductLabel: label, internalProductVolume: volume,
    createdAt: now, updatedAt: now, deleted: false, origin: 'staff'
  };
  database.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .run('task', task.id, teacher.id, JSON.stringify(task), now, now);
  database.prepare('INSERT INTO book_order_student_snapshots(' +
    'app,task_id,item_index,owner_id,book_id,public_title,student_id,student_identity_hash,' +
    'student_set_hash,item_identity_hash,task_identity_hash,expected_item_count,expected_row_count,created_at' +
    ') VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('task', task.id, 0, teacher.id, bookId, '주문 교재', studentIds[0], studentIdentityHash,
      studentSetHash, itemIdentityHash, taskIdentityHash, 1, 1, now);
  database.prepare('INSERT INTO book_order_fulfillments(' +
    'app,task_id,item_index,book_id,student_ids,status,revision,teacher_received_at,' +
    'teacher_received_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run('task', task.id, 0, bookId, JSON.stringify(studentIds), 'teacher_received', 1, now, teacher.id, now, now);
  return task;
}

function fixture(t) {
  const db = new TestD1();
  t.after(() => db.database.close());
  seedPeople(db.database);
  return { db, historical: seedHistoricalOrder(db.database) };
}

async function call(db, body, path = '/book-order') {
  const response = await worker.fetch(new Request('https://worker.example' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app: 'task', ...body })
  }), { DB: db, TASK_ADMIN_SECRET: administrator.secret });
  return { status: response.status, body: await response.json() };
}

function request(overrides = {}) {
  return { auth: teacher, action: 'create_internal', taskId: HISTORICAL_TASK_ID,
    productCode: 'logic_leap', volume: 1, studentIds: ['10000001'], ...overrides };
}

function storedTask(database) {
  return database.prepare('SELECT data FROM tasks WHERE app=? AND id=?').get('task', HISTORICAL_TASK_ID).data;
}

function snapshots(database) {
  return database.prepare('SELECT * FROM book_order_student_snapshots WHERE app=? AND task_id=?')
    .all('task', HISTORICAL_TASK_ID);
}

async function listedOrder(db, auth = teacher) {
  const result = await call(db, { auth, action: 'list' }, '/book-issue');
  assert.equal(result.status, 200);
  const order = result.body.orders.find(row => row.taskId === HISTORICAL_TASK_ID);
  assert.ok(order, 'the historical sealed order remains in the fulfillment/history listing');
  assert.equal(order.integrity, '');
  assert.equal(order.unitPrice, HISTORICAL_PRICE);
  assert.deepEqual(order.students.map(student => student.id), ['10000001']);
  return order;
}

test('sealed historical logic price survives receipt, student handoff, academy registration, and history', async t => {
  const { db, historical } = fixture(t);
  const originalTask = storedTask(db.database);
  const originalSnapshots = snapshots(db.database);
  assert.notEqual(HISTORICAL_PRICE, CURRENT_PRICE);
  const verification = await verifyOrderTaskSnapshotRows(historical.id, teacher.id, historical,
    originalSnapshots, roster(), Date.now(), false);
  assert.equal(verification.valid, true);
  assert.equal((await listedOrder(db)).stage, 'teacher_received');

  const handed = await call(db, { auth: teacher, action: 'order_transition', taskId: historical.id,
    itemIndex: 0, next: 'hand', revision: 1 }, '/book-issue');
  assert.equal(handed.status, 200);
  assert.equal(handed.body.status, 'student_handed');
  assert.equal((await listedOrder(db)).stage, 'student_handed');

  const registered = await call(db, { auth: administrator, action: 'order_transition', taskId: historical.id,
    itemIndex: 0, next: 'academy_register', revision: 2 }, '/book-issue');
  assert.equal(registered.status, 200);
  assert.equal(registered.body.status, 'academy_registered');
  const history = await listedOrder(db, administrator);
  assert.equal(history.title, '논리와 상상 도약 1권');
  assert.ok(history.studentHandedAt);
  assert.ok(history.academyRegisteredAt);
  assert.equal(storedTask(db.database), originalTask);
  assert.deepEqual(snapshots(db.database), originalSnapshots);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS n FROM completed_book_catalog').get().n, 0,
    'internal books must not become external-book catalog candidates');

  const current = await call(db, request({ taskId: 'ord_current_logic_leap_01' }));
  assert.equal(current.status, 201);
  assert.equal(current.body.task.orderItems[0].unitPrice, CURRENT_PRICE,
    'only a newly created order uses the current server catalog price');
  assert.equal((await listedOrder(db, administrator)).unitPrice, HISTORICAL_PRICE);
  assert.equal(storedTask(db.database), originalTask);
});

test('identical internal-order retries return the sealed old price without any database writes', async t => {
  const { db, historical } = fixture(t);
  for (const status of ['teacher_received', 'student_handed', 'academy_registered']) {
    if (status !== 'teacher_received') {
      const transition = await call(db, { auth: status === 'student_handed' ? teacher : administrator,
        action: 'order_transition', taskId: historical.id, itemIndex: 0,
        next: status === 'student_handed' ? 'hand' : 'academy_register',
        revision: status === 'student_handed' ? 1 : 2 }, '/book-issue');
      assert.equal(transition.status, 200);
    }
    const before = db.database.prepare('SELECT total_changes() AS n').get().n;
    const retry = await call(db, request());
    assert.equal(retry.status, 200, status);
    assert.equal(retry.body.idempotent, true, status);
    assert.deepEqual(retry.body.task, historical, status);
    assert.equal(retry.body.task.orderItems[0].unitPrice, HISTORICAL_PRICE, status);
    assert.equal(db.database.prepare('SELECT total_changes() AS n').get().n, before, status);
  }
});

test('old-price retries still reject different volume, product, student, or authenticated owner', async t => {
  const { db } = fixture(t);
  for (const [description, change] of [
    ['volume', { volume: 2 }], ['product', { productCode: 'logic_basic' }],
    ['student', { studentIds: ['10000002'] }], ['owner', { auth: otherTeacher }]
  ]) {
    const before = db.database.prepare('SELECT total_changes() AS n').get().n;
    const result = await call(db, request(change));
    assert.equal(result.status, 409, description);
    assert.equal(result.body.code, 'ORDER_ID_CONFLICT', description);
    assert.equal(db.database.prepare('SELECT total_changes() AS n').get().n, before, description);
  }
  assert.equal((await listedOrder(db)).unitPrice, HISTORICAL_PRICE);
});

test('stored price remains hash-protected even when a tampered value equals the current catalog price', async t => {
  const { db, historical } = fixture(t);
  const rows = snapshots(db.database);
  for (const [description, mutate] of [
    ['current price', task => { task.orderItems[0].unitPrice = CURRENT_PRICE; }],
    ['another positive price', task => { task.orderItems[0].unitPrice = 24000; }],
    ['missing price', task => { delete task.orderItems[0].unitPrice; }],
    ['zero price', task => { task.orderItems[0].unitPrice = 0; }]
  ]) {
    const changed = structuredClone(historical);
    mutate(changed);
    const verification = await verifyOrderTaskSnapshotRows(changed.id, teacher.id, changed,
      rows, roster(), Date.now(), false);
    assert.equal(verification.valid, false, description);
    assert.equal(verification.code, 'ORDER_IDENTITY_MISMATCH', description);
  }
  assert.throws(() => db.database.prepare(
    "UPDATE tasks SET data=json_set(data,'$.orderItems[0].unitPrice',?) WHERE app=? AND id=?"
  ).run(CURRENT_PRICE, 'task', historical.id), /BOOK_ORDER_SEALED/);
  assert.throws(() => db.database.prepare(
    'UPDATE book_order_student_snapshots SET item_identity_hash=? WHERE app=? AND task_id=?'
  ).run('0'.repeat(64), 'task', historical.id), /BOOK_ORDER_SNAPSHOT_APPEND_ONLY/);
  assert.equal((await listedOrder(db)).unitPrice, HISTORICAL_PRICE);
});

test('internal retry and new-order requests never accept a caller-supplied price or title', async t => {
  const { db } = fixture(t);
  for (const taskId of [HISTORICAL_TASK_ID, 'ord_untrusted_logic_price']) {
    for (const field of [{ unitPrice: HISTORICAL_PRICE }, { unitPrice: 1 }, { title: '임의 교재명' }]) {
      const before = db.database.prepare('SELECT total_changes() AS n').get().n;
      const result = await call(db, request({ taskId, ...field }));
      assert.equal(result.status, 400);
      assert.equal(result.body.code, 'ORDER_INVALID');
      assert.equal(db.database.prepare('SELECT total_changes() AS n').get().n, before);
    }
  }
});
