import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { filterPrivateAsset } from './worker-core.js';

const syncDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(syncDirectory, '..');
const buildToolPath = path.join(syncDirectory, 'tools', 'build-private-assets-sql.mjs');
const sanitizeToolPath = path.join(syncDirectory, 'tools', 'sanitize-public-private-assets.mjs');
const worker = fs.readFileSync(new URL('./worker-core.js', import.meta.url), 'utf8');
const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/005_private_assets.sql', import.meta.url), 'utf8');
const task = fs.readFileSync(new URL('../task/index.html', import.meta.url), 'utf8');
const buildTool = fs.readFileSync(buildToolPath, 'utf8');
const sanitizeTool = fs.readFileSync(sanitizeToolPath, 'utf8');
const readme = fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8');
const deployGuide = fs.readFileSync(new URL('../docs/배포-가이드-v0.md', import.meta.url), 'utf8');

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-private-assets-test-'));
  const repo = path.join(root, 'public-repo');
  const external = path.join(root, 'private-inputs');
  fs.mkdirSync(path.join(repo, 'task'), { recursive: true });
  fs.mkdirSync(external, { recursive: true });
  writeJson(path.join(repo, 'version.json'), { v: '2026-08-03.3' });
  writeJson(path.join(repo, 'task', 'roster.json'), {
    updated: '2026-08-03', baseline: '2026-08',
    note: '인증된 운영 앱에서만 제공되는 자료입니다.', students: []
  });
  writeJson(path.join(repo, 'task', 'textbooks.json'), {
    updated: '2026-08-03', note: '인증된 운영 앱에서만 제공되는 자료입니다.',
    vendors: [], books: [], students: []
  });
  const roster = path.join(external, 'roster.private.json');
  const textbooks = path.join(external, 'textbooks.private.json');
  writeJson(roster, { students: [{ name: 'TEST-STUDENT', teacher: 'TEST-TEACHER' }] });
  writeJson(textbooks, {
    students: [{ name: 'TEST-STUDENT', teacher: 'TEST-TEACHER' }],
    books: [{ id: 'TEST-BOOK' }], vendors: [{ id: 'TEST-VENDOR' }]
  });
  return { root, repo, external, roster, textbooks };
}

function runTool(script, args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 15_000 });
}

function buildArgs(fixture, output, receipt) {
  return [
    '--repo', fixture.repo,
    '--roster-input', fixture.roster,
    '--textbooks-input', fixture.textbooks,
    '--out', output,
    '--receipt', receipt,
    '--roster-sha', sha256(fs.readFileSync(fixture.roster)),
    '--textbooks-sha', sha256(fs.readFileSync(fixture.textbooks)),
    '--roster-students', '1',
    '--textbook-students', '1',
    '--books', '1',
    '--vendors', '1'
  ];
}

function writeD1Receipt(file, build, overrides = {}) {
  const assets = Object.fromEntries(Object.entries(build.assets).map(([key, value]) => [key, {
    ...value,
    updatedAt: build.updatedAt,
    jsonValid: true,
    contentHashVerified: true
  }]));
  writeJson(file, {
    schemaVersion: 1,
    kind: 'wb-private-assets-d1-verification',
    verified: true,
    verifiedAt: Date.now(),
    app: 'task',
    databaseId: 'test-d1-database',
    buildId: build.buildId,
    sqlSha256: build.sql.sha256,
    operationId: 'test-operation-0001',
    workerDeploymentId: 'preview-test-deployment',
    workerOrigin: 'https://preview.example.test',
    adminScopeVerified: true,
    personScopeVerified: true,
    rowCount: 2,
    jsonValid: 2,
    assets,
    ...overrides
  });
}

test('private asset schema is additive and standalone', () => {
  for (const source of [schema, migration]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS private_assets/);
    assert.match(source, /PRIMARY KEY \(app, asset_key\)/);
  }
  assert.doesNotMatch(migration, /DROP TABLE|DELETE FROM|UPDATE (?:staff|tasks|checks|tokens)/i);
});

