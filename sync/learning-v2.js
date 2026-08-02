/**
 * WB learning platform v2 API foundation.
 *
 * Integration from the existing Worker is intentionally one line and has no
 * side effects:
 *
 *   const response = await handleLearningV2Request(request, env, ctx);
 *   if (response) return response;
 *
 * A null response means that the request is not an /api/v2/learning route.
 * Provider webhooks and credential storage are deliberately not implemented.
 * Only normalized, manually reviewed integration candidates are accepted.
 */

const API_PREFIX = '/api/v2/learning';
const API_VERSION = '2026-08-03.1';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_PAGE_SIZE = 500;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;
const HASH_RE = /^[a-f0-9]{64}$/i;
const OPAQUE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9:._/#-]{0,255}$/;

const FORBIDDEN_INPUT_KEYS = new Set([
  'secret', 'password', 'apikey', 'apitoken', 'xapikey', 'accesskey', 'authorization',
  'token', 'authtoken', 'bearertoken', 'accesstoken', 'refreshtoken',
  'clientsecret', 'sessioncookie', 'authcookie', 'sessionid', 'privatekey', 'signingkey', 'webhooksecret',
  'passcode', 'pin', 'stem', 'solution', 'question',
  'credential', 'credentials',
  'rawpayload', 'rawhtml', 'questiontext', 'questioncontent',
  'problemtext', 'problemcontent', 'answer', 'answertext', 'answercontent'
]);

const PLANNER_TRANSITIONS = Object.freeze({
  planned: new Set(['available', 'cancelled']),
  available: new Set(['in_progress', 'submitted', 'completed', 'blocked', 'skipped', 'cancelled', 'expired']),
  in_progress: new Set(['submitted', 'completed', 'blocked', 'skipped', 'cancelled', 'expired']),
  submitted: new Set(['completed', 'in_progress', 'blocked', 'cancelled']),
  blocked: new Set(['available', 'in_progress', 'skipped', 'cancelled']),
  completed: new Set(['in_progress']),
  skipped: new Set(['available']),
  expired: new Set(['available']),
  cancelled: new Set([])
});

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(status, code, message, details) {
  throw new ApiError(status, code, message, details);
}

function json(data, status, headers) {
  const out = new Headers(headers || {});
  out.set('Content-Type', 'application/json;charset=utf-8');
  out.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { status: status || 200, headers: out });
}

function normalizeKey(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function assertNoSensitiveInput(value, path, seen) {
  if (value === null || value === undefined) return;
  if (typeof value !== 'object') return;
  if (!seen) seen = new Set();
  if (seen.has(value)) fail(400, 'cyclic_body', '순환 구조는 받을 수 없습니다');
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveInput(item, (path || '$') + '[' + index + ']', seen));
  } else {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_INPUT_KEYS.has(normalizeKey(key))) {
        fail(400, 'sensitive_field_rejected', '비밀값이나 원문 문제는 저장할 수 없습니다', {
          field: (path || '$') + '.' + key
        });
      }
      assertNoSensitiveInput(child, (path || '$') + '.' + key, seen);
    }
  }
  seen.delete(value);
}

async function readJson(request) {
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > MAX_BODY_BYTES) fail(413, 'body_too_large', '요청 본문이 너무 큽니다');
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    fail(413, 'body_too_large', '요청 본문이 너무 큽니다');
  }
  let body;
  try { body = text ? JSON.parse(text) : {}; }
  catch (error) { fail(400, 'invalid_json', 'JSON 본문을 읽을 수 없습니다'); }
  if (!body || Array.isArray(body) || typeof body !== 'object') {
    fail(400, 'invalid_body', 'JSON 객체가 필요합니다');
  }
  assertNoSensitiveInput(body, '$');
  return body;
}

function stringField(value, name, options) {
  const opts = options || {};
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (!text && opts.required) fail(400, 'missing_field', name + ' 값이 필요합니다', { field: name });
  if (text && opts.max && text.length > opts.max) {
    fail(400, 'field_too_long', name + ' 값이 너무 깁니다', { field: name, max: opts.max });
  }
  if (text && opts.pattern && !opts.pattern.test(text)) {
    fail(400, 'invalid_field', name + ' 형식이 올바르지 않습니다', { field: name });
  }
  return text;
}

function idField(value, name, required) {
  return stringField(value, name, { required: required !== false, max: 128, pattern: ID_RE });
}

function keyField(value, name, required) {
  return stringField(value, name, { required: required !== false, max: 128, pattern: KEY_RE });
}

function enumField(value, name, allowed, fallback) {
  const text = value === undefined || value === null || value === '' ? fallback : String(value);
  if (!allowed.includes(text)) fail(400, 'invalid_field', name + ' 값이 허용되지 않습니다', { field: name });
  return text;
}

function numberField(value, name, options) {
  const opts = options || {};
  if ((value === undefined || value === null || value === '') && !opts.required) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) fail(400, 'invalid_field', name + ' 값은 숫자여야 합니다', { field: name });
  if (opts.integer && !Number.isInteger(num)) fail(400, 'invalid_field', name + ' 값은 정수여야 합니다');
  if (opts.min !== undefined && num < opts.min) fail(400, 'invalid_field', name + ' 값이 너무 작습니다');
  if (opts.max !== undefined && num > opts.max) fail(400, 'invalid_field', name + ' 값이 너무 큽니다');
  return num;
}

function dateField(value, name, required) {
  return stringField(value, name, {
    required: required !== false,
    max: 10,
    pattern: /^\d{4}-\d{2}-\d{2}$/
  });
}

function jsonString(value, maxBytes) {
  const text = JSON.stringify(value === undefined ? {} : value);
  if (new TextEncoder().encode(text).byteLength > (maxBytes || 16 * 1024)) {
    fail(413, 'field_too_large', '구조화 데이터가 너무 큽니다');
  }
  return text;
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); }
  catch (error) { return fallback; }
}

function idempotencyKey(request) {
  return stringField(request.headers.get('Idempotency-Key'), 'Idempotency-Key', {
    required: true,
    max: 128,
    pattern: /^[A-Za-z0-9][A-Za-z0-9:._-]{7,127}$/
  });
}

function expectedRevision(request) {
  const raw = String(request.headers.get('If-Match') || '').replace(/^W\//, '').replace(/"/g, '').trim();
  if (!raw || !/^\d+$/.test(raw)) fail(428, 'revision_required', 'If-Match revision이 필요합니다');
  return Number(raw);
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function rows(result) {
  return result && Array.isArray(result.results) ? result.results : [];
}

async function dbAll(env, sql, bindings) {
  return rows(await env.DB.prepare(sql).bind(...(bindings || [])).all());
}

async function dbFirst(env, sql, bindings) {
  return await env.DB.prepare(sql).bind(...(bindings || [])).first();
}

async function defaultAuthenticate(request, env, now) {
  const header = String(request.headers.get('Authorization') || '');
  const match = header.match(/^Bearer\s+([^\s]+)$/i);
  if (!match) return null;
  const tokenHash = await sha256Hex(match[1]);
  const principal = await dbFirst(env,
    'SELECT s.tenant_id, s.principal_id, p.principal_type, p.display_name ' +
    'FROM lp_sessions s JOIN lp_principals p ON p.id=s.principal_id AND p.tenant_id=s.tenant_id ' +
    'WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? ' +
    "AND p.status='active'",
    [tokenHash, now]);
  if (!principal) return null;
  const grants = await dbAll(env,
    'SELECT rp.permission_code, rb.scope_type, rb.scope_id ' +
    'FROM lp_role_bindings rb JOIN lp_role_permissions rp ON rp.role_code=rb.role_code ' +
    'WHERE rb.tenant_id=? AND rb.principal_id=? ' +
    'AND (rb.valid_from IS NULL OR rb.valid_from<=?) ' +
    'AND (rb.valid_until IS NULL OR rb.valid_until>?)',
    [principal.tenant_id, principal.principal_id, now, now]);
  return {
    tenantId: principal.tenant_id,
    principalId: principal.principal_id,
    principalType: principal.principal_type,
    displayName: principal.display_name,
    grants: grants.map(grant => ({
      permission: grant.permission_code,
      scopeType: grant.scope_type,
      scopeId: grant.scope_id
    }))
  };
}

function grantMatches(grant, permission, scope) {
  if (grant.permission !== '*' && grant.permission !== permission) return false;
  if (grant.scopeType === 'tenant' && grant.scopeId === '*') return true;
  if (scope.studentId && grant.scopeType === 'student' && grant.scopeId === scope.studentId) return true;
  if (scope.programId && grant.scopeType === 'program' && grant.scopeId === scope.programId) return true;
  if (scope.campaignId && grant.scopeType === 'campaign' && grant.scopeId === scope.campaignId) return true;
  return false;
}

function hasPermission(actor, permission, scope) {
  return !!actor && (actor.grants || []).some(grant => grantMatches(grant, permission, scope || {}));
}

function requirePermission(actor, permission, scope) {
  if (!hasPermission(actor, permission, scope)) {
    fail(403, 'forbidden', '이 작업을 수행할 권한이 없습니다');
  }
}

function requireAnyPermission(actor, permissions, scope) {
  if (!permissions.some(permission => hasPermission(actor, permission, scope || {}))) {
    fail(403, 'forbidden', '이 작업을 수행할 권한이 없습니다');
  }
}

function allowedOrigin(request, env) {
  const origin = String(request.headers.get('Origin') || '');
  if (!origin) return '';
  const allowed = String(env.ALLOW_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean);
  if (!allowed.length || !allowed.includes(origin)) return null;
  return origin;
}

function responseHeaders(origin) {
  const headers = new Headers({ 'Vary': 'Origin' });
  if (origin) headers.set('Access-Control-Allow-Origin', origin);
  return headers;
}

function corsResponse(origin) {
  const headers = responseHeaders(origin);
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, If-Match');
  headers.set('Access-Control-Max-Age', '600');
  return new Response(null, { status: 204, headers });
}

function pageLimit(url) {
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Number(url.searchParams.get('limit')) || 100));
}

