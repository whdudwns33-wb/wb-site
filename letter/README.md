# letter/ — 브레인레터 (주간 뉴스레터) 코드 디렉터리

기획은 `docs/브레인레터-주간뉴스레터-기획서-v1.md` 가 정본이다. 여기 있는 것은 학생·가족 화면, 순수 로직(검증기·렌더러), 그리고
**커밋해도 되는 유일한 콘텐츠(자체 창작 체험 호 `issue-sample.json`)** 뿐이다. 실제 호(issue)는 KV(관리 웹에서 저장)에만 산다.
서버 쪽은 `reading-server/letter-api.mjs`, 관리 웹은 `reading-server/public/letter-admin.html`.

**무엇인가**: 유치(5~7세)부터 중학생까지 다섯 학년대에 **매주 한 호**를 보낸다. 한 호는 같은 주제를 학년대별로 다른 깊이로 읽는
읽을거리 + 독해 문제, 한자어 낱말 가족, **웩슬러(K-WISC-V) 다섯 지표와 연결된 두뇌 놀이**, 부모용 입시 문해력 칼럼, 부모 코칭,
학원 소식, 이번 주 미션으로 되어 있다. 기본은 앱(가족 링크·학생 토큰)이고, 원하는 가정은 화면의 [PDF로 저장]으로 인쇄본을 받는다.

**화면은 신문 한 면**이다 — 제호(브레인레터) → 발행선(제n호·날짜·○○판) → 1면 머리기사(이번 주 주제·표지 사진) → 본기사(읽을거리·낱말 노트·읽고 답해요)와
옆단(한자 코너·두뇌 놀이터·이번 주 미션) → 학부모면(칼럼·한 줄 코칭·학원 게시판). 좁은 화면은 한 줄, 넓은 화면과 A4 인쇄는 2단이다.
사진은 자체 촬영·제작·공공누리·CC0 만 싣고 출처(credit)가 없으면 저장되지 않는다. 시공간 두뇌 놀이는 `shapes.js` 가 도형을 그린다.

## 파일

