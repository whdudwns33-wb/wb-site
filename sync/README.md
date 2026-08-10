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

# 3) 비밀키 등록 — 코드나 wrangler.toml에 적지 않는다
npx wrangler secret put TASK_ADMIN_SECRET
npx wrangler secret put CONSULT_ADMIN_SECRET
npx wrangler secret put TASK_MANAGER_STAFF_IDS # task 운영 관리자 staff ID, 쉼표로 구분
npx wrangler secret put SOLAPI_KAKAO_DIRECTOR_REPORT_TEMPLATE_ID # 승인된 수행보고 알림톡 템플릿 ID
npx wrangler secret put NAVER_ID        # 네이버 검색 API Client ID (강좌 검색용)
npx wrangler secret put NAVER_SECRET    # 네이버 검색 API Client Secret

# 4) 배포
npx wrangler deploy
```

원생 정적 파일을 제거하는 배포에서는 `019_private_roster.sql` 적용 → Worker 배포 → 관리자
`/roster replace` 등록·조회 확인 → 프런트 전환 순서를 지킨다. 비공개 원생 데이터나 seed SQL은
저장소에 커밋하지 않는다. 운영 배포에 `deploy.ps1`을 다시 실행하면 관리자 비밀키가 교체되므로
기존 서비스에는 위 수동 명령을 사용한다.

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
