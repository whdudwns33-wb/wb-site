# 업무지시서 원장 로그인 · API · MCP

소스는 `whdudwns33-wb/wb-site`의 `task/`, 데이터는 기존 `wb-sync` Cloudflare Worker/D1이다.
WB1에는 같은 저장소의 작업 사본과 다른 앱 서버가 있다. 업무 데이터는 PC/NAS로 이전하지 않는다.

## 사용

- Cloudflare 화면: https://wb-sync.whdudwns33.workers.dev/task/
- 기존 Pages 화면: https://whdudwns33-wb.github.io/wb-site/task/
- 초기 아이디: `whdudwns33`. 초기 비밀번호는 설치 시 환경변수로 지정한다.
- 첫 로그인에서는 비밀번호 변경만 가능하다. 새 비밀번호는 8~128자이며 다시 로그인해야 한다.
- 로그인은 12시간이다. 로그아웃하면 해당 세션이 해지된다.
- 설정 → API · MCP 연결에서 이름을 입력하고 키를 발급한다. 원문은 한 번만 표시한다.
  키는 90일 유효하며 목록에서 개별 해지한다. 비밀번호 변경 시 모든 세션·키가 무효화된다.
- 기존 직원 개인 연결·원장 비밀키·운영 데이터는 유지한다.

## API

`POST /task-api`, `Authorization: Bearer <발급한 키>`, `Content-Type: application/json`.

```json
{"path":"/sync","body":{"since":0,"changes":[]}}
```

`app:'task'`와 원장 인증은 서버가 주입한다. 클라이언트의 app/auth는 무시한다.
허용 경로는 `sync/task-director.js`의 `TASK_ADMIN_PATHS`, 본문 계약은 `sync/README.md`를 따른다.
업무·직원·원생·수업·출결·교재·차량·발송·연결 관리 등 기존 원장 권한을 제공한다.
수정·삭제·발송은 실제 운영에 반영되므로 기존 CAS/revision/idempotency 규칙을 따른다.
다른 앱, Cloudflare 관리, 임의 SQL/파일/셸 실행, 개인대화의 개인 신원은 제공하지 않는다.
첫 동기화의 dataGeneration을 이후 쓰기에 반영하고 페이지/델타 계약을 지킨다.

`POST /task-account` 로그인 본문: `{action:'login',loginId,password}`.
나머지는 브라우저 로그인 Bearer만 허용한다. `password`는 `currentPassword,password`,
`issue_key`는 `label`, `revoke_key`는 `tokenHash`, `keys`·`logout`은 action만 보낸다.
비밀번호·키·인증 본문은 로그/저장소에 남기지 않는다.

## MCP

Streamable HTTP: `https://wb-sync.whdudwns33.workers.dev/task-mcp`.
Bearer 헤더를 지원하는 MCP 클라이언트에 주소와 키를 설정한다.
`task_admin_request` 도구 입력은 API와 같은 `{path,body}`다.
OAuth 자동 연결은 제공하지 않는다. Bearer 설정이 없는 클라이언트는 stdio를 사용한다.

```json
{"mcpServers":{"wb-task-director":{
  "command":"node",
  "args":["<저장소 절대 경로>/scripts/task-director-mcp.mjs"],
  "env":{"WB_TASK_ADMIN_TOKEN":"<설정 화면에서 발급한 키>"}
}}}
```

기존 `scripts/task-mcp-server.mjs`와 읽기 전용 토큰은 계속 읽기 전용이다.

## 최초 설치와 배포

저장소 루트에서 실행한다. 기존 `sync/deploy.ps1`은 새 DB 설치용이므로 사용하지 않는다.

1. `node scripts/check.mjs` → 작업 브랜치 PR → checks 초록 → squash merge.
2. `npx wrangler@4 login` 후 기존 운영 계정을 확인한다.
3. 운영 D1을 저장소 밖의 비공개 경로로 `d1 export`하고 SQLite 복원·무결성·기존 건수를 확인한다.
4. 초기 비밀번호를 `TASK_INITIAL_PASSWORD` 환경변수로 전달하여 `node sync/task-director-setup.mjs`를 실행하고 환경변수를 지운다.
   `.private/task-director-seed.sql`에는 무작위 salt와 해시만 있다. 기존 계정은 덮어쓰지 않는다.
5. `npx wrangler@4 d1 execute wb-sync --remote --config sync/wrangler.toml --file .private/task-director-seed.sql`.
   기존 마이그레이션 전체를 재실행하지 않는다. 이번 추가는 `089_task_director.sql` 두 테이블뿐이다.
6. `node sync/build-task-assets.mjs` → `npx wrangler@4 deploy --config sync/wrangler.toml`.
   dist에는 보호자 기존 정적 파일과 업무지시서 실행 자산만 조립한다.
7. `/task/`, 기존 보호자 `/`, `/health`, 초기 비밀번호 변경 게이트, 무인증 API/MCP 차단을 확인한다.
   Pages는 main 반영 후 갱신한다. 직원 연결 해지·알림 시험 발송은 하지 않는다.

롤백: 배포 직전 Worker version으로 되돌린다. 독립적인 계정 테이블은 남겨도 된다.
계정 삭제/비밀번호 초기화/기존 데이터 복원은 이 절차에 포함하지 않는다.
