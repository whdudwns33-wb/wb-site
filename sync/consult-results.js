/** consult 영어·수학 PDF 결과지. 원장만 등록·관리하고 파일은 private R2에 보관한다. */

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_RESULT_ID = /^crs_[a-f0-9]{32}$/;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_PDF_BYTES + 128 * 1024;
const SUBJECTS = new Set(['english', 'math']);

class PublicError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || '';
  }
}

function text(value, max) {
  return String(value == null ? '' : value).normalize('NFKC').replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
}

function validDate(value) {
  const raw = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return '';
  const date = new Date(raw + 'T00:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw ? raw : '';
}

function parseJson(value) {
  try { return JSON.parse(value || '{}'); } catch (error) { return null; }
}

async function activeStudent(env, owner) {
  if (!SAFE_ID.test(String(owner || ''))) return null;
  const row = await env.DB.prepare('SELECT id,data FROM staff WHERE app=? AND id=? LIMIT 1')
    .bind('consult', String(owner)).first();
  const data = row && parseJson(row.data);
  if (!row || !data || data.deleted || data.owner || data.manager || String(data.id || '') !== String(row.id) ||
      !text(data.name, 100)) return null;
  return { id: String(row.id), name: text(data.name, 100) };
}

function dto(row) {
  return {
    id: row.result_id,
    owner: row.owner,
    subject: row.subject,
    title: row.title,
    resultDate: row.result_date,
    mediaBytes: Number(row.media_bytes) || 0,
    status: row.status,
    revision: Number(row.revision) || 1,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0
  };
}

function responseError(error, json, origin) {
  if (error instanceof PublicError) {
    const body = { ok: false, error: error.message };
    if (error.code) body.code = error.code;
    return json(body, error.status, origin);
  }
  const message = String(error && error.message || error || '');
  if (/no such table.*consult_result_sheets/i.test(message)) {
    return json({ ok: false, code: 'CONSULT_RESULTS_NOT_READY', error: '결과지 기능을 준비하고 있습니다' }, 503, origin);
  }
  console.error('consult-results', error && error.name || 'Error');
  return json({ ok: false, error: '결과지를 처리하지 못했습니다. 잠시 후 다시 시도해 주세요' }, 500, origin);
}

function parseMultipartAuth(form) {
  try {
    const auth = JSON.parse(String(form.get('auth') || ''));
    return auth && typeof auth === 'object' && !Array.isArray(auth) ? auth : null;
  } catch (error) { return null; }
}

function includesAscii(bytes, ascii, from, to) {
  const pattern = new TextEncoder().encode(ascii);
  const start = Math.max(0, from || 0);
  const end = Math.min(bytes.length, to == null ? bytes.length : to);
  for (let i = start; i + pattern.length <= end; i++) {
    let same = true;
    for (let j = 0; j < pattern.length; j++) if (bytes[i + j] !== pattern[j]) { same = false; break; }
    if (same) return true;
  }
  return false;
}

function validatePdf(bytes) {
  if (!includesAscii(bytes, '%PDF-', 0, 1024) || !includesAscii(bytes, '%%EOF', Math.max(0, bytes.length - 4096))) {
    throw new PublicError(415, '올바른 PDF 파일만 올릴 수 있습니다');
  }
}

function actorId(auth) {
  return auth && auth.role === 'manager' && SAFE_ID.test(String(auth.id || '')) ? String(auth.id) : 'director';
}

async function deleteMedia(env, objectKey) {
  if (!objectKey || !env.CONSULT_MEDIA) return;
  try { await env.CONSULT_MEDIA.delete(objectKey); } catch (error) { /* 비공개 보관 상태로 남고 접근은 차단된다. */ }
}

export async function handleConsultResultUpload(request, env, origin, resolveAuth, json) {
  let objectKey = '';
  try {
    const contentType = String(request.headers.get('Content-Type') || '').toLowerCase();
    if (!contentType.startsWith('multipart/form-data;')) throw new PublicError(415, 'multipart/form-data 형식이 필요합니다');
    const contentLength = Number(request.headers.get('Content-Length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_MULTIPART_BYTES) {
      throw new PublicError(413, 'PDF는 10MB 이하로 올려 주세요');
    }
    let form;
    try { form = await request.formData(); } catch (error) { throw new PublicError(400, '업로드 본문을 읽을 수 없습니다'); }
    if (String(form.get('app') || '') !== 'consult') throw new PublicError(400, '컨설팅 앱에서만 사용할 수 있습니다');
    const auth = await resolveAuth(env, 'consult', parseMultipartAuth(form));
    if (!auth) throw new PublicError(401, '인증 실패');
    if (auth.scope !== 'all') throw new PublicError(403, '원장만 결과지를 올릴 수 있습니다');

    const student = await activeStudent(env, form.get('staffId'));
    if (!student) throw new PublicError(409, '현재 이용 중인 학생을 찾을 수 없습니다');
    const subject = String(form.get('subject') || '');
    if (!SUBJECTS.has(subject)) throw new PublicError(400, '과목은 영어 또는 수학을 선택해 주세요');
    const title = text(form.get('title'), 200);
    if (!title) throw new PublicError(400, '결과지 제목을 입력해 주세요');
    const resultDate = validDate(form.get('resultDate'));
    if (!resultDate) throw new PublicError(400, '결과 날짜를 확인해 주세요');
    const file = form.get('file');
    if (!file || typeof file.arrayBuffer !== 'function') throw new PublicError(400, 'PDF 파일을 선택해 주세요');
    if (!/\.pdf$/i.test(String(file.name || ''))) throw new PublicError(415, 'PDF 파일만 올릴 수 있습니다');
    if (!Number(file.size) || Number(file.size) > MAX_PDF_BYTES) throw new PublicError(413, 'PDF는 10MB 이하로 올려 주세요');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength !== Number(file.size)) throw new PublicError(415, 'PDF 파일을 읽을 수 없습니다');
    validatePdf(bytes);
    if (!env.CONSULT_MEDIA) throw new PublicError(503, '결과지 저장소를 준비하고 있습니다', 'CONSULT_MEDIA_NOT_READY');

    const now = Date.now();
    const id = 'crs_' + crypto.randomUUID().replace(/-/g, '');
    objectKey = 'consult-results/' + crypto.randomUUID().replace(/-/g, '') + '.pdf';
    await env.CONSULT_MEDIA.put(objectKey, bytes, {
      httpMetadata: { contentType: 'application/pdf', cacheControl: 'private, no-store' }
    });
    await env.DB.prepare(
      'INSERT INTO consult_result_sheets ' +
      '(app,result_id,owner,subject,title,result_date,object_key,media_bytes,status,revision,created_at,updated_at,uploaded_by) ' +
      "VALUES ('consult',?,?,?,?,?,?,?,'active',1,?,?,?)"
    ).bind(id, student.id, subject, title, resultDate, objectKey, bytes.byteLength, now, now, actorId(auth)).run();
    objectKey = '';
    const row = await env.DB.prepare('SELECT * FROM consult_result_sheets WHERE app=? AND result_id=? LIMIT 1')
      .bind('consult', id).first();
    return json({ ok: true, result: dto(row) }, 200, origin);
  } catch (error) {
    if (objectKey) await deleteMedia(env, objectKey);
    return responseError(error, json, origin);
  }
}

async function rowById(env, id) {
  if (!SAFE_RESULT_ID.test(String(id || ''))) throw new PublicError(400, '올바른 결과지 ID가 필요합니다');
  return await env.DB.prepare('SELECT * FROM consult_result_sheets WHERE app=? AND result_id=? LIMIT 1')
    .bind('consult', String(id)).first();
}

async function listResults(env, body, origin, auth, json) {
  if (auth.scope !== 'all') throw new PublicError(403, '원장만 결과지를 관리할 수 있습니다');
  const student = await activeStudent(env, body.staffId);
  if (!student) throw new PublicError(409, '현재 이용 중인 학생을 찾을 수 없습니다');
  const rows = await env.DB.prepare(
    "SELECT * FROM consult_result_sheets WHERE app='consult' AND owner=? AND status='active' " +
    'ORDER BY result_date DESC,created_at DESC LIMIT 100'
  ).bind(student.id).all();
  return json({ ok: true, results: (rows.results || []).map(dto) }, 200, origin);
}

async function readMedia(env, body, origin, auth) {
  if (auth.scope !== 'all') throw new PublicError(403, '원장만 이 결과지를 열 수 있습니다');
  const row = await rowById(env, body.id);
  if (!row || row.status !== 'active') throw new PublicError(404, '결과지를 찾을 수 없습니다');
  if (!env.CONSULT_MEDIA) throw new PublicError(503, '결과지 저장소를 준비하고 있습니다');
  const object = await env.CONSULT_MEDIA.get(row.object_key);
  if (!object) throw new PublicError(410, '결과지 파일을 찾을 수 없습니다');
  return new Response(object.body, { status: 200, headers: {
    'Access-Control-Allow-Origin': origin || '*',
    'Cache-Control': 'private, no-store',
    'Content-Type': 'application/pdf',
    'Content-Disposition': 'inline; filename="result.pdf"',
    'Content-Security-Policy': 'sandbox',
    'Referrer-Policy': 'no-referrer',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff'
  } });
}

async function archive(env, body, origin, auth, json) {
  if (auth.scope !== 'all') throw new PublicError(403, '원장만 결과지를 보관 처리할 수 있습니다');
  const row = await rowById(env, body.id);
  if (!row || row.status !== 'active') throw new PublicError(404, '결과지를 찾을 수 없습니다');
  const revision = Number(body.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new PublicError(400, '현재 revision을 확인해 주세요');
  if (Number(row.revision) !== revision) throw new PublicError(409, '결과지 목록이 바뀌었습니다. 새로고침해 주세요');
  const updatedAt = Math.max(Date.now(), Number(row.updated_at) + 1);
  const changed = await env.DB.prepare(
    "UPDATE consult_result_sheets SET status='archived',revision=revision+1,updated_at=? " +
    "WHERE app='consult' AND result_id=? AND status='active' AND revision=?"
  ).bind(updatedAt, row.result_id, revision).run();
  if (Number(changed && changed.meta && changed.meta.changes || 0) !== 1) {
    throw new PublicError(409, '다른 화면에서 먼저 변경했습니다. 새로고침해 주세요');
  }
  await deleteMedia(env, row.object_key);
  return json({ ok: true }, 200, origin);
}

export async function handleConsultResults(env, app, body, origin, auth, json) {
  try {
    if (app !== 'consult') throw new PublicError(400, '컨설팅 앱에서만 사용할 수 있습니다');
    const action = String(body.action || '');
    if (action === 'list') return await listResults(env, body, origin, auth, json);
    if (action === 'read_media') return await readMedia(env, body, origin, auth);
    if (action === 'archive') return await archive(env, body, origin, auth, json);
    throw new PublicError(400, '지원하지 않는 결과지 작업입니다');
  } catch (error) {
    return responseError(error, json, origin);
  }
}
