'use strict';
/* WB 워드브레인 — 기억 엔진 (순수 로직, 브라우저/Node 공용)
   기획서 §2.3: 간격 당일 밤 → 1일 → 3일 → 7일 → 14일 → 30일 → 90일.
   졸업 = 30일 간격 통과(step 6 도달) + 연속 성공 3회 + 서로 다른 맥락 3종. */
var WBSRS = (function () {
  var DAY = 86400000;
  var MIN10 = 600000;
  var INTERVAL_DAYS = [0, 1, 3, 7, 14, 30, 90];
  var GRADUATE_STEP = 6;

  function tonight(now) {
    var d = new Date(now);
    var t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 21, 0, 0, 0).getTime();
    return now < t ? t : now + MIN10; // 21시 이후 심으면 10분 뒤 첫 회상
  }

  function plant(id, now) {
    return {
      id: id, step: 0, due: tonight(now), plantedAt: now,
      reps: 0, lapses: 0, streak: 0, contexts: [],
      emaMs: null, exposures: 0, graduated: false, gradAt: null, last: null
    };
  }

  /* grade: 'fail'(몰랐어) | 'hard'(알쏭해) | 'good'(알았어) — context: 'review'|'flash'|'speed'|'plant' */
  function review(s, grade, now, context) {
    s.reps += 1; s.last = now;
    if (context && s.contexts.indexOf(context) < 0) s.contexts.push(context);
    if (grade === 'fail') {
      s.lapses += 1; s.streak = 0;
      s.step = Math.max(0, s.step - 2);
      s.due = now + MIN10;
    } else if (grade === 'hard') {
      s.streak = 0;
      s.due = now + DAY;
    } else {
      s.streak += 1;
      s.step = Math.min(s.step + 1, INTERVAL_DAYS.length - 1);
      s.due = now + Math.max(INTERVAL_DAYS[s.step], 1) * DAY;
      if (!s.graduated && s.step >= GRADUATE_STEP && s.streak >= 3 && s.contexts.length >= 3) {
        s.graduated = true; s.gradAt = now;
      }
    }
    return s;
  }

  function intervalMs(s) { return Math.max(INTERVAL_DAYS[s.step], 0.5) * DAY; }

  /* 0 싱싱 · 1 살짝 시듦 · 2 시듦 · 3 응급(바싹 마름) */
  function wither(s, now) {
    if (s.graduated) return 0;
    var over = now - s.due;
    if (over <= 0) return 0;
    var r = over / intervalMs(s);
    return r < 0.5 ? 1 : (r < 1.25 ? 2 : 3);
  }

  /* 시각 성장 단계 0새싹~5꽃, 6나무(졸업) */
  function stage(s) { return s.graduated ? 6 : Math.min(s.step, 5); }

  function values(states) {
    var out = [], k;
    for (k in states) if (Object.prototype.hasOwnProperty.call(states, k)) out.push(states[k]);
    return out;
  }

  function dueList(states, now) {
    return values(states)
      .filter(function (s) { return !s.graduated && s.due <= now; })
      .sort(function (a, b) { return ((now - a.due) / intervalMs(a)) < ((now - b.due) / intervalMs(b)) ? 1 : -1; });
  }

  function emergencies(states, now) {
    return values(states).filter(function (s) { return wither(s, now) >= 3; });
  }

  function sameDay(a, b) {
    var x = new Date(a), y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
  }

  function todayPlanted(states, now) {
    return values(states).filter(function (s) { return sameDay(s.plantedAt, now); });
  }

  /* 스피드 리콜 — 간격을 올리지 않는 보조 훈련. 성공 시 만기 전 단어에 한해 +6시간 보너스만. */
  function speedResult(s, ok, ms, now) {
    s.exposures += 1;
    if (ms > 0) s.emaMs = s.emaMs == null ? Math.round(ms) : Math.round(s.emaMs * 0.6 + ms * 0.4);
    if (ok && !s.graduated && s.due > now) s.due += 6 * 3600000;
    return s;
  }

  function exposure(s) { s.exposures += 1; return s; }

  /* 데모용 시간 이동 — 모든 시각을 days일 과거로 밀어 "시간이 흐른" 상태를 만든다 */
  function shiftTime(states, days) {
    var ms = days * DAY;
    values(states).forEach(function (s) {
      s.plantedAt -= ms; s.due -= ms;
      if (s.last != null) s.last -= ms;
      if (s.gradAt != null) s.gradAt -= ms;
    });
    return states;
  }

  function summary(states, now) {
    var list = values(states);
    var out = { total: list.length, graduated: 0, due: 0, emergency: 0, seed: 0, growing: 0, msAvg: null, byType: {} };
    var msSum = 0, msN = 0;
    list.forEach(function (s) {
      if (s.graduated) out.graduated += 1;
      else if (s.step <= 1) out.seed += 1;
      else out.growing += 1;
      if (!s.graduated && s.due <= now) out.due += 1;
      if (wither(s, now) >= 3) out.emergency += 1;
      if (s.emaMs != null) { msSum += s.emaMs; msN += 1; }
    });
    if (msN > 0) out.msAvg = Math.round(msSum / msN);
    return out;
  }

  return {
    DAY: DAY, INTERVAL_DAYS: INTERVAL_DAYS, GRADUATE_STEP: GRADUATE_STEP,
    tonight: tonight, plant: plant, review: review, intervalMs: intervalMs,
    wither: wither, stage: stage, dueList: dueList, emergencies: emergencies,
    todayPlanted: todayPlanted, speedResult: speedResult, exposure: exposure,
    shiftTime: shiftTime, summary: summary, sameDay: sameDay
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WBSRS;
