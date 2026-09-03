'use strict';
/* WB 국어브레인 — 준비도 산출 (순수 로직, 브라우저/Node 공용)
   기획서 §11 North Star("시험 범위 완성률")를 **한 숫자와 그 분해**로 바꾼 모듈.

   왜 따로 두나: engine.js의 workSummary/kindSummary는 '몇 개'를 센다. 원장이 보고 싶은 것은
   "이 학생이 이번 시험에 몇 % 준비됐나"이고, 그건 개수가 아니라 **가중 합**이다.
   가중치를 engine에 넣으면 학습 스케줄러가 평가 정책을 알게 되어 둘이 같이 흔들린다.

   설계 원칙 셋:
   1. 축은 사다리 5단계와 1:1 — 점수가 낮으면 **오늘 무엇을 할지가 바로 나온다**.
      "준비도 62%"만 있는 지표는 행동을 안 바꾼다.
   2. 가중치는 학교 시험의 실제 배점에서 온다 — 서술형 배점 40%인 학교면 준비도에서도 40%.
      임의의 상수가 아니라 평가계획에서 옮겨 적은 값이어야 강사가 학생에게 설명할 수 있다.
   3. 전망은 예측이 아니라 **제약**이다. 안정화는 '서로 다른 날 3회전'이라 오늘 처음 만난
      빈칸은 물리적으로 최소 4일이 걸린다. D-3에 미착수 빈칸이 남았으면 그건 추정이 아니라
      확정된 미달이다 — 그 사실을 숫자로 내보낸다.

   engine.js의 상수를 다시 적지 않고 주입받는다. 기본값이 engine과 어긋나면 테스트가 잡는다. */
