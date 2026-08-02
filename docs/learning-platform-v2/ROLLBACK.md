# WB 통합 학습 플랫폼 v2 복구 절차

## 복구 기준점

- Git 기준 커밋: `e44383727cd136dfee082022b4d633ab5edd4745`
- 원격 백업 태그: `backup-pre-learning-platform-v2-20260803-004401`
- 백업 폴더: `C:\Users\HeungPC\Desktop\코워크\마케팅\.codex_build\backups\wb-site_pre_learning_platform_v2_20260803_004401`
- Git bundle SHA-256: `88C9B8A9546EF6F1DCD2766044DDB1EA674B7BB984B4F8E49BFFBFFBF4ABB7EE`
- 소스 ZIP SHA-256: `3B4FA1F6AF781226928C902D311E3721A631AEBAC86A490AD66C2DC036CBF903`
- D1 SQL: `wb-sync_remote_after_browser_sync_20260803_004755.sql`
- D1 SQL SHA-256: `3C686E47A3BB06F462D394132411C19B25271FD8A1D1907B197E9E30B936BBF5`
- 백업 당시 운영 행: staff 22, tasks 77, checks 95, tokens 0
- Worker 기준 deployment: `42353f4f-5c8d-4c99-a5c2-1e3a07bc2719`
- Worker 기준 version: `c7bd7bad-ec45-4baa-8dac-64a866d54dd0`

백업의 `BACKUP_MANIFEST.md`와 실제 파일 해시를 먼저 대조한다.

## 복구 순서

1. [승인필요] 새 쓰기와 자동화를 잠시 중지한다.
2. 현재 상태를 별도 Git bundle·소스 ZIP·D1 SQL로 다시 보존한다. 장애 상태도 감사와 사후 분석에 필요하다.
3. 증상이 프런트, Worker, D1 중 어디에서 시작됐는지 분류한다.
4. 가장 작은 범위만 되돌리고 smoke test 후 쓰기를 재개한다.

## 프런트엔드 복구

신규 프런트는 bootstrap `/exchange`와 학습 prefix를 사용하므로 전체 rollback은 반드시 **프런트엔드를 먼저** 되돌리고 그 다음 Worker를 판단한다. 반대로 새 프런트를 구형 Worker에 남겨두면 개인 링크와 학습 동기화가 실패한다.

현재 작업 폴더를 강제로 초기화하지 않는다. 백업 태그에서 별도 복구 브랜치를 만든 뒤 정적 앱을 검증하고 배포한다.

```powershell
git switch -c restore/pre-learning-platform-v2 backup-pre-learning-platform-v2-20260803-004401
```

검증 항목:

- `/consult/`와 `/task/`가 열린다.
- 기존 학생·직원·업무·체크가 조회된다.
- 원장과 개인 링크의 권한이 분리된다.
- 비밀키·PIN이 URL이나 내보내기 파일에 나타나지 않는다.

신규 localStorage 학습 키는 이전 코드가 읽지 않으므로 프런트 복구만으로 삭제하지 않는다. 데이터 삭제가 필요하면 별도 승인과 백업 후 학생별 정확한 키만 대상으로 한다.

## Worker 복구

[승인필요] 먼저 프런트 복구와 쓰기 중지를 확인한다. `003` 적용 뒤 발급된 `sha256:` bearer는 기준 구형 Worker가 이해하지 못하므로, 개인 링크가 실제 배포된 뒤에는 기준 version을 무조건 되돌리지 않는다. 학습 기능만 끄되 bootstrap·접두해시 인증을 유지한 호환 rollback Worker를 우선 사용한다. 초기 canary에서 아직 개인 링크를 발급하지 않았고 token 행이 0임을 확인한 경우에만 Cloudflare 배포 이력의 기준 version rollback을 선택할 수 있다.

백업 태그의 `sync/` 소스를 사용할 때도 token 호환 조건을 먼저 검증한다.

복구 직후 확인:

- `/health`
- 관리자 인증과 개인 토큰 인증
- 자기 범위 읽기/쓰기와 타인 쓰기 거부
- `/search` 강좌 필터
- `/curriculum` 403 직접 붙여넣기 안내
- push 422 원자 거절과 pull pagination

비밀키를 코드·명령행·문서에 복사하지 않는다. 복구 과정에서 비밀키를 변경해야 하면 별도 사람 승인과 회전 기록이 필요하다.

## D1 복구

v2 스키마와 `bootstrap_codes`는 추가형이므로 Worker나 프런트를 되돌려도 급히 삭제하지 않는다. 이전 Worker가 이 테이블을 읽지 않으므로 그대로 보존하는 편이 안전하다.

기존 `staff/tasks/checks/tokens` 데이터 자체가 손상된 경우:

1. [승인필요] 새 D1 데이터베이스를 만든다.
2. 검증된 D1 SQL을 새 데이터베이스에 적용한다.
3. staff 22, tasks 77, checks 95, tokens 0과 표본 레코드를 대조한다.
4. 새 Worker preview에 새 D1을 연결해 읽기·쓰기 smoke test를 한다.
5. 운영 binding을 새 D1으로 바꾸고 배포한다.
6. 기존 손상 D1은 삭제하지 않고 읽기 전용 보관한다.

검증 없이 운영 D1 위에 백업 SQL을 덮어쓰지 않는다.

## 복구 완료 판정

- 데이터 기준 행 수와 표본이 일치한다.
- 기존 핵심 화면과 동기화가 정상이다.
- 개인 토큰으로 토큰 발급·타인 쓰기가 불가능하다.
- 브라우저 오류 로그가 없다.
- 장애 원인·복구 revision·승인자·복구시각·잔여 보류사항이 기록됐다.

## Codex 역할

[Codex] 백업 해시 확인, 복구 브랜치·테스트·diff 작성과 기술적 검증을 수행한다.

## 코워크 역할

[코워크] 복구 중 자동화 중지 후보, 영향 학생·업무 목록, 재처리 후보와 장애 로그를 모은다. 실제 재처리는 승인 전 실행하지 않는다.

## 사람 승인 게이트

[승인필요] 운영 쓰기 중지·재개, Worker rollback, D1 binding 변경, 새 D1 전환, 비밀키 회전, 사용자 안내 발송을 승인한다.

## 반복 실행 흐름

`쓰기 중지 → 장애 상태 백업 → 최소 범위 복구 → 자동 테스트 → preview smoke test → 사람 승인 → 운영 전환 → 사후 점검`

## 에이전트 간 전달물

`incident_snapshot`, `rollback_candidate`, `data_count_comparison`, `smoke_test_result`, `reprocess_candidate`, `release_resume_candidate`

## 로그/인수인계 기준

백업 파일명·SHA-256·Git revision·Worker version·D1 ID·행 수·명령 결과·승인자·시각을 기록하되 비밀값과 개인 토큰은 기록하지 않는다.
