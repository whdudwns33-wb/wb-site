// 기존 taskId와 기록은 유지하고 시간표의 유효기간만 분리한다.
const iso = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) &&
  !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const beforeDay = d => new Date(Date.parse(d) - 86400000).toISOString().slice(0, 10);
function fail(message) { const e = new Error(message); e.code = 'LESSON_HISTORY_PROTECTED'; e.status = 409; throw e; }
function signature(slots) {
  return JSON.stringify((slots || []).map(s => [Array.from(s.days || []).map(Number).sort(), s.startTime || '',
    s.endTime || '', s.lessonHours || '', s.validFrom || s.startDate || '', s.validTo || s.endDate || ''])
    .sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
export function lessonOccursForHistory(t, date) {
  if (!iso(date) || t.deleted || (t.start && date < t.start) || (t.end && date > t.end)) return false;
  if (t.repeat === 'once') return date === t.start;
  const day = new Date(date + 'T12:00:00Z').getUTCDay();
  if (t.scheduleSlots?.length) return t.scheduleSlots.some(s =>
    (!(s.validFrom || s.startDate) || (s.validFrom || s.startDate) <= date) &&
    (!(s.validTo || s.endDate) || date <= (s.validTo || s.endDate)) && (s.days || []).map(Number).includes(day));
  return t.repeat === 'daily' || (t.repeat === 'weekday' && day > 0 && day < 6) ||
    (t.repeat === 'days' && (t.days || []).map(Number).includes(day));
}
export function preserveLessonHistory(current, candidate, effectiveDate, options = {}) {
  const changed = signature(current.scheduleSlots) !== signature(candidate.scheduleSlots) || current.repeat !== candidate.repeat;
  const transferred = current.staffId !== candidate.staffId;
  if ((changed || transferred || current.start !== candidate.start) && !iso(effectiveDate)) {
    fail('변경 적용일을 선택해 주세요. 기존 수업 시작일과 과거 기록은 유지됩니다');
  }
  const next = { ...candidate, start: current.start || candidate.start, end: current.end || '' };
  if (!changed) { next.scheduleSlots = structuredClone(current.scheduleSlots || []); return next; }
  if (!current.scheduleSlots?.length || !candidate.scheduleSlots?.length || candidate.repeat !== 'days') {
    if (!current.scheduleSlots?.length && candidate.scheduleSlots?.length && options.allowLegacyConversion) return next;
    fail('기존 수업 기록 보호를 위해 확정 요일·시간표로 변경해 주세요');
  }
  if (current.start && effectiveDate < current.start) fail('변경 적용일은 최초 수업 시작일 이후여야 합니다');
  const oldSlots = current.scheduleSlots.filter(s => (s.validFrom || s.startDate || current.start || '') < effectiveDate)
    .map(s => ({ ...s, validTo: ((s.validTo || s.endDate) && (s.validTo || s.endDate) < effectiveDate) ? (s.validTo || s.endDate) : beforeDay(effectiveDate) }));
  const newSlots = candidate.scheduleSlots.filter(s => !(s.validTo || s.endDate) || (s.validTo || s.endDate) >= effectiveDate)
    .map((s,i) => ({ ...s, slotId: 'change-' + effectiveDate + '-' + i,
      validFrom: (s.validFrom || '') > effectiveDate ? s.validFrom : effectiveDate }));
  if (!newSlots.length) fail('변경 적용일 이후의 수업 시간을 입력해 주세요');
  next.scheduleSlots = oldSlots.concat(newSlots);
  next.days = [...new Set(next.scheduleSlots.flatMap(s => s.days || []))].sort();
  return next;
}
export function assertLessonRecordsVisible(current, next, rows) {
  for (const row of rows || []) {
    const c = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    const meaningful = c && (String(c.note || '').trim() || Object.values(c.lessonMemo || {}).some(v => String(v || '').trim()) ||
      c.done || c.att || c.attendance || c.at || c.count || Object.values(c.steps || {}).some(Boolean));
    if (!meaningful) continue;
    if (String(current.studentId || '') !== String(next.studentId || '')) fail('수업 기록이 있어 학생을 바꿀 수 없습니다. 별도 수업으로 등록해 주세요');
    const date = String(row.k || '').slice(-10);
    if (lessonOccursForHistory(current, date) && !lessonOccursForHistory(next, date)) {
      fail(date + '의 저장된 수업 기록이 가려지는 변경입니다. 해당 날짜 이후로 변경 적용일을 선택해 주세요');
    }
  }
}
