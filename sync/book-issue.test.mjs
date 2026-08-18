import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import worker from './worker-core.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/022_book_issues.sql', import.meta.url), 'utf8');
const fulfillmentMigration = fs.readFileSync(new URL('./migrations/031_book_order_fulfillments.sql', import.meta.url), 'utf8');
const priceMigration = fs.readFileSync(new URL('./migrations/043_book_order_item_prices.sql', import.meta.url), 'utf8');
const correctionMigration = fs.readFileSync(new URL('./migrations/044_book_order_item_price_corrections.sql', import.meta.url), 'utf8');
const KIM_NAMGI_STAFF_ID = '84349fea-f2f0-4fc3-b32a-aaef1e466d54';

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  first() { return this.db.prepare(this.sql).get(...this.args) || null; }
  all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  run() { const r = this.db.prepare(this.sql).run(...this.args); return { meta: { changes: Number(r.changes || 0) } }; }
}
class TestD1 {
  constructor() { this.database = new DatabaseSync(':memory:'); this.database.exec(schema); }
  prepare(sql) { return new Statement(this.database, sql); }
}

const admin = { mode: 'admin', secret: 'director-secret' };
const person = (id, token) => ({ mode: 'person', id, token });
const clone = value => JSON.parse(JSON.stringify(value));

function roster() {
  return {
    roster: { updated: '2026-08-11', baseline: '2026-08', students: [
      { id: 'student-a', name: '가학생', grade: '중1', teacher: '가선생', subject: '수학', start: '2026-08', end: '', reason: '', teacherIds: ['teacher-a', KIM_NAMGI_STAFF_ID] },
      { id: 'student-b', name: '나학생', grade: '중2', teacher: '나선생', subject: '국어', start: '2026-08', end: '', reason: '', teacherIds: ['teacher-b'] }
    ] },
    bookStudents: [
      { id: 'assign-a', studentId: 'student-a', name: '가학생', teacher: '가선생', bookId: 'BK01', at: '', perWeek: 2, goal: '', teacherIds: ['teacher-a'] },
      { id: 'assign-b', studentId: 'student-b', name: '나학생', teacher: '나선생', bookId: 'BK02', at: '', perWeek: 1, goal: '', teacherIds: ['teacher-b'] }
    ]
  };
}

function seed(db) {
  const now = Date.now();
  for (const [id, token] of [['teacher-a', 'token-a'], ['teacher-b', 'token-b'], [KIM_NAMGI_STAFF_ID, 'token-kim']]) {
    db.prepare('INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
      .bind('task', id, id, JSON.stringify({ id, name: id, deleted: false }), now, now).run();
    db.prepare('INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)')
      .bind('task', token, id, now).run();
  }
  db.prepare('INSERT INTO private_rosters(app,data,updated_at) VALUES(?,?,?)')
    .bind('task', JSON.stringify(roster()), now).run();
}

async function call(db, body, path = '/book-issue') {
  const response = await worker.fetch(new Request('https://worker.example' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app: 'task', ...body })
  }), { DB: db, TASK_ADMIN_SECRET: 'director-secret', CONSULT_ADMIN_SECRET: 'consult-secret' });
  return { status: response.status, body: await response.json() };
}

test('schema and migration are additive and store no student name or contact', () => {
  for (const sql of [schema, migration]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS book_issues/);
    for (const status of ['prepared', 'issued', 'handed', 'cancelled']) assert.ok(sql.includes("'" + status + "'"));
    const start = sql.indexOf('CREATE TABLE IF NOT EXISTS book_issues');
    const definition = sql.slice(start, sql.indexOf(');', start) + 2);
    assert.doesNotMatch(definition, /DROP TABLE|DELETE FROM/i);
  }
  const table = migration.slice(migration.indexOf('CREATE TABLE'), migration.indexOf(');') + 2);
  assert.doesNotMatch(table, /student_name|phone|address|memo/i);
});

