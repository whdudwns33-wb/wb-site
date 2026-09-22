'use strict';
/* node letter/content.test.cjs — 검증기 형식 검사로는 잡히지 않는 실제 문항과 학년별 미션.
   달 주기: https://science.nasa.gov/moon/moon-phases/
   도서 확인: https://bir.co.kr/book/134014/ · https://www.changbi.com/BookDetail?bookid=2291 */
const assert = require('node:assert/strict');
const L = require('./letter.js');
const moon = require('./issues/2026-W40.json');
const hangul = require('./issues/2026-W41.json');

const section = (issue, id) => issue.sections.find((s) => s.id === id);
const items = section(hangul, 'brain-e3').items;
const syllables = [...items[1].grid.join('')].filter((c) => /[가-힣]/.test(c));
const withFinal = syllables.filter((c) => (c.charCodeAt(0) - 0xac00) % 28 !== 0);
const startsG = syllables.filter((c) => Math.floor((c.charCodeAt(0) - 0xac00) / 588) === 0);
assert.equal(parseInt(items[1].answer, 10), withFinal.length, '받침 정답이 실제 격자와 다름');
assert.equal(parseInt(items[3].answer, 10), startsG.length, 'ㄱ 첫소리 정답이 실제 격자와 다름');
assert.equal(withFinal.length, 14);
assert.equal(startsG.length, 3);

const moonRead = section(moon, 'read-e2');
assert.match(moonRead.paragraphs[2], /삭에서.*다음 삭.*29\.5일/);
assert.match(moonRead.questions[2].q, /^삭에서 다음 삭/);
assert.equal(moonRead.questions[2].choices[moonRead.questions[2].answer], '약 29.5일');

/* 제외한 항목 앞뒤의 체크 키가 밀리면 기존 가정 기록이 다른 미션의 기록으로 바뀐다. */
for (const [issue, expected] of [
  [moon, { K: [0, 1, 3], E1: [0, 1, 2, 3], E2: [0, 1, 2, 3, 4], E3: [0, 1, 2, 3, 4], M: [0, 1, 2, 3, 4] }],
  [hangul, { K: [0, 1, 2, 3, 5], E1: [0, 1, 2, 3, 4, 5], E2: [0, 1, 2, 3, 4, 5, 6], E3: [0, 1, 2, 3, 4, 5, 6], M: [0, 1, 2, 3, 4, 5, 6] }],
]) {
  const mission = section(issue, 'mission');
  const checks = Object.fromEntries(mission.items.map((_, i) => ['mission:' + i, true]));
  for (const tier of L.TIER_IDS) {
    const html = L.renderDay(issue, tier, 6, { state: { checks } });
    const keys = [...html.matchAll(/data-chk="mission:(\d+)"/g)].map((m) => Number(m[1]));
    assert.deepEqual(keys, expected[tier], issue.id + ' ' + tier + ' 미션 대상·기존 체크 키');
    assert.equal((html.match(/data-chk="mission:\d+" checked/g) || []).length, expected[tier].length);
    const n = expected[tier].length;
    assert.ok(L.renderDay(issue, tier, 7, { state: { checks } }).includes('<b>' + n + '</b>/' + n + '<span>마친 미션</span>'), issue.id + ' ' + tier + ' 미션 완료 집계');
  }
}
console.log('content: 문항 검산·달 주기·다섯 학년대 미션 및 기존 기록 키 통과');
