# WB 통합 학습 플랫폼 v2 릴리스 체크리스트

## 1. 코드·기능 회귀

- [ ] 기존 `/consult/`, `/task/` 핵심 기능 회귀 확인
- [ ] 검색 결과가 강좌 상세 중심이고 후기·교재를 제외함
- [ ] 강좌 가져오기 403이 직접 붙여넣기 안내로 전환됨
- [ ] 관리자 PIN·개인 code·bearer가 URL·백업·staff 데이터에 없음
- [ ] 프로그램 CSV·JSON 미리보기→사람 승인, 완료요청→사람 검증, 평가·캠페인·오답 흐름 통과
- [ ] 초등 학교 정기시험 기본 비활성, 경시/KMT/NELT/영재원/입학/레벨/custom 선택 가능

## 2. 자동 검증

```powershell
node --test consult\learning-platform.test.cjs consult\learning-shell.test.cjs consult\learning-persistence.test.cjs consult\learning-persistence-runtime.test.cjs consult\sync-plan-merge.test.cjs consult\program-imports.test.js consult\program-import-ui.test.cjs consult\consult-security-accessibility.test.cjs task\task-security-accessibility.test.cjs sync\deploy-safe-static.test.mjs sync\worker-core.test.mjs sync\worker-regression.test.mjs sync\learning-v2.test.mjs sync\security-static.test.mjs
node scripts\check-inline-html.mjs consult\index.html task\index.html
```

- [ ] 모든 테스트와 인라인 JavaScript 문법 통과
- [ ] 로컬 D1에서 `schema.sql`, `002`, `003`을 두 번 적용해도 안정적임
- [ ] `lp_schema_migrations`는 version 2·3이 정확히 1행씩이고 이름·`applied_at`가 정확함
- [ ] `pwsh -File .\sync\deploy-safe.ps1 -Environment dry-run` 통과
- [ ] Wrangler가 `4.118.0`으로 고정됨

## 3. preview 선행 게이트

> 2026-08-03 현재 preview Worker와 preview D1은 아직 생성되지 않았다. 따라서 preview 배포가 완료됐다고 보고하면 안 된다.

- [ ] [승인필요] `wb-sync-preview` D1 생성 승인
- [ ] ignored `sync/wrangler.preview.toml`에 production과 다른 실제 UUID·HTTPS 정적 origin 입력
- [ ] worker/database 이름 모두 `wb-sync-preview`, health는 `https://wb-sync-preview.whdudwns33.workers.dev` 확인
- [ ] `LEARNING_V2_ENABLED=false` 확인
- [ ] [승인필요] `pwsh -File .\sync\deploy-safe.ps1 -Environment preview -ApplyMigrations -Deploy -ExpectedCommit <검증한-preview-40자리-SHA> -ConfirmPreview WB-SYNC-PREVIEW` 실행
- [ ] 테스트 학생만 code 교환 성공·재사용 410·해지 후 bearer 401, sync 범위·검색·403 fallback 확인
- [ ] preview D1/Worker 영수증 보존

## 4. 브라우저 smoke

- [ ] 초등 학생 생성·학습 초기화·학교 정기시험 미노출
- [ ] 경시대회 초안→동의·활성화→시험대비 탭 표시
- [ ] 정상 CSV 1행 승인, 자격정보 열 CSV 차단
- [ ] 오답→쌍둥이 요청 후 자동 숙달 없음
- [ ] 완료요청→확인대기→관리자 검증→재접속 보존
- [ ] 키보드 탭 이동, modal, 375px 모바일 가로 넘침, console 오류 확인

## 5. 운영 백업·maintenance 승인

- [ ] 24시간 이내 Git bundle·소스 ZIP·D1 SQL 백업과 manifest SHA-256·bundle 복원 검증
- [ ] 승인된 rollback 기준 SHA를 `-ExpectedBackupCommit e44383727cd136dfee082022b4d633ab5edd4745`로 고정하고 manifest 기준 커밋과 일치 확인
- [ ] clean 40자리 Git SHA와 같은 SHA의 정적 산출물 검증
- [ ] 배포 전 Worker version/deployment 기록
- [ ] [승인필요] 쓰기·개인 링크 발급을 멈출 maintenance window ID와 담당자 확정
- [ ] 호환 rollback 정적 산출물과 sha256/bootstrap 인증 유지 Worker 후보 smoke 완료
- [ ] 90일 이내 활성 bearer 수 확인: 0개면 표본 N/A, 1개 이상이면 repository 밖 제한 JSON과 동일 bearer 전·후 smoke 승인
- [ ] token normalization conflict 0건 확인: app별 bare 대소문자 중복과 case-insensitive bare↔prefixed 충돌을 상태와 무관하게 검사. 1건 이상이면 배포 중단, 새 D1 백업·사람 승인·링크 재발급/원장 정리

