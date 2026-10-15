# 작업 지침 (Codex·Claude Code 등 모든 코딩 에이전트 공용)

이 저장소는 WB 웩슬러브레인센터의 공개 사이트다. GitHub Pages가 `main`을 서비스한다.
**컨설팅 워크벤치**(`workbench/`) 작업이 대부분이며, 아래 규칙은 필수다.

> **처음 인계받은 에이전트는 [`workbench/HANDOFF.md`](workbench/HANDOFF.md)를 먼저 읽는다** — 현재 상태·할 일·사고 기록·코드 지도.

## 브랜치 규칙
- 워크벤치 **소스 작업은 전부 `claude/agent-performance-optimization-rj8ql6` 브랜치**에서 한다.
- `main`에는 워크벤치 관련으로 **암호화 배포본 두 파일(`workbench/index.html`, `workbench/bulk.enc.json`)만** 올린다
  — 다른 워크벤치 파일을 main에 커밋하지 말 것. main의 나머지 파일들(apps/, consult/ 등)은 별개 프로젝트다.

## 시작하기 / 빌드 / 배포
`workbench/src/README.md`의 절차를 그대로 따른다. 요약:
이미 준비된 `WB_PASSWORD` 환경변수를 사용한다. 비어 있으면 중단하고 알린다. 비밀번호를 채팅으로 묻거나 명령 문자열·화면·로그에 쓰지 않는다.

1. 작업 브랜치에서 `node workbench/src/check-password.mjs` 통과 → `workbench/backup/README.md`의 복원 명령 2개로
   gitignored 비공개 파일(`private-seed.json`, `bulk-data.json`) 복원. 복원 명령도 기존 `WB_PASSWORD`를 사용한다.
2. `workbench/src/app.html` 또는 데이터 수정 → `node workbench/src/check-names.mjs` 0건 확인.
   **데이터를 바꿨다면 `backup-encrypt.mjs`로 해당 백업을 재암호화하고 작업 브랜치에 커밋·푸시한 뒤**
   `node workbench/src/build.mjs` → 출력의 "복호화 검증: 일치 ✓" 확인 → 로컬 화면 확인.
   ⚠ build.mjs 의 "일치 ✓" 는 **비밀번호가 틀려도 뜬다** — 넘겨준 값으로 암호화하고 같은 값으로 되읽기 때문.
   틀린 값으로 배포하면 원장이 기존 비밀번호로 못 여는 앱이 올라간다. check-password.mjs 는 백업을 실제로
   복호화해 보므로 이것만이 진짜 검증이다.
3. 원장이 명시적으로 **"배포해"라고 한 뒤에만** 작업 브랜치에 소스와 빌드 산출물을 커밋·푸시한다.
   최신 `origin/main` 기반 별도 배포 브랜치(worktree 사용 권장)에 `workbench/index.html`·`workbench/bulk.enc.json`
   두 파일만 담은 PR을 열고, checks 통과 후 스쿼시 병합한다. **main 직접 푸시 금지.** 병합 권한이 없으면 PR 주소만 보고한다.
   병합 1~2분 뒤 라이브 `index.html`과 `bulk.enc.json?v=<빌드 태그>`의 SHA-256을 로컬 두 파일과 대조한다.
   **⚠ 두 파일은 반드시 함께 배포** — 같은 비밀번호·KDF 설정에서는 키를 유지해도 빌드 태그가
   어긋나면 대량 데이터 로드를 거부한다(2026-09-02에는 키 불일치 사고). 라이브 해시는 index.html과 bulk.enc.json
   **둘 다** 대조할 것. 앱은 빌드 태그(BUILD_TAG ↔ bulk의 t 필드)로 불일치를 감지해 경고를 띄운다.
4. 원장 데이터 반영: Drive `WB_워크벤치_백업` 폴더의 최신 `wb-consulting-backup-*.json`을 받아
   `node workbench/src/seed-from-backup.mjs <백업파일>` → `backup-encrypt.mjs seed`로 재암호화·커밋·푸시 → 재빌드 → 화면 확인 → 승인 후 두 파일 PR 배포 →
   `workbench/backup/last-drive-import.json`(fileId·modifiedTime) 갱신. 매일 아침 루틴과 같은 파일을 다루므로 아래 병행 작업 시간을 지킨다.

## 병행 작업 규칙 (Claude 세션·Codex·다른 컴퓨터가 같이 쓸 때)
- **작업 시작 전 반드시 `git pull origin claude/agent-performance-optimization-rj8ql6`** — 자동 루틴이 커밋을 만든다.
- 자동 루틴 시간대 **매일 07:50~08:15 KST**(Drive 백업 반영·수행평가)와 **매년 6월 1일 오전**(진학 실적 재수집)에는
  워크벤치 소스를 건드리지 않는다. 겹치면 푸시 거부·짝 불일치 배포가 날 수 있다.
