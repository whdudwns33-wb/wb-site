'use strict';
/* WB 내신브레인 — 문항 생성 모듈 (브라우저/Node 공용)
   레슨 팩 마스터(단어·문장)에서 훈련 문항을 런타임 생성한다 — 변주 문항은 저장하지
   않는다는 팩 스키마 원칙(마스터 우선)의 실행부다.
     단어  : 뜻 4지선다(정/역방향) · 철자 입력 · 예문 빈칸 · 영영풀이 고르기 (기획 §4.1)
     문장  : 사다리 3~5단계 — 핵심어 빈칸 → 클로즈+배열 → 영작 (§4.2; 스켈레톤은 §14-3 발판)
     진단  : 전 단어 고속 4지선다 + '모름' 버튼 (§14-1 사전 인출 진단)
   모든 무작위성은 rnd(0~1 반환 함수) 주입 — 미주입 시 Math.random. 테스트는 시드 고정. */
var WBGEN = (function () {

  function shuffle(arr, rnd) {
    var a = arr.slice(), r = rnd || Math.random;
    for (var i = a.length - 1; i > 0; i--) {
      /* rnd()가 정확히 1.0을 돌려주면 j=i+1로 튀어 undefined가 섞인다 — 상한을 막는다 */
      var j = Math.min(i, Math.floor(r() * (i + 1)));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* 단어의 대표 뜻 — 다의어(senses)는 첫 의미가 카드 앞면의 정본이다(§4.1 의미별 카드 분리 전
     단계의 기본값). senses가 없으면 meaningKo 배열의 첫 항목. */
  function meaningOf(w) {
    if (w.senses && w.senses.length && w.senses[0].meaningKo) return w.senses[0].meaningKo;
    var m = w.meaningKo;
    if (m && typeof m.length === 'number' && typeof m !== 'string') return m[0] || '';
    return m || '';
  }

  function norm(v) { return String(v == null ? '' : v).toLowerCase().replace(/\s+/g, ' ').trim(); }

  /* 단어가 가진 뜻 전부를 낱개 풀이로 — "간직하다, 보관하다"는 두 풀이다. 오답 보기가
     정답 단어의 다른 뜻과 같으면 정답이 둘인 문항이 된다(keep·maintain '유지하다'). */
  function allMeanings(w) {
    var out = {}, list = [];
    var m = w.meaningKo;
    if (m && typeof m !== 'string' && typeof m.length === 'number') list = list.concat(m);
    else if (m) list.push(m);
    (w.senses || []).forEach(function (s) { if (s && s.meaningKo) list.push(s.meaningKo); });
    list.forEach(function (v) {
      var whole = norm(v);
      if (whole) out[whole] = true;
      String(v).split(/[,;，、/]/).forEach(function (g) {
        var k = norm(g);
        if (k) out[k] = true;
      });
    });
    return out;
  }

  /* 유의어 표기는 "over"·"sweet (달콤한)" 같이 괄호 풀이가 붙기도 한다 — 표제어만 남긴다 */
  function synonymHeads(w) {
    return (w.synonyms || []).map(function (s) { return norm(String(s).replace(/\(.*$/, '')); }).filter(Boolean);
  }

  /* 정답 단어와 '같은 답'이 될 수 있는 것들 — 정답의 모든 뜻, 유의어 표제어, 그리고 팩 안의
     유의어 단어가 가진 뜻까지(store≈keep 이면 keep 의 '간직하다'도 store 의 답이다).
     반환: { meanings: {뜻: true}, heads: {표제어: true} } */
  function answerSet(target, pool) {
    var meanings = allMeanings(target), heads = {}, th = norm(target.headword);
    synonymHeads(target).forEach(function (h) { heads[h] = true; });
    (pool || []).forEach(function (w) {
      if (w === target) return;
      var hw = norm(w.headword);
      if (!hw) return;
      var syn = heads[hw] || (th && synonymHeads(w).indexOf(th) >= 0);
      if (!syn) return;
      heads[hw] = true;
      var wm = allMeanings(w), k;
      for (k in wm) if (Object.prototype.hasOwnProperty.call(wm, k)) meanings[k] = true;
    });
    return { meanings: meanings, heads: heads };
  }

  /* 후보 단어가 정답과 겹치는가 — 표제어가 유의어이거나 뜻이 하나라도 겹치면 보기로 못 쓴다 */
  function related(set, w) {
    if (set.heads[norm(w.headword)]) return true;
    var wm = allMeanings(w), k;
    for (k in wm) if (Object.prototype.hasOwnProperty.call(wm, k) && set.meanings[k]) return true;
    return false;
  }

  /* 두 단어가 겹치는 section(대화문/본문)을 갖는가 — 같은 지문에서 함께 배우는 말인가 */
  function sharesSection(a, b) {
    var as = a.sections || [], bs = b.sections || [];
    for (var i = 0; i < as.length; i++) if (bs.indexOf(as[i]) >= 0) return true;
    return false;
  }

  /* 오답 보기 n개 — 같은 팩의 다른 단어에서(§2.2). 우선순위:
       ① 같은 section + 같은 품사 — 지금 함께 외우는, 문법으로 걸러지지 않는 보기
       ② 같은 section  ③ 같은 품사  ④ 나머지 — 문항을 못 내는 것보다 낫다
     정답과 겹치는 보기는 금지 — 뜻 문자열 중복뿐 아니라 정답 단어의 다른 뜻·유의어까지
     (정방향·역방향 모두: '유지하다'를 보고 keep/maintain 둘 다 맞으면 문항이 아니다). */
  function distractors(target, pool, pick, n, rnd) {
    var want = pick(target), seen = {}, both = [], sec = [], pos = [], rest = [];
    seen[norm(want)] = true;
    var set = answerSet(target, pool), k;
    for (k in set.meanings) if (Object.prototype.hasOwnProperty.call(set.meanings, k)) seen[k] = true;
    for (k in set.heads) if (Object.prototype.hasOwnProperty.call(set.heads, k)) seen[k] = true;
    shuffle(pool || [], rnd).forEach(function (w) {
      if (w === target) return;
      if (w.id != null && target.id != null && w.id === target.id) return;
      var v = pick(w);
      if (!v) return;
      var key = norm(v);
      if (seen[key]) return;
      if (related(set, w)) return;
      seen[key] = true;
      var s = sharesSection(w, target), p = !!(w.pos && target.pos && w.pos === target.pos);
      if (s && p) both.push(v);
      else if (s) sec.push(v);
      else if (p) pos.push(v);
      else rest.push(v);
    });
    return both.concat(sec, pos, rest).slice(0, n);
  }

  /* 보기를 셔플하고 '1'~'n' 키를 붙인다. answerKey는 셔플 후의 정답 위치. */
  function keyedChoices(answer, opts, rnd) {
    var texts = shuffle([answer].concat(opts), rnd);
    var choices = texts.map(function (t, i) { return { key: String(i + 1), text: t }; });
    return { choices: choices, answerKey: String(texts.indexOf(answer) + 1) };
  }

  /* ── 단어 문항 ── */

  /* 뜻 4지선다 — 영어 headword를 보고 한국어 뜻을 고른다.
     opts.withUnknown이면 '0' 모름 선택지를 붙인다(§14-1: 진단에서 찍기를 막는 버튼 —
     찍어서 맞으면 출발선이 오염된다). 오답을 opts.minDistractors(기본 3)개 못 채우면 null. */
  function vocabMcq(word, pool, rnd, opts) {
    rnd = rnd || Math.random;
    opts = opts || {};
    var minD = opts.minDistractors == null ? 3 : opts.minDistractors;
    var answer = meaningOf(word);
    if (!answer) return null;
    var d = distractors(word, pool, meaningOf, 3, rnd);
    if (d.length < minD) return null;
    var kc = keyedChoices(answer, d, rnd);
    var q = { type: 'mcq', wordId: word.id, prompt: word.headword, choices: kc.choices, answerKey: kc.answerKey };
    if (opts.withUnknown) {
      q.choices.push({ key: '0', text: '모름' });
      q.unknownKey = '0';
    }
    return q;
  }

  /* 역방향 — 한국어 뜻을 보고 영어 단어를 고른다(재인의 방향을 바꿔 관대함을 보정). */
  function vocabMcqReverse(word, pool, rnd) {
    rnd = rnd || Math.random;
    var answer = word.headword;
    if (!answer) return null;
    var d = distractors(word, pool, function (w) { return w.headword; }, 3, rnd);
    if (d.length < 3) return null;
    var kc = keyedChoices(answer, d, rnd);
    return { type: 'mcq', wordId: word.id, prompt: meaningOf(word), choices: kc.choices, answerKey: kc.answerKey };
  }

  /* 철자 입력 — 뜻을 보고 headword를 쓴다. 기본은 첫 글자 + 글자 수 힌트("s _ _ _ _ _ _",
     구 표제어는 낱말 경계를 ' / '로 남긴다). opts.hint === false면 무힌트 — 힌트 없는 완전
     인출만이 기준 도달(§14-1)이므로 relearn·재검증 레인은 이걸 쓴다. hinted 플래그를 문항에
     실어 앱이 recordCriterion에 그대로 넘기게 한다.
     정답은 headword 하나뿐이다 — 불규칙형(kept)을 받으면 "썼다"는 착각만 남는다. */
  function spelling(word, rnd, opts) {
    var h = String(word.headword || '');
    if (!h) return null;
    var hinted = !(opts && opts.hint === false);
    var hint = hinted ? lenHint(h) : null;
    return { type: 'spell', wordId: word.id, promptKo: meaningOf(word), hint: hint, hinted: hinted, answers: [h] };
  }

  /* ── 표층형 탐색 ──
     예문 속 단어는 headword 그대로가 아니다 — keep은 kept로, call은 calling으로 나온다.
     후보: headword · irregularForms · 규칙 굴절(s/es/ed/ing/er/est + e탈락·y→ie·자음중복).
     긴 후보부터 찾아야 'calling'을 두고 'call'만 오려 내는 일이 없다. 어절 경계 필수 —
     'keep'이 'keeper' 속에 걸리면 문장이 망가진다. */
  var WORDCH = /[A-Za-z0-9]/;

  function overlaps(taken, start, len) {
    for (var i = 0; i < taken.length; i++) {
      var t = taken[i];
      if (start < t.start + t.len && t.start < start + len) return true;
    }
    return false;
  }

  /* text에서 needle의 자리(대소문자 무시 첫 매칭) — 이미 가린 자리(taken)와 겹치면 다음
     자리를 본다. 라틴 문자 가장자리에만 경계를 요구한다 — 한국어는 조사가 붙어 나오므로
     (밀물→밀물이) 경계를 강제하면 아무것도 못 찾는다.
     from 은 탐색 시작 위치 — 지면 순서(①②③…)를 지켜야 하는 곳에서 앞자리로 되돌아가지 않게. */
  function findSpan(text, needle, taken, from) {
    if (!needle) return null;
    var low = String(text).toLowerCase(), n = String(needle).toLowerCase();
    for (var i = low.indexOf(n, from || 0); i >= 0; i = low.indexOf(n, i + 1)) {
      var before = text[i - 1], after = text[i + n.length];
      if (before && WORDCH.test(before) && WORDCH.test(n[0])) continue;
      if (after && WORDCH.test(after) && WORDCH.test(n[n.length - 1])) continue;
      if (taken && overlaps(taken, i, n.length)) continue;
      return { start: i, len: n.length };
    }
    return null;
  }

  var VOWEL = /[aeiou]/;

  function surfaceCandidates(word) {
    var h = String(word.headword || ''), seen = {}, out = [];
    var list = [h].concat(word.irregularForms || []);
    if (h && h.indexOf(' ') < 0) {
      /* 비교급·최상급은 형용사·부사의 굴절이다 — 동사·명사에 -er 을 붙이면 keep→keeper 처럼
         다른 낱말(행위자 명사)에 걸린다. 품사를 모르면 허용한다(못 내는 것보다 낫다). */
      var grad = !word.pos || /^(a|adj|adv)/i.test(String(word.pos));
      list.push(h + 's', h + 'es', h + 'ed', h + 'ing');
      if (grad) list.push(h + 'er', h + 'est');
      var last = h[h.length - 1], prev = h[h.length - 2] || '';
      if (last === 'e') {                                        // make→making, like→liked, large→larger
        var st = h.slice(0, -1);
        list.push(st + 'ing', h + 'd');
        if (grad) list.push(h + 'r', h + 'st');
      }
      if (last === 'y' && prev && !VOWEL.test(prev)) {           // try→tries·tried, city→cities, happy→happier
        var sy = h.slice(0, -1);
        list.push(sy + 'ies', sy + 'ied');
        if (grad) list.push(sy + 'ier', sy + 'iest');
      }
      /* 자음-모음-자음 끝(run·big·stop)은 마지막 자음을 겹친다 — running·bigger·stopped */
      if (h.length >= 3 && !VOWEL.test(last) && /[a-z]/.test(last) && 'wxy'.indexOf(last) < 0 &&
          VOWEL.test(prev) && !VOWEL.test(h[h.length - 3] || 'a')) {
        var dbl = h + last;
        list.push(dbl + 'ing', dbl + 'ed');
        if (grad) list.push(dbl + 'er', dbl + 'est');
      }
    }
    list.forEach(function (c) {
      if (!c || seen[c]) return;
      seen[c] = true; out.push(c);
    });
    return out.sort(function (a, b) { return b.length - a.length; });
  }

  /* 예문 빈칸 — 예문 속 실제 표층형을 찾아 가린다. answers는 [표층형, headword] —
     학생이 어느 쪽을 써도 인출은 인출이다(채점기가 정규화 대조). 예문이 없거나
     표층형을 못 찾으면 null: 없는 자리에 구멍을 뚫으면 답이 없는 문제가 된다. */
  function exampleCloze(word) {
    var ex = word.example || (word.senses && word.senses.length && word.senses[0].example) || null;
    if (!ex || !ex.en) return null;
    var cands = surfaceCandidates(word);
    for (var k = 0; k < cands.length; k++) {
      var sp = findSpan(ex.en, cands[k], null);
      if (!sp) continue;
      var surface = ex.en.slice(sp.start, sp.start + sp.len);
      var answers = [surface];
      if (word.headword && word.headword !== surface) answers.push(word.headword);
      return {
        type: 'cloze', wordId: word.id,
        textParts: [ex.en.slice(0, sp.start), ex.en.slice(sp.start + sp.len)],
        answers: answers, ko: ex.ko || null,
      };
    }
    return null;
  }

  /* 영영풀이 고르기 — definition을 제시하고 단어 4지선다. definition 없으면 null. */
  function definitionPick(word, pool, rnd) {
    rnd = rnd || Math.random;
    if (!word.definition || !word.definition.en) return null;
    var answer = word.headword;
    var d = distractors(word, pool, function (w) { return w.headword; }, 3, rnd);
    if (d.length < 3) return null;
    var kc = keyedChoices(answer, d, rnd);
    return { type: 'defpick', wordId: word.id, prompt: word.definition.en, choices: kc.choices, answerKey: kc.answerKey };
  }

  /* ── 청크 트랙 (뜻 세우기) ──
     영어를 못 읽는 학생의 출발점이다. 암기용 한글은 청크별 직독직해(chunks[].ko)다 —
     문장 단위 매끄러운 해석(sentences[].ko)은 한국어 어순이라 영어 자리와 어긋나 여기 쓰지 않는다.
     한글은 목적지가 아니라 갈고리라, 세 문항 모두 영어 청크를 함께 실어 화면에서 짝지어 보인다. */

  /* 비교용 키 — 한글은 구두점·공백만 털고(조사는 남긴다), 영어는 norm 과 같은 눈으로 */
  function koKey(v) { return String(v == null ? '' : v).replace(/[\s,.!?·…"'“”‘’()\[\]]/g, ''); }
  function enKey(v) { return norm(String(v == null ? '' : v).replace(/[.,!?;:"'“”‘’]/g, ' ')); }

  /* 단락(문장 배열)의 청크를 읽는 순서대로 편다. en·ko 가 똑같은 청크가 또 나오면 뒤엣것을 버린다 —
     짝 맞추기에서 어느 쪽에 이어도 맞는 쌍이 생기면 채점이 거짓 오답을 낸다. */
  function chunkList(sentences) {
    var list = Array.isArray(sentences) ? sentences : [sentences], out = [], seen = {};
    list.forEach(function (s) {
      if (!s) return;
      (s.chunks || []).forEach(function (c, i) {
        if (!c || !c.ko) return;
        var k = enKey(c.en) + '|' + koKey(c.ko);
        if (seen[k]) return;
        seen[k] = true;
        out.push({ en: c.en || '', ko: c.ko, seq: s.seq, idx: i, key: s.seq + ':' + i });
      });
    });
    return out;
  }

  /* 청크 1 — 듣고 짝 맞추기. 영↔한 4~5쌍을 양쪽 따로 섞어 내놓는다(대조는 key 로).
     start/next 로 단락의 청크를 여러 판에 나눠 덮는다. 마지막 판에 한 쌍만 남으면 앞에서
     당겨 채운다 — 한 쌍짜리 화면은 문항이 아니다. 청크가 둘 미만이면 null. */
  function chunkMatch(sentences, rnd, opts) {
    rnd = rnd || Math.random;
    opts = opts || {};
    var all = chunkList(sentences);
    if (all.length < 2) return null;
    var size = Math.max(2, Math.min(opts.size == null ? 5 : (opts.size | 0), all.length));
    var start = opts.start == null ? 0 : (opts.start | 0);
    if (start < 0 || start >= all.length) return null;
    if (all.length - start < 2) start = all.length - size;
    var pairs = all.slice(start, start + size);
    function keys(list) { return list.map(function (c) { return c.key; }).join('|'); }
    var left = pairs, right = pairs;
    for (var i = 0; i < 12; i++) {
      left = shuffle(pairs, rnd);
      right = shuffle(pairs, rnd);
      if (keys(left) !== keys(right)) break;   // 두 줄이 같은 순서면 눈으로 답이 보인다
    }
    var end = start + pairs.length;
    return {
      type: 'ckmatch',
      pairs: pairs.map(function (c) { return { key: c.key, seq: c.seq, en: c.en, ko: c.ko }; }),
      left: left.map(function (c) { return { key: c.key, en: c.en }; }),
      right: right.map(function (c) { return { key: c.key, ko: c.ko }; }),
      start: start, next: end < all.length ? end : null, total: all.length,
    };
  }

  /* 청크 2 — 뜻 인출. 영어 청크를 보고 한글을 고른다. 오답 보기는 같은 단락의 다른 청크에서.
     정답이 둘인 보기를 막는다 — 같은 뜻(구두점·공백만 다른 것), 정답을 품거나 정답에 담기는
     뜻(부분 정답), 그리고 프롬프트와 en 이 같은 다른 청크의 뜻(그것도 정답이다)은 모두 뺀다.
     opts.index 로 단락의 몇 번째 청크를 물을지 고른다(미지정이면 rnd 로 하나).
     오답을 opts.minDistractors(기본 3)개 못 채우면 null. */
  function chunkMeaning(sentences, rnd, opts) {
    rnd = rnd || Math.random;
    opts = opts || {};
    var all = chunkList(sentences);
    if (!all.length) return null;
    var idx = opts.index == null ? Math.min(all.length - 1, Math.floor(rnd() * all.length)) : (opts.index | 0);
    if (idx < 0 || idx >= all.length) return null;
    var target = all[idx];
    if (!target.en || !target.ko) return null;
    var minD = opts.minDistractors == null ? 3 : opts.minDistractors;
    var ans = koKey(target.ko), banned = {};
    banned[ans] = true;
    all.forEach(function (c) { if (c !== target && enKey(c.en) === enKey(target.en)) banned[koKey(c.ko)] = true; });
    var pool = [], seen = {};
    shuffle(all, rnd).forEach(function (c) {
      if (c === target) return;
      var k = koKey(c.ko);
      if (!k || seen[k] || banned[k]) return;
      if (k.indexOf(ans) >= 0 || ans.indexOf(k) >= 0) return;   // 포함 관계는 부분 정답이 된다
      seen[k] = true;
      pool.push(c.ko);
    });
    if (pool.length < minD) return null;
    var kc = keyedChoices(target.ko, pool.slice(0, 3), rnd);
    return {
      type: 'ckmean', seq: target.seq, chunkIdx: target.idx, key: target.key,
      index: idx, total: all.length, prompt: target.en,
      choices: kc.choices, answerKey: kc.answerKey,
    };
  }

  /* 청크 3 — 순서 세우기. 한 문장의 한글 청크를 직독직해 순서로 잇는다.
     영어 자리를 함께 보여 주라고 answerEn·enFull 을 같이 싣는다(한글만 있는 화면 금지).
     청크가 둘 미만이거나 전부 같은 한글이면 null. */
  function chunkOrder(sentence, rnd) {
    rnd = rnd || Math.random;
    var chunks = (sentence.chunks || []).filter(function (c) { return c && c.ko; });
    if (chunks.length < 2) return null;
    var answer = chunks.map(function (c) { return c.ko; });
    var sh = shuffleDistinct(answer, rnd);
    if (!sh) return null;
    return {
      type: 'ckorder', seq: sentence.seq, shuffled: sh, answer: answer,
      answerEn: chunks.map(function (c) { return c.en || ''; }),
      enFull: sentence.en || null, koFull: sentence.ko || null,
    };
  }

  /* ── 단서 농도 (cue 0~3) ──
     3 전사(답을 보여 주고 그대로 옮겨 쓴다) · 2 첫 글자+글자 수 · 1 첫 글자 · 0 빈칸만.
     cue 를 안 넘기면(null) 예전 그대로 — 학생 앱의 기존 호출을 깨지 않는다. */
  function cueLevel(cue) {
    if (cue == null || cue === '' || isNaN(+cue)) return null;
    return Math.max(0, Math.min(3, Math.round(+cue)));
  }

  /* "s _ _ _ _ _ _" · 낱말 경계는 ' /' — 철자 힌트와 같은 표기를 쓴다(학생이 이미 아는 모양) */
  function lenHint(a) {
    var s = String(a == null ? '' : a);
    if (!s) return null;
    var out = s.charAt(0);
    for (var i = 1; i < s.length; i++) out += s.charAt(i) === ' ' ? ' /' : ' _';
    return out;
  }

  /* 빈칸 하나에 cue 를 입힌다 — hint 는 화면에 그대로 쓸 문자열, given 은 전사용 정답 */
  function cueApply(extra, answer, c) {
    var a = String(answer == null ? '' : answer);
    extra.cue = c;
    extra.lead = c >= 1 && a ? a.charAt(0) : null;
    extra.length = c >= 2 && a ? a.length : null;
    extra.hint = c >= 3 ? (a || null) : (c === 2 ? lenHint(a) : (c === 1 ? (a.charAt(0) || null) : null));
    extra.given = c >= 3 ? (a || null) : null;
    return extra;
  }

  /* 문장 뼈대 — 낱말마다 첫 글자만(cue 1), 또는 첫 글자 + 나머지 글자 수(cue 2).
     구두점은 원문 자리에 그대로 남긴다("summer," → "s_____,") — 문장의 마디가 보여야 발판이 된다. */
  function enSkeleton(en, withLen) {
    var s = String(en == null ? '' : en);
    if (!s) return null;
    return s.split(/\s+/).map(function (w) {
      var m = w.match(/^([^A-Za-z]*)([A-Za-z][A-Za-z'’-]*)([\s\S]*)$/);
      if (!m) return w;                                   // 숫자·기호뿐인 조각은 원문 그대로
      return m[1] + m[2].charAt(0) + (withLen ? new Array(m[2].length).join('_') : '') + m[3];
    }).join(' ');
  }

  /* ── 문장 사다리 ── */

  /* span 목록(start 오름차순)으로 문장을 파트 배열로 자른다.
     파트를 이어 붙이면(텍스트는 text, 빈칸은 answers[0]) 원문이 그대로 복원되어야 한다 —
     이 불변식이 깨지면 화면의 문장이 원문과 달라진다. */
  function buildParts(text, spans) {
    var parts = [], pos = 0;
    spans.forEach(function (sp) {
      if (sp.start > pos) parts.push({ text: text.slice(pos, sp.start) });
      var surface = text.slice(sp.start, sp.start + sp.len);
      var blank = { answers: sp.alt && sp.alt !== surface ? [surface, sp.alt] : [surface] };
      if (sp.extra) for (var k in sp.extra) if (Object.prototype.hasOwnProperty.call(sp.extra, k)) blank[k] = sp.extra[k];
      parts.push({ blank: blank });
      pos = sp.start + sp.len;
    });
    if (pos < text.length) parts.push({ text: text.slice(pos) });
    return parts;
  }

  function byStart(a, b) { return a.start - b.start; }

  /* 사다리 3단계 — 핵심어만 빈칸(워크북 2·3형). direction 'en': 영어 문장에서 keywords의
     en을 가리고 ko를 힌트로. 'ko'는 대칭. 문장에서 못 찾는 키워드는 조용히 건너뛴다 —
     자료 간 문장 분할 불일치(§2.2-5)로 키워드가 어긋나는 일은 데이터 검수의 몫이지
     학생 화면에서 터뜨릴 일이 아니다. */
  function keywordBlanks(sentence, direction, cue) {
    var dir = direction === 'ko' ? 'ko' : 'en';
    var text = sentence[dir] || '';
    var c = cueLevel(cue);
    var taken = [], spans = [];
    (sentence.keywords || []).forEach(function (kw) {
      var sp = findSpan(text, kw[dir], taken);
      if (!sp) return;
      sp.alt = kw[dir];
      sp.extra = dir === 'en' ? { hintKo: kw.ko } : { hintEn: kw.en };
      if (c != null) cueApply(sp.extra, text.slice(sp.start, sp.start + sp.len), c);
      taken.push(sp); spans.push(sp);
    });
    if (!spans.length) return null;
    spans.sort(byStart);
    var q = { type: 'kwblank', seq: sentence.seq, direction: dir, parts: buildParts(text, spans) };
    if (dir === 'en') q.koFull = sentence.ko; else q.enFull = sentence.en;
    if (c != null) { q.cue = c; q.showAnswer = c >= 3; q.given = c >= 3 ? text : null; }
    return q;
  }

  /* 사다리 1단계 — 줄 해석(한글 빈칸). 뜻 세우기의 마지막 칸이자 영어를 한 글자도 쓰지 않는 칸.
     청크 직독직해 한글을 ' / ' 로 이은 줄에서 keywords[].ko 를 판다 — 매끄러운 해석(sentence.ko)은
     한국어 어순이라 영어 자리와 어긋나므로 청크가 있으면 쓰지 않는다(없는 팩만 내려가고 source 로 알린다).
     빈칸 옆에는 늘 영어 핵심어(hintEn)가 붙는다 — 이 단계가 묻는 것은 "이 영어 자리의 뜻"이다.
     한글 줄이 없거나 키워드를 하나도 못 찾으면 null — 빈칸 없는 해석 화면은 문항이 아니다. */
  function koBlanks(sentence, cue) {
    var chunks = (sentence.chunks || []).filter(function (c) { return c && c.ko; });
    var source = chunks.length ? 'chunks' : 'ko';
    var text = chunks.length ? chunks.map(function (c) { return c.ko; }).join(' / ') : String(sentence.ko || '');
    if (!text) return null;
    var c = cueLevel(cue), taken = [], spans = [];
    (sentence.keywords || []).forEach(function (kw) {
      if (!kw || !kw.ko) return;
      var sp = findSpan(text, kw.ko, taken);
      if (!sp) return;
      sp.alt = kw.ko;
      sp.extra = { hintEn: kw.en || null };
      if (c != null) cueApply(sp.extra, text.slice(sp.start, sp.start + sp.len), c);
      taken.push(sp); spans.push(sp);
    });
    if (!spans.length) return null;
    spans.sort(byStart);
    var q = {
      type: 'koblank', seq: sentence.seq, source: source, koText: text,
      parts: buildParts(text, spans), enFull: sentence.en || null,
      chunks: chunks.map(function (x) { return { en: x.en || '', ko: x.ko }; }),
    };
    if (c != null) { q.cue = c; q.showAnswer = c >= 3; q.given = c >= 3 ? text : null; }
    return q;
  }

  /* 4자 이상이어도 내용어가 아닌 낱말 — 이걸 가리면 "when을 외웠는가"를 묻는 문항이 된다 */
  var FUNCTION_WORDS = {};
  ('when what where which while whom whose will would shall should could might must than then that this these those there their them they '
    + 'with without from into onto over under here have been being were does done some such very also just only more most much many '
    + 'each every both either neither about after before because until since though although whether every your yours ours mine '
    + 'himself herself itself myself yourself ourselves themselves cannot')
    .split(' ').forEach(function (w) { FUNCTION_WORDS[w] = true; });

  /* 사다리 4단계 전반 — 구 단위 클로즈로 가는 확장: 핵심어 빈칸에 더해 내용어(4자 이상,
     기능어 제외) 1~2개를 추가로 가린다. 추가 빈칸은 힌트가 없다(hintKo: null) — 힌트 없는
     인출이 이 단계의 목적이다. 같은 낱말은 한 번만 후보로 삼는다. */
  function clozeWide(sentence, rnd) {
    rnd = rnd || Math.random;
    var text = sentence.en || '';
    var taken = [], spans = [];
    (sentence.keywords || []).forEach(function (kw) {
      var sp = findSpan(text, kw.en, taken);
      if (!sp) return;
      sp.alt = kw.en;
      sp.extra = { hintKo: kw.ko };
      taken.push(sp); spans.push(sp);
    });
    var seen = {};
    spans.forEach(function (sp) { seen[text.substr(sp.start, sp.len).toLowerCase()] = true; });
    var cand = [], m, re = /[A-Za-z][A-Za-z'’-]{3,}/g;
    while ((m = re.exec(text))) {
      if (overlaps(taken, m.index, m[0].length)) continue;
      var k = m[0].toLowerCase();
      if (seen[k] || FUNCTION_WORDS[k]) continue;
      seen[k] = true;
      cand.push({ start: m.index, len: m[0].length, extra: { hintKo: null } });
    }
    var extraN = Math.min(cand.length, 1 + Math.floor(rnd() * 2));
    shuffle(cand, rnd).slice(0, extraN).forEach(function (sp) { spans.push(sp); });
    if (!spans.length) return null;
    spans.sort(byStart);
    return { type: 'clozewide', seq: sentence.seq, parts: buildParts(text, spans), koFull: sentence.ko };
  }

  /* 셔플이 원답 그대로면 다시 섞는다. 구분자는 토큰에 없는 제어문자 — 이어 붙여 비교하면
     ['a','ab'] 과 ['ab','a'] 같은 다른 순열이 같은 문자열이 되어 헛돈다.
     여러 번 해도 같으면(토큰이 전부 같은 문장) null — "이미 맞는 순서"는 문제가 아니다. */
  function shuffleDistinct(answer, rnd) {
    var key = answer.join('\u0001');
    for (var tries = 0; tries < 12; tries++) {
      var cand = shuffle(answer, rnd);
      if (cand.join('\u0001') !== key) return cand;
    }
    return null;
  }

  /* 사다리 4단계 후반 — 어구 토큰 셔플 → 재조립(워크북 8형).
     토큰이 3개 미만이면 문제가 아니다(2개는 뒤집기뿐). */
  function tokenOrder(sentence, rnd) {
    rnd = rnd || Math.random;
    var answer = (sentence.tokens || []).slice();
    if (answer.length < 3) return null;
    var shuffled = shuffleDistinct(answer, rnd);
    if (!shuffled) return null;
    return { type: 'order', seq: sentence.seq, shuffled: shuffled, answer: answer, koFull: sentence.ko };
  }

  /* 사다리 2단계 — 영어 청크 배열. 한글 청크를 직독직해 순서 그대로 보여 주고(koChunks)
     영어 청크를 잇는다. 철자를 한 자도 쓰지 않고 영어 순서를 세우는 칸이라 못 읽는 학생도 오른다.
     정답(영어 전문)은 화면에 없어야 하므로 enFull 은 싣지 않는다. 청크가 둘 미만이면 null. */
  function enChunkOrder(sentence, rnd) {
    rnd = rnd || Math.random;
    var chunks = (sentence.chunks || []).filter(function (c) { return c && c.en; });
    if (chunks.length < 2) return null;
    var answer = chunks.map(function (c) { return c.en; });
    var sh = shuffleDistinct(answer, rnd);
    if (!sh) return null;
    return {
      type: 'enorder', seq: sentence.seq, shuffled: sh, answer: answer,
      koChunks: chunks.map(function (c) { return c.ko || ''; }), koFull: sentence.ko || null,
    };
  }

  /* 사다리 5단계 — 한글만 보고 문장 영작(워크북 9형). writingKeywords는 힌트가 아니라
     채점·화면의 단어은행이다. */
  function writingPrompt(sentence, cue) {
    var c = cueLevel(cue);
    var q = {
      type: 'write', seq: sentence.seq, ko: sentence.ko,
      keywords: (sentence.writingKeywords || []).slice(), answers: [sentence.en],
    };
    if (c != null) {
      q.cue = c;
      q.showAnswer = c >= 3;
      q.given = c >= 3 ? String(sentence.en || '') : null;
      q.hint = c >= 3 ? String(sentence.en || '') || null : (c >= 1 ? enSkeleton(sentence.en, c >= 2) : null);
    }
    return q;
  }

  /* 키워드 스켈레톤(§14-3): 5단계(한글 전문)와 6단계(백지) 사이의 발판.
     문장당 핵심어 한 개(keywords[0].en)만 남기고 전문을 복원한다. */
  function skeleton(sentence) {
    var kws = sentence.keywords || [];
    var hint = kws.length ? kws[0].en : ((sentence.writingKeywords || [])[0] || null);
    return { type: 'skeleton', seq: sentence.seq, hint: hint, answers: [sentence.en] };
  }

  /* ── 워크북 파생형 ── */

  /* 워크북 5형 — 동사 원형을 주고 문장 속 알맞은 형태를 쓴다.
     verbForms가 비었거나 문장에서 하나도 못 찾으면 null. */
  function verbFormDrill(sentence) {
    var vfs = sentence.verbForms || [];
    if (!vfs.length) return null;
    var text = sentence.en || '', taken = [], spans = [];
    vfs.forEach(function (vf) {
      var sp = findSpan(text, vf.answer, taken);
      if (!sp) return;
      sp.alt = vf.answer;
      sp.extra = { base: vf.base };
      taken.push(sp); spans.push(sp);
    });
    if (!spans.length) return null;
    spans.sort(byStart);
    var parts = buildParts(text, spans);
    var blanks = [];
    parts.forEach(function (p) { if (p.blank) blanks.push({ base: p.blank.base, answers: p.blank.answers }); });
    return { type: 'verb', seq: sentence.seq, parts: parts, blanks: blanks, koFull: sentence.ko };
  }

  /* 워크북 6형 — 어법 2지선다. 정답 어구를 문장에서 가리고 두 선택지를 보인다.
     보기 순서는 데이터 그대로다(rnd 없음) — 원본 워크북의 배치가 정본이다. */
  function grammarChoiceDrill(sentence) {
    var gcs = sentence.grammarChoices || [];
    if (!gcs.length) return null;
    var out = [];
    gcs.forEach(function (gc) {
      var correct = (gc.options || [])[gc.answerIdx];
      if (correct == null) return;
      var sp = findSpan(sentence.en || '', correct, null);
      if (!sp) return;
      sp.alt = correct;
      out.push({
        type: 'grammar', seq: sentence.seq,
        parts: buildParts(sentence.en, [sp]),
        choices: gc.options.map(function (t, i) { return { key: String(i + 1), text: t }; }),
        answerKey: String(gc.answerIdx + 1), koFull: sentence.ko,
      });
    });
    return out.length ? out : null;
  }

  /* ── 단락·전체 관문 ── */

  var CIRCLED = '①②③④⑤⑥⑦⑧⑨';
  function circled(n) { return n >= 1 && n <= CIRCLED.length ? CIRCLED.charAt(n - 1) : '(' + n + ')'; }

  /* 지면 조각 자르기 — 고르는 자리는 {pick:{key,text}}. 이어 붙이면 원문이 그대로 나와야 한다. */
  function buildPickParts(text, spans) {
    var parts = [], pos = 0;
    spans.forEach(function (sp) {
      if (sp.start > pos) parts.push({ text: text.slice(pos, sp.start) });
      parts.push({ pick: { key: sp.key, text: text.slice(sp.start, sp.start + sp.len) } });
      pos = sp.start + sp.len;
    });
    if (pos < text.length) parts.push({ text: text.slice(pos) });
    return parts;
  }

  /* 단락 관문 — 어색한 곳 찾기. 팩의 oddOneItems 는 '한 곳만 바꾼 단락 지면'이다:
       { id, dayGroup, kind:'lexical'|'grammatical', sentences:[{seq,text}], options:[본문 조각…],
         answerIdx, correction, explanationKo, instructionKo? }
     옵션은 지면에 나오는 순서대로 ①②③④ 를 받는다 — 앞자리로 되돌아가 매칭하지 않도록
     줄 안에서도 커서를 전진시킨다. 조각을 하나라도 못 찾으면 null(번호가 어긋난 지면을
     학생에게 보이느니 문항을 내지 않는다). 그 단락 문항이 없어도 null.
     opts.index 로 같은 단락의 여러 문항을 돌려 쓴다(범위를 넘으면 앞으로 돈다). */
  function oddOneItem(oddOneItems, dayGroup, opts) {
    opts = opts || {};
    var list = (oddOneItems || []).filter(function (it) {
      return it && (dayGroup == null || it.dayGroup === dayGroup);
    });
    if (!list.length) return null;
    var n = list.length, i = opts.index == null ? 0 : ((opts.index | 0) % n + n) % n;
    var it = list[i], opt = it.options || [];
    if (opt.length < 2 || it.answerIdx == null || opt[it.answerIdx] == null) return null;
    var oi = 0, lines = [], bad = false;
    (it.sentences || []).forEach(function (ln) {
      var text = String((ln && ln.text) || ''), spans = [], cursor = 0;
      while (oi < opt.length) {
        var sp = findSpan(text, opt[oi], null, cursor);
        if (!sp) break;
        sp.key = String(oi + 1);
        spans.push(sp);
        cursor = sp.start + sp.len;
        oi += 1;
      }
      lines.push({ seq: ln && ln.seq != null ? ln.seq : null, text: text, parts: buildPickParts(text, spans) });
    });
    if (oi < opt.length || !lines.length) bad = true;
    if (bad) return null;
    var prompt = lines.map(function (ln) {
      return ln.parts.map(function (p) { return p.text != null ? p.text : circled(+p.pick.key) + p.pick.text; }).join('');
    }).join(' ');
    return {
      type: 'oddone', id: it.id || null, dayGroup: it.dayGroup || null, kind: it.kind || null,
      lines: lines, prompt: prompt,
      choices: opt.map(function (t, j) { return { key: String(j + 1), text: t }; }),
      answerKey: String(it.answerIdx + 1),
      correction: it.correction || null, explanationKo: it.explanationKo || null,
      koFull: it.instructionKo || '본문과 다르게 바뀐 곳을 고르세요.',
      index: i, total: n,
    };
  }

  /* 종합 Check — 팩의 checkItems 한 칸을 러너 문항으로. 슬롯 네 가지가 기존 문항 모양에 그대로 얹힌다:
       choice  → mcq(보기 셔플)      blank → parts+blank (본문 빈칸, ___ 자리에 answers)
       write   → write(영작)          arrange → order(토큰 배열)
     정답이 둘인 보기(같은 문구가 두 번), 빈칸 수와 정답 수 불일치, 빈 정답은 모두 null —
     최종 점검에서 답이 갈리는 문항은 없느니만 못하다. */
  function checkItem(it, rnd) {
    rnd = rnd || Math.random;
    if (!it || !it.slot) return null;
    var base = { checkId: it.id || null, slot: it.slot, seq: it.seq == null ? null : it.seq, kind: 'check' };
    function out(q) { for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) q[k] = base[k]; return q; }

    if (it.slot === 'choice') {
      var opts = (it.choices || []).map(function (t) { return String(t); });
      if (opts.length < 2 || it.answerIdx == null || opts[it.answerIdx] == null) return null;
      var seen = {}, dup = false;
      opts.forEach(function (t) { var k = norm(t); if (!k || seen[k]) dup = true; seen[k] = true; });
      if (dup) return null;
      var answer = opts[it.answerIdx];
      var kc = keyedChoices(answer, opts.filter(function (t, j) { return j !== it.answerIdx; }), rnd);
      return out({
        type: 'mcq', prompt: it.textEn || it.promptKo || '', koFull: it.textEn ? (it.promptKo || null) : null,
        choices: kc.choices, answerKey: kc.answerKey, explanationKo: it.explanationKo || null,
      });
    }

    if (it.slot === 'blank') {
      var text = String(it.textEn || ''), blanks = it.blanks || [];
      if (!text || !blanks.length) return null;
      var segs = text.split(/_{2,}/);
      if (segs.length - 1 !== blanks.length) return null;
      var parts = [], bad = false;
      segs.forEach(function (sg, j) {
        if (sg) parts.push({ text: sg });
        if (j >= blanks.length) return;
        var b = blanks[j] || {};
        var ans = Array.isArray(b.answers) ? b.answers.slice() : (b.answers ? [b.answers] : []);
        if (!ans.length) { bad = true; return; }
        parts.push({ blank: { answers: ans, hintKo: b.hintKo || null } });
      });
      if (bad) return null;
      return out({ type: 'ckblank', parts: parts, koFull: it.promptKo || null, explanationKo: it.explanationKo || null });
    }

    if (it.slot === 'write') {
      var answers = (it.answers || []).filter(function (a) { return a; });
      if (!answers.length || !it.ko) return null;
      return out({ type: 'write', ko: it.ko, keywords: (it.keywords || []).slice(), answers: answers });
    }

    if (it.slot === 'arrange') {
      var q = tokenOrder({ seq: it.seq, tokens: it.tokens || [], ko: it.ko || '' }, rnd);
      if (!q) return null;
      return out(q);
    }

    return null;                                   // 모르는 슬롯은 조용히 넘기지 않는다
  }

  /* 종합 Check 세트 — 팩의 슬롯 배열(기획 40슬롯)을 러너 문항 배열로.
     못 만든 칸은 건너뛰되 배열에 skipped(그 id 목록)를 달아 어디가 빠졌는지 남긴다.
     checkItems 가 없거나 한 문항도 못 만들면 null — 빈 배열을 돌려주면 화면이 조용히 빈다. */
  function checkSet(checkItems, rnd, opts) {
    rnd = rnd || Math.random;
    opts = opts || {};
    var list = (checkItems || []).slice();
    if (!list.length) return null;
    if (opts.shuffle) list = shuffle(list, rnd);
    var made = [], skipped = [];
    list.forEach(function (it) {
      var q = checkItem(it, rnd);
      if (q) made.push(q); else skipped.push((it && it.id) || null);
    });
    if (opts.limit) made = made.slice(0, opts.limit | 0);
    if (!made.length) return null;
    made.skipped = skipped;
    return made;
  }

  /* ── 세트 조립 ── */

  /* 사전 진단(§14-1) — 팩 진입 첫 세션: 전 단어 영→한 4지선다 + '모름' 버튼.
     진단이 곧 학습(pretesting)이고, 결과가 개인 출발선이 된다. 보기가 모자라는 작은 팩도
     남은 단어로라도 낸다 — 진단에서 빠진 단어는 출발선 없이 신규 큐에 묻힌다. */
  function diagnosticSet(pack, rnd) {
    rnd = rnd || Math.random;
    var out = [];
    (pack.words || []).forEach(function (w) {
      var q = vocabMcq(w, pack.words, rnd, { withUnknown: true, minDistractors: 0 });
      if (q) out.push(q);
    });
    return out;
  }

  /* 문자열 해시(작은 양의 정수) — 로테이션을 단어마다 다른 자리에서 시작시키는 데 쓴다 */
  function strHash(s) {
    var h = 0, str = String(s == null ? '' : s);
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0x7fffffff;
    return h;
  }

  /* 하루 세트 — 플래너가 산출한 planDay({words:{fresh,review,relearn}, sentences})를
     실제 문항 시퀀스로 조립한다. 항목은 id(문자열)든 객체든 받는다.
       fresh   : 첫 만남 — 재인(4지선다)으로 열고 힌트 철자로 굳힌다(힌트 철자는 도달이 아니다)
       review  : 미도달 단어는 무힌트 철자 — 도달 기회는 완전 인출뿐이라 재인 문항만 돌면
                 영원히 미도달이다. 도달 단어는 유형 로테이션(4지선다/예문 빈칸/영영풀이/
                 무힌트 철자) — 같은 단어를 늘 같은 각도로 보면 문항 답을 외우지 뜻을 외우지
                 않는다. 로테이션 자리는 단어 상태(id·오답·연속·날짜)로 정해 배열 위치와
                 무관하다. 그 단어로 못 만드는 유형은 다음 유형으로 폴백
       relearn : 무힌트 철자만 — 안정화 회전·철자 재검증은 짧고 완전한 인출이다(§14-1)
       문장    : 엔진 단계 정수 그대로 — 3 핵심어 빈칸, 4 클로즈+배열(2문항), 5 영작.
                 1·2·6단계는 앱이 직접 진행(읽기·해석·백지)하므로 여기선 만들지 않는다
     opts.states(또는 plan.states)로 상태 맵을 주면 도달 여부·로테이션에 쓴다. opts.now(ms)는
     날짜 해시용 — 없으면 Date.now()(rnd 미주입 시 Math.random과 같은 폴백). 0으로 고정하면
     상태를 안 넘기는 호출자에게서 같은 단어가 매일 같은 유형으로만 나와, 로테이션에 든
     무힌트 철자(도달 기회)가 영영 안 돌아온다. */
  function dailySet(pack, plan, rnd, opts) {
    rnd = rnd || Math.random;
    opts = opts || {};
    var states = opts.states || (plan && plan.states) || {};
    var now = opts.now != null ? +opts.now : (plan && plan.now != null ? +plan.now : Date.now());
    /* 로테이션 자리를 바꾸는 '하루'는 로컬 달력이어야 한다 — UTC 일수로 세면 경계가
       KST 09:00이라 같은 날 아침·오후에 유형이 바뀌고, 엔진의 날짜 판정(localDate)과도
       어긋난다. 연·월·일을 자리수로 접어 단조 증가하는 정수만 만든다(해시 씨앗용). */
    var dt = new Date(now);
    var dayNo = dt.getFullYear() * 372 + dt.getMonth() * 31 + dt.getDate();
    var byId = {}, bySeq = {}, out = [];
    (pack.words || []).forEach(function (w) { byId[w.id] = w; });
    (pack.sentences || []).forEach(function (s) { bySeq[s.seq] = s; });
    function word(ref) { return typeof ref === 'string' ? byId[ref] : ref; }
    function push(q, kind, stage) {
      if (!q) return;
      q.kind = kind;
      if (stage != null) q.stage = stage;
      out.push(q);
    }
    var words = (plan && plan.words) || {};

    (words.fresh || []).forEach(function (ref) {
      var w = word(ref);
      if (!w) return;
      push(vocabMcq(w, pack.words, rnd), 'word');
      push(spelling(w, rnd), 'word');
    });

    var rotation = [
      function (w) { return vocabMcq(w, pack.words, rnd); },
      function (w) { return exampleCloze(w); },
      function (w) { return definitionPick(w, pack.words, rnd); },
      function (w) { return spelling(w, rnd, { hint: false }); },
    ];
    (words.review || []).forEach(function (ref) {
      var w = word(ref);
      if (!w) return;
      var s = states[w.id];
      if (s && !s.reached) { push(spelling(w, rnd, { hint: false }), 'word'); return; }
      var base = strHash(w.id) + dayNo + (s ? ((s.wrong || 0) + (s.streak || 0)) : 0);
      for (var k = 0; k < rotation.length; k++) {
        var q = rotation[(base + k) % rotation.length](w);
        if (q) { push(q, 'word'); return; }
      }
    });

    (words.relearn || []).forEach(function (ref) {
      var w = word(ref);
      if (!w) return;
      push(spelling(w, rnd, { hint: false }), 'word');
    });

    var stageGens = {
      '3': function (s) { return [keywordBlanks(s, 'en')]; },
      '4': function (s) { return [clozeWide(s, rnd), tokenOrder(s, rnd)]; },
      '5': function (s) { return [writingPrompt(s)]; },
    };
    ((plan && plan.sentences) || []).forEach(function (ref) {
      var seq = typeof ref === 'number' ? ref : ref.seq;
      var stage = (ref && typeof ref === 'object' && ref.stage != null) ? ref.stage : 3;
      var s = bySeq[seq];
      if (!s) return;
      var gen = stageGens[String(stage)];
      if (!gen) return;
      gen(s).forEach(function (q) { push(q, 'sentence', stage); });
    });

    return out;
  }

  return {
    vocabMcq: vocabMcq, vocabMcqReverse: vocabMcqReverse, spelling: spelling,
    exampleCloze: exampleCloze, definitionPick: definitionPick,
    keywordBlanks: keywordBlanks, koBlanks: koBlanks, clozeWide: clozeWide,
    tokenOrder: tokenOrder, enChunkOrder: enChunkOrder,
    writingPrompt: writingPrompt, skeleton: skeleton,
    chunkMatch: chunkMatch, chunkMeaning: chunkMeaning, chunkOrder: chunkOrder,
    oddOneItem: oddOneItem, checkItem: checkItem, checkSet: checkSet,
    diagnosticSet: diagnosticSet, verbFormDrill: verbFormDrill,
    grammarChoiceDrill: grammarChoiceDrill, dailySet: dailySet,
    shuffle: shuffle, surfaceCandidates: surfaceCandidates,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WBGEN;
