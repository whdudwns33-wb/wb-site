'use strict';
/* 진로독서 어휘장 → 한자브레인 단어장 다리 검증 (node hanja/bridge.test.cjs) */
const assert = require('assert');
const BR = require('./bridge.js');
const CHECK = require('./book-check.js');

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };

const vocab = [
  { word: '관측', easy: '자연 현상을 살펴 재는 것', hanja: '觀(볼 관)+測(잴 측)', articleId: 'a1', addedAt: '2026-09-03', box: 1 },
  { word: 'orbit', easy: '궤도', hanja: null, lang: 'en', articleId: 'a1', addedAt: '2026-09-03' },
  { word: '다잡다', easy: '흐트러진 마음을 단단히 하다', hanja: null, articleId: 'a2', addedAt: '2026-08-20' },
  { word: '관측', easy: '중복', hanja: '觀(볼 관)+測(잴 측)', addedAt: '2026-09-04' },
  { word: '뜻없음', easy: '', hanja: null, addedAt: '2026-09-04' },
  { word: '', easy: 'x' }, null, { word: 'Sky', easy: '하늘' },
];

t('한자어·고유어만 가져오고 영어·중복·뜻 없는 낱말은 뺀다', () => {
  const raw = BR.toBook(vocab);
  assert.deepStrictEqual(raw.words.map((w) => w.word), ['관측', '다잡다']);
  assert.strictEqual(raw.words[0].hanja, '觀(볼 관)+測(잴 측)');
  assert.strictEqual(raw.id, 'reading-vocab');
  assert.strictEqual(raw.source, 'own', '진로독서 어휘장은 자체 기록 — AI 연상이 열린다');
});

t('검사기를 그대로 통과하고 단원은 모은 달, 최근 달이 앞', () => {
  const r = CHECK.checkBook(BR.toBook(vocab));
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepStrictEqual(r.book.units.map((u) => u.id), ['2026-09', '2026-08']);
  assert.strictEqual(r.book.units[0].title, '2026년 09월에 모음');
  assert.strictEqual(r.book.words[0].type, 'hanja');
  assert.deepStrictEqual(r.book.words[0].parts.map((p) => p.hun + p.eum), ['볼관', '잴측']);
  assert.strictEqual(r.book.words[0].id, '관측|觀測', '가져올 때마다 같은 id 라야 기억 기록이 이어진다');
  assert.ok(r.book.chars.some((c) => c.ch === '觀' && c.derived));
  assert.ok(/자체 기록/.test(r.book.note));
  assert.ok(CHECK.aiAllowed(r.book));
});

t('wbr.v1 문자열에서 어휘장만 — 깨진 값은 빈 배열', () => {
  assert.strictEqual(BR.readVocab(JSON.stringify({ v: 1, vocab: vocab })).length, vocab.length);
  assert.deepStrictEqual(BR.readVocab('{not json'), []);
  assert.deepStrictEqual(BR.readVocab(null), []);
  assert.deepStrictEqual(BR.readVocab(JSON.stringify({ vocab: 'x' })), []);
  assert.deepStrictEqual(BR.toBook(BR.readVocab(null)).words, []);
});

console.log(`\nOK — ${passed}개 통과`);
