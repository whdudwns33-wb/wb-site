#!/usr/bin/env node
/* WB 국어브레인 — 직전 요약노트 spans → 작품 조각(patch) (추출 파이프라인 2단계)
 *
 *   python3 naesin-ko/extract/pdf-spans.py <요약노트.pdf> > spans.json
 *   node naesin-ko/extract/build-yoyak.mjs spans.json \
 *        --workIds '1-1.(1)저녁 항구=w-jeonyeok;1-1.(2)비린내라뇨!=w-birinnae' \
 *        --review review/yoyak.json > patch-yoyak.json
 *
 * 절차 전체는 naesin-ko/extract/README.md 를 본다. 공용 규칙은 spans-util.mjs 에 있다.
 *
 * **stdout 은 팩 파일이 아니라 병합기(build-pack.mjs) 입력이다.** 팩 디렉터리에 넣으면
 * assemble() 이 모르는 최상위 키(patches)를 팩 루트로 그대로 복사해 학생 기기까지 배달한다.
 *
 * 뽑는 것 (§8 Work 의 조각): vocab / checklist / examPoints / blanks / check(개관·구성)
 *   완전한 Work 를 내지 않는다 — 같은 작품의 정본은 이해완성이 낸다. 같은 workId 로 Work 를
 *   두 번 내면 '작품 id 중복'으로 배포가 막힌다. 그래서 **덧붙일 조각(patch)** 만 낸다.
 *   조인 키는 머리말 좌표 문자열(workKey, 예 '1-1.(2)비린내라뇨!') — 4종 자료에 공통이다.
 *
 * 빈칸을 어떻게 아나 (이해완성과 다르다):
 *   이 자료는 **짝 지면(학생용/선생님용)이 없다.** 6쪽은 작품 2편이 나란히 실린 것이라
 *   U.pairHalves 를 쓰면 뒤 작품을 '선생님용'으로 착각해 통째로 버린다(조용한 손실이다).
 *   대신 **좌우 거울**이다: 왼쪽 기둥 = 정답이 채워진 핵심 요약, 오른쪽 기둥 = 같은 내용인데
 *   정답만 흰 글씨(dx = +252.0). 그래서 오른쪽 기둥의 흰 글씨가 곧 정답이고,
 *   왼쪽 기둥은 답 출처가 아니라 **검증 출처**다 — 단위(표 행·단락)마다 문자열 유사도
 *   게이트를 걸고, 미달한 단위는 좌·우 문장을 그대로 검수로 넘긴다.
 *   흰 글씨 중 size 7.4 '빈 칸 채우기로 바로 확인' 배너는 정답이 아니다(makeDecoy 가 거른다).
 *
 * 뽑지 '않는' 것 (검수에서 사람이 붙인다):
 *   keywords(시어 상징 표)·rhetoric·speaker 는 candidates 로만 모은다. 표 구조가 작품마다
 *   다르고, 자동 배정하면 3단계 구절 적용 문항이 엉뚱한 근거로 만들어진다.
 *   items·sets 는 이 시리즈에 아예 없다 — 인쇄된 문항이 없고 zb 고유번호도 0건이다.
 */
import * as U from './spans-util.mjs';

/* ── 실측 상수 ──
   전부 천재(노미숙) 중2-1 1단원 '직전 요약노트' 6쪽에서 재었다. 새 출판사 자료가 오면
   pdf-spans.py --colors 로 색 분포부터 다시 본다(extract/README.md §1). */

/* 기둥 경계. 좌 글자 오른끝 최대 282.4 / 우 최소 316.8 — 여유 각 17.6pt.
   build-ihae 의 width*0.60(=357.1)을 쓰면 오른쪽 기둥의 절머리·라벨셀(321~366)이
   통째로 왼쪽으로 분류돼 정답 문맥이 깨진다. */
const COL_AT = 300;
/* 머리말 39.6 · 안내 배너 66.3 · 본문 첫 줄 79.9 → 그 사이에서 자른다.
   배너는 한 문장이 좌우로 갈라져 있어 남기면 좌우 대조 유사도가 0.957까지 떨어진다. */
const TOP = 75;
/* 기둥 왼끝 + 오프셋으로 셀 경계를 잡는다(조판이 밀려도 살아남게).
   실측 좌: 왼끝 64.6 · 라벨 오른끝 최대 107.5 · 값셀 왼끝 115.9
        우: 왼끝 316.8 · 라벨 오른끝 최대 356.6 · 값셀 왼끝 368.4 */
const VALUE_OFF = 50;
/* 값셀 오른끝(좌 282.4 / 우 534.7) 언저리 — 여기서 끊긴 흰 글씨는 다음 줄로 이어진다.
   실측 2건: '사'(오른끝 527.7)+'랑', '상'(527.7)+'처'. 반례 '사랑'(531.3)은 다음 줄 첫
   글자가 검정이라 이어 붙이면 안 된다 → 오른끝만으로 판정하지 않는다. */
