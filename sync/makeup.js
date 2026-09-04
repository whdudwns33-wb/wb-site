import { validateRosterDocument } from './roster.js';
import { verifySessionPackIdentity } from './session-pack.js';
import { isTaskWriteCasConflict, taskWriteCasGuardStatement } from './task-write-cas.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const COMPLETE_EARLY_MS = 5 * 60 * 1000;
const ACTIVE_STATUSES = new Set(['review_pending', 'reviewed', 'awaiting_parent', 'confirmed']);
const STATUSES = new Set(['review_pending', 'reviewed', 'awaiting_parent', 'confirmed', 'completed', 'cancelled']);
const ACTIONS = new Set([
  'list', 'create_from_absence', 'create_manual', 'review', 'propose', 'confirm', 'schedule', 'restore_schedule', 'complete',
  'reconcile_attendance', 'no_makeup', 'cancel'
]);
const MANUAL_REASON_CODES = new Set([
  'manual_absence', 'manual_exam', 'manual_other'
]);
const REASON_CODES = new Set([
  'policy_ineligible', 'already_resolved', 'parent_declined',
  'schedule_unavailable', 'student_inactive', 'other'
]);

function problem(message, status = 400, code = '') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}

function parseJson(value, fallback = null) {
  try { return JSON.parse(value); } catch (error) { return fallback; }
}

function cleanId(value, label) {
  const id = String(value || '');
  if (!SAFE_ID.test(id)) problem(label + '를 확인해 주세요');
  return id;
}

function cleanDate(value, label = '날짜') {
  const date = String(value || '');
  const parsed = new Date(date + 'T00:00:00Z');
  if (!ISO_DATE.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    problem(label + '는 YYYY-MM-DD 형식의 실제 날짜여야 합니다');
  }
  return date;
}

function cleanReason(value, required = false) {
  const reason = String(value || '').trim();
  if (required && !reason) problem('운영 사유 유형을 선택해 주세요');
  if (reason && !REASON_CODES.has(reason)) problem('허용된 운영 사유 유형을 선택해 주세요');
  return reason;
}

function exactBody(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) problem('요청 형식을 확인해 주세요');
  const allowed = new Set(['app', 'auth', 'action', ...fields]);
  for (const key of Object.keys(body)) if (!allowed.has(key)) problem(key + '는 허용되지 않은 항목입니다');
}

function actorId(auth) {
  return auth && auth.id ? String(auth.id) : 'director';
}

async function digestIds(app, sourceTaskId, sourceDate) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
    app + '\n' + sourceTaskId + '\n' + sourceDate
  ));
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return { caseId: 'mu_' + hex.slice(0, 48), consumptionGroupId: 'mc_' + hex.slice(0, 48) };
}

function weekday(date) {
  return new Date(date + 'T00:00:00Z').getUTCDay();
}

function activeForDate(student, date) {
  const month = date.slice(0, 7);
  return (!student.start || student.start <= month) && (!student.end || month < student.end);
}

async function loadRoster(env, app) {
  const row = await env.DB.prepare('SELECT data FROM private_rosters WHERE app=? LIMIT 1').bind(app).first();
  if (!row) problem('원생 데이터가 아직 등록되지 않았습니다', 409, 'ROSTER_MISSING');
  try { return validateRosterDocument(JSON.parse(row.data)); }
  catch (error) { problem('저장된 원생 데이터 형식을 확인해 주세요', 500, 'ROSTER_INVALID'); }
}

function rosterStudent(document, studentId, date) {
  const student = document.roster.students.find(item => item.id === studentId);
  if (!student) problem('현재 원생 명단에서 학생을 찾을 수 없습니다', 409, 'STUDENT_MISSING');
  if (date && !activeForDate(student, date)) problem('해당 날짜에 재원 중인 학생이 아닙니다', 409, 'STUDENT_INACTIVE');
  return student;
}

async function activeStaff(env, app, staffId) {
  const row = await env.DB.prepare('SELECT data FROM staff WHERE app=? AND id=? LIMIT 1').bind(app, staffId).first();
  const data = row && parseJson(row.data);
  return !!(data && !data.deleted);
}

function isLesson(task) {
  return !!task && !task.deleted && (task.taskKind === 'lesson_instruction' || task.lessonFormVersion ||
    task.intakeVersion);
}

function occurs(task, date) {
  if (!isLesson(task) || (task.start && date < task.start) || (task.end && date > task.end)) return false;
  const day = weekday(date);
  if (task.repeat === 'once') return date === task.start;
  if (task.repeat === 'daily') return true;
  if (task.repeat === 'weekday') return day >= 1 && day <= 5;
  if (task.repeat === 'days') return Array.isArray(task.days) && task.days.includes(day);
  return false;
}

function taskIntervals(task, date) {
  if (!isLesson(task) || (task.start && date < task.start) || (task.end && date > task.end)) return null;
  if (!Array.isArray(task.scheduleSlots) || !task.scheduleSlots.length) return occurs(task, date) ? [] : null;
  const day = weekday(date);
  const applicable = task.scheduleSlots.filter(slot => {
    const from = String(slot.validFrom || slot.startDate || '');
    const to = String(slot.validTo || slot.endDate || '');
    if ((from && date < from) || (to && date > to)) return false;
    return Array.isArray(slot.days) && slot.days.includes(day);
  });
  if (!applicable.length) return null;
  return applicable.filter(slot => HHMM.test(String(slot.startTime || '')) && HHMM.test(String(slot.endTime || '')) &&
    slot.startTime < slot.endTime)
    .map(slot => [slot.startTime, slot.endTime]);
}

function kstRange(dateValue, startValue, endValue) {
  const date = cleanDate(dateValue, '보강 날짜');
  const startTime = String(startValue || '');
  const endTime = String(endValue || '');
  if (!HHMM.test(startTime) || !HHMM.test(endTime) || startTime >= endTime) {
    problem('보강 시작·종료 시간은 같은 날의 HH:MM 형식이어야 합니다');
  }
  const startAt = date + 'T' + startTime + ':00+09:00';
  const endAt = date + 'T' + endTime + ':00+09:00';
  if (!Number.isFinite(Date.parse(startAt)) || !Number.isFinite(Date.parse(endAt))) problem('보강 일시를 확인해 주세요');
  return { date, startTime, endTime, startAt, endAt };
}

function assertSlotNotEnded(range, now) {
  if (Date.parse(range.endAt) <= now) {
    problem('이미 종료된 보강 일정은 제안하거나 확정할 수 없습니다', 409, 'MAKEUP_SLOT_ENDED');
  }
}

function overlap(start, end, otherStart, otherEnd) {
  return start < otherEnd && otherStart < end;
}

async function assertNoConflict(env, app, currentCaseId, studentId, staffId, range) {
  const tasks = await env.DB.prepare('SELECT id,owner,data FROM tasks WHERE app=?').bind(app).all();
  for (const row of tasks.results || []) {
    const task = parseJson(row.data);
    if (!isLesson(task)) continue;
    // 보강 수업끼리의 충돌은 아래 makeup_cases 확정 원장에서 판정한다.
    // 생성된 일회성 task까지 정규 수업으로 세면 같은 충돌이 다른 코드로 이중 보고된다.
    if (String(task.lessonInstanceType || '') === 'makeup') continue;
    const intervals = taskIntervals(task, range.date);
    if (intervals === null) continue;
    const sameStudent = String(task.studentId || '') === studentId;
    // 보강 담당자의 정규 수업은 동시에 진행될 수 있다. 다만 같은 학생의
    // 정규 수업과 겹치면 출결·메모 정본이 둘로 갈리므로 계속 차단한다.
    if (!sameStudent) continue;
    if (!intervals.length) {
      problem('겹침을 확인할 수 없는 정규 수업이 있습니다. 먼저 정규 시간표를 확정해 주세요', 409, 'SCHEDULE_UNCONFIRMED');
    }
    if (intervals.some(([start, end]) => overlap(range.startTime, range.endTime, start, end))) {
      problem('학생의 정규 수업과 시간이 겹칩니다', 409, 'STUDENT_SCHEDULE_CONFLICT');
    }
  }
  const conflicts = await env.DB.prepare(
    "SELECT case_id,student_id,confirmed_staff_id FROM makeup_cases WHERE app=? AND status='confirmed' " +
    'AND case_id<>? AND confirmed_start_at<? AND confirmed_end_at>? AND (student_id=? OR confirmed_staff_id=?) LIMIT 1'
  ).bind(app, currentCaseId, range.endAt, range.startAt, studentId, staffId).first();
  if (conflicts) {
    problem(String(conflicts.student_id) === studentId ? '학생의 확정 보강과 시간이 겹칩니다' :
      '담당 선생님의 확정 보강과 시간이 겹칩니다', 409,
    String(conflicts.student_id) === studentId ? 'STUDENT_MAKEUP_CONFLICT' : 'STAFF_MAKEUP_CONFLICT');
  }
}

function parseHistory(value) {
  const history = parseJson(value, []);
  return Array.isArray(history) ? history : [];
}

function cleanManualReason(value) {
  const reason = String(value || '').trim();
  if (!MANUAL_REASON_CODES.has(reason)) problem('보강 유형을 선택해 주세요');
  return reason;
}

function caseCreationOrigin(row) {
  const first = parseHistory(row && row.history)[0];
  if (!first || typeof first !== 'object') return 'unknown';
  if (first.action === 'create_manual') return 'manual';
  if (first.action === 'create_from_absence') return 'absence';
  return 'unknown';
}

function manualCreation(row) {
  if (caseCreationOrigin(row) !== 'manual') return null;
  return parseHistory(row && row.history)[0];
}

function isManualCase(row) {
  return !!manualCreation(row);
}

function scheduleView(prefix, row) {
  const startAt = row[prefix + '_start_at'];
  const endAt = row[prefix + '_end_at'];
  return {
    date: startAt ? String(startAt).slice(0, 10) : null,
    startTime: startAt ? String(startAt).slice(11, 16) : null,
    endTime: endAt ? String(endAt).slice(11, 16) : null,
    staffId: row[prefix + '_staff_id'] || null
  };
}

function completedScheduleView(row) {
  if (String(row.status || '') !== 'completed') {
    return { date: null, startTime: null, endTime: null, staffId: null };
  }
  const history = parseHistory(row.history);
  const completion = history.slice().reverse().find(item => item && item.action === 'complete');
  if (completion && ISO_DATE.test(String(completion.date || '')) &&
      HHMM.test(String(completion.startTime || '')) && HHMM.test(String(completion.endTime || ''))) {
    return {
      date: String(completion.date), startTime: String(completion.startTime),
      endTime: String(completion.endTime), staffId: String(completion.staffId || row.confirmed_staff_id || '') || null
    };
  }
  return scheduleView('confirmed', row);
}

function publicCase(row, student, task, parentResponse, lessonTask) {
  const proposed = scheduleView('proposed', row);
  const confirmed = scheduleView('confirmed', row);
  const completed = completedScheduleView(row);
  const history = parseHistory(row.history);
  const creationType = caseCreationOrigin(row);
  const manual = creationType === 'manual' ? history[0] : null;
  return {
    caseId: String(row.case_id), studentId: String(row.student_id),
    studentName: student ? String(student.name || '') : '', grade: student ? String(student.grade || '') : '',
    sourceTaskId: String(row.source_task_id), sourceDate: String(row.source_date),
    sourceTeacherId: String(row.source_teacher_id),
    creationType,
    manualReason: manual ? String(manual.reason || '') : '',
    createdBy: manual ? String(manual.actorId || '') : '',
    createdScope: manual ? String(manual.actorScope || '') : '',
    currentTeacherId: String(task && task.staffId || row.source_teacher_id),
    hasLessonTask: !!(lessonTask && !lessonTask.deleted),
    consumptionGroupId: String(row.consumption_group_id),
    subject: task ? String(task.subject || '') : '', className: task ? String(task.className || '') : '',
    status: String(row.status), revision: Number(row.revision),
    proposedDate: proposed.date, proposedStartTime: proposed.startTime, proposedEndTime: proposed.endTime,
    proposedStaffId: proposed.staffId,
    confirmedDate: confirmed.date, confirmedStartTime: confirmed.startTime, confirmedEndTime: confirmed.endTime,
    confirmedStaffId: confirmed.staffId,
    completedDate: completed.date, completedStartTime: completed.startTime, completedEndTime: completed.endTime,
    completedStaffId: completed.staffId,
    completedAt: row.completed_at == null ? null : Number(row.completed_at),
    cancelledAt: row.cancelled_at == null ? null : Number(row.cancelled_at),
    reason: row.reason || '', notificationNeeded: Number(row.notification_needed) === 1,
    notificationEvent: row.notification_event || null,
    notificationEventRevision: Number(row.notification_event_revision || 0),
    parentResponse: parentResponse ? String(parentResponse.response || '') : '',
    parentRespondedAt: parentResponse ? Number(parentResponse.created_at) : null,
    parentResponseRevision: parentResponse ? Number(parentResponse.revision) : null,
    hiddenByAttendanceCorrection: String(row.status) === 'cancelled' &&
      history.length > 0 && history.at(-1).action === 'reconcile_attendance',
    history, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at)
  };
}

