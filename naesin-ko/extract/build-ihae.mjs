#!/usr/bin/env node
/* WB 국어브레인 — 이해완성 spans → 작품 정본 초안 (추출 파이프라인 2단계)
 *
 *   python3 naesin-ko/extract/pdf-spans.py <이해완성.pdf> > spans.json
 *   node naesin-ko/extract/build-ihae.mjs spans.json --workId w-xxx --title "작품명" > works/w-xxx.json
 *
 * 절차 전체는 naesin-ko/extract/README.md 를 본다.
 *
 * 뽑는 것 (§8 Work): overview / text(연·행) / lineNotes / composition / blanks(개념 단위)
 *
 * 빈칸을 어떻게 아나 — 이 파이프라인의 핵심:
 *   이해완성은 같은 지면이 앞은 학생용, 뒤는 선생님용(정답)으로 두 번 실린다.
 *   그런데 **텍스트 레이어는 두 쪽이 같고, 학생용은 정답 글자의 색만 흰색으로 바꿔 둔다.**
 *   그래서 지면을 이미지로 대조할 필요가 없다 — 두 쪽의 같은 자리를 비교해
 *   "학생용에서는 안 보이는데 선생님용에서는 보이는 글자" = 빈칸 정답이다.
 *
 *   흰 글씨라고 다 빈칸은 아니다: 초록 박스 안의 '1연' 같은 라벨도 흰색이다.
 *   그것들은 선생님용에서도 흰색이라 이 대조에서 저절로 걸러진다.
 *
 * 뽑지 '않는' 것 (검수에서 사람이 붙인다):
 *   keywords·rhetoric·speaker는 이해 전략 절의 표 구조가 작품마다 달라 자동 배정이 위험하다.
 *   대신 '구절 + 해설' 쌍을 candidates 로 모아 둔다. 초안은 초안이다 — 검수 게이트(§7[3])를
 *   건너뛰지 않는다. */

const PALE = ['#ffffff', '#e5e5e5', '#e6e6e6', '#fefefe'];        // 지면에서 안 보이는 색
const NOTE_COLORS = ['#2b5686', '#215ab9', '#3e88ab', '#1f4e79']; // 날개풀이(파란 계열)
const OVERVIEW_KEYS = ['갈래', '제재', '성격', '주제', '특징'];

/* 판면 부속물(쪽번호·자료 식별번호)은 **줄 안에 섞여 들어온다**.
   PDF 한 행이 "…깊이 사색함. I410-141-25-99-091285995- 2 -" 처럼 본문 + 부속물이라
   줄 전체를 버리는 필터로는 못 거른다. 토큰 단위로 지우고 남은 게 없으면 그 줄을 버린다. */
const CHROME_TOKENS = [
  /-\s*\d{1,3}\s*-\s*$/,                   // 쪽번호 '- 2 -' — 식별번호보다 **먼저** 지운다.
  /I?\d{3}-\d{3}-\d{2}-\d{2}-\d{4,}-?/g,   // 자료 식별번호(ISNI 유사 표기)
];                                          // 순서를 바꾸면 식별번호의 끝 하이픈을 먹어 쪽번호가 남는다
const BOILER = /콘텐츠산업|저작권법|제작연월일|제작자|선생님용|중\d\s*\|\s*국어/;

export function stripChrome(t) {
  var s = String(t || '');
  CHROME_TOKENS.forEach(function (re) { s = s.replace(re, ' '); });
  return s.replace(/\s+/g, ' ').trim();
}
const chrome = (t) => { const s = stripChrome(t); return !s || BOILER.test(s); };

const isPale = (s) => PALE.includes(s.color);
const isNote = (s) => NOTE_COLORS.includes(s.color);

/* spans 문서 하나 → { work, candidates, report, todo }.
   순수 함수다 — 파일도 argv도 읽지 않는다(테스트가 합성 fixture를 그대로 먹인다). */
