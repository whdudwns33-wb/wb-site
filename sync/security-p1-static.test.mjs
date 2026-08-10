import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const worker = fs.readFileSync(new URL('./worker-core.js', import.meta.url), 'utf8');
const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/004_security_access_v1.sql', import.meta.url), 'utf8');
const deployScript = fs.readFileSync(new URL('./deploy.ps1', import.meta.url), 'utf8');

test('every personal link stays owner scoped regardless of staff role', () => {
  assert.match(worker, /!await activeStaff\(env, app, id\)/);
  assert.match(worker, /return \{ scope: 'own', id: id \};/);
  assert.doesNotMatch(worker, /staff\.manager[^\n]*scope: 'all'/);
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
  assert.match(worker, /MAX_PENDING_BOOTSTRAPS = 3/);
  assert.match(worker, /MAX_ACTIVE_PERSON_SESSIONS = 3/);
  assert.match(worker, /consumed_at IS NULL/);
  for (const code of ['LINK_INVALID', 'LINK_USED', 'LINK_EXPIRED', 'LINK_REPLACED', 'AUTH_REQUIRED']) {
    assert.ok(worker.includes(`code: '${code}'`), code);
  }
  assert.match(worker, /expires_at<\?/);
  assert.doesNotMatch(worker,
    /UPDATE bootstrap_codes SET revoked=1 WHERE app=\? AND staff_id=\? AND revoked=0 AND consumed_at IS NULL['"]/);
  assert.doesNotMatch(worker,
    /UPDATE tokens SET revoked=1 WHERE app=\? AND staff_id=\? AND revoked=0 AND EXISTS/);
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

test('sensitive responses use no-store and no-referrer', () => {
  assert.match(worker, /'Cache-Control': 'no-store'/);
  assert.match(worker, /'Referrer-Policy': 'no-referrer'/);
  assert.match(worker, /'X-Content-Type-Options': 'nosniff'/);
});

test('deployment helper never writes admin secrets into the repository', () => {
  assert.doesNotMatch(deployScript, /Set-Content\s+\.\\배포결과\.txt/);
  assert.doesNotMatch(deployScript, /클로드에게 그대로 붙여넣/);
});
