'use strict';
/* WB 국어브레인 — 학습 엔진 (순수 로직, 브라우저/Node 공용)
   기획서(docs/국어내신-학습웹앱-기획서-v1.md) §4.1 사다리 5단계, §4.2 어휘·개념어 상시 큐,
   §4.6 모드 3종·적용 정답률 게이트, §5.4 D-21 플랜·오답 클리어.

   내신브레인(영어) engine.js에서 가져온 것: 2층 암기 모델(도달/안정화)·확신도 3버튼·
   오답 클리어·날짜 유틸. 새로 쓴 것: kind 3종(vocab|blank|work)을 아는 planDay,
   D-21 밴드 편성, 적용 정답률 게이트, 5단계 요약.

   왜 포크했나: 영어 엔진은 STAGE_MAX·게이트 단계·pack.words/sentences 형태가
   IIFE 클로저 상수로 굳어 있어 주입이 안 된다(기획서 §9.1). shared 승격은 §13-8.

   모든 함수는 now(ms)를 밖에서 받는다 — Date.now() 금지(테스트 가능성). */
var WBKOENGINE = (function () {
  var DAY = 86400000;
  var MIN10 = 600000;
  /* 시험대비 압축 간격표 — 국어도 마감형이라 영어와 같은 배치를 쓴다 */
  var INTERVAL_DAYS = [0.5, 1, 2, 3, 5, 7];
  var STAGE_MAX = 5;          // 사다리 5단계(§4.1) — 5단계는 서술형
  var DONE_STAGE = 4;         // 4단계(지문 주석 복원) 통과 = '작품 개관 완료'
  var RELEARN_TARGET = 3;     // 안정화 = 서로 다른 날 3회 재도달
  var RISKY_WRONG = 3;        // 오답 이만큼이면 '위험' 항목으로 집계
  var APPLY_GATE_RATE = 0.8;  // 3단계 적용 정답률 게이트 기본값(§4.1 — 파일럿 초기값)
  var PLAN_START_DDAY = 21;   // D-21 플랜 창(§5.4) — 국어는 3~4주 전 시작이 통설
  var ESSAY_START_DDAY = 14;  // 서술형 착수 — 자동 피드백은 3회 이상 세션이 있어야 는다

  /* 로컬 달력 날짜 'YYYY-MM-DD' — '다른 날' 판정은 전부 이 문자열 비교로 한다 */
  function localDate(now) {
    var d = new Date(now);
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  /* 'YYYY-MM-DD'까지 남은 로컬 일수 (오늘=0, 내일=1, 지났으면 음수) */
  function daysUntil(ymd, now) {
    var p = String(ymd || '').split('-');
    var target = new Date(+p[0], +p[1] - 1, +p[2]).getTime();
    var d = new Date(now);
    var today = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return Math.round((target - today) / DAY);
  }

  /* 상태 맵 키 규약 — 콘텐츠 id에서 기계적으로 유도한다(영어 팩 관례와 같은 결) */
  function vocabKey(id) { return 'v-' + id; }
  function blankKey(id) { return 'b-' + id; }
  function workKey(id) { return 'w-' + id; }

  function createState(id, kind, now) {
    var s = {
      id: id, kind: kind,
      reached: false, reachedAt: null,               // 기준 도달(힌트 없는 완전 인출 1회)
      relearnCount: 0, lastCriterionDate: null,      // 안정화 0~3회전 + 마지막 성공 날짜
      step: 0, due: now, streak: 0, wrong: 0, lapses: 0,
      needsRecheck: false,                           // 진단(4지선다) 통과분 재검증 플래그
      overconfident: 0, last: null
    };
    if (kind === 'work') { s.stage = 1; s.applyRight = 0; s.applyTotal = 0; }
    return s;
  }

  /* 오답 공통 처리 — 오답+확실은 과신 오류: 2계단 후퇴 + 최우선 재출제 */
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

  /* 일반 판정 퀴즈(4·5지선다·OX·빈칸 등) — result: {correct, confidence, hinted} */
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
     같은 날 여러 번 성공해도 1회만(successive relearning). */
  function criterionSuccess(s, confidence, now) {
    var d = localDate(now);
    s.streak += 1;
    s.needsRecheck = false;
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

  /* 힌트 없는 완전 인출 시도(빈칸 단답 입력·주석 복원 등) */
  function recordCriterion(s, result, now) {
    s.last = now;
    if (!result.correct) return fail(s, result.confidence, now);
    return criterionSuccess(s, result.confidence, now);
  }

  /* 3단계 구절 적용 기록 — 작품 상태에 정답률을 누적한다(게이트의 입력, §4.6).
     정답률은 '최근'이 아니라 누계다: 표본이 작을 때 한두 문항으로 게이트가
     열렸다 닫혔다 하는 것을 막는다. */
  function recordApply(s, correct, now) {
    s.last = now;
    if (s.applyTotal == null) { s.applyRight = 0; s.applyTotal = 0; }
    s.applyTotal += 1;
    if (correct) s.applyRight += 1; else s.wrong += 1;
    return s;
  }

  function applyRate(s) {
    if (!s || !s.applyTotal) return 0;
    return s.applyRight / s.applyTotal;
  }

  /* 안정도 게이지 0~3칸 — 도달 전엔 0 */
  function stability(s) { return s && s.reached ? s.relearnCount : 0; }
  function isStable(s) { return !!s && s.relearnCount >= RELEARN_TARGET; }

  /* 출발선 진단 — results: [{key, known}]. '안다'는 신규 큐를 건너뛰지만
     선다형 재인은 관대하므로 재검증 플래그를 달고 안정화는 0부터 다시 센다. */
  function applyDiagnostic(states, results, now) {
    (results || []).forEach(function (r) {
      var s = states[r.key];
      if (!s || !r.known) return;   // 모름은 그대로 신규 큐
      s.reached = true;
      if (s.reachedAt == null) s.reachedAt = now;
      s.needsRecheck = true;
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

  /* 어휘·개념어 / 개념 빈칸 진도 요약 — kind로 나눠 센다 */
  function kindSummary(states, kind) {
    var out = { total: 0, reached: 0, stable: 0, risky: 0, needsRecheck: 0 };
    values(states).forEach(function (s) {
      if (s.kind !== kind) return;
      out.total += 1;
      if (s.reached) out.reached += 1;
      if (isStable(s)) out.stable += 1;
      if (s.wrong >= RISKY_WRONG || s.overconfident > 0) out.risky += 1;
      if (s.needsRecheck) out.needsRecheck += 1;
    });
    return out;
  }

  /* 작품 × 단계 매트릭스의 원천(§4.1). '완료'는 4단계 통과 하나가 아니다 —
     적용 정답률 + 주석 복원 + 서술형 1회전을 모두 본다(§11 North Star와 같은 정의). */
  function workSummary(states, opts) {
    opts = opts || {};
    var rate = opts.applyGateRate == null ? APPLY_GATE_RATE : opts.applyGateRate;
    var out = {
      total: 0, byStage: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      applied: 0, restored: 0, essayDone: 0, complete: 0
    };
    values(states).forEach(function (s) {
      if (s.kind !== 'work') return;
      out.total += 1;
      out.byStage[s.stage] = (out.byStage[s.stage] || 0) + 1;
      var okApply = s.applyTotal > 0 && applyRate(s) >= rate;
      if (okApply) out.applied += 1;
      if (s.reached) out.restored += 1;          // 4단계(주석 복원) 통과
      if (s.essayDone) out.essayDone += 1;
      if (okApply && s.reached && s.essayDone) out.complete += 1;
    });
    return out;
  }

  /* 게이트 판정의 공통 핵 — 우선순위: 연습 > 오버라이드 > 정답률 도달 > 병행 > 잠김.
     영어는 '단어 선행'이 게이트였지만 국어의 전제는 어휘가 아니라 적용 능력이다(§4.6). */
  function gateDecision(rate, threshold, exam, opts) {
    opts = opts || {};
    if (!exam) return { open: true, reason: 'practice' };                    // 연습 모드는 게이트 없음
    if (opts.override === true) return { open: true, reason: 'override' };   // 강사 원터치
    if (rate >= threshold) return { open: true, reason: 'applied' };
    if (opts.parallel === true) return { open: true, reason: 'parallel' };   // 병행 모드
    return { open: false, reason: 'apply-gate' };
  }

  /* 작품 단위 게이트 — 실전 객관식·서술형 트랙 개방 여부(§4.6).
     적용 시도가 아직 없으면(applyTotal=0) 잠긴 것으로 본다 — 안 풀어 본 작품이
     '정답률 0'으로 열려 버리면 게이트가 무의미해진다. */
  function gate(workState, exam, opts) {
    opts = opts || {};
    var threshold = opts.applyGateRate == null ? APPLY_GATE_RATE : opts.applyGateRate;
    var rate = applyRate(workState);
    var g = gateDecision(rate, threshold, exam, opts);
    return {
      open: g.open, reason: g.reason, rate: rate, threshold: threshold,
      right: (workState && workState.applyRight) || 0,
      total: (workState && workState.applyTotal) || 0
    };
  }

  /* 오답노트 클리어 — 서로 다른 날 2회 정답이면 클리어.
     같은 세션 연속 정답은 단기 기억 재확인일 뿐이라 날짜 중복은 안 쌓인다. */
  function clearWrong(s, now) {
    var d = localDate(now);
    if (!s.wrongClearDates) s.wrongClearDates = [];
    if (s.wrongClearDates.indexOf(d) < 0) s.wrongClearDates.push(d);
    return { cleared: s.wrongClearDates.length >= 2, days: s.wrongClearDates.length };
  }

  /* D-day 밴드(§5.4) — 남은 날에 따라 오늘 무엇에 무게를 두는지.
     연습 모드(dday=null)는 'practice' 한 가지다. */
  function band(dday) {
    if (dday == null) return 'practice';
    if (dday <= 1) return 'taper';       // D-1: 새 학습 차단, 성장 리플레이
    if (dday <= 3) return 'mock';        // D-3~2: 종합 모의·오답 총정리
    if (dday <= 7) return 'restore';     // D-7~4: 주석 복원·확인 문제·실전
    if (dday <= 14) return 'apply';      // D-14~8: 구절 적용 + 서술형 착수
    return 'intake';                     // D-21~15: 읽기 + 개념 빈칸 + 어휘
  }

  var BAND_LABEL = {
    practice: '연습 모드 — 자율 진도',
    intake: '읽기·개념 빈칸 중심',
    apply: '구절 적용 + 서술형 착수',
    restore: '주석 복원·실전 문항',
    mock: '종합 모의·오답 총정리',
    taper: '테이퍼링 — 새 학습 없이 정리만'
  };

  /* SRS 큐 하나를 고르는 공통 절차 — vocab·blank가 같은 규칙을 쓴다.
     반환: {fresh, review, relearn, freshTotal} */
  function pickQueue(ids, states, keyFn, exam, dday, now, limits) {
    var today = localDate(now);
    var fresh = [], review = [], relearn = [], rotations = 0;
    ids.forEach(function (id) {
      var s = states[keyFn(id)];
      if (s && s.reached) {
        if (s.relearnCount >= RELEARN_TARGET) return;     // 안정화 완료 — 오늘 몫 없음
        if (s.lastCriterionDate === today) return;        // 오늘 이미 성공 — 같은 날 중복 불인정
        if (!exam && s.due > now) return;                 // 연습 모드는 due 기준
        relearn.push(id);
        rotations += RELEARN_TARGET - s.relearnCount;
      } else if (!s || s.last == null) {
        fresh.push(id);                                   // 손도 안 댄 항목
      } else if (s.due <= now) {
        review.push(id);                                  // 학습 중 + 만기
      }
    });
    var freshTotal = fresh.length;
    /* 신규 할당 — 잔량 ÷ 남은 날. 마감이 지났으면 상한까지 몰아서 낸다(회복 편성).
       "밀린 것 N개"는 학생에게 보이지 않는다 — 늘 '오늘의 새 플랜'만 있다. */
    var days = exam ? Math.max(1, dday - 1) : 1;
    var freshN = exam ? Math.min(limits.fresh, Math.ceil(fresh.length / days)) : limits.fresh;
    var out = {
      fresh: fresh.slice(0, freshN),
      review: review.sort(function (a, b) { return states[keyFn(a)].due - states[keyFn(b)].due; })
        .slice(0, limits.review),
      relearn: [],
      freshTotal: freshTotal
    };
    if (exam) {
      /* 안정화 회전은 남은 날로 나눠 배분한다 — 시험일에 가장 취약해지는 것을 막는다 */
      var n = Math.min(relearn.length, limits.relearn, Math.ceil(rotations / Math.max(1, dday)));
      out.relearn = relearn.slice(0, n);
    } else {
      out.relearn = relearn.slice(0, limits.relearn);
    }
    return out;
  }

  /* 오늘의 플랜(§5.4) — 매 호출이 전면 재계산이다.
     pack: {works:[{workId, blanks:[{id}], vocab:[{id}]}], ...} 형태를 받아
     vocab·blank·work 세 축의 오늘 몫을 낸다.
     exam: {examDate, profile:{essayWeight}} — essayWeight가 높으면 서술형을 앞당긴다. */
  function planDay(pack, states, exam, now, opts) {
    opts = opts || {};
    var dday = exam && exam.examDate ? daysUntil(exam.examDate, now) : null;
    var bd = band(dday);
    var works = (pack && pack.works) || [];

    /* 밴드별 가중 — 같은 큐라도 오늘 얼마나 낼지가 달라진다 */
    var W = {
      practice: { vocab: 10, blank: 12, works: 2 },
      intake: { vocab: 12, blank: 16, works: 2 },
      apply: { vocab: 8, blank: 12, works: 3 },
      restore: { vocab: 6, blank: 10, works: 4 },
      mock: { vocab: 5, blank: 8, works: 5 },
      taper: { vocab: 4, blank: 6, works: 5 }
    }[bd];

    var vocabIds = [], blankIds = [];
    works.forEach(function (w) {
      (w.vocab || []).forEach(function (v) { vocabIds.push(v.id); });
      (w.blanks || []).forEach(function (b) { blankIds.push(b.id); });
    });

    var newLimit = bd === 'taper' ? 0 : W.vocab;          // 테이퍼링은 새 학습을 막는다
    var vocab = pickQueue(vocabIds, states, vocabKey, exam, dday, now,
      { fresh: opts.maxNewVocab == null ? newLimit : opts.maxNewVocab, review: 20, relearn: 15 });
    var blanks = pickQueue(blankIds, states, blankKey, exam, dday, now,
      { fresh: bd === 'taper' ? 0 : (opts.maxNewBlanks == null ? W.blank : opts.maxNewBlanks), review: 25, relearn: 20 });

    /* 작품 — 완료되지 않은 것부터 현재 단계로. 게이트가 잠긴 작품은 5단계를 보류한다. */
    var threshold = opts.applyGateRate == null ? APPLY_GATE_RATE : opts.applyGateRate;
    var workList = [];
    works.forEach(function (w) {
      if (workList.length >= W.works) return;
      var s = states[workKey(w.workId)];
      var stage = s ? s.stage : 1;
      var g = gate(s, exam, { applyGateRate: threshold, override: opts.override, parallel: opts.parallel });
      if (s && s.reached && s.essayDone && g.open) return;     // 완료된 작품은 오늘 몫 없음
      if (!g.open && stage >= 5) stage = 3;                    // 잠기면 적용 단계로 되돌린다
      workList.push({ workId: w.workId, stage: stage, gateOpen: g.open, applyRate: g.rate });
    });

    /* 서술형 — D-14부터(서술형 배점이 높으면 D-21부터) 매일 1문항 이상.
       영어의 '단어 게이트 뒤 5단계'와 달리 국어는 서술형을 뒤로 미루지 않는다:
       지필 배점의 20~40%인데 D-3에 몰아 하면 연습 횟수가 안 나온다(§1.4-3·5). */
    var essayWeight = (exam && exam.profile && exam.profile.essayWeight) || 0;
    var essayStart = essayWeight >= 0.3 ? PLAN_START_DDAY : ESSAY_START_DDAY;
    var essay = 0;
    if (exam && dday != null && dday >= 1 && dday <= essayStart) {
      essay = bd === 'taper' ? 1 : (bd === 'mock' ? 3 : (bd === 'restore' ? 2 : 1));
    } else if (!exam) {
      essay = opts.practiceEssay == null ? 1 : opts.practiceEssay;
    }

    var parts = [];
    if (exam && dday != null) {
      parts.push('D-' + dday);
      parts.push(BAND_LABEL[bd]);
      if (dday > PLAN_START_DDAY) parts.push('시험 창 전 — 평시 진도');
    } else {
      parts.push(BAND_LABEL.practice);
    }
    parts.push('어휘 ' + (vocab.fresh.length + vocab.review.length + vocab.relearn.length) +
      ' · 개념 ' + (blanks.fresh.length + blanks.review.length + blanks.relearn.length) +
      ' · 작품 ' + workList.length + ' · 서술형 ' + essay);

    return {
      mode: exam ? 'exam' : 'practice', dday: dday, band: bd,
      vocab: vocab, blanks: blanks, works: workList, essay: essay,
      note: parts.join(' · ')
    };
  }

  /* 사다리 진급(§4.1) — 통과 시 다음 단계.
     4단계(주석 복원) 통과는 완전 인출 성공으로 처리해 안정화 규칙을 태우고,
     5단계(서술형) 통과는 essayDone으로 따로 표시한다 — 완료 정의가 2층이기 때문. */
  function advanceStage(s, passed, now) {
    s.last = now;
    if (!passed) return s;
    if (s.stage < DONE_STAGE) { s.stage += 1; return s; }
    if (s.stage === DONE_STAGE) { s.stage = STAGE_MAX; return criterionSuccess(s, null, now); }
    s.essayDone = true;
    return criterionSuccess(s, null, now);
  }

  return {
    DAY: DAY, MIN10: MIN10, INTERVAL_DAYS: INTERVAL_DAYS,
    STAGE_MAX: STAGE_MAX, DONE_STAGE: DONE_STAGE, RELEARN_TARGET: RELEARN_TARGET,
    APPLY_GATE_RATE: APPLY_GATE_RATE, PLAN_START_DDAY: PLAN_START_DDAY, ESSAY_START_DDAY: ESSAY_START_DDAY,
    localDate: localDate, daysUntil: daysUntil,
    vocabKey: vocabKey, blankKey: blankKey, workKey: workKey,
    createState: createState, recordQuiz: recordQuiz, recordCriterion: recordCriterion,
    recordApply: recordApply, applyRate: applyRate,
    stability: stability, isStable: isStable, applyDiagnostic: applyDiagnostic,
    kindSummary: kindSummary, workSummary: workSummary,
    gateDecision: gateDecision, gate: gate, clearWrong: clearWrong,
    band: band, planDay: planDay, advanceStage: advanceStage
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WBKOENGINE;
