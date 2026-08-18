/** consult 학생 인증사진·질문 제출함. 사진은 private R2, 권한·상태는 D1이 정본이다. */

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_JPEG_BYTES = 2 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_JPEG_BYTES + 64 * 1024;
const MAX_IMAGE_SIDE = 2000;
const MAX_IMAGE_PIXELS = 4_000_000;
const MAX_BODY_TEXT = 2000;
const MAX_ANSWER_TEXT = 5000;
const MAX_REVIEW_NOTE = 1000;
const MEDIA_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const STATUSES = new Set(['pending', 'approved', 'rejected', 'answered', 'cancelled']);

class PublicError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || '';
  }
}

function text(value) {
  return String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim();
}

function validDate(value) {
  const raw = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const date = new Date(raw + 'T00:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw;
}

function dayOfWeek(value) {
  return new Date(value + 'T00:00:00Z').getUTCDay();
}

function baseOccurrence(task, date) {
  if (!task || task.deleted || task.kind === 'mgoal' || task.kind === 'academic_event' ||
      task.kind === 'material_request' || (task.kind === 'material_response' && task.status !== 'provided')) return false;
  if (task.start && date < task.start) return false;
  if (task.end && date > task.end) return false;
  if (task.repeat === 'once') return date === task.start;
  if (task.repeat === 'daily') return true;
  if (task.repeat === 'weekday') {
    const day = dayOfWeek(date);
    return day >= 1 && day <= 5;
  }
  if (task.repeat === 'days') return Array.isArray(task.days) && task.days.map(Number).includes(dayOfWeek(date));
  return false;
}

async function requireOwnedOccurrence(env, owner, taskId, taskDate, requirePhotoEvidence, allowPerformanceQuestion = false) {
  if (!SAFE_ID.test(taskId) || !validDate(taskDate)) {
    throw new PublicError(400, '업무와 수행 날짜를 확인해 주세요');
  }
  const row = await env.DB.prepare('SELECT owner,data FROM tasks WHERE app=? AND id=? LIMIT 1')
    .bind('consult', taskId).first();
  let task;
  try { task = row ? JSON.parse(row.data || '{}') : null; } catch (error) { task = null; }
  if (!row || row.owner !== owner || !task || String(task.id || '') !== taskId || String(task.staffId || '') !== owner) {
    throw new PublicError(404, '본인의 업무를 찾을 수 없습니다');
  }
  if (task.deleted) throw new PublicError(404, '삭제된 업무에는 제출할 수 없습니다');
  if (requirePhotoEvidence && (task.evidenceMode !== 'photo' || task.origin === 'staff')) {
    throw new PublicError(403, '원장이 인증사진 제출을 지정한 업무만 제출할 수 있습니다');
  }
  if (allowPerformanceQuestion && task.origin !== 'staff' && task.kind === 'academic_event' && task.academicType === 'performance' &&
      String(task.dueDate || task.start || '') === taskDate) return;

  let moves = [];
  const moveRow = await env.DB.prepare('SELECT data FROM checks WHERE app=? AND k=? LIMIT 1')
    .bind('consult', '__weekmove__' + owner + '|all').first();
  try {
    const parsed = moveRow ? JSON.parse(moveRow.data || '{}') : null;
    moves = parsed && Array.isArray(parsed.moves) ? parsed.moves : [];
  } catch (error) { moves = []; }
  if (moves.some(move => move && move.taskId === taskId && move.to === taskDate &&
      validDate(String(move.from || '')) && baseOccurrence(task, String(move.from)))) return;
  if (moves.some(move => move && move.taskId === taskId && move.from === taskDate)) {
    throw new PublicError(409, '선택한 날짜에는 이 업무가 예정되어 있지 않습니다');
  }
  if (baseOccurrence(task, taskDate)) return;
  throw new PublicError(409, '선택한 날짜에는 이 업무가 예정되어 있지 않습니다');
}

function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    throw new PublicError(415, 'JPEG 사진만 올릴 수 있습니다');
  }
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  let dimensions = null;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) throw new PublicError(415, '손상된 JPEG 파일입니다');
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) throw new PublicError(415, '손상된 JPEG 파일입니다');
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) throw new PublicError(415, '손상된 JPEG 파일입니다');
    if (marker === 0xe1) throw new PublicError(415, '위치정보가 포함된 사진은 올릴 수 없습니다. 사진을 다시 저장한 뒤 올려 주세요');
    if (sof.has(marker)) {
      if (length < 7) throw new PublicError(415, '손상된 JPEG 파일입니다');
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      if (!width || !height || width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width * height > MAX_IMAGE_PIXELS) {
        throw new PublicError(413, '사진 크기는 2000px, 400만 화소 이하여야 합니다');
      }
      dimensions = { width, height };
    }
    offset += length;
  }
  if (dimensions) return dimensions;
  throw new PublicError(415, '사진 크기를 확인할 수 없는 JPEG 파일입니다');
}

