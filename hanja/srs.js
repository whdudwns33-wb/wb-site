'use strict';
/* WB 한자브레인 — 간격 반복 엔진 (순수 로직, 브라우저/Node 공용)
   워드브레인(vocab/srs.js)과 같은 눈금을 쓴다: 당일 밤 → 1일 → 3일 → 7일 → 14일 → 30일 → 90일.
   같은 학원 안에서 앱마다 간격이 다르면 강사가 "이 앱은 왜 오늘 또 묻지?"를 설명해야 한다.

   항목은 두 종류다 — 낱말(단어장별)과 한자(글자 하나, 단어장을 넘어 공용).
   觀 을 한 단어장에서 익히면 다른 단어장의 관찰·객관에서도 익힌 것이다.
   그래서 한자 항목의 id 는 'c:觀' 처럼 글자 하나로만 만들고 낱말은 'w:<단어장>:<낱말id>' 로 만든다. */
var WBHSRS = (function () {
  var DAY = 86400000;
  var MIN10 = 600000;
  var INTERVAL_DAYS = [0, 1, 3, 7, 14, 30, 90];
  var GRADUATE_STEP = 6;
  var STAGES = ['새로 심음', '하루', '사흘', '일주일', '2주', '한 달', '장기 기억'];

  function wordId(bookId, wid) { return 'w:' + bookId + ':' + wid; }
  function charId(ch) { return 'c:' + ch; }
  function kindOf(id) { return String(id || '').charAt(0) === 'c' ? 'char' : 'word'; }

  /* 21시 전에 심으면 오늘 밤, 그 뒤면 10분 뒤 첫 회상 — 자기 전 복습이 첫 인출이다 */
  function tonight(now) {
    var d = new Date(now);
    var t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 21, 0, 0, 0).getTime();
    return now < t ? t : now + MIN10;
  }

  function plant(id, now, meta) {
    var s = { id: id, step: 0, due: tonight(now), plantedAt: now, reps: 0, lapses: 0, streak: 0, last: null, graduated: false, gradAt: null };
    if (meta && meta.book) s.book = meta.book;
    return s;
  }

  /* grade: 'fail'(틀림) | 'hard'(힌트·재시도 뒤 맞힘) | 'good'(첫 시도 정답) */
  function review(s, grade, now) {
    s.reps += 1; s.last = now;
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
      if (!s.graduated && s.step >= GRADUATE_STEP && s.streak >= 3) { s.graduated = true; s.gradAt = now; }
    }
    return s;
  }

  function intervalMs(s) { return Math.max(INTERVAL_DAYS[Math.min(s.step || 0, INTERVAL_DAYS.length - 1)], 0.5) * DAY; }

  /* 0 제때 · 1 살짝 늦음 · 2 늦음 · 3 응급(간격의 1.25배 넘게 방치) */
  function urgency(s, now) {
    if (s.graduated) return 0;
    var over = now - s.due;
    if (over <= 0) return 0;
    var r = over / intervalMs(s);
    return r < 0.5 ? 1 : (r < 1.25 ? 2 : 3);
  }

  function stage(s) { return s.graduated ? 6 : Math.min(s.step, 5); }
  function stageLabel(s) { return STAGES[stage(s)]; }

  function values(states, filter) {
    var out = [], k;
    for (k in states) if (Object.prototype.hasOwnProperty.call(states, k) && (!filter || filter(states[k]))) out.push(states[k]);
    return out;
  }

  /* 오늘 물 줄 것 — 가장 오래 방치된 것부터 */
  function dueList(states, now, filter) {
    return values(states, filter)
      .filter(function (s) { return !s.graduated && s.due <= now; })
      .sort(function (a, b) { return ((now - b.due) / intervalMs(b)) - ((now - a.due) / intervalMs(a)); });
  }

  function sameDay(a, b) {
    var x = new Date(a), y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
  }

  function todayPlanted(states, now, filter) {
    return values(states, filter).filter(function (s) { return sameDay(s.plantedAt, now); });
  }

  function summary(states, now, filter) {
    var out = { total: 0, graduated: 0, due: 0, emergency: 0, seed: 0, growing: 0, words: 0, chars: 0 };
    values(states, filter).forEach(function (s) {
      out.total += 1;
      if (kindOf(s.id) === 'char') out.chars += 1; else out.words += 1;
      if (s.graduated) out.graduated += 1;
      else if (s.step <= 1) out.seed += 1;
      else out.growing += 1;
      if (!s.graduated && s.due <= now) out.due += 1;
      if (urgency(s, now) >= 3) out.emergency += 1;
    });
    return out;
  }

  /* 연속 학습일 — 오늘 처음 하면 어제에 이어 +1, 하루 건너뛰면 1부터 */
  function bumpStreak(streak, now) {
    var st = streak || { count: 0, last: null };
    if (st.last != null && sameDay(st.last, now)) return st;
    var yesterday = st.last != null && sameDay(st.last + DAY, now);
    return { count: yesterday ? st.count + 1 : 1, last: now };
  }

  return {
    DAY: DAY, INTERVAL_DAYS: INTERVAL_DAYS, GRADUATE_STEP: GRADUATE_STEP, STAGES: STAGES,
    wordId: wordId, charId: charId, kindOf: kindOf,
    tonight: tonight, plant: plant, review: review, intervalMs: intervalMs, urgency: urgency,
    stage: stage, stageLabel: stageLabel, dueList: dueList, todayPlanted: todayPlanted, summary: summary,
    sameDay: sameDay, bumpStreak: bumpStreak,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WBHSRS;