| 파일 | 무엇 |
|---|---|
| `index.html` | 학생·가족 앱. 모드 4개 — **가족 링크**(`/letter/?t=<ptoken>`, 로그인 없음, 기록은 기기에만) · **학생**(`wbr.auth` 토큰, 기록을 서버에 저장) · **관리 미리보기**(`?id=&tier=` + 관리 토큰, 초안도 봄, `tier=all`·`print=1`/`print=nokey`) · **체험**(아무것도 없으면 `issue-sample.json`). 문제 풀기(즉시 해설)·정답 보기·미션 체크·[다 읽었어요]·지난 호·[PDF로 저장](정답 별지 포함 / 정답 없이) |
| `letter.js` | 순수 로직 `WBLETTER` — 학년대 판정(`tierOf`: 명부 grade → K·E1·E2·E3·M, 원장 지정 `letterTier` 우선, 못 읽으면 진로독서 level 로 어림), KST ISO 주차(`weekId`·`weekStart`·`nextWeek`), **검증기 `checkIssue`**(관리 웹·AI 초안·서버 저장이 같은 규칙 — 사진 출처·도형 정답 일치까지), 학년대 선택 `forTier`, 가시성 `isVisible`, **렌더러 `renderIssue`**(신문 짜임, 학생 앱·관리 미리보기·인쇄가 같은 HTML), 공용 CSS(`CSS`, 2단·인쇄 규칙 포함), 빈 템플릿 `blankIssue`, **지표 순환 `rotationFor`·주제 달력 `calendarEntry`·`checkCalendar`** |
| `shapes.js` · `shapes.test.cjs` | **시공간(VSI) 두뇌 놀이 생성기** `WBSHAPES` — 다른 하나 찾기·돌리면 어느 것·거울에 비치면·쌓기나무 세기·빈 조각 찾기. `{kind, seed}` 로 결정적으로 SVG 를 그리고 정답을 정한다(호 JSON 에는 seed 만, 그림 문자열은 저장하지 않는다). 키랄 폴리오미노만 써서 거울 문제가 성립한다 |
| `drills.js` · `drills.test.cjs` | **5분 두뇌 놀이 생성기** `WBDRILLS` — 시공간 밖 네 지표: 거꾸로 말하기(WMI)·기호 찾기(PSI)·수열의 빈 칸(FRI)·공통점 말하기·무리에 안 드는 낱말(VCI, 자체 낱말 은행). 두뇌 놀이 항목에 `{drill:{kind,seed}}` 로 싣고, **오늘의 5분**(`daily(week,tier,day)`)이 1~6일째 매일 같은 자리에 한 문제씩 놓인다 — 사람이 매주 35문제를 짓지 않아도 매일 새 문제 |
| `calendar.json` | **주제 달력 기본값** — 2026-W40 부터 40주의 주제·메모(자체 작성). 관리 웹 [주제 달력]에서 고치면 KV(`letter:calendar`)가 이것을 통째로 대신한다. 두뇌 놀이 지표는 순환값(라틴 방진)이 기본, 주마다 `indices` 로 덮어쓴다 |
| `img/*.svg` | 배포본 삽화(자체 제작 벡터 그림 4점) — 호에서 `image: {file: "leaf-autumn.svg", …}` 로 쓴다. 올린 사진은 여기 없다(KV) |
| `fonts/` · `fetch-fonts.mjs` · `fetch-fonts.test.mjs` | **글꼴** — Noto Sans KR·Noto Serif KR(가변 굵기)을 Google Fonts 와 같은 유니코드 구간 조각(각 124개 woff2, 합 9.5MB)으로 받아 둔 것. SIL OFL 1.1(전문 `fonts/OFL.txt`). `fonts.css` 의 unicode-range 로 브라우저는 지면에 쓰인 글자의 조각만 받는다(한 호에 30여 조각). 앱은 CSP(`default-src 'self'`) 때문에 외부 글꼴을 못 부르므로 같은 오리진에 둔다. 다시 받기 `node letter/fetch-fonts.mjs` — 판이 바뀌면 디렉터리 이름(`sans-v39/`)도 바뀌어 캐시가 저절로 갈린다. 워커는 `/letter/fonts/*.woff2` 를 1년 불변 캐시로 낸다(`_headers` 의 `/letter/*` no-store 를 덮어쓰려고 `wrangler.toml` run_worker_first 에 올려 두었다) |
| `voice.js` · `trace.js` (배포본·로컬 서버에만) | 읽어 주기(`shared/voice.js`)와 한자 따라쓰기 판정(`vocab/trace.js`) — 원본은 각각 하나, build-dist 가 letter/ 에 복사한다 |
| `issue-sample.json` | 2026-W39 「가을 잎의 비밀」 — 다섯 학년대 전부 갖춘 자체 창작 체험 호. 테스트 픽스처 겸 미연동 데모 겸 AI 초안의 형식 예시 |
| `letter.test.cjs` | `node letter/letter.test.cjs` — 학년대·주차·검증기(반례)·선택·렌더러 이스케이프·인쇄 별지·샘플 오류 0 |
| `sw.js` · `manifest.webmanifest` · `icon.svg` | 껍데기 캐시(VERSION 은 build-dist 가 스탬프). `/api/*`·`*.json` 은 캐시하지 않는다. 글꼴 조각은 별도 캐시 `wbl-fonts` 에 캐시 먼저(껍데기가 갈려도 남는다), `fonts.css` 는 네트워크 먼저. **새 호 도착 푸시**(페이로드 없음)를 받아 알림을 띄우고, 누르면 가족 링크(Cache API `wbl-meta/famlink`)나 `/letter/` 를 연다 |
| `_headers` | 안내 주석만 — 배포 규칙은 `reading/_headers` 의 `/letter/*` no-store |
| `../reading-server/letter-api.mjs` | `/api/letter/*` — 가족(`parent?t=`·`parent/push/*`) · 사진(`img/<id>`, 무인증·불변 캐시) · 학생(`issues`·`issue?id=`·`state` GET/PUT·`push/*`) · 관리(`admin/issues`·`admin/issue` GET/PUT/DELETE·`admin/publish`(즉시 발행이면 알림)·`admin/push`(다시 보내기)·`admin/push/status`·`admin/students`·`admin/tier`·`admin/messages?id=`·`admin/stats?id=`·`admin/draft`(달력 프리필)·`admin/imgs`·`admin/img` POST/DELETE·`admin/calendar` GET/PUT). `sendLetterPushes`·`pushDueIssues`(07:00 크론)·`dumpLetter`(백업)·`dropStudentLetter`(퇴원, 구독도 삭제) |
| `../reading-server/letter-api.test.mjs` | `node reading-server/letter-api.test.mjs` — 메모리 어댑터·가짜 fetch 로 전 라우트 |
| `../reading-server/public/letter-admin.html` | 관리 — 호 목록(발행/내리기·알림 다시 보내기·미리보기·인쇄 링크·삭제, 다음 주 달력 주제) · 편집(JSON + 머리 정보 폼 + 검증 + 학년대별 미리보기 + 사진·도형 스니펫 도우미) · AI 초안(6조각, 달력 프리필, VSI 조각은 생성기 seed 로 채움) · 주제 달력(44주 표 편집) · 사진(브라우저에서 1600px JPEG 로 줄여 올리기, 목록·삭제) · 발송 문구(가족 링크 자동 발급) · 열람 현황 · 학생 학년대 지정 |

