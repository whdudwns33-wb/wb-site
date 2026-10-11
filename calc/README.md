# WB 연산 체험 (공개 페이지)

- 주소: https://whdudwns33-wb.github.io/wb-site/calc/
- 원본: `C:\Users\wb\wbread\arithmetic-app\public\index.html` (빌드 `node trial/build.js`가 만듦). 여기 파일은 복사본이라 직접 고치지 않고 다시 복사한다.
- 글에서 바로 들어가기: `?topic=t1`~`t6` (10 만들기 · 20까지 덧뺄 · 받아올림 없는 덧셈 · 받아내림 없는 뺄셈 · 받아올림 덧셈 · 받아내림 뺄셈) + `&from=글이름`.
- 집계 보기: `?ops=1` (그 기기 안의 수만. 모아 보려면 2차 서버 필요).
- 로그인 · 연락처 · 외부 요청 없음. 기록은 보는 사람 기기에만 남는다.

## 자료 · 상담 버튼 연결
`calc/links.json`에 주소를 넣으면 체험 결과의 "관련 글 · 활동지 받기" · "상담 안내 보기" 버튼이 그 주소를 새 창으로 엽니다. 비우면 아무 데도 가지 않습니다. 빌드 없이 이 파일만 고치면 됩니다.
`{ "material": "https://…", "consult": "https://…" }`
