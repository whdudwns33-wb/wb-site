'use strict';
/* WB 한자브레인 — 문항 출제 엔진 (브라우저/Node 공용)
   "아는지 모르는지"를 학생의 자기 채점이 아니라 객관식·입력형 문항으로 판정한다(워드브레인 v1.2 의 교훈 —
   어린 학생일수록 "봤으니 안다"고 과대평가한다). 어종별로 다른 문항을 낸다.
     한자어 : 뜻 고르기 · 낱말 고르기 · 문맥 빈칸 · 한자 조립(빠진 훈음) · 한자 표기 고르기 · 낱말 쓰기
     고유어 : 뜻 고르기 · 낱말 고르기 · 문맥 빈칸 · 낱말 쓰기
     한자   : 훈음 고르기 · 한자 고르기 · 이 한자가 든 낱말 · 획수
   SRS 계단이 높을수록 어려운 유형(재인 → 회상 → 산출)으로 올라간다(인출 난이도 사다리).
   오답 보기는 같은 단어장·같은 단원에서 먼저 뽑는다 — 지금 함께 배우는 말들이 진짜 헷갈리는 짝이다.

   rnd 를 주입받아 결정적으로 돌릴 수 있다(테스트). 예문 빈칸 자리는 ctx.find(예문, 낱말) 로 찾는다 —
   book-check.js 의 findInExample 을 넣으면 활용형까지 잡고, 없으면 글자 그대로만 찾는다. */
