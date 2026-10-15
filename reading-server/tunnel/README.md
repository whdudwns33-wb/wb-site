# 원장 PC 를 관리 서버로 — Cloudflare 터널 설치 키트 (Windows)

원장 요청: "클라우드플레어로 외부에서 접속되게 하고 이 컴퓨터를 서버로."
결정과 그 이유는 [`docs/로컬-서버-외부공개-터널.md`](../../docs/로컬-서버-외부공개-터널.md)가 정본이다.
이 문서는 **그 결정(A안)을 원장 PC 에서 그대로 따라 하는 순서**다.

```
원장·강사 브라우저 ─▶ https://wb.<내도메인>  ─▶ Cloudflare Access(이메일 코드)
                                                 └▶ 터널 ─▶ 이 PC 의 cloudflared ─▶ 127.0.0.1:8890 관리 서버(관리 전용)
학생 ─────────────▶ 지금 쓰는 운영 주소(wb-reading 워커) 그대로 — 이 PC 와 무관
```

- **원장·강사 전용이다.** 서버는 학생 로그인을 내주지 않는다(`WB_ADMIN_ONLY` — 실행기가 강제).
  학생 기록의 정본은 운영 워커에 있고, 여기에 학생이 붙으면 진도가 두 곳에 갈라진다.
- **두 겹으로 잠근다.** Cloudflare Access(허용한 이메일만) → 관리 로그인(아이디·비밀번호).
- **이 PC 바깥에서는 터널로만 들어온다.** 서버는 127.0.0.1 에만 묶여 같은 와이파이의 다른 기기도 못 붙는다.
- **서버는 저장소가 아니라 관리자 전용 사본을 돌린다.** 작업 스케줄러가 SYSTEM 으로 띄우는 코드를 저장소(일반 사용자도
  고칠 수 있는 자리)에서 바로 읽으면, 누구든 파일 한 줄로 SYSTEM 권한을 얻는다. 그래서 `install-server`·`restart-server` 가
  서버에 필요한 폴더와 **지금 쓰는 node.exe 까지** `C:\ProgramData\WB\app` 에 복사해 잠그고 그것을 돌린다(저장소에 링크가 있으면
  복사하지 않는다). 저장소는 원장·코덱스가 평소처럼 고친다.
- **이 관리 웹은 운영 관리 웹이 아니다.** 자료는 이 PC 의 `DATA_DIR\db.json` 에만 있고(처음엔 비어 있다)
  운영 워커의 학생 기록과 섞이지 않는다. 원장 PC 에서 하는 일(팩 제작·검수, 자료 정리)에 쓴다.
  **학생 등록·진도 확인·가정 발송은 지금처럼 운영 주소의 `/admin` 에서** 한다. 여기서 만든 가족 링크·안내 링크는
  이 잠긴 주소를 가리키므로 **가정에 보내지 않는다**(가정에 나가는 링크는 사람 확인 사항 — 저장소 규칙 7).
- **금고(A.5, 국어 자료를 원장 PC 2대로)는 이 키트에 들어 있지 않다.** 원장 확인 4건이 끝나기 전에는
  코드를 쓰지 않기로 했다(정본 문서 §1.5 「남은 것」). 금고를 만들 때도 이 터널에 경로를 더하는 식이다.

## ⚠ 먼저 읽기 — WB1 에는 이미 다른 체계가 돌고 있다 (2026-10-15)

이 키트는 2026-10-12 에 "원장 PC 에 **처음** 까는" 전제로 만들었다. 그 사이 WB1 에는 다른 방식의 관리 서버·터널이
이미 운영 중이다(키트는 아직 어느 PC 에도 설치되지 않았다).

| WB1 에 이미 있는 것 | 근거 |
|---|---|
| 국어 관리 서버 — `reading-server/start-admin.ps1` → `127.0.0.1:8891`, 예약 작업(사용자 로그온), 자료 `%LOCALAPPDATA%\WB\korean-admin-server` | `docs/코덱스-외부작업-인수인계-2026-10-14.md` §3 |
| 기존 Cloudflare 터널(이 PC 의 cloudflared) + Access(원장 1명 허용) | 같은 문서 §3 |
| 영어 내신 서버가 **8890**(= 이 키트의 기본 포트)을 쓰고, 같은 터널에 경로가 붙어 있다 | 미병합 브랜치 `codex/naesin-practice-assignment` 의 `docs/내신브레인-원내PC-실운영-계획.md` |

그래서 **원장이 "이 키트로 옮긴다"고 정하기 전에는 어느 PC 에도 설치하지 않는다.** WB1 에서는 특히:

