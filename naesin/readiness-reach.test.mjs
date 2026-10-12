#!/usr/bin/env node
/* 완성률 ↔ 복합 도달률 교차 고정 (node naesin/readiness-reach.test.mjs)
 *
 * 같은 관리 화면에 두 숫자가 나란히 놓인다:
 *   · 「반 완성률 68%」  ← naesin/readiness.js (브라우저 IIFE)
 *   · 「복합 도달률 m 0.74」 ← reading-server/naesin-results.mjs (서버 ESM)
 * 둘은 **같은 세 축의 같은 가중 합**이다. 그런데 모듈 형식이 달라(IIFE vs ESM) 한쪽이
 * 다른 쪽을 import 할 수 없어 가중치를 복제해 두었다. 복제는 언젠가 어긋난다 —
 * 한쪽만 고친 날, 원장은 같은 반을 두고 서로 다른 말을 하는 두 숫자를 본다.
 *
 * 그래서 이 테스트가 **두 파일을 같이 불러** 값이 아니라 **결과**를 맞춰 본다.
 * 상수 비교만으로는 축을 바꿔 끼운 변경(단어를 stable 대신 reached 로 세는 것 같은)을
 * 못 잡는다. 그래서 같은 요약을 양쪽에 넣고 숫자가 같은지 본다.
 *
 * 일부러 다른 자리 하나도 함께 고정한다: **재료가 없는 축**이다. reachOf 는 분모 0 을
 * 0점으로 깔고(회귀 입력이라 구멍을 못 만든다), readiness 는 축에서 뺀다(원칙 4 —
 * 거짓 미달을 만들면 판정 도구를 못 믿는다). 의도된 차이이므로 테스트로 못 박아
 * 나중에 "버그네" 하고 한쪽을 고치지 않게 한다.
 */
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { reachOf } from '../reading-server/naesin-results.mjs';

const require = createRequire(import.meta.url);
const R = require('./readiness.js');

let fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { fail += 1; console.error('  ✗ ' + name + '\n     ' + e.message); }
};

/* 축 하나만 채운 요약 — reachOf 에 넣으면 그 축의 가중치가 그대로 m 으로 나온다 */
const only = (k) => ({
  word: { total: 10, reached: 10, stable: k === 'stable' ? 10 : 0 },
  sentence: { total: 10, interpreted: k === 'interpret' ? 10 : 0, memorized: k === 'blank' ? 10 : 0 },
});

t('가중치가 두 파일에서 같다 — 상수가 아니라 **결과**로 확인한다', () => {
  assert.strictEqual(reachOf(only('stable')).m, R.W_STABLE,
    '단어 안정화의 비중이 다르다 — naesin-results.mjs 의 W_STABLE 과 맞춰야 한다');
  assert.strictEqual(reachOf(only('interpret')).m, R.W_INTERPRET,
    '문장 해석의 비중이 다르다 — W_INTERPRET 과 맞춰야 한다');
  assert.strictEqual(reachOf(only('blank')).m, R.W_BLANK,
    '백지 암송의 비중이 다르다 — W_BLANK 과 맞춰야 한다');
});

t('같은 요약 → 같은 숫자. 축을 바꿔 끼우면 여기서 걸린다', () => {
  /* 세 분모가 모두 있는(=축이 다 사는) 요약들. 이 구간에서 두 모듈은 **정확히** 같아야 한다 */
  const cases = [
    { word: { total: 100, reached: 100, stable: 100 }, sentence: { total: 60, interpreted: 60, memorized: 60 } },
    { word: { total: 100, reached: 100, stable: 0 }, sentence: { total: 60, interpreted: 0, memorized: 0 } },
    { word: { total: 120, reached: 90, stable: 60 }, sentence: { total: 60, interpreted: 41, memorized: 12 } },
    { word: { total: 7, reached: 3, stable: 1 }, sentence: { total: 13, interpreted: 5, memorized: 2 } },
    /* 불량 요약(도달 수가 총수를 넘는다) — 양쪽 모두 1 로 눌러야 한다 */
    { word: { total: 10, reached: 99, stable: 99 }, sentence: { total: 10, interpreted: 99, memorized: 99 } },
  ];
  cases.forEach((sum, i) => {
    const mine = R.readiness(sum).score;
    const theirs = Math.round(reachOf(sum).m * 100);
    assert.strictEqual(mine, theirs,
      `#${i} 완성률 ${mine}% 와 복합 도달률 ${theirs}% 가 어긋난다 — 같은 화면에서 두 숫자가 다른 말을 한다`);
  });
});

t('범위 합계(range)를 보는 눈도 같다 — 한쪽만 팩 값을 보면 분량이 어긋난다', () => {
  const stored = {
    packId: '2022-ne-kimgitaek-m2-L6',
    word: { total: 40, reached: 40, stable: 40 },          // 팩 하나는 다 했다
    sentence: { total: 20, interpreted: 20, memorized: 20 },
    range: {                                                // 범위(3과)로는 1/3
      packIds: ['a', 'b', 'c'],
      word: { total: 120, reached: 40, stable: 40 },
      sentence: { total: 60, interpreted: 20, memorized: 20 },
    },
  };
  assert.strictEqual(R.readiness(stored).score, Math.round(reachOf(stored).m * 100),
    '한쪽은 범위(range), 한쪽은 팩 값을 보고 있다');
  assert.strictEqual(R.readiness(stored).score, 33, '범위 기준이면 1/3 이다');
});

t('재료가 없는 축의 처리는 **일부러** 다르다 — 그 차이를 못 박아 둔다', () => {
  /* 문장이 없는 팩: reachOf 는 해석·백지를 0 으로 깔아 m 0.4 를 내고(회귀 입력이라
     구멍을 만들지 않는다), readiness 는 두 축을 빼고 단어만으로 100% 를 낸다.
     화면이 이 둘을 나란히 쓰면 안 된다 — 완성률은 판정용, m 은 점수 상관용이다. */
  const noSentence = {
    word: { total: 100, reached: 100, stable: 100 },
    sentence: { total: 0, interpreted: 0, memorized: 0 },
  };
  assert.strictEqual(Math.round(reachOf(noSentence).m * 100), 40,
    'reachOf 가 빈 축을 0 으로 깔지 않게 바뀌었다 — 회귀 입력의 전제가 달라졌다');
  assert.strictEqual(R.readiness(noSentence).score, 100,
    'readiness 가 빈 축을 0 으로 깔기 시작했다 — 거짓 미달을 만든다(원칙 4)');
  const axes = R.readiness(noSentence).axes;
  assert.strictEqual(axes.find((a) => a.key === 'interpret').absent, true);
});

if (fail) { console.error('\n실패 ' + fail + '건'); process.exit(1); }
console.log('OK — 두 모듈의 가중치·축·범위 기준이 같고, 빈 축 처리의 차이는 의도대로 고정됐다');
