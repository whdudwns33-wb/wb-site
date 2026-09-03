'use strict';
/* WB 국어브레인 — 문항 생성기 (순수 로직, 브라우저/Node 공용)
   기획서 §4.3: 작품 정본의 '구절 ↔ 개념' 쌍(작품당 10~15)에서 훈련 문항을 런타임 생성한다.
   저장하지 않는다 — 무한 재출제가 목적이고, 고유 문항(객관식·서술형·확인 문제)만 팩에 있다.

   설계 규칙 세 가지:
   1) 형식을 실전에 맞춘다(§1.4-7 반응 일치성) — 지문 제시·5지선다·부정발문·<보기>.
      선지의 추론 깊이까지 흉내 내지는 않는다. 깊이는 저장 문항(단원집중)이 담당한다.
   2) 오답 보기는 혼동 쌍(confusableWith) 우선 — 유사 범주 구별에서만 교차 효과가
      크다는 근거를 따른다. 어휘(단어) 퀴즈에는 혼동 쌍을 쓰지 않는다(역효과 근거).
   3) 모든 무작위성은 rnd를 주입받는다 — 테스트에서 시드를 고정하기 위해. */
var WBKOGEN = (function () {
  var CHOICE_N = 5;   // 실전(단원집중)이 5지선다다

  function rndDefault() { return Math.random(); }

  function shuffle(arr, rnd) {
    var a = arr.slice(), i, j, t;
    for (i = a.length - 1; i > 0; i--) {
      j = Math.floor((rnd || rndDefault)() * (i + 1));
      t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function pick(arr, rnd) { return arr[Math.floor((rnd || rndDefault)() * arr.length)]; }

  /* 선지에 키를 붙여 섞는다 — 정답 위치가 매번 달라지고, 채점은 key로 한다 */
  function keyedChoices(correctText, distractorTexts, rnd) {
    var all = [{ key: 'c', text: correctText, correct: true }];
    distractorTexts.forEach(function (t, i) { all.push({ key: 'd' + i, text: t, correct: false }); });
    return shuffle(all, rnd).map(function (c, i) { return { no: i + 1, key: c.key, text: c.text, correct: c.correct }; });
  }

  /* 오답 보기 계층(§4.3) — 혼동 쌍 → 같은 범주 → 사전의 나머지.
     conceptId가 없거나 사전이 얇으면 자연히 뒤 계층으로 내려간다. */
  function distractorsKo(targetId, concepts, n, rnd, opts) {
    opts = opts || {};
    var byId = {};
    (concepts || []).forEach(function (c) { byId[c.id] = c; });
    var target = byId[targetId];
    var used = {}; used[targetId] = true;
    var out = [];
    function take(list) {
      shuffle(list || [], rnd).forEach(function (id) {
        if (out.length >= n || used[id] || !byId[id]) return;
        if (opts.excludeIds && opts.excludeIds.indexOf(id) >= 0) return;
        used[id] = true; out.push(id);
      });
    }
    if (target) take(target.confusableWith);
    if (out.length < n && target) {
      take((concepts || []).filter(function (c) { return c.category === target.category; })
        .map(function (c) { return c.id; }));
    }
    if (out.length < n) take((concepts || []).map(function (c) { return c.id; }));
    return out;
  }

  function termOf(concepts, id, fallback) {
    var c = (concepts || []).filter(function (x) { return x.id === id; })[0];
    return (c && c.term) || fallback || id;
  }

  /* ── 3단계 구절 적용 ── */

  /* 표현법 판별 — "㉠에 쓰인 표현 방법으로 가장 적절한 것은?" */
  function rhetoricItem(work, r, concepts, rnd) {
    var right = r.name || termOf(concepts, r.conceptId);
    var dIds = distractorsKo(r.conceptId, concepts, CHOICE_N - 1, rnd);
    var ds = dIds.map(function (id) { return termOf(concepts, id); })
      .filter(function (t) { return t !== right; });
    if (ds.length < CHOICE_N - 1) return null;      // 사전이 얇으면 이 문항은 건너뛴다
    return {
      id: 'g-rh-' + work.workId + '-' + r.id,
      gen: true, workId: work.workId, kind: 'rhetoric', conceptId: r.conceptId,
      stem: '다음 구절에 쓰인 표현 방법으로 가장 적절한 것은?',
      quote: r.quote,
      choices: keyedChoices(right, ds.slice(0, CHOICE_N - 1), rnd),
      evidence: r.quote, explain: r.effect || null
    };
  }

  /* 시어 의미 — 극성(polarity)이 있는 작품에서만 반대 극성을 오답으로 쓰고,
     없으면 같은 작품의 다른 시어 의미로 폴백한다(§4.3). */
  function keywordItem(work, kw, rnd) {
    var others = (work.keywords || []).filter(function (k) { return k.id !== kw.id && k.meaning; });
    if (kw.polarity) {
      var opp = others.filter(function (k) { return k.polarity && k.polarity !== kw.polarity; });
      if (opp.length) others = opp.concat(others.filter(function (k) { return opp.indexOf(k) < 0; }));
    }
    if (others.length < CHOICE_N - 1) return null;
    var ds = shuffle(others, rnd).slice(0, CHOICE_N - 1).map(function (k) { return k.meaning; });
    return {
      id: 'g-kw-' + work.workId + '-' + kw.id,
      gen: true, workId: work.workId, kind: 'keyword',
      stem: '㉠의 함축적 의미로 가장 적절한 것은?',
      quote: (kw.quotes && kw.quotes[0]) || kw.word,
      mark: '㉠', markWord: kw.word,
      choices: keyedChoices(kw.meaning, ds, rnd),
      evidence: (kw.quotes && kw.quotes[0]) || null, explain: null
    };
  }

  /* 화자 태도 — 정본 attitude가 정답, 오답은 인접·반대 태도 목록에서.
     작품 정본에 태도 후보가 부족하면 만들지 않는다(억지 오답을 만들지 않는다). */
  var ATTITUDE_POOL = ['비판적', '예찬적', '체념적', '관조적', '반성적', '냉소적', '의지적', '해학적', '애상적', '낙관적'];
  function speakerItem(work, rnd) {
    var sp = work.speaker;
    if (!sp || !sp.attitude || !sp.attitude.length) return null;
    var right = sp.attitude[0];
    var ds = shuffle(ATTITUDE_POOL.filter(function (a) { return sp.attitude.indexOf(a) < 0; }), rnd)
      .slice(0, CHOICE_N - 1);
    if (ds.length < CHOICE_N - 1) return null;
    return {
      id: 'g-sp-' + work.workId,
      gen: true, workId: work.workId, kind: 'speaker',
      stem: '이 작품의 화자가 대상을 대하는 태도로 가장 적절한 것은?',
      quote: sp.evidence || null,
      choices: keyedChoices(right, ds, rnd),
      evidence: sp.evidence || null, explain: sp.situation || null
    };
  }

  /* 부정발문 — 구절·표현법 쌍 5개로 진술을 만들고 하나만 뒤바꾼다.
     "적절하지 않은 것"이 실전 21문항 중 약 절반이므로 형식을 맞춘다(§2.2-4). */
  function negativeRhetoricItem(work, concepts, rnd) {
    var pairs = (work.rhetoric || []).filter(function (r) { return r.quote; });
    if (pairs.length < CHOICE_N) return null;
    var picked = shuffle(pairs, rnd).slice(0, CHOICE_N);
    var wrongAt = Math.floor((rnd || rndDefault)() * CHOICE_N);
    var wrongPair = picked[wrongAt];
    var swapId = distractorsKo(wrongPair.conceptId, concepts, 1, rnd)[0];
    var swapped = swapId ? termOf(concepts, swapId) : null;
    if (!swapped) return null;
    var choices = picked.map(function (r, i) {
      var name = i === wrongAt ? swapped : (r.name || termOf(concepts, r.conceptId));
      return {
        no: i + 1, key: 'n' + i, correct: i === wrongAt,
        text: '『' + r.quote + '』에는 ' + name + '이(가) 쓰였다.'
      };
    });
    return {
      id: 'g-neg-' + work.workId + '-' + wrongPair.id,
      gen: true, workId: work.workId, kind: 'rhetoric', negative: true,
      stem: '이 작품의 표현에 대한 설명으로 적절하지 <b>않은</b> 것은?',
      choices: choices,
      evidence: wrongPair.quote,
      explain: '『' + wrongPair.quote + '』에 쓰인 것은 ' + (wrongPair.name || termOf(concepts, wrongPair.conceptId)) + '입니다.'
    };
  }

  /* <보기> 제시형 — 개념 정의를 <보기>로 주고 그 개념이 쓰인 구절을 고르게 한다 */
  function bogiItem(work, r, concepts, rnd) {
    var c = (concepts || []).filter(function (x) { return x.id === r.conceptId; })[0];
    if (!c || !c.definition) return null;
    var others = (work.rhetoric || []).filter(function (x) { return x.id !== r.id && x.quote && x.conceptId !== r.conceptId; });
    if (others.length < CHOICE_N - 1) return null;
    var ds = shuffle(others, rnd).slice(0, CHOICE_N - 1).map(function (x) { return x.quote; });
    return {
      id: 'g-bg-' + work.workId + '-' + r.id,
      gen: true, workId: work.workId, kind: 'rhetoric', conceptId: r.conceptId,
      stem: '<보기>의 표현 방법이 쓰인 구절로 가장 적절한 것은?',
      bogi: { kind: '개념제시', text: c.term + ': ' + c.definition },
      choices: keyedChoices(r.quote, ds, rnd),
      evidence: r.quote, explain: c.definition
    };
  }

  /* OX 변형 — 정본 진술을 그대로(참) 또는 뒤집어(거짓) 낸다 */
  function oxItem(work, kw, rnd, flip) {
    if (!kw.meaning) return null;
    var others = (work.keywords || []).filter(function (k) { return k.id !== kw.id && k.meaning; });
    var meaning = kw.meaning;
    if (flip && others.length) meaning = pick(others, rnd).meaning;
    return {
      id: 'g-ox-' + work.workId + '-' + kw.id + (flip ? '-f' : ''),
      gen: true, workId: work.workId, kind: 'ox',
      stem: '‘' + kw.word + '’은(는) ' + meaning + '을(를) 뜻한다.',
      answer: !flip,
      evidence: (kw.quotes && kw.quotes[0]) || null,
      explain: '‘' + kw.word + '’은(는) ' + kw.meaning + '을(를) 뜻합니다.'
    };
  }

  /* 연결하기 — 시어·표현법 용어 ↔ 설명 (확인 문제 형식 그대로) */
  function matchingItem(work, rnd) {
    var pool = [];
    (work.keywords || []).forEach(function (k) { if (k.meaning) pool.push({ term: k.word, def: k.meaning }); });
    (work.rhetoric || []).forEach(function (r) { if (r.effect) pool.push({ term: r.name, def: r.effect }); });
    if (pool.length < 3) return null;
    var picked = shuffle(pool, rnd).slice(0, Math.min(5, pool.length));
    return {
      id: 'g-mt-' + work.workId,
      gen: true, workId: work.workId, kind: 'matching',
      stem: '다음 말과 설명을 알맞게 연결하세요.',
      terms: picked.map(function (p, i) { return { key: 'm' + i, text: p.term }; }),
      defs: shuffle(picked.map(function (p, i) { return { key: 'm' + i, text: p.def }; }), rnd)
    };
  }

  /* ── 2단계 개념 빈칸 (단답) ── */
  function blankItem(work, b) {
    return {
      id: 'g-bl-' + b.id, gen: true, workId: work.workId, kind: 'blank', blankId: b.id,
      stem: b.label || '빈칸에 알맞은 말을 쓰세요.',
      context: b.text, answers: b.answers, hintLen: (b.answers && b.answers[0] || '').length,
      /* 한 문맥에 □ 무리가 여럿일 때 이 빈칸이 몇 번째인지. 없으면 첫 무리(옛 팩 호환) */
      slot: b.slot || 0
    };
  }

  /* ── 어휘·개념어 ──
     문맥 적용형을 함께 낸다 — 국어 어휘는 뜻 고르기보다 선지·문맥형으로 출제된다.
     오답 보기는 같은 범주에서만 뽑는다(혼동 쌍 교차는 단어 학습에서 역효과). */
  function vocabItem(work, v, allVocab, concepts, rnd) {
    var pool = (allVocab || []).filter(function (x) { return x.id !== v.id && x.definition; });
    if (pool.length < CHOICE_N - 1) {
      pool = pool.concat((concepts || []).filter(function (c) {
        return c.id !== v.conceptId && c.definition;
      }).map(function (c) { return { id: c.id, term: c.term, definition: c.definition }; }));
    }
    if (pool.length < CHOICE_N - 1) return null;
    var ds = shuffle(pool, rnd).slice(0, CHOICE_N - 1).map(function (x) { return x.definition; });
    return {
      id: 'g-vc-' + work.workId + '-' + v.id,
      gen: true, workId: work.workId, kind: 'vocab', vocabId: v.id,
      stem: '‘' + v.term + '’의 뜻으로 알맞은 것은?',
      choices: keyedChoices(v.definition, ds, rnd),
      explain: v.definition
    };
  }

  /* ── 4단계 주석 복원 대상 ──
     지문 기호(㉠…)와 연 요지를 항목으로 만든다. 채점은 grade.gradeRestore. */
  function restoreTargets(work) {
    var out = [];
    (work.rhetoric || []).forEach(function (r) {
      if (!r.mark) return;
      out.push({
        id: 'rt-rh-' + r.id, kind: 'rhetoric', label: r.mark + '의 표현 방법과 효과',
        quote: r.quote, keywords: [r.name].concat(r.effect ? [r.effect] : []).filter(Boolean)
      });
    });
    (work.keywords || []).forEach(function (k) {
      if (!k.mark) return;
      out.push({
        id: 'rt-kw-' + k.id, kind: 'keyword', label: k.mark + ' ‘' + k.word + '’의 함축적 의미',
        quote: (k.quotes && k.quotes[0]) || null, keywords: k.meaning ? [k.meaning] : []
      });
    });
    (work.composition || []).forEach(function (c, i) {
      out.push({
        id: 'rt-cp-' + i, kind: 'composition', label: c.range + '의 내용',
        quote: null, keywords: c.summary ? [c.summary] : []
      });
    });
    return out;
  }

  /* ── 세트 조립 ── */

  /* 3단계 적용 세트 — 부정발문·<보기> 비율을 섞는다.
     negRatio 기본값은 이 자료 실측(약 10~11/21)에서 왔고, 시험 프로파일이 있으면
     그 값으로 갱신된다(§4.3). */
  function applySet(work, concepts, n, rnd, opts) {
    opts = opts || {};
    var negRatio = opts.negRatio == null ? 0.5 : opts.negRatio;
    var out = [];
    var neg = negativeRhetoricItem(work, concepts, rnd);
    if (neg && (rnd || rndDefault)() < negRatio) out.push(neg);

    var rhet = shuffle(work.rhetoric || [], rnd);
    var bogiMade = false;
    rhet.forEach(function (r) {
      if (out.length >= n) return;
      if (!bogiMade) {
        var b = bogiItem(work, r, concepts, rnd);
        if (b) { out.push(b); bogiMade = true; return; }
      }
      var it = rhetoricItem(work, r, concepts, rnd);
      if (it) out.push(it);
    });
    shuffle(work.keywords || [], rnd).forEach(function (k) {
      if (out.length >= n) return;
      var it = keywordItem(work, k, rnd);
      if (it) out.push(it);
    });
    if (out.length < n) {
      var sp = speakerItem(work, rnd);
      if (sp) out.push(sp);
    }
    shuffle(work.keywords || [], rnd).forEach(function (k, i) {
      if (out.length >= n) return;
      var it = oxItem(work, k, rnd, i % 2 === 1);
      if (it) out.push(it);
    });
    return out.slice(0, n);
  }

  /* 오늘의 세트 — planDay 출력을 문항으로 바꾼다(§4.5 세션 유형별로 나눠 쓴다) */
  function dailySetKo(plan, pack, concepts, rnd, opts) {
    opts = opts || {};
    var byId = {};
    (pack.works || []).forEach(function (w) { byId[w.workId] = w; });
    var vocabById = {}, blankById = {}, allVocab = [];
    (pack.works || []).forEach(function (w) {
      (w.vocab || []).forEach(function (v) { vocabById[v.id] = { work: w, v: v }; allVocab.push(v); });
      (w.blanks || []).forEach(function (b) { blankById[b.id] = { work: w, b: b }; });
    });

    var vocabItems = [];
    ['fresh', 'review', 'relearn'].forEach(function (k) {
      (plan.vocab[k] || []).forEach(function (id) {
        var rec = vocabById[id];
        if (!rec) return;
        var it = vocabItem(rec.work, rec.v, allVocab, concepts, rnd);
        if (it) { it.queue = k; vocabItems.push(it); }
      });
    });

    var blankItems = [];
    ['fresh', 'review', 'relearn'].forEach(function (k) {
      (plan.blanks[k] || []).forEach(function (id) {
        var rec = blankById[id];
        if (!rec) return;
        var it = blankItem(rec.work, rec.b);
        it.queue = k; blankItems.push(it);
      });
    });

    var applyItems = [];
    (plan.works || []).forEach(function (w) {
      if (w.stage < 3) return;
      var work = byId[w.workId];
      if (!work) return;
      applyItems = applyItems.concat(applySet(work, concepts, opts.applyPerWork || 5, rnd, opts));
    });

    return { vocab: vocabItems, blanks: blankItems, apply: applyItems };
  }

  return {
    CHOICE_N: CHOICE_N, shuffle: shuffle, keyedChoices: keyedChoices, distractorsKo: distractorsKo,
    rhetoricItem: rhetoricItem, keywordItem: keywordItem, speakerItem: speakerItem,
    negativeRhetoricItem: negativeRhetoricItem, bogiItem: bogiItem,
    oxItem: oxItem, matchingItem: matchingItem, blankItem: blankItem, vocabItem: vocabItem,
    restoreTargets: restoreTargets, applySet: applySet, dailySetKo: dailySetKo
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WBKOGEN;
