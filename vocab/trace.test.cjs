'use strict';
/* 한자 따라쓰기 판정 검증 (node vocab/trace.test.cjs)
 *
 * 손으로 하는 훈련이라 화면만 보고는 어긋난 것을 못 알아챈다.
 * "손 안 대고 세 번 넘겼는데 다 썼다고 나온다"는 조용히 망가진다.
 */
const assert = require('assert');
const T = require('./trace.js');
const { WB_WORDS } = require('./words.js');

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };

/* 칸 한 변을 240으로 두고 잰다 — 화면 기본 크기 */
const SIZE = 240;
const line = (len) => [[{ x: 20, y: 120 }, { x: 20 + len, y: 120 }]];

t('한 글자를 세 번 쓰고 다음 글자로 넘어간다', () => {
  /* 觀→測→觀→測로 섞으면 획이 손에 붙기 전에 화면이 바뀐다 */
  const p = T.plan('觀測');
  assert.strictEqual(p.length, 6);
  assert.deepStrictEqual(p.map((s) => s.ch), ['觀', '觀', '觀', '測', '測', '測']);
  assert.deepStrictEqual(p.map((s) => s.rep), [0, 1, 2, 0, 1, 2]);
  assert.deepStrictEqual(p.filter((s) => s.last).map((s) => s.ch), ['觀', '測'],
    '글자마다 마지막 회차가 하나씩 있어야 한다');
});

t('한자가 아닌 글자는 따라쓰기에 안 들어간다', () => {
  assert.deepStrictEqual(T.chars('관측(觀測)'), ['觀', '測'], '한글과 괄호는 뺀다');
  assert.deepStrictEqual(T.chars('abc'), []);
  assert.deepStrictEqual(T.chars(''), []);
  assert.deepStrictEqual(T.chars(null), [], '한자 표기가 없는 낱말이 들어와도 빈 목록');
  assert.deepStrictEqual(T.plan(undefined), [], '쓸 글자가 없으면 차례도 없다');
});

t('시드 한자어 45개의 한자가 하나도 안 빠진다', () => {
  /* 정규식이 좁으면 특정 글자만 조용히 따라쓰기에서 사라진다 */
  WB_WORDS.filter((w) => w.type === 'hanja').forEach((w) => {
    assert.strictEqual(T.chars(w.hanja).join(''), w.hanja, w.word + ' 한자가 걸러졌다');
    assert.strictEqual(T.plan(w.hanja).length, w.hanja.length * T.REPS, w.word);
  });
});

t('안내 글자는 회차마다 옅어지고 마지막엔 사라진다', () => {
  /* 세 번 다 진하게 보여 주면 베끼기 세 번이지 인출 훈련이 아니다 */
  const a = [0, 1, 2].map(T.guideAlpha);
  assert.ok(a[0] > a[1], '2회차는 1회차보다 옅어야 한다');
  assert.ok(a[1] > a[2], '3회차는 2회차보다 옅어야 한다');
  assert.strictEqual(a[2], 0, '마지막은 안내 없이 스스로 쓴다');
  assert.strictEqual(T.guideAlpha(9), 0, '범위를 넘어가도 0');
  assert.strictEqual(T.guideAlpha(-1), T.GUIDE[0], '이상한 값이면 첫 회차처럼');
  assert.strictEqual(T.guideAlpha('x'), T.GUIDE[0]);
});

t('손 안 대고 다음으로 넘어갈 수 없다', () => {
  assert.strictEqual(T.enough([], SIZE), false, '빈 칸');
  assert.strictEqual(T.enough(null, SIZE), false);
  assert.strictEqual(T.enough([[{ x: 100, y: 100 }]], SIZE), false, '톡 찍기');
  assert.strictEqual(T.enough(line(20), SIZE), false, '짧게 긋고 넘기기');
});

t('한 획짜리 글자도 통과한다', () => {
  /* 一은 가로 한 획이다. 기준이 높으면 一을 못 쓴다 */
  assert.strictEqual(T.enough(line(SIZE * 0.8), SIZE), true, '칸을 가로지르는 한 획');
});

t('여러 획을 나눠 그어도 합쳐서 센다', () => {
  const three = [
    [{ x: 20, y: 60 }, { x: 200, y: 60 }],
    [{ x: 20, y: 120 }, { x: 200, y: 120 }],
    [{ x: 110, y: 30 }, { x: 110, y: 210 }],
  ];
  assert.ok(T.enough(three, SIZE));
  assert.ok(Math.abs(T.inkLen(three) - (180 + 180 + 180)) < 1e-6);
});

t('칸이 커지면 기준도 같이 커진다', () => {
  /* 큰 화면에서 작게 끄적이고 넘어가면 안 된다 */
  assert.ok(T.minInk(480) > T.minInk(240));
  assert.strictEqual(T.enough(line(160), 240), true);
  assert.strictEqual(T.enough(line(160), 480), false, '같은 획도 큰 칸에서는 모자라다');
  assert.ok(T.minInk(0) > 0, '크기를 못 잰 경우에도 기준이 0이면 안 된다');
  assert.strictEqual(T.minInk(NaN), T.minInk(240));
});

t('이상한 좌표가 들어와도 터지지 않는다', () => {
  /* 포인터 이벤트가 가끔 빈 값을 흘린다 */
  assert.strictEqual(T.inkLen([[{ x: NaN, y: 0 }, { x: 10, y: 0 }]]), 0);
  assert.strictEqual(T.inkLen([[null, { x: 10, y: 0 }]]), 0);
  assert.strictEqual(T.inkLen([null, undefined]), 0);
  assert.strictEqual(T.inkLen('붓'), 0);
  const wild = T.inkLen([[{ x: 0, y: 0 }, { x: Infinity, y: 0 }]]);
  assert.ok(Number.isFinite(wild), '무한대가 점수로 새 나가면 안 된다');
});

console.log('\n통과 ' + passed + '개 — 한자 따라쓰기 판정 검증 완료');
