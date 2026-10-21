import assert from 'node:assert/strict';
import { initialSessionSize, tuitionCycleEligible, billingCycleView } from './session-billing-cycle.js';

const student = { sessionInitialCycleSize: 12 };
assert.equal(initialSessionSize({}), 4);
assert.equal(initialSessionSize(student), 12);
assert.equal(tuitionCycleEligible(student, { cycleNo: 1 }), false);
assert.equal(tuitionCycleEligible(student, { cycleNo: 2 }), false);
assert.equal(tuitionCycleEligible(student, { cycleNo: 3 }), true);
const cycles = Array.from({ length: 4 }, (_, i) => ({
  cycleNo: i + 1, cycleStartDate: '2026-08-' + String(i * 4 + 1).padStart(2, '0'),
  entries: Array.from({ length: 4 }, (_, n) => ({ date: '2026-08-' + String(i * 4 + n + 1).padStart(2, '0') })),
  attendanceCount: 4, status: 'complete'
}));
const snapshot = JSON.stringify(cycles);
assert.equal(billingCycleView(cycles, {}) , cycles);
const projected = billingCycleView(cycles, student);
assert.deepEqual(projected.map(c => [c.cycleNo, c.cycleSize, c.attendanceCount]), [[1, 12, 12], [2, 4, 4]]);
assert.equal(projected[0].completedAt, '2026-08-12');
assert.equal(projected[0].entries[11].sessionNo, 12);
assert.equal(JSON.stringify(cycles), snapshot);
console.log('session billing projection: PASS');
