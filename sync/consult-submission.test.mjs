import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import worker from './worker-core.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migrationUrl = new URL('./migrations/041_consult_submissions.sql', import.meta.url);
const migration = fs.existsSync(migrationUrl) ? fs.readFileSync(migrationUrl, 'utf8') : '';
const coreSource = fs.readFileSync(new URL('./worker-core.js', import.meta.url), 'utf8');
const submissionSource = fs.readFileSync(new URL('./consult-submission.js', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('./wrangler.toml', import.meta.url), 'utf8');
const readme = fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8');

const ORIGIN = 'https://whdudwns33-wb.github.io';
const MAX_JPEG_BYTES = 2 * 1024 * 1024;
const admin = { mode: 'admin', secret: 'consult-secret' };
const person = (id, token) => ({ mode: 'person', id, token });

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
    this.database.exec(schema);
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

async function bytesOf(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value && typeof value.arrayBuffer === 'function') return new Uint8Array(await value.arrayBuffer());
  if (value instanceof ReadableStream) return new Uint8Array(await new Response(value).arrayBuffer());
  return new TextEncoder().encode(String(value || ''));
}

class FakeR2 {
  constructor() {
    this.objects = new Map();
    this.puts = [];
    this.gets = [];
    this.deletes = [];
    this.listCalls = 0;
  }
  async put(key, value, options = {}) {
    const bytes = await bytesOf(value);
    this.puts.push({ key, bytes: bytes.slice(), options });
    this.objects.set(key, { bytes: bytes.slice(), options });
    return { key, size: bytes.byteLength, etag: 'test-etag', httpEtag: '"test-etag"' };
  }
  async head(key) {
    const stored = this.objects.get(key);
    return stored ? { key, size: stored.bytes.byteLength, etag: 'test-etag', httpEtag: '"test-etag"' } : null;
  }
  async get(key) {
    this.gets.push(key);
    const stored = this.objects.get(key);
    if (!stored) return null;
    const bytes = stored.bytes.slice();
    return {
      key,
      size: bytes.byteLength,
      etag: 'test-etag',
      httpEtag: '"test-etag"',
      body: new Blob([bytes]).stream(),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      blob: async () => new Blob([bytes], { type: 'image/jpeg' }),
      writeHttpMetadata(headers) {
        headers.set('Content-Type', 'image/jpeg');
      }
    };
  }
  async delete(key) {
    this.deletes.push(key);
    this.objects.delete(key);
  }
  async list() {
    this.listCalls += 1;
    throw new Error('cleanup must never scan the bucket');
  }
}

