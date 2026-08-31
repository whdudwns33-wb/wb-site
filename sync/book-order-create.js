import { validateRosterDocument } from './roster.js';
import { acquireBookOrderDispatchLock, releaseBookOrderDispatchLockSafely } from './book-order-lock.js';
import { MANUAL_ONLINE_DELIVERY, ONLINE_BOOK_VENDOR, resolveBookPublisher } from './book-order-vendors.js';
import {
  activeRosterStudent,
  bookOrderStudentIdsForAuth,
  ownBookStudentWriteGuard
} from './book-order-student-scope.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_ORDER_TASK_ID = /^ord_[A-Za-z0-9_-]{8,120}$/;
const MAX_ITEMS = 50;
const MAX_STUDENTS = 200;
const MAX_UNIT_PRICE = 10000000;
export const MAX_BOOK_ORDER_MESSAGE_BYTES = 2000;
const ALLOWED_KEYS = new Set(['app', 'auth', 'action', 'taskId', 'vendorName', 'items', 'expectedUpdatedAt', 'itemIndex']);
const ALLOWED_ITEM_KEYS = new Set(['bookId', 'title', 'studentIds', 'unitPrice', 'publisherName']);
const BOUND_ALLOWED_KEYS = new Set(['app', 'auth', 'action', 'taskId', 'productCode', 'title', 'studentIds']);
const BOUND_DELIVERY = 'bound_print_v1';
const BOUND_VENDOR = '제본교재';
const INTERNAL_ALLOWED_KEYS = new Set(['app', 'auth', 'action', 'taskId', 'productCode', 'volume', 'studentIds']);
export const INTERNAL_BOOK_DELIVERY = 'internal_book_v1';
const INTERNAL_BOOK_VENDOR = '내부교재';
const BOUND_PRODUCTS = Object.freeze({
  pages_1_30: Object.freeze({ label: '1~30 장 - 4,000원', unitPrice: 4000 }),
  pages_31_60: Object.freeze({ label: '31~60 장 - 7,000원', unitPrice: 7000 }),
  pages_61_90: Object.freeze({ label: '61~90 장 - 9,000원', unitPrice: 9000 }),
  exam_upto_30: Object.freeze({ label: '시험대비 (30장 이하) - 9,000원', unitPrice: 9000 }),
  exam_over_30: Object.freeze({ label: '시험대비 (31장 이상) - 15,000원', unitPrice: 15000 })
});
const INTERNAL_BOOK_PRODUCTS = Object.freeze({
  vocab_stage_1: Object.freeze({ title: '어휘가 독해다 1단계', label: '1단계 - 12,500원', unitPrice: 12500 }),
  vocab_stage_2: Object.freeze({ title: '어휘가 독해다 2단계', label: '2단계 - 12,500원', unitPrice: 12500 }),
  vocab_stage_3: Object.freeze({ title: '어휘가 독해다 3단계', label: '3단계 - 12,500원', unitPrice: 12500 }),
  vocab_stage_4: Object.freeze({ title: '어휘가 독해다 4단계', label: '4단계 - 12,500원', unitPrice: 12500 }),
  vocab_stage_5: Object.freeze({ title: '어휘가 독해다 5단계', label: '5단계 - 12,500원', unitPrice: 12500 }),
  vocab_stage_6: Object.freeze({ title: '어휘가 독해다 6단계', label: '6단계 - 12,500원', unitPrice: 12500 }),
  vocab_basic: Object.freeze({ title: '어휘가 독해다 기본', label: '기본 - 12,000원', unitPrice: 12000 }),
  vocab_skill: Object.freeze({ title: '어휘가 독해다 실력', label: '실력 - 13,000원', unitPrice: 13000 }),
  vocab_middle: Object.freeze({ title: '어휘가 독해다 중등', label: '중등 - 14,500원', unitPrice: 14500 }),
  vocab_high: Object.freeze({ title: '어휘가 독해다 고등', label: '고등 - 16,000원', unitPrice: 16000 }),
  vocab_hanja_1: Object.freeze({ title: '어휘가 독해다 한자1단계', label: '한자1단계 - 12,000원', unitPrice: 12000 }),
  vocab_hanja_2: Object.freeze({ title: '어휘가 독해다 한자2단계', label: '한자2단계 - 12,000원', unitPrice: 12000 }),
  vocab_hanja_3: Object.freeze({ title: '어휘가 독해다 한자3단계', label: '한자3단계 - 12,000원', unitPrice: 12000 }),
  vocab_hanja_4: Object.freeze({ title: '어휘가 독해다 한자4단계', label: '한자4단계 - 12,000원', unitPrice: 12000 }),
  reading_bisang: Object.freeze({ title: '독해창 비상', label: '비상', unitPrice: 23000, volumeMin: 1, volumeMax: 8 }),
  reading_advanced: Object.freeze({ title: '독해창 심화', label: '심화', unitPrice: 19000, volumeMin: 1, volumeMax: 12 }),
  reading_application: Object.freeze({ title: '독해창 응용', label: '응용', unitPrice: 19000, volumeMin: 1, volumeMax: 12 }),
  reading_intro: Object.freeze({ title: '독해창 입문', label: '입문', unitPrice: 19000, volumeMin: 1, volumeMax: 8 }),
  reading_top: Object.freeze({ title: '독해창 최상', label: '최상', unitPrice: 23000, volumeMin: 1, volumeMax: 8 }),
  reading_essential: Object.freeze({ title: '독해창 필수', label: '필수', unitPrice: 19000, volumeMin: 1, volumeMax: 12 }),
  logic_preparatory: Object.freeze({ title: '논리와 상상 예비', label: '예비', unitPrice: 18000, volumeMin: 1, volumeMax: 6 }),
  logic_basic: Object.freeze({ title: '논리와 상상 기본', label: '기본', unitPrice: 24000, volumeMin: 1, volumeMax: 12,
    volumePrices: Object.freeze({ 3: 26000 }) }),
  logic_leap: Object.freeze({ title: '논리와 상상 도약', label: '도약', unitPrice: 24000, volumeMin: 1, volumeMax: 12,
    volumePrices: Object.freeze({ 1: 28000, 2: 28000, 3: 28000, 6: 28000, 8: 28000 }) }),
  logic_growth: Object.freeze({ title: '논리와 상상 성장', label: '성장', unitPrice: 24000, volumeMin: 1, volumeMax: 12,
    volumePrices: Object.freeze({ 4: 26000 }) }),
  studyforce_bound: Object.freeze({ title: '스터디포스 제본', label: '제본 - 6,000원', unitPrice: 6000 }),
  studyforce_passage_notes: Object.freeze({ title: '스터디포스 지문정리노트', label: '지문정리노트 - 10,000원', unitPrice: 10000 })
});

function text(value, max, empty) {
  const cleaned = String(value == null ? '' : value).normalize('NFKC').trim();
  if ((!empty && !cleaned) || cleaned.length > max || /[\u0000-\u001f\u007f]/.test(cleaned)) return null;
  return cleaned;
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); }
  catch (error) { return fallback; }
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function boundBookId(productCode, title) {
  const hash = await sha256Hex(JSON.stringify([String(productCode), String(title)]));
  return 'BOUND_' + hash.slice(0, 48);
}

function internalBookProduct(productCode, rawVolume) {
  const base = INTERNAL_BOOK_PRODUCTS[String(productCode || '')];
  if (!base) return null;
  const volumeProduct = Number.isInteger(base.volumeMin) && Number.isInteger(base.volumeMax);
  if (volumeProduct) {
    if (!Number.isInteger(rawVolume) || rawVolume < base.volumeMin || rawVolume > base.volumeMax) return null;
    const unitPrice = base.volumePrices && Object.prototype.hasOwnProperty.call(base.volumePrices, rawVolume)
      ? base.volumePrices[rawVolume] : base.unitPrice;
    return { ...base, unitPrice, volume: rawVolume,
      title: base.title + ' ' + rawVolume + '권', label: base.label + ' ' + rawVolume + '권' };
  }
  if (rawVolume !== undefined) return null;
  return { ...base, volume: null };
}

async function internalBookId(productCode, volume) {
  const hash = await sha256Hex(JSON.stringify([INTERNAL_BOOK_DELIVERY, String(productCode), volume]));
  return 'INTERNAL_' + hash.slice(0, 45);
}

