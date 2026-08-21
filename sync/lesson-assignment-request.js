import { buildLessonTask } from './lesson-create.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_NAME = 40;
const MAX_GRADE = 20;
const MAX_NOTE = 500;
const LESSON_HOURS = new Set(['1T', '1.5T', '2T', '3T', '4T', '5T', '6T']);
const SUBJECT_OPTIONS = new Set([
  '국어', '영어', '수학', '사회', '과학', '독해사고력', '독해력수업', '독해력훈련', '사고력수학', '질답', '클리닉'
]);

const text = (value, max) => String(value == null ? '' : value).normalize('NFKC').trim().slice(0, max);
const normalize = value => text(value, 200).replace(/\s+/g, '').toLocaleLowerCase('ko');

function parseDetails(value) {
  let parsed;
  try { parsed = JSON.parse(String(value || '')); } catch (error) { parsed = null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const subjects = Array.isArray(parsed.subjects)
    ? [...new Set(parsed.subjects.map(item => text(item, 40)).filter(item => SUBJECT_OPTIONS.has(item)))] : [];
  const scheduleSlots = Array.isArray(parsed.scheduleSlots) ? parsed.scheduleSlots.slice(0, 20).map(slot => ({
    days: Array.isArray(slot && slot.days) ? [...new Set(slot.days.map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b) : [],
    startTime: text(slot && slot.startTime, 5), endTime: text(slot && slot.endTime, 5)
  })) : [];
  const startDate = text(parsed.startDate, 10);
  const lessonHours = text(parsed.lessonHours, 4);
  if (!subjects.length || !scheduleSlots.length || !startDate || !LESSON_HOURS.has(lessonHours)) return null;
  return { subjects, lessonHours, scheduleSlots, startDate, reason: text(parsed.reason, MAX_NOTE) };
}

function parseMissingDetails(value) {
  let parsed;
  try { parsed = JSON.parse(String(value || '')); } catch (error) { parsed = null; }
  if (!parsed || parsed.kind !== 'missing') return null;
  const school = text(parsed.school, 80);
  const reason = text(parsed.reason, MAX_NOTE);
  return school && reason ? { school, reason } : null;
}

const view = row => row && ({
  requestKey: String(row.request_key), staffId: String(row.staff_id), studentName: String(row.student_name),
  grade: String(row.grade), studentId: row.student_id == null ? '' : String(row.student_id),
  revision: Number(row.revision), status: String(row.status), createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at), reviewedAt: row.reviewed_at == null ? null : Number(row.reviewed_at),
  reviewNote: row.review_note == null ? '' : String(row.review_note), details: parseDetails(row.request_data),
  missing: parseMissingDetails(row.request_data)
});

async function keyFor(staffId, identity) {
  const raw = [staffId, normalize(identity)].join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return 'lar_' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 48);
}

async function activeStaffRecord(env, app, id) {
  const row = await env.DB.prepare('SELECT data FROM staff WHERE app=? AND id=? LIMIT 1').bind(app, id).first();
  if (!row) return null;
  try {
    const staff = JSON.parse(row.data || '{}');
    return staff && !staff.deleted ? staff : null;
  } catch (error) { return null; }
}

async function requestRow(env, app, key) {
  return env.DB.prepare('SELECT * FROM lesson_assignment_requests WHERE app=? AND request_key=? LIMIT 1').bind(app, key).first();
}

async function rosterRow(env, app) {
  const row = await env.DB.prepare('SELECT data,updated_at FROM private_rosters WHERE app=? LIMIT 1').bind(app).first();
  if (!row) return null;
  try {
    const document = JSON.parse(row.data || '{}');
    if (!document || !document.roster || !Array.isArray(document.roster.students)) return null;
    return { document, updatedAt: Number(row.updated_at) };
  } catch (error) { return null; }
}

function currentMonth() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit' })
    .format(new Date()).slice(0, 7);
}

