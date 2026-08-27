import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import worker from './worker-core.js';
import {
  BOOK_PUBLISHER_VENDOR_MAP,
  MANUAL_ONLINE_DELIVERY,
  ONLINE_BOOK_VENDOR,
  isRawBookVendor,
  resolveBookPublisher
} from './book-order-vendors.js';
import {
  completedCatalogRecord,
  normalizeCatalogPart,
  verifyCompletedCatalogEntry
} from './completed-book-catalog.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/052_completed_book_catalog.sql', import.meta.url), 'utf8');
const catalogSource = fs.readFileSync(new URL('./completed-book-catalog.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('./wrangler.toml', import.meta.url), 'utf8');
const admin = { mode: 'admin', secret: 'director-secret' };
const teacherA = { mode: 'person', id: 'teacher-a', token: 'token-a' };
const teacherB = { mode: 'person', id: 'teacher-b', token: 'token-b' };
const vendorPhones = JSON.stringify({
  '천재출판사': '010-1111-1111',
  '동아출판사': '010-2222-2222',
  '청암출판사': '010-3333-3333',
  '상형출판사': '010-4444-4444'
});

const EXPECTED_PUBLISHERS = [
  ['천재교육', '천재출판사'], ['디딤돌', '천재출판사'], ['YBM', '천재출판사'],
  ['길벗스쿨', '천재출판사'], ['와칭국어', '천재출판사'],
  ['미래앤', '동아출판사'], ['동아', '동아출판사'], ['지학사', '동아출판사'],
  ['입시플라이', '동아출판사'], ['능률', '동아출판사'], ['백발백중', '동아출판사'],
  ['개념원리', '동아출판사'], ['RPM', '동아출판사'],
  ['비상', '청암출판사'], ['세듀', '청암출판사'], ['수경', '청암출판사'],
  ['메가스터디', '청암출판사'], ['교학사', '청암출판사'], ['다락원', '청암출판사'],
  ['이투스', '상형출판사'], ['마더텅', '상형출판사']
];

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  first() { return this.db.prepare(this.sql).get(...this.args) || null; }
  all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  run() {
    const result = this.db.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(result.changes || 0) } };
  }
}

class TestD1 {
  constructor() {
    this.database = new DatabaseSync(':memory:');
    this.database.exec(schema);
  }
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

function roster() {
  return {
    roster: { updated: '2026-08-27', baseline: '2026-08', students: [
      { id: 'student-a', name: '가학생', grade: '중1', teacher: '가선생', subject: '수학',
        start: '2026-08', end: '', reason: '', teacherIds: ['teacher-a'] },
      { id: 'student-b', name: '나학생', grade: '중2', teacher: '나선생', subject: '영어',
        start: '2026-08', end: '', reason: '', teacherIds: ['teacher-b'] }
    ] },
    bookStudents: []
  };
}

function seed(db) {
  const now = Date.now();
  for (const [id, token, name] of [
    ['teacher-a', 'token-a', '가선생'], ['teacher-b', 'token-b', '나선생']
  ]) {
    db.prepare('INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
      .bind('task', id, id, JSON.stringify({ id, name, deleted: false }), now, now).run();
    db.prepare('INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)')
      .bind('task', token, id, now).run();
  }
  db.prepare('INSERT INTO private_rosters(app,data,updated_at) VALUES(?,?,?)')
    .bind('task', JSON.stringify(roster()), now).run();
}

function makeEnv(db, extra = {}) {
  return {
    DB: db,
    TASK_ADMIN_SECRET: 'director-secret',
    CONSULT_ADMIN_SECRET: 'consult-secret',
    BOOK_VENDOR_PHONES: vendorPhones,
    ...extra
  };
}

async function call(db, body, path = '/book-order', extra = {}, ctx) {
  const response = await worker.fetch(new Request('https://worker.example' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app: 'task', ...body })
  }), makeEnv(db, extra), ctx);
  return { status: response.status, body: await response.json() };
}

function orderBody(taskId, overrides = {}) {
  const publisherName = Object.prototype.hasOwnProperty.call(overrides, 'publisherName')
    ? overrides.publisherName : '천재교육';
  const item = {
    bookId: overrides.bookId || 'BK_' + taskId.replace(/[^A-Za-z0-9]/g, '_'),
    title: overrides.title || '수학 기본서',
    studentIds: overrides.studentIds || ['student-a'],
    unitPrice: overrides.unitPrice || 15000
  };
  if (!overrides.omitPublisher) item.publisherName = publisherName;
  return {
    auth: overrides.auth || teacherA,
    action: 'create',
    taskId,
    vendorName: overrides.vendorName || '천재출판사',
    items: [item]
  };
}

function manualBody(taskId, overrides = {}) {
  return orderBody(taskId, {
    publisherName: '',
    vendorName: ONLINE_BOOK_VENDOR,
    title: '목록에 없는 교재',
    ...overrides
  });
}

function markScheduledAccepted(db, taskId, vendorName = '천재출판사') {
  const now = Date.now();
  const suffix = taskId.replace(/[^A-Za-z0-9_-]/g, '_');
  db.prepare(
    'INSERT INTO book_order_sends(app,send_id,idempotency_key,task_id,vendor_name,item_count,message_hash,status,created_at,updated_at) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,?)'
  ).bind('task', 'send_' + suffix, 'key_' + suffix, 'batch_' + suffix, vendorName, 1,
    suffix.padEnd(64, 'a').slice(0, 64), 'accepted', now, now).run();
  db.prepare('INSERT INTO book_order_batch_items(app,task_id,send_id,created_at) VALUES(?,?,?,?)')
    .bind('task', taskId, 'send_' + suffix, now).run();
}

async function completeScheduled(db, taskId, extra = {}, ctx) {
  markScheduledAccepted(db, taskId);
  const received = await call(db, { auth: teacherA, action: 'order_transition', taskId,
    itemIndex: 0, next: 'receive', revision: 0 }, '/book-issue', extra);
  assert.equal(received.status, 200);
  const handed = await call(db, { auth: teacherA, action: 'order_transition', taskId,
    itemIndex: 0, next: 'hand', revision: 1 }, '/book-issue', extra);
  assert.equal(handed.status, 200);
  return call(db, { auth: admin, action: 'order_transition', taskId,
    itemIndex: 0, next: 'academy_register', revision: 2 }, '/book-issue', extra, ctx);
}

