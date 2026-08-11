/**
 * 학부모 피드백을 카카오 알림톡(Solapi 카카오 비즈메시지)으로 실제 발송한다.
 *
 * 2026-08 원장 지시로 별도 "원장 승인" 클릭 없이, 선생님이 항목(잘한 점/보완점 등)을
 * 고르고 제출하는 순간 이 발송을 바로 시도한다 — attemptParentFeedbackSend()가 그
 * 자동 발송 지점이고, worker-core.js의 /feedback-request 제출 처리에서 직접 호출한다.
 * handleParentFeedbackSend()(HTTP 엔드포인트, 원장 전용)는 그때 막혔던 건(보호자 연락처를
 * 나중에 등록한 경우 등)을 원장이 수동으로 재시도할 때만 쓴다.
 *
 * book-order-send.js와 같은 안전장치를 따른다:
 *   · 전화번호는 서버가 guardian_contacts(원장이 직접 입력한 보호자 연락처)에서만 찾는다 —
 *     앱도, 자동발송 호출부도 전화번호를 직접 넘기지 않는다.
 *   · 발송 동의(consent)가 켜진 학생에게만 나간다.
 *   · 코드가 배포돼도 기본은 꺼짐 — WB_PARENT_FEEDBACK_SEND_ENABLED가 'true'여야 나간다.
 *   · 카카오 알림톡 전용 키(SOLAPI_KAKAO_API_KEY/SECRET)를 따로 써서, 교재주문·원장리포트가
 *     쓰는 기존 SOLAPI_API_KEY와 완전히 분리한다 — 문제가 생겨도 서로 영향이 없다.
 *   · 하루 발송 한도를 둬서 폭주를 막는다.
 *   · 알림톡은 항상 승인된 고정 틀 + 항목별 변수로만 나간다 — 자유 문구를 그대로 보내지 않는다.
 *
 *   POST /parent-feedback-send { app, auth(admin), requestKey } → { ok, status, ... }
 *     (막혔던 건을 원장이 수동으로 다시 시도할 때)
 */

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SOLAPI_SEND_URL = 'https://api.solapi.com/messages/v4/send-many/detail';
const SOLAPI_TIMEOUT_MS = 8000;
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;
const GLOBAL_DAILY_LIMIT = 150;
const ALLOWED_REQUEST_KEYS = new Set(['app', 'auth', 'requestKey']);
const ALLOWED_AUTH_KEYS = new Set(['mode', 'secret', 'id', 'token']);
const FORBIDDEN_REQUEST_KEYS = /(?:phone|^to$|^from$|message|recipient|guardian|studentname)/i;

/** Solapi에 등록된 템플릿 원문에서 변수 자리표시자만 뺀 고정 문구다.
 *  실제 발송 문구는 카카오 템플릿으로 렌더링되며, 이 상수는 보수적인 900자 상한 계산에만 쓴다.
 *  승인 전 템플릿 문구를 바꾸면 이 상수도 반드시 같이 맞춘다.
 */
const TEMPLATE_FIXED_TEXT =
  '안녕하세요, WB 웩슬러브레인센터(독해력학원)입니다.\n\n' +
  ' 선생님이 오늘  학생 수업을 마치고,\n직접 관찰한 내용을 정리해 보내드립니다.\n\n' +
  '▪ 오늘 배운 내용: \n▪ 잘한 점: \n▪ 다음에 더 신경 쓸 점: \n\n' +
  '숫자로 비교하지 않고, 그날 그 아이만 보고 남긴 기록입니다.\n문의사항은 학원으로 연락 주세요. 감사합니다.';
const MAX_ALIMTALK_CHARS = 900;

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

/** 코드가 배포돼도 실제 발송은 이 다섯 가지가 모두 갖춰져야만 켜진다.
 *  카카오 알림톡 전용 키(SOLAPI_KAKAO_*)를 쓴다 — 교재주문·원장리포트가 쓰는
 *  기존 SOLAPI_API_KEY/SECRET과는 별개다. */
