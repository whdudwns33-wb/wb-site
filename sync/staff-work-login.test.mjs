import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from './worker.js';
import {
  deriveStaffPinHash, guardStaffWorkAccess, handleStaffProfile, handleStaffWorkSession,
  handleManagerInspectionSession, resolveManagerInspectionAuth
} from './staff-work-login.js';

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  first() { return this.db.prepare(this.sql).get(...this.args) || null; }
  all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  run() { return { meta: { changes: Number(this.db.prepare(this.sql).run(...this.args).changes) } }; }
}
class TestD1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(`CREATE TABLE checks(app TEXT,k TEXT,owner TEXT,data TEXT,updated_at INTEGER,srv_at INTEGER,PRIMARY KEY(app,k));
      CREATE TABLE staff(app TEXT,id TEXT,data TEXT,PRIMARY KEY(app,id));
      CREATE TABLE tokens(app TEXT,token TEXT,staff_id TEXT,created_at INTEGER,revoked INTEGER);
      CREATE TABLE app_data_generations(app TEXT PRIMARY KEY,generation INTEGER);
      INSERT INTO app_data_generations VALUES('task',2);`);
    this.db.exec(readFileSync(new URL('./migrations/073_staff_work_login.sql', import.meta.url), 'utf8'));
    this.db.exec(readFileSync(new URL('./migrations/075_manager_inspection_sessions.sql', import.meta.url), 'utf8'));
    for (const id of ['teacher-a', 'teacher-b', 'manager-a']) {
      this.db.prepare('INSERT INTO staff VALUES(?,?,?)').run('task', id, JSON.stringify({ id, name: id }));
      this.db.prepare('INSERT INTO tokens VALUES(?,?,?,?,0)').run('task', 'device-' + id, id, Date.now());
    }
  }
  prepare(sql) { return new Statement(this.db, sql); }
}
const pepper = 'synthetic-test-pepper-never-production-0123456789';
const pin = '4826';
const teacher = { id: 'teacher-a', scope: 'own' };
const manager = { id: 'manager-a', scope: 'all', role: 'manager' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const now = Date.parse('2026-09-09T09:00:00+09:00');

async function fixture(extra = {}) {
  const DB = new TestD1();
  const env = { DB, WB_STAFF_WORK_LOGIN_ENABLED: 'true', WB_STAFF_PIN_PEPPER: pepper, TASK_MANAGER_STAFF_IDS: 'manager-a', ...extra };
  for (const id of ['teacher-a', 'manager-a']) {
    const salt = 'ab'.repeat(16);
    const pinHash = await deriveStaffPinHash(pin, salt, pepper);
    DB.db.prepare('INSERT INTO staff_private_profiles(app,staff_id,phone,login_enabled,pin_salt,pin_hash,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run('task', id, '010-0000-0000', 1, salt, pinHash, now);
  }
  return env;
}
async function withNow(value, fn) {
  const original = Date.now;
  Date.now = () => value;
  try { return await fn(); } finally { Date.now = original; }
}
function body(action, auth = teacher, extras = {}) {
  return { app: 'task', auth: { mode: 'person', id: auth.id, token: 'device-' + auth.id }, action, ...extras };
}
async function call(env, action, extras = {}, auth = teacher) {
  const input = body(action, auth, extras);
  const response = await handleStaffWorkSession(env, 'task', input, '*', auth, json);
  return { status: response.status, data: await response.json(), input };
}
async function gate(env, token, path = '/sync', auth = teacher, extra = {}) {
  const input = body('', auth, extra);
  input.auth.workSession = token || '';
  const response = await guardStaffWorkAccess(env, input, auth, path, '*', json);
  return response ? { status: response.status, data: await response.json() } : null;
}

test('login records server clock, binds opaque session to durable device, and logout preserves first punches', async () => {
  const env = await fixture();
  await withNow(now, async () => {
    const status = await call(env, 'status');
    assert.equal(status.data.required, true);
    assert.equal(status.data.configured, true);
    assert.equal(status.data.active, false);
    assert.equal('phone' in status.data, false);
    assert.equal((await gate(env)).data.code, 'STAFF_WORK_LOGIN_REQUIRED');
    const first = await call(env, 'login', { pin, at: 1, date: '2000-01-01' });
    assert.equal(first.status, 200);
    assert.equal(first.data.attendance.record.at, now);
    assert.equal(first.data.expiresAt, Date.parse('2026-09-10T00:00:00+09:00'));
    assert.match(first.data.workSession, /^[a-f0-9]{64}$/);
    assert.equal(await gate(env, first.data.workSession), null);
    assert.equal((await gate(env, first.data.workSession, '/staff-attendance')).data.code, 'STAFF_WORK_LOGIN_REQUIRED');
    assert.equal((await gate(env, first.data.workSession, '/sync', teacher, { auth: { mode: 'person', id: teacher.id, token: 'another-device' } })).data.code, 'STAFF_WORK_LOGIN_REQUIRED');
    const rows = env.DB.db.prepare('SELECT * FROM staff_work_sessions').all();
    assert.notEqual(rows[0].token_hash, first.data.workSession);
    assert.notEqual(rows[0].device_hash, 'device-teacher-a');
    const second = await withNow(now + 1000, () => call(env, 'login', { pin }));
    assert.equal(second.data.attendance.record.at, now);
    const request = { auth: { ...body('logout').auth, workSession: first.data.workSession } };
    const out = await withNow(now + 3600000, () => call(env, 'logout', request));
    assert.equal(out.status, 200);
    assert.equal(out.data.attendance.record.out, now + 3600000);
    assert.equal(out.data.active, false);
    const again = await withNow(now + 4000000, () => call(env, 'logout', request));
    assert.equal(again.data.attendance.record.out, now + 3600000);
    assert.equal((await gate(env, second.data.workSession)).data.code, 'STAFF_WORK_LOGIN_REQUIRED');
    assert.equal((await call(env, 'login', { pin })).data.code, 'STAFF_WORK_ALREADY_CLOCKED_OUT');
    assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM tokens WHERE revoked=0').get().n, 3);
  });
});

test('manager/admin and non-enrolled teacher retain previous flow and feature flag permits additive rollout', async () => {
  const env = await fixture();
  for (const auth of [manager, { scope: 'all' }, { id: 'teacher-b', scope: 'own' }]) {
    const result = await call(env, 'status', {}, auth);
    assert.equal(result.status, 200);
    assert.equal(result.data.required, false);
    assert.equal(await gate(env, '', '/sync', auth), null);
  }
  env.WB_STAFF_WORK_LOGIN_ENABLED = 'false';
  env.DB.db.exec('DROP TABLE staff_private_profiles; DROP TABLE staff_work_sessions;');
  assert.equal((await call(env, 'status')).data.required, false);
  assert.equal(await gate(env), null);
  env.WB_STAFF_WORK_LOGIN_ENABLED = 'true';
  assert.equal((await gate(env)).status, 503);
  assert.equal((await call(env, 'status')).status, 503);
});

test('manager inspection authenticates either manager PIN without exposing the teacher device bearer', async () => {
  const env = await fixture();
  const sourceAuth = { id: 'teacher-a', scope: 'own' };
  const loginInput = { app: 'task', auth: { mode: 'person', id: 'teacher-a', token: 'device-teacher-a' }, action: 'login', pin };
  const loginResponse = await handleManagerInspectionSession(env, 'task', loginInput, '*', sourceAuth, json, new Set(['manager-a']));
  assert.equal(loginResponse.status, 200);
  const logged = await loginResponse.json();
  assert.equal(logged.active, true);
  assert.match(logged.managerSession, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(logged).includes('device-teacher-a'), false);
  assert.equal(JSON.stringify(logged).includes(pin), false);
  const inspectionAuth = await resolveManagerInspectionAuth(env, 'task', {
    mode: 'manager_inspection', managerId: 'manager-a', token: logged.managerSession
  }, new Set(['manager-a']));
  assert.equal(inspectionAuth.scope, 'all');
  assert.equal(inspectionAuth.role, 'manager');
  assert.equal(inspectionAuth.inspection, true);
  const logoutResponse = await handleManagerInspectionSession(env, 'task', {
    app: 'task', auth: { mode: 'manager_inspection', managerId: 'manager-a', token: logged.managerSession }, action: 'logout'
  }, '*', inspectionAuth, json, new Set(['manager-a']));
  assert.equal(logoutResponse.status, 200);
  assert.equal(await resolveManagerInspectionAuth(env, 'task', {
    mode: 'manager_inspection', managerId: 'manager-a', token: logged.managerSession
  }, new Set(['manager-a'])), null);
});

test('five parallel bad attempts reserve only five verification slots then unlock after five minutes', async () => {
  const env = await fixture();
  await withNow(now, async () => {
    const responses = await Promise.all(Array.from({ length: 15 }, () => call(env, 'login', { pin: '9999' })));
    assert.equal(responses.filter(r => r.data.code === 'STAFF_WORK_PIN_INCORRECT').length, 4);
    assert.equal(responses.filter(r => r.data.code === 'STAFF_WORK_PIN_LOCKED').length, 11);
    const state = env.DB.db.prepare('SELECT * FROM staff_private_profiles WHERE staff_id=?').get(teacher.id);
    assert.equal(state.failed_attempts, 5);
    assert.equal(state.attempt_revision, 5);
    assert.equal(state.locked_until, now + 300000);
    assert.equal((await call(env, 'login', { pin })).status, 429);
    assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM checks').get().n, 0);
  });
  const retry = await withNow(now + 300001, () => call(env, 'login', { pin }));
  assert.equal(retry.status, 200);
  assert.equal(env.DB.db.prepare('SELECT failed_attempts n FROM staff_private_profiles WHERE staff_id=?').get(teacher.id).n, 0);
});

test('midnight, credential reset, data generation, and cross-person tokens cannot unlock a session', async () => {
  const env = await fixture();
  const login = await withNow(now, () => call(env, 'login', { pin }));
  assert.equal(await withNow(now, () => gate(env, login.data.workSession)), null);
  const next = await withNow(Date.parse('2026-09-10T00:00:00+09:00'), () => gate(env, login.data.workSession));
  assert.equal(next.data.code, 'STAFF_WORK_LOGIN_REQUIRED');
  env.DB.db.exec('UPDATE app_data_generations SET generation=3');
  assert.equal((await withNow(now, () => gate(env, login.data.workSession))).data.code, 'STAFF_WORK_LOGIN_REQUIRED');
  env.DB.db.exec('UPDATE app_data_generations SET generation=2; UPDATE staff_private_profiles SET credential_revision=2');
  assert.equal((await withNow(now, () => gate(env, login.data.workSession))).data.code, 'STAFF_WORK_LOGIN_REQUIRED');
});

test('status on restored tab resumes active day without changing attendance; logout needs its work token', async () => {
  const env = await fixture();
  await withNow(now, async () => {
    const login = await call(env, 'login', { pin });
    const status = await call(env, 'status', { auth: { ...body('status').auth, workSession: login.data.workSession } });
    assert.equal(status.data.active, true);
    assert.equal(status.data.attendance.record.at, now);
    const out = await call(env, 'logout');
    assert.equal(out.status, 409);
    assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM staff_work_sessions WHERE revoked=0').get().n, 1);
  });
});

test('admin private profiles expose contacts only to managers, enforce CAS and hash PIN resets', async () => {
  const env = await fixture();
  async function profile(input, auth = manager) {
    const response = await handleStaffProfile(env, 'task', input, '*', auth, json);
    return { status: response.status, data: await response.json() };
  }
  assert.equal((await profile({ action: 'list' }, teacher)).status, 403);
  const list = await profile({ action: 'list' });
  assert.equal(list.data.profiles.length, 3);
  assert.equal(list.data.profiles.find(p => p.staffId === teacher.id).phone, '010-0000-0000');
  assert.equal(JSON.stringify(list).includes('pin_hash'), false);
  const update = await profile({ action: 'update', staffId: teacher.id, phone: '010-0000-0001', expectedRevision: 1 });
  assert.equal(update.data.revision, 2);
  const stale = await profile({ action: 'update', staffId: teacher.id, phone: '', expectedRevision: 1 });
  assert.equal(stale.data.code, 'STAFF_PROFILE_CONFLICT');
  const reset = await profile({ action: 'reset_pin', staffId: teacher.id, pin: '9372', expectedRevision: 2 });
  assert.equal(reset.status, 200);
  assert.equal(reset.data.revision, 3);
  const saved = env.DB.db.prepare('SELECT * FROM staff_private_profiles WHERE staff_id=?').get(teacher.id);
  assert.equal(saved.phone, '010-0000-0001');
  assert.notEqual(saved.pin_hash, '9372');
  assert.equal(saved.pin_hash, await deriveStaffPinHash('9372', saved.pin_salt, pepper));
  assert.equal((await withNow(now, () => call(env, 'login', { pin: '9372' }))).status, 200);
  const publicRows = env.DB.db.prepare('SELECT data FROM staff').all();
  assert.equal(JSON.stringify(publicRows).includes('010-'), false);
});

test('actual deployed entry gates sync, attendance, search, curriculum and other teacher writes', async () => {
  const env = await fixture();
  await withNow(now, async () => {
    for (const path of ['/sync', '/staff-attendance', '/search', '/curriculum', '/book-issue', '/lesson-create', '/feedback-polish', '/parent-portal']) {
      const response = await worker.fetch(new Request('https://test.invalid' + path, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body('clock_in')) }), env, {});
      assert.equal(response.status, 409, path);
      assert.equal((await response.json()).code, 'STAFF_WORK_LOGIN_REQUIRED', path);
    }
    const request = new Request('https://test.invalid/staff-work-session', { method: 'POST',
      body: JSON.stringify(body('login', teacher, { pin })) });
    const login = await worker.fetch(request, env, {});
    assert.equal(login.status, 200);
    assert.equal((await login.json()).active, true);
    const invalid = await worker.fetch(new Request('https://test.invalid/staff-work-session', { method: 'POST',
      body: JSON.stringify({ ...body('status'), auth: { ...body('status').auth, token: 'invalid' } }) }), env, {});
    assert.equal(invalid.status, 401);
  });
});

