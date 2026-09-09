import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import worker from './worker-core.js';
import { handleOpsRequest } from './ops-request.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/073_ops_requests.sql', import.meta.url), 'utf8');
const workerSource = fs.readFileSync(new URL('./worker-core.js', import.meta.url), 'utf8');

const STAFF_SQL = `
CREATE TABLE staff (
  app TEXT NOT NULL,
  id TEXT NOT NULL,
  owner TEXT,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  srv_at INTEGER NOT NULL,
  PRIMARY KEY (app,id)
);
`;

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

// 마이그레이션 SQL을 실제로 실행해 문법을 검증한다. D1 batch처럼 한 transaction으로 묶는다.
class TestD1 {
  constructor(ready = true, fullSchema = false) {
    this.database = new DatabaseSync(':memory:');
    if (fullSchema) this.database.exec(schema);
    else { this.database.exec(STAFF_SQL); if (ready) this.database.exec(migration); }
  }
  prepare(sql) { return new Statement(this.database, sql); }
  batch(statements) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => statement.run());
      this.database.exec('COMMIT');
      return Promise.resolve(results);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

const staff = id => ({ scope: 'own', id });
const manager = id => ({ scope: 'all', id, role: 'manager' });
const director = { scope: 'all' };
const json = (body, status) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' }
});

function putStaff(db, id, data = {}) {
  const now = Date.now();
  db.database.prepare('INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .run('task', id, id, JSON.stringify({ id, name: id, deleted: false, ...data }), now, now);
}

function seed(db) {
  putStaff(db, 'teacher-a');
  putStaff(db, 'teacher-b');
  putStaff(db, 'ops-staff');
  putStaff(db, 'manager-a');
  putStaff(db, 'staff-gone', { deleted: true });
}

async function call(db, payload, auth = staff('teacher-a'), app = 'task') {
  const response = await handleOpsRequest({ DB: db }, app, { app, ...payload },
    'https://worker.example', auth, json);
  return { status: response.status, body: await response.json() };
}

function createBody(overrides = {}) {
  return {
    action: 'create', reqType: 'account', program: 'studyforce', targetRef: 'SF-012',
    neededBy: '2026-09-15', detail: '스터디포스 계정 발급 부탁드립니다', ...overrides
  };
}

async function created(db, overrides = {}, auth = staff('teacher-a')) {
  const result = await call(db, createBody(overrides), auth);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.request;
}

async function move(db, request, action, auth, extra = {}) {
  return call(db, { action, id: request.id, expectedUpdatedAt: request.updatedAt, ...extra }, auth);
}

async function atNow(value, action) {
  const original = Date.now;
  Date.now = () => value;
  try { return await action(); } finally { Date.now = original; }
}

function eventRows(db, requestId) {
  return db.database.prepare(
    'SELECT actor_id,action,from_status,to_status,created_at FROM ops_request_events WHERE request_id=? ORDER BY created_at,rowid'
  ).all(requestId);
}

function objectNames(database) {
  return database.prepare(
    "SELECT type,name FROM sqlite_master WHERE name LIKE '%ops_request%' ORDER BY type,name"
  ).all().map(row => row.type + ':' + row.name);
}

test('073 마이그레이션과 schema.sql이 같은 ops_requests 구조를 만든다', () => {
  const fresh = new DatabaseSync(':memory:');
  fresh.exec(schema);
  const upgraded = new DatabaseSync(':memory:');
  upgraded.exec(STAFF_SQL);
  upgraded.exec(migration);
  upgraded.exec(migration); // IF NOT EXISTS라 두 번 적용해도 실패하지 않는다
  const names = objectNames(upgraded);
  assert.deepEqual(objectNames(fresh), names);
  for (const name of ['table:ops_requests', 'table:ops_request_events',
    'index:idx_ops_requests_assignee_status', 'index:idx_ops_requests_owner',
    'trigger:trg_ops_requests_update_guard', 'trigger:trg_ops_requests_no_delete',
    'trigger:trg_ops_request_events_no_update', 'trigger:trg_ops_request_events_no_delete']) {
    assert.ok(names.includes(name), name);
  }
});

test('worker-core는 /ops-request를 인증 뒤 핸들러로 연결한다', async () => {
  assert.match(workerSource, /import \{ handleOpsRequest \} from '\.\/ops-request\.js';/);
  assert.ok(workerSource.includes("url.pathname === '/ops-request'"));
  const db = new TestD1(true, true);
  seed(db);
  const env = { DB: db, TASK_ADMIN_SECRET: 'admin-secret', CONSULT_ADMIN_SECRET: 'consult-secret' };
  const post = async payload => {
    const response = await worker.fetch(new Request('https://worker.example/ops-request', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
    }), env);
    return { status: response.status, body: await response.json() };
  };
  const unauthenticated = await post({ app: 'task', auth: { mode: 'admin', secret: 'wrong' }, action: 'list' });
  assert.equal(unauthenticated.status, 401);
  const admin = await post({
    app: 'task', auth: { mode: 'admin', secret: 'admin-secret' }, ...createBody({ via: 'kakao' })
  });
  assert.equal(admin.status, 200);
  assert.equal(admin.body.request.ownerId, 'admin');
  assert.equal(admin.body.request.via, 'kakao');
  const listed = await post({ app: 'task', auth: { mode: 'admin', secret: 'admin-secret' }, action: 'list' });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.role, 'admin');
  assert.equal(listed.body.requests.length, 1);
});

