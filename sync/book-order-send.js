/**
 * 교재 주문 문자를 거래처(출판사)에 실제로 보낸다.
 *
 * director-report-send.js와 같은 안전장치를 따른다 — 다만 그건 원장 본인
 * 테스트 번호 하나에만 고정해서 열어둔 것이고, 여긴 거래처마다 번호가 다르므로
 * "번호를 앱이 정하게 하면 안 된다"는 원칙을 다른 방식으로 지킨다:
 *   · 앱은 거래처 "이름"만 보낸다. 실제 전화번호는 앱이 절대 못 보내고,
 *     서버가 자기만 아는 비밀키(BOOK_VENDOR_PHONES)에서 찾는다.
 *   · 문자 내용도 앱이 자유 텍스트로 못 보낸다. 서버가 주문 지시서(taskId)를
 *     D1에서 직접 읽어 정해진 틀로 만든다.
 *   · 코드가 배포돼도 기본은 꺼짐 — WB_BOOK_ORDER_SEND_ENABLED가 'true'여야
 *     실제로 나간다. 거래처 번호를 다 확인하기 전에는 이 스위치를 켜지 않는다.
 *   · 하루 발송 한도를 둬서 실수로 반복 클릭해도 폭주하지 않는다.
 *
 *   POST /book-order-send { app, auth, taskId } → 실제 주문
 *   POST /book-order-send { app, auth, action:'sample' } → root/allowlist manager 본인 일일 샘플
 *   POST /book-order-send { app, auth, action:'retry-rejected' } → 확정 거절 배치만 당일 1회 재시도
 */

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SOLAPI_SEND_URL = 'https://api.solapi.com/messages/v4/send-many/detail';
const SOLAPI_TIMEOUT_MS = 8000;
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;
const GLOBAL_DAILY_LIMIT = 30;
const MAX_MESSAGE_BYTES = 2000;
const SAMPLE_RECIPIENT_SLOT = 'TEST-SMS-001';
const SAMPLE_IDEMPOTENCY_VERSION = 'BOOK_ORDER_SAMPLE_V1';
const SAMPLE_TASK_PREFIX = 'sample:book-order:';
const SAMPLE_VENDOR_NAME = '__BOOK_ORDER_SAMPLE__';
const SAMPLE_ITEMS = [{ title: '교재 주문 발송 경로 점검 (실제 주문 아님)', qty: '1권' }];
const REJECTED_RETRY_VERSION = 'BOOK_ORDER_REJECTED_RETRY_V1';
const ALLOWED_REQUEST_KEYS = new Set(['app', 'auth', 'taskId', 'action']);
const ALLOWED_AUTH_KEYS = new Set(['mode', 'secret', 'id', 'token']);
const FORBIDDEN_REQUEST_KEYS = /(?:phone|^to$|^from$|message|recipient|vendor)/i;

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
      return '거래처 번호나 문자 내용은 요청에서 지정할 수 없습니다';
    }
  }
  if (!body.auth || typeof body.auth !== 'object' || Array.isArray(body.auth)) return '인증 정보를 확인해 주세요';
  for (const key of Object.keys(body.auth)) {
    if (FORBIDDEN_REQUEST_KEYS.test(key) || !ALLOWED_AUTH_KEYS.has(key)) {
      return '거래처 번호나 문자 내용은 요청에서 지정할 수 없습니다';
    }
  }
  return null;
}

function solapiConfiguration(env) {
  if (!env.SOLAPI_API_KEY || !env.SOLAPI_API_SECRET || !env.SOLAPI_SENDER_NUMBER) return null;
  const apiKey = String(env.SOLAPI_API_KEY).trim();
  const apiSecret = String(env.SOLAPI_API_SECRET).trim();
  const sender = normalizedDigits(env.SOLAPI_SENDER_NUMBER);
  if (!apiKey || !apiSecret || !/^\d{8,12}$/.test(sender)) return null;
  return { apiKey, apiSecret, sender };
}

