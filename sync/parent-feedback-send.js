/**
 * 원장이 승인한 학부모 피드백 문구를 실제로 보호자에게 문자로 보낸다.
 *
 * book-order-send.js와 같은 안전장치를 따른다:
 *   · 앱은 requestKey만 보낸다. 전화번호는 앱이 절대 못 보내고, 서버가
 *     guardian_contacts(원장이 직접 입력한 보호자 연락처 원장)에서만 찾는다.
 *   · 문자 내용도 앱이 자유 텍스트로 못 보낸다. feedback_requests에 이미 저장된,
 *     원장이 승인한 문구(body)를 그대로 쓴다 — "문구 승인"과 "실제 발송"은 항상
 *     별개의 명시적 동작이다(먼저 /feedback-review approve_content, 그 다음 이 엔드포인트).
 *   · 발송 동의(consent)가 켜진 학생에게만 나간다. 연락처가 있어도 동의가 없으면 막는다.
 *   · 코드가 배포돼도 기본은 꺼짐 — WB_PARENT_FEEDBACK_SEND_ENABLED가 'true'여야 나간다.
 *   · 원장(scope='all')만 이 발송 버튼을 누를 수 있다 — 검토 권한과 동일하게 맞춘다.
 *   · 하루 발송 한도를 둬서 실수로 반복 클릭해도 폭주하지 않는다.
 *
 *   POST /parent-feedback-send { app, auth(admin), requestKey } → { ok, status, ... }
 */

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SOLAPI_SEND_URL = 'https://api.solapi.com/messages/v4/send-many/detail';
const SOLAPI_TIMEOUT_MS = 8000;
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;
const GLOBAL_DAILY_LIMIT = 150;
const MAX_MESSAGE_BYTES = 2000;
const ALLOWED_REQUEST_KEYS = new Set(['app', 'auth', 'requestKey']);
const ALLOWED_AUTH_KEYS = new Set(['mode', 'secret', 'id', 'token']);
const FORBIDDEN_REQUEST_KEYS = /(?:phone|^to$|^from$|message|recipient|guardian|studentname)/i;

function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bytesToHex(value) {
  return Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value) {
  const encoded = new TextEncoder().encode(String(value == null ? '' : value));
  return bytesToHex(await crypto.subtle.digest('SHA-256', encoded));
}

async function buildSolapiAuthorization(apiKey, apiSecret, date, salt) {
  const requestDate = String(date || new Date().toISOString());
  const requestSalt = String(salt || crypto.randomUUID());
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(String(apiSecret || '')),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = bytesToHex(await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(requestDate + requestSalt)
  ));
  return 'HMAC-SHA256 apiKey=' + apiKey + ', date=' + requestDate +
    ', salt=' + requestSalt + ', signature=' + signature;
}

function normalizedDigits(value) {
  return String(value || '').replace(/[\s()-]/g, '');
}

function validateRequestShape(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '요청 형식을 확인해 주세요';
  for (const key of Object.keys(body)) {
    if (FORBIDDEN_REQUEST_KEYS.test(key) || !ALLOWED_REQUEST_KEYS.has(key)) {
      return '보호자 연락처나 문자 내용은 요청에서 지정할 수 없습니다';
    }
  }
  if (!body.auth || typeof body.auth !== 'object' || Array.isArray(body.auth)) return '인증 정보를 확인해 주세요';
  for (const key of Object.keys(body.auth)) {
    if (FORBIDDEN_REQUEST_KEYS.test(key) || !ALLOWED_AUTH_KEYS.has(key)) {
      return '보호자 연락처나 문자 내용은 요청에서 지정할 수 없습니다';
    }
  }
  return null;
}