function parentOperationsUnavailable() {
  problem('보호자 응답 운영 준비가 완료되지 않았습니다', 503, 'OPERATIONS_NOT_READY');
}

async function latestParentResponses(env, app) {
  const responses = new Map();
  try {
    const result = await env.DB.prepare(
      "SELECT object_id,response,revision,created_at FROM guardian_portal_responses " +
      "WHERE app=? AND object_type='makeup' ORDER BY created_at DESC"
    ).bind(app).all();
    for (const row of result.results || []) if (!responses.has(String(row.object_id))) responses.set(String(row.object_id), row);
  } catch (error) {
    parentOperationsUnavailable();
  }
  return responses;
}

async function parentResponseForRevision(env, app, row) {
  try {
    return await env.DB.prepare(
      "SELECT response,revision,created_at FROM guardian_portal_responses WHERE app=? AND object_type='makeup' " +
      'AND object_id=? AND student_id=? AND revision=? LIMIT 1'
    ).bind(app, row.case_id, row.student_id, Number(row.revision)).first();
  } catch (error) {
    parentOperationsUnavailable();
  }
}

async function latestParentResponse(env, app, row) {
  try {
    return await env.DB.prepare(
      "SELECT response,revision,created_at FROM guardian_portal_responses WHERE app=? AND object_type='makeup' " +
      'AND object_id=? AND student_id=? ORDER BY created_at DESC LIMIT 1'
    ).bind(app, row.case_id, row.student_id).first();
  } catch (error) {
    parentOperationsUnavailable();
  }
}

async function sourceTask(env, app, sourceTaskId, sourceDate) {
  const row = await env.DB.prepare('SELECT owner,data,updated_at FROM tasks WHERE app=? AND id=? LIMIT 1').bind(app, sourceTaskId).first();
  const task = row && parseJson(row.data);
  if (!row || !isLesson(task) || String(task.lessonInstanceType || '') === 'makeup' || task.makeupCaseId ||
      String(task.id || '') !== sourceTaskId ||
      !SAFE_ID.test(String(task.studentId || ''))) {
    problem('stable studentId가 있는 수업을 찾을 수 없습니다', 404, 'LESSON_MISSING');
  }
  if (String(task.staffId || '') !== String(row.owner || '')) {
    problem('수업 담당자 정보가 일치하지 않습니다', 409, 'LESSON_IDENTITY_MISMATCH');
  }
  if (!occurs(task, sourceDate)) problem('해당 날짜에 예정된 수업이 아닙니다', 409, 'LESSON_NOT_SCHEDULED');
  return { row, task };
}

async function manualSourceTask(env, app, sourceTaskId, studentId, targetDate) {
  const row = await env.DB.prepare('SELECT owner,data,updated_at FROM tasks WHERE app=? AND id=? LIMIT 1')
    .bind(app, sourceTaskId).first();
  const task = row && parseJson(row.data);
  if (!row || !isLesson(task) || String(task.lessonInstanceType || '') === 'makeup' || task.makeupCaseId ||
      String(task.id || '') !== sourceTaskId || !SAFE_ID.test(String(task.studentId || ''))) {
    problem('stable studentId가 있는 정규 수업을 찾을 수 없습니다', 404, 'LESSON_MISSING');
  }
  if (String(task.studentId || '') !== studentId) {
    problem('선택한 학생과 원 수업의 학생이 일치하지 않습니다', 409, 'LESSON_STUDENT_MISMATCH');
  }
  if (String(task.staffId || '') !== String(row.owner || '')) {
    problem('수업 담당자 정보가 일치하지 않습니다', 409, 'LESSON_IDENTITY_MISMATCH');
  }
  // 직접 만드는 보강은 원 수업 요일과 다른 날에도 잡을 수 있지만,
  // 종료되었거나 아직 시작하지 않은 수업을 근거로 새 보강을 만들 수는 없다.
  if ((task.start && targetDate < String(task.start)) || (task.end && targetDate > String(task.end))) {
    problem('보강 날짜에 활성 상태인 정규 수업이 아닙니다', 409, 'LESSON_INACTIVE');
  }
  return { row, task };
}

async function assertAbsent(env, app, sourceTaskId, sourceDate, owner) {
  const key = sourceTaskId + '|' + sourceDate;
  const row = await env.DB.prepare('SELECT owner,data FROM checks WHERE app=? AND k=? LIMIT 1').bind(app, key).first();
  const check = row && parseJson(row.data);
  if (!row || row.owner !== owner || !check || check.att !== 'A' ||
      (check.taskId && check.taskId !== sourceTaskId) || (check.date && check.date !== sourceDate)) {
    problem('원 수업의 결석(A) 기록을 먼저 저장해 주세요', 409, 'ABSENCE_REQUIRED');
  }
}

async function loadCase(env, app, caseId) {
  const row = await env.DB.prepare('SELECT * FROM makeup_cases WHERE app=? AND case_id=? LIMIT 1').bind(app, caseId).first();
  if (!row) problem('보강 기록을 찾을 수 없습니다', 404, 'MAKEUP_MISSING');
  return row;
}

async function assertCaseIdentity(env, app, row) {
  const ids = await digestIds(app, String(row.source_task_id), String(row.source_date));
  if (ids.caseId !== String(row.case_id) || ids.consumptionGroupId !== String(row.consumption_group_id)) {
    problem('보강 기록의 원 수업 식별자가 일치하지 않습니다', 409, 'MAKEUP_IDENTITY_MISMATCH');
  }
  const taskRow = await env.DB.prepare('SELECT owner,data,updated_at FROM tasks WHERE app=? AND id=? LIMIT 1')
    .bind(app, row.source_task_id).first();
  const task = taskRow && parseJson(taskRow.data);
  if (!taskRow || !task || !isLesson(task) || String(task.id || '') !== String(row.source_task_id) ||
      String(task.studentId || '') !== String(row.student_id) ||
      String(task.staffId || '') !== String(taskRow.owner || '')) {
    problem('원 수업과 보강 기록의 학생·담당자가 일치하지 않습니다', 409, 'MAKEUP_IDENTITY_MISMATCH');
  }
  return { task, identity: taskRow };
}

function expectedRevision(body) {
  const revision = Number(body.revision);
  if (!Number.isInteger(revision) || revision < 1) problem('현재 revision이 필요합니다');
  return revision;
}

async function conflictResponse(env, app, caseId, json, origin) {
  const fresh = await env.DB.prepare('SELECT * FROM makeup_cases WHERE app=? AND case_id=? LIMIT 1').bind(app, caseId).first();
  return json({ ok: false, code: 'REVISION_CONFLICT', error: '다른 기기에서 먼저 변경했습니다',
    current: fresh ? publicCase(fresh) : null }, 409, origin);
}

function transitionSnapshot(row, next, event, now) {
  const revision = Number(row.revision) + 1;
  const history = parseHistory(row.history).concat({ ...event, revision, at: now });
  return { ...next, revision, history: JSON.stringify(history), updated_at: now };
}

function transitionStatement(env, app, row, next, event, now) {
  const snapshot = transitionSnapshot(row, next, event, now);
  return env.DB.prepare(
    'UPDATE makeup_cases SET status=?,revision=?,proposed_start_at=?,proposed_end_at=?,proposed_staff_id=?,' +
    'confirmed_start_at=?,confirmed_end_at=?,confirmed_staff_id=?,completed_at=?,completed_by=?,cancelled_at=?,' +
    'cancelled_by=?,reason=?,notification_needed=?,notification_event=?,notification_event_revision=?,history=?,updated_at=? ' +
    'WHERE app=? AND case_id=? AND revision=? AND status=?'
  ).bind(snapshot.status, snapshot.revision, snapshot.proposed_start_at, snapshot.proposed_end_at,
    snapshot.proposed_staff_id, snapshot.confirmed_start_at, snapshot.confirmed_end_at,
    snapshot.confirmed_staff_id, snapshot.completed_at, snapshot.completed_by, snapshot.cancelled_at,
    snapshot.cancelled_by, snapshot.reason, snapshot.notification_needed, snapshot.notification_event,
    snapshot.notification_event_revision, snapshot.history, now, app, row.case_id, Number(row.revision), row.status);
}

function mapTransitionError(error) {
  const message = String(error && error.message || error);
  if (/MAKEUP_TIME_CONFLICT/.test(message)) {
    problem('다른 확정 보강과 학생 또는 담당 선생님의 시간이 겹칩니다', 409, 'MAKEUP_TIME_CONFLICT');
  }
  if (/PARENT_DECLINED/.test(message)) {
    problem('학부모가 참석 불가로 응답했습니다. 새 일정을 제안해 주세요', 409, 'PARENT_DECLINED');
  }
  if (/MAKEUP_COMPLETE_ASSIGNEE/.test(message)) {
    problem('확정된 담당 선생님의 개인 인증으로만 보강을 완료할 수 있습니다', 403, 'MAKEUP_COMPLETE_FORBIDDEN');
  }
  throw error;
}

const MAKEUP_STEP_LABELS = [
  '지난 숙제·온라인 수행 확인',
  '교재와 오늘 진도 진행',
  '이해도·오답·학생 반응 확인',
  '다음 숙제 안내',
  '실제 진도와 특이사항 기록'
];

// 일회성 보강 task의 날짜를 바꾸거나 숨기기 전에, 그 task를 정본으로 삼는 모든 운영 기록을 확인한다.
// LIKE는 task id의 '_'를 와일드카드로 해석하므로 checks 키는 substr로 비교한다.
const MAKEUP_LESSON_NO_RECORDS_SQL = [
  "NOT EXISTS (SELECT 1 FROM checks record WHERE record.app=tasks.app AND substr(record.k,1,length(tasks.id)+1)=tasks.id||'|')",
  'NOT EXISTS (SELECT 1 FROM feedback_requests record WHERE record.app=tasks.app AND record.task_id=tasks.id)',
  'NOT EXISTS (SELECT 1 FROM lesson_change_requests record WHERE record.app=tasks.app AND record.task_id=tasks.id)',
  'NOT EXISTS (SELECT 1 FROM student_change_events record WHERE record.app=tasks.app AND record.task_id=tasks.id)',
  'NOT EXISTS (SELECT 1 FROM session_packs record WHERE record.app=tasks.app AND record.lesson_task_id=tasks.id)',
  'NOT EXISTS (SELECT 1 FROM session_pack_transfer_guards record WHERE record.app=tasks.app AND record.lesson_task_id=tasks.id)',
  'NOT EXISTS (SELECT 1 FROM weekend_actual_visits record WHERE record.app=tasks.app AND record.lesson_task_id=tasks.id)',
  'NOT EXISTS (SELECT 1 FROM teacher_live_requests record WHERE record.app=tasks.app AND record.lesson_task_id=tasks.id)',
  'NOT EXISTS (SELECT 1 FROM tuition_generation_alerts record WHERE record.app=tasks.app AND record.trigger_task_id=tasks.id)',
  'NOT EXISTS (SELECT 1 FROM lesson_handoffs record WHERE record.app=tasks.app AND record.lesson_task_id=tasks.id)',
  'NOT EXISTS (SELECT 1 FROM guardian_lesson_publications record WHERE record.app=tasks.app AND record.source_task_id=tasks.id)',
  'NOT EXISTS (SELECT 1 FROM student_lesson_self_checks record JOIN guardian_lesson_publications publication ' +
    'ON publication.app=record.app AND publication.publication_id=record.publication_id ' +
    'WHERE publication.app=tasks.app AND publication.source_task_id=tasks.id)'
].join(' AND ');

function makeupLessonId(caseId) {
  return 'makeup_lesson_' + cleanId(caseId, 'caseId');
}

