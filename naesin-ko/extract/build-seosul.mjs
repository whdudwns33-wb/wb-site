#!/usr/bin/env node
/* WB 국어브레인 — 서술형 공략 spans → 서술형 문항 · 지문 세트 · Work 패치 (추출 파이프라인 2단계)
 *
 *   python3 naesin-ko/extract/pdf-spans.py <서술형공략.pdf> > spans.json
 *   node naesin-ko/extract/build-seosul.mjs spans.json --scope u1 \
 *        --work "저녁 항구=w-jeonyeok" --review review/seosul-u1.json > items-seosul.json
 *
 * 절차 전체는 naesin-ko/extract/README.md 를 본다. 공용 규칙은 spans-util.mjs 에 있다.
 *
 * 뽑는 것: items(서술형 essay) · sets(지문 세트) · patches(작가) · review(검수 부속물)
 *
 * 이 자료의 성질 (전부 실측 — 천재(노미숙) 중2-1 「1.문학을 펼치면(01)」 15쪽):
 *   ① 앞쪽 p1~11 이 지문+문항, 뒤쪽 p12~15 가 정답·해설이다. 2단 조판이고 읽기 순서는
 *      **왼쪽단 전체 → 오른쪽단 전체**다 — p1 은 왼쪽단 1번이 y563, 오른쪽단 2번이 y98이라
 *      y로 훑으면 문항 순서가 뒤집힌다.
 *   ② 문항 번호 1..25 · 흰 글씨 zb1)..zb25) · 해설 절의 'N)' 25개 — **세 수가 같아야 한다.**
 *      팩의 counts 는 assemble 이 다시 세므로 누락 검산이 안 된다(스키마 분석 §pitfalls).
 *      그래서 검산을 여기서 직접 한다.
 *   ③ 빈칸 정답이 **없다**. 흰 글씨(#ffffff) 50개는 전부 zb 문항번호(25문항 × 2 span)다.
 *      이해완성의 '흰 글씨 = 정답' 규칙을 그대로 쓰면 문항번호가 빈칸으로 둔갑한다.
 *   ④ 머리말에 출판사·학년-학기('천재(노미숙)2-1')가 있다 — 4종 중 이 자료에만 있는 메타라
 *      다른 시리즈의 빈 칸을 이것으로 메운다(§2.2-7). U.headerMeta 가 이미 읽는다.
 *   ⑤ 지문 상자·<보기>·<조건> 박스의 테두리는 **벡터 괘선**이라 pdf-spans.py 출력에 없다.
 *      그래서 경계를 좌표가 아니라 **읽기 순서의 사건**(※ · 문항번호 · 박스 라벨)으로 잡는다.
 *
 * 뽑지 '않는' 것 (검수에서 사람이 붙인다 — 자료에 근거가 없다):
 *   · 배점(totalPoints) — 지면 전체에 배점 표기가 0건이다. 넣으면 요소 배점 합과 어긋나 오류다.
 *   · 루브릭 요소 묶기 — '핵심 단어'는 낱말 나열이지 요소 묶음이 아니다. 쉼표로 자른 것을
 *     그대로 요소로 쓰되, 이표기를 한 요소로 묶는 것은 사람이 한다(과엄격은 hold, 과관대는 오통과).
 *   · targetRefs — 자료에 문항↔개념 단위 대응이 없다. 문자열로 억지로 맞추면 오답이
 *     엉뚱한 빈칸 큐로 돌아가 학생이 상관없는 것을 외운다.
 *   · 제목·작가가 인쇄되지 않은 세트의 작품 추정 — 문맥으로는 알아도 지면에 없다.
 *   · chars/words 조건 — 이 자료에 0건이라 정규식을 실측으로 굳히지 못했다. 사람 확인으로 내린다.
 */
import * as U from './spans-util.mjs';
/* 채점기를 그대로 불러 **자기 검산**을 한다 — 뽑은 조건에 자료의 모범답안을 걸어 보고
   자기 모범답안이 자기 조건에 걸려 떨어지면 그 조건은 오분류다. 조건 오분류는 곧 오답 판정이라
   (checkConditions 의 fail 은 즉시 학생에게 되돌려진다) 지면 대조보다 이 검산이 확실하다. */
import G from '../grade.js';

/* 본문 글꼴 크기 — 실측 size 분포. 나머지는 전부 지면 부속물이라 이름으로 걸러 낸다:
   0.7/1.0 zb 문항번호 · 5.0 저작권 고지 · 6.0 자료 식별번호 · 7.0 해설 라벨(청록) ·
   7.4 '개념 plus+' 표 · 10.1/11.0 p1 배너 · 13.7 문항 번호.
   **size <= 6 을 통째로 버리면 안 된다** — zb 가 1.0/0.7 이라 문항 고유번호를 통째로 잃는다. */
const BODY_SIZES = [7.9, 9.1];

/* 해설 절 라벨 — 청록 #3e88ab **size 7.0**. p1 배너도 #3e88ab 지만 10.1/11.0 이라,
   크기를 함께 걸지 않으면 p1 이 해설쪽으로 오인된다(실측). */
const LABEL_COLOR = '#3e88ab', LABEL_SIZE = 7.0;
const L_ANSWER = '모범 답안', L_KEYWORD = '핵심 단어', L_CHECK = '모범 답안 check list';
const L_TIP = '서술형 공략 Tip', L_CONCEPT = '개념 plus+';
/* 해설 라벨이 앞 문항(1~10)은 '이해 plus+', 뒤 문항(11~25)은 '해설'로 갈린다. 한 문항에
   둘이 같이 오는 경우는 없다 — 둘을 같은 필드로 합쳐야 25/25 가 채워진다(실측 10 + 15). */
const L_EXPLAIN = ['이해 plus+', '해설'];

/* 박스 라벨 — 괘선이 없으므로 이 라벨이 박스의 시작 신호다. 라벨 줄은 라벨 하나뿐이다. */
const BOX_LABEL = /^<\s*(보기|조건)\s*>$/;
const PREFACE = /^\(\s*앞부분\s*줄거리\s*\)$/;
/* (가)(나) 라벨이 문단 첫 줄에 **붙어서** 온다('(가) 아주 평범한 날이었다.') —
   U.passageLabels 는 라벨이 단독 span 일 때만 잡으므로 여기서는 못 쓴다. */
const PART_LABEL = /^\s*\(([가-하])\)\s*/;

/* 발문 글자 자리 — 컬럼 왼끝 기준. 실측 첫 줄 +25.7~26.2(1자리/2자리), 이어지는 줄 +16.5~16.8.
   25문항 전부 이 값이라(예외 0) 발문의 끝을 이 격자에서 벗어나는 첫 줄로 잡는다.
   라벨 없는 인용 상자(문항 17의 '선생님:' 설명)가 발문에 통째로 붙는 것을 이것으로 막는다. */
const STEM_DX_FIRST = [23, 29], STEM_DX_CONT = [14.5, 19];

/* 작가 줄 — 좌표를 고정값으로 적지 않고 '기둥 왼끝에서 얼마나 오른쪽인가'로 본다.
   실측 작가 오프셋 197.0 폭 25.2, 인용 출처 '- 김종길, <성탄제>'는 오프셋 147.8 폭 70.0 이라
   두 조건(오프셋·폭)을 함께 걸어야 갈린다. */
