# WB 통합 학습 플랫폼 v2 릴리스 체크리스트

## 1. 변경 범위

- [ ] 기존 `/consult/`, `/task/` 핵심 기능 회귀 확인
- [ ] 검색 결과가 강좌 상세 중심이고 후기·교재를 제외함
- [ ] 강좌 가져오기 403이 직접 붙여넣기 안내로 전환됨
- [ ] 역할별 저장소·동기화 커서가 분리됨
- [ ] 관리자 PIN이 PBKDF2로 저장됨
- [ ] 비밀키·PIN·bearer는 URL·백업·staff 데이터에 없고, 24시간 1회용 `#c=` code는 네트워크 요청 전에 fragment에서 제거됨
- [ ] 통합 학습 탭이 같은 앱 안에서 열림

## 2. 학습 기능

- [ ] 스터디포스·클래스카드·메타수학·NELT와 미래 provider 등록 가능
- [ ] CSV/JSON 미리보기→검증→사람 반영 흐름
- [ ] 비밀번호·토큰·쿠키 열 차단
- [ ] 동일 입력 중복 방지와 충돌 확인필요 처리
- [ ] 오늘·주간 플래너 완료요청→확인대기→사람 검증
- [ ] NELT 3개월, 메타수학 주간·월말 일정 중복 없이 생성
- [ ] 초등 학교 정기시험 기본 비활성
- [ ] 초등 경시/KMT/NELT/영재원/입학/레벨/custom 선택 활성화
- [ ] 교재 오답은 참조만 저장
- [ ] 쌍둥이 문제 결과가 사람 확인 전 자동 숙달되지 않음

## 3. 자동 검증

```powershell
node --test consult\learning-platform.test.cjs consult\learning-shell.test.cjs consult\learning-persistence.test.cjs consult\program-imports.test.js consult\program-import-ui.test.cjs sync\worker-core.test.mjs sync\worker-regression.test.mjs sync\learning-v2.test.mjs sync\security-static.test.mjs
node scripts\check-inline-html.mjs consult\index.html task\index.html
```

- [ ] 모든 테스트 통과
- [ ] 인라인 JavaScript 문법 통과
- [ ] 로컬 D1에 기본 schema 적용
- [ ] v2 migration 첫 적용 통과
- [ ] 같은 v2 migration 두 번째 적용 통과
- [ ] `lp_schema_migrations` version 2와 3이 각각 정확히 1행이고 `applied_at>0`
- [ ] `002`와 `003`을 두 번 적용해도 schema·토큰·bootstrap 행이 안정적임
- [ ] v2 health는 `enabled:false`, 쓰기 API는 503임
- [ ] Worker `deploy --dry-run` 통과

## 4. 브라우저 smoke test

- [ ] 초등 학생 생성
- [ ] 통합 학습 초기화
- [ ] 초등 캠페인 목록에 학교 정기시험이 없음
- [ ] 경시대회 초안→동의·활성화→시험대비 탭 표시
- [ ] 정상 CSV 1행 사람 승인 반영
- [ ] 자격정보 열이 든 CSV는 0행 승인·1행 차단
- [ ] 오답등록→쌍둥이 생성요청 후 자동 숙달 없음
- [ ] 수행 완료 요청 후 관리자 확인대기 버튼 즉시 표시
- [ ] 관리자 검증 후 완료 표시
- [ ] 재접속 뒤 프로그램·캠페인·오답·완료 상태 보존
- [ ] 키보드 좌우 화살표 탭 이동
- [ ] 375px 모바일 폭에서 가로 넘침 없음
- [ ] 콘솔 error/warn 없음
- [ ] preview에서 1회용 링크 교환 성공·재사용 410·관리자 해지 후 bearer 401
- [ ] 구형 `?t=` 링크가 저장되지 않고 새 링크 안내만 표시됨

## 5. 백업·복구