test('order fulfillment migration is additive and stores stable ids without display names or contacts', () => {
  for (const sql of [schema, fulfillmentMigration]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS book_order_fulfillments/);
    for (const status of ['teacher_received', 'student_handed', 'academy_registered']) assert.ok(sql.includes("'" + status + "'"));
    const start = sql.indexOf('CREATE TABLE IF NOT EXISTS book_order_fulfillments');
    const definition = sql.slice(start, sql.indexOf(');', start) + 2);
    assert.doesNotMatch(definition, /DROP TABLE|DELETE FROM/i);
  }
  const table = fulfillmentMigration.slice(fulfillmentMigration.indexOf('CREATE TABLE'), fulfillmentMigration.indexOf(');') + 2);
  assert.match(table, /student_ids/);
  assert.doesNotMatch(table, /student_name|phone|address|memo/i);
});

test('list is authenticated and scoped by current assignment teacherIds', async () => {
  const db = new TestD1(); seed(db);
  assert.equal((await call(db, { action: 'list' })).status, 401);
  const own = await call(db, { auth: person('teacher-a', 'token-a'), action: 'list' });
  assert.deepEqual(own.body.issues.map(item => item.assignmentId), ['assign-a']);
  assert.equal(own.body.issues[0].status, 'none');
  assert.equal(JSON.stringify(own.body).includes('teacherIds'), false);
  assert.equal(JSON.stringify(own.body).includes('phone'), false);
  const all = await call(db, { auth: admin, action: 'list' });
  assert.equal(all.body.issues.length, 2);
});