function jpeg({ width = 1200, height = 800, size = 160, exif = false, sof = true } = {}) {
  const head = [0xff, 0xd8];
  if (exif) head.push(0xff, 0xe1, 0x00, 0x0a, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x00, 0x00);
  if (sof) {
    head.push(0xff, 0xc0, 0x00, 0x11, 0x08,
      (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff,
      0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00);
  }
  head.push(0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00);
  const output = new Uint8Array(Math.max(size, head.length + 2));
  output.set(head);
  output[output.length - 2] = 0xff;
  output[output.length - 1] = 0xd9;
  return output;
}

function seedPerson(db, id, token) {
  const stamp = Date.now();
  db.prepare('INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('consult', id, id, JSON.stringify({ id, name: id, deleted: false }), stamp, stamp).run();
  db.prepare('INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)')
    .bind('consult', token, id, stamp).run();
}

function seedTask(db, id, owner, date = '2026-08-18', overrides = {}) {
  const stamp = Date.now();
  const data = Object.assign({
    id, staffId: owner, title: '수학 문제 풀기', start: date, end: '', repeat: 'once', days: [],
    evidenceMode: 'photo', origin: 'admin', deleted: false, updatedAt: stamp
  }, overrides);
  db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('consult', id, owner, JSON.stringify(data), stamp, stamp).run();
  db.prepare('INSERT INTO checks(app,k,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('consult', id + '|' + date, owner, JSON.stringify({ taskId: id, date, done: false, updatedAt: stamp }), stamp, stamp).run();
}

function env(db, r2) {
  return {
    DB: db,
    CONSULT_MEDIA: r2,
    ALLOW_ORIGIN: ORIGIN,
    CONSULT_ADMIN_SECRET: 'consult-secret',
    TASK_ADMIN_SECRET: 'task-secret'
  };
}

async function jsonCall(db, r2, body, { path = '/consult-submission', origin = ORIGIN } = {}) {
  const response = await worker.fetch(new Request('https://worker.example' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(body)
  }), env(db, r2));
  return { response, status: response.status, body: await response.json().catch(() => null) };
}

async function upload(db, r2, {
  app = 'consult', auth, kind = 'proof', clientRequestId = crypto.randomUUID(),
  taskId = '', taskDate = '', bodyText = '', file = jpeg(), type = 'image/jpeg',
  filename = 'submission.jpg', origin = ORIGIN, includeLength = true
} = {}) {
  const form = new FormData();
  form.set('app', app);
  form.set('auth', JSON.stringify(auth || null));
  form.set('kind', kind);
  form.set('clientRequestId', clientRequestId);
  if (taskId) form.set('taskId', taskId);
  if (taskDate) form.set('taskDate', taskDate);
  if (bodyText) form.set('bodyText', bodyText);
  form.set('file', new Blob([file], { type }), filename);
  const headers = { origin };
  if (includeLength) headers['content-length'] = String(Number(file && file.byteLength || file && file.size || 0) + 4096);
  const response = await worker.fetch(new Request('https://worker.example/consult-submission-upload', {
    method: 'POST', headers, body: form
  }), env(db, r2));
  return { response, status: response.status, body: await response.json().catch(() => null) };
}

function publicJson(value, ...forbidden) {
  const text = JSON.stringify(value || {});
  assert.doesNotMatch(text, /object_?key|r2\.dev|cloudflarestorage\.com|presign/i);
  forbidden.filter(Boolean).forEach(secret => assert.ok(!text.includes(secret), 'private value leaked: ' + secret));
}

test('schema, routing, and deployment bind a private consult-only media ledger additively', () => {
  assert.ok(migration, '041_consult_submissions.sql must exist');
  for (const sql of [schema, migration]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS consult_submissions/);
    assert.match(sql, /CHECK\s*\(app\s*=\s*'consult'\)/);
    for (const value of ['proof', 'question', 'pending', 'approved', 'rejected', 'answered', 'cancelled']) {
      assert.ok(sql.includes("'" + value + "'"), value + ' must be schema constrained');
    }
  }
  assert.doesNotMatch(migration, /DROP\s+TABLE|DELETE\s+FROM/i);
  assert.match(wrangler, /\[\[r2_buckets\]\][\s\S]*?binding\s*=\s*"CONSULT_MEDIA"/);
  assert.doesNotMatch(wrangler, /r2\.dev|cloudflarestorage\.com|custom_domain/i);

  const uploadRoute = coreSource.indexOf("url.pathname === '/consult-submission-upload'");
  assert.ok(uploadRoute >= 0 && uploadRoute < coreSource.indexOf('await request.json()'),
    'multipart upload must be routed before the shared JSON parser');
  assert.ok(coreSource.includes("url.pathname === '/consult-submission'"));
  assert.match(readme, /r2 bucket lifecycle add[^\n]*wb-consult-private[^\n]*(?:--prefix\s+consult\/|consult\/)[^\n]*(?:--expire-days\s+90|90)/i,
    'deployment docs must include the required 90-day consult/ lifecycle command');
  assert.match(readme, /public development URL[^\n]*(?:사용하지|켜지 않|OFF)/i);
  assert.match(submissionSource, /media_expires_at/);
  assert.match(submissionSource, /action === 'read_media'/);
});

test('a valid JPEG proof is private, bounded, and idempotent by clientRequestId', async () => {
  const db = new TestD1();
  const r2 = new FakeR2();
  seedPerson(db, 'student-a', 'token-a');
  seedTask(db, 'task-a', 'student-a');
  const auth = person('student-a', 'token-a');
  const request = {
    auth, kind: 'proof', clientRequestId: 'client-proof-1', taskId: 'task-a', taskDate: '2026-08-18',
    file: jpeg({ width: 2000, height: 2000, size: MAX_JPEG_BYTES })
  };

  let result = await upload(db, r2, request);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.submission.owner, 'student-a');
  assert.equal(result.body.submission.kind, 'proof');
  assert.equal(result.body.submission.status, 'pending');
  assert.equal(result.body.submission.revision, 1);
  assert.equal(result.body.submission.hasImage, true);
  publicJson(result.body, 'token-a');
  assert.equal(r2.puts.length, 1);
  assert.equal(r2.puts[0].bytes.byteLength, MAX_JPEG_BYTES);

  result = await upload(db, r2, request);
  assert.equal(result.status, 200);
  assert.equal(result.body.idempotent, true);
  assert.equal(result.body.submission.revision, 1);
  assert.equal(r2.puts.length, 1, 'an idempotent retry must not store a second object');

});

