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
  dayHeaderEn?, dayHeaderKo?, en, ko, keywords[{en,ko}], tokens[], verbForms[{base,answer}],
  grammarChoices[{options[],answerIdx}], writingKeywords[] }` + `oddOneItems[]` + `checkItems[]`
- `dialogues.json` → `dialogues[]: { id, section, lines[{speaker,en,ko}] }` + `keyExpressions[]`
  + `functions[]` + `vocabSidebar[]` + `readingQA[]`
- `patterns.json` → `patterns[]: { patternNo, title, conceptKo, grammarPoint[][]?,
  textbookExamples[{en,ko,origin}], letsUseIt[] }`
- `items-*.json` → `items[]: { no, footnoteNo, formatType, instructionKo, isNegative,
  answerCount, stimulus{type,parts[]}, choices[{label,text|tuple}], answer[], explanationKo }`

## 검증

```
node naesin/pack-validate.mjs <팩 디렉터리>
```

검사: JSON 파싱 · 개수 일치 · id 중복 · 필수 필드 · seq 연속성 · 핵심어 쌍 완전성 ·
정답-보기 정합 · packId 일치. 오류는 배포 차단, 경고는 검수 화면 확인 대상.
