'use strict';
/* WB 내신브레인 — 문항 생성 모듈 (브라우저/Node 공용)
   레슨 팩 마스터(단어·문장)에서 훈련 문항을 런타임 생성한다 — 변주 문항은 저장하지
   않는다는 팩 스키마 원칙(마스터 우선)의 실행부다.
     단어  : 뜻 4지선다(정/역방향) · 철자 입력 · 예문 빈칸 · 영영풀이 고르기 (기획 §4.1)
     문장  : 사다리 3~5.5단계 — 핵심어 빈칸 → 구 클로즈 → 순서 배열 → 영작 → 스켈레톤 (§4.2, §14-3)
     진단  : 전 단어 고속 4지선다 + '모름' 버튼 (§14-1 사전 인출 진단)
   모든 무작위성은 rnd(0~1 반환 함수) 주입 — 미주입 시 Math.random. 테스트는 시드 고정. */
var WBGEN = (function () {

  function shuffle(arr, rnd) {
    var a = arr.slice(), r = rnd || Math.random;
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(r() * (i + 1));
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

  /* 두 단어가 겹치는 section(대화문/본문)을 갖는가 — 같은 지문에서 함께 배우는 말인가 */
  function sharesSection(a, b) {
    var as = a.sections || [], bs = b.sections || [];
    for (var i = 0; i < as.length; i++) if (bs.indexOf(as[i]) >= 0) return true;
    return false;
  }

  /* 오답 보기 n개 — 같은 팩의 다른 단어에서(§2.2). 우선순위:
       ① 같은 section + 같은 품사 — 지금 함께 외우는, 문법으로 걸러지지 않는 보기
       ② 같은 section  ③ 같은 품사  ④ 나머지 — 문항을 못 내는 것보다 낫다
     정답과 겹치는 보기는 금지(뜻 문자열 기준 중복 제거). */
  function distractors(target, pool, pick, n, rnd) {
    var want = pick(target), seen = {}, both = [], sec = [], pos = [], rest = [];
    seen[String(want).toLowerCase()] = true;
    shuffle(pool || [], rnd).forEach(function (w) {
      if (w === target) return;
      if (w.id != null && target.id != null && w.id === target.id) return;
      var v = pick(w);
      if (!v) return;
      var k = String(v).toLowerCase();
      if (seen[k]) return;
      seen[k] = true;
      var s = sharesSection(w, target), p = !!(w.pos && target.pos && w.pos === target.pos);
      if (s && p) both.push(v);
      else if (s) sec.push(v);
      else if (p) pos.push(v);
      else rest.push(v);
    });
    return both.concat(sec, pos, rest).slice(0, n);
  }

  /* 보기 4개를 셔플하고 '1'~'4' 키를 붙인다. answerKey는 셔플 후의 정답 위치. */
  function keyedChoices(answer, opts, rnd) {
    var texts = shuffle([answer].concat(opts), rnd);
    var choices = texts.map(function (t, i) { return { key: String(i + 1), text: t }; });
    return { choices: choices, answerKey: String(texts.indexOf(answer) + 1) };
  }

  /* ── 단어 문항 ── */

  /* 뜻 4지선다 — 영어 headword를 보고 한국어 뜻을 고른다.
     opts.withUnknown이면 '0' 모름 선택지를 붙인다(§14-1: 진단에서 찍기를 막는 버튼 —
     찍어서 맞으면 출발선이 오염된다). 오답 3개를 못 채우면 null. */
  function vocabMcq(word, pool, rnd, opts) {
    rnd = rnd || Math.random;
    var answer = meaningOf(word);
    if (!answer) return null;
    var d = distractors(word, pool, meaningOf, 3, rnd);
    if (d.length < 3) return null;
    var kc = keyedChoices(answer, d, rnd);
    var q = { type: 'mcq', wordId: word.id, prompt: word.headword, choices: kc.choices, answerKey: kc.answerKey };
    if (opts && opts.withUnknown) {
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

  /* 철자 입력 — 뜻을 보고 headword를 쓴다. 힌트는 첫 글자 + 글자 수("s _ _ _ _ _ _").
     정답은 headword 하나뿐이다 — 불규칙형(kept)을 받으면 "썼다"는 착각만 남는다. */
  function spelling(word) {
    var h = String(word.headword || '');
    if (!h) return null;
    var hint = h[0];
    for (var i = 1; i < h.length; i++) hint += ' _';
    return { type: 'spell', wordId: word.id, promptKo: meaningOf(word), hint: hint, answers: [h] };
  }

  /* ── 표층형 탐색 ──
     예문 속 단어는 headword 그대로가 아니다 — keep은 kept로, call은 calling으로 나온다.
     후보: headword · irregularForms · 단순 파생(s/es/ed/ing). 긴 후보부터 찾아야
     'calling'을 두고 'call'만 오려 내는 일이 없다. 어절 경계 필수 — 'keep'이 'keeper'
     속에 걸리면 문장이 망가진다. */
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
     (밀물→밀물이) 경계를 강제하면 아무것도 못 찾는다. */
  function findSpan(text, needle, taken) {
    if (!needle) return null;
    var low = String(text).toLowerCase(), n = String(needle).toLowerCase();
    for (var i = low.indexOf(n); i >= 0; i = low.indexOf(n, i + 1)) {
      var before = text[i - 1], after = text[i + n.length];
      if (before && WORDCH.test(before) && WORDCH.test(n[0])) continue;
      if (after && WORDCH.test(after) && WORDCH.test(n[n.length - 1])) continue;
      if (taken && overlaps(taken, i, n.length)) continue;
      return { start: i, len: n.length };
    }
    return null;
  }

  function surfaceCandidates(word) {
    var h = String(word.headword || ''), seen = {}, out = [];
    var list = [h].concat(word.irregularForms || [], [h + 's', h + 'es', h + 'ed', h + 'ing']);
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
  function keywordBlanks(sentence, direction) {
    var dir = direction === 'ko' ? 'ko' : 'en';
    var text = sentence[dir] || '';
    var taken = [], spans = [];
    (sentence.keywords || []).forEach(function (kw) {
      var sp = findSpan(text, kw[dir], taken);
      if (!sp) return;
      sp.alt = kw[dir];
      sp.extra = dir === 'en' ? { hintKo: kw.ko } : { hintEn: kw.en };
      taken.push(sp); spans.push(sp);
    });
    if (!spans.length) return null;
    spans.sort(byStart);
    var q = { type: 'kwblank', seq: sentence.seq, direction: dir, parts: buildParts(text, spans) };
    if (dir === 'en') q.koFull = sentence.ko; else q.enFull = sentence.en;
    return q;
  }

  /* 사다리 4단계 전반 — 구 단위 클로즈로 가는 확장: 핵심어 빈칸에 더해 내용어(4자 이상)
     1~2개를 추가로 가린다. 추가 빈칸은 힌트가 없다(hintKo: null) — 힌트 없는 인출이
     이 단계의 목적이다. 같은 낱말은 한 번만 후보로 삼는다. */
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
      if (seen[k]) continue;
      seen[k] = true;
      cand.push({ start: m.index, len: m[0].length, extra: { hintKo: null } });
    }
    var extraN = Math.min(cand.length, 1 + Math.floor(rnd() * 2));
    shuffle(cand, rnd).slice(0, extraN).forEach(function (sp) { spans.push(sp); });
    if (!spans.length) return null;
    spans.sort(byStart);
    return { type: 'clozewide', seq: sentence.seq, parts: buildParts(text, spans), koFull: sentence.ko };
  }

  /* 사다리 4단계 후반 — 어구 토큰 셔플 → 재조립(워크북 8형).
     셔플이 원답 그대로 나오면 1회 재셔플한다 — "이미 맞는 순서"는 문제가 아니다. */
  function tokenOrder(sentence, rnd) {
    rnd = rnd || Math.random;
    var answer = (sentence.tokens || []).slice();
    if (answer.length < 2) return null;
    var shuffled = shuffle(answer, rnd);
    if (shuffled.join('') === answer.join('')) shuffled = shuffle(answer, rnd);
    return { type: 'order', seq: sentence.seq, shuffled: shuffled, answer: answer, koFull: sentence.ko };
  }

  /* 사다리 5단계 — 한글만 보고 문장 영작(워크북 9형). writingKeywords는 힌트가 아니라
     채점·화면의 단어은행이다. */
  function writingPrompt(sentence) {
    return {
      type: 'write', seq: sentence.seq, ko: sentence.ko,
      keywords: (sentence.writingKeywords || []).slice(), answers: [sentence.en],
    };
  }

  /* 5.5단계 — 키워드 스켈레톤(§14-3): 5단계(한글 전문)와 6단계(백지) 사이의 발판.
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

  /* ── 세트 조립 ── */

  /* 사전 진단(§14-1) — 팩 진입 첫 세션: 전 단어 영→한 4지선다 + '모름' 버튼.
     진단이 곧 학습(pretesting)이고, 결과가 개인 출발선이 된다. */
  function diagnosticSet(pack, rnd) {
    rnd = rnd || Math.random;
    var out = [];
    (pack.words || []).forEach(function (w) {
      var q = vocabMcq(w, pack.words, rnd, { withUnknown: true });
      if (q) out.push(q);
    });
    return out;
  }

  /* 하루 세트 — 플래너가 산출한 planDay({words:{fresh,review,relearn}, sentences})를
     실제 문항 시퀀스로 조립한다. 항목은 id(문자열)든 객체든 받는다.
       fresh   : 첫 만남 — 재인(4지선다)으로 열고 곧장 인출(철자)로 굳힌다
       review  : 유형 로테이션(4지선다/예문 빈칸/영영풀이) — 같은 단어를 늘 같은 각도로
                 보면 문항 답을 외우지 뜻을 외우지 않는다. 그 단어로 못 만드는 유형은
                 다음 유형으로 폴백 — 문항을 못 내는 것보다 낫다
       relearn : 철자 입력만 — D-7 이후 고속 재인출 안정화(§14-1)는 짧고 완전한 인출이다
       문장    : stage에 맞는 사다리 생성기(3→핵심어, 4→구 클로즈, 4.5→배열, 5→영작, 5.5→스켈레톤) */
  function dailySet(pack, plan, rnd) {
    rnd = rnd || Math.random;
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
      push(spelling(w), 'word');
    });

    var rotation = [
      function (w) { return vocabMcq(w, pack.words, rnd); },
      function (w) { return exampleCloze(w); },
      function (w) { return definitionPick(w, pack.words, rnd); },
    ];
    (words.review || []).forEach(function (ref, i) {
      var w = word(ref);
      if (!w) return;
      for (var k = 0; k < rotation.length; k++) {
        var q = rotation[(i + k) % rotation.length](w);
        if (q) { push(q, 'word'); return; }
      }
    });

    (words.relearn || []).forEach(function (ref) {
      var w = word(ref);
      if (!w) return;
      push(spelling(w), 'word');
    });

    var stageGens = {
      '3': function (s) { return keywordBlanks(s, 'en'); },
      '4': function (s) { return clozeWide(s, rnd); },
      '4.5': function (s) { return tokenOrder(s, rnd); },
      '5': function (s) { return writingPrompt(s); },
      '5.5': function (s) { return skeleton(s); },
    };
    ((plan && plan.sentences) || []).forEach(function (ref) {
      var seq = typeof ref === 'number' ? ref : ref.seq;
      var stage = (ref && typeof ref === 'object' && ref.stage != null) ? ref.stage : 3;
      var s = bySeq[seq];
      if (!s) return;
      var gen = stageGens[String(stage)] || stageGens['3'];
      push(gen(s), 'sentence', stage);
    });

    return out;
  }

  return {
    vocabMcq: vocabMcq, vocabMcqReverse: vocabMcqReverse, spelling: spelling,
    exampleCloze: exampleCloze, definitionPick: definitionPick,
    keywordBlanks: keywordBlanks, clozeWide: clozeWide, tokenOrder: tokenOrder,
    writingPrompt: writingPrompt, skeleton: skeleton,
    diagnosticSet: diagnosticSet, verbFormDrill: verbFormDrill,
    grammarChoiceDrill: grammarChoiceDrill, dailySet: dailySet,
    shuffle: shuffle,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WBGEN;
