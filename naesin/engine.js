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
  /* '다른 날' 재도달의 최소 간격 — 23:59/00:01 두 번은 달력상 이틀이지만 기억엔 한 세션이다 */
  var CRITERION_GAP_MS = 8 * 3600000;
  /* 같은 단계에서 이 시간 안에 두 번 진급하지 않는다 — 한 세트(클로즈+배열)가 문항마다
     advanceStage를 부르면 4단계에서 6단계로 건너뛰어 영작(5단계)이 사라진다 */
  var STAGE_GUARD_MS = 60000;
  /* 시험대비 압축 간격표(§4.1) — 워드브레인의 장기 간격을 마감형으로 재배치 */
  var INTERVAL_DAYS = [0.5, 1, 2, 3, 5, 7];
  var STAGE_MAX = 6;          // 본문 사다리 6단계(§4.2) — 6단계(백지) 통과 = 암송 완료
  var RELEARN_TARGET = 3;     // 안정화 = 서로 다른 날 3회 재도달(§14-1)
  var RISKY_WRONG = 3;        // 오답 이만큼이면 '위험' 단어로 집계

  /* now는 ms 숫자가 정본이다 — Date를 그대로 받으면 now + DAY가 문자열 연결이 되어
     due가 "Tue Sep 01 ..."이 된다. 모든 공개 함수 입구에서 한 번 정규화한다. */
  function ms(now) { return now instanceof Date ? now.getTime() : +now; }

  /* 로컬 달력 날짜 'YYYY-MM-DD' — '다른 날' 판정은 전부 이 문자열 비교로 한다 */
  function localDate(now) {
    var d = new Date(ms(now));
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  /* 'YYYY-MM-DD'까지 남은 로컬 일수 (오늘=0, 내일=1, 지났으면 음수) */
  function daysUntil(ymd, now) {
    var p = String(ymd).split('-');
    var target = new Date(+p[0], +p[1] - 1, +p[2]).getTime();
    var d = new Date(ms(now));
    var today = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return Math.round((target - today) / DAY);
  }

  /* 시험 설정이 '쓸 만한' 것인가 — examDate가 없으면 시험 모드가 아니라 연습 모드다.
     {examDate: undefined}로 daysUntil이 터지는 것보다 조용히 연습으로 가는 게 맞다. */
  function examOf(exam) {
    if (!exam || typeof exam.examDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(exam.examDate)) return null;
    return exam;
  }

  /* 문장 상태의 키 규약 — states 맵에서 문장은 이 키로 찾는다 */
  function sentenceId(seq) { return 's-' + seq; }

  /* kind: 'word' | 'sentence' | 'dialogue'. 사다리 단계(stage)는 문장·대화문만 갖는다.
     대화문은 어느 집계(단어·본문)에도 섞이지 않게 별도 kind다. */
  function createState(id, kind, now) {
    now = ms(now);
    var s = {
      id: id, kind: kind,
      reached: false, reachedAt: null,               // 기준 도달(완전 인출 1회)
      relearnCount: 0, lastCriterionDate: null,      // 안정화 0~3회전 + 마지막 성공 날짜
      lastCriterionAt: null,                         // 마지막 성공 시각(ms) — 자정 걸침 방지
      step: 0, due: now, streak: 0, wrong: 0, lapses: 0,
      needsSpellCheck: false,                        // 진단(4지선다) 통과분 철자 재검증 플래그
      overconfident: 0, last: null
    };
    if (kind === 'sentence' || kind === 'dialogue') s.stage = 1;
    return s;
  }

  /* 오답 공통 처리 — 오답+확실은 과신 오류(§14-1): 2계단 후퇴 + 최우선 재출제.
     안정화 회전도 깎는다(확실이면 2회전) — 안정화가 끝난 단어도 틀리면 다시 편성돼야
     시험 직전 망각이 잡힌다. 날짜 기록을 지워 오늘 다시 성공하면 회복으로 센다. */
  function fail(s, confidence, now) {
    s.wrong += 1; s.lapses += 1; s.streak = 0;
    s.due = now + MIN10;
    var drop = 1;
    if (confidence === 'sure') {
      s.overconfident += 1;
      s.step = Math.max(0, s.step - 2);
      drop = 2;
    } else {
      s.step = Math.max(0, s.step - 1);
    }
    s.relearnCount = Math.max(0, (s.relearnCount || 0) - drop);
    s.lastCriterionDate = null;
    s.lastCriterionAt = null;
    return s;
  }

  /* 일반 판정 퀴즈(4지선다·빈칸 등) — result: {correct, confidence:'sure'|'unsure'|'guess', hinted} */
  function recordQuiz(s, result, now) {
    now = ms(now);
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

  /* 완전 인출 성공 공통 처리 — 최초면 도달, 이후엔 '다른 날'(달력이 다르고 8시간 이상
     지남)일 때만 안정화 +1. 같은 날 여러 번 성공해도 1회만(§14-1 successive relearning).
     '찍음'은 회전으로 안 센다 — 최초 도달만 허용하되 철자 재검증을 달아 진짜 인출을 한 번
     더 요구한다. */
  function criterionSuccess(s, confidence, now) {
    var d = localDate(now);
    if (confidence === 'guess') {
      s.streak = 0;
      s.due = now + DAY;
      if (!s.reached) { s.reached = true; s.reachedAt = now; s.needsSpellCheck = true; }
      s.lastCriterionAt = now;   // 같은 세션의 재성공이 회전으로 둔갑하지 않게 시각만 남긴다
      return s;
    }
    s.streak += 1;
    s.needsSpellCheck = false;   // 철자까지 쳐냈으면 재검증 끝
    if (!s.reached) {
      s.reached = true; s.reachedAt = now; s.lastCriterionDate = d; s.lastCriterionAt = now;
    } else if (s.lastCriterionDate !== d &&
      (s.lastCriterionAt == null || now - s.lastCriterionAt >= CRITERION_GAP_MS)) {
      s.relearnCount = Math.min(RELEARN_TARGET, s.relearnCount + 1);
      s.lastCriterionDate = d; s.lastCriterionAt = now;
    }
    s.step = Math.min(s.step + 1, INTERVAL_DAYS.length - 1);
    s.due = now + INTERVAL_DAYS[s.step] * DAY;
    return s;
  }

  /* 힌트 없는 완전 인출 시도(철자 입력·백지 등) — result: {correct, confidence, hinted}.
     힌트를 본 철자는 완전 인출이 아니다 — 일반 퀴즈로 처리해 도달로 안 친다. */
  function recordCriterion(s, result, now) {
    now = ms(now);
    if (result.hinted) return recordQuiz(s, result, now);
    s.last = now;
    if (!result.correct) return fail(s, result.confidence, now);
    return criterionSuccess(s, result.confidence, now);
  }

  /* 안정도 게이지 0~3칸(§4.1) — 도달 전엔 0 */
  function stability(s) { return s.reached ? s.relearnCount : 0; }
  function isStable(s) { return s.relearnCount >= RELEARN_TARGET; }
  /* 철자 재검증이 남은 도달은 아직 '완성'이 아니다 — 게이트·요약·플랜이 같은 눈으로 본다 */
  function isDone(s) { return !!(s.reached && !s.needsSpellCheck); }
  /* 오늘 이미 기준 성공했는가 — 달력이 같거나 8시간이 안 지났으면 오늘이다 */
  function successToday(s, now, today) {
    if (s.lastCriterionDate === today) return true;
    return s.lastCriterionAt != null && now - s.lastCriterionAt < CRITERION_GAP_MS;
  }

  /* 출발선 진단(§14-1) — results: [{id, known}]. '안다'는 신규 큐를 건너뛰지만
     4지선다 재인은 관대하므로 철자 재검증 플래그를 달고, 안정화는 0부터 다시 센다. */
  function applyDiagnostic(states, results, now) {
    now = ms(now);
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

  /* "77개 중 안정화 n개 · 도달 m개 · 위험 k개"(§4.1 진도) — 단어(kind 'word')만.
     '위험'은 안정화가 끝나면 해제된다 — 과거 과신 1회가 영구 낙인이면 표시가 의미를 잃는다. */
  function wordSummary(states) {
    var out = { total: 0, reached: 0, stable: 0, risky: 0, needsSpellCheck: 0 };
    values(states).forEach(function (s) {
      if (s.kind !== 'word') return;
      out.total += 1;
      if (isDone(s)) out.reached += 1;
      if (isStable(s)) out.stable += 1;
      if ((s.wrong >= RISKY_WRONG || s.overconfident > 0) && !isStable(s)) out.risky += 1;
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

  /* 단어 선행 완성 게이트(§4.4) — 시험 모드에서 본문 5·6단계·실전 트랙 개방 여부.
     '도달'은 철자 재검증까지 끝난 것만 센다 — 진단 '안다'만으로 열리면 게이트가 없는 셈이다.
     시험이 지났으면 잠글 이유가 없다(연습과 같음). */
  function gate(wordStates, exam, now, opts) {
    now = ms(now);
    exam = examOf(exam);
    if (exam && daysUntil(exam.examDate, now) <= 0) exam = null;
    var done = 0, total = 0;
    values(wordStates).forEach(function (s) {
      if (s.kind !== 'word') return;
      total += 1;
      if (isDone(s)) done += 1;
    });
    var g = gateDecision(done, total, exam, opts);
    return { open: g.open, reason: g.reason, done: done, total: total };
  }

  /* 오답노트 클리어(§5.4 v1.2) — 서로 다른 날 2회 정답이면 클리어.
     같은 세션 연속 정답은 단기 기억 재확인일 뿐이라 날짜 중복은 안 쌓인다.
     다시 틀리면 앱이 wrongClearDates를 비운다(계약 0.6) — 여기선 그 배열만 본다. */
  function clearWrong(s, now) {
    var d = localDate(now);
    if (!Array.isArray(s.wrongClearDates)) s.wrongClearDates = [];
    if (s.wrongClearDates.indexOf(d) < 0) s.wrongClearDates.push(d);
    return { cleared: s.wrongClearDates.length >= 2, days: s.wrongClearDates.length };
  }

  /* 오늘의 플랜(§5.4 회복 내장 편성) — 매 호출이 전면 재계산이다.
     "밀린 것 N개"는 없다: 미도달 잔량을 잔여일로 나눈 '오늘의 새 플랜'만 있다.
     레인(앱 호환): fresh = 손도 안 댄 단어, review = 학습 중·만기(미도달이면 gen이 무힌트
     철자로 도달 기회를 준다), relearn = 완전 인출(무힌트 철자) — 안정화 회전 + 철자 재검증.
     시험 모드: 단어 초회 도달 마감 = 시험 D-wordDeadlineDays(기본 7, 당일 포함),
     D-7~D-1엔 도달 단어의 안정화 회전을 잔여일로 나눠 배분(§14-1 망각 사각지대 방지).
     D-7 전에도 만기 도달 단어는 review로 돌려 SRS를 끊지 않는다. 시험이 지나면(D-0 이하)
     'after' — 신규 편성 없이 자율 복습만. */
  function planDay(pack, states, exam, now, opts) {
    now = ms(now);
    opts = opts || {};
    states = states || {};
    exam = examOf(exam);
    var wordsArr = (pack && pack.words) || [];
    var total = wordsArr.length;
    var deadlineDays = exam && exam.wordDeadlineDays != null ? +exam.wordDeadlineDays : 7;
    if (!(deadlineDays >= 1)) deadlineDays = 7;
    var maxNew = opts.maxNewWords == null ? 10 : opts.maxNewWords;
    /* 안정화 상한 기본값은 팩 크기에서 나온다 — 77단어×3회전을 7일에 끝내려면 하루 33개인데
       늦게 도달한 단어는 앞쪽 며칠을 못 쓰므로 (마감-2)일로 나눠 여유를 둔다 */
    var maxRe = opts.maxRelearn == null
      ? Math.max(15, Math.ceil(total * RELEARN_TARGET / Math.max(1, deadlineDays - 2)))
      : opts.maxRelearn;
    var maxRev = opts.maxReview == null ? 20 : opts.maxReview;
    var maxSen = opts.maxSentences == null ? 5 : opts.maxSentences;
    var today = localDate(now);
    var dday = exam ? daysUntil(exam.examDate, now) : null;
    var mode = !exam ? 'practice' : (dday <= 0 ? 'after' : 'exam');
    var inWindow = mode === 'exam' && dday <= deadlineDays;   // D-마감~D-1 안정화 구간

    var freshCand = [], reviewCand = [], relearnCand = [];
    var rotations = 0, doneN = 0, spellN = 0, order = {};
    wordsArr.forEach(function (w, idx) {
      order[w.id] = idx;
      var s = states[w.id];
      if (!s || s.last == null) { freshCand.push(w.id); return; }          // 손도 안 댄 단어
      if (!s.reached) { if (s.due <= now) reviewCand.push(w.id); return; }  // 학습 중 + 만기
      if (isDone(s)) doneN += 1;
      if (s.needsSpellCheck) {
        /* 진단·찍음 도달분의 철자 재검증 — D-day와 무관하게 매일 상한 안에서 */
        if (successToday(s, now, today)) return;
        relearnCand.push(w.id); spellN += 1;
        rotations += RELEARN_TARGET - s.relearnCount;
        return;
      }
      if (isStable(s)) return;                              // 안정화 완료 — 오늘 몫 없음
      if (successToday(s, now, today)) return;              // 오늘 이미 성공 — 같은 날 중복 불인정
      if (mode === 'exam' && !inWindow) {
        if (s.due <= now) reviewCand.push(w.id);            // D-7 전 — 만기면 복습(SRS 유지)
        return;
      }
      if (mode !== 'exam' && s.due > now) return;           // 연습·시험 후는 due 기준
      relearnCand.push(w.id);
      rotations += RELEARN_TARGET - s.relearnCount;
    });

    /* 신규 할당 — 미도달 잔량 ÷ 마감까지 잔여일(마감 당일 포함). 마감 경과면 오늘 다(상한만) */
    var fresh, lateDeadline = false;
    if (mode === 'exam') {
      var remain = dday - deadlineDays + 1;
      if (remain < 1) { remain = 1; lateDeadline = freshCand.length > 0; }
      fresh = freshCand.slice(0, Math.min(maxNew, Math.ceil(freshCand.length / remain)));
    } else if (mode === 'after') {
      fresh = [];
    } else {
      fresh = freshCand.slice(0, maxNew);
    }

    /* 복습 — 미도달(도달 기회가 급하다)이 먼저, 그다음 만기 오래된 순. 상한으로 자른다:
       결석 뒤 만기 60개를 한 화면에 쏟으면 그게 곧 "밀린 것 60개"다 */
    var review = reviewCand.slice().sort(function (a, b) {
      var ra = states[a].reached ? 1 : 0, rb = states[b].reached ? 1 : 0;
      return ra - rb || states[a].due - states[b].due || order[a] - order[b];
    }).slice(0, maxRev);

    /* 안정화 회전 — 재검증 대기가 먼저, 그다음 회전을 적게 받은 단어부터(동률이면 오래된
       성공부터). 팩 앞쪽만 계속 뽑히면 뒤쪽 단어는 D-1까지 회전을 못 받는다. */
    relearnCand.sort(function (a, b) {
      var sa = states[a], sb = states[b];
      var na = sa.needsSpellCheck ? 0 : 1, nb = sb.needsSpellCheck ? 0 : 1;
      if (na !== nb) return na - nb;
      if (sa.relearnCount !== sb.relearnCount) return sa.relearnCount - sb.relearnCount;
      var da = sa.lastCriterionDate || '', db = sb.lastCriterionDate || '';
      if (da !== db) return da < db ? -1 : 1;
      return order[a] - order[b];
    });
    var relearnN;
    if (inWindow) {
      relearnN = Math.min(relearnCand.length, maxRe, Math.max(spellN, Math.ceil(rotations / dday)));
    } else {
      relearnN = Math.min(relearnCand.length, maxRe);
    }
    var relearn = relearnCand.slice(0, relearnN);

    /* 문장 — 단락(seq) 순서로, 암송 완료 전 문장의 현재 단계 도전.
       게이트 잠김이면 5·6단계는 보류(§4.4 — 병행·오버라이드면 열린다).
       백지 통과 문장도 안정화(다른 날 3회)가 끝날 때까지 만기마다 6단계로 다시 부른다. */
    var g = gateDecision(doneN, total, mode === 'exam' ? exam : null, opts);
    var sentences = [], redo = [];
    ((pack && pack.sentences) || []).slice()
      .sort(function (a, b) { return a.seq - b.seq; })
      .forEach(function (sen) {
        var s = states[sentenceId(sen.seq)];
        if (s && s.reached) {
          if (!isStable(s) && s.due <= now && !successToday(s, now, today)) redo.push({ seq: sen.seq, stage: STAGE_MAX });
          return;
        }
        var stage = s ? s.stage : 1;
        if (!g.open && stage >= 5) return;
        sentences.push({ seq: sen.seq, stage: stage });
      });
    sentences = sentences.concat(redo).slice(0, maxSen);

    var parts = [];
    if (mode === 'exam') {
      parts.push('D-' + dday);
      if (lateDeadline) parts.push('단어 마감 경과 — 회복 편성');
      if (!g.open) parts.push('단어 게이트 잠김(5·6단계 보류)');
      if (g.reason === 'parallel') parts.push('병행 모드 — 미완성 단어 선차감');
    } else if (mode === 'after') {
      parts.push('시험 종료 — 자율 복습');
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

  /* 성취도 화면의 원천(§4.2) — 본문 문장(kind 'sentence')만. 해석은 2단계에서 먼저 잡고,
     백지가 최종 관문. 단계값은 1~6 정수로 눌러 센다 — 4.5 같은 값이 들어와도 NaN 칸이 안 생긴다. */
  function sentenceSummary(states) {
    var out = { total: 0, byStage: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }, interpreted: 0, memorized: 0 };
    values(states).forEach(function (s) {
      if (s.kind !== 'sentence') return;
      var st = Math.floor(+s.stage);
      if (!(st >= 1)) st = 1;
      if (st > STAGE_MAX) st = STAGE_MAX;
      out.total += 1;
      out.byStage[st] += 1;
      if (st >= 3) out.interpreted += 1;        // 2단계(해석 쓰기) 통과 — 목표①
      if (s.reached) out.memorized += 1;        // 6단계(백지) 통과 — 목표②
    });
    return out;
  }

  /* 문장 사다리 진급(§4.2) — 통과 시 다음 단계, 6단계 통과는 완전 인출 성공으로
     처리해 단어와 같은 안정화 규칙(서로 다른 날 3회)을 탄다. 실패는 단계 유지.
     이중 진급 가드: 같은 세션(opts.session이 같거나, 없으면 1분 안)에 두 번 부르면 두 번째는
     무시 — 한 세트가 문항마다 부르는 앱 경로의 안전판이다. */
  function advanceStage(s, passed, now, opts) {
    now = ms(now);
    s.last = now;
    if (!passed) return s;
    if (s.stage < STAGE_MAX) {
      var session = opts && opts.session != null ? opts.session : null;
      var dup = session != null
        ? s.stageSession === session
        : (s.stageAdvancedAt != null && now - s.stageAdvancedAt < STAGE_GUARD_MS);
      if (dup) return s;
      s.stageAdvancedFrom = s.stage;
      s.stageAdvancedAt = now;
      if (session != null) s.stageSession = session;
      s.stage += 1;
      return s;
    }
    return criterionSuccess(s, null, now);
  }

  return {
    DAY: DAY, MIN10: MIN10, INTERVAL_DAYS: INTERVAL_DAYS,
    CRITERION_GAP_MS: CRITERION_GAP_MS, STAGE_GUARD_MS: STAGE_GUARD_MS,
    STAGE_MAX: STAGE_MAX, RELEARN_TARGET: RELEARN_TARGET,
    localDate: localDate, daysUntil: daysUntil, sentenceId: sentenceId,
    createState: createState, recordQuiz: recordQuiz, recordCriterion: recordCriterion,
    stability: stability, isStable: isStable, isDone: isDone,
    applyDiagnostic: applyDiagnostic, wordSummary: wordSummary,
    gate: gate, clearWrong: clearWrong, planDay: planDay,
    sentenceSummary: sentenceSummary, advanceStage: advanceStage
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WBNAESIN;
