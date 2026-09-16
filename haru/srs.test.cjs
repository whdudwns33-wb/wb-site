'use strict';
const assert = require('node:assert/strict');
const R = require('./srs.js');
const DAY = R.DAY;
let n = 0; function t(name, fn) { fn(); n++; console.log('ok', name); }
const NOW = Date.UTC(2026, 8, 20, 11);   // 20:00 KST

t('간격 사다리 — 3년 지평, 국면 ①·② 는 cap 없음 (120일 생존)', () => {
  assert.equal(R.nextDue(7, NOW, { dday: null, active: 16, slots: 6 }) - NOW, 120 * DAY);
  assert.equal(R.nextDue(0, NOW, { dday: null, active: 16, slots: 6 }) - NOW, Math.max(0.5, 16 / 6) * DAY);   // floor 가 0.5 를 밀어 올린다
});
t('파이널 cap = dday × 0.35, 단 floor 아래로는 안 내려간다', () => {
  assert.equal(R.nextDue(5, NOW, { dday: 20, active: 16, slots: 6 }) - NOW, 7 * DAY);          // 30 → cap 7
  const d3 = R.nextDue(5, NOW, { dday: 3, active: 16, slots: 6 }) - NOW;
  assert.ok(Math.abs(d3 - (16 / 6) * DAY) < 1, 'cap 1.05 < floor 2.67 → floor');
});
t('큐 폭발 부재 — 활성 16장·슬롯 6, D-30~D-1 시뮬레이션에서 하루 due 가 슬롯을 넘지 않는다', () => {
  const cards = Array.from({ length: 16 }, (_, i) => { const c = R.createCard(NOW); c.step = i % 5; c.due = NOW + (i % 4) * DAY; return c; });
  const exam = NOW + 30 * DAY;
  const dueCounts = {}; cards.forEach(c => { const k = R.localDate(c.due); dueCounts[k] = (dueCounts[k] || 0) + 1; });
  let maxDue = 0;
  for (let day = 0; day < 30; day++) {
    const now = NOW + day * DAY, dday = Math.round((exam - now) / DAY);
    const due = cards.filter(c => R.isDue(c, now));
    maxDue = Math.max(maxDue, due.length);
    due.forEach(c => R.recordOk(c, { now, mixed: true, form: 'write', dday, active: 16, slots: 6, dueCounts }));
  }
  assert.ok(maxDue <= 6, 'max due/day = ' + maxDue);
});
t('졸업 = 서로 다른 3일 × 2맥락 — 4단계 혼합 정답으로 도달 가능', () => {
  const c = R.createCard(NOW, true);              // 진단 도달 → 3단계
  let now = NOW;
  for (let i = 0; i < 3; i++) R.recordOk(c, { now: now += 3600000, mixed: false, form: 'write', dday: null, active: 16, slots: 6 });   // 블록 3연속 → 4단계
  assert.equal(c.stage, 4);
  assert.equal(R.graduated(c), false);
  for (let d = 0; d < 3; d++) R.recordOk(c, { now: now += DAY, mixed: true, form: 'write', dday: null, active: 16, slots: 6 });
  assert.equal(c.relearnCount, 3);
  assert.deepEqual(c.ctx.sort(), ['block', 'mixed']);
  assert.equal(R.graduated(c), true);
});
t('같은 날 두 번 도달은 한 번 (8시간 간격)', () => {
  const c = R.createCard(NOW, true); c.stage = 4;
  R.recordOk(c, { now: NOW, mixed: true, form: 'write' });
  R.recordOk(c, { now: NOW + 3600000, mixed: true, form: 'write' });
  assert.equal(c.relearnCount, 1);
});
t('오답은 2계단 후퇴 + 단서 한 칸 + 반나절 뒤', () => {
  const c = R.createCard(NOW); c.step = 4; c.cue = 1; c.streak = 2;
  R.fail(c, { now: NOW });
  assert.equal(c.step, 2); assert.equal(c.cue, 2); assert.equal(c.streak, 0); assert.equal(c.due, NOW + 0.5 * DAY);
  assert.equal(c.lapses, 1);
});
t('4지선다 정답은 needsRecheck — recheck 통과 전엔 isDone 이 아니다', () => {
  const c = R.createCard(NOW, true); c.stage = 4; c.relearnCount = 3; c.ctx = ['block', 'mixed'];
  R.recordOk(c, { now: NOW, mixed: true, form: 'mcq4' });
  assert.equal(R.isDone(c), false);
  R.recheck(c, true);
  assert.equal(R.isDone(c), true);
  R.recordOk(c, { now: NOW + DAY, mixed: true, form: 'mcq4' });
  const step = c.step;
  R.recheck(c, false, { now: NOW + DAY });
  assert.equal(c.overconfident, 1); assert.equal(c.step, step - 1);
});
t('단서 단계는 1·3 — 2·4 에서는 오답이어도 cue 가 안 는다', () => {
  const c = R.createCard(NOW); c.stage = 2; c.cue = 0;
  R.fail(c, { now: NOW }); assert.equal(c.cue, 0);
  c.stage = 3; R.fail(c, { now: NOW }); assert.equal(c.cue, 1);
});
t('진단 도달 원자는 3단계·단서 0 에서 시작', () => {
  const c = R.applyDiagnostic(R.createCard(NOW), true);
  assert.equal(c.stage, 3); assert.equal(c.cue, 0);
});
console.log(n + ' tests passed');
