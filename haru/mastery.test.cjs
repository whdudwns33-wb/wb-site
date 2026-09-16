'use strict';
const assert = require('node:assert/strict');
const M = require('./mastery.js');
const DAY = 86400000;
let n = 0; function t(name, fn) { fn(); n++; console.log('ok', name); }
const ATOM = { id: 'x', teach: 'app', prereq: [] };
const NOW = Date.UTC(2026, 8, 20);

function run(seq, opts) {   // seq: 'o' 정답 'x' 오답, 문항 id 순환
  const s = M.create(NOW);
  const o = opts || {};
  let tms = NOW;
  seq.split('').forEach((c, i) => {
    tms += 3600000;
    M.observe(s, { ok: c === 'o', itemId: o.sameItem ? 'i-1' : 'i-' + i, form: o.form || 'mcq4', mixed: o.mixed !== false, cue: 0 }, tms);
  });
  return { s, tms };
}

t('찍기 보정 — 4지선다 정답 3연속 < write 정답 3연속, 4지선다 4연속 ≤ write 3연속', () => {
  const a3 = run('ooo', { form: 'mcq4' }), a4 = run('oooo', { form: 'mcq4' }), b = run('ooo', { form: 'write' });
  assert.ok(M.p(a3.s, a3.tms) < M.p(b.s, b.tms));
  assert.ok(M.p(a4.s, a4.tms) <= M.p(b.s, b.tms) + 1e-9);   // 정답 하나의 증거력이 오답의 3/4 — 4개가 write 3개와 같다
});
t('같은 itemId 4회차의 증거력은 1회차의 0.15배', () => {
  const s = M.create(NOW);
  M.observe(s, { ok: true, itemId: 'i', form: 'mcq4', mixed: true }, NOW);
  const first = s.a - 1;
  M.observe(s, { ok: true, itemId: 'i', form: 'mcq4', mixed: true }, NOW);
  M.observe(s, { ok: true, itemId: 'i', form: 'mcq4', mixed: true }, NOW);
  const before = s.a;
  M.observe(s, { ok: true, itemId: 'i', form: 'mcq4', mixed: true }, NOW);
  assert.ok(Math.abs((s.a - before) / first - 0.15) < 1e-9);
});
t('관측 0회 → unknown, 관측 2회도 unknown', () => {
  assert.equal(M.grade(M.create(NOW), ATOM, NOW), 'unknown');
  assert.equal(M.grade(run('oo').s, ATOM, NOW), 'unknown');
});
t('선수가 hole 이어도 관측 0회 자식은 hole 이 아니다 (사전은 판정에 안 쓴다)', () => {
  const hole = run('xxxxxx').s;
  const states = { pre: hole };
  const pr = M.prior({ id: 'child', prereq: ['pre'] }, states, NOW);
  assert.ok(pr.a0 < pr.b0, '사전은 낮게');
  const child = M.create(NOW, pr);
  assert.equal(M.grade(child, ATOM, NOW), 'unknown');
});
t('21일 뒤 p 는 그대로, ci95 만 커진다 (분산 팽창)', () => {
  const { s, tms } = run('ooxoooxooo');
  const p0 = M.p(s, tms), c0 = M.ci95(s, tms);
  const p1 = M.p(s, tms + 21 * DAY), c1 = M.ci95(s, tms + 21 * DAY);
  assert.ok(Math.abs(p0 - p1) < 1e-9);
  assert.ok(c1 > c0);
});
t('모범 경로 — 혼합 맥락 10관측 전부 정답이면 fluent', () => {
  const { s, tms } = run('oooooooooo');
  assert.equal(M.grade(s, ATOM, tms), 'fluent');
});
t('블록 맥락만이면 정답이 많아도 fluent 가 아니다 (졸업은 혼합에서만)', () => {
  const { s, tms } = run('oooooooooooo', { mixed: false });
  assert.notEqual(M.grade(s, ATOM, tms), 'fluent');
});
t('오답 다수 → hole · 반반 → shaky', () => {
  assert.equal(M.grade(run('xxxxox').s, ATOM, NOW + DAY), 'hole');
  assert.equal(M.grade(run('oxoxox').s, ATOM, NOW + DAY), 'shaky');
});
t('retake 관측은 a·b·obs 를 바꾸지 않는다', () => {
  const s = M.create(NOW); const snap = JSON.stringify(s);
  M.observe(s, { ok: true, itemId: 'i', form: 'mcq4', mixed: true, retake: true }, NOW + 1);
  assert.equal(JSON.stringify(s), snap);
});
t("teach:'paper' 원자는 observed-only", () => {
  assert.equal(M.grade(run('oooooooooo').s, { id: 'p', teach: 'paper' }, NOW), 'observed-only');
});
t('추정기 기대값 — 관측 정답률 0.8 → p̂≈0.75 (찍기 몫을 뺀 자리, 큰 표본)', () => {
  const s = M.create(NOW);
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 400; i++) M.observe(s, { ok: rnd() < 0.8, itemId: 'i' + i, form: 'mcq4', mixed: true }, NOW);
  assert.ok(Math.abs(M.p(s, NOW) - 0.75) < 0.05, String(M.p(s, NOW)));
});
t('habit 등급', () => {
  assert.equal(M.gradeHabit(0.9, 2), 'unknown');
  assert.equal(M.gradeHabit(0.9, 8), 'fluent');
  assert.equal(M.gradeHabit(0.2, 5), 'hole');
});
t('mapOf 는 unknown 에 p 를 안 준다', () => {
  const rows = M.mapOf({ a: M.create(NOW) }, [{ id: 'a', subject: 'kor', label: 'A', teach: 'app' }], NOW);
  assert.equal(rows[0].grade, 'unknown'); assert.equal(rows[0].p, null);
});
console.log(n + ' tests passed');