/** 코드가 배포돼도 실제 발송은 이 네 가지가 모두 갖춰져야만 켜진다 */
function sendConfiguration(env) {
  if (!safeEqual(env.WB_PARENT_FEEDBACK_SEND_ENABLED, 'true') ||
      !env.SOLAPI_API_KEY || !env.SOLAPI_API_SECRET || !env.SOLAPI_SENDER_NUMBER) {
    return null;
  }
  const sender = normalizedDigits(env.SOLAPI_SENDER_NUMBER);
  if (!/^\d{8,12}$/.test(sender)) return null;
  return { apiKey: String(env.SOLAPI_API_KEY), apiSecret: String(env.SOLAPI_API_SECRET), sender };
}

/** t.studentName이 없으면 client의 studentOf(t)와 똑같은 규칙으로 제목에서 뽑는다 */
function resolveStudentName(taskData) {
  const explicit = String((taskData && taskData.studentName) || '').trim();
  if (explicit) return explicit;
  const title = String((taskData && taskData.title) || '');
  return title.replace(/^\[[^\]]+\]\s*/, '').split('—')[0].replace(/\([^)]*\)/g, '').trim();
}

async function guardianPhone(env, app, studentName) {
  const row = await env.DB.prepare(
    'SELECT phone, consent FROM guardian_contacts WHERE app=? AND student_name=? LIMIT 1'
  ).bind(app, studentName).first();
  if (!row) return { error: 'GUARDIAN_NOT_REGISTERED' };
  const phone = normalizedDigits(row.phone);
  if (!/^01[016789]\d{7,8}$/.test(phone)) return { error: 'GUARDIAN_PHONE_MISSING' };
  if (!Number(row.consent)) return { error: 'GUARDIAN_CONSENT_MISSING' };
  return { phone };
}

function safeProviderId(value) {
  const text = String(value || '');
  return /^[A-Za-z0-9_-]{1,128}$/.test(text) ? text : null;
}
function safeProviderStatus(value) {
  const text = String(value || '');
  return /^\d{1,16}$/.test(text) ? text : null;
}

function providerOutcome(response, payload) {
  if (!response.ok) {
    return response.status >= 500
      ? { status: 'unknown', errorCode: 'SOLAPI_HTTP_5XX' }
      : { status: 'rejected', errorCode: 'SOLAPI_HTTP_4XX' };
  }
  const groupId = safeProviderId(payload && payload.groupInfo && payload.groupInfo.groupId);
  const message = payload && Array.isArray(payload.messageList) ? payload.messageList[0] : null;
  const messageId = safeProviderId(message && message.messageId);
  const statusCode = safeProviderStatus(message && message.statusCode);
  if (!groupId || !messageId || !statusCode) return { status: 'unknown', errorCode: 'SOLAPI_AMBIGUOUS_RESPONSE' };
  const provider = { groupId, messageId, statusCode };
  if (statusCode === '2000' || statusCode === '3000' || statusCode === '4000') return { status: 'accepted', provider };
  return { status: 'rejected', provider, errorCode: 'SOLAPI_REJECTED' };
}

function responseStatusFor(status) {
  if (status === 'accepted') return 200;
  if (status === 'rejected') return 502;
  return 202;
}

function publicResult(row, idempotent) {
  return {
    ok: row.status !== 'rejected',
    idempotent: !!idempotent,
    studentName: row.student_name,
    send: {
      sendId: row.send_id,
      status: row.status,
      createdAt: Number(row.created_at) || 0,
      updatedAt: Number(row.updated_at) || 0,
      errorCode: row.safe_error_code || undefined
    }
  };
}

async function findByIdempotency(env, app, idempotencyKey) {
  return await env.DB.prepare('SELECT * FROM parent_feedback_sends WHERE app=? AND idempotency_key=? LIMIT 1')
    .bind(app, idempotencyKey).first();
}

async function updateLedger(env, app, sendId, status, provider, safeErrorCode, now) {
  const result = await env.DB.prepare(
    'UPDATE parent_feedback_sends SET status=?, provider_group_id=?, provider_message_id=?, ' +
    'provider_status_code=?, safe_error_code=?, updated_at=? ' +
    "WHERE app=? AND send_id=? AND status='dispatching'"
  ).bind(
    status, provider && provider.groupId || null, provider && provider.messageId || null,
    provider && provider.statusCode || null, safeErrorCode || null, now, app, sendId
  ).run();
  return Number(result && result.meta && result.meta.changes || 0) === 1;
}