const WRAP_OFF = 208;
/* 인용 시구 박스 줄. 첫 span 이 기둥 왼끝 +4.3 에 오고 값셀을 가로질러 뻗는다
   (실측 7개 박스 14줄 전부, 좌우 모두). 들여쓰기 두 칸으로 알아보려 했더니 p3 의
   한 박스만 그 공백이 없어 x 로 잡는다 — 다만 +6.9 에 오는 표 라벨('시적 화자')과
   1.7pt 차이라 x 하나로는 위험하다. 그래서 '값셀을 가로지른다'를 함께 본다:
   표 라벨은 값셀 앞에서 끝나고, 이어지는 문단 줄은 +10.0 이상에서 시작한다. */
const QUOTE_OFF = 8;
/* 라벨 두 줄('화자의'+'태도') 잇기 문턱. 실측 이어지는 라벨 줄 간격 12.0~12.5 /
   다른 행 라벨 사이 최소 간격 15.6 — 셀 안쪽 줄 간격과 셀 패딩의 차이라서 갈린다. */
const LABEL_GAP = 14;
const DECO_SIZE = 7.4;        // 흰 장식 라벨 '빈 칸 채우기로 바로 확인' (10개 = 절 10개)
const GOLD = '#e9ae2b';       // ★ 출제 Point 별표
const HEAD_RED = '#bf0000';   // 체크리스트 쪽 절 제목
const POS_BLUE = '#215ab9';   // 어휘 품사 '명'
/* 좌우 대조 게이트. 완전 일치를 요구하면 원문 오탈자(실측 p3 1자)로 떨어진다. */
const MIRROR_GATE = 0.99;

const OVERVIEW_KEYS = ['갈래', '제재', '성격', '주제', '특징'];
const HEADER_RE = /^(출제\s*Point\s*[①-⑳]?|[가-힣]{2,6})$/;
const POINT_RE = /^출제\s*Point\s*([①-⑳])/;
/* 머리말 두 벌 — 체크리스트 쪽과 요약 쪽의 형식·크기·y가 서로 다르다(§fields) */
const KEY_COVER = /^(\d+-\d+)\.\((\d+)\)(.+)$/;
const KEY_SUMMARY = /^\[직전\s*요약노트\]\s*(\d+-\d+)\.\((\d+)\)(.+)$/;

/* ── 작은 도구 ── */
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const spanEnd = (s) => s.x + (s.w || 0);

/* 지면에서 안 보이지만 정답인 글자 — decoy 를 통과한 옅은 색 span */
function isAnswerSpan(s, decoy, y, lineText) {
  return U.isPale(s) && (s.text || '').trim() && !decoy(s, y, lineText);
}

/* ── 쪽 머리말에서 작품 키 뽑기 ──
   **쪽 순서로 묶으면 안 된다.** 한 파일에 작품 2편이 들어 있고 재편집 때 쪽이 밀린다.
   workKey('1-1.(2)비린내라뇨!')가 4종 자료를 잇는 유일한 조인 키다(§linkRule). */
function workKeyOf(page) {
  for (const line of page.lines) {
    if (line.y >= U.MAST_BAND) continue;
    const t = norm(U.joinSpans(line.spans));
    const m = KEY_SUMMARY.exec(t) || KEY_COVER.exec(t);
    if (m) return { key: m[1] + '.(' + m[2] + ')' + m[3].trim(), title: m[3].trim() };
  }
  return null;
}

/* 쪽 역할. 체크리스트 쪽은 1단이라 기둥 분리를 적용하면 안 된다(정의문이 x=502까지 뻗는다). */
function pageRole(page) {
  let deco = 0, headRed = 0;
  for (const l of page.lines) {
    for (const s of l.spans) {
      if (U.isPale(s) && s.size === DECO_SIZE) deco += 1;
      if (s.color === HEAD_RED) headRed += 1;
    }
  }
  if (deco) return 'summary';
  if (headRed) return 'checklist';
  return 'unknown';
}

/* ── 체크리스트 쪽 (1단) ──
   파이널 체크리스트: x=73.0 그룹 질문 / x=56.6 '☐ …' 하위 항목.
   어휘 체크리스트: '☐ 표제어' + 품사(#215ab9) + 뜻풀이.
   **뜻풀이는 세로 가운데 정렬이라 y 오름차순으로 순진하게 읽으면 앞 어휘에 붙는다** —
   실측 p1: y=555.9 뜻풀이 → y=563.1 '☐ 은유' → y=570.3 이어지는 뜻풀이.
   그래서 한 어휘 블록을 [표제어 y − 8, 다음 표제어 y − 8) 반개구간으로 자른다. */