test('invalid PIN format/configuration and missing generation fail without fabricating attendance', async () => {
  const env = await fixture();
  assert.equal((await call(env, 'login', { pin: '12' })).status, 400);
  env.WB_STAFF_PIN_PEPPER = '';
  assert.equal((await call(env, 'login', { pin })).status, 503);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM checks').get().n, 0);
  await assert.rejects(() => deriveStaffPinHash('bad', 'ab'.repeat(16), pepper), /CONFIGURATION_INVALID/);
  env.WB_STAFF_PIN_PEPPER = pepper;
  env.DB.db.exec('DELETE FROM app_data_generations');
  assert.equal((await call(env, 'login', { pin })).status, 503);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM checks').get().n, 0);
});

test('array app normalization cannot bypass the work gate at core or wrapper endpoints', async () => {
  const env = await fixture();
  for (const path of ['/sync', '/staff-attendance', '/search', '/curriculum']) {
    const response = await worker.fetch(new Request('https://test.invalid' + path, { method: 'POST',
      body: JSON.stringify({ ...body('clock_in'), app: ['task'] }) }), env, {});
    assert.equal(response.status, 400, path);
  }
  const response = await guardStaffWorkAccess(env, { ...body(''), app: ['task'] }, teacher, '/sync', '*', json);
  assert.equal(response.status, 409);
});

test('073 migration is additive, idempotent, and mirrored in the canonical schema', () => {
  const migration = readFileSync(new URL('./migrations/073_staff_work_login.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n').trim();
  const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(schema.includes(migration));
  assert.doesNotMatch(migration, /\b(?:DELETE|DROP|UPDATE)\b/i);
  const db = new TestD1();
  db.db.exec(migration);
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM tokens').get().n, 3);
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM staff_work_sessions').get().n, 0);
});

test('075 migration is additive and mirrored in the canonical schema', () => {
  const migration = readFileSync(new URL('./migrations/075_manager_inspection_sessions.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n').trim();
  const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS manager_inspection_sessions/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS manager_inspection_attempts/);
  assert.match(schema, /idx_manager_inspection_sessions_device/);
  assert.doesNotMatch(migration, /\b(?:DELETE|DROP|UPDATE)\b/i);
});
