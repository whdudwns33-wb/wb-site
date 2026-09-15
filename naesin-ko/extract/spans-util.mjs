/* WB 국어브레인 — 지면 span 공용 유틸 (추출 파이프라인 공통층)
 *
 * 족보닷컴 4종(이해완성·직전 요약노트·단원집중·서술형 공략)의 추출기가 같은 규칙을 쓰게 한다.
 * 여기 있는 상수는 전부 **실측값**이다 — 5개 파일(천재(노미숙) 중2-1 1단원)에서 재어 확인했다.
 * 다른 출판사 자료가 오면 pdf-spans.py --colors 를 먼저 돌려 PALE·색 상수를 넓힌다(extract/README.md §1).
 *
 * 좌표를 하드코딩하지 않는다: 기둥 경계·라벨 위치는 page.width 나 '기둥 왼끝 + 오프셋'으로 상대화한다.
 * 조판이 조금 밀려도 살아남아야 하고, 그게 안 되면 검수에서 걸리도록 보고를 남긴다.
 */
import crypto from 'node:crypto';

/* ── 색 ──
   PALE = 지면에서 안 보이는 색. #e7f4f6 은 실측으로 뒤늦게 찾았다 —
   이게 빠져 있어 이해완성 A에서 '은유법'·'의인법' 2개, B에서 4개를 통째로 놓치고 있었다. */
export const PALE = ['#ffffff', '#e5e5e5', '#e6e6e6', '#fefefe', '#e7f4f6'];
export const NOTE_COLORS = ['#2b5686', '#215ab9', '#3e88ab', '#1f4e79'];
/* 머리말 띠는 **좁게** 잡아야 한다. 실측: 러닝헤더 y 42~46인데 본문 첫 문항 번호가 y 64.3다
   — 90으로 자르면 단원집중 2번 문항이 통째로 사라진다. 표지 쪽 마스트헤드만 80까지 내려온다. */
export const HEAD_BAND = 55;      // 속쪽 러닝헤더 (모든 쪽에서 버려도 되는 띠)
export const MAST_BAND = 80;      // 표지 쪽 마스트헤드 '중2 | 국어 | 1-1.…'
export const FOOT_BAND = 770;     // 이 아래는 판권·쪽번호 (본문 최대 y 실측 758.3)
export const TINY = 1.2;          // 이 이하 크기는 지면에서 안 보이는 zb 문항번호

export const isPale = (s) => PALE.includes(s.color);
export const isNote = (s) => NOTE_COLORS.includes(s.color);

/* ── 판면 부속물 ──
   줄을 통째로 버리는 필터로는 못 거른다: chrome 이 본문 줄에 **섞여** 들어오는 줄이
   실측으로 이해완성 18줄·요약노트 10줄·서술형 8줄 있다. 토큰 단위로 지운다.
   순서가 고정이다 — 쪽번호를 먼저 지우지 않으면 식별번호 정규식이 그 끝 하이픈을 먹어
   '- 2 -' 가 살아남는다. */
const CHROME_TOKENS = [
  /-\s*\d{1,3}\s*-\s*$/,                    // 쪽번호 '- 12 -'
  /I\d{3}-\d{3}-\d{2}-\d{2}-\d{4,}-?/g,     // 자료 식별번호
];
const BOILER = /콘텐츠산업|저작권법|제작연월일|제작자|보호됩니다|법적 책임|무단으로 복제|교육지대|^\d{4}-\d{2}-\d{2}$/;

export function stripChrome(text) {
  let s = String(text == null ? '' : text);
  for (const re of CHROME_TOKENS) s = s.replace(re, ' ');
  return s.replace(/\s+/g, ' ').trim();
}
export function isChromeLine(text) {
  const s = stripChrome(text);
  return !s || BOILER.test(s);
}

/* ── span 잇기 ──
   PDF는 띄어쓰기를 공백 문자로 주지 않고 **좌표 간격**으로만 준다. 정답 글자가 색만 다른
   별개 span 이라 경계에서 공백이 사라진다 — 실측 '일상속에서'(정답 '일상'), '편견어린'(정답 '편견').
   모범답안은 글자 하나가 틀려도 채점기가 오판하므로(README §3) 간격에서 공백을 복원한다.
   실측: 붙은 글자 사이 -0.4~1.9pt, 진짜 띄어쓰기 3.9pt(size 9.3) → 문턱 size*0.3. */