## 6. 운영 연속 반영

1. [승인필요] maintenance window를 열고 신규 쓰기·링크 발급을 중지한다.
2. 아래처럼 신규 배포 SHA와 승인된 rollback SHA를 각각 고정한다. 활성 bearer가 있으면 명령에 `-AuthSmokeFile <repository-밖-제한-JSON>`을 추가한다.

```powershell
pwsh -File .\sync\deploy-safe.ps1 -Environment production -ApplyMigrations -Deploy -ExpectedCommit <검증한-신규-40자리-SHA> -BackupDirectory <검증한-백업-폴더> -ExpectedBackupCommit e44383727cd136dfee082022b4d633ab5edd4745 -ConfirmProduction WB-SYNC-PRODUCTION -MaintenanceWindowId <승인-ID> -StaticArtifactVerified
```
3. 스크립트 영수증에서 비변환 schema → 호환 Worker → pre-migration health/bearer → 002/003 → 원장 → post-migration 동일 bearer 순서를 확인한다.
4. 고정 production health가 통과하면 같은 커밋의 정적 앱을 즉시 연속 반영한다.
5. 관리자 인증, 1회 code, `/sync`, `/search`, `/curriculum`, 기존 핵심 화면을 확인한다.
6. 쓰기를 재개하고 승인자·시각·영수증 경로를 기록한다.

Worker와 정적 앱 사이의 호환되지 않는 분할 상태를 장시간 허용하지 않는다. Worker 성공만으로 릴리스 완료 처리하지 않으며 영수증의 `worker_succeeded_static_pending`을 정적 smoke 후 별도 운영 기록으로 닫는다.

## 7. 24시간 감시·rollback

- [ ] 0~1시간: `/health`, v2 disabled, 인증 401/403/410, sync 거절·5xx를 집중 확인
- [ ] 1~6시간: 확인대기 적체, 중복키, 프로그램 import 차단/승인 비율 확인
- [ ] 6~24시간: 오류 추세와 신규·기존 개인 링크 표본 확인
- [ ] 이상 시 구형 Worker로 되돌리지 않고 `ROLLBACK.md`의 호환 rollback 정적 산출물 + sha256/bootstrap Worker 경계를 유지

## 8. 인증 안전장치 완료 항목

- [x] DB에는 `sha256:<digest>`만 저장하고 bare 64hex·`sha256:` 원문 bearer 인증을 거부함
- [x] 링크는 `?u=<id>#c=<code>` 24시간 1회 code만 포함하고 네트워크 요청 전에 fragment를 제거함
- [x] code 재사용 거부, 교환 성공 시에만 기존 bearer 회전, bearer 90일 만료를 자동 테스트함
- [x] 관리자 대상별 해지로 활성 bearer와 미사용 code를 함께 폐기함
- [x] 구형 `?t=`를 저장·인증하지 않고 주소에서 제거함

위 완료 표시는 코드 회귀 테스트 기준이다. 실제 운영 반영은 migration 원장, Worker version, 배포 영수증과 health로 별도 확인한다.

## Codex 역할

[Codex] diff, 자동 테스트, 설정 검증, preview/production 후보와 영수증·호환 rollback 후보를 준비한다.

## 코워크 역할

[코워크] preview 후보, 오류 큐, 확인대기 적체, 중복키, 24시간 배포 후 상태를 반복 점검한다. 기본값은 dry-run이다.

## 사람 승인 게이트

[승인필요] preview 자원 생성·배포, 운영 D1 migration, Worker·정적 연속 배포, maintenance 개폐, secret 회전, rollback, 외부 계정 변경과 메시지 발송을 승인한다.

## 반복 실행 흐름

`백업 확인 → 자동 테스트 → dry-run → preview 자원 승인·검증 → maintenance 승인 → Worker·정적 연속 반영 → 24시간 감시 → 완료/호환 rollback`

## 에이전트 간 전달물

`release_candidate`, `migration_result`, `browser_smoke_result`, `approval_request`, `deployment_receipt`, `static_release_pending`, `postdeploy_health`, `rollback_candidate`

## 로그/인수인계 기준

Git SHA, 테스트 결과, D1 migration ledger, Worker version, 설정·영수증 SHA, maintenance ID, 정적 배포시각, 승인자, 24시간 지표와 보류 항목을 기록한다. 비밀값과 개인 토큰은 제외한다.
