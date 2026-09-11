// desk-api.mjs 를 node:sqlite 대역 위에서 직접 호출한다(sync/teacher-live-request.test.mjs 의 TestD1 방식).
// 마이그레이션 SQL 을 실제로 exec 해 문법·멱등성을 같이 검증한다. 학생·전화는 자리표시(학생A, 010-0000-0000)만 쓴다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { handleApi } from './desk-api.mjs';
import worker from './worker.mjs';

// 마이그레이션은 전부 순서대로 — 운영 배포가 매번 그렇게 적용한다(desk/README.md).
const migrationDir = new URL('./migrations/', import.meta.url);
const migration = fs.readdirSync(migrationDir).filter(n => n.endsWith('.sql')).sort()
  .map(n => fs.readFileSync(new URL(n, migrationDir), 'utf8')).join('\n');
const DAY = 24 * 60 * 60 * 1000;
const BASE = 'https://desk.test';
const PASSWORD = 'desk-password-1';

class Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.args = []; }
  // D1 은 BLOB 에 ArrayBuffer 를 받는다(문서 형식). node:sqlite 는 Uint8Array 만 받으므로 대역이 바꿔 준다.
  bind(...args) { this.args = args.map(a => (a instanceof ArrayBuffer ? new Uint8Array(a) : a)); return this; }
  async first() { return this.database.prepare(this.sql).get(...this.args) || null; }
  async all() { return { results: this.database.prepare(this.sql).all(...this.args) }; }
  async run() { return this.runSync(); }
  runSync() {
    const result = this.database.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(result.changes || 0) } };
  }
}