## 학년대·웩슬러 지표

| 학년대 | 대상 | 읽을거리 길이(공백 포함) | 문제 |
|---|---|---|---|
| `K` | 유치 5~7세 (부모가 읽어 주는 글, `readAloud`) | 50~300자 | 3문제 · 보기 2~3 |
| `E1` | 초1~2 | 160~480자 | 3문제 · 보기 3 |
| `E2` | 초3~4 | 380~820자 | 4문제 · 보기 4 |
| `E3` | 초5~6 | 560~1150자 | 4~5문제 · 보기 4 |
| `M` | 중1~3 (고등은 중등 것을 받는다) | 800~1600자, 수능 비문학형 구조 | 5문제 · 보기 5 |

두뇌 놀이(`brain`)는 반드시 K-WISC-V 기본 지표 하나를 겨냥한다 — `VCI` 언어이해 · `VSI` 시공간 · `FRI` 유동추론 · `WMI` 작업기억 ·
`PSI` 처리속도. **검사 문항을 복제하지 않는다**(검사 타당도를 해친다). 같은 인지 기능을 쓰는 다른 놀이다.
**지표 순환**은 `rotationFor(week)` 가 정한다 — 같은 주에 다섯 학년대가 서로 다른 지표, 5주에 학년대마다 다섯 지표가 한 번씩(기준 39호: K 처리속도·E1 시공간·E2 작업기억·E3 유동추론·M 언어이해). 주제 달력의 `indices` 로 주마다 덮어쓴다.
시공간(VSI) 차례인 학년대의 놀이는 `shapes.js` 도형이다: `items: [{ figure: { kind: "mirror", seed: 8 } }]` — prompt·answer 를 비우면 생성기 것이 쓰이고, answer 를 적으면 생성기 답과 같아야 저장된다.

## 호(issue) 스키마 — 검증기 `checkIssue` 가 정본

```
{ id: "2026-W39"(YYYY-Www[-접미]), week: "2026-W39", publishAt: "YYYY-MM-DD", status: "draft"|"published",
  title(≤80), theme(≤120), intro(≤800), source(필수 — 자체 창작 표시), cover?: 사진, sections: [ … ] }
사진 = { id: <올린 사진 32자 hex> | file: <배포본 삽화 파일명>, alt(필수 ≤120), caption?(≤200), credit(필수 ≤80 — 출처·저작 표시), w?·h?(한 쌍 — 있으면 사진이 오기 전에 자리를 잡는다) }
section 공통: { id: [a-z0-9-]{2,30} 유일, type, tiers: "all" | ["K","E1",…], title(≤80), image?: 사진(미션 제외), images?: [사진×3](읽을거리·칼럼·게시판) }
  read      { readAloud?, minutes?, lead?, paragraphs:[…], vocab:[{word(본문에 있어야), easy, hanja?}], questions:[{q, choices:2~5, answer:0부터, why?, skill?: main|detail|infer|vocab|apply|critical}] }
  words     { family?:{hanja,hun,eum}, words:[{word, meaning, hanja?, example?}] 1~10, task? }
  brain     { index: VCI|VSI|FRI|WMI|PSI, minutes?, howTo?, items:[{prompt, answer(필수), hint?, grid?:[줄…]} | {figure:{kind: odd|rotate|mirror|blocks|complete, seed:1~999999}, prompt?, answer?}] 1~10, parentTip? }
  column    { byline?, paragraphs:[…], takeaway? }      coach { tips:[…] 1~6 }      notice { items:[…] 1~10 }      checklist { items:[…] 1~8 }
  news      { items:[{title(≤80), summary(≤400), why?(≤200 — 우리 아이에게 뜻하는 것), source(필수 ≤60 — 기관·언론명), url?(https 만), date?(YYYY-MM-DD)}] 1~6 }   ← 학원 소식(notice) 대신 그 주의 교육·입시 이슈. 앱에서만 링크가 열리고 인쇄본엔 출처명만
  poem      { author?(≤40 — 자체 창작만), lines:[…] 1~24, task? }        talk { items:[…] 1~5 (가족 대화 카드) }
  write     { prompts:[{q(≤200), hint?}] 1~4 }  — 앱은 textarea(300자, state.write[섹션:번호]), 인쇄는 쓸 줄. 7일째 되돌아보기에 '내가 쓴 문장'으로 다시 나온다
  books     { items:[{title, author?, why(필수), for?}] 1~4 }      voices { items:[{who(≤20 — 이름은 줄여서), text(≤300)}] 1~8 }  — 원장이 [열람 현황]의 '아이들이 쓴 문장'에서 고른다
  brain.items 에 { drill:{kind: span|symbols|sequence|common|odd-word, seed} } — 도형(figure)과 같은 규칙(답은 생성기, answer 를 적으면 같아야 함, 지표와 다르면 경고)
  section.day?(1~7) — 하루 한 장에서 열리는 날을 지정(쓰기는 2일째가 기본, day:6 이면 미션 날에)
```
오류(저장 불가): 형식·범위 위반, 정답 번호가 보기 밖, 섹션 id 중복, 모르는 학년대·지표, 400KB 초과, 출처 없음, 사진에 alt·credit 없음, 도형 answer 가 생성기와 다름.
경고(저장 가능): 글자 수 권장 범위 밖, 낱말이 본문에 없음, 어느 학년대에 읽을거리·두뇌 놀이가 없음.

