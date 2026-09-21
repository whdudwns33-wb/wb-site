# WB 진로독서 백엔드 + 관리 웹

학생 기록 서버 동기화와 강사용 현황판. Node 22 내장 모듈만 사용(무의존성).

## 실행

```bash
ADMIN_PIN=원하는PIN node reading-server/server.mjs   # 기본 포트 8890 (아이디 로그인은 ADMIN_ID·ADMIN_PASSWORD 를 대신 써도 된다)
# 관리 로그인에 기본값은 없다 — 둘 다 빠지면 서버가 뜨지 않는다(공개 저장소에 기본 PIN 을 적어 두지 않으려는 것)
```

| 경로 | 내용 |
|------|------|
| `/` | 학생 앱 (reading/ 폴더를 그대로 서빙 — 같은 주소라 연동이 자동 활성화) |
| `/vocab/` | **워드브레인** (어휘 기억 앱, vocab/ 폴더) — 같은 오리진이라 진로독서 어휘장·학생 토큰이 자동 공유 |
| `/hanja/` | **한자브레인** (한자·한글 어휘 앱, hanja/ 폴더) — 같은 오리진, 학생 토큰 공유. 단어장은 `/api/hanja/*`(KV·db 전용) |
| `/admin/hanja-admin.html` | **한자브레인 단어장 관리** (PIN) — 문제집 단어장 업로드(붙여넣기·JSON)·공개 범위·종류(자체/교재)·학생 배정·현황 |
| `/admin` | 강사 관리 웹 (PIN 로그인) — 현황판·학생 상세·백업·학부모 링크 |
| `/admin/vocab-review.html` | **워드브레인 AI 연상 검수함** (PIN 로그인) — 승인/반려 + 학생별 어휘 현황 |
| `/review.html` | 지문 검수 뷰어 + **발행/초안 원클릭 전환** (PIN 로그인) |
| `/parent.html?t=…` | 학부모 주간 리포트 (학생별 열람 토큰, 로그인 불필요, 읽기 전용) |
| `/letter/` · `/letter/?t=…` | **브레인레터** 주간 뉴스레터 — 학생 앱 / 가족 링크(같은 학부모 토큰) / [PDF로 저장] |
| `/admin/letter-admin.html` | **브레인레터 관리** (PIN 로그인) — 호 편집·AI 초안·발행·발송 문구·열람 현황 |
| `/api/health` | 상태 확인 |

### 한자브레인

- 라우트는 `/api/hanja/*`, 데이터는 `hanja:` 접두 KV 키(로컬 `db.hanja`)만 — `hanja-api.mjs` 한 모듈. 상세는 `hanja/README.md`.
- 학생: `GET /books`·`GET /book?id=`(+`remap`)·`GET /pull`·`PUT /state`(저장 시 `hanja:summary:<code>` 요약 갱신)·`GET /task`(이번 주 단원, 학생→반→default)·`GET /strokes`(공용 획순 사전)·`GET /push/key`·`POST /push/subscribe|unsubscribe`(밤 9시 알림 — 워드브레인 크론이 함께 보낸다).
- 관리(PIN): `POST /admin/book`(붙여넣기·JSON, dryRun, 재업로드 시 낱말 id 대응 remap)·`GET /admin/books`·`DELETE /admin/book`·`POST /admin/scope`(id 하나 또는 ids 여러 권 — 한 번의 쓰기)·`POST /admin/source`(종류 — AI 연상은 자체 단어장만)·`POST /admin/assign`·`POST /admin/task`·`GET /admin/tasks`·`DELETE /admin/task`·`GET /admin/progress?scope=`(단원별 진도)·`POST|GET /admin/strokes`(획순 사전)·`GET /admin/overview`(요약 키). 관리 화면 `/admin/hanja-admin.html`, 시험지 인쇄 `/admin/hanja-print.html`.
- 단어장 검사 규칙은 `hanja/book-check.js` 하나 — CLI `node hanja/book-validate.mjs` 와 업로드 관문이 같은 판정. 백업 덤프에는 단어장 본문이 없다(id·메타만).

### 워드브레인 (분리 가능한 A 구조)

