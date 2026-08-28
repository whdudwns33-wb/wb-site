const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_TITLE = 100;
const MAX_BODY = 2000;
const MAX_TARGETS = 100;
const PRIORITIES = new Set(['normal', 'important']);

function changes(result) {
  return Number(result && result.meta && result.meta.changes || 0);
}

function parsed(value, fallback) {
  try { return JSON.parse(String(value || '')); } catch (error) { return fallback; }
}

function cleanTitle(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return cleaned && cleaned.length <= MAX_TITLE ? cleaned : null;
}

function cleanBody(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.normalize('NFKC').replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return cleaned && cleaned.length <= MAX_BODY ? cleaned : null;
}

function kstDate(now = Date.now()) {
  return new Date(Number(now) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function actor(auth) {
  const id = String(auth && auth.id || '');
  return SAFE_ID.test(id) ? id : 'director';
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value || '')));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function receiptId(directiveId, revision, staffId, eventType) {
  return 'adre_' + (await sha256Hex([directiveId, revision, staffId, eventType].join('\u001f'))).slice(0, 52);
}

async function tablesReady(env) {
  const result = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN " +
    "('admin_directives','admin_directive_revisions','admin_directive_receipt_events')"
  ).all();
  return (result.results || []).length === 3;
}

async function activeStaff(env, app) {
  const result = await env.DB.prepare('SELECT id,data FROM staff WHERE app=? ORDER BY id').bind(app).all();
  const rows = [];
  for (const row of result.results || []) {
    try {
      const data = JSON.parse(row.data || '{}');
      const id = String(row.id || '');
      const name = String(data && data.name || '').normalize('NFKC').trim();
      if (SAFE_ID.test(id) && data && !data.deleted && !data.owner && name) rows.push({ id, name });
    } catch (error) { /* 손상된 직원 행은 대상에서 제외한다. */ }
  }
  return rows;
}

function receiptMap(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const key = [row.directive_id, row.revision, row.staff_id].join('\u001f');
    const item = map.get(key) || { openedAt: null, acknowledgedAt: null };
    if (row.event_type === 'opened') item.openedAt = Number(row.created_at || 0) || null;
    if (row.event_type === 'acknowledged') item.acknowledgedAt = Number(row.created_at || 0) || null;
    map.set(key, item);
  }
  return map;
}

function revisionView(row, staffNames, receipts, ownStaffId = '') {
  const audience = parsed(row.audience_staff_ids, []).map(String).filter(id => SAFE_ID.test(id));
  const statuses = audience.map(staffId => {
    const receipt = receipts.get([row.directive_id, row.revision, staffId].join('\u001f')) || {};
    return {
      staffId,
      staffName: staffNames.get(staffId) || '직원 확인 필요',
      openedAt: receipt.openedAt || null,
      acknowledgedAt: receipt.acknowledgedAt || null
    };
  });
  const own = ownStaffId ? statuses.find(item => item.staffId === ownStaffId) : null;
  const date = kstDate();
  const current = Number(row.revision) === Number(row.current_revision);
  const status = String(row.directive_status || 'active');
  let displayStatus = 'past';
  if (status === 'ended') displayStatus = 'ended';
  else if (!current) displayStatus = 'superseded';
  else if (String(row.starts_date) > date) displayStatus = 'scheduled';
  else if (row.expires_date && String(row.expires_date) < date) displayStatus = 'expired';
  else displayStatus = 'active';
  return {
    directiveId: String(row.directive_id), revision: Number(row.revision),
    currentRevision: Number(row.current_revision), isCurrent: current,
    directiveStatus: status, displayStatus,
    title: String(row.title), body: String(row.body), priority: String(row.priority),
    startsDate: String(row.starts_date), expiresDate: row.expires_date == null ? '' : String(row.expires_date),
    audienceStaffIds: audience, audienceStatus: statuses,
    openedAt: own && own.openedAt || null,
    acknowledgedAt: own && own.acknowledgedAt || null,
    createdAt: Number(row.revision_created_at), createdBy: String(row.revision_created_by),
    updatedAt: Number(row.directive_updated_at), endedAt: row.ended_at == null ? null : Number(row.ended_at)
  };
}

