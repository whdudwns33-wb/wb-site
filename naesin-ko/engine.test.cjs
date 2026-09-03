'use strict';
/* WB 국어브레인 — 학습 엔진 검증 (node naesin-ko/engine.test.cjs)
   정본: 기획서 §4.1 사다리·§4.2 상시 큐·§4.6 적용 정답률 게이트·§5.4 D-21 플랜 */
const assert = require('assert');
const E = require('./engine.js');

const DAY = E.DAY;
let passed = 0;
function t(name, fn) { fn(); passed += 1; console.log('  ✓ ' + name); }

/* 고정 시각 — 로컬 달력 기준으로 서로 다른 날을 확실히 밟는다 */
const d1 = new Date(2026, 8, 2, 12, 0, 0).getTime();
const d1b = new Date(2026, 8, 2, 20, 0, 0).getTime();  // 같은 날 저녁
const d2 = new Date(2026, 8, 3, 9, 0, 0).getTime();
const d3 = new Date(2026, 8, 4, 9, 0, 0).getTime();
const d4 = new Date(2026, 8, 5, 9, 0, 0).getTime();

function mkPack(nVocab, nBlank, nWork) {
  const works = [];
  for (let w = 1; w <= (nWork || 1); w++) {
    const vocab = [], blanks = [];
    for (let i = 1; i <= nVocab; i++) vocab.push({ id: 'v' + w + '-' + i });
    for (let i = 1; i <= nBlank; i++) blanks.push({ id: 'b' + w + '-' + i });
    works.push({ workId: 'wk' + w, vocab, blanks });
  }
  return { works };
}

console.log('WBKOENGINE');

/* ── 날짜 유틸 ── */
t('localDate는 로컬 달력 날짜를 낸다', () => {
  assert.strictEqual(E.localDate(d1), '2026-09-02');
});
t('daysUntil은 오늘 0, 내일 1, 지난 날은 음수', () => {
  assert.strictEqual(E.daysUntil('2026-09-02', d1), 0);
  assert.strictEqual(E.daysUntil('2026-09-03', d1), 1);
  assert.strictEqual(E.daysUntil('2026-09-01', d1), -1);
});
t('상태 키는 kind별 접두어로 유도된다', () => {
  assert.strictEqual(E.vocabKey('x'), 'v-x');
  assert.strictEqual(E.blankKey('x'), 'b-x');
  assert.strictEqual(E.workKey('x'), 'w-x');
});

/* ── 2층 암기 모델 ── */
t('완전 인출 첫 성공은 도달, 안정화는 0', () => {
  const s = E.createState('a', 'blank', d1);
  E.recordCriterion(s, { correct: true, confidence: 'sure' }, d1);
  assert.strictEqual(s.reached, true);
  assert.strictEqual(s.relearnCount, 0);
  assert.strictEqual(E.stability(s), 0);
});
t('같은 날 두 번 성공해도 안정화는 오르지 않는다', () => {
  const s = E.createState('a', 'blank', d1);
  E.recordCriterion(s, { correct: true, confidence: 'sure' }, d1);
  E.recordCriterion(s, { correct: true, confidence: 'sure' }, d1b);
  assert.strictEqual(s.relearnCount, 0);
});
t('서로 다른 날 3회 재도달이면 안정화 완료', () => {
  const s = E.createState('a', 'blank', d1);
  [d1, d2, d3, d4].forEach((n) => E.recordCriterion(s, { correct: true, confidence: 'sure' }, n));
  assert.strictEqual(s.relearnCount, E.RELEARN_TARGET);
  assert.strictEqual(E.isStable(s), true);
});
t('오답+확실은 과신 오류로 2계단 후퇴한다', () => {
  const s = E.createState('a', 'vocab', d1);
  s.step = 3;
  E.recordQuiz(s, { correct: false, confidence: 'sure' }, d1);
  assert.strictEqual(s.step, 1);
  assert.strictEqual(s.overconfident, 1);
});
t('찍어서 맞으면 간격을 올리지 않는다', () => {
  const s = E.createState('a', 'vocab', d1);
  E.recordQuiz(s, { correct: true, confidence: 'guess' }, d1);
  assert.strictEqual(s.step, 0);
  assert.strictEqual(s.due, d1 + DAY);
});
t('진단 통과분은 재검증 플래그가 달리고 안정화는 0부터', () => {
  const states = { 'v-a': E.createState('a', 'vocab', d1) };
  states['v-a'].relearnCount = 2;
  E.applyDiagnostic(states, [{ key: 'v-a', known: true }], d1);
  assert.strictEqual(states['v-a'].reached, true);
  assert.strictEqual(states['v-a'].needsRecheck, true);
  assert.strictEqual(states['v-a'].relearnCount, 0);
});

