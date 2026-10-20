# 블렌디드 플래너 작업·검증 보고 (2026-10-19)

## 현재 상태

아래 초기 배포는 간편형 화면만 포함한 1차 구현이었다. 원본 기능이 빠졌다는 사용자 피드백에 따라 **원본 기능 재사용과 ‘일정·학사’ 통합을 구현·검증하고 외부 배포까지 완료**했다.
최종 배포 버전은 `8375714b-9580-47ce-8243-a8e645e46eed`이다. 학원 앱과의 글꼴·크기·톤 통일 후속을 반영했다. 학생·강사 디자인 개선 5건과 공통 톤을 반영했다. 공개 주소와 배포 자산 내용 일치, 기존 원장 설정 유지, 비로그인 플래너/리포트 차단을 재확인했다.
이전 문서의 ‘완료’는 간편형 1차 범위였다. 이번 기능 복원 결과와 미연동 항목은 아래 추가 내역을 기준으로 한다.
1차 구현은 Cloudflare 전용 Worker 배포와 **일반 외부 주소 HTTPS 접속 확인까지 완료**했다.
배포 직후 새 도메인의 공개 DNS 반영 오류가 있었고, 신규 도메인 재연결 후 2026-10-19 20:32 KST에 정상 응답을 확인했다.
20:36 KST 일반 DNS를 통한 재검사에서도 화면 200, 비로그인 자료 접근 401, 가상 계정 로그인 거부 401, 외부 출처 요청 403, 소스/DB/문서 경로 404를 확인했다.
원장 아이디는 `whdudwns33`이다. **사용자가 직접 최초 비밀번호 설정을 완료**했고 운영 API의 `ready: true`와 설정 완료 화면을 확인했다. 비밀번호는 채팅·파일·로그에 남기지 않았다.
설정 후 임시 설정 시크릿을 삭제하고 PC의 설정 도구를 종료했다. 외부 서비스는 Cloudflare에서 계속 동작한다.

## 학원 앱과 글꼴·크기·톤 통일 후속 · 배포 완료

사용자가 제공한 실제 학원 주소는 `https://blended-academy.wbcowork.com/ops/pads`다. 새로 확인한 앱은 별도 `wb-ops` 독립 설치이며 플래너 원본이라고 추정하지 않았다. 운영 runtime·릴리스·소스와 대조한 뒤 별도 `C:/Users/wb/CodexWork/wb-ops-blended-tone-20261019` (`codex/blended-tone-20261019`)에서 수정했다.

- Impeccable typeset 독립 검토 A(type_review)와 B(type_scan), 소스와 실제 계산된 스타일을 대조했다. 플래너 원본/상담/학원 간 15·16px 본문, 700·900 굵기, 폰트 스택·숫자 계열, 학원 자동 다크/코랄과 플래너 라이트/보라의 차이를 확인했다.
- 같은 시스템 한글 글꼴, 화면 제목26·카드 제목18·본문/입력16·조작15·설명14px으로 통일했다. 900 굵기·자간을 줄이고, 모바일 로그아웃11.25px과 small!important가 버튼을 덮어쓰는 문제를 고쳤다. 확대된 건수 배지도 한 줄로 유지한다.
- 학원은 정확히 WB 블렌디드학원인 직원 화면에만 브랜드 속성을 붙이고 같은 밝은 배경·남색·보라색 토큰을 적용했다. 기존 메뉴·업무 JS·lib/스키마·학부모/학생 CSS는 기존 설치와 같다. 로그인·학습·상담·리포트·패드 기능과 자료는 유지한다.
- 가상 자료 실측 시험 `node blended/typography-browser.cjs`에서 학원·플래너·상담의 글꼴/역할 크기 동일, 1365/820/390/320px, 어두운 OS 에뮬레이션, 학원 주요 경로320px, 브라우저 오류·가로 넘침0을 확인했다. 이미지·JSON은 무시되는 evidence/type-*·typography-result.json이다.
- 기존 `planner-browser.cjs`, `browser-check.cjs` 통과. 저장소 전체 병렬 검사에서는 portal-family.test.mjs의 파일 저장 완료 대기1건이 실패했고 단독 재검은 통과했다. 전체 `node scripts/check.mjs --serial` 재검으로 **321/321,196.6초** 통과했다. 그 테스트나 관련 운영 코드는 수정하지 않았다.
- 학원 TypeScript/빌드, 기존75개(인접 데스크 교차1SKIP), academy 패키지 생성·실제 추출 묶음251개 검사 통과. 기존 lib/스키마·업무 JS·학생/학부모 자산과의 실질 차이가 없음을 대조했다.
- 자동 점검 최종: 플래너11개 기존 구조/장식 경고, 학원3개 기존 폰트 정의·배포 제외 처리방침 경로/제목 경고. 이번 대상의 실제 타입/테마 불일치는 수정했으며 전체 무결함·새 평점을 주장하지 않는다. Taste는 홍보용 스킬로 앱 화면을 제외해 적용하지 않았고 Stitch를 사용했다고 하지 않는다.

배포: 플래너 Worker `8375714b-9580-47ce-8243-a8e645e46eed`, 학원 독립 묶음 `e92c6c032ed28335fa6fb0f8364f85e241d0f75f56df227f37506080fca6c360`. 전용 학원 서버만 새 릴리스로 재시작했고 기존 키·data-v2·터널/예약 설정은 보존했다. 양쪽 HTTPS의 최신 CSS SHA256 일치, 원장 설정 유지, 학원 사용자 로그인 세션 유지, 직원/플래너 익명401, 학생 호스트 직원404·학생 입구200, 서버 health200을 확인했다.