function kstDate(now) {
  return new Date(Number(now) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function buildBookOrderMessage(vendorName, items) {
  const lines = items.map(item => '· ' + item.title + ': ' + item.qty);
  return '안녕하세요, WB 웩슬러브레인센터(독해력학원)입니다.\n교재 주문 부탁드립니다.\n\n' +
    lines.join('\n') + '\n\n입고 예정일 회신 부탁드립니다. 감사합니다.';
}

function activeStudent(student, month) {
  return activeRosterStudent(student, month);
}

async function studentIdentityHash(student) {
  return sha256Hex(String(student.id) + '\n' + String(student.name || '').normalize('NFKC').trim());
}

function normalizedStudentIds(item) {
  if (!item || !Array.isArray(item.studentIds) || !item.studentIds.length || item.studentIds.length > MAX_STUDENTS) return null;
  const raw = item.studentIds.map(value => String(value || ''));
  const sorted = [...raw].sort();
  return raw.every(id => SAFE_ID.test(id)) &&
    new Set(raw).size === raw.length ? sorted : null;
}

async function itemIdentity(item) {
  const bookId = String(item && item.bookId || '');
  const title = text(item && item.title, 160, false);
  const studentIds = normalizedStudentIds(item);
  const hasUnitPrice = !!item && Object.prototype.hasOwnProperty.call(item, 'unitPrice');
  const unitPrice = hasUnitPrice ? Number(item.unitPrice) : null;
  const hasPublisherName = !!item && Object.prototype.hasOwnProperty.call(item, 'publisherName');
  const publisher = hasPublisherName ? resolveBookPublisher(item.publisherName) : null;
  if (!SAFE_ID.test(bookId) || !title || !studentIds ||
      (hasUnitPrice && (!Number.isInteger(unitPrice) || unitPrice < 1 || unitPrice > MAX_UNIT_PRICE)) ||
      (hasPublisherName && typeof item.publisherName !== 'string') ||
      (hasPublisherName && !publisher)) return null;
  const qty = studentIds.length + '권';
  const studentSetHash = await sha256Hex(JSON.stringify(studentIds));
  const identityFields = [bookId, title, qty, studentSetHash];
  if (hasUnitPrice) identityFields.push(unitPrice);
  if (hasPublisherName) identityFields.push('publisher:' + publisher.publisherName);
  const itemIdentityHash = await sha256Hex(JSON.stringify(identityFields));
  return {
    bookId, title, studentIds, qty, studentSetHash, itemIdentityHash,
    ...(hasPublisherName ? { publisherName: publisher.publisherName, publisherVendorName: publisher.vendorName,
      hasPublisherName: true } : {}),
    ...(hasUnitPrice ? { unitPrice } : {})
  };
}

async function taskIdentityHash(taskId, ownerId, vendorName, items) {
  return sha256Hex(JSON.stringify([taskId, ownerId, vendorName, items.map(item => item.itemIdentityHash)]));
}

async function currentRosterRecord(env, app) {
  const row = await env.DB.prepare('SELECT data,updated_at FROM private_rosters WHERE app=? LIMIT 1').bind(app).first();
  if (!row) return null;
  try {
    return {
      document: validateRosterDocument(JSON.parse(row.data)),
      rawData: String(row.data),
      updatedAt: Number(row.updated_at)
    };
  }
  catch (error) { return false; }
}

async function ownOrderStudentScopeStillValid(env, app, auth, studentIds) {
  if (!auth || auth.scope !== 'own') return true;
  const current = await currentRosterRecord(env, app);
  if (!current || current === false) return false;
  const allowed = await bookOrderStudentIdsForAuth(env, app, current.document, auth);
  return studentIds.every(studentId => allowed.has(String(studentId)));
}

async function currentRoster(env, app) {
  const record = await currentRosterRecord(env, app);
  return record && record !== false ? record.document : record;
}

export async function loadOrderIdentityRoster(env, app) {
  return currentRoster(env, app);
}

export async function loadOrderSnapshotRows(env, app, taskId) {
  const sql = 'SELECT * FROM book_order_student_snapshots WHERE app=?' +
    (taskId ? ' AND task_id=?' : '') + ' ORDER BY task_id,item_index,student_id';
  const statement = env.DB.prepare(sql).bind(app, ...(taskId ? [taskId] : []));
  const result = await statement.all();
  return result.results || [];
}

export async function loadOrderItemCancellationRows(env, app, taskId) {
  const sql = 'SELECT task_id,item_index,book_id,cancelled_at,cancelled_by FROM book_order_item_cancellations WHERE app=?' +
    (taskId ? ' AND task_id=?' : '') + ' ORDER BY task_id,item_index';
  const statement = env.DB.prepare(sql).bind(app, ...(taskId ? [taskId] : []));
  const result = await statement.all();
  return result.results || [];
}

export function cancelledOrderItemIndexes(rows, taskId) {
  return new Set((rows || []).filter(row => String(row.task_id) === String(taskId))
    .map(row => Number(row.item_index)).filter(index => Number.isInteger(index) && index >= 0));
}

/** Only a task outside the sealed namespace and without a seal marker may be a zero-row legacy order. */
export async function verifyOrderTaskSnapshotRows(
  taskId, owner, task, rows, document, now = Date.now(), requireCurrentEnrollment = true,
  cancelledItemIndexes = new Set()
) {
  const selected = (rows || []).filter(row => String(row.task_id) === String(taskId));
  if (!selected.length) {
    return Number(task && task.orderIdentityVersion) === 1 || String(taskId || '').startsWith('ord_')
      ? { sealed: true, valid: false, code: 'ORDER_IDENTITY_MISMATCH' }
      : { sealed: false, valid: true };
  }
  if (document === false) return { sealed: true, valid: false, code: 'ORDER_STUDENT_IDENTITY_CHANGED' };
  const ownerId = String(owner || '');
  const delivery = String(task && task.orderDelivery || '');
  if (!task || task.deleted || ![
    'scheduled_batch_v1', MANUAL_ONLINE_DELIVERY, BOUND_DELIVERY, INTERNAL_BOOK_DELIVERY
  ].includes(delivery) ||
      Number(task.orderIdentityVersion) !== 1 || !Array.isArray(task.orderItems) || !task.orderItems.length) {
    return { sealed: true, valid: false, code: 'ORDER_IDENTITY_MISMATCH' };
  }
  const vendorName = text(task.orderVendor, 100, true);
  if (vendorName == null) return { sealed: true, valid: false, code: 'ORDER_IDENTITY_MISMATCH' };
  const identities = [];
  for (const item of task.orderItems) {
    const identity = await itemIdentity(item);
    if (!identity || String(item.qty || '') !== identity.qty) {
      return { sealed: true, valid: false, code: 'ORDER_IDENTITY_MISMATCH' };
    }
    identities.push(identity);
  }
  if (identities.some(identity => identity.hasPublisherName && identity.publisherVendorName !== vendorName)) {
    return { sealed: true, valid: false, code: 'ORDER_IDENTITY_MISMATCH' };
  }
  if (delivery === MANUAL_ONLINE_DELIVERY && (vendorName !== ONLINE_BOOK_VENDOR ||
      identities.some(identity => !identity.hasPublisherName || identity.publisherVendorName !== ONLINE_BOOK_VENDOR))) {
    return { sealed: true, valid: false, code: 'ORDER_IDENTITY_MISMATCH' };
  }
  if (delivery === BOUND_DELIVERY) {
    const product = BOUND_PRODUCTS[String(task.boundProductCode || '')];
    const identity = identities[0];
    if (!product || identities.length !== 1 || vendorName !== BOUND_VENDOR ||
        String(task.boundProductLabel || '') !== product.label || identity.unitPrice !== product.unitPrice ||
        identity.bookId !== await boundBookId(String(task.boundProductCode), identity.title)) {
      return { sealed: true, valid: false, code: 'ORDER_IDENTITY_MISMATCH' };
    }
  }
  if (delivery === INTERNAL_BOOK_DELIVERY) {
    const productCode = String(task.internalProductCode || '');
    const rawVolume = Object.prototype.hasOwnProperty.call(task, 'internalProductVolume')
      ? task.internalProductVolume : undefined;
    const product = internalBookProduct(productCode, rawVolume);
    const identity = identities[0];
    if (!product || identities.length !== 1 || vendorName !== INTERNAL_BOOK_VENDOR ||
        String(task.internalProductLabel || '') !== product.label || identity.title !== product.title ||
        !Number.isInteger(identity.unitPrice) || identity.unitPrice < 1 ||
        identity.bookId !== await internalBookId(productCode, product.volume)) {
      return { sealed: true, valid: false, code: 'ORDER_IDENTITY_MISMATCH' };
    }
    // The immutable item/task snapshot hashes below seal the order-time price.
    // Repricing the catalog must not hide or invalidate an existing sealed order.
  }
  const expectedTaskHash = await taskIdentityHash(String(taskId), ownerId, vendorName, identities);
  const expectedRowCount = identities.reduce((sum, item) => sum + item.studentIds.length, 0);
  if (selected.length !== expectedRowCount || Number(selected[0].expected_item_count) !== identities.length ||
      Number(selected[0].expected_row_count) !== expectedRowCount) {
    return { sealed: true, valid: false, code: 'ORDER_IDENTITY_MISMATCH' };
  }
  const byIndex = new Map();
  for (const row of selected) {
    const index = Number(row.item_index);
    if (!Number.isInteger(index) || index < 0 || index >= identities.length) {
      return { sealed: true, valid: false, code: 'ORDER_IDENTITY_MISMATCH' };
    }
    if (!byIndex.has(index)) byIndex.set(index, []);
    byIndex.get(index).push(row);
  }
  if (byIndex.size !== identities.length) return { sealed: true, valid: false, code: 'ORDER_IDENTITY_MISMATCH' };

  const rosterById = document && document.roster && Array.isArray(document.roster.students)
    ? new Map(document.roster.students.map(student => [String(student.id), student])) : null;
  const month = kstDate(now).slice(0, 7);
  for (let index = 0; index < identities.length; index++) {
    const identity = identities[index];
    const itemRows = byIndex.get(index) || [];
    const rowIds = itemRows.map(row => String(row.student_id)).sort();
    if (JSON.stringify(rowIds) !== JSON.stringify(identity.studentIds)) {
      return { sealed: true, valid: false, code: 'ORDER_IDENTITY_MISMATCH' };
    }
    for (const row of itemRows) {
      if (String(row.owner_id || '') !== ownerId || String(row.book_id || '') !== identity.bookId ||
          String(row.public_title || '') !== '주문 교재' ||
          String(row.student_set_hash || '') !== identity.studentSetHash ||
          String(row.item_identity_hash || '') !== identity.itemIdentityHash ||
          String(row.task_identity_hash || '') !== expectedTaskHash ||
          Number(row.expected_item_count) !== identities.length ||
          Number(row.expected_row_count) !== expectedRowCount) {
        return { sealed: true, valid: false, code: 'ORDER_IDENTITY_MISMATCH' };
      }
      if (rosterById && !cancelledItemIndexes.has(index)) {
        const student = rosterById.get(String(row.student_id));
        if (!student || (requireCurrentEnrollment && !activeStudent(student, month)) ||
            await studentIdentityHash(student) !== String(row.student_identity_hash || '')) {
          return { sealed: true, valid: false, code: 'ORDER_STUDENT_IDENTITY_CHANGED' };
        }
      }
    }
  }
  return { sealed: true, valid: true, rows: selected };
}

export async function verifyOrderTaskSnapshot(env, app, taskId, owner, task, document, now) {
  const [rows, cancellations] = await Promise.all([
    loadOrderSnapshotRows(env, app, taskId),
    loadOrderItemCancellationRows(env, app, taskId)
  ]);
  if (!rows.length) return verifyOrderTaskSnapshotRows(taskId, owner, task, rows, null, now);
  const roster = document === undefined ? await currentRoster(env, app) : document;
  if (!roster) return { sealed: true, valid: false, code: 'ORDER_STUDENT_IDENTITY_CHANGED' };
  return verifyOrderTaskSnapshotRows(taskId, owner, task, rows, roster, now, true,
    cancelledOrderItemIndexes(cancellations, taskId));
}

function requestError(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return true;
  if (Object.keys(body).some(key => !ALLOWED_KEYS.has(key)) || body.action !== 'create') return true;
  if (Object.prototype.hasOwnProperty.call(body, 'expectedUpdatedAt') ||
      Object.prototype.hasOwnProperty.call(body, 'itemIndex') ||
      !SAFE_ORDER_TASK_ID.test(String(body.taskId || '')) || !Array.isArray(body.items) ||
      !body.items.length || body.items.length > MAX_ITEMS) return true;
  return body.items.some(item => !item || typeof item !== 'object' || Array.isArray(item) ||
    Object.keys(item).some(key => !ALLOWED_ITEM_KEYS.has(key)) ||
    !Object.prototype.hasOwnProperty.call(item, 'unitPrice') ||
    !Number.isInteger(item.unitPrice) || item.unitPrice < 1 || item.unitPrice > MAX_UNIT_PRICE);
}

function boundRequestError(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.action !== 'create_bound' ||
      Object.keys(body).some(key => !BOUND_ALLOWED_KEYS.has(key)) ||
      !SAFE_ORDER_TASK_ID.test(String(body.taskId || '')) ||
      !BOUND_PRODUCTS[String(body.productCode || '')] || !text(body.title, 160, false)) return true;
  return !normalizedStudentIds({ studentIds: body.studentIds });
}

function internalRequestError(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.action !== 'create_internal' ||
      Object.keys(body).some(key => !INTERNAL_ALLOWED_KEYS.has(key)) ||
      !SAFE_ORDER_TASK_ID.test(String(body.taskId || '')) ||
      !internalBookProduct(String(body.productCode || ''),
        Object.prototype.hasOwnProperty.call(body, 'volume') ? body.volume : undefined)) return true;
  return !normalizedStudentIds({ studentIds: body.studentIds });
}