/* ── 적용 정답률 게이트(§4.6) — 국어는 어휘가 아니라 적용이 전제다 ── */
t('적용 시도가 없으면 게이트는 잠긴다', () => {
  const w = E.createState('wk1', 'work', d1);
  const g = E.gate(w, { examDate: '2026-09-20' }, {});
  assert.strictEqual(g.open, false);
  assert.strictEqual(g.reason, 'apply-gate');
});
t('적용 정답률이 기준을 넘으면 열린다', () => {
  const w = E.createState('wk1', 'work', d1);
  for (let i = 0; i < 8; i++) E.recordApply(w, true, d1);
  for (let i = 0; i < 2; i++) E.recordApply(w, false, d1);
  assert.strictEqual(E.applyRate(w), 0.8);
  assert.strictEqual(E.gate(w, { examDate: '2026-09-20' }, {}).open, true);
});
t('연습 모드에는 게이트가 없다', () => {
  const w = E.createState('wk1', 'work', d1);
  assert.strictEqual(E.gate(w, null, {}).open, true);
  assert.strictEqual(E.gate(w, null, {}).reason, 'practice');
});
t('오버라이드·병행 모드는 잠긴 게이트를 연다', () => {
  const w = E.createState('wk1', 'work', d1);
  assert.strictEqual(E.gate(w, { examDate: '2026-09-20' }, { override: true }).reason, 'override');
  assert.strictEqual(E.gate(w, { examDate: '2026-09-20' }, { parallel: true }).reason, 'parallel');
});

/* ── 사다리(§4.1) ── */
t('4단계 통과는 완전 인출로 처리되고 5단계로 올라간다', () => {
  const s = E.createState('wk1', 'work', d1);
  s.stage = 4;
  E.advanceStage(s, true, d1);
  assert.strictEqual(s.stage, 5);
  assert.strictEqual(s.reached, true);       // 주석 복원 통과 = 도달
  assert.strictEqual(!!s.essayDone, false);  // 서술형은 아직
});
t('5단계 통과라야 essayDone이 선다', () => {
  const s = E.createState('wk1', 'work', d1);
  s.stage = 5;
  E.advanceStage(s, true, d1);
  assert.strictEqual(s.essayDone, true);
});
t('실패하면 단계가 그대로다', () => {
  const s = E.createState('wk1', 'work', d1);
  s.stage = 2;
  E.advanceStage(s, false, d1);
  assert.strictEqual(s.stage, 2);
});
t('작품 완료는 적용·복원·서술형 세 조건을 모두 본다', () => {
  const s = E.createState('wk1', 'work', d1);
  s.stage = 5; s.reached = true; s.applyRight = 9; s.applyTotal = 10;
  let sum = E.workSummary({ 'w-wk1': s });
  assert.strictEqual(sum.complete, 0);   // 서술형 미완
  s.essayDone = true;
  sum = E.workSummary({ 'w-wk1': s });
  assert.strictEqual(sum.complete, 1);
});