var WBKOREADY = (function () {
  var RELEARN_TARGET = 3;      // engine.RELEARN_TARGET 과 같아야 한다(테스트가 고정)
  var APPLY_GATE_RATE = 0.8;   // engine.APPLY_GATE_RATE 과 같아야 한다
  var APPLY_MIN = 4;           // 적용 정답률을 믿기 위한 최소 시도 수 — 2문항 100%는 100%가 아니다
  var ESSAY_BASE = 0.15;       // 서술형 기본 가중(학교 배점을 모를 때)

  /* 축 = 사다리 5단계 + 어휘. 합 1.00 */
  var AXES = [
    { key: 'read', label: '작품 읽기', w: 0.10, act: '작품 탭에서 1단계 읽기',
      hint: '1단계 읽기를 끝낸 작품 비율' },
    { key: 'blank', label: '개념 빈칸', w: 0.22, act: '오늘 탭의 개념 빈칸 큐',
      hint: '도달하면 절반, 서로 다른 날 3회전을 채우면 만점' },
    { key: 'vocab', label: '어휘·개념어', w: 0.10, act: '오늘 탭의 어휘 큐',
      hint: '도달하면 절반, 서로 다른 날 3회전을 채우면 만점' },
    { key: 'apply', label: '구절 적용', w: 0.26, act: '작품 탭 3단계 구절 적용',
      hint: '적용 정답률 ÷ 게이트 기준선. 시도가 적으면 그만큼 낮게 잡는다' },
    { key: 'restore', label: '주석 복원', w: 0.17, act: '작품 탭 4단계 주석 복원',
      hint: '4단계 주석 복원을 통과한 작품 비율' },
    { key: 'essay', label: '서술형', w: ESSAY_BASE, act: '작품 탭 5단계 서술형',
      hint: '5단계 서술형 루브릭을 통과한 작품 비율' }
  ];

  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function pct(x) { return Math.round(clamp(x, 0, 1) * 100); }

  /* 학교 서술형 배점이 있으면 그 값이 곧 서술형 축의 가중치가 되고, 나머지는 비례로 줄인다.
     "왜 이 비중이냐"는 물음의 답이 평가계획 종이 한 장이 되게 하려는 것이다. */
  function weights(essayWeight) {
    var out = {}, i;
    if (essayWeight == null || !isFinite(essayWeight)) {
      for (i = 0; i < AXES.length; i++) out[AXES[i].key] = AXES[i].w;
      return out;
    }
    var ew = clamp(essayWeight, 0.05, 0.45);
    var scale = (1 - ew) / (1 - ESSAY_BASE);
    for (i = 0; i < AXES.length; i++) {
      out[AXES[i].key] = AXES[i].key === 'essay' ? ew : AXES[i].w * scale;
    }
    return out;
  }

  /* 2층 암기 모델의 항목 점수 — 도달만으로는 절반이다(§4.2).
     도달 0.5 + 안정화 회전당 나머지를 나눠 준다. */
  function itemScore(s, target) {
    if (!s || !s.reached) return 0;
    var r = Math.min(s.relearnCount || 0, target);
    return 0.5 + 0.5 * (target ? r / target : 1);
  }

  /* 안정화까지 남은 **서로 다른 날**의 수. 같은 날 여러 번 맞혀도 1회전이라
     이건 노력으로 줄일 수 없는 하한이다 — 전망의 근거가 여기서 나온다. */
  function needDays(s, target) {
    if (!s || !s.reached) return target + 1;              // 도달 하루 + 회전 3일
    return Math.max(0, target - (s.relearnCount || 0));
  }

  function mean(list) {
    if (!list.length) return 0;
    var i, sum = 0;
    for (i = 0; i < list.length; i++) sum += list[i];
    return sum / list.length;
  }

  /* 준비도 본체.
     pack: {works:[{workId,title,vocab:[{id}],blanks:[{id}]}]}
     states: engine 상태 맵, opts: {exam, dday, applyGateRate, essayWeight, relearnTarget, wrongOpen} */
  function readiness(pack, states, opts) {
    opts = opts || {};
    states = states || {};
    var target = opts.relearnTarget == null ? RELEARN_TARGET : opts.relearnTarget;
    var gateRate = opts.applyGateRate == null ? APPLY_GATE_RATE : opts.applyGateRate;
    var essayWeight = opts.essayWeight;
    if (essayWeight == null && opts.exam && opts.exam.profile) essayWeight = opts.exam.profile.essayWeight;
    var W = weights(essayWeight);
    var weightSource = (essayWeight == null || !isFinite(essayWeight)) ? 'default' : 'exam';
    var works = (pack && pack.works) || [];

    var readList = [], applyList = [], restoreList = [], essayList = [];
    var blankScores = [], vocabScores = [];
    var rotations = 0, minDays = 0, untouched = 0, risky = 0;
    var workRows = [];

    works.forEach(function (w) {
      var ws = states['w-' + w.workId];
      var stage = ws ? ws.stage : 1;
      var aTotal = (ws && ws.applyTotal) || 0, aRight = (ws && ws.applyRight) || 0;
      var aRate = aTotal ? aRight / aTotal : 0;
      /* 적용 축은 게이트 기준선까지가 만점이다. 시도가 적으면 그만큼 깎는다 — 표본이 곧 신뢰다. */
      var aScore = aTotal ? clamp(aRate / gateRate, 0, 1) * Math.min(aTotal / APPLY_MIN, 1) : 0;
      readList.push(stage >= 2 ? 1 : 0);
      applyList.push(aScore);
      restoreList.push(ws && ws.reached ? 1 : 0);
      essayList.push(ws && ws.essayDone ? 1 : 0);
      if (!ws) untouched += 1;

      var own = [];
      (w.blanks || []).forEach(function (b) {
        var s = states['b-' + b.id];
        var sc = itemScore(s, target);
        blankScores.push(sc); own.push(sc);
        var nd = needDays(s, target);
        rotations += nd; if (nd > minDays) minDays = nd;
        if (s && (s.wrong >= 3 || s.overconfident > 0)) risky += 1;
      });
      (w.vocab || []).forEach(function (v) {
        var s = states['v-' + v.id];
        var sc = itemScore(s, target);
        vocabScores.push(sc);
        var nd = needDays(s, target);
        rotations += nd; if (nd > minDays) minDays = nd;
        if (s && (s.wrong >= 3 || s.overconfident > 0)) risky += 1;
      });

      workRows.push({
        workId: w.workId, title: w.title || w.workId, stage: stage,
        applyRate: aRate, applyTotal: aTotal, restored: !!(ws && ws.reached),
        essayDone: !!(ws && ws.essayDone), blank: pct(mean(own)),
        score: pct(0.25 * (stage >= 2 ? 1 : 0) + 0.25 * mean(own) + 0.2 * aScore +
          0.15 * (ws && ws.reached ? 1 : 0) + 0.15 * (ws && ws.essayDone ? 1 : 0))
      });
    });

    var rate = {
      read: mean(readList), blank: mean(blankScores), vocab: mean(vocabScores),
      apply: mean(applyList), restore: mean(restoreList), essay: mean(essayList)
    };
    /* 범위에 없는 축은 점수를 깎지 않는다 — 어휘가 0개인 팩에서 어휘 0%로 감점하면 거짓말이다.
       빠진 축의 가중치는 남은 축에 비례 배분한다. */
    var have = {
      read: works.length > 0, blank: blankScores.length > 0, vocab: vocabScores.length > 0,
      apply: works.length > 0, restore: works.length > 0, essay: works.length > 0
    };
    var live = 0;
    AXES.forEach(function (a) { if (have[a.key]) live += W[a.key]; });
    var norm = live > 0 ? 1 / live : 0;

    var parts = AXES.map(function (a) {
      var weight = have[a.key] ? W[a.key] * norm : 0;
      return {
        key: a.key, label: a.label, act: a.act, hint: a.hint,
        weight: weight, rate: rate[a.key],
        points: weight * rate[a.key] * 100,
        lost: weight * (1 - rate[a.key]) * 100,
        n: a.key === 'blank' ? blankScores.length : (a.key === 'vocab' ? vocabScores.length : works.length)
      };
    });
    var score = 0;
    parts.forEach(function (p) { score += p.points; });
    score = Math.round(score);

    var weak = nextAxis(parts, rate);

    var dday = opts.dday;
    if (dday == null && opts.exam && opts.exam.examDate && opts.now != null) dday = daysUntil(opts.exam.examDate, opts.now);
    var pace = null;
    if (dday != null) {
      var days = Math.max(1, dday);
      pace = {
        dday: dday, minDays: minDays, rotations: rotations,
        perDay: Math.ceil(rotations / days),
        onTrack: minDays <= dday
      };
    }

    return {
      score: score, grade: grade(score), parts: parts, weak: weak, weightSource: weightSource,
      works: workRows,
      totals: {
        works: works.length, blanks: blankScores.length, vocab: vocabScores.length,
        untouched: untouched, risky: risky,
        wrongOpen: opts.wrongOpen == null ? null : opts.wrongOpen
      },
      pace: pace,
      alert: alertOf(score, pace, untouched, works.length, opts.wrongOpen)
    };
  }

  function daysUntil(ymd, now) {
    var p = String(ymd || '').split('-');
    var t = new Date(+p[0], +p[1] - 1, +p[2]).getTime();
    var d = new Date(now);
    return Math.round((t - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
  }

  /* 오늘 손댈 축 — **가장 많이 잃은 축**이되 사다리에서 열려 있는 것 중에서 고른다.
     아무것도 안 한 학생에게 '구절 적용'이라고 말하면(가중치가 가장 크므로) 지시가 틀린다.
     3단계 적용은 1단계 읽기 없이는 못 한다(§4.1). 앞 단계가 반쯤 차야 다음이 열린다. */
  var PREREQ = { read: null, blank: 'read', vocab: 'read', apply: 'blank', restore: 'apply', essay: 'restore' };
  function nextAxis(parts, rate) {
    var open = [], any = null;
    parts.forEach(function (p) {
      if (!p.weight || p.rate >= 1) return;
      if (!any || p.lost > any.lost + 1e-9) any = p;
      var req = PREREQ[p.key];
      if (req == null || rate[req] >= 0.5) open.push(p);
    });
    var best = null;
    open.forEach(function (p) { if (!best || p.lost > best.lost + 1e-9) best = p; });
    return (best || any) ? (best || any).key : null;
  }

  function grade(score) {
    if (score >= 85) return { key: 'ready', label: '시험 준비 완료' };
    if (score >= 70) return { key: 'ontrack', label: '궤도에 있음' };
    if (score >= 45) return { key: 'building', label: '쌓는 중' };
    return { key: 'start', label: '시작 단계' };
  }

  /* 강사 화면의 신호등. **가장 이른 확정 미달을 먼저** 말한다 — 남은 날이 부족한 것은
     노력 부족과 다르고, 대응(범위 축소·병행 모드)도 다르기 때문이다. */
  function alertOf(score, pace, untouched, works, wrongOpen) {
    if (pace && !pace.onTrack) {
      return { level: 'risk', why: '안정화에 최소 ' + pace.minDays + '일이 필요한데 D-' + pace.dday + '입니다. 범위를 줄이거나 병행 모드를 켜세요.' };
    }
    if (pace && pace.dday <= 7 && score < 60) {
      return { level: 'risk', why: 'D-' + pace.dday + '에 준비도 ' + score + '%입니다. 실전 문항보다 개념 빈칸을 먼저 돌리세요.' };
    }
    if (untouched > 0 && pace && pace.dday <= 14) {
      return { level: 'watch', why: '손대지 않은 작품 ' + untouched + '/' + works + '편이 남았습니다.' };
    }
    if (pace && pace.perDay >= 45) {
      return { level: 'watch', why: '남은 회전을 맞추려면 하루 ' + pace.perDay + '개입니다. 부담이 큽니다.' };
    }
    if (wrongOpen != null && wrongOpen >= 10) {
      return { level: 'watch', why: '정리 안 된 오답이 ' + wrongOpen + '개입니다.' };
    }
    return null;
  }

  /* 관리 화면이 학생 요약 목록을 반 그림으로 바꾼다.
     rows: [{code,name,cls,summary:{ready:{score,weak,alert,grade}}}] — 서버는 요약만 읽는다(§8). */
  function classReadiness(rows) {
    var scores = [], weak = {}, risk = [], watch = [], linked = 0;
    (rows || []).forEach(function (r) {
      var rd = r && r.summary && r.summary.ready;
      if (!rd || typeof rd.score !== 'number') return;
      linked += 1;
      scores.push(rd.score);
      if (rd.weak) weak[rd.weak] = (weak[rd.weak] || 0) + 1;
      if (rd.alert && rd.alert.level === 'risk') risk.push({ code: r.code, name: r.name || r.code, why: rd.alert.why });
      else if (rd.alert && rd.alert.level === 'watch') watch.push({ code: r.code, name: r.name || r.code, why: rd.alert.why });
    });
    var sorted = scores.slice().sort(function (a, b) { return a - b; });
    var weakTop = [];
    AXES.forEach(function (a) { if (weak[a.key]) weakTop.push({ key: a.key, label: a.label, n: weak[a.key] }); });
    weakTop.sort(function (a, b) { return b.n - a.n; });
    return {
      n: (rows || []).length, linked: linked,
      avg: scores.length ? Math.round(mean(scores)) : null,
      median: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null,
      low: sorted.length ? sorted[0] : null,
      high: sorted.length ? sorted[sorted.length - 1] : null,
      dist: {
        start: scores.filter(function (s) { return s < 45; }).length,
        building: scores.filter(function (s) { return s >= 45 && s < 70; }).length,
        ontrack: scores.filter(function (s) { return s >= 70 && s < 85; }).length,
        ready: scores.filter(function (s) { return s >= 85; }).length
      },
      weakTop: weakTop, risk: risk, watch: watch
    };
  }

  /* 관리 화면·학생 화면이 같은 문장을 쓰게 하려고 여기서 만든다 */
  function line(rd) {
    if (!rd) return '기록 없음';
    var w = null;
    (rd.parts || []).forEach(function (p) { if (p.key === rd.weak) w = p; });
    return rd.score + '% · ' + rd.grade.label + (w ? ' · 다음: ' + w.label : '');
  }

  return {
    AXES: AXES, RELEARN_TARGET: RELEARN_TARGET, APPLY_GATE_RATE: APPLY_GATE_RATE,
    APPLY_MIN: APPLY_MIN, ESSAY_BASE: ESSAY_BASE,
    weights: weights, itemScore: itemScore, needDays: needDays,
    readiness: readiness, classReadiness: classReadiness, grade: grade, line: line
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WBKOREADY;
