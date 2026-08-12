const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_NAME = 40;
const MAX_GRADE = 20;
const MAX_NOTE = 500;

const text = (value, max) => String(value == null ? '' : value).normalize('NFKC').trim().slice(0, max);
const normalize = value => text(value, 200).replace(/\s+/g, '').toLocaleLowerCase('ko');
const view = row => row && ({
  requestKey: String(row.request_key), staffId: String(row.staff_id), studentName: String(row.student_name),
  grade: String(row.grade), studentId: row.student_id == null ? '' : String(row.student_id),
  revision: Number(row.revision), status: String(row.status), createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at), reviewedAt: row.reviewed_at == null ? null : Number(row.reviewed_at),
  reviewNote: row.review_note == null ? '' : String(row.review_note)
});

async function keyFor(staffId, studentName, grade) {
  const raw = [staffId, normalize(studentName), normalize(grade)].join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return 'lar_' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 48);
}

async function activeStaff(env, app, id) {
  const row = await env.DB.prepare('SELECT data FROM staff WHERE app=? AND id=? LIMIT 1').bind(app, id).first();
  try { return !!row && !JSON.parse(row.data || '{}').deleted; } catch (error) { return false; }
}

async function requestRow(env, app, key) {
  return env.DB.prepare('SELECT * FROM lesson_assignment_requests WHERE app=? AND request_key=? LIMIT 1').bind(app, key).first();
}

export async function handleLessonAssignmentRequest(env, app, body, origin, auth, json) {
  if (app !== 'task') return json({ ok: false, error: '이 기능은 직원 앱에서만 사용할 수 있습니다' }, 400, origin);
  const action = String(body.action || 'list');
  if (!['list', 'submit', 'cancel'].includes(action)) return json({ ok: false, error: 'action은 list, submit 또는 cancel이어야 합니다' }, 400, origin);
  const owner = auth.scope === 'own' ? auth.id : String(body.staffId || '');
  if (!SAFE_ID.test(owner)) return json({ ok: false, error: '개인 링크에서만 요청할 수 있습니다' }, 403, origin);
  if (auth.scope === 'all' && !await activeStaff(env, app, owner)) return json({ ok: false, error: '재직 중인 선생님을 선택해 주세요' }, 409, origin);
  if (action === 'list') {
    const result = await env.DB.prepare("SELECT * FROM lesson_assignment_requests WHERE app=? AND staff_id=? ORDER BY CASE status WHEN 'approval_waiting' THEN 0 WHEN 'rejected' THEN 1 ELSE 2 END, updated_at DESC LIMIT 100")
      .bind(app, owner).all();
    return json({ ok: true, requests: (result.results || []).map(view) }, 200, origin);
  }
  const studentName = text(body.studentName, MAX_NAME);
  const grade = text(body.grade, MAX_GRADE);
  if (!studentName || !grade) return json({ ok: false, error: '학생 이름과 학년을 입력해 주세요' }, 400, origin);
  const key = await keyFor(owner, studentName, grade);
  let current = await requestRow(env, app, key);
  const now = Date.now();
  if (action === 'cancel') {
    if (!current) return json({ ok: false, error: '취소할 배정 요청이 없습니다' }, 404, origin);
    if (current.status === 'cancelled') return json({ ok: true, idempotent: true, request: view(current) }, 200, origin);
    const changed = await env.DB.prepare("UPDATE lesson_assignment_requests SET status='cancelled', revision=revision+1, updated_at=? WHERE app=? AND request_key=? AND revision=? AND status='approval_waiting'")
      .bind(now, app, key, Number(current.revision)).run();
    if (Number(changed.meta && changed.meta.changes || 0) !== 1) return json({ ok: false, error: '요청 상태가 바뀌었습니다. 다시 확인해 주세요' }, 409, origin);
    current = await requestRow(env, app, key);
    return json({ ok: true, idempotent: false, request: view(current) }, 200, origin);
  }
  if (current && current.status === 'approval_waiting') return json({ ok: true, idempotent: true, request: view(current) }, 200, origin);
  if (!current) {
    await env.DB.prepare("INSERT INTO lesson_assignment_requests (app,request_key,staff_id,student_name,grade,student_id,revision,status,created_at,updated_at,reviewed_at,reviewed_by,review_note) VALUES (?,?,?,?,?,?,1,'approval_waiting',?,?,NULL,NULL,NULL)")
      .bind(app, key, owner, studentName, grade, null, now, now).run();
  } else {
    const changed = await env.DB.prepare("UPDATE lesson_assignment_requests SET student_name=?, grade=?, student_id=NULL, revision=revision+1, status='approval_waiting', updated_at=?, reviewed_at=NULL, reviewed_by=NULL, review_note=NULL WHERE app=? AND request_key=? AND revision=?")
      .bind(studentName, grade, now, app, key, Number(current.revision)).run();
    if (Number(changed.meta && changed.meta.changes || 0) !== 1) return json({ ok: false, error: '다른 변경이 먼저 저장되었습니다. 다시 시도해 주세요' }, 409, origin);
  }
  current = await requestRow(env, app, key);
  return json({ ok: true, idempotent: false, request: view(current) }, 200, origin);
}

