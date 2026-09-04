# haru/ — 하루브레인 (삼육중 대비 3년 상품) 코드 디렉터리

기획·명세는 `docs/삼육중-*.md`가 정본이다 — 상품은 `삼육중-대비-학습웹앱-기획서-v1.md`, 기술은 `삼육중-대비-앱-설계안-v1.md`.
지금 이 디렉터리에 있는 것은 **커밋해도 되는 유일한 콘텐츠 계층(원자 목록)**과 그 검증기뿐이다. 앱 코드는 기획서 §12 P0가 열리면 온다.

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

전부 실행: `for f in haru/*.test.cjs; do node $f | tail -1; done`

**아직 없는 것(P0 나머지)**: `gen.js`(naesin/gen.js 포크)·`calc.js`(수학 생성기 8종)·`kor-master.js`·`grade-ko.js`·`report.js`(주기 평가)·`plan-build.mjs`(진도표 → plan.days) — 순수 로직.
`haru-api.mjs`·`haru-score.mjs`·`haru-studio.mjs`·화면·배포 11곳은 **D-0(저장소 비공개)·D-5·D-6 결정 뒤**.

규칙(CLAUDE.md 절대 규칙 1·2): 라이선스 콘텐츠·문항·학생 정보는 여기 오지 않는다(KV·관리 웹 업로드로만). `std` 성취기준 코드는 2022 개정 원문
대조 후 채운다. `atoms.json`을 고치면 출제지형도 §4~§6의 `atomId` 열을 스크립트로 다시 생성한다(손으로 고치지 않는다).
**저장소 비공개 전환(기획서 D-0)은 아직 실행 전이다** — 이 디렉터리에 다음 파일을 넣기 전에 끝낸다.
