/** 차량 기사 연락과 승·하차 알림톡. 번호는 stable studentId 연락처 정본에서만 읽고,
 * 기사에게는 KST 오늘 본인 노선의 학생 중 별도 통화 동의가 유효한 번호만 공개한다. */

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EVENTS = new Set(['boarded', 'dropped']);
const SOLAPI_SEND_URL = 'https://api.solapi.com/messages/v4/send-many/detail';
const SOLAPI_TIMEOUT_MS = 8000;
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;
const DAILY_LIMIT = 150;
const TEMPLATE_ENV = Object.freeze({
  boarded: 'SOLAPI_KAKAO_TRANSPORT_BOARDED_APPROVED_TEMPLATE_ID',
  dropped: 'SOLAPI_KAKAO_TRANSPORT_DROPPED_APPROVED_TEMPLATE_ID'
});

// 승인 요청할 템플릿의 고정 문구와 변수 집합. 기사명·번호·주소는 포함하지 않는다.
export const TRANSPORT_TEMPLATE_TEXT = Object.freeze({
  boarded: '안녕하세요, WB 웩슬러브레인센터입니다.\n#{학생명} 학생이 #{운행일} #{확인시각} 차량에 탑승했습니다.\n노선: #{노선명}\n확인지점: #{확인지점}\n문의는 학원 대표번호로 연락해 주세요.',
  dropped: '안녕하세요, WB 웩슬러브레인센터입니다.\n#{학생명} 학생이 #{운행일} #{확인시각} 차량에서 하차했습니다.\n노선: #{노선명}\n확인지점: #{확인지점}\n문의는 학원 대표번호로 연락해 주세요.'
});
export const TRANSPORT_TEMPLATE_VARIABLES = Object.freeze([
  '#{학생명}', '#{운행일}', '#{확인시각}', '#{노선명}', '#{확인지점}'
]);

function fail(message, status = 400, code = '') {
  const error = new Error(message); error.status = status; error.code = code; throw error;
}
function text(value) { return String(value == null ? '' : value).normalize('NFKC').trim(); }
function digits(value) { return String(value || '').replace(/[\s()-]/g, ''); }
function changes(result) { return Number(result && result.meta && result.meta.changes || 0); }
function parseJson(value) { try { return JSON.parse(value || '{}'); } catch (error) { return null; } }
function actor(auth) {
  return auth && auth.role === 'manager' && SAFE_ID.test(String(auth.id || '')) ? String(auth.id) :
    auth && auth.scope === 'own' && SAFE_ID.test(String(auth.id || '')) ? String(auth.id) : 'director';
}
function kstToday(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(now));
}
function kstTime(ms) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date(ms));
}
function weekday(date) { return new Date(date + 'T00:00:00Z').getUTCDay(); }
async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value || '')));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function identityHash(studentId, studentName, phone) {
  return sha256Hex([studentId, text(studentName), digits(phone)].join('\u001f'));
}
function maskedPhone(phone) {
  const value = digits(phone);
  return /^01[016789]\d{7,8}$/.test(value) ? value.slice(0, 3) + '****' + value.slice(-4) : '';
}
function exact(body, allowed) {
  const keys = new Set(['app', 'auth', 'action', ...allowed]);
  for (const key of Object.keys(body || {})) if (!keys.has(key)) fail('허용되지 않은 요청 항목입니다', 400, 'REQUEST_INVALID');
}
async function rosterStudent(env, studentId) {
  if (!SAFE_ID.test(String(studentId || ''))) fail('학생 식별자를 확인해 주세요', 400, 'STUDENT_INVALID');
  const row = await env.DB.prepare('SELECT data FROM private_rosters WHERE app=? LIMIT 1').bind('task').first();
  const document = row && parseJson(row.data);
  const students = document && document.roster && document.roster.students;
  const student = Array.isArray(students) ? students.find(item => item && String(item.id) === studentId) : null;
  if (!student || !text(student.name)) fail('현재 원생 명단에서 학생을 찾을 수 없습니다', 409, 'STUDENT_INACTIVE');
  return { id: studentId, name: text(student.name).slice(0, 40) };
}
async function contactRow(env, studentId) {
  return env.DB.prepare(
    'SELECT student_name,phone,consent,updated_at,transport_call_allowed,transport_boarded_consent,' +
    'transport_dropped_consent,transport_guardian_identity_hash,transport_updated_at,transport_updated_by ' +
    'FROM guardian_contacts_by_student WHERE app=? AND student_id=? LIMIT 1'
  ).bind('task', studentId).first();
}
async function validContact(env, student, purpose) {
  const row = await contactRow(env, student.id);
  if (!row) return { error: 'GUARDIAN_NOT_REGISTERED' };
  if (text(row.student_name) !== student.name) return { error: 'GUARDIAN_IDENTITY_MISMATCH' };
  const phone = digits(row.phone);
  if (!/^01[016789]\d{7,8}$/.test(phone)) return { error: 'GUARDIAN_PHONE_MISSING' };
  const hash = await identityHash(student.id, student.name, phone);
  if (hash !== String(row.transport_guardian_identity_hash || '')) return { error: 'TRANSPORT_RECONSENT_REQUIRED' };
  const allowed = purpose === 'call' ? Number(row.transport_call_allowed) :
    purpose === 'boarded' ? Number(row.transport_boarded_consent) : Number(row.transport_dropped_consent);
  if (!allowed) return { error: purpose === 'call' ? 'CALL_CONSENT_MISSING' : 'TRANSPORT_NOTIFY_CONSENT_MISSING' };
  return { phone, hash, row };
}