/* ── D-21 밴드·플랜(§5.4) ── */
t('밴드는 남은 날에 따라 갈린다', () => {
  assert.strictEqual(E.band(null), 'practice');
  assert.strictEqual(E.band(18), 'intake');
  assert.strictEqual(E.band(10), 'apply');
  assert.strictEqual(E.band(5), 'restore');
  assert.strictEqual(E.band(2), 'mock');
  assert.strictEqual(E.band(1), 'taper');
});
t('연습 모드 플랜은 마감이 없다', () => {
  const p = E.planDay(mkPack(20, 20, 1), {}, null, d1, {});
  assert.strictEqual(p.mode, 'practice');
  assert.strictEqual(p.dday, null);
  assert.ok(p.vocab.fresh.length > 0);
});
t('시험 모드는 잔량을 남은 날로 나눠 낸다', () => {
  const pack = mkPack(40, 0, 1);
  const p = E.planDay(pack, {}, { examDate: '2026-09-22' }, d1, {});  // D-20
  assert.strictEqual(p.dday, 20);
  assert.ok(p.vocab.fresh.length <= 3, '잔량 40 ÷ 19일 ≈ 3, 실제 ' + p.vocab.fresh.length);
  assert.strictEqual(p.vocab.freshTotal, 40);
});
t('테이퍼링(D-1)은 새 학습을 내지 않는다', () => {
  const p = E.planDay(mkPack(20, 20, 1), {}, { examDate: '2026-09-03' }, d1, {});
  assert.strictEqual(p.band, 'taper');
  assert.strictEqual(p.vocab.fresh.length, 0);
  assert.strictEqual(p.blanks.fresh.length, 0);
});
t('서술형은 D-14부터 매일 배정된다', () => {
  const pack = mkPack(5, 5, 1);
  assert.strictEqual(E.planDay(pack, {}, { examDate: '2026-09-20' }, d1, {}).essay, 0); // D-18
  assert.ok(E.planDay(pack, {}, { examDate: '2026-09-15' }, d1, {}).essay >= 1);        // D-13
});
t('서술형 배점이 높은 시험은 D-21부터 배정한다', () => {
  const pack = mkPack(5, 5, 1);
  const exam = { examDate: '2026-09-20', profile: { essayWeight: 0.4 } };   // D-18
  assert.ok(E.planDay(pack, {}, exam, d1, {}).essay >= 1);
});
t('게이트가 잠긴 작품은 5단계를 내지 않는다', () => {
  const pack = mkPack(2, 2, 1);
  const states = {};
  const w = E.createState('wk1', 'work', d1);
  w.stage = 5;
  states[E.workKey('wk1')] = w;
  const p = E.planDay(pack, states, { examDate: '2026-09-20' }, d1, {});
  assert.strictEqual(p.works[0].stage, 3, '잠기면 적용 단계로 되돌린다');
  assert.strictEqual(p.works[0].gateOpen, false);
});
t('완료된 작품은 오늘 몫에서 빠진다', () => {
  const pack = mkPack(2, 2, 2);
  const states = {};
  const w = E.createState('wk1', 'work', d1);
  w.stage = 5; w.reached = true; w.essayDone = true; w.applyRight = 10; w.applyTotal = 10;
  states[E.workKey('wk1')] = w;
  const p = E.planDay(pack, states, { examDate: '2026-09-20' }, d1, {});
  assert.deepStrictEqual(p.works.map((x) => x.workId), ['wk2']);
});
t('오늘 이미 안정화한 항목은 다시 내지 않는다', () => {
  const pack = mkPack(1, 0, 1);
  const states = {};
  const s = E.createState('v1-1', 'vocab', d1);
  s.reached = true; s.lastCriterionDate = E.localDate(d1); s.relearnCount = 1;
  states[E.vocabKey('v1-1')] = s;
  const p = E.planDay(pack, states, { examDate: '2026-09-20' }, d1, {});
  assert.strictEqual(p.vocab.relearn.length, 0);
});

/* ── 오답 클리어 ── */
t('오답 클리어는 서로 다른 날 2회', () => {
  const s = E.createState('a', 'blank', d1);
  assert.strictEqual(E.clearWrong(s, d1).cleared, false);
  assert.strictEqual(E.clearWrong(s, d1b).cleared, false, '같은 날은 안 쌓인다');
  assert.strictEqual(E.clearWrong(s, d2).cleared, true);
});

/* ── 요약 ── */
t('kindSummary는 kind로 나눠 센다', () => {
  const states = {
    'v-1': E.createState('1', 'vocab', d1),
    'b-1': E.createState('1', 'blank', d1),
    'b-2': E.createState('2', 'blank', d1)
  };
  states['b-1'].reached = true;
  assert.strictEqual(E.kindSummary(states, 'vocab').total, 1);
  assert.strictEqual(E.kindSummary(states, 'blank').total, 2);
  assert.strictEqual(E.kindSummary(states, 'blank').reached, 1);
});

console.log('\n' + passed + '개 검증 통과');
