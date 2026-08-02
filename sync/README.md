# WB 동기화 백엔드 (Cloudflare Workers + D1)

`/task/`와 `/consult/`의 변경 행만 동기화하는 Worker다. 개인 code·bearer는 서버에 `sha256:<digest>`로 저장하며, 일반 개인은 자기 owner 범위만 읽고 쓴다.

## 현재 릴리스 상태

- production Worker는 `wb-sync`, D1은 `wb-sync` / `5d65c2e2-47d9-4947-b402-704719914fd3`, 정적 origin은 `https://whdudwns33-wb.github.io`로 고정한다.
- 2026-08-03 현재 preview Worker와 preview D1은 아직 생성되지 않았다. `sync/wrangler.preview.toml`도 없으며, 이는 오류가 아니라 원격 자원을 만들지 않은 안전한 상태다.
- preview 자원 생성, 실제 UUID 입력, preview 배포는 각각 사람 승인 전 실행하지 않는다.
- D1 v2는 `LEARNING_V2_ENABLED=false`를 유지한다. 외부 프로그램은 공식 계약 전 CSV·JSON 수동 후보만 받는다.

## 환경별 안전 명령

BOM 없는 UTF-8 스크립트의 검증 문구와 manifest 정규식을 정확히 처리하도록 PowerShell 7(`pwsh`) 이상이 필수다. Windows PowerShell 5.1에서는 `#requires` 단계에서 중단된다.

`deploy-safe.ps1`에는 `dry-run`, `preview`, `production` 중 하나를 반드시 명시한다. Wrangler는 모든 경로에서 `wrangler@4.118.0`으로 고정된다.

로컬 변경 없는 커밋에서 production 설정을 읽어 Worker bundle만 검증:

```powershell
cd sync
pwsh -File .\deploy-safe.ps1 -Environment dry-run
```

preview는 먼저 [승인필요] 별도 D1을 만들고 `wrangler.preview.example.toml`을 ignored `wrangler.preview.toml`로 복사해 실제 UUID와 production과 다른 HTTPS 정적 origin을 입력한다. worker/database 이름은 둘 다 `wb-sync-preview`여야 한다.

```powershell
pwsh -File .\deploy-safe.ps1 -Environment preview -ApplyMigrations -Deploy `
  -ExpectedCommit '<40자리 검증 SHA>' `
  -ConfirmPreview WB-SYNC-PREVIEW
```

production 변경은 24시간 이내 검증 백업, clean commit, 확인 문구가 필수다. Worker 배포는 같은 커밋의 정적 산출물이 준비된 승인 maintenance window 안에서만 시작한다.

```powershell
pwsh -File .\deploy-safe.ps1 -Environment production -ApplyMigrations -Deploy `
  -BackupDirectory 'C:\path\to\verified-backup' `
  -ExpectedBackupCommit e44383727cd136dfee082022b4d633ab5edd4745 `
  -ExpectedCommit '<40자리 검증 SHA>' `
  -MaintenanceWindowId '<승인된 작업창 ID>' `
  -StaticArtifactVerified `
  -ConfirmProduction WB-SYNC-PRODUCTION
```

스크립트는 임의 health URL을 받지 않는다. production은 `https://wb-sync.whdudwns33.workers.dev`, preview는 `https://wb-sync-preview.whdudwns33.workers.dev`만 검사한다.

`-ApplyMigrations`와 `-Deploy`는 preview·production 모두 반드시 같은 승인 실행에서 함께 사용한다. 한쪽만 지정하면 변경 전에 중단된다.

스크립트가 90일 이내 활성 개인 bearer를 발견하면 repository 밖의 제한된 JSON 파일을 `-AuthSmokeFile`로 요구한다. 파일은 `app`, `staffId`, `token` 세 필드만 가지며 장기 보관하거나 Git에 넣지 않는다. 동일 bearer가 토큰 변환 전·후 `/sync`를 모두 통과해야 한다. 활성 bearer가 0개이면 이 인자를 주지 않는다.

bare digest를 소문자 대상으로 정규화했을 때 동일 app에서 bare가 2개 이상이거나, 대소문자와 무관하게 같은 prefixed token이 하나라도 있으면 행 상태와 상관없이 자동 변환을 시작하지 않는다. inactive-only 중복도 `003` UPDATE의 UNIQUE 충돌을 일으키므로 포함한다. D1 백업을 다시 만든 뒤 사람 승인으로 원장을 조사하고 해당 링크를 재발급·회전한 후 재실행한다. migration 자체도 stale/revoked/타인 prefixed 행 때문에 활성 bare를 먼저 삭제하지 않고 unique conflict로 실패 종료한다.

## 마이그레이션·영수증

