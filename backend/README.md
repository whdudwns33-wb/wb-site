# 그림검사 AI 해석 웹 · 백엔드 MVP (HTP)

설계 문서(`docs/백엔드-설계-v0.md`, `docs/AI-해석-엔진-프롬프트-스펙-v0.md`)를 실행 가능한 골격으로 구현.
**무의존성**(Node 22 내장 모듈만) · **mock AI**로 네트워크/DB/API 키 없이 즉시 실행.

## 실행
```bash
cd backend
npm start          # http://localhost:8787  (키 없으면 mock AI)
npm test           # end-to-end 스모크 테스트 (17 케이스, mock)
```

## 실제 Claude 연동
```bash
npm install                      # @anthropic-ai/sdk 설치
export ANTHROPIC_API_KEY=sk-...  # 키가 있으면 자동으로 실제 호출 경로 사용
npm start
```
- 키가 **없으면** mock으로 동작(무의존성 실행·CI 유지). 키가 **있으면** `claudeClient.mjs`가 공식 SDK로 호출.
- **S1**(그림 판독): Vision + 강제 tool-use(`record_observations`)로 구조화 관찰 JSON.
- **S3**(생성): 안전 프롬프트로 전문가 초안/학부모 미리보기/정식 리포트.
- 실이미지: 업로드 시 `image_base64`(+선택 `media_type`)를 함께 전달하면 S1이 실제 판독. 데모 키워드(`sample-htp`)는 계속 mock 샘플.
- **모델 선택**(기본 `claude-opus-5`): `MODEL_S1` / `MODEL_S3` 또는 `CLAUDE_MODEL` 환경변수로 단계별 교체 가능(예: S1만 `claude-sonnet-5`로 비용 절감).

## 구조
```
db/schema.sql            프로덕션 DB 스키마(PostgreSQL)
src/server.mjs           API 서버(라우팅·RBAC 자리표시·상태전이)
src/store.mjs            인메모리 저장소(스키마 미러링 → PG로 교체 지점)
src/stateMachine.mjs     제출 상태머신(허용 전이만)
src/pipeline.mjs         S0(위기)→S1(관찰)→S2(가설)→S3(생성) 오케스트레이션
src/guardrails.mjs       금지어·근거수준·연령보정·발행 게이트
src/ai/s1Schema.mjs      S1 Claude tool-use 스키마(관찰 추출 강제)
src/ai/knowledgeBase.mjs HTP 지식베이스(가설·근거수준·연령규준)
src/ai/claudeClient.mjs  Claude 실제 경로 + mock 폴백
test/smoke.mjs           전체 플로우 검증
```

## 검증되는 안전 규칙 (스모크 테스트)
- 상태머신: `consent_pending → uploaded → processing → reviewing → confirmed → published`
- **확정 게이트**: 확정 전 학부모 리포트 미발급, published에서만 반환
- **연령 보정**: 만 8세 손 생략 → 신뢰도 mid→low 강등 + 문구
- **근거수준**: 전 가설 강/중/약 부착, 투사검사 특성상 '강' 없음
- **위기 라인**: 위기 신호 → 자동해석 중단·escalated·학부모 노출 차단
- **동의 게이트**: 만14세 미만 보호자 미인증 시 거부
- **RBAC**: 비전문가 콘솔 접근 403
- **리포트 접근**: 토큰 + 생년 2차 확인, 30일 만료
- **가드레일**: 금지어("진단/장애") 차단(단, "진단이 아닙니다" 면책은 허용)

## 프로덕션 전환 지점(TODO)
- 인메모리 store → PostgreSQL(한국 리전) · 컬럼/이미지 암호화
- 헤더 role → 세션/JWT + 정식 RBAC
- 동기 파이프라인 → 잡 큐/워커
- mock 서명URL → 오브젝트 스토리지 단기 서명 URL
- S3 템플릿 생성 → 실제 Claude messages 호출
- KFD·DAP·자유화 KB 추가