function requestId(request, makeId) {
  return stringField(request.headers.get('X-Request-Id'), 'X-Request-Id', {
    required: false,
    max: 128,
    pattern: ID_RE
  }) || makeId('req');
}

function changeStatement(env, tenantId, entityType, entityId, operation, revision, changedAt) {
  return env.DB.prepare(
    'INSERT INTO lp_change_feed(tenant_id,entity_type,entity_id,operation,revision,changed_at) VALUES(?,?,?,?,?,?)'
  ).bind(tenantId, entityType, entityId, operation, revision, changedAt);
}

function auditStatement(env, actor, action, entityType, entityId, reqId, occurredAt, metadata) {
  return env.DB.prepare(
    'INSERT INTO lp_audit_events(id,tenant_id,actor_id,action,entity_type,entity_id,request_id,' +
    'before_hash,after_hash,metadata_json,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
  ).bind(
    metadata.auditId,
    actor.tenantId,
    actor.principalId || null,
    action,
    entityType,
    entityId,
    reqId,
    metadata.beforeHash || null,
    metadata.afterHash || null,
    jsonString(metadata.publicMetadata || {}, 2048),
    occurredAt
  );
}

async function ensureStudent(env, actor, studentId) {
  const row = await dbFirst(env,
    "SELECT id FROM lp_principals WHERE id=? AND tenant_id=? AND principal_type='student' AND status='active'",
    [studentId, actor.tenantId]);
  if (!row) fail(404, 'student_not_found', '학생을 찾을 수 없습니다');
}

async function findByIdempotency(env, table, tenantId, key) {
  return await dbFirst(env, 'SELECT * FROM ' + table + ' WHERE tenant_id=? AND idempotency_key=?', [tenantId, key]);
}

function providerView(row) {
  return {
    id: row.id,
    providerKey: row.provider_key,
    displayName: row.display_name,
    adapterVersion: row.adapter_version,
    capabilities: parseJson(row.capabilities_json, {}),
    status: row.status,
    revision: row.revision
  };
}

