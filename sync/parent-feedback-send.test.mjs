import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

import worker from './worker-core.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/016_parent_feedback_send.sql', import.meta.url), 'utf8');

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
  WB_PARENT_FEEDBACK_SEND_ENABLED: 'true',
  SOLAPI_API_KEY: 'test-key',
  SOLAPI_API_SECRET: 'test-secret',
  SOLAPI_SENDER_NUMBER: '0212345678'
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
  const response = await worker.fetch(new Request('https://worker.example/parent-feedback-send', {
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

/** 승인 완료 상태('content_approved_send_blocked')의 피드백 요청 하나와, 그게 가리키는 지시서를 심는다 */
function seedApprovedFeedback(db, overrides = {}) {
  ensureKimStaff(db);
  const now = Date.now();
  const task = { id: 'task-1', staffId: 'S-kim', title: '[정규] 진호윤(중2) — 국어 독해', studentName: '진호윤', deleted: false };
  db.prepare('INSERT INTO tasks (app,id,owner,data,updated_at,srv_at) VALUES (?,?,?,?,?,?)')
    .bind('task', task.id, task.staffId, JSON.stringify(task), now, now).run();

  const body = overrides.body || '오늘 진호윤 학생 수업 잘 마쳤습니다. 집중을 잘 했어요.';
  const requestKey = overrides.requestKey || 'fbr_test0000000000000000000000000000000000000000';
  db.prepare(
    'INSERT INTO feedback_requests (app,request_key,task_id,owner,feedback_date,feedback_type,template_version,' +
    'body,body_hash,revision,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?)'
  ).bind('task', requestKey, task.id, 'S-kim', '2026-08-09', 'class_feedback', 'v1',
    body, 'x'.repeat(64), overrides.status || 'content_approved_send_blocked', now, now).run();
  return { requestKey, taskId: task.id, studentName: '진호윤' };
}

function registerGuardian(db, studentName, { phone = '01012345678', consent = 1 } = {}) {
  const now = Date.now();
  db.prepare('INSERT INTO guardian_contacts (app,student_name,phone,consent,updated_at,updated_by) VALUES (?,?,?,?,?,?)')
    .bind('task', studentName, phone, consent, now, 'director').run();
}

test('schema and migration are additive, and the send ledger itself stores no phone or message body', () => {
  for (const sql of [schema, migration]) {
    const match = sql.match(/CREATE TABLE IF NOT EXISTS parent_feedback_sends\s*\([\s\S]*?\);/);
    assert.ok(match, 'parent_feedback_sends 테이블 정의를 찾을 수 없습니다');
    assert.doesNotMatch(match[0], /phone|message_body/i, '발송 이력 테이블에는 전화번호나 문자 본문을 남기지 않는다(해시만)');
  }
});

test('client cannot specify phone, recipient, message, or studentName — request rejected before any fetch', async () => {
  const db = new TestD1();
  const { requestKey } = seedApprovedFeedback(db);
  registerGuardian(db, '진호윤');
  let fetches = 0;
  await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
    for (const bad of [{ phone: '01000000000' }, { message: 'hi' }, { to: '010' }, { studentName: 'x' }]) {
      const r = await call(db, { auth: admin, requestKey, ...bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
  });
  assert.equal(fetches, 0);
});

test('send is disabled by default even with valid credentials unless the explicit switch is on', async () => {
  const db = new TestD1();
  const { requestKey } = seedApprovedFeedback(db);
  registerGuardian(db, '진호윤');
  let fetches = 0;
  await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
    const r = await call(db, { auth: admin, requestKey }, { WB_PARENT_FEEDBACK_SEND_ENABLED: 'false' });
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'SEND_DISABLED');
  });
  assert.equal(fetches, 0);
});

test('only the director can trigger a real send, not the submitting teacher', async () => {
  const db = new TestD1();
  const { requestKey } = seedApprovedFeedback(db);
  registerGuardian(db, '진호윤');
  const r = await call(db, { auth: person('S-kim', 'tok-kim'), requestKey });
  assert.equal(r.status, 403);
});

test('content must be approved first — approval_waiting cannot be sent', async () => {
  const db = new TestD1();
  const { requestKey } = seedApprovedFeedback(db, { status: 'approval_waiting' });
  registerGuardian(db, '진호윤');
  const r = await call(db, { auth: admin, requestKey });
  assert.equal(r.status, 409);
});

test('no guardian contact registered at all is blocked before any fetch', async () => {
  const db = new TestD1();
  const { requestKey } = seedApprovedFeedback(db);
  let fetches = 0;
  await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
    const r = await call(db, { auth: admin, requestKey });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'GUARDIAN_NOT_REGISTERED');
  });
  assert.equal(fetches, 0);
});

