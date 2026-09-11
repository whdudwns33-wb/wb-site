import { studentChangeActorKey, studentChangeEventId, studentChangeEventStatement } from './student-change.js';
import { isTaskWriteCasConflict, taskWriteCasGuardStatement } from './task-write-cas.js';
import { lessonHandoffCheckoutGrant } from './lesson-handoff.js';
import {
  flexibleWeekendAllowedOn as flexibleAllowedOn,
  flexibleWeekendConfig as flexibleConfig,
  weekendAttendancePolicyOn,
  weekendFlexInternals
} from './weekend-flex.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_REASON = 200;
const MAX_VISIT_SEQUENCE = 99;
const { WEEKEND_DAYS, MAX_MONTHLY_TARGET } = weekendFlexInternals;

function parseJson(value) {
  try { return JSON.parse(value); } catch (error) { return null; }
}

function kstParts(timestamp) {
  const parts = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(timestamp)).forEach(part => {
    if (part.type !== 'literal') parts[part.type] = part.value;
  });
  return {
    date: parts.year + '-' + parts.month + '-' + parts.day,
    minute: Number(parts.hour) * 60 + Number(parts.minute)
  };
}

function validDate(value) {
  if (!DATE_RE.test(String(value || ''))) return false;
  const [year, month, day] = String(value).split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function isWeekendDate(value) {
  if (!validDate(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return dow === 0 || dow === 6;
}

function dayOfDate(value) {
  if (!validDate(value)) return -1;
  const [year, month, day] = String(value).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function addDateDays(value, amount) {
  if (!validDate(value) || !Number.isInteger(amount)) return '';
  const [year, month, day] = String(value).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return date.toISOString().slice(0, 10);
}

function weekendPairDates(value) {
  const day = dayOfDate(value);
  if (day === 6) return [String(value), addDateDays(value, 1)];
  if (day === 0) return [addDateDays(value, -1), String(value)];
  return [];
}

function monthRange(value) {
  const matched = String(value || '').match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!matched) return null;
  const year = Number(matched[1]), month = Number(matched[2]);
  const next = new Date(Date.UTC(year, month, 1));
  return {
    month: matched[1] + '-' + matched[2],
    start: matched[1] + '-' + matched[2] + '-01',
    end: String(next.getUTCFullYear()).padStart(4, '0') + '-' +
      String(next.getUTCMonth() + 1).padStart(2, '0') + '-01'
  };
}

function configView(task) {
  const flexible = flexibleConfig(task);
  return flexible || { mode: 'fixed', allowedDays: [], monthlyTarget: null, flexibleFrom: '' };
}

function hasWeekendSchedule(task) {
  const slots = Array.isArray(task && task.scheduleSlots) ? task.scheduleSlots : [];
  if (slots.some(slot => Array.isArray(slot && slot.days) && slot.days.map(Number).some(day => day === 0 || day === 6))) return true;
  return Array.isArray(task && task.days) && task.days.map(Number).some(day => day === 0 || day === 6);
}

function isLesson(task) {
  return !!(task && !task.deleted && String(task.lessonInstanceType || '') !== 'makeup' &&
    !String(task.makeupCaseId || '').trim() &&
    (task.taskKind === 'lesson_instruction' || task.lessonFormVersion || task.intakeVersion));
}

function activeOn(task, date) {
  return (!task.start || String(task.start) <= date) && (!task.end || String(task.end) >= date);
}

function plannedOccursOn(task, date) {
  if (!task || task.deleted || !validDate(date) || !activeOn(task, date)) return false;
  const day = dayOfDate(date);
  if (task.repeat === 'once') return String(task.start || '') === date;
  if (task.repeat === 'daily') return true;
  if (task.repeat === 'weekday') return day >= 1 && day <= 5;
  return task.repeat === 'days' && Array.isArray(task.days) && task.days.map(Number).includes(day);
}

/** Structured slots are authoritative. Legacy lessons fall back to recurrence. */
function plannedWeekendOccurrence(task, date) {
  if (!task || task.deleted || task.scheduleStatus === 'needs_review' ||
      !isWeekendDate(date) || !activeOn(task, date)) return false;
  const slots = Array.isArray(task.scheduleSlots) ? task.scheduleSlots : [];
  if (slots.length) {
    return slots.some(slot => {
      const from = String(slot && (slot.validFrom || slot.startDate) || '');
      const to = String(slot && (slot.validTo || slot.endDate) || '');
      const days = Array.isArray(slot && slot.days) ? slot.days.map(Number) : [];
      return (!from || from <= date) && (!to || to >= date) && days.includes(dayOfDate(date));
    });
  }
  return plannedOccursOn(task, date);
}

/**
 * New clients state the original card date. Legacy clients are accepted only
 * when the task schedule deterministically identifies the actual day first,
 * or the single opposite day in the same Saturday/Sunday pair.
 */
function resolveVisitSourceDate(task, visitDate, body) {
  const pair = weekendPairDates(visitDate);
  if (pair.length !== 2) return '';
  if (Object.prototype.hasOwnProperty.call(body || {}, 'sourceDate')) {
    const requested = String(body.sourceDate || '');
    return pair.includes(requested) && plannedWeekendOccurrence(task, requested) ? requested : '';
  }
  if (plannedWeekendOccurrence(task, visitDate)) return visitDate;
  const opposite = pair.find(date => date !== visitDate);
  return opposite && plannedWeekendOccurrence(task, opposite) ? opposite : '';
}

function rowView(row) {
  if (!row) return null;
  return {
    visitId: String(row.visit_id), studentId: String(row.student_id), lessonTaskId: String(row.lesson_task_id),
    staffId: String(row.staff_id), visitDate: String(row.visit_date),
    sourceDate: row.source_date == null ? null : String(row.source_date),
    visitSequence: Math.max(1, Number(row.visit_sequence) || 1), checkInAt: Number(row.check_in_at),
    checkOutAt: row.check_out_at == null ? null : Number(row.check_out_at), status: String(row.status),
    revision: Number(row.revision), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at)
  };
}

function randomId(prefix) {
  return prefix + crypto.randomUUID().replace(/-/g, '');
}

function hasDatabaseConstraint(error, code) {
  return String(error && error.message || error || '').includes(String(code || ''));
}

function actorId(auth) {
  const value = auth && auth.id ? String(auth.id) : '__admin__';
  return SAFE_ID.test(value) ? value : '__admin__';
}

async function findVisit(env, app, visitId) {
  return await env.DB.prepare('SELECT * FROM weekend_actual_visits WHERE app=? AND visit_id=? LIMIT 1')
    .bind(app, visitId).first();
}

async function currentVisitLesson(env, app, row) {
  if (!row || !SAFE_ID.test(String(row.lesson_task_id || '')) || !SAFE_ID.test(String(row.student_id || ''))) return null;
  const taskRow = await env.DB.prepare('SELECT owner,data FROM tasks WHERE app=? AND id=? LIMIT 1')
    .bind(app, String(row.lesson_task_id)).first();
  const task = taskRow && parseJson(taskRow.data);
  const owner = String(taskRow && taskRow.owner || '');
  if (!task || !isLesson(task) || !SAFE_ID.test(owner) ||
      String(task.id || '') !== String(row.lesson_task_id) || String(task.staffId || '') !== owner ||
      String(task.studentId || '') !== String(row.student_id)) return null;
  return { task, owner, taskData: String(taskRow.data || '') };
}

async function verifiedLesson(env, app, taskId, studentId, visitDate, auth) {
  if (!SAFE_ID.test(taskId) || !SAFE_ID.test(studentId)) return { error: '학생과 수업 식별 정보를 확인해 주세요' };
  const taskRow = await env.DB.prepare('SELECT owner,data FROM tasks WHERE app=? AND id=? LIMIT 1')
    .bind(app, taskId).first();
  const task = taskRow && parseJson(taskRow.data);
  const weekendPolicy = weekendAttendancePolicyOn(task, visitDate);
  if (!task || !isLesson(task) || !activeOn(task, visitDate) || weekendPolicy === 'invalid' ||
      (weekendPolicy === 'flexible' ? !flexibleAllowedOn(task, visitDate) : !hasWeekendSchedule(task))) {
    return { error: '현재 등록된 토·일 수업을 확인할 수 없습니다' };
  }
  if (String(task.studentId || '') !== studentId || String(task.staffId || '') !== String(taskRow.owner || '')) {
    return { error: '수업과 학생·담당자 연결이 일치하지 않습니다' };
  }
  if (auth.scope === 'own' && String(task.staffId || '') !== String(auth.id || '')) {
    return { error: '본인이 담당하는 수업만 기록할 수 있습니다' };
  }
  const rosterRow = await env.DB.prepare('SELECT data FROM private_rosters WHERE app=? LIMIT 1').bind(app).first();
  const document = rosterRow && parseJson(rosterRow.data);
  const students = document && document.roster && Array.isArray(document.roster.students)
    ? document.roster.students : [];
  if (!students.some(student => student && !student.deleted && String(student.id || '') === studentId)) {
    return { error: '현재 원생 명단에서 학생을 확인할 수 없습니다' };
  }
  return { task, staffId: String(task.staffId), taskData: String(taskRow.data || '') };
}

async function latestAfterWrite(env, app, visitId) {
  return rowView(await findVisit(env, app, visitId));
}

async function appendUpdate(env, app, current, values, eventType, reason, auth, lessonGuard) {
  const expectedRevision = Number(values.expectedRevision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision !== Number(current.revision)) {
    return { stale: true };
  }
  const now = Date.now();
  const updatedAt = Math.max(now, Number(current.updated_at) + 1);
  const revision = expectedRevision + 1;
  const actor = actorId(auth);
  const eventId = randomId('wve_');
  const eventData = JSON.stringify({
    version: 1,
    before: { checkInAt: Number(current.check_in_at), checkOutAt: current.check_out_at == null ? null : Number(current.check_out_at), status: current.status },
    after: { checkInAt: Number(values.checkInAt), checkOutAt: values.checkOutAt == null ? null : Number(values.checkOutAt), status: values.status },
    reason: String(reason || '')
  });
  const handoffGrant = lessonGuard && lessonGuard.handoff;
  const updateSql =
    'UPDATE weekend_actual_visits SET check_in_at=?,check_out_at=?,status=?,revision=?,updated_at=?,updated_by=? ' +
    'WHERE app=? AND visit_id=? AND revision=?' + (lessonGuard
      ? ' AND EXISTS (SELECT 1 FROM tasks current_task WHERE current_task.app=? AND current_task.id=? ' +
        'AND current_task.owner=? AND current_task.data=?)'
      : '') + (handoffGrant
      ? ' AND EXISTS (SELECT 1 FROM lesson_handoffs handoff WHERE handoff.app=? AND handoff.handoff_id=? ' +
        'AND handoff.revision=? AND handoff.status IN (\'accepted\',\'completed\') ' +
        'AND handoff.recipient_staff_id=? AND handoff.source_staff_id=? ' +
        'AND handoff.lesson_task_id=? AND handoff.student_id=? AND handoff.record_date=? AND handoff.source_date=? AND handoff.visit_id=? ' +
        'AND handoff.data_generation=COALESCE((SELECT generation FROM app_data_generations WHERE app=handoff.app),0) ' +
        'AND EXISTS (SELECT 1 FROM staff recipient WHERE recipient.app=handoff.app AND recipient.id=handoff.recipient_staff_id ' +
          'AND json_valid(recipient.data) AND COALESCE(json_extract(recipient.data,\'$.deleted\'),0)=0))'
      : '');
  const updateArgs = [values.checkInAt, values.checkOutAt, values.status, revision, updatedAt, actor,
    app, current.visit_id, expectedRevision];
  if (lessonGuard) updateArgs.push(app, String(current.lesson_task_id), lessonGuard.owner, lessonGuard.taskData);
  if (handoffGrant) updateArgs.push(app, handoffGrant.handoffId, handoffGrant.revision, String(auth.id || ''),
    lessonGuard.owner, String(current.lesson_task_id), String(current.student_id), String(current.visit_date),
    handoffGrant.sourceDate, String(current.visit_id));
  const statements = [env.DB.prepare(updateSql).bind(...updateArgs)];
  if (handoffGrant) {
    // The handoff may be revoked while a tablet is saving. Fail the entire batch,
    // including its audit event, unless this exact grant still authorizes checkout.
    statements.push(await taskWriteCasGuardStatement(env, app, 'lesson_handoff_checkout',
      [current.visit_id, expectedRevision, handoffGrant.handoffId, handoffGrant.revision, updatedAt].join('\n'), updatedAt));
  }
  statements.push(
    env.DB.prepare(
      'INSERT INTO weekend_actual_visit_events (app,event_id,visit_id,event_type,event_data,actor_id,created_at) ' +
      'SELECT ?,?,?,?,?,?,? WHERE EXISTS (' +
      'SELECT 1 FROM weekend_actual_visits WHERE app=? AND visit_id=? AND revision=? AND updated_at=?)'
    ).bind(app, eventId, current.visit_id, eventType, eventData, actor, updatedAt,
      app, current.visit_id, revision, updatedAt)
  );
  const results = await env.DB.batch(statements);
  if (Number(results && results[0] && results[0].meta && results[0].meta.changes || 0) !== 1) return { stale: true };
  return { visit: await latestAfterWrite(env, app, current.visit_id) };
}

async function listVisits(env, app, body, auth, json, origin) {
  const visitDate = String(body.visitDate || '');
  if (!isWeekendDate(visitDate)) return json({ ok: false, error: '토요일 또는 일요일 날짜를 선택해 주세요' }, 422, origin);
  let staffId = auth.scope === 'own' ? String(auth.id || '') : String(body.staffId || '');
  if (staffId && !SAFE_ID.test(staffId)) return json({ ok: false, error: '담당자 정보를 확인해 주세요' }, 422, origin);
  const result = await env.DB.prepare(
    "SELECT * FROM weekend_actual_visits WHERE app=? AND visit_date=? AND status<>'cancelled' " +
    'ORDER BY check_in_at,staff_id,student_id,visit_sequence'
  ).bind(app, visitDate).all();
  let rows = result.results || [];
  if (staffId) {
    const scoped = [];
    for (const row of rows) {
      const lesson = await currentVisitLesson(env, app, row);
      if (lesson && lesson.owner === staffId) scoped.push(row);
    }
    rows = scoped;
  }
  const allDayResult = await env.DB.prepare(
    'SELECT * FROM weekend_actual_visits WHERE app=? AND visit_date=? ' +
    'ORDER BY student_id,lesson_task_id,visit_sequence'
  ).bind(app, visitDate).all();
  let allDayRows = allDayResult.results || [];
  if (staffId) {
    const scoped = [];
    for (const row of allDayRows) {
      const lesson = await currentVisitLesson(env, app, row);
      if (lesson && lesson.owner === staffId) scoped.push(row);
    }
    allDayRows = scoped;
  }
  const nextByLesson = new Map();
  for (const row of allDayRows) {
    const key = String(row.student_id) + '\n' + String(row.lesson_task_id) + '\n' + String(row.visit_date);
    const sequence = Math.max(1, Number(row.visit_sequence) || 1);
    const current = nextByLesson.get(key);
    if (!current || sequence > current.sequence) nextByLesson.set(key, { row, sequence });
  }
  const nextVisitSequences = [...nextByLesson.values()].map(item => ({
    lessonTaskId: String(item.row.lesson_task_id), studentId: String(item.row.student_id),
    visitDate: String(item.row.visit_date),
    next: item.sequence + 1
  }));

  const range = monthRange(visitDate);
  const monthlyResult = await env.DB.prepare(
    "SELECT student_id,lesson_task_id,COUNT(DISTINCT visit_date) AS visit_count FROM weekend_actual_visits " +
    "WHERE app=? AND visit_date>=? AND visit_date<? AND status<>'cancelled' " +
    'GROUP BY student_id,lesson_task_id ORDER BY lesson_task_id,student_id'
  ).bind(app, range.start, range.end).all();
  const monthlyCounts = [];
  for (const monthly of monthlyResult.results || []) {
    if (staffId) {
      const lesson = await currentVisitLesson(env, app, monthly);
      if (!lesson || lesson.owner !== staffId) continue;
    }
    monthlyCounts.push({
      lessonTaskId: String(monthly.lesson_task_id), studentId: String(monthly.student_id),
      month: range.month, count: Number(monthly.visit_count) || 0
    });
  }
  return json({ ok: true, visits: rows.map(rowView), nextVisitSequences, monthlyCounts }, 200, origin);
}

function requestedConfig(body) {
  const mode = String(body.weekendAttendanceMode || '');
  if (mode === 'fixed') {
    if ((Array.isArray(body.weekendAllowedDays) && body.weekendAllowedDays.length) ||
        (body.weekendAllowedDays != null && !Array.isArray(body.weekendAllowedDays)) ||
        (body.weekendMonthlyTarget != null && body.weekendMonthlyTarget !== '') ||
        (body.weekendFlexibleFrom != null && body.weekendFlexibleFrom !== '')) return null;
    return { mode: 'fixed', allowedDays: [], monthlyTarget: null, flexibleFrom: '' };
  }
  if (mode !== 'flexible') return null;
  const days = Array.isArray(body.weekendAllowedDays)
    ? [...new Set(body.weekendAllowedDays)].sort((left, right) => left - right) : [];
  const target = body.weekendMonthlyTarget == null || body.weekendMonthlyTarget === ''
    ? null : body.weekendMonthlyTarget;
  const flexibleFrom = String(body.weekendFlexibleFrom || '');
  if (!days.length || days.some(day => !Number.isInteger(day) || !WEEKEND_DAYS.has(day)) ||
      (target != null && (!Number.isInteger(target) || target < 1 || target > MAX_MONTHLY_TARGET)) ||
      !validDate(flexibleFrom)) return null;
  return { mode, allowedDays: days, monthlyTarget: target, flexibleFrom };
}

function sameConfig(left, right) {
  return left.mode === right.mode && left.flexibleFrom === right.flexibleFrom &&
    left.monthlyTarget === right.monthlyTarget &&
    JSON.stringify(left.allowedDays) === JSON.stringify(right.allowedDays);
}

function taskWithConfig(task, config, updatedAt, editorRole) {
  const next = {
    ...task,
    weekendAttendanceMode: config.mode,
    weekendAllowedDays: config.allowedDays.slice(),
    weekendMonthlyTarget: config.monthlyTarget,
    weekendFlexibleFrom: config.flexibleFrom,
    updatedAt,
    previousUpdatedAt: Number(task.updatedAt) || null,
    lessonRevision: Math.max(1, Number(task.lessonRevision) || 1) + 1,
    updatedByScope: 'weekend_config',
    lastEditBy: editorRole
  };
  return next;
}

async function configureLesson(env, app, body, auth, json, origin) {
  if (!auth || auth.scope !== 'all') {
    return json({ ok: false, error: '비정기 주말 수업 설정은 관리자만 변경할 수 있습니다' }, 403, origin);
  }
  const taskId = String(body.taskId || '');
  const studentId = String(body.studentId || '');
  const expectedUpdatedAt = body.expectedUpdatedAt;
  const requested = requestedConfig(body);
  const allowedKeys = new Set([
    'app', 'auth', 'action', 'taskId', 'studentId', 'expectedUpdatedAt',
    'weekendAttendanceMode', 'weekendAllowedDays', 'weekendMonthlyTarget', 'weekendFlexibleFrom'
  ]);
  if (!SAFE_ID.test(taskId) || !SAFE_ID.test(studentId) ||
      Object.keys(body).some(key => !allowedKeys.has(key)) ||
      !Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt <= 0 || !requested) {
    return json({ ok: false, error: '수업·학생·비정기 등원 설정과 수정 기준 시각을 확인해 주세요' }, 422, origin);
  }
  const row = await env.DB.prepare('SELECT owner,data,updated_at FROM tasks WHERE app=? AND id=? LIMIT 1')
    .bind(app, taskId).first();
  const task = row && parseJson(row.data);
  const owner = String(row && row.owner || '');
  if (!row || !task || !isLesson(task) || String(task.id || '') !== taskId ||
      String(task.studentId || '') !== studentId || String(task.staffId || '') !== owner || !SAFE_ID.test(owner)) {
    return json({ ok: false, error: '현재 학생과 수업의 stable ID 연결을 확인할 수 없습니다' }, 409, origin);
  }
  if (requested.mode === 'flexible' && !hasWeekendSchedule(task)) {
    return json({ ok: false, error: '토요일 또는 일요일 확정 시간표가 있는 수업만 비정기 등원으로 설정할 수 있습니다' }, 422, origin);
  }
  if (requested.mode === 'flexible' &&
      ((task.start && requested.flexibleFrom < String(task.start)) ||
       (task.end && requested.flexibleFrom > String(task.end)))) {
    return json({ ok: false, error: '비정기 적용일은 현재 수업의 적용 기간 안에서 선택해 주세요' }, 422, origin);
  }
  const rowUpdatedAt = Number(row.updated_at);
  if (rowUpdatedAt !== expectedUpdatedAt || Number(task.updatedAt) !== expectedUpdatedAt) {
    return json({ ok: false, code: 'WEEKEND_CONFIG_STALE', error: '수업 설정이 다른 곳에서 먼저 변경되었습니다',
      task, updatedAt: rowUpdatedAt, config: configView(task) }, 409, origin);
  }
  const before = configView(task);
  if (sameConfig(before, requested)) {
    return json({ ok: true, idempotent: true, task, updatedAt: rowUpdatedAt, config: before }, 200, origin);
  }

  const rosterRow = await env.DB.prepare('SELECT data FROM private_rosters WHERE app=? LIMIT 1').bind(app).first();
  const document = rosterRow && parseJson(rosterRow.data);
  const students = document && document.roster && Array.isArray(document.roster.students)
    ? document.roster.students : [];
  if (!students.some(student => student && !student.deleted && String(student.id || '') === studentId)) {
    return json({ ok: false, error: '현재 원생 명단에서 학생을 확인할 수 없습니다' }, 409, origin);
  }

  const changedBy = studentChangeActorKey(auth);
  const updatedAt = Math.max(Date.now(), rowUpdatedAt + 1);
  const next = taskWithConfig(task, requested, updatedAt, auth.role === 'manager' ? 'manager' : 'admin');
  const changedFields = ['weekendAttendanceMode', 'weekendAllowedDays', 'weekendMonthlyTarget', 'weekendFlexibleFrom'];
  const eventId = await studentChangeEventId('weekend-config\n' + taskId + '\n' + next.lessonRevision);
  try {
    const update = env.DB.prepare(
      'UPDATE tasks SET data=?,updated_at=?,srv_at=? WHERE app=? AND id=? AND owner=? AND updated_at=? AND data=?'
    ).bind(JSON.stringify(next), updatedAt, updatedAt, app, taskId, owner, rowUpdatedAt, String(row.data));
    const guard = await taskWriteCasGuardStatement(env, app, 'weekend_flexible_config',
      [taskId, studentId, rowUpdatedAt, updatedAt].join('\n'), updatedAt);
    const event = studentChangeEventStatement(env, app, {
      eventId, studentId, taskId, eventType: 'work_instruction', changedFields,
      details: { before, after: requested }, audienceStaffIds: [owner],
      effectiveDate: requested.mode === 'flexible' ? requested.flexibleFrom : null,
      requiresAck: true, changedAt: updatedAt, changedBy
    });
    const results = await env.DB.batch([update, guard, event]);
    if (!Array.isArray(results) || Number(results[0] && results[0].meta && results[0].meta.changes || 0) !== 1) {
      return json({ ok: false, code: 'WEEKEND_CONFIG_STALE', error: '수업 설정이 다른 곳에서 먼저 변경되었습니다' }, 409, origin);
    }
  } catch (error) {
    if (isTaskWriteCasConflict(error)) {
      return json({ ok: false, code: 'WEEKEND_CONFIG_STALE', error: '수업 설정이 다른 곳에서 먼저 변경되었습니다' }, 409, origin);
    }
    throw error;
  }
  return json({ ok: true, idempotent: false, task: next, updatedAt, config: requested }, 200, origin);
}

async function checkIn(env, app, body, auth, json, origin) {
  const now = Date.now();
  const visitDate = String(body.visitDate || '');
  const taskId = String(body.lessonTaskId || '');
  const studentId = String(body.studentId || '');
  const visitSequence = Object.prototype.hasOwnProperty.call(body || {}, 'visitSequence')
    ? Number(body.visitSequence) : 1;
  if (!Number.isSafeInteger(visitSequence) || visitSequence < 1 || visitSequence > MAX_VISIT_SEQUENCE) {
    return json({ ok: false, error: '실제 등원 방문 순서를 확인해 주세요' }, 422, origin);
  }
  if (!isWeekendDate(visitDate) || kstParts(now).date !== visitDate) {
    return json({ ok: false, error: '실제 등원은 오늘 토·일 기록에서만 저장할 수 있습니다' }, 422, origin);
  }
  const verified = await verifiedLesson(env, app, taskId, studentId, visitDate, auth);
  if (verified.error) return json({ ok: false, error: verified.error }, 422, origin);
  const sourceDate = resolveVisitSourceDate(verified.task, visitDate, body);
  if (!sourceDate) {
    return json({ ok: false, code: 'SOURCE_DATE_INVALID',
      error: '원래 수업 날짜와 확정 주말 시간표 연결을 확인해 주세요' }, 422, origin);
  }

  const linkedResult = await env.DB.prepare(
    "SELECT * FROM weekend_actual_visits WHERE app=? AND student_id=? AND lesson_task_id=? " +
    "AND visit_date<>? AND status<>'cancelled' ORDER BY visit_date,visit_sequence"
  ).bind(app, studentId, taskId, visitDate).all();
  const linkedElsewhere = (linkedResult.results || []).find(row =>
    (row.source_date != null && String(row.source_date) === sourceDate) ||
    (row.source_date == null && resolveVisitSourceDate(verified.task, String(row.visit_date || ''), {}) === sourceDate));
  if (linkedElsewhere) {
    return json({ ok: false, code: 'SOURCE_DATE_ALREADY_LINKED',
      error: '이 원 수업은 이미 다른 실제 등원일에 연결되어 있습니다' }, 409, origin);
  }

  const seriesResult = await env.DB.prepare(
    'SELECT * FROM weekend_actual_visits WHERE app=? AND student_id=? AND lesson_task_id=? AND visit_date=? ' +
    'ORDER BY visit_sequence'
  ).bind(app, studentId, taskId, visitDate).all();
  const series = seriesResult.results || [];
  const existing = series.find(row => Math.max(1, Number(row.visit_sequence) || 1) === visitSequence) || null;
  if (series.some(row => row.source_date != null && String(row.source_date) !== sourceDate)) {
    return json({ ok: false, code: 'SOURCE_DATE_MISMATCH',
      error: '이미 저장된 실제 등원 기록의 원래 수업 날짜와 일치하지 않습니다' }, 409, origin);
  }
  if (existing && existing.status === 'active') return json({ ok: true, idempotent: true, visit: rowView(existing) }, 200, origin);
  if (existing && existing.status === 'completed') {
    return json({ ok: false, code: 'VISIT_ALREADY_COMPLETED', error: '이미 하원까지 완료된 기록입니다' }, 409, origin);
  }
  const maxSequence = series.reduce((max, row) => Math.max(max, Math.max(1, Number(row.visit_sequence) || 1)), 0);
  const expectedSequence = existing && existing.status === 'cancelled' && visitSequence === maxSequence
    ? maxSequence : maxSequence + 1;
  if (visitSequence !== expectedSequence) {
    return json({ ok: false, code: 'VISIT_SEQUENCE_MISMATCH',
      error: '최근 등·하원 기록을 새로고침한 뒤 다시 시도해 주세요', nextVisitSequence: expectedSequence }, 409, origin);
  }
  const anotherOpen = await env.DB.prepare(
    "SELECT * FROM weekend_actual_visits WHERE app=? AND student_id=? AND status='active' LIMIT 1"
  ).bind(app, studentId).first();
  if (anotherOpen) {
    return json({ ok: false, code: 'VISIT_ALREADY_OPEN', error: '이 학생의 하원 전 기록이 이미 있습니다', current: rowView(anotherOpen) }, 409, origin);
  }

  if (existing && existing.status === 'cancelled') {
    let reopened;
    try {
      reopened = await appendUpdate(env, app, existing, {
        checkInAt: now, checkOutAt: null, status: 'active', expectedRevision: Number(existing.revision)
      }, 'reopen', '취소 후 다시 등원', auth,
      auth.scope === 'own' ? { owner: verified.staffId, taskData: verified.taskData } : null);
    } catch (error) {
      if (hasDatabaseConstraint(error, 'WEEKEND_SOURCE_DATE_ALREADY_LINKED')) {
        return json({ ok: false, code: 'SOURCE_DATE_ALREADY_LINKED',
          error: '이 원 수업은 이미 다른 실제 등원일에 연결되어 있습니다' }, 409, origin);
      }
      if (hasDatabaseConstraint(error, 'WEEKEND_VISIT_TIME_OVERLAP')) {
        return json({ ok: false, code: 'VISIT_TIME_OVERLAP',
          error: '다른 실제 방문 시간과 겹쳐 등원할 수 없습니다' }, 409, origin);
      }
      throw error;
    }
    if (reopened.stale) return json({ ok: false, code: 'VISIT_STALE', error: '다른 기기에서 기록이 먼저 변경되었습니다' }, 409, origin);
    return json({ ok: true, visit: reopened.visit }, 200, origin);
  }

  const visitId = randomId('wv_');
  const eventId = randomId('wve_');
  const actor = actorId(auth);
  const eventData = JSON.stringify({ version: 1, before: null,
    after: { visitDate, sourceDate, visitSequence, checkInAt: now, checkOutAt: null, status: 'active' }, reason: '' });
  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare(
      'INSERT OR IGNORE INTO weekend_actual_visits ' +
      '(app,visit_id,student_id,lesson_task_id,staff_id,visit_date,source_date,visit_sequence,check_in_at,check_out_at,status,revision,created_at,updated_at,created_by,updated_by) ' +
      'SELECT ?,?,?,?,?,?,?,?,?,NULL,\'active\',1,?,?,?,? FROM tasks current_task ' +
      'WHERE current_task.app=? AND current_task.id=? AND current_task.owner=? AND current_task.data=?'
    ).bind(app, visitId, studentId, taskId, verified.staffId, visitDate, sourceDate, visitSequence, now, now, now, actor, actor,
      app, taskId, verified.staffId, verified.taskData),
      env.DB.prepare(
      'INSERT INTO weekend_actual_visit_events (app,event_id,visit_id,event_type,event_data,actor_id,created_at) ' +
      'SELECT ?,?,?,\'check_in\',?,?,? WHERE EXISTS (' +
      'SELECT 1 FROM weekend_actual_visits WHERE app=? AND visit_id=? AND revision=1 AND updated_at=?)'
      ).bind(app, eventId, visitId, eventData, actor, now, app, visitId, now)
    ]);
  } catch (error) {
    if (hasDatabaseConstraint(error, 'WEEKEND_SOURCE_DATE_ALREADY_LINKED')) {
      return json({ ok: false, code: 'SOURCE_DATE_ALREADY_LINKED',
        error: '이 원 수업은 이미 다른 실제 등원일에 연결되어 있습니다' }, 409, origin);
    }
    if (hasDatabaseConstraint(error, 'WEEKEND_VISIT_TIME_OVERLAP')) {
      const concurrent = await env.DB.prepare(
        'SELECT * FROM weekend_actual_visits WHERE app=? AND student_id=? AND lesson_task_id=? AND visit_date=? AND visit_sequence=? LIMIT 1'
      ).bind(app, studentId, taskId, visitDate, visitSequence).first();
      if (concurrent && concurrent.status === 'active' &&
          (concurrent.source_date == null || String(concurrent.source_date) === sourceDate)) {
        return json({ ok: true, idempotent: true, visit: rowView(concurrent) }, 200, origin);
      }
      return json({ ok: false, code: 'VISIT_TIME_OVERLAP',
        error: '다른 실제 방문 시간과 겹쳐 등원할 수 없습니다' }, 409, origin);
    }
    throw error;
  }
  if (Number(results && results[0] && results[0].meta && results[0].meta.changes || 0) !== 1) {
    const concurrent = await env.DB.prepare(
      'SELECT * FROM weekend_actual_visits WHERE app=? AND student_id=? AND lesson_task_id=? AND visit_date=? AND visit_sequence=? LIMIT 1'
    ).bind(app, studentId, taskId, visitDate, visitSequence).first();
    if (concurrent && concurrent.status === 'active' &&
        (concurrent.source_date == null || String(concurrent.source_date) === sourceDate)) {
      return json({ ok: true, idempotent: true, visit: rowView(concurrent) }, 200, origin);
    }
    const concurrentOpen = await env.DB.prepare(
      "SELECT * FROM weekend_actual_visits WHERE app=? AND student_id=? AND status='active' LIMIT 1"
    ).bind(app, studentId).first();
    if (concurrentOpen) {
      return json({ ok: false, code: 'VISIT_ALREADY_OPEN', error: '이 학생의 하원 전 기록이 이미 있습니다',
        current: rowView(concurrentOpen) }, 409, origin);
    }
    return json({ ok: false, code: 'VISIT_CONFLICT', error: '다른 기기에서 같은 등원 기록을 먼저 저장했습니다' }, 409, origin);
  }
  return json({ ok: true, visit: await latestAfterWrite(env, app, visitId) }, 200, origin);
}

