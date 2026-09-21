'use strict';
/* 한자브레인 간격 반복 엔진 검증 (node hanja/srs.test.cjs) */
const assert = require('assert');
const S = require('./srs.js');

const DAY = S.DAY;
let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };
const at = (h) => new Date(2026, 8, 21, h, 0, 0).getTime();   // 2026-09-21 h시

t('id 규약 — 한자는 글자 하나로 공용, 낱말은 단어장에 매인다', () => {
  assert.strictEqual(S.charId('觀'), 'c:觀');
  assert.strictEqual(S.wordId('eohwi-1', 'w003'), 'w:eohwi-1:w003');
  assert.strictEqual(S.kindOf('c:觀'), 'char');
  assert.strictEqual(S.kindOf('w:eohwi-1:w003'), 'word');
});

t('심으면 첫 회상은 오늘 밤 9시, 9시 뒤에 심으면 10분 뒤', () => {
  const s = S.plant('c:觀', at(15));
  assert.strictEqual(s.due, at(21));
  assert.strictEqual(s.step, 0);
  const late = S.plant('c:觀', at(22));
  assert.strictEqual(late.due, at(22) + 600000);
});

t('good 이 이어지면 1→3→7→14→30→90일로 벌어지고 졸업한다', () => {
  let s = S.plant('w:b:w1', at(10));
  const gaps = [];
  let now = at(21);
  for (let i = 0; i < 6; i++) { S.review(s, 'good', now); gaps.push((s.due - now) / DAY); now = s.due; }
  assert.deepStrictEqual(gaps, [1, 3, 7, 14, 30, 90]);
  /* 30일 간격을 통과한 순간(step 6) 연속 3회를 채웠으면 졸업 — 워드브레인과 같은 판정 */
  assert.ok(s.graduated, 'step 6 + 연속 3회인데 졸업이 아니다');
  assert.strictEqual(S.stage(s), 6);
  assert.strictEqual(S.stageLabel(s), '장기 기억');
  /* 중간에 한 번 틀렸으면 30일 통과만으로는 졸업이 아니다 */
  let u = S.plant('w:b:w2', at(10));
  now = at(21);
  for (let i = 0; i < 4; i++) { S.review(u, 'good', now); now = u.due; }
  S.review(u, 'fail', now); now = u.due;          // step 4 → 2
  for (let i = 0; i < 4; i++) { S.review(u, 'good', now); now = u.due; }   // step 6, streak 4
  assert.ok(u.graduated, '실패 뒤에도 다시 연속 3회를 채우면 졸업이어야 한다');
  let v = S.plant('w:b:w3', at(10));
  now = at(21);
  for (let i = 0; i < 5; i++) { S.review(v, 'good', now); now = v.due; }
  S.review(v, 'hard', now); now = v.due;          // 계단 5 유지, 연속 0
  S.review(v, 'good', now);                        // step 6, streak 1
  assert.ok(!v.graduated, '연속 3회가 안 됐는데 졸업했다');
});

t('fail 은 두 계단 내려가 10분 뒤에 다시, hard 는 계단 유지 하루 뒤', () => {
  let s = S.plant('w:b:w1', at(10));
  s.step = 4; s.streak = 2;
  S.review(s, 'fail', at(12));
  assert.strictEqual(s.step, 2); assert.strictEqual(s.streak, 0); assert.strictEqual(s.lapses, 1);
  assert.strictEqual(s.due, at(12) + 600000);
  S.review(s, 'hard', at(13));
  assert.strictEqual(s.step, 2); assert.strictEqual(s.due, at(13) + DAY);
});

t('물 줄 목록은 가장 오래 방치된 것부터, 졸업·미도래는 뺀다', () => {
  const now = at(12);
  const states = {
    a: Object.assign(S.plant('w:b:a', now - 3 * DAY), { step: 1, due: now - 2 * DAY }),   // 1일 간격에 2일 방치 → 응급
    b: Object.assign(S.plant('w:b:b', now - 3 * DAY), { step: 3, due: now - DAY }),       // 7일 간격에 1일
    c: Object.assign(S.plant('w:b:c', now), { due: now + DAY }),
    d: Object.assign(S.plant('c:觀', now - 30 * DAY), { graduated: true, due: now - 10 * DAY }),
  };
  assert.deepStrictEqual(S.dueList(states, now).map((s) => s.id), ['w:b:a', 'w:b:b']);
  assert.strictEqual(S.urgency(states.a, now), 3);
  assert.strictEqual(S.urgency(states.b, now), 1);
  assert.strictEqual(S.urgency(states.d, now), 0);
  const sum = S.summary(states, now);
  assert.deepStrictEqual(sum, { total: 4, graduated: 1, due: 2, emergency: 1, seed: 2, growing: 1, words: 3, chars: 1 });
  /* 단어장별로 좁혀 본다 */
  assert.strictEqual(S.dueList(states, now, (s) => s.id.indexOf('w:b:') === 0).length, 2);
});

t('연속 학습일 — 어제에 이어 +1, 오늘 두 번은 그대로, 건너뛰면 1', () => {
  let st = S.bumpStreak(null, at(10));
  assert.strictEqual(st.count, 1);
  st = S.bumpStreak(st, at(15));
  assert.strictEqual(st.count, 1);
  st = S.bumpStreak(st, at(10) + DAY);
  assert.strictEqual(st.count, 2);
  st = S.bumpStreak(st, at(10) + 3 * DAY);
  assert.strictEqual(st.count, 1);
});

console.log(`\nOK — ${passed}개 통과`);