test('prepared to issued to handed uses CAS and duplicate clicks are idempotent', async () => {
  const db = new TestD1(); seed(db);
  const auth = person('teacher-a', 'token-a');
  const prepared = await call(db, { auth, action: 'transition', assignmentId: 'assign-a', next: 'prepared', revision: 0 });
  assert.equal(prepared.status, 200);
  assert.equal(prepared.body.issue.status, 'prepared');
  assert.equal(prepared.body.issue.revision, 1);
  const duplicate = await call(db, { auth, action: 'transition', assignmentId: 'assign-a', next: 'prepared', revision: 0 });
  assert.equal(duplicate.body.idempotent, true);
  const issued = await call(db, { auth, action: 'transition', assignmentId: 'assign-a', next: 'issued', revision: 1 });
  assert.equal(issued.body.issue.status, 'issued');
  assert.ok(issued.body.issue.issuedAt);
  const handed = await call(db, { auth, action: 'transition', assignmentId: 'assign-a', next: 'handed', revision: 2 });
  assert.equal(handed.body.issue.status, 'handed');
  assert.ok(handed.body.issue.handedAt);
  assert.deepEqual(handed.body.issue.history.map(event => event.action), ['prepared', 'issued', 'handed']);
  const stale = await call(db, { auth, action: 'transition', assignmentId: 'assign-a', next: 'cancelled', revision: 1, reason: '착오' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'REVISION_CONFLICT');
});

test('none may skip to issued; cancel and reissue require reasons and create a new prepared cycle', async () => {
  const db = new TestD1(); seed(db);
  const auth = person('teacher-a', 'token-a');
  const issued = await call(db, { auth, action: 'transition', assignmentId: 'assign-a', next: 'issued', revision: 0 });
  assert.equal(issued.body.issue.status, 'issued');
  assert.ok(issued.body.issue.preparedAt);
  assert.equal((await call(db, { auth, action: 'transition', assignmentId: 'assign-a', next: 'cancelled', revision: 1 })).status, 400);
  const cancelled = await call(db, { auth, action: 'transition', assignmentId: 'assign-a', next: 'cancelled', revision: 1, reason: '학생 변경' });
  assert.equal(cancelled.body.issue.status, 'cancelled');
  assert.equal((await call(db, { auth, action: 'transition', assignmentId: 'assign-a', next: 'reissue', revision: 2 })).status, 400);
  const reissued = await call(db, { auth, action: 'transition', assignmentId: 'assign-a', next: 'reissue', revision: 2, reason: '새 교재 준비' });
  assert.equal(reissued.body.issue.status, 'prepared');
  assert.equal(reissued.body.issue.cycle, 2);
  assert.equal(reissued.body.issue.reissueReason, '새 교재 준비');
  assert.equal(reissued.body.issue.issuedAt, null);
});

test('server rejects unassigned staff, missing assignments, and invalid transitions', async () => {
  const db = new TestD1(); seed(db);
  assert.equal((await call(db, { auth: person('teacher-b', 'token-b'), action: 'transition', assignmentId: 'assign-a', next: 'prepared', revision: 0 })).status, 403);
  assert.equal((await call(db, { auth: admin, action: 'transition', assignmentId: 'missing', next: 'prepared', revision: 0 })).status, 404);
  assert.equal((await call(db, { auth: admin, action: 'transition', assignmentId: 'assign-a', next: 'handed', revision: 0 })).status, 409);
});

test('roster replace blocks removal or identity change while issue is active', async () => {
  const db = new TestD1(); seed(db);
  await call(db, { auth: admin, action: 'transition', assignmentId: 'assign-a', next: 'prepared', revision: 0 });
  const removed = clone(roster()); removed.bookStudents.shift();
  const r1 = await call(db, { auth: admin, action: 'replace', document: removed }, '/roster');
  assert.equal(r1.status, 409);
  assert.equal(r1.body.code, 'ACTIVE_BOOK_ISSUE_CONFLICT');
  const changed = clone(roster()); changed.bookStudents[0].bookId = 'BK99';
  const r2 = await call(db, { auth: admin, action: 'replace', document: changed }, '/roster');
  assert.equal(r2.status, 409);
  await call(db, { auth: admin, action: 'transition', assignmentId: 'assign-a', next: 'issued', revision: 1 });
  await call(db, { auth: admin, action: 'transition', assignmentId: 'assign-a', next: 'handed', revision: 2 });
  const afterCompletion = await call(db, { auth: admin, action: 'replace', document: removed }, '/roster');
  assert.equal(afterCompletion.status, 200, '인계 완료 뒤에는 배정 정리가 가능하다');
});

test('admin sees orphan/identity warnings while ordinary staff fail closed', async () => {
  const db = new TestD1(); seed(db);
  await call(db, { auth: admin, action: 'transition', assignmentId: 'assign-a', next: 'issued', revision: 0 });
  db.prepare("UPDATE book_issues SET status='handed' WHERE app='task' AND assignment_id='assign-a'").run();
  const changed = clone(roster()); changed.bookStudents[0].bookId = 'BK99';
  db.prepare("UPDATE private_rosters SET data=? WHERE app='task'").bind(JSON.stringify(changed)).run();
  const all = await call(db, { auth: admin, action: 'list' });
  assert.equal(all.body.warnings[0].code, 'ASSIGNMENT_IDENTITY_MISMATCH');
  assert.equal(all.body.issues.find(item => item.assignmentId === 'assign-a').integrity, 'mismatch');
  const own = await call(db, { auth: person('teacher-a', 'token-a'), action: 'list' });
  assert.equal(own.body.warnings.length, 0);
  assert.equal(own.body.issues.some(item => item.assignmentId === 'assign-a'), false);
});

test('new order moves through accepted, teacher received, student handed, and admin academy registration', async () => {
  const db = new TestD1(); seed(db);
  const now = Date.now();
  const task = {
    id: 'order-a', staffId: 'teacher-a', title: '[주문] 새 교재', deleted: false,
    orderDelivery: 'scheduled_batch_v1', orderVendor: '테스트출판사',
    orderItems: [{ bookId: 'BK01', title: '새 교재', qty: '1권', studentIds: ['student-a'], unitPrice: 15000 }],
    origin: 'staff', createdAt: now, updatedAt: now
  };
  db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', task.id, 'teacher-a', JSON.stringify(task), now, now).run();

  const waiting = await call(db, { auth: person('teacher-a', 'token-a'), action: 'list' });
  assert.equal(waiting.body.orders[0].stage, 'order_waiting');
  assert.equal(waiting.body.orders[0].unitPrice, 15000);
  assert.equal(waiting.body.orders[0].orderRequestedAt, now);
  assert.equal(waiting.body.orders[0].orderCompletedAt, null);
  assert.equal(waiting.body.orders[0].teacherReceivedAt, null);
  assert.equal(waiting.body.orders[0].studentHandedAt, null);
  assert.deepEqual(waiting.body.orders[0].students.map(student => student.id), ['student-a']);
  assert.equal(JSON.stringify(waiting.body.orders).includes('teacherIds'), false);

  db.prepare('INSERT INTO book_order_sends(app,send_id,idempotency_key,task_id,vendor_name,item_count,message_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .bind('task', 'send-a', 'key-a', 'batch-a', '테스트출판사', 1, 'a'.repeat(64), 'accepted', now, now).run();
  db.prepare('INSERT INTO book_order_batch_items(app,task_id,send_id,created_at) VALUES(?,?,?,?)')
    .bind('task', task.id, 'send-a', now).run();

  const accepted = await call(db, { auth: person('teacher-a', 'token-a'), action: 'list' });
  assert.equal(accepted.body.orders[0].stage, 'ordered');
  assert.equal(accepted.body.orders[0].orderCompletedAt, now);
  const received = await call(db, { auth: person('teacher-a', 'token-a'), action: 'order_transition',
    taskId: task.id, itemIndex: 0, next: 'receive', revision: 0 });
  assert.equal(received.status, 200);
  assert.equal(received.body.status, 'teacher_received');
  const handed = await call(db, { auth: person('teacher-a', 'token-a'), action: 'order_transition',
    taskId: task.id, itemIndex: 0, next: 'hand', revision: 1 });
  assert.equal(handed.body.status, 'student_handed');
  const staffAcademy = await call(db, { auth: person('teacher-a', 'token-a'), action: 'order_transition',
    taskId: task.id, itemIndex: 0, next: 'academy_register', revision: 2 });
  assert.equal(staffAcademy.status, 403);
  const academy = await call(db, { auth: admin, action: 'order_transition',
    taskId: task.id, itemIndex: 0, next: 'academy_register', revision: 2 });
  assert.equal(academy.status, 200);
  assert.equal(academy.body.status, 'academy_registered');
  const completed = await call(db, { auth: admin, action: 'list' });
  assert.equal(completed.body.orders[0].stage, 'student_handed');
  assert.equal(completed.body.orders[0].unitPrice, 15000);
  assert.equal(completed.body.orders[0].orderRequestedAt, now);
  assert.equal(completed.body.orders[0].orderCompletedAt, now);
  assert.ok(completed.body.orders[0].teacherReceivedAt);
  assert.ok(completed.body.orders[0].studentHandedAt);
  assert.ok(completed.body.orders[0].academyRegisteredAt);
});

test('legacy order price migration is additive, contains no student data, and is append-only', () => {
  for (const sql of [schema, priceMigration]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS book_order_item_prices/);
    const start = sql.indexOf('CREATE TABLE IF NOT EXISTS book_order_item_prices');
    const definition = sql.slice(start, sql.indexOf(');', start) + 2);
    assert.doesNotMatch(definition, /DROP TABLE|DELETE FROM|student|phone|address|memo/i);
  }
  const db = new TestD1();
  db.database.exec(priceMigration);
  db.prepare('INSERT INTO book_order_item_prices(app,task_id,item_index,unit_price,created_at,created_by) VALUES(?,?,?,?,?,?)')
    .bind('task', 'legacy-price', 0, 15000, Date.now(), 'director').run();
  assert.throws(() => db.prepare("UPDATE book_order_item_prices SET unit_price=16000 WHERE task_id='legacy-price'").run(),
    /BOOK_ORDER_ITEM_PRICE_APPEND_ONLY/);
  assert.throws(() => db.prepare("DELETE FROM book_order_item_prices WHERE task_id='legacy-price'").run(),
    /BOOK_ORDER_ITEM_PRICE_APPEND_ONLY/);
});

test('price correction migration preserves 16,000 won and appends the exact 17,000 won correction once', () => {
  for (const sql of [schema, correctionMigration]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS book_order_item_price_corrections/);
    const start = sql.indexOf('CREATE TABLE IF NOT EXISTS book_order_item_price_corrections');
    const definition = sql.slice(start, sql.indexOf(');', start) + 2);
    assert.doesNotMatch(definition, /DROP TABLE|DELETE FROM|student|phone|address|memo/i);
  }
  assert.doesNotMatch(correctionMigration, /UPDATE\s+book_order_item_prices|DELETE\s+FROM\s+book_order_item_prices/i);

  const db = new TestD1();
  const now = Date.now();
  const task = { id: '7905db2c-0b17-40bd-bbd7-fbb698f19542', title: '[주문] 최고수준 S 초3-2', deleted: false,
    orderDelivery: 'scheduled_batch_v1', orderItems: [{ bookId: 'BK01', title: '최고수준 S 초3-2', studentIds: ['student-a'] }] };
  db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', task.id, KIM_NAMGI_STAFF_ID, JSON.stringify(task), now, now).run();
  db.prepare('INSERT INTO book_order_item_prices(app,task_id,item_index,unit_price,created_at,created_by) VALUES(?,?,?,?,?,?)')
    .bind('task', task.id, 0, 16000, now, 'director').run();
  db.prepare('INSERT INTO book_order_fulfillments(app,task_id,item_index,book_id,student_ids,status,revision,teacher_received_at,teacher_received_by,student_handed_at,student_handed_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind('task', task.id, 0, 'BK01', JSON.stringify(['student-a']), 'student_handed', 2,
      now - 1000, KIM_NAMGI_STAFF_ID, now, KIM_NAMGI_STAFF_ID, now - 1000, now).run();
  db.database.exec(correctionMigration);

  const original = db.prepare('SELECT unit_price FROM book_order_item_prices WHERE app=? AND task_id=? AND item_index=0')
    .bind('task', task.id).first();
  const correction = db.prepare('SELECT * FROM book_order_item_price_corrections WHERE app=? AND task_id=? AND item_index=0')
    .bind('task', task.id).first();
  assert.equal(original.unit_price, 16000);
  assert.equal(correction.previous_unit_price, 16000);
  assert.equal(correction.corrected_unit_price, 17000);
  assert.throws(() => db.prepare('UPDATE book_order_item_price_corrections SET corrected_unit_price=18000 WHERE task_id=?')
    .bind(task.id).run(), /BOOK_ORDER_ITEM_PRICE_CORRECTION_APPEND_ONLY/);
  assert.throws(() => db.prepare('DELETE FROM book_order_item_price_corrections WHERE task_id=?')
    .bind(task.id).run(), /BOOK_ORDER_ITEM_PRICE_CORRECTION_APPEND_ONLY/);
});

