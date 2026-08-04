import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./worker-core.js', import.meta.url), 'utf8');
const worker = (await import(new URL('./worker-core.js', import.meta.url))).default;
const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/010_feedback_requests.sql', import.meta.url), 'utf8');

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql.replace(/\s+/g, ' ').trim(); this.args = []; }
  bind(...args) { this.args = args; return this; }
  async first() { return this.db.first(this.sql, this.args); }
  async run() { return this.db.run(this.sql, this.args); }
  async all() { return this.db.all(this.sql, this.args); }
}

class FakeDB {
  constructor() {
    this.tasks = new Map();
    this.tokens = new Map();
    this.feedback = new Map();
  }
  prepare(sql) { return new Statement(this, sql); }
  addTask(id, owner, data = {}) { this.tasks.set(id, { owner, data: JSON.stringify(data) }); }
  addToken(token, staffId) { this.tokens.set(token, { staff_id: staffId }); }
  async first(sql, args) {
    if (sql.startsWith('SELECT staff_id FROM tokens')) return this.tokens.get(args[2]) || null;
    if (sql.startsWith('SELECT owner, data FROM tasks')) return this.tasks.get(args[1]) || null;
    if (sql.includes('FROM feedback_requests WHERE app=? AND task_id=?')) {
      return [...this.feedback.values()].find(row => row.app === args[0] && row.task_id === args[1] &&
        row.feedback_date === args[2] && row.feedback_type === args[3] && row.template_version === args[4]) || null;
    }
    if (sql.includes('FROM feedback_requests WHERE app=? AND request_key=?')) {
      const row = this.feedback.get(args[1]);
      return row && row.app === args[0] ? { ...row } : null;
    }
    throw new Error('Unhandled first SQL: ' + sql);
  }
  async run(sql, args) {
    if (sql.startsWith('INSERT OR IGNORE INTO feedback_requests')) {
      const [app, request_key, task_id, owner, feedback_date, feedback_type, template_version, body, body_hash, created_at, updated_at] = args;
      const duplicate = [...this.feedback.values()].some(row => row.app === app && row.task_id === task_id &&
        row.feedback_date === feedback_date && row.feedback_type === feedback_type && row.template_version === template_version);
      if (duplicate) return { meta: { changes: 0 } };
      this.feedback.set(request_key, { app, request_key, task_id, owner, feedback_date, feedback_type,
        template_version, body, body_hash, revision: 1, status: 'approval_waiting', created_at, updated_at,
        reviewed_at: null, reviewed_by: null, review_note: null });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("status='cancelled'")) {
      const [owner, updated_at, app, key, revision] = args;
      const row = this.feedback.get(key);
      if (!row || row.app !== app || row.revision !== revision) return { meta: { changes: 0 } };
      Object.assign(row, { owner, status: 'cancelled', revision: revision + 1, updated_at,
        reviewed_at: null, reviewed_by: null, review_note: null });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("body=?, body_hash=?, revision=revision+1")) {
      const [owner, body, body_hash, updated_at, app, key, revision] = args;
      const row = this.feedback.get(key);
      if (!row || row.app !== app || row.revision !== revision) return { meta: { changes: 0 } };
      Object.assign(row, { owner, body, body_hash, revision: revision + 1, status: 'approval_waiting', updated_at,
        reviewed_at: null, reviewed_by: null, review_note: null });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("status='content_approved_send_blocked'")) {
      const [updated_at, reviewed_at, app, key, revision] = args;
      const row = this.feedback.get(key);
      if (!row || row.app !== app || row.revision !== revision || row.status !== 'approval_waiting') return { meta: { changes: 0 } };
      Object.assign(row, { status: 'content_approved_send_blocked', updated_at, reviewed_at,
        reviewed_by: 'director', review_note: null });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("status='revision_requested'")) {
      const [updated_at, reviewed_at, review_note, app, key, revision] = args;
      const row = this.feedback.get(key);
      if (!row || row.app !== app || row.revision !== revision || row.status === 'cancelled') return { meta: { changes: 0 } };
      Object.assign(row, { status: 'revision_requested', updated_at, reviewed_at,
        reviewed_by: 'director', review_note });
      return { meta: { changes: 1 } };
    }
    throw new Error('Unhandled run SQL: ' + sql);
  }
  async all(sql, args) {
    if (!sql.includes('FROM feedback_requests')) throw new Error('Unhandled all SQL: ' + sql);
    let rows = [...this.feedback.values()].filter(row => row.app === args[0]);
    let pos = 1;
    if (sql.includes('status=?')) {
      const status = args[pos++];
      rows = rows.filter(row => row.status === status);
    }
    if (sql.includes('owner=?')) {
      const owner = args[pos++];
      rows = rows.filter(row => row.owner === owner);
    }
    if (sql.includes('feedback_date=?')) {
      const feedbackDate = args[pos++];
      rows = rows.filter(row => row.feedback_date === feedbackDate);
    }
    if (sql.includes('ORDER BY CASE status')) {
      const rank = sql.includes("WHEN 'revision_requested' THEN 0")
        ? { revision_requested: 0, approval_waiting: 1, content_approved_send_blocked: 2, cancelled: 3 }
        : { approval_waiting: 0, revision_requested: 1, content_approved_send_blocked: 2, cancelled: 3 };
      rows.sort((a, b) => (rank[a.status] ?? 4) - (rank[b.status] ?? 4) || b.updated_at - a.updated_at);
    } else {
      rows.sort((a, b) => b.updated_at - a.updated_at);
    }
    const limit = Number((sql.match(/ LIMIT (\d+)$/) || [])[1]) || rows.length;
    return { results: rows.slice(0, limit).map(row => ({ ...row })) };
  }
}