추가 변경 파일은 플래너 `ui.css`, `typography-browser.cjs`, README·RESULTS·ACADEMY_REQUEST다. 학원은 server.mjs의 직원 HTML 속성 1곳, public/app.css, 디자인/인계/검증 문서만 바꿨다. 학원 상세 보고: `C:/Users/wb/CodexWork/wb-ops-blended-tone-20261019/academy-app/블렌디드-디자인-검증.md`.

비교 시험은 가상 학원 견본을8894에서 켜고 플래너 폴더에서 실행한다. 외부 학원↔플래너 API 연결·실자료 변경·실제 발송·NAS/다른 운영 앱·공유 저장소 push/PR은 하지 않았다. 실제 휴대폰·Safari·스크린리더·종합 성능은 미검증이다.

## 학생·강사 디자인 개선 5건 · 배포 완료

사용자가 선택한 Impeccable 점검 5건을 양쪽 역할과 상담 화면에 반영했다. 원본 컨설팅 파일과 기존 작업본의 변경사항은 그대로 보존했다.

| 항목 | 반영 결과 |
|---|---|
| 메뉴 발견 | 오늘·주간·일정·학사·상담·리포트와 전체 메뉴를 공통 적용. 휴대폰에서는 줄을 나눠 표시하며 로드맵·인강·학습·배부·학생 현황·관리를 전체 메뉴에서 연다. |
| 역할별 우선순위 | 학생 체크리스트·타이머·오늘 마무리 바로가기와 체크리스트를 앞에 배치. 강사는 확인·피드백을 맨 앞에 표시. 포인트·스탬프는 접어서 열며 내용을 보존. |
| 미저장 입력 | 상담·학생 수행 입력의 닫기/Esc에 계속 작성·버리기 확인. 강사 피드백에도 닫기 확인과 페이지 이탈 경고 적용. 저장 성공·권한 상실은 해당 상태에 맞게 종료. 실패·충돌은 기존 입력 보존. |
| 공통 톤 | 연결 플래너와 상담·관리 화면에 남색 본문, 보라색 주요 동작, 같은 한글 시스템 글꼴·메뉴·선택 학생 맥락을 적용. 긴 상담 양식은 기본 정보·내부 기록·공개 내용으로 구분하고 저장·닫기를 고정. |
| 모바일·접근성 | 날짜 이동·체크·타이머 등 주요 조작 44px 이상, 작은 시간표·설명 글자 확대, 모바일 입력 16px, 날짜·아이콘의 접근 가능한 이름과 공부 추가 라벨 적용. |

검증 결과:

- `node scripts/check.mjs`: **321/321 시험 파일 통과, 65.4초**. 처음 실행에서 검토 기록 폴더의 루트 지도 누락이 발견되어 AGENTS/CLAUDE에 동일한 설명을 추가한 후 전체 재검사했다.
- `node --test blended/planner.test.mjs`: 최종 소스 기준 **9/9** 통과. 원본 학습 기능·접근권한·충돌·혼합 과목·리포트 경계 유지.
- `node blended/browser-check.cjs`: 배정→수행→확인→상담→약속→발행→보호자 열람, 계정·담당 등록, 실패·충돌 입력 보존, 상담 Esc/계속 작성, 변경 없는 닫기, 1365/820/390px 통과. 브라우저 오류 0.
- `node blended/planner-browser.cjs`: 원본 주요 6개 화면, 일정·학사·시험, 교재 로드맵, 인강, 질문, 주간 리포트, 학생 선택 유지, 미완료 이월·하루 마감 통과. 학생/강사의 320·390·820·1365px 메뉴·주요 조작 크기·가로 넘침, 키보드 전체 메뉴, 강사 피드백 버리기 취소까지 확인. 브라우저 오류·기존 컨설팅 서버 호출 0.
- Cloudflare 로컬 실제 런타임 시험과 6개 진입/공통 자산 응답·CSP 확인 통과. 배포 dry-run 통과.
- 공개 HTTPS에서 **10개 배포 자산 SHA-256 일치**, 운영 초기 설정 `ready:true`, 비로그인 학습/플래너/리포트 401, 외부 Origin 403, 소스·DB·문서 경로 404 확인. 운영 로그인이나 실데이터 쓰기 시험은 하지 않았다.
- Impeccable 자동 탐지는 기존 과목 구분선·내부 기록 구분·원본 애니메이션 등을 포함해 12개 경고를 냈다. 새로 추가했던 불필요한 강조선은 제거했다. 나머지는 기존 의미·구조 보존 범위로 검토했으며 자동 경고 0이나 새 평점 취득을 주장하지 않는다.

최종 Worker: `wb-blended`, 버전 `dc4eada5-f94c-4bb1-8aa2-66d00561772b`. 작업 전 버전 `34c34807-457c-4384-9456-63bf14ff1e98`을 기록했다. 인증·DB 스키마·저장소 소관은 변경하지 않았다. 공유 저장소 push는 하지 않았다.

변경 파일:

- 공통 UI: `blended/navigation.js`, `ui.css`, `index.html`, `app.js`, `planner-adapter.js`.
- 조립·제공: `blended/planner-build.mjs`, `build.mjs`, `server.mjs`, `worker.mjs`.
- 시험: `blended/browser-check.cjs`, `planner-browser.cjs`, `planner.test.mjs`.
- 문서: `blended/README.md`, `RESULTS.md`, `ACADEMY_REQUEST.md`, 루트 `AGENTS.md`·`CLAUDE.md`, `.impeccable/critique/`의 기존 점검 기록 해결 상태.