function sourceLessonHoursForDate(source, date) {
  const day = weekday(date);
  const values = (Array.isArray(source.scheduleSlots) ? source.scheduleSlots : []).filter(slot => {
    const from = String(slot && (slot.validFrom || slot.startDate) || '');
    const to = String(slot && (slot.validTo || slot.endDate) || '');
    return Array.isArray(slot && slot.days) && slot.days.includes(day) && (!from || from <= date) && (!to || date <= to);
  }).map(slot => String(slot.lessonHours || source.lessonHours || '').trim()).filter(Boolean);
  const unique = [...new Set(values)];
  if (unique.length > 1) {
    problem('결석일에 서로 다른 수업시수의 시간대가 여러 개라 보강 수업시수를 확정할 수 없습니다',
      409, 'MAKEUP_LESSON_HOURS_AMBIGUOUS');
  }
  return unique[0] || String(source.lessonHours || '').trim();
}

function makeupLessonTask(row, source, student, staffId, range, now, existing) {
  const id = makeupLessonId(String(row.case_id));
  const subject = String(source.subject || '');
  const className = String(source.className || '');
  const subjectLabel = [subject, className].filter(Boolean).join(' · ') || '보강';
  const studentName = String(student && student.name || source.studentName || '학생');
  const grade = String(student && student.grade || source.grade || '');
  const lessonHours = sourceLessonHoursForDate(source, String(row.source_date));
  const labels = Array.isArray(source.steps) && source.steps.length
    ? source.steps.map(step => String(step && step.label || '')).filter(Boolean)
    : MAKEUP_STEP_LABELS;
  const createdAt = Number(existing && existing.createdAt) || now;
  return {
    id,
    groupId: 'makeup-' + String(row.case_id),
    staffId,
    title: '[수업] ' + studentName + (grade ? ' (' + grade + ')' : '') + ' — ' + subjectLabel,
    detail: [grade, subjectLabel, range.date + ' ' + range.startTime + '-' + range.endTime]
      .filter(Boolean).join(' · '),
    guide: String(source.guide || ''),
    steps: labels.map((label, index) => ({ id: id + '-step-' + (index + 1), label })),
    target: 0,
    unit: '건',
    time: range.startTime,
    priority: String(source.priority || 'normal'),
    repeat: 'once',
    days: [weekday(range.date)],
    start: range.date,
    end: range.date,
    carry: false,
    origin: 'makeup',
    createdAt,
    updatedAt: now,
    deleted: false,
    studentId: String(row.student_id),
    studentName,
    grade,
    subject,
    className,
    lessonRole: String(source.lessonRole || className || subjectLabel),
    lessonHours,
    scheduleText: range.date + ' ' + range.startTime + '-' + range.endTime,
    scheduleSlots: [{
      days: [weekday(range.date)], startTime: range.startTime, endTime: range.endTime,
      ...(lessonHours ? { lessonHours } : {}), validFrom: range.date, validTo: range.date
    }],
    scheduleStatus: 'confirmed',
    scheduleReviewReason: '',
    materials: String(source.materials || ''),
    onlineProgram: String(source.onlineProgram || ''),
    onlinePrograms: Array.isArray(source.onlinePrograms) ? source.onlinePrograms : [],
    homework: String(source.homework || ''),
    studentTraits: String(source.studentTraits || ''),
    goal: String(source.goal || ''),
    parentRequest: String(source.parentRequest || ''),
    adminRequest: String(source.adminRequest || ''),
    taskKind: 'lesson_instruction',
    lessonFormVersion: 1,
    lessonRevision: Math.max(1, Number(existing && existing.lessonRevision || 0) + (existing ? 1 : 0)),
    lessonInstanceType: 'makeup',
    makeupCaseId: String(row.case_id),
    makeupSourceTaskId: String(row.source_task_id),
    makeupSourceDate: String(row.source_date)
  };
}

function makeupLessonIdentityMatches(dbRow, task, row, staffId) {
  return !!(dbRow && task && String(dbRow.owner || '') === String(staffId) &&
      String(task.id || '') === makeupLessonId(String(row.case_id)) &&
      String(task.staffId || '') === String(staffId) &&
      String(task.studentId || '') === String(row.student_id) &&
      String(task.lessonInstanceType || '') === 'makeup' &&
      String(task.makeupCaseId || '') === String(row.case_id) &&
      String(task.makeupSourceTaskId || '') === String(row.source_task_id) &&
      String(task.makeupSourceDate || '') === String(row.source_date));
}

function assertMakeupLessonIdentity(dbRow, task, row, staffId) {
  if (!makeupLessonIdentityMatches(dbRow, task, row, staffId)) {
    problem('보강 수업 식별자가 기존 수업과 충돌합니다', 409, 'MAKEUP_LESSON_IDENTITY_MISMATCH');
  }
}

async function prepareMakeupLessonWrite(env, app, row, source, student, staffId, range, now,
  preserveExisting = false) {
  const id = makeupLessonId(String(row.case_id));
  const dbRow = await env.DB.prepare('SELECT owner,data,updated_at FROM tasks WHERE app=? AND id=? LIMIT 1')
    .bind(app, id).first();
  const existing = dbRow && parseJson(dbRow.data);
  if (dbRow) assertMakeupLessonIdentity(dbRow, existing, row, staffId);
  const task = makeupLessonTask(row, source, student, staffId, range, now, existing);
  if (dbRow && preserveExisting) {
    // 기록이 전혀 없을 때만 actual 일시로 이동한다. CASE 판정과 갱신이 한 SQL 문장이므로
    // 사전 조회 뒤 기록이 생기는 TOCTOU 없이, 기록이 생겼다면 기존 예정 task를 그대로 보존한다.
    const noRecords = '(' + MAKEUP_LESSON_NO_RECORDS_SQL + ')';
    const existingSlot = Array.isArray(existing.scheduleSlots) && existing.scheduleSlots[0];
    const existingEndAt = String(existing.start || '') && existingSlot && HHMM.test(String(existingSlot.endTime || ''))
      ? Date.parse(String(existing.start) + 'T' + String(existingSlot.endTime) + ':00+09:00') : NaN;
    const scheduleChanged = String(existing.start || '') !== range.date ||
      String(existingSlot && existingSlot.startTime || '') !== range.startTime ||
      String(existingSlot && existingSlot.endTime || '') !== range.endTime;
    const hideFuturePreserved = scheduleChanged && Number.isFinite(existingEndAt) && existingEndAt > now;
    const preserved = hideFuturePreserved ? {
      ...existing,
      deleted: true,
      updatedAt: now,
      lessonRevision: Math.max(1, Number(existing.lessonRevision || 0) + 1),
      makeupCompleted: true,
      makeupCompletedActualDate: range.date,
      makeupCompletedActualStartTime: range.startTime,
      makeupCompletedActualEndTime: range.endTime,
      makeupHiddenReason: 'completed_at_different_time_with_records'
    } : existing;
    return {
      task,
      statement: env.DB.prepare(
        'UPDATE tasks SET data=CASE WHEN ' + noRecords + ' THEN ? ELSE ? END,' +
        'updated_at=CASE WHEN ' + noRecords + ' OR ? THEN ? ELSE updated_at END,' +
        'srv_at=CASE WHEN ' + noRecords + ' OR ? THEN ? ELSE srv_at END ' +
        'WHERE app=? AND id=? AND owner=? AND data=? AND updated_at=?'
      ).bind(JSON.stringify(task), JSON.stringify(preserved), hideFuturePreserved ? 1 : 0, now,
        hideFuturePreserved ? 1 : 0, now, app, id, dbRow.owner, dbRow.data, Number(dbRow.updated_at)),
      existed: true
    };
  }
  const statement = dbRow
    ? env.DB.prepare(
      'UPDATE tasks SET owner=?,data=?,updated_at=?,srv_at=? WHERE app=? AND id=? AND owner=? AND data=? AND updated_at=?'
    ).bind(staffId, JSON.stringify(task), now, now, app, id, dbRow.owner, dbRow.data, Number(dbRow.updated_at))
    : env.DB.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
      .bind(app, id, staffId, JSON.stringify(task), now, now);
  return { task, statement, existed: !!dbRow };
}

async function makeupLessonHasRecords(env, app, id) {
  const row = await env.DB.prepare(
    'SELECT CASE WHEN ' + MAKEUP_LESSON_NO_RECORDS_SQL + ' THEN 0 ELSE 1 END AS has_records ' +
    'FROM tasks WHERE app=? AND id=? LIMIT 1'
  ).bind(app, id).first();
  return !!(row && Number(row.has_records) === 1);
}

async function prepareMakeupLessonDelete(env, app, row, staffId, now) {
  const id = makeupLessonId(String(row.case_id));
  const dbRow = await env.DB.prepare('SELECT owner,data,updated_at FROM tasks WHERE app=? AND id=? LIMIT 1')
    .bind(app, id).first();
  if (!dbRow) return null;
  const task = parseJson(dbRow.data);
  assertMakeupLessonIdentity(dbRow, task, row, staffId);
  if (await makeupLessonHasRecords(env, app, id)) {
    problem('이미 출결·메모 또는 피드백 기록이 있는 보강 수업은 보강 없음으로 바꿀 수 없습니다',
      409, 'MAKEUP_LESSON_HAS_RECORDS');
  }
  const deleted = { ...task, deleted: true, updatedAt: now };
  return env.DB.prepare(
    'UPDATE tasks SET data=?,updated_at=?,srv_at=? WHERE app=? AND id=? AND owner=? AND data=? AND updated_at=? AND ' +
    MAKEUP_LESSON_NO_RECORDS_SQL
  ).bind(JSON.stringify(deleted), now, now, app, id, dbRow.owner, dbRow.data, Number(dbRow.updated_at));
}

async function casGuard(env, app, operation, row, now, attemptIdentity = '') {
  return taskWriteCasGuardStatement(env, app, operation,
    [String(row.case_id), String(row.revision), String(now), String(attemptIdentity || '')].join('\n'), now);
}

function regularConflictGuardStatement(env, app, row, studentId, staffId, range) {
  const day = weekday(range.date);
  return env.DB.prepare(
    'UPDATE makeup_cases SET updated_at=updated_at WHERE app=? AND case_id=? AND revision=? AND status=? AND NOT EXISTS (' +
    'SELECT 1 FROM tasks regular WHERE regular.app=? AND json_valid(regular.data)=1 ' +
    "AND COALESCE(json_extract(regular.data,'$.deleted'),0)=0 " +
    "AND (json_extract(regular.data,'$.taskKind')='lesson_instruction' OR json_extract(regular.data,'$.lessonFormVersion') IS NOT NULL OR json_extract(regular.data,'$.intakeVersion') IS NOT NULL) " +
    "AND COALESCE(json_extract(regular.data,'$.lessonInstanceType'),'')<>'makeup' " +
    "AND json_extract(regular.data,'$.studentId')=? " +
    "AND (COALESCE(json_extract(regular.data,'$.start'),'')='' OR json_extract(regular.data,'$.start')<=?) " +
    "AND (COALESCE(json_extract(regular.data,'$.end'),'')='' OR json_extract(regular.data,'$.end')>=?) AND (" +
      "(COALESCE(json_array_length(json_extract(regular.data,'$.scheduleSlots')),0)=0 AND (" +
        "(json_extract(regular.data,'$.repeat')='once' AND json_extract(regular.data,'$.start')=?) OR " +
        "json_extract(regular.data,'$.repeat')='daily' OR " +
        "(json_extract(regular.data,'$.repeat')='weekday' AND ? BETWEEN 1 AND 5) OR " +
        "(json_extract(regular.data,'$.repeat')='days' AND EXISTS (SELECT 1 FROM json_each(json_extract(regular.data,'$.days')) d WHERE d.value=?))" +
      ')) OR EXISTS (SELECT 1 FROM json_each(json_extract(regular.data,\'$.scheduleSlots\')) slot WHERE ' +
        "(COALESCE(json_extract(slot.value,'$.validFrom'),json_extract(slot.value,'$.startDate'),'')='' OR COALESCE(json_extract(slot.value,'$.validFrom'),json_extract(slot.value,'$.startDate'))<=?) " +
        "AND (COALESCE(json_extract(slot.value,'$.validTo'),json_extract(slot.value,'$.endDate'),'')='' OR COALESCE(json_extract(slot.value,'$.validTo'),json_extract(slot.value,'$.endDate'))>=?) " +
        "AND EXISTS (SELECT 1 FROM json_each(json_extract(slot.value,'$.days')) sd WHERE sd.value=?) " +
        "AND json_extract(slot.value,'$.startTime')<? AND json_extract(slot.value,'$.endTime')>?))" +
    ") AND NOT EXISTS (SELECT 1 FROM makeup_cases other WHERE other.app=? AND other.status='confirmed' " +
      'AND other.case_id<>? AND other.confirmed_start_at<? AND other.confirmed_end_at>? ' +
      'AND (other.student_id=? OR other.confirmed_staff_id=?))'
  ).bind(app, row.case_id, Number(row.revision), row.status, app, studentId,
    range.date, range.date, range.date, day, day, range.date, range.date, day, range.endTime, range.startTime,
    app, row.case_id, range.endAt, range.startAt, studentId, staffId);
}

