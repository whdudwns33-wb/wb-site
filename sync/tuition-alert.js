import { weekendAttendancePolicyOn } from './weekend-flex.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const ALERT_ID = /^tga_[a-f0-9]{52}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SESSION_MODE = 'session4';
const ATTENDANCE_THRESHOLD = 3;
const QUALIFYING_ATTENDANCE = new Set(['P', 'L', 'E']);

function reply(json, origin, body, status = 200) {
  return json(body, status, origin);
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function exactKeys(value, allowed) {
  return Object.keys(record(value)).every(key => allowed.includes(key));
}

function validDate(value) {
  const text = String(value || '');
  if (!ISO_DATE.test(text)) return false;
  const [year, month, day] = text.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
}

function kstDateAt(value) {
  return new Date(Number(value) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value || '')));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function alertId(studentId, cycleStartDate) {
  return 'tga_' + (await sha256Hex('tuition-generation-alert-v1\n' + studentId + '\n' + cycleStartDate)).slice(0, 52);
}

async function confirmationId(exactAlertId) {
  return 'tgc_' + (await sha256Hex('tuition-generation-confirmation-v1\n' + exactAlertId)).slice(0, 52);
}

function actorKey(auth) {
  return auth && auth.role === 'manager' && SAFE_ID.test(String(auth.id || ''))
    ? 'manager:' + String(auth.id) : 'director';
}

function billingStudents(document, sourceDate) {
  const students = document && document.roster && Array.isArray(document.roster.students)
    ? document.roster.students : [];
  const sourceMonth = String(sourceDate || kstDateAt(Date.now())).slice(0, 7);
  const result = new Map();
  for (const student of students) {
    const studentId = String(student && student.id || '');
    const cycleStartDate = String(student && student.sessionCycleStartDate || '');
    if (!SAFE_ID.test(studentId) || student && student.billingMode !== SESSION_MODE || !validDate(cycleStartDate) ||
        String(student && student.start || '') > sourceMonth ||
        (String(student && student.end || '') && String(student.end) <= sourceMonth)) continue;
    if (result.has(studentId)) continue;
    result.set(studentId, {
      studentId,
      cycleStartDate,
      name: String(student && student.name || '').slice(0, 80),
      school: String(student && student.school || '').slice(0, 100),
      grade: String(student && student.grade || '').slice(0, 40)
    });
  }
  return result;
}

function rosterStudentIdentities(document) {
  const students = document && document.roster && Array.isArray(document.roster.students)
    ? document.roster.students : [];
  const result = new Map();
  for (const student of students) {
    const studentId = String(student && student.id || '');
    if (!SAFE_ID.test(studentId) || result.has(studentId)) continue;
    result.set(studentId, {
      studentId,
      name: String(student && student.name || '').slice(0, 80),
      school: String(student && student.school || '').slice(0, 100),
      grade: String(student && student.grade || '').slice(0, 40)
    });
  }
  return result;
}

async function loadRoster(env, sourceDate) {
  const row = await env.DB.prepare("SELECT data FROM private_rosters WHERE app='task' LIMIT 1").first();
  if (!row) return { error: 'ROSTER_NOT_READY' };
  try {
    const document = JSON.parse(row.data || '{}');
    if (!document || !document.roster || !Array.isArray(document.roster.students)) throw new Error('invalid roster');
    return { document, students: billingStudents(document, sourceDate), identities: rosterStudentIdentities(document) };
  } catch (error) {
    return { error: 'ROSTER_INVALID' };
  }
}

function lessonTask(value, taskId, taskOwner) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    String(value.id || '') === taskId && SAFE_ID.test(String(value.studentId || '')) &&
    SAFE_ID.test(String(taskOwner || '')) && String(value.staffId || '') === String(taskOwner) &&
    (value.taskKind === 'lesson_instruction' || value.lessonFormVersion || value.intakeVersion);
}

