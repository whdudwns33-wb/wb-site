'use strict';
/* 주기 평가 리포트 엔진 — L3 월간 · L4 국면. 출력은 문장이 아니라 필드이고, 문장은 strings.js 템플릿이 만든다(템플릿에 없는 문장은 존재하지 않는다).
   "개선·보완점"은 칸 이름 + 이번 달 관측 + 다음 행동 세 조각뿐이다. 능력 귀인·비교·예측은 금지어 검사가 잡는다.
   원천 필드가 없는 문장은 쓸 수 없다(기획서 §9-3) — 이 파일이 읽는 필드 목록이 곧 리포트가 말할 수 있는 것의 전부다. */
var WBHARU_RPT = (function () {
  var M = (typeof WBHARU_M !== 'undefined') ? WBHARU_M : require('./mastery.js');
  var S = (typeof WBHARU_S !== 'undefined') ? WBHARU_S : require('./strings.js');
  var C = (typeof WBHARU_C !== 'undefined') ? WBHARU_C : require('./cause.js');
  var MIN_N_CAUSE = 10, MIN_N_DIST = 30, LOW_RATE = 0.5, ONEREAD_LOW = 0.3;

  function index(atoms) { var m = {}; (atoms || []).forEach(function (a) { m[a.id] = a; }); return m; }
  function inMonth(d, month) { return typeof d === 'string' && d.slice(0, 7) === month; }
  function label(idx, id) { return idx[id] ? idx[id].label : id; }
  function dominant(cause) { var best = null, n = 0; Object.keys(cause || {}).forEach(function (k) { if (cause[k] > n) { n = cause[k]; best = k; } }); return { cause: best, n: n }; }

  /* 판정 규칙표(학생평가 §4-3) — 상태 조합 → 다음 행동. 문장 템플릿은 과정형만. */
  function actionFor(atom, s, grade, now) {
    if (!atom || !s) return null;
    var dom = dominant(s.cause), L = atom.label;
    if (grade === 'hole') {
      if (atom.tier === 3 && (s.cause && s.cause.gap >= 3)) return { atomId: atom.id, action: 'paper', text: L + '은(는) 발상이 필요한 칸이라 종이로 갑니다' + (atom.paperSource ? ' (' + atom.paperSource + ')' : '') };
      if (dom.cause === 'exec') return { atomId: atom.id, action: 'block', text: L + '은(는) 아는데 손이 어긋납니다. 3문항씩 매일 만납니다' };
      if (dom.cause === 'confuse') return { atomId: atom.id, action: 'interleave', text: L + '을(를) ' + ((atom.confuse || []).length ? '비슷한 칸과 섞어서' : '섞어서') + ' 냅니다' };
      if (dom.cause === 'misread') return { atomId: atom.id, action: 'markConditions', text: L + '은(는) 조건에 표시하는 연습을 넣습니다' };
      return { atomId: atom.id, action: 'ladder', text: L + '은(는) 풀이를 보며 처음부터 다시 만납니다' };
    }
    if (grade === 'shaky' && (s.obs || 0) >= M.MIN_FLUENT_OBS && (s.ctx || []).indexOf('mixed') < 0) return { atomId: atom.id, action: 'mixed', text: L + '은(는) 섞어 내도 맞아야 붙습니다' };
    if (grade === 'unknown') return { atomId: atom.id, action: 'probe', text: L + '은(는) 아직 재지 않았습니다. 다음 달 먼저 만납니다' };
    return null;
  }

  /* opts: { now, core:[ids], prevAtoms:{id:{obs,ok}}, prevGrades:{id:grade}, dist:{keyId:{n,bins,mine,composition,itemSource}}, lowWeeks, nextBand, nextAtoms:[ids] } */
  function monthly(all, atoms, plan, month, opts) {
    opts = opts || {};
    var now = opts.now || Date.now(), idx = index(atoms), state = all.state || {}, mocks = (all.mocks || []), paper = (all.paper || []);
    var core = opts.core || Object.keys(state.atoms || {});
    var prevA = opts.prevAtoms || {}, prevG = opts.prevGrades || {};

    var days = { sat: 0, min: 0 };
    Object.keys(state.days || {}).forEach(function (d) { if (inMonth(d, month) && state.days[d].sat) { days.sat++; days.min += state.days[d].min || 0; } });
    var pas = (state.passages || []).filter(function (p) { return inMonth(p.at, month); });
    var passages = { sessions: pas.length, oneRead: pas.filter(function (p) { return p.oneRead; }).length, rewinds: pas.reduce(function (a, p) { return a + (p.rewinds || 0); }, 0) };

    var byState = { fluent: [], shaky: [], hole: [], unknown: [] }, confirmedDelta = [], actions = [];
    core.forEach(function (id) {
      var a = idx[id], s = (state.atoms || {})[id];
      var g = M.grade(s, a, now);
      var mo = s ? Math.round(((s.obs || 0) - ((prevA[id] && prevA[id].obs) || 0)) * 10) / 10 : 0;
      var mok = s ? Math.round(((s.ok || 0) - ((prevA[id] && prevA[id].ok) || 0)) * 10) / 10 : 0;
      var row = { atomId: id, label: label(idx, id), grade: g, monthObs: Math.max(0, mo), monthOk: Math.max(0, mok), obs: s ? s.obs : 0 };
      if (g === 'observed-only') return;
      byState[g].push(row);
      if (g === 'fluent' && prevG[id] !== 'fluent') confirmedDelta.push(id);
      var act = actionFor(a, s, g, now); if (act) actions.push(act);
    });

    var mockRows = mocks.filter(function (m) { return inMonth(m.at, month); }).map(function (m) {
      var sk = m.skills || {};
      return { keyId: m.keyId, at: m.at, completed: !!m.completed, blank: m.blank || 0, retake: !!m.retake,
               skillsPassed: ['markImmediate', 'passUsedAndRecovered', 'blank0', 'noBreakGrade'].filter(function (k) { return sk[k]; }).length,
               dist: (opts.dist && opts.dist[m.keyId] && opts.dist[m.keyId].n >= MIN_N_DIST) ? opts.dist[m.keyId] : null };
    });
    /* 회차 무응답이 두 번 연속 → 시험 기술 처방 */
    var recentMocks = mocks.filter(function (m) { return !m.retake; }).slice(-2);
    if (recentMocks.length === 2 && recentMocks.every(function (m) { return (m.blank || 0) > 0; })) actions.push({ atomId: null, action: 'skipRecover', text: '빈칸으로 낸 문항이 있습니다. 넘긴 문항으로 되돌아오는 연습을 넣습니다' });
    /* 3개월 되감기 없는 1회독 비율 */
    var recentPas = (state.passages || []).slice(-24);
    if (recentPas.length >= 8 && recentPas.filter(function (p) { return p.oneRead; }).length / recentPas.length < ONEREAD_LOW) actions.push({ atomId: null, action: 'readAloud', text: '지문을 한 번에 읽는 비율이 낮습니다. 화·목 세션을 소리 내어 읽기로 바꿉니다' });

    var causeDist = C.distribution((state.wrong || []).filter(function (w) { return inMonth(String(w.at || ''), month); }), MIN_N_CAUSE);
    var paperRows = paper.filter(function (p) { return inMonth(p.at, month); });
    var toPaper = actions.filter(function (a) { return a.action === 'paper'; });
    var lowWeeks = opts.lowWeeks || 0;
    var condition = (lowWeeks >= 3) ? null : (days.sat > 0 && days.sat < 10 ? '저녁 시작 시각을 30분 당겨 보시겠어요?' : null);   // 아이 탓이 아니라 조건 조정. 3주 연속이면 문구도 멈춘다

    return { month: month, days: days, passages: passages, byState: byState, confirmedDelta: confirmedDelta, actions: actions, toPaper: toPaper,
             mocks: mockRows, paper: { sheets: paperRows.length }, causeDist: causeDist, nextMonth: { band: opts.nextBand || null, atoms: opts.nextAtoms || [] },
             condition: condition, coachNote: null };
  }

  /* 국면 평가 — 동결 세트 재응시 차이 · 코어 완주율 · 궤적 · 코호트 단위 조정 제안. 학생별 플랜 조정은 없다(toPaper 만 학생별). */
  function phaseReview(all, atoms, plan, opts) {
    opts = opts || {};
    var now = opts.now || Date.now(), idx = index(atoms), state = all.state || {}, mocks = all.mocks || [];
    var core = opts.core || Object.keys(state.atoms || {});
    var frozenId = opts.frozenKeyId || (plan && plan.frozenKeyId);
    var fr = mocks.filter(function (m) { return m.keyId === frozenId; });
    var before = fr.filter(function (m) { return !m.retake; })[0] || null, after = fr.filter(function (m) { return m.retake; }).slice(-1)[0] || null;
    var okOf = function (m) { if (!m) return null; var t = 0; Object.keys(m.bySubject || {}).forEach(function (k) { t += m.bySubject[k].ok || 0; }); return t; };
    var frozen = { keyId: frozenId, before: okOf(before), after: okOf(after), diff: (before && after) ? okOf(after) - okOf(before) : null };
    var grades = {}; core.forEach(function (id) { grades[id] = M.grade((state.atoms || {})[id], idx[id], now); });
    var fluent = core.filter(function (id) { return grades[id] === 'fluent'; }).length;
    var completion = core.length ? fluent / core.length : 0;
    var trajectory = (state.weekly || []).map(function (w) { return { w: w.w, top3: (w.top3 || []).map(function (id) { return label(idx, id); }) }; });
    var toPaper = core.map(function (id) { return actionFor(idx[id], (state.atoms || {})[id], grades[id], now); }).filter(function (a) { return a && a.action === 'paper'; });
    var recommend = { bands: completion < 0.3 ? 'later' : completion > 0.8 ? 'earlier' : null, dailyMin: null, toPaper: toPaper, consult: frozen.diff != null && frozen.diff <= 0 };
    return { frozen: frozen, coreCompletion: { fluent: fluent, total: core.length }, grades: grades, trajectory: trajectory, recommend: recommend };
  }

  /* 뷰 투영 — 학생: 과정형만 · 부모: 1장 · 강사: 내부값 포함. 금지어는 strings.findForbidden 이 검사한다. */
  function forStudent(r) {
    var lines = [];
    r.confirmedDelta.forEach(function (id) { var row = r.byState.fluent.filter(function (x) { return x.atomId === id; })[0]; if (row) lines.push(S.transitionLine('shaky', 'fluent', row.label)); });
    r.byState.shaky.concat(r.byState.hole).forEach(function (x) { lines.push(x.label + ' — ' + S.progressLine(x.obs, x.obs * 0 + (x.monthOk || 0) + Math.max(0, (x.obs - x.monthObs)) * 0, M.MIN_FLUENT_OBS).replace(/관측 \d+번 중 \d+번 맞았어요/, '이번 달 ' + Math.round(x.monthObs) + '번 만났어요')); });
    return { sat: r.days.sat, lines: lines.filter(Boolean) };
  }
  function forParent(r) {
    return { month: r.month, sat: r.days.sat, min: r.days.min, passages: r.passages,
             newlyFluent: r.confirmedDelta.map(function (id) { var row = r.byState.fluent.filter(function (x) { return x.atomId === id; })[0]; return row ? row.label : id; }),
             shaky: r.byState.shaky.map(function (x) { return x.label + ' (' + Math.round(x.monthObs) + '번 만나 ' + Math.round(x.monthOk) + '번)'; }),
             hole: r.byState.hole.map(function (x) { return x.label + ' (' + Math.round(x.monthObs) + '번 만나 ' + Math.round(x.monthOk) + '번)'; }),
             unknownCount: r.byState.unknown.length,
             mocks: r.mocks.map(function (m) { return { completed: m.completed, blank: m.blank, dist: m.dist }; }),   // 점수 없음
             causeDist: r.causeDist.show ? r.causeDist.byCause : null, causeN: r.causeDist.n,
             nextMonth: r.nextMonth, toPaper: r.toPaper.map(function (a) { return a.text; }), condition: r.condition, coachNote: r.coachNote };
  }
  function forCoach(r) {
    var p = forParent(r);
    p.internal = { byState: r.byState, actions: r.actions, mocks: r.mocks };
    return p;
  }
  function textOf(view) { return JSON.stringify(view); }

  return { MIN_N_CAUSE: MIN_N_CAUSE, MIN_N_DIST: MIN_N_DIST, monthly: monthly, phaseReview: phaseReview, forStudent: forStudent, forParent: forParent, forCoach: forCoach, actionFor: actionFor, textOf: textOf };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WBHARU_RPT;
