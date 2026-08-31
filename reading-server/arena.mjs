'use strict';
/* WB 워드브레인 — 아레나(반 대전) 판정 로직 (server.mjs·worker.mjs 공용, 순수 함수)
   기획서 §2.5 ③·§8 Phase 3. 또래 대전은 초·중등 지속률의 검증된 지렛대다(§319).

   하루 단위 반 대전이다. 반 전체가 같은 문제를 받고 각자 편할 때 푼다.
   같은 순간에 둘이 접속해 있어야 하는 실시간 맞대결은 8명 반에서 상대를 못 찾는다 —
   상대가 없는 대전은 없는 것보다 나쁘다. 실시간은 이 위에 얹을 수 있다.

   공정하려면 세 가지가 필요하다.
   ① 반 전체가 같은 문제 — 날짜와 반 이름으로 자리를 고정한다(같은 날 같은 반이면 같은 문제).
   ② 하루 한 번 — 여러 번 풀면 점수가 아니라 시도 횟수를 재게 된다.
   ③ 채점은 서버가 — 순위표가 걸리면 화면이 보내온 점수를 믿을 수 없다. */

export const ARENA_Q = 10;          // 하루 문항 수
export const ARENA_MS_CAP = 20000;  // 한 문항 시간 상한(ms) — 자리 비운 것을 점수로 안 친다

/* 자리를 고정하는 난수 — 같은 씨앗이면 늘 같은 차례가 나온다 */
function seedOf(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rngOf(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffleWith(rnd, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}

/* 오늘의 문제를 만든다. pool = [{word, meaning}] — 그 반이 배운 낱말.
   같은 (반, 날짜)면 늘 같은 결과다. 보기도 같은 자리에 온다. */
export function buildRound(pool, cls, day) {
  const uniq = [];
  const seen = new Set();
  for (const w of pool || []) {
    if (!w || !w.word || !w.meaning) continue;
    if (seen.has(w.word) || seen.has(w.meaning)) continue;
    seen.add(w.word); seen.add(w.meaning);
    uniq.push({ word: w.word, meaning: w.meaning });
  }
  /* 보기 넷을 만들려면 낱말이 최소 넷은 있어야 한다 */
  if (uniq.length < 4) return null;
  const rnd = rngOf(seedOf(cls + '|' + day));
  const picked = shuffleWith(rnd, uniq).slice(0, Math.min(ARENA_Q, uniq.length));
  return picked.map((w) => {
    const others = shuffleWith(rnd, uniq.filter((x) => x.word !== w.word)).slice(0, 3).map((x) => x.meaning);
    return { word: w.word, answer: w.meaning, options: shuffleWith(rnd, [w.meaning].concat(others)) };
  });
}

/* 화면에는 정답을 빼고 보낸다 — 답이 같이 가면 순위표가 의미를 잃는다 */
export const forClient = (round) => (round || []).map((q) => ({ word: q.word, options: q.options }));

/* 채점. answers = 학생이 고른 보기 문자열 배열, times = 문항별 걸린 ms.
   점수 = 맞은 개수 × 100 + 빠르기 보너스. 정확도가 먼저고 속도는 동점을 가른다. */
export function grade(round, answers, times) {
  const n = (round || []).length;
  const a = Array.isArray(answers) ? answers : [];
  const t = Array.isArray(times) ? times : [];
  let right = 0, ms = 0;
  const marks = [];
  for (let i = 0; i < n; i++) {
    const ok = typeof a[i] === 'string' && a[i] === round[i].answer;
    if (ok) right += 1;
    marks.push(ok);
    const each = Number(t[i]);
    ms += Number.isFinite(each) && each > 0 ? Math.min(each, ARENA_MS_CAP) : ARENA_MS_CAP;
  }
  /* 빠르기 보너스는 맞힌 문항에만 준다 — 찍고 넘기는 것이 이득이 되면 안 된다 */
  const avg = n ? ms / n : ARENA_MS_CAP;
  const speed = right ? Math.round(Math.max(0, (ARENA_MS_CAP - avg) / ARENA_MS_CAP) * 50) : 0;
  return { right: right, total: n, ms: ms, score: right * 100 + speed, marks: marks };
}

/* 순위표. rows = [{code, name, score, right, ms}] */
export function rank(rows, meCode) {
  const list = (rows || []).slice().sort((x, y) => y.score - x.score || x.ms - y.ms
    || String(x.name || x.code).localeCompare(String(y.name || y.code), 'ko'));
  return list.map((r, i) => ({ ...r, place: i + 1, me: r.code === meCode }));
}
