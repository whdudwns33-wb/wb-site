import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import worker from './worker-core.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  first() { return this.db.prepare(this.sql).get(...this.args) || null; }
  all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  run() { const row = this.db.prepare(this.sql).run(...this.args); return { meta: { changes: Number(row.changes || 0) } }; }
}
class TestD1 {
  constructor() { this.database = new DatabaseSync(':memory:'); this.database.exec(schema); }
  prepare(sql) { return new Statement(this.database, sql); }
  batch(statements) { return Promise.all(statements.map(statement => statement.run())); }
}

const admin = { mode: 'admin', secret: 'director-secret' };
const month = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
const date = month + '-15';

function seed(db, end = '') {
  const document = { roster: { updated: date, baseline: month, students: [
    { id: 'student-a', name: '가학생', grade: '중1', teacher: '김선생', subject: '수학',
      start: month, end, reason: '', teacherIds: ['manager-a'] }
  ] }, bookStudents: [] };
  db.prepare('INSERT INTO private_rosters(app,data,updated_at) VALUES(?,?,?)')
    .bind('task', JSON.stringify(document), Date.now()).run();
}

async function call(db, body, path = '/onboarding-patch', env = {}) {
  const response = await worker.fetch(new Request('https://worker.example' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app: 'task', ...body })
  }), { DB: db, TASK_ADMIN_SECRET: 'director-secret', CONSULT_ADMIN_SECRET: 'consult-secret', ...env });
  return { status: response.status, body: await response.json() };
}

test('create uses the stable roster ID and only server-owned fields and timestamps', async () => {
  const db = new TestD1(); seed(db);
  const result = await call(db, { auth: admin, studentId: 'student-a', expectedUpdatedAt: 0,
    op: 'create', payload: { firstClassDate: date } });
  assert.equal(result.status, 200);
  assert.equal(result.body.record.studentId, 'student-a');
  assert.equal(result.body.record.taskId, '__onboarding__student-a');
  assert.equal(result.body.record.date, 'all');
  assert.equal(result.body.record.updatedBy, 'director');
  assert.equal(result.body.record.casVersion, 1);
  assert.ok(result.body.record.updatedAt > 0);
  const row = db.prepare("SELECT k,owner,data,updated_at FROM checks WHERE app='task'").first();
  assert.equal(row.k, '__onboarding__student-a|all');
  assert.equal(row.owner, null);
  assert.equal(JSON.parse(row.data).updatedAt, row.updated_at);
});

test('concurrent different item writes have one winner, return latest, and preserve both after retry', async () => {
  const db = new TestD1(); seed(db);
  const created = await call(db, { auth: admin, studentId: 'student-a', expectedUpdatedAt: 0,
    op: 'create', payload: { firstClassDate: date } });
  const expectedUpdatedAt = created.body.record.updatedAt;
  const requests = ['guardian', 'schedule'].map(itemId => call(db, {
    auth: admin, studentId: 'student-a', expectedUpdatedAt, op: 'item', payload: { itemId, done: true }
  }));
  const results = await Promise.all(requests);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const loser = results.find(result => result.status === 409);
  assert.equal(loser.body.code, 'ONBOARDING_CONFLICT');
  assert.ok(loser.body.current.updatedAt > expectedUpdatedAt);
  const winningItem = Object.keys(loser.body.current.items).find(key => loser.body.current.items[key]);
  const retryItem = winningItem === 'guardian' ? 'schedule' : 'guardian';
  const retried = await call(db, { auth: admin, studentId: 'student-a',
    expectedUpdatedAt: loser.body.current.updatedAt, op: 'item', payload: { itemId: retryItem, done: true } });
  assert.equal(retried.status, 200);
  assert.ok(retried.body.record.items.guardian);
  assert.ok(retried.body.record.items.schedule);
});