test('phone registered but consent off is blocked before any fetch', async () => {
  const db = new TestD1();
  const { requestKey } = seedApprovedFeedback(db);
  registerGuardian(db, '진호윤', { consent: 0 });
  let fetches = 0;
  await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
    const r = await call(db, { auth: admin, requestKey });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'GUARDIAN_CONSENT_MISSING');
  });
  assert.equal(fetches, 0);
});

test('happy path: approved content + phone + consent → sends, and marks feedback_requests as sent', async () => {
  const db = new TestD1();
  const { requestKey } = seedApprovedFeedback(db);
  registerGuardian(db, '진호윤');
  let sentTo = null;
  await withFetch(async (url, init) => {
    sentTo = JSON.parse(init.body).messages[0];
    return acceptedResponse();
  }, async () => {
    const r = await call(db, { auth: admin, requestKey });
    assert.equal(r.status, 200);
    assert.equal(r.body.send.status, 'accepted');
  });
  assert.equal(sentTo.to, '01012345678');
  assert.match(sentTo.text, /진호윤/);

  const row = db.prepare("SELECT status FROM feedback_requests WHERE request_key=?").bind(requestKey).first();
  assert.equal(row.status, 'sent', '발송 성공 후 feedback_requests 상태가 sent로 바뀐다');
});

test('resending the same approved content is idempotent — no second fetch', async () => {
  const db = new TestD1();
  const { requestKey } = seedApprovedFeedback(db);
  registerGuardian(db, '진호윤');
  let fetches = 0;
  await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
    await call(db, { auth: admin, requestKey });
  });
  assert.equal(fetches, 1);

  // 이미 'sent'로 바뀌었으니 다시 호출하면 ALREADY_SENT로 바로 응답하고 fetch는 없어야 한다
  await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
    const again = await call(db, { auth: admin, requestKey });
    assert.equal(again.status, 200);
    assert.equal(again.body.idempotent, true);
    assert.equal(again.body.code, 'ALREADY_SENT');
  });
  assert.equal(fetches, 1, '이미 보낸 건은 다시 발송하지 않는다');
});

test('rejected provider response keeps feedback_requests blocked, not marked sent', async () => {
  const db = new TestD1();
  const { requestKey } = seedApprovedFeedback(db);
  registerGuardian(db, '진호윤');
  await withFetch(async () => new Response(JSON.stringify({
    groupInfo: { groupId: 'G1' }, messageList: [{ messageId: 'M1', statusCode: '9999' }]
  }), { status: 200, headers: { 'content-type': 'application/json' } }), async () => {
    const r = await call(db, { auth: admin, requestKey });
    assert.equal(r.body.send.status, 'rejected');
  });
  const row = db.prepare("SELECT status FROM feedback_requests WHERE request_key=?").bind(requestKey).first();
  assert.equal(row.status, 'content_approved_send_blocked', '거절된 발송은 문구 상태를 sent로 바꾸지 않는다');
});

test('consult app cannot use this feature', async () => {
  const db = new TestD1();
  const response = await worker.fetch(new Request('https://worker.example/parent-feedback-send', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app: 'consult', auth: { mode: 'admin', secret: 'consult-secret' }, requestKey: 'fbr_x' })
  }), { DB: db, ...fullEnvBase });
  assert.equal(response.status, 400);
});
