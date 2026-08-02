# WB 동기화 백엔드 자동 배포 (Windows PowerShell)
# 이 파일이 있는 폴더에서 실행하면 끝까지 알아서 진행한다.
#   1) Cloudflare 로그인   2) D1 생성 + wrangler.toml 자동 수정
#   3) 표 만들기          4) 비밀키 자동 생성·등록
#   5) 배포               6) 결과를 배포결과.txt 로 저장
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

# ── 2) 데이터베이스
Say "`n[2/5] 데이터베이스 만드는 중" 'Cyan'
npx --yes $W d1 create wb-sync 2>&1 | Out-Host   # 이미 있으면 경고만 나고 넘어간다

$dbid = $null
try {
  $raw = (npx --yes $W d1 list --json 2>$null | Out-String)
  $m = [regex]::Match($raw, '\{[^{}]*"name"\s*:\s*"wb-sync"[^{}]*\}')
  if ($m.Success) { $u = [regex]::Match($m.Value, '"(uuid|database_id)"\s*:\s*"([0-9a-f\-]{30,})"'); if ($u.Success) { $dbid = $u.Groups[2].Value } }
  if (-not $dbid) {
    $u = [regex]::Match($raw, '"(uuid|database_id)"\s*:\s*"([0-9a-f\-]{30,})"')
    if ($u.Success) { $dbid = $u.Groups[2].Value }
  }
} catch { }
if (-not $dbid) { Die '데이터베이스 ID를 읽지 못했습니다.' }
Say "database_id = $dbid" 'DarkGray'

$toml = Get-Content .\wrangler.toml -Raw
$toml = [regex]::Replace($toml, 'database_id\s*=\s*".*"', ('database_id = "' + $dbid + '"'))
Set-Content .\wrangler.toml $toml -Encoding UTF8

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
Say "`n[5/5] 배포 중" 'Cyan'
$out = (npx --yes $W deploy 2>&1 | Out-String)
Write-Host $out
$url = [regex]::Match($out, 'https://[a-z0-9\-\.]+\.workers\.dev').Value
if (-not $url) { $url = '(주소를 못 읽었습니다 — 위 출력에서 workers.dev 로 끝나는 줄을 찾아주세요)' }

$result = @"
WB 동기화 백엔드 배포 결과
──────────────────────────────
주소: $url
TASK_ADMIN_SECRET: $k1
CONSULT_ADMIN_SECRET: $k2
──────────────────────────────
"@
Set-Content .\배포결과.txt $result -Encoding UTF8

Say "`n===== 아래 내용을 클로드에게 그대로 붙여넣어 주세요 =====" 'Green'
Write-Host $result
Say '같은 내용이 이 폴더의 배포결과.txt 에도 저장되었습니다.' 'DarkGray'
Say '비밀키는 남에게 보내지 마세요.' 'Yellow'
Read-Host "`n엔터를 누르면 닫힙니다"