- 대시보드에서 새 터널을 만들지 않고, `setup.mjs tunnel` 을 돌리지 않는다. 도구는 기존 **Windows 서비스** `Cloudflared` 가
  보이면 토큰 파일을 요구하기 전에 거절하고(확인이 실패해도 설치하지 않는다), 토큰이 든 파일은 지운다 — 하지만 WB1 의 연결기가
  로그온 예약 작업으로 돈다면 서비스로 보이지 않아 이 거절이 걸리지 않는다. 도구를 믿지 말고 치지 않는다.
  **`cloudflared service uninstall` 을 치지 않는다** — 그 PC 의 기존 관리 주소가 모두 끊긴다. 새 주소가 필요하면 원장이
  대시보드에서 기존 터널에 경로(Published application)를 더한다.
- `install-server` 의 `DATA_DIR` 에 다른 서버의 자료 폴더를 적지 않는다(잠그면 그 서버가 자기 `db.json` 을 못 연다). 사용자 AppData 아래는
  도구가 거절하지만, 그 밖의 다른 서버 자료 폴더(다른 clone 의 `reading-server\data` 등)는 구별하지 못한다 — 늘 새 빈 폴더(`C:\WB_server_data`)만 쓴다.
- `doctor` 는 이 키트의 설치를 기준으로 본다. WB1 에서는 그 권고를 **하나도** 따르지 않는다 — "작업 없음 → install-server",
  "cloudflared 서비스 없음 → 3단계(tunnel)", "직접 띄운 `server.mjs` 창을 닫으라" 모두. 앞의 둘은 키트를 새로 깔게 하고,
  셋째는 8890 의 영어 서버(또는 다른 개발 서버)를 끄게 한다.

옮기기로 정했을 때의 순서는 맨 아래 「WB1 을 이 키트로 옮길 때」를 따른다.

## 들어 있는 것

| 파일 | 하는 일 |
|---|---|
| `setup.mjs` | 설치·점검 도구. `env` · `install-server` · `restart-server` · `uninstall-server` · `tunnel` · `doctor` |
| `run-server.mjs` | 서버 실행기. 저장소 밖 설정 파일을 검사하고, 관리 전용·127.0.0.1 로 `server.mjs` 를 띄우고, 로그를 남기고, 죽으면 다시 띄운다. 깨진 `db.json` 이면 띄우지 않는다(빈 DB 가 원본을 덮어쓰지 않게). 로그를 쓰기 전에 실패하면 설정 파일 옆 `run-server-error.log` 에 이유를 남긴다 |
| `exit-with-parent.mjs` | 실행기가 꺼지면 서버도 같이 꺼지게(Windows 는 부모를 꺼도 자식이 남는다) |
| `kit.mjs` | 위 둘이 쓰는 판단 로직(부작용 없음) — 테스트가 여기를 본다 |
| `*.test.mjs` | `node scripts/check.mjs --only tunnel` (`app-copy.test.mjs` 는 실제로 사본을 만들어 서버를 띄워 본다) |

---

## 0. 먼저 정할 것·준비할 것 (한 번만)

1. **관리 서버는 PC 한 대에서만 켠다.** 두 대에서 각각 켜면 관리 웹에서 올린 자료가 두 PC 에 따로 쌓인다.
   (집·학원 2대는 금고 이야기다 — 이 키트와 별개.) 늘 켜 두기 쉬운 PC 를 고른다.
2. **도메인이 Cloudflare 에 '활성(Active)'이어야 한다.** 무료 요금제는 네임서버를 Cloudflare 로 옮기는 방식만 된다
   (CNAME 부분 설정은 Business 이상).
   - 옮기기 전에 도메인을 산 곳에서 **DNSSEC 를 끈다** — 켠 채로 옮기면 도메인이 한동안 안 열릴 수 있다.
   - 그 도메인으로 **메일·홈페이지를 쓰고 있다면** Cloudflare 가 가져온 DNS 레코드(MX 등)가 다 있는지 확인하고 옮긴다.
3. **Node.js 22 이상**을 설치한다 — nodejs.org 의 LTS `.msi` 를 권한다(또는
   `winget install --id OpenJS.NodeJS.LTS -e --installer-type wix --scope machine`). 작업은 설치된 node 가 아니라
   `install-server` 때 사본 안에 복사한 `node.exe` 를 돌리므로, Node 를 올린 뒤에는 `restart-server` 한 번이면 반영된다.
4. **저장소를 받아 둔다** — 예: `C:\WB\wb-site`. **OneDrive 안(바탕 화면·문서 폴더가 OneDrive 로 옮겨진 PC)은 피한다** —
   서버는 SYSTEM 계정으로 돌아 그런 자리의 파일을 못 읽을 수 있다. 자료 폴더(`DATA_DIR`)는 OneDrive·NAS 경로면 실행기가 거절한다.
