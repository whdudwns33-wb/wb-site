'use strict';
/* 내신브레인 준비도 테스트 (node naesin/readiness.test.cjs)
 *
 * 이 모듈은 **파일럿 판정 도구**다. 틀린 숫자 하나가 "Phase 2 로 갈까" 를 뒤집는다.
 * 그래서 평범한 계산보다 아래 셋을 더 무겁게 고정한다:
 *   ① engine 과 상수가 어긋나지 않는가 (머리말 원칙 2 — 어긋나면 안정화 판정이 둘이 된다)
 *   ② 재료가 없는 축을 0점으로 깔지 않는가 (원칙 4 — 거짓 미달을 만들면 도구를 못 믿는다)
 *   ③ 모르는 것을 단정하지 않는가 (시작 시점을 모르면 파일럿 판정을 내지 않는다)
 */
const assert = require('assert');
const R = require('./readiness.js');
const ENGINE = require('./engine.js');

let fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { fail += 1; console.error('  ✗ ' + name + '\n     ' + e.message); }
};

/* 자체 창작 요약 — engine.rangeSummary 가 내는 모양 그대로 */
function summary(over) {
  return Object.assign({
    packIds: ['2022-ne-kimgitaek-m2-L6'],
    word: { total: 100, reached: 0, stable: 0, risky: 0, needsSpellCheck: 0 },
    sentence: { total: 60, interpreted: 0, memorized: 0, byStage: { 1: 60, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 } },
    passage: { chunkDone: 0, chunkTotal: 8, paraBlank: 0, paraTotal: 8, cumulative: 0, check: null },
    packs: {}
  }, over || {});
}

t('engine 과 상수가 같다 — 안정화 판정이 둘이 되면 안 된다', () => {
  assert.strictEqual(R.RELEARN_TARGET, ENGINE.RELEARN_TARGET,
    'engine.RELEARN_TARGET 이 바뀌었다 — readiness 의 값도 같이 고쳐야 안정화 판정이 하나로 남는다');
});

t('점수 축은 셋(합 1), 진단 축은 가중치 0 — 진단 축이 완성률을 흔들면 안 된다', () => {
  const score = R.AXES.filter((a) => !a.diagnostic);
  const diag = R.AXES.filter((a) => a.diagnostic);
  const sum = score.reduce((a, x) => a + x.w, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, '점수 축 가중치 합이 1 이 아니다: ' + sum);
  assert.deepStrictEqual(score.map((a) => a.key), ['word', 'interpret', 'memorize'],
    '점수 축이 바뀌었다 — naesin-results.mjs 의 복합 도달률 m 과 같은 세 축이어야 한다');
  assert.ok(diag.length, '진단 축이 사라졌다 — 본문 진행·점검·단어 도달을 볼 자리가 없어진다');
  diag.forEach((a) => {
    assert.strictEqual(a.w, 0, a.key + ' 는 진단 축인데 가중치가 남아 있다 — 완성률을 흔든다');
  });
  R.AXES.forEach((a) => {
    assert.ok(a.act && a.label && a.hint, a.key + ' 에 행동(act)·라벨·설명이 없다');
  });
});

t('내보낸 가중치가 축 가중치와 같다 — 화면이 둘 중 아무 쪽을 읽어도 같아야 한다', () => {
  const by = {};
  R.AXES.forEach((a) => { by[a.key] = a.w; });
  assert.strictEqual(R.W_STABLE, by.word, 'W_STABLE 과 word 축 가중치가 다르다');
  assert.strictEqual(R.W_INTERPRET, by.interpret, 'W_INTERPRET 과 interpret 축 가중치가 다르다');
  assert.strictEqual(R.W_BLANK, by.memorize, 'W_BLANK 과 memorize 축 가중치가 다르다');
});

t('아무것도 안 한 학생은 0%, 다 한 학생은 100%', () => {
  assert.strictEqual(R.readiness(summary()).score, 0);
  const done = summary({
    word: { total: 100, reached: 100, stable: 100, risky: 0, needsSpellCheck: 0 },
    sentence: { total: 60, interpreted: 60, memorized: 60, byStage: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 60 } },
    passage: { chunkDone: 8, chunkTotal: 8, paraBlank: 8, paraTotal: 8, cumulative: 8, check: { correct: 10, total: 10 } }
  });
  assert.strictEqual(R.readiness(done).score, 100);
});