async function changeVisit(env, app, body, auth, json, origin) {
  const action = String(body.action || '');
  const visitId = String(body.visitId || '');
  if (!SAFE_ID.test(visitId)) return json({ ok: false, error: '등·하원 기록을 확인해 주세요' }, 422, origin);
  const current = await findVisit(env, app, visitId);
  if (!current || current.status === 'cancelled') return json({ ok: false, error: '현재 등·하원 기록을 찾을 수 없습니다' }, 404, origin);
  let currentLesson = auth.scope === 'own' ? await currentVisitLesson(env, app, current) : null;
  if (auth.scope === 'own' && (!currentLesson || currentLesson.owner !== String(auth.id || ''))) {
    const handoff = action === 'check_out' && currentLesson
      ? await lessonHandoffCheckoutGrant(env, app, auth, current) : null;
    if (!handoff) {
      return json({ ok: false, error: '현재 본인이 담당하거나 당일 인계받은 수업만 하원 처리할 수 있습니다' }, 422, origin);
    }
    currentLesson = { ...currentLesson, handoff };
  }
  const expectedRevision = Number(body.revision);

  if (action === 'check_out') {
    const now = Date.now();
    if (current.status === 'completed') return json({ ok: true, idempotent: true, visit: rowView(current) }, 200, origin);
    if (kstParts(now).date !== current.visit_date) {
      return json({ ok: false, error: '지난 날짜의 미하원 기록은 시간 수정 또는 취소로 정리해 주세요' }, 422, origin);
    }
    let saved;
    try {
      saved = await appendUpdate(env, app, current, {
        checkInAt: Number(current.check_in_at), checkOutAt: now, status: 'completed', expectedRevision
      }, 'check_out', '', auth, currentLesson);
    } catch (error) {
      if (isTaskWriteCasConflict(error)) {
        return json({ ok: false, code: 'VISIT_STALE',
          error: '수업 인계 또는 등·하원 정보가 변경되었습니다. 새로 확인해 주세요' }, 409, origin);
      }
      if (hasDatabaseConstraint(error, 'WEEKEND_VISIT_TIME_OVERLAP')) {
        return json({ ok: false, code: 'VISIT_TIME_OVERLAP',
          error: '다른 실제 방문 시간과 겹쳐 하원 시간을 저장할 수 없습니다' }, 409, origin);
      }
      throw error;
    }
    if (saved.stale) return json({ ok: false, code: 'VISIT_STALE', error: '다른 기기에서 기록이 먼저 변경되었습니다' }, 409, origin);
    return json({ ok: true, visit: saved.visit }, 200, origin);
  }

  const reason = String(body.reason || '').replace(/\s+/g, ' ').trim();
  if (!reason || reason.length > MAX_REASON || /[\u0000-\u001f\u007f]/.test(reason)) {
    return json({ ok: false, error: '수정·취소 사유를 200자 이내로 입력해 주세요' }, 422, origin);
  }
  const nowParts = kstParts(Date.now());
  if (auth.scope === 'own' && (nowParts.date !== current.visit_date || nowParts.minute >= 23 * 60 + 50)) {
    return json({ ok: false, error: '선생님은 당일 23:50 전까지만 시간을 수정하거나 취소할 수 있습니다' }, 422, origin);
  }

  if (action === 'cancel') {
    const saved = await appendUpdate(env, app, current, {
      checkInAt: Number(current.check_in_at), checkOutAt: current.check_out_at == null ? null : Number(current.check_out_at),
      status: 'cancelled', expectedRevision
    }, 'cancel', reason, auth, currentLesson);
    if (saved.stale) return json({ ok: false, code: 'VISIT_STALE', error: '다른 기기에서 기록이 먼저 변경되었습니다' }, 409, origin);
    return json({ ok: true, visit: saved.visit }, 200, origin);
  }

  if (action !== 'correct') return json({ ok: false, error: '지원하지 않는 등·하원 작업입니다' }, 400, origin);
  const checkInAt = Number(body.checkInAt);
  const checkOutAt = body.checkOutAt == null || body.checkOutAt === '' ? null : Number(body.checkOutAt);
  if (!Number.isSafeInteger(checkInAt) || checkInAt <= 0 || kstParts(checkInAt).date !== current.visit_date ||
      (checkOutAt != null && (!Number.isSafeInteger(checkOutAt) || checkOutAt < checkInAt || kstParts(checkOutAt).date !== current.visit_date))) {
    return json({ ok: false, error: '등원·하원 시간을 같은 날짜 안에서 올바르게 입력해 주세요' }, 422, origin);
  }
  const siblingResult = await env.DB.prepare(
    "SELECT * FROM weekend_actual_visits WHERE app=? AND student_id=? AND lesson_task_id=? AND visit_date=? " +
    "AND visit_id<>? AND status<>'cancelled' ORDER BY check_in_at,visit_sequence"
  ).bind(app, String(current.student_id), String(current.lesson_task_id), String(current.visit_date), visitId).all();
  const siblings = siblingResult.results || [];
  const requestedEnd = checkOutAt == null ? Number.MAX_SAFE_INTEGER : checkOutAt;
  const overlaps = siblings.some(row => {
    const siblingEnd = row.check_out_at == null ? Number.MAX_SAFE_INTEGER : Number(row.check_out_at);
    return !(requestedEnd <= Number(row.check_in_at) || siblingEnd <= checkInAt);
  });
  const currentSequence = Math.max(1, Number(current.visit_sequence) || 1);
  const sequenceConflict = siblings.some(row => {
    const sequence = Math.max(1, Number(row.visit_sequence) || 1);
    if (sequence < currentSequence) return row.check_out_at == null || Number(row.check_out_at) > checkInAt;
    if (sequence > currentSequence) return checkOutAt == null || checkOutAt > Number(row.check_in_at);
    return false;
  });
  if (overlaps || sequenceConflict) {
    return json({ ok: false, code: 'VISIT_TIME_OVERLAP',
      error: '방문 순서와 겹치지 않도록 실제 등·하원 시간을 확인해 주세요' }, 409, origin);
  }
  let saved;
  try {
    saved = await appendUpdate(env, app, current, {
      checkInAt, checkOutAt, status: checkOutAt == null ? 'active' : 'completed', expectedRevision
    }, 'correct', reason, auth, currentLesson);
  } catch (error) {
    if (hasDatabaseConstraint(error, 'WEEKEND_VISIT_TIME_OVERLAP')) {
      return json({ ok: false, code: 'VISIT_TIME_OVERLAP',
        error: '다른 실제 방문 시간이 먼저 변경되어 저장할 수 없습니다' }, 409, origin);
    }
    throw error;
  }
  if (saved.stale) return json({ ok: false, code: 'VISIT_STALE', error: '다른 기기에서 기록이 먼저 변경되었습니다' }, 409, origin);
  return json({ ok: true, visit: saved.visit }, 200, origin);
}

export async function handleWeekendVisit(env, app, body, origin, auth, json) {
  if (app !== 'task') return json({ ok: false, error: '업무 화면에서만 등·하원 기록을 사용할 수 있습니다' }, 400, origin);
  const action = String(body.action || 'list');
  if (action === 'list') return await listVisits(env, app, body, auth, json, origin);
  if (action === 'configure') return await configureLesson(env, app, body, auth, json, origin);
  if (action === 'check_in') return await checkIn(env, app, body, auth, json, origin);
  return await changeVisit(env, app, body, auth, json, origin);
}

export const weekendVisitInternals = {
  isWeekendDate, hasWeekendSchedule, kstParts, flexibleConfig, flexibleAllowedOn, monthRange,
  plannedWeekendOccurrence, weekendPairDates, resolveVisitSourceDate
};
