/**
 * 보강·회차 운영 알림톡. 수신번호와 템플릿 변수는 모두 서버 정본에서 만든다.
 * 기존 학부모 피드백 동의는 읽지 않으며, makeup/session 별도 동의만 사용한다.
 *
 * POST /guardian-ops-send
 *   { app, auth, action:'consent_list' }
 *   { app, auth, action:'consent_set', studentId, scope:'makeup'|'session', consent:boolean,
 *     expectedUpdatedAt:number }
 *   { app, auth, action:'preview'|'send', eventType, sourceId, revision }
 */

import { validateRosterDocument } from './roster.js';
import { issueGuardianPortalInvite } from './parent-portal.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const EVENT_TYPES = new Set([
  'makeup_proposal', 'makeup_confirmed', 'makeup_cancelled', 'session_balance'
]);
const SCOPES = new Set(['makeup', 'session']);
const SOLAPI_SEND_URL = 'https://api.solapi.com/messages/v4/send-many/detail';
const SOLAPI_TIMEOUT_MS = 8000;
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;
const GLOBAL_DAILY_LIMIT = 150;
const TEMPLATE_ENV = Object.freeze({
  makeup_proposal: 'SOLAPI_KAKAO_MAKEUP_PROPOSAL_APPROVED_TEMPLATE_ID',
  makeup_confirmed: 'SOLAPI_KAKAO_MAKEUP_CONFIRMED_APPROVED_TEMPLATE_ID',
  makeup_cancelled: 'SOLAPI_KAKAO_MAKEUP_CANCELLED_APPROVED_TEMPLATE_ID',
  session_balance: 'SOLAPI_KAKAO_SESSION_BALANCE_APPROVED_TEMPLATE_ID'
});

class PublicError extends Error {
  constructor(code, message, status = 400) {
    super(message); this.code = code; this.status = status;
  }
}

function fail(code, message, status) {
  throw new PublicError(code, message, status);
}

function text(value) {
  return String(value == null ? '' : value).normalize('NFKC').trim();
}

function identity(value) {
  return text(value).replace(/\s+/g, '').toLocaleLowerCase('ko-KR');
}

function digits(value) {
  return String(value || '').replace(/[\s()-]/g, '');
}

async function guardianIdentityHash(studentId, studentName, phone) {
  return sha256Hex([
    String(studentId || ''), text(studentName), digits(phone)
  ].join('\u001f'));
}

async function guardianPortalIdentityHash(studentId, studentName, phone) {
  return sha256Hex([
    String(studentId || ''), identity(studentName), digits(phone)
  ].join('\u001f'));
}

function parseJson(value) {
  try { return JSON.parse(value || '{}'); } catch (error) { return null; }
}

function changes(result) {
  return Number(result && result.meta && result.meta.changes || 0);
}

function actor(auth) {
  return auth && auth.role === 'manager' && SAFE_ID.test(String(auth.id || ''))
    ? String(auth.id) : 'director';
}

function exactBody(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail('REQUEST_INVALID', '요청 형식을 확인해 주세요', 400);
  }
  const allowed = new Set(['app', 'auth', 'action', ...fields]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      fail('REQUEST_FIELD_FORBIDDEN', '전화번호·수신자·문구는 요청에서 지정할 수 없습니다', 400);
    }
  }
  if (!body.auth || typeof body.auth !== 'object' || Array.isArray(body.auth)) {
    fail('AUTH_INVALID', '인증 정보를 확인해 주세요', 400);
  }
  const authKeys = new Set(['mode', 'secret', 'id', 'token']);
  for (const key of Object.keys(body.auth)) {
    if (!authKeys.has(key)) fail('AUTH_INVALID', '인증 정보를 확인해 주세요', 400);
  }
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value || '')));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function randomId(prefix) {
  return prefix + crypto.randomUUID().replace(/-/g, '');
}

async function solapiAuthorization(apiKey, apiSecret) {
  const date = new Date().toISOString();
  const salt = crypto.randomUUID();
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(apiSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = Array.from(new Uint8Array(await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(date + salt)
  )), byte => byte.toString(16).padStart(2, '0')).join('');
  return 'HMAC-SHA256 apiKey=' + apiKey + ', date=' + date + ', salt=' + salt + ', signature=' + signature;
}

function portalBaseUrl(value) {
  const raw = text(value);
  if (!raw || raw.length > 300) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    return url.href;
  } catch (error) { return null; }
}

function sendConfiguration(env, eventType, requireEnabled = true) {
  if (text(env.WB_GUARDIAN_CONTACT_ENABLED) === 'false') {
    return { error: 'SEND_DISABLED' };
  }
  if (requireEnabled && text(env.WB_GUARDIAN_OPS_SEND_ENABLED) !== 'true') {
    return { error: 'SEND_DISABLED' };
  }
  const apiKey = text(env.SOLAPI_KAKAO_API_KEY);
  const apiSecret = text(env.SOLAPI_KAKAO_API_SECRET);
  const pfId = text(env.SOLAPI_KAKAO_PF_ID);
  const templateId = text(env[TEMPLATE_ENV[eventType]]);
  const sender = digits(env.SOLAPI_SENDER_NUMBER);
  const parentPortalUrl = eventType === 'makeup_proposal'
    ? portalBaseUrl(env.WB_PARENT_PORTAL_BASE_URL) : null;
  if (!apiKey || !apiSecret || !SAFE_ID.test(pfId) || !SAFE_ID.test(templateId) ||
      !/^\d{8,12}$/.test(sender) || (eventType === 'makeup_proposal' && !parentPortalUrl)) {
    return { error: 'TEMPLATE_NOT_APPROVED' };
  }
  return { apiKey, apiSecret, pfId, templateId, sender, parentPortalUrl };
}

