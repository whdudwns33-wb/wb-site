const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('./perf-core.js');

/* 고정 달력: 2026-09-07(월) ~ 09-13(일). 오늘은 09-09(수). 지난주 월요일 08-31, 그 전 08-24. */
const MON = '2026-09-07', TODAY = '2026-09-09', SUN = '2026-09-13';
const ROSTER = { students: [
  { id: 'stu_a', name: '학생A', grade: '중1', start: '2026-03', end: '' },
  { id: 'stu_b', name: '학생B', grade: '중2', start: '2026-03', end: '' }
] };

function perfset(checks, id, progs) {
  checks[core.perfsetKey(id)] = { progs: progs || ['studyforce', 'classcard'], target: null, from: 'bulk' };
}
function stamp(checks, prog, ymd, ex) {
  checks[core.perfdayKey(prog, ymd)] = { stamp: { by: 's1', at: 1, basis: 'login_log' }, ex: ex || {} };
}
function ctxOf(checks, extra) {
  return Object.assign({ checks: checks, today: TODAY, students: ROSTER.students }, extra || {});
}
function fixture() {
  const checks = {};
  perfset(checks, 'stu_a');
  perfset(checks, 'stu_b');
  return checks;
}
/* from..to 사이 대상일(월~금)마다 stu_a를 미수행으로 찍는다 */
function notDoneRun(checks, prog, from, to, id) {
  for (let d = from; d <= to; d = core.addDays(d, 1)) {
    if (core.DEFAULT_DUE_DAYS.includes(core.dowOf(d))) {
      const ex = {};
      ex[id || 'stu_a'] = { st: 'not_completed', why: 'no_login' };
      stamp(checks, prog, d, ex);
    }
  }
}

/* ── 키 ── */

test('keys follow the checks prefix scheme and perfday is keyed by date scope', () => {
  assert.equal(core.perfsetKey('stu_a'), '__perfset__stu_a|all');
  assert.equal(core.perfsetTaskId('stu_a') + '|all', core.perfsetKey('stu_a'));
  assert.equal(core.perfdayKey('studyforce', TODAY), '__perfday__studyforce|' + TODAY);
  assert.equal(core.perfdayTaskId('classcard') + '|' + TODAY, core.perfdayKey('classcard', TODAY));
  assert.equal(core.actKey('s1', 'S1:studyforce:stu_a:' + TODAY), '__act__s1|S1:studyforce:stu_a:' + TODAY);
  assert.deepEqual(core.parseActKey('__act__s1|S1:studyforce:stu_a:' + TODAY), { staffId: 's1', actionId: 'S1:studyforce:stu_a:' + TODAY });
  assert.deepEqual(core.parsePerfdayKey('__perfday__classcard|' + TODAY), { prog: 'classcard', ymd: TODAY });
  assert.equal(core.parsePerfdayKey('__perfday__foo|' + TODAY), null);
});

test('isPerfKey covers perfset and perfday only — act rows stay staff-owned', () => {
  assert.equal(core.isPerfKey('__perfset__stu_a|all'), true);
  assert.equal(core.isPerfKey('__perfday__studyforce|' + TODAY), true);
  assert.equal(core.isPerfKey('__act__s1|S1:studyforce:stu_a:' + TODAY), false);
  assert.equal(core.isActKey('__act__s1|x'), true);
  ['__st__stu_a|' + TODAY, '__opset__학생A|all', '__op__학생A|' + MON, 'task1|' + TODAY].forEach(k => {
    assert.equal(core.isPerfKey(k), false, k);
    assert.equal(core.isActKey(k), false, k);
  });
  /* 통합 담당이 ownerOfCheck에 넣을 정규식과 같은 집합이어야 한다 */
  const re = /^__perf(set|day)__/;
  ['__perfset__stu_a|all', '__perfday__studyforce|' + TODAY, '__act__s1|x', '__st__x|y'].forEach(k => {
    assert.equal(re.test(k), core.isPerfKey(k), k);
  });
});

/* ── 날짜 (KST 달력 문자열 산술) ── */