5. **절전을 끈다** — 관리자 터미널에서 `powercfg /change standby-timeout-ac 0` · `powercfg /change hibernate-timeout-ac 0`
   (지금 쓰는 전원 계획에만 적용된다 — 계획을 바꾸면 다시). 노트북이면 전원을 꽂아 둔다. 절전에 들어가면 바깥에서 안 열린다.
6. 아래 명령은 전부 **관리자 권한 터미널**에서 저장소 폴더로 가서 친다
   (시작 메뉴 → "터미널" 오른쪽 클릭 → 관리자 권한으로 실행 → `cd C:\WB\wb-site`).

## 1. 서버 — 설정 파일 만들고 자동 시작 등록

```bat
node reading-server\tunnel\setup.mjs env
notepad C:\ProgramData\WB\server.env
```

`env` 는 설정 폴더 `C:\ProgramData\WB` 를 **먼저 관리자·SYSTEM 만 열리게 잠그고**(주인도 관리자로) 그다음 견본을 만든다.
잠근 뒤 실제 권한을 다시 읽어 남의 권한이 남아 있으면 지우고, 그래도 남으면 멈춘다. 그래서 메모장도 **같은 관리자 터미널**에서 연다.
메모장에서 채운다(값은 **원장이 직접** — 채팅·에이전트에게 알려 주지 않는다):

| 키 | 넣을 것 |
|---|---|
| `ADMIN_ID` / `ADMIN_PASSWORD` | 관리 로그인. 비밀번호 12자 이상. **운영 워커와 다른 값**으로 — 한쪽이 새도 다른 쪽은 지킨다 |
| `DATA_DIR` | 자료 폴더 — **서버 전용 새 폴더**, 이 PC 디스크. 기본 `C:\WB_server_data`. 관리자만 열리게 잠그므로 기존 자료 폴더·바탕 화면·문서·드라이브 뿌리·OneDrive·NAS(`\\NAS\…`, 매핑된 `Z:` 같은 네트워크 드라이브)는 거절한다 |
| `PORT` | 그대로 8890 |
| `PUBLIC_HOST` | 바깥 주소 이름만 — 예 `wb.내도메인.com` (점검 도구가 Access 확인에 쓴다) |

`WB_ADMIN_ONLY`·`HOST` 는 적지 않는다(실행기가 강제한다. 다르게 적으면 서버가 안 뜬다).
**위 표에 없는 키는 받지 않는다**(AI 초안을 쓸 때의 `ANTHROPIC_API_KEY` 처럼 서버가 읽는 선택 키만 예외) — 이 파일의 값은
SYSTEM 으로 도는 서버에 그대로 넘어가므로, `NODE_OPTIONS`·`PATH` 같은 값이 끼면 SYSTEM 으로 코드를 싣는 길이 된다.

```bat
node reading-server\tunnel\run-server.mjs --check
node reading-server\tunnel\setup.mjs install-server
```

`install-server` 는 서버 코드를 `C:\ProgramData\WB\app` 에 복사해 잠그고, 자료 폴더를 잠그고(둘 다 잠근 뒤 실제 권한을 다시 읽는다),
작업 스케줄러에 등록한다. `서버가 떴습니다 ✓` 가 나오면 이 PC 브라우저에서 `http://127.0.0.1:8890/admin` 이 열린다.
작업 스케줄러에 `WB-Admin-Server` 가 생기고, **부팅 30초 뒤 + 5분마다**(죽어 있으면) 자동으로 뜬다 — 로그인하지 않아도.
`schtasks /Query /TN WB-Admin-Server /V /FO LIST` 로 실행 사용자 SYSTEM·시간 제한 없음을 볼 수 있다.
한 번은 **재부팅한 뒤 로그인하지 않은 채** 다른 기기에서 열리는지(또는 로그인 후 `doctor`) 확인해 둔다.

## 2. cloudflared 설치

