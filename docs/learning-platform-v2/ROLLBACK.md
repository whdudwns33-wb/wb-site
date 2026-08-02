# WB 통합 학습 플랫폼 v2 인증 호환 복구 절차

## 복구 기준점과 중요한 제한

- Git 기준 커밋: `e44383727cd136dfee082022b4d633ab5edd4745`
- 원격 백업 태그: `backup-pre-learning-platform-v2-20260803-004401`
- 백업 폴더: `C:\Users\HeungPC\Desktop\코워크\마케팅\.codex_build\backups\wb-site_pre_learning_platform_v2_20260803_004401`
- 독립 복구용 Git bundle: `wb-site_e443837_standalone.bundle`
- Git bundle SHA-256: `7BCD01CE75B8688281E2001A1CD2965BF2BCD9C7F1DF296CD370789A65A008A4`
- bundle 검증: 새 빈 경로에서 실제 clone, 기준 커밋 detach, 백업 태그 대상 확인, `git fsck --full --no-dangling`, 누락 객체 0건 통과
- 사용 금지: `wb-site_e443837_full.bundle`은 shallow 저장소의 부모 객체가 빠져 실제 clone에 실패하므로 복구에 사용하지 않는다.
- 소스 ZIP SHA-256: `3B4FA1F6AF781226928C902D311E3721A631AEBAC86A490AD66C2DC036CBF903`
- D1 SQL: `wb-sync_remote_after_browser_sync_20260803_004755.sql`
- D1 SQL SHA-256: `3C686E47A3BB06F462D394132411C19B25271FD8A1D1907B197E9E30B936BBF5`
- 백업 당시 운영 행: staff 22, tasks 77, checks 95, tokens 0
- Worker 기준 deployment: `42353f4f-5c8d-4c99-a5c2-1e3a07bc2719`
- Worker 기준 version: `c7bd7bad-ec45-4baa-8dac-64a866d54dd0`

백업의 `BACKUP_MANIFEST.md`와 실제 파일 해시를 먼저 대조한다.
운영 배포 승인 시에는 이 기준 커밋을 `-ExpectedBackupCommit e44383727cd136dfee082022b4d633ab5edd4745`로 명시해, 다른 시점의 완전한 백업이 실수로 승인 게이트를 통과하지 못하게 한다.

빠른 코드 복구 검증은 백업 폴더에서 검증된 standalone bundle로 수행한다.

```powershell
git clone .\wb-site_e443837_standalone.bundle C:\tmp\wb-site-recovery
git -C C:\tmp\wb-site-recovery switch --detach e44383727cd136dfee082022b4d633ab5edd4745
git -C C:\tmp\wb-site-recovery show-ref --verify refs/tags/backup-pre-learning-platform-v2-20260803-004401
git -C C:\tmp\wb-site-recovery fsck --full --no-dangling
```

- 변경 전 보존 기준은 원격 태그 `backup-pre-learning-platform-v2-20260803-004401`과 검증된 백업 manifest다.
- 이 기준점은 소스·데이터 비교와 최후 복원 자료이지, 신규 개인 링크 발급 뒤 그대로 운영 배포할 수 있는 인증 호환 산출물이 아니다.
- migration `003` 뒤의 token은 `sha256:<digest>`이고 개인 링크는 `/token`→`/exchange` bootstrap 계약을 사용한다. 구형 Worker와 구형 정적 앱은 이 계약을 함께 이해하지 못한다.
- 2026-08-03 현재 preview Worker와 preview D1은 아직 생성되지 않았다. 실제 rollback 연습은 preview 자원 생성·배포 승인을 받은 뒤에만 수행한다.

## 운영 전 필수 rollback 산출물

운영 첫 개인 링크 전에 다음 두 후보를 같은 Git SHA 기준으로 만들어 preview smoke 해야 한다.

1. **호환 rollback Worker**: `sha256:` token, `/token`, `/exchange`, `/revoke`, 기존 `/sync` 권한을 유지하고 `LEARNING_V2_ENABLED=false`로 학습 v2 쓰기를 닫는다.
2. **호환 rollback 정적 산출물**: bootstrap code 교환과 현재 sync 인증은 유지하되 신규 통합 학습 메뉴·쓰기 진입만 숨기거나 비활성화한다.

기준 태그의 구형 Worker/정적 파일을 호환 rollback이라고 부르지 않는다. 위 두 후보의 SHA, 테스트, Worker version, 정적 artifact 해시가 없으면 production 배포를 보류한다.

## 단계별 실패 경계