function insertPendingCatalog(db, { id, title = '수학 기본서', publisher = '천재교육', vendor = '천재출판사',
  status = 'pending', sourceUrls = [] }) {
  const now = Date.now();
  const normalizedTitle = normalizeCatalogPart(title);
  const normalizedPublisher = normalizeCatalogPart(publisher);
  const reviewMethod = status === 'legacy_fallback' ? 'legacy'
    : ['fallback_ai_error', 'fallback_mismatch', 'fallback_no_source', 'fallback_insufficient_evidence', 'verified']
      .includes(status) ? 'web_search' : 'none';
  db.prepare(
    'INSERT INTO completed_book_catalog(app,catalog_id,title,normalized_title,publisher_name,normalized_publisher,' +
      'selected_publisher_name,selected_normalized_title,selected_normalized_publisher,vendor_name,completed_at,' +
      'verification_status,source_urls,verified_at,revision,review_method,created_at,updated_at) ' +
      'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).bind('task', id, title, normalizedTitle, publisher, normalizedPublisher,
    publisher, normalizedTitle, normalizedPublisher, vendor, now, status, JSON.stringify(sourceUrls), null,
    0, reviewMethod, now, now).run();
}

test('중앙 출판사 표는 21개 raw 총판 key와 목록없음→쿠팡을 단일 정본으로 제공한다', () => {
  assert.deepEqual(BOOK_PUBLISHER_VENDOR_MAP.map(row => [row.publisherName, row.vendorName]), EXPECTED_PUBLISHERS);
  assert.equal(new Set(BOOK_PUBLISHER_VENDOR_MAP.map(row => row.publisherName)).size, 21);
  assert.deepEqual(resolveBookPublisher('  천재교육  '),
    { publisherName: '천재교육', vendorName: '천재출판사', listed: true });
  assert.deepEqual(resolveBookPublisher('ｙｂｍ'),
    { publisherName: 'YBM', vendorName: '천재출판사', listed: true });
  for (const marker of ['', '목록에 없음', '__unlisted__', 'unlisted']) {
    assert.deepEqual(resolveBookPublisher(marker),
      { publisherName: '', vendorName: ONLINE_BOOK_VENDOR, listed: false }, marker);
  }
  assert.equal(resolveBookPublisher('임의출판사'), null);
  for (const vendor of ['천재출판사', '동아출판사', '청암출판사', '상형출판사', ONLINE_BOOK_VENDOR]) {
    assert.equal(isRawBookVendor(vendor), true, vendor);
  }
  assert.equal(isRawBookVendor('천재총판'), false);
  assert.equal(MANUAL_ONLINE_DELIVERY, 'manual_online_v1');
});

test('publisherName은 canonical 주문에 봉인되고 임의명·총판 불일치·쿠팡 우회를 차단한다', async () => {
  const db = new TestD1(); seed(db);
  const body = orderBody('ord_known_000001');
  body.items[0].publisherName = '  천재교육  ';
  const created = await call(db, body);
  assert.equal(created.status, 201);
  assert.equal(created.body.task.orderDelivery, 'scheduled_batch_v1');
  assert.equal(created.body.task.orderVendor, '천재출판사');
  assert.equal(created.body.task.orderItems[0].publisherName, '천재교육');
  const stored = JSON.parse(db.prepare("SELECT data FROM tasks WHERE app='task' AND id=?")
    .bind(body.taskId).first().data);
  assert.equal(stored.orderItems[0].publisherName, '천재교육');

  const exact = orderBody(body.taskId);
  assert.equal((await call(db, exact)).status, 200);
  const changedPublisher = orderBody(body.taskId);
  changedPublisher.items[0].publisherName = '디딤돌';
  const collision = await call(db, changedPublisher);
  assert.equal(collision.status, 409);
  assert.equal(collision.body.code, 'ORDER_ID_CONFLICT');

  const mismatch = orderBody('ord_mismatch_0001', { vendorName: '동아출판사' });
  const mismatchResult = await call(db, mismatch);
  assert.equal(mismatchResult.status, 409);
  assert.equal(mismatchResult.body.code, 'ORDER_VENDOR_MISMATCH');

  const unknown = orderBody('ord_unknown_00001', { publisherName: '임의출판사' });
  const unknownResult = await call(db, unknown);
  assert.equal(unknownResult.status, 400);
  assert.equal(unknownResult.body.code, 'ORDER_INVALID');

  const nonText = orderBody('ord_nontext_00001', { publisherName: null });
  const nonTextResult = await call(db, nonText);
  assert.equal(nonTextResult.status, 400);
  assert.equal(nonTextResult.body.code, 'ORDER_INVALID');

  const blankKnown = orderBody('ord_blank_known01', { publisherName: '' });
  const blankKnownResult = await call(db, blankKnown);
  assert.equal(blankKnownResult.status, 409);
  assert.equal(blankKnownResult.body.code, 'ORDER_VENDOR_MISMATCH');

  const omittedCoupang = orderBody('ord_coupang_omit1', { vendorName: ONLINE_BOOK_VENDOR, omitPublisher: true });
  const omittedResult = await call(db, omittedCoupang);
  assert.equal(omittedResult.status, 409);
  assert.equal(omittedResult.body.code, 'ORDER_VENDOR_NOT_CONFIGURED');
});