export function joinSpans(spans) {
  let out = '';
  let prev = null;
  for (const s of spans) {
    if (prev) {
      const gap = s.x - (prev.x + prev.w);
      if (gap >= (prev.size || 9) * 0.3 && !/\s$/.test(out) && !/^\s/.test(s.text)) out += ' ';
    }
    out += s.text;
    prev = s;
  }
  return out;
}

/* ── 시리즈 판별 ──
   파일명은 못 믿는다 — 구글 드라이브에서 내려받으면 한글이 깨진다(실제로 그랬다).
   지면 내용만으로 가른다. 1차는 머리말 대괄호 태그, 2차는 색·마커 지문(fingerprint). */
const TAG = {
  ihae: /\[이해완성\]/,
  yoyak: /\[직전\s*요약노트\]/,
  danwon: /\[단원집중\]/,
  seosul: /\[서술형\s*공략\]/,
};
const FALLBACK = {
  ihae: (t, c) => /이해전략\s*\d/.test(t) && (c['#e5e5e5'] || 0) > 0,
  yoyak: (t, c) => /출제\s*Point/.test(t) && (c['#e9ae2b'] || 0) > 0,
  danwon: (t) => /\[정답\]/.test(t) && /\[해설\]/.test(t),
  seosul: (t) => /모범\s*답안/.test(t),
};

export function plainText(doc) {
  const out = [];
  for (const p of doc.pages || []) for (const l of p.lines) for (const s of l.spans) out.push(s.text);
  return out.join('');
}
export function colorTally(doc) {
  const t = {};
  for (const p of doc.pages || []) for (const l of p.lines) for (const s of l.spans) t[s.color] = (t[s.color] || 0) + 1;
  return t;
}

export function detectSeries(doc) {
  const text = plainText(doc);
  const hits = Object.keys(TAG).filter((k) => TAG[k].test(text));
  if (hits.length === 1) return { series: hits[0], by: 'tag', confident: true };
  const tally = colorTally(doc);
  const fb = Object.keys(FALLBACK).filter((k) => FALLBACK[k](text, tally));
  if (fb.length === 1) return { series: fb[0], by: 'fallback', confident: false, candidates: hits };
  /* 판정이 유일하지 않으면 절대 추측하지 않는다 — 사람에게 넘긴다. */
  return { series: null, by: 'none', confident: false, candidates: hits.concat(fb) };
}

export const SERIES_LABEL = {
  ihae: '이해완성', yoyak: '직전 요약노트', danwon: '단원집중', seosul: '서술형 공략',
};

/* ── 안 보이지만 정답이 아닌 글자 ──
   이게 실제 거름망이다. 앞뒤 쪽 좌표 대조는 실측 매칭률 2.8%로 **사실상 작동하지 않았다**
   (선생님용에서는 정답이 앞뒤 글자와 한 span 으로 합쳐지고 y도 3~20pt 어긋난다).
   빈칸이 맞게 나오던 것은 대조 덕분이 아니라 색과 이 규칙 덕분이었다. */
export function makeDecoy(page, series) {
  const W = page.width || 595;
  return function decoy(span, lineY, lineText) {
    const t = (span.text || '').trim();
    if (lineY < HEAD_BAND || lineY >= FOOT_BAND) return true;       // 머리말·판권 띠
    /* 마스트헤드('중2 | 국어')는 흰 글씨로 조판돼 있다. 조각('중','2','국어')만 보면 못 거르니
       줄 전체를 본다 — 표지 쪽은 마스트헤드가 머리말 띠보다 아래에 온다. */
    if (MASTHEAD.test(String(lineText || '').replace(/\s+/g, ' '))) return true;
    if (/^(중|고)$/.test(t) || t === '국어') return true;            // 마스트헤드 조각
    /* 연 라벨 — 초록 박스 안 흰 글씨. 표기가 파일마다 다르다: '5연~6연' 과 '1~2연' 둘 다 온다 */
    if (span.size === 8 && span.x > W * 0.65 && STANZA_LABEL.test(t)) return true;
    if (series === 'yoyak' && span.size === 7.4) return true;        // '빈 칸 채우기로 바로 확인' 배너
    return false;
  };
}