test('staff는 create 뒤 자기 요청만 보고, 다른 staff는 못 보며, admin은 전체를 본다', async () => {
  const db = new TestD1(); seed(db);
  const before = Date.now();
  const first = await created(db);
  const after = Date.now();
  assert.deepEqual(Object.keys(first).sort(), ['acceptedAt', 'assigneeId', 'createdAt', 'detail', 'doneAt',
    'id', 'neededBy', 'ownerId', 'program', 'reqType', 'resultNote', 'resultUrl', 'status', 'targetRef',
    'updatedAt', 'via'].sort());
  assert.match(first.id, /^opr_[A-Za-z0-9_-]{4,76}$/);
  assert.deepEqual({
    reqType: first.reqType, program: first.program, targetRef: first.targetRef, ownerId: first.ownerId,
    assigneeId: first.assigneeId, via: first.via, neededBy: first.neededBy, status: first.status,
    resultNote: first.resultNote, resultUrl: first.resultUrl, acceptedAt: first.acceptedAt, doneAt: first.doneAt
  }, {
    reqType: 'account', program: 'studyforce', targetRef: 'SF-012', ownerId: 'teacher-a', assigneeId: null,
    via: 'app', neededBy: '2026-09-15', status: 'requested', resultNote: null, resultUrl: null,
    acceptedAt: null, doneAt: null
  });
  assert.ok(first.createdAt >= before && first.createdAt <= after);
  assert.equal(first.updatedAt, first.createdAt);

  await created(db, { reqType: 'worksheet', program: 'exam4you', targetRef: null, neededBy: null,
    detail: '중간고사 대비 문제지 3세트' });
  await created(db, { detail: '클래스카드 세트 배정', program: 'classcard' }, staff('teacher-b'));

  const mine = await call(db, { action: 'list' }, staff('teacher-a'));
  assert.equal(mine.status, 200);
  assert.deepEqual([mine.body.role, mine.body.viewerId], ['staff', 'teacher-a']);
  assert.deepEqual(mine.body.requests.map(row => row.ownerId), ['teacher-a', 'teacher-a']);
  assert.ok(mine.body.requests[0].updatedAt >= mine.body.requests[1].updatedAt);

  const other = await call(db, { action: 'list' }, staff('teacher-b'));
  assert.deepEqual(other.body.requests.map(row => row.ownerId), ['teacher-b']);
  const outsider = await call(db, { action: 'list' }, staff('ops-staff'));
  assert.deepEqual(outsider.body.requests, []);

  const all = await call(db, { action: 'list' }, director);
  assert.equal(all.body.role, 'admin');
  assert.equal(all.body.requests.length, 3);
  const byManager = await call(db, { action: 'list' }, manager('manager-a'));
  assert.deepEqual(byManager.body.requests, all.body.requests);
  assert.deepEqual(byManager.body.viewerId, 'manager-a');

  assert.deepEqual(eventRows(db, first.id).map(row => [row.actor_id, row.action, row.from_status, row.to_status]),
    [['teacher-a', 'create', null, 'requested']]);
  assert.equal(db.database.prepare('SELECT COUNT(*) count FROM ops_request_events').get().count, 3);
});