test('명시적 blank 출판사는 서버 manual_online_v1 1단계에서 owner 결과 원장을 거쳐 기존 배송 단계로 이어진다', async () => {
  const db = new TestD1(); seed(db);
  const body = manualBody('ord_manual_000001');
  const created = await call(db, body);
  assert.equal(created.status, 201);
  assert.equal(created.body.task.orderDelivery, MANUAL_ONLINE_DELIVERY);
  assert.equal(created.body.task.orderVendor, ONLINE_BOOK_VENDOR);
  assert.equal(Object.hasOwn(created.body.task.orderItems[0], 'publisherName'), true);
  assert.equal(created.body.task.orderItems[0].publisherName, '');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM book_order_sends').first().count, 0);

  const waiting = await call(db, { auth: teacherA, action: 'list' }, '/book-issue');
  const waitingRow = waiting.body.orders.find(row => row.taskId === body.taskId);
  assert.equal(waitingRow.stage, 'order_waiting');
  assert.equal(waitingRow.orderDelivery, MANUAL_ONLINE_DELIVERY);

  const foreign = await call(db, { auth: teacherB, action: 'manual_online_result', taskId: body.taskId,
    result: 'completed', revision: 0 }, '/book-issue');
  assert.equal(foreign.status, 403);
  const completed = await call(db, { auth: teacherA, action: 'manual_online_result', taskId: body.taskId,
    result: 'completed', revision: 0 }, '/book-issue');
  assert.equal(completed.status, 200);
  assert.equal(completed.body.status, 'accepted');
  assert.equal(completed.body.revision, 1);
  const send = db.prepare('SELECT * FROM book_order_sends WHERE app=? AND task_id=?')
    .bind('task', body.taskId).first();
  assert.equal(send.vendor_name, ONLINE_BOOK_VENDOR);
  assert.equal(send.status, 'accepted');
  assert.equal(send.provider_status_code, 'MANUAL_ONLINE_COMPLETED');
  assert.equal(send.provider_message_id, null);

  const retry = await call(db, { auth: teacherA, action: 'manual_online_result', taskId: body.taskId,
    result: 'completed', revision: 0 }, '/book-issue');
  assert.equal(retry.status, 200);
  assert.equal(retry.body.idempotent, true);
  const conflict = await call(db, { auth: teacherA, action: 'manual_online_result', taskId: body.taskId,
    result: 'failed', revision: 0 }, '/book-issue');
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'REVISION_CONFLICT');

  const ordered = await call(db, { auth: teacherA, action: 'list' }, '/book-issue');
  assert.equal(ordered.body.orders.find(row => row.taskId === body.taskId).stage, 'ordered');
  assert.equal((await call(db, { auth: teacherA, action: 'order_transition', taskId: body.taskId,
    itemIndex: 0, next: 'receive', revision: 0 }, '/book-issue')).body.status, 'teacher_received');
  assert.equal((await call(db, { auth: teacherA, action: 'order_transition', taskId: body.taskId,
    itemIndex: 0, next: 'hand', revision: 1 }, '/book-issue')).body.status, 'student_handed');
  assert.equal((await call(db, { auth: admin, action: 'order_transition', taskId: body.taskId,
    itemIndex: 0, next: 'academy_register', revision: 2 }, '/book-issue')).body.status, 'academy_registered');
  const catalog = db.prepare('SELECT * FROM completed_book_catalog WHERE app=? AND catalog_id=?')
    .bind('task', body.items[0].bookId).first();
  assert.equal(catalog.publisher_name, '');
  assert.equal(catalog.vendor_name, ONLINE_BOOK_VENDOR);
  assert.equal(catalog.verification_status, 'fallback_search_disabled');
});

test('manual_online_result 실패는 admin도 기록할 수 있지만 주문완료로 가장하거나 수령할 수 없다', async () => {
  const db = new TestD1(); seed(db);
  const body = manualBody('ord_manual_fail01', { bookId: 'BK_MANUAL_FAIL' });
  assert.equal((await call(db, body)).status, 201);
  const invalidRevision = await call(db, { auth: admin, action: 'manual_online_result', taskId: body.taskId,
    result: 'failed', revision: 0.5 }, '/book-issue');
  assert.equal(invalidRevision.status, 400);
  const failed = await call(db, { auth: admin, action: 'manual_online_result', taskId: body.taskId,
    result: 'failed', revision: 0 }, '/book-issue');
  assert.equal(failed.status, 200);
  assert.equal(failed.body.status, 'rejected');
  const listed = await call(db, { auth: teacherA, action: 'list' }, '/book-issue');
  assert.equal(listed.body.orders.find(row => row.taskId === body.taskId).stage, 'order_failed');
  const receive = await call(db, { auth: teacherA, action: 'order_transition', taskId: body.taskId,
    itemIndex: 0, next: 'receive', revision: 0 }, '/book-issue');
  assert.equal(receive.status, 409);
  assert.equal(receive.body.code, 'ORDER_NOT_ACCEPTED');
});

