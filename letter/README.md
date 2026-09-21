# letter/ — 브레인레터 (주간 뉴스레터) 코드 디렉터리

기획은 `docs/브레인레터-주간뉴스레터-기획서-v1.md` 가 정본이다. 여기 있는 것은 학생·가족 화면, 순수 로직(검증기·렌더러), 그리고
**커밋해도 되는 유일한 콘텐츠(자체 창작 체험 호 `issue-sample.json`)** 뿐이다. 실제 호(issue)는 KV(관리 웹에서 저장)에만 산다.
서버 쪽은 `reading-server/letter-api.mjs`, 관리 웹은 `reading-server/public/letter-admin.html`.

**무엇인가**: 유치(5~7세)부터 중학생까지 다섯 학년대에 **매주 한 호**를 보낸다. 한 호는 같은 주제를 학년대별로 다른 깊이로 읽는
읽을거리 + 독해 문제, 한자어 낱말 가족, **웩슬러(K-WISC-V) 다섯 지표와 연결된 두뇌 놀이**, 부모용 입시 문해력 칼럼, 부모 코칭,
학원 소식, 이번 주 미션으로 되어 있다. 기본은 앱(가족 링크·학생 토큰)이고, 원하는 가정은 화면의 [PDF로 저장]으로 인쇄본을 받는다.

## 파일

| 파일 | 무엇 |
|---|---|
| `index.html` | 학생·가족 앱. 모드 4개 — **가족 링크**(`/letter/?t=<ptoken>`, 로그인 없음, 기록은 기기에만) · **학생**(`wbr.auth` 토큰, 기록을 서버에 저장) · **관리 미리보기**(`?id=&tier=` + 관리 토큰, 초안도 봄, `tier=all`·`print=1`/`print=nokey`) · **체험**(아무것도 없으면 `issue-sample.json`). 문제 풀기(즉시 해설)·정답 보기·미션 체크·[다 읽었어요]·지난 호·[PDF로 저장](정답 별지 포함 / 정답 없이) |
| `letter.js` | 순수 로직 `WBLETTER` — 학년대 판정(`tierOf`: 명부 grade → K·E1·E2·E3·M, 원장 지정 `letterTier` 우선, 못 읽으면 진로독서 level 로 어림), KST ISO 주차(`weekId`·`weekStart`), **검증기 `checkIssue`**(관리 웹·AI 초안·서버 저장이 같은 규칙), 학년대 선택 `forTier`, 가시성 `isVisible`, **렌더러 `renderIssue`**(학생 앱·관리 미리보기·인쇄가 같은 HTML), 공용 CSS(`CSS`, 인쇄 규칙 포함), 빈 템플릿 `blankIssue` |
| `issue-sample.json` | 2026-W39 「가을 잎의 비밀」 — 다섯 학년대 전부 갖춘 자체 창작 체험 호. 테스트 픽스처 겸 미연동 데모 겸 AI 초안의 형식 예시 |
| `letter.test.cjs` | `node letter/letter.test.cjs` — 학년대·주차·검증기(반례)·선택·렌더러 이스케이프·인쇄 별지·샘플 오류 0 |
| `sw.js` · `manifest.webmanifest` · `icon.svg` | 껍데기 캐시(VERSION 은 build-dist 가 스탬프). `/api/*`·`*.json` 은 캐시하지 않는다 |
| `_headers` | 안내 주석만 — 배포 규칙은 `reading/_headers` 의 `/letter/*` no-store |
| `../reading-server/letter-api.mjs` | `/api/letter/*` — 가족(`parent?t=`) · 학생(`issues`·`issue?id=`·`state` GET/PUT) · 관리(`admin/issues`·`admin/issue` GET/PUT/DELETE·`admin/publish`·`admin/students`·`admin/tier`·`admin/messages?id=`·`admin/stats?id=`·`admin/draft`). `dumpLetter`(백업)·`dropStudentLetter`(퇴원) |
| `../reading-server/letter-api.test.mjs` | `node reading-server/letter-api.test.mjs` — 메모리 어댑터·가짜 fetch 로 전 라우트 |
| `../reading-server/public/letter-admin.html` | 관리 — 호 목록(발행/내리기·미리보기·인쇄 링크·삭제) · 편집(JSON + 머리 정보 폼 + 검증 + 학년대별 미리보기) · AI 초안(6조각) · 발송 문구(가족 링크 자동 발급) · 열람 현황 · 학생 학년대 지정 |

## 학년대·웩슬러 지표

| 학년대 | 대상 | 읽을거리 길이(공백 포함) | 문제 |
|---|---|---|---|
| `K` | 유치 5~7세 (부모가 읽어 주는 글, `readAloud`) | 50~300자 | 3문제 · 보기 2~3 |
| `E1` | 초1~2 | 160~480자 | 3문제 · 보기 3 |
| `E2` | 초3~4 | 380~820자 | 4문제 · 보기 4 |
| `E3` | 초5~6 | 560~1150자 | 4~5문제 · 보기 4 |
| `M` | 중1~3 (고등은 중등 것을 받는다) | 800~1600자, 수능 비문학형 구조 | 5문제 · 보기 5 |

두뇌 놀이(`brain`)는 반드시 K-WISC-V 기본 지표 하나를 겨냥한다 — `VCI` 언어이해 · `VSI` 시공간 · `FRI` 유동추론 · `WMI` 작업기억 ·
`PSI` 처리속도. **검사 문항을 복제하지 않는다**(검사 타당도를 해친다). 같은 인지 기능을 쓰는 다른 놀이다. 매주 학년대별로 지표를 돌려 가며 고르게 쓴다.

