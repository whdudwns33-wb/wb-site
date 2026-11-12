# 탐구브레인 — 사회·과학 내신 시험대비 앱

족보닷컴 구매 자료(사회·과학 문제지와 요점정리)를 **지면 그대로** 재원생에게 원내 전용으로 보여 주고,
답만 화면에서 받아 채점·오답·시험 계획을 맡는 앱. 내신브레인(영어)·국어브레인의 형제 앱이고 같은 서버·같은 학생 토큰을 쓴다.
기획서: `docs/탐구내신-학습웹앱-기획서-v0.md`.

국어브레인과 가장 다른 점: **자료를 뜯어 다시 조립하지 않는다.** 쪽을 그림으로 바꿔 올릴 뿐이라 문항 생성기·팩 검증기가 없고,
대신 **채점을 서버가 한다** — 정답은 제출 전에 어떤 응답에도 실리지 않고, 정답·해설 쪽도 제출 전에는 403 이다.

## 구성

```
naesin-tg/
  index.html          학생 앱 (탭: 오늘·개념·문제·오답·성취도 + 풀이 화면: 왼쪽 지면, 오른쪽 답안 칸)
  sheet-sample.json   자체 창작 체험 문제지(전기 6문항, SVG 3쪽) — 저장소에 있는 유일한 문제지
  extract/
    build-sheet.mjs   PDF → 올릴 문제지 파일(쪽마다 JPEG). 오프라인 도구, poppler 필요
    make-sample.mjs   sheet-sample.json 을 다시 만든다
reading-server/
  naesin-tg-api.mjs            /api/naesin-tg/* (worker.mjs·server.mjs 양쪽에 등록)
  public/naesin-tg-admin.html  관리 웹 — 올리기·정답 입력·열기/닫기·시험 배정·현황·서술형 확정
```

## 자료를 넣는 순서

1. 저장소 **밖** 작업 폴더에서 `node naesin-tg/extract/build-sheet.mjs <PDF> --id sc-m2-7-1-top-1` → `<id>.sheet.json`.
   PDF 도, 이 파일도 커밋하지 않는다(절대 규칙 1). 외부 AI 로 보내지 않는다.
2. 관리 웹에서 그 파일을 고른다. 과목·학년·단원·단계, **정답·해설이 시작하는 쪽**, 문항 수를 확인한다.
3. 번호별로 유형(객관식·단답·서술형), 있는 쪽, 정답을 넣는다. 객관식은 `3`, 복수 정답은 `1,3`, 단답은 `도체|전도체`.
   정답 자동 읽기는 없다 — 족보닷컴 지면은 정답의 동그라미 숫자가 글자층에 없다(2026-11-12 실측).
4. 「정답을 확인했고 학생에게 엽니다」를 켜고 저장. 정답이 비었거나 쪽 그림이 빠지면 서버가 열기를 거절한다.
5. 자료를 고르고 시험일을 넣어 배정한다(대상을 비우면 반 공통).

## 학생 앱이 하는 일

- 배정되고 열린 자료만 보인다. 읽기 자료(요점정리·노트)는 「개념」, 문제지는 「문제」에 단계별로.
- 풀이 화면: 지면은 전체 / 왼쪽 단 / 오른쪽 단으로 본다(2단 조판 — 그림은 그대로, 보이는 범위만 바꾼다).
  답은 1.2초 뒤 서버에 임시 저장돼 기기를 바꿔도 이어 푼다.
- 제출은 한 번. 제출하면 ○✕·정답·해설 쪽이 열린다. 서술형은 모범답안을 보고 스스로 표시하고 강사가 확정한다.
- 틀린 문제는 **틀린 날과 다른 날** 다시 맞혀야 오답에서 지워진다.

## 서버 API

학생: `GET /sheets` → `{sheets, exam, scope, progress, today}` · `GET /sheet?id=` → `{sheet, my, answers?}`(answers 는 제출 뒤에만)
· `GET /page?id=&n=` → `{page:{n,data}}` · `PUT /draft` · `POST /submit` → `{result}` · `POST /retry` → `{retry}` · `POST /essay`

관리: `GET /admin/sheets` · `POST /admin/sheet {id, sheet}` · `POST /admin/page {id, n, data}`(1.4MB) · `POST /admin/sheet-delete`
· `GET/POST /admin/exam` · `GET /admin/overview` · `GET /admin/student?code=&id=` · `POST /admin/essay`

## 현재 상태 (v0, 2026-11-12)

있는 것: 위 전부, 서버 테스트(`node reading-server/naesin-tg-api.test.mjs`).
아직 없는 것: 실제 족보닷컴 문제지로 한 시험(계정에 내려받기 권한이 없었다) · 과제 배정(시험 범위와 따로 주는 숙제) ·
반별 현황 묶음 · 인쇄 · 이용권이 끝났을 때 자료를 지우는 절차 · 야간 백업에 풀이 기록 싣기(`worker.mjs` 의 dump).
