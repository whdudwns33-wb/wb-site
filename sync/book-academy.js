import { taskWriteCasGuardStatement } from './task-write-cas.js';
import { completedCatalogRecord, completedCatalogInsertStatement, verifyCompletedCatalogEntry } from './completed-book-catalog.js';

// 배송 상태와 회계 입력 상태는 독립적이다. 이름 대신 학생 ID와 등록 당시 금액을 비교한다.
export function academySnapshot(row) {
  return JSON.stringify({ bookId: row.bookId, title: row.title, unitPrice: row.unitPrice,
    students: (row.students || []).map(s => String(s.id)).sort(),
    cancelled: row.stage === 'cancelled',
    cancellations: (row.cancelledStudents || []).map(s => String(s.id)).sort() });
}

export function withAcademyState(row, registration) {
  const at = Number(registration && registration.registered_at || row.academyRegisteredAt) || null;
  const legacyChanged = at && (Number(row.priceCorrectedAt) > at || Number(row.orderCancelledAt) > at ||
    (row.cancelledStudents || []).some(s => Number(s.cancelledAt) > at));
  return { ...row, academyRegisteredAt: at, academyRevision: Number(registration && registration.revision || 0),
    academyConfirmedAt: Number(registration && registration.confirmed_at) || at,
    academyCorrectionNeeded: !!(at && (row.integrity || (registration
      ? registration.snapshot !== academySnapshot(row) : legacyChanged))) };
}

const CONTROL = `SELECT t.data, COALESCE(f.revision,0) fulfillment_revision,
  COALESCE((SELECT SUM(cancelled_at) FROM book_order_received_student_cancellations WHERE app=t.app AND task_id=t.id AND item_index=?),0) student_cancel_stamp,
  COALESCE((SELECT cancelled_at FROM book_order_item_cancellations WHERE app=t.app AND task_id=t.id AND item_index=?),0) cancel_stamp,
  COALESCE((SELECT created_at FROM book_order_item_prices WHERE app=t.app AND task_id=t.id AND item_index=?),0) price_stamp,
  COALESCE((SELECT created_at FROM book_order_item_price_corrections WHERE app=t.app AND task_id=t.id AND item_index=?),0) correction_stamp
  FROM tasks t LEFT JOIN book_order_fulfillments f ON f.app=t.app AND f.task_id=t.id AND f.item_index=?
  WHERE t.app=? AND t.id=?`;