작업 경로·실행: `C:\Users\wb\Projects\wb-site-blended-20261019`, 브랜치 `codex/blended-planner-local-20261019`. Node 24에서 `node blended/server.mjs` 실행 후 `http://127.0.0.1:8896/blended/`를 연다. `node blended/build.mjs`로 배포 자산을 조립한다. 가상 시험 계정과 전체 실행 방법은 README를 따른다.

학원 앱에도 같은 톤을 적용할 기준을 `ACADEMY_REQUEST.md`에 추가했다. 실제 학원 앱 주소·소스는 미확인이며 학원 앱 자체와 기존 consult 운영 화면은 수정하지 않았다. 사진/PDF 저장, 외부 진도·성적, 학원 데이터, 실제 알림 발송은 계속 미연동이다. 실제 휴대폰·Safari·스크린리더·200% 확대·대규모 부하 시험은 하지 않았다.

## 원본 기능 복원·일정 통합 결과

- 로그인 기본 화면: `/blended/planner/`. 원본 오늘 체크리스트·순공시간/시간표·주간·로드맵·인강·학습 화면과 로직을 빌드 시 재사용한다. 기존 컨설팅 서버로 요청하지 않는다.
- **일정·학사**: 월간 달력·월간 계획·시험/수행평가·시험 계획·자료 요청을 단일 메뉴에 배치했다. 내부 보기에서 월간 일정과 시험/수행평가를 전환한다.
- 원본 공부 배정 → 학생 체크 → 강사 확인·피드백을 연결했다. 상담 약속도 같은 체크리스트에 표시하며 기존 약속 자료를 복제하지 않는다.
- 교재 로드맵 분량 분배, 인강 목차 직접 등록, 주간 목표, 텍스트 질문·답변, 하루 마감·미완료 이월, 주간/월간 공개 리포트를 연결했다. 요약 복사·확인으로 마감하며 메시지를 발송했다고 표시하지 않는다.
- 상담으로 이동할 때 선택한 학생을 유지한다. 상담 집계는 기존 약속과 원본 과제·인강의 직접 기록을 함께 사용한다.
- 과목별 혼합 자료는 서버에서 허용 부분만 응답하고, 수정 시 다른 과목 부분을 보존한다. 새 원본 자료용 표·인덱스만 추가했으며 기존 계정/상담/학습 행을 초기화하거나 수정하는 배포 코드는 없다.
- 저장 중 다른 기기의 변경이 도착해도 새 revision에 자동 덮어쓰지 않는다. 충돌 시 내 수정본을 유지하고 내려받기/명시적 최신 내용 불러오기를 제공한다.

추가 검증:

| 시험 | 결과 |
|---|---|
| 저장소 전체 `node scripts/check.mjs` | **321/321 시험 파일 통과, 83.0초** |
| 변경 앱 재검사 `--only blended` | 3/3 시험 파일 통과: 기존 API 16개, 최초 설정, 원본 연결 시험 |
| 최종 `node --test blended/planner.test.mjs` | **9/9 통과**: 범위/충돌/재시도/혼합 자료 보존/약속 연결/발행 불변성·철회/질문·답변/안전한 이월/날짜·역할 검증 |
| `node blended/planner-browser.cjs` | 6개 원본 화면, 통합 일정의 시험 등록·재열기, 공부 배정·학생 체크·강사 확인, 교재 자동 분배, 인강 목차, 주간 목표, 텍스트 질문, 공개본 보호자 열람, 선택 학생 상담 연결 통과 |
| 같은 브라우저 시험의 저장 경합·하루 마감 | 전송 중 다른 기기 수정 충돌/내 입력 보존/명시적 최신 불러오기, 상담 약속·로드맵 이월, 요약 복사 후 마감 서버 확인 통과 |
| 화면·격리 | 1365/820/390px, 가로 넘침 없음, JS 오류 없음, 원본 동기화 서버 요청 없음, localStorage에 학습 자료 저장 없음 |
| Cloudflare 로컬 실행 엔진 | 원본 과제·체크·상담 집계·권한 회수 포함 통과 |
| 최종 외부 HTTPS | 조립한 자산과 응답 내용 일치, 원장 설정 유지, 비로그인 401, 외부 출처 403, API 소스/DB/문서 404 |

가상 화면 증빙: [일정·학사 PC](./evidence/restored-schedule-desktop.png), [학생 오늘 휴대폰](./evidence/restored-today-phone.png).
검증 기록: [전체 시험](./evidence/repository-tests-restored.txt), [변경 앱 재검사](./evidence/blended-tests-restored.txt), [최종 외부 확인](./evidence/production-restored.json).
원본의 모든 부가 기능 조합을 수동으로 시험한 것은 아니다. 기존 원본 회귀 시험과 위 추가 연결 흐름을 검증했다.

## 작업 위치·변경 파일

- 작업 트리: `C:\Users\wb\Projects\wb-site-blended-20261019`
- 브랜치: `codex/blended-planner-local-20261019`
- 시작 커밋: `60df731b489603cf4afe296e6f384e6284b1289c`
- 기존 작업본: `C:\Users\wb\Projects\wb-site`의 consult/task 미커밋 변경·미추적 파일은 그대로 유지했다.
- 공유 저장소 push/PR 없음. Aside 원문과 프로젝트 sources는 수정하지 않았다.