/* 연 라벨 표기가 파일마다 다르다: '1연' · '5연~6연' · '1~2연' 전부 온다. */
const STANZA_LABEL = /^\d+\s*연?\s*[~〜～]?\s*\d*\s*연$/;

/* 행 하나를 "정답을 채운 원문" + "빈칸으로 가린 문맥" 두 벌로 만든다. */
export function readLine(line, opts) {
  opts = opts || {};
  const decoy = opts.decoy || (() => false);
  const y = line.y;
  const rawText = joinSpans(line.spans);
  const answers = [];
  const fullSpans = [], maskSpans = [];
  for (const s of line.spans) {
    const a = (s.text || '').trim();
    if (isPale(s) && a && !decoy(s, y, rawText)) {
      answers.push({ text: a, x: s.x, size: s.size, color: s.color });
      fullSpans.push(s);
      maskSpans.push({ ...s, text: s.text.replace(/\S/g, '□') });
    } else {
      fullSpans.push(s); maskSpans.push(s);
    }
  }
  return { full: stripChrome(joinSpans(fullSpans)), masked: stripChrome(joinSpans(maskSpans)), answers, y };
}

/* ── 기둥 ──
   읽기 순서는 반드시 기둥 우선(왼쪽 전부 → 오른쪽 전부)이다. y로 훑으면 순서가 뒤엉킨다
   (단원집중 p1은 (가)y130 → (다)y274 오른기둥 → (나)y529 왼기둥). */
export function splitColumns(page, opts) {
  opts = opts || {};
  const at = opts.at == null ? (page.width || 595) / 2 : opts.at;
  const top = opts.top == null ? HEAD_BAND : opts.top;
  const bottom = opts.bottom == null ? FOOT_BAND : opts.bottom;
  const left = [], right = [];
  for (const line of page.lines) {
    if (line.y < top || line.y >= bottom) continue;
    const l = line.spans.filter((s) => s.x < at);
    const r = line.spans.filter((s) => s.x >= at);
    if (l.length) left.push({ y: line.y, spans: l });
    if (r.length) right.push({ y: line.y, spans: r });
  }
  return [left, right];
}

/* 기둥의 왼끝 — 좌표를 하드코딩하지 않기 위한 기준점 */
export function colLeft(lines) {
  let m = Infinity;
  for (const l of lines) for (const s of l.spans) if (s.x < m) m = s.x;
  return m === Infinity ? 0 : m;
}

/* ── 절(작품·학생용/선생님용) 경계 ──
   마스트헤드('중2 | 국어')가 찍힌 쪽이 새 절의 시작이다. 이해완성의 학생/선생님 경계와
   요약노트의 작품 경계를 같은 신호 하나로 잡는다. 실측 이해완성 [1,8] · 요약노트 [1,4]. */
const MASTHEAD = /(중|고)\s*\d\s*\|?\s*국어/;
export function sectionStarts(doc) {
  const out = [];
  (doc.pages || []).forEach((p) => {
    const head = p.lines.filter((l) => l.y < MAST_BAND).map((l) => joinSpans(l.spans)).join(' ');
    if (MASTHEAD.test(head.replace(/\s+/g, ' '))) out.push(p.no);
  });
  return out;
}

/* 학생용 / 선생님용 짝. 좌표 대조에는 못 쓰고(위 주석), **정본 원문 검증용**으로 쓴다 —
   뒤 절반은 정답이 채워진 완성 문장이라 초안이 맞는지 대조할 수 있다. */
export function pairHalves(doc) {
  const pages = doc.pages || [];
  const starts = sectionStarts(doc);
  const half = Math.floor(pages.length / 2);
  if (pages.length % 2 !== 0 || half === 0) return null;
  if (!(starts.length === 2 && starts[0] === 1 && starts[1] === half + 1)) return null;
  const paleOf = (ps) => ps.reduce((a, p) => a + p.lines.reduce((b, l) => b + l.spans.filter(isPale).length, 0), 0);
  const student = pages.slice(0, half), teacher = pages.slice(half);
  const fp = paleOf(student), bp = paleOf(teacher);
  if (!(fp > bp * 3)) return null;
  return { student, teacher, frontPale: fp, backPale: bp };
}

