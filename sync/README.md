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

# consult 인증사진·질문 JPEG를 저장할 private R2 버킷 (r2.dev/public access를 켜지 않는다)
npx wrangler r2 bucket create wb-consult-private
npx --yes wrangler@4 r2 bucket lifecycle add wb-consult-private consult-media-90d consult/ --expire-days 90 --force

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
npx wrangler d1 execute wb-sync --remote --file=./migrations/031_book_order_fulfillments.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/032_acaflow_student_links.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/033_consult_admin_accounts.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/034_parent_portal_scope.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/035_parent_portal_phase2.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/036_guardian_announcements.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/037_book_order_identity_snapshots.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/038_student_portal.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/039_student_portal_scope_v2.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/040_student_lesson_self_checks.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/041_consult_submissions.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/042_consult_guardian_portal.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/043_book_order_item_prices.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/044_book_order_item_price_corrections.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/045_student_change_history.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/046_app_data_generations.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/047_lesson_assignment_details.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/048_admin_directives.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/049_consult_result_sheets.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/050_weekend_actual_visits.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/051_feedback_template_v2.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/052_completed_book_catalog.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/053_consult_link_send.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/054_lesson_staff_scope.sql
npx wrangler d1 execute wb-sync --remote --file=./migrations/055_task_write_cas_guards.sql

# 3) 비밀키 등록 — 코드나 wrangler.toml에 적지 않는다
npx wrangler secret put TASK_ADMIN_SECRET
npx wrangler secret put CONSULT_ADMIN_SECRET
npx wrangler secret put TASK_MANAGER_STAFF_IDS # task 운영 관리자 staff ID, 쉼표로 구분
npx wrangler secret put SOLAPI_KAKAO_DIRECTOR_REPORT_TEMPLATE_ID # 승인된 수행보고 알림톡 템플릿 ID
npx wrangler secret put SOLAPI_KAKAO_CONSULT_LINK_APPROVED_TEMPLATE_ID # 승인된 consult 학생 링크 알림톡 템플릿 ID
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
npx wrangler secret put WB_CONSULT_LINK_SEND_ENABLED # 학생 링크 템플릿 승인·연락처 동의 확인 뒤에만 true
npx wrangler secret put WB_BOOK_ORDER_SAMPLE_ENABLED # 본인 교재문자 샘플 때만 true, 확인 뒤 false
npx wrangler secret put NAVER_ID        # 네이버 검색 API Client ID (강좌 검색용)
npx wrangler secret put NAVER_SECRET    # 네이버 검색 API Client Secret
npx wrangler secret put NAVER_MAPS_ID       # 네이버 지도 API Key ID (Geocoding + Directions 5)
npx wrangler secret put NAVER_MAPS_SECRET   # 네이버 지도 API Key (Geocoding + Directions 5)