function guardianView(student, row, hashMatches, feedbackConsentReset = false) {
  const ready = !!(row && /^01[016789]\d{7,8}$/.test(digits(row.phone)));
  return {
    studentId: student.id, studentName: student.name, maskedPhone: ready ? maskedPhone(row.phone) : '',
    phoneReady: ready, callAllowed: ready && hashMatches && !!Number(row.transport_call_allowed),
    boardedConsent: ready && hashMatches && !!Number(row.transport_boarded_consent),
    droppedConsent: ready && hashMatches && !!Number(row.transport_dropped_consent),
    needsReconsent: ready && !hashMatches,
    contactUpdatedAt: row ? Number(row.updated_at) : 0,
    consentUpdatedAt: row ? Number(row.transport_updated_at) : 0,
    updatedAt: row ? Math.max(Number(row.updated_at), Number(row.transport_updated_at)) : 0,
    feedbackConsentReset: !!feedbackConsentReset
  };
}

export async function getTransportGuardian(env, body, auth) {
  if (!auth || auth.scope !== 'all') fail('보호자 차량 설정은 원장만 관리할 수 있습니다', 403, 'FORBIDDEN');
  exact(body, ['studentId']);
  const student = await rosterStudent(env, String(body.studentId || ''));
  const row = await contactRow(env, student.id);
  const phone = row && digits(row.phone);
  const hashMatches = !!(row && /^01[016789]\d{7,8}$/.test(phone) &&
    await identityHash(student.id, student.name, phone) === String(row.transport_guardian_identity_hash || ''));
  return { ok: true, guardian: guardianView(student, row, hashMatches) };
}

