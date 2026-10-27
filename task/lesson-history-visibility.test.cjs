'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, 'index.html'), 'utf8');
const source = html.slice(html.indexOf('function plannedOccursOn('), html.indexOf('\nfunction occursOn('));
const context = { dowOf: d => new Date(d + 'T12:00:00Z').getUTCDay() };
vm.createContext(context); vm.runInContext(source, context);
const occurs = context.plannedOccursOn;
const task = { repeat: 'days', start: '2026-08-01', days: [0], scheduleSlots: [
  { days: [6], startTime: '15:00', endTime: '16:50', validFrom: '2026-08-01', validTo: '2026-10-23' },
  { days: [0], startTime: '10:00', endTime: '11:50', validFrom: '2026-10-24' }
] };
assert.equal(occurs(task, '2026-10-17'), true, 'old Saturday memo card remains visible');
assert.equal(occurs(task, '2026-10-18'), false);
assert.equal(occurs(task, '2026-10-24'), false, 'do not revive old weekday after change');
assert.equal(occurs(task, '2026-10-25'), true);
assert.equal(occurs({ ...task, deleted: true }, '2026-10-17'), false);
assert.equal(occurs({ ...task, end: '2026-10-16' }, '2026-10-17'), false);
assert.equal(occurs(task, '2026-07-25'), false);
assert.equal(occurs({ repeat: 'days', days: [6] }, '2026-10-17'), true);
assert.equal(occurs({ ...task, repeat: 'once', start: '2026-10-24' }, '2026-10-24'), true);
assert.equal(occurs({ ...task, repeat: 'once', start: '2026-10-24' }, '2026-10-25'), false);
assert.equal(occurs({ ...task, repeat: 'daily' }, '2026-10-18'), true);
console.log('lesson history visibility: passed');
assert.match(html, /변경 적용일 \(필수\)/);
assert.match(html, /effectiveDate: draft\._sourceTaskId \? draft\.effectiveDate/);
