#!/usr/bin/env node
/* WB 국어브레인 — 이해완성 spans → 작품 정본 초안 (추출 파이프라인 2단계)
 *
 *   python3 naesin-ko/extract/pdf-spans.py <이해완성.pdf> > spans.json
 *   node naesin-ko/extract/build-ihae.mjs spans.json --workId w-xxx --title "작품명" \
 *        --review review/w-xxx.json > works/w-xxx.json
 *
 * 절차 전체는 naesin-ko/extract/README.md 를 본다. 공용 규칙은 spans-util.mjs 에 있다.
 *
 * 뽑는 것 (§8 Work): overview / text(연·행) / lineNotes / composition / blanks(개념 단위)
 *
 * 빈칸을 어떻게 아나:
 *   이해완성은 정답 글자의 **색만 흰색으로 바꿔** 지면에 그대로 싣는다. 도형이 아니다.
 *   흰 글씨라고 다 정답은 아니어서(연 라벨·마스트헤드도 흰색) spans-util 의 decoy 규칙이 거른다.
 *   같은 지면이 뒤쪽에 선생님용으로 한 번 더 실리지만 **좌표 대조는 쓰지 않는다** —
 *   실측 매칭률 2.8%였다(선생님용은 정답이 앞뒤 글자와 한 span 으로 합쳐지고 y도 어긋난다).
 *   뒤 절반은 대조가 아니라 **정본 검증용**으로 남겨 둔다.
 *
 * 뽑지 '않는' 것 (검수에서 사람이 붙인다):
 *   keywords·rhetoric·speaker 는 이해 전략 절의 표 구조가 작품마다 달라 자동 배정이 위험하다.
 *   '구절 + 해설' 쌍을 candidates 로 모아 두되 **정본 파일에는 넣지 않는다** —
 *   works/*.json 에 섞으면 병합기가 팩 루트로 복사해 학생에게 그대로 배달된다(실측 16%).
 */
import * as U from './spans-util.mjs';

/* 연 요지 라벨: '1연' · '5연~6연' · '1~2연' 세 표기가 다 온다 */
const RANGE = /^(\d+\s*연?\s*[~〜～]?\s*\d*\s*연)\s*(.*)$/;
const OVERVIEW_KEYS = ['갈래', '제재', '성격', '주제', '특징'];
const VERSE_MIN = 8.4, VERSE_MAX = 10.6;   // 시행 글꼴 크기 구간(실측)

