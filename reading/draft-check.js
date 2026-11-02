'use strict';
/* 지문 초안 한 편을 articles.json 에 넣기 전에 검사한다.
 *
 * 왜 따로 있나: content.test.cjs 는 `articles.json` 을 열어 전수 검사한다.
 * 그런데 집필은 한 편씩 따로 쓰고(여러 에이전트가 동시에 쓰므로 저장소 파일을
 * 건드릴 수 없다) 병합은 맨 나중이다. 그래서 병합 전에 한 편만 같은 규격으로
 * 재어 볼 자리가 매주 필요했고, 매주 스크래치패드에 같은 스크립트를 다시 썼다.
 * 그때마다 조금씩 달라져 규격이 흔들렸으므로 저장소에 둔다.
 *
 * 규격 수치는 content.test.cjs 가 정본이고 여기는 그 사본이다 —
 * 어긋나면 draft-check.test.cjs 가 막는다. */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WBDraftCheck = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  /* content.test.cjs 의 LIMITS — 학년대별 글자 수·어휘·문항 */
  var LIMITS = {
    L1: { min: 180, max: 380, vocab: 3, q: 3 },
    L2: { min: 450, max: 750, vocab: 4, q: 4 },
    L3: { min: 650, max: 1050, vocab: 5, q: 4 },
    L4: { min: 900, max: 1450, vocab: 5, q: 5 }
  };
  /* 규격서 2장의 조각 길이 눈금 — chunk.mjs 초안이 ±0.4 안쪽으로 내놓으므로
     손질 여유를 더해 ±0.8 까지 받는다 */
  var SPEC = { L1: 3.3, L2: 3.7, L3: 4.1, L4: 4.5 };
  var TOL = 0.8;
  var LONG = 8;                 /* 한 조각 최대 어절 — 예외 없음 */
  var LEVELS = ['L1', 'L2', 'L3', 'L4'];
  var QTYPES = ['main', 'detail', 'vocab', 'infer', 'critical'];
  var CHTYPES = QTYPES.concat(['apply']);
  var CATS = ['science', 'society', 'history', 'humanities', 'environment'];
  var CAREERS = ['eng', 'it', 'med', 'bio', 'nat', 'biz', 'media', 'law', 'edu', 'art', 'env', 'hum'];

  function words(seg) { return (seg.match(/\S+\s*/g) || []).length; }

  /* 출처가 기관 첫 화면이나 게시판 목록이면 학생이 눌러도 근거를 못 찾는다.
     content.test.cjs 의 isIndexPage 와 같은 규칙이다. */
  function isIndexPage(u) {
    var x;
    try { x = new URL(u); } catch (e) { return false; }
    var p = x.pathname.replace(/\/$/, '');
    if (p === '' || /^\/(index|main)\.(do|jsp|html?)$/.test(p)) return true;
    if (/(List|list)\.do|listRenew|boardCnts\/list/.test(p + x.search)) return true;
    if (/[?&]menuId=\d+$/.test(x.search) && /index\.do/.test(p)) return true;
    if (/\/(press|news|notice|board|list)\.(do|jsp|html?|php|asp)$/i.test(p) && !x.search) return true;
    return false;
  }
  /* 본문을 싣지 않고 첨부파일만 두는 전재 페이지 */
  function isAttachmentOnly(u) { return /korea\.kr\/briefing\/pressReleaseView\.do/.test(u || ''); }

  function checkLevel(out, tag, lv, b) {
    var lim = LIMITS[lv], E = out.E, W = out.W;
    if (!b.title) E(tag + ': title 없음');
    if (!Number.isInteger(b.minutes) || b.minutes < 1) E(tag + ': minutes 잘못됨');
    if (!Array.isArray(b.paragraphs) || !b.paragraphs.length) { E(tag + ': paragraphs 없음'); return null; }

    var lens = [], maxSeg = 0;
    b.paragraphs.forEach(function (p, pi) {
      if (!Array.isArray(p) || !p.length) { E(tag + ': 문단 ' + pi + ' 형식 오류'); return; }
      p.forEach(function (seg, si) {
        if (typeof seg !== 'string' || !seg.trim()) { E(tag + ': 문단 ' + pi + ' 조각 ' + si + ' 비어 있음'); return; }
        var n = words(seg);
        lens.push(n);
        if (n > maxSeg) maxSeg = n;
        if (n > LONG) E(tag + ': 문단 ' + pi + ' 조각 ' + si + ' 가 ' + n + '어절 — ' + LONG + '어절을 넘습니다 ' + JSON.stringify(seg));
      });
      var t = p.join('');
      if (/ {2,}/.test(t)) E(tag + ': 문단 ' + pi + ' 연속 공백');
      if (t !== t.trim()) E(tag + ': 문단 ' + pi + ' 앞뒤 공백');
    });

    var chars = b.paragraphs.map(function (p) { return p.join(''); }).join('').length;
    if (chars < lim.min || chars > lim.max) E(tag + ': 글자 수 ' + chars + ' (규격 ' + lim.min + '~' + lim.max + ')');

    var mean = lens.length ? lens.reduce(function (x, y) { return x + y; }, 0) / lens.length : 0;
    if (lens.length >= 5 && Math.abs(mean - SPEC[lv]) > TOL)
      E(tag + ': 조각 평균 ' + mean.toFixed(2) + '어절 — 규격은 ' + SPEC[lv] + ' ± ' + TOL);

    if (!Array.isArray(b.vocab)) E(tag + ': vocab 배열 아님');
    else {
      if (b.vocab.length < lim.vocab - 1) E(tag + ': vocab ' + b.vocab.length + '개 (규격 ' + lim.vocab + ')');
      var seen = {};
      b.vocab.forEach(function (v, vi) {
        if (!v.word || !v.easy) { E(tag + ': vocab ' + vi + ' word/easy 누락'); return; }
        if (seen[v.word]) E(tag + ': vocab 중복 "' + v.word + '"');
        seen[v.word] = 1;
        /* 낱말이 조각 경계에 걸리면 어휘 카드가 본문에서 그 말을 못 찾는다 */
        var inSeg = b.paragraphs.some(function (p) {
          return p.some(function (s) { return s.indexOf(v.word) >= 0; });
        });
        if (!inSeg) E(tag + ': vocab "' + v.word + '" 가 어떤 조각 안에도 통째로 없음');
        if (lv === 'L1' && v.hanja) E(tag + ': L1 은 한자 병기 없이 뜻풀이만 (' + v.word + ')');
      });
    }

    function checkQs(list, label, types, required) {
      if (!Array.isArray(list) || !list.length) {
        if (required) E(tag + ': ' + label + ' 없음');
        return;
      }
      list.forEach(function (q, qi) {
        var qt = tag + ' ' + label + (qi + 1);
        if (types.indexOf(q.type) < 0) E(qt + ': type "' + q.type + '" 알 수 없음');
        /* 기본 문항의 critical 은 L4 전용(경고) — 심화는 CHTYPES 가 허용한다.
           content.test.cjs 와 같은 세기로 둔다. */
        if (required && q.type === 'critical' && lv !== 'L4') W(qt + ': critical 은 L4 전용');
        if (!q.q) E(qt + ': 발문 없음');
        if (!Array.isArray(q.choices) || q.choices.length !== 4) E(qt + ': 선지 4개 아님');
        if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer > 3) E(qt + ': answer 인덱스 오류');
        if (!q.explain) E(qt + ': explain 없음');
        if (!Number.isInteger(q.evidencePara) || q.evidencePara < 0 || q.evidencePara >= b.paragraphs.length)
          E(qt + ': evidencePara 범위 오류');
      });
    }
    checkQs(b.questions, 'Q', QTYPES, true);
    checkQs(b.challenge, '심화Q', CHTYPES, false);
    if (Array.isArray(b.questions) && b.questions.length !== lim.q)
      E(tag + ': 문항 ' + b.questions.length + '개 (규격 ' + lim.q + ')');
    if (!Array.isArray(b.challenge) || !b.challenge.length) W(tag + ': 심화 문항 없음 (신규 지문은 2개 권장)');

    /* 영어 대역 — L1 은 없다 */
    if (lv !== 'L1') {
      if (!Array.isArray(b.en) || b.en.length !== b.paragraphs.length) E(tag + ': en 문단 수 불일치');
      if (!Array.isArray(b.enseg) || b.enseg.length !== (b.en || []).length) E(tag + ': enseg 문단 수 불일치');
      else b.enseg.forEach(function (sg, i) {
        if (!Array.isArray(sg) || sg.join('') !== b.en[i]) E(tag + ': enseg[' + i + '] 이어붙이기가 en 과 다름');
      });
      if (!Array.isArray(b.envocab) || b.envocab.length < 5) E(tag + ': envocab ' + ((b.envocab || []).length) + '개 (규격 5~6)');
      else {
        var enText = (b.en || []).join('\n');
        b.envocab.forEach(function (ev, i) {
          if (!ev.word || !ev.ko) { E(tag + ': envocab[' + i + '] word/ko 누락'); return; }
          if (enText.indexOf(ev.word) < 0) E(tag + ': envocab "' + ev.word + '" 가 영어 본문에 없음');
        });
      }
    }

    /* 정답이 「혼자 가장 긴 선지」인 문항을 센다.
       학생이 지문을 읽지 않고 가장 긴 선지만 골라도 맞으면 문항이 재는 것이 없다.
       2026-11-02 전수 측정에서 발행된 63편의 1,512문항 가운데 85%가 이 꼴이었다 —
       긴 정답은 쓰다 보면 저절로 생긴다(정답에는 근거를 다 담고 오답은 짧게 끝내므로).
       기존 지문을 막지 않도록 경고로 둔다. */
    var tell = 0, qn = 0;
    [].concat(b.questions || [], b.challenge || []).forEach(function (q) {
      var ch = q.choices;
      if (!Array.isArray(ch) || ch.length !== 4) return;
      if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer > 3) return;
      qn += 1;
      var len = ch.map(function (c) { return String(c).length; });
      var mx = Math.max.apply(null, len);
      var ties = len.filter(function (x) { return x === mx; }).length;
      if (len[q.answer] === mx && ties === 1) tell += 1;
    });
    if (qn >= 4 && tell / qn > 0.5)
      W(tag + ': 정답이 혼자 가장 긴 선지인 문항 ' + tell + '/' + qn
        + ' — 지문을 읽지 않고 가장 긴 선지만 골라도 맞습니다. 정답을 줄이거나 오답 하나를 같은 길이로 늘리세요');

    return { chars: chars, segs: lens.length, mean: mean, max: maxSeg,
             vocab: (b.vocab || []).length, q: (b.questions || []).length,
             challenge: (b.challenge || []).length,
             lengthTell: tell, qCount: qn };
  }

  /* 지문 한 편을 검사한다 → {errors, warns, stats} */
  function checkDraft(a) {
    var errors = [], warns = [];
    var out = {
      E: function (m) { errors.push(m); },
      W: function (m) { warns.push(m); }
    };
    var tag = (a && a.id) || '(no-id)';
    if (!a || typeof a !== 'object') { errors.push('지문 객체가 아님'); return { errors: errors, warns: warns, stats: {} }; }
    if (!a.id) errors.push('id 없음');
    if (CATS.indexOf(a.category) < 0) errors.push(tag + ': category "' + a.category + '" 알 수 없음');
    if (!Array.isArray(a.careers) || !a.careers.length) errors.push(tag + ': careers 없음');
    else a.careers.forEach(function (c) {
      if (CAREERS.indexOf(c) < 0) errors.push(tag + ': career "' + c + '" 알 수 없음');
    });
    if (['published', 'draft'].indexOf(a.status) < 0) errors.push(tag + ': status 오류');
    if (a.issue != null && typeof a.issue !== 'boolean') errors.push(tag + ': issue 는 boolean');
    if (!Array.isArray(a.sources) || !a.sources.length) errors.push(tag + ': sources 없음');
    else a.sources.forEach(function (s) {
      if (!/^https:\/\//.test((s && s.url) || '')) errors.push(tag + ': source URL https 아님');
      else if (isAttachmentOnly(s.url)) errors.push(tag + ': 출처가 첨부파일만 있는 전재 페이지 — 발표 부처 원문을 링크하세요\n        ' + s.url);
      else if (isIndexPage(s.url)) errors.push(tag + ': 출처가 기관 홈페이지·목록 페이지 — 그 내용이 실린 페이지를 링크하세요\n        ' + s.url);
    });

    var stats = {};
    LEVELS.forEach(function (lv) {
      var b = a.levels && a.levels[lv];
      if (!b) { errors.push(tag + ': ' + lv + ' 없음'); return; }
      stats[lv] = checkLevel(out, tag + '/' + lv, lv, b);
    });
    return { errors: errors, warns: warns, stats: stats };
  }

  /* 어휘 카드의 한자 훈음 — 글자당 하나로 고정해야 한다.
     어휘 카드는 vocab.hanja 를 그대로 보여 주고 한자 카드는 그것을 낱글자로 쪼개 모으므로,
     한 글자를 지문마다 다르게 적으면 같은 학생이 두 화면에서 다른 훈을 읽는다.
     content.test.cjs 가 오류로 막지만, 집필은 한 편씩 따로 하므로 병합할 때까지 드러나지 않는다
     (2026-11-02 에 네 편에서 10건이 한꺼번에 나왔다). 그래서 병합 전에 미리 잰다. */
  function collectReadings(articles) {
    var map = {};
    (articles || []).forEach(function (a) {
      Object.keys((a && a.levels) || {}).forEach(function (lv) {
        ((a.levels[lv] || {}).vocab || []).forEach(function (v) {
          if (!v || !v.hanja) return;
          String(v.hanja).replace(/(.)\(([^)]+)\)/g, function (_, ch, rd) {
            if (!map[ch]) map[ch] = {};
            if (!map[ch][rd]) map[ch][rd] = a.id + '/' + lv + ' ' + v.word;
            return '';
          });
        });
      });
    });
    return map;
  }

  /* 초안 하나가 쓰는 훈음이 모아 둔 것과 어긋나는 자리를 돌려준다 */
  function hanjaClash(a, corpus) {
    var out = [];
    if (!a || !corpus) return out;
    Object.keys((a.levels) || {}).forEach(function (lv) {
      ((a.levels[lv] || {}).vocab || []).forEach(function (v) {
        if (!v || !v.hanja) return;
        String(v.hanja).replace(/(.)\(([^)]+)\)/g, function (_, ch, rd) {
          var seen = corpus[ch];
          if (!seen || seen[rd]) return '';      /* 새 글자이거나 같은 훈음이면 괜찮다 */
          var have = Object.keys(seen)[0];
          out.push(lv + ' ' + v.word + ': 한자 "' + ch + '(' + rd + ')" — 모아 둔 것은 "'
            + ch + '(' + have + ')" 입니다 (' + seen[have] + '). 하나로 통일하지 않으면 content.test.cjs 가 막습니다');
          return '';
        });
      });
    });
    return out;
  }

  return {
    collectReadings: collectReadings, hanjaClash: hanjaClash,
    LIMITS: LIMITS, SPEC: SPEC, TOL: TOL, LONG: LONG, LEVELS: LEVELS,
    QTYPES: QTYPES, CHTYPES: CHTYPES, CATS: CATS, CAREERS: CAREERS,
    words: words, isIndexPage: isIndexPage, isAttachmentOnly: isAttachmentOnly,
    checkDraft: checkDraft
  };
});