async function listRows(env, app, staffId = '') {
  const binds = [app];
  const ownClause = staffId
    ? ' AND EXISTS (SELECT 1 FROM json_each(revision.audience_staff_ids) target WHERE target.value=?)'
    : '';
  if (staffId) binds.push(staffId);
  const [revisionResult, receiptResult, staffRows] = await Promise.all([
    env.DB.prepare(
      'SELECT directive.status directive_status,directive.current_revision,directive.updated_at directive_updated_at,' +
      'directive.ended_at,revision.*,revision.created_at revision_created_at,revision.created_by revision_created_by ' +
      'FROM admin_directive_revisions revision JOIN admin_directives directive ' +
      'ON directive.app=revision.app AND directive.directive_id=revision.directive_id ' +
      'WHERE revision.app=?' + ownClause +
      ' ORDER BY revision.created_at DESC,revision.directive_id DESC,revision.revision DESC LIMIT 500'
    ).bind(...binds).all(),
    env.DB.prepare(
      'SELECT directive_id,revision,staff_id,event_type,created_at FROM admin_directive_receipt_events ' +
      'WHERE app=? ORDER BY created_at DESC LIMIT 5000'
    ).bind(app).all(),
    activeStaff(env, app)
  ]);
  const names = new Map(staffRows.map(item => [item.id, item.name]));
  const receipts = receiptMap(receiptResult.results || []);
  return (revisionResult.results || []).map(row => revisionView(row, names, receipts, staffId));
}

function sameRevision(row, input) {
  return row && String(row.title) === input.title && String(row.body) === input.body &&
    String(row.priority) === input.priority &&
    String(row.audience_staff_ids) === JSON.stringify(input.audienceStaffIds);
}

async function targetSnapshot(env, app, body) {
  const targetType = String(body.targetType || '');
  const staffIds = Array.isArray(body.staffIds) ? body.staffIds.map(value => String(value || '')) : null;
  if (!['all', 'staff'].includes(targetType) || !staffIds ||
      staffIds.some(id => !SAFE_ID.test(id)) || new Set(staffIds).size !== staffIds.length) return null;
  const staff = await activeStaff(env, app);
  const activeIds = new Set(staff.map(item => item.id));
  let audience;
  if (targetType === 'all') {
    if (staffIds.length) return null;
    audience = [...activeIds];
  } else {
    if (!staffIds.length || staffIds.length > MAX_TARGETS || staffIds.some(id => !activeIds.has(id))) return null;
    audience = staffIds.slice();
  }
  audience.sort();
  return audience.length && audience.length <= MAX_TARGETS ? audience : null;
}

async function list(env, app, body, origin, auth, json) {
  const manage = String(body.view || '') === 'manage';
  if (manage && auth.scope !== 'all') {
    return json({ ok: false, error: '원장·관리 담당만 전체 확인 현황을 볼 수 있습니다' }, 403, origin);
  }
  if (!manage && (!SAFE_ID.test(String(auth.id || '')))) {
    return json({ ok: false, error: '개인 직원 인증으로 다시 열어 주세요' }, 403, origin);
  }
  const revisions = await listRows(env, app, manage ? '' : String(auth.id));
  return json({ ok: true, revisions }, 200, origin);
}