function readChecklistPage(page, patch, review) {
  let finalY = null, vocabY = null;
  for (const l of page.lines) {
    for (const s of l.spans) {
      if (s.color !== HEAD_RED) continue;
      if (/파이널/.test(s.text)) finalY = l.y;
      else if (/어휘/.test(s.text)) vocabY = l.y;
    }
  }
  if (finalY == null || vocabY == null) {
    review.pending.push({ page: page.no, why: '체크리스트 쪽의 절 제목(#bf0000)을 못 찾았다' });
    return;
  }

  /* 파이널 체크리스트 — 항목은 직전 그룹 질문에 붙는다 */
  let group = null;
  page.lines.forEach((l) => {
    if (l.y <= finalY || l.y >= vocabY) return;
    const t = U.stripChrome(U.joinSpans(l.spans));
    if (!t || U.isChromeLine(t)) return;
    if (l.spans.every((s) => s.color !== '#000000')) return;   // #d90909 안내문은 장식이라 버린다
    if (/☐/.test(t)) {
      if (!group) { review.pending.push({ page: page.no, why: '그룹 질문 없이 체크 항목이 먼저 나왔다: ' + t }); return; }
      group.items.push(t.replace(/^\s*☐\s*/, ''));
    } else {
      group = { question: t, items: [] };
      patch.checklist.push(group);
    }
  });

  /* 어휘 체크리스트 */
  const terms = [], defs = [];
  page.lines.forEach((l) => {
    if (l.y <= vocabY || l.y >= U.FOOT_BAND) return;
    l.spans.forEach((s) => {
      const t = norm(s.text);
      if (!t) return;
      if (s.color === POS_BLUE) { defs.push({ y: l.y, kind: 'pos', text: t }); return; }
      if (s.color !== '#000000') return;                      // #d90909 안내문
      const m = /^☐\s*(\S+)$/.exec(t);                        // 표제어 span 은 '☐ 은유' 하나뿐이다
      if (m) terms.push({ y: l.y, term: m[1] });
      else defs.push({ y: l.y, kind: 'def', text: t });
    });
  });
  terms.sort((a, b) => a.y - b.y);
  terms.forEach((t, i) => {
    const from = t.y - 8, to = i + 1 < terms.length ? terms[i + 1].y - 8 : Infinity;
    const mine = defs.filter((d) => d.y >= from && d.y < to);
    patch.vocab.push({
      localNo: patch.vocab.length + 1,
      term: t.term,
      pos: mine.filter((d) => d.kind === 'pos').map((d) => d.text).join(''),
      definition: norm(mine.filter((d) => d.kind === 'def').map((d) => d.text).join('')),
      page: page.no,
    });
  });
}

/* ── 요약 쪽: 줄 갈래 ──
   기둥 왼끝에 붙은 마커(・ ⇨ (N) ★ 인용)는 표 **밖** 단락이고, 값셀 안의 '・'는 표 행
   안쪽이다(실측 p6 시어 표). 그래서 마커는 x 로 한 번 더 거른다. */
function classify(line, geom) {
  const raw = U.joinSpans(line.spans);
  const t = raw.trim();
  const first = line.spans[0];
  const margin = first.x < geom.valueX;
  const labels = [], values = [];
  let straddle = 0;
  line.spans.forEach((s) => {
    if (s.x >= geom.valueX) values.push(s);
    else if (spanEnd(s) <= geom.valueX) labels.push(s);
    else straddle += 1;      // 라벨셀에서 시작해 값셀을 넘는 span = 전폭 단락 줄
  });
  let kind = 'cont';
  if (margin && line.spans.some((s) => s.color === GOLD)) kind = 'star';
  else if (margin && /^\(\d+\)/.test(t)) kind = 'subtitle';
  else if (margin && /^⇨/.test(t)) kind = 'para';
  else if (margin && /^・/.test(t)) kind = 'para';
  else if (first.x < geom.quoteX && spanEnd(first) > geom.valueX) kind = 'quote';
  else if (!straddle && values.length) kind = 'table';
  else if (!straddle && labels.length) kind = 'tableLabel';     // 라벨만 있는 줄(세로 가운데 정렬)
  return { kind, raw, labels, values, line, y: line.y, endsSpace: /\s$/.test(raw) };
}

/* ── 표 행 가르기 ──
   **라벨은 행 박스의 세로 가운데에 놓인다**(실측 38행 전부). 그래서 y 간격이나 라벨 y의
   중간값으로 가르면 틀린다 — 행 높이가 제각각이라 '주제'(2줄) 다음의 '특징'(9줄)이
   주제 행으로 빨려 들어간다. 행의 세로 중앙이 라벨 y에 가장 가까워지는 데까지만 담는다.
   (행 경계의 정본은 라벨셀 채움 사각형인데 pdf-spans.py 가 도형을 안 내보낸다 —
    도형이 생기면 이 함수를 [y0−3, 다음 y0−3) 로 바꾸는 것이 맞다. review.todo 참조.) */
function groupRows(labels, valueRows) {
  if (!labels.length) return valueRows.length ? [{ label: '', labelY: valueRows[0].y, rows: valueRows }] : [];
  const out = [];
  let i = 0;
  labels.forEach((lab, li) => {
    const last = li === labels.length - 1;
    const keep = labels.length - li - 1;          // 남은 라벨에 최소 한 줄씩은 남겨 둔다
    const group = [];
    let best = Infinity;
    while (i < valueRows.length && (last || valueRows.length - i > keep)) {
      const top = group.length ? group[0].y : valueRows[i].y;
      const d = Math.abs((top + valueRows[i].y) / 2 - lab.y);   // 이 줄까지 담았을 때의 세로 중앙
      if (group.length && d > best) break;                      // 중앙이 멀어지기 시작하면 그 행은 끝났다
      best = d; group.push(valueRows[i]); i += 1;
    }
    out.push({ label: lab.text, labelY: lab.y, rows: group });
  });
  if (i < valueRows.length) out[out.length - 1].rows.push(...valueRows.slice(i));
  return out;
}

