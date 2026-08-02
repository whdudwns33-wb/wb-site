# WB 동기화 백엔드 (Cloudflare Workers + D1)

`/task/`와 `/consult/`의 변경 행만 동기화하는 Worker다. 개인 code·bearer는 서버에 `sha256:<digest>`로 저장하며, 일반 개인은 자기 owner 범위만 읽고 쓴다. task 운영 화면의 `ct/exam/op/opset` 4종 check만 allowlist로 공유하고, 관리자와 명시적 manager만 전체 범위를 조회한다.

## 현재 릴리스 정책

- 기존 `staff/tasks/checks` 경로가 운영 저장소다.
- 학습 화면은 분할된 legacy bridge를 사용한다. 학생은 `lpclaim` 완료요청만 쓸 수 있고 학습 원장 blob은 관리자/manager만 쓴다.
- `/api/v2/learning`은 다음 단계용 기반이며 운영에서는 `LEARNING_V2_ENABLED=false`다. health만 상태를 공개하고 쓰기 API는 열지 않는다.
- 스터디포스·클래스카드·메타수학·NELT는 공식 계약이 확인되기 전 수동 CSV/JSON 후보만 받는다.

## 안전 배포 순서

직접 `wrangler deploy`하지 않는다. 순서는 반드시 다음과 같다.

1. 운영 직전 Git bundle·소스 ZIP·D1 SQL 백업 생성 및 복원 검증
2. 모든 신규 파일을 포함한 clean commit 준비 (`git add -A` 누락 금지)
3. 자동 테스트와 인라인 JS 검사
4. `deploy-safe.ps1` Worker dry-run
5. [승인필요] 번호순 additive migration(002 → 003) → migration 원장 version 2·3 확인
6. [승인필요] Worker 배포 → `/health`와 비활성 v2 health smoke test
7. [승인필요] 정적 프런트 배포
8. 24시간 인증 오류·4xx/5xx·거절 배치·확인대기 적체 감시

검증만 실행:

~~~powershell
cd sync
.\deploy-safe.ps1
~~~

운영 변경은 검증한 40자리 커밋, 24시간 이내 백업 폴더, 실제 Worker URL, 확인 문구가 모두 필요하다.

~~~powershell
.\deploy-safe.ps1 -ApplyMigrations -Deploy `
  -BackupDirectory 'C:\path\to\verified-backup' `
  -ExpectedCommit '<40자리 검증 SHA>' `
  -HealthUrl 'https://<worker-host>' `
  -ConfirmProduction WB-SYNC-PRODUCTION
~~~

스크립트는 백업 manifest의 bundle·ZIP·D1 SQL SHA-256과 Git bundle을 실제 검증하고, dirty/untracked worktree를 거부하며, 배포 전후 Worker 이력을 `.release-receipts`에 남긴다. 정적 프런트 배포는 자동으로 수행하지 않는다.

## 비밀값

`wrangler.toml`, 코드, URL, 문서에 비밀값을 쓰지 않는다. Cloudflare secret으로만 등록한다.

~~~powershell
npx wrangler secret put TASK_ADMIN_SECRET
npx wrangler secret put CONSULT_ADMIN_SECRET
npx wrangler secret put NAVER_ID
npx wrangler secret put NAVER_SECRET
~~~

기존 `s=` 복구 링크는 폐기됐다. 이미 공유된 구형 링크가 있다면 [승인필요] 관리자 secret 회전 후 새 연결을 설정한다.

## 주요 API

- `GET /health`: Worker 상태
- `POST /sync`: 역할·owner 검증 후 원자적 delta push/pull
- `POST /token`: 관리자만 24시간 유효한 1회용 개인 링크 code 발급
- `POST /exchange`: 대상이 1회용 code를 교환해 90일 bearer 발급
- `POST /revoke`: 관리자만 `staffId` 단위로 bearer와 미사용 code를 즉시 해지

링크에는 `?u=<id>#c=<code>`만 들어가며 code는 네트워크 요청 전에 주소에서 제거된다. code 원문은 발급 응답에서 한 번만 제공되고 DB에는 `sha256:<digest>`만 저장된다. 링크를 새로 만드는 것만으로 기존 bearer는 끊기지 않으며, code 교환이 성공한 원자 트랜잭션에서만 이전 bearer를 회전한다.
- `POST /search`: 후기·교재를 제외한 강좌 상세 후보 검색
- `POST /curriculum`: 허용 호스트의 강의목차 추출; 403·동적 페이지는 직접 붙여넣기 안내
- `GET /api/v2/learning/health`: v2 foundation의 enabled 상태

모든 sync push는 배치 전체 검증 후 저장한다. 한 건이라도 권한·형식 오류가 있으면 422로 전체 거절하며 클라이언트는 `rejected>0` 응답도 실패로 처리한다.

## 검증

~~~powershell
node --test ..\consult\learning-platform.test.cjs ..\consult\learning-shell.test.cjs ..\consult\learning-persistence.test.cjs ..\consult\program-imports.test.js ..\consult\program-import-ui.test.cjs .\worker-core.test.mjs .\worker-regression.test.mjs .\learning-v2.test.mjs .\security-static.test.mjs
node ..\scripts\check-inline-html.mjs ..\consult\index.html ..\task\index.html
~~~

복구 기준과 최소 범위 rollback은 `../docs/learning-platform-v2/ROLLBACK.md`를 따른다.