export async function transitionAcademy(env, app, body, auth, json, origin, listRows, ctx) {
  if (auth.scope !== 'all') return json({ ok:false, error:'아카등록 처리는 관리자만 할 수 있습니다' },403,origin);
  const taskId=String(body.taskId||''), index=Number(body.itemIndex), revision=Number(body.academyRevision||0);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(taskId) || !Number.isInteger(index) || index<0 ||
      !Number.isInteger(revision) || revision<0 || !['register','correct'].includes(body.next)) {
    return json({ok:false,error:'아카등록 항목을 확인해 주세요'},400,origin);
  }
  const control=await env.DB.prepare(CONTROL).bind(index,index,index,index,index,app,taskId).first();
  const row=(await listRows()).find(r=>r.taskId===taskId && r.itemIndex===index);
  if (!control || !row) return json({ok:false,error:'주문 항목을 찾을 수 없습니다'},404,origin);
  const registration=await env.DB.prepare('SELECT * FROM book_order_academy WHERE app=? AND task_id=? AND item_index=?').bind(app,taskId,index).first();
  const state=withAcademyState(row,registration);
  if (body.next==='register' && state.academyRegisteredAt && !state.academyCorrectionNeeded) return json({ok:true,idempotent:true},200,origin);
  if (revision!==state.academyRevision || Number(body.revision)!==row.revision) return json({ok:false,error:'주문 상태가 변경되었습니다. 새로고침 후 확인해 주세요'},409,origin);
  if (body.next==='register' && (!['ordered','teacher_received','student_handed'].includes(row.stage) ||
      state.academyRegisteredAt || row.needsStudentLink || row.integrity || !Number.isInteger(row.unitPrice) || row.unitPrice<1)) {
    return json({ok:false,error:'주문완료와 학생 연결·교재 금액을 먼저 확인해 주세요'},409,origin);
  }
  if (body.next==='correct' && (!state.academyRegisteredAt || !state.academyCorrectionNeeded || row.integrity ||
      (row.stage!=='cancelled' && (row.needsStudentLink || !Number.isInteger(row.unitPrice) || row.unitPrice<1)))) {
    return json({ok:false,error:'아카 수정 필요 상태와 학생·교재 연결을 확인해 주세요'},409,origin);
  }
  const now=Date.now(), actor=String(auth.id||'director'), registeredAt=state.academyRegisteredAt||now;
  const statements=[env.DB.prepare(`UPDATE tasks SET updated_at=updated_at WHERE app=? AND id=? AND data=?
    AND EXISTS (SELECT 1 FROM (${CONTROL}) c WHERE c.fulfillment_revision=? AND c.student_cancel_stamp=?
      AND c.cancel_stamp=? AND c.price_stamp=? AND c.correction_stamp=?)`).bind(app,taskId,control.data,
        index,index,index,index,index,app,taskId,control.fulfillment_revision,control.student_cancel_stamp,
        control.cancel_stamp,control.price_stamp,control.correction_stamp),
    await taskWriteCasGuardStatement(env,app,'book_academy_source',crypto.randomUUID(),now)];
  const snapshot=academySnapshot(row);
  statements.push(env.DB.prepare(`INSERT INTO book_order_academy(app,task_id,item_index,registered_at,confirmed_at,confirmed_by,revision,snapshot)
    VALUES(?,?,?,?,?,?,1,?) ON CONFLICT(app,task_id,item_index) DO UPDATE SET confirmed_at=excluded.confirmed_at,
    confirmed_by=excluded.confirmed_by,revision=book_order_academy.revision+1,snapshot=excluded.snapshot WHERE book_order_academy.revision=?`)
    .bind(app,taskId,index,registeredAt,now,actor,snapshot,revision),
    await taskWriteCasGuardStatement(env,app,'book_academy_register',crypto.randomUUID(),now));
  let catalog=null;
  if(row.stage==='student_handed') {
    statements.push(env.DB.prepare(`UPDATE book_order_fulfillments SET status='academy_registered',revision=revision+1,
      academy_registered_at=?,academy_registered_by=?,updated_at=? WHERE app=? AND task_id=? AND item_index=? AND revision=?`)
      .bind(registeredAt,actor,now,app,taskId,index,row.revision),
      await taskWriteCasGuardStatement(env,app,'book_academy_delivery',crypto.randomUUID(),now));
    const task=JSON.parse(control.data),item=task.orderItems[index];
    if(task.orderDelivery!=='internal_book_v1') catalog=completedCatalogRecord(env,item,task,now);
    if(catalog) statements.push(completedCatalogInsertStatement(env,app,catalog,{taskId,itemIndex:index,bookId:row.bookId,
      studentIdsJson:JSON.stringify((item.studentIds||[]).map(String).sort()),revision:row.revision+1}));
  }
  try { await env.DB.batch(statements); }
  catch(error) {
    if(!/TASK_WRITE_CAS_CONFLICT|task_write_cas_guards/.test(String(error.message))) throw error;
    return json({ok:false,error:'주문이 변경되었습니다. 최신 내용으로 다시 확인해 주세요'},409,origin);
  }
  if(catalog && catalog.verificationStatus==='pending' && ctx?.waitUntil) ctx.waitUntil(verifyCompletedCatalogEntry(env,catalog.catalogId).catch(()=>undefined));
  return json({ok:true,academyRegisteredAt:registeredAt,academyRevision:revision+1},200,origin);
}