/* 라벨 span 을 행 라벨로 잇는다 — '화자의'+'태도' 처럼 두 줄에 걸친 라벨이 실제로 있다 */
function mergeLabels(spans) {
  const sorted = spans.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const out = [];
  sorted.forEach((s) => {
    const last = out[out.length - 1];
    if (last && s.y - last.y2 < LABEL_GAP) { last.text += s.text; last.y2 = s.y; }
    else out.push({ text: s.text, y: s.y, y2: s.y });
  });
  return out.map((l) => ({ text: norm(l.text), y: (l.y + l.y2) / 2 }));
}

/* 한 단위(표 행 또는 표 밖 단락)를 "정답 채운 판 / 가린 판 / 정답 목록"으로 만든다.
   줄을 이을 때 공백은 **원본 줄 끝에 공백이 있었는지**로 정한다 — 한국어 조판은 줄바꿈에
   공백을 넣지 않으므로 무조건 공백을 넣으면 '노 고에'가 되고, 무조건 붙이면
   '갈매기날고)'가 된다(실측 두 경우 다 있다). */
function readUnit(items, decoy, geom, valuesOnly) {
  let full = '', masked = '';
  const answers = [];
  let prev = null;
  items.forEach((it) => {
    /* 표 행은 **값셀만** 읽는다. 라벨은 세로 가운데 정렬이라 행 중간 줄에 붙어 있어
       그대로 읽으면 문장 한복판에 라벨이 끼어든다('…고단함과 사정서·태도 랑을 깨달음.').
       라벨은 blanks[].label 로 따로 나간다 — build-ihae 가 개관 표에서 하는 것과 같다. */
    const r = U.readLine(valuesOnly ? { y: it.y, spans: it.values } : it.line, { decoy });
    if (!r.full || U.isChromeLine(r.full)) return;
    const glue = prev == null ? '' : (prev.endsSpace ? ' ' : '');
    /* 줄바꿈으로 쪼개진 정답 잇기: 앞 줄이 값셀 오른끝에서 흰 글씨로 끝나고
       다음 줄 값셀 첫 글자도 흰 글씨일 때만 합친다. 안 합치면 '사','랑'이 각각
       모범답안이 되어 채점기가 오판한다. */
    const tail = prev && prev.tail;
    const head = it.head;
    if (tail && head && !glue && spanEnd(tail) >= geom.wrapX && answers.length) {
      answers[answers.length - 1].text += r.answers.length ? r.answers[0].text : '';
      answers[answers.length - 1].wrapped = true;
      r.answers.shift();
    }
    full += glue + r.full;
    masked += glue + r.masked;
    r.answers.forEach((a) => answers.push({ text: a.text }));
    prev = it;
  });
  return { full: norm(full), masked: norm(masked), answers };
}