test('052 카탈로그는 additive·append-only이며 과거 완료 일반교재만 개인정보 없는 DTO로 보강한다', async () => {
  for (const sql of [schema, migration]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS completed_book_catalog/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS completed_book_catalog_review_events/);
    assert.match(sql, /UNIQUE \(app, selected_normalized_publisher, selected_normalized_title\)/);
    assert.match(sql, /UNIQUE \(app, catalog_id, to_revision\)/);
    assert.doesNotMatch(sql, /DROP TABLE/i);
    const start = sql.indexOf('CREATE TABLE IF NOT EXISTS completed_book_catalog');
    const definition = sql.slice(start, sql.indexOf(');', start) + 2);
    assert.doesNotMatch(definition, /task_id|item_index|student|owner|teacher|phone|contact|address/i);
    const eventStart = sql.indexOf('CREATE TABLE IF NOT EXISTS completed_book_catalog_review_events');
    const eventDefinition = sql.slice(eventStart, sql.indexOf(');', eventStart) + 2);
    assert.doesNotMatch(eventDefinition, /task_id|item_index|student|owner|teacher|phone|contact|address|order_/i);
  }
  assert.match(migration, /json_extract\(task\.data,'\$\.orderDelivery'\) IN \('scheduled_batch_v1','manual_online_v1'\)/);
  assert.match(migration, /'legacy_fallback'/);
  assert.match(migration, /trg_completed_book_catalog_no_delete/);
  assert.match(migration, /trg_completed_book_catalog_review_no_update/);
  assert.match(migration, /trg_completed_book_catalog_review_no_delete/);

  const db = new TestD1(); seed(db);
  const now = Date.now();
  const task = {
    id: 'legacy-catalog-task', deleted: false, orderDelivery: 'scheduled_batch_v1', orderVendor: '천재출판사',
    orderItems: [{ bookId: 'BK_LEGACY_CAT', title: '과거 수학책', publisherName: '천재교육',
      studentIds: ['student-a'], qty: '1권', unitPrice: 12000 }]
  };
  db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', task.id, 'teacher-a', JSON.stringify(task), now, now).run();
  db.prepare(
    'INSERT INTO book_order_fulfillments(app,task_id,item_index,book_id,student_ids,status,revision,' +
      'teacher_received_at,teacher_received_by,student_handed_at,student_handed_by,academy_registered_at,' +
      'academy_registered_by,created_at,updated_at) VALUES(?,?,?,?,?,?,3,?,?,?,?,?,?,?,?)'
  ).bind('task', task.id, 0, 'BK_LEGACY_CAT', JSON.stringify(['student-a']), 'academy_registered',
    now - 2000, 'teacher-a', now - 1000, 'teacher-a', now, 'director', now - 2000, now).run();
  db.database.exec(migration);

  const stored = db.prepare('SELECT * FROM completed_book_catalog WHERE catalog_id=?').bind('BK_LEGACY_CAT').first();
  assert.equal(stored.verification_status, 'legacy_fallback');
  assert.equal(stored.selected_publisher_name, '천재교육');
  assert.equal(stored.selected_normalized_title, normalizeCatalogPart('과거 수학책'));
  assert.equal(stored.selected_normalized_publisher, normalizeCatalogPart('천재교육'));
  assert.throws(() => db.prepare("UPDATE completed_book_catalog SET title='변조' WHERE catalog_id='BK_LEGACY_CAT'").run(),
    /COMPLETED_BOOK_CATALOG_IMMUTABLE/);
  assert.throws(() => db.prepare("DELETE FROM completed_book_catalog WHERE catalog_id='BK_LEGACY_CAT'").run(),
    /COMPLETED_BOOK_CATALOG_APPEND_ONLY/);

  assert.equal((await call(db, { action: 'list' }, '/book-catalog')).status, 401);
  const listed = await call(db, { auth: teacherB, action: 'list' }, '/book-catalog');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.books.length, 0);
  assert.equal(listed.body.reviewCandidates.length, 1);
  const reviewCandidate = listed.body.reviewCandidates[0];
  assert.deepEqual(Object.keys(reviewCandidate).sort(), [
    'bookId', 'completedAt', 'publisherName', 'selectedPublisherName', 'sourceUrls', 'title', 'vendorName',
    'verificationStatus', 'verifiedAt', 'revision', 'reviewMethod', 'reviewedAt'
  ].sort());
  assert.equal(reviewCandidate.bookId, 'BK_LEGACY_CAT');
  assert.equal(reviewCandidate.selectedPublisherName, '천재교육');
  assert.equal(reviewCandidate.verificationStatus, 'legacy_fallback');
  assert.equal(JSON.stringify(listed.body).includes(task.id), false);
  assert.equal(JSON.stringify(listed.body).includes('student-a'), false);
  assert.equal(JSON.stringify(listed.body).includes('가학생'), false);
});

test('review_approve는 관리자만 exact CAS로 검토 후보를 승인하고 immutable 분류와 append-only 원장을 보존한다', async () => {
  const db = new TestD1(); seed(db);
  insertPendingCatalog(db, { id: 'BK_REVIEW_APPROVE', title: '수학 기본서', publisher: '미래앤',
    vendor: '동아출판사', status: 'fallback_mismatch' });
  const payload = { action: 'review_approve', bookId: 'BK_REVIEW_APPROVE', expectedRevision: 0,
    title: '수학 기본서 개정', publisherName: '미래엔' };

  const forbidden = await call(db, { auth: teacherA, ...payload }, '/book-catalog');
  assert.equal(forbidden.status, 403);
  assert.equal(db.prepare('SELECT revision FROM completed_book_catalog WHERE catalog_id=?')
    .bind(payload.bookId).first().revision, 0);

  for (const invalid of [
    { ...payload, title: '' },
    { ...payload, publisherName: '' },
    { ...payload, title: '가'.repeat(161) },
    { ...payload, expectedRevision: 0.5 },
    { ...payload, studentIds: ['student-a'] }
  ]) {
    assert.equal((await call(db, { auth: admin, ...invalid }, '/book-catalog')).status, 400);
  }

  const approved = await call(db, { auth: admin, ...payload }, '/book-catalog');
  assert.equal(approved.status, 200);
  assert.equal(approved.body.idempotent, false);
  assert.deepEqual(Object.keys(approved.body.book).sort(), [
    'bookId', 'completedAt', 'publisherName', 'selectedPublisherName', 'sourceUrls', 'title', 'vendorName',
    'verificationStatus', 'verifiedAt', 'revision', 'reviewMethod', 'reviewedAt'
  ].sort());
  assert.equal(approved.body.book.verificationStatus, 'verified');
  assert.equal(approved.body.book.revision, 1);
  assert.equal(approved.body.book.reviewMethod, 'admin');
  assert.equal(Object.hasOwn(approved.body.book, 'reviewedBy'), false);
  assert.ok(approved.body.book.reviewedAt > 0);

  const stored = db.prepare('SELECT * FROM completed_book_catalog WHERE catalog_id=?').bind(payload.bookId).first();
  assert.equal(stored.title, payload.title);
  assert.equal(stored.publisher_name, payload.publisherName);
  assert.equal(stored.verification_status, 'verified');
  assert.equal(stored.revision, 1);
  assert.equal(stored.review_method, 'admin');
  assert.equal(stored.reviewed_by, 'director');
  assert.ok(stored.reviewed_at > 0);
  assert.equal(stored.selected_publisher_name, '미래앤');
  assert.equal(stored.vendor_name, '동아출판사');

  const events = db.prepare('SELECT * FROM completed_book_catalog_review_events WHERE catalog_id=? ORDER BY to_revision')
    .bind(payload.bookId).all().results;
  assert.equal(events.length, 1);
  assert.equal(events[0].from_status, 'fallback_mismatch');
  assert.equal(events[0].from_revision, 0);
  assert.equal(events[0].to_revision, 1);
  assert.equal(events[0].title, payload.title);
  assert.equal(events[0].publisher_name, payload.publisherName);
  assert.equal(events[0].reviewed_by, 'director');
  assert.ok(events[0].reviewed_at > 0);
  assert.equal(JSON.stringify(events[0]).includes('student-a'), false);
  assert.throws(() => db.prepare('UPDATE completed_book_catalog_review_events SET title=? WHERE event_id=?')
    .bind('변조', events[0].event_id).run(), /APPEND_ONLY|REVIEW_EVENT/i);
  assert.throws(() => db.prepare('DELETE FROM completed_book_catalog_review_events WHERE event_id=?')
    .bind(events[0].event_id).run(), /APPEND_ONLY|REVIEW_EVENT/i);

  const retry = await call(db, { auth: admin, ...payload }, '/book-catalog');
  assert.equal(retry.status, 200);
  assert.equal(retry.body.idempotent, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM completed_book_catalog_review_events WHERE catalog_id=?')
    .bind(payload.bookId).first().count, 1);

  const listedAfterReview = await call(db, { auth: teacherA, action: 'list' }, '/book-catalog');
  assert.equal(listedAfterReview.body.books.some(book => book.bookId === payload.bookId), true);
  assert.equal(listedAfterReview.body.reviewCandidates.some(book => book.bookId === payload.bookId), false);

  const stale = await call(db, { auth: admin, ...payload, title: '다른 제목' }, '/book-catalog');
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'REVISION_CONFLICT');

  insertPendingCatalog(db, { id: 'BK_REVIEW_PENDING' });
  const pending = await call(db, { auth: admin, ...payload, bookId: 'BK_REVIEW_PENDING' }, '/book-catalog');
  assert.equal(pending.status, 409);
  assert.equal(pending.body.code, 'BOOK_CATALOG_PENDING');
  const missing = await call(db, { auth: admin, ...payload, bookId: 'BK_REVIEW_MISSING' }, '/book-catalog');
  assert.equal(missing.status, 404);
});

