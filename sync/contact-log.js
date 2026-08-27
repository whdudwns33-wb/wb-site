const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CONTACT_TYPES = new Set(['call', 'msg', 'meet']);
const CONTACT_PREFIX = '__contact__';

function normalizeName(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('ko');
}

function isLesson(task) {
  return !!(task && !task.deleted && (task.taskKind === 'lesson_instruction' ||
    task.lessonFormVersion || task.intakeVersion));
}

function kstToday(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(now));
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return value.year + '-' + value.month + '-' + value.day;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function parseJson(value) {
  try { return JSON.parse(value); } catch (error) { return null; }
}

export async function handleContactLog(env, app, body, origin, auth, json) {
  if (app !== 'task') return json({ ok: false, error: '업무 화면에서만 연락 기록을 저장할 수 있습니다' }, 400, origin);
  if (body.action !== 'save') return json({ ok: false, error: '지원하지 않는 연락 기록 작업입니다' }, 400, origin);

  const sourceTaskId = String(body.sourceTaskId || '');
  const requestedStudentId = String(body.studentId || '');
  const type = String(body.type || '');
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  const hasTask = SAFE_ID.test(sourceTaskId);
  const directManager = !hasTask && auth.scope === 'all' && SAFE_ID.test(requestedStudentId);
  if ((!hasTask && !directManager) || !CONTACT_TYPES.has(type)) {
    return json({ ok: false, error: '수업과 연락 유형을 확인해 주세요' }, 422, origin);
  }
  if (typeof body.note !== 'string' || note.length > 200 || /[\u0000-\u001f\u007f]/.test(note)) {
    return json({ ok: false, error: '연락 메모는 한 줄 200자까지 입력할 수 있습니다' }, 422, origin);
  }

  let task = null;
  if (hasTask) {
    const taskRow = await env.DB.prepare('SELECT owner,data FROM tasks WHERE app=? AND id=? LIMIT 1')
      .bind(app, sourceTaskId).first();
    task = taskRow && parseJson(taskRow.data);
    if (!task || !isLesson(task)) {
      return json({ ok: false, error: '현재 등록된 실제 수업에서만 연락 기록을 남길 수 있습니다' }, 422, origin);
    }
    if (String(taskRow.owner || '') !== String(task.staffId || '')) {
      return json({ ok: false, error: '수업 담당 정보가 일치하지 않아 저장하지 않았습니다' }, 422, origin);
    }
    if (auth.scope === 'own' && (String(taskRow.owner || '') !== String(auth.id || '') ||
        String(task.staffId || '') !== String(auth.id || ''))) {
      return json({ ok: false, error: '담당 수업의 연락 기록만 작성할 수 있습니다' }, 422, origin);
    }
  }

  const rosterRow = await env.DB.prepare('SELECT data FROM private_rosters WHERE app=? LIMIT 1').bind(app).first();
  const document = rosterRow && parseJson(rosterRow.data);
  const students = document && document.roster && Array.isArray(document.roster.students)
    ? document.roster.students : [];
  if (!students.length) {
    return json({ ok: false, error: '담당 학생 명단을 확인할 수 없어 저장하지 않았습니다' }, 422, origin);
  }

  const taskStudentId = String(task && task.studentId || '');
  let student = directManager
    ? students.find(item => item && String(item.id || '') === requestedStudentId)
    : (taskStudentId ? students.find(item => item && String(item.id || '') === taskStudentId) : null);
  if (directManager && !student) {
    return json({ ok: false, error: '현재 학생 명단에서 대상을 확인할 수 없습니다' }, 422, origin);
  }
  if (!directManager) {
    if (taskStudentId && !student) {
      return json({ ok: false, error: '수업에 연결된 학생이 현재 명단에 없어 저장하지 않았습니다' }, 422, origin);
    }
    if (student && task.studentName && normalizeName(task.studentName) !== normalizeName(student.name)) {
      return json({ ok: false, error: '수업과 학생 명단의 정보가 일치하지 않습니다' }, 422, origin);
    }
    if (!student) {
      return json({ ok: false, error: '수업의 stable studentId 연결을 확인한 뒤 다시 저장해 주세요' }, 422, origin);
    }
  }

  const actorId = auth.id ? String(auth.id) : '__admin__';
  let actorName = auth.id ? '담당교사' : '대표';
  if (auth.id) {
    const staffRow = await env.DB.prepare('SELECT data FROM staff WHERE app=? AND id=? LIMIT 1')
      .bind(app, auth.id).first();
    const staff = staffRow && parseJson(staffRow.data);
    if (staff && staff.name) actorName = String(staff.name).trim().slice(0, 40) || actorName;
  }

  const now = Date.now();
  const date = kstToday(now);
  const studentId = String(student.id || '');
  if (!SAFE_ID.test(studentId)) {
    return json({ ok: false, error: '학생 식별 정보를 확인할 수 없어 저장하지 않았습니다' }, 422, origin);
  }
  const digest = await sha256Hex(actorId + '\n' + studentId);
  const taskId = CONTACT_PREFIX + digest.slice(0, 40);
  const key = taskId + '|' + date;
  const expectedUpdatedAt = Number(body.expectedUpdatedAt || 0);
  if (!Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt < 0) {
    return json({ ok: false, error: '연락 기록 버전을 확인해 주세요' }, 422, origin);
  }
  const currentRow = await env.DB.prepare(
    'SELECT owner,data,updated_at FROM checks WHERE app=? AND k=? LIMIT 1'
  ).bind(app, key).first();
  const currentUpdatedAt = Number(currentRow && currentRow.updated_at || 0);
  const currentRecord = currentRow && parseJson(currentRow.data);
  if (currentUpdatedAt !== expectedUpdatedAt) {
    return json({ ok: false, code: 'CONTACT_STALE',
      error: '다른 기기에서 연락 기록이 먼저 바뀌었습니다. 확인 후 다시 저장해 주세요',
      current: currentRecord ? { key, record: currentRecord } : null }, 409, origin);
  }
  const savedAt = Math.max(now, currentUpdatedAt + 1);
  const contact = {
    version: 1,
    studentId,
    sourceTaskId,
    date,
    type,
    note,
    by: actorName,
    byStaffId: auth.id ? String(auth.id) : '',
    at: savedAt
  };
  const record = { taskId, date, contact, updatedAt: savedAt };
  const result = currentRow
    ? await env.DB.prepare(
      'UPDATE checks SET owner=?,data=?,updated_at=?,srv_at=? WHERE app=? AND k=? AND updated_at=?'
    ).bind(auth.id || null, JSON.stringify(record), savedAt, savedAt, app, key, expectedUpdatedAt).run()
    : await env.DB.prepare(
      'INSERT OR IGNORE INTO checks (app,k,owner,data,updated_at,srv_at) VALUES (?,?,?,?,?,?)'
    ).bind(app, key, auth.id || null, JSON.stringify(record), savedAt, savedAt).run();
  if (Number(result && result.meta && result.meta.changes || 0) !== 1) {
    const latestRow = await env.DB.prepare(
      'SELECT owner,data,updated_at FROM checks WHERE app=? AND k=? LIMIT 1'
    ).bind(app, key).first();
    const latestRecord = latestRow && parseJson(latestRow.data);
    return json({ ok: false, code: 'CONTACT_STALE',
      error: '다른 기기에서 연락 기록이 먼저 바뀌었습니다. 확인 후 다시 저장해 주세요',
      current: latestRecord ? { key, record: latestRecord } : null }, 409, origin);
  }
  return json({ ok: true, key, record }, 200, origin);
}