var WBHQUIZ = (function () {

  var HEAD = {
    'w-meaning': '뜻 고르기', 'w-word': '낱말 고르기', 'w-cloze': '문맥 빈칸', 'w-build': '한자 조립',
    'w-hanja': '한자 표기', 'w-type': '낱말 쓰기',
    'c-hun': '훈음 고르기', 'c-char': '한자 고르기', 'c-word': '이 한자가 든 낱말', 'c-count': '획수 세기',
  };

  function shuffle(arr, rnd) {
    var a = arr.slice(), r = rnd || Math.random;
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(r() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function pickOne(arr, rnd) { return arr[Math.floor((rnd || Math.random)() * arr.length)]; }
  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, '').normalize('NFC').toLowerCase(); }
  function gloss(p) { return (p.hun || '') + ' ' + (p.eum || ''); }
  function hasGloss(p) { return !!(p && p.hun && p.eum); }
  function shapeOf(s) { return /다$/.test(String(s || '')) ? 'v' : 'n'; }

  /* 오답 보기 — 값이 서로 다르고 정답과 다른 것을 rank 가 낮은 순(같은 단원 → 같은 어종 → 나머지)으로 n개 */
  function distractors(pool, target, pickFn, n, rnd, rank) {
    var want = pickFn(target), seen = {}, buckets = [[], [], [], []];
    seen[want] = true;
    shuffle(pool, rnd).forEach(function (x) {
      if (x === target || (target.id != null && x.id === target.id)) return;
      var v = pickFn(x);
      if (!v || seen[v]) return;
      seen[v] = true;
      var r = rank ? rank(x) : 0;
      buckets[Math.max(0, Math.min(3, r))].push(v);
    });
    return buckets[0].concat(buckets[1], buckets[2], buckets[3]).slice(0, n);
  }
  /* 같은 단원·같은 어종·같은 꼴이 0, 같은 어종·같은 꼴 1, 같은 단원 2, 나머지 3.
     꼴(~다로 끝나는 용언 / 아니면 체언)을 먼저 본다 — 용언 정답에 명사 보기만 놓으면
     낱말을 몰라도 문법만으로 답이 보인다. */
  function wordRank(w) {
    var shape = shapeOf(w.word);
    return function (x) {
      var sameShape = shapeOf(x.word) === shape, sameType = x.type === w.type, sameUnit = !!(x.unit && x.unit === w.unit);
      if (sameUnit && sameType && sameShape) return 0;
      if (sameType && sameShape) return 1;
      if (sameUnit && sameType) return 2;
      return 3;
    };
  }
  function charRank(c) { return function (x) { return x.unit && x.unit === c.unit ? 0 : 1; }; }

  function choiceQ(kind, itemId, prompt, answer, opts, rnd, extra) {
    var q = { kind: kind, head: HEAD[kind], id: itemId, prompt: prompt, choices: shuffle([answer].concat(opts), rnd), answer: answer, input: false };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) q[k] = extra[k];
    return q;
  }

  /* 예문에서 낱말 자리를 ○○○로 — 자리를 못 찾으면 null(문항을 내지 않는다) */
  function blankExample(w, find) {
    if (!w || !w.example) return null;
    var ex = String(w.example), pos = null;
    if (typeof find === 'function') pos = find(ex, w.word);
    else { var i = ex.indexOf(w.word); if (i >= 0) { var j = i + w.word.length; while (j < ex.length && /[가-힣]/.test(ex[j])) j += 1; pos = { start: i, end: j }; } }
    if (!pos) return null;
    return ex.slice(0, pos.start) + '○○○' + ex.slice(pos.end);
  }

  /* ── 낱말 문항 ── */
  function wordLabel(w) { return w.word + (w.hanja ? ' (' + w.hanja + ')' : ''); }

  function qMeaning(w, ctx, rnd) {
    var d = distractors(ctx.words, w, function (x) { return x.meaning; }, 3, rnd, wordRank(w));
    if (d.length < 3) return null;
    return choiceQ('w-meaning', w._sid, wordLabel(w) + ' 의 뜻은?', w.meaning, d, rnd, { word: w.word, speak: w.word });
  }
  function qWord(w, ctx, rnd) {
    var d = distractors(ctx.words, w, function (x) { return x.word; }, 3, rnd, wordRank(w));
    if (d.length < 3) return null;
    return choiceQ('w-word', w._sid, '"' + w.meaning + '" — 이 뜻의 낱말은?', w.word, d, rnd, { word: w.word });
  }
  function qCloze(w, ctx, rnd) {
    var blanked = blankExample(w, ctx.find);
    if (!blanked) return null;
    var d = distractors(ctx.words, w, function (x) { return x.word; }, 3, rnd, wordRank(w));
    if (d.length < 3) return null;
    return choiceQ('w-cloze', w._sid, '빈칸에 알맞은 말은?\n' + blanked, w.word, d, rnd, { word: w.word, hint: w.meaning });
  }
  /* 한자 조립 — 가린 글자의 훈음을 고른다. 보기는 단어장의 다른 한자 훈음에서 */
  function qBuild(w, ctx, rnd) {
    if (!w.parts || w.parts.length < 2 || !w.parts.every(hasGloss)) return null;
    var idx = Math.floor((rnd || Math.random)() * w.parts.length);
    var hidden = w.parts[idx], answer = gloss(hidden);
    var mine = {}, seen = {}, opts = [];
    w.parts.forEach(function (p) { mine[gloss(p)] = true; });
    seen[answer] = true;
    var pool = (ctx.chars || []).filter(hasGloss);
    shuffle(pool, rnd).forEach(function (c) {
      if (opts.length >= 3) return;
      var v = gloss(c);
      if (seen[v] || mine[v]) return;
      seen[v] = true; opts.push(v);
    });
    if (opts.length < 3) return null;
    var shown = w.parts.map(function (p, i) { return i === idx ? '□' : p.ch; }).join('');
    return choiceQ('w-build', w._sid, w.word + ' — ' + shown + ' 에서 □의 뜻과 음은?', answer, opts, rnd, {
      word: w.word, hint: w.literal ? '조립하면: ' + w.literal : null, hiddenCh: hidden.ch,
    });
  }
  /* 한자 표기 — 같은 글자 수의 다른 낱말 한자를 보기로. 한자 하나를 나눠 쓰는 낱말(관측/관점)을 먼저 */
  function qHanja(w, ctx, rnd) {
    if (!w.hanja) return null;
    var mine = w.hanja.split('');
    var shares = function (x) { return x.hanja && x.hanja.split('').some(function (c) { return mine.indexOf(c) >= 0; }); };
    var d = distractors(ctx.words.filter(function (x) { return x.hanja && x.hanja.length === w.hanja.length; }), w,
      function (x) { return x.hanja; }, 3, rnd, function (x) { return shares(x) ? 0 : (x.unit === w.unit ? 1 : 2); });
    if (d.length < 3) return null;
    return choiceQ('w-hanja', w._sid, w.word + ' (' + w.meaning + ') 의 한자 표기는?', w.hanja, d, rnd, { word: w.word, big: true, bigChoices: true });
  }
  /* 낱말 쓰기 — 뜻을 보고 낱말을 입력한다(산출). 한자어는 한자를 힌트로 준다 */
  function qType(w) {
    if (!w.word || w.word.length < 2) return null;
    return {
      kind: 'w-type', head: HEAD['w-type'], id: w._sid, word: w.word,
      prompt: '"' + w.meaning + '" — 이 뜻의 낱말을 쓰세요', answer: w.word, input: true,
      hint: w.hanja ? '한자: ' + w.hanja : (w.word[0] + ' ' + new Array(w.word.length).join('_ ')).trim(),
    };
  }

  /* ── 한자 문항 ── */
  function charLabel(c) { return c.ch + (hasGloss(c) ? ' (' + gloss(c) + ')' : ''); }

  function qHun(c, ctx, rnd) {
    if (!hasGloss(c)) return null;
    var d = distractors(ctx.chars.filter(hasGloss), c, gloss, 3, rnd, charRank(c));
    if (d.length < 3) return null;
    return choiceQ('c-hun', c._sid, c.ch + ' 의 훈(뜻)과 음(소리)은?', gloss(c), d, rnd, { ch: c.ch, big: true });
  }
  function qChar(c, ctx, rnd) {
    if (!hasGloss(c)) return null;
    var d = distractors(ctx.chars, c, function (x) { return x.ch; }, 3, rnd, charRank(c));
    if (d.length < 3) return null;
    return choiceQ('c-char', c._sid, '"' + gloss(c) + '" 에 맞는 한자는?', c.ch, d, rnd, { ch: c.ch, bigChoices: true });
  }
  /* 이 한자가 든 낱말 — 정답은 그 글자를 쓰는 낱말, 보기는 안 쓰는 한자어 */
  function qCharWord(c, ctx, rnd) {
    var withC = ctx.words.filter(function (w) { return w.hanja && w.hanja.indexOf(c.ch) >= 0; });
    var without = ctx.words.filter(function (w) { return w.hanja && w.hanja.indexOf(c.ch) < 0; });
    if (!withC.length || without.length < 3) return null;
    var answer = pickOne(withC, rnd);
    var d = distractors(without, answer, function (x) { return x.word; }, 3, rnd, wordRank(answer));
    if (d.length < 3) return null;
    return choiceQ('c-word', c._sid, charLabel(c) + ' 이(가) 들어간 낱말은?', answer.word, d, rnd, { ch: c.ch, reveal: answer.word + ' (' + answer.hanja + ')' });
  }
  function qCount(c, ctx, rnd) {
    if (!c.strokes) return null;
    var cands = [];
    for (var k = -3; k <= 3; k++) if (k !== 0 && c.strokes + k >= 1) cands.push(String(c.strokes + k));
    var opts = shuffle(cands, rnd).slice(0, 3);
    if (opts.length < 3) return null;
    return choiceQ('c-count', c._sid, c.ch + ' 은(는) 몇 획일까요?', String(c.strokes), opts, rnd, { ch: c.ch, big: true, suffix: '획' });
  }

  var WORD_KINDS = { 'w-meaning': qMeaning, 'w-word': qWord, 'w-cloze': qCloze, 'w-build': qBuild, 'w-hanja': qHanja, 'w-type': qType };
  var CHAR_KINDS = { 'c-hun': qHun, 'c-char': qChar, 'c-word': qCharWord, 'c-count': qCount };
  /* 계단별 유형 순서 — 낮은 계단은 재인(뜻 고르기), 높은 계단은 산출(쓰기) */
  var PLAN = {
    word: [
      ['w-meaning', 'w-word', 'w-hanja'],
      ['w-word', 'w-hanja', 'w-meaning', 'w-build'],
      ['w-cloze', 'w-build', 'w-hanja', 'w-word'],
      ['w-type', 'w-cloze', 'w-build', 'w-hanja'],
    ],
    char: [
      ['c-hun', 'c-char'],
      ['c-char', 'c-word', 'c-hun'],
      ['c-word', 'c-count', 'c-char'],
      ['c-count', 'c-word', 'c-hun'],
    ],
  };
  function tier(step) { return step >= 4 ? 3 : (step >= 2 ? 2 : (step >= 1 ? 1 : 0)); }

  /* item: { kind:'word', w } | { kind:'char', c } — w/c 는 단어장 항목, _sid 는 SRS id.
     opts: { step, rnd, kinds(고정 유형 목록) } — 유형이 안 만들어지면 같은 계단의 다른 유형, 그래도 없으면 전부 */
  function makeQuestion(item, ctx, opts) {
    opts = opts || {};
    var rnd = opts.rnd || Math.random;
    var isChar = item.kind === 'char';
    var target = isChar ? item.c : item.w;
    if (!target) return null;
    var table = isChar ? CHAR_KINDS : WORD_KINDS;
    var order = opts.kinds || PLAN[isChar ? 'char' : 'word'][tier(opts.step || 0)];
    var all = Object.keys(table);
    var tried = {}, q = null;
    order.concat(all).forEach(function (k) {
      if (q || tried[k] || !table[k]) return;
      tried[k] = true;
      q = table[k](target, ctx, rnd);
    });
    return q;
  }

  /* 채점 — 첫 시도 정답 good, 힌트 뒤 정답 hard 는 화면이 정한다. 여기서는 맞고 틀림만 */
  function check(q, answer) {
    if (!q) return false;
    if (q.input) return norm(answer) === norm(q.answer);
    return String(answer) === String(q.answer);
  }

  /* 여러 항목 → 문항 목록. 못 낸 항목은 skipped 에 남긴다(화면이 카드로 보여 준다) */
  function session(items, ctx, opts) {
    opts = opts || {};
    var out = [], skipped = [];
    items.forEach(function (it) {
      var q = makeQuestion(it, ctx, { step: it.step || 0, rnd: opts.rnd, kinds: opts.kinds });
      if (q) out.push(q); else skipped.push(it);
    });
    return { questions: opts.max ? out.slice(0, opts.max) : out, skipped: skipped };
  }

  return {
    HEAD: HEAD, PLAN: PLAN, shuffle: shuffle, norm: norm, blankExample: blankExample,
    makeQuestion: makeQuestion, check: check, session: session, tier: tier,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WBHQUIZ;