async function rosterStudent(env, app, studentId) {
  if (!SAFE_ID.test(studentId)) fail('STUDENT_INVALID', '학생 식별자를 확인해 주세요', 400);
  const row = await env.DB.prepare('SELECT data FROM private_rosters WHERE app=? LIMIT 1').bind(app).first();
  let document;
  try { document = row && validateRosterDocument(parseJson(row.data)); }
  catch (error) { fail('ROSTER_INVALID', '저장된 원생 명단을 확인해 주세요', 500); }
  const students = document && document.roster.students;
  const student = Array.isArray(students) ? students.find(item => item && item.id === studentId) : null;
  if (!student || !text(student.name) || !Array.isArray(student.teacherIds)) {
    fail('STUDENT_NOT_IN_ROSTER', '현재 원생 명단에서 학생을 찾을 수 없습니다', 409);
  }
  return student;
}

async function guardianIdentityFor(env, app, student) {
  const contact = await env.DB.prepare(
    'SELECT student_name,phone FROM guardian_contacts_by_student WHERE app=? AND student_id=? LIMIT 1'
  ).bind(app, student.id).first();
  if (!contact) return { error: 'GUARDIAN_NOT_REGISTERED' };
  if (identity(contact.student_name) !== identity(student.name)) return { error: 'GUARDIAN_IDENTITY_MISMATCH' };
  const phone = digits(contact.phone);
  if (!/^01[016789]\d{7,8}$/.test(phone)) return { error: 'GUARDIAN_PHONE_MISSING' };
  const identityHash = await guardianIdentityHash(student.id, student.name, phone);
  const portalIdentityHash = await guardianPortalIdentityHash(student.id, student.name, phone);
  return { phone, identityHash, portalIdentityHash };
}

async function contactFor(env, app, student, scope) {
  const guardian = await guardianIdentityFor(env, app, student);
  if (guardian.error) return guardian;
  const consent = await env.DB.prepare(
    'SELECT consent,guardian_identity_hash FROM guardian_ops_notification_consents ' +
    'WHERE app=? AND student_id=? AND scope=? LIMIT 1'
  ).bind(app, student.id, scope).first();
  if (!consent || !Number(consent.consent)) return { error: 'OPS_CONSENT_MISSING' };
  if (String(consent.guardian_identity_hash) !== guardian.identityHash) {
    return { error: 'OPS_CONSENT_IDENTITY_MISMATCH' };
  }
  return guardian;
}

async function portalAccessForProposal(env, app, target, guardian) {
  if (target.eventType !== 'makeup_proposal') return { ok: true };
  const row = await env.DB.prepare(
    'SELECT enabled,guardian_identity_hash,scope_version,updated_at FROM guardian_portal_access ' +
    'WHERE app=? AND student_id=? LIMIT 1'
  ).bind(app, target.student.id).first();
  if (!row || Number(row.enabled) !== 1) return { error: 'PORTAL_ACCESS_MISSING' };
  if (Number(row.scope_version || 1) < 1) return { error: 'PORTAL_ACCESS_MISSING' };
  if (!guardian || guardian.error ||
      String(row.guardian_identity_hash || '') !== String(guardian.portalIdentityHash || '')) {
    return { error: 'PORTAL_RECONSENT_REQUIRED' };
  }
  return { ok: true, updatedAt: Number(row.updated_at), identityHash: String(row.guardian_identity_hash),
    scopeVersion: Number(row.scope_version || 1) };
}

function portalInviteUrl(baseUrl, code) {
  const url = new URL(baseUrl);
  url.hash = new URLSearchParams({ code }).toString();
  return url.href;
}

async function staffName(env, app, staffId) {
  if (!SAFE_ID.test(String(staffId || ''))) fail('STAFF_INVALID', '담당 선생님을 확인해 주세요', 409);
  const row = await env.DB.prepare('SELECT data FROM staff WHERE app=? AND id=? LIMIT 1').bind(app, staffId).first();
  const staff = row && parseJson(row.data);
  if (!staff || staff.deleted || !text(staff.name)) fail('STAFF_INVALID', '담당 선생님을 확인해 주세요', 409);
  return text(staff.name).slice(0, 40);
}

async function taskContext(env, app, taskId) {
  const row = await env.DB.prepare('SELECT owner,data FROM tasks WHERE app=? AND id=? LIMIT 1').bind(app, taskId).first();
  const task = row && parseJson(row.data);
  if (!row || !task || task.deleted || String(task.id || '') !== taskId) {
    fail('LESSON_NOT_FOUND', '현재 수업 정보를 찾을 수 없습니다', 409);
  }
  return { owner: String(row.owner || ''), task };
}

function scheduleText(startAt, endAt) {
  const start = String(startAt || '');
  const end = String(endAt || '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/.test(start) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/.test(end) || start >= end) {
    fail('SCHEDULE_INVALID', '보강 일정을 확인해 주세요', 409);
  }
  return start.slice(0, 10) + ' ' + start.slice(11, 16) + '–' + end.slice(11, 16);
}