- [ ] 백업 Git bundle·소스 ZIP·D1 SQL 존재
- [ ] 세 파일의 SHA-256이 `BACKUP_MANIFEST.md`와 일치
- [ ] 원격 백업 태그 존재
- [ ] 현재 운영 Worker deployment/version 기록
- [ ] `ROLLBACK.md`를 운영 담당자가 확인
- [ ] 운영 변경 직전 D1을 한 번 더 export

## 6. 단계 배포

1. [Codex] feature branch와 diff를 최종 감사한다.
2. [Codex] Worker bundle dry-run과 로컬 D1 migration을 검증한다.
3. [승인필요] preview/staging Worker에 additive migration과 코드를 배포한다.
4. [코워크] 테스트 학생 후보만으로 1회 주기를 실행하고 로그를 모은다.
5. [승인필요] 운영 D1 migration과 Worker 배포를 승인한다.
6. [승인필요] 정적 앱을 운영 브랜치에 반영하고 token exchange preview smoke를 수행한다.
7. [승인필요] 이미 공유된 구형 `s=` 복구 링크를 무효화하도록 관리자 secret을 회전하고 승인된 원장 기기에 새 값을 입력한다.
8. [코워크] 24시간 동안 인증 오류, 4xx/5xx, 거절 배치, 확인대기 적체, 중복키를 감시한다.
9. 이상 시 `ROLLBACK.md`의 최소 범위 복구를 실행한다.

## Codex 역할

[Codex] 코드·스키마·문서·자동 테스트·브라우저 smoke test·배포 후보와 복구 후보를 준비한다.

## 코워크 역할

[코워크] 정기 후보 생성, 오류 큐, 확인대기 적체, 중복키, 배포 후 상태를 반복 점검한다. 기본값은 `dry_run`이다.

## 사람 승인 게이트

[승인필요] 운영 D1 migration, Worker·정적 앱 운영 배포, 외부 계정 변경, 결과 확정, 학생·보호자 동의, 실제 메시지 발송을 승인한다.

## 반복 실행 흐름

`백업 확인 → 자동 테스트 → 로컬 migration → Worker dry-run → preview → 사람 승인 → 운영 배포 → 24시간 점검 → 완료 또는 rollback`

## 에이전트 간 전달물

`release_candidate`, `migration_result`, `browser_smoke_result`, `approval_request`, `deployment_receipt`, `postdeploy_health`, `rollback_candidate`

## 로그/인수인계 기준

Git revision, 테스트 수·결과, D1 migration version, Worker version, 배포시각, 승인자, 검증 학생 범위, 오류·보류 항목을 기록한다. 비밀값과 개인 식별 토큰은 제외한다.


## 인증 안전장치 완료 항목

- [x] DB에는 `sha256:<digest>`만 저장하고 원문 bearer만 인증한다. bare 64hex와 `sha256:` bearer는 거부한다.
- [x] 링크에는 장기 bearer 대신 `?u=<id>#c=<code>` 형식의 24시간 유효 1회용 bootstrap code만 넣고, 네트워크 요청 전에 fragment를 제거한다.
- [x] bootstrap 저장소의 `created_at`, `expires_at`, `consumed_at`, `revoked`로 원자적 1회 소비와 재사용 거부를 검증한다.
- [x] 링크 발급만으로 활성 bearer를 해지하지 않고, 교환 성공 시에만 기존 bearer를 회전한다. bearer 유효기간은 90일이다.
- [x] 운영 UI에서 대상별 `staffId` 해지를 제공해 활성 bearer와 미사용 code를 함께 폐기한다.
- [x] 구형 `?t=`는 저장·인증하지 않고 즉시 주소에서 제거한 뒤 새 링크 안내를 표시한다.

위 항목은 자동 회귀 테스트로 검증한다. 실제 운영 반영 여부는 migration version 3, Worker revision, 배포 영수증과 배포 후 health check로 별도 확인한다.
