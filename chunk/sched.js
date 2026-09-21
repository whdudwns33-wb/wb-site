'use strict';
/* WB 청크브레인 — 연습 기록·복습 일정 (순수 로직, 브라우저/Node 공용)
 *
 * 글 하나가 카드 하나다. 점수에 따라 다음 복습일이 정해진다 — 워드브레인(vocab/srs.js)과 같은 간격 사다리를
 * 쓰되 단계 승급 조건만 다르다: 어휘는 「알았어」 한 번이지만, 끊어 읽기는 «점수»가 나온다.
 *   85점 이상  → 한 단계 위 (1일 → 3일 → 7일 → 14일 → 30일, 30일 복습을 통과하면 졸업)
 *   60~84점    → 제자리, 한 단계 아래 간격으로 다시
 *   60점 미만  → 처음으로, 내일 다시
 * 문헌이 말하는 두 가지를 그대로 옮겼다 — 표시된 글에만 익숙해지면 안 되므로 복습은 «표시 없는 글에 직접 찍는» 단계로
 * 시작하고(fading), 이미 잘 읽는 아이에게 계속 시키는 것은 효과가 없으므로 졸업과 단계 올리기 제안을 둔다. */
var WBCHUNK_SCHED = (function () {
  var DAY = 86400000;
  var STEP_DAYS = [1, 3, 7, 14, 30];
  var GRADUATE_STEP = STEP_DAYS.length + 1; /* 1·3·7·14·30일 복습을 모두 통과한 여섯 번째 성공에서 졸업 */
  var LOG_MAX = 400;
  var WEAK_WINDOW = 30;                       /* 약한 규칙은 최근 30회 기록으로 본다 */

  function blank(now) {
    return { v: 1, band: null, items: {}, log: [], lessons: {}, prefs: { font: 'normal', rate: null, marker: 'auto', recording: true }, assign: null, updatedAt: now || 0 };
  }
  /* 저장된 것을 복원할 때 빠진 칸을 채운다 — 버전이 올라가도 옛 기록이 열리게 */
  function normalize(s, now) {
    var b = blank(now);
    if (!s || typeof s !== 'object') return b;
    var out = {};
    for (var k in b) out[k] = (s[k] != null && b[k] != null && typeof s[k] === typeof b[k]) ? s[k] : b[k];
    /* band 의 기본값이 null 이라 위 비교로는 문자열이 버려진다 — 따로 본다 */
    out.band = typeof s.band === 'string' ? legacyBand(s.band) : null;
    /* 선생님 과제(서버가 준 것을 그대로 보관) — 기본값이 null 이라 위 비교로는 버려진다 */
    out.assign = s.assign && typeof s.assign === 'object' && !Array.isArray(s.assign) ? s.assign : null;
    if (!out.prefs || typeof out.prefs !== 'object') out.prefs = b.prefs;
    for (var p in b.prefs) if (out.prefs[p] === undefined) out.prefs[p] = b.prefs[p];
    if (!Array.isArray(out.log)) out.log = [];
    if (!out.items || typeof out.items !== 'object' || Array.isArray(out.items)) out.items = {};
    if (!out.lessons || typeof out.lessons !== 'object' || Array.isArray(out.lessons)) out.lessons = {};
    Object.keys(out.items).forEach(function (k) { var it = out.items[k]; if (it && typeof it.band === 'string') it.band = legacyBand(it.band); });
    out.log.forEach(function (e) { if (e && typeof e.band === 'string') e.band = legacyBand(e.band); });
    return out;
  }

  /* 2026-09-21 이전의 여섯 밴드(E1·E2·E3·M·H) 기록은 학년 단계로 옮긴다 — 각 밴드의 맨 아래 학년으로.
     글 id 도 그때 바뀌었으므로 옛 기록의 글은 목록에서 못 찾을 수 있다. 화면은 그런 항목을 건너뛴다. */
  var LEGACY = { E1: 'G1', E2: 'G3', E3: 'G5', M: 'G7', H: 'G10' };
  function legacyBand(b) { return LEGACY[b] || b; }

  function gradeOf(score) { return score >= 85 ? 'good' : score >= 60 ? 'ok' : 'weak'; }

  /* 연습 한 번을 기록한다. res = { score, qOk, tags, mode:'practice'|'review'|'lesson', wpm, band } */
  function record(state, id, res, now) {
    var it = state.items[id];
    if (!it) it = state.items[id] = { id: id, band: res.band || state.band || null, n: 0, step: 0, due: 0, best: 0, last: null, lastScore: null, scores: [], q: [0, 0], graduated: false, firstAt: now };
    var sc = Math.max(0, Math.min(100, Math.round(Number(res.score) || 0)));
    it.n += 1; it.last = now; it.lastScore = sc; it.best = Math.max(it.best || 0, sc);
    it.scores.push(sc); if (it.scores.length > 8) it.scores.shift();
    if (res.qOk === true || res.qOk === false) { it.q[1] += 1; if (res.qOk) it.q[0] += 1; }
    var g = gradeOf(sc);
    if (g === 'good') it.step = Math.min(it.step + 1, GRADUATE_STEP);
    else if (g === 'weak') it.step = 0;
    else it.step = Math.max(1, it.step);
    if (it.step >= GRADUATE_STEP) { it.graduated = true; it.due = 0; it.gradAt = now; }
    else {
      it.graduated = false;
      var idx = g === 'good' ? Math.min(it.step - 1, STEP_DAYS.length - 1) : g === 'ok' ? Math.max(0, it.step - 2) : 0;
      it.due = now + STEP_DAYS[idx] * DAY;
    }
    state.log.push({ t: now, id: id, band: it.band, score: sc, qOk: res.qOk == null ? null : !!res.qOk, mode: res.mode || 'practice', wpm: res.wpm || null, self: res.self == null ? null : Math.max(0, Math.min(3, Math.round(res.self))), tags: (res.tags || []).slice(0, 12) });
    if (state.log.length > LOG_MAX) state.log.splice(0, state.log.length - LOG_MAX);
    state.updatedAt = now;
    return it;
  }

  function intervalMs(it) { return STEP_DAYS[Math.max(0, Math.min(STEP_DAYS.length - 1, it.step - 1))] * DAY; }

  function values(map) { var out = [], k; for (k in map) if (Object.prototype.hasOwnProperty.call(map, k)) out.push(map[k]); return out; }

  /* 오늘 복습할 글 — 밀린 정도(지난 시간 ÷ 간격)가 큰 순 */
  function dueList(state, now, band) {
    return values(state.items)
      .filter(function (it) { return !it.graduated && it.due && it.due <= now && (!band || it.band === band); })
      .sort(function (a, b) { return ((now - b.due) / intervalMs(b)) - ((now - a.due) / intervalMs(a)); });
  }

  /* 다음에 연습할 글 — 밀린 복습 → 아직 안 한 글(순서대로) → 점수가 가장 낮은 글. 다 졸업했으면 null. */
  function nextPassage(state, ids, now, band) {
    var due = dueList(state, now, band);
    if (due.length && ids.indexOf(due[0].id) >= 0) return { id: due[0].id, why: 'due' };
    for (var i = 0; i < ids.length; i++) if (!state.items[ids[i]]) return { id: ids[i], why: 'new' };
    var left = ids.map(function (id) { return state.items[id]; }).filter(function (it) { return it && !it.graduated; })
      .sort(function (a, b) { return (a.lastScore || 0) - (b.lastScore || 0) || (a.last || 0) - (b.last || 0); });
    if (left.length) return { id: left[0].id, why: 'weak' };
    return null;
  }

  /* 약한 규칙 — 최근 기록의 태그를 센다. 2회 이상 나온 것만, 많은 순 */
  function weakTags(state, n) {
    var recent = state.log.slice(-WEAK_WINDOW), cnt = {};
    recent.forEach(function (e) { (e.tags || []).forEach(function (tg) { cnt[tg] = (cnt[tg] || 0) + 1; }); });
    return Object.keys(cnt).filter(function (k) { return cnt[k] >= 2; })
      .sort(function (a, b) { return cnt[b] - cnt[a]; })
      .slice(0, n || 3).map(function (k) { return { tag: k, n: cnt[k] }; });
  }

  /* 단계 올리기·내리기 제안 — 같은 밴드의 최근 연습(복습 제외) 3회로 본다 */
  function suggestion(state, band) {
    var recent = state.log.filter(function (e) { return e.band === band && e.mode === 'practice'; }).slice(-3);
    if (recent.length < 3) return null;
    var hi = recent.every(function (e) { return e.score >= 85; }) && recent.filter(function (e) { return e.qOk === true; }).length >= 2;
    if (hi) return 'up';
    if (recent.every(function (e) { return e.score < 50; })) return 'down';
    return null;
  }

  function dayKey(t) { var d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

  /* 연속 학습일 — 오늘 또는 어제까지 이어진 날 수 */
  function streak(state, now) {
    var days = {}; state.log.forEach(function (e) { days[dayKey(e.t)] = true; });
    var n = 0, t = now;
    if (!days[dayKey(t)]) { t -= DAY; if (!days[dayKey(t)]) return 0; }
    while (days[dayKey(t)]) { n++; t -= DAY; }
    return n;
  }

  function lessonDone(state, lessonId, now, score) {
    state.lessons[lessonId] = { at: now, score: score == null ? null : score };
    state.updatedAt = now;
  }

  /* 과제 진행 — 선생님이 정한 뒤(assign.updatedAt) 연습한 글과 본 카드만 센다 */
  function assignDone(state) {
    var a = state.assign; if (!a) return 0;
    var since = a.updatedAt ? Date.parse(a.updatedAt) || 0 : 0, n = 0;
    (a.passages || []).forEach(function (id) { var it = state.items[id]; if (it && it.last >= since) n++; });
    (a.lessons || []).forEach(function (id) { var l = state.lessons[id]; if (l && l.at >= since) n++; });
    return n;
  }
  function assignTotal(state) { var a = state.assign; return a ? (a.passages || []).length + (a.lessons || []).length : 0; }

  function summary(state, now, band) {
    var items = values(state.items).filter(function (it) { return !band || it.band === band; });
    var logs = state.log.filter(function (e) { return !band || e.band === band; });
    var sum = 0; logs.forEach(function (e) { sum += e.score; });
    var recent = logs.slice(-5); var rsum = 0; recent.forEach(function (e) { rsum += e.score; });
    var wpm = logs.filter(function (e) { return e.wpm; }).slice(-5).map(function (e) { return e.wpm; });
    return {
      attempts: logs.length, practiced: items.length, graduated: items.filter(function (it) { return it.graduated; }).length,
      due: dueList(state, now, band).length, avg: logs.length ? Math.round(sum / logs.length) : null,
      recentAvg: recent.length ? Math.round(rsum / recent.length) : null,
      qRate: (function () { var a = 0, b = 0; logs.forEach(function (e) { if (e.qOk != null) { b++; if (e.qOk) a++; } }); return b ? Math.round(a / b * 100) : null; })(),
      wpmRecent: wpm.length ? Math.round(wpm.reduce(function (a, b) { return a + b; }, 0) / wpm.length) : null,
      streak: streak(state, now), lessonsDone: Object.keys(state.lessons).length,
    };
  }

  /* 선생님 확인용 요약 — 서버에 함께 올리는 작은 객체(화이트리스트는 서버가 다시 건다) */
  function forTeacher(state, now) {
    var s = summary(state, now);
    return { band: state.band, attempts: s.attempts, practiced: s.practiced, graduated: s.graduated, avg: s.avg, recentAvg: s.recentAvg, qRate: s.qRate, wpmRecent: s.wpmRecent, streak: s.streak, lessonsDone: s.lessonsDone, weak: weakTags(state, 5), assignDone: assignDone(state), lastAt: state.log.length ? state.log[state.log.length - 1].t : null };
  }

  return { DAY: DAY, STEP_DAYS: STEP_DAYS, GRADUATE_STEP: GRADUATE_STEP, blank: blank, normalize: normalize, gradeOf: gradeOf, record: record, dueList: dueList, nextPassage: nextPassage, weakTags: weakTags, suggestion: suggestion, streak: streak, lessonDone: lessonDone, summary: summary, forTeacher: forTeacher, assignDone: assignDone, assignTotal: assignTotal, dayKey: dayKey };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WBCHUNK_SCHED;
