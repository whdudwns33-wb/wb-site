'use strict';
/* 아레나(반 대전) 판정 검증 (node reading-server/arena.test.mjs)
 *
 * 순위표가 걸린 기능이다. 셈이 어긋나면 아이들이 먼저 알아채고 신뢰를 잃는다.
 */
import assert from 'node:assert';
import { buildRound, forClient, grade, rank, ARENA_Q, ARENA_MS_CAP } from './arena.mjs';

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };

const POOL = Array.from({ length: 14 }, (_, i) => ({ word: '낱말' + i, meaning: '뜻' + i }));

t('같은 반·같은 날이면 늘 같은 문제가 나온다', () => {
  /* 반 전체가 같은 문제를 풀어야 점수를 견줄 수 있다. 사람마다 다르면 순위표가 거짓말이다. */
  const a = buildRound(POOL, '초5 A반', '2026-09-01');
  const b = buildRound(POOL, '초5 A반', '2026-09-01');
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(a.map((q) => q.options), b.map((q) => q.options), '보기 차례까지 같아야 한다');
});

t('날짜나 반이 바뀌면 문제도 바뀐다', () => {
  const a = buildRound(POOL, '초5 A반', '2026-09-01');
  assert.notDeepStrictEqual(a, buildRound(POOL, '초5 A반', '2026-09-02'), '다음 날은 새 문제');
  assert.notDeepStrictEqual(a, buildRound(POOL, '중1 B반', '2026-09-01'), '다른 반은 다른 문제');
});

t('문항은 열 개, 보기는 넷, 정답이 보기 안에 있다', () => {
  const r = buildRound(POOL, 'A', '2026-09-01');
  assert.strictEqual(r.length, ARENA_Q);
  for (const q of r) {
    assert.strictEqual(q.options.length, 4);
    assert.ok(q.options.includes(q.answer), q.word + ': 정답이 보기에 없다');
    assert.strictEqual(new Set(q.options).size, 4, q.word + ': 보기가 겹친다');
  }
});

t('낱말이 모자라면 문제를 만들지 않는다', () => {
  /* 보기 넷을 못 만들면서 억지로 내면 답이 뻔한 문제가 된다 */
  assert.strictEqual(buildRound(POOL.slice(0, 3), 'A', 'd'), null);
  assert.strictEqual(buildRound([], 'A', 'd'), null);
  assert.strictEqual(buildRound(null, 'A', 'd'), null);
  const few = buildRound(POOL.slice(0, 5), 'A', 'd');
  assert.strictEqual(few.length, 5, '열 개보다 적으면 있는 만큼만 낸다');
});

t('뜻이 같은 낱말이 보기에 두 번 오지 않는다', () => {
  /* 같은 뜻이 보기에 둘 있으면 정답이 둘이 된다 */
  const dup = POOL.concat([{ word: '다른낱말', meaning: '뜻0' }]);
  const r = buildRound(dup, 'A', 'd');
  const words = r.map((q) => q.word);
  assert.ok(!(words.includes('낱말0') && words.includes('다른낱말')), '뜻이 겹치는 낱말은 하나만 쓴다');
});

t('화면으로 나가는 문제에는 정답이 없다', () => {
  /* 답이 같이 가면 순위표가 의미를 잃는다 */
  const r = buildRound(POOL, 'A', 'd');
  for (const q of forClient(r)) {
    assert.deepStrictEqual(Object.keys(q).sort(), ['options', 'word']);
  }
});

t('채점 — 정확도가 먼저, 속도는 동점을 가른다', () => {
  const r = buildRound(POOL, 'A', 'd');
  const all = r.map((q) => q.answer);
  const fast = grade(r, all, r.map(() => 1000));
  const slow = grade(r, all, r.map(() => ARENA_MS_CAP));
  assert.strictEqual(fast.right, 10);
  assert.strictEqual(slow.right, 10);
  assert.ok(fast.score > slow.score, '같은 정답 수면 빠른 쪽이 높다');
  /* 정확도 차이가 속도 차이를 이긴다 — 찍고 빨리 넘기는 것이 이득이면 안 된다 */
  const nine = grade(r, all.map((a, i) => (i === 0 ? '틀린답' : a)), r.map(() => 1));
  assert.ok(nine.score < slow.score, '9개 맞히고 번개처럼 풀어도 10개 맞힌 느림보를 못 이긴다');
});

t('채점 — 안 푼 문항은 시간 상한으로 친다', () => {
  const r = buildRound(POOL, 'A', 'd');
  const g = grade(r, [], []);
  assert.strictEqual(g.right, 0);
  assert.strictEqual(g.score, 0, '하나도 안 맞히면 빠르기 보너스도 없다');
  assert.strictEqual(g.ms, ARENA_Q * ARENA_MS_CAP, '자리 비운 것을 0초로 쳐 주면 안 된다');
});

t('채점 — 이상한 시간 값을 넣어도 점수가 터지지 않는다', () => {
  const r = buildRound(POOL, 'A', 'd');
  const all = r.map((q) => q.answer);
  for (const bad of [-999, 0, NaN, Infinity, 'x', null]) {
    const g = grade(r, all, r.map(() => bad));
    assert.ok(Number.isFinite(g.score) && g.score >= 1000 && g.score <= 1050,
      '시간이 ' + String(bad) + ' 일 때 점수 ' + g.score);
  }
  /* 음수 시간으로 보너스를 부풀릴 수 없다 */
  const huge = grade(r, all, r.map(() => -1e9));
  assert.ok(huge.score <= 1050, '음수 시간으로 점수를 못 올린다');
});

t('순위 — 점수, 같으면 시간, 그다음 이름', () => {
  const rows = [
    { code: 'c', name: '다', score: 800, ms: 5000 },
    { code: 'a', name: '가', score: 900, ms: 9000 },
    { code: 'b', name: '나', score: 800, ms: 4000 },
  ];
  const r = rank(rows, 'b');
  assert.deepStrictEqual(r.map((x) => x.name), ['가', '나', '다']);
  assert.deepStrictEqual(r.map((x) => x.place), [1, 2, 3]);
  assert.strictEqual(r[1].me, true, '나를 표시한다');
  assert.strictEqual(r[0].me, false);
});

t('순위 — 아무도 안 풀었으면 빈 표다', () => {
  assert.deepStrictEqual(rank([], 'a'), []);
  assert.deepStrictEqual(rank(null, 'a'), []);
});

console.log('\n통과 ' + passed + '개 — 아레나 판정 검증 완료');
