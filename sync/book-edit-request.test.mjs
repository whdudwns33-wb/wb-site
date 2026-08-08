import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

import worker from './worker-core.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/015_book_edit_requests.sql', import.meta.url), 'utf8');

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
  constructor() {
    this.database = new DatabaseSync(':memory:');
    this.database.exec(schema);
  }
  prepare(sql) { return new D1Statement(this.database, sql); }
  batch(statements) { return statements.map(s => s.run()); }
}

const admin = { mode: 'admin', secret: 'director-secret' };
const person = (id, token) => ({ mode: 'person', id, token });

async function call(db, path, body) {
  const response = await worker.fetch(new Request('https://worker.example' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app: 'task', ...body })
  }), { DB: db, TASK_ADMIN_SECRET: 'director-secret', CONSULT_ADMIN_SECRET: 'consult-secret' });
  return { status: response.status, body: await response.json() };
}

function seed(db) {
  const now = Date.now();
  db.prepare("INSERT INTO staff (app,id,owner,data,updated_at,srv_at) VALUES ('task','S-kim','S-kim',?,?,?)")
    .bind(JSON.stringify({ id: 'S-kim', name: '김남기', owner: false, createdAt: now, updatedAt: now, deleted: false }), now, now).run();
  db.prepare("INSERT INTO tokens (app,token,staff_id,created_at,revoked) VALUES ('task','tok-kim','S-kim',?,0)").bind(now).run();
  db.prepare("INSERT INTO staff (app,id,owner,data,updated_at,srv_at) VALUES ('task','S-other','S-other',?,?,?)")
    .bind(JSON.stringify({ id: 'S-other', name: '다른쌤', owner: false, createdAt: now, updatedAt: now, deleted: false }), now, now).run();
  db.prepare("INSERT INTO tokens (app,token,staff_id,created_at,revoked) VALUES ('task','tok-other','S-other',?,0)").bind(now).run();
}

test('schema and migration are additive and restrict states', () => {
  for (const sql of [schema, migration]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS book_edit_requests/);
    for (const status of ['approval_waiting', 'approved', 'rejected', 'cancelled']) {
      assert.ok(sql.includes("'" + status + "'"));
    }
    assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM/i);
  }
});

test('unauthenticated request is rejected', async () => {
  const db = new TestD1(); seed(db);
  const r = await call(db, '/book-edit-request', { action: 'list' });
  assert.equal(r.status, 401);
});

test('staff proposing an edit goes to approval_waiting, not visible in list_approved yet', async () => {
  const db = new TestD1(); seed(db);
  const submit = await call(db, '/book-edit-request', {
    auth: person('S-kim', 'tok-kim'), action: 'submit', bookId: 'BK08', title: '독해창 비상1(개정판)',
    subject: '국어 독해', level: '중1', vendorName: '동아출판사',
    units: [{ name: 'Ⅰ. 사실적 독해', sections: ['중심 문장 찾기'] }], note: '실물 대조 완료'
  });
  assert.equal(submit.status, 200);
  assert.equal(submit.body.request.status, 'approval_waiting');
  assert.equal(submit.body.request.bookId, 'BK08');

  const approvedList = await call(db, '/book-edit-request', { auth: person('S-kim', 'tok-kim'), action: 'list_approved' });
  assert.equal(approvedList.body.edits.length, 0, '승인 전에는 반영 대상 목록에 나타나지 않는다');
});

test('director submitting is auto-approved and shows up immediately in list_approved', async () => {
  const db = new TestD1(); seed(db);
  const submit = await call(db, '/book-edit-request', {
    auth: admin, action: 'submit', bookId: 'BK06', title: 'WB 자체 독해교재(수정)', note: '챕터 정보 확인됨'
  });
  assert.equal(submit.body.request.status, 'approved', '원장 신청은 검토 없이 바로 승인된다');

  const approvedList = await call(db, '/book-edit-request', { auth: person('S-kim', 'tok-kim'), action: 'list_approved' });
  assert.equal(approvedList.body.edits.length, 1);
  assert.equal(approvedList.body.edits[0].bookId, 'BK06');
});