async function save(env, app, body, origin, auth, json) {
  if (auth.scope !== 'all') return json({ ok: false, error: '원장·관리 담당만 요청을 전달할 수 있습니다' }, 403, origin);
  const directiveId = String(body.directiveId || '');
  const expectedRevision = Number(body.expectedRevision);
  const title = cleanTitle(body.title);
  const directiveBody = cleanBody(body.body);
  const priority = String(body.priority || '');
  const audienceStaffIds = await targetSnapshot(env, app, body);
  if (!SAFE_ID.test(directiveId) || !directiveId.startsWith('adr_') ||
      !Number.isInteger(expectedRevision) || expectedRevision < 0 || !title || !directiveBody ||
      !PRIORITIES.has(priority) || !audienceStaffIds) {
    return json({ ok: false, error: '요청 제목·내용·대상 선생님을 확인해 주세요' }, 400, origin);
  }
  const current = await env.DB.prepare(
    'SELECT * FROM admin_directives WHERE app=? AND directive_id=? LIMIT 1'
  ).bind(app, directiveId).first();
  const nextRevision = expectedRevision + 1;
  const now = Math.max(Date.now(), Number(current && current.updated_at || 0) + 1);
  const existingNext = current && Number(current.current_revision) === nextRevision
    ? await env.DB.prepare(
      'SELECT * FROM admin_directive_revisions WHERE app=? AND directive_id=? AND revision=? LIMIT 1'
    ).bind(app, directiveId, nextRevision).first() : null;
  // 실시간 요청은 예약 기간을 받지 않는다. 과거 schema는 호환을 위해 유지하되 새 revision은 서버 시각에 즉시 전달한다.
  const startsDate = existingNext ? String(existingNext.starts_date) : kstDate(now);
  const expiresDate = existingNext && existingNext.expires_date ? String(existingNext.expires_date) : '';
  const input = { title, body: directiveBody, priority, startsDate, expiresDate, audienceStaffIds };
  if (existingNext && sameRevision(existingNext, input)) {
    const rows = await listRows(env, app, '');
    return json({ ok: true, idempotent: true,
      revision: rows.find(row => row.directiveId === directiveId && row.revision === nextRevision) }, 200, origin);
  }
  if ((!current && expectedRevision !== 0) || current &&
      (String(current.status) !== 'active' || Number(current.current_revision) !== expectedRevision)) {
    return json({ ok: false, code: 'STALE_REVISION',
      error: '공통 요청이 다른 화면에서 변경되었습니다. 새로고침 후 다시 확인해 주세요' }, 409, origin);
  }
  const by = actor(auth);
  const audienceJson = JSON.stringify(audienceStaffIds);
  let results;
  if (!current) {
    results = await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO admin_directives(app,directive_id,status,current_revision,created_at,created_by," +
        "updated_at,updated_by,ended_at,ended_by) VALUES(?,?,'active',1,?,?,?,?,NULL,NULL)"
      ).bind(app, directiveId, now, by, now, by),
      env.DB.prepare(
        'INSERT OR IGNORE INTO admin_directive_revisions(app,directive_id,revision,title,body,priority,' +
        'starts_date,expires_date,audience_staff_ids,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
      ).bind(app, directiveId, 1, title, directiveBody, priority, startsDate, expiresDate || null,
        audienceJson, now, by)
    ]);
  } else {
    results = await env.DB.batch([
      env.DB.prepare(
        'INSERT OR IGNORE INTO admin_directive_revisions(app,directive_id,revision,title,body,priority,' +
        'starts_date,expires_date,audience_staff_ids,created_at,created_by) ' +
        "SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM admin_directives " +
        "WHERE app=? AND directive_id=? AND status='active' AND current_revision=?)"
      ).bind(app, directiveId, nextRevision, title, directiveBody, priority, startsDate,
        expiresDate || null, audienceJson, now, by, app, directiveId, expectedRevision),
      env.DB.prepare(
        "UPDATE admin_directives SET current_revision=?,updated_at=?,updated_by=? " +
        "WHERE app=? AND directive_id=? AND status='active' AND current_revision=?"
      ).bind(nextRevision, now, by, app, directiveId, expectedRevision)
    ]);
  }
  const saved = await env.DB.prepare(
    'SELECT revision.* FROM admin_directive_revisions revision JOIN admin_directives directive ' +
    'ON directive.app=revision.app AND directive.directive_id=revision.directive_id ' +
    'WHERE revision.app=? AND revision.directive_id=? AND revision.revision=directive.current_revision LIMIT 1'
  ).bind(app, directiveId).first();
  if (!saved || Number(saved.revision) !== nextRevision || !sameRevision(saved, input)) {
    return json({ ok: false, code: 'STALE_REVISION',
      error: '공통 요청이 다른 화면에서 변경되었습니다. 새로고침 후 다시 확인해 주세요' }, 409, origin);
  }
  const rows = await listRows(env, app, '');
  return json({ ok: true, idempotent: !results.some(result => changes(result) === 1),
    revision: rows.find(row => row.directiveId === directiveId && row.revision === nextRevision) }, 200, origin);
}