async function makeupTarget(env, app, eventType, sourceId, revision) {
  if (!sourceId.startsWith('mu_')) fail('SOURCE_INVALID', '보강 기록을 확인해 주세요', 400);
  const row = await env.DB.prepare('SELECT * FROM makeup_cases WHERE app=? AND case_id=? LIMIT 1')
    .bind(app, sourceId).first();
  if (!row) fail('SOURCE_NOT_FOUND', '보강 기록을 찾을 수 없습니다', 404);
  const expectedEvent = eventType.replace('makeup_', '');
  const expectedStatus = { proposal: 'awaiting_parent', confirmed: 'confirmed', cancelled: 'cancelled' }[expectedEvent];
  if (!Number(row.notification_needed) || String(row.notification_event || '') !== expectedEvent ||
      Number(row.notification_event_revision) !== revision || String(row.status) !== expectedStatus) {
    fail('SOURCE_EVENT_MISMATCH', '현재 보강 상태와 알림 이벤트가 일치하지 않습니다', 409);
  }
  const student = await rosterStudent(env, app, String(row.student_id));
  const source = await taskContext(env, app, String(row.source_task_id));
  if (String(source.task.studentId || '') !== String(student.id) ||
      String(source.owner) !== String(row.source_teacher_id) ||
      (source.task.staffId && String(source.task.staffId) !== String(row.source_teacher_id))) {
    fail('SOURCE_IDENTITY_MISMATCH', '원 수업과 보강 학생·담당자가 일치하지 않습니다', 409);
  }
  let startAt;
  let endAt;
  let staffId;
  if (expectedEvent === 'proposal') {
    startAt = row.proposed_start_at; endAt = row.proposed_end_at; staffId = row.proposed_staff_id;
  } else if (expectedEvent === 'confirmed') {
    startAt = row.confirmed_start_at; endAt = row.confirmed_end_at; staffId = row.confirmed_staff_id;
  } else {
    startAt = row.confirmed_start_at || row.proposed_start_at;
    endAt = row.confirmed_end_at || row.proposed_end_at;
    staffId = row.confirmed_staff_id || row.proposed_staff_id || row.source_teacher_id;
  }
  const schedule = scheduleText(startAt, endAt);
  const teacherName = await staffName(env, app, String(staffId || ''));
  const variables = eventType === 'makeup_proposal'
    ? { '#{학생명}': text(student.name), '#{원수업일}': String(row.source_date), '#{보강일시}': schedule,
        '#{담당선생님}': teacherName, '#{보호자앱URL}': '' }
    : eventType === 'makeup_confirmed'
      ? { '#{학생명}': text(student.name), '#{보강일시}': schedule, '#{담당선생님}': teacherName }
      : { '#{학생명}': text(student.name), '#{취소일정}': schedule, '#{담당선생님}': teacherName };
  return {
    eventType, sourceId, revision, scope: 'makeup', student, variables,
    sourceGuard: {
      kind: 'makeup', rowRevision: Number(row.revision), status: expectedStatus,
      notificationEvent: expectedEvent, notificationEventRevision: revision
    }
  };
}

async function sessionTarget(env, app, sourceId, revision) {
  if (!sourceId.startsWith('sp_')) fail('SOURCE_INVALID', '회차권을 확인해 주세요', 400);
  const pack = await env.DB.prepare('SELECT * FROM session_packs WHERE app=? AND pack_id=? LIMIT 1')
    .bind(app, sourceId).first();
  if (!pack) fail('SOURCE_NOT_FOUND', '회차권을 찾을 수 없습니다', 404);
  if (Number(pack.revision) !== revision) fail('SOURCE_EVENT_MISMATCH', '현재 회차와 revision이 일치하지 않습니다', 409);
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (String(pack.status || '') !== 'active') {
    fail('SESSION_PACK_NOT_ACTIVE', '현재 이용 중인 회차권만 안내할 수 있습니다', 409);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(pack.valid_from || '')) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(String(pack.expires_on || '')) ||
      String(pack.valid_from) > String(pack.expires_on) ||
      today < String(pack.valid_from) || today > String(pack.expires_on)) {
    fail('SESSION_PACK_OUTSIDE_VALIDITY', '현재 유효기간 안의 회차권만 안내할 수 있습니다', 409);
  }
  const student = await rosterStudent(env, app, String(pack.student_id));
  const source = await taskContext(env, app, String(pack.lesson_task_id));
  if (source.owner !== String(pack.task_owner) || String(source.task.studentId || '') !== String(student.id) ||
      String(source.task.staffId || source.owner) !== source.owner ||
      !student.teacherIds.includes(source.owner)) {
    fail('SOURCE_IDENTITY_MISMATCH', '현재 학생·수업·담당자 연결이 회차권과 일치하지 않습니다', 409);
  }
  const studentHash = await sha256Hex('student-id\n' + student.id);
  const taskHash = await sha256Hex([
    'lesson-task', source.task.id, source.owner, source.task.studentId,
    source.task.lessonAssignmentKey || source.task.lessonDedupeKey || source.task.id
  ].join('\n'));
  if (studentHash !== String(pack.student_identity_hash) || taskHash !== String(pack.task_identity_hash)) {
    fail('SOURCE_IDENTITY_MISMATCH', '회차권 생성 당시 정보와 현재 학생·수업 정보가 다릅니다', 409);
  }
  const usage = await env.DB.prepare(
    'SELECT COALESCE(SUM(delta),0) AS used FROM session_pack_usage WHERE app=? AND pack_id=?'
  ).bind(app, sourceId).first();
  const total = Number(pack.total_sessions);
  const used = Number(usage && usage.used || 0);
  if (!Number.isInteger(total) || !Number.isInteger(used) || used < 0 || used > total) {
    fail('SESSION_BALANCE_INVALID', '회차 잔여 수를 확인해 주세요', 409);
  }
  return {
    eventType: 'session_balance', sourceId, revision, scope: 'session', student,
    sourceGuard: { kind: 'session', today, used },
    variables: {
      '#{전체횟수}': String(total), '#{사용횟수}': String(used), '#{잔여횟수}': String(total - used),
      '#{유효기간}': String(pack.valid_from) + '–' + String(pack.expires_on)
    }
  };
}

async function authoritativeTarget(env, app, body) {
  const eventType = String(body.eventType || '');
  const sourceId = String(body.sourceId || '');
  const revision = Number(body.revision);
  if (!EVENT_TYPES.has(eventType) || !SAFE_ID.test(sourceId) || !Number.isInteger(revision) || revision < 1) {
    fail('TARGET_INVALID', '이벤트·원본 ID·revision을 확인해 주세요', 400);
  }
  return eventType === 'session_balance'
    ? sessionTarget(env, app, sourceId, revision)
    : makeupTarget(env, app, eventType, sourceId, revision);
}

function safeProviderId(value) {
  const valueText = String(value || '');
  return SAFE_ID.test(valueText) ? valueText : null;
}

