/**
 * consult 학생 개인 링크 연락처와 Solapi 알림톡 접수.
 * 전화번호는 D1 전용 테이블에서만 읽고, 클라이언트는 발송 문구·URL·수신자를 지정할 수 없다.
 *
 * POST /consult-link-send
 *   { app:'consult', auth, action:'list' }
 *   { app:'consult', auth, action:'set', staffId, phone, consent, expectedUpdatedAt }
 *   { app:'consult', auth, action:'send', staffId }
 */

import { buildSolapiAuthorization, kstDateFromMs } from './director-report-send.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_CODE = /^[a-f0-9]{48}$/;
const SAFE_PHONE = /^01[016789]\d{7,8}$/;
const SOLAPI_SEND_URL = 'https://api.solapi.com/messages/v4/send-many/detail';
export const SOLAPI_TIMEOUT_MS = 8000;
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;
export const CONSULT_LINK_GLOBAL_DAILY_LIMIT = 150;
export const CONSULT_LINK_TEMPLATE_BUTTON_URL =
  'https://whdudwns33-wb.github.io/wb-site/consult/?u=#{학생ID}#c=#{연결코드}';
export const CONSULT_LINK_TEMPLATE_VARIABLE_KEYS = Object.freeze([
  '#{학생명}', '#{학생ID}', '#{연결코드}'
]);

class PublicError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status) {
  throw new PublicError(code, message, status);
}

function text(value) {
  return String(value == null ? '' : value).normalize('NFKC').trim();
}

function digits(value) {
  return String(value == null ? '' : value).replace(/[\s()-]/g, '');
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    return null;
  }
}

function changes(result) {
  return Number(result && result.meta && result.meta.changes || 0);
}

