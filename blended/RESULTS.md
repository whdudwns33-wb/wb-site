# 블렌디드 플래너 작업·검증 보고 (2026-10-19)

## 현재 상태

구현과 가상 자료 시험은 완료했다. Cloudflare 전용 Worker 배포와 **일반 외부 주소 HTTPS 접속 확인까지 완료**했다.
배포 직후 새 도메인의 공개 DNS 반영 오류가 있었고, 신규 도메인 재연결 후 2026-10-19 20:32 KST에 정상 응답을 확인했다.
20:36 KST 일반 DNS를 통한 재검사에서도 화면 200, 비로그인 자료 접근 401, 가상 계정 로그인 거부 401, 외부 출처 요청 403, 소스/DB/문서 경로 404를 확인했다.
원장 아이디는 `whdudwns33`이다. 비밀번호는 사용자 직접 설정 단계이며 채팅·파일·로그에 남기지 않는다.

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

현재 PC의 최초 설정 화면 <http://127.0.0.1:8897/>에서 새 비밀번호를 두 번 입력한다.
설정 화면이 꺼진 경우 이 작업 폴더에서 `python blended/first-setup.py`로 연다. 일반 재실행은 외부 DNS가 정상이어야 한다.
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
| 실제 외부 계정·강사 사용 | 사용자 원장 최초 설정 후 확인 필요. 외부 주소·로그인 화면·비인증 차단은 검증 완료 |

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
현재 코드 버전: `d22a4a71-8f48-4067-b6fb-71fc78437696`.
기존 운영 Worker/D1/R2/시크릿/프로세스/학원 앱은 변경하지 않았다.
새 원장 설정용 시크릿만 신규 앱에 생성했고, 설정 키와 비밀번호는 파일·로그에 출력하지 않았다.
도메인 연결 오류 조사 중 이 신규 도메인만 재연결했다. 도메인 루트와 다른 서브도메인은 변경하지 않았다.

운영은 빈 저장소로 시작한다. 기존 자료 이관과 실제 메시지 발송은 승인 범위에 포함하지 않았다.
DNS 조사 중 최초 설정 도구는 잠시 확인된 Cloudflare IP에만 이름 해석을 지정해 실행했다. 인증서 검증을 유지했고 OS DNS/hosts는 변경하지 않았다. 현재 실행 중인 설정 도구는 일반 DNS를 사용한다.

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
월간 확장·오프라인 저장·파일 첨부·자동 초대는 하지 않았다.
대규모 부하, 실제 데이터 백업 복원, 실사용자 종단 시험은 미검증이다. 현재 구현은 단일 학원의 전용 저장소 기준이다.
