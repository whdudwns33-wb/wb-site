# WB 컨설팅 플래너

`/task/`(직원 업무지시서)를 컨설팅 학생용으로 복제한 앱. 코드는 같고 **데이터 통은 완전히 분리**되어 있다.

| | /task/ (직원용) | /consult/ (학생용) |
|---|---|---|
| 사용자 | 직원 | 컨설팅 학생 |
| 저장 키 | `wb_taskboard_v1` | `wb_consult_v1` |
| 시트 | WB 업무지시서 | WB 컨설팅 플래너 (데이터) |
| Apps Script | 별도 배포 | 별도 배포 (SECRET 다름) |
| 드라이브 자동 등록 접두어 | `WB_지시서입력_*.json` | `WB_컨설팅입력_*.json` |
| 테마 | 파랑 | 보라 |

같은 도메인(github.io)이라 localStorage가 공유되므로 저장 키가 다른 것이 데이터 분리의 핵심이다.
두 앱의 Apps Script가 서로 다른 파일명 접두어를 스캔하므로 자동 등록도 섞이지 않는다.

세팅 방법은 `task/README.md`와 동일 — 새 스프레드시트에서 확장 프로그램 → Apps Script에
`consult/apps-script.gs`를 붙여넣고 웹 앱으로 배포한 뒤, 앱 설정에 URL과 비밀키를 넣는다.
`importFromDrive` 트리거(10분)도 컨설팅용 스크립트에 따로 걸어야 자동 등록이 동작한다.
