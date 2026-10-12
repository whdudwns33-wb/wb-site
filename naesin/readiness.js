'use strict';
/* WB 내신브레인(영어) — 시험 준비도 산출 (순수 로직, 브라우저/Node 공용)
   기획서 §12 파일럿 판정 기준("시험 2주 전 시작한 반의 **범위 완성률 70%**")을
   실제로 셀 수 있는 한 숫자와 그 분해로 바꾼 모듈.

   왜 따로 두나: engine.js 의 rangeSummary 는 '몇 개'를 센다(단어 도달 83/120, 문장 해석 41/60…).
   원장이 판정에 쓰는 값은 개수가 아니라 **가중 합**이고, 그 가중치는 학습 스케줄러가 알 일이
   아니다. engine 에 넣으면 플랜과 평가 정책이 한 파일에서 같이 흔들린다.
   국어브레인의 naesin-ko/readiness.js 와 같은 자리·같은 역할이지만 **사다리가 다르다** —
   국어는 5단계(읽기→개념빈칸→구절적용→주석복원→서술형), 영어는 단어 게이트 + 문장 6단계 +
   본문 세 층이다. 그래서 축을 베끼지 않고 영어 사다리에서 다시 세운다.

   **완성률의 정본은 이미 있다.** `reading-server/naesin-results.mjs:15` 의 복합 도달률 `m`
   (W_STABLE 0.4 · W_INTERPRET 0.3 · W_BLANK 0.3)이 세 최종 목표(① 해석 ② 백지 ③ 단어 100%)를
   가중 합한 값이고, 시험 결과 분석이 그 숫자로 점수와의 상관을 낸다. 여기서 다른 가중치를
   쓰면 **같은 관리 화면에서 「반 완성률 68%」와 「복합 도달률 0.74」가 서로 다른 말을 한다.**
   그래서 완성률은 그 가중치를 그대로 따르고, 본문 진행·내용정리 점검은 **점수를 바꾸지 않는
   진단 축**으로만 둔다(무엇을 먼저 할지 고르는 데만 쓴다).
   모듈이 둘로 갈린 이유는 하나뿐이다 — 이쪽은 브라우저 IIFE, 저쪽은 서버 ESM 이라 import 가
   안 된다. 그래서 값을 복제하되 **`readiness-reach.test.mjs` 가 두 모듈을 같이 불러
   같은 요약에서 같은 숫자가 나오는지 고정한다** — 상수만 견주면 축을 바꿔 끼운 변경
   (단어를 stable 대신 reached 로 세는 것 같은)을 놓친다.

   설계 원칙 넷:
   1. 축은 학생이 **오늘 무엇을 할지**와 1:1 이다. "준비도 62%" 만 있는 지표는 행동을 안 바꾼다.
   2. engine.js 의 상수를 다시 적지 않고 주입받는다. 기본값이 engine 과 어긋나면 테스트가 잡는다.
   3. 전망은 예측이 아니라 **제약**이다. 안정화는 '서로 다른 날 3회 재도달'이라, 오늘 처음 만난
      단어는 물리적으로 최소 3일이 걸린다. D-2 에 미착수 단어가 남았으면 그건 추정이 아니라
      **확정된 미달**이다 — 그 사실을 숫자로 내보낸다.
   4. **모르는 것은 0점이 아니라 축에서 뺀다.** 내용정리 점검 문항이 없는 팩에서 check 를 0점으로
      깔면 그 반은 영원히 70% 를 못 넘는다. 재료가 없는 축은 가중치를 0으로 돌리고 남은 축으로
      정규화한다 — 거짓 미달을 만들지 않는 쪽이 판정 도구의 조건이다.

   파일럿 판정의 두 읽기: 기획서의 "반의 범위 완성률 70%" 는 ① 반 평균이 70% 인가
   ② 반 학생 중 70% 를 넘긴 비율인가 — 두 가지로 읽힌다. 이 모듈은 **②를 머리 숫자로** 둔다.
   ①은 잘하는 두세 명이 평균을 끌어올려 반쪽짜리 파일럿을 통과시킬 수 있기 때문이다.
   그래도 ①(average)·중앙값도 같이 돌려주므로 원장이 다른 읽기로 판정할 수 있다. */