function programView(row) {
  return {
    id: row.id,
    studentId: row.student_id,
    providerId: row.provider_id,
    programCode: row.program_code,
    levelCode: row.level_code,
    status: row.status,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    settings: parseJson(row.settings_json, {}),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function plannerView(row) {
  return {
    id: row.id,
    studentId: row.student_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceVersion: row.source_version,
    title: row.title,
    detail: row.detail,
    priority: row.priority,
    status: row.status,
    availableAt: row.available_at,
    dueAt: row.due_at,
    timezone: row.timezone,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function occurrenceView(row) {
  return {
    id: row.id,
    studentId: row.student_id,
    studentProgramId: row.student_program_id,
    templateVersionId: row.template_version_id,
    cycleKey: row.cycle_key,
    scheduledFor: row.scheduled_for,
    windowOpensAt: row.window_opens_at,
    windowClosesAt: row.window_closes_at,
    dueAt: row.due_at,
    status: row.status,
    revision: row.revision
  };
}

async function listProviders(context) {
  requirePermission(context.actor, 'provider.read');
  const result = await dbAll(context.env,
    "SELECT * FROM lp_provider_registry WHERE status<>'disabled' ORDER BY display_name", []);
  return { items: result.map(providerView) };
}

async function listPrograms(context) {
  const studentId = idField(context.url.searchParams.get('studentId'), 'studentId');
  requirePermission(context.actor, 'program.read', { studentId });
  const result = await dbAll(context.env,
    'SELECT * FROM lp_student_programs WHERE tenant_id=? AND student_id=? AND deleted_at IS NULL ' +
    'ORDER BY created_at DESC LIMIT ?',
    [context.actor.tenantId, studentId, pageLimit(context.url)]);
  return { items: result.map(programView) };
}

async function createProgram(context) {
  const body = await readJson(context.request);
  const studentId = idField(body.studentId, 'studentId');
  requirePermission(context.actor, 'program.write', { studentId });
  await ensureStudent(context.env, context.actor, studentId);
  const providerKey = keyField(body.providerKey, 'providerKey');
  const provider = await dbFirst(context.env,
    "SELECT id FROM lp_provider_registry WHERE provider_key=? AND status<>'disabled'", [providerKey]);
  if (!provider) fail(404, 'provider_not_found', '프로그램 공급사를 찾을 수 없습니다');
  const key = idempotencyKey(context.request);
  const existing = await findByIdempotency(context.env, 'lp_student_programs', context.actor.tenantId, key);
  if (existing) return { status: 200, body: { item: programView(existing), replayed: true } };

  const externalHash = stringField(body.externalSubjectHash, 'externalSubjectHash', {
    required: false, max: 64, pattern: HASH_RE
  }) || null;
  const item = {
    id: context.makeId('program'),
    studentId,
    providerId: provider.id,
    programCode: keyField(body.programCode, 'programCode'),
    levelCode: stringField(body.levelCode, 'levelCode', { required: false, max: 64 }) || null,
    status: enumField(body.status, 'status', ['candidate', 'planned', 'active', 'paused'], 'candidate'),
    startsOn: body.startsOn ? dateField(body.startsOn, 'startsOn') : null,
    endsOn: body.endsOn ? dateField(body.endsOn, 'endsOn') : null,
    settings: body.settings || {},
    revision: 1,
    createdAt: context.now,
    updatedAt: context.now
  };
  if (item.startsOn && item.endsOn && item.endsOn < item.startsOn) {
    fail(400, 'invalid_date_range', '종료일은 시작일 이후여야 합니다');
  }
  // settings는 저장 직전에도 재귀 검사해 이후 호출 경로가 추가돼도 비밀값이 DB에 닿지 않게 한다.
  assertNoSensitiveInput(item.settings, '$.settings');
  const afterHash = await sha256Hex(JSON.stringify(item));
  await context.env.DB.batch([
    context.env.DB.prepare(
      'INSERT INTO lp_student_programs(id,tenant_id,student_id,provider_id,program_code,' +
      'external_subject_hash,level_code,status,starts_on,ends_on,settings_json,idempotency_key,' +
      'revision,created_at,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)'
    ).bind(
      item.id, context.actor.tenantId, studentId, item.providerId, item.programCode,
      externalHash, item.levelCode, item.status, item.startsOn, item.endsOn,
      jsonString(item.settings), key, 1, context.now, context.now
    ),
    changeStatement(context.env, context.actor.tenantId, 'student_program', item.id, 'upsert', 1, context.now),
    auditStatement(context.env, context.actor, 'student_program.create', 'student_program', item.id,
      context.requestId, context.now, {
        auditId: context.makeId('audit'), afterHash, publicMetadata: { providerKey, programCode: item.programCode }
      })
  ]);
  return { status: 201, body: { item } };
}

async function listPlannerItems(context) {
  const studentId = idField(context.url.searchParams.get('studentId'), 'studentId');
  requirePermission(context.actor, 'planner.read', { studentId });
  const after = Math.max(0, Number(context.url.searchParams.get('after')) || 0);
  const result = await dbAll(context.env,
    'SELECT * FROM lp_planner_items WHERE tenant_id=? AND student_id=? AND deleted_at IS NULL ' +
    'AND (?=0 OR COALESCE(due_at,created_at)>=?) ORDER BY COALESCE(due_at,created_at),id LIMIT ?',
    [context.actor.tenantId, studentId, after, after, pageLimit(context.url)]);
  return { items: result.map(plannerView) };
}

async function createPlannerItem(context) {
  const body = await readJson(context.request);
  const studentId = idField(body.studentId, 'studentId');
  requirePermission(context.actor, 'planner.write', { studentId });
  await ensureStudent(context.env, context.actor, studentId);
  const key = idempotencyKey(context.request);
  const existing = await findByIdempotency(context.env, 'lp_planner_items', context.actor.tenantId, key);
  if (existing) return { status: 200, body: { item: plannerView(existing), replayed: true } };
  const item = {
    id: context.makeId('planner'),
    studentId,
    sourceType: enumField(body.sourceType, 'sourceType',
      ['manual', 'assessment', 'prep_campaign', 'twin_problem', 'legacy'], 'manual'),
    sourceId: body.sourceId ? idField(body.sourceId, 'sourceId') : null,
    sourceVersion: body.sourceVersion === undefined ? null : numberField(body.sourceVersion, 'sourceVersion', {
      required: true, integer: true, min: 1
    }),
    title: stringField(body.title, 'title', { required: true, max: 160 }),
    detail: stringField(body.detail, 'detail', { required: false, max: 1200 }) || null,
    priority: enumField(body.priority, 'priority', ['low', 'normal', 'high'], 'normal'),
    status: enumField(body.status, 'status', ['planned', 'available'], 'planned'),
    availableAt: body.availableAt === undefined ? null : numberField(body.availableAt, 'availableAt', {
      required: true, integer: true, min: 0
    }),
    dueAt: body.dueAt === undefined ? null : numberField(body.dueAt, 'dueAt', {
      required: true, integer: true, min: 0
    }),
    timezone: stringField(body.timezone || 'Asia/Seoul', 'timezone', { required: true, max: 64 }),
    revision: 1,
    createdAt: context.now,
    updatedAt: context.now
  };
  if (item.availableAt !== null && item.dueAt !== null && item.dueAt < item.availableAt) {
    fail(400, 'invalid_date_range', '마감 시각은 공개 시각 이후여야 합니다');
  }
  const afterHash = await sha256Hex(JSON.stringify(item));
  await context.env.DB.batch([
    context.env.DB.prepare(
      'INSERT INTO lp_planner_items(id,tenant_id,student_id,source_type,source_id,source_version,' +
      'title,detail,priority,status,available_at,due_at,timezone,idempotency_key,revision,created_by,' +
      'created_at,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)'
    ).bind(
      item.id, context.actor.tenantId, studentId, item.sourceType, item.sourceId, item.sourceVersion,
      item.title, item.detail, item.priority, item.status, item.availableAt, item.dueAt, item.timezone,
      key, 1, context.actor.principalId || null, context.now, context.now
    ),
    changeStatement(context.env, context.actor.tenantId, 'planner_item', item.id, 'upsert', 1, context.now),
    auditStatement(context.env, context.actor, 'planner_item.create', 'planner_item', item.id,
      context.requestId, context.now, {
        auditId: context.makeId('audit'), afterHash, publicMetadata: { sourceType: item.sourceType }
      })
  ]);
  return { status: 201, body: { item } };
}

async function transitionPlannerItem(context, itemId) {
  const body = await readJson(context.request);
  const key = idempotencyKey(context.request);
  const item = await dbFirst(context.env,
    'SELECT * FROM lp_planner_items WHERE id=? AND tenant_id=? AND deleted_at IS NULL',
    [itemId, context.actor.tenantId]);
  if (!item) fail(404, 'planner_item_not_found', '플래너 항목을 찾을 수 없습니다');
  requirePermission(context.actor, 'planner.write', { studentId: item.student_id });
  const replay = await dbFirst(context.env,
    'SELECT id FROM lp_planner_transitions WHERE planner_item_id=? AND idempotency_key=?', [itemId, key]);
  if (replay) {
    const current = await dbFirst(context.env, 'SELECT * FROM lp_planner_items WHERE id=?', [itemId]);
    return { status: 200, body: { item: plannerView(current), replayed: true } };
  }
  const expected = expectedRevision(context.request);
  if (Number(item.revision) !== expected) {
    fail(409, 'revision_conflict', '다른 기기에서 먼저 수정했습니다', { currentRevision: item.revision });
  }
  const nextStatus = enumField(body.toStatus, 'toStatus', Object.keys(PLANNER_TRANSITIONS));
  if (!PLANNER_TRANSITIONS[item.status] || !PLANNER_TRANSITIONS[item.status].has(nextStatus)) {
    fail(409, 'invalid_transition', item.status + ' 상태에서 ' + nextStatus + '(으)로 바꿀 수 없습니다');
  }
  const nextRevision = expected + 1;
  const transitionId = context.makeId('transition');
  const auditId = context.makeId('audit');
  const reasonCode = stringField(body.reasonCode, 'reasonCode', { required: false, max: 64 }) || null;
  const batch = await context.env.DB.batch([
    context.env.DB.prepare(
      'UPDATE lp_planner_items SET status=?,revision=?,updated_at=? ' +
      'WHERE id=? AND tenant_id=? AND revision=? AND status=?'
    ).bind(nextStatus, nextRevision, context.now, itemId, context.actor.tenantId, expected, item.status),
    context.env.DB.prepare(
      'INSERT INTO lp_planner_transitions(id,tenant_id,planner_item_id,from_status,to_status,' +
      'actor_type,actor_id,reason_code,metadata_json,idempotency_key,occurred_at) ' +
      'SELECT ?,tenant_id,id,?,?,\'user\',?,?,\'{}\',?,? FROM lp_planner_items ' +
      'WHERE id=? AND tenant_id=? AND revision=? AND status=?'
    ).bind(
      transitionId, item.status, nextStatus, context.actor.principalId || null, reasonCode,
      key, context.now, itemId, context.actor.tenantId, nextRevision, nextStatus
    ),
    context.env.DB.prepare(
      "INSERT INTO lp_change_feed(tenant_id,entity_type,entity_id,operation,revision,changed_at) " +
      "SELECT tenant_id,'planner_item',id,'upsert',revision,? FROM lp_planner_items " +
      'WHERE id=? AND tenant_id=? AND revision=? AND status=?'
    ).bind(context.now, itemId, context.actor.tenantId, nextRevision, nextStatus),
    context.env.DB.prepare(
      'INSERT INTO lp_audit_events(id,tenant_id,actor_id,action,entity_type,entity_id,request_id,' +
      'before_hash,after_hash,metadata_json,occurred_at) ' +
      "SELECT ?,tenant_id,?,'planner_item.transition','planner_item',id,?,NULL,NULL,?,? " +
      'FROM lp_planner_items WHERE id=? AND tenant_id=? AND revision=? AND status=?'
    ).bind(
      auditId, context.actor.principalId || null, context.requestId,
      jsonString({ fromStatus: item.status, toStatus: nextStatus, reasonCode }, 1024), context.now,
      itemId, context.actor.tenantId, nextRevision, nextStatus
    )
  ]);
  const changes = batch && batch[0] && batch[0].meta ? Number(batch[0].meta.changes || 0) : 1;
  if (!changes) fail(409, 'revision_conflict', '다른 기기에서 먼저 수정했습니다');
  const current = await dbFirst(context.env, 'SELECT * FROM lp_planner_items WHERE id=?', [itemId]);
  return { item: plannerView(current) };
}

async function listAssessmentRegistry(context) {
  requirePermission(context.actor, 'assessment.read');
  const result = await dbAll(context.env,
    'SELECT ar.*,pr.provider_key,pr.display_name AS provider_name FROM lp_assessment_registry ar ' +
    'JOIN lp_provider_registry pr ON pr.id=ar.provider_id WHERE ar.status<>\'retired\' ' +
    'ORDER BY pr.display_name,ar.display_name LIMIT ?', [pageLimit(context.url)]);
  return { items: result.map(row => ({
    id: row.id,
    providerKey: row.provider_key,
    providerName: row.provider_name,
    registryKey: row.registry_key,
    displayName: row.display_name,
    subjectCode: row.subject_code,
    gradeBand: row.grade_band,
    assessmentType: row.assessment_type,
    resultSchemaVersion: row.result_schema_version,
    status: row.status,
    revision: row.revision
  })) };
}

async function createAssessmentRegistry(context) {
  requirePermission(context.actor, 'assessment.write');
  const body = await readJson(context.request);
  const providerKey = keyField(body.providerKey, 'providerKey');
  const provider = await dbFirst(context.env,
    "SELECT id FROM lp_provider_registry WHERE provider_key=? AND status<>'disabled'", [providerKey]);
  if (!provider) fail(404, 'provider_not_found', '공급사를 찾을 수 없습니다');
  const registryKey = keyField(body.registryKey, 'registryKey');
  const existing = await dbFirst(context.env,
    'SELECT id,revision FROM lp_assessment_registry WHERE provider_id=? AND registry_key=?',
    [provider.id, registryKey]);
  if (existing) return { status: 200, body: { id: existing.id, revision: existing.revision, replayed: true } };
  const id = context.makeId('assessment');
  const displayName = stringField(body.displayName, 'displayName', { required: true, max: 160 });
  const subjectCode = stringField(body.subjectCode, 'subjectCode', { required: false, max: 64 }) || null;
  const gradeBand = stringField(body.gradeBand, 'gradeBand', { required: false, max: 64 }) || null;
  const assessmentType = keyField(body.assessmentType, 'assessmentType');
  const schemaVersion = numberField(body.resultSchemaVersion || 1, 'resultSchemaVersion', {
    required: true, integer: true, min: 1, max: 1000
  });
  await context.env.DB.batch([
    context.env.DB.prepare(
      'INSERT INTO lp_assessment_registry(id,provider_id,registry_key,display_name,subject_code,grade_band,' +
      'assessment_type,result_schema_version,metadata_json,status,revision,created_at,updated_at) ' +
      "VALUES(?,?,?,?,?,?,?,?,?,'candidate',1,?,?)"
    ).bind(
      id, provider.id, registryKey, displayName, subjectCode, gradeBand, assessmentType,
      schemaVersion, jsonString(body.metadata || {}, 4096), context.now, context.now
    ),
    changeStatement(context.env, context.actor.tenantId, 'assessment_registry', id, 'upsert', 1, context.now),
    auditStatement(context.env, context.actor, 'assessment_registry.create', 'assessment_registry', id,
      context.requestId, context.now, {
        auditId: context.makeId('audit'), publicMetadata: { providerKey, registryKey }
      })
  ]);
  return { status: 201, body: { id, revision: 1 } };
}

function validateScheduleRule(rule) {
  if (!rule || Array.isArray(rule) || typeof rule !== 'object') {
    fail(400, 'invalid_schedule', 'scheduleRule 객체가 필요합니다');
  }
  const frequency = enumField(rule.frequency, 'scheduleRule.frequency',
    ['once', 'weekly', 'monthly', 'term']);
  const interval = numberField(rule.interval || 1, 'scheduleRule.interval', {
    required: true, integer: true, min: 1, max: 52
  });
  const weekdays = Array.isArray(rule.weekdays)
    ? [...new Set(rule.weekdays.map(value => numberField(value, 'scheduleRule.weekdays', {
      required: true, integer: true, min: 0, max: 6
    })))].sort()
    : [];
  if (frequency === 'weekly' && !weekdays.length) {
    fail(400, 'invalid_schedule', '주간 일정에는 요일이 필요합니다');
  }
  return { schemaVersion: 1, frequency, interval, weekdays };
}

async function createAssessmentTemplate(context) {
  requirePermission(context.actor, 'assessment.write');
  const body = await readJson(context.request);
  idempotencyKey(context.request);
  const templateKey = keyField(body.templateKey, 'templateKey');
  const existing = await dbFirst(context.env,
    'SELECT id,active_version,revision FROM lp_assessment_templates WHERE tenant_id=? AND template_key=?',
    [context.actor.tenantId, templateKey]);
  if (existing) return { status: 200, body: { id: existing.id, activeVersion: existing.active_version, replayed: true } };
  const registryId = idField(body.assessmentRegistryId, 'assessmentRegistryId');
  const registry = await dbFirst(context.env,
    "SELECT id FROM lp_assessment_registry WHERE id=? AND status<>'retired'", [registryId]);
  if (!registry) fail(404, 'assessment_not_found', '평가 레지스트리를 찾을 수 없습니다');
  const templateId = context.makeId('template');
  const versionId = context.makeId('template-version');
  const schedule = validateScheduleRule(body.scheduleRule);
  const displayName = stringField(body.displayName, 'displayName', { required: true, max: 160 });
  const timezone = stringField(body.timezone || 'Asia/Seoul', 'timezone', { required: true, max: 64 });
  const openOffset = numberField(body.windowOpenOffsetMin || 0, 'windowOpenOffsetMin', {
    required: true, integer: true, min: -525600, max: 525600
  });
  const closeOffset = numberField(body.windowCloseOffsetMin || 1440, 'windowCloseOffsetMin', {
    required: true, integer: true, min: 1, max: 525600
  });
  await context.env.DB.batch([
    context.env.DB.prepare(
      "INSERT INTO lp_assessment_templates(id,tenant_id,template_key,display_name,active_version,status," +
      "revision,created_by,created_at,updated_at) VALUES(?,?,?,?,1,'draft',1,?,?,?)"
    ).bind(
      templateId, context.actor.tenantId, templateKey, displayName,
      context.actor.principalId || null, context.now, context.now
    ),
    context.env.DB.prepare(
      'INSERT INTO lp_assessment_template_versions(id,tenant_id,template_id,version_no,' +
      'assessment_registry_id,schedule_schema_version,schedule_rule_json,timezone,' +
      'window_open_offset_min,window_close_offset_min,instructions,config_json,created_by,created_at) ' +
      'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(
      versionId, context.actor.tenantId, templateId, 1, registryId, 1, jsonString(schedule), timezone,
      openOffset, closeOffset, stringField(body.instructions, 'instructions', { required: false, max: 2000 }) || null,
      jsonString(body.config || {}, 4096), context.actor.principalId || null, context.now
    ),
    changeStatement(context.env, context.actor.tenantId, 'assessment_template', templateId, 'upsert', 1, context.now),
    auditStatement(context.env, context.actor, 'assessment_template.create', 'assessment_template', templateId,
      context.requestId, context.now, {
        auditId: context.makeId('audit'), publicMetadata: { templateKey, version: 1 }
      })
  ]);
  return { status: 201, body: { id: templateId, versionId, activeVersion: 1, revision: 1 } };
}

async function listOccurrences(context) {
  const studentId = idField(context.url.searchParams.get('studentId'), 'studentId');
  requirePermission(context.actor, 'assessment.read', { studentId });
  const result = await dbAll(context.env,
    'SELECT * FROM lp_assessment_occurrences WHERE tenant_id=? AND student_id=? ' +
    'ORDER BY due_at,id LIMIT ?',
    [context.actor.tenantId, studentId, pageLimit(context.url)]);
  return { items: result.map(occurrenceView) };
}

async function createOccurrence(context) {
  const body = await readJson(context.request);
  const studentId = idField(body.studentId, 'studentId');
  requirePermission(context.actor, 'assessment.write', { studentId });
  await ensureStudent(context.env, context.actor, studentId);
  const key = idempotencyKey(context.request);
  const existing = await findByIdempotency(context.env, 'lp_assessment_occurrences', context.actor.tenantId, key);
  if (existing) return { status: 200, body: { item: occurrenceView(existing), replayed: true } };
  const templateVersionId = idField(body.templateVersionId, 'templateVersionId');
  const template = await dbFirst(context.env,
    'SELECT tv.id,tv.version_no,t.display_name FROM lp_assessment_template_versions tv ' +
    'JOIN lp_assessment_templates t ON t.id=tv.template_id AND t.tenant_id=tv.tenant_id ' +
    'WHERE tv.id=? AND tv.tenant_id=?',
    [templateVersionId, context.actor.tenantId]);
  if (!template) fail(404, 'template_version_not_found', '평가 템플릿 버전을 찾을 수 없습니다');
  const scheduledFor = numberField(body.scheduledFor, 'scheduledFor', { required: true, integer: true, min: 0 });
  const windowOpensAt = numberField(body.windowOpensAt, 'windowOpensAt', { required: true, integer: true, min: 0 });
  const windowClosesAt = numberField(body.windowClosesAt, 'windowClosesAt', { required: true, integer: true, min: 0 });
  const dueAt = numberField(body.dueAt, 'dueAt', { required: true, integer: true, min: 0 });
  if (!(windowOpensAt <= scheduledFor && scheduledFor <= dueAt && dueAt <= windowClosesAt)) {
    fail(400, 'invalid_occurrence_window', '평가 공개·예정·마감·종료 시각 순서를 확인해 주세요');
  }
  const occurrenceId = context.makeId('occurrence');
  const plannerId = context.makeId('planner');
  const cycleKey = keyField(body.cycleKey, 'cycleKey');
  const programId = body.studentProgramId ? idField(body.studentProgramId, 'studentProgramId') : null;
  if (programId) {
    const program = await dbFirst(context.env,
      'SELECT id FROM lp_student_programs WHERE id=? AND tenant_id=? AND student_id=? AND deleted_at IS NULL',
      [programId, context.actor.tenantId, studentId]);
    if (!program) fail(404, 'program_not_found', '학생 프로그램을 찾을 수 없습니다');
  }
  const snapshot = {
    schemaVersion: 1,
    templateVersionId,
    templateVersion: template.version_no,
    templateName: template.display_name
  };
  await context.env.DB.batch([
    context.env.DB.prepare(
      'INSERT INTO lp_assessment_occurrences(id,tenant_id,student_id,student_program_id,' +
      'template_version_id,cycle_key,scheduled_for,window_opens_at,window_closes_at,due_at,' +
      "schedule_snapshot_json,status,idempotency_key,revision,created_at,updated_at) " +
      "VALUES(?,?,?,?,?,?,?,?,?,?,?,'scheduled',?,1,?,?)"
    ).bind(
      occurrenceId, context.actor.tenantId, studentId, programId, templateVersionId, cycleKey,
      scheduledFor, windowOpensAt, windowClosesAt, dueAt, jsonString(snapshot), key, context.now, context.now
    ),
    context.env.DB.prepare(
      'INSERT INTO lp_planner_items(id,tenant_id,student_id,source_type,source_id,source_version,' +
      "title,detail,priority,status,available_at,due_at,timezone,idempotency_key,revision,created_by," +
      "created_at,updated_at,deleted_at) VALUES(?,?,?,'assessment',?,?,?,NULL,'high','planned',?,?,'Asia/Seoul',?,1,?,?,?,NULL)"
    ).bind(
      plannerId, context.actor.tenantId, studentId, occurrenceId, Number(template.version_no),
      template.display_name, windowOpensAt, dueAt, key + ':planner', context.actor.principalId || null,
      context.now, context.now
    ),
    changeStatement(context.env, context.actor.tenantId, 'assessment_occurrence', occurrenceId, 'upsert', 1, context.now),
    changeStatement(context.env, context.actor.tenantId, 'planner_item', plannerId, 'upsert', 1, context.now),
    auditStatement(context.env, context.actor, 'assessment_occurrence.create', 'assessment_occurrence', occurrenceId,
      context.requestId, context.now, {
        auditId: context.makeId('audit'), publicMetadata: { cycleKey, plannerId }
      })
  ]);
  return {
    status: 201,
    body: {
      item: occurrenceView({
        id: occurrenceId,
        student_id: studentId,
        student_program_id: programId,
        template_version_id: templateVersionId,
        cycle_key: cycleKey,
        scheduled_for: scheduledFor,
        window_opens_at: windowOpensAt,
        window_closes_at: windowClosesAt,
        due_at: dueAt,
        status: 'scheduled',
        revision: 1
      }),
      plannerItemId: plannerId
    }
  };
}

function normalizedMetrics(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    fail(400, 'invalid_metrics', 'metrics는 최대 100개의 배열이어야 합니다');
  }
  return value.map((metric, index) => {
    if (!metric || Array.isArray(metric) || typeof metric !== 'object') {
      fail(400, 'invalid_metrics', 'metric 객체 형식이 올바르지 않습니다', { index });
    }
    const valueNumber = metric.valueNumber === undefined ? null : numberField(metric.valueNumber,
      'metrics[' + index + '].valueNumber', { required: true, min: -1000000000, max: 1000000000 });
    const valueText = stringField(metric.valueText, 'metrics[' + index + '].valueText', {
      required: false, max: 100
    }) || null;
    if (valueNumber === null && valueText === null) {
      fail(400, 'invalid_metrics', 'metric 값이 필요합니다', { index });
    }
    return {
      code: keyField(metric.code, 'metrics[' + index + '].code'),
      domain: stringField(metric.domain, 'metrics[' + index + '].domain', { required: false, max: 64 }) || '',
      valueNumber,
      valueText,
      unit: stringField(metric.unit, 'metrics[' + index + '].unit', { required: false, max: 32 }) || null
    };
  });
}

async function createAssessmentResult(context) {
  const body = await readJson(context.request);
  const occurrenceId = idField(body.occurrenceId, 'occurrenceId');
  const occurrence = await dbFirst(context.env,
    'SELECT * FROM lp_assessment_occurrences WHERE id=? AND tenant_id=?',
    [occurrenceId, context.actor.tenantId]);
  if (!occurrence) fail(404, 'occurrence_not_found', '평가 회차를 찾을 수 없습니다');
  requirePermission(context.actor, 'assessment.result.write', { studentId: occurrence.student_id });
  const key = idempotencyKey(context.request);
  const existing = await findByIdempotency(context.env, 'lp_assessment_results', context.actor.tenantId, key);
  if (existing) return { status: 200, body: { id: existing.id, revisionNo: existing.revision_no, replayed: true } };
  const resultId = context.makeId('result');
  const metrics = normalizedMetrics(body.metrics);
  const schemaVersion = numberField(body.schemaVersion || 1, 'schemaVersion', {
    required: true, integer: true, min: 1, max: 1000
  });
  const overallScore = body.overallScore === undefined ? null : numberField(body.overallScore, 'overallScore', {
    required: true, min: -1000000000, max: 1000000000
  });
  const percentile = body.percentile === undefined ? null : numberField(body.percentile, 'percentile', {
    required: true, min: 0, max: 100
  });
  const sourceEventId = body.sourceEventId ? idField(body.sourceEventId, 'sourceEventId') : null;
  if (sourceEventId) {
    const event = await dbFirst(context.env,
      'SELECT id FROM lp_integration_events WHERE id=? AND tenant_id=? AND status IN (\'validated\',\'applied\')',
      [sourceEventId, context.actor.tenantId]);
    if (!event) fail(404, 'integration_event_not_found', '검증된 연동 이벤트를 찾을 수 없습니다');
  }
  const batch = await context.env.DB.batch([
    context.env.DB.prepare(
      'INSERT INTO lp_assessment_results(id,tenant_id,occurrence_id,revision_no,schema_version,' +
      'validation_status,release_status,overall_score,score_scale,level_code,percentile,metrics_json,' +
      'source_event_id,idempotency_key,created_by,created_at,reviewed_by,reviewed_at,released_at) ' +
      "SELECT ?,?,?,COALESCE(MAX(revision_no),0)+1,?,'pending','private',?,?,?,?,?,?,?,?,?,NULL,NULL,NULL " +
      'FROM lp_assessment_results WHERE occurrence_id=?'
    ).bind(
      resultId, context.actor.tenantId, occurrenceId, schemaVersion, overallScore,
      stringField(body.scoreScale, 'scoreScale', { required: false, max: 64 }) || null,
      stringField(body.levelCode, 'levelCode', { required: false, max: 64 }) || null,
      percentile, jsonString(metrics, 24 * 1024), sourceEventId, key,
      context.actor.principalId || null, context.now, occurrenceId
    ),
    changeStatement(context.env, context.actor.tenantId, 'assessment_result', resultId, 'upsert', 1, context.now),
    auditStatement(context.env, context.actor, 'assessment_result.create', 'assessment_result', resultId,
      context.requestId, context.now, {
        auditId: context.makeId('audit'), publicMetadata: { occurrenceId, metricCount: metrics.length }
      })
  ]);
  const inserted = batch && batch[0] && batch[0].meta ? Number(batch[0].meta.changes || 0) : 1;
  if (!inserted) fail(409, 'result_conflict', '평가 결과를 추가하지 못했습니다');
  const row = await dbFirst(context.env, 'SELECT revision_no FROM lp_assessment_results WHERE id=?', [resultId]);
  return { status: 201, body: { id: resultId, revisionNo: row.revision_no, releaseStatus: 'private' } };
}

async function createPrepCampaign(context) {
  requirePermission(context.actor, 'prep.write');
  const body = await readJson(context.request);
  const key = idempotencyKey(context.request);
  const existing = await findByIdempotency(context.env, 'lp_prep_campaigns', context.actor.tenantId, key);
  if (existing) return { status: 200, body: { id: existing.id, revision: existing.revision, replayed: true } };
  const type = enumField(body.campaignType, 'campaignType', ['general', 'elementary_choice_exam'], 'general');
  const startsAt = numberField(body.startsAt, 'startsAt', { required: true, integer: true, min: 0 });
  const endsAt = numberField(body.endsAt, 'endsAt', { required: true, integer: true, min: 0 });
  const selectionClosesAt = body.selectionClosesAt === undefined ? null : numberField(
    body.selectionClosesAt, 'selectionClosesAt', { required: true, integer: true, min: startsAt, max: endsAt });
  if (endsAt <= startsAt) fail(400, 'invalid_date_range', '캠페인 종료 시각은 시작 이후여야 합니다');
  if (type === 'elementary_choice_exam' && selectionClosesAt === null) {
    fail(400, 'selection_deadline_required', '초등 선택형 시험에는 선택 마감 시각이 필요합니다');
  }
  const id = context.makeId('campaign');
  await context.env.DB.batch([
    context.env.DB.prepare(
      'INSERT INTO lp_prep_campaigns(id,tenant_id,campaign_type,name,target_assessment_id,starts_at,' +
      "selection_closes_at,ends_at,status,config_json,idempotency_key,revision,created_by,created_at,updated_at) " +
      "VALUES(?,?,?,?,?,?,?,?,'draft',?,?,1,?,?,?)"
    ).bind(
      id, context.actor.tenantId, type,
      stringField(body.name, 'name', { required: true, max: 160 }),
      body.targetAssessmentId ? idField(body.targetAssessmentId, 'targetAssessmentId') : null,
      startsAt, selectionClosesAt, endsAt, jsonString(body.config || {}, 4096), key,
      context.actor.principalId || null, context.now, context.now
    ),
    changeStatement(context.env, context.actor.tenantId, 'prep_campaign', id, 'upsert', 1, context.now),
    auditStatement(context.env, context.actor, 'prep_campaign.create', 'prep_campaign', id,
      context.requestId, context.now, {
        auditId: context.makeId('audit'), publicMetadata: { campaignType: type }
      })
  ]);
  return { status: 201, body: { id, campaignType: type, status: 'draft', revision: 1 } };
}

async function addPrepOption(context, campaignId) {
  requirePermission(context.actor, 'prep.write', { campaignId });
  const body = await readJson(context.request);
  idempotencyKey(context.request);
  const campaign = await dbFirst(context.env,
    'SELECT id FROM lp_prep_campaigns WHERE id=? AND tenant_id=?', [campaignId, context.actor.tenantId]);
  if (!campaign) fail(404, 'campaign_not_found', '준비 캠페인을 찾을 수 없습니다');
  const optionCode = keyField(body.optionCode, 'optionCode');
  const existing = await dbFirst(context.env,
    'SELECT id FROM lp_prep_campaign_options WHERE campaign_id=? AND option_code=?', [campaignId, optionCode]);
  if (existing) return { status: 200, body: { id: existing.id, replayed: true } };
  const templateVersionId = idField(body.templateVersionId, 'templateVersionId');
  const templateVersion = await dbFirst(context.env,
    'SELECT id FROM lp_assessment_template_versions WHERE id=? AND tenant_id=?',
    [templateVersionId, context.actor.tenantId]);
  if (!templateVersion) fail(404, 'template_version_not_found', '같은 센터의 평가 템플릿 버전을 찾을 수 없습니다');
  const id = context.makeId('campaign-option');
  await context.env.DB.batch([
    context.env.DB.prepare(
      'INSERT INTO lp_prep_campaign_options(id,campaign_id,template_version_id,option_code,label,' +
      'sort_order,eligibility_json,capacity) VALUES(?,?,?,?,?,?,?,?)'
    ).bind(
      id, campaignId, templateVersionId, optionCode,
      stringField(body.label, 'label', { required: true, max: 120 }),
      numberField(body.sortOrder || 0, 'sortOrder', { required: true, integer: true, min: 0, max: 10000 }),
      jsonString(body.eligibility || {}, 4096),
      body.capacity === undefined ? null : numberField(body.capacity, 'capacity', {
        required: true, integer: true, min: 1, max: 100000
      })
    ),
    changeStatement(context.env, context.actor.tenantId, 'prep_campaign_option', id, 'upsert', 1, context.now),
    auditStatement(context.env, context.actor, 'prep_campaign.option.create', 'prep_campaign_option', id,
      context.requestId, context.now, {
        auditId: context.makeId('audit'), publicMetadata: { campaignId, optionCode }
      })
  ]);
  return { status: 201, body: { id, campaignId, optionCode } };
}

async function selectPrepOption(context, campaignId) {
  const body = await readJson(context.request);
  const studentId = idField(body.studentId, 'studentId');
  requireAnyPermission(context.actor, ['prep.select', 'prep.write'], { studentId, campaignId });
  await ensureStudent(context.env, context.actor, studentId);
  const action = enumField(body.action, 'action', ['select', 'change', 'lock', 'waive'], 'select');
  if ((action === 'lock' || action === 'waive') && !hasPermission(context.actor, 'prep.write', { studentId, campaignId })) {
    fail(403, 'forbidden', '선택 잠금·면제 권한이 없습니다');
  }
  const key = idempotencyKey(context.request);
  const replay = await dbFirst(context.env,
    'SELECT id FROM lp_prep_selection_events WHERE campaign_id=? AND student_id=? AND idempotency_key=?',
    [campaignId, studentId, key]);
  if (replay) return { status: 200, body: { id: replay.id, replayed: true } };
  const campaign = await dbFirst(context.env,
    'SELECT * FROM lp_prep_campaigns WHERE id=? AND tenant_id=?', [campaignId, context.actor.tenantId]);
  if (!campaign) fail(404, 'campaign_not_found', '준비 캠페인을 찾을 수 없습니다');
  if (campaign.selection_closes_at && context.now > campaign.selection_closes_at && action !== 'waive') {
    fail(409, 'selection_closed', '시험 선택 기간이 끝났습니다');
  }
  const optionId = action === 'waive' ? null : idField(body.optionId, 'optionId');
  if (optionId) {
    const option = await dbFirst(context.env,
      'SELECT o.id,o.capacity,(SELECT COUNT(*) FROM lp_prep_campaign_members m ' +
      "WHERE m.selected_option_id=o.id AND m.selection_status IN ('selected','locked')) AS used " +
      'FROM lp_prep_campaign_options o WHERE o.id=? AND o.campaign_id=?',
      [optionId, campaignId]);
    if (!option) fail(404, 'campaign_option_not_found', '시험 선택지를 찾을 수 없습니다');
    const current = await dbFirst(context.env,
      'SELECT selected_option_id FROM lp_prep_campaign_members WHERE campaign_id=? AND student_id=?',
      [campaignId, studentId]);
    if (option.capacity !== null && Number(option.used) >= Number(option.capacity) &&
        (!current || current.selected_option_id !== optionId)) {
      fail(409, 'option_full', '선택 가능한 인원이 모두 찼습니다');
    }
  }
  const memberId = context.makeId('campaign-member');
  const eventId = context.makeId('selection');
  const status = action === 'waive' ? 'waived' : action === 'lock' ? 'locked' : 'selected';
  await context.env.DB.batch([
    context.env.DB.prepare(
      'INSERT INTO lp_prep_campaign_members(id,campaign_id,student_id,selected_option_id,selection_status,' +
      'revision,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?) ' +
      'ON CONFLICT(campaign_id,student_id) DO UPDATE SET selected_option_id=excluded.selected_option_id,' +
      'selection_status=excluded.selection_status,revision=lp_prep_campaign_members.revision+1,' +
      'updated_at=excluded.updated_at'
    ).bind(memberId, campaignId, studentId, optionId, status, context.now, context.now),
    context.env.DB.prepare(
      'INSERT INTO lp_prep_selection_events(id,campaign_id,student_id,option_id,action,actor_id,' +
      'idempotency_key,occurred_at) VALUES(?,?,?,?,?,?,?,?)'
    ).bind(eventId, campaignId, studentId, optionId, action, context.actor.principalId || null, key, context.now),
    changeStatement(context.env, context.actor.tenantId, 'prep_selection', eventId, 'upsert', 1, context.now),
    auditStatement(context.env, context.actor, 'prep_campaign.selection', 'prep_campaign', campaignId,
      context.requestId, context.now, {
        auditId: context.makeId('audit'), publicMetadata: { studentId, action, optionId }
      })
  ]);
  return { status: 201, body: { id: eventId, campaignId, studentId, optionId, status } };
}

async function listWrongAnswers(context) {
  const studentId = idField(context.url.searchParams.get('studentId'), 'studentId');
  requirePermission(context.actor, 'practice.write', { studentId });
  const result = await dbAll(context.env,
    'SELECT id,student_id,occurrence_id,result_id,skill_id,provider_question_hash,question_ref,' +
    'error_code,status,revision,first_seen_at,last_seen_at FROM lp_wrong_answers ' +
    'WHERE tenant_id=? AND student_id=? ORDER BY last_seen_at DESC LIMIT ?',
    [context.actor.tenantId, studentId, pageLimit(context.url)]);
  return { items: result.map(row => ({
    id: row.id,
    studentId: row.student_id,
    occurrenceId: row.occurrence_id,
    resultId: row.result_id,
    skillId: row.skill_id,
    providerQuestionHash: row.provider_question_hash,
    questionRef: row.question_ref,
    errorCode: row.error_code,
    status: row.status,
    revision: row.revision,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at
  })) };
}

async function createWrongAnswer(context) {
  const body = await readJson(context.request);
  const studentId = idField(body.studentId, 'studentId');
  requirePermission(context.actor, 'practice.write', { studentId });
  await ensureStudent(context.env, context.actor, studentId);
  const occurrenceId = body.occurrenceId ? idField(body.occurrenceId, 'occurrenceId') : null;
  const resultId = body.resultId ? idField(body.resultId, 'resultId') : null;
  const skillId = body.skillId ? idField(body.skillId, 'skillId') : null;
  if (occurrenceId) {
    const occurrence = await dbFirst(context.env,
      'SELECT id FROM lp_assessment_occurrences WHERE id=? AND tenant_id=? AND student_id=?',
      [occurrenceId, context.actor.tenantId, studentId]);
    if (!occurrence) fail(404, 'occurrence_not_found', '같은 학생의 평가 회차를 찾을 수 없습니다');
  }
  if (resultId) {
    const result = await dbFirst(context.env,
      'SELECT r.id,o.id AS occurrence_id FROM lp_assessment_results r ' +
      'JOIN lp_assessment_occurrences o ON o.id=r.occurrence_id AND o.tenant_id=r.tenant_id ' +
      'WHERE r.id=? AND r.tenant_id=? AND o.student_id=?',
      [resultId, context.actor.tenantId, studentId]);
    if (!result || (occurrenceId && result.occurrence_id !== occurrenceId)) {
      fail(404, 'result_not_found', '같은 학생·회차의 평가 결과를 찾을 수 없습니다');
    }
  }
  if (skillId) {
    const skill = await dbFirst(context.env, 'SELECT id FROM lp_skill_registry WHERE id=?', [skillId]);
    if (!skill) fail(404, 'skill_not_found', '기술 분류를 찾을 수 없습니다');
  }
  const key = idempotencyKey(context.request);
  const existing = await findByIdempotency(context.env, 'lp_wrong_answers', context.actor.tenantId, key);
  if (existing) return { status: 200, body: { id: existing.id, replayed: true } };
  const questionRef = body.questionRef ? stringField(body.questionRef, 'questionRef', {
    required: true, max: 256, pattern: OPAQUE_REF_RE
  }) : null;
  const questionHash = body.providerQuestionHash ? stringField(body.providerQuestionHash,
    'providerQuestionHash', { required: true, max: 64, pattern: HASH_RE }) : null;
  if (!questionRef && !questionHash) {
    fail(400, 'question_reference_required', '문제 원문 대신 questionRef 또는 해시가 필요합니다');
  }
  const id = context.makeId('wrong-answer');
  await context.env.DB.batch([
    context.env.DB.prepare(
      'INSERT INTO lp_wrong_answers(id,tenant_id,student_id,occurrence_id,result_id,skill_id,' +
      "provider_question_hash,question_ref,error_code,status,idempotency_key,revision,first_seen_at," +
      "last_seen_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'open',?,1,?,?,?,?)"
    ).bind(
      id, context.actor.tenantId, studentId,
      occurrenceId,
      resultId,
      skillId,
      questionHash, questionRef,
      stringField(body.errorCode, 'errorCode', { required: false, max: 64 }) || null,
      key, context.now, context.now, context.now, context.now
    ),
    changeStatement(context.env, context.actor.tenantId, 'wrong_answer', id, 'upsert', 1, context.now),
    auditStatement(context.env, context.actor, 'wrong_answer.create', 'wrong_answer', id,
      context.requestId, context.now, {
        auditId: context.makeId('audit'), publicMetadata: { studentId, hasQuestionRef: !!questionRef }
      })
  ]);
  return { status: 201, body: { id, studentId, status: 'open', revision: 1 } };
}

async function createTwinProblem(context, wrongAnswerId) {
  const body = await readJson(context.request);
  const wrong = await dbFirst(context.env,
    'SELECT student_id FROM lp_wrong_answers WHERE id=? AND tenant_id=?',
    [wrongAnswerId, context.actor.tenantId]);
  if (!wrong) fail(404, 'wrong_answer_not_found', '오답 기록을 찾을 수 없습니다');
  requirePermission(context.actor, 'practice.write', { studentId: wrong.student_id });
  const key = idempotencyKey(context.request);
  const existing = await findByIdempotency(context.env, 'lp_twin_problems', context.actor.tenantId, key);
  if (existing) return { status: 200, body: { id: existing.id, replayed: true } };
  const id = context.makeId('twin-problem');
  const variant = await dbFirst(context.env,
    'SELECT COALESCE(MAX(variant_no),0)+1 AS next_no FROM lp_twin_problems WHERE wrong_answer_id=?',
    [wrongAnswerId]);
  const problemRef = stringField(body.problemRef, 'problemRef', {
    required: true, max: 256, pattern: OPAQUE_REF_RE
  });
  await context.env.DB.batch([
    context.env.DB.prepare(
      'INSERT INTO lp_twin_problems(id,tenant_id,wrong_answer_id,variant_no,generator_key,' +
      "generator_version,problem_ref,status,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,'candidate',?,?)"
    ).bind(
      id, context.actor.tenantId, wrongAnswerId, Number(variant.next_no),
      keyField(body.generatorKey || 'manual', 'generatorKey'),
      stringField(body.generatorVersion || '1', 'generatorVersion', { required: true, max: 64 }),
      problemRef, key, context.now
    ),
    changeStatement(context.env, context.actor.tenantId, 'twin_problem', id, 'upsert', 1, context.now),
    auditStatement(context.env, context.actor, 'twin_problem.create', 'twin_problem', id,
      context.requestId, context.now, {
        auditId: context.makeId('audit'), publicMetadata: { wrongAnswerId, variantNo: Number(variant.next_no) }
      })
  ]);
  return { status: 201, body: { id, wrongAnswerId, variantNo: Number(variant.next_no), problemRef } };
}

async function createTwinAttempt(context, twinProblemId) {
  const body = await readJson(context.request);
  const twin = await dbFirst(context.env,
    'SELECT tp.id,wa.student_id FROM lp_twin_problems tp JOIN lp_wrong_answers wa ON wa.id=tp.wrong_answer_id ' +
    'WHERE tp.id=? AND tp.tenant_id=? AND wa.tenant_id=?',
    [twinProblemId, context.actor.tenantId, context.actor.tenantId]);
  if (!twin) fail(404, 'twin_problem_not_found', '쌍둥이 문제를 찾을 수 없습니다');
  requirePermission(context.actor, 'practice.write', { studentId: twin.student_id });
  const key = idempotencyKey(context.request);
  const existing = await findByIdempotency(context.env, 'lp_twin_attempts', context.actor.tenantId, key);
  if (existing) return { status: 200, body: { id: existing.id, replayed: true } };
  const next = await dbFirst(context.env,
    'SELECT COALESCE(MAX(attempt_no),0)+1 AS next_no FROM lp_twin_attempts WHERE twin_problem_id=? AND student_id=?',
    [twinProblemId, twin.student_id]);
  const id = context.makeId('twin-attempt');
  const outcome = enumField(body.outcome, 'outcome', ['correct', 'incorrect', 'partial']);
  const score = body.score === undefined ? null : numberField(body.score, 'score', {
    required: true, min: 0, max: 100
  });
  await context.env.DB.batch([
    context.env.DB.prepare(
      'INSERT INTO lp_twin_attempts(id,tenant_id,twin_problem_id,student_id,attempt_no,outcome,' +
      'score,idempotency_key,submitted_at) VALUES(?,?,?,?,?,?,?,?,?)'
    ).bind(
      id, context.actor.tenantId, twinProblemId, twin.student_id, Number(next.next_no),
      outcome, score, key, context.now
    ),
    changeStatement(context.env, context.actor.tenantId, 'twin_attempt', id, 'upsert', 1, context.now),
    auditStatement(context.env, context.actor, 'twin_attempt.create', 'twin_attempt', id,
      context.requestId, context.now, {
        auditId: context.makeId('audit'), publicMetadata: { twinProblemId, outcome }
      })
  ]);
  return { status: 201, body: { id, twinProblemId, attemptNo: Number(next.next_no), outcome, score } };
}

async function listMastery(context) {
  const studentId = idField(context.url.searchParams.get('studentId'), 'studentId');
  requirePermission(context.actor, 'mastery.read', { studentId });
  const result = await dbAll(context.env,
    'SELECT sm.*,sr.skill_code,sr.display_name,sr.subject_code FROM lp_student_mastery sm ' +
    'JOIN lp_skill_registry sr ON sr.id=sm.skill_id WHERE sm.tenant_id=? AND sm.student_id=? ' +
    'ORDER BY sr.subject_code,sr.skill_code LIMIT ?',
    [context.actor.tenantId, studentId, pageLimit(context.url)]);
  return { items: result.map(row => ({
    studentId: row.student_id,
    skillId: row.skill_id,
    skillCode: row.skill_code,
    displayName: row.display_name,
    subjectCode: row.subject_code,
    modelVersion: row.model_version,
    masteryScore: row.mastery_score,
    confidence: row.confidence,
    evidenceCount: row.evidence_count,
    lastEvidenceAt: row.last_evidence_at,
    revision: row.revision
  })) };
}

async function createMasteryEvidence(context) {
  const body = await readJson(context.request);
  const studentId = idField(body.studentId, 'studentId');
  requirePermission(context.actor, 'mastery.write', { studentId });
  await ensureStudent(context.env, context.actor, studentId);
  const key = idempotencyKey(context.request);
  const existing = await findByIdempotency(context.env, 'lp_mastery_evidence', context.actor.tenantId, key);
  if (existing) return { status: 200, body: { id: existing.id, replayed: true } };
  const skillId = idField(body.skillId, 'skillId');
  const skill = await dbFirst(context.env, 'SELECT id FROM lp_skill_registry WHERE id=?', [skillId]);
  if (!skill) fail(404, 'skill_not_found', '숙련도 기술을 찾을 수 없습니다');
  const sourceType = enumField(body.sourceType, 'sourceType',
    ['assessment_result', 'twin_attempt', 'manual_import']);
  const sourceId = idField(body.sourceId, 'sourceId');
  let source;
  if (sourceType === 'assessment_result') {
    source = await dbFirst(context.env,
      'SELECT r.id FROM lp_assessment_results r JOIN lp_assessment_occurrences o ' +
      'ON o.id=r.occurrence_id AND o.tenant_id=r.tenant_id ' +
      'WHERE r.id=? AND r.tenant_id=? AND o.student_id=?',
      [sourceId, context.actor.tenantId, studentId]);
  } else if (sourceType === 'twin_attempt') {
    source = await dbFirst(context.env,
      'SELECT id FROM lp_twin_attempts WHERE id=? AND tenant_id=? AND student_id=?',
      [sourceId, context.actor.tenantId, studentId]);
  } else {
    source = await dbFirst(context.env,
      'SELECT id FROM lp_integration_events WHERE id=? AND tenant_id=?',
      [sourceId, context.actor.tenantId]);
  }
  if (!source) fail(404, 'mastery_source_not_found', '같은 센터·학생의 숙달 근거를 찾을 수 없습니다');
  const outcome = numberField(body.outcome, 'outcome', { required: true, min: 0, max: 1 });
  const weight = numberField(body.weight || 1, 'weight', { required: true, min: 0.01, max: 100 });
  const modelVersion = stringField(body.modelVersion || 'mvp-1', 'modelVersion', { required: true, max: 64 });
  const id = context.makeId('mastery-evidence');
  await context.env.DB.batch([
    context.env.DB.prepare(
      'INSERT INTO lp_mastery_evidence(id,tenant_id,student_id,skill_id,source_type,source_id,' +
      'outcome,weight,model_version,idempotency_key,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(
      id, context.actor.tenantId, studentId, skillId, sourceType, sourceId,
      outcome, weight, modelVersion, key, context.now
    ),
    context.env.DB.prepare(
      'INSERT INTO lp_student_mastery(tenant_id,student_id,skill_id,model_version,mastery_score,' +
      'confidence,evidence_count,last_evidence_at,revision,updated_at) ' +
      'SELECT tenant_id,student_id,skill_id,model_version,' +
      'SUM(outcome*weight)/SUM(weight),MIN(1.0,SUM(weight)/5.0),COUNT(*),MAX(occurred_at),1,? ' +
      'FROM lp_mastery_evidence WHERE tenant_id=? AND student_id=? AND skill_id=? AND model_version=? ' +
      'GROUP BY tenant_id,student_id,skill_id,model_version ' +
      'ON CONFLICT(tenant_id,student_id,skill_id,model_version) DO UPDATE SET ' +
      'mastery_score=excluded.mastery_score,confidence=excluded.confidence,' +
      'evidence_count=excluded.evidence_count,last_evidence_at=excluded.last_evidence_at,' +
      'revision=lp_student_mastery.revision+1,updated_at=excluded.updated_at'
    ).bind(context.now, context.actor.tenantId, studentId, skillId, modelVersion),
    changeStatement(context.env, context.actor.tenantId, 'student_mastery', studentId + ':' + skillId, 'upsert', 1, context.now),
    auditStatement(context.env, context.actor, 'mastery.evidence.create', 'mastery_evidence', id,
      context.requestId, context.now, {
        auditId: context.makeId('audit'), publicMetadata: { studentId, skillId, sourceType }
      })
  ]);
  return { status: 201, body: { id, studentId, skillId, outcome, weight, modelVersion } };
}

function normalizedCandidate(body) {
  const summary = body.summary || {};
  if (!summary || Array.isArray(summary) || typeof summary !== 'object') {
    fail(400, 'invalid_candidate', 'summary 객체가 필요합니다');
  }
  return {
    schemaVersion: 1,
    studentId: idField(body.studentId, 'studentId'),
    externalSubjectHash: body.externalSubjectHash ? stringField(body.externalSubjectHash,
      'externalSubjectHash', { required: true, max: 64, pattern: HASH_RE }) : null,
    assessmentKey: body.assessmentKey ? keyField(body.assessmentKey, 'assessmentKey') : null,
    occurredAt: numberField(body.occurredAt, 'occurredAt', { required: true, integer: true, min: 0 }),
    summary: {
      overallScore: summary.overallScore === undefined ? null : numberField(summary.overallScore,
        'summary.overallScore', { required: true, min: -1000000000, max: 1000000000 }),
      scoreScale: stringField(summary.scoreScale, 'summary.scoreScale', { required: false, max: 64 }) || null,
      levelCode: stringField(summary.levelCode, 'summary.levelCode', { required: false, max: 64 }) || null,
      percentile: summary.percentile === undefined ? null : numberField(summary.percentile,
        'summary.percentile', { required: true, min: 0, max: 100 }),
      metrics: normalizedMetrics(summary.metrics)
    }
  };
}

async function createManualIntegrationEvent(context) {
  const body = await readJson(context.request);
  const mode = enumField(body.mode, 'mode', ['manual_candidate', 'manual_import'], 'manual_candidate');
  const candidate = normalizedCandidate(body);
  requirePermission(context.actor,
    mode === 'manual_import' ? 'integration.import.write' : 'integration.candidate.write',
    { studentId: candidate.studentId });
  await ensureStudent(context.env, context.actor, candidate.studentId);
  const providerKey = keyField(body.providerKey, 'providerKey');
  const provider = await dbFirst(context.env,
    "SELECT id FROM lp_provider_registry WHERE provider_key=? AND status<>'disabled'", [providerKey]);
  if (!provider) fail(404, 'provider_not_found', '공급사를 찾을 수 없습니다');
  const key = idempotencyKey(context.request);
  const existing = await dbFirst(context.env,
    'SELECT * FROM lp_integration_events WHERE tenant_id=? AND provider_id=? AND idempotency_key=?',
    [context.actor.tenantId, provider.id, key]);
  if (existing) return { status: 200, body: { id: existing.id, status: existing.status, replayed: true } };
  const candidateText = jsonString(candidate, 32 * 1024);
  const eventId = context.makeId('integration-event');
  const status = mode === 'manual_import' ? 'validated' : 'candidate';
  await context.env.DB.batch([
    context.env.DB.prepare(
      'INSERT INTO lp_integration_events(id,tenant_id,provider_id,source_mode,idempotency_key,' +
      'provider_event_id,event_type,payload_sha256,candidate_json,status,received_by,received_at,' +
      'processed_at,error_code) VALUES(?,?,?,?,?,NULL,?,?,?,?,?,?,NULL,NULL)'
    ).bind(
      eventId, context.actor.tenantId, provider.id, mode, key,
      keyField(body.eventType, 'eventType'), await sha256Hex(candidateText), candidateText,
      status, context.actor.principalId || null, context.now
    ),
    changeStatement(context.env, context.actor.tenantId, 'integration_event', eventId, 'upsert', 1, context.now),
    auditStatement(context.env, context.actor, 'integration_event.create', 'integration_event', eventId,
      context.requestId, context.now, {
        auditId: context.makeId('audit'), publicMetadata: {
          providerKey, mode, eventType: body.eventType, studentId: candidate.studentId
        }
      })
  ]);
  return { status: 201, body: { id: eventId, providerKey, mode, status } };
}

async function listChanges(context) {
  requirePermission(context.actor, 'sync.read');
  const after = Math.max(0, Number(context.url.searchParams.get('afterSeq')) || 0);
  const result = await dbAll(context.env,
    'SELECT seq,entity_type,entity_id,operation,revision,changed_at FROM lp_change_feed ' +
    'WHERE tenant_id=? AND seq>? ORDER BY seq LIMIT ?',
    [context.actor.tenantId, after, pageLimit(context.url)]);
  const next = result.length ? Number(result[result.length - 1].seq) : after;
  return {
    afterSeq: after,
    nextSeq: next,
    items: result.map(row => ({
      seq: Number(row.seq),
      entityType: row.entity_type,
      entityId: row.entity_id,
      operation: row.operation,
      revision: row.revision,
      changedAt: row.changed_at
    }))
  };
}

async function dispatch(context) {
  const method = context.request.method.toUpperCase();
  const parts = context.url.pathname.slice(API_PREFIX.length).split('/').filter(Boolean);

  if (!parts.length || (parts.length === 1 && parts[0] === 'health')) {
    if (method !== 'GET') fail(405, 'method_not_allowed', 'GET만 허용됩니다');
    return {
      apiVersion: API_VERSION,
      ok: true,
      capabilities: {
        providerMode: 'manual-candidate-only',
        storesSecrets: false,
        storesQuestionBodies: false,
        legacyCoexistence: true
      }
    };
  }

  context.actor = await context.authenticate(context.request, context.env, context.now);
  if (!context.actor || !context.actor.tenantId) fail(401, 'unauthorized', '인증이 필요합니다');

  if (parts.length === 1 && parts[0] === 'providers' && method === 'GET') return listProviders(context);
  if (parts.length === 1 && parts[0] === 'student-programs') {
    if (method === 'GET') return listPrograms(context);
    if (method === 'POST') return createProgram(context);
  }
  if (parts.length === 2 && parts[0] === 'planner' && parts[1] === 'items') {
    if (method === 'GET') return listPlannerItems(context);
    if (method === 'POST') return createPlannerItem(context);
  }
  if (parts.length === 4 && parts[0] === 'planner' && parts[1] === 'items' && parts[3] === 'transitions' && method === 'POST') {
    return transitionPlannerItem(context, idField(parts[2], 'plannerItemId'));
  }
  if (parts.length === 2 && parts[0] === 'assessments' && parts[1] === 'registry') {
    if (method === 'GET') return listAssessmentRegistry(context);
    if (method === 'POST') return createAssessmentRegistry(context);
  }
  if (parts.length === 2 && parts[0] === 'assessments' && parts[1] === 'templates' && method === 'POST') {
    return createAssessmentTemplate(context);
  }
  if (parts.length === 2 && parts[0] === 'assessments' && parts[1] === 'occurrences') {
    if (method === 'GET') return listOccurrences(context);
    if (method === 'POST') return createOccurrence(context);
  }
  if (parts.length === 2 && parts[0] === 'assessments' && parts[1] === 'results' && method === 'POST') {
    return createAssessmentResult(context);
  }
  if (parts.length === 1 && parts[0] === 'prep-campaigns' && method === 'POST') {
    return createPrepCampaign(context);
  }
  if (parts.length === 3 && parts[0] === 'prep-campaigns' && parts[2] === 'options' && method === 'POST') {
    return addPrepOption(context, idField(parts[1], 'campaignId'));
  }
  if (parts.length === 3 && parts[0] === 'prep-campaigns' && parts[2] === 'selections' && method === 'POST') {
    return selectPrepOption(context, idField(parts[1], 'campaignId'));
  }
  if (parts.length === 1 && parts[0] === 'wrong-answers') {
    if (method === 'GET') return listWrongAnswers(context);
    if (method === 'POST') return createWrongAnswer(context);
  }
  if (parts.length === 3 && parts[0] === 'wrong-answers' && parts[2] === 'twins' && method === 'POST') {
    return createTwinProblem(context, idField(parts[1], 'wrongAnswerId'));
  }
  if (parts.length === 3 && parts[0] === 'twin-problems' && parts[2] === 'attempts' && method === 'POST') {
    return createTwinAttempt(context, idField(parts[1], 'twinProblemId'));
  }
  if (parts.length === 1 && parts[0] === 'mastery' && method === 'GET') return listMastery(context);
  if (parts.length === 2 && parts[0] === 'mastery' && parts[1] === 'evidence' && method === 'POST') {
    return createMasteryEvidence(context);
  }
  if (parts.length === 2 && parts[0] === 'integration-events' && parts[1] === 'manual' && method === 'POST') {
    return createManualIntegrationEvent(context);
  }
  if (parts.length === 1 && parts[0] === 'changes' && method === 'GET') return listChanges(context);

  fail(404, 'not_found', '지원하지 않는 v2 API 경로입니다');
}

export function isLearningV2Request(request) {
  try {
    const path = new URL(request.url).pathname;
    return path === API_PREFIX || path.startsWith(API_PREFIX + '/');
  } catch (error) {
    return false;
  }
}

export function createLearningV2Handler(options) {
  const opts = options || {};
  const authenticate = opts.authenticate || defaultAuthenticate;
  const nowFn = opts.now || (() => Date.now());
  const makeIdFn = opts.makeId || (prefix => prefix + ':' + crypto.randomUUID());

  return async function learningV2Handler(request, env, ctx) {
    if (!isLearningV2Request(request)) return null;
    const origin = allowedOrigin(request, env || {});
    if (origin === null) {
      return json({ ok: false, error: { code: 'origin_not_allowed', message: '허용되지 않은 출처입니다' } },
        403, responseHeaders(''));
    }
    if (request.method.toUpperCase() === 'OPTIONS') return corsResponse(origin);
    const headers = responseHeaders(origin);
    // 환경변수 누락·오타·예상하지 못한 값은 모두 닫힌 상태다. 정확한 문자열 "true"만 명시적으로 연다.
    const enabled = (env || {}).LEARNING_V2_ENABLED === 'true';
    if (!enabled) {
      const pathname = new URL(request.url).pathname;
      const healthRequest = request.method.toUpperCase() === 'GET' &&
        (pathname === API_PREFIX || pathname === API_PREFIX + '/health');
      if (healthRequest) {
        return json({
          ok: true,
          apiVersion: API_VERSION,
          enabled: false,
          capabilities: {
            providerMode: 'manual-candidate-only',
            storesSecrets: false,
            storesQuestionBodies: false,
            legacyCoexistence: true
          }
        }, 200, headers);
      }
      return json({
        ok: false,
        error: {
          code: 'learning_v2_disabled',
          message: 'v2 API는 데이터 이전 검증 전까지 운영에서 비활성 상태입니다'
        }
      }, 503, headers);
    }
    const context = {
      request,
      env,
      ctx,
      url: new URL(request.url),
      now: Number(nowFn()),
      makeId: makeIdFn,
      authenticate,
      requestId: requestId(request, makeIdFn),
      actor: null
    };
    try {
      const result = await dispatch(context);
      if (result && Object.prototype.hasOwnProperty.call(result, 'body')) {
        return json({ ok: true, ...result.body }, result.status || 200, headers);
      }
      return json({ ok: true, ...result }, 200, headers);
    } catch (error) {
      if (error instanceof ApiError) {
        return json({
          ok: false,
          error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }
        }, error.status, headers);
      }
      const message = String(error && error.message || error);
      if (/UNIQUE constraint failed/i.test(message)) {
        return json({ ok: false, error: { code: 'conflict', message: '이미 처리된 요청이거나 중복 데이터입니다' } },
          409, headers);
      }
      console.error('learning-v2', error);
      return json({ ok: false, error: { code: 'internal_error', message: '서버에서 요청을 처리하지 못했습니다' } },
        500, headers);
    }
  };
}

const defaultHandler = createLearningV2Handler();

export async function handleLearningV2Request(request, env, ctx) {
  return defaultHandler(request, env, ctx);
}

export const LEARNING_V2_API_PREFIX = API_PREFIX;
export const LEARNING_V2_API_VERSION = API_VERSION;

export default {
  handle: handleLearningV2Request,
  createHandler: createLearningV2Handler,
  matches: isLearningV2Request
};