test('date helpers are pure string arithmetic and Sunday belongs to the previous Monday', () => {
  assert.equal(core.addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(core.addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(core.dowOf(MON), 1);
  assert.equal(core.mondayOf(SUN), MON, '일요일은 지난 월요일 주에 붙는다');
  assert.equal(core.mondayOf(TODAY), MON);
  assert.equal(core.validYmd('2026-02-30'), false);
  assert.equal(core.diffDays(TODAY, MON), 2);
});

test('the injected mondayOf wins over the built-in week boundary', () => {
  const checks = fixture();
  /* 이번 주 월·화 미수행 → 기본 주 경계면 S6(2일). 주입된 경계가 오늘부터면 S6가 나오면 안 된다 */
  notDoneRun(checks, 'studyforce', MON, '2026-09-08');
  stamp(checks, 'studyforce', TODAY);
  const withDefault = core.signals(ctxOf(checks), TODAY).filter(s => s.rule === 'S6');
  assert.equal(withDefault.length, 1);
  assert.equal(withDefault[0].evidence.from, MON);
  const injected = core.signals(ctxOf(checks, { mondayOf: () => TODAY }), TODAY).filter(s => s.rule === 'S6');
  assert.equal(injected.length, 0);
});

/* ── dayState ── */

test('a day without a stamp is unknown for everyone', () => {
  const checks = fixture();
  const ctx = ctxOf(checks);
  assert.equal(core.dayState(ctx, 'stu_a', 'studyforce', TODAY), 'unknown');
  assert.equal(core.dayState(ctx, 'stu_b', 'studyforce', TODAY), 'unknown');
  /* 스탬프 없이 예외만 있는 행도 unknown — 안 봤는데 완료로 남는 게 가장 나쁜 오류다 */
  checks[core.perfdayKey('studyforce', TODAY)] = { ex: { stu_a: { st: 'not_completed' } } };
  assert.equal(core.dayState(ctx, 'stu_b', 'studyforce', TODAY), 'unknown');
  assert.equal(core.hasStamp(checks[core.perfdayKey('studyforce', TODAY)]), false);
});

test('stamp present and no exception means completed; exceptions carry their own state', () => {
  const checks = fixture();
  stamp(checks, 'studyforce', TODAY, { stu_b: { st: 'partial', why: 'review_pending' } });
  const ctx = ctxOf(checks);
  assert.equal(core.dayState(ctx, 'stu_a', 'studyforce', TODAY), 'completed');
  assert.equal(core.dayState(ctx, 'stu_b', 'studyforce', TODAY), 'partial');
  stamp(checks, 'classcard', TODAY, { stu_a: { st: 'unknown' }, stu_b: { st: 'not_completed', why: 'no_login' } });
  assert.equal(core.dayState(ctx, 'stu_a', 'classcard', TODAY), 'unknown');
  assert.equal(core.explicitUnknown(ctx, 'stu_a', 'classcard', TODAY), true);
  assert.equal(core.explicitUnknown(ctx, 'stu_a', 'studyforce', '2026-09-08'), false, '스탬프 없는 unknown은 명시가 아니다');
  assert.equal(core.dayState(ctx, 'stu_b', 'classcard', TODAY), 'not_completed');
  /* enum 밖의 상태는 unknown으로 떨어진다 */
  stamp(checks, 'classcard', '2026-09-08', { stu_a: { st: 'done' } });
  assert.equal(core.dayState(ctx, 'stu_a', 'classcard', '2026-09-08'), 'completed', 'enum 밖 예외는 버려지므로 예외 없음=completed');
});

test('weekend, non-due weekday, missing program and absence are not due days', () => {
  const checks = fixture();
  checks[core.perfsetKey('stu_b')] = { progs: ['classcard'], dueDays: { classcard: [2, 4] } };
  stamp(checks, 'studyforce', SUN);
  stamp(checks, 'classcard', MON);
  stamp(checks, 'classcard', '2026-09-08');
  checks['__st__stu_a|' + TODAY] = { att: 'A' };
  stamp(checks, 'studyforce', TODAY, { stu_a: { st: 'not_completed' } });
  const ctx = ctxOf(checks);
  assert.equal(core.dayState(ctx, 'stu_a', 'studyforce', SUN), 'not_due', '주말');
  assert.equal(core.dayState(ctx, 'stu_b', 'classcard', MON), 'not_due', '대상 요일 아님(화·목만)');
  assert.equal(core.dayState(ctx, 'stu_b', 'classcard', '2026-09-08'), 'completed');
  assert.equal(core.dayState(ctx, 'stu_b', 'studyforce', '2026-09-08'), 'not_due', '이용하지 않는 프로그램');
  assert.equal(core.dayState(ctx, 'stu_a', 'studyforce', TODAY), 'absent', '__st__ A는 예외보다 우선');
  /* 결석 출처는 주입할 수 있다 — task 앱의 결석은 수업 체크의 att에 있다 */
  const ctx2 = ctxOf(checks, { absentOn: (id, d) => id === 'stu_b' && d === '2026-09-08' });
  assert.equal(core.dayState(ctx2, 'stu_b', 'classcard', '2026-09-08'), 'absent');
  assert.equal(core.dayState(ctx2, 'stu_a', 'studyforce', TODAY), 'not_completed', '주입하면 __st__는 보지 않는다');
});

/* ── weekSummary ── */

test('weekly ratio is min(daysDone, target)/target and unknown days leave the denominator', () => {
  const checks = fixture();
  checks[core.perfsetKey('stu_a')] = { progs: ['studyforce'] };
  ['2026-09-07', '2026-09-08', '2026-09-09'].forEach(d => stamp(checks, 'studyforce', d));
  stamp(checks, 'studyforce', '2026-09-10', { stu_a: { st: 'not_completed' } });
  stamp(checks, 'studyforce', '2026-09-11');
  const full = core.weekSummary(ctxOf(checks, { today: SUN }), 'stu_a', MON);
  assert.equal(full.daysDone, 4);
  assert.equal(full.target, 5);
  assert.equal(full.ratio, 0.8);
  assert.equal(full.rawRatio, 0.8);
  assert.equal(full.unknown, 0);
  assert.equal(full.progs.studyforce.notDone, 1);

  delete checks[core.perfdayKey('studyforce', '2026-09-11')];
  const oneUnknown = core.weekSummary(ctxOf(checks, { today: SUN }), 'stu_a', MON);
  assert.equal(oneUnknown.unknown, 1);
  assert.equal(oneUnknown.daysDone, 3);
  assert.equal(oneUnknown.ratio, 0.75, '분모 5→4');
  assert.equal(oneUnknown.rawRatio, 0.6, '원식은 그대로');

  Object.keys(checks).filter(core.isPerfKey).filter(k => k.startsWith('__perfday__')).forEach(k => delete checks[k]);
  const allUnknown = core.weekSummary(ctxOf(checks, { today: SUN }), 'stu_a', MON);
  assert.equal(allUnknown.unknown, 5);
  assert.equal(allUnknown.ratio, null, '본 날이 없으면 비율이 없다');
  assert.equal(allUnknown.rawRatio, 0);
});

test('weekly summary treats future due days as pending and caps daysDone at target', () => {
  const checks = fixture();
  checks[core.perfsetKey('stu_a')] = { progs: ['studyforce'], target: { studyforce: 2 } };
  ['2026-09-07', '2026-09-08', '2026-09-09'].forEach(d => stamp(checks, 'studyforce', d));
  const mid = core.weekSummary(ctxOf(checks), 'stu_a', MON);
  assert.equal(mid.pending, 2, '목·금은 아직');
  assert.equal(mid.daysDone, 3);
  assert.equal(mid.target, 2);
  assert.equal(mid.ratio, 1);
  assert.equal(mid.rawRatio, 1, 'min(3,2)/2');
  assert.equal(mid.days.length, 7);
  assert.equal(mid.days[0], MON);
});

test('partial weight defaults to 0 and can be set per call', () => {
  const checks = fixture();
  checks[core.perfsetKey('stu_a')] = { progs: ['classcard'] };
  stamp(checks, 'classcard', MON, { stu_a: { st: 'partial', why: 'score_below_target' } });
  stamp(checks, 'classcard', '2026-09-08');
  const ctx = ctxOf(checks, { today: '2026-09-08' });
  assert.equal(core.weekSummary(ctx, 'stu_a', MON).daysDone, 1);
  assert.equal(core.weekSummary(ctx, 'stu_a', MON).partial, 1);
  assert.equal(core.weekSummary(ctx, 'stu_a', MON, { partialWeight: 0.5 }).daysDone, 1.5);
  assert.equal(core.weekSummary(ctx, 'stu_x', MON).target, 0, 'perfset 없는 학생은 빈 요약');
});

/* ── dueStreak ── */

test('due-day streak skips unknown, weekend and absence without breaking, and stops at completed', () => {
  const checks = fixture();
  notDoneRun(checks, 'studyforce', '2026-08-31', '2026-09-08');   // 월~금 + 월·화 = 7 대상일
  const ctx = ctxOf(checks, { today: '2026-09-08' });
  assert.equal(core.dueStreak(ctx, 'stu_a', 'studyforce', '2026-09-08'), 7);
  assert.equal(core.dueStreak(ctx, 'stu_b', 'studyforce', '2026-09-08'), 0, '예외에 없는 학생은 완료');
  const info = core.streakInfo(ctx, 'stu_a', 'studyforce', '2026-09-08');
  assert.deepEqual([info.from, info.to], ['2026-08-31', '2026-09-08']);

  delete checks[core.perfdayKey('studyforce', '2026-09-02')];   // 수요일 스탬프 없음
  assert.equal(core.dueStreak(ctx, 'stu_a', 'studyforce', '2026-09-08'), 6, 'unknown은 건너뛰고 끊지 않는다');

  checks['__st__stu_a|2026-09-03'] = { att: 'A' };
  assert.equal(core.dueStreak(ctx, 'stu_a', 'studyforce', '2026-09-08'), 5, '결석은 세지 않는다');

  stamp(checks, 'studyforce', '2026-09-01');   // 화요일 완료
  assert.equal(core.dueStreak(ctx, 'stu_a', 'studyforce', '2026-09-08'), 3, '완료에서 끊긴다: 9/4·9/7·9/8');

  /* 오늘이 unknown이어도 어제까지의 연속을 본다 */
  delete checks[core.perfdayKey('studyforce', '2026-09-08')];
  assert.equal(core.dueStreak(ctx, 'stu_a', 'studyforce', '2026-09-08'), 2);
});

test('streak lookback is bounded so a student with no records ever does not walk forever', () => {
  const checks = fixture();
  assert.equal(core.dueStreak(ctxOf(checks), 'stu_a', 'studyforce', TODAY), 0);
  assert.ok(core.LOOKBACK_DAYS >= core.STREAK_P0 * 2);
});

/* ── 신호 규칙 ── */

test('S1 grades the streak: 7→P0, 3→P1, 1→P2', () => {
  const checks = fixture();
  checks[core.perfsetKey('stu_a')] = { progs: ['studyforce'] };
  checks[core.perfsetKey('stu_b')] = { progs: ['studyforce'] };
  notDoneRun(checks, 'studyforce', '2026-08-31', TODAY, 'stu_a');   // 8 대상일
  /* stu_b는 9/7·9/8·9/9 3일 — 같은 스탬프 행에 예외만 추가 */
  ['2026-09-07', '2026-09-08', '2026-09-09'].forEach(d => {
    checks[core.perfdayKey('studyforce', d)].ex.stu_b = { st: 'not_completed', why: 'no_login' };
  });
  const s1 = core.signals(ctxOf(checks), TODAY).filter(s => s.rule === 'S1');
  const a = s1.find(s => s.studentId === 'stu_a'), b = s1.find(s => s.studentId === 'stu_b');
  assert.equal(a.priority, 'P0');
  assert.equal(a.evidence.dueStreak, 8);
  assert.equal(b.priority, 'P1');
  assert.equal(b.evidence.dueStreak, 3);
  assert.equal(s1[0].studentId, 'stu_a', 'P0가 앞에 온다');

  const one = fixture();
  one[core.perfsetKey('stu_a')] = { progs: ['classcard'] };
  one[core.perfsetKey('stu_b')] = { progs: [] };
  stamp(one, 'classcard', TODAY, { stu_a: { st: 'not_completed', why: 'other' } });
  const p2 = core.signals(ctxOf(one), TODAY);
  assert.equal(p2.length, 1);
  assert.equal(p2[0].priority, 'P2');
  assert.equal(core.planActions(p2, [], { staffId: 's1', ymd: TODAY, now: 5 }).length, 0, 'P2는 색만');
});

test('S3 fires only on two consecutive explicit unknown due days', () => {
  const checks = fixture();
  checks[core.perfsetKey('stu_a')] = { progs: ['studyforce'] };
  checks[core.perfsetKey('stu_b')] = { progs: [] };
  stamp(checks, 'studyforce', '2026-09-08', { stu_a: { st: 'unknown' } });
  stamp(checks, 'studyforce', TODAY, { stu_a: { st: 'unknown' } });
  const hit = core.signals(ctxOf(checks), TODAY).filter(s => s.rule === 'S3');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].priority, 'P2');
  assert.deepEqual([hit[0].evidence.from, hit[0].evidence.to], ['2026-09-08', TODAY]);

  delete checks[core.perfdayKey('studyforce', TODAY)];   // 오늘 스탬프 없음 → 명시가 아니다
  assert.equal(core.signals(ctxOf(checks), TODAY).filter(s => s.rule === 'S3').length, 0);

  stamp(checks, 'studyforce', TODAY, { stu_a: { st: 'unknown' } });
  stamp(checks, 'studyforce', '2026-09-08', { stu_a: { st: 'not_completed' } });
  assert.equal(core.signals(ctxOf(checks), TODAY).filter(s => s.rule === 'S3').length, 0, '하루만 unknown');
  /* 주말을 건너뛴 금·월도 "연속"이다 */
  const wk = fixture();
  wk[core.perfsetKey('stu_a')] = { progs: ['studyforce'] };
  wk[core.perfsetKey('stu_b')] = { progs: [] };
  stamp(wk, 'studyforce', '2026-09-04', { stu_a: { st: 'unknown' } });
  stamp(wk, 'studyforce', MON, { stu_a: { st: 'unknown' } });
  assert.equal(core.signals(ctxOf(wk, { today: MON }), MON).filter(s => s.rule === 'S3').length, 1);
});