test('upload rejects oversized, spoofed, over-dimensioned, missing-SOF, and EXIF JPEGs before R2', async () => {
  const cases = [
    ['empty', new Uint8Array(), 'image/jpeg', 413],
    ['too large', jpeg({ size: MAX_JPEG_BYTES + 1 }), 'image/jpeg', 413],
    ['wrong MIME', jpeg(), 'image/png', 415],
    ['renamed PNG', Uint8Array.of(0x89, 0x50, 0x4e, 0x47), 'image/jpeg', 415],
    ['missing SOF', jpeg({ sof: false }), 'image/jpeg', 415],
    ['side over 2000px', jpeg({ width: 2001, height: 1000 }), 'image/jpeg', 413],
    ['EXIF metadata', jpeg({ exif: true }), 'image/jpeg', 415]
  ];

  {
    const db = new TestD1();
    const r2 = new FakeR2();
    seedPerson(db, 'student-a', 'token-a');
    seedTask(db, 'task-a', 'student-a');
    const missingLength = await upload(db, r2, {
      auth: person('student-a', 'token-a'), kind: 'proof', taskId: 'task-a', taskDate: '2026-08-18', includeLength: false
    });
    assert.equal(missingLength.status, 411);
    assert.equal(r2.puts.length, 0);
  }
  for (const [label, file, type, expected] of cases) {
    const db = new TestD1();
    const r2 = new FakeR2();
    seedPerson(db, 'student-a', 'token-a');
    seedTask(db, 'task-a', 'student-a');
    const result = await upload(db, r2, {
      auth: person('student-a', 'token-a'), clientRequestId: 'bad-' + label.replace(/\s/g, '-'),
      taskId: 'task-a', taskDate: '2026-08-18', file, type, filename: 'looks-safe.jpg'
    });
    assert.equal(result.status, expected, label);
    assert.equal(r2.puts.length, 0, label + ' must be rejected before storage');
    assert.equal(r2.objects.size, 0, label);
  }
});

test('consult submissions enforce own/all scope without touching R2 before authorization', async () => {
  const db = new TestD1();
  const r2 = new FakeR2();
  seedPerson(db, 'student-a', 'token-a');
  seedPerson(db, 'student-b', 'token-b');
  seedTask(db, 'task-a', 'student-a');
  seedTask(db, 'task-b', 'student-b');

  let result = await upload(db, r2, {
    auth: person('student-a', 'token-a'), clientRequestId: 'cross-owner',
    taskId: 'task-b', taskDate: '2026-08-18'
  });
  assert.ok(result.status === 403 || result.status === 404);
  assert.equal(r2.puts.length, 0);

  result = await upload(db, r2, {
    auth: person('student-a', 'token-a'), clientRequestId: 'own-proof',
    taskId: 'task-a', taskDate: '2026-08-18'
  });
  assert.equal(result.status, 200);
  const id = result.body.submission.id;

  const own = await jsonCall(db, r2, { app: 'consult', auth: person('student-a', 'token-a'), action: 'list' });
  assert.equal(own.status, 200);
  assert.deepEqual(own.body.submissions.map(item => item.id), [id]);
  publicJson(own.body, 'token-a');

  const other = await jsonCall(db, r2, { app: 'consult', auth: person('student-b', 'token-b'), action: 'list' });
  assert.equal(other.status, 200);
  assert.deepEqual(other.body.submissions, []);
  const getsBefore = r2.gets.length;
  const readOther = await jsonCall(db, r2, {
    app: 'consult', auth: person('student-b', 'token-b'), action: 'read_media', id
  });
  assert.equal(readOther.status, 404);
  assert.equal(r2.gets.length, getsBefore, 'ownership must be checked before reading the bucket');

  const all = await jsonCall(db, r2, { app: 'consult', auth: admin, action: 'list' });
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.submissions.map(item => item.id), [id]);

  const taskApp = await upload(db, r2, {
    app: 'task', auth: person('student-a', 'token-a'), clientRequestId: 'wrong-app',
    taskId: 'task-a', taskDate: '2026-08-18'
  });
  assert.equal(taskApp.status, 400);
  const foreignOrigin = await upload(db, r2, {
    auth: person('student-a', 'token-a'), clientRequestId: 'foreign-origin',
    taskId: 'task-a', taskDate: '2026-08-18', origin: 'https://evil.example'
  });
  assert.equal(foreignOrigin.status, 403);
  assert.equal(r2.puts.length, 1);
});