function sourceIdentityGuardStatement(env, app, row, sourceRow) {
  return env.DB.prepare(
    'UPDATE makeup_cases SET updated_at=updated_at WHERE app=? AND case_id=? AND revision=? AND status=? ' +
    'AND EXISTS (SELECT 1 FROM tasks source WHERE source.app=? AND source.id=? AND source.owner=? ' +
    'AND source.data=? AND source.updated_at=?)'
  ).bind(app, row.case_id, Number(row.revision), row.status, app, row.source_task_id,
    sourceRow.owner, sourceRow.data, Number(sourceRow.updated_at));
}

function mapAtomicMakeupError(error) {
  if (isTaskWriteCasConflict(error)) {
    problem('다른 기기에서 보강 또는 보강 수업을 먼저 변경했습니다', 409, 'REVISION_CONFLICT');
  }
  if (/UNIQUE constraint failed: tasks\.app, tasks\.id/.test(String(error && error.message || error))) {
    problem('보강 수업 식별자가 기존 수업과 충돌합니다', 409, 'MAKEUP_LESSON_IDENTITY_MISMATCH');
  }
  completionBatchError(error);
}

async function saveTransition(env, app, row, next, event, json, origin, now = Date.now()) {
  let result;
  try {
    result = await transitionStatement(env, app, row, next, event, now).run();
  } catch (error) {
    mapTransitionError(error);
  }
  if (!result.meta || Number(result.meta.changes || 0) !== 1) return conflictResponse(env, app, row.case_id, json, origin);
  return env.DB.prepare('SELECT * FROM makeup_cases WHERE app=? AND case_id=? LIMIT 1').bind(app, row.case_id).first();
}

async function activeSessionPack(env, app, row) {
  return await env.DB.prepare(
    "SELECT * FROM session_packs " +
    "WHERE app=? AND student_id=? AND lesson_task_id=? AND status='active' LIMIT 1"
  ).bind(app, row.student_id, row.source_task_id).first();
}

function completionBatchError(error) {
  const message = String(error && error.message || error);
  if (/MAKEUP_REVISION_CONFLICT/.test(message)) {
    problem('다른 기기에서 보강 상태가 먼저 변경되었습니다', 409, 'REVISION_CONFLICT');
  }
  if (/SESSION_PACK_REVISION_CONFLICT/.test(message)) {
    problem('다른 기기에서 회차가 먼저 변경되었습니다', 409, 'SESSION_PACK_REVISION_CONFLICT');
  }
  if (/SESSION_PACK_NOT_ACTIVE/.test(message)) {
    problem('완료 처리 중 회차권이 닫혔습니다', 409, 'PACK_NOT_ACTIVE');
  }
  if (/SESSION_PACK_DATE_OUT_OF_RANGE/.test(message)) {
    problem('완료 처리 중 회차권 유효기간이 변경되었습니다', 409, 'DATE_OUT_OF_RANGE');
  }
  if (/SESSION_PACK_BALANCE_INVALID/.test(message)) {
    problem('회차 잔액을 확인해 주세요', 409, 'BALANCE_INVALID');
  }
  if (/idx_session_pack_usage_one_consumption|session_pack_usage\.app, session_pack_usage\.pack_id, session_pack_usage\.consumption_group_id/.test(message)) {
    problem('원 수업과 보강의 회차 차감 상태가 먼저 변경되었습니다', 409, 'DUPLICATE_CONSUMPTION');
  }
  if (/session_pack_usage\.app, session_pack_usage\.source_type, session_pack_usage\.source_ref/.test(message)) {
    problem('이 보강은 회차 원장에 이미 기록되어 있습니다', 409, 'SESSION_PACK_SOURCE_EXISTS');
  }
  if (/MAKEUP_USAGE_EVIDENCE_INVALID/.test(message)) {
    problem('보강 완료와 회차 사용 근거가 일치하지 않습니다', 409, 'MAKEUP_USAGE_EVIDENCE_INVALID');
  }
  mapTransitionError(error);
}

async function saveSchedule(env, app, row, next, event, source, sourceIdentity, student, staffId, range, json, origin, now) {
  const taskWrite = await prepareMakeupLessonWrite(env, app, row, source, student, staffId, range, now);
  const statements = [
    sourceIdentityGuardStatement(env, app, row, sourceIdentity),
    await casGuard(env, app, 'makeup_schedule_source', row, now),
    regularConflictGuardStatement(env, app, row, String(row.student_id), staffId, range),
    await casGuard(env, app, 'makeup_schedule_conflict', row, now)
  ];
  let scheduleBase = row;
  if (row.status === 'awaiting_parent' && event.action === 'schedule') {
    const supersededNext = { ...row, status: 'reviewed', notification_needed: 0,
      notification_event: null, notification_event_revision: 0 };
    const supersededEvent = { action: 'supersede_parent_process_for_schedule', from: row.status, to: 'reviewed',
      actorId: event.actorId, notificationNeeded: false };
    statements.push(transitionStatement(env, app, row, supersededNext, supersededEvent, now),
      await casGuard(env, app, 'makeup_schedule_supersede', row, now));
    scheduleBase = transitionSnapshot(row, supersededNext, supersededEvent, now);
  }
  statements.push(transitionStatement(env, app, scheduleBase, next,
    { ...event, from: scheduleBase.status }, now),
  await casGuard(env, app, 'makeup_schedule_case', scheduleBase, now),
  taskWrite.statement,
  await casGuard(env, app, 'makeup_schedule_task', row, now));
  let results;
  try {
    results = await env.DB.batch(statements);
  } catch (error) {
    if (isTaskWriteCasConflict(error)) {
      await assertNoConflict(env, app, String(row.case_id), String(row.student_id), staffId, range);
    }
    mapAtomicMakeupError(error);
  }
  if (!Array.isArray(results) || results.length !== statements.length ||
      results.some(result => Number(result && result.meta && result.meta.changes || 0) !== 1)) {
    return conflictResponse(env, app, row.case_id, json, origin);
  }
  return env.DB.prepare('SELECT * FROM makeup_cases WHERE app=? AND case_id=? LIMIT 1')
    .bind(app, row.case_id).first();
}

async function saveCancellation(env, app, row, next, event, currentSourceTeacherId, json, origin, now) {
  const staffId = String(row.confirmed_staff_id || currentSourceTeacherId || '');
  const taskDelete = staffId ? await prepareMakeupLessonDelete(env, app, row, staffId, now) : null;
  if (!taskDelete) {
    let missingResults;
    try {
      missingResults = await env.DB.batch([
        env.DB.prepare(
          'UPDATE makeup_cases SET updated_at=updated_at WHERE app=? AND case_id=? AND revision=? AND status=? ' +
          'AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.app=? AND tasks.id=?)'
        ).bind(app, row.case_id, Number(row.revision), row.status, app, makeupLessonId(String(row.case_id))),
        await casGuard(env, app, 'makeup_cancel_missing_task', row, now),
        transitionStatement(env, app, row, next, event, now),
        await casGuard(env, app, 'makeup_cancel_missing_case', row, now)
      ]);
    } catch (error) {
      mapAtomicMakeupError(error);
    }
    if (!Array.isArray(missingResults) || missingResults.length !== 4 ||
        missingResults.some(result => Number(result && result.meta && result.meta.changes || 0) !== 1)) {
      return conflictResponse(env, app, row.case_id, json, origin);
    }
    return env.DB.prepare('SELECT * FROM makeup_cases WHERE app=? AND case_id=? LIMIT 1')
      .bind(app, row.case_id).first();
  }
  let results;
  try {
    results = await env.DB.batch([
      transitionStatement(env, app, row, next, event, now),
      await casGuard(env, app, 'makeup_cancel_case', row, now),
      taskDelete,
      await casGuard(env, app, 'makeup_cancel_task', row, now)
    ]);
  } catch (error) {
    if (isTaskWriteCasConflict(error) &&
        await makeupLessonHasRecords(env, app, makeupLessonId(String(row.case_id)))) {
      problem('이미 출결·메모 또는 피드백 기록이 있는 보강 수업은 보강 없음으로 바꿀 수 없습니다',
        409, 'MAKEUP_LESSON_HAS_RECORDS');
    }
    mapAtomicMakeupError(error);
  }
  if (!Array.isArray(results) || results.length !== 4 ||
      results.some(result => Number(result && result.meta && result.meta.changes || 0) !== 1)) {
    return conflictResponse(env, app, row.case_id, json, origin);
  }
  return env.DB.prepare('SELECT * FROM makeup_cases WHERE app=? AND case_id=? LIMIT 1')
    .bind(app, row.case_id).first();
}

async function completionImpact(env, app, row, document, currentSourceTeacherId) {
  // 시험·기타 보강은 원 수업 회차를 대신 소비하지 않는다. 반면 선생님이 직접 생성한
  // 결석보강은 자동 생성 결석보강과 동일한 회차 정책을 적용한다.
  const origin = caseCreationOrigin(row);
  const manual = origin === 'manual' ? manualCreation(row) : null;
  if (origin === 'unknown') {
    return { impact: { status: 'not_applicable', reason: 'unknown_origin_no_charge', refreshNeeded: false } };
  }
  if (manual && String(manual.reason || '') !== 'manual_absence') {
    return { impact: { status: 'not_applicable', reason: 'manual_no_charge', refreshNeeded: false } };
  }
  const pack = await activeSessionPack(env, app, row);
  if (!pack) return { impact: { status: 'not_applicable', reason: 'no_active_pack', refreshNeeded: false } };
  const packContext = await verifySessionPackIdentity(env, app, document, pack);
  if (packContext.error || String(pack.task_owner) !== String(currentSourceTeacherId)) {
    return { impact: { status: 'not_applicable', reason: 'pack_identity_mismatch', refreshNeeded: false } };
  }
  if (String(row.source_date) < String(pack.valid_from) || String(row.source_date) > String(pack.expires_on)) {
    return { impact: { status: 'not_applicable', reason: 'source_date_out_of_range', refreshNeeded: false } };
  }
  const positive = await env.DB.prepare(
    'SELECT entry_id FROM session_pack_usage WHERE app=? AND pack_id=? AND consumption_group_id=? AND delta>0 LIMIT 1'
  ).bind(app, pack.pack_id, row.consumption_group_id).first();
  const delta = positive ? 0 : 1;
  return {
    pack,
    impact: {
      status: 'recorded', packId: String(pack.pack_id), delta,
      packRevision: Number(pack.revision) + 1, refreshNeeded: true
    }
  };
}

