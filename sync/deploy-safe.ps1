#requires -Version 7.0

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('dry-run', 'preview', 'production')]
  [string]$Environment,
  [switch]$Deploy,
  [switch]$ApplyMigrations,
  [switch]$ValidateConfigurationOnly,
  [string]$BackupDirectory = '',
  [string]$ExpectedBackupCommit = '',
  [string]$ExpectedCommit = '',
  [string]$ConfirmPreview = '',
  [string]$ConfirmProduction = '',
  [string]$MaintenanceWindowId = '',
  [switch]$StaticArtifactVerified,
  [string]$AuthSmokeFile = ''
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$WranglerPackage = 'wrangler@4.118.0'
$NpxExecutable = if ($IsWindows) { 'npx.cmd' } else { 'npx' }
$ProductionPhrase = 'WB-SYNC-PRODUCTION'
$PreviewPhrase = 'WB-SYNC-PREVIEW'
$ProductionWorkerName = 'wb-sync'
$ProductionDatabaseName = 'wb-sync'
$ProductionDatabaseId = '5d65c2e2-47d9-4947-b402-704719914fd3'
$ProductionAllowedOrigin = 'https://whdudwns33-wb.github.io'
$ProductionHealthOrigin = 'https://wb-sync.whdudwns33.workers.dev'
$PreviewWorkerName = 'wb-sync-preview'
$PreviewDatabaseName = 'wb-sync-preview'
$PreviewHealthOrigin = 'https://wb-sync-preview.whdudwns33.workers.dev'
$ExpectedMigrations = @(
  [pscustomobject]@{ File = '002_learning_platform_v2.sql'; Version = 2; Name = 'learning_platform_v2' },
  [pscustomobject]@{ File = '003_token_hash_prefix.sql'; Version = 3; Name = 'token_bootstrap_hardening' }
)

function Step([string]$Message) {
  Write-Host ''
  Write-Host "== $Message ==" -ForegroundColor Cyan
}

function Get-TomlQuotedValue([string]$Text, [string]$Key) {
  $Pattern = '(?m)^\s*' + [regex]::Escape($Key) + '\s*=\s*"([^"]+)"\s*(?:#.*)?$'
  $Matches = [regex]::Matches($Text, $Pattern)
  if ($Matches.Count -ne 1) { throw "$Key 값이 설정에 정확히 한 번 있어야 합니다." }
  return $Matches[0].Groups[1].Value
}

function Assert-Origin([string]$Origin, [string]$Label) {
  $Parsed = $null
  if (-not [Uri]::TryCreate($Origin, [UriKind]::Absolute, [ref]$Parsed)) {
    throw "$Label 값이 절대 URL이 아닙니다."
  }
  if ($Parsed.Scheme -ne 'https' -or $Parsed.AbsolutePath -ne '/' -or $Parsed.Query -or $Parsed.Fragment -or $Parsed.UserInfo) {
    throw "$Label 값은 경로·쿼리·fragment·자격정보가 없는 HTTPS origin이어야 합니다."
  }
}

function Read-And-ValidateTarget([pscustomobject]$Target) {
  if (-not (Test-Path -LiteralPath $Target.ConfigPath -PathType Leaf)) {
    if ($Target.Environment -eq 'preview') {
      throw 'preview 실설정 sync/wrangler.preview.toml이 없습니다. 사람 승인 후 예제를 복사하고 실제 preview D1 UUID와 별도 정적 origin을 입력하세요.'
    }
    throw "Wrangler 설정 파일이 없습니다: $($Target.ConfigPath)"
  }

  $Text = Get-Content -LiteralPath $Target.ConfigPath -Raw
  $WorkerName = Get-TomlQuotedValue $Text 'name'
  $Main = Get-TomlQuotedValue $Text 'main'
  $DatabaseName = Get-TomlQuotedValue $Text 'database_name'
  $DatabaseId = Get-TomlQuotedValue $Text 'database_id'
  $AllowedOrigin = Get-TomlQuotedValue $Text 'ALLOW_ORIGIN'
  $LearningEnabled = Get-TomlQuotedValue $Text 'LEARNING_V2_ENABLED'

  if ($Main -ne 'worker.js') { throw 'Wrangler main은 worker.js여야 합니다.' }
  if ($WorkerName -ne $Target.WorkerName) { throw "Worker name 불일치: $WorkerName" }
  if ($DatabaseName -ne $Target.DatabaseName) { throw "D1 database_name 불일치: $DatabaseName" }
  if ($LearningEnabled -cne 'false') { throw 'LEARNING_V2_ENABLED는 preview와 production 모두 정확히 false여야 합니다.' }

  $ParsedDatabaseId = [guid]::Empty
  if (-not [guid]::TryParse($DatabaseId, [ref]$ParsedDatabaseId) -or $ParsedDatabaseId -eq [guid]::Empty) {
    throw 'D1 database_id는 실제 non-zero UUID여야 합니다.'
  }

  if ($Target.Environment -eq 'preview') {
    if ($DatabaseId -eq $ProductionDatabaseId) { throw 'preview D1 UUID가 production D1 UUID와 같아서는 안 됩니다.' }
    if ($AllowedOrigin -eq $ProductionAllowedOrigin) { throw 'preview ALLOW_ORIGIN은 production origin과 달라야 합니다.' }
    if ($AllowedOrigin -match '(?i)(example\.invalid|replace[-_])') { throw 'preview ALLOW_ORIGIN placeholder를 실제 별도 origin으로 바꾸세요.' }
    Assert-Origin $AllowedOrigin 'preview ALLOW_ORIGIN'
    if ($Target.HealthOrigin -eq $ProductionHealthOrigin) { throw 'preview health origin이 production과 같아서는 안 됩니다.' }
  } else {
    if ($DatabaseId -ne $ProductionDatabaseId) { throw 'production D1 database_id가 승인된 고정 UUID와 다릅니다.' }
    if ($AllowedOrigin -ne $ProductionAllowedOrigin) { throw 'production ALLOW_ORIGIN이 승인된 고정 origin과 다릅니다.' }
  }

  return [pscustomobject]@{
    Text = $Text
    WorkerName = $WorkerName
    DatabaseName = $DatabaseName
    DatabaseId = $DatabaseId
    AllowedOrigin = $AllowedOrigin
    LearningEnabled = $LearningEnabled
  }
}

