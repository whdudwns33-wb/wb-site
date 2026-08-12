# 삭제 대상 26개

claude.ai 스킬 설정에서 제거할 목록. 원본은 [`_archive/`](./_archive/)에 보관되어 있다.

## ⚠️ 삭제 전 필수 선행 작업

| # | 작업 | 이유 |
|---|---|---|
| 1 | n8n `WF-SUMMARYBUILD01`의 호출 대상을 `agent-consult`로 변경 | `agent-consultation-summary-builder`가 이 트리거를 직접 수신하도록 명시돼 있었다 |
| 2 | n8n에서 `control-tower`를 호출하는 트리거를 `agent-coo`로 변경 | 텔레그램 `_inbox/` 진입 경로가 컨트롤타워를 거쳤다 |

나머지 22개는 선행 작업 없이 바로 삭제 가능하다.

---

## A. 승계 완료 중복 21개

각 후계자가 자기 description에 "승계·통합"을 명시했으나 원본이 잔존한 것들.

### `agent-notify` 가 승계 (7개)

```
agent-calendar-notification-scanner
agent-center-notification-ledger-manager
agent-solapi-template-tracker
agent-center-delivery-result-ingestor
agent-kakao-channel-manager
agent-center-form-link-registry-manager
agent-fillout-response-ingest-manager
```

### `agent-booking` 가 승계 (4개)

```
new-booking
agent-center-booking-ledger-manager
agent-notion-booking-scanner
agent-center-calendar-hubspot-reconciliation-manager
```

### `agent-consult` 가 승계 (5개)

```
consult-input
agent-center-consultation-secretary
agent-consultation-summary-builder      ← 선행 작업 1 필요
agent-center-postcare-manager
agent-center-material-ledger-manager
```

### `agent-reward-voc` 가 승계 (3개)

```
agent-center-point-ledger-manager
agent-point-friendship-matcher
agent-center-voc-review-manager
```

### `agent-crm` 이 흡수 (2개)

```
agent-hubspot-update-classifier
agent-center-family-customer-ledger-manager
```

---

## B. 라우터 계층 통폐합 3개

`agent-coo` v4.0에 내용을 전부 흡수시킨 뒤 제거.

```
control-tower       ← 선행 작업 2 필요
agent-pmo
agent-ops
```

흡수 대응표는 [`README.md`](./README.md) §③ 참조.
`skills-modified/agent-coo/SKILL.md`가 통합본이다 — **이걸 먼저 반영한 뒤** 셋을 삭제할 것.

---

## C. HR 중복 1개

```
agent-hr-cho
```

`agent-hr`와 본문 0~12장이 바이트 단위로 동일한 복제였다.
`skills-modified/agent-hr/SKILL.md`가 통합본 — **이걸 먼저 반영한 뒤** 삭제할 것.

산하 `hr-recruiter`·`hr-onboarding`·`hr-retention`은 **삭제하지 않는다.**
내용이 서로 다른 실무 매뉴얼이고, 이미 상위를 `agent-hr`로 부르고 있어 수정도 필요 없다.

---

## D. 비서 1개

```
agent-secretary
```

Google Calendar·Gmail·Drive 권한과 아침·야간 브리핑, 직원 업무 라우팅을
`agent-google`의 **Step 0** 으로 이관했다.
`skills-modified/agent-google/SKILL.md`를 **먼저 반영한 뒤** 삭제할 것.

⚠️ 이 파일은 원본이 잘려 있었다(8,796바이트 이후 널바이트). 이관한 내용은 살아 있는 부분 전부다.

---

## 삭제 후 확인

이 26개를 참조하던 파일은 이미 후계자 이름으로 갱신해 `skills-modified/`에 담아두었다.
반영 후 새 세션에서 아래가 정상 동작하는지 확인한다.

- "예약 잡혔어" → `agent-booking` 단독 호출 (이전엔 `new-booking`과 경합)
- "상담 끝났어" → `agent-consult` 단독 호출
- "이거 처리해" → `agent-coo` 직행 (이전엔 `control-tower` 경유)
- "전체 프로젝트 현황" → `agent-coo` Step 0 (이전엔 `agent-pmo`)
- "강사 채용" → `agent-hr` 단독 호출 (이전엔 `agent-hr-cho`와 경합)
- "일정 잡아줘" → `agent-google` (이전엔 `agent-secretary`)
