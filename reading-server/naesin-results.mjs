'use strict';
/* WB 내신 — 시험 결과 회고 분석 (순수 함수, 저장소·라우트와 무관)
   naesin-api.mjs 의 /admin/results·/result 가 쓰고, 테스트는 naesin-results.test.mjs.

   왜 따로 두나: 앱이 재는 것은 전부 「앱 안 도달률」이다. 이 앱이 실제 학교 시험 점수를
   올리는지는 시험이 끝난 뒤 강사가 넣는 점수와, 그 시점의 도달률(snapshot)을 나란히
   놓아야만 알 수 있다. 그 판단은 서버가 숫자로만 내고(상관·평균·최소제곱 직선),
   「예상 점수대」 같은 말투는 화면 몫이다.

   표본이 적으면 아무 말도 하지 않는다 — 점 두 개로 그린 직선은 학생에게 거짓말이 된다.
   상관은 3건, 예측은 5건부터. */

/* 복합 도달률 m 의 가중치 — 세 최종 목표(① 해석 ② 백지 ③ 단어 100%)의 비중.
   단어 안정화가 가장 무겁다: 시험 전 단어 완성이 나머지 둘의 전제이기 때문. */
const W_STABLE = 0.4, W_INTERPRET = 0.3, W_BLANK = 0.3;
export const HIGH_BLANK = 0.8;      // 「백지 80% 이상」 그룹 경계 — 기획서의 목표선
export const MIN_N_CORR = 3;        // 상관계수를 내는 최소 표본
export const MIN_N_PREDICT = 5;     // 예측 직선을 내는 최소 표본
export const BAND_MIN = 5;          // 예측 구간의 최소 폭(±점) — RMSE 가 작아도 이보다 좁게 말하지 않는다

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/* 음수·비유한 값은 0으로. 학생 기기가 올린 요약이 원천이라 이 방어가 통계 전체를 지킨다. */
const n0 = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
/* 분모 0이면 그 항은 0. 도달 수가 총수를 넘는 불량 요약은 1로 눌러 회귀가 튀지 않게 한다. */
const rate = (a, b) => (b > 0 ? Math.min(1, n0(a) / b) : 0);
const round = (v, d) => { const p = Math.pow(10, d); return Math.round(v * p) / p; };
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const meanOrNull = (xs, d = 1) => (xs.length ? round(mean(xs), d) : null);

/* 요약 하나에서 도달률 세 값과 복합 도달률 m 을 뽑는다.
   범위 합계(summary.range, 계약 R1)가 있으면 그것을 본다 — 실제 시험 범위는 보통 2~3과라
   팩 하나의 값으로는 점수와 견줄 단위가 맞지 않는다. 없으면 팩 값(옛 요약)으로 물러난다. */
export function reachOf(summary) {
  if (!isObj(summary)) return null;
  const src = isObj(summary.range) ? summary.range : summary;
  const w = isObj(src.word) ? src.word : {};
  const s = isObj(src.sentence) ? src.sentence : {};
  const stable = rate(w.stable, n0(w.total));
  const interpret = rate(s.interpreted, n0(s.total));
  const blank = rate(s.memorized, n0(s.total));
  return { stable, interpret, blank, m: W_STABLE * stable + W_INTERPRET * interpret + W_BLANK * blank };
}

/* 편차제곱합이 사실상 0인가 — 값이 전부 같아도 부동소수점 때문에 정확히 0이 아니라
   1e-33 같은 찌꺼기가 남는다(0.2 세 개의 평균은 0.20000000000000004). 그대로 나누면
   뜻 없는 상관·터무니없는 기울기가 나오므로, 값의 크기에 견주어 0인지 본다. */
const isFlat = (ss, mu, n) => !(ss > 1e-12 * n * Math.max(1, mu * mu));

/* 피어슨 상관계수. 한쪽이 전부 같은 값이면(분산 0) 정의되지 않는다 — null 로 돌려
   화면이 "0에 가깝다"로 오해하지 않게 한다. */
