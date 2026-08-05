const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TEST_RECIPIENT_SLOT = 'TEST-SMS-001';
const SOLAPI_SEND_URL = 'https://api.solapi.com/messages/v4/send-many/detail';
const SOLAPI_ACTIVE_SENDERS_URL = 'https://api.solapi.com/senderid/v1/numbers/active';
const TASK_APP_URL = 'https://whdudwns33-wb.github.io/wb-site/task/';
const STAFF_DAILY_LIMIT = 2;
const GLOBAL_DAILY_LIMIT = 30;
const SOLAPI_TIMEOUT_MS = 8000;
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;
const OPS_ONCE_MAX_TTL_MS = 15 * 60 * 1000;
const ALLOWED_REQUEST_KEYS = new Set(['app', 'auth', 'reportDate', 'staffId']);
const ALLOWED_AUTH_KEYS = new Set(['mode', 'secret', 'id', 'token']);
const FORBIDDEN_REQUEST_KEYS = /(?:phone|^to$|^from$|message|recipient|guardian)/i;

function safeEqual(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

export function resolveDirectorReportOpsAuth(env, app, body, now = Date.now()) {
  if (app !== 'task' || !body || typeof body !== 'object' || Array.isArray(body)) return null;
  const auth = body.auth;
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return null;
  if (auth.mode !== 'ops_once' || typeof auth.secret !== 'string') return null;
  const authKeys = Object.keys(auth);
  if (authKeys.length !== 2 || authKeys.some(key => key !== 'mode' && key !== 'secret')) return null;

  let config;
  try {
    config = JSON.parse(String(env.WB_DIRECTOR_REPORT_ONESHOT || ''));
  } catch (error) {
    return null;
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const allowedConfigKeys = new Set(['token', 'nonce', 'staffId', 'reportDate', 'expiresAt', 'purpose']);
  const configKeys = Object.keys(config);
  if (configKeys.length !== allowedConfigKeys.size || configKeys.some(key => !allowedConfigKeys.has(key))) return null;

  const token = String(config.token || '');
  const nonce = String(config.nonce || '');
  const staffId = String(config.staffId || '');
  const reportDate = String(config.reportDate || '');
  const purpose = String(config.purpose || '');
  const expiresAt = Number(config.expiresAt);
  const timestamp = Number(now);
  if (!/^[A-Za-z0-9_-]{43,172}$/.test(token) ||
      !SAFE_ID.test(nonce) || !SAFE_ID.test(staffId) || !isIsoDate(reportDate) ||
      (purpose !== 'send' && purpose !== 'preflight') ||
      !Number.isSafeInteger(timestamp) || !Number.isSafeInteger(expiresAt) ||
      expiresAt <= timestamp || expiresAt > timestamp + OPS_ONCE_MAX_TTL_MS ||
      reportDate !== kstDateFromMs(timestamp) ||
      String(body.staffId || '') !== staffId || String(body.reportDate || '') !== reportDate ||
      !safeEqual(auth.secret, token)) {
    return null;
  }
  return { scope: 'all', opsOnce: { nonce, staffId, reportDate, expiresAt, purpose } };
}

function bytesToHex(value) {
  return Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value) {
  const encoded = new TextEncoder().encode(String(value || ''));
  return bytesToHex(await crypto.subtle.digest('SHA-256', encoded));
}

export function kstDateFromMs(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) throw new Error('invalid timestamp');
  return new Date(timestamp + (9 * 60 * 60 * 1000)).toISOString().slice(0, 10);
}

function isIsoDate(value) {
  const text = String(value || '');
  if (!SAFE_DATE.test(text)) return false;
  const parsed = new Date(text + 'T00:00:00Z');
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

function dayOfWeek(date) {
  return new Date(date + 'T00:00:00Z').getUTCDay();
}

function occursOn(task, date) {
  if (!task || task.deleted) return false;
  if (task.start && date < String(task.start)) return false;
  if (task.end && date > String(task.end)) return false;
  switch (task.repeat) {
    case 'once':
      return date === String(task.start || '');
    case 'daily':
      return true;
    case 'weekday': {
      const weekday = dayOfWeek(date);
      return weekday >= 1 && weekday <= 5;
    }
    case 'days':
      return (Array.isArray(task.days) ? task.days : []).map(Number).includes(dayOfWeek(date));
    default:
      return false;
  }
}

function parseObjectJson(value, label) {
  let parsed;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  } catch (error) {
    throw new Error(label + '_INVALID_JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(label + '_INVALID_OBJECT');
  }
  return parsed;
}

function checkHasProgress(task, check) {
  if (!check) return false;
  const steps = Array.isArray(task.steps) ? task.steps : [];
  if (steps.length) {
    return steps.some(step => step && step.id && check.steps && !!check.steps[step.id]);
  }
  if (Number(task.target) > 0) {
    const count = Number(check.count);
    return Number.isFinite(count) && count > 0;
  }
  return false;
}

export function summarizeReportRows(taskRows, checkRows, staffId, reportDate) {
  const tasks = [];
  for (const row of (Array.isArray(taskRows) ? taskRows : [])) {
    const task = parseObjectJson(row.data, 'TASK');
    if (String(row.id || '') !== String(task.id || '')) throw new Error('TASK_ID_MISMATCH');
    if (String(task.staffId || '') !== staffId) throw new Error('TASK_OWNER_MISMATCH');
    if (occursOn(task, reportDate)) tasks.push(task);
  }

  const taskIds = new Set(tasks.map(task => String(task.id)));
  const checks = new Map();
  for (const row of (Array.isArray(checkRows) ? checkRows : [])) {
    const key = String(row.k || '');
    const separator = key.lastIndexOf('|');
    if (separator <= 0) continue;
    const taskId = key.slice(0, separator);
    const date = key.slice(separator + 1);
    if (date !== reportDate || !taskIds.has(taskId)) continue;
    const check = parseObjectJson(row.data, 'CHECK');
    if (check.taskId != null && String(check.taskId) !== taskId) throw new Error('CHECK_TASK_MISMATCH');
    if (check.date != null && String(check.date) !== reportDate) throw new Error('CHECK_DATE_MISMATCH');
    checks.set(taskId, check);
  }

  const summary = { done: 0, total: tasks.length, doing: 0, todo: 0, blocked: 0, pct: 0 };
  for (const task of tasks) {
    const check = checks.get(String(task.id));
    if (check && check.blocked) summary.blocked += 1;
    else if (check && check.done) summary.done += 1;
    else if (checkHasProgress(task, check)) summary.doing += 1;
    else summary.todo += 1;
  }
  summary.pct = summary.total ? Math.round((summary.done / summary.total) * 100) : 0;
  return summary;
}

export function buildDirectorReportText(reportDate, staffName, summary) {
  return [
    '[WB 오늘 수행 보고]',
    '담당: ' + staffName,
    reportDate + ' 기준',
    '전체 ' + summary.total + '건',
    '완료 ' + summary.done + '건',
    '진행 ' + summary.doing + '건',
    '미완료 ' + summary.todo + '건',
    '막힘 ' + summary.blocked + '건',
    '수행률 ' + summary.pct + '%',
    '상세 내용은 업무지시서 원장 화면에서 확인해 주세요.',
    TASK_APP_URL
  ].join('\n');
}

export async function buildSolapiAuthorization(apiKey, apiSecret, date, salt) {
  const requestDate = String(date || new Date().toISOString());
  const requestSalt = String(salt || crypto.randomUUID());
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(apiSecret || '')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = bytesToHex(await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(requestDate + requestSalt)
  ));
  return 'HMAC-SHA256 apiKey=' + apiKey + ', date=' + requestDate +
    ', salt=' + requestSalt + ', signature=' + signature;
}

function validateRequestShape(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '요청 형식을 확인해 주세요';
  for (const key of Object.keys(body)) {
    if (FORBIDDEN_REQUEST_KEYS.test(key) || !ALLOWED_REQUEST_KEYS.has(key)) {
      return '수신자나 문자 내용은 요청에서 지정할 수 없습니다';
    }
  }
  if (!body.auth || typeof body.auth !== 'object' || Array.isArray(body.auth)) {
    return '인증 정보를 확인해 주세요';
  }
  for (const key of Object.keys(body.auth)) {
    if (FORBIDDEN_REQUEST_KEYS.test(key) || !ALLOWED_AUTH_KEYS.has(key)) {
      return '수신자나 문자 내용은 요청에서 지정할 수 없습니다';
    }
  }
  return null;
}

function normalizedDigits(value) {
  return String(value || '').replace(/[\s()-]/g, '');
}

function solapiBaseConfiguration(env) {
  if (!env.SOLAPI_API_KEY || !env.SOLAPI_API_SECRET || !env.SOLAPI_SENDER_NUMBER ||
      !env.SOLAPI_KAKAO_PF_ID || !env.SOLAPI_DIRECTOR_REPORT_TEMPLATE_ID) return null;
  const sender = normalizedDigits(env.SOLAPI_SENDER_NUMBER);
  if (!/^\d{8,12}$/.test(sender)) return null;
  const pfId = String(env.SOLAPI_KAKAO_PF_ID).trim();
  const templateId = String(env.SOLAPI_DIRECTOR_REPORT_TEMPLATE_ID).trim();
  if (!/^KA01PF[A-Za-z0-9_-]{8,}$/.test(pfId) ||
      !/^KA01TP[A-Za-z0-9_-]{8,}$/.test(templateId)) return null;
  return {
    apiKey: String(env.SOLAPI_API_KEY).trim(),
    apiSecret: String(env.SOLAPI_API_SECRET).trim(),
    sender,
    pfId,
    templateId
  };
}

export function buildDirectorReportVariables(reportDate, staffName, summary) {
  return {
    '#{staff_name}': String(staffName),
    '#{report_date}': String(reportDate),
    '#{total_count}': String(summary.total),
    '#{done_count}': String(summary.done),
    '#{doing_count}': String(summary.doing),
    '#{todo_count}': String(summary.todo),
    '#{blocked_count}': String(summary.blocked),
    '#{completion_rate}': String(summary.pct) + '%'
  };
}

function sendConfiguration(env) {
  const base = solapiBaseConfiguration(env);
  if (!base ||
      !safeEqual(env.WB_SEND_MODE, 'test') ||
      !safeEqual(env.WB_TEST_RECIPIENT_ID, TEST_RECIPIENT_SLOT) ||
      !safeEqual(env.WB_ACTUAL_TEST_SEND_APPROVED, 'true') ||
      !env.SOLAPI_TEST_RECIPIENT_PHONE) {
    return null;
  }
  const recipient = normalizedDigits(env.SOLAPI_TEST_RECIPIENT_PHONE);
  if (!/^01[016789]\d{7,8}$/.test(recipient)) return null;
  return { ...base, recipient };
}

async function activeStaff(env, app, staffId) {
  const row = await env.DB.prepare('SELECT data FROM staff WHERE app=? AND id=? LIMIT 1')
    .bind(app, staffId).first();
  if (!row) return null;
  try {
    const data = parseObjectJson(row.data, 'STAFF');
    const name = String(data.name || '').replace(/\s+/g, ' ').trim();
    if (String(data.id || staffId) !== staffId || data.deleted || !name || name.length > 40 ||
        /[\r\n\u0000-\u001f]/.test(name) || !/^[가-힣A-Za-z·.\- ]+$/.test(name)) {
      return null;
    }
    return { name };
  } catch (error) {
    return null;
  }
}

async function loadSummary(env, app, staffId, reportDate) {
  const tasks = await env.DB.prepare('SELECT id,data FROM tasks WHERE app=? AND owner=?')
    .bind(app, staffId).all();
  const checks = await env.DB.prepare('SELECT k,data FROM checks WHERE app=? AND owner=? AND k LIKE ?')
    .bind(app, staffId, '%|' + reportDate).all();
  return summarizeReportRows(tasks.results || [], checks.results || [], staffId, reportDate);
}

function safeProviderId(value) {
  const text = String(value || '');
  return /^[A-Za-z0-9_-]{1,128}$/.test(text) ? text : null;
}

function safeProviderStatus(value) {
  const text = String(value || '');
  return /^\d{1,16}$/.test(text) ? text : null;
}

function safeProviderErrorCode(value) {
  const text = String(value || '');
  return /^[A-Za-z0-9_-]{1,64}$/.test(text) ? text : null;
}

function statusLabel(status) {
  if (status === 'accepted') return '접수';
  if (status === 'rejected') return '접수 실패';
  return '확인 필요';
}

function publicResult(row, idempotent) {
  const total = Number(row.total_count) || 0;
  const done = Number(row.done_count) || 0;
  return {
    ok: row.status !== 'rejected',
    idempotent: !!idempotent,
    recipientLabel: '원장님 본인',
    reportDate: row.report_date,
    summary: {
      done,
      total,
      doing: Number(row.doing_count) || 0,
      todo: Number(row.todo_count) || 0,
      blocked: Number(row.blocked_count) || 0,
      pct: total ? Math.round((done / total) * 100) : 0
    },
    send: {
      sendId: row.send_id,
      status: row.status,
      statusLabel: statusLabel(row.status),
      acceptedMeans: '접수',
      createdAt: Number(row.created_at) || 0,
      updatedAt: Number(row.updated_at) || 0,
      errorCode: row.safe_error_code || undefined
    }
  };
}

async function findByIdempotency(env, app, idempotencyKey) {
  return await env.DB.prepare(
    'SELECT * FROM director_report_sends WHERE app=? AND idempotency_key=? LIMIT 1'
  ).bind(app, idempotencyKey).first();
}

async function updateLedger(env, app, sendId, status, provider, safeErrorCode, now) {
  const result = await env.DB.prepare(
    'UPDATE director_report_sends SET status=?, provider_group_id=?, provider_message_id=?, ' +
    'provider_status_code=?, safe_error_code=?, updated_at=? ' +
    "WHERE app=? AND send_id=? AND status='dispatching'"
  ).bind(
    status,
    provider && provider.groupId || null,
    provider && provider.messageId || null,
    provider && provider.statusCode || null,
    safeErrorCode || null,
    now,
    app,
    sendId
  ).run();
  return Number(result && result.meta && result.meta.changes || 0) === 1;
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
  if (!groupId || !messageId || !statusCode) {
    return { status: 'unknown', errorCode: 'SOLAPI_AMBIGUOUS_RESPONSE' };
  }
  const provider = { groupId, messageId, statusCode };
  if (statusCode === '2000' || statusCode === '3000' || statusCode === '4000') {
    return { status: 'accepted', provider };
  }
  return { status: 'rejected', provider, errorCode: 'SOLAPI_REJECTED' };
}

function responseStatusFor(sendStatus) {
  if (sendStatus === 'accepted') return 200;
  if (sendStatus === 'rejected') return 502;
  return 202;
}

export async function handleDirectorReportPreflight(env, app, body, origin, auth, json) {
  if (app !== 'task' || !auth || !auth.opsOnce || auth.opsOnce.purpose !== 'preflight') {
    return json({ ok: false, error: '사전점검 권한이 없습니다' }, 403, origin);
  }
  const shapeError = validateRequestShape(body);
  if (shapeError) return json({ ok: false, error: shapeError }, 400, origin);
  if (!safeEqual(env.WB_ACTUAL_TEST_SEND_APPROVED, 'false')) {
    return json({ ok: false, code: 'PREFLIGHT_REQUIRES_CLOSED_GATE', error: '발송 게이트를 닫은 뒤 점검해 주세요' }, 409, origin);
  }
  const config = solapiBaseConfiguration(env);
  if (!config) {
    return json({ ok: false, code: 'SOLAPI_CONFIG_INCOMPLETE', error: 'Solapi 기본 설정을 확인해 주세요' }, 503, origin);
  }

  const authorization = await buildSolapiAuthorization(config.apiKey, config.apiSecret);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOLAPI_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(SOLAPI_ACTIVE_SENDERS_URL, {
      method: 'GET',
      headers: { Authorization: authorization, Accept: 'application/json' },
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timeout);
    return json({
      ok: false,
      code: controller.signal.aborted ? 'SOLAPI_PREFLIGHT_TIMEOUT' : 'SOLAPI_PREFLIGHT_NETWORK',
      error: 'Solapi 읽기 전용 점검에 실패했습니다'
    }, 502, origin);
  }
  clearTimeout(timeout);

  let payload;
  try {
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
      return json({ ok: false, code: 'SOLAPI_PREFLIGHT_RESPONSE_TOO_LARGE', error: 'Solapi 점검 응답을 확인해 주세요' }, 502, origin);
    }
    payload = raw ? JSON.parse(raw) : null;
  } catch (error) {
    return json({ ok: false, code: 'SOLAPI_PREFLIGHT_INVALID_RESPONSE', error: 'Solapi 점검 응답을 확인해 주세요' }, 502, origin);
  }

  if (!response.ok) {
    return json({
      ok: false,
      authOk: response.status === 401 || response.status === 403 ? false : null,
      senderActive: null,
      providerHttpStatus: response.status,
      providerErrorCode: safeProviderErrorCode(payload && payload.errorCode) || undefined
    }, 200, origin);
  }
  if (!Array.isArray(payload)) {
    return json({ ok: false, code: 'SOLAPI_PREFLIGHT_INVALID_RESPONSE', error: 'Solapi 점검 응답을 확인해 주세요' }, 502, origin);
  }
  const senderActive = payload.some(item =>
    item && item.status === 'ACTIVE' && normalizedDigits(item.phoneNumber) === config.sender
  );
  return json({
    ok: true,
    authOk: true,
    senderConfigured: true,
    senderActive,
    activeSenderCount: Math.min(payload.length, 1000)
  }, 200, origin);
}

