'use strict';
/* WB 국어브레인 — 문항 생성기 검증 (node naesin-ko/gen.test.cjs)
   정본: 기획서 §4.3 구절 적용 생성기 · §4.1 5지선다 형식 정렬 */
const assert = require('assert');
const GEN = require('./gen.js');
const pack = require('./pack-sample.json');
const dict = require('./concepts.json');

const concepts = dict.concepts;
const work = pack.works[0];        // 빈 의자 (정본 보유)
const novel = pack.works[1];       // 골목의 끝 (정본 없음)

let passed = 0;
function t(name, fn) { fn(); passed += 1; console.log('  ✓ ' + name); }

/* 시드 고정 난수 — 모든 무작위성이 주입이라 테스트가 결정적이다 */
function seeded(seed) {
  let x = seed >>> 0;
  return function () { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };
}

console.log('WBKOGEN');

t('같은 시드는 같은 문항을 낸다 — 무작위성은 전부 주입', () => {
  const a = GEN.applySet(work, concepts, 5, seeded(7));
  const b = GEN.applySet(work, concepts, 5, seeded(7));
  assert.deepStrictEqual(a.map((x) => x.id), b.map((x) => x.id));
  assert.deepStrictEqual(
    a.map((x) => (x.choices || []).map((c) => c.text).join('|')),
    b.map((x) => (x.choices || []).map((c) => c.text).join('|')));
});

t('오답 보기는 혼동 쌍을 먼저 쓴다(§4.3)', () => {
  const conf = concepts.filter((c) => c.id === 'c-banueo')[0].confusableWith;   // 역설·풍자
  const ds = GEN.distractorsKo('c-banueo', concepts, conf.length, seeded(3));
  assert.strictEqual(ds.length, conf.length);
  ds.forEach((id) => assert.ok(conf.indexOf(id) >= 0, id + '는 혼동 쌍이 아니다'));
});
t('혼동 쌍이 모자라면 같은 범주 → 사전 순으로 내려간다', () => {
  const conf = concepts.filter((c) => c.id === 'c-banueo')[0].confusableWith;
  const ds = GEN.distractorsKo('c-banueo', concepts, 4, seeded(3));
  assert.strictEqual(ds.length, 4);
  conf.forEach((id) => assert.ok(ds.indexOf(id) >= 0, '혼동 쌍이 먼저 들어가야 한다: ' + id));
  const extra = ds.filter((id) => conf.indexOf(id) < 0);
  extra.forEach((id) => {
    const c = concepts.filter((x) => x.id === id)[0];
    assert.strictEqual(c.category, '강조', '다음 계층은 같은 범주다');
  });
});
t('정답 개념은 오답에 들어가지 않는다', () => {
  const ds = GEN.distractorsKo('c-eunyu', concepts, 6, seeded(5));
  assert.strictEqual(ds.length, 6);
  assert.ok(ds.indexOf('c-eunyu') < 0);
  assert.strictEqual(new Set(ds).size, ds.length, '오답끼리도 중복이 없다');
});

t('표현법 판별 문항은 5지선다이고 정답이 하나다', () => {
  const it = GEN.rhetoricItem(work, work.rhetoric[0], concepts, seeded(1));
  assert.strictEqual(it.choices.length, GEN.CHOICE_N);
  assert.strictEqual(it.choices.filter((c) => c.correct).length, 1);
  assert.strictEqual(it.choices.filter((c) => c.correct)[0].text, '의인법');
  assert.strictEqual(it.quote, '하루 종일 해를 안고 있다');
});
t('선지 텍스트는 서로 다르다', () => {
  const it = GEN.rhetoricItem(work, work.rhetoric[0], concepts, seeded(11));
  const texts = it.choices.map((c) => c.text);
  assert.strictEqual(new Set(texts).size, texts.length);
});
t('정답 위치는 시드에 따라 달라진다', () => {
  const pos = [];
  for (let s = 1; s <= 12; s++) {
    const it = GEN.rhetoricItem(work, work.rhetoric[0], concepts, seeded(s));
    pos.push(it.choices.findIndex((c) => c.correct));
  }
  assert.ok(new Set(pos).size > 1, '정답이 늘 같은 자리면 위치 암기가 된다');
});

t('시어 의미 문항은 극성이 반대인 시어를 오답으로 먼저 쓴다', () => {
  const kw = work.keywords.filter((k) => k.id === 'k-byeot')[0];   // 긍정
  const it = GEN.keywordItem(work, kw, seeded(2));
  assert.ok(it, '시어가 5개라 문항이 만들어진다');
  const wrong = it.choices.filter((c) => !c.correct).map((c) => c.text);
  const neg = work.keywords.filter((k) => k.polarity === '부정')[0];
  assert.ok(wrong.indexOf(neg.meaning) >= 0, '반대 극성 시어 의미가 오답에 있어야 한다');
});
t('시어가 부족하면 문항을 만들지 않는다 — 억지 오답을 만들지 않는다', () => {
  const thin = { workId: 'x', keywords: [{ id: 'a', word: 'ㄱ', meaning: 'ㄱ뜻' }] };
  assert.strictEqual(GEN.keywordItem(thin, thin.keywords[0], seeded(1)), null);
});

