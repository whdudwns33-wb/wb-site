# haru/ — 삼육중 및 영재원 대비 작업 인수인계 (Codex · Claude Code 공용)

호남삼육중 입학시험 대비 3년(초4~초6) 학습 앱. 학생은 오늘 카드 한 장(`/haru/`), 부모는 읽기 전용 링크(`parent.html?t=`),
강사·원장은 관리 웹(`/admin/haru-admin.html`). 영재원 트랙(`gift`)은 기획만 있고 코드는 없다.
보호자·원장용 준비 정보는 별도 정적 안내(`/haru/guide.html`)에 있다. 영재원 정보 안내와 학습 트랙 구현은 구분한다.

**읽는 순서**: 저장소 루트 `AGENTS.md`(= `CLAUDE.md`) → `haru/README.md`(파일별 역할·첫 운영 절차) → 이 문서.
README 가 "무엇이 있나"라면 이 문서는 **"지금 어디까지 왔고, 다음에 뭘 하고, 무엇을 밟으면 조용히 깨지는가"**다.
기획 정본은 `docs/삼육중-대비-학습웹앱-기획서-v1.md`(§4 절대 원칙·§8 화면), 기술 명세는 `docs/삼육중-대비-앱-설계안-v1.md`,
전형 사실은 `docs/삼육중-전형-사실-정본-v1.md`만 인용한다.

---

## 1. 지금 상태 (2026-10-06 기준)

운영 중이다. 파일럿 학생이 매일 쓴다. 주소는 원내 전용.

- **#327**(P0): 학생 앱·부모 화면·관리 웹·`/api/haru/*` 서버·배포 배선.
- **원장 요청: 초4 4주 과정 검토**: `docs/초4-삼육중-영재원-4주-수업안-v0.md`에 두 선택 경로의 목표·자체 예시·시간·교사 관찰·가정 역할을 제안했다. 수업 운영·배정·기록 수집·T3 구현은 미확정이며 운영 코드·플랜을 바꾸지 않는다. 다음은 원장이 학교 진도·대체 시간·담당·자료/기록 조건을 검토하는 일이다.
- **#415**: 디자인 점검(Impeccable audit·polish 기준, 폰 390·태블릿 820·관리 1280, 라이트·다크) 상 6·중 19건 수정 —
  좌표 격자, 러너 결과 스크롤, 30초 반증 중복 문항 제외, OMR 고정 타이머·표시/넘김/빈칸·앱 안 제출 확인, 연결 화면 form,
  완료 표시 원자 id 키, 다크 모드 토큰, 대비·탭 대상 44px. 부모 마일스톤 '합격' 문구 제거, 상시 고지 3문장.
  영재원 기획서·사실 조사 v0(`docs/영재원-대비-기획서-v0.md`, `docs/광주전남-영재원-선발-사실-조사-v0.md`).
- **#420 T1 머지·운영 배포 완료**: 러너 전체 위치·반증 시간 막대·저장 표시·완료 버튼, 부모 상단·일정 문구, 관리 표시·좌표 격자·내보내기 잠금, 종이 SVG·지연 로딩 뼈대. `ui.test.cjs`로 표시와 기존 반증 전송을 확인한다. 운영 플랜 재업로드는 원장 작업으로 남아 있다.
- **원장 요청: 표시 이름·샘플 검토**: 표시 이름은 '삼육중 및 영재원 대비'. `/haru/?preview=1`에서 학생 홈·학습·좌표·답안지·회고, `/haru/parent.html?preview=1`에서 보호자 예시를 본다. `preview.js`의 자체 창작 자료만 메모리에서 사용한다. 경로·KV 키·인증은 그대로이며 영재원 MVP 승인은 별도로 필요하다.
- **원장 요청: 정보·과정 우선**: `guide.html`에 삼육중 지원 일정·준비 순서, 영재원 기관별 자격·절차, 초3~초6 WB 준비 제안, 역할·공식 출처를 추가했다. 로그인·API·저장소가 없는 읽기 안내다. T3 학습 MVP·수업 운영 결정 D-1~D-8 승인을 대신하지 않는다.

**시기 제약 — 시험 2026-10-25(일).** 그때까지 흐름·채점·데이터 계약·API 응답 모양을 바꾸지 않는다(시각·문구·접근성만).
10/25 뒤에는 회고 창이 돈다(시험일 12:00 잠금 → 발표일 침묵 → 시험일+7일 16:00 숫자 개방, `plan.js`).

