# chunk/ — 청크브레인 작업 규칙 (Codex·Claude Code 공용)

유치(5~7세) + 초1~고3, 모두 13단계(`K`·`G1`~`G12`)로 **의미 단위 끊어읽기**를 배우고 연습하고 복습하는
원내 학습 PWA. 교재는 `print.html` 브라우저 인쇄 → PDF, 수업은 `class.html`(프로젝터).

**읽는 순서**: 저장소 루트 `AGENTS.md`(= `CLAUDE.md`, 최상위 규칙) → `chunk/README.md`(이 앱의 정본 문서,
파일별 역할·설계 근거·데이터 형식이 전부 여기 있다) → 고칠 파일. 이 문서는 **조용히 깨지는 자리**만 적는다.

## 고치기 전에 돌리는 것

```
for f in chunk/*.test.cjs; do node $f; done && node reading-server/chunk-api.test.mjs
node reading-server/override.test.mjs            # 워커·로컬 저장 어댑터 짝 검사
node reading-server/build-dist.mjs && node reading-server/dist-cache.test.mjs
PORT=8890 ADMIN_PIN=<pin> DATA_DIR=<dir> node reading-server/server.mjs   # → http://localhost:8890/chunk/
```

`main` 푸시가 곧 배포다. 테스트가 빨간 채로 머지하면 학생 화면이 바로 그 상태가 된다.

## 조용히 깨지는 자리

1. **채점(`explain`)과 초안(`autoChunk`)은 다른 것이다.** `autoChunk`·`draftParagraphs`는 글을 만들 때
   쓰는 초안 생성기라 보수적으로 끊는다(조사·어미 뒤에서만). 이 보수적 게이트를 채점 쪽으로 옮기면
   **학생이 옳게 끊은 자리를 틀렸다고 하게 된다.** 채점은 모범 경계와의 일치로만 나와야 한다.

2. **지문 조각은 공백을 품는다.** `segs.join('') === 원문` 이 성립해야 하고 마지막 조각만 공백이 없다.
   `content.test.cjs` 가 편마다 검사한다. 손으로 조각을 고칠 때 공백을 흘리면 화면에서 낱말이 붙어 버린다.

3. **저장 어댑터는 두 파일에 짝으로 있어야 한다.** `reading-server/worker.mjs`(운영)와 `server.mjs`(로컬)의
   `chunkStore` 에 메서드를 더할 때 한쪽만 고치면 운영에서만 터진다. `override.test.mjs` 가 짝을 검사한다.

4. **새 테스트 파일을 만들면 CI 에 스텝을 더한다.** `.github/workflows/deploy-reading.yml` 의 청크 스텝은
   파일 이름을 하나씩 적는 방식이라, 새 파일은 적지 않으면 CI 에서 영영 안 돈다.

5. **서비스 워커 `VERSION` 을 손으로 만지지 않는다.** `build-dist.mjs` 가 내용 해시로 스탬프한다.
   손으로 적으면 내용이 바뀌어도 학생 기기가 옛 화면을 계속 쓴다.

6. **가족 링크 토큰은 진로독서 학부모 토큰 그대로다**(`parent:<t>` — 브레인레터와 같은 것, 가정마다 링크 하나).
   `/chunk/?t=` 로 들어온 기기는 로그인 없이 자녀 기록을 읽고 쓰므로, `/api/chunk/parent*` 는 호스트가
   `who` 검증 **전에** 넘긴다. 이 갈래를 일반 학생 라우트로 합치면 가족 모드가 401 로 죽는다.

7. **응답 키는 경로 명사와 같다**(루트 규칙 4). `/state` → `{state, updatedAt}`, `/custom` → `{custom, …}`,
   `/parent` → `{parent, assign, custom, …}`. 바꾸려면 클라이언트·서버·테스트를 한 커밋에서 함께 고친다.

8. **지문·규칙 카드는 자체 창작만 커밋한다**(루트 규칙 1 — 저장소는 public). 출판 교재·문제집에서
   베껴 오지 않는다. 학원이 쓰는 글은 관리 웹 「글 저작」으로 서버에만 올린다.

## 화면 고칠 때

`index.html`·`print.html`·`class.html` 은 각각 한 파일짜리 앱이다. 화면은 `render()` 가 문자열로 그리고
클릭은 `data-act` 위임 하나로 받는다. **틈(`gap`)을 한 번 누를 때마다 화면을 통째로 다시 그리므로**
DOM 핸들을 들고 있다가 다시 쓰면 안 된다(자동화 테스트도 매번 다시 찾아야 한다).

`class.html` 에는 이 한 줄이 반드시 있어야 한다 — 없으면 숨긴 팝업이 화면 전체를 덮어 수업 중에 먹통이 된다.

```css
.sheet[hidden] { display:none; }
```

## 손대지 않는 것

옆 앱(`reading/`·`vocab/`·`naesin/`·`naesin-ko/`·`haru/`·`letter/`·`hanja/`)은 요청받은 범위가 아니면
건드리지 않는다. 배포되는 헤더는 `reading/_headers` 하나이고 `chunk/_headers` 는 그리로 안내하는 주석 파일이다.