export function buildIhae(doc, opts) {
  opts = opts || {};
  const pages = (doc && doc.pages) || [];
  const meta = U.headerMeta(doc);

  /* 학생용 절만 읽는다. 짝이 없으면(학생용만 받은 경우) 전체를 학생용으로 본다. */
  const halves = U.pairHalves(doc);
  const usePages = halves ? halves.student : pages;

  const workId = opts.workId || 'w-draft';
  const work = {
    workId,
    title: opts.title || meta.workTitle || '',
    author: opts.author || '',
    kind: opts.kind || 'poem',
    hasCanon: true,
    isExternal: false,
    unitPath: opts.unitPath || (meta.unit ? meta.unit + (meta.subUnit ? ' > ' + meta.subUnit : '') : ''),
    overview: { genre: [], material: '', tone: [], theme: '', features: [] },
    composition: [], text: { stanzas: [] }, lineNotes: [], marks: [],
    keywords: [], rhetoric: [], features: [], vocab: [],
    checklist: [], examPoints: [], appreciationPoints: [], blanks: [], notes: [],
  };
  const candidates = [];
  let blankNo = 0;

  function pushBlanks(r, path, label, page) {
    r.answers.forEach((a) => {
      blankNo += 1;
      work.blanks.push({
        /* 팩 전역 유일해야 한다 — 파일마다 001부터 세면 작품 2편을 한 팩에 담는 순간
           '빈칸 id 중복' 오류로 배포가 통째로 막힌다(실측 103건). */
        id: U.blankId(workId, 'ihae', blankNo),
        path, label, text: r.masked, answers: [a.text], page: page.no,
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
  function parseOverview(page, decoy) {
    const used = new Set();      // 건너뛸 줄을 **y로** 기억한다(기둥으로 자르면 인덱스가 달라진다)
    let cur = null;
    page.lines.forEach((line) => {
      const first = line.spans[0];
      const label = first && first.text.trim();
      if (OVERVIEW_KEYS.includes(label) && first.x < page.width * 0.2) {
        cur = label; used.add(line.y);
        const r = U.readLine({ y: line.y, spans: line.spans.slice(1) }, { decoy });
        if (r.full) assign(cur, r, page);
        return;
      }
      if (!cur) return;
      const r = U.readLine(line, { decoy });
      if (!r.full || U.isChromeLine(r.full)) return;
      /* 특징은 ①~⑤ 로 이어지고, 라벨 '특징'이 가운데 줄에 끼어 있기도 하다 */
      if (/^[①②③④⑤]/.test(r.full)) { used.add(line.y); cur = '특징'; assign(cur, r, page); return; }
      cur = null;
    });
    return used;
  }

  /* ── 본문·날개풀이·연 요지 ──
     x 로 기둥을 가른다. 이해완성 p2 만 왼쪽(본문+날개풀이)/오른쪽(연 요지) 구조이고
     경계는 width*0.60 이다(실측 여유 24pt) — 다른 시리즈의 width/2 를 쓰면 안 된다. */
  function parseBody(page, decoy, skipY) {
    const [left, right] = U.splitColumns(page, { at: page.width * 0.60, top: 0 });

    /* 오른쪽 — 연 요지 */
    right.forEach((line) => {
      const r = U.readLine(line, { decoy });
      if (!r.full || U.isChromeLine(r.full)) return;
      const m = r.full.match(RANGE);
      if (m) {
        work.composition.push({ range: m[1].replace(/\s+/g, ''), summary: m[2] || '' });
        if (m[2]) pushBlanks(r, 'composition.' + work.composition.length, m[1], page);
      } else if (work.composition.length) {
        const last = work.composition[work.composition.length - 1];
        last.summary = (last.summary + ' ' + r.full).trim();
        pushBlanks(r, 'composition.' + work.composition.length, last.range, page);
      }
    });

    /* 왼쪽 — 개관 표를 건너뛰고 시행과 날개풀이를 가른다 */
    const verses = [], notes = [];
    left.forEach((line) => {
      if (skipY.has(line.y)) return;
      const r = U.readLine(line, { decoy });
      if (!r.full || U.isChromeLine(r.full)) return;
      const size = line.spans[0].size;
      if (line.spans.some(U.isNote)) { notes.push({ y: line.y, r }); return; }
      if (size < VERSE_MIN || size > VERSE_MAX) return;
      verses.push({ y: line.y, r });
    });

    /* 연 나눔 — 시행 사이의 큰 간격은 대개 끼어든 날개풀이다(spans-util 주석 참조) */
    U.stanzaSplit(verses, notes).forEach((group, i) => {
      const stanza = { no: i + 1, lines: [] };
      group.forEach((v) => {
        stanza.lines.push(v.r.full);
        pushBlanks(v.r, 'text.stanza' + stanza.no, '본문', page);
      });
      work.text.stanzas.push(stanza);
    });

    /* 날개풀이는 바로 앞 시행에 건다 */
    notes.forEach((n) => {
      let anchor = '';
      for (const v of verses) if (v.y < n.y) anchor = v.r.full;
      work.lineNotes.push({ anchor, note: n.r.full });
      pushBlanks(n.r, 'lineNotes.' + work.lineNotes.length, '날개풀이', page);
      candidates.push({ kind: 'gloss', quote: anchor, text: n.r.full, page: page.no });
    });
  }

  /* ── 이해 전략 절 — 빈칸은 다 담고, 구절+해설은 후보로만 ── */
  function parseStrategy(page, decoy) {
    page.lines.forEach((line) => {
      const r = U.readLine(line, { decoy });
      if (!r.full || U.isChromeLine(r.full)) return;
      if (r.answers.length) pushBlanks(r, 'strategy.p' + page.no, '이해 전략', page);
      if (line.spans.some(U.isNote)) candidates.push({ kind: 'strategy', text: r.full, page: page.no });
    });
  }

  usePages.forEach((page, i) => {
    const decoy = U.makeDecoy(page, 'ihae');
    if (i === 0) return;                                  // 구조도 — 다이어그램이라 사람이 옮긴다
    if (i === 1) { const skip = parseOverview(page, decoy); parseBody(page, decoy, skip); return; }
    parseStrategy(page, decoy);
  });

  /* ── 초안 품질 보고 ── */
  const lines = work.text.stanzas.reduce((a, s) => a + s.lines.length, 0);
  /* 연 요지가 말하는 마지막 연 번호 — 본문 연 수와 어긋나면 검수 대상이다 */
  let maxStanza = 0;
  work.composition.forEach((c) => {
    (c.range.match(/\d+/g) || []).forEach((n) => { if (+n > maxStanza) maxStanza = +n; });
  });

  const report = [
    `페이지 ${pages.length}` + (halves ? ` (학생용 ${usePages.length}쪽 · 선생님용 ${halves.teacher.length}쪽은 검증용)` : ' (짝 지면 없음)'),
    `개관: 갈래 ${work.overview.genre.length} · 성격 ${work.overview.tone.length} · 특징 ${work.overview.features.length}` +
      (work.overview.theme ? ' · 주제 있음' : ' · 주제 없음(확인)'),
    `본문 ${work.text.stanzas.length}연 ${lines}행 · 날개풀이 ${work.lineNotes.length} · 연 요지 ${work.composition.length}`,
    `빈칸(개념 단위) ${work.blanks.length}`,
    `검수 후보(구절+해설) ${candidates.length}`,
  ];
  const todo = [];
  if (!work.title) todo.push('title(작품명) — 자료에 없으면 --title 로 넣는다');
  if (!work.author) todo.push('author(작가) — 이해완성에는 인쇄돼 있지 않다. 단원집중·서술형 공략에는 있다(§2.2-7)');
  if (!work.text.stanzas.length) todo.push('본문을 못 찾았다 — 지면 구성이 다른 자료일 수 있다');
  if (!work.blanks.length) todo.push('빈칸을 못 찾았다 — pdf-spans.py --colors 로 색 분포를 확인');
  if (!work.composition.length) todo.push('연 요지를 못 찾았다 — 오른쪽 기둥 위치를 확인');
  if (maxStanza && maxStanza !== work.text.stanzas.length) {
    todo.push(`연 수가 어긋난다 — 본문 ${work.text.stanzas.length}연인데 연 요지는 ${maxStanza}연까지 말한다. 지면과 대조할 것`);
  }
  todo.push('keywords·rhetoric·speaker 는 자동 배정하지 않았다 — candidates 를 보고 검수에서 채운다');
  todo.push('marks(㉠ 기호)는 단원집중 쪽 자료에서 나온다 — 여기서는 비어 있다');

  return { work, candidates, report, todo, meta, paired: !!halves };
}

/* ── CLI ── (import 될 때는 안 돈다) */
const invokedDirectly = process.argv[1] && /build-ihae\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  const fs = await import('node:fs');
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith('--'));
  const opt = (name) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
  };
  if (!file) {
    console.error('사용법: node naesin-ko/extract/build-ihae.mjs <spans.json> --workId w-xxx --title 제목' +
      ' [--author 작가] [--kind poem] [--review review/w-xxx.json]');
    process.exit(1);
  }
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const det = U.detectSeries(doc);
  if (det.series && det.series !== 'ihae') {
    console.error(`이 파일은 이해완성이 아니라 '${U.SERIES_LABEL[det.series]}' 입니다 — 맞는 추출기를 쓰세요.`);
    process.exit(2);
  }
  const out = buildIhae(doc, {
    workId: opt('workId'), title: opt('title'), author: opt('author'),
    kind: opt('kind'), unitPath: opt('unitPath'),
  });

  /* 검수 부속물은 **정본과 다른 파일**로 나간다. 같은 파일에 넣으면 병합기가 팩 루트로
     복사하고 관리 웹이 그대로 업로드해 학생 기기까지 간다(실측 팩의 16%가 그것이었다). */
  const reviewPath = opt('review');
  const review = { workId: out.work.workId, candidates: out.candidates, report: out.report, todo: out.todo, meta: out.meta };
  if (reviewPath) {
    fs.mkdirSync(reviewPath.replace(/\/[^/]*$/, '') || '.', { recursive: true });
    fs.writeFileSync(reviewPath, JSON.stringify(review, null, 1));
  }

  process.stderr.write('\n[이해완성 초안]\n' + out.report.map((r) => '  ' + r).join('\n') +
    '\n\n[검수에서 할 일]\n' + out.todo.map((t) => '  · ' + t).join('\n') +
    (reviewPath ? `\n\n검수 후보 ${out.candidates.length}건 → ${reviewPath}\n\n`
      : `\n\n검수 후보 ${out.candidates.length}건은 버렸습니다 — 남기려면 --review <경로> 를 주세요.\n\n`));

  /* stdout 은 팩에 그대로 들어갈 수 있는 모양이어야 한다 — work 하나뿐이다. */
  console.log(JSON.stringify({ work: out.work }, null, 1));
}