function dto(row) {
  const expiresAt = row.media_expires_at == null ? null : Number(row.media_expires_at);
  return {
    id: row.submission_id,
    owner: row.owner,
    kind: row.kind,
    status: row.status,
    revision: Number(row.revision),
    hasImage: !!row.object_key && row.status !== 'cancelled' && (!expiresAt || expiresAt > Date.now()),
    taskId: row.task_id || '',
    taskDate: row.task_date || '',
    bodyText: row.body_text || '',
    answerText: row.answer_text || '',
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    reviewedAt: row.reviewed_at == null ? null : Number(row.reviewed_at),
    reviewedBy: row.reviewed_by || '',
    reviewNote: row.review_note || '',
    mediaExpiresAt: expiresAt
  };
}

function result(json, row, origin, extra) {
  return json(Object.assign({ ok: true, submission: dto(row) }, extra || {}), 200, origin);
}

function errorResponse(error, json, origin) {
  if (error instanceof PublicError) {
    const payload = { ok: false, error: error.message };
    if (error.code) payload.code = error.code;
    return json(payload, error.status, origin);
  }
  const message = String(error && error.message || error || '');
  if (/CONSULT_SUBMISSION_DAILY_LIMIT/.test(message)) {
    return json({ ok: false, code: 'CONSULT_SUBMISSION_DAILY_LIMIT', error: '하루에 제출할 수 있는 인증사진과 질문은 20건까지입니다' }, 429, origin);
  }
  if (/CONSULT_SUBMISSION_PENDING_LIMIT/.test(message)) {
    return json({ ok: false, code: 'CONSULT_SUBMISSION_PENDING_LIMIT', error: '검토를 기다리는 제출이 10건입니다. 처리된 뒤 다시 제출해 주세요' }, 429, origin);
  }
  if (/no such table.*consult_submissions/i.test(message)) {
    return json({ ok: false, code: 'CONSULT_SUBMISSIONS_NOT_READY', error: '인증사진과 질문 제출함을 준비하고 있습니다' }, 503, origin);
  }
  console.error('consult-submission', error && error.name || 'Error');
  return json({ ok: false, error: '제출함을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요' }, 500, origin);
}

async function byClientRequest(env, owner, clientRequestId) {
  return await env.DB.prepare('SELECT * FROM consult_submissions WHERE app=? AND owner=? AND client_request_id=? LIMIT 1')
    .bind('consult', owner, clientRequestId).first();
}

async function byId(env, id) {
  if (!SAFE_ID.test(id) || !id.startsWith('cs_')) throw new PublicError(400, '올바른 제출 ID가 필요합니다');
  return await env.DB.prepare('SELECT * FROM consult_submissions WHERE app=? AND submission_id=? LIMIT 1')
    .bind('consult', id).first();
}

function authorizeRow(row, auth) {
  if (!row || (auth.scope === 'own' && row.owner !== auth.id)) {
    throw new PublicError(404, '제출 내용을 찾을 수 없습니다');
  }
}

function validateClientRequestId(value) {
  const id = String(value || '');
  if (!SAFE_ID.test(id)) throw new PublicError(400, '올바른 clientRequestId가 필요합니다');
  return id;
}

function validateBodyText(value, required) {
  const bodyText = text(value);
  if (required && !bodyText) throw new PublicError(400, '질문 내용을 입력해 주세요');
  if (bodyText.length > MAX_BODY_TEXT) throw new PublicError(413, '내용은 ' + MAX_BODY_TEXT + '자까지 입력할 수 있습니다');
  return bodyText;
}

function sameSubmissionInput(row, fields) {
  return !!row && row.kind === fields.kind && (row.task_id || '') === (fields.taskId || '') &&
    (row.task_date || '') === (fields.taskDate || '') && (row.body_text || '') === fields.bodyText &&
    !!row.object_key === !!fields.hasImage;
}