function sendConfiguration(env) {
  if (!safeEqual(env.WB_PARENT_FEEDBACK_SEND_ENABLED, 'true') ||
      !env.SOLAPI_KAKAO_API_KEY || !env.SOLAPI_KAKAO_API_SECRET ||
      !env.SOLAPI_KAKAO_PF_ID || !env.SOLAPI_KAKAO_TEMPLATE_ID || !env.SOLAPI_SENDER_NUMBER) {
    return null;
  }
  const sender = normalizedDigits(env.SOLAPI_SENDER_NUMBER);
  if (!/^\d{8,12}$/.test(sender)) return null;
  return {
    apiKey: String(env.SOLAPI_KAKAO_API_KEY), apiSecret: String(env.SOLAPI_KAKAO_API_SECRET),
    pfId: String(env.SOLAPI_KAKAO_PF_ID), templateId: String(env.SOLAPI_KAKAO_TEMPLATE_ID),
    sender
  };
}

/** t.studentName이 없으면 client의 studentOf(t)와 똑같은 규칙으로 제목에서 뽑는다.
 *  worker-core.js도 feedback_requests.student_name을 저장할 때 이 함수를 그대로 써서,
 *  여기서 발송할 때 찾는 이름과 항상 똑같게 맞춘다(어긋나면 보호자 조회가 실패한다). */
