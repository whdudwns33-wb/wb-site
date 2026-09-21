# 한자브레인 — 한자·한글 어휘 훈련 앱

한글 어휘가 부족한 학생을 위한 원내 전용 앱. **문제집 한 권 = 단어장 하나**로 올려 그 책의 낱말·한자만
따로 배우고, 한자는 **손가락으로 직접 따라 쓴다.** 영어는 다루지 않는다(영어는 워드브레인 `/vocab/`).

주소: 학생 `/hanja/` · 관리 `/admin/hanja-admin.html` (PIN). 학생 인증은 진로독서 학생 토큰(`wbr.auth`)을 그대로 읽는다 —
진로독서에서 학원 QR로 한 번 연동하면 이 앱도 열린다. 미연동 기기는 `book-sample.json`(자체 창작) 체험 모드다.

## 구성

```
hanja/
  index.html        학생 앱 (탭: 오늘·단어장·한자·훈련·기록)
  book-check.js     단어장 검사·정규화·붙여넣기 파서 — 관리 업로드 관문·미리보기·CLI 가 같은 규칙   [WBBOOKCHECK]
  book-validate.mjs 단어장 검증기 CLI (book-check.js 위임)
  srs.js            간격 반복 (당일 밤→1→3→7→14→30→90일, 졸업)                                    [WBHSRS]
  quiz.js           문항 생성 — 뜻·낱말·문맥 빈칸·한자 조립·한자 표기·낱말 쓰기 / 훈음·글자·낱말·획수   [WBHQUIZ]
  trace.js          따라쓰기 판정 — 덮음률(모양 모드)·획수 대조·획순 데이터 매칭(획순 모드)             [WBHTRACE]
  book-sample.json  자체 창작 체험 단어장 (기초 한자 39자 + 한자어 34 + 고유어 14) — 커밋 가능한 유일한 단어장
  sw.js · manifest.webmanifest · icon.svg · _headers(안내 주석)
  *.test.cjs        각 모듈 테스트 (node 로 바로 실행)
reading-server/
  hanja-api.mjs     /api/hanja/* 라우트 (worker.mjs·server.mjs 양쪽에 등록)
  public/hanja-admin.html  관리 웹 — 단어장 업로드(붙여넣기·JSON)·목록·공개 범위·학생 배정·현황
```

```
for f in hanja/*.test.cjs; do node $f; done          # 순수 로직 테스트
node reading-server/hanja-api.test.mjs               # 서버 라우트 테스트
node hanja/book-validate.mjs <단어장.json|.txt> [--id <id> --title <제목>]   # 업로드 전 검사
```

## 단어장 (wordbook)

구매 교재의 낱말은 라이선스 자료라 **저장소·정적 자산에 없다.** 관리 웹 업로드로만 들어와 KV(`hanja:book:<id>`)에
살고, 학생은 토큰으로만 받는다. 목록(`hanja:books`)은 본문 없는 메타만 담는다.

관리 웹 붙여넣기 형식(워드브레인 배정과 같은 표기):

```
# 1일차                                   ← # 줄 = 새 단원(회차). 아래 줄이 그 단원에 든다
관측 | 보고 재는 것 | 觀(볼 관)+測(잴 측) | 별을 관측했다.     ← 낱말 | 뜻 | 한자(선택) | 예문(선택)
다잡다 | 흐트러진 마음을 단단히 하다 | 마음을 다잡고 앉았다.   ← 한자 없으면 고유어
觀 | 볼 관 | 25                            ← 첫 칸이 한자 한 글자면 한자 항목: 훈음 · 획수(선택)
```

JSON 모양(정규화 뒤 — `book-check.js` 머리말 참조):

```
{ id, title, publisher?, level?(L1~L4), note?,
  units: [{ id, title }],
  words: [{ id, unit, word, type:'hanja'|'native', hanja?, parts?:[{ch,hun,eum}], literal?, meaning, example?, syn? }],
  chars: [{ ch, hun, eum, strokes?, unit, medians?, words:[…], derived? }],
  strokes?: { "觀": 25 } }                  ← 낱말에서 끌어낸 글자에 획수를 붙일 때
```

- **id 는 영문·숫자·하이픈 3~60자** — 드라이브의 단어장 폴더 이름과 같게 둔다(`docs/자료-폴더-표준.md`).
- `chars` 는 두 갈래다. **직접 적은 글자**(한자 급수 교재)는 그 단원의 학습 항목이고, 낱말의 한자 분해에서
  **끌어낸 글자**(`derived`)는 낱말에 딸린 참고다 — 한자 탭에서 따라 쓰고, 「한자만」 훈련에 들어온다.
  한자어 교재의 낱말 12개가 한자 25자에 묻히지 않게 하려는 구분이다.
- `medians` = 획순 데이터(0~1 좌표의 획 중심선, 획 순서대로). **있는 글자만 획순 모드**가 열린다.
  체험 단어장의 一二三十人大天口日月木山川中土上下小火水 20자에 들어 있다.