공식 설치 파일만 쓴다: <https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.msi>
설치 뒤 새 관리자 터미널에서 `cloudflared --version` — **2026.7.3 이상**이어야 한다
(그보다 옛 버전은 서비스 설치 때 터널 토큰을 레지스트리에 평문으로 남긴다. `setup.mjs tunnel` 이 옛 버전을 거절한다).
키트는 **Program Files 아래의 cloudflared 만** 쓴다 — `C:\` 바로 아래나 사용자 폴더에 둔 cloudflared.exe 는 일반 사용자가
바꿔 끼울 수 있고, 그 파일이 토큰을 받고 SYSTEM 서비스로 등록되기 때문이다.

## 3. Cloudflare — **Access 를 먼저, 터널 경로는 맨 나중에**

순서가 중요하다. 경로(Route)를 먼저 만들면 Access 를 걸 때까지 관리 화면이 인터넷에 그대로 열린다
(Cloudflare 문서도 같은 경고를 한다).

**3-1. Zero Trust 시작** — Cloudflare 대시보드 → Zero Trust. 무료 요금제(50명까지)를 고른다.
결제 수단을 물을 수 있는데 무료 요금제는 청구되지 않는다. 팀 이름(team name)을 정한다.

**3-2. 로그인 방법 추가** — Zero Trust → Integrations → Identity providers → Add new → **One-time PIN**.
새로 만든 조직은 기본 로그인 방법이 "Cloudflare 계정 구성원만"이라, 이것을 안 하면 강사님들이 로그인하지 못한다.

**3-3. Access 응용 만들기** — Zero Trust → Access controls → Applications → Create new application →
**Self-hosted and private** → Add public hostname:
- Subdomain `wb`, Domain 은 내 도메인, **Path 는 비운다**(호스트 전체를 잠근다)
- 정책: Action **Allow**, 규칙 **Include → Emails** 에 원장·강사 이메일
  (⚠ Require 에 여러 이메일을 넣으면 "모두 동시에 해당"이 되어 아무도 못 들어간다)
- 로그인 방법: **One-time PIN** 만 고른다(기본 "Cloudflare" 는 끈다)
- 세션 24시간(기본값) → Create

**3-4. 터널 만들기** — Cloudflare 대시보드 → **Networking → Tunnels** → Create Tunnel → 이름 `wb-admin` →
환경 **Windows 64-bit** → "Install and run" 에 보이는 명령(`cloudflared.exe service install eyJ...`)을 복사한다.
그 긴 값이 **터널 토큰(비밀)** 이다. **터미널에 직접 붙여 넣지 않는다** — Windows 터미널(PowerShell)은 친 명령을
사용자 폴더의 기록 파일(ConsoleHost_history.txt)에 평문으로 남긴다. 대신 같은 관리자 터미널에서:

```bat
notepad C:\ProgramData\WB\tunnel-token.txt
node reading-server\tunnel\setup.mjs tunnel --token-file C:\ProgramData\WB\tunnel-token.txt
```

메모장이 "새로 만들까요?" 하면 예 → 복사한 명령을 통째로 붙여 넣고 저장 → 닫는다. (**"문서 폴더에 저장할까요?"** 가 뜨면
거절한다 — 관리자 터미널에서 연 메모장이 아니라는 뜻이고, 문서 폴더는 OneDrive 로 올라갈 수 있다.)
`tunnel` 은 먼저 이 PC 에 Cloudflared 서비스가 있는지 보고(있거나 확인이 안 되면 멈춘다), cloudflared 버전을 확인하고
(2026.7.3 미만이면 멈춘다), 토큰을 화면에 찍지 않고 서비스를 설치한다. 토큰이 든 파일은 **성공·실패와 관계없이 지운다**
(토큰이 없는 파일 — 경로를 잘못 준 `server.env` 등 — 은 지우지 않는다). `--dry-run` 은 지우지 않으니 직접 지운다. 이미 터미널에 붙여 넣었다면: (PowerShell 에서) `Remove-Item (Get-PSReadLineOption).HistorySavePath` 로 기록 파일을 지우고,
아래 5절 "토큰이 샜다고 의심될 때" 대로 토큰을 바꾼다.

대시보드에 커넥터가 연결됨(Connected/Healthy)으로 보이면 다음으로.

**3-5. 경로 연결(맨 마지막)** — 그 터널 → **Routes → Add route → Published application**:
- Subdomain `wb`, Domain 내 도메인, Path 비움
- Service URL **`http://127.0.0.1:8890`** — `localhost` 가 아니라 숫자로(서버가 127.0.0.1 에만 묶여 있다)

## 4. 확인

```bat
node reading-server\tunnel\setup.mjs doctor
```

**`✗` 가 하나도 없어야 하고, 바깥 주소 `/`·`/admin/` 두 줄이 `✓`("Access 가 로그인을 요구합니다")** 여야 한다.
`·` 는 "확인하지 못한 항목"이다(관리자 터미널이 아니라 권한을 못 읽었다 등) — 읽어 보고 넘어가도 되는지 판단한다.
점검은 관리자 터미널에서 해야 폴더 권한(설정·자료·코드 사본)까지 본다.
`위험: Access 없이 서버가 그대로 열려 있습니다` 가 나오면 **즉시** 3-5 의 경로를 지우고 3-3 을 다시 확인한다.