function exactBody(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail('REQUEST_INVALID', '요청 형식을 확인해 주세요', 400);
  }
  const allowed = new Set(['app', 'auth', 'action', ...fields]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      fail('REQUEST_FIELD_FORBIDDEN', '수신자·문구·링크는 요청에서 지정할 수 없습니다', 400);
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

function actor(auth) {
  const id = String(auth && auth.id || '');
  return SAFE_ID.test(id) ? id : 'director';
}

function maskPhone(phone) {
  const normalized = digits(phone);
  return SAFE_PHONE.test(normalized)
    ? normalized.slice(0, 3) + '****' + normalized.slice(-4)
    : '';
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(String(value == null ? '' : value))
  );
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function publicContact(row, fallback) {
  const phoneMasked = maskPhone(row && row.phone);
  return {
    staffId: String(row && row.staff_id || fallback.id),
    studentName: text(row && row.student_name || fallback.name),
    phoneRegistered: !!phoneMasked,
    phoneMasked: phoneMasked || undefined,
    consent: !!Number(row && row.consent),
    updatedAt: Number(row && row.updated_at || 0)
  };
}

function studentFromRow(row) {
  if (!row || !SAFE_ID.test(String(row.id || ''))) return null;
  const data = parseObject(row.data);
  if (!data || data.deleted || data.owner || data.manager) return null;
  if (data.id != null && String(data.id) !== String(row.id)) return null;
  const name = text(data.name);
  if (!name || Array.from(name).length > 40 || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return { id: String(row.id), name, dataText: String(row.data) };
}

async function activeStudent(env, staffId) {
  if (!SAFE_ID.test(String(staffId || ''))) {
    fail('STUDENT_INVALID', '학생을 다시 선택해 주세요', 400);
  }
  const row = await env.DB.prepare(
    "SELECT id,data FROM staff WHERE app='consult' AND id=? LIMIT 1"
  ).bind(String(staffId)).first();
  const student = studentFromRow(row);
  if (!student) fail('STUDENT_NOT_ACTIVE', '현재 학생 명단에서 대상을 찾을 수 없습니다', 409);
  return student;
}

async function contactRow(env, staffId) {
  return env.DB.prepare(
    "SELECT staff_id,student_name,phone,consent,updated_at,updated_by " +
    "FROM consult_link_contacts WHERE app='consult' AND staff_id=? LIMIT 1"
  ).bind(staffId).first();
}

async function listContacts(env, origin, json) {
  const result = await env.DB.prepare(
    "SELECT id,data FROM staff WHERE app='consult' ORDER BY id"
  ).all();
  const students = (result.results || []).map(studentFromRow).filter(Boolean);
  const contacts = new Map();
  const contactResult = await env.DB.prepare(
    "SELECT staff_id,student_name,phone,consent,updated_at,updated_by " +
    "FROM consult_link_contacts WHERE app='consult'"
  ).all();
  for (const row of (contactResult.results || [])) contacts.set(String(row.staff_id), row);
  const items = students.map(student => publicContact(contacts.get(student.id), student));
  items.sort((left, right) => left.studentName.localeCompare(right.studentName, 'ko-KR') ||
    left.staffId.localeCompare(right.staffId));
  return json({ ok: true, contacts: items }, 200, origin);
}

function contactConflict(row, student, origin, json) {
  return json({
    ok: false,
    code: 'CONTACT_CONFLICT',
    error: '다른 기기에서 연락처가 변경되었습니다. 새로고침 후 다시 시도해 주세요',
    current: row ? publicContact(row, student) : {
      staffId: student.id, studentName: student.name, phoneRegistered: false,
      consent: false, updatedAt: 0
    }
  }, 409, origin);
}

async function setContact(env, body, auth, origin, json) {
  const student = await activeStudent(env, String(body.staffId || ''));
  if (typeof body.consent !== 'boolean') {
    fail('CONSENT_INVALID', '발송 동의를 선택해 주세요', 400);
  }
  const expectedUpdatedAt = Number(body.expectedUpdatedAt);
  if (!Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt < 0) {
    fail('REVISION_INVALID', '연락처 변경 기준 시각을 확인해 주세요', 400);
  }
  const phone = digits(body.phone);
  if (phone && !SAFE_PHONE.test(phone)) {
    fail('PHONE_INVALID', '휴대전화 번호를 확인해 주세요', 400);
  }
  if (body.consent && !phone) {
    fail('PHONE_REQUIRED', '발송에 동의하려면 휴대전화 번호를 등록해 주세요', 400);
  }

  const before = await contactRow(env, student.id);
  if ((!before && expectedUpdatedAt !== 0) ||
      (before && Number(before.updated_at) !== expectedUpdatedAt)) {
    return contactConflict(before, student, origin, json);
  }

  const now = Math.max(Date.now(), expectedUpdatedAt + 1);
  let saved;
  if (before) {
    saved = await env.DB.prepare(
      "UPDATE consult_link_contacts SET student_name=?,phone=?,consent=?,updated_at=?,updated_by=? " +
      "WHERE app='consult' AND staff_id=? AND updated_at=?"
    ).bind(student.name, phone || null, body.consent ? 1 : 0, now, actor(auth),
      student.id, expectedUpdatedAt).run();
  } else {
    saved = await env.DB.prepare(
      "INSERT OR IGNORE INTO consult_link_contacts " +
      "(app,staff_id,student_name,phone,consent,updated_at,updated_by) " +
      "VALUES('consult',?,?,?,?,?,?)"
    ).bind(student.id, student.name, phone || null, body.consent ? 1 : 0, now, actor(auth)).run();
  }
  if (changes(saved) !== 1) {
    return contactConflict(await contactRow(env, student.id), student, origin, json);
  }
  const current = await contactRow(env, student.id);
  return json({ ok: true, contact: publicContact(current, student) }, 200, origin);
}

function sendConfiguration(env) {
  if (String(env.WB_CONSULT_LINK_SEND_ENABLED || '') !== 'true') {
    return { error: 'SEND_DISABLED' };
  }
  const apiKey = text(env.SOLAPI_KAKAO_API_KEY);
  const apiSecret = text(env.SOLAPI_KAKAO_API_SECRET);
  const pfId = text(env.SOLAPI_KAKAO_PF_ID);
  const templateId = text(env.SOLAPI_KAKAO_CONSULT_LINK_APPROVED_TEMPLATE_ID);
  const sender = digits(env.SOLAPI_SENDER_NUMBER);
  if (!apiKey || !apiSecret || !SAFE_ID.test(pfId) || !SAFE_ID.test(templateId) ||
      !/^\d{8,12}$/.test(sender)) {
    return { error: 'SEND_NOT_CONFIGURED' };
  }
  return { apiKey, apiSecret, pfId, templateId, sender };
}

function blockerMessage(code) {
  return ({
    SEND_DISABLED: '학생 링크 발송 기능이 현재 중지되어 있습니다',
    SEND_NOT_CONFIGURED: '승인된 알림톡 발송 설정을 확인해 주세요',
    CONTACT_MISSING: '학생 연락처를 먼저 등록해 주세요',
    CONSENT_MISSING: '학생 링크 발송 동의를 먼저 받아 주세요',
    CONTACT_STALE: '학생 정보가 변경되었습니다. 연락처를 다시 확인해 주세요',
    DAILY_SEND_LIMIT: '오늘 발송 한도에 도달했습니다',
    PRIOR_SEND_IN_PROGRESS: '앞선 발송을 접수 처리하고 있습니다',
    PRIOR_SEND_UNCERTAIN: '앞선 발송의 접수 여부를 확인해 주세요',
    BOOTSTRAP_REVOKE_FAILED: '일회용 링크 폐기 여부를 확인할 수 없습니다',
    LINK_ISSUE_FAILED: '학생 연결 링크를 만들지 못했습니다. 다시 시도해 주세요',
    SOURCE_CHANGED: '학생 또는 연락처 정보가 바뀌었습니다. 다시 확인해 주세요'
  })[code] || '알림톡을 접수하지 못했습니다';
}

function publicSend(row) {
  const status = String(row && row.status || 'dispatching');
  const label = ({
    dispatching: '접수 처리 중', accepted: '접수됨', rejected: '접수 실패',
    unknown: '접수 여부 확인 필요'
  })[status] || '접수 처리 중';
  return {
    sendId: String(row && row.send_id || ''),
    staffId: String(row && row.staff_id || ''),
    attemptNo: Number(row && row.attempt_no || 0),
    status,
    statusLabel: label,
    providerAcceptedOnly: status === 'accepted',
    createdAt: Number(row && row.created_at || 0)
  };
}

async function priorBlockingSend(env, staffId, sendDate) {
  return env.DB.prepare(
    "SELECT send_id,staff_id,attempt_no,status,created_at FROM consult_link_sends " +
    "WHERE app='consult' AND staff_id=? AND send_date=? " +
    "AND status IN ('dispatching','accepted','unknown') ORDER BY attempt_no DESC LIMIT 1"
  ).bind(staffId, sendDate).first();
}

function priorResponse(prior, origin, json) {
  const send = publicSend(prior);
  if (String(prior.status) === 'accepted') {
    return json({
      ok: true, idempotent: true, status: 'accepted', statusLabel: '접수됨', send,
      notice: 'Solapi 공급자 접수이며 단말 도착·열람 완료가 아닙니다'
    }, 200, origin);
  }
  const dispatching = String(prior.status) === 'dispatching';
  return json({
    ok: false, idempotent: true, status: dispatching ? 'dispatching' : 'unknown',
    code: dispatching ? 'PRIOR_SEND_IN_PROGRESS' : 'PRIOR_SEND_UNCERTAIN',
    error: blockerMessage(dispatching ? 'PRIOR_SEND_IN_PROGRESS' : 'PRIOR_SEND_UNCERTAIN'), send
  }, 202, origin);
}

async function authoritativeSnapshot(env, student) {
  const contact = await contactRow(env, student.id);
  if (!contact || !SAFE_PHONE.test(digits(contact.phone))) {
    fail('CONTACT_MISSING', blockerMessage('CONTACT_MISSING'), 409);
  }
  if (!Number(contact.consent)) fail('CONSENT_MISSING', blockerMessage('CONSENT_MISSING'), 409);
  if (text(contact.student_name) !== student.name) {
    fail('CONTACT_STALE', blockerMessage('CONTACT_STALE'), 409);
  }
  return {
    phone: digits(contact.phone),
    revision: Number(contact.updated_at),
    studentName: text(contact.student_name)
  };
}

async function reserveSend(env, student, contact, config, sendDate) {
  const previous = await env.DB.prepare(
    "SELECT COALESCE(MAX(attempt_no),0) AS attempt_no FROM consult_link_sends " +
    "WHERE app='consult' AND staff_id=? AND send_date=?"
  ).bind(student.id, sendDate).first();
  const attemptNo = Number(previous && previous.attempt_no || 0) + 1;
  const idempotencyKey = await sha256Hex([
    'consult-link-ata-v1', sendDate, student.id, contact.revision, config.templateId, attemptNo
  ].join('\u001f'));
  const sendId = 'cls_' + idempotencyKey.slice(0, 48);
  const now = Date.now();
  const inserted = await env.DB.prepare(
    "INSERT OR IGNORE INTO consult_link_sends " +
    "(app,send_id,idempotency_key,send_date,staff_id,contact_revision," +
    "template_id,attempt_no,status,dispatch_started_at,created_at,updated_at) " +
    "SELECT 'consult',?,?,?,?,?,?,?, 'dispatching',?,?,? " +
    "WHERE (SELECT COUNT(*) FROM consult_link_sends WHERE app='consult' AND send_date=?)<? " +
    "AND EXISTS (SELECT 1 FROM consult_link_contacts c WHERE c.app='consult' AND c.staff_id=? " +
    "AND c.student_name=? AND c.phone=? AND c.consent=1 AND c.updated_at=?) " +
    "AND EXISTS (SELECT 1 FROM staff s WHERE s.app='consult' AND s.id=? AND s.data=? " +
    "AND json_valid(s.data) AND COALESCE(json_extract(s.data,'$.deleted'),0)=0 " +
    "AND COALESCE(json_extract(s.data,'$.owner'),0)=0 " +
    "AND COALESCE(json_extract(s.data,'$.manager'),0)=0) " +
    "AND NOT EXISTS (SELECT 1 FROM consult_link_sends prior WHERE prior.app='consult' " +
    "AND prior.staff_id=? AND prior.send_date=? AND prior.status IN ('dispatching','accepted','unknown'))"
  ).bind(sendId, idempotencyKey, sendDate, student.id, contact.revision, config.templateId,
    attemptNo, now, now, now, sendDate, CONSULT_LINK_GLOBAL_DAILY_LIMIT,
    student.id, student.name, contact.phone, contact.revision,
    student.id, student.dataText, student.id, sendDate).run();
  if (changes(inserted) !== 1) return null;
  return { sendId, attemptNo, now };
}

async function snapshotStillCurrent(env, student, contact) {
  const current = await env.DB.prepare(
    "SELECT s.data,c.student_name,c.phone,c.consent,c.updated_at FROM staff s " +
    "JOIN consult_link_contacts c ON c.app=s.app AND c.staff_id=s.id " +
    "WHERE s.app='consult' AND s.id=? LIMIT 1"
  ).bind(student.id).first();
  if (!current || String(current.data) !== student.dataText ||
      text(current.student_name) !== student.name || digits(current.phone) !== contact.phone ||
      Number(current.consent) !== 1 || Number(current.updated_at) !== contact.revision) return false;
  return !!studentFromRow({ id: student.id, data: current.data });
}

function safeProviderId(value) {
  const normalized = String(value || '');
  return SAFE_ID.test(normalized) ? normalized : null;
}

function safeProviderStatus(value) {
  const normalized = String(value || '');
  return /^\d{1,16}$/.test(normalized) ? normalized : null;
}

function providerOutcome(response, payload) {
  if (!response.ok) {
    return response.status >= 400 && response.status < 500
      ? { status: 'rejected', errorCode: 'SOLAPI_HTTP_' + response.status }
      : { status: 'unknown', errorCode: 'SOLAPI_HTTP_' + response.status };
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
  if (!groupId || !messageId || !statusCode) {
    return { status: 'unknown', errorCode: 'SOLAPI_AMBIGUOUS_RESPONSE' };
  }
  const provider = { groupId, messageId, statusCode };
  return ['2000', '3000', '4000'].includes(statusCode)
    ? { status: 'accepted', provider }
    : { status: 'rejected', provider, errorCode: 'SOLAPI_STATUS_' + statusCode };
}

async function finishSend(env, reservation, outcome) {
  const provider = outcome.provider || {};
  const result = await env.DB.prepare(
    "UPDATE consult_link_sends SET status=?,provider_group_id=?,provider_message_id=?," +
    "provider_status_code=?,safe_error_code=?,updated_at=? " +
    "WHERE app='consult' AND send_id=? AND status='dispatching'"
  ).bind(outcome.status, provider.groupId || null, provider.messageId || null,
    provider.statusCode || null, outcome.errorCode || null,
    Math.max(Date.now(), reservation.now + 1), reservation.sendId).run();
  return changes(result) === 1;
}

async function rejectReservation(env, reservation, code, origin, json) {
  const outcome = { status: 'rejected', errorCode: code };
  if (!await finishSend(env, reservation, outcome)) {
    return json({ ok: false, status: 'unknown', code: 'SEND_RESULT_NOT_RECORDED',
      error: blockerMessage('PRIOR_SEND_UNCERTAIN') }, 202, origin);
  }
  return json({ ok: false, status: 'rejected', code, error: blockerMessage(code), send: {
    sendId: reservation.sendId, attemptNo: reservation.attemptNo,
    status: 'rejected', statusLabel: '접수 실패', createdAt: reservation.now
  } }, 409, origin);
}

async function unknownReservation(env, reservation, code, origin, json) {
  const recorded = await finishSend(env, reservation, { status: 'unknown', errorCode: code });
  return json({
    ok: false, status: 'unknown',
    code: recorded ? code : 'SEND_RESULT_NOT_RECORDED',
    error: blockerMessage(code)
  }, 202, origin);
}

async function revokeIssuedCode(revokeBootstrapForStudent, staffId, code) {
  try {
    return await revokeBootstrapForStudent(staffId, code) === true;
  } catch (error) {
    return false;
  }
}

async function rejectIssuedReservation(
  env, reservation, rejectionCode, staffId, issuedCode,
  origin, json, revokeBootstrapForStudent
) {
  if (!await revokeIssuedCode(revokeBootstrapForStudent, staffId, issuedCode)) {
    return unknownReservation(env, reservation, 'BOOTSTRAP_REVOKE_FAILED', origin, json);
  }
  return rejectReservation(env, reservation, rejectionCode, origin, json);
}

async function sendLink(
  env, body, origin, json, issueBootstrapForStudent, revokeBootstrapForStudent
) {
  const student = await activeStudent(env, String(body.staffId || ''));
  const contact = await authoritativeSnapshot(env, student);
  const sendDate = kstDateFromMs(Date.now());
  const prior = await priorBlockingSend(env, student.id, sendDate);
  if (prior) return priorResponse(prior, origin, json);

  const config = sendConfiguration(env);
  if (config.error) fail(config.error, blockerMessage(config.error), 503);
  const reservation = await reserveSend(env, student, contact, config, sendDate);
  if (!reservation) {
    const raced = await priorBlockingSend(env, student.id, sendDate);
    if (raced) return priorResponse(raced, origin, json);
    if (!await snapshotStillCurrent(env, student, contact)) {
      fail('SOURCE_CHANGED', blockerMessage('SOURCE_CHANGED'), 409);
    }
    fail('DAILY_SEND_LIMIT', blockerMessage('DAILY_SEND_LIMIT'), 429);
  }

  if (!await snapshotStillCurrent(env, student, contact)) {
    return rejectReservation(env, reservation, 'SOURCE_CHANGED', origin, json);
  }

  let issued;
  try {
    issued = await issueBootstrapForStudent(student.id);
  } catch (error) {
    return rejectReservation(env, reservation, 'LINK_ISSUE_FAILED', origin, json);
  }
  if (!issued || !SAFE_CODE.test(String(issued.code || ''))) {
    return rejectReservation(env, reservation, 'LINK_ISSUE_FAILED', origin, json);
  }

  if (!await snapshotStillCurrent(env, student, contact)) {
    return rejectIssuedReservation(
      env, reservation, 'SOURCE_CHANGED', student.id, issued.code,
      origin, json, revokeBootstrapForStudent
    );
  }

  const variables = {
    '#{학생명}': student.name,
    '#{학생ID}': student.id,
    '#{연결코드}': String(issued.code)
  };
  if (Object.keys(variables).length !== CONSULT_LINK_TEMPLATE_VARIABLE_KEYS.length ||
      !CONSULT_LINK_TEMPLATE_VARIABLE_KEYS.every(key => Object.hasOwn(variables, key))) {
    return rejectIssuedReservation(
      env, reservation, 'LINK_ISSUE_FAILED', student.id, issued.code,
      origin, json, revokeBootstrapForStudent
    );
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
        Authorization: await buildSolapiAuthorization(config.apiKey, config.apiSecret)
      },
      body: JSON.stringify({
        messages: [{
          to: contact.phone,
          from: config.sender,
          type: 'ATA',
          kakaoOptions: {
            pfId: config.pfId,
            templateId: config.templateId,
            disableSms: true,
            variables
          },
          customFields: { wbSendId: reservation.sendId }
        }],
        strict: true,
        allowDuplicates: false,
        showMessageList: true
      }),
      signal: controller.signal
    });
    raw = await response.text();
  } catch (error) {
    clearTimeout(timeout);
    const outcome = {
      status: 'unknown', errorCode: controller.signal.aborted ? 'SOLAPI_TIMEOUT' : 'SOLAPI_NETWORK'
    };
    const recorded = await finishSend(env, reservation, outcome);
    return json({
      ok: false, status: 'unknown',
      code: recorded ? outcome.errorCode : 'SEND_RESULT_NOT_RECORDED',
      error: blockerMessage('PRIOR_SEND_UNCERTAIN')
    }, 202, origin);
  }
  clearTimeout(timeout);

  let outcome;
  const tooLarge = new TextEncoder().encode(raw).byteLength > MAX_PROVIDER_RESPONSE_BYTES;
  if (tooLarge) {
    outcome = response.status >= 400 && response.status < 500
      ? { status: 'rejected', errorCode: 'SOLAPI_HTTP_' + response.status }
      : { status: 'unknown', errorCode: 'SOLAPI_RESPONSE_TOO_LARGE' };
  } else {
    let payload = {};
    let validJson = true;
    try { payload = raw ? JSON.parse(raw) : {}; }
    catch (error) { validJson = false; }
    outcome = validJson
      ? providerOutcome(response, payload)
      : (response.status >= 400 && response.status < 500
        ? { status: 'rejected', errorCode: 'SOLAPI_HTTP_' + response.status }
        : { status: 'unknown', errorCode: 'SOLAPI_INVALID_RESPONSE' });
  }

  if (outcome.status === 'rejected' &&
      !await revokeIssuedCode(revokeBootstrapForStudent, student.id, issued.code)) {
    outcome = { status: 'unknown', errorCode: 'BOOTSTRAP_REVOKE_FAILED' };
  }

  if (!await finishSend(env, reservation, outcome)) {
    return json({ ok: false, status: 'unknown', code: 'SEND_RESULT_NOT_RECORDED',
      error: blockerMessage('PRIOR_SEND_UNCERTAIN') }, 202, origin);
  }
  const send = {
    sendId: reservation.sendId, staffId: student.id, attemptNo: reservation.attemptNo,
    status: outcome.status,
    statusLabel: outcome.status === 'accepted' ? '접수됨' :
      outcome.status === 'rejected' ? '접수 실패' : '접수 여부 확인 필요',
    providerAcceptedOnly: outcome.status === 'accepted', createdAt: reservation.now
  };
  const statusCode = outcome.status === 'accepted' ? 200 : outcome.status === 'rejected' ? 502 : 202;
  return json({
    ok: outcome.status === 'accepted', idempotent: false, status: outcome.status,
    statusLabel: send.statusLabel, code: outcome.errorCode || undefined, send,
    notice: outcome.status === 'accepted'
      ? 'Solapi 공급자 접수이며 단말 도착·열람 완료가 아닙니다' : undefined
  }, statusCode, origin);
}

