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
     축약형 전개 → 구두점 제거 → 아포스트로피 없는 축약(dont) 복원 → 공백 정리 순서다.
     아포스트로피는 축약을 전개한 '뒤에' 지운다 — 먼저 지우면 dont 가 되어 do not 과
     영영 못 만난다. 그래도 학생은 dont 라고 쓰므로 낱말 표를 한 번 더 거친다. */

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

  /* 아포스트로피를 빠뜨린 축약형 — 정답 "Don't"는 do not 으로 펴지는데 학생의 dont 는
     그대로 남아 어긋난다. 다른 낱말과 겹치지 않는 형태만 싣는다(ill·well·its·were 는 제외). */
  var NOAPOS = {
    dont: 'do not', doesnt: 'does not', didnt: 'did not', isnt: 'is not', arent: 'are not',
    wasnt: 'was not', werent: 'were not', cant: 'cannot', wont: 'will not', couldnt: 'could not',
    wouldnt: 'would not', shouldnt: 'should not', hasnt: 'has not', havent: 'have not',
    hadnt: 'had not', mustnt: 'must not', im: 'i am', ive: 'i have', id: 'i would',
    youre: 'you are', youve: 'you have', youll: 'you will', youd: 'you would',
    theyre: 'they are', theyve: 'they have', theyll: 'they will', theyd: 'they would',
    weve: 'we have', hes: 'he is', shes: 'she is', thats: 'that is', whats: 'what is',
    theres: 'there is', heres: 'here is', whos: 'who is',
  };

  function normalizeEn(s) {
    var t = String(s == null ? '' : s).toLowerCase();
    t = t.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"'); // 굽은따옴표 펴기
    for (var i = 0; i < SPECIAL.length; i++) t = t.replace(SPECIAL[i][0], SPECIAL[i][1]);
    t = t.replace(/n't\b/g, ' not')      // don't·isn't·didn't·doesn't·wasn't·weren't·aren't …
      .replace(/'m\b/g, ' am')           // i'm
      .replace(/'re\b/g, ' are')         // we're·they're·you're
      .replace(/'ll\b/g, ' will')        // i'll
      .replace(/'ve\b/g, ' have')
      .replace(/'d\b/g, ' would')        // i'd·you'd — had 로도 쓰이지만 한 규칙으로 양쪽을 같게 편다
      .replace(S_IS, '$1 is');           // it's·he's·she's (is 로만)
    t = t.replace(/'/g, '');             // 남은 아포스트로피(소유격 등)는 이제 지운다
    t = t.replace(/[^a-z0-9\s]/g, ' ');  // 구두점·기호는 공백으로 — sea.The 가 붙지 않게
    var words = t.split(/\s+/), out = [];
    for (i = 0; i < words.length; i++) {
      if (!words[i]) continue;
      out.push(NOAPOS[words[i]] || words[i]);
    }
    t = out.join(' ');
    return t.replace(/\bcan not\b/g, 'cannot'); // can not / can't / cannot 은 한 답
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

  function simTokens(x, y) {
    if (!x.length && !y.length) return 1;
    if (!x.length || !y.length) return 0;
    return 1 - editDist(x, y) / Math.max(x.length, y.length);
  }

  function similarity(a, b) {
    return simTokens(tokensOfNorm(a), tokensOfNorm(b));
  }

  /* ── 문장 분할 ──
     마침표·물음표·느낌표에서 끊되, Mr.·Aug. 같은 단순 약어와 소수점(3.5)은 지킨다.
     줄바꿈도 경계로 본다 — 브레인덤프에서 아이들은 구두점 없이 줄만 바꿔 치는 일이 많고,
     그걸 한 문장으로 뭉치면 정렬이 통째로 무너진다. */
  var ABBREV = ['mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'prof',
    'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
    'vs', 'etc'];

  function isAbbrevEnd(cur) {
    var body = cur.slice(0, -1);
    var m = body.match(/([A-Za-z]+)$/); // 마침표 바로 앞 낱말
    if (!m) return false;
    var w = m[1].toLowerCase();
    if (w.length === 1) {
      if (body[m.index - 1] === '.') return true;   // U.S.A. — 약어 속 글자
      return w !== 'a' && w !== 'i';                // 'a'·'I'는 낱말이다("I got an A."는 끝난 문장); 나머지 한 글자는 이니셜(J. K. Rowling)
    }
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
  /* 구두점 뒤 공백을 빠뜨린 조각을 낱개로 쪼갠다 — 'summer,my'는 키가 'summer my'(공백
     포함)라 정본의 어느 토큰과도 안 맞아, 정규화상 완전히 같은 덤프인데도 매칭·diff가
     통째로 어긋난다. 구분자는 앞 토큰 표시에 붙여('summer,' + 'my') 원문 모양을 지킨다.
     아포스트로피는 낱말 문자로 남긴다 — don't 를 여기서 쪼개면 축약 전개가 죽는다. */
  function splitGlued(raw) {
    var parts = String(raw).split(/([^A-Za-z0-9'’]+)/), out = [], pending = '', i;
    for (i = 0; i < parts.length; i++) {
      var piece = parts[i];
      if (!piece) continue;
      var key = (i % 2 === 0) ? normalizeEn(piece) : '';
      if (!key) {                                   // 구두점 — 앞 토큰에, 앞이 없으면 다음 토큰 앞에
        if (out.length) out[out.length - 1].text += piece;
        else pending += piece;
        continue;
      }
      /* glue = 원문에서 앞 조각과 공백 없이 붙어 있었다는 표시. 화면에 다시 이어 붙일 때
         공백을 넣지 않으려는 것 — well-known 이 "well- known"으로, U.S.A. 가 "U. S. A."로
         보이면 쪼갠 티가 난다. 학생이 정말 붙여 쓴 'summer,my'는 그대로 보인다. */
      out.push({ text: pending + piece, key: key, glue: out.length > 0 });
      pending = '';
    }
    if (pending && !out.length) out.push({ text: pending, key: '' });
    return out;
  }

  function displayTokens(sentence) {
    var out = [];
    String(sentence == null ? '' : sentence).split(/\s+/).forEach(function (t) {
      if (!t) return;
      var key = normalizeEn(t);
      if (key.indexOf(' ') >= 0) {                  // 키가 여러 낱말 — 붙은 조각인지 축약형인지 본다
        var parts = splitGlued(t);
        if (parts.length > 1) { parts.forEach(function (p) { out.push(p); }); return; }
      }
      out.push({ text: t, key: key });
    });
    return out;
  }

  /* 비교용 평탄화 — 정규화가 낱말 수를 바꾸는 토큰을 정본과 같은 눈금으로 맞춘다.
     don't → do·not(표기는 첫 조각만 갖는다 — 화면엔 원문 한 번만 나와야 한다),
     can·not → cannot(normalizeEn의 마지막 규칙과 같은 병합). 이걸 안 하면 정규화상
     완전히 같은 문장("I can not go." vs "I cannot go.")도 diff에 missing/extra가 뜨고,
     분할 채점의 LCS도 같은 자리에서 헛돈다. */
  function flatTokens(toks) {
    var raw = [], out = [], i, k;
    for (i = 0; i < toks.length; i++) {
      var keys = toks[i].key ? toks[i].key.split(' ') : [];
      if (!keys.length) { raw.push({ text: toks[i].text, key: '', glue: !!toks[i].glue }); continue; }
      for (k = 0; k < keys.length; k++) {
        raw.push({ text: k === 0 ? toks[i].text : '', key: keys[k], glue: k === 0 ? !!toks[i].glue : false });
      }
    }
    for (i = 0; i < raw.length; i++) {
      if (raw[i].key === 'can' && raw[i + 1] && raw[i + 1].key === 'not') {
        var tx = raw[i].text && raw[i + 1].text
          ? raw[i].text + (raw[i + 1].glue ? '' : ' ') + raw[i + 1].text
          : (raw[i].text || raw[i + 1].text);
        out.push({ text: tx, key: 'cannot', glue: !!raw[i].glue });
        i += 1;
        continue;
      }
      out.push(raw[i]);
    }
    return out;
  }

  function tokenDiff(canonDisp, stuDisp) {
    var canonToks = flatTokens(canonDisp), stuToks = flatTokens(stuDisp);
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
    function op(type, tok) { return [type, tok.text, tok.key, !!tok.glue]; }
    i = 0; j = 0;
    while (i < m && j < n) {
      if (canonToks[i].key === stuToks[j].key) { ops.push(op('same', canonToks[i])); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(op('missing', canonToks[i])); i++; } // 정본 쪽 먼저
      else { ops.push(op('extra', stuToks[j])); j++; }
    }
    while (i < m) { ops.push(op('missing', canonToks[i])); i++; }
    while (j < n) { ops.push(op('extra', stuToks[j])); j++; }
    /* 같은 종류가 이어지면 한 덩어리로 — 낱말마다 조각내면 화면이 읽히지 않는다.
       평탄화로 표기가 빈 조각(don't 의 not)은 앞 덩어리에 이미 원문이 있으니 건너뛰고,
       그 조각이 덩어리를 새로 열 때만 정규화 키로라도 보여 준다. */
    var out = [];
    ops.forEach(function (o) {
      var last = out[out.length - 1];
      var tx = o[1], glue = o[3];
      if (!tx) {
        if (last && last.type === o[0]) return;
        tx = o[2];                                  // 표기가 빈 조각이 덩어리를 열면 정규화 키로라도
        glue = false;
        if (!tx) return;
      }
      if (last && last.type === o[0]) last.text += (glue ? '' : ' ') + tx;
      else out.push({ type: o[0], text: tx });
    });
    return out;
  }

  /* ── 백지 쓰기 · 브레인덤프 채점 (§4.2·§14-3) ──
     1차: 학생 문장 각각을 가장 유사한 정본 문장에 탐욕 매칭한다. 유사도 높은 쌍부터
     확정하는 전역 탐욕이다 — 앞 문장이 남의 정본을 먼저 차지하는 사고를 막는다.
     0.35 미만이면 매칭하지 않는다(전혀 다른 문장을 억지로 붙이면 diff 가 소음이 된다).
     짧은 문장은 더 엄격하다 — 낱말 두 개짜리 문장은 하나만 겹쳐도 절반이라 "Me too."에
     "Me neither."가 붙는다. 최소 낱말 2개는 겹쳐야 한다(2/길이, 1은 완전 일치).
     2차: 1차가 완벽하지 않으면 학생 토큰 열 전체를 정본 문장 경계로 DP 분할해 본다 —
     구두점 없이 이어 쓴 브레인덤프(한 덩어리 → 전부 missing), 두 문장을 한 문장으로
     합쳐 쓴 경우(한쪽 missing), 한 문장을 둘로 나눠 쓴 경우(반쪽 extras)를 모두 잡는다.
     둘 중 매칭 유사도 합이 큰 쪽을 쓴다(동률이면 학생의 문장 경계를 존중한 1차).
     status: 정규화 후 완전 일치만 ok(긴 문장에서 낱말 하나 틀린 것도 통과가 아니다) /
     매칭됐지만 그 아래는 partial / 매칭 없음 missing. score 는 화면 표시용 유사도.
     orderOk: 학생이 쓴 순서대로 정본 seq 가 비내림차순인가 — 순서 뒤바뀜 표시용. */
  var MATCH_MIN = 0.35;

  function minSimFor(na, nb) {
    return Math.min(1, Math.max(MATCH_MIN, 2 / Math.max(na, nb, 1)));
  }

  /* 1차 — 전역 탐욕 매칭. 반환: inputs[j] = {text, keys, sim} | null, extras, orderOk */
  function matchGreedy(stu, cKeys) {
    var pairs = [], i, j;
    for (i = 0; i < stu.length; i++) {
      for (j = 0; j < cKeys.length; j++) {
        var sim = simTokens(stu[i].keys, cKeys[j]);
        if (sim >= minSimFor(stu[i].keys.length, cKeys[j].length)) pairs.push({ i: i, j: j, sim: sim });
      }
    }
    pairs.sort(function (x, y) { return y.sim - x.sim || x.j - y.j || x.i - y.i; });
    var stuTaken = {}, inputs = [];
    for (j = 0; j < cKeys.length; j++) inputs[j] = null;
    pairs.forEach(function (p) {
      if (stuTaken[p.i] !== undefined || inputs[p.j]) return;
      stuTaken[p.i] = p.j;
      inputs[p.j] = { text: stu[p.i].text, keys: stu[p.i].keys, sim: p.sim };
    });
    var extras = [], seqIdx = [];
    for (i = 0; i < stu.length; i++) {
      if (stuTaken[i] === undefined) extras.push(stu[i].text);
      else seqIdx.push(stuTaken[i]);
    }
    var orderOk = true;
    for (i = 1; i < seqIdx.length; i++) if (seqIdx[i] < seqIdx[i - 1]) orderOk = false;
    return { inputs: inputs, extras: extras, orderOk: orderOk };
  }

  /* 2차 — 토큰 열을 정본 문장 순서대로 연속 구간에 배분한다(빈 구간 = 누락 문장).
     구간 점수는 정본과의 LCS 낱말 수, 전체 합이 최대인 분할을 DP 로 찾는다.
     가운데 문장 구간은 정본 길이의 2배+5로 제한해 계산량을 누르고, 첫·끝 문장은 제한이
     없어 앞뒤 잡음이 어디든 들어갈 자리가 있다(분할이 늘 성립한다).
     동점이면 늦은 시작을 택한다(>=) — 경계의 군더더기 낱말은 다음 문장이 아니라 그 앞
     문장(학생이 그 문장을 쓰다 보탠 것)에 붙는다. */
  function partitionTokens(flat, cDisp) {
    var m = cDisp.length, n = flat.length;
    var NEG = -Infinity, j, k, b;
    var dp = [[]], back = [null];
    for (k = 0; k <= n; k++) dp[0][k] = k === 0 ? 0 : NEG;
    for (j = 1; j <= m; j++) {
      var ck = flatTokens(cDisp[j - 1]).map(function (t) { return t.key; }), L = ck.length;
      var cap = (j === 1 || j === m) ? n : Math.max(12, 2 * L + 5);
      var row = [], bk = [];
      for (k = 0; k <= n; k++) { row[k] = NEG; bk[k] = -1; }
      for (var start = 0; start <= n; start++) {
        var base = dp[j - 1][start];
        if (base === NEG) continue;
        if (base >= row[start]) { row[start] = base; bk[start] = start; }
        var prev = [], cur = [];
        for (b = 0; b <= L; b++) { prev[b] = 0; cur[b] = 0; }
        var maxEnd = Math.min(n, start + cap);
        for (var end = start + 1; end <= maxEnd; end++) {
          var key = flat[end - 1].key;
          cur[0] = 0;
          for (b = 1; b <= L; b++) {
            var v = prev[b] > cur[b - 1] ? prev[b] : cur[b - 1];
            if (key && ck[b - 1] === key && prev[b - 1] + 1 > v) v = prev[b - 1] + 1;
            cur[b] = v;
          }
          var sc = base + cur[L];
          if (sc >= row[end]) { row[end] = sc; bk[end] = start; }
          var tmp = prev; prev = cur; cur = tmp;
        }
      }
      dp[j] = row; back[j] = bk;
    }
    var segs = [], pos = n;
    for (j = m; j >= 1; j--) { var st = back[j][pos]; segs[j - 1] = [st, pos]; pos = st; }
    return segs;
  }

  function matchPartition(stu, cKeys, cDisp) {
    var flat = [];
    stu.forEach(function (s) { flatTokens(displayTokens(s.text)).forEach(function (t) { flat.push(t); }); });
    var segs = partitionTokens(flat, cDisp);
    var inputs = [], extras = [];
    segs.forEach(function (seg, j) {
      if (seg[1] <= seg[0]) { inputs[j] = null; return; }
      /* 표기가 빈 조각(평탄화 부산물)은 건너뛰고, 원문에서 붙어 있던 조각은 붙여서 되살린다 */
      var text = '';
      flat.slice(seg[0], seg[1]).forEach(function (t) {
        if (!t.text) return;
        text += (!text || t.glue ? '' : ' ') + t.text;
      });
      var keys = tokensOfNorm(text);
      var sim = simTokens(keys, cKeys[j]);
      if (sim < minSimFor(keys.length, cKeys[j].length)) { inputs[j] = null; extras.push(text); return; }
      inputs[j] = { text: text, keys: keys, sim: sim };
    });
    return { inputs: inputs, extras: extras, orderOk: true };
  }

  function matchScore(r) {
    var sum = 0;
    r.inputs.forEach(function (m) { if (m) sum += m.sim; });
    return sum;
  }

  function isPerfect(r) {
    if (r.extras.length) return false;
    for (var j = 0; j < r.inputs.length; j++) if (!r.inputs[j] || r.inputs[j].sim < 1) return false;
    return true;
  }

  function diffPassage(text, canonical) {
    var canon = (canonical || []).slice().sort(function (x, y) { return x.seq - y.seq; });
    var cKeys = canon.map(function (c) { return tokensOfNorm(c.en); });
    var cDisp = canon.map(function (c) { return displayTokens(c.en); });
    var stu = splitSentences(text).map(function (t) { return { text: t, keys: tokensOfNorm(t) }; });

    var r = matchGreedy(stu, cKeys);
    if (canon.length && stu.length && !isPerfect(r)) {
      var r2 = matchPartition(stu, cKeys, cDisp);
      if (matchScore(r2) > matchScore(r)) r = r2;
    }

    var okCount = 0, partialCount = 0, missingCount = 0;
    var perSentence = canon.map(function (c, j) {
      var m = r.inputs[j];
      if (!m) {
        missingCount += 1;
        return { seq: c.seq, status: 'missing', score: 0, input: null, diff: tokenDiff(cDisp[j], []) };
      }
      var status = m.sim >= 1 ? 'ok' : 'partial';
      if (status === 'ok') okCount += 1; else partialCount += 1;
      return { seq: c.seq, status: status, score: m.sim, input: m.text, diff: tokenDiff(cDisp[j], displayTokens(m.text)) };
    });
    return {
      perSentence: perSentence, extras: r.extras, orderOk: r.orderOk,
      okCount: okCount, partialCount: partialCount, missingCount: missingCount,
    };
  }

  /* ── 해석 셀프 체크 보조 (§14-2, Phase 1 — AI 없이) ──
     청크 모범 해석의 핵심 토큰이 학생 해석 어딘가에 있는지만 본다. 조사를 떼고
     (가족은→가족), 용언은 종결어미를 근사로 뗀다(들었다→들었 — 들었어요 도 잡힌다).
     활용까지 다 좇을 수는 없으니 3자 이상 어간은 앞 2자를 예비 후보로 둔다(갈매기들→갈매;
     2자 어간의 2자 접두는 어간 그대로라 뜻 없는 관대함만 보탠다).
     어느 문장에나 나오는 기능 어간(것이다·하다·있다·되다·이다 …)은 핵심 토큰이 아니다 —
     "나는 그것이 좋다"가 "간직할 것이다" 청크를 채워선 안 된다.
     같은 자리를 두 토큰이 나눠 쓰지 못하고(사용 구간 표시), 한 청크 안에서는 앞 토큰이
     매칭된 자리 뒤에서만 다음 토큰을 찾는다(위치 순서 제약).
     청크의 토큰 절반 이상이 보이면 present — 정밀 채점이 아니라 "이 청크를 통째로
     빠뜨렸다"를 표시하는 용도라, 한두 낱말의 의역은 너그럽게 지나간다. */
  var JOSA = ['에서는', '에게서', '에서', '에게', '으로', '부터', '까지', '처럼', '보다', '한테', '께서', '에는',
    '은', '는', '이', '가', '을', '를', '의', '에', '로', '와', '과', '도', '만'];

  var FUNC_STEMS = {};
  ('것 것이 수 하 한 했 해 하고 하는 있 있는 있었 없 없는 없었 되 된 됐 되는 되었 이 이었 인 않 않는 않았 '
    + '그 저 그것 이것 저것 때 때문 위해 위한 대해 대한 통해 같 같은 같이 및 등 또 또한 그리고 그래서 하지만')
    .split(' ').forEach(function (w) { FUNC_STEMS[w] = true; });

  function stripJosa(w) {
    for (var k = 0; k < JOSA.length; k++) {
      var j = JOSA[k];
      if (w.length > j.length && w.slice(-j.length) === j) return w.slice(0, -j.length);
    }
    return w;
  }

  function isFunctionToken(word, base) {
    var stem = base.replace(/[다요]$/, '');
    return !!(FUNC_STEMS[word] || FUNC_STEMS[base] || FUNC_STEMS[stem]);
  }

  function coreCands(word) {
    var cands = [], base = stripJosa(word);
    function add(c) { if (c.length >= 2 && cands.indexOf(c) < 0) cands.push(c); }
    add(base);
    add(base.replace(/[다요]$/, ''));                 // 용언 종결어미 근사 — 만들었다→만들었
    if (base.length >= 3) add(base.slice(0, 2));      // 활용 대비 예비 후보 — 갈매기들→갈매
    if (!cands.length) add(word.slice(0, 2));         // 조사를 떼니 한 글자만 남는 낱말 — 문이→문이
    return cands;
  }

  function gradeTranslationChunks(inputKo, chunks) {
    var input = String(inputKo == null ? '' : inputKo);
    var used = [];
    function free(p, len) {
      for (var k = 0; k < used.length; k++) if (p < used[k][1] && used[k][0] < p + len) return false;
      return true;
    }
    function findFrom(cand, from) {
      for (var p = input.indexOf(cand, from); p >= 0; p = input.indexOf(cand, p + 1)) {
        if (free(p, cand.length)) return p;
      }
      return -1;
    }
    var presentCount = 0;
    var perChunk = (chunks || []).map(function (c) {
      var words = String((c && c.ko) || '').replace(/[^가-힣]/g, ' ').split(/\s+/);
      var total = 0, found = 0, cursor = 0;
      words.forEach(function (w) {
        if (w.length < 2) return; // 2자 미만은 핵심 토큰으로 안 본다
        var base = stripJosa(w);
        if (isFunctionToken(w, base)) return;
        total += 1;
        var cands = coreCands(w);
        for (var k = 0; k < cands.length; k++) {
          var p = findFrom(cands[k], cursor);
          if (p < 0) continue;
          used.push([p, p + cands[k].length]);
          cursor = p + cands[k].length;
          found += 1;
          return;
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
