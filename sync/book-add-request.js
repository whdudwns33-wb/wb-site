/**
 * 교재 추가 신청 — 교재 DB(textbooks.json)는 저장소의 정적 파일이라 앱에서 직접
 * 못 고친다. 여기서는 그 자리를 메운다: 선생님이 "이 교재를 새로 추가해 주세요"를
 * 신청하면(request), 원장이 검토(review)해 승인해야 실제 교재 목록에 나타난다.
 * 원장이 직접 신청하면 검토 없이 바로 승인 상태로 등록된다 — 이미 전체 권한이 있으니
 * 스스로에게 검토를 또 요구하지 않는다.
 *
 * 승인된 항목은 textbooks.json을 고쳐 쓰지 않는다(정적 파일이라 배포 없이는 불가능).
 * 대신 승인된 신청 목록을 클라이언트가 별도로 읽어(list_approved) 화면에서 병합해
 * 보여준다 — 배포 없이 즉시 교재 목록에 나타나는 이유가 이것이다. 나중에 원장이
 * 원하면 이 목록을 textbooks.json에 정식으로 옮겨 적을 수 있다(선택 사항).
 *
 *   POST /book-add-request { app, auth, action:'submit'|'cancel'|'list'|'list_approved', title, subject, level, vendorName, units, note }
 *   POST /book-add-review  { app, auth(admin), action:'list'|'approve'|'reject', requestKey, revision, note }
 */

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_TITLE = 120;
const MAX_SUBJECT = 60;
const MAX_LEVEL = 40;
const MAX_VENDOR = 60;
const MAX_NOTE = 500;
const MAX_REVIEW_NOTE = 1000;
const MAX_UNITS = 12;
const MAX_UNIT_NAME = 80;
const MAX_SECTIONS = 30;
const MAX_SECTION_TEXT = 60;
const STATUSES = new Set(['approval_waiting', 'approved', 'rejected', 'cancelled']);

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value == null ? '' : value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeText(value) {
  return String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim();
}

function sanitizeUnits(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) { const e = new Error('목차 형식을 확인해 주세요'); e.status = 400; throw e; }
  if (raw.length > MAX_UNITS) { const e = new Error('단원은 ' + MAX_UNITS + '개까지 등록할 수 있습니다'); e.status = 400; throw e; }
  return raw.map(u => {
    if (!u || typeof u !== 'object') { const e = new Error('목차 형식을 확인해 주세요'); e.status = 400; throw e; }
    const name = normalizeText(u.name);
    if (name.length > MAX_UNIT_NAME) { const e = new Error('단원 이름이 너무 깁니다'); e.status = 400; throw e; }
    const sectionsRaw = Array.isArray(u.sections) ? u.sections : [];
    if (sectionsRaw.length > MAX_SECTIONS) { const e = new Error('소단원은 ' + MAX_SECTIONS + '개까지 등록할 수 있습니다'); e.status = 400; throw e; }
    const sections = sectionsRaw.map(s => normalizeText(s)).filter(Boolean);
    for (const s of sections) {
      if (s.length > MAX_SECTION_TEXT) { const e = new Error('소단원 이름이 너무 깁니다'); e.status = 400; throw e; }
    }
    return { name, sections };
  }).filter(u => u.name || u.sections.length);
}

function contentPayload(fields) {
  return { subject: fields.subject, level: fields.level, vendorName: fields.vendorName, units: fields.units, note: fields.note };
}

/** 신청자가 아니라 "교재명"으로만 키를 만든다 — 서로 다른 선생님이 같은 책을
 *  각자 다른 행으로 중복 신청하지 못하게 막고(신청자 불일치는 409), 한 책당
 *  하나의 canonical 행만 존재하게 한다. */
async function requestKeyFor(title) {
  const normalized = title.trim().toLowerCase();
  return 'bar_' + (await sha256Hex(normalized)).slice(0, 48);
}

function bookIdFor(requestKey) {
  return 'ADD' + requestKey.slice(4, 12).toUpperCase();
}

function view(row) {
  if (!row) return null;
  let units = [];
  try { units = JSON.parse(row.units || '[]'); } catch (error) { units = []; }
  return {
    requestKey: row.request_key,
    bookId: row.book_id,
    owner: row.owner,
    title: row.title,
    subject: row.subject == null ? '' : String(row.subject),
    level: row.level == null ? '' : String(row.level),
    vendorName: row.vendor_name == null ? '' : String(row.vendor_name),
    units,
    note: row.note == null ? '' : String(row.note),
    revision: Number(row.revision),
    status: row.status,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    reviewedAt: row.reviewed_at == null ? null : Number(row.reviewed_at),
    reviewNote: row.review_note == null ? '' : String(row.review_note)
  };
}

/** 교재 목록에 병합할 때 쓰는 축약 형태 — 승인된 것만, 검토 이력 없이 */
function approvedView(row) {
  const full = view(row);
  return {
    bookId: full.bookId, owner: full.owner, title: full.title, subject: full.subject,
    level: full.level, vendorName: full.vendorName, units: full.units, note: full.note,
    updatedAt: full.updatedAt
  };
}