# 4) 보호자·직원 Worker 배포 후, 별도 origin의 학생 Worker 배포
npx wrangler deploy
npx wrangler deploy --config wrangler.student.toml
```

학생 앱을 포함한 기존 운영 DB 배포는 반드시 `036 → 037 → 038 → 039 → 040` 마이그레이션을 모두 적용한 뒤
각 마이그레이션의 신규 객체와 `student_visible` 열을 확인하고, `wrangler.toml`의 보호자·직원 Worker,
`wrangler.student.toml`의 학생 Worker, 마지막으로 task Pages 순서로 진행한다. 학생 Worker를 생략하면
관리자 화면에서 초대 링크를 만들 수 있어도 학생 화면은 열리지 않는다. 두 설정의
`WB_STUDENT_PORTAL_BASE_URL`은 query/hash 없는 동일한 학생 Worker HTTPS 루트여야 한다.
기존 운영 DB의 사전 확인, 중복 적용 방지, 휴대폰·태블릿 연결과 해제 확인은
[`PORTAL_RELEASE_RUNBOOK.md`](./PORTAL_RELEASE_RUNBOOK.md)를 그대로 따른다.

consult 원장 계정 로그인을 추가하는 배포는 `033_consult_admin_accounts.sql`을 먼저
운영 D1에 적용한 뒤 Worker, Pages 순서로 배포한다. 기존 `task` 인증과 데이터는
변경하지 않는다. 기존 consult 원장 기기의 설정에서 아이디·비밀번호를 한 번
저장하면 최대 5대의 기기가 각각 90일간 자동 로그인한다.

consult 인증사진·질문 제출함은 `041_consult_submissions.sql` 적용과 private
`wb-consult-private` R2 버킷 준비를 마친 뒤 보호자·직원 Worker와 consult Pages 순서로
배포한다. 버킷의 public development URL과 custom domain은 사용하지 않으며, R2 설정에서
`consult/` prefix 객체를 90일 뒤 삭제하는 lifecycle rule을 반드시 켠다. 사진은 인증된
`POST /consult-submission` 조회를 통해서만 제공하며 task·학생 전용 Worker는 변경하지 않는다.

consult 보호자 리포트 공유는 운영 D1에 `042_consult_guardian_portal.sql`을 먼저 적용하고,
신규 표 4개와 `trg_consult_guardian_*` 트리거를 확인한 뒤 보호자·직원 Worker, consult Pages
순서로 배포한다. 기존 `/parent-portal` 표와 쿠키는 사용하지 않으므로 task 보호자 앱은 이
마이그레이션의 대상이 아니다. 배포 후 원장 화면에서 테스트 학생의 공유 동의 → 초대 링크 →
휴대폰 조회 → 확인 기록 → 공유 끄기 순서로 점검한다.

consult 영어·수학 PDF 결과지는 운영 D1에 `049_consult_result_sheets.sql`을 먼저 적용하고,
보호자·직원 Worker, consult Pages 순서로 배포한다. PDF는 기존 private
`wb-consult-private` 버킷의 `consult-results/` prefix에 저장하며 public development URL과
custom domain을 사용하지 않는다. `consult/` 인증사진용 90일 lifecycle rule은
`consult-results/`에 확대 적용하지 않는다. 결과지 공유 범위가 추가되므로 기존 보호자 공유는
원장 화면에서 새 범위 동의를 다시 확인한 뒤 새 일회용 초대 링크를 발급한다.

consult 인강 목차 사진 인식은 `wrangler.toml`의 Workers AI `AI` binding을 사용한다.
D1 마이그레이션이나 R2 저장은 없으며, 브라우저에서 압축·메타데이터 제거한 사진을 한 번에
최대 6장만 받아 인식 결과 텍스트를 반환하고 사진은 보관하지 않는다. `/consult-curriculum-image`는
consult 원장과 지정 관리자만 사용할 수 있고 `task` 요청은 거부한다. 이 기능 배포는 보호자·직원
Worker를 먼저 배포한 뒤 consult Pages를 배포하며 학생 전용 Worker와 task Pages는 변경하지 않는다.
로그인 없이 공개되는 강좌 상세 주소는 `/consult-curriculum-url`에서 목차를 가져오며, 로그인·자바스크립트가
필요한 페이지는 서버가 읽을 수 없으므로 같은 등록 화면의 사진 가져오기를 사용한다.

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

주문 교재의 4단계 배송 현황과 아카등록 업무를 추가하는 배포에서는
`031_book_order_fulfillments.sql`을 운영 D1에 먼저 적용한 뒤 Worker, Pages 순서로 배포한다.
원장에는 주문 task ID, 교재 ID, stable studentId 목록과 단계별 시각만 저장하며 학생 표시명과
연락처는 저장하지 않는다.

아카등록 완료 일반 교재의 공용 DB와 온라인 직접 주문을 추가하는 배포에서는
`052_completed_book_catalog.sql`을 운영 D1에 먼저 적용한 뒤 Worker, task Pages 순서로 배포한다.
완료 교재 원장은 교재 ID·검색 검증 교재명/출판사·주문 당시 선택 출판사·기존 raw 주문처·완료 시각과 검색 검증 상태·근거 URL만
저장하고 주문 ID, 학생 ID·이름, 연락처는 저장하지 않는다. 같은 정규화 출판사+교재명은 최초 한 행만
남긴다. `WB_BOOK_CATALOG_WEB_SEARCH_ENABLED="true"`이고 `AI` binding을 사용할 수 있을 때에만 최초
고유 교재를 `xai/grok-4.20-multi-agent-0309`의 `web_search`로 비동기 검증한다. 12초 내 실패·불일치·
AI 미설정은 주문 입력값 후보로 보존하며, 아카등록 완료 자체는 검색 결과를 기다리거나 되돌리지 않는다.
자동 확정은 NFKC 후 공백·기호를 제외한 제목이 정확히 같을 때도 모델이 명시한 근거 중 허용된 HTTPS 상품
상세 URL만 제한된 시간·개수·응답 크기로 직접 확인한다. 수동 redirect의 모든 목적지를 다시 허용 목록과
상품 상세 경로로 검사하고, 최종 200 HTML 본문에 전체 교재명과 호환 출판사가 함께 확인될 때만 허용한다.
접근 불가·무관한 본문·허용 밖 redirect·과대 응답은 확정하지 않는다. 그 외 검색 대기·실패·불일치·근거 부족·과거 보강 행은
`reviewCandidates`로 분리하고, 관리자가 `review_approve` CAS로 정확한 교재명·출판사를 확정할 수 있다.
관리자 확정은 선택 출판사와 raw 주문처를 바꾸지 않으며 별도 append-only 검토 event에 같은 batch로 남긴다.
재주문용 `/book-catalog`의 `books`에는 웹 근거 또는 관리자 검토로 확정된 `verified` 교재만 노출한다.

수업별 담당자 권한 정본 전환에서는 `054_lesson_staff_scope.sql`, `055_task_write_cas_guards.sql`을
운영 D1에 순서대로 먼저 적용한 뒤 Worker, task Pages 순서로 배포한다(마이그레이션 → Worker → Pages).
두 마이그레이션은 회차권 담당 이전과 다중 쓰기 CAS의 원자성을 함께 보호한다. 회차 사용 차감 트리거는
원생 명단의 기존 `teacherIds`를 권한 조건으로 사용하지 않으며, 수업 task의
`owner`와 `data.staffId`, stable `studentId`가 일치하는 활성 수업만 담당 범위로 인정하게 한다.
원생 명단의 `teacher`와 `teacherIds`는 기존 문서 호환용 선택 필드일 뿐 새 권한 판정에는 사용하지 않는다.

금액 없이 생성된 기존 주문에 1회성 권당 금액 입력을 추가하는 배포에서는
`043_book_order_item_prices.sql`을 운영 D1에 먼저 적용한 뒤 Worker, Pages 순서로 배포한다.
보조 원장은 주문 task ID와 항목 번호, 금액, 기록 시각·처리자 ID만 저장하고 수정·삭제를
DB 트리거로 차단한다. 기존 주문 task와 학생 연결 봉인 데이터는 변경하지 않는다.

승인된 1회성 금액 정정은 기존 금액을 덮어쓰지 않고 `044_book_order_item_price_corrections.sql`의
별도 불변 원장에 남긴다. 운영 D1 적용 뒤 Worker를 배포하며, 정정 전·후 금액과 고정 사유 코드만
보관한다. 대상 주문·담당 stable ID·교재명·현재 단계·기존 금액이 모두 일치하지 않으면 정정 행은
생성되지 않으므로 배포를 중단하고 대상 상태를 다시 확인한다.

토·일 실제 등·하원 기록 기능은 `050_weekend_actual_visits.sql`을 운영 D1에 먼저 적용한 뒤
Worker, task Pages 순서로 배포한다. 기존 예정 시간표와 출석·회차 원장은 변경하지 않고,
stable studentId와 수업 task ID로 연결된 별도 기록과 append-only 수정 이력을 저장한다.
선생님은 본인 담당 토·일 수업만 당일 23:50 전까지 정정할 수 있고 관리자는 감사 사유를
남긴 뒤 이전 기록을 정정할 수 있다.

수업 담당 변경·퇴원·휴원과 학생정보/업무지시 수정 확인 기능은
`045_student_change_history.sql`을 운영 D1에 먼저 적용한 뒤 Worker, task Pages 순서로 배포한다.
이력은 stable studentId로 누적하고 원장·관리 담당·각 선생님의 확인 상태는 서로 독립적으로
append-only 저장한다. 승인된 수업삭제의 감사 행은 DB에만 보관하며 학생 변경 이력 API와 화면에는
노출하지 않는다.

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
`027_parent_portal.sql` → `028_guardian_ops_notifications.sql` → `034_parent_portal_scope.sql` →
`035_parent_portal_phase2.sql` → `036_guardian_announcements.sql` →
`037_book_order_identity_snapshots.sql` 순서로 먼저 적용하고 Worker를
배포한 뒤 Pages를 배포한다. 월제 수업은
회차권 행을 만들지 않으며, 실제 횟수제 학생·수업만 원장이 명시적으로 등록한다. 보호자 웹앱 동의는
기존 수업 피드백 알림톡 동의와 별도이고, 꺼지면 해당 학생의 초대코드와 세션이 모두 해지된다.
보호자 앱에는 전화번호·학생 특징·상담 메모·다른 학생 정보가 반환되지 않는다.
특정 학생 공지는 지정 당시 stable 학생 ID와 이름의 비가역 identity snapshot을 함께 저장하며,
보호자가 읽을 때 현재 활성 원생 명단과 다시 일치하는 경우에만 공개한다.

보호자 교재 주문 현황을 추가하는 배포는 반드시
`037_book_order_identity_snapshots.sql` → Worker → Pages 순서로 진행한다. 새
`/book-order create`만 현재 재원생 ID·이름 해시와 교재·학생 집합을 불변
원장에 봉인한다. 기존 주문은 오연결 위험 때문에 자동 이관하지 않고 보호자에게
표시하지 않는다. `BOOK_VENDOR_PHONES`의 유효한 문자 주문처만 봉인할 수 있으며,
쿠팡 등 온라인 직접 주문은 기존 `manual_online_v1` 경로를 유지하고 보호자 주문
현황에는 표시하지 않는다. 보호자에는 서버 교재 DB 정본이 없는 현재 단계에서
임의 교재명을 보내지 않고 `주문 교재`로만 표시한다.

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

도구는 원생 원장의 공통 `teacher`/`teacherIds`를 새로 만들지 않으며, 교재 배정 행에만 해당 배정의
직원 이름을 서버에서 조회해 assignment-specific `teacherIds`로 매핑한다. 이미 이관된 문서가 있으면
기존 원생·교재 배정 ID를 보존한다. 담당 학생 권한의 정본은 교재 배정 값이 아니라 활성 수업 task의
`owner`와 `data.staffId`다. 같은 이름의 학생이 한 명뿐이면 학년 승급 뒤에도
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
운영 관리 담당은 기존 secret `TASK_MANAGER_STAFF_IDS`와 배포 설정의
`TASK_MANAGER_STAFF_IDS_CONFIG`를 합친 정확한 staff ID allowlist로 판정한다.

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

모든 레코드는 변경되지 않는 ID가 필요하다. 원생의 담당 범위는 종료되지 않은 현재·예정 structured
수업 task의 `owner`와 `data.staffId`가 일치하는 수업을 `studentId`로 결합해 파생한다. roster 학생의 `teacherIds`는
legacy 문서 호환 필드일 뿐 담당 권한의 정본이 아니다. 교재 배정은 여러 권을 지원하기 위해
행 고유 `id`와 원생을 가리키는 `studentId`를 따로 쓴다. legacy 교재 배정의 `teacherIds`는
입력 문서에 남을 수 있지만 응답에는 포함되지 않는다. `/book-issue`의 legacy 조회·출고 변경은
현재 활성 수업으로 파생한 학생 범위와 해당 교재 배정 행의 `teacherIds`를 모두 만족해야 한다.

```jsonc
// 원장만 전체 문서 교체
{
  "app": "task", "auth": { "mode": "admin", "secret": "..." }, "action": "replace",
  "document": {
    "roster": {
      "updated": "2026-08-10", "baseline": "2026-08", "note": "",
      "students": [{
        "id": "student-001", "name": "홍길동", "grade": "중1",
        "subject": "수학", "subjects": ["수학"],
        "start": "2026-08", "end": "", "reason": ""
      }]
    },
    "bookStudents": [{
      "id": "book-assignment-001", "studentId": "student-001", "name": "홍길동",
      "teacher": "김선생", "bookId": "BK01", "at": "1단원", "perWeek": 2,
      "goal": "1회독", "teacherIds": ["staff-kim"]
    }]
  }
}

