(function(root) {
  'use strict';
  var fields = [
    ['status', '처리 상태'], ['confirmedDate', '보강 날짜'], ['confirmedStartTime', '시작시간'],
    ['confirmedEndTime', '종료시간'], ['confirmedStaffId', '보강 담당자'], ['currentTeacherId', '원 수업 담당자'],
    ['sourceDate', '원수업 날짜'], ['completedDate', '완료 날짜'], ['completedStartTime', '완료 시작시간'],
    ['completedEndTime', '완료 종료시간'], ['completedStaffId', '완료 담당자'], ['reason', '처리 사유']
  ];
  function changes(before, after) {
    if (!before || !after) return [];
    var result = fields.filter(function(field) { return String(before[field[0]] || '') !== String(after[field[0]] || ''); })
      .map(function(field) { return { field: field[0], label: field[1], before: before[field[0]] || '', after: after[field[0]] || '' }; });
    if (Number((before.instructions || {}).version || 0) !== Number((after.instructions || {}).version || 0))
      result.push({ field: 'instructions', label: '전달사항', before: (before.instructions || {}).text || '', after: (after.instructions || {}).text || '' });
    return result;
  }
  function matches(payload, row) {
    if (!row) return false;
    if (payload.action === 'complete') return row.status === 'completed' && !row.resolvedByCompletion &&
      String(row.completedDate || '') === String(payload.date || '') &&
      String(row.completedStartTime || '') === String(payload.startTime || '') &&
      String(row.completedEndTime || '') === String(payload.endTime || '') &&
      (!payload.staffId || row.completedStaffId === payload.staffId);
    if (['schedule', 'reschedule', 'reschedule_after_absence'].indexOf(payload.action) >= 0)
      return row.status === 'confirmed' && row.hasLessonTask === true &&
        row.confirmedDate === payload.date && row.confirmedStartTime === payload.startTime &&
        row.confirmedEndTime === payload.endTime && row.confirmedStaffId === payload.staffId &&
        (payload.instructionText == null || String((row.instructions || {}).text || '') === payload.instructionText);
    if (payload.action === 'no_makeup') return row.status === 'cancelled' && row.reason === payload.reason &&
      (row.history || []).some(function(event) { return event.action === 'no_makeup'; });
    if (payload.action === 'instruction_ack') return !!((row.instructions || {}).acknowledged &&
      row.instructions.version === payload.instructionVersion && row.instructions.assignment === payload.assignment);
    return false;
  }
  function createFlightGate() {
    var active = new Set();
    return { enter: function(key) { if (active.has(key)) return false; active.add(key); return true; },
      leave: function(key) { active.delete(key); } };
  }
  var api = { changes: changes, matches: matches, createFlightGate: createFlightGate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WBMakeupRecoveryCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