async function saveCompletion(env, app, row, next, event, document, source, student, staffId, range,
  direct, currentSourceTeacherId, sourceIdentity, json, origin, now, forcedImpact = null) {
  const taskWrite = await prepareMakeupLessonWrite(env, app, row, source, student, staffId, range, now, true);
  const planned = forcedImpact ? { impact: forcedImpact } :
    await completionImpact(env, app, row, document, currentSourceTeacherId);
  const impact = planned.impact;
  const statements = [];
  statements.push(sourceIdentityGuardStatement(env, app, row, sourceIdentity));
  statements.push(await casGuard(env, app, 'makeup_complete_source', row, now));
  statements.push(regularConflictGuardStatement(env, app, row, String(row.student_id), staffId, range));
  statements.push(await casGuard(env, app, 'makeup_complete_conflict', row, now));
  let completionRow = row;
  let completionNext = next;

  if (direct) {
    let scheduleBase = row;
    if (row.status === 'awaiting_parent') {
      const supersededNext = {
        ...row,
        status: 'reviewed',
        notification_needed: 0,
        notification_event: null,
        notification_event_revision: 0
      };
      const supersededEvent = {
        action: 'supersede_parent_process_for_completion', from: row.status, to: 'reviewed',
        actorId: event.actorId, notificationNeeded: false
      };
      statements.push(transitionStatement(env, app, row, supersededNext, supersededEvent, now));
      statements.push(await casGuard(env, app, 'makeup_direct_supersede', row, now));
      scheduleBase = transitionSnapshot(row, supersededNext, supersededEvent, now);
    }
    const scheduledNext = {
      ...scheduleBase,
      status: 'confirmed',
      confirmed_start_at: range.startAt,
      confirmed_end_at: range.endAt,
      confirmed_staff_id: staffId,
      notification_needed: 0,
      notification_event: null,
      notification_event_revision: 0
    };
    const scheduledEvent = {
      action: 'schedule_for_completion', from: scheduleBase.status, to: 'confirmed', actorId: event.actorId,
      date: range.date, startTime: range.startTime, endTime: range.endTime, staffId,
      notificationNeeded: false
    };
    statements.push(transitionStatement(env, app, scheduleBase, scheduledNext, scheduledEvent, now));
    statements.push(await casGuard(env, app, 'makeup_direct_schedule', scheduleBase, now));
    if (taskWrite.statement) {
      statements.push(taskWrite.statement);
      statements.push(await casGuard(env, app, 'makeup_direct_task', row, now));
    }
    completionRow = transitionSnapshot(scheduleBase, scheduledNext, scheduledEvent, now);
    completionNext = { ...completionRow, status: 'completed', completed_at: now, completed_by: staffId };
  } else {
    statements.push(transitionStatement(env, app, row, completionNext,
      { ...event, sessionPackImpact: impact }, now));
    statements.push(await casGuard(env, app, 'makeup_complete_case', row, now));
    if (taskWrite.statement) {
      statements.push(taskWrite.statement);
      statements.push(await casGuard(env, app, 'makeup_complete_task', row, now));
    }
  }

  if (direct) {
    statements.push(transitionStatement(env, app, completionRow, completionNext,
      { ...event, from: 'confirmed', sessionPackImpact: impact }, now));
    statements.push(await casGuard(env, app, 'makeup_direct_complete', completionRow, now));
  }

  if (planned.pack) {
    statements.push(env.DB.prepare(
      'INSERT INTO session_pack_usage(app,entry_id,pack_id,expected_revision,source_type,source_ref,source_date,' +
      'attendance_event,delta,consumption_group_id,reason_code,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(app, 'su_' + crypto.randomUUID().replace(/-/g, ''), planned.pack.pack_id,
      Number(planned.pack.revision), 'makeup', row.case_id, row.source_date, 'makeup_completed', impact.delta,
      row.consumption_group_id, 'makeup_atomic_v1', String(staffId), now));
  }

  let results;
  try {
    results = await env.DB.batch(statements);
  } catch (error) {
    if (isTaskWriteCasConflict(error)) {
      await assertNoConflict(env, app, String(row.case_id), String(row.student_id), staffId, range);
    }
    if (!forcedImpact && /SESSION_PACK_IDENTITY_MISMATCH/.test(String(error && error.message || error))) {
      const mismatch = { status: 'not_applicable', reason: 'pack_identity_mismatch', refreshNeeded: false };
      return saveCompletion(env, app, row, next, event, document, source, student, staffId, range,
        direct, currentSourceTeacherId, sourceIdentity, json, origin, now, mismatch);
    }
    mapAtomicMakeupError(error);
  }
  if (!Array.isArray(results) || results.length !== statements.length ||
      results.some(result => Number(result && result.meta && result.meta.changes || 0) !== 1)) {
    return conflictResponse(env, app, row.case_id, json, origin);
  }
  const saved = await env.DB.prepare('SELECT * FROM makeup_cases WHERE app=? AND case_id=? LIMIT 1')
    .bind(app, row.case_id).first();
  return { saved, impact };
}

async function taskRowsByIds(env, app, ids) {
  const rows = new Map();
  const unique = [...new Set((ids || []).map(String).filter(id => SAFE_ID.test(id)))];
  // D1/SQLite bind 한도를 넉넉히 피하면서 후보 수와 무관하게 N+1 조회를 만들지 않는다.
  for (let offset = 0; offset < unique.length; offset += 80) {
    const chunk = unique.slice(offset, offset + 80);
    const result = await env.DB.prepare(
      'SELECT id,owner,data,updated_at FROM tasks WHERE app=? AND id IN (' + chunk.map(() => '?').join(',') + ')'
    ).bind(app, ...chunk).all();
    for (const row of result.results || []) rows.set(String(row.id), row);
  }
  return rows;
}

async function listCases(env, app, body, auth, json, origin) {
  exactBody(body, ['status', 'studentId', 'fromDate', 'toDate', 'limit']);
  const clauses = ['app=?'];
  const binds = [app];
  if (body.status) {
    if (!STATUSES.has(String(body.status))) return json({ ok: false, error: 'status를 확인해 주세요' }, 400, origin);
    clauses.push('status=?'); binds.push(String(body.status));
  }
  if (body.studentId) { clauses.push('student_id=?'); binds.push(cleanId(body.studentId, 'studentId')); }
  if (body.fromDate) { clauses.push('source_date>=?'); binds.push(cleanDate(body.fromDate, '시작 날짜')); }
  if (body.toDate) { clauses.push('source_date<=?'); binds.push(cleanDate(body.toDate, '종료 날짜')); }
  const limit = Math.floor(Math.max(1, Math.min(500, Number(body.limit) || 200)));
  const result = await env.DB.prepare('SELECT * FROM makeup_cases WHERE ' + clauses.join(' AND ') +
    ' ORDER BY CASE status WHEN \'review_pending\' THEN 0 WHEN \'awaiting_parent\' THEN 1 WHEN \'confirmed\' THEN 2 ELSE 3 END,' +
    ' updated_at DESC LIMIT ' + limit).bind(...binds).all();
  const document = await loadRoster(env, app);
  const students = new Map(document.roster.students.map(student => [student.id, student]));
  const candidates = result.results || [];
  const taskIds = [...new Set(candidates.map(row => String(row.source_task_id)))];
  const tasks = new Map();
  const lessonTasks = new Map();
  const currentOwners = new Map();
  const sourceRows = await taskRowsByIds(env, app, taskIds);
  for (const taskId of taskIds) {
    const row = sourceRows.get(taskId);
    const task = row && parseJson(row.data);
    const owner = String(row && row.owner || '');
    if (!task || !isLesson(task) || String(task.id || '') !== taskId ||
        String(task.staffId || '') !== owner || !SAFE_ID.test(owner)) continue;
    tasks.set(taskId, task);
    currentOwners.set(taskId, owner);
  }
  const lessonIds = candidates.map(row => makeupLessonId(String(row.case_id)));
  const lessonRows = await taskRowsByIds(env, app, lessonIds);
  for (const row of candidates) {
    const lessonRow = lessonRows.get(makeupLessonId(String(row.case_id)));
    const lessonTask = lessonRow && parseJson(lessonRow.data);
    const expectedStaffId = String(row.confirmed_staff_id || currentOwners.get(String(row.source_task_id)) || '');
    if (lessonTask && makeupLessonIdentityMatches(lessonRow, lessonTask, row, expectedStaffId)) {
      lessonTasks.set(String(row.case_id), lessonTask);
    }
  }
  const visible = candidates.filter(row => {
    const student = students.get(String(row.student_id));
    const taskId = String(row.source_task_id);
    const task = tasks.get(taskId);
    if (!student || !task || String(task.studentId || '') !== String(row.student_id)) return false;
    return auth.scope === 'all' || (auth.scope === 'own' &&
      [currentOwners.get(taskId), row.proposed_staff_id, row.confirmed_staff_id]
        .some(staffId => String(staffId || '') === String(auth.id || '')));
  });
  const responses = await latestParentResponses(env, app);
  return json({ ok: true, cases: visible.map(row => publicCase(row, students.get(String(row.student_id)),
    tasks.get(String(row.source_task_id)), responses.get(String(row.case_id)),
    lessonTasks.get(String(row.case_id)))) }, 200, origin);
}

async function manualExistingResponse(env, app, existing, student, source, sourceTaskId, studentId,
  sourceTeacherId, reason, range, json, origin) {
  if (!isManualCase(existing)) {
    problem('같은 원 수업과 날짜에 결석 보강 기록이 이미 있습니다', 409, 'ABSENCE_MAKEUP_EXISTS');
  }
  if (String(existing.student_id) !== studentId || String(existing.source_task_id) !== sourceTaskId ||
      String(existing.source_date) !== range.date) {
    problem('보강 기록의 원 수업 정체성이 다릅니다', 409, 'MAKEUP_IDENTITY_MISMATCH');
  }
  const manual = manualCreation(existing);
  const exact = String(manual && manual.reason || '') === reason &&
    String(existing.source_teacher_id || '') === sourceTeacherId &&
    String(existing.confirmed_staff_id || '') === sourceTeacherId &&
    String(existing.confirmed_start_at || '') === range.startAt &&
    String(existing.confirmed_end_at || '') === range.endAt;
  if (!exact) {
    problem('같은 원 수업과 날짜에 다른 내용의 직접 생성 보강이 이미 있습니다',
      409, 'MANUAL_MAKEUP_CONFLICT');
  }
  const lessonRow = await env.DB.prepare('SELECT owner,data FROM tasks WHERE app=? AND id=? LIMIT 1')
    .bind(app, makeupLessonId(String(existing.case_id))).first();
  const lessonTask = lessonRow && parseJson(lessonRow.data);
  if (!lessonRow) problem('기존 보강 수업이 누락되어 복구가 필요합니다', 409, 'MAKEUP_LESSON_MISSING');
  assertMakeupLessonIdentity(lessonRow, lessonTask, existing, sourceTeacherId);
  return json({ ok: true, idempotent: true,
    case: publicCase(existing, student, source.task, null, lessonTask), lessonTask }, 200, origin);
}