function cancelRequestError(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.action !== 'cancel' ||
      Object.keys(body).some(key => !ALLOWED_KEYS.has(key))) return true;
  const expected = Number(body.expectedUpdatedAt);
  return !SAFE_ORDER_TASK_ID.test(String(body.taskId || '')) || !Number.isInteger(expected) || expected <= 0 ||
    Object.prototype.hasOwnProperty.call(body, 'vendorName') || Object.prototype.hasOwnProperty.call(body, 'items') ||
    Object.prototype.hasOwnProperty.call(body, 'itemIndex');
}

function cancelItemRequestError(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.action !== 'cancel_item' ||
      Object.keys(body).some(key => !ALLOWED_KEYS.has(key))) return true;
  const expected = Number(body.expectedUpdatedAt);
  const itemIndex = Number(body.itemIndex);
  return !SAFE_ORDER_TASK_ID.test(String(body.taskId || '')) || !Number.isInteger(expected) || expected <= 0 ||
    !Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= MAX_ITEMS ||
    Object.prototype.hasOwnProperty.call(body, 'vendorName') || Object.prototype.hasOwnProperty.call(body, 'items');
}

function originFor(auth) {
  return auth && auth.role === 'manager' ? 'manager' : auth && auth.scope === 'own' ? 'staff' : 'admin';
}

function configuredVendor(env, vendorName) {
  let vendors;
  try { vendors = JSON.parse(env.BOOK_VENDOR_PHONES || '{}'); }
  catch (error) { return false; }
  const phone = String(vendors && vendors[vendorName] || '').replace(/[\s()-]/g, '');
  return /^01[016789]\d{7,8}$/.test(phone);
}

function canonicalTask(taskId, ownerId, vendorName, items, delivery, now) {
  const titleMain = items.length > 1 ? (vendorName || '교재') + ' — ' + items.length + '권' : items[0].title;
  const list = items.map(item => item.title + ': ' + item.qty);
  const manualOnline = delivery === MANUAL_ONLINE_DELIVERY;
  const guide = (manualOnline ? '온라인에서 직접 주문할 교재입니다.' : '재고 부족으로 요청된 교재 주문입니다.') +
    '\n■ 목록\n' + list.map(line => '· ' + line).join('\n') + '\n' +
    (vendorName ? '■ 주문처: ' + vendorName + '\n' : '■ 주문처: 미등록\n') +
    (manualOnline
      ? '1) 쿠팡에서 주문 후 교재 탭에서 주문완료 또는 주문실패 표시\n2) 입고 후 수령완료와 배부완료 처리'
      : '1) 저녁 8시 주문 접수 확인\n2) 교재 탭에서 수령완료와 배부완료 처리');
  return {
    id: taskId,
    groupId: 'order-' + now,
    staffId: ownerId || null,
    title: '[주문] ' + titleMain,
    detail: list.join(' · ') + (vendorName ? ' · 주문처: ' + vendorName : ''),
    guide,
    steps: [{ id: crypto.randomUUID(), label: manualOnline ? '온라인 주문 결과 표시' : '교재 탭 배송 확인' }],
    target: 0,
    unit: '건',
    time: '',
    priority: 'normal',
    repeat: 'once',
    days: [],
    start: kstDate(now),
    end: '',
    carry: true,
    orderVendor: vendorName,
    orderItems: items.map(item => ({
      bookId: item.bookId, title: item.title, studentIds: item.studentIds, qty: item.qty,
      unitPrice: item.unitPrice,
      ...(item.hasPublisherName ? { publisherName: item.publisherName } : {})
    })),
    orderDelivery: delivery,
    orderIdentityVersion: 1,
    createdAt: now,
    updatedAt: now,
    deleted: false
  };
}

