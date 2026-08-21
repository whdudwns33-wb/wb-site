(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WBLessonFormCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CLOCK_RE = /^(?:[01]?\d|2[0-3]):[0-5]\d$/;
  const RANGE_RE = /((?:[01]?\d|2[0-3]):[0-5]\d)\s*(?:-|–|—|−|~|～)\s*((?:[01]?\d|2[0-3]):[0-5]\d)/g;
  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
  const LESSON_HOURS = ['1T', '1.5T', '2T', '3T', '4T', '5T', '6T'];
  const DAY_BY_KO = { '일': 0, '월': 1, '화': 2, '수': 3, '목': 4, '금': 5, '토': 6 };
  const DAY_BY_EN = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const REQUIRED_FIELDS = [
    { key: 'student', fields: ['studentName', 'grade'], message: '학생 이름과 학년을 입력해 주세요' },
    { key: 'subjectClass', fields: ['subject', 'className'], any: true, message: '과목 또는 반을 입력해 주세요' },
    { key: 'lessonHours', fields: ['lessonHours'], message: '수업시수를 선택해 주세요' },
    { key: 'schedule', fields: ['scheduleText', 'scheduleSlots'], any: true, message: '수업 요일과 시간을 입력해 주세요' },
    { key: 'materials', fields: ['materials'], message: '교재와 현재 진도를 입력해 주세요' },
    { key: 'onlineProgram', fields: ['onlineProgram'], message: '온라인 프로그램을 입력해 주세요 (없으면 없음)' },
    { key: 'homework', fields: ['homework'], message: '숙제 루틴과 수행률을 입력해 주세요 (없으면 없음)' },
    { key: 'studentTraits', fields: ['studentTraits'], message: '학생 특징을 입력해 주세요' },
    { key: 'goal', fields: ['goal'], message: '지금 목표를 입력해 주세요 (없으면 없음)' },
    { key: 'parentRequest', fields: ['parentRequest'], message: '특이사항·학부모 요청을 입력해 주세요 (없으면 없음)' }
  ];

  function text(value) {
    return String(value == null ? '' : value)
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map(line => line.replace(/[\t ]+/g, ' ').trim())
      .join('\n')
      .trim();
  }

  function identityText(value) {
    return text(value).replace(/\s+/g, '').toLocaleLowerCase('ko-KR');
  }

  function normalizeLessonInput(raw) {
    const source = raw || {};
    return {
      staffId: text(source.staffId),
      staffName: text(source.staffName),
      studentId: text(source.studentId),
      studentName: text(source.studentName),
      grade: text(source.grade),
      subject: text(source.subject),
      className: text(source.className),
      lessonRole: text(source.lessonRole),
      lessonHours: text(source.lessonHours),
      scheduleText: text(source.scheduleText),
      scheduleSlots: Array.isArray(source.scheduleSlots) ? source.scheduleSlots.slice() : [],
      materials: text(source.materials),
      onlineProgram: text(source.onlineProgram),
      homework: text(source.homework),
      studentTraits: text(source.studentTraits),
      goal: text(source.goal),
      parentRequest: text(source.parentRequest),
      adminRequest: text(source.adminRequest) || '없음',
      start: text(source.start),
      end: text(source.end)
    };
  }

  function hasValue(value) {
    if (Array.isArray(value)) return value.length > 0;
    return text(value).length > 0;
  }

  function parseClockMinute(value) {
    const valueText = text(value);
    if (!CLOCK_RE.test(valueText)) return null;
    const parts = valueText.split(':').map(Number);
    return parts[0] * 60 + parts[1];
  }

  function clockText(minute) {
    const hour = String(Math.floor(minute / 60)).padStart(2, '0');
    const mins = String(minute % 60).padStart(2, '0');
    return hour + ':' + mins;
  }

  function normalizeDays(value) {
    const values = Array.isArray(value) ? value : [value];
    const days = [];
    values.forEach(item => {
      if (Number.isInteger(item) && item >= 0 && item <= 6) {
        days.push(item);
        return;
      }
      const valueText = text(item).toLowerCase();
      if (/^[0-6]$/.test(valueText)) {
        days.push(Number(valueText));
        return;
      }
      if (Object.prototype.hasOwnProperty.call(DAY_BY_EN, valueText)) {
        days.push(DAY_BY_EN[valueText]);
        return;
      }
      if (Object.prototype.hasOwnProperty.call(DAY_BY_KO, valueText.replace(/요일$/, ''))) {
        days.push(DAY_BY_KO[valueText.replace(/요일$/, '')]);
      }
    });
    return [...new Set(days)].sort((a, b) => a - b);
  }

  function parseDayPrefix(value) {
    let source = text(value).replace(/\s+/g, '');
    if (!source) return { days: [], valid: false };

    const days = [];
    if (source.includes('매일')) {
      days.push(0, 1, 2, 3, 4, 5, 6);
      source = source.replace(/매일/g, '');
    }
    if (source.includes('평일')) {
      days.push(1, 2, 3, 4, 5);
      source = source.replace(/평일/g, '');
    }

    source = source
      .replace(/방학(?:중|동안)/g, '')
      .replace(/매주/g, '')
      .replace(/수업/g, '')
      .replace(/요일/g, '');

    source = source.replace(/[일월화수목금토]/g, day => {
      days.push(DAY_BY_KO[day]);
      return '';
    });

    source = source.replace(/[\s,·&+()]/g, '').replace(/(?:및|와|과)/g, '');
    return {
      days: [...new Set(days)].sort((a, b) => a - b),
      valid: source === '' && days.length > 0
    };
  }

  function slotIssue(code, message, source) {
    return { code: code, message: message, source: text(source) };
  }

  function normalizeStructuredSlot(raw, index) {
    const source = raw || {};
    const days = normalizeDays(source.days == null ? source.day : source.days);
    const startMinute = parseClockMinute(source.startTime);
    const endMinute = parseClockMinute(source.endTime);
    if (!days.length || startMinute === null || endMinute === null || endMinute <= startMinute) {
      return {
        slot: null,
        issue: slotIssue(
          'invalid_slot',
          '각 시간대의 요일·시작·종료 시간을 확인해 주세요',
          JSON.stringify({ days: source.days, startTime: source.startTime, endTime: source.endTime })
        )
      };
    }

    const validFrom = text(source.validFrom || source.startDate);
    const validTo = text(source.validTo || source.endDate);
    if ((validFrom && !ISO_DATE_RE.test(validFrom)) || (validTo && !ISO_DATE_RE.test(validTo)) ||
        (validFrom && validTo && validFrom > validTo)) {
      return {
        slot: null,
        issue: slotIssue('invalid_slot_date', '시간대 적용 기간을 확인해 주세요', validFrom + '–' + validTo)
      };
    }

    const startTime = clockText(startMinute);
    const endTime = clockText(endMinute);
    const slotId = text(source.slotId) ||
      ('slot-' + days.join('') + '-' + startTime.replace(':', '') + '-' + endTime.replace(':', ''));
    return {
      slot: {
        slotId: slotId,
        days: days,
        startTime: startTime,
        endTime: endTime,
        lessonRole: text(source.lessonRole),
        validFrom: validFrom,
        validTo: validTo
      },
      issue: null
    };
  }

  function parseFreeTextSlot(segment, index) {
    const ranges = [];
    let match;
    RANGE_RE.lastIndex = 0;
    while ((match = RANGE_RE.exec(segment))) {
      ranges.push({
        index: match.index,
        length: match[0].length,
        startTime: match[1],
        endTime: match[2]
      });
    }
    if (ranges.length !== 1) {
      return {
        slot: null,
        issue: slotIssue('ambiguous_schedule', '각 구간에 요일과 시작·종료 시간을 하나씩 입력해 주세요', segment)
      };
    }

    const range = ranges[0];
    const prefix = segment.slice(0, range.index);
    const suffix = segment.slice(range.index + range.length);
    const parsedDays = parseDayPrefix(prefix);
    const remaining = text(suffix).replace(/[\s,·.()]/g, '').replace(/(?:수업)$/g, '');
    if (!parsedDays.valid || remaining) {
      return {
        slot: null,
        issue: slotIssue('ambiguous_schedule', '요일별 시간을 추정하지 않고 확인 필요로 저장합니다', segment)
      };
    }

    return normalizeStructuredSlot({
      slotId: 'slot-' + (index + 1),
      days: parsedDays.days,
      startTime: range.startTime,
      endTime: range.endTime
    }, index);
  }

  function findConflicts(slots) {
    const conflicts = [];
    for (let i = 0; i < slots.length; i += 1) {
      for (let j = i + 1; j < slots.length; j += 1) {
        const left = slots[i];
        const right = slots[j];
        const sharedDay = left.days.some(day => right.days.includes(day));
        if (!sharedDay) continue;
        const leftStart = parseClockMinute(left.startTime);
        const leftEnd = parseClockMinute(left.endTime);
        const rightStart = parseClockMinute(right.startTime);
        const rightEnd = parseClockMinute(right.endTime);
        if (leftStart < rightEnd && rightStart < leftEnd) {
          conflicts.push(slotIssue(
            'overlapping_slots',
            '같은 요일에 겹치는 시간대가 있습니다',
            left.startTime + '–' + left.endTime + ' / ' + right.startTime + '–' + right.endTime
          ));
        }
      }
    }
    return conflicts;
  }

  function canonicalizeSlots(slots) {
    const seen = new Set();
    return slots
      .filter(slot => {
        const key = [slot.days.join(','), slot.startTime, slot.endTime, slot.lessonRole, slot.validFrom, slot.validTo].join('|');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) =>
        Math.min.apply(null, a.days) - Math.min.apply(null, b.days) ||
        a.startTime.localeCompare(b.startTime) ||
        a.endTime.localeCompare(b.endTime) ||
        a.days.join(',').localeCompare(b.days.join(','))
      );
  }

  function parseTextSchedule(scheduleText) {
    const issues = [];
    const slots = [];
    const segments = text(scheduleText).split(/(?:\/|;|\n)+/).map(item => text(item)).filter(Boolean);
    segments.forEach((segment, index) => {
      const result = parseFreeTextSlot(segment, index);
      if (result.issue) issues.push(result.issue);
      if (result.slot) slots.push(result.slot);
    });
    const normalized = canonicalizeSlots(slots);
    issues.push.apply(issues, findConflicts(normalized));
    return { slots: normalized, issues: issues };
  }

  function resolveSchedule(raw) {
    const input = normalizeLessonInput(raw);
    const issues = [];
    let normalizedSlots = [];

    if (input.scheduleSlots.length) {
      const structuredSlots = [];
      input.scheduleSlots.forEach((item, index) => {
        const result = normalizeStructuredSlot(item, index);
        if (result.issue) issues.push(result.issue);
        if (result.slot) structuredSlots.push(result.slot);
      });
      normalizedSlots = canonicalizeSlots(structuredSlots);
      issues.push.apply(issues, findConflicts(normalizedSlots));
    } else if (input.scheduleText) {
      const parsedText = parseTextSchedule(input.scheduleText);
      normalizedSlots = parsedText.slots;
      issues.push.apply(issues, parsedText.issues);
    } else {
      issues.push(slotIssue('missing_schedule', '수업 요일과 시간을 입력해 주세요', ''));
    }

    if (issues.length || !normalizedSlots.length) {
      return { scheduleSlots: [], scheduleStatus: 'needs_review', issues: issues };
    }
    return { scheduleSlots: normalizedSlots, scheduleStatus: 'normal', issues: [] };
  }

  function validateLessonInput(raw) {
    const input = normalizeLessonInput(raw);
    const errors = [];
    REQUIRED_FIELDS.forEach(group => {
      const values = group.fields.map(field => input[field]);
      const valid = group.any ? values.some(hasValue) : values.every(hasValue);
      if (!valid) errors.push({ field: group.key, message: group.message });
    });
    if (input.studentId && !SAFE_ID_RE.test(input.studentId)) {
      errors.push({ field: 'studentId', message: '학생 식별자를 확인해 주세요' });
    }
    if (input.lessonHours && !LESSON_HOURS.includes(input.lessonHours)) {
      errors.push({ field: 'lessonHours', message: '수업시수는 1T, 1.5T, 2T, 3T, 4T, 5T, 6T 중에서 선택해 주세요' });
    }
    const schedule = resolveSchedule(input);
    return {
      valid: errors.length === 0,
      errors: errors,
      warnings: schedule.issues.slice(),
      input: input,
      schedule: schedule
    };
  }

  function hash32(value, seed) {
    let hash = seed >>> 0;
    const source = String(value);
    for (let i = 0; i < source.length; i += 1) {
      hash ^= source.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function canonicalLessonIdentity(raw, options) {
    const input = normalizeLessonInput(raw);
    const opts = options || {};
    const staffIdentity = text(opts.staffId || input.staffId || opts.staffName || input.staffName || 'unassigned');
    if (input.studentId) {
      if (!SAFE_ID_RE.test(input.studentId)) throw new Error('학생 식별자를 확인해 주세요');
      return [
        'lesson-v1',
        identityText(staffIdentity),
        'student-id:' + input.studentId,
        identityText(input.subject),
        identityText(input.className),
        identityText(input.lessonRole)
      ].join('|');
    }
    return [
      'lesson-v1',
      identityText(staffIdentity),
      identityText(input.studentName),
      identityText(input.grade),
      identityText(input.subject),
      identityText(input.className),
      identityText(input.lessonRole)
    ].join('|');
  }

  function buildDedupeIdentity(raw, options) {
    const canonical = canonicalLessonIdentity(raw, options);
    return 'lesson:v1:' + hash32(canonical, 2166136261) + hash32(canonical.split('').reverse().join(''), 3335557771);
  }

  function scheduleCompatibility(schedule) {
    const slots = schedule.scheduleSlots;
    if (!slots.length) return { repeat: 'once', days: [], time: '' };
    const days = [...new Set(slots.flatMap(slot => slot.days))].sort((a, b) => a - b);
    let repeat = 'days';
    if (days.join(',') === '1,2,3,4,5') repeat = 'weekday';
    if (days.join(',') === '0,1,2,3,4,5,6') repeat = 'daily';
    const startTimes = [...new Set(slots.map(slot => slot.startTime))];
    return { repeat: repeat, days: days, time: startTimes.length === 1 ? startTimes[0] : '' };
  }

  function subjectClassLabel(input) {
    const values = [input.subject, input.className].filter(Boolean);
    return [...new Set(values)].join(' · ') || '수업';
  }

  function scheduleTextFromSlots(slots) {
    const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
    const displayRank = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 0: 6 };
    return slots.slice().sort((left, right) =>
      Math.min.apply(null, left.days.map(day => displayRank[day])) - Math.min.apply(null, right.days.map(day => displayRank[day])) ||
      left.startTime.localeCompare(right.startTime) || left.endTime.localeCompare(right.endTime)
    ).map(slot =>
      slot.days.slice().sort((left, right) => displayRank[left] - displayRank[right]).map(day => dayNames[day]).join('·') +
        ' ' + slot.startTime + '-' + slot.endTime
    ).join(' / ');
  }

  function buildLessonTaskBody(raw, options) {
    const validation = validateLessonInput(raw);
    if (!validation.valid) {
      const error = new Error(validation.errors.map(item => item.message).join('\n'));
      error.code = 'LESSON_FORM_INVALID';
      error.validationErrors = validation.errors;
      throw error;
    }

    const input = validation.input;
    const opts = options || {};
    const schedule = validation.schedule;
    const compatibility = scheduleCompatibility(schedule);
    const dedupeKey = buildDedupeIdentity(input, opts);
    const role = input.lessonRole || input.className || input.subject;
    const scheduleText = schedule.scheduleSlots.length
      ? scheduleTextFromSlots(schedule.scheduleSlots)
      : input.scheduleText;
    const detail = [
      '수업 요일·시간: ' + scheduleText,
      '교재와 현재 진도: ' + input.materials,
      '온라인 프로그램: ' + input.onlineProgram
    ].join('\n');
    const guide = [
      '숙제 루틴과 수행률: ' + input.homework,
      '학생 특징: ' + input.studentTraits,
      '지금 목표: ' + input.goal,
      '특이사항·학부모 요청: ' + input.parentRequest,
      '관리자 요청사항: ' + input.adminRequest
    ].join('\n');

    return {
      dedupeKey: dedupeKey,
      intakeSource: 'teacher_9_field_form',
      intakeVersion: 1,
      studentId: input.studentId,
      studentName: input.studentName,
      grade: input.grade,
      subject: input.subject,
      className: input.className,
      lessonRole: role,
      lessonHours: input.lessonHours,
      scheduleText: scheduleText,
      scheduleSlots: schedule.scheduleSlots,
      scheduleStatus: schedule.scheduleStatus,
      materials: input.materials,
      onlineProgram: input.onlineProgram,
      homework: input.homework,
      studentTraits: input.studentTraits,
      goal: input.goal,
      parentRequest: input.parentRequest,
      adminRequest: input.adminRequest,
      title: '[수업] ' + input.studentName + ' (' + input.grade + ') — ' + subjectClassLabel(input),
      detail: detail,
      guide: guide,
      steps: [
        { id: 'lesson-progress', label: '교재·현재 진도 확인' },
        { id: 'lesson-homework', label: '숙제 수행 및 오답 확인' },
        { id: 'lesson-goal', label: '수업 목표에 맞춰 지도' }
      ],
      target: 0,
      unit: '건',
      time: compatibility.time,
      priority: 'normal',
      repeat: compatibility.repeat,
      days: compatibility.days,
      start: text(opts.start || input.start),
      end: text(opts.end || input.end),
      carry: true,
      deleted: false
    };
  }

  return {
    REQUIRED_FIELDS: REQUIRED_FIELDS,
    LESSON_HOURS: LESSON_HOURS,
    normalizeLessonInput: normalizeLessonInput,
    normalizeDays: normalizeDays,
    resolveSchedule: resolveSchedule,
    validateLessonInput: validateLessonInput,
    canonicalLessonIdentity: canonicalLessonIdentity,
    buildDedupeIdentity: buildDedupeIdentity,
    buildLessonTaskBody: buildLessonTaskBody
  };
});