function isActiveStudent(student) {
  const month = currentMonth();
  const transition = /^(휴원|퇴원)\s+\d{4}-\d{2}-\d{2}(?:\s|$)/.test(String(student && student.reason || ''));
  return !!student && SAFE_ID.test(String(student.id || '')) && !transition &&
    (!student.start || String(student.start) <= month) && (!student.end || String(student.end) > month);
}

function studentSubjects(student) {
  const values = Array.isArray(student && student.subjects)
    ? student.subjects : String(student && student.subject || '').split(/[·,/]/);
  return [...new Set(values.map(item => text(item, 40)).filter(item => SUBJECT_OPTIONS.has(item)))];
}

function lastFour(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits ? digits.slice(-4) : '';
}

function candidateViews(students, owner) {
  const active = students.filter(isActiveStudent);
  const identityCounts = new Map();
  active.forEach(student => {
    const key = [normalize(student.name), normalize(student.school), normalize(student.grade)].join('|');
    identityCounts.set(key, (identityCounts.get(key) || 0) + 1);
  });
  return active.map(student => {
    const key = [normalize(student.name), normalize(student.school), normalize(student.grade)].join('|');
    const duplicate = (identityCounts.get(key) || 0) > 1;
    const hints = duplicate ? [lastFour(student.phoneFather), lastFour(student.phoneMother)].filter(Boolean) : [];
    const teacherIds = Array.isArray(student.teacherIds) ? student.teacherIds.map(String).filter(id => SAFE_ID.test(id)) : [];
    return {
      id: String(student.id), name: text(student.name, MAX_NAME), school: text(student.school, 80),
      grade: text(student.grade, MAX_GRADE), subjects: studentSubjects(student), teacherIds,
      assigned: teacherIds.includes(owner), contactHint: hints.length ? [...new Set(hints)].join(' · ') : ''
    };
  }).sort((left, right) => left.name.localeCompare(right.name, 'ko') || left.school.localeCompare(right.school, 'ko') ||
    left.grade.localeCompare(right.grade, 'ko') || left.id.localeCompare(right.id));
}

async function normalizedRequestDetails(student, body, staffId) {
  const subjects = Array.isArray(body.subjects)
    ? [...new Set(body.subjects.map(item => text(item, 40)).filter(item => SUBJECT_OPTIONS.has(item)))] : [];
  if (!subjects.length) throw new Error('요청할 과목을 선택해 주세요');
  if (!text(student.grade, MAX_GRADE)) throw new Error('관리자가 원생 정보에 학년을 먼저 입력해야 합니다');
  const reason = text(body.reason, MAX_NOTE);
  if (!reason) throw new Error('배정 요청 사유를 입력해 주세요');
  const lessonHours = text(body.lessonHours, 4);
  if (!LESSON_HOURS.has(lessonHours)) throw new Error('수업시수를 선택해 주세요');
  const task = await buildLessonTask({
    studentId: String(student.id), studentName: text(student.name, MAX_NAME), grade: text(student.grade, MAX_GRADE),
    subject: subjects.join('·'), className: '', lessonRole: subjects.join('·'), lessonHours, scheduleText: '',
    scheduleSlots: body.scheduleSlots, start: body.startDate,
    materials: '없음', onlineProgram: '없음', homework: '없음', studentTraits: '없음', goal: '없음', parentRequest: '없음', adminRequest: '없음'
  }, staffId, 'staff', Date.now());
  return {
    subjects, lessonHours,
    scheduleSlots: task.scheduleSlots.map(slot => ({ days: slot.days, startTime: slot.startTime, endTime: slot.endTime })),
    startDate: task.start,
    reason
  };
}

async function requestedLesson(student, details, staffId, serverNow) {
  return buildLessonTask({
    studentId: String(student.id), studentName: text(student.name, MAX_NAME), grade: text(student.grade, MAX_GRADE),
    subject: details.subjects.join('·'), className: '', lessonRole: details.subjects.join('·'), lessonHours: details.lessonHours, scheduleText: '',
    scheduleSlots: details.scheduleSlots, start: details.startDate,
    materials: '없음', onlineProgram: '없음', homework: '없음', studentTraits: '없음', goal: '없음', parentRequest: '없음', adminRequest: '없음'
  }, staffId, 'manager', serverNow);
}