function canonicalBoundTask(taskId, ownerId, productCode, product, item, now) {
  return {
    id: taskId,
    groupId: 'bound-order-' + now,
    staffId: ownerId || null,
    title: '[주문] ' + item.title,
    detail: item.title + ': ' + item.qty + ' · ' + product.label,
    guide: '제본 교재 주문입니다.\n1) 제본 완료 후 학생에게 배부\n2) 배부 후 아카등록 완료 처리',
    steps: [{ id: crypto.randomUUID(), label: '배부 후 아카등록' }],
    target: 0,
    unit: '건',
    time: '',
    priority: 'normal',
    repeat: 'once',
    days: [],
    start: kstDate(now),
    end: '',
    carry: true,
    orderVendor: BOUND_VENDOR,
    orderItems: [{
      bookId: item.bookId,
      title: item.title,
      studentIds: item.studentIds,
      qty: item.qty,
      unitPrice: item.unitPrice
    }],
    orderDelivery: BOUND_DELIVERY,
    orderIdentityVersion: 1,
    boundProductCode: productCode,
    boundProductLabel: product.label,
    createdAt: now,
    updatedAt: now,
    deleted: false
  };
}

function canonicalInternalTask(taskId, ownerId, productCode, product, item, now) {
  return {
    id: taskId,
    groupId: 'internal-order-' + now,
    staffId: ownerId || null,
    title: '[주문] ' + item.title,
    detail: item.title + ': ' + item.qty + ' · ' + product.label,
    guide: '내부 교재 주문입니다.\n1) 주문 즉시 선생님 수령 단계로 등록\n2) 배부 후 아카등록 완료 처리',
    steps: [{ id: crypto.randomUUID(), label: '배부 후 아카등록' }],
    target: 0,
    unit: '건',
    time: '',
    priority: 'normal',
    repeat: 'once',
    days: [],
    start: kstDate(now),
    end: '',
    carry: true,
    orderVendor: INTERNAL_BOOK_VENDOR,
    orderItems: [{
      bookId: item.bookId,
      title: item.title,
      studentIds: item.studentIds,
      qty: item.qty,
      unitPrice: item.unitPrice
    }],
    orderDelivery: INTERNAL_BOOK_DELIVERY,
    orderIdentityVersion: 1,
    internalProductCode: productCode,
    internalProductLabel: product.label,
    ...(product.volume === null ? {} : { internalProductVolume: product.volume }),
    createdAt: now,
    updatedAt: now,
    deleted: false
  };
}

async function exactExisting(env, app, taskId, ownerId, vendorName, delivery, items, document) {
  const row = await env.DB.prepare('SELECT owner,data FROM tasks WHERE app=? AND id=? LIMIT 1')
    .bind(app, taskId).first();
  const snapshots = await loadOrderSnapshotRows(env, app, taskId);
  if (!row || !snapshots.length) return null;
  const task = parseJson(row.data || '{}', null);
  const verified = await verifyOrderTaskSnapshotRows(taskId, row.owner, task, snapshots, document, Date.now(), false);
  if (!verified.valid || !verified.sealed || task.orderDelivery !== delivery ||
      String(row.owner || '') !== ownerId ||
      text(task.orderVendor, 100, true) !== vendorName || task.orderItems.length !== items.length) return null;
  for (let index = 0; index < items.length; index++) {
    const stored = await itemIdentity(task.orderItems[index]);
    if (!stored || stored.itemIdentityHash !== items[index].itemIdentityHash) return null;
  }
  return task;
}

async function exactExistingBound(env, app, taskId, ownerId, productCode, identity, document) {
  const [taskRow, fulfillment] = await Promise.all([
    env.DB.prepare('SELECT owner,data FROM tasks WHERE app=? AND id=? LIMIT 1').bind(app, taskId).first(),
    env.DB.prepare('SELECT * FROM book_order_fulfillments WHERE app=? AND task_id=? AND item_index=0 LIMIT 1')
      .bind(app, taskId).first()
  ]);
  const snapshots = await loadOrderSnapshotRows(env, app, taskId);
  if (!taskRow || !snapshots.length || !fulfillment) return null;
  const task = parseJson(taskRow.data || '{}', null);
  const verified = await verifyOrderTaskSnapshotRows(
    taskId, taskRow.owner, task, snapshots, document, Date.now(), false
  );
  const stored = task && Array.isArray(task.orderItems) && task.orderItems.length === 1
    ? await itemIdentity(task.orderItems[0]) : null;
  const parsedFulfillmentIds = parseJson(fulfillment.student_ids || '[]', null);
  const fulfillmentIds = Array.isArray(parsedFulfillmentIds) ? parsedFulfillmentIds.map(String).sort() : [];
  if (!verified.valid || !verified.sealed || task.orderDelivery !== BOUND_DELIVERY ||
      String(task.boundProductCode || '') !== productCode || String(taskRow.owner || '') !== ownerId ||
      !stored || stored.itemIdentityHash !== identity.itemIdentityHash ||
      String(fulfillment.book_id || '') !== identity.bookId ||
      JSON.stringify(fulfillmentIds) !== JSON.stringify(identity.studentIds) ||
      !['teacher_received', 'student_handed', 'academy_registered'].includes(String(fulfillment.status || '')) ||
      !Number(fulfillment.teacher_received_at)) return null;
  return task;
}

async function exactExistingInternal(env, app, taskId, ownerId, productCode, product, identity, document) {
  const [taskRow, fulfillment] = await Promise.all([
    env.DB.prepare('SELECT owner,data FROM tasks WHERE app=? AND id=? LIMIT 1').bind(app, taskId).first(),
    env.DB.prepare('SELECT * FROM book_order_fulfillments WHERE app=? AND task_id=? AND item_index=0 LIMIT 1')
      .bind(app, taskId).first()
  ]);
  const snapshots = await loadOrderSnapshotRows(env, app, taskId);
  if (!taskRow || !snapshots.length || !fulfillment) return null;
  const task = parseJson(taskRow.data || '{}', null);
  const verified = await verifyOrderTaskSnapshotRows(
    taskId, taskRow.owner, task, snapshots, document, Date.now(), false
  );
  const stored = task && Array.isArray(task.orderItems) && task.orderItems.length === 1
    ? await itemIdentity(task.orderItems[0]) : null;
  const requestedAtStoredPrice = verified.valid && stored
    ? await itemIdentity({ bookId: identity.bookId, title: identity.title,
      studentIds: identity.studentIds, unitPrice: stored.unitPrice }) : null;
  const parsedFulfillmentIds = parseJson(fulfillment.student_ids || '[]', null);
  const fulfillmentIds = Array.isArray(parsedFulfillmentIds) ? parsedFulfillmentIds.map(String).sort() : [];
  const storedVolume = Object.prototype.hasOwnProperty.call(task || {}, 'internalProductVolume')
    ? task.internalProductVolume : null;
  if (!verified.valid || !verified.sealed || task.orderDelivery !== INTERNAL_BOOK_DELIVERY ||
      String(task.internalProductCode || '') !== productCode ||
      String(task.internalProductLabel || '') !== product.label || storedVolume !== product.volume ||
      String(taskRow.owner || '') !== ownerId || !stored || !requestedAtStoredPrice ||
      stored.itemIdentityHash !== requestedAtStoredPrice.itemIdentityHash ||
      String(fulfillment.book_id || '') !== identity.bookId ||
      JSON.stringify(fulfillmentIds) !== JSON.stringify(identity.studentIds) ||
      !['teacher_received', 'student_handed', 'academy_registered'].includes(String(fulfillment.status || '')) ||
      !Number(fulfillment.teacher_received_at)) return null;
  return task;
}

async function hasActiveDuplicate(env, app, identities) {
  const wanted = new Set(identities.flatMap(item =>
    item.studentIds.map(studentId => item.bookId + '\u0000' + studentId)));
  const studentIds = [...new Set(identities.flatMap(item => item.studentIds))];
  const result = await env.DB.prepare(
    'SELECT target.book_id,target.student_id FROM book_order_active_targets target ' +
    'JOIN json_each(?) selected ON selected.value=target.student_id WHERE target.app=? AND target.active=1'
  ).bind(JSON.stringify(studentIds), app).all();
  return (result.results || []).some(row => wanted.has(String(row.book_id) + '\u0000' + String(row.student_id)));
}

