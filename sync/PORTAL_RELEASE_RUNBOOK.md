# 보호자·학생 앱 운영 배포 및 실제 기기 확인

이 문서는 **기존 운영 D1**에 보호자 앱 Phase 3·4와 학생 앱 공개 v1·v2를 반영할 때 사용한다.
학생 이름, 전화번호, 초대코드, 세션값, 관리자 비밀키는 터미널·채팅·검증 기록에 남기지 않는다.

## 완료 기준

- 운영 D1에 필요한 `036 → 037 → 038 → 039` 구조가 정확히 존재한다.
- 보호자·직원 Worker, 학생 전용 Worker, task 화면이 이 순서로 배포된다.
- 관리자 미리보기는 DB 행이나 쿠키를 만들지 않는다.
- 동의받은 시험 학생 한 명이 휴대폰과 태블릿에서 학생 앱을 연다.
- 학생 앱에는 오늘 수업·출결·5단계, 오늘 차량, 최근 14일 공개 숙제·준비물,
  배정 교재 상태, 주간 시간표만 보인다.
- 기존 학생 공개 v1 세션에는 외부 학습 링크가 보이지 않고, 보호자가 v2 범위를 다시 확인한
  학생에게만 메타수학·클래스카드 공식 화면 링크 두 개가 보인다.
- 보호자 요청, 보강, 회차, 공지, 주문 상태, 연락처, 주소, 내부 메모, 다른 학생 정보는 보이지 않는다.
- 연결을 끄면 기존 초대코드와 모든 학생 세션이 즉시 사용할 수 없게 된다.

## 2026-08-18 KST 배포 결과

배포 전 probe에서 `039`가 정확히 `0/4`, `0/4`인 것을 확인한 뒤 한 번 적용했고,
두 Worker와 Pages를 정해진 순서로 배포했다. 아래는 배포 후 읽기 전용으로 다시 확인한 상태다.

| 점검 | 현재 운영 상태 |
|---|---|
| 선행 테이블 | `9/9` |
| 036 객체 | `10/10` — 적용됨 |
| 037 객체 | `21/21` — 적용됨 |
| 038 객체·열 | `10/10`, `2/2` — 적용됨 |
| 039 객체·열 | `4/4`, `4/4` — 적용됨 |
| 보호자·직원 Worker health | HTTP `200` |
| 학생 Worker health | HTTP `200` |
| 원격 task/consult/version | `2026-08-18.1` |
| 배포 커밋 | `8a0cf73` |

사후 probe는 `rows_written: 0`, `changed_db: false`였고 두 Worker health와 공개 Origin 경계도
정상이다. `036`~`039`는 모두 운영에 적용됐으므로 재실행하지 않는다. 이후 변경은 새 migration으로만
추가한다.

## 1. 코드 검증

저장소 루트에서 실행한다.

```bash
node --test --test-isolation=none sync/*.test.mjs task/*.test.cjs parent/*.test.cjs student/*.test.cjs consult/*.test.cjs
git diff --check
node --check sync/worker.js
node --check sync/worker-core.js
node --check sync/student-worker.js
node --check sync/student-portal.js
```

배포 파일 생성만 확인한다. 이 명령은 운영에 배포하지 않는다.

```bash
cd sync
npx wrangler deploy --dry-run
npx wrangler deploy --config wrangler.student.toml --dry-run
```

하나라도 실패하면 D1이나 Worker를 변경하지 않는다.

## 2. 운영 D1 사전 확인

`deploy.ps1`은 **새 설치 전용**이다. 기존 `wb-sync` 운영 DB에는 실행하지 않는다.
기존 DB는 Cloudflare의 D1 복구점 또는 암호화 백업을 먼저 확보한 뒤 아래의 읽기 전용 확인부터
시작한다. 백업 파일은 저장소·채팅·공용 폴더에 두지 않는다. 두 Wrangler 설정의 `database_id`가
같은 운영 DB인지, main 설정의 `ALLOW_ORIGIN`이 task Pages origin인지, 두 설정의
`WB_STUDENT_PORTAL_BASE_URL`이 동일한 HTTPS root인지도 눈으로 확인한다.

```bash
cd sync
PORTAL_PROBE_SQL="$(sed '/^[[:space:]]*--/d' ./portal-release-probe.sql)"
npx wrangler d1 execute wb-sync --remote --command "$PORTAL_PROBE_SQL"
unset PORTAL_PROBE_SQL
```

probe는 설명 주석을 뺀 뒤 읽기 전용 `--command`로 실행한다. `--file`은 Wrangler의 import 경로를
사용해 읽기 전용 점검에도 운영 DB 일시 잠금과 별도 인증을 요구할 수 있으므로 probe에는 쓰지 않는다.

판정은 다음과 같이 한다.

