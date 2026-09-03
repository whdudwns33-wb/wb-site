# wb-site — 에이전트 작업 안내

WB 독해력학원·웩슬러브레인센터의 원내 학습 웹앱 모음. 어떤 에이전트(Claude Code, Codex 등)든
이 문서와 각 앱의 문서를 읽고 같은 규칙으로 이어서 작업한다.

## 저장소 지도

| 경로 | 내용 |
|------|------|
| `reading/` | 진로독서 학생 앱 (정적 PWA) + 지문 데이터 |
| `vocab/` | 워드브레인 — 어휘 SRS 앱 (`srs.js`·`quiz.js`는 순수 로직 모듈) |
| `naesin/` | 내신브레인 — 영어 내신 시험대비 앱. **상세: `naesin/README.md`** |
| `naesin-ko/` | 국어브레인 — 국어 내신 시험대비 앱. **상세: `naesin-ko/README.md`** |
| `reading-server/` | Cloudflare Worker(운영) + Node 로컬 서버 + 관리 웹(`public/`) + dist 조립 |
| `shared/` | 공용 모듈 (voice.js TTS, qr.js) |
| `docs/` | 기획서 + 자료 폴더 표준(`자료-폴더-표준.md`) — 내신 영어: `docs/영어내신-학습웹앱-기획서-v1.md` (v1.2) · 내신 국어: `docs/국어내신-학습웹앱-기획서-v1.md` (v1.0, 기획 단계) |
| `vocab-age/` | 어휘 나이 진단 (유일한 공개 페이지) |

## 명령

```
node <앱>/<이름>.test.cjs           # 단위 테스트 (의존성 없음, 파일별 실행)
node reading-server/<이름>.test.mjs # 서버 테스트
node reading-server/build-dist.mjs  # dist 조립 (+ SW 캐시 이름 스탬프)
PORT=8890 ADMIN_PIN=<pin> DATA_DIR=<dir> node reading-server/server.mjs  # 로컬 서버
node naesin/pack-validate.mjs <팩 디렉터리>     # 영어 레슨 팩 검증
node naesin-ko/pack-validate.mjs <팩 디렉터리>  # 국어 단원 팩 검증
node naesin-ko/extract/build-pack.mjs <단원 폴더>       # 국어: 폴더 하나 → 팩 초안 (시리즈 자동 판별)
python3 naesin-ko/extract/pdf-spans.py <PDF> --colors  # 새 출판사 자료 색 팔레트 점검
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
4. **서버 응답은 래핑 계약**: 경로 명사 = 응답 키, `scope`는 학생→default 폴백 표시다.
   `/pack` → `{pack, updatedAt}` · `/state` → `{state, updatedAt}` · `/exam` → `{exam, scope}` ·
   `/task` → `{task, scope}` · (국어) `/overlay` → `{overlay, scope}` · `/review` → `{reviews, updatedAt}`.
   클라이언트와 함께 맞춘다.
5. 배포 자산 캐시는 `build-dist.mjs`가 내용 해시로 스탬프한다 — SW `VERSION`을 손으로
   만지지 않는다.

## 운영 주소 (원내 전용 — 링크 외부 공유 금지)

- 학생: `/` 진로독서 · `/vocab/` 워드브레인 · `/naesin/` 내신브레인(영어) · `/naesin-ko/` 국어브레인
- 관리: `/admin/` 진로독서(+교재 코칭 원문 업로드) · `/admin/naesin-admin.html` 내신브레인
  (팩 업로드·시험 등록·반 성취도) · `/admin/naesin-ko-admin.html` 국어브레인
  (팩 업로드·시험 등록·과제 배정·학교 오버레이·서술형 검토)
- 베이스: `https://wb-reading.whdudwns33.workers.dev`

## 진행 중인 큰 작업: 내신브레인

기획서 v1.2(`docs/`)가 정본, 구현 현황과 다음 단계는 `naesin/README.md`의
"현재 상태 / Phase 2 백로그" 절을 본다. 팩(콘텐츠) 제작 파이프라인 절차도 그 문서에 있다.

## 진행 중인 큰 작업: 국어브레인 (Phase 1a 완료)

정본 기획서 `docs/국어내신-학습웹앱-기획서-v1.md` (v1.1), 구현 현황은 `naesin-ko/README.md`.
영어 앱의 형제이지만 **학습 모델이 다르다**: 게이트가 어휘가 아니라 '구절 적용 정답률'이고,
사다리는 5단계(읽기→개념 빈칸→구절 적용→주석 복원→서술형)이며, 서술형 루브릭 채점이 핵심이다.

라이선스: **권리 두 갈래 모두 해소됐다**(2026-09-03 원장 회신). 트랙 A — 족보닷컴 "학원 내부 무료 사용은
상관없다"(§10-1). 트랙 B — 원작자 관련도 족보닷컴이 문제 없게 해결(§10-2). 팩 배포·원문 표시가 열렸고
남은 것은 **회신본 서면 보관**이다. 그래도 원문 없이 위치 참조만으로 성립하는 설계는 지우지 않는다 —
이용권·출판사가 바뀌면 다시 쓴다.

**자료를 올리는 자리와 이름 규칙은 `docs/자료-폴더-표준.md`, 추출 절차는
`naesin-ko/extract/README.md` 가 정본이다.** 구글 드라이브 공유 폴더 하나 아래 앱별로 폴더를 나누되
이름을 저장소 디렉터리와 같게 두고(`naesin-ko/`·`naesin/`…), **단원 폴더 이름을 곧 팩 id로** 쓴다.
PDF 파일명은 도구가 보지 않는다 — 드라이브에서 한글이 깨지므로 시리즈는 **지면 내용**으로 판별한다.

족보닷컴 4종(이해완성·직전 요약노트·단원집중·서술형 공략) 추출기가 다 있고 `build-pack.mjs` 가 묶어
부른다. 빈칸 정답은 도형이 아니라 지면의 **흰 글씨 텍스트**다. 공용 규칙(시리즈 판별·공백 복원·
연 나누기·id 규약)은 `extract/spans-util.mjs` 하나에 모은다 — 추출기가 각자 다시 구현하면 안 된다.
추출은 전부 오프라인 로컬 도구다 — **구매 자료를 외부 AI API로 보내지 않는다.**

추출기가 지키는 두 가지: ① **검수 부속물은 팩에 넣지 않는다**(병합기가 알 수 없는 최상위 키를 팩 루트로
복사해 학생 기기까지 간다) ② **못 뽑은 것은 조용히 넘기지 않는다** — 지문 없는 문항·루브릭 없는 서술형·
대조 미달은 `review/` 로 내리고 이유를 남긴다.

학생 성취·시험대비 수치화는 `naesin-ko/readiness.js`(준비도 0~100 + 반 집계) 하나로 모은다 —
학생 앱 성취도 탭과 관리 웹 반 성취도가 같은 모듈을 쓴다.
