/* 같은 이름이라도 학생 ID가 다르면 별도 그룹으로 보존한다. */
(function(root) {
  'use strict';
  function normalize(value) { return String(value || '').replace(/\s+/g, '').toLocaleLowerCase('ko'); }
  function group(rows, options) {
    var o = options || {}, query = normalize(o.query), groups = new Map();
    (rows || []).forEach(function(row) {
      if (query && !normalize(row.studentName).includes(query)) return;
      if (o.date && String(o.archived ? (row.completedDate || row.confirmedDate || '') : (row.confirmedDate || '')) !== o.date) return;
      var staffId = row.completedStaffId || row.confirmedStaffId || row.sourceTeacherId || row.currentTeacherId || '';
      var id = o.mode === 'student' ? String(row.studentId || row.caseId) : String(staffId || 'unknown');
      var label = o.mode === 'student' ? o.studentLabel(row) : o.teacherLabel(staffId);
      if (!groups.has(id)) groups.set(id, {id:id, label:label, rows:[], needed:0, scheduled:0});
      var g = groups.get(id); g.rows.push(row);
      if (!['completed','cancelled'].includes(row.status)) {
        if (o.needsSchedule(row)) g.needed++; else g.scheduled++;
      }
    });
    return Array.from(groups.values()).sort(function(a,b) { return a.label.localeCompare(b.label,'ko') || a.id.localeCompare(b.id); }).map(function(g) {
      g.rows.sort(function(a,b) {
        if (o.archived) return Number(b.updatedAt || 0)-Number(a.updatedAt || 0);
        return Number(!!o.needsSchedule(b))-Number(!!o.needsSchedule(a)) ||
          String(a.confirmedDate || a.sourceDate || '').localeCompare(String(b.confirmedDate || b.sourceDate || '')) ||
          String(a.confirmedStartTime || '').localeCompare(String(b.confirmedStartTime || '')) || String(a.caseId).localeCompare(String(b.caseId));
      }); return g;
    });
  }
  var api={group:group,normalize:normalize};
  if(typeof module==='object'&&module.exports) module.exports=api;
  root.WBMakeupGroups=api;
})(typeof globalThis!=='undefined'?globalThis:this);
