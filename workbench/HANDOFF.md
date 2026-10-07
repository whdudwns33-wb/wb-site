# 워크벤치 인수인계서 — Claude Code → Codex

> 기준일 **2026-10-07** · 라이브 **v39** · 작업 브랜치 `claude/agent-performance-optimization-rj8ql6`
> 이 문서는 **공개 저장소**에 있다. 비밀번호·학생 실명·Drive 파일 ID를 여기에 적지 말 것.
> 규칙의 정본은 루트 `AGENTS.md`, 빌드 절차의 정본은 `workbench/src/README.md`다. 이 문서는 그 둘을 읽기 전에 보는 지도다.

---

## 0. 30초 요약

**무엇** — WB 웩슬러브레인센터 원장 전용 고교 컨설팅 웹앱. 단일 HTML(`workbench/src/app.html`)을
비밀번호로 암호화해 GitHub Pages로 서비스한다. https://whdudwns33-wb.github.io/wb-site/workbench/

**지금 상태** — v39 라이브 (2026-10-07 · v37 수시 지원 현황 + v38 디자인 기본 체계 + v39 업무형 슬레이트 테마)
- `index.html` sha256 `c4cb32c389a98f6d…` · `bulk.enc.json` sha256 `b395f34892025adc…` · 빌드 태그 `56c35f7b`
- 학생 14명 · 입결 46,656행(어디가 5개년) · 학교 3,951곳 · 학교 성취도 내장 74개교(광주 중학교)

**바로 할 일**
1. **v40 — 학교 성취도 74 → 538개교** (데이터·변환기 준비 완료, 원본 CSV만 받으면 됨 → §5-1)
2. 수시 지원 현황 후속 — 원장 입력이 쌓이는 대로 다듬기 (→ §5-2)
3. 백로그 (→ §5-3)

**절대 하지 말 것**
1. `index.html`·`bulk.enc.json` 중 **하나만** main에 배포 — 전 기기에서 대량 데이터가 안 열린다 (§7)
2. 비공개 평문(`private-seed.json`·`bulk-data.json`)을 바꾸고 **재암호화 전에** 배포·종료 — 평문은 gitignored라 사라진다 (§7)
3. `build.mjs`의 "일치 ✓"를 비밀번호 검증으로 믿기 — 틀려도 뜬다. `check-password.mjs`만 진짜다
4. 학생 실명·비밀번호를 공개 파일·커밋 메시지에 쓰기 — 저장소는 public이다
5. 학교알리미 보안문자(캡차) 우회·자동 수집, 어디가 입결 평문 재배포

---

## 1. 시작하기 (첫 30분)

필요: Node 18+, Python 3.9+, (선택) Playwright. 비밀번호는 **원장에게 직접** 받는다 — 환경변수로만 쓴다.

```bash
git clone https://github.com/whdudwns33-wb/wb-site && cd wb-site
git checkout claude/agent-performance-optimization-rj8ql6        # ⚠ main 이 아니다
git pull origin claude/agent-performance-optimization-rj8ql6
export WB_PASSWORD='<원장에게 받은 비밀번호>'                       # 셸에만. 파일에 쓰지 말 것

node workbench/src/check-password.mjs     # "비밀번호 확인 ✓" 가 나와야 다음으로
# workbench/backup/README.md 의 복원 명령 2개 실행 → src/private-seed.json, src/bulk-data.json 생성
node workbench/src/check-names.mjs        # "실명 검사 ✓ — 0건"
node workbench/src/build.mjs              # index.html + bulk.enc.json 생성, "복호화 검증: 일치 ✓"

cd workbench && python3 -m http.server 8899   # http://localhost:8899/ 에서 로그인해 확인
```

로컬 빌드는 작업 트리의 `workbench/index.html`·`bulk.enc.json`을 바꾼다. 배포하지 않을 거면
`git checkout -- workbench/index.html workbench/bulk.enc.json`으로 되돌린다.

---

## 2. 저장소·배포 구조

| 브랜치 | 담는 것 |
|---|---|
| `claude/agent-performance-optimization-rj8ql6` | 워크벤치 **소스 전부** + 빌드 산출물 + 암호화 백업 |
| `main` | 워크벤치는 **`workbench/index.html` + `workbench/bulk.enc.json` 두 파일만**. 나머지는 다른 팀 앱(reading·haru·hanja·letter 등) |