test('review event insert와 catalog CAS update는 한 batch로 rollback된다', async () => {
  const db = new TestD1(); seed(db);
  insertPendingCatalog(db, { id: 'BK_REVIEW_ATOMIC', status: 'fallback_insufficient_evidence' });
  db.database.exec(
    "CREATE TRIGGER test_review_catalog_failure BEFORE UPDATE ON completed_book_catalog " +
    "WHEN NEW.catalog_id='BK_REVIEW_ATOMIC' BEGIN SELECT RAISE(ABORT,'TEST_REVIEW_CATALOG_FAIL'); END"
  );
  const failed = await call(db, { auth: admin, action: 'review_approve', bookId: 'BK_REVIEW_ATOMIC',
    expectedRevision: 0, title: '수학 기본서', publisherName: '천재교육' }, '/book-catalog');
  assert.equal(failed.status, 500);
  const row = db.prepare('SELECT verification_status,revision,review_method FROM completed_book_catalog WHERE catalog_id=?')
    .bind('BK_REVIEW_ATOMIC').first();
  assert.deepEqual([row.verification_status, row.revision, row.review_method],
    ['fallback_insufficient_evidence', 0, 'web_search']);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM completed_book_catalog_review_events WHERE catalog_id=?')
    .bind('BK_REVIEW_ATOMIC').first().count, 0);
});

