# WB 세일즈데스크 — 상담·CS 뒤 전환 CRM + HubSpot 연동 + 파트너 학원 연계

웩슬러브레인센터에서 **상담(해석 상담)·CS 가 끝난 가정**을 등록까지 이어가는 원내 앱. 문의 접수 → 예약 → 검사 → 해석 → **D+3·D+7·D+14 팔로업** → 판정(등록 / 장기보류 / 이탈+사유)까지 한 화면에서 돌고,
리드·기록은 **원장 승인 뒤 HubSpot** 연락처·딜·노트로 간다. 파트너 학원(서로 광고·소개, 센터는 검사 제공)은 별도 포털 `/partner/` 로 소개를 보내고 받는다.

- 주소: `https://wb-crm.whdudwns33.workers.dev/` (Cloudflare Worker `wb-crm`, D1 `wb-crm`) · 파트너 포털 `/partner/`
- 사용자: 원장(비밀번호) · 상담 직원(개인 링크) · 파트너 학원(포털 개인 링크, `/api/partner/*` 만)
- 운영 규칙의 출처: 원장 CRM 운영 정리(파이프라인 2개·채널·D+3/7/14·이탈 사유 P/T/C/W/N/U·재검사 2년·소개 크레딧 v2.0·HubSpot 반영은 승인 뒤) — 코드는 `crm-core.js` 가 정본
- 파트너 연계 기획·구조 결정: `docs/파트너학원-연계-기획서-v0.md`

## 1. 처음 시작

1. 주소를 연다 → **관리자 비밀번호 만들기**(8자 이상). 처음 한 번만.
2. **관리** 탭 → 직원 등록 → **링크 발급** → 1:1 로 보낸다(7일 안에 한 번 열면 그 기기에 연결).
3. **허브스팟** 탭(원장) → 연결 상태 확인. 토큰이 없으면 §5 대로 등록 → [HubSpot 파이프라인 불러오기] → 라벨이 같은 단계는 자동으로 맞춰진다 → [매핑 저장] → [없는 속성 만들기] → [전체 가져오기].
4. **파트너** 탭(원장) → 파트너 학원 등록 → [링크 발급] → 파트너 원장에게 보낸다.
5. 오늘부터: **＋ 새 문의**에 카톡·전화 메모를 그대로 붙여 넣으면 유입 채널과 핫 리드 여부가 자동으로 표시된다.

## 2. 화면