- 라우트는 `/api/vocab/*` 아래, 데이터는 vocab 전용 저장소(워커: `vocab:` 접두 KV 키, 로컬: `db.vocab`)만 사용 — 로직은 `vocab-api.mjs` 한 모듈. 나중에 단독 서비스로 분리할 때 이 모듈+키만 들어내면 된다.
- 인증은 진로독서 학생 토큰을 그대로 공유 — 학생은 "선생님 연동" 한 번으로 두 앱 모두 연동된다.
- 학생 API: `GET /api/vocab/pull` / `PUT /api/vocab/state` (400KB 제한) / `POST /api/vocab/mnemonic {word,meaning,type}` — AI 연상 3안 생성(같은 단어는 캐시, 승인되면 승인본만 반환).
- 관리 API(PIN): `GET·POST /api/vocab/admin/review` (승인 시 cue·scene 확정 — 이후 학생들에게 재사용) / `GET /api/vocab/admin/overview`.
- AI 연상은 `ANTHROPIC_API_KEY` 시크릿 필요(모델 기본 `claude-opus-5`, `VOCAB_AI_MODEL`로 변경). 키가 없으면 해당 기능만 "미설정" 안내로 동작.
- **관리 로그인**은 PIN(`ADMIN_PIN`) 또는 아이디·비밀번호(`ADMIN_ID`·`ADMIN_PASSWORD`) — 판정은 `admin-auth.mjs` 하나(워커·로컬 공용, 다이제스트 고정 시간 비교). 워커 시크릿은 Actions 「관리 계정·AI 삽화 시크릿 등록」(`admin-secrets.yml`)이 저장소 시크릿에서 복사한다(값을 입력으로 받지 않는다 — public 저장소). 브레인레터 AI 삽화의 `GEMINI_API_KEY` 도 같은 워크플로우.
- **PIN 을 잊었다면** 되찾을 수 없다 — 워커 시크릿은 덮어쓸 수만 있고 읽어낼 수 없다. 저장소 시크릿에 새 `ADMIN_PIN`(10자 이상)을 넣고 위 워크플로우를 `pin` 체크로 돌리면 교체된다. 아이디·비밀번호를 새로 등록해 그쪽으로 들어가도 된다. 어느 쪽이든 **이미 로그인해 둔 기기의 관리 토큰은 최장 30일까지 살아 있다**(로그인과 따로 발급되는 값이라 교체로 끊기지 않는다).
- **밤 9시 물주기 푸시**: 페이로드 없는 Web Push(암호화 불필요·무의존성). `node reading-server/gen-vapid.mjs`로 키 생성 → `VAPID_PUBLIC_KEY`·`VAPID_PRIVATE_JWK` 시크릿 등록. 학생이 리포트 탭에서 "밤 9시 알림 켜기" → 21:00 KST 크론이 **물 줄 단어가 있는 구독자에게만** 발송(404/410이면 구독 자동 정리). 키가 없으면 알림 카드만 비활성.
- 승인 반영 루프: 학생이 고른 연상이 검수 전(pending)이면 앱이 접속 때마다 `mnemonic/check`로 확인 — 승인되면 승인본으로 교체, 반려되면 제거(재생성 가능).

### 브레인레터 (주간 뉴스레터 — `letter/`)

- 라우트는 `/api/letter/*` 아래, 데이터는 `letter:` 접두 KV(로컬: `db.letter`) — 로직은 `letter-api.mjs` 한 모듈, 검증기·렌더러는 `letter/letter.js`.
- 가족: `GET /api/letter/parent?t=토큰[&id=]`(진로독서 학부모 토큰 공용, 로그인 없음) → `{parent, issue, issues}` · `GET /api/letter/parent/push/key?t=` · `POST /api/letter/parent/push/subscribe|unsubscribe?t=`(새 호 푸시 구독).
- 사진: `GET /api/letter/img/<id>`(무인증 — id 가 열쇠, 불변 캐시).
- 학생(Bearer): `GET /api/letter/issues` / `GET /api/letter/issue?id=` (발행일이 지난 호만, 자기 학년대 섹션만) / `GET·PUT /api/letter/state`(150KB, 하루 10회) / `GET /api/letter/push/key` · `POST /api/letter/push/subscribe|unsubscribe`.
- 관리(PIN): `GET /api/letter/admin/issues` · `GET·PUT·DELETE /api/letter/admin/issue` · `POST /api/letter/admin/publish {id,status,publishAt?}`(지금 보이는 첫 발행이면 푸시) · `POST /api/letter/admin/push {id}`(다시 보내기) · `GET /api/letter/admin/push/status` · `GET /api/letter/admin/students` · `POST /api/letter/admin/tier {code,tier}` · `GET /api/letter/admin/messages?id=`(발송 문구 + 가족 링크 발급) · `GET /api/letter/admin/stats?id=` · `POST /api/letter/admin/draft {part,theme?,week,…}`(AI 초안 한 조각 — `ANTHROPIC_API_KEY`, 한도 `LETTER_AI_DAILY` 기본 30, 주제·지표는 달력에서) · `GET /api/letter/admin/imgs` · `POST /api/letter/admin/img {name,data(base64),w,h,src?}`(JPEG/PNG/WebP ≤1.5MB) · `DELETE /api/letter/admin/img {id}` · `POST /api/letter/admin/img/gen {prompt,ratio}`(AI 삽화 — `GEMINI_API_KEY`, 그림을 base64 로 돌려주고 저장하지 않는다, 한도는 AI 초안과 같은 장부) · `GET·PUT /api/letter/admin/calendar`.
- 새 호 푸시: 워드브레인과 같은 VAPID 키. 발행 즉시(워커 `waitUntil`) + 22:00 UTC(07:00 KST) 크론이 발행일이 된 호를 한 번 보낸다. 로컬 서버는 1분 폴링.
- 화면: `/letter/`(학생·가족·체험·관리 미리보기 `?id=&tier=&print=`) · `/admin/letter-admin.html`.

