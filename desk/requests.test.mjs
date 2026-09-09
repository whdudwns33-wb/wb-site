// sync/ops-request.test.mjs(01a73cb)의 케이스를 desk 역할 모델({role, staffId})로 옮긴 것.
// 마이그레이션 SQL 을 실제로 실행해 트리거·CHECK 까지 같이 검증한다. 학생은 SF 코드·자리표시 id 만 쓴다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { handleRequests } from './requests.mjs';

const migration = fs.readFileSync(new URL('./migrations/001_desk.sql', import.meta.url), 'utf8');

class Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  async first() { return this.database.prepare(this.sql).get(...this.args) || null; }
  async all() { return { results: this.database.prepare(this.sql).all(...this.args) }; }
  async run() { return this.runSync(); }
  runSync() {
    const result = this.database.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(result.changes || 0) } };
  }
}

// D1 batch 처럼 한 transaction 으로 묶는다 — changes() 가드가 이를 전제한다.
class TestD1 {
  constructor(ready = true) {
    this.database = new DatabaseSync(':memory:');
    if (ready) this.database.exec(migration);
    else this.database.exec(migration.slice(0, migration.indexOf('CREATE TABLE IF NOT EXISTS desk_requests')));
  }
  prepare(sql) { return new Statement(this.database, sql); }
  async batch(statements) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => statement.runSync());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

const staff = id => ({ role: 'staff', staffId: id });
const director = { role: 'admin', staffId: 'admin' };

function putStaff(db, id, active = 1) {
  const now = Date.now();
  db.database.prepare('INSERT INTO desk_staff(id,name,role,active,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(id, id, 'staff', active, now, now);
}

function seed(db) {
  putStaff(db, 'teacher-a');
  putStaff(db, 'teacher-b');
  putStaff(db, 'ops-staff');
  putStaff(db, 'staff-gone', 0);
}

async function call(db, payload, auth = staff('teacher-a')) {
  const response = await handleRequests(payload, { DB: db }, auth);
  return { status: response.status, headers: response.headers, body: await response.json() };
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
    'SELECT actor_id,action,from_status,to_status,created_at FROM desk_request_events WHERE request_id=? ORDER BY created_at,rowid'
  ).all(requestId);
}

test('마이그레이션은 두 번 적용해도 되고 요청 원장 표·인덱스·트리거를 만든다', () => {
  const db = new TestD1();
  db.database.exec(migration);
  const names = db.database.prepare(
    "SELECT type||':'||name AS n FROM sqlite_master WHERE name LIKE '%desk_request%' ORDER BY n"
  ).all().map(row => row.n);
  for (const name of ['table:desk_requests', 'table:desk_request_events',
    'index:idx_desk_requests_assignee_status', 'index:idx_desk_requests_owner', 'index:idx_desk_request_events_request',
    'trigger:trg_desk_requests_update_guard', 'trigger:trg_desk_requests_no_delete',
    'trigger:trg_desk_request_events_no_update', 'trigger:trg_desk_request_events_no_delete']) {
    assert.ok(names.includes(name), name);
  }
});

test('staff 는 create 뒤 자기 요청만 보고, 다른 staff 는 못 보며, admin 은 전체를 본다', async () => {
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
  assert.equal(mine.headers.get('cache-control'), 'no-store');
  assert.deepEqual([mine.body.role, mine.body.viewerId], ['staff', 'teacher-a']);
  assert.deepEqual(mine.body.requests.map(row => row.ownerId), ['teacher-a', 'teacher-a']);
  assert.ok(mine.body.requests[0].updatedAt >= mine.body.requests[1].updatedAt);

  const other = await call(db, { action: 'list' }, staff('teacher-b'));
  assert.deepEqual(other.body.requests.map(row => row.ownerId), ['teacher-b']);
  const outsider = await call(db, { action: 'list' }, staff('ops-staff'));
  assert.deepEqual(outsider.body.requests, []);

  const all = await call(db, { action: 'list' }, director);
  assert.deepEqual([all.body.role, all.body.viewerId, all.body.requests.length], ['admin', 'admin', 3]);
  // action 을 생략하면 list
  assert.equal((await call(db, {}, director)).body.requests.length, 3);

  assert.deepEqual(eventRows(db, first.id).map(row => [row.actor_id, row.action, row.from_status, row.to_status]),
    [['teacher-a', 'create', null, 'requested']]);
  assert.equal(db.database.prepare('SELECT COUNT(*) count FROM desk_request_events').get().count, 3);
});