- 활성 token 원장을 먼저 읽고, 비변환 `schema.sql` → raw/sha256 양쪽을 읽는 호환 Worker → 변환 `002`, `003` 순서로 실행한다. Worker 배포 실패 전에는 token 변환을 시작하지 않는다.
- 호환 Worker는 `003` 전 health와 활성 bearer 표본을 통과해야 하며, 적용 뒤 같은 health·bearer와 `lp_schema_migrations`의 정확한 version 2·3 원장을 다시 확인한다.
- 검증한 백업 폴더·기준 커밋·manifest/bundle/ZIP/D1 SHA-256, token 집계, 익명화한 bearer 표본 ID, 단계별 실패 경계, D1 적용 파일, 원장 행, Worker 배포 전후 이력과 health 결과를 ignored `.release-receipts/` JSON·텍스트로 남긴다.
- production Worker가 성공해도 영수증은 `worker_succeeded_static_pending`이다. 같은 maintenance window에서 정적 앱을 즉시 연속 반영하고 별도 smoke가 끝나야 릴리스 완료다.

## 운영 릴리스와 감시

1. [승인필요] 쓰기·개인 링크 발급을 잠시 멈추는 maintenance window를 연다.
2. 활성 bearer가 있으면 repository 밖 보안 JSON을 준비하고 `-AuthSmokeFile`을 추가한다.
3. 스크립트가 비변환 schema → 호환 Worker → 변환 migration 순서와 동일 bearer 전·후 smoke를 완료한다.
4. Worker·D1 smoke가 통과하면 같은 커밋의 정적 앱을 즉시 반영한다. Worker와 정적 앱을 서로 다른 날이나 독립 작업으로 배포하지 않는다.
5. 관리자 인증, 1회 code 교환, `/search`, `/curriculum`을 표본 점검한 뒤 쓰기를 재개한다.
6. 24시간 동안 인증 401/403/410, sync 4xx/5xx·거절, 확인대기 적체, 중복키, health를 감시하고 영수증에 연결한다.

## 비밀값

비밀값은 TOML·코드·URL·문서에 쓰지 않고 Cloudflare secret으로만 등록한다. 다음 명령도 별도 사람 승인과 노출된 자격정보 회전 뒤에만 실행한다.

```powershell
npx --yes wrangler@4.118.0 secret put TASK_ADMIN_SECRET
npx --yes wrangler@4.118.0 secret put CONSULT_ADMIN_SECRET
npx --yes wrangler@4.118.0 secret put NAVER_ID
npx --yes wrangler@4.118.0 secret put NAVER_SECRET
```

## 주요 API

- `GET /health`: Worker 상태
- `POST /sync`: 역할·owner 검증을 적용하는 delta push/pull
- `POST /token`: 관리자 전용 24시간 1회 code 발급
- `POST /exchange`: code 교환 뒤 90일 bearer 발급
- `POST /revoke`: staff 단위 bearer·미사용 code 해지
- `POST /search`: 후기·교재를 제외한 강좌 상세 후보 검색
- `POST /curriculum`: 허용 host 강의목차 추출과 403 직접 붙여넣기 fallback
- `GET /api/v2/learning/health`: 비활성 v2 foundation 상태

`POST /sync`는 요청 전체의 원자적 반영을 보장하지 않는다. 특히 `lpplan` revision CAS는 항목별 별도 write이며, 그 뒤 레코드 처리에서 실패하면 앞선 write가 이미 반영됐을 수 있다. `lpcore`·`lpassess`·`lpcampaign`·`lpwrong`·프로그램 import 데이터도 `lpplan`과 하나의 transaction으로 묶이지 않는다. 실패 응답 뒤에는 pull/read-back으로 실제 반영 범위를 확인하고 동일 mutation ID·revision 규칙으로 안전하게 재시도한다.

## 검증

```powershell
node --test .\deploy-safe-static.test.mjs .\worker-core.test.mjs .\worker-regression.test.mjs .\learning-v2.test.mjs .\security-static.test.mjs
node ..\scripts\check-inline-html.mjs ..\consult\index.html ..\task\index.html
```

복구는 `../docs/learning-platform-v2/ROLLBACK.md`의 인증 호환 rollback만 사용한다. 첫 개인 링크 이후에는 구형 평문/bare-hash 인증 Worker나 기준 정적 앱으로 직접 되돌리지 않는다.

## Codex 역할

[Codex] 설정·코드·스키마·테스트·영수증 형식을 준비하고 dry-run 결과를 검증한다. 원격 자원 생성·운영 반영은 사람 승인 없이 실행하지 않는다.

## 코워크 역할

[코워크] preview 후보, 배포 후 health·오류율·확인대기 적체를 반복 점검한다. 기본 실행은 후보 또는 dry-run이다.

## 사람 승인 게이트

[승인필요] preview 자원 생성·배포, production migration·Worker·정적 앱, maintenance window 개폐, secret 회전, rollback을 각각 승인한다.

## 반복 실행 흐름

`설정 검증 → dry-run → preview 자원 승인 → preview 검증 → 운영 백업 → maintenance 승인 → Worker·정적 연속 반영 → 24시간 감시 → 완료/호환 rollback`

## 에이전트 간 전달물

`release_candidate`, `migration_receipt`, `worker_receipt`, `static_release_pending`, `postdeploy_health`, `rollback_candidate`

## 로그/인수인계 기준

환경, Git SHA, 설정 SHA-256, Worker/D1 이름·ID, migration 원장, 배포 전후 version, health origin, maintenance ID, 승인자·시각을 기록한다. 비밀값·개인 bearer/code는 기록하지 않는다.