test('academy_register와 카탈로그 insert는 원자적이고 같은 선택 출판사·교재명은 한 번만 누적된다', async () => {
  const db = new TestD1(); seed(db);
  const first = orderBody('ord_dedupe_000001', { bookId: 'BK_DEDUPE_A', title: '중학 수학 완성' });
  assert.equal((await call(db, first)).status, 201);
  assert.equal((await completeScheduled(db, first.taskId)).status, 200);
  const second = orderBody('ord_dedupe_000002', { bookId: 'BK_DEDUPE_B', title: '  중학   수학 완성  ' });
  assert.equal((await call(db, second)).status, 201);
  assert.equal((await completeScheduled(db, second.taskId)).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM completed_book_catalog').first().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM book_order_fulfillments WHERE status='academy_registered'").first().count, 2);
  assert.equal(db.prepare('SELECT catalog_id FROM completed_book_catalog').first().catalog_id, 'BK_DEDUPE_A');

  const atomic = orderBody('ord_atomic_000001', { bookId: 'BK_ATOMIC_FAIL', title: '원자성 확인 교재' });
  assert.equal((await call(db, atomic)).status, 201);
  markScheduledAccepted(db, atomic.taskId);
  assert.equal((await call(db, { auth: teacherA, action: 'order_transition', taskId: atomic.taskId,
    itemIndex: 0, next: 'receive', revision: 0 }, '/book-issue')).status, 200);
  assert.equal((await call(db, { auth: teacherA, action: 'order_transition', taskId: atomic.taskId,
    itemIndex: 0, next: 'hand', revision: 1 }, '/book-issue')).status, 200);
  db.database.exec(
    "CREATE TRIGGER test_catalog_insert_failure BEFORE INSERT ON completed_book_catalog " +
    "WHEN NEW.catalog_id='BK_ATOMIC_FAIL' BEGIN SELECT RAISE(ABORT,'TEST_CATALOG_FAIL'); END"
  );
  const failed = await call(db, { auth: admin, action: 'order_transition', taskId: atomic.taskId,
    itemIndex: 0, next: 'academy_register', revision: 2 }, '/book-issue');
  assert.equal(failed.status, 500);
  assert.match(String(failed.body && failed.body.error || ''), /TEST_CATALOG_FAIL/);
  const fulfillment = db.prepare('SELECT status,revision,academy_registered_at FROM book_order_fulfillments WHERE task_id=?')
    .bind(atomic.taskId).first();
  assert.deepEqual([fulfillment.status, fulfillment.revision, fulfillment.academy_registered_at],
    ['student_handed', 2, null]);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM completed_book_catalog WHERE catalog_id='BK_ATOMIC_FAIL'").first().count, 0);
});

test('AI feature flag·binding에 따라 pending 또는 명시적 fallback을 선택하고 제본은 카탈로그에서 제외한다', () => {
  const item = { bookId: 'BK_AI_FLAG', title: 'AI 확인 교재', publisherName: '천재교육' };
  const task = { orderDelivery: 'scheduled_batch_v1', orderVendor: '천재출판사' };
  assert.equal(completedCatalogRecord({}, item, task, 1).verificationStatus, 'fallback_search_disabled');
  assert.equal(completedCatalogRecord({ WB_BOOK_CATALOG_WEB_SEARCH_ENABLED: 'true' }, item, task, 1).verificationStatus,
    'fallback_ai_unavailable');
  assert.equal(completedCatalogRecord({ WB_BOOK_CATALOG_WEB_SEARCH_ENABLED: 'true', AI: { run() {} } }, item, task, 1)
    .verificationStatus, 'pending');
  assert.equal(completedCatalogRecord({}, item, { ...task, orderDelivery: 'bound_print_v1' }, 1), null);
  assert.match(wrangler, /WB_BOOK_CATALOG_WEB_SEARCH_ENABLED\s*=\s*"true"/);
  assert.match(wrangler, /\[ai\][\s\S]*binding\s*=\s*"AI"/);
  assert.match(catalogSource, /const AI_MODEL = 'xai\/grok-4\.20-multi-agent-0309'/);
  assert.match(catalogSource, /const AI_TIMEOUT_MS = 12000/);
  assert.match(catalogSource, /tools: \[\{ type: 'web_search' \}\]/);
  assert.match(catalogSource, /gateway: \{ id: 'default' \}/);
  for (const domain of ['search.shopping.naver.com', 'smartstore.naver.com', 'brand.naver.com',
    'product.kyobobook.co.kr', 'www.yes24.com', 'www.aladin.co.kr', 'www.coupang.com']) {
    assert.ok(catalogSource.includes("'" + domain + "'"), domain);
  }
  assert.match(catalogSource, /MAX_EVIDENCE_FETCHES = 3/);
  assert.match(catalogSource, /MAX_EVIDENCE_BODY_BYTES = 512 \* 1024/);
  assert.match(catalogSource, /redirect: 'manual'/);
});

test('web_search 자동 검증은 compact exact 제목과 신뢰 근거만 확정하고 fuzzy·근거부족·오류는 fallback한다', async () => {
  const db = new TestD1();
  const calls = [];
  insertPendingCatalog(db, { id: 'BK_AI_VERIFIED', publisher: '미래앤', vendor: '동아출판사' });
  await verifyCompletedCatalogEntry({
    DB: db,
    WB_BOOK_CATALOG_WEB_SEARCH_ENABLED: 'true',
    BOOK_CATALOG_FETCH: async () => new Response(
      '<html><head><title>수학-기본서</title></head><body>출판사 미래엔</body></html>',
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }
    ),
    AI: { run: async (...args) => {
      calls.push(args);
      return { output_text: JSON.stringify({
        title: '수학-기본서', publisherName: '미래엔',
        sourceUrls: ['https://product.kyobobook.co.kr/detail/S000001', 'http://product.kyobobook.co.kr/unsafe',
          'javascript:alert(1)']
      }) };
    } }
  }, 'BK_AI_VERIFIED');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'xai/grok-4.20-multi-agent-0309');
  assert.deepEqual(calls[0][1].tools, [{ type: 'web_search' }]);
  assert.deepEqual(calls[0][2], { gateway: { id: 'default' } });
  const verified = db.prepare('SELECT * FROM completed_book_catalog WHERE catalog_id=?').bind('BK_AI_VERIFIED').first();
  assert.equal(verified.verification_status, 'verified');
  assert.equal(verified.title, '수학-기본서');
  assert.equal(verified.publisher_name, '미래엔');
  assert.equal(verified.selected_publisher_name, '미래앤');
  assert.deepEqual(JSON.parse(verified.source_urls), ['https://product.kyobobook.co.kr/detail/S000001']);
  assert.ok(verified.verified_at > 0);
  assert.equal(verified.selected_normalized_title, normalizeCatalogPart('수학 기본서'));
  assert.equal(verified.selected_normalized_publisher, normalizeCatalogPart('미래앤'));

  insertPendingCatalog(db, { id: 'BK_AI_NOSOURCE', title: '영어 기본서' });
  await verifyCompletedCatalogEntry({ DB: db, WB_BOOK_CATALOG_WEB_SEARCH_ENABLED: 'true',
    AI: { run: async () => ({ output_text: JSON.stringify({ title: '영어 기본서', publisherName: '천재교육', sourceUrls: [] }) }) } },
  'BK_AI_NOSOURCE');
  assert.equal(db.prepare('SELECT verification_status FROM completed_book_catalog WHERE catalog_id=?')
    .bind('BK_AI_NOSOURCE').first().verification_status, 'fallback_no_source');

  insertPendingCatalog(db, { id: 'BK_AI_ONE_UNTRUSTED', title: '영어 심화 기본서' });
  await verifyCompletedCatalogEntry({ DB: db, WB_BOOK_CATALOG_WEB_SEARCH_ENABLED: 'true',
    AI: { run: async () => ({ output_text: JSON.stringify({ title: '영어-심화 기본서', publisherName: '천재교육',
      sourceUrls: ['https://example.com/only-one'] }) }) } }, 'BK_AI_ONE_UNTRUSTED');
  const oneUntrusted = db.prepare('SELECT title,verification_status,source_urls FROM completed_book_catalog WHERE catalog_id=?')
    .bind('BK_AI_ONE_UNTRUSTED').first();
  assert.equal(oneUntrusted.title, '영어 심화 기본서');
  assert.equal(oneUntrusted.verification_status, 'fallback_insufficient_evidence');
  assert.deepEqual(JSON.parse(oneUntrusted.source_urls), ['https://example.com/only-one']);

  insertPendingCatalog(db, { id: 'BK_AI_HTTP_EVIDENCE', title: '영어 문법 기본서' });
  await verifyCompletedCatalogEntry({ DB: db, WB_BOOK_CATALOG_WEB_SEARCH_ENABLED: 'true',
    AI: { run: async () => ({ output_text: JSON.stringify({ title: '영어 문법 기본서', publisherName: '천재교육',
      sourceUrls: ['http://product.kyobobook.co.kr/not-trusted', 'https://single.example/evidence'] }) }) } },
  'BK_AI_HTTP_EVIDENCE');
  const httpEvidence = db.prepare('SELECT verification_status,source_urls FROM completed_book_catalog WHERE catalog_id=?')
    .bind('BK_AI_HTTP_EVIDENCE').first();
  assert.equal(httpEvidence.verification_status, 'fallback_insufficient_evidence');
  assert.deepEqual(JSON.parse(httpEvidence.source_urls), ['https://single.example/evidence']);

  insertPendingCatalog(db, { id: 'BK_AI_SAME_HOST', title: '과학 탐구 기본서' });
  await verifyCompletedCatalogEntry({ DB: db, WB_BOOK_CATALOG_WEB_SEARCH_ENABLED: 'true',
    AI: { run: async () => ({ output_text: JSON.stringify({ title: '과학 탐구 기본서', publisherName: '천재교육',
      sourceUrls: ['https://same.example/first', 'https://same.example/second'] }) }) } }, 'BK_AI_SAME_HOST');
  assert.equal(db.prepare('SELECT verification_status FROM completed_book_catalog WHERE catalog_id=?')
    .bind('BK_AI_SAME_HOST').first().verification_status, 'fallback_insufficient_evidence');

  insertPendingCatalog(db, { id: 'BK_AI_MISMATCH', title: '국어 독해집' });
  await verifyCompletedCatalogEntry({ DB: db, WB_BOOK_CATALOG_WEB_SEARCH_ENABLED: 'true',
    AI: { run: async () => ({ output_text: JSON.stringify({ title: '완전히 다른 책', publisherName: '천재교육',
      sourceUrls: ['https://product.kyobobook.co.kr/detail/wrong'] }) }) } }, 'BK_AI_MISMATCH');
  const mismatch = db.prepare('SELECT title,verification_status,source_urls FROM completed_book_catalog WHERE catalog_id=?')
    .bind('BK_AI_MISMATCH').first();
  assert.equal(mismatch.title, '국어 독해집');
  assert.equal(mismatch.verification_status, 'fallback_mismatch');
  assert.deepEqual(JSON.parse(mismatch.source_urls), ['https://product.kyobobook.co.kr/detail/wrong']);

  insertPendingCatalog(db, { id: 'BK_AI_FUZZY', title: '최고수준 수학 중등' });
  await verifyCompletedCatalogEntry({ DB: db, WB_BOOK_CATALOG_WEB_SEARCH_ENABLED: 'true',
    AI: { run: async () => ({ output_text: JSON.stringify({ title: '최고수준 수학 심화', publisherName: '천재교육',
      sourceUrls: ['https://product.kyobobook.co.kr/detail/fuzzy'] }) }) } }, 'BK_AI_FUZZY');
  const fuzzy = db.prepare('SELECT title,verification_status,selected_publisher_name FROM completed_book_catalog WHERE catalog_id=?')
    .bind('BK_AI_FUZZY').first();
  assert.equal(fuzzy.title, '최고수준 수학 중등');
  assert.equal(fuzzy.verification_status, 'fallback_mismatch');
  assert.equal(fuzzy.selected_publisher_name, '천재교육');

  insertPendingCatalog(db, { id: 'BK_AI_RPM_ALIAS', title: 'RPM 수학 기본', publisher: 'RPM', vendor: '동아출판사' });
  await verifyCompletedCatalogEntry({ DB: db, WB_BOOK_CATALOG_WEB_SEARCH_ENABLED: 'true',
    BOOK_CATALOG_FETCH: async () => new Response('<html><body>RPM 수학 기본 · 개념원리</body></html>',
      { status: 200, headers: { 'content-type': 'text/html' } }),
    AI: { run: async () => ({ output_text: JSON.stringify({ title: 'RPM 수학 기본', publisherName: '개념원리',
      sourceUrls: ['https://product.kyobobook.co.kr/detail/S000009'] }) }) } }, 'BK_AI_RPM_ALIAS');
  const rpmAlias = db.prepare('SELECT publisher_name,selected_publisher_name,verification_status FROM completed_book_catalog WHERE catalog_id=?')
    .bind('BK_AI_RPM_ALIAS').first();
  assert.equal(rpmAlias.publisher_name, '개념원리');
  assert.equal(rpmAlias.selected_publisher_name, 'RPM');
  assert.equal(rpmAlias.verification_status, 'verified');

  insertPendingCatalog(db, { id: 'BK_AI_NUMBER', title: '개념원리 수학 1' });
  await verifyCompletedCatalogEntry({ DB: db, WB_BOOK_CATALOG_WEB_SEARCH_ENABLED: 'true',
    AI: { run: async () => ({ output_text: JSON.stringify({ title: '개념원리 수학 2', publisherName: '천재교육',
      sourceUrls: ['https://product.kyobobook.co.kr/detail/number'] }) }) } }, 'BK_AI_NUMBER');
  const numberMismatch = db.prepare('SELECT title,verification_status FROM completed_book_catalog WHERE catalog_id=?')
    .bind('BK_AI_NUMBER').first();
  assert.equal(numberMismatch.title, '개념원리 수학 1');
  assert.equal(numberMismatch.verification_status, 'fallback_mismatch');

  insertPendingCatalog(db, { id: 'BK_AI_ERROR', title: '과학 기본서' });
  await verifyCompletedCatalogEntry({ DB: db, WB_BOOK_CATALOG_WEB_SEARCH_ENABLED: 'true',
    AI: { run: async () => { throw new Error('provider unavailable'); } } }, 'BK_AI_ERROR');
  assert.equal(db.prepare('SELECT verification_status FROM completed_book_catalog WHERE catalog_id=?')
    .bind('BK_AI_ERROR').first().verification_status, 'fallback_ai_error');

  insertPendingCatalog(db, { id: 'BK_AI_TIMEOUT', title: '사회 기본서' });
  const nativeSetTimeout = globalThis.setTimeout;
  let requestedTimeout = null;
  globalThis.setTimeout = (callback, delay, ...args) => {
    requestedTimeout = delay;
    return nativeSetTimeout(callback, 0, ...args);
  };
  try {
    await verifyCompletedCatalogEntry({ DB: db, WB_BOOK_CATALOG_WEB_SEARCH_ENABLED: 'true',
      AI: { run: () => new Promise(() => {}) } }, 'BK_AI_TIMEOUT');
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
  }
  assert.equal(requestedTimeout, 12000);
  assert.equal(db.prepare('SELECT verification_status FROM completed_book_catalog WHERE catalog_id=?')
    .bind('BK_AI_TIMEOUT').first().verification_status, 'fallback_ai_error');
});

