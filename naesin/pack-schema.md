# WB 내신 — 레슨 팩 스키마 v0 (Phase 0)

팩 = **(교육과정, 교과서, 학년, 과)** 단위의 구조화 콘텐츠 묶음.
`packId` 예: `2022-ne-kimgitaek-m2-L6` (2022 개정 · NE능률(김기택) · 중2 · Lesson 6).

> **콘텐츠는 이 저장소에 커밋하지 않는다.** 이그잼포유 라이선스 자료를 구조화한 것이므로
> 팩 JSON은 업로드 파이프라인을 통해 서버 저장소(KV)로만 들어간다(기획서 §9.3).
> 이 문서와 `pack-validate.mjs`(검수 게이트의 자동 검증 단계)만 코드 자산으로 관리한다.

## 파일 구성

| 파일 | 내용 | 원천 자료 |
|------|------|----------|
| `words.json` | 단어 마스터 — 뜻·예문·영영풀이·다의어 senses·유의/반의 | WORD TEST 학습자료부 |
| `sentences.json` | 본문 문장 마스터 — 영/한 대역·핵심어 쌍·배열 토큰·동사형·어법 선택·어색한 곳·종합 Check | 본문 10단계 워크북 |
| `dialogues.json` | 대화문 마스터 + 핵심표현·어휘 사이드바·서술형 QA | 내용정리 플러스 |
| `patterns.json` | 문법 패턴 — 개념·Grammar Point·교과서 예문·Let's Use It | Grammar Build Up 개념부 |
| `items-*.json` | 저장 문항(마스터에서 파생 불가한 고유 문항) | 각 자료 시험부 |

## 핵심 원칙

1. **마스터 우선.** 영→한 시험, 한→영 시험, 본문 빈칸·배열·영작 등 단순 변주 문항은 저장하지
   않고 마스터에서 런타임 생성한다. `items-*`에는 변형문·오류문·객관식 등 고유 문항만 담는다.
2. **정답은 배열.** 원본의 `knocking[knock]`·`if[whether]` 복수 정답 표기는 `answers`/`accepted`
   배열로 파싱해 담는다. 채점기는 대소문자·구두점·축약형 정규화 후 대조한다.
3. **원문 보존.** 오탈자도 교정하지 않고 옮기되 `notes`에 기록한다 — 교정 여부는 검수 게이트에서
   사람이 결정한다.
4. **위치 복합키.** 문항은 `(source, section, no, footnoteNo)`로 원본 지면을 역추적할 수 있어야
   한다(정답지 각주번호 매핑 재현).

## 필드 상세

각 파일의 필드 구조는 `pack-validate.mjs`의 검사 항목이 정본이다. 요약:

- `words.json` → `words[]: { id, headword, pos, meaningKo[], sections[]("conversation"|"reading"),
  irregularForms, example{en,ko}?, definition{en,ko}?, senses[]?, synonyms[], antonyms[] }`
- `sentences.json` → `passage{titleEn,titleKo}` + `sentences[]: { seq(1..N 연속), dayGroup,
  dayHeaderEn?, dayHeaderKo?, en, ko, chunks[{en,ko}], keywords[{en,ko}], tokens[],
  verbForms[{base,answer}], grammarChoices[{options[],answerIdx}], writingKeywords[] }`
  + `oddOneItems[]`(선택) + `checkItems[]`(선택) — 아래 「본문 문장 상세」
- `dialogues.json` → `dialogues[]: { id, section, lines[{speaker,en,ko}] }` + `keyExpressions[]`
  + `functions[]` + `vocabSidebar[]` + `readingQA[]`
- `patterns.json` → `patterns[]: { patternNo, title, conceptKo, grammarPoint[][]?,
  textbookExamples[{en,ko,origin}], letsUseIt[] }`
- `items-*.json` → `items[]: { no, footnoteNo, formatType, instructionKo, isNegative,
  answerCount, stimulus{type,parts[]}, choices[{label,text|tuple}], answer[], explanationKo }`

## 본문 문장 상세 (`sentences.json`)

### 두 가지 한글 — 암기용은 청크다

`chunks[{en,ko}]`가 **암기 훈련의 축**이다. 청크별 직독직해 한글이라 영어 자리와 나란히 선다.
조각의 `en`을 이어 붙이면 문장 `en`과 정확히 같아야 한다(검증기가 막는다).
문장 단위 `ko`는 매끄러운 해석이라 **한국어 어순**이고 영어 자리와 어긋나므로 암기 훈련에 쓰지 않는다 —
화면 위쪽 뜻 표시·영작 제시문 용도다. 청크가 없는 문장은 청크 트랙과 2단계(영어 청크 배열)가
서지 않고, 1단계 한글 빈칸만 `ko`로 내려간다(문항에 `source:'ko'`로 표시된다).

### `oddOneItems[]` — 단락 관문 「어색한 곳 찾기」 (선택)

