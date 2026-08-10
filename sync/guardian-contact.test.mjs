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

async function call(db, body) {
  const response = await worker.fetch(new Request('https://worker.example/guardian-contact', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app: 'task', ...body })
  }), { DB: db, TASK_ADMIN_SECRET: 'director-secret', CONSULT_ADMIN_SECRET: 'consult-secret' });
  return { status: response.status, body: await response.json() };
}

function seedStaff(db) {
  const now = Date.now();
  db.prepare("INSERT INTO staff (app,id,owner,data,updated_at,srv_at) VALUES ('task','S-kim','S-kim',?,?,?)")
    .bind(JSON.stringify({ id: 'S-kim', name: '김남기', deleted: false }), now, now).run();
  db.prepare("INSERT INTO tokens (app,token,staff_id,created_at,revoked) VALUES ('task','tok-kim','S-kim',?,0)").bind(now).run();
}

test('schema and migration add guardian_contacts additively and never touch roster.json-style static data', () => {
  for (const sql of [schema, migration]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS guardian_contacts/);
    assert.doesNotMatch(sql, /DROP TABLE guardian_contacts|DELETE FROM guardian_contacts/i);
  }
});

test('only the director (admin secret) can manage guardian contacts', async () => {
  const db = new TestD1(); seedStaff(db);
  const staffTry = await call(db, { auth: person('S-kim', 'tok-kim'), action: 'list' });
  assert.equal(staffTry.status, 403);

  const noAuth = await call(db, { action: 'list' });
  assert.equal(noAuth.status, 401);
});

test('director can register a phone and toggle consent', async () => {
  const db = new TestD1(); seedStaff(db);
  const set = await call(db, { auth: admin, action: 'set', studentName: '테스트학생', phone: '010-1234-5678', consent: true });
  assert.equal(set.status, 200);
  assert.equal(set.body.contact.phone, '01012345678', '전화번호는 숫자만 정규화되어 저장된다');
  assert.equal(set.body.contact.consent, true);

  const list = await call(db, { auth: admin, action: 'list' });
  assert.equal(list.body.contacts.length, 1);
  assert.equal(list.body.contacts[0].studentName, '테스트학생');
});

test('invalid phone format is rejected', async () => {
  const db = new TestD1(); seedStaff(db);
  const bad = await call(db, { auth: admin, action: 'set', studentName: '테스트학생', phone: '123', consent: false });
  assert.equal(bad.status, 400);
});

test('consent cannot be turned on without a phone number', async () => {
  const db = new TestD1(); seedStaff(db);
  const r = await call(db, { auth: admin, action: 'set', studentName: '테스트학생', phone: '', consent: true });
  assert.equal(r.status, 400);
});

test('re-saving updates the same row (upsert), not a duplicate', async () => {
  const db = new TestD1(); seedStaff(db);
  await call(db, { auth: admin, action: 'set', studentName: '테스트학생', phone: '01011112222', consent: true });
  await call(db, { auth: admin, action: 'set', studentName: '테스트학생', phone: '01033334444', consent: false });
  const rows = db.prepare("SELECT * FROM guardian_contacts WHERE app='task'").all().results;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].phone, '01033334444');
  assert.equal(Number(rows[0].consent), 0);
});

test('empty phone clears the contact (consent forced off)', async () => {
  const db = new TestD1(); seedStaff(db);
  await call(db, { auth: admin, action: 'set', studentName: '테스트학생', phone: '01011112222', consent: true });
  const cleared = await call(db, { auth: admin, action: 'set', studentName: '테스트학생', phone: '', consent: false });
  assert.equal(cleared.body.contact.phone, '');
  assert.equal(cleared.body.contact.consent, false);
});

test('consult app cannot use this feature', async () => {
  const db = new TestD1();
  const response = await worker.fetch(new Request('https://worker.example/guardian-contact', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app: 'consult', auth: { mode: 'admin', secret: 'consult-secret' }, action: 'list' })
  }), { DB: db, TASK_ADMIN_SECRET: 'director-secret', CONSULT_ADMIN_SECRET: 'consult-secret' });
  assert.equal(response.status, 400);
});