export async function handleBookAddRequest(env, app, body, origin, auth, json) {
  if (app !== 'task') return json({ ok: false, error: '이 기능은 직원 앱에서만 사용할 수 있습니다' }, 400, origin);

  const action = String(body.action || 'submit');
  if (!['submit', 'cancel', 'list', 'list_approved'].includes(action)) {
    return json({ ok: false, error: 'action은 submit, cancel, list 또는 list_approved여야 합니다' }, 400, origin);
  }

  if (action === 'list_approved') {
    const limit = Math.max(1, Math.min(500, Number(body.limit) || 300));
    const result = await env.DB.prepare(
      "SELECT * FROM book_add_requests WHERE app=? AND status='approved' ORDER BY updated_at DESC LIMIT " + limit
    ).bind(app).all();
    return json({ ok: true, books: (result.results || []).map(approvedView) }, 200, origin);
  }

  if (action === 'list') {
    if (auth.scope !== 'own') return json({ ok: false, error: '직원 본인의 신청만 확인할 수 있습니다' }, 403, origin);
    const limit = Math.max(1, Math.min(200, Number(body.limit) || 100));
    const result = await env.DB.prepare(
      "SELECT * FROM book_add_requests WHERE app=? AND owner=? ORDER BY CASE status " +
      "WHEN 'approval_waiting' THEN 0 WHEN 'rejected' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END, updated_at DESC LIMIT " + limit
    ).bind(app, auth.id).all();
    return json({ ok: true, requests: (result.results || []).map(view) }, 200, origin);
  }

  const owner = auth.scope === 'all' ? 'director' : String(auth.id || '');
  if (!owner || !SAFE_ID.test(owner)) return json({ ok: false, error: '인증 정보를 확인할 수 없습니다' }, 401, origin);

  const title = normalizeText(body.title);
  if (!title) return json({ ok: false, error: '교재명을 입력해 주세요' }, 400, origin);
  if (title.length > MAX_TITLE) return json({ ok: false, error: '교재명은 ' + MAX_TITLE + '자까지 입력할 수 있습니다' }, 413, origin);
  const requestKey = await requestKeyFor(title);
  const bookId = bookIdFor(requestKey);
  const now = Date.now();
  let current = await env.DB.prepare('SELECT * FROM book_add_requests WHERE app=? AND request_key=? LIMIT 1')
    .bind(app, requestKey).first();

  if (action === 'cancel') {
    if (!current) return json({ ok: false, error: '취소할 신청을 찾을 수 없습니다' }, 404, origin);
    if (auth.scope === 'own' && current.owner !== owner) return json({ ok: false, error: '본인 신청만 취소할 수 있습니다' }, 403, origin);
    if (current.status === 'cancelled') return json({ ok: true, idempotent: true, request: view(current) }, 200, origin);
    const result = await env.DB.prepare(
      "UPDATE book_add_requests SET status='cancelled', revision=revision+1, updated_at=?, " +
      'reviewed_at=NULL, reviewed_by=NULL, review_note=NULL WHERE app=? AND request_key=? AND revision=?'
    ).bind(now, app, requestKey, Number(current.revision)).run();
    if (Number(result && result.meta && result.meta.changes || 0) !== 1) {
      return json({ ok: false, error: '다른 변경이 먼저 저장되었습니다. 새로고침 후 다시 시도해 주세요' }, 409, origin);
    }
    current = await env.DB.prepare('SELECT * FROM book_add_requests WHERE app=? AND request_key=? LIMIT 1')
      .bind(app, requestKey).first();
    return json({ ok: true, idempotent: false, request: view(current) }, 200, origin);
  }

  const subject = normalizeText(body.subject);
  if (subject.length > MAX_SUBJECT) return json({ ok: false, error: '과목은 ' + MAX_SUBJECT + '자까지 입력할 수 있습니다' }, 413, origin);
  const level = normalizeText(body.level);
  if (level.length > MAX_LEVEL) return json({ ok: false, error: '학년/레벨은 ' + MAX_LEVEL + '자까지 입력할 수 있습니다' }, 413, origin);
  const vendorName = normalizeText(body.vendorName);
  if (vendorName.length > MAX_VENDOR) return json({ ok: false, error: '거래처명은 ' + MAX_VENDOR + '자까지 입력할 수 있습니다' }, 413, origin);
  const note = normalizeText(body.note);
  if (note.length > MAX_NOTE) return json({ ok: false, error: '메모는 ' + MAX_NOTE + '자까지 입력할 수 있습니다' }, 413, origin);
  let units;
  try { units = sanitizeUnits(body.units); }
  catch (error) { return json({ ok: false, error: String(error.message || error) }, error.status || 400, origin); }

  const fields = { subject, level, vendorName, units, note };
  const unitsJson = JSON.stringify(units);
  const contentHash = await sha256Hex(JSON.stringify(contentPayload(fields)));
  // 원장이 직접 신청하면 검토를 거칠 필요가 없다 — 이미 전체 권한이 있다
  const autoApprove = auth.scope === 'all';
  const status = autoApprove ? 'approved' : 'approval_waiting';
  const reviewedAt = autoApprove ? now : null;
  const reviewedBy = autoApprove ? 'director' : null;

  if (!current) {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO book_add_requests ' +
      '(app,request_key,book_id,owner,title,subject,level,vendor_name,units,note,content_hash,revision,status,created_at,updated_at,reviewed_at,reviewed_by,review_note) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,NULL)'
    ).bind(app, requestKey, bookId, owner, title, subject, level, vendorName, unitsJson, note, contentHash, status, now, now, reviewedAt, reviewedBy).run();
    current = await env.DB.prepare('SELECT * FROM book_add_requests WHERE app=? AND request_key=? LIMIT 1')
      .bind(app, requestKey).first();
    if (!current) return json({ ok: false, error: '신청을 저장하지 못했습니다' }, 500, origin);
    return json({ ok: true, idempotent: false, request: view(current) }, 200, origin);
  }

  if (auth.scope === 'own' && current.owner !== owner) {
    return json({ ok: false, error: '다른 사람이 신청한 교재명입니다. 이름을 조금 다르게 적어 주세요' }, 409, origin);
  }
  if (current.content_hash === contentHash && current.status !== 'cancelled' && current.status !== 'rejected') {
    return json({ ok: true, idempotent: true, request: view(current) }, 200, origin);
  }

  const result = await env.DB.prepare(
    'UPDATE book_add_requests SET subject=?, level=?, vendor_name=?, units=?, note=?, content_hash=?, ' +
    "revision=revision+1, status=?, updated_at=?, reviewed_at=?, reviewed_by=?, review_note=NULL " +
    'WHERE app=? AND request_key=? AND revision=?'
  ).bind(subject, level, vendorName, unitsJson, note, contentHash, status, now, reviewedAt, reviewedBy, app, requestKey, Number(current.revision)).run();
  if (Number(result && result.meta && result.meta.changes || 0) !== 1) {
    return json({ ok: false, error: '다른 변경이 먼저 저장되었습니다. 새로고침 후 다시 시도해 주세요' }, 409, origin);
  }
  current = await env.DB.prepare('SELECT * FROM book_add_requests WHERE app=? AND request_key=? LIMIT 1')
    .bind(app, requestKey).first();
  return json({ ok: true, idempotent: false, request: view(current) }, 200, origin);
}

