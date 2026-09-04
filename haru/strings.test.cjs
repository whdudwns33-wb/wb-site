'use strict';
const assert = require('node:assert/strict');
const S = require('./strings.js');
let n = 0; function t(name, fn) { fn(); n++; console.log('ok', name); }

t('내부값 → 학생/강사 문자열', () => {
  assert.equal(S.stateLabel('hole', 'student'), '다시 만날 칸');
  assert.equal(S.stateLabel('hole', 'coach'), '구멍');
  assert.equal(S.stateLabel('unknown', 'student'), '처음 보는 칸');
  assert.equal(S.slotLabel('probe'), '처음 보는 칸');
});
t('학생 문자열 자체에 학생 금지어가 없다', () => {
  Object.keys(S.STATE).forEach(k => assert.deepEqual(S.findForbidden(S.stateLabel(k, 'student'), 'student'), [], k));
  assert.deepEqual(S.findForbidden(S.progressLine(11, 4, 8), 'student'), []);
  assert.deepEqual(S.findForbidden(S.progressLine(0, 0, 8), 'student'), []);
});
t('관측 문구', () => {
  assert.equal(S.progressLine(11, 4, 8), '관측 11번 중 4번 맞았어요 · 섞어 내도 맞으면 붙어요');
  assert.equal(S.progressLine(5, 3, 8), '관측 5번 중 3번 맞았어요 · 3번 더 만나면 붙어요');
  assert.equal(S.progressLine(0, 0, 8), '오늘 처음 만나요');
});
t('강등은 null, 승격만 문장', () => {
  assert.equal(S.transitionLine('shaky', 'hole', '비와 비율'), null);
  assert.equal(S.transitionLine('hole', 'shaky', '비와 비율'), '비와 비율 — 굳히는 중이에요');
  assert.equal(S.transitionLine('shaky', 'fluent', '비와 비율'), '비와 비율 — 붙었어요');
});
t('금지어 탐지', () => {
  assert.deepEqual(S.findForbidden('오늘 오답 3개 · 점수 88', 'student'), ['오답', '점수']);
  assert.deepEqual(S.findForbidden('아직 3일 남았습니다', 'parent'), ['아직', '남았']);
  assert.deepEqual(S.findForbidden('이번 주 5일 앉았습니다.', 'parent'), []);
});
t('부모 coach — 과정 서술, 3주 저실행이면 멈춤', () => {
  assert.deepEqual(S.findForbidden(S.coach(5, 0, '10/11(일) 09:00'), 'parent'), []);
  assert.deepEqual(S.findForbidden(S.coach(2, 1), 'parent'), []);
  assert.equal(S.coach(0, 3), null);
});
console.log(n + ' tests passed');