const AUTHOR_DX = 150, AUTHOR_W = 45;
/* <보기> 출처 줄 — 오른쪽 정렬이고 '-'로 시작한다. 실측 오프셋 106.8/142.6/147.8.
   본문 대화 줄도 '―'로 시작하지만(문항 6) 오프셋 13.2라 갈린다. */
const SOURCE_DX = 90;
const SOURCE_RE = /^[-–—―]\s*(.+?)\s*[,，]?\s*<\s*(.+?)\s*>/;

/* 지문 기호. U+3260~U+326D = ㉠~㉭. 범위를 코드포인트로 적는 이유는 ㉟(U+325F)가 ㉠보다
   앞이라 /[㉠-㉟]/ 라고 쓰면 범위가 뒤집혀 정규식 자체가 죽기 때문이다. */
const MARK_SYM = /[㉠-㉭]/g;
/* 부정발문 — 밑줄 서식 경계에서 공백이 먹혀 '적절하지 않은것은?'으로 붙어 나온다. */
const NEGATIVE = /적절하지\s*않은|옳지\s*않은|아닌\s*것은/;

const pad2 = (n) => String(n).padStart(2, '0');

/* 여러 줄을 한 덩이로 — **구분자 없이** 붙이고 맨 끝에 한 번만 판면 부속물을 턴다.
   줄 글자를 trim 하지 않는 이유가 여기 있다: PDF는 어절 경계 줄바꿈에만 끝공백을 넣어 두고
   ('…운율을 형성' + '하고') 어절 중간에는 안 넣는다('종결 어' + '미를'). trim 하거나 ' '로 이으면
   모범답안 글자가 틀어지고, 채점기는 글자 하나 차이로 오판한다(기획서 §7). */
function joinRows(rows) {
  return U.stripChrome(rows.map((r) => r.text).join(''));
}

/* 상자 안 여러 줄 잇기 — 줄바꿈이 '흘러넘친 것'인지 '일부러 끊은 것'인지로 갈린다.
   흘러넘친 줄(같은 왼끝 + 기둥 폭을 채움)은 어절 중간에서 끊기므로 구분자 없이 붙여야 하고,
   일부러 끊은 줄(시행·가운데 정렬 문장)을 그렇게 붙이면 '묻혀내 울음은'처럼 글자가 엉킨다.
   실측 <보기> 상자 6개가 이 두 신호(공통 왼끝 · 폭 중앙값)로 전부 갈렸다 —
   산문 인용 3개는 흘러넘친 줄, 시 인용 2개와 가운데 정렬 두 줄짜리 1개는 끊은 줄이다.
   끊은 줄은 시 인용 관례대로 ' / '로 이어 지면의 줄바꿈을 살린다. */
function joinBox(rows, colWidth) {
  if (rows.length < 2) return joinRows(rows);
  const tally = {};
  rows.forEach((r) => { const k = Math.round(r.dx); tally[k] = (tally[k] || 0) + 1; });
  const sameLeft = Math.max.apply(null, Object.keys(tally).map((k) => tally[k]));
  const widths = rows.map((r) => r.right - r.x).sort((a, b) => a - b);
  const median = widths[Math.floor(widths.length / 2)];
  if (!(sameLeft >= 2 && median >= colWidth * 0.75)) {
    return rows.map((r) => U.stripChrome(r.text)).filter(Boolean).join(' / ');
  }
  /* 흘러넘친 상자라도 문단이 여럿이면 문단 끝 줄은 오른쪽 여백에 못 닿는다 —
     그 다음 줄은 새 문단이라 붙이면 '내음새가 나고또 인절미'처럼 엉킨다.
     상자 자신의 오른쪽 여백(가장 오른쪽까지 간 줄)을 기준으로 4pt 이상 모자란 줄 뒤에만 띄운다. */
  const edge = Math.max.apply(null, rows.map((r) => r.right));
  let out = '';
  rows.forEach((r, i) => {
    out += r.text;
    if (i < rows.length - 1 && edge - r.right > 4 && !/\s$/.test(out)) out += ' ';
  });
  return U.stripChrome(out);
}

/* 읽기 순서 스트림: 쪽마다 왼쪽단 전체(y↑) → 오른쪽단 전체(y↑).
   U.splitColumns 의 기본 경계(width/2 = 297.6)가 실측 밴드(좌 ~286.2 / 우 311.8~) 사이에
   안전하게 떨어지고, 머리말·판권 띠를 y로 이미 잘라 준다 —
   해설쪽 저작권 고지가 x=302.6(어느 밴드에도 없는 자리)에서 오른쪽단으로 새는 것도
   y>=770 이라 여기서 함께 걸러진다(순진한 x<300 분할은 실측 5문항을 오염시켰다). */
function readStream(pages, sizes) {
  const out = [];
  pages.forEach((page) => {
    const cols = U.splitColumns(page);
    ['L', 'R'].forEach((col, ci) => {
      cols[ci].slice().sort((a, b) => a.y - b.y).forEach((line) => {
        const body = line.spans.filter((s) => sizes.indexOf(s.size) >= 0);
        out.push({
          page: page.no, col, y: line.y, spans: line.spans, body,
          text: body.length ? U.joinSpans(body) : '',
          x: body.length ? Math.min.apply(null, body.map((s) => s.x)) : null,
          right: body.length ? Math.max.apply(null, body.map((s) => s.x + s.w)) : null,
        });
      });
    });
  });
  return out;
}

/* 기둥 왼끝을 **문서 전체에서** 한 번만 잰다. 쪽·기둥마다 따로 재면 그 기둥에 짧은 줄만
   있는 쪽에서 기준이 밀려, 같은 격자인데 왼단은 dx 0 오른단은 dx 5.3 으로 어긋난다.
   실측 왼단 56.6 · 오른단 311.8 (둘 다 '※ 다음 글을…' 줄이 기둥 맨 왼쪽에 선다). */
function columnGeometry(rows) {
  const base = { L: Infinity, R: Infinity }, edge = { L: -Infinity, R: -Infinity };
  rows.forEach((r) => {
    if (!r.body.length) return;
    if (r.x < base[r.col]) base[r.col] = r.x;
    if (r.right > edge[r.col]) edge[r.col] = r.right;
  });
  ['L', 'R'].forEach((c) => { if (!isFinite(base[c])) { base[c] = 0; edge[c] = 0; } });
  const width = Math.max(edge.L - base.L, edge.R - base.R);
  return { base, edge, width: width > 0 ? width : 1 };
}

/* ── <조건> 문구 → grade.checkConditions 의 kind ──
   자동 변환이 확실한 것만 진짜 kind 로 내고, 애매한 것은 kind 'quote'(= 자동 판정 안 함)로
   **내려서** 낸다. 지우지 않는 이유: 조건 문구는 학생 화면에 그대로 뜨는 요구사항이라
   (index.html drawEssay) 빼 버리면 학생이 무엇을 지켜야 하는지 못 본다.
   내린 것은 전부 review.pending 으로 올라가 사람이 kind 를 확정한다.

   실측 18개 조건의 분포: form 7 · sentences 4 · include 2 · quote 1 · 내용 요구 5
   (문항 9의 조건 하나가 form 과 sentences 를 겸한다 → 조건 객체는 19개가 된다). */
