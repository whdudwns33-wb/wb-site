# WB 진로독서 백엔드 + 관리 웹

학생 기록 서버 동기화와 강사용 현황판. Node 22 내장 모듈만 사용(무의존성).

## 실행

```bash
ADMIN_PIN=원하는PIN node reading-server/server.mjs   # 기본 포트 8890
```

| 경로 | 내용 |
|------|------|
| `/` | 학생 앱 (reading/ 폴더를 그대로 서빙 — 같은 주소라 연동이 자동 활성화) |
| `/admin` | 강사 관리 웹 (PIN 로그인) |
| `/review.html` | 지문 검수 뷰어 |
| `/api/health` | 상태 확인 |

## 동작 방식

- **학생**: 앱 설정 → "선생님 연동"에 학생 코드 입력 → 이후 모든 기록(완독·문제·훈련·보고서)이 저장 시 2.5초 디바운스로 서버에 자동 백업. 새 기기에서 같은 코드로 연동하면 기록 복원(활동량 많은 쪽 채택). 강사의 레벨 조정은 다음 동기화 때 반영.
- **강사**: `/admin` → 학생 등록(코드 발급) → 현황판(오늘 미수행 상단 정렬, 스트릭·정답률·보고서·붉은책), 레벨 조정.

## API 요약

- `POST /api/login {code}` → `{token, student}` (학생)
- `GET /api/pull` → `{state, level, name}` / `PUT /api/state {state}` (Bearer)
- `POST /api/admin/login {pin}` → `{token}` / `GET /api/admin/overview` / `POST /api/admin/students` / `POST /api/admin/level {code,level}` / `GET /api/admin/student/:code`

## 저장소

`reading-server/data/db.json` 파일 하나(자동 생성, git 미추적). 백업 = 이 파일 복사.
프로덕션 이관 지점: `store.mjs`만 Cloudflare KV/D1 또는 PostgreSQL로 교체.

## 배포 옵션

1. **원내 PC/NAS (권장 시작점)**: 학원 컴퓨터에서 위 명령 실행 → 원내 태블릿은 `http://<PC IP>:8890` 접속. 외부(가정) 접속까지 열려면 공유기 포트포워딩+DDNS 또는 Cloudflare Tunnel.
2. **Cloudflare Workers (운영 중)**: **https://wb-reading.whdudwns33.workers.dev** — 학생 앱(/) + 관리 웹(/admin) + API. `worker.mjs`+KV(DB)로 배포됨.
   재배포(지문·앱 업데이트 반영): `node build-dist.mjs && CLOUDFLARE_API_TOKEN=... npx wrangler deploy` (reading-server/ 에서)

⚠ 운영 전 필수: `ADMIN_PIN` 변경, HTTPS(터널/워커) 뒤에서만 외부 노출.
