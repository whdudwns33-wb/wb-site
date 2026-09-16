'use strict';
const assert = require('node:assert/strict');
const R = require('./report.js');
const M = require('./mastery.js');
const S = require('./strings.js');
const DOC = require('./atoms.json');
let n = 0; function t(name, fn) { fn(); n++; console.log('ok', name); }
const ATOMS = DOC.atoms, CORE = DOC.coreByPhase.p2;
const NOW = Date.UTC(2026, 9, 1, 3);   // 2026-10-01 12:00 KST
const mk = (ok, wrong, mixed, cause) => { const s = M.create(NOW - 20 * 86400000); for (let i = 0; i < ok; i++) M.observe(s, { ok: true, itemId: 'o' + i, form: 'mcq4', mixed: mixed !== false }, NOW - 86400000); for (let i = 0; i < wrong; i++) M.observe(s, { ok: false, itemId: 'w' + i, form: 'mcq4', mixed: mixed !== false }, NOW - 86400000); if (cause) s.cause = cause; return s; };
function sample() {
  const atoms = {};
  atoms['k-word-build'] = mk(10, 0, true);                                   // fluent
  atoms['k-poly'] = mk(4, 4, true);                                          // shaky
  atoms['k-trap'] = mk(1, 7, true, { gap: 4, exec: 0, confuse: 1, misread: 0, time: 0 });   // hole · tier3 · gap → paper
  atoms['m-frac-div'] = mk(1, 6, true, { gap: 0, exec: 5, confuse: 0, misread: 0, time: 0 }); // hole · exec → block
  atoms['m-ratio-base'] = mk(16, 2, false);                                  // shaky — 블록 맥락만 (obs≥8)
  const days = {}; for (let d = 1; d <= 18; d++) days['2026-09-' + String(d + 10).padStart(2, '0')] = { sat: true, min: 15 };
  const state = { atoms, days, passages: [{ at: '2026-09-22', oneRead: true, rewinds: 0 }, { at: '2026-09-24', oneRead: false, rewinds: 3 }],
    wrong: Array.from({ length: 12 }, (_, i) => ({ at: '2026-09-2' + (i % 8), cause: ['gap', 'exec', 'exec', 'confuse'][i % 4] })), weekly: [{ w: '2026-W38', top3: ['k-trap', 'm-frac-div', 'k-poly'] }] };
  const mocks = [{ keyId: 'own-mock-01', at: '2026-09-13T00:04:00Z', retake: false, completed: true, blank: 3, bySubject: { kor: { n: 25, ok: 11 } }, skills: { markImmediate: true, passUsedAndRecovered: false, blank0: false, noBreakGrade: true } }];
  return { state, mocks, paper: [{ keyId: 'own-drill-6-1-u6', at: '2026-09-21', wrongNos: [3] }] };
}
const OPTS = { now: NOW, core: CORE, prevGrades: { 'k-word-build': 'shaky' } };

t('월간 — 원천 필드에서만 채운다', () => {
  const r = R.monthly(sample(), ATOMS, {}, '2026-09', OPTS);
  assert.equal(r.days.sat, 18); assert.equal(r.days.min, 270);
  assert.deepEqual(r.confirmedDelta, ['k-word-build']);
  assert.equal(r.passages.sessions, 2); assert.equal(r.passages.oneRead, 1);
  assert.equal(r.mocks.length, 1); assert.equal(r.mocks[0].blank, 3); assert.equal(r.mocks[0].dist, null);
  assert.equal(r.causeDist.show, true); assert.equal(r.causeDist.n, 12);
  assert.ok(r.byState.unknown.length >= 10, '관측 없는 코어는 unknown');
});
t('판정 규칙 — tier3+gap → 종이, exec 우세 → 블록, 블록만이면 혼합 필요', () => {
  const r = R.monthly(sample(), ATOMS, {}, '2026-09', OPTS);
  const by = {}; r.actions.forEach(a => { if (a.atomId) by[a.atomId] = a.action; });
  assert.equal(by['k-trap'], 'paper'); assert.equal(by['m-frac-div'], 'block'); assert.equal(by['m-ratio-base'], 'mixed');
  assert.equal(r.toPaper.length, 1);
});
t('회차 분포는 n<30 이면 없다, n≥30 이면 있다', () => {
  const r1 = R.monthly(sample(), ATOMS, {}, '2026-09', Object.assign({}, OPTS, { dist: { 'own-mock-01': { n: 12, bins: [] } } }));
  assert.equal(r1.mocks[0].dist, null);
  const r2 = R.monthly(sample(), ATOMS, {}, '2026-09', Object.assign({}, OPTS, { dist: { 'own-mock-01': { n: 34, bins: [] } } }));
  assert.equal(r2.mocks[0].dist.n, 34);
});
t('원인 분포는 n<10 이면 그리지 않는다', () => {
  const s = sample(); s.state.wrong = s.state.wrong.slice(0, 7);
  assert.equal(R.monthly(s, ATOMS, {}, '2026-09', OPTS).causeDist.show, false);
});
t('부모 뷰 — 점수·정답 개수 없음, 금지어 없음', () => {
  const r = R.monthly(sample(), ATOMS, {}, '2026-09', OPTS);
  const p = R.forParent(r);
  const txt = R.textOf(p);
  assert.ok(!txt.includes('"ok"') && !txt.includes('bySubject') && !txt.includes('점수'), txt);
  assert.deepEqual(S.findForbidden(txt, 'parent'), [], txt);
  assert.ok(p.newlyFluent.length === 1);
  assert.ok(p.toPaper[0].includes('종이'));
});
t('학생 뷰 — 과정형만, 강등·결손 어휘 없음', () => {
  const r = R.monthly(sample(), ATOMS, {}, '2026-09', OPTS);
  const st = R.forStudent(r);
  const txt = R.textOf(st);
  assert.deepEqual(S.findForbidden(txt, 'student'), [], txt);
  assert.ok(st.lines.some(l => l.includes('붙었어요')));
});
t('조건 문구는 저실행일 때만, 3주 연속이면 멈춘다', () => {
  const s = sample(); Object.keys(s.state.days).slice(5).forEach(d => delete s.state.days[d]);
  assert.ok(R.monthly(s, ATOMS, {}, '2026-09', OPTS).condition);
  assert.equal(R.monthly(s, ATOMS, {}, '2026-09', Object.assign({}, OPTS, { lowWeeks: 3 })).condition, null);
});
t('국면 평가 — 동결 세트 두 결과, 완주율, 조정 제안', () => {
  const s = sample();
  s.mocks.push({ keyId: 'own-mock-01', at: '2026-10-18T00:04:00Z', retake: true, completed: true, blank: 0, bySubject: { kor: { n: 25, ok: 19 } }, skills: {} });
  const pr = R.phaseReview(s, ATOMS, { frozenKeyId: 'own-mock-01' }, { now: NOW + 20 * 86400000, core: CORE });
  assert.deepEqual(pr.frozen, { keyId: 'own-mock-01', before: 11, after: 19, diff: 8 });
  assert.equal(pr.coreCompletion.total, 16);
  assert.equal(pr.recommend.bands, 'later');       // 1/16 유창
  assert.equal(pr.recommend.consult, false);
  assert.ok(pr.trajectory[0].top3[0]);
});
console.log(n + ' tests passed');
