import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { readPublicBookStatus } from './public-book-status.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const NOW = Date.parse('2026-08-17T03:00:00.000Z');

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
}

function roster() {
  return {
    roster: { updated: '2026-08-17', baseline: '2026-08', students: [
      { id: 'student-a', name: '가학생', grade: '중1', teacher: '가선생', subject: '영어', start: '2026-08', end: '', reason: '', teacherIds: ['teacher-a'] },
      { id: 'student-b', name: '나학생', grade: '중2', teacher: '나선생', subject: '영어', start: '2026-08', end: '', reason: '', teacherIds: ['teacher-b'] },
      { id: 'student-old', name: '종료학생', grade: '중3', teacher: '가선생', subject: '영어', start: '2026-01', end: '2026-08', reason: '', teacherIds: ['teacher-a'] }
    ] },
    bookStudents: [
      { id: 'assign-a', studentId: 'student-a', name: '가학생', teacher: '가선생', bookId: 'BK01', at: '', perWeek: 2, goal: '', teacherIds: ['teacher-a'] },
      { id: 'assign-b', studentId: 'student-b', name: '나학생', teacher: '나선생', bookId: 'BK02', at: '', perWeek: 2, goal: '', teacherIds: ['teacher-b'] }
    ]
  };
}

function seed(db) {
  db.prepare('INSERT INTO private_rosters(app,data,updated_at) VALUES(?,?,?)')
    .bind('task', JSON.stringify(roster()), NOW).run();
}

async function studentHash(id, name) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id + '\n' + name));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function hash(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function addSnapshotTask(db, taskId, items, createdAt = NOW) {
  const names = new Map([['student-a', '가학생'], ['student-b', '나학생']]);
  const rowCount = items.reduce((sum, item) => sum + item.studentIds.length, 0);
  const taskHash = await hash('task\n' + taskId);
  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex];
    const ids = item.studentIds.map(String).sort();
    const setHash = await hash(JSON.stringify(ids));
    const itemHash = await hash(JSON.stringify([item.bookId, ids]));
    for (const studentId of ids) {
      db.prepare('INSERT INTO book_order_student_snapshots(app,task_id,item_index,owner_id,book_id,public_title,' +
        'student_id,student_identity_hash,student_set_hash,item_identity_hash,task_identity_hash,' +
        'expected_item_count,expected_row_count,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .bind('task', taskId, itemIndex, 'teacher-a', item.bookId, '주문 교재', studentId,
          await studentHash(studentId, names.get(studentId)), setHash, itemHash, taskHash,
          items.length, rowCount, createdAt).run();
    }
  }
}

function addTask(db, id, bookId, title, studentIds, updatedAt = NOW) {
  const task = {
    id, staffId: 'teacher-a', title: '[주문] 내부 문구', detail: '업체 메모 010-9999-8888',
    guide: '교사 메모는 노출하지 않음', deleted: false, orderDelivery: 'scheduled_batch_v1',
    orderVendor: '비밀출판사', orderItems: [{ bookId, title, studentIds }]
  };
  db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', id, 'teacher-a', JSON.stringify(task), updatedAt, updatedAt).run();
}

function addSend(db, sendId, taskId, status, updatedAt = NOW) {
  db.prepare('INSERT INTO book_order_sends(app,send_id,idempotency_key,task_id,vendor_name,item_count,message_hash,' +
    'status,provider_group_id,provider_message_id,provider_status_code,safe_error_code,created_at,updated_at) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind('task', sendId, 'key-' + sendId, taskId, '비밀업체', 1, 'a'.repeat(64), status,
      'provider-group-secret-' + sendId, 'provider-message-secret-' + sendId,
      'SECRET_STATUS', 'SECRET_ERROR', updatedAt, updatedAt).run();
}

function addFulfillment(db, taskId, bookId, studentIds, status, updatedAt = NOW) {
  const received = status === 'teacher_received' || status === 'student_handed' || status === 'academy_registered' ? updatedAt : null;
  const handed = status === 'student_handed' || status === 'academy_registered' ? updatedAt : null;
  const academy = status === 'academy_registered' ? updatedAt : null;
  db.prepare('INSERT INTO book_order_fulfillments(app,task_id,item_index,book_id,student_ids,status,revision,' +
    'teacher_received_at,teacher_received_by,student_handed_at,student_handed_by,academy_registered_at,' +
    'academy_registered_by,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?,?,?,?,?,?,?)')
    .bind('task', taskId, 0, bookId, JSON.stringify(studentIds), status, received, 'teacher-a',
      handed, handed ? 'teacher-a' : null, academy, academy ? 'director' : null, updatedAt, updatedAt).run();
}

