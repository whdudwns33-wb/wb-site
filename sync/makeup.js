import { validateRosterDocument } from './roster.js';
import { verifySessionPackIdentity } from './session-pack.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const COMPLETE_EARLY_MS = 5 * 60 * 1000;
const STATUSES = new Set(['review_pending', 'reviewed', 'awaiting_parent', 'confirmed', 'completed', 'cancelled']);
const ACTIONS = new Set(['list', 'create_from_absence', 'review', 'propose', 'confirm', 'complete', 'cancel']);
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
    const intervals = taskIntervals(task, range.date);
    if (intervals === null) continue;
    const sameStudent = String(task.studentId || '') === studentId;
    const sameTeacher = String(task.staffId || row.owner || '') === staffId;
    if (!sameStudent && !sameTeacher) continue;
    if (!intervals.length) {
      problem('겹침을 확인할 수 없는 정규 수업이 있습니다. 먼저 정규 시간표를 확정해 주세요', 409, 'SCHEDULE_UNCONFIRMED');
    }
    if (intervals.some(([start, end]) => overlap(range.startTime, range.endTime, start, end))) {
      problem(sameStudent ? '학생의 정규 수업과 시간이 겹칩니다' : '담당 선생님의 정규 수업과 시간이 겹칩니다', 409,
        sameStudent ? 'STUDENT_SCHEDULE_CONFLICT' : 'STAFF_SCHEDULE_CONFLICT');
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

function publicCase(row, student, task, parentResponse) {
  const proposed = scheduleView('proposed', row);
  const confirmed = scheduleView('confirmed', row);
  return {
    caseId: String(row.case_id), studentId: String(row.student_id),
    studentName: student ? String(student.name || '') : '', grade: student ? String(student.grade || '') : '',
    sourceTaskId: String(row.source_task_id), sourceDate: String(row.source_date),
    sourceTeacherId: String(row.source_teacher_id), consumptionGroupId: String(row.consumption_group_id),
    subject: task ? String(task.subject || '') : '', className: task ? String(task.className || '') : '',
    status: String(row.status), revision: Number(row.revision),
    proposedDate: proposed.date, proposedStartTime: proposed.startTime, proposedEndTime: proposed.endTime,
    proposedStaffId: proposed.staffId,
    confirmedDate: confirmed.date, confirmedStartTime: confirmed.startTime, confirmedEndTime: confirmed.endTime,
    confirmedStaffId: confirmed.staffId,
    completedAt: row.completed_at == null ? null : Number(row.completed_at),
    cancelledAt: row.cancelled_at == null ? null : Number(row.cancelled_at),
    reason: row.reason || '', notificationNeeded: Number(row.notification_needed) === 1,
    notificationEvent: row.notification_event || null,
    notificationEventRevision: Number(row.notification_event_revision || 0),
    parentResponse: parentResponse ? String(parentResponse.response || '') : '',
    parentRespondedAt: parentResponse ? Number(parentResponse.created_at) : null,
    parentResponseRevision: parentResponse ? Number(parentResponse.revision) : null,
    history: parseHistory(row.history), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at)
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
  const row = await env.DB.prepare('SELECT owner,data FROM tasks WHERE app=? AND id=? LIMIT 1').bind(app, sourceTaskId).first();
  const task = row && parseJson(row.data);
  if (!row || !isLesson(task) || String(task.id || '') !== sourceTaskId ||
      !SAFE_ID.test(String(task.studentId || ''))) {
    problem('stable studentId가 있는 수업을 찾을 수 없습니다', 404, 'LESSON_MISSING');
  }
  if (String(task.staffId || '') !== String(row.owner || '')) {
    problem('수업 담당자 정보가 일치하지 않습니다', 409, 'LESSON_IDENTITY_MISMATCH');
  }
  if (!occurs(task, sourceDate)) problem('해당 날짜에 예정된 수업이 아닙니다', 409, 'LESSON_NOT_SCHEDULED');
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
  const taskRow = await env.DB.prepare('SELECT owner,data FROM tasks WHERE app=? AND id=? LIMIT 1')
    .bind(app, row.source_task_id).first();
  const task = taskRow && parseJson(taskRow.data);
  if (!taskRow || !task || !isLesson(task) || String(task.id || '') !== String(row.source_task_id) ||
      String(task.studentId || '') !== String(row.student_id) ||
      String(task.staffId || '') !== String(taskRow.owner || '')) {
    problem('원 수업과 보강 기록의 학생·담당자가 일치하지 않습니다', 409, 'MAKEUP_IDENTITY_MISMATCH');
  }
  return task;
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

function transitionStatement(env, app, row, next, event, now) {
  const revision = Number(row.revision) + 1;
  const history = parseHistory(row.history).concat({ ...event, revision, at: now });
  return env.DB.prepare(
    'UPDATE makeup_cases SET status=?,revision=?,proposed_start_at=?,proposed_end_at=?,proposed_staff_id=?,' +
    'confirmed_start_at=?,confirmed_end_at=?,confirmed_staff_id=?,completed_at=?,completed_by=?,cancelled_at=?,' +
    'cancelled_by=?,reason=?,notification_needed=?,notification_event=?,notification_event_revision=?,history=?,updated_at=? ' +
    'WHERE app=? AND case_id=? AND revision=? AND status=?'
  ).bind(next.status, revision, next.proposed_start_at, next.proposed_end_at, next.proposed_staff_id,
    next.confirmed_start_at, next.confirmed_end_at, next.confirmed_staff_id, next.completed_at, next.completed_by,
    next.cancelled_at, next.cancelled_by, next.reason, next.notification_needed, next.notification_event,
    next.notification_event_revision, JSON.stringify(history), now, app, row.case_id, Number(row.revision), row.status);
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

async function saveCompletion(env, app, row, next, event, document, json, origin, now) {
  const pack = await activeSessionPack(env, app, row);
  if (!pack) {
    const impact = { status: 'not_applicable', reason: 'no_active_pack', refreshNeeded: false };
    const saved = await saveTransition(env, app, row, next, { ...event, sessionPackImpact: impact }, json, origin, now);
    return saved instanceof Response ? saved : { saved, impact };
  }
  const packContext = await verifySessionPackIdentity(env, app, document, pack);
  if (packContext.error || String(pack.task_owner) !== String(row.source_teacher_id)) {
    const impact = { status: 'not_applicable', reason: 'pack_identity_mismatch', refreshNeeded: false };
    const saved = await saveTransition(env, app, row, next, { ...event, sessionPackImpact: impact }, json, origin, now);
    return saved instanceof Response ? saved : { saved, impact };
  }
  if (String(row.source_date) < String(pack.valid_from) || String(row.source_date) > String(pack.expires_on)) {
    const impact = { status: 'not_applicable', reason: 'source_date_out_of_range', refreshNeeded: false };
    const saved = await saveTransition(env, app, row, next, { ...event, sessionPackImpact: impact }, json, origin, now);
    return saved instanceof Response ? saved : { saved, impact };
  }
  const positive = await env.DB.prepare(
    'SELECT entry_id FROM session_pack_usage WHERE app=? AND pack_id=? AND consumption_group_id=? AND delta>0 LIMIT 1'
  ).bind(app, pack.pack_id, row.consumption_group_id).first();
  const delta = positive ? 0 : 1;
  const impact = {
    status: 'recorded', packId: String(pack.pack_id), delta,
    packRevision: Number(pack.revision) + 1, refreshNeeded: true
  };
  const usage = env.DB.prepare(
    'INSERT INTO session_pack_usage(app,entry_id,pack_id,expected_revision,source_type,source_ref,source_date,' +
    'attendance_event,delta,consumption_group_id,reason_code,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).bind(app, 'su_' + crypto.randomUUID().replace(/-/g, ''), pack.pack_id, Number(pack.revision), 'makeup',
    row.case_id, row.source_date, 'makeup_completed', delta, row.consumption_group_id, 'makeup_atomic_v1',
    String(next.completed_by), now);
  let results;
  try {
    results = await env.DB.batch([
      transitionStatement(env, app, row, next, { ...event, sessionPackImpact: impact }, now),
      usage
    ]);
  } catch (error) {
    if (/SESSION_PACK_IDENTITY_MISMATCH/.test(String(error && error.message || error))) {
      const mismatch = { status: 'not_applicable', reason: 'pack_identity_mismatch', refreshNeeded: false };
      const saved = await saveTransition(env, app, row, next, { ...event, sessionPackImpact: mismatch },
        json, origin, now);
      return saved instanceof Response ? saved : { saved, impact: mismatch };
    }
    completionBatchError(error);
  }
  if (!results[0] || !results[0].meta || Number(results[0].meta.changes || 0) !== 1) {
    return conflictResponse(env, app, row.case_id, json, origin);
  }
  const saved = await env.DB.prepare('SELECT * FROM makeup_cases WHERE app=? AND case_id=? LIMIT 1')
    .bind(app, row.case_id).first();
  return { saved, impact };
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
  const currentOwners = new Map();
  for (const taskId of taskIds) {
    const row = await env.DB.prepare('SELECT owner,data FROM tasks WHERE app=? AND id=? LIMIT 1').bind(app, taskId).first();
    const task = row && parseJson(row.data);
    const owner = String(row && row.owner || '');
    if (!task || !isLesson(task) || String(task.id || '') !== taskId ||
        String(task.staffId || '') !== owner || !SAFE_ID.test(owner)) continue;
    tasks.set(taskId, task);
    currentOwners.set(taskId, owner);
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
    tasks.get(String(row.source_task_id)), responses.get(String(row.case_id)))) }, 200, origin);
}