## 호(issue) 스키마 — 검증기 `checkIssue` 가 정본

```
{ id: "2026-W39"(YYYY-Www[-접미]), week: "2026-W39", publishAt: "YYYY-MM-DD", status: "draft"|"published",
  title(≤80), theme(≤120), intro(≤800), source(필수 — 자체 창작 표시), sections: [ … ] }
section 공통: { id: [a-z0-9-]{2,30} 유일, type, tiers: "all" | ["K","E1",…], title(≤80) }
  read      { readAloud?, minutes?, lead?, paragraphs:[…], vocab:[{word(본문에 있어야), easy, hanja?}], questions:[{q, choices:2~5, answer:0부터, why?, skill?: main|detail|infer|vocab|apply|critical}] }
  words     { family?:{hanja,hun,eum}, words:[{word, meaning, hanja?, example?}] 1~10, task? }
  brain     { index: VCI|VSI|FRI|WMI|PSI, minutes?, howTo?, items:[{prompt, answer(필수), hint?, grid?:[줄…]}] 1~10, parentTip? }
  column    { paragraphs:[…], takeaway? }      coach { tips:[…] 1~6 }      notice { items:[…] 1~10 }      checklist { items:[…] 1~8 }
```
오류(저장 불가): 형식·범위 위반, 정답 번호가 보기 밖, 섹션 id 중복, 모르는 학년대·지표, 400KB 초과, 출처 없음.
경고(저장 가능): 글자 수 권장 범위 밖, 낱말이 본문에 없음, 어느 학년대에 읽을거리·두뇌 놀이가 없음.

학생에게는 `forTier` 로 자기 학년대 섹션(`tiers` 에 포함 또는 `"all"`)만 내려간다. 정답·해설은 뉴스레터의 일부라 함께 내려간다(가정 학습지다 — 하루브레인과 다르다).

## 주간 운영 절차(원장)

1. `/admin/letter-admin.html` → [호 목록] → 주차 확인 → **[AI 초안 만들기]**(`ANTHROPIC_API_KEY` 가 있을 때. 주제·원장 메모·학년대별 지표를 넣으면 공통 + 학년대 5 = 6조각을 차례로 받아 한 호로 조립) 또는 [빈 템플릿] / [샘플 호 복제].
2. [편집] — 머리 정보 폼 + JSON. [검증] 으로 오류 0 을 만들고 오른쪽 미리보기(학년대별)로 읽어 본다. **모든 글은 자체 창작**이어야 한다(교재·기사·시험 문제를 옮기지 않는다). [저장] 은 발행 상태를 바꾸지 않는다.
3. [호 목록] → [발행](발행일 지정, 월요일 아침이 기본). 발행일 전에는 학생·가족에게 보이지 않는다. [내리기] 로 언제든 초안으로.
4. [발송 문구] → 학생마다 가족 링크가 든 문구(알림톡·문자용) → [전체 복사]. 링크가 없던 학생은 여기서 발급된다(진로독서 학부모 리포트와 같은 `parent:<t>` 토큰 — 가정마다 링크 하나). **동의서의 보호자 번호로만** 보낸다.
5. 종이로 받고 싶은 가정 → [호 목록]의 [인쇄·PDF] → 학년대별 또는 전체 학년대, 정답 별지 포함/없이 → 브라우저 인쇄 창에서 "PDF로 저장". 가정에서는 화면의 [PDF로 저장] 버튼이 같은 일을 한다.
6. 다음 주 [열람 현황] — 학년대별 열람·완독, 안 연 학생, 문항별 정답률(학생 토큰으로 연 것만 잡힌다. 가족 링크 열람은 기기에만 남는다).

## 인증·저장·비용

- 학생 라우트는 호스트의 `wbr.auth` 토큰 + apps 게이트(`appOfPath` → `'letter'`; 재원생은 전부, `apps` 배열이 있는 외부 학생은 `letter` 가 있어야).
- KV 키: `letter:issue:<id>` · `letter:issues`(id 목록) · `letter:state:<code>`(학생 기록 — 열람·문제·미션, 150KB, 하루 PUT 10회) · `letter:aiuse`(AI 초안 장부). 가족 링크는 `parent:<t>` 공용.
- 백업(`fullDump`)에 호 본문과 기록이 통째로 담긴다(원장이 쓴 글이라 라이선스 원문이 아니다). 퇴원 처리는 `letter:state:<code>` 만 지운다.
- AI 초안: `ANTHROPIC_API_KEY`(모델 기본 `claude-opus-5`, `LETTER_AI_MODEL` 로 변경), 하루 한도 `LETTER_AI_DAILY`(기본 30회 = 다섯 호). 키가 없으면 초안 버튼만 안내로 동작하고 나머지는 그대로 돈다.

전부 실행: `node letter/letter.test.cjs && node reading-server/letter-api.test.mjs`
로컬 서버: `PORT=8890 ADMIN_PIN=<pin> DATA_DIR=<dir> node reading-server/server.mjs` → `http://localhost:8890/letter/` · `/admin/letter-admin.html`

**아직 없는 것(다음 단계)**: 발행 시 Web Push(워드브레인 밤 9시 푸시 배선 재사용) · 학생별 맞춤(진로독서 관심사·워드브레인 낱말과 연결) · 지난 호 검색 · 시공간(VSI) 놀이용 도형 SVG 생성기 · 이메일 발송(스티비) 연동.