/* ── 요약 쪽 (2단 거울) ── */
function readSummaryPage(page, decoy) {
  const [leftLines, rightLines] = U.splitColumns(page, { at: COL_AT, top: TOP, bottom: U.FOOT_BAND });
  const geomOf = (lines) => {
    const left = U.colLeft(lines);
    return { left, valueX: left + VALUE_OFF, wrapX: left + WRAP_OFF, quoteX: left + QUOTE_OFF };
  };
  const gL = geomOf(leftLines), gR = geomOf(rightLines);

  /* 절 경계 — 오른쪽 기둥의 흰 장식 라벨(size 7.4)이 절머리 바 자리를 그대로 차지한다.
     실측 장식 10 = 회색 절머리 바 10 = 절 10. 절 이름은 왼쪽 기둥의 제목에서 읽는다
     (오른쪽 같은 자리는 장식 라벨이 덮고 있어 이름이 없다). 좌우 y는 최대 9.3pt 어긋난다. */
  const decoYs = rightLines.filter((l) => l.spans.some((s) => U.isPale(s) && s.size === DECO_SIZE)).map((l) => l.y);
  const headerYs = new Set();
  const sections = decoYs.map((dy) => {
    let head = null;
    leftLines.forEach((l) => {
      if (Math.abs(l.y - dy) > 13) return;
      if (l.spans[0].x >= gL.left + 15) return;
      if (l.spans.some((s) => s.color === GOLD)) return;
      const t = norm(U.joinSpans(l.spans));
      if (HEADER_RE.test(t)) head = { y: l.y, text: t };
    });
    if (head) headerYs.add(head.y);
    const name = head ? head.text : '';
    const pm = POINT_RE.exec(name);
    return { name, point: pm ? pm[1] : '', y: Math.min(dy, head ? head.y : dy) - 1, decoY: dy };
  });
  sections.forEach((s, i) => { s.to = i + 1 < sections.length ? sections[i + 1].y : U.FOOT_BAND; });

  /* 기둥 하나를 단위 목록으로 — 마커로 단락을 열고, 표 줄이 이어지면 표로 묶는다 */
  function parseColumn(lines, geom, isLeft) {
    const units = [];
    sections.forEach((sec) => {
      /* 절 제목은 왼쪽 기둥에만 있다 — y로만 버리면 같은 y의 오른쪽 ★ 줄까지 날아간다
         (실측 p6: 왼쪽 '출제 Point ③'과 오른쪽 '★★ 표현 방식 파악하기'가 같은 y=424.1) */
      const mine = lines.filter((l) => l.y >= sec.y && l.y < sec.to && !(isLeft && headerYs.has(l.y)) &&
        !l.spans.some((s) => U.isPale(s) && s.size === DECO_SIZE));
      let cur = null, prevKind = null;
      mine.forEach((line) => {
        const c = classify(line, geom);
        /* 정답이 이 줄에서 잘렸는지 / 이 줄 값셀 첫 글자가 정답인지 — 줄바꿈 정답 잇기용 */
        const lineText = U.joinSpans(line.spans);
        const lastSpan = line.spans[line.spans.length - 1];
        c.tail = isAnswerSpan(lastSpan, decoy, line.y, lineText) ? lastSpan : null;
        c.head = c.values.length ? isAnswerSpan(c.values[0], decoy, line.y, lineText) : false;

        const marker = c.kind === 'star' || c.kind === 'subtitle' || c.kind === 'para' || c.kind === 'quote';
        if (marker) {
          /* 인용 시구 박스는 두 줄짜리가 있다 — 바로 이어지는 인용 줄은 같은 박스다 */
          if (c.kind === 'quote' && cur && cur.kind === 'quote' && prevKind === 'quote') cur.items.push(c);
          else { cur = { kind: c.kind, section: sec, items: [c] }; units.push(cur); }
        } else if (c.kind === 'table') {
          if (!cur || cur.kind !== 'table') { cur = { kind: 'table', section: sec, items: [] }; units.push(cur); }
          cur.items.push(c);
        } else if (c.kind === 'tableLabel' && cur && cur.kind === 'table') {
          cur.items.push(c);
        } else if (cur) {
          /* 문단 마지막 조각('법.'·'함.')은 라벨셀 폭 안에 들어와 표 라벨처럼 보인다 —
             앞 단락에 이어 붙인다(§pitfalls: 라벨셀 좌표만으로는 못 가른다) */
          cur.items.push(c);
        }
        prevKind = c.kind;
      });
    });
    return units;
  }

  /* 표 단위를 행으로 펼친다 */
  function expand(units, geom) {
    const out = [];
    units.forEach((u) => {
      if (u.kind !== 'table') { out.push({ ...u, label: '' }); return; }
      const labelSpans = [];
      u.items.forEach((it) => it.labels.forEach((s) => labelSpans.push({ ...s, y: it.y })));
      const rows = groupRows(mergeLabels(labelSpans), u.items.filter((it) => it.values.length));
      rows.forEach((r) => out.push({ kind: 'row', section: u.section, label: r.label, items: r.rows }));
    });
    return out;
  }

  const read = (u, geom) => ({ ...u, read: readUnit(u.items, decoy, geom, u.kind === 'row') });
  const left = expand(parseColumn(leftLines, gL, true), gL).map((u) => read(u, gL));
  const right = expand(parseColumn(rightLines, gR, false), gR).map((u) => read(u, gR));

  /* 좌우 대조 — 이 시리즈에서 짝 지면(선생님용)을 대신하는 검증 링크다.
     span 단위 x−252 매칭은 쓰면 안 된다(왼쪽은 정답이 긴 검은 span 에 녹아 있어 실측
     108건 중 64건 실패). **단위(표 행·단락) 단위로 견준다** — U.similarity 는 같은 자리끼리
     맞대는 함수라 쪽 전체를 한 문자열로 견주면 원문의 마침표 1자 차이에도 뒤가 통째로
     밀려 0.75까지 떨어진다(실측 p3). 단위로 끊으면 어긋난 자리가 그대로 검수 대상이 된다. */
  const n = Math.min(left.length, right.length);
  const cells = [];
  for (let i = 0; i < n; i += 1) {
    cells.push({ i, label: right[i].label || left[i].label || right[i].kind,
      score: U.similarity(left[i].read.full, right[i].read.full),
      left: left[i].read.full, right: right[i].read.full });
  }
  const bad = cells.filter((c) => c.score < MIRROR_GATE);
  const similarity = cells.length ? Math.min(...cells.map((c) => c.score)) : 1;

  /* ★ 출제 Point 는 왼쪽 기둥에서만 읽는다 — 오른쪽은 같은 것이 한 번 더 나온다 */
  const examPoints = [];
  leftLines.forEach((l) => {
    const star = l.spans.find((s) => s.color === GOLD);
    if (!star) return;
    const sec = sections.find((s) => l.y >= s.y && l.y < s.to);
    const title = norm(U.joinSpans(l.spans.filter((s) => s.x > star.x)));
    examPoints.push({ point: sec ? sec.point : '', stars: (star.text.match(/★/g) || []).length, title, page: page.no });
  });

  return { left, right, sections, similarity, bad, cells: cells.length, examPoints,
    shape: left.length === right.length };
}

