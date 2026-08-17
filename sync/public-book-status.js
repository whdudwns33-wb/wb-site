import { validateRosterDocument } from './roster.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ISSUE_STAGES = {
  prepared: ['preparing', '교재 준비 중'],
  issued: ['ready_for_handoff', '학생 전달 준비'],
  handed: ['handed', '학생 전달 완료'],
  cancelled: ['cancelled', '교재 처리 취소']
};
const ORDER_STAGES = {
  waiting: ['order_waiting', '주문 대기'],
  accepted: ['ordered', '주문 접수'],
  rejected: ['order_failed', '학원 확인 중'],
  checking: ['order_check', '학원 확인 중'],
  teacher_received: ['academy_received', '학원 도착'],
  student_handed: ['handed', '학생 전달 완료'],
  academy_registered: ['handed', '학생 전달 완료'],
  cancelled: ['cancelled', '교재 처리 취소']
};

function parseJson(value) {
  try { return JSON.parse(value || '{}'); }
  catch (error) { return null; }
}

function kstMonth(now) {
  return new Date(Number(now) + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

function activeInMonth(student, month) {
  return student && SAFE_ID.test(String(student.id || '')) &&
    (!student.start || String(student.start) <= month) &&
    (!student.end || String(student.end) > month);
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function identityHash(student) {
  return sha256Hex(String(student.id) + '\n' + String(student.name || '').normalize('NFKC').trim());
}

async function ready(env) {
  const result = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN " +
    "('book_issues','book_order_student_snapshots','book_order_cancellations'," +
    "'book_order_sends','book_order_batch_items','book_order_fulfillments')"
  ).all();
  return new Set((result.results || []).map(row => String(row.name))).size === 6;
}

function jsonIds(value) {
  const ids = parseJson(value);
  return Array.isArray(ids) && ids.every(id => SAFE_ID.test(String(id))) ? ids.map(String).sort() : null;
}

async function validSnapshotTask(taskRows, document, now) {
  if (!taskRows.length) return false;
  const taskHash = String(taskRows[0].task_identity_hash || '');
  const owner = String(taskRows[0].owner_id || '');
  const expectedItemCount = Number(taskRows[0].expected_item_count);
  const expectedRowCount = Number(taskRows[0].expected_row_count);
  if (!Number.isInteger(expectedItemCount) || expectedItemCount < 1 ||
      !Number.isInteger(expectedRowCount) || expectedRowCount !== taskRows.length) return false;
  const byItem = new Map();
  for (const row of taskRows) {
    const index = Number(row.item_index);
    if (!Number.isInteger(index) || index < 0 || String(row.task_identity_hash || '') !== taskHash ||
        String(row.owner_id || '') !== owner || Number(row.expected_item_count) !== expectedItemCount ||
        Number(row.expected_row_count) !== expectedRowCount) return false;
    if (!byItem.has(index)) byItem.set(index, []);
    byItem.get(index).push(row);
  }
  const indices = [...byItem.keys()].sort((a, b) => a - b);
  if (indices.length !== expectedItemCount || indices.some((index, position) => index !== position)) return false;
  const students = new Map(document.roster.students.map(student => [String(student.id), student]));
  for (const itemRows of byItem.values()) {
    const first = itemRows[0];
    const ids = itemRows.map(row => String(row.student_id)).sort();
    if (new Set(ids).size !== ids.length ||
        await sha256Hex(JSON.stringify(ids)) !== String(first.student_set_hash || '')) return false;
    for (const row of itemRows) {
      if (String(row.book_id || '') !== String(first.book_id || '') ||
          String(row.public_title || '') !== '주문 교재' || String(first.public_title || '') !== '주문 교재' ||
          String(row.student_set_hash || '') !== String(first.student_set_hash || '') ||
          String(row.item_identity_hash || '') !== String(first.item_identity_hash || '')) return false;
      const student = students.get(String(row.student_id));
      if (!student || await identityHash(student) !== String(row.student_identity_hash || '')) return false;
    }
  }
  return true;
}

/**
 * A guardian-safe, read-only view of one current student's book progress.
 * Contract: never returns stable/internal IDs, raw task text, contacts, actors or provider data.
 * Legacy order tasks have no immutable student identity snapshot, so they are intentionally omitted.
 * Order rows come only from the immutable snapshot/send/fulfillment ledgers; task JSON is never read here.
 */
export async function readPublicBookStatus(env, studentId, now = Date.now()) {
  const exactId = typeof studentId === 'string' ? studentId : '';
  if (!SAFE_ID.test(exactId)) return { error: '교재 현황을 확인할 수 없습니다', code: 'STUDENT_INVALID' };
  if (!await ready(env)) return { error: '교재 현황을 준비하고 있습니다', code: 'BOOK_STATUS_NOT_READY' };

  const rosterRow = await env.DB.prepare('SELECT data FROM private_rosters WHERE app=? LIMIT 1').bind('task').first();
  let document;
  try { document = rosterRow && validateRosterDocument(parseJson(rosterRow.data)); }
  catch (error) { return { error: '교재 현황을 확인할 수 없습니다', code: 'ROSTER_INVALID' }; }
  const month = kstMonth(now);
  const student = document && document.roster.students.find(item => item.id === exactId);
  if (!activeInMonth(student, month)) {
    return { error: '현재 이용할 수 없는 학생입니다', code: 'STUDENT_INACTIVE' };
  }

  const issueResult = await env.DB.prepare(
    'SELECT assignment_id,student_id,book_id,student_identity_hash,status,updated_at ' +
    'FROM book_issues WHERE app=? AND student_id=? ORDER BY updated_at DESC'
  ).bind('task', exactId).all();
  const rows = [];

  const assignments = new Map(document.bookStudents.filter(item => item.studentId === exactId)
    .map(item => [String(item.id), item]));
  const expectedIdentity = await identityHash(student);
  for (const issue of issueResult.results || []) {
    const assignment = assignments.get(String(issue.assignment_id || ''));
    const stage = ISSUE_STAGES[String(issue.status || '')];
    if (!assignment || !stage || String(issue.student_id || '') !== exactId ||
        String(issue.book_id || '') !== String(assignment.bookId) ||
        String(issue.student_identity_hash || '') !== expectedIdentity) continue;
    rows.push({
      kind: 'distribution', title: '배정 교재',
      stage: stage[0], label: stage[1], updatedAt: Number(issue.updated_at || 0)
    });
  }

  const targetResult = await env.DB.prepare(
    'SELECT task_id,MAX(created_at) AS latest_created_at FROM book_order_student_snapshots ' +
    'WHERE app=? AND student_id=? GROUP BY task_id ORDER BY latest_created_at DESC LIMIT 100'
  ).bind('task', exactId).all();
  const targetIds = (targetResult.results || []).map(row => String(row.task_id || '')).filter(Boolean);
  if (!targetIds.length) {
    rows.sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title, 'ko') || a.stage.localeCompare(b.stage));
    return { rows: rows.slice(0, 100) };
  }
  const targetCte = 'WITH target_tasks AS (' +
    'SELECT task_id FROM book_order_student_snapshots WHERE app=? AND student_id=? ' +
    'GROUP BY task_id ORDER BY MAX(created_at) DESC LIMIT 100) ';
  const [snapshotResult, sendResult, mappingResult, fulfillmentResult, cancellationResult] = await Promise.all([
    env.DB.prepare(
      targetCte +
      'SELECT task_id,item_index,owner_id,book_id,public_title,student_id,student_identity_hash,' +
      'student_set_hash,item_identity_hash,task_identity_hash,expected_item_count,expected_row_count,created_at ' +
      'FROM book_order_student_snapshots snapshot WHERE snapshot.app=? ' +
      'AND EXISTS (SELECT 1 FROM target_tasks target WHERE target.task_id=snapshot.task_id) ' +
      'ORDER BY task_id,item_index,student_id'
    ).bind('task', exactId, 'task').all(),
    env.DB.prepare(
      targetCte +
      'SELECT send_id,task_id,status,created_at,updated_at FROM book_order_sends WHERE app=? AND (' +
      'EXISTS (SELECT 1 FROM target_tasks target WHERE target.task_id=book_order_sends.task_id) OR ' +
      'EXISTS (SELECT 1 FROM book_order_batch_items item JOIN target_tasks target ON target.task_id=item.task_id ' +
        'WHERE item.app=book_order_sends.app AND item.send_id=book_order_sends.send_id)) ' +
      'ORDER BY created_at DESC,updated_at DESC'
    ).bind('task', exactId, 'task').all(),
    env.DB.prepare(
      targetCte + 'SELECT item.task_id,item.send_id FROM book_order_batch_items item WHERE item.app=? ' +
      'AND EXISTS (SELECT 1 FROM target_tasks target WHERE target.task_id=item.task_id)'
    ).bind('task', exactId, 'task').all(),
    env.DB.prepare(
      targetCte +
      'SELECT task_id,item_index,book_id,student_ids,status,updated_at FROM book_order_fulfillments ' +
      'WHERE app=? AND EXISTS (SELECT 1 FROM target_tasks target ' +
        'WHERE target.task_id=book_order_fulfillments.task_id)'
    ).bind('task', exactId, 'task').all(),
    env.DB.prepare(
      targetCte + 'SELECT task_id,cancelled_at FROM book_order_cancellations WHERE app=? ' +
      'AND EXISTS (SELECT 1 FROM target_tasks target WHERE target.task_id=book_order_cancellations.task_id)'
    ).bind('task', exactId, 'task').all()
  ]);
  const snapshotByTask = new Map();
  for (const row of snapshotResult.results || []) {
    const taskId = String(row.task_id || '');
    if (!snapshotByTask.has(taskId)) snapshotByTask.set(taskId, []);
    snapshotByTask.get(taskId).push(row);
  }
  const sendsById = new Map((sendResult.results || []).map(row => [String(row.send_id), row]));
  const mappedSendIds = new Set((mappingResult.results || []).map(row => String(row.send_id || '')));
  const sendByTask = new Map();
  for (const send of sendResult.results || []) {
    const taskId = String(send.task_id || '');
    if (mappedSendIds.has(String(send.send_id || '')) || /^(?:batch_|retry_)|^sample:/.test(taskId)) continue;
    if (!sendByTask.has(taskId)) sendByTask.set(taskId, send);
  }
  for (const mapping of mappingResult.results || []) {
    const send = sendsById.get(String(mapping.send_id || ''));
    const taskId = String(mapping.task_id || '');
    const current = sendByTask.get(taskId);
    if (send && (!current || Number(send.created_at || 0) > Number(current.created_at || 0) ||
        (Number(send.created_at || 0) === Number(current.created_at || 0) &&
          Number(send.updated_at || 0) > Number(current.updated_at || 0)))) sendByTask.set(taskId, send);
  }
  const fulfillmentByItem = new Map((fulfillmentResult.results || []).map(row => [
    String(row.task_id || '') + '|' + Number(row.item_index), row
  ]));
  const cancellations = new Map((cancellationResult.results || []).map(row => [String(row.task_id), Number(row.cancelled_at)]));

  for (const [taskId, taskRows] of snapshotByTask) {
    if (!taskRows.some(row => String(row.student_id) === exactId) ||
        !await validSnapshotTask(taskRows, document, now)) continue;
    const byItem = new Map();
    for (const row of taskRows) {
      const index = Number(row.item_index);
      if (!byItem.has(index)) byItem.set(index, []);
      byItem.get(index).push(row);
    }
    for (const [itemIndex, itemRows] of byItem) {
      if (!itemRows.some(row => String(row.student_id) === exactId)) continue;
      const first = itemRows[0];
      const expectedIds = itemRows.map(row => String(row.student_id)).sort();
      const fulfillment = fulfillmentByItem.get(taskId + '|' + itemIndex) || null;
      const fulfillmentIds = fulfillment && jsonIds(fulfillment.student_ids);
      const fulfillmentValid = !fulfillment || (
        String(fulfillment.book_id || '') === String(first.book_id || '') &&
        JSON.stringify(fulfillmentIds) === JSON.stringify(expectedIds) &&
        ['teacher_received', 'student_handed', 'academy_registered'].includes(String(fulfillment.status || ''))
      );
      if (!fulfillmentValid) continue;
      const cancelledAt = cancellations.get(taskId) || 0;
      const send = sendByTask.get(taskId) || null;
      if (fulfillment && (!send || String(send.status) !== 'accepted')) continue;
      if (cancelledAt && (fulfillment || (send && ['reserved', 'dispatching', 'accepted', 'unknown'].includes(String(send.status))))) continue;
      const state = cancelledAt ? 'cancelled' : fulfillment ? String(fulfillment.status) : !send ? 'waiting' :
        String(send.status) === 'accepted' ? 'accepted' : String(send.status) === 'rejected' ? 'rejected' : 'checking';
      const stage = ORDER_STAGES[state];
      if (!stage) continue;
      rows.push({
        kind: 'order', title: String(first.public_title), stage: stage[0], label: stage[1],
        updatedAt: cancelledAt || Number(fulfillment && fulfillment.updated_at || send && send.updated_at || first.created_at || 0)
      });
    }
  }

  rows.sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title, 'ko') || a.stage.localeCompare(b.stage));
  return { rows: rows.slice(0, 100) };
}
