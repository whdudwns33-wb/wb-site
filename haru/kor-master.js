'use strict';
/* 국어 어휘·문법 마스터 생성기 — 데이터(kor-master-data.json, 자체 창작)에서 런타임에 문항을 파생한다. 문항을 저장하지 않는다.
   유형: 낱말의 짜임(mcq-classify) · 한자어 낱말 가족(mcq-classify) · 다의어 문맥(mcq-context) · 호응(mcq-fix) · 표현법 식별(figure-id).
   국어 독해 지문은 여기서 나오지 않는다 — 지문은 T0(자체·공공누리)·T2(재창작)·T3(종이)로만(기획서 §6-4). */
var WBHARU_KM = (function () {
  function choose(rnd, arr) { return arr[Math.floor(rnd() * arr.length)]; }
  function shuffle(arr, rnd) { var a = arr.slice(); for (var i = a.length - 1; i > 0; i--) { var j = Math.min(i, Math.floor(rnd() * (i + 1))); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  function keyed(answer, others, rnd, tag) {
    var all = shuffle([{ text: answer, answer: true }].concat(others.map(function (o) { return typeof o === 'string' ? { text: o } : o; })), rnd);
    var choices = all.map(function (c, i) { var o = { key: String(i + 1), text: c.text }; if (!c.answer) { o.atomId = c.atomId || null; o.errKind = c.errKind || (tag || 'concept'); } return o; });
    return { choices: choices, answerKey: String(all.map(function (c) { return !!c.answer; }).indexOf(true) + 1) };
  }
  function strHash(s) { var h = 0, str = String(s); for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0x7fffffff; return h; }
  function item(tpl, atomId, q, kc, expl, stem) {
    var it = { gen: 'kor-master', tpl: tpl, atomId: atomId, form: 'mcq4', isNegative: /않은|다른 하나/.test(q), answerCount: 1, instructionKo: q, choices: kc.choices, answerKey: kc.answerKey, explanationKo: expl };
    if (stem) it.stemKo = stem;
    it.itemId = 'km:' + tpl + ':' + strHash(q + kc.choices.map(function (c) { return c.text; }).join('|')).toString(36);
    return it;
  }

  /* 1. 낱말의 짜임 — "짜임이 다른 하나는?" (같은 종류 3 + 다른 종류 1) 또는 "'○○'의 짜임은?" */
  function wordBuild(data, rnd) {
    var byKind = {}; data.wordBuild.forEach(function (w) { (byKind[w.kind] = byKind[w.kind] || []).push(w); });
    var kinds = Object.keys(byKind).filter(function (k) { return byKind[k].length >= 3; });
    if (kinds.length < 2) return null;
    if (rnd() < 0.5) {
      var main = choose(rnd, kinds), other = choose(rnd, kinds.filter(function (k) { return k !== main; }));
      var same = shuffle(byKind[main], rnd).slice(0, 3), odd = choose(rnd, byKind[other]);
      var kc = keyed(odd.word, same.map(function (w) { return w.word; }), rnd);
      return item('word-build-odd', 'k-word-build', '다음 낱말 중 짜임이 다른 하나는?', kc, odd.word + '은(는) ' + odd.kind + (odd.parts ? '(' + odd.parts.join(' + ') + ')' : '') + ', 나머지는 ' + main);
    }
    var w = choose(rnd, data.wordBuild), opts = ['단일어', '합성어', '파생어'].filter(function (k) { return k !== w.kind; });
    var kc2 = keyed(w.kind, opts.concat(['외래어']), rnd);
    return item('word-build-kind', 'k-word-build', "'" + w.word + "'의 짜임으로 알맞은 것은?", kc2, w.parts ? w.parts.join(' + ') + ' → ' + w.kind : '더 나눌 수 없는 하나의 뿌리 → 단일어');
  }
  /* 2. 한자어 — 낱자의 뜻(훈) 고르기 · 같은 낱자를 쓰는 낱말 고르기 */
  function hanja(data, rnd) {
    var h = choose(rnd, data.hanja), part = choose(rnd, h.parts);
    if (rnd() < 0.5) {
      var otherHuns = shuffle(data.hanja.reduce(function (a, x) { x.parts.forEach(function (p) { if (p.hun !== part.hun && a.indexOf(p.hun) < 0) a.push(p.hun); }); return a; }, []), rnd).slice(0, 3);
      if (otherHuns.length < 3) return null;
      var kc = keyed(part.hun, otherHuns, rnd);
      return item('hanja-hun', 'k-hanja-family', "'" + h.word + "'에서 '" + part.eum + "(" + part.ch + ")'의 뜻은?", kc, h.word + ' = ' + h.literal);
    }
    var fam = h.family && h.family.length ? choose(rnd, h.family) : null; if (!fam) return null;
    var others = shuffle(data.hanja.filter(function (x) { return x !== h; }).reduce(function (a, x) { return a.concat(x.family || []); }, []).filter(function (f) { return (h.family || []).indexOf(f) < 0; }), rnd).slice(0, 3);
    if (others.length < 3) return null;
    var kc2 = keyed(fam, others, rnd);
    return item('hanja-family', 'k-hanja-family', "'" + h.word + "'의 '" + part.eum + "(" + part.ch + ")'과 같은 낱자를 쓰는 낱말은?", kc2, fam + '도 ' + part.ch + '(' + part.hun + ' ' + part.eum + ')을 쓴다');
  }
  /* 3. 다의어 문맥 — 밑줄 친 낱말과 같은 뜻으로 쓰인 것 */
  function poly(data, rnd) {
    var w = choose(rnd, data.poly.filter(function (x) { return x.senses.length >= 3 && x.senses.every(function (s) { return s.examples.length >= 2; }); }));
    if (!w) return null;
    var si = Math.floor(rnd() * w.senses.length), sense = w.senses[si];
    var exs = shuffle(sense.examples, rnd), stem = exs[0], answer = exs[1];
    // 오답은 같은 낱말의 다른 뜻 예문에서 먼저 채운다(뜻 3개면 한 뜻에서 예문 2개) — 다른 낱말 예문은 문맥 감별이 아니라 낱말 감별이 돼 버린다
    var pool = shuffle(w.senses.filter(function (s, i) { return i !== si; }).reduce(function (a, s) { return a.concat(shuffle(s.examples, rnd)); }, []), rnd);
    var others = pool.slice(0, 3);
    while (others.length < 3) others.push(choose(rnd, data.poly.filter(function (x) { return x !== w; })).senses[0].examples[0]);
    var kc = keyed(answer, others, rnd);
    return item('poly-context', 'k-poly', "다음 문장의 '" + w.word + "'와(과) 같은 뜻으로 쓰인 것은?", kc, "'" + sense.meaning + "'의 뜻", stem);
  }
  /* 4. 호응 — 자연스러운 문장 고르기 · 고쳐야 할 이유 */
  function concord(data, rnd) {
    var c = choose(rnd, data.concord), others = shuffle(data.concord.filter(function (x) { return x !== c; }), rnd).slice(0, 3).map(function (x) { return { text: x.wrong, errKind: 'concept' }; });
    if (others.length < 3) return null;
    var kc = keyed(c.right, others, rnd);
    return item('concord-pick', 'k-sentence-part', '다음 중 호응이 자연스러운 문장은?', kc, c.explain);
  }
  /* 5. 표현법 식별 */
  var FIGURES = ['직유', '은유', '의인', '과장', '반복', '대구', '설의', '역설'];
  function figure(data, rnd) {
    var f = choose(rnd, data.figure);
    if (rnd() < 0.6) {
      var kc = keyed(f.figure, shuffle(FIGURES.filter(function (x) { return x !== f.figure; }), rnd).slice(0, 3), rnd);
      return item('figure-id', 'k-fig-id', '다음 시구에 쓰인 표현법은?', kc, f.line + ' → ' + f.figure, f.line);
    }
    var same = data.figure.filter(function (x) { return x.figure === f.figure && x !== f; }); if (!same.length) return null;
    var answer = choose(rnd, same).line;
    var others = shuffle(data.figure.filter(function (x) { return x.figure !== f.figure; }), rnd).slice(0, 3).map(function (x) { return { text: x.line, errKind: 'concept' }; });
    var kc2 = keyed(answer, others, rnd);
    return item('figure-same', 'k-fig-id', "'" + f.line + "'과 같은 표현법이 쓰인 것은?", kc2, '둘 다 ' + f.figure);
  }

  var TEMPLATES = { 'k-word-build': wordBuild, 'k-hanja-family': hanja, 'k-poly': poly, 'k-sentence-part': concord, 'k-fig-id': figure };
  function generate(atomId, data, rnd) { var fn = TEMPLATES[atomId]; return fn ? fn(data, rnd) : null; }
  function sampleSheet(atomId, data, n, rnd) { var out = []; for (var i = 0; i < (n || 30); i++) { var it = generate(atomId, data, rnd); if (it) out.push(it); } return out; }
  return { TEMPLATES: TEMPLATES, FIGURES: FIGURES, generate: generate, sampleSheet: sampleSheet, strHash: strHash };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WBHARU_KM;
