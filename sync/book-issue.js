import { validateRosterDocument } from './roster.js';
import {
  INTERNAL_BOOK_DELIVERY,
  cancelledOrderItemIndexes,
  loadOrderItemCancellationRows,
  loadOrderSnapshotRows,
  verifyOrderTaskSnapshotRows
} from './book-order-create.js';
import { acquireBookOrderDispatchLock, releaseBookOrderDispatchLockSafely } from './book-order-lock.js';
import { MANUAL_ONLINE_DELIVERY, ONLINE_BOOK_VENDOR } from './book-order-vendors.js';
import { bookOrderStudentIdsForAuth, ownBookStudentWriteGuard } from './book-order-student-scope.js';
import {
  completedCatalogInsertStatement,
  completedCatalogRecord,
  verifyCompletedCatalogEntry
} from './completed-book-catalog.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const STATES = new Set(['prepared', 'issued', 'handed', 'cancelled']);
const NEXT = new Set([...STATES, 'reissue']);
const ORDER_NEXT = new Set(['receive', 'hand', 'academy_register']);
const IMMEDIATE_RECEIPT_DELIVERIES = new Set(['bound_print_v1', INTERNAL_BOOK_DELIVERY]);
const ORDER_DELIVERIES = new Set([
  'scheduled_batch_v1', MANUAL_ONLINE_DELIVERY, ...IMMEDIATE_RECEIPT_DELIVERIES
]);
const MAX_UNIT_PRICE = 10000000;
const KIM_NAMGI_STAFF_ID = '84349fea-f2f0-4fc3-b32a-aaef1e466d54';
const WORDMASTER_BASIC_TITLE = '워드마스터중등베이직';

function cleanReason(value) {
  const reason = String(value || '').trim();
  if (reason.length > 300 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason)) return null;
  return reason;
}

function normalizedName(value) {
  return String(value || '').normalize('NFKC').trim();
}

async function identityHash(studentId, studentName) {
  return sha256Hex(String(studentId) + '\n' + normalizedName(studentName));
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value == null ? '' : value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function currentRoster(env, app) {
  const row = await env.DB.prepare('SELECT data FROM private_rosters WHERE app=? LIMIT 1').bind(app).first();
  if (!row) return null;
  try { return validateRosterDocument(JSON.parse(row.data)); }
  catch (error) { throw new Error('저장된 원생 데이터 형식이 올바르지 않습니다'); }
}

function parseHistory(value) {
  try {
    const history = JSON.parse(value || '[]');
    return Array.isArray(history) ? history : [];
  } catch (error) { return []; }
}

function actorId(auth) {
  return auth.id || 'director';
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); }
  catch (error) { return fallback; }
}

function orderStudentIds(item) {
  if (!item || !Array.isArray(item.studentIds)) return [];
  return Array.from(new Set(item.studentIds.map(value => String(value || '')).filter(id => SAFE_ID.test(id)))).sort();
}

function validOrderStudentSelection(item, studentIds) {
  return !!item && Array.isArray(item.studentIds) && item.studentIds.length === studentIds.length && studentIds.length <= 200;
}

function orderQuantity(item, studentIds) {
  if (studentIds.length) return studentIds.length;
  const match = String(item && item.qty || '').match(/\d+/);
  return Math.max(1, Math.min(999, Number(match && match[0]) || 1));
}

function orderUnitPrice(item) {
  const value = Number(item && item.unitPrice);
  return Number.isInteger(value) && value >= 1 && value <= MAX_UNIT_PRICE ? value : null;
}

function storedOrderUnitPrice(item, priceRow, correctionRow) {
  const taskPrice = orderUnitPrice(item);
  if (taskPrice !== null) return taskPrice;
  const original = Number(priceRow && priceRow.unit_price);
  if (!Number.isInteger(original) || original < 1 || original > MAX_UNIT_PRICE) return null;
  const previous = Number(correctionRow && correctionRow.previous_unit_price);
  const corrected = Number(correctionRow && correctionRow.corrected_unit_price);
  if (previous === original && Number.isInteger(corrected) && corrected >= 1 && corrected <= MAX_UNIT_PRICE && corrected !== original) {
    return corrected;
  }
  return original;
}

function normalizedBookTitle(value) {
  return normalizedName(value).replace(/\s+/g, '');
}

function canSetLegacyOrderPrice(owner, item, send, fulfillment, integrity, storedPrice) {
  if (String(owner || '') !== KIM_NAMGI_STAFF_ID || orderUnitPrice(item) !== null || storedPrice !== null || integrity) return false;
  if (!send || String(send.status) !== 'accepted') return false;
  if (fulfillment && ['student_handed', 'academy_registered'].includes(String(fulfillment.status))) return true;
  return !fulfillment && normalizedBookTitle(item && item.title) === WORDMASTER_BASIC_TITLE;
}

function orderTaskData(row) {
  const task = parseJson(row && row.data || '{}', null);
  if (!task || task.deleted || !String(task.title || '').startsWith('[주문] ') ||
      !ORDER_DELIVERIES.has(String(task.orderDelivery || '')) || !Array.isArray(task.orderItems)) return null;
  return task;
}

async function latestOrderSend(env, app, taskId) {
  return await env.DB.prepare(
    'SELECT s.* FROM book_order_sends s LEFT JOIN book_order_batch_items i ' +
    'ON i.app=s.app AND i.send_id=s.send_id WHERE s.app=? AND (i.task_id=? OR ' +
    "(s.task_id=? AND s.task_id NOT LIKE 'batch_%' AND s.task_id NOT LIKE 'retry_%' " +
      "AND s.task_id NOT LIKE 'sample:%')) " +
    'ORDER BY s.created_at DESC LIMIT 1'
  ).bind(app, taskId, taskId).first();
}

async function orderItemCancellation(env, app, taskId, itemIndex) {
  return await env.DB.prepare(
    'SELECT book_id,cancelled_at FROM book_order_item_cancellations WHERE app=? AND task_id=? AND item_index=? LIMIT 1'
  ).bind(app, taskId, itemIndex).first();
}

function fulfillmentMatches(row, bookId, studentIds) {
  if (!row) return true;
  const storedIds = parseJson(row.student_ids || '[]', []).map(String).sort();
  return String(row.book_id) === bookId && JSON.stringify(storedIds) === JSON.stringify(studentIds);
}

function publicOrderFulfillment(taskId, itemIndex, item, vendorName, owner, teacherName, students, send, row, priceRow, correctionRow, integrity,
    taskCreatedAt, taskUpdatedAt, needsStudentLink, canLinkStudents, orderDelivery, cancelledAt) {
  const immediateReceipt = IMMEDIATE_RECEIPT_DELIVERIES.has(String(orderDelivery || ''));
  const studentIds = orderStudentIds(item);
  const unitPrice = storedOrderUnitPrice(item, priceRow, correctionRow);
  let stage = !send ? 'order_waiting' : send.status === 'accepted' ? 'ordered'
    : send.status === 'rejected' ? 'order_failed' : 'order_check';
  if (row && !integrity) {
    if (row.status === 'teacher_received') stage = 'teacher_received';
    if (row.status === 'student_handed' || row.status === 'academy_registered') stage = 'student_handed';
  }
  if (cancelledAt) stage = 'cancelled';
  return {
    taskId, itemIndex, bookId: String(item.bookId || ''), title: String(item.title || '교재명 미입력'),
    publisherName: Object.prototype.hasOwnProperty.call(item || {}, 'publisherName') ? String(item.publisherName || '') : '',
    orderDelivery: String(orderDelivery || ''),
    quantity: orderQuantity(item, studentIds), vendorName: String(vendorName || '주문처 미등록'),
    unitPrice,
    priceBackfilledAt: priceRow && priceRow.created_at ? Number(priceRow.created_at) : null,
    priceCorrectedAt: correctionRow && correctionRow.created_at ? Number(correctionRow.created_at) : null,
    canSetUnitPrice: canSetLegacyOrderPrice(owner, item, send, row, integrity, unitPrice),
    owner: owner || null, teacherName: teacherName || (owner ? '담당 미지정' : '관리자'),
    students, sendStatus: send ? String(send.status) : immediateReceipt ? 'accepted' : 'waiting', stage,
    taskUpdatedAt: Number(taskUpdatedAt) || 0,
    orderRequestedAt: Number(taskCreatedAt) || Number(taskUpdatedAt) || null,
    orderCompletedAt: immediateReceipt ? Number(taskCreatedAt) || Number(taskUpdatedAt) || null
      : send && String(send.status) === 'accepted' ? Number(send.updated_at || send.created_at) || null : null,
    needsStudentLink: !!needsStudentLink,
    canLinkStudents: !!canLinkStudents,
    revision: row ? Number(row.revision) : 0,
    teacherReceivedAt: row && row.teacher_received_at ? Number(row.teacher_received_at) : null,
    studentHandedAt: row && row.student_handed_at ? Number(row.student_handed_at) : null,
    academyRegisteredAt: row && row.academy_registered_at ? Number(row.academy_registered_at) : null,
    orderCancelledAt: cancelledAt ? Number(cancelledAt) : null,
    integrity: integrity || ''
  };
}

