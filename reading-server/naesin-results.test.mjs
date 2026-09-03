'use strict';
/* 시험 결과 분석·예측 검증 (node reading-server/naesin-results.test.mjs)
   기대값은 전부 손으로 계산해 적어 둔다 — 구현이 바뀌어도 숫자가 그대로여야 한다. */
import assert from 'node:assert';
import { reachOf, pearson, resultStats, predictScore, HIGH_BLANK, MIN_N_CORR, MIN_N_PREDICT, BAND_MIN } from './naesin-results.mjs';

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };

/* 단어 10개·문장 10개짜리 요약 — m = 0.04·안정화 + 0.03·해석 + 0.03·백지 로 딱 떨어진다.
   시드는 자체 창작 더미다(기획서 §9.3). */
const snap = (stable, interpreted, memorized) => ({
  packId: 'dummy-e2-mid1',
  word: { total: 10, reached: stable, stable, risky: 0, needsSpellCheck: 0 },
  sentence: { total: 10, interpreted, memorized, byStage: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: memorized } },
  task: null, updatedAt: '',
});
/* 도달률 m = 0.2 / 0.4 / 0.6 / 0.8 / 1.0 인 다섯 학생 (백지율 0 / 0 / .4 / .6 / 1.0) */
const M20 = snap(5, 0, 0), M40 = snap(10, 0, 0), M60 = snap(6, 8, 4), M80 = snap(8, 10, 6), M100 = snap(10, 10, 10);
const M50 = snap(5, 6, 4);   // 0.2+0.18+0.12 = 0.5 — 「지금 내 도달률」
const row = (code, score, snapshot, examDate = '2026-10-05') => ({ code, examDate, score, packIds: ['dummy-e2-mid1'], snapshot, at: '2026-10-06T09:00:00.000Z' });

/* 완전 직선: (m, score) = (.2,60) (.4,70) (.6,80) (.8,90) (1,100) → score = 50 + 50m, r = 1, RMSE = 0 */
const FIT = [row('st-1', 60, M20), row('st-2', 70, M40), row('st-3', 80, M60), row('st-4', 90, M80), row('st-5', 100, M100)];
/* 한 점만 어긋난 묶음: (.6, 100) → 평균 84, b = 50, a = 54, 잔차 -4·-4·+16·-4·-4 → RMSE = 8 */
const SCATTER = [row('st-1', 60, M20), row('st-2', 70, M40), row('st-3', 100, M60), row('st-4', 90, M80), row('st-5', 100, M100)];

t('reachOf — 복합 도달률 m = 0.4·안정화 + 0.3·해석 + 0.3·백지, 분모 0이면 그 항 0', () => {
  assert.deepStrictEqual(reachOf(M20), { stable: 0.5, interpret: 0, blank: 0, m: 0.2 });
  const r = reachOf(M60);
  assert.deepStrictEqual([r.stable, r.interpret, r.blank], [0.6, 0.8, 0.4]);
  assert.strictEqual(Math.round(r.m * 1000) / 1000, 0.6);
  assert.strictEqual(Math.round(reachOf(M100).m * 1000) / 1000, 1);
  /* 총수가 0이면 나눗셈이 아니라 0 — 아직 아무것도 안 한 학생이 NaN 으로 통계를 오염시키지 않는다 */
  const zero = reachOf({ word: { total: 0, stable: 0 }, sentence: { total: 0, interpreted: 0, memorized: 0 } });
  assert.deepStrictEqual(zero, { stable: 0, interpret: 0, blank: 0, m: 0 });
  /* 도달 수가 총수를 넘는 불량 요약은 1로 눌러 회귀가 튀지 않게 한다 */
  assert.strictEqual(reachOf({ word: { total: 10, stable: 99 }, sentence: { total: 0 } }).stable, 1);
  assert.strictEqual(reachOf({ word: { total: 10, stable: -5 }, sentence: { total: 10, interpreted: 'x', memorized: null } }).m, 0);
  assert.strictEqual(reachOf(null), null);
  assert.strictEqual(reachOf('x'), null);
  assert.strictEqual(reachOf([1]), null, '배열은 요약이 아니다');
});

t('reachOf — range(범위 합계)가 있으면 그것을 본다 (실제 시험은 2~3과)', () => {
  const withRange = {
    ...M20,
    range: { packIds: ['dummy-e2-mid1', 'dummy-e2-mid2'], word: { total: 20, reached: 20, stable: 20 },
      sentence: { total: 20, interpreted: 20, memorized: 20, byStage: {} }, packs: {} },
  };
  assert.strictEqual(reachOf(withRange).m, 1, '팩 값(0.2)이 아니라 범위 합계(1.0)');
  assert.strictEqual(reachOf({ ...M20, range: 'x' }).m, 0.2, 'range 가 객체가 아니면 팩 값으로 물러난다');
});