async function validateOptionalOccurrence(env, owner, taskIdValue, taskDateValue) {
  const taskId = String(taskIdValue || '');
  const taskDate = String(taskDateValue || '');
  if (!taskId && !taskDate) return { taskId: null, taskDate: null };
  if (!taskId || !taskDate) throw new PublicError(400, '업무와 수행 날짜를 함께 입력해 주세요');
  await requireOwnedOccurrence(env, owner, taskId, taskDate, false, true);
  return { taskId, taskDate };
}

async function enforceQuota(env, owner, createdAt) {
  const counts = await env.DB.prepare(
    "SELECT SUM(CASE WHEN created_at>? THEN 1 ELSE 0 END) AS daily_count," +
    "SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending_count " +
    "FROM consult_submissions WHERE app='consult' AND owner=?"
  ).bind(createdAt - 86400000, owner).first();
  if (Number(counts && counts.daily_count || 0) >= 20) {
    throw new PublicError(429, '하루에 제출할 수 있는 인증사진과 질문은 20건까지입니다', 'CONSULT_SUBMISSION_DAILY_LIMIT');
  }
  if (Number(counts && counts.pending_count || 0) >= 10) {
    throw new PublicError(429, '검토를 기다리는 제출이 10건입니다. 처리된 뒤 다시 제출해 주세요', 'CONSULT_SUBMISSION_PENDING_LIMIT');
  }
}

async function insertSubmission(env, fields) {
  await env.DB.prepare(
    'INSERT OR IGNORE INTO consult_submissions ' +
    '(app,submission_id,client_request_id,owner,kind,task_id,task_date,body_text,object_key,media_bytes,media_expires_at,' +
    'status,answer_text,revision,created_at,updated_at,reviewed_at,reviewed_by,review_note) ' +
    "VALUES ('consult',?,?,?,?,?,?,?,?,?,?,'pending',NULL,1,?,?,NULL,NULL,NULL)"
  ).bind(fields.id, fields.clientRequestId, fields.owner, fields.kind, fields.taskId, fields.taskDate,
    fields.bodyText, fields.objectKey, fields.mediaBytes, fields.mediaExpiresAt, fields.createdAt, fields.createdAt).run();
  return await byClientRequest(env, fields.owner, fields.clientRequestId);
}

async function deleteMedia(env, objectKey) {
  if (!objectKey || !env.CONSULT_MEDIA) return;
  try { await env.CONSULT_MEDIA.delete(objectKey); } catch (error) { /* lifecycle이 최종 정리한다 */ }
}

function parseMultipartAuth(form) {
  try {
    const auth = JSON.parse(String(form.get('auth') || ''));
    return auth && typeof auth === 'object' && !Array.isArray(auth) ? auth : null;
  } catch (error) { return null; }
}

