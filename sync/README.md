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

# 2) 스키마 적용 (원격)
npx wrangler d1 execute wb-sync --remote --file=./schema.sql

# 3) 비밀키 등록 — 코드나 wrangler.toml에 적지 않는다
npx wrangler secret put TASK_ADMIN_SECRET
npx wrangler secret put CONSULT_ADMIN_SECRET
npx wrangler secret put NAVER_ID        # 네이버 검색 API Client ID (강좌 검색용)
npx wrangler secret put NAVER_SECRET    # 네이버 검색 API Client Secret
npx wrangler secret put SOLAPI_API_KEY              # 업무지시서 전용 Solapi API Key
npx wrangler secret put SOLAPI_API_SECRET           # 생성 시 한 번만 표시되는 API Secret
npx wrangler secret put SOLAPI_SENDER_NUMBER        # Solapi에서 활성화된 발신번호
npx wrangler secret put SOLAPI_TEST_RECIPIENT_PHONE # 원장 본인 테스트 수신번호
npx wrangler secret put WB_SEND_MODE                 # test
npx wrangler secret put WB_TEST_RECIPIENT_ID         # TEST-SMS-001
npx wrangler secret put WB_ACTUAL_TEST_SEND_APPROVED # 평상시 false

# 4) 배포
npx wrangler deploy
```

Solapi 비밀값은 `.dev.vars`, `.env`, `wrangler.toml`, README 또는 GitHub에 적지 않는다.
기존 API Key의 Secret은 다시 볼 수 없으므로, 다른 자동화가 사용하는 Secret을 재생성하지 말고
업무지시서 Worker 전용 API Key를 별도로 만든다. `SOLAPI_TEST_RECIPIENT_PHONE`은 원장 본인 번호만
등록하며, 실제 직원·학부모 발송은 별도 승인 절차를 거친다.

평상시 `WB_ACTUAL_TEST_SEND_APPROVED`는 반드시 `false`로 둔다. 원장 본인 1건 테스트를 별도로
승인받은 직후에만 `true`로 바꾸고, 결과 확인 즉시 다시 `false`로 바꾸거나 Secret을 삭제한다.
상세 절차는 [Solapi 원장 수행보고 문자 운영](./SOLAPI_OPERATIONS.md)을 따른다.

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
응답:
```jsonc
{ "ok": true, "now": 1785651111111, "more": false, "changes": [ /* since 이후 바뀐 행 */ ] }
```
`more: true`면 아직 남은 게 있다는 뜻이니 받은 `now`로 한 번 더 호출한다.

### `/token` — 개인 링크 토큰 발급 (원장만)
```jsonc
{ "app": "consult", "auth": { "mode": "admin", "secret": "..." }, "staffId": "S1" }
→ { "ok": true, "token": "..." }
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