export function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2 || ys.length !== n) return null;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (isFlat(sxx, mx, n) || isFlat(syy, my, n)) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/* 결과 한 건이 통계에 쓸 수 있는 모양인가 — 점수는 필수, snapshot 은 있으면 도달률 짝이 된다 */
const scoreOf = (row) => {
  if (!isObj(row)) return null;
  const n = Number(row.score);
  return Number.isFinite(n) ? n : null;
};
function pairsOf(rows) {
  const out = [];
  for (const row of rows) {
    const score = scoreOf(row);
    if (score == null) continue;
    const re = reachOf(row.snapshot);
    if (re) out.push({ m: re.m, blank: re.blank, score, examDate: typeof row.examDate === 'string' ? row.examDate : '' });
  }
  return out;
}
const corrOf = (pairs) => (pairs.length >= MIN_N_CORR
  ? (() => { const r = pearson(pairs.map((p) => p.m), pairs.map((p) => p.score)); return r == null ? null : round(r, 3); })()
  : null);

/* 결과 묶음의 분석 (계약 R2)
   반환 { n, meanScore, r, groups:{highBlank:{n,mean}, lowBlank:{n,mean}}, byDate:{[examDate]:{n,meanScore,r}} }
   - n·meanScore 는 점수가 있는 모든 결과, r·groups 는 snapshot 이 있는 결과만(도달률 짝이 있어야 한다).
   - r 은 표본 3건 미만이면 null. 평균은 소수 첫째 자리, r 은 셋째 자리에서 반올림한다. */
export function resultStats(results) {
  const rows = (Array.isArray(results) ? results : []).filter((r) => scoreOf(r) != null);
  const scores = rows.map(scoreOf);
  const pairs = pairsOf(rows);
  const hi = pairs.filter((p) => p.blank >= HIGH_BLANK), lo = pairs.filter((p) => p.blank < HIGH_BLANK);

  const byDate = {};
  for (const row of rows) {
    const d = typeof row.examDate === 'string' && row.examDate ? row.examDate : '';
    if (!d) continue;
    (byDate[d] = byDate[d] || []).push(row);
  }
  const byDateOut = {};
  for (const d of Object.keys(byDate).sort()) {
    const group = byDate[d];
    byDateOut[d] = { n: group.length, meanScore: meanOrNull(group.map(scoreOf)), r: corrOf(pairsOf(group)) };
  }

  return {
    n: rows.length,
    meanScore: meanOrNull(scores),
    r: corrOf(pairs),
    groups: {
      highBlank: { n: hi.length, mean: meanOrNull(hi.map((p) => p.score)) },
      lowBlank: { n: lo.length, mean: meanOrNull(lo.map((p) => p.score)) },
    },
    byDate: byDateOut,
  };
}

/* 현재 도달률로 본 예상 점수대 (계약 R2)
   원내 결과 전체로 최소제곱 직선 score ≈ a + b·m 을 세우고, 내 지금 요약의 m 을 넣는다.
   구간은 ± max(5, RMSE) — 잔차가 작아도 5점보다 좁게 말하지 않는다. 0~100 으로 자른다.
   표본 5건 미만이거나 내 요약이 없으면 null: 아무 말도 하지 않는 것이 맞다. */
export function predictScore(results, summary) {
  const mine = reachOf(summary);
  if (!mine) return null;
  const pairs = pairsOf(Array.isArray(results) ? results : []);
  if (pairs.length < MIN_N_PREDICT) return null;

  const xs = pairs.map((p) => p.m), ys = pairs.map((p) => p.score);
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < xs.length; i++) { const dx = xs[i] - mx; sxy += dx * (ys[i] - my); sxx += dx * dx; }
  /* 도달률이 전부 같으면 기울기를 낼 수 없다 — 평균으로 답한다(기울기 0) */
  const b = isFlat(sxx, mx, xs.length) ? 0 : sxy / sxx;
  const a = my - b * mx;
  let se = 0;
  for (let i = 0; i < xs.length; i++) { const d = ys[i] - (a + b * xs[i]); se += d * d; }
  const rmse = Math.sqrt(se / xs.length);
  const band = Math.max(BAND_MIN, rmse);
  const raw = a + b * mine.m;
  const clamp = (v) => Math.max(0, Math.min(100, Math.round(v)));
  return { score: clamp(raw), low: clamp(raw - band), high: clamp(raw + band), n: pairs.length };
}
