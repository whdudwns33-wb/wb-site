'use strict';
/* node reading-server/haru-score.test.mjs */
import assert from 'node:assert/strict';
import { scorePeriod, mockRecord, keyFromPack, distUpdate, distView, pctOf, aggWeek, boardRows, coachMap, MIN_N_DIST } from './haru-score.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ATOMS = require('../haru/atoms.json');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

const KEY = { id: 'own-mock-t', subject: 'kor', n: 6, timeLimitSec: 600, origin: 'own', holder: 'academy', frozen: true,
  sets: { A: [1, 2, 3], B: [4, 5], q6: [6] }, map: { 1: 'k-dev-pattern', 2: 'k-refer', 3: 'k-trap', 4: 'k-theme', 5: 'k-poly', 6: 'k-word-build' },
  answer: { 1: '2', 2: '1', 3: '3', 4: '4', 5: '1', 6: '2' } };
const T0 = Date.UTC(2026, 9, 4, 0, 0, 0);
const ev = (type, no, at, key) => ({ type, no, at: T0 + at * 1000, key });

t('교시 채점 — 정답·무응답·오답 번호·세트 시간·시험 기술', () => {
  const events = [ev('mark', 1, 200, '2'), ev('mark', 2, 240, '1'), ev('mark', 3, 280, '1'), ev('pass', 4, 300), ev('mark', 5, 360, '1'), ev('mark', 4, 420, '4')];
  const r = scorePeriod({ subject: 'kor', events, openedAt: T0, closedAt: T0 + 500 * 1000 }, KEY);
  assert.equal(r.ok, 4); assert.equal(r.blank, 1); assert.deepEqual(r.wrongNos, [3]);
  assert.equal(r.perItem[5].picked, null); assert.equal(r.perItem[2].atomId, 'k-trap');
  assert.ok(r.sets.find((s) => s.setId === 'A').readSec > 0, '세트 A 의 지문 읽기 시간이 떼어졌다');
  assert.equal(r.skills.passUsedAndRecovered, true); assert.equal(r.skills.blank0, false); assert.equal(r.completed, true);
  assert.equal(r.sec, 500);
});
t('기기가 보낸 이상값은 버린다 — 범위 밖 번호·잘못된 키·문자열 시각', () => {
  const r = scorePeriod({ subject: 'kor', marks: { 1: '2', 9: '1', 2: 'x', 3: '3' }, events: [{ type: 'mark', no: 'a', at: 'b' }, { type: 'boom', no: 1, at: T0 }], openedAt: T0, closedAt: T0 + 1000 }, KEY);
  assert.equal(r.ok, 2); assert.equal(r.blank, 4);
});
t('정답 표가 없는 대응표는 채점하지 않는다(ok null) — 시판 자료', () => {
  const r = scorePeriod({ subject: 'math', marks: { 1: '1' }, events: [], openedAt: T0, closedAt: T0 + 1000 }, { ...KEY, id: 'cm-1', answer: undefined });
  assert.equal(r.ok, null); assert.equal(r.perItem[0].ok, null); assert.equal(r.blank, 5);
});
t('screen-mock 팩 → 대응표 투영: 지문 세트 + 단독 문항 세트, 정답', () => {
  const pack = { packId: 'sm-1', subject: 'math', origin: 'own', timeLimitSec: 2400, passages: [{ id: 'p-1', itemNos: [1, 2] }],
    items: [{ no: 2, atomId: 'm-frac-div', answerKey: '3' }, { no: 1, atomId: 'm-ratio-base', answerKey: '1' }, { no: 3, atomId: 'm-unit-vol', answerKey: '2' }] };
  const k = keyFromPack(pack);
  assert.deepEqual(k.sets, { 'p-1': [1, 2], q3: [3] }); assert.equal(k.n, 3); assert.equal(k.answer[3], '2'); assert.equal(k.map[2], 'm-frac-div');
});
t('회차 기록 — 과목별 정답 수, 무응답 합, skills 는 전 교시 AND, 재응시 표시', () => {
  const a = scorePeriod({ subject: 'kor', marks: { 1: '2', 2: '1', 3: '3', 4: '4', 5: '1', 6: '2' }, events: [ev('mark', 1, 10, '2'), ev('mark', 2, 11, '1'), ev('mark', 3, 12, '3'), ev('mark', 4, 13, '4'), ev('mark', 5, 14, '1'), ev('mark', 6, 15, '2')], openedAt: T0, closedAt: T0 + 20000 }, KEY);
  const b = scorePeriod({ subject: 'math', marks: {}, events: [], openedAt: T0, closedAt: T0 + 20000 }, { ...KEY, id: 'k2', subject: 'math' });
  const rec = mockRecord([a, b], { keyId: 'own-mock-02', at: '2026-10-04T00:04:00Z', retake: true, kind: 'full' });
  assert.equal(rec.bySubject.kor.ok, 6); assert.equal(rec.bySubject.math.ok, 0); assert.equal(rec.blank, 6); assert.equal(rec.retake, true);
  assert.equal(rec.skills.blank0, false, '한 교시라도 무응답이 있으면 blank0 은 false');
  assert.ok(!('score' in rec) && !('pct' in rec), '기록에 점수 필드가 없다');
  assert.equal(pctOf([a, b]), 50);
});
t('분포 — 구간 5개에 쌓이고, n<30 이면 부모 화면 투영이 null', () => {
  let d = null;
  for (let i = 0; i < 29; i++) d = distUpdate(d, 60 + (i % 5), { keyId: 'k', cohort: '2027-pilot', at: 'x' });
  assert.equal(d.n, 29); assert.equal(distView(d, 62), null);
  d = distUpdate(d, 100, { keyId: 'k', cohort: '2027-pilot' });
  assert.equal(d.n, MIN_N_DIST); assert.equal(d.bins[4].c, 1);
  const v = distView(d, 62); assert.equal(v.mine, 3); assert.equal(v.n, 30);
  assert.equal(distUpdate(d, null, {}).n, 30, '채점 불가 회차는 분포에 안 들어간다');
});
t('주간 집계 — 앉은 학생 10명 미만이면 null, 셀 n<5 생략, 학생 코드 없음', () => {
  const mk = (k) => ({ code: 'c' + k, atoms: { 'm-ratio-base': { obs: 3, ok: 2 }, ...(k < 4 ? { 'k-poly': { obs: 2, ok: 1 } } : {}) } });
  assert.equal(aggWeek('2026-W41', [mk(1), mk(2)]), null);
  const agg = aggWeek('2026-W41', Array.from({ length: 12 }, (_, i) => mk(i)));
  assert.equal(agg.students, 12); assert.ok(agg.cells.find((c) => c.atomId === 'm-ratio-base').n === 12);
  assert.ok(!agg.cells.find((c) => c.atomId === 'k-poly'), 'n=4 셀은 빠진다');
  assert.ok(!JSON.stringify(agg).includes('"code"'));
});
t('코치 보드 — 오래 안 온 순, 점수 열 없음, 확정칸·봉투·시험 기술', () => {
  const now = Date.UTC(2026, 9, 6, 3, 0, 0);
  const fluent = { a: 30, b: 4, obs: 12, ok: 11, ctx: ['mixed', 'block'], lastAt: now, seen: {} };
  const rows = boardRows([
    { code: 'a', student: { name: 'A', consent: { at: '2026-09-10' } }, state: { updatedAt: '2026-10-05T12:00:00Z', state: { days: { '2026-10-05': { sat: true, min: 14 } }, atoms: { 'm-ratio-base': fluent }, envelope: { items: [{ atomId: 'm-solid-cut', label: '입체 겉넓이' }] } } },
      mocks: { mocks: [{ keyId: 'own-mock-02', completed: true, blank: 1, skills: { markImmediate: true, passUsedAndRecovered: false, blank0: false, noBreakGrade: true, lag: 2 } }] } },
    { code: 'b', student: { name: 'B' }, state: { updatedAt: '2026-10-01T12:00:00Z', state: { days: { '2026-10-01': { sat: true, min: 10 } } } }, mocks: null },
  ], ATOMS.atoms, ATOMS.coreByPhase.p2, now);
  assert.equal(rows[0].code, 'b'); assert.equal(rows[0].flag, 'idle5');
  assert.equal(rows[1].confirmed, 1); assert.equal(rows[1].coreTotal, 16); assert.deepEqual(rows[1].envelope, ['입체 겉넓이']);
  assert.equal(rows[1].lastMock.passes, 2); assert.equal(rows[1].min7, 14);
  const txt = JSON.stringify(rows);
  ['score', 'pct', 'rank', 'prob', '정답률', '점수'].forEach((w) => assert.ok(!txt.includes(w), w));
  const map = coachMap({ state: { atoms: { 'm-ratio-base': fluent, 'm-solid-cut': { obs: 2, ok: 0, a: 1, b: 3, ctx: [] } } } }, ATOMS.atoms, ATOMS.coreByPhase.p2, now);
  assert.equal(map.core.find((r) => r.id === 'm-ratio-base').stateLabel, '유창');
  assert.ok(map.peri.find((r) => r.id === 'm-solid-cut'));
});
console.log(n + ' tests passed');
