#!/usr/bin/env node
/* WB 국어브레인 — 단원집중 spans → 지문 세트 · 객관식 문항 · Work 패치 (추출 파이프라인 2단계)
 *
 *   python3 naesin-ko/extract/pdf-spans.py <단원집중.pdf> > spans.json
 *   node naesin-ko/extract/build-danwon.mjs spans.json --scope 1-1 \
 *        --work "저녁 항구=w-jeonyeok" --review review/danwon-1-1.json > items-danwon.json
 *
 * 절차 전체는 naesin-ko/extract/README.md 를 본다. 공용 규칙은 spans-util.mjs 에 있다.
 *
 * 뽑는 것: sets(지문 세트) · items(객관식 mc5) · patches(작가·㉠ 기호) · review(검수 부속물)
 *
 * 이 자료의 성질 (전부 실측 — 천재(노미숙) 중2-1 1-1.시의 목소리(1회), 10쪽):
 *   ① 앞쪽 1~7 이 지문+문항, 뒤쪽 8~10 이 정답·해설이다. 경계는 문항 번호(#191919 13.7pt)가
 *      사라지는 지점 + [정답] 출현이다.
 *   ② 2단 조판(경계 x=310.0, 좌단 최대 우변 308.8 · 우단 최소 좌변 311.8)이라 pdf-spans 의
 *      line(y로 묶음)을 그대로 읽으면 좌·우단 문장이 섞인다. 읽기 순서는 반드시 기둥 우선이다 —
 *      p4 좌단 중간(y=282.2)의 ※ 세트 표시가 p4 우단 맨 위(y=64.3)의 11번보다 앞선다.
 *   ③ 흰 글씨는 정답이 아니라 zb 문항번호다. 이해완성의 '흰 글씨 = 빈칸 정답' 규칙을
 *      여기서 재사용하면 문항 번호가 빈칸으로 둔갑한다(실측 빈칸 정답 0개).
 *
 * 뽑지 '않는' 것 (검수에서 사람이 붙인다 — 자료에 근거가 없다):
 *   · 연(stanza) 구분 — 문제집은 시행을 19pt/38pt 교대 격자에 앉혀서, 간격 추정이 실측 3회 모두
 *     틀렸다(저녁 항구가 5연이 아니라 6연으로 갈린다). 연 구분은 이해완성 정본을 따른다.
 *   · targetRefs(문항→개념 단위) — 자료에 대응 정보가 없다. 해설 문장과 빈칸 정답을 문자열로
 *     맞추면 그럴듯하게 붙지만, 틀리면 오답이 엉뚱한 큐로 돌아가 학생이 상관없는 것을 외운다.
 *   · 배점 — 이 자료에는 표기가 아예 없다('점]' '점)' 검색 0건).
 *   · 서술형 루브릭 — 그래서 서술형 문항은 items 가 아니라 review.pending 으로 나간다.
 *     rubric 없는 essay 는 경고가 아니라 **오류**라 팩 전체 배포가 막힌다(pack-check.js).
 */
import * as U from './spans-util.mjs';

/* 본문 글꼴 크기 — 실측 size 분포(7.9:361 · 9.1:454). 나머지는 전부 지면 부속물이다:
   0.7/1.0 zb 문항번호 · 4.6 제작일 · 5.0 자료 식별번호 · 10.1/11.0 1쪽 흰 마스트헤드 ·
   13.7 문항 번호. y밴드 필터로는 못 거른다 — 식별번호·제작일이 해설쪽 좌단 '한가운데'
   (y=143.9 / 115.6)에 떠 있어서, 그대로 두면 19번 정답이 '③[단원집중]…'이 된다(재현함). */
const BODY_SIZES = [7.9, 9.1];

const CIRCLED = ['①', '②', '③', '④', '⑤'];
/* 부정발문 — 밑줄 서식 경계에서 공백이 먹혀 '적절하지 않은것은?' 으로 붙어 나온다.
   '않은 것은' 처럼 공백을 필수로 두면 실측 11건을 전부 놓친다. */