export function resolveStudentName(taskData) {
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

/** 항목별 변수 값을 다듬는다 — 앞뒤 공백 제거, 지나치게 길면 잘라내지 않고 거부하도록
 *  상위에서 900자 합산 체크를 한다. 여기서는 최소한의 정규화만 한다. */
function cleanField(value) {
  return String(value == null ? '' : value).trim();
}

function totalAlimtalkLength(fields) {
  return TEMPLATE_FIXED_TEXT.length +
    fields.teacherName.length + fields.studentName.length +
    fields.contentText.length + fields.plusText.length + fields.minusText.length;
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
  const failed = payload && Array.isArray(payload.failedMessageList) ? payload.failedMessageList[0] : null;
  if (failed) {
    const messageId = safeProviderId(failed.messageId);
    const statusCode = safeProviderStatus(failed.statusCode);
    const provider = groupId && messageId && statusCode ? { groupId, messageId, statusCode } : undefined;
    return {
      status: 'rejected',
      provider,
      errorCode: 'SOLAPI_STATUS_' + (statusCode || 'REJECTED')
    };
  }
  const message = payload && Array.isArray(payload.messageList) ? payload.messageList[0] : null;
  const messageId = safeProviderId(message && message.messageId);
  const statusCode = safeProviderStatus(message && message.statusCode);
  if (!groupId || !messageId || !statusCode) return { status: 'unknown', errorCode: 'SOLAPI_AMBIGUOUS_RESPONSE' };
  const provider = { groupId, messageId, statusCode };
  if (statusCode === '2000' || statusCode === '3000' || statusCode === '4000') return { status: 'accepted', provider };
  return { status: 'rejected', provider, errorCode: 'SOLAPI_STATUS_' + statusCode };
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

async function markFeedbackOutcome(env, app, requestKey, revision, status, note, now) {
  await env.DB.prepare(
    "UPDATE feedback_requests SET status=?, review_note=?, updated_at=? " +
    "WHERE app=? AND request_key=? AND revision=? AND status<>'sent' AND status<>'cancelled'"
  ).bind(status, note || null, now, app, requestKey, revision).run();
}

/**
 * 실제 발송을 시도하는 공용 로직. HTTP 엔드포인트(수동 재시도)와 /feedback-request 제출
 * 처리(자동 발송)가 둘 다 이 함수를 쓴다. current는 feedback_requests 행이어야 한다.
 */
export async function attemptParentFeedbackSend(env, app, current) {
  const now0 = Date.now();
  if (current.status === 'sent') {
    return { ok: true, idempotent: true, code: 'ALREADY_SENT', status: 'sent' };
  }
  if (current.status === 'cancelled') {
    return { ok: false, code: 'CANCELLED', status: current.status };
  }

  const teacherName = cleanField(current.teacher_name);
  const studentName = cleanField(current.student_name);
  const contentText = cleanField(current.content_text);
  const plusText = cleanField(current.plus_text);
  const minusText = cleanField(current.minus_text);
  if (!teacherName || !studentName || !contentText || !plusText || !minusText) {
    await markFeedbackOutcome(env, app, current.request_key, Number(current.revision),
      'content_approved_send_blocked', '항목이 모두 채워지지 않아 발송하지 못했습니다', now0);
    return { ok: false, code: 'FIELDS_INCOMPLETE', status: 'content_approved_send_blocked' };
  }

  const config = sendConfiguration(env);
  if (!config) {
    await markFeedbackOutcome(env, app, current.request_key, Number(current.revision),
      'content_approved_send_blocked', '학부모 알림톡 자동 발송이 아직 켜져 있지 않습니다', now0);
    return { ok: false, code: 'SEND_DISABLED', status: 'content_approved_send_blocked' };
  }

  const guardian = await guardianPhone(env, app, studentName);
  if (guardian.error) {
    const note = guardian.error === 'GUARDIAN_CONSENT_MISSING'
      ? '보호자의 발송 동의가 켜져 있지 않아 발송하지 못했습니다'
      : '보호자 연락처가 등록되지 않아 발송하지 못했습니다 — 설정에서 먼저 등록해 주세요';
    await markFeedbackOutcome(env, app, current.request_key, Number(current.revision),
      'content_approved_send_blocked', note, now0);
    return { ok: false, code: guardian.error, status: 'content_approved_send_blocked' };
  }

  const fields = { teacherName, studentName, contentText, plusText, minusText };
  if (totalAlimtalkLength(fields) > MAX_ALIMTALK_CHARS) {
    await markFeedbackOutcome(env, app, current.request_key, Number(current.revision),
      'content_approved_send_blocked', '문구가 알림톡 글자수 상한(900자)을 넘어 발송하지 못했습니다', now0);
    return { ok: false, code: 'MESSAGE_TOO_LONG', status: 'content_approved_send_blocked' };
  }

  const variablesHash = await sha256Hex(JSON.stringify(fields));
  const idempotencyKey = await sha256Hex([app, current.request_key, guardian.phone, variablesHash].join(''));
  const sendId = 'pfs_' + idempotencyKey.slice(0, 48);
  const now = Date.now();

  const inserted = await env.DB.prepare(
    'INSERT OR IGNORE INTO parent_feedback_sends ' +
    '(app,send_id,idempotency_key,feedback_request_key,student_name,message_hash,status,created_at,updated_at) ' +
    "SELECT ?,?,?,?,?,?,'reserved',?,? " +
    'WHERE (SELECT COUNT(*) FROM parent_feedback_sends WHERE app=? AND created_at > ?) < ' + GLOBAL_DAILY_LIMIT
  ).bind(
    app, sendId, idempotencyKey, current.request_key, studentName, variablesHash, now, now,
    app, now - 24 * 60 * 60 * 1000
  ).run();

  if (Number(inserted && inserted.meta && inserted.meta.changes || 0) !== 1) {
    const existing = await findByIdempotency(env, app, idempotencyKey);
    if (existing) {
      if (existing.status === 'accepted') {
        await markFeedbackOutcome(env, app, current.request_key, Number(current.revision), 'sent', null, Date.now());
      }
      return { ok: existing.status !== 'rejected', idempotent: true, status: existing.status };
    }
    await markFeedbackOutcome(env, app, current.request_key, Number(current.revision),
      'content_approved_send_blocked', '오늘 발송 한도에 도달해 발송하지 못했습니다', now0);
    return { ok: false, code: 'DAILY_SEND_LIMIT', status: 'content_approved_send_blocked' };
  }

  const dispatchAt = Date.now();
  const dispatch = await env.DB.prepare(
    "UPDATE parent_feedback_sends SET status='dispatching', dispatch_started_at=?, updated_at=? " +
    "WHERE app=? AND send_id=? AND status='reserved'"
  ).bind(dispatchAt, dispatchAt, app, sendId).run();
  if (Number(dispatch && dispatch.meta && dispatch.meta.changes || 0) !== 1) {
    return { ok: false, code: 'SEND_STATE_CONFLICT', status: current.status };
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
          to: guardian.phone, from: config.sender, type: 'ATA',
          kakaoOptions: {
            pfId: config.pfId, templateId: config.templateId, disableSms: true,
            variables: {
              '#{선생님}': teacherName, '#{학생명}': studentName, '#{학습내용}': contentText,
              '#{잘한점}': plusText, '#{보완점}': minusText
            }
          },
          customFields: { wbSendId: sendId }
        }],
        strict: true, allowDuplicates: false, showMessageList: true
      }),
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timeout);
    const code = controller.signal.aborted ? 'SOLAPI_TIMEOUT' : 'SOLAPI_NETWORK';
    await updateLedger(env, app, sendId, 'unknown', null, code, Date.now());
    await markFeedbackOutcome(env, app, current.request_key, Number(current.revision),
      'content_approved_send_blocked', '발송 시도 중 통신 오류가 발생했습니다(' + code + ')', Date.now());
    return { ok: false, code, status: 'content_approved_send_blocked' };
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
  if (outcome.status === 'accepted') {
    await markFeedbackOutcome(env, app, current.request_key, Number(current.revision), 'sent', null, Date.now());
  } else {
    await markFeedbackOutcome(env, app, current.request_key, Number(current.revision),
      'content_approved_send_blocked', '카카오 발송이 거절되었습니다(' + (outcome.errorCode || outcome.status) + ')', Date.now());
  }
  return { ok: outcome.status === 'accepted', code: outcome.errorCode, status: outcome.status === 'accepted' ? 'sent' : 'content_approved_send_blocked' };
}