export async function setTransportGuardian(env, body, auth) {
  if (!auth || auth.scope !== 'all') fail('보호자 차량 설정은 원장만 관리할 수 있습니다', 403, 'FORBIDDEN');
  exact(body, ['studentId', 'phone', 'clearPhone', 'confirmNewIdentity', 'callAllowed', 'boardedConsent', 'droppedConsent',
    'expectedContactUpdatedAt', 'expectedConsentUpdatedAt']);
  for (const key of ['callAllowed', 'boardedConsent', 'droppedConsent']) {
    if (typeof body[key] !== 'boolean') fail('통화·탑승·하차 동의 여부를 확인해 주세요', 400, 'CONSENT_INVALID');
  }
  const expectedContact = Number(body.expectedContactUpdatedAt);
  const expectedConsent = Number(body.expectedConsentUpdatedAt);
  if (!Number.isSafeInteger(expectedContact) || expectedContact < 0 ||
      !Number.isSafeInteger(expectedConsent) || expectedConsent < 0) {
    fail('현재 연락처·동의 revision이 필요합니다', 400, 'CONSENT_REVISION_REQUIRED');
  }
  if (body.clearPhone != null && typeof body.clearPhone !== 'boolean') fail('연락처 삭제 여부를 확인해 주세요', 400);
  const student = await rosterStudent(env, String(body.studentId || ''));
  const before = await contactRow(env, student.id);
  if ((before ? Number(before.updated_at) : 0) !== expectedContact ||
      (before ? Number(before.transport_updated_at) : 0) !== expectedConsent) {
    fail('보호자 연락처 또는 차량 동의가 변경되었습니다. 새로고침 후 다시 저장해 주세요', 409,
      'GUARDIAN_REVISION_CONFLICT');
  }
  const supplied = digits(body.phone);
  let phone = body.clearPhone ? '' : supplied || digits(before && before.phone);
  if (phone && !/^01[016789]\d{7,8}$/.test(phone)) fail('올바른 휴대폰 번호를 입력해 주세요', 400, 'PHONE_INVALID');
  if (!phone && (body.callAllowed || body.boardedConsent || body.droppedConsent)) {
    fail('연락처 없이는 차량 통화·알림 동의를 켤 수 없습니다', 400, 'PHONE_REQUIRED');
  }
  if (!before && !phone) fail('보호자 연락처를 먼저 입력해 주세요', 400, 'PHONE_REQUIRED');
  const previousPhone = digits(before && before.phone);
  const phoneChanged = previousPhone !== phone;
  const identityLabelChanged = !!(before && text(before.student_name) !== student.name);
  const previousHashMatches = !!(before && phone &&
    await identityHash(student.id, student.name, phone) === String(before.transport_guardian_identity_hash || ''));
  const anyTransportAllowed = body.callAllowed || body.boardedConsent || body.droppedConsent;
  if (phone && anyTransportAllowed &&
      (phoneChanged || !previousHashMatches) &&
      body.confirmNewIdentity !== true) {
    fail('새 번호의 보호자에게 차량 통화·알림 동의를 직접 확인해 주세요', 400,
      'CONFIRM_NEW_IDENTITY_REQUIRED');
  }
  const contactIdentityChanged = phoneChanged || identityLabelChanged;
  const feedbackConsentReset = contactIdentityChanged && !!Number(before && before.consent);
  const now = Math.max(Date.now(), expectedContact + 1, expectedConsent + 1);
  const contactUpdatedAt = contactIdentityChanged || !before ? now : expectedContact;
  // 세 목적이 모두 꺼지면 확인 결합도 폐기한다. 이후 재활성화에는 다시 직접 확인이 필요하다.
  const transportHash = phone && anyTransportAllowed ? await identityHash(student.id, student.name, phone) : null;
  let result;
  if (!before) {
    result = await env.DB.prepare(
      'INSERT OR IGNORE INTO guardian_contacts_by_student ' +
      '(app,student_id,student_name,phone,consent,updated_at,updated_by,transport_call_allowed,' +
      'transport_boarded_consent,transport_dropped_consent,transport_guardian_identity_hash,' +
      'transport_updated_at,transport_updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind('task', student.id, student.name, phone || null, 0, contactUpdatedAt, actor(auth),
      body.callAllowed ? 1 : 0, body.boardedConsent ? 1 : 0, body.droppedConsent ? 1 : 0,
      transportHash, now, actor(auth)).run();
  } else {
    result = await env.DB.prepare(
      'UPDATE guardian_contacts_by_student SET student_name=?,phone=?,consent=?,updated_at=?,updated_by=?,' +
      'transport_call_allowed=?,transport_boarded_consent=?,transport_dropped_consent=?,' +
      'transport_guardian_identity_hash=?,transport_updated_at=?,transport_updated_by=? ' +
      'WHERE app=? AND student_id=? AND updated_at=? AND transport_updated_at=?'
    ).bind(student.name, phone || null, contactIdentityChanged ? 0 : Number(before.consent), contactUpdatedAt, actor(auth),
      body.callAllowed ? 1 : 0, body.boardedConsent ? 1 : 0, body.droppedConsent ? 1 : 0,
      transportHash, now, actor(auth), 'task', student.id, expectedContact, expectedConsent).run();
  }
  if (changes(result) !== 1) fail('보호자 연락처 또는 차량 동의가 변경되었습니다', 409,
    'GUARDIAN_REVISION_CONFLICT');
  const saved = await contactRow(env, student.id);
  const savedHashMatches = !!(phone && transportHash && transportHash ===
    String(saved.transport_guardian_identity_hash || ''));
  return { ok: true, guardian: guardianView(student, saved, savedHashMatches, feedbackConsentReset) };
}