export async function handleBookAddReview(env, app, body, origin, auth, json) {
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
    const limit = Math.max(1, Math.min(200, Number(body.limit) || 100));
    const result = await env.DB.prepare(
      'SELECT * FROM book_add_requests WHERE ' + clauses.join(' AND ') +
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
  if (!SAFE_ID.test(requestKey) || !requestKey.startsWith('bar_')) {
    return json({ ok: false, error: '올바른 requestKey가 필요합니다' }, 400, origin);
  }
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    return json({ ok: false, error: '현재 revision이 필요합니다' }, 400, origin);
  }
  let current = await env.DB.prepare('SELECT * FROM book_add_requests WHERE app=? AND request_key=? LIMIT 1')
    .bind(app, requestKey).first();
  if (!current) return json({ ok: false, error: '신청을 찾을 수 없습니다' }, 404, origin);
  if (Number(current.revision) !== expectedRevision) {
    return json({ ok: false, error: '신청 내용이 바뀌었습니다. 새로고침 후 다시 검토해 주세요' }, 409, origin);
  }
  if (current.status === 'cancelled') return json({ ok: false, error: '취소된 신청은 검토할 수 없습니다' }, 409, origin);

  const now = Date.now();
  if (action === 'approve') {
    if (current.status === 'approved') return json({ ok: true, idempotent: true, request: view(current) }, 200, origin);
    if (current.status !== 'approval_waiting') {
      return json({ ok: false, error: '다시 제출된 신청만 승인할 수 있습니다' }, 409, origin);
    }
    const result = await env.DB.prepare(
      "UPDATE book_add_requests SET status='approved', updated_at=?, reviewed_at=?, " +
      "reviewed_by='director', review_note=NULL WHERE app=? AND request_key=? AND revision=? AND status='approval_waiting'"
    ).bind(now, now, app, requestKey, expectedRevision).run();
    if (Number(result && result.meta && result.meta.changes || 0) !== 1) {
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
      "UPDATE book_add_requests SET status='rejected', updated_at=?, reviewed_at=?, " +
      "reviewed_by='director', review_note=? WHERE app=? AND request_key=? AND revision=? AND status<>'cancelled'"
    ).bind(now, now, note, app, requestKey, expectedRevision).run();
    if (Number(result && result.meta && result.meta.changes || 0) !== 1) {
      return json({ ok: false, error: '다른 변경이 먼저 저장되었습니다. 새로고침 후 다시 검토해 주세요' }, 409, origin);
    }
  }
  current = await env.DB.prepare('SELECT * FROM book_add_requests WHERE app=? AND request_key=? LIMIT 1')
    .bind(app, requestKey).first();
  return json({ ok: true, idempotent: false, request: view(current) }, 200, origin);
}