function occursOn(task, date) {
  if (!task || task.deleted || (task.start && date < String(task.start)) ||
      (task.end && date > String(task.end))) return false;
  const day = new Date(date + 'T00:00:00Z').getUTCDay();
  if (task.repeat === 'once') return date === String(task.start || '');
  if (task.repeat === 'daily') return true;
  if (task.repeat === 'weekday') return day >= 1 && day <= 5;
  return task.repeat === 'days' && Array.isArray(task.days) && task.days.map(Number).includes(day);
}

function qualifyingEvidence(row, students, sourceDate) {
  let task, check;
  try {
    task = JSON.parse(row.task_data || '{}');
    check = JSON.parse(row.check_data || '{}');
  } catch (error) {
    return null;
  }
  const taskId = String(row.task_id || '');
  const date = String(check && check.date || '');
  const studentId = String(task && task.studentId || '');
  const student = students.get(studentId);
  const weekendPolicy = weekendAttendancePolicyOn(task, date);
  const exactActualVisit = validDate(date) && [0, 6].includes(new Date(date + 'T00:00:00Z').getUTCDay()) &&
    !!String(row.actual_visit_id || '');
  const attendanceOccurrence = weekendPolicy === 'flexible'
    ? exactActualVisit
    : weekendPolicy === 'fixed' && (occursOn(task, date) || exactActualVisit);
  if (!SAFE_ID.test(taskId) || String(row.check_owner || '') !== String(row.task_owner || '') ||
      !student || !lessonTask(task, taskId, row.task_owner) || !validDate(date) ||
      date < student.cycleStartDate || date > sourceDate || String(check.taskId || '') !== taskId ||
      String(row.check_key || '') !== taskId + '|' + date ||
      !QUALIFYING_ATTENDANCE.has(String(check.att || '')) || !attendanceOccurrence) {
    return null;
  }
  return { studentId, cycleStartDate: student.cycleStartDate, taskId, date, checkKey: taskId + '|' + date };
}

async function qualifyingRows(env, earliestDate, sourceDate) {
  const result = await env.DB.prepare(
    "SELECT check_row.k AS check_key,check_row.owner AS check_owner,check_row.data AS check_data," +
      "task.id AS task_id,task.owner AS task_owner,task.data AS task_data," +
      "actual_visit.visit_id AS actual_visit_id " +
    "FROM checks AS check_row JOIN tasks AS task " +
      "ON task.app=check_row.app AND task.id=CAST(json_extract(check_row.data,'$.taskId') AS TEXT) " +
    "LEFT JOIN weekend_actual_visits AS actual_visit " +
      "ON actual_visit.app=check_row.app AND actual_visit.lesson_task_id=task.id " +
      "AND actual_visit.student_id=CAST(json_extract(task.data,'$.studentId') AS TEXT) " +
      "AND actual_visit.visit_date=CAST(json_extract(check_row.data,'$.date') AS TEXT) " +
      "AND actual_visit.status<>'cancelled' " +
    "WHERE check_row.app='task' AND json_valid(check_row.data) AND json_valid(task.data) " +
      "AND json_extract(check_row.data,'$.att') IN ('P','L','E') " +
      "AND json_extract(check_row.data,'$.date') BETWEEN ? AND ? " +
    "ORDER BY json_extract(check_row.data,'$.date'),task.id,check_row.k"
  ).bind(earliestDate, sourceDate).all();
  return result.results || [];
}

/**
 * 23:50 KST Cron에서 호출한다. roster의 학생 단위 회차 시작일부터 모든 과목의
 * 최종 P/L/E만 합산하며, stable studentId + taskId + date를 한 번만 센다.
 */