없으면 그 단락의 어색한 곳 찾기 단계를 건너뛴다(생성기가 `null`을 돌려준다).

```json
{ "id": "odd-8-1", "dayGroup": "8/1", "kind": "lexical",
  "instructionKo": "본문과 다르게 바뀐 곳을 고르세요.",
  "sentences": [ { "seq": 1, "text": "…한 곳만 바꾼 지면 그대로…" } ],
  "options": ["지면에 나오는 순서대로", "고를 조각들"],
  "answerIdx": 1, "correction": "본문의 원래 표현",
  "explanationKo": "왜 그것이 본문과 다른지" }
```

- `kind`: `lexical`(낱말이 바뀜) | `grammatical`(어법이 바뀜).
- `sentences[].text`는 **그 단락 전체를 지면 그대로** 싣되 딱 한 곳만 바꾼다.
  정답 조각을 `correction`으로 되돌리면 정본 `en`과 글자까지 같아야 한다.
- `options[]`는 지면에 나오는 순서대로 ①②③④를 받는다. 각 조각은 `sentences[].text` 안에서
  그 순서대로 찾을 수 있어야 한다 — 하나라도 못 찾으면 문항을 내지 않는다(번호가 어긋난 지면을
  학생에게 보이지 않는다).

### `checkItems[]` — 「종합 Check」 (선택)

모든 단락을 통과한 뒤 여는 최종 점검(기획 40슬롯). 없으면 종합 Check가 열리지 않는다.
슬롯 네 가지가 기존 러너 문항 모양에 그대로 얹힌다.

| `slot` | 필수 필드 | 러너 문항 |
|---|---|---|
| `choice` | `choices[]`, `answerIdx`, `promptKo`, `textEn?` | `mcq` (보기 셔플) |
| `blank` | `textEn`(빈칸은 `______`), `blanks[{answers[],hintKo?}]` | `ckblank` (parts+blank) |
| `write` | `ko`, `answers[]`, `keywords[]?` | `write` (영작) |
| `arrange` | `tokens[]`(3개 이상), `ko` | `order` (토큰 배열) |

공통: `id`, `slot`, `seq?`(대상 문장), `promptKo`, `explanationKo?`.
`choice`의 보기는 서로 겹치면 안 된다(정규화 후 같은 문구가 둘이면 정답이 둘이다) ·
`blank`는 `______` 자리 수와 `blanks[]` 수가 같아야 한다 — 어기면 그 칸을 문항으로 만들지 않는다.

## 마스터에서 생성하는 문항 타입 (`gen.js`)

| 타입 | 생성기 | 쓰는 데이터 |
|---|---|---|
| `ckmatch` | `chunkMatch(sentences, rnd, opts)` | 단락 청크 4~5쌍 영↔한 짝 맞추기 |
| `ckmean` | `chunkMeaning(sentences, rnd, opts)` | 영어 청크 → 한글 4지선다(오답은 같은 단락의 다른 청크) |
| `ckorder` | `chunkOrder(sentence, rnd)` | 한글 청크를 직독직해 순서로 |
| `koblank` | `koBlanks(sentence, cue)` | 1단계 — 청크 한글 줄 + `keywords[].ko` 빈칸 |
| `enorder` | `enChunkOrder(sentence, rnd)` | 2단계 — 한글 청크를 보고 영어 청크 배열 |
| `kwblank` | `keywordBlanks(sentence, dir, cue)` | 3단계 — 영어 핵심어 빈칸 |
| `verb`·`grammar` | `verbFormDrill`·`grammarChoiceDrill` | 4단계 — `verbForms`·`grammarChoices` |
| `write` | `writingPrompt(sentence, cue)` | 5단계 — 줄 영작 |
| `oddone` | `oddOneItem(oddOneItems, dayGroup, opts)` | 단락 관문 — 어색한 곳 찾기 |
| `mcq`·`ckblank`·`write`·`order` | `checkSet(checkItems, rnd, opts)` | 종합 Check |

**단서 농도(`cue` 0~3)** 는 1·3·5단계 생성기의 선택 인자다 —
3 전사(답을 보여 주고 그대로 옮겨 쓰기, `showAnswer:true`) · 2 첫 글자+글자 수 · 1 첫 글자 · 0 빈칸만.
인자를 안 넘기면 예전 출력 그대로다(기존 호출 호환).

## 검증

```
node naesin/pack-validate.mjs <팩 디렉터리>
```

검사: JSON 파싱 · 개수 일치 · id 중복 · 필수 필드 · seq 연속성 · 핵심어 쌍 완전성 ·
청크 연결과 `en` 일치 · 정답-보기 정합 · packId 일치. 오류는 배포 차단, 경고는 검수 화면 확인 대상.
`oddOneItems`·`checkItems`는 개수만 요약에 나온다 — 내용 정합(조각을 지면에서 찾을 수 있는가,
보기가 겹치지 않는가)은 생성기가 `null`로 걸러 내고 `naesin/gen.test.cjs`가 지킨다.