- `prerequisite_tables`는 `9/9`여야 한다. 아니면 중단한다.
- `migration_036_objects`는 `0/10`이면 036을 한 번 적용하고, `10/10`이면 건너뛴다.
- `migration_037_objects`는 `0/21`이면 037을 한 번 적용하고, `21/21`이면 건너뛴다.
- `migration_038_objects`와 `migration_038_columns`는 각각 `0/10`, `0/2`일 때만 038을
  한 번 적용하고, 각각 `10/10`, `2/2`이면 건너뛴다.
- `migration_039_objects`와 `migration_039_columns`는 각각 `0/4`, `0/4`일 때만 039를
  한 번 적용하고, 각각 `4/4`, `4/4`이면 건너뛴다.
- 일부만 있으면 **중단**한다. 같은 파일을 다시 실행하거나 스키마를 손으로 고치지 않는다.
- 036은 테이블 2 + 인덱스 2 + 트리거 6, 037은 테이블 3 + 인덱스 4 + 트리거 14,
  038은 테이블 3 + 인덱스 2 + 트리거 5와 열 2, 039는 학생 access/code/session의
  `effective_scope_version` 열 3개, access의 `scope_confirmed_at` 열 1개와 범위 보호 트리거
  4개가 완전한 상태다.
- 이 저장소는 과거에 SQL 파일을 직접 적용한 이력이 있으므로 `d1_migrations` 기록만으로
  적용 여부를 판단하지 않는다.

## 3. 필요한 마이그레이션만 1회 적용

사전 확인에서 **완전히 미적용**으로 확인된 파일만 아래 순서로 실행한다.

```bash
npx wrangler d1 execute wb-sync --remote --file=./migrations/036_guardian_announcements.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/037_book_order_identity_snapshots.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/038_student_portal.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/039_student_portal_scope_v2.sql
```

`038`과 `039`에는 `ALTER TABLE`이 있으므로 맹목적으로 재실행하면 안 된다. 적용 직후 probe를 다시
실행하고 `9/9`, `10/10`, `21/21`, `10/10`, `2/2`, `4/4`, `4/4`을 모두 확인한다.

- `guardian_announcements`, `guardian_announcement_events`
- `book_order_student_snapshots`, `book_order_active_targets`, `book_order_cancellations`
- `student_portal_access`, `student_portal_codes`, `student_portal_sessions`
- `guardian_lesson_publications.student_visible`
- `guardian_lesson_publication_events.student_visible`
- `student_portal_access/codes/sessions.effective_scope_version`
- `student_portal_access.scope_confirmed_at`

어느 하나라도 빠지면 Worker를 배포하지 않는다.

## 4. 설정과 배포

두 Wrangler 설정의 `WB_STUDENT_PORTAL_BASE_URL`은 query와 hash가 없는 동일한 학생 Worker
HTTPS 루트여야 한다. 비밀값은 파일에 적지 않는다.

```bash
npx wrangler deploy
npx wrangler deploy --config wrangler.student.toml
```

배포 순서는 반드시 다음과 같다.

1. 운영 D1 `036 → 037 → 038 → 039`
2. 보호자·직원 Worker (`wrangler.toml`)
3. 학생 전용 Worker (`wrangler.student.toml`)
4. task Pages와 `version.json`

두 Worker의 상태만 먼저 확인한다.

```bash
curl -fsS https://wb-sync.whdudwns33.workers.dev/health
curl -fsS https://wb-student.whdudwns33.workers.dev/health
```

둘 중 하나라도 200이 아니면 화면 배포를 중단한다.