### 사람만 할 수 있는 일 — 에이전트는 하지 말고 알리기만
- 운영 KV 코호트 플랜 재업로드: 관리 웹 [팩·대응표·플랜] → 「코호트 플랜」에 `haru/plans/2027-pilot.json`.
  저장소 플랜을 고쳐도 이걸 하기 전엔 운영 화면이 안 바뀐다(#415 의 '결과 발표' 문구·고지도 이 대기 중).
- 영재원 기획서 §12 결정 D-1~D-8(트랙 형태·광고 문구·웩슬러 연계·MVP 착수 시점 등).
- 삼육중 정본 후보 체크(`docs/삼육중-정보수집-로그.md`의 `[ ]` — 원장이 `[x]` 해야 정본이 바뀐다. 체크 전 후보를 다른 문서에 옮기지 않는다).
- 월요일 09:00(KST) 삼육중 주간 정보 스윕은 Claude 루틴이 돌린다 — 중복 실행하지 않는다.

## 2. 다음 할 일 (우선순위 순, 작업 하나 = PR 하나)

### T1. 디자인 잔여 항목 (#420 머지·배포 완료 — 아래는 확인 항목)
1. 러너 머리줄: 슬롯 안 순번('처음 보는 칸 · 1/3')만 보인다 → '카드 1/3 · 문항 2/3'처럼 전체 위치도. 진행 막대는 모든 러너 화면에.
2. 30초 반증 카운트다운이 작은 회색 글자 안에 있다 → 숫자 1.25rem 이상 + 남은 시간 막대(0이면 '모름' 처리됨을 알 수 있게).
3. 헤더 저장 상태('저장 전'·'첫 시작'·'동기화됨')가 로그인 전에도 보인다 → 로그인 전엔 숨기고 학생에게는 '저장됨'/'저장 못 함' 둘만.
4. 완료 화면: '앉은 날 1' → '1일', 주 버튼 [홈으로]를 [오늘 더 할래] 위로.
5. 부모 화면: 상단 '하루브레인 · 보호자용' 띠. 어른 일정의 중복 시각('10/25 08:30 — 08:30까지 …', '11/02 — 입학 등록 2026-11-02 ~ …') 정리 —
   문구 원천은 `plan-build.mjs` `milestonesFromFacts`. 고치면 플랜을 다시 빌드한다(§4 명령) — 운영 반영은 재업로드 필요라고 PR 에 적는다.
6. 관리 화면 일관성: 글꼴 스택을 학생 화면과 같게, 원값(`paper`·`confirmed`) → '종이'·'확정', 내보내기 버튼은 숫자 개방 전 `disabled` + '11/1 16:00 이후',
   강사 좌표 칩을 격자로.
7. (낮음) 학생 화면 이모지(📄) → 인라인 SVG. (낮음) 0.5초 넘는 로딩에 카드 뼈대.
- **손대지 않는다(원장 결정 사항)**: 좌표 칸 관측 문구 '관측 n번 중 m번 맞았어요 · …'(`strings.js` `progressLine`, 테스트 고정), 학생 화면 말투(반말/해요체) 통일.

### T2. 부모 화면의 시험일 의존 제거 (10/26 이후)
`parent.html`은 서버가 시험일을 주지 않아 마일스톤 '고사장 입실' 문구로 D-7 취침 강조 기간을 판정한다.
`GET /api/haru/parent`의 `parent`에 `examDate`(또는 `bedRamp`)를 더해 그 값을 쓰게 바꾼다. `haru-api.test.mjs`에 테스트.
워커·로컬 서버가 같은 `handleHaru`를 쓰므로 한 곳만 고치면 되지만, 두 호스트 배선이 같은지 확인한다.

### T3. 영재원 트랙 MVP — **원장 승인(D-2·D-8) 전에는 코드를 쓰지 않는다**
승인 뒤 `docs/영재원-대비-기획서-v0.md` §4·§5·§8·§9 P2: 플랜 `track:'gift'`, `atoms.json`에 `subject:'gift'` 원자 25(M 갈래는
`m-counting`·`m-logic`·`m-pattern-inverse` 재사용), 닫힌 생성기 4종(`gen.js` 계약), 「생각 노트」 화면, 부모 마일스톤.
`atoms-check.js`의 코어 규칙(국6·수6·영4)은 삼육중 트랙에만 걸리게 좁힌다. 영재원 금지(대필·GED 대리 지원·KEDI 샘플 복제·변형·
"영재원 대비반"·선행 광고)는 기획서 §3.

## 3. 고칠 때 조용히 깨지는 자리

**서버·데이터**
- `GET /api/haru/pack`·`/gen`은 정답·해설·오답 태그를 뺀다. 정답은 `POST /answer` 응답에만. 생성기 문항은 서버가 seed 로 만들고
  같은 seed 로 다시 만들어 채점한다(gid `g:<atomId>:<seed>`) — 기기에 정답을 내려보내는 순간 이 앱의 성립 조건이 깨진다.
- 학생 기록은 쓰는 쪽에 따라 3키: `haru:state`(학생 PUT) · `haru:mock`·`haru:paper`(서버만). `PUT /state`에 `mocks` 키가 오면 400.
  학생 `GET /state`는 `mocks`의 `pct`를 뺀다. `PUT /state`는 하루 3번(`PUTS_PER_DAY`), 넘으면 429 → 화면은 '오늘 저장 상한'.
- `day.done`은 **원자 id 키**다(옛 숫자 키는 무시). 슬롯 순번으로 되돌리면 [오늘 더 할래]의 새 슬롯이 완료로 그려진다.
- 30초 반증은 그 칸에서 정답을 이미 보여 준 문항을 뺀다(`fetchItems(slot, n, exclude)`). 빼지 않으면 원인이 '문제 오독'(`cause.js` misread)으로 잘못 남는다.
- `/attempt`는 `{accepted, at}`만 돌려준다(채점 결과는 다음 날). `kind:'full'`인데 3교시 미만이면 409. 동결 세트 재응시는 `retake:true`로 분포에서 뺀다.
- 분포는 n<30 이면 보이지 않는다. 주간 익명 집계는 10명 미만 주·5 미만 칸을 버린다. 크론 `'10 18 * * *'` → `weeklyAgg`(`worker.mjs` `scheduled()`).
- 퇴원·파기는 4계열(state·mock·paper·parent)을 지우고 원장의 `haru:paperkey:*`는 남긴다(`student-lifecycle.test.mjs` ⑥-5).
- `apps:['haru']` 학생은 `allowedApp` 게이트로 다른 앱을 못 연다. `/api/token/refresh`는 게이트에서 null(허용) — 막으면 토큰 갱신이 죽는다.
- 게이트 순서: 동의 → 만료(회고 경로는 통과) → 팩 배정.

**플랜·문구**
- `haru/plans/2027-pilot.json`은 **빌더 산출물과 같아야 한다**(`plan-build.test.mjs`) — 손으로 고치지 말고 다시 빌드한다.
- 부모에게 가는 마일스톤·고지는 부모 금지어 검사를 통과해야 한다(같은 테스트). 원천은 `plan-build.mjs`·`facts.json`.
- 마일스톤 '고사장 입실'은 시험일에 하나뿐이어야 한다 — `parent.html`이 그걸로 시험일을 읽는다(T2 전까지).
- 상시 고지는 `facts.json` `notice` 3문장, 주소는 `school.url` 호스트(`facts.test.cjs`).
- 학생·부모 화면 문구는 `strings.js` `findForbidden(text,'student'|'parent')`를 통과해야 한다. 합격 확률·등수·경쟁률·연속 학습일·
  아이 푸시·미수행 독촉·웩슬러 동선 금지(기획서 §4).

**화면**
- 학생(`index.html`)과 부모(`parent.html`)는 **같은 색 토큰 이름·값**을 쓴다: `--accent`(글자용 초록) · `--btn`(버튼 바탕) ·
  `--edge`(조작 요소 테두리, 비텍스트 3:1) · `--line`(장식 구분선) + `prefers-color-scheme: dark` 한 벌. 다크에서 글자 초록은 밝고 버튼 바탕은
  어두워야 해서 `--accent`/`--btn`을 나눴다 — 하나로 합치면 다크 대비가 깨진다. 새 색은 토큰으로만, 두 파일을 함께.
- 글자 크기는 rem/em(기기 글자 설정을 따른다). 태블릿(≥700px)은 18px 기준.
- 좌표 격자는 `minmax(0,1fr)` + `.cell{min-width:0}` — `1fr`로 되돌리면 `keep-all` 긴 라벨이 열을 부풀린다.
- 러너 결과는 `render(html, true)`(스크롤 유지) + 결과 상자 `scrollIntoView` — 새 문항만 맨 위로.
- 학생 코드 입력은 `autocapitalize="none"`이고 코드를 소문자로 바꾸지 않는다(서버 정확 일치).
- SW `VERSION`(`wbh-shell-dev`)은 손으로 바꾸지 않는다 — `reading-server/build-dist.mjs`가 내용 해시로 스탬프한다.
- 샘플은 명시적인 `preview=1`일 때만 사용한다. 실제 토큰이 있어도 샘플이 먼저이며, `wbr.auth`·`wbh.state`·`wbh.omr`를 읽거나 쓰거나 지우지 않는다. 지원하지 않는 샘플 경로·모듈 실패에서 운영 API로 돌아가지 않는다. 샘플 화면은 SW 등록도 하지 않는다.
- `preview.js`는 자체 창작 공개 예시만 가진다. 운영 팩·정답·대응표·학생 기록을 옮기지 않는다. SW 셸과 `build-dist.mjs` 해시 입력에 같이 등록해 샘플 수정도 새 배포에서 갱신한다.
- 배포되는 `_headers`는 `reading/_headers` 하나(`/haru/*` no-store). `haru/_headers`는 안내 주석 파일.
- `guide.html`은 읽기 문서만 유지한다. 삼육중 사실은 기존 정본·facts.json, 영재원 사실은 공식 조사 문서·기관별 공고를 대조한다. 미래 날짜·미확인 항목을 확정하지 않고, WB 로드맵을 실제 제공 중인 기능이나 기관의 공식 교육과정으로 표현하지 않는다. 날짜를 고치면 `guide.test.cjs`도 정본과 일치하는지 확인한다.
- 전형 안내는 오프라인 셸에 넣지 않는다. `reading/sw.js`(루트 범위)와 `haru/sw.js` 모두 `/haru/guide`·`guide.html`만 처리에서 제외한다. 이 경계가 빠지면 방문한 안내가 학생 홈 캐시를 덮거나 오프라인에서 다른 화면으로 대체된다.

## 4. 명령

```
node scripts/check.mjs --only haru                                   # 하루브레인 몫만 (고친 뒤 먼저)
node scripts/check.mjs                                               # 저장소 전체 — PR 전에 반드시
for f in haru/*.test.cjs haru/*.test.mjs; do node $f; done           # 순수 로직·달력·조판기
node reading-server/haru-score.test.mjs && node reading-server/haru-api.test.mjs
node reading-server/student-lifecycle.test.mjs                       # 등록→승인→기록→퇴원(⑥-5 하루브레인)
node haru/plan-build.mjs haru/plans/2027-pilot.input.json haru/plans/2027-pilot.json   # 플랜 다시 빌드
node haru/sheet-build.mjs <팩.json> <출력 디렉터리> --frozen --key-id <id>              # 종이 회차 (저장소 밖에서)
```

화면을 바꿨으면 로컬 서버로 직접 본다:
1. `PORT=8931 ADMIN_PIN=<임의> DATA_DIR=<임시폴더> node reading-server/server.mjs`
2. `POST /api/admin/login {pin}` → `POST /api/haru/admin/plan {cohort:'2027-pilot', plan}` → `POST /api/haru/admin/pack {pack: haru/pack-sample.json}`
   → `POST /api/haru/admin/enroll {code,name,grade,cohort:'2027-pilot',consent:{at,via:'paper'}}`(동의일 필수)
3. `POST /api/login {code}` → `POST /api/admin/pending {nonce, action:'approve'}` → `GET /api/login/status?n=` 로 학생 토큰
4. 브라우저 localStorage `wbr.auth` = `{token, code, name}` (관리 웹은 `wbr.admin.token`), 부모는 `POST /api/haru/admin/parentlink` 의 `ptoken`
5. 폰 390×844·태블릿 820×1180, 라이트·다크. 렌더된 `document.body.innerText`에 `WBHARU_S.findForbidden(…,'student'|'parent')`가 `[]`인지.
6. 대비: 글자 4.5:1, 조작 요소 테두리 3:1(다크 포함).

PR 은 작업 브랜치 → PR → `checks.yml` 초록 → 스쿼시 머지(제목 끝 `(#번호)`). main 푸시 = 운영 배포. 머지는 원장 승인 뒤.