export async function addOwnDriverContacts(env, date, auth, routes) {
  const personalDriver = auth && SAFE_ID.test(String(auth.id || '')) &&
    (auth.scope === 'own' || auth.role === 'manager');
  if (!personalDriver || date !== kstToday()) return routes;
  for (const route of routes) {
    if (route.driverId !== auth.id) continue;
    for (const student of route.students || []) {
      let contact;
      try { contact = await validContact(env, { id: student.id, name: text(student.name) }, 'call'); }
      catch (error) { contact = { error: 'CONTACT_UNAVAILABLE' }; }
      student.guardianPhone = contact.error ? null : contact.phone;
      student.callReady = !contact.error;
    }
  }
  return routes;
}

function sendConfig(env, event) {
  if (text(env.WB_TRANSPORT_NOTIFY_ENABLED) !== 'true') return { error: 'SEND_DISABLED' };
  const apiKey = text(env.SOLAPI_KAKAO_API_KEY), apiSecret = text(env.SOLAPI_KAKAO_API_SECRET);
  const pfId = text(env.SOLAPI_KAKAO_PF_ID), templateId = text(env[TEMPLATE_ENV[event]]);
  const sender = digits(env.SOLAPI_SENDER_NUMBER);
  if (!apiKey || !apiSecret || !SAFE_ID.test(pfId) || !SAFE_ID.test(templateId) || !/^\d{8,12}$/.test(sender)) {
    return { error: 'TEMPLATE_NOT_APPROVED' };
  }
  return { apiKey, apiSecret, pfId, templateId, sender };
}
async function authorization(apiKey, apiSecret) {
  const date = new Date().toISOString(), salt = crypto.randomUUID();
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(apiSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key,
    new TextEncoder().encode(date + salt))), byte => byte.toString(16).padStart(2, '0')).join('');
  return 'HMAC-SHA256 apiKey=' + apiKey + ', date=' + date + ', salt=' + salt + ', signature=' + signature;
}
async function boundedProviderText(response, signal) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_PROVIDER_RESPONSE_BYTES) {
    try { await response.body?.cancel(); } catch (error) { /* 공급자 원문 오류는 숨긴다. */ }
    return { tooLarge: true, text: '' };
  }
  if (!response.body) return { tooLarge: false, text: '' };
  const reader = response.body.getReader(), chunks = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error('ABORTED');
      let onAbort;
      const aborted = new Promise((resolve, reject) => {
        onAbort = () => reject(new Error('ABORTED'));
        signal.addEventListener('abort', onAbort, { once: true });
      });
      let chunk;
      try { chunk = await Promise.race([reader.read(), aborted]); }
      finally { signal.removeEventListener('abort', onAbort); }
      const { done, value } = chunk;
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        return { tooLarge: true, text: '' };
      }
      chunks.push(value);
    }
  } catch (error) {
    try { void reader.cancel(); } catch (cancelError) { /* 공급자 원문 오류는 숨긴다. */ }
    const safe = new Error(signal.aborted ? 'SOLAPI_TIMEOUT' : 'SOLAPI_NETWORK');
    safe.safeCode = safe.message;
    throw safe;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { tooLarge: false, text: new TextDecoder().decode(bytes) };
}
function safeProviderId(value) { const v = String(value || ''); return SAFE_ID.test(v) ? v : null; }
function safeProviderStatus(value) { const v = String(value || ''); return /^\d{1,16}$/.test(v) ? v : null; }
function providerOutcome(response, payload) {
  if (!response.ok) {
    const raw = String(payload && (payload.errorCode || payload.statusCode) || '');
    const suffix = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40).toUpperCase();
    return response.status >= 500 ? { status: 'unknown', errorCode: 'SOLAPI_HTTP_' + response.status + (suffix ? '_' + suffix : '') }
      : { status: 'rejected', errorCode: 'SOLAPI_HTTP_' + response.status + (suffix ? '_' + suffix : '') };
  }
  const groupId = safeProviderId(payload && payload.groupInfo && payload.groupInfo.groupId);
  const failed = payload && Array.isArray(payload.failedMessageList) ? payload.failedMessageList[0] : null;
  const item = failed || (payload && Array.isArray(payload.messageList) ? payload.messageList[0] : null);
  const messageId = safeProviderId(item && item.messageId), statusCode = safeProviderStatus(item && item.statusCode);
  const provider = groupId && messageId && statusCode ? { groupId, messageId, statusCode } : undefined;
  if (failed) return { status: 'rejected', provider, errorCode: 'SOLAPI_STATUS_' + (statusCode || 'REJECTED') };
  if (!provider) return { status: 'unknown', errorCode: 'SOLAPI_AMBIGUOUS_RESPONSE' };
  return ['2000', '3000', '4000'].includes(statusCode) ? { status: 'accepted', provider }
    : { status: 'rejected', provider, errorCode: 'SOLAPI_STATUS_' + statusCode };
}

