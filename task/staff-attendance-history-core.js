'use strict';

var WBStaffAttendanceHistoryCore = (function () {
  var KST_OFFSET_MS = 9 * 60 * 60 * 1000;
  var LABELS = {
    complete: '출퇴근 완료',
    missing_out: '퇴근 미기록',
    no_record: '기록 없음',
    invalid: '시간 확인 필요'
  };

  function isEmpty(value) { return value == null || value === ''; }

  function timestamp(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (typeof value === 'string' && !value.trim()) return null;
    var ms = Number(value);
    if (!Number.isFinite(ms) || ms <= 0) return null;
    // 기기 시간대가 달라도 서버가 기록한 한국 날짜와 시각으로 읽어야 한다.
    var date = new Date(ms + KST_OFFSET_MS);
    if (!Number.isFinite(date.getTime())) return null;
    return {
      ms: ms,
      date: date.toISOString().slice(0, 10),
      time: String(date.getUTCHours()).padStart(2, '0') + ':' +
        String(date.getUTCMinutes()).padStart(2, '0')
    };
  }

  function duration(inAt, outAt) {
    var minutes = Math.floor((outAt - inAt) / 60000);
    var hours = Math.floor(minutes / 60), remainder = minutes % 60;
    return hours ? hours + '시간' + (remainder ? ' ' + remainder + '분' : '') : minutes + '분';
  }

  function setStatus(row, status) {
    row.status = status;
    row.label = LABELS[status];
    return row;
  }

  function attendanceRow(staff, date, record) {
    var row = {
      staffId: String(staff.id), name: String(staff.name == null ? '' : staff.name), date: date,
      clockIn: '', clockOut: '', duration: '', status: 'no_record', label: LABELS.no_record
    };
    if (record == null) return row;
    if (typeof record !== 'object' || Array.isArray(record)) return setStatus(row, 'invalid');

    var emptyIn = isEmpty(record.at), emptyOut = isEmpty(record.out);
    var inAt = emptyIn ? null : timestamp(record.at), outAt = emptyOut ? null : timestamp(record.out);
    var validIn = !!inAt && inAt.date === date, validOut = !!outAt && outAt.date === date;
    row.clockIn = validIn ? inAt.time : '';
    row.clockOut = validOut ? outAt.time : '';

    if ((!emptyIn && !validIn) || (!emptyOut && !validOut)) return setStatus(row, 'invalid');
    if (record.done !== true) {
      // 완료 표시 없이 남은 시각을 출근 기록으로 추정하면 관리자가 누락을 놓칠 수 있다.
      return emptyIn && emptyOut ? row : setStatus(row, 'invalid');
    }
    if (!validIn) return setStatus(row, 'invalid');
    if (emptyOut) return setStatus(row, 'missing_out');
    // 기존 급여 CSV와 같은 기준으로, 출퇴근이 동일한 시각이면 확인 대상으로 남긴다.
    if (outAt.ms <= inAt.ms) return setStatus(row, 'invalid');
    row.duration = duration(inAt.ms, outAt.ms);
    return setStatus(row, 'complete');
  }

  function buildRows(options) {
    options = options || {};
    var selected = options.staffId == null ? '' : String(options.staffId);
    var staff = (Array.isArray(options.staff) ? options.staff : []).filter(function (person) {
      return person && person.id != null && String(person.id) !== '' &&
        (!selected || String(person.id) === selected);
    });
    var checks = options.checks && typeof options.checks === 'object' ? options.checks : {};
    var rows = [];
    (Array.isArray(options.dates) ? options.dates : []).forEach(function (date) {
      staff.forEach(function (person) {
        var key = '__att__' + String(person.id) + '|' + date;
        var record = Object.prototype.hasOwnProperty.call(checks, key) ? checks[key] : null;
        rows.push(attendanceRow(person, date, record));
      });
    });
    return rows;
  }

  function summary(rows) {
    var result = { total: 0, complete: 0, missingOut: 0, noRecord: 0, invalid: 0 };
    (Array.isArray(rows) ? rows : []).forEach(function (row) {
      result.total++;
      if (!row) return;
      if (row.status === 'complete') result.complete++;
      else if (row.status === 'missing_out') result.missingOut++;
      else if (row.status === 'no_record') result.noRecord++;
      else if (row.status === 'invalid') result.invalid++;
    });
    return result;
  }

  return { buildRows: buildRows, summary: summary };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WBStaffAttendanceHistoryCore;