test('admin assign → assignee accept → start → done, resultUrl 은 https 만, 이벤트는 append-only 로 누적된다', async () => {
  const db = new TestD1(); seed(db);
  const request = await created(db);

  const staffAssign = await move(db, request, 'assign', staff('teacher-a'), { assigneeId: 'ops-staff' });
  assert.deepEqual([staffAssign.status, staffAssign.body.code], [403, 'OPS_FORBIDDEN']);
  const goneAssign = await move(db, request, 'assign', director, { assigneeId: 'staff-gone' });
  assert.deepEqual([goneAssign.status, goneAssign.body.code], [400, 'OPS_ASSIGNEE']);

  const assigned = await move(db, request, 'assign', director, { assigneeId: 'ops-staff' });
  assert.equal(assigned.status, 200);
  assert.deepEqual([assigned.body.request.status, assigned.body.request.assigneeId], ['requested', 'ops-staff']);
  assert.ok(assigned.body.request.updatedAt > request.updatedAt);
  assert.equal(assigned.body.request.ownerId, 'teacher-a');

  const inbox = await call(db, { action: 'list' }, staff('ops-staff'));
  assert.deepEqual(inbox.body.requests.map(row => row.id), [request.id]);

  const wrongStart = await move(db, assigned.body.request, 'start', staff('ops-staff'));
  assert.deepEqual([wrongStart.status, wrongStart.body.code, wrongStart.body.current.status], [409, 'OPS_TRANSITION', 'requested']);

  const accepted = await move(db, assigned.body.request, 'accept', staff('ops-staff'));
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.request.status, 'accepted');
  assert.ok(accepted.body.request.acceptedAt >= request.createdAt);

  const started = await move(db, accepted.body.request, 'start', staff('ops-staff'));
  assert.equal(started.body.request.status, 'in_progress');

  const httpUrl = await move(db, started.body.request, 'done', staff('ops-staff'), { resultUrl: 'http://example.com/result' });
  assert.deepEqual([httpUrl.status, httpUrl.body.code], [400, 'OPS_URL']);
  const credUrl = await move(db, started.body.request, 'done', staff('ops-staff'), { resultUrl: 'https://user:pw@example.com/result' });
  assert.equal(credUrl.body.code, 'OPS_URL');
  const earlyUrl = await move(db, started.body.request, 'block', staff('ops-staff'), { resultUrl: 'https://example.com/result' });
  assert.equal(earlyUrl.body.code, 'OPS_URL');

  const done = await move(db, started.body.request, 'done', staff('ops-staff'),
    { resultUrl: 'https://drive.google.com/file/d/abc', resultNote: '계정 4개 발급 완료' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual([done.body.request.status, done.body.request.resultUrl, done.body.request.resultNote],
    ['done', 'https://drive.google.com/file/d/abc', '계정 4개 발급 완료']);
  assert.ok(done.body.request.doneAt >= accepted.body.request.acceptedAt);

  const afterDone = await move(db, done.body.request, 'start', director);
  assert.deepEqual([afterDone.status, afterDone.body.code], [409, 'OPS_TRANSITION']);

  assert.deepEqual(eventRows(db, request.id).map(row => [row.actor_id, row.action, row.from_status, row.to_status]), [
    ['teacher-a', 'create', null, 'requested'],
    ['admin', 'assign', 'requested', 'requested'],
    ['ops-staff', 'accept', 'requested', 'accepted'],
    ['ops-staff', 'start', 'accepted', 'in_progress'],
    ['ops-staff', 'done', 'in_progress', 'done']
  ]);
  assert.throws(() => db.database.prepare('UPDATE desk_request_events SET actor_id=? WHERE request_id=?')
    .run('x', request.id), /OPS_REQUEST_EVENT_APPEND_ONLY/);
  assert.throws(() => db.database.prepare('DELETE FROM desk_request_events WHERE request_id=?')
    .run(request.id), /OPS_REQUEST_EVENT_APPEND_ONLY/);
  assert.throws(() => db.database.prepare('DELETE FROM desk_requests WHERE request_id=?')
    .run(request.id), /OPS_REQUEST_APPEND_ONLY/);
  assert.throws(() => db.database.prepare('UPDATE desk_requests SET owner_id=?, updated_at=updated_at+1 WHERE request_id=?')
    .run('teacher-b', request.id), /OPS_REQUEST_IMMUTABLE_FIELDS/);
});

test('block/unblock 은 assignee 만, 사유는 resultNote 에 남고 done 이 안 보내면 이전 메모를 지킨다', async () => {
  const db = new TestD1(); seed(db);
  const request = await created(db);
  const assigned = (await move(db, request, 'assign', director, { assigneeId: 'ops-staff' })).body.request;
  assert.equal((await move(db, assigned, 'block', staff('teacher-b'), { resultNote: '남의 요청' })).status, 403);
  assert.equal((await move(db, assigned, 'block', staff('teacher-a'), { resultNote: '내 요청이지만 담당 아님' })).status, 403);

  const blocked = await move(db, assigned, 'block', staff('ops-staff'), { resultNote: '관리자 계정 승인 대기' });
  assert.equal(blocked.status, 200);
  assert.deepEqual([blocked.body.request.status, blocked.body.request.resultNote], ['blocked', '관리자 계정 승인 대기']);
  const unblocked = await move(db, blocked.body.request, 'unblock', staff('ops-staff'));
  assert.equal(unblocked.body.request.status, 'in_progress');
  const reblocked = await move(db, unblocked.body.request, 'block', director);
  assert.equal(reblocked.body.request.status, 'blocked');
  const done = await move(db, reblocked.body.request, 'done', staff('ops-staff'));
  assert.deepEqual([done.body.request.status, done.body.request.resultNote], ['done', '관리자 계정 승인 대기']);
  assert.deepEqual(eventRows(db, request.id).map(row => row.action), ['create', 'assign', 'block', 'unblock', 'block', 'done']);
});

test('cancel 은 owner 또는 admin 만, requested 에서만 된다', async () => {
  const db = new TestD1(); seed(db);
  const request = await created(db);
  const byOther = await move(db, request, 'cancel', staff('teacher-b'));
  assert.deepEqual([byOther.status, byOther.body.code], [403, 'OPS_FORBIDDEN']);
  const assigned = (await move(db, request, 'assign', director, { assigneeId: 'ops-staff' })).body.request;
  assert.equal((await move(db, assigned, 'cancel', staff('ops-staff'))).status, 403);

  const cancelled = await move(db, assigned, 'cancel', staff('teacher-a'), { resultNote: '학생이 다른 반으로' });
  assert.equal(cancelled.status, 200);
  assert.deepEqual([cancelled.body.request.status, cancelled.body.request.ownerId], ['cancelled', 'teacher-a']);
  const again = await move(db, cancelled.body.request, 'cancel', director);
  assert.deepEqual([again.status, again.body.code], [409, 'OPS_TRANSITION']);

  const second = await created(db);
  const accepted = (await move(db, (await move(db, second, 'assign', director, { assigneeId: 'ops-staff' })).body.request,
    'accept', staff('ops-staff'))).body.request;
  assert.equal((await move(db, accepted, 'cancel', staff('teacher-a'))).status, 409);
  const adminCancel = await move(db, second, 'cancel', director);
  assert.deepEqual([adminCancel.status, adminCancel.body.code], [409, 'OPS_STALE']);
  // 전이 형태는 두 가지 모두 받는다
  const viaTransition = await call(db, {
    action: 'transition', transition: 'cancel', id: (await created(db)).id, expectedUpdatedAt: 0
  }, director);
  assert.equal(viaTransition.body.code, 'OPS_STALE');
});

test('CAS: expectedUpdatedAt 이 다르면 409 OPS_STALE 와 현재 행을 돌려주고, 같은 ms 갱신도 updatedAt 이 커진다', async () => {
  const db = new TestD1(); seed(db);
  const request = await created(db);
  const stale = await call(db, { action: 'assign', id: request.id, expectedUpdatedAt: request.updatedAt - 1, assigneeId: 'ops-staff' }, director);
  assert.deepEqual([stale.status, stale.body.code, stale.body.current.updatedAt, stale.body.current.assigneeId],
    [409, 'OPS_STALE', request.updatedAt, null]);
  assert.equal((await call(db, { action: 'assign', id: request.id, assigneeId: 'ops-staff' }, director)).status, 400);

  const fixed = request.updatedAt;
  const assigned = await atNow(fixed, () => move(db, request, 'assign', director, { assigneeId: 'ops-staff' }));
  assert.equal(assigned.status, 200);
  assert.equal(assigned.body.request.updatedAt, fixed + 1);
  const raced = await atNow(fixed, () => move(db, request, 'assign', director, { assigneeId: 'teacher-b' }));
  assert.deepEqual([raced.status, raced.body.code, raced.body.current.assigneeId, raced.body.current.updatedAt],
    [409, 'OPS_STALE', 'ops-staff', fixed + 1]);
  const accepted = await atNow(fixed, () => move(db, assigned.body.request, 'accept', staff('ops-staff')));
  assert.deepEqual([accepted.status, accepted.body.request.updatedAt, accepted.body.request.acceptedAt], [200, fixed + 2, fixed + 2]);
  assert.equal(db.database.prepare('SELECT COUNT(*) count FROM desk_request_events WHERE request_id=?').get(request.id).count, 3);

  const notFound = await call(db, { action: 'accept', id: 'opr_missing_0001', expectedUpdatedAt: 1 }, director);
  assert.deepEqual([notFound.status, notFound.body.code], [404, 'OPS_NOT_FOUND']);
});

test('create 검증: PII detail·targetRef 400, 불법 targetRef 400, 어휘·날짜·길이·담당자 검증', async () => {
  const db = new TestD1(); seed(db);
  const expect = async (overrides, code, auth = staff('teacher-a')) => {
    const result = await call(db, createBody(overrides), auth);
    assert.equal(result.status, code === 'OPS_FORBIDDEN' ? 403 : 400, JSON.stringify(result.body));
    assert.equal(result.body.code, code);
  };
  await expect({ detail: '김OO 어머니 010-0000-0000로 연락' }, 'OPS_PII');
  await expect({ detail: '연락처 01000000000' }, 'OPS_PII');
  await expect({ detail: '학원 02-000-0000' }, 'OPS_PII');
  await expect({ detail: 'parent@example.com 으로 발송' }, 'OPS_PII');
  await expect({ detail: '주민번호 000000-1000000' }, 'OPS_PII');
  await expect({ targetRef: '01000000000' }, 'OPS_PII');
  await expect({ targetRef: '학생A' }, 'OPS_TARGET');
  await expect({ targetRef: 'SF-12' }, 'OPS_TARGET');
  await expect({ targetRef: 'a b' }, 'OPS_TARGET');
  await expect({ targetRef: 'a'.repeat(65) }, 'OPS_TARGET');
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
  assert.equal(db.database.prepare('SELECT COUNT(*) count FROM desk_requests').get().count, 0);

  // 정상: 날짜·SF 코드·학생 ID·숫자는 PII 로 오탐하지 않고, 한 줄로 정규화해 저장한다
  const okDetail = await created(db, { detail: ' SF-012 계정  ' + String.fromCharCode(13, 10) + ' 2026-09-10까지 ' + String.fromCharCode(9) + '12명 ', targetRef: 'stu_12345678' });
  assert.equal(okDetail.detail, 'SF-012 계정 2026-09-10까지 12명');
  assert.equal(okDetail.targetRef, 'stu_12345678');
  const staffKakao = await created(db, { via: 'kakao' });
  assert.equal(staffKakao.via, 'app');
  const adminKakao = await created(db, { via: 'kakao', assigneeId: 'ops-staff' }, director);
  assert.deepEqual([adminKakao.via, adminKakao.ownerId, adminKakao.assigneeId], ['kakao', 'admin', 'ops-staff']);
});

test('transition 검증: resultNote PII 400, 잘못된 메모 400, 모르는 action 400', async () => {
  const db = new TestD1(); seed(db);
  const request = await created(db);
  const assigned = (await move(db, request, 'assign', director, { assigneeId: 'ops-staff' })).body.request;
  const pii = await move(db, assigned, 'block', staff('ops-staff'), { resultNote: '학부모 010-0000-0000 통화 필요' });
  assert.deepEqual([pii.status, pii.body.code], [400, 'OPS_PII']);
  assert.equal((await move(db, assigned, 'block', staff('ops-staff'), { resultNote: '가'.repeat(301) })).body.code, 'OPS_DETAIL');
  const unknown = await call(db, { action: 'approve', id: request.id, expectedUpdatedAt: request.updatedAt }, director);
  assert.deepEqual([unknown.status, unknown.body.code], [400, 'OPS_INVALID']);
  const unknownTransition = await call(db, { action: 'transition', transition: 'approve', id: request.id, expectedUpdatedAt: request.updatedAt }, director);
  assert.equal(unknownTransition.status, 400);
  assert.equal((await call(db, { action: 'list' }, director)).body.requests[0].status, 'requested');
  assert.equal(db.database.prepare('SELECT COUNT(*) count FROM desk_request_events').get().count, 2);
});

test('같은 id 재전송은 새 행을 만들지 않고, 남의 id 는 409', async () => {
  const db = new TestD1(); seed(db);
  const fixed = Date.now();
  const first = await atNow(fixed, () => call(db, createBody({ id: 'opr_client_0001' })));
  assert.equal(first.status, 200);
  assert.equal(first.body.idempotent, undefined);
  const retry = await atNow(fixed, () => call(db, createBody({ id: 'opr_client_0001' })));
  assert.deepEqual([retry.status, retry.body.idempotent, retry.body.request.createdAt], [200, true, first.body.request.createdAt]);
  const stolen = await call(db, createBody({ id: 'opr_client_0001' }), staff('teacher-b'));
  assert.deepEqual([stolen.status, stolen.body.code], [409, 'OPS_ID_CONFLICT']);
  assert.equal(db.database.prepare('SELECT COUNT(*) count FROM desk_requests').get().count, 1);
  assert.equal(db.database.prepare('SELECT COUNT(*) count FROM desk_request_events').get().count, 1);
});

test('테이블 미준비 503, 인증 형태가 이상하면 403, Request 객체·비-JSON 본문도 처리한다', async () => {
  const db = new TestD1(); seed(db);
  const notReady = await call(new TestD1(false), { action: 'list' });
  assert.deepEqual([notReady.status, notReady.body.code], [503, 'OPS_REQUEST_NOT_READY']);
  assert.equal((await call(db, { action: 'list' }, { role: 'staff', staffId: 'bad id' })).status, 403);
  assert.equal((await call(db, { action: 'list' }, { scope: 'all' })).status, 403);
  assert.equal((await call(db, { action: 'list' }, null)).status, 403);

  const viaRequest = await handleRequests(new Request('https://desk.test/api/requests', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(createBody())
  }), { DB: db }, staff('teacher-a'));
  assert.equal(viaRequest.status, 200);
  const broken = await handleRequests(new Request('https://desk.test/api/requests', { method: 'POST', body: 'not json' }), { DB: db }, director);
  assert.deepEqual([broken.status, (await broken.json()).code], [400, 'OPS_INVALID']);
});