t('단어 완성은 **안정화**다 — 도달만 채운 학생을 완성으로 세지 않는다', () => {
  /* reachOf(naesin-results.mjs)가 stable 을 보므로 이쪽도 stable 이어야 한다.
     도달(reached)을 섞으면 같은 화면의 「복합 도달률」과 숫자가 어긋난다.
     도달은 진행 상황이라 진단 축으로 따로 보여 주되 점수에 넣지 않는다. */
  const reachedOnly = summary({ word: { total: 100, reached: 100, stable: 0, risky: 0, needsSpellCheck: 0 } });
  const r = R.readiness(reachedOnly);
  const word = r.axes.find((a) => a.key === 'word');
  assert.strictEqual(word.ratio, 0, '도달만 채운 단어를 완성으로 셌다 — 안정화 비율이어야 한다');
  assert.strictEqual(r.score, 0, '도달만으로 완성률이 올라갔다');
  const reached = r.axes.find((a) => a.key === 'reached');
  assert.strictEqual(reached.ratio, 1, '도달 진단 축이 진행 상황을 보여 주지 않는다');
  assert.strictEqual(reached.weight, 0, '도달 축에 가중치가 붙어 완성률을 흔든다');
  /* 안정화를 채우면 그때 W_STABLE 몫만큼 오른다 */
  const stable = summary({ word: { total: 100, reached: 100, stable: 100, risky: 0, needsSpellCheck: 0 } });
  const rs = R.readiness(stable);
  assert.strictEqual(rs.axes.find((a) => a.key === 'word').ratio, 1);
  assert.strictEqual(rs.score, 40, '단어만 완성이면 W_STABLE 몫(40%)이어야 한다');
});

t('범위 합계(summary.range)가 있으면 그것으로 센다 — 팩 하나로 재면 범위의 일부만 센다', () => {
  /* 저장된 state.summary 는 팩 값과 범위 합계를 둘 다 담는다. reachOf·naesinNightDue 가
     `sum.range || sum` 으로 보므로 이쪽도 같아야 한다. 어긋나면 같은 화면의 두 숫자가
     **서로 다른 분량**을 두고 말한다. */
  const stored = {
    packId: '2022-ne-kimgitaek-m2-L6',
    /* 팩 하나(1과)는 다 했다 */
    word: { total: 40, reached: 40, stable: 40 },
    sentence: { total: 20, interpreted: 20, memorized: 20 },
    /* 범위(3과)로는 1/3 만 했다 */
    range: {
      packIds: ['a', 'b', 'c'],
      word: { total: 120, reached: 40, stable: 40 },
      sentence: { total: 60, interpreted: 20, memorized: 20 },
      passage: { chunkDone: 0, chunkTotal: 9, paraBlank: 0, paraTotal: 9, cumulative: 0, check: null }
    }
  };
  assert.strictEqual(R.readiness(stored).score, 33,
    '팩 값으로 재서 100% 가 나왔다 — 범위 합계(range)를 봐야 한다');
  /* 미착수 단어도 범위 기준이어야 한다 — 팩 값으로 보면 0 이 되어 미달을 놓친다 */
  assert.strictEqual(R.needDays(stored).untouched, 80, '미착수 단어를 범위 기준으로 세지 않았다');
  /* range 가 없는 옛 저장본·engine.rangeSummary() 반환값은 그대로 본다 */
  assert.strictEqual(R.src({ word: { total: 1 } }).word.total, 1);
});

t('재료가 없는 **점수 축**은 0점이 아니라 축에서 빠진다 — 거짓 미달 금지', () => {
  /* 문장이 없는 팩(sentence.total 0)에서 해석·백지를 0 으로 깔면 단어를 다 해도 40% 가 천장이다 */
  const noSentence = {
    packIds: ['x'], packs: {},
    word: { total: 100, reached: 100, stable: 100, risky: 0, needsSpellCheck: 0 },
    sentence: { total: 0, interpreted: 0, memorized: 0, byStage: {} },
    passage: { chunkDone: 8, chunkTotal: 8, paraBlank: 8, paraTotal: 8, cumulative: 8, check: null }
  };
  const r = R.readiness(noSentence);
  assert.strictEqual(r.score, 100,
    '문장이 없는 팩에서 단어를 다 한 학생이 100% 가 아니면 빠진 축을 0 으로 깔고 있다');
  ['interpret', 'memorize'].forEach((k) => {
    const a = r.axes.find((x) => x.key === k);
    assert.strictEqual(a.absent, true, k + ': 빠진 축임을 화면이 구분할 수 있어야 한다');
    assert.strictEqual(a.weight, 0, k + ': 빠진 축에 가중치가 남아 있다');
  });
  assert.strictEqual(r.axes.find((x) => x.key === 'word').weight, 1,
    '남은 점수 축 하나로 정규화해야 한다');
  /* 점검 문항이 없는 팩(check: null)도 거짓 미달을 만들지 않는다 — 진단 축이라 애초에 점수 밖이다 */
  const check = r.axes.find((x) => x.key === 'check');
  assert.strictEqual(check.absent, true, '없는 점검을 0% 로 그리면 거짓이다');
  assert.strictEqual(check.weight, 0);
});

