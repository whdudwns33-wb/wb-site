import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  CONSULT_LINK_TEMPLATE_BUTTON_URL,
  handleConsultLinkSend
} from './consult-link-send.js';
import worker from './worker-core.js';

const migration = fs.readFileSync(new URL('./migrations/053_consult_link_send.sql', import.meta.url), 'utf8');
const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const moduleSource = fs.readFileSync(new URL('./consult-link-send.js', import.meta.url), 'utf8');
const workerSource = fs.readFileSync(new URL('./worker-core.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('./wrangler.toml', import.meta.url), 'utf8');

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
  constructor() {
    this.database = new DatabaseSync(':memory:');
    this.database.exec(`
      CREATE TABLE staff (
        app TEXT NOT NULL, id TEXT NOT NULL, owner TEXT, data TEXT NOT NULL,
        updated_at INTEGER NOT NULL, srv_at INTEGER NOT NULL, PRIMARY KEY(app,id)
      );
      CREATE TABLE bootstrap_codes (
        app TEXT NOT NULL, code_hash TEXT NOT NULL, staff_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER,
        revoked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(app,code_hash)
      );
    `);
    this.database.exec(migration);
  }
  prepare(sql) { return new Statement(this.database, sql); }
  batch(statements) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => statement.run());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

const authBody = { mode: 'admin', secret: 'test-secret' };
const resolvedAdmin = { scope: 'all', role: 'admin' };
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' }
});

function env(db, overrides = {}) {
  return {
    DB: db,
    CONSULT_ADMIN_SECRET: 'test-secret',
    WB_CONSULT_LINK_SEND_ENABLED: 'true',
    SOLAPI_KAKAO_API_KEY: 'api-key',
    SOLAPI_KAKAO_API_SECRET: 'api-secret',
    SOLAPI_KAKAO_PF_ID: 'pf-id',
    SOLAPI_KAKAO_CONSULT_LINK_APPROVED_TEMPLATE_ID: 'template-id',
    SOLAPI_SENDER_NUMBER: '0212345678',
    ...overrides
  };
}