export async function handleDirectorReportSend(env, app, body, origin, auth, json) {
  if (app !== 'task') {
    return json({ ok: false, error: '오늘 수행 보고는 task 앱에서만 사용할 수 있습니다' }, 400, origin);
  }
  const shapeError = validateRequestShape(body);
  if (shapeError) return json({ ok: false, error: shapeError }, 400, origin);
  if (auth && auth.opsOnce && auth.opsOnce.purpose !== 'send') {
    return json({ ok: false, error: '발송 전용 인증이 필요합니다' }, 403, origin);
  }

  let staffId;
  if (auth.scope === 'own') {
    if (body.staffId != null && String(body.staffId) !== auth.id) {
      return json({ ok: false, error: '개인 링크에서는 본인의 수행 보고만 보낼 수 있습니다' }, 403, origin);
    }
    staffId = auth.id;
  } else if (auth.scope === 'all') {
    staffId = String(body.staffId || '');
    if (!SAFE_ID.test(staffId)) {
      return json({ ok: false, error: '원장 화면에서는 활성 staffId를 지정해 주세요' }, 400, origin);
    }
  } else {
    return json({ ok: false, error: '발송 권한이 없습니다' }, 403, origin);
  }
  if (!SAFE_ID.test(staffId)) return json({ ok: false, error: '올바른 담당자 정보가 필요합니다' }, 400, origin);

  const todayKst = kstDateFromMs(Date.now());
  const reportDate = String(body.reportDate || '');
  if (!isIsoDate(reportDate) || reportDate !== todayKst) {
    return json({ ok: false, error: '한국시간 오늘 수행 보고만 보낼 수 있습니다' }, 400, origin);
  }
  const staff = await activeStaff(env, app, staffId);
  if (!staff) {
    return json({ ok: false, error: '활성 직원을 찾을 수 없습니다' }, 404, origin);
  }

  const config = sendConfiguration(env);
  if (!config) {
    return json({ ok: false, code: 'TEST_SEND_DISABLED', error: '원장 테스트 발송 설정이 완전하지 않아 차단했습니다' }, 503, origin);
  }

  let summary;
  try {
    summary = await loadSummary(env, app, staffId, reportDate);
  } catch (error) {
    return json({ ok: false, code: 'REPORT_DATA_INVALID', error: '오늘 수행 현황을 안전하게 집계하지 못했습니다' }, 409, origin);
  }
  const reportText = buildDirectorReportText(reportDate, staff.name, summary);
  const templateVariables = buildDirectorReportVariables(reportDate, staff.name, summary);

  const messageHash = await sha256Hex(reportText);
  const idempotencyKey = auth.opsOnce
    ? await sha256Hex(['ops_once', app, auth.opsOnce.nonce].join('\u001f'))
    : await sha256Hex([app, staffId, reportDate, TEST_RECIPIENT_SLOT, messageHash].join('\u001f'));
  const sendId = 'drs_' + idempotencyKey.slice(0, 48);
  const now = Date.now();
  const inserted = await env.DB.prepare(
    'INSERT OR IGNORE INTO director_report_sends ' +
    '(app,send_id,idempotency_key,report_date,staff_id,recipient_slot,total_count,done_count,doing_count,todo_count,blocked_count,message_hash,status,created_at,updated_at) ' +
    "SELECT ?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?,? " +
    'WHERE (SELECT COUNT(*) FROM director_report_sends WHERE app=? AND report_date=? AND staff_id=?) < ' + STAFF_DAILY_LIMIT + ' ' +
    'AND (SELECT COUNT(*) FROM director_report_sends WHERE app=? AND report_date=?) < ' + GLOBAL_DAILY_LIMIT
  ).bind(
    app, sendId, idempotencyKey, reportDate, staffId, TEST_RECIPIENT_SLOT,
    summary.total, summary.done, summary.doing, summary.todo, summary.blocked,
    messageHash, now, now,
    app, reportDate, staffId,
    app, reportDate
  ).run();
  if (Number(inserted && inserted.meta && inserted.meta.changes || 0) !== 1) {
    const existing = await findByIdempotency(env, app, idempotencyKey);
    if (existing) {
      const view = publicResult(existing, true);
      return json(view, responseStatusFor(existing.status), origin);
    }
    return json({
      ok: false,
      code: 'DAILY_SEND_LIMIT',
      error: '오늘 테스트 발송 한도에 도달했습니다',
      recipientLabel: '원장님 본인',
      reportDate,
      summary
    }, 429, origin);
  }

  const dispatchAt = Date.now();
  const dispatch = await env.DB.prepare(
    "UPDATE director_report_sends SET status='dispatching', dispatch_started_at=?, updated_at=? " +
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
      headers: {
        'Content-Type': 'application/json;charset=utf-8',
        Authorization: authorization
      },
      body: JSON.stringify({
        messages: [{
          to: config.recipient,
          type: 'ATA',
          autoTypeDetect: false,
          kakaoOptions: {
            pfId: config.pfId,
            templateId: config.templateId,
            variables: templateVariables,
            disableSms: true
          },
          customFields: { wbSendId: sendId }
        }],
        strict: true,
        allowDuplicates: false,
        showMessageList: true
      }),
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timeout);
    const code = controller.signal.aborted ? 'SOLAPI_TIMEOUT' : 'SOLAPI_NETWORK';
    await updateLedger(env, app, sendId, 'unknown', null, code, Date.now());
    const row = await findByIdempotency(env, app, idempotencyKey);
    return json(publicResult(row || {
      app, send_id: sendId, report_date: reportDate, ...{
        total_count: summary.total, done_count: summary.done, doing_count: summary.doing,
        todo_count: summary.todo, blocked_count: summary.blocked
      }, status: 'unknown', safe_error_code: code, created_at: now, updated_at: Date.now()
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
  const updatedAt = Date.now();
  const updated = await updateLedger(
    env, app, sendId, outcome.status, outcome.provider || null, outcome.errorCode || null, updatedAt
  );
  if (!updated) {
    return json({
      ok: false,
      code: 'SEND_RESULT_NOT_RECORDED',
      error: '접수 결과를 기록하지 못했습니다. 다시 발송하지 말고 발송 내역을 확인해 주세요',
      recipientLabel: '원장님 본인'
    }, 202, origin);
  }
  const finalRow = await findByIdempotency(env, app, idempotencyKey);
  if (!finalRow) {
    return json({
      ok: false,
      code: 'SEND_RESULT_NOT_RECORDED',
      error: '접수 결과를 확인하지 못했습니다. 다시 발송하지 말고 발송 내역을 확인해 주세요',
      recipientLabel: '원장님 본인'
    }, 202, origin);
  }
  return json(publicResult(finalRow, false), responseStatusFor(outcome.status), origin);
}

export const directorReportConstants = Object.freeze({
  TEST_RECIPIENT_SLOT,
  SOLAPI_SEND_URL,
  SOLAPI_ACTIVE_SENDERS_URL,
  TASK_APP_URL,
  STAFF_DAILY_LIMIT,
  GLOBAL_DAILY_LIMIT,
  OPS_ONCE_MAX_TTL_MS
});