async function listOrderFulfillments(env, app, auth, document) {
  const [tasksResult, sendsResult, mappingsResult, fulfillmentsResult, pricesResult, correctionsResult, staffResult, snapshotResult,
    itemCancellationResult] = await Promise.all([
    env.DB.prepare('SELECT id,owner,data,updated_at FROM tasks WHERE app=? ORDER BY updated_at DESC').bind(app).all(),
    env.DB.prepare('SELECT * FROM book_order_sends WHERE app=? ORDER BY created_at DESC').bind(app).all(),
    env.DB.prepare('SELECT task_id,send_id FROM book_order_batch_items WHERE app=?').bind(app).all(),
    env.DB.prepare('SELECT * FROM book_order_fulfillments WHERE app=?').bind(app).all(),
    env.DB.prepare('SELECT task_id,item_index,unit_price,created_at FROM book_order_item_prices WHERE app=?').bind(app).all(),
    env.DB.prepare('SELECT task_id,item_index,previous_unit_price,corrected_unit_price,created_at FROM book_order_item_price_corrections WHERE app=?').bind(app).all(),
    env.DB.prepare('SELECT id,data FROM staff WHERE app=?').bind(app).all(),
    env.DB.prepare('SELECT * FROM book_order_student_snapshots WHERE app=? ORDER BY task_id,item_index,student_id').bind(app).all(),
    env.DB.prepare('SELECT task_id,item_index,book_id,cancelled_at FROM book_order_item_cancellations WHERE app=?').bind(app).all()
  ]);
  const sendsById = new Map((sendsResult.results || []).map(row => [String(row.send_id), row]));
  const mappedSendIds = new Set((mappingsResult.results || []).map(row => String(row.send_id || '')));
  const sendByTask = new Map();
  for (const row of sendsResult.results || []) {
    const taskId = String(row.task_id || '');
    if (mappedSendIds.has(String(row.send_id || '')) || /^(?:batch_|retry_)|^sample:/.test(taskId)) continue;
    if (!sendByTask.has(taskId)) sendByTask.set(taskId, row);
  }
  for (const mapping of mappingsResult.results || []) {
    const send = sendsById.get(String(mapping.send_id));
    const taskId = String(mapping.task_id);
    const current = sendByTask.get(taskId);
    if (send && (!current || Number(send.created_at || 0) > Number(current.created_at || 0) ||
        (Number(send.created_at || 0) === Number(current.created_at || 0) &&
          Number(send.updated_at || 0) > Number(current.updated_at || 0)))) sendByTask.set(taskId, send);
  }
  const fulfillmentByItem = new Map((fulfillmentsResult.results || []).map(row => [String(row.task_id) + '|' + Number(row.item_index), row]));
  const priceByItem = new Map((pricesResult.results || []).map(row => [String(row.task_id) + '|' + Number(row.item_index), row]));
  const correctionByItem = new Map((correctionsResult.results || []).map(row => [String(row.task_id) + '|' + Number(row.item_index), row]));
  const cancellationByItem = new Map((itemCancellationResult.results || []).map(row => [
    String(row.task_id) + '|' + Number(row.item_index), row
  ]));
  const staffNames = new Map((staffResult.results || []).map(row => {
    const data = parseJson(row.data || '{}', {});
    return [String(row.id), String(data.name || row.id)];
  }));
  const studentsById = new Map(document.roster.students.map(student => [String(student.id), student]));
  const allowedStudentIds = await bookOrderStudentIdsForAuth(env, app, document, auth);
  const rows = [];
  for (const taskRow of tasksResult.results || []) {
    if (auth.scope === 'own' && String(taskRow.owner || '') !== auth.id) continue;
    const task = orderTaskData(taskRow);
    if (!task) continue;
    const cancelledIndexes = cancelledOrderItemIndexes(itemCancellationResult.results || [], taskRow.id);
    const send = sendByTask.get(String(taskRow.id)) || null;
    const immediateReceipt = IMMEDIATE_RECEIPT_DELIVERIES.has(String(task.orderDelivery || ''));
    const accepted = immediateReceipt || (!!send && String(send.status) === 'accepted');
    const sealedIdentity = await verifyOrderTaskSnapshotRows(
      String(taskRow.id), taskRow.owner, task, snapshotResult.results || [], document, Date.now(),
      !accepted, cancelledIndexes
    );
    for (let itemIndex = 0; itemIndex < task.orderItems.length; itemIndex++) {
      const item = task.orderItems[itemIndex] || {};
      const studentIds = orderStudentIds(item);
      const invalidSelection = Array.isArray(item.studentIds) && !validOrderStudentSelection(item, studentIds);
      const unauthorized = auth.scope === 'own' && studentIds.some(id => !allowedStudentIds.has(id));
      const missing = studentIds.some(id => !studentsById.has(id));
      const fulfillment = fulfillmentByItem.get(String(taskRow.id) + '|' + itemIndex) || null;
      const priceRow = priceByItem.get(String(taskRow.id) + '|' + itemIndex) || null;
      const correctionRow = correctionByItem.get(String(taskRow.id) + '|' + itemIndex) || null;
      const cancellation = cancellationByItem.get(String(taskRow.id) + '|' + itemIndex) || null;
      const cancelled = !!cancellation;
      const identityMismatch = !fulfillmentMatches(fulfillment, String(item.bookId || ''), studentIds);
      const integrity = cancelled ? '' : sealedIdentity.sealed && !sealedIdentity.valid ? 'identity_mismatch' :
        invalidSelection ? 'student_invalid' : unauthorized ? 'student_scope' : missing ? 'student_missing' : identityMismatch ? 'identity_mismatch' : '';
      const needsStudentLink = !cancelled && (!String(item.bookId || '') || !studentIds.length || invalidSelection || unauthorized || missing);
      const canLinkStudents = !cancelled && !integrity && !fulfillment && !!send && String(send.status) === 'accepted' && needsStudentLink;
      const students = integrity || cancelled ? [] : studentIds.map(id => studentsById.get(id)).filter(Boolean).map(student => ({
        id: String(student.id), name: String(student.name || '이름 미입력'),
        school: String(student.school || ''), grade: String(student.grade || '')
      }));
      rows.push(publicOrderFulfillment(String(taskRow.id), itemIndex, item, task.orderVendor, String(taskRow.owner || ''),
        staffNames.get(String(taskRow.owner || '')), students, send, fulfillment, priceRow, correctionRow, integrity,
        task.createdAt, taskRow.updated_at, needsStudentLink, canLinkStudents, task.orderDelivery,
        cancellation && cancellation.cancelled_at));
    }
  }
  return rows;
}