| 파일 | 변경 내용 |
|---|---|
| `AGENTS.md`, `CLAUDE.md` | 새 앱 위치 설명 동일한 한 줄 |
| `blended/index.html`, `style.css`, `app.js` | 역할별 반응형 화면, 학습·상담·공개본·강사/학생 관리 |
| `blended/api.mjs`, `schema.sql` | 인증·권한·입력 검증·상태 전환·불변 발행본·내부 메모 분리 |
| `blended/planner-build.mjs`, `planner-adapter.js` | 원본 화면·로직 재사용, 전용 저장 연결, 일정·학사 단일 메뉴, 강사 확인 |
| `blended/planner-api.mjs` | 학생·과목별 원본 자료 저장, 혼합 자료 부분 보존, 상담 약속 연결, 주간·월간 공개본 |
| `blended/planner.test.mjs`, `planner-browser.cjs` | 원본 연결·권한·저장·원본 화면 기능 시험 |
| `blended/local-db.mjs`, `server.mjs` | 전용 로컬 SQLite와 가상 계정/자료 |
| `blended/worker.mjs`, `wrangler.toml`, `build.mjs` | 별도 Cloudflare Worker/SQLite Object/정적 자산 배포 |
| `blended/first-setup.py` | 현재 PC에서 원장 비밀번호 직접 설정, 임시 비밀은 메모리에서만 처리 |
| `blended/delivery-contract.mjs` | 발송 자격·중복 방지 키·결과 불명 상태 계약, 실제 발송 없음 |
| `blended/api.test.mjs`, `first-setup.test.cjs`, `browser-check.cjs`, `worker-check.mjs` | 서버·설정 도구·화면 조작·Cloudflare 로컬 실행 시험 |
| `blended/.gitignore`, `README.md`, `ACADEMY_REQUEST.md`, `RESULTS.md` | 생성 파일 제외, 실행 안내, 학원 요청서, 이 보고 |

`consult/`, `sync/`, `parent/`에 코드 변경이 없다. 기존 인증/DB/파일 저장소를 공유하지 않는다.
기존 공개 consult HTML은 시작 커밋과 줄바꿈 정규화 후 동일했다(SHA256 `2b51f1516b7bc75dba8b7c0beb773ee07ab86997a341844637bfce2841f75f4d`).

## 사용 방법

외부 주소: <https://blended.wbcowork.com/blended/>.

원장 최초 설정은 완료되었다. 외부 주소에서 사용자가 직접 정한 비밀번호로 로그인한다.
최초 설정 도구를 다시 실행해도 기존 계정을 초기화하지 않는다. 현재 PC의 8897 설정 화면은 종료했다.
원장 로그인 후 **강사·담당 관리 → 강사 추가 → 학생 추가 → 담당 배정** 순서로 사용한다.
강사들은 등록된 개별 아이디·비밀번호로 로그인하고, **내 계정**에서 비밀번호를 변경한다.

로컬 가상 자료 실행:

```powershell
Set-Location C:\Users\wb\Projects\wb-site-blended-20261019
node blended/server.mjs
```

<http://127.0.0.1:8896/blended/>를 연다. 가상 계정은 [README](./README.md)에 있다. 운영에는 이 계정을 생성하지 않았다.

## 구현·시험 결과

| 항목 | 결과 |
|---|---|
| 강사 등록·개별 로그인·활성/비활성·과목/기간 담당 배정 | 구현, API·화면 조작 통과 |
| 타 담당 학생/과목/상담/리포트 직접 API 차단 | 통과 |
| 담당 해제·비활성 즉시 권한 회수 | 통과, 기존 작성 이력 보존 |
| 학생 본인 수행·질문 → 강사 별도 확인 | 통과, 학생 변경 시 확인 해제 |
| 기간·출처·자료 없음·미연동을 구분한 상담 준비 | 통과 |
| 내부 메모와 공개 내용 분리 | 별도 표, 학생/보호자 응답·발행본·감사 기록에 내부 메모 없음 |
| 상담 완료 → 기한 있는 다음 학습 약속 | 원자적 저장·중복 재시도·실패 rollback 통과 |
| 검토·원장 발행·수정본·철회 | 불변 스냅샷·새 버전·수정 사유·철회 후 과거 공개본 차단 통과 |
| 보호자 관계/동의/서비스 상태 | 가상 연결에서 허용/차단 통과. 실제 원본 연결 미완료 |
| 저장 실패·동시 수정 충돌 | 폼 유지, 조용한 덮어쓰기 없음, 재시도 식별 통과 |
| PC/태블릿/휴대폰 | 1365/820/390px 조작·긴 내용·키보드·가로 넘침·콘솔 오류 확인 통과 |
| 기존 consult/auth/report/guardian 회귀 | 저장소 전체 시험에 포함하여 통과 |
| 실제 외부 계정·강사 사용 | 원장 개설 완료. 외부 주소·로그인 화면·비인증 차단 검증 완료. 사용자 비밀번호를 이용한 로그인 조작과 실제 강사 등록은 사용자가 진행 |

실행한 명령과 결과:

- `node --test blended/api.test.mjs`: 16/16 통과.
- `node blended/first-setup.test.cjs`: loopback/Origin/CSRF/비밀번호 확인/일회성/비밀 미노출 통과. 설정 요청의 User-Agent와 HTML 폼 Referrer-Policy를 보완한 뒤 회귀 시험 추가·재실행 통과.
- 최초 설정의 `no-referrer` 정책이 브라우저 폼 POST의 Origin을 `null`로 만드는 문제를 사용자 시도에서 발견했다. 비밀번호 없는 별도 로컬 폼으로 앱 안 브라우저에서 재현하고 `same-origin`으로 정상 Origin이 전달되는 것을 확인했다. 인증 경계/CSRF 검사는 유지했다. 첫 실패에서 비밀번호는 저장되지 않았다.
- `node scripts/check.mjs`: **320/320 시험 파일 통과, 73.0초**. 처음 실행에서 문서 지도 누락과 기존 portal-family 타이밍 실패를 발견했다. 문서 지도 보완, 해당 기존 시험 단독 통과 후 전체 재실행에서 모두 통과했다.
- `node blended/browser-check.cjs`: 역할별 핵심 흐름·등록/배정·동의 철회·저장 실패/충돌·세 화면 크기 통과.
- 로컬 Wrangler 실행 후 `node blended/worker-check.mjs`: 실제 Worker 엔진에서 신규 설정·로그인·강사/학생 등록·배정·상담·발행·메모 분리·권한 회수 통과. 주소를 127.0.0.1:8898로 고정하여 운영 자료를 만들지 않는다.
- `git diff --check`, 주요 JS 문법 검사, Python 구문 검사 통과.
- `wrangler deploy --dry-run --config blended/wrangler.toml` 및 실제 배포 성공.

화면 증빙은 가상 자료만 포함한다(버전 관리 제외):

- [PC 강사 화면](./evidence/desktop-teacher.png)
- [태블릿 학생 화면](./evidence/tablet-student.png)
- [휴대폰 보호자 화면](./evidence/phone-guardian.png)
- [휴대폰 학습 화면](./evidence/phone-learning.png)
- [저장소 전체 시험 로그](./evidence/repository-tests-final.txt)
- [외부 주소·보안 경계 검사](./evidence/production-check.json)

## 배포·원본 보호·되돌리기

사용자의 후속 요청으로 외부 배포가 승인되었다. `wb-blended` Worker와 전용 SQLite Durable Object만 새로 배포했다.
현재 활성 배포 버전: `34c34807-457c-4384-9456-63bf14ff1e98` (원본 기능 복원·일정 통합).
복원 전 기준 배포 버전: `41dd9abf-c473-46a8-a25c-e148777d4a6b` (최초 설정 시크릿 제거 반영).
기존 운영 Worker/D1/R2/시크릿/프로세스/학원 앱은 변경하지 않았다.
새 원장 설정용 시크릿만 신규 앱에 생성한 후 설정 완료 시 삭제했다. 설정 키와 비밀번호는 파일·로그에 출력하지 않았다.
도메인 연결 오류 조사 중 이 신규 도메인만 재연결했다. 도메인 루트와 다른 서브도메인은 변경하지 않았다.

운영은 빈 저장소로 시작한다. 기존 자료 이관과 실제 메시지 발송은 승인 범위에 포함하지 않았다.
DNS 조사 중 최초 설정 도구는 잠시 확인된 Cloudflare IP에만 이름 해석을 지정해 실행했다. 인증서 검증을 유지했고 OS DNS/hosts는 변경하지 않았다. 사용자의 최종 비밀번호 설정은 일반 DNS를 사용하는 수정 도구에서 완료했다.

후속 운영 변경 전에는 현재 Worker 배포 버전, Object의 PITR bookmark, 변경 대상/원본 소관을 기록한다.
별도 시험 Object로 복원을 검증한 후 운영 변경한다. 실제 자료 백업·복원 연습은 아직 하지 않았다.
코드만 되돌리는 경우 해당 Worker의 이전 배포로 rollback한다. 데이터 복원은 별도 절차이며 코드 rollback으로 되돌아가지 않는다.
서비스를 중단할 때에도 신규 `blended.wbcowork.com` 연결만 해제하고 자료는 보존한다. 기존 consult나 학원 DB를 되돌리지 않는다.

## 미연동·미검증·추후 요청

[학원 앱 기능 요청·연결 계약 v0.2](./ACADEMY_REQUEST.md)를 작성했다. 담당 세션에 직접 전달하지 않았다.
실제 학원 원본 주소/API/안정 ID, 보호자 관계·전화번호·동의, 외부 학습 성적, 실제 문자/카카오/이메일은 미연동이다.
운영 보호자 가입·본인/관계 확인도 연결 계약 확정이 필요하다. 가상 보호자 시험 통과를 실제 확인 완료로 표시하지 않는다.

발송 계약 시험은 있지만 제공자 호출·예약 원장·콜백·운영 중복 방지 연동은 없다. `send`는 서버에서 거부한다.
SOLAPI 키는 가져오거나 복사하지 않았다. 향후에도 사용자 지정대로 운영 PC 중계기가 기존 환경변수를 사용해야 한다.
사진·PDF 업로드 저장소, 목차 사진 인식/URL 자동 수집, 기프트 카드 교환, 오프라인 저장, 자동 초대는 미연동이다. 목차 직접 입력·텍스트 질문·월간/주간 리포트 발행·인쇄는 가능하다.
대규모 부하, 실제 데이터 백업 복원, 실사용자 종단 시험은 미검증이다. 현재 구현은 단일 학원의 전용 저장소 기준이다.

## 2026-10-20 학원 학생 상세 실제 연결