| 탭 | 하는 일 |
|---|---|
| **오늘** | 팔로업(밀린 것 먼저, [초안 복사]·[기록]·[건너뜀]) · 최종판정 대기(상담 뒤 14일 지남 — [등록]·[보류]·[이탈]) · 바로 연락할 문의(핫·하루 넘게 기록 없음) · 재검사 안내(D-30·D-7·D-day·지남) · (원장) HubSpot 반영 대기 배너 |
| **파이프라인** | 검사 여정(신규문의→연락완료→예약확정→검사완료→해석완료→업셀제안→성사/미성사) · 학원 등록(트라이얼→트라이얼검토→활성→이탈위험→이탈). 칸반 카드: 핫(빨강)·14일 이상 머묾(주황)·HubSpot 연결(초록 점) |
| **고객** | 검색(이름·아이·학교·전화)·채널·담당·상태 필터. PC 표/모바일 카드에 최근 기록·다음 연락 표시. 이름을 누르면 상세 |
| **리드 상세** | 단계 이동(성사/미성사는 판정 창) · 장기보류/해제 · 전화 가림(탭하면 통화) · HubSpot 연락처/딜 열기 · **＋ 기록**(상담·CS·통화·문자·방문·메모 — 상담·CS 는 팔로업 일정 시작·강점 메모·검사 정보·단계 해석완료 이동) · 팔로업 D+3/7/14(초안·기록·건너뜀·일정 다시 잡기) · 파트너 소개(나가는 소개, 동의 필수) · (원장) 소개 크레딧 적립/사용 · 기록 타임라인 · (원장) 삭제 |
| **성과** | 월별 — 신규 문의·상담 완료 코호트·등록·전환율(목표 60%)·D+14 결정률(80%)·팔로업1 응답률(40%)·이탈·핫 비율 · 채널별 유입 · 이탈 사유 · 진행 중 단계 분포 |
| **허브스팟**(원장) | 연결 상태(포털 id) · WB 사용자 속성 점검/생성 · 파이프라인 매핑(자동 제안 + 손 수정) · 가져오기(변경분/전체) · **반영 큐**(승인 대기·반영 대기·실패·반영됨·반려 — 승인/반려/재시도/전체 승인/지금 반영) · "빠른 입력 자동 승인" 스위치 |
| **파트너**(원장) | 파트너 학원 등록·수정·중지/재개·링크 발급·기기 해제 · 월별 집계(보내 준 가정·검사 완료·등록 / 우리가 소개·등록) · 정산 문구 복사 |
| **관리**(원장) | 직원·링크·이름·비활성·기기 해제 · 조직 이름·팔로업 간격 · 비밀번호 · 전체 백업(JSON) |
| **/partner/** (파트너) | 소개 보내기(보호자 동의 필수, 하루 20건) · 보내 준 소개의 진행(접수→예약→검사 완료→등록/종료) · 받은 소개의 상태 표시(보냄→연락됨→등록/미등록)+메모. 전화·메모·내부 단계는 보이지 않는다 |

**팔로업 문자 초안**은 원장의 세일즈 템플릿(D+3 강점 언급·판매 어휘 없음 / D+7 재접촉 / D+14 마무리)에 호칭(어머니·아버님·보호자님)·아이 이름(받침 처리)·강점·검사 요일을 채워 클립보드로 복사한다 — 앱이 문자를 보내지는 않는다.

직원 화면은 PC 왼쪽 메뉴, 넓은 화면의 고객 상세 3단(고객 정보·상담 기록·다음 연락), 모바일 한 열 배치를 쓴다. 입력 창을 수정한 뒤 닫기·ESC·배경 클릭·페이지 이탈 시 확인하며 저장 성공 후에는 묻지 않는다. 고객/활동 기록의 앱 저장 큐와 HubSpot 승인·반영 큐는 별개다.

## 3. 데이터와 권한

| 데이터 | 저장 | 누가 쓰나 |
|---|---|---|
| 리드(보호자·아이·채널·단계·팔로업·판정·검사·재검사·파트너) | D1 `crm_documents` `leads` | 직원·원장. 삭제는 원장. `hubspot`(연결 id)·`creditBalanceHs` 는 서버가 가진다 |
| 기록(상담·CS·통화·문자·방문·메모·단계·팔로업) | `activities` — append-only, 기록자는 토큰 신원 | 직원·원장 |
| 소개 크레딧 원장(적립·사용·소멸·조정) | `credits` — append-only | 원장 |
| 파트너 학원 | `partners` | 원장 |
| 나가는 소개(센터→파트너) | `referrals` — 리드·파트너는 만든 뒤 고정, 상태·메모만 바뀜 | 직원·원장(만들기, 동의 필수)·파트너 포털(상태·메모) |
| 설정(조직 이름·팔로업 간격·HubSpot 매핑·자동 승인·포털 정보) | `settings/main` | 원장(포털 정보는 서버) |
| HubSpot 반영 큐 | `crm_sync_queue` | 서버가 만들고 원장이 승인 |
| HubSpot 연락처 ↔ 리드 연결표 | `crm_hs_links` | 서버 |
| 직원·링크·토큰 / 파트너 링크·토큰 | `crm_staff`·`crm_codes`·`crm_tokens` / `crm_partner_codes`·`crm_partner_tokens` | 원장 |

개인정보 규칙: 전화는 `leads.phone`·`partners.phone`, 이메일은 `leads.email` 에만. 다른 글자 칸(메모·기록·사유·조직 이름)에 전화·이메일·주민번호 패턴이 들어오면 서버가 거부한다(`PII`). 화면은 번호를 가려 보이고 탭하면 통화. 파트너 포털 응답에는 전화·이메일·메모·내부 단계가 없다. 정적 파일·저장소에는 가정 정보가 없다.

## 4. HubSpot 연동 — 어떻게 도나

- **단일 진실**: 연락처·딜은 HubSpot, 팔로업·기록·판정·KPI 는 세일즈데스크. 리드마다 연락처 하나, 파이프라인마다 딜 하나(`hubspot.deals.inspection / academy`).
- **반영 큐**(원장 CRM 규칙 P4-A/B): 리드가 바뀌면 서버가 `contact`(연락처 속성) 줄을, 단계가 바뀌면 `deal`(딜 단계) 줄을, 기록이 생기면 `note`(노트) 줄을 만든다. 같은 리드의 같은 종류는 한 줄로 합쳐진다.
  연락처·노트는 **빠른 입력**(설정에서 자동 승인 가능), 딜 단계 전이는 **검토 필요**(항상 원장 승인). 승인한 딜 줄의 단계가 그 뒤에 또 바뀌면 승인은 무효가 되어 다시 승인 대기로 돌아가고, 리드가 다른 파이프라인으로 옮겨지면 옛 파이프라인의 열린 딜 줄은 반려된다. 승인된 줄은 [지금 반영] 또는 15분 크론이 보낸다. 실패(매핑 없음·429·LINKED 등)는 사유와 함께 남고 [다시 시도]. 리드를 지우면 그 리드의 열린 줄은 반려된다.
- **검사 여정 → 학원 등록**으로 넘기면 검사 여정 딜은 성사로 닫히고 학원 등록 딜이 트라이얼로 생긴다(큐 두 줄).
- **가져오기**: `lastmodifieddate` 기준 변경분 연락처(+연결된 딜)를 리드로. 전화·이메일·`wb_crm_lead_id` 로 같은 연락처를 찾고, 우리 쪽에 미반영 큐가 있는 리드는 덮지 않고 **다음 가져오기 때 id 로 다시 읽는다**(커서와 별도). 원장이 지운 리드는 되살리지 않고, 이름에 전화 패턴이 섞인 연락처는 들여오지 않는다. 기록·팔로업·메모는 건드리지 않는다.
- **중복 방지**: 연락처를 만들기 전에 이메일(첫 그룹)·전화(계산 속성 `hs_searchable_calculated_*` 숫자 + 우리 표기)로 찾는다. 같은 연락처가 이미 다른 리드에 연결돼 있으면 가로채지 않고 큐에 `LINKED` 실패로 남긴다(원장이 두 리드를 합치거나 전화를 바꾼다).
- **속성**: 표준(이름·전화·이메일·lifecyclestage=customer 는 성사 때만) + WB 사용자 속성 `wb_source_channel`(선택지에 `파트너` 보강)·`wb_academy_status`·`wb_credit_balance`·`wb_referrer_contact_id`·`wb_retest_due_date`·`wb_inspection_type`·`wb_inspection_date`·`wb_child_name`·`wb_child_birth`·`wb_child_grade`·`wb_consult_date`·`wb_lost_reason`·`wb_crm_lead_id`·`wb_partner`. 포털에 없는 속성은 만들기 전까지 보내지 않는다.
- **단계 매핑**: 우리 단계 라벨 = HubSpot 딜 단계 라벨이면 자동(검사 여정·학원 등록). `성사(등록)`↔`성사된 거래`, `미성사`↔`성사되지 않은 거래` 는 별칭. 안 맞는 단계는 손으로 고른다.

## 5. HubSpot 토큰 등록 (원장 1회)

1. HubSpot → 설정 → 통합 → **비공개 앱(Private Apps)** → 앱 만들기. 스코프: `crm.objects.contacts`(읽기·쓰기) · `crm.objects.deals`(읽기·쓰기) · `crm.schemas.contacts`(읽기·쓰기 — 속성 만들기) · `crm.objects.owners`(읽기). 노트는 contacts 쓰기 스코프로 충분하다.
2. 토큰을 GitHub 저장소 **Settings → Secrets and variables → Actions** 에 `HUBSPOT_ACCESS_TOKEN` 으로 저장한다.
3. Actions → **Deploy wb-crm worker** → Run workflow. 워크플로우가 저장소 시크릿을 워커 시크릿으로 복사한다(값은 마스킹, 로그에 안 남음). 이후 main 배포마다 같은 단계가 돌아 토큰을 갈아 끼워도 된다.
4. 허브스팟 탭 → [다시 확인] → "연결됨".

토큰은 저장소·화면·응답·로그 어디에도 적지 않는다(절대 규칙 5). 손으로 넣을 때: `printf '%s' "$TOKEN" | npx wrangler secret put HUBSPOT_ACCESS_TOKEN` (`crm/` 에서).

## 6. 서버 API 요약 (`/api/*`, JSON, 모든 응답 `Cache-Control: no-store`)

| 경로 | 누가 | 하는 일 |
|---|---|---|
| `GET /api/health` | 누구나 | `{ok, app:'wb-crm', setup, hubspot(토큰 유무), now}` |
| `POST /api/setup` · `/api/login` · `/api/password` · `/api/link-exchange` · `GET /api/me` · `POST /api/logout` | — | desk 와 같은 인증(원장 PBKDF2 비밀번호, 직원 1회용 링크, Bearer 토큰 sha256 저장, 원장 30일·직원 180일) |
| `GET /api/staff` · `POST /api/staff {op}` | 원장 | 직원·링크 관리 |
| `GET /api/docs?since=` · `POST /api/docs {changes}` | 인증 | 문서 읽기·쓰기(컬렉션 규칙은 `crm-api.mjs` RULES). 쓰면 반영 큐가 생긴다(`queued`) |
| `GET /api/hubspot/queue?status=&leadId=` · `POST /api/hubspot/queue {op:approve\|reject\|retry\|unapprove\|approveAll, ids}` | 읽기 인증·쓰기 원장 | 반영 큐 |
| `GET /api/hubspot/status` · `/pipelines` · `GET\|POST /properties` · `POST /pull {full}` · `POST /push {limit}` | 원장 | 연결·파이프라인 제안·속성 점검/생성·가져오기·반영 |
| `POST /api/partners {op:link\|revoke\|devices, partnerId}` | 원장 | 파트너 포털 링크·기기 |
| `POST /api/partner/link-exchange` · `GET /api/partner/me` · `GET\|POST /api/partner/referrals` · `POST /api/partner/referrals/<id>/status` · `POST /api/partner/logout` | 파트너 토큰 | 포털(`partner-api.mjs`). 파트너 토큰으로는 다른 `/api/*` 가 열리지 않고, 직원 토큰으로는 `/api/partner/*` 가 열리지 않는다 |
| `GET /api/export` | 원장 | 전체 백업 JSON(토큰 없음) |

## 7. 배포 — 원장은 머지만

`.github/workflows/deploy-crm.yml` 이 main 에 `crm/` 변경이 올라오면 돈다: 테스트 → `node crm/build.mjs` → D1 `wb-crm` 을 이름으로 찾고 없으면 생성 → `migrations/*.sql` 전부 순서대로(**전부 `IF NOT EXISTS`**) → 번들 dry-run(node: 모듈 금지) → 배포 → `HUBSPOT_ACCESS_TOKEN` 저장소 시크릿이 있으면 워커 시크릿으로 복사 → `/api/health`.
필요한 저장소 시크릿: `CLOUDFLARE_API_TOKEN`(D1 편집 + Workers 편집)·`CLOUDFLARE_ACCOUNT_ID`, 선택 `HUBSPOT_ACCESS_TOKEN`.

## 8. 로컬 실행·테스트

```
node scripts/check.mjs --only crm                     # crm 테스트 전부(순수 로직·HubSpot 클라이언트·서버·파트너)
node crm/crm-core.test.cjs && node crm/hubspot.test.mjs && node crm/crm-api.test.mjs
PORT=8892 node crm/dev-server.mjs                     # 로컬 서버 (D1 대역: crm/.local/crm.sqlite — 커밋 금지). HUBSPOT_ACCESS_TOKEN=… 로 실제 연동 시험
node crm/build.mjs                                    # dist 조립 (배포 워크플로우가 하는 일과 같다)
```

## 9. 파일

```
crm/
├─ worker.mjs          워커 진입 — /api/* → crm-api, 그 외 정적 자산 · scheduled(15분) → 승인된 큐 반영
├─ crm-api.mjs         인증·직원·문서 규칙·반영 큐·HubSpot 라우트(status/pipelines/properties/pull/queue/push)·내보내기 (+ crm-api.test.mjs)
├─ partner-api.mjs     파트너 포털 API(/api/partner/*) + 원장 링크 발급 — 나중에 별도 워커로 떼어낼 단위
├─ crm-shared.mjs      두 API 가 함께 쓰는 도우미(응답·암호·문서 읽기/쓰기·PII·큐 등록)
├─ hubspot.mjs         HubSpot CRM v3/v4 클라이언트(fetch 주입)·리드↔연락처 변환·딜·노트 (+ hubspot.test.mjs)
├─ crm-core.js         순수 로직 정본 — 단계·채널/HOT 감지·팔로업·재검사·판정·KPI·크레딧·파트너 집계·단계 자동 매핑·문서 병합 (+ crm-core.test.cjs). 브라우저·서버 공용
├─ migrations/         001 기본 표(원장·직원·코드·토큰·문서·연결표·반영 큐·kv) · 002 파트너 코드·토큰
├─ app/                index.html · app.js(런타임·화면 8개) · crm.css · manifest · icon
├─ partner/            파트너 포털 index.html · partner.js (crm.css 공유, 토큰·API 는 별도)
├─ build.mjs           app/ + crm-core.js + partner/ → dist/ (내용 해시 스탬프)
└─ dev-server.mjs      로컬 실행 (node:sqlite)
```