function safeProviderStatus(value) {
  const valueText = String(value || '');
  return /^\d{1,16}$/.test(valueText) ? valueText : null;
}

function providerOutcome(response, payload) {
  if (!response.ok) {
    const raw = String(payload && (payload.errorCode || payload.statusCode) || '');
    const suffix = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40).toUpperCase();
    return response.status >= 500
      ? { status: 'unknown', errorCode: 'SOLAPI_HTTP_' + response.status + (suffix ? '_' + suffix : '') }
      : { status: 'rejected', errorCode: 'SOLAPI_HTTP_' + response.status + (suffix ? '_' + suffix : '') };
  }
  const groupId = safeProviderId(payload && payload.groupInfo && payload.groupInfo.groupId);
  const failed = payload && Array.isArray(payload.failedMessageList) ? payload.failedMessageList[0] : null;
  if (failed) {
    const messageId = safeProviderId(failed.messageId);
    const statusCode = safeProviderStatus(failed.statusCode);
    return {
      status: 'rejected', errorCode: 'SOLAPI_STATUS_' + (statusCode || 'REJECTED'),
      provider: groupId && messageId && statusCode ? { groupId, messageId, statusCode } : undefined
    };
  }
  const message = payload && Array.isArray(payload.messageList) ? payload.messageList[0] : null;
  const messageId = safeProviderId(message && message.messageId);
  const statusCode = safeProviderStatus(message && message.statusCode);
  if (!groupId || !messageId || !statusCode) return { status: 'unknown', errorCode: 'SOLAPI_AMBIGUOUS_RESPONSE' };
  const provider = { groupId, messageId, statusCode };
  return ['2000', '3000', '4000'].includes(statusCode)
    ? { status: 'accepted', provider }
    : { status: 'rejected', provider, errorCode: 'SOLAPI_STATUS_' + statusCode };
}

async function latestTargetState(env, app, target) {
  const row = await env.DB.prepare(
    'SELECT s.send_id,s.attempt_no,s.created_at,e.status,e.safe_error_code ' +
    'FROM guardian_ops_notification_sends s LEFT JOIN guardian_ops_notification_send_events e ' +
    'ON e.app=s.app AND e.send_id=s.send_id WHERE s.app=? AND s.event_type=? AND s.source_id=? ' +
    'AND s.source_revision=? ORDER BY s.attempt_no DESC LIMIT 1'
  ).bind(app, target.eventType, target.sourceId, target.revision).first();
  if (!row) return null;
  return {
    sendId: String(row.send_id), attemptNo: Number(row.attempt_no),
    status: row.status || 'dispatching', errorCode: row.safe_error_code || undefined,
    createdAt: Number(row.created_at)
  };
}

async function reserveSend(env, app, target, guardian, portal, config, auth) {
  const now = Date.now();
  const sendId = randomId('gos_');
  const variablesHash = await sha256Hex(JSON.stringify(target.variables));
  const idempotencyKey = await sha256Hex([
    app, target.eventType, target.sourceId, target.revision, sendId
  ].join('\u001f'));
  const sourceGuard = target.sourceGuard || {};
  const sourceClause = sourceGuard.kind === 'session'
    ? 'AND EXISTS (SELECT 1 FROM session_packs current_source WHERE current_source.app=? ' +
      'AND current_source.pack_id=? AND current_source.revision=? AND current_source.status=\'active\' ' +
      'AND ? BETWEEN current_source.valid_from AND current_source.expires_on ' +
      'AND (SELECT COALESCE(SUM(current_usage.delta),0) FROM session_pack_usage current_usage ' +
      'WHERE current_usage.app=current_source.app AND current_usage.pack_id=current_source.pack_id)=?) '
    : 'AND EXISTS (SELECT 1 FROM makeup_cases current_source WHERE current_source.app=? ' +
      'AND current_source.case_id=? AND current_source.student_id=? AND current_source.revision=? ' +
      'AND current_source.status=? AND current_source.notification_needed=1 ' +
      'AND current_source.notification_event=? AND current_source.notification_event_revision=?) ';
  const sourceBindings = sourceGuard.kind === 'session'
    ? [app, target.sourceId, target.revision, sourceGuard.today, sourceGuard.used]
    : [app, target.sourceId, target.student.id, sourceGuard.rowRevision, sourceGuard.status,
      sourceGuard.notificationEvent, sourceGuard.notificationEventRevision];
  const sql =
    'INSERT INTO guardian_ops_notification_sends ' +
    '(app,send_id,idempotency_key,event_type,source_id,source_revision,student_id,' +
    'variables_hash,template_id,attempt_no,created_at,created_by) ' +
    'SELECT ?,?,?,?,?,?,?,?,?,COALESCE((SELECT MAX(previous.attempt_no) FROM guardian_ops_notification_sends previous ' +
    'WHERE previous.app=? AND previous.event_type=? AND previous.source_id=? AND previous.source_revision=?),0)+1,?,? ' +
    'WHERE (SELECT COUNT(*) FROM guardian_ops_notification_sends WHERE app=? AND created_at>?)<' + GLOBAL_DAILY_LIMIT + ' ' +
    'AND EXISTS (SELECT 1 FROM guardian_ops_notification_consents current_consent ' +
    'WHERE current_consent.app=? AND current_consent.student_id=? AND current_consent.scope=? ' +
    'AND current_consent.consent=1 AND current_consent.guardian_identity_hash=?) ' +
    "AND (?<>'makeup_proposal' OR EXISTS (SELECT 1 FROM guardian_portal_access portal_access " +
    'WHERE portal_access.app=? AND portal_access.student_id=? AND portal_access.enabled=1 ' +
    'AND portal_access.guardian_identity_hash=? AND portal_access.updated_at=? ' +
    'AND portal_access.scope_version=?)) ' +
    sourceClause +
    'AND NOT EXISTS (SELECT 1 FROM guardian_ops_notification_sends prior ' +
    'LEFT JOIN guardian_ops_notification_send_events outcome ON outcome.app=prior.app AND outcome.send_id=prior.send_id ' +
    'WHERE prior.app=? AND prior.event_type=? AND prior.source_id=? AND prior.source_revision=? ' +
    "AND (outcome.status IS NULL OR outcome.status IN ('accepted','unknown')))";
  const result = await env.DB.prepare(sql).bind(
    app, sendId, idempotencyKey, target.eventType, target.sourceId, target.revision,
    target.student.id, variablesHash, config.templateId,
    app, target.eventType, target.sourceId, target.revision, now, actor(auth),
    app, now - 24 * 60 * 60 * 1000,
    app, target.student.id, target.scope, guardian.identityHash,
    target.eventType, app, target.student.id, guardian.portalIdentityHash,
    Number(portal && portal.updatedAt || 0), Number(portal && portal.scopeVersion || 1),
    ...sourceBindings,
    app, target.eventType, target.sourceId, target.revision
  ).run();
  return changes(result) === 1 ? { sendId, now, variablesHash } : null;
}