- 검사 규칙(`checkBook`)은 오류(막음)와 경고(알림)를 가른다: 영어 낱말·뜻 없음·나쁜 한자·획수/획순 불일치는 오류,
  예문에 낱말이 안 보임·훈음 없음·목록에 없는 단원은 경고. 미리보기(dryRun)와 실제 업로드가 같은 판정이다.
- 공개 범위 `scope`: `all`(연동 학생 모두, 기본) · `assigned`(배정한 학생만 — 교재를 산 학생에게만 열 때).

## 학생 앱 동작

- **오늘**: 복습할 것(SRS 만기) · 현재 단어장·단원의 진도 · 새로 배우기 · 따라쓰기.
- **단어장**: 단어장 고르기(선생님 배정이 앞에, WB 기본 체험 단어장은 늘 마지막) → 단원 펼치기 → 낱말·한자 상세.
- **새로 배우기(심기)**: 한 자리에 8개. 카드(뜻·한자 조립·예문·듣기)를 보고 곧바로 확인 문항 하나(즉시 인출) → 심는다.
  첫 복습은 오늘 밤 9시.
- **한자**: 단원별 글자 타일. 세 번 쓰되 안내가 옅어진다(보고 → 흐릿 → 기억).
  - 획순 모드(`medians` 있음): 색 안내선을 따라 한 획씩. 획마다 자리·방향·순서를 판정하고 「획순 보기」로 순서를 본다.
  - 모양 모드: 옅은 안내 글자를 따라 쓰고 「확인」— 안내 글자 마스크와의 덮음률·새어 나간 잉크·잉크 과다·획수를 본다.
  - **획순 데이터가 없는 글자의 획순은 채점하지 않는다.** 없는 데이터로 틀렸다고 말하면 맞는 획순도 틀렸다고 하게 된다.
  - 처음 써 본 글자는 심어진다(그날 밤 훈음 문항으로 다시 만난다).
- **훈련**: 오늘 복습(모든 단어장) · 단원 · 단어장 전체 · 한자만. 계단이 오를수록 재인→회상→산출
  (뜻 고르기 → 낱말 고르기·한자 표기 → 문맥 빈칸·한자 조립 → 낱말 쓰기). 첫 시도 정답 good, 힌트 뒤 정답 hard, 오답 fail.
- **기록**: 낱말·한자·장기 기억·써 본 한자, 단어장별, 연동 상태.
- 상태는 기기(`wbhj.v1:<코드>`) 정본 + 연동 학생은 서버 백업(2.5초 디바운스, 400KB). 단어장 본문은 기기에 캐시하되
  자리가 없으면 다른 단어장 캐시부터 비운다.

SRS id 규약: 한자는 `c:<글자>`(단어장을 넘어 공용), 낱말은 `w:<단어장id>:<낱말id>`.

## 서버 API (hanja-api.mjs)

학생(토큰)
- `GET /books` → `{books:[메타 + mine], updatedAt}` — 공개 범위 `all` + 내게 배정된 것
- `GET /book?id=` → `{book, updatedAt}` — `assigned` 단어장은 배정받은 학생만(403)
- `GET /pull` → `{state, updatedAt}` · `PUT /state {state}` → `{ok, updatedAt}` (400KB)

관리(PIN)
- `POST /admin/book {book}` 또는 `{text, id, title, publisher?, level?, note?}` (+`dryRun`) → 검사 결과·저장.
  같은 id 는 덮어쓴다(공개 범위·배정 유지). 본문 2MB, 단어장 1.5MB.
- `GET /admin/books` · `GET /admin/book?id=` · `DELETE /admin/book {id}`(배정에서도 뺀다, 학생 기록은 남는다)
- `POST /admin/scope {id, scope}` · `POST /admin/assign {codes, bookIds, action:'add'|'remove'}` · `GET /admin/assign`
- `GET /admin/overview` → 학생별 `{words, chars, graduated, due, emergency, traced, streak, books, assigned, lastActive}`

저장: 워커 `hanja:book:<id>` · `hanja:books`(목록) · `hanja:state:<code>` · `hanja:assign:<code>` / 로컬 `db.hanja`.
백업 덤프(`dumpHanja`)는 단어장 본문을 싣지 않는다(내신 팩과 같은 이유). 퇴원은 `state`·`assign` 두 키만 지운다.
apps 게이트: `/api/hanja/*` 는 앱 이름 `hanja` (`haru-api.mjs appOfPath`).

## 백로그

- 획순 데이터 확충 — 원장이 검수한 글자부터 `medians` 를 붙인다(체험 단어장 20자가 형식 예시).
- 학부모 리포트 연동(진로독서 `/api/parent/summary` 에 한자 요약 한 줄).
- 강사가 단원 단위로 「이번 주 단원」을 지정해 오늘 화면 맨 위에 띄우기.
