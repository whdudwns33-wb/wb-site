# 보호자 포털

`sync/wrangler.toml`의 **wb-sync Worker assets**로 서비스하는 보호자 화면이다.
API와 같은 origin의 세션 쿠키(`credentials:'include'`)를 사용한다. GitHub Pages의 사본은 운영 포털이 아니다.

| 경로 | API·공개 범위 |
|---|---|
| `index.html` (`/`) | `POST /parent-portal`, `app:'task'`. 해당 자녀의 확정 수업·출결·차량·보강·회차·피드백·공개 숙제/준비물·공지·교재 진행·보호자 요청. 서버 capability에 따라 표시한다. |
| `consult-guardian/index.html` (`/consult-guardian/`) | `POST /consult-guardian`, `app:'consult'`. 동의한 학생의 주간/월간 학습 리포트·확인 기록·공유된 PDF 결과지. task 포털과 표·쿠키·동의를 분리한다. |

일회용 초대 코드를 세션으로 교환하고 주소에서 제거한다. 로그아웃·연결 해제 뒤에는 새 초대가 필요하다.
내부 메모·연락처·주소·정류장·업체 정보를 응답이나 화면에 더하지 않는다.
운영 설정 `WB_GUARDIAN_CONTACT_ENABLED=false`는 task 보호자 접근·응답·발송을 기본 중지한다.
비공개 학생별 허용 목록이 있으면 그 범위만 예외다. 수업 피드백의 별도 전체 학생 허용 설정과
consult 공유는 각 서버 정책을 따른다. 문서 수정으로 활성화하지 않는다.

배포 정본은 [`sync/README.md`](../sync/README.md)와
[`sync/PORTAL_RELEASE_RUNBOOK.md`](../sync/PORTAL_RELEASE_RUNBOOK.md)다.
필요한 마이그레이션 → wb-sync Worker/assets → task/consult Pages 순서로 수동 배포한다.
`_headers`는 이 Worker assets용이며, Pages 사본에는 HTML의 noindex만 적용된다.

저장소 뿌리에서 `node scripts/check.mjs --only parent`와 `node scripts/check.mjs --only sync`를 실행한다.
전체 `node scripts/check.mjs` 통과와 별도로 운영 쿠키·초대/해제 확인은 배포 절차를 따른다.
