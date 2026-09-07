const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MIN_DATE = '0001-01-01';
const MAX_DATE = '9999-12-31';
const ACTIVE_MAKEUP_STATUSES = new Set(['confirmed', 'completed']);
const CONFLICT_CODES = new Set([
  'STUDENT_SCHEDULE_CONFLICT',
  'STUDENT_MAKEUP_CONFLICT',
  'SCHEDULE_UNCONFIRMED',
  'MAKEUP_TIME_CONFLICT'
]);

function parseJson(value) {
  try { return JSON.parse(String(value || '')); } catch (error) { return null; }
}

function validDate(value) {
  const text = String(value || '');
  if (!ISO_DATE.test(text)) return '';
  const parsed = new Date(text + 'T00:00:00Z');
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : '';
}

function taskWindow(task) {
  const rawStart = String(task && (task.start || task.startDate) || '');
  const rawEnd = String(task && (task.end || task.endDate) || '');
  const start = rawStart ? validDate(rawStart) : MIN_DATE;
  const end = rawEnd ? validDate(rawEnd) : MAX_DATE;
  if (!start || !end || start > end) return { from: MIN_DATE, to: MAX_DATE, valid: false };
  if (String(task && task.repeat || '') === 'once') {
    return rawStart && start ? { from: start, to: start, valid: true } :
      { from: MIN_DATE, to: MAX_DATE, valid: false };
  }
  return { from: start, to: end, valid: true };
}

function intersectWindow(left, right) {
  const from = left.from > right.from ? left.from : right.from;
  const to = left.to < right.to ? left.to : right.to;
  return from <= to ? { from, to } : null;
}

function weekday(date) {
  return new Date(date + 'T00:00:00Z').getUTCDay();
}

function windowContainsWeekday(window, wantedDay) {
  const parsed = new Date(window.from + 'T00:00:00Z');
  const offset = (wantedDay - parsed.getUTCDay() + 7) % 7;
  parsed.setUTCDate(parsed.getUTCDate() + offset);
  return parsed.getTime() <= Date.parse(window.to + 'T00:00:00Z');
}

function overlap(start, end, otherStart, otherEnd) {
  // 맞닿기만 하는 수업(예: 15:00 종료, 15:00 시작)은 겹침이 아니다.
  return start < otherEnd && otherStart < end;
}

export function isRegularLessonScheduleTask(task) {
  // 제목의 [수업] 접두어만으로 분류하면 일반 task가 수업을 가장해 정상 등록을 막을 수 있다.
  // 서버가 발급하는 구조화 표식이 있는 수업만 권한·중복 판정의 정본으로 사용한다.
  return !!task && typeof task === 'object' && !Array.isArray(task) && !task.deleted &&
    String(task.lessonInstanceType || '') !== 'makeup' && !String(task.makeupCaseId || '').trim() &&
    (task.taskKind === 'lesson_instruction' || Number(task.lessonFormVersion || 0) >= 1 ||
      Number(task.intakeVersion || 0) >= 1 ||
      task.intakeSource === 'teacher_9_field_form');
}

function scheduleForTask(task) {
  const window = taskWindow(task);
  const rawSlots = Array.isArray(task && task.scheduleSlots) ? task.scheduleSlots : [];
  if (!window.valid || String(task && task.scheduleStatus || '') === 'needs_review' || !rawSlots.length) {
    return { window, confirmed: false, slots: [] };
  }

  const slots = [];
  for (const raw of rawSlots) {
    const days = Array.isArray(raw && raw.days)
      ? [...new Set(raw.days.map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6))]
      : [];
    const startTime = String(raw && raw.startTime || '');
    const endTime = String(raw && raw.endTime || '');
    const rawFrom = String(raw && (raw.validFrom || raw.startDate) || '');
    const rawTo = String(raw && (raw.validTo || raw.endDate) || '');
    const slotWindow = {
      from: rawFrom ? validDate(rawFrom) : window.from,
      to: rawTo ? validDate(rawTo) : window.to
    };
    if (String(raw && raw.status || '') === 'needs_review' || !days.length ||
        !HHMM.test(startTime) || !HHMM.test(endTime) || startTime >= endTime ||
        !slotWindow.from || !slotWindow.to || slotWindow.from > slotWindow.to) {
      return { window, confirmed: false, slots: [] };
    }
    const effectiveWindow = intersectWindow(window, slotWindow);
    if (!effectiveWindow) continue;
    slots.push({ days, startTime, endTime, window: effectiveWindow });
  }
  return { window, confirmed: true, slots };
}

