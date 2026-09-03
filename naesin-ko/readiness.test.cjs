/* 준비도가 정직한 숫자인가 (node naesin-ko/readiness.test.cjs)
 *
 * 지표는 틀려도 아무도 못 알아챈다 — 그럴듯한 숫자가 나오기 때문이다. 그래서 여기서는
 * "값이 얼마다"가 아니라 **어떤 성질을 지켜야 하는가**를 건다:
 *   · 안 배운 것을 만점으로 세지 않는다 (표본 적은 적용 정답률, 범위에 없는 축)
 *   · 학교 배점이 바뀌면 가중치가 따라 바뀐다
 *   · 남은 날이 물리적으로 부족하면 그건 추정이 아니라 확정이다 */
const assert = require('assert');
const R = require('./readiness.js');
const E = require('./engine.js');

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };
const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= (eps == null ? 0.5 : eps), `${a} ≈ ${b} 아님`);

/* 작품 2편 · 작품당 빈칸 3 · 어휘 2 */
function pack(n) {
  const works = [];
  for (let i = 1; i <= (n || 2); i++) {
    works.push({
      workId: 'w' + i, title: '작품' + i,
      blanks: [{ id: 'w' + i + '-b1' }, { id: 'w' + i + '-b2' }, { id: 'w' + i + '-b3' }],
      vocab: [{ id: 'w' + i + '-v1' }, { id: 'w' + i + '-v2' }]
    });
  }
  return { works };
}
/* 상태 맵을 손으로 짓는다 — engine의 스케줄러를 거치지 않아야 준비도만 시험한다 */
function item(reached, relearn, extra) {
  return Object.assign({ reached: !!reached, relearnCount: relearn || 0, wrong: 0, overconfident: 0 }, extra || {});
}
function full(p) {
  const st = {};
  p.works.forEach((w) => {
    st['w-' + w.workId] = { stage: 5, applyRight: 10, applyTotal: 10, reached: true, essayDone: true };
    w.blanks.forEach((b) => { st['b-' + b.id] = item(true, 3); });
    w.vocab.forEach((v) => { st['v-' + v.id] = item(true, 3); });
  });
  return st;
}

t('engine과 상수가 어긋나면 두 화면이 서로 다른 말을 한다', () => {
  assert.strictEqual(R.RELEARN_TARGET, E.RELEARN_TARGET);
  assert.strictEqual(R.APPLY_GATE_RATE, E.APPLY_GATE_RATE);
});

t('가중치 합은 언제나 1이고, 학교 서술형 배점이 곧 서술형 가중치다', () => {
  const sum = (w) => Object.keys(w).reduce((a, k) => a + w[k], 0);
  near(sum(R.weights(null)), 1, 1e-9);
  near(sum(R.weights(0.4)), 1, 1e-9);
  assert.strictEqual(R.weights(0.4).essay, 0.4);
  assert.strictEqual(R.weights(0.02).essay, 0.05);   // 하한 — 서술형 0점짜리 시험은 없다
  assert.strictEqual(R.weights(0.9).essay, 0.45);    // 상한 — 나머지 축이 사라지면 안 된다
  assert.ok(R.weights(0.4).blank < R.weights(null).blank, '서술형이 커지면 나머지는 줄어야 한다');
});

t('2층 암기 모델이 그대로 항목 점수가 된다', () => {
  assert.strictEqual(R.itemScore(null, 3), 0);
  assert.strictEqual(R.itemScore(item(false), 3), 0);
  assert.strictEqual(R.itemScore(item(true, 0), 3), 0.5);        // 도달만으로는 절반
  near(R.itemScore(item(true, 2), 3), 0.8333, 0.001);
  assert.strictEqual(R.itemScore(item(true, 3), 3), 1);
});

t('안정화 하한 일수는 노력으로 줄일 수 없다', () => {
  assert.strictEqual(R.needDays(null, 3), 4);                    // 도달 하루 + 서로 다른 날 3회전
  assert.strictEqual(R.needDays(item(true, 0), 3), 3);
  assert.strictEqual(R.needDays(item(true, 2), 3), 1);
  assert.strictEqual(R.needDays(item(true, 3), 3), 0);
});