// 원장: 전체, 개인 링크: 활성 수업 task에서 owner/data.staffId가 본인인 학생 행만 반환
{ "app": "task", "auth": { "mode": "person", "id": "staff-kim", "token": "..." }, "action": "get" }
→ { "ok": true, "updatedAt": 178..., "roster": { ... }, "bookStudents": [ ... ] }
```

### `/book-order` — 보호자 공개 가능한 봉인 주문

새 문자 주문은 generic `/sync`로 지시서를 먼저 만들지 않고 이 API를 사용한다.
`taskId`는 `ord_`로 시작하는 전용 ID이며 클라이언트가 한 번 생성해 재시도할 때 같은 값을 쓴다. 서버는 재원
원생·담당 범위·문자 주문처를 확인한 뒤 canonical task와 identity snapshot을 한
D1 batch로 저장한다. 같은 학생·교재의 미완료 주문은 DB 고유 제약으로 동시에 두 개
생성되지 않으며, 취소나 학생 전달 완료 후에만 다시 주문할 수 있다.

```jsonc
{
  "app": "task", "auth": { /* admin | person */ }, "action": "create",
  "taskId": "ord_01examplestable", "vendorName": "출판사",
  "items": [{ "bookId": "BK01", "title": "교재명", "studentIds": ["student-001"] }]
}
→ { "ok": true, "idempotent": false, "task": { "orderIdentityVersion": 1 /* ... */ } }
```

같은 `taskId`·같은 payload 재시도는 `idempotent:true` 정본 task를 돌려준다.
다른 payload의 ID 재사용은 `ORDER_ID_CONFLICT`, 미완료 중복은
`ORDER_ALREADY_ACTIVE`, 서버 주문처 미설정은 `ORDER_VENDOR_NOT_CONFIGURED`,
문자 2,000바이트를 넘는 단일 주문은 `ORDER_MESSAGE_TOO_LARGE`로 차단한다.
검증 뒤 저장 사이 원생 명단이 바뀌면 부분 원장을 남기지 않고
`ROSTER_REVISION_CONFLICT`로 재시도를 요청한다. 봉인 학생은 취소되거나
아카플로우 등록 완료가 확인될 때까지 이름 변경·삭제·현재월 비활성화를 막는다.

봉인된 주문 취소도 generic LWW가 아니라 공용 발송 lease를 획득하는 전용 action을
사용한다. `reserved`, `dispatching`, `accepted`, `unknown` 발송이 있거나 배치
발송 중이면 `ORDER_CANCEL_SEND_ACTIVE`로 차단한다.

```jsonc
{
  "app": "task", "auth": { /* admin | person */ }, "action": "cancel",
  "taskId": "ord_01examplestable", "expectedUpdatedAt": 178...
}
→ { "ok": true, "idempotent": false, "task": { "deleted": true, "orderCancelledAt": 178... } }
```

### `/book-order-send` — 교재 주문 문자

실제 주문은 수신번호와 문구를 서버가 결정한다. 새 `orderIdentityVersion:1`
주문은 개별 `taskId` 발송을 전원 `ORDER_SCHEDULED_ONLY`로 차단하고 20시
일괄 발송으로만 처리한다. 아래 `taskId` 형식은 배포 전 기존 legacy 주문 호환용이다.

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
20시 예약 발송, legacy 개별 발송은 동일한 D1 lease를 사용해 동시에 Solapi를
호출하지 않는다. 20시 배치가 거절되어도 다음 cron은 자동 재발송하지 않고 이 action만
재시도한다. 거래처 문자가 2,000바이트를 넘으면 주문 task 경계로 나누며,
하루 30통 한도 밖의 거절 주문은 기존 `rejected` 매핑을 유지해 다음날 이어서 처리한다.

```jsonc
{ "app":"task", "auth":{...}, "action":"retry-rejected" }
```

### `/book-issue` — 학생별 교재 출고·인계

현재 비공개 원생 문서의 교재 배정이 정본이다. 원장·관리 담당은 전체, 개인 링크는 종료되지 않은
현재·예정 수업 task의 `owner`와 `data.staffId`가 본인으로 일치하고 해당 legacy 교재 배정의
assignment-specific `teacherIds`에도 본인이 포함된 건만 조회·변경한다. 응답의 학생
이름·학년은 현재 원생 문서에서 그때 파생하며 출고 원장에는 저장하지 않는다. 관리자 `warnings`에는 삭제된 배정(orphan)이나
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

원장·관리 담당이 stable 학생 ID별 웹앱 동의를 별도로 저장하고 1회용 초대코드를 발급한다. 공개 범위
v2는 확정 수업·오늘 출결/수업 기록 진행·차량 확인·보강·회차·피드백을 포함한다. v3는 내부 메모와
분리된 공개 숙제·준비물과 정형 보호자 요청을 추가하고, v4는 학원 공지와 교재 준비·인계 상태를 추가한다.
기존 v1~v3 동의는 자동 승계하지 않고 관리자
화면에서 다시 확인하되, 이미 연결된 세션은 기존 동의 범위 안에서 계속 읽을 수 있다. 코드는
교환 즉시 폐기되며 서버에는 해시만 저장된다. 보호자 세션은 한 학생만 볼 수 있고, 확정 시간표·보강
제안/확정·횟수 잔여·이미 접수된 피드백의 안전한 요약만 반환한다.

```jsonc
// 관리자
{ "app":"task", "auth":{...}, "action":"access_set",
  "studentId":"student-1", "enabled":true, "scopeVersion":4, "expectedUpdatedAt":0 }
{ "app":"task", "auth":{...}, "action":"invite", "studentId":"student-1" }