async function createImmediateOrder(env, app, body, origin, auth, json) {
  const internal = body && body.action === 'create_internal';
  if (app !== 'task' || (internal ? internalRequestError(body) : boundRequestError(body))) {
    return json({ ok: false, code: 'ORDER_INVALID',
      error: internal
        ? '내부 교재 종류·권번호·학생 선택을 다시 확인해 주세요'
        : '제본 종류·교재명·학생 선택을 다시 확인해 주세요' }, 400, origin);
  }
  const productCode = String(body.productCode);
  const product = internal
    ? internalBookProduct(productCode,
      Object.prototype.hasOwnProperty.call(body, 'volume') ? body.volume : undefined)
    : BOUND_PRODUCTS[productCode];
  const title = internal ? product.title : text(body.title, 160, false).replace(/\s+/g, ' ');
  const studentIds = normalizedStudentIds({ studentIds: body.studentIds });
  const bookId = internal
    ? await internalBookId(productCode, product.volume)
    : await boundBookId(productCode, title);
  const identity = await itemIdentity({ bookId, title, studentIds, unitPrice: product.unitPrice });
  if (!identity) {
    return json({ ok: false, code: 'ORDER_INVALID',
      error: internal
        ? '내부 교재 종류·권번호·학생 선택을 다시 확인해 주세요'
        : '제본 종류·교재명·학생 선택을 다시 확인해 주세요' }, 400, origin);
  }

  const taskId = String(body.taskId);
  const ownerId = auth && SAFE_ID.test(String(auth.id || '')) ? String(auth.id) : '';
  const rosterRecord = await currentRosterRecord(env, app);
  if (rosterRecord === null) {
    return json({ ok: false, code: 'ROSTER_MISSING', error: '현재 원생 명단을 먼저 등록해 주세요' }, 404, origin);
  }
  if (rosterRecord === false) {
    return json({ ok: false, code: 'ROSTER_INVALID', error: '현재 원생 명단 형식을 확인해 주세요' }, 409, origin);
  }
  const document = rosterRecord.document;
  const rosterById = new Map(document.roster.students.map(student => [String(student.id), student]));
  const exactImmediate = () => internal
    ? exactExistingInternal(env, app, taskId, ownerId, productCode, product, identity, document)
    : exactExistingBound(env, app, taskId, ownerId, productCode, identity, document);
  let existing;
  try {
    existing = await exactImmediate();
  } catch (error) {
    if (/no such table.*(?:book_order_student_snapshots|book_order_fulfillments)/i.test(
      String(error && error.message || error)
    )) {
      return json({ ok: false, code: 'ORDER_LEDGER_NOT_READY', error: '교재 주문 원장을 준비하고 있습니다' }, 503, origin);
    }
    throw error;
  }
  if (existing) return json({ ok: true, idempotent: true, task: existing }, 200, origin);

  const collision = await env.DB.prepare(
    'SELECT 1 AS found FROM tasks WHERE app=? AND id=? UNION ALL ' +
    'SELECT 1 AS found FROM book_order_student_snapshots WHERE app=? AND task_id=? LIMIT 1'
  ).bind(app, taskId, app, taskId).first();
  if (collision) {
    return json({ ok: false, code: 'ORDER_ID_CONFLICT',
      error: '같은 주문 ID가 이미 다른 내용으로 사용되었습니다' }, 409, origin);
  }

  const month = kstDate(Date.now()).slice(0, 7);
  if (studentIds.some(id => !rosterById.has(id))) {
    return json({ ok: false, code: 'ORDER_STUDENT_MISSING',
      error: '선택한 학생이 현재 원생 명단에 없습니다' }, 409, origin);
  }
  if (studentIds.some(id => !activeStudent(rosterById.get(id), month))) {
    return json({ ok: false, code: 'ORDER_STUDENT_INACTIVE',
      error: '현재 재원 중인 학생만 주문에 연결할 수 있습니다' }, 409, origin);
  }
  const allowedStudentIds = await bookOrderStudentIdsForAuth(env, app, document, auth);
  if (auth.scope === 'own' && studentIds.some(id => !allowedStudentIds.has(id))) {
    return json({ ok: false, code: 'ORDER_STUDENT_SCOPE',
      error: '현재 본인이 담당하는 수업 학생만 주문에 연결할 수 있습니다' }, 403, origin);
  }
  if (await hasActiveDuplicate(env, app, [identity])) {
    return json({ ok: false, code: 'ORDER_ALREADY_ACTIVE',
      error: internal
        ? '같은 학생의 같은 내부 교재 주문이 아직 완료되지 않았습니다'
        : '같은 학생의 같은 제본 교재 주문이 아직 완료되지 않았습니다' }, 409, origin);
  }

  const now = Date.now();
  const task = internal
    ? canonicalInternalTask(taskId, ownerId, productCode, product, identity, now)
    : canonicalBoundTask(taskId, ownerId, productCode, product, identity, now);
  task.origin = originFor(auth);
  const taskHash = await taskIdentityHash(
    taskId, ownerId, internal ? INTERNAL_BOOK_VENDOR : BOUND_VENDOR, [identity]
  );
  const snapshots = [];
  for (const studentId of studentIds) {
    snapshots.push({
      taskId, itemIndex: 0, ownerId, bookId, studentId,
      studentIdentityHash: await studentIdentityHash(rosterById.get(studentId)),
      studentSetHash: identity.studentSetHash,
      itemIdentityHash: identity.itemIdentityHash,
      taskHash,
      itemCount: 1,
      rowCount: studentIds.length,
      createdAt: now
    });
  }
  const taskData = JSON.stringify(task);
  const studentIdsJson = JSON.stringify(studentIds);
  const receiverId = ownerId || 'director';
  const writeGuard = ownBookStudentWriteGuard(auth, app, studentIds, now);
  const statements = [
    env.DB.prepare(
      'INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) SELECT ?,?,?,?,?,? ' +
      'WHERE EXISTS (SELECT 1 FROM private_rosters WHERE app=? AND data=? AND updated_at=?)' +
      writeGuard.sql
    ).bind(app, taskId, ownerId || null, taskData, now, now,
      app, rosterRecord.rawData, rosterRecord.updatedAt, ...writeGuard.binds),
    env.DB.prepare(
      'INSERT INTO book_order_student_snapshots(app,task_id,item_index,owner_id,book_id,public_title,student_id,' +
      'student_identity_hash,student_set_hash,item_identity_hash,task_identity_hash,' +
      'expected_item_count,expected_row_count,created_at) ' +
      "SELECT ?,json_extract(value,'$.taskId'),json_extract(value,'$.itemIndex')," +
      "json_extract(value,'$.ownerId'),json_extract(value,'$.bookId'),'주문 교재'," +
      "json_extract(value,'$.studentId'),json_extract(value,'$.studentIdentityHash')," +
      "json_extract(value,'$.studentSetHash'),json_extract(value,'$.itemIdentityHash')," +
      "json_extract(value,'$.taskHash'),json_extract(value,'$.itemCount')," +
      "json_extract(value,'$.rowCount'),json_extract(value,'$.createdAt') FROM json_each(?) " +
      'WHERE EXISTS (SELECT 1 FROM tasks WHERE app=? AND id=? AND data=? AND updated_at=?) ' +
      'AND EXISTS (SELECT 1 FROM private_rosters WHERE app=? AND data=? AND updated_at=?)'
    ).bind(app, JSON.stringify(snapshots), app, taskId, taskData, now,
      app, rosterRecord.rawData, rosterRecord.updatedAt),
    env.DB.prepare(
      'INSERT INTO book_order_fulfillments(app,task_id,item_index,book_id,student_ids,status,revision,' +
      'teacher_received_at,teacher_received_by,created_at,updated_at) ' +
      "SELECT ?,?,?,?,?,'teacher_received',1,?,?,?,? " +
      'WHERE EXISTS (SELECT 1 FROM tasks WHERE app=? AND id=? AND data=? AND updated_at=?) ' +
      'AND (SELECT COUNT(*) FROM book_order_student_snapshots WHERE app=? AND task_id=? ' +
        'AND item_index=0 AND book_id=?)=? ' +
      'AND NOT EXISTS (SELECT 1 FROM json_each(?) selected WHERE NOT EXISTS (' +
        'SELECT 1 FROM book_order_student_snapshots snapshot WHERE snapshot.app=? AND snapshot.task_id=? ' +
        'AND snapshot.item_index=0 AND snapshot.book_id=? AND snapshot.student_id=selected.value))'
    ).bind(app, taskId, 0, bookId, studentIdsJson, now, receiverId, now, now,
      app, taskId, taskData, now, app, taskId, bookId, studentIds.length,
      studentIdsJson, app, taskId, bookId)
  ];

  try {
    const results = await env.DB.batch(statements);
    const taskChanges = Number(results && results[0] && results[0].meta && results[0].meta.changes || 0);
    const snapshotChanges = Number(results && results[1] && results[1].meta && results[1].meta.changes || 0);
    const fulfillmentChanges = Number(results && results[2] && results[2].meta && results[2].meta.changes || 0);
    if (taskChanges !== 1) {
      const raced = await exactImmediate();
      if (raced) return json({ ok: true, idempotent: true, task: raced }, 200, origin);
      if (!(await ownOrderStudentScopeStillValid(env, app, auth, studentIds))) {
        return json({ ok: false, code: 'ORDER_STUDENT_SCOPE',
          error: '담당 수업이 변경되어 이 학생의 주문을 등록할 수 없습니다' }, 403, origin);
      }
      return json({ ok: false, code: 'ROSTER_REVISION_CONFLICT',
        error: '원생 명단이 주문 등록 중 변경되었습니다. 새로고침 후 다시 등록해 주세요' }, 409, origin);
    }
    const stored = await exactImmediate();
    if (snapshotChanges !== studentIds.length || fulfillmentChanges !== 1 || !stored) {
      return json({ ok: false, code: 'ORDER_IDENTITY_MISMATCH',
        error: internal
          ? '내부 교재 주문 원장의 정체성 확인이 필요합니다'
          : '제본 교재 주문 원장의 정체성 확인이 필요합니다' }, 500, origin);
    }
  } catch (error) {
    const raced = await exactImmediate();
    if (raced) return json({ ok: true, idempotent: true, task: raced }, 200, origin);
    if (await hasActiveDuplicate(env, app, [identity])) {
      return json({ ok: false, code: 'ORDER_ALREADY_ACTIVE',
        error: internal
          ? '같은 학생의 같은 내부 교재 주문이 아직 완료되지 않았습니다'
          : '같은 학생의 같은 제본 교재 주문이 아직 완료되지 않았습니다' }, 409, origin);
    }
    if (/constraint|unique|primary|BOOK_ORDER_/i.test(String(error && error.message || error))) {
      return json({ ok: false, code: 'ORDER_ID_CONFLICT',
        error: '같은 주문 ID가 이미 다른 내용으로 사용되었습니다' }, 409, origin);
    }
    throw error;
  }
  return json({ ok: true, idempotent: false, task }, 201, origin);
}