async function target(env, input, auth) {
  const date = String(input.date || ''), routeId = String(input.routeId || ''), studentId = String(input.studentId || '');
  const event = String(input.state || ''), revision = Number(input.revision);
  if (!ISO_DATE.test(date) || !SAFE_ID.test(routeId) || !SAFE_ID.test(studentId) || !EVENTS.has(event) ||
      !Number.isInteger(revision) || revision < 1) fail('알림 대상을 확인해 주세요', 400, 'NOTIFICATION_TARGET_INVALID');
  if (date !== kstToday()) fail('승하차 알림은 한국시간 오늘 운행만 보낼 수 있습니다', 403, 'DATE_FORBIDDEN');
  const configRow = await env.DB.prepare('SELECT data FROM transport_configs WHERE app=? LIMIT 1').bind('task').first();
  const config = configRow && parseJson(configRow.data);
  const route = config && Array.isArray(config.routes) ? config.routes.find(item => item && item.id === routeId) : null;
  const stop = route && Array.isArray(route.stops) ? route.stops.find(item => Array.isArray(item.studentIds) && item.studentIds.includes(studentId)) : null;
  if (!route || !route.active || !route.days.includes(weekday(date)) || !stop ||
      (auth.scope === 'own' && route.driverId !== auth.id)) fail('현재 배정 노선을 확인해 주세요', 409, 'ROUTE_CHANGED');
  const state = await env.DB.prepare(
    'SELECT status,revision,boarded_at,dropped_at FROM transport_states WHERE app=? AND date=? AND route_id=? AND student_id=? LIMIT 1'
  ).bind('task', date, routeId, studentId).first();
  if (!state || String(state.status) !== event || Number(state.revision) !== revision) {
    fail('승하차 상태가 변경되었습니다', 409, 'STATE_CHANGED');
  }
  const student = await rosterStudent(env, studentId);
  const contact = await validContact(env, student, event);
  const confirmedAt = Number(event === 'boarded' ? state.boarded_at : state.dropped_at);
  if (!Number.isSafeInteger(confirmedAt) || confirmedAt <= 0) fail('승하차 확인 시각을 찾을 수 없습니다', 409, 'STATE_INVALID');
  const academyEvent = (route.direction === 'pickup' && event === 'dropped') ||
    (route.direction === 'dropoff' && event === 'boarded');
  const location = academyEvent ? '학원' : text(stop.name).slice(0, 100);
  const variables = {
    '#{학생명}': student.name, '#{운행일}': date, '#{확인시각}': kstTime(confirmedAt),
    '#{노선명}': text(route.name).slice(0, 100), '#{확인지점}': location
  };
  let rendered = TRANSPORT_TEMPLATE_TEXT[event];
  for (const key of TRANSPORT_TEMPLATE_VARIABLES) rendered = rendered.split(key).join(variables[key]);
  if (rendered.length > 1000) fail('알림톡 문구 길이를 확인해 주세요', 413, 'MESSAGE_TOO_LONG');
  return { date, routeId, studentId, event, revision, student, contact, variables };
}
async function existingSend(env, item) {
  const row = await env.DB.prepare(
    'SELECT s.send_id,s.event_state,s.source_revision,e.status,e.safe_error_code FROM transport_notification_sends s ' +
    'LEFT JOIN transport_notification_send_events e ON e.app=s.app AND e.send_id=s.send_id ' +
    'WHERE s.app=? AND s.transport_date=? AND s.route_id=? AND s.student_id=? AND s.event_state=? AND s.source_revision=? LIMIT 1'
  ).bind('task', item.date, item.routeId, item.studentId, item.event, item.revision).first();
  if (!row) return null;
  return { status: row.status || 'unknown', event: String(row.event_state), code: row.status ? (row.safe_error_code || undefined) : 'PRIOR_SEND_UNCERTAIN',
    revision: Number(row.source_revision), idempotent: true };
}
async function appendOutcome(env, sendId, outcome) {
  const provider = outcome.provider || {};
  const result = await env.DB.prepare(
    'INSERT OR IGNORE INTO transport_notification_send_events ' +
    '(app,ledger_event_id,send_id,status,provider_group_id,provider_message_id,provider_status_code,safe_error_code,created_at) ' +
    'VALUES(?,?,?,?,?,?,?,?,?)'
  ).bind('task', 'tne_' + crypto.randomUUID().replace(/-/g, ''), sendId, outcome.status,
    provider.groupId || null, provider.messageId || null, provider.statusCode || null,
    outcome.errorCode || null, Date.now()).run();
  return changes(result) === 1;
}
async function safelyAppendOutcome(env, sendId, outcome) {
  try { return await appendOutcome(env, sendId, outcome); }
  catch (error) { return false; }
}
function blocked(event, revision, code) {
  return { status: 'blocked', event, code, revision, idempotent: false, retryAllowed: true };
}

