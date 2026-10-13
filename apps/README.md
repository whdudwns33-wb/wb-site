# 별도 프로토타입·전략 보드

학습 앱과 다른 대상·백엔드를 쓰는 정적 HTML 모음이다. GitHub Pages `/wb-site/apps/` 아래에서
서비스되며, 파일 안의 `meta robots noindex`를 유지한다. noindex는 접근 인증을 대신하지 않는다.

| 경로 | 역할·현재 상태 |
|---|---|
| `picture-test/index.html` | 그림검사 AI 해석 프로토타입. 현재 `WB_API_BASE`가 비어 있어 공개 배포본은 샘플 데모를 쓴다. `?api=` 또는 localhost로 백엔드를 지정하면 `/api/health`부터 확인한다. 백엔드 구조·mock/실제 AI 구분은 [`backend/README.md`](../backend/README.md)를 읽는다. |
| `picture-test/samples/` | 데모 샘플 그림 SVG. 실학생 그림·개인정보를 추가하지 않는다. |
| `suwan-launch/index.html` | 학원 운영 전략·수완 신규 거점 준비 보드. 편집 기록은 사용자 브라우저 localStorage에 남으며 서버 동기화가 없다. 브라우저 관문은 서버 인증이 아니다. |
| `suwan-launch/partner-brief.html` | 리더스·리드앤톡·WB 협업 준비 브리핑. 외부 배부·문구 변경은 원장 확인 사항이다. |

프로토타입을 운영 서비스로 전환하려면 backend의 인증·저장소·동의/발행 조건부터 확인한다.
학습 앱용 `reading/_headers`나 `reading-server/build-dist.mjs`는 이 Pages 화면에 적용되지 않는다.

작업 뒤 저장소 뿌리에서 `node scripts/pages-noindex.test.mjs`, PR 전에는 `node scripts/check.mjs`를 실행한다.
`backend/test/smoke.mjs`는 파일명이 전체 검사 자동 탐색 대상이 아니므로 backend를 고쳤다면
`cd backend && npm test`도 따로 실행한다.