test('admin assign → assignee accept → start → done, resultUrl은 https만, 이벤트는 append-only로 누적된다', async () => {
  const db = new TestD1(); seed(db);
  const request = await created(db);

  const staffAssign = await move(db, request, 'assign', staff('teacher-a'), { assigneeId: 'ops-staff' });
  assert.equal(staffAssign.status, 403);
  assert.equal(staffAssign.body.code, 'OPS_FORBIDDEN');
  const goneAssign = await move(db, request, 'assign', manager('manager-a'), { assigneeId: 'staff-gone' });
  assert.equal(goneAssign.status, 400);
  assert.equal(goneAssign.body.code, 'OPS_ASSIGNEE');

  const assigned = await move(db, request, 'assign', manager('manager-a'), { assigneeId: 'ops-staff' });
  assert.equal(assigned.status, 200);
  assert.deepEqual([assigned.body.request.status, assigned.body.request.assigneeId], ['requested', 'ops-staff']);
  assert.ok(assigned.body.request.updatedAt > request.updatedAt);
  assert.equal(assigned.body.request.ownerId, 'teacher-a');

  const inbox = await call(db, { action: 'list' }, staff('ops-staff'));
  assert.deepEqual(inbox.body.requests.map(row => row.id), [request.id]);

  const wrongStart = await move(db, assigned.body.request, 'start', staff('ops-staff'));
  assert.equal(wrongStart.status, 409);
  assert.equal(wrongStart.body.code, 'OPS_TRANSITION');
  assert.equal(wrongStart.body.current.status, 'requested');

  const accepted = await move(db, assigned.body.request, 'accept', staff('ops-staff'));
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.request.status, 'accepted');
  assert.ok(accepted.body.request.acceptedAt >= request.createdAt);

  const started = await move(db, accepted.body.request, 'start', staff('ops-staff'));
  assert.equal(started.body.request.status, 'in_progress');

  const httpUrl = await move(db, started.body.request, 'done', staff('ops-staff'),
    { resultUrl: 'http://example.com/result' });
  assert.equal(httpUrl.status, 400);
  assert.equal(httpUrl.body.code, 'OPS_URL');
  const credUrl = await move(db, started.body.request, 'done', staff('ops-staff'),
    { resultUrl: 'https://user:pw@example.com/result' });
  assert.equal(credUrl.body.code, 'OPS_URL');
  const earlyUrl = await move(db, started.body.request, 'block', staff('ops-staff'),
    { resultUrl: 'https://example.com/result' });
  assert.equal(earlyUrl.body.code, 'OPS_URL');

  const done = await move(db, started.body.request, 'done', staff('ops-staff'),
    { resultUrl: 'https://drive.google.com/file/d/abc', resultNote: '계정 4개 발급 완료' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual([done.body.request.status, done.body.request.resultUrl, done.body.request.resultNote],
    ['done', 'https://drive.google.com/file/d/abc', '계정 4개 발급 완료']);
  assert.ok(done.body.request.doneAt >= accepted.body.request.acceptedAt);
  assert.equal(done.body.request.ownerId, 'teacher-a');

  const afterDone = await move(db, done.body.request, 'start', director);
  assert.equal(afterDone.status, 409);
  assert.equal(afterDone.body.code, 'OPS_TRANSITION');

  assert.deepEqual(eventRows(db, request.id).map(row => [row.actor_id, row.action, row.from_status, row.to_status]), [
    ['teacher-a', 'create', null, 'requested'],
    ['manager-a', 'assign', 'requested', 'requested'],
    ['ops-staff', 'accept', 'requested', 'accepted'],
    ['ops-staff', 'start', 'accepted', 'in_progress'],
    ['ops-staff', 'done', 'in_progress', 'done']
  ]);
  assert.throws(() => db.database.prepare('UPDATE ops_request_events SET actor_id=? WHERE request_id=?')
    .run('x', request.id), /OPS_REQUEST_EVENT_APPEND_ONLY/);
  assert.throws(() => db.database.prepare('DELETE FROM ops_request_events WHERE request_id=?')
    .run(request.id), /OPS_REQUEST_EVENT_APPEND_ONLY/);
  assert.throws(() => db.database.prepare('DELETE FROM ops_requests WHERE request_id=?')
    .run(request.id), /OPS_REQUEST_APPEND_ONLY/);
  assert.throws(() => db.database.prepare('UPDATE ops_requests SET owner_id=?, updated_at=updated_at+1 WHERE request_id=?')
    .run('teacher-b', request.id), /OPS_REQUEST_IMMUTABLE_FIELDS/);
});

test('block/unblock은 assignee만, 사유는 resultNote에 남고 done이 안 보내면 이전 메모를 지킨다', async () => {
  const db = new TestD1(); seed(db);
  const request = await created(db);
  const assigned = (await move(db, request, 'assign', director, { assigneeId: 'ops-staff' })).body.request;
  const otherBlock = await move(db, assigned, 'block', staff('teacher-b'), { resultNote: '남의 요청' });
  assert.equal(otherBlock.status, 403);
  const ownerBlock = await move(db, assigned, 'block', staff('teacher-a'), { resultNote: '내 요청이지만 담당 아님' });
  assert.equal(ownerBlock.status, 403);

  const blocked = await move(db, assigned, 'block', staff('ops-staff'), { resultNote: '관리자 계정 승인 대기' });
  assert.equal(blocked.status, 200);
  assert.deepEqual([blocked.body.request.status, blocked.body.request.resultNote], ['blocked', '관리자 계정 승인 대기']);
  const unblocked = await move(db, blocked.body.request, 'unblock', staff('ops-staff'));
  assert.equal(unblocked.body.request.status, 'in_progress');
  const reblocked = await move(db, unblocked.body.request, 'block', director);
  assert.equal(reblocked.body.request.status, 'blocked');
  const done = await move(db, reblocked.body.request, 'done', staff('ops-staff'));
  assert.deepEqual([done.body.request.status, done.body.request.resultNote], ['done', '관리자 계정 승인 대기']);
  assert.deepEqual(eventRows(db, request.id).map(row => row.action),
    ['create', 'assign', 'block', 'unblock', 'block', 'done']);
});

test('cancel은 owner 또는 admin만, requested에서만 된다', async () => {
  const db = new TestD1(); seed(db);
  const request = await created(db);
  const byOther = await move(db, request, 'cancel', staff('teacher-b'));
  assert.equal(byOther.status, 403);
  assert.equal(byOther.body.code, 'OPS_FORBIDDEN');
  const assigned = (await move(db, request, 'assign', director, { assigneeId: 'ops-staff' })).body.request;
  const byAssignee = await move(db, assigned, 'cancel', staff('ops-staff'));
  assert.equal(byAssignee.status, 403);

  const cancelled = await move(db, assigned, 'cancel', staff('teacher-a'), { resultNote: '학생이 다른 반으로' });
  assert.equal(cancelled.status, 200);
  assert.deepEqual([cancelled.body.request.status, cancelled.body.request.ownerId], ['cancelled', 'teacher-a']);
  const again = await move(db, cancelled.body.request, 'cancel', director);
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'OPS_TRANSITION');

  const second = await created(db);
  const accepted = (await move(db, (await move(db, second, 'assign', director, { assigneeId: 'ops-staff' })).body.request,
    'accept', staff('ops-staff'))).body.request;
  const lateCancel = await move(db, accepted, 'cancel', staff('teacher-a'));
  assert.equal(lateCancel.status, 409);
  const adminCancel = await move(db, second, 'cancel', director);
  assert.equal(adminCancel.status, 409);
  assert.equal(adminCancel.body.code, 'OPS_STALE');
  // 전이 형태는 두 가지 모두 받는다
  const viaTransition = await call(db, {
    action: 'transition', transition: 'cancel', id: (await created(db)).id, expectedUpdatedAt: 0
  }, director);
  assert.equal(viaTransition.body.code, 'OPS_STALE');
});

