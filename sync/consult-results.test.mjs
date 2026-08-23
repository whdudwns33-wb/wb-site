import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import worker from './worker-core.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/049_consult_result_sheets.sql', import.meta.url), 'utf8');
const coreSource = fs.readFileSync(new URL('./worker-core.js', import.meta.url), 'utf8');
const resultSource = fs.readFileSync(new URL('./consult-results.js', import.meta.url), 'utf8');
const guardianSource = fs.readFileSync(new URL('./consult-guardian.js', import.meta.url), 'utf8');
const readme = fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8');
const ADMIN_ORIGIN = 'https://whdudwns33-wb.github.io';
const WORKER_ORIGIN = 'https://worker.example';
const admin = { mode: 'admin', secret: 'consult-secret' };

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
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => statement.run());
      this.database.exec('COMMIT'); return results;
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
}

async function bytesOf(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value && typeof value.arrayBuffer === 'function') return new Uint8Array(await value.arrayBuffer());
  if (value instanceof ReadableStream) return new Uint8Array(await new Response(value).arrayBuffer());
  return new TextEncoder().encode(String(value || ''));
}

class FakeR2 {
  constructor() { this.objects = new Map(); this.puts = []; this.gets = []; this.deletes = []; }
  async put(key, value, options = {}) {
    const bytes = await bytesOf(value); this.puts.push({ key, bytes: bytes.slice(), options });
    this.objects.set(key, { bytes: bytes.slice(), options }); return { key, size: bytes.byteLength };
  }
  async get(key) {
    this.gets.push(key); const stored = this.objects.get(key); if (!stored) return null;
    const bytes = stored.bytes.slice();
    return { key, size: bytes.byteLength, body: new Blob([bytes]).stream() };
  }
  async delete(key) { this.deletes.push(key); this.objects.delete(key); }
}

function pdf(text = 'WB result') {
  return new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n% ' + text + '\n%%EOF\n');
}

function env(db, r2) {
  return {
    DB: db, CONSULT_MEDIA: r2, ALLOW_ORIGIN: ADMIN_ORIGIN,
    CONSULT_ADMIN_SECRET: 'consult-secret', TASK_ADMIN_SECRET: 'task-secret'
  };
}

function seedStaff(db, id, overrides = {}) {
  const stamp = Date.now() - 1000;
  db.prepare('INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('consult', id, id, JSON.stringify({ id, name: id, deleted: false, ...overrides }), stamp, stamp).run();
}

function seedPerson(db, id, token) {
  seedStaff(db, id);
  db.prepare('INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)')
    .bind('consult', token, id, Date.now()).run();
}

async function jsonCall(db, r2, body, { origin = ADMIN_ORIGIN, cookie = '', path = '/consult-result' } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (origin != null) headers.origin = origin;
  if (cookie) headers.cookie = cookie;
  const response = await worker.fetch(new Request(WORKER_ORIGIN + path, {
    method: 'POST', headers, body: JSON.stringify(body)
  }), env(db, r2));
  return { response, status: response.status, body: await response.clone().json().catch(() => null) };
}

async function upload(db, r2, {
  app = 'consult', auth = admin, staffId = 'student-a', subject = 'english', title = '8월 영어 평가',
  resultDate = '2026-08-23', file = pdf(), filename = 'result.pdf', origin = ADMIN_ORIGIN
} = {}) {
  const form = new FormData();
  form.set('app', app); form.set('auth', JSON.stringify(auth)); form.set('staffId', staffId);
  form.set('subject', subject); form.set('title', title); form.set('resultDate', resultDate);
  form.set('file', new Blob([file], { type: 'application/pdf' }), filename);
  const response = await worker.fetch(new Request(WORKER_ORIGIN + '/consult-result-upload', {
    method: 'POST', headers: { origin, 'content-length': String(file.byteLength + 4096) }, body: form
  }), env(db, r2));
  return { response, status: response.status, body: await response.clone().json().catch(() => null) };
}

function cookieOf(result) { return String(result.response.headers.get('set-cookie') || '').split(';')[0]; }

test('result sheets are an additive consult-only private PDF ledger routed before JSON parsing', () => {
  for (const sql of [schema, migration]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS consult_result_sheets/);
    assert.match(sql, /CHECK \(app = 'consult'\)/);
    assert.match(sql, /subject IN \('english','math'\)/);
    assert.match(sql, /media_bytes BETWEEN 1 AND 10485760/);
    assert.match(sql, /trg_consult_result_sheets_no_delete/);
  }
  assert.doesNotMatch(migration, /DROP\s+TABLE|DELETE\s+FROM/i);
  const uploadRoute = coreSource.indexOf("url.pathname === '/consult-result-upload'");
  assert.ok(uploadRoute >= 0 && uploadRoute < coreSource.indexOf('await request.json()'));
  assert.match(coreSource, /url\.pathname === '\/consult-result'/);
  assert.match(resultSource, /Content-Security-Policy': 'sandbox'/);
  assert.match(guardianSource, /CONSULT_GUARDIAN_SCOPE_VERSION = 2/);
  assert.match(readme, /049_consult_result_sheets\.sql/);
  assert.match(readme, /consult-results\/[\s\S]*90일 lifecycle rule은[\s\S]*확대 적용하지 않는다/);
});

test('only the director uploads bounded genuine PDFs for an active student', async () => {
  const db = new TestD1(), r2 = new FakeR2();
  seedPerson(db, 'student-a', 'token-a');
  seedStaff(db, 'owner-a', { owner: true });

  let result = await upload(db, r2);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.result.owner, 'student-a');
  assert.equal(result.body.result.subject, 'english');
  assert.equal(result.body.result.status, 'active');
  assert.equal(result.body.result.objectKey, undefined);
  assert.equal(r2.puts.length, 1);
  assert.match(r2.puts[0].key, /^consult-results\/[a-f0-9]{32}\.pdf$/);
  assert.equal(r2.puts[0].options.httpMetadata.contentType, 'application/pdf');

  const before = r2.puts.length;
  result = await upload(db, r2, { auth: { mode: 'person', id: 'student-a', token: 'token-a' } });
  assert.equal(result.status, 403);
  result = await upload(db, r2, { staffId: 'owner-a' });
  assert.equal(result.status, 409);
  result = await upload(db, r2, { subject: 'science' });
  assert.equal(result.status, 400);
  result = await upload(db, r2, { file: new TextEncoder().encode('not a pdf') });
  assert.equal(result.status, 415);
  result = await upload(db, r2, { filename: 'renamed.txt' });
  assert.equal(result.status, 415);
  result = await upload(db, r2, { app: 'task', auth: { mode: 'admin', secret: 'task-secret' } });
  assert.equal(result.status, 400);
  assert.equal(r2.puts.length, before);
});

