# 솔라피 알림톡 + Fillout CS 설문 운영안

기준일: 2026-08-05

## 발송 원칙

- 업무지시서와 수행보고는 솔라피 카카오 알림톡(ATA)을 기본 채널로 사용한다.
- 모든 요청에 `disableSms: true`를 적용하여 SMS/LMS 자동 대체를 금지한다.
- 승인된 템플릿만 원장 승인 후 발송한다.
- 전화번호·이름·상담 내용은 URL에 넣지 않는다.

## 알림톡 템플릿 3종

### WB_DIRECTOR_DAILY_REPORT_V1

```text
[WB 오늘 수행 보고]
담당: #{staff_name}
#{report_date} 기준
전체 #{total_count}건
완료 #{done_count}건
진행 #{doing_count}건
미완료 #{todo_count}건
막힘 #{blocked_count}건
수행률 #{completion_rate}
상세 내용은 업무지시서에서 확인해 주세요.
```

### WB_STUDENT_CS_SURVEY_V1

```text
[WB 학습 만족도 확인]
#{survey_period} 동안 수업은 어땠나요?
아래 버튼을 눌러 #{due_date}까지 응답해 주세요.
```

버튼: 설문 참여하기 / URL 변수: `#{survey_url}`

### WB_PARENT_CS_SURVEY_V1

```text
[WB 월간 학습 의견 확인]
이번 달 자녀의 수업과 학습 변화에 대한 의견을 부탁드립니다.
보내주신 의견은 다음 달 지도 계획에 반영하겠습니다.
아래 버튼을 눌러 #{due_date}까지 응답해 주세요.
```

버튼: 보호자 설문 참여 / URL 변수: `#{survey_url}`

## Fillout 폼

### 학생 2주 설문

- form_key: `academy_student_cs_biweekly`
- 문항: 만족도, 난이도, 설명 이해도, 숙제량, 온라인 프로그램 어려움, 도움 된 점, 다음 2주 요청
- 초등 저학년은 5문항 이내로 줄이고 필요 시 보호자와 함께 응답한다.

### 보호자 월간 설문

- form_key: `academy_parent_cs_monthly`
- 문항: 만족도, 학습 변화, 숙제 상태, 소통 만족도, 걱정/요청, 다음 달 중점 지도, 추가 상담 희망

## URL 파라미터

허용: `survey_type`, `journey_stage`, `form_key`, `student_code`, `cycle_id`, `source`, `resource_key`

금지: 이름, 전화번호, 학교명, 상담 내용, 검사 결과.

응답 매핑은 `submission.urlParameters.student_code`를 우선한다.

## 자동화 흐름

1. 학생은 마지막 발송 후 14일, 보호자는 마지막 발송 후 30일이 지나면 후보로 생성한다.
2. 재원 상태·수신 동의·연락처·중복 여부를 검사한다.
3. 원장 화면의 `approval_waiting` 후보만 사람이 승인한다.
4. 승인 건만 알림톡으로 발송한다.
5. 결과는 `accepted/rejected/unknown`으로 기록하며 `unknown`은 자동 재발송하지 않는다.
6. Fillout 웹훅은 submission id로 중복 제거한다.
7. 응답은 원장에 바로 확정하지 않고 `needs_review` 요약 후보로 만든다.
8. 미응답 알림은 1회만 보내고 이후 상담 후보로 넘긴다.

권장 시간은 학생 평일 18:30~20:00, 보호자 평일 19:00 전후다.

## 배포 전 게이트

- 세 템플릿 승인 및 ID 등록
- Fillout 폼 2종 공개 URL 확인
- 테스트 student_code 왕복 검증
- 웹훅 중복방지 검증
- 내부 테스트 1건 승인 발송
- 실제 대상자 일괄 발송은 별도 승인