function conflictError(code) {
  const messages = {
    STUDENT_SCHEDULE_CONFLICT: '같은 학생의 정규 수업과 시간이 겹칩니다. 기존 수업 시간을 확인해 주세요',
    STUDENT_MAKEUP_CONFLICT: '같은 학생의 확정·완료 보강과 시간이 겹칩니다. 보강 일정을 확인해 주세요',
    SCHEDULE_UNCONFIRMED: '같은 학생의 기존 수업 시간이 확정되지 않아 겹침을 확인할 수 없습니다. 기존 시간표를 먼저 확정해 주세요',
    MAKEUP_TIME_CONFLICT: '같은 학생의 다른 확정·완료 보강과 시간이 겹칩니다. 보강 일정을 확인해 주세요'
  };
  const error = new Error(messages[code]);
  error.status = 409;
  error.code = code;
  return error;
}

function regularPairConflict(leftTask, rightTask) {
  const left = scheduleForTask(leftTask);
  const right = scheduleForTask(rightTask);
  if (!intersectWindow(left.window, right.window)) return '';
  if (!left.confirmed || !right.confirmed) return 'SCHEDULE_UNCONFIRMED';

  for (const leftSlot of left.slots) {
    for (const rightSlot of right.slots) {
      if (!overlap(leftSlot.startTime, leftSlot.endTime, rightSlot.startTime, rightSlot.endTime)) continue;
      const dateWindow = intersectWindow(leftSlot.window, rightSlot.window);
      if (!dateWindow) continue;
      for (const day of leftSlot.days) {
        if (rightSlot.days.includes(day) && windowContainsWeekday(dateWindow, day)) {
          return 'STUDENT_SCHEDULE_CONFLICT';
        }
      }
    }
  }
  return '';
}

function regularSelfConflict(task) {
  const schedule = scheduleForTask(task);
  if (!schedule.confirmed) return '';
  for (let leftIndex = 0; leftIndex < schedule.slots.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < schedule.slots.length; rightIndex += 1) {
      const left = schedule.slots[leftIndex];
      const right = schedule.slots[rightIndex];
      if (!overlap(left.startTime, left.endTime, right.startTime, right.endTime)) continue;
      const dateWindow = intersectWindow(left.window, right.window);
      if (!dateWindow) continue;
      if (left.days.some(day => right.days.includes(day) && windowContainsWeekday(dateWindow, day))) {
        return 'STUDENT_SCHEDULE_CONFLICT';
      }
    }
  }
  return '';
}

function makeupRange(row) {
  if (!row || !ACTIVE_MAKEUP_STATUSES.has(String(row.status || ''))) return null;
  const startAt = String(row.confirmed_start_at || '');
  const endAt = String(row.confirmed_end_at || '');
  const date = validDate(startAt.slice(0, 10));
  const endDate = validDate(endAt.slice(0, 10));
  const startTime = startAt.slice(11, 16);
  const endTime = endAt.slice(11, 16);
  if (!date || endDate !== date || !HHMM.test(startTime) || !HHMM.test(endTime) || startTime >= endTime) {
    return { valid: false };
  }
  return { valid: true, date, startTime, endTime };
}