async function addIssue(db, overrides = {}) {
  const values = {
    assignmentId: 'assign-a', studentId: 'student-a', bookId: 'BK01',
    identity: await studentHash('student-a', '가학생'), status: 'issued', updatedAt: NOW - 1000,
    ...overrides
  };
  db.prepare('INSERT INTO book_issues(app,assignment_id,student_id,book_id,student_identity_hash,status,cycle,revision,' +
    'prepared_at,prepared_by,issued_at,issued_by,history,created_at,updated_at) VALUES(?,?,?,?,?,?,1,2,?,?,?,?,?,?,?)')
    .bind('task', values.assignmentId, values.studentId, values.bookId, values.identity, values.status,
      values.updatedAt - 100, 'teacher-a', values.updatedAt, 'teacher-a',
      JSON.stringify([{ actorId: 'teacher-a', reason: '교사메모 010-1111-2222' }]), values.updatedAt - 100, values.updatedAt).run();
}

test('one exact active student receives only safe DTO fields from a verified distribution identity', async () => {
  const db = new TestD1(); seed(db);
  addTask(db, 'order-a', 'BK01', '리딩바이트 Grade 2', ['student-a']);
  addTask(db, 'order-b', 'BK02', '타학생 교재', ['student-b']);
  addSend(db, 'send-batch', 'batch-secret', 'accepted');
  db.prepare('INSERT INTO book_order_batch_items(app,task_id,send_id,created_at) VALUES(?,?,?,?)')
    .bind('task', 'order-a', 'send-batch', NOW).run();
  await addIssue(db);

  const result = await readPublicBookStatus({ DB: db }, 'student-a', NOW);
  assert.deepEqual(result.rows.map(row => [row.kind, row.title, row.stage, row.label]), [
    ['distribution', '배정 교재', 'ready_for_handoff', '학생 전달 준비']
  ]);
  for (const row of result.rows) {
    assert.deepEqual(Object.keys(row).sort(), ['kind', 'label', 'stage', 'title', 'updatedAt']);
  }
  const exposed = JSON.stringify(result);
  for (const secret of ['student-a', 'student-b', '나학생', 'BK01', 'assign-a', 'order-a', 'teacher-a',
    '비밀출판사', '비밀업체', '010-1111-2222', 'provider-group-secret', 'SECRET_ERROR', '교사메모']) {
    assert.equal(exposed.includes(secret), false, secret + '가 노출됨');
  }
});

test('legacy order/send/fulfillment rows without an immutable student identity snapshot stay hidden', async () => {
  const db = new TestD1(); seed(db);
  const cases = [
    ['wait', null, null, 'order_waiting', '주문 대기'],
    ['accepted', 'accepted', null, 'ordered', '주문 접수'],
    ['unknown', 'unknown', null, 'order_check', '학원 확인 중'],
    ['rejected', 'rejected', null, 'order_failed', '학원 확인 중'],
    ['reserved', 'reserved', null, 'order_check', '학원 확인 중'],
    ['received', 'accepted', 'teacher_received', 'academy_received', '학원 도착'],
    ['handed', 'accepted', 'student_handed', 'handed', '학생 전달 완료'],
    ['registered', 'accepted', 'academy_registered', 'handed', '학생 전달 완료']
  ];
  cases.forEach(([name, send, fulfillment], index) => {
    const taskId = 'order-' + name;
    addTask(db, taskId, 'BK' + String(index + 10), 'TITLE-' + name, ['student-a'], NOW + index);
    if (send) addSend(db, 'send-' + name, taskId, send, NOW + index);
    if (fulfillment) addFulfillment(db, taskId, 'BK' + String(index + 10), ['student-a'], fulfillment, NOW + index);
  });
  const result = await readPublicBookStatus({ DB: db }, 'student-a', NOW);
  assert.deepEqual(result.rows, []);
  assert.doesNotMatch(JSON.stringify(result), /provider|SECRET|safe_error|status_code/i);
});

test('mismatched issue identities and all unsealed order titles fail closed', async () => {
  const db = new TestD1(); seed(db);
  addTask(db, 'bad-fulfillment', 'BK01', '숨겨야 할 교재', ['student-a']);
  addFulfillment(db, 'bad-fulfillment', 'BK99', ['student-a'], 'teacher_received');
  addTask(db, 'bad-roster-link', 'BK03', '잘못된 연결', ['student-a', 'missing-student']);
  addTask(db, 'safe-fallback', 'BK04', '교재\n연락처: 010-1234-5678', ['student-a']);
  addTask(db, 'other-student', 'BK02', '타학생 교재', ['student-b']);
  await addIssue(db, { identity: await studentHash('student-a', '개명 전 이름') });

  const result = await readPublicBookStatus({ DB: db }, 'student-a', NOW);
  assert.deepEqual(result.rows, []);
  assert.doesNotMatch(JSON.stringify(result), /010|missing-student|타학생|숨겨야|잘못된|개명/);
});

test('a reused stable ID with a changed name cannot inherit old order or distribution history', async () => {
  const db = new TestD1(); seed(db);
  addTask(db, 'old-order', 'BK01', '예전 학생 교재', ['student-a']);
  addSend(db, 'old-send', 'old-order', 'accepted');
  addFulfillment(db, 'old-order', 'BK01', ['student-a'], 'student_handed');
  await addIssue(db);
  const changed = roster();
  changed.roster.students[0].name = '새학생';
  changed.bookStudents[0].name = '새학생';
  db.prepare('UPDATE private_rosters SET data=?,updated_at=? WHERE app=?')
    .bind(JSON.stringify(changed), NOW + 1, 'task').run();

  const result = await readPublicBookStatus({ DB: db }, 'student-a', NOW);
  assert.deepEqual(result.rows, []);
  assert.doesNotMatch(JSON.stringify(result), /예전 학생|old-order|old-send|student-a/);
});