export async function handleConsultSubmissionUpload(request, env, origin, resolveAuth, json) {
  let objectKey = '';
  try {
    const contentType = String(request.headers.get('Content-Type') || '').toLowerCase();
    if (!contentType.startsWith('multipart/form-data;')) throw new PublicError(415, 'multipart/form-data 형식이 필요합니다');
    const contentLengthHeader = request.headers.get('Content-Length');
    const contentLength = Number(contentLengthHeader);
    if (!contentLengthHeader || !Number.isFinite(contentLength) || contentLength <= 0) {
      throw new PublicError(411, '사진 크기 정보가 필요합니다');
    }
    if (contentLength > MAX_MULTIPART_BYTES) {
      throw new PublicError(413, '사진은 2MB 이하로 올려 주세요');
    }
    let form;
    try { form = await request.formData(); }
    catch (error) { throw new PublicError(400, '업로드 본문을 읽을 수 없습니다'); }
    if (String(form.get('app') || '') !== 'consult') throw new PublicError(400, '이 기능은 컨설팅 앱에서만 사용할 수 있습니다');
    const auth = await resolveAuth(env, 'consult', parseMultipartAuth(form));
    if (!auth) throw new PublicError(401, '인증 실패');
    if (auth.scope !== 'own' || !SAFE_ID.test(String(auth.id || ''))) {
      throw new PublicError(403, '학생 본인만 사진을 제출할 수 있습니다');
    }

    const owner = String(auth.id);
    const kind = String(form.get('kind') || '');
    if (kind !== 'proof' && kind !== 'question') throw new PublicError(400, 'kind는 proof 또는 question이어야 합니다');
    const clientRequestId = validateClientRequestId(form.get('clientRequestId'));
    const bodyText = validateBodyText(form.get('bodyText'), false);
    const taskId = String(form.get('taskId') || '');
    const taskDate = String(form.get('taskDate') || '');
    const file = form.get('file');
    const hasFile = !!file && typeof file.arrayBuffer === 'function';
    const existing = await byClientRequest(env, owner, clientRequestId);
    if (existing) {
      if (!sameSubmissionInput(existing, { kind, taskId, taskDate, bodyText, hasImage: hasFile })) {
        throw new PublicError(409, '이미 사용한 clientRequestId의 제출 내용과 다릅니다');
      }
      return result(json, existing, origin, { idempotent: true });
    }

    let occurrence;
    if (kind === 'proof') {
      await requireOwnedOccurrence(env, owner, taskId, taskDate, true);
      occurrence = { taskId, taskDate };
      const active = await env.DB.prepare(
        "SELECT submission_id,status FROM consult_submissions WHERE app='consult' AND owner=? AND kind='proof' " +
        "AND task_id=? AND task_date=? AND status IN ('pending','approved') LIMIT 1"
      ).bind(owner, taskId, taskDate).first();
      if (active) throw new PublicError(409, active.status === 'approved' ? '이미 승인된 인증사진입니다' : '검토 중인 인증사진이 있습니다');
    } else {
      occurrence = await validateOptionalOccurrence(env, owner, taskId, taskDate);
    }

    if (!hasFile) {
      if (kind === 'proof') throw new PublicError(400, '인증사진을 선택해 주세요');
      if (!bodyText) throw new PublicError(400, '질문 내용이나 사진을 넣어 주세요');
      const textCreatedAt = Date.now();
      await enforceQuota(env, owner, textCreatedAt);
      const row = await insertSubmission(env, {
        id: 'cs_' + crypto.randomUUID().replace(/-/g, ''), clientRequestId, owner, kind,
        taskId: occurrence.taskId, taskDate: occurrence.taskDate, bodyText,
        objectKey: null, mediaBytes: null, mediaExpiresAt: null, createdAt: textCreatedAt
      });
      if (!row) throw new Error('question insert failed');
      if (!sameSubmissionInput(row, { kind, taskId, taskDate, bodyText, hasImage: false })) {
        throw new PublicError(409, '이미 사용한 clientRequestId의 제출 내용과 다릅니다');
      }
      return result(json, row, origin, { idempotent: false });
    }
    if (String(file.type || '').toLowerCase() !== 'image/jpeg') {
      throw new PublicError(415, 'JPEG 사진만 올릴 수 있습니다');
    }
    if (!Number(file.size)) throw new PublicError(413, '비어 있는 사진은 올릴 수 없습니다');
    if (Number(file.size) > MAX_JPEG_BYTES) throw new PublicError(413, '사진은 2MB 이하로 올려 주세요');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength !== Number(file.size)) throw new PublicError(415, '사진을 읽을 수 없습니다');
    jpegDimensions(bytes);
    if (!env.CONSULT_MEDIA) throw new PublicError(503, '사진 저장소를 준비하고 있습니다', 'CONSULT_MEDIA_NOT_READY');

    const createdAt = Date.now();
    await enforceQuota(env, owner, createdAt);
    const id = 'cs_' + crypto.randomUUID().replace(/-/g, '');
    objectKey = 'consult/' + crypto.randomUUID().replace(/-/g, '') + '.jpg';
    await env.CONSULT_MEDIA.put(objectKey, bytes, {
      httpMetadata: { contentType: 'image/jpeg', cacheControl: 'private, no-store' }
    });
    const row = await insertSubmission(env, {
      id, clientRequestId, owner, kind,
      taskId: occurrence.taskId, taskDate: occurrence.taskDate, bodyText,
      objectKey, mediaBytes: bytes.byteLength, mediaExpiresAt: createdAt + MEDIA_TTL_MS, createdAt
    });
    if (!row) {
      await deleteMedia(env, objectKey); objectKey = '';
      const conflict = kind === 'proof' && await env.DB.prepare(
        "SELECT submission_id FROM consult_submissions WHERE app='consult' AND owner=? AND kind='proof' " +
        "AND task_id=? AND task_date=? AND status IN ('pending','approved') LIMIT 1"
      ).bind(owner, occurrence.taskId, occurrence.taskDate).first();
      if (conflict) throw new PublicError(409, '같은 업무의 인증사진이 먼저 제출되었습니다');
      throw new Error('submission insert failed');
    }
    if (row.object_key !== objectKey) {
      await deleteMedia(env, objectKey); objectKey = '';
      if (!sameSubmissionInput(row, { kind, taskId, taskDate, bodyText, hasImage: true })) {
        throw new PublicError(409, '이미 사용한 clientRequestId의 제출 내용과 다릅니다');
      }
      return result(json, row, origin, { idempotent: true });
    }
    objectKey = '';
    return result(json, row, origin, { idempotent: false });
  } catch (error) {
    if (objectKey) await deleteMedia(env, objectKey);
    return errorResponse(error, json, origin);
  }
}

