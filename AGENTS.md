# wb-site — 에이전트 작업 안내

WB 독해력학원·웩슬러브레인센터의 원내 학습 웹앱 모음. 어떤 에이전트(Claude Code, Codex 등)든
이 문서와 각 앱의 문서를 읽고 같은 규칙으로 이어서 작업한다.

## 저장소 지도

| 경로 | 내용 |
|------|------|
| `reading/` | 진로독서 학생 앱 (정적 PWA) + 지문 데이터 |
| `vocab/` | 워드브레인 — 어휘 SRS 앱 (`srs.js`·`quiz.js`는 순수 로직 모듈) |
| `naesin/` | 내신브레인 — 영어 내신 시험대비 앱. **상세: `naesin/README.md`** |
| `haru/` | 하루브레인 — 삼육중 대비 3년 학습 앱(학생 `/haru/`·부모 `parent.html`) + 순수 로직(좌표·SRS·원인·페이스·생성기·리포트) + `atoms.json`(원자 목록, 문항 0). 팩·대응표·플랜·시험지는 저장소에 없다(KV·관리 웹 업로드). **상세: `haru/README.md`** |
| `reading-server/` | Cloudflare Worker(운영) + Node 로컬 서버 + 관리 웹(`public/`) + dist 조립 |
| `shared/` | 공용 모듈 (voice.js TTS, qr.js) |
| `docs/` | 기획서 모음 — 내신: `docs/영어내신-학습웹앱-기획서-v1.md` (v1.2) · 프로그램데스크: `docs/외부프로그램-자료운영-직원웹앱-기획제안-3안-v0.md` (§8 방향 변경·구현 현황) · v1 3안(직원의 관리자): `docs/프로그램데스크-기획서-v1.md` · 삼육중 대비(코드는 `haru/`): `docs/삼육중-*.md` — 정본은 `삼육중-대비-학습웹앱-기획서-v1.md`, 기술 명세는 `삼육중-대비-앱-설계안-v1.md`, 전형 사실은 `삼육중-전형-사실-정본-v1.md`만 인용. `삼육중-정보수집-로그.md`는 주간 자동 스윕이 쓴다(원장이 정본 후보를 체크해야 정본이 바뀐다) |
| `vocab-age/` | 어휘 나이 진단 (유일한 공개 페이지) |
| `desk/` | **프로그램데스크** — 학원과 별개 사업(구독 학생의 프로그램·자료 운영) 앱. 새 워커 `wb-desk` + 새 D1. **상세: `desk/README.md`** |
| `desk-ext/` | 프로그램데스크 크롬 확장(표 캡처, MV3). 학생 정보 없음. `desk/build.mjs`가 `dist/ext/`로 복사 |

## 명령

```
node <앱>/<이름>.test.cjs           # 단위 테스트 (의존성 없음, 파일별 실행)
node reading-server/<이름>.test.mjs # 서버 테스트
node reading-server/build-dist.mjs  # dist 조립 (+ SW 캐시 이름 스탬프)
PORT=8890 ADMIN_PIN=<pin> DATA_DIR=<dir> node reading-server/server.mjs  # 로컬 서버
node naesin/pack-validate.mjs <팩 디렉터리>  # 레슨 팩 검증
for f in haru/*.test.cjs haru/*.test.mjs; do node $f; done   # 하루브레인 순수 로직·달력·조판기
node reading-server/haru-score.test.mjs && node reading-server/haru-api.test.mjs   # 하루브레인 서버
node haru/sheet-build.mjs <팩.json> <출력 디렉터리> --frozen --key-id <id>   # 종이 회차 시험지·정답표·paperkey (저장소 밖에서)
```

CI: `.github/workflows/deploy-reading.yml` — **main 푸시가 곧 배포**다(테스트 전부 통과 시
Cloudflare Workers `wb-reading`으로). PR은 스쿼시 머지, 제목에 `(#번호)`가 남는 관례.

## 절대 규칙

1. **라이선스 콘텐츠를 저장소에 커밋하지 않는다.** 저장소는 public이다. 이그잼포유 팩,
   교재 코칭 원문(textbook.json), 학생 개인정보는 서버 저장소(KV / 로컬 db)에만 산다.
   원문·팩은 관리 웹 업로드로 들어간다. 시드·테스트 데이터는 자체 창작만
   (`naesin/pack-sample.json`이 그 예). **`docs/`에도 제3자 온라인 식별자를 쓰지 않는다** — 카페·블로그·
   지식iN의 개인 글 URL·아이디·글번호는 `[출처 Q-nnn]` 키로 적고 대응표는 저장소 밖(원장 드라이브)에 둔다.
   학원·언론·기관의 공식 자료 링크만 그대로 남긴다.
2. **하우스 스타일**: vanilla HTML/CSS/JS 정적 PWA, 순수 로직은 `'use strict'` + IIFE
   var 전역 + `module.exports` 가드(브라우저/Node 공용), 외부 의존성 없음, 한국어 주석은
   "왜"를 적는다. 새 로직 모듈에는 반드시 `.test.cjs`/`.test.mjs`를 같이 만든다.
3. **인증 없이 콘텐츠를 내보내지 않는다.** 학생 토큰(`wbr.auth`) 또는 관리 PIN 토큰.
   배포되는 `_headers`는 `reading/_headers` 하나다(noindex + 앱 경로 no-store) — `naesin/_headers`·
   `vocab/_headers`·`haru/_headers`는 그리로 안내하는 주석 파일이다. 내신 팩은 자기 시험 범위에 배정된 것만 받는다.
   하루브레인은 `GET /api/haru/pack`·`/gen`이 정답·해설·오답 태그를 뺀다(정답은 `/answer` 응답에만). 외부 초6 학생
   (`student.apps:['haru']`)은 호스트가 `who` 검증 직후 한 곳에서 거는 `allowedApp` 게이트로 다른 세 앱을 열지 못한다.
4. **서버 응답은 래핑 계약**: `/api/naesin/pack` → `{pack, updatedAt}`,
   `/state` → `{state, updatedAt}`, `/exam` → `{exam, scope}` — 클라이언트와 함께 맞춘다.
   학생이 올린 `state.summary`는 서버가 화이트리스트로 정규화하고 화면은 다시 이스케이프한다 —
   강사 화면은 학생 기기가 올린 값을 그리는 곳이라 두 겹을 모두 유지한다.
5. 배포 자산 캐시는 `build-dist.mjs`가 내용 해시로 스탬프한다 — SW `VERSION`을 손으로
   만지지 않는다.

## 운영 주소 (원내 전용 — 링크 외부 공유 금지)

- 학생: `/` 진로독서 · `/vocab/` 워드브레인 · `/naesin/` 내신브레인 · `/haru/` 하루브레인(부모 `/haru/parent.html?t=`)
- 관리: `/admin/` 진로독서(+교재 코칭 원문 업로드) · `/admin/naesin-admin.html` 내신브레인
  (팩 업로드·시험 등록·반 성취도) · `/admin/haru-admin.html` 하루브레인(코치 보드·등록·팩/대응표/플랜·종이 회수·파기)
- 베이스: `https://wb-reading.whdudwns33.workers.dev`

## 진행 중인 큰 작업: 내신브레인

기획서 v1.2(`docs/`)가 정본, 구현 현황과 다음 단계는 `naesin/README.md`의
"현재 상태 / Phase 2 백로그" 절을 본다. 팩(콘텐츠) 제작 파이프라인 절차도 그 문서에 있다.