var WBNAESINREADY = (function () {
  var RELEARN_TARGET = 3;    // engine.RELEARN_TARGET 과 같아야 한다(테스트가 고정)
  var PASS_RATE = 0.7;       // 기획서 §12 파일럿 판정 임계 — 범위 완성률 70%
  var START_DAYS = 14;       // "시험 2주 전 시작한 반" — 판정 대상 여부를 재는 기준

  /* 완성률 가중치 — naesin-results.mjs 의 W_STABLE·W_INTERPRET·W_BLANK 와 **같은 값이어야 한다**.
     테스트가 두 파일을 읽어 고정한다. 바꿀 일이 있으면 양쪽을 같이 바꾼다. */
  var W_STABLE = 0.4, W_INTERPRET = 0.3, W_BLANK = 0.3;

  /* 완성률을 만드는 세 축(합 1.00) + 점수를 바꾸지 않는 진단 축 둘.
     단어는 **안정화(stable)** 로 센다 — 기획서의 '시험 전 단어 100% 완성'이 안정화를 말하고,
     reachOf 도 stable 을 본다. 도달(reached)은 진행 상황이라 따로 보여 주되 점수에 넣지 않는다. */
  var AXES = [
    { key: 'word', label: '단어 안정화', w: W_STABLE, act: '오늘 탭의 단어 큐',
      hint: '서로 다른 날 3회전으로 안정화된 단어 비율 (도달만으로는 완성이 아니다)' },
    { key: 'interpret', label: '문장 해석', w: W_INTERPRET, act: '본문 탭 1~2단계',
      hint: '줄 해석(1단계)을 통과한 문장 비율' },
    { key: 'memorize', label: '백지 암송', w: W_BLANK, act: '본문 탭 6단계 단락 백지',
      hint: '6단계(단락 백지)까지 통과한 문장 비율' },
    /* ── 아래는 진단 축: 점수를 바꾸지 않는다(w: 0). 무엇을 먼저 할지 고르는 데만 쓴다 ── */
    { key: 'passage', label: '본문 진행', w: 0, act: '본문 탭 청크·단락 관문', diagnostic: true,
      hint: '청크 트랙과 단락 백지를 통과한 단락 비율 (완성률에는 넣지 않는다)' },
    { key: 'check', label: '내용정리 점검', w: 0, act: '문제 탭 내용정리', diagnostic: true,
      hint: '점검 문항 정답률 (완성률에는 넣지 않는다)' },
    { key: 'reached', label: '단어 도달', w: 0, act: '오늘 탭의 단어 큐', diagnostic: true,
      hint: '한 번 도달한 단어 비율 — 진행 상황. 완성은 안정화다' }
  ];

  function num(v) { var n = +v; return isFinite(n) && n > 0 ? n : 0; }
  function rate(a, b) { var t = num(b); return t ? Math.min(1, num(a) / t) : null; }
  function pct(x) { return Math.round(x * 100); }

  /* 축별 가중치 — 재료가 없는 축(ratio === null)은 빼고 남은 축으로 정규화한다(원칙 4).
     진단 축은 w: 0 이라 여기서 저절로 빠진다 — 점수를 바꾸지 않는다.
     over 로 학교 배점을 덮어쓸 수 있다 — 합이 1이 아니어도 정규화한다. 다만 완성률을
     결과 분석의 m 과 견주려면 기본값을 그대로 쓰는 쪽이 맞다. */
  function weights(ratios, over) {
    var o = over && typeof over === 'object' ? over : {};
    var live = [], sum = 0;
    AXES.forEach(function (a) {
      if (!ratios || ratios[a.key] == null) return;        // 재료 없음 → 축에서 뺀다
      var w = o[a.key] != null ? num(o[a.key]) : a.w;
      if (!w) return;
      live.push({ key: a.key, w: w }); sum += w;
    });
    var out = {};
    live.forEach(function (x) { out[x.key] = sum ? x.w / sum : 0; });
    return out;
  }

  /* 요약 어디를 보는가 — 저장된 state.summary 는 팩 하나짜리 값(summary.word)과 범위 합계
     (summary.range, 계약 R1)를 **둘 다** 담는다. 시험 범위는 보통 2~3과라 팩 값으로 재면
     범위의 일부만 센다. naesin-results.mjs 의 reachOf·naesin-api 의 naesinNightDue 가
     모두 `sum.range || sum` 으로 보므로 여기도 같아야 한다 — 어긋나면 같은 화면의
     「완성률」과 「복합 도달률」이 서로 다른 분량을 두고 말한다.
     engine.rangeSummary() 의 반환값을 그대로 넘기는 호출(관리 웹의 즉석 계산)은 range 키가
     없으니 그대로 쓰인다. */
  function src(summary) {
    var s = summary && typeof summary === 'object' ? summary : {};
    return (s.range && typeof s.range === 'object') ? s.range : s;
  }

  /* rangeSummary(engine) → 축별 비율 0~1. 재료가 없으면 null(0 이 아니다 — 원칙 4). */
  function ratios(summary) {
    var s = src(summary);
    var w = s.word || {}, sen = s.sentence || {}, p = s.passage || {};
    /* 단어 완성 = 안정화 비율. reachOf(naesin-results.mjs)와 같은 눈이어야 한다 —
       도달(reached)을 섞으면 같은 화면의 복합 도달률과 어긋난다. 도달은 진단 축으로 따로 낸다. */
    var word = rate(w.stable, w.total);
    /* 본문 진행: 청크와 단락 백지를 각각 비율로 보고 평균. 둘 다 재료가 없으면 null */
    var chunk = rate(p.chunkDone, p.chunkTotal);
    var para = rate(p.paraBlank, p.paraTotal);
    var parts = [chunk, para].filter(function (x) { return x != null; });
    var passage = parts.length
      ? parts.reduce(function (a, b) { return a + b; }, 0) / parts.length
      : null;
    return {
      word: word,
      interpret: rate(sen.interpreted, sen.total),
      memorize: rate(sen.memorized, sen.total),
      passage: passage,
      check: p.check ? rate(p.check.correct, p.check.total) : null,
      reached: rate(w.reached, w.total)
    };
  }

  /* 남은 날로 물리적으로 가능한가 — 예측이 아니라 제약(원칙 3).
     안정화는 서로 다른 날 RELEARN_TARGET 회라, 아직 도달하지 못한 단어는 최소 그만큼의
     '다른 날'이 필요하다. 남은 날이 그보다 적으면 그 몫은 확정된 미달이다. */
  function needDays(summary, opts) {
    var w = src(summary).word || {};
    var target = (opts && opts.relearnTarget != null) ? num(opts.relearnTarget) : RELEARN_TARGET;
    var untouched = Math.max(0, num(w.total) - num(w.reached));
    return { untouched: untouched, minDays: untouched ? target : 0 };
  }

  /* 학생 한 명의 준비도. summary 는 engine.rangeSummary 의 반환값 그대로.
     dday 는 시험까지 남은 날(없으면 null) — 제약 판정에만 쓴다. */
  function readiness(summary, opts) {
    var o = opts && typeof opts === 'object' ? opts : {};
    var r = ratios(summary);
    var ws = weights(r, o.weights);
    var score = 0, axes = [];
    AXES.forEach(function (a) {
      var ratio = r[a.key], w = ws[a.key] || 0;
      if (ratio != null && w) score += ratio * w;
      axes.push({
        key: a.key, label: a.label, act: a.act, hint: a.hint,
        ratio: ratio, weight: w,
        /* 재료가 없어 축에서 빠졌음을 화면이 구분할 수 있게 둔다 — 0% 로 그리면 거짓이다 */
        absent: ratio == null
      });
    });
    var need = needDays(summary, o);
    var dday = o.dday == null ? null : num(o.dday);
    return {
      score: pct(score),
      /* 가장 낮은, 그리고 재료가 있는 축 — "오늘 무엇을 할지"가 여기서 나온다 */
      weakest: weakest(axes),
      axes: axes,
      need: need,
      /* 남은 날이 안정화에 필요한 날보다 적으면 확정된 미달이다(추정 아님) */
      shortfall: (dday != null && need.minDays > dday)
        ? { minDays: need.minDays, dday: dday, untouched: need.untouched }
        : null
    };
  }

  /* 가장 낮은 축 = 다음 할 일. **진단 축은 고르지 않는다** — 그걸 해도 완성률이 안 오른다 */
  function weakest(axes) {
    var best = null;
    (axes || []).forEach(function (a) {
      if (a.absent || !a.weight) return;
      if (!best || a.ratio < best.ratio) best = a;
    });
    return best ? { key: best.key, label: best.label, act: best.act, ratio: best.ratio } : null;
  }

  /* 반 집계 — 파일럿 판정이 쓰는 값.
     rows: [{ code, name, cls, summary, dday?, startedAt? }]
     머리 숫자는 **임계 이상 학생 비율**(rate)이다. average·median 도 함께 돌려주므로
     원장이 다른 읽기로 판정할 수 있다(머리말의 '두 읽기'). */
  function classReadiness(rows, opts) {
    var o = opts && typeof opts === 'object' ? opts : {};
    var pass = o.passRate != null ? num(o.passRate) : PASS_RATE;
    var list = (Array.isArray(rows) ? rows : []).filter(Boolean).map(function (s) {
      var rd = readiness(s.summary, { dday: s.dday, weights: o.weights, relearnTarget: o.relearnTarget });
      return {
        code: String(s.code == null ? '' : s.code),
        name: String(s.name == null ? '' : s.name),
        cls: String(s.cls == null ? '' : s.cls),
        score: rd.score, weakest: rd.weakest, shortfall: rd.shortfall
      };
    });
    var n = list.length;
    var scores = list.map(function (x) { return x.score; }).sort(function (a, b) { return a - b; });
    var over = list.filter(function (x) { return x.score >= pct(pass); });
    return {
      n: n,
      threshold: pct(pass),
      /* 판정 머리 숫자 — 임계 이상 학생 비율 */
      rate: n ? Math.round(over.length * 100 / n) : null,
      reached: over.length,
      average: n ? Math.round(scores.reduce(function (a, b) { return a + b; }, 0) / n) : null,
      median: n ? (n % 2 ? scores[(n - 1) / 2] : Math.round((scores[n / 2 - 1] + scores[n / 2]) / 2)) : null,
      /* 확정된 미달 — 남은 날로 안정화가 불가능한 학생. 판정 전에 원장이 봐야 하는 수 */
      shortfall: list.filter(function (x) { return x.shortfall; }).length,
      /* 낮은 순 — 개입 순서다 */
      students: list.slice().sort(function (a, b) { return a.score - b.score; })
    };
  }

  /* 파일럿 판정 — 기획서 §12. "시험 2주 전 시작한 반" 이 대상이므로 시작 시점도 본다.
     startedDaysBefore 를 모르면 대상 여부를 **단정하지 않는다**(eligible: null). */
  function pilotVerdict(cls, startedDaysBefore, opts) {
    var o = opts && typeof opts === 'object' ? opts : {};
    var need = o.startDays != null ? num(o.startDays) : START_DAYS;
    var started = startedDaysBefore == null ? null : num(startedDaysBefore);
    var eligible = started == null ? null : started >= need;
    var r = cls && cls.rate != null ? cls.rate : null;
    return {
      eligible: eligible, startDays: need, startedDaysBefore: started,
      rate: r, threshold: cls ? cls.threshold : pct(PASS_RATE),
      /* 판정은 대상 여부가 확실하고 숫자가 있을 때만 — 모르면 null 로 남긴다 */
      passed: (eligible === true && r != null) ? (r >= (cls.threshold || pct(PASS_RATE))) : null
    };
  }

  function grade(score) {
    var s = num(score);
    if (s >= 85) return { key: 'ready', label: '준비됨' };
    if (s >= pct(PASS_RATE)) return { key: 'ontrack', label: '순조' };
    if (s >= 40) return { key: 'behind', label: '뒤처짐' };
    return { key: 'risk', label: '위험' };
  }

  function line(rd) {
    if (!rd) return '—';
    var g = grade(rd.score), w = rd.weakest;
    return rd.score + '% · ' + g.label + (w ? ' · 다음: ' + w.label : '');
  }

  return {
    AXES: AXES, RELEARN_TARGET: RELEARN_TARGET, PASS_RATE: PASS_RATE, START_DAYS: START_DAYS,
    W_STABLE: W_STABLE, W_INTERPRET: W_INTERPRET, W_BLANK: W_BLANK,
    weights: weights, ratios: ratios, needDays: needDays, src: src,
    readiness: readiness, classReadiness: classReadiness,
    pilotVerdict: pilotVerdict, grade: grade, line: line
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WBNAESINREADY;