- main의 루트 `AGENTS.md`는 **다른 팀 공용 문서**이고 워크벤치를 언급하지 않는다. 워크벤치 규칙은 작업 브랜치의 `AGENTS.md`에 있다.
- main에는 다른 팀 커밋이 자주 들어온다. 배포는 항상 **최신 `origin/main`에서 만든 worktree**로 두 파일만 바꿔 올린다.

```
private-seed.json (gitignored) ─┐
app.html ───────────────────────┼─ build.mjs ─→ index.html     (앱+학생 시드, AES-256-GCM)
bulk-data.json (gitignored) ────┘            └→ bulk.enc.json  (입결·학교·성취도, 같은 키·다른 IV, gzip)
                                  매 빌드마다 새 키 + BUILD_TAG → 두 파일은 반드시 짝으로 배포
```

- **런타임 데이터의 정본은 원장 브라우저의 `localStorage`**(키 `wb-consulting-v1`). 시드는 빈 기기를 채울 뿐, 이미 쓰던 기기에는 신규 항목만 더한다.
- 원장 입력을 저장소로 가져오는 길은 하나뿐: 앱의 "📤 백업 내보내기" → Drive `WB_워크벤치_백업` 폴더 → `seed-from-backup.mjs`. **이 폴더는 2026-09-02 이후 비어 있다** — 원장의 실제 상담 기록은 브라우저에만 있다.

---

## 3. 앱 코드 지도 (`workbench/src/app.html`, 약 3,800줄)

줄 번호는 계속 바뀐다. 구역은 `/* ═══════════ <이름>` 주석으로 grep 한다.

| 구역 | 주요 함수 |
|---|---|
| 저장·공통 | `load()` `save()`(캐시 무효화 포함) `stu()` `uid()` `esc()` `dday()` `ddayChip()` `toast()` |
| 사이드바·라우터 | `renderSide()` · `render()`(view.page 분기) · `go(page)` · `openStu(id)` |
| 대시보드 | `renderHome()` `focusList()` |
| 학생 화면 | `renderStu()` + 탭 함수: `tabOverview` `tabApply` `tabAcad` `tabSaenggibu` `tabTasks` `tabInquiry` `tabRecords` `tabAdm` `tabPlan` |
| 수시 지원 현황 (v37) | `aplList` `minCheck`(수능최저 판정) `aplConflicts`(일정 겹침) `tabApply` `aplCard` `renderApply`(전체 보드) `openApl` |
| 진학 가능권 분석 | `renderIpsi` · 판정 `classify`(수시, 등급) `classifyPct`(정시, 백분위) · 변환 `gradeToTopPct` `topPctToGrade` |
| 입결·학교 데이터 | `allIpRows()` `ipGroups()`(캐시) `allHsRows()` |
| 고교 선택 + 성취도 보정 | `renderHsSim` · `achFor` `achBulkIdx` `achDistFor` `achCorrect` `achEff` |
| 모의지원 · 입시 검색 · 파트너십 · 어디가 | `renderMock` `renderSearch` `renderPartner` `renderAdiga` |
| 프롬프트 조립 | `stuContext` `copyBriefing` (외부 AI는 직접 호출하지 않는다 — 프롬프트만 만든다) |
| 대량 데이터 지연 로딩 | `loadBulk()` · `BUILD_TAG` ↔ `bulk.enc.json`의 `t` 대조 |
| 빌드 주입 지점 | `/*BUILD:PRIVATE_SEED*/` `/*BUILD:BULK_DATA*/` `/*BUILD:TAG*/` — 문자열을 바꾸면 build.mjs 도 고쳐야 한다 |

**데이터 모델**
- `db = {students:[…], ipdb, hsdb, partners, trends, adiga, lessons, achdb, meta}`
- 학생: `name grade school career targetUniv lcsi narrative notes profileMd saenggibu tasks records planners grades inquiries exams subjectsMgmt univs tongLogs commLogs consult` + v37 `apply` `mockRef`
- `apply[]`: `{id, univ, major, track, kind(교과|종합|논술|실기|기타), free(6장 제외), status, wait, memo, ex:{date,time,kind}, res:{date}, min:{on, areas[국수영탐], n, sum, must, tam(1|2|2t), hist, note}}`
- `mockRef`: `{exam, 국, 수, 영, 탐1, 탐2, 한}` — 수능최저 판정의 기준 등급
- `BULK.ach = {s:[학교명], j:[과목], r:[[학교idx, 고교여부, 학년도-2000, 학년, 학기, 과목idx, 평균, A,B,C,D,E], …]}`

