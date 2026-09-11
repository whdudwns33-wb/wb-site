'use strict';
const assert = require('node:assert/strict');
const GK = require('./grade-ko.js');
let n = 0; function t(name, fn) { fn(); n++; console.log('ok', name); }

t('회귀 방지 — similarity/normalizeEn 이 없다 (한글 두 문장이 항상 일치로 판정되지 않는다)', () => {
  assert.equal(GK.similarity, undefined); assert.equal(GK.normalizeEn, undefined);
  const r = GK.gradeTranslationChunks('고래는 바다에 산다', [{ ko: '나는 학교에 간다' }]);
  assert.equal(r.perChunk[0].present, false);
  assert.equal(r.coverage, 0);
});
t('조사 제거·기능어 배제·어간 근사', () => {
  assert.equal(GK.stripJosa('취수장에서'), '취수장');
  assert.equal(GK.stripJosa('물을'), '물');
  assert.ok(GK.isFunctionToken('때문에', GK.stripJosa('때문에')));
  assert.ok(GK.isFunctionToken('글쓴이는', GK.stripJosa('글쓴이는')));
  assert.deepEqual(GK.coreCands('끌어올린다'), ['끌어올린다', '끌어올린', '끌어']);
});
t('지문 요약 핵심어 누락 표시 — 빠뜨린 것만 돌려준다, 점수 없음', () => {
  const keys = ['취수장이 끌어올린다', '정수장이 거른다', '배수지에 모였다가'];
  const g1 = GK.summaryGaps('취수장이 강물을 끌어올리고 정수장에서 거른 물이 집으로 간다', keys);
  assert.deepEqual(g1.missing, ['배수지에 모였다가']);
  const g2 = GK.summaryGaps('물은 배수지에 모였다가 집으로 내려간다', keys);
  assert.deepEqual(g2.missing, ['취수장이 끌어올린다', '정수장이 거른다']);
  assert.ok(!('score' in g1));
});
t('같은 자리를 두 토큰이 나눠 쓰지 못한다', () => {
  const r = GK.gradeTranslationChunks('정수장', [{ ko: '정수장이 거른다' }, { ko: '정수장이 모은다' }]);
  assert.equal(r.perChunk[0].present, true);     // 정수장 1 + 거른다 0 → 절반
  assert.equal(r.perChunk[1].present, false);    // '정수장' 자리는 이미 쓰였다
});
console.log(n + ' tests passed');
