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
