# MCP 서버 정리안

현재 12개가 연결되어 있다. 도구 스키마 자체는 지연 로딩(ToolSearch)이라 부담이 적지만,
**각 서버가 제공하는 instruction 블록은 매 세션 전문이 로드**된다. Figma의 것이 가장 크다(~2KB).

## 판정 근거

정리 전 스킬 118개 본문 전체에서 각 서버 언급 횟수를 센 결과다.

| MCP | 언급 스킬 수 | 판정 |
|---|---:|---|
| HubSpot | 49 | **유지** — 핵심 |
| Google Calendar | 30 | **유지** — 핵심 |
| Kakao (채널) | 9 | 유지 — 단 아래 주석 참조 |
| Gmail | 7 | 유지 |
| Canva | 6 | 유지 — `agent-design` 계열 |
| Zoom | 5 | 검토 — 상담 녹취 용도면 유지 |
| Naver | 5 | 검토 — PlayMCP 하위 |
| Google Drive | 5 | 유지 |
| Notion | 4 | 유지 |
| github | 2 | 유지 — 레포 작업용 |
| Perplexity | 1 | 검토 — 기본 WebSearch와 기능 중복 |
| Saramin | 1 | 검토 — PlayMCP 하위, 채용 |
| **Figma** | **0** | **끄기** |
| **Gamma** | **0** | **끄기** |

## 즉시 실행

**Figma, Gamma 두 개를 끈다.** 118개 스킬 어디서도 쓰지 않는다.
Figma는 instruction 블록이 12개 중 가장 무거워 절감폭이 크다. 합쳐서 약 800~1,000토큰.

## 검토 대상

- **PlayMCP** — KakaoMap·NaverSearch·Saramin을 한 서버에 묶고 있다.
  스킬에서 잡힌 Kakao 9건은 대부분 *카카오채널(비즈니스)* 이야기라 PlayMCP의 KakaoMap·메모챗과는
  무관할 가능성이 높다. 즉 실제로는 **NaverSearch만 쓰고 있을 확률이 크다.**
  네이버 검색을 안 쓴다면 정리 후보.
- **Perplexity** — 1개 스킬에서만 참조. 심층 리서치가 꼭 필요한 게 아니면 기본 WebSearch로 대체 가능.
- **Zoom** — 5건. 상담 녹취·회의록 파이프라인에 실제로 물려 있다면 유지.

## 반영 방법

MCP 연결은 **claude.ai 계정 커넥터 설정**에 있다.
로컬에 `.mcp.json`이나 `~/.claude.json`의 `mcpServers` 항목이 없으므로 코드로 반영할 수 없다.

claude.ai → 설정 → 커넥터에서 해당 서버를 해제한다.
