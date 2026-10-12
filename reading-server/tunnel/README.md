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
  서버에 필요한 폴더만 `C:\ProgramData\WB\app` 에 복사해 잠그고 그것을 돌린다. 저장소는 원장·코덱스가 평소처럼 고친다.
- **이 관리 웹은 운영 관리 웹이 아니다.** 자료는 이 PC 의 `DATA_DIR\db.json` 에만 있고(처음엔 비어 있다)
  운영 워커의 학생 기록과 섞이지 않는다. 원장 PC 에서 하는 일(팩 제작·검수, 자료 정리)에 쓴다.
  **학생 등록·진도 확인·가정 발송은 지금처럼 운영 주소의 `/admin` 에서** 한다. 여기서 만든 가족 링크·안내 링크는
  이 잠긴 주소를 가리키므로 **가정에 보내지 않는다**(가정에 나가는 링크는 사람 확인 사항 — 저장소 규칙 7).
- **금고(A.5, 국어 자료를 원장 PC 2대로)는 이 키트에 들어 있지 않다.** 원장 확인 4건이 끝나기 전에는
  코드를 쓰지 않기로 했다(정본 문서 §1.5 「남은 것」). 금고를 만들 때도 이 터널에 경로를 더하는 식이다.

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
3. **Node.js 22 이상**을 **설치 파일(MSI)로** 설치한다 — nodejs.org 의 LTS `.msi`, 또는
   `winget install --id OpenJS.NodeJS.LTS -e --installer-type wix --scope machine`.
   그래야 `C:\Program Files\nodejs\node.exe` 에 고정된다. winget 휴대용(zip)·nvm 은 버전마다 폴더가 바뀌어
   Node 를 올리는 순간 자동 시작이 조용히 깨진다(`install-server` 가 그런 자리를 보면 경고한다).
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
`tunnel` 은 cloudflared 버전을 확인하고(2026.7.3 미만이면 멈춘다), 토큰을 화면에 찍지 않고 서비스를 설치한 뒤
**토큰 파일을 지운다**. 이미 터미널에 붙여 넣었다면: `Remove-Item (Get-PSReadLineOption).HistorySavePath` 로 기록 파일을 지우고,
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
| 코드 업데이트 | `git pull` → (관리자 터미널) `node reading-server\tunnel\setup.mjs restart-server` — **지금 저장소의 코드를 사본으로 복사**해 다시 띄운다. 시험 중인 수정이 있으면 그것도 들어가니 커밋된 상태에서 한다. `doctor` 의 "코드 사본" 줄이 저장소와 다르다고 하면 이것을 잊은 것이다 |
| 서버 로그 | `DATA_DIR\logs\server-날짜.log` (14일치). 서버가 아예 안 뜨면 `C:\ProgramData\WB\run-server-error.log`. 둘 다 관리자만 열린다 — 관리자 터미널에서 `notepad <경로>` |
| 터널 상태·로그 | 대시보드 Networking → Tunnels → `wb-admin` (Live logs). ⚠ "Healthy" 는 서버가 살아 있다는 뜻이 아니다 — `doctor` 로 본다 |
| 자료 백업 | `DATA_DIR` 을 **NAS** 로(원장 결정 — 클라우드 동기화 폴더는 쓰지 않는다). 방법은 아직 정하지 않았다(아래 남은 일) |
| cloudflared 업데이트 | **자동 갱신이 없다.** 분기마다 최신 MSI 를 다시 설치 → `net stop cloudflared` → `net start cloudflared` → `doctor` |
| 강사 추가·퇴사 | Access 정책의 Emails 목록을 고친다. 퇴사하면 Users 에서 Revoke + Remove(자리를 비운다) |
| 토큰이 샜다고 의심될 때 | 대시보드에서 터널 → Rotate token → `cloudflared service uninstall` → 새 명령을 3-4 처럼 토큰 파일로 `setup.mjs tunnel` |
| 관리 웹 저장이 갑자기 안 될 때 | Access 세션(24시간)이 끝난 것일 수 있다 — 새로고침하면 다시 이메일 코드를 묻는다 |

## 6. 문제 해결 — `doctor` 메시지별