test('private asset endpoint requires normal app authentication', () => {
  assert.match(worker, /handlePrivateAsset/);
  assert.match(worker, /resolveAuth\(env, app, body\.auth\)/);
  assert.match(worker, /url\.pathname === '\/private-asset'/);
  assert.match(worker, /SELECT data,updated_at,content_hash FROM private_assets/);
});

test('roster is filtered to the authenticated teacher', () => {
  const source = {
    updated: '2026-08-01', baseline: '2026-08',
    students: [
      { name: '함께', teacher: '최인찬·김남기' },
      { name: '본인', teacher: '김남기' },
      { name: '다른반', teacher: '김동현' }
    ]
  };
  const result = filterPrivateAsset('roster', source, '김남기');
  assert.deepEqual(result.students.map(student => student.name), ['함께', '본인']);
  assert.equal(source.students.length, 3);
});

test('textbook student progress is filtered but shared book metadata remains', () => {
  const source = {
    vendors: [{ name: '거래처' }], books: [{ id: 'B1' }],
    students: [{ name: '본인', teacher: '김남기' }, { name: '타인', teacher: '김동현' }]
  };
  const result = filterPrivateAsset('textbooks', source, '김남기');
  assert.equal(result.students.length, 1);
  assert.equal(result.students[0].name, '본인');
  assert.equal(result.books.length, 1);
  assert.equal(result.vendors.length, 1);
});