test('CAS: expectedUpdatedAt이 다르면 409 OPS_STALE와 현재 행을 돌려주고, 같은 ms 갱신도 updatedAt이 커진다', async () => {
  const db = new TestD1(); seed(db);
  const request = await created(db);
  const stale = await call(db, { action: 'assign', id: request.id, expectedUpdatedAt: request.updatedAt - 1,
    assigneeId: 'ops-staff' }, director);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'OPS_STALE');
  assert.equal(stale.body.current.updatedAt, request.updatedAt);
  assert.equal(stale.body.current.assigneeId, null);
  const missing = await call(db, { action: 'assign', id: request.id, assigneeId: 'ops-staff' }, director);
  assert.equal(missing.status, 400);

  const fixed = request.updatedAt;
  const assigned = await atNow(fixed, () => move(db, request, 'assign', director, { assigneeId: 'ops-staff' }));
  assert.equal(assigned.status, 200);
  assert.equal(assigned.body.request.updatedAt, fixed + 1);
  const raced = await atNow(fixed, () => move(db, request, 'assign', director, { assigneeId: 'teacher-b' }));
  assert.equal(raced.status, 409);
  assert.equal(raced.body.code, 'OPS_STALE');
  assert.deepEqual([raced.body.current.assigneeId, raced.body.current.updatedAt], ['ops-staff', fixed + 1]);
  const accepted = await atNow(fixed, () => move(db, assigned.body.request, 'accept', staff('ops-staff')));
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.request.updatedAt, fixed + 2);
  assert.equal(accepted.body.request.acceptedAt, fixed + 2);
  assert.equal(db.database.prepare('SELECT COUNT(*) count FROM ops_request_events WHERE request_id=?')
    .get(request.id).count, 3);

  const notFound = await call(db, { action: 'accept', id: 'opr_missing_0001', expectedUpdatedAt: 1 }, director);
  assert.equal(notFound.status, 404);
});