async function submitQuestion(env, body, origin, auth, json) {
  if (auth.scope !== 'own' || !SAFE_ID.test(String(auth.id || ''))) {
    throw new PublicError(403, '학생 본인만 질문을 제출할 수 있습니다');
  }
  const owner = String(auth.id);
  const clientRequestId = validateClientRequestId(body.clientRequestId);
  const bodyText = validateBodyText(body.bodyText, true);
  const taskId = String(body.taskId || '');
  const taskDate = String(body.taskDate || '');
  const existing = await byClientRequest(env, owner, clientRequestId);
  if (existing) {
    if (!sameSubmissionInput(existing, { kind: 'question', taskId, taskDate, bodyText, hasImage: false })) {
      throw new PublicError(409, '이미 사용한 clientRequestId의 제출 내용과 다릅니다');
    }
    return result(json, existing, origin, { idempotent: true });
  }
  const occurrence = await validateOptionalOccurrence(env, owner, taskId, taskDate);
  const createdAt = Date.now();
  await enforceQuota(env, owner, createdAt);
  const row = await insertSubmission(env, {
    id: 'cs_' + crypto.randomUUID().replace(/-/g, ''), clientRequestId, owner, kind: 'question',
    taskId: occurrence.taskId, taskDate: occurrence.taskDate, bodyText,
    objectKey: null, mediaBytes: null, mediaExpiresAt: null, createdAt
  });
  if (!row) throw new Error('question insert failed');
  if (!sameSubmissionInput(row, { kind: 'question', taskId, taskDate, bodyText, hasImage: false })) {
    throw new PublicError(409, '이미 사용한 clientRequestId의 제출 내용과 다릅니다');
  }
  return result(json, row, origin, { idempotent: row.client_request_id === clientRequestId && row.created_at !== createdAt });
}

async function listSubmissions(env, body, origin, auth, json) {
  const clauses = ["app='consult'"];
  const binds = [];
  if (auth.scope === 'own') { clauses.push('owner=?'); binds.push(auth.id); }
  else if (body.owner) {
    const owner = String(body.owner);
    if (!SAFE_ID.test(owner)) throw new PublicError(400, '올바른 owner가 필요합니다');
    clauses.push('owner=?'); binds.push(owner);
  }
  if (body.kind) {
    const kind = String(body.kind);
    if (kind !== 'proof' && kind !== 'question') throw new PublicError(400, '올바른 kind가 필요합니다');
    clauses.push('kind=?'); binds.push(kind);
  }
  if (body.status) {
    const status = String(body.status);
    if (!STATUSES.has(status)) throw new PublicError(400, '올바른 status가 필요합니다');
    clauses.push('status=?'); binds.push(status);
  }
  if (body.before != null && body.before !== '') {
    const before = Number(body.before);
    if (!Number.isFinite(before) || before <= 0) throw new PublicError(400, '올바른 before가 필요합니다');
    clauses.push('updated_at<?'); binds.push(before);
  }
  const limit = Math.max(1, Math.min(50, Math.floor(Number(body.limit) || 30)));
  const rows = await env.DB.prepare(
    'SELECT * FROM consult_submissions WHERE ' + clauses.join(' AND ') + ' ORDER BY updated_at DESC,submission_id DESC LIMIT ' + limit
  ).bind(...binds).all();
  const submissions = (rows.results || []).map(dto);
  return json({ ok: true, submissions, nextBefore: submissions.length === limit ? submissions[submissions.length - 1].updatedAt : null }, 200, origin);
}