쿠키나 초대코드 없이 origin 경계도 확인한다. 아래 네 응답은 순서대로 `401`, `403`, `403`,
`403`이어야 한다.

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -H 'Origin: https://wb-student.whdudwns33.workers.dev' --data '{"app":"task","action":"view"}' https://wb-student.whdudwns33.workers.dev/student-portal
curl -sS -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' --data '{"app":"task","action":"view"}' https://wb-student.whdudwns33.workers.dev/student-portal
curl -sS -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -H 'Origin: https://example.invalid' --data '{"app":"task","action":"view"}' https://wb-student.whdudwns33.workers.dev/student-portal
curl -sS -w '\n%{http_code}\n' -X POST -H 'Content-Type: application/json' -H 'Origin: https://whdudwns33-wb.github.io' --data '{"app":"task","action":"view"}' https://wb-sync.whdudwns33.workers.dev/student-portal
```

마지막 응답 본문에는 `학생 앱 전용 주소`도 있어야 한다. 그래야 main Worker의 전역 Origin 차단이
아니라 public 학생 action 자체가 분리된 것을 확인할 수 있다.

학생 앱 root의 응답 헤더에는 `no-store`, `noindex`, `frame-ancestors 'none'` 또는 동등한 차단이
있어야 한다.

```bash
curl -fsSI https://wb-student.whdudwns33.workers.dev/
```

## 5. 관리자 미리보기 확인

1. task 앱의 설정에서 학생 앱 연결 카드를 연다.
2. 아직 연결하지 않은 시험 학생을 선택한다.
3. `학생 화면 미리보기`를 연다.
4. 미리보기 전후 `student_portal_access`, `student_portal_codes`,
   `student_portal_sessions`의 해당 시험 학생 행 수가 변하지 않았는지 **개수만** 확인한다.
5. 미리보기에 전화번호·주소·내부 메모·보호자 전용 정보가 없는지 확인한다.

미리보기는 동의나 초대코드 발급을 대신하지 않는다.

## 6. 실제 휴대폰·태블릿 확인

반드시 보호자에게 학생 앱 공개 v2 범위와 외부 서비스 이동 시 처리될 수 있는 기기·접속 기록·
서비스 쿠키를 설명하고 동의를 받은 시험 학생으로 진행한다. WB는 외부 아이디·비밀번호·학습 결과를
받거나 저장하지 않는다.

1. 관리자 화면에서 보호자 연락처 연결 상태를 확인한다.
2. 학생 앱 공개 동의 확인란을 선택해 연결을 켠다.
3. 새 초대 링크를 한 번 발급한다. 링크나 코드를 채팅·캡처에 남기지 않는다.
4. 학생 휴대폰 Chrome 또는 Safari에서 링크를 연다.
5. 주소창에서 초대 fragment가 즉시 사라지고 화면이 열린 것을 확인한다.
6. 오늘 수업·차량·최근 공개 기록·배정 교재·주간 시간표를 각각 확인한다.
7. 메타수학·클래스카드 링크가 정확히 두 개만 보이고, 새 창/탭의 공식 HTTPS 주소로 열리는지 확인한다.
8. 앱을 백그라운드로 보냈다가 다시 열고, 새로고침 후에도 같은 학생만 보이는지 확인한다.
9. 태블릿에도 별도로 연결해 같은 항목과 모바일 배치를 확인한다.
10. 이미 연결된 기기에서 새 링크를 열면 기존 연결 안내와 로그아웃 동작이 보이고,
   로그아웃 뒤 새 링크가 정상 교환되는지 확인한다.
11. 관리자 화면에서 연결을 끈 뒤 휴대폰·태블릿을 새로고침해 모두 접근이 거절되는지 확인한다.

학생 앱에서 수정·응답·자유 입력·전화 걸기가 보이면 실패로 판정한다. 기존 v1 세션에 외부 링크가
보이거나, v2 화면에 승인된 메타수학·클래스카드 공식 HTTPS 주소 외의 링크·iframe·자동 로그인이
있어도 실패로 판정한다.

## 7. 보호자 앱 회귀 확인

학생 앱 배포가 기존 보호자 앱을 바꾸지 않았는지 동의 범위별로 확인한다.

- 기존 v1~v3 보호자 연결은 원래 공개 범위를 그대로 유지한다.
- v4로 다시 동의한 보호자만 학원 공지와 검증된 교재 현황을 본다.
- 보호자 실제 화면과 관리자 미리보기의 섹션·상태·순서가 일치한다.
- 보호자 세션 쿠키와 학생 세션 쿠키가 서로의 Worker API에서 인정되지 않는다.

## 8. 중단과 롤백

- 잘못된 학생 또는 잘못된 보호자 동의를 발견하면 가장 먼저 관리자 화면에서 해당 학생의
  학생 앱 연결을 끈다. 코드와 세션이 모두 해지된 뒤 원인을 확인한다.
- Worker나 화면 오류는 직전 배포로 되돌릴 수 있다. `036~039`는 기존 데이터를 보존하는 schema이므로
  운영 테이블을 삭제하거나 데이터를 되돌리지 않는다.
- `SESSION_ALREADY_ACTIVE`는 발급 실패가 아니다. 기존 기기에서 로그아웃한 뒤 같은 새 링크를
  교환한다.
- `STUDENT_PORTAL_NOT_READY`는 마이그레이션 구조가 불완전하다는 뜻이다. 재배포나 재실행으로
  덮지 말고 2절의 구조를 다시 확인한다.

## 9. 비식별 완료 기록

실제 확인 뒤에는 학생 이름·전화번호 대신 아래 형식만 남긴다.

```text
배포일시(KST):
D1 036/037/038/039: 적용/기적용
보호자·직원 Worker health: 통과/실패
학생 Worker health: 통과/실패
관리자 미리보기 무부작용: 통과/실패
휴대폰 연결: 통과/실패
태블릿 연결: 통과/실패
허용 정보만 표시: 통과/실패
v1 외부 링크 비노출·v2 공식 링크 2개: 통과/실패
연결 해제 후 세션 차단: 통과/실패
남은 문제(민감정보 제외):
```
