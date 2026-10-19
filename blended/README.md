# 블렌디드 플래너

기존 컨설팅 플래너를 유지한 별도 앱. 현재 학원 원본·외부 학습 성적·실제 메시지 발송은 미연동이다.
2026-10-19 사용자 추가 요청으로 **외부 배포·개별 로그인·강사 등록**까지 범위를 확대했다.
원장 아이디는 `whdudwns33`, 전용 주소는 `https://blended.wbcowork.com/blended/`다.
배포 실행 결과와 검증 내역은 [완료 보고](./RESULTS.md)에 기록한다.

후속 요청은 **원본 기능 최대한 유지 + 블렌디드 권한·상담 추가**, **학사관리와 일정을 ‘일정·학사’로 통합**이다.
로그인하면 `/blended/planner/`에서 원본 오늘·주간·로드맵·인강·학습 화면을 연다.
상담·리포트와 강사·학생 관리는 같은 로그인으로 이어지며 선택한 학생을 유지한다.
월간 달력과 시험·수행평가·자료 요청은 한 메뉴 안의 두 보기다.

## 공통 글꼴·크기 후속 (2026-10-19)

학원 `https://blended-academy.wbcowork.com/ops/pads`와 플래너·상담 화면을 같은 시스템 한글 글꼴, 화면 제목26/카드18/본문16/조작15/설명14/입력16px으로 통일했다. 학원 직원 화면만 밝은 배경·남색·보라로 맞추고 기존 기능과 학부모/학생 테마는 유지했다. 가상 학원 견본 localhost:8894가 실행 중일 때 `node blended/typography-browser.cjs`로 계산된 크기·글꼴을 비교한다. 실행 의존성은 아래 기존 Playwright 설정을 따른다.

## 디자인 개선 (2026-10-19)

학생·강사 양쪽에 전체 메뉴, 역할별 작업 우선순위, 상담/피드백 미저장 닫기 확인, 공통 색·글꼴·메뉴, 모바일 글자·터치 크기 개선을 적용했다. 포인트·스탬프는 접어서 열며 기존 기능은 유지한다. 학원 앱 쪽 공통 톤 반영은 [별도 요청서](./ACADEMY_REQUEST.md)에 기록했다.

## 구현 범위와 원본 보존

- 조사 기준/개발 시작점: `60df731b489603cf4afe296e6f384e6284b1289c`.
- 별도 작업 트리: `C:\Users\wb\Projects\wb-site-blended-20261019`.
- 브랜치: `codex/blended-planner-local-20261019`.
- 기존 작업본 `C:\Users\wb\Projects\wb-site`의 consult·task 미커밋 변경은 읽기만 했다. 해당 작업본의 체크아웃/reset/수정을 하지 않았다.
- `consult/`, `sync/`, `parent/`, 학원 원본 앱, 기존 DB/R2/시크릿은 변경하지 않는다. 공통 모듈을 광범위하게 분리하지 않는다.
- 재사용: `consult/index.html`을 빌드 때 읽어 원본 CSS·학습 로직을 조립한다. 원본 파일은 수정하지 않고 `planner-build.mjs`에서 초기화·통신 연결만 교체한다. `planner-adapter.js`가 전용 로그인·저장·통합 메뉴·강사 확인을 연결한다. 생성물은 커밋하지 않는다. 원본 연결 지점이 달라지면 빌드가 실패한다.
- 영향 범위: 새 화면·API·로컬/클라우드 DB·가상 자료·시험·배포 설정·보호자 읽기 화면·공개 리포트 응답. 기존 호출부/내보내기/Worker 설정은 변경하지 않는다. 루트 `AGENTS.md`와 `CLAUDE.md` 지도에 동일한 앱 설명 한 줄을 추가했다.
- 설계: 남색 `#1b3a5c`, 보라색 `#6d28d9`, 밝은 배경 `#f7f7fa`, 보조 배경 `#f0ebf8`, 경계 `#d5d3df`. `ui.css`와 `navigation.js`로 원본 연결 플래너·상담 화면의 톤과 메뉴를 맞췄다. 기기 기본 한국어 글꼴, 좌측 학습 목록/우측 실제 순서 안내, 모바일 세로 전환. 외부 브랜드/유료 콘텐츠를 복제하지 않았다.

## 실행

Node 24 이상. 새 npm 의존성 없이 로컬 실행:

