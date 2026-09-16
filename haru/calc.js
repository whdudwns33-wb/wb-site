'use strict';
/* 수학 수치 생성기 8종 — T1·T2 의 산출은 문항이 아니라 템플릿이고, 런타임에 rnd 주입으로 무한 파생한다("변주 문항은 저장하지 않는다").
   CSP 가 CDN 을 막으므로(KaTeX 불가) 출력은 HTML 없이 유니코드 텍스트뿐이다: 분수 "3/4"·대분수 "1 3/4"·단위 "cm³".
   오답 선택지는 이 앱의 관측 장치다 — 계산 실수형(errKind:'calc')과 개념 혼동형(atomId 또는 errKind:'concept')을 생성기가 표시해
   ②실행 오류·③유형 혼동 판정의 손 비용이 0 이 된다. 정답은 값으로 유일해야 한다(같은 값의 다른 표기는 금지). */
var WBHARU_CALC = (function () {
  function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { var t = a % b; a = b; b = t; } return a; }
  function lcm(a, b) { return a / gcd(a, b) * b; }
  function pick(rnd, lo, hi) { return lo + Math.floor(rnd() * (hi - lo + 1)); }
  function choose(rnd, arr) { return arr[Math.floor(rnd() * arr.length)]; }
  function shuffle(arr, rnd) { var a = arr.slice(); for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rnd() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  function round(x, places) { var m = Math.pow(10, places || 0); return Math.round(x * m + 1e-9) / m; }
  function fmtInt(n) { var s = String(Math.abs(Math.round(n))); if (s.length > 4) s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ','); return (n < 0 ? '−' : '') + s; }
  function fmtDec(x, places) { var r = round(x, places); var s = String(r); return s.indexOf('e') >= 0 ? r.toFixed(places || 0) : s; }
  /* 기약 + 대분수 표기 — 초등 교과서 관행. 값 비교는 fracVal 로 한다 (같은 값의 다른 표기가 선택지에 둘 들어가면 정답이 둘이 된다). */
  function frac(n, d) { if (d < 0) { n = -n; d = -d; } var g = gcd(n, d) || 1; return { n: n / g, d: d / g }; }
  function fracVal(f) { return f.n / f.d; }
  function fmtFrac(f) {
    f = frac(f.n, f.d);
    if (f.d === 1) return String(f.n);
    var neg = f.n < 0, n = Math.abs(f.n);
    var whole = Math.floor(n / f.d), rest = n % f.d;
    var s = whole > 0 ? (rest ? whole + ' ' + rest + '/' + f.d : String(whole)) : rest + '/' + f.d;
    return (neg ? '−' : '') + s;
  }
  var SUP = { '2': '²', '3': '³' };

  /* 선택지 조립 — 정답 + 오답 후보(값이 정답·서로와 다른 것만) 3개, 부족하면 정답 근처의 계산 실수형으로 채운다. */
  function build(rnd, correct, cands, fmt) {
    var out = [{ text: fmt(correct.v), value: correct.v, atomId: null, errKind: null, answer: true }];
    var seenV = [correct.v], seenT = [out[0].text];
    function push(c) {
      if (out.length >= 4) return;
      var t = fmt(c.v);
      if (!isFinite(c.v) || c.v < 0 && !c.allowNeg) return;
      for (var i = 0; i < seenV.length; i++) if (Math.abs(seenV[i] - c.v) < 1e-9) return;
      if (seenT.indexOf(t) >= 0) return;
      seenV.push(c.v); seenT.push(t);
      out.push({ text: t, value: c.v, atomId: c.atomId || null, errKind: c.errKind || null, answer: false });
    }
    cands.forEach(push);
    var k = 1, unit = Math.abs(correct.v) >= 10 ? 1 : Math.abs(correct.v) >= 1 ? 0.5 : 0.1;
    while (out.length < 4 && k < 20) {
      push({ v: correct.v * (1 + 0.1 * k), errKind: 'calc' }); push({ v: correct.v * (1 - 0.1 * k), errKind: 'calc' });
      push({ v: correct.v + unit * k, errKind: 'calc' }); push({ v: correct.v - unit * k, errKind: 'calc' });
      k++;
    }
    var order = shuffle(out, rnd);
    var choices = order.map(function (c, i) { var o = { key: String(i + 1), text: c.text }; if (!c.answer) { o.atomId = c.atomId; o.errKind = c.errKind; } return o; });
    var answerKey = String(order.map(function (c) { return c.answer; }).indexOf(true) + 1);
    return { choices: choices, answerKey: answerKey };
  }
  function item(tpl, atomId, params, q, answerValue, built, expl, rnd) {
    return { gen: 'calc', tpl: tpl, atomId: atomId, form: 'mcq4', isNegative: false, answerCount: 1,
             instructionKo: q, choices: built.choices, answerKey: built.answerKey, explanationKo: expl, answerValue: answerValue, params: params };
  }

  /* 1. 분수 사칙 — n-frac-basic(덧뺄) · m-frac-mul(곱) · m-frac-div(나눗셈, 단위량 문장제) */
  function fracArith(rnd, opts) {
    var atomId = (opts && opts.atomId) || 'n-frac-basic';
    if (atomId === 'm-frac-div') {
      var d = pick(rnd, 3, 9), n = pick(rnd, 1, d - 1), k = pick(rnd, 2, 6);
      var g = frac(n, d), ans = frac(n, d * k);
      var word = choose(rnd, ['물 {a} L 를 컵 {k}개에 똑같이 나누면 한 컵에 몇 L 인가?', '리본 {a} m 를 {k}명이 똑같이 나누면 한 명이 몇 m 를 갖는가?', '주스 {a} L 를 {k}일 동안 똑같이 나누어 마시면 하루에 몇 L 인가?']);
      var q = word.replace('{a}', fmtFrac(g)).replace('{k}', k);
      var built = build(rnd, { v: fracVal(ans) }, [
        { v: fracVal(frac(n * k, d)), atomId: 'm-frac-mul' },                  // ÷ 를 × 로 — 유형 혼동
        { v: fracVal(frac(n, d * k * k)), errKind: 'calc' },                   // 분모에 두 번 곱함
        { v: fracVal(frac(n, d)) / k / 2, errKind: 'calc' }
      ], function (v) { return fmtFrac(toFrac(v)) + (q.indexOf('L') >= 0 ? ' L' : ' m'); });
      return item('frac-div', atomId, { n: n, d: d, k: k }, q, fracVal(ans), built, fmtFrac(g) + ' ÷ ' + k + ' = ' + n + '/(' + d + '×' + k + ') = ' + fmtFrac(ans), rnd);
    }
    if (atomId === 'm-frac-mul') {
      var d1 = pick(rnd, 2, 9), n1 = pick(rnd, 1, d1 - 1), d2 = pick(rnd, 2, 9), n2 = pick(rnd, 1, d2 - 1);
      var a = frac(n1, d1), b = frac(n2, d2), r = frac(a.n * b.n, a.d * b.d);
      var q2 = fmtFrac(a) + ' × ' + fmtFrac(b) + ' 의 값은?';
      var built2 = build(rnd, { v: fracVal(r) }, [
        { v: fracVal(frac(a.n * b.d + b.n * a.d, a.d * b.d)), atomId: 'n-frac-basic' },   // 덧셈으로 — 유형 혼동
        { v: fracVal(frac(a.n * b.n, a.d + b.d)), errKind: 'calc' },                     // 분모를 더함
        { v: fracVal(frac(a.n + b.n, a.d * b.d)), errKind: 'calc' }
      ], function (v) { return fmtFrac(toFrac(v)); });
      return item('frac-mul', atomId, { n1: a.n, d1: a.d, n2: b.n, d2: b.d }, q2, fracVal(r), built2, '분자끼리, 분모끼리 곱한다: ' + fmtFrac(r), rnd);
    }
    var dA = pick(rnd, 2, 9), dB = pick(rnd, 2, 9); if (dB === dA) dB = dA === 9 ? 8 : dA + 1;
    var nA = pick(rnd, 1, dA - 1), nB = pick(rnd, 1, dB - 1), plus = rnd() < 0.6;
    var A = frac(nA, dA), B = frac(nB, dB);
    if (!plus && fracVal(A) < fracVal(B)) { var tmp = A; A = B; B = tmp; }
    var R = frac(plus ? A.n * B.d + B.n * A.d : A.n * B.d - B.n * A.d, A.d * B.d);
    var q3 = fmtFrac(A) + (plus ? ' + ' : ' − ') + fmtFrac(B) + ' 의 값은?';
    var built3 = build(rnd, { v: fracVal(R) }, [
      { v: fracVal(frac(plus ? A.n + B.n : A.n - B.n, A.d + B.d)), errKind: 'calc' },          // 통분 없이 분자·분모 각각
      { v: fracVal(frac(plus ? A.n + B.n : A.n - B.n, lcm(A.d, B.d))), errKind: 'calc' },       // 분모만 통분
      { v: fracVal(frac(A.n * B.n, A.d * B.d)), atomId: 'm-frac-mul' },                          // 곱셈으로 — 유형 혼동
      { v: fracVal(frac(plus ? A.n * B.d - B.n * A.d : A.n * B.d + B.n * A.d, A.d * B.d)), errKind: 'calc', allowNeg: false },   // 부호 반대
      { v: fracVal(frac(R.n + 1, R.d)), errKind: 'calc' }, { v: fracVal(frac(R.n, R.d + 1)), errKind: 'calc' }
    ], function (v) { return fmtFrac(toFrac(v)); });
    return item('frac-addsub', atomId, { nA: A.n, dA: A.d, nB: B.n, dB: B.d, plus: plus }, q3, fracVal(R), built3, '분모를 ' + lcm(A.d, B.d) + ' 로 통분한 뒤 분자끼리 계산: ' + fmtFrac(R), rnd);
  }
  /* 실수 → 분수 근사(선택지 표기용). 생성기 안의 값은 전부 유리수라 분모 5040 안에서 정확히 잡힌다. */
  function toFrac(v) {
    var best = { n: Math.round(v), d: 1 }, err = Math.abs(v - best.n);
    for (var d = 1; d <= 5040 && err > 1e-9; d++) { var n = Math.round(v * d); var e = Math.abs(v - n / d); if (e < err) { err = e; best = { n: n, d: d }; } }
    return frac(best.n, best.d);
  }

  /* 2. 3방향 변환·비율·백분율·기준량 역산 — n-convert · m-ratio-base · m-pct-apply · m-pct-inverse */
  function convert(rnd, opts) {
    var atomId = (opts && opts.atomId) || 'm-ratio-base';
    var pct = function (v) { return fmtDec(v, 2) + ' %'; };
    if (atomId === 'n-convert') {
      var d = choose(rnd, [4, 5, 8, 10, 20, 25, 50]), n = pick(rnd, 1, d - 1); var f = frac(n, d), val = n / d;
      var mode = choose(rnd, ['dec', 'pct', 'frac']);
      if (mode === 'dec') { var b1 = build(rnd, { v: val }, [{ v: val * 10, errKind: 'calc' }, { v: val / 10, errKind: 'calc' }, { v: f.d / (f.n + f.d), errKind: 'concept' }], function (v) { return fmtDec(v, 4); });
        return item('convert', atomId, { n: f.n, d: f.d, mode: mode }, fmtFrac(f) + ' 을 소수로 나타내면?', val, b1, f.n + ' ÷ ' + f.d + ' = ' + fmtDec(val, 4), rnd); }
      if (mode === 'pct') { var b2 = build(rnd, { v: val * 100 }, [{ v: val, errKind: 'calc' }, { v: val * 10, errKind: 'calc' }, { v: (1 - val) * 100, errKind: 'concept' }], pct);
        return item('convert', atomId, { n: f.n, d: f.d, mode: mode }, fmtDec(val, 4) + ' 을 백분율로 나타내면?', val * 100, b2, '소수에 100 을 곱한다: ' + fmtDec(val * 100, 2) + ' %', rnd); }
      var b3 = build(rnd, { v: val }, [{ v: val / 10, errKind: 'calc' }, { v: (f.d - f.n) / f.d, errKind: 'concept' }, { v: f.n / (f.d + 1), errKind: 'calc' }], function (v) { return fmtFrac(toFrac(v)); });
      return item('convert', atomId, { n: f.n, d: f.d, mode: mode }, fmtDec(val * 100, 2) + ' % 를 기약분수로 나타내면?', val, b3, fmtDec(val * 100, 2) + '/100 을 약분: ' + fmtFrac(f), rnd);
    }
    if (atomId === 'm-pct-apply') {
      var base = choose(rnd, [200, 400, 500, 800, 1000, 1200, 1500, 2000, 2500, 3000]), p = choose(rnd, [5, 10, 15, 20, 25, 30, 40, 50]), up = rnd() < 0.4;
      var res = up ? base * (1 + p / 100) : base * (1 - p / 100);
      var q = (up ? '{b}원인 물건 값이 {p} % 올랐다. 오른 뒤 값은?' : '{b}원인 물건을 {p} % 할인하면 얼마인가?').replace('{b}', fmtInt(base)).replace('{p}', p);
      var b4 = build(rnd, { v: res }, [{ v: base * p / 100, errKind: 'concept' }, { v: up ? base * (1 - p / 100) : base * (1 + p / 100), errKind: 'concept' }, { v: up ? base + p : base - p, errKind: 'calc' }, { v: res * 10, errKind: 'calc' }], function (v) { return fmtInt(v) + '원'; });
      return item('pct-apply', atomId, { base: base, p: p, up: up }, q, res, b4, fmtInt(base) + ' × ' + (up ? '(1 + ' : '(1 − ') + p + '/100) = ' + fmtInt(res) + '원', rnd);
    }
    if (atomId === 'm-pct-inverse') {
      if (rnd() < 0.5) {
        var pr = choose(rnd, [10, 20, 25, 40, 50, 60, 75, 80]), part = choose(rnd, [6, 8, 12, 15, 18, 20, 24, 30, 36, 45, 60]) ; var whole = part * 100 / pr;
        if (whole !== Math.round(whole)) { whole = pick(rnd, 2, 12) * 10; part = whole * pr / 100; }
        var q5 = choose(rnd, ['어떤 반에서 {a}명이 안경을 썼고, 이는 반 전체의 {p} % 이다. 반 전체 학생은 몇 명인가?', '컵에 물이 {a} mL 들어 있고, 이는 컵 전체의 {p} % 이다. 컵 전체는 몇 mL 인가?']).replace('{a}', fmtInt(part)).replace('{p}', pr);
        var unit = q5.indexOf('mL') >= 0 ? ' mL' : '명';
        var b5 = build(rnd, { v: whole }, [{ v: part * pr / 100, atomId: 'm-pct-apply' }, { v: part + pr, errKind: 'calc' }, { v: part * 100 / (100 - pr), errKind: 'concept' }, { v: whole * 10, errKind: 'calc' }], function (v) { return fmtDec(v, 1) + unit; });
        return item('pct-inverse', atomId, { part: part, p: pr, kind: 'base' }, q5, whole, b5, '기준량 = 비교하는 양 ÷ 비율 = ' + fmtInt(part) + ' ÷ ' + pr + '/100 = ' + fmtInt(whole) + unit, rnd);
      }
      var base2 = choose(rnd, [1000, 2000, 4000, 5000, 8000, 10000]), p1 = choose(rnd, [10, 20, 25, 50]), p2 = choose(rnd, [10, 20, 25, 50]);
      var res2 = base2 * (1 - p1 / 100) * (1 - p2 / 100);
      var q6 = fmtInt(base2) + '원인 물건을 ' + p1 + ' % 할인한 뒤, 그 값에서 다시 ' + p2 + ' % 할인했다. 최종 값은?';
      var b6 = build(rnd, { v: res2 }, [{ v: base2 * (1 - (p1 + p2) / 100), errKind: 'concept' }, { v: base2 * (1 - p1 / 100), errKind: 'calc' }, { v: base2 * (1 - p1 / 100) - p2, errKind: 'calc' }], function (v) { return fmtInt(v) + '원'; });
      return item('pct-chain', atomId, { base: base2, p1: p1, p2: p2, kind: 'chain' }, q6, res2, b6, '할인은 할인된 값에 다시 적용한다: ' + fmtInt(base2) + ' × ' + (100 - p1) / 100 + ' × ' + (100 - p2) / 100 + ' = ' + fmtInt(res2) + '원', rnd);
    }
    var b = choose(rnd, [20, 25, 40, 50, 80, 100, 120, 150, 200, 250, 400, 500]), a = pick(rnd, 1, b - 1);
    var ratio = a / b * 100;
    var q7 = choose(rnd, ['전체 {b}개 중 {a}개가 빨간 구슬이다. 빨간 구슬의 비율을 백분율로 나타내면?', '{b}명 중 {a}명이 자전거로 통학한다. 자전거 통학생의 비율은 몇 % 인가?', '{b} L 의 물 중 {a} L 가 걸러졌다. 걸러진 물의 비율은 몇 % 인가?']).replace('{b}', fmtInt(b)).replace('{a}', fmtInt(a));
    var b7 = build(rnd, { v: ratio }, [{ v: b / a * 100, atomId: 'm-pct-inverse' }, { v: a / b, errKind: 'calc' }, { v: a / b * 10, errKind: 'calc' }, { v: (b - a) / b * 100, errKind: 'concept' }], pct);
    return item('ratio-base', atomId, { a: a, b: b }, q7, ratio, b7, '기준량 ' + b + ', 비교하는 양 ' + a + ' → ' + a + '/' + b + ' = ' + fmtDec(ratio, 2) + ' %', rnd);
  }

  /* 3. 단위 환산 — n-unit(길이·시간·들이·무게) · m-unit-vol(넓이·부피) */
  var UNITS = {
    'n-unit': [['km', 'm', 1000], ['m', 'cm', 100], ['cm', 'mm', 10], ['L', 'mL', 1000], ['kg', 'g', 1000], ['시간', '분', 60], ['분', '초', 60]],
    'm-unit-vol': [['m²', 'cm²', 10000], ['km²', 'm²', 1000000], ['m³', 'cm³', 1000000], ['L', 'cm³', 1000], ['m³', 'L', 1000], ['cm³', 'mL', 1]]
  };
  function unit(rnd, opts) {
    var atomId = (opts && opts.atomId) || 'n-unit';
    var u = choose(rnd, UNITS[atomId] || UNITS['n-unit']), big = u[0], small = u[1], f = u[2];
    var toSmall = rnd() < 0.5, n;
    if (toSmall) n = choose(rnd, [0.5, 1.2, 2, 2.5, 3, 4.5, 7, 12]); else n = f * choose(rnd, [0.5, 1.5, 2, 3, 4, 6, 25]);
    var q = toSmall ? fmtDec(n, 2) + ' ' + big + ' 는 몇 ' + small + ' 인가?' : fmtInt(n) + ' ' + small + ' 는 몇 ' + big + ' 인가?';
    var ans = toSmall ? n * f : n / f;
    var fmt = function (v) { return (Math.abs(v - Math.round(v)) < 1e-9 ? fmtInt(v) : fmtDec(v, 3)) + ' ' + (toSmall ? small : big); };
    var b = build(rnd, { v: ans }, [{ v: ans * 10, errKind: 'calc' }, { v: ans / 10, errKind: 'calc' }, { v: ans * 100, errKind: 'calc' }, { v: ans / 100, errKind: 'calc' },
      { v: toSmall ? n / f : n * f, errKind: 'concept' }], fmt);
    return item('unit', atomId, { n: n, big: big, small: small, f: f, toSmall: toSmall }, q, ans, b, '1 ' + big + ' = ' + fmtInt(f) + ' ' + small, rnd);
  }

  /* 4. 몫과 나머지, 나머지의 소수점 — m-dec-remainder · m-dec-div */
  function remainder(rnd, opts) {
    var atomId = (opts && opts.atomId) || 'm-dec-remainder';
    var k = pick(rnd, 3, 9);
    if (atomId === 'm-dec-div') {
      var qv = round(pick(rnd, 11, 99) / 10, 1), dividend = round(qv * k, 2);
      var q0 = fmtDec(dividend, 2) + ' ÷ ' + k + ' 의 값은?';
      var b0 = build(rnd, { v: qv }, [{ v: qv * 10, errKind: 'calc' }, { v: qv / 10, errKind: 'calc' }, { v: dividend * k, atomId: 'm-frac-mul' }], function (v) { return fmtDec(v, 3); });
      return item('dec-div', atomId, { dividend: dividend, k: k }, q0, qv, b0, fmtDec(dividend, 2) + ' ÷ ' + k + ' = ' + fmtDec(qv, 1), rnd);
    }
    /* 몫(소수 첫째 자리)과 나머지(0 < r < 0.1k, 소수 첫째 자리)를 먼저 고르고 나뉘는 수를 만든다 — 거꾸로 뽑으면 나머지 0 이 자주 나와 문항이 안 된다 */
    var quot = round(pick(rnd, 12, 89) / 10, 1);
    var rem = round(pick(rnd, 1, k - 1) / 10, 1);
    var dv = round(quot * k + rem, 1);
    var q = fmtDec(dv, 1) + ' ÷ ' + k + ' 의 몫을 소수 첫째 자리까지 구했을 때 나머지는?';
    var b = build(rnd, { v: rem }, [{ v: rem * 10, errKind: 'calc' }, { v: rem * 100, errKind: 'calc' }, { v: quot, errKind: 'concept' }, { v: rem / 10, errKind: 'calc' }], function (v) { return fmtDec(v, 3); });
    return item('dec-remainder', atomId, { dv: dv, k: k, quot: quot }, q, rem, b, '몫 ' + fmtDec(quot, 1) + ', 나머지 = ' + fmtDec(dv, 1) + ' − ' + k + ' × ' + fmtDec(quot, 1) + ' = ' + fmtDec(rem, 2) + ' (나머지의 소수점은 나뉘는 수와 같은 자리)', rnd);
  }

  /* 5. 약수·배수 — m-divisor-multiple(값) · m-gcd-lcm-word(문장제) */
  function gcdLcm(rnd, opts) {
    var atomId = (opts && opts.atomId) || 'm-gcd-lcm-word';
    var g = choose(rnd, [2, 3, 4, 5, 6, 8, 12]), x = pick(rnd, 2, 7), y = pick(rnd, 2, 7); if (gcd(x, y) !== 1) { y = x + 1; } if (x === y) y++;
    var a = g * x, b = g * y, G = gcd(a, b), L = lcm(a, b), wantG = rnd() < 0.5;
    var q, unitTxt = '';
    if (atomId === 'm-divisor-multiple') q = a + ' 과 ' + b + ' 의 ' + (wantG ? '최대공약수' : '최소공배수') + '는?';
    else if (wantG) { q = choose(rnd, ['길이 {a} cm 와 {b} cm 인 리본 두 개를 남김없이 같은 길이로 자르려고 한다. 가장 길게 자를 때 한 도막의 길이는?', '가로 {a} cm, 세로 {b} cm 인 종이를 남김없이 같은 크기의 정사각형으로 자르려고 한다. 가장 큰 정사각형의 한 변은?']).replace('{a}', a).replace('{b}', b); unitTxt = ' cm'; }
    else { q = choose(rnd, ['두 버스가 각각 {a}분, {b}분 간격으로 출발한다. 동시에 출발한 뒤 다음에 동시에 출발하는 때는 몇 분 후인가?', '톱니 수가 {a}개, {b}개인 톱니바퀴가 맞물려 돈다. 처음 맞물린 톱니가 다시 맞물리려면 톱니가 몇 개 지나야 하는가?']).replace('{a}', a).replace('{b}', b); unitTxt = q.indexOf('분') >= 0 && q.indexOf('버스') >= 0 ? '분' : '개'; }
    var ans = wantG ? G : L;
    var bch = build(rnd, { v: ans }, [{ v: wantG ? L : G, errKind: 'concept' }, { v: a * b, errKind: 'calc' }, { v: wantG ? G * 2 : L / 2, errKind: 'calc' }, { v: a + b, errKind: 'calc' }], function (v) { return fmtInt(v) + unitTxt; });
    return item('gcd-lcm', atomId, { a: a, b: b, wantG: wantG }, q, ans, bch, (wantG ? '최대공약수 ' : '최소공배수 ') + ans + ' (' + a + ' = ' + G + '×' + a / G + ', ' + b + ' = ' + G + '×' + b / G + ')', rnd);
  }

  /* 6. 평균 역산 — m-avg-inverse */
  function avgInverse(rnd) {
    var n = pick(rnd, 3, 5), avg = choose(rnd, [70, 75, 80, 82, 84, 85, 88, 90]);
    var known = [], sum = avg * n;
    for (var i = 0; i < n - 1; i++) known.push(pick(rnd, 60, 100));
    var last = sum - known.reduce(function (s, v) { return s + v; }, 0);
    if (last < 0 || last > 100) { known = known.map(function () { return avg; }); last = avg; }
    var q = n + '과목 점수의 평균이 ' + avg + '점이다. ' + (n - 1) + '과목 점수가 ' + known.join('점, ') + '점일 때 나머지 한 과목의 점수는?';
    var kavg = Math.round(known.reduce(function (s, v) { return s + v; }, 0) / (n - 1));
    var b = build(rnd, { v: last }, [{ v: avg, errKind: 'concept' }, { v: kavg, errKind: 'concept' }, { v: last + n, errKind: 'calc' }, { v: last - n, errKind: 'calc' }, { v: last + 10, errKind: 'calc' }], function (v) { return fmtInt(v) + '점'; });
    return item('avg-inverse', 'm-avg-inverse', { n: n, avg: avg, known: known }, q, last, b, '합계 = 평균 × 개수 = ' + avg + ' × ' + n + ' = ' + sum + ', 나머지 = ' + sum + ' − (' + known.join(' + ') + ') = ' + last + '점', rnd);
  }

  /* 7. 각기둥·각뿔 구성 요소 — m-prism-count */
  var POLY = ['삼각', '사각', '오각', '육각', '칠각', '팔각'];
  function prism(rnd) {
    var n = pick(rnd, 3, 8), isPrism = rnd() < 0.5, what = choose(rnd, ['면', '모서리', '꼭짓점']);
    var name = POLY[n - 3] + (isPrism ? '기둥' : '뿔');
    var val = { 면: isPrism ? n + 2 : n + 1, 모서리: isPrism ? 3 * n : 2 * n, 꼭짓점: isPrism ? 2 * n : n + 1 }[what];
    var other = { 면: isPrism ? n + 1 : n + 2, 모서리: isPrism ? 2 * n : 3 * n, 꼭짓점: isPrism ? n + 1 : 2 * n }[what];
    var q = name + '의 ' + what + '의 수는?';
    var b = build(rnd, { v: val }, [{ v: other, errKind: 'concept' }, { v: val + n, errKind: 'calc' }, { v: n, errKind: 'calc' }, { v: val - 1, errKind: 'calc' }], function (v) { return fmtInt(v) + '개'; });
    var rule = isPrism ? '각기둥: 면 n+2 · 모서리 3n · 꼭짓점 2n' : '각뿔: 면 n+1 · 모서리 2n · 꼭짓점 n+1';
    return item('prism', 'm-prism-count', { n: n, isPrism: isPrism, what: what }, q, val, b, rule + ' (n = ' + n + ') → ' + val + '개', rnd);
  }

  /* 8. 직육면체 겉넓이·부피 — m-surface-volume */
  function surfaceVolume(rnd) {
    var a = pick(rnd, 2, 12), b = pick(rnd, 2, 12), c = pick(rnd, 2, 12), cube = rnd() < 0.25, wantS = rnd() < 0.5;
    if (cube) { b = a; c = a; }
    var S = 2 * (a * b + b * c + c * a), V = a * b * c;
    var shape = cube ? '한 모서리가 ' + a + ' cm 인 정육면체' : '가로 ' + a + ' cm, 세로 ' + b + ' cm, 높이 ' + c + ' cm 인 직육면체';
    var q = shape + '의 ' + (wantS ? '겉넓이는?' : '부피는?');
    var unitS = ' cm' + SUP['2'], unitV = ' cm' + SUP['3'];
    var b2 = build(rnd, { v: wantS ? S : V }, [{ v: wantS ? V : S, errKind: 'concept' }, { v: wantS ? S / 2 : V * 2, errKind: 'calc' }, { v: wantS ? 2 * (a * b + b * c) : a * b + c, errKind: 'calc' }, { v: wantS ? a * b * 6 : (a + b + c), errKind: 'calc' }], function (v) { return fmtInt(v) + (wantS ? unitS : unitV); });
    return item('surface-volume', 'm-surface-volume', { a: a, b: b, c: c, wantS: wantS }, q, wantS ? S : V, b2, wantS ? '겉넓이 = 2 × (' + a + '×' + b + ' + ' + b + '×' + c + ' + ' + c + '×' + a + ') = ' + S + unitS : '부피 = ' + a + ' × ' + b + ' × ' + c + ' = ' + V + unitV, rnd);
  }

  var TEMPLATES = {
    'n-frac-basic': fracArith, 'm-frac-mul': fracArith, 'm-frac-div': fracArith,
    'n-convert': convert, 'm-ratio-base': convert, 'm-pct-apply': convert, 'm-pct-inverse': convert,
    'n-unit': unit, 'm-unit-vol': unit,
    'm-dec-remainder': remainder, 'm-dec-div': remainder,
    'm-divisor-multiple': gcdLcm, 'm-gcd-lcm-word': gcdLcm,
    'm-avg-inverse': avgInverse, 'm-prism-count': prism, 'm-surface-volume': surfaceVolume
  };
  /* 시드 재현 — 같은 (원자, 날짜, 상태) 면 같은 문항. naesin 의 strHash(id)+dayNo+(wrong+streak) 계약을 그대로 쓴다. */
  function seeded(seed) { var s = (seed >>> 0) || 1; return function () { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; }
  function strHash(str) { var h = 5381; for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return h >>> 0; }
  function generate(atomId, rnd, opts) {
    var fn = TEMPLATES[atomId]; if (!fn) return null;
    var it = fn(rnd, Object.assign({}, opts || {}, { atomId: atomId }));
    it.itemId = 'calc:' + it.tpl + ':' + strHash(JSON.stringify(it.params)).toString(36);
    return it;
  }
  /* 원장 검수 표본 — 템플릿당 30문항 (기획서 §6-5 · 정제소 검수 시간의 주 항목) */
  function sampleSheet(atomId, n, seed) { var rnd = seeded(seed || 1), out = []; for (var i = 0; i < (n || 30); i++) out.push(generate(atomId, rnd)); return out; }

  return { TEMPLATES: TEMPLATES, generate: generate, sampleSheet: sampleSheet, seeded: seeded, strHash: strHash,
           gcd: gcd, lcm: lcm, frac: frac, fmtFrac: fmtFrac, fmtDec: fmtDec, fmtInt: fmtInt, toFrac: toFrac, build: build };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WBHARU_CALC;
