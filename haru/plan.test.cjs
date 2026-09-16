'use strict';
const assert = require('node:assert/strict');
const P = require('./plan.js');
let n = 0; function t(name, fn) { fn(); n++; console.log('ok', name); }
const K = (ymd, hm) => P.kstAt(ymd, hm);

const PILOT = { cohort: '2027-pilot', examDate: '2026-10-25', bands: { '5-1': '2026-09-10', '5-2': '2026-09-10', '6-1': '2026-09-10' },
  phases: [{ id: 'p4', from: '2026-09-04', to: '2026-10-24', dailyMin: 15, extendBlockMin: 15, extendMax: 2 }],
  days: [{ d: '2026-09-13', kind: 'mock', keyId: 'own-mock-01' }, { d: '2026-09-21', kind: 'card' }, { d: '2026-09-28', kind: 'card' }],
  milestones: [{ d: '2026-09-29', aud: 'parent', text: '서류 양식 공개' }, { d: '2026-10-25', aud: 'both', text: '08:30 입실' }, { d: '2026-10-30', aud: 'parent', text: '발표 16:00' }] };
const C2028 = { cohort: '2028', examDate: '2027-10-24', bands: { '5-1': '2026-10-05', '5-2': '2026-10-05', '6-1': '2027-01-04' },
  phases: [{ id: 'p2', from: '2026-10-05', to: '2027-02-28', dailyMin: 15 }, { id: 'p3', from: '2027-03-01', to: '2027-08-31', dailyMin: 20 }, { id: 'p4', from: '2027-09-01', to: '2027-10-23' }] };

t('KST 날짜 — UTC 자정 직전은 한국의 다음 날', () => {
  assert.equal(P.kstDate(Date.UTC(2026, 8, 12, 16, 0)), '2026-09-13');
  assert.equal(P.kstDate(K('2026-09-13', '00:00')), '2026-09-13');
});
t('D-day', () => {
  assert.equal(P.dday(PILOT, K('2026-09-04', '10:00')), 51);
  assert.equal(P.dday(PILOT, K('2026-10-25', '09:00')), 0);
  assert.equal(P.dday(PILOT, K('2026-10-26', '09:00')), -1);
});
t('isLocked — 시험일 12:00 경계', () => {
  assert.equal(P.isLocked(PILOT, K('2026-10-25', '11:59')), false);
  assert.equal(P.isLocked(PILOT, K('2026-10-25', '12:00')), true);
  assert.equal(P.isLocked(PILOT, K('2026-10-26', '09:00')), true);
  assert.deepEqual(P.phaseOf(PILOT, K('2026-10-26', '09:00')).mix, { hole: 0, shaky: 0, probe: 0 });
});
t('회고 창과 숫자 개방 — 11/1 16:00', () => {
  assert.equal(P.isRetro(PILOT, K('2026-10-26', '00:00')), true);
  assert.equal(P.isRetro(PILOT, K('2026-11-24', '00:00')), false);
  assert.equal(P.numbersOpen(PILOT, K('2026-11-01', '15:59')), false);
  assert.equal(P.numbersOpen(PILOT, K('2026-11-01', '16:00')), true);
});
t('파이널 하위 국면 — D 로 갈린다', () => {
  const at = (d) => P.phaseOf(PILOT, K(d, '20:00'));
  assert.equal(at('2026-09-21').sub, 'rebuild'); assert.equal(at('2026-09-21').mode, 'block');
  assert.deepEqual(at('2026-09-21').mix, { hole: 1, shaky: 0, probe: 2 });
  assert.equal(at('2026-09-28').sub, 'mix');       // D-27
  assert.equal(at('2026-10-11').sub, 'narrow');    // D-14
  assert.equal(at('2026-10-11').freezeNew, true);
  assert.equal(at('2026-10-10').freezeNew, false);
  assert.equal(at('2026-10-19').sub, 'settle');    // D-6
  assert.equal(at('2026-10-19').dailyMin, 15);
  assert.equal(at('2026-09-21').extendMax, 2);
});
t('3년 코호트 — 달력이 국면을 정한다', () => {
  assert.equal(P.phaseOf(C2028, K('2026-11-15', '20:00')).phase, 'p2');
  assert.equal(P.phaseOf(C2028, K('2027-05-01', '20:00')).phase, 'p3');
  assert.equal(P.phaseOf(C2028, K('2027-09-10', '20:00')).phase, 'p4');
  assert.equal(P.phaseOf(C2028, K('2027-09-10', '20:00')).dailyMin, 15);
  assert.equal(P.phaseOf({ examDate: '2028-10-22' }, K('2026-12-01', '20:00')).phase, 'p1');   // phases 없으면 D 로
});
t('bands 잠금 — 초5 겨울 전에는 6-1 이 닫혀 있다', () => {
  assert.equal(P.bandOpen(C2028, '5-2', K('2026-11-01', '20:00')), true);
  assert.equal(P.bandOpen(C2028, '6-1', K('2026-12-31', '20:00')), false);
  assert.equal(P.bandOpen(C2028, '6-1', K('2027-01-04', '20:00')), true);
  assert.equal(P.bandOpen(C2028, 'none', K('2026-01-01', '20:00')), true);
  assert.equal(P.bandOpen(C2028, '4-1', K('2027-01-04', '20:00')), false);   // 정의 없는 band 는 닫힘
});
t('마일스톤 aud 필터 — 학생은 부모 항목을 못 본다', () => {
  const now = K('2026-09-20', '20:00');
  assert.deepEqual(P.milestonesFor(PILOT, 'student', now).map(m => m.text), ['08:30 입실']);
  assert.deepEqual(P.milestonesFor(PILOT, 'parent', now).map(m => m.d), ['2026-09-29', '2026-10-25', '2026-10-30']);
  assert.deepEqual(P.milestonesFor(PILOT, 'parent', K('2026-10-01', '20:00')).map(m => m.d), ['2026-10-25', '2026-10-30']);
});
t('오늘 ±3일 창', () => {
  assert.deepEqual(P.windowDays(PILOT, K('2026-09-24', '20:00')).map(x => x.d), ['2026-09-21']);
  assert.equal(P.dayEntry(PILOT, '2026-09-13').keyId, 'own-mock-01');
});
t('D-7 위상 전진 — 15분씩 당겨 D-1 에 목표 시각', () => {
  assert.equal(P.bedTarget(PILOT, K('2026-10-10', '20:00')), '23:45');   // D-15
  assert.equal(P.bedTarget(PILOT, K('2026-10-18', '20:00')), '23:30');   // D-7
  assert.equal(P.bedTarget(PILOT, K('2026-10-24', '20:00')), '22:00');   // D-1
  assert.equal(P.bedTarget(PILOT, K('2026-10-25', '08:00')), '22:00');
});
t('월요일 · 주차 키', () => {
  assert.equal(P.isMonday(K('2026-09-21', '09:00')), true);
  assert.equal(P.isMonday(K('2026-09-22', '09:00')), false);
  assert.equal(P.weekKey(K('2026-09-21', '09:00')), '2026-W39');
  assert.equal(P.weekKey(K('2026-01-01', '09:00')), '2026-W01');
});
console.log(n + ' tests passed');
