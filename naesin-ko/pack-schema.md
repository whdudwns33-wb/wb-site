# 국어브레인 — 단원 팩 스키마 (v0, Phase 1a)

팩 = **(개정, 교과서, 학년·학기, 대단원) 하나**의 구조화 콘텐츠 묶음.
정본 문서: `docs/국어내신-학습웹앱-기획서-v1.md` §8.

> **이 문서는 요약이고, 필드의 정본은 `pack-check.js`의 검사 항목이다.**
> Node 검증기(`pack-validate.mjs`)와 관리 웹이 같은 파일을 부르므로 규칙이 갈리지 않는다.

## 핵심 원칙 4가지

1. **마스터 우선** — 빈칸 퀴즈·구절 적용·OX 변형·연결하기·주석 복원은 저장하지 않고 정본에서
   런타임 생성한다(`gen.js`). `items[]`에는 자동 생성이 불가능한 고유 문항만 넣는다.
2. **정답은 배열** — 복수 인정답을 `answers[]`로. 채점기는 정규화 후 대조한다(`grade.js`).
3. **원문 보존** — 자료의 오탈자도 교정하지 않고 옮기되 `notes`에 기록한다. 교정은 검수에서 사람이 결정.
4. **위치 복합키** — 문항은 `source{series, section, no}`로 원본 지면을 역추적할 수 있어야 한다.

## 파일 구성

관리 웹이 여러 파일을 골라 **병합(assemble)** 한 뒤 검증·업로드한다.

```
meta.json          팩 메타 (packId·revision·publisher·grade·semester·unit·source)
works/<id>.json    작품 정본  { "work": {...} }  또는 { "works": [...] }
sets.json          지문 세트  { "sets": [...] }
items-<계열>.json  저장 문항  { "items": [...] }
```

`counts`는 병합 때 다시 센다 — 손으로 적어 둔 값과 어긋나면 검증기가 잡는다.

## 팩 루트

| 필드 | 설명 |
|------|------|
| `packId` | `^[A-Za-z0-9-]{3,60}$`. 좌표를 인코딩한다: `<개정>-<출판사저자>-<학년>-<학기>-U<대단원>` (예: `2022-cheonjae-nomisuk-m2-1-U1`) |
| `revision` | 개정 연도. **자료에 인쇄돼 있지 않다** — 업로드 때 넣는다(§2.2-7) |
| `publisher` / `author` / `grade` / `semester` / `unit` | 교과서 좌표. 자료마다 빠진 항목이 다르니 교차 확인해 채운다 |
| `source` | `{provider, producedAt, contentCode, protectNotice}` — 화면 출처 고지(§10-8)가 이 값을 렌더링한다 |
| `counts` | `{works, sets, items, blanks, vocab}` |

## Work — 작품 정본

`kind`: `poem` · `novel` · `nonfiction` · `grammar` · `speech` · `media` · `handout`(학교 프린트).

| 필드 | 설명 |
|------|------|
| `workId`, `title`, `author`, `kind`, `unitPath` | 식별·좌표. `unitPath`는 `1 > 1-1 > (1)` 형식 |
| `hasCanon` | 정본(이해완성류) 보유 여부. **false면 개념 단위가 없어** 오답이 빈칸 큐로 돌아가지 않는다(§2.2-6) |
| `isExternal` | `<보기>` 인용 작품. 해당 문항 맥락에서만 표시한다(§10-5) |
| `overview` | `{genre[], material, tone[], theme, features[]}` |
| `composition[]` | `{range, summary}` — 연·문단 범위별 요지 |
| `text` | `{stanzas:[{no, lines[]}]}` 또는 `{paragraphs:[]}`. **선택 필드다** — 원문 미표시 설계(§10-2 ③)에서는 비운다 |
| `lineNotes[]` | `{anchor, note}` — 행별 날개풀이. 3·4단계 화면에서는 **보이지 않는다**(그게 곧 정답이다) |
| `marks[]` | `{symbol, anchorText, style}` — 지문 기호. `anchorText`는 본문 안에 실제로 있어야 한다(검증기가 확인) |
| `keywords[]` | `{id, word, mark, meaning, polarity, starred, quotes[]}` — 시어·소재 |
| `speaker` | `{who, situation, attitude[], shift, evidence}` |
| `rhetoric[]` | `{id, conceptId, name, mark, quote, tenor, vehicle, effect}` — **구절 적용 문항의 원천**. `quote` 필수 |
| `features[]`, `vocab[]`, `checklist[]`, `examPoints[]`, `structureMap`, `appreciationPoints[]` | 보조 정본 |
| `blanks[]` | `{id, path, label, text, answers[]}` — **빈칸 = 개념 단위 = MasteryState 키**. 이해완성·요약노트가 같은 핵심어를 두 번 뚫으므로 하나로 병합한다(§2.2-2) |

