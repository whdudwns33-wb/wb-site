# WB 동기화 백엔드 (Cloudflare Workers + D1)

학생 100명 이상을 감당하기 위해 기존 Apps Script 동기화를 대체한다.

## 왜 바꾸나

| | 기존 (Apps Script + 시트) | 여기 (Workers + D1) |
|---|---|---|
| 한 번에 오가는 양 | **전체 상태** (모든 학생·업무·체크) | 바뀐 행만 (델타) |
| 학생 한 명이 체크 하나를 누르면 | 나머지 99명 데이터까지 왕복 | 자기 1건만 |
| 저장 방식 | JSON 한 덩어리를 시트 셀에 쪼개 저장, 매번 전체 재작성 | 테이블 + 인덱스, 해당 행만 갱신 |
| 동시 처리 | 30개 한계 → 20~30명에서 실패 시작 | 사실상 무제한 |
| 개인 링크 권한 | 링크마다 **전체 접근 비밀키**가 들어감 | 링크마다 다른 토큰, 자기 것만 |

## 배포 순서

사전 준비: Node 설치, Cloudflare 로그인 (`npx wrangler login`)

```bash
cd sync

# 1) D1 데이터베이스 생성 → 출력된 database_id를 wrangler.toml에 붙여넣는다
npx wrangler d1 create wb-sync

# 2-a) 새 데이터베이스는 전체 스키마 적용 (원격)
npx wrangler d1 execute wb-sync --remote --file=./schema.sql

# 2-b) 기존 운영 데이터베이스는 2-a 대신 새 마이그레이션만 적용
npx wrangler d1 execute wb-sync --remote --file=./migrations/019_private_roster.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/020_book_order_dispatch_lock.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/021_parent_feedback_student_ids.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/022_book_issues.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/023_transport.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/024_transport_integrity.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/025_makeup.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/026_session_packs.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/027_parent_portal.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/028_guardian_ops_notifications.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/029_transport_notifications.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/030_lesson_assignment_requests.sql

# 3) 비밀키 등록 — 코드나 wrangler.toml에 적지 않는다
npx wrangler secret put TASK_ADMIN_SECRET
npx wrangler secret put CONSULT_ADMIN_SECRET
npx wrangler secret put TASK_MANAGER_STAFF_IDS # task 운영 관리자 staff ID, 쉼표로 구분
npx wrangler secret put SOLAPI_KAKAO_DIRECTOR_REPORT_TEMPLATE_ID # 승인된 수행보고 알림톡 템플릿 ID
npx wrangler secret put SOLAPI_KAKAO_API_KEY        # 카카오 알림톡 전용 API 키
npx wrangler secret put SOLAPI_KAKAO_API_SECRET     # 카카오 알림톡 전용 API 시크릿
npx wrangler secret put SOLAPI_KAKAO_PF_ID          # 연동된 카카오 채널 ID
npx wrangler secret put SOLAPI_KAKAO_TEMPLATE_ID    # 승인된 학부모 수업 피드백 템플릿 ID
npx wrangler secret put SOLAPI_SENDER_NUMBER        # Solapi에 등록된 발신번호
npx wrangler secret put WB_PARENT_FEEDBACK_SEND_ENABLED # 승인·연락처 점검 뒤에만 true
npx wrangler secret put SOLAPI_KAKAO_MAKEUP_PROPOSAL_APPROVED_TEMPLATE_ID
npx wrangler secret put SOLAPI_KAKAO_MAKEUP_CONFIRMED_APPROVED_TEMPLATE_ID
npx wrangler secret put SOLAPI_KAKAO_MAKEUP_CANCELLED_APPROVED_TEMPLATE_ID
npx wrangler secret put SOLAPI_KAKAO_SESSION_BALANCE_APPROVED_TEMPLATE_ID
npx wrangler secret put WB_GUARDIAN_OPS_SEND_ENABLED # 4개 템플릿 승인·별도 동의 확인 뒤에만 true
npx wrangler secret put SOLAPI_KAKAO_TRANSPORT_BOARDED_APPROVED_TEMPLATE_ID
npx wrangler secret put SOLAPI_KAKAO_TRANSPORT_DROPPED_APPROVED_TEMPLATE_ID
npx wrangler secret put WB_TRANSPORT_NOTIFY_ENABLED # 두 템플릿 APPROVED·차량 목적 동의 확인 뒤에만 true
npx wrangler secret put WB_BOOK_ORDER_SAMPLE_ENABLED # 본인 교재문자 샘플 때만 true, 확인 뒤 false
npx wrangler secret put NAVER_ID        # 네이버 검색 API Client ID (강좌 검색용)
npx wrangler secret put NAVER_SECRET    # 네이버 검색 API Client Secret
npx wrangler secret put NAVER_MAPS_ID       # 네이버 지도 API Key ID (Geocoding + Directions 5)
npx wrangler secret put NAVER_MAPS_SECRET   # 네이버 지도 API Key (Geocoding + Directions 5)

# 4) 배포
npx wrangler deploy
```

