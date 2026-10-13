# 학생 포털

`sync/wrangler.student.toml`의 **wb-student Worker assets**로 서비스하는 학생 화면이다.
직원·보호자 wb-sync와 다른 origin이며, `POST /student-portal` (`app:'task'`)에
`credentials:'include'`로 학생 세션 쿠키를 보낸다. consult 학습 플래너와는 별도 앱이다.

원장이 만든 일회용 초대 코드를 세션으로 교환하고 주소에서 제거한다. 기존 학생 연결이 있는 기기는
임의로 바꾸지 않고 로그아웃 뒤 새 초대를 연결한다. 인증 만료·해제 후에는 새 링크가 필요하다.

- 내 수업·출결·5단계 진행, 최근 14일 **학생 공개가 확인된** 숙제·준비물, 차량 탑승,
  교재 준비/수령, 확정 주간 시간표를 표시한다.
- `selfCheck` capability가 열리면 오늘 공개한 할 일에 **완료/도움 필요**만 선택한다.
  교사 확인 전에는 최종 완료가 아니며 공개 revision과 선택 revision을 함께 보낸다.
- `externalLearning` capability가 열리면 메타수학·클래스카드로 이동한다.
  외부 서비스의 로그인 정보·학습 결과를 WB에 받거나 저장하지 않는다.
- 연락처·주소·정류장·내부 메모·보호자 전용 기능은 제공하지 않는다.

배포 정본은 [`sync/README.md`](../sync/README.md)와
[`sync/PORTAL_RELEASE_RUNBOOK.md`](../sync/PORTAL_RELEASE_RUNBOOK.md)다.
포털 마이그레이션 036~040 확인 → wb-sync → **wb-student** → task Pages 순서를 지킨다.
학생 Worker를 생략하면 초대 발급이 가능해도 화면이 열리지 않는다. 학생·보호자/직원 origin은 분리한다.
`_headers`는 이 Worker assets용이며, Pages 사본에는 HTML의 noindex만 적용된다.

저장소 뿌리에서 `node scripts/check.mjs --only student`와 `node scripts/check.mjs --only sync`를 실행한다.
PR 전에는 전체 `node scripts/check.mjs`를 통과시키고 실제 기기의 초대·로그아웃·해제를 배포 절차대로 확인한다.