export async function handleScheduledTuitionAlerts(env, scheduledTime) {
  const cutoff = Number(scheduledTime) || Date.now();
  const sourceDate = kstDateAt(cutoff);
  const summary = {
    ok: true, sourceDate, eligibleStudents: 0, qualifyingAttendances: 0,
    created: 0, idempotent: 0, skipped: 0, failed: 0
  };
  const roster = await loadRoster(env, sourceDate);
  if (roster.error) return { ...summary, ok: false, code: roster.error };
  const students = roster.students;
  summary.eligibleStudents = students.size;
  if (!students.size) return summary;

  const earliestDate = Array.from(students.values()).reduce((earliest, student) =>
    !earliest || student.cycleStartDate < earliest ? student.cycleStartDate : earliest, '');
  let rows;
  try {
    rows = await qualifyingRows(env, earliestDate, sourceDate);
  } catch (error) {
    return { ...summary, ok: false, code: 'TUITION_ATTENDANCE_READ_FAILED' };
  }

  const byStudent = new Map();
  const seen = new Set();
  for (const row of rows) {
    const evidence = qualifyingEvidence(row, students, sourceDate);
    if (!evidence) { summary.skipped++; continue; }
    const identity = evidence.studentId + '\u001f' + evidence.taskId + '\u001f' + evidence.date;
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (!byStudent.has(evidence.studentId)) byStudent.set(evidence.studentId, []);
    byStudent.get(evidence.studentId).push(evidence);
    summary.qualifyingAttendances++;
  }

  for (const student of students.values()) {
    const evidence = (byStudent.get(student.studentId) || []).sort((left, right) =>
      left.date.localeCompare(right.date) || left.taskId.localeCompare(right.taskId));
    if (evidence.length < ATTENDANCE_THRESHOLD) continue;
    const trigger = evidence[ATTENDANCE_THRESHOLD - 1];
    const id = await alertId(student.studentId, student.cycleStartDate);
    try {
      const saved = await env.DB.prepare(
        'INSERT OR IGNORE INTO tuition_generation_alerts ' +
        '(app,alert_id,student_id,cycle_start_date,threshold_count,trigger_task_id,trigger_date,created_at) ' +
        "VALUES('task',?,?,?,?,?,?,?)"
      ).bind(id, student.studentId, student.cycleStartDate, ATTENDANCE_THRESHOLD,
        trigger.taskId, trigger.date, cutoff).run();
      if (Number(saved && saved.meta && saved.meta.changes || 0) === 1) {
        summary.created++;
      } else {
        const existing = await env.DB.prepare(
          "SELECT alert_id,threshold_count FROM tuition_generation_alerts " +
          "WHERE app='task' AND student_id=? AND cycle_start_date=? LIMIT 1"
        ).bind(student.studentId, student.cycleStartDate).first();
        if (existing && String(existing.alert_id || '') === id &&
            Number(existing.threshold_count) === ATTENDANCE_THRESHOLD) summary.idempotent++;
        else summary.failed++;
      }
    } catch (error) {
      if (/no such table.*tuition_generation_alerts/i.test(String(error && error.message || error))) {
        return { ...summary, ok: false, code: 'TUITION_ALERT_LEDGER_NOT_READY' };
      }
      summary.failed++;
    }
  }
  return summary;
}

function alertView(row, student) {
  return {
    alertId: String(row.alert_id), studentId: String(row.student_id),
    studentName: student ? student.name : '', school: student ? student.school : '',
    grade: student ? student.grade : '', cycleStartDate: String(row.cycle_start_date),
    attendanceCount: Number(row.threshold_count), triggerTaskId: String(row.trigger_task_id),
    triggerDate: String(row.trigger_date), message: '수강료 생성필요',
    createdAt: Number(row.created_at), confirmedAt: Number(row.confirmed_at || 0) || null,
    status: row.confirmed_at == null ? 'open' : 'confirmed'
  };
}

