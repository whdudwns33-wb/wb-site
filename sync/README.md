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
  "cursor": { "srv_at":1785651000000, "table_rank":-1, "key":"" }, // 첫 요청은 모두 0/-1/빈 문자열, 이후 response.cursor
  "changes": [                      // 올릴 변경 (최대 500건)
    { "table": "checks", "k": "__st__S1|2026-08-02", "owner": "S1",
      "data": { }, "updated_at": 1785650000000 }
  ]
}
```
응답:
```jsonc
{ "ok":true, "now":1785651111111,
  "cursor":{ "srv_at":1785651111111, "table_rank":-1, "key":"" },
  "more":false, "changes":[ /* cursor 이후 바뀐 행 */ ] }
```
새 클라이언트는 응답의 복합 cursor `(srv_at, table_rank, key)` 전체를 다음 요청에 그대로 보낸다. `more:true`이면 정확한 마지막 행 위치로 즉시 다음 페이지를 받고, terminal page인 `more:false`이면 서버가 `table_rank:-1, key:""`로 같은 `srv_at` 경계를 한 번 겹쳐 읽도록 만든 cursor를 저장한다. 이 overlap은 같은 밀리초에 늦게 생긴 행의 누락을 막고 LWW가 중복을 제거한다. `now`와 요청의 `since`는 구형 클라이언트 호환 전용이며 새 클라이언트의 진행 기준으로 쓰지 않는다.

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

### `/admin-recover` — task 원장 세션 최초 발급·긴급 복구

```jsonc
{ "app":"task", "auth":{ "mode":"admin", "secret":"<TASK_ADMIN_SECRET>" } }
→ { "ok":true, "token":"...", "expiresAt":... } // 24시간
```

이 경로는 최초 운영 복구, `TASK_ADMIN_SECRET` 교체 직후, 원장 세션을 모두 잃은 긴급 상황에만 사용한다. root secret은 그 순간 한 번만 메모리에 입력하고 URL, 브라우저 저장소, 소스, 셸 이력, 로그에 저장하지 않는다. 성공하면 기존 `admin_sessions`와 아직 소비되지 않은 `admin_bootstrap_codes`를 모두 폐기하고 24시간 유효한 새 원장 세션 토큰 하나를 반환한다. 이후 요청은 새 세션 토큰을 사용하고 root secret 입력값은 즉시 버린다. 이 계약이 없는 Pages 버전으로 되돌리지 않는다.

### `/private-asset` — 직원 앱의 비공개 학생·교재 자료

```jsonc
{ "app":"task", "auth":{...}, "key":"roster" } // roster | textbooks
→ { "ok":true, "key":"roster", "hash":"...", "data":{...} }
```

원장 인증에는 전체 자료를, 개인 링크에는 D1 직원 레코드의 이름과 일치하는 담당 학생만 반환한다.
요청자가 교사 이름을 직접 지정할 수 없으며 `consult` 앱에서는 사용할 수 없다.

운영 자료를 갱신할 때는 공개 JSON을 원본으로 사용하지 않는다. 첫 전환 전·stub 전환 후 모두 roster와 textbooks의 정본을 **저장소 밖 접근 제한 폴더**에서 명시적으로 전달한다. 입력 파일, 생성 SQL, build/D1/sanitize receipt는 모두 공개 저장소 밖의 절대 경로여야 하며 기존 파일은 덮어쓰지 않는다.

```bash
node tools/build-private-assets-sql.mjs \
  --repo /absolute/path/to/wb-site \
  --roster-input /secure/wb-private/roster.private.json \
  --textbooks-input /secure/wb-private/textbooks.private.json \
  --out /secure/wb-private/run-20260803/private-assets.sql \
  --receipt /secure/wb-private/run-20260803/build-receipt.json \
  --roster-sha <SHA256> --textbooks-sha <SHA256> \
  --roster-students <COUNT> --textbook-students <COUNT> \
  --books <COUNT> --vendors <COUNT>