- 비변환 `schema.sql` 또는 호환 Worker 배포 전에 실패하면 token은 변환되지 않았으므로 기존 Worker 상태를 유지한다.
- 호환 Worker 배포 뒤 `002`/`003` 전에 실패하면 새 Worker를 유지한다. 이 Worker는 raw와 `sha256:` token을 모두 읽으므로 원인을 해결한 뒤 같은 승인 실행을 재개한다.
- `003` 시작 뒤에는 기준 태그의 구형 Worker로 되돌리지 않는다. 영수증의 `failedPhase`, `compatibleWorkerDeployed`, `tokenTransformStarted`를 확인하고 호환 Worker 또는 검증된 호환 rollback Worker만 사용한다.
- 활성 bearer가 있으면 같은 표본의 pre/post smoke가 모두 성공하지 않은 실행을 완료로 처리하지 않는다.

## 장애 분류와 최소 복구

1. [승인필요] maintenance window를 열어 신규 쓰기와 개인 링크 발급을 중지한다.
2. 장애 상태의 Git SHA, 정적 artifact, Worker deployment/version, D1 export와 release receipt를 별도 보존한다.
3. health·인증·sync·학습 UI·D1 중 장애 경계를 분류한다.
4. 아래에서 가장 작은 범위만 반영하고 smoke 후 쓰기를 재개한다.

### 정적 학습 UI 장애

호환 rollback 정적 산출물을 배포한다. 이 산출물은 학습 UI만 끄고 `/exchange`와 sha256/bootstrap 인증 계약은 유지해야 한다. 백업 태그의 구형 정적 앱을 바로 배포하면 새 Worker의 `/token` 응답과 링크 교환 계약이 깨질 수 있으므로 금지한다.

### Worker 학습 경로 장애

현재 인증 호환 Worker를 유지하면서 `LEARNING_V2_ENABLED=false`를 확인하고, 필요하면 preview에서 검증한 호환 rollback Worker version을 배포한다. 첫 개인 링크 뒤에는 Cloudflare의 구형 legacy-auth version으로 되돌리지 않는다.

### D1 v2 장애

`lp_*`와 `bootstrap_codes`는 추가형이므로 급히 DROP/DELETE하지 않는다. v2를 false로 닫고 기존 `staff/tasks/checks/tokens`를 보존한다. 기존 운영 테이블이 손상된 경우에만 사람 승인으로 새 D1을 만들고 검증된 SQL을 **새 D1**에 적용한 뒤 preview Worker로 표본 검증한다. 운영 D1 위에 백업 SQL을 덮어쓰지 않는다.

### 003 이전으로의 예외적 전체 복귀

다음 조건을 모두 증명한 초기 canary에서만 검토한다.

- `tokens=0`, `bootstrap_codes=0`이고 새 개인 링크가 한 번도 전달되지 않음
- maintenance window 안에서 쓰기 중지
- preview에서 구형 Worker·정적 조합을 함께 smoke
- 사람의 별도 전체 rollback 승인

하나라도 증명하지 못하면 호환 rollback 경로만 사용한다.

## 복구 smoke와 재개

- `/health`, `/api/v2/learning/health`의 `enabled:false`
- 관리자 인증, 신규 1회 code 교환, code 재사용 410, 기존 bearer 인증, 대상 해지 401
- 자기 범위 sync 성공·타인 쓰기 거부·422 원자 거절·pagination
- `/search` 강좌 필터, `/curriculum` 403 직접 붙여넣기 안내
- 기존 `/consult/`, `/task/` 핵심 화면과 데이터 보존
- 호환 rollback 정적 화면에서 신규 학습 쓰기 진입 비활성

smoke가 모두 통과해야 [승인필요] 쓰기를 재개한다. 이후 24시간 인증 오류, 4xx/5xx, sync 거절, 확인대기 적체를 감시한다.

## Codex 역할

[Codex] 백업 해시, 장애 diff, 호환 rollback Worker·정적 후보, 테스트와 데이터 비교표를 준비한다.

## 코워크 역할

[코워크] 자동화 중지 후보, 영향 학생·업무 목록, 재처리 후보, 24시간 장애·복구 로그를 모은다. 실제 반영은 승인 전 실행하지 않는다.

## 사람 승인 게이트

[승인필요] maintenance 개폐, 운영 쓰기 중지·재개, Worker/정적 rollback, 새 D1·binding, secret 회전, 사용자 안내를 각각 승인한다.

## 반복 실행 흐름

`쓰기 중지 → 장애 상태 백업 → 경계 분류 → 호환 최소 복구 → smoke → 사람 승인 → 쓰기 재개 → 24시간 감시`

## 에이전트 간 전달물

`incident_snapshot`, `compatible_worker_candidate`, `compatible_static_candidate`, `data_count_comparison`, `smoke_test_result`, `release_resume_candidate`

## 로그/인수인계 기준

백업·artifact SHA-256, Git SHA, Worker version, D1 ID·행 수, release receipt, maintenance ID, 승인자·시각, smoke와 24시간 지표를 기록한다. 비밀값과 개인 bearer/code는 기록하지 않는다.