/* ── 문제집 계열 마커 ── */

/* 문항 번호 'N.' — #191919 size 13.7. 이 색·크기 조합은 두 문제집에만, 이 용도로만 쓰인다. */
export function itemMarkers(lines) {
  const out = [];
  for (const l of lines) {
    for (const s of l.spans) {
      const t = (s.text || '').trim();
      if (s.color === '#191919' && s.size === 13.7 && /^\d{1,3}\.$/.test(t)) {
        out.push({ no: parseInt(t, 10), x: s.x, y: l.y });
      }
    }
  }
  return out;
}

/* 족보닷컴 문항 고유번호 'zb17)'.
   **색이 아니라 크기로 잡는다** — 흰색 전제는 틀렸다(단원집중 p7의 zb22)·zb23)은 검정 1pt다).
   size <= 1.2 인 span 은 5개 파일 통틀어 이 id 뿐이고, 'zb' 와 'N)' 이 별개 span 이라 잇는다. */
export function itemIds(lines) {
  const out = [];
  for (const l of lines) {
    const tiny = l.spans.filter((s) => (s.size || 9) <= 1.2);
    let buf = '', x0 = null;
    for (const s of tiny) {
      if (!buf) x0 = s.x;
      buf += s.text.trim();
      const m = buf.match(/^zb(\d{1,3})\)$/);
      if (m) { out.push({ id: buf, no: parseInt(m[1], 10), x: x0, y: l.y }); buf = ''; x0 = null; }
      else if (buf.length > 8) { buf = ''; x0 = null; }
    }
  }
  return out;
}

/* zb id 는 지면에서 안 보이는 글자다 — 발문에 남으면 학생 화면에 'zb7) 이 시의…'로 뜬다. */
export function stripItemIds(text) {
  return String(text || '').replace(/zb\s*\d{1,3}\)\s*/g, '').replace(/\s+/g, ' ').trim();
}

/* 해설 절의 항목 마커 'N)' — size 7.9 검정, 기둥 라벨 위치.
   저작권 고지의 '1) 제작연월일 :' 과 정규식이 겹치지만 size 5 라서 갈린다. */
export function solutionEntries(lines) {
  const left = colLeft(lines);
  const out = [];
  for (const l of lines) {
    for (const s of l.spans) {
      const t = (s.text || '').trim();
      /* 마커는 기둥 왼끝에 붙어 있고 본문은 그보다 안쪽에서 시작한다 — 좌표를 고정값으로
         적지 않고 기둥 왼끝 기준으로 본다(조판이 밀려도 산다). */
      if (s.size === 7.9 && s.color === '#000000' && /^\d{1,3}\)$/.test(t) && Math.abs(s.x - left) < 4) {
        out.push({ no: parseInt(t, 10), x: s.x, y: l.y });
      }
    }
  }
  return out;
}

/* 지문 세트의 시작 '※ 다음 글을 읽고' 와 그 안의 (가)(나) 라벨 */
export function passageStarts(lines) {
  const out = [];
  for (const l of lines) {
    const t = joinSpans(l.spans).trim();
    if (/^※\s*다음\s*글을\s*읽고/.test(t)) out.push({ y: l.y });
  }
  return out;
}
export function passageLabels(lines) {
  const out = [];
  for (const l of lines) {
    for (const s of l.spans) {
      const t = (s.text || '').trim();
      if (/^\([가-하]\)$/.test(t) && (s.size || 0) >= 8.5) out.push({ label: t, x: s.x, y: l.y });
    }
  }
  return out;
}

/* 연 라벨 — 연 나눔의 **정답 앵커**다. y 간격 추정(groupByGap)은 실측 두 파일 모두에서 틀렸다:
   시행 사이에 날개풀이가 끼어 간격 중앙값이 부풀기 때문. 앵커가 있으면 앵커를 쓴다. */