test('operation schemas, roster period, ended students, and own-scope access fail closed', async () => {
  const db = new TestD1(); seed(db);
  assert.equal((await call(db, { auth: admin, studentId: 'student-a', expectedUpdatedAt: 0,
    op: 'create', payload: { firstClassDate: '2026-02-30' } })).status, 400);
  assert.equal((await call(db, { auth: admin, studentId: 'student-a', expectedUpdatedAt: 0,
    op: 'item', payload: { itemId: 'forged', done: true } })).status, 400);

  const ended = new TestD1(); seed(ended, month);
  const blocked = await call(ended, { auth: admin, studentId: 'student-a', expectedUpdatedAt: 0,
    op: 'create', payload: { firstClassDate: date } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'STUDENT_ENDED');

  const now = Date.now();
  db.prepare('INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', 'manager-a', 'manager-a', JSON.stringify({ id: 'manager-a', deleted: false }), now, now).run();
  db.prepare('INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)')
    .bind('task', 'token-a', 'manager-a', now).run();
  const own = await call(db, { auth: { mode: 'person', id: 'manager-a', token: 'token-a' }, studentId: 'student-a',
    expectedUpdatedAt: 0, op: 'create', payload: { firstClassDate: date } });
  assert.equal(own.status, 403);
  const allowlisted = await call(db, {
    auth: { mode: 'person', id: 'manager-a', token: 'token-a' }, studentId: 'student-a',
    expectedUpdatedAt: 0, op: 'create', payload: { firstClassDate: date }
  }, '/onboarding-patch', { TASK_MANAGER_STAFF_IDS: 'manager-a' });
  assert.equal(allowlisted.status, 200);
  assert.equal(allowlisted.body.record.updatedBy, 'manager-a');
});

test('generic sync stays compatible with legacy rows but cannot overwrite a CAS-protected row', async () => {
  const db = new TestD1(); seed(db);
  const legacy = { taskId: '__onboarding__student-a', date: 'all', studentId: 'student-a',
    firstClassDate: date, items: {}, updatedAt: 10 };
  db.prepare('INSERT INTO checks(app,k,owner,data,updated_at,srv_at) VALUES(?,?,NULL,?,?,?)')
    .bind('task', '__onboarding__student-a|all', JSON.stringify(legacy), 10, 10).run();
  let synced = await call(db, { auth: admin, since: 0, changes: [{ table: 'checks',
    k: '__onboarding__student-a|all', owner: null, data: { ...legacy, classroom: 'A', updatedAt: 20 }, updated_at: 20 }] }, '/sync');
  assert.equal(synced.status, 200);
  assert.equal(JSON.parse(db.prepare("SELECT data FROM checks WHERE app='task'").first().data).classroom, 'A');

  const patched = await call(db, { auth: admin, studentId: 'student-a', expectedUpdatedAt: 20,
    op: 'classroom', payload: { value: 'B' } });
  assert.equal(patched.status, 200);
  const reconciled = await call(db, { auth: admin, since: patched.body.record.updatedAt + 10000,
    changes: [{ table: 'checks', k: '__onboarding__student-a|all', owner: null, reconcile: true }] }, '/sync');
  assert.equal(reconciled.status, 200);
  assert.equal(reconciled.body.changes.length, 1);
  assert.equal(reconciled.body.changes[0].authoritative, true);
  assert.equal(reconciled.body.changes[0].data.classroom, 'B');
  assert.equal(reconciled.body.changes[0].data.updatedAt, patched.body.record.updatedAt);

  const forged = { ...patched.body.record, classroom: 'FORGED', updatedAt: patched.body.record.updatedAt + 1000 };
  synced = await call(db, { auth: admin, since: forged.updatedAt + 1000, changes: [{ table: 'checks',
    k: '__onboarding__student-a|all', owner: null, data: forged, updated_at: forged.updatedAt }, { table: 'checks',
    k: '__onboarding__student-a|all', owner: null, data: forged, updated_at: forged.updatedAt }] }, '/sync');
  assert.equal(synced.status, 200);
  assert.equal(synced.body.changes.length, 1, '같은 key의 정본은 since와 중복 시도에도 한 번만 내려야 한다');
  assert.equal(synced.body.changes[0].authoritative, true);
  assert.equal(synced.body.changes[0].data.classroom, 'B');
  assert.equal(synced.body.changes[0].data.updatedAt, patched.body.record.updatedAt);
  const stored = JSON.parse(db.prepare("SELECT data FROM checks WHERE app='task'").first().data);
  assert.equal(stored.classroom, 'B');
  assert.equal(stored.casVersion, 1);
});
