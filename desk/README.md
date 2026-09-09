# WB 프로그램데스크 — 구독 학생 프로그램·자료 운영 앱

학원 운영(업무지시서·진로독서)과 **별개의 사업**을 위한 앱이다. 메타수학·넬트·스터디포스·클래스카드를 이용하는 구독 학생(학원 재원 여부 무관)의
명단·계정·일일 수행·후속 연락과, 이그잼포유·족보닷컴 자료의 구매·제공을 담당 직원 1명이 운영하고 원장이 관리한다.

- 주소: `https://wb-desk.whdudwns33.workers.dev/` (Cloudflare Worker `wb-desk`, 새 D1 `wb-desk`)
- 사용자: 직원(개인 링크)과 원장(비밀번호). 학생·보호자 화면은 없다.
- 기획 정본: `docs/외부프로그램-자료운영-직원웹앱-기획제안-3안-v0.md` §8(방향 변경)과 세 안(§3~§5)

## 1. 처음 시작

1. 주소를 연다 → **관리자 비밀번호 만들기**(8자 이상). 이 화면은 비밀번호가 없을 때 한 번만 나온다.
2. **관리** 탭 → 직원 등록 → **링크 발급** → 링크를 직원에게 1:1로 보낸다(7일 안에 한 번 열면 그 기기에 연결된다).
3. **학생** 탭 → 학생 등록(이름·학년·구독 프로그램·계정 상태·보호자 연락처·동의).
4. **관리** 탭 → **📋 런북 발행** → 직원의 오늘 할 일에 하루 절차가 등록된다.

__APP_USAGE__

## 3. 데이터와 권한

| 데이터 | 저장 | 누가 쓰나 |
|---|---|---|
| 학생·구독·계정·보호자 연락처 | D1 `desk_docs` (`students`) | 직원·원장. 삭제는 원장 |
| 오늘 할 일(런북 task·체크) | `tasks`·`checks` | 직원·원장 |
| 자산 원장(시험 범위·자산·이벤트) | `checks`의 `__licneed__`·`__lic__`·`__licev__` 키 | 직원·원장. **구매 승인·반려는 원장만**(서버가 강제) |
| 수행 기록(프로그램 설정·일일 스탬프·조치) | `checks`의 `__perfset__`·`__perfday__`·`__act__` 키 | 직원·원장 |
| 연락 기록 | `contacts` (쓴 뒤 바뀌지 않음) | 직원·원장 |
| 운영 요청 | `desk_requests` + 이벤트 | 직원(자기 것)·원장(전체) |
| 직원·링크·토큰·설정 | `desk_staff`·`desk_codes`·`desk_tokens`·`settings` | 원장 |

개인정보 규칙: 보호자 전화번호는 `students.guardian.phone` 한 필드에만 둔다. 다른 어떤 글자 칸에도 전화·이메일·주민번호 패턴이 들어오면
서버가 거부한다(`PII`). 화면 목록은 번호를 가려 보이고, 탭하면 전화가 걸린다. 정적 파일·저장소에는 학생 정보가 없다.
외부 서비스는 `shared/external-links.js`의 공식 https 주소를 새 창으로 열 뿐, 아이디·비밀번호·수행 결과를 받아 오지 않는다.

## 4. 서버 API 요약 (`/api/*`, JSON, 모든 응답 `Cache-Control: no-store`)

| 경로 | 누가 | 하는 일 |
|---|---|---|
| `GET /api/health` | 누구나 | `{ok, app:'wb-desk', setup, now}` — `setup`이 false면 비밀번호 미설정 |
| `POST /api/setup` `{password}` | 최초 1회 | 원장 비밀번호 생성 + 토큰 |
| `POST /api/login` `{password}` | 원장 | 토큰. 5회 실패 시 5분 잠금 |
| `POST /api/password` `{password, newPassword}` | 원장 | 비밀번호 변경(다른 기기 토큰 폐기) |
| `POST /api/link-exchange` `{code}` | 직원 링크 | 1회용 코드 → 기기 토큰 |
| `GET /api/me` · `POST /api/logout` | 인증 | 내 역할 / 이 기기 토큰 폐기 |
| `GET /api/staff` · `POST /api/staff` `{op:create|link|rename|activate|deactivate|revoke}` | 원장(GET은 직원도) | 직원·링크 관리 |
| `GET /api/docs?since=` · `POST /api/docs {changes}` | 인증 | 문서 읽기·쓰기(컬렉션 규칙은 `desk-api.mjs` 상단 표) |
| `POST /api/requests` `{action,…}` | 인증 | 운영 요청 원장 — list/create/assign/accept/start/done/block/unblock/cancel |
| `GET /api/export` | 원장 | 전체 백업 JSON |

인증은 `Authorization: Bearer <token>`. 토큰은 서버에 해시로만 저장되고, 원장 30일·직원 180일(마지막 사용 기준)이다.

## 5. 배포 — 원장은 머지만

`.github/workflows/deploy-desk.yml`이 main에 `desk/` 변경이 올라오면 자동으로 돈다: 테스트 → `node desk/build.mjs`(dist 조립) →
D1 `wb-desk`를 이름으로 찾고 없으면 생성 → `migrations/*.sql` 전부 순서대로 적용(**전부 `IF NOT EXISTS`라 매번 반복해도 안전** — 새 마이그레이션도
이 규칙을 지킨다) → 워커 배포 → `/api/health` 확인. 저장소 시크릿 `CLOUDFLARE_API_TOKEN`(D1 편집 + Workers 편집)·`CLOUDFLARE_ACCOUNT_ID`가 필요하다.
Actions 탭에서 [Run workflow]로 손으로 돌릴 수도 있다. 사용자 도메인을 붙이려면 `wrangler.toml`에 `routes` 한 줄과 Cloudflare DNS 클릭이 필요하다.

## 6. 로컬 실행·테스트

```
node --test desk/*.test.mjs desk/lib/*.test.cjs desk/app/*.test.cjs   # 서버·순수 로직·런타임
PORT=8891 node desk/dev-server.mjs                                    # 로컬 서버 (D1 대역: desk/.local/desk.sqlite — 커밋 금지)
node desk/build.mjs                                                   # dist 조립 (배포 워크플로우가 하는 일과 같다)
```

## 7. 파일

```
desk/
├─ worker.mjs          워커 진입 — /api/* → desk-api, 그 외 정적 자산
├─ desk-api.mjs        인증·직원·문서·내보내기 라우트 (+ worker.test.mjs)
├─ requests.mjs        운영 요청 원장 (+ requests.test.mjs)
├─ migrations/         D1 스키마 (멱등)
├─ dev-server.mjs      로컬 실행 (node:sqlite)
├─ build.mjs           app/ + lib/ + shared/external-links.js → dist/
├─ app/                index.html · app.js(런타임·화면) · desk-core.js(순수 로직) · desk.css · manifest · icon
└─ lib/                런북(runbook-*)·자산(ledger-*)·수행(perf-*) 코어와 패널, runbook-pack.json — 세 기획안의 부품
```
