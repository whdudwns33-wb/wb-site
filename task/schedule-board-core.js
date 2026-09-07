(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WBScheduleCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RANGE_RE = /(\d{1,2}):([0-5]\d)\s*(?:-|–|—|−|~|～)\s*(\d{1,2}):([0-5]\d)/g;
  const CLOCK_RE = /\b\d{1,2}:[0-5]\d\b/;

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function parseClockMinute(value) {
    const match = String(value || '').trim().match(/^(\d{1,2}):([0-5]\d)$/);
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
    return hour * 60 + minute;
  }

  function clockText(minute) {
    return pad2(Math.floor(minute / 60)) + ':' + pad2(minute % 60);
  }

  function studentGroupKey(name, grade, studentId) {
    const clean = value => String(value || '').normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('ko');
    const id = String(studentId || '').trim();
    return id ? 'id|' + id : 'legacy|' + clean(name) + '|' + clean(grade);
  }

  function extractLessonRanges(value) {
    const text = String(value || '');
    const ranges = [];
    const seen = new Set();
    let match;
    RANGE_RE.lastIndex = 0;
    while ((match = RANGE_RE.exec(text))) {
      const startMinute = parseClockMinute(match[1] + ':' + match[2]);
      const endMinute = parseClockMinute(match[3] + ':' + match[4]);
      if (startMinute === null || endMinute === null || endMinute <= startMinute) continue;
      const key = startMinute + '-' + endMinute;
      if (seen.has(key)) continue;
      seen.add(key);
      ranges.push({
        startTime: clockText(startMinute),
        endTime: clockText(endMinute),
        startMinute: startMinute,
        endMinute: endMinute,
        label: clockText(startMinute) + '–' + clockText(endMinute)
      });
    }
    return ranges;
  }

  function normalizedDays(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6))];
  }

  function appliesOn(slot, date, dow, fallbackOccurs, withinRange) {
    const validFrom = String(slot.validFrom || slot.startDate || '');
    const validTo = String(slot.validTo || slot.endDate || '');
    if (validFrom && date < validFrom) return false;
    if (validTo && date > validTo) return false;
    if (!withinRange) return false;
    const days = normalizedDays(slot.days);
    if (days.length) return days.includes(dow);
    return fallbackOccurs;
  }

  function needsScheduleReview(task) {
    if (task.scheduleStatus === 'needs_review') return true;
    const evidence = [task.detail, task.guide, task.scheduleText].filter(Boolean).join('\n');
    return /실제\s*시간표|시간표[^\n]{0,30}확인\s*필요|요일[^\n]{0,30}시간[^\n]{0,50}확정하지/.test(evidence);
  }

  function issue(code, message, source) {
    return { code: code, message: message, source: String(source || '') };
  }

  function classifyTaskSchedule(task, options) {
    const date = String(options.date || '');
    const dow = Number(options.dow);
    const fallbackOccurs = !!options.occurs;
    const withinRange = options.withinRange !== false;
    const role = String(task.lessonRole || '').trim();
    const structured = Array.isArray(task.scheduleSlots) ? task.scheduleSlots : [];
    const flexibleFrom = String(task.weekendFlexibleFrom || '');
    const flexibleEffective = task.weekendAttendanceMode === 'flexible' &&
      /^\d{4}-\d{2}-\d{2}$/.test(flexibleFrom) && date >= flexibleFrom;

    if (!withinRange) {
      return { slots: [], issues: [], sourceType: structured.length ? 'structured' : 'legacy' };
    }

    /* 비정기 주말 수업의 기존 scheduleSlots는 참고 시간표일 뿐이다. 전환일 이후
     * 관리자 시간표에는 exact taskId + studentId + visitDate로 확인한 실제 방문만
     * 넣는다. 참고 요일로 카드를 만들거나 이름으로 방문을 추측하지 않는다. */
    if (flexibleEffective) {
      const visit = options.flexibleVisit || null;
      const exactVisit = !!(visit && visit.status !== 'cancelled' && fallbackOccurs &&
        String(visit.lessonTaskId || '') === String(task.id || '') &&
        String(task.studentId || '') && String(visit.studentId || '') === String(task.studentId || '') &&
        String(visit.visitDate || '') === date);
      if (!exactVisit) return { slots: [], issues: [], sourceType: 'flexible' };

      const startMinute = parseClockMinute(visit.startTime);
      const endMinute = parseClockMinute(visit.endTime);
      if (startMinute === null || endMinute === null || endMinute <= startMinute) {
        return {
          slots: [],
          issues: [issue('invalid_visit_time', '실제 등·하원 시간을 확인해 주세요', '')],
          sourceType: 'flexible'
        };
      }
      return {
        slots: [{
          slotId: 'weekend-visit:' + String(visit.visitId || task.id + ':' + date),
          startTime: clockText(startMinute),
          endTime: clockText(endMinute),
          startMinute: startMinute,
          endMinute: endMinute,
          label: visit.projectedEnd ? clockText(startMinute) + '–등원 중' : clockText(startMinute) + '–' + clockText(endMinute),
          lessonRole: role,
          scheduleStatus: visit.projectedEnd ? 'actual_visit_active' : 'actual_visit'
        }],
        issues: [],
        sourceType: 'flexible'
      };
    }

    if (structured.length) {
      const slots = [];
      const issues = [];
      structured.forEach((raw, index) => {
        const slot = raw || {};
        if (!appliesOn(slot, date, dow, fallbackOccurs, withinRange)) return;
        const startMinute = parseClockMinute(slot.startTime);
        const endMinute = parseClockMinute(slot.endTime);
        if (startMinute === null || endMinute === null || endMinute <= startMinute) {
          issues.push(issue('invalid_slot', '시작·종료 시간을 확인해 주세요', slot.startTime + '–' + slot.endTime));
          return;
        }
        slots.push({
          slotId: String(slot.slotId || task.id + ':' + index),
          startTime: clockText(startMinute),
          endTime: clockText(endMinute),
          startMinute: startMinute,
          endMinute: endMinute,
          label: clockText(startMinute) + '–' + clockText(endMinute),
          lessonRole: String(slot.lessonRole || role),
          scheduleStatus: String(slot.status || 'normal')
        });
      });
      return { slots: slots, issues: issues, sourceType: 'structured' };
    }

    if (task.repeat && !fallbackOccurs) return { slots: [], issues: [], sourceType: 'legacy' };

    const source = String(task.scheduleText || task.time || '').trim();
    const ranges = extractLessonRanges(source);
    if (ranges.length > 1) {
      return {
        slots: [],
        issues: [issue('split_assignment', '분할 시간의 담당 선생님·역할을 확인해 주세요', source)],
        sourceType: 'legacy'
      };
    }
    const review = needsScheduleReview(task);
    if (review) {
      return {
        slots: [],
        issues: [issue('needs_review', '확정 전 시간표입니다. 원장 확인이 필요합니다', source)],
        sourceType: 'legacy'
      };
    }
    if (ranges.length === 1 && fallbackOccurs) {
      return {
        slots: [Object.assign({
          slotId: String(task.id) + ':legacy:0',
          lessonRole: role,
          scheduleStatus: 'normal'
        }, ranges[0])],
        issues: [],
        sourceType: 'legacy'
      };
    }
    if (source && CLOCK_RE.test(source)) {
      return {
        slots: [],
        issues: [issue('missing_end', '수업 종료 시간을 확인해 주세요', source)],
        sourceType: 'legacy'
      };
    }
    if (fallbackOccurs) {
      return {
        slots: [],
        issues: [issue('missing_schedule', '수업 요일·시간·반복을 확인해 주세요', source)],
        sourceType: 'legacy'
      };
    }
    return { slots: [], issues: [], sourceType: 'legacy' };
  }

  function clockState(slot, date, todayDate, nowMinute) {
    if (date < todayDate) return 'ended';
    if (date > todayDate) return 'upcoming';
    if (nowMinute < slot.startMinute) return 'upcoming';
    if (slot.scheduleStatus === 'actual_visit_active') return 'current';
    if (nowMinute >= slot.endMinute) return 'ended';
    return 'current';
  }

  function occupiedEndMinute(entry, options) {
    const slot = entry.slot || entry;
    let endMinute = Number(slot.endMinute);
    if (slot.scheduleStatus !== 'actual_visit_active') return endMinute;
    const date = String(entry.date || options && options.date || '');
    const todayDate = String(options && options.todayDate || '');
    const nowMinute = Number(options && options.nowMinute);
    const startMinute = Number(slot.startMinute);
    if (date && date === todayDate && Number.isFinite(nowMinute) && nowMinute >= startMinute) {
      endMinute = Math.max(endMinute, Math.min(24 * 60, nowMinute + 1));
    }
    return endMinute;
  }

  function timelineRange(entries, options) {
    const slots = (entries || []).map(entry => {
      const slot = entry.slot || entry;
      return Object.assign({}, slot, { endMinute: occupiedEndMinute(entry, options) });
    }).filter(slot =>
      Number.isFinite(slot.startMinute) && Number.isFinite(slot.endMinute) && slot.endMinute > slot.startMinute
    );
    if (!slots.length) return { startMinute: 14 * 60, endMinute: 20 * 60 };

    const first = Math.min.apply(null, slots.map(slot => slot.startMinute));
    const last = Math.max.apply(null, slots.map(slot => slot.endMinute));
    let startMinute = Math.max(0, Math.floor((first - 30) / 60) * 60);
    let endMinute = Math.min(24 * 60, Math.ceil((last + 30) / 60) * 60);
    if (endMinute - startMinute < 4 * 60) {
      endMinute = Math.min(24 * 60, startMinute + 4 * 60);
      startMinute = Math.max(0, endMinute - 4 * 60);
    }
    return { startMinute: startMinute, endMinute: endMinute };
  }

  function overlaps(a, b) {
    return a.startMinute < b.endMinute && b.startMinute < a.endMinute;
  }

  function lessonIdentity(entry) {
    const task = entry.task || {};
    const slot = entry.slot || {};
    const clean = value => String(value || '').normalize('NFKC').trim().toLocaleLowerCase('ko');
    const parts = [task.subject, task.className, entry.role || slot.lessonRole || task.lessonRole].map(clean);
    const makeupCaseId = clean(task.makeupCaseId);
    if (task.lessonInstanceType === 'makeup' || makeupCaseId) {
      // 같은 교사·시간이어도 정규반과 보강은 서로 다른 수업 카드다. 보강 건 ID를
      // 포함해야 서로 다른 학생의 보강까지 하나의 정규 그룹으로 합쳐지지 않는다.
      parts.push('makeup:' + (makeupCaseId || clean(task.id) || 'unspecified'));
    }
    return parts.some(Boolean) ? parts.join('|') : 'unspecified';
  }

  function timelineRows(entries, options) {
    const prepared = (entries || []).map((entry, index) => ({
      entry: entry,
      index: index,
      teacherKey: String(entry.staffId || entry.teacherName || 'unassigned'),
      startMinute: Number((entry.slot || {}).startMinute),
      endMinute: occupiedEndMinute(entry, options),
      lessonIdentity: lessonIdentity(entry)
    })).filter(item => Number.isFinite(item.startMinute) && Number.isFinite(item.endMinute) && item.endMinute > item.startMinute);

    const studentConflicts = new Set();
    const byStudent = new Map();
    prepared.forEach(item => {
      const name = String(item.entry.studentName || '').trim();
      if (!name || name === '학생 미입력') return;
      const key = studentGroupKey(name, item.entry.grade, item.entry.studentId);
      if (!byStudent.has(key)) byStudent.set(key, []);
      byStudent.get(key).push(item);
    });
    byStudent.forEach(items => {
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const a = items[i], b = items[j];
          // 같은 선생님·같은 수업이 중복 등록된 행은 빨간 겹침 경고로 보지 않는다.
          // 실제로 한 학생이 서로 다른 두 수업에 동시에 배정된 경우만 학생 충돌이다.
          const duplicateRegistration = a.teacherKey === b.teacherKey && a.lessonIdentity === b.lessonIdentity;
          if (overlaps(a, b) && !duplicateRegistration) {
            studentConflicts.add(a.index);
            studentConflicts.add(b.index);
          }
        }
      }
    });

    const rows = new Map();
    prepared.forEach(item => {
      if (!rows.has(item.teacherKey)) rows.set(item.teacherKey, {
        teacherKey: item.teacherKey,
        staffId: item.entry.staffId || '',
        teacherName: item.entry.teacherName || '담당 미지정',
        sessions: new Map()
      });
      const row = rows.get(item.teacherKey);
      const sessionKey = item.startMinute + '-' + item.endMinute + '|' + item.lessonIdentity;
      if (!row.sessions.has(sessionKey)) row.sessions.set(sessionKey, {
        startMinute: item.startMinute,
        endMinute: item.endMinute,
        lessonIdentity: item.lessonIdentity,
        label: (item.entry.slot || {}).label || clockText(item.startMinute) + '–' + clockText(item.endMinute),
        entries: [],
        sourceIndexes: [],
        lane: 0,
        teacherConflict: false,
        studentConflict: false
      });
      const session = row.sessions.get(sessionKey);
      session.entries.push(item.entry);
      session.sourceIndexes.push(item.index);
    });

    return Array.from(rows.values()).map(row => {
      const sessions = Array.from(row.sessions.values()).sort((a, b) =>
        a.startMinute - b.startMinute || a.endMinute - b.endMinute
      );
      for (let i = 0; i < sessions.length; i++) {
        sessions[i].studentConflictEntries = sessions[i].sourceIndexes
          .filter(index => studentConflicts.has(index))
          .map(index => (entries || [])[index])
          .filter(Boolean);
        sessions[i].studentConflict = sessions[i].studentConflictEntries.length > 0;
        for (let j = i + 1; j < sessions.length; j++) {
          if (!overlaps(sessions[i], sessions[j])) continue;
          sessions[i].teacherConflict = true;
          sessions[j].teacherConflict = true;
        }
      }
      const laneEnds = [];
      sessions.forEach(session => {
        let lane = laneEnds.findIndex(endMinute => endMinute <= session.startMinute);
        if (lane < 0) lane = laneEnds.length;
        session.lane = lane;
        laneEnds[lane] = session.endMinute;
        session.entries.sort((a, b) => String(a.studentName || '').localeCompare(String(b.studentName || ''), 'ko'));
        delete session.sourceIndexes;
      });
      return {
        teacherKey: row.teacherKey,
        staffId: row.staffId,
        teacherName: row.teacherName,
        sessions: sessions,
        laneCount: Math.max(1, laneEnds.length)
      };
    }).sort((a, b) => a.teacherName.localeCompare(b.teacherName, 'ko'));
  }

  function weeklyTeacherSummary(entries, options) {
    const byDate = new Map();
    (entries || []).forEach(entry => {
      const date = String(entry.date || '');
      if (!date) return;
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(entry);
    });

    const byTeacher = new Map();
    Array.from(byDate.keys()).sort().forEach(date => {
      timelineRows(byDate.get(date), Object.assign({}, options || {}, { date: date })).forEach(row => {
        if (!byTeacher.has(row.teacherKey)) byTeacher.set(row.teacherKey, {
          teacherKey: row.teacherKey,
          staffId: row.staffId,
          teacherName: row.teacherName,
          sessions: []
        });
        const teacher = byTeacher.get(row.teacherKey);
        row.sessions.forEach(session => teacher.sessions.push(Object.assign({ date: date }, session)));
      });
    });

    const allStudents = new Set();
    const teachers = Array.from(byTeacher.values()).map(teacher => {
      teacher.sessions.sort((a, b) => a.date.localeCompare(b.date) ||
        a.startMinute - b.startMinute || a.endMinute - b.endMinute ||
        a.lessonIdentity.localeCompare(b.lessonIdentity, 'ko'));
      const students = new Set();
      teacher.sessions.forEach(session => session.entries.forEach(entry => {
        const name = String(entry.studentName || '').trim();
        if (!name || name === '학생 미입력') return;
        const key = studentGroupKey(name, entry.grade, entry.studentId);
        students.add(key);
        allStudents.add(key);
      }));
      teacher.sessionCount = teacher.sessions.length;
      teacher.studentCount = students.size;
      teacher.durationMinutes = teacher.sessions.reduce((sum, session) =>
        sum + session.endMinute - session.startMinute, 0);
      teacher.conflictCount = teacher.sessions.filter(session => session.studentConflict).length;
      return teacher;
    }).sort((a, b) => a.teacherName.localeCompare(b.teacherName, 'ko'));

    return {
      teachers: teachers,
      totals: {
        sessionCount: teachers.reduce((sum, teacher) => sum + teacher.sessionCount, 0),
        studentCount: allStudents.size,
        teacherCount: teachers.length,
        durationMinutes: teachers.reduce((sum, teacher) => sum + teacher.durationMinutes, 0),
        conflictCount: teachers.reduce((sum, teacher) => sum + teacher.conflictCount, 0)
      }
    };
  }

  return {
    parseClockMinute: parseClockMinute,
    studentGroupKey: studentGroupKey,
    extractLessonRanges: extractLessonRanges,
    normalizedDays: normalizedDays,
    needsScheduleReview: needsScheduleReview,
    classifyTaskSchedule: classifyTaskSchedule,
    clockState: clockState,
    timelineRange: timelineRange,
    timelineRows: timelineRows,
    weeklyTeacherSummary: weeklyTeacherSummary
  };
});