async function createFromAbsence(env, app, body, auth, json, origin) {
  exactBody(body, ['sourceTaskId', 'sourceDate']);
  const sourceTaskId = cleanId(body.sourceTaskId, 'sourceTaskId');
  const sourceDate = cleanDate(body.sourceDate, '결석 날짜');
  const source = await sourceTask(env, app, sourceTaskId, sourceDate);
  const studentId = cleanId(source.task.studentId, 'studentId');
  const sourceTeacherId = cleanId(source.row.owner, '수업 담당자');
  const document = await loadRoster(env, app);
  const student = rosterStudent(document, studentId, sourceDate);
  if (auth.scope !== 'all' && sourceTeacherId !== auth.id) {
    return json({ ok: false, error: '담당 학생의 결석 수업만 보강으로 등록할 수 있습니다' }, 403, origin);
  }
  if (!await activeStaff(env, app, sourceTeacherId)) return json({ ok: false, error: '원 수업 담당자가 비활성 상태입니다' }, 409, origin);
  await assertAbsent(env, app, sourceTaskId, sourceDate, sourceTeacherId);
  const ids = await digestIds(app, sourceTaskId, sourceDate);
  const now = Date.now();
  const history = [{ action: 'create_from_absence', from: 'none', to: 'review_pending', actorId: actorId(auth),
    revision: 1, at: now, notificationNeeded: false }];
  const inserted = await env.DB.prepare(
    'INSERT OR IGNORE INTO makeup_cases(app,case_id,student_id,source_task_id,source_date,source_teacher_id,' +
    'consumption_group_id,status,revision,notification_needed,notification_event_revision,history,created_at,updated_at) ' +
    "VALUES(?,?,?,?,?,?,?,'review_pending',1,0,0,?,?,?)"
  ).bind(app, ids.caseId, studentId, sourceTaskId, sourceDate, sourceTeacherId, ids.consumptionGroupId,
    JSON.stringify(history), now, now).run();
  const row = await loadCase(env, app, ids.caseId);
  if (String(row.student_id) !== studentId || String(row.source_task_id) !== sourceTaskId || String(row.source_date) !== sourceDate) {
    return json({ ok: false, code: 'MAKEUP_IDENTITY_MISMATCH', error: '보강 기록의 원 수업 정체성이 다릅니다' }, 409, origin);
  }
  return json({ ok: true, idempotent: Number(inserted.meta && inserted.meta.changes || 0) !== 1,
    case: publicCase(row, student, source.task) }, 200, origin);
}

