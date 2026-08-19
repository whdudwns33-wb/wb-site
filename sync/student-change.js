const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/;

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value || '')));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function studentChangeActorKey(auth) {
  if (auth && auth.role === 'manager' && auth.id) return 'manager:' + auth.id;
  if (auth && auth.scope === 'own' && auth.id) return 'staff:' + auth.id;
  return 'director';
}

export async function studentChangeEventId(source) {
  return 'sce_' + (await sha256Hex(source)).slice(0, 52);
}

export async function studentChangeAcknowledgementId(eventId, actorKey) {
  return 'sca_' + (await sha256Hex(eventId + '\n' + actorKey)).slice(0, 52);
}

export function studentChangeEventStatement(env, app, event) {
  return env.DB.prepare(
    'INSERT OR IGNORE INTO student_change_events ' +
    '(app,event_id,student_id,task_id,event_type,changed_fields,details,audience_staff_ids,effective_date,' +
      'requires_ack,request_key,request_revision,changed_at,changed_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).bind(
    app, event.eventId, event.studentId, event.taskId || null, event.eventType,
    JSON.stringify(event.changedFields || []), JSON.stringify(event.details || {}),
    JSON.stringify([...new Set((event.audienceStaffIds || []).filter(id => SAFE_ID.test(String(id))))]),
    event.effectiveDate || null, event.requiresAck ? 1 : 0,
    event.requestKey || null, event.requestRevision || null, event.changedAt, event.changedBy
  );
}

function parsed(value, fallback) {
  try { return JSON.parse(value); } catch (error) { return fallback; }
}

function view(row) {
  return {
    eventId: String(row.event_id),
    studentId: String(row.student_id),
    taskId: row.task_id == null ? '' : String(row.task_id),
    eventType: String(row.event_type),
    changedFields: parsed(row.changed_fields, []),
    details: parsed(row.details, {}),
    effectiveDate: row.effective_date == null ? '' : String(row.effective_date),
    requiresAck: Number(row.requires_ack) === 1,
    acknowledged: Number(row.acknowledged) === 1,
    changedAt: Number(row.changed_at)
  };
}

async function visibleEvents(env, app, auth, actorKey, studentId, pendingOnly) {
  const clauses = ["event.app=?", "event.event_type<>'lesson_delete'"];
  const binds = [app];
  if (studentId) { clauses.push('event.student_id=?'); binds.push(studentId); }
  if (pendingOnly) clauses.push('event.requires_ack=1');
  if (auth.scope !== 'all') {
    clauses.push('EXISTS (SELECT 1 FROM json_each(event.audience_staff_ids) audience WHERE audience.value=?)');
    binds.push(auth.id);
  }
  binds.push(actorKey);
  const result = await env.DB.prepare(
    'SELECT event.*, EXISTS (SELECT 1 FROM student_change_acknowledgements ack ' +
      'WHERE ack.app=event.app AND ack.event_id=event.event_id AND ack.actor_key=?) AS acknowledged ' +
    'FROM student_change_events event WHERE ' + clauses.join(' AND ') +
    ' ORDER BY event.changed_at DESC, event.event_id DESC LIMIT 500'
  ).bind(binds.pop(), ...binds).all();
  return result.results || [];
}

export async function handleStudentChange(env, app, body, origin, auth, json) {
  if (app !== 'task') return json({ ok: false, error: '이 기능은 직원 앱에서만 사용할 수 있습니다' }, 400, origin);
  const action = String(body.action || 'list');
  if (!['list', 'acknowledge'].includes(action)) {
    return json({ ok: false, error: '지원하지 않는 학생 변경 이력 작업입니다' }, 400, origin);
  }
  const actorKey = studentChangeActorKey(auth);
  if (action === 'list') {
    const rows = await visibleEvents(env, app, auth, actorKey, '', false);
    return json({ ok: true, events: rows.map(view) }, 200, origin);
  }

  const studentId = String(body.studentId || '');
  if (!SAFE_ID.test(studentId)) return json({ ok: false, error: '학생을 다시 선택해 주세요' }, 400, origin);
  const rows = await visibleEvents(env, app, auth, actorKey, studentId, true);
  const pending = rows.filter(row => Number(row.acknowledged) !== 1);
  if (!pending.length) return json({ ok: true, idempotent: true, acknowledged: 0 }, 200, origin);
  const now = Date.now();
  const statements = [];
  for (const row of pending) {
    const acknowledgementId = await studentChangeAcknowledgementId(String(row.event_id), actorKey);
    statements.push(env.DB.prepare(
      'INSERT OR IGNORE INTO student_change_acknowledgements ' +
      '(app,acknowledgement_id,event_id,actor_key,acknowledged_at) VALUES (?,?,?,?,?)'
    ).bind(app, acknowledgementId, String(row.event_id), actorKey, now));
  }
  const results = await env.DB.batch(statements);
  const acknowledged = results.reduce((sum, result) => sum + Number(result && result.meta && result.meta.changes || 0), 0);
  return json({ ok: true, idempotent: acknowledged === 0, acknowledged }, 200, origin);
}