t('아무것도 안 한 학생은 0, 다 한 학생은 100', () => {
  const p = pack();
  assert.strictEqual(R.readiness(p, {}, {}).score, 0);
  assert.strictEqual(R.readiness(p, {}, {}).grade.key, 'start');
  const done = R.readiness(p, full(p), {});
  assert.strictEqual(done.score, 100);
  assert.strictEqual(done.grade.key, 'ready');
  assert.strictEqual(done.alert, null);
});

t('표본이 적은 적용 정답률은 만점을 못 받는다 — 2문항 100%는 100%가 아니다', () => {
  const p = pack(1);
  const few = { 'w-w1': { stage: 3, applyRight: 2, applyTotal: 2 } };
  const many = { 'w-w1': { stage: 3, applyRight: 8, applyTotal: 8 } };
  const ax = (st) => R.readiness(p, st, {}).parts.filter((x) => x.key === 'apply')[0];
  assert.ok(ax(few).rate < ax(many).rate, '시도 수가 신뢰에 반영돼야 한다');
  assert.strictEqual(ax(many).rate, 1);
  assert.strictEqual(ax(few).rate, 0.5);                          // 2/4 표본
  /* 게이트 기준선(80%)이 만점선이다 — 그 위는 더 안 준다 */
  assert.strictEqual(ax({ 'w-w1': { stage: 3, applyRight: 8, applyTotal: 10 } }).rate, 1);
  assert.strictEqual(ax({ 'w-w1': { stage: 3, applyRight: 10, applyTotal: 10 } }).rate, 1);
});

t('범위에 없는 축은 감점하지 않는다 — 어휘 0개 팩에서 어휘 0%는 거짓말이다', () => {
  const p = { works: [{ workId: 'w1', title: 'ㄱ', blanks: [{ id: 'b1' }], vocab: [] }] };
  const rd = R.readiness(p, {}, {});
  const vocab = rd.parts.filter((x) => x.key === 'vocab')[0];
  assert.strictEqual(vocab.weight, 0);
  const live = rd.parts.reduce((a, x) => a + x.weight, 0);
  near(live, 1, 1e-9);                                            // 남은 축이 100%를 채운다
});

t('사다리에서 열린 축만 다음 할 일이 된다 — 읽기 없이 구절 적용을 시킬 수 없다', () => {
  const p = pack(1);
  /* 아무것도 안 한 학생: 가중치가 가장 큰 축은 '구절 적용'이지만 지시는 '작품 읽기'여야 한다 */
  assert.strictEqual(R.readiness(p, {}, {}).weak, 'read');
  const read = { 'w-w1': { stage: 2, applyRight: 0, applyTotal: 0 } };
  assert.ok(['blank', 'vocab'].indexOf(R.readiness(p, read, {}).weak) >= 0);
  /* 개념 빈칸이 절반을 넘겨야 적용이 열린다 */
  const half = Object.assign({}, read);
  p.works[0].blanks.forEach((b) => { half['b-' + b.id] = item(true, 3); });
  p.works[0].vocab.forEach((v) => { half['v-' + v.id] = item(true, 3); });
  assert.strictEqual(R.readiness(p, half, {}).weak, 'apply');
});

t('약한 축이 오늘 할 일을 가리킨다', () => {
  const p = pack(1);
  const st = full(p);
  st['w-w1'].essayDone = false;                                   // 서술형만 안 함
  const rd = R.readiness(p, st, { essayWeight: 0.4 });
  assert.strictEqual(rd.weak, 'essay');
  assert.strictEqual(rd.score, 60);                               // 서술형 배점이 40%면 딱 그만큼 빈다
  const w = rd.parts.filter((x) => x.key === 'essay')[0];
  assert.ok(/서술형/.test(w.act), w.act);
});

t('남은 날이 부족한 것은 추정이 아니라 확정이다', () => {
  const p = pack(1);
  const late = R.readiness(p, {}, { dday: 2 });                   // 손도 안 댐 + D-2 → 최소 4일 필요
  assert.strictEqual(late.pace.minDays, 4);
  assert.strictEqual(late.pace.onTrack, false);
  assert.strictEqual(late.alert.level, 'risk');
  assert.ok(/최소 4일/.test(late.alert.why), late.alert.why);

  const early = R.readiness(p, {}, { dday: 21 });
  assert.strictEqual(early.pace.onTrack, true);
  assert.notStrictEqual(early.alert && early.alert.level, 'risk');
});