async function setLegacyOrderPrice(env, app, body, auth, json, origin) {
  const taskId = String(body.taskId || '');
  const itemIndex = Number(body.itemIndex);
  const unitPrice = Number(body.unitPrice);
  if (!SAFE_ID.test(taskId) || !Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex > 49 ||
      !Number.isInteger(unitPrice) || unitPrice < 1 || unitPrice > MAX_UNIT_PRICE) {
    return json({ ok: false, error: 'taskId, itemIndex, unitPrice를 확인해 주세요' }, 400, origin);
  }

  const taskRow = await env.DB.prepare('SELECT id,owner,data FROM tasks WHERE app=? AND id=? LIMIT 1')
    .bind(app, taskId).first();
  const task = orderTaskData(taskRow);
  if (!task || !task.orderItems[itemIndex]) return json({ ok: false, error: '현재 주문 항목을 찾을 수 없습니다' }, 404, origin);
  if (auth.scope === 'own' && String(taskRow.owner || '') !== auth.id) {
    return json({ ok: false, error: '본인이 주문한 교재 금액만 처리할 수 있습니다' }, 403, origin);
  }
  if (await orderItemCancellation(env, app, taskId, itemIndex)) {
    return json({ ok: false, code: 'ORDER_ITEM_CANCELLED', error: '취소된 교재 주문은 처리할 수 없습니다' }, 409, origin);
  }
  if (String(taskRow.owner || '') !== KIM_NAMGI_STAFF_ID) {
    return json({ ok: false, code: 'ORDER_PRICE_NOT_ELIGIBLE', error: '1회성 금액 입력 대상 주문이 아닙니다' }, 409, origin);
  }

  const item = task.orderItems[itemIndex];
  if (orderUnitPrice(item) !== null) {
    return json({ ok: false, code: 'ORDER_PRICE_ALREADY_SET', error: '이미 교재 금액이 기록된 주문입니다' }, 409, origin);
  }
  const existing = await env.DB.prepare(
    'SELECT p.unit_price,p.created_at,c.previous_unit_price,c.corrected_unit_price,c.created_at AS corrected_at ' +
    'FROM book_order_item_prices p LEFT JOIN book_order_item_price_corrections c ' +
    'ON c.app=p.app AND c.task_id=p.task_id AND c.item_index=p.item_index ' +
    'WHERE p.app=? AND p.task_id=? AND p.item_index=? LIMIT 1'
  ).bind(app, taskId, itemIndex).first();
  if (existing) {
    const effectivePrice = storedOrderUnitPrice(null, existing, existing);
    if (effectivePrice === unitPrice) {
      return json({ ok: true, idempotent: true, unitPrice, createdAt: Number(existing.corrected_at || existing.created_at) }, 200, origin);
    }
    return json({ ok: false, code: 'ORDER_PRICE_ALREADY_SET', error: '교재 금액은 한 번 저장한 뒤 변경할 수 없습니다' }, 409, origin);
  }

  const [send, fulfillment] = await Promise.all([
    latestOrderSend(env, app, taskId),
    env.DB.prepare('SELECT * FROM book_order_fulfillments WHERE app=? AND task_id=? AND item_index=? LIMIT 1')
      .bind(app, taskId, itemIndex).first()
  ]);
  if (!fulfillmentMatches(fulfillment, String(item.bookId || ''), orderStudentIds(item)) ||
      !canSetLegacyOrderPrice(taskRow.owner, item, send, fulfillment, '', null)) {
    return json({ ok: false, code: 'ORDER_PRICE_NOT_ELIGIBLE', error: '1회성 금액 입력 대상 주문이 아닙니다' }, 409, origin);
  }

  const now = Date.now();
  const actor = actorId(auth);
  if (!SAFE_ID.test(actor)) return json({ ok: false, error: '처리자 정보를 확인해 주세요' }, 403, origin);
  await env.DB.prepare(
    'INSERT OR IGNORE INTO book_order_item_prices(app,task_id,item_index,unit_price,created_at,created_by) VALUES(?,?,?,?,?,?)'
  ).bind(app, taskId, itemIndex, unitPrice, now, actor).run();
  const stored = await env.DB.prepare(
    'SELECT unit_price,created_at FROM book_order_item_prices WHERE app=? AND task_id=? AND item_index=? LIMIT 1'
  ).bind(app, taskId, itemIndex).first();
  if (stored && Number(stored.unit_price) === unitPrice) {
    return json({ ok: true, idempotent: Number(stored.created_at) !== now, unitPrice, createdAt: Number(stored.created_at) }, 200, origin);
  }
  return json({ ok: false, code: 'ORDER_PRICE_ALREADY_SET', error: '다른 기기에서 교재 금액이 먼저 저장되었습니다' }, 409, origin);
}