이 절이 이전 ‘학원 API 미확정’ 상태보다 최신이다. 학원 상세에서 원장이 기존 플래너의 학생 ID·이름을 확인해 직접 연결하고 ‘플래너 열기’로 같은 ID를 연다. 두 앱의 별도 로그인·담당 권한을 유지하며 로그인 전후 대상 ID를 보존한다. 없는/담당 외 학생을 다른 학생으로 대체하지 않는다.

- 작업본 C:/Users/wb/Projects/wb-site-blended-link-20261020, codex/blended-handoff-20261020. 원본 consult 파일은 수정하지 않았다.
- 변경: api.mjs(학생 ID·이름 읽기 전용), worker.mjs/server.mjs(서버 연결 인증), planner-adapter.js/app.js(대상 보존·접근 오류), academy-api.test.mjs/academy-browser.cjs/worker-check.mjs(검증).
- 학원 작업본 C:/Users/wb/CodexWork/wb-ops-blended-link-20261020의 lib/planner.mjs, lib/api.mjs, server.mjs, student.tsx, student-planner.tsx, 배포 검사/문서를 함께 반영했다. 실제 계약은 그 작업본 academy-app/블렌디드-플래너-연동계약.md 첫 절 참고.
- 실행: node blended/server.mjs (가상 자료 로컬 서버). 새 양쪽 시험은 NODE_PATH와 PLAYWRIGHT_CHROMIUM_EXECUTABLE을 README대로 지정하고 ACADEMY_SOURCE를 위 학원 작업본으로 설정한 뒤 node blended/academy-browser.cjs.
- API26/26, 저장소 전체322/322(직렬197초), 기존 planner-browser 및 browser-check 통과. 원본6화면·일정/학사 통합·과제/로드맵/목차·리포트/권한 회수 유지. 가상 동명이인 ID 선택·로그인 후 대상 유지·미존재/권한 외 대체 표시 방지·비활성 거부·390px 넘침0·브라우저 오류0. Cloudflare 로컬 런타임에서도 서비스 키/Origin/크기 경계 통과.
- 보호자 동의 철회 후 빈 리포트 표시는 기존 흐름대로 유지했다. 외부 요청 학생을 명시한 경우에는 권한 오류를 표시한다.
- Worker 현재 4bddba84-0988-4de4-b39d-3958b83016a3, 직전 기준8375714b-9580-47ce-8243-a8e645e46eed. 전용 ACADEMY_BRIDGE_KEY 추가(읽기 전용), 기존 로그인/자료/키 변경 없음.
- 학원 현재61c0491ffbe3562f887377001eaabcb73fe27c77377cb82170eb8d9242cfabe5, 이전e92c6c032ed28335fa6fb0f8364f85e241d0f75f56df227f37506080fca6c360 보존. 전용 launcher에 보호 키 파일 경로만 추가, 서버 작업만 전환. 터널/기존 운영 앱/원본/DB 구조는 유지.
- 외부 HTTPS 자산 SHA256 일치, 서버 health200, 직원 익명401·학생 호스트 직원404, 운영 읽기 전용 학생 계약200·미인증/브라우저Origin403 확인. 생산 학생 ID·이름은 로그에 출력하지 않았다.
- 운영 명부가 비어 있어 실제 학생/계정/연결은 만들지 않았다. 기존 브라우저 직원 세션은 만료되어 로그인 화면 표시를 확인했다. 사용자 비밀번호를 읽거나 재설정하지 않았다.

미연동: SSO, 상담·리포트 요약 수신, 강사 자동 배정/계정 복제, 메시지 발송. 실데이터 종단 시험·실기기/낭독기·재부팅 복구는 미검증. 공유 저장소 push/PR0.

## 2026-10-20 후속: 학원 직원 자동 로그인·관리자·리포트 샘플

사용자가 별도 로그인 없는 진입과 기존 강사 권한 유지를 요청했다. 새 C:/Users/wb/Projects/wb-site-blended-sso-20261020 및 C:/Users/wb/CodexWork/wb-ops-blended-sso-20261020, 각 codex/blended-sso-20261020에서 구현했다. 이전 작업본은 보존했다. 사용자는 관리자 계정을 나중에 등록한다고 답해 실제 계정 생성/초대는 하지 않았다.

사용법: 학원 원장→직원 화면의 직원 자동 로그인 연결→본인 학원 직원과 같은 역할의 기존 플래너 계정 연결(한 번). 학생 상세의 플래너 열기→학원 세션으로 같은 학생에게 자동 진입. 원장급↔owner, 관리자(실장)↔admin, 강사↔teacher만 허용하며 데스크/회계/학생/보호자는 직원 SSO 대상이 아니다. 이름 자동 매칭/계정 복제/담당 학생·과목 확대 없음. 플래너 관리자 추가 버튼은 원장에게만 보이고 기존 API도 원장만 관리자를 만들 수 있다. 학원은 기존 직원 등록에서 역할 관리자를 선택한다.

학생 ID·이름 읽기 키는 그대로 두고 별도 ACADEMY_AUTH_KEY와 protected/planner-auth.key를 추가했다. /academy-start의90초 상태 쿠키→학원 현재 직원/학생 재검사→60초 일회용 티켓→/academy-entry/#ticket→같은 Origin의 /academy-exchange로 교환한다. 쿠키는 Secure/HttpOnly/SameSite=Strict/Host 전용, 티켓은 해시 저장·한 번만 사용·브라우저 상태 결합이다. entry는 fragment를 즉시 지운다. 학원 request_receipts에는 티켓 대신 재시도 안내만 저장한다. 활성/역할/담당을 교환 때도 다시 확인한다. 다른 사용자의 원장 세션이 있어도 해당 강사 본인의 세션으로 교체한다. 기존 개별 로그인은 유지한다.