async function readMedia(env, body, origin, auth) {
  const row = await byId(env, String(body.id || ''));
  authorizeRow(row, auth);
  if (row.status === 'cancelled') throw new PublicError(410, '취소된 제출의 사진은 볼 수 없습니다');
  if (!row.object_key) throw new PublicError(404, '첨부된 사진이 없습니다');
  if (Number(row.media_expires_at || 0) <= Date.now()) throw new PublicError(410, '사진 보관 기간이 끝났습니다');
  if (!env.CONSULT_MEDIA) throw new PublicError(503, '사진 저장소를 준비하고 있습니다', 'CONSULT_MEDIA_NOT_READY');
  const object = await env.CONSULT_MEDIA.get(row.object_key);
  if (!object) throw new PublicError(410, '사진 보관 기간이 끝났습니다');
  return new Response(object.body, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': origin || '*',
      'Cache-Control': 'private, no-store',
      'Content-Type': 'image/jpeg',
      'Content-Disposition': 'inline; filename="consult-image.jpg"',
      'Referrer-Policy': 'no-referrer',
      'Vary': 'Origin',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

async function changeStatus(env, body, origin, auth, json, action) {
  const row = await byId(env, String(body.id || ''));
  authorizeRow(row, auth);
  const revision = Number(body.revision);
  if (!Number.isInteger(revision) || revision < 1) throw new PublicError(400, '현재 revision이 필요합니다');

  if (action === 'cancel') {
    if (auth.scope !== 'own' || row.owner !== auth.id) throw new PublicError(403, '학생 본인의 제출만 취소할 수 있습니다');
  } else {
    if (auth.scope !== 'all') throw new PublicError(403, '원장만 검토할 수 있습니다');
    if (action === 'approve' && row.kind !== 'proof') throw new PublicError(409, '인증사진만 승인할 수 있습니다');
    if (action === 'answer' && row.kind !== 'question') throw new PublicError(409, '질문에만 답변할 수 있습니다');
  }

  const reviewNote = action === 'reject' ? text(body.reviewNote == null ? body.note : body.reviewNote) : '';
  if (action === 'reject' && !reviewNote) throw new PublicError(400, '반려 사유를 입력해 주세요');
  if (reviewNote.length > MAX_REVIEW_NOTE) throw new PublicError(413, '검토 메모는 ' + MAX_REVIEW_NOTE + '자까지 입력할 수 있습니다');
  const answerText = action === 'answer' ? text(body.answerText) : '';
  if (action === 'answer' && !answerText) throw new PublicError(400, '답변 내용을 입력해 주세요');
  if (answerText.length > MAX_ANSWER_TEXT) throw new PublicError(413, '답변은 ' + MAX_ANSWER_TEXT + '자까지 입력할 수 있습니다');
  const status = action === 'cancel' ? 'cancelled' : action === 'approve' ? 'approved' : action === 'answer' ? 'answered' : 'rejected';
  if (Number(row.revision) !== revision) throw new PublicError(409, '제출 내용이 바뀌었습니다. 새로고침 후 다시 시도해 주세요');
  if (row.status !== 'pending') throw new PublicError(409, '이미 처리된 제출입니다');

  const now = Math.max(Date.now(), Number(row.updated_at || 0) + 1);
  const reviewedBy = action === 'cancel' ? null : (auth.id ? String(auth.id) : 'director');
  const changed = await env.DB.prepare(
    'UPDATE consult_submissions SET status=?,answer_text=?,revision=revision+1,updated_at=?,reviewed_at=?,reviewed_by=?,review_note=? ' +
    "WHERE app='consult' AND submission_id=? AND revision=? AND status='pending'"
  ).bind(status, answerText || null, now, action === 'cancel' ? null : now, reviewedBy,
    reviewNote || null, row.submission_id, revision).run();
  if (Number(changed && changed.meta && changed.meta.changes || 0) !== 1) {
    throw new PublicError(409, '다른 처리가 먼저 저장되었습니다. 새로고침 후 다시 시도해 주세요');
  }
  const updated = await byId(env, row.submission_id);
  if (action === 'cancel') await deleteMedia(env, row.object_key);
  return result(json, updated, origin);
}

export async function handleConsultSubmission(env, app, body, origin, auth, json) {
  try {
    if (app !== 'consult') throw new PublicError(400, '이 기능은 컨설팅 앱에서만 사용할 수 있습니다');
    const action = String(body.action || '');
    if (action === 'submit_question') return await submitQuestion(env, body, origin, auth, json);
    if (action === 'list') return await listSubmissions(env, body, origin, auth, json);
    if (action === 'read_media') return await readMedia(env, body, origin, auth);
    if (action === 'cancel' || action === 'approve' || action === 'reject' || action === 'answer') {
      return await changeStatus(env, body, origin, auth, json, action);
    }
    throw new PublicError(400, '지원하지 않는 제출함 작업입니다');
  } catch (error) {
    return errorResponse(error, json, origin);
  }
}
