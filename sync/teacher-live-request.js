const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const REQUEST_ID = /^tlr_[A-Za-z0-9_-]{4,76}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BODY = 2000;
const MAX_REQUESTS = 500;
const MAX_RECEIPTS = 5000;

function changes(result) {
  return Number(result && result.meta && result.meta.changes || 0);
}

function parseJson(value) {
  try { return JSON.parse(String(value || '')); } catch (error) { return null; }
}

function cleanBody(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.normalize('NFKC').replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return cleaned && cleaned.length <= MAX_BODY ? cleaned : null;
}

function validDate(value) {
  const date = String(value || '');
  if (!DATE_RE.test(date)) return false;
  const parts = date.split('-').map(Number);
  const parsed = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  return parsed.getUTCFullYear() === parts[0] && parsed.getUTCMonth() === parts[1] - 1 &&
    parsed.getUTCDate() === parts[2];
}

function kstDate(now = Date.now()) {
  return new Date(Number(now) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function dayOf(date) {
  const parts = String(date).split('-').map(Number);
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])).getUTCDay();
}

function isLessonTask(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task) || task.deleted) return false;
  const lessonFormVersion = Number(task.lessonFormVersion);
  const intakeVersion = Number(task.intakeVersion);
  return task.taskKind === 'lesson_instruction' ||
    (Number.isInteger(lessonFormVersion) && lessonFormVersion >= 1) ||
    (Number.isInteger(intakeVersion) && intakeVersion >= 1);
}

function occursOn(task, date) {
  if (!validDate(date) || !task || task.deleted) return false;
  if (task.start && String(task.start) > date) return false;
  if (task.end && String(task.end) < date) return false;
  const day = dayOf(date);
  if (task.repeat === 'once') return String(task.start || '') === date;
  if (task.repeat === 'daily') return true;
  if (task.repeat === 'weekday') return day >= 1 && day <= 5;
  if (task.repeat === 'days') {
    return Array.isArray(task.days) && task.days.map(Number).includes(day);
  }
  return false;
}

function managerIdSet(env) {
  return new Set([env.TASK_MANAGER_STAFF_IDS, env.TASK_MANAGER_STAFF_IDS_CONFIG]
    .flatMap(value => String(value || '').split(','))
    .map(value => value.trim()).filter(value => SAFE_ID.test(value) && value !== 'director'));
}

async function activeManagerIds(env, app) {
  const configured = managerIdSet(env);
  if (!configured.size) return [];
  const result = await env.DB.prepare('SELECT id,data FROM staff WHERE app=? ORDER BY id').bind(app).all();
  const ids = [];
  for (const row of result.results || []) {
    const id = String(row.id || '');
    if (!configured.has(id)) continue;
    const staff = parseJson(row.data);
    if (staff && !staff.deleted && String(staff.id || '') === id) ids.push(id);
  }
  return [...new Set(ids)].sort();
}

async function recipientIds(env, app) {
  return ['director', ...await activeManagerIds(env, app)];
}

async function recipientAdminViews(env, app, ids) {
  const views = [{ adminId: 'director', displayName: '원장님' }];
  const managerIds = (ids || []).filter(id => id !== 'director');
  if (!managerIds.length) return views;
  const placeholders = managerIds.map(() => '?').join(',');
  const result = await env.DB.prepare(
    'SELECT id,data FROM staff WHERE app=? AND id IN (' + placeholders + ') ORDER BY id'
  ).bind(app, ...managerIds).all();
  const names = new Map();
  for (const row of result.results || []) {
    const data = parseJson(row.data);
    const name = String(data && data.name || '').normalize('NFKC').trim().slice(0, 80);
    if (name && !/[\u0000-\u001f\u007f]/.test(name)) names.set(String(row.id), name);
  }
  managerIds.forEach(adminId => views.push({
    adminId, displayName: names.get(adminId) || '관리자'
  }));
  return views;
}