// 담당 선생님: 서버 KST 오늘의 확정·현재 담당 수업만 공개한다.
{ "app":"task", "auth":{...}, "action":"publication_list", "lessonDate":"2026-08-17" }
{ "app":"task", "auth":{...}, "action":"publication_set", "taskId":"lesson-1",
  "lessonDate":"2026-08-17", "publicHomework":"2쪽 풀기", "publicReadiness":"연필",
  "published":true, "expectedRevision":0 }

// 원장·관리 담당: 보호자 요청함 조회와 CAS 처리.
{ "app":"task", "auth":{...}, "action":"request_list", "status":"open" }
{ "app":"task", "auth":{...}, "action":"request_resolve", "requestId":"grq_...",
  "resolution":"resolved", "expectedRevision":1 }

// 원장·관리 담당: 공지 초안 저장 뒤 revision CAS로 게시한다.
{ "app":"task", "auth":{...}, "action":"announcement_save", "announcementId":"notice-...",
  "expectedRevision":0, "title":"운영 안내", "body":"준비 안내", "publishDate":"2026-08-17",
  "expiresDate":"2026-08-24", "targetType":"students", "studentIds":["student-1"] }
{ "app":"task", "auth":{...}, "action":"announcement_publish",
  "announcementId":"notice-...", "expectedRevision":1 }

