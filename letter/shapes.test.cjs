'use strict';
/* 시공간 놀이 생성기 검증 — node letter/shapes.test.cjs
   같은 seed 는 같은 그림, 보기는 서로 다르고 정답은 범위 안, 거울 문제는 키랄 도형만, 쌓기나무 답은 높이의 합 */
const assert = require('node:assert/strict');
const S = require('./shapes.js');
let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };

t('다섯 종류 전부 만들어지고 같은 seed 면 같은 결과', () => {
  for (const kind of S.KINDS) {
    const a = S.make({ kind, seed: 42, tier: 'E2' }), b = S.make({ kind, seed: 42, tier: 'E2' });
    assert.ok(a && a.prompt && a.answerText, kind);
    assert.deepEqual(a, b, kind + ' 는 결정적이어야 한다');
    assert.notDeepEqual(S.make({ kind, seed: 43, tier: 'E2' }), a, kind + ' 는 seed 가 다르면 달라야 한다');
  }
  assert.equal(S.make({ kind: 'nope', seed: 1 }), null);
  assert.equal(S.make({ kind: 'odd', seed: 0 }), null);
  assert.equal(S.isValidFigure({ kind: 'odd', seed: 3 }), true);
  assert.equal(S.isValidFigure({ kind: 'odd', seed: 'x' }), false);
  assert.equal(S.isValidFigure({ kind: 'odd', seed: 1e9 }), false);
});

t('도형 목록은 전부 키랄 — 거울상이 어떤 회전과도 겹치지 않는다', () => {
  for (const sh of S.SHAPES) {
    const m = S.key(S.mirror(sh.cells));
    const rots = [0, 1, 2, 3].map((k) => S.key(S.turn(sh.cells, k)));
    assert.ok(!rots.includes(m), sh.id);
    assert.equal(S.key(S.turn(sh.cells, 4)), S.key(sh.cells), '네 번 돌리면 제자리');
  }
});

t('보기 문제 — 보기 4개가 서로 다르고 정답 번호가 맞는다 (seed 200개)', () => {
  for (const kind of ['rotate', 'mirror', 'complete']) {
    for (let seed = 1; seed <= 200; seed += 1) {
      for (const tier of ['K', 'E3']) {
        const g = S.make({ kind, seed, tier });
        assert.equal(g.options.length, 4, kind + seed);
        assert.equal(new Set(g.options).size, 4, kind + ' seed ' + seed + ' 보기가 겹친다');
        assert.ok(g.answerIndex >= 0 && g.answerIndex < 4);
        assert.equal(g.answerText, ['①', '②', '③', '④'][g.answerIndex]);
        assert.ok(/^<svg/.test(g.options[0]) && !/<script/.test(g.options.join('')));
      }
    }
  }
});

t('다른 하나 찾기 — 셋은 같고 하나만 다르며 정답이 그 하나를 가리킨다', () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    const g = S.make({ kind: 'odd', seed, tier: 'K' });
    assert.equal(g.options.length, 4);
    assert.equal(new Set(g.options).size, 2, 'seed ' + seed);
    const odd = g.options[g.answerIndex];
    assert.equal(g.options.filter((o) => o === odd).length, 1, '정답은 유일한 것이어야 한다');
  }
});

t('쌓기나무 — 답은 높이의 합, 유치는 2×2·2층, 초등 중학년부터 3×3·3층', () => {
  for (let seed = 1; seed <= 100; seed += 1) {
    const k = S.make({ kind: 'blocks', seed, tier: 'K' }), e = S.make({ kind: 'blocks', seed, tier: 'E3' });
    assert.ok(/^\d+개$/.test(k.answerText) && /^\d+개$/.test(e.answerText));
    assert.ok(+k.answerText.slice(0, -1) <= 8 && +k.answerText.slice(0, -1) >= 1, '유치 ' + k.answerText);
    assert.ok(+e.answerText.slice(0, -1) <= 27 && +e.answerText.slice(0, -1) >= 1, '초등 ' + e.answerText);
    assert.equal(k.options, null);
    assert.ok((k.target.match(/<polygon/g) || []).length === 3 * +k.answerText.slice(0, -1), '나무 하나에 면 셋');
  }
});

t('html() — 과녁·보기 묶음, 잘못된 figure 는 안내 문구', () => {
  const h = S.html({ kind: 'rotate', seed: 9, tier: 'E2' });
  assert.ok(/np-fig-target/.test(h) && (h.match(/np-fig-opt"/g) || []).length === 4 && /①/.test(h) && /④/.test(h));
  assert.ok(/np-fig-missing/.test(S.html({ kind: 'zzz', seed: 1 })));
  assert.ok(!/np-fig-target/.test(S.html({ kind: 'odd', seed: 2 })), '다른 하나 찾기는 과녁이 없다');
});

console.log(`\nOK — ${passed}개 통과 (shapes.test.cjs)`);