- 배포(PR 병합)는 한 번에 한 주체만. 배포 직후 라이브 해시 2개(index·bulk) 대조를 끝내기 전에는 다른 주체가 배포하지 않는다.
- 충돌이 나면 `app.html`은 수동 병합(자동 병합 금지 — 단일 파일이라 조용히 깨진다), `index.html`·`bulk.enc.json`은 병합하지 말고 재빌드로 다시 만든다.
- 비공개 파일(`private-seed.json`·`bulk-data.json`)을 바꾼 주체가 `backup/*.enc.json` 재암호화까지 책임진다 —
  `node workbench/src/backup-encrypt.mjs`로 재암호화하고 **재빌드보다 먼저 커밋·푸시**한다.

## 절대 규칙 (위반 시 커밋 금지)
1. **공개 파일에 학생 실명·연락처 0건.** `app.html`·문서·커밋 메시지 포함.
   검사: `node workbench/src/check-names.mjs` → "실명 검사 ✓ — 0건". 이름은 비공개 시드에서 읽는다 —
   **이름 목록을 문서·코드에 직접 적지 말 것** (그 자체가 공개 저장소 노출이다).
2. **비밀번호를 코드·문서·커밋에 적지 않는다.** 환경변수로만 사용.
   앱 빌드의 공개 KDF 설정은 `workbench/src/encryption-config.json`에 유지하며 빌드마다 다시 만들지 않는다.
   앱·bulk는 암호화할 때마다 각각 새 무작위 96비트 IV를 사용한다. 백업의 무작위 salt·IV는 별도이며 변경하지 않는다.
3. **`private-seed.json`·`bulk-data.json`을 평문으로 커밋하지 않는다** (.gitignore 유지).
   내용을 바꿨으면 `workbench/backup/*.enc.json`을 재암호화해 재빌드 전에 커밋·푸시한다 (`backup-encrypt.mjs`).
4. **입결 대량 데이터(어디가 재정리본)를 평문으로 공개 위치에 내보내지 않는다** — 약관상 재배포 금지.
5. `workbench/index.html`은 자동 생성물 — 직접 수정 금지, 항상 build.mjs로 재생성.

## 코드 컨벤션 (app.html)
- 단일 HTML + 바닐라 JS. 프레임워크·외부 CDN·빌드 도구 추가 금지.
- 테마: 모든 색은 CSS 토큰(`:root` 3블록 — 라이트/`prefers-color-scheme: dark`/`[data-theme="dark"]`)으로.
  사이드바(어두운 판) 안에서는 `--side-*` 토큰만 쓴다. `--shadow`는 none — 다른 그림자와 쉼표로 합치지 말 것.
  강조색 배경 위 글자는 `var(--on-accent)`.
- 글자 크기는 **`--fs-xs/sm/md/lg/xl`(11.5/12.5/14/16/22px) 5단계만** — 새 px 값을 만들지 말 것.
  간격은 4px 격자(`--sp-1`~`--sp-6` = 4·8·12·16·24·32). 제목에 장식 이모지를 넣지 않는다(순서 표시 1️⃣·①은 허용).
- 데이터 접근: 대량 입결은 `allIpRows()`/`ipGroups()`(캐시 — `save()`가 무효화), 고교는 `allHsRows()`.
- 판정 로직: 수시=등급(`classify`), 정시=수능 백분위(`classifyPct`), 변환은 `gradeToTopPct`/`topPctToGrade`(CUM9).
- 문구 원칙: 분석 결과는 "예측"이 아니라 "상담용 참고치"로 표기, 출처(어디가·연도) 명시.

## 검증
- 최소: 빌드 자가검증 통과 + 실명 검사 0건.
- 화면 확인: 원장이 직접 로그인 → 학생 14명 → 고교 카드의 공시 성취도 → 다크 모드를 확인한다. 스크린샷은 만들지 않는다.
- 라이브 확인: `index.html`·`bulk.enc.json?v=<빌드 태그>`의 SHA-256이 로컬 두 파일과 모두 일치해야 한다.

## 백업 체계 (건드리기 전에 알아둘 것)
① main의 암호화 배포본(라이브) ② 작업 브랜치 `workbench/backup/*.enc.json`(+README)
③ Google Drive `WB_스킬교체_20260813` 폴더(파서·레시피·시드 사본) ④ Claude 비공개 아티팩트(데이터 내장).
②의 파일들이 정본 백업이다 — 시드·대량 데이터를 바꾸면 반드시 갱신한다.
