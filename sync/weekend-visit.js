const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_REASON = 200;

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

function hasWeekendSchedule(task) {
  const slots = Array.isArray(task && task.scheduleSlots) ? task.scheduleSlots : [];
  if (slots.some(slot => Array.isArray(slot && slot.days) && slot.days.map(Number).some(day => day === 0 || day === 6))) return true;
  return Array.isArray(task && task.days) && task.days.map(Number).some(day => day === 0 || day === 6);
}

function isLesson(task) {
  return !!(task && !task.deleted && (task.taskKind === 'lesson_instruction' || task.lessonFormVersion ||
    task.intakeVersion || /^\[(수업|컨설팅)\]/.test(String(task.title || ''))));
}

function activeOn(task, date) {
  return (!task.start || String(task.start) <= date) && (!task.end || String(task.end) >= date);
}

function rowView(row) {
  if (!row) return null;
  return {
    visitId: String(row.visit_id), studentId: String(row.student_id), lessonTaskId: String(row.lesson_task_id),
    staffId: String(row.staff_id), visitDate: String(row.visit_date), checkInAt: Number(row.check_in_at),
    checkOutAt: row.check_out_at == null ? null : Number(row.check_out_at), status: String(row.status),
    revision: Number(row.revision), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at)
  };
}

function randomId(prefix) {
  return prefix + crypto.randomUUID().replace(/-/g, '');
}

function actorId(auth) {
  const value = auth && auth.id ? String(auth.id) : '__admin__';
  return SAFE_ID.test(value) ? value : '__admin__';
}

async function findVisit(env, app, visitId) {
  return await env.DB.prepare('SELECT * FROM weekend_actual_visits WHERE app=? AND visit_id=? LIMIT 1')
    .bind(app, visitId).first();
}

function canAccess(row, auth) {
  return auth.scope === 'all' || String(row && row.staff_id || '') === String(auth.id || '');
}

