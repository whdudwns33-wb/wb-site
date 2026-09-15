# haru/ — 하루브레인 (삼육중 대비 3년 상품) 코드 디렉터리

기획·명세는 `docs/삼육중-*.md`가 정본이다 — 상품은 `삼육중-대비-학습웹앱-기획서-v1.md`, 기술은 `삼육중-대비-앱-설계안-v1.md`.
여기 있는 것은 학생·부모 화면, 순수 로직, 그리고 **커밋해도 되는 유일한 콘텐츠 계층(원자 목록 `atoms.json`, 문항 0)**뿐이다.
팩·종이 대응표·코호트 플랜·시험지는 KV(관리 웹 업로드)에만 산다. 서버 쪽은 `reading-server/haru-api.mjs`·`haru-score.mjs`, 관리 웹은 `reading-server/public/haru-admin.html`.

## 화면·서버 (P0, 2026-09-15)

| 파일 | 무엇 |
|---|---|
| `index.html` | 학생 앱 — 연동(코드 → 강사 승인) · 홈(오늘 카드 3슬롯·이번 주 봉투·[앉았다]·좌표 요약·상시 고지) · 러너(슬롯당 3문항, 틀리면 "지금 다시 보면 풀 수 있어요?" 2지선다 → 30초 반증 → 해설) · 좌표 16칸 · 답안지(교시별 타이머·[넘김]·휴식 20분 잠금·`/attempt`) · 회고. 학생 화면 문자열은 `strings.js` 금지어 검사를 통과한다 |
| `parent.html` | 부모 화면(ptoken) — 오늘·이번 주·지난 회차 완주/무응답·분포(n≥30)·취침 목표·어른 일정. 쓰기 없음 |
| `sw.js` · `manifest.webmanifest` · `icon.svg` | 껍데기 캐시(VERSION 은 build-dist 가 스탬프) — `/api/*`·`*.json` 은 캐시하지 않는다 |
| `../reading-server/haru-api.mjs` | `/api/haru/*` — 학생(atoms·plan·today·gen·pack·cue·state·answer·probe·attempt·sheet·retro·report) · 부모(parent?t=) · 관리(students·enroll·pack·paperkey·paper·plan·cohort·atoms·board·map·parentlink·reports·export·purge). consent → 만료(회고 통과) → 배정 게이트. `allowedApp`(apps 게이트)·`weeklyAgg`(크론) 내보내기 |
| `../reading-server/haru-score.mjs` | 서버 채점 — `scorePeriod`(paperkey/screen-mock)·`mockRecord`·분포(`distUpdate`, n<30 비표시)·주간 익명 집계(10명·셀 5 미만 생략)·코치 보드 행·강사 좌표 |
| `../reading-server/public/haru-admin.html` | 관리 — 코치 보드 · 학생 등록(동의일 필수, `apps:['haru']`) · 팩/대응표/플랜/원자 업로드(검증기 오류 0) · 종이 회수 · 부모 링크 · 학습 여권 export(숫자 개방 뒤) · 파기(4계열) |

**첫 운영 절차(원장)**: ① `/admin/haru-admin.html` → [팩·대응표·플랜]에 `haru/plans/2027-pilot.json` 붙여넣기 → 저장 ② 9/13 회차의 `own-mock-01-paperkey.json`(sheet-build 산출물, 저장소 밖) 붙여넣기 ③ [학생 등록]에 코드·이름·코호트·**동의일** ④ 학생이 `/haru/`에서 코드 입력 → `/admin/`(진로독서 관리)의 「연동 승인 대기」에서 승인 ⑤ 회차 날 3교시 대응표는 `keyId-kor`·`-math`·`-eng` 세 개(재응시 회차는 1교시가 `retakeKeyId`).
**생성기 문항은 서버가 seed 로 만들고 seed 로 다시 만들어 채점한다**(`GET /gen` → `POST /answer`) — 정답이 기기에 내려가지 않는 것이 이 앱의 성립 조건(설계안 §7-1).