const admin = { mode: 'admin', secret: 'director-secret' };
const person = (id, token) => ({ mode: 'person', id, token });
const identity = { taskId: 'task-a', feedbackDate: '2026-08-04', feedbackType: 'class_feedback', templateVersion: 'v1' };

async function call(db, path, body) {
  const response = await worker.fetch(new Request('https://worker.example' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app: 'task', ...body })
  }), { DB: db, TASK_ADMIN_SECRET: 'director-secret', CONSULT_ADMIN_SECRET: 'consult-secret' });
  return { status: response.status, body: await response.json() };
}

test('schema and migration are additive and restrict states', () => {
  for (const sql of [schema, migration]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS feedback_requests/);
    for (const status of ['approval_waiting', 'content_approved_send_blocked', 'revision_requested', 'cancelled']) {
      assert.ok(sql.includes("'" + status + "'"));
    }
    assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM/i);
  }
});

test('worker contains no external delivery integration or recipient fields', () => {
  assert.doesNotMatch(source, /api\.solapi\.com|SOLAPI_[A-Z_]+|templateId|phoneNumber|recipientPhone/i);
  assert.doesNotMatch(source, /status\s*=\s*['"](?:sending|sent)['"]/i);
});

test('authentication and cross-owner task access are enforced', async () => {
  const db = new FakeDB();
  db.addTask('task-a', 'teacher-a');
  db.addToken('token-a', 'teacher-a');
  db.addToken('token-b', 'teacher-b');
  let result = await call(db, '/feedback-request', { ...identity, message: '오늘 수업 내용입니다.' });
  assert.equal(result.status, 401);
  result = await call(db, '/feedback-request', { auth: person('teacher-b', 'token-b'), ...identity, message: '오늘 수업 내용입니다.' });
  assert.equal(result.status, 403);
  result = await call(db, '/feedback-review', { auth: person('teacher-a', 'token-a'), action: 'list' });
  assert.equal(result.status, 403);
});

test('teacher list is own-scope and exposes review status and note', async () => {
  const db = new FakeDB();
  db.addTask('task-a', 'teacher-a');
  db.addTask('task-b', 'teacher-b');
  db.addToken('token-a', 'teacher-a');
  db.addToken('token-b', 'teacher-b');

  let own = await call(db, '/feedback-request', {
    auth: person('teacher-a', 'token-a'), ...identity, message: 'teacher a feedback'
  });
  const ownKey = own.body.request.requestKey;
  await call(db, '/feedback-review', {
    auth: admin, action: 'request_revision', requestKey: ownKey, revision: 1, note: 'Add the lesson result.'
  });
  await call(db, '/feedback-request', {
    auth: person('teacher-b', 'token-b'), taskId: 'task-b', feedbackDate: identity.feedbackDate,
    feedbackType: identity.feedbackType, templateVersion: identity.templateVersion, message: 'teacher b feedback'
  });

  own = await call(db, '/feedback-request', { auth: person('teacher-a', 'token-a'), action: 'list' });
  assert.equal(own.status, 200);
  assert.equal(own.body.requests.length, 1);
  assert.equal(own.body.requests[0].owner, 'teacher-a');
  assert.equal(own.body.requests[0].status, 'revision_requested');
  assert.equal(own.body.requests[0].reviewNote, 'Add the lesson result.');

  const adminList = await call(db, '/feedback-request', { auth: admin, action: 'list' });
  assert.equal(adminList.status, 403);
});

test('teacher list prioritizes revision and waiting requests before newer history', async () => {
  const db = new FakeDB();
  db.addToken('token-a', 'teacher-a');
  const makeRow = (key, status, updatedAt) => ({
    app: 'task', request_key: key, task_id: key, owner: 'teacher-a', feedback_date: '2026-08-04',
    feedback_type: 'class_feedback', template_version: 'v1', body: key, body_hash: key,
    revision: 1, status, created_at: updatedAt, updated_at: updatedAt,
    reviewed_at: null, reviewed_by: null, review_note: status === 'revision_requested' ? 'Revise this.' : null
  });
  db.feedback.set('fbr_approved_newest', makeRow('fbr_approved_newest', 'content_approved_send_blocked', 400));
  db.feedback.set('fbr_cancelled_newer', makeRow('fbr_cancelled_newer', 'cancelled', 300));
  db.feedback.set('fbr_waiting_old', makeRow('fbr_waiting_old', 'approval_waiting', 200));
  db.feedback.set('fbr_revision_oldest', makeRow('fbr_revision_oldest', 'revision_requested', 100));

  const result = await call(db, '/feedback-request', {
    auth: person('teacher-a', 'token-a'), action: 'list', limit: 2
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.requests.map(row => row.requestKey), ['fbr_revision_oldest', 'fbr_waiting_old']);
  assert.equal(result.body.requests[0].reviewNote, 'Revise this.');
});

test('duplicate submit is idempotent and content update invalidates approval', async () => {
  const db = new FakeDB();
  db.addTask('task-a', 'teacher-a');
  db.addToken('token-a', 'teacher-a');
  const submit = { auth: person('teacher-a', 'token-a'), ...identity, message: '오늘 수업 내용을 잘 이해했습니다.' };
  let result = await call(db, '/feedback-request', submit);
  assert.equal(result.status, 200);
  assert.equal(result.body.request.revision, 1);
  assert.equal(result.body.request.status, 'approval_waiting');
  assert.match(result.body.request.bodyHash, /^[a-f0-9]{64}$/);
  const key = result.body.request.requestKey;

  result = await call(db, '/feedback-request', submit);
  assert.equal(result.status, 200);
  assert.equal(result.body.idempotent, true);
  assert.equal(db.feedback.size, 1);
  assert.equal(result.body.request.revision, 1);

  result = await call(db, '/feedback-review', { auth: admin, action: 'approve_content', requestKey: key, revision: 1 });
  assert.equal(result.status, 200);
  assert.equal(result.body.request.status, 'content_approved_send_blocked');

  result = await call(db, '/feedback-request', { ...submit, message: '수정한 수업 피드백 문구입니다.' });
  assert.equal(result.status, 200);
  assert.equal(result.body.request.revision, 2);
  assert.equal(result.body.request.status, 'approval_waiting');
  assert.equal(result.body.request.reviewedAt, null);
  assert.equal(result.body.request.reviewNote, '');
});

test('director can list, request revision, and stale reviews are rejected', async () => {
  const db = new FakeDB();
  db.addTask('task-a', 'teacher-a');
  let result = await call(db, '/feedback-request', { auth: admin, ...identity, message: '검토가 필요한 문구입니다.' });
  const key = result.body.request.requestKey;
  result = await call(db, '/feedback-review', { auth: admin, action: 'list', status: 'approval_waiting' });
  assert.equal(result.status, 200);
  assert.equal(result.body.requests.length, 1);
  result = await call(db, '/feedback-review', { auth: admin, action: 'request_revision', requestKey: key, revision: 1, note: '학습 내용을 더 구체적으로 적어 주세요.' });
  assert.equal(result.status, 200);
  assert.equal(result.body.request.status, 'revision_requested');
  result = await call(db, '/feedback-review', { auth: admin, action: 'approve_content', requestKey: key, revision: 2 });
  assert.equal(result.status, 409);
});

test('unchanged revision request is rejected and changed content returns to approval waiting', async () => {
  const db = new FakeDB();
  db.addTask('task-a', 'teacher-a');
  db.addToken('token-a', 'teacher-a');
  const auth = person('teacher-a', 'token-a');
  const original = { auth, ...identity, message: 'Original feedback.' };

  let result = await call(db, '/feedback-request', original);
  const key = result.body.request.requestKey;
  result = await call(db, '/feedback-review', {
    auth: admin, action: 'request_revision', requestKey: key, revision: 1, note: 'Make the result specific.'
  });
  assert.equal(result.body.request.status, 'revision_requested');

  result = await call(db, '/feedback-request', original);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'REVISION_UNCHANGED');
  assert.equal(result.body.request.status, 'revision_requested');
  assert.equal(result.body.request.reviewNote, 'Make the result specific.');
  assert.equal(result.body.request.revision, 1);

  result = await call(db, '/feedback-request', { ...original, message: 'Revised feedback with a specific result.' });
  assert.equal(result.status, 200);
  assert.equal(result.body.request.status, 'approval_waiting');
  assert.equal(result.body.request.revision, 2);
  assert.equal(result.body.request.reviewNote, '');
});

test('admin list prioritizes pending work before newer history within the limit', async () => {
  const db = new FakeDB();
  const makeRow = (key, status, updatedAt) => ({
    app: 'task', request_key: key, task_id: key, owner: 'teacher-a', feedback_date: '2026-08-04',
    feedback_type: 'class_feedback', template_version: 'v1', body: key, body_hash: key,
    revision: 1, status, created_at: updatedAt, updated_at: updatedAt,
    reviewed_at: null, reviewed_by: null, review_note: null
  });
  db.feedback.set('fbr_history_newest', makeRow('fbr_history_newest', 'content_approved_send_blocked', 300));
  db.feedback.set('fbr_cancelled_newer', makeRow('fbr_cancelled_newer', 'cancelled', 200));
  db.feedback.set('fbr_pending_oldest', makeRow('fbr_pending_oldest', 'approval_waiting', 100));

  const result = await call(db, '/feedback-review', { auth: admin, action: 'list', limit: 2 });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.requests.map(row => row.requestKey), ['fbr_pending_oldest', 'fbr_history_newest']);
});

test('cancel is idempotent and increments revision once', async () => {
  const db = new FakeDB();
  db.addTask('task-a', 'teacher-a');
  db.addToken('token-a', 'teacher-a');
  const base = { auth: person('teacher-a', 'token-a'), ...identity };
  let result = await call(db, '/feedback-request', { ...base, message: '취소할 문구입니다.' });
  assert.equal(result.body.request.revision, 1);
  result = await call(db, '/feedback-request', { ...base, action: 'cancel' });
  assert.equal(result.body.request.status, 'cancelled');
  assert.equal(result.body.request.revision, 2);
  result = await call(db, '/feedback-request', { ...base, action: 'cancel' });
  assert.equal(result.body.idempotent, true);
  assert.equal(result.body.request.revision, 2);
});