async function listAlerts(env, body, origin, auth, json) {
  if (!exactKeys(body, ['app', 'auth', 'action', 'includeConfirmed'])) {
    return reply(json, origin, { ok: false, error: '허용되지 않은 입력이 있습니다' }, 400);
  }
  if (body.includeConfirmed != null && typeof body.includeConfirmed !== 'boolean') {
    return reply(json, origin, { ok: false, error: 'includeConfirmed 값을 확인해 주세요' }, 400);
  }
  const roster = await loadRoster(env);
  if (roster.error) return reply(json, origin, { ok: false, code: roster.error, error: '원생 명단을 확인해 주세요' }, 409);
  try {
    const result = await env.DB.prepare(
      'SELECT alert.*,confirmation.confirmed_at FROM tuition_generation_alerts AS alert ' +
      'LEFT JOIN tuition_generation_alert_confirmations AS confirmation ' +
        'ON confirmation.app=alert.app AND confirmation.alert_id=alert.alert_id ' +
      "WHERE alert.app='task'" + (body.includeConfirmed ? '' : ' AND confirmation.alert_id IS NULL') +
      ' ORDER BY alert.created_at DESC,alert.alert_id DESC LIMIT 500'
    ).all();
    return reply(json, origin, { ok: true, alerts: (result.results || []).map(row =>
      alertView(row, roster.identities.get(String(row.student_id || '')) || null)) });
  } catch (error) {
    if (/no such table.*tuition_generation_alert/i.test(String(error && error.message || error))) {
      return reply(json, origin, { ok: false, code: 'TUITION_ALERT_LEDGER_NOT_READY',
        error: '수강료 알림 원장을 준비하고 있습니다' }, 503);
    }
    throw error;
  }
}

async function confirmAlert(env, body, origin, auth, json) {
  if (!exactKeys(body, ['app', 'auth', 'action', 'alertId'])) {
    return reply(json, origin, { ok: false, error: '허용되지 않은 입력이 있습니다' }, 400);
  }
  const id = String(body.alertId || '');
  if (!ALERT_ID.test(id)) return reply(json, origin, { ok: false, error: '알림을 다시 선택해 주세요' }, 400);
  try {
    const alert = await env.DB.prepare(
      "SELECT alert_id FROM tuition_generation_alerts WHERE app='task' AND alert_id=? LIMIT 1"
    ).bind(id).first();
    if (!alert) return reply(json, origin, { ok: false, error: '알림을 찾을 수 없습니다' }, 404);
    const existing = await env.DB.prepare(
      "SELECT confirmed_at FROM tuition_generation_alert_confirmations WHERE app='task' AND alert_id=? LIMIT 1"
    ).bind(id).first();
    if (existing) return reply(json, origin, { ok: true, idempotent: true,
      alertId: id, confirmedAt: Number(existing.confirmed_at) });
    const now = Date.now();
    const confirmation = await confirmationId(id);
    const saved = await env.DB.prepare(
      'INSERT OR IGNORE INTO tuition_generation_alert_confirmations ' +
      "(app,confirmation_id,alert_id,confirmed_at,confirmed_by) VALUES('task',?,?,?,?)"
    ).bind(confirmation, id, now, actorKey(auth)).run();
    const current = await env.DB.prepare(
      "SELECT confirmed_at FROM tuition_generation_alert_confirmations WHERE app='task' AND alert_id=? LIMIT 1"
    ).bind(id).first();
    if (!current) throw new Error('TUITION_ALERT_CONFIRMATION_NOT_SAVED');
    return reply(json, origin, { ok: true,
      idempotent: Number(saved && saved.meta && saved.meta.changes || 0) !== 1,
      alertId: id, confirmedAt: Number(current.confirmed_at) });
  } catch (error) {
    if (/no such table.*tuition_generation_alert/i.test(String(error && error.message || error))) {
      return reply(json, origin, { ok: false, code: 'TUITION_ALERT_LEDGER_NOT_READY',
        error: '수강료 알림 원장을 준비하고 있습니다' }, 503);
    }
    throw error;
  }
}

export async function handleTuitionAlert(env, app, body, origin, auth, json) {
  body = record(body);
  if (app !== 'task') return reply(json, origin, { ok: false, error: '업무지시서에서만 사용할 수 있습니다' }, 400);
  if (!auth || auth.scope !== 'all') {
    return reply(json, origin, { ok: false, error: '관리자만 수강료 알림을 확인할 수 있습니다' }, 403);
  }
  const action = String(body.action || 'list');
  if (action === 'list') return await listAlerts(env, body, origin, auth, json);
  if (action === 'confirm') return await confirmAlert(env, body, origin, auth, json);
  return reply(json, origin, { ok: false, error: '지원하지 않는 수강료 알림 작업입니다' }, 400);
}
