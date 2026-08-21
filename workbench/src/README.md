# WB 컨설팅 워크벤치 — 소스

원장 전용 컨설팅 관리 웹앱. 배포본은 비밀번호로 암호화되어 `/workbench/index.html` 로 서비스된다.

| 파일 | 역할 |
|---|---|
| `app.html` | **앱 원본.** 기능 수정은 전부 이 파일에서 한다 (단일 HTML, 의존성 없음) |
| `wrapper-template.html` | 비밀번호 입력 화면 + 복호화 로직 |
| `build.mjs` | `app.html` 을 암호화해 `../index.html` 생성 |
| `../index.html` | **배포본(자동 생성).** 직접 수정하지 말 것 |

## 수정 → 배포

```bash
cd workbench/src
# 1) app.html 수정
node --check <(sed -n '/<script>/,/<\/script>/p' app.html)   # 선택: 문법 확인
# 2) 빌드 (비밀번호는 원장에게 확인, 저장소에 적지 않는다)
WB_PASSWORD='비밀번호' node build.mjs
# 3) 배포
git add ../index.html app.html && git commit -m "..." && git push origin main
```

GitHub Pages가 `main` 브랜치를 서비스하므로 push 후 1~2분이면 반영된다.
배포 주소: `https://whdudwns33-wb.github.io/wb-site/workbench/`

## 설계 원칙

- **단일 HTML.** 빌드 도구·프레임워크·외부 CDN을 쓰지 않는다 (CSP 및 오프라인 안정성).
- **학생 데이터는 저장소에 없다.** 전부 사용자 브라우저 `localStorage`(키 `wb-consulting-v1`)에만 저장된다.
  따라서 `app.html` 에는 실명·연락처 등 개인정보를 절대 넣지 않는다.
- **비밀번호는 코드에 없다.** 빌드 시 환경변수로만 주입한다. 비밀번호 변경 = 재빌드 후 재배포.
- 외부 서비스(Perplexity·Gamma·진학사·대학어디가)는 앱이 직접 호출하지 않는다.
  앱은 **프롬프트를 조립**하고, 실행은 Cowork(Claude) 쪽에서 한다.

## 구조

- 전역 화면: 대시보드 / 월간 캘린더 / 노하우 랩 / 어디가 데이터
- 학생별 8탭: 프로파일 · 학업 관리 · 생기부 · 수행평가 · 탐구보고서 · 상담 관리 · 진학사 통 · 월간 계획