async function appendOutcome(env, app, sendId, outcome) {
  const provider = outcome.provider || {};
  const result = await env.DB.prepare(
    'INSERT OR IGNORE INTO guardian_ops_notification_send_events ' +
    '(app,ledger_event_id,send_id,status,provider_group_id,provider_message_id,provider_status_code,safe_error_code,created_at) ' +
    'VALUES(?,?,?,?,?,?,?,?,?)'
  ).bind(
    app, randomId('goe_'), sendId, outcome.status, provider.groupId || null,
    provider.messageId || null, provider.statusCode || null, outcome.errorCode || null, Date.now()
  ).run();
  return changes(result) === 1;
}

async function revalidateAuthoritativeSource(env, app, target, config, variablesHash) {
  try {
    const fresh = await authoritativeTarget(env, app, {
      eventType: target.eventType, sourceId: target.sourceId, revision: target.revision
    });
    if (fresh.eventType === 'makeup_proposal') {
      fresh.variables['#{보호자앱URL}'] = config.parentPortalUrl;
    }
    const freshHash = await sha256Hex(JSON.stringify(fresh.variables));
    if (freshHash !== variablesHash || fresh.student.id !== target.student.id || fresh.scope !== target.scope) {
      return { error: 'SOURCE_CHANGED_BEFORE_DISPATCH' };
    }
    return { ok: true, target: fresh };
  } catch (error) {
    return { error: 'SOURCE_CHANGED_BEFORE_DISPATCH' };
  }
}

async function dispatchSnapshot(env, app, target, guardian, portal, config, variablesHash) {
  const currentGuardian = await contactFor(env, app, target.student, target.scope);
  if (currentGuardian.error) {
    return { error: currentGuardian.error === 'OPS_CONSENT_MISSING'
      ? 'OPS_CONSENT_REVOKED_BEFORE_DISPATCH' : 'GUARDIAN_PHONE_CHANGED_BEFORE_DISPATCH' };
  }
  if (currentGuardian.phone !== guardian.phone || currentGuardian.identityHash !== guardian.identityHash ||
      currentGuardian.portalIdentityHash !== guardian.portalIdentityHash) {
    return { error: 'GUARDIAN_PHONE_CHANGED_BEFORE_DISPATCH' };
  }
  const currentPortal = await portalAccessForProposal(env, app, target, currentGuardian);
  if (currentPortal.error || currentPortal.updatedAt !== portal.updatedAt ||
      currentPortal.identityHash !== portal.identityHash || currentPortal.scopeVersion !== portal.scopeVersion) {
    return { error: 'PORTAL_ACCESS_REVOKED_BEFORE_DISPATCH' };
  }
  const source = await revalidateAuthoritativeSource(env, app, target, config, variablesHash);
  if (source.error) return source;
  return { ok: true, guardian: currentGuardian, target: source.target };
}

async function revokeUnusedPortalInvite(env, code) {
  if (!/^[a-f0-9]{48}$/i.test(String(code || ''))) return;
  try {
    await env.DB.prepare(
      'UPDATE guardian_portal_codes SET revoked=1 WHERE app=? AND code_hash=? AND consumed_at IS NULL'
    ).bind('task', 'sha256:' + await sha256Hex(code)).run();
  } catch (error) {
    // 원문 code는 응답·원장·로그에 노출되지 않으므로, revoke 실패 시에도 외부 전달 경로는 없다.
  }
}

async function rejectedReservation(env, app, reservation, code, origin, json, inviteCode) {
  if (inviteCode) await revokeUnusedPortalInvite(env, inviteCode);
  const recorded = await appendOutcome(env, app, reservation.sendId, {
    status: 'rejected', errorCode: code
  });
  const safeCode = recorded ? code : 'SEND_RESULT_NOT_RECORDED';
  return json({ ok: false, idempotent: false, status: recorded ? 'rejected' : 'unknown', code: safeCode,
    error: recorded ? blockerMessage(safeCode) : blockerMessage('PRIOR_SEND_UNCERTAIN') }, recorded ? 409 : 202, origin);
}

