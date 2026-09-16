'use strict';
/* 카드 상태기계 — naesin/engine.js 단어 상태기계의 개념 포크 (require 불가: IIFE private).
   3년 지평이라 간격 사다리에 30·60·120일이 있고, 파이널에서는 cap = dday × 0.35 가 자동으로 압축한다.
   마감 압축은 하드캡이 아니라 '처리량 역산' — 간격은 '한 바퀴에 필요한 최소 날수'(활성 카드 ÷ 하루 슬롯) 아래로 절대 안 내려간다.
   0.2 캡을 매 복습마다 걸면 D-3 에 due 가 하루 70장으로 폭발하고 그 구간이 하필 '정착·감량' P4 다. */
var WBHARU_R = (function () {
  var DAY = 86400000;
  var INTERVAL_DAYS = [0.5, 2, 5, 9, 14, 30, 60, 120];
  var CRITERION_GAP_MS = 8 * 3600000;    // 같은 날 두 번은 한 번이다 (naesin 그대로)
  var RELEARN_TARGET = 3;                // 서로 다른 3일
  var CUE_MAX = 3;                       // 3 전문 → 2 첫 줄+수치 → 1 첫 줄 → 0 조건만
  var CUE_STAGES = [1, 3];               // 단서가 있는 단계
  var STAGE_MAX = 4;                     // 1 완전 풀이 · 2 순서 세우기 · 3 조건만(블록) · 4 혼동 짝 혼합
  var ADVANCE_STREAK = 3;
  var DDAY_CAP = 0.35;
  var FAIL_BACK = 2;

  function createCard(now, reached) {
    return { step: 0, due: now, streak: 0, wrong: 0, lapses: 0, relearnCount: 0, lastCriterionDate: null, lastCriterionAt: null,
             stage: reached ? 3 : 1, cue: reached ? 0 : CUE_MAX, needsRecheck: false, ctx: [], reached: !!reached, overconfident: 0 };
  }
  function localDate(now) { return new Date(now + 9 * 3600000).toISOString().slice(0, 10); }
  function dayStart(now) { var d = new Date(now + 9 * 3600000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 9 * 3600000; }
  function isCueStage(stage) { return CUE_STAGES.indexOf(stage) >= 0; }

  /* ctx: { dday (null 이면 cap 없음 — 국면 ①·②), active (활성 카드 수), slots (하루 슬롯) } */
  function nextDue(step, now, ctx) {
    ctx = ctx || {};
    var want = INTERVAL_DAYS[Math.min(Math.max(step, 0), INTERVAL_DAYS.length - 1)];
    var floor = Math.max(1, (ctx.active || 1) / (ctx.slots || 1));
    var cap = (ctx.dday != null && ctx.dday > 0) ? Math.max(floor, ctx.dday * DDAY_CAP) : Infinity;
    var t = now + Math.min(Math.max(want, floor), cap) * DAY;
    /* 분산 배치 — 같은 날에 due 가 슬롯보다 많이 몰리면 그날부터 며칠 안의 빈 날로 민다.
       처리량 역산(floor)은 평균만 보장하고 몰리는 날을 못 막는다. dueCounts 는 호출자가 {ymd:count} 로 넘기고 여기서 갱신한다. */
    if (ctx.dueCounts && ctx.slots) {
      var spread = ctx.spreadDays == null ? 5 : ctx.spreadDays, best = 0, bestCnt = Infinity;
      for (var off = 0; off <= spread; off++) {
        var cnt = ctx.dueCounts[localDate(t + off * DAY)] || 0;
        if (cnt < ctx.slots) { best = off; break; }
        if (cnt < bestCnt) { bestCnt = cnt; best = off; }      // 전부 찼으면 가장 덜 찬 날
      }
      var key = localDate(t + best * DAY);
      ctx.dueCounts[key] = (ctx.dueCounts[key] || 0) + 1;
      return dayStart(t + best * DAY);          // 그 날짜의 0시로 스냅 — 그날 몇 시에 앉든 due 다. 23:00 due 가 다음 날로 밀리며 몰리는 것을 막는다
    }
    return t;
  }

  /* 정답 — 단계·단서·간격을 올린다. 4지선다 정답에는 needsRecheck 를 세운다(25%는 그냥 맞는다) — recheck 가 통과할 때까지 isDone 이 아니다.
     o: { now, mixed, form, dday, active, slots } */
  function recordOk(c, o) {
    o = o || {};
    c.streak += 1;
    if (o.form === 'mcq4' || o.form === 'mcq5' || o.form == null) c.needsRecheck = true;
    var ctxName = o.mixed ? 'mixed' : 'block';
    if (c.ctx.indexOf(ctxName) < 0) c.ctx.push(ctxName);
    if (c.cue > 0 && c.streak >= 2) c.cue -= 1;                     // 단서는 연속 정답에 한 칸씩 걷힌다
    if (c.stage < STAGE_MAX && c.streak >= ADVANCE_STREAK) { c.stage += 1; c.streak = 0; c.cue = isCueStage(c.stage) ? Math.min(c.cue, 1) : 0; }
    if (c.stage >= STAGE_MAX && o.mixed) criterionSuccess(c, o.now);   // 혼합에서 맞힌 것만 도달로 센다
    c.step = Math.min(c.step + 1, INTERVAL_DAYS.length - 1);
    c.due = nextDue(c.step, o.now, o);
    return c;
  }

  /* 도달 = 4단계에서 혼합 정답. 서로 다른 날 3회(8시간 간격)면 안정화. */
  function criterionSuccess(c, now) {
    var today = localDate(now);
    if (c.lastCriterionDate !== today && (c.lastCriterionAt == null || now - c.lastCriterionAt >= CRITERION_GAP_MS)) {
      c.relearnCount = Math.min(RELEARN_TARGET, c.relearnCount + 1);
      c.lastCriterionDate = today; c.lastCriterionAt = now;
      c.reached = true;
    }
    return c;
  }

  /* 오답 — 2계단 후퇴, 단서 한 칸 더, 반나절 뒤 재출제. 단계는 유지한다(사다리는 한 칸씩만 오르고 내려가지 않는다 — 위음성이 위양성보다 비싸다). */
  function fail(c, o) {
    o = o || {};
    c.step = Math.max(0, c.step - FAIL_BACK);
    c.streak = 0; c.wrong += 1; c.lapses += 1;
    c.needsRecheck = false;
    if (isCueStage(c.stage)) c.cue = Math.min(CUE_MAX, c.cue + 1);
    c.due = o.now + INTERVAL_DAYS[0] * DAY;
    return c;
  }
  function recordCue(c) { c.cue = Math.min(CUE_MAX, c.cue + 1); return c; }
  /* "왜 나머지 3개가 아닌지 1개 고르기" 통과 → 재확인 해제. 실패면 자신감 과잉으로 기록하고 한 계단 후퇴. */
  function recheck(c, ok, o) {
    if (ok) { c.needsRecheck = false; return c; }
    c.overconfident += 1; c.step = Math.max(0, c.step - 1); c.due = (o && o.now || 0) + INTERVAL_DAYS[0] * DAY;
    return c;
  }
  /* 진단에서 이미 도달한 원자는 3단계에서 시작 — 전문가 역전 */
  function applyDiagnostic(c, reached) { if (reached) { c.stage = Math.max(c.stage, 3); c.cue = 0; c.reached = true; } return c; }

  function graduated(c) { return c.relearnCount >= RELEARN_TARGET && c.ctx.length >= 2; }
  function isDone(c) { return graduated(c) && !c.needsRecheck; }
  function isDue(c, now) { return c.due <= now; }

  return { DAY: DAY, INTERVAL_DAYS: INTERVAL_DAYS, CRITERION_GAP_MS: CRITERION_GAP_MS, RELEARN_TARGET: RELEARN_TARGET, CUE_MAX: CUE_MAX, STAGE_MAX: STAGE_MAX, DDAY_CAP: DDAY_CAP,
           createCard: createCard, nextDue: nextDue, recordOk: recordOk, fail: fail, recordCue: recordCue, recheck: recheck, criterionSuccess: criterionSuccess,
           applyDiagnostic: applyDiagnostic, isCueStage: isCueStage, graduated: graduated, isDone: isDone, isDue: isDue, localDate: localDate, dayStart: dayStart };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WBHARU_R;
