# 학교알리미 진학 실적 수집 (연 1회 재실행)

`bulk-data.json`의 고교 행 7번째 필드 `[졸업자, 진학계, 4년제, 재적, 연간전출]`을 만든다.
출처: 학교알리미 공개용데이터(`/openData.do`, 페이지 내장 키) + 학교별 공시 "졸업생의 진로 현황"(13-다, 캡차 없음).
교과별 학업성취 사항(4-나)은 캡차로 보호되어 자동 수집하지 않는다 — 대량 취득은 EDSS 신청 경로만.

```bash
cd workbench/src/schoolinfo
mkdir -p si/data && curl -sS -c si/cookies.txt https://www.schoolinfo.go.kr/ng/go/pnnggo_a01_l2.do -o /dev/null
python3 collect_lists.py     # 16개 교육청 × (학교기본정보 + 전출입) → si/data/hs_basic.json, hs_drop.json
python3 crawl_jinro.py       # 학교별 진로 현황 ~2,450건, 재개 가능(si/data/jinro.jsonl) — 20분 내외
python3 merge_metrics2.py    # 학교명+시도(교육청 코드) 매칭 → ../bulk-data.json 갱신
# 이후 build.mjs 재빌드 → 두 파일 배포 → backup/bulk-data.enc.json 재암호화(backup/README)
```

공시 갱신 시기: 진로 현황은 매년 5월 말(전년 2월 졸업생), 재적·전출은 4월 말. 교육청 코드표는 `collect_lists.py`의 OFFICES
(2026년 행정통합 반영: 05=전남광주통합, 14=전북). 해석 주의: 공시 "기타"에 재수 준비가 포함되어 정시 강세 학교는 진학률이 낮게 보인다.

## 학업성취 분포(4-나) 데이터셋

앱의 `BULK.ach`(학교별 A~E 분포)는 **자동 수집하지 않는다** — 학교알리미 4-나는 학교마다 보안문자가 걸려 있어
사람이 직접 받은 자료만 쓴다. 원장 Drive의 통합본을 변환해 넣는다.

```bash
# 원본: Drive `학교학업성취DB_v1.0.csv` (전남·광주 592개교 대장 기준, 123,489행)
#   열: school_key,school_name,region,district,school_level,academic_year,grade,semester,track,
#       subject,avg_score,rate_A..rate_E
python3 build_ach.py <내려받은.csv> ach.json
# → bulk-data.json 의 "ach" 키를 통째로 교체 → build.mjs 재빌드 → 두 파일 배포
```

채택 규칙 (build_ach.py):
- **중학교는 전 학년**, **고등학교는 1학년만** — 2·3학년 선택과목은 수강 집단이 이미 갈려 학교 전체 분포로 못 쓴다.
- 국·영·수·사·과·역사·도덕만. `과제`·`연구`·`실험`이 붙은 과목(과학탐구실험, 수학과제탐구, 사회과제연구)은 뺀다.
- A~E가 모두 있고 합이 100±3인 행만. 계열이 여럿이면 평균낸다.
- 결과: 538개교 36,454행 (고 210 · 중 328). 광주과학고는 1학년 분포를 공시하지 않아 빠진다(평균만 공시).

Drive 통합본은 10MB 초과라 MCP 도구로 못 받는다. 원장이 잠시 "링크가 있는 모든 사용자(뷰어)"로 바꿔 주면
`https://drive.usercontent.google.com/download?id=<fileId>&export=download&confirm=t` 로 받고 즉시 되돌린다.