| 메시지 | 할 일 |
|---|---|
| 설정 파일이 없습니다 / 권한이 없습니다 | 1단계 `env` · 관리자 터미널에서 다시 |
| 이 서버가 쓰지 않는 키입니다 | 그 줄을 지운다(1단계 표의 키만) |
| 로컬 서버 응답 없음 | `DATA_DIR\logs` 의 오늘 로그 맨 아래, 없으면 `C:\ProgramData\WB\run-server-error.log` → 고친 뒤 `restart-server` |
| db.json 이 JSON 으로 읽히지 않습니다 | 서버가 원본을 지키려고 멈춘 것이다. NAS 백업의 `db.json` 으로 바꾼 뒤 `restart-server` |
| 관리 전용: 학생 로그인이 401(403 이 아닌 값) | 누군가 `server.mjs` 를 직접 띄운 창이 있다 — 닫고 `restart-server` |
| 권한: … 관리자·SYSTEM 말고도 열 수 있습니다 | 설정 폴더면 `env`, 자료 폴더·코드 사본이면 `install-server` 를 다시. 그래도 남으면 그 폴더를 비우고 다시 |
| 코드 사본이 없습니다 / 저장소와 다릅니다 | `install-server`(처음) 또는 `restart-server`(업데이트 뒤) |
| 자료 드라이브: Network/Removable | `DATA_DIR` 을 이 PC 디스크(예: `C:\WB_server_data`)로 |
| LAN 차단 실패 | 위와 같다(실행기 없이 띄운 서버는 모든 주소에 묶인다) |
| cloudflared 서비스 없음/멈춤 | 3-4 다시, 또는 서비스 앱에서 Cloudflared 시작 |
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
첫 줄은 자동 시작과 코드 사본을 지운다(자료·설정 파일은 남는다). 둘째 줄은 터널 서비스와 토큰 파일을 지운다.
그다음 대시보드에서 경로(Route)·터널·Access 응용을 지운다. (이 문서의 명령은 PowerShell·명령 프롬프트 어느 쪽에서나 같다.)

## 8. 하지 말 것

- 퀵 터널(`cloudflared tunnel --url ...`)로 운영하지 않는다 — 재시작마다 주소가 바뀌고 잠글 수 없다.
- `server.mjs` 를 직접 띄워 터널에 붙이지 않는다 — 관리 전용·127.0.0.1 이 빠진다. 늘 실행기로.
- 학생·학부모에게 이 주소를 주지 않는다. 이 관리 웹에서 만든 가족 링크도 보내지 않는다.
- **같은 터널 토큰을 다른 PC 에 설치하지 않는다** — 같은 토큰을 깐 PC 는 그 터널의 "복제본"이 되어 바깥 요청이 두 PC 로
  나뉜다(한쪽에는 관리 서버가 없거나 자료가 다르다). 관리 서버·터널은 한 PC 에만. 금고 PC 가 생기면 그때 따로 설계한다.
- 설정 파일·터널 토큰을 저장소·채팅·스크린숏에 남기지 않는다. **터널 토큰을 터미널(PowerShell)에 붙여 넣지 않는다**(기록 파일에 남는다).
  `--loglevel debug` 로 돌리지 않는다(헤더째 기록된다).
- 코드 사본(`C:\ProgramData\WB\app`)을 손으로 고치지 않는다 — 다음 `restart-server` 가 저장소 코드로 덮어쓴다.
- 실제 도메인·팀 이름·이메일을 이 저장소 문서에 적지 않는다(공개 저장소다).

---

## 코덱스가 이어받을 때 (원장 PC 에서)

**지금 상태 (2026-10-12)** — 키트 코드·테스트는 들어갔다. Linux CI 에서 실행기·점검 로직·작업 정의 생성까지
돌려 봤지만 **Windows 실기에서는 아직 한 번도 돌려 보지 않았다.** 아래가 실기에서 처음 확인할 것들이다.

1. `schtasks /Create /XML … /RU SYSTEM` 이 UTF-16 작업 정의(한글 설명 포함)를 받는지 — 파일 인코딩 규칙은 공식 문서에 없다.
   실패하면 `kit.mjs taskXml` 의 Description 을 ASCII 로, 그래도 안 되면 PowerShell `Register-ScheduledTask -Xml (Get-Content …)` 로
