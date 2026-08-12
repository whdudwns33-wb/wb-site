# 유령 참조 분류 — 존재하지 않는 스킬을 가리키는 참조

정리 후 92개 스킬을 전수 스캔한 결과다.

> **앞선 보고 정정** — README에 "60종 156회"라고 적었으나, 그 수치에는
> 의도적으로 남긴 승계 이력(후계자 문서 안의 폐지 스킬 언급), 경로 플레이스홀더(`[agent-name]`),
> 파일명(`hr-retention-changelog.md`)이 섞여 있었다.
> **실제 유령 참조는 27종 100회다.**

## 요약

| 갈래 | 종 | 회 | 상태 |
|---|---:|---:|---|
| **A. 만들어야 할 것** — 실무는 도는데 스킬만 없음 | 5 | 34 | 원장님 판단 필요 |
| **B-1. 이름만 교정** — 기능 동일한 실존 스킬 있음 | 7 | 21 | ✅ **적용 완료** |
| **B-2. 통합 대상** — 실존 스킬로 흡수 가능하나 판단 필요 | 5 | 19 | 원장님 판단 필요 |
| **C. 지울 것** — 계획만 있고 실체 없음 | 8 | 22 | 원장님 확인 후 삭제 |
| **D. 안전 경로** — 위임 대상 부재 | 1 | 2 | ✅ **처리 완료** |

---

## D. 안전 경로 — `agent-crisis` ✅ 처리 완료

`agent-coo` 라우팅표 2곳이 위기·자해·신고를 `agent-crisis`로 넘기고 있었으나 그 스킬은 없었다.
지시대로 참조를 제거했다. **다만 "받을 곳 없음" 상태로 두지 않고 명시적 처리로 바꿨다:**

| 위치 | 이전 | 이후 |
|---|---|---|
| 라우팅표 | `"위기","긴급","큰일","신고" → agent-crisis 즉시` | `COO가 직접 접수 → 영준님 즉시 보고 (자동 처리 금지)` |
| 도메인 매핑 | `위기·자해·신고 → agent-crisis (직진입 권장)` | `위임하지 않음 — COO 접수 후 영준님 즉시 보고` |

그냥 행을 지우면 위기 발화가 "그 외 모든 발화 → COO가 처리"로 떨어져 **일반 업무와 같은 취급**을 받는다.
그건 지우는 것보다 나쁘다고 판단해 한 줄을 남겼다. 이 문구도 빼길 원하시면 말씀해 주시면 제거하겠다.

---

## A. 만들어야 할 것 — 실무는 도는데 스킬만 없음 (5종 34회)

이 경로들은 **지우면 업무 흐름이 끊긴다.** 실제로 도는 일에 대한 위임처인데 받을 스킬이 없는 상태다.

### A-1. 채널 발행 4종 (21회)

```
agent-channel-blog    6회   ← agent-design, agent-email, agent-qa, hr-recruiter
agent-channel-cafe    7회   ← agent-design, agent-email, agent-qa, hr-recruiter
agent-channel-insta   6회   ← agent-design, agent-email, agent-image-gen, agent-qa, hr-recruiter
agent-channel-karrot  2회   ← agent-qa
```

**끊긴 흐름:**
- `agent-qa`가 "발행 준비 완료 선언 시" 검수하는 대상이 **전부 이 4종** — 즉 QA 게이트가 받을 입력이 없다
- `agent-design`·`agent-image-gen`이 이미지 완성 후 "캡션·해시태그 의뢰"로 넘기는 다음 단계
- `agent-email`이 블로그 SEO·SNS 콘텐츠를 위임하는 곳
- `hr-recruiter`가 채용 공고를 맘카페·SNS에 게시할 때

**부분 대안** — `daangn-video-ad`(당근 동영상 광고)가 karrot을 일부 커버한다.
`agent-marketing`이 상위에 있으나 채널별 발행 실무는 없다.

**선택지:** (a) 4종 신규 생성 / (b) `agent-marketing`에 채널별 섹션으로 통합 / (c) 발행은 수동이므로 참조 삭제

### A-2. `agent-design-canva` (13회)

```← agent-cto, agent-design, agent-image-gen, hr-recruiter```

`agent-design`이 **인스타 카드뉴스·시크릿노트 표지·기존 Canva 디자인 수정**을 명시적으로 이쪽에 라우팅한다.
`agent-image-gen`도 "복잡한 레이아웃은 agent-design-canva"라고 자기 금지사항에 적어뒀다.
**Canva MCP는 실제로 연결돼 있다**(6개 스킬이 참조).

**선택지:** (a) 생성 / (b) `agent-design`이 Canva MCP를 직접 다루도록 흡수 / (c) 수동 작업이면 삭제

---

## B-1. 이름만 교정 — ✅ 적용 완료 (7종 21회)

기능이 같은 실존 스킬이 있는데 이름을 잘못 부르고 있던 것들. 판단이 필요 없어 바로 고쳤다.