/* ── 본체 ── */
export function buildYoyak(doc, opts) {
  opts = opts || {};
  const pages = (doc && doc.pages) || [];
  const meta = U.headerMeta(doc);
  const ids = opts.workIds || {};
  const review = { report: [], todo: [], candidates: [], pending: [] };
  const byKey = new Map();
  const order = [];

  function patchOf(page) {
    const k = workKeyOf(page);
    if (!k) { review.pending.push({ page: page.no, why: '머리말에서 작품 키를 못 읽었다' }); return null; }
    if (!byKey.has(k.key)) {
      byKey.set(k.key, {
        workKey: k.key, title: k.title,
        vocab: [], checklist: [], examPoints: [], blanks: [],
        check: { overview: { genre: [], material: '', tone: [], theme: '', features: [] }, composition: [] },
      });
      order.push(k.key);
    }
    return byKey.get(k.key);
  }

  const mirrors = [];
  const stat = { checklistPages: 0, summaryPages: 0, tableRows: 0, paras: 0, quotes: 0, wrapped: 0,
    blankRows: 0, blankParas: 0 };

  pages.forEach((page) => {
    const patch = patchOf(page);
    if (!patch) return;
    const role = pageRole(page);
    if (role === 'checklist') { stat.checklistPages += 1; readChecklistPage(page, patch, review); return; }
    if (role !== 'summary') { review.pending.push({ page: page.no, why: '쪽 역할을 판별하지 못했다' }); return; }
    stat.summaryPages += 1;

    const decoy = U.makeDecoy(page, 'yoyak');
    const r = readSummaryPage(page, decoy);
    mirrors.push({ page: page.no, workKey: patch.workKey, min: r.similarity, cells: r.cells, bad: r.bad.length });
    if (!r.shape) {
      review.pending.push({ page: page.no, workKey: patch.workKey,
        why: `좌우 기둥의 단위 수가 다르다(좌 ${r.left.length} / 우 ${r.right.length}) — 지면 구성이 바뀐 자료일 수 있다` });
    }
    /* 미달 단위는 '어느 줄이 어긋났는지'까지 넘긴다 — 대개 원문 오탈자이고, 고치는 것은 사람 몫이다 */
    r.bad.forEach((c) => review.pending.push({ page: page.no, workKey: patch.workKey,
      similarity: +c.score.toFixed(4), label: c.label, left: c.left, right: c.right,
      why: `좌우 거울 대조가 문턱(${MIRROR_GATE}) 미만 — 이 단위는 사람이 본다` }));
    /* 절을 못 잡으면 빈칸 path 가 통째로 뭉개진다 — 조용히 넘기지 않는다 */
    if (!r.sections.length) {
      review.pending.push({ page: page.no, workKey: patch.workKey,
        why: '요약 쪽인데 절머리(흰 장식 라벨 size 7.4)를 하나도 못 찾았다 — 색·크기가 다른 자료일 수 있다' });
    }
    r.sections.filter((sc) => !sc.name).forEach((sc) => {
      review.pending.push({ page: page.no, workKey: patch.workKey, y: sc.decoY,
        why: '절 이름(개관/구성/출제 Point ⓝ)을 왼쪽 기둥에서 못 읽었다 — 그 절의 빈칸 path 가 뭉개진다' });
    });
    patch.examPoints.push(...r.examPoints);

    /* 왼쪽 기둥 = 검증 출처. 개관·구성 값을 check 에 담아 이해완성 정본과 대조하게 한다.
       **patch 본문에 직접 쓰지 않는다** — 정본은 이해완성이고, 병합기가 덮어쓰면 안 된다. */
    r.left.forEach((u) => {
      const name = u.section.name;
      const v = u.read.full;
      if (!v) return;
      if (name === '개관' && u.kind === 'row') {
        const ov = patch.check.overview;
        /* 이해완성과 **같은 5키**다 — 문자열 그대로 견줄 수 있게 어휘를 맞춰 둔다 */
        if (!OVERVIEW_KEYS.includes(u.label)) {
          review.pending.push({ page: page.no, workKey: patch.workKey, label: u.label,
            why: '개관 표에 모르는 라벨이 있다 — 이해완성 개관과 대조할 수 없다' });
        }
        if (u.label === '갈래') ov.genre = v.split(/[,·]/).map((x) => x.trim()).filter(Boolean);
        else if (u.label === '제재') ov.material = v;
        else if (u.label === '성격') ov.tone = v.split(/[,·]/).map((x) => x.trim()).filter(Boolean);
        else if (u.label === '주제') ov.theme = v;
        else if (u.label === '특징') v.split(/(?=[①②③④⑤])/).map((x) => x.trim()).filter(Boolean)
          .forEach((x) => ov.features.push(x.replace(/^[①②③④⑤]\s*/, '')));
      } else if (name === '구성' && u.kind === 'row') {
        patch.check.composition.push({ range: u.label.replace(/\s+/g, ''), summary: v });
      }
    });

    /* 오른쪽 기둥 = 정답 출처 */
    let secKey = '', paraNo = 0, rowNo = 0, subTitle = '';
    let curSec = null;
    r.right.forEach((u) => {
      if (u.section !== curSec) { curSec = u.section; paraNo = 0; rowNo = 0; subTitle = ''; }
      const name = u.section.name;
      /* 빈칸 path 는 **이해완성과 같은 어휘**를 쓴다. path 가 다르면 같은 핵심어를 두 번
         뚫어도 §2.2-2 중복 병합 경고가 영원히 안 뜬다(검증기 시그니처가 path|answers 다). */
      if (name === '개관') secKey = 'overview';
      else if (name === '구성') secKey = 'composition';
      else secKey = 'point' + (u.section.point ? '.' + u.section.point : '');

      if (u.kind === 'subtitle') subTitle = u.read.full;
      if (u.kind === 'quote') {
        stat.quotes += 1;
        review.candidates.push({ kind: 'quote', workKey: patch.workKey, section: name, subTitle,
          text: u.read.full, page: page.no });
      }
      /* 시어 상징 표는 keywords 후보로만 모은다 — 자동 배정하지 않는다(§humanOnly) */
      if (u.kind === 'row' && /시어/.test(subTitle) && u.label) {
        review.candidates.push({ kind: 'keyword', workKey: patch.workKey, word: u.label,
          meaning: u.read.full, section: name, subTitle, page: page.no });
      }
      if (u.kind === 'row') { rowNo += 1; stat.tableRows += 1; }
      else if (u.kind !== 'star') { paraNo += 1; stat.paras += 1; }
      if (!u.read.answers.length) return;
      if (u.kind === 'row') stat.blankRows += 1; else stat.blankParas += 1;

      let path, label;
      if (u.kind === 'row') {
        /* 개관은 라벨(갈래/제재/…), 구성은 행 번호 — 둘 다 이해완성이 쓰는 어휘 그대로다 */
        const key = secKey === 'overview' ? u.label : secKey === 'composition' ? String(rowNo) : (u.label || String(rowNo));
        path = secKey + '.' + key;
        label = u.label || name;
      } else {
        path = secKey + '.p' + paraNo;
        label = subTitle || name;
      }
      u.read.answers.forEach((a) => {
        if (a.wrapped) stat.wrapped += 1;
        const localNo = patch.blanks.length + 1;
        const workId = ids[patch.workKey];
        patch.blanks.push({
          /* 빈칸 id 는 **팩 전역 유일**이어야 한다(검증기가 works 루프 바깥에서 본다).
             patch 단계에서는 workId 를 모를 수 있어 localNo 만 담고, 병합기가
             U.blankId(workId, 'yoyak', localNo) 로 붙인다. */
          ...(workId ? { id: U.blankId(workId, 'yoyak', localNo) } : {}),
          localNo, series: 'yoyak',
          path, label, text: u.read.masked, answers: [a.text], page: page.no,
        });
      });
    });
  });

  /* vocab id 도 팩 전역 유일이어야 한다 — 검증기는 작품 안 유일만 보지만 engine.js 의
     상태 키가 평면이라 두 작품이 같은 id 를 쓰면 학습 상태가 조용히 뒤섞인다. */
  order.forEach((k) => {
    const p = byKey.get(k);
    const workId = ids[k];
    if (workId) p.vocab.forEach((v) => { v.id = 'v-' + workId + '-' + String(v.localNo).padStart(3, '0'); });
  });

  const patches = order.map((k) => byKey.get(k));

  /* ── 초안 품질 보고 ── */
  const sum = (f) => patches.reduce((a, p) => a + f(p), 0);
  const starts = U.sectionStarts(doc);
  const report = [
    `페이지 ${pages.length} (체크리스트 ${stat.checklistPages}쪽 · 요약 ${stat.summaryPages}쪽) · 작품 ${patches.length}편`,
    `작품 키: ${patches.map((p) => p.workKey).join(' / ') || '(없음)'}`,
    `빈칸 ${sum((p) => p.blanks.length)} (줄바꿈으로 쪼개진 정답 ${stat.wrapped}건 이어 붙임)` +
      ` · 빈칸 있는 단위 ${stat.blankRows + stat.blankParas}(표 행 ${stat.blankRows} + 표 밖 단락 ${stat.blankParas})` +
      ` / 전체 단위 ${stat.tableRows + stat.paras}(표 행 ${stat.tableRows} + 표 밖 단락 ${stat.paras})`,
    `어휘 ${sum((p) => p.vocab.length)} · 파이널 체크리스트 ${sum((p) => p.checklist.length)}묶음 ` +
      `${sum((p) => p.checklist.reduce((a, c) => a + c.items.length, 0))}항목 · ★ 출제 Point ${sum((p) => p.examPoints.length)}`,
    `좌우 거울 대조(단위별 최솟값): ${mirrors.map((m) => `p${m.page} ${m.min.toFixed(4)}(미달 ${m.bad}/${m.cells})`).join(' · ') || '(요약 쪽 없음)'}`,
    `검수 후보 ${review.candidates.length}건(인용 시구 ${stat.quotes} + 시어 표 ${review.candidates.filter((c) => c.kind === 'keyword').length})`,
    `저장 문항 0 · 지문 세트 0 — 이 시리즈에는 인쇄된 문항이 없다(zb 고유번호 실측 0건)`,
  ];

  const todo = [];
  if (!patches.length) todo.push('작품을 하나도 못 찾았다 — 머리말 형식이 다른 자료일 수 있다');
  if (!sum((p) => p.blanks.length)) todo.push('빈칸을 못 찾았다 — pdf-spans.py --colors 로 색 분포를 확인');
  if (starts.length !== patches.length) {
    todo.push(`마스트헤드 쪽 ${starts.length}개인데 작품 키는 ${patches.length}개다 — 쪽 묶음을 지면과 대조할 것`);
  }
  patches.forEach((p) => {
    if (!ids[p.workKey]) {
      todo.push(`'${p.workKey}' 의 workId 가 없다 — 병합기가 blanks[].id = U.blankId(workId,'yoyak',localNo), ` +
        `vocab[].id = 'v-<workId>-<localNo 3자리>' 로 붙여야 한다. 안 붙이면 팩 전역 id 중복으로 배포가 막힌다`);
    }
  });
  mirrors.filter((m) => m.bad).forEach((m) => {
    todo.push(`p${m.page} 좌우 대조 미달 ${m.bad}단위(최솟값 ${m.min.toFixed(4)}) — 대개 원문 오탈자다. ` +
      '고치지 말고 notes 에 적는다(스키마 원칙 3). 어긋난 자리는 review.pending 에 좌·우 문장이 그대로 있다');
  });
  todo.push('author(작가)는 이 자료에도 인쇄돼 있지 않다 — 업로드 폼에서 넣는다(‘천재(노미숙)’은 교과서 출판사·저자다)');
  todo.push('checklist·examPoints 는 뽑아 두었지만 **지금 앱이 어디서도 읽지 않는다**(gen·grade·engine·index.html grep 0건) — ' +
    '소비처가 생기기 전에는 이 두 필드 검수에 시간을 쓰지 말 것');
  todo.push('빈칸 정답이 문맥상 유일한지는 사람이 훑는다 — 두 글자 문맥은 다른 답도 성립한다(예 성격 ‘□□적, 감각적’)');
  todo.push('keywords(시어 상징 표)·rhetoric 은 자동 배정하지 않았다 — candidates 를 보고 검수에서 채운다');
  todo.push('인용 시구는 원문이 아니다(‘ / ’로 행이 합쳐지고 ‘…중략…’이 들어간다) — 몇 연 몇 행인지는 이해완성 정본과 대조해 사람이 붙인다');
  todo.push('★ 개수(2/3)는 중요도 2단계일 뿐이다 — 출제 확률·복습 빈도로 환산하는 것은 정책 결정이다');
  todo.push('행 경계의 정본은 라벨셀 채움 사각형인데 pdf-spans.py 가 도형을 안 내보낸다 — ' +
    '지금은 ‘라벨은 행의 세로 가운데’ 규칙으로 대신한다. rects 가 생기면 [y0−3, 다음 y0−3) 로 바꾼다');
  todo.push('check(개관·구성)는 이해완성 정본과 대조하라고 담은 값이다 — 어긋날 때 어느 쪽을 채택할지는 사람이 정한다');

  return { series: 'yoyak', patches, sets: [], items: [], review: { ...review, report, todo }, meta, mirrors };
}

