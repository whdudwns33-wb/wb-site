---
name: 삼육중 및 영재원 대비
description: 기존 학생·보호자 화면에서 이어지는 한국어 준비 안내
colors:
  bg: "#F5F3EE"
  panel: "#FFFFFF"
  ink: "#22302A"
  soft: "#56645D"
  line: "#E1E6E2"
  edge: "#86938C"
  accent: "#2B4C3F"
  btn: "#2B4C3F"
  on-btn: "#FFFFFF"
  green-soft: "#E6EFEA"
  blue: "#2F5F8F"
  bg-dark: "#141A17"
  panel-dark: "#1C2420"
  ink-dark: "#E6ECE8"
  soft-dark: "#A3B1AA"
  line-dark: "#2E3A34"
  edge-dark: "#6E7D76"
  accent-dark: "#8FC7AE"
  btn-dark: "#2E5546"
  green-soft-dark: "#22352C"
  blue-dark: "#8DB9E6"
typography:
  body:
    fontFamily: '"Noto Sans KR","Apple SD Gothic Neo","Malgun Gothic",sans-serif'
    fontSize: "1rem"
    lineHeight: 1.6
  guide-body:
    fontFamily: '"Noto Sans KR","Apple SD Gothic Neo","Malgun Gothic",sans-serif'
    fontSize: "1rem"
    lineHeight: 1.75
  guide-headline:
    fontSize: "2.5rem"
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: "-.025em"
  guide-title:
    fontSize: "1.625rem"
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: "-.02em"
  guide-small:
    fontSize: ".875rem"
  button:
    fontSize: "1.125em"
    fontWeight: 900
  chip:
    fontSize: ".8125em"
    fontWeight: 800
    lineHeight: 1.5
  input:
    fontSize: "1.05rem"
rounded:
  grade-link: "10px"
  note: "12px"
  control: "14px"
  card: "16px"
  chip: "99px"
spacing:
  compact: "8px"
  small: "12px"
  medium: "16px"
  wide: "24px"
components:
  button-primary:
    backgroundColor: "{colors.btn}"
    textColor: "{colors.on-btn}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    width: "100%"
  button-ghost:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.accent}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    width: "100%"
  input-code:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    typography: "{typography.input}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    width: "100%"
  chip:
    backgroundColor: "{colors.green-soft}"
    textColor: "{colors.accent}"
    typography: "{typography.chip}"
    rounded: "{rounded.chip}"
    padding: "1px 9px"
  card:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "18px 18px"
  guide-note:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.note}"
    padding: "16px 20px"
  guide-nav:
    textColor: "{colors.accent}"
    padding: "8px 0"
  grade-link:
    textColor: "{colors.accent}"
    rounded: "{rounded.grade-link}"
    padding: "6px 16px"
---

# Design System: 삼육중 및 영재원 대비

## Overview

**Creative North Star: "현재 학생·보호자 화면의 시각 체계"**

따뜻한 바탕, 초록 글자, 한국어 시스템 글꼴을 유지한다. 학생 화면은 큰 조작 요소와 카드, 보호자 화면은 읽기 카드, 준비 안내는 여백·구분선·목차·기본 펼침 목록으로 구성한다. 이 문서는 `index.html`, `parent.html`, `guide.html`의 현재 구현을 기록하며 새로운 시각 정체성을 정하지 않는다.

**Key Characteristics:**
- 한국어 글줄과 초록 강조
- 운영체제 설정을 따르는 라이트·다크
- 그림자 없이 바탕색·테두리·여백으로 구분

## Colors

### Primary

`accent`는 제목·링크·강조 글자, `btn`은 학생 화면의 채운 버튼, `on-btn`은 그 위 글자다. 다크에서 글자용 초록과 버튼 바탕을 분리한 기존 역할을 유지한다. `green-soft`는 카드 안 강조와 안내 경로의 바탕이다.

### Neutral

