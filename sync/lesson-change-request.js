/**
 * 수업 지시서 변경 요청 — 원장이 등록한 [수업]/[컨설팅] 지시서는 직원이 직접 못 고친다
 * (서버가 upsertStmt/inspectOwnTaskChanges에서 origin!=='staff' 업무의 수정을 막는다).
 * 여기서는 그 자리를 메운다: 직원이 "이렇게 바꿔 주세요"를 제안하면(request),
 * 원장이 검토(review)해 승인해야 실제 지시서에 반영된다. 학부모 피드백 검토와 같은
 * "제출 → 확인" 골격을 그대로 따른다.
 *
 * 대상은 구조화된 수업 등록(lesson-create.js, scheduleSlots 기반)이 아니라
 * 평범한 지시서 필드(days/time/repeat/detail/guide/target/unit)다. 신형 강사 수업
 * 입력으로 만든 지시서(lessonFormVersion/intakeVersion 있음)는 이미 본인이 직접
 * 고칠 수 있어 이 경로가 필요 없다.
 *
 *   POST /lesson-change-request { app, auth, action:'submit'|'cancel'|'list', taskId, changes, note }
 *   POST /lesson-change-review  { app, auth(admin), action:'list'|'approve'|'reject', requestKey, revision, note }
 */

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
import { validateRosterDocument } from './roster.js';
import { studentChangeActorKey, studentChangeEventId, studentChangeEventStatement } from './student-change.js';