export async function handleConsultLinkSend(
  env, app, body, origin, auth, json, issueBootstrapForStudent, revokeBootstrapForStudent
) {
  try {
    if (app !== 'consult') fail('APP_INVALID', '컨설팅 앱에서만 사용할 수 있습니다', 400);
    if (!auth || auth.scope !== 'all') {
      fail('FORBIDDEN', '원장 로그인에서만 학생 링크를 관리할 수 있습니다', 403);
    }
    const action = String(body && body.action || '');
    if (action === 'list') exactBody(body, []);
    else if (action === 'set') exactBody(body, ['staffId', 'phone', 'consent', 'expectedUpdatedAt']);
    else if (action === 'send') exactBody(body, ['staffId']);
    else fail('ACTION_INVALID', 'action은 list, set, send 중 하나여야 합니다', 400);

    if (action === 'list') return await listContacts(env, origin, json);
    if (action === 'set') return await setContact(env, body, auth, origin, json);
    if (typeof issueBootstrapForStudent !== 'function' ||
        typeof revokeBootstrapForStudent !== 'function') {
      fail('LINK_ISSUE_FAILED', blockerMessage('LINK_ISSUE_FAILED'), 503);
    }
    return await sendLink(
      env, body, origin, json, issueBootstrapForStudent, revokeBootstrapForStudent
    );
  } catch (error) {
    if (error instanceof PublicError) {
      return json({ ok: false, code: error.code, error: error.message }, error.status, origin);
    }
    return json({ ok: false, code: 'INTERNAL_ERROR', error: '학생 링크 요청을 처리하지 못했습니다' },
      500, origin);
  }
}