```powershell
Set-Location C:\Users\wb\Projects\wb-site-blended-20261019
node blended/server.mjs
```

`http://127.0.0.1:8896/blended/`를 연다. 전용 로컬 파일 `blended/.local/blended-demo.sqlite`에 가상 자료만 만든다.
다른 폴더/운영 DB를 지정하는 옵션은 없다. 파일이 있으면 그대로 유지하며 다시 시드하지 않는다.

| 로컬 아이디 | 역할 | 비밀번호 |
|---|---|---|
| owner | 원장 | Demo-owner-2026! |
| admin | 관리자 | Demo-admin-2026! |
| teacher-a / teacher-b | 과목별 강사 | Demo-teacher-a-2026! / Demo-teacher-b-2026! |
| student-a / student-b | 학생 | Demo-student-a-2026! / Demo-student-b-2026! |
| guardian-a / guardian-b | 확인된 가상 보호자 | Demo-guardian-a-2026! / Demo-guardian-b-2026! |

**위 계정은 외부 서버에 생성되지 않는다.** 외부 서버는 빈 전용 저장소에서 시작한다.
원장 비밀번호는 이 PC의 최초 설정 도구에서 직접 입력한다. 도구는 임시 키를 메모리에만 두고, 비밀번호를 HTTPS로 전달한다.

```powershell
python blended/first-setup.py
```

`http://127.0.0.1:8897/`에서 원장 비밀번호를 설정한 후 외부 주소에서 로그인한다.
이미 원장이 설정되어 있으면 다시 초기화하지 않는다. 최초 설정은 단 한 번만 가능하다.
설정 후 도구 프로세스를 종료해도 서비스는 Cloudflare에서 계속 동작한다.
로그인한 원장은 **강사·담당 관리 → 강사 추가 / 학생 추가 / 담당 배정** 순으로 사용할 수 있다.
강사는 각자 아이디·비밀번호로 로그인한다. 계정의 비밀번호 변경은 **내 계정**에서 한다.

## 상태·권한

1. 강사가 담당 과목의 날짜·교재/범위·할 일을 배정한다.
2. 학생은 본인 항목에 완료·질문을 남긴다. 외부 서비스 성적이나 검증 완료로 보지 않는다.
3. 강사가 피드백과 별도 확인 상태를 남긴다. 학생이 다시 수정하면 확인 상태가 해제된다.
4. 상담에서 기간별 학습 사실을 불러오고 학생 의견·공개 확인 사항·지도 방향·목표·기한을 적는다.
5. 상담 완료가 상담 ID와 연결된 날짜 있는 학습 항목 하나를 원자적으로 만든다. 중복 완료/재시도는 같은 항목을 반환한다.
6. 초안 → 검토 요청 → 원장 공개본 발행을 별도로 수행한다. 관리자/강사는 최종 발행하지 못한다.
7. 수정은 초안 변경 → 재검토 → 사유를 적어 새 버전 발행. 기존 스냅샷은 DB trigger로 UPDATE/DELETE를 거부한다. 철회도 새 이력이며 학생·보호자에게는 최신 유효본만 보인다.

| 역할 | 서버 허용 범위 |
|---|---|
| 원장 | 전체 블렌디드 영역, 계정/담당 관리, 최종 발행·철회 |
| 관리자 | 이 블렌디드 영역의 강사·학생/담당 관리, 학습/상담/리포트 검토. 원장 변경·관리자 생성·최종 발행 불가 |
| 강사 | 활성 계정 + 활성 배정 + 오늘이 배정 시작/종료일 안 + 해당 과목. 담당 해제/비활성 즉시 신규 API 접근 차단 |
| 학생 | 본인 수행·질문, 본인 약속, 발행된 공개본 |
| 보호자 | 확인된 관계·유효 동의·학생 서비스 활성일 때 해당 자녀의 최신 공개본 읽기. 실제 원본 연결은 미연동 |

내부 메모는 `internal_notes` 별도 표에만 저장하고 강사/운영 담당의 `consult_get`만 읽는다.
발행 과정은 이 표를 읽지 않는다. 공개본은 명시된 공개 필드만 선택하며 감사 기록에는 행위자·작업·ID·시각만 남긴다.