const LESSON_CHANGE_FIELDS = ['days', 'time', 'repeat', 'detail', 'guide', 'target', 'unit'];
const REQUEST_OPERATIONS = new Set([
  'lesson_fields', 'teacher_assignment', 'withdrawal', 'leave', 'lesson_delete', 'information_request'
]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const REPEAT_VALUES = new Set(['once', 'daily', 'weekday', 'days']);
const MAX_LESSON_TEXT = 2400;
const MAX_UNIT = 20;
const MAX_NOTE = 500;
const MAX_REVIEW_NOTE = 1000;
const STATUSES = new Set(['approval_waiting', 'approved', 'rejected', 'cancelled']);

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value == null ? '' : value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeText(value) {
  return String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim();
}

function auditActor(auth) {
  return auth.role === 'manager' ? String(auth.id) : 'director';
}

function validIsoDate(value) {
  const text = normalizeText(value);
  const date = new Date(text + 'T00:00:00Z');
  return ISO_DATE.test(text) && !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function nextMonthForDate(value) {
  const date = new Date(value + 'T00:00:00Z');
  date.setUTCMonth(date.getUTCMonth() + 1, 1);
  return date.toISOString().slice(0, 7);
}

async function activeStaff(env, app, staffId) {
  if (!SAFE_ID.test(staffId)) return null;
  const row = await env.DB.prepare('SELECT data FROM staff WHERE app=? AND id=? LIMIT 1').bind(app, staffId).first();
  if (!row) return null;
  try {
    const data = JSON.parse(row.data || '{}');
    return data && !data.deleted ? data : null;
  } catch (error) { return null; }
}

async function rosterContext(env, app, studentId) {
  const row = await env.DB.prepare('SELECT data,updated_at FROM private_rosters WHERE app=? LIMIT 1').bind(app).first();
  if (!row) return null;
  try {
    const document = validateRosterDocument(JSON.parse(row.data));
    const index = document.roster.students.findIndex(student => student.id === studentId);
    return index < 0 ? null : { row, document, index, student: document.roster.students[index] };
  } catch (error) { return null; }
}

/** 화이트리스트 밖 필드는 조용히 버리고, 안에 있는 값만 형식을 검사해 정리한다 */
function sanitizeLessonChanges(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    const error = new Error('변경할 항목이 올바르지 않습니다'); error.status = 400; throw error;
  }
  const operation = REQUEST_OPERATIONS.has(String(raw.operation || '')) ? String(raw.operation) : 'lesson_fields';
  const out = operation === 'lesson_fields' ? {} : { operation };
  if (['teacher_assignment', 'withdrawal', 'leave', 'lesson_delete'].includes(operation)) {
    const effectiveDate = normalizeText(raw.effectiveDate);
    if (!validIsoDate(effectiveDate)) {
      const e = new Error(operation === 'teacher_assignment' ? '변경 시작일을 선택해 주세요' : '적용 날짜를 선택해 주세요');
      e.status = 400; throw e;
    }
    out.effectiveDate = effectiveDate;
    return out;
  }
  if (operation === 'information_request') {
    const informationRequest = normalizeText(raw.informationRequest);
    if (!informationRequest) { const e = new Error('변경 요청 내용을 자세히 입력해 주세요'); e.status = 400; throw e; }
    if (informationRequest.length > MAX_LESSON_TEXT) { const e = new Error('변경 요청 내용이 너무 깁니다'); e.status = 413; throw e; }
    out.informationRequest = informationRequest;
    return out;
  }
  for (const key of Object.keys(raw)) {
    if (!LESSON_CHANGE_FIELDS.includes(key)) continue;
    const value = raw[key];
    if (key === 'days') {
      if (!Array.isArray(value)) { const e = new Error('요일 형식을 확인해 주세요'); e.status = 400; throw e; }
      out.days = [...new Set(value.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b);
    } else if (key === 'time') {
      const text = normalizeText(value);
      if (text && !/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) {
        const e = new Error('시간 형식을 확인해 주세요 (예: 18:00)'); e.status = 400; throw e;
      }
      out.time = text;
    } else if (key === 'repeat') {
      const text = String(value || '');
      if (!REPEAT_VALUES.has(text)) { const e = new Error('반복 방식을 확인해 주세요'); e.status = 400; throw e; }
      out.repeat = text;
    } else if (key === 'target') {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) { const e = new Error('진행 수량을 확인해 주세요'); e.status = 400; throw e; }
      out.target = Math.floor(n);
    } else if (key === 'unit') {
      const text = normalizeText(value);
      if (text.length > MAX_UNIT) { const e = new Error('단위가 너무 깁니다'); e.status = 400; throw e; }
      out.unit = text;
    } else {
      const text = normalizeText(value);
      if (text.length > MAX_LESSON_TEXT) { const e = new Error('입력 내용이 너무 깁니다'); e.status = 400; throw e; }
      out[key] = text;
    }
  }
  if (!Object.keys(out).length) { const e = new Error('변경할 항목을 선택해 주세요'); e.status = 400; throw e; }
  if (out.repeat === 'days' && Array.isArray(out.days) && !out.days.length) {
    const e = new Error('요일 지정을 고르면 요일을 하나 이상 선택해야 합니다'); e.status = 400; throw e;
  }
  return out;
}

function canonicalChangesJson(changes) {
  const out = {};
  for (const key of Object.keys(changes).sort()) out[key] = changes[key];
  return JSON.stringify(out);
}

async function requestKeyForTask(taskId) {
  return 'lcr_' + (await sha256Hex(taskId)).slice(0, 48);
}

function view(row) {
  if (!row) return null;
  let changes = {};
  try { changes = JSON.parse(row.changes || '{}'); } catch (error) { changes = {}; }
  return {
    requestKey: row.request_key,
    taskId: row.task_id,
    owner: row.owner,
    changes,
    note: row.note == null ? '' : String(row.note),
    revision: Number(row.revision),
    status: row.status,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    reviewedAt: row.reviewed_at == null ? null : Number(row.reviewed_at),
    reviewNote: row.review_note == null ? '' : String(row.review_note)
  };
}

async function loadTask(env, app, taskId) {
  const row = await env.DB.prepare('SELECT owner, data FROM tasks WHERE app=? AND id=? LIMIT 1')
    .bind(app, taskId).first();
  if (!row) return null;
  let data;
  try { data = JSON.parse(row.data || '{}'); } catch (error) { data = null; }
  return { owner: row.owner, data };
}

export async function handleLessonChangeRequest(env, app, body, origin, auth, json) {
  if (app !== 'task') return json({ ok: false, error: '이 기능은 직원 앱에서만 사용할 수 있습니다' }, 400, origin);

  const action = String(body.action || 'submit');
  if (!['submit', 'cancel', 'list'].includes(action)) {
    return json({ ok: false, error: 'action은 submit, cancel 또는 list여야 합니다' }, 400, origin);
  }

  if (action === 'list') {
    if (auth.scope !== 'own') return json({ ok: false, error: '직원 본인의 요청만 확인할 수 있습니다' }, 403, origin);
    const limit = Math.max(1, Math.min(200, Number(body.limit) || 100));
    const result = await env.DB.prepare(
      "SELECT * FROM lesson_change_requests WHERE app=? AND owner=? ORDER BY CASE status " +
      "WHEN 'approval_waiting' THEN 0 WHEN 'rejected' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END, updated_at DESC LIMIT " + limit
    ).bind(app, auth.id).all();
    return json({ ok: true, requests: (result.results || []).map(view) }, 200, origin);
  }

  const taskId = String(body.taskId || '');
  if (!SAFE_ID.test(taskId)) return json({ ok: false, error: '올바른 taskId가 필요합니다' }, 400, origin);
  const task = await loadTask(env, app, taskId);
  if (!task || !task.data) return json({ ok: false, error: '지시서를 찾을 수 없습니다' }, 404, origin);
  if (task.data.deleted) return json({ ok: false, error: '삭제된 지시서에는 요청할 수 없습니다' }, 409, origin);
  if (!task.owner || !SAFE_ID.test(String(task.owner))) {
    return json({ ok: false, error: '담당자가 지정된 지시서만 요청할 수 있습니다' }, 409, origin);
  }
  if (auth.scope === 'own' && task.owner !== auth.id) {
    return json({ ok: false, error: '본인 지시서에만 변경을 요청할 수 있습니다' }, 403, origin);
  }

  const owner = String(task.owner);
  const requestKey = await requestKeyForTask(taskId);
  const now = Date.now();
  let current = await env.DB.prepare('SELECT * FROM lesson_change_requests WHERE app=? AND request_key=? LIMIT 1')
    .bind(app, requestKey).first();

  if (action === 'cancel') {
    if (!current) return json({ ok: false, error: '취소할 요청을 찾을 수 없습니다' }, 404, origin);
    if (current.status === 'cancelled') return json({ ok: true, idempotent: true, request: view(current) }, 200, origin);
    const result = await env.DB.prepare(
      "UPDATE lesson_change_requests SET status='cancelled', revision=revision+1, updated_at=?, " +
      'reviewed_at=NULL, reviewed_by=NULL, review_note=NULL WHERE app=? AND request_key=? AND revision=?'
    ).bind(now, app, requestKey, Number(current.revision)).run();
    if (Number(result && result.meta && result.meta.changes || 0) !== 1) {
      return json({ ok: false, error: '다른 변경이 먼저 저장되었습니다. 새로고침 후 다시 시도해 주세요' }, 409, origin);
    }
    current = await env.DB.prepare('SELECT * FROM lesson_change_requests WHERE app=? AND request_key=? LIMIT 1')
      .bind(app, requestKey).first();
    return json({ ok: true, idempotent: false, request: view(current) }, 200, origin);
  }

  let changes;
  try { changes = sanitizeLessonChanges(body.changes); }
  catch (error) { return json({ ok: false, error: String(error.message || error) }, error.status || 400, origin); }
  if ((changes.operation || 'lesson_fields') !== 'lesson_fields' && !SAFE_ID.test(String(task.data.studentId || ''))) {
    return json({ ok: false, error: '실제 원생의 stable studentId가 연결된 수업에서만 이 요청을 보낼 수 있습니다' }, 409, origin);
  }
  const note = normalizeText(body.note);
  if (note.length > MAX_NOTE) return json({ ok: false, error: '요청 사유는 ' + MAX_NOTE + '자까지 입력할 수 있습니다' }, 413, origin);
  const changesHash = await sha256Hex(canonicalChangesJson(changes));
  const changesJson = JSON.stringify(changes);

  if (!current) {
    const insertResult = await env.DB.prepare(
      'INSERT OR IGNORE INTO lesson_change_requests ' +
      '(app,request_key,task_id,owner,changes,changes_hash,note,revision,status,created_at,updated_at,reviewed_at,reviewed_by,review_note) ' +
      "VALUES (?,?,?,?,?,?,?,1,'approval_waiting',?,?,NULL,NULL,NULL)"
    ).bind(app, requestKey, taskId, owner, changesJson, changesHash, note, now, now).run();
    current = await env.DB.prepare('SELECT * FROM lesson_change_requests WHERE app=? AND request_key=? LIMIT 1')
      .bind(app, requestKey).first();
    if (!current) return json({ ok: false, error: '요청을 저장하지 못했습니다' }, 500, origin);
    if (current.changes_hash === changesHash && current.note === note) {
      return json({ ok: true, idempotent: Number(insertResult && insertResult.meta && insertResult.meta.changes || 0) !== 1, request: view(current) }, 200, origin);
    }
  }

  if (current.changes_hash === changesHash && current.note === note && current.status === 'rejected') {
    return json({
      ok: false, code: 'REQUEST_UNCHANGED',
      error: '반려 사유를 반영해 내용을 바꾼 뒤 다시 요청해 주세요',
      request: view(current)
    }, 409, origin);
  }
  if (current.changes_hash === changesHash && current.note === note && current.status !== 'cancelled') {
    return json({ ok: true, idempotent: true, request: view(current) }, 200, origin);
  }

  const result = await env.DB.prepare(
    "UPDATE lesson_change_requests SET owner=?, changes=?, changes_hash=?, note=?, revision=revision+1, " +
    "status='approval_waiting', updated_at=?, reviewed_at=NULL, reviewed_by=NULL, review_note=NULL " +
    'WHERE app=? AND request_key=? AND revision=?'
  ).bind(owner, changesJson, changesHash, note, now, app, requestKey, Number(current.revision)).run();
  if (Number(result && result.meta && result.meta.changes || 0) !== 1) {
    return json({ ok: false, error: '다른 변경이 먼저 저장되었습니다. 새로고침 후 다시 시도해 주세요' }, 409, origin);
  }
  current = await env.DB.prepare('SELECT * FROM lesson_change_requests WHERE app=? AND request_key=? LIMIT 1')
    .bind(app, requestKey).first();
  return json({ ok: true, idempotent: false, request: view(current) }, 200, origin);
}

export async function handleLessonChangeReview(env, app, body, origin, auth, json) {
  if (app !== 'task') return json({ ok: false, error: '이 기능은 직원 앱에서만 사용할 수 있습니다' }, 400, origin);
  if (auth.scope !== 'all') return json({ ok: false, error: '원장만 검토할 수 있습니다' }, 403, origin);

  const action = String(body.action || 'list');
  if (action === 'list') {
    const clauses = ['app=?'];
    const binds = [app];
    if (body.status != null && body.status !== '') {
      const status = String(body.status);
      if (!STATUSES.has(status)) return json({ ok: false, error: '올바른 status가 필요합니다' }, 400, origin);
      clauses.push('status=?'); binds.push(status);
    }
    if (body.owner != null && body.owner !== '') {
      const owner = String(body.owner);
      if (!SAFE_ID.test(owner)) return json({ ok: false, error: '올바른 owner가 필요합니다' }, 400, origin);
      clauses.push('owner=?'); binds.push(owner);
    }
    const limit = Math.max(1, Math.min(200, Number(body.limit) || 100));
    const result = await env.DB.prepare(
      'SELECT * FROM lesson_change_requests WHERE ' + clauses.join(' AND ') +
      " ORDER BY CASE status WHEN 'approval_waiting' THEN 0 WHEN 'rejected' THEN 1 " +
      "WHEN 'approved' THEN 2 ELSE 3 END, updated_at DESC LIMIT " + limit
    ).bind(...binds).all();
    return json({ ok: true, requests: (result.results || []).map(view) }, 200, origin);
  }

  if (action !== 'approve' && action !== 'reject') {
    return json({ ok: false, error: 'action은 list, approve 또는 reject여야 합니다' }, 400, origin);
  }
  const requestKey = String(body.requestKey || '');
  const expectedRevision = Number(body.revision);
  if (!SAFE_ID.test(requestKey) || !requestKey.startsWith('lcr_')) {
    return json({ ok: false, error: '올바른 requestKey가 필요합니다' }, 400, origin);
  }
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    return json({ ok: false, error: '현재 revision이 필요합니다' }, 400, origin);
  }
  let current = await env.DB.prepare('SELECT * FROM lesson_change_requests WHERE app=? AND request_key=? LIMIT 1')
    .bind(app, requestKey).first();
  if (!current) return json({ ok: false, error: '요청을 찾을 수 없습니다' }, 404, origin);
  if (Number(current.revision) !== expectedRevision) {
    return json({ ok: false, error: '요청 내용이 바뀌었습니다. 새로고침 후 다시 검토해 주세요' }, 409, origin);
  }
  if (current.status === 'cancelled') return json({ ok: false, error: '취소된 요청은 검토할 수 없습니다' }, 409, origin);

  const now = Date.now();
  const reviewedBy = auditActor(auth);
  if (action === 'approve') {
    if (current.status === 'approved') return json({ ok: true, idempotent: true, request: view(current) }, 200, origin);
    if (current.status !== 'approval_waiting') {
      return json({ ok: false, error: '다시 제출된 요청만 승인할 수 있습니다' }, 409, origin);
    }
    let changes;
    try { changes = JSON.parse(current.changes || '{}'); } catch (error) { changes = {}; }

    const taskRow = await env.DB.prepare('SELECT owner, data, updated_at FROM tasks WHERE app=? AND id=? LIMIT 1')
      .bind(app, current.task_id).first();
    if (!taskRow) return json({ ok: false, error: '지시서를 찾을 수 없습니다' }, 404, origin);
    let taskData;
    try { taskData = JSON.parse(taskRow.data || '{}'); } catch (error) { taskData = null; }
    if (!taskData || taskData.deleted) {
      return json({ ok: false, error: '삭제된 지시서는 반영할 수 없습니다' }, 409, origin);
    }
    const operation = REQUEST_OPERATIONS.has(String(changes.operation || '')) ? String(changes.operation) : 'lesson_fields';
    const studentId = String(taskData.studentId || '');
    if (operation !== 'lesson_fields' && !SAFE_ID.test(studentId)) {
      return json({ ok: false, error: 'stable studentId 연결을 확인한 뒤 승인해 주세요' }, 409, origin);
    }

    let targetStaff = null;
    if (operation === 'teacher_assignment') {
      const selectedStaffId = String(body.selectedStaffId || '');
      targetStaff = await activeStaff(env, app, selectedStaffId);
      if (!targetStaff) return json({ ok: false, error: '변경할 재직 선생님을 선택해 주세요' }, 400, origin);
      if (selectedStaffId === String(taskRow.owner)) {
        return json({ ok: false, error: '현재 담당자와 다른 선생님을 선택해 주세요' }, 409, origin);
      }
    }

    const statements = [];
    const requiredChangeIndexes = [];
    const actorRole = auth.role === 'manager' ? 'manager' : 'admin';
    let eventType = 'work_instruction';
    let changedFields = [];
    let details = {};
    let effectiveDate = changes.effectiveDate || null;
    let requiresAck = operation !== 'information_request' && operation !== 'lesson_delete';
    let audienceStaffIds = [String(taskRow.owner || '')];
    let roster = null;

    if (operation !== 'lesson_fields') {
      roster = await rosterContext(env, app, studentId);
      if (!roster) return json({ ok: false, error: '현재 원생 명단에서 학생을 찾을 수 없습니다' }, 409, origin);
      audienceStaffIds.push(...(roster.student.teacherIds || []));
    }

    if (operation === 'lesson_fields') {
      const patch = {};
      LESSON_CHANGE_FIELDS.forEach(key => { if (Object.prototype.hasOwnProperty.call(changes, key)) patch[key] = changes[key]; });
      changedFields = Object.keys(patch).filter(key => JSON.stringify(taskData[key] || '') !== JSON.stringify(patch[key] || ''));
      details = {
        before: Object.fromEntries(changedFields.map(key => [key, taskData[key] == null ? '' : taskData[key]])),
        after: Object.fromEntries(changedFields.map(key => [key, patch[key] == null ? '' : patch[key]]))
      };
      const updatedAt = Math.max(now, Number(taskRow.updated_at || 0) + 1);
      const merged = Object.assign({}, taskData, patch, { updatedAt, lastEditBy: actorRole });
      requiredChangeIndexes.push(statements.length);
      statements.push(env.DB.prepare(
        'UPDATE tasks SET data=?, updated_at=?, srv_at=? WHERE app=? AND id=? AND updated_at=?'
      ).bind(JSON.stringify(merged), updatedAt, updatedAt, app, current.task_id, taskRow.updated_at));
    } else if (operation === 'teacher_assignment') {
      eventType = 'teacher_assignment'; changedFields = ['teacherIds'];
      const selectedStaffId = String(body.selectedStaffId);
      audienceStaffIds.push(selectedStaffId);
      const previousStaff = await activeStaff(env, app, String(taskRow.owner || ''));
      details = {
        beforeStaffId: String(taskRow.owner || ''), beforeStaffName: previousStaff && previousStaff.name || '',
        afterStaffId: selectedStaffId, afterStaffName: String(targetStaff.name || '')
      };
      const updatedAt = Math.max(now, Number(taskRow.updated_at || 0) + 1);
      const merged = Object.assign({}, taskData, { staffId: selectedStaffId, updatedAt, lastEditBy: actorRole });
      requiredChangeIndexes.push(statements.length);
      statements.push(env.DB.prepare(
        'UPDATE tasks SET owner=?, data=?, updated_at=?, srv_at=? WHERE app=? AND id=? AND updated_at=?'
      ).bind(selectedStaffId, JSON.stringify(merged), updatedAt, updatedAt, app, current.task_id, taskRow.updated_at));

      const oldStaffId = String(taskRow.owner || '');
      const otherOldLesson = await env.DB.prepare(
        "SELECT id FROM tasks WHERE app=? AND id<>? AND owner=? AND json_valid(data) " +
        "AND json_extract(data,'$.studentId')=? AND COALESCE(json_extract(data,'$.deleted'),0)=0 LIMIT 1"
      ).bind(app, current.task_id, oldStaffId, studentId).first();
      if (!otherOldLesson) roster.student.teacherIds = roster.student.teacherIds.filter(id => id !== oldStaffId);
      if (!roster.student.teacherIds.includes(selectedStaffId)) roster.student.teacherIds.push(selectedStaffId);
      for (const assignment of roster.document.bookStudents) {
        if (assignment.studentId !== studentId) continue;
        if (!otherOldLesson) assignment.teacherIds = assignment.teacherIds.filter(id => id !== oldStaffId);
        if (!assignment.teacherIds.includes(selectedStaffId)) assignment.teacherIds.push(selectedStaffId);
      }
      const teacherNames = [];
      for (const teacherId of roster.student.teacherIds) {
        const teacher = await activeStaff(env, app, teacherId);
        if (teacher && teacher.name) teacherNames.push(String(teacher.name));
      }
      roster.student.teacher = teacherNames.join('·') || roster.student.teacher;
    } else if (operation === 'withdrawal' || operation === 'leave') {
      eventType = operation;
      changedFields = ['end', 'reason'];
      details = { effectiveDate, label: operation === 'withdrawal' ? '퇴원' : '휴원' };
      roster.student.end = nextMonthForDate(effectiveDate);
      roster.student.reason = (operation === 'withdrawal' ? '퇴원 ' : '휴원 ') + effectiveDate;
      const lessonRows = await env.DB.prepare(
        "SELECT id,owner,data,updated_at FROM tasks WHERE app=? AND json_valid(data) " +
        "AND json_extract(data,'$.studentId')=? AND COALESCE(json_extract(data,'$.deleted'),0)=0"
      ).bind(app, studentId).all();
      for (const row of lessonRows.results || []) {
        let data;
        try { data = JSON.parse(row.data || '{}'); } catch (error) { continue; }
        const updatedAt = Math.max(now, Number(row.updated_at || 0) + 1);
        data.end = effectiveDate; data.updatedAt = updatedAt; data.lastEditBy = actorRole;
        requiredChangeIndexes.push(statements.length);
        statements.push(env.DB.prepare(
          'UPDATE tasks SET data=?,updated_at=?,srv_at=? WHERE app=? AND id=? AND updated_at=?'
        ).bind(JSON.stringify(data), updatedAt, updatedAt, app, row.id, row.updated_at));
        audienceStaffIds.push(String(row.owner || ''));
      }
    } else if (operation === 'lesson_delete') {
      eventType = 'lesson_delete'; changedFields = ['deleted']; requiresAck = false;
      details = { effectiveDate };
      const updatedAt = Math.max(now, Number(taskRow.updated_at || 0) + 1);
      const merged = Object.assign({}, taskData, { deleted: true, end: effectiveDate, updatedAt, lastEditBy: actorRole });
      requiredChangeIndexes.push(statements.length);
      statements.push(env.DB.prepare(
        'UPDATE tasks SET data=?,updated_at=?,srv_at=? WHERE app=? AND id=? AND updated_at=?'
      ).bind(JSON.stringify(merged), updatedAt, updatedAt, app, current.task_id, taskRow.updated_at));
    } else {
      eventType = 'information_request'; changedFields = ['informationRequest']; requiresAck = false;
      details = { request: String(changes.informationRequest || ''), note: String(current.note || '') };
    }

    if (roster && ['teacher_assignment', 'withdrawal', 'leave'].includes(operation)) {
      roster.document.roster.updated = new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
      try { roster.document = validateRosterDocument(roster.document); }
      catch (error) { return json({ ok: false, error: String(error && error.message || error) }, 409, origin); }
      const rosterUpdatedAt = Math.max(now, Number(roster.row.updated_at || 0) + 1);
      requiredChangeIndexes.push(statements.length);
      statements.push(env.DB.prepare(
        'UPDATE private_rosters SET data=?,updated_at=? WHERE app=? AND updated_at=?'
      ).bind(JSON.stringify(roster.document), rosterUpdatedAt, app, roster.row.updated_at));
    }

    if (SAFE_ID.test(studentId)) {
      const eventId = await studentChangeEventId('lesson-request\n' + requestKey + '\n' + expectedRevision);
      statements.push(studentChangeEventStatement(env, app, {
        eventId, studentId, taskId: current.task_id, eventType, changedFields, details,
        audienceStaffIds, effectiveDate, requiresAck, requestKey, requestRevision: expectedRevision,
        changedAt: now, changedBy: studentChangeActorKey(auth)
      }));
    }
    const requestUpdateIndex = statements.length;
    statements.push(env.DB.prepare(
      "UPDATE lesson_change_requests SET status='approved', updated_at=?, reviewed_at=?, " +
      "reviewed_by=?, review_note=NULL WHERE app=? AND request_key=? AND revision=? AND status='approval_waiting'"
    ).bind(now, now, reviewedBy, app, requestKey, expectedRevision));

    const applied = await env.DB.batch(statements);
    const reqChanged = Number(applied[requestUpdateIndex] && applied[requestUpdateIndex].meta && applied[requestUpdateIndex].meta.changes || 0);
    const requiredChanged = requiredChangeIndexes.every(index => Number(applied[index] && applied[index].meta && applied[index].meta.changes || 0) === 1);
    if (!requiredChanged || reqChanged !== 1) {
      return json({ ok: false, error: '다른 변경이 먼저 저장되었습니다. 새로고침 후 다시 검토해 주세요' }, 409, origin);
    }
  } else {
    const note = normalizeText(body.note);
    if (!note) return json({ ok: false, error: '반려 사유를 입력해 주세요' }, 400, origin);
    if (note.length > MAX_REVIEW_NOTE) return json({ ok: false, error: '반려 사유는 ' + MAX_REVIEW_NOTE + '자까지 입력할 수 있습니다' }, 413, origin);
    if (current.status === 'rejected' && String(current.review_note || '') === note) {
      return json({ ok: true, idempotent: true, request: view(current) }, 200, origin);
    }
    const result = await env.DB.prepare(
      "UPDATE lesson_change_requests SET status='rejected', updated_at=?, reviewed_at=?, " +
      "reviewed_by=?, review_note=? WHERE app=? AND request_key=? AND revision=? AND status<>'cancelled'"
    ).bind(now, now, reviewedBy, note, app, requestKey, expectedRevision).run();
    if (Number(result && result.meta && result.meta.changes || 0) !== 1) {
      return json({ ok: false, error: '다른 변경이 먼저 저장되었습니다. 새로고침 후 다시 검토해 주세요' }, 409, origin);
    }
  }
  current = await env.DB.prepare('SELECT * FROM lesson_change_requests WHERE app=? AND request_key=? LIMIT 1')
    .bind(app, requestKey).first();
  return json({ ok: true, idempotent: false, request: view(current) }, 200, origin);
}