```

안전 순서는 다음과 같다.

1. 위 명령으로 외부 원본의 해시·정확한 개수를 검증하고 외부 SQL과 `wb-private-assets-build` receipt를 만든다. SQL에는 개인정보가 있으므로 접근권한을 제한한다. SQL 안에는 `BEGIN/COMMIT`을 넣지 않는다. 원격 `wrangler d1 execute --file`이 파일 실행 실패를 원복하므로 중첩 transaction을 피한다.
2. D1 백업 후 migration `005_private_assets.sql`과 방금 생성한 SQL을 적용한다. 이 단계와 이후 확인은 운영자 승인 뒤에만 실행한다.
3. 실제 운영 D1을 읽기 전용으로 조회해 행 2개, `json_valid=2`, 각 자산의 content hash·byte 수·정확한 배열 개수·`updated_at`을 build receipt와 대조한다. 이어 배포된 Worker에서 원장 전체 범위와 개인 담당자 범위를 확인한다.
4. 검증 실행기가 `wb-private-assets-d1-verification` receipt를 저장소 밖에 만든다. receipt에는 같은 `buildId`, SQL SHA-256, 운영 D1 ID, 고유 `operationId`, Worker 배포 ID/origin, 원장·개인 범위 확인 결과, 정확한 자산 해시·byte 수·개수·`updatedAt` 및 검증 시각이 있어야 한다. 1시간이 지나면 다시 검증한다. 사람이 손으로 값을 써서 만든 JSON은 검증 receipt로 인정하지 않는다.
5. 공개 파일이 아직 원본이거나 이미 canonical stub인 상태에서 다음 명령을 실행한다. 입력·build·D1 receipt가 한 실행으로 연결되지 않으면 fail-closed하며, 성공 뒤 별도 sanitize receipt를 만든다.

```bash
node tools/sanitize-public-private-assets.mjs \
  --repo /absolute/path/to/wb-site \
  --roster-input /secure/wb-private/roster.private.json \
  --textbooks-input /secure/wb-private/textbooks.private.json \
  --roster-sha <SHA256> --textbooks-sha <SHA256> \
  --build-receipt /secure/wb-private/run-20260803/build-receipt.json \
  --d1-receipt /secure/wb-private/run-20260803/d1-verification.json \
  --sanitize-receipt /secure/wb-private/run-20260803/sanitize-receipt.json \
  --database-id <PRODUCTION_D1_ID>
```

6. canonical stub과 새 정적 앱을 배포하고 인증 경로를 재확인한다. `task/roster.json`과 `task/textbooks.json` stub은 향후 반복 갱신을 위한 공개 호환 파일이므로 삭제하지 않는다. SQL과 외부 원본의 보존·폐기는 개인정보 보관 정책과 사람 승인에 따른다. 운영 갱신에는 비밀키를 재생성하는 `deploy.ps1`을 사용하지 않는다.

### Git 이력과 rollback 하한

현재 작업 트리의 두 JSON을 stub으로 바꾸어도 **Git 과거 이력**의 학생 개인정보는 제거되지 않는다. 완료로 선언하기 전에 **사람의 명시적 승인**으로 다음 중 하나를 선택해야 한다.

- 저장소를 비공개로 전환하고 기존 이력 노출 위험과 접근자 범위를 문서로 수용한다.
- 별도 승인된 작업 창에서 `git filter-repo` 또는 BFG로 모든 ref의 이력을 재작성하고 force-push, 호스팅 캐시·fork·clone 대응과 전원 재-clone까지 수행한다.

이 작업은 자동화 도구가 임의로 실행하지 않는다. 승인과 외부 조치가 끝나기 전에는 `gitHistoryVerified:false`를 유지한다.

비공개 자산 cutover의 Pages 영구 하한은 `2026-08-03.3`이다. `.3`보다 이전 Pages 배포·커밋으로 checkout, Revert, rollback, force-push하면 안 된다. 장애 시 `.3` 기반 유지보수판 또는 `.4+` 수정판으로 **roll-forward only** 한다. Worker·D1도 공개 원본이나 오래된 root-secret 흐름을 다시 요구하는 조합으로 되돌리지 않는다.

## 설계 메모

- **충돌 처리**는 `updated_at`(클라이언트 시각) 기준 last-write-wins. 늦게 도착한 옛 기록이 최신을 덮지 않도록 `ON CONFLICT ... WHERE excluded.updated_at > 기존.updated_at` 으로 막는다.
- **델타 기준은 `srv_at`(서버 시각)** 을 따로 둔다. 기기 시계가 틀어져도 빠지는 행이 생기지 않는다.
- **개인 접속의 쓰기 범위**도 서버에서 검사한다. 클라이언트가 남의 `owner`를 붙여 보내도 저장되지 않는다.
- `ALLOW_ORIGIN`을 비우면 모든 출처를 허용하므로 운영에서는 반드시 채운다.

## 검증

`scratchpad/test-worker.mjs` — 인메모리 SQLite로 D1을 흉내 내 20개 시나리오를 돌린다
(인증·출처·델타·분할·위조 토큰·LWW·앱 격리·토큰 해지·전송 상한·100명 규모 조회).