2. 잠금 두 줄(`icacls <폴더> /setowner *S-1-5-32-544 /T /C` → `icacls <폴더> /inheritance:r /grant:r *S-1-5-32-544:(OI)(CI)F /grant:r *S-1-5-18:(OI)(CI)F`)이
   통하는지, 그 뒤 권한 확인(PowerShell `Get-Acl` → `OWNER|…`·`ACE|…` 줄, `kit.mjs aclScript`)이 관리자·SYSTEM 만으로 읽히는지
3. SYSTEM 으로 뜬 실행기가 코드 사본(`C:\ProgramData\WB\app`)에서 뜨는지, 5분 트리거가 죽은 서버를 살리는지(작업 스케줄러의
   '실패 시 다시 시작'은 프로그램이 오류 코드로 끝난 경우를 늘 잡지 않는다는 보고가 있어 5분 트리거를 같이 둔 것이다)
4. 작업 스케줄러에서 "끝내기" 하면 서버(자식)도 같이 꺼지는지(`exit-with-parent.mjs`) — `doctor` 의 로컬 서버가 ✗ 가 되면 정상
5. 관리자 판정(`whoami /groups` — `env`·`install-server` 가 쓰고 `doctor` 의 "관리자 권한" 줄에 보인다)·드라이브 종류
   (`[IO.DriveInfo]`)·`(Get-Service cloudflared).Status`·metrics `/ready`(127.0.0.1:20241~20245)가 실제로 읽히는지
6. 일반(관리자 아님) 터미널에서 `setup.mjs restart-server` 가 "관리자 권한 터미널에서 실행하세요" 로 멈추는지

**코덱스가 하는 것 / 원장이 하는 것**

- 코덱스: `git pull` · `node scripts/check.mjs --only tunnel` · `setup.mjs` 의 `env`/`install-server`/`restart-server`/`doctor`
  실행과 결과 해석 · 실기에서 틀린 곳 고치기(+ 테스트) · 이 문서와 정본 문서 갱신.
- 원장: 설정 파일의 **비밀번호 입력**, Cloudflare **대시보드 클릭 전부**(Zero Trust·Access·터널·경로), 터널 토큰 다루기.
  코덱스는 비밀 값을 받거나 출력하지 않는다.

**첫 프롬프트 예시**

> `reading-server/tunnel/README.md` 를 읽고 원장 PC 에서 1단계부터 진행해 줘. 관리자 터미널이야.
> 비밀번호는 내가 메모장에 직접 넣을게. 각 단계 뒤에 `setup.mjs doctor` 결과를 보여 주고,
> Windows 실기에서 처음 확인할 6가지를 확인한 결과를 README 에 적어 줘. 금고(A.5) 코드는 쓰지 마.

**남은 일(키트 밖)**

- `DATA_DIR` → NAS 백업 방법 정하기(robocopy 예약 작업 등) — 원장 결정(어느 NAS·몇 일치).
- 관리 웹의 `fetch` 가 Access 세션 만료 때 불투명한 302 를 받는 문제 — 관리 웹 API 요청에
  `X-Requested-With: XMLHttpRequest` 를 붙이면 401 로 바뀐다(Cloudflare 문서). 401 이면 새로고침 안내.
- (선택) 터널 경로의 "Protect with Access"(cloudflared 가 Access 토큰을 한 번 더 검사) — 원격 관리 터널에서
  설정 화면 위치가 공식 문서에 없다. 화면에서 찾으면 켜고 이 문서에 위치를 적는다.
- 로컬 서버의 관리 로그인에는 횟수 제한이 없다(운영 워커에만 있다). 지금은 Access 와 127.0.0.1 묶기가 앞을 막는다 —
  둘 중 하나가 빠지는 날을 대비해 `server.mjs` 에도 같은 제한을 둘지 정한다.
- `store.mjs` 는 종료 신호 때 300ms 지연 저장을 비우지 않는다 — 작업 끝내기·재부팅 직전 저장 한 번이 빠질 수 있다.