const BULLET = /^\s*(?:\d+\s*[.)]|[-–—‧·•])\s*/;
/* 형식 조건: 따옴표 안에 물결(~)이 든 틀이 있고, '형식/형태/같이' 로 그 틀을 요구한다.
   여는 따옴표부터 **마지막** 닫는 따옴표까지 욕심껏 잡는다 — 틀 안에 따옴표가 한 번 더
   나오는 표기가 실제로 있다('‘나‘는 ~ 처지이기 때문에 ~ 느꼈을 것이다.’'). */
const FORM_TPL = /[‘'"“]([\s\S]*~[\s\S]*)[’'"”]/;
const FORM_TRIGGER = /형식|형태|같이/;
const QUOTE_TOKEN = /[‘'"“]([^’'"”~]{1,24})[’'"”]/g;
const INCLUDE_TRIGGER = /모두\s*포함|함께\s*(서술|포함|쓸|쓰)|모두\s*(넣|담)/;
const SENTENCE_RE = /(?:^|[^0-9A-Za-z가-힣])(한|하나의|하나|두|둘|세|셋|네|넷|다섯|\d{1,2})\s*문장/;
const SENTENCE_NUM = { 한: 1, 하나: 1, 하나의: 1, 두: 2, 둘: 2, 세: 3, 셋: 3, 네: 4, 넷: 4, 다섯: 5 };
/* 인용 조건 — '시행/구절을 (모두) (찾아) 쓸 것'. checkConditions 는 quote 를 자동 판정하지
   않으므로(사람 확인) 안전하다. '공통점을 쓸 것' 같은 내용 요구가 걸리지 않게 좁게 적는다. */
const QUOTE_RE = /(시행|구절)[을를]?\s*(모두\s*)?(찾아\s*)?(그대로\s*)?(쓸|인용할|포함할)\s*것/;
/* normalizeKo 가 지워 버리는 글자 — 원문자(①ⓐ), 지문 기호(㉠), 꺾쇠(<보기>).
   이런 글자가 틀 안에 있으면 조각이 1글자로 잘려 검사가 무력해지거나 정답이 오탈락한다. */
const EATEN = /[①-⓿㉠-㉭<>]/;

export function classifyCondition(raw) {
  const text = U.stripChrome(String(raw || '')).replace(BULLET, '').trim();
  const kinds = [], why = [];
  if (!text) return { text: '', kinds: [], why: ['빈 조건'] };

  /* ① 형식(form) */
  const tpl = text.match(FORM_TPL);
  if (tpl && FORM_TRIGGER.test(text)) {
    const value = tpl[1].trim();
    /* 물결로 자른 조각 중 **글자가 있는데 정규화 후 2자 미만**이 되는 것이 있으면
       그 조각은 checkConditions 가 버려 검사가 헐거워진다(또는 엉뚱하게 엄격해진다). */
    const thin = value.split(/~+/).some((f) => f.trim().length > 0 && G.normalizeKo(f).length < 2);
    if (EATEN.test(value)) why.push('틀에 정규화가 지우는 글자(원문자·㉠·꺾쇠)가 있다 — 사람이 앞뒤를 잘라야 한다');
    else if (thin) why.push('물결로 자른 조각이 1글자 이하로 남는다 — 사실상 검사가 되지 않는다');
    else kinds.push({ kind: 'form', value });
  }

  /* ② 문장 수(sentences) — 형식 조건과 겸할 수 있다(실측 문항 9). */
  const sm = text.match(SENTENCE_RE);
  if (sm) {
    const n = SENTENCE_NUM[sm[1]] != null ? SENTENCE_NUM[sm[1]] : parseInt(sm[1], 10);
    if (n > 0) kinds.push({ kind: 'sentences', value: n });
  }

  /* ③ 포함(include) — 따옴표로 묶인 어구를 모두 쓰라는 요구. 형식 틀이 있으면 그 쪽이다. */
  if (!tpl && INCLUDE_TRIGGER.test(text)) {
    const toks = [];
    let m;
    QUOTE_TOKEN.lastIndex = 0;
    while ((m = QUOTE_TOKEN.exec(text))) toks.push(m[1].trim());
    if (toks.length) {
      /* 1글자 어구는 다른 낱말 속에 그대로 들어 있어 오통과한다 —
         실측 '배'가 '배경·배우·통통배'에 전부 걸린다. */
      if (toks.some((t) => G.normalizeKo(t).length < 2)) {
        why.push('포함 어구에 1글자가 있다 — 다른 낱말 속에 걸려 오통과한다(사람이 인정 표기로 바꿔야 한다)');
      } else {
        kinds.push({ kind: 'include', value: toks });
      }
    }
  }

  /* ④ 인용(quote) — 자동 판정하지 않는 조건이라 그대로 내도 안전하다. */
  if (!kinds.length && !why.length && QUOTE_RE.test(text)) kinds.push({ kind: 'quote', value: text });

  if (!kinds.length && !why.length) {
    why.push('내용 요구형이라 자동 판정할 수 없다 — 억지로 include 로 바꾸면 오답 판정이 된다');
  }
  return { text, kinds, why };
}

export function buildSeosul(doc, opts) {
  opts = opts || {};
  const pages = (doc && doc.pages) || [];
  const meta = Object.assign({}, U.headerMeta(doc));
  const sizes = opts.bodySizes || BODY_SIZES;
  /* 문항 id 의 네임스페이스. zb 번호는 **파일 안에서만** 유일하다 —
     단원집중 zb1~23 과 서술형 공략 zb1~25 가 정면충돌하므로 시리즈 접두(U.itemId)와 scope 로 가른다. */
  const scope = String(opts.scope || meta.subUnit || (meta.unit ? 'u' + meta.unit : 'u'))
    .replace(/[^A-Za-z0-9-]+/g, '-');
  const workIds = opts.workIds || {};     // 제목 → workId. 이해완성이 정한 id를 사람이 넘긴다.
  const section = opts.section || meta.unitTitle || '';

  const report = [], todo = [], candidates = [], pending = [];
  const sets = [], items = [], patches = [];

  /* ── 앞뒤 절 가르기 ──
     '마지막으로 문항 번호가 찍힌 쪽 다음부터 해설'. 쪽 수가 달라져도 산다(실측 문제 11 · 해설 4).
     청록 라벨(#3e88ab 7.0)이 있는 쪽으로도 따로 재어 두 판정이 어긋나면 검수로 넘긴다. */
  let lastProblem = -1;
  pages.forEach((p, i) => { if (U.itemMarkers(p.lines).length) lastProblem = i; });
  const labelPages = pages.filter((p) => p.lines.some((l) =>
    l.spans.some((s) => s.color === LABEL_COLOR && s.size === LABEL_SIZE))).map((p) => p.no);
  const problemPages = pages.slice(0, lastProblem + 1);
  const solutionPages = pages.slice(lastProblem + 1);
  if (labelPages.length && labelPages[0] !== (solutionPages[0] || {}).no) {
    todo.push(`문항쪽/해설쪽 경계가 두 방식에서 다르다 — 문항번호 기준 p${(solutionPages[0] || {}).no}` +
      ` · 해설 라벨 기준 p${labelPages[0]}. 지면과 대조할 것`);
  }

  /* ── 문항쪽 스트림 ── */
  const ps = readStream(problemPages, sizes);
  const geo = columnGeometry(ps);
  ps.forEach((r) => {
    r.dx = r.x == null ? null : +(r.x - geo.base[r.col]).toFixed(1);
    r.w = r.x == null ? 0 : r.right - r.x;
    const one = [{ y: r.y, spans: r.spans }];
    const m = U.itemMarkers(one);
    if (m.length) r.itemNo = m[0].no;
    if (U.passageStarts(one).length) r.setStart = true;
  });
  const isEvent = (r) => r.itemNo != null || r.setStart;

  /* zb 고유번호 — **색이 아니라 크기로** 잡는다(spans-util 주석). 기둥을 먼저 갈라야
     같은 y에 놓인 좌·우단 zb 가 한 줄로 뭉쳐 오는 것을 풀 수 있다. */
  const zbById = {};
  let zbCount = 0;
  problemPages.forEach((page) => {
    U.splitColumns(page).forEach((lines) => {
      const marks = U.itemMarkers(lines);
      U.itemIds(lines).forEach((z) => {
        zbCount += 1;
        let owner = null;
        marks.forEach((m) => { if (m.y < z.y) owner = m; });   // 같은 기둥의 직전 문항 번호
        if (owner) zbById[owner.no] = z.id;
      });
    });
  });

  /* ── 지문 세트 ──
     ※ 줄부터 다음 사건(문항 번호 또는 다음 ※)까지가 한 세트다. 지문 상자는 단·쪽을 넘겨
     이어지므로(실측 세트#3은 p2R에서 열려 p3R에서 닫힌다) 스트림 위에서 자른다. */
  function parseRegion(rows) {
    const lines = rows.filter((r) => r.body.length);
    /* 작가 줄을 먼저 찾고 **그 바로 앞 줄**을 제목으로 본다. '가운데 정렬'로 잡으면
       양쪽 정렬된 산문 본문 줄이 우연히 중심에 걸려 제목으로 둔갑한다(분석 결과 pitfalls). */
    const ai = lines.findIndex((r) => r.body.length === 1 && r.dx >= AUTHOR_DX && r.w < AUTHOR_W);
    const author = ai >= 0 ? U.stripChrome(lines[ai].text) : '';
    const title = ai > 0 ? U.stripChrome(lines[ai - 1].text) : '';
    const rest = lines.filter((r, i) => i !== ai && i !== ai - 1);

    /* 문단 나눔은 좌표 상수가 아니라 **가장 흔한 들여쓰기**로 잡는다. 자료 안에서 두 관례가
       섞여 있다(문단 첫 줄이 +13.2이고 이어지는 줄이 +5.3인 상자 / 그 반대인 상자).
       '가장 많은 dx = 이어지는 줄'로 두면 두 관례가 같은 코드로 갈린다. */
    const tally = {};
    rest.forEach((r) => { const k = Math.round(r.dx); tally[k] = (tally[k] || 0) + 1; });
    const mode = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0];
    const cont = mode == null ? 0 : Number(mode);
    const isStart = (r) => Math.abs(r.dx - cont) > 2;

    /* 시인가 산문인가 — 산문은 기둥 폭까지 채운 줄이 대부분이고 시는 하나도 없다.
       실측 시 0% · 산문 64~78%. 시 갈래를 자동으로 정하지 않기 위한 판정이 아니라
       'text.paragraphs 를 담아야 하는가'를 정하기 위한 판정이다. */
    const full = rest.filter((r) => r.w >= geo.width * 0.80).length;
    const prose = rest.length > 0 && full / rest.length >= 0.35;

    /* 앞부분 줄거리 — '(앞부분 줄거리)' 앵커 다음 **한 문단**. 실측 4세트 모두 한 문단이다. */
    let preface = '', prefaceEnd = -1;
    const pi = rest.findIndex((r) => PREFACE.test(r.text.trim()));
    if (pi >= 0) {
      const buf = [];
      for (let i = pi + 1; i < rest.length; i += 1) {
        if (i > pi + 1 && isStart(rest[i])) break;
        buf.push(rest[i]); prefaceEnd = i;
      }
      preface = joinRows(buf);
    }

    /* 본문 — (가)(나) 라벨이 문단 첫 줄에 붙어 오므로 라벨로 조각을 가른다. */
    const bodyRows = rest.filter((r, i) => i !== pi && !(pi >= 0 && i > pi && i <= prefaceEnd));
    const parts = [];
    let cur = null;
    bodyRows.forEach((r) => {
      const t = r.text;
      const lab = t.match(PART_LABEL);
      if (lab || !cur) {
        cur = { label: lab ? '(' + lab[1] + ')' : '', paras: [], lines: [] };
        parts.push(cur);
      }
      const clean = lab ? t.replace(PART_LABEL, '') : t;
      if (prose) {
        if (isStart(r) || !cur.paras.length) cur.paras.push([]);
        cur.paras[cur.paras.length - 1].push({ text: clean });
      }
      cur.lines.push(U.stripChrome(clean));
    });
    return parts.map((p) => ({
      label: p.label, title, author, prose, preface,
      paragraphs: p.paras.map((rows2) => joinRows(rows2)).filter(Boolean),
      lines: p.lines.filter(Boolean),
      page: lines.length ? lines[0].page : null,
    }));
  }

  const regions = [];
  ps.forEach((row, i) => {
    if (!row.setStart) return;
    let end = i + 1;
    while (end < ps.length && !isEvent(ps[end])) end += 1;
    regions.push({ no: regions.length + 1, at: i, parts: parseRegion(ps.slice(i + 1, end)) });
  });

  /* ── 세트 → 팩 ──
     works[].workId 가 없는 작품을 참조하면 배포가 막힌다. 제목이 인쇄되지 않은 세트는
     팩에 내지 않고 검수로 보낸다 — 반쪽만 담으면 문항이 가리키는 지문이 조용히 사라진다. */
  const setOf = {};
  regions.forEach((g) => {
    const setId = 's-ss-' + scope + '-' + pad2(g.no);
    const marks = [];
    g.parts.forEach((p) => {
      const wid = workIds[p.title] || '';
      /* ㉠는 **세트 스코프**다 — 같은 시가 여러 세트에 실리는데 세트마다 다른 행을 가리킨다.
         작품 단위로 합치면 4단계(주석 복원)가 틀린 자리를 묻는다. 그래서 세트에 매단다.
         기호가 줄 끝에 오고 가리키는 구절이 다음 줄로 넘어가는 경우가 있어
         (실측 '내가 너희들에게 ㉠' + '힐링의 시간을…') 줄이 아니라 문단/행 단위에서 찾는다. */
      const units = p.prose ? p.paragraphs : p.lines;
      units.forEach((unit) => {
        (unit.match(MARK_SYM) || []).forEach((sym) => {
          /* 40자로 자르되 문장이 먼저 끝나면 거기서 끊는다 — 앞에서부터 자른 조각이라
             원문의 부분 문자열이 그대로 유지된다(work.marks 로 옮길 때 앵커가 살아 있어야 한다). */
          const tail = unit.slice(unit.indexOf(sym) + 1).trim();
          const stop = tail.search(/[.!?”’」]/);
          const after = (stop >= 0 && stop < 40 ? tail.slice(0, stop + 1) : tail.slice(0, 40)).trim();
          marks.push({ symbol: sym, workId: wid, title: p.title, anchorText: after, setId });
        });
      });
      candidates.push({ kind: 'setText', setId, label: p.label, title: p.title, author: p.author,
        kind2: p.prose ? 'excerpt' : 'full', page: p.page,
        preface: p.preface || null, body: p.prose ? p.paragraphs : p.lines });
    });
    const refs = g.parts.map((p) => {
      const ref = { label: p.label, workId: workIds[p.title] || '', kind: p.prose ? 'excerpt' : 'full' };
      /* 발췌 세트는 자기 본문을 가져야 한다 — 소설 전문은 자료에 없어 슬라이스할 수 없다.
         시는 이해완성 정본(work.text)으로 화면이 성립하므로 본문을 중복해 담지 않는다. */
      if (p.prose) ref.text = { paragraphs: p.paragraphs };
      if (p.preface) ref.prefaceSummary = p.preface;
      return ref;
    });
    setOf[g.no] = { marks };
    /* 세트를 못 내더라도 문항에는 **세트 번호를 달아 둔다.** 병합기가 폴더 전체를 보고
       세트를 살릴 수 있고(정본 없는 작품 세우기 등), 그때 이 번호가 있어야 문항이 이어진다.
       세트가 끝내 안 살아나면 병합기가 이 번호로 '지문 없는 문항'을 알아보고 팩에서 뺀다. */
    setOf[g.no].setId = setId;
    const missingText = refs.some((r) => r.kind === 'excerpt' && !(r.text.paragraphs || []).length);
    if (refs.length && refs.every((r) => r.workId) && !missingText) {
      const s = { setId, works: refs };
      if (marks.length) s.marks = marks.map((m) => ({ symbol: m.symbol, workId: m.workId, anchorText: m.anchorText }));
      sets.push(s);
      const uniq = refs.map((r) => r.workId).filter((v, i, a) => a.indexOf(v) === i);
      if (uniq.length === 1) setOf[g.no].workId = uniq[0];
    } else {
      pending.push({ kind: 'set', setId,
        why: g.parts.every((p) => !p.title)
          ? '제목·작가가 지면에 인쇄돼 있지 않다 — 추론하지 않았다. 검수에서 workId 를 정해 sets 로 옮긴다'
          : 'workId 를 못 찾은 작품이 있다 — --work "제목=workId" 로 넘기면 팩에 들어간다',
        works: g.parts.map((p) => ({ label: p.label, title: p.title, author: p.author,
          kind: p.prose ? 'excerpt' : 'full', workId: workIds[p.title] || null,
          prefaceSummary: p.preface || null,
          text: p.prose ? { paragraphs: p.paragraphs } : undefined,
          lines: p.prose ? undefined : p.lines })),
        marks });
    }
  });

  /* ── 문항 블록 ── */
  const blocks = [];
  let curSet = null;
  ps.forEach((row, i) => {
    if (row.setStart) { curSet = regions.filter((g) => g.at === i)[0] || curSet; return; }
    if (row.itemNo == null) return;
    let end = i + 1;
    while (end < ps.length && !isEvent(ps[end])) end += 1;
    blocks.push({ no: row.itemNo, set: curSet, page: row.page, col: row.col,
      rows: ps.slice(i, end).filter((r) => r.body.length) });
  });

  let gridMiss = 0, unlabeledBox = 0;
  function parseItem(b) {
    const rows = b.rows;
    /* 발문 = 발문 격자에 앉은 앞머리 줄들. 격자를 못 찾으면(다른 조판) 라벨 앞까지로 물러난다. */
    const stemRows = [];
    let i = 0;
    for (; i < rows.length; i += 1) {
      if (BOX_LABEL.test(rows[i].text.trim())) break;
      const dx = rows[i].dx;
      const band = stemRows.length ? STEM_DX_CONT : STEM_DX_FIRST;
      if (!(dx >= band[0] && dx <= band[1])) break;
      stemRows.push(rows[i]);
    }
    if (!stemRows.length) {
      gridMiss += 1;
      while (i < rows.length && !BOX_LABEL.test(rows[i].text.trim())) { stemRows.push(rows[i]); i += 1; }
    }
    /* 남은 줄을 박스로 나눈다. 라벨 없이 시작하는 상자가 하나 있다(문항 17의 '선생님:' 설명) —
       발문 격자에서 벗어난 순간 상자가 시작된 것으로 보고 라벨 없는 상자로 담는다. */
    const boxes = [];
    let cur = null;
    for (; i < rows.length; i += 1) {
      const t = rows[i].text.trim();
      const lab = t.match(BOX_LABEL);
      if (lab) { cur = { label: lab[1], rows: [] }; boxes.push(cur); continue; }
      if (!cur) { cur = { label: '', rows: [] }; boxes.push(cur); unlabeledBox += 1; }
      cur.rows.push(rows[i]);
    }
    return { stem: joinRows(stemRows), boxes };
  }

  /* ── 정답·해설 ──
     해설 블록은 'N)' 단독 줄로 시작하고 단·쪽을 넘어 흐른다. 블록 안은 청록 라벨로 나뉜다. */
  const ss = readStream(solutionPages, sizes);
  const entryAt = {};
  solutionPages.forEach((page) => {
    U.splitColumns(page).forEach((lines, ci) => {
      U.solutionEntries(lines).forEach((e) => { entryAt[page.no + (ci ? 'R' : 'L') + ':' + e.y] = e.no; });
    });
  });
  ss.forEach((r) => {
    const lab = r.spans.filter((s) => s.color === LABEL_COLOR && s.size === LABEL_SIZE);
    /* '모범 답안 check list ' 는 끝 공백까지 한 덩어리다. startsWith 로 가르면 25개여야 할
       모범답안이 31개가 된다 — 정확히 일치로 갈라야 한다. */
    r.label = lab.length ? U.joinSpans(lab).trim() : null;
    r.hasTable = r.spans.some((s) => s.size === 7.4);
  });
  const solutions = {};
  const solOrder = [];
  ss.forEach((row, i) => {
    const no = entryAt[row.page + row.col + ':' + row.y];
    if (no == null) return;
    let end = i + 1;
    while (end < ss.length && entryAt[ss[end].page + ss[end].col + ':' + ss[end].y] == null) end += 1;
    const secs = [];
    let cur = null;
    ss.slice(i, end).forEach((r) => {
      if (r.label) { cur = { label: r.label, rows: [], raw: [] }; secs.push(cur); return; }
      if (!cur) return;                                     // 'N)' 마커 줄
      cur.raw.push(U.joinSpans(r.spans));
      if (r.hasTable || !r.text) return;                    // '개념 plus+' 표는 셀이 여러 기둥으로 흩어진다
      cur.rows.push(r);
    });
    const pick = (name) => secs.filter((s) => s.label === name).map((s) => joinRows(s.rows));
    solOrder.push(no);
    solutions[no] = {
      labels: secs.map((s) => s.label),
      answer: pick(L_ANSWER)[0] || '',
      keywords: pick(L_KEYWORD)[0] || '',
      checklist: pick(L_CHECK)[0] || '',
      tip: pick(L_TIP)[0] || '',
      explain: L_EXPLAIN.reduce((a, n) => a || pick(n)[0] || '', ''),
      concept: secs.filter((s) => s.label === L_CONCEPT).map((s) => U.stripChrome(s.raw.join(' '))),
    };
  });

  /* ── 문항 → 팩 ── */
  let condBoxes = 0, condCount = 0, condAuto = 0, condManual = 0, bogiCount = 0, srcCount = 0;
  let negCount = 0, slashAnswers = 0;
  const zbMismatch = [], missingSol = [], selfFail = [];
  const kindTally = {};

  blocks.forEach((b) => {
    const parsed = parseItem(b);
    const sol = solutions[b.no] || null;
    if (!sol) missingSol.push(b.no);
    const zbId = zbById[b.no] || '';
    if (zbId && zbId !== 'zb' + b.no + ')') zbMismatch.push(b.no + '↔' + zbId);

    const plainStem = U.stripItemIds(parsed.stem);      // 지면에 안 보이는 글자다 — 남으면 화면에 뜬다
    const isNegative = NEGATIVE.test(plainStem);
    if (isNegative) negCount += 1;
    /* stem 만 innerHTML 이다 — 자료의 '<보기>'를 안 막으면 화면에서 통째로 사라진다.
       나머지 필드는 앱이 esc() 하므로 평문이어야 한다(이 비대칭이 함정이다). */
    let stem = U.escapeStem(plainStem);
    if (isNegative) stem = stem.replace(NEGATIVE, (s) => s.replace(/(않은|아닌)/, '<b>$1</b>'));

    /* <보기> 상자 · <조건> 상자 */
    let bogi = null;
    /* 조건은 바로 팩 모양으로 굳히지 않는다 — 아래 '자기 검산'에서 사람 확인으로 내릴 수 있게
       원문 조각(src)과 자동 판정 여부(auto)를 함께 들고 있는다. */
    const condObjs = [];
    parsed.boxes.forEach((box) => {
      if (box.label === '조건') {
        condBoxes += 1;
        /* 새 조건은 마커(1. / 2) / -)로 시작하는 줄이다. 마커가 없으면 상자 전체가 조건 1개다
           — 조건 1개가 두 줄로 흐르는 상자가 있어(들여쓰기 +13.2 → +5.3) 좌표로 가르면 쪼개진다. */
        const chunks = [];
        box.rows.forEach((r) => {
          if (!chunks.length || BULLET.test(r.text.trim())) chunks.push([]);
          chunks[chunks.length - 1].push(r);
        });
        chunks.forEach((rows) => {
          const c = classifyCondition(joinRows(rows));
          if (!c.text) return;
          condCount += 1;
          if (c.kinds.length) {
            /* 한 조건이 두 종류를 겸하기도 한다 — 실측 '…와 같이 완결된 하나의 문장으로 쓸 것'은
               form 이면서 sentences 다. 조건 객체를 둘로 내되 문구(text)는 같은 것을 쓴다. */
            c.kinds.forEach((k) => condObjs.push({
              obj: { kind: k.kind, value: k.value, text: c.text }, src: c, auto: true }));
          } else {
            /* 자동 판정을 포기하되 조건 문구는 학생에게 그대로 보여 준다 —
               quote 는 checkConditions 가 '사람 확인'으로 두고 절대 오답을 내지 않는다.
               지워 버리면 학생이 무엇을 지켜야 하는지 화면에서 못 본다(drawEssay 가 text 를 그린다). */
            condObjs.push({ obj: { kind: 'quote', value: c.text, text: c.text }, src: c, auto: false });
          }
        });
      } else {
        const rows = box.rows.slice();
        let source = '';
        const last = rows[rows.length - 1];
        if (last && last.dx >= SOURCE_DX && /^[-–—―]/.test(last.text.trim())) {
          source = U.stripChrome(last.text).replace(/^[-–—―]\s*/, '');
          srcCount += 1;
          rows.pop();
        }
        const text = joinBox(rows, geo.width);
        if (!text) return;
        bogiCount += 1;
        bogi = { kind: 'text', text };
        if (source) bogi.sourceWork = source;
        if (!box.label) {
          candidates.push({ kind: 'unlabeledBox', no: b.no, text,
            why: '<보기>/<조건> 라벨 없이 실린 인용 상자다 — 발문에 붙일지 보기로 둘지 사람이 정한다' });
        }
      }
    });
    const conditions = condObjs.map((x) => x.obj);

    /* 모범 답안 — 답이 둘이면 ' / '로 병기한다(실측 1건). 그 표기는 grade.parseAccepted 의
       분리 규칙과 그대로 맞으므로 쪼개도 정보가 늘지 줄지 않는다. */
    const rawAnswer = sol ? sol.answer : '';
    const modelAnswers = rawAnswer ? rawAnswer.split(/\s+\/\s+/).map((t) => t.trim()).filter(Boolean) : [];
    if (modelAnswers.length > 1) slashAnswers += 1;
    const answerChecks = sol && sol.checklist
      ? sol.checklist.split('□').map((t) => U.stripChrome(t)).filter(Boolean) : [];
    /* 루브릭 — 자료가 주는 것은 '핵심 단어' 낱말 나열뿐이다. 쉼표로 잘라 **요소 하나씩** 낸다.
       한 요소에 다 몰아넣으면 낱말 하나만 써도 만점이 되어 '오통과'가 나는데,
       요소를 나누면 최악이 hold(사람이 본다)라 되돌릴 수 있다. 묶기는 사람 몫이다. */
    const rubric = sol && sol.keywords
      ? sol.keywords.split(/\s*,\s*/).map((w) => w.trim()).filter(Boolean)
        .map((w) => ({ element: w, keywords: [w], points: null, source: 'material' }))
      : [];

    /* ── 자기 검산 게이트 ──
       자료의 모범답안을 자기 조건에 걸어 본다. **자기 모범답안이 자기 조건에서 떨어지면
       그 조건은 뽑기가 틀렸거나 자료가 어긋난 것**이다(실측 1건: 조건은 '인간은 ~'인데
       모범답안은 '사람들은 ~'이다). checkConditions 의 fail 은 즉시 학생 화면에
       '조건을 지키지 않았어요'로 되돌려지므로, 확신이 없으면 자동 판정을 끄는 편이 안전하다. */
    if (modelAnswers.length) {
      G.checkConditions(modelAnswers[0], conditions).forEach((r, i) => {
        if (r.pass || r.manual || !condObjs[i].auto) return;
        const c = condObjs[i];
        selfFail.push(b.no + '(' + c.obj.kind + ')');
        c.auto = false;
        c.demoted = c.obj.kind;
        c.obj = { kind: 'quote', value: c.obj.text, text: c.obj.text };
        conditions[i] = c.obj;
      });
    }
    /* 조건 집계는 게이트를 지난 뒤에 한다. 원문 조건 하나가 kind 둘로 나뉘므로
       '자동/사람 확인'은 조건 객체가 아니라 **원문 조각(src)** 단위로 센다. */
    const seen = [];
    condObjs.forEach((x) => {
      kindTally[x.auto ? x.obj.kind : 'quote_manual'] = (kindTally[x.auto ? x.obj.kind : 'quote_manual'] || 0) + 1;
      if (!x.auto) {
        pending.push({ kind: 'condition', no: b.no, text: x.obj.text,
          why: x.demoted
            ? `${x.demoted} 로 뽑았지만 자료의 모범답안이 이 조건에서 떨어진다 — 조건과 모범답안이 어긋난다`
            : x.src.why.join(' / '),
          hint: '자동 판정을 켜려면 kind 를 include/sentences/chars/words/form 중 하나로 고치고 value 를 다듬는다' });
      }
      if (seen.indexOf(x.src) < 0) seen.push(x.src);
    });
    seen.forEach((c) => {
      if (condObjs.some((x) => x.src === c && x.auto)) condAuto += 1; else condManual += 1;
    });

    const src = { series: '서술형 공략', section, no: b.no };
    if (zbId) src.zbId = zbId;
    const ref = b.set ? setOf[b.set.no] : null;

    const draft = {
      id: U.itemId('seosul', scope, b.no),
      format: 'essay',
      source: src,
      stem,
      isNegative,
      conditions,
      rubric,
      modelAnswers,
      /* 배점은 지면에 0건이다 — totalPoints 를 지어내면 요소 배점 합과 어긋나 배포가 막힌다. */
      targetRefs: [],
    };
    if (ref && ref.setId) draft.setId = ref.setId;
    if (ref && ref.workId) draft.workId = ref.workId;
    if (bogi) draft.bogi = bogi;
    if (answerChecks.length) draft.answerChecks = answerChecks;
    if (sol && sol.tip) draft.tip = sol.tip;
    if (sol && sol.explain) draft.explanation = { main: sol.explain };

    if (sol && sol.concept.length) {
      candidates.push({ kind: 'concept', no: b.no, rows: sol.concept,
        why: "'개념 plus+' 표는 셀이 여러 기둥으로 흩어져 줄 단위로 이으면 뒤섞인다 — 사람이 옮기거나 버린다" });
    }

    /* rubric 없는 essay 는 경고가 아니라 **오류**라 팩 전체 배포가 막힌다.
       루브릭을 저작한 뒤 items 로 옮기는 순서를 여기서 강제한다. */
    if (!rubric.length) {
      pending.push({ kind: 'item', no: b.no, reason: 'no-rubric',
        why: "'핵심 단어'가 없어 채점 요소를 자료에서 만들 수 없다 — 루브릭을 저작한 뒤 items 로 옮긴다",
        item: draft });
      return;
    }

    /* ── 루브릭 자기 검산 ──
       조건에 건 것과 같은 검산을 루브릭에도 건다. '핵심 단어'를 쉼표로 자른 요소는 AND 로 채점되는데,
       발문이 '한 가지만 쓰시오'이고 모범답안이 여러 갈래인 문항은 요소가 답들에 흩어져 있어서
       **자료의 모범답안조차 만점을 못 받는다.** 그런 문항은 학생이 무엇을 써도 영영 hold 라
       그 작품의 5단계가 끝나지 않는다(index.html 은 verdict==='pass' 일 때만 승급시킨다).
       모범답안 중 하나라도 통과하지 못하면 팩에 내지 않고 검수로 넘긴다. */
    const models = (draft.modelAnswers || []).filter(Boolean);
    if (models.length) {
      let best = null;
      models.forEach((mAns) => {
        const v = G.gradeRubric(mAns, draft);
        if (!best || (v && v.verdict === 'pass')) best = v;
      });
      if (!best || best.verdict !== 'pass') {
        pending.push({ kind: 'item', no: b.no, reason: 'rubric-selfcheck',
          why: '자료의 모범답안조차 이 루브릭에서 통과하지 못한다' +
            (models.length > 1 ? ' — 모범답안이 여러 갈래인 대체 정답형이라 요소를 AND 가 아니라 한 요소의 keywords 로 묶어야 한다' : '') +
            '. 이대로 내면 학생이 무엇을 써도 영영 보류가 된다',
          rubricCheck: best || null, item: draft });
        return;
      }
    }
    items.push(draft);
  });

  /* ── 작품 패치 ──
     완전한 Work 를 내지 않는다. 같은 workId 로 Work 를 두 번 내면 '작품 id 중복'으로 배포가 막힌다.
     이 자료가 갖고 있는 것은 **작가명**이다(4종 중 단원집중과 여기에만 인쇄돼 있다).
     ㉠ 기호는 세트마다 가리키는 곳이 달라 work 가 아니라 sets[].marks 로 냈다. */
  const byTitle = {};
  regions.forEach((g) => {
    g.parts.forEach((p) => {
      if (!p.title) return;
      const t = byTitle[p.title] || (byTitle[p.title] = { workKey: p.title, title: p.title, author: '', instances: 0 });
      t.instances += 1;
      if (!t.author && p.author) t.author = p.author;
    });
  });
  Object.keys(byTitle).forEach((k) => {
    const p = byTitle[k];
    const patch = { workKey: p.workKey, title: p.title };
    if (p.author) patch.author = p.author;
    patch.source = { series: '서술형 공략', section, instances: p.instances };
    patches.push(patch);
  });

  /* ── 검산 보고 ── */
  meta.series = '서술형 공략';
  meta.unitPath = opts.unitPath || (meta.unit ? meta.unit + (meta.subUnit ? ' > ' + meta.subUnit : '') : '');
  /* 제작 표시는 판권 띠(y>=770)라 본문 스트림에 안 들어온다 — 라이선스 회신본 보관(§10)의
     출처 근거라 여기서 따로 읽어 meta 로만 내보낸다(학생 화면에는 안 쓴다). */
  pages.forEach((p) => p.lines.forEach((l) => {
    const t = U.joinSpans(l.spans);
    const d = t.match(/제작연월일\s*:\s*(\d{4}-\d{2}-\d{2})/);
    if (d && !meta.producedAt) meta.producedAt = d[1];
    const m = t.match(/제작자\s*:\s*(\S+)/);
    if (m && !meta.producer) meta.producer = m[1];
  }));

  const solCount = solOrder.length;
  const proseSets = regions.filter((g) => g.parts.some((p) => p.prose)).length;
  report.push(`쪽 ${pages.length} (문항쪽 ${problemPages.length} · 해설쪽 ${solutionPages.length})`);
  report.push(`검산 — 문항번호 ${blocks.length} · zb id ${zbCount} · 해설 블록 ${solCount}` +
    (blocks.length === zbCount && zbCount === solCount ? ' (일치)' : ' ← 셋이 같아야 한다'));
  report.push(`교과서 좌표 — ${meta.publisher || '?'}(${meta.publisherAuthor || '?'}) ` +
    `${meta.grade || '?'}-${meta.semester || '?'} · ${meta.unit || '?'}.${meta.unitTitle || ''}` +
    (meta.producedAt ? ` · 제작 ${meta.producedAt} ${meta.producer || ''}` : ''));
  report.push(`지문 세트 ${regions.length} (산문 ${proseSets} · 팩에 낸 것 ${sets.length} · 검수 대기 ${regions.length - sets.length})` +
    ` · 앞부분 줄거리 ${regions.filter((g) => g.parts.some((p) => p.preface)).length}` +
    ` · ㉠ 앵커 ${Object.keys(setOf).reduce((a, k) => a + setOf[k].marks.length, 0)}`);
  const noRubric = pending.filter((p) => p.kind === 'item' && p.reason === 'no-rubric').length;
  const selfFailRubric = pending.filter((p) => p.kind === 'item' && p.reason === 'rubric-selfcheck').length;
  report.push(`문항 ${blocks.length} = 팩에 낸 것 ${items.length}(items) + 검수로 내린 것 ` +
    `${noRubric + selfFailRubric}(review.pending: 루브릭 미저작 ${noRubric} · 모범답안이 자기 루브릭에서 떨어짐 ${selfFailRubric})`);
  report.push(`모범 답안 ${blocks.length - missingSol.length}` +
    (slashAnswers ? ` (복수 정답 ' / ' 병기 ${slashAnswers})` : '') +
    ` · 채점 요소(핵심 단어) ${items.length} · 모범답안 check list ${blocks.filter((b) => (solutions[b.no] || {}).checklist).length}` +
    ` · Tip ${blocks.filter((b) => (solutions[b.no] || {}).tip).length}` +
    ` · 해설 ${blocks.filter((b) => (solutions[b.no] || {}).explain).length}` +
    ` (${L_EXPLAIN.map((n) => n + ' ' + blocks.filter((b) => ((solutions[b.no] || {}).labels || []).indexOf(n) >= 0).length).join(' + ')})`);
  report.push(`<조건> 상자 ${condBoxes} → 개별 조건 ${condCount} (자동 판정 ${condAuto} · 사람 확인 ${condManual})` +
    ` · kind ${JSON.stringify(kindTally)}`);
  report.push(`<보기> 상자 ${bogiCount}(출처 표기 ${srcCount} · 라벨 없는 상자 ${unlabeledBox}) · 부정발문 ${negCount}`);
  report.push(`자기 검산 — 자료의 모범답안이 자기 조건에서 떨어져 사람 확인으로 내린 조건 ${selfFail.length}` +
    (selfFail.length ? ': 문항 ' + selfFail.join(' ') : ' (없음)'));

  if (blocks.length !== zbCount || zbCount !== solCount) {
    todo.push(`검산 불일치 — 문항 ${blocks.length} · zb ${zbCount} · 해설 ${solCount}. 뽑기가 샌 것이니 지면과 대조할 것`);
  }
  if (missingSol.length) todo.push(`모범 답안을 못 찾은 문항: ${missingSol.join(',')}`);
  if (zbMismatch.length) todo.push(`zb 번호가 지면 문항 번호와 다르다: ${zbMismatch.join(' ')} — source.no 를 확인할 것`);
  if (gridMiss) todo.push(`발문 격자(+25.9/+16.8)에 안 맞는 문항 ${gridMiss}개 — 라벨 앞까지로 물러나 잘랐다. 발문 끝을 확인할 것`);
  if (selfFail.length) {
    todo.push(`자료의 모범답안이 자기 조건에서 떨어졌다: 문항 ${selfFail.join(' ')} —` +
      ' 자동 판정을 끄고(quote) pending 에 올렸다. 조건 문구와 모범답안 중 어느 쪽이 맞는지 지면과 대조할 것');
  }
  if (unlabeledBox) {
    todo.push(`라벨 없는 인용 상자 ${unlabeledBox}개를 <보기>로 담았다 — 발문에 붙일지 보기로 둘지 사람이 정한다(candidates 확인)`);
  }
  todo.push('rubric 요소는 핵심 단어를 쉼표로 자른 것이다 — 같은 요소의 이표기(예 \'촉각적 심상(이미지)\')를' +
    ' 한 요소로 묶는 것은 사람이 한다. 지금은 과엄격 쪽(hold)이라 오통과는 안 나지만 만점 기준이 실제보다 높다');
  todo.push('배점(totalPoints)은 자료에 표기가 0건이라 넣지 않았다 — 요소 배점(points)이 null 이면 검증기가 1로 센다');
  todo.push('사람 확인으로 내린 조건은 kind:\'quote\' 로 나가 자동 판정을 하지 않는다 —' +
    ' review.pending 의 condition 항목을 보고 kind/value 를 확정할 것');
  todo.push('chars(글자 수)·words(어절 수) 조건은 이 자료에 0건이라 규칙을 굳히지 않았다 —' +
    ' 다른 단원에서 나오면 사람 확인(quote)으로 내려가니 pending 에서 확인할 것');
  todo.push('targetRefs 는 전부 빈 배열이다 — 자료에 문항↔개념 단위 대응이 없다. 검수에서 사람이 잇는다');
  todo.push('patches 는 조각이다 — 같은 workId 로 Work 를 두 번 내면 배포가 막힌다. 이해완성이 만든 works/*.json 에 합칠 것');
  todo.push('㉠ 기호는 sets[].marks 로만 냈다 — 세트마다 가리키는 구절이 달라 work.marks 하나로는 못 담는다.' +
    ' 앱(poemHtml)은 work.marks 만 그리므로 어느 세트의 기호를 정본으로 삼을지 사람이 정한다');
  todo.push('앞부분 줄거리는 앵커 다음 **한 문단**으로 잘랐다(실측 4/4 일치) — 두 문단짜리 자료가 오면 깨진다');
  todo.push('essay 의 explanation 은 지금 학생 화면(drawEssay)이 그리지 않는다 — 다듬는 데 검수 시간을 쓰지 말 것');

  return { series: 'seosul', patches, sets, items,
    review: { report, todo, candidates, pending }, meta };
}