test('order fulfillment rejects another teacher and cannot receive before an accepted order result', async () => {
  const db = new TestD1(); seed(db);
  const now = Date.now();
  const task = { id: 'order-b', title: '[주문] 새 교재', deleted: false, orderDelivery: 'scheduled_batch_v1',
    orderItems: [{ bookId: 'BK01', title: '새 교재', qty: '1권', studentIds: ['student-a'] }], origin: 'staff' };
  db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', task.id, 'teacher-a', JSON.stringify(task), now, now).run();
  assert.equal((await call(db, { auth: person('teacher-b', 'token-b'), action: 'order_transition',
    taskId: task.id, itemIndex: 0, next: 'receive', revision: 0 })).status, 403);
  const early = await call(db, { auth: person('teacher-a', 'token-a'), action: 'order_transition',
    taskId: task.id, itemIndex: 0, next: 'receive', revision: 0 });
  assert.equal(early.status, 409);
  assert.equal(early.body.code, 'ORDER_NOT_ACCEPTED');
});

test('accepted legacy order links stable student ids before receipt and locks identity after receipt', async () => {
  const db = new TestD1(); seed(db);
  const now = Date.now();
  const task = { id: 'legacy-order', title: '[주문] 새 교재', deleted: false, orderDelivery: 'scheduled_batch_v1',
    orderVendor: '테스트출판사', orderItems: [{ title: '새 교재', qty: '2권' }], origin: 'staff', updatedAt: now };
  db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', task.id, 'teacher-a', JSON.stringify(task), now, now).run();
  db.prepare('INSERT INTO book_order_sends(app,send_id,idempotency_key,task_id,vendor_name,item_count,message_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .bind('task', 'send-legacy', 'key-legacy', task.id, '테스트출판사', 1, 'b'.repeat(64), 'accepted', now, now).run();

  const auth = person('teacher-a', 'token-a');
  const before = await call(db, { auth, action: 'list' });
  assert.equal(before.body.orders[0].stage, 'ordered');
  assert.equal(before.body.orders[0].needsStudentLink, true);
  assert.equal(before.body.orders[0].canLinkStudents, true);
  assert.equal(before.body.orders[0].students.length, 0);

  const linked = await call(db, { auth, action: 'order_link', taskId: task.id, itemIndex: 0, bookId: 'BK01',
    studentIds: ['student-a'], expectedUpdatedAt: before.body.orders[0].taskUpdatedAt });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.idempotent, false);
  const stored = JSON.parse(db.prepare("SELECT data FROM tasks WHERE app='task' AND id='legacy-order'").first().data);
  assert.equal(stored.orderItems[0].bookId, 'BK01');
  assert.deepEqual(stored.orderItems[0].studentIds, ['student-a']);
  assert.equal(stored.orderItems[0].qty, '1권');
  assert.equal(JSON.stringify(stored.orderItems[0]).includes('가학생'), false);

  const after = await call(db, { auth, action: 'list' });
  assert.equal(after.body.orders[0].needsStudentLink, false);
  assert.equal(after.body.orders[0].canLinkStudents, false);
  assert.deepEqual(after.body.orders[0].students.map(student => student.id), ['student-a']);
  const received = await call(db, { auth, action: 'order_transition', taskId: task.id, itemIndex: 0, next: 'receive', revision: 0 });
  assert.equal(received.status, 200);
  const relink = await call(db, { auth: admin, action: 'order_link', taskId: task.id, itemIndex: 0, bookId: 'BK01',
    studentIds: ['student-b'], expectedUpdatedAt: linked.body.taskUpdatedAt });
  assert.equal(relink.status, 409);
  assert.equal(relink.body.code, 'ORDER_ALREADY_RECEIVED');
});