export async function handleLessonAssignmentReview(env, app, body, origin, auth, json) {
  if (app !== 'task' || auth.scope !== 'all') return json({ ok: false, error: '원장만 검토할 수 있습니다' }, 403, origin);
  const action = String(body.action || 'list');
  if (action === 'list') {
    const result = await env.DB.prepare("SELECT * FROM lesson_assignment_requests WHERE app=? ORDER BY CASE status WHEN 'approval_waiting' THEN 0 WHEN 'rejected' THEN 1 ELSE 2 END, updated_at DESC LIMIT 200").bind(app).all();
    return json({ ok: true, requests: (result.results || []).map(view) }, 200, origin);
  }
  if (!['approve', 'reject'].includes(action)) return json({ ok: false, error: 'action은 list, approve 또는 reject이어야 합니다' }, 400, origin);
  const requestKey = String(body.requestKey || '');
  const revision = Number(body.revision);
  if (!SAFE_ID.test(requestKey) || !requestKey.startsWith('lar_') || !Number.isInteger(revision) || revision < 1) return json({ ok: false, error: '요청을 다시 선택해 주세요' }, 400, origin);
  let current = await requestRow(env, app, requestKey);
  if (!current) return json({ ok: false, error: '배정 요청을 찾을 수 없습니다' }, 404, origin);
  if (Number(current.revision) !== revision || current.status !== 'approval_waiting') return json({ ok: false, error: '요청 상태가 바뀌었습니다. 새로고침 후 다시 확인해 주세요' }, 409, origin);
  const now = Date.now();
  const reviewer = auth.role === 'manager' ? String(auth.id) : 'director';
  if (action === 'reject') {
    const note = text(body.note, MAX_NOTE);
    if (!note) return json({ ok: false, error: '반려 사유를 입력해 주세요' }, 400, origin);
    const changed = await env.DB.prepare("UPDATE lesson_assignment_requests SET status='rejected', updated_at=?, reviewed_at=?, reviewed_by=?, review_note=? WHERE app=? AND request_key=? AND revision=? AND status='approval_waiting'")
      .bind(now, now, reviewer, note, app, requestKey, revision).run();
    if (Number(changed.meta && changed.meta.changes || 0) !== 1) return json({ ok: false, error: '다른 변경이 먼저 저장되었습니다. 다시 확인해 주세요' }, 409, origin);
  } else {
    const studentId = String(body.studentId || '');
    if (!SAFE_ID.test(studentId)) return json({ ok: false, error: '원생 명단에서 학생을 선택해 주세요' }, 400, origin);
    if (!await activeStaff(env, app, String(current.staff_id))) return json({ ok: false, error: '요청한 선생님이 현재 재직 중이 아닙니다' }, 409, origin);
    const rosterRow = await env.DB.prepare('SELECT data,updated_at FROM private_rosters WHERE app=? LIMIT 1').bind(app).first();
    if (!rosterRow) return json({ ok: false, error: '원생 명단이 아직 준비되지 않았습니다' }, 409, origin);
    let document;
    try { document = JSON.parse(rosterRow.data || '{}'); } catch (error) { document = null; }
    const student = document && document.roster && Array.isArray(document.roster.students) && document.roster.students.find(item => item && item.id === studentId);
    if (!student) return json({ ok: false, error: '현재 원생 명단에서 학생을 다시 선택해 주세요' }, 409, origin);
    const identityMismatch = normalize(student.name) !== normalize(current.student_name) || normalize(student.grade) !== normalize(current.grade);
    if (identityMismatch && body.confirmIdentityMismatch !== true) {
      return json({ ok: false, code: 'IDENTITY_CONFIRM_REQUIRED', error: '요청 이름·학년과 선택한 원생이 달라 확인이 필요합니다' }, 409, origin);
    }
    const ids = Array.isArray(student.teacherIds) ? student.teacherIds : [];
    if (!ids.includes(String(current.staff_id))) student.teacherIds = ids.concat(String(current.staff_id));
    const review = env.DB.prepare("UPDATE lesson_assignment_requests SET status='approved', student_id=?, updated_at=?, reviewed_at=?, reviewed_by=?, review_note=NULL WHERE app=? AND request_key=? AND revision=? AND status='approval_waiting'")
      .bind(studentId, now, now, reviewer, app, requestKey, revision);
    const roster = env.DB.prepare('UPDATE private_rosters SET data=?,updated_at=? WHERE app=? AND updated_at=?')
      .bind(JSON.stringify(document), now, app, Number(rosterRow.updated_at));
    const applied = await env.DB.batch([roster, review]);
    if (Number(applied[0].meta && applied[0].meta.changes || 0) !== 1 || Number(applied[1].meta && applied[1].meta.changes || 0) !== 1) {
      return json({ ok: false, error: '명단 또는 요청 상태가 바뀌었습니다. 새로고침 후 다시 승인해 주세요' }, 409, origin);
    }
  }
  current = await requestRow(env, app, requestKey);
  return json({ ok: true, request: view(current) }, 200, origin);
}