async function createManual(env, app, body, auth, json, origin) {
  exactBody(body, ['studentId', 'sourceTaskId', 'reason', 'date', 'startTime', 'endTime']);
  const studentId = cleanId(body.studentId, 'studentId');
  const sourceTaskId = cleanId(body.sourceTaskId, 'sourceTaskId');
  const reason = cleanManualReason(body.reason);
  const range = kstRange(body.date, body.startTime, body.endTime);
  const now = Date.now();
  assertSlotNotEnded(range, now);
  const source = await manualSourceTask(env, app, sourceTaskId, studentId, range.date);
  const sourceTeacherId = cleanId(source.row.owner, '수업 담당자');
  if (auth.scope === 'own' && String(auth.id || '') !== sourceTeacherId) {
    return json({ ok: false, error: '본인이 담당하는 학생의 수업만 보강으로 생성할 수 있습니다' }, 403, origin);
  }
  const document = await loadRoster(env, app);
  const student = rosterStudent(document, studentId, range.date);
  if (!await activeStaff(env, app, sourceTeacherId)) {
    problem('원 수업 담당 선생님이 비활성 상태입니다', 409, 'STAFF_INACTIVE');
  }
  const ids = await digestIds(app, sourceTaskId, range.date);
  const existing = await env.DB.prepare('SELECT * FROM makeup_cases WHERE app=? AND case_id=? LIMIT 1')
    .bind(app, ids.caseId).first();
  if (existing) {
    return manualExistingResponse(env, app, existing, student, source, sourceTaskId, studentId,
      sourceTeacherId, reason, range, json, origin);
  }
  await assertNoConflict(env, app, ids.caseId, studentId, sourceTeacherId, range);
  const history = [{
    action: 'create_manual', from: 'none', to: 'confirmed', actorId: actorId(auth),
    actorScope: String(auth.scope || ''),
    reason, date: range.date, startTime: range.startTime, endTime: range.endTime,
    staffId: sourceTeacherId, revision: 1, at: now, notificationNeeded: false
  }];
  const row = {
    app, case_id: ids.caseId, student_id: studentId, source_task_id: sourceTaskId,
    source_date: range.date, source_teacher_id: sourceTeacherId,
    consumption_group_id: ids.consumptionGroupId, status: 'confirmed', revision: 1,
    proposed_start_at: null, proposed_end_at: null, proposed_staff_id: null,
    confirmed_start_at: range.startAt, confirmed_end_at: range.endAt,
    confirmed_staff_id: sourceTeacherId, completed_at: null, completed_by: null,
    cancelled_at: null, cancelled_by: null, reason: null,
    notification_needed: 0, notification_event: null, notification_event_revision: 0,
    history: JSON.stringify(history), created_at: now, updated_at: now
  };
  const taskWrite = await prepareMakeupLessonWrite(
    env, app, row, source.task, student, sourceTeacherId, range, now
  );
  // source/staff/roster 조건은 INSERT 시점의 운영 정본으로 다시 검사한다. 사전 검증 뒤
  // 담당 변경·퇴원 등이 생기면 바로 다음 CAS guard가 전체 batch를 롤백한다.
  const insert = env.DB.prepare(
    'INSERT OR IGNORE INTO makeup_cases(app,case_id,student_id,source_task_id,source_date,source_teacher_id,' +
    'consumption_group_id,status,revision,confirmed_start_at,confirmed_end_at,confirmed_staff_id,' +
    'notification_needed,notification_event_revision,history,created_at,updated_at) ' +
    "SELECT ?,?,?,?,?,?,?,'confirmed',1,?,?,?,0,0,?,?,? WHERE EXISTS (" +
      'SELECT 1 FROM tasks source WHERE source.app=? AND source.id=? AND source.owner=? ' +
      'AND source.data=? AND source.updated_at=?) AND EXISTS (' +
      'SELECT 1 FROM staff teacher WHERE teacher.app=? AND teacher.id=? AND json_valid(teacher.data)=1 ' +
      "AND COALESCE(json_extract(teacher.data,'$.deleted'),0)=0) AND EXISTS (" +
      "SELECT 1 FROM private_rosters roster, json_each(roster.data,'$.roster.students') student " +
      'WHERE roster.app=? AND json_valid(roster.data)=1 ' +
      "AND json_extract(student.value,'$.id')=? " +
      "AND (COALESCE(json_extract(student.value,'$.start'),'')='' OR json_extract(student.value,'$.start')<=?) " +
      "AND (COALESCE(json_extract(student.value,'$.end'),'')='' OR ?<json_extract(student.value,'$.end')))"
  ).bind(app, ids.caseId, studentId, sourceTaskId, range.date, sourceTeacherId, ids.consumptionGroupId,
    range.startAt, range.endAt, sourceTeacherId, JSON.stringify(history), now, now,
    app, sourceTaskId, source.row.owner, source.row.data, Number(source.row.updated_at),
    app, sourceTeacherId, app, studentId, range.date.slice(0, 7), range.date.slice(0, 7));
  const statements = [
    insert,
    await taskWriteCasGuardStatement(env, app, 'makeup_create_manual_case', ids.caseId + '\n' + now, now),
    sourceIdentityGuardStatement(env, app, row, source.row),
    await casGuard(env, app, 'makeup_create_manual_source', row, now),
    regularConflictGuardStatement(env, app, row, studentId, sourceTeacherId, range),
    await casGuard(env, app, 'makeup_create_manual_conflict', row, now),
    taskWrite.statement,
    await casGuard(env, app, 'makeup_create_manual_task', row, now)
  ];
  let results;
  try {
    results = await env.DB.batch(statements);
  } catch (error) {
    if (isTaskWriteCasConflict(error)) {
      const raced = await env.DB.prepare('SELECT * FROM makeup_cases WHERE app=? AND case_id=? LIMIT 1')
        .bind(app, ids.caseId).first();
      if (raced) {
        return manualExistingResponse(env, app, raced, student, source, sourceTaskId, studentId,
          sourceTeacherId, reason, range, json, origin);
      }
      // 가능한 경우 구체적인 운영 충돌을 먼저 돌려주고, 정본 변경이면 CAS 충돌로 닫는다.
      await assertNoConflict(env, app, ids.caseId, studentId, sourceTeacherId, range);
      const freshSource = await manualSourceTask(env, app, sourceTaskId, studentId, range.date);
      rosterStudent(await loadRoster(env, app), studentId, range.date);
      if (!await activeStaff(env, app, String(freshSource.row.owner || ''))) {
        problem('원 수업 담당 선생님이 비활성 상태입니다', 409, 'STAFF_INACTIVE');
      }
    }
    mapAtomicMakeupError(error);
  }
  if (!Array.isArray(results) || results.length !== statements.length ||
      results.some(result => Number(result && result.meta && result.meta.changes || 0) !== 1)) {
    problem('다른 기기에서 보강 또는 보강 수업을 먼저 변경했습니다', 409, 'REVISION_CONFLICT');
  }
  const saved = await loadCase(env, app, ids.caseId);
  const lessonRow = await env.DB.prepare('SELECT owner,data FROM tasks WHERE app=? AND id=? LIMIT 1')
    .bind(app, makeupLessonId(ids.caseId)).first();
  const lessonTask = lessonRow && parseJson(lessonRow.data);
  assertMakeupLessonIdentity(lessonRow, lessonTask, saved, sourceTeacherId);
  return json({ ok: true, idempotent: false,
    case: publicCase(saved, student, source.task, null, lessonTask), lessonTask }, 200, origin);
}

async function createFromAbsence(env, app, body, auth, json, origin) {
  exactBody(body, ['sourceTaskId', 'sourceDate', 'creationMode']);
  const sourceTaskId = cleanId(body.sourceTaskId, 'sourceTaskId');
  const sourceDate = cleanDate(body.sourceDate, '결석 날짜');
  const creationMode = body.creationMode == null ? 'automatic' : String(body.creationMode || '');
  if (!['automatic', 'manual'].includes(creationMode)) {
    problem('보강 생성 방식을 확인해 주세요', 400, 'MAKEUP_CREATION_MODE_INVALID');
  }
  const source = await sourceTask(env, app, sourceTaskId, sourceDate);
  const studentId = cleanId(source.task.studentId, 'studentId');
  const sourceTeacherId = cleanId(source.row.owner, '수업 담당자');
  const document = await loadRoster(env, app);
  const student = rosterStudent(document, studentId, sourceDate);
  // 구형 화면은 creationMode를 보내지 않으므로 automatic으로 닫는다. 회차제 결석은
  // 해당 학생의 유효한 회차 시작일 이후부터 자동 생성하지 않는다. 시작일 이전 결석은
  // 당시 월제였던 기존 운영 규칙을 보존하고, 사용자가 보강 버튼을 직접 누른 경우는 허용한다.
  const cycleStartDate = String(student.sessionCycleStartDate || '');
  const parsedCycleStart = new Date(cycleStartDate + 'T00:00:00Z');
  const validCycleStart = ISO_DATE.test(cycleStartDate) && !Number.isNaN(parsedCycleStart.getTime()) &&
    parsedCycleStart.toISOString().slice(0, 10) === cycleStartDate;
  if (String(student.billingMode || 'monthly') === 'session4' && validCycleStart &&
      sourceDate >= cycleStartDate && creationMode !== 'manual') {
    problem('회차제 학생의 결석 보강은 자동 생성되지 않습니다. 필요하면 보강 버튼에서 직접 생성해 주세요',
      409, 'SESSION4_AUTOMATIC_MAKEUP_DISABLED');
  }
  if (auth.scope !== 'all' && sourceTeacherId !== auth.id) {
    return json({ ok: false, error: '담당 학생의 결석 수업만 보강으로 등록할 수 있습니다' }, 403, origin);
  }
  if (!await activeStaff(env, app, sourceTeacherId)) return json({ ok: false, error: '원 수업 담당자가 비활성 상태입니다' }, 409, origin);
  await assertAbsent(env, app, sourceTaskId, sourceDate, sourceTeacherId);
  const ids = await digestIds(app, sourceTaskId, sourceDate);
  const now = Date.now();
  const existing = await env.DB.prepare('SELECT * FROM makeup_cases WHERE app=? AND case_id=? LIMIT 1')
    .bind(app, ids.caseId).first();
  if (existing) {
    if (isManualCase(existing)) {
      problem('같은 원 수업과 날짜에 직접 생성한 보강이 이미 있습니다',
        409, 'MANUAL_MAKEUP_EXISTS');
    }
    if (String(existing.student_id) !== studentId || String(existing.source_task_id) !== sourceTaskId ||
        String(existing.source_date) !== sourceDate) {
      return json({ ok: false, code: 'MAKEUP_IDENTITY_MISMATCH', error: '보강 기록의 원 수업 정체성이 다릅니다' }, 409, origin);
    }
    const priorHistory = parseHistory(existing.history);
    const attendanceCancelled = existing.status === 'cancelled' && priorHistory.length > 0 &&
      priorHistory.at(-1).action === 'reconcile_attendance';
    if (!attendanceCancelled) {
      return json({ ok: true, idempotent: true, case: publicCase(existing, student, source.task) }, 200, origin);
    }
    const taskId = makeupLessonId(ids.caseId);
    const lessonRow = await env.DB.prepare('SELECT owner,data,updated_at FROM tasks WHERE app=? AND id=? LIMIT 1')
      .bind(app, taskId).first();
    const lessonTask = lessonRow && parseJson(lessonRow.data);
    if (lessonRow) {
      const priorStaffId = String(existing.confirmed_staff_id || sourceTeacherId);
      assertMakeupLessonIdentity(lessonRow, lessonTask, existing, priorStaffId);
      if (!lessonTask.deleted || await makeupLessonHasRecords(env, app, taskId)) {
        problem('출결 정정으로 숨긴 보강 수업 상태를 자동 복구할 수 없습니다', 409, 'MAKEUP_LESSON_HAS_RECORDS');
      }
    }
    const reopened = {
      ...existing, status: 'review_pending', proposed_start_at: null, proposed_end_at: null, proposed_staff_id: null,
      confirmed_start_at: null, confirmed_end_at: null, confirmed_staff_id: null,
      completed_at: null, completed_by: null, cancelled_at: null, cancelled_by: null, reason: null,
      notification_needed: 0, notification_event: null, notification_event_revision: 0
    };
    const event = { action: 'reopen_after_attendance_correction', from: 'cancelled', to: 'review_pending',
      actorId: actorId(auth), notificationNeeded: false };
    const statements = [
      sourceIdentityGuardStatement(env, app, existing, source.row),
      await casGuard(env, app, 'makeup_reopen_source', existing, now),
      env.DB.prepare(
        "UPDATE makeup_cases SET updated_at=updated_at WHERE app=? AND case_id=? AND revision=? AND status='cancelled' " +
        "AND EXISTS (SELECT 1 FROM checks WHERE checks.app=? AND checks.k=? AND checks.owner=? " +
        "AND json_valid(checks.data)=1 AND json_extract(checks.data,'$.att')='A')"
      ).bind(app, existing.case_id, Number(existing.revision), app, sourceTaskId + '|' + sourceDate, sourceTeacherId),
      await casGuard(env, app, 'makeup_reopen_absence', existing, now),
      transitionStatement(env, app, existing, reopened, event, now),
      await casGuard(env, app, 'makeup_reopen_case', existing, now)
    ];
    if (lessonRow) {
      const retargeted = { ...lessonTask, staffId: sourceTeacherId, deleted: true, updatedAt: now };
      statements.push(env.DB.prepare(
        'UPDATE tasks SET owner=?,data=?,updated_at=?,srv_at=? WHERE app=? AND id=? AND owner=? AND data=? AND updated_at=?'
      ).bind(sourceTeacherId, JSON.stringify(retargeted), now, now, app, taskId, lessonRow.owner,
        lessonRow.data, Number(lessonRow.updated_at)),
      await casGuard(env, app, 'makeup_reopen_task', existing, now));
    }
    try { await env.DB.batch(statements); }
    catch (error) {
      if (isTaskWriteCasConflict(error)) await assertAbsent(env, app, sourceTaskId, sourceDate, sourceTeacherId);
      mapAtomicMakeupError(error);
    }
    const saved = await loadCase(env, app, ids.caseId);
    return json({ ok: true, idempotent: false, case: publicCase(saved, student, source.task, null, lessonTask),
      ...(lessonTask ? { lessonTask: { ...lessonTask, staffId: sourceTeacherId, deleted: true, updatedAt: now } } : {}) }, 200, origin);
  }
  const history = [{ action: 'create_from_absence', creationMode, from: 'none', to: 'review_pending',
    actorId: actorId(auth), revision: 1, at: now, notificationNeeded: false }];
  const insert = env.DB.prepare(
    'INSERT OR IGNORE INTO makeup_cases(app,case_id,student_id,source_task_id,source_date,source_teacher_id,' +
    'consumption_group_id,status,revision,notification_needed,notification_event_revision,history,created_at,updated_at) ' +
    "SELECT ?,?,?,?,?,?,?,'review_pending',1,0,0,?,?,? WHERE EXISTS (" +
      'SELECT 1 FROM tasks source JOIN checks attendance ON attendance.app=source.app ' +
      'AND attendance.k=source.id||? WHERE source.app=? AND source.id=? AND source.owner=? AND source.data=? ' +
      'AND attendance.owner=source.owner AND json_valid(attendance.data)=1 ' +
      "AND json_extract(attendance.data,'$.att')='A' " +
      "AND (json_extract(attendance.data,'$.taskId') IS NULL OR json_extract(attendance.data,'$.taskId')=source.id) " +
      "AND (json_extract(attendance.data,'$.date') IS NULL OR json_extract(attendance.data,'$.date')=?))"
  ).bind(app, ids.caseId, studentId, sourceTaskId, sourceDate, sourceTeacherId, ids.consumptionGroupId,
    JSON.stringify(history), now, now, '|' + sourceDate, app, sourceTaskId, sourceTeacherId, source.row.data, sourceDate);
  try {
    await env.DB.batch([
      insert,
      await taskWriteCasGuardStatement(env, app, 'makeup_create_absence', ids.caseId + '\n' + now, now)
    ]);
  } catch (error) {
    if (isTaskWriteCasConflict(error)) {
      const raced = await env.DB.prepare('SELECT * FROM makeup_cases WHERE app=? AND case_id=? LIMIT 1')
        .bind(app, ids.caseId).first();
      if (raced) {
        if (isManualCase(raced)) {
          problem('같은 원 수업과 날짜에 직접 생성한 보강이 이미 있습니다',
            409, 'MANUAL_MAKEUP_EXISTS');
        }
        if (String(raced.student_id) !== studentId || String(raced.source_task_id) !== sourceTaskId ||
            String(raced.source_date) !== sourceDate) {
          problem('보강 기록의 원 수업 정체성이 다릅니다', 409, 'MAKEUP_IDENTITY_MISMATCH');
        }
        return json({ ok: true, idempotent: true, case: publicCase(raced, student, source.task) }, 200, origin);
      }
      await assertAbsent(env, app, sourceTaskId, sourceDate, sourceTeacherId);
      await sourceTask(env, app, sourceTaskId, sourceDate);
    }
    mapAtomicMakeupError(error);
  }
  const row = await loadCase(env, app, ids.caseId);
  if (String(row.student_id) !== studentId || String(row.source_task_id) !== sourceTaskId || String(row.source_date) !== sourceDate) {
    return json({ ok: false, code: 'MAKEUP_IDENTITY_MISMATCH', error: '보강 기록의 원 수업 정체성이 다릅니다' }, 409, origin);
  }
  return json({ ok: true, idempotent: false,
    case: publicCase(row, student, source.task) }, 200, origin);
}