export async function sendTransportNotification(env, input, auth) {
  const event = String(input.state || '');
  const revision = Number(input.revision) || 0;
  let item;
  try { item = await target(env, input, auth); }
  catch (error) { return blocked(event, revision, error.code || 'NOTIFICATION_BLOCKED'); }
  const prior = await existingSend(env, item);
  if (prior) return { ...prior, retryAllowed: false };
  const config = sendConfig(env, item.event);
  if (config.error) return blocked(item.event, item.revision, config.error);
  if (item.contact.error) return blocked(item.event, item.revision, item.contact.error);
  const variablesHash = await sha256Hex(JSON.stringify(item.variables));
  const idempotencyKey = await sha256Hex([item.date, item.routeId, item.studentId, item.event, item.revision].join('|'));
  const sendId = 'tns_' + idempotencyKey.slice(0, 48), now = Date.now();
  const consentColumn = item.event === 'boarded' ? 'transport_boarded_consent' : 'transport_dropped_consent';
  const inserted = await env.DB.prepare(
    'INSERT OR IGNORE INTO transport_notification_sends ' +
    '(app,send_id,idempotency_key,event_state,transport_date,route_id,student_id,source_revision,' +
    'variables_hash,template_id,created_at,created_by) ' +
    'SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE ' +
    '(SELECT COUNT(*) FROM transport_notification_sends WHERE app=? AND created_at>?)<? ' +
    'AND EXISTS (SELECT 1 FROM transport_states s WHERE s.app=? AND s.date=? AND s.route_id=? AND s.student_id=? ' +
    'AND s.status=? AND s.revision=?) ' +
    'AND EXISTS (SELECT 1 FROM guardian_contacts_by_student g WHERE g.app=? AND g.student_id=? ' +
    'AND g.' + consentColumn + '=1 AND g.transport_guardian_identity_hash=?)'
  ).bind('task', sendId, idempotencyKey, item.event, item.date, item.routeId, item.studentId, item.revision,
    variablesHash, config.templateId, now, actor(auth), 'task', now - 86400000, DAILY_LIMIT,
    'task', item.date, item.routeId, item.studentId, item.event, item.revision,
    'task', item.studentId, item.contact.hash).run();
  if (changes(inserted) !== 1) return await existingSend(env, item) || blocked(item.event, item.revision, 'SOURCE_CHANGED_BEFORE_DISPATCH');
  let fresh;
  try { fresh = await target(env, input, auth); }
  catch (error) {
    const recorded = await safelyAppendOutcome(env, sendId,
      { status: 'rejected', errorCode: 'SOURCE_CHANGED_BEFORE_DISPATCH' });
    return { status: recorded ? 'rejected' : 'unknown', event: item.event,
      code: recorded ? 'SOURCE_CHANGED_BEFORE_DISPATCH' : 'SEND_RESULT_NOT_RECORDED', revision: item.revision,
      idempotent: false, retryAllowed: false };
  }
  if (fresh.contact.error || fresh.contact.phone !== item.contact.phone || fresh.contact.hash !== item.contact.hash ||
      await sha256Hex(JSON.stringify(fresh.variables)) !== variablesHash) {
    const recorded = await safelyAppendOutcome(env, sendId,
      { status: 'rejected', errorCode: 'SOURCE_CHANGED_BEFORE_DISPATCH' });
    return { status: recorded ? 'rejected' : 'unknown', event: item.event,
      code: recorded ? 'SOURCE_CHANGED_BEFORE_DISPATCH' : 'SEND_RESULT_NOT_RECORDED', revision: item.revision,
      idempotent: false, retryAllowed: false };
  }
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), SOLAPI_TIMEOUT_MS);
  let response, raw, tooLarge = false;
  try {
    response = await fetch(SOLAPI_SEND_URL, { method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json;charset=utf-8', Authorization: await authorization(config.apiKey, config.apiSecret) },
      body: JSON.stringify({ messages: [{ to: fresh.contact.phone, from: config.sender, type: 'ATA',
        kakaoOptions: { pfId: config.pfId, templateId: config.templateId, disableSms: true, variables: fresh.variables },
        customFields: { wbSendId: sendId } }], strict: true, allowDuplicates: false, showMessageList: true }) });
    const body = await boundedProviderText(response, controller.signal);
    raw = body.text; tooLarge = body.tooLarge;
  } catch (error) {
    clearTimeout(timeout);
    const outcome = { status: 'unknown', errorCode: error && error.safeCode ||
      (controller.signal.aborted ? 'SOLAPI_TIMEOUT' : 'SOLAPI_NETWORK') };
    const recorded = await safelyAppendOutcome(env, sendId, outcome);
    return { status: 'unknown', event: item.event,
      code: recorded ? outcome.errorCode : 'SEND_RESULT_NOT_RECORDED', revision: item.revision,
      idempotent: false, retryAllowed: false };
  }
  clearTimeout(timeout);
  let outcome;
  try {
    if (tooLarge) {
      outcome = response.ok ? { status: 'unknown', errorCode: 'SOLAPI_RESPONSE_TOO_LARGE' } : providerOutcome(response, {});
    } else {
      let payload = {}; try { payload = raw ? JSON.parse(raw) : {}; } catch (error) { if (response.ok) throw error; }
      outcome = providerOutcome(response, payload);
    }
  } catch (error) { outcome = { status: 'unknown', errorCode: 'SOLAPI_INVALID_RESPONSE' }; }
  if (!await safelyAppendOutcome(env, sendId, outcome)) {
    outcome = { status: 'unknown', errorCode: 'SEND_RESULT_NOT_RECORDED' };
  }
  return { status: outcome.status, event: item.event, code: outcome.errorCode || undefined,
    revision: item.revision, idempotent: false, retryAllowed: false };
}