**코드 규칙** — 단일 HTML + 바닐라 JS, 외부 CDN·프레임워크 금지. 색은 CSS 토큰만(라이트 `:root` + 다크 2블록).
글자 크기는 `--fs-xs/sm/md/lg/xl` 5단계만(v38에서 16종을 정리했다 — 새 px 값을 만들지 말 것), 간격은 4px 격자 `--sp-1~6`.
제목에는 장식 이모지를 넣지 않는다(순서 표시 1️⃣·①은 허용). 학생 화면 머리 상태는 `.sig`(색 점), `.chip`은 목록 안 상태용.
강조색 배경 위 글자는 `var(--on-accent)` (다크에서 흰 글자는 대비 2:1이라 v37에서 고쳤다).
**테마(v39 업무형 슬레이트)** — 강조색 인디고(라이트 `#2E4FC7`·다크 `#7C9BFF`), 그림자 없이 선으로 구분(`--shadow:none`),
모서리 카드 8px·버튼 6px·칩 5px, 섹션 제목은 작은 회색 라벨. 사이드바는 라이트·다크 모두 어두운 판이라 그 안의 색은
`--side-*` 토큰만 쓴다(본문 토큰을 쓰면 다크 판 위에 어두운 글자가 된다). `--shadow`가 none이므로 `inset …, var(--shadow)`처럼
쉼표로 합치면 선언 전체가 무효가 된다 — 합치지 말 것. 로그인 화면(`src/wrapper-template.html`)도 같은 색을 따로 정의한다. 분석 결과 문구는 "예측"이 아니라 "상담용 참고치"로 쓴다.

---

## 4. 데이터 파이프라인

| 데이터 | 출처 | 재생성 |
|---|---|---|
| 입결 46,656행 | 대학어디가 5개년 재정리본 | Drive `WB_스킬교체_20260813`의 파서·레시피 (약관상 평문 공개 금지) |
| 학교 3,951곳 + 진학 실적 | 학교알리미 공개용 데이터 + 13-다 진로 현황(캡차 없음) | `workbench/src/schoolinfo/` — **매년 6/1** (README 참조) |
| 학교 성취도(4-나) | Drive `학교학업성취DB_v1.0.csv` (사람이 받아 둔 공시 원본 통합본) | `schoolinfo/build_ach.py` — 자동 수집 금지(캡차) |
| 학생 시드 | 원장 앱 백업 JSON | `seed-from-backup.mjs` |

---

## 5. 해야 할 일

### 5-1. v40 — 학교 성취도 538개교 (가장 먼저)

변환기와 검증 기준은 준비돼 있다. Claude 쪽에서는 Drive 도구가 10MB 넘는 파일을 못 받아 원장의 링크 공유가 필요했다.
**원장 컴퓨터에서 Codex가 작업하면 원장이 Drive에서 그냥 내려받으면 된다** — 공유 설정 불필요.

```bash
# 1) 원장이 Drive 에서 학교학업성취DB_v1.0.csv (19,117,704 바이트 · 123,489행) 을 내려받는다
python3 workbench/src/schoolinfo/build_ach.py ~/Downloads/학교학업성취DB_v1.0.csv /tmp/ach.json
#    기대 출력: 원본 123,488행 → 채택 38,841행 → 병합 36,454행 / 학교 538곳 (고 210 · 중 328)
# 2) bulk-data.json 의 "ach" 키만 통째로 교체
python3 -c "import json;p='workbench/src/bulk-data.json';d=json.load(open(p));d['ach']=json.load(open('/tmp/ach.json'));json.dump(d,open(p,'w'),ensure_ascii=False,separators=(',',':'))"
# 3) ★ 배포보다 먼저 백업 재암호화 + 커밋 (평문은 gitignored)
node workbench/src/backup-encrypt.mjs bulk && git add workbench/backup/bulk-data.enc.json && git commit -m "workbench: 성취도 538개교 백업"
# 4) 빌드 → 검증 → 배포 (§9)
```

