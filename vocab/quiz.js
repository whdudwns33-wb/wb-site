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

  /* ── 헷갈리는 말 짝 찾기 ──
     교재가 강마다 가르치는 것이 바로 이 짝이다 — 반듯이/반드시, 갔다/같다, 거름/걸음.
     글자로 비교하면 못 잡는다: "거름"과 "걸음"은 두 글자가 다 다르지만 소리는 같다.
     낱자로 풀면 둘 다 ㄱㅓㄹㅡㅁ 으로 똑같아진다. 그래서 낱자 거리로 잰다.
     짝은 1~2, 무관한 낱말은 5 이상으로 벌어진다. */
  var CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'.split('');
  var JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ'.split('');
  var JONG = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

  function jamo(s) {
    var out = [], str = String(s || '');
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i) - 0xAC00;
      if (c < 0 || c > 11171) { out.push(str[i]); continue; }
      out.push(CHO[Math.floor(c / 588)], JUNG[Math.floor((c % 588) / 28)]);
      var j = JONG[c % 28];
      if (j) out.push(j);
    }
    return out;
  }

  function editDist(a, b) {
    var prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur[0] = i;
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      for (j = 0; j <= b.length; j++) prev[j] = cur[j];
    }
    return prev[b.length];
  }

  /* 소리가 거의 같은 짝인가 — 낱자 두 개 안쪽으로 갈리면 그렇다 */
  function confusable(a, b) {
    a = String(a || ''); b = String(b || '');
    if (a.length < 2 || b.length < 2 || a === b) return false;
    var x = jamo(a), y = jamo(b);
    if (Math.abs(x.length - y.length) > 2) return false;
    return editDist(x, y) <= 2;
  }

  /* 낱말의 '꼴' — 끝이 '다'면 용언(움직임·성질), 아니면 체언(이름).
     문맥 빈칸에서 정답만 명사이고 오답이 모두 '~다'면 낱말을 몰라도 문법만으로 답이 보인다.
     "회오리바람에 ○○○ 날아갔어요"에 눈부시다·미덥다·가득하다를 놓으면 문제가 성립하지 않는다. */
  function shapeOf(s) { return /다$/.test(String(s || '')) ? 'v' : 'n'; }

  /* pool에서 target과 겹치지 않는 오답 n개 뽑기 — pick(w)가 보기 문자열.
     byWord가 참이면(빈칸에 낱말을 고르는 문제) 순서를 이렇게 잡는다:
       ① 소리가 헷갈리는 짝 — 교재가 가르치려는 바로 그 구별이다
       ② 정답과 같은 꼴 — 명사 정답에 '~다'만 늘어놓으면 문법으로 답이 보인다
       ③ 나머지 — 앞의 둘로 모자랄 때만. 문항을 못 내는 것보다 낫다 */
  /* 같은 배정(같은 강)에서 온 낱말인가 — 지금 함께 배우는 말들이다 */
  function sameBatch(a, b) { return !!(a.assignId && b.assignId && a.assignId === b.assignId); }

  function distractors(target, pool, pick, n, rnd, byWord) {
    var want = pick(target), seen = {}, near = [], batch = [], same = [], rest = [];
    seen[want] = true;
    shuffle(pool, rnd).forEach(function (w) {
      if (w.id === target.id) return;
      var v = pick(w);
      if (!v || seen[v]) return;
      seen[v] = true;
      if (!byWord) { same.push(v); return; }
      if (confusable(v, want)) near.push(v);
      else if (sameBatch(w, target) && shapeOf(v) === shapeOf(want)) batch.push(v);
      else if (shapeOf(v) === shapeOf(want)) same.push(v);
      else rest.push(v);
    });
    /* ② 같은 강 낱말을 ③ 아무 낱말보다 먼저 — 아이가 모르는 말을 보기로 놓으면
       뜻을 몰라도 "아는 말 하나"를 골라 맞힌다. 그건 확인이 아니다. */
    return near.concat(batch, same, rest).slice(0, n);
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
  /* 예문에서 그 낱말이 나온 자리를 ○○○로 가린다. 예문은 활용형으로 나온다 —
     "작다"는 "작아요"로, "마치다"는 "마치고"로. 어간을 여러 갈래로 만들어 긴 것부터 찾는다.
     예전에는 한 글자 어간을 버렸는데(작다→작), 그 바람에 2음절 용언은 문항이 아예 안 나왔다.
     하필 교재의 헷갈리는 말이 대부분 그 꼴이다 — 작다·잇다·띠다·낫다·쫓다·싸다.
     대신 한 글자 어간은 낱말 첫머리에서만 인정한다. 남의 낱말 속(마음의 '마')에 걸리면
     엉뚱한 자리가 가려진다. */
  function stemsOf(word) {
    var out = [word];
    var cut = word.replace(/다$/, '');                       // 마치다 → 마치
    if (cut && out.indexOf(cut) < 0) out.push(cut);
    var m = word.match(/^(.+?)(하다|이다|스럽다|치다|다)$/);   // 부딪치다 → 부딪
    if (m && m[1] && out.indexOf(m[1]) < 0) out.push(m[1]);
    return out.sort(function (a, b) { return b.length - a.length; });
  }

  function findStem(ex, stem) {
    if (stem.length >= 2) return ex.indexOf(stem);
    /* 한 글자는 낱말이 시작하는 자리에서만 */
    for (var i = 0; i < ex.length; i++) {
      if (ex[i] !== stem) continue;
      if (i === 0 || /[\s"“”'‘’(\[]/.test(ex[i - 1])) return i;
    }
    return -1;
  }

  var HANGUL = /[가-힣]/;
  /* 음절의 첫소리. 활용해도 첫소리는 남는다 — 리→렸, 대→댔, 쁘→빴, 롭→로, 낫→나 */
  function cho(ch) {
    var c = String(ch || '').charCodeAt(0) - 0xAC00;
    return (c < 0 || c > 11171) ? '' : CHO[Math.floor(c / 588)];
  }

  /* 활용형 찾기 — 어간을 글자 그대로 찾는 것만으로는 절반을 놓친다.
     「엇갈리다」의 예문은 「친구와 길에서 엇갈렸어요」라 '엇갈리'가 없다.
     한국어 활용은 어간의 끝 음절만 바꾸므로, 앞부분(엇갈)으로 자리를 잡고
     그다음 음절의 첫소리가 어간 끝 음절의 첫소리와 같은지로 확인한다.
     ㅅ·ㅂ·ㅡ 불규칙(낫다→나았, 지혜롭다→지혜로운, 가쁘다→가빴)이 모두 이 규칙 안에 든다. */
  /* 활용했을 때 받침이 어떻게 되는가.
     그대로 남거나(늘다→늘어), 홀소리로 끝나는 어간에 과거 ㅆ이 붙거나(가다→갔다),
     불규칙으로만 떨어진다: ㅅ(낫다→나았), ㅂ(돕다→도와), ㅎ(하얗다→하얘), ㄷ→ㄹ(걷다→걸어).
     이 표가 없으면 「없다」가 「어떤」을, 「걷다」가 「거름을」을 잡는다 —
     첫소리·가운뎃소리만 같고 받침만 사라진 남남이다. */
  var CODA_DROP = { 'ㅅ': [''], 'ㅂ': [''], 'ㅎ': [''], 'ㄷ': ['ㄹ'] };
  function codaOk(from, to) {
    if (from === to) return true;
    if (from === '' && to === 'ㅆ') return true;
    return (CODA_DROP[from] || []).indexOf(to) >= 0;
  }
  /* 음절의 받침 */
  function jong(ch) {
    var c = String(ch || '').charCodeAt(0) - 0xAC00;
    return (c < 0 || c > 11171) ? '' : JONG[c % 28];
  }
  /* 음절의 가운뎃소리 */
  function jung(ch) {
    var c = String(ch || '').charCodeAt(0) - 0xAC00;
    return (c < 0 || c > 11171) ? '' : JUNG[Math.floor((c % 588) / 28)];
  }
  var atStart = function (ex, i) { return i === 0 || !HANGUL.test(ex[i - 1]); };
  /* 받침 없는 음절에 받침을 붙인다 — 다 + ㄹ → 달 */
  function addJong(ch, j) {
    var c = String(ch || '').charCodeAt(0) - 0xAC00, k = JONG.indexOf(j);
    if (c < 0 || c > 11171 || k < 1 || c % 28 !== 0) return ch;
    return String.fromCharCode(0xAC00 + c + k);
  }

  function findConjugated(ex, stem) {
    /* 어간이 한 글자면 뗄 앞부분이 없다 — 첫소리와 가운뎃소리가 같고 어절이 시작하는
       자리를 찾는다. 낫다→나았어요, 가다→갔다. 어절 끝쪽을 먼저 보는 편이 안전하다:
       한국어는 서술어가 뒤에 오고, 「엄마가」의 가는 어절 첫머리가 아니라 걸리지 않는다. */
    if (stem.length < 2) {
      var c0 = cho(stem), j0 = jung(stem), g0 = jong(stem), found = -1;
      if (!c0) return -1;
      for (var n = 0; n < ex.length; n++) {
        if (!HANGUL.test(ex[n]) || !atStart(ex, n)) continue;
        if (cho(ex[n]) !== c0 || jung(ex[n]) !== j0) continue;
        if (!codaOk(g0, jong(ex[n]))) continue;
        found = n;
      }
      return found;
    }
    var head = stem.slice(0, -1), want = cho(stem.slice(-1));
    if (!want) return -1;
    /* 르 불규칙은 어간 끝 음절이 앞 음절의 받침으로 녹아든다 — 다르다 → 달라, 부르다 → 불러.
       앞부분을 「다」가 아니라 「달」로 보고 찾아야 걸린다. */
    if (stem.slice(-1) === '르' && head) {
      var alt = head.slice(0, -1) + addJong(head.slice(-1), 'ㄹ');
      if (alt !== head) {
        var j = findConjugated(ex, alt + '르');
        if (j >= 0) return j;
      }
    }
    for (var i = ex.indexOf(head); i >= 0; i = ex.indexOf(head, i + 1)) {
      var next = ex[i + head.length];
      if (!next || !HANGUL.test(next)) continue;
      if (cho(next) !== want) continue;
      /* 낱말 한가운데를 잘라내면 문장이 망가진다 — 어절이 시작하는 자리여야 한다 */
      if (!atStart(ex, i)) continue;
      return i;
    }
    return -1;
  }

  /* 어절 끝까지 지운다. 「엇갈렸어요」를 「엇갈」만 지우면 「○○○렸어요」가 남는다. */
  function eojeolEnd(ex, from) {
    var i = from;
    while (i < ex.length && HANGUL.test(ex[i])) i += 1;
    return i;
  }

  function blankExample(w) {
    if (!w.example) return null;
    var stems = stemsOf(String(w.word || ''));
    var k, stem, i;
    /* ① 글자 그대로 있는 것을 먼저 — 활용을 짐작할 필요가 없다 */
    for (k = 0; k < stems.length; k++) {
      stem = stems[k];
      if (!stem) continue;
      i = findStem(w.example, stem);
      if (i < 0) continue;
      var tail = w.example.slice(i + stem.length).match(/^[가-힣]{0,3}/);
      var len = stem.length + (tail ? tail[0].length : 0);
      return w.example.slice(0, i) + '○○○' + w.example.slice(i + len);
    }
    /* ② 활용한 꼴 */
    for (k = 0; k < stems.length; k++) {
      stem = stems[k];
      if (!stem) continue;
      i = findConjugated(w.example, stem);
      if (i < 0) continue;
      return w.example.slice(0, i) + '○○○' + w.example.slice(eojeolEnd(w.example, i));
    }
    return null;
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
    var d = distractors(w, pool, function (x) { return x.word; }, 3, rnd, true);
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
    confusable: confusable, jamo: jamo,
    _q: { qMeaning4: qMeaning4, qCloze: qCloze, qAssemble: qAssemble, qSyn: qSyn, qSpell: qSpell, qListen: qListen },
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WBQUIZ;