async function adminIdentity(env, app, auth) {
  if (!auth || auth.scope !== 'all') return '';
  const id = String(auth.id || '');
  if (!id) return 'director';
  if (!SAFE_ID.test(id) || id === 'director') return '';
  const allowed = await activeManagerIds(env, app);
  return allowed.includes(id) ? id : '';
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value || '')));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function receiptEventId(requestId, adminId, eventType) {
  return 'tlre_' + (await sha256Hex([requestId, adminId, eventType].join('\u001f'))).slice(0, 52);
}

async function tablesReady(env) {
  const result = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN " +
    "('teacher_live_requests','teacher_live_request_receipt_events')"
  ).all();
  return (result.results || []).length === 2;
}

function requestView(row, receiptsByRequest, admins) {
  const receipts = receiptsByRequest.get(String(row.request_id)) || new Map();
  const receiptStatus = admins.map(adminId => {
    const status = receipts.get(adminId) || {};
    return {
      adminId,
      openedAt: Number(status.openedAt) || null,
      acknowledgedAt: Number(status.acknowledgedAt) || null
    };
  });
  return {
    requestId: String(row.request_id),
    lessonTaskId: String(row.lesson_task_id), lessonDate: String(row.lesson_date),
    studentId: String(row.student_id), senderStaffId: String(row.sender_staff_id),
    recipientAdminId: String(row.recipient_admin_id), body: String(row.body),
    createdAt: Number(row.created_at), receiptStatus
  };
}

function receiptMaps(rows) {
  const byRequest = new Map();
  const seenAdminIds = new Set();
  for (const row of rows || []) {
    const requestId = String(row.request_id || '');
    const adminId = String(row.admin_id || '');
    if (!REQUEST_ID.test(requestId) || !SAFE_ID.test(adminId)) continue;
    seenAdminIds.add(adminId);
    const statuses = byRequest.get(requestId) || new Map();
    const status = statuses.get(adminId) || {};
    if (row.event_type === 'opened') status.openedAt = Number(row.created_at) || null;
    if (row.event_type === 'acknowledged') status.acknowledgedAt = Number(row.created_at) || null;
    statuses.set(adminId, status);
    byRequest.set(requestId, statuses);
  }
  return { byRequest, seenAdminIds };
}

async function listRows(env, app) {
  const [requestResult, receiptResult, currentAdmins] = await Promise.all([
    env.DB.prepare(
      'SELECT app,request_id,lesson_task_id,lesson_date,student_id,sender_staff_id,' +
      'recipient_admin_id,body,created_at FROM teacher_live_requests WHERE app=? ' +
      'ORDER BY created_at DESC,request_id DESC LIMIT ' + MAX_REQUESTS
    ).bind(app).all(),
    env.DB.prepare(
      'SELECT request_id,admin_id,event_type,created_at FROM teacher_live_request_receipt_events ' +
      'WHERE app=? ORDER BY created_at DESC LIMIT ' + MAX_RECEIPTS
    ).bind(app).all(),
    recipientIds(env, app)
  ]);
  const receipts = receiptMaps(receiptResult.results || []);
  const admins = [...new Set(currentAdmins.concat([...receipts.seenAdminIds]))].sort((left, right) => {
    if (left === 'director') return -1;
    if (right === 'director') return 1;
    return left.localeCompare(right);
  });
  return (requestResult.results || []).map(row => requestView(row, receipts.byRequest, admins));
}

async function recipientList(env, app, origin, auth, json) {
  const actorId = String(auth && auth.id || '');
  if (!SAFE_ID.test(actorId)) {
    return json({ ok: false, error: '개인 직원 인증으로 다시 열어 주세요' }, 403, origin);
  }
  const recipientAdminIds = await recipientIds(env, app);
  return json({ ok: true, recipientAdminIds,
    recipientAdmins: await recipientAdminViews(env, app, recipientAdminIds) }, 200, origin);
}