t('문장도 본문도 재료가 없으면(팩이 단어만) 남은 축으로 정규화한다', () => {
  const wordsOnly = {
    packIds: ['x'], packs: {},
    word: { total: 50, reached: 50, stable: 50, risky: 0, needsSpellCheck: 0 },
    sentence: { total: 0, interpreted: 0, memorized: 0, byStage: {} },
    passage: { chunkDone: 0, chunkTotal: 0, paraBlank: 0, paraTotal: 0, cumulative: 0, check: null }
  };
  assert.strictEqual(R.readiness(wordsOnly).score, 100, '단어만 있는 팩에서 단어를 다 했으면 100% 다');
});

t('가장 낮은 축이 다음 할 일 — 빠진 축은 고르지 않는다', () => {
  const s = summary({
    word: { total: 100, reached: 100, stable: 100, risky: 0, needsSpellCheck: 0 },
    sentence: { total: 60, interpreted: 30, memorized: 0, byStage: {} },
    passage: { chunkDone: 8, chunkTotal: 8, paraBlank: 8, paraTotal: 8, cumulative: 8, check: null }
  });
  const w = R.readiness(s).weakest;
  assert.strictEqual(w.key, 'memorize', '가장 낮은 축은 백지 암송(0%)이다');
  assert.ok(w.act, '다음 할 일이 비어 있다');
});

t('전망은 예측이 아니라 제약 — 남은 날이 안정화에 못 미치면 확정된 미달이다', () => {
  const s = summary({ word: { total: 100, reached: 40, stable: 0, risky: 0, needsSpellCheck: 0 } });
  /* 미착수 60개는 서로 다른 날 3회가 필요하다 — D-2 면 물리적으로 불가능 */
  const tight = R.readiness(s, { dday: 2 });
  assert.ok(tight.shortfall, 'D-2 에 미착수가 남았으면 확정된 미달로 내보내야 한다');
  assert.strictEqual(tight.shortfall.minDays, 3);
  assert.strictEqual(tight.shortfall.untouched, 60);
  /* 여유가 있으면 미달이라고 하지 않는다 */
  assert.strictEqual(R.readiness(s, { dday: 10 }).shortfall, null);
  /* 남은 날을 모르면 단정하지 않는다 */
  assert.strictEqual(R.readiness(s).shortfall, null, 'dday 를 모르면 미달 판정을 하지 않는다');
});

t('반 집계의 머리 숫자는 임계 이상 **학생 비율** — 평균이 가리는 반쪽 파일럿을 통과시키지 않는다', () => {
  const hi = summary({
    word: { total: 100, reached: 100, stable: 100, risky: 0, needsSpellCheck: 0 },
    sentence: { total: 60, interpreted: 60, memorized: 60, byStage: {} },
    passage: { chunkDone: 8, chunkTotal: 8, paraBlank: 8, paraTotal: 8, cumulative: 8, check: null }
  });
  const lo = summary();
  /* 2명 100% + 2명 0% → 평균 50%, 임계 이상 비율 50% */
  const cls = R.classReadiness([
    { code: 'S1', name: '가학생', summary: hi }, { code: 'S2', name: '나학생', summary: hi },
    { code: 'S3', name: '다학생', summary: lo }, { code: 'S4', name: '라학생', summary: lo }
  ]);
  assert.strictEqual(cls.n, 4);
  assert.strictEqual(cls.threshold, 70);
  assert.strictEqual(cls.rate, 50, '임계 이상 학생 비율');
  assert.strictEqual(cls.reached, 2);
  assert.strictEqual(cls.average, 50, '평균도 함께 돌려준다(원장이 다른 읽기로 판정할 수 있게)');
  assert.strictEqual(cls.students[0].score, 0, '낮은 순 정렬 — 개입 순서다');
});