test('student lookup is exact and requires a currently active roster identity', async () => {
  const db = new TestD1(); seed(db);
  assert.equal((await readPublicBookStatus({ DB: db }, 'Student-a', NOW)).code, 'STUDENT_INACTIVE');
  assert.equal((await readPublicBookStatus({ DB: db }, 'student-old', NOW)).code, 'STUDENT_INACTIVE');
  assert.equal((await readPublicBookStatus({ DB: db }, 'student id', NOW)).code, 'STUDENT_INVALID');
});

test('every order ledger dependency is readiness-checked before guardian queries run', async () => {
  for (const table of ['book_issues', 'book_order_student_snapshots', 'book_order_cancellations',
    'book_order_sends', 'book_order_batch_items', 'book_order_fulfillments']) {
    const db = new TestD1();
    db.database.exec('DROP TABLE ' + table);
    const result = await readPublicBookStatus({ DB: db }, 'student-a', NOW);
    assert.equal(result.code, 'BOOK_STATUS_NOT_READY', table);
  }
});

test('sealed order projection reads 100 target tasks without large IN binds and exposes only fixed DTOs', async () => {
  const db = new TestD1(); seed(db);
  for (let index = 0; index < 100; index++) {
    const taskId = 'ord_public_' + String(index).padStart(3, '0');
    await addSnapshotTask(db, taskId, [{ bookId: 'BK-PUBLIC-' + index,
      studentIds: ['student-a', 'student-b'] }], NOW + index);
    addSend(db, 'safe-send-' + index, taskId, 'accepted', NOW + index);
  }
  const result = await readPublicBookStatus({ DB: db }, 'student-a', NOW + 200);
  assert.equal(result.rows.length, 100);
  assert.ok(result.rows.every(row => row.title === '주문 교재' && row.stage === 'ordered'));
  assert.ok(result.rows.every(row => JSON.stringify(Object.keys(row).sort()) ===
    JSON.stringify(['kind', 'label', 'stage', 'title', 'updatedAt'])));
  assert.doesNotMatch(JSON.stringify(result), /student-|BK-PUBLIC|safe-send|teacher-a/);
});

test('partial snapshot tails and contradictory fulfillment/send/cancel ledgers fail closed', async () => {
  const db = new TestD1(); seed(db);
  const identity = await studentHash('student-a', '가학생');
  const setHash = await hash(JSON.stringify(['student-a', 'student-b']));
  db.prepare('INSERT INTO book_order_student_snapshots(app,task_id,item_index,owner_id,book_id,public_title,' +
    'student_id,student_identity_hash,student_set_hash,item_identity_hash,task_identity_hash,' +
    'expected_item_count,expected_row_count,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind('task', 'ord_partial12', 0, 'teacher-a', 'BK-PARTIAL', '주문 교재', 'student-a', identity,
      setHash, 'a'.repeat(64), 'b'.repeat(64), 1, 2, NOW).run();

  const oneSetHash = await hash(JSON.stringify(['student-a']));
  db.prepare('INSERT INTO book_order_student_snapshots(app,task_id,item_index,owner_id,book_id,public_title,' +
    'student_id,student_identity_hash,student_set_hash,item_identity_hash,task_identity_hash,' +
    'expected_item_count,expected_row_count,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind('task', 'ord_missing_item', 0, 'teacher-a', 'BK-MISSING-ITEM', '주문 교재', 'student-a', identity,
      oneSetHash, 'c'.repeat(64), 'd'.repeat(64), 2, 1, NOW).run();

  await addSnapshotTask(db, 'ord_no_send12', [{ bookId: 'BK-NOSEND', studentIds: ['student-a'] }], NOW + 1);
  addFulfillment(db, 'ord_no_send12', 'BK-NOSEND', ['student-a'], 'teacher_received', NOW + 1);

  await addSnapshotTask(db, 'ord_bad_fulfill', [{ bookId: 'BK-EXPECTED', studentIds: ['student-a'] }], NOW + 1);
  addSend(db, 'send-bad-fulfill', 'ord_bad_fulfill', 'accepted', NOW + 1);
  addFulfillment(db, 'ord_bad_fulfill', 'BK-WRONG', ['student-a'], 'teacher_received', NOW + 1);

  await addSnapshotTask(db, 'ord_cancel12x', [{ bookId: 'BK-CANCEL', studentIds: ['student-a'] }], NOW + 2);
  addSend(db, 'send-cancelled', 'ord_cancel12x', 'accepted', NOW + 2);
  db.prepare('INSERT INTO book_order_cancellations(app,task_id,cancelled_at) VALUES(?,?,?)')
    .bind('task', 'ord_cancel12x', NOW + 3).run();

  const result = await readPublicBookStatus({ DB: db }, 'student-a', NOW + 4);
  assert.deepEqual(result.rows, []);
});