## PassageSet — 지문 세트

같은 작품이 문제집마다 기호 위치·라벨을 달리해 여러 번 실린다. 작품 단위로 합치면
문항↔기호 매핑이 깨지므로 세트를 따로 둔다(§2.2-5).

```
{ setId, works: [{ label, workId, kind: "full"|"excerpt", text?, prefaceSummary?, range? }],
  marks: [{ symbol, workId, anchorText }] }
```

`kind: "excerpt"`면 **`text`가 필수**다 — 소설 전문은 자료에 없어서 슬라이스할 수 없다.

## Item — 저장 문항

`format`: `mc5` · `essay` · `ox` · `matching` · `cloze` · `choice_dialog`.

| 필드 | 설명 |
|------|------|
| `id`, `setId`, `workId`, `source{series, section, no}`, `targetLabels[]`, `refMarks[]` | 식별·연결 |
| `stem` | 발문. 부정발문은 `isNegative: true` + `<b>않은</b>` |
| `bogi` | `{kind, text, sourceWork}` — `<보기>` 박스 |
| `choices[]` / `answer` | `mc5`는 `{no, text}` 5개 + 정답 번호, `ox`는 `answer: true/false` |
| `explanation` | `{main, perChoice:{1..5}}` — **선지별 해설이 오답 피드백의 핵심 재료**(§5.2) |
| `conditions[]` | 서술형 조건. `kind`: `include` / `sentences` / `chars` / `words` / `form` / `quote` |
| `rubric[]` | `{element, keywords[], acceptedVariants[], points, source}` — `source`는 `material`(자료 제공) 또는 `authored`(검수 저작) |
| `totalPoints` | 요소 배점의 합과 일치해야 한다 |
| `modelAnswers[]`, `answerChecks[]`, `tip` | 모범 답안·채점 요소 목록·공략 Tip |
| `targetRefs[]` | 개념 단위 역참조(`b-<빈칸id>`). 오답이 2단계 큐로 돌아가는 경로 |

**서술형 루브릭은 대부분 검수에서 사람이 저작해야 한다** — 자료의 핵심 단어는 27문항 중
7문항에만 있다(§2.2-3). 검증기가 `rubric` 없는 서술형을 오류로 잡는다.

## 학교 오버레이 (팩 밖)

정본은 출발점이고, 채점 기준은 학교 선생님의 해석이다(§1.4-4). 오버레이는 팩과 **분리 저장**된다.

```
POST /api/naesin-ko/admin/overlay
{ scope: "default"|학생코드,
  overrides: [{ targetRef: "b-bl-09", answers: ["의인법","활유법"], note: "..." }],
  notes:     [{ workId: "w-...", text: "학교 선생님 강조" }] }
```

`targetRef` 규약: `b-<빈칸id>`(개념 빈칸) · `t-<복원항목id>`(주석 복원).

## 검증

```
node naesin-ko/pack-validate.mjs <팩 디렉터리>
```

**오류 = 배포 차단 / 경고 = 검수 화면에서 사람이 확인.** 주요 검사:
counts 대조 · id 유일 · 빈칸-정답 쌍 완전성 · 같은 핵심어 병합 경고 · 기호 앵커가 본문에 존재 ·
발췌 세트 `text` 필수 · 작품·세트 참조 무결성 · `mc5` 정답 범위 · 선지별 해설 누락 경고 ·
서술형 루브릭 존재와 배점 합 · 조건 `kind` · `targetRefs` 참조 · `conceptId`가 사전에 존재.
