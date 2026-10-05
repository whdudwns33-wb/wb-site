'use strict';
/* 공개 획순 데이터 변환기 검증 (node hanja/strokes-convert.test.mjs) */
import assert from 'node:assert';
import { convertLines, wantedFromBook } from './strokes-convert.mjs';
import CHECK from './book-check.js';

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };

/* 글꼴 좌표(1024 상자, y 위로) 십(十): 가로 왼→오, 세로 위→아래 */
const LINES = [
  JSON.stringify({ character: '十', strokes: ['M…'], medians: [[[100, 450], [924, 450]], [[512, 850], [512, -20]]] }),
  JSON.stringify({ character: '一', medians: [[[100, 450], [924, 450]]] }),
  'not json at all',
  JSON.stringify({ character: '山', medians: [[[512, 850], [512, 200]], [[150, 600], [150, 200], [874, 200]], [[874, 650], [874, 200]]] }),
  JSON.stringify({ character: '十', medians: [[[0, 0], [1, 1]]] }),   /* 같은 글자 두 번 — 처음 것만 */
];

t('좌표를 0~1·y 아래로 바꾸고, 원하는 글자만 뽑는다', () => {
  const r = convertLines(LINES, { '十': 2, '山': 3 });
  assert.deepStrictEqual(Object.keys(r.strokes).sort(), ['十', '山']);
  const s = r.strokes['十'];
  assert.strictEqual(s.strokes, 2);
  assert.deepStrictEqual(s.medians[0], [[0.098, 0.439], [0.902, 0.439]]);
  assert.deepStrictEqual(s.medians[1][0], [0.5, 0.049], 'y 가 위에서 아래로 바뀌어야 한다');
  assert.deepStrictEqual(s.medians[1][1], [0.5, 0.898], '상자 밖(-20)은 0~1 로 자른다');
  assert.deepStrictEqual(r.missing, []);
  assert.deepStrictEqual(r.mismatch, []);
});

t('획 수가 단어장과 다르면 검수 목록에, 데이터에 없으면 missing 에', () => {
  const r = convertLines(LINES, { '十': 3, '龜': 16, '一': null });
  assert.deepStrictEqual(r.mismatch, [{ ch: '十', expected: 3, got: 2 }]);
  assert.deepStrictEqual(r.missing, ['龜']);
  assert.strictEqual(r.strokes['一'].strokes, 1, '기대 획수가 없어도 변환은 된다');
});

t('산출물은 획순 사전 검사(checkMedians)를 그대로 통과한다', () => {
  const r = convertLines(LINES, { '山': null });
  const C = { errors: [], err: (w, m) => C.errors.push({ where: w, message: m }) };
  const med = CHECK.checkMedians(r.strokes['山'].medians, '山', C);
  assert.ok(med && med.length === 3, JSON.stringify(C.errors));
});

t('단어장에서 글자와 기대 획수를 모은다 — 직접 적은 글자·낱말의 한자·획수 표', () => {
  const w = wantedFromBook({ chars: [{ ch: '山', strokes: 3 }], words: [{ word: '관측', hanja: '觀測' }, { word: '천지', parts: [{ ch: '天' }, { ch: '地' }] }], strokes: { '觀': 25, '山': 99 } });
  assert.deepStrictEqual(w, { '山': 3, '觀': 25, '測': null, '天': null, '地': null });
});

console.log(`\nOK — ${passed}개 통과`);