export function buildIhae(doc, opts) {
  opts = opts || {};
  const pages = (doc && doc.pages) || [];

  /* ── 학생용 / 선생님용 짝 맞추기 ──
     같은 지면이 앞뒤로 두 번 있고, 뒤쪽에서 정답이 검정으로 바뀐다.
     짝이 없으면(학생용만 받은 경우) 대조 없이 '안 보이는 색 = 빈칸'으로 떨어진다. */
  const half = Math.floor(pages.length / 2);
  const paleCount = (p) => p.lines.reduce((a, l) => a + l.spans.filter(isPale).length, 0);
  const front = pages.slice(0, half), back = pages.slice(half);
  const paired = half > 0 && back.length === front.length &&
    paleCount(front[1] || front[0]) > paleCount(back[1] || back[0]);
  const usePages = paired ? front : pages;

  /* 같은 자리(x·y 근사)의 선생님용 span 이 보이는 색인가 */
  function answerAt(pageIdx, lineY, span) {
    if (!paired) return true;                     // 대조본이 없으면 색만 믿는다
    const tp = back[pageIdx];
    if (!tp) return true;
    for (const l of tp.lines) {
      if (Math.abs(l.y - lineY) > 4) continue;
      for (const s of l.spans) {
        if (Math.abs(s.x - span.x) > 3) continue;
        if (s.text.trim() !== span.text.trim()) continue;
        return !isPale(s);                        // 선생님용에서 보이면 → 빈칸 정답
      }
    }
    return true;
  }

  const work = {
    workId: opts.workId || 'w-draft',
    title: opts.title || '', author: opts.author || '',
    kind: 'poem', hasCanon: true, isExternal: false, unitPath: opts.unitPath || '',
    overview: { genre: [], material: '', tone: [], theme: '', features: [] },
    composition: [], text: { stanzas: [] }, lineNotes: [], marks: [],
    keywords: [], rhetoric: [], features: [], vocab: [],
    checklist: [], examPoints: [], appreciationPoints: [], blanks: [], notes: [],
  };
  const candidates = [];
  let blankNo = 0;

  /* 행 하나를 "정답을 채운 원문" + "빈칸으로 가린 문맥" 두 벌로 만든다.
     정본에는 채운 쪽이, blanks 에는 가린 쪽이 들어간다. */
  function readLine(line, pageIdx) {
    let full = '', masked = '', answers = [];
    line.spans.forEach((s) => {
      const t = s.text;
      const a = t.trim();
      if (isPale(s) && a && answerAt(pageIdx, line.y, s)) {
        answers.push(a);
        full += t;
        masked += '□'.repeat(a.length);
      } else {
        full += t; masked += t;
      }
    });
    return { full: stripChrome(full), masked: stripChrome(masked), answers };
  }

  function pushBlanks(r, path, label, page) {
    r.answers.forEach((a) => {
      blankNo += 1;
      work.blanks.push({
        id: 'bl-' + String(blankNo).padStart(3, '0'),
        path, label, text: r.masked, answers: [a], page: page.no,
      });
    });
  }

  function assign(key, r, page) {
    const v = r.full;
    if (key === '갈래') work.overview.genre = v.split(/[,·]/).map((x) => x.trim()).filter(Boolean);
    else if (key === '제재') work.overview.material = v;
    else if (key === '성격') work.overview.tone = v.split(/[,·]/).map((x) => x.trim()).filter(Boolean);
    else if (key === '주제') work.overview.theme = v;
    else if (key === '특징') work.overview.features.push(v.replace(/^[①②③④⑤]\s*/, ''));
    pushBlanks(r, 'overview.' + key, key, page);
  }

  /* ── 개관 표 ── */
  function parseOverview(page, pageIdx) {
    const used = new Set();
    let cur = null;
    page.lines.forEach((line, li) => {
      const first = line.spans[0];
      const label = first && first.text.trim();
      const isLabel = OVERVIEW_KEYS.includes(label) && first.x < page.width * 0.2;
      if (isLabel) {
        cur = label;
        used.add(li);
        const r = readLine({ y: line.y, spans: line.spans.slice(1) }, pageIdx);
        if (r.full) assign(cur, r, page);
        return;
      }
      if (!cur) return;
      const r = readLine(line, pageIdx);
      if (!r.full || chrome(r.full)) return;
      /* 특징은 ①~⑤ 로 이어지고, 라벨 '특징'이 가운데 줄에 있을 수도 있다 */
      if (cur === '특징' && /^[①②③④⑤]/.test(r.full)) { used.add(li); assign(cur, r, page); return; }
      if (/^[①②③④⑤]/.test(r.full)) { used.add(li); cur = '특징'; assign(cur, r, page); return; }
      cur = null;
    });
    return used;
  }

  /* ── 본문·날개풀이·연 요지 ──
     x 위치로 기둥을 가른다. 연 나눔은 행 간격이 벌어지는 자리다(빈 줄이 텍스트에 없다). */
  function parseBody(page, pageIdx, skip) {
    const RIGHT = page.width * 0.60;
    const body = [];
    page.lines.forEach((line, li) => {
      if (skip.has(li)) return;
      const left = line.spans.filter((s) => s.x < RIGHT);
      const right = line.spans.filter((s) => s.x >= RIGHT);

      if (right.length) {
        const rr = readLine({ y: line.y, spans: right }, pageIdx);
        const m = rr.full.match(/^(\d+\s*연(?:\s*~\s*\d+\s*연)?)\s*(.*)$/);
        if (m) {
          work.composition.push({ range: m[1].replace(/\s+/g, ''), summary: m[2] || '' });
          if (m[2]) pushBlanks(rr, 'composition.' + work.composition.length, m[1], page);
        } else if (work.composition.length && rr.full && !chrome(rr.full)) {
          const last = work.composition[work.composition.length - 1];
          last.summary = (last.summary + ' ' + rr.full).trim();
          pushBlanks(rr, 'composition.' + work.composition.length, last.range, page);
        }
      }
      if (!left.length) return;
      const lr = readLine({ y: line.y, spans: left }, pageIdx);
      if (!lr.full || chrome(lr.full)) return;
      body.push({ y: line.y, r: lr, note: left.some(isNote), size: left[0].size });
    });

    /* 시행과 날개풀이를 갈라 담는다. 시행 사이 간격이 평소보다 크면 새 연이다. */
    const verses = body.filter((b) => !b.note && b.size >= 8.4 && b.size <= 10.6);
    const gaps = [];
    for (let i = 1; i < verses.length; i++) gaps.push(verses[i].y - verses[i - 1].y);
    gaps.sort((a, b) => a - b);
    const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 14;
    let stanza = null;
    body.forEach((b) => {
      if (b.note) {
        const anchor = stanza && stanza.lines.length ? stanza.lines[stanza.lines.length - 1] : '';
        work.lineNotes.push({ anchor, note: b.r.full });
        pushBlanks(b.r, 'lineNotes.' + work.lineNotes.length, '날개풀이', page);
        candidates.push({ kind: 'gloss', quote: anchor, text: b.r.full, page: page.no });
        return;
      }
      if (b.size < 8.4 || b.size > 10.6) return;
      const prev = verses[verses.indexOf(b) - 1];
      const newStanza = !stanza || (prev && b.y - prev.y > median * 1.7);
      if (newStanza) { stanza = { no: work.text.stanzas.length + 1, lines: [] }; work.text.stanzas.push(stanza); }
      stanza.lines.push(b.r.full);
      pushBlanks(b.r, 'text.stanza' + stanza.no, '본문', page);
    });
  }

  /* ── 이해 전략 절 — 빈칸은 다 담고, 구절+해설은 후보로만 ── */
  function parseStrategy(page, pageIdx) {
    page.lines.forEach((line) => {
      const r = readLine(line, pageIdx);
      if (!r.full || chrome(r.full)) return;
      if (r.answers.length) pushBlanks(r, 'strategy.p' + page.no, '이해 전략', page);
      if (line.spans.some(isNote)) candidates.push({ kind: 'strategy', text: r.full, page: page.no });
    });
  }

  usePages.forEach((page, i) => {
    if (i === 0) return;                                  // 구조도 — 다이어그램이라 사람이 옮긴다
    if (i === 1) { const skip = parseOverview(page, i); parseBody(page, i, skip); return; }
    parseStrategy(page, i);
  });

  /* ── 초안 품질 보고 ── */
  const verses = work.text.stanzas.reduce((a, s) => a + s.lines.length, 0);
  const report = [
    `페이지 ${pages.length}` + (paired ? ` (학생용 ${usePages.length}쪽 사용 · 선생님용과 대조해 빈칸 판정)` : ' (대조본 없음 — 색만으로 빈칸 판정)'),
    `개관: 갈래 ${work.overview.genre.length} · 성격 ${work.overview.tone.length} · 특징 ${work.overview.features.length}` +
      (work.overview.theme ? ' · 주제 있음' : ' · 주제 없음(확인)'),
    `본문 ${work.text.stanzas.length}연 ${verses}행 · 날개풀이 ${work.lineNotes.length} · 연 요지 ${work.composition.length}`,
    `빈칸(개념 단위) ${work.blanks.length}`,
    `검수 후보(구절+해설) ${candidates.length}`,
  ];
  const todo = [];
  if (!work.title) todo.push('title(작품명) — 자료에 없으면 --title 로 넣는다');
  if (!work.author) todo.push('author(작가) — 이해완성에는 인쇄돼 있지 않다(§2.2-7)');
  if (!work.text.stanzas.length) todo.push('본문을 못 찾았다 — 지면 구성이 다른 자료일 수 있다');
  if (!work.blanks.length) todo.push('빈칸을 못 찾았다 — pdf-spans 출력의 color 분포를 확인');
  if (!work.composition.length) todo.push('연 요지를 못 찾았다 — 오른쪽 기둥 위치를 확인');
  todo.push('keywords·rhetoric·speaker는 자동 배정하지 않았다 — candidates 를 보고 검수에서 채운다');
  todo.push('marks(㉠ 기호)는 문제집 쪽 자료에서 나온다 — 여기서는 비어 있다');

  return { work, candidates, report, todo, paired };
}

/* ── CLI ── (import 될 때는 안 돈다) */
const invokedDirectly = process.argv[1] && /build-ihae\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  const fs = await import('node:fs');
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith('--'));
  const opt = (name) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
  };
  if (!file) {
    console.error('사용법: node naesin-ko/extract/build-ihae.mjs <spans.json> [--workId w-xxx] [--title 제목] [--author 작가]');
    process.exit(1);
  }
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = buildIhae(doc, {
    workId: opt('workId'), title: opt('title'), author: opt('author'), unitPath: opt('unitPath'),
  });
  process.stderr.write('\n[이해완성 초안]\n' + out.report.map((r) => '  ' + r).join('\n') +
    '\n\n[검수에서 할 일]\n' + out.todo.map((t) => '  · ' + t).join('\n') + '\n\n');
  console.log(JSON.stringify({
    work: out.work, candidates: out.candidates, _report: out.report, _todo: out.todo,
  }, null, 1));
}