async function verifiedLesson(env, app, body, auth) {
  const taskId = String(body.lessonTaskId || '');
  const lessonDate = String(body.lessonDate || '');
  const senderId = String(auth && auth.id || '');
  if (!SAFE_ID.test(taskId) || !SAFE_ID.test(senderId) || !validDate(lessonDate)) {
    return { error: '수업·날짜·담당 선생님 정보를 다시 확인해 주세요', status: 400 };
  }
  const today = kstDate();
  if (lessonDate !== today) {
    return { error: '실시간 선생님 요청은 오늘 수업에서만 보낼 수 있습니다', status: 422 };
  }
  const row = await env.DB.prepare('SELECT owner,data FROM tasks WHERE app=? AND id=? LIMIT 1')
    .bind(app, taskId).first();
  const task = row && parseJson(row.data);
  const owner = String(row && row.owner || '');
  if (!row || !task || !isLessonTask(task) || String(task.id || '') !== taskId ||
      !SAFE_ID.test(owner) || String(task.staffId || '') !== owner) {
    return { error: '현재 등록된 수업 정보를 찾을 수 없습니다', status: 409 };
  }
  if (owner !== senderId) {
    return { error: '본인이 담당하는 수업에서만 요청을 보낼 수 있습니다', status: 403 };
  }
  if (!occursOn(task, lessonDate)) {
    return { error: '오늘 진행되는 활성 수업에서만 요청을 보낼 수 있습니다', status: 422 };
  }
  const studentId = String(task.studentId || '');
  if (!SAFE_ID.test(studentId)) {
    return { error: '수업의 stable studentId 연결을 확인해 주세요', status: 409 };
  }
  return { taskId, lessonDate, studentId, senderId, owner, taskData: String(row.data || '') };
}

function sameRequest(row, input) {
  return !!row && String(row.lesson_task_id) === input.taskId &&
    String(row.lesson_date) === input.lessonDate && String(row.student_id) === input.studentId &&
    String(row.sender_staff_id) === input.senderId &&
    String(row.recipient_admin_id) === input.recipientAdminId && String(row.body) === input.body;
}

async function send(env, app, body, origin, auth, json) {
  const requestId = String(body.requestId || '');
  const recipientAdminId = String(body.recipientAdminId || '');
  const requestBody = cleanBody(body.body);
  if (!REQUEST_ID.test(requestId) || !SAFE_ID.test(recipientAdminId) || !requestBody) {
    return json({ ok: false, error: '요청 ID·내용·수신 관리자를 확인해 주세요' }, 400, origin);
  }
  const lesson = await verifiedLesson(env, app, body, auth);
  if (lesson.error) return json({ ok: false, error: lesson.error }, lesson.status, origin);
  const recipients = await recipientIds(env, app);
  if (!recipients.includes(recipientAdminId)) {
    return json({ ok: false, error: '현재 요청을 받을 수 있는 관리자를 선택해 주세요' }, 422, origin);
  }
  const input = { ...lesson, recipientAdminId, body: requestBody };
  const existing = await env.DB.prepare(
    'SELECT * FROM teacher_live_requests WHERE app=? AND request_id=? LIMIT 1'
  ).bind(app, requestId).first();
  if (existing) {
    if (!sameRequest(existing, input)) {
      return json({ ok: false, code: 'REQUEST_ID_CONFLICT', error: '같은 요청 ID로 다른 내용이 이미 저장되어 있습니다' }, 409, origin);
    }
    const rows = await listRows(env, app);
    return json({ ok: true, idempotent: true, request: rows.find(row => row.requestId === requestId) }, 200, origin);
  }
  const now = Date.now();
  const result = await env.DB.prepare(
    'INSERT OR IGNORE INTO teacher_live_requests ' +
    '(app,request_id,lesson_task_id,lesson_date,student_id,sender_staff_id,recipient_admin_id,body,created_at) ' +
    'SELECT ?,?,?,?,?,?,?,?,? FROM tasks current_task WHERE current_task.app=? AND current_task.id=? ' +
    'AND current_task.owner=? AND current_task.data=?'
  ).bind(app, requestId, lesson.taskId, lesson.lessonDate, lesson.studentId, lesson.senderId,
    recipientAdminId, requestBody, now, app, lesson.taskId, lesson.owner, lesson.taskData).run();
  const saved = await env.DB.prepare(
    'SELECT * FROM teacher_live_requests WHERE app=? AND request_id=? LIMIT 1'
  ).bind(app, requestId).first();
  if (!saved || !sameRequest(saved, input)) {
    return json({ ok: false, code: changes(result) ? 'REQUEST_SAVE_INVALID' : 'LESSON_CHANGED',
      error: '수업 정보가 변경되었습니다. 새로고침 후 다시 보내 주세요' }, 409, origin);
  }
  const rows = await listRows(env, app);
  return json({ ok: true, idempotent: changes(result) === 0,
    request: rows.find(row => row.requestId === requestId) }, 200, origin);
}

