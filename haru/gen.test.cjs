'use strict';
const assert = require('node:assert/strict');
const G = require('./gen.js');
let n = 0; function t(name, fn) { fn(); n++; console.log('ok', name); }
const seeded = (s) => () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
/* 자체 창작 소형 풀 — 시험용 */
const POOL = [
  { id: 'e-w-keep', atomId: 'e-vocab-300', headword: 'keep', pos: 'v', meaningKo: '간직하다, 보관하다', synonyms: ['maintain'], irregularForms: ['kept'], example: { en: 'She kept the letter in a box.', ko: '그녀는 편지를 상자에 간직했다.' }, definition: { en: 'to have or hold something and not give it away' } },
  { id: 'e-w-maintain', atomId: 'e-vocab-300', headword: 'maintain', pos: 'v', meaningKo: '유지하다', example: { en: 'He maintains a garden.', ko: '그는 정원을 가꾼다.' } },
  { id: 'e-w-observe', atomId: 'e-vocab-300', headword: 'observe', pos: 'v', meaningKo: '관찰하다', example: { en: 'Scientists observe the stars.', ko: '과학자들은 별을 관찰한다.' }, definition: { en: 'to watch something carefully' } },
  { id: 'e-w-predict', atomId: 'e-vocab-300', headword: 'predict', pos: 'v', meaningKo: '예측하다', example: { en: 'Nobody can predict the weather.', ko: '아무도 날씨를 예측할 수 없다.' } },
  { id: 'e-w-brave', atomId: 'e-vocab-300', headword: 'brave', pos: 'adj', meaningKo: '용감한', example: { en: 'The brave girl saved the dog.', ko: '용감한 소녀가 개를 구했다.' } },
  { id: 'e-w-quiet', atomId: 'e-vocab-300', headword: 'quiet', pos: 'adj', meaningKo: '조용한', example: { en: 'The library is quiet.', ko: '도서관은 조용하다.' } },
  { id: 'e-w-carry', atomId: 'e-vocab-300', headword: 'carry', pos: 'v', meaningKo: '나르다', example: { en: 'He carried the box upstairs.', ko: '그는 상자를 위층으로 날랐다.' } },
];
const keep = POOL[0];

t('뜻 4지선다 — 정답 단어의 다른 뜻·유의어의 뜻은 오답으로 안 나온다', () => {
  for (let s = 1; s < 30; s++) {
    const q = G.vocabMcq(keep, POOL, seeded(s));
    assert.ok(q, 'null');
    const texts = q.choices.map(c => c.text);
    assert.ok(!texts.includes('유지하다'), 'maintain(유의어)의 뜻이 오답에: ' + texts.join('|'));
    assert.ok(!texts.includes('보관하다'));
    assert.equal(q.choices.find(c => c.key === q.answerKey).text, '간직하다, 보관하다');
    assert.equal(new Set(texts).size, 4);
  }
});
t('오답 우선순위 — 같은 원자·같은 품사가 먼저', () => {
  const q = G.vocabMcq(POOL[4], POOL, seeded(2));   // brave(adj)
  assert.ok(q.choices.map(c => c.text).includes('조용한'));
});
t('역방향·영영풀이·철자·예문 빈칸', () => {
  const r = G.vocabMcqReverse(keep, POOL, seeded(3));
  assert.equal(r.prompt, '간직하다, 보관하다'); assert.ok(!r.choices.map(c => c.text).includes('maintain'));
  const d = G.definitionPick(keep, POOL, seeded(4));
  assert.equal(d.choices.find(c => c.key === d.answerKey).text, 'keep');
  const s = G.spelling(keep, null, { hint: false }); assert.equal(s.hinted, false); assert.deepEqual(s.answers, ['keep']);
  const sh = G.spelling(keep); assert.equal(sh.hint, 'k _ _ _');
  const c = G.exampleCloze(keep); assert.deepEqual(c.textParts, ['She ', ' the letter in a box.']); assert.deepEqual(c.answers, ['kept', 'keep']);
  const c2 = G.exampleCloze(POOL[6]); assert.deepEqual(c2.answers, ['carried', 'carry']);   // y→ied
});
t('풀이 작으면 null — 없는 자리에 문항을 만들지 않는다', () => {
  assert.equal(G.vocabMcq(keep, POOL.slice(0, 2), seeded(1)), null);
  assert.equal(G.exampleCloze({ id: 'x', headword: 'zzz', example: { en: 'nothing here' } }), null);
});
t('로테이션 — 같은 단어가 날짜·상태에 따라 다른 유형', () => {
  const kinds = new Set();
  for (let day = 0; day < 5; day++) kinds.add(G.rotate(keep, POOL, { wrong: 0, streak: 0 }, day, seeded(day)).type);
  assert.ok(kinds.size >= 3, [...kinds].join(','));
});
t('발문 표시 — 조건 토큰을 전부 찾아 탭 대상으로', () => {
  const m = G.markConditions({ instructionKo: '가로 9 cm, 세로 6 cm 인 직육면체의 겉넓이로 옳지 않은 것은? 모두 고르면 몇 개인가?' });
  assert.ok(m.required >= 5, String(m.required));
  assert.ok(m.kinds.includes('negative') && m.kinds.includes('all') && m.kinds.includes('unit') && m.kinds.includes('quantity'));
  assert.equal(m.parts.map(p => p.text).join(''), '가로 9 cm, 세로 6 cm 인 직육면체의 겉넓이로 옳지 않은 것은? 모두 고르면 몇 개인가?');
  const none = G.markConditions({ instructionKo: '이 글의 주제로 알맞은 것은?' });
  assert.equal(none.required, 0);
});
console.log(n + ' tests passed');