test('S2 flags a new student with zero completion in the first five due days after the account item', () => {
  const checks = fixture();
  checks[core.perfsetKey('stu_a')] = { progs: ['classcard'] };
  checks[core.perfsetKey('stu_b')] = { progs: [] };
  notDoneRun(checks, 'classcard', '2026-08-31', '2026-09-04');
  const acct = { onboardingAccountDate: id => (id === 'stu_a' ? '2026-08-28' : null) };
  const at904 = core.signals(ctxOf(checks, Object.assign({ today: '2026-09-04' }, acct)), '2026-09-04');
  const s2 = at904.filter(s => s.rule === 'S2');
  assert.equal(s2.length, 1);
  assert.equal(s2[0].priority, 'P0');
  assert.deepEqual([s2[0].evidence.from, s2[0].evidence.to], ['2026-08-31', '2026-09-04']);
  assert.equal(core.signals(ctxOf(checks, Object.assign({ today: '2026-09-03' }, acct)), '2026-09-03').filter(s => s.rule === 'S2').length, 0, '대상일 4일뿐');
  assert.equal(core.signals(ctxOf(checks, { today: '2026-09-04' }), '2026-09-04').filter(s => s.rule === 'S2').length, 0, '계정 항목 없음');
  assert.equal(core.signals(ctxOf(checks, Object.assign({ today: '2026-09-14' }, acct)), '2026-09-14').filter(s => s.rule === 'S2').length, 0, '창 종료 후 1주가 지나면 S1에 맡긴다');

  stamp(checks, 'classcard', '2026-09-02');   // 하루라도 완료면 미시작이 아니다
  assert.equal(core.signals(ctxOf(checks, Object.assign({ today: '2026-09-04' }, acct)), '2026-09-04').filter(s => s.rule === 'S2').length, 0);

  const blank = fixture();
  blank[core.perfsetKey('stu_a')] = { progs: ['classcard'] };
  blank[core.perfsetKey('stu_b')] = { progs: [] };
  assert.equal(core.signals(ctxOf(blank, Object.assign({ today: '2026-09-04' }, acct)), '2026-09-04').filter(s => s.rule === 'S2').length, 0, '전부 unknown이면 근거 없음');

  const acts = core.planActions(s2, [], { staffId: 's1', ymd: '2026-09-04', now: 10 });
  assert.deepEqual(acts.map(a => a.type), ['assign', 'contact']);
  assert.equal(acts[0].actionId, 'S2:classcard:stu_a:2026-09-04');
  assert.equal(acts[1].actionId, 'S2:classcard:stu_a:2026-09-04:contact');
});

