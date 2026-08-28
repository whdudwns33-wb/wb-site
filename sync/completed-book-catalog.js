import { resolveBookPublisher } from './book-order-vendors.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const AI_MODEL = 'xai/grok-4.20-multi-agent-0309';
const AI_TIMEOUT_MS = 12000;
const MAX_SOURCE_URLS = 8;
const MAX_EVIDENCE_FETCHES = 3;
const EVIDENCE_FETCH_TIMEOUT_MS = 6000;
const EVIDENCE_TOTAL_TIMEOUT_MS = 10000;
const MAX_EVIDENCE_BODY_BYTES = 512 * 1024;
const MAX_EVIDENCE_REDIRECTS = 3;
const FINAL_STATUSES = new Set([
  'verified',
  'fallback_search_disabled',
  'fallback_ai_unavailable',
  'fallback_ai_error',
  'fallback_mismatch',
  'fallback_no_source',
  'fallback_insufficient_evidence',
  'legacy_fallback'
]);
const TRUSTED_EVIDENCE_DOMAINS = Object.freeze([
  'search.shopping.naver.com',
  'smartstore.naver.com',
  'brand.naver.com',
  'product.kyobobook.co.kr',
  'www.yes24.com',
  'www.aladin.co.kr',
  'www.coupang.com'
]);
const PUBLISHER_SEARCH_ALIASES = Object.freeze({
  '미래앤': Object.freeze(['미래엔']),
  '세듀': Object.freeze(['쎄듀']),
  'RPM': Object.freeze(['개념원리'])
});

function cleanText(value, max) {
  const text = String(value == null ? '' : value).normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) return '';
  return text;
}

export function normalizeCatalogPart(value) {
  return String(value == null ? '' : value).normalize('NFKC').replace(/\s+/g, ' ').trim()
    .toLocaleLowerCase('ko-KR');
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); }
  catch (error) { return fallback; }
}

function publicRow(row) {
  const urls = parseJson(row.source_urls || '[]', []);
  return {
    bookId: String(row.catalog_id || ''),
    title: String(row.title || ''),
    publisherName: String(row.publisher_name || ''),
    selectedPublisherName: String(row.selected_publisher_name || ''),
    vendorName: String(row.vendor_name || ''),
    completedAt: Number(row.completed_at || 0),
    verificationStatus: String(row.verification_status || ''),
    sourceUrls: Array.isArray(urls) ? urls.map(safeUrl).filter(Boolean).slice(0, MAX_SOURCE_URLS) : [],
    verifiedAt: row.verified_at == null ? null : Number(row.verified_at),
    revision: Number(row.revision || 0),
    reviewMethod: String(row.review_method || 'none'),
    reviewedAt: row.reviewed_at == null ? null : Number(row.reviewed_at)
  };
}

function aiReady(env) {
  return String(env && env.WB_BOOK_CATALOG_WEB_SEARCH_ENABLED || '') === 'true' &&
    !!(env && env.AI && typeof env.AI.run === 'function');
}

export function completedCatalogRecord(env, item, task, completedAt) {
  if (!item || !task || task.orderDelivery === 'bound_print_v1') return null;
  if (!['scheduled_batch_v1', 'manual_online_v1'].includes(String(task.orderDelivery || ''))) return null;
  const catalogId = String(item.bookId || '');
  const title = cleanText(item.title, 160);
  const hasSelectedPublisher = Object.prototype.hasOwnProperty.call(item, 'publisherName');
  const publisherName = cleanText(hasSelectedPublisher ? item.publisherName : '', 100);
  const vendorName = cleanText(task.orderVendor, 100);
  const normalizedTitle = normalizeCatalogPart(title);
  const normalizedPublisher = normalizeCatalogPart(publisherName);
  if (!SAFE_ID.test(catalogId) || !title || !vendorName || !normalizedTitle) return null;
  const searchEnabled = String(env && env.WB_BOOK_CATALOG_WEB_SEARCH_ENABLED || '') === 'true';
  return {
    catalogId,
    title,
    publisherName,
    selectedPublisherName: publisherName,
    vendorName,
    normalizedTitle,
    normalizedPublisher,
    completedAt: Number(completedAt),
    verificationStatus: !searchEnabled ? 'fallback_search_disabled' : aiReady(env) ? 'pending' : 'fallback_ai_unavailable',
    revision: 0,
    reviewMethod: 'none'
  };
}