export function stanzaAnchors(page) {
  const W = page.width || 595;
  const out = [];
  for (const l of page.lines) {
    for (const s of l.spans) {
      const t = (s.text || '').trim();
      if (s.size === 8 && s.x > W * 0.65 && STANZA_LABEL.test(t)) {
        out.push({ range: t.replace(/\s+/g, ''), y: l.y, x: s.x });
      }
    }
  }
  return out.sort((a, b) => a.y - b.y);
}

/* ── 연 나누기 ──
   시행 사이의 큰 간격은 **연 나눔이 아니라 끼어든 날개풀이**인 경우가 많다. 그래서 순진한
   y 간격 추정은 실측 두 파일 모두에서 틀렸다(A: 6연을 5연으로, B: 6연을 3연으로).
   끼어든 날개풀이 줄이 차지한 높이를 빼고 나면 진짜 연 나눔만 남는다 — 실측 확인:
     4연 안: 27.1 - 13.5(날개풀이 1줄) = 13.6  → 같은 연
     5연/6연 사이: 27.1 - 0                    → 연 나눔
   기준 줄높이는 '사이에 아무것도 없는 간격'의 중앙값으로 스스로 잰다(글꼴 크기 무관). */
export function stanzaSplit(verses, notes, opts) {
  opts = opts || {};
  if (!verses.length) return [];
  const noteYs = (notes || []).map((n) => n.y);
  const gaps = [];
  for (let i = 1; i < verses.length; i++) {
    const a = verses[i - 1].y, b = verses[i].y;
    gaps.push({ g: b - a, n: noteYs.filter((y) => y > a && y < b).length });
  }
  const clean = gaps.filter((x) => x.n === 0).map((x) => x.g).sort((a, b) => a - b);
  const base = clean.length ? clean[Math.floor(clean.length / 2)] : 14;
  const thr = base * (opts.factor == null ? 1.6 : opts.factor);
  const groups = [[verses[0]]];
  gaps.forEach((x, i) => {
    if (x.g - x.n * base > thr) groups.push([]);
    groups[groups.length - 1].push(verses[i + 1]);
  });
  return groups;
}

/* 앵커가 없을 때의 최후 수단. 쓰면 결과에 '연 수 검수' todo 를 반드시 붙인다. */
export function groupByGap(items, factor) {
  factor = factor || 1.7;
  if (!items.length) return [];
  const gaps = [];
  for (let i = 1; i < items.length; i++) gaps.push(items[i].y - items[i - 1].y);
  const sorted = gaps.slice().sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 14;
  const groups = [[items[0]]];
  for (let i = 1; i < items.length; i++) {
    if (items[i].y - items[i - 1].y > median * factor) groups.push([]);
    groups[groups.length - 1].push(items[i]);
  }
  return groups;
}

/* ── 머리말 메타 ──
   자료마다 빠진 항목이 다르다(§2.2-7). 여러 파일에서 모으면 서로를 채운다:
   학기는 서술형 공략에만, 작가는 문제집 계열에만 인쇄돼 있다. */