test('create 검증: PII detail·targetRef 400, 불법 targetRef 400, 어휘·날짜·길이·담당자 검증', async () => {
  const db = new TestD1(); seed(db);
  const expect = async (overrides, code, auth = staff('teacher-a')) => {
    const result = await call(db, createBody(overrides), auth);
    assert.equal(result.status, code === 'OPS_FORBIDDEN' ? 403 : 400, JSON.stringify(result.body));
    assert.equal(result.body.code, code);
  };
  await expect({ detail: '김OO 어머니 010-1234-5678로 연락' }, 'OPS_PII');
  await expect({ detail: '연락처 01012345678' }, 'OPS_PII');
  await expect({ detail: '학원 02-123-4567' }, 'OPS_PII');
  await expect({ detail: 'parent@example.com 으로 발송' }, 'OPS_PII');
  await expect({ detail: '주민번호 900101-1234567' }, 'OPS_PII');
  await expect({ targetRef: '01012345678' }, 'OPS_PII');
  await expect({ targetRef: '김철수' }, 'OPS_TARGET');
  await expect({ targetRef: 'SF-12' }, 'OPS_TARGET');
  await expect({ targetRef: 'a b' }, 'OPS_TARGET');
  await expect({ reqType: 'material' }, 'OPS_INVALID');
  await expect({ program: 'leaders' }, 'OPS_INVALID');
  await expect({ neededBy: '2026-02-30' }, 'OPS_INVALID');
  await expect({ neededBy: '20260915' }, 'OPS_INVALID');
  await expect({ detail: '   ' }, 'OPS_DETAIL');
  await expect({ detail: '가'.repeat(301) }, 'OPS_DETAIL');
  await expect({ detail: 12 }, 'OPS_DETAIL');
  await expect({ assigneeId: 'ops-staff' }, 'OPS_FORBIDDEN');
  await expect({ assigneeId: 'staff-gone' }, 'OPS_ASSIGNEE', director);
  await expect({ assigneeId: 'nobody' }, 'OPS_ASSIGNEE', director);
  await expect({ via: 'auto' }, 'OPS_INVALID', director);
  await expect({ id: 'bad id' }, 'OPS_INVALID');
  assert.equal(db.database.prepare('SELECT COUNT(*) count FROM ops_requests').get().count, 0);

  // 정상: 날짜·SF 코드·학생 ID·숫자는 PII로 오탐하지 않고, 한 줄로 정규화해 저장한다
  const okDetail = await created(db, { detail: ' SF-012 계정  \r\n 2026-09-10까지 \t12명 ', targetRef: '12345678' });
  assert.equal(okDetail.detail, 'SF-012 계정 2026-09-10까지 12명');
  assert.equal(okDetail.targetRef, '12345678');
  const staffKakao = await created(db, { via: 'kakao' });
  assert.equal(staffKakao.via, 'app');
  const adminKakao = await created(db, { via: 'kakao', assigneeId: 'ops-staff' }, manager('manager-a'));
  assert.deepEqual([adminKakao.via, adminKakao.ownerId, adminKakao.assigneeId], ['kakao', 'manager-a', 'ops-staff']);
  const secretAdmin = await created(db, {}, director);
  assert.equal(secretAdmin.ownerId, 'admin');
});