원생 정적 파일을 제거하는 배포에서는 `019_private_roster.sql` 적용 → Worker 배포 → 관리자
`/roster replace` 등록·조회 확인 → 프런트 전환 순서를 지킨다. 비공개 원생 데이터나 seed SQL은
저장소에 커밋하지 않는다. 운영 배포에 `deploy.ps1`을 다시 실행하면 관리자 비밀키가 교체되므로
기존 서비스에는 위 수동 명령을 사용한다.

교재 주문 발송 잠금을 추가하는 배포에서는 반드시 `020_book_order_dispatch_lock.sql`을 운영 D1에
먼저 적용한 뒤 Worker를 배포한다. 역순이면 재시도·예약·개별 발송이 잠금 테이블 오류로 차단된다.

학부모 알림톡 stable-ID 전환에서는 `021_parent_feedback_student_ids.sql`을 먼저 적용한다. 기존
이름 기반 보호자 연락처는 동명이인·개명 오발송 위험 때문에 자동 이관하지 않는다. 원장이 현재
원생 명단의 학생을 다시 선택해 연락처와 동의를 저장해야 하며, 실제 발송은
`guardian_contacts_by_student.student_id`만 사용한다. 학부모 수업 피드백 템플릿이
`APPROVED`이고 변수 `#{선생님}`, `#{학생명}`, `#{학습내용}`, `#{잘한점}`, `#{보완점}`이 정확히
일치하는 것을 확인한 뒤에만 `WB_PARENT_FEEDBACK_SEND_ENABLED=true`로 켠다. SMS 대체 발송은
항상 비활성화한다(`disableSms: true`).

학생별 교재 출고 기능은 `022_book_issues.sql`을 먼저 적용한 뒤 Worker를 배포한다. 출고 원장은
원생 이름·연락처를 저장하지 않고 `private_rosters.bookStudents`의 stable 배정 ID·학생 ID·교재
ID를 매 요청 다시 대조한다. `prepared` 또는 `issued` 상태인 배정을 원생 문서에서 삭제하거나
다른 학생·교재로 바꾸는 교체 요청은 409로 차단된다.

차량 기능은 `023_transport.sql`을 먼저 적용한 뒤 Worker를 배포한다. 설정·상태에는 stable ID와
운행 정보만 저장하고 전화·주소·보호자 정보는 저장하지 않는다. 날짜와 관계없이 승차 후 미하차 기록이 있는
노선·차량·운전 담당자·학생 배정은 설정 교체로 제거하거나 변경할 수 없다.

차량 원장의 동시 변경 보호를 추가하는 배포에서는 `024_transport_integrity.sql`을 운영 D1에
먼저 적용한 뒤 Worker와 Pages를 순서대로 배포한다. 이 트리거는 승차 처리와 원생 명단·기사·노선
변경이 동시에 들어와도 미하차 기록의 참조가 사라지지 않게 최종 DB 쓰기에서 차단한다. 직원 삭제는
`/staff-deactivate` CAS 경로만 사용해 직원 비활성화와 개인 토큰·1회용 링크 해지를 함께 확정한다.