`bg`는 화면 바탕, `panel`은 카드·상단 바탕, `ink`는 본문, `soft`는 보조 글자다. `line`은 장식 구분선, `edge`는 학생 조작 요소 테두리다. `-dark` 항목은 같은 CSS 변수의 다크 값이며 별도 팔레트 선택 기능을 뜻하지 않는다.

학생 화면의 파랑은 선택·안내·포커스에 쓰고, 준비 안내에서는 포커스에 쓴다. 학생 화면의 경고·오류·정답 상태 색은 기존 코드에 남아 있으며 이 문서가 재정의하지 않는다.

## Typography

별도 웹폰트 다운로드 없이 frontmatter의 한국어 글꼴 스택을 쓴다. 학생 기본 글줄은 `body`, 안내는 `guide-body`다. 안내 제목·절 제목·보조 글자는 각각 `guide-headline`, `guide-title`, `guide-small`을 따른다. 한글은 단어 단위로 줄을 바꾸고 긴 문자열은 넘침을 허용하지 않는다.

학생과 안내는 700px 이상에서 본문을 1.125rem으로 키운다. 보호자 화면의 기존 16px·1.65 글줄은 그대로다. 안내는 900px 이하에서 첫 제목 2rem, 절 제목 1.5rem으로 바뀐다.

## Layout

학생 본문은 최대 640px, 700px 이상에서는 720px이다. 보호자 본문은 최대 560px이다. 준비 안내는 최대 1120px 안에 180px 목차와 본문을 48px 간격으로 배치한다. 900px 이하에서는 목차가 본문 위로 이동하고 경로·로드맵은 한 열이 된다. 이 문서 레이아웃을 학생·보호자 화면에 적용하지 않는다.

안내의 데스크톱 바깥 여백은 24px, 좁은 화면은 20px이다. 학생 좌표는 520px부터 네 열이며 `minmax(0,1fr)`와 자식 최소 폭 0을 유지한다.

## Elevation & Depth

세 화면에 그림자는 없다. 따뜻한 화면 바탕 위의 패널, 옅은 초록 강조 바탕, 얇은 구분선으로 영역을 나눈다. 고정 상단과 목차는 현재 화면별 구현을 따른다.

## Shapes

카드는 `card`, 안내 메모는 `note`, 큰 학생 조작 요소는 `control`, 학년 바로가기는 `grade-link`의 둥근 모서리를 쓴다. 상태 칩은 알약형이다. 구분선과 조작 요소 테두리의 역할을 바꾸지 않는다.

## Components

채운 버튼과 외곽선 버튼은 학생 화면에서 최소 높이 58px이다. 코드 입력은 최소 54px 높이와 조작용 테두리를 쓴다. 버튼에 별도 hover 애니메이션은 없다. 카드의 내부 여백은 학생 18px, 보호자 16px 18px으로 유지한다.

안내 목차·학년 바로가기는 최소 44px 조작 높이를 가진 링크다. 학년 바로가기는 초록 외곽선과 hover의 옅은 초록 바탕을 쓴다. 기관·학년의 펼침 목록은 기본 `details`/`summary`이며 summary는 최소 높이 52px이다. 안내 링크의 hover는 밑줄을 강조한다.

키보드 포커스는 보이는 외곽선으로 표시한다. 학생은 파랑·2px 간격, 안내는 파랑·4px 간격, 보호자는 초록·3px 간격으로 모두 3px 선을 쓴다. 학생 진행 막대의 0.3초 폭 전환은 모션 감소 설정에서 꺼진다.

## Do's and Don'ts

### Do:
- **Do** 기존 한국어 글꼴 스택과 라이트·다크 CSS 변수 역할을 유지한다.
- **Do** 장식 구분선과 조작 요소 테두리를 구분하고 키보드 포커스를 보이게 한다.

### Don't:
- **Don't** 다크의 글자용 초록과 버튼 바탕을 하나로 합치지 않는다.
- **Don't** 안내의 넓은 문서 배치를 학생·보호자 화면의 공통 레이아웃으로 바꾸지 않는다.