마지막으로 와이파이를 끈 휴대폰(LTE)으로 `https://wb.<내도메인>/admin` → Cloudflare 이메일 코드 화면 →
코드 입력 → 관리 로그인 화면이 나오면 끝이다.

## 5. 평소 운영

| 할 일 | 방법 |
|---|---|
| 코드 업데이트 | `git pull` → `git status` 가 깨끗한지 본다 → (관리자 터미널) `node reading-server\tunnel\setup.mjs restart-server` — install-server 와 같은 검사(설정·자료 폴더 잠금)를 거쳐 **지금 저장소의 코드와 node.exe 를 사본으로 복사**해 다시 띄우고 45초 안에 떴는지 본다. `doctor` 의 "코드 사본" 줄이 "저장소와 다르다" 고 하면 이것을 잊었거나, 누가 저장소를 고친 것이다 — 무엇이 바뀌었는지 보고 나서 restart |
| 서버 로그 | `DATA_DIR\logs\server-날짜.log` (14일치). 서버가 아예 안 뜨면 `C:\ProgramData\WB\run-server-error.log`. 둘 다 관리자만 열린다 — 관리자 터미널에서 `notepad <경로>` |
| 터널 상태·로그 | 대시보드 Networking → Tunnels → `wb-admin` (Live logs). ⚠ "Healthy" 는 서버가 살아 있다는 뜻이 아니다 — `doctor` 로 본다 |
| 자료 백업 | `DATA_DIR` 을 **NAS** 로(원장 결정 — 클라우드 동기화 폴더는 쓰지 않는다). 방법은 아직 정하지 않았다(아래 남은 일) |
| cloudflared 업데이트 | **자동 갱신이 없다.** 분기마다 최신 MSI 를 다시 설치 → `net stop cloudflared` → `net start cloudflared` → `doctor` |
| 강사 추가·퇴사 | Access 정책의 Emails 목록을 고친다. 퇴사하면 Users 에서 Revoke + Remove(자리를 비운다) |
| 토큰이 샜다고 의심될 때 | 대시보드에서 터널 → Rotate token → (**이 키트로 깐 서비스일 때만**) `cloudflared service uninstall` → 새 명령을 3-4 처럼 토큰 파일로 `setup.mjs tunnel`. 기존 터널이 함께 돌던 PC 라면 uninstall 이 그 경로까지 끊으니 원장과 순서를 정한다 |
| 관리 웹 저장이 갑자기 안 될 때 | Access 세션(24시간)이 끝난 것일 수 있다 — 새로고침하면 다시 이메일 코드를 묻는다 |

## 6. 문제 해결 — `doctor` 메시지별

| 메시지 | 할 일 |
|---|---|
| 설정 파일이 없습니다 / 권한이 없습니다 | 1단계 `env` · 관리자 터미널에서 다시 |
| 이 서버가 쓰지 않는 키입니다 | 그 줄을 지운다(1단계 표의 키만) |
| 로컬 서버 응답 없음 | `DATA_DIR\logs` 의 오늘 로그 맨 아래, 없으면 `C:\ProgramData\WB\run-server-error.log` → 고친 뒤 `restart-server`. 로그에 "db.json 이 JSON 으로 읽히지 않습니다" 가 있으면 아래 그 줄을 따른다 |
| 작업 스케줄러: 꺼져 있습니다 | install/restart 가 도중에 실패해 작업을 꺼 둔 채 멈춘 것이다(그때 화면에 ⚠ 로 나온다) — 원인을 고친 뒤 `restart-server` |
| (서버 로그·`run-server-error.log` 에만 보인다 — doctor 에는 "로컬 서버 응답 없음") db.json 이 JSON 으로 읽히지 않습니다 | 실행기가 원본을 지키려고 서버를 띄우지 않은 것이다. ① `db.json` 을 지우거나 고치지 말고 그대로 둔다 ② `DATA_DIR\backups\db-날짜.json` 을 그 자리에 복사하지 **않는다** — 일일 스냅샷은 팩 본문·로그인 토큰·가족 링크·브레인레터·하루브레인·청크브레인 기록이 빠진 모양이라, 오류 없이 떠서 그대로 덮어쓴다 ③ NAS 백업이 정해지기 전(5절)에는 원장에게 알리고 멈춘다. NAS 백업이 생긴 뒤에는 그 `db.json` 으로 바꾸고 `restart-server` |
| 관리 전용: 학생 로그인이 401(403 이 아닌 값) | 누군가 `server.mjs` 를 직접 띄운 창이 있다 — 닫고 `restart-server` |
| 권한: … 관리자·SYSTEM 말고도 열 수 있습니다 | 설정 폴더면 `env`, 자료 폴더·코드 사본이면 `install-server` 를 다시. 그래도 남으면 그 폴더를 비우고 다시 |
| 코드 사본이 없습니다 / 저장소와 다릅니다 | `install-server`(처음) 또는 `restart-server`(업데이트 뒤) |
| 자료 드라이브: Network/Removable | `DATA_DIR` 을 이 PC 디스크(예: `C:\WB_server_data`)로 |
| LAN 차단 실패 | 누군가 `server.mjs` 를 직접 띄운 창이 있다(`WB_ADMIN_ONLY=1` 을 줬어도 HOST 없이 띄우면 모든 주소에 묶인다) — 닫고 `restart-server` |
| cloudflared 서비스 없음/멈춤 | (이 키트를 쓰기로 한 PC 에서만 — WB1 에서는 따르지 않는다) 3-4 다시, 또는 서비스 앱에서 Cloudflared 시작 |
| 터널 연결 실패(/ready 503) | 인터넷·방화벽 — 바깥으로 7844 포트(UDP·TCP)가 나가야 한다 |
| 호스트 이름이 DNS 에 없습니다 | 3-5 의 경로가 없거나 도메인이 아직 Active 가 아니다 |
| 터널이 연결되어 있지 않습니다(530/1033) | cloudflared 서비스가 꺼져 있다 |
| 서버가 응답하지 않습니다(502) | 경로의 Service URL 이 `http://127.0.0.1:8890` 인지, 서버가 떠 있는지 |
| 403 — Access 로그인 화면이 안 뜬다 | Access 응용(Path 비움)·로그인 방법(One-time PIN) 확인 |

