# 스킬 재설계 — 91 → 35 (2026-08-13)

> **2026-08-13 개정**: 당초 33개 안이었으나 `hr-playbook`(135KB) 병합본이 스킬 등록 API의
> 단일 호출 크기 한계를 넘어, HR만 원래 3종(`hr-recruiter`·`hr-onboarding`·`hr-retention`)으로
> 되돌렸다. 결과 **35개**. 목표(40 이하)는 충족하며 description 합계는 10,405자로 사실상 동일하다.
> 부수 효과로 HR 문서 내부 모순(시급표·채용채널)이 문서 분리로 자연 해소됐다.

1차 정리(118→91, 27개 삭제)에 이어, 살아있는 스킬 91개를 도메인별로 병합해 **35개**로 재설계했다.
병합 원칙: **본문 무손실** (흡수된 스킬의 표·절차·경로·금액은 절 단위로 그대로 이동, 요약·축약 없음).

## 결과 수치

| | 1차 정리 후 | 재설계 후 |
|---|---:|---:|
| 스킬 수 | 91 | **35** |
| description 합계 | 27,408자 | **10,405자** |
| 상시 로드 토큰 (근사) | ~18,300 | **~6,900** |
| YAML 오류 / 유령 참조 / 중복 name | 0 / 0 / 0 | 0 / 0 / 0 |

원본(118개) 대비 상시 로드 무게 **~77% 감소**.

## 최종 35개 구성

| 갈래 | 스킬 |
|---|---|
| 학원 6 | agent-academy, agent-academy-daily(신설), agent-student, agent-instructor, agent-curriculum, agent-studyforce-manager |
| 센터 7 | agent-booking, agent-consult, agent-consulting(불변), agent-center-daily, agent-notify, agent-crm, agent-voc |
| 경영 6 | agent-coo, agent-cto, agent-ceo, agent-cfo, agent-compliance, agent-research |
| 마케팅 4 | agent-marketing, agent-design, agent-editor, wb-flow-shortform |
| 인사 4 | agent-hr, hr-recruiter, hr-onboarding, hr-retention |
| 공통 4 | agent-google, session-start, skill-creator, mcp-builder |
| 기본 4 | docx, pdf, pptx, xlsx |

## 병합 매핑 (흡수됨 56종 → 대상)

| 대상 | 흡수한 스킬 |
|---|---|
| agent-academy | academy-ops-automation-manager, academy-form-manager |
| agent-academy-daily | academy-daily-ops-closeout, daily-teacher-workorder, teacher-task-controller, attendance-schedule-manager, classcard-manager |
| agent-student | student-data-manager, learning-manager, planner-manager, online-program-manager, retention |
| agent-instructor | teacher-data-manager |
| agent-curriculum | textbook, textbook-author, exam-author, wisc-activity-author, content-db |
| agent-booking | intake |
| agent-center-daily | daily-closeout-reporter, center-ops-automation-manager, report-manager, reporter, billing-service-manager |
| agent-notify | notification-manager, parent-communication-manager |
| agent-crm | hubspot, hubspot-data-manager, channel-attr, recheck, interpret, referral, sales |
| agent-voc | reward-voc, survey, review, cs, fillout-survey-manager |
| agent-cto | monitor, backup, cowork-agent-producer |
| agent-ceo | strategy, expansion |
| agent-cfo | accounting, bookkeeping, payroll, tax-liaison |
| agent-compliance | legal, center-privacy-guard |
| agent-research | analytics, competitor |
| agent-marketing | daangn-video-ad, email |
| agent-design | image-gen |
| agent-editor | qa |
| agent-google | briefing, morning |

(접두사 `agent-` 생략 표기. 전체 참조 재연결 51건 자동 수행, 잔존 유령 참조 0건 검증 완료.)

## 병합 중 확정·수정된 사항

- **센터 주소 통일**: agent-design의 브랜드 상수가 구주소(봉선로 149)였음 → 원장 확인을 받아
  전 문서 `광주 서구 월드컵4강로 52`로 통일. (HR 문서 등의 "봉선동"은 학원 상권 표기라 유지)
- **위기 라우팅**: agent-crisis 관련 행은 사용자 확정 지시로 전부 삭제 유지.
- **컨설팅 보존**: agent-consulting은 바이트 단위 불변. agent-coo의 컨설팅 라우팅 키 유지.

## 원문 충돌 3건 — 원장 확정 (2026-08-13) 반영 완료

1. **시급표**: 리텐션부 기준으로 통일 — 신입 18,000 / 3년차 22,000 / 5년차+ 25,000원 (+한자·한국사 5,000원 프리미엄).
   채용부 §2.2 표 교체, 공고 제목 예시·알바몬 표기·시강비(3.5~5만 원)·양식 예시까지 연동 수정.
2. **채용 채널 1순위**: 사람인. 채널 목록 6개로 확장(사람인 신설 §3.5 ⓪), 훈장마을 2순위로 강등, 이하 순위 재정렬.
3. **맘카페 계정**: agent-marketing의 실명 체계(순광맘·광수방·맘스팡)로 통일 — agent-editor 발행 캘린더의 계정 A/B/C 표기 교체.

## 적용 순서 (claude.ai에서)

1. **플러그인 먼저**: `wb-governance`, `wb-ops-extended` 비활성화
   (control-tower·coo·cto·pmo·monitor 구버전이 계속 중복 적재되는 원인. 이걸 안 끄면 재설계 효과 없음)
2. `wb-scan` / `wb-scanner` 중 하나 비활성화 (기능 중복)
3. 기존 스킬 삭제 — 실제 대상 72개 (계정 custom 94개 중, 이름이 같아 덮어쓰기되는 20개와 재등록되는 hr-onboarding·hr-retention 제외)
4. 재설계 35종 업로드 — 실제 등록 대상은 29개 (Anthropic 제공 6개는 재업로드 불필요)
5. 새 세션에서 스모크 테스트: "오늘 학원 마감" → agent-academy-daily / "상담 준비" → agent-consult /
   "강사 채용" → agent-hr → hr-recruiter / "카드뉴스" → agent-design / "브리핑" → agent-google

스킬 원본 파일은 개인정보(컨설팅 학생명 등) 포함으로 **저장소에 커밋하지 않고** 파일로 별도 전달했다.