차량 노선 자동 계산은 네이버 클라우드 Maps 애플리케이션에서 Geocoding과 Directions 5를 함께
선택한 전용 `NAVER_MAPS_ID`·`NAVER_MAPS_SECRET`을 사용한다. 기존 검색용
`NAVER_ID`·`NAVER_SECRET`은 인증 체계가 달라 지도에 재사용하지 않는다. 전용 키가 없으면
버튼을 설정 필요 상태로 잠근다. 실시간 교통량을 반영한 제안이므로 저장 전에 정류장 순서와 시간을 확인한다.

보강·회차제·보호자 웹앱 배포는 `025_makeup.sql` → `026_session_packs.sql` →
`027_parent_portal.sql` → `028_guardian_ops_notifications.sql` 순서로 먼저 적용하고 Worker를
배포한 뒤 Pages를 배포한다. 월제 수업은
회차권 행을 만들지 않으며, 실제 횟수제 학생·수업만 원장이 명시적으로 등록한다. 보호자 웹앱 동의는
기존 수업 피드백 알림톡 동의와 별도이고, 꺼지면 해당 학생의 초대코드와 세션이 모두 해지된다.
보호자 앱에는 전화번호·학생 특징·상담 메모·다른 학생 정보가 반환되지 않는다.

보강·회차 운영 알림톡은 기존 수업 피드백 알림톡 동의를 재사용하지 않는다. 원장이 학생별
`makeup`·`session` 동의를 따로 저장하고, 위 4개 템플릿이 Solapi에서 `APPROVED`이며 변수 계약이
정확히 일치하는 것을 확인하기 전까지 `WB_GUARDIAN_OPS_SEND_ENABLED`를 설정하지 않는다.

기존 `roster.json`과 `textbooks.json`의 학생 배정을 처음 이관할 때는 비밀키를 명령줄에 직접
쓰지 말고 보안 입력으로 환경변수에 넣은 뒤 이관 도구를 실행한다.

```bash
cd sync
export SYNC_URL='https://wb-sync.<계정>.workers.dev'
read -rsp 'TASK_ADMIN_SECRET: ' TASK_ADMIN_SECRET && echo
export TASK_ADMIN_SECRET
# 현재 작업공간처럼 저장소 루트의 Git 제외 폴더에 원본을 보관한 경우
node ./import-private-roster.mjs ../.private/roster.json ../.private/textbooks-source.json
# 다른 위치라면 위 두 경로만 /secure/path/... 로 바꾼다.
unset TASK_ADMIN_SECRET
```

도구는 활성 직원 이름을 서버에서 조회해 `teacherIds`로 정확히 매핑하고, 이미 이관된 문서가
있으면 기존 원생·교재 배정 ID를 보존한다. 같은 이름의 학생이 한 명뿐이면 학년 승급 뒤에도
ID를 유지하고, 이름 정정 때는 원본 행에 기존 `id`를 명시하면 같은 ID를 유지한다. 도구는 교체
직후 `/roster get`을 다시 호출해 원생 ID와 교재 배정 ID·연결을 대조한다. 성공 출력의
`readbackVerified`가 `true`이고 원생·교재 배정 건수가 원본과 같을 때만 프런트를 배포한다.
대조가 다르면 `ROSTER_READBACK_MISMATCH`로 실패하며 Pages 병합을 진행하지 않는다. 정적 파일
삭제 전의 두 원본은 Git에서 제외된 보안 경로에 보관한다.

배포가 끝나면 `https://wb-sync.<계정>.workers.dev` 주소가 나온다. 이 주소를 앱에 넣는다.

확인:
```bash
curl https://wb-sync.<계정>.workers.dev/health
# {"ok":true,"now":...}
```