function blockerMessage(code) {
  return {
    SEND_DISABLED: '운영 알림톡 발송 스위치가 꺼져 있습니다',
    TEMPLATE_NOT_APPROVED: '승인된 카카오 템플릿·보호자 앱 주소 설정을 확인해 주세요',
    GUARDIAN_NOT_REGISTERED: '보호자 연락처를 먼저 등록해 주세요',
    GUARDIAN_IDENTITY_MISMATCH: '보호자 연락처의 학생 이름이 현재 원생 명단과 일치하지 않습니다',
    GUARDIAN_PHONE_MISSING: '보호자 휴대폰 번호를 확인해 주세요',
    OPS_CONSENT_MISSING: '이 운영 알림 범위의 별도 수신 동의가 없습니다',
    OPS_CONSENT_IDENTITY_MISMATCH: '보호자 정보가 변경되어 운영 알림 동의를 다시 받아야 합니다',
    PORTAL_ACCESS_MISSING: '보호자 웹앱 이용 동의와 기존 앱 연결을 먼저 준비해 주세요',
    PORTAL_RECONSENT_REQUIRED: '보호자 정보가 변경되어 웹앱 이용 동의를 다시 받아야 합니다',
    OPS_CONSENT_REVOKED_BEFORE_DISPATCH: '발송 직전 운영 알림 수신 동의가 철회되어 보내지 않았습니다',
    GUARDIAN_PHONE_CHANGED_BEFORE_DISPATCH: '발송 직전 보호자 연락처가 변경되어 보내지 않았습니다',
    PORTAL_ACCESS_REVOKED_BEFORE_DISPATCH: '발송 직전 보호자 웹앱 이용 동의가 변경되어 보내지 않았습니다',
    SOURCE_CHANGED_BEFORE_DISPATCH: '발송 직전 보강·회차 상태가 변경되어 보내지 않았습니다',
    PRIOR_SEND_UNCERTAIN: '이 이벤트의 이전 발송 접수 여부를 먼저 확인해 주세요',
    DAILY_SEND_LIMIT: '최근 24시간 운영 알림톡 150건 한도에 도달했습니다'
  }[code] || '운영 알림톡을 발송할 수 없습니다';
}

function emptyConsentView(studentId, scope) {
  return { studentId, scope, consent: false, needsReconsent: false, updatedAt: 0, updatedBy: '' };
}

async function publicConsent(env, app, studentId, scope, row) {
  if (!row) return emptyConsentView(studentId, scope);
  const storedConsent = !!Number(row.consent);
  let identityMatches = false;
  if (storedConsent) {
    try {
      const student = await rosterStudent(env, app, studentId);
      const guardian = await guardianIdentityFor(env, app, student);
      identityMatches = !guardian.error && guardian.identityHash === String(row.guardian_identity_hash);
    } catch (error) {
      identityMatches = false;
    }
  }
  return {
    studentId, scope, consent: storedConsent && identityMatches,
    needsReconsent: storedConsent && !identityMatches,
    updatedAt: Number(row.updated_at), updatedBy: String(row.updated_by || '')
  };
}

async function currentConsent(env, app, studentId, scope) {
  const row = await env.DB.prepare(
    'SELECT consent,guardian_identity_hash,updated_at,updated_by ' +
    'FROM guardian_ops_notification_consents WHERE app=? AND student_id=? AND scope=? LIMIT 1'
  ).bind(app, studentId, scope).first();
  return { row, view: await publicConsent(env, app, studentId, scope, row) };
}

async function consentList(env, app, origin, json) {
  const result = await env.DB.prepare(
    'SELECT student_id,scope,consent,guardian_identity_hash,updated_at,updated_by ' +
    'FROM guardian_ops_notification_consents WHERE app=? ORDER BY student_id,scope'
  ).bind(app).all();
  const consents = [];
  for (const row of result.results || []) {
    consents.push(await publicConsent(env, app, String(row.student_id), String(row.scope), row));
  }
  return json({ ok: true, consents }, 200, origin);
}

function consentConflict(current, origin, json) {
  return json({ ok: false, code: 'CONSENT_REVISION_CONFLICT',
    error: '운영 알림 동의가 다른 화면에서 변경되었습니다. 최신 상태를 확인해 주세요',
    current }, 409, origin);
}

async function consentSet(env, app, body, auth, origin, json) {
  const studentId = String(body.studentId || '');
  const scope = String(body.scope || '');
  const expectedUpdatedAt = body.expectedUpdatedAt;
  if (!SAFE_ID.test(studentId) || !SCOPES.has(scope) || typeof body.consent !== 'boolean' ||
      typeof expectedUpdatedAt !== 'number' || !Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt < 0) {
    return json({ ok: false, code: 'CONSENT_INVALID', error: '학생·알림 범위·동의 여부를 확인해 주세요' }, 400, origin);
  }
  const beforeState = await currentConsent(env, app, studentId, scope);
  const before = beforeState.row;
  const currentUpdatedAt = before ? Number(before.updated_at) : 0;
  if (currentUpdatedAt !== expectedUpdatedAt) return consentConflict(beforeState.view, origin, json);

  let identityHash = before ? String(before.guardian_identity_hash) : '';
  if (body.consent) {
    let student;
    try { student = await rosterStudent(env, app, studentId); }
    catch (error) {
      return json({ ok: false, code: 'GUARDIAN_NOT_READY', error: '현재 학생과 일치하는 보호자 휴대폰 번호를 먼저 확인해 주세요' }, 409, origin);
    }
    const guardian = await guardianIdentityFor(env, app, student);
    if (guardian.error) {
      return json({ ok: false, code: 'GUARDIAN_NOT_READY', error: '현재 학생과 일치하는 보호자 휴대폰 번호를 먼저 확인해 주세요' }, 409, origin);
    }
    identityHash = guardian.identityHash;
    if (before && Number(before.consent) === 1 && String(before.guardian_identity_hash) === identityHash) {
      return json({ ok: true, idempotent: true, consent: beforeState.view }, 200, origin);
    }
  } else if (before && Number(before.consent) === 0) {
    return json({ ok: true, idempotent: true, consent: beforeState.view }, 200, origin);
  }
  if (!identityHash) identityHash = await guardianIdentityHash(studentId, '', '');
  const now = Math.max(Date.now(), expectedUpdatedAt + 1);
  const updatedBy = actor(auth);
  const saved = before
    ? await env.DB.prepare(
      'UPDATE guardian_ops_notification_consents SET consent=?,guardian_identity_hash=?,updated_at=?,updated_by=? ' +
      'WHERE app=? AND student_id=? AND scope=? AND updated_at=?'
    ).bind(body.consent ? 1 : 0, identityHash, now, updatedBy,
      app, studentId, scope, expectedUpdatedAt).run()
    : await env.DB.prepare(
      'INSERT OR IGNORE INTO guardian_ops_notification_consents ' +
      '(app,student_id,scope,consent,guardian_identity_hash,updated_at,updated_by) VALUES(?,?,?,?,?,?,?)'
    ).bind(app, studentId, scope, body.consent ? 1 : 0, identityHash, now, updatedBy).run();
  if (changes(saved) !== 1) {
    const raced = await currentConsent(env, app, studentId, scope);
    return consentConflict(raced.view, origin, json);
  }
  return json({ ok: true, idempotent: false, consent: {
    studentId, scope, consent: body.consent, needsReconsent: false, updatedAt: now, updatedBy
  } }, 200, origin);
}