function seedStudent(db, id, name, extra = {}) {
  const now = Date.now() - 1000;
  db.prepare('INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('consult', id, id, JSON.stringify({ id, name, deleted: false, ...extra }), now, now).run();
}

async function call(db, body, options = {}) {
  const response = await handleConsultLinkSend(
    env(db, options.env), options.app || 'consult',
    { app: options.app || 'consult', auth: authBody, ...body }, '*',
    options.auth || resolvedAdmin, json,
    options.issue || (async () => ({ code: 'a'.repeat(48), expiresAt: Date.now() + 86400000 })),
    options.revoke || (async () => true)
  );
  return { status: response.status, body: await response.json() };
}

async function register(db, staffId = 'student-a', phone = '010-1234-5678') {
  const result = await call(db, {
    action: 'set', staffId, phone, consent: true, expectedUpdatedAt: 0
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.contact;
}

function acceptedResponse() {
  return new Response(JSON.stringify({
    groupInfo: { groupId: 'group-1' },
    messageList: [{ messageId: 'message-1', statusCode: '2000' }],
    failedMessageList: []
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('migration is additive, consult-only, privacy separated, and routed with the existing bootstrap issuer', () => {
  for (const sql of [migration, schema]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS consult_link_contacts/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS consult_link_sends/);
    assert.match(sql, /CHECK \(app = 'consult'\)/);
    assert.match(sql, /WHERE status IN \('dispatching','accepted','unknown'\)/);
    assert.match(sql, /CONSULT_LINK_SEND_APPEND_ONLY/);
    assert.match(sql, /trg_consult_link_contacts_clear_inactive/);
    const consultLinkLedger = sql.slice(sql.lastIndexOf(
      'CREATE TABLE IF NOT EXISTS consult_link_sends'
    ));
    assert.doesNotMatch(consultLinkLedger, /student_identity_hash/);
  }
  assert.doesNotMatch(migration, /DROP\s+TABLE|DELETE\s+FROM/i);
  assert.match(workerSource, /handleConsultLinkSend/);
  assert.match(workerSource, /issueBootstrap\(env, 'consult', staffId, BOOTSTRAP_TTL_MS\)/);
  assert.match(workerSource,
    /WHERE app=\? AND staff_id=\? AND code_hash=\? AND revoked=0 AND consumed_at IS NULL/);
  assert.match(wrangler, /SOLAPI_KAKAO_CONSULT_LINK_APPROVED_TEMPLATE_ID/);
  assert.match(wrangler, /WB_CONSULT_LINK_SEND_ENABLED/);
  assert.equal(CONSULT_LINK_TEMPLATE_BUTTON_URL,
    'https://whdudwns33-wb.github.io/wb-site/consult/?u=#{학생ID}#c=#{연결코드}');
  assert.match(moduleSource, /SOLAPI_TIMEOUT_MS = 8000/);
  assert.doesNotMatch(moduleSource, /student_identity_hash|identityHash/);
  assert.doesNotMatch(migration, /\bphone\b[\s\S]{0,40}consult_link_sends/i);
});

test('consult staff becoming deleted, owner, or manager clears phone and consent but retains audit row', async () => {
  for (const flag of ['deleted', 'owner', 'manager']) {
    const db = new TestD1();
    seedStudent(db, 'student-a', '김학생');
    const contact = await register(db);
    const staff = db.prepare("SELECT * FROM staff WHERE app='consult' AND id='student-a'").first();
    const stamp = Math.max(Date.now(), Number(contact.updatedAt) + 1);
    db.prepare("UPDATE staff SET data=?,updated_at=?,srv_at=? WHERE app='consult' AND id='student-a'")
      .bind(JSON.stringify({ id: 'student-a', name: '김학생', deleted: false, [flag]: true }),
        stamp, stamp).run();
    const cleared = db.prepare(
      "SELECT phone,consent,updated_at,updated_by FROM consult_link_contacts " +
      "WHERE app='consult' AND staff_id='student-a'"
    ).first();
    assert.ok(cleared, flag);
    assert.equal(cleared.phone, null, flag);
    assert.equal(cleared.consent, 0, flag);
    assert.equal(cleared.updated_by, 'system', flag);
    assert.ok(Number(cleared.updated_at) > Number(contact.updatedAt), flag);
    assert.ok(staff);
  }
});

test('list/set mask D1-only phones, exclude owner/manager/deleted, and enforce CAS', async () => {
  const db = new TestD1();
  seedStudent(db, 'student-a', '김학생');
  seedStudent(db, 'owner-a', '원장', { owner: true });
  seedStudent(db, 'manager-a', '관리자', { manager: true });
  seedStudent(db, 'deleted-a', '삭제', { deleted: true });

  const saved = await register(db);
  assert.equal(saved.phoneMasked, '010****5678');
  assert.equal(saved.phoneRegistered, true);
  assert.equal(JSON.stringify(saved).includes('01012345678'), false);
  const stored = db.prepare("SELECT * FROM consult_link_contacts WHERE staff_id='student-a'").first();
  assert.equal(stored.phone, '01012345678');

  let result = await call(db, { action: 'list' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.contacts.map(item => item.staffId), ['student-a']);
  assert.equal(JSON.stringify(result.body).includes('01012345678'), false);

  result = await call(db, {
    action: 'set', staffId: 'student-a', phone: '01099998888', consent: true,
    expectedUpdatedAt: 0
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'CONTACT_CONFLICT');
  assert.equal(JSON.stringify(result.body).includes('01012345678'), false);

  result = await call(db, {
    action: 'set', staffId: 'student-a', phone: '', consent: false,
    expectedUpdatedAt: saved.updatedAt
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.contact.phoneRegistered, false);
  assert.equal(result.body.contact.consent, false);
  assert.equal(db.prepare("SELECT phone FROM consult_link_contacts WHERE staff_id='student-a'").first().phone, null);
});

test('send creates one ATA dispatch with exact server variables and returns no phone, URL, or code', async t => {
  const db = new TestD1();
  seedStudent(db, 'student-a', '김학생');
  await register(db);
  const originalFetch = globalThis.fetch;
  let requestPayload;
  let fetches = 0;
  let issues = 0;
  let revokes = 0;
  globalThis.fetch = async (url, options) => {
    fetches += 1;
    assert.equal(url, 'https://api.solapi.com/messages/v4/send-many/detail');
    assert.match(options.headers.Authorization, /^HMAC-SHA256 /);
    requestPayload = JSON.parse(options.body);
    return acceptedResponse();
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const issue = async staffId => {
    issues += 1;
    assert.equal(staffId, 'student-a');
    return { code: 'b'.repeat(48), expiresAt: Date.now() + 86400000 };
  };
  const revoke = async () => { revokes += 1; return true; };
  let result = await call(db, { action: 'send', staffId: 'student-a' }, { issue, revoke });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.status, 'accepted');
  assert.equal(result.body.statusLabel, '접수됨');
  assert.match(result.body.notice, /단말 도착·열람 완료가 아닙니다/);
  assert.equal(fetches, 1);
  assert.equal(issues, 1);
  assert.equal(revokes, 0);

  assert.equal(requestPayload.messages.length, 1);
  const message = requestPayload.messages[0];
  assert.equal(message.type, 'ATA');
  assert.equal(message.to, '01012345678');
  assert.equal(message.text, undefined);
  assert.equal(message.kakaoOptions.disableSms, true);
  assert.deepEqual(Object.keys(message.kakaoOptions.variables).sort(),
    ['#{연결코드}', '#{학생ID}', '#{학생명}'].sort());
  assert.equal(message.kakaoOptions.variables['#{학생명}'], '김학생');
  assert.equal(message.kakaoOptions.variables['#{학생ID}'], 'student-a');
  assert.equal(message.kakaoOptions.variables['#{연결코드}'], 'b'.repeat(48));
  assert.equal(requestPayload.strict, true);
  assert.equal(requestPayload.allowDuplicates, false);

  const apiText = JSON.stringify(result.body);
  assert.equal(apiText.includes('01012345678'), false);
  assert.equal(apiText.includes('b'.repeat(48)), false);
  assert.equal(apiText.includes('https://'), false);
  const ledger = db.prepare("SELECT * FROM consult_link_sends WHERE staff_id='student-a'").first();
  const ledgerText = JSON.stringify(ledger);
  assert.equal(ledger.status, 'accepted');
  assert.equal(ledgerText.includes('01012345678'), false);
  assert.equal(ledgerText.includes('b'.repeat(48)), false);
  assert.equal(ledgerText.includes('https://'), false);

  result = await call(db, { action: 'send', staffId: 'student-a' }, { issue, revoke });
  assert.equal(result.status, 200);
  assert.equal(result.body.idempotent, true);
  assert.equal(fetches, 1);
  assert.equal(issues, 1);
  assert.equal(revokes, 0);
});

test('confirmed 4xx is rejected and retryable; network uncertainty blocks another daily send', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const rejectedDb = new TestD1();
  seedStudent(rejectedDb, 'student-a', '김학생');
  await register(rejectedDb);
  let calls = 0;
  const revoked = [];
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response('not-json', { status: 400 })
      : acceptedResponse();
  };
  const revoke = async (staffId, code) => { revoked.push({ staffId, code }); return true; };
  let result = await call(rejectedDb, { action: 'send', staffId: 'student-a' }, { revoke });
  assert.equal(result.status, 502);
  assert.equal(result.body.status, 'rejected');
  assert.deepEqual(revoked, [{ staffId: 'student-a', code: 'a'.repeat(48) }]);
  result = await call(rejectedDb, { action: 'send', staffId: 'student-a' }, { revoke });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(calls, 2);
  assert.equal(revoked.length, 1);
  const attempts = rejectedDb.prepare(
    "SELECT attempt_no,status FROM consult_link_sends ORDER BY attempt_no"
  ).all().results;
  assert.deepEqual(attempts.map(row => [row.attempt_no, row.status]),
    [[1, 'rejected'], [2, 'accepted']]);

  const unknownDb = new TestD1();
  seedStudent(unknownDb, 'student-b', '이학생');
  await register(unknownDb, 'student-b', '01022223333');
  let unknownCalls = 0;
  let unknownRevokes = 0;
  globalThis.fetch = async () => { unknownCalls += 1; throw new TypeError('network detail'); };
  result = await call(unknownDb, { action: 'send', staffId: 'student-b' }, {
    revoke: async () => { unknownRevokes += 1; return true; }
  });
  assert.equal(result.status, 202);
  assert.equal(result.body.status, 'unknown');
  assert.equal(JSON.stringify(result.body).includes('network detail'), false);
  result = await call(unknownDb, { action: 'send', staffId: 'student-b' }, {
    revoke: async () => { unknownRevokes += 1; return true; }
  });
  assert.equal(result.status, 202);
  assert.equal(result.body.idempotent, true);
  assert.equal(unknownCalls, 1);
  assert.equal(unknownRevokes, 0);
});

test('source change after issue revokes only that code before provider dispatch', async t => {
  const db = new TestD1();
  seedStudent(db, 'student-a', '김학생');
  await register(db);
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches += 1; return acceptedResponse(); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const code = 'd'.repeat(48);
  const revoked = [];
  const issue = async () => {
    const stamp = Date.now() + 10;
    db.prepare("UPDATE staff SET data=?,updated_at=?,srv_at=? WHERE app='consult' AND id='student-a'")
      .bind(JSON.stringify({ id: 'student-a', name: '변경학생', deleted: false }), stamp, stamp).run();
    return { code, expiresAt: stamp + 86400000 };
  };
  const result = await call(db, { action: 'send', staffId: 'student-a' }, {
    issue,
    revoke: async (staffId, issuedCode) => { revoked.push({ staffId, issuedCode }); return true; }
  });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.code, 'SOURCE_CHANGED');
  assert.deepEqual(revoked, [{ staffId: 'student-a', issuedCode: code }]);
  assert.equal(fetches, 0);
  assert.equal(JSON.stringify(result.body).includes(code), false);
  const ledger = db.prepare("SELECT status,safe_error_code FROM consult_link_sends").first();
  assert.equal(ledger.status, 'rejected');
  assert.equal(ledger.safe_error_code, 'SOURCE_CHANGED');
});

test('worker route hashes and revokes the exact newly issued unused bootstrap after confirmed rejection', async t => {
  const db = new TestD1();
  seedStudent(db, 'student-a', '김학생');
  await register(db);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 400 });
  t.after(() => { globalThis.fetch = originalFetch; });

  const response = await worker.fetch(new Request('https://worker.example/consult-link-send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      app: 'consult', auth: { mode: 'admin', secret: 'test-secret' },
      action: 'send', staffId: 'student-a'
    })
  }), env(db));
  const body = await response.json();
  assert.equal(response.status, 502, JSON.stringify(body));
  assert.equal(body.status, 'rejected');
  const bootstrap = db.prepare(
    "SELECT code_hash,staff_id,consumed_at,revoked FROM bootstrap_codes WHERE app='consult'"
  ).first();
  assert.ok(bootstrap);
  assert.match(bootstrap.code_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(bootstrap.staff_id, 'student-a');
  assert.equal(bootstrap.consumed_at, null);
  assert.equal(bootstrap.revoked, 1);
  assert.equal(JSON.stringify(body).includes(bootstrap.code_hash.slice(7)), false);
});

test('revoke failure converts a confirmed rejection to unknown and blocks automatic retry', async t => {
  const db = new TestD1();
  seedStudent(db, 'student-a', '김학생');
  await register(db);
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  let revokes = 0;
  globalThis.fetch = async () => { fetches += 1; return new Response('{}', { status: 400 }); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const options = { revoke: async () => { revokes += 1; return false; } };
  let result = await call(db, { action: 'send', staffId: 'student-a' }, options);
  assert.equal(result.status, 202);
  assert.equal(result.body.status, 'unknown');
  assert.equal(result.body.code, 'BOOTSTRAP_REVOKE_FAILED');
  assert.equal(JSON.stringify(result.body).includes('a'.repeat(48)), false);
  const ledger = db.prepare("SELECT status,safe_error_code FROM consult_link_sends").first();
  assert.equal(ledger.status, 'unknown');
  assert.equal(ledger.safe_error_code, 'BOOTSTRAP_REVOKE_FAILED');
  result = await call(db, { action: 'send', staffId: 'student-a' }, options);
  assert.equal(result.status, 202);
  assert.equal(result.body.idempotent, true);
  assert.equal(fetches, 1);
  assert.equal(revokes, 1);
});

test('concurrent double click reserves once and invokes Solapi once', async t => {
  const db = new TestD1();
  seedStudent(db, 'student-a', '김학생');
  await register(db);
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  let releaseFetch;
  let enteredFetch;
  const entered = new Promise(resolve => { enteredFetch = resolve; });
  const release = new Promise(resolve => { releaseFetch = resolve; });
  globalThis.fetch = async () => {
    fetches += 1;
    enteredFetch();
    await release;
    return acceptedResponse();
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const firstPromise = call(db, { action: 'send', staffId: 'student-a' });
  await entered;
  const second = await call(db, { action: 'send', staffId: 'student-a' });
  assert.equal(second.status, 202);
  assert.equal(second.body.idempotent, true);
  assert.equal(fetches, 1);
  releaseFetch();
  const first = await firstPromise;
  assert.equal(first.status, 200);
  assert.equal(fetches, 1);
});

test('task, own scope, owner targets, and injected send fields are rejected before code/fetch', async t => {
  const db = new TestD1();
  seedStudent(db, 'student-a', '김학생');
  seedStudent(db, 'owner-a', '원장', { owner: true });
  await register(db);
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  let issues = 0;
  globalThis.fetch = async () => { fetches += 1; return acceptedResponse(); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const issue = async () => { issues += 1; return { code: 'c'.repeat(48) }; };

  let result = await call(db, { action: 'send', staffId: 'student-a' }, { app: 'task', issue });
  assert.equal(result.status, 400);
  result = await call(db, { action: 'send', staffId: 'student-a' }, {
    auth: { scope: 'own', id: 'student-a' }, issue
  });
  assert.equal(result.status, 403);
  result = await call(db, {
    action: 'send', staffId: 'student-a', phone: '01099998888'
  }, { issue });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'REQUEST_FIELD_FORBIDDEN');
  result = await call(db, {
    action: 'set', staffId: 'owner-a', phone: '01099998888', consent: true, expectedUpdatedAt: 0
  }, { issue });
  assert.equal(result.status, 409);
  assert.equal(fetches, 0);
  assert.equal(issues, 0);
});