test('director list/read/archive uses CAS, hides R2 keys, and removes guardian-visible media', async () => {
  const db = new TestD1(), r2 = new FakeR2();
  seedStaff(db, 'student-a'); seedStaff(db, 'student-b');
  const uploaded = await upload(db, r2);
  const id = uploaded.body.result.id;

  let result = await jsonCall(db, r2, { app: 'consult', auth: admin, action: 'list', staffId: 'student-a' });
  assert.equal(result.status, 200);
  assert.equal(result.body.results.length, 1);
  assert.equal(JSON.stringify(result.body).includes('consult-results/'), false);
  result = await jsonCall(db, r2, { app: 'consult', auth: admin, action: 'list', staffId: 'student-b' });
  assert.deepEqual(result.body.results, []);

  result = await jsonCall(db, r2, { app: 'consult', auth: admin, action: 'read_media', id });
  assert.equal(result.status, 200);
  assert.equal(result.response.headers.get('content-type'), 'application/pdf');
  assert.equal(result.response.headers.get('cache-control'), 'private, no-store');
  assert.equal(result.response.headers.get('content-security-policy'), 'sandbox');
  assert.deepEqual(new Uint8Array(await result.response.arrayBuffer()), pdf());

  result = await jsonCall(db, r2, { app: 'consult', auth: admin, action: 'archive', id, revision: 2 });
  assert.equal(result.status, 409);
  result = await jsonCall(db, r2, { app: 'consult', auth: admin, action: 'archive', id, revision: 1 });
  assert.equal(result.status, 200);
  assert.equal(r2.deletes.length, 1);
  result = await jsonCall(db, r2, { app: 'consult', auth: admin, action: 'list', staffId: 'student-a' });
  assert.deepEqual(result.body.results, []);
  result = await jsonCall(db, r2, { app: 'consult', auth: admin, action: 'read_media', id });
  assert.equal(result.status, 404);
});

test('guardian receives only own opaque metadata and can read but never change a PDF', async () => {
  const db = new TestD1(), r2 = new FakeR2();
  seedStaff(db, 'student-a'); seedStaff(db, 'student-b');
  const own = await upload(db, r2, { staffId: 'student-a', title: 'A 학생 영어 결과' });
  await upload(db, r2, { staffId: 'student-b', subject: 'math', title: 'B 학생 비밀 결과' });

  let result = await jsonCall(db, r2, {
    app: 'consult', auth: admin, action: 'access_set', staffId: 'student-a',
    enabled: true, consentConfirmed: true, expectedUpdatedAt: 0
  }, { path: '/consult-guardian' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const invited = await jsonCall(db, r2, {
    app: 'consult', auth: admin, action: 'invite', staffId: 'student-a'
  }, { path: '/consult-guardian' });
  assert.equal(invited.status, 200);
  const exchanged = await jsonCall(db, r2, {
    app: 'consult', action: 'exchange', code: invited.body.code
  }, { path: '/consult-guardian', origin: WORKER_ORIGIN });
  assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
  assert.equal(exchanged.body.results.length, 1);
  const guardianResult = exchanged.body.results[0];
  assert.match(guardianResult.id, /^cgs_[a-f0-9]{48}$/);
  assert.equal(guardianResult.title, 'A 학생 영어 결과');
  const publicText = JSON.stringify(exchanged.body);
  assert.ok(!publicText.includes(own.body.result.id));
  assert.ok(!publicText.includes('consult-results/'));
  assert.ok(!publicText.includes('B 학생 비밀 결과'));
  assert.equal(guardianResult.revision, undefined);

  const media = await jsonCall(db, r2, {
    app: 'consult', action: 'result_media', resultId: guardianResult.id
  }, { path: '/consult-guardian', origin: WORKER_ORIGIN, cookie: cookieOf(exchanged) });
  assert.equal(media.status, 200);
  assert.equal(media.response.headers.get('content-type'), 'application/pdf');
  assert.deepEqual(new Uint8Array(await media.response.arrayBuffer()), pdf());

  result = await jsonCall(db, r2, {
    app: 'consult', action: 'archive', id: own.body.result.id, revision: 1
  }, { path: '/consult-guardian', origin: WORKER_ORIGIN, cookie: cookieOf(exchanged) });
  assert.equal(result.status, 400, 'guardian endpoint has no mutation action');
  result = await jsonCall(db, r2, {
    app: 'consult', action: 'result_media', resultId: guardianResult.id
  }, { path: '/consult-guardian', origin: ADMIN_ORIGIN, cookie: cookieOf(exchanged) });
  assert.equal(result.status, 403, 'public reads require exact portal origin');
});
