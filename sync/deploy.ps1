# WB 동기화 백엔드 자동 배포 (Windows PowerShell)
# 이 파일이 있는 폴더에서 실행하면 끝까지 알아서 진행한다.
#   1) Cloudflare 로그인   2) D1 생성 + wrangler.toml 자동 수정
#   3) 표 만들기          4) 비밀키 자동 생성·등록
#   5) 배포               6) 결과를 현재 터미널에 한 번만 표시
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$W = 'wrangler@4'

function Say($m, $c = 'White') { Write-Host $m -ForegroundColor $c }
function Die($m) { Say "`n[중단] $m" 'Red'; Say '이 화면을 그대로 캡처해서 클로드에게 보내주세요.' 'Yellow'; Read-Host '엔터를 누르면 닫힙니다'; exit 1 }

Say '===== WB 동기화 백엔드 배포 =====' 'Cyan'

# ── Node 확인
try { $nv = (node -v) 2>&1 } catch { $nv = $null }
if (-not $nv -or $nv -notmatch '^v\d') {
  Die 'Node.js가 없습니다. https://nodejs.org 에서 LTS 버전을 설치하고, 이 창을 닫았다가 다시 실행해 주세요.'
}
Say "Node $nv 확인" 'DarkGray'

# ── 1) 로그인
Say "`n[1/5] Cloudflare 로그인 — 브라우저가 열리면 [Allow]를 눌러주세요" 'Cyan'
npx --yes $W login
if ($LASTEXITCODE -ne 0) { Die '로그인에 실패했습니다.' }

# ── 2) 데이터베이스 — 이 도우미는 최초 설치 전용이다. 기존 운영 DB는 README 순서로 migration한다.
Say "`n[2/5] 데이터베이스 만드는 중" 'Cyan'
$beforeRaw = (npx --yes $W d1 list --json 2>$null | Out-String)
if ($LASTEXITCODE -ne 0) { Die '기존 D1 확인에 실패했습니다. 안전을 위해 배포를 중단합니다.' }
try { $beforeRows = @($beforeRaw | ConvertFrom-Json) }
catch { Die 'D1 목록 응답을 읽지 못했습니다. 안전을 위해 배포를 중단합니다.' }
$existingDb = @($beforeRows | Where-Object { $_.name -eq 'wb-sync' }).Count -gt 0
if ($existingDb) {
  Die '기존 wb-sync 운영 DB가 있습니다. 이 최초 설치 도우미를 실행하면 안 됩니다. README의 036 → 037 → 038 수동 migration과 두 Worker 배포 순서를 사용해 주세요.'
}
npx --yes $W d1 create wb-sync 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { Die '새 D1 데이터베이스 생성에 실패했습니다.' }

$afterRaw = (npx --yes $W d1 list --json 2>$null | Out-String)
if ($LASTEXITCODE -ne 0) { Die '생성된 D1 확인에 실패했습니다. 안전을 위해 배포를 중단합니다.' }
try { $afterRows = @($afterRaw | ConvertFrom-Json) }
catch { Die '생성된 D1 목록 응답을 읽지 못했습니다. 안전을 위해 배포를 중단합니다.' }
$dbRow = @($afterRows | Where-Object { $_.name -eq 'wb-sync' }) | Select-Object -First 1
$dbid = if ($dbRow.uuid) { [string]$dbRow.uuid } else { [string]$dbRow.database_id }
if ($dbid -notmatch '^[0-9a-f\-]{30,}$') { Die '새 wb-sync 데이터베이스 ID를 읽지 못했습니다.' }
Say "database_id = $dbid" 'DarkGray'

$toml = Get-Content .\wrangler.toml -Raw
$toml = [regex]::Replace($toml, 'database_id\s*=\s*".*"', ('database_id = "' + $dbid + '"'))
Set-Content .\wrangler.toml $toml -Encoding UTF8
$studentToml = Get-Content .\wrangler.student.toml -Raw
$studentToml = [regex]::Replace($studentToml, 'database_id\s*=\s*".*"', ('database_id = "' + $dbid + '"'))
Set-Content .\wrangler.student.toml $studentToml -Encoding UTF8

# ── 3) 표 만들기
Say "`n[3/5] 표 만드는 중" 'Cyan'
npx --yes $W d1 execute wb-sync --remote --file=./schema.sql -y
if ($LASTEXITCODE -ne 0) { Die '표를 만들지 못했습니다.' }

# ── 4) 비밀키 (자동 생성 — 외우실 필요 없습니다)
Say "`n[4/5] 비밀키 등록 중" 'Cyan'
function New-Key { -join (1..40 | ForEach-Object { 'abcdefghijkmnpqrstuvwxyz23456789'[(Get-Random -Max 32)] }) }
$k1 = New-Key; $k2 = New-Key
$k1 | npx --yes $W secret put TASK_ADMIN_SECRET
if ($LASTEXITCODE -ne 0) { Die '비밀키 등록에 실패했습니다.' }
$k2 | npx --yes $W secret put CONSULT_ADMIN_SECRET
if ($LASTEXITCODE -ne 0) { Die '비밀키 등록에 실패했습니다.' }

# ── 5) 배포
Say "`n[5/5] 보호자·직원 Worker 배포 중" 'Cyan'
$mainOut = (npx --yes $W deploy 2>&1 | Out-String)
Write-Host $mainOut
if ($LASTEXITCODE -ne 0) { Die '보호자·직원 Worker 배포에 실패했습니다.' }
$mainUrl = [regex]::Match($mainOut, 'https://[a-z0-9\-\.]+\.workers\.dev').Value
if (-not $mainUrl) { $mainUrl = '(주소를 못 읽었습니다 — 위 출력에서 workers.dev 로 끝나는 줄을 찾아주세요)' }

Say "`n학생 전용 Worker 배포 중" 'Cyan'
$studentOut = (npx --yes $W deploy --config .\wrangler.student.toml 2>&1 | Out-String)
Write-Host $studentOut
if ($LASTEXITCODE -ne 0) { Die '학생 전용 Worker 배포에 실패했습니다.' }
$studentUrl = [regex]::Match($studentOut, 'https://[a-z0-9\-\.]+\.workers\.dev').Value
if (-not $studentUrl) { $studentUrl = '(주소를 못 읽었습니다 — 위 출력에서 workers.dev 로 끝나는 줄을 찾아주세요)' }

$result = @"
WB 동기화 백엔드 배포 결과
──────────────────────────────
보호자·직원 주소: $mainUrl
학생 앱 주소: $studentUrl
TASK_ADMIN_SECRET: $k1
CONSULT_ADMIN_SECRET: $k2
──────────────────────────────
"@
Say "`n===== 아래 내용을 암호 관리자에 바로 저장해 주세요 =====" 'Green'
Write-Host $result
Say '비밀키는 파일로 저장되지 않습니다. 암호 관리자에 바로 보관하고 채팅에는 보내지 마세요.' 'Yellow'
Read-Host "`n엔터를 누르면 닫힙니다"