function Resolve-BackupFile([string]$Root, [string]$Name) {
  $RootFull = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $FileFull = [IO.Path]::GetFullPath((Join-Path $RootFull $Name))
  if (-not $FileFull.StartsWith($RootFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "백업 파일이 백업 폴더 밖을 가리킵니다: $Name"
  }
  if (-not (Test-Path -LiteralPath $FileFull -PathType Leaf)) { throw "백업 파일이 없습니다: $FileFull" }
  return $FileFull
}

function Assert-Hash([string]$Path, [string]$Expected) {
  $Actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($Actual -ne $Expected.ToUpperInvariant()) { throw "백업 SHA-256 불일치: $Path" }
}

function Get-StrictTemporaryChildPath([string]$Root, [string]$Leaf) {
  $RootFull = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
  if ([string]::IsNullOrWhiteSpace($Leaf) -or [IO.Path]::IsPathRooted($Leaf) -or [IO.Path]::GetFileName($Leaf) -ne $Leaf) {
    throw '임시 복원 검증 경로 이름이 안전하지 않습니다.'
  }
  $ChildFull = [IO.Path]::GetFullPath((Join-Path $RootFull $Leaf))
  if ($ChildFull -eq $RootFull -or -not $ChildFull.StartsWith($RootFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw '임시 복원 검증 경로가 임시 폴더 밖을 가리킵니다.'
  }
  return $ChildFull
}

function Remove-VerifiedTemporaryDirectory([string]$Root, [string]$Path, [string]$ExpectedLeaf) {
  $RootFull = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $TargetFull = [IO.Path]::GetFullPath($Path)
  if ($TargetFull -eq $RootFull -or
      -not $TargetFull.StartsWith($RootFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($TargetFull) -cne $ExpectedLeaf) {
    throw '임시 복원 검증 폴더 정리 경계 검증에 실패했습니다.'
  }
  if (Test-Path -LiteralPath $TargetFull) {
    $TargetItem = Get-Item -LiteralPath $TargetFull -Force
    if (-not $TargetItem.PSIsContainer) { throw '임시 복원 검증 대상이 폴더가 아닙니다.' }
    Remove-Item -LiteralPath $TargetFull -Recurse -Force
  }
}

function Verify-Backup([string]$Directory, [string]$ApprovedCommit) {
  if (-not $Directory) { throw '-BackupDirectory가 필요합니다.' }
  if ($ApprovedCommit -notmatch '^[A-Fa-f0-9]{40}$') {
    throw '승인된 복구 기준 40자리 Git SHA(-ExpectedBackupCommit)가 필요합니다.'
  }
  $Root = (Resolve-Path -LiteralPath $Directory).Path
  $ManifestPath = Join-Path $Root 'BACKUP_MANIFEST.md'
  if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { throw 'BACKUP_MANIFEST.md가 없습니다.' }
  $ManifestInfo = Get-Item -LiteralPath $ManifestPath
  if (((Get-Date).ToUniversalTime() - $ManifestInfo.LastWriteTimeUtc).TotalHours -gt 24) {
    throw '운영 변경 직전 24시간 이내 백업이 필요합니다.'
  }
  $Manifest = Get-Content -LiteralPath $ManifestPath -Raw
  if ($Manifest -notmatch '상태:\s*verified') { throw 'manifest의 verified 상태를 확인할 수 없습니다.' }

  $CommitMatch = [regex]::Match($Manifest, '(?im)^\s*-?\s*기준\s*커밋:\s*\x60([A-Fa-f0-9]{40})\x60\s*$')
  $BundleMatch = [regex]::Match($Manifest, 'Git bundle:\s*\x60([^\x60]+)\x60\s*\r?\n\s*- SHA-256:\s*\x60([A-Fa-f0-9]{64})\x60')
  $ZipMatch = [regex]::Match($Manifest, '소스 ZIP:\s*\x60([^\x60]+)\x60\s*\r?\n\s*- SHA-256:\s*\x60([A-Fa-f0-9]{64})\x60')
  $D1Match = [regex]::Match($Manifest, '최신 복구 기준:\s*\x60([^\x60]+)\x60\s*\r?\n- SHA-256:\s*\x60([A-Fa-f0-9]{64})\x60')
  if (-not ($CommitMatch.Success -and $BundleMatch.Success -and $ZipMatch.Success -and $D1Match.Success)) {
    throw 'manifest에서 기준 커밋·bundle·ZIP·D1 SQL 파일과 해시를 읽지 못했습니다.'
  }
  $ManifestCommit = $CommitMatch.Groups[1].Value.ToLowerInvariant()
  if ($ManifestCommit -ne $ApprovedCommit.ToLowerInvariant()) {
    throw "manifest 기준 커밋이 승인된 복구 기준과 다릅니다. manifest: $ManifestCommit"
  }
  $Bundle = Resolve-BackupFile $Root $BundleMatch.Groups[1].Value
  $Zip = Resolve-BackupFile $Root $ZipMatch.Groups[1].Value
  $D1 = Resolve-BackupFile $Root $D1Match.Groups[1].Value
  Assert-Hash $Bundle $BundleMatch.Groups[2].Value
  Assert-Hash $Zip $ZipMatch.Groups[2].Value
  Assert-Hash $D1 $D1Match.Groups[2].Value
  & git bundle verify $Bundle | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Git bundle 검증 실패' }

  $TemporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $RestoreProbeLeaf = 'wb-backup-verify-' + [guid]::NewGuid().ToString('N')
  $RestoreProbe = Get-StrictTemporaryChildPath $TemporaryRoot $RestoreProbeLeaf
  try {
    & git clone --no-checkout --quiet -- $Bundle $RestoreProbe
    if ($LASTEXITCODE -ne 0) { throw 'Git bundle 실제 clone 검증 실패' }

    $CommitObject = $ManifestCommit + '^{commit}'
    & git -C $RestoreProbe cat-file -e $CommitObject
    if ($LASTEXITCODE -ne 0) { throw "Git bundle에 manifest 기준 커밋이 없습니다: $ManifestCommit" }

    & git -C $RestoreProbe fsck --full | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Git bundle 실제 clone fsck 검증 실패' }
  } finally {
    Remove-VerifiedTemporaryDirectory $TemporaryRoot $RestoreProbe $RestoreProbeLeaf
  }
  Write-Host "백업 검증 완료: $Root" -ForegroundColor Green
  return [pscustomobject]@{
    verifiedAt = (Get-Date).ToUniversalTime().ToString('o')
    directory = $Root
    expectedCommit = $ApprovedCommit.ToLowerInvariant()
    manifest = [ordered]@{
      file = 'BACKUP_MANIFEST.md'
      sha256 = (Get-FileHash -LiteralPath $ManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    bundle = [ordered]@{
      file = $BundleMatch.Groups[1].Value
      sha256 = $BundleMatch.Groups[2].Value.ToLowerInvariant()
    }
    sourceZip = [ordered]@{
      file = $ZipMatch.Groups[1].Value
      sha256 = $ZipMatch.Groups[2].Value.ToLowerInvariant()
    }
    d1 = [ordered]@{
      file = $D1Match.Groups[1].Value
      sha256 = $D1Match.Groups[2].Value.ToLowerInvariant()
    }
  }
}

function Write-Receipt {
  $script:Receipt | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $script:ReceiptPath -Encoding utf8
}

function Add-ReceiptOperation([string]$Kind, [string]$Action, [string]$Status, [object]$Details = $null) {
  $Operation = [ordered]@{
    at = (Get-Date).ToUniversalTime().ToString('o')
    kind = $Kind
    action = $Action
    status = $Status
  }
  if ($null -ne $Details) { $Operation['details'] = $Details }
  $script:Receipt['operations'] += [pscustomobject]$Operation
  Write-Receipt
}

function Invoke-Wrangler([string]$Label, [string[]]$Arguments) {
  $Output = @(& $script:NpxExecutable --yes $script:WranglerPackage @Arguments 2>&1)
  $ExitCode = $LASTEXITCODE
  if ($ExitCode -ne 0) { throw "$Label 실패 (Wrangler exit $ExitCode)" }
  return @($Output | ForEach-Object { $_.ToString() })
}

function Capture-WorkerDeployments([string]$Label) {
  $Output = Invoke-Wrangler "Worker 배포 이력 $Label" @(
    'deployments', 'list', '--name', $script:Target.WorkerName, '--config', $script:Target.ConfigPath
  )
  $FileName = "$($script:Stamp)-worker-$Label.txt"
  $Path = Join-Path $script:ReceiptRoot $FileName
  $Output | Set-Content -LiteralPath $Path -Encoding utf8
  Add-ReceiptOperation 'worker' "deployments-$Label" 'succeeded' ([ordered]@{ receiptFile = $FileName })
}

function Assert-MigrationLedger([string[]]$JsonLines) {
  $Json = $JsonLines -join [Environment]::NewLine
  try { $Parsed = $Json | ConvertFrom-Json } catch { throw '마이그레이션 원장 JSON을 해석하지 못했습니다.' }
  $Rows = @()
  foreach ($Batch in @($Parsed)) {
    foreach ($Row in @($Batch.results)) { $Rows += $Row }
  }
  if ($Rows.Count -ne $ExpectedMigrations.Count) {
    throw "lp_schema_migrations는 정확히 version 2·3 두 행이어야 합니다. 실제: $($Rows.Count)"
  }
  for ($Index = 0; $Index -lt $ExpectedMigrations.Count; $Index += 1) {
    $Expected = $ExpectedMigrations[$Index]
    $Actual = $Rows[$Index]
    if ([int]$Actual.version -ne $Expected.Version -or [string]$Actual.name -ne $Expected.Name -or [int64]$Actual.applied_at -le 0) {
      throw "마이그레이션 원장 불일치: version $($Expected.Version) / $($Expected.Name)"
    }
  }
  return @($Rows | ForEach-Object {
    [ordered]@{ version = [int]$_.version; name = [string]$_.name; appliedAt = [int64]$_.applied_at }
  })
}

function ConvertFrom-WranglerRows([string[]]$JsonLines, [string]$Label) {
  $Json = $JsonLines -join [Environment]::NewLine
  try { $Parsed = $Json | ConvertFrom-Json } catch { throw "$Label JSON을 해석하지 못했습니다." }
  $Rows = @()
  foreach ($Batch in @($Parsed)) {
    if ($null -eq $Batch.results) { continue }
    foreach ($Row in @($Batch.results)) { $Rows += $Row }
  }
  return @($Rows)
}

function Get-ActiveTokenInventory {
  $TableOutput = Invoke-Wrangler 'token 테이블 확인' @(
    'd1', 'execute', $script:Target.DatabaseName, '--config', $script:Target.ConfigPath, '--remote', '--json',
    '--command', "SELECT COUNT(*) AS table_count FROM sqlite_master WHERE type='table' AND name='tokens'"
  )
  $TableRows = @(ConvertFrom-WranglerRows $TableOutput 'token 테이블 확인')
  if ($TableRows.Count -ne 1 -or [int64]($TableRows[0].table_count) -notin @(0, 1)) {
    throw 'token 테이블 확인 결과가 정확하지 않습니다.'
  }
  if ([int64]($TableRows[0].table_count) -eq 0) {
    return [pscustomobject]@{ activeTotal = 0; prefixedTotal = 0; migratableBareTotal = 0; tokenNormalizationConflictTotal = 0 }
  }
  $InventoryOutput = Invoke-Wrangler '활성 개인 bearer 원장 확인' @(
    'd1', 'execute', $script:Target.DatabaseName, '--config', $script:Target.ConfigPath, '--remote', '--json',
    '--command', "WITH bare_targets AS (SELECT app, lower(token) AS digest, COUNT(*) AS bare_count FROM tokens WHERE length(token)=64 AND token NOT GLOB '*[^0-9A-Fa-f]*' GROUP BY app, lower(token)) SELECT COUNT(*) AS active_total, COALESCE(SUM(CASE WHEN token LIKE 'sha256:%' THEN 1 ELSE 0 END),0) AS prefixed_total, COALESCE(SUM(CASE WHEN length(token)=64 AND token NOT GLOB '*[^0-9A-Fa-f]*' THEN 1 ELSE 0 END),0) AS migratable_bare_total, (SELECT COUNT(*) FROM bare_targets AS target WHERE target.bare_count > 1 OR EXISTS (SELECT 1 FROM tokens AS canonical WHERE canonical.app=target.app AND lower(canonical.token)='sha256:' || target.digest)) AS token_normalization_conflict_total FROM tokens WHERE revoked=0 AND created_at >= (unixepoch('now') * 1000 - 7776000000)"
  )
  $Rows = @(ConvertFrom-WranglerRows $InventoryOutput '활성 개인 bearer 원장')
  if ($Rows.Count -ne 1) { throw '활성 개인 bearer 원장 결과가 정확히 한 행이어야 합니다.' }
  $Active = [int64]($Rows[0].active_total)
  $Prefixed = [int64]($Rows[0].prefixed_total)
  $Migratable = [int64]($Rows[0].migratable_bare_total)
  $TokenNormalizationConflicts = [int64]($Rows[0].token_normalization_conflict_total)
  if ($Active -lt 0 -or $Prefixed -lt 0 -or $Migratable -lt 0 -or $TokenNormalizationConflicts -lt 0 -or
      $Prefixed -gt $Active -or $Migratable -gt $Active) {
    throw '활성 개인 bearer 원장 집계가 유효하지 않습니다.'
  }
  return [pscustomobject]@{
    activeTotal = $Active
    prefixedTotal = $Prefixed
    migratableBareTotal = $Migratable
    tokenNormalizationConflictTotal = $TokenNormalizationConflicts
  }
}

function Get-StringSha256([string]$Value) {
  $Bytes = [Text.Encoding]::UTF8.GetBytes($Value)
  return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}

function Read-AuthSmokeCredential([string]$Path, [string]$RepositoryRoot) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
  if (-not [IO.Path]::IsPathRooted($Path)) { throw '-AuthSmokeFile은 repository 밖의 절대 경로여야 합니다.' }
  $Full = (Resolve-Path -LiteralPath $Path).Path
  $RepoFull = [IO.Path]::GetFullPath($RepositoryRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
  if ($Full -eq $RepoFull -or $Full.StartsWith($RepoFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw '-AuthSmokeFile은 repository 안에 둘 수 없습니다.'
  }
  $Item = Get-Item -LiteralPath $Full -Force
  if ($Item.PSIsContainer -or $Item.Length -le 0 -or $Item.Length -gt 4096) { throw '인증 smoke JSON 파일 크기가 유효하지 않습니다.' }
  try { $Data = Get-Content -LiteralPath $Full -Raw | ConvertFrom-Json } catch { throw '인증 smoke JSON을 해석하지 못했습니다.' }
  if ($null -eq $Data -or $Data -is [Array]) { throw '인증 smoke JSON은 단일 객체여야 합니다.' }
  $PropertyNames = @($Data.PSObject.Properties.Name | Sort-Object)
  if (($PropertyNames -join '|') -cne 'app|staffId|token') { throw '인증 smoke JSON은 app, staffId, token 필드만 가져야 합니다.' }
  $App = [string]$Data.app
  $StaffId = [string]$Data.staffId
  $Token = [string]$Data.token
  if ($App -notin @('task', 'consult')) { throw '인증 smoke app은 task 또는 consult여야 합니다.' }
  if ($StaffId -notmatch '^[A-Za-z0-9_-]{1,128}$') { throw '인증 smoke staffId 형식이 유효하지 않습니다.' }
  if ($Token.Length -lt 20 -or $Token.Length -gt 256 -or $Token -match '\s' -or $Token -match '^[A-Fa-f0-9]{64}$' -or $Token.StartsWith('sha256:', [StringComparison]::OrdinalIgnoreCase)) {
    throw '인증 smoke token은 저장용 digest가 아닌 기존 raw bearer여야 합니다.'
  }
  return [pscustomobject]@{ app = $App; staffId = $StaffId; token = $Token; staffIdSha256 = (Get-StringSha256 $StaffId) }
}

function Invoke-WorkerHealthSmoke([string]$Phase) {
  try {
    $Health = Invoke-RestMethod -Method Get -Uri ($script:Target.HealthOrigin + '/health') -TimeoutSec 30
    $V2Health = Invoke-RestMethod -Method Get -Uri ($script:Target.HealthOrigin + '/api/v2/learning/health') -TimeoutSec 30
  } catch {
    throw "$Phase Worker health smoke 실패"
  }
  if (-not $Health.ok) { throw "$Phase /health smoke 실패" }
  if (-not $V2Health.ok -or $V2Health.enabled -ne $false) {
    throw "$Phase v2 foundation은 enabled=false여야 합니다."
  }
  Add-ReceiptOperation 'worker' "health-smoke-$Phase" 'succeeded' ([ordered]@{
    origin = $script:Target.HealthOrigin
    healthOk = $true
    learningV2Enabled = $false
  })
}

function Invoke-PersonalAuthSmoke([string]$Phase) {
  if ($null -eq $script:AuthSmokeCredential) { return }
  $Payload = [ordered]@{
    app = $script:AuthSmokeCredential.app
    auth = [ordered]@{ mode = "person"; id = $script:AuthSmokeCredential.staffId; token = $script:AuthSmokeCredential.token }
    since = 0
    changes = @()
  }
  try {
    $Response = Invoke-RestMethod -Method Post -Uri ($script:Target.HealthOrigin + '/sync') -TimeoutSec 30 `
      -ContentType 'application/json; charset=utf-8' -Headers @{ Origin = $script:Config.AllowedOrigin } `
      -Body ($Payload | ConvertTo-Json -Depth 5 -Compress)
  } catch {
    throw "$Phase 기존 개인 bearer smoke 실패"
  }
  if ($null -eq $Response -or $Response.ok -ne $true) { throw "$Phase 기존 개인 bearer smoke 실패" }
  Add-ReceiptOperation 'auth' "personal-bearer-$Phase" 'succeeded' ([ordered]@{
    app = $script:AuthSmokeCredential.app
    staffIdSha256 = $script:AuthSmokeCredential.staffIdSha256
  })
}
$Target = switch ($Environment) {
  'dry-run' {
    [pscustomobject]@{
      Environment = 'dry-run'
      ConfigPath = (Join-Path $PSScriptRoot 'wrangler.toml')
      WorkerName = $ProductionWorkerName
      DatabaseName = $ProductionDatabaseName
      HealthOrigin = $ProductionHealthOrigin
    }
  }
  'preview' {
    [pscustomobject]@{
      Environment = 'preview'
      ConfigPath = (Join-Path $PSScriptRoot 'wrangler.preview.toml')
      WorkerName = $PreviewWorkerName
      DatabaseName = $PreviewDatabaseName
      HealthOrigin = $PreviewHealthOrigin
    }
  }
  'production' {
    [pscustomobject]@{
      Environment = 'production'
      ConfigPath = (Join-Path $PSScriptRoot 'wrangler.toml')
      WorkerName = $ProductionWorkerName
      DatabaseName = $ProductionDatabaseName
      HealthOrigin = $ProductionHealthOrigin
    }
  }
}

if ($Environment -eq 'dry-run' -and ($Deploy -or $ApplyMigrations)) {
  throw 'dry-run 환경에서는 -Deploy 또는 -ApplyMigrations를 사용할 수 없습니다.'
}
if ($ValidateConfigurationOnly -and ($Deploy -or $ApplyMigrations)) {
  throw '-ValidateConfigurationOnly는 변경 옵션과 함께 사용할 수 없습니다.'
}
if (($Deploy -and -not $ApplyMigrations) -or ($ApplyMigrations -and -not $Deploy)) {
  throw 'Worker 배포와 D1 마이그레이션은 같은 승인 실행에서 함께만 허용됩니다.'
}

$Config = Read-And-ValidateTarget $Target
if ($ValidateConfigurationOnly) {
  Write-Host "설정 검증 완료: $Environment / $($Config.WorkerName) / $($Config.DatabaseName)" -ForegroundColor Green
  return
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js가 필요합니다.' }
$RepoRoot = (Resolve-Path -LiteralPath '..').Path
$GitStatus = @(& git -C $RepoRoot status --porcelain --untracked-files=all)
if ($LASTEXITCODE -ne 0) { throw 'Git 상태 확인 실패' }
if ($GitStatus.Count -gt 0) { throw '추적되지 않은 파일을 포함해 작업 폴더가 깨끗한 커밋이어야 합니다.' }
$Head = (& git -C $RepoRoot rev-parse HEAD).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0) { throw 'Git revision 확인 실패' }

$IsMutation = $Deploy -or $ApplyMigrations
$BackupVerification = $null
$AuthSmokeCredential = $null
if ($AuthSmokeFile -and -not $IsMutation) { throw '-AuthSmokeFile은 preview 또는 production 변경 실행에서만 사용합니다.' }
if ($IsMutation) { $AuthSmokeCredential = Read-AuthSmokeCredential $AuthSmokeFile $RepoRoot }
if ($Environment -eq 'preview' -and $IsMutation) {
  if ($ConfirmPreview -ne $PreviewPhrase) { throw "preview 변경 확인 문구가 필요합니다: -ConfirmPreview $PreviewPhrase" }
  if ($ExpectedCommit -notmatch '^[A-Fa-f0-9]{40}$' -or $Head -ne $ExpectedCommit.ToLowerInvariant()) {
    throw "검증한 40자리 Git SHA와 현재 HEAD가 일치해야 합니다. 현재: $Head"
  }
}
if ($Environment -eq 'production' -and $IsMutation) {
  if ($ConfirmProduction -ne $ProductionPhrase) {
    throw "운영 변경 확인 문구가 필요합니다: -ConfirmProduction $ProductionPhrase"
  }
  if ($ExpectedCommit -notmatch '^[A-Fa-f0-9]{40}$' -or $Head -ne $ExpectedCommit.ToLowerInvariant()) {
    throw "검증한 40자리 Git SHA와 현재 HEAD가 일치해야 합니다. 현재: $Head"
  }
  $BackupVerification = Verify-Backup $BackupDirectory $ExpectedBackupCommit
}
if ($Environment -eq 'production' -and $IsMutation) {
  if (-not $StaticArtifactVerified) { throw '운영 Worker 배포 전 같은 커밋의 정적 산출물 검증 확인(-StaticArtifactVerified)이 필요합니다.' }
  if (-not $MaintenanceWindowId.Trim()) { throw 'Worker와 정적 앱을 연속 반영할 승인된 maintenance window ID가 필요합니다.' }
}

$ReceiptRoot = Join-Path $PSScriptRoot '.release-receipts'
New-Item -ItemType Directory -Force -Path $ReceiptRoot | Out-Null
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmssfff'
$ReceiptPath = Join-Path $ReceiptRoot "$Stamp-$Environment-release.json"
$Receipt = [ordered]@{
  schemaVersion = 1
  startedAt = (Get-Date).ToUniversalTime().ToString('o')
  environment = $Environment
  status = 'in_progress'
  commit = $Head
  config = [ordered]@{
    file = [IO.Path]::GetFileName($Target.ConfigPath)
    sha256 = (Get-FileHash -LiteralPath $Target.ConfigPath -Algorithm SHA256).Hash.ToLowerInvariant()
    workerName = $Config.WorkerName
    databaseName = $Config.DatabaseName
    databaseId = $Config.DatabaseId
    allowedOrigin = $Config.AllowedOrigin
    healthOrigin = $Target.HealthOrigin
    learningV2Enabled = $Config.LearningEnabled
    wranglerPackage = $WranglerPackage
  }
  maintenanceWindowId = $(if ($MaintenanceWindowId) { $MaintenanceWindowId } else { $null })
  backup = $BackupVerification
  authSmoke = [ordered]@{
    supplied = ($null -ne $AuthSmokeCredential)
    app = $(if ($null -ne $AuthSmokeCredential) { $AuthSmokeCredential.app } else { $null })
    staffIdSha256 = $(if ($null -ne $AuthSmokeCredential) { $AuthSmokeCredential.staffIdSha256 } else { $null })
  }
  operations = @()
}
Write-Receipt

$ReleasePhase = 'preflight'
$CompatibleWorkerDeployed = $false
$TokenTransformStarted = $false
try {
  Step 'Cloudflare 인증 확인'
  [void](Invoke-Wrangler 'Cloudflare 인증 확인' @('whoami', '--config', $Target.ConfigPath))
  Add-ReceiptOperation 'worker' 'whoami' 'succeeded'

  Step 'Worker 번들 드라이런'
  [void](Invoke-Wrangler 'Worker 번들 드라이런' @('deploy', '--dry-run', '--config', $Target.ConfigPath))
  Add-ReceiptOperation 'worker' 'bundle-dry-run' 'succeeded'

  if ($ApplyMigrations) {
    $SchemaPath = Join-Path $PSScriptRoot 'schema.sql'
    if (-not (Test-Path -LiteralPath $SchemaPath -PathType Leaf)) { throw 'schema.sql이 없습니다.' }
    $MigrationFiles = @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'migrations') -Filter '*.sql' -File | Sort-Object Name)
    $ActualMigrationNames = @($MigrationFiles | ForEach-Object { $_.Name })
    $ExpectedMigrationNames = @($ExpectedMigrations | ForEach-Object { $_.File })
    if (($ActualMigrationNames -join '|') -ne ($ExpectedMigrationNames -join '|')) {
      throw "승인된 migration 파일 집합과 다릅니다. 실제: $($ActualMigrationNames -join ' , ')"
    }
  }

  if ($IsMutation) {
    $ReleasePhase = 'token-inventory'
    $TokenInventory = Get-ActiveTokenInventory
    Add-ReceiptOperation 'auth' 'active-token-inventory' 'succeeded' ([ordered]@{
      activeTotal = $TokenInventory.activeTotal
      prefixedTotal = $TokenInventory.prefixedTotal
      migratableBareTotal = $TokenInventory.migratableBareTotal
      tokenNormalizationConflictTotal = $TokenInventory.tokenNormalizationConflictTotal
    })
    if ($TokenInventory.tokenNormalizationConflictTotal -gt 0) {
      throw '대소문자를 정규화했을 때 같은 대상이 되는 bare digest 중복 또는 prefixed token 충돌이 있어 자동 변환을 중단했습니다. 백업 후 사람 승인으로 충돌 원장을 먼저 정리하세요.'
    }
    if ($TokenInventory.activeTotal -gt 0 -and $null -eq $AuthSmokeCredential) {
      throw '90일 이내 활성 개인 bearer가 있어 repository 밖 -AuthSmokeFile 표본이 필요합니다.'
    }
    if ($TokenInventory.activeTotal -eq 0 -and $null -ne $AuthSmokeCredential) {
      throw '활성 개인 bearer가 없으므로 -AuthSmokeFile을 제거하세요.'
    }
    if ($TokenInventory.activeTotal -eq 0) {
      Add-ReceiptOperation 'auth' 'personal-bearer-pre-post' 'skipped_no_active_tokens'
    }
  }

  if ($Deploy) {
    Step '변경 전 Worker 이력 캡처'
    Capture-WorkerDeployments 'before'
  }

  if ($ApplyMigrations) {
    $ReleasePhase = 'base-schema'
    Step '비변환 기본 스키마 적용'
    [void](Invoke-Wrangler '비변환 기본 스키마 적용' @(
      'd1', 'execute', $Target.DatabaseName, '--config', $Target.ConfigPath, '--remote', "--file=$SchemaPath", '-y'
    ))
    Add-ReceiptOperation 'd1' 'schema.sql' 'succeeded' ([ordered]@{ dataTransform = $false })
  }

  if ($Deploy) {
    $ReleasePhase = 'compatible-worker-deploy'
    Step "$Environment 호환 Worker 선행 배포"
    [void](Invoke-Wrangler "$Environment 호환 Worker 선행 배포" @(
      'deploy', '--name', $Target.WorkerName, '--config', $Target.ConfigPath
    ))
    $CompatibleWorkerDeployed = $true
    Add-ReceiptOperation 'worker' 'deploy-compatible-before-token-transform' 'succeeded'

    $ReleasePhase = 'pre-migration-smoke'
    Step '토큰 변환 전 호환 Worker smoke'
    Invoke-WorkerHealthSmoke 'pre-migration'
    Invoke-PersonalAuthSmoke 'pre-migration'
  }

  if ($ApplyMigrations) {
    $ReleasePhase = 'token-transform-migrations'
    $TokenTransformStarted = $true
    Step '호환 Worker 배포 후 번호순 추가형 마이그레이션 적용'
    foreach ($Migration in $MigrationFiles) {
      [void](Invoke-Wrangler "migration 적용: $($Migration.Name)" @(
        'd1', 'execute', $Target.DatabaseName, '--config', $Target.ConfigPath, '--remote', "--file=$($Migration.FullName)", '-y'
      ))
      Add-ReceiptOperation 'd1' $Migration.Name 'succeeded'
    }

    $ReleasePhase = 'migration-ledger'
    Step '마이그레이션 원장 정확성 확인'
    $LedgerOutput = Invoke-Wrangler '마이그레이션 원장 확인' @(
      'd1', 'execute', $Target.DatabaseName, '--config', $Target.ConfigPath, '--remote', '--json',
      '--command', 'SELECT version,name,applied_at FROM lp_schema_migrations ORDER BY version'
    )
    $LedgerRows = Assert-MigrationLedger $LedgerOutput
    Add-ReceiptOperation 'd1' 'migration-ledger' 'succeeded' ([ordered]@{ rows = $LedgerRows })
  }

  if ($Deploy) {
    $ReleasePhase = 'post-migration-smoke'
    Step '토큰 변환 후 동일 Worker smoke'
    Invoke-WorkerHealthSmoke 'post-migration'
    Invoke-PersonalAuthSmoke 'post-migration'

    Step '변경 후 Worker 이력 캡처'
    Capture-WorkerDeployments 'after'

    if ($Environment -eq 'production') {
      Add-ReceiptOperation 'static' 'production-static-release' 'pending_human_approval' ([ordered]@{
        commit = $Head
        maintenanceWindowId = $MaintenanceWindowId
      })
      $ReleasePhase = 'static-pending'
      $Receipt['status'] = 'worker_succeeded_static_pending'
      Write-Host 'Worker·D1 검증 완료. 릴리스는 아직 완료가 아닙니다. 승인된 maintenance window 안에서 같은 커밋의 정적 앱을 즉시 연속 반영하고 smoke test를 완료하세요.' -ForegroundColor Yellow
    } else {
      $ReleasePhase = 'succeeded'
      $Receipt['status'] = 'succeeded'
    }
  } else {
    $ReleasePhase = 'succeeded'
    $Receipt['status'] = 'succeeded'
    Write-Host "$Environment 검증 완료 (HEAD $Head). 원격 데이터·Worker 변경은 없었습니다." -ForegroundColor Green
  }
} catch {
  $Receipt['status'] = 'failed'
  $Receipt['failedPhase'] = $ReleasePhase
  $Receipt['compatibleWorkerDeployed'] = $CompatibleWorkerDeployed
  $Receipt['tokenTransformStarted'] = $TokenTransformStarted
  $Receipt['error'] = $_.Exception.Message
  throw
} finally {
  $Receipt['finishedAt'] = (Get-Date).ToUniversalTime().ToString('o')
  Write-Receipt
  Write-Host "릴리스 영수증: $ReceiptPath"
}