export async function notifyTransportGuardian(env, body, auth) {
  exact(body, ['date', 'routeId', 'studentId', 'state', 'revision']);
  return sendTransportNotification(env, body, auth);
}

export async function transportNotificationSummaries(env, routes, date) {
  for (const route of routes) for (const student of route.students || []) {
    if (!EVENTS.has(student.status) || !student.revision) { student.notification = null; continue; }
    const item = { date, routeId: route.id, studentId: student.id, event: student.status, revision: student.revision };
    let saved;
    try { saved = await existingSend(env, item); }
    catch (error) {
      student.notification = { status: 'blocked', event: item.event, code: 'NOTIFICATION_LEDGER_UNAVAILABLE',
        revision: item.revision, idempotent: true, retryAllowed: true };
      continue;
    }
    if (saved) { student.notification = { ...saved, retryAllowed: false }; continue; }
    const config = sendConfig(env, item.event);
    if (config.error) { student.notification = { ...blocked(item.event, item.revision, config.error), idempotent: true }; continue; }
    const contact = await validContact(env, { id: student.id, name: text(student.name) }, item.event);
    student.notification = contact.error
      ? { ...blocked(item.event, item.revision, contact.error), idempotent: true }
      : { status: 'skipped', event: item.event, code: 'NOT_REQUESTED', revision: item.revision,
        idempotent: true, retryAllowed: true };
  }
  return routes;
}

export const transportNotifyContract = Object.freeze({
  enabledEnv: 'WB_TRANSPORT_NOTIFY_ENABLED', templateEnv: TEMPLATE_ENV,
  variables: TRANSPORT_TEMPLATE_VARIABLES
});