// Worker origin의 보호자 웹앱: /#code=<1회용 코드>를 즉시 지운 뒤 교환한다.
// exchange 응답은 HttpOnly·Secure·SameSite=Strict 쿠키를 설정한다.
{ "app":"task", "action":"exchange", "code":"..." }
{ "app":"task", "action":"view" }
{ "app":"task", "action":"respond",
  "caseId":"mu_...", "revision":3, "response":"accept" }
{ "app":"task", "action":"submit_request",
  "requestType":"consultation", "clientRequestId":"req_20260817_a1b2c3d4" }
```

보호자 앱 정적 파일과 API는 같은 Worker origin에서 제공하고, 직원 GitHub Pages와 origin을
분리한다. 초대·세션 원문, 전화번호, 내부 메모는 응답이나 장부에 저장하지 않으며 세션 토큰은
자바스크립트나 localStorage에 노출하지 않는다. 오프라인 캐시는 사용하지 않고, 웹앱 동의나
보호자 연락처 연결이 바뀌면 기존 코드·세션을 즉시 무효화한다.
보호자 요청 종류는 `consultation`, `schedule_check`, `info_correction`뿐이며 학생 ID는 세션에서만
결정한다. 자유문구·전화번호·주소·첨부는 받지 않는다. 같은 종류의 open 요청은 하나로 합치고 학생별
24시간 5건으로 제한한다. 공개 숙제·준비물은 현재 assignment의 최근 14일 최신 1건만 보인다.
교재 상태는 현재 원생 명단의 학생 identity snapshot과 일치하는 배정·인계 원장만 공개한다. 과거 주문
task에는 불변 학생 identity snapshot이 없으므로 보호자 화면에 추정해 표시하지 않는다. 공지는 게시 당시
대상 학생 identity를 저장하고 게시 직전과 보호자 조회 때 현재 재원 명단을 다시 확인한다.

### `/consult-guardian` — consult 보호자 학습 리포트

원장 전체 권한만 학생별 공유 동의를 켜고 24시간 1회용 초대 링크를 만들 수 있다. 대표·관리자
계정은 공유 대상에서 제외한다. 공개 화면은 Worker와 exact same-origin에서만 동작하며
`__Host-wb_consult_guardian` HttpOnly·Secure·SameSite=Strict 쿠키를 사용한다. 세션은 90일,
학생별 최근 3대까지만 유지한다.

```jsonc
// 원장 Pages
{ "app":"consult", "auth":{...}, "action":"access_list" }
{ "app":"consult", "auth":{...}, "action":"access_set", "staffId":"student-1",
  "enabled":true, "consentConfirmed":true, "expectedUpdatedAt":0 }
{ "app":"consult", "auth":{...}, "action":"invite", "staffId":"student-1" }
{ "app":"consult", "auth":{...}, "action":"preview", "staffId":"student-1" }

