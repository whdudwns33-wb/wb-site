'use strict';
/* 코호트 달력 — 이 앱의 분모. 콘텐츠 양이 아니라 날짜가 분모라서 팩이 늘어도 학생 부담이 안 늘고, 상태가 비어도 카드가 사라지지 않는다.
   시각은 전부 KST 고정으로 계산한다 — 워커(UTC)와 태블릿(로컬)이 같은 날짜를 봐야 하고, naesin/engine.js 의 localDate 는 실행 환경 시간대를 탄다. */
var WBHARU_P = (function () {
  var DAY = 86400000, KST = 9 * 3600000;
  var MIX = {                                   // 슬롯 배합 (다시 만날 칸 / 굳히는 중 / 처음 보는 칸)
    p1: { hole: 1, shaky: 0, probe: 2 },        // 초4 — 블록 기본값, 프로브 중심
    p2: { hole: 1, shaky: 1, probe: 1 },
    p3: { hole: 1, shaky: 1, probe: 1 },
    p4: { rebuild: { hole: 1, shaky: 0, probe: 2 }, mix: { hole: 1, shaky: 1, probe: 1 }, narrow: { hole: 1, shaky: 2, probe: 0 }, settle: { hole: 0, shaky: 3, probe: 0 } },
    p5: { hole: 0, shaky: 0, probe: 0 }
  };
  var DAILY = { p1: 10, p2: 15, p3: 20, p4: 15, p5: 0 };

  function ms(now) { return typeof now === 'number' ? now : (now instanceof Date ? now.getTime() : Date.parse(now)); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function kstDate(now) { return new Date(ms(now) + KST).toISOString().slice(0, 10); }
  function kstAt(ymd, hhmm) {
    var p = String(ymd).split('-'), h = String(hhmm || '00:00').split(':');
    return Date.UTC(+p[0], +p[1] - 1, +p[2], +h[0] - 9, +h[1] || 0);
  }
  function daysUntil(ymd, now) { return Math.round((kstAt(ymd, '00:00') - kstAt(kstDate(now), '00:00')) / DAY); }
  function dday(plan, now) { return daysUntil(plan.examDate, now); }
  function isMonday(now) { return new Date(ms(now) + KST).getUTCDay() === 1; }
  /* ISO 주차 'YYYY-Www' — weekly[] 스냅샷과 haru:agg 키 */
  function weekKey(now) {
    var d = new Date(ms(now) + KST); d.setUTCHours(0, 0, 0, 0);
    var day = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() + 4 - day);
    var y0 = Date.UTC(d.getUTCFullYear(), 0, 1);
    return d.getUTCFullYear() + '-W' + pad(Math.ceil(((d - y0) / DAY + 1) / 7));
  }

  /* 시험일 12:00 KST 부터 잠긴다 — 발표 다음 날 아침 "오늘 학습을 시작하세요"가 이 앱이 할 수 있는 가장 잔인한 일이다. */
  function isLocked(plan, now) { return ms(now) >= kstAt(plan.examDate, plan.lockAt || '12:00'); }
  function retroEndAt(plan) { return kstAt(plan.examDate, '00:00') + (plan.retainDays || 30) * DAY; }
  function isRetro(plan, now) { var t = ms(now); return t >= kstAt(plan.examDate, '00:00') + DAY && t < retroEndAt(plan); }
  /* 숫자(정답률·완주 횟수·되감기)는 발표 뒤 48시간 = 시험일 + 7일 16:00 KST 에 열린다 (2027: 11/1 16:00). 그 전에는 앉은 날과 carryTo 만. */
  function numbersOpenAt(plan) { return kstAt(plan.examDate, '00:00') + (plan.numbersOpenDays != null ? plan.numbersOpenDays : 7) * DAY + 16 * 3600000; }
  function numbersOpen(plan, now) { return ms(now) >= numbersOpenAt(plan); }

  function phaseByDate(plan, today) {
    var ph = (plan.phases || []).filter(function (p) { return today >= p.from && today <= p.to; })[0];
    return ph || null;
  }
  function p4Sub(d) { return d >= 29 ? 'rebuild' : d >= 15 ? 'mix' : d >= 8 ? 'narrow' : 'settle'; }

  function phaseOf(plan, now) {
    var d = dday(plan, now), today = kstDate(now);
    if (isLocked(plan, now)) return { phase: 'p5', sub: null, dday: d, mix: MIX.p5, dailyMin: 0, extendBlockMin: 0, extendMax: 0, freezeNew: true, mode: 'locked' };
    var ph = phaseByDate(plan, today);
    var id = ph ? ph.id : (d > 540 ? 'p1' : d > 300 ? 'p2' : d > 51 ? 'p3' : 'p4');
    var out = { phase: id, sub: null, dday: d, dailyMin: (ph && ph.dailyMin) || DAILY[id] || 15,
                extendBlockMin: (ph && ph.extendBlockMin) || 0, extendMax: (ph && ph.extendMax) || 0, freezeNew: false, mode: 'mixed' };
    if (id === 'p4') {
      out.sub = p4Sub(d); out.mix = MIX.p4[out.sub];
      out.freezeNew = d <= 14;                   // D-14 신규 원자 마감
      out.mode = out.sub === 'rebuild' ? 'block' : 'mixed';
      if (out.sub === 'settle') out.dailyMin = Math.min(out.dailyMin, 15);   // 감량 — 7일에 새 스킬이 안정화될 확률은 낮고 불안 비용은 확실하다
      if (!out.extendBlockMin) { out.extendBlockMin = 15; out.extendMax = 2; }
    } else {
      out.mix = MIX[id] || MIX.p2;
      if (id === 'p1') out.mode = 'block';
    }
    return out;
  }

  /* 학기 잠금 — 초5 1월에 6-1 원자를 찌르지 않는다. band 'none' 은 늘 열림. */
  function bandOpen(plan, band, now) {
    if (!band || band === 'none') return true;
    var open = (plan.bands || {})[band];
    return !!open && kstDate(now) >= open;
  }

  function dayEntry(plan, ymd) { return (plan.days || []).filter(function (x) { return x.d === ymd; })[0] || null; }
  function windowDays(plan, now, span) {
    var t0 = kstAt(kstDate(now), '00:00'), s = span == null ? 3 : span;
    return (plan.days || []).filter(function (x) { var dt = (kstAt(x.d, '00:00') - t0) / DAY; return dt >= -s && dt <= s; });
  }
  /* aud 필터는 서버가 건다 — 클라이언트에서 거르면 배열 전체가 아이 기기에 내려간다. */
  function milestonesFor(plan, aud, now, days) {
    var t0 = kstAt(kstDate(now), '00:00'), lim = (days == null ? 45 : days) * DAY;
    return (plan.milestones || []).filter(function (m) {
      var ok = m.aud === 'both' || m.aud === aud;
      var dt = kstAt(m.d, '00:00') - t0;
      return ok && dt >= 0 && dt <= lim;
    });
  }

  /* D-7 위상 전진 — 매일 15분씩 취침을 당겨 시험 전날 목표 시각에 닿는다. 서버에 저장하지 않는 값이다. */
  function bedTarget(plan, now) {
    var bed = plan.bed || { base: '23:45', target: '22:00', days: 7 };
    var d = dday(plan, now);
    var toMin = function (s) { var p = s.split(':'); return +p[0] * 60 + +p[1]; };
    var fromMin = function (m) { return pad(Math.floor(m / 60)) + ':' + pad(m % 60); };
    if (d > bed.days) return bed.base;
    if (d <= 0) return bed.target;
    var base = toMin(bed.base), tgt = toMin(bed.target), step = (base - tgt) / bed.days;
    return fromMin(Math.round(base - step * (bed.days - d + 1)));
  }

  return { DAY: DAY, MIX: MIX, ms: ms, kstDate: kstDate, kstAt: kstAt, daysUntil: daysUntil, dday: dday, isMonday: isMonday, weekKey: weekKey,
           isLocked: isLocked, isRetro: isRetro, retroEndAt: retroEndAt, numbersOpenAt: numbersOpenAt, numbersOpen: numbersOpen,
           phaseOf: phaseOf, bandOpen: bandOpen, dayEntry: dayEntry, windowDays: windowDays, milestonesFor: milestonesFor, bedTarget: bedTarget };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WBHARU_P;
