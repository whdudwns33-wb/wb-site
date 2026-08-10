import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

import worker from './worker-core.js';

const source = fs.readFileSync(new URL('./worker-core.js', import.meta.url), 'utf8');
const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/010_feedback_requests.sql', import.meta.url), 'utf8');
const migration017 = fs.readFileSync(new URL('./migrations/017_feedback_structured_fields.sql', import.meta.url), 'utf8');

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
const identity = { taskId: 'task-a', feedbackDate: '2026-08-04', feedbackType: 'class_feedback', templateVersion: 'v1' };

// 자동 발송이 시도는 되지만(제출 즉시), Solapi 설정이 없는 기본 env라 항상 SEND_DISABLED로
// 조용히 막힌다 — 이 파일은 "제출" 흐름 자체(검증·소유권·멱등성)만 검증하고,
// 실제 발송 로직은 parent-feedback-send.test.mjs가 전담한다.
function seedStaff(db, id, name) {
  const now = Date.now();
  db.prepare('INSERT INTO staff (app,id,owner,data,updated_at,srv_at) VALUES (?,?,?,?,?,?)')
    .bind('task', id, id, JSON.stringify({ id, name, deleted: false }), now, now).run();
}
function seedToken(db, token, staffId) {
  db.prepare("INSERT INTO tokens (app,token,staff_id,created_at,revoked) VALUES ('task',?,?,?,0)")
    .bind(token, staffId, Date.now()).run();
}
function seedTask(db, id, owner, overrides = {}) {
  const now = Date.now();
  const data = { id, staffId: owner, title: '[정규] 테스트학생(중2) — 국어 독해', studentName: '테스트학생', deleted: false, ...overrides };
  db.prepare('INSERT INTO tasks (app,id,owner,data,updated_at,srv_at) VALUES (?,?,?,?,?,?)')
    .bind('task', id, owner, JSON.stringify(data), now, now).run();
}

const fields = (overrides = {}) => ({
  contentText: '독해 지문 3개 풀이', plusText: '오답을 스스로 설명함', minusText: '어휘', ...overrides
});

async function call(db, path, body) {
  const response = await worker.fetch(new Request('https://worker.example' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app: 'task', ...body })
  }), { DB: db, TASK_ADMIN_SECRET: 'director-secret', CONSULT_ADMIN_SECRET: 'consult-secret' });
  return { status: response.status, body: await response.json() };
}

test('schema and migrations are additive and restrict states', () => {
  for (const sql of [schema, migration]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS feedback_requests/);
    for (const status of ['approval_waiting', 'content_approved_send_blocked', 'revision_requested', 'cancelled']) {
      assert.ok(sql.includes("'" + status + "'"));
    }
    assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM/i);
  }
  assert.doesNotMatch(migration017, /DROP TABLE|DELETE FROM/i);
});

test('feedback submission delegates all real sending to the dedicated send module', () => {
  const start = source.indexOf('학부모 피드백 — 항목 제출 + 실제 발송');
  const end = source.indexOf('인강 커리큘럼 자동 가져오기');
  const feedbackSource = source.slice(start, end);
  // Solapi 호출·전화번호·템플릿ID를 이 구간에 직접 두지 않는다 — 전부 parent-feedback-send.js로 위임한다.
  assert.doesNotMatch(feedbackSource, /api\.solapi\.com|SOLAPI_[A-Z_]+|phoneNumber|recipientPhone/i);
  assert.doesNotMatch(source, /https:\/\/api\.solapi\.com/);
  assert.match(source, /from '.\/parent-feedback-send\.js'/);
  assert.match(feedbackSource, /attemptParentFeedbackSend/);
});

