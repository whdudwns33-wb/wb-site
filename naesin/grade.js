'use strict';
/* WB 내신 — 채점 모듈 (브라우저/Node 공용)
   기획서 §5.3 auto_norm: 영어 단답·영작을 정규화(대소문자·구두점·축약형·복수 정답)로 채점한다.
   기획서 §4.2 백지 쓰기: 입력 전문을 문장 단위로 분할·정렬해 정본과 대조하고
   문장 누락·순서 바뀜·표현 오류를 각각 표시한다. §14-3 브레인덤프도 같은 채점기를 쓴다 —
   통과/실패 판정 없이 diff만 보여 주는 저부담 인출 도구다.
   해석 셀프 체크 보조(§14-2, Phase 1)는 AI 없이 청크 핵심 토큰의 존재만 살펴
   "빠뜨린 청크"를 표시한다 — 정밀 채점이 아니라 스스로 대조할 자리를 잡아 주는 용도. */
var WBGRADE = (function () {

  /* ── 영어 정규화 (auto_norm) ──
     "Don't worry."와 "do not worry"는 같은 답이다. 소문자화 → 굽은따옴표 펴기 →
     축약형 전개 → 구두점 제거 → 공백 정리 순서다. 아포스트로피는 축약을 전개한
     '뒤에' 지운다 — 먼저 지우면 dont 가 되어 do not 과 영영 못 만난다. */

  /* 일반 규칙으로 안 풀리는 축약형 먼저 — won't 를 n't 규칙에 맡기면 wo not 이 된다 */
  var SPECIAL = [
    [/\bwon't\b/g, 'will not'],
    [/\bcan't\b/g, 'cannot'],
    [/\blet's\b/g, 'let us'],
  ];
  /* 's 는 대명사 뒤에서만 is 로 편다(it's→it is). 아무 데나 펴면 소유격이 망가진다 —
     my brother's book 이 my brother is book 이 되어 버린다. 소유격의 아포스트로피는
     그냥 지워져 brothers 가 되고, 양쪽이 똑같이 지워지므로 비교는 어긋나지 않는다.
     it's 는 it has 로도 쓰이지만 기획서대로 is 로만 편다. */
  var S_IS = /\b(it|he|she|that|there|here|what|who)'s\b/g;

  function normalizeEn(s) {
    var t = String(s == null ? '' : s).toLowerCase();
    t = t.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"'); // 굽은따옴표 펴기
    for (var i = 0; i < SPECIAL.length; i++) t = t.replace(SPECIAL[i][0], SPECIAL[i][1]);
    t = t.replace(/n't\b/g, ' not')      // don't·isn't·didn't·doesn't·wasn't·weren't·aren't …
      .replace(/'m\b/g, ' am')           // i'm
      .replace(/'re\b/g, ' are')         // we're·they're·you're
      .replace(/'ll\b/g, ' will')        // i'll
      .replace(/'ve\b/g, ' have')
      .replace(S_IS, '$1 is');           // it's·he's·she's (is 로만)
    t = t.replace(/'/g, '');             // 남은 아포스트로피(소유격 등)는 이제 지운다
    t = t.replace(/[^a-z0-9\s]/g, ' ');  // 구두점·기호는 공백으로 — sea.The 가 붙지 않게
    return t.replace(/\s+/g, ' ').trim();
  }

  /* 복수 정답 채점 — accepted 는 ["knocking","knock"] 같은 배열.
     정규화 후 일치하는 첫 정답을 matched 로 돌려 준다(화면에 "이 표기로 인정" 표시용). */
  function gradeAnswer(input, accepted) {
    var got = normalizeEn(input);
    var list = accepted || [];
    if (got) {
      for (var i = 0; i < list.length; i++) {
        if (normalizeEn(list[i]) === got) return { correct: true, matched: list[i] };
      }
    }
    return { correct: false, matched: null };
  }

  /* 빈칸 여러 개 — 칸마다 따로 판정하고 expected 에 대표 정답(첫 표기)을 담는다.
     부분 정답을 보여 줘야 학생이 어느 칸을 틀렸는지 안다. */
  function gradeBlanks(inputs, answers) {
    var ins = inputs || [];
    var all = true;
    var per = (answers || []).map(function (acc, i) {
      var r = gradeAnswer(ins[i], acc);
      if (!r.correct) all = false;
      return { correct: r.correct, expected: (acc && acc[0]) || '', matched: r.matched };
    });
    return { allCorrect: all, perBlank: per };
  }

  /* ── 토큰 편집거리 유사도 ──
     글자가 아니라 낱말 단위로 잰다 — 백지 쓰기에서 중요한 것은 철자 한 글자가 아니라
     "어느 낱말을 빠뜨리고 바꿨는가"다. 정규화를 먼저 하므로 Don't/do not 차이는 0이다. */
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

  function tokensOfNorm(s) {
    var t = normalizeEn(s);
    return t ? t.split(' ') : [];
  }

  function similarity(a, b) {
    var x = tokensOfNorm(a), y = tokensOfNorm(b);
    if (!x.length && !y.length) return 1;
    if (!x.length || !y.length) return 0;
    return 1 - editDist(x, y) / Math.max(x.length, y.length);
  }

  /* ── 문장 분할 ──
     마침표·물음표·느낌표에서 끊되, Mr.·Aug. 같은 단순 약어와 소수점(3.5)은 지킨다.
     줄바꿈도 경계로 본다 — 브레인덤프에서 아이들은 구두점 없이 줄만 바꿔 치는 일이 많고,
     그걸 한 문장으로 뭉치면 정렬이 통째로 무너진다. */
  var ABBREV = ['mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'prof',
    'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
    'vs', 'etc'];

  function isAbbrevEnd(cur) {
    var m = cur.slice(0, -1).match(/([A-Za-z]+)$/); // 마침표 바로 앞 낱말
    if (!m) return false;
    var w = m[1].toLowerCase();
    if (w.length === 1) return true;                // 이니셜 — J. K. Rowling
    return ABBREV.indexOf(w) >= 0;
  }

  function splitSentences(text) {
    var s = String(text == null ? '' : text);
    var out = [], cur = '';
    function flush() { var t = cur.trim(); if (t) out.push(t); cur = ''; }
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (ch === '\n' || ch === '\r') { flush(); continue; }
      cur += ch;
      if (ch !== '.' && ch !== '?' && ch !== '!') continue;
      if (ch === '.') {
        if (/\d/.test(cur[cur.length - 2] || '') && /\d/.test(s[i + 1] || '')) continue; // 소수점 3.5
        if (isAbbrevEnd(cur)) continue;
      }
      /* 뒤따르는 종결부호·닫는따옴표는 같은 문장에 붙인다 — "...", ?!, ." */
      while (i + 1 < s.length && /["'”’.?!]/.test(s[i + 1])) { i += 1; cur += s[i]; }
      flush();
    }
    flush();
    return out;
  }

  /* ── 토큰 LCS diff ──
     비교는 정규화한 키로, 표시는 원문 그대로 — 학생에게 "Warm 이 빠졌다"를 보여 줄 때
     소문자로 뭉갠 낱말이 아니라 정본의 낱말을 보여 줘야 한다. */
  function displayTokens(sentence) {
    var out = [];
    String(sentence == null ? '' : sentence).split(/\s+/).forEach(function (t) {
      if (!t) return;
      out.push({ text: t, key: normalizeEn(t) });
    });
    return out;
  }

  function tokenDiff(canonToks, stuToks) {
    var m = canonToks.length, n = stuToks.length, i, j;
    var dp = []; // dp[i][j] = canon[i..]·stu[j..] 의 LCS 길이
    for (i = m; i >= 0; i--) {
      dp[i] = [];
      for (j = n; j >= 0; j--) {
        if (i === m || j === n) dp[i][j] = 0;
        else if (canonToks[i].key === stuToks[j].key) dp[i][j] = dp[i + 1][j + 1] + 1;
        else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    var ops = [];
    i = 0; j = 0;
    while (i < m && j < n) {
      if (canonToks[i].key === stuToks[j].key) { ops.push(['same', canonToks[i].text]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['missing', canonToks[i].text]); i++; } // 정본 쪽 먼저
      else { ops.push(['extra', stuToks[j].text]); j++; }
    }
    while (i < m) { ops.push(['missing', canonToks[i].text]); i++; }
    while (j < n) { ops.push(['extra', stuToks[j].text]); j++; }
    /* 같은 종류가 이어지면 한 덩어리로 — 낱말마다 조각내면 화면이 읽히지 않는다 */
    var out = [];
    ops.forEach(function (op) {
      var last = out[out.length - 1];
      if (last && last.type === op[0]) last.text += ' ' + op[1];
      else out.push({ type: op[0], text: op[1] });
    });
    return out;
  }

  /* ── 백지 쓰기 · 브레인덤프 채점 (§4.2·§14-3) ──
     학생 문장 각각을 가장 유사한 정본 문장에 탐욕 매칭한다. 유사도 높은 쌍부터
     확정하는 전역 탐욕이다 — 앞 문장이 남의 정본을 먼저 차지하는 사고를 막는다.
     0.35 미만이면 매칭하지 않는다(전혀 다른 문장을 억지로 붙이면 diff 가 소음이 된다).
     status: 0.92 이상 ok / 매칭됐지만 그 아래는 partial / 매칭 없음 missing.
     orderOk: 학생이 쓴 순서대로 정본 seq 가 비내림차순인가 — 순서 뒤바뀜 표시용. */
  var MATCH_MIN = 0.35, OK_MIN = 0.92, PARTIAL_MIN = 0.5;

  function diffPassage(text, canonical) {
    var canon = (canonical || []).slice().sort(function (x, y) { return x.seq - y.seq; });
    var stu = splitSentences(text);
    var pairs = [], i, j;
    for (i = 0; i < stu.length; i++) {
      for (j = 0; j < canon.length; j++) {
        var sim = similarity(stu[i], canon[j].en);
        if (sim >= MATCH_MIN) pairs.push({ i: i, j: j, sim: sim });
      }
    }
    pairs.sort(function (x, y) { return y.sim - x.sim || x.j - y.j || x.i - y.i; });
    var stuTaken = {}, canonMatch = {}; // canonMatch[j] = {i, sim}
    pairs.forEach(function (p) {
      if (stuTaken[p.i] !== undefined || canonMatch[p.j]) return;
      stuTaken[p.i] = p.j;
      canonMatch[p.j] = { i: p.i, sim: p.sim };
    });
    var okCount = 0, partialCount = 0, missingCount = 0;
    var perSentence = canon.map(function (c, jj) {
      var m = canonMatch[jj];
      if (!m) {
        missingCount += 1;
        return { seq: c.seq, status: 'missing', score: 0, input: null, diff: tokenDiff(displayTokens(c.en), []) };
      }
      var status = m.sim >= OK_MIN ? 'ok' : 'partial'; // PARTIAL_MIN 미만이라도 매칭됐으면 partial — 흔적은 흔적대로 보여 준다
      if (status === 'ok') okCount += 1; else partialCount += 1;
      return {
        seq: c.seq, status: status, score: m.sim, input: stu[m.i],
        diff: tokenDiff(displayTokens(c.en), displayTokens(stu[m.i])),
      };
    });
    var extras = [], seqsInOrder = [];
    for (i = 0; i < stu.length; i++) {
      if (stuTaken[i] === undefined) extras.push(stu[i]);
      else seqsInOrder.push(canon[stuTaken[i]].seq);
    }
    var orderOk = true;
    for (i = 1; i < seqsInOrder.length; i++) if (seqsInOrder[i] < seqsInOrder[i - 1]) orderOk = false;
    return {
      perSentence: perSentence, extras: extras, orderOk: orderOk,
      okCount: okCount, partialCount: partialCount, missingCount: missingCount,
    };
  }

  /* ── 해석 셀프 체크 보조 (§14-2, Phase 1 — AI 없이) ──
     청크 모범 해석의 핵심 토큰이 학생 해석 어딘가에 있는지만 본다. 조사를 떼고
     (가족은→가족), 용언은 종결어미를 근사로 뗀다(들었다→들었 — 들었어요 도 잡힌다).
     활용까지 다 좇을 수는 없으니 앞 2자를 예비 후보로 둔다(갈매기들이→갈매).
     청크의 토큰 절반 이상이 보이면 present — 정밀 채점이 아니라 "이 청크를 통째로
     빠뜨렸다"를 표시하는 용도라, 한두 낱말의 의역은 너그럽게 지나간다. */
  var JOSA = ['에서는', '에게서', '에서', '에게', '으로', '부터', '까지', '처럼', '보다', '한테', '께서', '에는',
    '은', '는', '이', '가', '을', '를', '의', '에', '로', '와', '과', '도', '만'];

  function stripJosa(w) {
    for (var k = 0; k < JOSA.length; k++) {
      var j = JOSA[k];
      if (w.length > j.length && w.slice(-j.length) === j) return w.slice(0, -j.length);
    }
    return w;
  }

  function coreCands(word) {
    var cands = [], base = stripJosa(word);
    function add(c) { if (c.length >= 2 && cands.indexOf(c) < 0) cands.push(c); }
    add(base);
    add(base.replace(/[다요]$/, ''));   // 용언 종결어미 근사 — 만들었다→만들었
    add(base.slice(0, 2));              // 활용 대비 예비 후보 — 갈매기들→갈매
    if (!cands.length) add(word.slice(0, 2)); // 조사를 떼니 한 글자만 남는 낱말 — 문이→문이
    return cands;
  }

  function gradeTranslationChunks(inputKo, chunks) {
    var input = String(inputKo == null ? '' : inputKo);
    var presentCount = 0;
    var perChunk = (chunks || []).map(function (c) {
      var words = String((c && c.ko) || '').replace(/[^가-힣]/g, ' ').split(/\s+/);
      var total = 0, found = 0;
      words.forEach(function (w) {
        if (w.length < 2) return; // 2자 미만은 핵심 토큰으로 안 본다
        total += 1;
        var cands = coreCands(w);
        for (var k = 0; k < cands.length; k++) {
          if (input.indexOf(cands[k]) >= 0) { found += 1; return; }
        }
      });
      var present = total === 0 || found * 2 >= total; // 절반 이상 보이면 있는 것으로
      if (present) presentCount += 1;
      return { present: present };
    });
    var coverage = perChunk.length ? presentCount / perChunk.length : 1;
    return { perChunk: perChunk, coverage: coverage };
  }

  return {
    normalizeEn: normalizeEn, gradeAnswer: gradeAnswer, gradeBlanks: gradeBlanks,
    similarity: similarity, splitSentences: splitSentences, diffPassage: diffPassage,
    gradeTranslationChunks: gradeTranslationChunks,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WBGRADE;
