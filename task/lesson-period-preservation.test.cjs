'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const core = require('./lesson-form-core.js');
const source = fs.readFileSync(__dirname + '/index.html', 'utf8');
const draftFn = source.slice(source.indexOf('function lessonDraftFromTask('), source.indexOf('function lessonTextField('));
const slotFn = source.slice(source.indexOf('function lessonSlotHtml('), source.indexOf('function lessonBatchSlotHtml('));
const context = { today: () => '2026-10-16', lessonHoursValue: value => value || '', lessonRegistrationIsoDate: value => value || '', esc: String, DOW: ['일','월','화','수','목','금','토'] };
vm.createContext(context);
vm.runInContext(draftFn + slotFn, context);
const slots = [
  {slotId:'past',days:[1],startTime:'16:00',endTime:'16:50',lessonHours:'1T',validFrom:'2026-08-04',validTo:'2026-09-28'},
  {slotId:'new',days:[1],startTime:'15:30',endTime:'16:20',lessonHours:'1T',validFrom:'2026-09-29'}
];
const draft = context.lessonDraftFromTask({id:'sample',studentName:'샘플',start:'2026-08-04',scheduleSlots:slots});
assert.equal(draft.scheduleSlots[0].validTo, '2026-09-28');
assert.equal(draft.scheduleSlots[1].slotId, 'new');
const html = context.lessonSlotHtml(draft.scheduleSlots[0],0);
assert.match(html,/지난 시간표/);
assert.doesNotMatch(html,/<input|lessonslotdel|<details[^>]*\bopen/);
const resolved = core.resolveSchedule({scheduleSlots:slots});
assert.ok(!JSON.stringify(resolved).includes('overlapping_slots'));
console.log('versioned schedule draft and read-only history tests passed');
