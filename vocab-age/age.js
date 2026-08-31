'use strict';
/* WB 어휘 나이 진단 — 판정 로직 (브라우저/Node 공용, 순수 함수)
   기획서 §8 Phase 3 「외부 공개 체험판(어휘 나이 진단)」.

   재는 방법: 계단(staircase). 학년대마다 뜻 고르기 3문항을 내고,
   2개 이상 맞히면 한 칸 올라가고 아니면 내려간다. 못 올라가는 칸이 나오면 멈춘다.
   전수 검사가 아니라 「어느 학년대 낱말까지 아는가」를 빠르게 좁히는 방식이다.

   이 수치는 참고용이다. 낱말 뜻만 재고, 한 교재 계열에서 뽑은 낱말이며,
   문항 수가 적다. 검사 도구가 아니라는 것을 화면에도 적어 둔다. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WBAGE = api;
}(typeof self !== 'undefined' ? self : this, function () {

  /* 학년대 사다리 — 아래에서 위로 */
  var BANDS = [
    { id: 'cho1', label: '초1', age: '만 6~7세' },
    { id: 'cho2', label: '초2', age: '만 7~8세' },
    { id: 'cho3', label: '초3', age: '만 8~9세' },
    { id: 'cho4', label: '초4', age: '만 9~10세' },
    { id: 'cho56', label: '초5·6', age: '만 10~12세' },
    { id: 'jung', label: '중1~3', age: '만 13~15세' },
  ];
  var PER_BAND = 3;          // 한 칸에 내는 문항 수
  var PASS = 2;              // 이 이상 맞히면 그 칸을 통과로 본다

  function bandIndex(id) {
    for (var i = 0; i < BANDS.length; i++) if (BANDS[i].id === id) return i;
    return -1;
  }

  /* 다음에 갈 칸을 정한다.
       done   — 더 낼 것이 없다
       next   — 다음에 낼 칸의 번호
     tried[i] = 그 칸에서 맞힌 개수 (안 본 칸은 undefined)

     올라가다 처음 막히면 거기서 끝난다. 시작 칸부터 틀리면 내려가며 통과하는 칸을 찾는다.
     한 번 본 칸은 다시 내지 않는다 — 그래야 끝나고, 같은 낱말이 두 번 나오지 않는다. */
  function nextBand(tried) {
    var seen = [];
    for (var i = 0; i < BANDS.length; i++) if (typeof tried[i] === 'number') seen.push(i);
    if (!seen.length) return { done: false, next: null, reason: 'start' };

    var lo = seen[0], hi = seen[seen.length - 1];
    /* 맨 위 칸을 통과했으면 더 볼 것이 없다 */
    if (tried[hi] >= PASS) {
      if (hi === BANDS.length - 1) return { done: true, next: null, reason: 'ceiling' };
      return { done: false, next: hi + 1, reason: 'up' };
    }
    /* 막혔다. 그 아래에 통과한 칸이 이미 있으면 끝 */
    for (var k = 0; k < seen.length; k++) if (tried[seen[k]] >= PASS) return { done: true, next: null, reason: 'settled' };
    /* 아직 한 칸도 통과 못 했으면 내려간다 */
    if (lo === 0) return { done: true, next: null, reason: 'floor' };
    return { done: false, next: lo - 1, reason: 'down' };
  }

  /* 결과 — 통과한 가장 높은 칸이 그 아이의 어휘 수준이다.
     한 칸도 통과 못 하면 맨 아래 칸 미만(below)으로 본다. */
  function verdict(tried) {
    var best = -1;
    for (var i = 0; i < BANDS.length; i++) if (tried[i] >= PASS) best = i;
    var asked = 0, right = 0;
    for (var j = 0; j < BANDS.length; j++) {
      if (typeof tried[j] !== 'number') continue;
      asked += PER_BAND; right += tried[j];
    }
    return {
      below: best < 0,
      band: best < 0 ? null : BANDS[best],
      /* 통과한 칸 바로 위가 「아직 어려운」 칸이다 */
      nextBand: (best >= 0 && best < BANDS.length - 1) ? BANDS[best + 1] : null,
      asked: asked, right: right,
    };
  }

  return {
    BANDS: BANDS, PER_BAND: PER_BAND, PASS: PASS,
    bandIndex: bandIndex, nextBand: nextBand, verdict: verdict,
  };
}));