## API

모두 `POST`, 본문은 JSON.

### `/sync`
```jsonc
{
  "app": "consult",                 // task | consult
  "auth": { "mode": "admin", "secret": "..." },
  //  또는 { "mode": "person", "id": "<staffId>", "token": "..." }
  "since": 1785651000000,           // 마지막으로 받은 서버 시각. 처음이면 0
  "changes": [                      // 올릴 변경 (최대 500건)
    { "table": "checks", "k": "__st__S1|2026-08-02", "owner": "S1",
      "data": { }, "updated_at": 1785650000000 }
  ]
}
```
응답의 `authRole`은 서버가 판정한 `admin | manager | staff` 값이다. task 앱은 이 값을
권한 표시의 정본으로 사용하며, 수정 가능한 직원 명부의 `manager` 표시는 권한을 부여하지 않는다.

```jsonc
{ "ok": true, "now": 1785651111111, "more": false, "authRole": "staff", "changes": [ /* since 이후 바뀐 행 */ ] }
```
`more: true`면 아직 남은 게 있다는 뜻이니 받은 `now`로 한 번 더 호출한다.

### `/token` — 개인 링크 토큰 발급 (원장만)
```jsonc
{ "app": "consult", "auth": { "mode": "admin", "secret": "..." }, "staffId": "S1" }
→ { "ok": true, "token": "..." }
```

### `/roster` — 비공개 원생·교재 배정 문서

모든 레코드는 변경되지 않는 ID와 `teacherIds`가 필요하다. 교재 배정은 여러 권을 지원하기 위해
행 고유 `id`와 원생을 가리키는 `studentId`를 따로 쓴다. `teacherIds`는 응답에 포함되지 않는다.

```jsonc
// 원장만 전체 문서 교체
{
  "app": "task", "auth": { "mode": "admin", "secret": "..." }, "action": "replace",
  "document": {
    "roster": {
      "updated": "2026-08-10", "baseline": "2026-08", "note": "",
      "students": [{
        "id": "student-001", "name": "홍길동", "grade": "중1", "teacher": "김선생",
        "subject": "수학", "start": "2026-08", "end": "", "reason": "",
        "teacherIds": ["staff-kim"]
      }]
    },
    "bookStudents": [{
      "id": "book-assignment-001", "studentId": "student-001", "name": "홍길동",
      "teacher": "김선생", "bookId": "BK01", "at": "1단원", "perWeek": 2,
      "goal": "1회독", "teacherIds": ["staff-kim"]
    }]
  }
}

// 원장: 전체, 개인 링크: teacherIds에 본인 staffId가 있는 행만 반환
{ "app": "task", "auth": { "mode": "person", "id": "staff-kim", "token": "..." }, "action": "get" }
→ { "ok": true, "updatedAt": 178..., "roster": { ... }, "bookStudents": [ ... ] }
```

### `/book-order-send` — 교재 주문 문자

실제 주문은 앱의 주문 `taskId`만 보내며, 수신번호와 문구는 서버가 결정한다.

```jsonc
{ "app":"task", "auth":{...}, "taskId":"order-task-id" }
```

본인 샘플은 원장 또는 서버 허용목록의 관리 담당만 요청할 수 있다. 요청에서 번호·문구·주문을
지정할 수 없고 `SOLAPI_TEST_RECIPIENT_PHONE`의 고정 번호로 KST 하루 한 번만 접수된다. 실제 주문
배치와 장부 집계에는 포함되지 않는다. `WB_SEND_MODE=test`, `WB_TEST_RECIPIENT_ID=TEST-SMS-001`,
`WB_ACTUAL_TEST_SEND_APPROVED=true`, `WB_BOOK_ORDER_SAMPLE_ENABLED=true`가 모두 일치해야 하며,
확인 직후 마지막 값을 `false`로 되돌린다.

```jsonc
{ "app":"task", "auth":{...}, "action":"sample" }
```