/** 성공했을 때만 feedback_requests를 'sent'로 넘긴다. 이미 다른 상태로 바뀌었으면 조용히 둔다 */
async function markFeedbackSent(env, app, requestKey, revision, now) {
  await env.DB.prepare(
    "UPDATE feedback_requests SET status='sent', updated_at=? " +
    "WHERE app=? AND request_key=? AND revision=? AND status='content_approved_send_blocked'"
  ).bind(now, app, requestKey, revision).run();
}

export async function handleParentFeedbackSend(env, app, body, origin, auth, json) {
  if (app !== 'task') return json({ ok: false, error: '학부모 발송은 task 앱에서만 사용할 수 있습니다' }, 400, origin);
  const shapeError = validateRequestShape(body);
  if (shapeError) return json({ ok: false, error: shapeError }, 400, origin);
  if (auth.scope !== 'all') return json({ ok: false, error: '실제 발송은 원장만 할 수 있습니다' }, 403, origin);

  const requestKey = String(body.requestKey || '');
  if (!SAFE_ID.test(requestKey) || !requestKey.startsWith('fbr_')) {
    return json({ ok: false, error: '올바른 requestKey가 필요합니다' }, 400, origin);
  }

  const current = await env.DB.prepare('SELECT * FROM feedback_requests WHERE app=? AND request_key=? LIMIT 1')
    .bind(app, requestKey).first();
  if (!current) return json({ ok: false, error: '피드백 요청을 찾을 수 없습니다' }, 404, origin);
  if (current.status === 'sent') {
    return json({ ok: true, idempotent: true, code: 'ALREADY_SENT', request: { status: 'sent' } }, 200, origin);
  }
  if (current.status !== 'content_approved_send_blocked') {
    return json({ ok: false, error: '문구 승인이 끝난 요청만 발송할 수 있습니다' }, 409, origin);
  }

  const taskRow = await env.DB.prepare('SELECT data FROM tasks WHERE app=? AND id=? LIMIT 1')
    .bind(app, current.task_id).first();
  let taskData = {};
  try { taskData = taskRow ? JSON.parse(taskRow.data || '{}') : {}; } catch (error) { taskData = {}; }
  const studentName = resolveStudentName(taskData);
  if (!studentName) return json({ ok: false, error: '지시서에서 학생 이름을 찾을 수 없습니다' }, 409, origin);

  const config = sendConfiguration(env);
  if (!config) {
    return json({ ok: false, code: 'SEND_DISABLED', error: '학부모 문자 자동 발송이 아직 켜져 있지 않습니다' }, 503, origin);
  }

  const guardian = await guardianPhone(env, app, studentName);
  if (guardian.error === 'GUARDIAN_NOT_REGISTERED' || guardian.error === 'GUARDIAN_PHONE_MISSING') {
    return json({
      ok: false, code: guardian.error,
      error: '"' + studentName + '" 학생의 보호자 연락처가 등록되지 않았습니다 — 설정에서 먼저 등록해 주세요'
    }, 409, origin);
  }
  if (guardian.error === 'GUARDIAN_CONSENT_MISSING') {
    return json({
      ok: false, code: 'GUARDIAN_CONSENT_MISSING',
      error: '"' + studentName + '" 보호자의 발송 동의가 켜져 있지 않습니다'
    }, 409, origin);
  }

  const messageText = String(current.body || '');
  if (new TextEncoder().encode(messageText).byteLength > MAX_MESSAGE_BYTES) {
    return json({ ok: false, error: '문구가 너무 길어 문자 한 통에 안 들어갑니다 — 줄여서 다시 승인해 주세요' }, 413, origin);
  }
  const idempotencyKey = await sha256Hex([app, requestKey, guardian.phone, current.body_hash].join(''));
  const sendId = 'pfs_' + idempotencyKey.slice(0, 48);
  const now = Date.now();

  const inserted = await env.DB.prepare(
    'INSERT OR IGNORE INTO parent_feedback_sends ' +
    '(app,send_id,idempotency_key,feedback_request_key,student_name,message_hash,status,created_at,updated_at) ' +
    "SELECT ?,?,?,?,?,?,'reserved',?,? " +
    'WHERE (SELECT COUNT(*) FROM parent_feedback_sends WHERE app=? AND created_at > ?) < ' + GLOBAL_DAILY_LIMIT
  ).bind(
    app, sendId, idempotencyKey, requestKey, studentName, current.body_hash, now, now,
    app, now - 24 * 60 * 60 * 1000
  ).run();

  if (Number(inserted && inserted.meta && inserted.meta.changes || 0) !== 1) {
    const existing = await findByIdempotency(env, app, idempotencyKey);
    if (existing) {
      if (existing.status === 'accepted') await markFeedbackSent(env, app, requestKey, Number(current.revision), Date.now());
      return json(publicResult(existing, true), responseStatusFor(existing.status), origin);
    }
    return json({ ok: false, code: 'DAILY_SEND_LIMIT', error: '오늘 발송 한도에 도달했습니다', studentName }, 429, origin);
  }

  const dispatchAt = Date.now();
  const dispatch = await env.DB.prepare(
    "UPDATE parent_feedback_sends SET status='dispatching', dispatch_started_at=?, updated_at=? " +
    "WHERE app=? AND send_id=? AND status='reserved'"
  ).bind(dispatchAt, dispatchAt, app, sendId).run();
  if (Number(dispatch && dispatch.meta && dispatch.meta.changes || 0) !== 1) {
    const existing = await findByIdempotency(env, app, idempotencyKey);
    if (existing) return json(publicResult(existing, true), responseStatusFor(existing.status), origin);
    return json({ ok: false, code: 'SEND_STATE_CONFLICT', error: '발송 상태를 확인해 주세요' }, 409, origin);
  }

  const authorization = await buildSolapiAuthorization(config.apiKey, config.apiSecret);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOLAPI_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(SOLAPI_SEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=utf-8', Authorization: authorization },
      body: JSON.stringify({
        messages: [{
          to: guardian.phone, from: config.sender, text: messageText, type: 'LMS',
          autoTypeDetect: false, customFields: { wbSendId: sendId }
        }],
        strict: true, allowDuplicates: false, showMessageList: true
      }),
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timeout);
    const code = controller.signal.aborted ? 'SOLAPI_TIMEOUT' : 'SOLAPI_NETWORK';
    await updateLedger(env, app, sendId, 'unknown', null, code, Date.now());
    const row = await findByIdempotency(env, app, idempotencyKey);
    return json(publicResult(row || {
      app, send_id: sendId, student_name: studentName,
      status: 'unknown', safe_error_code: code, created_at: now, updated_at: Date.now()
    }, false), 202, origin);
  }
  clearTimeout(timeout);

  let outcome;
  try {
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
      outcome = { status: 'unknown', errorCode: 'SOLAPI_RESPONSE_TOO_LARGE' };
    } else {
      const payload = raw ? JSON.parse(raw) : {};
      outcome = providerOutcome(response, payload);
    }
  } catch (error) {
    outcome = { status: 'unknown', errorCode: 'SOLAPI_INVALID_RESPONSE' };
  }

  await updateLedger(env, app, sendId, outcome.status, outcome.provider, outcome.errorCode, Date.now());
  if (outcome.status === 'accepted') await markFeedbackSent(env, app, requestKey, Number(current.revision), Date.now());
  const finalRow = await findByIdempotency(env, app, idempotencyKey);
  return json(publicResult(finalRow || {
    app, send_id: sendId, student_name: studentName,
    status: outcome.status, safe_error_code: outcome.errorCode, created_at: now, updated_at: Date.now()
  }, false), responseStatusFor(outcome.status), origin);
}