export function headerMeta(doc) {
  const meta = { publisher: '', publisherAuthor: '', grade: '', semester: '', subject: '',
    unit: '', subUnit: '', unitTitle: '', workTitle: '', roundTitle: '', madeAt: '', sourceId: '' };
  const text = plainText(doc);
  const sid = text.match(/I\d{3}-\d{3}-\d{2}-\d{2}-\d+/);
  if (sid) meta.sourceId = sid[0];

  /* **머리말 띠만 본다.** 본문까지 뒤지면 학습목표 문장이나 '① 말하는 이(시적 화자)' 같은
     괄호 표기가 출판사로 잡힌다 — 실제로 그렇게 잡혔다. 메타는 지면 맨 위에만 있다.
     표지 쪽은 마스트헤드까지(80), 속쪽은 러닝헤더까지(55)만 본다. */
  const starts = sectionStarts(doc);
  for (const p of doc.pages || []) {
    const band = starts.includes(p.no) ? MAST_BAND : HEAD_BAND;
    for (const l of p.lines) {
      if (l.y >= band) continue;
      /* zb 문항번호(1pt)는 지면에 없는 글자다 — 머리말에 섞이면 출판사로 오인된다 */
      const t = stripChrome(joinSpans(l.spans.filter((s) => (s.size || 9) > TINY)));
      if (!t || t.length > 40) continue;
      /* 출판사(교과서 저자)와 학년-학기: '천재(노미숙)2-1' 또는 '천재(노미숙)' */
      const pub = t.match(/^(.{1,8}?)\(([^)]{1,12})\)(?:(\d)-(\d))?$/);
      if (pub && !meta.publisher) {
        meta.publisher = pub[1]; meta.publisherAuthor = pub[2];
        if (pub[3]) { meta.grade = '중' + pub[3]; meta.semester = pub[4]; }
      }
      /* 마스트헤드와 단원 코드가 **한 줄에 같이** 온다('중2 국어 1.문학을 펼치면(01)').
         학년을 떼어 내고 남은 것을 코드로 읽는다 — 줄 시작에 앵커를 걸면 둘 다 놓친다. */
      let rest = t.replace(/^\[[^\]]+\]\s*/, '');
      rest = rest.replace(/(중|고)\s*(\d)\s*\|?\s*국어\s*/, function (m0, a, b) {
        if (!meta.grade) meta.grade = a + b;
        meta.subject = '국어';
        return '';
      }).trim();
      /* '1.문학을 펼치면(01)' · '1-1.시의 목소리(1회)' · '1-1.(1)저녁 항구' 세 모양이 온다 */
      const code = rest.match(/^(\d+)(?:-(\d+))?\.\s*(?:\((\d+)\))?\s*(.+)$/);
      if (code) {
        if (!meta.unit) meta.unit = code[1];
        if (code[2] && !meta.subUnit) meta.subUnit = code[1] + '-' + code[2];
        if (code[3]) { if (!meta.workTitle) meta.workTitle = code[4]; }
        else if (code[2]) { if (!meta.roundTitle) meta.roundTitle = code[4]; }
        else if (!meta.unitTitle) meta.unitTitle = code[4];
      }
      if (!meta.madeAt) { const d = t.match(/^(\d{4}-\d{2}-\d{2})$/); if (d) meta.madeAt = d[1]; }
    }
  }
  if (!meta.subject && /국어/.test(text)) meta.subject = '국어';
  return meta;
}

/* ── id 규약 ──
   빈칸 id 는 **팩 전역 유일**이어야 한다(검증기가 works 루프 바깥에서 검사한다).
   파일마다 bl-001 부터 다시 세면 작품 2편을 한 팩에 담는 순간 배포가 막힌다 — 실제로 막혔다. */
export function blankId(workId, series, n) {
  const tag = { ihae: 'bl', yoyak: 'sum', danwon: 'dj', seosul: 'ss' }[series] || 'bl';
  return workId + ':' + tag + '-' + String(n).padStart(3, '0');
}
export function itemId(series, scope, no) {
  const tag = { danwon: 'dj', seosul: 'ss', ihae: 'ih', yoyak: 'yo' }[series] || 'it';
  return tag + '-' + scope + '-' + String(no).padStart(3, '0');
}
/* 내용에서 나오는 안정 키 — 쪽이 밀려도 안 바뀐다. 재추출 후 학생 진도를 잇는 데 쓴다. */
export function stableKey(parts) {
  return crypto.createHash('sha1').update(parts.join(' ')).digest('hex').slice(0, 8);
}

/* 학생 화면의 stem 만 innerHTML 로 들어간다(부정발문 <b>않은</b> 때문).
   자료에 '<보기>'가 24회 나오므로 이스케이프하지 않으면 화면에서 통째로 사라진다. */
export function escapeStem(text) {
  return String(text == null ? '' : text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* 좌우 거울 지면(요약노트)의 대조 게이트. 완전 일치를 요구하면 원문 오탈자로 떨어진다. */
export function similarity(a, b) {
  const x = String(a).replace(/\s+/g, ''), y = String(b).replace(/\s+/g, '');
  if (!x && !y) return 1;
  if (!x || !y) return 0;
  const n = Math.max(x.length, y.length);
  let same = 0;
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] === y[i]) same += 1;
  return same / n;
}