확정 거절된 예약 주문은 원장 또는 서버 허용목록의 관리 담당만 즉시 재시도할 수 있다. 요청에서
거래처·번호·문구·주문 ID를 지정할 수 없으며, 서버가 현재 장부의 `rejected` 매핑만 다시 읽어
거래처별 한 통으로 묶는다. `accepted`, `unknown`, `reserved`, `dispatching`은 제외하고,
KST 날짜·거래처·주문 집합으로 멱등 처리해 같은 날 반복 요청도 실제 발송은 한 번뿐이다. 재시도,
20시 예약 발송, 개별 즉시 발송은 동일한 D1 lease를 사용해 동시에 Solapi를 호출하지 않는다.

```jsonc
{ "app":"task", "auth":{...}, "action":"retry-rejected" }
```

### `/book-issue` — 학생별 교재 출고·인계

현재 비공개 원생 문서의 교재 배정이 정본이다. 원장·관리 담당은 전체, 개인 링크는 현재
`teacherIds`에 본인이 있는 배정만 조회·변경한다. 응답의 학생 이름·학년은 현재 원생 문서에서
그때 파생하며 출고 원장에는 저장하지 않는다. 관리자 `warnings`에는 삭제된 배정(orphan)이나
stable ID 정체성 불일치가 나오고, 일반 직원에게는 그런 이력을 노출하지 않는다.

```jsonc
// 전체/담당 배정과 상태 조회. 아직 시작하지 않은 배정은 status:none, revision:0
{ "app":"task", "auth":{...}, "action":"list" }
→ { "ok":true, "issues":[{
  "assignmentId":"book-assignment-001", "studentId":"student-001",
  "studentName":"홍길동", "grade":"중1", "bookId":"BK01",
  "status":"none", "cycle":0, "revision":0,
  "preparedAt":null, "issuedAt":null, "handedAt":null,
  "cancelledAt":null, "cancelReason":"", "reissueReason":"", "history":[]
}], "warnings":[] }

// CAS 상태 변경. next가 정식 필드이며 event/expectedRevision은 전환기 호환 별칭이다.
{ "app":"task", "auth":{...}, "action":"transition",
  "assignmentId":"book-assignment-001", "next":"prepared", "revision":0 }
→ { "ok":true, "idempotent":false, "issue":{ "status":"prepared", "revision":1, ... } }
```

허용 전이는 `none → prepared|issued`, `prepared → issued|cancelled`,
`issued → handed|cancelled`, `handed|cancelled → reissue(새 cycle의 prepared)`이다.
`cancelled`와 `reissue`에는 300자 이내 `reason`이 필수다. 성공한 요청을 같은 이전 revision으로
즉시 다시 보내면 `idempotent:true`, 다른 변경과 충돌하면 최신 `current`와 함께 409를 반환한다.

### `/transport` — 차량 노선·승하차 현황

원장·관리 담당은 전체, 개인 링크는 본인이 운전 담당인 노선만 조회한다. 개인 링크의 상태 변경은
KST 오늘 본인 노선으로 제한된다. 전체 관리 권한은 오늘 기준 ±31일 이내 상태를 처리하며, 별도
`unresolved` 목록에 잡힌 과거 미하차 기록은 날짜 제한 없이 사유를 남겨 초기화할 수 있다.