t('부정발문은 진술 5개 중 하나만 거짓이다', () => {
  const it = GEN.negativeRhetoricItem(work, concepts, seeded(4));
  assert.ok(it, '표현법 쌍이 5개 이상이라 만들어진다');
  assert.strictEqual(it.negative, true);
  assert.strictEqual(it.choices.length, 5);
  assert.strictEqual(it.choices.filter((c) => c.correct).length, 1, '거짓 진술이 정확히 하나');
  assert.ok(it.stem.indexOf('않은') >= 0);
});
t('부정발문의 거짓 진술은 실제 표현법과 다른 이름을 단다', () => {
  const it = GEN.negativeRhetoricItem(work, concepts, seeded(9));
  const wrongText = it.choices.filter((c) => c.correct)[0].text;
  const quote = it.evidence;
  const real = work.rhetoric.filter((r) => r.quote === quote)[0];
  assert.ok(wrongText.indexOf(quote) >= 0);
  assert.ok(wrongText.indexOf(real.name) < 0, '거짓 진술에 진짜 표현법 이름이 들어가면 안 된다');
});

t('<보기> 문항은 개념 정의를 보기로 주고 구절을 고르게 한다', () => {
  const it = GEN.bogiItem(work, work.rhetoric[0], concepts, seeded(6));
  assert.ok(it.bogi && it.bogi.text.indexOf('의인법') >= 0);
  assert.strictEqual(it.choices.filter((c) => c.correct)[0].text, work.rhetoric[0].quote);
});

t('OX는 뒤집으면 정답이 거짓이 된다', () => {
  const kw = work.keywords[0];
  assert.strictEqual(GEN.oxItem(work, kw, seeded(1), false).answer, true);
  assert.strictEqual(GEN.oxItem(work, kw, seeded(1), true).answer, false);
});

t('연결하기는 용어와 설명 수가 같고 키로 짝이 맞는다', () => {
  const it = GEN.matchingItem(work, seeded(8));
  assert.strictEqual(it.terms.length, it.defs.length);
  const tk = it.terms.map((x) => x.key).sort();
  const dk = it.defs.map((x) => x.key).sort();
  assert.deepStrictEqual(tk, dk);
});

t('개념 빈칸 문항은 정답과 글자 수 힌트를 갖는다', () => {
  const it = GEN.blankItem(work, work.blanks[0]);
  assert.deepStrictEqual(it.answers, ['자유시']);
  assert.strictEqual(it.hintLen, 3);
  assert.strictEqual(it.kind, 'blank');
});

t('어휘 문항은 뜻 고르기 5지선다', () => {
  const it = GEN.vocabItem(work, work.vocab[0], work.vocab, concepts, seeded(1));
  assert.strictEqual(it.choices.length, GEN.CHOICE_N);
  assert.strictEqual(it.choices.filter((c) => c.correct)[0].text, work.vocab[0].definition);
});

t('주석 복원 대상은 기호가 달린 항목과 연 요지에서 나온다', () => {
  const ts = GEN.restoreTargets(work);
  const ids = ts.map((x) => x.id);
  assert.ok(ids.indexOf('rt-rh-r-1') >= 0, '㉠ 표현법');
  assert.ok(ids.indexOf('rt-kw-k-binjari') >= 0, '㉢ 시어');
  assert.strictEqual(ts.filter((x) => x.kind === 'composition').length, 5, '5개 연 요지');
  ts.forEach((x) => assert.ok(x.keywords.length > 0, x.id + ' 키워드가 있어야 채점된다'));
});

t('적용 세트는 요청한 수만큼 낸다', () => {
  const set = GEN.applySet(work, concepts, 6, seeded(12));
  assert.strictEqual(set.length, 6);
  set.forEach((it) => assert.strictEqual(it.workId, work.workId));
});
t('부정발문 비율 0이면 부정발문이 안 나온다', () => {
  const set = GEN.applySet(work, concepts, 5, seeded(13), { negRatio: 0 });
  assert.strictEqual(set.filter((x) => x.negative).length, 0);
});
t('정본이 없는 작품은 적용 문항이 만들어지지 않는다(§2.2-6)', () => {
  assert.strictEqual(GEN.applySet(novel, concepts, 5, seeded(1)).length, 0);
});

t('dailySetKo는 플랜을 문항으로 바꾼다', () => {
  const plan = {
    vocab: { fresh: ['v-maru'], review: [], relearn: [] },
    blanks: { fresh: ['bl-01', 'bl-02'], review: [], relearn: [] },
    works: [{ workId: work.workId, stage: 3 }]
  };
  const set = GEN.dailySetKo(plan, pack, concepts, seeded(21), { applyPerWork: 3 });
  assert.strictEqual(set.vocab.length, 1);
  assert.strictEqual(set.blanks.length, 2);
  assert.strictEqual(set.apply.length, 3);
  assert.strictEqual(set.vocab[0].queue, 'fresh');
});
t('3단계 미만 작품은 적용 문항을 내지 않는다', () => {
  const plan = { vocab: { fresh: [], review: [], relearn: [] }, blanks: { fresh: [], review: [], relearn: [] },
    works: [{ workId: work.workId, stage: 2 }] };
  assert.strictEqual(GEN.dailySetKo(plan, pack, concepts, seeded(1)).apply.length, 0);
});

console.log('\n' + passed + '개 검증 통과');