test('order student link enforces owner, accepted result, current assignment scope, and task CAS', async () => {
  const db = new TestD1(); seed(db);
  const now = Date.now();
  const task = { id: 'link-guard', title: '[주문] 새 교재', deleted: false, orderDelivery: 'scheduled_batch_v1',
    orderItems: [{ title: '새 교재', qty: '1권' }], origin: 'staff', updatedAt: now };
  db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', task.id, 'teacher-a', JSON.stringify(task), now, now).run();
  const request = { action: 'order_link', taskId: task.id, itemIndex: 0, bookId: 'BK01',
    studentIds: ['student-a'], expectedUpdatedAt: now };
  assert.equal((await call(db, { auth: person('teacher-b', 'token-b'), ...request })).status, 403);
  const early = await call(db, { auth: person('teacher-a', 'token-a'), ...request });
  assert.equal(early.status, 409);
  assert.equal(early.body.code, 'ORDER_NOT_ACCEPTED');

  db.prepare('INSERT INTO book_order_sends(app,send_id,idempotency_key,task_id,vendor_name,item_count,message_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .bind('task', 'send-guard', 'key-guard', task.id, '테스트출판사', 1, 'c'.repeat(64), 'accepted', now, now).run();
  const wrongStudent = await call(db, { auth: person('teacher-a', 'token-a'), ...request, studentIds: ['student-b'] });
  assert.equal(wrongStudent.status, 403);
  db.prepare("UPDATE tasks SET updated_at=updated_at+1 WHERE app='task' AND id='link-guard'").run();
  const stale = await call(db, { auth: person('teacher-a', 'token-a'), ...request });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'REVISION_CONFLICT');
});