test('상품 상세 근거는 bounded fetch로 본문을 대조하고 무관·SSRF redirect·oversize를 fail-closed 처리한다', async () => {
  const db = new TestD1();
  async function verifyCase({ id, title, sourceUrl, fetcher }) {
    insertPendingCatalog(db, { id, title, publisher: '천재교육', vendor: '천재출판사' });
    await verifyCompletedCatalogEntry({
      DB: db,
      WB_BOOK_CATALOG_WEB_SEARCH_ENABLED: 'true',
      BOOK_CATALOG_FETCH: fetcher,
      AI: { run: async () => ({ output_text: JSON.stringify({
        title, publisherName: '천재교육', sourceUrls: [sourceUrl]
      }) }) }
    }, id);
    return db.prepare('SELECT * FROM completed_book_catalog WHERE catalog_id=?').bind(id).first();
  }

  let unrelatedCalls = 0;
  const unrelated = await verifyCase({
    id: 'BK_EVIDENCE_UNRELATED', title: '정확한 국어 독해',
    sourceUrl: 'https://product.kyobobook.co.kr/detail/S000101',
    fetcher: async (url, options) => {
      unrelatedCalls += 1;
      assert.equal(url, 'https://product.kyobobook.co.kr/detail/S000101');
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'manual');
      assert.ok(options.signal instanceof AbortSignal);
      return new Response('<html><body>전혀 다른 수학 교재 · 다른출판사</body></html>', {
        status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }
      });
    }
  });
  assert.equal(unrelatedCalls, 1);
  assert.equal(unrelated.verification_status, 'fallback_insufficient_evidence');
  assert.equal(unrelated.title, '정확한 국어 독해');

  let redirectCalls = 0;
  const blockedRedirect = await verifyCase({
    id: 'BK_EVIDENCE_REDIRECT_BLOCK', title: '리다이렉트 차단 교재',
    sourceUrl: 'https://www.yes24.com/Product/Goods/10001',
    fetcher: async () => {
      redirectCalls += 1;
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
    }
  });
  assert.equal(redirectCalls, 1, '허용 목록 밖 redirect는 따라가면 안 됩니다');
  assert.equal(blockedRedirect.verification_status, 'fallback_insufficient_evidence');

  let fakeHostCalls = 0;
  const fakeHost = await verifyCase({
    id: 'BK_EVIDENCE_FAKE_HOST', title: '가짜 호스트 교재',
    sourceUrl: 'https://product.kyobobook.co.kr.evil.example/detail/S000102',
    fetcher: async () => {
      fakeHostCalls += 1;
      return new Response('<html><body>가짜 호스트 교재 천재교육</body></html>', {
        status: 200, headers: { 'content-type': 'text/html' }
      });
    }
  });
  assert.equal(fakeHostCalls, 0, '접미사가 비슷한 외부 host는 요청하면 안 됩니다');
  assert.equal(fakeHost.verification_status, 'fallback_insufficient_evidence');

  const oversizedBody = '가'.repeat(180000);
  assert.ok(new TextEncoder().encode(oversizedBody).byteLength > 512 * 1024);
  const oversized = await verifyCase({
    id: 'BK_EVIDENCE_OVERSIZED', title: '대용량 교재',
    sourceUrl: 'https://www.coupang.com/vp/products/10002',
    fetcher: async () => new Response(oversizedBody, {
      status: 200, headers: { 'content-type': 'text/html' }
    })
  });
  assert.equal(oversized.verification_status, 'fallback_insufficient_evidence');

  const wrongContentType = await verifyCase({
    id: 'BK_EVIDENCE_WRONG_TYPE', title: '응답 형식 교재',
    sourceUrl: 'https://search.shopping.naver.com/book/catalog/10003',
    fetcher: async () => new Response(JSON.stringify({ title: '응답 형식 교재', publisher: '천재교육' }), {
      status: 200, headers: { 'content-type': 'application/json' }
    })
  });
  assert.equal(wrongContentType.verification_status, 'fallback_insufficient_evidence');
});

