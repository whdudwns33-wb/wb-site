# WB 진로독서 백엔드 + 관리 웹

학생 기록 서버 동기화와 강사용 현황판. Node 22 내장 모듈만 사용(무의존성).

## 실행

```bash
ADMIN_PIN=원하는PIN node reading-server/server.mjs   # 기본 포트 8890
```

| 경로 | 내용 |
|------|------|
| `/` | 학생 앱 (reading/ 폴더를 그대로 서빙 — 같은 주소라 연동이 자동 활성화) |
| `/vocab/` | **워드브레인** (어휘 기억 앱, vocab/ 폴더) — 같은 오리진이라 진로독서 어휘장·학생 토큰이 자동 공유 |
| `/admin` | 강사 관리 웹 (PIN 로그인) — 현황판·학생 상세·백업·학부모 링크 |
| `/admin/vocab-review.html` | **워드브레인 AI 연상 검수함** (PIN 로그인) — 승인/반려 + 학생별 어휘 현황 |
| `/review.html` | 지문 검수 뷰어 + **발행/초안 원클릭 전환** (PIN 로그인) |
| `/parent.html?t=…` | 학부모 주간 리포트 (학생별 열람 토큰, 로그인 불필요, 읽기 전용) |
| `/api/health` | 상태 확인 |

### 워드브레인 (분리 가능한 A 구조)

- 라우트는 `/api/vocab/*` 아래, 데이터는 vocab 전용 저장소(워커: `vocab:` 접두 KV 키, 로컬: `db.vocab`)만 사용 — 로직은 `vocab-api.mjs` 한 모듈. 나중에 단독 서비스로 분리할 때 이 모듈+키만 들어내면 된다.
- 인증은 진로독서 학생 토큰을 그대로 공유 — 학생은 "선생님 연동" 한 번으로 두 앱 모두 연동된다.
- 학생 API: `GET /api/vocab/pull` / `PUT /api/vocab/state` (400KB 제한) / `POST /api/vocab/mnemonic {word,meaning,type}` — AI 연상 3안 생성(같은 단어는 캐시, 승인되면 승인본만 반환).
- 관리 API(PIN): `GET·POST /api/vocab/admin/review` (승인 시 cue·scene 확정 — 이후 학생들에게 재사용) / `GET /api/vocab/admin/overview`.
- AI 연상은 `ANTHROPIC_API_KEY` 시크릿 필요(모델 기본 `claude-opus-5`, `VOCAB_AI_MODEL`로 변경). 키가 없으면 해당 기능만 "미설정" 안내로 동작.

## 동작 방식

- **학생**: 앱 설정 → "선생님 연동"에 학생 코드 입력 → 이후 모든 기록(완독·문제·훈련·보고서)이 저장 시 2.5초 디바운스로 서버에 자동 백업. 새 기기에서 같은 코드로 연동하면 기록 복원(활동량 많은 쪽 채택). 강사의 레벨 조정은 다음 동기화 때 반영.
- **강사**: `/admin` → 학생 등록(코드 발급) → 현황판(오늘 미수행 상단 정렬), **학생 이름 클릭 → 상세**(완독 목록·정답률·보고서 원문·붉은책·읽기 속도), 레벨 조정, **학부모 링크 발급/재발급**, **전체 백업 내려받기 + 자동 스냅샷**.
- **발행**: `/review.html`에서 PIN 로그인 후 지문별 '지금 발행 / 초안으로 내리기' — 재배포 없이 즉시 반영(발행 오버라이드가 KV `pubmap`에 저장되고 `/articles.json` 서빙 시 적용). 주간 루틴이 pubmap을 git articles.json에 정합시킴.
- **학부모**: 관리 웹에서 학생별 링크 생성 → 학부모는 로그인 없이 주간 현황(연속·이번 주·완독·정답률·읽기 속도·최근 글·보고서 제목)만 열람.

## API 요약

- 공개: `GET /api/health` · `GET /api/pub`(발행 오버라이드 맵) · `GET /api/parent/summary?t=토큰`(학부모 리포트)
- 학생: `POST /api/login {code}` → `{token, student}` / `GET /api/pull` / `PUT /api/state {state}` (Bearer, 900KB 제한)
- 관리(Bearer, PIN 로그인): `POST /api/admin/login {pin}` / `GET /api/admin/overview` / `POST /api/admin/students` / `POST /api/admin/level` / `GET /api/admin/student/:code` / `GET /api/admin/export[?backup=날짜]` / `GET /api/admin/backups` / `POST /api/admin/backup-now` / `POST /api/admin/pub {id,status}` / `POST /api/admin/parentlink {code,reset?}`
- 로그인 실패는 IP당 15분 20회로 제한(무차별 대입 완화, 워커).

## 저장소·백업

- 로컬: `reading-server/data/db.json` + 하루 1회 자동 스냅샷 `data/backups/db-<날짜>.json`(10개 보관).
- 워커(운영): Cloudflare KV. **크론이 매일 03:00 KST에 `backup:<날짜>` 스냅샷을 만들어 10개 보관.** 관리 웹 '데이터 백업' 카드에서 현재 데이터·스냅샷을 JSON으로 내려받아 컴퓨터에 보관 권장(주 1회).
- 프로덕션 이관 지점: `store.mjs`만 KV/D1 또는 PostgreSQL로 교체.

## 배포 옵션

1. **원내 PC/NAS**: 학원 컴퓨터에서 위 명령 실행 → 원내 태블릿은 `http://<PC IP>:8890` 접속.
2. **Cloudflare Workers (운영 중)**: **https://wb-reading.whdudwns33.workers.dev** — 학생 앱(/) + 관리 웹(/admin) + API + 일일 백업 크론. `worker.mjs`+KV(DB)로 배포됨.
   재배포는 자동: `reading/**`·`reading-server/**` 변경이 main에 머지되면 GitHub Actions가 배포. 수동은 `node build-dist.mjs && CLOUDFLARE_API_TOKEN=... npx wrangler deploy` (reading-server/ 에서)

⚠ 운영 전 필수: `ADMIN_PIN` 변경, HTTPS(터널/워커) 뒤에서만 외부 노출.