/** 코드가 배포돼도 실제 거래처 발송은 명시 스위치까지 갖춰져야만 켜진다 */
function sendConfiguration(env) {
  return safeEqual(env.WB_BOOK_ORDER_SEND_ENABLED, 'true') ? solapiConfiguration(env) : null;
}

/** 본인 샘플은 거래처 발송 스위치와 분리하고, 고정된 테스트 수신처만 허용한다. */
function sampleSendConfiguration(env) {
  if (!safeEqual(env.WB_SEND_MODE, 'test') ||
      !safeEqual(env.WB_TEST_RECIPIENT_ID, SAMPLE_RECIPIENT_SLOT) ||
      !safeEqual(env.WB_ACTUAL_TEST_SEND_APPROVED, 'true') ||
      !safeEqual(env.WB_BOOK_ORDER_SAMPLE_ENABLED, 'true')) return null;
  const config = solapiConfiguration(env);
  const recipient = normalizedDigits(env.SOLAPI_TEST_RECIPIENT_PHONE);
  return config && /^01[016789]\d{7,8}$/.test(recipient) ? { ...config, recipient } : null;
}

function kstDate(ms) {
  return new Date((Number(ms) || Date.now()) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function isRetryCronWindow(ms) {
  const value = Number(ms);
  const shifted = new Date((Number.isFinite(value) ? value : Date.now()) + 9 * 60 * 60 * 1000);
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  return minutes >= 19 * 60 + 45 && minutes <= 20 * 60 + 30;
}

function canOperateBookOrder(auth) {
  const rootAdmin = auth && auth.scope === 'all' && !auth.role && !auth.id && !auth.device;
  const manager = auth && auth.scope === 'all' && auth.role === 'manager' &&
    SAFE_ID.test(String(auth.id || '')) && !auth.device;
  return !!(rootAdmin || manager);
}

/** 거래처 전화번호는 앱이 절대 못 정한다 — 서버 비밀키(BOOK_VENDOR_PHONES, JSON)에서만 찾는다 */
function vendorPhone(env, vendorName) {
  let map;
  try { map = JSON.parse(env.BOOK_VENDOR_PHONES || '{}'); }
  catch (error) { return null; }
  if (!map || typeof map !== 'object') return null;
  const raw = map[vendorName];
  const phone = normalizedDigits(raw);
  return /^01[016789]\d{7,8}$/.test(phone) ? phone : null;
}

function buildOrderMessage(vendorName, items) {
  const lines = items.map(item => '· ' + item.title + ': ' + item.qty);
  return '안녕하세요, WB 웩슬러브레인센터(독해력학원)입니다.\n교재 주문 부탁드립니다.\n\n' +
    lines.join('\n') + '\n\n입고 예정일 회신 부탁드립니다. 감사합니다.';
}

async function loadOrderTask(env, app, taskId, auth) {
  const row = await env.DB.prepare('SELECT owner, data FROM tasks WHERE app=? AND id=? LIMIT 1')
    .bind(app, taskId).first();
  if (!row) return { error: '주문 지시서를 찾을 수 없습니다', status: 404 };
  let data;
  try { data = JSON.parse(row.data || '{}'); } catch (error) { return { error: '지시서 데이터가 올바르지 않습니다', status: 409 }; }
  if (data.deleted) return { error: '삭제된 지시서입니다', status: 409 };
  if (!String(data.title || '').startsWith('[주문] ')) return { error: '교재 주문 지시서가 아닙니다', status: 409 };
  const vendorName = String(data.orderVendor || '').trim();
  const items = Array.isArray(data.orderItems) ? data.orderItems : [];
  const cleanItems = items
    .map(it => ({ title: String((it && it.title) || '').trim(), qty: String((it && it.qty) || '').trim() }))
    .filter(it => it.title);
  if (!vendorName || !cleanItems.length) {
    return { error: '이 지시서에는 자동 발송용 주문 정보(거래처·교재 목록)가 없습니다', status: 409 };
  }
  if (auth.scope === 'own' && row.owner !== auth.id) {
    return { error: '본인에게 배정된 주문만 발송할 수 있습니다', status: 403 };
  }
  return { vendorName, items: cleanItems, owner: row.owner };
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
    const rawCode = String(payload && (payload.errorCode || payload.statusCode) || '');
    const safeCode = rawCode.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40).toUpperCase();
    return response.status >= 500
      ? { status: 'unknown', errorCode: 'SOLAPI_HTTP_' + response.status + (safeCode ? '_' + safeCode : '') }
      : { status: 'rejected', errorCode: 'SOLAPI_HTTP_' + response.status + (safeCode ? '_' + safeCode : '') };
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
  const sample = String(row.task_id || '').startsWith(SAMPLE_TASK_PREFIX);
  return {
    ok: row.status !== 'rejected',
    idempotent: !!idempotent,
    ...(sample
      ? { sample: true, recipientLabel: '원장님 본인' }
      : { vendorName: row.vendor_name }),
    itemCount: Number(row.item_count) || 0,
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
  return await env.DB.prepare('SELECT * FROM book_order_sends WHERE app=? AND idempotency_key=? LIMIT 1')
    .bind(app, idempotencyKey).first();
}

async function findBatchSendForTask(env, app, taskId) {
  return await env.DB.prepare(
    'SELECT s.* FROM book_order_batch_items i JOIN book_order_sends s ON s.app=i.app AND s.send_id=i.send_id ' +
    'WHERE i.app=? AND i.task_id=? LIMIT 1'
  ).bind(app, taskId).first();
}

async function saveBatchItems(env, app, sendId, taskIds, now) {
  if (!taskIds.length) return;
  await env.DB.batch(taskIds.map(taskId => env.DB.prepare(
    'INSERT INTO book_order_batch_items(app,task_id,send_id,created_at) VALUES(?,?,?,?) ' +
    'ON CONFLICT(app,task_id) DO UPDATE SET send_id=excluded.send_id, created_at=excluded.created_at'
  ).bind(app, taskId, sendId, now)));
}

async function updateLedger(env, app, sendId, status, provider, safeErrorCode, now) {
  const result = await env.DB.prepare(
    'UPDATE book_order_sends SET status=?, provider_group_id=?, provider_message_id=?, ' +
    'provider_status_code=?, safe_error_code=?, updated_at=? ' +
    "WHERE app=? AND send_id=? AND status='dispatching'"
  ).bind(
    status, provider && provider.groupId || null, provider && provider.messageId || null,
    provider && provider.statusCode || null, safeErrorCode || null, now, app, sendId
  ).run();
  return Number(result && result.meta && result.meta.changes || 0) === 1;
}

async function dispatchOrderMessage(env, app, taskId, vendorName, items, batchTaskIds, origin, json, mode) {
  const sample = mode === 'sample';
  const config = sample ? sampleSendConfiguration(env) : sendConfiguration(env);
  if (!config) {
    return sample
      ? json({ ok: false, code: 'SAMPLE_SEND_DISABLED', error: '본인 샘플 발송 설정이 완전하지 않아 차단했습니다' }, 503, origin)
      : json({ ok: false, code: 'SEND_DISABLED', error: '교재 주문 자동 발송이 아직 켜져 있지 않습니다' }, 503, origin);
  }
  const phone = sample ? config.recipient : vendorPhone(env, vendorName);
  if (!phone) {
    return json({
      ok: false, code: 'VENDOR_PHONE_MISSING',
      error: '"' + vendorName + '" 거래처 번호가 등록되지 않았습니다 — 문자 앱으로 직접 보내주세요'
    }, 409, origin);
  }

  const messageText = (sample ? '[테스트 발송 · 실제 주문 아님]\n' : '') + buildOrderMessage(vendorName, items);
  if (new TextEncoder().encode(messageText).byteLength > MAX_MESSAGE_BYTES) {
    return json({ ok: false, error: '주문 목록이 너무 많아 문자 한 통에 안 들어갑니다 — 나눠서 주문해 주세요' }, 413, origin);
  }
  const messageHash = await sha256Hex(messageText);
  const idempotencyKey = await sha256Hex((sample
    ? [app, SAMPLE_IDEMPOTENCY_VERSION, taskId, SAMPLE_RECIPIENT_SLOT]
    : [app, taskId, phone, messageHash]).join('\u001f'));
  const sendId = (sample ? 'boss_' : 'bos_') + idempotencyKey.slice(0, 48);
  const now = Date.now();

  const inserted = await env.DB.prepare(
    'INSERT OR IGNORE INTO book_order_sends ' +
    '(app,send_id,idempotency_key,task_id,vendor_name,item_count,message_hash,status,created_at,updated_at) ' +
    "SELECT ?,?,?,?,?,?,?,'reserved',?,? " +
    "WHERE ?=1 OR (SELECT COUNT(*) FROM book_order_sends WHERE app=? AND created_at > ? AND task_id NOT LIKE ?) < " +
      GLOBAL_DAILY_LIMIT
  ).bind(
    app, sendId, idempotencyKey, taskId, vendorName, items.length, messageHash, now, now,
    sample ? 1 : 0, app, now - 24 * 60 * 60 * 1000, SAMPLE_TASK_PREFIX + '%'
  ).run();

  if (Number(inserted && inserted.meta && inserted.meta.changes || 0) !== 1) {
    const existing = await findByIdempotency(env, app, idempotencyKey);
    if (existing) {
      await saveBatchItems(env, app, existing.send_id, batchTaskIds, now);
      return json(publicResult(existing, true), responseStatusFor(existing.status), origin);
    }
    return json({ ok: false, code: 'DAILY_SEND_LIMIT', error: '오늘 발송 한도에 도달했습니다', vendorName }, 429, origin);
  }

  await saveBatchItems(env, app, sendId, batchTaskIds, now);

  const dispatchAt = Date.now();
  const dispatch = await env.DB.prepare(
    "UPDATE book_order_sends SET status='dispatching', dispatch_started_at=?, updated_at=? " +
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
          to: phone, from: config.sender, text: messageText, type: 'LMS', subject: 'WB 교재 주문',
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
      app, send_id: sendId, task_id: taskId, vendor_name: vendorName, item_count: items.length,
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
  const finalRow = await findByIdempotency(env, app, idempotencyKey);
  return json(publicResult(finalRow || {
    app, send_id: sendId, task_id: taskId, vendor_name: vendorName, item_count: items.length,
    status: outcome.status, safe_error_code: outcome.errorCode, created_at: now, updated_at: Date.now()
  }, false), responseStatusFor(outcome.status), origin);
}

/**
 * 현재 mapping이 rejected인 예약 주문만 서버에서 다시 모은다.
 * accepted/unknown/reserved/dispatching 이력이 하나라도 있으면 fail-closed로 제외한다.
 * 날짜+거래처+task 집합으로 멱등키를 고정해 같은 날 반복 클릭도 실제 재발송하지 않는다.
 */
async function retryRejectedBookOrders(env, app, origin, json) {
  const now = Date.now();
  if (isRetryCronWindow(now)) {
    return json({
      ok: false,
      code: 'RETRY_CRON_WINDOW',
      error: '20:00 예약 발송과 겹치지 않도록 20:30 이후 다시 시도해 주세요'
    }, 409, origin);
  }
  const retryDate = kstDate(now).replace(/-/g, '');
  const retryPrefix = 'retry_' + retryDate + '_';

  const selected = await env.DB.prepare(
    "SELECT t.id,t.data FROM book_order_batch_items i " +
    "JOIN book_order_sends failed ON failed.app=i.app AND failed.send_id=i.send_id " +
    "JOIN tasks t ON t.app=i.app AND t.id=i.task_id " +
    "WHERE i.app=? AND failed.status='rejected' " +
    "AND failed.task_id NOT LIKE ? " +
    "AND NOT EXISTS (SELECT 1 FROM book_order_sends active " +
      "WHERE active.app=i.app AND active.task_id=i.task_id " +
      "AND active.status IN ('reserved','dispatching','accepted','unknown')) " +
    'ORDER BY t.updated_at,t.id LIMIT 2000'
  ).bind(app, retryPrefix + '%').all();

  const groups = new Map();
  const cutoff = now;
  for (const row of selected.results || []) {
    let task;
    try { task = JSON.parse(row.data || '{}'); } catch (error) { continue; }
    if (task.deleted || task.orderDelivery !== 'scheduled_batch_v1' || Number(task.createdAt) > cutoff) continue;
    const vendorName = String(task.orderVendor || '').trim();
    const items = (Array.isArray(task.orderItems) ? task.orderItems : [])
      .map(item => ({ title: String((item && item.title) || '').trim(), qty: String((item && item.qty) || '').trim() }))
      .filter(item => item.title);
    if (!vendorName || !items.length) continue;
    if (!groups.has(vendorName)) groups.set(vendorName, { taskIds: [], items: [] });
    groups.get(vendorName).taskIds.push(row.id);
    groups.get(vendorName).items.push(...items);
  }

  if (!groups.size) {
    return json({ ok: true, idempotent: true, action: 'retry-rejected', results: [] }, 200, origin);
  }
  if (!sendConfiguration(env)) {
    return json({ ok: false, code: 'SEND_DISABLED', error: '교재 주문 자동 발송이 아직 켜져 있지 않습니다' }, 503, origin);
  }

  const previews = [];
  for (const [vendorName, group] of groups) {
    if (!vendorPhone(env, vendorName)) {
      return json({ ok: false, code: 'VENDOR_PHONE_MISSING', error: '거래처 번호 등록을 먼저 확인해 주세요' }, 409, origin);
    }
    const messageBytes = new TextEncoder().encode(buildOrderMessage(vendorName, group.items)).byteLength;
    if (messageBytes > MAX_MESSAGE_BYTES) {
      return json({ ok: false, code: 'MESSAGE_TOO_LARGE', error: '주문 목록이 너무 많아 문자 한 통에 안 들어갑니다' }, 413, origin);
    }
    previews.push({ vendorName, taskCount: group.taskIds.length, itemCount: group.items.length, messageBytes });
  }

  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM book_order_sends WHERE app=? AND created_at>? AND task_id NOT LIKE ?"
  ).bind(app, now - 24 * 60 * 60 * 1000, SAMPLE_TASK_PREFIX + '%').first();
  if ((Number(recent && recent.count) || 0) + groups.size > GLOBAL_DAILY_LIMIT) {
    return json({ ok: false, code: 'DAILY_SEND_LIMIT', error: '오늘 발송 한도에 도달했습니다' }, 429, origin);
  }

  const results = [];
  for (let i = 0; i < previews.length; i++) {
    const preview = previews[i];
    const group = groups.get(preview.vendorName);
    const taskIds = group.taskIds.slice().sort();
    const key = await sha256Hex([REJECTED_RETRY_VERSION, retryDate, preview.vendorName, ...taskIds].join('\u001f'));
    const retryBatchId = 'retry_' + retryDate + '_' + key.slice(0, 40);
    const response = await dispatchOrderMessage(
      env, app, retryBatchId, preview.vendorName, group.items, taskIds, origin, json
    );
    const result = await response.json();
    results.push({ ...preview, idempotent: !!result.idempotent,
      status: result && result.send && result.send.status || result.code || 'failed' });
  }

  const rejected = results.some(result => result.status === 'rejected');
  const uncertain = results.some(result => result.status !== 'accepted' && result.status !== 'rejected');
  return json({ ok: !rejected && !uncertain, action: 'retry-rejected', results },
    rejected ? 502 : uncertain ? 202 : 200, origin);
}

export async function handleBookOrderSend(env, app, body, origin, auth, json) {
  if (app !== 'task') return json({ ok: false, error: '교재 주문 발송은 task 앱에서만 사용할 수 있습니다' }, 400, origin);
  const shapeError = validateRequestShape(body);
  if (shapeError) return json({ ok: false, error: shapeError }, 400, origin);

  if (body.action != null) {
    if (body.taskId != null || (body.action !== 'sample' && body.action !== 'retry-rejected')) {
      return json({ ok: false, error: '지원하는 발송 action만 지정해 주세요' }, 400, origin);
    }
    if (!canOperateBookOrder(auth)) {
      return json({ ok: false, error: '원장 또는 승인된 관리 담당 인증이 필요합니다' }, 403, origin);
    }
    if (body.action === 'retry-rejected') return await retryRejectedBookOrders(env, app, origin, json);
    const sampleTaskId = SAMPLE_TASK_PREFIX + kstDate();
    return await dispatchOrderMessage(
      env, app, sampleTaskId, SAMPLE_VENDOR_NAME, SAMPLE_ITEMS, [], origin, json, 'sample'
    );
  }

  const taskId = String(body.taskId || '');
  if (!SAFE_ID.test(taskId)) return json({ ok: false, error: '올바른 taskId가 필요합니다' }, 400, origin);

  const loaded = await loadOrderTask(env, app, taskId, auth);
  if (loaded.error) return json({ ok: false, error: loaded.error }, loaded.status, origin);
  const batchSend = await findBatchSendForTask(env, app, taskId);
  if (batchSend) return json(publicResult(batchSend, true), responseStatusFor(batchSend.status), origin);
  return await dispatchOrderMessage(env, app, taskId, loaded.vendorName, loaded.items, [], origin, json);
}

const scheduledJson = (obj, status) => new Response(JSON.stringify(obj), {
  status: status || 200,
  headers: { 'Content-Type': 'application/json;charset=utf-8' }
});

/** 매일 20:00 KST: 새 방식으로 접수된 미발송 주문을 출판사별 한 통으로 묶는다. */
export async function handleScheduledBookOrders(env, scheduledTime) {
  const cutoff = Number(scheduledTime) || Date.now();
  const [taskResult, batchResult, directResult] = await Promise.all([
    env.DB.prepare("SELECT id,data FROM tasks WHERE app='task' ORDER BY updated_at LIMIT 2000").all(),
    env.DB.prepare(
      "SELECT i.task_id FROM book_order_batch_items i JOIN book_order_sends s " +
      "ON s.app=i.app AND s.send_id=i.send_id WHERE i.app='task' AND s.status<>'rejected'"
    ).all(),
    env.DB.prepare(
      "SELECT task_id FROM book_order_sends WHERE app='task' AND status IN ('reserved','dispatching','accepted','unknown')"
    ).all()
  ]);
  const done = new Set([...(batchResult.results || []), ...(directResult.results || [])].map(row => row.task_id));
  const groups = new Map();

  for (const row of taskResult.results || []) {
    if (done.has(row.id)) continue;
    let task;
    try { task = JSON.parse(row.data || '{}'); } catch (error) { continue; }
    if (task.deleted || task.orderDelivery !== 'scheduled_batch_v1' || Number(task.createdAt) > cutoff) continue;
    const vendorName = String(task.orderVendor || '').trim();
    const items = (Array.isArray(task.orderItems) ? task.orderItems : [])
      .map(item => ({ title: String((item && item.title) || '').trim(), qty: String((item && item.qty) || '').trim() }))
      .filter(item => item.title);
    if (!vendorName || !items.length) continue;
    if (!groups.has(vendorName)) groups.set(vendorName, { taskIds: [], items: [] });
    groups.get(vendorName).taskIds.push(row.id);
    groups.get(vendorName).items.push(...items);
  }

  const results = [];
  for (const [vendorName, group] of groups) {
    const batchKey = await sha256Hex([cutoff, vendorName, ...group.taskIds.sort()].join('\u001f'));
    const batchId = 'batch_' + batchKey.slice(0, 48);
    const response = await dispatchOrderMessage(
      env, 'task', batchId, vendorName, group.items, group.taskIds, '*', scheduledJson
    );
    const result = await response.json();
    results.push({ vendorName, taskCount: group.taskIds.length, itemCount: group.items.length,
      status: result && result.send && result.send.status || result.code || 'failed' });
  }
  return { ok: results.every(result => result.status === 'accepted'), cutoff, results };
}
