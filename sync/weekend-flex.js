const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKEND_DAYS = new Set([0, 6]);
const MAX_MONTHLY_TARGET = 31;

function validDate(value) {
  const date = String(value || '');
  if (!DATE_RE.test(date)) return false;
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
}

function dayOf(value) {
  if (!validDate(value)) return -1;
  const [year, month, day] = String(value).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function flexibleWeekendConfig(task) {
  if (!task || task.weekendAttendanceMode !== 'flexible') return null;
  const days = Array.isArray(task.weekendAllowedDays)
    ? [...new Set(task.weekendAllowedDays)].sort((left, right) => left - right) : [];
  const target = task.weekendMonthlyTarget == null || task.weekendMonthlyTarget === ''
    ? null : task.weekendMonthlyTarget;
  const flexibleFrom = String(task.weekendFlexibleFrom || '');
  if (!days.length || days.some(day => !Number.isInteger(day) || !WEEKEND_DAYS.has(day)) ||
      (target != null && (!Number.isInteger(target) || target < 1 || target > MAX_MONTHLY_TARGET)) ||
      !validDate(flexibleFrom)) return null;
  return { mode: 'flexible', allowedDays: days, monthlyTarget: target, flexibleFrom };
}

/**
 * A configured future transition keeps the original recurrence until its effective date.
 * A malformed server record never silently falls back to a fixed timetable.
 */
export function weekendAttendancePolicyOn(task, date) {
  if (!task || task.weekendAttendanceMode !== 'flexible') return 'fixed';
  const config = flexibleWeekendConfig(task);
  if (!config || !validDate(date)) return 'invalid';
  return String(date) >= config.flexibleFrom ? 'flexible' : 'fixed';
}

export function flexibleWeekendEffectiveOn(task, date) {
  const config = flexibleWeekendConfig(task);
  return !!(config && weekendAttendancePolicyOn(task, date) === 'flexible' && !task.deleted &&
    (!task.start || String(task.start) <= date) && (!task.end || String(task.end) >= date) &&
    WEEKEND_DAYS.has(dayOf(date)));
}

export function flexibleWeekendAllowedOn(task, date) {
  const config = flexibleWeekendConfig(task);
  return !!(config && flexibleWeekendEffectiveOn(task, date) && config.allowedDays.includes(dayOf(date)));
}

/**
 * Stable lesson task ID + studentId + actual weekend date must all match the
 * non-cancelled visit ledger. Names and similar timetables are never used.
 */
export async function hasWeekendActualVisit(env, app, task, date) {
  const taskId = String(task && task.id || '');
  const studentId = String(task && task.studentId || '');
  if (app !== 'task' || !SAFE_ID.test(taskId) || !SAFE_ID.test(studentId) ||
      !task || task.deleted || !validDate(date) || !WEEKEND_DAYS.has(dayOf(date)) ||
      (task.start && String(task.start) > String(date)) ||
      (task.end && String(task.end) < String(date))) return false;
  const row = await env.DB.prepare(
    "SELECT visit_id FROM weekend_actual_visits WHERE app=? AND lesson_task_id=? " +
    "AND student_id=? AND visit_date=? AND status<>'cancelled' LIMIT 1"
  ).bind(app, taskId, studentId, String(date)).first();
  return !!row;
}

export async function hasFlexibleWeekendVisit(env, app, task, date) {
  if (!flexibleWeekendEffectiveOn(task, date)) return false;
  return await hasWeekendActualVisit(env, app, task, date);
}

export const weekendFlexInternals = Object.freeze({ validDate, dayOf, WEEKEND_DAYS, MAX_MONTHLY_TARGET });