async function cancelSealedOrderItem(env, app, body, origin, auth, json) {
  if (app !== 'task' || cancelItemRequestError(body)) {
    return json({ ok: false, code: 'ORDER_INVALID', error: '취소할 교재와 최신 상태를 다시 확인해 주세요' }, 400, origin);
  }
  const lock = await acquireBookOrderDispatchLock(env, app, 'cancel_item', Date.now());
  if (!lock) {
    return json({ ok: false, code: 'ORDER_CANCEL_SEND_ACTIVE', error: '주문 발송 확인 중에는 취소할 수 없습니다' }, 409, origin);
  }
  const taskId = String(body.taskId);
  const itemIndex = Number(body.itemIndex);
  try {
    const row = await env.DB.prepare('SELECT owner,data,updated_at FROM tasks WHERE app=? AND id=? LIMIT 1')
      .bind(app, taskId).first();
    if (!row) return json({ ok: false, error: '주문 지시서를 찾을 수 없습니다' }, 404, origin);
    if (auth.scope === 'own' && String(row.owner || '') !== String(auth.id || '')) {
      return json({ ok: false, error: '본인이 만든 주문만 취소할 수 있습니다' }, 403, origin);
    }
    const task = parseJson(row.data || '{}', null);
    const item = task && Array.isArray(task.orderItems) ? task.orderItems[itemIndex] : null;
    if (!task || !item || Number(task.orderIdentityVersion) !== 1) {
      return json({ ok: false, code: 'ORDER_CANCEL_NOT_WAITING',
        error: '1단계 주문대기 교재만 취소할 수 있습니다' }, 409, origin);
    }
    const bookId = String(item.bookId || '');
    if (!SAFE_ID.test(bookId)) {
      return json({ ok: false, code: 'ORDER_IDENTITY_MISMATCH', error: '주문 교재의 정체성 확인이 필요합니다' }, 409, origin);
    }
    let cancelled = await env.DB.prepare(
      'SELECT task_id,item_index,book_id,cancelled_at FROM book_order_item_cancellations ' +
      'WHERE app=? AND task_id=? AND item_index=? LIMIT 1'
    ).bind(app, taskId, itemIndex).first();
    if (cancelled) {
      if (String(cancelled.book_id || '') !== bookId) {
        return json({ ok: false, code: 'ORDER_IDENTITY_MISMATCH', error: '취소 원장의 교재 정체성이 일치하지 않습니다' }, 409, origin);
      }
      return json({ ok: true, idempotent: true, cancellation: {
        taskId, itemIndex, cancelledAt: Number(cancelled.cancelled_at)
      } }, 200, origin);
    }
    if (task.deleted || !['scheduled_batch_v1', MANUAL_ONLINE_DELIVERY].includes(String(task.orderDelivery || ''))) {
      return json({ ok: false, code: 'ORDER_CANCEL_NOT_WAITING',
        error: '1단계 주문대기 교재만 취소할 수 있습니다' }, 409, origin);
    }
    const [snapshots, existingCancellations] = await Promise.all([
      loadOrderSnapshotRows(env, app, taskId),
      loadOrderItemCancellationRows(env, app, taskId)
    ]);
    const verified = await verifyOrderTaskSnapshotRows(
      taskId, row.owner, task, snapshots, null, Date.now(), true,
      cancelledOrderItemIndexes(existingCancellations, taskId)
    );
    if (!verified.valid) {
      return json({ ok: false, code: 'ORDER_IDENTITY_MISMATCH', error: '주문 내용의 정체성 확인이 필요합니다' }, 409, origin);
    }
    if (Number(row.updated_at) !== Number(body.expectedUpdatedAt)) {
      return json({ ok: false, code: 'REVISION_CONFLICT', error: '다른 기기에서 주문이 먼저 변경되었습니다' }, 409, origin);
    }
    const fulfillment = await env.DB.prepare(
      'SELECT 1 AS found FROM book_order_fulfillments WHERE app=? AND task_id=? AND item_index=? LIMIT 1'
    ).bind(app, taskId, itemIndex).first();
    if (fulfillment) {
      return json({ ok: false, code: 'ORDER_CANCEL_NOT_WAITING', error: '1단계 주문대기 교재만 취소할 수 있습니다' }, 409, origin);
    }
    const send = await env.DB.prepare(
      'SELECT 1 AS found FROM book_order_sends send LEFT JOIN book_order_batch_items mapped ' +
      'ON mapped.app=send.app AND mapped.send_id=send.send_id WHERE send.app=? ' +
      'AND (send.task_id=? OR mapped.task_id=?) LIMIT 1'
    ).bind(app, taskId, taskId).first();
    if (send) {
      return json({ ok: false, code: 'ORDER_CANCEL_NOT_WAITING', error: '1단계 주문대기 교재만 취소할 수 있습니다' }, 409, origin);
    }
    const now = Date.now();
    const actor = originFor(auth);
    let inserted;
    try {
      inserted = await env.DB.prepare(
        'INSERT OR IGNORE INTO book_order_item_cancellations(app,task_id,item_index,book_id,cancelled_at,cancelled_by) ' +
        'SELECT ?,?,?,?,?,? WHERE EXISTS (' +
          "SELECT 1 FROM tasks WHERE app=? AND id=? AND updated_at=? AND COALESCE(json_extract(data,'$.deleted'),0)=0" +
        ') AND NOT EXISTS (' +
          'SELECT 1 FROM book_order_sends active LEFT JOIN book_order_batch_items mapped ' +
          'ON mapped.app=active.app AND mapped.send_id=active.send_id WHERE active.app=? ' +
          'AND (active.task_id=? OR mapped.task_id=?)' +
        ') AND NOT EXISTS (' +
          'SELECT 1 FROM book_order_fulfillments fulfillment WHERE fulfillment.app=? ' +
          'AND fulfillment.task_id=? AND fulfillment.item_index=?' +
        ')'
      ).bind(app, taskId, itemIndex, bookId, now, actor,
        app, taskId, Number(body.expectedUpdatedAt), app, taskId, taskId, app, taskId, itemIndex).run();
    } catch (error) {
      if (/BOOK_ORDER_ITEM_CANCEL_NOT_WAITING/.test(String(error && error.message || error))) {
        return json({ ok: false, code: 'ORDER_CANCEL_NOT_WAITING', error: '1단계 주문대기 교재만 취소할 수 있습니다' }, 409, origin);
      }
      throw error;
    }
    cancelled = await env.DB.prepare(
      'SELECT task_id,item_index,book_id,cancelled_at FROM book_order_item_cancellations ' +
      'WHERE app=? AND task_id=? AND item_index=? LIMIT 1'
    ).bind(app, taskId, itemIndex).first();
    if (cancelled && String(cancelled.book_id || '') === bookId) {
      return json({ ok: true, idempotent: !inserted || !inserted.meta || Number(inserted.meta.changes || 0) !== 1,
        cancellation: { taskId, itemIndex, cancelledAt: Number(cancelled.cancelled_at) } }, 200, origin);
    }
    const fresh = await env.DB.prepare('SELECT updated_at FROM tasks WHERE app=? AND id=? LIMIT 1')
      .bind(app, taskId).first();
    if (!fresh || Number(fresh.updated_at) !== Number(body.expectedUpdatedAt)) {
      return json({ ok: false, code: 'REVISION_CONFLICT', error: '다른 기기에서 주문이 먼저 변경되었습니다' }, 409, origin);
    }
    return json({ ok: false, code: 'ORDER_CANCEL_NOT_WAITING', error: '1단계 주문대기 교재만 취소할 수 있습니다' }, 409, origin);
  } finally {
    await releaseBookOrderDispatchLockSafely(env, app, lock);
  }
}