## 7. 되돌리기

```bat
node reading-server\tunnel\setup.mjs uninstall-server
cloudflared service uninstall
```
첫 줄은 자동 시작과 코드 사본을 지운다(자료·설정 파일은 남는다). 둘째 줄은 터널 서비스와 토큰 파일을 지운다 —
**이 키트로 깐 서비스일 때만** 친다(서비스는 PC 당 하나라, 기존 터널이 돌던 PC 에서 치면 그 경로까지 끊긴다).
그다음 대시보드에서 경로(Route)·터널·Access 응용을 지운다. (1~7절의 명령은 PowerShell·명령 프롬프트 어느 쪽에서나 같다 —
3-4 의 `Remove-Item` 줄만 PowerShell 전용이다. 도구가 화면에 보여 주는 `> icacls …` 줄을 PowerShell 에 그대로 붙여 넣을 때는
`*S-1-5-32-544:(OI)(CI)F` 를 따옴표로 감싼다.)

## 8. 하지 말 것

- 퀵 터널(`cloudflared tunnel --url ...`)로 운영하지 않는다 — 재시작마다 주소가 바뀌고 잠글 수 없다.
- `server.mjs` 를 직접 띄워 터널에 붙이지 않는다 — 관리 전용·127.0.0.1 이 빠진다. 늘 실행기로.
- 학생·학부모에게 이 주소를 주지 않는다. 이 관리 웹에서 만든 가족 링크도 보내지 않는다.
- **같은 터널 토큰을 다른 PC 에 설치하지 않는다** — 같은 토큰을 깐 PC 는 그 터널의 "복제본"이 되어 바깥 요청이 두 PC 로
  나뉜다(한쪽에는 관리 서버가 없거나 자료가 다르다). 관리 서버·터널은 한 PC 에만. 금고 PC 가 생기면 그때 따로 설계한다.
- 설정 파일·터널 토큰을 저장소·채팅·스크린숏에 남기지 않는다. **터널 토큰을 터미널(PowerShell)에 붙여 넣지 않는다**(기록 파일에 남는다).
  `--loglevel debug` 로 돌리지 않는다(헤더째 기록된다).
- 코드 사본(`C:\ProgramData\WB\app`)을 손으로 고치지 않는다 — 다음 `restart-server` 가 저장소 코드로 덮어쓴다.
- 코드 사본 안에서 `setup.mjs` 를 돌리지 않는다(원본과 사본이 겹치면 시작하지 않는다 — 늘 저장소 폴더에서).

### 남는 위험 — 관리자 터미널은 저장소 코드를 관리자로 실행한다