t('반이 비면 숫자를 0 으로 꾸미지 않고 null 로 둔다', () => {
  const cls = R.classReadiness([]);
  assert.strictEqual(cls.n, 0);
  assert.strictEqual(cls.rate, null);
  assert.strictEqual(cls.average, null);
  assert.strictEqual(cls.median, null);
});

t('파일럿 판정 — 시작 시점을 모르면 대상 여부도 합격도 단정하지 않는다', () => {
  const cls = R.classReadiness([{ code: 'S1', summary: summary() }]);
  const unknown = R.pilotVerdict(cls, null);
  assert.strictEqual(unknown.eligible, null, '시작 시점을 모르면 대상 여부를 모른다');
  assert.strictEqual(unknown.passed, null, '모르면 합격·불합격을 내지 않는다');
  /* 2주 전에 시작하지 않은 반은 판정 대상이 아니다 */
  assert.strictEqual(R.pilotVerdict(cls, 7).eligible, false);
  assert.strictEqual(R.pilotVerdict(cls, 7).passed, null, '대상이 아니면 합격 판정을 내지 않는다');
});

t('파일럿 판정 — 대상이고 숫자가 있으면 임계로 가른다', () => {
  const hi = summary({
    word: { total: 10, reached: 10, stable: 10, risky: 0, needsSpellCheck: 0 },
    sentence: { total: 10, interpreted: 10, memorized: 10, byStage: {} },
    passage: { chunkDone: 2, chunkTotal: 2, paraBlank: 2, paraTotal: 2, cumulative: 2, check: null }
  });
  const pass = R.pilotVerdict(R.classReadiness([{ code: 'A', summary: hi }]), 14);
  assert.strictEqual(pass.eligible, true);
  assert.strictEqual(pass.passed, true);
  const miss = R.pilotVerdict(R.classReadiness([{ code: 'B', summary: summary() }]), 20);
  assert.strictEqual(miss.passed, false);
});

t('학교 배점으로 가중치를 덮어쓸 수 있다 — 합이 1 이 아니어도 정규화한다', () => {
  const s = summary({
    word: { total: 10, reached: 10, stable: 10, risky: 0, needsSpellCheck: 0 },
    sentence: { total: 10, interpreted: 0, memorized: 0, byStage: {} },
    passage: { chunkDone: 0, chunkTotal: 2, paraBlank: 0, paraTotal: 2, cumulative: 0, check: null }
  });
  /* 단어만 다 한 학생: 기본 가중치에서는 W_STABLE 몫(40%), 단어 배점을 크게 주면 더 높아야 한다 */
  const base = R.readiness(s).score;
  assert.strictEqual(base, 40,
    '기본 가중치가 바뀌었다 — naesin-results.mjs 의 W_STABLE 과 같이 바꿨는지 확인한다');
  const heavy = R.readiness(s, { weights: { word: 0.9 } }).score;
  assert.ok(heavy > base, '가중치를 올렸는데 점수가 안 올랐다: ' + base + ' → ' + heavy);
});

t('망가진 입력에 던지지 않는다 — 관리 화면이 한 학생 때문에 비지 않게', () => {
  [null, undefined, {}, { word: null }, { word: { total: 'x' } }, 7, 'nope'].forEach((bad) => {
    const r = R.readiness(bad);
    assert.strictEqual(typeof r.score, 'number', '망가진 입력: ' + JSON.stringify(bad));
    assert.ok(r.score >= 0 && r.score <= 100);
  });
  assert.doesNotThrow(() => R.classReadiness([null, undefined, { code: 'S1' }]));
  assert.doesNotThrow(() => R.classReadiness(null));
  assert.strictEqual(R.line(null), '—');
});

t('한 줄 요약과 등급이 임계와 어긋나지 않는다', () => {
  assert.strictEqual(R.grade(70).key, 'ontrack', '임계값이 순조의 바닥이어야 한다');
  assert.strictEqual(R.grade(69).key, 'behind');
  assert.strictEqual(R.grade(85).key, 'ready');
  assert.ok(/^\d+% · /.test(R.line(R.readiness(summary()))));
});

if (fail) { console.error('\n실패 ' + fail + '건'); process.exit(1); }
console.log('OK — 축·가중·제약·반 집계·파일럿 판정, 그리고 모를 때 단정하지 않는 것까지 통과');
