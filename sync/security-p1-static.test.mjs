import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const worker = fs.readFileSync(new URL('./worker-core.js', import.meta.url), 'utf8');
const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/004_security_access_v1.sql', import.meta.url), 'utf8');
const adminMigration = fs.readFileSync(new URL('./migrations/006_admin_sessions.sql', import.meta.url), 'utf8');
const searchWrapper = fs.readFileSync(new URL('./search-filter.js', import.meta.url), 'utf8');
const curriculumWrapper = fs.readFileSync(new URL('./curriculum-fix.js', import.meta.url), 'utf8');

test('personal auth is always owner scoped', () => {
  assert.match(worker, /return \{ scope: 'own', id: id, kind: 'person' \};/);
  assert.doesNotMatch(worker, /app === 'task' \? \{ scope: 'all'/);
});

test('new bearer tokens are hashed and expire', () => {
  assert.match(worker, /TOKEN_HASH_PREFIX = 'sha256:'/);
  assert.match(worker, /tokenStorageValue\(await sha256Hex\(token\)\)/);
  assert.match(worker, /TOKEN_TTL_MS/);
  assert.match(worker, /token\.startsWith\(TOKEN_HASH_PREFIX\)/);
});

test('bootstrap exchange and handoff routes exist', () => {
  for (const route of ['/bootstrap', '/exchange', '/handoff']) {
    assert.ok(worker.includes(`url.pathname === '${route}'`), route);
  }
  assert.match(worker, /HANDOFF_TTL_MS = 10 \* 60 \* 1000/);
  assert.match(worker, /consumed_at IS NULL/);
  assert.match(worker, /만료되었거나 이미 사용한 링크입니다/);
});

test('staff revoke invalidates bearer and bootstrap rows', () => {
  assert.match(worker, /UPDATE tokens SET revoked=1 WHERE app=\? AND staff_id=\?/);
  assert.match(worker, /UPDATE bootstrap_codes SET revoked=1 WHERE app=\? AND staff_id=\?/);
});

test('unauthorized personal writes fail instead of reporting a false success', () => {
  assert.match(worker, /let forbidden = false/);
  assert.match(worker, /개인 링크에서는 본인 업무만 저장할 수 있습니다/);
  assert.match(worker, /403, origin/);
});

test('security schema migration is additive and standalone', () => {
  for (const source of [schema, migration]) {

    assert.match(source, /CREATE TABLE IF NOT EXISTS bootstrap_codes/);
    assert.match(source, /CREATE INDEX IF NOT EXISTS idx_bootstrap_staff/);
  }
  assert.doesNotMatch(migration, /DROP TABLE|DELETE FROM|UPDATE tokens|lp_schema_migrations/i);
});

test('admin sessions are cryptographically separate from personal tokens', () => {
  assert.match(worker, /ADMIN_CODE_HASH_PREFIX = 'admin-code-sha256:'/);
  assert.match(worker, /ADMIN_TOKEN_HASH_PREFIX = 'admin-token-sha256:'/);
  assert.match(worker, /auth\.mode === 'admin_session'/);
  assert.match(worker, /kind: 'admin_session'/);
  for (const route of ['/admin-recover', '/admin-exchange', '/admin-handoff', '/admin-revoke']) {
    assert.ok(worker.includes(`url.pathname === '${route}'`), route);
  }
  for (const source of [schema, adminMigration]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS admin_bootstrap_codes/);
    assert.match(source, /CREATE TABLE IF NOT EXISTS admin_sessions/);
  }
  assert.doesNotMatch(adminMigration, /DROP TABLE|DELETE FROM|UPDATE (?:staff|tasks|checks|tokens)/i);
});

test('root recovery revokes old admin access before issuing a 24 hour session', () => {
  assert.match(worker, /async function handleAdminRecover/);
  assert.match(worker, /auth.kind !== 'root_secret'/);
  assert.match(worker, /UPDATE admin_bootstrap_codes SET revoked=1/);
  assert.match(worker, /UPDATE admin_sessions SET revoked=1/);
  assert.match(worker, /ADMIN_SESSION_TTL_MS/);
});

test('search and curriculum wrappers use the canonical hashed-token resolver', () => {
  assert.match(worker, /export async function resolveAuth/);
  assert.match(searchWrapper, /import baseWorker, { resolveAuth } from '.\/worker-core\.js'/);
  assert.match(curriculumWrapper, /import { resolveAuth } from '.\/worker-core\.js'/);
  for (const source of [searchWrapper, curriculumWrapper]) {
    assert.doesNotMatch(source, /async function resolveAuth/);
    assert.doesNotMatch(source, /SELECT staff_id FROM tokens/);
  }
});
test('sensitive responses use no-store and no-referrer', () => {
  assert.match(worker, /'Cache-Control': 'no-store'/);
  assert.match(worker, /'Referrer-Policy': 'no-referrer'/);
  assert.match(worker, /'X-Content-Type-Options': 'nosniff'/);
});
