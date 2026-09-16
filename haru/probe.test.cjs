'use strict';
const assert = require('node:assert/strict');
const PR = require('./probe.js');
const M = require('./mastery.js');
const P = require('./plan.js');
const DOC = require('./atoms.json');
let n = 0; function t(name, fn) { fn(); n++; console.log('ok', name); }
const K = (d, h) => P.kstAt(d, h);
const ATOMS = DOC.atoms, CORE = DOC.coreByPhase.p2;
const PILOT = { examDate: '2026-10-25', bands: { '5-1': '2026-09-10', '5-2': '2026-09-10', '6-1': '2026-09-10' },
  phases: [{ id: 'p4', from: '2026-09-04', to: '2026-10-24', dailyMin: 15 }] };
const C2028 = { examDate: '2027-10-24', bands: { '5-1': '2026-10-05', '5-2': '2026-10-05', '6-1': '2027-01-04' },
  phases: [{ id: 'p2', from: '2026-10-05', to: '2027-02-28', dailyMin: 15 }] };

t('콜드스타트 — 관측 없는 칸이 무조건 먼저', () => {
  const now = K('2026-09-21', '20:00');
  const states = {}; CORE.forEach(id => { states[id] = M.create(now); });
  // 하나만 관측을 많이 준다
  for (let i = 0; i < 10; i++) M.observe(states['k-poly'], { ok: true, itemId: 'i' + i, form: 'mcq4', mixed: true }, now);
  const first = PR.nextProbe(states, ATOMS, PILOT, now, { core: CORE });
  assert.notEqual(first.atomId, 'k-poly');
  assert.equal(first.grade, 'unknown');
});
t('A(k) — 선수가 구멍이면 자식의 value 가 0.2배', () => {
  const now = K('2026-09-21', '20:00');
  const idx = PR.index(ATOMS);
  const states = {};
  // m-pct-inverse 의 선수 m-ratio-base 를 구멍으로, m-pct-inverse 자신은 shaky 로
  states['m-ratio-base'] = M.create(now); for (let i = 0; i < 6; i++) M.observe(states['m-ratio-base'], { ok: false, itemId: 'r' + i, form: 'mcq4', mixed: true }, now);
  states['m-pct-inverse'] = M.create(now); for (let i = 0; i < 6; i++) M.observe(states['m-pct-inverse'], { ok: i % 2 === 0, itemId: 'p' + i, form: 'mcq4', mixed: true }, now);
  const blocked = PR.value(idx['m-pct-inverse'], states['m-pct-inverse'], states, idx, PILOT, now);
  states['m-ratio-base'] = M.create(now); for (let i = 0; i < 10; i++) M.observe(states['m-ratio-base'], { ok: true, itemId: 'r' + i, form: 'mcq4', mixed: true }, now);
  const open = PR.value(idx['m-pct-inverse'], states['m-pct-inverse'], states, idx, PILOT, now);
  assert.ok(Math.abs(blocked / open - 0.2) < 1e-9);
});
t('B — 학기 잠금 밖 원자는 value 0 (초5 겨울 전의 6-1)', () => {
  const now = K('2026-12-01', '20:00');
  const idx = PR.index(ATOMS);
  assert.equal(PR.value(idx['m-frac-div'], undefined, {}, idx, C2028, now), 0);
  assert.ok(PR.value(idx['m-avg-inverse'], undefined, {}, idx, C2028, now) > 0);   // 5-2 는 열려 있다
  const card = PR.todayCard({}, ATOMS, C2028, now, { core: CORE });
  assert.ok(card.slots.every(s => idx[s.atomId].band !== '6-1'));
});
t('오늘 카드 — 파이널 재건 배합 1/0/2, 국면 ⑤는 빈 슬롯', () => {
  const now = K('2026-09-21', '20:00');
  const card = PR.todayCard({}, ATOMS, PILOT, now, { core: CORE });
  assert.equal(card.slots.length, 3);
  assert.deepEqual(card.slots.map(s => s.kind), ['hole', 'shaky', 'probe'].filter(k => ({ hole: 1, shaky: 0, probe: 2 })[k]).flatMap(k => Array(({ hole: 1, shaky: 0, probe: 2 })[k]).fill(k)));
  assert.ok(card.slots.every(s => s.borrowed === true || s.kind === 'probe'));   // 관측 0이라 hole 슬롯은 probe 에서 빌린다
  assert.equal(card.minEstimate, 15);
  assert.deepEqual(PR.todayCard({}, ATOMS, PILOT, K('2026-10-26', '09:00'), { core: CORE }).slots, []);
});
t('D-14 이후 새 원자를 열지 않는다 (probe 슬롯 비움)', () => {
  const now = K('2026-10-12', '20:00');   // D-13
  const card = PR.todayCard({}, ATOMS, PILOT, now, { core: CORE });
  assert.equal(card.phase.freezeNew, true);
  assert.ok(card.slots.every(s => s.kind !== 'probe'));
});
t('봉투는 월요일에만 새로, 주중엔 이전 것 · 종이 원자만 · 최대 2', () => {
  const mon = K('2026-09-21', '20:00'), tue = K('2026-09-22', '20:00');
  const e1 = PR.todayCard({}, ATOMS, PILOT, mon, { core: CORE }).envelope;
  assert.equal(e1.week, '2026-W39');
  assert.ok(e1.items.length <= 2 && e1.items.every(i => i.paperSource));
  const e2 = PR.todayCard({}, ATOMS, PILOT, tue, { core: CORE, prevEnvelope: e1 }).envelope;
  assert.equal(e2, e1);
});
t('45일 시뮬레이션 — 반수렴 루프 없이 θ=0.9 칸은 대부분 fluent, θ=0.2 칸은 hole, θ=0.55 는 fluent 아님, 전 코어 obs≥3', () => {
  let seed = 11; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const theta = {}; CORE.forEach((id, i) => { theta[id] = i % 3 === 0 ? 0.9 : i % 3 === 1 ? 0.55 : 0.2; });
  const states = {}; const recent = {};
  const start = K('2026-09-08', '20:00');       // D-47 부터 45일 — 파이널 51일 산술의 실증 (30일로는 유창이 2칸뿐이었다)
  let prev = null;
  for (let day = 0; day < 45; day++) {
    const now = start + day * P.DAY;
    const card = PR.todayCard(states, ATOMS, PILOT, now, { core: CORE, prevEnvelope: prev });
    prev = card.envelope;
    card.slots.forEach((slot, si) => {                       // 슬롯당 3문항
      const id = slot.atomId;
      if (!states[id]) states[id] = M.create(now);
      for (let k = 0; k < 3; k++) M.observe(states[id], { ok: rnd() < theta[id], itemId: id + ':' + day + ':' + si + k, form: 'mcq4', mixed: (day + k) % 2 === 0 }, now + si * 60000 + k * 1000);
    });
  }
  const end = start + 45 * P.DAY;
  const idx = PR.index(ATOMS);
  CORE.forEach(id => assert.ok(states[id] && states[id].obs >= 3, id + ' obs'));
  const grades = CORE.map(id => M.grade(states[id], idx[id], end));
  const good = [], mid = [];
  CORE.forEach((id, i) => {
    const g = grades[i];
    if (theta[id] === 0.9) { good.push(g); assert.notEqual(g, 'hole', id); }
    if (theta[id] === 0.55) { mid.push(g); assert.notEqual(g, 'fluent', id); }     // 반반은 절대 '붙었어요'가 아니다
    if (theta[id] === 0.2) assert.equal(g, 'hole', id);
  });
  assert.ok(good.filter(g => g === 'fluent').length >= 4, 'θ=0.9 → ' + good.join(','));   // 유창 = 관측 정답률 ≈0.85 = 실점 3~4개 수준
  const hist = {}; grades.forEach(g => { hist[g] = (hist[g] || 0) + 1; });
  console.log('   45일 후 분포', JSON.stringify(hist));
});
console.log(n + ' tests passed');