test('Kim Namgi can record the accepted legacy Wordmaster price once without mutating the sealed task', async () => {
  const db = new TestD1(); seed(db);
  const now = Date.now();
  const task = { id: 'legacy-wordmaster', title: '[주문] 워드마스터', deleted: false,
    orderDelivery: 'scheduled_batch_v1', orderVendor: '테스트출판사',
    orderItems: [{ bookId: 'BK01', title: '워드마스터 중등 베이직', qty: '2권', studentIds: ['student-a'] }],
    origin: 'staff', createdAt: now, updatedAt: now };
  db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', task.id, KIM_NAMGI_STAFF_ID, JSON.stringify(task), now, now).run();
  db.prepare('INSERT INTO book_order_sends(app,send_id,idempotency_key,task_id,vendor_name,item_count,message_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .bind('task', 'send-wordmaster', 'key-wordmaster', task.id, '테스트출판사', 1, 'd'.repeat(64), 'accepted', now, now).run();

  const auth = person(KIM_NAMGI_STAFF_ID, 'token-kim');
  const before = await call(db, { auth, action: 'list' });
  const beforeRow = before.body.orders.find(row => row.taskId === task.id);
  assert.equal(beforeRow.stage, 'ordered');
  assert.equal(beforeRow.unitPrice, null);
  assert.equal(beforeRow.canSetUnitPrice, true);

  const saved = await call(db, { auth, action: 'order_price_set', taskId: task.id, itemIndex: 0, unitPrice: 17000 });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.idempotent, false);
  const after = await call(db, { auth, action: 'list' });
  const afterRow = after.body.orders.find(row => row.taskId === task.id);
  assert.equal(afterRow.unitPrice, 17000);
  assert.equal(afterRow.canSetUnitPrice, false);
  assert.ok(afterRow.priceBackfilledAt);
  const unchanged = JSON.parse(db.prepare("SELECT data FROM tasks WHERE app='task' AND id='legacy-wordmaster'").first().data);
  assert.equal(Object.hasOwn(unchanged.orderItems[0], 'unitPrice'), false);

  const duplicate = await call(db, { auth, action: 'order_price_set', taskId: task.id, itemIndex: 0, unitPrice: 17000 });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.idempotent, true);
  const changed = await call(db, { auth, action: 'order_price_set', taskId: task.id, itemIndex: 0, unitPrice: 18000 });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.code, 'ORDER_PRICE_ALREADY_SET');
});