async function reconcileAttendance(env, app, body, auth, json, origin) {
  exactBody(body, ['sourceTaskId', 'sourceDate']);
  const sourceTaskId = cleanId(body.sourceTaskId, 'sourceTaskId');
  const sourceDate = cleanDate(body.sourceDate, '수업 날짜');
  const ids = await digestIds(app, sourceTaskId, sourceDate);
  const row = await env.DB.prepare('SELECT * FROM makeup_cases WHERE app=? AND case_id=? LIMIT 1')
    .bind(app, ids.caseId).first();
  // 직접 생성한 보강 날짜는 원 정규 수업 요일과 다를 수 있다. 이 경우에도 출결 동기화가
  // 보강을 취소하지 않도록, recurrence 검증보다 먼저 생성 유형을 확인한다.
  const source = row && isManualCase(row)
    ? await manualSourceTask(env, app, sourceTaskId, String(row.student_id), sourceDate)
    : await sourceTask(env, app, sourceTaskId, sourceDate);
  const currentTeacherId = cleanId(source.row.owner, '현재 수업 담당자');
  if (auth.scope !== 'all' && String(auth.id || '') !== currentTeacherId) {
    return json({ ok: false, error: '현재 담당 수업의 출결만 정정할 수 있습니다' }, 403, origin);
  }
  if (row && isManualCase(row)) {
    await assertCaseIdentity(env, app, row);
    const document = await loadRoster(env, app);
    const student = rosterStudent(document, String(row.student_id), sourceDate);
    const lessonRow = await env.DB.prepare('SELECT data FROM tasks WHERE app=? AND id=? LIMIT 1')
      .bind(app, makeupLessonId(ids.caseId)).first();
    const lessonTask = lessonRow && parseJson(lessonRow.data);
    return json({ ok: true, idempotent: true,
      case: publicCase(row, student, source.task, null, lessonTask), ...(lessonTask ? { lessonTask } : {}) }, 200, origin);
  }
  const key = sourceTaskId + '|' + sourceDate;
  const checkRow = await env.DB.prepare('SELECT owner,data FROM checks WHERE app=? AND k=? LIMIT 1').bind(app, key).first();
  const check = checkRow && parseJson(checkRow.data);
  if (!checkRow || String(checkRow.owner || '') !== currentTeacherId || !check || check.att !== 'P') {
    problem('서버 출결이 출석(P)으로 저장된 경우에만 연결된 보강을 취소할 수 있습니다',
      409, 'ATTENDANCE_CORRECTION_REQUIRED');
  }
  if (!row) return json({ ok: true, idempotent: true, case: null }, 200, origin);
  await assertCaseIdentity(env, app, row);
  const document = await loadRoster(env, app);
  const student = rosterStudent(document, String(row.student_id), sourceDate);
  if (row.status === 'completed') problem('이미 완료된 보강은 출석 정정으로 취소할 수 없습니다', 409, 'MAKEUP_ALREADY_COMPLETED');
  if (row.status === 'cancelled') {
    const lessonRow = await env.DB.prepare('SELECT data FROM tasks WHERE app=? AND id=? LIMIT 1')
      .bind(app, makeupLessonId(ids.caseId)).first();
    const lessonTask = lessonRow && parseJson(lessonRow.data);
    return json({ ok: true, idempotent: true,
      case: publicCase(row, student, source.task, null, lessonTask), ...(lessonTask ? { lessonTask } : {}) }, 200, origin);
  }
  if (!ACTIVE_STATUSES.has(String(row.status))) problem('현재 보강 상태를 정정할 수 없습니다', 409, 'INVALID_TRANSITION');
  const now = Date.now();
  const next = { ...row, status: 'cancelled', cancelled_at: now, cancelled_by: actorId(auth),
    reason: 'already_resolved', notification_needed: 0, notification_event: null, notification_event_revision: 0 };
  const event = { action: 'reconcile_attendance', from: row.status, to: 'cancelled', actorId: actorId(auth),
    reason: 'already_resolved', notificationNeeded: false };
  const staffId = String(row.confirmed_staff_id || currentTeacherId);
  const taskDelete = await prepareMakeupLessonDelete(env, app, row, staffId, now);
  const statements = [
    sourceIdentityGuardStatement(env, app, row, source.row),
    await casGuard(env, app, 'makeup_reconcile_source', row, now),
    env.DB.prepare(
      "UPDATE makeup_cases SET updated_at=updated_at WHERE app=? AND case_id=? AND revision=? AND status=? " +
      "AND EXISTS (SELECT 1 FROM checks WHERE checks.app=? AND checks.k=? AND checks.owner=? " +
      "AND json_valid(checks.data)=1 AND json_extract(checks.data,'$.att')='P')"
    ).bind(app, row.case_id, Number(row.revision), row.status, app, key, currentTeacherId),
    await casGuard(env, app, 'makeup_reconcile_attendance', row, now)
  ];
  if (!taskDelete) {
    statements.push(env.DB.prepare(
      'UPDATE makeup_cases SET updated_at=updated_at WHERE app=? AND case_id=? AND revision=? ' +
      'AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.app=? AND tasks.id=?)'
    ).bind(app, row.case_id, Number(row.revision), app, makeupLessonId(ids.caseId)),
    await casGuard(env, app, 'makeup_reconcile_missing_task', row, now));
  }
  statements.push(transitionStatement(env, app, row, next, event, now),
    await casGuard(env, app, 'makeup_reconcile_case', row, now));
  if (taskDelete) statements.push(taskDelete, await casGuard(env, app, 'makeup_reconcile_task', row, now));
  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (isTaskWriteCasConflict(error)) {
      const freshCheck = await env.DB.prepare('SELECT owner,data FROM checks WHERE app=? AND k=? LIMIT 1')
        .bind(app, key).first();
      const fresh = freshCheck && parseJson(freshCheck.data);
      if (!freshCheck || String(freshCheck.owner || '') !== currentTeacherId || !fresh || fresh.att !== 'P') {
        problem('서버 출결이 더 이상 출석(P)이 아닙니다', 409, 'ATTENDANCE_CORRECTION_REQUIRED');
      }
    }
    mapAtomicMakeupError(error);
  }
  const saved = await loadCase(env, app, ids.caseId);
  const lessonRow = await env.DB.prepare('SELECT data FROM tasks WHERE app=? AND id=? LIMIT 1')
    .bind(app, makeupLessonId(ids.caseId)).first();
  const lessonTask = lessonRow && parseJson(lessonRow.data);
  return json({ ok: true, idempotent: false,
    case: publicCase(saved, student, source.task, null, lessonTask), ...(lessonTask ? { lessonTask } : {}) }, 200, origin);
}