/** 같은 academy_register CAS batch 안에서만 행이 생기게 fulfillment의 새 revision을 다시 확인한다. */
export function completedCatalogInsertStatement(env, app, record, condition) {
  return env.DB.prepare(
    'INSERT INTO completed_book_catalog(app,catalog_id,title,normalized_title,publisher_name,normalized_publisher,' +
      'selected_publisher_name,selected_normalized_title,selected_normalized_publisher,' +
      'vendor_name,completed_at,verification_status,source_urls,verified_at,revision,review_method,' +
      'reviewed_at,reviewed_by,created_at,updated_at) ' +
    'SELECT ?,?,?,?,?,?,?,?,?,?,?,?,\'[]\',NULL,?,?,NULL,NULL,?,? WHERE EXISTS (' +
      'SELECT 1 FROM book_order_fulfillments fulfillment WHERE fulfillment.app=? AND fulfillment.task_id=? ' +
      'AND fulfillment.item_index=? AND fulfillment.book_id=? AND fulfillment.student_ids=? ' +
      "AND fulfillment.status='academy_registered' AND fulfillment.revision=?" +
    ') ON CONFLICT DO NOTHING'
  ).bind(
    app, record.catalogId, record.title, record.normalizedTitle, record.publisherName,
    record.normalizedPublisher, record.selectedPublisherName, record.normalizedTitle, record.normalizedPublisher,
    record.vendorName, record.completedAt, record.verificationStatus,
    record.revision, record.reviewMethod,
    record.completedAt, record.completedAt,
    app, condition.taskId, condition.itemIndex, condition.bookId, condition.studentIdsJson, condition.revision
  );
}

function collectText(response) {
  const parts = [];
  if (response && typeof response.output_text === 'string') parts.push(response.output_text);
  if (response && typeof response.response === 'string') parts.push(response.response);
  for (const output of response && Array.isArray(response.output) ? response.output : []) {
    if (typeof output.text === 'string') parts.push(output.text);
    for (const content of Array.isArray(output.content) ? output.content : []) {
      if (typeof content.text === 'string') parts.push(content.text);
    }
  }
  return parts.join('\n').trim();
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    url.hash = '';
    return url.toString().length <= 500 ? url.toString() : '';
  } catch (error) { return ''; }
}

function evidenceHost(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return '';
    return url.hostname.toLocaleLowerCase('en-US').replace(/\.$/, '');
  } catch (error) { return ''; }
}

function allowedProductDetailUrl(value) {
  const safe = safeUrl(value);
  if (!safe) return '';
  const url = new URL(safe);
  const host = evidenceHost(safe);
  if (!host || url.port || !TRUSTED_EVIDENCE_DOMAINS.includes(host)) return '';
  const path = url.pathname;
  const allowed =
    (host === 'product.kyobobook.co.kr' && /^\/detail\/[A-Za-z0-9_-]+\/?$/.test(path)) ||
    (host === 'www.yes24.com' && /^\/Product\/Goods\/\d+\/?$/i.test(path)) ||
    (host === 'www.aladin.co.kr' && /^\/shop\/wproduct\.aspx$/i.test(path) && /^\d+$/.test(url.searchParams.get('ItemId') || '')) ||
    (host === 'www.coupang.com' && /^\/vp\/products\/\d+\/?$/i.test(path)) ||
    (host === 'search.shopping.naver.com' && /^\/book\/catalog\/\d+\/?$/i.test(path)) ||
    ((host === 'smartstore.naver.com' || host === 'brand.naver.com') &&
      /^\/[A-Za-z0-9_.-]+\/products\/\d+\/?$/i.test(path));
  return allowed ? url.toString() : '';
}