// 같은 Worker origin의 /consult-guardian/ 정적 화면
{ "app":"consult", "action":"exchange", "code":"..." }
{ "app":"consult", "action":"view" }
{ "app":"consult", "action":"ack", "reportId":"cgr_...", "reportRevision":2 }
{ "app":"consult", "action":"logout" }
```

보호자에게는 학생별·기간별 최신 `admin` 발행 리포트만 반환하며 최신 revision이 철회 상태면
그 기간은 숨긴다. 학생 ID, 내부 task ID·origin, URL·설정, 인증사진·질문 원문은 DTO에서 제외한다.
과목·수행·공부시간·학생 회고·원장 피드백·다음 집중 목표만 길이 제한과 URL 제거 후 공개한다.
확인 기록은 현재 공개 중인 정확한 리포트 revision에만 멱등 저장한다. 공유 해제, 학생 이름·역할·
활성 identity 변경, 공개 scope 상향은 기존 코드·세션을 폐기하며 새 동의를 요구한다.

### `/student-portal` — 학생 전용 최소권한 앱

학생 앱은 보호자 앱과 다른 Worker origin과 `__Host-wb_student_session` 쿠키를 사용한다. 관리자 화면에서
현재 보호자 연락처를 먼저 저장한 뒤, 보호자에게 공개 범위를 안내하고 별도 동의를 확인해야 access를
활성화할 수 있다. access·초대코드·세션에는 현재 stable 학생 identity와 보호자 identity, 동의 scope,
동의 시각을 함께 봉인한다. 학생 이름이나 보호자 연락처가 바뀌면 기존 코드와 세션을 즉시 폐기한다.
외부학습 이동은 scope v2, 오늘 할 일 자기 체크는 scope v3다. 기존 v1 세션은 종전 읽기 정보만,
v2 세션은 외부학습 링크까지 유지하며 자기 체크 필드와 쓰기 capability는 받지 않는다. v3는 보호자에게
학생 선택과 담당 선생님 확인 범위를 다시 안내·확인한 뒤에만 저장하고, 기존 코드·세션을 폐기해 새
초대 링크로 연결한다. 기존 `effective_scope_version IN (1,2)` 열은 재작성하지 않고 v3 자기 체크 동의
비트와 확인 시각을 별도로 봉인한다.

```jsonc
// 직원·보호자 Worker의 원장·관리 담당 인증 경로
{ "app":"task", "auth":{...}, "action":"access_set", "studentId":"student-1",
  "enabled":true, "consentConfirmed":true, "scopeVersion":3, "expectedUpdatedAt":0 }
{ "app":"task", "auth":{...}, "action":"invite", "studentId":"student-1" }
{ "app":"task", "auth":{...}, "action":"preview", "studentId":"student-1" }
{ "app":"task", "auth":{...}, "action":"self_check_list", "lessonDate":"YYYY-MM-DD" }
{ "app":"task", "auth":{...}, "action":"self_check_confirm",
  "activityId":"glp_...", "expectedRevision":1 }