async function cancelSealedOrder(env, app, body, origin, auth, json) {
  if (app !== 'task' || cancelRequestError(body)) {
    return json({ ok: false, code: 'ORDER_INVALID', error: '취소할 주문과 최신 상태를 다시 확인해 주세요' }, 400, origin);
  }
  const lock = await acquireBookOrderDispatchLock(env, app, 'cancel', Date.now());
  if (!lock) {
    return json({ ok: false, code: 'ORDER_CANCEL_SEND_ACTIVE', error: '주문 발송 확인 중에는 취소할 수 없습니다' }, 409, origin);
  }
  const taskId = String(body.taskId);
  try {
    const row = await env.DB.prepare('SELECT owner,data,updated_at FROM tasks WHERE app=? AND id=? LIMIT 1')
      .bind(app, taskId).first();
    if (!row) return json({ ok: false, error: '주문 지시서를 찾을 수 없습니다' }, 404, origin);
    if (auth.scope === 'own' && String(row.owner || '') !== String(auth.id || '')) {
      return json({ ok: false, error: '본인이 만든 주문만 취소할 수 있습니다' }, 403, origin);
    }
    const task = parseJson(row.data || '{}', null);
    const cancelled = await env.DB.prepare(
      'SELECT cancelled_at FROM book_order_cancellations WHERE app=? AND task_id=? LIMIT 1'
    ).bind(app, taskId).first();
    if (cancelled && task && task.deleted && Number(task.orderCancelledAt) === Number(cancelled.cancelled_at)) {
      return json({ ok: true, idempotent: true, task }, 200, origin);
    }
    const snapshots = await loadOrderSnapshotRows(env, app, taskId);
    if (!snapshots.length || Number(task && task.orderIdentityVersion) !== 1) {
      return json({ ok: false, code: 'ORDER_NOT_SEALED', error: '기존 주문은 기존 취소 방식으로 처리해 주세요' }, 409, origin);
    }
    const verified = await verifyOrderTaskSnapshotRows(taskId, row.owner, task, snapshots, null);
    if (!verified.valid) {
      return json({ ok: false, code: 'ORDER_IDENTITY_MISMATCH', error: '주문 내용의 정체성 확인이 필요합니다' }, 409, origin);
    }
    if (Number(row.updated_at) !== Number(body.expectedUpdatedAt)) {
      return json({ ok: false, code: 'REVISION_CONFLICT', error: '다른 기기에서 주문이 먼저 변경되었습니다' }, 409, origin);
    }
    const fulfillment = await env.DB.prepare(
      'SELECT 1 AS found FROM book_order_fulfillments WHERE app=? AND task_id=? LIMIT 1'
    ).bind(app, taskId).first();
    if (fulfillment) {
      return json({ ok: false, code: 'ORDER_ALREADY_RECEIVED',
        error: '이미 수령 처리가 시작된 주문은 취소할 수 없습니다' }, 409, origin);
    }
    const active = await env.DB.prepare(
      'SELECT send.status FROM book_order_sends send LEFT JOIN book_order_batch_items item ' +
      'ON item.app=send.app AND item.send_id=send.send_id WHERE send.app=? ' +
      'AND (item.task_id=? OR send.task_id=?) LIMIT 1'
    ).bind(app, taskId, taskId).first();
    if (active) {
      const stillActive = ['reserved', 'dispatching', 'accepted', 'unknown'].includes(String(active.status || ''));
      return json({ ok: false, code: stillActive ? 'ORDER_CANCEL_SEND_ACTIVE' : 'ORDER_CANCEL_NOT_WAITING',
        error: stillActive ? '이미 발송 중이거나 접수된 주문은 취소할 수 없습니다' :
          '1단계 주문대기 상태에서만 취소할 수 있습니다' }, 409, origin);
    }
    const now = Date.now();
    const next = { ...task, deleted: true, orderCancelledAt: now, updatedAt: now,
      lastEditBy: auth.role === 'manager' ? 'manager' : auth.scope === 'own' ? 'staff' : 'admin' };
    let updated;
    try {
      updated = await env.DB.prepare(
        'UPDATE tasks SET data=?,updated_at=?,srv_at=? WHERE app=? AND id=? AND updated_at=?'
      ).bind(JSON.stringify(next), now, now, app, taskId, Number(body.expectedUpdatedAt)).run();
    } catch (error) {
      if (/BOOK_ORDER_SEND_ACTIVE/.test(String(error && error.message || error))) {
        return json({ ok: false, code: 'ORDER_CANCEL_SEND_ACTIVE', error: '이미 발송 중이거나 접수된 주문은 취소할 수 없습니다' }, 409, origin);
      }
      throw error;
    }
    if (!updated.meta || Number(updated.meta.changes || 0) !== 1) {
      return json({ ok: false, code: 'REVISION_CONFLICT', error: '다른 기기에서 주문이 먼저 변경되었습니다' }, 409, origin);
    }
    return json({ ok: true, idempotent: false, task: next }, 200, origin);
  } finally {
    await releaseBookOrderDispatchLockSafely(env, app, lock);
  }
}