async function linkOrderStudents(env, app, body, auth, json, origin) {
  const taskId = String(body.taskId || '');
  const itemIndex = Number(body.itemIndex);
  const bookId = String(body.bookId || '');
  const expectedUpdatedAt = Number(body.expectedUpdatedAt);
  const requestedIds = Array.isArray(body.studentIds) ? body.studentIds.map(value => String(value || '')) : [];
  const studentIds = Array.from(new Set(requestedIds.filter(id => SAFE_ID.test(id)))).sort();
  if (!SAFE_ID.test(taskId) || !Number.isInteger(itemIndex) || itemIndex < 0 || !SAFE_ID.test(bookId) ||
      !Number.isInteger(expectedUpdatedAt) || expectedUpdatedAt < 0 || !requestedIds.length || requestedIds.length > 200 ||
      requestedIds.length !== studentIds.length) {
    return json({ ok: false, error: 'taskId, itemIndex, bookId, studentIds, expectedUpdatedAt을 확인해 주세요' }, 400, origin);
  }

  const taskRow = await env.DB.prepare('SELECT id,owner,data,updated_at FROM tasks WHERE app=? AND id=? LIMIT 1')
    .bind(app, taskId).first();
  const task = orderTaskData(taskRow);
  if (!task || !task.orderItems[itemIndex]) return json({ ok: false, error: '현재 주문 항목을 찾을 수 없습니다' }, 404, origin);
  if (auth.scope === 'own' && String(taskRow.owner || '') !== auth.id) {
    return json({ ok: false, error: '본인이 주문한 교재만 처리할 수 있습니다' }, 403, origin);
  }

  if (await orderItemCancellation(env, app, taskId, itemIndex)) {
    return json({ ok: false, code: 'ORDER_ITEM_CANCELLED', error: '취소된 교재 주문은 처리할 수 없습니다' }, 409, origin);
  }

  const item = task.orderItems[itemIndex];
  const currentBookId = String(item.bookId || '');
  if (currentBookId && currentBookId !== bookId) {
    return json({ ok: false, code: 'ORDER_BOOK_MISMATCH', error: '기존 주문의 교재 연결은 다른 교재로 변경할 수 없습니다' }, 409, origin);
  }
  const fulfillment = await env.DB.prepare(
    'SELECT task_id FROM book_order_fulfillments WHERE app=? AND task_id=? AND item_index=? LIMIT 1'
  ).bind(app, taskId, itemIndex).first();
  if (fulfillment) {
    return json({ ok: false, code: 'ORDER_ALREADY_RECEIVED', error: '이미 수령 처리가 시작된 주문의 학생 연결은 변경할 수 없습니다' }, 409, origin);
  }
  const send = await latestOrderSend(env, app, taskId);
  if (!send || String(send.status) !== 'accepted') {
    return json({ ok: false, code: 'ORDER_NOT_ACCEPTED', error: '주문완료가 확인된 교재만 학생을 연결할 수 있습니다' }, 409, origin);
  }

  const document = await currentRoster(env, app);
  if (!document) return json({ ok: false, error: '원생 데이터가 아직 등록되지 않았습니다' }, 404, origin);
  const studentsById = new Map(document.roster.students.map(student => [String(student.id), student]));
  if (studentIds.some(id => !studentsById.has(id))) {
    return json({ ok: false, code: 'ORDER_STUDENT_MISSING', error: '선택한 학생이 현재 원생 명단에 없어 다시 확인해 주세요' }, 409, origin);
  }
  const allowedStudentIds = await bookOrderStudentIdsForAuth(env, app, document, auth);
  if (auth.scope === 'own' && studentIds.some(id => !allowedStudentIds.has(id))) {
    return json({ ok: false, error: '현재 본인이 담당하는 수업 학생만 주문에 연결할 수 있습니다' }, 403, origin);
  }

  const snapshots = await loadOrderSnapshotRows(env, app, taskId);
  const sealedIdentity = await verifyOrderTaskSnapshotRows(
    taskId, taskRow.owner, task, snapshots, document, Date.now(), false
  );
  if (sealedIdentity.sealed) {
    const currentIds = orderStudentIds(item);
    if (sealedIdentity.valid && currentBookId === bookId && validOrderStudentSelection(item, currentIds) &&
        JSON.stringify(currentIds) === JSON.stringify(studentIds)) {
      return json({ ok: true, idempotent: true, taskUpdatedAt: Number(taskRow.updated_at) || 0 }, 200, origin);
    }
    return json({ ok: false, code: 'ORDER_IDENTITY_MISMATCH', error: '봉인된 주문의 학생·교재 연결은 변경할 수 없습니다' }, 409, origin);
  }

  const currentIds = orderStudentIds(item);
  if (currentBookId === bookId && validOrderStudentSelection(item, currentIds) &&
      JSON.stringify(currentIds) === JSON.stringify(studentIds)) {
    return json({ ok: true, idempotent: true, taskUpdatedAt: Number(taskRow.updated_at) || 0 }, 200, origin);
  }
  if (Number(taskRow.updated_at) !== expectedUpdatedAt) {
    return json({ ok: false, code: 'REVISION_CONFLICT', error: '다른 기기에서 주문이 먼저 변경되었습니다. 새로고침 후 다시 연결해 주세요' }, 409, origin);
  }

  const now = Date.now();
  const nextTask = { ...task, orderItems: task.orderItems.slice(), updatedAt: now,
    lastEditBy: auth.role === 'manager' ? 'manager' : auth.scope === 'all' ? 'admin' : 'staff' };
  nextTask.orderItems[itemIndex] = { ...item, bookId, studentIds, qty: studentIds.length + '권' };
  const studentGuard = ownBookStudentWriteGuard(auth, app, studentIds, now);
  const ownerGuard = ownOrderOwnerWriteGuard(auth, app, taskId);
  const updated = await env.DB.prepare(
    'UPDATE tasks SET data=?,updated_at=?,srv_at=? WHERE app=? AND id=? AND updated_at=?' +
    ownerGuard.sql + studentGuard.sql
  ).bind(JSON.stringify(nextTask), now, now, app, taskId, expectedUpdatedAt,
    ...ownerGuard.binds, ...studentGuard.binds).run();
  if (!updated.meta || Number(updated.meta.changes || 0) !== 1) {
    if (!(await ownOrderMutationStillValid(env, app, auth, taskId, studentIds))) {
      return json({ ok: false, code: 'ORDER_STUDENT_SCOPE',
        error: '담당 수업 또는 주문 담당자가 변경되어 학생을 연결할 수 없습니다' }, 403, origin);
    }
    return json({ ok: false, code: 'REVISION_CONFLICT', error: '다른 기기에서 주문이 먼저 변경되었습니다. 새로고침 후 다시 연결해 주세요' }, 409, origin);
  }
  return json({ ok: true, idempotent: false, taskUpdatedAt: now }, 200, origin);
}

function publicIssue(assignment, student, row) {
  const base = {
    assignmentId: assignment.id,
    studentId: assignment.studentId,
    studentName: student.name,
    grade: student.grade,
    bookId: assignment.bookId,
    status: row ? row.status : 'none',
    cycle: row ? Number(row.cycle) : 0,
    revision: row ? Number(row.revision) : 0,
    preparedAt: row && row.prepared_at ? Number(row.prepared_at) : null,
    preparedBy: row ? row.prepared_by || null : null,
    issuedAt: row && row.issued_at ? Number(row.issued_at) : null,
    issuedBy: row ? row.issued_by || null : null,
    handedAt: row && row.handed_at ? Number(row.handed_at) : null,
    handedBy: row ? row.handed_by || null : null,
    cancelledAt: row && row.cancelled_at ? Number(row.cancelled_at) : null,
    cancelledBy: row ? row.cancelled_by || null : null,
    updatedAt: row && row.updated_at ? Number(row.updated_at) : null,
    cancelReason: row ? row.cancel_reason || '' : '',
    reissueReason: row ? row.reissue_reason || '' : '',
    history: row ? parseHistory(row.history) : []
  };
  return base;
}

function publicIntegrityIssue(row, student, integrity) {
  return {
    assignmentId: String(row.assignment_id),
    studentId: String(row.student_id),
    studentName: student ? student.name : '학생 연결 확인 필요',
    grade: student ? student.grade : '',
    bookId: String(row.book_id),
    status: String(row.status),
    cycle: Number(row.cycle),
    revision: Number(row.revision),
    preparedAt: row.prepared_at ? Number(row.prepared_at) : null,
    preparedBy: row.prepared_by || null,
    issuedAt: row.issued_at ? Number(row.issued_at) : null,
    issuedBy: row.issued_by || null,
    handedAt: row.handed_at ? Number(row.handed_at) : null,
    handedBy: row.handed_by || null,
    cancelledAt: row.cancelled_at ? Number(row.cancelled_at) : null,
    cancelledBy: row.cancelled_by || null,
    updatedAt: Number(row.updated_at),
    cancelReason: row.cancel_reason || '',
    reissueReason: row.reissue_reason || '',
    history: parseHistory(row.history),
    integrity
  };
}

function latestIsDuplicate(row, next, revision, reason) {
  if (!row || Number(row.revision) !== revision + 1) return false;
  const history = parseHistory(row.history);
  const last = history[history.length - 1];
  return !!last && last.action === next && String(last.reason || '') === String(reason || '');
}

function sameIdentity(row, assignment, hash) {
  return !!row && String(row.student_id) === assignment.studentId && String(row.book_id) === assignment.bookId &&
    String(row.student_identity_hash) === hash;
}