export async function handleMakeup(env, app, body, origin, auth, json) {
  if (app !== 'task') return json({ ok: false, error: '이 기능은 직원 앱에서만 사용할 수 있습니다' }, 400, origin);
  if (!auth || (auth.scope !== 'own' && auth.scope !== 'all')) return json({ ok: false, error: '인증이 필요합니다' }, 401, origin);
  const action = String(body && body.action || '');
  if (!ACTIONS.has(action)) return json({ ok: false, error: 'action을 확인해 주세요' }, 400, origin);

  try {
    if (action === 'list') return await listCases(env, app, body, auth, json, origin);
    if (action === 'create_from_absence') return await createFromAbsence(env, app, body, auth, json, origin);

    const administrative = new Set(['review', 'propose', 'confirm', 'cancel']);
    if (administrative.has(action) && auth.scope !== 'all') {
      return json({ ok: false, error: '원장·관리 담당만 보강을 검토하거나 확정할 수 있습니다' }, 403, origin);
    }
    exactBody(body, action === 'review' ? ['caseId', 'revision', 'decision', 'reason'] :
      action === 'propose' ? ['caseId', 'revision', 'date', 'startTime', 'endTime', 'staffId'] :
      action === 'cancel' ? ['caseId', 'revision', 'reason'] : ['caseId', 'revision']);
    const caseId = cleanId(body.caseId, 'caseId');
    const revision = expectedRevision(body);
    const row = await loadCase(env, app, caseId);
    if (Number(row.revision) !== revision) return conflictResponse(env, app, caseId, json, origin);
    await assertCaseIdentity(env, app, row);
    const latestResponse = await latestParentResponse(env, app, row);
    const requestNow = Date.now();
    const document = await loadRoster(env, app);
    let student = rosterStudent(document, String(row.student_id),
      action === 'propose' ? cleanDate(body.date, '보강 날짜') : String(row.source_date));
    if (action === 'complete' && (!(auth.scope === 'own' || auth.role === 'manager') ||
        !auth.id || String(row.confirmed_staff_id || '') !== String(auth.id))) {
      return json({ ok: false, code: 'MAKEUP_COMPLETE_FORBIDDEN',
        error: '확정된 담당 선생님의 개인 인증으로만 보강을 완료할 수 있습니다' }, 403, origin);
    }
    const next = { ...row };
    let event;

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
      rosterStudent(document, String(row.student_id), range.date);
      if (!await activeStaff(env, app, String(row.proposed_staff_id))) problem('제안된 담당 선생님이 비활성 상태입니다', 409, 'STAFF_INACTIVE');
      await assertNoConflict(env, app, caseId, String(row.student_id), String(row.proposed_staff_id), range);
      next.status = 'confirmed'; next.confirmed_start_at = row.proposed_start_at; next.confirmed_end_at = row.proposed_end_at;
      next.confirmed_staff_id = row.proposed_staff_id; next.notification_needed = 1;
      next.notification_event = 'confirmed'; next.notification_event_revision = revision + 1;
      event = { action, from: row.status, to: next.status, actorId: actorId(auth), notificationNeeded: true };
    } else if (action === 'complete') {
      if (row.status !== 'confirmed') problem('확정된 보강만 완료할 수 있습니다', 409, 'INVALID_TRANSITION');
      const confirmedEnd = Date.parse(String(row.confirmed_end_at || ''));
      if (!Number.isFinite(confirmedEnd) || requestNow < confirmedEnd - COMPLETE_EARLY_MS) {
        problem('보강 종료 5분 전부터 완료할 수 있습니다', 409, 'MAKEUP_NOT_ENDED');
      }
      const confirmedDate = String(row.confirmed_start_at || '').slice(0, 10);
      student = rosterStudent(document, String(row.student_id), cleanDate(confirmedDate, '확정 보강 날짜'));
      if (!await activeStaff(env, app, String(row.confirmed_staff_id || ''))) {
        problem('확정된 보강 담당 선생님이 비활성 상태입니다', 409, 'STAFF_INACTIVE');
      }
      next.status = 'completed'; next.completed_at = requestNow; next.completed_by = actorId(auth);
      event = { action, from: row.status, to: next.status, actorId: actorId(auth), notificationNeeded: false };
    } else {
      if (!['review_pending', 'reviewed', 'awaiting_parent', 'confirmed'].includes(String(row.status))) {
        problem('현재 상태에서는 보강을 취소할 수 없습니다', 409, 'INVALID_TRANSITION');
      }
      const reason = cleanReason(body.reason, true);
      next.status = 'cancelled'; next.cancelled_at = Date.now(); next.cancelled_by = actorId(auth); next.reason = reason;
      const notify = row.status === 'awaiting_parent' || row.status === 'confirmed';
      if (notify) { next.notification_needed = 1; next.notification_event = 'cancelled'; next.notification_event_revision = revision + 1; }
      event = { action, from: row.status, to: next.status, actorId: actorId(auth), reason, notificationNeeded: notify };
    }

    const completion = action === 'complete'
      ? await saveCompletion(env, app, row, next, event, document, json, origin, requestNow)
      : null;
    const saved = completion ? (completion instanceof Response ? completion : completion.saved)
      : await saveTransition(env, app, row, next, event, json, origin, requestNow);
    if (saved instanceof Response) return saved;
    const task = await env.DB.prepare('SELECT data FROM tasks WHERE app=? AND id=? LIMIT 1').bind(app, row.source_task_id).first();
    return json({ ok: true, case: publicCase(saved, student, task && parseJson(task.data), latestResponse),
      ...(completion && completion.impact ? { sessionPackImpact: completion.impact } : {}) }, 200, origin);
  } catch (error) {
    return json({ ok: false, ...(error.code ? { code: error.code } : {}), error: String(error.message || error) },
      Number(error.status) || 400, origin);
  }
}
