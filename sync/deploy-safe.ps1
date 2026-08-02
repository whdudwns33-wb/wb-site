param(
  [switch]$Deploy,
  [switch]$ApplyMigrations,
  [string]$BackupDirectory = '',
  [string]$ExpectedCommit = '',
  [string]$HealthUrl = '',
  [string]$ConfirmProduction = ''
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$WranglerPackage = 'wrangler@4'
$ProductionPhrase = 'WB-SYNC-PRODUCTION'

function Step([string]$Message) {
  Write-Host ""
  Write-Host "== $Message ==" -ForegroundColor Cyan
}

function Require-Success([string]$Label) {
  if ($LASTEXITCODE -ne 0) { throw "$Label 실패 (exit $LASTEXITCODE)" }
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

function Verify-Backup([string]$Directory) {
  if (-not $Directory) { throw '-BackupDirectory가 필요합니다.' }
  $Root = (Resolve-Path -LiteralPath $Directory).Path
  $ManifestPath = Join-Path $Root 'BACKUP_MANIFEST.md'
  if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { throw 'BACKUP_MANIFEST.md가 없습니다.' }
  $ManifestInfo = Get-Item -LiteralPath $ManifestPath
  if (((Get-Date).ToUniversalTime() - $ManifestInfo.LastWriteTimeUtc).TotalHours -gt 24) {
    throw '운영 변경 직전 24시간 이내 백업이 필요합니다.'
  }
  $Manifest = Get-Content -LiteralPath $ManifestPath -Raw
  if ($Manifest -notmatch '상태:\s*verified') { throw 'manifest의 verified 상태를 확인할 수 없습니다.' }

  $BundleMatch = [regex]::Match($Manifest, 'Git bundle:\s*`([^`]+)`\s*\r?\n\s*- SHA-256:\s*`([A-Fa-f0-9]{64})`')
  $ZipMatch = [regex]::Match($Manifest, '소스 ZIP:\s*`([^`]+)`\s*\r?\n\s*- SHA-256:\s*`([A-Fa-f0-9]{64})`')
  $D1Match = [regex]::Match($Manifest, '최신 복구 기준:\s*`([^`]+)`\s*\r?\n- SHA-256:\s*`([A-Fa-f0-9]{64})`')
  if (-not ($BundleMatch.Success -and $ZipMatch.Success -and $D1Match.Success)) {
    throw 'manifest에서 bundle·ZIP·D1 SQL 파일과 해시를 읽지 못했습니다.'
  }
  $Bundle = Resolve-BackupFile $Root $BundleMatch.Groups[1].Value
  $Zip = Resolve-BackupFile $Root $ZipMatch.Groups[1].Value
  $D1 = Resolve-BackupFile $Root $D1Match.Groups[1].Value
  Assert-Hash $Bundle $BundleMatch.Groups[2].Value
  Assert-Hash $Zip $ZipMatch.Groups[2].Value
  Assert-Hash $D1 $D1Match.Groups[2].Value
  git bundle verify $Bundle
  Require-Success 'Git bundle 검증'
  Write-Host "백업 검증 완료: $Root" -ForegroundColor Green
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js가 필요합니다.' }
if (-not (Test-Path -LiteralPath '.\wrangler.toml')) { throw 'wrangler.toml을 찾을 수 없습니다.' }
$Config = Get-Content -LiteralPath '.\wrangler.toml' -Raw
if ($Config -notmatch 'database_id\s*=\s*"[0-9a-f-]{36}"') {
  throw 'wrangler.toml의 D1 database_id가 실제 UUID인지 확인해 주세요.'
}

$RepoRoot = (Resolve-Path -LiteralPath '..').Path
$GitStatus = @(git -C $RepoRoot status --porcelain --untracked-files=all)
Require-Success 'Git 상태 확인'
if ($GitStatus.Count -gt 0) { throw '추적되지 않은 파일을 포함해 작업 폴더가 깨끗한 커밋이어야 합니다.' }
$Head = (git -C $RepoRoot rev-parse HEAD).Trim()
Require-Success 'Git revision 확인'

if ($Deploy -and -not $ApplyMigrations) {
  throw '운영 Worker 배포는 -ApplyMigrations와 같은 승인 실행에서만 허용됩니다.'
}
if ($Deploy -or $ApplyMigrations) {
  if ($ConfirmProduction -ne $ProductionPhrase) {
    throw "운영 변경 확인 문구가 필요합니다: -ConfirmProduction $ProductionPhrase"
  }
  if ($ExpectedCommit -notmatch '^[A-Fa-f0-9]{40}$' -or $Head -ne $ExpectedCommit.ToLowerInvariant()) {
    throw "검증한 40자리 Git SHA와 현재 HEAD가 일치해야 합니다. 현재: $Head"
  }
  Verify-Backup $BackupDirectory
}
if ($Deploy -and -not $HealthUrl) { throw '배포 후 smoke test를 위한 -HealthUrl이 필요합니다.' }

Step 'Cloudflare 인증 및 설정 확인'
npx --yes $WranglerPackage whoami
Require-Success 'Cloudflare 인증 확인'

Step 'Worker 번들 드라이런'
npx --yes $WranglerPackage deploy --dry-run
Require-Success 'Worker 드라이런'

if ($ApplyMigrations) {
  Step '배포 전 Worker 이력 캡처'
  $ReceiptRoot = Join-Path $PSScriptRoot '.release-receipts'
  New-Item -ItemType Directory -Force -Path $ReceiptRoot | Out-Null
  $Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  npx --yes $WranglerPackage deployments list --name wb-sync | Out-File -LiteralPath (Join-Path $ReceiptRoot "$Stamp-before.txt") -Encoding utf8
  Require-Success '기존 Worker 이력 캡처'

  Step '기본 스키마 적용 (멱등)'
  npx --yes $WranglerPackage d1 execute wb-sync --remote --file=.\schema.sql -y
  Require-Success '기본 스키마 적용'

  Step '번호순 추가형 마이그레이션 적용'
  $MigrationFiles = @(Get-ChildItem -LiteralPath '.\migrations' -Filter '*.sql' -File | Sort-Object Name)
  if ($MigrationFiles.Count -eq 0) { throw '적용할 migration SQL이 없습니다.' }
  foreach ($Migration in $MigrationFiles) {
    Write-Host ("적용: " + $Migration.Name)
    npx --yes $WranglerPackage d1 execute wb-sync --remote --file=$Migration.FullName -y
    Require-Success ("migration 적용: " + $Migration.Name)
  }

  Step '개인 토큰 해시 형식 마이그레이션 적용'
  npx --yes $WranglerPackage d1 execute wb-sync --remote --file=.\migrations\003_token_hash_prefix.sql -y
  Require-Success '토큰 해시 마이그레이션 적용'

  Step '마이그레이션 원장 확인'
  npx --yes $WranglerPackage d1 execute wb-sync --remote --command "SELECT version,name FROM lp_schema_migrations ORDER BY version" -y
  Require-Success '마이그레이션 원장 확인'
}

if ($Deploy) {
  Step '운영 Worker 배포'
  npx --yes $WranglerPackage deploy
  Require-Success 'Worker 배포'

  Step '배포 후 health smoke test'
  $Base = $HealthUrl.TrimEnd('/')
  $Health = Invoke-RestMethod -Method Get -Uri ($Base + '/health')
  if (-not $Health.ok) { throw '/health smoke test 실패' }
  $V2Health = Invoke-RestMethod -Method Get -Uri ($Base + '/api/v2/learning/health')
  if (-not $V2Health.ok -or $V2Health.enabled -ne $false) {
    throw 'v2 foundation은 운영에서 enabled=false여야 합니다.'
  }
  npx --yes $WranglerPackage deployments list --name wb-sync | Out-File -LiteralPath (Join-Path $ReceiptRoot "$Stamp-after.txt") -Encoding utf8
  Require-Success '배포 이력 기록'
  Write-Host 'Worker 배포와 health 확인 완료. 정적 프런트 배포는 별도 승인 단계입니다.' -ForegroundColor Green
} else {
  Write-Host "드라이런 완료 (HEAD $Head). 운영 변경은 없었습니다." -ForegroundColor Green
}