```jsonc
// 날짜별 조회. row가 없으면 scheduled/revision 0
{ "app":"task", "auth":{...}, "action":"list", "date":"2026-08-11" }
→ { "ok":true, "config":{"vehicles":[],"drivers":[],"routes":[]},
    "routes":[], "states":[], "unresolved":[], "revision":0, "warnings":[], "summary":{...} }

// 전체 관리 권한만 설정 교체. revision은 list/replace 응답의 설정 revision
{ "app":"task", "auth":{...}, "action":"replace", "revision":0,
  "config":{"vehicles":[{"id":"van-1","name":"1호차","plate":"12가3456","capacity":12}],
    "routes":[{"id":"route-1","name":"월수금 귀가","direction":"dropoff",
      "vehicleId":"van-1","driverId":"staff-kim","days":[1,3,5],"startTime":"19:00",
      "stops":[{"id":"stop-1","name":"중앙공원","time":"19:15","studentIds":["student-1"]}],
      "active":true}]}}

// CAS 상태 변경
{ "app":"task", "auth":{...}, "action":"state", "date":"2026-08-11",
  "routeId":"route-1", "studentId":"student-1", "next":"boarded", "revision":0,
  "notifyGuardian":true }

// stable studentId별 차량 통화·승하차 알림 동의(전체 관리 권한만)
{ "app":"task", "auth":{...}, "action":"guardian_get", "studentId":"student-1" }
{ "app":"task", "auth":{...}, "action":"guardian_set", "studentId":"student-1",
  "phone":"01012345678", "confirmNewIdentity":true,
  "callAllowed":true, "boardedConsent":true, "droppedConsent":true,
  "expectedContactUpdatedAt":0, "expectedConsentUpdatedAt":0 }
```

허용 전이는 `scheduled → boarded|absent`, `boarded → dropped`이다. 전체 관리 권한만 `next:"scheduled"`와
필수 `reason`으로 초기화할 수 있다. 같은 이전 revision의 중복 클릭은 409로 차단된다. 관리자
조회에는 설정에서 누락됐더라도 `boarded`인 기록을 숨기지 않고 `ORPHAN_BOARDED` 경고로 반환한다.

기사 개인 링크(관리 담당 기사 포함)는 KST 오늘 본인 배정 노선에서만, 별도 `callAllowed` 동의가
현재 보호자 번호 identity와 일치하는 학생의 번호를 받을 수 있다. 관리자·다른 노선·과거/미래에는
번호를 응답하지 않는다. 승차/하차 상태 저장 뒤 각각 승인된 고정 Solapi ATA 템플릿으로 알림을
시도하며 SMS 대체는 끈다. 기존 화면이 `notifyGuardian`을 생략해도 기본 발송을 시도하고,
명시적 `false`만 보내지 않는다. 연락처·해당 이벤트 동의·전용 gate·승인 템플릿이 없으면 provider를
호출하지 않고 차단 결과를 남긴다. `accepted`/`unknown`/확정 `rejected` 원장은 같은 날짜·노선·학생·
상태 revision에서 재발송하지 않는다. 상태 저장과 외부 호출은 한 DB transaction으로 묶지 않으며,
공급자 호출 전에 append-only 예약을 만들어 exactly-once를 보장한다. 알림 변수는 `학생명`, `운행일`,
`확인시각`, `노선명`, `확인지점`뿐이고 기사 정보·주소는 포함하지 않는다.

운영 배포는 `029_transport_notifications.sql` D1 migration을 먼저 적용한 뒤 Worker를 배포한다.
실발송 전 `WB_TRANSPORT_NOTIFY_ENABLED=true`와 탑승/하차 승인 템플릿 ID를 별도로 등록해야 한다.

### `/makeup` — 전 학생 공통 보강 원장

결석 출결 한 건에서 보강 검토를 만들고 `review_pending → reviewed → awaiting_parent →
confirmed → completed`로 관리한다. 모든 변경은 `revision` CAS이며, 학생·담당 선생님·정규 수업과
확정 보강의 시간 겹침을 서버에서 다시 검사한다. 담당 선생님은 자기 학생의 검토 요청과 자기 담당
보강 완료만 할 수 있고, 원장·허용된 관리 담당만 검토·일정 제안·확정·취소를 할 수 있다.

```jsonc
{ "app":"task", "auth":{...}, "action":"create_from_absence",
  "sourceTaskId":"lesson-1", "sourceDate":"2026-08-11" }
{ "app":"task", "auth":{...}, "action":"propose", "caseId":"mu_...",
  "revision":2, "date":"2026-08-14", "startTime":"18:00",
  "endTime":"18:50", "staffId":"staff-1" }
```

