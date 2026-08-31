'use strict';
/* 어휘 나이 판정 검증 (node vocab-age/age.test.cjs)
 *
 * 이 수치는 학부모에게 아이의 어휘 수준으로 제시된다. 틀리면 조용히 틀린다 —
 * 화면에는 그럴듯한 「초4 수준」이 뜨고 아무도 이상한 줄 모른다. 그래서 여기서 조인다.
 */
const assert = require('assert');
const A = require('./age.js');
const fs = require('fs');
const path = require('path');

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };

/* tried 배열 만들기 — {칸번호: 맞힌 개수} */
const T = (o) => { const a = []; for (const [k, v] of Object.entries(o)) a[+k] = v; return a; };

t('사다리는 초1부터 중등까지 여섯 칸', () => {
  assert.deepStrictEqual(A.BANDS.map((b) => b.label), ['초1', '초2', '초3', '초4', '초5·6', '중1~3']);
  assert.strictEqual(A.PER_BAND, 3);
  assert.strictEqual(A.PASS, 2);
});

t('통과하면 한 칸 올라간다', () => {
  assert.deepStrictEqual(A.nextBand(T({ 2: 3 })), { done: false, next: 3, reason: 'up' });
  assert.deepStrictEqual(A.nextBand(T({ 2: 2 })), { done: false, next: 3, reason: 'up' },
    '3개 중 2개면 통과다');
});

t('막히면 거기서 끝난다 — 이미 통과한 칸이 아래에 있으므로', () => {
  const r = A.nextBand(T({ 2: 3, 3: 1 }));
  assert.strictEqual(r.done, true, '초4에서 막혔으면 더 볼 것이 없다');
  assert.strictEqual(A.verdict(T({ 2: 3, 3: 1 })).band.label, '초3', '통과한 가장 높은 칸');
});

t('시작 칸부터 틀리면 내려가며 찾는다', () => {
  assert.deepStrictEqual(A.nextBand(T({ 3: 1 })), { done: false, next: 2, reason: 'down' });
  assert.deepStrictEqual(A.nextBand(T({ 3: 1, 2: 0 })), { done: false, next: 1, reason: 'down' });
  /* 내려가다 통과하면 끝 */
  assert.strictEqual(A.nextBand(T({ 3: 1, 2: 0, 1: 2 })).done, true);
  assert.strictEqual(A.verdict(T({ 3: 1, 2: 0, 1: 2 })).band.label, '초2');
});

t('맨 위를 통과하면 더 낼 것이 없다', () => {
  const tried = T({ 5: 3 });
  assert.deepStrictEqual(A.nextBand(tried), { done: true, next: null, reason: 'ceiling' });
  assert.strictEqual(A.verdict(tried).band.label, '중1~3');
  assert.strictEqual(A.verdict(tried).nextBand, null, '위가 없으면 「다음 칸」도 없다');
});

t('맨 아래까지 내려가도 못 통과하면 「초1 미만」이다', () => {
  const tried = T({ 2: 1, 1: 0, 0: 1 });
  assert.deepStrictEqual(A.nextBand(tried), { done: true, next: null, reason: 'floor' });
  const v = A.verdict(tried);
  assert.strictEqual(v.below, true);
  assert.strictEqual(v.band, null, '없는 수준을 지어내지 않는다');
});

t('같은 칸을 두 번 내지 않는다 — 안 그러면 안 끝나고 낱말도 겹친다', () => {
  /* 초3 통과 → 초4 실패. 여기서 다시 초3을 내면 무한히 오간다. */
  const tried = T({ 2: 3, 3: 0 });
  assert.strictEqual(A.nextBand(tried).done, true);
  /* 어떤 조합으로 굴려도 끝나는지 — 모든 시작 칸 × 모든 점수로 완주해 본다 */
  for (let start = 0; start < A.BANDS.length; start++) {
    for (let seed = 0; seed < 64; seed++) {
      const tr = []; let at = start, steps = 0;
      while (at != null) {
        tr[at] = (seed >> (at % 6)) & 1 ? 3 : 0;
        const n = A.nextBand(tr);
        at = n.done ? null : n.next;
        steps += 1;
        assert.ok(steps <= A.BANDS.length, '칸 수보다 많이 도는 조합이 있다 (start=' + start + ', seed=' + seed + ')');
      }
    }
  }
});

t('문항 수와 정답 수를 함께 돌려준다', () => {
  const v = A.verdict(T({ 3: 2, 4: 1 }));
  assert.strictEqual(v.asked, 6, '두 칸 × 3문항');
  assert.strictEqual(v.right, 3);
  assert.strictEqual(v.band.label, '초4');
  assert.strictEqual(v.nextBand.label, '초5·6', '막힌 칸을 「아직 어려운 칸」으로 알려 준다');
});

/* ── 문제 밑천 ── */
const WORDS = JSON.parse(fs.readFileSync(path.join(__dirname, 'words.json'), 'utf8'));

t('칸마다 문제를 낼 만큼 낱말이 있다', () => {
  for (const b of A.BANDS) {
    const list = WORDS.bands[b.id];
    assert.ok(Array.isArray(list), b.label + ' 칸이 없다');
    /* 문항 3개 + 오답 보기 3개씩 = 최소 12개는 있어야 겹치지 않는다 */
    assert.ok(list.length >= 12, b.label + ': 낱말이 ' + list.length + '개뿐이다');
  }
});

t('공개 데이터에 교재 코칭 원문이 섞이지 않았다', () => {
  /* 코칭글은 강사용 자료다. 로그인 없이 열리는 페이지로 새어 나가면 안 된다.
     그래서 낱말과 뜻만 싣는다 — 필드가 늘면 여기서 걸린다. */
  for (const b of A.BANDS)
    for (const w of WORDS.bands[b.id]) {
      assert.deepStrictEqual(Object.keys(w).sort(), ['m', 'w'],
        b.label + ' ' + w.w + ': 낱말(w)과 뜻(m) 말고 다른 것이 실렸다');
      assert.ok(w.m.length <= 60, b.label + ' ' + w.w + ': 뜻이 너무 길다 — 원문 조각일 수 있다');
    }
});

t('같은 낱말이 여러 칸에 걸쳐 있지 않다', () => {
  /* 걸쳐 있으면 그 낱말을 맞혔을 때 어느 칸의 실력인지 알 수 없다 */
  const at = {};
  for (const b of A.BANDS) for (const w of WORDS.bands[b.id]) (at[w.w] = at[w.w] || []).push(b.label);
  const dup = Object.entries(at).filter(([, bs]) => bs.length > 1);
  assert.strictEqual(dup.length, 0,
    '여러 칸에 있는 낱말: ' + dup.slice(0, 5).map(([w, bs]) => w + '(' + bs.join(',') + ')').join(', '));
});

console.log('\n통과 ' + passed + '개 — 어휘 나이 판정 검증 완료');
