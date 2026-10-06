# 세일즈데스크(crm/) — 인수인계 (어느 에이전트든: Codex · Claude Code)

이 문서는 **"지금 어디까지 돼 있고, 다음에 무엇을 하며, 고칠 때 어디가 깨지는가"** 만 적는다. 무엇을 하는 앱인지·화면·API 는 `crm/README.md`,
파트너 연계의 기획·구조 결정은 `docs/파트너학원-연계-기획서-v0.md`, 저장소 공통 규칙은 루트 `AGENTS.md`(= `CLAUDE.md`).

## 0. 시작하기 전에 돌릴 것

```
node scripts/check.mjs --only crm        # crm 하위의 순수 로직·API·화면 검사 전부
node scripts/check.mjs                   # 저장소 전체 — PR 전 필수(초록 아니면 올리지 않는다)
PORT=8892 node crm/dev-server.mjs        # http://127.0.0.1:8892 (빌드 없이 app/ 그대로), 포털은 /partner/
node crm/build.mjs                       # dist/ 조립(배포 워크플로우와 같은 일) — dist/·.local/ 은 커밋 금지
```

HubSpot 실제 연동을 로컬에서 시험하려면 `HUBSPOT_ACCESS_TOKEN=… PORT=8892 node crm/dev-server.mjs` 처럼 **환경변수로만** 넘긴다. 파일·저장소·로그에 두지 않는다.

## 1. 지금 상태 (2026-10-06)

- **배포됨**: `https://wb-crm.whdudwns33.workers.dev/` (워커 `wb-crm`, D1 `wb-crm`, 마이그레이션 001·002 적용). 관계관리 PR #423까지 배포 완료.
- **관리자 설정 완료** — 2026-10-06 관계관리 작업 시작 시 운영 `/api/health`의 `setup:true`를 확인했다. 직원·파트너는 원장이 링크를 발급해야 들어온다. 관리자 비밀번호를 다시 만들거나 재설정하지 않는다.
- **HubSpot 서버 키 등록 완료**: 전용 비공개 앱 `WB Sales Desk`와 README §5의 7개 권한을 만들고 `HUBSPOT_ACCESS_TOKEN`을 GitHub 시크릿에 저장했다. Actions `Deploy wb-crm worker` 실행 `37459212755` 성공, 운영 health `hubspot:true` 확인. 이 값은 키 존재만 뜻한다. 세일즈데스크 관리자 로그인 후 실제 API 연결 확인·매핑·첫 가져오기는 아직 남아 있다. 기존 n8n용 앱의 토큰·권한은 변경하지 않았다.
  원장 포털에는 딜 파이프라인 "검사 여정"(default)·"학원 등록" 2개와 `wb_source_channel`·`wb_academy_status`·`wb_credit_balance`·`wb_referrer_contact_id`·`wb_retest_due_date`·`wb_risk_signals` 가 이미 있고, 나머지 `wb_*` 8개는 [없는 속성 만들기]가 만든다. 포털 id 는 설정 문서(`settings.hubspot.portal`)에 서버가 심는다 — 저장소에 적지 않는다.
