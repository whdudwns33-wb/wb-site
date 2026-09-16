'use strict';
/* 오답 원인 5분류와 처방 라우터. 학생에게 묻는 것은 딱 하나("다시 보니 풀 수 있다 / 아직 모르겠다")이고 30초 안에 반증된다.
   순서가 규칙이다: confuse 를 첫 줄에 두면 4지선다 오답의 70~75% 가 참 원인과 무관하게 confuse 로 찍힌다. */
var WBHARU_C = (function () {
  var TIME_MS = 180000;                   // 이보다 오래 붙들었거나 [넘김]이면 ⑤ 시간
  var CAUSES = ['gap', 'exec', 'confuse', 'misread', 'time'];
  var LABEL = { gap: '몰라서', exec: '실행 오류', confuse: '유형 혼동', misread: '문제 오독', time: '시간' };

  function choiceOf(item, picked) {
    return ((item && item.choices) || []).filter(function (c) { return c.key === picked; })[0] || null;
  }

  /* item: 팩 문항(choices[].atomId·errKind 포함본 — 기기에서 분류하므로 정답 제거본이 아니라 응답 후 /answer 가 준 것)
     picked: 고른 키 또는 'skip' · ms: 소요 · s: 원자 상태(reached 여부) · probe: {said:'canDo'|'no', ok:bool} 30초 반증 결과 */
  function classify(item, picked, ms, s, probe) {
    var ch = choiceOf(item, picked);
    if (picked === 'skip' || ms > TIME_MS)                       return 'time';     // ⑤
    if (s && s.reached && ch && ch.errKind === 'calc')           return 'exec';     // ② 팩이 표시한 계산 실수형 오답 (도달한 원자에서만)
    if (probe && probe.said === 'canDo' && probe.ok === true)     return 'misread';  // ④ 반증 통과 — 다시 보니 풀 수 있었다
    if (ch && ch.atomId)                                         return 'confuse';  // ③ 오답이 다른 원자의 정답
    return 'gap';                                                                   // ①
  }

  /* 처방 — cause 는 라우터의 내부 값이고 화면에 나오는 것은 그 결과(다음 카드·봉투)뿐이다. */
  function route(cause, s, atom) {
    switch (cause) {
      case 'gap':     return { mode: 'ladder', stage: 1, cue: 3, items: 3, priority: 2 };                                  // 완전 풀이부터 (GET /cue)
      case 'exec':    return { mode: 'block', stage: 3, cue: 0, items: 3, stepBack: 2, priority: 1 };                      // 2계단 후퇴 + 최우선 재출제 + 자동화
      case 'confuse': return { mode: 'interleave', stage: 4, cue: 0, items: 8, with: (atom && atom.confuse) || [], priority: 2 }; // 혼동 짝과 번갈아
      case 'misread': return { mode: 'markConditions', stage: s && s.stage ? s.stage : 3, cue: 0, items: 3, priority: 3 };   // 발문 표시 훈련
      case 'time':    return { mode: 'block', stage: 3, cue: 0, items: 3, priority: 3 };                                    // 초시계 아님. 블록으로 되돌려 자동화
      default:        return { mode: 'ladder', stage: 1, cue: 3, items: 3, priority: 2 };
    }
  }

  /* 원인 분포 — 누적 오답 n < MIN_N 이면 그리지 않는다(목록만). 점 두 개로 그린 파이는 학생에게 거짓말이 된다. */
  function distribution(wrong, minN) {
    var by = { gap: 0, exec: 0, confuse: 0, misread: 0, time: 0 }, n = 0;
    (wrong || []).forEach(function (w) { if (by[w.cause] != null) { by[w.cause]++; n++; } });
    return { show: n >= (minN == null ? 10 : minN), n: n, byCause: by };
  }

  return { CAUSES: CAUSES, LABEL: LABEL, TIME_MS: TIME_MS, choiceOf: choiceOf, classify: classify, route: route, distribution: distribution };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WBHARU_C;