`setup.mjs` 를 관리자 터미널에서 돌리는 순간 저장소의 그 파일이 관리자 권한으로 실행되고, `restart-server` 는 저장소의 지금
코드를 SYSTEM 사본으로 올린다. 사본·잠금은 "올린 뒤에 바꿔치기"를 막을 뿐, **올리기 전의 저장소**를 지켜 주지는 않는다.
그래서: ① 이 PC 를 다른 사람이 자기 계정으로 쓰지 않게 한다 ② 관리자 명령 전에 `git status` 가 깨끗한지·`git log` 가
기억나는 변경인지 본다 ③ `doctor` 의 "코드 사본" 줄이 경고하면 이유를 확인하기 전에는 restart 하지 않는다.
(저장소를 관리자만 쓰게 잠그는 방법도 있지만, 그러면 코덱스·원장이 평소 저장소를 고칠 때마다 관리자 권한이 필요해진다 — 채택하지 않았다.)
- 실제 도메인·팀 이름·이메일을 이 저장소 문서에 적지 않는다(공개 저장소다).

---

## 코덱스가 이어받을 때 (원장 PC 에서)

**지금 상태 (2026-10-15)** — 키트는 PR #447(미병합)에만 있고 **어느 PC 에도 설치하지 않았다.** 맨 위 「먼저 읽기」대로
WB1 에는 다른 체계가 이미 돌고 있어, 설치·이관은 원장 결정이 먼저다. 키트 코드·테스트는 들어갔다. Linux CI 에서 실행기·점검 로직·작업 정의 생성까지
돌려 봤지만 **Windows 실기에서는 아직 한 번도 돌려 보지 않았다.** 아래가 실기에서 처음 확인할 것들이다.

1. `schtasks /Create /XML … /RU SYSTEM` 이 UTF-16 작업 정의(한글 설명 포함)를 받는지 — 파일 인코딩 규칙은 공식 문서에 없다.
   실패하면 `kit.mjs taskXml` 의 Description 을 ASCII 로, 그래도 안 되면 PowerShell `Register-ScheduledTask -Xml (Get-Content …)` 로
2. 잠금(`icacls <폴더> /setowner *S-1-5-32-544 /T /C` → `icacls <폴더> /inheritance:r /grant:r *S-1-5-32-544:(OI)(CI)F /grant:r *S-1-5-18:(OI)(CI)F`
   → 안의 항목마다 `icacls <항목> /reset /T /C /Q`)이 통하는지, 그 뒤 권한 확인(PowerShell `Get-Acl`, 경로는 환경 변수 `WB_ACL_TARGET`
   — `kit.mjs ACL_SCRIPT`)이 `OWNER|S-1-5-32-544`·관리자·SYSTEM 만으로 읽히는지. 정션을 하나 만들어 두고(PowerShell: `New-Item -ItemType Junction -Path <링크> -Target <대상>`) `env` 가 거절하는지
3. SYSTEM 으로 뜬 실행기가 코드 사본(`C:\ProgramData\WB\app`, node 는 `app\node\node.exe`)에서 뜨는지, 5분 트리거가 죽은 서버를 살리는지(작업 스케줄러의
   '실패 시 다시 시작'은 프로그램이 오류 코드로 끝난 경우를 늘 잡지 않는다는 보고가 있어 5분 트리거를 같이 둔 것이다)
4. 작업 스케줄러에서 "끝내기" 하면 서버(자식)도 같이 꺼지는지(`exit-with-parent.mjs`) — `doctor` 의 로컬 서버가 ✗ 가 되면 정상
5. 관리자 판정(`whoami /groups` — `env`·`install-server` 가 쓰고 `doctor` 의 "관리자 권한" 줄에 보인다)·드라이브 종류
   (`[IO.DriveInfo]`)·`(Get-Service cloudflared).Status`·metrics `/ready`(127.0.0.1:20241~20245)가 실제로 읽히는지
6. 일반(관리자 아님) 터미널에서 `setup.mjs restart-server` 가 "관리자 권한 터미널에서 실행하세요" 로 멈추는지
7. `setup.mjs tunnel --dry-run` 이 이 PC 의 Cloudflared 서비스 유무를 맞게 말하는지(`detectCloudflaredService` — 테스트는 가짜 실행기로만 확인했다),
   `host-bind.test.mjs`·서버를 띄우는 테스트들이 Windows 방화벽 아래에서 통과하는지(허용 창이 뜨면 허용하지 말고 닫는다 — 원내 모드 LAN 연결 검사만 실패하면 그 사실을 적는다)

**코덱스가 하는 것 / 원장이 하는 것**

- 코덱스: `git pull` · `node scripts/check.mjs --only tunnel` · `setup.mjs` 의 `env`/`install-server`/`restart-server`/`doctor`
  실행과 결과 해석 · 실기에서 틀린 곳 고치기(+ 테스트) · 이 문서와 정본 문서 갱신.