test('허용된 상품 상세 redirect의 최종 URL과 compact exact 제목·호환 출판사를 확인한 경우만 자동 확정한다', async () => {
  const db = new TestD1();
  insertPendingCatalog(db, { id: 'BK_EVIDENCE_VALID_REDIRECT', title: '정상 상세 교재',
    publisher: '세듀', vendor: '청암출판사' });
  const requested = [];
  await verifyCompletedCatalogEntry({
    DB: db,
    WB_BOOK_CATALOG_WEB_SEARCH_ENABLED: 'true',
    BOOK_CATALOG_FETCH: async (url, options) => {
      requested.push([url, options.redirect]);
      if (requested.length === 1) {
        return new Response(null, { status: 302,
          headers: { location: 'https://product.kyobobook.co.kr/detail/S000105' } });
      }
      return new Response('<html><body><h1>정상 상세 <em>교재</em></h1><div>출판사: 쎄듀</div></body></html>', {
        status: 200,
        headers: { 'content-type': 'application/xhtml+xml; charset=utf-8', 'content-length': '120' }
      });
    },
    AI: { run: async () => ({ output_text: JSON.stringify({
      title: '정상-상세 교재', publisherName: '쎄듀',
      sourceUrls: ['https://product.kyobobook.co.kr/detail/S000104']
    }) }) }
  }, 'BK_EVIDENCE_VALID_REDIRECT');
  assert.deepEqual(requested, [
    ['https://product.kyobobook.co.kr/detail/S000104', 'manual'],
    ['https://product.kyobobook.co.kr/detail/S000105', 'manual']
  ]);
  const stored = db.prepare('SELECT * FROM completed_book_catalog WHERE catalog_id=?')
    .bind('BK_EVIDENCE_VALID_REDIRECT').first();
  assert.equal(stored.verification_status, 'verified');
  assert.equal(stored.title, '정상-상세 교재');
  assert.equal(stored.publisher_name, '쎄듀');
  assert.equal(stored.selected_publisher_name, '세듀');
  assert.deepEqual(JSON.parse(stored.source_urls), ['https://product.kyobobook.co.kr/detail/S000105']);
});
