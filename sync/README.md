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

# 4) 배포
npx wrangler deploy
```

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