const RETRY_ERROR_TEXT = {
  ALREADY_SENT: '이미 발송된 문구입니다',
  CANCELLED: '취소된 요청은 발송할 수 없습니다',
  FIELDS_INCOMPLETE: '항목이 모두 채워지지 않아 발송할 수 없습니다',
  SEND_DISABLED: '학부모 알림톡 자동 발송이 아직 켜져 있지 않습니다',
  GUARDIAN_NOT_REGISTERED: '보호자 연락처가 등록되지 않았습니다 — 설정에서 먼저 등록해 주세요',
  GUARDIAN_PHONE_MISSING: '보호자 연락처가 등록되지 않았습니다 — 설정에서 먼저 등록해 주세요',
  GUARDIAN_CONSENT_MISSING: '보호자의 발송 동의가 켜져 있지 않습니다',
  MESSAGE_TOO_LONG: '문구가 알림톡 글자수 상한(900자)을 넘었습니다',
  DAILY_SEND_LIMIT: '오늘 발송 한도에 도달했습니다',
  SEND_STATE_CONFLICT: '발송 상태를 확인해 주세요',
  SOLAPI_TIMEOUT: '카카오 발송 시도 중 응답이 없었습니다 — 잠시 후 다시 시도해 주세요',
  SOLAPI_NETWORK: '카카오 발송 시도 중 통신 오류가 발생했습니다'
};
const RETRY_HTTP_STATUS = {
  ALREADY_SENT: 200,
  CANCELLED: 409,
  FIELDS_INCOMPLETE: 409,
  SEND_DISABLED: 503,
  GUARDIAN_NOT_REGISTERED: 409,
  GUARDIAN_PHONE_MISSING: 409,
  GUARDIAN_CONSENT_MISSING: 409,
  MESSAGE_TOO_LONG: 413,
  DAILY_SEND_LIMIT: 429,
  SEND_STATE_CONFLICT: 409
};

export async function handleParentFeedbackSend(env, app, body, origin, auth, json) {
  if (app !== 'task') return json({ ok: false, error: '학부모 발송은 task 앱에서만 사용할 수 있습니다' }, 400, origin);
  const shapeError = validateRequestShape(body);
  if (shapeError) return json({ ok: false, error: shapeError }, 400, origin);
  if (auth.scope !== 'all') return json({ ok: false, error: '수동 재시도는 원장만 할 수 있습니다' }, 403, origin);

  const requestKey = String(body.requestKey || '');
  if (!SAFE_ID.test(requestKey) || !requestKey.startsWith('fbr_')) {
    return json({ ok: false, error: '올바른 requestKey가 필요합니다' }, 400, origin);
  }

  const current = await env.DB.prepare('SELECT * FROM feedback_requests WHERE app=? AND request_key=? LIMIT 1')
    .bind(app, requestKey).first();
  if (!current) return json({ ok: false, error: '피드백 요청을 찾을 수 없습니다' }, 404, origin);

  const result = await attemptParentFeedbackSend(env, app, current);
  if (result.status === 'sent') return json(result, 200, origin);
  if (result.code && RETRY_HTTP_STATUS[result.code] != null) {
    return json({ ...result, error: RETRY_ERROR_TEXT[result.code] }, RETRY_HTTP_STATUS[result.code], origin);
  }
  // 카카오가 응답은 했지만 거절/판단불가(rejected·unknown) — 결과는 그대로 두고 202로 알린다
  return json(result, 202, origin);
}