// 별도 학생 Worker의 exact same-origin 경로
{ "app":"task", "action":"exchange", "code":"..." }
{ "app":"task", "action":"view" }
{ "app":"task", "action":"self_check_set", "activityId":"glp_...", "publicationRevision":1,
  "response":"completed", "expectedRevision":0 }
{ "app":"task", "action":"logout" }
```

학생 화면에는 오늘 수업·출결·5단계 진행, 오늘 차량의 방향·예정 시각·안전 상태, 주간 시간표,
최근 14일 중 선생님이 `학생 앱에도 공개`를 명시한 숙제·준비물 기록, identity가 검증된 배정 교재 상태만 표시한다.
보호자 연락처·주소·정류장·기사 정보·내부 메모·보호자 요청·보강·회차·공지·수업 피드백·교재 주문
상태는 반환하지 않는다. 기존 보호자 공개 숙제는 `student_visible=0`으로 유지되어 자동 승계되지 않는다.
외부 서비스 URL도 API DTO에 넣지 않고, scope v2 세션과 관리자 미리보기에만
`capabilities.externalLearning=true`를 반환한다. 정적 학생 화면은 이 boolean이 true일 때만 사전에 검토한
공식 학습 링크를 표시한다.
scope v3의 자기 체크는 KST 오늘의 `published + student_visible=1` 공개 수업에만 붙는다. 학생 ID는
세션에서만 결정하고 입력값은 `completed` 또는 `help_needed`뿐이다. 학생 선택은 업무지시서의 출결이나
5단계 체크를 바꾸지 않으며, 담당 선생님의 개인 인증으로 확인하기 전에는 최종 완료가 아니다. 관리
담당도 자신의 수업만 확인할 수 있고 원장 비밀키는 담당자 흉내 내기에 사용할 수 없다. 학생 변경은
24시간 30회로 제한하며 current 행은 CAS, 이력은 UPDATE/DELETE 불가 event로 보존한다. 공개 내용이
수정·철회되면 이전 선택은 표시·확인할 수 없고 현재 공개 revision에 다시 선택해야 한다.
같은 공개 revision에서 담당자가 확인한 `completed`는 최종 상태라 학생이 되돌릴 수 없다. 확인된
`help_needed`는 학생이 `completed`로 바꿀 수 있지만 다시 담당 확인 대기가 된다.
학생 앱 정적 파일은 `student/`, 전용 Worker 설정은 `sync/wrangler.student.toml`에 있다. 한 학생 기기에
다른 초대코드를 연결하려면 먼저 로그아웃해야 하며, 유효 세션이 있으면 코드를 소비하지 않고 409로 막는다.

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