async function listIssues(env, app, auth, json, origin) {
  const document = await currentRoster(env, app);
  if (!document) return json({ ok: false, error: '원생 데이터가 아직 등록되지 않았습니다' }, 404, origin);
  const result = await env.DB.prepare('SELECT * FROM book_issues WHERE app=? ORDER BY updated_at DESC').bind(app).all();
  const stored = new Map((result.results || []).map(row => [String(row.assignment_id), row]));
  const students = new Map(document.roster.students.map(student => [student.id, student]));
  const assignments = new Map(document.bookStudents.map(item => [item.id, item]));
  const allowedStudentIds = await bookOrderStudentIdsForAuth(env, app, document, auth);
  const issues = [];
  const warnings = [];

  for (const assignment of document.bookStudents) {
    if (auth.scope === 'own' &&
        (!assignment.teacherIds.includes(auth.id) || !allowedStudentIds.has(String(assignment.studentId)))) continue;
    const student = students.get(assignment.studentId);
    const row = stored.get(assignment.id);
    if (row) {
      const hash = await identityHash(student.id, student.name);
      if (String(row.student_id) !== assignment.studentId || String(row.book_id) !== assignment.bookId ||
          String(row.student_identity_hash) !== hash) {
        if (auth.scope === 'all') {
          warnings.push({
            code: 'ASSIGNMENT_IDENTITY_MISMATCH', assignmentId: assignment.id,
            message: '교재 배정 ID의 학생 또는 교재 정체성이 출고 이력과 다릅니다.'
          });
          const storedStudent = students.get(String(row.student_id));
          const storedHashMatches = storedStudent && await identityHash(storedStudent.id, storedStudent.name) === String(row.student_identity_hash);
          issues.push(publicIntegrityIssue(row, storedHashMatches ? storedStudent : null, 'mismatch'));
        }
        continue;
      }
    }
    issues.push(publicIssue(assignment, student, row));
  }

  if (auth.scope === 'all') {
    for (const row of stored.values()) {
      if (!assignments.has(String(row.assignment_id))) {
        warnings.push({
          code: 'ORPHAN_BOOK_ISSUE', assignmentId: String(row.assignment_id), status: String(row.status),
          message: '현재 원생 명단에서 사라진 교재 배정의 출고 이력입니다.'
        });
        const storedStudent = students.get(String(row.student_id));
        const storedHashMatches = storedStudent && await identityHash(storedStudent.id, storedStudent.name) === String(row.student_identity_hash);
        issues.push(publicIntegrityIssue(row, storedHashMatches ? storedStudent : null, 'orphan'));
      }
    }
  }
  const orders = await listOrderFulfillments(env, app, auth, document);
  return json({ ok: true, issues, warnings, orders }, 200, origin);
}

async function ownOrderStudentScopeStillValid(env, app, auth, studentIds) {
  if (!auth || auth.scope !== 'own') return true;
  const document = await currentRoster(env, app);
  if (!document) return false;
  const allowed = await bookOrderStudentIdsForAuth(env, app, document, auth);
  return studentIds.every(studentId => allowed.has(String(studentId)));
}

async function ownOrderMutationStillValid(env, app, auth, taskId, studentIds) {
  if (!auth || auth.scope !== 'own') return true;
  const row = await env.DB.prepare('SELECT owner FROM tasks WHERE app=? AND id=? LIMIT 1')
    .bind(app, taskId).first();
  return !!row && String(row.owner || '') === String(auth.id || '') &&
    await ownOrderStudentScopeStillValid(env, app, auth, studentIds);
}

function ownOrderOwnerWriteGuard(auth, app, taskId) {
  if (!auth || auth.scope !== 'own') return { sql: '', binds: [] };
  return {
    sql: ' AND EXISTS (SELECT 1 FROM tasks owned_order WHERE owned_order.app=? ' +
      'AND owned_order.id=? AND owned_order.owner=?)',
    binds: [app, taskId, String(auth.id || '')]
  };
}

function ownLegacyAssignmentWriteGuard(auth, app, assignment) {
  if (!auth || auth.scope !== 'own') return { sql: '', binds: [] };
  return {
    sql: ' AND EXISTS (SELECT 1 FROM private_rosters current_roster, ' +
      "json_each(current_roster.data,'$.bookStudents') current_assignment, " +
      "json_each(current_assignment.value,'$.teacherIds') current_teacher " +
      'WHERE current_roster.app=? AND json_valid(current_roster.data) ' +
      "AND CAST(json_extract(current_assignment.value,'$.id') AS TEXT)=? " +
      "AND CAST(json_extract(current_assignment.value,'$.studentId') AS TEXT)=? " +
      "AND CAST(json_extract(current_assignment.value,'$.bookId') AS TEXT)=? " +
      'AND CAST(current_teacher.value AS TEXT)=?)',
    binds: [app, String(assignment.id), String(assignment.studentId), String(assignment.bookId), String(auth.id || '')]
  };
}

async function ownLegacyAssignmentStillValid(env, app, auth, assignment) {
  if (!auth || auth.scope !== 'own') return true;
  const document = await currentRoster(env, app);
  if (!document) return false;
  const current = document.bookStudents.find(item => item.id === assignment.id &&
    item.studentId === assignment.studentId && item.bookId === assignment.bookId);
  if (!current || !Array.isArray(current.teacherIds) || !current.teacherIds.includes(auth.id)) return false;
  const allowed = await bookOrderStudentIdsForAuth(env, app, document, auth);
  return allowed.has(String(assignment.studentId));
}

async function setManualOnlineResult(env, app, body, auth, json, origin) {
  const allowed = new Set(['app', 'auth', 'action', 'taskId', 'result', 'revision']);
  const taskId = String(body && body.taskId || '');
  const result = String(body && body.result || '');
  const revision = body && body.revision;
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !allowed.has(key)) || !SAFE_ID.test(taskId) ||
      !['completed', 'failed'].includes(result) || !Number.isInteger(revision) || revision !== 0) {
    return json({ ok: false, error: 'taskId, result, revision을 확인해 주세요' }, 400, origin);
  }
  const lock = await acquireBookOrderDispatchLock(env, app, 'manual_online', Date.now());
  if (!lock) {
    return json({ ok: false, code: 'BOOK_ORDER_SEND_BUSY',
      error: '주문 결과 또는 취소 처리가 진행 중입니다. 잠시 후 다시 확인해 주세요' }, 409, origin);
  }
  try {
  const taskRow = await env.DB.prepare('SELECT id,owner,data FROM tasks WHERE app=? AND id=? LIMIT 1')
    .bind(app, taskId).first();
  const task = orderTaskData(taskRow);
  if (!task || task.orderDelivery !== MANUAL_ONLINE_DELIVERY || String(task.orderVendor || '') !== ONLINE_BOOK_VENDOR) {
    return json({ ok: false, error: '온라인 직접 주문을 찾을 수 없습니다' }, 404, origin);
  }
  if (auth.scope === 'own' && String(taskRow.owner || '') !== String(auth.id || '')) {
    return json({ ok: false, error: '본인이 만든 온라인 주문만 처리할 수 있습니다' }, 403, origin);
  }
  const cancellations = await loadOrderItemCancellationRows(env, app, taskId);
  const cancelledIndexes = cancelledOrderItemIndexes(cancellations, taskId);
  const activeItems = task.orderItems.filter((item, itemIndex) => !cancelledIndexes.has(itemIndex));
  if (!activeItems.length) {
    return json({ ok: false, code: 'ORDER_ITEM_CANCELLED', error: '모든 교재가 취소된 주문입니다' }, 409, origin);
  }
  if (await env.DB.prepare(
    'SELECT 1 AS found FROM book_order_fulfillments WHERE app=? AND task_id=? LIMIT 1'
  ).bind(app, taskId).first()) {
    return json({ ok: false, code: 'ORDER_ALREADY_RECEIVED', error: '수령 처리가 시작된 주문 결과는 바꿀 수 없습니다' }, 409, origin);
  }

  const existing = await latestOrderSend(env, app, taskId);
  const targetStatus = result === 'completed' ? 'accepted' : 'rejected';
  if (existing) {
    if (String(existing.status) === targetStatus && String(existing.provider_status_code || '') ===
        (result === 'completed' ? 'MANUAL_ONLINE_COMPLETED' : 'MANUAL_ONLINE_FAILED')) {
      return json({ ok: true, idempotent: true, status: targetStatus, revision: 1 }, 200, origin);
    }
    return json({ ok: false, code: 'REVISION_CONFLICT', error: '온라인 주문 결과가 이미 저장되었습니다' }, 409, origin);
  }

  const document = await currentRoster(env, app);
  if (!document) return json({ ok: false, error: '원생 데이터가 아직 등록되지 않았습니다' }, 404, origin);
  const snapshots = await loadOrderSnapshotRows(env, app, taskId);
  const sealed = await verifyOrderTaskSnapshotRows(
    taskId, taskRow.owner, task, snapshots, document, Date.now(), true, cancelledIndexes
  );
  if (!sealed.valid) {
    return json({ ok: false, code: 'ORDER_IDENTITY_MISMATCH', error: '봉인된 주문 정체성이 일치하지 않습니다' }, 409, origin);
  }

  const now = Date.now();
  const sendId = 'manual_' + taskId;
  const messageHash = await sha256Hex(JSON.stringify([
    taskId,
    task.orderVendor,
    activeItems.map(item => [String(item.bookId || ''), String(item.title || ''), String(item.qty || '')])
  ]));
  const inserted = await env.DB.prepare(
    'INSERT INTO book_order_sends(app,send_id,idempotency_key,task_id,vendor_name,item_count,message_hash,status,' +
      'provider_group_id,provider_message_id,provider_status_code,safe_error_code,created_at,dispatch_started_at,updated_at) ' +
    'SELECT ?,?,?,?,?,?,?,?,NULL,NULL,?,?,?,NULL,? WHERE EXISTS (' +
      "SELECT 1 FROM tasks WHERE app=? AND id=? AND data=? AND COALESCE(json_extract(data,'$.deleted'),0)=0 " +
      "AND json_extract(data,'$.orderDelivery')='manual_online_v1'" +
      ' AND (SELECT COUNT(*) FROM book_order_item_cancellations cancellation ' +
        'WHERE cancellation.app=tasks.app AND cancellation.task_id=tasks.id)=?' +
    ') ON CONFLICT DO NOTHING'
  ).bind(app, sendId, 'manual-online:' + taskId, taskId, ONLINE_BOOK_VENDOR, activeItems.length,
    messageHash, targetStatus, result === 'completed' ? 'MANUAL_ONLINE_COMPLETED' : 'MANUAL_ONLINE_FAILED',
    result === 'failed' ? 'MANUAL_ONLINE_FAILED' : null, now, now,
    app, taskId, String(taskRow.data || ''), cancelledIndexes.size).run();
  if (!inserted.meta || Number(inserted.meta.changes || 0) !== 1) {
    const raced = await latestOrderSend(env, app, taskId);
    if (raced && String(raced.status) === targetStatus) {
      return json({ ok: true, idempotent: true, status: targetStatus, revision: 1 }, 200, origin);
    }
    return json({ ok: false, code: 'REVISION_CONFLICT', error: '온라인 주문 결과가 먼저 저장되었습니다' }, 409, origin);
  }
  return json({ ok: true, idempotent: false, status: targetStatus, revision: 1 }, 200, origin);
  } finally {
    await releaseBookOrderDispatchLockSafely(env, app, lock);
  }
}

