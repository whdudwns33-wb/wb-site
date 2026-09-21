'use strict';
/* 청크브레인 복습 일정 검증 — node chunk/sched.test.cjs */
const assert = require('assert');
const S = require('./sched.js');
let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };
const DAY = S.DAY;
const T0 = new Date(2026, 8, 21, 15, 0, 0).getTime();

t('빈 상태와 복원 — 빠진 칸은 채우고 이상한 값은 버린다', () => {
  const b = S.blank(T0);
  assert.strictEqual(b.band, null); assert.deepStrictEqual(b.items, {});
  const n = S.normalize({ v: 1, band: 'G3', items: { a: { id: 'a' } }, log: 'bad', prefs: { font: 'large' } }, T0);
  assert.strictEqual(n.band, 'G3'); assert.deepStrictEqual(n.log, []); assert.strictEqual(n.prefs.font, 'large'); assert.strictEqual(n.prefs.marker, 'auto');
  assert.strictEqual(S.normalize(null, T0).v, 1);
  assert.strictEqual(S.normalize({ band: 7 }, T0).band, null);
  const old = S.normalize({ band: 'E2', items: { a: { id: 'a', band: 'M' } }, log: [{ t: 1, id: 'a', band: 'H', score: 80 }] }, T0);
  assert.strictEqual(old.band, 'G3', '옛 초3~4 밴드는 초3 단계로');
  assert.strictEqual(old.items.a.band, 'G7'); assert.strictEqual(old.log[0].band, 'G10');
});

t('점수 등급 — 85 이상 good · 60~84 ok · 60 미만 weak', () => {
  assert.strictEqual(S.gradeOf(85), 'good'); assert.strictEqual(S.gradeOf(84), 'ok'); assert.strictEqual(S.gradeOf(60), 'ok'); assert.strictEqual(S.gradeOf(59), 'weak');
});

t('간격 사다리 — 잘하면 1→3→7→14→30일, 30일을 통과하면 졸업', () => {
  const s = S.blank(T0); let now = T0;
  const it = S.record(s, 'p1', { score: 90, qOk: true, band: 'E2' }, now);
  assert.strictEqual(it.step, 1); assert.strictEqual(it.due, now + 1 * DAY);
  now += DAY; S.record(s, 'p1', { score: 100 }, now); assert.strictEqual(it.due, now + 3 * DAY);
  now += 3 * DAY; S.record(s, 'p1', { score: 92 }, now); assert.strictEqual(it.due, now + 7 * DAY);
  now += 7 * DAY; S.record(s, 'p1', { score: 92 }, now); assert.strictEqual(it.due, now + 14 * DAY);
  now += 14 * DAY; S.record(s, 'p1', { score: 92 }, now); assert.strictEqual(it.due, now + 30 * DAY);
  assert.strictEqual(it.graduated, false);
  now += 30 * DAY; S.record(s, 'p1', { score: 92 }, now);
  assert.strictEqual(it.graduated, true); assert.strictEqual(it.due, 0); assert.strictEqual(it.n, 6); assert.strictEqual(it.best, 100);
  assert.strictEqual(s.updatedAt, now);
});

t('보통(60~84)은 제자리에서 한 칸 아래 간격, 못하면(60 미만) 처음으로 내일', () => {
  const s = S.blank(T0); let now = T0;
  S.record(s, 'p', { score: 90 }, now); now += DAY;
  S.record(s, 'p', { score: 90 }, now); now += 3 * DAY;        /* step 2, 7일 간격 예정 */
  const it = S.record(s, 'p', { score: 70 }, now);
  assert.strictEqual(it.step, 2); assert.strictEqual(it.due, now + 1 * DAY, '한 칸 아래(1일)');
  now += DAY; S.record(s, 'p', { score: 30 }, now);
  assert.strictEqual(it.step, 0); assert.strictEqual(it.due, now + DAY); assert.strictEqual(it.graduated, false);
  const first = S.record(S.blank(T0), 'q', { score: 70 }, T0);
  assert.strictEqual(first.step, 1); assert.strictEqual(first.due, T0 + DAY, '첫 시도가 보통이면 내일 다시');
  const sc = S.record(S.blank(T0), 'r', { score: 130 }, T0);
  assert.strictEqual(sc.lastScore, 100, '점수는 0~100 으로 자른다');
});

