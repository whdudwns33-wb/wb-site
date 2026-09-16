'use strict';
const assert = require('node:assert/strict');
const P = require('./pace.js');
let n = 0; function t(name, fn) { fn(); n++; console.log('ok', name); }
const KEY = { id: 'own-mock-01', n: 9, timeLimitSec: 2400, sets: { A: [1, 2, 3, 4], B: [5, 6, 7], C: [8], D: [9] } };
const T0 = 1000000;
// 세트 A: 지문 150초 읽고 40·40·40·40 / 세트 B: 120초 읽고 50·45·50 / 8: 60초 / 9: 넘겼다가 회수
const ev = [];
let clock = T0;
[[1, 190], [2, 40], [3, 40], [4, 40], [5, 170], [6, 45], [7, 50], [8, 60]].forEach(([no, s]) => { clock += s * 1000; ev.push({ type: 'mark', no, at: clock }); });
ev.push({ type: 'pass', no: 9, at: clock + 5000 });
ev.push({ type: 'mark', no: 9, at: clock + 90000 });
const CLOSED = clock + 120000;

t('세트 첫 문항이 지문 읽기 시간을 뒤집어쓰지 않는다', () => {
  const r = P.attribute(ev, T0, CLOSED, KEY);
  const A = r.sets.find(s => s.setId === 'A');
  assert.equal(A.readSec, 150);
  assert.deepEqual(A.perItemSec, [40, 40, 40, 40]);
  assert.equal(r.items.find(i => i.no === 1).sec, 40);
  assert.equal(r.items.find(i => i.no === 1).rawSec, 190);
  const B = r.sets.find(s => s.setId === 'B');
  assert.equal(B.readSec, 170 - 48);            // 나머지 [45,50] 의 중앙값 47.5 → 48
  assert.deepEqual(B.perItemSec, [48, 45, 50]);
});
t('한 문항짜리 세트는 보정 없음 · 회수 문항은 via recovered', () => {
  const r = P.attribute(ev, T0, CLOSED, KEY);
  assert.equal(r.sets.find(s => s.setId === 'C').readSec, 0);
  assert.equal(r.items.find(i => i.no === 8).sec, 60);
  assert.equal(r.items.find(i => i.no === 9).via, 'recovered');
});
t('미마킹은 blank', () => {
  const r = P.itemTimes(ev.slice(0, 3), T0, CLOSED, KEY);
  assert.equal(r.filter(i => i.via === 'blank').length, 6);
});
t('마킹 지연 — 같은 세트 안의 연속 마킹은 세지 않고, 세트 밖 몰아 마킹만 센다', () => {
  const quick = [{ type: 'mark', no: 1, at: 1000 }, { type: 'mark', no: 2, at: 2000 }, { type: 'mark', no: 3, at: 3000 },   // 세트 A 안
                 { type: 'mark', no: 8, at: 4000 }, { type: 'mark', no: 9, at: 5000 }];                                    // C→D 몰아 마킹
  assert.equal(P.markLag(quick, KEY), 2);   // 3→8 (A→C), 8→9 (C→D)
  assert.equal(P.markLag(ev, KEY), 0);
});
t('페이스 밴드', () => {
  assert.equal(P.band(1200, 15, 2400, 25), 'ahead');
  assert.equal(P.band(1200, 12, 2400, 25), 'on');
  assert.equal(P.band(1200, 8, 2400, 25), 'behind');
});
t('시험 기술 4항목', () => {
  const s = P.skills(ev, KEY);
  assert.equal(s.markImmediate, true);
  assert.equal(s.passUsedAndRecovered, true);
  assert.equal(s.blank0, true);
  assert.equal(s.noBreakGrade, true);
  const s2 = P.skills(ev.slice(0, 8).concat([{ type: 'pass', no: 9, at: clock + 5000 }]), KEY);
  assert.equal(s2.passUsedAndRecovered, false);   // 넘기고 안 돌아왔다
  assert.equal(s2.blank0, false);
  const s3 = P.skills(ev.concat([{ type: 'break-grade-attempt', at: CLOSED + 1000 }]), KEY);
  assert.equal(s3.noBreakGrade, false);
});
console.log(n + ' tests passed');