test('S4 turns a no_assignment exception into a P1 assign action', () => {
  const checks = fixture();
  checks[core.perfsetKey('stu_b')] = { progs: [] };
  stamp(checks, 'studyforce', TODAY, { stu_a: { st: 'not_completed', why: 'no_assignment' } });
  const s4 = core.signals(ctxOf(checks), TODAY).filter(s => s.rule === 'S4');
  assert.equal(s4.length, 1);
  assert.equal(s4[0].priority, 'P1');
  assert.equal(s4[0].evidence.why, 'no_assignment');
  const acts = core.planActions(s4, [], { staffId: 's1', ymd: TODAY, now: 10 });
  assert.equal(acts[0].type, 'assign');
  assert.equal(acts[0].actionId, 'S4:studyforce:stu_a:' + TODAY);
});

test('S6 counts not_completed days in the current week and is issued once per week', () => {
  const checks = fixture();
  checks[core.perfsetKey('stu_b')] = { progs: [] };
  notDoneRun(checks, 'classcard', MON, TODAY);
  const s6 = core.signals(ctxOf(checks), TODAY).filter(s => s.rule === 'S6');
  assert.equal(s6.length, 1);
  assert.equal(s6[0].evidence.count, 3);
  const first = core.planActions(s6, [], { staffId: 's1', ymd: TODAY, now: 10, weekStart: MON });
  assert.equal(first[0].type, 'teacher_note');
  const done = core.transitionAction(first[0], 'done', { by: 's1', at: 20 });
  const again = core.planActions(s6, [done], { staffId: 's1', ymd: '2026-09-10', now: 30, weekStart: MON });
  assert.equal(again.length, 0, '이번 주 이미 냈으면(종결됐어도) 다시 내지 않는다');
  const nextWeek = core.planActions(s6, [done], { staffId: 's1', ymd: '2026-09-14', now: 30, weekStart: '2026-09-14' });
  assert.equal(nextWeek.length, 1);
});