t('pearson — 손으로 계산한 값과 일치, 분산 0이면 null', () => {
  assert.strictEqual(pearson([1, 2, 3], [2, 4, 6]), 1);
  assert.strictEqual(pearson([1, 2, 3], [3, 2, 1]), -1);
  /* (1,2)(2,4)(3,5): dx=-1,0,1 dy=-1.667,0.333,1.333 → Sxy=3, Sxx=2, Syy=4.667 → r=3/√9.333=0.98198 */
  assert.strictEqual(Math.round(pearson([1, 2, 3], [2, 4, 5]) * 100000) / 100000, 0.98198);
  assert.strictEqual(pearson([1, 1, 1], [1, 2, 3]), null, '한쪽이 전부 같은 값이면 정의되지 않는다');
  assert.strictEqual(pearson([1, 2], [1]), null, '길이가 다르면 null');
  assert.strictEqual(pearson([1], [1]), null);
});

t('resultStats — 평균·상관·백지 그룹 (완전 직선 묶음: r = 1)', () => {
  const s = resultStats(FIT);
  assert.strictEqual(s.n, 5);
  assert.strictEqual(s.meanScore, 80, '(60+70+80+90+100)/5');
  assert.strictEqual(s.r, 1, '도달률과 점수가 정확히 같이 움직인다');
  assert.deepStrictEqual(s.groups.highBlank, { n: 1, mean: 100 }, '백지율 100% 한 명');
  assert.deepStrictEqual(s.groups.lowBlank, { n: 4, mean: 75 }, '(60+70+80+90)/4');
  assert.deepStrictEqual(Object.keys(s.byDate), ['2026-10-05']);
  assert.deepStrictEqual(s.byDate['2026-10-05'], { n: 5, meanScore: 80, r: 1 });
});

t('resultStats — 흩어진 묶음의 r = 20/√528 = 0.870 (셋째 자리 반올림)', () => {
  const s = resultStats(SCATTER);
  assert.strictEqual(s.meanScore, 84, '420/5');
  assert.strictEqual(s.r, 0.87, 'Σdxdy=20, Σdx²=0.4, Σdy²=1320 → 20/√(0.4·1320)=0.8704');
  assert.deepStrictEqual(s.groups.highBlank, { n: 1, mean: 100 });
  assert.deepStrictEqual(s.groups.lowBlank, { n: 4, mean: 80 }, '(60+70+100+90)/4');
});

t('resultStats — 표본이 적으면 상관을 내지 않는다(n<3 → null)', () => {
  assert.strictEqual(MIN_N_CORR, 3);
  assert.strictEqual(resultStats(FIT.slice(0, 2)).r, null, '점 두 개로 그린 직선은 거짓말이다');
  assert.strictEqual(resultStats(FIT.slice(0, 2)).n, 2, 'n·평균은 그래도 낸다');
  assert.strictEqual(resultStats(FIT.slice(0, 2)).meanScore, 65);
  assert.strictEqual(resultStats(FIT.slice(0, 3)).r, 1, '세 건부터 낸다');
  /* 도달률이 전부 같으면 상관은 정의되지 않는다 — 0 이 아니라 null */
  assert.strictEqual(resultStats([row('a', 60, M20), row('b', 70, M20), row('c', 80, M20)]).r, null);
});

t('resultStats — 빈 입력·불량 입력에서도 셈이 깨지지 않는다', () => {
  assert.deepStrictEqual(resultStats([]), {
    n: 0, meanScore: null, r: null,
    groups: { highBlank: { n: 0, mean: null }, lowBlank: { n: 0, mean: null } }, byDate: {},
  });
  assert.deepStrictEqual(resultStats(null), resultStats([]));
  assert.deepStrictEqual(resultStats(['x', null, { score: 'abc' }, { nope: 1 }]), resultStats([]), '점수 없는 줄은 세지 않는다');
  /* snapshot 이 없는 결과(옛 기록)는 평균에는 들어가고 상관·그룹에는 안 들어간다 */
  const mixed = resultStats([...FIT, row('st-6', 0, null)]);
  assert.strictEqual(mixed.n, 6);
  assert.strictEqual(mixed.meanScore, 66.7, '400/6 = 66.67 → 소수 첫째 자리');
  assert.strictEqual(mixed.r, 1, '도달률 짝이 없는 줄은 상관에서 빠진다');
  assert.strictEqual(mixed.groups.highBlank.n + mixed.groups.lowBlank.n, 5);
});