- 원장: 설정 파일의 **비밀번호 입력**, Cloudflare **대시보드 클릭 전부**(Zero Trust·Access·터널·경로), 터널 토큰 다루기.
  코덱스는 비밀 값을 받거나 출력하지 않는다.

코덱스의 Windows 샌드박스는 명령을 관리자 권한 없이 돌린다 — `env`·`install-server`·`restart-server` 는 샌드박스 밖 실행을
승인하거나, 원장이 관리자 터미널에서 직접 친다. 터널 토큰과 비밀번호는 어느 쪽이든 코덱스에게 주지 않는다.

**첫 프롬프트 예시** (원장이 설치·이관을 정한 뒤에만)

> `reading-server/tunnel/README.md` 를 읽고 원장 PC 에서 1단계부터 진행해 줘. 관리자 터미널이야.
> 비밀번호는 내가 메모장에 직접 넣을게. 각 단계 뒤에 `setup.mjs doctor` 결과를 보여 주고,
> Windows 실기에서 처음 확인할 7가지를 확인한 결과를 README 에 적어 줘. 금고(A.5) 코드는 쓰지 마.

**남은 일(키트 밖)**

- `DATA_DIR` → NAS 백업 방법 정하기(robocopy 예약 작업 등) — 원장 결정(어느 NAS·몇 일치).
- 관리 웹의 `fetch` 가 Access 세션 만료 때 불투명한 302 를 받는 문제 — 관리 웹 API 요청에
  `X-Requested-With: XMLHttpRequest` 를 붙이면 401 로 바뀐다(Cloudflare 문서). 401 이면 새로고침 안내.
- (선택) 터널 경로의 "Protect with Access"(cloudflared 가 Access 토큰을 한 번 더 검사) — 원격 관리 터널에서
  설정 화면 위치가 공식 문서에 없다. 화면에서 찾으면 켜고 이 문서에 위치를 적는다.
- 로컬 서버의 관리 로그인에는 횟수 제한이 없다(운영 워커에만 있다). 지금은 Access 와 127.0.0.1 묶기가 앞을 막는다 —
  둘 중 하나가 빠지는 날을 대비해 `server.mjs` 에도 같은 제한을 둘지 정한다.
- `store.mjs` 는 종료 신호 때 300ms 지연 저장을 비우지 않는다 — 작업 끝내기·재부팅 직전 저장 한 번이 빠질 수 있다.

### WB1 을 이 키트로 옮길 때 (원장이 정한 경우에만)

옮길지·말지는 원장 결정이다. 옮기면 얻는 것: 로그인하지 않아도 뜨는 서버(SYSTEM), 관리자 전용 코드 사본, 날짜별 로그·14일 정리,
깨진 `db.json` 보호, `doctor`. 옮기기 전에 정할 것: 포트(기존 경로를 살리려면 8891), Access 범위(지금 원장 1명), 자료 이전 방식.

1. 원장 결정과 확인 — 기존 터널의 연결기가 Windows 서비스인지(`Get-Service cloudflared`), 예약 작업 정의(`Get-ScheduledTask -TaskPath '\WB 앱\'`)
2. 기존 예약 작업 `\WB 앱\WB 국어 관리자 서버` 를 **끄고** 서버가 내려갔는지 확인한다(되돌릴 때 다시 켠다)
3. `%LOCALAPPDATA%\WB\korean-admin-server\db.json` 을 새 `DATA_DIR`(예: `C:\WB_server_data`)로 **복사**한다 — 옮기지 않는다, 원본은 그대로
4. 원장이 `server.env` 에 비밀번호를 직접 넣는다 — 기존 `admin.credential.xml` 은 그 Windows 사용자에게 묶여 있어 SYSTEM 이 풀지 못한다.
   기존 경로를 그대로 쓰려면 `PORT=8891`
5. **병합된 main** 의 clone 에서 `setup.mjs env` → `install-server` (작업 브랜치 폴더에서 돌리면 미병합 코드가 SYSTEM 사본으로 올라간다)
6. 터널은 **새로 깔지 않는다** — 기존 터널을 그대로 두고, 포트를 바꿨다면 원장이 대시보드에서 그 경로의 Service URL 만 고친다
7. `setup.mjs doctor --host <기존 관리 호스트>` — "cloudflared 서비스 ✗" 는 연결기가 서비스가 아닐 때 예상된 결과다.
   연결기가 로그온 작업이면 "로그인하지 않아도 바깥에서 열린다" 는 여전히 성립하지 않는다(연결기도 옮겨야 한다 — 원장과)