test('proof is accepted only for a director-assigned photo-evidence task', async () => {
  const db = new TestD1();
  const r2 = new FakeR2();
  seedPerson(db, 'student-a', 'token-a');
  seedTask(db, 'plain-task', 'student-a', '2026-08-18', { evidenceMode: '' });
  seedTask(db, 'student-task', 'student-a', '2026-08-18', { origin: 'staff' });

  for (const taskId of ['plain-task', 'student-task']) {
    const result = await upload(db, r2, {
      auth: person('student-a', 'token-a'), clientRequestId: 'forbidden-' + taskId,
      taskId, taskDate: '2026-08-18'
    });
    assert.equal(result.status, 403, taskId);
  }
  assert.equal(r2.puts.length, 0, 'an unapproved task must be rejected before private storage');
});

test('only the director can approve or reject proof and answer questions; stale CAS is rejected', async () => {
  const db = new TestD1();
  const r2 = new FakeR2();
  seedPerson(db, 'student-a', 'token-a');
  seedTask(db, 'task-a', 'student-a');
  const ownAuth = person('student-a', 'token-a');

  let proof = await upload(db, r2, {
    auth: ownAuth, clientRequestId: 'review-proof', taskId: 'task-a', taskDate: '2026-08-18'
  });
  const proofId = proof.body.submission.id;
  let result = await jsonCall(db, r2, {
    app: 'consult', auth: ownAuth, action: 'approve', id: proofId, revision: 1
  });
  assert.equal(result.status, 403);

  result = await jsonCall(db, r2, {
    app: 'consult', auth: admin, action: 'approve', id: proofId, revision: 1
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.submission.status, 'approved');
  assert.equal(result.body.submission.revision, 2);
  result = await jsonCall(db, r2, {
    app: 'consult', auth: admin, action: 'approve', id: proofId, revision: 1
  });
  assert.equal(result.status, 409);
  result = await jsonCall(db, r2, {
    app: 'consult', auth: admin, action: 'reject', id: proofId, revision: 1, reviewNote: '다시 제출'
  });
  assert.equal(result.status, 409);

  let question = await jsonCall(db, r2, {
    app: 'consult', auth: ownAuth, action: 'submit_question',
    clientRequestId: 'question-1', bodyText: '이 문제의 풀이를 모르겠어요.'
  });
  assert.equal(question.status, 200);
  assert.equal(question.body.submission.kind, 'question');
  assert.equal(question.body.submission.status, 'pending');
  assert.equal(question.body.submission.hasImage, false);
  const questionId = question.body.submission.id;
  const repeatedQuestion = await jsonCall(db, r2, {
    app: 'consult', auth: ownAuth, action: 'submit_question',
    clientRequestId: 'question-1', bodyText: '이 문제의 풀이를 모르겠어요.'
  });
  assert.equal(repeatedQuestion.status, 200);
  assert.equal(repeatedQuestion.body.idempotent, true);
  assert.equal(repeatedQuestion.body.submission.id, questionId);

  result = await jsonCall(db, r2, {
    app: 'consult', auth: ownAuth, action: 'answer', id: questionId, revision: 1, answerText: '식을 먼저 정리하세요.'
  });
  assert.equal(result.status, 403);
  result = await jsonCall(db, r2, {
    app: 'consult', auth: admin, action: 'answer', id: questionId, revision: 1, answerText: '식을 먼저 정리하세요.'
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.submission.status, 'answered');
  assert.equal(result.body.submission.revision, 2);
  assert.equal(result.body.submission.answerText, '식을 먼저 정리하세요.');
  result = await jsonCall(db, r2, {
    app: 'consult', auth: admin, action: 'answer', id: questionId, revision: 1, answerText: '식을 먼저 정리하세요.'
  });
  assert.equal(result.status, 409);
});

test('authenticated media reads return only JPEG bytes with private fixed headers', async () => {
  const db = new TestD1();
  const r2 = new FakeR2();
  seedPerson(db, 'student-a', 'token-a');
  seedTask(db, 'task-a', 'student-a');
  const original = jpeg({ width: 900, height: 1200, size: 512 });
  const created = await upload(db, r2, {
    auth: person('student-a', 'token-a'), clientRequestId: 'read-proof',
    taskId: 'task-a', taskDate: '2026-08-18', file: original, filename: 'student-a-secret-name.jpg'
  });
  const id = created.body.submission.id;
  const response = await worker.fetch(new Request('https://worker.example/consult-submission', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ app: 'consult', auth: person('student-a', 'token-a'), action: 'read_media', id })
  }), env(db, r2));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.match(response.headers.get('cache-control') || '', /private/);
  assert.match(response.headers.get('cache-control') || '', /no-store/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  const disposition = response.headers.get('content-disposition') || '';
  assert.match(disposition, /inline/i);
  assert.doesNotMatch(disposition, /student-a|secret-name|token-a/i);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), original);

  // This isolated fixture bypasses the production immutability guard only to exercise
  // the read-time expiry boundary; production rows remain immutable.
  db.database.exec('DROP TRIGGER trg_consult_submissions_update_guard');
  const expiredAt = Date.now() - 1;
  db.prepare("UPDATE consult_submissions SET created_at=?,media_expires_at=? WHERE app='consult' AND submission_id=?")
    .bind(expiredAt - 90 * 24 * 60 * 60 * 1000, expiredAt, id).run();
  const getsBeforeExpiry = r2.gets.length;
  const expired = await jsonCall(db, r2, {
    app: 'consult', auth: person('student-a', 'token-a'), action: 'read_media', id
  });
  assert.equal(expired.status, 410);
  assert.equal(r2.gets.length, getsBeforeExpiry, 'expired metadata must block access before R2');
});

