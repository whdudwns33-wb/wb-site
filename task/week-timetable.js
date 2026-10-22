'use strict';
var WBWeekTimetable = (function () {
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clock(value) { return String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0'); }
  function rows(entries, days, staffId) {
    var grouped = new Map(), seen = new Set();
    (entries || []).forEach(function (entry) {
      // 운영 조회 권한이 있는 일반 직원도 주간 플래너에서는 본인 수업만 본다.
      if (!staffId || entry.staffId !== staffId || !days.includes(entry.date)) return;
      var slot = entry.slot || {}, start = slot.startMinute, end = slot.endMinute;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 1440 || end <= start) return;
      var key = entry.date + '|' + entry.key + '|' + start + '|' + end;
      if (seen.has(key)) return;
      seen.add(key);
      if (!grouped.has(start)) grouped.set(start, days.map(function () { return []; }));
      grouped.get(start)[days.indexOf(entry.date)].push(entry);
    });
    return Array.from(grouped.keys()).sort(function (a, b) { return a - b; }).map(function (start) {
      var cells = grouped.get(start);
      cells.forEach(function (cell) { cell.sort(function (a, b) { return a.slot.endMinute - b.slot.endMinute || String(a.studentName).localeCompare(String(b.studentName), 'ko'); }); });
      return { start: start, cells: cells };
    });
  }
  function render(entries, days, staffId, today) {
    var list = rows(entries, days, staffId);
    if (!list.length) return '<div class="empty">이번 주 등록된 수업이 없습니다.</div>';
    return '<div class="week-time-scroll" role="region" aria-label="주간 수업 시간표" tabindex="0"><table class="week-time-table"><thead><tr><th scope="col">시작</th>' +
      days.map(function (date, i) { return '<th scope="col"' + (date === today ? ' class="is-today"' : '') + '>' + ['월','화','수','목','금','토','일'][i] + '<br>' + esc(date.slice(5).replace('-', '/')) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      list.map(function (row) {
        return '<tr><th scope="row">' + clock(row.start) + '</th>' + row.cells.map(function (cell) {
          return '<td>' + (cell.length ? cell.map(function (entry) {
            var task = entry.task || {}, makeup = task.lessonInstanceType === 'makeup' || !!task.makeupCaseId;
            var first = task.firstClassDate === entry.date;
            var kind = first ? 'first' : makeup ? 'makeup' : task.lessonInstanceType === 'subscription' ? 'subscription' : 'regular';
            return '<div class="week-time-lesson is-' + kind + '"><strong>' + esc(entry.displayName || entry.studentName) + '</strong><span>' + esc(task.subject || '과목 미입력') + '</span><span class="week-time-clock">' + clock(entry.slot.startMinute) + '–' + clock(entry.slot.endMinute) + '</span>' +
              ((first || makeup || kind === 'subscription') ? '<small>' + [first && '첫수업', makeup && '보강', kind === 'subscription' && '구독'].filter(Boolean).join(' · ') + '</small>' : '') + '</div>';
          }).join('') : '<span class="week-time-empty">—</span>') + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>';
  }
  return { rows: rows, render: render };
})();
if (typeof module === 'object' && module.exports) module.exports = WBWeekTimetable;
