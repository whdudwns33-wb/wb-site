# WB 컨설팅 워크벤치 — 소스

원장 전용 컨설팅 관리 웹앱. 배포본은 비밀번호로 암호화되어 `/workbench/index.html` 로 서비스된다.
배포 주소: `https://whdudwns33-wb.github.io/wb-site/workbench/` (공개 URL — 비밀번호 로그인)

| 파일 | 역할 |
|---|---|
| `app.html` | **앱 원본 (공개, 개인정보 0).** 기능 수정은 전부 이 파일에서 (단일 HTML, 의존성 없음) |
| `wrapper-template.html` | 비밀번호 입력 화면 + WebCrypto 복호화 로직 |
| `build.mjs` | seed·bulk 주입 → AES-256-GCM 암호화 → `../index.html` 생성 + 복호화 자가검증 |
| `private-seed.json` | **gitignored.** 학생 시드 — `../backup/private-seed.enc.json` 에서 복원 |
| `bulk-data.json` | **gitignored.** 입결 5개년+전국고교 — `../backup/bulk-data.enc.json` 에서 복원 |
| `../index.html` | **배포본(자동 생성).** 직접 수정하지 말 것 |

## 새 기기에서 시작 (한 번만)

```bash
git clone https://github.com/whdudwns33-wb/wb-site && cd wb-site
git checkout claude/agent-performance-optimization-rj8ql6   # 워크벤치 소스는 이 브랜치
# workbench/backup/README.md 의 복원 명령 2개 실행 (비밀번호 필요)
```

## 수정 → 빌드 → 배포

```bash
# 1) workbench/src/app.html 수정
# 2) 빌드 (비밀번호는 원장에게 확인, 저장소·코드에 절대 적지 않는다)
WB_PASSWORD='<비밀번호>' node workbench/src/build.mjs   # "복호화 검증: 일치 ✓" 확인
# 3) 실명 검사 (공개 파일에 학생 실명 0건이어야 함 — 통과 못 하면 커밋 금지)
grep -c "한수빈\|박세윤\|조유빈\|강준서\|마윤서\|김아린\|강현서\|김태련\|고현준\|오수아\|남혁준\|윤시현" workbench/src/app.html  # → 0
# 4) 소스 커밋: 작업 브랜치에 app.html + index.html
git add workbench/src/app.html workbench/index.html && git commit && git push origin claude/agent-performance-optimization-rj8ql6
# 5) 배포: main에는 index.html 한 파일만 (Pages가 main을 서비스)
git worktree add /tmp/wt-main origin/main && cd /tmp/wt-main \
  && git checkout -b deploy-$(date +%s) origin/main \
  && cp <저장소>/workbench/index.html workbench/index.html \
  && git add workbench/index.html && git commit -m "workbench: ... 배포" && git push origin HEAD:main
# 6) 라이브 확인: 배포 후 1~2분 뒤
curl -sS https://whdudwns33-wb.github.io/wb-site/workbench/ | sha256sum   # 로컬 index.html 해시와 일치해야 함
```

`private-seed.json`을 수정했다면 `../backup/private-seed.enc.json`도 재생성해 커밋한다 (backup/README 참조 역방향).

## 설계 원칙

- **단일 HTML.** 프레임워크·외부 CDN 없음 (CSP·오프라인 안정성).
- **공개 소스에 개인정보 0.** 학생 데이터는 빌드 때 주입되어 암호문으로만 나간다.
  런타임 데이터 정본은 사용자 브라우저 `localStorage`(키 `wb-consulting-v1`).
- **비밀번호는 코드에 없다.** 빌드 시 환경변수로만. 비밀번호 변경 = 재빌드+재배포+백업 재암호화.
- 외부 서비스(Perplexity·Gamma·진학사·어디가)는 앱이 직접 호출하지 않는다 — 앱은 프롬프트를 조립만 한다.
- 입결 대량 데이터는 약관상 평문 재배포 금지 — 암호문 밖으로 꺼내지 않는다.

## 구조 (2026-09 현재)

- 전역: 대시보드 / 월간 캘린더 / 노하우 랩 / 진학 가능권 분석(상담 보드+등급 지형) / 모의지원 /
  고교 선택 시뮬레이터 / 입시 검색(대학 디렉터리+고교) / 학교 파트너십 / 어디가 데이터 / 노하우 라이브러리
- 학생별 8탭: 프로파일(성적기록·성장 궤적) · 학업 관리 · 생기부 · 수행평가 · 탐구보고서 · 상담 관리 · 진학사 통 · 월간 계획
- 데이터 계층: `SEED_PRIV`(학생 시드) / `BULK`(입결·고교 대량) / `ipGroups()`(대학|학과|전형 그룹 캐시, `save()`가 무효화)