test('cancel removes only its R2 object and never changes existing task/check rows or task sync', async () => {
  const db = new TestD1();
  const r2 = new FakeR2();
  seedPerson(db, 'student-a', 'token-a');
  seedTask(db, 'task-a', 'student-a');
  const beforeTask = db.prepare("SELECT * FROM tasks WHERE app='consult' AND id='task-a'").first();
  const beforeCheck = db.prepare("SELECT * FROM checks WHERE app='consult' AND k='task-a|2026-08-18'").first();

  const created = await upload(db, r2, {
    auth: person('student-a', 'token-a'), clientRequestId: 'cancel-proof',
    taskId: 'task-a', taskDate: '2026-08-18'
  });
  assert.equal(created.status, 200);
  const storedKey = r2.puts[0].key;
  const directorCancel = await jsonCall(db, r2, {
    app: 'consult', auth: admin, action: 'cancel', id: created.body.submission.id, revision: 1
  });
  assert.equal(directorCancel.status, 403);
  assert.equal(r2.deletes.length, 0, 'the director must not erase a student submission as if the student cancelled it');
  const cancelled = await jsonCall(db, r2, {
    app: 'consult', auth: person('student-a', 'token-a'), action: 'cancel',
    id: created.body.submission.id, revision: 1
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.submission.status, 'cancelled');
  assert.equal(r2.objects.has(storedKey), false);
  assert.deepEqual(r2.deletes, [storedKey]);
  assert.equal(r2.listCalls, 0);
  const getsBeforeCancelRead = r2.gets.length;
  const cancelledRead = await jsonCall(db, r2, {
    app: 'consult', auth: person('student-a', 'token-a'), action: 'read_media', id: created.body.submission.id
  });
  assert.equal(cancelledRead.status, 410);
  assert.equal(r2.gets.length, getsBeforeCancelRead, 'cancelled metadata must block access before R2');
  assert.deepEqual(db.prepare("SELECT * FROM tasks WHERE app='consult' AND id='task-a'").first(), beforeTask);
  assert.deepEqual(db.prepare("SELECT * FROM checks WHERE app='consult' AND k='task-a|2026-08-18'").first(), beforeCheck);

  const taskSync = await worker.fetch(new Request('https://worker.example/sync', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ app: 'task', auth: { mode: 'admin', secret: 'task-secret' }, since: 0, changes: [] })
  }), env(db, r2));
  assert.equal(taskSync.status, 200);
  assert.equal((await taskSync.json()).ok, true);
});
