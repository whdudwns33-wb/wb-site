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

  function appliesOn(slot, date, dow, fallbackOccurs) {
    const validFrom = String(slot.validFrom || slot.startDate || '');
    const validTo = String(slot.validTo || slot.endDate || '');
    if (validFrom && date < validFrom) return false;
    if (validTo && date > validTo) return false;
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
    const role = String(task.lessonRole || '').trim();
    const structured = Array.isArray(task.scheduleSlots) ? task.scheduleSlots : [];

    if (structured.length) {
      const slots = [];
      const issues = [];
      structured.forEach((raw, index) => {
        const slot = raw || {};
        if (!appliesOn(slot, date, dow, fallbackOccurs)) return;
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
    if (!fallbackOccurs && !review) return { slots: [], issues: [], sourceType: 'legacy' };
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
    if (fallbackOccurs || review) {
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
    if (nowMinute >= slot.endMinute) return 'ended';
    return 'current';
  }

  return {
    parseClockMinute: parseClockMinute,
    extractLessonRanges: extractLessonRanges,
    normalizedDays: normalizedDays,
    needsScheduleReview: needsScheduleReview,
    classifyTaskSchedule: classifyTaskSchedule,
    clockState: clockState
  };
});