export async function handleMakeup(env, app, body, origin, auth, json) {
  if (app !== 'task') return json({ ok: false, error: '이 기능은 직원 앱에서만 사용할 수 있습니다' }, 400, origin);
  if (!auth || (auth.scope !== 'own' && auth.scope !== 'all')) return json({ ok: false, error: '인증이 필요합니다' }, 401, origin);
  const action = String(body && body.action || '');
  if (!ACTIONS.has(action)) return json({ ok: false, error: 'action을 확인해 주세요' }, 400, origin);

  try {
    if (action === 'list') return await listCases(env, app, body, auth, json, origin);
    if (action === 'create_from_absence') return await createFromAbsence(env, app, body, auth, json, origin);
    if (action === 'create_manual') return await createManual(env, app, body, auth, json, origin);
    if (action === 'reconcile_attendance') return await reconcileAttendance(env, app, body, auth, json, origin);

    const administrative = new Set(['review', 'propose', 'confirm', 'schedule', 'restore_schedule', 'no_makeup', 'cancel']);
    if (administrative.has(action) && auth.scope !== 'all') {
      return json({ ok: false, error: '원장·관리 담당만 보강을 검토하거나 확정할 수 있습니다' }, 403, origin);
    }
    exactBody(body, action === 'review' ? ['caseId', 'revision', 'decision', 'reason'] :
      action === 'propose' ? ['caseId', 'revision', 'date', 'startTime', 'endTime', 'staffId'] :
      action === 'schedule' ? ['caseId', 'revision', 'date', 'startTime', 'endTime'] :
      action === 'complete' ? ['caseId', 'revision', 'date', 'startTime', 'endTime'] :
      (action === 'cancel' || action === 'no_makeup') ? ['caseId', 'revision', 'reason'] :
      ['caseId', 'revision']);
    const caseId = cleanId(body.caseId, 'caseId');
    const revision = expectedRevision(body);
    const row = await loadCase(env, app, caseId);
    if (Number(row.revision) !== revision) return conflictResponse(env, app, caseId, json, origin);
    const sourceSnapshot = await assertCaseIdentity(env, app, row);
    const source = sourceSnapshot.task;
    const sourceIdentity = sourceSnapshot.identity;
    const currentSourceTeacherId = cleanId(source.staffId, '현재 원 수업 담당자');
    const latestResponse = await latestParentResponse(env, app, row);
    const requestNow = Date.now();
    const document = await loadRoster(env, app);
    let student = rosterStudent(document, String(row.student_id), String(row.source_date));
    const next = { ...row };
    let event;
    let scheduledSave = null;
    let completion = null;
    let cancellation = false;

    if (action === 'restore_schedule') {
      if (row.status !== 'confirmed' || !row.confirmed_start_at || !row.confirmed_end_at || !row.confirmed_staff_id) {
        problem('확정되었지만 수업이 누락된 보강만 복구할 수 있습니다', 409, 'INVALID_TRANSITION');
      }
      const range = kstRange(String(row.confirmed_start_at).slice(0, 10),
        String(row.confirmed_start_at).slice(11, 16), String(row.confirmed_end_at).slice(11, 16));
      const staffId = cleanId(row.confirmed_staff_id, '확정 보강 담당자');
      student = rosterStudent(document, String(row.student_id), range.date);
      const existingRow = await env.DB.prepare('SELECT owner,data FROM tasks WHERE app=? AND id=? LIMIT 1')
        .bind(app, makeupLessonId(caseId)).first();
      const existing = existingRow && parseJson(existingRow.data);
      if (existingRow) {
        assertMakeupLessonIdentity(existingRow, existing, row, staffId);
        if (!existing.deleted) {
          return json({ ok: true, idempotent: true,
            case: publicCase(row, student, source, latestResponse, existing), lessonTask: existing }, 200, origin);
        }
        // 삭제 표시 뒤 수업 기록이 붙었다면 어느 날짜의 기록인지 자동 판단하지 않는다.
        // 기록 없는 tombstone만 확정 일정으로 되살려 과거 기록의 잘못된 노출을 막는다.
        if (await makeupLessonHasRecords(env, app, makeupLessonId(caseId))) {
          problem('기존 기록이 연결된 삭제 보강은 자동 복구할 수 없습니다', 409, 'MAKEUP_LESSON_HAS_RECORDS');
        }
      }
      if (!await activeStaff(env, app, staffId)) problem('확정된 보강 담당 선생님이 비활성 상태입니다', 409, 'STAFF_INACTIVE');
      await assertNoConflict(env, app, caseId, String(row.student_id), staffId, range);
      const taskWrite = await prepareMakeupLessonWrite(env, app, row, source, student, staffId, range, requestNow);
      const restoreAttempt = existingRow ? String(existingRow.updated_at || '') + '\n' + String(existingRow.data || '') : 'new';
      let results;
      try {
        results = await env.DB.batch([
          sourceIdentityGuardStatement(env, app, row, sourceIdentity),
          await casGuard(env, app, 'makeup_restore_source', row, requestNow, restoreAttempt),
          regularConflictGuardStatement(env, app, row, String(row.student_id), staffId, range),
          await casGuard(env, app, 'makeup_restore_conflict', row, requestNow, restoreAttempt),
          taskWrite.statement,
          await casGuard(env, app, 'makeup_restore_task', row, requestNow, restoreAttempt)
        ]);
      } catch (error) {
        if (isTaskWriteCasConflict(error)) {
          await assertNoConflict(env, app, caseId, String(row.student_id), staffId, range);
        }
        mapAtomicMakeupError(error);
      }
      if (!Array.isArray(results) || results.length !== 6 ||
          results.some(result => Number(result && result.meta && result.meta.changes || 0) !== 1)) {
        return conflictResponse(env, app, caseId, json, origin);
      }
      return json({ ok: true, idempotent: false,
        case: publicCase(row, student, source, latestResponse, taskWrite.task), lessonTask: taskWrite.task }, 200, origin);
    }

    if (action === 'review') {
      if (row.status !== 'review_pending') problem('검토 대기 보강만 검토할 수 있습니다', 409, 'INVALID_TRANSITION');
      const decision = String(body.decision || '');
      if (decision !== 'required' && decision !== 'not_required') problem('decision은 required 또는 not_required여야 합니다');
      const reason = cleanReason(body.reason, decision === 'not_required');
      next.status = decision === 'required' ? 'reviewed' : 'cancelled';
      next.reason = reason || null;
      if (decision === 'not_required') { next.cancelled_at = Date.now(); next.cancelled_by = actorId(auth); }
      event = { action, decision, from: row.status, to: next.status, actorId: actorId(auth),
        ...(reason ? { reason } : {}), notificationNeeded: false };
    } else if (action === 'propose') {
      if (row.status !== 'reviewed' && row.status !== 'awaiting_parent') problem('검토 완료 또는 학부모 응답 대기 상태에서만 일정을 제안할 수 있습니다', 409, 'INVALID_TRANSITION');
      const range = kstRange(body.date, body.startTime, body.endTime);
      assertSlotNotEnded(range, requestNow);
      const staffId = cleanId(body.staffId, 'staffId');
      rosterStudent(document, String(row.student_id), range.date);
      if (!await activeStaff(env, app, staffId)) problem('활성 담당 선생님을 선택해 주세요', 409, 'STAFF_INACTIVE');
      await assertNoConflict(env, app, caseId, String(row.student_id), staffId, range);
      next.status = 'awaiting_parent'; next.proposed_start_at = range.startAt; next.proposed_end_at = range.endAt;
      next.proposed_staff_id = staffId; next.notification_needed = 1;
      next.notification_event = 'proposal'; next.notification_event_revision = revision + 1;
      event = { action, from: row.status, to: next.status, actorId: actorId(auth), date: range.date,
        startTime: range.startTime, endTime: range.endTime, staffId, notificationNeeded: true };
    } else if (action === 'confirm') {
      if (row.status !== 'awaiting_parent' || !row.proposed_start_at || !row.proposed_end_at || !row.proposed_staff_id) {
        problem('일정 제안 상태에서만 확정할 수 있습니다', 409, 'INVALID_TRANSITION');
      }
      const parentResponse = await parentResponseForRevision(env, app, row);
      if (parentResponse && parentResponse.response === 'decline') {
        problem('학부모가 참석 불가로 응답했습니다. 새 일정을 제안해 주세요', 409, 'PARENT_DECLINED');
      }
      const range = kstRange(String(row.proposed_start_at).slice(0, 10), String(row.proposed_start_at).slice(11, 16),
        String(row.proposed_end_at).slice(11, 16));
      assertSlotNotEnded(range, requestNow);
      student = rosterStudent(document, String(row.student_id), range.date);
      if (!await activeStaff(env, app, String(row.proposed_staff_id))) problem('제안된 담당 선생님이 비활성 상태입니다', 409, 'STAFF_INACTIVE');
      await assertNoConflict(env, app, caseId, String(row.student_id), String(row.proposed_staff_id), range);
      next.status = 'confirmed'; next.confirmed_start_at = row.proposed_start_at; next.confirmed_end_at = row.proposed_end_at;
      next.confirmed_staff_id = row.proposed_staff_id; next.notification_needed = 1;
      next.notification_event = 'confirmed'; next.notification_event_revision = revision + 1;
      event = { action, from: row.status, to: next.status, actorId: actorId(auth), notificationNeeded: true };
      scheduledSave = { staffId: String(row.proposed_staff_id), range };
    } else if (action === 'schedule') {
      if (!['review_pending', 'reviewed', 'awaiting_parent'].includes(String(row.status))) {
        problem('일정이 아직 생성되지 않은 보강만 생성할 수 있습니다', 409, 'INVALID_TRANSITION');
      }
      const range = kstRange(body.date, body.startTime, body.endTime);
      assertSlotNotEnded(range, requestNow);
      const staffId = currentSourceTeacherId;
      student = rosterStudent(document, String(row.student_id), range.date);
      if (!await activeStaff(env, app, staffId)) problem('원 수업 담당 선생님이 비활성 상태입니다', 409, 'STAFF_INACTIVE');
      await assertNoConflict(env, app, caseId, String(row.student_id), staffId, range);
      next.status = 'confirmed';
      next.confirmed_start_at = range.startAt;
      next.confirmed_end_at = range.endAt;
      next.confirmed_staff_id = staffId;
      next.notification_needed = 0;
      next.notification_event = null;
      next.notification_event_revision = 0;
      event = {
        action, from: row.status, to: next.status, actorId: actorId(auth), date: range.date,
        startTime: range.startTime, endTime: range.endTime, staffId, notificationNeeded: false
      };
      scheduledSave = { staffId, range };
    } else if (action === 'complete') {
      const direct = row.status !== 'confirmed';
      if (direct && !['review_pending', 'reviewed', 'awaiting_parent'].includes(String(row.status))) {
        problem('일정 미생성 또는 확정 상태의 보강만 완료할 수 있습니다', 409, 'INVALID_TRANSITION');
      }
      const supplied = [body.date, body.startTime, body.endTime].map(value => String(value || '').trim());
      if (supplied.some(Boolean) && !supplied.every(Boolean)) {
        problem('실제 보강 날짜·시작시간·종료시간을 모두 입력해 주세요');
      }
      if (direct && !supplied.every(Boolean)) {
        problem('일정 없이 완료할 때는 실제 보강 날짜·시작시간·종료시간이 필요합니다');
      }
      const range = supplied.every(Boolean)
        ? kstRange(supplied[0], supplied[1], supplied[2])
        : kstRange(String(row.confirmed_start_at || '').slice(0, 10),
          String(row.confirmed_start_at || '').slice(11, 16), String(row.confirmed_end_at || '').slice(11, 16));
      if (requestNow < Date.parse(range.endAt) - COMPLETE_EARLY_MS) {
        problem('보강 종료 5분 전부터 완료할 수 있습니다', 409, 'MAKEUP_NOT_ENDED');
      }
      const staffId = direct ? currentSourceTeacherId : cleanId(row.confirmed_staff_id, '보강 담당자');
      if (auth.scope !== 'all' && (!auth.id || String(auth.id) !== staffId)) {
        return json({ ok: false, code: 'MAKEUP_COMPLETE_FORBIDDEN',
          error: '보강 담당 선생님의 개인 인증 또는 관리자 인증으로만 완료할 수 있습니다' }, 403, origin);
      }
      student = rosterStudent(document, String(row.student_id), range.date);
      if (!await activeStaff(env, app, staffId)) {
        problem('확정된 보강 담당 선생님이 비활성 상태입니다', 409, 'STAFF_INACTIVE');
      }
      next.status = 'completed';
      next.completed_at = requestNow;
      // DB trigger는 완료 수업의 담당자를 completed_by로 강제하고, 실제 조작자는 history에 별도로 남긴다.
      next.completed_by = staffId;
      next.notification_needed = 0;
      event = {
        action, from: row.status, to: next.status, actorId: actorId(auth), date: range.date,
        startTime: range.startTime, endTime: range.endTime, staffId, direct, notificationNeeded: false
      };
      completion = await saveCompletion(env, app, row, next, event, document, source, student, staffId, range,
        direct, currentSourceTeacherId, sourceIdentity, json, origin, requestNow);
    } else {
      if (!ACTIVE_STATUSES.has(String(row.status))) {
        problem('현재 상태에서는 보강을 취소할 수 없습니다', 409, 'INVALID_TRANSITION');
      }
      const reason = action === 'no_makeup'
        ? cleanReason(body.reason || 'policy_ineligible', true)
        : cleanReason(body.reason, true);
      next.status = 'cancelled'; next.cancelled_at = Date.now(); next.cancelled_by = actorId(auth); next.reason = reason;
      // 새 3버튼 흐름의 `보강없음`은 보호자 제안 절차와 분리한다. 과거 cancel API만
      // 이미 발송된 레거시 제안의 취소 알림 표식을 유지한다.
      const notify = action === 'cancel' &&
        (row.status === 'awaiting_parent' || (row.status === 'confirmed' && !!row.proposed_start_at));
      if (action === 'no_makeup') {
        next.notification_needed = 0;
        next.notification_event = null;
        next.notification_event_revision = 0;
      } else if (notify) {
        next.notification_needed = 1; next.notification_event = 'cancelled'; next.notification_event_revision = revision + 1;
      }
      event = { action, from: row.status, to: next.status, actorId: actorId(auth), reason, notificationNeeded: notify };
      cancellation = true;
    }

    const saved = completion ? (completion instanceof Response ? completion : completion.saved)
      : scheduledSave
        ? await saveSchedule(env, app, row, next, event, source, sourceIdentity, student, scheduledSave.staffId,
          scheduledSave.range, json, origin, requestNow)
        : cancellation
          ? await saveCancellation(env, app, row, next, event, currentSourceTeacherId, json, origin, requestNow)
          : await saveTransition(env, app, row, next, event, json, origin, requestNow);
    if (saved instanceof Response) return saved;
    const task = await env.DB.prepare('SELECT data FROM tasks WHERE app=? AND id=? LIMIT 1').bind(app, row.source_task_id).first();
    const lessonTaskRow = await env.DB.prepare('SELECT data FROM tasks WHERE app=? AND id=? LIMIT 1')
      .bind(app, makeupLessonId(String(row.case_id))).first();
    const lessonTask = lessonTaskRow && parseJson(lessonTaskRow.data);
    return json({ ok: true, case: publicCase(saved, student, task && parseJson(task.data), latestResponse, lessonTask),
      ...(lessonTask ? { lessonTask } : {}),
      ...(completion && completion.impact ? { sessionPackImpact: completion.impact } : {}) }, 200, origin);
  } catch (error) {
    return json({ ok: false, ...(error.code ? { code: error.code } : {}), error: String(error.message || error) },
      Number(error.status) || 400, origin);
  }
}