async function verifiedLesson(env, app, taskId, studentId, visitDate, auth) {
  if (!SAFE_ID.test(taskId) || !SAFE_ID.test(studentId)) return { error: '학생과 수업 식별 정보를 확인해 주세요' };
  const taskRow = await env.DB.prepare('SELECT owner,data FROM tasks WHERE app=? AND id=? LIMIT 1')
    .bind(app, taskId).first();
  const task = taskRow && parseJson(taskRow.data);
  if (!task || !isLesson(task) || !activeOn(task, visitDate) || !hasWeekendSchedule(task)) {
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
  return { task, staffId: String(task.staffId) };
}

async function latestAfterWrite(env, app, visitId) {
  return rowView(await findVisit(env, app, visitId));
}

async function appendUpdate(env, app, current, values, eventType, reason, auth) {
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
  const statements = [
    env.DB.prepare(
      'UPDATE weekend_actual_visits SET check_in_at=?,check_out_at=?,status=?,revision=?,updated_at=?,updated_by=? ' +
      'WHERE app=? AND visit_id=? AND revision=?'
    ).bind(values.checkInAt, values.checkOutAt, values.status, revision, updatedAt, actor,
      app, current.visit_id, expectedRevision),
    env.DB.prepare(
      'INSERT INTO weekend_actual_visit_events (app,event_id,visit_id,event_type,event_data,actor_id,created_at) ' +
      'SELECT ?,?,?,?,?,?,? WHERE EXISTS (' +
      'SELECT 1 FROM weekend_actual_visits WHERE app=? AND visit_id=? AND revision=? AND updated_at=?)'
    ).bind(app, eventId, current.visit_id, eventType, eventData, actor, updatedAt,
      app, current.visit_id, revision, updatedAt)
  ];
  const results = await env.DB.batch(statements);
  if (Number(results && results[0] && results[0].meta && results[0].meta.changes || 0) !== 1) return { stale: true };
  return { visit: await latestAfterWrite(env, app, current.visit_id) };
}

async function listVisits(env, app, body, auth, json, origin) {
  const visitDate = String(body.visitDate || '');
  if (!isWeekendDate(visitDate)) return json({ ok: false, error: '토요일 또는 일요일 날짜를 선택해 주세요' }, 422, origin);
  let staffId = auth.scope === 'own' ? String(auth.id || '') : String(body.staffId || '');
  if (staffId && !SAFE_ID.test(staffId)) return json({ ok: false, error: '담당자 정보를 확인해 주세요' }, 422, origin);
  const result = staffId
    ? await env.DB.prepare(
      "SELECT * FROM weekend_actual_visits WHERE app=? AND visit_date=? AND staff_id=? AND status<>'cancelled' ORDER BY check_in_at,student_id"
    ).bind(app, visitDate, staffId).all()
    : await env.DB.prepare(
      "SELECT * FROM weekend_actual_visits WHERE app=? AND visit_date=? AND status<>'cancelled' ORDER BY check_in_at,staff_id,student_id"
    ).bind(app, visitDate).all();
  return json({ ok: true, visits: (result.results || []).map(rowView) }, 200, origin);
}

async function checkIn(env, app, body, auth, json, origin) {
  const now = Date.now();
  const visitDate = String(body.visitDate || '');
  const taskId = String(body.lessonTaskId || '');
  const studentId = String(body.studentId || '');
  if (!isWeekendDate(visitDate) || kstParts(now).date !== visitDate) {
    return json({ ok: false, error: '실제 등원은 오늘 토·일 기록에서만 저장할 수 있습니다' }, 422, origin);
  }
  const verified = await verifiedLesson(env, app, taskId, studentId, visitDate, auth);
  if (verified.error) return json({ ok: false, error: verified.error }, 422, origin);

  const existing = await env.DB.prepare(
    'SELECT * FROM weekend_actual_visits WHERE app=? AND student_id=? AND lesson_task_id=? AND visit_date=? LIMIT 1'
  ).bind(app, studentId, taskId, visitDate).first();
  if (existing && existing.status === 'active') return json({ ok: true, idempotent: true, visit: rowView(existing) }, 200, origin);
  if (existing && existing.status === 'completed') {
    return json({ ok: false, code: 'VISIT_ALREADY_COMPLETED', error: '이미 하원까지 완료된 기록입니다' }, 409, origin);
  }
  const anotherOpen = await env.DB.prepare(
    "SELECT * FROM weekend_actual_visits WHERE app=? AND student_id=? AND status='active' LIMIT 1"
  ).bind(app, studentId).first();
  if (anotherOpen) {
    return json({ ok: false, code: 'VISIT_ALREADY_OPEN', error: '이 학생의 하원 전 기록이 이미 있습니다', current: rowView(anotherOpen) }, 409, origin);
  }

  if (existing && existing.status === 'cancelled') {
    const reopened = await appendUpdate(env, app, existing, {
      checkInAt: now, checkOutAt: null, status: 'active', expectedRevision: Number(existing.revision)
    }, 'reopen', '취소 후 다시 등원', auth);
    if (reopened.stale) return json({ ok: false, code: 'VISIT_STALE', error: '다른 기기에서 기록이 먼저 변경되었습니다' }, 409, origin);
    return json({ ok: true, visit: reopened.visit }, 200, origin);
  }

  const visitId = randomId('wv_');
  const eventId = randomId('wve_');
  const actor = actorId(auth);
  const eventData = JSON.stringify({ version: 1, before: null,
    after: { checkInAt: now, checkOutAt: null, status: 'active' }, reason: '' });
  const results = await env.DB.batch([
    env.DB.prepare(
      'INSERT OR IGNORE INTO weekend_actual_visits ' +
      '(app,visit_id,student_id,lesson_task_id,staff_id,visit_date,check_in_at,check_out_at,status,revision,created_at,updated_at,created_by,updated_by) ' +
      'VALUES (?,?,?,?,?,?,?,NULL,\'active\',1,?,?,?,?)'
    ).bind(app, visitId, studentId, taskId, verified.staffId, visitDate, now, now, now, actor, actor),
    env.DB.prepare(
      'INSERT INTO weekend_actual_visit_events (app,event_id,visit_id,event_type,event_data,actor_id,created_at) ' +
      'SELECT ?,?,?,\'check_in\',?,?,? WHERE EXISTS (' +
      'SELECT 1 FROM weekend_actual_visits WHERE app=? AND visit_id=? AND revision=1 AND updated_at=?)'
    ).bind(app, eventId, visitId, eventData, actor, now, app, visitId, now)
  ]);
  if (Number(results && results[0] && results[0].meta && results[0].meta.changes || 0) !== 1) {
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
  if (!canAccess(current, auth)) return json({ ok: false, error: '본인이 담당하는 수업만 기록할 수 있습니다' }, 422, origin);
  const expectedRevision = Number(body.revision);

  if (action === 'check_out') {
    const now = Date.now();
    if (current.status === 'completed') return json({ ok: true, idempotent: true, visit: rowView(current) }, 200, origin);
    if (kstParts(now).date !== current.visit_date) {
      return json({ ok: false, error: '지난 날짜의 미하원 기록은 시간 수정 또는 취소로 정리해 주세요' }, 422, origin);
    }
    const saved = await appendUpdate(env, app, current, {
      checkInAt: Number(current.check_in_at), checkOutAt: now, status: 'completed', expectedRevision
    }, 'check_out', '', auth);
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
    }, 'cancel', reason, auth);
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
  const saved = await appendUpdate(env, app, current, {
    checkInAt, checkOutAt, status: checkOutAt == null ? 'active' : 'completed', expectedRevision
  }, 'correct', reason, auth);
  if (saved.stale) return json({ ok: false, code: 'VISIT_STALE', error: '다른 기기에서 기록이 먼저 변경되었습니다' }, 409, origin);
  return json({ ok: true, visit: saved.visit }, 200, origin);
}

export async function handleWeekendVisit(env, app, body, origin, auth, json) {
  if (app !== 'task') return json({ ok: false, error: '업무 화면에서만 등·하원 기록을 사용할 수 있습니다' }, 400, origin);
  const action = String(body.action || 'list');
  if (action === 'list') return await listVisits(env, app, body, auth, json, origin);
  if (action === 'check_in') return await checkIn(env, app, body, auth, json, origin);
  return await changeVisit(env, app, body, auth, json, origin);
}

export const weekendVisitInternals = { isWeekendDate, hasWeekendSchedule, kstParts };
