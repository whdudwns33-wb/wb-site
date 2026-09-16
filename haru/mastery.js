'use strict';
/* 좌표 추정 — 찍기 보정 Beta-이항 + 문항 재사용 감쇠 + 분산 팽창. 전면 IRT 는 쓰지 않는다(보정할 데이터가 없다).
   'unknown' 이 1급 상태다: 실관측(obs)이 MIN_OBS 미만이면 아무 말도 하지 않는다 — 사전이 아니라 관측으로 센다. */
var WBHARU_M = (function () {
  var GUESS = { mcq4: 0.25, mcq5: 0.20, mcq2: 0.5, write: 0 };
  var HALF_DAYS = 21;                    // 파이널 반감기. 초4·초5 국면은 60 — 방학을 지나면 CI 가 넓어져 probe 가 자연히 되돌아온다
  var PRIOR_K = 2;
  var MIN_OBS = 3;                       // 이보다 적으면 unknown
  var MIN_FLUENT_OBS = 8;
  var FLUENT_P = 0.80, HOLE_P = 0.40;    // 찍기 보정 추정기에서 0.85 는 10회 이상을 요구해 구조적으로 도달 불가였다
  var SEEN_W = [1, 0.5, 0.25, 0.15];     // 같은 문항 1·2·3·4회차의 증거력 — 2회차부터는 인출이 아니라 재인이다

  function create(now, prior) {
    var a0 = prior ? prior.a0 : 1, b0 = prior ? prior.b0 : 1;
    return { a: a0, b: b0, obs: 0, ok: 0, seen: {}, lastAt: now || null, medMs: null, ctx: [] };
  }

  /* 정답의 증거력 = 1-g, 오답의 증거력 = 1.0. 4지선다에서 정답이 오답의 3/4 밖에 안 되는 것이 이 앱의 겸손이다.
     관측 정답률 c 에 대한 기대값: p̂ = 0.75c / (0.75c + (1-c)) → c=0.8 → 0.75, c=0.4 → 0.33.
     그래서 유창 임계 p≥0.80 은 관측 정답률 약 0.84, 구멍 임계 p≤0.40 은 약 0.47 에 해당한다 (찍기 25% 를 뺀 자리). */
  function observe(s, obs, now) {
    if (!obs || obs.retake) return s;                          // 동결 세트 재응시는 좌표에 넣지 않는다 (재탕은 실력이 아니다)
    var g = GUESS[obs.form] != null ? GUESS[obs.form] : 0.25;
    var seen = (s.seen && s.seen[obs.itemId]) || 0;
    var wSeen = SEEN_W[Math.min(seen, SEEN_W.length - 1)];
    var wCtx = (obs.mixed ? 1.0 : 0.55) * (obs.cue > 0 ? 0.4 : 1.0);   // 단서 있는 정답·블록 정답은 증거력이 낮다
    var w = wSeen * wCtx;
    if (obs.ok) { s.a += w * (1 - g); s.ok = (s.ok || 0) + w; } else { s.b += w * 1.0; }
    s.obs = (s.obs || 0) + w;
    if (!s.seen) s.seen = {};
    if (obs.itemId) s.seen[obs.itemId] = seen + 1;
    if (!s.ctx) s.ctx = [];
    var c = obs.mixed ? 'mixed' : 'block';
    if (s.ctx.indexOf(c) < 0) s.ctx.push(c);
    if (typeof obs.ms === 'number') s.medMs = s.medMs == null ? obs.ms : Math.round(s.medMs * 0.6 + obs.ms * 0.4);
    s.lastAt = now;
    return s;
  }

  /* 선수 전파는 '사전'에만 쓴다. 판정(grade)에는 절대 쓰지 않는다 —
     손댄 적 없는 칸들이 첫날부터 구멍으로 칠해진 격자를 12살에게 보이면 안 된다. */
  function minPrereqP(atom, states, now, halfDays) {
    var m = 0.5;
    (atom.prereq || []).forEach(function (id) {
      var s = states[id]; if (!s || (s.obs || 0) < MIN_OBS) return;
      m = Math.min(m, p(s, now, halfDays));
    });
    return m;
  }
  function prior(atom, states, now, halfDays) {
    var m = minPrereqP(atom, states, now, halfDays);
    return { a0: 1 + PRIOR_K * m, b0: 1 + PRIOR_K * (1 - m) };
  }

  /* 망각을 a/b 삭감이 아니라 '분산 팽창'으로 — 평균은 보존하고 신뢰구간만 넓힌다.
     삭감하면 probe 의 H 항과 합쳐져 모든 칸이 p≈0.5 에 고정되는 항상성 루프가 생긴다. */
  function inflated(s, now, halfDays) {
    var h = halfDays || HALF_DAYS;
    var age = s.lastAt == null ? 0 : Math.max(0, (now - s.lastAt));
    var k = 1 + age / (h * 86400000);
    var n = s.a + s.b, pv = s.a / n;
    var n2 = 2 + (n - 2) / k;                 // 농도만 줄인다 — a·b 를 따로 깎으면 평균이 0.5 로 끌려간다
    return { a: pv * n2, b: (1 - pv) * n2 };
  }
  function p(s, now, halfDays) { var d = inflated(s, now, halfDays); return d.a / (d.a + d.b); }
  function varOf(s, now, halfDays) { var d = inflated(s, now, halfDays), n = d.a + d.b; return (d.a * d.b) / (n * n * (n + 1)); }
  function ci95(s, now, halfDays) { return 1.96 * Math.sqrt(varOf(s, now, halfDays)); }

  /* 4상태 + observed-only. medMs 는 게이트에 없다 — 합격권 학생에게 시간은 구속 조건이 아니고, 속도는 국면 ③부터 보조 표시다. */
  function grade(s, atom, now, halfDays) {
    if (atom && atom.teach === 'paper') return 'observed-only';
    if (!s || (s.obs || 0) < MIN_OBS) return 'unknown';
    var pv = p(s, now, halfDays);
    if (pv >= FLUENT_P && s.obs >= MIN_FLUENT_OBS && (s.ctx || []).indexOf('mixed') >= 0) return 'fluent';
    if (pv <= HOLE_P) return 'hole';
    return 'shaky';
  }

  /* 습관 원자(r-oneread) — MCQ 가 아니라 비율 관측. 같은 4상태 어휘로 돌려준다. */
  function gradeHabit(rate, n) {
    if (n == null || n < MIN_OBS) return 'unknown';
    if (rate >= FLUENT_P && n >= MIN_FLUENT_OBS) return 'fluent';
    if (rate <= HOLE_P) return 'hole';
    return 'shaky';
  }

  function mapOf(states, atoms, now, halfDays) {
    return (atoms || []).map(function (a) {
      var s = states[a.id];
      var g = grade(s, a, now, halfDays);
      return { id: a.id, subject: a.subject, label: a.label, grade: g,
               p: s && (s.obs || 0) >= MIN_OBS ? Math.round(p(s, now, halfDays) * 100) / 100 : null,
               obs: s ? Math.round((s.obs || 0) * 10) / 10 : 0, ok: s ? Math.round((s.ok || 0) * 10) / 10 : 0,
               ci: s && (s.obs || 0) >= MIN_OBS ? Math.round(ci95(s, now, halfDays) * 100) / 100 : null };
    });
  }

  return { create: create, observe: observe, prior: prior, inflated: inflated, p: p, varOf: varOf, ci95: ci95, grade: grade, gradeHabit: gradeHabit, mapOf: mapOf,
           GUESS: GUESS, HALF_DAYS: HALF_DAYS, PRIOR_K: PRIOR_K, MIN_OBS: MIN_OBS, MIN_FLUENT_OBS: MIN_FLUENT_OBS, FLUENT_P: FLUENT_P, HOLE_P: HOLE_P, SEEN_W: SEEN_W };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WBHARU_M;