test('transition 검증: resultNote PII 400, 잘못된 메모 400, 모르는 action 400', async () => {
  const db = new TestD1(); seed(db);
  const request = await created(db);
  const assigned = (await move(db, request, 'assign', director, { assigneeId: 'ops-staff' })).body.request;
  const pii = await move(db, assigned, 'block', staff('ops-staff'), { resultNote: '학부모 010-9999-8888 통화 필요' });
  assert.equal(pii.status, 400);
  assert.equal(pii.body.code, 'OPS_PII');
  const tooLong = await move(db, assigned, 'block', staff('ops-staff'), { resultNote: '가'.repeat(301) });
  assert.equal(tooLong.body.code, 'OPS_DETAIL');
  const unknown = await call(db, { action: 'approve', id: request.id, expectedUpdatedAt: request.updatedAt }, director);
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, 'OPS_INVALID');
  const unknownTransition = await call(db, { action: 'transition', transition: 'approve', id: request.id,
    expectedUpdatedAt: request.updatedAt }, director);
  assert.equal(unknownTransition.status, 400);
  assert.equal((await call(db, { action: 'list' }, director)).body.requests[0].status, 'requested');
  assert.equal(db.database.prepare('SELECT COUNT(*) count FROM ops_request_events').get().count, 2);
});

test('같은 id 재전송은 새 행을 만들지 않고, 남의 id는 409', async () => {
  const db = new TestD1(); seed(db);
  // 같은 ms 안의 재전송에서도 이벤트가 한 번만 남아야 한다(직전 INSERT의 changes() guard)
  const fixed = Date.now();
  const first = await atNow(fixed, () => call(db, createBody({ id: 'opr_client_0001' })));
  assert.equal(first.status, 200);
  assert.equal(first.body.idempotent, undefined);
  const retry = await atNow(fixed, () => call(db, createBody({ id: 'opr_client_0001' })));
  assert.equal(retry.status, 200);
  assert.equal(retry.body.idempotent, true);
  assert.equal(retry.body.request.createdAt, first.body.request.createdAt);
  const stolen = await call(db, createBody({ id: 'opr_client_0001' }), staff('teacher-b'));
  assert.equal(stolen.status, 409);
  assert.equal(stolen.body.code, 'OPS_ID_CONFLICT');
  assert.equal(db.database.prepare('SELECT COUNT(*) count FROM ops_requests').get().count, 1);
  assert.equal(db.database.prepare('SELECT COUNT(*) count FROM ops_request_events').get().count, 1);
});

test('app이 task가 아니면 400, 테이블 미준비 503, 인증 형태가 이상하면 403', async () => {
  const db = new TestD1(); seed(db);
  assert.equal((await call(db, { action: 'list' }, staff('teacher-a'), 'consult')).status, 400);
  const notReady = await call(new TestD1(false), { action: 'list' });
  assert.equal(notReady.status, 503);
  assert.equal(notReady.body.code, 'OPS_REQUEST_NOT_READY');
  assert.equal((await call(db, { action: 'list' }, { scope: 'own', id: 'bad id' })).status, 403);
  assert.equal((await call(db, { action: 'list' }, null)).status, 403);
});
