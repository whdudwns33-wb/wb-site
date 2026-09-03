'use strict';
/* WB 국어브레인 — 채점 모듈 (브라우저/Node 공용)
   기획서 §5.3 채점 5모드: auto(선택형) / auto_ko(단답 정규화) /
   rubric(서술형 1층 — 조건·요소·문장 완결) / hybrid(AI, Phase 2) / self(셀프 체크).
   §4.4 주석 복원: 정본 키워드 커버리지 매트릭스.

   영어 grade.js의 normalizeEn은 `[^a-z0-9\s]` 필터라 한글을 통째로 지운다 — 못 쓴다.
   조사 목록(JOSA)·stripJosa는 영어 앱의 해석 청크 채점기에서 쓰던 것을 그대로 가져왔다.
   두 앱이 같은 목록을 쓰도록 테스트로 고정한다(§9.4). */
var WBKOGRADE = (function () {

  /* ── 한국어 정규화 (auto_ko, §9.4) ──
     "은유법"·"은유법."·"은 유 법"·"은유법이다"를 같은 답으로 본다.
     순서: NFC → 괄호 병기 분리 → 문장부호 제거 → 공백 제거 → (단답이면) 끝 조사 제거.
     공백을 통째로 지우는 이유: 중학생 답안의 띄어쓰기는 신뢰할 수 없고,
     단답 채점에서 띄어쓰기 오류로 오답을 내면 채점기가 학습을 방해한다. */

  var JOSA = ['에서는', '에게서', '에서', '에게', '으로', '부터', '까지', '처럼', '보다', '한테', '께서', '에는',
    '은', '는', '이', '가', '을', '를', '의', '에', '로', '와', '과', '도', '만'];

  /* 서술격 조사 — '은유법이다'를 '은유법'으로. JOSA에 넣지 않는 이유는 이것이
     체언 뒤 조사가 아니라 서술어 어미라서, 영어 앱과 공유하는 목록을 오염시키기 때문이다.
     한 글자('다')는 떼지 않는다 — '바다'가 '바'가 되어 버린다. */
  var COPULA = ['이었다', '이에요', '입니다', '였다', '이다', '예요'];

  function stripJosa(w) {
    for (var k = 0; k < JOSA.length; k++) {
      var j = JOSA[k];
      if (w.length > j.length && w.slice(-j.length) === j) return w.slice(0, -j.length);
    }
    return w;
  }

  function stripEnding(w) {
    for (var i = 0; i < COPULA.length; i++) {
      var c = COPULA[i];
      if (w.length > c.length && w.slice(-c.length) === c) return w.slice(0, -c.length);
    }
    return stripJosa(w);
  }

  function nfc(s) {
    var t = String(s == null ? '' : s);
    return t.normalize ? t.normalize('NFC') : t;
  }

  function normalizeKo(s, opts) {
    opts = opts || {};
    var t = nfc(s);
    t = t.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');
    /* 괄호 병기는 지운다 — '화장(점액질)'과 '화장'이 만나게. 괄호 안만 쓴 답은
       parseAccepted가 별도 인정답으로 따로 만들어 둔다. */
    t = t.replace(/[（(][^)）]*[)）]/g, '');
    t = t.replace(/[^0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ一-鿕\s]/g, ' ');  // 기호·문장부호 → 공백
    t = t.replace(/\s+/g, '');                                      // 띄어쓰기 관대
    if (opts.josa) t = stripEnding(t);
    return t;
  }

  /* 자료의 복수 정답 표기를 인정답 배열로 편다.
     '자유시 / 서정시'  → ['자유시','서정시']
     '비린내·향기'      → 구분자가 가운뎃점 하나뿐일 때만 분리(시어 나열과 구별이 안 되므로
                          기본은 분리하지 않고, splitDot 옵션이 켜졌을 때만)
     '화장(점액질)'     → ['화장(점액질)', '화장', '점액질'] */
  function parseAccepted(raw, opts) {
    opts = opts || {};
    var out = [];
    function add(v) {
      var t = nfc(v).trim();
      if (t && out.indexOf(t) < 0) out.push(t);
    }
    var list = Array.isArray(raw) ? raw : [raw];
    list.forEach(function (one) {
      var s = nfc(one).trim();
      if (!s) return;
      var parts = s.split(/\s*(?:\/|또는)\s*/);
      if (opts.splitDot && parts.length === 1) parts = s.split(/\s*·\s*/);
      parts.forEach(function (p) {
        add(p);
        var m = p.match(/^(.*?)[（(]([^)）]+)[)）]\s*$/);
        if (m) { add(m[1]); add(m[2]); }
      });
    });
    return out;
  }

  /* 단답 채점 — 인정답 중 하나와 정규화 결과가 같으면 정답.
     matched: 어느 표기로 인정됐는지(학생에게 "이 표기로 인정" 표시용). */
  function gradeAnswer(input, accepted, opts) {
    opts = opts || {};
    var cands = parseAccepted(accepted, opts);
    var a = normalizeKo(input, opts);
    if (!a) return { correct: false, matched: null };
    for (var i = 0; i < cands.length; i++) {
      if (normalizeKo(cands[i], opts) === a) return { correct: true, matched: cands[i] };
    }
    /* 조사만 다른 답은 단답 모드에서 한 번 더 본다 — '은유법을'과 '은유법' */
    if (!opts.josa) {
      var b = normalizeKo(input, { josa: true });
      for (var k = 0; k < cands.length; k++) {
        if (normalizeKo(cands[k], { josa: true }) === b) return { correct: true, matched: cands[k] };
      }
    }
    return { correct: false, matched: null };
  }

  /* 여러 빈칸 한 번에 — blanks: [{id, answers[]}], inputs: {id: 값} */
  function gradeBlanks(inputs, blanks, opts) {
    var per = (blanks || []).map(function (b) {
      var r = gradeAnswer((inputs || {})[b.id], b.answers, opts);
      return { id: b.id, correct: r.correct, matched: r.matched, answers: b.answers };
    });
    var right = per.filter(function (p) { return p.correct; }).length;
    return { perBlank: per, right: right, total: per.length, allCorrect: per.length > 0 && right === per.length };
  }

  /* ── 키워드 존재 판정 ──
     조사를 떼고(가족은→가족), 용언 종결어미를 근사로 뗀다(들었다→들었).
     활용까지 다 좇을 수 없으니 앞 2자를 예비 후보로 둔다(갈매기들이→갈매).
     정밀 형태소 분석이 아니라 "이 요소를 아예 안 썼다"를 잡는 용도다. */
  function coreCands(word) {
    var cands = [], base = stripJosa(word);
    function add(c) { if (c.length >= 2 && cands.indexOf(c) < 0) cands.push(c); }
    add(base);
    add(base.replace(/[다요]$/, ''));
    add(base.slice(0, 2));
    if (!cands.length) add(word.slice(0, 2));
    return cands;
  }

  /* 키워드 하나가 답안에 있는가 — 인정 변형(acceptedVariants)도 함께 본다 */
  function hasKeyword(inputNorm, keyword, variants) {
    var all = [keyword].concat(variants || []);
    for (var i = 0; i < all.length; i++) {
      var kw = normalizeKo(all[i]);
      if (!kw) continue;
      if (inputNorm.indexOf(kw) >= 0) return true;
      var cands = coreCands(kw);
      for (var k = 0; k < cands.length; k++) {
        if (cands[k].length >= 2 && inputNorm.indexOf(cands[k]) >= 0) return true;
      }
    }
    return false;
  }

  /* ── 서술형 조건 검사(§1.4-5) ──
     conditions: [{kind, value, text}]
       include  : value = ['편견','존중']   — 필수 어구 전부 포함
       sentences: value = 1 | [1,2]        — 문장 수
       chars    : value = [80,120]         — 글자 수(공백 포함)
       words    : value = 3                — 어절 수
       form     : value = '~때문에 ~하다'   — 지정 형식(어미·틀). 핵심 조각만 본다
       quote    : value = '본문 인용'       — 사람 확인 항목(자동 판정하지 않는다) */
  function countSentences(s) {
    var t = nfc(s).trim();
    if (!t) return 0;
    var parts = t.split(/[.!?。？！]+|\n+/).map(function (x) { return x.trim(); }).filter(Boolean);
    return parts.length || (t ? 1 : 0);
  }

  function countWords(s) {
    var t = nfc(s).trim();
    if (!t) return 0;
    return t.split(/\s+/).filter(Boolean).length;
  }

  /* 문장 완결 — 종결 어미로 끝나는가. 핵심어만 나열한 답안을 거르는 장치(§5.3).
     '~이다/한다/했다/합니다/~요' 계열과 물음표를 인정한다. */
  var ENDING_RE = /(다|요|까|죠|네|오)[.!?]?\s*$/;
  function isComplete(s) {
    var t = nfc(s).trim();
    if (!t) return false;
    if (countWords(t) < 3) return false;   // 한두 낱말은 서술이 아니다
    return ENDING_RE.test(t);
  }

  function checkConditions(input, conditions) {
    var t = nfc(input);
    var norm = normalizeKo(t);
    return (conditions || []).map(function (c) {
      var kind = c.kind, v = c.value, pass = true, detail = '';
      if (kind === 'include') {
        var miss = (Array.isArray(v) ? v : [v]).filter(function (w) {
          return norm.indexOf(normalizeKo(w)) < 0;
        });
        pass = miss.length === 0;
        if (!pass) detail = '빠진 어구: ' + miss.join(', ');
      } else if (kind === 'sentences') {
        var n = countSentences(t);
        var lo = Array.isArray(v) ? v[0] : v, hi = Array.isArray(v) ? v[1] : v;
        pass = n >= lo && n <= hi;
        if (!pass) detail = n + '문장 (요구 ' + (lo === hi ? lo : lo + '~' + hi) + ')';
      } else if (kind === 'chars') {
        var len = t.replace(/\s+$/, '').length;
        pass = len >= v[0] && len <= v[1];
        if (!pass) detail = len + '자 (요구 ' + v[0] + '~' + v[1] + ')';
      } else if (kind === 'words') {
        var w = countWords(t);
        var wlo = Array.isArray(v) ? v[0] : v, whi = Array.isArray(v) ? v[1] : v;
        pass = w >= wlo && w <= whi;
        if (!pass) detail = w + '어절 (요구 ' + (wlo === whi ? wlo : wlo + '~' + whi) + ')';
      } else if (kind === 'form') {
        /* 형식 조건은 물결로 자른 조각이 순서대로 다 나오는지만 본다 —
           '~하여 운율을 형성하고 있다'면 '운율을형성' 조각의 존재를 확인한다. */
        var frags = String(v).split(/~+/).map(function (x) { return normalizeKo(x); })
          .filter(function (x) { return x.length >= 2; });
        var pos = 0; pass = true;
        for (var i = 0; i < frags.length; i++) {
          var at = norm.indexOf(frags[i], pos);
          if (at < 0) { pass = false; break; }
          pos = at + frags[i].length;
        }
        if (!pass) detail = '지정 형식과 어긋남';
      } else if (kind === 'quote') {
        pass = true; detail = '사람 확인';   // 자동 판정하지 않는다
      }
      return { kind: kind, text: c.text || '', value: v, pass: pass, detail: detail, manual: kind === 'quote' };
    });
  }

  /* ── 서술형 루브릭 채점 (1층, §5.3) ──
     item: { rubric: [{element, keywords[], acceptedVariants[], points}], totalPoints,
             conditions: [...] }
     반환: { score, total, elements[], conditions[], complete, verdict }
     verdict: 'pass'(확정 통과) | 'hold'(보류 — 2층으로) | 'fail'(미달, 즉시 피드백)

     왜 3값인가: 조건 위반·요소 0은 학생이 바로 고칠 수 있어 즉시 돌려주고,
     만점+문장 완결만 확정 통과로 본다. 그 사이는 사람(또는 AI)이 본다 —
     "핵심어를 나열만 한 답"이 자동 통과하는 것을 막는 것이 이 층의 목적이다. */
  function gradeRubric(input, item) {
    var t = nfc(input);
    var norm = normalizeKo(t);
    var rubric = (item && item.rubric) || [];
    var elements = rubric.map(function (r) {
      var pts = r.points == null ? 1 : r.points;
      var kws = r.keywords || [];
      var hit = kws.filter(function (k) { return hasKeyword(norm, k, r.acceptedVariants); });
      /* 요소 안의 키워드는 '하나라도 있으면 충족'이다 — 같은 뜻의 여러 표현을
         나열해 둔 것이지 전부 쓰라는 뜻이 아니다(자료의 핵심 단어 표기 방식). */
      var met = kws.length === 0 ? false : hit.length > 0;
      return { element: r.element, points: pts, met: met, hit: hit, keywords: kws };
    });
    var total = item && item.totalPoints != null
      ? item.totalPoints
      : elements.reduce(function (a, e) { return a + e.points; }, 0);
    var score = elements.reduce(function (a, e) { return a + (e.met ? e.points : 0); }, 0);
    var conds = checkConditions(t, item && item.conditions);
    var condFail = conds.filter(function (c) { return !c.pass && !c.manual; }).length;
    var complete = isComplete(t);

    var verdict;
    if (!t.trim()) verdict = 'fail';
    else if (condFail > 0) verdict = 'fail';
    else if (score === 0) verdict = 'fail';
    else if (score >= total && complete) verdict = 'pass';
    else verdict = 'hold';

    return {
      score: score, total: total, elements: elements, conditions: conds,
      complete: complete, verdict: verdict,
      note: verdict === 'fail'
        ? (condFail > 0 ? '조건을 지키지 않았어요.' : '핵심 요소가 답안에 없어요.')
        : (verdict === 'hold'
          ? (!complete ? '문장을 완결해 주세요 (핵심어 나열만으로는 통과하지 않아요).' : '일부 요소가 빠졌어요.')
          : '요소를 모두 갖춘 완결된 문장이에요.')
    };
  }

  /* ── 주석 복원 채점 (4단계, §4.4) ──
     targets: [{id, label, keywords[], answers[]}]  inputs: {id: 학생 입력}
     항목별 [완성/부분/누락]을 낸다. 누락 항목이 2단계 빈칸 큐로 되돌아간다. */
  function gradeRestore(inputs, targets) {
    var per = (targets || []).map(function (t) {
      var raw = (inputs || {})[t.id];
      var norm = normalizeKo(raw);
      var kws = (t.keywords && t.keywords.length) ? t.keywords : parseAccepted(t.answers || []);
      var hit = kws.filter(function (k) { return hasKeyword(norm, k, t.variants); });
      var status = !norm ? 'missing' : (kws.length === 0 ? 'full'
        : (hit.length === kws.length ? 'full' : (hit.length > 0 ? 'partial' : 'missing')));
      return { id: t.id, label: t.label, status: status, hit: hit, keywords: kws };
    });
    var full = per.filter(function (p) { return p.status === 'full'; }).length;
    var partial = per.filter(function (p) { return p.status === 'partial'; }).length;
    return {
      perTarget: per, full: full, partial: partial,
      missing: per.length - full - partial, total: per.length,
      coverage: per.length ? (full + partial * 0.5) / per.length : 0
    };
  }

  /* ── 브레인덤프 diff (§4.4) — 판정 없이 "무엇을 안 썼는지"만 보여 준다 */
  function dumpDiff(input, targets) {
    var norm = normalizeKo(input);
    var per = (targets || []).map(function (t) {
      var kws = (t.keywords && t.keywords.length) ? t.keywords : parseAccepted(t.answers || []);
      var present = kws.some(function (k) { return hasKeyword(norm, k, t.variants); });
      return { id: t.id, label: t.label, present: present };
    });
    var n = per.filter(function (p) { return p.present; }).length;
    return { perTarget: per, present: n, total: per.length };
  }

  return {
    JOSA: JOSA, COPULA: COPULA, stripJosa: stripJosa, stripEnding: stripEnding, normalizeKo: normalizeKo, parseAccepted: parseAccepted,
    gradeAnswer: gradeAnswer, gradeBlanks: gradeBlanks,
    hasKeyword: hasKeyword, coreCands: coreCands,
    countSentences: countSentences, countWords: countWords, isComplete: isComplete,
    checkConditions: checkConditions, gradeRubric: gradeRubric,
    gradeRestore: gradeRestore, dumpDiff: dumpDiff
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WBKOGRADE;