test('authentication and cross-owner task access are enforced', async () => {
  const db = new TestD1();
  seedStaff(db, 'teacher-a', '김남기'); seedToken(db, 'token-a', 'teacher-a');
  seedStaff(db, 'teacher-b', '박선생'); seedToken(db, 'token-b', 'teacher-b');
  seedTask(db, 'task-a', 'teacher-a');
  let result = await call(db, '/feedback-request', { ...identity, message: '오늘 수업 내용입니다.', ...fields() });
  assert.equal(result.status, 401);
  result = await call(db, '/feedback-request', { auth: person('teacher-b', 'token-b'), ...identity, message: '오늘 수업 내용입니다.', ...fields() });
  assert.equal(result.status, 403);
  result = await call(db, '/feedback-review', { auth: person('teacher-a', 'token-a'), action: 'list' });
  assert.equal(result.status, 403);
});

test('submitting without content/plus/minus text is rejected', async () => {
  const db = new TestD1();
  seedStaff(db, 'teacher-a', '김남기'); seedToken(db, 'token-a', 'teacher-a');
  seedTask(db, 'task-a', 'teacher-a');
  const auth = person('teacher-a', 'token-a');
  for (const missing of ['contentText', 'plusText', 'minusText']) {
    const body = { auth, ...identity, message: 'm', ...fields({ [missing]: '' }) };
    const result = await call(db, '/feedback-request', body);
    assert.equal(result.status, 400, missing);
  }
});