async function preview(env, app, body, origin, json) {
  const target = await authoritativeTarget(env, app, body);
  const prior = await latestTargetState(env, app, target);
  const config = sendConfiguration(env, target.eventType, false);
  if (!config.error && target.eventType === 'makeup_proposal') {
    target.variables['#{보호자앱URL}'] = config.parentPortalUrl;
  }
  const guardian = await contactFor(env, app, target.student, target.scope);
  const portal = await portalAccessForProposal(env, app, target, guardian);
  const gateCode = text(env.WB_GUARDIAN_OPS_SEND_ENABLED) === 'true' ? '' : 'SEND_DISABLED';
  const priorCode = prior && ['dispatching', 'unknown'].includes(prior.status) ? 'PRIOR_SEND_UNCERTAIN'
    : prior && prior.status === 'accepted' ? 'ALREADY_ACCEPTED' : '';
  const blocker = priorCode || gateCode || config.error || guardian.error || portal.error || '';
  return json({ ok: true, preview: {
    eventType: target.eventType, sourceId: target.sourceId, revision: target.revision,
    studentId: target.student.id, studentName: text(target.student.name), scope: target.scope,
    variables: target.variables, ready: !blocker, blocker: blocker || undefined,
    retryAllowed: !!(prior && prior.status === 'rejected'), prior: prior || undefined
  } }, 200, origin);
}

