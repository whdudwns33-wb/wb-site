'use strict';
/* WB 국어브레인 — 공용 개념어 사전 검증 (node naesin-ko/concepts.test.cjs)
   이 사전은 자체 창작이라 저장소에 커밋되고 정적 자산으로 나간다(§9.3).
   그래서 '자체 창작'이 무너지지 않도록 여기서 고정한다 —
   추출 파이프라인 출력이 섞여 들어오면 라이선스 콘텐츠가 공개 노출된다. */
const assert = require('assert');
const dict = require('./concepts.json');

let passed = 0;
function t(name, fn) { fn(); passed += 1; console.log('  ✓ ' + name); }
const list = dict.concepts;

console.log('WBKOCONCEPTS');

t('id가 유일하다', () => {
  const ids = list.map((c) => c.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});
t('term이 유일하다 — 같은 용어가 두 id로 갈리면 오답 보기가 중복된다', () => {
  const terms = list.map((c) => c.term);
  assert.strictEqual(new Set(terms).size, terms.length);
});
t('confusableWith는 실재하는 id만 가리킨다', () => {
  const ids = new Set(list.map((c) => c.id));
  list.forEach((c) => (c.confusableWith || []).forEach((r) => {
    assert.ok(ids.has(r), c.id + ' → ' + r + ' 가 사전에 없다');
    assert.notStrictEqual(r, c.id, c.id + ' 가 자기 자신을 혼동 쌍으로 가리킨다');
  }));
});
t('모든 개념에 정의와 예시가 있다 — 정의만으로는 적용을 못 배운다', () => {
  list.forEach((c) => {
    assert.ok(c.definition && c.definition.length >= 8, c.id + ' 정의가 너무 짧다');
    assert.ok((c.examples || []).length >= 1, c.id + ' 예시가 없다');
  });
});
t('범주가 비어 있지 않다', () => {
  list.forEach((c) => assert.ok(c.category && c.category.length > 0, c.id + ' category 없음'));
});
t('혼동 쌍은 서로를 가리킨다(대칭) — A가 답일 때 B가 오답이면 그 반대도 성립해야 한다', () => {
  const byId = {};
  list.forEach((c) => { byId[c.id] = c; });
  list.forEach((c) => (c.confusableWith || []).forEach((r) => {
    assert.ok((byId[r].confusableWith || []).indexOf(c.id) >= 0,
      c.id + ' → ' + r + ' 는 있는데 반대 방향이 없다 (오답 품질이 방향에 따라 갈린다)');
  }));
});
t('혼동 쌍은 범주를 넘을 수 있다 — 대조↔역설처럼 실제로 헷갈리는 짝', () => {
  const byId = {};
  list.forEach((c) => { byId[c.id] = c; });
  const cross = list.some((c) => (c.confusableWith || []).some((r) => byId[r].category !== c.category));
  assert.ok(cross, '범주를 넘는 혼동 쌍이 하나도 없다면 범주 기준으로만 묶은 것이다');
});

/* ── 라이선스 방어선 ──
   실제 교과서 수록작·구매 자료의 문장이 사전에 섞이지 않게 한다.
   작품명·작가명은 예시에 쓰지 않는다(창작 예문만). */
t('예시에 실제 작품명·작가명이 없다', () => {
  const BAN = ['저녁 항구', '비린내라뇨', '축구공과 응원 봉', '함기석', '함민복', '조규미',
    '백석', '김종길', '나희덕', '홍랑', '족보닷컴', '교육지대', '이해완성', '단원집중'];
  const blob = JSON.stringify(dict);
  BAN.forEach((w) => assert.ok(blob.indexOf(w) < 0, '사전에 금지어가 들어 있다: ' + w));
});
t('예시가 지나치게 길지 않다 — 원문 인용이 아니라 창작 예문이어야 한다', () => {
  list.forEach((c) => (c.examples || []).forEach((e) => {
    assert.ok(e.length <= 40, c.id + ' 예시가 40자를 넘는다 (인용 의심): ' + e);
  }));
});
t('사전 규모가 Phase 0 목표(30~40개 이상)를 채운다', () => {
  assert.ok(list.length >= 30, '개념 ' + list.length + '개');
});

console.log('\n' + passed + '개 검증 통과');