function collectSourceUrls(parsed) {
  const urls = new Set();
  const add = value => {
    const url = safeUrl(value);
    if (url && urls.size < MAX_SOURCE_URLS) urls.add(url);
  };
  const walk = (value, depth) => {
    if (depth > 7 || value == null || urls.size >= MAX_SOURCE_URLS) return;
    if (typeof value === 'string') {
      for (const match of value.match(/https?:\/\/[^\s<>"'\]\)]+/g) || []) add(match.replace(/[.,;:!?]+$/, ''));
      return;
    }
    if (Array.isArray(value)) return value.forEach(item => walk(item, depth + 1));
    if (typeof value === 'object') Object.entries(value).forEach(([key, item]) => {
      if (/^(?:url|link)$/i.test(key)) add(item);
      else walk(item, depth + 1);
    });
  };
  walk(parsed && parsed.sourceUrls, 0);
  return [...urls];
}

function decodedHtmlText(value) {
  return String(value || '')
    .replace(/<!--[^]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => {
      const number = Number(code);
      return Number.isInteger(number) && number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : ' ';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      const number = Number.parseInt(code, 16);
      return Number.isInteger(number) && number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : ' ';
    })
    .replace(/&(nbsp|amp|quot|apos|lt|gt);/gi, (_, name) => ({
      nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>'
    })[String(name).toLocaleLowerCase('en-US')] || ' ');
}

function publisherEvidenceTerms(verifiedPublisher, selectedPublisher) {
  const terms = new Set();
  const add = value => {
    const compact = compactComparable(value);
    if (compact.length >= 2) terms.add(compact);
  };
  add(verifiedPublisher);
  add(selectedPublisher);
  const resolved = resolveBookPublisher(selectedPublisher);
  if (resolved && resolved.listed) {
    add(resolved.publisherName);
    for (const alias of PUBLISHER_SEARCH_ALIASES[resolved.publisherName] || []) add(alias);
  }
  return [...terms];
}

async function withAbortTimeout(promise, controller, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          try { controller.abort(); } catch (error) { /* no-op */ }
          reject(new Error('BOOK_CATALOG_EVIDENCE_TIMEOUT'));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function boundedResponseText(response, controller, deadlineAt) {
  const contentLength = Number(response.headers && response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_EVIDENCE_BODY_BYTES) {
    try { await response.body?.cancel(); } catch (error) { /* no-op */ }
    return null;
  }
  if (!response.body || typeof response.body.getReader !== 'function') return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    while (true) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        try { controller.abort(); } catch (error) { /* no-op */ }
        try { await reader.cancel(); } catch (error) { /* no-op */ }
        return null;
      }
      const part = await withAbortTimeout(reader.read(), controller, remaining);
      if (part.done) break;
      const chunk = part.value instanceof Uint8Array ? part.value : new Uint8Array(part.value || []);
      size += chunk.byteLength;
      if (size > MAX_EVIDENCE_BODY_BYTES) {
        try { await reader.cancel(); } catch (error) { /* no-op */ }
        return null;
      }
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    try { reader.releaseLock(); } catch (error) { /* no-op */ }
  }
}

async function fetchEvidencePage(env, sourceUrl, deadlineAt) {
  const fetcher = env && typeof env.BOOK_CATALOG_FETCH === 'function'
    ? env.BOOK_CATALOG_FETCH.bind(env) : globalThis.fetch;
  if (typeof fetcher !== 'function') return null;
  let currentUrl = allowedProductDetailUrl(sourceUrl);
  if (!currentUrl) return null;
  for (let redirectCount = 0; redirectCount <= MAX_EVIDENCE_REDIRECTS; redirectCount++) {
    const remaining = Math.min(EVIDENCE_FETCH_TIMEOUT_MS, deadlineAt - Date.now());
    if (remaining <= 0) return null;
    const controller = new AbortController();
    let response;
    try {
      response = await withAbortTimeout(fetcher(currentUrl, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: { accept: 'text/html,application/xhtml+xml;q=0.9' }
      }), controller, remaining);
    } catch (error) { return null; }
    if (!response || typeof response.status !== 'number') return null;
    if (response.status >= 300 && response.status < 400) {
      if (redirectCount >= MAX_EVIDENCE_REDIRECTS) return null;
      const location = response.headers && response.headers.get('location');
      let nextUrl;
      try { nextUrl = new URL(String(location || ''), currentUrl).toString(); }
      catch (error) { return null; }
      currentUrl = allowedProductDetailUrl(nextUrl);
      if (!currentUrl) return null;
      try { await response.body?.cancel(); } catch (error) { /* no-op */ }
      continue;
    }
    if (response.status !== 200) {
      try { await response.body?.cancel(); } catch (error) { /* no-op */ }
      return null;
    }
    const finalUrl = allowedProductDetailUrl(String(response.url || '') || currentUrl);
    if (!finalUrl) {
      try { await response.body?.cancel(); } catch (error) { /* no-op */ }
      return null;
    }
    const contentType = String(response.headers && response.headers.get('content-type') || '')
      .split(';', 1)[0].trim().toLocaleLowerCase('en-US');
    if (contentType !== 'text/html' && contentType !== 'application/xhtml+xml') {
      try { await response.body?.cancel(); } catch (error) { /* no-op */ }
      return null;
    }
    const body = await boundedResponseText(response, controller, deadlineAt);
    return body == null ? null : { finalUrl, body };
  }
  return null;
}

async function verifiedEvidenceUrls(env, sourceUrls, title, verifiedPublisher, selectedPublisher) {
  const candidates = [...new Set((sourceUrls || []).map(allowedProductDetailUrl).filter(Boolean))]
    .slice(0, MAX_EVIDENCE_FETCHES);
  if (!candidates.length) return [];
  const titleTerm = compactComparable(title);
  const publisherTerms = publisherEvidenceTerms(verifiedPublisher, selectedPublisher);
  if (!titleTerm || !publisherTerms.length) return [];
  const deadlineAt = Date.now() + EVIDENCE_TOTAL_TIMEOUT_MS;
  for (const sourceUrl of candidates) {
    const page = await fetchEvidencePage(env, sourceUrl, deadlineAt);
    if (!page) continue;
    const body = compactComparable(decodedHtmlText(page.body));
    if (!body.includes(titleTerm)) continue;
    // 출판사명이 교재명 자체에 들어 있는 경우를 독립 근거로 잘못 세지 않는다.
    const outsideTitle = body.split(titleTerm).join('');
    if (publisherTerms.some(term => outsideTitle.includes(term))) {
      return [page.finalUrl];
    }
  }
  return [];
}

function parseAiResult(outputText) {
  const source = String(outputText || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const parsed = parseJson(source.slice(start, end + 1), null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const title = cleanText(parsed.title, 160);
  const publisherName = cleanText(parsed.publisherName, 100);
  return title ? { title, publisherName, sourceUrls: parsed.sourceUrls } : null;
}

function compactComparable(value) {
  return normalizeCatalogPart(value).replace(/[^\p{L}\p{N}]+/gu, '');
}

function compatibleCompact(left, right, minimum) {
  const a = compactComparable(left);
  const b = compactComparable(right);
  if (!a || !b || Math.min(a.length, b.length) < minimum) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function compatibleTitle(left, right) {
  const a = compactComparable(left);
  const b = compactComparable(right);
  return !!a && a === b;
}

function compatiblePublisher(verified, selected) {
  if (compatibleCompact(verified, selected, 2)) return true;
  const resolved = resolveBookPublisher(selected);
  if (!resolved || !resolved.listed) return false;
  return (PUBLISHER_SEARCH_ALIASES[resolved.publisherName] || [])
    .some(alias => compatibleCompact(verified, alias, 2));
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('BOOK_CATALOG_AI_TIMEOUT')), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function finishVerification(env, row, status, sourceUrls, now, verifiedBook) {
  if (!FINAL_STATUSES.has(status)) status = 'fallback_ai_error';
  if (status === 'verified' && verifiedBook) {
    const normalizedTitle = normalizeCatalogPart(verifiedBook.title);
    const normalizedPublisher = normalizeCatalogPart(verifiedBook.publisherName);
    let updated;
    try {
      updated = await env.DB.prepare(
        'UPDATE completed_book_catalog SET title=?,normalized_title=?,publisher_name=?,normalized_publisher=?,' +
          "verification_status=?,source_urls=?,verified_at=?,revision=revision+1,review_method='web_search'," +
          'reviewed_at=NULL,reviewed_by=NULL,updated_at=? ' +
        "WHERE app='task' AND catalog_id=? AND verification_status='pending' AND NOT EXISTS (" +
          'SELECT 1 FROM completed_book_catalog duplicate WHERE duplicate.app=completed_book_catalog.app ' +
          'AND duplicate.normalized_publisher=? AND duplicate.normalized_title=? ' +
          'AND duplicate.catalog_id<>completed_book_catalog.catalog_id)'
      ).bind(verifiedBook.title, normalizedTitle, verifiedBook.publisherName, normalizedPublisher,
        status, JSON.stringify(sourceUrls || []), now, now, String(row.catalog_id),
        normalizedPublisher, normalizedTitle).run();
    } catch (error) {
      // 서로 다른 선택명이 동시에 같은 검색 정본으로 수렴해도 기존 행을 덮거나 pending으로 남기지 않는다.
      if (!/unique|constraint/i.test(String(error && error.message || error))) throw error;
    }
    if (updated && updated.meta && Number(updated.meta.changes || 0) === 1) return;
    status = 'fallback_mismatch';
  }
  await env.DB.prepare(
    "UPDATE completed_book_catalog SET verification_status=?,source_urls=?,verified_at=?,revision=revision+1," +
      "review_method='web_search',reviewed_at=NULL,reviewed_by=NULL,updated_at=? " +
    "WHERE app='task' AND catalog_id=? AND verification_status='pending'"
  ).bind(status, JSON.stringify(sourceUrls || []), now, now, String(row.catalog_id)).run();
}

/** 응답 경로와 분리된 best-effort 검증. 실패해도 이미 완료된 주문·기본 카탈로그 행은 유지한다. */
export async function verifyCompletedCatalogEntry(env, catalogId) {
  if (!aiReady(env) || !SAFE_ID.test(String(catalogId || ''))) return;
  const row = await env.DB.prepare(
    "SELECT * FROM completed_book_catalog WHERE app='task' AND catalog_id=? AND verification_status='pending' LIMIT 1"
  ).bind(String(catalogId)).first();
  if (!row) return;

  let response;
  try {
    response = await withTimeout(env.AI.run(AI_MODEL, {
      input: JSON.stringify({
        title: String(row.title),
        publisherName: String(row.selected_publisher_name || row.publisher_name || '')
      }),
      instructions: '한국에서 판매되는 교재인지 웹 검색으로 확인하세요. 반드시 JSON 하나만 반환하세요: ' +
        '{"title":"확인된 교재명","publisherName":"확인된 출판사","sourceUrls":["근거 URL"]}. ' +
        '근거가 부족하면 빈 sourceUrls를 반환하고 추측하지 마세요.',
      max_turns: 2,
      max_output_tokens: 512,
      tools: [{ type: 'web_search' }]
    }, { gateway: { id: 'default' } }), AI_TIMEOUT_MS);
  } catch (error) {
    await finishVerification(env, row, 'fallback_ai_error', [], Date.now());
    return;
  }

  const outputText = collectText(response);
  const parsed = parseAiResult(outputText);
  const sourceUrls = collectSourceUrls(parsed);
  if (!parsed) {
    await finishVerification(env, row, 'fallback_ai_error', sourceUrls, Date.now());
    return;
  }
  const titleMatches = compatibleTitle(parsed.title, row.title);
  const selectedPublisher = String(row.selected_publisher_name || row.publisher_name || '');
  const publisherMatches = selectedPublisher
    ? compatiblePublisher(parsed.publisherName, selectedPublisher)
    : !!normalizeCatalogPart(parsed.publisherName);
  let evidenceUrls = [];
  if (titleMatches && publisherMatches && sourceUrls.length) {
    evidenceUrls = await verifiedEvidenceUrls(env, sourceUrls, parsed.title, parsed.publisherName, selectedPublisher);
  }
  const status = !titleMatches || !publisherMatches ? 'fallback_mismatch'
    : !sourceUrls.length ? 'fallback_no_source'
      : !evidenceUrls.length ? 'fallback_insufficient_evidence' : 'verified';
  await finishVerification(env, row, status, status === 'verified' ? evidenceUrls : sourceUrls,
    Date.now(), status === 'verified' ? parsed : null);
}

function reviewActor(auth) {
  const id = String(auth && auth.id || '');
  return SAFE_ID.test(id) ? id : 'director';
}

function exactAdminReviewRetry(row, expectedRevision, title, publisherName, actor) {
  return !!row && String(row.verification_status) === 'verified' && String(row.review_method) === 'admin' &&
    Number(row.revision) === expectedRevision + 1 && String(row.title) === title &&
    String(row.publisher_name) === publisherName && String(row.reviewed_by || '') === actor;
}

function reviewableStatus(value) {
  const status = String(value || '');
  return FINAL_STATUSES.has(status) && status !== 'verified';
}

async function approveCatalogReview(env, app, body, origin, auth, json) {
  if (!auth || auth.scope !== 'all') {
    return json({ ok: false, error: '외부교재DB 후보 확정은 관리자만 처리할 수 있습니다' }, 403, origin);
  }
  const allowed = new Set(['app', 'auth', 'action', 'bookId', 'expectedRevision', 'title', 'publisherName']);
  const bookId = String(body && body.bookId || '');
  const expectedRevision = body && body.expectedRevision;
  const title = cleanText(body && body.title, 160);
  const publisherName = cleanText(body && body.publisherName, 100);
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !allowed.has(key)) || !SAFE_ID.test(bookId) ||
      !Number.isInteger(expectedRevision) || expectedRevision < 0 || !title || !publisherName) {
    return json({ ok: false, error: 'bookId, expectedRevision, 교재명과 출판사를 확인해 주세요' }, 400, origin);
  }
  if (!env.DB || typeof env.DB.batch !== 'function') {
    return json({ ok: false, code: 'BOOK_CATALOG_REVIEW_LEDGER_NOT_READY',
      error: '외부교재DB 검토 원장을 준비하고 있습니다' }, 503, origin);
  }

  let row;
  try {
    row = await env.DB.prepare(
      "SELECT * FROM completed_book_catalog WHERE app='task' AND catalog_id=? LIMIT 1"
    ).bind(bookId).first();
  } catch (error) {
    if (/no such table.*completed_book_catalog/i.test(String(error && error.message || error))) {
      return json({ ok: false, code: 'BOOK_CATALOG_NOT_READY', error: '완료 외부교재DB를 준비하고 있습니다' }, 503, origin);
    }
    throw error;
  }
  if (!row) return json({ ok: false, error: '외부교재DB 확인 후보를 찾을 수 없습니다' }, 404, origin);
  const actor = reviewActor(auth);
  if (exactAdminReviewRetry(row, expectedRevision, title, publisherName, actor)) {
    return json({ ok: true, idempotent: true, book: publicRow(row) }, 200, origin);
  }
  if (String(row.verification_status) === 'pending') {
    return json({ ok: false, code: 'BOOK_CATALOG_PENDING', error: '웹 검색 확인이 끝난 뒤 처리해 주세요' }, 409, origin);
  }
  if (!reviewableStatus(row.verification_status) || Number(row.revision) !== expectedRevision) {
    return json({ ok: false, code: 'REVISION_CONFLICT', error: '외부교재DB 후보가 다른 기기에서 먼저 변경되었습니다' }, 409, origin);
  }

  const now = Date.now();
  const nextRevision = expectedRevision + 1;
  const eventId = crypto.randomUUID();
  const normalizedTitle = normalizeCatalogPart(title);
  const normalizedPublisher = normalizeCatalogPart(publisherName);
  const fromStatus = String(row.verification_status);
  const eventStatement = env.DB.prepare(
    'INSERT INTO completed_book_catalog_review_events(app,event_id,catalog_id,from_status,from_revision,to_revision,' +
      'title,publisher_name,reviewed_by,reviewed_at) ' +
    'SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS (' +
      'SELECT 1 FROM completed_book_catalog WHERE app=? AND catalog_id=? AND verification_status=? AND revision=?' +
    ') ON CONFLICT DO NOTHING'
  ).bind(app, eventId, bookId, fromStatus, expectedRevision, nextRevision, title, publisherName, actor, now,
    app, bookId, fromStatus, expectedRevision);
  const updateStatement = env.DB.prepare(
    "UPDATE completed_book_catalog SET title=?,normalized_title=?,publisher_name=?,normalized_publisher=?," +
      "verification_status='verified',verified_at=?,revision=revision+1,review_method='admin'," +
      'reviewed_at=?,reviewed_by=?,updated_at=? ' +
    'WHERE app=? AND catalog_id=? AND verification_status=? AND revision=? AND EXISTS (' +
      'SELECT 1 FROM completed_book_catalog_review_events event WHERE event.app=? AND event.event_id=? ' +
      'AND event.catalog_id=? AND event.from_status=? AND event.from_revision=? AND event.to_revision=? ' +
      'AND event.title=? AND event.publisher_name=? AND event.reviewed_by=? AND event.reviewed_at=?' +
    ')'
  ).bind(title, normalizedTitle, publisherName, normalizedPublisher, now, now, actor, now,
    app, bookId, fromStatus, expectedRevision,
    app, eventId, bookId, fromStatus, expectedRevision, nextRevision, title, publisherName, actor, now);

  try {
    const results = await env.DB.batch([eventStatement, updateStatement]);
    if (Number(results && results[0] && results[0].meta && results[0].meta.changes || 0) !== 1 ||
        Number(results && results[1] && results[1].meta && results[1].meta.changes || 0) !== 1) {
      const raced = await env.DB.prepare(
        "SELECT * FROM completed_book_catalog WHERE app='task' AND catalog_id=? LIMIT 1"
      ).bind(bookId).first();
      if (exactAdminReviewRetry(raced, expectedRevision, title, publisherName, actor)) {
        return json({ ok: true, idempotent: true, book: publicRow(raced) }, 200, origin);
      }
      return json({ ok: false, code: 'REVISION_CONFLICT', error: '외부교재DB 후보가 다른 기기에서 먼저 변경되었습니다' }, 409, origin);
    }
  } catch (error) {
    const message = String(error && error.message || error);
    if (/no such table.*completed_book_catalog(?:_review_events)?/i.test(message)) {
      return json({ ok: false, code: 'BOOK_CATALOG_REVIEW_LEDGER_NOT_READY',
        error: '외부교재DB 검토 원장을 준비하고 있습니다' }, 503, origin);
    }
    const raced = await env.DB.prepare(
      "SELECT * FROM completed_book_catalog WHERE app='task' AND catalog_id=? LIMIT 1"
    ).bind(bookId).first();
    if (exactAdminReviewRetry(raced, expectedRevision, title, publisherName, actor)) {
      return json({ ok: true, idempotent: true, book: publicRow(raced) }, 200, origin);
    }
    if (/unique constraint.*completed_book_catalog\.(?:normalized_publisher|normalized_title)/i.test(message)) {
      return json({ ok: false, code: 'BOOK_CATALOG_DUPLICATE', error: '같은 교재명과 출판사가 이미 외부교재DB에 있습니다' }, 409, origin);
    }
    if (/COMPLETED_BOOK_CATALOG_(?:REVIEW_STALE|IMMUTABLE)/i.test(message)) {
      return json({ ok: false, code: 'REVISION_CONFLICT', error: '외부교재DB 후보가 다른 기기에서 먼저 변경되었습니다' }, 409, origin);
    }
    throw error;
  }
  const stored = await env.DB.prepare(
    "SELECT * FROM completed_book_catalog WHERE app='task' AND catalog_id=? LIMIT 1"
  ).bind(bookId).first();
  return json({ ok: true, idempotent: false, book: publicRow(stored) }, 200, origin);
}

export async function handleBookCatalog(env, app, body, origin, auth, json) {
  if (app !== 'task') return json({ ok: false, error: '이 기능은 직원 앱에서만 사용할 수 있습니다' }, 400, origin);
  const action = String(body && body.action || '');
  if (action === 'review_approve') return approveCatalogReview(env, app, body, origin, auth, json);
  if (action !== 'list') return json({ ok: false, error: '지원하는 외부교재DB action을 확인해 주세요' }, 400, origin);
  const limit = Math.floor(Math.max(1, Math.min(500, Number(body.limit) || 500)));
  try {
    const result = await env.DB.prepare(
      'SELECT catalog_id,title,publisher_name,selected_publisher_name,vendor_name,completed_at,' +
      'verification_status,source_urls,verified_at,revision,review_method,reviewed_at ' +
      'FROM completed_book_catalog WHERE app=? ORDER BY completed_at DESC,title,publisher_name LIMIT ' + limit
    ).bind(app).all();
    const rows = (result.results || []).map(publicRow);
    const trusted = row => row.verificationStatus === 'verified' &&
      (row.reviewMethod === 'admin' ||
        (row.reviewMethod === 'web_search' && row.sourceUrls.some(allowedProductDetailUrl)));
    return json({
      ok: true,
      books: rows.filter(trusted),
      reviewCandidates: rows.filter(row => !trusted(row))
    }, 200, origin);
  } catch (error) {
    if (/no such table.*completed_book_catalog/i.test(String(error && error.message || error))) {
      return json({ ok: false, code: 'BOOK_CATALOG_NOT_READY', error: '완료 외부교재DB를 준비하고 있습니다' }, 503, origin);
    }
    throw error;
  }
}