## 동작 방식

- **학생**: 앱 설정 → "선생님 연동"에 학생 코드 입력 → 이후 모든 기록(완독·문제·훈련·보고서)이 저장 시 2.5초 디바운스로 서버에 자동 백업. 새 기기에서 같은 코드로 연동하면 기록 복원(활동량 많은 쪽 채택). 강사의 레벨 조정은 다음 동기화 때 반영.
- **강사**: `/admin` → 학생 등록(코드 발급) → 현황판(오늘 미수행 상단 정렬), **학생 이름 클릭 → 상세**(완독 목록·정답률·보고서 원문·붉은책·읽기 속도), 레벨 조정, **학부모 링크 발급/재발급**, **전체 백업 내려받기 + 자동 스냅샷**.
- **발행**: `/review.html`에서 PIN 로그인 후 지문별 '지금 발행 / 초안으로 내리기' — 재배포 없이 즉시 반영(발행 오버라이드가 KV `pubmap`에 저장되고 `/articles.json` 서빙 시 적용). 주간 루틴이 pubmap을 git articles.json에 정합시킴.
- **학부모**: 관리 웹에서 학생별 링크 생성 → 학부모는 로그인 없이 주간 현황(연속·이번 주·완독·정답률·읽기 속도·최근 글·보고서 제목)만 열람.

## API 요약

- 공개: `GET /api/health` · `GET /api/pub`(발행 오버라이드 맵) · `GET /api/parent/summary?t=토큰`(학부모 리포트)
- 학생: `POST /api/login {code}` → `{token, student}` / `GET /api/pull` / `PUT /api/state {state}` (Bearer, 900KB 제한) / `GET /api/league`(같은 반 스트릭 리그 — 성적 비공개)
- 관리(Bearer, PIN 로그인): `POST /api/admin/login {pin}` / `GET /api/admin/overview` / `POST /api/admin/students` / `POST /api/admin/level` / `GET /api/admin/student/:code` / `GET /api/admin/export[?backup=날짜]` / `GET /api/admin/backups` / `POST /api/admin/backup-now` / `POST /api/admin/pub {id,status}` / `POST /api/admin/parentlink {code,reset?}` / `GET /api/admin/parent-messages`(학부모 주간 발송 문구 일괄 생성)
- 로그인 실패는 IP당 15분 20회로 제한(무차별 대입 완화, 워커).

## 저장소·백업

- 로컬: `reading-server/data/db.json` + 하루 1회 자동 스냅샷 `data/backups/db-<날짜>.json`(10개 보관).
- 워커(운영): Cloudflare KV. **크론이 매일 03:00 KST에 `backup:<날짜>` 스냅샷을 만들어 10개 보관.** 관리 웹 '데이터 백업' 카드에서 현재 데이터·스냅샷을 JSON으로 내려받아 컴퓨터에 보관 권장(주 1회).
- 프로덕션 이관 지점: `store.mjs`만 KV/D1 또는 PostgreSQL로 교체.

## 배포 옵션

1. **원내 PC/NAS**: 학원 컴퓨터에서 위 명령 실행 → 원내 태블릿은 `http://<PC IP>:8890` 접속.
2. **Cloudflare Workers (운영 중)**: **https://wb-reading.whdudwns33.workers.dev** — 학생 앱(/) + 관리 웹(/admin) + API + 일일 백업 크론. `worker.mjs`+KV(DB)로 배포됨.
   재배포는 자동: `reading/**`·`reading-server/**` 변경이 main에 머지되면 GitHub Actions가 배포. 수동은 `node build-dist.mjs && CLOUDFLARE_API_TOKEN=... npx wrangler deploy` (reading-server/ 에서)

⚠ 운영 전 필수: `ADMIN_PIN`(또는 `ADMIN_ID`·`ADMIN_PASSWORD`) 설정 — **기본값이 없어 없으면 아예 뜨지 않는다**. HTTPS(터널/워커) 뒤에서만 외부 노출.
