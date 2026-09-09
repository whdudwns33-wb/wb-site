'use strict';

var WBStaffWorkSessionCore = (function () {
  function sameIdentity(a, b) {
    return !!(a && b && a.mode === b.mode && (a.mode === 'person'
      ? a.id === b.id && a.token === b.token : a.secret === b.secret));
  }
  function validPin(value) { return /^\d{4}$/.test(String(value || '')); }
  function validateStatus(value, staffId) {
    if (!value || value.ok !== true || String(value.staffId || '') !== String(staffId || '') ||
        !['teacher', 'manager'].includes(value.authRole) || typeof value.required !== 'boolean' ||
        typeof value.active !== 'boolean' || typeof value.configured !== 'boolean' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(String(value.workDate || '')) ||
        (value.authRole === 'manager' && value.required)) throw new Error('출근 로그인 상태를 확인하지 못했습니다');
    return value;
  }
  function isActive(value, date, at) {
    return !!(value && value.checked && (!value.required || (value.active && value.workDate === date &&
      (!value.expiresAt || Number(value.expiresAt) > Number(at)))));
  }
  function isLoginRequired(error) { return String(error && error.code || '') === 'STAFF_WORK_LOGIN_REQUIRED'; }
  function attendance(value, staffId) {
    if (!value) return null;
    var record = value.record, key = '__att__' + String(staffId || '') + '|';
    if (!record || !/^\d{4}-\d{2}-\d{2}$/.test(String(record.date || '')) || value.key !== key + record.date ||
        value.owner !== staffId || record.taskId !== '__att__' + staffId) throw new Error('출퇴근 저장 결과를 확인하지 못했습니다');
    return { key: value.key, record: record };
  }
  return { sameIdentity: sameIdentity, validPin: validPin, validateStatus: validateStatus,
    isActive: isActive, isLoginRequired: isLoginRequired, attendance: attendance };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WBStaffWorkSessionCore;