`POST /blended/api`는 `{app:'blended', action, payload, requestId}` 계약이다.
읽기는 `state`, `summary`, `consult_get`, `report_get`; 쓰기는 `teacher_create`, `teacher_status`, `student_create`,
`assign`, `unassign`, `student_status`, `guardian_consent`, `learning_create`, `perform`, `check`, `consult_save`,
`consult_complete`, `review`, `publish`, `withdraw`, `password_change`다. `send`는 항상 연결 대기로 차단한다.
공통 인증 후 각 작업의 역할/객체/과목/기간을 검사한다. 변경은 revision 일치와 requestId 재시도 식별자를 요구한다.
최초 `runtime`, `setup`, `login` 외에는 인증이 필요하다. `setup`은 별도 임시 비밀과 빈 계정 상태를 함께 요구한다.

## 저장·배포 격리

- 운영: `wb-blended` Worker + `BlendedPlanner` SQLite Durable Object. 전용 ID `blended-production-v1`.
- 기존 `wb-sync`/D1·consult 쿠키/토큰·R2를 연결하지 않는다. 보호자도 `/blended/guardian/`의 같은 전용 인증 경계를 사용한다.
- 운영 쿠키 `__Host-wb_blended`: Secure/HttpOnly/SameSite=Strict, 8시간. 서버에는 토큰 해시만 저장한다.
- 비밀번호: 개별 salt + scrypt. 실패 제한은 DB에 남아 실행 인스턴스가 교체되어도 유지된다.
- 같은 origin + 전용 요청 헤더 + JSON만 API에 허용. 전용 호스트만 허용하며 no-store/CSP/frame 차단을 적용한다.
- localStorage, IndexedDB, 서비스워커를 사용하지 않는다. 열린 폼의 입력만 메모리에 보존한다. 저장 실패/409에서 조용히 덮어쓰거나 자동 재시도하지 않는다.
- 정적 화면 자산만 허용 목록으로 제공한다. API/DB/문서/시험/계정 파일은 제공하지 않는다. 사진·PDF 파일 저장은 미연동이며 텍스트 질문과 주간·월간 리포트 인쇄를 지원한다.
- 단일 기관용 SQLite Object다. 다수 기관/대규모 동시 사용이 필요하면 기관별 분리와 성능 검증이 필요하다.

```powershell
node blended/build.mjs
wrangler deploy --dry-run --config blended/wrangler.toml
wrangler deploy --config blended/wrangler.toml
```

저장소 push 없이 전용 Worker만 배포할 수 있다. `wrangler.toml`에는 새 앱의 리소스와 공개 설정만 있다.
`first-setup.py`는 확인된 기존 Wrangler 인증을 메모리에서 읽어 **새 앱의 BOOTSTRAP_TOKEN만** 설정한다.
다른 앱 시크릿을 수정하지 않는다. 설정 후 기존 원장 행 때문에 재설정 요청은 거부된다.

## 시험

```powershell
node --test blended/api.test.mjs
node --test blended/planner.test.mjs
node blended/first-setup.test.cjs
node scripts/check.mjs
```

브라우저 조작 시험은 설치된 Playwright를 재사용한다(추가 설치 불필요):

```powershell
$env:PLAYWRIGHT_MODULE='C:\Users\wb\AppData\Local\npm-cache\_npx\e41f203b7505f1fb\node_modules\playwright'
$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE='C:\Users\wb\.cache\ms-playwright\chromium-1248\chrome-win64\chrome.exe'
node blended/browser-check.cjs
$env:NODE_PATH='C:\Users\wb\AppData\Local\npm-cache\_npx\e41f203b7505f1fb\node_modules'
node blended/planner-browser.cjs
```

경로는 이번 PC에서 확인한 설치 위치다. 다른 PC에서는 실제 설치 경로를 지정한다.
기본 Playwright 실행으로 Chromium sandbox를 유지한다. headless-shell 직접 실행이나 `--no-sandbox`를 사용하지 않는다.
가상 자료만 담긴 화면 증빙은 무시되는 `blended/evidence/`에 저장한다.

Cloudflare 실행 환경은 로컬 Worker를 먼저 띄운 뒤 `node blended/worker-check.mjs`로 검사한다.
이 시험은 127.0.0.1:8898에 고정되어 운영 데이터를 만들 수 없다. 설정 키와 계정도 합성 시험용이다.
로컬 Worker 실행은 README의 운영 설정을 사용하되 `PUBLIC_ORIGIN=http://blended.wbcowork.com`,
`BOOTSTRAP_TOKEN=synthetic-local-setup-only`, 포트 8898을 CLI에서만 덮어쓴다.