async function end(env, app, body, origin, auth, json) {
  if (auth.scope !== 'all') return json({ ok: false, error: '원장·관리 담당만 요청을 종료할 수 있습니다' }, 403, origin);
  const directiveId = String(body.directiveId || '');
  const expectedRevision = Number(body.expectedRevision);
  if (!SAFE_ID.test(directiveId) || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
    return json({ ok: false, error: '종료할 요청과 현재 버전을 확인해 주세요' }, 400, origin);
  }
  const current = await env.DB.prepare(
    'SELECT * FROM admin_directives WHERE app=? AND directive_id=? LIMIT 1'
  ).bind(app, directiveId).first();
  if (!current) return json({ ok: false, error: '공통 요청을 찾을 수 없습니다' }, 404, origin);
  if (String(current.status) === 'ended') return json({ ok: true, idempotent: true }, 200, origin);
  if (Number(current.current_revision) !== expectedRevision) {
    return json({ ok: false, code: 'STALE_REVISION', error: '요청이 이미 수정되었습니다. 새로고침해 주세요' }, 409, origin);
  }
  const now = Math.max(Date.now(), Number(current.updated_at || 0) + 1);
  const result = await env.DB.prepare(
    "UPDATE admin_directives SET status='ended',updated_at=?,updated_by=?,ended_at=?,ended_by=? " +
    "WHERE app=? AND directive_id=? AND status='active' AND current_revision=?"
  ).bind(now, actor(auth), now, actor(auth), app, directiveId, expectedRevision).run();
  if (changes(result) !== 1) return json({ ok: false, code: 'STALE_REVISION', error: '요청 상태가 변경되었습니다' }, 409, origin);
  return json({ ok: true, idempotent: false }, 200, origin);
}

async function receipt(env, app, body, origin, auth, json, eventType) {
  const staffId = String(auth.id || '');
  const directiveId = String(body.directiveId || '');
  const revision = Number(body.revision);
  if (!SAFE_ID.test(staffId) || !SAFE_ID.test(directiveId) || !Number.isInteger(revision) || revision < 1) {
    return json({ ok: false, error: '확인할 공통 요청을 다시 선택해 주세요' }, 400, origin);
  }
  const targeted = await env.DB.prepare(
    'SELECT 1 present FROM admin_directive_revisions revision WHERE revision.app=? ' +
    'AND revision.directive_id=? AND revision.revision=? AND EXISTS ' +
    '(SELECT 1 FROM json_each(revision.audience_staff_ids) target WHERE target.value=?) LIMIT 1'
  ).bind(app, directiveId, revision, staffId).first();
  if (!targeted) return json({ ok: false, error: '이 요청의 대상 선생님이 아닙니다' }, 403, origin);
  const now = Date.now();
  const types = eventType === 'acknowledged' ? ['opened', 'acknowledged'] : ['opened'];
  const statements = [];
  for (const type of types) {
    statements.push(env.DB.prepare(
      'INSERT OR IGNORE INTO admin_directive_receipt_events ' +
      '(app,receipt_event_id,directive_id,revision,staff_id,event_type,created_at) VALUES(?,?,?,?,?,?,?)'
    ).bind(app, await receiptId(directiveId, revision, staffId, type), directiveId, revision, staffId, type, now));
  }
  const results = await env.DB.batch(statements);
  return json({ ok: true, idempotent: results.every(result => changes(result) === 0) }, 200, origin);
}

export async function handleAdminDirective(env, app, body, origin, auth, json) {
  if (app !== 'task') return json({ ok: false, error: '공통 관리자 요청은 직원 앱에서만 사용할 수 있습니다' }, 400, origin);
  if (!await tablesReady(env)) return json({ ok: false, code: 'ADMIN_DIRECTIVES_NOT_READY',
    error: '공통 관리자 요청 기능을 준비하고 있습니다' }, 503, origin);
  const action = String(body.action || 'list');
  if (action === 'list') return list(env, app, body, origin, auth, json);
  if (action === 'save') return save(env, app, body, origin, auth, json);
  if (action === 'end') return end(env, app, body, origin, auth, json);
  if (action === 'opened') return receipt(env, app, body, origin, auth, json, 'opened');
  if (action === 'acknowledge') return receipt(env, app, body, origin, auth, json, 'acknowledged');
  return json({ ok: false, error: '지원하지 않는 공통 관리자 요청 작업입니다' }, 400, origin);
}