const NEGATIVE = /적절하지\s*않은|옳지\s*않은|아닌\s*것은/;
/* 지문 기호. 자료 전체에 ㉠만 5회(지문 2 · 발문 2 · 해설 1)지만 계열 전체를 받아 둔다.
   범위를 코드포인트로 적는다 — ㉠는 U+3260(원문자 한글)이고 ㉟는 U+325F(원문자 35)라
   /[㉠-㉟]/ 라고 쓰면 순서가 뒤집혀 정규식 자체가 죽는다(실제로 죽였다). U+3260~U+326D = ㉠~㉭. */
const MARK_SYM = /[\u3260-\u326d]/g;
/* 작가 줄 판정 — 좌표를 고정값으로 적지 않고 '기둥 왼끝에서 얼마나 오른쪽인가'로 본다.
   실측 오프셋: 작가 183.8~192.0pt(7/7) · 제목 0~85.9pt. 폭은 작가 17.0~25.2pt.
   제목 '산버들 가리어 꺾어'가 74.1pt라 폭만으로는 못 가른다 — 오프셋이 진짜 판별자다. */
const AUTHOR_DX = 150, AUTHOR_W = 45;

const pad2 = (n) => String(n).padStart(2, '0');

/* 줄 안의 본문 글자. **trim 하지 않는다** — PDF는 어절 경계 줄바꿈에만 끝공백을 넣어 두고
   ('…부모님의 ' + '고단한') 어절 중간에는 안 넣는다('…따라' + '서 화자가'). 여기서 trim 하면
   '비유를결합하여'가 되고, 줄을 ' '로 이으면 '따라 서 화자가'가 된다. 둘 다 재현했다. */
function bodyText(spans, sizes) {
  const body = spans.filter((s) => sizes.indexOf(s.size) >= 0);
  return body.length ? U.joinSpans(body) : '';
}
/* 여러 줄을 한 덩이로 — 구분자 없이 붙이고 **맨 끝에 한 번만** 판면 부속물을 턴다. */
function joinRows(rows) {
  return U.stripChrome(rows.map((r) => r.text).join(''));
}

/* 읽기 순서 스트림: 쪽마다 좌단 전체(y↑) → 우단 전체(y↑).
   y로 훑으면 지문·문항 순서가 뒤엉킨다(spans-util splitColumns 주석 참조). */
function readStream(pages, sizes) {
  const out = [];
  pages.forEach((page) => {
    const cols = U.splitColumns(page);          // 기본값 width/2 — 실측 경계 310.0과 여유 12pt
    ['L', 'R'].forEach((col, ci) => {
      cols[ci].slice().sort((a, b) => a.y - b.y).forEach((line) => {
        out.push({ page: page.no, col, y: line.y, spans: line.spans,
          text: bodyText(line.spans, sizes) });
      });
    });
  });
  return out;
}