test('a matching immutable correction becomes the displayed and idempotent effective price', async () => {
  const db = new TestD1(); seed(db);
  const now = Date.now();
  const task = { id: 'corrected-price', title: '[주문] 교재', deleted: false,
    orderDelivery: 'scheduled_batch_v1', orderVendor: '테스트출판사',
    orderItems: [{ bookId: 'BK01', title: '다른 교재', qty: '1권', studentIds: ['student-a'] }],
    origin: 'staff', createdAt: now, updatedAt: now };
  db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', task.id, KIM_NAMGI_STAFF_ID, JSON.stringify(task), now, now).run();
  db.prepare('INSERT INTO book_order_sends(app,send_id,idempotency_key,task_id,vendor_name,item_count,message_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .bind('task', 'send-corrected', 'key-corrected', task.id, '테스트출판사', 1, 'f'.repeat(64), 'accepted', now, now).run();
  db.prepare('INSERT INTO book_order_fulfillments(app,task_id,item_index,book_id,student_ids,status,revision,teacher_received_at,teacher_received_by,student_handed_at,student_handed_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind('task', task.id, 0, 'BK01', JSON.stringify(['student-a']), 'student_handed', 2,
      now - 1000, KIM_NAMGI_STAFF_ID, now, KIM_NAMGI_STAFF_ID, now - 1000, now).run();
  db.prepare('INSERT INTO book_order_item_prices(app,task_id,item_index,unit_price,created_at,created_by) VALUES(?,?,?,?,?,?)')
    .bind('task', task.id, 0, 16000, now - 500, 'director').run();
  db.prepare('INSERT INTO book_order_item_price_corrections(app,task_id,item_index,previous_unit_price,corrected_unit_price,reason_code,created_at,created_by) VALUES(?,?,?,?,?,?,?,?)')
    .bind('task', task.id, 0, 16000, 17000, 'director_amount_correction', now, 'director').run();

  const listed = await call(db, { auth: admin, action: 'list' });
  const row = listed.body.orders.find(item => item.taskId === task.id);
  assert.equal(row.unitPrice, 17000);
  assert.equal(row.priceCorrectedAt, now);
  assert.equal(row.canSetUnitPrice, false);
  const duplicate = await call(db, { auth: admin, action: 'order_price_set', taskId: task.id, itemIndex: 0, unitPrice: 17000 });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.idempotent, true);
  const oldValue = await call(db, { auth: admin, action: 'order_price_set', taskId: task.id, itemIndex: 0, unitPrice: 16000 });
  assert.equal(oldValue.status, 409);
  assert.equal(oldValue.body.code, 'ORDER_PRICE_ALREADY_SET');
});

