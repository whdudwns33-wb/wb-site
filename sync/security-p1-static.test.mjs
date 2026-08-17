import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const worker = fs.readFileSync(new URL('./worker-core.js', import.meta.url), 'utf8');
const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/004_security_access_v1.sql', import.meta.url), 'utf8');
const deployScript = fs.readFileSync(new URL('./deploy.ps1', import.meta.url), 'utf8');
const portalRunbook = fs.readFileSync(new URL('./PORTAL_RELEASE_RUNBOOK.md', import.meta.url), 'utf8');
const portalProbe = fs.readFileSync(new URL('./portal-release-probe.sql', import.meta.url), 'utf8');
const mainWrangler = fs.readFileSync(new URL('./wrangler.toml', import.meta.url), 'utf8');
const studentWrangler = fs.readFileSync(new URL('./wrangler.student.toml', import.meta.url), 'utf8');

test('only the task environment allowlist elevates personal auth', () => {
  assert.match(worker, /const staff = await activeStaffData\(env, app, id\)/);
  assert.match(worker, /TASK_MANAGER_STAFF_IDS/);
  assert.match(worker, /TASK_MANAGER_STAFF_IDS_CONFIG/);
  assert.match(worker, /\.flatMap\(value => String\(value \|\| ''\)\.split\(','\)\)/);
  assert.match(worker, /app === 'task' && taskManagerIds\(env\)\.has\(id\)/);
  assert.match(worker, /return \{ scope: 'all', id: id, role: 'manager' \}/);
  assert.match(worker, /return \{ scope: 'own', id: id \};/);
  assert.doesNotMatch(worker, /staff\.manager\s*===\s*true/);
  assert.doesNotMatch(worker, /app === 'consult'[^\n]*scope: 'all'/);
});

test('sync returns the server auth role and stamps manager task audit fields', () => {
  assert.match(worker, /authRole/);
  assert.match(worker, /auth\.role === 'manager' \? 'manager'/);
  assert.match(worker, /\$\.lastEditBy', 'manager'/);
  assert.match(worker, /json_extract\(tasks\.data,'\$\.origin'\)/);
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

test('기존 운영 DB의 포털 배포는 중복 migration과 역순 배포를 차단한다', () => {
  assert.match(portalRunbook, /deploy\.ps1.*새 설치 전용/);
  assert.match(portalRunbook, /--command "\$PORTAL_PROBE_SQL"/);
  assert.match(portalRunbook, /sed '\/\^\[\[:space:\]\]\*--\/d'/);
  assert.doesNotMatch(portalRunbook, /--file=\.\/portal-release-probe\.sql/);
  assert.ok(portalRunbook.indexOf('036_guardian_announcements.sql') < portalRunbook.indexOf('037_book_order_identity_snapshots.sql'));
  assert.ok(portalRunbook.indexOf('037_book_order_identity_snapshots.sql') < portalRunbook.indexOf('038_student_portal.sql'));
  assert.ok(portalRunbook.indexOf('038_student_portal.sql') < portalRunbook.indexOf('039_student_portal_scope_v2.sql'));
  assert.match(portalRunbook, /`038`과 `039`에는 `ALTER TABLE`이 있으므로 맹목적으로 재실행하면 안 된다/);
  assert.match(portalRunbook, /`10\/10`, `21\/21`, `10\/10`, `2\/2`, `4\/4`, `4\/4`/);
  assert.match(portalRunbook, /연결을 끈 뒤.*모두 접근이 거절/s);
  assert.match(portalRunbook, /Origin: https:\/\/whdudwns33-wb\.github\.io/);
  assert.match(portalRunbook, /학생 앱 전용 주소/);
  assert.match(portalProbe, /idx_book_order_one_active_target/);
  assert.match(portalProbe, /'migration_036_objects'.*COUNT\(schema\.name\).*COUNT\(\*\)/s);
  assert.match(portalProbe, /'migration_037_objects'.*COUNT\(schema\.name\).*COUNT\(\*\)/s);
  assert.match(portalProbe, /'migration_038_objects'.*COUNT\(schema\.name\).*COUNT\(\*\)/s);
  assert.match(portalProbe, /'migration_038_columns'.*COUNT\(found\.column_name\).*COUNT\(\*\)/s);
  assert.match(portalProbe, /'migration_039_objects'.*COUNT\(schema\.name\).*COUNT\(\*\)/s);
  assert.match(portalProbe, /'migration_039_columns'.*COUNT\(found\.column_name\).*COUNT\(\*\)/s);
  assert.match(mainWrangler, /WB_STUDENT_PORTAL_BASE_URL\s*=\s*"https:\/\/wb-student\.whdudwns33\.workers\.dev\/"/);
  assert.match(studentWrangler, /WB_STUDENT_PORTAL_BASE_URL\s*=\s*"https:\/\/wb-student\.whdudwns33\.workers\.dev\/"/);
});

test('포털 배포 probe는 fresh schema의 선행 구조와 036~039 객체를 정확히 센다', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  const rows = portalProbe.split(';').map(statement => statement.trim()).filter(Boolean)
    .map(statement => database.prepare(statement).get());
  assert.deepEqual(rows.map(row => [row.check_name, Number(row.found), Number(row.expected)]), [
    ['prerequisite_tables', 9, 9],
    ['migration_036_objects', 10, 10],
    ['migration_037_objects', 21, 21],
    ['migration_038_objects', 10, 10],
    ['migration_038_columns', 2, 2],
    ['migration_039_objects', 4, 4],
    ['migration_039_columns', 4, 4]
  ]);
});
