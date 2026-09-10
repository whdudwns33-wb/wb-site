const SAFE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function validDate(value) {
  const text = String(value || '');
  if (!SAFE_DATE.test(text)) return false;
  const date = new Date(text + 'T00:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function dayOf(value) {
  return new Date(String(value) + 'T00:00:00Z').getUTCDay();
}

function clockMinute(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):([0-5]\d)$/);
  if (!match || Number(match[1]) > 23) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function clockText(minute) {
  return String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
}

function activeOnDate(task, date) {
  if (!task || task.deleted || !validDate(date)) return false;
  const from = String(task.start || task.startDate || '');
  const to = String(task.end || task.endDate || '');
  return (!from || from <= date) && (!to || to >= date);
}

function slotActiveOnDate(slot, date) {
  const from = String(slot && (slot.validFrom || slot.startDate) || '');
  const to = String(slot && (slot.validTo || slot.endDate) || '');
  return (!from || from <= date) && (!to || to >= date);
}

/**
 * 한 수업의 특정 날짜 시간대만 계산한다. 구조화된 확정 시간표를 우선하고,
 * 구형 업무는 repeat/days/time을 제한적으로 보완한다. 비정기 방문 기록은
 * 별도 원장의 실제 날짜와 정규 수업을 섞지 않도록 여기서 제외한다.
 */
export function lessonOccurrencesOnDate(task, date) {
  if (!activeOnDate(task, date) || task.scheduleStatus === 'needs_review' ||
      task.lessonInstanceType === 'makeup' || task.makeupCaseId) return [];
  const day = dayOf(date);
  const slots = Array.isArray(task.scheduleSlots) ? task.scheduleSlots : [];
  if (slots.length) {
    return slots.filter(slot => slotActiveOnDate(slot, date) &&
      Array.isArray(slot && slot.days) && slot.days.map(Number).includes(day))
      .map(slot => ({
        slotId: String(slot.slotId || ''),
        startTime: String(slot.startTime || '').trim(),
        endTime: String(slot.endTime || '').trim(),
        lessonHours: String(slot.lessonHours || task.lessonHours || '').trim()
      }))
      .filter(slot => clockMinute(slot.startTime) !== null && clockMinute(slot.endTime) !== null &&
        clockMinute(slot.endTime) > clockMinute(slot.startTime));
  }

  const repeat = String(task.repeat || '');
  const scheduled = repeat === 'daily' ||
    (repeat === 'weekday' && day >= 1 && day <= 5) ||
    (repeat === 'days' && Array.isArray(task.days) && task.days.map(Number).includes(day)) ||
    (repeat === 'once' && String(task.start || '') === date);
  if (!scheduled) return [];
  const start = String(task.time || '').trim();
  const minute = clockMinute(start);
  return minute === null ? [] : [{ slotId: '', startTime: clockText(minute), endTime: '', lessonHours: String(task.lessonHours || '') }];
}

function isLessonTask(task) {
  return !!(task && !task.deleted &&
    (task.taskKind === 'lesson_instruction' || task.lessonFormVersion || task.intakeVersion ||
      /^\[(수업|컨설팅)\]/.test(String(task.title || ''))));
}

function candidateSort(left, right) {
  return left.startMinute - right.startMinute ||
    (left.endMinute == null ? 0 : left.endMinute) - (right.endMinute == null ? 0 : right.endMinute) ||
    String(left.subject || '').localeCompare(String(right.subject || ''), 'ko') ||
    String(left.teacherName || '').localeCompare(String(right.teacherName || ''), 'ko') ||
    String(left.taskId || '').localeCompare(String(right.taskId || ''));
}

/**
 * 현재 수업 담당 교사가 같은 학생의 이후 수업을 안내할 수 있도록, 가장 가까운
 * 한 건만 고른다. 이름으로 연결하지 않고 양쪽 모두 stable studentId가 있는
 * 경우에만 동작한다.
 */
export function findNextStudentLesson(tasks, currentTaskId, date, teacherNames = {}) {
  const current = (Array.isArray(tasks) ? tasks : []).find(task =>
    task && String(task.id || '') === String(currentTaskId || '') && isLessonTask(task));
  if (!current || !SAFE_ID.test(String(current.studentId || '')) || !validDate(date)) return null;
  const currentOccurrences = lessonOccurrencesOnDate(current, date);
  const currentStart = currentOccurrences.length
    ? Math.min(...currentOccurrences.map(slot => clockMinute(slot.startTime)))
    : clockMinute(current.time);
  if (currentStart === null) return null;

  const candidates = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!isLessonTask(task) || String(task.id || '') === String(current.id || '') ||
        String(task.studentId || '') !== String(current.studentId || '')) continue;
    const occurrences = lessonOccurrencesOnDate(task, date);
    for (const slot of occurrences) {
      const startMinute = clockMinute(slot.startTime);
      if (startMinute === null || startMinute <= currentStart) continue;
      const endMinute = clockMinute(slot.endTime);
      candidates.push({
        taskId: String(task.id), studentId: String(task.studentId),
        subject: String(task.subject || task.className || '').trim(),
        className: String(task.className || '').trim(),
        startTime: slot.startTime, endTime: slot.endTime,
        lessonHours: slot.lessonHours || String(task.lessonHours || '').trim(),
        startMinute, endMinute, teacherName: String(teacherNames[String(task.staffId || task.owner || '')] || '').trim(),
        staffId: String(task.staffId || task.owner || ''),
        lessonInstanceType: String(task.lessonInstanceType || '')
      });
    }
  }
  candidates.sort(candidateSort);
  return candidates[0] || null;
}

/** API 응답으로 내보낼 허용 필드만 남긴다. 메모·출결·업무지시는 절대 포함하지 않는다. */
export function projectNextStudentLesson(value, date) {
  if (!value || !SAFE_ID.test(String(value.taskId || '')) || !SAFE_ID.test(String(value.studentId || ''))) return null;
  return {
    taskId: String(value.taskId), studentId: String(value.studentId), lessonDate: String(date || ''),
    subject: String(value.subject || '').slice(0, 80), className: String(value.className || '').slice(0, 100),
    startTime: String(value.startTime || '').slice(0, 5), endTime: String(value.endTime || '').slice(0, 5),
    lessonHours: String(value.lessonHours || '').slice(0, 4), staffId: SAFE_ID.test(String(value.staffId || '')) ? String(value.staffId) : '',
    teacherName: String(value.teacherName || '').slice(0, 80),
    lessonInstanceType: String(value.lessonInstanceType || '') === 'makeup' ? 'makeup' : 'regular'
  };
}

export { clockMinute, validDate };