t('하루 회전 부담을 남은 날로 나눠 낸다', () => {
  const p = pack(2);                                              // 빈칸 6 + 어휘 4 = 10개 × 4일
  const rd = R.readiness(p, {}, { dday: 20 });
  assert.strictEqual(rd.pace.rotations, 40);
  assert.strictEqual(rd.pace.perDay, 2);
  assert.strictEqual(R.readiness(p, {}, { dday: 1 }).pace.perDay, 40);
});

t('시험 프로필의 서술형 배점을 알아서 쓴다', () => {
  const p = pack(1);
  const st = full(p); st['w-w1'].essayDone = false;
  const a = R.readiness(p, st, { exam: { profile: { essayWeight: 0.4 } } });
  const b = R.readiness(p, st, { exam: { profile: { essayWeight: null } } });
  assert.strictEqual(a.score, 60);
  assert.strictEqual(b.score, 85);                                // 기본 가중 15%
});

t('작품별 점수가 사다리 진행을 그대로 비춘다', () => {
  const p = pack(2);
  const st = full(p);
  delete st['w-w2']; p.works[1].blanks.forEach((b) => { delete st['b-' + b.id]; });
  p.works[1].vocab.forEach((v) => { delete st['v-' + v.id]; });
  const rd = R.readiness(p, st, {});
  assert.strictEqual(rd.works[0].score, 100);
  assert.strictEqual(rd.works[1].score, 0);
  assert.strictEqual(rd.works[1].stage, 1);
  assert.strictEqual(rd.totals.untouched, 1);
});

t('반 그림은 요약만 보고 만든다 — state를 통째로 읽지 않는다', () => {
  const rows = [
    { code: 'a', name: '가', summary: { ready: { score: 90, weak: 'essay', grade: { key: 'ready' }, alert: null } } },
    { code: 'b', name: '나', summary: { ready: { score: 50, weak: 'blank', grade: { key: 'building' }, alert: { level: 'watch', why: 'x' } } } },
    { code: 'c', name: '다', summary: { ready: { score: 20, weak: 'blank', grade: { key: 'start' }, alert: { level: 'risk', why: 'y' } } } },
    { code: 'd', name: '라' }                                     // 아직 안 들어온 학생
  ];
  const c = R.classReadiness(rows);
  assert.strictEqual(c.n, 4);
  assert.strictEqual(c.linked, 3);
  assert.strictEqual(c.avg, 53);
  assert.strictEqual(c.median, 50);
  assert.strictEqual(c.low, 20);
  assert.strictEqual(c.high, 90);
  assert.deepStrictEqual(c.dist, { start: 1, building: 1, ontrack: 0, ready: 1 });
  assert.strictEqual(c.weakTop[0].key, 'blank');
  assert.strictEqual(c.weakTop[0].n, 2);
  assert.deepStrictEqual(c.risk.map((x) => x.code), ['c']);
  assert.deepStrictEqual(c.watch.map((x) => x.code), ['b']);
  assert.strictEqual(R.classReadiness([]).avg, null);
});

t('학생 화면과 강사 화면이 같은 문장을 쓴다', () => {
  const p = pack(1);
  const st = full(p); st['w-w1'].essayDone = false;
  const rd = R.readiness(p, st, {});
  assert.strictEqual(R.line(rd), '85% · 시험 준비 완료 · 다음: 서술형');
  assert.strictEqual(R.line(null), '기록 없음');
});

t('오답이 쌓이면 위험 항목으로 세고 신호를 낸다', () => {
  const p = pack(2);
  const st = full(p);
  st['b-w1-b1'].wrong = 4;
  st['b-w1-b2'].overconfident = 1;
  const rd = R.readiness(p, st, { wrongOpen: 12 });
  assert.strictEqual(rd.totals.risky, 2);
  assert.strictEqual(rd.totals.wrongOpen, 12);
  assert.strictEqual(rd.alert.level, 'watch');
  assert.ok(/오답이 12개/.test(rd.alert.why), rd.alert.why);
});

console.log(`\nOK — ${passed}개 통과. 준비도는 개수가 아니라 '무엇이 비었는가'를 말한다.`);
