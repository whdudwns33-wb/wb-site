import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanInstruction, instructionView, instructionAssignment } from './makeup-instructions.js';

test('instruction text has a bounded plain-text contract', () => {
  assert.equal(cleanInstruction('  교재 10쪽\r\n오답 확인  '), '교재 10쪽\n오답 확인');
  assert.throws(() => cleanInstruction('가'.repeat(1501)));
  assert.throws(() => cleanInstruction({ text: 'object' }));
  assert.equal(cleanInstruction(''), '');
});

test('read receipt follows note version and assignment, not ordinary date changes', () => {
  const events = [{ action: 'schedule', staffId: 'staff-a', revision: 2 }];
  const row = { confirmed_staff_id: 'staff-a', history: JSON.stringify(events) };
  const note = { instruction_text: '자체 창작 안내', version: 1, ack_version: 1,
    ack_staff_id: 'staff-a', ack_assignment: instructionAssignment(row) };
  assert.equal(instructionView(row, note).acknowledged, true);
  events.push({ action: 'reschedule', staffId: 'staff-a', revision: 3 });
  row.history = JSON.stringify(events);
  assert.equal(instructionView(row, note).acknowledged, true);
  events.push({ action: 'reschedule', staffId: 'staff-b', revision: 4 },
    { action: 'reschedule', staffId: 'staff-a', revision: 5 });
  row.history = JSON.stringify(events);
  assert.equal(instructionView(row, note).acknowledged, false);
  assert.equal(instructionView(row, null).text, '');
});