t('복습 목록·다음 글 고르기 — 밀린 복습 → 새 글 → 점수 낮은 글 → 다 졸업하면 없음', () => {
  const s = S.blank(T0); s.band = 'G3';
  const ids = ['a', 'b', 'c'];
  assert.deepStrictEqual(S.nextPassage(s, ids, T0, 'G3'), { id: 'a', why: 'new' });
  S.record(s, 'a', { score: 90, band: 'G3' }, T0);
  assert.deepStrictEqual(S.nextPassage(s, ids, T0, 'G3'), { id: 'b', why: 'new' });
  assert.strictEqual(S.dueList(s, T0, 'G3').length, 0);
  assert.strictEqual(S.dueList(s, T0 + DAY + 1, 'G3').length, 1, '하루 지나면 복습');
  assert.deepStrictEqual(S.nextPassage(s, ids, T0 + DAY + 1, 'G3'), { id: 'a', why: 'due' });
  S.record(s, 'b', { score: 40, band: 'G3' }, T0); S.record(s, 'c', { score: 70, band: 'G3' }, T0);
  /* 아직 아무것도 due 가 아닌 시각(같은 날)에서는 점수 낮은 글 */
  assert.deepStrictEqual(S.nextPassage(s, ids, T0 + 1, 'G3'), { id: 'b', why: 'weak' });
  /* 밀린 정도가 큰 순 — b(1일 간격)와 a(1일 간격)가 같이 밀리면 더 오래된 due 가 먼저 */
  const due = S.dueList(s, T0 + 2 * DAY, 'G3').map((x) => x.id);
  assert.strictEqual(due.length, 3); assert.strictEqual(due[0], 'a');
  const g = S.blank(T0); ['a', 'b', 'c'].forEach((id) => { const it = S.record(g, id, { score: 100, band: 'G3' }, T0); it.graduated = true; it.due = 0; });
  assert.strictEqual(S.nextPassage(g, ids, T0, 'G3'), null);
  assert.strictEqual(S.dueList(s, T0 + 2 * DAY, 'G12').length, 0, '다른 단계는 안 섞인다');
});

t('약한 규칙 — 최근 기록의 태그를 세어 2회 이상만', () => {
  const s = S.blank(T0);
  S.record(s, 'a', { score: 50, tags: ['extra:adn', 'miss:comma'] }, T0);
  S.record(s, 'b', { score: 60, tags: ['extra:adn'] }, T0);
  S.record(s, 'c', { score: 60, tags: ['extra:adn', 'miss:sent'] }, T0);
  assert.deepStrictEqual(S.weakTags(s, 3), [{ tag: 'extra:adn', n: 3 }]);
  S.record(s, 'd', { score: 60, tags: ['miss:comma'] }, T0);
  assert.deepStrictEqual(S.weakTags(s, 1), [{ tag: 'extra:adn', n: 3 }]);
  assert.strictEqual(S.weakTags(s, 3).length, 2);
});

t('단계 제안 — 같은 밴드 최근 연습 3회가 전부 85+ 이고 문제 2회 이상 정답이면 up, 전부 50 미만이면 down', () => {
  const s = S.blank(T0); s.band = 'G3';
  assert.strictEqual(S.suggestion(s, 'E2'), null);
  ['a', 'b', 'c'].forEach((id) => S.record(s, id, { score: 90, qOk: true, band: 'E2', mode: 'practice' }, T0));
  assert.strictEqual(S.suggestion(s, 'E2'), 'up');
  S.record(s, 'a', { score: 100, qOk: true, band: 'E2', mode: 'review' }, T0 + DAY);
  assert.strictEqual(S.suggestion(s, 'E2'), 'up', '복습 기록은 제안 계산에서 뺀다');
  ['d', 'e', 'f'].forEach((id) => S.record(s, id, { score: 30, qOk: false, band: 'E2', mode: 'practice' }, T0 + 2 * DAY));
  assert.strictEqual(S.suggestion(s, 'E2'), 'down');
  assert.strictEqual(S.suggestion(s, 'E3'), null);
});

t('연속 학습일·요약', () => {
  const s = S.blank(T0);
  assert.strictEqual(S.streak(s, T0), 0);
  S.record(s, 'a', { score: 80, qOk: true, wpm: 120, band: 'G3' }, T0 - 2 * DAY);
  S.record(s, 'b', { score: 90, qOk: false, wpm: 140, band: 'G3' }, T0 - DAY);
  assert.strictEqual(S.streak(s, T0), 2, '어제까지 이어졌으면 오늘 아직 안 해도 2');
  assert.strictEqual(S.streak(s, T0 + 2 * DAY), 0, '이틀 비면 끊긴다');
  S.record(s, 'c', { score: 100, qOk: true, band: 'G3' }, T0);
  const sm = S.summary(s, T0, 'G3');
  assert.strictEqual(sm.attempts, 3); assert.strictEqual(sm.practiced, 3); assert.strictEqual(sm.avg, 90); assert.strictEqual(sm.qRate, 67);
  assert.strictEqual(sm.wpmRecent, 130); assert.strictEqual(sm.streak, 3); assert.strictEqual(sm.due, 2, 'a·b 는 오늘 복습 차례');
  S.lessonDone(s, 'g3-1', T0, 100);
  assert.strictEqual(S.summary(s, T0).lessonsDone, 1);
  const ft = S.forTeacher(s, T0);
  assert.deepStrictEqual(Object.keys(ft).sort(), ['attempts', 'avg', 'band', 'graduated', 'lastAt', 'lessonsDone', 'practiced', 'qRate', 'recentAvg', 'streak', 'wpmRecent']);
});

t('기록은 400건까지만 — 오래된 것부터 버린다', () => {
  const s = S.blank(T0);
  for (let i = 0; i < 450; i++) S.record(s, 'p' + (i % 7), { score: 80 }, T0 + i * 1000);
  assert.strictEqual(s.log.length, 400);
  assert.strictEqual(s.log[0].t, T0 + 50 * 1000);
});

console.log('\n' + passed + '건 통과 — chunk/sched.js');
