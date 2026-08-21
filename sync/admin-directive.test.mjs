import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import worker from './worker-core.js';
import { handleAdminDirective } from './admin-directive.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/048_admin_directives.sql', import.meta.url), 'utf8');

class Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  first() { return this.database.prepare(this.sql).get(...this.args) || null; }
  all() { return { results: this.database.prepare(this.sql).all(...this.args) }; }
  run() { const result = this.database.prepare(this.sql).run(...this.args); return { meta: { changes: Number(result.changes || 0) } }; }
}
class TestD1 {
  constructor() { this.database = new DatabaseSync(':memory:'); this.database.exec(schema); }
  prepare(sql) { return new Statement(this.database, sql); }
  batch(statements) { return Promise.resolve(statements.map(statement => statement.run())); }
}

const manager = { scope: 'all', id: 'manager-a', role: 'manager' };
const teacher = id => ({ scope: 'own', id });
const json = (body, status) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' }
});
const today = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

function seed(db) {
  const now = Date.now();
  for (const [id, name, extra] of [
    ['teacher-a', '가선생', {}], ['teacher-b', '나선생', {}],
    ['director-row', '원장', { owner: true }], ['deleted-a', '퇴사자', { deleted: true }]
  ]) {
    db.prepare('INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
      .bind('task', id, id, JSON.stringify({ id, name, deleted: false, ...extra }), now, now).run();
    if (!extra.owner && !extra.deleted) db.prepare(
      'INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)'
    ).bind('task', 'tok-' + id, id, now).run();
  }
}

async function call(db, payload, auth = manager) {
  const response = await handleAdminDirective({ DB: db }, 'task',
    { app: 'task', ...payload }, 'https://worker.example', auth, json);
  return { status: response.status, body: await response.json() };
}

function draft(overrides = {}) {
  return {
    action: 'save', directiveId: 'adr_request_001', expectedRevision: 0,
    title: '전체 선생님 안내', body: '오늘 수업 전 확인해 주세요.', priority: 'important',
    startsDate: today(), expiresDate: '', targetType: 'all', staffIds: [], ...overrides
  };
}

test('048 migration은 additive이고 신규 schema와 동일한 객체를 만든다', () => {
  assert.doesNotMatch(migration, /DROP TABLE|DELETE FROM/i);
  const fresh = new DatabaseSync(':memory:');
  const upgraded = new DatabaseSync(':memory:');
  fresh.exec(schema);
  upgraded.exec(schema.slice(0, schema.indexOf('-- 관리자가 여러 선생님에게 전달하는 공통 요청')));
  upgraded.exec(migration);
  const objects = database => database.prepare(
    "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name"
  ).all().filter(row => /admin_directive/.test(row.name)).map(row => ({ ...row,
    sql: row.sql.replace(/IF NOT EXISTS\s*/gi, '').replace(/\s+/g, '')
  }));
  assert.deepEqual(objects(upgraded), objects(fresh));
});

test('전체 대상은 현재 활성 선생님 staffId만 스냅샷하고 선생님별 확인을 독립 저장한다', async () => {
  const db = new TestD1(); seed(db);
  const saved = await call(db, draft());
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.revision.audienceStaffIds, ['teacher-a', 'teacher-b']);

  const ownA = await call(db, { action: 'list', view: 'own' }, teacher('teacher-a'));
  assert.equal(ownA.status, 200);
  assert.equal(ownA.body.revisions.length, 1);
  assert.equal(ownA.body.revisions[0].acknowledgedAt, null);
  assert.equal((await call(db, {
    action: 'acknowledge', directiveId: 'adr_request_001', revision: 1
  }, teacher('teacher-a'))).status, 200);

  const managed = await call(db, { action: 'list', view: 'manage' });
  const statuses = managed.body.revisions[0].audienceStatus;
  assert.ok(statuses.find(row => row.staffId === 'teacher-a').acknowledgedAt);
  assert.equal(statuses.find(row => row.staffId === 'teacher-b').acknowledgedAt, null);
});

test('수정은 새 revision을 만들고 이전 확인을 승계하지 않으며 지난 기록을 유지한다', async () => {
  const db = new TestD1(); seed(db);
  assert.equal((await call(db, draft())).status, 200);
  await call(db, { action: 'acknowledge', directiveId: 'adr_request_001', revision: 1 }, teacher('teacher-a'));
  const updated = await call(db, draft({ expectedRevision: 1, body: '수정된 새 요청입니다.',
    targetType: 'staff', staffIds: ['teacher-a'] }));
  assert.equal(updated.status, 200);
  assert.equal(updated.body.revision.revision, 2);
  assert.equal(updated.body.revision.acknowledgedAt, null);
  const own = await call(db, { action: 'list', view: 'own' }, teacher('teacher-a'));
  assert.deepEqual(own.body.revisions.map(row => row.revision), [2, 1]);
  assert.equal(own.body.revisions[0].displayStatus, 'active');
  assert.equal(own.body.revisions[1].displayStatus, 'superseded');
  const stale = await call(db, draft({ expectedRevision: 1, body: '오래된 화면 저장' }));
  assert.equal(stale.status, 409);
});

test('선택 대상 외 직원은 조회·확인할 수 없고 종료 후에도 이력은 남는다', async () => {
  const db = new TestD1(); seed(db);
  assert.equal((await call(db, draft({ targetType: 'staff', staffIds: ['teacher-a'] }))).status, 200);
  assert.equal((await call(db, { action: 'list', view: 'own' }, teacher('teacher-b'))).body.revisions.length, 0);
  assert.equal((await call(db, {
    action: 'opened', directiveId: 'adr_request_001', revision: 1
  }, teacher('teacher-b'))).status, 403);
  assert.equal((await call(db, {
    action: 'end', directiveId: 'adr_request_001', expectedRevision: 1
  })).status, 200);
  const own = await call(db, { action: 'list', view: 'own' }, teacher('teacher-a'));
  assert.equal(own.body.revisions[0].displayStatus, 'ended');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM admin_directive_revisions').first().count, 1);
});

test('Worker 경로는 인증을 거치며 개인 링크와 관리자 권한을 구분한다', async () => {
  const db = new TestD1(); seed(db);
  const invoke = async payload => {
    const response = await worker.fetch(new Request('https://worker.example/admin-directive', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: 'task', ...payload })
    }), { DB: db, TASK_ADMIN_SECRET: 'director-secret' });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await invoke(draft())).status, 401);
  assert.equal((await invoke({ ...draft(), auth: { mode: 'admin', secret: 'director-secret' } })).status, 200);
  assert.equal((await invoke({ action: 'list', view: 'own',
    auth: { mode: 'person', id: 'teacher-a', token: 'tok-teacher-a' } })).status, 200);
});