async function list(env, app, origin, auth, json) {
  const viewerAdminId = await adminIdentity(env, app, auth);
  if (!viewerAdminId) {
    return json({ ok: false, error: '원장·관리 담당만 선생님 요청을 볼 수 있습니다' }, 403, origin);
  }
  return json({ ok: true, viewerAdminId, requests: await listRows(env, app) }, 200, origin);
}

async function receipt(env, app, body, origin, auth, json, eventType) {
  const adminId = await adminIdentity(env, app, auth);
  const requestId = String(body.requestId || '');
  if (!adminId) {
    return json({ ok: false, error: '원장·관리 담당 인증으로 다시 열어 주세요' }, 403, origin);
  }
  if (!REQUEST_ID.test(requestId)) {
    return json({ ok: false, error: '확인할 선생님 요청을 다시 선택해 주세요' }, 400, origin);
  }
  const request = await env.DB.prepare(
    'SELECT 1 present FROM teacher_live_requests WHERE app=? AND request_id=? LIMIT 1'
  ).bind(app, requestId).first();
  if (!request) return json({ ok: false, error: '선생님 요청을 찾을 수 없습니다' }, 404, origin);
  const now = Date.now();
  const types = eventType === 'acknowledged' ? ['opened', 'acknowledged'] : ['opened'];
  const statements = [];
  for (const type of types) {
    statements.push(env.DB.prepare(
      'INSERT OR IGNORE INTO teacher_live_request_receipt_events ' +
      '(app,receipt_event_id,request_id,admin_id,event_type,created_at) VALUES(?,?,?,?,?,?)'
    ).bind(app, await receiptEventId(requestId, adminId, type), requestId, adminId, type, now));
  }
  const results = await env.DB.batch(statements);
  return json({ ok: true, adminId, idempotent: results.every(result => changes(result) === 0) }, 200, origin);
}

export async function handleTeacherLiveRequest(env, app, body, origin, auth, json) {
  if (app !== 'task') {
    return json({ ok: false, error: '실시간 선생님 요청은 직원 앱에서만 사용할 수 있습니다' }, 400, origin);
  }
  if (!await tablesReady(env)) {
    return json({ ok: false, code: 'TEACHER_LIVE_REQUEST_NOT_READY',
      error: '실시간 선생님 요청 기능을 준비하고 있습니다' }, 503, origin);
  }
  const action = String(body && body.action || 'list');
  if (action === 'recipients') return recipientList(env, app, origin, auth, json);
  if (action === 'send') return send(env, app, body, origin, auth, json);
  if (action === 'list') return list(env, app, origin, auth, json);
  if (action === 'opened') return receipt(env, app, body, origin, auth, json, 'opened');
  if (action === 'acknowledge') return receipt(env, app, body, origin, auth, json, 'acknowledged');
  return json({ ok: false, error: '지원하지 않는 실시간 선생님 요청 작업입니다' }, 400, origin);
}