**검증 기준** (2026-09-09 실측, 맞지 않으면 배포하지 말 것)
- 광주 중 74/74 · 광주 고 67/68 · 전남 중 255/255 · 전남 고 143/143
- **광주과학고 1곳 제외는 정상** — 1학년 행은 있지만 A~E 분포가 비어 있다(평균만 공시)
- 고교 행은 **1학년만**, 중학교는 1~3학년. 연도 2023·2024·2025 각 약 1.2만 행
- 회귀: 고실중학교 90행이 v36과 완전히 같아야 한다. 수학 A비율 수완하나중 39.4% · 신광중 15.2%, 올A 학생 중심 추정 각각 상위 5.2% · 2.1%
- 소규모 특성화고는 수학 A비율 0%인 곳이 있다 — 밴드가 넓어 자동으로 정성 표기로 넘어가면 정상
- 화면: 고교 카드 "📊 공시 성취도 … (1학년 공통 n과목)", 성취도 칸에 **고교명**을 넣으면 보정 안 됨(배지도 안 뜸)이 정상 — 보정은 중학교 성적용이다

### 5-2. 수시 지원 현황 (v37) 후속

원장이 고3 학생별로 기준 등급·지원 카드를 입력하기 시작하면 다듬는다. 판정 로직은 9개 사례로 검증돼 있다
(경계·여유·미충족·한국사 미달·탐구 2과목 평균·평균 절사·미입력·최저 없음). 다음 후보:
- **면접 예상 질문 프롬프트** — 생기부·세특 데이터로 학종 면접 대비 (10~11월 수요)
- **수능 가채점 입력 → 최저 재판정** — 11월 19일 수능 직후. 지금은 `mockRef` 하나라 "가채점"을 별도 슬롯으로 둘지 결정 필요
- **정시 가·나·다군 판단 화면** — 11월 말, `classifyPct` 재사용

### 5-3. 백로그

- 진학 가능권 입결 표: 숫자 열 왼쪽 정렬 → 오른쪽·`tabular-nums`
- 성취도 보정 모형오차 σ=0.45 — **실제 석차 30~50건이 쌓이기 전에는 낮추지 말 것**(밴드가 좁아 보일 뿐 정확해지지 않는다)
- 원장 몫(코드 아님): 관심대학 "(임시)" 확정, 상담 주기·LCSI 입력, **앱 백업 파일을 Drive에 올리기**

---

## 6. 자동 루틴 — 지금 Claude 쪽에서 돈다

| 시각 (KST) | 루틴 | 저장소에 쓰나 |
|---|---|---|
| 매일 07:50 | 워크벤치 Drive 백업 자동 반영 — 새 백업이 있을 때만 시드 갱신·재빌드·**main 배포** | 예 |
| 매일 08:00 | 수행평가 초안 (Notion → Drive 학생 폴더) | 아니오 |
| 매년 6/1 오전 | 진학 실적 재수집 (`schoolinfo/`) | 예 |

- **07:50~08:15 KST에는 워크벤치 소스를 건드리지 말 것.** 배포(main 푸시)는 한 번에 한 주체만 한다.
- 07:50 루틴은 비밀번호가 담긴 Claude 세션에 묶여 있다. Codex가 배포를 전담하게 되면 원장이 claude.ai 루틴 설정에서
  이 루틴을 끄거나, 시간을 합의해야 한다 — 두 주체가 같은 날 배포하면 짝 불일치가 날 수 있다.

---

## 7. 사고 기록 — 같은 실수를 하지 않기 위해

| 날짜 | 무슨 일 | 원인 | 지금의 방지책 |
|---|---|---|---|
| 2026-09-02 | v29: 전 기기에서 고교 34곳·대학 8곳만 보임 | `index.html`만 main에 배포 → 키 불일치로 bulk 복호화 실패 | 두 파일 짝 배포 · `BUILD_TAG` 대조(앱이 경고) · `?v=TAG` 캐시버스팅 · 라이브 해시 **2개** 대조 |
| 2026-09-16 | 538개교 성취도 데이터 통째로 소실 | 평문만 만들고 배포가 밀린 사이 컨테이너 초기화 | `backup-encrypt.mjs` — 평문을 바꾸면 **배포보다 먼저** 재암호화 커밋 |
| 2026-09 | 비밀번호 검증 착시 | `build.mjs`는 넘긴 값으로 암호화하고 같은 값으로 되읽음 | `check-password.mjs`가 기존 백업을 실제로 복호화 |
| 2026-09-04 | 아티팩트 발행 거부 | 소스에 리터럴 U+FFFD | 정규식에서 `�` 이스케이프로만 쓴다 |
| 2026-10-06 | 공개 문서에 학생 실명 12명 노출 + 2명 검사 누락 | 실명 검사 명령에 이름 목록을 직접 적음 | `check-names.mjs`가 비공개 시드에서 이름을 읽음 · **과거 커밋 기록에는 남아 있음** |
| 2026-10-07 | 학생 공유 플래너 페이지의 글자 크기가 무시됨(v38에서 생김 · v39에서 수정) | v38 일괄 치환이 독립 HTML 문자열(`genSharePage`) 안의 px까지 `var(--fs-*)`로 바꿈 — 그 문서엔 토큰이 없다 | 공유 페이지 `<style>`에 토큰 정의 · 일괄 치환 때 독립 문서 문자열은 제외 |