| 유령 | → 실존 스킬 | 회 | 근거 |
|---|---|---:|---|
| `agent-cs-center` | `agent-cs` | 5 | agent-cs가 "센터 + 학원" CS 모두 담당한다고 명시 |
| `agent-cs-academy` | `agent-cs` | 3 | 〃 |
| `agent-docs-manager` | `agent-google` | 6 | Drive 배포 담당 = 이제 agent-google Step 0 |
| `agent-center-ops` | `agent-center-ops-automation-manager` | 3 | 정식 명칭 |
| `agent-academy-ops` | `agent-academy-ops-automation-manager` | 2 | 정식 명칭 |
| `agent-center-consult` | `agent-consult` | 1 | 정식 명칭 |
| `agent-program-manager` | `agent-online-program-manager` | 1 | 정식 명칭 |

추가로 별도 오탈자 4건도 함께 고쳤다:
`agent-studyforce`→`agent-studyforce-manager`, `agent-docx`→`docx`,
`hr-recruiting`→`hr-recruiter`, `agent-academy-student`→`agent-student`.

**가장 심각했던 건 `agent-voc`** — 위임 대상 14건이 전부 유령이었다. 지금은 실존 스킬을 가리킨다.

---

## B-2. 통합 대상 — 판단 필요 (5종 19회)

흡수할 실존 스킬이 있으나 **어느 쪽으로 보낼지가 운영 판단**이다.

### B-2-1. n8n 4종 (13회)

```
agent-n8n-flow       5회  ← agent-cto, agent-make
agent-n8n            4회  ← agent-cto, agent-make
agent-n8n-installer  3회  ← agent-cto, agent-make
agent-n8n-monitor    1회  ← agent-cto
```

`agent-make`(Make 자동화 전담)가 **"🔴 등급 데이터가 필요한 자동화 → agent-n8n-flow로 이관"**,
**"n8n 설치 → agent-n8n-installer"** 라고 명시적으로 넘긴다.
agent-make description에 "Make × n8n 병행 실험(4주)"이라 적혀 있는데, **n8n 쪽 담당자가 없다.**

**선택지:** (a) `agent-n8n` 하나로 생성(4종 통합) / (b) `agent-make`를 `agent-automation`으로 확장해 양쪽 담당 / (c) n8n 실험 종료면 참조 삭제

### B-2-2. `agent-idea` (6회)

```← agent-voc```

`agent-voc`가 **"같은 니즈 5회 이상 반복 → 신사업 시드로 agent-idea에 이관"** 하는 구조.
`agent-coo` 라우팅표에 `"아이디어:", "메모:", "할 일:" → capture(_inbox/)`가 이미 있다.

**선택지:** (a) `agent-coo`의 `_inbox/` 캡처로 대체 / (b) `agent-strategy`로 보냄(agent-voc가 이미 병기) / (c) 생성

---

## C. 지울 것 — 계획만 있고 실체 없음 (8종 22회)

대부분 **`agent-cto`의 "에이전트 팀 맵 (2026-04-26 기준)"** 에만 등장한다.
만들 계획을 적어뒀다가 실제로 만들지 않은 것들로 보인다.

| 유령 | 회 | 등장 위치 | 대체 |
|---|---:|---|---|
| `agent-scanner` | 6 | agent-cto 스캔 파이프라인 | 스캔 감지는 `agent-google` Step 0-5에 있음 |
| `agent-scan` | 5 | 〃 | 〃 |
| `agent-mcp-ops` | 4 | agent-cto MCP 연결 전략 | **agent-cto 자신이 담당**이라고 description에 명시 |
| `agent-skill-ops` | 3 | agent-cto 스킬DevOps | `skill-creator` 존재 |
| `agent-skill-deployer` | 2 | 〃 | 〃 |
| `agent-skill-monitor` | 2 | 〃 | 〃 |
| `agent-skill-auditor` | 1 | 〃 | 〃 |
| `agent-center-ops-architect`<br>`agent-wb-academy-architect` | 2 | 두 automation-manager의 "PRD 설계자" | 설계는 `agent-cto` |

**권고: 전부 삭제.** `agent-cto`의 팀 맵을 실제 존재하는 스킬만 남기도록 정리하면
20회가 한 번에 사라진다. `agent-mcp-ops`는 특히 agent-cto 자신이 하는 일을 남에게 넘기는 모양새다.

---

## 적용 후 남은 수치

| | 이전 | 현재 |
|---|---:|---:|
| 유령 참조 | 27종 100회 | **20종 79회** |
| 처리 완료 | — | B-1 21회 + D 2회 |

남은 79회는 A(34) · B-2(19) · C(22)로, 전부 원장님 판단이 필요한 항목이다.
가장 효율이 좋은 순서는 **C 삭제(22회, 판단 쉬움) → A-1 채널 4종(21회, 업무 영향 큼) → B-2 n8n(13회)** 이다.
