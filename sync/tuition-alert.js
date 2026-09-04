import { weekendAttendancePolicyOn } from './weekend-flex.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const ALERT_ID = /^tga_[a-f0-9]{52}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SESSION_MODE = 'session4';
const ATTENDANCE_THRESHOLD = 3;
const SESSION_SIZE = 4;
const QUALIFYING_ATTENDANCE = new Set(['P', 'L', 'E']);
const CALENDAR_ATTENDANCE = new Set(['P', 'L', 'A', 'E']);

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

function finalizedAttendanceDateAt(value) {
  const shifted = new Date(Number(value) + 9 * 60 * 60 * 1000);
  const time = shifted.toISOString().slice(11, 16);
  // 회차제 출결은 당일 23:50까지 바꿀 수 있으므로 그 전에는 전날까지만 확정한다.
  if (time < '23:50') shifted.setUTCDate(shifted.getUTCDate() - 1);
  return shifted.toISOString().slice(0, 10);
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

function rosterStudentActiveOn(student, sourceDate) {
  const sourceMonth = String(sourceDate || kstDateAt(Date.now())).slice(0, 7);
  return !(String(student && student.start || '') > sourceMonth ||
    (String(student && student.end || '') && String(student.end) <= sourceMonth));
}

function billingStudents(document, sourceDate, includeInactive = false) {
  const students = document && document.roster && Array.isArray(document.roster.students)
    ? document.roster.students : [];
  const result = new Map();
  for (const student of students) {
    const studentId = String(student && student.id || '');
    const cycleStartDate = String(student && student.sessionCycleStartDate || '');
    const active = rosterStudentActiveOn(student, sourceDate);
    if (!SAFE_ID.test(studentId) || student && student.billingMode !== SESSION_MODE ||
        !validDate(cycleStartDate) || (!includeInactive && !active)) continue;
    if (result.has(studentId)) continue;
    result.set(studentId, {
      studentId, active,
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

async function loadRoster(env, sourceDate, includeInactive = false) {
  const row = await env.DB.prepare("SELECT data FROM private_rosters WHERE app='task' LIMIT 1").first();
  if (!row) return { error: 'ROSTER_NOT_READY' };
  try {
    const document = JSON.parse(row.data || '{}');
    if (!document || !document.roster || !Array.isArray(document.roster.students)) throw new Error('invalid roster');
    return { document, students: billingStudents(document, sourceDate, includeInactive),
      identities: rosterStudentIdentities(document) };
  } catch (error) {
    return { error: 'ROSTER_INVALID' };
  }
}

function lessonIdentity(value, taskId, taskOwner) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    String(value.id || '') === taskId && SAFE_ID.test(String(value.studentId || '')) &&
    SAFE_ID.test(String(taskOwner || '')) && String(value.staffId || '') === String(taskOwner) &&
    (value.taskKind === 'lesson_instruction' || value.lessonFormVersion || value.intakeVersion);
}

function lessonTask(value, taskId, taskOwner) {
  return lessonIdentity(value, taskId, taskOwner) &&
    String(value.lessonInstanceType || '') !== 'makeup' && !String(value.makeupCaseId || '').trim();
}

function makeupOriginAllowsSession(historyValue) {
  let history;
  try { history = JSON.parse(historyValue || '[]'); }
  catch (error) { return false; }
  const first = Array.isArray(history) && history[0] && typeof history[0] === 'object' ? history[0] : null;
  return !!(first && (first.action === 'create_from_absence' ||
    (first.action === 'create_manual' && first.reason === 'manual_absence')));
}

function taskRangeAllowsOn(task, date) {
  // 승인된 휴원·퇴원·수업삭제는 end를 보존한 채 deleted=true로 만든다. 그 이전의
  // 실제 check는 감사·초기 backfill 대상이지만, end 없는 tombstone은 일정으로 인정하지 않는다.
  return !!(task && !(task.deleted && !validDate(String(task.end || ''))) &&
    (!task.start || date >= String(task.start)) && (!task.end || date <= String(task.end)));
}

function occursOn(task, date) {
  if (!taskRangeAllowsOn(task, date)) return false;
  const day = new Date(date + 'T00:00:00Z').getUTCDay();
  if (Array.isArray(task.scheduleSlots) && task.scheduleSlots.length) {
    return task.scheduleSlots.some(slot => {
      const from = String(slot && (slot.validFrom || slot.startDate) || '');
      const to = String(slot && (slot.validTo || slot.endDate) || '');
      if ((from && date < from) || (to && date > to)) return false;
      return Array.isArray(slot && slot.days) && slot.days.map(Number).includes(day);
    });
  }
  if (task.repeat === 'once') return date === String(task.start || '');
  if (task.repeat === 'daily') return true;
  if (task.repeat === 'weekday') return day >= 1 && day <= 5;
  return task.repeat === 'days' && Array.isArray(task.days) && task.days.map(Number).includes(day);
}

function attendanceEvidence(row, students, earliestDate, sourceDate) {
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
  const isMakeup = String(task && task.lessonInstanceType || '') === 'makeup' ||
    !!String(task && task.makeupCaseId || '').trim();
  const makeupIdentity = isMakeup && lessonIdentity(task, taskId, row.task_owner) &&
    taskId === 'makeup_lesson_' + String(row.makeup_case_id || '') &&
    String(row.makeup_case_id || '') === String(task.makeupCaseId || '') &&
    String(row.makeup_student_id || '') === studentId &&
    ['confirmed', 'completed'].includes(String(row.makeup_status || ''));
  const regularIdentity = !isMakeup && lessonTask(task, taskId, row.task_owner);
  const weekendPolicy = weekendAttendancePolicyOn(task, date);
  const exactActualVisit = validDate(date) && [0, 6].includes(new Date(date + 'T00:00:00Z').getUTCDay()) &&
    !!String(row.actual_visit_id || '');
  const attendanceOccurrence = weekendPolicy === 'flexible'
    ? exactActualVisit
    : weekendPolicy === 'fixed' && (occursOn(task, date) || exactActualVisit);
  if (!SAFE_ID.test(taskId) || String(row.check_owner || '') !== String(row.task_owner || '') ||
      !student || (!regularIdentity && !makeupIdentity) || !validDate(date) ||
      !taskRangeAllowsOn(task, date) ||
      date < earliestDate || date > sourceDate || String(check.taskId || '') !== taskId ||
      String(row.check_key || '') !== taskId + '|' + date ||
      !CALENDAR_ATTENDANCE.has(String(check.att || '')) || !attendanceOccurrence) {
    return null;
  }
  return {
    studentId, cycleStartDate: student.cycleStartDate, taskId, date,
    status: String(check.att), checkKey: taskId + '|' + date,
    sessionQualifies: regularIdentity || (makeupIdentity && makeupOriginAllowsSession(row.makeup_history))
  };
}

function qualifyingEvidence(row, students, sourceDate) {
  const studentId = (() => {
    try { return String(JSON.parse(row.task_data || '{}').studentId || ''); }
    catch (error) { return ''; }
  })();
  const student = students.get(studentId);
  if (!student) return null;
  const evidence = attendanceEvidence(row, students, student.cycleStartDate, sourceDate);
  return evidence && evidence.sessionQualifies && QUALIFYING_ATTENDANCE.has(evidence.status) ? evidence : null;
}

async function qualifyingRows(env, earliestDate, sourceDate) {
  const result = await env.DB.prepare(
    "SELECT check_row.k AS check_key,check_row.owner AS check_owner,check_row.data AS check_data," +
      "task.id AS task_id,task.owner AS task_owner,task.data AS task_data," +
      "makeup.case_id AS makeup_case_id,makeup.student_id AS makeup_student_id," +
      "makeup.status AS makeup_status,makeup.history AS makeup_history," +
      "actual_visit.visit_id AS actual_visit_id " +
    "FROM checks AS check_row JOIN tasks AS task " +
      "ON task.app=check_row.app AND task.id=CAST(json_extract(check_row.data,'$.taskId') AS TEXT) " +
    "LEFT JOIN weekend_actual_visits AS actual_visit " +
      "ON actual_visit.app=check_row.app AND actual_visit.lesson_task_id=task.id " +
      "AND actual_visit.student_id=CAST(json_extract(task.data,'$.studentId') AS TEXT) " +
      "AND actual_visit.visit_date=CAST(json_extract(check_row.data,'$.date') AS TEXT) " +
      "AND actual_visit.status<>'cancelled' " +
    "LEFT JOIN makeup_cases AS makeup ON makeup.app=task.app " +
      "AND makeup.case_id=CAST(json_extract(task.data,'$.makeupCaseId') AS TEXT) " +
    "WHERE check_row.app='task' AND json_valid(check_row.data) AND json_valid(task.data) " +
      "AND json_extract(check_row.data,'$.att') IN ('P','L','A','E') " +
      "AND json_extract(check_row.data,'$.date') BETWEEN ? AND ? " +
    "ORDER BY json_extract(check_row.data,'$.date'),task.id,check_row.k"
  ).bind(earliestDate, sourceDate).all();
  return result.results || [];
}

function sortedUniqueEvidence(items) {
  const seen = new Set();
  return items.slice().sort((left, right) =>
    left.date.localeCompare(right.date) || left.taskId.localeCompare(right.taskId)
  ).filter(item => {
    const identity = item.studentId + '\u001f' + item.taskId + '\u001f' + item.date;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

/** 설정 시작일을 첫 회차의 시작으로 두고, 이후에는 5·9…번째 출석일을 새 시작일로 삼는다. */
export function sessionCycles(items, configuredCycleStartDate) {
  const evidence = sortedUniqueEvidence(items).filter(item =>
    QUALIFYING_ATTENDANCE.has(String(item.status || '')) && item.date >= configuredCycleStartDate
  );
  const cycles = [];
  let current = null;
  for (const item of evidence) {
    if (!current || current.attendance.length >= SESSION_SIZE) {
      current = {
        cycleStartDate: cycles.length ? item.date : configuredCycleStartDate,
        attendance: []
      };
      cycles.push(current);
    }
    current.attendance.push(item);
  }
  return cycles;
}

function currentSessionCycle(items, configuredCycleStartDate) {
  const cycles = sessionCycles(items, configuredCycleStartDate);
  const current = cycles.at(-1) || { cycleStartDate: configuredCycleStartDate, attendance: [] };
  return {
    cycleStartDate: current.cycleStartDate,
    attendanceCount: current.attendance.length,
    cycleSize: SESSION_SIZE,
    cycleComplete: current.attendance.length === SESSION_SIZE
  };
}

function ledgerUnavailable(error) {
  return /no such table.*student_session_/i.test(String(error && error.message || error));
}

async function ledgerCycles(env, studentId, configuredCycleStartDate) {
  const [cycleResult, eventResult] = await Promise.all([
    env.DB.prepare(
      "SELECT cycle_number,cycle_start_date,created_at FROM student_session_cycles " +
      "WHERE app='task' AND student_id=? AND configured_start_date=? ORDER BY cycle_number"
    ).bind(studentId, configuredCycleStartDate).all(),
    env.DB.prepare(
      "SELECT cycle_number,session_number,lesson_task_id,attendance_date,attendance_status,created_at " +
      "FROM student_session_attendance_events WHERE app='task' AND student_id=? " +
      "AND configured_start_date=? ORDER BY cycle_number,session_number"
    ).bind(studentId, configuredCycleStartDate).all()
  ]);
  const entriesByCycle = new Map();
  for (const row of eventResult.results || []) {
    const number = Number(row.cycle_number);
    if (!entriesByCycle.has(number)) entriesByCycle.set(number, []);
    entriesByCycle.get(number).push({
      date: String(row.attendance_date), status: String(row.attendance_status),
      taskId: String(row.lesson_task_id), recordedAt: Number(row.created_at)
    });
  }
  return (cycleResult.results || []).map(row => {
    const entries = entriesByCycle.get(Number(row.cycle_number)) || [];
    return {
      cycleNo: Number(row.cycle_number), cycleStartDate: String(row.cycle_start_date),
      status: entries.length === SESSION_SIZE ? 'complete' : 'open',
      attendanceCount: entries.length,
      completedAt: entries.length === SESSION_SIZE ? entries[SESSION_SIZE - 1].date : null,
      entries
    };
  });
}

async function ensureInitialLedgerCycle(env, student, now) {
  return await env.DB.prepare(
    "INSERT OR IGNORE INTO student_session_cycles " +
    "(app,student_id,configured_start_date,cycle_number,cycle_start_date,created_at) " +
    "VALUES('task',?,?,1,?,?)"
  ).bind(student.studentId, student.cycleStartDate, student.cycleStartDate, now).run();
}

async function appendLedgerEvidence(env, student, evidence, now) {
  const studentId = student.studentId;
  const configured = student.cycleStartDate;
  await ensureInitialLedgerCycle(env, student, now);

  let cycles = await ledgerCycles(env, studentId, configured);
  if (!cycles.length) throw new Error('STUDENT_SESSION_INITIAL_CYCLE_NOT_SAVED');
  const existing = new Set(cycles.flatMap(cycle => cycle.entries.map(entry => entry.taskId + '\u001f' + entry.date)));
  let current = cycles.at(-1);
  let lastDate = cycles.flatMap(cycle => cycle.entries).at(-1)?.date || '';
  const summary = { cycles: 0, events: 0, idempotent: 0, skipped: 0 };
  for (const item of sortedUniqueEvidence(evidence)) {
    const identity = item.taskId + '\u001f' + item.date;
    if (existing.has(identity)) { summary.idempotent++; continue; }
    // append-only 원장에 뒤늦은 과거 출결을 끼워 넣으면 이미 확정된 회차가 바뀐다.
    if (lastDate && item.date < lastDate) { summary.skipped++; continue; }
    const startsNewCycle = current.attendanceCount >= SESSION_SIZE;
    const cycleNo = startsNewCycle ? current.cycleNo + 1 : current.cycleNo;
    const sessionNo = startsNewCycle ? 1 : current.attendanceCount + 1;
    const event = env.DB.prepare(
      "INSERT INTO student_session_attendance_events " +
      "(app,student_id,configured_start_date,cycle_number,session_number,lesson_task_id," +
      "attendance_date,attendance_status,check_key,created_at) VALUES('task',?,?,?,?,?,?,?,?,?)"
    ).bind(studentId, configured, cycleNo, sessionNo, item.taskId, item.date, item.status, item.checkKey, now);
    try {
      if (startsNewCycle) {
        const cycle = env.DB.prepare(
          "INSERT INTO student_session_cycles " +
          "(app,student_id,configured_start_date,cycle_number,cycle_start_date,created_at) " +
          "VALUES('task',?,?,?,?,?)"
        ).bind(studentId, configured, cycleNo, item.date, now);
        await env.DB.batch([cycle, event]);
        summary.cycles++;
        current = { cycleNo, cycleStartDate: item.date, status: 'open', attendanceCount: 1,
          completedAt: null, entries: [] };
      } else {
        await event.run();
        current = { ...current, attendanceCount: sessionNo,
          status: sessionNo === SESSION_SIZE ? 'complete' : 'open',
          completedAt: sessionNo === SESSION_SIZE ? item.date : null };
      }
      existing.add(identity);
      lastDate = item.date;
      summary.events++;
    } catch (error) {
      // 같은 Cron/조회가 겹쳤다면 원장 정본을 다시 읽어 정확히 같은 근거가 이미 있는지만 확인한다.
      const refreshed = await ledgerCycles(env, studentId, configured);
      const exact = refreshed.some(cycle => cycle.entries.some(entry =>
        entry.taskId === item.taskId && entry.date === item.date && entry.status === item.status
      ));
      if (!exact) throw error;
      cycles = refreshed;
      current = cycles.at(-1);
      existing.add(identity);
      lastDate = cycles.flatMap(cycle => cycle.entries).at(-1)?.date || lastDate;
      summary.idempotent++;
    }
  }
  return summary;
}

/** roster의 현재 session4 설정을 기준으로 0/4 회차와 최종 P/L/E 사용 근거를 일반 backfill한다. */
export async function syncStudentSessionLedgers(env, scheduledTime) {
  const cutoff = Number(scheduledTime) || Date.now();
  const sourceDate = finalizedAttendanceDateAt(cutoff);
  const summary = { ok: true, sourceDate, eligibleStudents: 0, createdCycles: 0,
    createdEvents: 0, idempotent: 0, skipped: 0 };
  const roster = await loadRoster(env, sourceDate, true);
  if (roster.error) return { ...summary, ok: false, code: roster.error };
  const students = roster.students;
  summary.eligibleStudents = students.size;
  if (!students.size) return summary;
  const earliestDate = Array.from(students.values()).reduce((earliest, student) =>
    !earliest || student.cycleStartDate < earliest ? student.cycleStartDate : earliest, '');
  let rows;
  try { rows = await qualifyingRows(env, earliestDate, sourceDate); }
  catch (error) { return { ...summary, ok: false, code: 'STUDENT_SESSION_ATTENDANCE_READ_FAILED' }; }
  const byStudent = new Map();
  for (const row of rows) {
    const item = qualifyingEvidence(row, students, sourceDate);
    if (!item) { summary.skipped++; continue; }
    if (!byStudent.has(item.studentId)) byStudent.set(item.studentId, []);
    byStudent.get(item.studentId).push(item);
  }
  try {
    for (const student of students.values()) {
      const saved = await appendLedgerEvidence(env, student, byStudent.get(student.studentId) || [], cutoff);
      summary.createdCycles += saved.cycles;
      summary.createdEvents += saved.events;
      summary.idempotent += saved.idempotent;
      summary.skipped += saved.skipped;
    }
  } catch (error) {
    if (ledgerUnavailable(error)) return { ...summary, ok: false, code: 'STUDENT_SESSION_LEDGER_NOT_READY' };
    return { ...summary, ok: false, code: 'STUDENT_SESSION_LEDGER_WRITE_FAILED' };
  }
  return summary;
}

/**
 * 23:50 KST Cron에서 호출한다. roster의 학생 단위 회차 시작일부터 모든 과목의
 * 최종 P/L/E만 합산하며, stable studentId + taskId + date를 한 번만 센다.
 */
export async function handleScheduledTuitionAlerts(env, scheduledTime) {
  const cutoff = Number(scheduledTime) || Date.now();
  const sourceDate = finalizedAttendanceDateAt(cutoff);
  const summary = {
    ok: true, sourceDate, eligibleStudents: 0, qualifyingAttendances: 0,
    created: 0, idempotent: 0, skipped: 0, failed: 0
  };
  const ledgerSync = await syncStudentSessionLedgers(env, cutoff);
  if (!ledgerSync.ok) return { ...summary, ok: false, code: ledgerSync.code };
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
    let cycles;
    try { cycles = await ledgerCycles(env, student.studentId, student.cycleStartDate); }
    catch (error) {
      if (ledgerUnavailable(error)) return { ...summary, ok: false, code: 'STUDENT_SESSION_LEDGER_NOT_READY' };
      summary.failed++;
      continue;
    }
    for (const cycle of cycles) {
      if (cycle.entries.length < ATTENDANCE_THRESHOLD) continue;
      const trigger = cycle.entries[ATTENDANCE_THRESHOLD - 1];
      const id = await alertId(student.studentId, cycle.cycleStartDate);
      try {
        const saved = await env.DB.prepare(
          'INSERT OR IGNORE INTO tuition_generation_alerts ' +
          '(app,alert_id,student_id,cycle_start_date,threshold_count,trigger_task_id,trigger_date,created_at) ' +
          "VALUES('task',?,?,?,?,?,?,?)"
        ).bind(id, student.studentId, cycle.cycleStartDate, ATTENDANCE_THRESHOLD,
          trigger.taskId, trigger.date, cutoff).run();
        if (Number(saved && saved.meta && saved.meta.changes || 0) === 1) {
          summary.created++;
        } else {
          const existing = await env.DB.prepare(
            "SELECT alert_id,threshold_count FROM tuition_generation_alerts " +
            "WHERE app='task' AND student_id=? AND cycle_start_date=? LIMIT 1"
          ).bind(student.studentId, cycle.cycleStartDate).first();
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

async function assignedStudentIds(env, auth, sourceDate) {
  if (auth && auth.scope === 'all') return null;
  if (!auth || auth.scope !== 'own' || !SAFE_ID.test(String(auth.id || ''))) return new Set();
  const result = await env.DB.prepare(
    "SELECT id,owner,data FROM tasks WHERE app='task' AND owner=?"
  ).bind(String(auth.id)).all();
  const ids = new Set();
  for (const row of result.results || []) {
    let task;
    try { task = JSON.parse(row.data || '{}'); }
    catch (error) { continue; }
    if (!task.deleted && (!task.start || String(task.start) <= sourceDate) &&
        (!task.end || String(task.end) >= sourceDate) &&
        lessonTask(task, String(row.id || ''), String(row.owner || ''))) {
      ids.add(String(task.studentId));
    }
  }
  return ids;
}

function cycleSummary(studentId, configuredCycleStartDate, cycles) {
  const current = cycles.at(-1) || null;
  return {
    studentId, billingMode: SESSION_MODE, configuredCycleStartDate,
    cycleStartDate: current ? current.cycleStartDate : configuredCycleStartDate,
    attendanceCount: current ? current.attendanceCount : 0,
    cycleSize: SESSION_SIZE, cycleComplete: !!(current && current.status === 'complete'), cycles
  };
}

/**
 * 학생 정보 달력과 4회 진행 표시가 함께 쓰는 읽기 전용 정본이다.
 * 연락처·이름·메모는 반환하지 않고 stable studentId와 출결 최소 필드만 보낸다.
 */
export async function handleStudentAttendance(env, app, body, origin, auth, json) {
  body = record(body);
  if (app !== 'task') {
    return reply(json, origin, { ok: false, error: '업무지시서에서만 사용할 수 있습니다' }, 400);
  }
  if (!exactKeys(body, ['app', 'auth', 'action', 'studentId', 'month'])) {
    return reply(json, origin, { ok: false, error: '허용되지 않은 입력이 있습니다' }, 400);
  }
  const action = body.action == null || body.action === '' ? 'get' : String(body.action);
  if (!['get', 'list', 'backfill'].includes(action)) {
    return reply(json, origin, { ok: false, error: '지원하지 않는 출결 조회 작업입니다' }, 400);
  }
  const sourceDate = kstDateAt(Date.now());
  const month = body.month == null || body.month === '' ? sourceDate.slice(0, 7) : String(body.month);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return reply(json, origin, { ok: false, error: 'month는 YYYY-MM 형식이어야 합니다' }, 400);
  }
  const roster = await loadRoster(env, sourceDate, true);
  if (roster.error) {
    return reply(json, origin, { ok: false, code: roster.error, error: '원생 명단을 확인해 주세요' }, 409);
  }
  const allowedStudentIds = await assignedStudentIds(env, auth, sourceDate);
  if (action === 'backfill') {
    if (body.studentId != null || body.month != null || !auth || auth.scope !== 'all') {
      return reply(json, origin, { ok: false, error: '관리자만 전체 회차 원장을 확정할 수 있습니다' }, 403);
    }
    const synced = await syncStudentSessionLedgers(env, Date.now());
    return reply(json, origin, synced, synced.ok ? 200 : 503);
  }
  if (action === 'list') {
    if (body.studentId != null || body.month != null) {
      return reply(json, origin, { ok: false, error: '목록 조회에는 studentId 또는 month를 사용할 수 없습니다' }, 400);
    }
    const summaries = [];
    try {
      for (const student of roster.students.values()) {
        if (allowedStudentIds && (!student.active || !allowedStudentIds.has(student.studentId))) continue;
        await ensureInitialLedgerCycle(env, student, Date.now());
        const cycles = await ledgerCycles(env, student.studentId, student.cycleStartDate);
        summaries.push(cycleSummary(student.studentId, student.cycleStartDate, cycles));
      }
    } catch (error) {
      if (ledgerUnavailable(error)) return reply(json, origin, { ok: false,
        code: 'STUDENT_SESSION_LEDGER_NOT_READY', error: '학생 회차 원장을 준비하고 있습니다' }, 503);
      throw error;
    }
    return reply(json, origin, { ok: true, students: summaries });
  }

  const studentId = String(body.studentId || '');
  if (!SAFE_ID.test(studentId)) {
    return reply(json, origin, { ok: false, error: '학생 ID를 확인해 주세요' }, 400);
  }
  const rawStudents = roster.document.roster.students;
  const student = rawStudents.find(item => String(item && item.id || '') === studentId);
  if (!student) return reply(json, origin, { ok: false, error: '학생을 찾을 수 없습니다' }, 404);
  if (allowedStudentIds && (!rosterStudentActiveOn(student, sourceDate) || !allowedStudentIds.has(studentId))) {
    return reply(json, origin, { ok: false, error: '해당 학생의 담당 선생님 또는 관리자만 출결을 확인할 수 있습니다' }, 403);
  }

  const billingMode = String(student.billingMode || 'monthly') === SESSION_MODE ? SESSION_MODE : 'monthly';
  const configuredCycleStartDate = billingMode === SESSION_MODE && validDate(student.sessionCycleStartDate)
    ? String(student.sessionCycleStartDate) : null;
  const monthStart = month + '-01';
  const earliestDate = configuredCycleStartDate && configuredCycleStartDate < monthStart
    ? configuredCycleStartDate : monthStart;
  let rows = [];
  if (earliestDate <= sourceDate) rows = await qualifyingRows(env, earliestDate, sourceDate);
  const studentMap = new Map([[studentId, {
    studentId, cycleStartDate: configuredCycleStartDate || earliestDate
  }]]);
  const evidence = sortedUniqueEvidence(rows.map(row =>
    attendanceEvidence(row, studentMap, earliestDate, sourceDate)
  ).filter(Boolean));
  const attendance = evidence.filter(item => item.date.slice(0, 7) === month)
    .map(item => ({ date: item.date, status: item.status, taskId: item.taskId }));
  if (billingMode !== SESSION_MODE || !configuredCycleStartDate) {
    return reply(json, origin, { ok: true, studentId, month, billingMode, configuredCycleStartDate: null,
      cycleStartDate: null, attendanceCount: 0, cycleSize: SESSION_SIZE, cycleComplete: false,
      cycles: [], attendance });
  }
  let cycles;
  try {
    await ensureInitialLedgerCycle(env, { studentId, cycleStartDate: configuredCycleStartDate }, Date.now());
    cycles = await ledgerCycles(env, studentId, configuredCycleStartDate);
  }
  catch (error) {
    if (ledgerUnavailable(error)) return reply(json, origin, { ok: false,
      code: 'STUDENT_SESSION_LEDGER_NOT_READY', error: '학생 회차 원장을 준비하고 있습니다' }, 503);
    throw error;
  }
  return reply(json, origin, { ok: true, month, attendance,
    ...cycleSummary(studentId, configuredCycleStartDate, cycles) });
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