---

## 8. 도메인 지식·함정

- **학교알리미 4-나(교과별 학업성취)는 학교마다 보안문자** — 자동 수집하지 않는다. 사람이 조회해 붙여넣거나 원장이 받아 둔 원본을 쓴다.
- 학교알리미가 주는 `.xls`는 **실제로 HTML 표**다 — pandas·openpyxl로 안 열린다.
- 공시 회차: N년 4월 **1차** = (N−1)학년도 1·2학기 / N년 9월 **3차** = N학년도 1학기만. 통합 CSV는 이미 학년도로 정리돼 있다.
- **고교 성취도는 1학년 공통과목만 쓴다.** 2·3학년 선택과목은 수강 집단이 갈려 학교 분포로 못 쓴다. `과제·연구·실험` 붙은 과목(과학탐구실험 등)도 제외.
- 성취도 보정 게이트: 과목 4개 미만 → 숫자 없음, 대체값 비중 30% 초과 → 분포 약함, 밴드 45%p 초과 → 정성 표기만. 밴드가 넓을 때 고정표로 되돌리지 않는다.
- 어디가 입결: 수치 인용 + "출처: 한국대학교육협의회 어디가"는 가능, 화면·PDF 통째 복제·대량 크롤링·평문 재배포는 금지.
- 수능최저: 탐구 반영(상위 1과목/2과목 평균/평균 절사)·영어·한국사 조건이 대학마다 다르다. 판정은 참고치로 표기한다.
- 수시 6장에 들지 않는 대학: 과학기술원(KAIST·GIST·DGIST·UNIST 등)·사관학교·경찰대·산업대·전문대 → 카드의 "6장 제외".
- 수능일은 `db.meta.suneung`(2026-11-19). 대시보드에서 바꿀 수 있다.

---

## 9. 배포 전 체크리스트

```
[ ] node workbench/src/check-password.mjs            → ✓
[ ] node workbench/src/check-names.mjs               → ✓ 0건
[ ] (평문을 바꿨다면) node workbench/src/backup-encrypt.mjs → 커밋까지
[ ] node workbench/src/build.mjs                     → 복호화 검증 일치 ✓
[ ] 브라우저: 로그인 → 학생 14명 → 바꾼 화면 동작 → 콘솔 오류 0 → 다크모드 한 번
[ ] 작업 브랜치에 app.html + index.html + bulk.enc.json 커밋·푸시
[ ] 최신 origin/main worktree 에 두 파일만 복사 → 커밋 → main 푸시
[ ] 1~2분 뒤 라이브 해시 2개 대조 (index · bulk?v=<태그>) — 둘 다 일치할 때까지 다른 주체 배포 금지
```

---

## 10. Claude 쪽에만 있는 것 (Codex가 직접 못 건드림)

- claude.ai 비공개 아티팩트: 워크벤치 데이터 내장 사본(**v36 기준이라 낡음** — 수시 지원 탭 없음), 고교 선택 패키지, 학업성취 취득 경로 검토, 성취도 분포 입력 안내서(**내장 데이터 반영 갱신 필요**)
- §6의 자동 루틴들
- 필요하면 원장이 Claude 세션에 요청하면 된다.

---

## 11. Codex 첫 프롬프트 예시

```
wb-site 저장소의 워크벤치 작업을 이어받는다.
1) 브랜치 claude/agent-performance-optimization-rj8ql6 를 체크아웃하고 pull 해.
2) workbench/HANDOFF.md → AGENTS.md → workbench/src/README.md 순서로 읽어.
3) 비밀번호는 내가 셸에 WB_PASSWORD 로 넣어 줄게 — 파일·커밋에 절대 쓰지 마.
4) §1 대로 복원·빌드하고 로컬에서 로그인까지 확인한 뒤, 오늘 할 일(§5)부터 제안해.
지금이 07:50~08:15 KST 면 시작하지 말고 알려 줘.
```