export function buildDanwon(doc, opts) {
  opts = opts || {};
  const pages = (doc && doc.pages) || [];
  const meta = U.headerMeta(doc);
  const sizes = opts.bodySizes || BODY_SIZES;
  /* 문항 id 의 네임스페이스. zb 번호는 **파일 안에서만** 유일하다 — 단원집중 zb1~23 과
     서술형 공략 zb1~25 가 정면충돌하므로 시리즈 접두(U.itemId)와 이 scope 로 가른다. */
  const scope = String(opts.scope || meta.subUnit || 'u').replace(/[^A-Za-z0-9-]+/g, '-');
  const workIds = opts.workIds || {};          // 제목 → workId. 이해완성이 정한 id를 사람이 넘긴다.
  const section = opts.section || meta.roundTitle || '';

  const report = [], todo = [], candidates = [], pending = [];
  const sets = [], items = [], patches = [];

  /* ── 앞뒤 절 가르기 ──
     '마지막으로 문항 번호가 찍힌 쪽 다음부터 해설'. 쪽 수가 달라져도 산다(실측 문제 7 · 해설 3). */
  let lastProblem = -1;
  pages.forEach((p, i) => { if (U.itemMarkers(p.lines).length) lastProblem = i; });
  const problemPages = pages.slice(0, lastProblem + 1);
  const solutionPages = pages.slice(lastProblem + 1);

  /* ── 문항쪽 스트림에 표지 달기 ── */
  const ps = readStream(problemPages, sizes);
  ps.forEach((row) => {
    const one = [{ y: row.y, spans: row.spans }];
    const m = U.itemMarkers(one);
    if (m.length) row.itemNo = m[0].no;
    if (U.passageStarts(one).length) row.setStart = true;
  });
  const isEvent = (r) => r.itemNo != null || r.setStart;

  /* zb 고유번호 — **색이 아니라 크기로** 잡는다. 23개 중 21개는 흰색이지만 22·23번은 검정이다.
     색으로 잡으면 21개만 잡히고 1쪽 흰 머리말 '중/2/국어' 3개가 쓰레기로 섞인다. */
  const zbById = {};
  let zbCount = 0;
  problemPages.forEach((page) => {
    const cols = U.splitColumns(page);
    cols.forEach((lines) => {
      const marks = U.itemMarkers(lines);
      U.itemIds(lines).forEach((z) => {
        zbCount += 1;
        /* 같은 기둥에서 직전 문항 번호에 붙인다(실측 y차 +13.4~+16.7) */
        let owner = null;
        marks.forEach((m) => { if (m.y < z.y) owner = m; });
        if (owner) zbById[owner.no] = z.id;
      });
    });
  });

  /* ── 지문 세트 ──
     라벨 (가)(나)는 **세트 스코프**다. set1의 (가)=저녁 항구인데 set3의 (가)=비린내라뇨! 라서
     문서 전역 사전을 만들면 19·20번이 엉뚱한 작품에 붙는다. */
  function parseRegion(rows) {
    /* 기둥 왼끝 — 제목·작가 판정의 기준점. 쪽·기둥마다 따로 잰다(조판이 밀려도 산다). */
    const leftOf = {};
    rows.forEach((r) => {
      const body = r.spans.filter((s) => sizes.indexOf(s.size) >= 0);
      if (!body.length) return;
      const k = r.page + r.col;
      const min = Math.min.apply(null, body.map((s) => s.x));
      if (leftOf[k] == null || min < leftOf[k]) leftOf[k] = min;
    });
    const blocks = [];
    let cur = null;
    rows.forEach((r) => {
      const body = r.spans.filter((s) => sizes.indexOf(s.size) >= 0);
      if (!body.length) return;
      const label = U.passageLabels([{ y: r.y, spans: body }]);
      if (label.length) { cur = { label: label[0].label, rows: [], page: r.page }; blocks.push(cur); return; }
      if (!cur) { cur = { label: '', rows: [], page: r.page }; blocks.push(cur); }
      const isAuthor = body.length === 1 &&
        (body[0].x - (leftOf[r.page + r.col] || 0)) >= AUTHOR_DX && body[0].w < AUTHOR_W;
      cur.rows.push({ text: U.stripChrome(r.text), isAuthor, page: r.page });
    });
    return blocks.map((b) => {
      const ai = b.rows.findIndex((x) => x.isAuthor);
      /* 제목은 '가운데 정렬인가'가 아니라 '작가 줄 바로 앞인가'로 잡는다 — 가운데 정렬로 잡으면
         좌측 정렬된 시조 제목 하나를 놓쳐 6/7 이 된다(실측). */
      const author = ai >= 0 ? b.rows[ai].text : '';
      const title = ai > 0 ? b.rows[ai - 1].text : '';
      const lines = b.rows
        .filter((x, i) => !x.isAuthor && i !== ai - 1 && x.text)
        .map((x) => x.text);
      return { label: b.label, title, author, lines, page: b.page };
    });
  }

  const regions = [];
  ps.forEach((row, i) => {
    if (!row.setStart) return;
    let end = i + 1;
    while (end < ps.length && !isEvent(ps[end])) end += 1;   // 기둥·쪽을 넘어 이어진다
    regions.push({ no: regions.length + 1, at: i, works: parseRegion(ps.slice(i + 1, end)) });
  });

  /* ── 문항 블록 ──
     한 문항의 발문·보기·선지5개는 모두 같은 단, 같은 쪽에서 끝난다(실측 23/23). */
  const blocks = [];
  let curSet = null;
  ps.forEach((row, i) => {
    if (row.setStart) { curSet = regions.filter((g) => g.at === i)[0] || curSet; return; }
    if (row.itemNo == null) return;
    let end = i + 1;
    while (end < ps.length && ps[end].page === row.page && ps[end].col === row.col && !isEvent(ps[end])) end += 1;
    blocks.push({ no: row.itemNo, set: curSet, page: row.page, col: row.col, rows: ps.slice(i, end) });
  });

  function parseItem(b) {
    const rows = b.rows.filter((r) => r.text);
    let bogiAt = -1, firstChoice = -1, want = 0;
    const chIdx = [];
    rows.forEach((r, i) => {
      const t = r.text.trim();
      if (bogiAt < 0 && t === '<보기>') bogiAt = i;
      /* 선지는 **다음 번호가 맞을 때만** 새 선지로 본다. 그냥 '원문자로 시작하면 새 선지'로
         잡으면 <보기> 본문이나 이어지는 줄의 첫 글자에 걸린다. */
      if (want < 5 && t.indexOf(CIRCLED[want]) === 0) {
        if (firstChoice < 0) firstChoice = i;
        chIdx.push(i); want += 1;
      }
    });
    const stemEnd = bogiAt >= 0 ? bogiAt : (firstChoice >= 0 ? firstChoice : rows.length);
    const stem = joinRows(rows.slice(0, stemEnd));
    const bogi = bogiAt >= 0
      ? joinRows(rows.slice(bogiAt + 1, firstChoice >= 0 ? firstChoice : rows.length)) : '';
    const choices = chIdx.map((at, k) => ({
      no: k + 1,
      text: joinRows(rows.slice(at, chIdx[k + 1] == null ? rows.length : chIdx[k + 1]))
        .replace(new RegExp('^' + CIRCLED[k] + '\\s*'), ''),
    }));
    return { stem, bogi, choices };
  }

  /* ── 정답·해설 ──
     해설은 단과 쪽을 넘어 흐른다(p8 좌단 맨 아래 → p8 우단 맨 위 → p9 좌단 맨 위).
     블록 단위가 아니라 **스트림 단위**로 잘라야 한다. */
  const ss = readStream(solutionPages, sizes);
  const entryAt = {};
  solutionPages.forEach((page) => {
    U.splitColumns(page).forEach((lines, ci) => {
      U.solutionEntries(lines).forEach((e) => { entryAt[page.no + (ci ? 'R' : 'L') + ':' + e.y] = e.no; });
    });
  });
  const solutions = {};
  const solOrder = [];
  ss.forEach((row, i) => {
    const no = entryAt[row.page + row.col + ':' + row.y];
    if (no == null) return;
    let end = i + 1;
    while (end < ss.length && entryAt[ss[end].page + ss[end].col + ':' + ss[end].y] == null) end += 1;
    const raw = joinRows(ss.slice(i, end)).replace(new RegExp('^\\s*' + no + '\\)\\s*'), '');
    solOrder.push(no);
    const m = raw.match(/^\[정답\]\s*([\s\S]*?)\s*\[해설\]\s*([\s\S]*)$/);
    if (!m) { solutions[no] = { raw, answer: '', body: '' }; return; }
    solutions[no] = { raw, answer: m[1], body: m[2] };
  });

  /* 선지별 해설 — 마커 뒤 공백을 **강제**한다. 룩어헤드를 빼면 정답 근거 안의 '④의 설명은…'이
     분할점이 되어 14번이 깨진다(실측). 정답 선지에는 마커가 안 붙어 보통 4개만 나온다. */
  function splitPerChoice(body) {
    const hits = [];
    const re = /[①-⑤](?=\s)/g;
    let m;
    while ((m = re.exec(body))) hits.push({ no: CIRCLED.indexOf(m[0]) + 1, at: m.index });
    const main = (hits.length ? body.slice(0, hits[0].at) : body).trim();
    const per = {};
    hits.forEach((h, i) => {
      const to = hits[i + 1] ? hits[i + 1].at : body.length;
      if (!per[h.no]) per[h.no] = body.slice(h.at + 1, to).trim();
    });
    return { main, per, count: hits.length };
  }

  /* ── 세트 → 팩 ──
     works[].workId 가 없는 작품을 참조하면 배포가 막힌다. 이해완성이 정한 workId 를 사람이
     넘겨 주지 않은 세트는 팩에 내지 않고 검수로 보낸다 — 반쪽만 담으면 문항이 가리키는 지문이
     조용히 사라진다. */
  const setOf = {};        // regions.no → {setId, workId(단독일 때만)}
  regions.forEach((g) => {
    const setId = 's-dj-' + scope + '-' + pad2(g.no);
    const refs = g.works.map((w) => ({ label: w.label, workId: workIds[w.title] || '', kind: 'full' }));
    const marks = [];
    g.works.forEach((w) => {
      w.lines.forEach((ln) => {
        (ln.match(MARK_SYM) || []).forEach((sym) => {
          marks.push({ symbol: sym, workId: workIds[w.title] || '', title: w.title,
            anchorText: ln.slice(ln.indexOf(sym) + 1).trim(), setId, page: w.page });
        });
      });
      candidates.push({ kind: 'setText', setId, label: w.label, title: w.title,
        author: w.author, page: w.page, lines: w.lines });
      if (w.title || w.author) {
        candidates.push({ kind: 'attribution', setId, label: w.label,
          title: w.title, author: w.author, page: w.page });
      }
    });
    setOf[g.no] = { marks };
    /* 세트를 못 내더라도 문항에는 **세트 번호를 달아 둔다.** 병합기가 폴더 전체를 보고
       세트를 살릴 수 있고(정본 없는 작품 세우기 등), 그때 이 번호가 있어야 문항이 이어진다.
       세트가 끝내 안 살아나면 병합기가 이 번호로 '지문 없는 문항'을 알아보고 팩에서 뺀다. */
    setOf[g.no].setId = setId;
    if (refs.length && refs.every((r) => r.workId)) {
      const s = { setId, works: refs };
      if (marks.length) s.marks = marks.map((m) => ({ symbol: m.symbol, workId: m.workId, anchorText: m.anchorText }));
      sets.push(s);
      if (refs.length === 1) setOf[g.no].workId = refs[0].workId;
    } else {
      pending.push({ kind: 'set', setId,
        why: 'workId 를 못 찾은 작품이 있다 — --work "제목=workId" 로 넘기면 팩에 들어간다',
        works: g.works.map((w) => ({ label: w.label, title: w.title, author: w.author,
          workId: workIds[w.title] || null, lines: w.lines.length })) });
    }
  });

  /* ── 작품 패치 ──
     완전한 Work 를 내지 않는다. 같은 workId 로 Work 를 두 번 내면 '작품 id 중복'으로 배포가 막힌다.
     이 자료가 유일하게 갖고 있는 것(작가명·㉠ 기호)만 조각으로 낸다.
     실측: 같은 작품이 4개 세트에 7번 실린다(고유 3편) — 제목으로 접지 않으면 팩이 3배로 부푼다. */
  const byTitle = {};
  regions.forEach((g) => {
    g.works.forEach((w) => {
      if (!w.title) return;
      const p = byTitle[w.title] || (byTitle[w.title] = {
        workKey: w.title, title: w.title, author: '', marks: [], instances: 0 });
      p.instances += 1;
      if (!p.author && w.author) p.author = w.author;
    });
  });
  regions.forEach((g) => {
    (setOf[g.no].marks || []).forEach((m) => {
      const p = byTitle[m.title];
      if (p) p.marks.push({ symbol: m.symbol, anchorText: m.anchorText, setId: m.setId, page: m.page });
    });
  });
  Object.keys(byTitle).forEach((k) => {
    const p = byTitle[k];
    const patch = { workKey: p.workKey, title: p.title };
    if (p.author) patch.author = p.author;
    if (p.marks.length) patch.marks = p.marks;
    patch.source = { series: '단원집중', section, instances: p.instances };
    patches.push(patch);
  });

  /* ── 문항 → 팩 ── */
  let mc = 0, essay = 0, negCount = 0, bogiCount = 0, choiceCount = 0, perCount = 0;
  const missingSol = [], zbMismatch = [];
  blocks.forEach((b) => {
    const parsed = parseItem(b);
    const sol = solutions[b.no] || null;
    if (!sol) missingSol.push(b.no);
    const zbId = zbById[b.no] || '';
    if (zbId && zbId !== 'zb' + b.no + ')') zbMismatch.push(b.no + '↔' + zbId);

    const plainStem = U.stripItemIds(parsed.stem);      // 지면에 안 보이는 글자다 — 남으면 화면에 뜬다
    const isNegative = NEGATIVE.test(plainStem);
    if (isNegative) negCount += 1;
    /* stem 만 innerHTML 이다 — 자료의 '<보기>'(24회)를 안 막으면 화면에서 통째로 사라진다.
       나머지 필드는 앱이 esc() 하므로 평문이어야 한다. */
    let stem = U.escapeStem(plainStem);
    if (isNegative) stem = stem.replace(NEGATIVE, (s) => s.replace(/(않은|아닌)/, '<b>$1</b>'));

    const src = { series: '단원집중', section, no: b.no };
    if (zbId) src.zbId = zbId;
    const ref = b.set ? setOf[b.set.no] : null;

    /* 선지가 하나도 없으면 서술형이다. 객관식 문제집이라고 전부 mc5 로 캐스팅하면
       선지 0개짜리 Item 이 스키마 검증에서 튄다(실측 22·23번이 서술형). */
    if (!parsed.choices.length) {
      essay += 1;
      const draft = { id: U.itemId('danwon', scope, b.no), format: 'essay', source: src,
        stem, isNegative, targetRefs: [], rubric: [],
        modelAnswers: sol && sol.answer ? [sol.answer] : [],
        explanation: sol ? { main: (sol.body || '').trim() } : undefined };
      if (parsed.bogi) { bogiCount += 1; draft.bogi = { kind: 'text', text: parsed.bogi }; }
      if (ref && ref.setId) draft.setId = ref.setId;
      if (ref && ref.workId) draft.workId = ref.workId;
      /* rubric 없는 essay 는 **오류**라 팩 전체가 막힌다 — 저작이 끝난 것만 items 로 옮긴다. */
      pending.push({ kind: 'item', why: 'rubric(채점 요소)이 자료에 없다 — 저작한 뒤 items 로 옮긴다', item: draft });
      return;
    }

    mc += 1;
    choiceCount += parsed.choices.length;
    const it = {
      id: U.itemId('danwon', scope, b.no),
      format: 'mc5',
      source: src,
      stem,
      isNegative,
      choices: parsed.choices,
      /* 자료에 대응 정보가 없다 — 문자열로 억지 매칭하면 오답이 엉뚱한 빈칸 큐로 돌아간다. */
      targetRefs: [],
    };
    if (ref && ref.setId) it.setId = ref.setId;
    if (ref && ref.workId) it.workId = ref.workId;
    if (parsed.bogi) { bogiCount += 1; it.bogi = { kind: 'text', text: parsed.bogi }; }

    if (sol) {
      const ansNo = CIRCLED.indexOf((sol.answer || '').trim()) + 1;
      if (ansNo) it.answer = ansNo;
      const sp = splitPerChoice(sol.body || '');
      perCount += sp.count;
      /* 정답 선지에는 마커가 안 붙는다 — 앞 산문이 그 역할을 한다. main 과 perChoice[정답]
         양쪽에 넣어야 '선지별 해설 누락' 경고가 안 뜨고 학생 오답 피드백도 맞는다. */
      const per = sp.per;
      if (ansNo && !per[ansNo]) per[ansNo] = sp.main;
      it.explanation = { main: sp.main, perChoice: per };
    }
    items.push(it);
  });

  /* ── 검산 보고 ──
     counts 는 손으로 적어도 assemble 이 다시 세므로 조용히 무시된다 — 누락 검산은 여기서 한다. */
  const solCount = solOrder.length;
  report.push(`쪽 ${pages.length} (문항쪽 ${problemPages.length} · 해설쪽 ${solutionPages.length})`);
  report.push(`검산 — 문항번호 ${blocks.length} · zb id ${zbCount} · 해설 블록 ${solCount}` +
    (blocks.length === zbCount && zbCount === solCount ? ' (일치)' : ' ← 셋이 같아야 한다'));
  report.push(`지문 세트 ${regions.length} (팩에 낸 것 ${sets.length} · 검수 대기 ${regions.length - sets.length})`);
  report.push(`문항 ${blocks.length} = 객관식(mc5) ${mc} + 서술형 ${essay}(루브릭 미저작이라 review.pending)`);
  report.push(`선지 ${choiceCount} · 선지별 해설 ${perCount} · <보기> ${bogiCount} · 부정발문 ${negCount}`);
  report.push(`작품 인스턴스 ${regions.reduce((a, g) => a + g.works.length, 0)} → 고유 ${patches.length}` +
    ` · 작가 뽑힌 작품 ${patches.filter((p) => p.author).length}` +
    ` · ㉠ 앵커 ${patches.reduce((a, p) => a + (p.marks || []).length, 0)}`);

  if (blocks.length !== zbCount || zbCount !== solCount) {
    todo.push(`검산 불일치 — 문항 ${blocks.length} · zb ${zbCount} · 해설 ${solCount}. 뽑기가 샌 것이니 지면과 대조할 것`);
  }
  if (missingSol.length) todo.push(`해설을 못 찾은 문항: ${missingSol.join(',')}`);
  if (zbMismatch.length) todo.push(`zb 번호가 문항 번호와 다르다: ${zbMismatch.join(' ')} — source.no 를 확인할 것`);
  items.forEach((it) => {
    if (it.answer == null) todo.push(`${it.id} 정답을 못 읽었다 — 해설쪽 [정답] 표기를 확인할 것`);
    if (it.choices.length !== 5) todo.push(`${it.id} 선지가 ${it.choices.length}개다 — 단·쪽을 넘어간 문항일 수 있다`);
  });
  patches.forEach((p) => {
    if (!p.author) todo.push(`'${p.title}' 작가를 못 찾았다 — 작가 줄이 없는 무명 작품일 수 있다(candidates 확인)`);
  });
  todo.push('patches 는 조각이다 — 같은 workId 로 Work 를 두 번 내면 배포가 막힌다. 이해완성이 만든 works/*.json 에 합칠 것');
  todo.push('marks.anchorText 가 이해완성 본문 문자열 안에 **그대로** 없으면 오류다. 본문이 여기 없어 검증할 수 없다 —' +
    ' 특히 밑줄 경계에서 공백이 먹힌 행이 있으니(실측 \'있다우리 집 현관에서\') 정본과 대조해 고칠 것');
  todo.push('㉠는 세트 스코프다 — 같은 기호가 세트마다 다른 행을 가리킨다. work.marks 는 하나뿐이니 어느 것을 담을지 사람이 정한다');
  todo.push('작가·제목은 후보다 — <보기> 안 인용 출처가 같은 자리에 오면 함께 걸린다. candidates 의 attribution 을 보고 고를 것');
  todo.push('연(stanza) 구분은 이 지면에서 못 뽑는다(19pt/38pt 교대 격자) — 세트 본문을 담지 않고 이해완성 정본에 맡겼다.' +
    ' 지문이 발췌(소설·수필)면 works[].kind 를 excerpt 로 바꾸고 candidates 의 setText 를 text.paragraphs 로 옮길 것');
  todo.push('targetRefs 는 전부 빈 배열이다 — 자료에 문항↔개념 단위 대응이 없다. 검수에서 사람이 잇는다');
  todo.push('배점 표기가 자료에 없다 — 필요하면 검수에서 채운다');
  todo.push('작품이 여럿인 세트의 문항에는 workId 를 달지 않았다 — 발문이 가리키는 작품((가)/(나))을 사람이 정한다');
  todo.push(`문항 id 는 dj-${scope}-NNN 이다 — 같은 대단원에 다른 회차를 함께 담으면 --scope 를 달리해야 충돌하지 않는다`);
  if (pending.filter((p) => p.kind === 'item').length) {
    todo.push('서술형은 items 가 아니라 review.pending 에 있다 — rubric 을 저작한 뒤 옮긴다(빈 rubric 은 배포 차단 오류)');
  }

  return { series: 'danwon', patches, sets, items,
    review: { report, todo, candidates, pending }, meta };
}

