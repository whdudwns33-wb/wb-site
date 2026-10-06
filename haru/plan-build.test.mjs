import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildPlan, milestonesFromFacts, FACTS } from './plan-build.mjs';
import P from './plan.js';
import S from './strings.js';
let n = 0; function t(name, fn) { fn(); n++; console.log('ok', name); }
const input = JSON.parse(fs.readFileSync(new URL('./plans/2027-pilot.input.json', import.meta.url), 'utf8'));
const plan = buildPlan(input);
const day = (d) => plan.days.find((e) => e.d === d);

t('파일럿 달력 — 9/4 부터 시험일+30일까지 연속', () => {
  assert.equal(plan.days[0].d, '2026-09-04'); assert.equal(plan.days[plan.days.length - 1].d, '2026-11-24');
  assert.equal(plan.days.length, 82);
});
t('회차 3회 — 9/13 종이·10/4 앱·10/18 재응시, 9/27 은 회차 없는 휴일', () => {
  assert.equal(day('2026-09-13').kind, 'mock'); assert.equal(day('2026-09-13').app, false);
  assert.equal(day('2026-10-04').kind, 'mock'); assert.equal(day('2026-10-04').app, true);
  assert.equal(day('2026-10-18').retakeKeyId, 'own-mock-01');
  assert.equal(day('2026-09-27').kind, 'rest'); assert.ok(/추석/.test(day('2026-09-27').note));
  assert.equal(day('2026-09-28').kind, 'card', '9/28 은 대체공휴일이 아니다');
});
t('9/21 전은 prep, 화·목은 지문, 월요일은 봉투, 주말은 rest', () => {
  assert.equal(day('2026-09-15').kind, 'prep');
  assert.equal(day('2026-09-22').kind, 'passage'); assert.equal(day('2026-09-24').kind, 'rest');   // 9/24 는 추석
  assert.equal(day('2026-10-01').kind, 'passage');
  assert.equal(day('2026-09-21').envelope, true); assert.equal(day('2026-09-21').kind, 'card');
  assert.equal(day('2026-09-19').kind, 'rest');
});
t('파이널 하위 국면과 D-14 동결이 날짜에 박힌다', () => {
  assert.equal(day('2026-09-21').sub, 'rebuild'); assert.equal(day('2026-09-21').mode, 'block');
  assert.equal(day('2026-09-28').sub, 'mix');
  assert.equal(day('2026-10-12').freezeNew, true); assert.equal(day('2026-10-12').sub, 'narrow');   // D-13 월요일 (D-14 는 일요일 rest)
  assert.equal(day('2026-10-08').freezeNew, undefined);
  assert.equal(day('2026-10-20').sub, 'settle');
});
t('시험일·회고', () => {
  assert.equal(day('2026-10-25').kind, 'exam'); assert.equal(day('2026-10-25').lockAt, '12:00');
  assert.equal(day('2026-10-26').kind, 'retro'); assert.equal(day('2026-11-24').kind, 'retro');
  assert.equal(P.isLocked(plan, P.kstAt('2026-10-25', '12:00')), true);
});
t('마일스톤은 facts.json 에서 — 부모 항목과 입실(both)', () => {
  const ms = milestonesFromFacts(FACTS);
  assert.ok(ms.some((m) => m.d === '2026-10-13' && m.aud === 'parent' && /동의서/.test(m.text)));
  assert.ok(ms.some((m) => m.d === '2026-10-25' && m.aud === 'both'));
  assert.ok(ms.some((m) => m.d === '2026-09-29'));
  assert.ok(plan.milestones.some((m) => m.d === '2026-10-24' && m.at === '21:00'));
  assert.deepEqual(P.milestonesFor(plan, 'student', P.kstAt('2026-10-20', '20:00')).map((m) => m.d), ['2026-10-25']);
});
/* 부모 화면(parent.html)은 마일스톤 문구와 고지를 그대로 그린다 — 부모 금지어는 화면이 아니라 원천에서 막는다.
   저장소의 플랜 파일(관리 웹에 올리는 그 파일)과 빌더 산출물을 둘 다 본다. */
const COMMITTED = JSON.parse(fs.readFileSync(new URL('./plans/2027-pilot.json', import.meta.url), 'utf8'));
const forParent = (pl) => pl.milestones.filter((m) => m.aud === 'parent' || m.aud === 'both');
t('부모에게 가는 마일스톤·상시 고지에 부모 금지어가 없다 (저장소 플랜 + 빌더 산출물)', () => {
  for (const pl of [COMMITTED, plan]) {
    assert.ok(forParent(pl).length >= 10);
    forParent(pl).forEach((m) => assert.deepEqual(S.findForbidden(m.text, 'parent'), [], m.d + ' ' + m.text));
    assert.deepEqual(S.findForbidden(pl.notice, 'parent'), [], pl.notice);
    assert.deepEqual(S.findForbidden(pl.notice, 'student'), [], pl.notice);   // 고지는 학생 홈에도 나간다
  }
});
t('저장소의 플랜 파일 = 빌더 산출물 (facts.json·빌더를 고치고 다시 빌드하지 않으면 실패)', () => {
  assert.deepEqual(COMMITTED, JSON.parse(JSON.stringify(plan)));
});
t('부모 화면이 시험일을 읽는 입실 마일스톤은 시험일에 하나뿐', () => {
  /* parent.html 은 서버가 시험일을 따로 주지 않아 이 문구로 D-7 취침 위상 전진 기간을 판정한다 */
  const exam = forParent(plan).filter((m) => /고사장 입실/.test(m.text));
  assert.equal(exam.length, 1); assert.equal(exam[0].d, plan.examDate);
});
t('어른 일정은 시각·시작일을 반복하지 않고 마감과 등록 종료일을 유지한다', () => {
  const ms = milestonesFromFacts(FACTS);
  ms.forEach((m) => { if (m.at) assert.ok(!m.text.includes(m.at), m.text); });
  const exam = ms.find((m) => m.aud === 'both');
  assert.equal(exam.at, FACTS.exam.arriveBy); assert.equal(exam.text, '고사장 입실 마감');
  const enroll = ms.find((m) => m.d === FACTS.schedule.enroll[0]);
  assert.ok(!enroll.text.includes(enroll.d)); assert.ok(enroll.text.endsWith(FACTS.schedule.enroll[1] + '까지'));
});
t('회차가 휴일과 겹치면 빌드가 거부된다', () => {
  const bad = JSON.parse(JSON.stringify(input)); bad.mocks[0].d = '2026-09-27';
  assert.throws(() => buildPlan(bad), /휴일/);
});
console.log(n + ' tests passed');
