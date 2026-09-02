# wb-site — 에이전트 작업 안내

WB 독해력학원·웩슬러브레인센터의 원내 학습 웹앱 모음. 어떤 에이전트(Claude Code, Codex 등)든
이 문서와 각 앱의 문서를 읽고 같은 규칙으로 이어서 작업한다.

## 저장소 지도

| 경로 | 내용 |
|------|------|
| `reading/` | 진로독서 학생 앱 (정적 PWA) + 지문 데이터 |
| `vocab/` | 워드브레인 — 어휘 SRS 앱 (`srs.js`·`quiz.js`는 순수 로직 모듈) |
| `naesin/` | 내신브레인 — 영어 내신 시험대비 앱. **상세: `naesin/README.md`** |
| `reading-server/` | Cloudflare Worker(운영) + Node 로컬 서버 + 관리 웹(`public/`) + dist 조립 |
| `shared/` | 공용 모듈 (voice.js TTS, qr.js) |
| `docs/` | 기획서 모음 — 내신: `docs/영어내신-학습웹앱-기획서-v1.md` (v1.2) |
| `vocab-age/` | 어휘 나이 진단 (유일한 공개 페이지) |

## 명령

```
node <앱>/<이름>.test.cjs           # 단위 테스트 (의존성 없음, 파일별 실행)
node reading-server/<이름>.test.mjs # 서버 테스트
node reading-server/build-dist.mjs  # dist 조립 (+ SW 캐시 이름 스탬프)
PORT=8890 ADMIN_PIN=<pin> DATA_DIR=<dir> node reading-server/server.mjs  # 로컬 서버
node naesin/pack-validate.mjs <팩 디렉터리>  # 레슨 팩 검증
```

CI: `.github/workflows/deploy-reading.yml` — **main 푸시가 곧 배포**다(테스트 전부 통과 시
Cloudflare Workers `wb-reading`으로). PR은 스쿼시 머지, 제목에 `(#번호)`가 남는 관례.

## 절대 규칙

1. **라이선스 콘텐츠를 저장소에 커밋하지 않는다.** 저장소는 public이다. 이그잼포유 팩,
   교재 코칭 원문(textbook.json), 학생 개인정보는 서버 저장소(KV / 로컬 db)에만 산다.
   원문·팩은 관리 웹 업로드로 들어간다. 시드·테스트 데이터는 자체 창작만
   (`naesin/pack-sample.json`이 그 예).
2. **하우스 스타일**: vanilla HTML/CSS/JS 정적 PWA, 순수 로직은 `'use strict'` + IIFE
   var 전역 + `module.exports` 가드(브라우저/Node 공용), 외부 의존성 없음, 한국어 주석은
   "왜"를 적는다. 새 로직 모듈에는 반드시 `.test.cjs`/`.test.mjs`를 같이 만든다.
3. **인증 없이 콘텐츠를 내보내지 않는다.** 학생 토큰(`wbr.auth`) 또는 관리 PIN 토큰.
   모든 앱 `_headers`는 noindex + no-store.
4. **서버 응답은 래핑 계약**: `/api/naesin/pack` → `{pack, updatedAt}`,
   `/state` → `{state, updatedAt}`, `/exam` → `{exam, scope}` — 클라이언트와 함께 맞춘다.
5. 배포 자산 캐시는 `build-dist.mjs`가 내용 해시로 스탬프한다 — SW `VERSION`을 손으로
   만지지 않는다.

## 운영 주소 (원내 전용 — 링크 외부 공유 금지)

- 학생: `/` 진로독서 · `/vocab/` 워드브레인 · `/naesin/` 내신브레인
- 관리: `/admin/` 진로독서(+교재 코칭 원문 업로드) · `/admin/naesin-admin.html` 내신브레인
  (팩 업로드·시험 등록·반 성취도)
- 베이스: `https://wb-reading.whdudwns33.workers.dev`

## 진행 중인 큰 작업: 내신브레인

기획서 v1.2(`docs/`)가 정본, 구현 현황과 다음 단계는 `naesin/README.md`의
"현재 상태 / Phase 2 백로그" 절을 본다. 팩(콘텐츠) 제작 파이프라인 절차도 그 문서에 있다.
