'use strict';
/* WB 워드브레인 — 문제 출제 엔진 (브라우저/Node 공용)
   자기 채점("알았어/몰랐어")의 친숙도 착각을 없애기 위해, 아는지 모르는지를
   객관적으로 판정하는 문항을 어종별로 생성한다.
     한자어 : 뜻 4지선다 · 한자 조립(빠진 훈음 고르기) · 예문 빈칸
     영어   : 뜻 4지선다 · 철자 입력 · 듣고 고르기
     고유어 : 예문 빈칸 · 유의어 고르기 · 뜻 4지선다
   채점 → SRS 등급: 첫 시도 정답 good / 힌트·재시도 후 정답 hard / 오답 fail */
var WBQUIZ = (function () {

  function shuffle(arr, rnd) {
    var a = arr.slice(), r = rnd || Math.random;
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(r() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* pool에서 target과 겹치지 않는 오답 n개 뽑기 — pick(w)가 보기 문자열 */
  function distractors(target, pool, pick, n, rnd) {
    var want = pick(target), seen = {}, out = [];
    seen[want] = true;
    shuffle(pool, rnd).forEach(function (w) {
      if (out.length >= n || w.id === target.id) return;
      var v = pick(w);
      if (!v || seen[v]) return;
      seen[v] = true;
      out.push(v);
    });
    return out;
  }

  function choiceQ(kind, target, prompt, answer, opts, rnd, extra) {
    var choices = shuffle([answer].concat(opts), rnd);
    var q = {
      kind: kind, id: target.id, word: target.word, type: target.type,
      prompt: prompt, choices: choices, answer: answer, input: false,
    };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) q[k] = extra[k];
    return q;
  }

  /* 예문에서 단어를 빈칸으로 — 활용형이라 못 찾으면 null */
  function blankExample(w) {
    if (!w.example) return null;
    var stem = w.word.replace(/(하다|이다|스럽다|치다|다)$/, '');
    if (stem.length < 2) stem = w.word;
    var i = w.example.indexOf(stem);
    if (i < 0) return null;
    var tail = w.example.slice(i + stem.length).match(/^[가-힣]{0,3}/);
    var len = stem.length + (tail ? tail[0].length : 0);
    return w.example.slice(0, i) + '○○○' + w.example.slice(i + len);
  }

  /* ── 어종별 문항 ── */
  function qMeaning4(w, pool, rnd) {
    var d = distractors(w, pool, function (x) { return x.meaning; }, 3, rnd);
    if (d.length < 3) return null;
    var label = w.type === 'english' ? w.word : w.word + (w.hanja ? ' (' + w.hanja + ')' : '');
    return choiceQ('meaning4', w, label + ' 의 뜻은?', w.meaning, d, rnd, { head: '뜻 고르기', speak: w.type === 'english' });
  }

  function qCloze(w, pool, rnd) {
    var blanked = blankExample(w);
    if (!blanked) return null;
    var d = distractors(w, pool, function (x) { return x.word; }, 3, rnd);
    if (d.length < 3) return null;
    return choiceQ('cloze', w, '빈칸에 알맞은 말은?\n' + blanked, w.word, d, rnd, { head: '문맥 빈칸' });
  }

  function qAssemble(w, pool, rnd) {
    if (!w.parts || w.parts.length < 2) return null;
    var idx = Math.floor((rnd || Math.random)() * w.parts.length);
    var hidden = w.parts[idx];
    var answer = hidden.hun + ' ' + hidden.eum;
    var seen = {}, opts = [];
    seen[answer] = true;
    shuffle(pool, rnd).forEach(function (x) {
      if (opts.length >= 3 || !x.parts) return;
      x.parts.forEach(function (p) {
        if (opts.length >= 3) return;
        var v = p.hun + ' ' + p.eum;
        if (seen[v]) return;
        seen[v] = true; opts.push(v);
      });
    });
    if (opts.length < 3) return null;
    // 가린 글자는 □로 — '?'로 가리면 문장 끝 물음표와 겹쳐 뭘 묻는지 헷갈린다
    var shown = w.parts.map(function (p, i) { return i === idx ? '□' : p.ch; }).join('');
    return choiceQ('assemble', w, w.word + ' — ' + shown + ' 에서 □의 뜻과 음은?', answer, opts, rnd, {
      head: '한자 조립', hint: w.literal ? '조립하면: ' + w.literal : null,
    });
  }

  function qSyn(w, pool, rnd) {
    if (!w.syn || !w.syn.length) return null;
    var answer = w.syn[Math.floor((rnd || Math.random)() * w.syn.length)];
    var mine = {};
    (w.syn || []).forEach(function (s) { mine[s] = true; });
    var seen = {}, opts = [];
    seen[answer] = true;
    shuffle(pool, rnd).forEach(function (x) {
      if (opts.length >= 3 || x.id === w.id || !x.syn) return;
      x.syn.forEach(function (s) {
        if (opts.length >= 3 || seen[s] || mine[s]) return;
        seen[s] = true; opts.push(s);
      });
    });
    if (opts.length < 3) return null;
    return choiceQ('syn', w, w.word + ' 와(과) 뜻이 가장 비슷한 말은?', answer, opts, rnd, { head: '비슷한 말' });
  }

  function qListen(w, pool, rnd) {
    if (w.type !== 'english') return null;
    var d = distractors(w, pool, function (x) { return x.meaning; }, 3, rnd);
    if (d.length < 3) return null;
    return choiceQ('listen', w, '잘 듣고 뜻을 고르세요', w.meaning, d, rnd, {
      head: '듣고 고르기', speak: true, hideWord: true,
    });
  }

  /* 철자 입력 — 첫 글자와 길이만 힌트로 */
  function qSpell(w) {
    if (w.type !== 'english' || w.word.length < 3) return null;
    return {
      kind: 'spell', id: w.id, word: w.word, type: w.type,
      prompt: '"' + w.meaning + '" 을(를) 뜻하는 영어 단어를 쓰세요',
      answer: w.word, input: true, head: '철자 쓰기', speak: true,
      hint: w.word[0] + ' _'.repeat(w.word.length - 1).trim(),
    };
  }

  var PLAN = {
    hanja: [qMeaning4, qAssemble, qCloze],
    english: [qMeaning4, qSpell, qListen],
    native: [qCloze, qSyn, qMeaning4],
  };

  /* 단어 1개 → 문항 1개. step(SRS 계단)이 높을수록 어려운 유형으로.
     생성 실패 시 같은 어종의 다른 유형으로 폴백, 전부 실패하면 null(호출측이 카드형으로 처리) */
  function makeQuestion(word, pool, step, rnd) {
    var plan = PLAN[word.type] || PLAN.hanja;
    var samePool = pool.filter(function (x) { return x.type === word.type; });
    if (samePool.length < 4) samePool = pool;
    var start = Math.min(Math.max(step || 0, 0), plan.length - 1);
    for (var i = 0; i < plan.length; i++) {
      var q = plan[(start + i) % plan.length](word, samePool, rnd);
      if (q) return q;
    }
    return null;
  }

  function normalize(s) { return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' '); }

  /* 정답 판정 — 입력형은 대소문자·공백 무시 */
  function check(q, given) {
    return q.input ? normalize(given) === normalize(q.answer) : given === q.answer;
  }

  /* 시도 결과 → SRS 등급 */
  function grade(correct, attempts, usedHint) {
    if (!correct) return 'fail';
    return (attempts > 1 || usedHint) ? 'hard' : 'good';
  }

  return {
    makeQuestion: makeQuestion, check: check, grade: grade,
    blankExample: blankExample, shuffle: shuffle, normalize: normalize,
    _q: { qMeaning4: qMeaning4, qCloze: qCloze, qAssemble: qAssemble, qSyn: qSyn, qSpell: qSpell, qListen: qListen },
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WBQUIZ;