변경 파일: api.mjs, schema.sql(academy_tickets 추가만), worker.mjs, server.mjs, app.js, academy-handoff.mjs. 검사: academy-auth.test.mjs, academy-sso-browser.cjs, worker-check.mjs, browser-check.cjs. 가상 공개본 생성기 report-sample.cjs는 실제 상담 발행→보호자 공개 템플릿에서 HTML/PNG/PDF를 만든다. 내부 메모 제외·16px 본문·390px 넘침0을 검사하고 A4 1쪽 PDF를 렌더링 확인했다.

검증 결과: 플래너 API27/27, 전체323/323(직렬295.9초), 기존 원본6화면/일정통합/과제/로드맵/목차/리포트·동의철회/키보드/PC·820·390 회귀 통과. 두 앱 실제 가상 HTTP 브라우저에서 원장/관리자/강사 비밀번호 재입력0·정확한 학생·원장→강사 세션 교체·담당 외/회수 거부·브라우저 오류0. 학원 test/planner-sso.mjs는 계정·역할 조작/중복409·미연결/대기 중 역할 변경·티켓 보관 금지를 검사한다. 학원 배포 검사+추출본 검사 통과. Cloudflare 실제 로컬 엔진도 별도 키/상태 쿠키/세션 쿠키/재사용 거부 통과.

배포 Worker 0000c117-b811-4f99-abcb-21eeac7f2474(이전4bddba84-0988-4de4-b39d-3958b83016a3), 학원 aec02fca20accd4b9b9d51c4b05cfebbb9d0a53ec04e88cbf68a294fedcc6bac(이전61c0491ffbe3562f887377001eaabcb73fe27c77377cb82170eb8d9242cfabe5 보존). dedicated launcher에 WB_OPS_PLANNER_AUTH_KEY_FILE만 추가하고 해당 서버만 전환했다. 보호 키·data-v2·터널·다른 앱/예약 설정은 보존했다. 외부 SSO 경로200/302·잘못된 키/Origin/상태403·세 키 자산 SHA256·health200·직원 익명401·학생 직원404 확인. 실계정·실학생·학생매핑 변경0, 실발송0, 공유push/PR0.

실행: 기존 node blended/server.mjs는 가상 개별 로그인 서버. 양쪽 SSO 검증은 README Playwright 경로를 설정하고 ACADEMY_SOURCE를 새 학원 작업본으로 지정한 뒤 node blended/academy-sso-browser.cjs. node --test blended/academy-auth.test.mjs 및 학원 node test/planner-sso.mjs. 로컬 Worker는 기존 합성 설정에 ACADEMY_AUTH_KEY=c 64개 추가 후 node blended/worker-check.mjs. 샘플은 REPORT_SAMPLE_DIR을 지정하고 node blended/report-sample.cjs.

샘플 산출물: C:/Users/wb/.codex/.chatgpt-projects/g-p-6ad5f0507c6481919d57c4a566f69099/artifacts/report-sample-20261020/report-sample.html, report-sample.png, report-sample-phone.png, report-sample.pdf. 모두 가상 자료다.

한계: SSO 세션은30분이며 플래너 역할/담당/활성은 매 요청 재검사한다. 학원 로그아웃/중지와 이미 발급한 플래너 세션의 동시 종료는 미구현(최대30분), 새 SSO는 학원 현재 상태로 차단한다. 실사용자 종단 로그인·실기기/낭독기·재부팅 복구는 미검증. 상담/리포트 자동 수신과 메시지 발송은 여전히 미연동이다.

## 2026-10-20 ECharts·pdfme 리포트 개선과 비교 샘플

사용자의 두 라이브러리 도입 요청과 버전별 샘플 요청을 구현했다. 새 작업본 C:/Users/wb/Projects/wb-site-blended-reports-20261020, codex/blended-reports-20261020. 기존 consult 및 학원 앱/다른 작업본은 수정하지 않았다.

ECharts6.1.0(Apache-2.0)과 pdfme6.2.6(MIT)의 common/generator/schemas/ui, 빌드 도구 esbuild0.28.2를 blended/package.json·package-lock.json에 고정했다. 설치 npm audit 취약점0. 신규 AI 스킬 설치가 아니라 앱 개발 라이브러리다. Ponytail full과 Impeccable은 기존 스킬을 읽고 적용했다.

리포트 목록의 ‘차트·PDF 보기’, 발행 대기의 ‘차트·PDF 미리보기’, 원장의 ‘PDF 양식 편집’을 추가했다. 기존 공개본 보기/발행/철회/인쇄는 유지한다. 기존 주간·월간 발행본에도 바로가기를 연결했다. 상담은 배정/학생 완료/강사 확인을 독립 막대로 표시하고, 주간·월간은 기록이 있는 날짜별 추이와 과목별 수치를 보여준다. 없는 기록은 미수행/0점으로 추정하지 않는다. 차트에는 수치 표를 함께 제공한다.