test('director approves a staff edit, then it appears in list_approved', async () => {
  const db = new TestD1(); seed(db);
  const submit = await call(db, '/book-edit-request', {
    auth: person('S-kim', 'tok-kim'), action: 'submit', bookId: 'BK09', title: '어휘 5단계(정식명)', level: '초3'
  });
  const { requestKey } = submit.body.request;

  const listPending = await call(db, '/book-edit-review', { auth: admin, action: 'list', status: 'approval_waiting' });
  assert.equal(listPending.body.requests.length, 1);

  const wrongRevision = await call(db, '/book-edit-review', { auth: admin, action: 'approve', requestKey, revision: 99 });
  assert.equal(wrongRevision.status, 409);

  const approve = await call(db, '/book-edit-review', { auth: admin, action: 'approve', requestKey, revision: 1 });
  assert.equal(approve.status, 200);
  assert.equal(approve.body.request.status, 'approved');

  const approvedList = await call(db, '/book-edit-request', { auth: person('S-other', 'tok-other'), action: 'list_approved' });
  assert.equal(approvedList.body.edits.length, 1);
  assert.equal(approvedList.body.edits[0].title, '어휘 5단계(정식명)');

  const again = await call(db, '/book-edit-review', { auth: admin, action: 'approve', requestKey, revision: 1 });
  assert.equal(again.body.idempotent, true, '이미 승인된 신청을 다시 승인해도 안전하다');
});

test('director can reject with a note, and staff sees it in their own list', async () => {
  const db = new TestD1(); seed(db);
  const submit = await call(db, '/book-edit-request', {
    auth: person('S-kim', 'tok-kim'), action: 'submit', bookId: 'BK10', title: '논리와 상상 도약5(오타 수정)'
  });
  const { requestKey, revision } = submit.body.request;

  const reject = await call(db, '/book-edit-review', {
    auth: admin, action: 'reject', requestKey, revision, note: '원본이 맞습니다, 다시 확인해 주세요'
  });
  assert.equal(reject.body.request.status, 'rejected');

  const mine = await call(db, '/book-edit-request', { auth: person('S-kim', 'tok-kim'), action: 'list' });
  assert.equal(mine.body.requests[0].status, 'rejected');
  assert.match(mine.body.requests[0].reviewNote, /원본이 맞습니다/);
});

test('resubmitting for the same book updates the same request instead of creating a new one', async () => {
  const db = new TestD1(); seed(db);
  const first = await call(db, '/book-edit-request', {
    auth: person('S-kim', 'tok-kim'), action: 'submit', bookId: 'BK11', title: '예비 매3비'
  });
  const second = await call(db, '/book-edit-request', {
    auth: person('S-other', 'tok-other'), action: 'submit', bookId: 'BK11', title: '예비 매3비', level: '고1'
  });
  assert.equal(first.body.request.requestKey, second.body.request.requestKey, '같은 책이면 누가 신청하든 같은 행을 쓴다');
  assert.equal(second.body.request.revision, 2);

  const rows = db.prepare("SELECT COUNT(*) as n FROM book_edit_requests WHERE app='task'").first();
  assert.equal(rows.n, 1, '새 행이 아니라 같은 행이 갱신된다');
});

test('staff can cancel their own pending edit', async () => {
  const db = new TestD1(); seed(db);
  await call(db, '/book-edit-request', { auth: person('S-kim', 'tok-kim'), action: 'submit', bookId: 'BK12', title: '우공비 비문학 독해 2' });
  const cancel = await call(db, '/book-edit-request', { auth: person('S-kim', 'tok-kim'), action: 'cancel', bookId: 'BK12' });
  assert.equal(cancel.body.request.status, 'cancelled');
});

test('forbidden fields and oversized input are rejected', async () => {
  const db = new TestD1(); seed(db);
  const emptyTitle = await call(db, '/book-edit-request', { auth: person('S-kim', 'tok-kim'), action: 'submit', bookId: 'BK13', title: '' });
  assert.equal(emptyTitle.status, 400);

  const badBookId = await call(db, '/book-edit-request', { auth: person('S-kim', 'tok-kim'), action: 'submit', bookId: '../../etc', title: 'x' });
  assert.equal(badBookId.status, 400);

  const tooLong = await call(db, '/book-edit-request', {
    auth: person('S-kim', 'tok-kim'), action: 'submit', bookId: 'BK14', title: 'x'.repeat(200)
  });
  assert.equal(tooLong.status, 413);
});

test('consult app cannot use this feature', async () => {
  const db = new TestD1(); seed(db);
  const response = await worker.fetch(new Request('https://worker.example/book-edit-request', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app: 'consult', auth: { mode: 'admin', secret: 'consult-secret' }, action: 'list_approved' })
  }), { DB: db, TASK_ADMIN_SECRET: 'director-secret', CONSULT_ADMIN_SECRET: 'consult-secret' });
  assert.equal(response.status, 400);
});
