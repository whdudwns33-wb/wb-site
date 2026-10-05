'use strict';
/* 한자 따라쓰기 판정 검증 (node hanja/trace.test.cjs)
 *
 * 손으로 하는 훈련이라 화면만 보고는 어긋난 판정을 못 알아챈다 — "안 썼는데 통과",
 * "잘 썼는데 다시" 둘 다 조용히 망가진다. 캔버스 없이 마스크·좌표만으로 판정을 못 박는다. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const T = require('./trace.js');
const B = require('./book-check.js');

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };
const N = 48;
const line = (x0, y0, x1, y1, k = 12) => { const o = []; for (let i = 0; i < k; i++) o.push({ x: x0 + (x1 - x0) * i / (k - 1), y: y0 + (y1 - y0) * i / (k - 1) }); return o; };
/* 합성 글리프 — 一(가로 막대) 와 十(가로+세로) 을 마스크로 직접 만든다 */
const glyphBar = () => T.rasterize([line(0.12, 0.5, 0.88, 0.5)], N, 2);
const glyphCross = () => T.rasterize([line(0.1, 0.5, 0.9, 0.5), line(0.5, 0.1, 0.5, 0.9)], N, 2);

t('한 글자를 세 번 쓰고 다음 글자로, 안내는 회차마다 옅어져 마지막은 없다', () => {
  const p = T.plan('觀測');
  assert.deepStrictEqual(p.map((s) => s.ch + s.rep), ['觀0', '觀1', '觀2', '測0', '測1', '測2']);
  assert.deepStrictEqual(p.filter((s) => s.last).map((s) => s.ch), ['觀', '測']);
  assert.ok(T.guideAlpha(0) > T.guideAlpha(1) && T.guideAlpha(2) === 0);
  assert.deepStrictEqual(T.chars('관측(觀測) abc'), ['觀', '測']);
});

t('안 쓰고 넘기기는 막히고, 一 한 획은 통과한다', () => {
  assert.ok(!T.enough([], 1));
  assert.ok(!T.enough([[{ x: 0.5, y: 0.5 }, { x: 0.52, y: 0.5 }]], 1), '톡 찍은 것이 통과했다');
  assert.ok(T.enough([line(0.12, 0.5, 0.88, 0.5)], 1), '一 한 획이 막혔다');
});

t('획 수 — 실수로 닿은 점은 세지 않고 丶 같은 짧은 획은 센다', () => {
  const strokes = [line(0.1, 0.5, 0.9, 0.5), line(0.5, 0.1, 0.5, 0.9), [{ x: 0.3, y: 0.3 }, { x: 0.305, y: 0.3 }], line(0.6, 0.6, 0.66, 0.68, 4)];
  assert.strictEqual(T.strokeCount(strokes), 3);
});

t('모양 모드 — 안내를 따라 그으면 good, 엉뚱한 곳은 retry, 덧칠은 stray 로 잡힌다', () => {
  const g = glyphBar();
  const good = T.coverage(g, T.rasterize([line(0.13, 0.51, 0.87, 0.49)], N), N);
  assert.ok(good.hit > 0.9, '따라 그은 획의 덮음률이 낮다: ' + good.hit);
  assert.ok(good.stray < 0.1, '따라 그은 획이 샜다고 한다: ' + good.stray);
  assert.strictEqual(T.verdict(good, 1, 1).level, 'good');

  const wrong = T.coverage(g, T.rasterize([line(0.5, 0.1, 0.5, 0.9)], N), N);
  assert.ok(wrong.hit < 0.3, '세로로 그었는데 가로 막대를 덮었다고 한다: ' + wrong.hit);
  assert.strictEqual(T.verdict(wrong, 1, 1).level, 'retry');

  const messy = T.coverage(g, T.rasterize([line(0.13, 0.5, 0.87, 0.5), line(0.2, 0.15, 0.8, 0.2), line(0.2, 0.85, 0.8, 0.8)], N), N);
  assert.ok(messy.hit > 0.9 && messy.stray > 0.5, '막대 밖 낙서가 stray 로 안 잡힌다: ' + JSON.stringify(messy));
  assert.notStrictEqual(T.verdict(messy, 3, 1).level, 'good');

  /* 칸을 통째로 칠하기 — 글리프는 다 덮이지만 잉크가 글리프의 몇 배라 통과가 아니다 */
  const fill = []; for (let y = 0.08; y <= 0.92; y += 0.06) fill.push(line(0.08, y, 0.92, y));
  const filled = T.coverage(g, T.rasterize(fill, N), N);
  assert.ok(filled.hit > 0.9, filled.hit);
  assert.strictEqual(T.verdict(filled, fill.length, 1).level, 'retry', '칸을 통째로 칠했는데 통과: ' + JSON.stringify(filled));
  const half = T.coverage(g, T.rasterize([line(0.13, 0.5, 0.5, 0.5)], N), N);
  assert.ok(half.hit > 0.4 && half.hit < 0.65, '반만 그었는데: ' + half.hit);
  assert.notStrictEqual(T.verdict(half, 1, 1).level, 'good');
  assert.ok(T.verdict({ hit: 0, stray: 0 }, 0, 1).level === 'retry');
});

t('획수 대조 — 이어 쓰거나 끊어 쓰면 good 이 ok 로 내려가고 이유를 말한다', () => {
  const g = glyphCross();
  const cov = T.coverage(g, T.rasterize([line(0.1, 0.5, 0.9, 0.5), line(0.5, 0.1, 0.5, 0.9)], N), N);
  assert.strictEqual(T.verdict(cov, 2, 2).level, 'good');
  const v = T.verdict(cov, 1, 2);
  assert.strictEqual(v.level, 'ok');
  assert.ok(/2획인데 1획/.test(v.strokeMsg), v.strokeMsg);
  const v2 = T.verdict(cov, 3, 2);
  assert.ok(/끊어/.test(v2.strokeMsg));
  assert.strictEqual(T.verdict(cov, 2, null).strokeMsg, null, '획수를 모르는 글자에 획수 말을 하면 안 된다');
});