pdfme 편집기는 원장만 서버 저장/수정할 수 있다. 위치·글자 크기/색·문구/로고 편집, 샘플 PDF, 양식 저장, 기본 양식 불러오기(저장 전 미반영)가 가능하다. 필수 공개 필드와 한글 글꼴/A4/이미지/크기/형식·외부 URL을 검증하며 수정 충돌409를 반환한다. 새 report_layout 표만 추가했고 기존 데이터는 유지했다. 새 상담 및 주간/월간 발행본에 당시 양식을 고정한다. 양식 변경으로 이전 발행 내용과 양식을 덮어쓰지 않는다. 공개 데이터만 PDF 입력으로 만들며 내부 메모를 읽지 않는다. PDF 저장 직전에 현재 열람 권한을 재확인한다. 기존 발행본에 양식이 없으면 고정 기본 양식을 사용한다.

Noto Sans KR은 공식 Google Fonts의 고정 커밋·SHA256/OFL로 검증해 제공한다. 글꼴/라이브러리/편집기는 모두 앱 자산으로 제공하며 학생 자료를 외부 PDF 사이트로 보내지 않는다. 무거운 pdfme 편집/생성 모듈은 필요할 때 불러온다. 약10.4MB 한글 글꼴은 첫 PDF/편집 때 로드하고 해시 파일명으로 캐시한다. 인쇄 자동 확장으로 내용이 길면 여러 장이 될 수 있다. CSP의 인라인 스타일·WASM 허용은 보고서 도구 경로에만 적용하고 다른 앱의 정책은 유지했다. 직접 패키지 라이선스와 번들 법적 고지, PDFium 고지와 폰트 OFL을 함께 배포했다.

주요 변경: api.mjs·schema.sql·planner-api.mjs(공개 미리보기/양식·고정 발행), report-layout.mjs·report-model.mjs(검증/공개 데이터), reports-page.js·reports.html·reports.css, report-charts.js·report-pdf.js·report-designer.js, app.js·planner-adapter.js(진입점), build.mjs·worker.mjs·server.mjs(빌드/정적 경로). 신규 검증 reports.test.mjs·reports-browser.cjs, 샘플 생성 report-variants.cjs, Worker 검증 worker-check.mjs.

검증: 저장소 전체324/324(직렬226.6초), 기존 학습→상담→발행→동의 철회/등록·배정/충돌·입력 보존·키보드/원본6화면·일정 통합·로드맵/목차·공개 리포트 회귀 통과. 새 단위 검사는 원장 전용/불법 양식/외부 이미지·폰트/필수 필드/409/발행 양식 보존/공개 정보만 PDF에 사용/추가 문구 정규화를 검사했다. 실제 가상 브라우저에서 ECharts SVG, 한글 PDF 텍스트 추출, 비공개 메모 제외, pdfme 한국어 편집기·실제 X위치 변경 저장·기본 양식 저장, PC/390px 넘침0, 학생 편집 차단, 외부 요청0/예상 초기401 외 콘솔 오류0을 확인했다. Cloudflare 로컬 엔진에서 양식 읽기/저장·강사403 및 기존 SSO 계약 통과. Impeccable 기계 검사0건이며 도구가 절대 URL CSS를 해석하지 못한 경고는 실제 브라우저의 CSS/글꼴/반응형 측정으로 확인했다.

현재 Worker 78ac0900-2f24-48ca-a1af-81e4834f6fe6. 직전 기준0000c117-b811-4f99-abcb-21eeac7f2474 보존. 외부 /blended/reports/·reports-page.js·reports.css 해시 일치, 익명 report_layout401 확인. 배포 시 실제 계정·학생·양식·발행 자료에 시험 쓰기 없음. 학원 runtime·키·터널·실제 발송·공유 push/PR 변경0.

샘플: C:/Users/wb/.codex/.chatgpt-projects/g-p-6ad5f0507c6481919d57c4a566f69099/artifacts/report-variants-20261020. 동일한 가상 발행 자료 5배정/4학생 완료/3강사 확인을 V1 요약형(v1-summary, A4 1쪽), V2 상담형(v2-consultation, A4 1쪽), V3 상세형(v3-detail, A4 2쪽)으로 각각 HTML/PNG/PDF 생성했다. index.html·comparison.png는 비교 보기다. PNG/PDF 페이지 렌더를 확인했고 390px 넘침0이다. 세 디자인은 비교 시안이며 앱의 세 가지 선택형 프리셋으로 등록한 것은 아니다. 운영 양식은 원장이 별도 편집·저장한다.

Aside 사용자 지정 세션75Iu7ZZT1MC7VD9b(옵시디언 구상 정리)에 라이브러리/스킬 구분·설치/검증/배포 진행 상태를 기록하고 완료 갱신을 전달했다. 기존 REA 설치는10월14일 이력이며 오늘 설치로 합치지 않았다.

실행: npm ci --ignore-scripts --prefix blended → node blended/build.mjs → node blended/server.mjs. 기존 README Playwright 환경변수를 지정하고 node blended/reports-browser.cjs 또는 REPORT_SAMPLE_DIR 지정 후 node blended/report-variants.cjs. 검사 node --test blended/reports.test.mjs, 전체 node scripts/check.mjs --serial. 폰트 첫 빌드만 공식 저장소 다운로드가 필요하고 이후 고정 해시 캐시를 재사용한다. 배포는 기존 전용 Wrangler 설정만 사용한다.

미확인: 실제 학생/사용자 종단 시험·실기기/낭독기·느린 이동통신 성능. 양식 편집기는 첫 로드 용량이 크며 휴대폰에서는 편집 영역을 좌우로 이동한다. 기존 자동 로그인30분/동시 로그아웃 미연동 한계와 실제 발송 미연동은 그대로다.