| 파일 | 무엇 |
|---|---|
| `atoms.json` | 원자 목록 v1 — 코어 16(2026-09-04 원장 확정, 기획서 D-11) + 주변 62 = 78. WB 자체 창작(스킬 트리의 투영). 문항·지문은 한 줄도 없다 |
| `atoms-check.js` | 검증기(순수 로직, 브라우저/Node 공용) — 코어 16 = 국6·수6·영4 전부 app · paper→paperSource · 선수 순환 없음 · 트리 커버리지 |
| `atoms-check.test.cjs` | `node haru/atoms-check.test.cjs` — 실제 파일 오류 0 + 규칙별 반례 13 |
| `facts.json` · `facts.test.cjs` | 전형 사실의 기계 판독본(정본 v1.2 와 같은 값) — 일정·배점·문항 수·동점자. 마일스톤·타이머·고지 문구의 단일 원천 |
| `strings.js` | 내부값 ↔ 학생/강사 문자열 표, 금지어(학생·부모), 관측 문구·coach 문구. 학생 화면 문자열은 전부 여기서 나온다 |
| `plan.js` | 코호트 달력 — KST 고정 날짜, D-day, `isLocked`(시험일 12:00), 회고 창, 숫자 개방(시험일+7일 16:00), 국면·파이널 하위 국면 배합, `bands` 잠금, 마일스톤 aud 필터, D-7 취침 위상 전진 |
| `mastery.js` | 좌표 추정 — 찍기 보정 Beta, 문항 재사용 감쇠, 분산 팽창(평균 보존), 4상태 `grade`, `retake` 제외, habit 등급 |
| `probe.js` | 무엇을 찌를까 — value = U·H·A·B, 콜드스타트 바닥, 오늘 카드(국면 배합·빌림·D-14 동결), 월요일 봉투 |
| `srs.js` | 카드 상태기계 — 3년 간격 사다리, 처리량 역산 floor + dday×0.35 cap + 분산 배치, 4단 사다리·단서, 도달(8시간 규칙)·졸업(3일×2맥락), needsRecheck |
| `cause.js` | 오답 원인 5분류(배제 순서 time→exec→misread→confuse→gap)·처방 라우터·원인 분포(n<10 비표시) |
| `pace.js` | 회차 계측 — 지문 세트 단위 시간 귀속(paperkey `sets`), 몰아 마킹 지연, 페이스 밴드, 시험 기술 4항목 |
| `pack-check.js` · `pack-sample.json` | 팩·paperkey 검사의 단일 소스(라이선스 게이트: origin enum·kogl1 출처·pd 현대어역·T2 sourceText·serve·만료 / paperkey: 시판 정답표 금지·holder·타 학원 모의 불허·sets 필수·동결) + 정답 제거본 `stripForStudent`. 체험 팩은 자체 창작 |

| `sheet-build.mjs` | 종이 회차 조판 — 팩 → 시험지 HTML(`stripForStudent` 뒤에만 조판, 부정 발문 밑줄, 시는 행 보존, OMR 25칸) · 원장용 정답표 · paperkey(`sets` = 지문 단위 + 단독 문항 각 1). 시험지 원본은 저장소 밖(scratchpad → 원장 전달)에서만 만든다 |
| `calc.js` | 수학 수치 생성기 — 템플릿 16개(원자 16개: 분수 사칙·변환·비율·백분율·기준량 역산·단위·나머지·GCD/LCM·평균 역산·각기둥·겉넓이 부피). 유니코드 텍스트만, 오답에 errKind:'calc'/개념 혼동 atomId 자동 태깅, `sampleSheet(atomId, 30, seed)` 로 원장 검수 표본 |
| `gen.js` | 영어 어휘 MCQ — naesin/gen.js 단어 계열 포크(오답 충돌 방지·rnd 주입·유형 로테이션) + `markConditions`(④ 문제 오독 처방: 발문 조건 표시 훈련) |
| `kor-master.js` · `kor-master-data.json` | 국어 어휘·문법 생성기 5종(낱말의 짜임·한자어 낱말 가족·다의어 문맥·호응·표현법 식별). 데이터는 자체 창작 초안(시구 포함) — 원장 검수·확장 대상 |
| `grade-ko.js` | 한국어 핵심어 누락 표시 — naesin/grade.js 토크나이저 6개 포크, `summaryGaps(요약, keyPhrases)`. `similarity` 없음(회귀 테스트) |
| `report.js` | 주기 평가 — `monthly`(부모 1장 필드)·`phaseReview`(동결 세트 차이·완주율·조정 제안)·판정 규칙표·`forStudent/forParent/forCoach` 투영. 금지어 검사 통과가 테스트 |
| `plan-build.mjs` · `plans/2027-pilot.input.json` → `plans/2027-pilot.json` | 진도 입력 → `plan.days`(82일: prep·card·passage·mock·rest·exam·retro) + facts.json 에서 마일스톤 생성. `node haru/plan-build.mjs haru/plans/2027-pilot.input.json` |

전부 실행: `for f in haru/*.test.cjs haru/*.test.mjs; do node $f | tail -1; done; node reading-server/haru-score.test.mjs; node reading-server/haru-api.test.mjs`
로컬 서버: `PORT=8890 ADMIN_PIN=<pin> DATA_DIR=<dir> node reading-server/server.mjs` → `http://localhost:8890/haru/` · `/admin/haru-admin.html`

**아직 없는 것**: 영어 300어 마스터 데이터(gen.js 가 읽을 `{id, headword, meaningKo, pos, example, definition}` 형태) · 국어 데이터 확장(합성/파생 80쌍·한자어 60·다의어 40·호응 30·시구 60행) — 콘텐츠 검수 항목.
P1 이후: `haru-studio.mjs`(정제소) · 월간 평가 큐(`/admin/reviews`) · `itemstats` · 정보 수집 큐 화면 · 학습 여권 PDF 판. 영어 300어 데이터가 없으면 영어 코어 4칸은 오늘 카드에 오르지 않는다(공급 없는 원자는 슬롯에서 제외).

규칙(CLAUDE.md 절대 규칙 1·2): 라이선스 콘텐츠·문항·학생 정보는 여기 오지 않는다(KV·관리 웹 업로드로만). `std` 성취기준 코드는 2022 개정 원문
대조 후 채운다. `atoms.json`을 고치면 출제지형도 §4~§6의 `atomId` 열을 스크립트로 다시 생성한다(손으로 고치지 않는다).
**저장소 비공개 전환(기획서 D-0)은 아직 실행 전이다** — 원장 결정으로 D-0 전에 P0 코드를 올렸다(2026-09-15). 콘텐츠는 여전히 KV 에만 있다.