- **리뷰에서 고친 것**(둘째 커밋): 승인한 딜 줄의 단계가 바뀌면 다시 승인 대기 · 파이프라인별 큐 합치기 · 되돌아오면 옛 파이프라인 줄 반려 · 가져오기 retry 목록 · 지운 리드 되살리지 않음 · hubspot 필드만 CAS 로 고침 · 다른 리드에 연결된 연락처 가로채지 않음(LINKED 실패) · findContact 이메일 우선 · 선택지 hidden 보존 · 현재 비밀번호 오타 403 · 상태 확인이 설정 문서를 매번 쓰지 않음 · 화면 PII 사전 검사 · 포털 폼 보존 · 단계 select 되돌림 · dev-server `/partner` 리다이렉트.
- **범위**: D+3·7·14는 등록 전환 팔로업이고, 3개월 상품 관리·검사비 분납·별도 CS 티켓은 아직 없다. 소개 크레딧·파트너 소개는 구현되어 있다. HubSpot 실데이터 가져오기·직접 반영은 실행하지 않았고 자동 전송 결과는 미확인이다. 키 등록 이후 기존 승인 큐는 크론으로 전송될 수 있으므로 다음 로그인에서 큐 상태도 확인한다.
- **고객 화면 1차 개선(PR #421)**: PC 왼쪽 메뉴·고객 표(최근 기록/다음 연락), 모바일 고객 카드, 넓은 화면의 고객 정보/상담 기록/다음 연락 3단 배치. 기존 권한·전화 가림·팔로업·HubSpot 승인 규칙은 유지. 모달 변경 후 닫기·ESC·배경·페이지 이탈 확인, 저장 성공 시 확인 생략. 일반 기록은 기존 비동기 저장 큐이므로 서버 사후 거절 시 폼 자동 복원은 아직 없다. `crm/app-modal.test.cjs`의 입력 보호·고객 표·본문 바로가기 9개 검사, 전체 검사 287/287, dist 조립을 통과했다. 로컬 가상 데이터로 PC/모바일/태블릿·검색·빈 결과·입력 취소/폐기·저장 후 새로고침을 확인했다. 배포 여부는 PR #421의 `Deploy wb-crm worker` 결과를 확인한다.
- **관계관리(PR #423)**: 친구맺기·서포터즈의 참여 상태·월 활동·소검사 회차와 맘스쿨의 주제·일정·정원·참석·다음 연락을 기록한다. 맘스쿨은 검사 완료 보호자 4~6명의 차 모임이며 담당자가 동일 보호자의 형제 중복을 확인한다. 고객 상세와 오늘의 연락 예정에 연결했다. 새 기록은 버전 검증과 원본 참조 확인 후 저장하며 서버 재조회 성공 뒤에만 닫는다. 충돌·통신 실패는 입력을 보존한다. 센터앱 혜택 원본·포인트·HubSpot 반영 큐는 변경하지 않는다. 상세 경계는 README §10.
  검증: CRM 5/5·전체 289/289, dist 조립·워커 dry-run 통과. 가상 고객으로 참여·활동·검사·4명 모임 저장/재조회, 오늘 연락 예정, PC·모바일 표시를 확인했다. 독립 리뷰의 고객 ID 오탐·실패한 충돌 재조회·비활성 필드 초기 초점·신규 안내 대비를 고쳤다. 배포 완료 여부는 이 변경을 합친 `Deploy wb-crm worker` 실행으로 확인한다.

## 2. 다음 할 일 (우선순위 순)

1. **HubSpot 실데이터 점검** — 서버 키는 등록됐으므로 다시 만들지 않는다. 세일즈데스크 관리자 로그인 후 허브스팟 탭 [다시 확인] → [HubSpot 파이프라인 불러오기] → [매핑 저장] → [없는 속성 만들기] → [전체 가져오기]. 첫 결과(created/updated/conflicts/invalid/retry)를 원장에게 보고한다. 연락처가 많으면 한 번에 3페이지(300건)씩이라 [변경분 가져오기]를 "더 있음"이 사라질 때까지 반복한다. 가져온 리드의 단계가 비어 보이면 매핑(`settings.hubspot.map`)의 stageMap 이 빠진 단계다.
   - 2026-10-06 HubSpot은 Aside에서 로그인 완료. 세일즈데스크는 별도 관리자 로그인 화면이며 해당 사이트의 저장된 Vault 자격증명이 없어 원장 직접 로그인을 요청했다. 다른 사이트 비밀번호를 시도하거나 관리자 비밀번호를 재설정하지 않는다. 비밀번호·토큰을 채팅으로 받거나 파일·로그에 기록하지 않는다.
2. **파트너 기획서 §7 열린 질문 4가지**를 원장이 정하면 반영한다 — 나가는 소개의 전화 전달 방식 / 혜택 조건 구조화 여부 / HubSpot Company 매핑 / 포털 동의 문구(가정에 나가는 문구라 원장 확인 필수, 루트 규칙 7).
   - 이번 인수 확인에는 새 답변이 없어 정책·동의 문구를 변경하지 않았다.
3. 백로그(README·기획서 §8): 포털 Web Push, 조건 구조화·자동 정산표, HubSpot Company, 공개 신청 폼(절대 규칙 3 과 함께 따로 설계), 파트너가 많아지면 워커 분리(기획서 §6 기준).
4. **원장 추가 진행 요청(2026-10-06)**: 고객 화면 1차 개선은 PR #421. 다음 구현은 HubSpot 반영 결과 재조회/결과 미확정 처리 → CS 티켓·일반 작업 → 가족·구매 상품 → 3개월 관리·20만원 검사비 분납 순이다. 후속 기능은 아직 미구현이며, 외부 발송·파트너 정책·동의 문구를 이 화면 작업에서 바꾸지 않는다.
   - 원장 요청의 친구맺기·서포터즈·맘스쿨 관계관리는 구현했다. 센터앱 원본 연동 API는 확인되지 않아 담당자가 확인 기록을 남기는 방식이다. 자동 연동이 필요하면 정본 API·가족 식별을 먼저 정한다. 정책 전환·혜택 자동 제한·매출 반영을 추정하지 않는다.
   - **HubSpot을 자주 열지 않는 운영 요청(2026-10-06)**: 세일즈데스크를 일상 업무 화면으로 쓰는 방향을 제안했다. 현재는 수동 가져오기와 승인 큐 전송이며 완전 자동 양방향 동기화가 아니다. 자동 가져오기 확대 전에 실패 큐도 충돌로 보호하고 리드 저장에 CAS를 적용한다. 자동 전송 확대 전 작업 선점·큐 버전 확인·외부 결과 재확인으로 중복/경합을 막는다. 그 뒤 변경 알림/주기적 누락 점검과 상태 표시를 추가한다. n8n은 부가 자동화 후보이며 핵심 동기화의 필수 구성요소로 추가하지 않았다.

## 3. 고칠 때 깨지는 자리

- **`crm-core.js` 하나를 브라우저(app.js·partner.js 는 서버 응답만 씀)와 서버(crm-api·crm-shared·partner-api·hubspot.mjs)가 같이 읽는다.** 상수·검증 함수를 바꾸면 `node scripts/check.mjs --only crm` 전체를 돌린다. IIFE + `module.exports` 가드 형식을 지킨다(워커 번들은 esbuild 가 CJS 로 알아서 잇는다).
- **관계관리 저장**: `memberships`·`programActivities`·`programExams`·`gatherings`는 `expectedUpdatedAt` 숫자가 필수다(새 기록 0). D1 문장 안에서 버전·참조 원본·친구맺기 소검사 1회 한도를 함께 검사한다. 화면은 `saveRelationship`의 직접 저장·재조회 경로이며 기존 낙관적 큐로 바꾸지 않는다. ID는 PII 본문 검사 대상이 아니지만 참가자 메모·다음 행동은 검사한다. 관계 기록은 삭제하지 않고 상태를 바꾼다.
- **채널 목록 `CHANNELS`** 는 HubSpot `wb_source_channel` 선택지와 1:1 이다. 값을 더하면 `hubspot.mjs` `WB_PROPERTIES` 를 통해 [없는 속성 만들기]가 PATCH 로 선택지를 보강한다(기존 선택지·hidden 은 보존). 값을 빼거나 이름을 바꾸면 기존 리드·HubSpot 양쪽이 어긋난다.
- **단계 키**(`STAGES`·`STAGE_LABEL`·`STAGE_ALIASES`)를 바꾸면 저장된 매핑(`settings.hubspot.map[pipeline].stageMap`)과 리드의 `stage` 가 어긋난다. 라벨만 바꾸는 것은 안전하지만 자동 매핑은 HubSpot 단계 라벨과의 일치로 돈다.
- **반영 큐 규칙은 `crm-shared.mjs` `enqueueFor` 한 곳**: 종류별 한 줄(딜은 파이프라인별), 승인된 검토 줄의 단계가 바뀌면 `pending`, 다른 파이프라인의 열린 딜 줄은 반려, 새 줄의 `created_at` 은 그 리드의 기존 줄보다 크게(`tick`), 큐 UPDATE 는 `updated_at=MAX(?,created_at)`. 여기를 건드리면 `crm-api.test.mjs` 6·7·8·11·12 가 지켜본다.
- **PII 규칙 정본은 `crm-core.js`**(`PII_PATTERNS`·`findPii`). 서버는 `LEAD_PII_SKIP`(phone·email·hubspot·creditBalanceHs)을 건너뛴다. 새 id 필드를 리드에 더하면 숫자열이 오탐될 수 있다 — skip 에 넣거나 영문이 섞인 슬러그를 쓴다. 화면도 저장 전에 같은 검사로 막는다(막지 않으면 거절된 저장이 "리드가 사라진 것"처럼 보인다).
- **서버가 가진 필드**: `leads.hubspot`·`creditBalanceHs` 는 클라이언트 값을 버리고 이전 값을 잇는다(`ruleLeads`). push 는 `patchDocFields` 로 그 필드만 CAS 갱신한다 — 문서 전체를 `writeDocRaw` 로 되쓰면 직원 편집을 덮는다.
- **파트너 경계**: 파트너 토큰은 `/api/partner/*` 에서만 통한다(`crm-api.mjs` 라우터 맨 앞에서 `handlePartnerApi` 로 넘김). 포털 응답에 전화·이메일·메모·내부 단계를 싣지 않는다(`inboundView`·`outboundView`). 파트너 표는 `crm_partner_*`, 문서는 `partners`·`referrals` — 나중에 워커를 떼어낼 단위.
- **응답 계약**: `/api/docs` → `{docs, now}` · `/api/hubspot/queue` → `{items, counts}` · `/api/hubspot/status` → `{connected, reason, portal, queue, pull, map}` · `/api/hubspot/pull` → `{created, updated, conflicts, invalid, deleted, seen, total, more, retry, cursor}` · `/api/partner/referrals` → `{inbound, outbound}`. 바꾸면 app.js·partner.js 를 같이 맞춘다.
- **빌드 스탬프**: `index.html`·`partner/index.html` 의 `./…?v=dev`·`../…?v=dev` 만 해시로 바뀐다. 새 정적 파일을 더하면 `?v=dev` 로 참조하고 `build.mjs` 의 복사 목록(app/·partner/·crm-core.js)에 들어가는지 본다. `dev-server.mjs` 의 `APP_FILES` 도.
- **마이그레이션**은 전부 `IF NOT EXISTS`, 새 파일은 `003_….sql` 부터. 배포 워크플로우가 매번 전부 다시 적용한다. 컬렉션 허용 목록은 표가 아니라 `crm-api.mjs` `COLLECTIONS`(= `CORE.COLLECTIONS` − staff).
- **시크릿**: HubSpot 토큰은 `HUBSPOT_ACCESS_TOKEN` 워커 시크릿뿐. 응답·로그·문서·테스트에 토큰을 넣지 않는다(테스트는 `env.HUBSPOT_FETCH` 가짜 fetch + `pat-test`).
- **시간**: 서버는 UTC 로 돌지만 기본 날짜는 `kstToday()`(한국 시간). 화면은 기기 시간. 날짜는 전부 `YYYY-MM-DD` 문자열.

## 4. 가장 잦은 작업

- **HubSpot 단계·속성이 바뀌었다** → 허브스팟 탭 [HubSpot 파이프라인 불러오기] → 매핑 손보기 → [매핑 저장]. 코드 수정 없음.
- **팔로업 간격·조직 이름** → 관리 탭 설정. `settings.followupOffsets`.
- **큐가 실패로 쌓인다** → 실패 사유를 본다: `UNMAPPED`(매핑 저장) · `LINKED`(같은 전화의 연락처가 다른 리드에 연결됨 — 리드를 합치거나 전화 수정) · 429(기다렸다 [다시 시도]) · 401(`HUBSPOT_AUTH`, 토큰 교체 → 워크플로우 재실행).
- **문의 원문에 전화번호가 섞여 저장이 막힌다** → 전화 칸에만 적는 규칙이다(의도). 메모·기록도 같다.

## 5. 테스트 지도

- `crm-core.test.cjs` — 단계·채널/HOT 감지·재검사·팔로업·초안·검증·크레딧·자동 매핑·오늘 보드·KPI·검색·병합·라우트·파트너·PII.
- `hubspot.test.mjs` — 가짜 fetch 로 요청 모양(검색 그룹·속성 생성/PATCH·딜·노트·배치 읽기)·변환(리드↔연락처·딜 적용).
- `app-modal.test.cjs`·`app-relationships.test.cjs` — 모달 입력·키보드 초점·관계 기록 저장/재조회·불확정 결과/충돌 복구·HubSpot ID와 본문 PII 구분.
- `crm-api.test.mjs` — node:sqlite 대역 + 가짜 HubSpot: 인증·문서 규칙·큐·push·pull·파트너 포털·내보내기. 시간 의존 로직이 있어 고친 뒤엔 여러 번 돌려 본다(`for i in $(seq 1 5); do node crm/crm-api.test.mjs | grep '^# fail'; done`).
