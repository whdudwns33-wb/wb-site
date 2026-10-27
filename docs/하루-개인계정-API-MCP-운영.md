# 대비 앱 개인 계정·API·MCP (2026-10-27)

## 범위와 권한

- 화면: `https://haru.wbcowork.com/`, 개인 로그인: `/haru/staff/`, 관리 화면: `/admin/haru-admin.html`.
- 서버는 wb1의 127.0.0.1:8951. Cloudflare 명명 터널 `wb-haru-wb1`로만 외부에 연결한다.
- 두 관리자 계정은 비공개 초기화 파일로 등록한다. 아이디는 `wb이름`, 최초 비밀번호는 원장 지정값이다. 기존 계정을 다시 초기화하지 않는다.
- 최초 비밀번호 변경은 서버 PC의 `http://127.0.0.1:8951/haru/staff/`에서만 허용한다. Cloudflare·전달 헤더가 붙은 요청은 금지한다. 변경 후 외부에서 로그인할 수 있다.
- 새 비밀번호는 8자 이상. 변경 시 모든 세션·API 키를 폐기한다. 로그인 12시간, API 키 90일. 계정당 5회 실패 시 5분 잠금, IP당 5분 20회 제한.
- 학생·자료·플랜·현황·내보내기·파기 등 **기존 하루 관리자 API만** 허용한다. 다른 WB 앱·계정 발급·서버 명령 권한은 없다. 교사에게 별도 제한 역할을 만들지 않고 원장 요청대로 두 계정 모두 대비 앱 관리자로 둔다.
- 실제 학생·보호자 계정이나 기록을 초기화·이관하지 않는다. 기존 학습·채점 서버와 Cloudflare KV를 유지한다. 학생·보호자 화면은 기존 Worker로 연결한다.

## API와 MCP 연결

로그인 → 개인 계정 화면 → 연결 이름 입력 → 개인 API 키 발급. 값은 한 번만 표시하며 비밀 보관소에 보관한다. 공개 문서·소스·채팅에 붙이지 않는다. 키 목록에서는 값 대신 이름·만료일만 보이고 직접 폐기할 수 있다.

- API: `https://haru.wbcowork.com/api/haru/admin/`
- MCP: `https://haru.wbcowork.com/mcp` (Streamable HTTP, JSON 응답)
- 인증: `Authorization: Bearer <개인 API 키>`
- MCP 도구: `haru_admin_request`, 인수 `method`, `path`, 선택 `body`.
- 읽기 예: `{"method":"GET","path":"/api/haru/admin/plans"}`.
- GET: students, packs, paperkeys, plans, plan, atoms, board, map, reports, export.
- POST: enroll, pack, paperkey, paper, plan, cohort, atoms, parentlink, reports/resolve, purge.
- DELETE: pack, plan. 경로 앞에는 `/api/haru/admin/`를 붙인다. 본문·쿼리는 기존 `haru-api.mjs` 계약과 같다.
- MCP 협상 버전: 2025-11-25 / 2025-06-18 / 2025-03-26. 클라이언트가 Bearer 헤더를 지원해야 한다. OAuth 자동 로그인·SSE 구독은 제공하지 않는다.
- 키로 다른 키를 발급하거나 비밀번호를 변경할 수 없다. MCP도 HTTP API와 동일한 허용 목록을 통과한다. 도구의 파기 기능은 사용자가 대상을 명시해 요청한 경우에만 사용한다.

## 저장·기동·복구

- 접속 서버 설정·SQLite 계정/세션/감사 로그·실행 스크립트는 저장소의 `.private/haru-staff/`에 둔다. 초기화 파일은 계정 생성 직후 삭제한다. 계정과 키는 해시로만 저장하고 요청 본문·학생 응답·키 값은 감사 로그에 기록하지 않는다.
- `WB_HARU_CONFIG`로 비공개 JSON 설정 경로를 지정하고 `node reading-server/haru-staff-server.mjs`를 실행한다. JSON 필드: privateDir, port, publicOrigin, backend, secret. secret은 새 Worker 전용 시크릿 `HARU_STAFF_GATEWAY_SECRET`과 같아야 한다.
- 전용 Worker `wb-haru-api`는 기존 KV 어댑터·관리자 핸들러를 재사용한다. 공개된 Worker 주소로 직접 요청하면 전용 키 없이는 401이다. 기존 `wb-reading` Worker와 다른 앱 터널은 수정하지 않는다.
- Windows 작업 스케줄러 `WB Haru Staff Server`, `WB Haru Staff Tunnel`은 현재 사용자 로그인 때 시작하고 실패 시 재시작한다. 서버 PC 전원·네트워크·사용자 로그인이 필요하다. 절전·로그아웃·종료 시 외부 접속이 중단될 수 있다.
- 계정 저장소를 백업하려면 서버 작업을 멈춘 뒤 비공개 폴더 전체를 암호화된 보관소에 복사하고 재기동한다. 실행 중 SQLite 본체 파일만 복사하면 WAL 변경을 놓칠 수 있다. 학생 기록 백업은 기존 Worker 절차를 따른다.
- Windows에서 작업 중지가 자식 Node를 남길 수 있다. 8951 리스너의 명령줄이 이 작업 폴더의 `haru-staff-server.mjs`인지 확인한 뒤 해당 프로세스만 종료하고, 리스너가 사라진 것을 확인해야 중지가 완료된다. 재기동은 서버 작업을 다시 시작한다. 다른 Node·터널 프로세스를 일괄 종료하지 않는다.
- 복구 시 비공개 폴더·Cloudflare 터널 자격 파일을 복원하고 포트/호스트·시크릿 일치를 확인한다. 초기화 명령을 비밀번호 재설정 용도로 쓰지 않는다.
- 철회는 두 작업 중지 → 새 터널/DNS 제거 → 전용 Worker 삭제 순서다. 기존 학습 서버·KV·다른 WB 앱은 삭제하지 않는다.

## 검증

`node reading-server/haru-staff.test.mjs`는 가상 계정으로 최초 로컬 변경, 외부 초기 로그인 차단, 다른 앱 차단, 키 발급/폐기, 비밀번호 변경에 따른 일괄 폐기, MCP 도구, 요청 크기·출처·호스트, 공개 파일 경계를 검사한다. 운영 학생 데이터에 쓰지 않는다.

`node scripts/check.mjs --serial`로 저장소 전체 검사, 전용 Wrangler 설정의 dry-run으로 빌드를 확인한다. 운영에서는 익명 API 401·초기 비밀번호 외부 차단·공개 화면만 확인한다. 실제 두 교사의 새 비밀번호 설정과 로그인은 당사자가 마무리해야 한다.
