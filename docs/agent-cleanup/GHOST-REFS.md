# 유령 참조 정리 — 완료

존재하지 않는 스킬을 가리키던 참조를 전부 실존 스킬로 연결했다.

| | 이전 | 이후 |
|---|---:|---:|
| 유령 참조 | **27종 100회** | **0** |

> **초기 보고 정정** — README에 "60종 156회"라고 적었으나, 그 수치에는 의도적으로 남긴
> 승계 이력(후계자 문서 안의 폐지 스킬 언급), 경로 플레이스홀더(`[agent-name]`),
> 파일명(`hr-retention-changelog.md`)이 섞여 있었다. 실제는 27종 100회였다.

## 방침 — 신규 스킬을 만들지 않았다

채널 4종과 `agent-design-canva`는 "만들어야 할 것"으로 분류했으나 **생성하지 않기로 했다.**
4~5개를 새로 만들면 상시 로드 description이 다시 1,000토큰 이상 늘어 이번 정리의 목적과 정면으로 어긋난다.
전부 **이미 그 일을 담당하는 상위 실존 스킬로 흡수**했다.

나중에 채널별 전담이 정말 필요해지면 그때 분리하면 된다 — 지금은 받을 곳이 없는 상태가 문제였지, 전담이 없는 게 문제가 아니었다.

---

## 처리 내역

### A. 실무는 도는데 스킬만 없던 것 (5종 34회) → 상위 스킬로 흡수

| 유령 | → | 근거 |
|---|---|---|
| `agent-channel-blog`<br>`agent-channel-cafe`<br>`agent-channel-insta`<br>`agent-channel-karrot` | `agent-marketing` | 상위 마케팅 에이전트가 채널 발행을 총괄한다. `agent-qa`의 발행 검수 게이트가 이제 실제로 받을 입력이 생겼다. 당근 동영상은 `daangn-video-ad`가 별도로 담당한다. |
| `agent-design-canva` | `agent-design` | agent-design이 이미 Creative Director이고 Canva MCP가 연결돼 있다. 카드뉴스·시크릿노트 표지를 직접 다루면 된다. |

### B-1. 이름만 틀렸던 것 (7종 21회) → 교정

| 유령 | → | 근거 |
|---|---|---|
| `agent-cs-center` / `agent-cs-academy` | `agent-cs` | agent-cs가 "센터 + 학원" CS 모두 담당한다고 명시 |
| `agent-docs-manager` | `agent-google` | Drive 배포 담당이 agent-google Step 0으로 이관됨 |
| `agent-center-ops` | `agent-center-ops-automation-manager` | 정식 명칭 |
| `agent-academy-ops` | `agent-academy-ops-automation-manager` | 정식 명칭 |
| `agent-center-consult` | `agent-consult` | 정식 명칭 |
| `agent-program-manager` | `agent-online-program-manager` | 정식 명칭 |

별도 오탈자 4건도 함께: `agent-studyforce`→`agent-studyforce-manager`,
`agent-docx`→`docx`, `hr-recruiting`→`hr-recruiter`, `agent-academy-student`→`agent-student`.

**`agent-voc`가 가장 심했다** — 위임 대상 14건이 전부 유령이었다.

### B-2. 통합 대상 (5종 19회)

| 유령 | → | 근거 |
|---|---|---|
| `agent-n8n` / `-flow` / `-installer` / `-monitor` | **`agent-cto`** | agent-cto가 "자동화 파이프라인 설계" 담당이다. **`agent-make`로 보내지 않았다** — agent-make는 🟢 등급 데이터 전용인데 n8n은 🔴 등급을 받는 경로라, 그쪽으로 넘기면 데이터 등급 위반이 된다. |
| `agent-idea` | `agent-strategy` | agent-voc가 이미 "agent-idea / agent-strategy"로 병기하던 대안 |

> ⚠️ **n8n은 여전히 담당자가 없다.** agent-make description의 "Make × n8n 병행 실험(4주)"에서
> n8n 쪽 실행 주체가 비어 있는 상태다. 참조는 agent-cto로 연결했지만,
> 실험을 계속한다면 담당을 정해야 하고 끝났다면 agent-make에서 그 문구를 빼는 게 맞다.

### C. 계획만 있고 실체 없던 것 (8종 22회) → 실존 담당자로 축약

거의 전부 `agent-cto`의 "에이전트 팀 맵(2026-04-26 기준)"에만 있던 것들이다.

| 유령 | → |
|---|---|
| `agent-skill-ops` / `-deployer` / `-monitor` / `-auditor` | `skill-creator` |
| `agent-scanner` / `agent-scan` | `agent-google` (Drive 스캔 파일 감지) |
| `agent-mcp-ops` | `agent-cto (본인 담당)` — description에 MCP 연결 전략이 자기 일이라고 적혀 있었다 |
| `agent-center-ops-architect` / `agent-wb-academy-architect` | `agent-cto` (설계 담당) |

### D. 안전 경로 — `agent-crisis` (1종 2회)

지시대로 참조를 제거하되, **"받을 곳 없음" 상태로 두지 않았다.**

| 위치 | 이전 | 이후 |
|---|---|---|
| 라우팅표 | `"위기","긴급","큰일","신고" → agent-crisis 즉시` | `COO가 직접 접수 → 영준님 즉시 보고 (자동 처리 금지)` |
| 도메인 매핑 | `위기·자해·신고 → agent-crisis (직진입 권장)` | `위임하지 않음 — COO 접수 후 영준님 즉시 보고` |

행만 지우면 위기 발화가 `그 외 모든 발화 → COO가 처리` 디폴트로 떨어져
**일반 업무와 같은 취급**을 받는다. 그건 유령 참조를 남기는 것보다 나쁘다고 판단해 한 줄을 남겼다.
이 문구가 불필요하면 제거해도 된다.

---

## 부수 정리

흡수 과정에서 같은 이름이 연달아 반복된 자리(`agent-marketing, agent-marketing, …`)를
5개 파일에서 정리했고, `agent-cto`의 `agent-channel-* (4개)` 와일드카드 표기도 실제 스킬명으로 바꿨다.

## 최종 검증

- 스킬 92개 / YAML 오류 0 / 중복 name 0 / 널바이트 0
- **유령 참조 0종 0회**
- 이름 중복 표기 0건