학생에게는 `forTier` 로 자기 학년대 섹션(`tiers` 에 포함 또는 `"all"`)만 내려간다. 정답·해설은 뉴스레터의 일부라 함께 내려간다(가정 학습지다 — 하루브레인과 다르다).

## 주간 운영 절차(원장)

0. (한 학기에 한 번) [주제 달력] — 주차마다 주제 한 줄·메모를 적어 둔다. 배포본에 40주 기본값이 있고, 두뇌 놀이 지표는 순환값이 채워진다.
1. `/admin/letter-admin.html` → [호 목록] → 다음 주 주제(달력)를 확인 → **[AI 초안 만들기]**(`ANTHROPIC_API_KEY` 가 있을 때. 주제·지표가 달력에서 채워진다. 공통 + 학년대 5 + 교육·입시 이슈 = 7조각을 차례로 받아 한 호로 조립. 시공간 조각은 생성기 seed 로 채우고, 이슈 조각만 웹 검색 도구를 켜 그 주 소식을 간추린다) 또는 [빈 템플릿] / [샘플 호 복제].
   사진은 [사진] 탭에서 올린다(자체 촬영·제작·공공누리·CC0 만, 학생 얼굴은 동의가 있는 것만). 편집기의 [사진 넣기]·[도형 놀이 넣기]가 붙여 넣을 스니펫을 준다.
2. [편집] — 머리 정보 폼 + JSON. [검증] 으로 오류 0 을 만들고 오른쪽 미리보기(학년대별)로 읽어 본다. **모든 글은 자체 창작**이어야 한다(교재·기사·시험 문제를 옮기지 않는다). [저장] 은 발행 상태를 바꾸지 않는다.
3. [호 목록] → [발행](발행일 지정, 월요일 아침이 기본). 발행일 전에는 학생·가족에게 보이지 않는다. [내리기] 로 언제든 초안으로.
   **새 호 알림**: 지금 보이는 호를 처음 발행하면 그 자리에서 구독 가정(학생 기기·가족 링크)에 푸시가 나가고, 발행일이 미래면 그날 07:00 KST 크론이 보낸다. 한 호에 한 번뿐이며 [알림 다시]로 재발송한다. VAPID 키(워드브레인과 공용)가 없으면 알림만 빠지고 나머지는 그대로다.
4. [발송 문구] → 학생마다 가족 링크가 든 문구(알림톡·문자용) → [전체 복사]. 링크가 없던 학생은 여기서 발급된다(진로독서 학부모 리포트와 같은 `parent:<t>` 토큰 — 가정마다 링크 하나). **동의서의 보호자 번호로만** 보낸다.
5. 종이로 받고 싶은 가정 → [호 목록]의 [인쇄·PDF] → 학년대별 또는 전체 학년대, 정답 별지 포함/없이 → 브라우저 인쇄 창에서 "PDF로 저장". 가정에서는 화면의 [PDF로 저장] 버튼이 같은 일을 한다.
6. 다음 주 [열람 현황] — 학년대별 열람·완독, **학생별 하루 한 장 진행(요일 7칸)**, 안 연 학생, 문항별 정답률. 가족 링크로 읽은 것도 `/api/letter/parent/state` 로 올라와 잡힌다.

