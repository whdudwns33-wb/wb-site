'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('./makeup-recovery-core.js');
test('같은 보강에 대한 동시 요청은 한 건만 허용하고 실패 후 잠금은 풀 수 있다', () => {
  const gate = core.createFlightGate();
  assert.equal(gate.enter('case-a'), true);
  assert.equal(gate.enter('case-a'), false);
  assert.equal(gate.enter('case-b'), true);
  gate.leave('case-a');
  assert.equal(gate.enter('case-a'), true);
});
test('변경 항목은 상태 날짜 담당자 전달사항을 구분한다', () => {
  const changes = core.changes({ status: 'reviewed', confirmedDate: '', currentTeacherId: 'a', instructions: { version: 1, text: '기존' } },
    { status: 'confirmed', confirmedDate: '2026-09-20', currentTeacherId: 'b', instructions: { version: 2, text: '변경' } });
  assert.deepEqual(changes.map(item => item.label), ['처리 상태', '보강 날짜', '원 수업 담당자', '전달사항']);
});
test('이미 처리됨은 상태뿐 아니라 실제 저장값도 일치해야 한다', () => {
  const payload = { action: 'schedule', date: '2026-09-20', startTime: '10:00', endTime: '10:50', staffId: 'a', instructionText: '창작 안내' };
  const row = { status: 'confirmed', hasLessonTask: true, confirmedDate: payload.date,
    confirmedStartTime: payload.startTime, confirmedEndTime: payload.endTime, confirmedStaffId: 'a', instructions: { text: '창작 안내' } };
  assert.equal(core.matches(payload, row), true);
  assert.equal(core.matches(payload, { ...row, confirmedStaffId: 'b' }), false);
  assert.equal(core.matches(payload, { ...row, hasLessonTask: false }), false);
  assert.equal(core.matches({ ...payload, instructionText: '다른 안내' }, row), false);
  assert.equal(core.matches({ action: 'complete', date: '2026-09-20', startTime: '10:00', endTime: '10:50' },
    { status: 'completed', completedDate: '2026-09-20', completedStartTime: '10:00', completedEndTime: '10:50' }), true);
  assert.equal(core.matches({ action: 'complete', date: '2026-09-21' }, { status: 'completed', completedDate: '2026-09-20' }), false);
  assert.equal(core.matches({ action: 'no_makeup', reason: '' }, { status: 'cancelled', reason: '', history: [{ action: 'reconcile_attendance' }] }), false);
});