/* ── CLI ── (import 될 때는 안 돈다) */
const invokedDirectly = process.argv[1] && /build-seosul\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  const fs = await import('node:fs');
  const argv = process.argv.slice(2);
  /* --work 는 여러 번 올 수 있어 indexOf 로는 못 가른다(첫 번째만 찾는다). 앞에서부터 한 번 훑는다. */
  const VALUED = ['scope', 'section', 'review', 'work', 'unitPath'];
  const files = [], opts = {}, works = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (VALUED.indexOf(name) >= 0 && argv[i + 1] != null && !argv[i + 1].startsWith('--')) {
        if (name === 'work') works.push(argv[i + 1]); else opts[name] = argv[i + 1];
        i += 1;
      }
      continue;
    }
    files.push(a);
  }
  const file = files[0];
  const opt = (name) => opts[name];
  if (!file) {
    console.error('사용법: node naesin-ko/extract/build-seosul.mjs <spans.json> [--scope u1]' +
      ' [--work "제목=workId"]... [--section 소제목] [--review review/seosul-u1.json]');
    process.exit(1);
  }
  const workIds = {};
  works.forEach((pair) => {
    const eq = pair.indexOf('=');
    if (eq > 0) workIds[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  });

  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const det = U.detectSeries(doc);
  if (det.series && det.series !== 'seosul') {
    console.error(`이 파일은 서술형 공략이 아니라 '${U.SERIES_LABEL[det.series]}' 입니다 — 맞는 추출기를 쓰세요.`);
    process.exit(2);
  }
  const out = buildSeosul(doc, { scope: opt('scope'), section: opt('section'),
    unitPath: opt('unitPath'), workIds });

  /* 검수 부속물은 **팩과 다른 파일**로 나간다. 같은 파일에 넣으면 assemble 이 팩 루트로 복사하고
     관리 웹이 그대로 POST 해 학생 기기까지 간다(실측 팩의 16%가 그것이었다). */
  const reviewPath = opt('review');
  if (reviewPath) {
    fs.mkdirSync(reviewPath.replace(/\/[^/]*$/, '') || '.', { recursive: true });
    fs.writeFileSync(reviewPath, JSON.stringify({ series: out.series, meta: out.meta,
      patches: out.patches, ...out.review }, null, 1));
  }

  process.stderr.write('\n[서술형 공략 초안]\n' + out.review.report.map((r) => '  ' + r).join('\n') +
    '\n\n[검수에서 할 일]\n' + out.review.todo.map((t) => '  · ' + t).join('\n') +
    (reviewPath
      ? `\n\n패치 ${out.patches.length} · 후보 ${out.review.candidates.length} · 대기 ${out.review.pending.length} → ${reviewPath}\n\n`
      : `\n\n패치·후보·대기 ${out.patches.length + out.review.candidates.length + out.review.pending.length}건은 버렸습니다 — 남기려면 --review <경로> 를 주세요.\n\n`));

  /* stdout 은 팩에 그대로 들어갈 수 있는 모양이어야 한다 — sets·items 뿐이다. */
  console.log(JSON.stringify({ sets: out.sets, items: out.items }, null, 1));
}