## 인증·저장·비용

- 학생 라우트는 호스트의 `wbr.auth` 토큰 + apps 게이트(`appOfPath` → `'letter'`; 재원생은 전부, `apps` 배열이 있는 외부 학생은 `letter` 가 있어야).
- KV 키: `letter:issue:<id>` · `letter:issues`(id 목록) · `letter:state:<code>`(학생 기록 — 열람·문제·미션, 150KB, 하루 PUT 10회) · `letter:aiuse`(AI 초안 장부) · `letter:img:<id>`(사진 바이트 + 메타데이터, 1.5MB 이내 JPEG/PNG/WebP) · `letter:push:s:<code>` / `letter:push:f:<ptoken>`(알림 구독) · `letter:calendar`(주제 달력 저장본). 가족 링크는 `parent:<t>` 공용.
- 가족 링크 기록: `GET/PUT /api/letter/parent/state?t=` — 링크 토큰이 자격(읽기와 같다). 학생 코드 자리에 저장돼 앱 연동 학생과 같은 기록이고 하루 PUT 10회도 함께 센다. 서버가 화이트리스트(`days` 1~7 시각 · `trace` 섹션별 회차 포함)로 정규화한다.
- 사진은 `/api/letter/img/<id>` 로 누구나 받을 수 있다 — id 가 128비트 무작위라 그 자체가 열쇠다(가족 링크와 같은 방식). 학생 얼굴이 나오는 사진은 올리기 전에 보호자 동의를 확인한다. SVG 는 올리지 못한다(스크립트가 들어갈 수 있다).
- 백업(`fullDump`)에 호 본문·기록·달력·알림 구독이 담긴다(원장이 쓴 글이라 라이선스 원문이 아니다). 사진은 목록만 담긴다(바이트는 KV 에만). 퇴원 처리는 `letter:state:<code>` 와 그 학생·가족의 알림 구독을 지운다.
- AI 초안: `ANTHROPIC_API_KEY`(모델 기본 `claude-opus-5`, `LETTER_AI_MODEL` 로 변경), 하루 한도 `LETTER_AI_DAILY`(기본 30회 = 다섯 호). 키가 없으면 초안 버튼만 안내로 동작하고 나머지는 그대로 돈다.

전부 실행: `node letter/letter.test.cjs && node letter/shapes.test.cjs && node reading-server/letter-api.test.mjs`
로컬 서버: `PORT=8890 ADMIN_PIN=<pin> DATA_DIR=<dir> node reading-server/server.mjs` → `http://localhost:8890/letter/` · `/admin/letter-admin.html`

**아직 없는 것(다음 단계)**: 학생별 맞춤(진로독서 관심사·워드브레인 낱말과 연결, 검사 결과 기반 약한 지표 우선) · 지난 호 검색 · 이메일 발송(스티비) 연동 · 형제 가정 링크 하나로 묶기 · 유치·초저 읽어 주기 TTS(shared/voice.js).

## 하루 한 장 — 7일 리듬

한 호를 한자리에서 다 읽지 않는다. 발행일이 1일째이고 요일은 실제 날짜에서 센다(`dayOf`·`dayDate`·`DAY_PLAN`):

| 일째 | 장 | 무엇을 |
|---|---|---|
| 1 | 읽을거리 | 머리기사(표지·머리말) + 읽을거리 본문·낱말 노트(문제는 없다) + **시 한 편**(낭독·필사) + **가족 대화 카드** |
| 2 | 읽고 답해요 | 문제만(본문은 `<details>` 로 접혀 있다) + **한 문장 쓰기**(요약·질문 만들기·기자 되기) |
| 3 | 한자 코너 | 낱말 가족 + **손가락 따라쓰기** + **낱말 복습**(어제 읽은 글의 낱말 노트에서 저절로 만든 빈칸 문제) |
| 4 | 두뇌 놀이터 | 그 주 지표의 놀이 |
| 5 | 학부모의 밤 | 칼럼 + 교육·입시 이슈 + **책 한 권** + 한 줄 코칭 |
| 6 | 미션 점검 | 이번 주 미션(체크) + **지난 호 독자의 답** + 학원 게시판(있으면) |
| 7 | 되돌아보기 | 내 답 vs 정답(안 푼 문제는 정답을 감춘다)·맞힌 수·낱말 복습·마친 미션 + **내가 쓴 문장** + 다음 주 예고(주제 달력) |

