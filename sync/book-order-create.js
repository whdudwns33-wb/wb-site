import { validateRosterDocument } from './roster.js';
import { acquireBookOrderDispatchLock, releaseBookOrderDispatchLockSafely } from './book-order-lock.js';
import { MANUAL_ONLINE_DELIVERY, ONLINE_BOOK_VENDOR, resolveBookPublisher } from './book-order-vendors.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_ORDER_TASK_ID = /^ord_[A-Za-z0-9_-]{8,120}$/;
const MAX_ITEMS = 50;
const MAX_STUDENTS = 200;
const MAX_UNIT_PRICE = 10000000;
export const MAX_BOOK_ORDER_MESSAGE_BYTES = 2000;
const ALLOWED_KEYS = new Set(['app', 'auth', 'action', 'taskId', 'vendorName', 'items', 'expectedUpdatedAt']);
const ALLOWED_ITEM_KEYS = new Set(['bookId', 'title', 'studentIds', 'unitPrice', 'publisherName']);
const BOUND_ALLOWED_KEYS = new Set(['app', 'auth', 'action', 'taskId', 'productCode', 'title', 'studentIds']);
const BOUND_DELIVERY = 'bound_print_v1';
const BOUND_VENDOR = '제본교재';
const BOUND_PRODUCTS = Object.freeze({
  pages_1_30: Object.freeze({ label: '1~30 장 - 4,000원', unitPrice: 4000 }),
  pages_31_60: Object.freeze({ label: '31~60 장 - 7,000원', unitPrice: 7000 }),
  pages_61_90: Object.freeze({ label: '61~90 장 - 9,000원', unitPrice: 9000 }),
  exam_upto_30: Object.freeze({ label: '시험대비 (30장 이하) - 9,000원', unitPrice: 9000 }),
  exam_over_30: Object.freeze({ label: '시험대비 (31장 이상) - 15,000원', unitPrice: 15000 })
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

function kstDate(now) {
  return new Date(Number(now) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function buildBookOrderMessage(vendorName, items) {
  const lines = items.map(item => '· ' + item.title + ': ' + item.qty);
  return '안녕하세요, WB 웩슬러브레인센터(독해력학원)입니다.\n교재 주문 부탁드립니다.\n\n' +
    lines.join('\n') + '\n\n입고 예정일 회신 부탁드립니다. 감사합니다.';
}

function activeStudent(student, month) {
  return !!student && SAFE_ID.test(String(student.id || '')) &&
    (!student.start || String(student.start) <= month) &&
    (!student.end || String(student.end) > month);
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

/** Only a task outside the sealed namespace and without a seal marker may be a zero-row legacy order. */
export async function verifyOrderTaskSnapshotRows(
  taskId, owner, task, rows, document, now = Date.now(), requireCurrentEnrollment = true
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
  if (!task || task.deleted || !['scheduled_batch_v1', MANUAL_ONLINE_DELIVERY, BOUND_DELIVERY].includes(delivery) ||
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
      if (rosterById) {
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
  const rows = await loadOrderSnapshotRows(env, app, taskId);
  if (!rows.length) return verifyOrderTaskSnapshotRows(taskId, owner, task, rows, null, now);
  const roster = document === undefined ? await currentRoster(env, app) : document;
  if (!roster) return { sealed: true, valid: false, code: 'ORDER_STUDENT_IDENTITY_CHANGED' };
  return verifyOrderTaskSnapshotRows(taskId, owner, task, rows, roster, now);
}

function requestError(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return true;
  if (Object.keys(body).some(key => !ALLOWED_KEYS.has(key)) || body.action !== 'create') return true;
  if (Object.prototype.hasOwnProperty.call(body, 'expectedUpdatedAt') ||
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

function cancelRequestError(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.action !== 'cancel' ||
      Object.keys(body).some(key => !ALLOWED_KEYS.has(key))) return true;
  const expected = Number(body.expectedUpdatedAt);
  return !SAFE_ORDER_TASK_ID.test(String(body.taskId || '')) || !Number.isInteger(expected) || expected <= 0 ||
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

async function createBoundOrder(env, app, body, origin, auth, json) {
  if (app !== 'task' || boundRequestError(body)) {
    return json({ ok: false, code: 'ORDER_INVALID',
      error: '제본 종류·교재명·학생 선택을 다시 확인해 주세요' }, 400, origin);
  }
  const productCode = String(body.productCode);
  const product = BOUND_PRODUCTS[productCode];
  const title = text(body.title, 160, false).replace(/\s+/g, ' ');
  const studentIds = normalizedStudentIds({ studentIds: body.studentIds });
  const bookId = await boundBookId(productCode, title);
  const identity = await itemIdentity({ bookId, title, studentIds, unitPrice: product.unitPrice });
  if (!identity) {
    return json({ ok: false, code: 'ORDER_INVALID',
      error: '제본 종류·교재명·학생 선택을 다시 확인해 주세요' }, 400, origin);
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
  let existing;
  try {
    existing = await exactExistingBound(env, app, taskId, ownerId, productCode, identity, document);
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
  if (auth.scope === 'own' && studentIds.some(id => {
    const student = rosterById.get(id);
    return !Array.isArray(student.teacherIds) || !student.teacherIds.includes(auth.id);
  })) {
    return json({ ok: false, code: 'ORDER_STUDENT_SCOPE',
      error: '현재 담당 학생만 주문에 연결할 수 있습니다' }, 403, origin);
  }
  if (await hasActiveDuplicate(env, app, [identity])) {
    return json({ ok: false, code: 'ORDER_ALREADY_ACTIVE',
      error: '같은 학생의 같은 제본 교재 주문이 아직 완료되지 않았습니다' }, 409, origin);
  }

  const now = Date.now();
  const task = canonicalBoundTask(taskId, ownerId, productCode, product, identity, now);
  task.origin = originFor(auth);
  const taskHash = await taskIdentityHash(taskId, ownerId, BOUND_VENDOR, [identity]);
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
  const statements = [
    env.DB.prepare(
      'INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) SELECT ?,?,?,?,?,? ' +
      'WHERE EXISTS (SELECT 1 FROM private_rosters WHERE app=? AND data=? AND updated_at=?)'
    ).bind(app, taskId, ownerId || null, taskData, now, now,
      app, rosterRecord.rawData, rosterRecord.updatedAt),
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
      const raced = await exactExistingBound(env, app, taskId, ownerId, productCode, identity, document);
      if (raced) return json({ ok: true, idempotent: true, task: raced }, 200, origin);
      return json({ ok: false, code: 'ROSTER_REVISION_CONFLICT',
        error: '원생 명단이 주문 등록 중 변경되었습니다. 새로고침 후 다시 등록해 주세요' }, 409, origin);
    }
    const stored = await exactExistingBound(env, app, taskId, ownerId, productCode, identity, document);
    if (snapshotChanges !== studentIds.length || fulfillmentChanges !== 1 || !stored) {
      return json({ ok: false, code: 'ORDER_IDENTITY_MISMATCH',
        error: '제본 교재 주문 원장의 정체성 확인이 필요합니다' }, 500, origin);
    }
  } catch (error) {
    const raced = await exactExistingBound(env, app, taskId, ownerId, productCode, identity, document);
    if (raced) return json({ ok: true, idempotent: true, task: raced }, 200, origin);
    if (await hasActiveDuplicate(env, app, [identity])) {
      return json({ ok: false, code: 'ORDER_ALREADY_ACTIVE',
        error: '같은 학생의 같은 제본 교재 주문이 아직 완료되지 않았습니다' }, 409, origin);
    }
    if (/constraint|unique|primary|BOOK_ORDER_/i.test(String(error && error.message || error))) {
      return json({ ok: false, code: 'ORDER_ID_CONFLICT',
        error: '같은 주문 ID가 이미 다른 내용으로 사용되었습니다' }, 409, origin);
    }
    throw error;
  }
  return json({ ok: true, idempotent: false, task }, 201, origin);
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
      "AND (item.task_id=? OR (send.task_id=? AND send.task_id LIKE 'ord_%')) " +
      "AND send.status IN ('reserved','dispatching','accepted','unknown') LIMIT 1"
    ).bind(app, taskId, taskId).first();
    if (active) {
      return json({ ok: false, code: 'ORDER_CANCEL_SEND_ACTIVE', error: '이미 발송 중이거나 접수된 주문은 취소할 수 없습니다' }, 409, origin);
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
  if (body && body.action === 'create_bound') return createBoundOrder(env, app, body, origin, auth, json);
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
  if (auth.scope === 'own' && selectedIds.some(id => {
    const student = rosterById.get(id);
    return !Array.isArray(student.teacherIds) || !student.teacherIds.includes(auth.id);
  })) return json({ ok: false, code: 'ORDER_STUDENT_SCOPE', error: '현재 담당 학생만 주문에 연결할 수 있습니다' }, 403, origin);

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
  const statements = [
    env.DB.prepare(
      'INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) SELECT ?,?,?,?,?,? ' +
      'WHERE EXISTS (SELECT 1 FROM private_rosters WHERE app=? AND data=? AND updated_at=?)'
    ).bind(app, taskId, ownerId || null, taskData, now, now,
      app, rosterRecord.rawData, rosterRecord.updatedAt),
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