## 미연동과 후속 절차

[학원 앱 기능 요청·연결 계약](./ACADEMY_REQUEST.md)을 별도 보관한다. 담당 세션에는 전달하지 않았다.
학생/강사 원본 가져오기, 보호자 관계·번호·동의 확인, SOLAPI/카카오/문자/이메일 발송, 외부 성적 수집은 없다.
`delivery-contract.mjs`는 발송 준비 조건·멱등 키·접수/전달/결과 불명 구분의 계약 시험용이며 실제 발송 코드가 아니다.
월간·주간 리포트는 원본의 발행·철회·인쇄를 사용하며 최신 공개본은 확인된 보호자 계정에서도 열람한다.
오프라인 저장, 자동 초대, 사진·PDF 첨부, 목차 사진 인식·URL 자동 수집, 기프트 카드 교환은 미연동이다.
목차 직접 입력·붙여넣기, 학습 포인트·스탬프, 텍스트 질문·답변은 사용할 수 있다.

## 원본 자료와 상담 연결

`planner_records`는 원본 `staff/tasks/checks` 자료 형식과 행별 revision을 저장한다. 기존 컨설팅 서버의 자료는 읽거나 가져오지 않는다.
`planner_save`는 변경 묶음을 하나의 트랜잭션으로 저장하며, 충돌 시 전체 취소한다. 같은 requestId의 통신 재시도는 중복 생성하지 않는다.
화면은 저장 실패 시 수정 내용을 유지하고 재저장·수정본 내려받기·명시적 최신 내용 불러오기를 제공한다. 탭을 닫으면 미저장 내용은 소실될 수 있다.

상담 약속은 기존 `learning` 행을 원본 체크리스트에 투영하므로 두 벌로 복제하지 않는다. 원본에서 수행하면 상담 화면에도 반영되고 그 반대도 동일하다.
상담 집계는 기존 약속 + 원본 과제 + 인강의 배정·학생 수행을 포함한다. 외부 서비스 성적이 아니라 이 앱에서 직접 기록한 결과다.
주간·월간 계획의 지도 의견은 공개용이다. 비공개 상담 메모는 반드시 **상담·리포트의 내부 메모**에 작성한다.

강사는 담당 학생·과목의 과제/로드맵/인강/오답·회독만 받는다. 혼합 과목 자료를 저장해도 다른 과목 부분은 서버에서 보존한다.
공통 인강 가능 시간은 계획 수립에 사용한다. 전체 마감·포인트·최종 발행은 학생·원장 화면에서 확인한다.
주간·월간 발행본은 원장만 새 버전으로 만들며 기존 행 수정은 거부한다. 보호자에게는 동의가 유효한 자녀의 최신 공개본만 제공한다.

운영 데이터 도입 전에는 학원 원본/보관·삭제 책임/보호자 수신 정책을 확정한다. 기존 자료를 자동 복제하지 않는다.
향후 버전 변경 전 Cloudflare 배포 버전과 Object의 PITR bookmark를 기록하고, 별도 시험 Object로 복원 검증한다.
코드 문제는 이전 Worker 버전으로 rollback, DB 문제는 검증한 bookmark로 복원한다. 두 동작은 다르다.
처음 배포는 빈 신규 저장소이며 기존 서비스의 DB 마이그레이션/복원을 수행하지 않는다.
되돌릴 때 기존 consult나 도메인 루트를 바꾸지 말고 신규 `blended.wbcowork.com` 연결과 `wb-blended`만 대상으로 한다.

### 학원 연결 시험 추가 (2026-10-20)

실제 학생 바로가기는 RESULTS.md 최신 절을 따른다. 두 앱 가상 브라우저 시험은 ACADEMY_SOURCE를 별도 학원 작업본으로 지정하고 `node blended/academy-browser.cjs` 실행. 로컬 Worker의 worker-check.mjs는 기존 설정에 ACADEMY_BRIDGE_KEY를 합성값 `a` 64개로 추가한다. 운영 키를 개발 환경에 복사하지 않는다. 학원에는 기존 플래너 계정을 원장이 직접 연결하며 로그인/담당 검사는 플래너가 수행한다.
