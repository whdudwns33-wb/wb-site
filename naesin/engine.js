'use strict';
/* WB 내신브레인 — 암기 엔진 (순수 로직, 브라우저/Node 공용)
   기획서 §4.1(단어 SRS·확신도 3버튼), §4.4(연습·시험 이원화 + 단어 선행 게이트),
   §5.4(오답 클리어·회복 편성), §14-1(출발선 진단 + 안정화 스케줄러).
   '암기 완료'는 2층이다: [기준 도달] = 힌트 없는 완전 인출 1회 성공,
   [안정화] = 도달 후 서로 다른 날 3회 재도달(successive relearning).
   모든 함수는 now(ms)를 밖에서 받는다 — Date.now() 금지(테스트 가능성). */
var WBNAESIN = (function () {
  var DAY = 86400000;
  var MIN10 = 600000;
  /* 시험대비 압축 간격표(§4.1) — 워드브레인의 장기 간격을 마감형으로 재배치 */
  var INTERVAL_DAYS = [0.5, 1, 2, 3, 5, 7];
  var STAGE_MAX = 6;          // 본문 사다리 6단계(§4.2) — 6단계(백지) 통과 = 암송 완료
  var RELEARN_TARGET = 3;     // 안정화 = 서로 다른 날 3회 재도달(§14-1)
  var RISKY_WRONG = 3;        // 오답 이만큼이면 '위험' 단어로 집계

  /* 로컬 달력 날짜 'YYYY-MM-DD' — '다른 날' 판정은 전부 이 문자열 비교로 한다 */
  function localDate(now) {
    var d = new Date(now);
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  /* 'YYYY-MM-DD'까지 남은 로컬 일수 (오늘=0, 내일=1, 지났으면 음수) */
  function daysUntil(ymd, now) {
    var p = ymd.split('-');
    var target = new Date(+p[0], +p[1] - 1, +p[2]).getTime();
    var d = new Date(now);
    var today = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return Math.round((target - today) / DAY);
  }

  /* 문장 상태의 키 규약 — states 맵에서 문장은 이 키로 찾는다 */
  function sentenceId(seq) { return 's-' + seq; }

  function createState(id, kind, now) {
    var s = {
      id: id, kind: kind,
      reached: false, reachedAt: null,               // 기준 도달(완전 인출 1회)
      relearnCount: 0, lastCriterionDate: null,      // 안정화 0~3회전 + 마지막 성공 날짜
      step: 0, due: now, streak: 0, wrong: 0, lapses: 0,
      needsSpellCheck: false,                        // 진단(4지선다) 통과분 철자 재검증 플래그
      overconfident: 0, last: null
    };
    if (kind === 'sentence') s.stage = 1;            // 사다리 단계는 문장만
    return s;
  }

  /* 오답 공통 처리 — 오답+확실은 과신 오류(§14-1): 2계단 후퇴 + 최우선 재출제 */
  function fail(s, confidence, now) {
    s.wrong += 1; s.lapses += 1; s.streak = 0;
    s.due = now + MIN10;
    if (confidence === 'sure') {
      s.overconfident += 1;
      s.step = Math.max(0, s.step - 2);
    } else {
      s.step = Math.max(0, s.step - 1);
    }
    return s;
  }

  /* 일반 판정 퀴즈(4지선다·빈칸 등) — result: {correct, confidence:'sure'|'unsure'|'guess', hinted} */
  function recordQuiz(s, result, now) {
    s.last = now;
    if (!result.correct) return fail(s, result.confidence, now);
    if (result.confidence === 'guess' || result.hinted) {
      /* 찍어서 맞음·힌트 보고 맞음 — 인출 증거가 아니므로 간격을 안 올린다(내일 다시) */
      s.streak = 0;
      s.due = now + DAY;
    } else {
      s.streak += 1;
      s.step = Math.min(s.step + 1, INTERVAL_DAYS.length - 1);
      s.due = now + INTERVAL_DAYS[s.step] * DAY;
    }
    return s;
  }

  /* 완전 인출 성공 공통 처리 — 최초면 도달, 이후엔 '다른 날'일 때만 안정화 +1.
     같은 날 여러 번 성공해도 1회만(§14-1 successive relearning). */
  function criterionSuccess(s, confidence, now) {
    var d = localDate(now);
    s.streak += 1;
    s.needsSpellCheck = false;   // 철자까지 쳐냈으면 재검증 끝
    if (!s.reached) {
      s.reached = true; s.reachedAt = now; s.lastCriterionDate = d;
    } else if (s.lastCriterionDate !== d) {
      s.relearnCount = Math.min(RELEARN_TARGET, s.relearnCount + 1);
      s.lastCriterionDate = d;
    }
    if (confidence === 'guess') {
      s.due = now + DAY;         // 완전 인출이어도 찍음이면 간격 동결
    } else {
      s.step = Math.min(s.step + 1, INTERVAL_DAYS.length - 1);
      s.due = now + INTERVAL_DAYS[s.step] * DAY;
    }
    return s;
  }

  /* 힌트 없는 완전 인출 시도(철자 입력·백지 등) — result: {correct, confidence} */
  function recordCriterion(s, result, now) {
    s.last = now;
    if (!result.correct) return fail(s, result.confidence, now);
    return criterionSuccess(s, result.confidence, now);
  }

  /* 안정도 게이지 0~3칸(§4.1) — 도달 전엔 0 */
  function stability(s) { return s.reached ? s.relearnCount : 0; }
  function isStable(s) { return s.relearnCount >= RELEARN_TARGET; }

  /* 출발선 진단(§14-1) — results: [{id, known}]. '안다'는 신규 큐를 건너뛰지만
     4지선다 재인은 관대하므로 철자 재검증 플래그를 달고, 안정화는 0부터 다시 센다. */
  function applyDiagnostic(states, results, now) {
    (results || []).forEach(function (r) {
      var s = states[r.id];
      if (!s || !r.known) return;   // 모름은 그대로 신규 큐
      s.reached = true;
      if (s.reachedAt == null) s.reachedAt = now;
      s.needsSpellCheck = true;
      s.relearnCount = 0;
      s.last = now;
    });
    return states;
  }

  function values(states) {
    var out = [], k;
    for (k in states) if (Object.prototype.hasOwnProperty.call(states, k)) out.push(states[k]);
    return out;
  }

  /* "77개 중 안정화 n개 · 도달 m개 · 위험 k개"(§4.1 진도) */
  function wordSummary(states) {
    var out = { total: 0, reached: 0, stable: 0, risky: 0, needsSpellCheck: 0 };
    values(states).forEach(function (s) {
      if (s.kind === 'sentence') return;
      out.total += 1;
      if (s.reached) out.reached += 1;
      if (isStable(s)) out.stable += 1;
      if (s.wrong >= RISKY_WRONG || s.overconfident > 0) out.risky += 1;
      if (s.needsSpellCheck) out.needsSpellCheck += 1;
    });
    return out;
  }

  /* 게이트 판정의 공통 핵 — 우선순위: 연습 > 오버라이드 > 전원 도달 > 병행 > 잠김 */
  function gateDecision(done, total, exam, opts) {
    opts = opts || {};
    if (!exam) return { open: true, reason: 'practice' };        // 연습 모드는 게이트 없음(§4.4)
    if (opts.override === true) return { open: true, reason: 'override' };  // 강사 원터치(§14-4)
    if (done >= total) return { open: true, reason: 'reached' };
    if (opts.parallel === true) return { open: true, reason: 'parallel' };  // UI가 단어 5개 선차감
    return { open: false, reason: 'word-gate' };
  }

  /* 단어 선행 완성 게이트(§4.4) — 시험 모드에서 본문 5·6단계·실전 트랙 개방 여부 */
  function gate(wordStates, exam, now, opts) {
    var done = 0, total = 0;
    values(wordStates).forEach(function (s) {
      if (s.kind === 'sentence') return;
      total += 1;
      if (s.reached) done += 1;
    });
    var g = gateDecision(done, total, exam, opts);
    return { open: g.open, reason: g.reason, done: done, total: total };
  }

  /* 오답노트 클리어(§5.4 v1.2) — 서로 다른 날 2회 정답이면 클리어.
     같은 세션 연속 정답은 단기 기억 재확인일 뿐이라 날짜 중복은 안 쌓인다. */
  function clearWrong(s, now) {
    var d = localDate(now);
    if (!s.wrongClearDates) s.wrongClearDates = [];
    if (s.wrongClearDates.indexOf(d) < 0) s.wrongClearDates.push(d);
    return { cleared: s.wrongClearDates.length >= 2, days: s.wrongClearDates.length };
  }

  /* 오늘의 플랜(§5.4 회복 내장 편성) — 매 호출이 전면 재계산이다.
     "밀린 것 N개"는 없다: 미도달 잔량을 잔여일로 나눈 '오늘의 새 플랜'만 있다.
     시험 모드: 단어 초회 도달 마감 = 시험 D-wordDeadlineDays(기본 7),
     D-7~D-1엔 도달 단어의 안정화 회전을 잔여일로 나눠 배분(§14-1 망각 사각지대 방지). */
  function planDay(pack, states, exam, now, opts) {
    opts = opts || {};
    var maxNew = opts.maxNewWords == null ? 10 : opts.maxNewWords;
    var maxRe = opts.maxRelearn == null ? 15 : opts.maxRelearn;
    var maxSen = opts.maxSentences == null ? 5 : opts.maxSentences;
    var today = localDate(now);
    var mode = exam ? 'exam' : 'practice';
    var dday = exam ? daysUntil(exam.examDate, now) : null;
    var deadlineDays = exam && exam.wordDeadlineDays != null ? exam.wordDeadlineDays : 7;

    var wordsArr = (pack && pack.words) || [];
    var freshCand = [], reviewCand = [], relearnCand = [];
    var rotations = 0, reachedN = 0;
    wordsArr.forEach(function (w) {
      var s = states[w.id];
      if (s && s.reached) {
        reachedN += 1;
        if (s.relearnCount >= RELEARN_TARGET) return;      // 안정화 완료 — 오늘 몫 없음
        if (s.lastCriterionDate === today) return;         // 오늘 이미 성공 — 같은 날 중복 불인정
        if (!exam && s.due > now) return;                  // 연습 모드는 due 기준
        relearnCand.push(w.id);
        rotations += RELEARN_TARGET - s.relearnCount;
      } else if (!s || s.last == null) {
        freshCand.push(w.id);                              // 손도 안 댄 단어
      } else if (s.due <= now) {
        reviewCand.push(w.id);                             // 학습 중 + 만기
      }
    });

    /* 신규 할당 — 미도달 잔량 ÷ 마감까지 잔여일 (마감 당일·경과면 오늘 다, 상한만 적용) */
    var fresh, lateDeadline = false;
    if (exam) {
      var remain = dday - deadlineDays;
      if (remain < 1) { remain = 1; lateDeadline = freshCand.length > 0; }
      fresh = freshCand.slice(0, Math.min(maxNew, Math.ceil(freshCand.length / remain)));
    } else {
      fresh = freshCand.slice(0, maxNew);
    }

    var review = reviewCand.slice().sort(function (a, b) { return states[a].due - states[b].due; });

    /* 안정화 회전 — 시험 모드는 D-deadlineDays~D-1 구간에 잔여 회전 ÷ 잔여일 */
    var relearn = [];
    if (exam) {
      if (dday >= 1 && dday <= deadlineDays && relearnCand.length > 0) {
        var n = Math.min(relearnCand.length, maxRe, Math.ceil(rotations / dday));
        relearn = relearnCand.slice(0, n);
      }
    } else {
      relearn = relearnCand.slice(0, maxRe);
    }

    /* 문장 — 단락(seq) 순서로, 암송 완료 전 문장의 현재 단계 도전.
       게이트 잠김이면 5·6단계는 보류(§4.4 — 병행·오버라이드면 열린다). */
    var g = gateDecision(reachedN, wordsArr.length, exam, opts);
    var sentences = [];
    ((pack && pack.sentences) || []).slice()
      .sort(function (a, b) { return a.seq - b.seq; })
      .forEach(function (sen) {
        if (sentences.length >= maxSen) return;
        var s = states[sentenceId(sen.seq)];
        if (s && s.reached) return;                        // 백지 통과 — 오늘 도전 없음
        var stage = s ? s.stage : 1;
        if (!g.open && stage >= 5) return;
        sentences.push({ seq: sen.seq, stage: stage });
      });

    var parts = [];
    if (exam) {
      parts.push('D-' + dday);
      if (lateDeadline) parts.push('단어 마감 경과 — 회복 편성');
      if (!g.open) parts.push('단어 게이트 잠김(5·6단계 보류)');
      if (g.reason === 'parallel') parts.push('병행 모드 — 미완성 단어 선차감');
    } else {
      parts.push('연습 모드 — 자율 진도');
    }
    parts.push('신규 ' + fresh.length + '/' + freshCand.length +
      ' · 복습 ' + review.length + ' · 안정화 ' + relearn.length);

    return {
      mode: mode, dday: dday,
      words: { fresh: fresh, review: review, relearn: relearn },
      sentences: sentences, note: parts.join(' · ')
    };
  }

  /* 성취도 화면의 원천(§4.2) — 해석은 2단계에서 먼저 잡고, 백지가 최종 관문 */
  function sentenceSummary(states) {
    var out = { total: 0, byStage: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }, interpreted: 0, memorized: 0 };
    values(states).forEach(function (s) {
      if (s.kind !== 'sentence') return;
      out.total += 1;
      out.byStage[s.stage] += 1;
      if (s.stage >= 3) out.interpreted += 1;   // 2단계(해석 쓰기) 통과 — 목표①
      if (s.reached) out.memorized += 1;        // 6단계(백지) 통과 — 목표②
    });
    return out;
  }

  /* 문장 사다리 진급(§4.2) — 통과 시 다음 단계, 6단계 통과는 완전 인출 성공으로
     처리해 단어와 같은 안정화 규칙(서로 다른 날 3회)을 탄다. 실패는 단계 유지. */
  function advanceStage(s, passed, now) {
    s.last = now;
    if (!passed) return s;
    if (s.stage < STAGE_MAX) { s.stage += 1; return s; }
    return criterionSuccess(s, null, now);
  }

  return {
    DAY: DAY, MIN10: MIN10, INTERVAL_DAYS: INTERVAL_DAYS,
    STAGE_MAX: STAGE_MAX, RELEARN_TARGET: RELEARN_TARGET,
    localDate: localDate, daysUntil: daysUntil, sentenceId: sentenceId,
    createState: createState, recordQuiz: recordQuiz, recordCriterion: recordCriterion,
    stability: stability, isStable: isStable,
    applyDiagnostic: applyDiagnostic, wordSummary: wordSummary,
    gate: gate, clearWrong: clearWrong, planDay: planDay,
    sentenceSummary: sentenceSummary, advanceStage: advanceStage
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WBNAESIN;