t('resultStats — byDate: 시험일별 n·평균·상관', () => {
  const rows = [
    row('st-1', 60, M20, '2026-05-01'), row('st-2', 70, M40, '2026-05-01'), row('st-3', 80, M60, '2026-05-01'),
    row('st-1', 90, M80, '2026-10-05'), row('st-2', 100, M100, '2026-10-05'),
  ];
  const s = resultStats(rows);
  assert.deepStrictEqual(Object.keys(s.byDate), ['2026-05-01', '2026-10-05'], '날짜순 키');
  assert.deepStrictEqual(s.byDate['2026-05-01'], { n: 3, meanScore: 70, r: 1 });
  assert.deepStrictEqual(s.byDate['2026-10-05'], { n: 2, meanScore: 95, r: null }, '두 건짜리 시험일은 상관 없음');
  assert.strictEqual(s.n, 5);
  assert.strictEqual(s.meanScore, 80);
});

t('predictScore — 최소제곱 직선 score = 50 + 50m, 완전 직선이면 구간은 최소 폭 ±5', () => {
  assert.strictEqual(BAND_MIN, 5);
  /* m_now = 0.5 → 50 + 25 = 75, RMSE = 0 → ±max(5,0) */
  assert.deepStrictEqual(predictScore(FIT, M50), { score: 75, low: 70, high: 80, n: 5 });
  assert.deepStrictEqual(predictScore(FIT, M20), { score: 60, low: 55, high: 65, n: 5 }, '표본 안의 점은 그 점수로 돌아온다');
});

t('predictScore — 잔차가 있으면 RMSE 만큼 넓어진다 (a=54, b=50, RMSE=8)', () => {
  /* m_now = 0.5 → 54 + 25 = 79, ±max(5,8) */
  assert.deepStrictEqual(predictScore(SCATTER, M50), { score: 79, low: 71, high: 87, n: 5 });
  /* m_now = 1.0 → 104 → 0~100 으로 자른다 */
  assert.deepStrictEqual(predictScore(SCATTER, M100), { score: 100, low: 96, high: 100, n: 5 });
});

t('predictScore — 표본이 적으면 예측하지 않는다(n<5 → null), 내 요약이 없어도 null', () => {
  assert.strictEqual(MIN_N_PREDICT, 5);
  assert.strictEqual(predictScore(FIT.slice(0, 4), M50), null, '네 건으로는 말하지 않는다');
  assert.ok(predictScore(FIT, M50), '다섯 건부터');
  assert.strictEqual(predictScore(FIT, null), null);
  assert.strictEqual(predictScore(FIT, {}).score, 50, '빈 요약은 m=0 — 직선의 절편');
  assert.strictEqual(predictScore([], M50), null);
  assert.strictEqual(predictScore(null, M50), null);
  /* snapshot 없는 결과는 짝이 못 되어 표본에서 빠진다 — 그래서 5건이 안 된다 */
  assert.strictEqual(predictScore([...FIT.slice(0, 4), row('st-6', 90, null)], M50), null);
});

t('predictScore — 도달률이 전부 같으면 기울기 없이 평균, 0 아래로 안 내려간다', () => {
  const flat = [row('a', 5, M20), row('b', 5, M20), row('c', 5, M20), row('d', 5, M20), row('e', 5, M20)];
  assert.deepStrictEqual(predictScore(flat, M100), { score: 5, low: 0, high: 10, n: 5 }, '평균 5점 ±5, 아래는 0으로 자른다');
});

t('HIGH_BLANK 경계 — 백지율 0.8 은 高 그룹에 든다(이상)', () => {
  assert.strictEqual(HIGH_BLANK, 0.8);
  const at80 = snap(0, 0, 8);    // 백지율 정확히 0.8
  const at70 = snap(0, 0, 7);
  const s = resultStats([row('a', 90, at80), row('b', 80, at70), row('c', 70, at70)]);
  assert.deepStrictEqual(s.groups.highBlank, { n: 1, mean: 90 });
  assert.deepStrictEqual(s.groups.lowBlank, { n: 2, mean: 75 });
});

console.log('\n통과 ' + passed + '개 — 시험 결과 분석·예측 검증 완료');