결석 즉시 보호자에게 자동 발송하지 않는다. 관리자가 보강 가능 여부와 일정을 확인한 이후에만
`notificationNeeded` 이벤트가 생성된다. 보호자 웹앱의 동일 revision 거절 응답이 있으면 확정을
차단한다.

### `/session-pack` — 지정 학생·수업의 횟수권

월제 수업은 행이 없고, 횟수제 학생·수업만 `create`로 등록한다. 잔여 횟수는 append-only 사용
원장의 합계로 계산하며 과거 행을 수정하지 않는다. 기본 정책은 출석·지각·당일취소·무단결석을
1회 차감하고, 사전 인정 결석·학원 취소는 차감하지 않으며 실제 보강 완료 때 한 번만 차감한다.

```jsonc
{ "app":"task", "auth":{...}, "action":"create", "studentId":"student-1",
  "lessonTaskId":"lesson-1", "totalSessions":8,
  "validFrom":"2026-08-01", "expiresOn":"2026-08-31" }
{ "app":"task", "auth":{...}, "action":"record", "packId":"sp_...",
  "revision":1, "sourceType":"regular", "sourceKey":"check-..." }
```

같은 정규 출결·보강 consumption group은 두 번 차감되지 않고, 수동 증감은 사유가 있는 별도
조정 행으로만 남는다.

### `/parent-portal` — 보호자 전용 웹앱

원장·관리 담당이 stable 학생 ID별 웹앱 동의를 별도로 저장하고 1회용 초대코드를 발급한다. 코드는
교환 즉시 폐기되며 서버에는 해시만 저장된다. 보호자 세션은 한 학생만 볼 수 있고, 확정 시간표·보강
제안/확정·횟수 잔여·이미 접수된 피드백의 안전한 요약만 반환한다.

```jsonc
// 관리자
{ "app":"task", "auth":{...}, "action":"access_set",
  "studentId":"student-1", "enabled":true, "expectedUpdatedAt":0 }
{ "app":"task", "auth":{...}, "action":"invite", "studentId":"student-1" }

// Worker origin의 보호자 웹앱: /#code=<1회용 코드>를 즉시 지운 뒤 교환한다.
// exchange 응답은 HttpOnly·Secure·SameSite=Strict 쿠키를 설정한다.
{ "app":"task", "action":"exchange", "code":"..." }
{ "app":"task", "action":"view" }
{ "app":"task", "action":"respond",
  "caseId":"mu_...", "revision":3, "response":"accept" }
```

보호자 앱 정적 파일과 API는 같은 Worker origin에서 제공하고, 직원 GitHub Pages와 origin을
분리한다. 초대·세션 원문, 전화번호, 내부 메모는 응답이나 장부에 저장하지 않으며 세션 토큰은
자바스크립트나 localStorage에 노출하지 않는다. 오프라인 캐시는 사용하지 않고, 웹앱 동의나
보호자 연락처 연결이 바뀌면 기존 코드·세션을 즉시 무효화한다.

### `/guardian-ops-send` — 보강·회차 운영 알림톡

원장·허용된 관리 담당 전용이다. `consent_set`으로 기존 수업 피드백 알림톡과 별개의
`makeup`·`session` 동의를 학생별 저장하고, `preview`로 서버 정본 변수와 차단 사유를 확인한 뒤
`send`한다. 요청에서 전화번호·수신자·본문을 지정할 수 없다.

```jsonc
{ "app":"task", "auth":{...}, "action":"consent_set",
  "studentId":"student-1", "scope":"makeup", "consent":true, "expectedUpdatedAt":0 }
{ "app":"task", "auth":{...}, "action":"preview",
  "eventType":"makeup_proposal", "sourceId":"mu_...", "revision":3 }
{ "app":"task", "auth":{...}, "action":"send",
  "eventType":"session_balance", "sourceId":"sp_...", "revision":5 }
```

