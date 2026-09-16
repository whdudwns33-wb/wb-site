'use strict';
const assert = require('node:assert/strict');
const C = require('./cause.js');
let n = 0; function t(name, fn) { fn(); n++; console.log('ok', name); }
const item = { no: 3, atomId: 'm-ratio-base', choices: [
  { key: '1', text: 'a', atomId: 'm-pct-inverse', errKind: null },
  { key: '2', text: 'b', atomId: null, errKind: 'calc' },
  { key: '3', text: 'c' },
  { key: '4', text: 'd', atomId: null, errKind: null } ] };

t('시간이 먼저 — 오답이 다른 원자를 가리켜도 180초 넘으면 time', () => {
  assert.equal(C.classify(item, '1', 200000, { reached: true }, null), 'time');
  assert.equal(C.classify(item, 'skip', 5000, { reached: true }, null), 'time');
});
t('exec 는 도달한 원자에서 계산 실수형 오답을 골랐을 때만', () => {
  assert.equal(C.classify(item, '2', 40000, { reached: true }, null), 'exec');
  assert.equal(C.classify(item, '2', 40000, { reached: false }, null), 'gap');   // 도달 전이면 실수가 아니라 몰라서
});
t('misread 는 30초 반증을 통과했을 때만', () => {
  assert.equal(C.classify(item, '4', 40000, { reached: false }, { said: 'canDo', ok: true }), 'misread');
  assert.equal(C.classify(item, '4', 40000, { reached: false }, { said: 'canDo', ok: false }), 'gap');   // 신고를 남기되 신뢰하지 않는다
});
t('confuse 는 time·exec·misread 를 배제한 뒤에만', () => {
  assert.equal(C.classify(item, '1', 40000, { reached: false }, null), 'confuse');
  assert.equal(C.classify(item, '1', 40000, { reached: false }, { said: 'canDo', ok: true }), 'misread');
});
t('confuse 과대 판정 부재 — 매핑 없는 오답은 gap', () => {
  assert.equal(C.classify(item, '4', 40000, { reached: false }, null), 'gap');
});
t('5범주가 서로 다른 route 를 낸다', () => {
  const routes = C.CAUSES.map(c => C.route(c, { stage: 2 }, { confuse: ['m-pct-inverse'] }));
  const sig = routes.map(r => r.mode + ':' + r.stage + ':' + r.cue + ':' + (r.stepBack || 0) + ':' + (r.with ? r.with.length : 0));
  assert.equal(new Set(sig).size, 5, sig.join(' | '));
  assert.deepEqual(C.route('confuse', {}, { confuse: ['m-pct-inverse'] }).with, ['m-pct-inverse']);
  assert.equal(C.route('exec', {}, {}).stepBack, 2);
});
t('원인 분포는 n<10 이면 그리지 않는다', () => {
  const w = Array.from({ length: 7 }, () => ({ cause: 'gap' }));
  assert.equal(C.distribution(w).show, false);
  assert.equal(C.distribution(w.concat(w)).show, true);
  assert.equal(C.distribution(w.concat(w)).byCause.gap, 14);
});
console.log(n + ' tests passed');