1~6일째에는 **오늘의 5분**(`drills.js`)이 매일 맨 아래 같은 자리에 한 문제 놓인다 — 요일마다 지표가 돌아 한 주에 다섯 지표를 다 만난다. 이 구성은 어린이 신문·잡지의 고정 코너(매 호 같은 자리의 퍼즐·눈높이 사설·NIE·학생기자)와 신문 활용 교육에서 효과가 검증된 활동(요약·질문 만들기·어휘·필사·가족 토론)을 옮긴 것이다.

그 학년대에 그날 섹션이 없으면(유치부의 한자 코너) 읽을거리를 **다시 읽는 날**로 채운다. 잠그지는 않는다 — 7일 띠에서 어느 날이든 열 수 있고(지난 장 다시 열기가 곧 복습), 오늘 장은 진하게·마친 날은 ✓·아직 오지 않은 날은 옅게 보인다. [오늘 장 다 읽었어요]가 `state.days[n]` 에 남고 7일째 것은 호 완독(`doneAt`)이다. `?view=paper` 또는 [신문 전체로 보기]로 예전 신문 한 면도 본다. 인쇄(PDF)는 늘 신문 전체다. 앱 모드 옵션 `noQuiz`·`foldText`·`noTts`·`noTrace` 는 `renderDay` 가 장에 맞춰 넣는다(관리 미리보기는 `noTts`·`noTrace`).

## 패드에서 보는 사진 (앱 모드에만, 인쇄는 그대로)

- 표지는 16:10 으로 잘라 맞추고(`object-fit: cover`) 캡션·출처를 그림 위 그러데이션에 얹는다. 폰(≤639px)에서는 가장자리까지 펼친다(`main` 여백 16px 을 되돌린다).
- 사진은 `mix-blend-mode: multiply` 로 종이 바탕과 섞여 인쇄된 듯 보인다. 여러 장(`images`)은 폰에서 옆으로 넘기는 스냅 갤러리, 패드에서 2열.
- 누르면 **돋보기**(전체 화면, 손가락 두 개로 더 키움, ESC·탭으로 닫기). `w`·`h` 가 있으면 `width/height`+`aspect-ratio` 로 자리를 먼저 잡아 글이 튀지 않는다 — [사진 넣기] 스니펫이 올린 사진의 크기를 같이 준다.

## 읽어 주기·따라쓰기 (앱 모드에만)

- **읽어 주기** — 읽을거리 위의 🔊 단추. `shared/voice.js` 의 `speakSeq` 로 문단을 차례로 읽고 읽는 문단을 밝힌다(유치·초1~2 는 조금 느리게). 기기가 못 읽으면 단추를 감춘다. 2일째(문제 장)에는 없다.
- **한자 따라쓰기** — 한자 코너의 큰 글자 아래 240px 캔버스. `vocab/trace.js` 규칙 그대로: 세 번 쓰되 안내 글자가 0.30 → 0.13 → 0 으로 옅어지고, 최소 획 길이(한 변의 0.6배)를 못 채우면 "조금 더 써 볼까요?". 마친 회차는 `state.trace[섹션 id]`. 획순은 채점하지 않는다(그 데이터가 없는 채로 틀렸다고 하지 않는다).

## 교육·입시 이슈 (`news`)

학원 소식 대신 **그 주의 교육·입시 소식 3~5건**을 학부모의 밤(5일째)과 신문 아래 좁은 단에 싣는다. 항목마다 제목·요약·"우리 아이에게"·출처(기관·언론명, 필수)·원문 링크(https 만)·날짜. AI 초안의 `news` 조각만 **웹 검색 도구**(`web_search`, 한국 기준, 6회 이내)를 켠다 — 시스템 프롬프트의 창작 규칙에 이 조각만 예외로 적혀 있다(기사 문장을 옮기지 않고 사실만 간추려 출처를 적는다). 검색이 길어져 멈춘 응답(`pause_turn`)에 JSON 이 없으면 사유 `paused` 로 돌려주고 [이 조각만] 다시 부른다. 검색이 없는 환경(키 없음)에서는 원장이 직접 적는다.