function parseTaskRow(row) {
  if (!row) return null;
  try { return { task: JSON.parse(row.data || '{}'), updatedAt: Number(row.updated_at) }; } catch (error) { return null; }
}

export async function handleLessonAssignmentRequest(env, app, body, origin, auth, json) {
  if (app !== 'task') return json({ ok: false, error: '이 기능은 직원 앱에서만 사용할 수 있습니다' }, 400, origin);
  const action = String(body.action || 'list');
  if (!['list', 'submit', 'submit_missing', 'cancel'].includes(action)) return json({ ok: false, error: 'action은 list, submit, submit_missing 또는 cancel이어야 합니다' }, 400, origin);
  const owner = auth.scope === 'own' ? auth.id : String(body.staffId || '');
  if (!SAFE_ID.test(owner)) return json({ ok: false, error: '개인 링크에서만 요청할 수 있습니다' }, 403, origin);
  if (!await activeStaffRecord(env, app, owner)) return json({ ok: false, error: '재직 중인 선생님을 선택해 주세요' }, 409, origin);

  if (action === 'list') {
    const [result, roster] = await Promise.all([
      env.DB.prepare("SELECT * FROM lesson_assignment_requests WHERE app=? AND staff_id=? ORDER BY CASE status WHEN 'approval_waiting' THEN 0 WHEN 'rejected' THEN 1 ELSE 2 END, updated_at DESC LIMIT 100")
        .bind(app, owner).all(),
      rosterRow(env, app)
    ]);
    return json({ ok: true, requests: (result.results || []).map(view), candidates: roster ? candidateViews(roster.document.roster.students, owner) : [] }, 200, origin);
  }

  if (action === 'cancel') {
    const requestKey = String(body.requestKey || '');
    const revision = Number(body.revision);
    if (!SAFE_ID.test(requestKey) || !requestKey.startsWith('lar_') || !Number.isInteger(revision)) {
      return json({ ok: false, error: '취소할 요청을 다시 선택해 주세요' }, 400, origin);
    }
    const current = await requestRow(env, app, requestKey);
    if (!current || String(current.staff_id) !== owner) return json({ ok: false, error: '취소할 배정 요청이 없습니다' }, 404, origin);
    if (current.status === 'cancelled') return json({ ok: true, idempotent: true, request: view(current) }, 200, origin);
    const changed = await env.DB.prepare("UPDATE lesson_assignment_requests SET status='cancelled', revision=revision+1, updated_at=? WHERE app=? AND request_key=? AND revision=? AND status='approval_waiting'")
      .bind(Date.now(), app, requestKey, revision).run();
    if (Number(changed.meta && changed.meta.changes || 0) !== 1) return json({ ok: false, error: '요청 상태가 바뀌었습니다. 다시 확인해 주세요' }, 409, origin);
    return json({ ok: true, idempotent: false, request: view(await requestRow(env, app, requestKey)) }, 200, origin);
  }

  if (action === 'submit_missing') {
    const studentName = text(body.studentName, MAX_NAME);
    const school = text(body.school, 80);
    const grade = text(body.grade, MAX_GRADE);
    const reason = text(body.reason, MAX_NOTE);
    if (!studentName || !school || !grade || !reason) return json({ ok: false, error: '이름·학교·학년·요청 사유를 모두 입력해 주세요' }, 400, origin);
    const key = await keyFor(owner, ['missing', studentName, school, grade].join('|'));
    let current = await requestRow(env, app, key);
    const now = Date.now();
    const requestData = JSON.stringify({ kind: 'missing', school, reason });
    if (!current) {
      await env.DB.prepare("INSERT INTO lesson_assignment_requests (app,request_key,staff_id,student_name,grade,student_id,revision,status,created_at,updated_at,reviewed_at,reviewed_by,review_note,request_data) VALUES (?,?,?,?,?,NULL,1,'approval_waiting',?,?,NULL,NULL,NULL,?)")
        .bind(app, key, owner, studentName, grade, now, now, requestData).run();
    } else if (current.status === 'approval_waiting' && String(current.request_data || '') === requestData) {
      return json({ ok: true, idempotent: true, request: view(current) }, 200, origin);
    } else {
      const changed = await env.DB.prepare("UPDATE lesson_assignment_requests SET student_name=?, grade=?, student_id=NULL, request_data=?, revision=revision+1, status='approval_waiting', updated_at=?, reviewed_at=NULL, reviewed_by=NULL, review_note=NULL WHERE app=? AND request_key=? AND revision=?")
        .bind(studentName, grade, requestData, now, app, key, Number(current.revision)).run();
      if (Number(changed.meta && changed.meta.changes || 0) !== 1) return json({ ok: false, error: '다른 변경이 먼저 저장되었습니다. 다시 시도해 주세요' }, 409, origin);
    }
    return json({ ok: true, idempotent: false, request: view(await requestRow(env, app, key)) }, 200, origin);
  }

  const studentId = String(body.studentId || '');
  if (!SAFE_ID.test(studentId)) return json({ ok: false, error: '재원생 명단에서 학생을 선택해 주세요' }, 400, origin);
  const roster = await rosterRow(env, app);
  if (!roster) return json({ ok: false, error: '원생 명단이 아직 준비되지 않았습니다' }, 409, origin);
  const student = roster.document.roster.students.find(item => item && String(item.id) === studentId && isActiveStudent(item));
  if (!student) return json({ ok: false, error: '현재 재원생 명단에서 학생을 다시 선택해 주세요' }, 409, origin);
  if (Array.isArray(student.teacherIds) && student.teacherIds.map(String).includes(owner)) {
    return json({ ok: false, error: '이미 담당 원생으로 연결된 학생입니다' }, 409, origin);
  }
  let details;
  try { details = await normalizedRequestDetails(student, body, owner); }
  catch (error) { return json({ ok: false, error: String(error && error.message || error) }, Number(error && error.status) || 400, origin); }

  const key = await keyFor(owner, 'student-id:' + studentId);
  let current = await requestRow(env, app, key);
  const now = Date.now();
  const requestData = JSON.stringify(details);
  if (!current) {
    await env.DB.prepare("INSERT INTO lesson_assignment_requests (app,request_key,staff_id,student_name,grade,student_id,revision,status,created_at,updated_at,reviewed_at,reviewed_by,review_note,request_data) VALUES (?,?,?,?,?,?,1,'approval_waiting',?,?,NULL,NULL,NULL,?)")
      .bind(app, key, owner, text(student.name, MAX_NAME), text(student.grade, MAX_GRADE), studentId, now, now, requestData).run();
  } else if (current.status === 'approval_waiting' && String(current.request_data || '') === requestData) {
    return json({ ok: true, idempotent: true, request: view(current) }, 200, origin);
  } else {
    const changed = await env.DB.prepare("UPDATE lesson_assignment_requests SET student_name=?, grade=?, student_id=?, request_data=?, revision=revision+1, status='approval_waiting', updated_at=?, reviewed_at=NULL, reviewed_by=NULL, review_note=NULL WHERE app=? AND request_key=? AND revision=?")
      .bind(text(student.name, MAX_NAME), text(student.grade, MAX_GRADE), studentId, requestData, now, app, key, Number(current.revision)).run();
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
    return json({ ok: true, request: view(await requestRow(env, app, requestKey)) }, 200, origin);
  }

  const details = parseDetails(current.request_data);
  const missing = parseMissingDetails(current.request_data);
  const modernStudentId = String(current.student_id || '');
  if (modernStudentId && !details) {
    return json({ ok: false, error: '이 요청에는 수업시수가 없습니다. 선생님이 요청을 취소한 뒤 다시 제출해 주세요' }, 409, origin);
  }
  const studentId = modernStudentId || String(body.studentId || '');
  if (!SAFE_ID.test(studentId)) return json({ ok: false, error: '원생 명단에서 학생을 선택해 주세요' }, 400, origin);
  const staff = await activeStaffRecord(env, app, String(current.staff_id));
  if (!staff) return json({ ok: false, error: '요청한 선생님이 현재 재직 중이 아닙니다' }, 409, origin);
  const roster = await rosterRow(env, app);
  if (!roster) return json({ ok: false, error: '원생 명단이 아직 준비되지 않았습니다' }, 409, origin);
  const student = roster.document.roster.students.find(item => item && String(item.id) === studentId && isActiveStudent(item));
  if (!student) return json({ ok: false, error: '현재 재원생 명단에서 학생을 다시 선택해 주세요' }, 409, origin);
  if (!details) {
    const identityMismatch = normalize(student.name) !== normalize(current.student_name) || normalize(student.grade) !== normalize(current.grade) ||
      (!!missing && normalize(student.school) !== normalize(missing.school));
    if (identityMismatch && body.confirmIdentityMismatch !== true) {
      return json({ ok: false, code: 'IDENTITY_CONFIRM_REQUIRED', error: '요청 이름·학년과 선택한 원생이 달라 확인이 필요합니다' }, 409, origin);
    }
  }

  const teacherIds = Array.isArray(student.teacherIds) ? student.teacherIds.map(String) : [];
  if (!teacherIds.includes(String(current.staff_id))) teacherIds.push(String(current.staff_id));
  student.teacherIds = [...new Set(teacherIds)];
  const teacherNames = String(student.teacher || '').split(/[·,]/).map(item => item.trim()).filter(Boolean);
  if (staff.name && !teacherNames.includes(String(staff.name))) teacherNames.push(String(staff.name));
  student.teacher = teacherNames.join('·');

  let task = null;
  let taskStatement = null;
  if (details) {
    const subjects = [...new Set(studentSubjects(student).concat(details.subjects))];
    student.subjects = subjects;
    student.subject = subjects.join('·');
    try { task = await requestedLesson(student, details, String(current.staff_id), now); }
    catch (error) { return json({ ok: false, error: String(error && error.message || error) }, Number(error && error.status) || 400, origin); }
    const existing = parseTaskRow(await env.DB.prepare('SELECT data,updated_at FROM tasks WHERE app=? AND id=? AND owner=? LIMIT 1')
      .bind(app, task.id, String(current.staff_id)).first());
    if (!existing) {
      taskStatement = env.DB.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
        .bind(app, task.id, String(current.staff_id), JSON.stringify(task), task.updatedAt, task.updatedAt);
    } else if (existing.task.deleted) {
      task = { ...task, createdAt: existing.task.createdAt || task.createdAt, updatedAt: Math.max(now, Number(existing.task.updatedAt || 0) + 1) };
      taskStatement = env.DB.prepare('UPDATE tasks SET data=?,updated_at=?,srv_at=? WHERE app=? AND id=? AND owner=? AND updated_at=?')
        .bind(JSON.stringify(task), task.updatedAt, task.updatedAt, app, task.id, String(current.staff_id), existing.updatedAt);
    } else {
      task = existing.task;
    }
  }

  roster.document.roster.updated = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date(now));
  const statements = [
    env.DB.prepare('UPDATE private_rosters SET data=?,updated_at=? WHERE app=? AND updated_at=?')
      .bind(JSON.stringify(roster.document), now, app, roster.updatedAt)
  ];
  if (taskStatement) statements.push(taskStatement);
  statements.push(env.DB.prepare("UPDATE lesson_assignment_requests SET status='approved', student_id=?, updated_at=?, reviewed_at=?, reviewed_by=?, review_note=NULL WHERE app=? AND request_key=? AND revision=? AND status='approval_waiting'")
    .bind(studentId, now, now, reviewer, app, requestKey, revision));
  const applied = await env.DB.batch(statements);
  if (applied.some(result => Number(result.meta && result.meta.changes || 0) !== 1)) {
    return json({ ok: false, error: '명단·수업 또는 요청 상태가 바뀌었습니다. 새로고침 후 다시 승인해 주세요' }, 409, origin);
  }
  current = await requestRow(env, app, requestKey);
  return json({ ok: true, request: view(current), task }, 200, origin);
}