async function send(env, app, body, auth, origin, json) {
  const target = await authoritativeTarget(env, app, body);
  const prior = await latestTargetState(env, app, target);
  if (prior && prior.status === 'accepted') {
    return json({ ok: true, idempotent: true, status: 'accepted', send: prior }, 200, origin);
  }
  if (prior && ['dispatching', 'unknown'].includes(prior.status)) {
    return json({ ok: false, idempotent: true, status: 'unknown', code: 'PRIOR_SEND_UNCERTAIN',
      error: blockerMessage('PRIOR_SEND_UNCERTAIN'), send: prior }, 202, origin);
  }
  const config = sendConfiguration(env, target.eventType, true);
  if (config.error) return json({ ok: false, code: config.error, error: blockerMessage(config.error) }, 503, origin);
  if (target.eventType === 'makeup_proposal') target.variables['#{보호자앱URL}'] = config.parentPortalUrl;
  const guardian = await contactFor(env, app, target.student, target.scope);
  if (guardian.error) return json({ ok: false, code: guardian.error, error: blockerMessage(guardian.error) }, 409, origin);
  const portal = await portalAccessForProposal(env, app, target, guardian);
  if (portal.error) return json({ ok: false, code: portal.error, error: blockerMessage(portal.error) }, 409, origin);

  const reservation = await reserveSend(env, app, target, guardian, portal, config, auth);
  if (!reservation) {
    const raced = await latestTargetState(env, app, target);
    if (raced && raced.status === 'accepted') {
      return json({ ok: true, idempotent: true, status: 'accepted', send: raced }, 200, origin);
    }
    if (raced && ['dispatching', 'unknown'].includes(raced.status)) {
      return json({ ok: false, idempotent: true, status: 'unknown', code: 'PRIOR_SEND_UNCERTAIN',
        error: blockerMessage('PRIOR_SEND_UNCERTAIN'), send: raced }, 202, origin);
    }
    const currentGuardian = await contactFor(env, app, target.student, target.scope);
    if (currentGuardian.error) {
      return json({ ok: false, code: currentGuardian.error, error: blockerMessage(currentGuardian.error) }, 409, origin);
    }
    if (currentGuardian.identityHash !== guardian.identityHash ||
        currentGuardian.portalIdentityHash !== guardian.portalIdentityHash) {
      return json({ ok: false, code: 'GUARDIAN_PHONE_CHANGED_BEFORE_DISPATCH',
        error: blockerMessage('GUARDIAN_PHONE_CHANGED_BEFORE_DISPATCH') }, 409, origin);
    }
    const currentPortal = await portalAccessForProposal(env, app, target, currentGuardian);
    if (currentPortal.error || currentPortal.updatedAt !== portal.updatedAt ||
        currentPortal.identityHash !== portal.identityHash || currentPortal.scopeVersion !== portal.scopeVersion) {
      const code = currentPortal.error || 'PORTAL_ACCESS_REVOKED_BEFORE_DISPATCH';
      return json({ ok: false, code, error: blockerMessage(code) }, 409, origin);
    }
    const currentSource = await revalidateAuthoritativeSource(
      env, app, target, config, await sha256Hex(JSON.stringify(target.variables))
    );
    if (currentSource.error) {
      return json({ ok: false, code: currentSource.error, error: blockerMessage(currentSource.error) }, 409, origin);
    }
    return json({ ok: false, code: 'DAILY_SEND_LIMIT', error: blockerMessage('DAILY_SEND_LIMIT') }, 429, origin);
  }

  // 예약 뒤에도 연락처·동의·보호자 웹앱 identity와 원본 상태/변수를 함께 재검증한다.
  // 원본이 바뀌면 공급자 호출 없이 rejected 결과만 append한다.
  let dispatch = await dispatchSnapshot(env, app, target, guardian, portal, config, reservation.variablesHash);
  if (dispatch.error) {
    return rejectedReservation(env, app, reservation, dispatch.error, origin, json);
  }

  // 1회용 코드는 예약이 성공한 신규 dispatch에서만 발급한다. 원문 URL/code는
  // idempotency hash·append-only 원장·API 응답에 넣지 않고 Solapi 변수로만 즉시 전달한다.
  let inviteCode = '';
  if (target.eventType === 'makeup_proposal') {
    const invite = await issueGuardianPortalInvite(env, {
      studentId: target.student.id,
      issuedBy: actor(auth),
      requiredScopeVersion: 1
    });
    if (!invite.ok) {
      const inviteRejectionCode = String(invite.errorCode || '').startsWith('PORTAL_')
        ? 'PORTAL_ACCESS_REVOKED_BEFORE_DISPATCH' : 'GUARDIAN_PHONE_CHANGED_BEFORE_DISPATCH';
      return rejectedReservation(env, app, reservation, inviteRejectionCode, origin, json);
    }
    inviteCode = invite.code;
    // 코드 발급 중 원본/identity가 바뀌었을 수 있으므로 실제 fetch 직전에 다시 확인한다.
    dispatch = await dispatchSnapshot(env, app, target, guardian, portal, config, reservation.variablesHash);
    if (dispatch.error) {
      return rejectedReservation(env, app, reservation, dispatch.error, origin, json, inviteCode);
    }
    dispatch.target.variables['#{보호자앱URL}'] = portalInviteUrl(config.parentPortalUrl, inviteCode);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOLAPI_TIMEOUT_MS);
  let response;
  let raw;
  try {
    response = await fetch(SOLAPI_SEND_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=utf-8',
        Authorization: await solapiAuthorization(config.apiKey, config.apiSecret)
      },
      body: JSON.stringify({
        messages: [{
          to: dispatch.guardian.phone, from: config.sender, type: 'ATA',
          kakaoOptions: {
            pfId: config.pfId, templateId: config.templateId,
            disableSms: true, variables: dispatch.target.variables
          },
          customFields: { wbSendId: reservation.sendId }
        }],
        strict: true, allowDuplicates: false, showMessageList: true
      }),
      signal: controller.signal
    });
    raw = await response.text();
  } catch (error) {
    clearTimeout(timeout);
    const outcome = { status: 'unknown', errorCode: controller.signal.aborted ? 'SOLAPI_TIMEOUT' : 'SOLAPI_NETWORK' };
    const recorded = await appendOutcome(env, app, reservation.sendId, outcome);
    const code = recorded ? outcome.errorCode : 'SEND_RESULT_NOT_RECORDED';
    return json({ ok: false, status: 'unknown', code, error: blockerMessage('PRIOR_SEND_UNCERTAIN') }, 202, origin);
  }
  clearTimeout(timeout);

  let outcome;
  try {
    const tooLarge = new TextEncoder().encode(raw).byteLength > MAX_PROVIDER_RESPONSE_BYTES;
    if (tooLarge) {
      outcome = response.ok ? { status: 'unknown', errorCode: 'SOLAPI_RESPONSE_TOO_LARGE' }
        : providerOutcome(response, {});
    } else {
      let payload = {};
      try { payload = raw ? JSON.parse(raw) : {}; }
      catch (error) { if (response.ok) throw error; }
      outcome = providerOutcome(response, payload);
    }
  } catch (error) {
    outcome = { status: 'unknown', errorCode: 'SOLAPI_INVALID_RESPONSE' };
  }
  if (!await appendOutcome(env, app, reservation.sendId, outcome)) {
    return json({ ok: false, status: 'unknown', code: 'SEND_RESULT_NOT_RECORDED',
      error: blockerMessage('PRIOR_SEND_UNCERTAIN') }, 202, origin);
  }
  const status = outcome.status === 'accepted' ? 200 : outcome.status === 'rejected' ? 502 : 202;
  return json({
    ok: outcome.status === 'accepted', idempotent: false, status: outcome.status,
    code: outcome.errorCode || undefined,
    send: { sendId: reservation.sendId, attemptNo: prior ? prior.attemptNo + 1 : 1, createdAt: reservation.now }
  }, status, origin);
}

export async function handleGuardianOpsSend(env, app, body, origin, auth, json) {
  try {
    if (app !== 'task') fail('APP_INVALID', '운영 알림톡은 직원 앱에서만 사용할 수 있습니다', 400);
    if (!auth || auth.scope !== 'all') fail('FORBIDDEN', '운영 알림톡은 원장·관리 담당만 관리할 수 있습니다', 403);
    const action = String(body && body.action || '');
    if (action === 'consent_list') exactBody(body, []);
    else if (action === 'consent_set') exactBody(body, ['studentId', 'scope', 'consent', 'expectedUpdatedAt']);
    else if (action === 'preview' || action === 'send') exactBody(body, ['eventType', 'sourceId', 'revision']);
    else fail('ACTION_INVALID', 'action은 consent_list, consent_set, preview, send 중 하나여야 합니다', 400);

    if (action === 'consent_list') return await consentList(env, app, origin, json);
    if (action === 'consent_set') return await consentSet(env, app, body, auth, origin, json);
    if (action === 'preview') return await preview(env, app, body, origin, json);
    return await send(env, app, body, auth, origin, json);
  } catch (error) {
    if (error instanceof PublicError) {
      return json({ ok: false, code: error.code, error: error.message }, error.status, origin);
    }
    throw error;
  }
}

export const guardianOpsContract = Object.freeze({
  route: '/guardian-ops-send',
  handler: 'handleGuardianOpsSend',
  enabledEnv: 'WB_GUARDIAN_OPS_SEND_ENABLED',
  templateEnv: TEMPLATE_ENV,
  parentPortalBaseUrlEnv: 'WB_PARENT_PORTAL_BASE_URL'
});
