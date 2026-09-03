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
  var STAGE_MAX = 6;          // 본문 사다리 6단계(§4.2) — 6단계(단락 백지) 통과 = 암송 완료
  var RELEARN_TARGET = 3;     // 안정화 = 서로 다른 날 3회 재도달(§14-1)
  var RISKY_WRONG = 3;        // 오답 이만큼이면 '위험' 단어로 집계
  /* 트랙별 최고 단계 — 문장·대화문은 6단, 청크 트랙과 단락 관문은 3단이다.
     (청크: 듣고 짝 맞추기 → 뜻 인출 → 순서 세우기 / 관문: 줄거리 → 어색한 곳 → 단락 백지)
     최고 단계 통과가 곧 그 트랙의 reached다 — 문장의 6단계 통과와 같은 자리. */
  var TRACK_STAGES = { chunk: 3, para: 3 };
  var PARA_STEPS = ['summary', 'odd', 'blank'];   // 단락 관문 stage 1·2·3의 이름
  var CUE_MAX = 3;            // 단서 농도 상한 — 3 전사 · 2 첫 글자+글자 수 · 1 첫 글자 · 0 빈칸만
  var PASSAGE_BASE = 5;       // 본문 하루 상한의 바닥값(연습 모드는 이 고정값)
  var FRESH_EVERY = 3;        // 본문 자리 세 칸에 한 칸은 '아직 손대지 않은 문장' 몫
  var HEAVY_DAY = 60;         // 하루 분량(단어+본문)이 이만큼을 넘으면 노트에 숫자를 그대로 밝힌다

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

  /* 상태 키 규약 — states 맵에서 문장·청크 트랙·단락 관문은 이 키로 찾는다.
     청크·관문은 단락(dayGroup) 단위라 키의 꼬리가 seq가 아니라 dayGroup이다. */
  function sentenceId(seq) { return 's-' + seq; }
  function chunkId(day) { return 'ck-' + day; }
  function paraId(day) { return 'pg-' + day; }

  /* kind: 'word' | 'sentence' | 'dialogue' | 'chunk' | 'para'.
     사다리 단계(stage)는 문장·대화문·청크·관문이 갖고, 단어는 갖지 않는다.
     'chunk'(단락 청크 트랙)·'para'(단락 관문)는 단어 집계(wordSummary·gate)에도
     문장 집계(sentenceSummary)에도 섞이지 않는다 — 'dialogue'가 빠지는 것과 같은 방식.
     둘의 진행은 passageSummary가 따로 센다. */
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
    /* 단서 농도(cue)는 문장 사다리 1·3·5단계에서만 쓰지만, 사다리를 갖는 상태는 모두 같은
       필드를 갖는다 — 화면이 kind마다 다른 모양을 외우지 않게. */
    if (kind === 'sentence' || kind === 'dialogue' || kind === 'chunk' || kind === 'para') {
      s.stage = 1; s.cue = 1;
    }
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

  /* 그 상태가 오를 수 있는 최고 단계 — 문장·대화문 6, 청크·관문 3 */
  function stageMaxOf(s) {
    var m = s && TRACK_STAGES[s.kind];
    return m || STAGE_MAX;
  }

  /* 단계는 1~최고 단계의 정수만 의미가 있다 — 옛 상태의 4.5 같은 값이 남아 있어도 플랜·요약이
     같은 눈(내림, 범위 고정)으로 읽어 NaN 칸이나 생성기 누락(dailySet은 정수 키만 안다)이
     생기지 않는다. */
  function stageOf(s) {
    var st = Math.floor(+(s && s.stage));
    if (!(st >= 1)) st = 1;
    var max = stageMaxOf(s);
    if (st > max) st = max;
    return st;
  }

  /* 단서 농도(§3.3) — 3 전문 전사 · 2 빈칸+첫 글자+글자 수 · 1 빈칸+첫 글자 · 0 빈칸만.
     필드가 없는 옛 상태는 1로 읽는다 — 지금까지의 화면이 곧 '빈칸+첫 글자'였다. */
  function cueOf(s) {
    var c = Math.floor(+(s && s.cue));
    if (!(c >= 0)) c = 1;
    if (c > CUE_MAX) c = CUE_MAX;
    return c;
  }

  /* 단서가 걸리는 단계 — 1 줄 해석 · 3 핵심어 빈칸 · 5 줄 영작. 답을 '쓰는' 단계만이다.
     2(영어 청크 배열)·4(문법 형태)·6(단락 백지)은 단서 없이 한 번에 판정한다. */
  function isCueStage(stage) {
    var n = Math.floor(+stage);
    return n === 1 || n === 3 || n === 5;
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
     시험 당일(D-0)까지는 잠근 채로 둔다 — 그날 아침 마지막 복습이 제일 중요하다. 시험이
     지나야(D-1 이하) 잠글 이유가 없어진다(연습과 같음). */
  function gate(wordStates, exam, now, opts) {
    now = ms(now);
    exam = examOf(exam);
    if (exam && daysUntil(exam.examDate, now) < 0) exam = null;
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

  /* ── 오늘의 플랜(§5.4 회복 내장 편성) ─────────────────────────────────────────
     매 호출이 전면 재계산이다. "밀린 것 N개"는 없다: 미도달 잔량을 잔여일로 나눈
     '오늘의 새 플랜'만 있다.
     레인(앱 호환): fresh = 손도 안 댄 단어, review = 학습 중·만기(미도달이면 gen이 무힌트
     철자로 도달 기회를 준다), relearn = 완전 인출(무힌트 철자) — 안정화 회전 + 철자 재검증.
     시험 모드: 단어 초회 도달 마감 = 시험 D-wordDeadlineDays(기본 7, 당일 포함),
     D-7~D-1엔 도달 단어의 안정화 회전을 잔여일로 나눠 배분(§14-1 망각 사각지대 방지).
     D-7 전에도 만기 도달 단어는 review로 돌려 SRS를 끊지 않는다. 시험 당일(D-0)은 마지막
     복습이 가장 중요하니 아직 시험 모드다 — 시험이 지나야(D-1 이하) 'after'가 되어 신규
     편성 없이 자율 복습만 남는다(학생 앱의 daysUntil < 0 '시험 종료'와 같은 경계).
     내부는 [후보 수집 wordCandidates] → [배분 allocateWords] 두 단계다 — 통합 범위
     플랜(planRange)이 여러 과의 후보를 합쳐 한 번만 배분하려면 두 단계가 갈라져 있어야
     한다(과별로 배분하면 하루 할당이 과 수만큼 불어난다). */

  /* 시험 설정 → 플랜이 공유하는 시간·모드 맥락. total은 상한 계산의 분모라 범위
     플랜에선 범위 전체 단어 수가 들어온다. */
  function planContext(exam, now, total) {
    var deadlineDays = exam && exam.wordDeadlineDays != null ? +exam.wordDeadlineDays : 7;
    if (!(deadlineDays >= 1)) deadlineDays = 7;
    var dday = exam ? daysUntil(exam.examDate, now) : null;
    var mode = !exam ? 'practice' : (dday < 0 ? 'after' : 'exam');   // D-0(시험 당일)은 아직 시험 모드
    return {
      mode: mode, dday: dday, today: localDate(now),
      deadlineDays: deadlineDays, total: total,
      inWindow: mode === 'exam' && dday <= deadlineDays               // D-마감~D-1 안정화 구간
    };
  }

  /* 한 과의 단어를 레인별 후보로 나눈다(planDay·planRange 공용).
     ref = {packId, pi, nPacks} — 후보의 rank는 여러 과를 한 번에 배분할 때 과가 번갈아
     나오도록 접은 순번(과 안 순번×과 수 + 과 번호)이다. 한 과면 rank = 팩 안 순번 그대로라
     기존 편성 순서가 그대로 유지되고, 두 과면 L6-1·L7-1·L6-2… 로 갈마들어 한 과가 상한을
     독식해 다른 과를 굶기지 않는다. */
  function wordCandidates(pack, states, now, ctx, ref) {
    states = states || {};
    var packId = ref && ref.packId != null ? ref.packId : null;
    var np = ref && ref.nPacks > 1 ? ref.nPacks : 1;
    var pi = ref && ref.pi > 0 ? ref.pi : 0;
    var out = { packId: packId, fresh: [], review: [], relearn: [], rotations: 0, doneN: 0, spellN: 0, total: 0 };
    var wordsArr = (pack && pack.words) || [];
    out.total = wordsArr.length;
    wordsArr.forEach(function (w, idx) {
      var c = { packId: packId, id: w.id, s: null, rank: idx * np + pi };
      var s = states[w.id];
      if (!s || s.last == null) { out.fresh.push(c); return; }             // 손도 안 댄 단어
      c.s = s;
      if (!s.reached) { if (s.due <= now) out.review.push(c); return; }    // 학습 중 + 만기
      if (isDone(s)) out.doneN += 1;
      if (s.needsSpellCheck) {
        /* 진단·찍음 도달분의 철자 재검증 — D-day와 무관하게 매일 상한 안에서 */
        if (successToday(s, now, ctx.today)) return;
        out.relearn.push(c); out.spellN += 1;
        out.rotations += RELEARN_TARGET - s.relearnCount;
        return;
      }
      if (isStable(s)) return;                                 // 안정화 완료 — 오늘 몫 없음
      if (successToday(s, now, ctx.today)) return;             // 오늘 이미 성공 — 같은 날 중복 불인정
      if (ctx.mode === 'exam' && !ctx.inWindow) {
        if (s.due <= now) out.review.push(c);                  // D-7 전 — 만기면 복습(SRS 유지)
        return;
      }
      if (ctx.mode !== 'exam' && s.due > now) return;           // 연습·시험 후는 due 기준
      out.relearn.push(c);
      out.rotations += RELEARN_TARGET - s.relearnCount;
    });
    return out;
  }

  /* 후보 → 오늘 몫. 상한·마감은 넘겨받은 ctx 하나로 계산한다 — 범위 플랜이면 그 값이
     범위 전체 기준이라, 과가 둘이어도 마감·상한을 두 번 세지 않는다. */
  function allocateWords(cand, ctx, opts) {
    opts = opts || {};
    /* 안정화 상한 기본값은 (범위) 단어 수에서 나온다 — 77단어×3회전을 7일에 끝내려면 하루
       33개인데 늦게 도달한 단어는 앞쪽 며칠을 못 쓰므로 (마감-2)일로 나눠 여유를 둔다 */
    var maxRe = opts.maxRelearn == null
      ? Math.max(15, Math.ceil(ctx.total * RELEARN_TARGET / Math.max(1, ctx.deadlineDays - 2)))
      : opts.maxRelearn;

    /* 신규 할당 — 미도달 잔량 ÷ 마감까지 남은 날. 나누는 날수는 마감 하루 전까지다:
       fresh 레인은 4지선다+힌트 철자라 그날은 '도달'이 아니고, 무힌트 철자(=도달)는 다음 날
       복습 레인에서 나온다. 마감 당일에 처음 꺼낸 단어는 마감을 못 지킨다 — 하루 앞당겨
       나눠야 마감이 곧 '초회 도달 완료'가 된다(목표③).
       상한 기본값도 여기서 나온다: max(10, 오늘 필요량) — 고정 상한(옛 10)은 범위가 커질수록
       마감을 이겨 버려서, 상한 때문에 마감을 못 지키는 일이 생겼다(2과 154단어에서 130개만
       도달). 상한은 하루 분량의 안전판이지 마감을 무르는 장치가 아니다. 명시
       opts.maxNewWords는 그대로 이긴다 — 그때는 못 지키는 마감을 노트가 밝힌다. */
    var freshCand = cand.fresh.slice().sort(byRank);
    var fresh, lateDeadline = false, needNew = 0, maxNew, capped = false, aim = 1;
    if (ctx.mode === 'exam') {
      var remain = ctx.dday - ctx.deadlineDays + 1;
      if (remain < 1) { remain = 1; lateDeadline = freshCand.length > 0; }
      aim = Math.max(1, remain - 1);            // 마감 하루 전까지 남은 날
      needNew = Math.ceil(freshCand.length / aim);
      maxNew = opts.maxNewWords == null ? Math.max(10, needNew) : opts.maxNewWords;
      capped = needNew > maxNew;
      fresh = freshCand.slice(0, Math.min(maxNew, needNew));
    } else if (ctx.mode === 'after') {
      fresh = [];
    } else {
      /* 연습 모드는 마감이 없다 — 자동 산정할 분모가 없으니 하루 10개 고정 */
      maxNew = opts.maxNewWords == null ? 10 : opts.maxNewWords;
      fresh = freshCand.slice(0, maxNew);
    }

    /* 복습 — 미도달(도달 기회가 급하다)이 먼저, 그다음 만기 오래된 순. 상한으로 자른다:
       결석 뒤 만기 60개를 한 화면에 쏟으면 그게 곧 "밀린 것 60개"다.
       다만 시험 모드에선 도달 대기(미도달)만큼은 자리를 비워 둔다 — 어제 꺼낸 단어가
       '도달'하는 자리가 바로 이 레인이라(fresh는 힌트 철자, 무힌트 철자는 다음 날 여기서
       나온다) 상한이 신규보다 작으면 도달이 매일 조금씩 밀려 마감을 못 지킨다. 밀린 도달
       잔량도 신규와 같은 눈으로 마감까지 고르게 나눈다 — 결석 뒤 60개를 한 날에 쏟지 않는다. */
    var reachN = 0;
    cand.review.forEach(function (c) { if (!c.s.reached) reachN += 1; });
    var maxRev = opts.maxReview == null
      ? (ctx.mode === 'exam' ? Math.max(20, needNew, Math.ceil(reachN / aim)) : 20)
      : opts.maxReview;
    var review = cand.review.slice().sort(function (a, b) {
      var ra = a.s.reached ? 1 : 0, rb = b.s.reached ? 1 : 0;
      return ra - rb || a.s.due - b.s.due || a.rank - b.rank;
    }).slice(0, maxRev);

    /* 안정화 회전 — 재검증 대기가 먼저, 그다음 회전을 적게 받은 단어부터(동률이면 오래된
       성공부터). 팩 앞쪽만 계속 뽑히면 뒤쪽 단어는 D-1까지 회전을 못 받는다. 범위 플랜에선
       이 정렬이 그대로 과 사이 공정성이 된다 — 어제 회전을 받은 과는 relearnCount가 올라가
       오늘은 뒤로 밀린다. */
    var relearnCand = cand.relearn.slice().sort(function (a, b) {
      var na = a.s.needsSpellCheck ? 0 : 1, nb = b.s.needsSpellCheck ? 0 : 1;
      if (na !== nb) return na - nb;
      if (a.s.relearnCount !== b.s.relearnCount) return a.s.relearnCount - b.s.relearnCount;
      var da = a.s.lastCriterionDate || '', db = b.s.lastCriterionDate || '';
      if (da !== db) return da < db ? -1 : 1;
      return a.rank - b.rank;
    });
    var relearnN;
    if (ctx.inWindow) {
      relearnN = Math.min(relearnCand.length, maxRe, Math.max(cand.spellN, Math.ceil(cand.rotations / Math.max(1, ctx.dday))));
    } else {
      relearnN = Math.min(relearnCand.length, maxRe);
    }
    return {
      fresh: fresh, review: review, relearn: relearnCand.slice(0, relearnN),
      freshCand: freshCand.length, lateDeadline: lateDeadline,
      needNew: needNew, maxNew: maxNew, capped: capped
    };
  }

  function byRank(a, b) { return a.rank - b.rank; }

  /* ── 본문 트랙: 단락 · 청크 게이트 · 단락 관문 ─────────────────────────────────
     단위 순서는 청크 → 줄 → 단락이다(재설계 §2). 뜻(한글)을 청크로 먼저 세운 단락에서만
     문장 사다리가 열리고, 문장이 다 올라선 단락에서만 관문이 열린다. */

  /* 팩의 단락 목록 — dayGroup 값이 같은 문장을 한 단락으로 묶는다(첫 등장 순서 유지).
     인접이 아니라 값으로 묶는 이유: 청크·관문 상태 키가 dayGroup이라, 같은 dayGroup이
     두 덩이로 나오면 한 상태를 두 단락이 나눠 갖게 되어 게이트가 어긋난다. */
  function dayGroups(pack) {
    var groups = [], byDay = {};
    ((pack && pack.sentences) || []).slice()
      .sort(function (a, b) { return a.seq - b.seq; })
      .forEach(function (sen) {
        var day = sen.dayGroup == null ? '' : String(sen.dayGroup);
        var g = Object.prototype.hasOwnProperty.call(byDay, day) ? byDay[day] : null;
        if (!g) { g = { day: day, header: sen.dayHeaderKo || day, sentences: [] }; byDay[day] = g; groups.push(g); }
        if (sen.dayHeaderKo) g.header = sen.dayHeaderKo;
        g.sentences.push(sen);
      });
    return groups;
  }

  function groupOf(pack, day) {
    var key = day == null ? '' : String(day), found = null;
    dayGroups(pack).forEach(function (g) { if (g.day === key) found = g; });
    return found;
  }

  /* 청크 트랙을 돌릴 재료가 있는 단락인가 — 직독직해 청크(chunks[])가 정본이다 */
  function hasChunks(g) {
    return !!g && g.sentences.some(function (sen) {
      return Array.isArray(sen.chunks) && sen.chunks.length > 0;
    });
  }

  /* 청크 게이트(§3.4) — 이 단락의 청크 트랙이 reached여야 문장 사다리가 1단계도 열린다.
     청크 데이터가 없는 팩(옛 팩)은 열어 둔다 — 열 방법이 없는 자물쇠는 본문 탭을 통째로
     잠근다. 단어 게이트와 달리 시험 여부와 무관하다: 뜻 세우기는 언제나 첫 자리다. */
  function chunkGate(pack, states, day) {
    states = states || {};
    var g = groupOf(pack, day);
    if (!hasChunks(g)) return { open: true, reason: 'no-chunk', day: day, stage: 0, total: g ? g.sentences.length : 0 };
    var s = states[chunkId(g.day)];
    var st = s ? stageOf(s) : 1;
    if (s && s.reached) return { open: true, reason: 'reached', day: g.day, stage: st, total: g.sentences.length };
    return { open: false, reason: 'chunk-gate', day: g.day, stage: st, total: g.sentences.length };
  }

  /* 단락 관문 게이트(§3.4) — 그 단락 문장이 전부 stage >= need 인가.
     need 2 = 줄거리(1단계 줄 해석 통과) · need 5 = 어색한 곳·단락 백지.
     백지를 통과한 문장(reached)은 언제나 최고 단계로 센다. */
  function paraGate(pack, states, day, need) {
    states = states || {};
    if (!(need >= 1)) need = 2;
    need = Math.floor(need);
    var g = groupOf(pack, day);
    if (!g || !g.sentences.length) return { open: false, reason: 'empty', need: need, done: 0, total: 0, day: day };
    var done = 0;
    g.sentences.forEach(function (sen) {
      var s = states[sentenceId(sen.seq)];
      var st = s ? (s.reached ? STAGE_MAX : stageOf(s)) : 1;
      if (st >= need) done += 1;
    });
    var open = done >= g.sentences.length;
    return { open: open, reason: open ? 'reached' : 'stage-gate', need: need, done: done, total: g.sentences.length, day: g.day };
  }

  /* 본문 편성 — 다섯 종류를 종류별 바구니로 나눠 돌려준다(플랜이 청크 → 문장 → 관문 →
     누적 → 종합 순으로 펼친다). 범위 플랜이 여러 과의 같은 종류를 나란히 놓으려면
     바구니가 갈라져 있어야 한다.
       chunk   단락 청크 트랙(뜻 세우기) — 단어 게이트를 받지 않는다. 영어를 못 읽는 학생이
               첫날 시작하는 자리가 여기다.
       pending 문장 사다리 — 청크 트랙이 통과된 단락만. 게이트 잠김이면 5·6단계 보류(§4.4).
       redo    백지 통과 문장의 만기 재도전(안정화가 끝날 때까지).
       para    단락 관문 — 줄거리(문장 전부 stage≥2) → 어색한 곳·백지(전부 stage≥5 + 단어 게이트).
       tail    누적 백지·종합 Check — 모든 단락이 백지를 통과한 뒤, 1일차 → 1+2일차 → … 순서로만.
     rec = 팩 저장소 기록 {cumulative, check}(§3.5). 없으면 누적은 미시작으로 본다. */
  function passageCandidates(pack, states, now, today, open, rec) {
    states = states || {};
    var groups = dayGroups(pack);
    var out = { chunk: [], pending: [], redo: [], para: [], tail: [] };

    groups.forEach(function (g) {
      if (!hasChunks(g)) return;
      var s = states[chunkId(g.day)];
      if (s && s.reached) return;
      out.chunk.push({ kind: 'chunk', day: g.day, stage: s ? stageOf(s) : 1 });
    });

    /* 손댄 적 없는 문장(untouched)과 이미 손댄 문장을 따로 모은다 — 아래에서 자리를 짠다 */
    var untouched = [], touched = [];
    groups.forEach(function (g) {
      if (!chunkGate(pack, states, g.day).open) return;
      g.sentences.forEach(function (sen) {
        var s = states[sentenceId(sen.seq)];
        if (s && s.reached) {
          if (!isStable(s) && s.due <= now && !successToday(s, now, today)) {
            out.redo.push({ kind: 'sentence', seq: sen.seq, stage: STAGE_MAX });
          }
          return;
        }
        var stage = s ? stageOf(s) : 1;
        if (!open && stage >= 5) return;
        (s && s.last != null ? touched : untouched).push({ kind: 'sentence', seq: sen.seq, stage: stage });
      });
    });
    out.pending = weavePending(untouched, touched);

    groups.forEach(function (g) {
      var s = states[paraId(g.day)];
      if (s && s.reached) return;
      var stage = s ? stageOf(s) : 1;
      var step = PARA_STEPS[stage - 1] || PARA_STEPS[PARA_STEPS.length - 1];
      if (!paraGate(pack, states, g.day, step === 'summary' ? 2 : 5).open) return;
      if (step !== 'summary' && !open) return;      // 어색한 곳·백지는 5·6단계와 같은 자리
      out.para.push({ kind: 'para', day: g.day, step: step, stage: stage });
    });

    var allPara = groups.length > 0 && groups.every(function (g) {
      var s = states[paraId(g.day)];
      return !!(s && s.reached);
    });
    if (allPara && open) {
      var cum = (rec && rec.cumulative) || null;
      var i = 0;
      while (i < groups.length && cum && Object.prototype.hasOwnProperty.call(cum, groups[i].day)) i += 1;
      if (i < groups.length) out.tail.push({ kind: 'cumulative', lastDay: groups[i].day });
      else if (!(rec && rec.check)) out.tail.push({ kind: 'check' });   // 최종 점검은 누적을 다 밟은 뒤
    }
    return out;
  }

  /* 문장 자리 짜기 — 세 칸에 한 칸(FRESH_EVERY)은 아직 손대지 않은 문장에 먼저 준다.
     seq 순으로만 채우면 앞 문장이 한 단계에 정체할 때(단서가 안 지워지거나 학생이 그 단계를
     건너뛸 때) 뒤 문장은 상한에 밀려 영영 1단계도 못 받는다 — 25문장 팩에서 실제로 5문장만
     해석이 열리는 것을 시뮬레이션으로 봤다. 안정화 레인이 '회전을 적게 받은 단어'부터 도는
     것과 같은 정신이다: 굶는 쪽을 먼저 부른다. 한쪽이 떨어지면 남은 쪽이 순서대로 채운다. */
  function weavePending(untouched, touched) {
    var out = [], ui = 0, ti = 0, i = 0;
    while (ui < untouched.length || ti < touched.length) {
      var takeNew = ti >= touched.length || (i % FRESH_EVERY === 0 && ui < untouched.length);
      out.push(takeNew ? untouched[ui++] : touched[ti++]);
      i += 1;
    }
    return out;
  }

  /* 본문 잔여 작업량 — 상한 자동 산정의 분자다. 러너 한 번(한 단계 통과) = 1로 센다.
       ladder    청크 단계 + 문장 단계 + 단락 관문 단계 — 여러 개를 하루에 몰아 할 수 있다
       tailDays  누적 백지 + 종합 Check — 하루 한 칸씩 직렬이라 '나눌 양'이 아니라 '먹는 날수'다
     tail을 날수로 세는 이유: 마지막 며칠에 누적만 남으면 종합 Check까지 못 간다.
     그만큼 날짜를 먼저 떼고 나머지 날에 사다리를 나눠야 시험 전에 끝난다. */
  function passageWork(pack, states, rec) {
    states = states || {};
    var groups = dayGroups(pack);
    var out = { ladder: 0, tailDays: 0 };
    groups.forEach(function (g) {
      if (hasChunks(g)) {
        var ck = states[chunkId(g.day)];
        if (!(ck && ck.reached)) out.ladder += TRACK_STAGES.chunk - (ck ? stageOf(ck) : 1) + 1;
      }
      var pg = states[paraId(g.day)];
      if (!(pg && pg.reached)) out.ladder += TRACK_STAGES.para - (pg ? stageOf(pg) : 1) + 1;
      g.sentences.forEach(function (sen) {
        var s = states[sentenceId(sen.seq)];
        if (s && s.reached) return;
        out.ladder += STAGE_MAX - (s ? stageOf(s) : 1) + 1;
      });
    });
    if (!groups.length) return out;
    var cum = rec && rec.cumulative, i = 0;
    while (i < groups.length && cum && Object.prototype.hasOwnProperty.call(cum, groups[i].day)) i += 1;
    out.tailDays = (groups.length - i) + ((rec && rec.check) ? 0 : 1);
    return out;
  }

  /* 본문 하루 상한 — 단어 레인(maxNewWords·maxReview)과 같은 방식으로 자동 산정한다.
     고정 상한은 범위가 커질수록 마감을 이겨 버린다: 25문장 팩은 하루 5칸이면 시험까지
     문장 5개만 백지에 닿는다. 상한은 하루 분량의 안전판이지 마감을 무르는 장치가 아니다.
     연습 모드는 마감이 없으니 분모가 없다 — 예전대로 하루 5 고정.
     명시 opts.maxSentences는 그대로 이긴다 — 그때는 못 지키는 마감을 노트가 밝힌다.
     w = {ladder, tailDays, tailSlots, redoN} (tailSlots·redoN은 그날 몫이라 나누지 않고 더한다) */
  function passageCap(w, ctx, opts) {
    var explicit = opts && opts.maxSentences != null ? +opts.maxSentences : null;
    if (ctx.mode !== 'exam') {
      return { cap: explicit == null ? PASSAGE_BASE : explicit, need: null, capped: false };
    }
    var days = Math.max(1, ctx.dday);                        // D-1까지 끝낸다(시험 당일 아침은 마지막 복습)
    var ladderDays = Math.max(1, days - w.tailDays);
    var need = Math.ceil(w.ladder / ladderDays) + w.tailSlots + w.redoN;
    if (!(need >= PASSAGE_BASE)) need = PASSAGE_BASE;
    return {
      cap: explicit == null ? need : explicit,
      need: need,
      capped: explicit != null && explicit < need
    };
  }

  var CAND_LANES = ['chunk', 'pending', 'para', 'tail', 'redo'];
  /* 오늘 몫 — 청크 → 문장 → 단락 관문 → 누적 → 종합 순서 그대로다. 두 가지만 더 한다.
     ① 단락 관문·누적·종합은 자리를 먼저 떼어 둔다. 상한에 걸려 뒤로 밀리면 그날이 통째로
        날아가고(누적은 하루 한 칸씩 직렬이다) 시험 전에 종합까지 못 간다. 미완 문장은
        하루 밀려도 다음 날 같은 단계로 다시 나온다 — 밀려도 되는 쪽을 민다.
     ② 백지 재도전(redo)은 맨 뒤다. 이미 통과한 문장의 안정화 회전이라, 마감이 걸린 새 땅
        (관문·누적·종합)을 밀어낼 이유가 없다. 25문장 팩에서 매일 redo 25칸이 앞을 막아
        단락 관문이 시험 전에 한 번도 안 열리는 것을 시뮬레이션으로 봤다. */
  function takeCandidates(b, cap) {
    var reserve = b.para.length + b.tail.length;
    var room = Math.max(0, cap - reserve);
    return b.chunk.concat(b.pending).slice(0, room)
      .concat(b.para, b.tail, b.redo).slice(0, cap);
  }
  /* 범위 플랜용 — 항목에 packId를 붙이고(원본은 그대로 둔다) 떼어 낸다 */
  function tagPack(packId, x) {
    var o = { packId: packId }, k;
    for (k in x) if (Object.prototype.hasOwnProperty.call(x, k)) o[k] = x[k];
    return o;
  }
  function untagPack(x) {
    var o = {}, k;
    for (k in x) if (Object.prototype.hasOwnProperty.call(x, k) && k !== 'packId') o[k] = x[k];
    return o;
  }

  /* 플랜 한 줄 요약 — 범위가 여러 과면 그 사실을 모드 바로 뒤에 박는다("L6·L7 범위") */
  function planNote(ctx, flags, counts, rangeLabel) {
    var parts = [];
    if (ctx.mode === 'exam') parts.push('D-' + ctx.dday);
    else if (ctx.mode === 'after') parts.push('시험 종료 — 자율 복습');
    else parts.push('연습 모드 — 자율 진도');
    if (rangeLabel) parts.push(rangeLabel);
    if (ctx.mode === 'exam') {
      if (flags.lateDeadline) parts.push('단어 마감 경과 — 회복 편성');
      /* 하루 분량이 평상시(10개)를 넘으면 그 숫자를 그대로 보여 준다 — 범위를 두세 과로
         잡으면 마감을 지키는 데 얼마가 드는지가 강사·학생이 먼저 알아야 할 사실이다 */
      if (flags.heavy) parts.push('하루 신규 ' + flags.needNew + '개 필요 — 범위가 큽니다');
      if (flags.capped) parts.push('신규 상한 ' + flags.maxNew + '개 — 마감까지 도달 어려움');
      /* 본문도 같은 눈으로 — 하루 몇 칸이 필요한지, 상한 때문에 못 끝내는지를 감추지 않는다 */
      if (flags.senNeed > PASSAGE_BASE) parts.push('하루 본문 ' + flags.senNeed + '칸 필요');
      if (flags.senCapped) parts.push('본문 상한 ' + flags.senMax + '칸 — 시험 전 완료 어려움');
      if (flags.locked) parts.push('단어 게이트 잠김(5·6단계 보류)');
      if (flags.parallel) parts.push('병행 모드 — 미완성 단어 선차감');
    }
    parts.push('신규 ' + counts.fresh + '/' + counts.freshCand +
      ' · 복습 ' + counts.review + ' · 안정화 ' + counts.relearn +
      ' · 본문 ' + counts.sentences);
    /* 하루 분량이 사람이 소화할 수준을 넘으면 그 사실 자체가 강사에게 보여야 한다 —
       범위를 줄이거나 시작을 앞당기는 판단은 숫자를 본 사람이 한다 */
    var load = counts.fresh + counts.review + counts.relearn + counts.sentences;
    if (load > HEAVY_DAY) parts.push('하루 분량 ' + load + '개 — 남은 날에 비해 많습니다');
    return parts.join(' · ');
  }

  function ids(list) { return list.map(function (c) { return c.id; }); }

  /* 한 과의 오늘 플랜 — 시그니처·반환은 학생 앱(gen.dailySet)과의 계약이라 그대로다.
     sentences 항목은 다섯 종류가 섞인다(kind: chunk·sentence·para·cumulative·check).
     문장 항목의 {seq, stage}는 예전 그대로라 옛 소비자가 깨지지 않는다 — kind만 늘었다.
     opts.rec = 팩 저장소의 {cumulative, check} 기록(§3.5) — 누적·종합의 진행 원천. */
  function planDay(pack, states, exam, now, opts) {
    now = ms(now);
    opts = opts || {};
    states = states || {};
    exam = examOf(exam);
    var ctx = planContext(exam, now, ((pack && pack.words) || []).length);

    var cand = wordCandidates(pack, states, now, ctx, null);
    var alloc = allocateWords(cand, ctx, opts);

    var g = gateDecision(cand.doneN, cand.total, ctx.mode === 'exam' ? exam : null, opts);
    var buckets = passageCandidates(pack, states, now, ctx.today, g.open, opts.rec);
    var work = passageWork(pack, states, opts.rec);
    var pc = passageCap({
      ladder: work.ladder, tailDays: work.tailDays,
      tailSlots: work.tailDays > 0 ? 1 : 0, redoN: buckets.redo.length
    }, ctx, opts);
    var sentences = takeCandidates(buckets, pc.cap);

    return {
      mode: ctx.mode, dday: ctx.dday,
      words: { fresh: ids(alloc.fresh), review: ids(alloc.review), relearn: ids(alloc.relearn) },
      sentences: sentences,
      note: planNote(ctx, {
        lateDeadline: alloc.lateDeadline, heavy: !alloc.lateDeadline && alloc.needNew > 10,
        needNew: alloc.needNew, capped: alloc.capped, maxNew: alloc.maxNew,
        senNeed: pc.need, senCapped: pc.capped, senMax: opts.maxSentences,
        locked: !g.open, parallel: g.reason === 'parallel'
      }, {
        fresh: alloc.fresh.length, freshCand: alloc.freshCand,
        review: alloc.review.length, relearn: alloc.relearn.length,
        sentences: sentences.length
      }, null)
    };
  }

  /* 시험 범위 엔트리 정규화 — [{packId, pack, states, rec?}] (범위 순서 유지).
     packId가 없으면 팩의 packId, 그것도 없으면 자리 번호. 같은 packId가 두 번 오면
     첫 것만 남긴다(perPack 키 충돌·이중 집계 방지).
     rec = 그 과의 팩 저장소 기록 {cumulative, check}(§3.5). 엔트리가 팩 저장소(pd) 자체를
     넘겨도 되게, rec가 없으면 엔트리에서 바로 읽는다. */
  function rangeEntries(entries) {
    var out = [], seen = {};
    (Array.isArray(entries) ? entries : []).forEach(function (e, i) {
      if (!e || typeof e !== 'object') return;
      var pid = e.packId != null ? String(e.packId)
        : (e.pack && e.pack.packId != null ? String(e.pack.packId) : '#' + i);
      if (Object.prototype.hasOwnProperty.call(seen, pid)) return;
      seen[pid] = true;
      out.push({ packId: pid, pack: e.pack || null, states: e.states || {}, rec: e.rec || e });
    });
    return out;
  }

  /* 과 표시명 — 학생이 아는 단위는 packId가 아니라 'L6'이다 */
  function packLabel(e) {
    var lesson = e.pack && e.pack.lesson;
    if (lesson != null && lesson !== '') return 'L' + lesson;
    return e.packId;
  }

  /* 통합 시험 범위(여러 과)의 오늘 플랜 — 실제 학교 시험 범위는 보통 2~3개 과다.
     과별로 planDay를 돌려 합치면 하루 할당도 마감 계산도 과 수만큼 불어난다. 여기서는
     후보를 합쳐 한 번만 배분하므로 상한·마감이 범위 전체에 한 번 걸린다.
     반환: words/sentences는 {packId,…}가 붙은 범위 전체 목록, perPack은 그대로
     gen.dailySet(pack, perPack[packId], …)에 넘길 수 있는 과별 하위 계획.
     문장 순서는 팩 순서 → seq (학생이 보는 교재 순서), 5·6단계 게이트는 그 과의 단어. */
  function planRange(entries, exam, now, opts) {
    now = ms(now);
    opts = opts || {};
    exam = examOf(exam);
    var list = rangeEntries(entries);
    var total = 0;
    list.forEach(function (e) { total += ((e.pack && e.pack.words) || []).length; });
    var ctx = planContext(exam, now, total);

    var merged = { fresh: [], review: [], relearn: [], rotations: 0, spellN: 0 };
    var gates = [];
    list.forEach(function (e, i) {
      var c = wordCandidates(e.pack, e.states, now, ctx, { packId: e.packId, pi: i, nPacks: list.length });
      merged.fresh = merged.fresh.concat(c.fresh);
      merged.review = merged.review.concat(c.review);
      merged.relearn = merged.relearn.concat(c.relearn);
      merged.rotations += c.rotations;
      merged.spellN += c.spellN;
      gates.push(gateDecision(c.doneN, c.total, ctx.mode === 'exam' ? exam : null, opts));
    });
    var alloc = allocateWords(merged, ctx, opts);

    /* 본문 — 종류가 먼저, 그 안에서 팩 순서 → seq. 청크 → 문장 → 관문 → 누적 → 종합 순으로
       펴고 상한은 범위 전체에 한 번. 종류를 먼저 묶는 이유: 한 과의 관문이 다른 과의 청크
       (뜻 세우기)보다 앞서면 못 읽는 학생이 두 번째 과에서 다시 막힌다. */
    var senLanes = { chunk: [], pending: [], redo: [], para: [], tail: [] };
    /* 작업량은 과별로 합치되 누적·종합이 먹는 날수는 과끼리 겹친다(같은 날 L6·L7 누적을
       나란히 본다) — 그래서 ladder는 합, tailDays는 최대, 자리(tailSlots)는 과 수다. */
    var swork = { ladder: 0, tailDays: 0, tailSlots: 0, redoN: 0 };
    list.forEach(function (e, i) {
      var b = passageCandidates(e.pack, e.states, now, ctx.today, gates[i].open, e.rec);
      CAND_LANES.forEach(function (lane) {
        b[lane].forEach(function (x) { senLanes[lane].push(tagPack(e.packId, x)); });
      });
      var w = passageWork(e.pack, e.states, e.rec);
      swork.ladder += w.ladder;
      swork.tailDays = Math.max(swork.tailDays, w.tailDays);
      if (w.tailDays > 0) swork.tailSlots += 1;
      swork.redoN += b.redo.length;
    });
    var pc = passageCap(swork, ctx, opts);
    var sentences = takeCandidates(senLanes, pc.cap);

    /* perPack — 배분된 결과만 담는다(상한에 잘린 뒤의 진짜 오늘 몫) */
    var perPack = {};
    list.forEach(function (e) {
      perPack[e.packId] = { words: { fresh: [], review: [], relearn: [] }, sentences: [] };
    });
    ['fresh', 'review', 'relearn'].forEach(function (lane) {
      alloc[lane].forEach(function (c) {
        if (perPack[c.packId]) perPack[c.packId].words[lane].push(c.id);
      });
    });
    sentences.forEach(function (x) {
      if (perPack[x.packId]) perPack[x.packId].sentences.push(untagPack(x));
    });

    var locked = false, parallel = false;
    gates.forEach(function (g) {
      if (!g.open) locked = true;
      if (g.reason === 'parallel') parallel = true;
    });
    var label = list.length > 1
      ? list.map(packLabel).join('·') + ' 범위'
      : null;

    return {
      mode: ctx.mode, dday: ctx.dday,
      words: {
        fresh: alloc.fresh.map(refOf), review: alloc.review.map(refOf), relearn: alloc.relearn.map(refOf)
      },
      sentences: sentences,
      perPack: perPack,
      note: planNote(ctx, {
        lateDeadline: alloc.lateDeadline, heavy: !alloc.lateDeadline && alloc.needNew > 10,
        needNew: alloc.needNew, capped: alloc.capped, maxNew: alloc.maxNew,
        senNeed: pc.need, senCapped: pc.capped, senMax: opts.maxSentences,
        locked: locked, parallel: parallel
      }, {
        fresh: alloc.fresh.length, freshCand: alloc.freshCand,
        review: alloc.review.length, relearn: alloc.relearn.length,
        sentences: sentences.length
      }, label)
    };
  }

  function refOf(c) { return { packId: c.packId, id: c.id }; }

  /* 범위 전체 단어 게이트 — 실전 모의(§4.4)는 시험 범위 전부가 기준이다.
     완료 기준은 gate와 같은 isDone(도달 + 철자 재검증 완료). */
  function gateRange(entries, exam, now, opts) {
    now = ms(now);
    exam = examOf(exam);
    if (exam && daysUntil(exam.examDate, now) < 0) exam = null;
    var done = 0, total = 0;
    rangeEntries(entries).forEach(function (e) {
      values(e.states).forEach(function (s) {
        if (!s || s.kind !== 'word') return;
        total += 1;
        if (isDone(s)) done += 1;
      });
    });
    var g = gateDecision(done, total, exam, opts);
    return { open: g.open, reason: g.reason, done: done, total: total };
  }

  /* 범위 요약(계약 R1의 state.summary.range) — 관리 현황판·홈 보드가 "시험 범위 전체"를
     한 단위로 보게 하는 값. 합계와 함께 과별 값(packs)도 남긴다(펼침 표시용). */
  function rangeSummary(entries) {
    var list = rangeEntries(entries);
    var out = {
      packIds: [],
      word: { total: 0, reached: 0, stable: 0, risky: 0, needsSpellCheck: 0 },
      sentence: { total: 0, interpreted: 0, memorized: 0, byStage: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 } },
      /* 본문 진행도 범위 전체가 한 단위다(§3.6) — 관리 현황판의 「본문 진행」 열이 이 값이다 */
      passage: { chunkDone: 0, chunkTotal: 0, paraBlank: 0, paraTotal: 0, cumulative: 0, check: null },
      packs: {}
    };
    var checkCorrect = 0, checkTotal = 0, hasCheck = false;
    list.forEach(function (e) {
      var w = wordSummary(e.states), s = sentenceSummary(e.states);
      var p = passageSummary(e.pack, e.states, e.rec);
      out.packIds.push(e.packId);
      out.word.total += w.total; out.word.reached += w.reached; out.word.stable += w.stable;
      out.word.risky += w.risky; out.word.needsSpellCheck += w.needsSpellCheck;
      out.sentence.total += s.total; out.sentence.interpreted += s.interpreted;
      out.sentence.memorized += s.memorized;
      [1, 2, 3, 4, 5, 6].forEach(function (k) { out.sentence.byStage[k] += s.byStage[k]; });
      out.passage.chunkDone += p.chunkDone; out.passage.chunkTotal += p.chunkTotal;
      out.passage.paraBlank += p.paraBlank; out.passage.paraTotal += p.paraTotal;
      out.passage.cumulative += p.cumulative;
      if (p.check) { hasCheck = true; checkCorrect += p.check.correct; checkTotal += p.check.total; }
      out.packs[e.packId] = {
        word: { total: w.total, reached: w.reached, stable: w.stable },
        sentence: { total: s.total, interpreted: s.interpreted, memorized: s.memorized }
      };
    });
    if (hasCheck) out.passage.check = { correct: checkCorrect, total: checkTotal };
    return out;
  }

  /* 성취도 화면의 원천(§4.2) — 본문 문장(kind 'sentence')만. 청크 트랙·단락 관문·대화문·
     단어는 여기 섞이지 않는다. 단계값은 1~6 정수로 눌러 센다 — 4.5 같은 값이 들어와도
     NaN 칸이 안 생긴다.
     재설계 §3.2: interpreted 기준이 stage >= 2다. 새 1단계가 '줄 해석(한글 빈칸)'이라
     그 한 단을 통과하면 그 줄의 뜻을 세운 것이다(옛 사다리의 2단계 = 해석 쓰기 자리). */
  function sentenceSummary(states) {
    var out = { total: 0, byStage: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }, interpreted: 0, memorized: 0 };
    values(states).forEach(function (s) {
      if (s.kind !== 'sentence') return;
      var st = stageOf(s);
      out.total += 1;
      out.byStage[st] += 1;
      if (st >= 2) out.interpreted += 1;        // 1단계(줄 해석) 통과 — 목표①
      if (s.reached) out.memorized += 1;        // 6단계(단락 백지) 통과 — 목표②
    });
    return out;
  }

  function intOf(v) { var n = Math.floor(+v); return n >= 0 ? n : 0; }

  /* 본문 진행 요약(§3.6의 summary.passage) — 문장 사다리 밖의 세 층을 한 눈에 센다.
       chunkDone/chunkTotal  청크 트랙을 통과한 단락 / 청크 재료가 있는 단락
       paraBlank/paraTotal   단락 백지를 통과한 단락 / 전체 단락
       cumulative            누적 백지가 도달한 단락 수(0이면 미시작)
       check                 종합 Check 결과 {correct, total} 또는 null
     rec = 팩 저장소 기록 {cumulative:{[lastDay]:…}, check:{correct,total}}(§3.5).
     누적·종합은 상태(states)가 아니라 기록이라 밖에서 받는다 — 없으면 미시작으로 본다. */
  function passageSummary(pack, states, rec) {
    states = states || {};
    var groups = dayGroups(pack);
    var out = { chunkDone: 0, chunkTotal: 0, paraBlank: 0, paraTotal: groups.length, cumulative: 0, check: null };
    groups.forEach(function (g) {
      if (hasChunks(g)) {
        out.chunkTotal += 1;                     // 청크가 없는 단락은 분모에도 넣지 않는다
        var ck = states[chunkId(g.day)];
        if (ck && ck.reached) out.chunkDone += 1;
      }
      var pg = states[paraId(g.day)];
      if (pg && pg.reached) out.paraBlank += 1;
    });
    var cum = rec && rec.cumulative;
    if (cum) {
      /* 누적은 1일차 → 1+2일차 → … 이므로 앞에서부터 이어진 기록만 센다 — 중간이 비면
         거기서 멈춘다(뒤 기록만 있는 것은 순서를 건너뛴 값이라 진행으로 안 본다). */
      for (var i = 0; i < groups.length; i++) {
        if (!Object.prototype.hasOwnProperty.call(cum, groups[i].day)) break;
        out.cumulative = i + 1;
      }
    }
    if (rec && rec.check) out.check = { correct: intOf(rec.check.correct), total: intOf(rec.check.total) };
    return out;
  }

  /* 문장 사다리 진급(§4.2) — 통과 시 다음 단계, 6단계 통과는 완전 인출 성공으로
     처리해 단어와 같은 안정화 규칙(서로 다른 날 3회)을 탄다. 실패는 단계 유지.
     이중 진급 가드 — 한 세트(4단계 = 클로즈+배열 2문항)가 문항마다 부르면 5단계(영작)가
     사라지므로 두 번째 호출은 무시한다. 판정 근거는 정확한 순서로:
       opts.fromStage — 세트가 어느 단계용이었는지. 지금 단계와 다르면 이미 진급한 세트다.
                        호출자가 아는 사실이라 가장 정확하다(3단계 통과 직후 4단계를 1분 안에
                        끝내는 빠른 학생도 정상 진급한다).
       opts.session   — 세트 식별자. 같은 세션에서 두 번째면 무시.
       둘 다 없으면    — 마지막 진급 뒤 1분 안이면 무시(안전판. 앱이 세트 단위로 1회 부르는
                        지금은 걸릴 일이 없지만, 걸리면 빠른 정상 진급도 막히니 앱은 fromStage를
                        넘기는 게 맞다). */
  function advanceStage(s, passed, now, opts) {
    now = ms(now);
    s.last = now;
    if (!passed) return s;
    /* 단서가 남아 있으면 아직 진급이 아니다(§3.3) — 통과할 때마다 단서를 한 겹 지우고,
       단서 0에서 통과해야 다음 단으로 오른다. 어느 단계가 단서 단계인지는 호출자가 안다
       (문항을 만든 쪽이다) — opts.faded: true 로 알린다. 단서 계산은 recordCue가 한다. */
    if (opts && opts.faded === true && cueOf(s) > 0) return s;
    /* 단계는 stageOf로 읽는다 — 옛 상태의 4.5 같은 값을 원시값 그대로 비교하면
       planDay·sentenceSummary(내림)가 준 fromStage 4와 영영 안 맞아 진급이 막히고,
       session 경로에선 5.5→6.5로 비정수가 번져 dailySet(정수 키)이 문항을 못 만든다. */
    var cur = stageOf(s);
    if (cur < stageMaxOf(s)) {
      var session = opts && opts.session != null ? opts.session : null;
      var fromStage = opts && opts.fromStage != null ? Math.floor(+opts.fromStage) : null;
      var dup;
      if (fromStage != null) dup = cur !== fromStage;
      else if (session != null) dup = s.stageSession === session;
      else dup = s.stageAdvancedAt != null && now - s.stageAdvancedAt < STAGE_GUARD_MS;
      if (dup) return s;
      s.stageAdvancedFrom = cur;
      s.stageAdvancedAt = now;
      if (session != null) s.stageSession = session;
      s.stage = cur + 1;
      s.cue = 1;                 // 다음 단계는 다시 단서 1(빈칸+첫 글자)에서 시작한다
      return s;
    }
    return criterionSuccess(s, null, now);
  }

  /* 단서 농도 기록(§3.3) — 단서 단계(문장 사다리 1·3·5)의 유일한 호출 지점이다.
       통과 + 단서 남음 → 단서를 한 겹 지운다(단계 유지). "맞히면 힌트가 줄어요."
       통과 + 단서 0    → 그때 진급하고 다음 단계 단서를 1로 되돌린다.
       실패            → 단서를 한 겹 더 준다(최대 3). 단계는 내려가지 않는다.
     실패부터 시키면 학습이 아니라 회피가 생긴다 — 못하는 학생은 전사(3)까지 올라가
     답을 보고 옮겨 쓰면서 따라온다.
     같은 통과가 두 번 세지 않게, 단서 단계에서는 advanceStage를 따로 부르지 않는다.
     opts.session을 넘기면 같은 세션의 두 번째 호출은 무시한다(기존 이중 진급 가드와 같은 장치).
     opts.fromStage는 그대로 advanceStage로 넘어간다.
     반환: {before, cue, advanced, stage, reached, duplicate} */
  function recordCue(s, passed, now, opts) {
    now = ms(now);
    var before = cueOf(s);
    var session = opts && opts.session != null ? opts.session : null;
    var res = function (advanced, duplicate) {
      return {
        before: before, cue: cueOf(s), advanced: !!advanced,
        stage: stageOf(s), reached: !!s.reached, duplicate: !!duplicate
      };
    };
    if (session != null && s.cueSession === session) return res(false, true);
    if (session != null) s.cueSession = session;
    if (!passed) {
      s.cue = Math.min(CUE_MAX, before + 1);
      s.last = now;
      return res(false, false);
    }
    if (before > 0) {
      s.cue = before - 1;
      s.last = now;
      return res(false, false);
    }
    var stage0 = stageOf(s), reached0 = !!s.reached;
    var o = { faded: true };
    if (opts && opts.fromStage != null) o.fromStage = opts.fromStage;
    if (session != null) o.session = session;
    advanceStage(s, true, now, o);
    return res(stageOf(s) !== stage0 || (!reached0 && s.reached), false);
  }

  return {
    DAY: DAY, MIN10: MIN10, INTERVAL_DAYS: INTERVAL_DAYS,
    CRITERION_GAP_MS: CRITERION_GAP_MS, STAGE_GUARD_MS: STAGE_GUARD_MS,
    STAGE_MAX: STAGE_MAX, RELEARN_TARGET: RELEARN_TARGET,
    CUE_MAX: CUE_MAX, PARA_STEPS: PARA_STEPS,
    localDate: localDate, daysUntil: daysUntil, sentenceId: sentenceId,
    chunkId: chunkId, paraId: paraId, dayGroups: dayGroups,
    createState: createState, recordQuiz: recordQuiz, recordCriterion: recordCriterion,
    stability: stability, isStable: isStable, isDone: isDone,
    stageOf: stageOf, stageMaxOf: stageMaxOf, cueOf: cueOf, isCueStage: isCueStage,
    applyDiagnostic: applyDiagnostic, wordSummary: wordSummary,
    gate: gate, clearWrong: clearWrong, planDay: planDay,
    sentenceSummary: sentenceSummary, passageSummary: passageSummary,
    chunkGate: chunkGate, paraGate: paraGate,
    advanceStage: advanceStage, recordCue: recordCue,
    planRange: planRange, gateRange: gateRange, rangeSummary: rangeSummary
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WBNAESIN;
