'use strict';
/* node letter/drills.test.cjs — 5분 두뇌 놀이 생성기 */
const assert = require('node:assert/strict');
const path = require('node:path');
const D = require('./drills.js');
let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };

t('다섯 종류가 네 지표를 덮는다 — 시공간은 shapes.js 몫', () => {
  assert.deepEqual(D.KINDS, ['span', 'symbols', 'sequence', 'common', 'odd-word']);
  assert.deepEqual(new Set(Object.values(D.INDEX_OF)), new Set(['WMI', 'PSI', 'FRI', 'VCI']));
  assert.deepEqual(D.kindsFor('VCI'), ['common', 'odd-word']);
});
t('같은 seed 는 같은 문제, 다른 seed 는 다른 문제; 잘못된 입력은 null', () => {
  for (const kind of D.KINDS) {
    const a = D.make({ kind, seed: 7, tier: 'E2' }), b = D.make({ kind, seed: 7, tier: 'E2' });
    assert.deepEqual(a, b, kind);
    assert.ok(a.prompt && a.body && a.answerText && a.hint && a.index && a.label, kind + ' 필드');
    assert.ok(!/<script|onload|onerror/i.test(a.body), '몸통에 스크립트가 없다');
  }
  assert.notEqual(D.make({ kind: 'span', seed: 7 }).answerText, D.make({ kind: 'span', seed: 8 }).answerText);
  assert.equal(D.make({ kind: 'nope', seed: 1 }), null); assert.equal(D.make({ kind: 'span', seed: 0 }), null);
  assert.ok(D.isValidDrill({ kind: 'symbols', seed: 12 })); assert.ok(!D.isValidDrill({ kind: 'symbols', seed: 0 })); assert.ok(!D.isValidDrill({ kind: 'x', seed: 1 }));
});
t('거꾸로 말하기 — 학년대별 길이(3·4·5), 답은 거꾸로', () => {
  const k = D.make({ kind: 'span', seed: 3, tier: 'K' }), m = D.make({ kind: 'span', seed: 3, tier: 'M' });
  const digits = (g) => g.body.replace(/<[^>]+>/g, '').trim().split(' – ');
  assert.equal(digits(k).length, 3); assert.equal(digits(m).length, 5);
  assert.equal(m.answerText, digits(m).reverse().join(' – '));
  assert.equal(new Set(digits(m)).size, 5, '숫자가 겹치지 않는다');
});
t('기호 찾기 — 정답 개수가 격자와 맞고, 저학년은 작은 격자', () => {
  for (const seed of [1, 22, 333]) {
    const g = D.make({ kind: 'symbols', seed, tier: 'E3' });
    const target = g.body.match(/찾을 기호 <b>(.)<\/b>/)[1];
    const cells = (g.body.match(/<span>(.)<\/span>/g) || []).map((x) => x.replace(/<[^>]+>/g, ''));
    assert.equal(cells.length, 56);
    assert.equal(g.answerText, cells.filter((c) => c === target).length + '개');
  }
  assert.equal((D.make({ kind: 'symbols', seed: 5, tier: 'K' }).body.match(/<span>/g) || []).length, 30);
});
t('수열 — 빈 칸 하나, 답은 규칙에 맞는 수; 저학년은 등차만', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const g = D.make({ kind: 'sequence', seed, tier: seed % 2 ? 'E1' : 'M' });
    const shown = g.body.replace(/<[^>]+>/g, '').trim().split(' , ');
    assert.equal(shown.filter((x) => x === '□').length, 1);
    assert.ok(/^\d+$/.test(g.answerText));
    if (seed % 2) assert.ok(/씩 커져요/.test(g.hint), '저학년은 등차');
  }
});
t('공통점·무리 — 낱말 은행에서 범주가 섞이지 않게; 정답은 범주 이름', () => {
  const c = D.make({ kind: 'common', seed: 9, tier: 'E2' });
  const words = c.body.replace(/<[^>]+>/g, '').split(' · ');
  const cat = D.BANK.find((b) => words.every((w) => b.words.includes(w)));
  assert.ok(cat, '세 낱말이 한 범주에서 나온다'); assert.equal(c.answerText, '모두 ' + cat.cat + '(이)에요');
  const o = D.make({ kind: 'odd-word', seed: 9, tier: 'E2' });
  const four = o.body.replace(/<[^>]+>/g, '').split(/\s{2}/).map((x) => x.replace(/^[①②③④] /, ''));
  assert.equal(four.length, 4);
  const m = o.answerText.match(/^([①②③④]) (\S+) — 나머지는 (.+)$/); assert.ok(m);
  const rest = four.filter((w) => w !== m[2]); const cat2 = D.BANK.find((b) => b.cat === m[3]);
  assert.ok(rest.every((w) => cat2.words.includes(w)) && !cat2.words.includes(m[2]));
});
t('오늘의 5분 — 주차·학년대·요일로 결정, 요일마다 종류가 돈다', () => {
  const a = D.daily('2026-W39', 'E2', 3), b = D.daily('2026-W39', 'E2', 3), c = D.daily('2026-W40', 'E2', 3);
  assert.deepEqual(a, b); assert.notEqual(a.seed, c.seed); assert.equal(a.tier, 'E2');
  const kinds = [1, 2, 3, 4, 5].map((d) => D.daily('2026-W39', 'K', d).kind);
  assert.deepEqual(new Set(kinds).size, 5, '닷새에 다섯 종류');
  assert.ok(D.isValidDrill(a));
  assert.ok(/np-dr/.test(D.html(a)));
});
console.log(`\nOK — ${passed}개 통과 (${path.basename(__filename)})`);
