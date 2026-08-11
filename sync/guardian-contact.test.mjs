import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

import worker from './worker-core.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/016_parent_feedback_send.sql', import.meta.url), 'utf8');
const migration021 = fs.readFileSync(new URL('./migrations/021_parent_feedback_student_ids.sql', import.meta.url), 'utf8');

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

async function call(db, body, env = {}) {
  const response = await worker.fetch(new Request('https://worker.example/guardian-contact', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app: 'task', ...body })
  }), { DB: db, TASK_ADMIN_SECRET: 'director-secret', CONSULT_ADMIN_SECRET: 'consult-secret', ...env });
  return { status: response.status, body: await response.json() };
}

function seedStaff(db) {
  const now = Date.now();
  db.prepare("INSERT INTO staff (app,id,owner,data,updated_at,srv_at) VALUES ('task','S-kim','S-kim',?,?,?)")
    .bind(JSON.stringify({ id: 'S-kim', name: '김남기', deleted: false }), now, now).run();
  db.prepare("INSERT INTO tokens (app,token,staff_id,created_at,revoked) VALUES ('task','tok-kim','S-kim',?,0)").bind(now).run();
  const roster = {
    roster: {
      updated: '2026-08-09', baseline: '2026-08',
      students: [{
        id: 'student-test', name: '테스트학생', grade: '중2', teacher: '김남기', subject: '국어',
        start: '2026-08', end: '', reason: '', teacherIds: ['S-kim']
      }]
    },
    bookStudents: []
  };
  db.prepare("INSERT INTO private_rosters(app,data,updated_at) VALUES('task',?,?)")
    .bind(JSON.stringify(roster), now).run();
}

test('schema and migrations add stable-id guardian contacts without guessing legacy name mappings', () => {
  for (const sql of [schema, migration, migration021]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS guardian_contacts/);
    assert.doesNotMatch(sql, /DROP TABLE guardian_contacts|DELETE FROM guardian_contacts/i);
  }
  assert.match(migration021, /guardian_contacts_by_student/);
  assert.doesNotMatch(migration021, /INSERT INTO guardian_contacts_by_student[\s\S]*SELECT/i);
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
  const set = await call(db, {
    auth: admin, action: 'set', studentId: 'student-test', phone: '010-1234-5678', consent: true
  });
  assert.equal(set.status, 200);
  assert.equal(set.body.contact.phone, '01012345678', '전화번호는 숫자만 정규화되어 저장된다');
  assert.equal(set.body.contact.consent, true);

  const list = await call(db, { auth: admin, action: 'list' });
  assert.equal(list.body.contacts.length, 1);
  assert.equal(list.body.contacts[0].studentId, 'student-test');
  assert.equal(list.body.contacts[0].studentName, '테스트학생');
});

test('legacy UI name-only set resolves one roster student to a stable id, but never guesses duplicates', async () => {
  const db = new TestD1(); seedStaff(db);
  let result = await call(db, {
    auth: admin, action: 'set', studentName: ' 테스트학생 ', phone: '01012345678', consent: true
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.contact.studentId, 'student-test');

  const stored = JSON.parse(db.prepare("SELECT data FROM private_rosters WHERE app='task'").first().data);
  stored.roster.students.push({ ...stored.roster.students[0], id: 'student-same-name' });
  db.prepare("UPDATE private_rosters SET data=? WHERE app='task'").bind(JSON.stringify(stored)).run();
  result = await call(db, {
    auth: admin, action: 'set', studentName: '테스트학생', phone: '01022223333', consent: true
  });
  assert.equal(result.status, 409);
  assert.match(result.body.error, /동명이인/);
  assert.equal(db.prepare(
    "SELECT COUNT(*) AS count FROM guardian_contacts_by_student WHERE app='task'"
  ).first().count, 1);
});

test('server-authorized manager changes are attributed to the manager staff id', async () => {
  const db = new TestD1(); seedStaff(db);
  const set = await call(db, {
    auth: person('S-kim', 'tok-kim'), action: 'set', studentId: 'student-test',
    phone: '01012345678', consent: true
  }, { TASK_MANAGER_STAFF_IDS: 'S-kim' });
  assert.equal(set.status, 200);
  assert.equal(db.prepare("SELECT updated_by FROM guardian_contacts_by_student WHERE app='task'").first().updated_by, 'S-kim');
});

test('invalid phone format is rejected', async () => {
  const db = new TestD1(); seedStaff(db);
  const bad = await call(db, { auth: admin, action: 'set', studentId: 'student-test', phone: '123', consent: false });
  assert.equal(bad.status, 400);
});

test('consent cannot be turned on without a phone number', async () => {
  const db = new TestD1(); seedStaff(db);
  const r = await call(db, { auth: admin, action: 'set', studentId: 'student-test', phone: '', consent: true });
  assert.equal(r.status, 400);
});

test('re-saving updates the same row (upsert), not a duplicate', async () => {
  const db = new TestD1(); seedStaff(db);
  await call(db, { auth: admin, action: 'set', studentId: 'student-test', phone: '01011112222', consent: true });
  await call(db, { auth: admin, action: 'set', studentId: 'student-test', phone: '01033334444', consent: false });
  const rows = db.prepare("SELECT * FROM guardian_contacts_by_student WHERE app='task'").all().results;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].phone, '01033334444');
  assert.equal(Number(rows[0].consent), 0);
});

test('empty phone clears the contact (consent forced off)', async () => {
  const db = new TestD1(); seedStaff(db);
  await call(db, { auth: admin, action: 'set', studentId: 'student-test', phone: '01011112222', consent: true });
  const cleared = await call(db, { auth: admin, action: 'set', studentId: 'student-test', phone: '', consent: false });
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
