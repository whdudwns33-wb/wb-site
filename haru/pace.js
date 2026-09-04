'use strict';
/* 회차 계측 — 마킹 타임스탬프가 1차 계측이다(훈련시키려는 습관 '풀면 바로 마킹'이 곧 계측 장치).
   막대 단위는 문항이 아니라 지문 세트다: 국어 25문항의 약 76%[추정] 가 지문에 매달려, 문항 단위로 귀속하면 세트 첫 문항이 지문 읽기 시간을
   통째로 뒤집어써 회차마다 가짜 물림이 생기고 그 가짜가 처방의 입력이 된다. 세트 경계는 paperkey.sets 에서 읽는다.
   events: [{type:'mark'|'pass'|'change'|'break-grade-attempt', no, at(ms)}] · key: {n, sets:{A:[1,2,3,4],…}, timeLimitSec} */
var WBHARU_PACE = (function () {
  var BUNCH_MS = 3000;       // 이 안에 연달아 찍힌 마킹은 '몰아 마킹' — 즉시 마킹 습관의 반대 신호
  var END_WINDOW_MS = 60000;

  function setOf(key) {
    var m = {};
    var sets = (key && key.sets) || {};
    Object.keys(sets).forEach(function (sid) { (sets[sid] || []).forEach(function (no) { m[no] = sid; }); });
    return function (no) { return m[no] || ('i' + no); };
  }
  function sorted(events) { return (events || []).slice().sort(function (a, b) { return a.at - b.at; }); }
  function median(arr) {
    if (!arr.length) return 0;
    var s = arr.slice().sort(function (a, b) { return a - b; }), h = Math.floor(s.length / 2);
    return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
  }

  /* 문항별 원시 귀속 — 마지막 마킹 시각 − 직전 마킹 시각. 미마킹은 sec null · via 'blank'. */
  function itemTimes(events, openedAt, closedAt, key) {
    var ev = sorted(events), sid = setOf(key);
    var last = {}, passed = {};
    ev.forEach(function (e) { if (e.type === 'mark') last[e.no] = e.at; if (e.type === 'pass') passed[e.no] = true; });
    var marks = Object.keys(last).map(function (no) { return { no: +no, at: last[no] }; }).sort(function (a, b) { return a.at - b.at; });
    var out = [], prev = openedAt;
    marks.forEach(function (m) {
      out.push({ no: m.no, sec: Math.max(0, Math.round((m.at - prev) / 1000)), via: passed[m.no] ? 'recovered' : 'mark', setId: sid(m.no), at: m.at });
      prev = m.at;
    });
    var n = (key && key.n) || 25;
    for (var no = 1; no <= n; no++) if (last[no] == null) out.push({ no: no, sec: null, via: passed[no] ? 'passed-blank' : 'blank', setId: sid(no), at: null });
    return out;
  }

  /* 세트 보정 — 세트의 첫 문항 간격 = 지문 읽기 + 첫 문항 풀이. 나머지 문항의 중앙값을 첫 문항 풀이로 보고 차액을 readSec 으로 뗀다.
     한 문항짜리 세트(수학 등)는 보정 없음. */
  function setTimes(times, key) {
    var groups = {}, order = [];
    times.filter(function (t) { return t.sec != null; }).forEach(function (t) {
      if (!groups[t.setId]) { groups[t.setId] = []; order.push(t.setId); }
      groups[t.setId].push(t);
    });
    return order.map(function (sid) {
      var g = groups[sid].slice().sort(function (a, b) { return a.at - b.at; });
      var secs = g.map(function (t) { return t.sec; });
      if (g.length < 2) return { setId: sid, itemNos: g.map(function (t) { return t.no; }), readSec: 0, perItemSec: secs, corrected: false };
      var med = Math.round(median(secs.slice(1)));
      var readSec = Math.max(0, secs[0] - med);
      var per = [med].concat(secs.slice(1));
      return { setId: sid, itemNos: g.map(function (t) { return t.no; }), readSec: readSec, perItemSec: per, corrected: readSec > 0 };
    });
  }

  /* 원시 + 보정을 한 번에 — 리포트와 rx 는 corrected 를 쓴다. */
  function attribute(events, openedAt, closedAt, key) {
    var raw = itemTimes(events, openedAt, closedAt, key);
    var sets = setTimes(raw, key);
    var corr = {};
    sets.forEach(function (s) { s.itemNos.forEach(function (no, i) { corr[no] = s.perItemSec[i]; }); });
    var items = raw.map(function (t) { return { no: t.no, sec: t.sec == null ? null : (corr[t.no] != null ? corr[t.no] : t.sec), rawSec: t.sec, via: t.via, setId: t.setId }; });
    return { items: items, sets: sets };
  }

  /* 마킹 지연 — 세트 밖에서 3초 안에 연달아 찍힌 마킹(몰아 마킹). 같은 세트 안의 연속 마킹은 세지 않는다 —
     지문 한 편 읽고 네 문항을 잇달아 찍는 것은 옳은 독해 행동이고, 앱이 그것을 벌점으로 표시하면 안 된다. */
  function markLag(events, key) {
    var sid = setOf(key), marks = sorted(events).filter(function (e) { return e.type === 'mark'; });
    var lag = 0;
    for (var i = 1; i < marks.length; i++) {
      var a = marks[i - 1], b = marks[i];
      if (b.at - a.at <= BUNCH_MS && sid(a.no) !== sid(b.no)) lag++;
    }
    return lag;
  }

  /* 페이스 밴드 — 문항 카운트다운 대신 2~3번의 신호만. */
  function band(elapsedSec, doneCount, limitSec, n) {
    n = n || 25;
    var expected = (elapsedSec / limitSec) * n;
    if (doneCount >= expected + 2) return 'ahead';
    if (doneCount <= expected - 2) return 'behind';
    return 'on';
  }

  /* 시험 기술 4항목 — 합격 여부와 무관하게 중학교 3년간 유효한 자산. mocks[].skills 의 원천. */
  function skills(events, key, extra) {
    var ev = sorted(events), n = (key && key.n) || 25;
    var marked = {}, passes = {};
    ev.forEach(function (e) { if (e.type === 'mark') marked[e.no] = true; if (e.type === 'pass') passes[e.no] = true; });
    var passedNos = Object.keys(passes), allMarked = true;
    for (var no = 1; no <= n; no++) if (!marked[no]) allMarked = false;
    var recovered = passedNos.every(function (no) { return marked[no]; });
    var lag = markLag(events, key);
    var lastMin = ev.filter(function (e) { return e.type === 'mark'; }).slice(-3);
    var endBunch = lastMin.length === 3 && (lastMin[2].at - lastMin[0].at) <= END_WINDOW_MS && lastMin.every(function (e, i) { return i === 0 || setOfKeyDiffers(key, lastMin[i - 1].no, e.no); });
    return {
      markImmediate: lag <= 1 && !endBunch,
      passUsedAndRecovered: passedNos.length > 0 ? recovered : allMarked,
      blank0: allMarked,
      noBreakGrade: !(extra && extra.breakGradeAttempts > 0) && !ev.some(function (e) { return e.type === 'break-grade-attempt'; }),
      lag: lag, passes: passedNos.length
    };
  }
  function setOfKeyDiffers(key, a, b) { var sid = setOf(key); return sid(a) !== sid(b); }

  return { BUNCH_MS: BUNCH_MS, itemTimes: itemTimes, setTimes: setTimes, attribute: attribute, markLag: markLag, band: band, skills: skills, median: median };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WBHARU_PACE;