/* ── CLI ── (import 될 때는 안 돈다) */
const invokedDirectly = process.argv[1] && /build-danwon\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  const fs = await import('node:fs');
  const argv = process.argv.slice(2);
  /* 값을 받는 플래그의 값이 파일 이름으로 오인되면 안 된다 — --work 는 여러 번 올 수 있어서
     indexOf 로는 못 가른다(첫 번째만 찾는다). 앞에서부터 한 번 훑으며 가른다. */
  const VALUED = ['scope', 'section', 'review', 'work'];
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
    console.error('사용법: node naesin-ko/extract/build-danwon.mjs <spans.json> [--scope 1-1]' +
      ' [--work "제목=workId"]... [--section 소제목] [--review review/danwon-1-1.json]');
    process.exit(1);
  }
  /* 제목 → workId 는 사람이 준다. 이해완성이 정한 id 를 모르면 세트를 팩에 낼 수 없다. */
  const workIds = {};
  works.forEach((pair) => {
    const eq = pair.indexOf('=');
    if (eq > 0) workIds[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  });

  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const det = U.detectSeries(doc);
  if (det.series && det.series !== 'danwon') {
    console.error(`이 파일은 단원집중이 아니라 '${U.SERIES_LABEL[det.series]}' 입니다 — 맞는 추출기를 쓰세요.`);
    process.exit(2);
  }
  const out = buildDanwon(doc, { scope: opt('scope'), section: opt('section'), workIds });

  /* 검수 부속물은 **팩과 다른 파일**로 나간다. 같은 파일에 넣으면 assemble 이 팩 루트로 복사하고
     관리 웹이 그대로 POST 해 학생 기기까지 간다(실측 팩의 16%가 그것이었다). */
  const reviewPath = opt('review');
  if (reviewPath) {
    fs.mkdirSync(reviewPath.replace(/\/[^/]*$/, '') || '.', { recursive: true });
    fs.writeFileSync(reviewPath, JSON.stringify({ series: out.series, meta: out.meta,
      patches: out.patches, ...out.review }, null, 1));
  }

  process.stderr.write('\n[단원집중 초안]\n' + out.review.report.map((r) => '  ' + r).join('\n') +
    '\n\n[검수에서 할 일]\n' + out.review.todo.map((t) => '  · ' + t).join('\n') +
    (reviewPath
      ? `\n\n패치 ${out.patches.length} · 후보 ${out.review.candidates.length} · 대기 ${out.review.pending.length} → ${reviewPath}\n\n`
      : `\n\n패치·후보·대기 ${out.patches.length + out.review.candidates.length + out.review.pending.length}건은 버렸습니다 — 남기려면 --review <경로> 를 주세요.\n\n`));

  /* stdout 은 팩에 그대로 들어갈 수 있는 모양이어야 한다 — sets·items 뿐이다. */
  console.log(JSON.stringify({ sets: out.sets, items: out.items }, null, 1));
}