t('래스터·팽창 — 점 하나도 잉크가 되고, 팽창하면 넓어진다', () => {
  const dot = T.rasterize([[{ x: 0.5, y: 0.5 }]], N, 1.5);
  assert.ok(T.count(dot) >= 4 && T.count(dot) <= 12, '점 잉크 크기: ' + T.count(dot));
  assert.ok(T.count(T.dilate(dot, N, 2)) > T.count(dot));
  assert.strictEqual(T.count(T.rasterize([], N)), 0);
});

/* 十 의 획순 데이터 — 체험 단어장의 것과 같다 */
const CROSS = [[[0.1, 0.5], [0.9, 0.5]], [[0.5, 0.1], [0.5, 0.9]]];

t('획순 모드 — 안내선을 따라 그으면 그 획으로 인정하고 다음 획을 기다린다', () => {
  const r1 = T.matchStroke(line(0.12, 0.52, 0.88, 0.49), CROSS, []);
  assert.ok(r1.ok && r1.idx === 0 && !r1.outOfOrder, JSON.stringify(r1));
  assert.strictEqual(T.strokeHint(r1, CROSS), '좋아요, 다음 획!');
  const r2 = T.matchStroke(line(0.5, 0.12, 0.51, 0.9), CROSS, [0]);
  assert.ok(r2.ok && r2.idx === 1, JSON.stringify(r2));
  assert.ok(/마지막 획/.test(T.strokeHint(r2, CROSS)));
});

t('획순 모드 — 거꾸로 그으면 방향을, 순서를 바꾸면 순서를 말한다', () => {
  const rev = T.matchStroke(line(0.88, 0.5, 0.12, 0.5), CROSS, []);
  assert.ok(!rev.ok && rev.reversed && rev.idx === 0, JSON.stringify(rev));
  assert.ok(/왼쪽에서 오른쪽으로/.test(T.strokeHint(rev, CROSS)), T.strokeHint(rev, CROSS));
  const short = T.matchStroke(line(0.58, 0.5, 0.5, 0.5), [[[0.5, 0.5], [0.58, 0.5]]], []);
  assert.ok(!short.ok && short.reversed, '짧은 획의 역방향이 거리 여유 안에 들어가도 통과하면 안 된다');
  const ooo = T.matchStroke(line(0.5, 0.1, 0.5, 0.9), CROSS, []);
  assert.ok(ooo.ok && ooo.idx === 1 && ooo.outOfOrder && ooo.expected === 0, JSON.stringify(ooo));
  assert.ok(/순서가 달라요/.test(T.strokeHint(ooo, CROSS)));
});

t('획순 모드 — 엉뚱한 획은 통과가 아니고, 남은 획이 없으면 -1', () => {
  const diag = T.matchStroke(line(0.1, 0.1, 0.9, 0.9), CROSS, []);
  assert.ok(!diag.ok && !diag.reversed, JSON.stringify(diag));
  assert.ok(/1번째 획/.test(T.strokeHint(diag, CROSS)));
  const none = T.matchStroke(line(0.1, 0.5, 0.9, 0.5), CROSS, [0, 1]);
  assert.strictEqual(none.idx, -1);
  assert.ok(!none.ok);
});

t('빨리 그은 획(점 2개)과 천천히 그은 획(점 60개)이 같은 판정을 받는다', () => {
  const fast = T.matchStroke([{ x: 0.12, y: 0.5 }, { x: 0.88, y: 0.5 }], CROSS, []);
  const slow = T.matchStroke(line(0.12, 0.5, 0.88, 0.5, 60), CROSS, []);
  assert.ok(fast.ok && slow.ok);
  assert.ok(Math.abs(fast.dist - slow.dist) < 0.02);
  assert.strictEqual(T.resample(line(0, 0, 1, 0, 3), 5).length, 5);
  assert.deepStrictEqual(T.resample([{ x: 0.2, y: 0.2 }], 3).map((p) => p.x), [0.2, 0.2, 0.2]);
});

t('체험 단어장의 획순 데이터를 그대로 따라 그으면 전부 순서대로 인정된다', () => {
  const book = B.checkBook(JSON.parse(fs.readFileSync(path.join(__dirname, 'book-sample.json'), 'utf8'))).book;
  const withM = book.chars.filter((c) => c.medians);
  assert.ok(withM.length >= 20);
  withM.forEach((c) => {
    const done = [];
    c.medians.forEach((m, i) => {
      /* 학생이 안내선을 살짝 벗어나 그은 것처럼 0.02 흔들어 준다 */
      const user = m.map(([x, y]) => ({ x: x + 0.02, y: y - 0.015 }));
      const r = T.matchStroke(user, c.medians, done);
      assert.ok(r.ok && r.idx === i && !r.outOfOrder, c.ch + ' ' + (i + 1) + '획: ' + JSON.stringify(r));
      done.push(r.idx);
    });
  });
  /* 방향 낱말 — 一 은 왼쪽에서 오른쪽, 丨 은 위에서 아래 */
  assert.strictEqual(T.directionOf(CROSS[0]), '왼쪽에서 오른쪽으로');
  assert.strictEqual(T.directionOf(CROSS[1]), '위에서 아래로');
});

console.log(`\nOK — ${passed}개 통과`);