test('stub rules S5/S7/S8 are listed but never emitted', () => {
  const ids = core.RULES.map(r => r.id);
  assert.deepEqual(ids, ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']);
  assert.deepEqual(core.RULES.filter(r => !r.impl).map(r => r.id), ['S5', 'S7', 'S8']);
  const checks = fixture();
  notDoneRun(checks, 'studyforce', '2026-08-24', TODAY);
  const rules = new Set(core.signals(ctxOf(checks), TODAY).map(s => s.rule));
  ['S5', 'S7', 'S8'].forEach(r => assert.equal(rules.has(r), false, r));
});

/* ── planActions ── */

test('actions carry the fixed actionId, a nameless script and an open history entry', () => {
  const checks = fixture();
  checks[core.perfsetKey('stu_b')] = { progs: [] };
  notDoneRun(checks, 'studyforce', '2026-08-31', TODAY);
  const sigs = core.signals(ctxOf(checks), TODAY).filter(s => s.rule === 'S1');
  const rows = core.planActions(sigs, [], { staffId: 's1', ymd: TODAY, now: 1000 });
  assert.equal(rows.length, 1);
  const a = rows[0];
  assert.equal(a.actionId, 'S1:studyforce:stu_a:' + TODAY);
  assert.deepEqual(core.parseActionId(a.actionId), { rule: 'S1', prog: 'studyforce', studentId: 'stu_a', openedDate: TODAY, sub: '' });
  assert.equal(a.type, 'contact');
  assert.equal(a.priority, 'P0');
  assert.equal(a.st, 'open');
  assert.equal(a.openedAt, 1000);
  assert.equal(a.openedDate, TODAY);
  assert.equal(a.staffId, 's1');
  assert.deepEqual(a.hist, [{ st: 'open', at: 1000, by: 's1', result: '' }]);
  assert.ok(a.note.includes('스터디포스'));
  assert.ok(!a.note.includes('학생A'), '문구에 이름이 없다');
  assert.equal(core.planActions(sigs, [], { staffId: 's1', now: 1 }).length, 0, 'ymd 없으면 아무것도 만들지 않는다');
});

test('an existing open action of equal or higher priority suppresses a duplicate, escalation passes', () => {
  const p1 = { rule: 'S1', priority: 'P1', studentId: 'stu_a', prog: 'studyforce', evidence: { prog: 'studyforce', dueStreak: 3 } };
  const p0 = Object.assign({}, p1, { priority: 'P0', evidence: { prog: 'studyforce', dueStreak: 7 } });
  const first = core.planActions([p1], [], { staffId: 's1', ymd: '2026-09-08', now: 1 });
  assert.equal(first.length, 1);
  assert.equal(core.planActions([p1], first, { staffId: 's1', ymd: TODAY, now: 2 }).length, 0, '같은 등급 열림');
  const esc = core.planActions([p0], first, { staffId: 's1', ymd: TODAY, now: 2 });
  assert.equal(esc.length, 1, 'P1 열린 채 P0로 상승');
  assert.equal(esc[0].priority, 'P0');
  const closed = core.transitionAction(first[0], 'done', { by: 's1', at: 3 });
  assert.equal(core.planActions([p1], [closed], { staffId: 's1', ymd: TODAY, now: 4 }).length, 1, '종결됐으면 다시 낸다(재발)');
  assert.equal(core.planActions([p1], first, { staffId: 's1', ymd: '2026-09-08', now: 5 }).length, 0, '같은 actionId는 건너뛴다');
});

test('the daily cap keeps the highest priorities and cuts the rest', () => {
  const sigs = [];
  for (let i = 0; i < 15; i++) {
    sigs.push({ rule: 'S1', priority: 'P1', studentId: 'stu_' + String(i).padStart(2, '0'), prog: 'studyforce', evidence: { prog: 'studyforce', dueStreak: 3 } });
  }
  sigs.push({ rule: 'S1', priority: 'P0', studentId: 'stu_zz', prog: 'classcard', evidence: { prog: 'classcard', dueStreak: 7 } });
  sigs.push({ rule: 'S4', priority: 'P1', studentId: 'stu_zz', prog: 'classcard', evidence: { prog: 'classcard', why: 'no_assignment' } });
  const rows = core.planActions(sigs, [], { staffId: 's1', ymd: TODAY, now: 1 });
  assert.equal(rows.length, core.DEFAULT_CAP);
  assert.equal(rows[0].priority, 'P0');
  assert.equal(rows[0].studentId, 'stu_zz');
  assert.equal(rows.filter(r => r.priority === 'P0').length, 1);
  assert.equal(core.planActions(sigs, [], { staffId: 's1', ymd: TODAY, now: 1, cap: 3 }).length, 3);
  /* 같은 학생·프로그램·유형은 배치 안에서 한 번만 */
  const dup = [
    { rule: 'S1', priority: 'P0', studentId: 'stu_a', prog: 'studyforce', evidence: { prog: 'studyforce', dueStreak: 7 } },
    { rule: 'S2', priority: 'P0', studentId: 'stu_a', prog: 'studyforce', evidence: { prog: 'studyforce', dueStreak: 5 } }
  ];
  const types = core.planActions(dup, [], { staffId: 's1', ymd: TODAY, now: 1 }).map(a => a.rule + '/' + a.type);
  assert.deepEqual(types, ['S1/contact', 'S2/assign']);
});

/* ── mergeAction · transitionAction ── */

test('merging the same actionId keeps the earliest openedAt and the union of history', () => {
  const base = { actionId: 'S1:studyforce:stu_a:' + TODAY, studentId: 'stu_a', type: 'contact', rule: 'S1', priority: 'P0',
    evidence: { prog: 'studyforce', dueStreak: 7 }, st: 'open', openedAt: 2000, openedDate: TODAY,
    hist: [{ st: 'open', at: 2000, by: 'tablet2' }] };
  const other = Object.assign({}, base, { openedAt: 1500, hist: [{ st: 'open', at: 1500, by: 'tablet1' }] });
  const m = core.mergeAction(base, other);
  assert.equal(m.openedAt, 1500);
  assert.deepEqual(m.hist.map(h => h.at), [1500, 2000]);
  assert.equal(m.st, 'open');
  const closed = core.transitionAction(other, 'done', { by: 'tablet1', at: 3000, result: 'reached' });
  const m2 = core.mergeAction(base, closed);
  assert.equal(m2.st, 'done', '더 늦은 이력을 가진 쪽의 상태');
  assert.equal(m2.result, 'reached');
  assert.equal(m2.closedAt, 3000);
  assert.equal(m2.openedAt, 1500);
  assert.equal(core.mergeAction(base, closed).hist.length, 3);
  assert.equal(core.mergeAction(null, base).actionId, base.actionId);
  assert.equal(core.mergeAction(base, null).openedAt, 2000);
});

test('transitions respect the closed enums and keep an unanswered call open', () => {
  const a = core.planActions([{ rule: 'S1', priority: 'P1', studentId: 'stu_a', prog: 'classcard', evidence: { prog: 'classcard', dueStreak: 3 } }],
    [], { staffId: 's1', ymd: TODAY, now: 1 })[0];
  const noAnswer = core.transitionAction(a, 'done', { by: 's1', at: 2, result: 'no_answer' });
  assert.equal(noAnswer.st, 'open', '부재중은 열어둔 채 이월');
  assert.equal(noAnswer.result, 'no_answer');
  assert.equal(noAnswer.closedAt, null);
  const reached = core.transitionAction(noAnswer, 'done', { by: 's1', at: 3, result: 'reached', ctRef: 'ct_1' });
  assert.equal(reached.st, 'done');
  assert.equal(reached.closedAt, 3);
  assert.equal(reached.ctRef, 'ct_1');
  assert.equal(reached.hist.length, 3);
  const blocked = core.transitionAction(a, 'blocked', { by: 's1', at: 4 });
  assert.equal(blocked.st, 'blocked');
  assert.equal(blocked.closedAt, null, '막힘은 종결이 아니다');
  const bad = core.transitionAction(a, 'lost', { by: 's1', at: 5, result: 'match' });
  assert.equal(bad.st, 'open', 'enum 밖 상태는 무시');
  assert.equal(bad.result, null, 'contact에 audit 결과는 들어가지 않는다');
});

/* ── kpi ── */

test('kpi counts states, flags P0 open over 24h, medians close time and measures unknown cells', () => {
  const checks = fixture();
  checks[core.perfsetKey('stu_a')] = { progs: ['studyforce'] };
  checks[core.perfsetKey('stu_b')] = { progs: ['studyforce'] };
  stamp(checks, 'studyforce', MON);   // 9/8·9/9는 스탬프 없음
  const H = 3600000;
  const mk = (id, priority, st, openedAt, closedAt, staffId) => ({
    actionId: 'S1:studyforce:' + id + ':' + TODAY, studentId: id, type: 'contact', rule: 'S1', priority: priority,
    evidence: { prog: 'studyforce', dueStreak: 7 }, st: st, openedAt: openedAt, closedAt: closedAt, openedDate: TODAY, staffId: staffId || 's1'
  });
  const now = 100 * H;
  const actions = [
    mk('stu_a', 'P0', 'open', now - 30 * H, null),
    mk('stu_b', 'P0', 'open', now - 2 * H, null),
    mk('stu_c', 'P0', 'done', now - 10 * H, now - 8 * H),
    mk('stu_d', 'P0', 'done', now - 10 * H, now - 4 * H),
    mk('stu_e', 'P1', 'blocked', now - 5 * H, null, 's2'),
    mk('stu_f', 'P1', 'skipped', now - 5 * H, now - 4 * H, 's2'),
    Object.assign(mk('stu_g', 'P1', 'done', now - 9 * H, now - 8 * H), { openedDate: '2026-08-01' })   // 범위 밖
  ];
  const k = core.kpi(actions, ctxOf(checks, { now: now }), { from: MON, to: TODAY });
  assert.equal(k.open, 2);
  assert.equal(k.done, 2);
  assert.equal(k.blocked, 1);
  assert.equal(k.skipped, 1);
  assert.equal(k.p0Over24h.length, 1);
  assert.equal(k.p0Over24h[0].studentId, 'stu_a');
  assert.equal(k.medianCloseMs.P0, 4 * H);
  assert.equal(k.medianCloseMs.P1, null);
  assert.equal(k.dueCells, 6, '학생 2 × 월~수');
  assert.equal(k.unknownCells, 4);
  assert.equal(k.unknownRatio, 4 / 6);
  assert.deepEqual(k.byStaff.s2, { open: 0, done: 0, blocked: 1, skipped: 1 });
  assert.equal(core.kpi(actions, ctxOf(checks, { now: now })).done, 3, '범위 없으면 전부');
  assert.equal(core.median([]), null);
  assert.equal(core.median([1, 5, 3]), 3);
  assert.equal(core.median([1, 2, 3, 4]), 2.5);
});

/* ── 학생 해석·레거시 ── */

test('resolveStudent matches by id or name and refuses to pick between namesakes', () => {
  const roster = { students: ROSTER.students.concat([{ id: 'stu_c', name: '학생A', grade: '고1' }]) };
  assert.deepEqual(core.resolveStudent(roster, 'stu_b'), { id: 'stu_b', name: '학생B', grade: '중2' });
  assert.deepEqual(core.resolveStudent(roster, ' 학생B '), { id: 'stu_b', name: '학생B', grade: '중2' });
  assert.equal(core.resolveStudent(roster, '학생C'), null);
  assert.equal(core.resolveStudent(roster, ''), null);
  const amb = core.resolveStudent(roster, '학생A');
  assert.equal(amb.ambiguous, true);
  assert.deepEqual(amb.candidates.map(c => c.id), ['stu_a', 'stu_c']);
  assert.deepEqual(core.resolveStudent(ROSTER.students, '학생A'), { id: 'stu_a', name: '학생A', grade: '중1' }, '배열도 받는다');
});

test('legacy __opset__ rows become perfset drafts keyed by stable id, read-only', () => {
  const checks = {
    '__opset__학생A|all': { progs: ['스터디포스'], done: true },
    '__opset__학생B|all': { progs: ['클래스카드', '스터디포스', '엉뚱한것'] },
    '__opset__학생C|all': { progs: [] },
    ['__op__학생A|' + MON]: { cnt: { '스터디포스': 3 } }
  };
  const a = core.legacyPerfset(checks, ROSTER, '학생A');
  assert.deepEqual(a.perfset, { progs: ['studyforce'], dueDays: { studyforce: [1, 2, 3, 4, 5] }, target: null, from: 'legacy' });
  assert.equal(a.resolved.id, 'stu_a');
  assert.equal(core.legacyPerfset(checks, ROSTER, '학생C'), null, '프로그램 없으면 옮길 것이 없다');
  assert.equal(core.legacyPerfset(checks, ROSTER, '학생D'), null);
  const all = core.legacyPerfsets(checks, ROSTER);
  assert.deepEqual(all.map(x => x.name).sort(), ['학생A', '학생B']);
  assert.deepEqual(all.find(x => x.name === '학생B').perfset.progs, ['classcard', 'studyforce']);
  assert.equal(checks['__perfset__stu_a|all'], undefined, '레거시 읽기는 새 키를 쓰지 않는다');
});

test('examTrendOf reads legacy __exam__ rows the way examTrend/examRisk do', () => {
  const checks = {
    '__exam__학생A|2026-03-01': { items: [{ kind: '넬트', lv: 3 }, { kind: '메타수학', lv: 2 }] },
    '__exam__학생A|2026-06-01': { items: [{ kind: '넬트', lv: 3 }] },
    '__exam__학생A|2026-09-01': { items: [{ kind: '넬트', lv: 3, label: 'L3' }, { kind: '메타수학', lv: 3 }] }
  };
  const t = core.examTrendOf(checks, '학생A', TODAY);
  assert.equal(t.nelt.trend, 'flat');
  assert.equal(t.nelt.risk, 'stall', '3회 연속 같은 단계');
  assert.equal(t.nelt.last, '2026-09-01');
  assert.equal(t.nelt.daysSince, 8);
  assert.equal(t.nelt.label, 'L3');
  assert.equal(t.metamath.trend, 'up');
  assert.equal(t.metamath.risk, null, '2회차로는 판정하지 않는다');
  checks['__exam__학생A|2026-09-05'] = { items: [{ kind: '넬트', lv: 2 }] };
  assert.equal(core.examTrendOf(checks, '학생A', TODAY).nelt.risk, 'down');
  const none = core.examTrendOf(checks, '학생B', TODAY);
  assert.equal(none.nelt.count, 0);
  assert.equal(none.nelt.trend, null);
  assert.equal(none.nelt.daysSince, null);
});

/* ── 문구·정규화 ── */

test('scripts are constant text without a student name and every type has one', () => {
  ['contact', 'assign', 'teacher_note', 'nelt_notice', 'audit'].forEach(type => {
    const s = core.scriptFor(type, { prog: 'classcard', dueStreak: 7, count: 2 });
    assert.equal(typeof s, 'string');
    assert.ok(s.length > 5, type);
    assert.ok(!/학생[A-Z]|\{name\}/.test(s), type);
  });
  assert.ok(core.scriptFor('contact', { prog: 'classcard', dueStreak: 7 }).includes('클래스카드'));
  assert.ok(core.scriptFor('contact', { prog: 'classcard', dueStreak: 7 }).includes('전화'));
  assert.ok(core.scriptFor('contact', { prog: 'studyforce', dueStreak: 3 }).includes('문자'));
  assert.equal(core.scriptFor('nope', {}), '');
});

test('normalizers drop anything outside the closed enums', () => {
  const ps = core.normalizePerfset({ progs: ['studyforce', 'wordbrain', 'studyforce'], dueDays: { studyforce: [1, 9, 'x', 3] }, target: { studyforce: 12 }, from: 'manual' });
  assert.deepEqual(ps, { progs: ['studyforce'], dueDays: { studyforce: [1, 3] }, target: null, from: 'bulk' });
  assert.deepEqual(core.normalizePerfset(null).progs, []);
  assert.equal(core.targetOf({ progs: ['classcard'], target: { classcard: 3 } }, 'classcard'), 3);
  assert.equal(core.targetOf({ progs: ['classcard'] }, 'classcard'), 5);
  const day = core.normalizePerfday({ stamp: { by: 's1', at: 5, basis: 'screenshot' }, ex: { stu_a: { st: 'late', why: 'no_login' }, stu_b: { st: 'partial', why: 'because' } } });
  assert.equal(day.stamp.basis, 'login_log', '기준 밖 basis는 기본값');
  assert.deepEqual(day.ex, { stu_b: { st: 'partial', why: '' } });
  assert.equal(core.normalizePerfday({ stamp: { by: '', at: 0, basis: '' } }).stamp, null);
  const act = core.normalizeAction({ type: 'assign', priority: 'P9', st: 'lost', result: 'reached', evidence: { prog: 'x', score: 90 } });
  assert.equal(act.priority, 'P2');
  assert.equal(act.st, 'open');
  assert.equal(act.result, null);
  assert.equal(act.evidence.prog, '');
  assert.equal('score' in act.evidence, false, '점수 필드는 살아남지 않는다');
});