class TestD1 {
  constructor() {
    this.database = new DatabaseSync(':memory:');
    this.database.exec(migration);
    this.database.exec(migration); // 전부 IF NOT EXISTS 라 두 번 적용해도 실패하지 않는다
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

function envFor() { return { DB: new TestD1() }; }

async function call(env, method, path, options = {}) {
  const headers = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = 'Bearer ' + options.token;
  const response = await handleApi(new Request(BASE + path, {
    method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body)
  }), env, {});
  return { status: response.status, headers: response.headers, body: await response.json() };
}

async function setupAdmin(env) {
  const result = await call(env, 'POST', '/api/setup', { body: { password: PASSWORD } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.role, 'admin');
  return result.body.token;
}

async function makeStaff(env, adminToken, name) {
  const created = await call(env, 'POST', '/api/staff', { token: adminToken, body: { op: 'create', name } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const link = await call(env, 'POST', '/api/staff', { token: adminToken, body: { op: 'link', staffId: created.body.staff.id } });
  assert.equal(link.status, 200, JSON.stringify(link.body));
  const exchanged = await call(env, 'POST', '/api/link-exchange', { body: { code: link.body.code } });
  assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
  return { id: created.body.staff.id, name, token: exchanged.body.token, code: link.body.code };
}

async function atNow(value, action) {
  const original = Date.now;
  Date.now = () => value;
  try { return await action(); } finally { Date.now = original; }
}

async function putDoc(env, token, c, id, data, extra = {}) {
  return call(env, 'POST', '/api/docs', { token, body: { changes: [Object.assign({ c, id, data }, extra)] } });
}

function student(overrides = {}) {
  return Object.assign({
    name: '학생A', grade: '중2', code: 'SF-001', status: 'active', since: '2026-03',
    programs: { studyforce: { active: true, plan: '월 구독', since: '2026-03-01', account: 'issued' } },
    guardian: { relation: '모', phone: '010-0000-0000', consent: true }
  }, overrides);
}

test('마이그레이션은 멱등이고 표·인덱스·트리거를 만든다', () => {
  const db = new TestD1();
  const names = db.database.prepare("SELECT type||':'||name AS n FROM sqlite_master WHERE name LIKE 'desk_%' OR name LIKE 'idx_desk%' OR name LIKE 'trg_desk%' ORDER BY n")
    .all().map(row => row.n);
  for (const name of ['table:desk_admin', 'table:desk_staff', 'table:desk_codes', 'table:desk_tokens', 'table:desk_docs', 'table:desk_documents',
    'table:desk_requests', 'table:desk_request_events', 'index:idx_desk_docs_updated', 'index:idx_desk_documents_updated',
    'index:idx_desk_requests_assignee_status', 'index:idx_desk_requests_owner',
    'trigger:trg_desk_requests_update_guard', 'trigger:trg_desk_requests_no_delete',
    'trigger:trg_desk_request_events_no_update', 'trigger:trg_desk_request_events_no_delete']) {
    assert.ok(names.includes(name), name);
  }
  assert.throws(() => db.database.prepare('INSERT INTO desk_admin(id,password_salt,password_hash,password_iterations,created_at) VALUES(2,?,?,?,?)')
    .run('s', 'h', 100000, 1), /CHECK/);
});

test('health → setup(2회째 409) → login 성공·실패·잠금·해제', async () => {
  const env = envFor();
  const before = await call(env, 'GET', '/api/health');
  assert.deepEqual([before.status, before.body.ok, before.body.app, before.body.setup], [200, true, 'wb-desk', false]);
  assert.equal(before.headers.get('cache-control'), 'no-store');

  assert.equal((await call(env, 'POST', '/api/setup', { body: { password: 'short' } })).status, 400);
  assert.equal((await call(env, 'POST', '/api/login', { body: { password: PASSWORD } })).body.code, 'NOT_SETUP');
  const adminToken = await setupAdmin(env);
  assert.match(adminToken, /^[a-f0-9]{48}$/);
  const again = await call(env, 'POST', '/api/setup', { body: { password: 'another-password' } });
  assert.deepEqual([again.status, again.body.code], [409, 'ALREADY_SETUP']);
  assert.equal((await call(env, 'GET', '/api/health')).body.setup, true);

  const me = await call(env, 'GET', '/api/me', { token: adminToken });
  assert.deepEqual(me.body, { ok: true, role: 'admin', staffId: 'admin', name: '원장' });

  const wrong = await call(env, 'POST', '/api/login', { body: { password: 'wrong-password' } });
  assert.deepEqual([wrong.status, wrong.body.code], [401, 'LOGIN_FAILED']);
  const right = await call(env, 'POST', '/api/login', { body: { password: PASSWORD } });
  assert.equal(right.status, 200);
  assert.notEqual(right.body.token, adminToken);
  assert.ok(right.body.expiresAt > Date.now() + 29 * DAY);

  // 5회 실패 → 5분 잠금. 잠긴 동안은 맞는 비밀번호도 429.
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) {
    const miss = await atNow(t0, () => call(env, 'POST', '/api/login', { body: { password: 'wrong-' + i } }));
    assert.equal(miss.status, 401);
  }
  const locked = await atNow(t0 + 1000, () => call(env, 'POST', '/api/login', { body: { password: PASSWORD } }));
  assert.deepEqual([locked.status, locked.body.code], [429, 'LOGIN_LOCKED']);
  const released = await atNow(t0 + 5 * 60 * 1000 + 1, () => call(env, 'POST', '/api/login', { body: { password: PASSWORD } }));
  assert.equal(released.status, 200);
  // 4회 실패 뒤 성공하면 카운터가 초기화된다
  for (let i = 0; i < 4; i++) assert.equal((await call(env, 'POST', '/api/login', { body: { password: 'x' } })).status, 401);
  assert.equal((await call(env, 'POST', '/api/login', { body: { password: PASSWORD } })).status, 200);
  assert.equal((await call(env, 'POST', '/api/login', { body: { password: 'x' } })).status, 401);
  assert.equal((await call(env, 'POST', '/api/login', { body: { password: PASSWORD } })).status, 200);
});

test('직원 생성·링크 발급·교환(재사용·만료 불가)·me·비활성·revoke', async () => {
  const env = envFor();
  const adminToken = await setupAdmin(env);
  const created = await call(env, 'POST', '/api/staff', { token: adminToken, body: { op: 'create', name: '  직원  A ' } });
  assert.equal(created.status, 200);
  assert.match(created.body.staff.id, /^st_[a-z0-9]{12}$/);
  assert.deepEqual([created.body.staff.name, created.body.staff.role, created.body.staff.active], ['직원 A', 'staff', true]);
  assert.equal((await call(env, 'POST', '/api/staff', { token: adminToken, body: { op: 'create', name: '010-0000-0000' } })).body.code, 'PII');
  assert.equal((await call(env, 'POST', '/api/staff', { token: adminToken, body: { op: 'link', staffId: 'st_nobody000000' } })).status, 404);

  const t0 = Date.now();
  const link = await atNow(t0, () => call(env, 'POST', '/api/staff', { token: adminToken, body: { op: 'link', staffId: created.body.staff.id } }));
  assert.match(link.body.code, /^[a-f0-9]{48}$/);
  assert.equal(link.body.expiresAt, t0 + 7 * DAY);

  const exchanged = await call(env, 'POST', '/api/link-exchange', { body: { code: link.body.code } });
  assert.equal(exchanged.status, 200);
  assert.deepEqual([exchanged.body.role, exchanged.body.staffId, exchanged.body.name], ['staff', created.body.staff.id, '직원 A']);
  const reuse = await call(env, 'POST', '/api/link-exchange', { body: { code: link.body.code } });
  assert.deepEqual([reuse.status, reuse.body.code], [401, 'CODE_INVALID']);
  assert.equal((await call(env, 'POST', '/api/link-exchange', { body: { code: 'zz' } })).status, 401);

  const staffToken = exchanged.body.token;
  const me = await call(env, 'GET', '/api/me', { token: staffToken });
  assert.deepEqual(me.body, { ok: true, role: 'staff', staffId: created.body.staff.id, name: '직원 A' });
  // 직원은 명단은 볼 수 있지만 직원 관리는 못 한다
  const listed = await call(env, 'GET', '/api/staff', { token: staffToken });
  assert.deepEqual(listed.body.staff, [{ id: created.body.staff.id, name: '직원 A', role: 'staff', active: true }]);
  assert.equal((await call(env, 'POST', '/api/staff', { token: staffToken, body: { op: 'create', name: 'B' } })).status, 403);

  // 만료된 코드
  const link2 = await atNow(t0, () => call(env, 'POST', '/api/staff', { token: adminToken, body: { op: 'link', staffId: created.body.staff.id } }));
  const expired = await atNow(t0 + 7 * DAY + 1, () => call(env, 'POST', '/api/link-exchange', { body: { code: link2.body.code } }));
  assert.deepEqual([expired.status, expired.body.code], [401, 'CODE_INVALID']);

  // 비활성 → 토큰은 있어도 401, 다시 활성화하면 같은 토큰으로 이어 쓴다
  const off = await call(env, 'POST', '/api/staff', { token: adminToken, body: { op: 'deactivate', staffId: created.body.staff.id } });
  assert.equal(off.body.staff.active, false);
  assert.equal((await call(env, 'GET', '/api/me', { token: staffToken })).status, 401);
  assert.equal((await call(env, 'POST', '/api/staff', { token: adminToken, body: { op: 'link', staffId: created.body.staff.id } })).status, 409);
  await call(env, 'POST', '/api/staff', { token: adminToken, body: { op: 'activate', staffId: created.body.staff.id } });
  assert.equal((await call(env, 'GET', '/api/me', { token: staffToken })).status, 200);

  // rename 은 updated_at 을 올려 since= 동기화에 실린다
  const renamed = await call(env, 'POST', '/api/staff', { token: adminToken, body: { op: 'rename', staffId: created.body.staff.id, name: '직원 가' } });
  assert.equal(renamed.body.staff.name, '직원 가');
  assert.equal((await call(env, 'GET', '/api/me', { token: staffToken })).body.name, '직원 가');

  // revoke 는 토큰·미사용 코드를 전부 폐기한다(만료됐지만 안 쓰인 link2 도 함께 → 코드 2건)
  const pending = await call(env, 'POST', '/api/staff', { token: adminToken, body: { op: 'link', staffId: created.body.staff.id } });
  const revoked = await call(env, 'POST', '/api/staff', { token: adminToken, body: { op: 'revoke', staffId: created.body.staff.id } });
  assert.deepEqual([revoked.body.revokedTokens, revoked.body.revokedCodes], [1, 2]);
  assert.equal((await call(env, 'GET', '/api/me', { token: staffToken })).status, 401);
  assert.equal((await call(env, 'POST', '/api/link-exchange', { body: { code: pending.body.code } })).status, 401);
});

test('인증 없는 접근은 401, logout 뒤 토큰은 죽고, 토큰 TTL 은 last_seen 기준으로 연장된다', async () => {
  const env = envFor();
  for (const [method, path] of [['GET', '/api/me'], ['GET', '/api/docs'], ['POST', '/api/docs'], ['POST', '/api/requests'],
    ['GET', '/api/staff'], ['GET', '/api/export'], ['POST', '/api/logout']]) {
    const result = await call(env, method, path, { body: method === 'POST' ? {} : undefined });
    assert.deepEqual([result.status, result.body.code], [401, 'AUTH'], method + ' ' + path);
  }
  assert.equal((await call(env, 'GET', '/api/me', { token: 'not-a-token' })).status, 401);
  assert.equal((await call(env, 'GET', '/api/nope')).status, 401);

  const t0 = Date.now();
  const adminToken = await atNow(t0, () => setupAdmin(env));
  assert.equal((await call(env, 'GET', '/api/nope', { token: adminToken })).status, 404);
  assert.equal((await call(env, 'DELETE', '/api/me', { token: adminToken })).status, 405);
  assert.equal((await call(env, 'POST', '/api/logout', { token: adminToken })).body.ok, true);
  assert.equal((await call(env, 'GET', '/api/me', { token: adminToken })).status, 401);

  const login = await atNow(t0, () => call(env, 'POST', '/api/login', { body: { password: PASSWORD } }));
  const token = login.body.token;
  assert.equal((await atNow(t0 + 29 * DAY, () => call(env, 'GET', '/api/me', { token }))).status, 200);
  assert.equal((await atNow(t0 + 58 * DAY, () => call(env, 'GET', '/api/me', { token }))).status, 200);
  assert.equal((await atNow(t0 + 58 * DAY + 31 * DAY, () => call(env, 'GET', '/api/me', { token }))).status, 401);

  const staff = await atNow(t0, () => makeStaff(env, token, '직원 B'));
  assert.equal((await atNow(t0 + 179 * DAY, () => call(env, 'GET', '/api/me', { token: staff.token }))).status, 200);
  assert.equal((await atNow(t0 + 179 * DAY + 181 * DAY, () => call(env, 'GET', '/api/me', { token: staff.token }))).status, 401);
});

test('docs students: 정상 저장, PII 거부, LWW, STALE+current, since=, 삭제는 원장만, staff 문서 동봉', async () => {
  const env = envFor();
  const adminToken = await setupAdmin(env);
  const a = await makeStaff(env, adminToken, '직원 A');
  const b = await makeStaff(env, adminToken, '직원 B');

  const saved = await putDoc(env, a.token, 'students', 'stu_a', student());
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(Object.keys(saved.body.results[0]).sort(), ['c', 'id', 'updatedAt']);
  const firstAt = saved.body.results[0].updatedAt;

  const pii = await putDoc(env, a.token, 'students', 'stu_b', student({ name: '학생B', memo: '어머니 010-0000-0000 통화' }));
  assert.deepEqual([pii.status, pii.body.ok, pii.body.code, pii.body.results[0].code], [400, false, 'PII', 'PII']);
  assert.equal((await putDoc(env, a.token, 'students', 'stu_b', student({ name: 'a@b.co' }))).body.code, 'PII');
  assert.equal((await putDoc(env, a.token, 'students', 'stu_b', student({ programs: { studyforce: { active: true, plan: '02-000-0000' } } }))).body.code, 'PII');
  assert.equal((await putDoc(env, a.token, 'students', 'stu_b', student({ status: 'gone' }))).body.code, 'INVALID');
  assert.equal((await putDoc(env, a.token, 'students', 'stu_b', student({ programs: { leaders: { active: true } } }))).body.code, 'INVALID');
  assert.equal((await putDoc(env, a.token, 'students', 'stu_b', student({ guardian: { phone: '010-0000-0000-0000-0000', consent: true } }))).body.code, 'INVALID');
  assert.equal((await putDoc(env, a.token, 'students', 'stu_b', student({ guardian: { phone: '02-000-0000', consent: false } }))).status, 200);
  assert.equal((await putDoc(env, a.token, 'students', 'bad id', student())).body.code, 'INVALID');
  assert.equal((await putDoc(env, a.token, 'people', 'x', student())).body.code, 'INVALID');
  assert.equal((await call(env, 'POST', '/api/docs', { token: a.token, body: { changes: 'x' } })).status, 400);

  // 다른 직원이 expectedUpdatedAt 없이 쓰면 LWW 로 덮는다
  const lww = await putDoc(env, b.token, 'students', 'stu_a', student({ memo: 'B 가 고침' }));
  assert.equal(lww.status, 200);
  assert.ok(lww.body.results[0].updatedAt > firstAt);
  const secondAt = lww.body.results[0].updatedAt;

  // expectedUpdatedAt 이 다르면 STALE + current
  const stale = await putDoc(env, a.token, 'students', 'stu_a', student({ memo: 'A 가 고침' }), { expectedUpdatedAt: firstAt });
  assert.deepEqual([stale.status, stale.body.results[0].code, stale.body.results[0].current.updatedAt,
    stale.body.results[0].current.data.memo, stale.body.results[0].current.updatedBy], [409, 'STALE', secondAt, 'B 가 고침', b.id]);
  const fresh = await putDoc(env, a.token, 'students', 'stu_a', student({ memo: 'A 가 고침' }), { expectedUpdatedAt: secondAt });
  assert.equal(fresh.status, 200);
  const thirdAt = fresh.body.results[0].updatedAt;
  // 여기부터 쓰기는 시계를 thirdAt 에 고정한다 — since= 검사가 실제 시계 속도에 흔들리면 안 된다
  // (CI 러너는 로컬보다 빨라 stu_new 가 2ms 뒤에 만들어지면 since=fixed+1 에 섞여 들어왔다).
  const fixed = thirdAt;
  const missing = await putDoc(env, a.token, 'students', 'stu_new', student(), { expectedUpdatedAt: 5 });
  assert.equal(missing.body.results[0].code, 'STALE');
  assert.equal(missing.body.results[0].current, null);
  const created = await atNow(fixed, () => putDoc(env, a.token, 'students', 'stu_new', student(), { expectedUpdatedAt: 0 }));
  assert.deepEqual([created.status, created.body.results[0].updatedAt], [200, fixed]);

  // 같은 ms 안의 연속 쓰기도 updatedAt 이 커진다
  const same1 = await atNow(fixed, () => putDoc(env, a.token, 'students', 'stu_a', student({ memo: '1' })));
  const same2 = await atNow(fixed, () => putDoc(env, a.token, 'students', 'stu_a', student({ memo: '2' })));
  assert.deepEqual([same1.body.results[0].updatedAt, same2.body.results[0].updatedAt], [fixed + 1, fixed + 2]);

  // GET: 전체엔 학생 3 + staff 2, since= 는 그 뒤 것만
  const all = await call(env, 'GET', '/api/docs', { token: b.token });
  assert.equal(all.status, 200);
  const byKey = Object.fromEntries(all.body.docs.map(d => [d.c + '/' + d.id, d]));
  assert.deepEqual(Object.keys(byKey).sort(), ['staff/' + a.id, 'staff/' + b.id, 'students/stu_a', 'students/stu_b', 'students/stu_new'].sort());
  assert.deepEqual(byKey['staff/' + a.id].data, { id: a.id, name: '직원 A', role: 'staff', active: true });
  assert.deepEqual([byKey['students/stu_a'].data.memo, byKey['students/stu_a'].updatedBy, byKey['students/stu_a'].deleted], ['2', a.id, false]);
  assert.equal(byKey['students/stu_a'].data.guardian.phone, '010-0000-0000');
  const since = await call(env, 'GET', '/api/docs?since=' + (fixed + 1), { token: b.token });
  assert.deepEqual(since.body.docs.map(d => d.c + '/' + d.id), ['students/stu_a']);
  assert.equal((await call(env, 'GET', '/api/docs?since=abc', { token: b.token })).status, 400);

  // 삭제는 원장만. 삭제된 행은 내용을 비운 채 남아 since= 로 전파된다
  const staffDelete = await call(env, 'POST', '/api/docs', { token: a.token, body: { changes: [{ c: 'students', id: 'stu_b', deleted: true }] } });
  assert.deepEqual([staffDelete.status, staffDelete.body.results[0].code], [403, 'FORBIDDEN']);
  const adminDelete = await atNow(fixed + 10, () => call(env, 'POST', '/api/docs', { token: adminToken, body: { changes: [{ c: 'students', id: 'stu_b', deleted: true }] } }));
  assert.deepEqual([adminDelete.status, adminDelete.body.results[0].updatedAt], [200, fixed + 10]);
  const afterDelete = await call(env, 'GET', '/api/docs?since=' + (fixed + 9), { token: a.token });
  assert.deepEqual(afterDelete.body.docs.map(d => [d.id, d.deleted, d.data]), [['stu_b', true, {}]]);
});

test('docs checks: __lic__ 승인은 원장만, __licev__ 는 append-only, 자유 텍스트 300자·PII', async () => {
  const env = envFor();
  const adminToken = await setupAdmin(env);
  const a = await makeStaff(env, adminToken, '직원 A');
  const lic = '__lic__MAT-0001|all';
  assert.equal((await putDoc(env, a.token, 'checks', lic, { status: 'requested', note: '02 워크북 필요' })).status, 200);
  const staffApprove = await putDoc(env, a.token, 'checks', lic, { status: 'approved' });
  assert.deepEqual([staffApprove.status, staffApprove.body.results[0].code], [403, 'APPROVAL_ADMIN_ONLY']);
  assert.equal((await putDoc(env, a.token, 'checks', lic, { status: 'rejected' })).status, 403);
  const adminApprove = await putDoc(env, adminToken, 'checks', lic, { status: 'approved' });
  assert.equal(adminApprove.status, 200);
  // approved → purchased 는 직원도 된다(승인 단계만 원장 전용)
  assert.equal((await putDoc(env, a.token, 'checks', lic, { status: 'purchased' })).status, 200);
  // requested 가 아닌 상태에서 approved 로 쓰는 것은 직원도 막지 않는다(승인 전이만 본다)
  assert.equal((await putDoc(env, a.token, 'checks', '__lic__MAT-0002|all', { status: 'approved' })).status, 200);

  const ev = '__licev__ev1|all';
  assert.equal((await putDoc(env, a.token, 'checks', ev, { type: 'request', at: 1 })).status, 200);
  const rewrite = await putDoc(env, adminToken, 'checks', ev, { type: 'request', at: 2 });
  assert.deepEqual([rewrite.status, rewrite.body.results[0].code], [409, 'APPEND_ONLY']);

  assert.equal((await putDoc(env, a.token, 'checks', 't1|2026-09-09', { done: true, count: 3, at: 1757400000000, by: a.id })).status, 200);
  const piiNote = await putDoc(env, a.token, 'checks', 't1|2026-09-10', { done: false, note: '학부모 010-0000-0000' });
  assert.deepEqual([piiNote.status, piiNote.body.results[0].code], [400, 'PII']);
  assert.equal((await putDoc(env, a.token, 'checks', 't1|2026-09-10', { memo: '가'.repeat(301) })).body.results[0].code, 'INVALID');
  assert.equal((await putDoc(env, a.token, 'checks', '__act__' + a.id + '|x1', { items: [{ note: '정상 메모 300자 이하' }] })).status, 200);
});

test('docs contacts(append-only, by 덮어쓰기)·settings(원장만)·tasks(ext 키·16KB)·복수 변경', async () => {
  const env = envFor();
  const adminToken = await setupAdmin(env);
  const a = await makeStaff(env, adminToken, '직원 A');

  const contact = await putDoc(env, a.token, 'contacts', 'ct_1', { studentId: 'stu_a', type: 'call', result: 'reached', note: '안내 완료', at: 1757400000000, by: 'someone-else' });
  assert.equal(contact.status, 200);
  const stored = (await call(env, 'GET', '/api/docs', { token: a.token })).body.docs.find(d => d.c === 'contacts');
  assert.equal(stored.data.by, a.id);
  const again = await putDoc(env, a.token, 'contacts', 'ct_1', { studentId: 'stu_a', type: 'call', result: 'reached', at: 1 });
  assert.deepEqual([again.status, again.body.results[0].code], [409, 'APPEND_ONLY']);
  assert.equal((await putDoc(env, a.token, 'contacts', 'ct_2', { studentId: 'stu_a', type: 'fax', result: 'reached' })).body.code, 'INVALID');
  assert.equal((await putDoc(env, a.token, 'contacts', 'ct_2', { studentId: 'stu_a', type: 'msg', result: 'note', note: 'p@q.io' })).body.code, 'PII');
  assert.equal((await putDoc(env, a.token, 'contacts', 'ct_2', { studentId: 'stu_a', type: 'msg', result: 'note', note: '가'.repeat(201) })).body.code, 'INVALID');

  const staffSettings = await putDoc(env, a.token, 'settings', 'main', { orgName: '데스크' });
  assert.deepEqual([staffSettings.status, staffSettings.body.results[0].code], [403, 'FORBIDDEN']);
  assert.equal((await putDoc(env, adminToken, 'settings', 'main', { orgName: '데스크', requestPasscode: '1234', runbookPack: { v: 1 } })).status, 200);
  assert.equal((await putDoc(env, adminToken, 'settings', 'main', { runbookPack: 'x' })).body.code, 'INVALID');

  assert.equal((await putDoc(env, a.token, 'tasks', 'task_1', { title: '계정 발급', steps: [{ label: '접속', ext: 'studyforce_admin' }] })).status, 200);
  assert.equal((await putDoc(env, a.token, 'tasks', 'task_2', { steps: [{ label: 'x', ext: 'Bad-Key' }] })).body.code, 'INVALID');
  assert.equal((await putDoc(env, a.token, 'tasks', 'task_3', { blob: 'x'.repeat(17 * 1024) })).body.code, 'TOO_LARGE');
  assert.equal((await putDoc(env, a.token, 'students', 'big', student({ memo: 'x'.repeat(200) }), {})).status, 200);

  // 복수 변경: 성공한 건의 updatedAt 은 남고 상태 코드는 첫 실패를 따른다
  const mixed = await call(env, 'POST', '/api/docs', { token: a.token, body: { changes: [
    { c: 'checks', id: 't2|2026-09-09', data: { done: true } },
    { c: 'students', id: 'stu_c', data: student({ name: '학생B', memo: '010-0000-0000' }) },
    { c: 'checks', id: 't3|2026-09-09', data: { done: true } }
  ] } });
  assert.deepEqual([mixed.status, mixed.body.ok, mixed.body.code], [400, false, 'PII']);
  assert.ok(mixed.body.results[0].updatedAt > 0 && mixed.body.results[2].updatedAt > 0);
  assert.equal(mixed.body.results[1].code, 'PII');
  const tooMany = await call(env, 'POST', '/api/docs', { token: a.token, body: { changes: new Array(201).fill({ c: 'checks', id: 'x|y', data: {} }) } });
  assert.equal(tooMany.status, 400);
});

test('export 는 원장만, 비밀번호 변경은 다른 원장 기기를 내려보낸다', async () => {
  const env = envFor();
  const adminToken = await setupAdmin(env);
  const a = await makeStaff(env, adminToken, '직원 A');
  await putDoc(env, a.token, 'students', 'stu_a', student());
  const req = await call(env, 'POST', '/api/requests', { token: a.token, body: { action: 'create', reqType: 'account', program: 'studyforce', targetRef: 'stu_a', detail: '계정 발급' } });
  assert.equal(req.status, 200, JSON.stringify(req.body));
  assert.equal(req.body.request.ownerId, a.id);
  const adminList = await call(env, 'POST', '/api/requests', { token: adminToken, body: { app: 'task', auth: { mode: 'admin' }, action: 'list' } });
  assert.deepEqual([adminList.body.role, adminList.body.viewerId, adminList.body.requests.length], ['admin', 'admin', 1]);

  assert.equal((await call(env, 'GET', '/api/export', { token: a.token })).status, 403);
  const exported = await call(env, 'GET', '/api/export', { token: adminToken });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-disposition'), /^attachment; filename="wb-desk-export-\d{4}-\d{2}-\d{2}\.json"$/);
  assert.deepEqual([exported.body.docs.length, exported.body.staff.length, exported.body.requests.length, exported.body.events.length], [1, 1, 1, 1]);
  assert.equal(exported.body.docs[0].data.guardian.phone, '010-0000-0000');

  const other = (await call(env, 'POST', '/api/login', { body: { password: PASSWORD } })).body.token;
  assert.equal((await call(env, 'POST', '/api/password', { token: a.token, body: { password: PASSWORD, newPassword: 'new-password-22' } })).status, 403);
  assert.equal((await call(env, 'POST', '/api/password', { token: adminToken, body: { password: 'wrong', newPassword: 'new-password-22' } })).status, 401);
  assert.equal((await call(env, 'POST', '/api/password', { token: adminToken, body: { password: PASSWORD, newPassword: 'new-password-22' } })).status, 200);
  assert.equal((await call(env, 'GET', '/api/me', { token: adminToken })).status, 200);
  assert.equal((await call(env, 'GET', '/api/me', { token: other })).status, 401);
  assert.equal((await call(env, 'POST', '/api/login', { body: { password: PASSWORD } })).status, 401);
  assert.equal((await call(env, 'POST', '/api/login', { body: { password: 'new-password-22' } })).status, 200);
});

test('worker.mjs: /api/* 는 handleApi, 나머지는 ASSETS 로', async () => {
  const env = envFor();
  const served = [];
  env.ASSETS = { fetch: async request => { served.push(new URL(request.url).pathname); return new Response('asset', { status: 200 }); } };
  const health = await worker.fetch(new Request(BASE + '/api/health'), env, {});
  assert.equal((await health.json()).app, 'wb-desk');
  const page = await worker.fetch(new Request(BASE + '/'), env, {});
  assert.equal(await page.text(), 'asset');
  await worker.fetch(new Request(BASE + '/lib/runbook-ui.js'), env, {});
  assert.deepEqual(served, ['/', '/lib/runbook-ui.js']);
});

/* ── 기획서 v1.1 — 배정 카드·템플릿·앱 목적지·매뉴얼 ── */

async function docOf(env, token, c, id) {
  const res = await call(env, 'GET', '/api/docs', { token });
  const hit = res.body.docs.find(d => d.c === c && d.id === id);
  return hit ? hit.data : null;
}

test('docs cards: 직원도 쓰고, 만든 사람·완료자·증빙 by 는 토큰 신원, 막힘엔 사유, 프로그램·대상·기한·PII 검증, 삭제는 원장만', async () => {
  const env = envFor();
  const adminToken = await setupAdmin(env);
  const a = await makeStaff(env, adminToken, '직원 A');
  const base = { program: 'classcard', target: { type: 'text', label: '중2A반' }, what: '이번 주 세트 배정', where: '클래스카드 → 중2A반', due: '2026-09-09' };
  const made = await putDoc(env, adminToken, 'cards', 'c1', Object.assign({ createdBy: 'hacker', byOwner: false, doneAt: 5 }, base));
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const got = await docOf(env, a.token, 'cards', 'c1');
  assert.deepEqual([got.status, got.createdBy, got.byOwner, typeof got.createdAt, got.doneAt], ['todo', 'admin', true, 'number', undefined]);

  assert.equal((await putDoc(env, a.token, 'cards', 'c1', Object.assign({}, got, { status: 'doing' }))).status, 200);
  assert.equal((await putDoc(env, a.token, 'cards', 'c1', Object.assign({}, got, { status: 'blocked' }))).body.code, 'INVALID');
  assert.equal((await putDoc(env, a.token, 'cards', 'c1', Object.assign({}, got, { status: 'blocked', blockedReason: '반이 아직 없음' }))).status, 200);
  assert.equal((await docOf(env, a.token, 'cards', 'c1')).blockedReason, '반이 아직 없음');
  const done = await putDoc(env, a.token, 'cards', 'c1', Object.assign({}, got, { status: 'done', evidence: { kind: 'check', by: 'someone', note: '반 3개 완료' }, createdBy: 'x' }));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const after = await docOf(env, a.token, 'cards', 'c1');
  assert.deepEqual([after.status, after.evidence.kind, after.evidence.by, after.evidence.note, after.doneBy, after.createdBy, after.byOwner, after.blockedReason],
    ['done', 'check', a.id, '반 3개 완료', a.id, 'admin', true, undefined]);
  assert.ok(after.doneAt > 0 && after.evidence.at > 0);
  // 완료된 카드를 다시 저장해도 완료 시각·완료자는 처음 값
  await putDoc(env, adminToken, 'cards', 'c1', Object.assign({}, after, { note: '원장 메모' }));
  const kept = await docOf(env, a.token, 'cards', 'c1');
  assert.deepEqual([kept.doneAt, kept.doneBy, kept.note], [after.doneAt, a.id, '원장 메모']);

  assert.equal((await putDoc(env, a.token, 'cards', 'c2', Object.assign({}, base, { program: 'naver' }))).body.code, 'INVALID');
  assert.equal((await putDoc(env, a.token, 'cards', 'c2', Object.assign({}, base, { target: { type: 'student' } }))).body.code, 'INVALID');
  assert.equal((await putDoc(env, a.token, 'cards', 'c2', Object.assign({}, base, { target: { type: 'text', label: '' } }))).body.code, 'INVALID');
  assert.equal((await putDoc(env, a.token, 'cards', 'c2', Object.assign({}, base, { note: '엄마 010-0000-0000' }))).body.code, 'PII');
  assert.equal((await putDoc(env, a.token, 'cards', 'c2', Object.assign({}, base, { due: '2026-9-9' }))).body.code, 'INVALID');
  assert.equal((await putDoc(env, a.token, 'cards', 'c2', Object.assign({}, base, { status: 'maybe' }))).body.code, 'INVALID');
  assert.equal((await putDoc(env, a.token, 'cards', 'c2', Object.assign({}, base, { what: '' }))).body.code, 'INVALID');
  assert.equal((await putDoc(env, a.token, 'cards', 'c2', Object.assign({}, base, { evidence: { kind: 'photo' } }))).body.code, 'INVALID');
  assert.equal((await putDoc(env, a.token, 'cards', 'c3', { program: 'studyforce', target: { type: 'student', id: 'stu_a' }, what: '수행 확인' })).status, 200);
  assert.equal((await docOf(env, a.token, 'cards', 'c3')).byOwner, false);
  assert.equal((await call(env, 'POST', '/api/docs', { token: a.token, body: { changes: [{ c: 'cards', id: 'c3', deleted: true }] } })).status, 403);
  assert.equal((await call(env, 'POST', '/api/docs', { token: adminToken, body: { changes: [{ c: 'cards', id: 'c3', deleted: true }] } })).status, 200);
});

test('docs apps·plans·manuals: 원장만, 직원은 앱 자료 범위의 status·note 만, https·요일·범위·링크 검증', async () => {
  const env = envFor();
  const adminToken = await setupAdmin(env);
  const a = await makeStaff(env, adminToken, '직원 A');

  assert.equal((await putDoc(env, a.token, 'apps', 'app1', { name: '국어 내신 앱' })).status, 403);
  assert.equal((await putDoc(env, adminToken, 'apps', 'app1', { name: '국어 내신 앱', adminUrl: 'http://insecure' })).body.code, 'INVALID');
  assert.equal((await putDoc(env, adminToken, 'apps', 'app1', { name: '' })).body.code, 'INVALID');
  const app = await putDoc(env, adminToken, 'apps', 'app1', { name: '국어 내신 앱', adminUrl: 'https://example.invalid/admin/', format: '팩 JSON' });
  assert.equal(app.status, 200, JSON.stringify(app.body));
  assert.deepEqual(await docOf(env, a.token, 'apps', 'app1'), { name: '국어 내신 앱', adminUrl: 'https://example.invalid/admin/', format: '팩 JSON', active: true });

  const rec = { kind: 'recurring', program: 'studyforce', days: [5, 1, 2, 3, 3, 4], target: { type: 'each' }, what: '수행 확인' };
  assert.equal((await putDoc(env, a.token, 'plans', 'pl1', rec)).status, 403);
  assert.equal((await putDoc(env, adminToken, 'plans', 'pl1', Object.assign({}, rec, { days: [7] }))).body.code, 'INVALID');
  assert.equal((await putDoc(env, adminToken, 'plans', 'pl1', Object.assign({}, rec, { days: [] }))).body.code, 'INVALID');
  assert.equal((await putDoc(env, adminToken, 'plans', 'pl1', Object.assign({}, rec, { target: { type: 'student' } }))).body.code, 'INVALID');
  assert.equal((await putDoc(env, adminToken, 'plans', 'pl1', Object.assign({}, rec, { kind: 'weekly' }))).body.code, 'INVALID');
  assert.equal((await putDoc(env, adminToken, 'plans', 'pl1', Object.assign({}, rec, { program: 'exam4you', target: { type: 'app', id: 'app1' } }))).status, 200);
  assert.equal((await putDoc(env, adminToken, 'plans', 'pl1', rec)).status, 200);
  const saved = await docOf(env, a.token, 'plans', 'pl1');
  assert.deepEqual([saved.days, saved.active, saved.target], [[1, 2, 3, 4, 5], true, { type: 'each' }]);

  const range = { kind: 'apprange', appId: 'app1', subject: '국어', grade: '중2', unit: '3단원', material: '기출 3개년' };
  assert.equal((await putDoc(env, a.token, 'plans', 'r1', range)).status, 403);
  assert.equal((await putDoc(env, adminToken, 'plans', 'r1', range)).status, 200);
  const r1 = await docOf(env, a.token, 'plans', 'r1');
  assert.deepEqual([r1.status, r1.source], ['need', 'exam4you']);
  assert.equal((await putDoc(env, a.token, 'plans', 'r1', Object.assign({}, r1, { status: 'buying', note: '9/10 구매 예정' }))).status, 200);
  assert.equal((await docOf(env, a.token, 'plans', 'r1')).status, 'buying');
  assert.equal((await putDoc(env, a.token, 'plans', 'r1', Object.assign({}, r1, { status: 'have', unit: '4단원' }))).status, 403);
  assert.equal((await putDoc(env, adminToken, 'plans', 'r1', Object.assign({}, r1, { status: 'nope' }))).body.code, 'INVALID');
  assert.equal((await putDoc(env, adminToken, 'plans', 'r2', Object.assign({}, range, { unit: '' }))).body.code, 'INVALID');
  assert.equal((await putDoc(env, adminToken, 'plans', 'r2', Object.assign({}, range, { source: 'naver' }))).body.code, 'INVALID');

  const man = { scope: 'classcard', task: 'assign', title: '세트 배정', purpose: '반에 이번 주 세트를 넣는다',
    steps: ['반을 연다', { text: '세트를 고른다', note: '주차 확인' }], cautions: ['학생 이름을 카드에 적지 않는다'],
    links: [{ label: '클래스카드', url: 'https://www.classcard.net/Login' }] };
  assert.equal((await putDoc(env, a.token, 'manuals', 'm1', man)).status, 403);
  const m = await putDoc(env, adminToken, 'manuals', 'm1', man);
  assert.equal(m.status, 200, JSON.stringify(m.body));
  const m1 = await docOf(env, a.token, 'manuals', 'm1');
  assert.deepEqual([m1.steps, m1.version, m1.links, m1.cautions], [[{ text: '반을 연다' }, { text: '세트를 고른다', note: '주차 확인' }], 1, man.links, man.cautions]);
  assert.equal((await putDoc(env, adminToken, 'manuals', 'm2', Object.assign({}, man, { links: [{ label: 'x', url: 'http://x' }] }))).body.code, 'INVALID');
  assert.equal((await putDoc(env, adminToken, 'manuals', 'm2', Object.assign({}, man, { scope: 'kakao' }))).body.code, 'INVALID');
  assert.equal((await putDoc(env, adminToken, 'manuals', 'm2', Object.assign({}, man, { steps: ['전화 010-0000-0000'] }))).body.code, 'PII');
  assert.equal((await putDoc(env, adminToken, 'manuals', 'm2', Object.assign({}, man, { title: '' }))).body.code, 'INVALID');
  assert.equal((await putDoc(env, adminToken, 'manuals', 'm2', Object.assign({}, man, { scope: 'app', appId: 'bad id' }))).body.code, 'INVALID');
  assert.equal((await putDoc(env, adminToken, 'manuals', 'm2', Object.assign({}, man, { scope: 'app', appId: 'app1', task: 'upload' }))).status, 200);
});

test('docs plans(exam)·students.school: 시험 템플릿 규칙(학교·시험일·기간·자료 출처)과 학생 학교 칸', async () => {
  const env = envFor();
  const adminToken = await setupAdmin(env);
  const a = await makeStaff(env, adminToken, '직원 A');
  const exam = { kind: 'exam', school: ' OO중 ', grade: '중2', subject: '영어', examName: '2학기 중간', examDate: '2026-09-30', scope: '3~4과',
    materials: [{ source: 'exam4you', what: '교과서 변형 3~4과', where: '학생 폴더' }, { source: 'jokbo', what: '기출 3개년', where: '' }] };
  assert.equal((await putDoc(env, a.token, 'plans', 'ex1', exam)).status, 403);
  const saved = await putDoc(env, adminToken, 'plans', 'ex1', exam);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const doc = await docOf(env, a.token, 'plans', 'ex1');
  assert.deepEqual([doc.school, doc.leadDays, doc.dueDaysBefore, doc.active, doc.materials], ['OO중', 21, 7, true, [{ source: 'exam4you', what: '교과서 변형 3~4과', where: '학생 폴더' }, { source: 'jokbo', what: '기출 3개년' }]]);
  assert.equal((await putDoc(env, adminToken, 'plans', 'ex2', Object.assign({}, exam, { school: '' }))).body.code, 'INVALID');
  assert.equal((await putDoc(env, adminToken, 'plans', 'ex2', Object.assign({}, exam, { examDate: '2026-9-30' }))).body.code, 'INVALID');
  assert.equal((await putDoc(env, adminToken, 'plans', 'ex2', Object.assign({}, exam, { leadDays: 7, dueDaysBefore: 7 }))).body.code, 'INVALID');
  assert.equal((await putDoc(env, adminToken, 'plans', 'ex2', Object.assign({}, exam, { materials: [] }))).body.code, 'INVALID');
  assert.equal((await putDoc(env, adminToken, 'plans', 'ex2', Object.assign({}, exam, { materials: [{ source: 'other', what: 'x' }] }))).body.code, 'INVALID');
  assert.equal((await putDoc(env, adminToken, 'plans', 'ex2', Object.assign({}, exam, { scope: '연락 010-0000-0000' }))).body.code, 'PII');
  // 직원은 exam 템플릿의 status·note 변경도 못 한다(apprange 만 허용)
  assert.equal((await putDoc(env, a.token, 'plans', 'ex1', Object.assign({}, doc, { note: '직원 메모' }))).status, 403);
  const stu = await putDoc(env, a.token, 'students', 'stu_s', { name: '학생A', grade: '중2', school: ' OO중 ' });
  assert.equal(stu.status, 200, JSON.stringify(stu.body));
  assert.equal((await docOf(env, a.token, 'students', 'stu_s')).school, 'OO중');
  assert.equal((await putDoc(env, a.token, 'students', 'stu_s', { name: '학생A', school: 'x'.repeat(41) })).body.code, 'INVALID');
});

async function rawCall(env, method, path, options = {}) {
  const headers = {};
  if (options.body !== undefined) { headers['content-type'] = 'application/json'; }
  if (options.token) headers.authorization = 'Bearer ' + options.token;
  return handleApi(new Request(BASE + path, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) }), env, {});
}

test('captures: 만들기(PII 가림·검증)·목록·단건·반영 표시·삭제 권한·보관 30건·크롬 확장 CORS·capture 규칙', async () => {
  const env = envFor();
  const adminToken = await setupAdmin(env);
  const a = await makeStaff(env, adminToken, '직원 A');
  const body = { program: 'studyforce', page: { host: 'https://hol.sfcenter.co.kr/x', title: '수행 현황' }, header: ['이름', '학년', '수행'],
    rows: [['학생A', '중2', '완료'], ['학생B', '중2', '010-0000-0000'], ['', '', ''], ['학생C']] };
  assert.equal((await call(env, 'POST', '/api/captures', { body })).status, 401);
  assert.equal((await call(env, 'POST', '/api/captures', { token: a.token, body: Object.assign({}, body, { program: 'exam4you' }) })).body.code, 'INVALID');
  assert.equal((await call(env, 'POST', '/api/captures', { token: a.token, body: Object.assign({}, body, { header: [] }) })).body.code, 'INVALID');
  assert.equal((await call(env, 'POST', '/api/captures', { token: a.token, body: Object.assign({}, body, { rows: 'x' }) })).body.code, 'INVALID');
  const made = await call(env, 'POST', '/api/captures', { token: a.token, body });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.deepEqual([made.body.rowCount, made.body.scrubbed, /^c_[0-9a-f]{24}$/.test(made.body.id)], [3, 1, true]);
  const list = await call(env, 'GET', '/api/captures?program=studyforce', { token: adminToken });
  const c0 = list.body.captures[0];
  assert.deepEqual([list.body.captures.length, c0.host, c0.title, c0.header, c0.rowCount, c0.createdBy, c0.rows, c0.appliedAt], [1, 'hol.sfcenter.co.kr', '수행 현황', ['이름', '학년', '수행'], 3, a.id, undefined, null]);
  const one = await call(env, 'GET', '/api/captures/' + made.body.id, { token: a.token });
  assert.deepEqual(one.body.capture.rows, [['학생A', '중2', '완료'], ['학생B', '중2', '(가림)'], ['학생C']]);
  assert.equal((await call(env, 'GET', '/api/captures?program=kakao', { token: a.token })).body.code, 'INVALID');
  assert.equal((await call(env, 'GET', '/api/captures/c_000000000000000000000000', { token: a.token })).status, 404);
  const applied = await call(env, 'POST', '/api/captures/' + made.body.id + '/applied', { token: a.token, body: {} });
  assert.deepEqual([applied.status, applied.body.appliedBy], [200, a.id]);
  assert.equal((await call(env, 'GET', '/api/captures', { token: a.token })).body.captures[0].appliedBy, a.id);
  assert.equal((await call(env, 'POST', '/api/captures/c_000000000000000000000000/applied', { token: a.token, body: {} })).status, 404);
  for (let i = 0; i < 32; i++) await call(env, 'POST', '/api/captures', { token: a.token, body: Object.assign({}, body, { capturedAt: 1000 + i }) });
  assert.equal((await call(env, 'GET', '/api/captures?program=studyforce&limit=30', { token: a.token })).body.captures.length, 30, '프로그램당 30건만 남는다');
  const latest = (await call(env, 'GET', '/api/captures?program=studyforce', { token: a.token })).body.captures[0].id;
  assert.equal((await call(env, 'DELETE', '/api/captures/' + latest, { token: a.token })).status, 403);
  assert.equal((await call(env, 'DELETE', '/api/captures/' + latest, { token: adminToken })).body.deleted, 1);

  const ext = 'chrome-extension://' + 'a'.repeat(32);
  const pre = await handleApi(new Request(BASE + '/api/captures', { method: 'OPTIONS', headers: { origin: ext } }), env, {});
  assert.deepEqual([pre.status, pre.headers.get('access-control-allow-origin'), pre.headers.get('access-control-allow-headers')], [204, ext, 'authorization, content-type']);
  assert.equal((await handleApi(new Request(BASE + '/api/captures', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }), env, {})).status, 405);
  assert.equal((await handleApi(new Request(BASE + '/api/health', { headers: { origin: ext } }), env, {})).headers.get('access-control-allow-origin'), ext);
  assert.equal((await handleApi(new Request(BASE + '/api/health', { headers: { origin: 'https://evil.example' } }), env, {})).headers.get('access-control-allow-origin'), null);
  assert.equal((await handleApi(new Request(BASE + '/api/health'), env, {})).headers.get('access-control-allow-origin'), null);

  const rule = { kind: 'capture', program: 'studyforce', nameCol: 0, statusCol: 2, gradeCol: 1, doneValues: ['완료', ' O '], partialValues: [] };
  assert.equal((await putDoc(env, a.token, 'plans', 'cap:studyforce', rule)).status, 403);
  assert.equal((await putDoc(env, adminToken, 'plans', 'cap:studyforce', rule)).status, 200);
  const saved = await docOf(env, a.token, 'plans', 'cap:studyforce');
  assert.deepEqual([saved.basis, saved.doneValues, saved.active], ['report', ['완료', 'O'], true]);
  assert.equal((await putDoc(env, adminToken, 'plans', 'cap:x', Object.assign({}, rule, { statusCol: 0 }))).body.code, 'INVALID');
  assert.equal((await putDoc(env, adminToken, 'plans', 'cap:x', Object.assign({}, rule, { doneValues: [] }))).body.code, 'INVALID');
  assert.equal((await putDoc(env, adminToken, 'plans', 'cap:x', Object.assign({}, rule, { program: 'exam4you' }))).body.code, 'INVALID');
  assert.equal((await putDoc(env, adminToken, 'plans', 'cap:x', Object.assign({}, rule, { gradeCol: 40 }))).body.code, 'INVALID');
});