/* ── CLI ── (import 될 때는 안 돈다) */
const invokedDirectly = process.argv[1] && /build-yoyak\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  const fs = await import('node:fs');
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith('--'));
  const opt = (name) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
  };
  if (!file) {
    console.error('사용법: node naesin-ko/extract/build-yoyak.mjs <spans.json>' +
      ' [--workIds "<작품키>=<workId>;…"] [--workId w-xxx] [--review review/yoyak.json]\n' +
      '  stdout 은 **병합기 입력**이다 — 팩 디렉터리에 넣지 마라(팩 루트로 복사돼 학생에게 배달된다).');
    process.exit(1);
  }
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const det = U.detectSeries(doc);
  if (det.series && det.series !== 'yoyak') {
    console.error(`이 파일은 직전 요약노트가 아니라 '${U.SERIES_LABEL[det.series]}' 입니다 — 맞는 추출기를 쓰세요.`);
    process.exit(2);
  }
  const workIds = {};
  (opt('workIds') || '').split(';').forEach((pair) => {
    const i = pair.indexOf('=');
    if (i > 0) workIds[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  });
  const single = opt('workId');
  const out = buildYoyak(doc, { workIds });
  /* --workId 는 작품이 한 편일 때만 쓰는 지름길이다 — 여러 편이면 어느 작품인지 알 수 없다 */
  if (single && out.patches.length === 1) {
    Object.assign(workIds, { [out.patches[0].workKey]: single });
  } else if (single) {
    console.error(`작품이 ${out.patches.length}편이라 --workId 를 쓸 수 없습니다 — --workIds 로 작품 키마다 지정하세요.`);
    process.exit(2);
  }
  const res = single && out.patches.length === 1 ? buildYoyak(doc, { workIds }) : out;

  const reviewPath = opt('review');
  if (reviewPath) {
    fs.mkdirSync(reviewPath.replace(/\/[^/]*$/, '') || '.', { recursive: true });
    fs.writeFileSync(reviewPath, JSON.stringify({ series: 'yoyak', meta: res.meta, ...res.review }, null, 1));
  }

  process.stderr.write('\n[직전 요약노트 초안]\n' + res.review.report.map((r) => '  ' + r).join('\n') +
    '\n\n[검수에서 할 일]\n' + res.review.todo.map((t) => '  · ' + t).join('\n') +
    (res.review.pending.length ? '\n\n[사람에게 넘김]\n' + res.review.pending.map((p) => '  · ' + JSON.stringify(p)).join('\n') : '') +
    (reviewPath ? `\n\n검수 후보 ${res.review.candidates.length}건 → ${reviewPath}\n\n`
      : `\n\n검수 후보 ${res.review.candidates.length}건은 버렸습니다 — 남기려면 --review <경로> 를 주세요.\n\n`));

  /* stdout 은 병합기(build-pack.mjs)가 그대로 import·읽는 모양이다 — 검수 부속물은 빠진다 */
  console.log(JSON.stringify({ series: res.series, patches: res.patches, sets: res.sets, items: res.items, meta: res.meta }, null, 1));
}