async function transitionOrderFulfillment(env, app, body, auth, json, origin, ctx) {
  const taskId = String(body.taskId || '');
  const itemIndex = Number(body.itemIndex);
  const next = String(body.next || '');
  const revision = Number(body.revision || 0);
  if (!SAFE_ID.test(taskId) || !Number.isInteger(itemIndex) || itemIndex < 0 || !ORDER_NEXT.has(next) ||
      !Number.isInteger(revision) || revision < 0) {
    return json({ ok: false, error: 'taskId, itemIndex, next, revision을 확인해 주세요' }, 400, origin);
  }
  if (next === 'academy_register' && auth.scope !== 'all') {
    return json({ ok: false, error: '아카등록 완료는 관리자만 처리할 수 있습니다' }, 403, origin);
  }
  const taskRow = await env.DB.prepare('SELECT id,owner,data FROM tasks WHERE app=? AND id=? LIMIT 1').bind(app, taskId).first();
  const task = orderTaskData(taskRow);
  if (!task || !task.orderItems[itemIndex]) return json({ ok: false, error: '현재 주문 항목을 찾을 수 없습니다' }, 404, origin);
  if (auth.scope === 'own' && String(taskRow.owner || '') !== auth.id) {
    return json({ ok: false, error: '본인이 주문한 교재만 처리할 수 있습니다' }, 403, origin);
  }
  if (await orderItemCancellation(env, app, taskId, itemIndex)) {
    return json({ ok: false, code: 'ORDER_ITEM_CANCELLED', error: '취소된 교재 주문은 처리할 수 없습니다' }, 409, origin);
  }
  const item = task.orderItems[itemIndex];
  const bookId = String(item.bookId || '');
  const studentIds = orderStudentIds(item);
  if (!bookId || bookId.length > 128 || !studentIds.length || !validOrderStudentSelection(item, studentIds)) {
    return json({ ok: false, error: '학생을 선택한 새 주문만 수령·배부 처리할 수 있습니다' }, 409, origin);
  }
  const document = await currentRoster(env, app);
  if (!document) return json({ ok: false, error: '원생 데이터가 아직 등록되지 않았습니다' }, 404, origin);
  const studentsById = new Map(document.roster.students.map(student => [String(student.id), student]));
  if (studentIds.some(id => !studentsById.has(id))) {
    return json({ ok: false, code: 'ORDER_STUDENT_MISSING', error: '주문 학생이 현재 원생 명단에 없어 확인이 필요합니다' }, 409, origin);
  }
  const allowedStudentIds = await bookOrderStudentIdsForAuth(env, app, document, auth);
  if (auth.scope === 'own' && studentIds.some(id => !allowedStudentIds.has(id))) {
    return json({ ok: false, error: '현재 본인이 담당하는 수업 학생의 주문만 처리할 수 있습니다' }, 403, origin);
  }

  const send = await latestOrderSend(env, app, taskId);
  const accepted = IMMEDIATE_RECEIPT_DELIVERIES.has(String(task.orderDelivery || '')) ||
    (!!send && String(send.status) === 'accepted');
  const snapshots = await loadOrderSnapshotRows(env, app, taskId);
  const sealedIdentity = await verifyOrderTaskSnapshotRows(
    taskId, taskRow.owner, task, snapshots, document, Date.now(), !accepted
  );
  if (sealedIdentity.sealed && !sealedIdentity.valid) {
    return json({ ok: false, code: 'ORDER_IDENTITY_MISMATCH', error: '봉인된 주문의 학생 또는 교재 정체성이 일치하지 않습니다' }, 409, origin);
  }

  let row = await env.DB.prepare('SELECT * FROM book_order_fulfillments WHERE app=? AND task_id=? AND item_index=? LIMIT 1')
    .bind(app, taskId, itemIndex).first();
  if (!fulfillmentMatches(row, bookId, studentIds)) {
    return json({ ok: false, code: 'ORDER_IDENTITY_MISMATCH', error: '주문 항목의 학생 또는 교재 정체성이 기존 이력과 다릅니다' }, 409, origin);
  }
  const targetStatus = next === 'receive' ? 'teacher_received' : next === 'hand' ? 'student_handed' : 'academy_registered';
  if (row && Number(row.revision) === revision + 1 && String(row.status) === targetStatus) {
    return json({ ok: true, idempotent: true }, 200, origin);
  }
  if ((!row && revision !== 0) || (row && Number(row.revision) !== revision)) {
    return json({ ok: false, code: 'REVISION_CONFLICT', error: '다른 기기에서 상태가 먼저 변경되었습니다' }, 409, origin);
  }
  if (!row && next !== 'receive') return json({ ok: false, code: 'INVALID_TRANSITION', error: '선생님 수령을 먼저 완료해 주세요' }, 409, origin);
  if (row && ((row.status === 'teacher_received' && next !== 'hand') ||
      (row.status === 'student_handed' && next !== 'academy_register') || row.status === 'academy_registered')) {
    return json({ ok: false, code: 'INVALID_TRANSITION', error: '현재 상태에서는 요청한 변경을 할 수 없습니다' }, 409, origin);
  }
  if (!accepted) {
    return json({ ok: false, code: 'ORDER_NOT_ACCEPTED', error: '주문완료가 확인된 뒤 수령·배부 처리할 수 있습니다' }, 409, origin);
  }
  const now = Date.now();
  const actor = actorId(auth);
  const idsJson = JSON.stringify(studentIds);
  const studentGuard = ownBookStudentWriteGuard(auth, app, studentIds, now);
  const ownerGuard = ownOrderOwnerWriteGuard(auth, app, taskId);
  let insertedCatalog = null;
  if (!row) {
    const inserted = await env.DB.prepare(
      'INSERT INTO book_order_fulfillments(app,task_id,item_index,book_id,student_ids,status,revision,' +
      'teacher_received_at,teacher_received_by,created_at,updated_at) SELECT ?,?,?,?,?,?,1,?,?,?,? ' +
      'WHERE 1=1' + ownerGuard.sql + studentGuard.sql + ' ' +
      'ON CONFLICT(app,task_id,item_index) DO NOTHING'
    ).bind(app, taskId, itemIndex, bookId, idsJson, targetStatus, now, actor, now, now,
      ...ownerGuard.binds, ...studentGuard.binds).run();
    if (!inserted.meta || Number(inserted.meta.changes || 0) !== 1) {
      if (!(await ownOrderMutationStillValid(env, app, auth, taskId, studentIds))) {
        return json({ ok: false, code: 'ORDER_STUDENT_SCOPE',
          error: '담당 수업 또는 주문 담당자가 변경되어 수령 처리할 수 없습니다' }, 403, origin);
      }
      return json({ ok: false, code: 'REVISION_CONFLICT', error: '다른 기기에서 상태가 먼저 변경되었습니다' }, 409, origin);
    }
  } else {
    const handedAt = next === 'hand' ? now : row.student_handed_at;
    const handedBy = next === 'hand' ? actor : row.student_handed_by;
    const academyAt = next === 'academy_register' ? now : row.academy_registered_at;
    const academyBy = next === 'academy_register' ? actor : row.academy_registered_by;
    const updateStatement = env.DB.prepare(
      'UPDATE book_order_fulfillments SET status=?,revision=revision+1,student_handed_at=?,student_handed_by=?,' +
      'academy_registered_at=?,academy_registered_by=?,updated_at=? ' +
      'WHERE app=? AND task_id=? AND item_index=? AND revision=? AND status=? AND book_id=? AND student_ids=?' +
      ownerGuard.sql + studentGuard.sql
    ).bind(targetStatus, handedAt, handedBy, academyAt, academyBy, now, app, taskId, itemIndex, revision,
      row.status, bookId, idsJson, ...ownerGuard.binds, ...studentGuard.binds);
    let updated;
    const catalog = next === 'academy_register' && task.orderDelivery !== INTERNAL_BOOK_DELIVERY
      ? completedCatalogRecord(env, item, task, now) : null;
    if (catalog) {
      if (typeof env.DB.batch !== 'function') {
        // 일부 로컬 D1 어댑터에는 batch가 없다. 운영 D1에서는 아래 atomic 경로만 사용된다.
        updated = await updateStatement.run();
        if (updated.meta && Number(updated.meta.changes || 0) === 1) {
          try {
            const catalogResult = await completedCatalogInsertStatement(env, app, catalog, {
              taskId, itemIndex, bookId, studentIdsJson: idsJson, revision: revision + 1
            }).run();
            if (catalogResult.meta && Number(catalogResult.meta.changes || 0) === 1) insertedCatalog = catalog;
          } catch (error) {
            if (!/no such table.*completed_book_catalog/i.test(String(error && error.message || error))) throw error;
          }
        }
      } else try {
        const results = await env.DB.batch([
          updateStatement,
          completedCatalogInsertStatement(env, app, catalog, {
            taskId,
            itemIndex,
            bookId,
            studentIdsJson: idsJson,
            revision: revision + 1
          })
        ]);
        updated = results && results[0];
        if (Number(results && results[1] && results[1].meta && results[1].meta.changes || 0) === 1) {
          insertedCatalog = catalog;
        }
      } catch (error) {
        // Migration이 아직 적용되지 않은 짧은 전환 구간에도 아카등록 완료 자체는 보존한다.
        if (!/no such table.*completed_book_catalog/i.test(String(error && error.message || error))) throw error;
        updated = await updateStatement.run();
      }
    } else {
      updated = await updateStatement.run();
    }
    if (!updated || !updated.meta || Number(updated.meta.changes || 0) !== 1) {
      if (!(await ownOrderMutationStillValid(env, app, auth, taskId, studentIds))) {
        return json({ ok: false, code: 'ORDER_STUDENT_SCOPE',
          error: '담당 수업 또는 주문 담당자가 변경되어 배부 처리할 수 없습니다' }, 403, origin);
      }
      return json({ ok: false, code: 'REVISION_CONFLICT', error: '다른 기기에서 상태가 먼저 변경되었습니다' }, 409, origin);
    }
  }
  if (insertedCatalog && insertedCatalog.verificationStatus === 'pending' && ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(verifyCompletedCatalogEntry(env, insertedCatalog.catalogId).catch(() => undefined));
  }
  row = await env.DB.prepare('SELECT * FROM book_order_fulfillments WHERE app=? AND task_id=? AND item_index=? LIMIT 1')
    .bind(app, taskId, itemIndex).first();
  return json({ ok: true, idempotent: false, status: row.status, revision: Number(row.revision) }, 200, origin);
}

