import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const load = relative => readFile(new URL(relative, import.meta.url), 'utf8');

test('deploy-safe requires an explicit environment and a pinned Wrangler version', async () => {
  const script = await load('./deploy-safe.ps1');
  assert.match(script, /^#requires -Version 7\.0/);
  assert.match(script, /\[ValidateSet\('dry-run', 'preview', 'production'\)\]/);
  assert.match(script, /\[Parameter\(Mandatory = \$true\)\][\s\S]*\[string\]\$Environment/);
  assert.match(script, /\$WranglerPackage = 'wrangler@4\.118\.0'/);
  assert.match(script, /\$NpxExecutable = if \(\$IsWindows\) \{ 'npx\.cmd' \} else \{ 'npx' \}/);
  assert.match(script, /& \$script:NpxExecutable --yes \$script:WranglerPackage/);
  assert.doesNotMatch(script, /& npx --yes/);
  assert.doesNotMatch(script, /wrangler@4(?!\.118\.0)/);
  assert.match(script, /dry-run 환경에서는 -Deploy 또는 -ApplyMigrations/);
});

test('production target is exact and health cannot be supplied arbitrarily', async () => {
  const script = await load('./deploy-safe.ps1');
  assert.match(script, /\$ProductionWorkerName = 'wb-sync'/);
  assert.match(script, /\$ProductionDatabaseName = 'wb-sync'/);
  assert.match(script, /\$ProductionDatabaseId = '5d65c2e2-47d9-4947-b402-704719914fd3'/);
  assert.match(script, /\$ProductionAllowedOrigin = 'https:\/\/whdudwns33-wb\.github\.io'/);
  assert.match(script, /\$ProductionHealthOrigin = 'https:\/\/wb-sync\.whdudwns33\.workers\.dev'/);
  assert.doesNotMatch(script, /\[string\]\$HealthUrl/);
  assert.match(script, /\$script:Target\.HealthOrigin \+ '\/health'/);
  assert.match(script, /\[string\]\$ExpectedBackupCommit/);
  assert.match(script, /Verify-Backup \$BackupDirectory \$ExpectedBackupCommit/);
  assert.match(script, /\$ConfirmProduction -ne \$ProductionPhrase/);
});

test('backup gate proves the manifest commit can be restored from the bundle', async () => {
  const script = await load('./deploy-safe.ps1');
  assert.match(script, /기준\\s\*커밋:[^\n]+\(\[A-Fa-f0-9\]\{40\}\)/);
  assert.match(script, /\$ManifestCommit = \$CommitMatch\.Groups\[1\]\.Value\.ToLowerInvariant\(\)/);
  assert.match(script, /승인된 복구 기준 40자리 Git SHA/);
  assert.match(script, /\$ManifestCommit -ne \$ApprovedCommit\.ToLowerInvariant\(\)/);
  assert.match(script, /manifest 기준 커밋이 승인된 복구 기준과 다릅니다/);
  assert.match(script, /git bundle verify \$Bundle/);
  assert.match(script, /git clone --no-checkout --quiet -- \$Bundle \$RestoreProbe/);
  assert.match(script, /\$CommitObject = \$ManifestCommit \+ '\^\{commit\}'/);
  assert.match(script, /git -C \$RestoreProbe cat-file -e \$CommitObject/);
  assert.match(script, /git -C \$RestoreProbe fsck --full/);
  assert.match(script, /try \{[\s\S]*git clone --no-checkout[\s\S]*\} finally \{\s*Remove-VerifiedTemporaryDirectory/);
});

test('backup restore probe cleanup is restricted to its exact generated temp child', async () => {
  const script = await load('./deploy-safe.ps1');
  assert.match(script, /Get-StrictTemporaryChildPath \$TemporaryRoot \$RestoreProbeLeaf/);
  assert.match(script, /\$TargetFull -eq \$RootFull/);
  assert.match(script, /StartsWith\(\$RootFull \+ \[IO\.Path\]::DirectorySeparatorChar, \[StringComparison\]::OrdinalIgnoreCase\)/);
  assert.match(script, /\[IO\.Path\]::GetFileName\(\$TargetFull\) -cne \$ExpectedLeaf/);
  assert.match(script, /Remove-Item -LiteralPath \$TargetFull -Recurse -Force/);
  assert.doesNotMatch(script, /Remove-Item\s+(?:-Recurse\s+)?-Force\s+\$TemporaryRoot/);
});

test('preview configuration is isolated, ignored, and rejects production identifiers', async () => {
  const [script, example, gitignore] = await Promise.all([
    load('./deploy-safe.ps1'),
    load('./wrangler.preview.example.toml'),
    load('../.gitignore')
  ]);
  assert.match(gitignore, /^sync\/wrangler\.preview\.toml$/m);
  assert.match(example, /^name = "wb-sync-preview"$/m);
  assert.match(example, /^database_name = "wb-sync-preview"$/m);
  assert.match(example, /REPLACE_WITH_REAL_PREVIEW_D1_UUID/);
  assert.match(example, /LEARNING_V2_ENABLED = "false"/);
  assert.match(script, /preview D1 UUID가 production D1 UUID와 같아서는 안 됩니다/);
  assert.match(script, /preview ALLOW_ORIGIN은 production origin과 달라야 합니다/);
  assert.match(script, /\$PreviewHealthOrigin = 'https:\/\/wb-sync-preview\.whdudwns33\.workers\.dev'/);
  assert.match(script, /wrangler\.preview\.toml이 없습니다/);
});

test('migrations run once in the ordered loop and exact ledger rows are asserted', async () => {
  const script = await load('./deploy-safe.ps1');
  assert.match(script, /\(\$Deploy -and -not \$ApplyMigrations\)[\s\S]*\(\$ApplyMigrations -and -not \$Deploy\)/);
  assert.match(script, /Worker 배포와 D1 마이그레이션은 같은 승인 실행에서 함께만 허용됩니다/);
  assert.match(script, /\$Environment -eq 'production' -and \$IsMutation/);
  assert.doesNotMatch(script, /\$Environment -eq 'production' -and \$Deploy\)/);
  assert.equal((script.match(/File = '003_token_hash_prefix\.sql'/g) || []).length, 1);
  assert.doesNotMatch(script, /--file=\.\\migrations\\003_token_hash_prefix\.sql/);
  assert.match(script, /\$ActualMigrationNames -join '\|'/);
  assert.match(script, /SELECT version,name,applied_at FROM lp_schema_migrations ORDER BY version/);
  assert.match(script, /\$Rows\.Count -ne \$ExpectedMigrations\.Count/);
  assert.match(script, /learning_platform_v2/);
  assert.match(script, /token_bootstrap_hardening/);
});

test('D1 and Worker operations create receipts and production stops at static pending', async () => {
  const script = await load('./deploy-safe.ps1');
  assert.match(script, /\.release-receipts/);
  assert.match(script, /Add-ReceiptOperation 'd1' 'migration-ledger'/);
  assert.match(script, /Add-ReceiptOperation 'worker' 'deploy-compatible-before-token-transform'/);
  assert.match(script, /Capture-WorkerDeployments 'before'/);
  assert.match(script, /Capture-WorkerDeployments 'after'/);
  assert.match(script, /worker_succeeded_static_pending/);
  assert.match(script, /-StaticArtifactVerified/);
  assert.match(script, /maintenance window ID/);
  assert.match(script, /\$BackupVerification = Verify-Backup \$BackupDirectory \$ExpectedBackupCommit/);
  assert.match(script, /backup = \$BackupVerification/);
  assert.match(script, /expectedCommit = \$ApprovedCommit\.ToLowerInvariant\(\)/);
  assert.match(script, /manifest = \[ordered\]@\{/);
  assert.match(script, /bundle = \[ordered\]@\{/);
  assert.match(script, /d1 = \[ordered\]@\{/);
});

test('compatible Worker precedes token transforms and active bearer is smoked on both sides', async () => {
  const script = await load('./deploy-safe.ps1');
  const schemaAt = script.indexOf("Add-ReceiptOperation 'd1' 'schema.sql'");
  const deployAt = script.indexOf("Add-ReceiptOperation 'worker' 'deploy-compatible-before-token-transform'");
  const preHealthAt = script.indexOf("Invoke-WorkerHealthSmoke 'pre-migration'");
  const migrationAt = script.indexOf('foreach ($Migration in $MigrationFiles)');
  const postHealthAt = script.indexOf("Invoke-WorkerHealthSmoke 'post-migration'");
  assert.ok(schemaAt >= 0 && schemaAt < deployAt);
  assert.ok(deployAt < preHealthAt && preHealthAt < migrationAt);
  assert.ok(migrationAt < postHealthAt);
  assert.match(script, /Get-ActiveTokenInventory/);
  assert.match(script, /token_normalization_conflict_total/);
  assert.match(script, /tokenNormalizationConflictTotal -gt 0/);
  assert.match(script, /GROUP BY app, lower\(token\)/);
  assert.match(script, /lower\(canonical\.token\)='sha256:' \|\| target\.digest/);
  assert.match(script, /대소문자를 정규화했을 때 같은 대상/);
  assert.match(script, /activeTotal -gt 0 -and \$null -eq \$AuthSmokeCredential/);
  assert.match(script, /AuthSmokeFile은 repository 밖의 절대 경로/);
  assert.match(script, /personal-bearer-\$Phase/);
  assert.match(script, /staffIdSha256/);
  assert.match(script, /failedPhase/);
  assert.match(script, /compatibleWorkerDeployed/);
  assert.match(script, /tokenTransformStarted/);
});

test('token inventory SQL detects case-normalized conflicts regardless of row state', async () => {
  const script = await load('./deploy-safe.ps1');
  const match = script.match(/'--command', "(WITH bare_targets [^"\r\n]+)"/);
  assert.ok(match, 'token inventory SQL must be extractable');
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE tokens (
      app TEXT NOT NULL, token TEXT NOT NULL, staff_id TEXT NOT NULL,
      created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (app, token)
    );
  `);
  const insert = database.prepare(
    'INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,?)'
  );
  const digestA = 'a'.repeat(64);
  const digestB = 'b'.repeat(64);
  insert.run('consult', digestA, 'A', 1, 1);
  insert.run('consult', digestA.toUpperCase(), 'B', 1, 1);
  insert.run('task', digestB, 'A', Date.now(), 0);
  insert.run('task', 'SHA256:' + digestB.toUpperCase(), 'B', 1, 1);
  insert.run('other', 'sha256:' + 'c'.repeat(64), 'C', Date.now(), 0);

  const conflicted = database.prepare(match[1]).get();
  assert.equal(conflicted.active_total, 2);
  assert.equal(conflicted.prefixed_total, 1);
  assert.equal(conflicted.migratable_bare_total, 1);
  assert.equal(conflicted.token_normalization_conflict_total, 2);

  database.prepare("DELETE FROM tokens WHERE app IN ('consult','task')").run();
  const clean = database.prepare(match[1]).get();
  assert.equal(clean.active_total, 1);
  assert.equal(clean.token_normalization_conflict_total, 0);
  database.close();
});

test('release docs state the missing preview resources and compatible rollback boundary', async () => {
  const [readme, release, rollback, architecture] = await Promise.all([
    load('./README.md'),
    load('../docs/learning-platform-v2/RELEASE_CHECKLIST.md'),
    load('../docs/learning-platform-v2/ROLLBACK.md'),
    load('../docs/learning-platform-v2/ARCHITECTURE.md')
  ]);
  const combined = [readme, release, rollback].join('\n');
  assert.match(combined, /preview Worker와 preview D1은 아직 생성되지 않았다/);
  assert.match(combined, /maintenance window/i);
  assert.match(combined, /24시간/);
  assert.match(readme, /ExpectedBackupCommit e44383727cd136dfee082022b4d633ab5edd4745/);
  assert.match(readme, /ApplyMigrations.*Deploy.*같은 승인 실행/);
  assert.match(readme, /PowerShell 7\(`pwsh`\) 이상이 필수/);
  assert.equal((readme.match(/pwsh -File \.\\deploy-safe\.ps1/g) || []).length, 3);
  assert.match(release, /pwsh -File \.\\sync\\deploy-safe\.ps1/);
  assert.match(release, /Environment preview[^`\n]*-ExpectedCommit <검증한-preview-40자리-SHA>/);
  assert.match(rollback, /sha256.*bootstrap/i);
  assert.match(rollback, /호환 rollback 정적 산출물/);
  assert.match(rollback, /호환 Worker 배포 뒤.*002.*003/);
  assert.match(readme, /동일 bearer가 토큰 변환 전·후/);
  assert.match(release, /비변환 schema.*호환 Worker.*pre-migration.*002\/003.*post-migration/);
  assert.match(release, /token normalization conflict 0건/);
  assert.match(readme, /migration 자체도.*활성 bare를 먼저 삭제하지 않고.*실패 종료/);
  assert.match(rollback, /LEARNING_V2_ENABLED=false/);
  assert.doesNotMatch(architecture, /CSV·JSON·PDF 결과의 수동 후보 등록/);
  assert.match(architecture, /CSV·JSON 결과의 수동 후보 등록/);
});
