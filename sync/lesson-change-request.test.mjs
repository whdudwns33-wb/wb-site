import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

import worker from './worker-core.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/012_lesson_change_requests.sql', import.meta.url), 'utf8');

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

  const lessonTask = {
    id: 'task-1', groupId: 'g1', staffId: 'S-kim',
    title: '[수업] 예시학생 (중2) — 수학', detail: '쎈 2-2, 82쪽', guide: '학생 특징: ...',
    steps: [], target: 0, unit: '회', time: '18:00', priority: 'normal',
    repeat: 'days', days: [1, 3, 5], start: '2026-08-02', end: '', carry: true,
    createdAt: now, updatedAt: now, deleted: false
  };
  db.prepare("INSERT INTO tasks (app,id,owner,data,updated_at,srv_at) VALUES ('task','task-1','S-kim',?,?,?)")
    .bind(JSON.stringify(lessonTask), now, now).run();
  return { now };
}

test('schema and migration are additive and restrict states', () => {
  for (const sql of [schema, migration]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS lesson_change_requests/);
    for (const status of ['approval_waiting', 'approved', 'rejected', 'cancelled']) {
      assert.ok(sql.includes("'" + status + "'"));
    }
    assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM/i);
  }
});

test('unauthenticated request is rejected', async () => {
  const db = new TestD1(); seed(db);
  const r = await call(db, '/lesson-change-request', { action: 'list' });
  assert.equal(r.status, 401);
});

test('staff can propose a change and it does not touch the live task until approved', async () => {
  const db = new TestD1(); seed(db);
  const submit = await call(db, '/lesson-change-request', {
    auth: person('S-kim', 'tok-kim'), action: 'submit', taskId: 'task-1',
    changes: { days: [2, 4], time: '19:30', staffId: 'hacker', id: 'evil' }, note: '화목반으로 옮겨주세요'
  });
  assert.equal(submit.status, 200);
  assert.equal(submit.body.request.changes.days.join(','), '2,4');
  assert.ok(!('staffId' in submit.body.request.changes), '화이트리스트 밖 필드는 저장되지 않는다');

  const liveTask = JSON.parse(db.prepare("SELECT data FROM tasks WHERE app='task' AND id='task-1'").first().data);
  assert.equal(liveTask.days.join(','), '1,3,5', '승인 전에는 실제 지시서가 그대로다');
});

test('submitting for a missing task 404s, and for someone else\'s task 403s', async () => {
  const db = new TestD1(); seed(db);
  const missing = await call(db, '/lesson-change-request', {
    auth: person('S-kim', 'tok-kim'), action: 'submit', taskId: 'no-such-task', changes: { time: '10:00' }
  });
  assert.equal(missing.status, 404);

  const forbidden = await call(db, '/lesson-change-request', {
    auth: person('S-other', 'tok-other'), action: 'submit', taskId: 'task-1', changes: { time: '11:00' }
  });
  assert.equal(forbidden.status, 403);
});

test('director sees the pending request and approving it writes into the live task', async () => {
  const db = new TestD1(); seed(db);
  const submit = await call(db, '/lesson-change-request', {
    auth: person('S-kim', 'tok-kim'), action: 'submit', taskId: 'task-1', changes: { days: [2, 4], time: '19:30' }
  });
  const { requestKey } = submit.body.request;

  const list = await call(db, '/lesson-change-review', { auth: admin, action: 'list', status: 'approval_waiting' });
  assert.equal(list.body.requests.length, 1);

  const wrongRevision = await call(db, '/lesson-change-review', { auth: admin, action: 'approve', requestKey, revision: 99 });
  assert.equal(wrongRevision.status, 409);

  const approve = await call(db, '/lesson-change-review', { auth: admin, action: 'approve', requestKey, revision: 1 });
  assert.equal(approve.status, 200);
  const applied = JSON.parse(db.prepare("SELECT data FROM tasks WHERE app='task' AND id='task-1'").first().data);
  assert.equal(applied.days.join(','), '2,4');
  assert.equal(applied.time, '19:30');
  assert.equal(applied.title, '[수업] 예시학생 (중2) — 수학', '화이트리스트 밖 필드는 보존된다');

  const again = await call(db, '/lesson-change-review', { auth: admin, action: 'approve', requestKey, revision: 1 });
  assert.equal(again.body.idempotent, true, '이미 승인된 요청을 다시 승인해도 안전하다');
});

test('director can reject with a note, and staff sees it in their own list', async () => {
  const db = new TestD1(); seed(db);
  const submit = await call(db, '/lesson-change-request', {
    auth: person('S-kim', 'tok-kim'), action: 'submit', taskId: 'task-1', changes: { time: '20:00' }
  });
  const { requestKey, revision } = submit.body.request;

  const reject = await call(db, '/lesson-change-review', {
    auth: admin, action: 'reject', requestKey, revision, note: '그 시간엔 다른 수업이 있어요'
  });
  assert.equal(reject.body.request.status, 'rejected');

  const mine = await call(db, '/lesson-change-request', { auth: person('S-kim', 'tok-kim'), action: 'list' });
  assert.equal(mine.body.requests[0].status, 'rejected');
  assert.match(mine.body.requests[0].reviewNote, /다른 수업/);
});

test('consult app cannot use this feature', async () => {
  const db = new TestD1(); seed(db);
  const response = await worker.fetch(new Request('https://worker.example/lesson-change-request', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app: 'consult', auth: { mode: 'admin', secret: 'consult-secret' }, action: 'list' })
  }), { DB: db, TASK_ADMIN_SECRET: 'director-secret', CONSULT_ADMIN_SECRET: 'consult-secret' });
  assert.equal(response.status, 400);
});