function transitionPlan(row, next, reason, now, actor) {
  const from = row ? String(row.status) : 'none';
  if (!row && next !== 'prepared' && next !== 'issued') return null;
  if (row && from === 'prepared' && next !== 'issued' && next !== 'cancelled') return null;
  if (row && from === 'issued' && next !== 'handed' && next !== 'cancelled') return null;
  if (row && (from === 'handed' || from === 'cancelled') && next !== 'reissue') return null;
  if ((next === 'cancelled' || next === 'reissue') && !reason) return null;

  const status = next === 'reissue' ? 'prepared' : next;
  const cycle = row ? Number(row.cycle) + (next === 'reissue' ? 1 : 0) : 1;
  const history = row ? parseHistory(row.history) : [];
  history.push({ action: next, from, to: status, cycle, actorId: actor, at: now, ...(reason ? { reason } : {}) });
  return { from, status, cycle, history };
}

async function transition(env, app, body, auth, json, origin) {
  const assignmentId = String(body.assignmentId || '');
  const next = String(body.next || body.event || '');
  const revisionValue = Object.prototype.hasOwnProperty.call(body, 'revision') ? body.revision : body.expectedRevision;
  const revision = revisionValue === undefined ? 0 : Number(revisionValue);
  const reason = cleanReason(body.reason);
  if (!SAFE_ID.test(assignmentId) || !NEXT.has(next) || !Number.isInteger(revision) || revision < 0) {
    return json({ ok: false, error: 'assignmentId, next, revision을 확인해 주세요' }, 400, origin);
  }
  if (reason === null) return json({ ok: false, error: '사유는 300자 이내여야 합니다' }, 400, origin);
  if ((next === 'cancelled' || next === 'reissue') && !reason) {
    return json({ ok: false, error: '취소·재출고에는 사유가 필요합니다' }, 400, origin);
  }

  const document = await currentRoster(env, app);
  if (!document) return json({ ok: false, error: '원생 데이터가 아직 등록되지 않았습니다' }, 404, origin);
  const assignment = document.bookStudents.find(item => item.id === assignmentId);
  if (!assignment) return json({ ok: false, error: '현재 명단의 교재 배정을 찾을 수 없습니다' }, 404, origin);
  if (auth.scope === 'own' && !assignment.teacherIds.includes(auth.id)) {
    return json({ ok: false, error: '이 교재 배정을 담당하는 선생님만 처리할 수 있습니다' }, 403, origin);
  }
  const allowedStudentIds = await bookOrderStudentIdsForAuth(env, app, document, auth);
  if (auth.scope === 'own' && !allowedStudentIds.has(String(assignment.studentId))) {
    return json({ ok: false, error: '현재 본인이 담당하는 수업 학생의 교재만 처리할 수 있습니다' }, 403, origin);
  }
  const student = document.roster.students.find(item => item.id === assignment.studentId);
  const hash = await identityHash(student.id, student.name);
  let row = await env.DB.prepare('SELECT * FROM book_issues WHERE app=? AND assignment_id=? LIMIT 1')
    .bind(app, assignmentId).first();
  if (row && !sameIdentity(row, assignment, hash)) {
    return json({ ok: false, code: 'ASSIGNMENT_IDENTITY_MISMATCH', error: '교재 배정 ID의 정체성이 기존 출고 이력과 다릅니다' }, 409, origin);
  }
  if (row && Number(row.revision) !== revision) {
    if (latestIsDuplicate(row, next, revision, reason)) {
      return json({ ok: true, idempotent: true, issue: publicIssue(assignment, student, row) }, 200, origin);
    }
    return json({ ok: false, code: 'REVISION_CONFLICT', error: '다른 기기에서 상태가 먼저 변경되었습니다', current: publicIssue(assignment, student, row) }, 409, origin);
  }
  if (!row && revision !== 0) {
    return json({ ok: false, code: 'REVISION_CONFLICT', error: '출고 상태가 아직 시작되지 않았습니다' }, 409, origin);
  }

  const now = Date.now();
  const actor = actorId(auth);
  const plan = transitionPlan(row, next, reason, now, actor);
  if (!plan) return json({ ok: false, code: 'INVALID_TRANSITION', error: '현재 상태에서는 요청한 변경을 할 수 없습니다' }, 409, origin);
  const studentGuard = ownBookStudentWriteGuard(auth, app, [assignment.studentId], now);
  const assignmentGuard = ownLegacyAssignmentWriteGuard(auth, app, assignment);

  if (!row) {
    const preparedAt = next === 'prepared' || next === 'issued' ? now : null;
    const issuedAt = next === 'issued' ? now : null;
    const inserted = await env.DB.prepare(
      'INSERT INTO book_issues(app,assignment_id,student_id,book_id,student_identity_hash,status,cycle,revision,' +
      'prepared_at,prepared_by,issued_at,issued_by,handed_at,handed_by,cancelled_at,cancelled_by,cancel_reason,reissue_reason,history,created_at,updated_at) ' +
      'SELECT ?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,NULL,?,?,? WHERE 1=1' +
      assignmentGuard.sql + studentGuard.sql + ' ON CONFLICT(app,assignment_id) DO NOTHING'
    ).bind(app, assignmentId, assignment.studentId, assignment.bookId, hash, plan.status, 1, 1,
      preparedAt, actor, issuedAt, issuedAt ? actor : null, JSON.stringify(plan.history), now, now,
      ...assignmentGuard.binds, ...studentGuard.binds).run();
    if (!inserted.meta || Number(inserted.meta.changes || 0) !== 1) {
      if (!(await ownLegacyAssignmentStillValid(env, app, auth, assignment))) {
        return json({ ok: false, code: 'BOOK_ASSIGNMENT_SCOPE',
          error: '교재 배정 또는 담당 수업이 변경되어 처리할 수 없습니다' }, 403, origin);
      }
      row = await env.DB.prepare('SELECT * FROM book_issues WHERE app=? AND assignment_id=? LIMIT 1').bind(app, assignmentId).first();
      if (sameIdentity(row, assignment, hash) && latestIsDuplicate(row, next, revision, reason)) {
        return json({ ok: true, idempotent: true, issue: publicIssue(assignment, student, row) }, 200, origin);
      }
      return json({ ok: false, code: 'REVISION_CONFLICT', error: '다른 기기에서 상태가 먼저 변경되었습니다' }, 409, origin);
    }
  } else {
    let preparedAt = row.prepared_at, preparedBy = row.prepared_by;
    let issuedAt = row.issued_at, issuedBy = row.issued_by;
    let handedAt = row.handed_at, handedBy = row.handed_by;
    let cancelledAt = row.cancelled_at, cancelledBy = row.cancelled_by;
    let cancelReason = row.cancel_reason, reissueReason = row.reissue_reason;
    if (next === 'issued') { issuedAt = now; issuedBy = actor; }
    if (next === 'handed') { handedAt = now; handedBy = actor; }
    if (next === 'cancelled') { cancelledAt = now; cancelledBy = actor; cancelReason = reason; }
    if (next === 'reissue') {
      preparedAt = now; preparedBy = actor; issuedAt = null; issuedBy = null; handedAt = null; handedBy = null;
      cancelledAt = null; cancelledBy = null; cancelReason = null; reissueReason = reason;
    }
    const updated = await env.DB.prepare(
      'UPDATE book_issues SET status=?,cycle=?,revision=revision+1,prepared_at=?,prepared_by=?,issued_at=?,issued_by=?,' +
      'handed_at=?,handed_by=?,cancelled_at=?,cancelled_by=?,cancel_reason=?,reissue_reason=?,history=?,updated_at=? ' +
      'WHERE app=? AND assignment_id=? AND revision=? AND status=? AND student_id=? AND book_id=? AND student_identity_hash=?' +
      assignmentGuard.sql + studentGuard.sql
    ).bind(plan.status, plan.cycle, preparedAt, preparedBy, issuedAt, issuedBy, handedAt, handedBy,
      cancelledAt, cancelledBy, cancelReason, reissueReason, JSON.stringify(plan.history), now,
      app, assignmentId, revision, row.status, assignment.studentId, assignment.bookId, hash,
      ...assignmentGuard.binds, ...studentGuard.binds).run();
    if (!updated.meta || Number(updated.meta.changes || 0) !== 1) {
      if (!(await ownLegacyAssignmentStillValid(env, app, auth, assignment))) {
        return json({ ok: false, code: 'BOOK_ASSIGNMENT_SCOPE',
          error: '교재 배정 또는 담당 수업이 변경되어 처리할 수 없습니다' }, 403, origin);
      }
      const fresh = await env.DB.prepare('SELECT * FROM book_issues WHERE app=? AND assignment_id=? LIMIT 1').bind(app, assignmentId).first();
      if (sameIdentity(fresh, assignment, hash) && latestIsDuplicate(fresh, next, revision, reason)) {
        return json({ ok: true, idempotent: true, issue: publicIssue(assignment, student, fresh) }, 200, origin);
      }
      return json({ ok: false, code: 'REVISION_CONFLICT', error: '다른 기기에서 상태가 먼저 변경되었습니다' }, 409, origin);
    }
  }

  row = await env.DB.prepare('SELECT * FROM book_issues WHERE app=? AND assignment_id=? LIMIT 1').bind(app, assignmentId).first();
  return json({ ok: true, idempotent: false, issue: publicIssue(assignment, student, row) }, 200, origin);
}

export async function handleBookIssue(env, app, body, origin, auth, json, ctx) {
  if (app !== 'task') return json({ ok: false, error: '이 기능은 직원 앱에서만 사용할 수 있습니다' }, 400, origin);
  const action = String(body.action || '');
  if (action === 'list') return listIssues(env, app, auth, json, origin);
  if (action === 'transition') return transition(env, app, body, auth, json, origin);
  if (action === 'order_link') return linkOrderStudents(env, app, body, auth, json, origin);
  if (action === 'order_price_set') return setLegacyOrderPrice(env, app, body, auth, json, origin);
  if (action === 'manual_online_result') return setManualOnlineResult(env, app, body, auth, json, origin);
  if (action === 'order_transition') return transitionOrderFulfillment(env, app, body, auth, json, origin, ctx);
  return json({ ok: false, error: '지원하는 교재 처리 action을 확인해 주세요' }, 400, origin);
}
