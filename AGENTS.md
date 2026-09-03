# 작업 지침 (Codex·Claude Code 등 모든 코딩 에이전트 공용)

이 저장소는 WB 웩슬러브레인센터의 공개 사이트다. GitHub Pages가 `main`을 서비스한다.
**컨설팅 워크벤치**(`workbench/`) 작업이 대부분이며, 아래 규칙은 필수다.

## 브랜치 규칙
- 워크벤치 **소스 작업은 전부 `claude/agent-performance-optimization-rj8ql6` 브랜치**에서 한다.
- `main`에는 워크벤치 관련으로 **암호화 배포본 두 파일(`workbench/index.html`, `workbench/bulk.enc.json`)만** 올린다
  — 다른 워크벤치 파일을 main에 커밋하지 말 것. main의 나머지 파일들(apps/, consult/ 등)은 별개 프로젝트다.

## 시작하기 / 빌드 / 배포
`workbench/src/README.md`의 절차를 그대로 따른다. 요약:
1. 작업 브랜치 체크아웃 → `workbench/backup/README.md`의 복원 명령 2개로 gitignored 비공개 파일
   (`private-seed.json`, `bulk-data.json`) 복원. 복호화 키 = 워크벤치 접속 비밀번호 (원장에게 확인).
2. `workbench/src/app.html` 수정 → `WB_PASSWORD='...' node workbench/src/build.mjs`
   → 출력의 "복호화 검증: 일치 ✓" 확인.
3. 배포는 main에 index.html + bulk.enc.json (worktree 사용 권장), 배포 후 라이브 URL 해시 대조.
   **⚠ 두 파일은 반드시 함께 배포** — 암호화 키가 빌드마다 바뀌어 짝이 어긋나면 전 기기에서
   대량 데이터 로드가 실패한다(2026-09-02 실제 사고). 라이브 해시는 index.html과 bulk.enc.json
   **둘 다** 대조할 것. 앱은 빌드 태그(BUILD_TAG ↔ bulk의 t 필드)로 불일치를 감지해 경고를 띄운다.
4. 원장 데이터 반영: Drive `WB_워크벤치_백업` 폴더의 최신 `wb-consulting-backup-*.json`을 받아
   `node workbench/src/seed-from-backup.mjs <백업파일>` → 재빌드 → 두 파일 배포 →
   `workbench/backup/private-seed.enc.json` 재암호화 커밋(backup/README) →
   `workbench/backup/last-drive-import.json`(fileId·modifiedTime) 갱신. 매일 아침 루틴이 이를 자동 수행한다.

## 병행 작업 규칙 (Claude 세션·Codex·다른 컴퓨터가 같이 쓸 때)
- **작업 시작 전 반드시 `git pull origin claude/agent-performance-optimization-rj8ql6`** — 자동 루틴이 커밋을 만든다.
- 자동 루틴 시간대 **매일 07:50~08:15 KST**(Drive 백업 반영·수행평가)와 **매년 6월 1일 오전**(진학 실적 재수집)에는
  워크벤치 소스를 건드리지 않는다. 겹치면 푸시 거부·짝 불일치 배포가 날 수 있다.
- 배포(main 푸시)는 한 번에 한 주체만. 배포 직후 라이브 해시 2개(index·bulk) 대조를 끝내기 전에는 다른 주체가 배포하지 않는다.
- 충돌이 나면 `app.html`은 수동 병합(자동 병합 금지 — 단일 파일이라 조용히 깨진다), `index.html`·`bulk.enc.json`은 병합하지 말고 재빌드로 다시 만든다.
- 비공개 파일(`private-seed.json`·`bulk-data.json`)을 바꾼 주체가 `backup/*.enc.json` 재암호화까지 책임진다.

## 절대 규칙 (위반 시 커밋 금지)
1. **공개 파일에 학생 실명·연락처 0건.** `app.html`·문서·커밋 메시지 포함.
   검사: `grep -c "한수빈\|박세윤\|조유빈\|강준서\|마윤서\|김아린\|강현서\|김태련\|고현준\|오수아\|남혁준\|윤시현" workbench/src/app.html` → 0.
2. **비밀번호를 코드·문서·커밋에 적지 않는다.** 환경변수로만 사용.
3. **`private-seed.json`·`bulk-data.json`을 평문으로 커밋하지 않는다** (.gitignore 유지).
   내용을 바꿨으면 `workbench/backup/*.enc.json`을 재암호화해 함께 커밋한다 (backup/README 참조).
4. **입결 대량 데이터(어디가 재정리본)를 평문으로 공개 위치에 내보내지 않는다** — 약관상 재배포 금지.
5. `workbench/index.html`은 자동 생성물 — 직접 수정 금지, 항상 build.mjs로 재생성.

## 코드 컨벤션 (app.html)
- 단일 HTML + 바닐라 JS. 프레임워크·외부 CDN·빌드 도구 추가 금지.
- 테마: 모든 색은 CSS 토큰(`:root` 3블록 — 라이트/`prefers-color-scheme: dark`/`[data-theme="dark"]`)으로.
- 데이터 접근: 대량 입결은 `allIpRows()`/`ipGroups()`(캐시 — `save()`가 무효화), 고교는 `allHsRows()`.
- 판정 로직: 수시=등급(`classify`), 정시=수능 백분위(`classifyPct`), 변환은 `gradeToTopPct`/`topPctToGrade`(CUM9).
- 문구 원칙: 분석 결과는 "예측"이 아니라 "상담용 참고치"로 표기, 출처(어디가·연도) 명시.

## 검증
- 최소: 빌드 자가검증 통과 + 실명 검사 0건.
- 권장: Playwright(Chromium)로 배포본 열어 로그인 → 학생 14명 렌더 → 바꾼 화면 동작 → JS 오류 0 확인.
- 라이브 확인: `curl -sS https://whdudwns33-wb.github.io/wb-site/workbench/ | sha256sum` = 로컬 index.html 해시.

## 백업 체계 (건드리기 전에 알아둘 것)
① main의 암호화 배포본(라이브) ② 작업 브랜치 `workbench/backup/*.enc.json`(+README)
③ Google Drive `WB_스킬교체_20260813` 폴더(파서·레시피·시드 사본) ④ Claude 비공개 아티팩트(데이터 내장).
②의 파일들이 정본 백업이다 — 시드·대량 데이터를 바꾸면 반드시 갱신한다.