function regularMakeupConflict(task, row) {
  const schedule = scheduleForTask(task);
  const range = makeupRange(row);
  if (!range) return '';
  if (!range.valid) return 'SCHEDULE_UNCONFIRMED';
  if (range.date < schedule.window.from || range.date > schedule.window.to) return '';
  if (!schedule.confirmed) return 'SCHEDULE_UNCONFIRMED';
  const day = weekday(range.date);
  return schedule.slots.some(slot =>
    range.date >= slot.window.from && range.date <= slot.window.to && slot.days.includes(day) &&
    overlap(slot.startTime, slot.endTime, range.startTime, range.endTime)
  ) ? 'STUDENT_MAKEUP_CONFLICT' : '';
}

/**
 * 한 학생의 정규수업 및 확정·완료 보강을 하나의 시간축으로 검사한다.
 * 이름·담당자·과목은 식별 조건이 아니며 stable studentId만 사용한다.
 */
export function assertStudentScheduleSnapshot(candidates, existingTasks, makeupRows) {
  const lessons = (Array.isArray(candidates) ? candidates : [])
    .filter(isRegularLessonScheduleTask)
    .filter(task => String(task.studentId || ''));
  if (!lessons.length) return;

  const existing = (Array.isArray(existingTasks) ? existingTasks : []).map(row => {
    const parsed = row && row.task || parseJson(row && row.data);
    return parsed && !parsed.id && row && row.id ? { ...parsed, id: String(row.id) } : parsed;
  }).filter(isRegularLessonScheduleTask);
  const makeups = Array.isArray(makeupRows) ? makeupRows : [];

  for (const candidate of lessons) {
    const studentId = String(candidate.studentId || '');
    const selfCode = regularSelfConflict(candidate);
    if (selfCode) throw conflictError(selfCode);
    for (const current of existing) {
      if (String(current.studentId || '') !== studentId) continue;
      if (String(candidate.id || '') && String(current.id || '') === String(candidate.id || '')) continue;
      const code = regularPairConflict(candidate, current);
      if (code) throw conflictError(code);
    }
    for (const row of makeups) {
      if (String(row && row.student_id || '') !== studentId) continue;
      const code = regularMakeupConflict(candidate, row);
      if (code) throw conflictError(code);
    }
  }

  for (let leftIndex = 0; leftIndex < lessons.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < lessons.length; rightIndex += 1) {
      const left = lessons[leftIndex];
      const right = lessons[rightIndex];
      if (String(left.studentId || '') !== String(right.studentId || '') ||
          (left.id && String(left.id) === String(right.id || ''))) continue;
      const code = regularPairConflict(left, right);
      if (code) throw conflictError(code);
    }
  }
}

export async function assertStudentLessonScheduleAvailable(env, app, candidates) {
  const lessons = (Array.isArray(candidates) ? candidates : [candidates])
    .filter(isRegularLessonScheduleTask)
    .filter(task => String(task.studentId || ''));
  if (!lessons.length) return;
  const [taskResult, makeupResult] = await Promise.all([
    env.DB.prepare('SELECT id,owner,data FROM tasks WHERE app=?').bind(app).all(),
    env.DB.prepare(
      "SELECT case_id,student_id,status,confirmed_start_at,confirmed_end_at FROM makeup_cases " +
      "WHERE app=? AND status IN ('confirmed','completed')"
    ).bind(app).all()
  ]);
  assertStudentScheduleSnapshot(lessons, taskResult && taskResult.results, makeupResult && makeupResult.results);
}

function codeFromError(error) {
  const direct = String(error && error.code || '');
  if (CONFLICT_CODES.has(direct)) return direct;
  const message = String(error && error.message || error || '');
  return [...CONFLICT_CODES].find(code => message.includes(code)) || '';
}

export function studentScheduleConflictPayload(error) {
  const code = codeFromError(error);
  if (!code) return null;
  return { ok: false, code, error: conflictError(code).message };
}
