'use strict';
/* 무엇을 찌를 것인가 — 게이트 대신 우선순위. value = U(배점 지배력) × H(사후 분산) × A(선수 실행가능성) × B(학기 잠금).
   A(k) 가 없으면 앱이 매일 가장 비싼 칸(m-pct-inverse)만 찌르고, B 가 없으면 초5 겨울에 6-1 원자가 unknown 이라는 이유로 최우선이 된다. */
var WBHARU_PR = (function () {
  var M = (typeof WBHARU_M !== 'undefined') ? WBHARU_M : require('./mastery.js');
  var P = (typeof WBHARU_P !== 'undefined') ? WBHARU_P : require('./plan.js');
  var S = (typeof WBHARU_S !== 'undefined') ? WBHARU_S : require('./strings.js');
  var SUBJECT_W = { kor: 1.15, math: 1.00, eng: 0.95 };   // 동점자 규칙. 1.15 는 추정치 — 근거는 "국어가 이긴다"이지 15% 가 아니다
  var H_SCALE = 12, A_BLOCKED = 0.2, RECENT_DAYS = 3, ENVELOPE_MAX = 2;

  function index(atoms) { var m = {}; (atoms || []).forEach(function (a) { m[a.id] = a; }); return m; }
  function prereqReady(atom, states, idx, now, halfDays) {
    return (atom.prereq || []).every(function (id) {
      var s = states[id]; if (!s || !idx[id]) return true;         // 관측 없는 선수는 막지 않는다 (unknown 은 구멍이 아니다)
      return M.grade(s, idx[id], now, halfDays) !== 'hole';
    });
  }
  function value(atom, s, states, idx, plan, now, halfDays) {
    if (!P.bandOpen(plan, atom.band, now)) return 0;                                   // B
    if (!s || (s.obs || 0) < M.MIN_OBS) return 1e6 - (s ? s.obs || 0 : 0);            // 콜드스타트 바닥 — 없으면 P1 3주 내내 회색 격자
    var U = (atom.weight || 1) * (SUBJECT_W[atom.subject] || 1);
    var H = M.varOf(s, now, halfDays) * H_SCALE;
    var A = prereqReady(atom, states, idx, now, halfDays) ? 1 : A_BLOCKED;
    return U * H * A;
  }

  /* opts: { core:[ids], recent:{id:lastAt}, halfDays } */
  function ranked(states, atoms, plan, now, opts) {
    opts = opts || {};
    var idx = index(atoms), core = opts.core || atoms.map(function (a) { return a.id; });
    var recent = opts.recent || {};
    return core.map(function (id) { return idx[id]; }).filter(Boolean)
      .filter(function (a) { return a.teach !== 'paper' && !(recent[a.id] && now - recent[a.id] < RECENT_DAYS * P.DAY); })
      .map(function (a) { var s = states[a.id]; return { atom: a, state: s, grade: M.grade(s, a, now, opts.halfDays), value: value(a, s, states, idx, plan, now, opts.halfDays) }; })
      .filter(function (r) { return r.value > 0; })
      .sort(function (x, y) { return y.value - x.value || (x.atom.subject === 'kor' ? -1 : y.atom.subject === 'kor' ? 1 : 0); });
  }
  function nextProbe(states, atoms, plan, now, opts) { var r = ranked(states, atoms, plan, now, opts)[0]; return r ? { atomId: r.atom.id, value: r.value, grade: r.grade } : null; }

  /* 오늘 카드 — 국면 배합대로 슬롯을 채운다. 비면 이웃 버킷에서 빌린다(카드가 사라지지 않는 것이 달력 분모의 뜻이다). */
  function todayCard(states, atoms, plan, now, opts) {
    opts = opts || {};
    var ph = P.phaseOf(plan, now);
    if (ph.phase === 'p5') return { phase: ph, slots: [], envelope: null, minEstimate: 0 };
    var rows = ranked(states, atoms, plan, now, opts);
    var buckets = { hole: [], shaky: [], probe: [] };
    rows.forEach(function (r) {
      if (r.grade === 'unknown') buckets.probe.push(r);
      else if (r.grade === 'hole') buckets.hole.push(r);
      else if (r.grade === 'shaky') buckets.shaky.push(r);
      else if (r.grade === 'fluent' && r.state && r.state.due != null && r.state.due <= now) buckets.shaky.push(r);   // 복습 시점이 온 유창 칸
    });
    if (ph.freezeNew) buckets.probe = [];                                              // D-14 신규 원자 마감
    var want = ph.mix, slots = [], used = {};
    var take = function (kind) {
      var order = kind === 'hole' ? ['hole', 'shaky', 'probe'] : kind === 'shaky' ? ['shaky', 'hole', 'probe'] : ['probe', 'shaky', 'hole'];
      for (var i = 0; i < order.length; i++) {
        var b = buckets[order[i]];
        while (b.length) { var r = b.shift(); if (!used[r.atom.id]) { used[r.atom.id] = true; return { kind: kind, r: r, borrowed: order[i] !== kind }; } }
      }
      return null;
    };
    ['hole', 'shaky', 'probe'].forEach(function (kind) {
      for (var k = 0; k < (want[kind] || 0); k++) {
        var got = take(kind); if (!got) continue;
        var s = got.r.state;
        slots.push({ kind: kind, atomId: got.r.atom.id, label: S.slotLabel(kind), atomLabel: got.r.atom.label, subject: got.r.atom.subject,
                     why: S.progressLine(s ? s.obs : 0, s ? s.ok : 0, M.MIN_FLUENT_OBS), mode: ph.mode, borrowed: got.borrowed });
      }
    });
    var envelope = (ph.phase === 'p1') ? null : (P.isMonday(now) || !opts.prevEnvelope) ? buildEnvelope(states, atoms, plan, now, opts) : opts.prevEnvelope;
    return { phase: ph, slots: slots, envelope: envelope, minEstimate: ph.dailyMin };
  }

  /* 이번 주 종이 봉투 — 월요일에만 새로 만든다(강사 손이 매일 서랍을 열지 않는다). 종이 원자 중 이번 주 사건이 많거나 코어 구멍의 이웃인 것 최대 2개. */
  function buildEnvelope(states, atoms, plan, now, opts) {
    var idx = index(atoms), peri = (opts && opts.seenPeri) || {};
    var holes = {};
    (opts && opts.core || []).forEach(function (id) { var s = states[id]; if (s && idx[id] && M.grade(s, idx[id], now, opts.halfDays) === 'hole') holes[id] = true; });
    var cands = atoms.filter(function (a) { return a.teach === 'paper' && P.bandOpen(plan, a.band, now); }).map(function (a) {
      var wrong = (peri[a.id] && peri[a.id].wrong) || 0;
      var neighbor = (a.prereq || []).some(function (p) { return holes[p]; }) ? 1 : 0;
      return { atomId: a.id, label: a.label, paperSource: a.paperSource, score: (a.weight || 1) * (1 + wrong) + neighbor };
    }).sort(function (x, y) { return y.score - x.score; }).slice(0, ENVELOPE_MAX);
    return { week: P.weekKey(now), items: cands };
  }

  return { SUBJECT_W: SUBJECT_W, value: value, ranked: ranked, nextProbe: nextProbe, todayCard: todayCard, buildEnvelope: buildEnvelope, prereqReady: prereqReady, index: index };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WBHARU_PR;