test('submission resolves teacher name from the staff table, not from client input', async () => {
  const db = new TestD1();
  seedStaff(db, 'teacher-a', '김남기'); seedToken(db, 'token-a', 'teacher-a');
  seedTask(db, 'task-a', 'teacher-a');
  const result = await call(db, '/feedback-request', {
    auth: person('teacher-a', 'token-a'), ...identity, message: '오늘 수업 내용입니다.',
    teacherName: '가짜이름', ...fields()
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.request.teacherName, '김남기', '클라이언트가 보낸 teacherName은 무시되고 서버가 staff 테이블에서 찾은 이름을 쓴다');
  assert.equal(result.body.request.studentName, '테스트학생', '지시서 제목/필드에서 학생 이름을 뽑는다');
});

test('duplicate submit is idempotent and content update invalidates approval', async () => {
  const db = new TestD1();
  seedStaff(db, 'teacher-a', '김남기'); seedToken(db, 'token-a', 'teacher-a');
  seedTask(db, 'task-a', 'teacher-a');
  const submit = { auth: person('teacher-a', 'token-a'), ...identity, message: '오늘 수업 내용을 잘 이해했습니다.', ...fields() };
  let result = await call(db, '/feedback-request', submit);
  assert.equal(result.status, 200);
  assert.equal(result.body.request.revision, 1);
  assert.match(result.body.request.bodyHash, /^[a-f0-9]{64}$/);
  const key = result.body.request.requestKey;

  result = await call(db, '/feedback-request', submit);
  assert.equal(result.status, 200);
  assert.equal(result.body.idempotent, true);
  assert.equal(result.body.request.revision, 1);

  result = await call(db, '/feedback-request', { ...submit, message: '수정한 수업 피드백 문구입니다.' });
  assert.equal(result.status, 200);
  assert.equal(result.body.request.revision, 2);
  assert.equal(result.body.request.reviewedAt, null);
  assert.equal(result.body.request.reviewNote === '' || typeof result.body.request.reviewNote === 'string', true);

  // Solapi가 설정되지 않은 기본 env이므로 발송은 항상 막히고, 문구 상태는 sent가 아니어야 한다
  assert.notEqual(result.body.request.status, 'sent');
});

test('director can list, request revision, and stale reviews are rejected', async () => {
  const db = new TestD1();
  seedStaff(db, 'teacher-a', '김남기');
  seedTask(db, 'task-a', 'teacher-a');
  let result = await call(db, '/feedback-request', { auth: admin, ...identity, message: '검토가 필요한 문구입니다.', ...fields() });
  const key = result.body.request.requestKey;
  result = await call(db, '/feedback-review', { auth: admin, action: 'list' });
  assert.equal(result.status, 200);
  assert.equal(result.body.requests.length, 1);
  result = await call(db, '/feedback-review', {
    auth: admin, action: 'request_revision', requestKey: key, revision: 1, note: '학습 내용을 더 구체적으로 적어 주세요.'
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.request.status, 'revision_requested');
  result = await call(db, '/feedback-review', { auth: admin, action: 'approve_content', requestKey: key, revision: 2 });
  assert.equal(result.status, 409);
});

test('resubmitting unchanged content while revision_requested is rejected; changed content clears the note', async () => {
  const db = new TestD1();
  seedStaff(db, 'teacher-a', '김남기'); seedToken(db, 'token-a', 'teacher-a');
  seedTask(db, 'task-a', 'teacher-a');
  const auth = person('teacher-a', 'token-a');
  const original = { auth, ...identity, message: 'Original feedback.', ...fields() };

  let result = await call(db, '/feedback-request', original);
  const key = result.body.request.requestKey;
  result = await call(db, '/feedback-review', {
    auth: admin, action: 'request_revision', requestKey: key, revision: 1, note: 'Make the result specific.'
  });
  assert.equal(result.body.request.status, 'revision_requested');

  result = await call(db, '/feedback-request', original);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'REVISION_UNCHANGED');
  assert.equal(result.body.request.reviewNote, 'Make the result specific.');
  assert.equal(result.body.request.revision, 1);

  result = await call(db, '/feedback-request', { ...original, message: 'Revised feedback with a specific result.' });
  assert.equal(result.status, 200);
  assert.equal(result.body.request.revision, 2);
  // 제출 즉시 발송을 다시 시도하므로(기본 env는 Solapi 미설정), 예전 수정요청 사유 대신
  // "왜 아직 안 나갔는지"로 review_note가 바뀐다 — 빈 문자열로 남지 않는다.
  assert.notEqual(result.body.request.reviewNote, 'Make the result specific.');
  assert.notEqual(result.body.request.status, 'sent');
});

test('cancel is idempotent and increments revision once', async () => {
  const db = new TestD1();
  seedStaff(db, 'teacher-a', '김남기'); seedToken(db, 'token-a', 'teacher-a');
  seedTask(db, 'task-a', 'teacher-a');
  const base = { auth: person('teacher-a', 'token-a'), ...identity };
  let result = await call(db, '/feedback-request', { ...base, message: '취소할 문구입니다.', ...fields() });
  assert.equal(result.body.request.revision, 1);
  result = await call(db, '/feedback-request', { ...base, action: 'cancel' });
  assert.equal(result.body.request.status, 'cancelled');
  assert.equal(result.body.request.revision, 2);
  result = await call(db, '/feedback-request', { ...base, action: 'cancel' });
  assert.equal(result.body.idempotent, true);
  assert.equal(result.body.request.revision, 2);
});

test('teacher list is own-scope and exposes review status and note', async () => {
  const db = new TestD1();
  seedStaff(db, 'teacher-a', '김남기'); seedToken(db, 'token-a', 'teacher-a');
  seedStaff(db, 'teacher-b', '박선생'); seedToken(db, 'token-b', 'teacher-b');
  seedTask(db, 'task-a', 'teacher-a');
  seedTask(db, 'task-b', 'teacher-b');

  let own = await call(db, '/feedback-request', { auth: person('teacher-a', 'token-a'), ...identity, message: 'teacher a feedback', ...fields() });
  const ownKey = own.body.request.requestKey;
  await call(db, '/feedback-review', { auth: admin, action: 'request_revision', requestKey: ownKey, revision: 1, note: 'Add the lesson result.' });
  await call(db, '/feedback-request', {
    auth: person('teacher-b', 'token-b'), taskId: 'task-b', feedbackDate: identity.feedbackDate,
    feedbackType: identity.feedbackType, templateVersion: identity.templateVersion, message: 'teacher b feedback', ...fields()
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

test('a task without a resolvable student name in the title cannot be submitted', async () => {
  const db = new TestD1();
  seedStaff(db, 'teacher-a', '김남기'); seedToken(db, 'token-a', 'teacher-a');
  seedTask(db, 'task-a', 'teacher-a', { title: '[정규]', studentName: '' });
  const result = await call(db, '/feedback-request', {
    auth: person('teacher-a', 'token-a'), ...identity, message: '오늘 수업 내용입니다.', ...fields()
  });
  assert.equal(result.status, 409);
});