test('one-time price accepts Kim Namgi student-handed legacy books and rejects other orders', async () => {
  const db = new TestD1(); seed(db);
  const now = Date.now();
  const insertOrder = (id, owner, title, unitPrice) => {
    const item = { bookId: 'BK01', title, qty: '1권', studentIds: ['student-a'] };
    if (unitPrice) item.unitPrice = unitPrice;
    const task = { id, title: '[주문] ' + title, deleted: false, orderDelivery: 'scheduled_batch_v1',
      orderVendor: '테스트출판사', orderItems: [item], origin: 'staff', createdAt: now, updatedAt: now };
    db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
      .bind('task', id, owner, JSON.stringify(task), now, now).run();
    db.prepare('INSERT INTO book_order_sends(app,send_id,idempotency_key,task_id,vendor_name,item_count,message_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .bind('task', 'send-' + id, 'key-' + id, id, '테스트출판사', 1, id.padEnd(64, 'e').slice(0, 64), 'accepted', now, now).run();
  };
  insertOrder('legacy-handed', KIM_NAMGI_STAFF_ID, '다른 교재', null);
  db.prepare('INSERT INTO book_order_fulfillments(app,task_id,item_index,book_id,student_ids,status,revision,teacher_received_at,teacher_received_by,student_handed_at,student_handed_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind('task', 'legacy-handed', 0, 'BK01', JSON.stringify(['student-a']), 'student_handed', 2,
      now - 1000, KIM_NAMGI_STAFF_ID, now, KIM_NAMGI_STAFF_ID, now - 1000, now).run();
  const handed = await call(db, { auth: admin, action: 'order_price_set', taskId: 'legacy-handed', itemIndex: 0, unitPrice: 12000 });
  assert.equal(handed.status, 200);

  insertOrder('other-owner', 'teacher-a', '워드마스터 중등베이직', null);
  const otherOwner = await call(db, { auth: admin, action: 'order_price_set', taskId: 'other-owner', itemIndex: 0, unitPrice: 12000 });
  assert.equal(otherOwner.status, 409);
  assert.equal(otherOwner.body.code, 'ORDER_PRICE_NOT_ELIGIBLE');

  insertOrder('already-priced', KIM_NAMGI_STAFF_ID, '워드마스터 중등베이직', 13000);
  const alreadyPriced = await call(db, { auth: admin, action: 'order_price_set', taskId: 'already-priced', itemIndex: 0, unitPrice: 14000 });
  assert.equal(alreadyPriced.status, 409);
  assert.equal(alreadyPriced.body.code, 'ORDER_PRICE_ALREADY_SET');
});