test('task app no longer fetches public roster or textbook JSON', () => {
  assert.match(task, /sync\.privateAsset\('roster'\)/);
  assert.match(task, /sync\.privateAsset\('textbooks'\)/);
  assert.doesNotMatch(task, /fetch\(['"](?:roster|textbooks)\.json/);
  assert.match(task, /case 'retrybooks'/);
  assert.match(task, /case 'retryroster'/);
});

test('private asset tools require external sources and linked receipts', () => {
  assert.match(buildTool, /explicit-external-input-only/);
  assert.match(buildTool, /realExternalFile/);
  assert.match(buildTool, /openSync\(file, 'wx'/);
  assert.match(buildTool, /ON CONFLICT\(app,asset_key\) DO UPDATE/);
  assert.doesNotMatch(buildTool, /BEGIN TRANSACTION|COMMIT;/);
  assert.match(sanitizeTool, /wb-private-assets-d1-verification/);
  assert.match(sanitizeTool, /buildId/);
  assert.match(sanitizeTool, /roll-forward-only/);
});

test('external build and repeated stub sanitization succeed without repository inputs', t => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const output = path.join(fixture.external, 'private-assets.sql');
  const buildReceiptFile = path.join(fixture.external, 'build-receipt.json');
  const built = runTool(buildToolPath, buildArgs(fixture, output, buildReceiptFile));
  assert.equal(built.status, 0, built.stderr);
  const build = JSON.parse(fs.readFileSync(buildReceiptFile, 'utf8'));
  assert.equal(build.sourcePolicy, 'explicit-external-input-only');
  assert.equal(build.sourcePathsStored, false);
  assert.equal(build.pagesRollbackFloor, '2026-08-03.3');
  assert.ok(Number.isSafeInteger(build.updatedAt));
  assert.doesNotMatch(JSON.stringify(build), /private-inputs|roster\.private|textbooks\.private/);
  assert.doesNotMatch(fs.readFileSync(output, 'utf8'), /BEGIN TRANSACTION|COMMIT;/);

  const d1ReceiptFile = path.join(fixture.external, 'd1-receipt.json');
  writeD1Receipt(d1ReceiptFile, build);
  const commonSanitizeArgs = [
    '--repo', fixture.repo,
    '--roster-input', fixture.roster,
    '--textbooks-input', fixture.textbooks,
    '--roster-sha', sha256(fs.readFileSync(fixture.roster)),
    '--textbooks-sha', sha256(fs.readFileSync(fixture.textbooks)),
    '--build-receipt', buildReceiptFile,
    '--d1-receipt', d1ReceiptFile,
    '--database-id', 'test-d1-database'
  ];
  const firstReceipt = path.join(fixture.external, 'sanitize-first.json');
  const first = runTool(sanitizeToolPath, [...commonSanitizeArgs, '--sanitize-receipt', firstReceipt]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(fs.readFileSync(firstReceipt, 'utf8')).gitHistoryVerified, false);

  const secondReceipt = path.join(fixture.external, 'sanitize-second.json');
  const second = runTool(sanitizeToolPath, [...commonSanitizeArgs, '--sanitize-receipt', secondReceipt]);
  assert.equal(second.status, 0, second.stderr);
  const secondResult = JSON.parse(second.stdout);
  assert.equal(secondResult.publicStubs.roster.action, 'stub-refresh');
  assert.equal(secondResult.publicStubs.textbooks.action, 'stub-refresh');
});

test('tools reject in-repository private input and a forged D1 build link', t => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const output = path.join(fixture.external, 'private-assets.sql');
  const buildReceiptFile = path.join(fixture.external, 'build-receipt.json');
  const insideRoster = path.join(fixture.repo, 'inside-private.json');
  fs.copyFileSync(fixture.roster, insideRoster);
  const insideArgs = buildArgs(fixture, output, buildReceiptFile);
  insideArgs[insideArgs.indexOf(fixture.roster)] = insideRoster;
  const inside = runTool(buildToolPath, insideArgs);
  assert.notEqual(inside.status, 0);
  assert.match(inside.stderr, /repository 밖/);

  const built = runTool(buildToolPath, buildArgs(fixture, output, buildReceiptFile));
  assert.equal(built.status, 0, built.stderr);
  const build = JSON.parse(fs.readFileSync(buildReceiptFile, 'utf8'));
  const d1ReceiptFile = path.join(fixture.external, 'forged-d1-receipt.json');
  writeD1Receipt(d1ReceiptFile, build, { buildId: 'A'.repeat(64) });
  const sanitize = runTool(sanitizeToolPath, [
    '--repo', fixture.repo,
    '--roster-input', fixture.roster,
    '--textbooks-input', fixture.textbooks,
    '--roster-sha', sha256(fs.readFileSync(fixture.roster)),
    '--textbooks-sha', sha256(fs.readFileSync(fixture.textbooks)),
    '--build-receipt', buildReceiptFile,
    '--d1-receipt', d1ReceiptFile,
    '--sanitize-receipt', path.join(fixture.external, 'must-not-exist.json'),
    '--database-id', 'test-d1-database'
  ]);
  assert.notEqual(sanitize.status, 0);
  assert.match(sanitize.stderr, /build 연결/);
  assert.equal(fs.existsSync(path.join(fixture.external, 'must-not-exist.json')), false);
});

test('operations docs pin the private-asset rollback floor and recovery semantics', () => {
  assert.match(readme, /2026-08-03\.3/);
  assert.match(readme, /roll-forward only|roll-forward-only/);
  assert.match(readme, /Git 과거 이력/);
  assert.match(readme, /사람의 명시적 승인/);
  assert.match(readme, /\/admin-recover/);
  assert.match(readme, /24시간/);
  assert.match(readme, /admin_sessions/);
  assert.match(readme, /admin_bootstrap_codes/);
  assert.match(deployGuide, /2026-08-03\.3/);
  assert.match(deployGuide, /roll-forward only|roll-forward-only/);
  const currentVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'version.json'), 'utf8')).v;
  const [currentDate, currentRevision] = currentVersion.split('.');
  assert.ok(currentDate > '2026-08-03' || (currentDate === '2026-08-03' && Number(currentRevision) >= 3));
});