지원 이벤트는 `makeup_proposal`, `makeup_confirmed`, `makeup_cancelled`, `session_balance`다.
서버가 현재 명단·보호자 연락처·별도 동의·원 수업/보강/회차 revision을 다시 대조한다. ATA만
사용하고 SMS 대체 발송을 끈다. accepted는 접수로만 표시하고, unknown/dispatching은 공급자 확인
전 재발송하지 않으며, 확정 rejected만 새 attempt로 재시도한다.
보호자 앱의 공개 기준 주소는 비밀값이 아니므로 `wrangler.toml`의
`WB_PARENT_PORTAL_BASE_URL`에 query/hash 없는 Worker origin 루트로 고정한다.

### `/onboarding-patch` — 신규 학생 30일 관리 CAS 저장

기존 `checks`의 `__onboarding__<studentId>|all` 행을 그대로 쓰되, 원장·관리 담당의 동시 수정이
서로 덮이지 않도록 현재 `updatedAt`을 조건으로 한 필드만 갱신한다. 지원 작업은 `create`, `item`,
`package`, `classroom`, `date`, `cancel`, `restore`이며 서버가 stable 학생 ID·재원 기간·항목
목록·시각·처리자를 검증한다. 충돌하면 409와 최신 `current`를 반환하므로 화면이 최신 상태를
반영한 뒤 사용자가 다시 시도한다. 이 경로를 한 번 거친 `casVersion:1` 행은 예전 generic
`/sync` LWW 요청으로 덮어쓸 수 없다.

### `/search` — 강좌명으로 강좌 페이지 찾기 (네이버 웹문서 검색)
```jsonc
{ "app":"consult", "auth":{...}, "q":"현우진 뉴런", "platform":"메가스터디" }
→ { "ok":true, "items":[{ "title":"...", "url":"https://...", "desc":"..." }] }
```
`platform`을 주면 그 도메인 결과만 남기고, 강좌 상세 페이지로 보이는 주소를 위로 정렬한다.

### `/curriculum` — 강좌 주소에서 목차 추출
```jsonc
{ "app":"consult", "auth":{...}, "url":"https://..." }
→ { "ok":true, "text":"1강. 개념 52:10\n...", "count":59 }
→ 못 읽으면 { "ok":true, "text":"", "count":0, "hint":"..." }
```
사이트별 선택자가 아니라 "회차 번호 + 시간 표기" 패턴으로 표를 훑는다.
euc-kr 페이지도 인코딩을 판별해 읽는다. 자바스크립트로 목록을 그리는 페이지는
서버에서 못 잡으므로 붙여넣기로 안내한다. 내부망·비HTTP 주소는 거부한다(SSRF 방어).

### `/revoke` — 토큰 해지 (원장만)
```jsonc
{ "app": "consult", "auth": { "mode":"admin", "secret":"..." }, "token": "..." }
```

## 설계 메모

- **충돌 처리**는 `updated_at`(클라이언트 시각) 기준 last-write-wins. 늦게 도착한 옛 기록이 최신을 덮지 않도록 `ON CONFLICT ... WHERE excluded.updated_at > 기존.updated_at` 으로 막는다.
- **델타 기준은 `srv_at`(서버 시각)** 을 따로 둔다. 기기 시계가 틀어져도 빠지는 행이 생기지 않는다.
- **개인 접속의 쓰기 범위**도 서버에서 검사한다. 클라이언트가 남의 `owner`를 붙여 보내도 저장되지 않는다.
- `ALLOW_ORIGIN`을 비우면 모든 출처를 허용하므로 운영에서는 반드시 채운다.

## 검증

`scratchpad/test-worker.mjs` — 인메모리 SQLite로 D1을 흉내 내 20개 시나리오를 돌린다
(인증·출처·델타·분할·위조 토큰·LWW·앱 격리·토큰 해지·전송 상한·100명 규모 조회).