test('files: 원장만 올리고 지운다, 직원은 본다, base64·mime·크기 검증, 매뉴얼 photos 규칙', async () => {
  const env = envFor();
  const adminToken = await setupAdmin(env);
  const a = await makeStaff(env, adminToken, '직원 A');
  const bytes = Buffer.from('not-really-a-jpeg-but-bytes-are-bytes');
  const b64 = bytes.toString('base64');
  assert.equal((await call(env, 'POST', '/api/files', { token: a.token, body: { mime: 'image/jpeg', data: b64 } })).status, 403);
  assert.equal((await call(env, 'POST', '/api/files', { token: adminToken, body: { mime: 'image/gif', data: b64 } })).body.code, 'INVALID');
  assert.equal((await call(env, 'POST', '/api/files', { token: adminToken, body: { mime: 'image/jpeg', data: '***' } })).body.code, 'INVALID');
  assert.equal((await call(env, 'POST', '/api/files', { token: adminToken, body: { mime: 'image/jpeg', kind: 'secret', data: b64 } })).body.code, 'INVALID');
  const big = Buffer.alloc(401 * 1024, 1).toString('base64');
  assert.equal((await call(env, 'POST', '/api/files', { token: adminToken, body: { mime: 'image/png', data: big } })).status, 413);
  const up = await call(env, 'POST', '/api/files', { token: adminToken, body: { mime: 'image/png', data: 'data:image/png;base64,' + b64, ref: 'm1' } });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.deepEqual([up.body.mime, up.body.size, /^f_[0-9a-f]{24}$/.test(up.body.id)], ['image/png', bytes.length, true]);
  const got = await rawCall(env, 'GET', '/api/files/' + up.body.id, { token: a.token });
  assert.equal(got.status, 200);
  assert.deepEqual([got.headers.get('content-type'), got.headers.get('cache-control'), Buffer.from(await got.arrayBuffer()).equals(bytes)], ['image/png', 'private, max-age=86400', true]);
  assert.equal((await rawCall(env, 'GET', '/api/files/' + up.body.id, {})).status, 401);
  assert.equal((await call(env, 'GET', '/api/files/f_doesnotexist000000000000', { token: a.token })).status, 404);
  assert.equal((await call(env, 'GET', '/api/files/bad id', { token: a.token })).body.code, 'INVALID');
  const man = { scope: 'classcard', task: 'assign', title: '세트 배정', steps: ['반을 연다'], photos: [{ id: up.body.id, caption: ' 1 ' }] };
  assert.equal((await putDoc(env, adminToken, 'manuals', 'm1', man)).status, 200);
  assert.deepEqual((await docOf(env, a.token, 'manuals', 'm1')).photos, [{ id: up.body.id, caption: '1' }]);
  assert.equal((await putDoc(env, adminToken, 'manuals', 'm2', Object.assign({}, man, { photos: [{ id: 'nope' }] }))).body.code, 'INVALID');
  assert.equal((await putDoc(env, adminToken, 'manuals', 'm2', Object.assign({}, man, { photos: Array.from({ length: 13 }, () => ({ id: up.body.id })) }))).body.code, 'INVALID');
  assert.equal((await call(env, 'DELETE', '/api/files/' + up.body.id, { token: a.token })).status, 403);
  const del = await call(env, 'DELETE', '/api/files/' + up.body.id, { token: adminToken });
  assert.deepEqual([del.status, del.body.deleted], [200, 1]);
  assert.equal((await call(env, 'GET', '/api/files/' + up.body.id, { token: a.token })).status, 404);
});
