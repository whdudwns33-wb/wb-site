'use strict';
/* 어휘 MCQ 생성기 — naesin/gen.js 의 단어 계열 포크(본문·청크 계열은 버린다: 외울 교과서 본문이 없다).
   가져온 것: 오답 충돌 방지(정답 단어의 다른 뜻·유의어·팩 안 유의어의 뜻까지 배제), rnd 주입, 시드 계약(strHash(id)+dayNo+(wrong+streak)).
   추가한 것: markConditions — ④문제 오독 처방(발문 표시 훈련)의 실제 모듈. A안이 처방으로 적었지만 파일 목록 어디에도 없던 것.
   단어 형태는 내신과 같다: { id, headword, meaningKo, pos, synonyms[], example{en,ko}, definition{en}, level } — 영어 300어 마스터가 이 형태로 온다. */
var WBHARU_G = (function () {
  function shuffle(arr, rnd) {
    var a = arr.slice(), r = rnd || Math.random;
    for (var i = a.length - 1; i > 0; i--) { var j = Math.min(i, Math.floor(r() * (i + 1))); var t = a[i]; a[i] = a[j]; a[j] = t; }   // rnd()==1.0 이면 j=i+1 로 튄다
    return a;
  }
  function norm(v) { return String(v == null ? '' : v).toLowerCase().replace(/\s+/g, ' ').trim(); }
  function meaningOf(w) {
    if (w.senses && w.senses.length && w.senses[0].meaningKo) return w.senses[0].meaningKo;
    var m = w.meaningKo;
    if (m && typeof m.length === 'number' && typeof m !== 'string') return m[0] || '';
    return m || '';
  }
  /* 단어가 가진 뜻 전부 — "간직하다, 보관하다"는 두 풀이다. 오답이 정답 단어의 다른 뜻과 같으면 정답이 둘인 문항이 된다. */
  function allMeanings(w) {
    var out = {}, list = [], m = w.meaningKo;
    if (m && typeof m !== 'string' && typeof m.length === 'number') list = list.concat(m); else if (m) list.push(m);
    (w.senses || []).forEach(function (s) { if (s && s.meaningKo) list.push(s.meaningKo); });
    list.forEach(function (v) { var whole = norm(v); if (whole) out[whole] = true; String(v).split(/[,;，、/]/).forEach(function (g) { var k = norm(g); if (k) out[k] = true; }); });
    return out;
  }
  function synonymHeads(w) { return (w.synonyms || []).map(function (s) { return norm(String(s).replace(/\(.*$/, '')); }).filter(Boolean); }
  function answerSet(target, pool) {
    var meanings = allMeanings(target), heads = {}, th = norm(target.headword);
    synonymHeads(target).forEach(function (h) { heads[h] = true; });
    (pool || []).forEach(function (w) {
      if (w === target) return;
      var hw = norm(w.headword); if (!hw) return;
      var syn = heads[hw] || (th && synonymHeads(w).indexOf(th) >= 0);
      if (!syn) return;
      heads[hw] = true;
      var wm = allMeanings(w), k; for (k in wm) if (Object.prototype.hasOwnProperty.call(wm, k)) meanings[k] = true;
    });
    return { meanings: meanings, heads: heads };
  }
  function related(set, w) {
    if (set.heads[norm(w.headword)]) return true;
    var wm = allMeanings(w), k; for (k in wm) if (Object.prototype.hasOwnProperty.call(wm, k) && set.meanings[k]) return true;
    return false;
  }
  /* 오답 n개 — 우선순위: 같은 원자(atomId)+같은 품사 → 같은 원자 → 같은 품사 → 나머지. 정답과 겹치는 보기는 금지. */
  function distractors(target, pool, pick, n, rnd) {
    var want = pick(target), seen = {}, both = [], grp = [], pos = [], rest = [];
    seen[norm(want)] = true;
    var set = answerSet(target, pool), k;
    for (k in set.meanings) if (Object.prototype.hasOwnProperty.call(set.meanings, k)) seen[k] = true;
    for (k in set.heads) if (Object.prototype.hasOwnProperty.call(set.heads, k)) seen[k] = true;
    shuffle(pool || [], rnd).forEach(function (w) {
      if (w === target || (w.id != null && w.id === target.id)) return;
      var v = pick(w); if (!v) return;
      var key = norm(v); if (seen[key]) return;
      if (related(set, w)) return;
      seen[key] = true;
      var g = !!(w.atomId && target.atomId && w.atomId === target.atomId), p = !!(w.pos && target.pos && w.pos === target.pos);
      if (g && p) both.push(v); else if (g) grp.push(v); else if (p) pos.push(v); else rest.push(v);
    });
    return both.concat(grp, pos, rest).slice(0, n);
  }
  function keyedChoices(answer, opts, rnd) {
    var texts = shuffle([answer].concat(opts), rnd);
    return { choices: texts.map(function (t, i) { return { key: String(i + 1), text: t }; }), answerKey: String(texts.indexOf(answer) + 1) };
  }

  /* 뜻 4지선다(정방향). opts.withUnknown 이면 '0' 모름 — 진단에서 찍기를 막는 버튼 */
  function vocabMcq(word, pool, rnd, opts) {
    rnd = rnd || Math.random; opts = opts || {};
    var answer = meaningOf(word); if (!answer) return null;
    var d = distractors(word, pool, meaningOf, 3, rnd);
    if (d.length < (opts.minDistractors == null ? 3 : opts.minDistractors)) return null;
    var kc = keyedChoices(answer, d, rnd);
    var q = { type: 'mcq', form: 'mcq4', wordId: word.id, atomId: word.atomId || null, prompt: word.headword, choices: kc.choices, answerKey: kc.answerKey };
    if (opts.withUnknown) { q.choices.push({ key: '0', text: '모름' }); q.unknownKey = '0'; }
    return q;
  }
  function vocabMcqReverse(word, pool, rnd) {
    rnd = rnd || Math.random;
    var answer = word.headword; if (!answer) return null;
    var d = distractors(word, pool, function (w) { return w.headword; }, 3, rnd);
    if (d.length < 3) return null;
    var kc = keyedChoices(answer, d, rnd);
    return { type: 'mcq', form: 'mcq4', wordId: word.id, atomId: word.atomId || null, prompt: meaningOf(word), choices: kc.choices, answerKey: kc.answerKey };
  }
  function lenHint(h) { return h.split(' ').map(function (w) { return w[0] + Array(w.length).join(' _'); }).join(' / '); }
  /* 철자 — 힌트 없는 완전 인출만 도달이다. hinted 를 문항에 실어 앱이 그대로 넘긴다. 정답은 headword 하나뿐. */
  function spelling(word, rnd, opts) {
    var h = String(word.headword || ''); if (!h) return null;
    var hinted = !(opts && opts.hint === false);
    return { type: 'spell', form: 'write', wordId: word.id, atomId: word.atomId || null, promptKo: meaningOf(word), hint: hinted ? lenHint(h) : null, hinted: hinted, answers: [h] };
  }
  var WORDCH = /[A-Za-z0-9]/, VOWEL = /[aeiou]/;
  function findSpan(text, needle, from) {
    if (!needle) return null;
    var low = String(text).toLowerCase(), n = String(needle).toLowerCase();
    for (var i = low.indexOf(n, from || 0); i >= 0; i = low.indexOf(n, i + 1)) {
      var before = text[i - 1], after = text[i + n.length];
      if (before && WORDCH.test(before) && WORDCH.test(n[0])) continue;
      if (after && WORDCH.test(after) && WORDCH.test(n[n.length - 1])) continue;
      return { start: i, len: n.length };
    }
    return null;
  }
  /* 표층형 후보 — keep 은 kept 로, call 은 calling 으로 나온다. 긴 후보부터. */
  function surfaceCandidates(word) {
    var h = String(word.headword || ''), seen = {}, out = [], list = [h].concat(word.irregularForms || []);
    if (h && h.indexOf(' ') < 0) {
      var grad = !word.pos || /^(a|adj|adv)/i.test(String(word.pos));
      list.push(h + 's', h + 'es', h + 'ed', h + 'ing'); if (grad) list.push(h + 'er', h + 'est');
      var last = h[h.length - 1], prev = h[h.length - 2] || '';
      if (last === 'e') { var st = h.slice(0, -1); list.push(st + 'ing', h + 'd'); if (grad) list.push(h + 'r', h + 'st'); }
      if (last === 'y' && prev && !VOWEL.test(prev)) { var sy = h.slice(0, -1); list.push(sy + 'ies', sy + 'ied'); if (grad) list.push(sy + 'ier', sy + 'iest'); }
      if (h.length >= 3 && !VOWEL.test(last) && /[a-z]/.test(last) && 'wxy'.indexOf(last) < 0 && VOWEL.test(prev) && !VOWEL.test(h[h.length - 3] || 'a')) {
        var dbl = h + last; list.push(dbl + 'ing', dbl + 'ed'); if (grad) list.push(dbl + 'er', dbl + 'est');
      }
    }
    list.forEach(function (c) { if (c && !seen[c]) { seen[c] = true; out.push(c); } });
    return out.sort(function (a, b) { return b.length - a.length; });
  }
  /* 예문 빈칸 — 예문 속 실제 표층형을 가린다. 없으면 null(없는 자리에 구멍을 뚫으면 답이 없는 문제가 된다). */
  function exampleCloze(word) {
    var ex = word.example || (word.senses && word.senses.length && word.senses[0].example) || null;
    if (!ex || !ex.en) return null;
    var cands = surfaceCandidates(word);
    for (var k = 0; k < cands.length; k++) {
      var sp = findSpan(ex.en, cands[k]); if (!sp) continue;
      var surface = ex.en.slice(sp.start, sp.start + sp.len), answers = [surface];
      if (word.headword && word.headword !== surface) answers.push(word.headword);
      return { type: 'cloze', form: 'write', wordId: word.id, atomId: word.atomId || null, textParts: [ex.en.slice(0, sp.start), ex.en.slice(sp.start + sp.len)], answers: answers, ko: ex.ko || null };
    }
    return null;
  }
  function definitionPick(word, pool, rnd) {
    rnd = rnd || Math.random;
    if (!word.definition || !word.definition.en) return null;
    var d = distractors(word, pool, function (w) { return w.headword; }, 3, rnd);
    if (d.length < 3) return null;
    var kc = keyedChoices(word.headword, d, rnd);
    return { type: 'defpick', form: 'mcq4', wordId: word.id, atomId: word.atomId || null, prompt: word.definition.en, choices: kc.choices, answerKey: kc.answerKey };
  }
  /* 유형 로테이션 — 같은 단어를 늘 같은 각도로 보면 답을 외운다. 자리는 단어 상태(id·오답·연속·날짜)로 정한다. */
  var ROTATION = ['mcq', 'cloze', 'defpick', 'spell', 'reverse'];
  function rotate(word, pool, state, dayNo, rnd) {
    var start = (strHash(word.id) + (dayNo || 0) + ((state && (state.wrong + state.streak)) || 0)) % ROTATION.length;
    for (var i = 0; i < ROTATION.length; i++) {
      var q = null;
      switch (ROTATION[(start + i) % ROTATION.length]) {
        case 'mcq': q = vocabMcq(word, pool, rnd); break;
        case 'cloze': q = exampleCloze(word); break;
        case 'defpick': q = definitionPick(word, pool, rnd); break;
        case 'spell': q = spelling(word, rnd, { hint: false }); break;
        case 'reverse': q = vocabMcqReverse(word, pool, rnd); break;
      }
      if (q) return q;
    }
    return null;
  }
  function strHash(s) { var h = 0, str = String(s == null ? '' : s); for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0x7fffffff; return h; }

  /* ── 발문 표시 훈련(④ 문제 오독 처방) ──
     발문에서 조건 토큰(단위 · 부정 발문 · 수량 한정 · 비교 극 · 숫자)을 찾아 탭 대상으로 만든다. 전부 표시해야 선택지가 열린다.
     구현 30줄이고, 없으면 ④가 처방 없는 라벨이 된다. */
  var COND = [
    { kind: 'negative', re: /(옳지\s*않은|일치하지\s*않는|아닌|틀린|없는)\s*것/g },
    { kind: 'all', re: /(모두|전부|전체)/g },
    { kind: 'extreme', re: /(가장\s*(큰|작은|긴|짧은|많은|적은|알맞은|먼|가까운)|최대|최소|처음|마지막)/g },
    { kind: 'quantity', re: /몇\s*(개|명|L|mL|cm|m|km|g|kg|분|초|시간|%|원|도막|번)/g },
    { kind: 'unit', re: /\d+(?:[.,]\d+)?\s*(cm³|cm²|m³|m²|km²|cm|mm|km|m|mL|L|kg|g|%|원|명|개|분|초|시간|점|일|회)/g },
    { kind: 'number', re: /\d+(?:[.,]\d+)?(?:\s\d+\/\d+|\/\d+)?/g }
  ];
  function markConditions(item) {
    var text = String(item && item.instructionKo || ''), spans = [];
    function taken(s, e) { return spans.some(function (x) { return s < x.end && x.start < e; }); }
    COND.forEach(function (c) {
      var re = new RegExp(c.re.source, 'g'), m;
      while ((m = re.exec(text))) { if (!taken(m.index, m.index + m[0].length)) spans.push({ kind: c.kind, start: m.index, end: m.index + m[0].length, text: m[0] }); if (!m[0].length) re.lastIndex++; }
    });
    spans.sort(function (a, b) { return a.start - b.start; });
    var parts = [], cur = 0;
    spans.forEach(function (s) { if (s.start > cur) parts.push({ text: text.slice(cur, s.start) }); parts.push({ text: s.text, cond: s.kind }); cur = s.end; });
    if (cur < text.length) parts.push({ text: text.slice(cur) });
    return { parts: parts, required: spans.length, kinds: spans.map(function (s) { return s.kind; }) };
  }

  return { shuffle: shuffle, meaningOf: meaningOf, allMeanings: allMeanings, answerSet: answerSet, related: related, distractors: distractors, keyedChoices: keyedChoices,
           vocabMcq: vocabMcq, vocabMcqReverse: vocabMcqReverse, spelling: spelling, exampleCloze: exampleCloze, definitionPick: definitionPick, surfaceCandidates: surfaceCandidates, findSpan: findSpan,
           rotate: rotate, ROTATION: ROTATION, strHash: strHash, markConditions: markConditions, COND: COND };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WBHARU_G;
