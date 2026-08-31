'use strict';
/* AI 하루 한도 검증 (node reading-server/ai-quota.test.mjs)
 *
 * 이 한도가 새면 요금이 샌다. 그리고 조용히 샌다 — 화면에는 아무 표시가 없다.
 */
import assert from 'node:assert';
import { dayKey, readLimits, todayUsage, reserve, usageSummary, QUOTA_DEFAULT } from './ai-quota.mjs';

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };

const K = (mo, d, h) => Date.UTC(2026, mo, d, h - 9);   // KST 시각
const T = K(7, 31, 15);                                  // 2026-08-31 15:00 KST

t('하루는 KST로 가른다', () => {
  assert.strictEqual(dayKey(K(7, 31, 15)), '2026-08-31');
  assert.strictEqual(dayKey(K(7, 31, 23)), '2026-08-31', '한국 밤 11시는 아직 그날이다');
  assert.strictEqual(dayKey(K(8, 1, 0)), '2026-09-01', '자정을 넘기면 다음 날');
});

t('환경변수가 없거나 이상하면 기본값을 쓴다', () => {
  assert.deepStrictEqual(readLimits({}), QUOTA_DEFAULT);
  assert.deepStrictEqual(readLimits(null), QUOTA_DEFAULT);
  /* 오타로 0이나 글자가 들어가도 기능이 통째로 죽으면 안 된다 */
  assert.strictEqual(readLimits({ AI_DAILY_TOTAL: '0' }).total, QUOTA_DEFAULT.total);
  assert.strictEqual(readLimits({ AI_DAILY_TOTAL: 'abc' }).total, QUOTA_DEFAULT.total);
  assert.strictEqual(readLimits({ AI_DAILY_TOTAL: '-5' }).total, QUOTA_DEFAULT.total);
  assert.strictEqual(readLimits({ AI_DAILY_TOTAL: '500' }).total, 500, '제대로 준 값은 쓴다');
  assert.strictEqual(readLimits({ AI_DAILY_PER_STUDENT: '12.7' }).perStudent, 12, '소수는 내림');
});

t('날짜가 바뀌면 저절로 0에서 시작한다', () => {
  const yesterday = { day: '2026-08-30', total: 199, by: { 'wb-101': 29 } };
  const u = todayUsage(yesterday, T);
  assert.strictEqual(u.total, 0);
  assert.deepStrictEqual(u.by, {}, '어제 것을 오늘로 끌고 오면 안 된다');
  assert.strictEqual(u.day, '2026-08-31');
});

t('자리를 잡으면 장부가 하나 올라간다', () => {
  const r = reserve(null, 'wb-101', T, { perStudent: 3, total: 10 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.usage.total, 1);
  assert.strictEqual(r.usage.by['wb-101'], 1);
  assert.strictEqual(r.left.student, 2);
  assert.strictEqual(r.left.total, 9);
});

t('학생 한도에 걸리면 그 학생만 막힌다', () => {
  const lim = { perStudent: 2, total: 10 };
  const rec = { day: '2026-08-31', total: 2, by: { 'wb-101': 2 } };
  const mine = reserve(rec, 'wb-101', T, lim);
  assert.strictEqual(mine.ok, false);
  assert.strictEqual(mine.reason, 'student');
  assert.strictEqual(mine.cap, 2);
  const other = reserve(rec, 'wb-102', T, lim);
  assert.strictEqual(other.ok, true, '다른 학생은 계속 쓸 수 있어야 한다');
});

t('전체 한도가 학생 한도보다 먼저다', () => {
  /* 전체가 찼으면 아직 안 쓴 학생도 막혀야 한다 — 그게 비용 상한이다 */
  const rec = { day: '2026-08-31', total: 10, by: { 'wb-101': 10 } };
  const r = reserve(rec, 'wb-999', T, { perStudent: 30, total: 10 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'total');
});

t('한도까지 정확히 쓰고 그다음에 막힌다', () => {
  const lim = { perStudent: 30, total: 3 };
  let rec = null, n = 0;
  for (let i = 0; i < 5; i++) {
    const r = reserve(rec, 'wb-101', T, lim);
    if (!r.ok) break;
    rec = r.usage; n += 1;
  }
  assert.strictEqual(n, 3, '3회 한도면 3번 되고 4번째부터 막힌다');
  assert.strictEqual(rec.total, 3);
});

t('관리 화면에 오늘 쓴 양과 많이 쓴 학생이 나온다', () => {
  const rec = { day: '2026-08-31', total: 14, by: { 'wb-101': 9, 'wb-102': 5 } };
  const s = usageSummary(rec, T, { perStudent: 30, total: 200 });
  assert.strictEqual(s.total, 14);
  assert.strictEqual(s.cap, 200);
  assert.strictEqual(s.perStudentCap, 30);
  assert.deepStrictEqual(s.students, [{ code: 'wb-101', n: 9 }, { code: 'wb-102', n: 5 }],
    '많이 쓴 순으로');
  /* 어제 장부를 넘겨도 오늘은 0이다 */
  assert.strictEqual(usageSummary({ day: '2026-08-30', total: 99, by: {} }, T).total, 0);
});

t('기본값은 파일럿 한 반이 쓰기에 넉넉하되 열려 있지 않다', () => {
  /* 대화 미션 한 판이 3~8회. 학생 하루 30회면 미션 서너 판 + 문장 짓기까지 된다.
     전체 200회는 8명 반이 하루에 다 몰려도 남는다. 무제한은 아니다. */
  assert.strictEqual(QUOTA_DEFAULT.perStudent, 30);
  assert.strictEqual(QUOTA_DEFAULT.total, 200);
  assert.ok(QUOTA_DEFAULT.total > QUOTA_DEFAULT.perStudent, '전체가 1인 한도보다 커야 의미가 있다');
});

console.log('\n통과 ' + passed + '개 — AI 하루 한도 검증 완료');