export async function handleBookOrderCreate(env, app, body, origin, auth, json) {
  if (body && ['create_bound', 'create_internal'].includes(body.action)) {
    return createImmediateOrder(env, app, body, origin, auth, json);
  }
  if (body && body.action === 'cancel_item') return cancelSealedOrderItem(env, app, body, origin, auth, json);
  if (body && body.action === 'cancel') return cancelSealedOrder(env, app, body, origin, auth, json);
  if (app !== 'task' || requestError(body)) {
    return json({ ok: false, code: 'ORDER_INVALID', error: '교재 주문 항목과 학생 선택을 다시 확인해 주세요' }, 400, origin);
  }
  const vendorName = text(body.vendorName, 100, true);
  if (!vendorName) {
    return json({ ok: false, code: 'ORDER_VENDOR_REQUIRED', error: '교재 정보에서 주문처를 먼저 등록해 주세요' }, 400, origin);
  }
  const identities = [];
  let studentCount = 0;
  for (const item of body.items) {
    const identity = await itemIdentity(item);
    if (!identity || (studentCount += identity.studentIds.length) > MAX_STUDENTS) {
      return json({ ok: false, code: 'ORDER_INVALID', error: '교재·학생 선택 형식을 다시 확인해 주세요' }, 400, origin);
    }
    identities.push(identity);
  }
  if (new Set(identities.map(item => item.bookId)).size !== identities.length) {
    return json({ ok: false, code: 'ORDER_INVALID', error: '같은 교재는 주문 항목에 한 번만 넣어 주세요' }, 400, origin);
  }
  if (identities.some(item => item.hasPublisherName && item.publisherVendorName !== vendorName)) {
    return json({ ok: false, code: 'ORDER_VENDOR_MISMATCH',
      error: '선택한 출판사의 주문처와 주문 정보가 일치하지 않습니다' }, 409, origin);
  }
  const delivery = vendorName === ONLINE_BOOK_VENDOR &&
      identities.every(item => item.hasPublisherName && item.publisherVendorName === ONLINE_BOOK_VENDOR)
    ? MANUAL_ONLINE_DELIVERY : 'scheduled_batch_v1';
  if (delivery === 'scheduled_batch_v1' && !configuredVendor(env, vendorName)) {
    return json({ ok: false, code: 'ORDER_VENDOR_NOT_CONFIGURED', error: '문자 주문처 설정을 먼저 확인해 주세요' }, 409, origin);
  }

  const taskId = String(body.taskId);
  const ownerId = auth && SAFE_ID.test(String(auth.id || '')) ? String(auth.id) : '';
  const rosterRecord = await currentRosterRecord(env, app);
  if (rosterRecord === null) return json({ ok: false, code: 'ROSTER_MISSING', error: '현재 원생 명단을 먼저 등록해 주세요' }, 404, origin);
  if (rosterRecord === false) return json({ ok: false, code: 'ROSTER_INVALID', error: '현재 원생 명단 형식을 확인해 주세요' }, 409, origin);
  const document = rosterRecord.document;
  const rosterById = new Map(document.roster.students.map(student => [String(student.id), student]));
  let existing;
  try { existing = await exactExisting(env, app, taskId, ownerId, vendorName, delivery, identities, document); }
  catch (error) {
    if (/no such table.*book_order_student_snapshots/i.test(String(error && error.message || error))) {
      return json({ ok: false, code: 'ORDER_LEDGER_NOT_READY', error: '교재 주문 원장을 준비하고 있습니다' }, 503, origin);
    }
    throw error;
  }
  if (existing) return json({ ok: true, idempotent: true, task: existing }, 200, origin);
  const collision = await env.DB.prepare(
    'SELECT 1 AS found FROM tasks WHERE app=? AND id=? UNION ALL ' +
    'SELECT 1 AS found FROM book_order_student_snapshots WHERE app=? AND task_id=? LIMIT 1'
  ).bind(app, taskId, app, taskId).first();
  if (collision) return json({ ok: false, code: 'ORDER_ID_CONFLICT', error: '같은 주문 ID가 이미 다른 내용으로 사용되었습니다' }, 409, origin);

  const month = kstDate(Date.now()).slice(0, 7);
  const selectedIds = [...new Set(identities.flatMap(item => item.studentIds))];
  if (selectedIds.some(id => !rosterById.has(id))) {
    return json({ ok: false, code: 'ORDER_STUDENT_MISSING', error: '선택한 학생이 현재 원생 명단에 없습니다' }, 409, origin);
  }
  if (selectedIds.some(id => !activeStudent(rosterById.get(id), month))) {
    return json({ ok: false, code: 'ORDER_STUDENT_INACTIVE', error: '현재 재원 중인 학생만 주문에 연결할 수 있습니다' }, 409, origin);
  }
  const allowedStudentIds = await bookOrderStudentIdsForAuth(env, app, document, auth);
  if (auth.scope === 'own' && selectedIds.some(id => !allowedStudentIds.has(id))) {
    return json({ ok: false, code: 'ORDER_STUDENT_SCOPE',
      error: '현재 본인이 담당하는 수업 학생만 주문에 연결할 수 있습니다' }, 403, origin);
  }

  if (await hasActiveDuplicate(env, app, identities)) {
    return json({ ok: false, code: 'ORDER_ALREADY_ACTIVE',
      error: '같은 학생의 같은 교재 주문이 아직 완료되지 않았습니다' }, 409, origin);
  }

  const now = Date.now();
  const task = canonicalTask(taskId, ownerId, vendorName, identities, delivery, now);
  if (delivery === 'scheduled_batch_v1' &&
      new TextEncoder().encode(buildBookOrderMessage(vendorName, task.orderItems)).byteLength >
      MAX_BOOK_ORDER_MESSAGE_BYTES) {
    return json({ ok: false, code: 'ORDER_MESSAGE_TOO_LARGE',
      error: '한 번에 보낼 주문 내용이 너무 많습니다. 주문을 나눠 등록해 주세요' }, 413, origin);
  }
  task.origin = originFor(auth);
  const taskHash = await taskIdentityHash(taskId, ownerId, vendorName, identities);
  const snapshots = [];
  for (let itemIndex = 0; itemIndex < identities.length; itemIndex++) {
    const item = identities[itemIndex];
    for (const studentId of item.studentIds) {
      snapshots.push({ taskId, itemIndex, ownerId, bookId: item.bookId, studentId,
        studentIdentityHash: await studentIdentityHash(rosterById.get(studentId)),
        studentSetHash: item.studentSetHash, itemIdentityHash: item.itemIdentityHash, taskHash,
        itemCount: identities.length, rowCount: studentCount, createdAt: now });
    }
  }
  const taskData = JSON.stringify(task);
  const writeGuard = ownBookStudentWriteGuard(auth, app, selectedIds, now);
  const statements = [
    env.DB.prepare(
      'INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) SELECT ?,?,?,?,?,? ' +
      'WHERE EXISTS (SELECT 1 FROM private_rosters WHERE app=? AND data=? AND updated_at=?)' +
      writeGuard.sql
    ).bind(app, taskId, ownerId || null, taskData, now, now,
      app, rosterRecord.rawData, rosterRecord.updatedAt, ...writeGuard.binds),
    env.DB.prepare(
      'INSERT INTO book_order_student_snapshots(app,task_id,item_index,owner_id,book_id,public_title,student_id,' +
      'student_identity_hash,student_set_hash,item_identity_hash,task_identity_hash,' +
      'expected_item_count,expected_row_count,created_at) ' +
      "SELECT ?,json_extract(value,'$.taskId'),json_extract(value,'$.itemIndex')," +
      "json_extract(value,'$.ownerId'),json_extract(value,'$.bookId'),'주문 교재'," +
      "json_extract(value,'$.studentId'),json_extract(value,'$.studentIdentityHash')," +
      "json_extract(value,'$.studentSetHash'),json_extract(value,'$.itemIdentityHash')," +
      "json_extract(value,'$.taskHash'),json_extract(value,'$.itemCount')," +
      "json_extract(value,'$.rowCount'),json_extract(value,'$.createdAt') FROM json_each(?) " +
      'WHERE EXISTS (SELECT 1 FROM tasks WHERE app=? AND id=? AND data=? AND updated_at=?) ' +
      'AND EXISTS (SELECT 1 FROM private_rosters WHERE app=? AND data=? AND updated_at=?)'
    ).bind(app, JSON.stringify(snapshots), app, taskId, taskData, now,
      app, rosterRecord.rawData, rosterRecord.updatedAt)
  ];
  try {
    const results = await env.DB.batch(statements);
    const taskChanges = Number(results && results[0] && results[0].meta && results[0].meta.changes || 0);
    if (taskChanges !== 1) {
      const raced = await exactExisting(env, app, taskId, ownerId, vendorName, delivery, identities, document);
      if (raced) return json({ ok: true, idempotent: true, task: raced }, 200, origin);
      if (!(await ownOrderStudentScopeStillValid(env, app, auth, selectedIds))) {
        return json({ ok: false, code: 'ORDER_STUDENT_SCOPE',
          error: '담당 수업이 변경되어 이 학생의 주문을 등록할 수 없습니다' }, 403, origin);
      }
      return json({ ok: false, code: 'ROSTER_REVISION_CONFLICT',
        error: '원생 명단이 주문 등록 중 변경되었습니다. 새로고침 후 다시 등록해 주세요' }, 409, origin);
    }
    const stored = await exactExisting(env, app, taskId, ownerId, vendorName, delivery, identities, document);
    if (!stored) {
      return json({ ok: false, code: 'ORDER_IDENTITY_MISMATCH',
        error: '교재 주문 원장의 정체성 확인이 필요합니다' }, 500, origin);
    }
  } catch (error) {
    const raced = await exactExisting(env, app, taskId, ownerId, vendorName, delivery, identities, document);
    if (raced) return json({ ok: true, idempotent: true, task: raced }, 200, origin);
    if (await hasActiveDuplicate(env, app, identities)) {
      return json({ ok: false, code: 'ORDER_ALREADY_ACTIVE',
        error: '같은 학생의 같은 교재 주문이 아직 완료되지 않았습니다' }, 409, origin);
    }
    if (/constraint|unique|primary|BOOK_ORDER_/i.test(String(error && error.message || error))) {
      return json({ ok: false, code: 'ORDER_ID_CONFLICT', error: '같은 주문 ID가 이미 다른 내용으로 사용되었습니다' }, 409, origin);
    }
    throw error;
  }
  return json({ ok: true, idempotent: false, task }, 201, origin);
}
