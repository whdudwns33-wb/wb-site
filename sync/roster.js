import { studentChangeActorKey, studentChangeEventId, studentChangeEventStatement } from './student-change.js';
import { buildLessonTask } from './lesson-create.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const NEW_STUDENT_ID = /^[1-9]\d{7}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_STUDENTS = 2000;
const MAX_BOOK_STUDENTS = 5000;
const ROSTER_SUBJECTS = new Set([
  '국어', '영어', '수학', '사회', '과학', '독해사고력', '독해력수업', '독해력훈련', '사고력수학', '질답'
]);

function nextMonthForDate(value) {
  const [year, monthValue] = String(value || '').slice(0, 7).split('-').map(Number);
  const monthIndex = year * 12 + monthValue;
  return String(Math.floor(monthIndex / 12)) + '-' + String(monthIndex % 12 + 1).padStart(2, '0');
}

function rosterTransition(student) {
  const match = String(student && student.reason || '').match(/^(휴원|퇴원)\s+(\d{4}-\d{2}-\d{2})(?:\s*·\s*(.*))?$/);
  if (!match) return null;
  return { operation: match[1] === '휴원' ? 'leave' : 'withdrawal', effectiveDate: match[2], note: match[3] || '' };
}

function isLessonTask(value) {
  return !!value && (value.taskKind === 'lesson_instruction' || value.lessonFormVersion || value.intakeVersion ||
    /^\[수업\]/.test(String(value.title || '')));
}

async function activeStaffRecord(env, app, staffId) {
  if (!SAFE_ID.test(String(staffId || ''))) return null;
  const row = await env.DB.prepare('SELECT data FROM staff WHERE app=? AND id=? LIMIT 1').bind(app, staffId).first();
  if (!row) return null;
  try {
    const data = JSON.parse(row.data || '{}');
    return data && !data.deleted && String(data.name || '').trim() ? { id: String(staffId), name: String(data.name).trim() } : null;
  } catch (error) { return null; }
}

function randomEightDigitStudentId() {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return String(10000000 + Math.floor((values[0] / 4294967296) * 90000000));
}

export function allocateNewStudentId(reservedIds, makeCandidate = randomEightDigitStudentId) {
  if (!(reservedIds instanceof Set) || typeof makeCandidate !== 'function') {
    throw new Error('STUDENT_ID_GENERATION_INVALID');
  }
  for (let attempt = 0; attempt < 128; attempt++) {
    const candidate = String(makeCandidate());
    if (NEW_STUDENT_ID.test(candidate) && !reservedIds.has(candidate)) {
      reservedIds.add(candidate);
      return candidate;
    }
  }
  throw new Error('STUDENT_ID_GENERATION_FAILED');
}

function isBoardingLockError(error) {
  return /BOARDING_LOCK/.test(String(error && error.message || error || ''));
}

function isActiveBookOrderConflictError(error) {
  return /ACTIVE_BOOK_ORDER_CONFLICT/.test(String(error && error.message || error || ''));
}

function fail(path, message) {
  throw new Error(path + ': ' + message);
}

function record(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, '객체여야 합니다');
  return value;
}

function shape(value, required, optional, path) {
  record(value, path);
  const allowed = new Set(required.concat(optional || []));
  required.forEach(key => {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(path + '.' + key, '필수 항목입니다');
  });
  Object.keys(value).forEach(key => {
    if (!allowed.has(key)) fail(path + '.' + key, '허용되지 않은 항목입니다');
  });
}

function text(value, path, max, empty) {
  if (typeof value !== 'string') fail(path, '문자열이어야 합니다');
  const normalized = value.trim();
  if (!empty && !normalized) fail(path, '비어 있을 수 없습니다');
  if (normalized.length > max) fail(path, max + '자를 넘을 수 없습니다');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) fail(path, '제어 문자를 포함할 수 없습니다');
  return normalized;
}

function id(value, path) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) fail(path, '올바른 ID가 아닙니다');
  return value;
}

function isoDate(value, path) {
  const result = text(value, path, 10, false);
  const parsed = new Date(result + 'T00:00:00Z');
  if (!ISO_DATE.test(result) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) {
    fail(path, 'YYYY-MM-DD 형식의 실제 날짜여야 합니다');
  }
  return result;
}

function month(value, path, empty) {
  const result = text(value, path, 7, empty);
  if (result && !YEAR_MONTH.test(result)) fail(path, 'YYYY-MM 형식이어야 합니다');
  return result;
}

function optionalIsoDate(value, path) {
  if (typeof value !== 'string') fail(path, '문자열이어야 합니다');
  return value.trim() ? isoDate(value, path) : '';
}

function phone(value, path) {
  const result = text(value, path, 30, true);
  if (!result) return '';
  const digits = result.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15 || /[^0-9+()\-\s]/.test(result)) {
    fail(path, '8~15자리 연락처를 확인해 주세요');
  }
  return result;
}

function subjects(value, path) {
  if (!Array.isArray(value) || value.length > ROSTER_SUBJECTS.size) {
    fail(path, '등록과목 배열을 확인해 주세요');
  }
  const result = value.map((item, index) => text(item, path + '[' + index + ']', 20, false));
  if (new Set(result).size !== result.length) fail(path, '중복 과목이 있습니다');
  if (result.some(item => !ROSTER_SUBJECTS.has(item))) fail(path, '등록할 수 없는 과목이 있습니다');
  return result;
}

function teacherIds(value, path, empty) {
  if (!Array.isArray(value) || (!empty && !value.length) || value.length > 20) {
    fail(path, (empty ? '0~20개' : '1~20개') + '의 직원 ID 배열이어야 합니다');
  }
  const result = value.map((item, index) => id(item, path + '[' + index + ']'));
  if (new Set(result).size !== result.length) fail(path, '중복 ID가 있습니다');
  return result;
}

function identityText(value) {
  return String(value == null ? '' : value).normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('ko');
}

function identityPhone(value) {
  return String(value == null ? '' : value).replace(/\D/g, '');
}

export function studentRegistrationIdentityKey(value) {
  const parentPhones = [...new Set([identityPhone(value && value.phoneFather), identityPhone(value && value.phoneMother)].filter(Boolean))].sort();
  return [identityText(value && value.name), identityText(value && value.school), identityText(value && value.grade), parentPhones.join(',')].join('\u0000');
}

function rosterStudent(value, index) {
  const path = 'document.roster.students[' + index + ']';
  shape(value,
    ['id', 'name', 'grade', 'teacher', 'subject', 'start', 'end', 'reason', 'teacherIds'],
    ['memo', 'entryType', 'school', 'phoneSelf', 'phoneFather', 'phoneMother',
      'registrationDate', 'firstClassDate', 'subjects'], path);
  const start = month(value.start, path + '.start', false);
  const end = month(value.end, path + '.end', true);
  if (end && end < start) fail(path + '.end', '시작월보다 빠를 수 없습니다');
  const result = {
    id: id(value.id, path + '.id'),
    name: text(value.name, path + '.name', 40, false),
    grade: text(value.grade, path + '.grade', 20, true),
    teacher: text(value.teacher, path + '.teacher', 200, true),
    subject: text(value.subject, path + '.subject', 200, true),
    start,
    end,
    reason: text(value.reason, path + '.reason', 500, true),
    teacherIds: teacherIds(value.teacherIds, path + '.teacherIds', true)
  };
  if (Object.prototype.hasOwnProperty.call(value, 'memo')) result.memo = text(value.memo, path + '.memo', 1000, true);
  if (Object.prototype.hasOwnProperty.call(value, 'school')) result.school = text(value.school, path + '.school', 80, true);
  if (Object.prototype.hasOwnProperty.call(value, 'phoneSelf')) result.phoneSelf = phone(value.phoneSelf, path + '.phoneSelf');
  if (Object.prototype.hasOwnProperty.call(value, 'phoneFather')) result.phoneFather = phone(value.phoneFather, path + '.phoneFather');
  if (Object.prototype.hasOwnProperty.call(value, 'phoneMother')) result.phoneMother = phone(value.phoneMother, path + '.phoneMother');
  if (Object.prototype.hasOwnProperty.call(value, 'registrationDate')) {
    result.registrationDate = optionalIsoDate(value.registrationDate, path + '.registrationDate');
  }
  if (Object.prototype.hasOwnProperty.call(value, 'firstClassDate')) {
    result.firstClassDate = optionalIsoDate(value.firstClassDate, path + '.firstClassDate');
  }
  if (Object.prototype.hasOwnProperty.call(value, 'subjects')) {
    result.subjects = subjects(value.subjects, path + '.subjects');
    result.subject = result.subjects.join('·');
  }
  if (Object.prototype.hasOwnProperty.call(value, 'entryType')) {
    if (!['existing', 'new'].includes(value.entryType)) fail(path + '.entryType', 'existing 또는 new여야 합니다');
    result.entryType = value.entryType;
  }
  return result;
}

function bookStudent(value, index, rosterById) {
  const path = 'document.bookStudents[' + index + ']';
  shape(value,
    ['id', 'studentId', 'name', 'teacher', 'bookId', 'at', 'perWeek', 'goal', 'teacherIds'],
    [], path);
  const studentId = id(value.studentId, path + '.studentId');
  const student = rosterById.get(studentId);
  if (!student) fail(path + '.studentId', 'roster에 없는 학생입니다');
  const name = text(value.name, path + '.name', 40, false);
  if (name !== student.name) fail(path + '.name', 'roster의 학생 이름과 다릅니다');
  const teachers = teacherIds(value.teacherIds, path + '.teacherIds');
  if (teachers.some(teacherId => !student.teacherIds.includes(teacherId))) {
    fail(path + '.teacherIds', 'roster 담당자에 없는 직원이 포함되어 있습니다');
  }
  if (!Number.isInteger(value.perWeek) || value.perWeek < 1 || value.perWeek > 14) {
    fail(path + '.perWeek', '1~14 사이의 정수여야 합니다');
  }
  return {
    id: id(value.id, path + '.id'),
    studentId,
    name,
    teacher: text(value.teacher, path + '.teacher', 200, false),
    bookId: id(value.bookId, path + '.bookId'),
    at: text(value.at, path + '.at', 500, true),
    perWeek: value.perWeek,
    goal: text(value.goal, path + '.goal', 1000, true),
    teacherIds: teachers
  };
}

export function validateRosterDocument(value) {
  shape(value, ['roster', 'bookStudents'], [], 'document');
  shape(value.roster, ['updated', 'baseline', 'students'], ['note'], 'document.roster');
  if (!Array.isArray(value.roster.students) || value.roster.students.length > MAX_STUDENTS) {
    fail('document.roster.students', '배열이어야 하며 ' + MAX_STUDENTS + '명을 넘을 수 없습니다');
  }
  if (!Array.isArray(value.bookStudents) || value.bookStudents.length > MAX_BOOK_STUDENTS) {
    fail('document.bookStudents', '배열이어야 하며 ' + MAX_BOOK_STUDENTS + '건을 넘을 수 없습니다');
  }

  const students = value.roster.students.map(rosterStudent);
  const rosterById = new Map();
  students.forEach(student => {
    if (rosterById.has(student.id)) fail('document.roster.students', '중복 id가 있습니다: ' + student.id);
    rosterById.set(student.id, student);
  });

  const bookStudents = value.bookStudents.map((item, index) => bookStudent(item, index, rosterById));
  const allIds = new Set(rosterById.keys());
  bookStudents.forEach(item => {
    if (allIds.has(item.id)) fail('document.bookStudents', '중복 id가 있습니다: ' + item.id);
    allIds.add(item.id);
  });

  const roster = {
    updated: isoDate(value.roster.updated, 'document.roster.updated'),
    baseline: month(value.roster.baseline, 'document.roster.baseline', false),
    students
  };
  if (Object.prototype.hasOwnProperty.call(value.roster, 'note')) {
    roster.note = text(value.roster.note, 'document.roster.note', 2000, true);
  }
  const document = { roster, bookStudents };
  if (new TextEncoder().encode(JSON.stringify(document)).length > MAX_DOCUMENT_BYTES) {
    fail('document', MAX_DOCUMENT_BYTES + '바이트를 넘을 수 없습니다');
  }
  return document;
}

function withoutTeacherIds(item) {
  const result = { ...item };
  delete result.teacherIds;
  return result;
}

function responseDocument(document, auth) {
  const allowed = item => auth.scope === 'all' || item.teacherIds.includes(auth.id);
  return {
    studentSelectionScope: auth.scope === 'all' ? 'all_active' : 'assigned',
    roster: {
      ...document.roster,
      students: document.roster.students.filter(allowed).map(withoutTeacherIds)
    },
    bookStudents: document.bookStudents.filter(allowed).map(withoutTeacherIds)
  };
}

async function studentIdentityHash(studentId, studentName) {
  const normalized = String(studentName || '').normalize('NFKC').trim();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(studentId) + '\n' + normalized));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function activeBookIssueConflicts(env, app, document) {
  const result = await env.DB.prepare(
    "SELECT assignment_id,student_id,book_id,student_identity_hash,status FROM book_issues " +
    "WHERE app=? AND status IN ('prepared','issued')"
  ).bind(app).all();
  const assignments = new Map(document.bookStudents.map(item => [item.id, item]));
  const students = new Map(document.roster.students.map(item => [item.id, item]));
  const conflicts = [];
  for (const row of result.results || []) {
    const assignment = assignments.get(String(row.assignment_id));
    if (!assignment) {
      conflicts.push({ assignmentId: String(row.assignment_id), status: String(row.status), reason: 'removed' });
      continue;
    }
    const student = students.get(assignment.studentId);
    const hash = student ? await studentIdentityHash(student.id, student.name) : '';
    if (assignment.studentId !== String(row.student_id) || assignment.bookId !== String(row.book_id) ||
        hash !== String(row.student_identity_hash)) {
      conflicts.push({ assignmentId: String(row.assignment_id), status: String(row.status), reason: 'identity_changed' });
    }
  }
  return conflicts;
}

async function activeBookOrderConflicts(env, app, document) {
  const [result, currentRow] = await Promise.all([
    env.DB.prepare(
    'SELECT DISTINCT snapshot.task_id,snapshot.student_id,snapshot.student_identity_hash ' +
    'FROM book_order_student_snapshots snapshot WHERE snapshot.app=? ' +
    'AND NOT EXISTS (SELECT 1 FROM book_order_cancellations cancellation ' +
      'WHERE cancellation.app=snapshot.app AND cancellation.task_id=snapshot.task_id) ' +
    'AND NOT EXISTS (SELECT 1 FROM book_order_fulfillments fulfillment ' +
      'WHERE fulfillment.app=snapshot.app AND fulfillment.task_id=snapshot.task_id ' +
        'AND fulfillment.item_index=snapshot.item_index AND fulfillment.book_id=snapshot.book_id ' +
        "AND fulfillment.status='academy_registered' AND json_valid(fulfillment.student_ids) " +
        'AND (SELECT COUNT(*) FROM book_order_student_snapshots expected ' +
          'WHERE expected.app=snapshot.app AND expected.task_id=snapshot.task_id ' +
            'AND expected.item_index=snapshot.item_index AND expected.book_id=snapshot.book_id) ' +
          '=json_array_length(fulfillment.student_ids) ' +
        'AND NOT EXISTS (SELECT 1 FROM book_order_student_snapshots expected ' +
          'WHERE expected.app=snapshot.app AND expected.task_id=snapshot.task_id ' +
            'AND expected.item_index=snapshot.item_index AND expected.book_id=snapshot.book_id ' +
            'AND NOT EXISTS (SELECT 1 FROM json_each(fulfillment.student_ids) selected ' +
              'WHERE selected.value=expected.student_id)))'
    ).bind(app).all(),
    env.DB.prepare('SELECT data FROM private_rosters WHERE app=? LIMIT 1').bind(app).first()
  ]);
  const students = new Map(document.roster.students.map(item => [item.id, item]));
  let currentStudents = new Map();
  try {
    const current = currentRow && validateRosterDocument(JSON.parse(currentRow.data));
    currentStudents = new Map((current && current.roster.students || []).map(item => [item.id, item]));
  } catch (error) { /* 손상된 현재 명단은 pending identity 변경을 허용하지 않는다 */ }
  const month = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
  const conflicts = [];
  for (const row of result.results || []) {
    const student = students.get(String(row.student_id));
    const active = student && student.start <= month && (!student.end || student.end > month);
    const current = currentStudents.get(String(row.student_id));
    const unchangedEnrollmentWindow = student && current && student.start === current.start && student.end === current.end;
    const hash = student ? await studentIdentityHash(student.id, student.name) : '';
    if ((!active && !unchangedEnrollmentWindow) || hash !== String(row.student_identity_hash || '')) {
      conflicts.push({ taskId: String(row.task_id), studentId: String(row.student_id),
        reason: student ? 'identity_changed_or_inactivated' : 'removed' });
    }
  }
  return conflicts;
}

async function inactiveTeacherIds(env, app, document) {
  const used = new Set();
  document.roster.students.forEach(item => item.teacherIds.forEach(id => used.add(id)));
  document.bookStudents.forEach(item => item.teacherIds.forEach(id => used.add(id)));
  if (!used.size) return [];
  const result = await env.DB.prepare('SELECT id,data FROM staff WHERE app=?').bind(app).all();
  const active = new Set();
  (result.results || []).forEach(row => {
    try {
      const data = JSON.parse(row.data || '{}');
      if (!data.deleted) active.add(String(row.id));
    } catch (error) { /* 손상된 직원 행은 활성 직원으로 인정하지 않는다 */ }
  });
  return Array.from(used).filter(id => !active.has(id));
}

async function boardedStudentConflicts(env, app, document) {
  const result = await env.DB.prepare(
    "SELECT date,student_id FROM transport_states WHERE app=? AND status='boarded'"
  ).bind(app).all();
  const students = new Map(document.roster.students.map(item => [item.id, item]));
  const conflicts = new Set();
  for (const row of result.results || []) {
    const studentId = String(row.student_id || '');
    const student = students.get(studentId);
    const boardingMonth = String(row.date || '').slice(0, 7);
    const activeForBoarding = student && YEAR_MONTH.test(boardingMonth) &&
      student.start <= boardingMonth && (!student.end || student.end > boardingMonth);
    if (!activeForBoarding) conflicts.add(studentId);
  }
  return [...conflicts];
}

export async function handleRoster(env, app, body, origin, auth, json) {
  if (app !== 'task') return json({ ok: false, error: '이 기능은 직원 앱에서만 사용할 수 있습니다' }, 400, origin);
  const action = String(body.action || '');
  if (!['get', 'replace', 'student_get', 'student_create', 'student_update', 'student_transition'].includes(action)) {
    return json({ ok: false, error: '지원하지 않는 원생 명단 작업입니다' }, 400, origin);
  }

  if (action === 'student_get') {
    if (auth.scope !== 'all') return json({ ok: false, error: '원생 기본 정보는 원장만 수정할 수 있습니다' }, 403, origin);
    const studentId = String(body.studentId || '');
    if (!SAFE_ID.test(studentId)) return json({ ok: false, error: '원생을 다시 선택해 주세요' }, 400, origin);
    const row = await env.DB.prepare('SELECT data,updated_at FROM private_rosters WHERE app=? LIMIT 1').bind(app).first();
    if (!row) return json({ ok: false, error: '원생 명단이 아직 준비되지 않았습니다' }, 409, origin);
    let document;
    try { document = validateRosterDocument(JSON.parse(row.data)); }
    catch (error) { return json({ ok: false, error: '저장된 원생 데이터 형식이 올바르지 않습니다' }, 500, origin); }
    const student = document.roster.students.find(item => item.id === studentId);
    if (!student) return json({ ok: false, error: '현재 원생 명단에서 학생을 찾을 수 없습니다' }, 404, origin);
    return json({ ok: true, updatedAt: Number(row.updated_at), student }, 200, origin);
  }

  if (action === 'student_transition') {
    if (auth.scope !== 'all') return json({ ok: false, error: '휴원·퇴원·복귀는 관리자만 직접 처리할 수 있습니다' }, 403, origin);
    const expectedUpdatedAt = Number(body.expectedUpdatedAt);
    const studentId = String(body.studentId || '');
    const operation = String(body.operation || '');
    if (!Number.isInteger(expectedUpdatedAt) || expectedUpdatedAt < 1 || !SAFE_ID.test(studentId)) {
      return json({ ok: false, error: '원생 명단을 새로고침한 뒤 다시 처리해 주세요' }, 400, origin);
    }
    if (!['leave', 'withdrawal', 'return'].includes(operation)) {
      return json({ ok: false, error: '휴원·퇴원·복귀 중 처리할 상태를 선택해 주세요' }, 400, origin);
    }
    let effectiveDate;
    try { effectiveDate = isoDate(body.effectiveDate, 'effectiveDate'); }
    catch (error) { return json({ ok: false, error: String(error && error.message || error) }, 400, origin); }
    const row = await env.DB.prepare('SELECT data,updated_at FROM private_rosters WHERE app=? LIMIT 1').bind(app).first();
    if (!row) return json({ ok: false, error: '원생 명단이 아직 준비되지 않았습니다' }, 409, origin);
    if (Number(row.updated_at) !== expectedUpdatedAt) {
      return json({ ok: false, code: 'ROSTER_REVISION_CONFLICT', error: '원생 명단이 다른 기기에서 변경되었습니다. 새로고침 후 다시 처리해 주세요' }, 409, origin);
    }
    let document;
    try { document = validateRosterDocument(JSON.parse(row.data)); }
    catch (error) { return json({ ok: false, error: '저장된 원생 데이터 형식이 올바르지 않습니다' }, 500, origin); }
    const student = document.roster.students.find(item => item.id === studentId);
    if (!student) return json({ ok: false, error: '현재 원생 명단에서 학생을 찾을 수 없습니다' }, 404, origin);
    const currentTransition = rosterTransition(student);
    const now = Date.now();
    const actorRole = auth.role === 'manager' ? 'manager' : 'admin';
    const audienceStaffIds = [...student.teacherIds];
    const statements = [];
    const requiredIndexes = [];
    let responseTask = null;
    let eventType = operation;
    let changedFields;
    let details;

    if (operation === 'leave' || operation === 'withdrawal') {
      if (currentTransition) return json({ ok: false, error: '이미 휴원 또는 퇴원 처리된 학생입니다' }, 409, origin);
      let note;
      try { note = text(String(body.note || ''), 'note', 430, true); }
      catch (error) { return json({ ok: false, error: String(error && error.message || error) }, 400, origin); }
      const label = operation === 'leave' ? '휴원' : '퇴원';
      student.end = nextMonthForDate(effectiveDate);
      student.reason = label + ' ' + effectiveDate + (note ? ' · ' + note : '');
      changedFields = ['end', 'reason', 'deleted'];
      details = { effectiveDate, label, note, direct: true };
      const lessons = await env.DB.prepare(
        "SELECT id,owner,data,updated_at FROM tasks WHERE app=? AND json_valid(data) " +
        "AND json_extract(data,'$.studentId')=? AND COALESCE(json_extract(data,'$.deleted'),0)=0"
      ).bind(app, studentId).all();
      for (const lessonRow of lessons.results || []) {
        let lesson;
        try { lesson = JSON.parse(lessonRow.data || '{}'); } catch (error) { continue; }
        if (!isLessonTask(lesson)) continue;
        const taskUpdatedAt = Math.max(now, Number(lessonRow.updated_at || 0) + 1);
        lesson.end = effectiveDate;
        lesson.deleted = true;
        lesson.updatedAt = taskUpdatedAt;
        lesson.lastEditBy = actorRole;
        requiredIndexes.push(statements.length);
        statements.push(env.DB.prepare(
          'UPDATE tasks SET data=?,updated_at=?,srv_at=? WHERE app=? AND id=? AND updated_at=?'
        ).bind(JSON.stringify(lesson), taskUpdatedAt, taskUpdatedAt, app, lessonRow.id, lessonRow.updated_at));
        audienceStaffIds.push(String(lessonRow.owner || ''));
      }
    } else {
      if (!currentTransition) return json({ ok: false, error: '휴원생 또는 퇴원생만 복귀 처리할 수 있습니다' }, 409, origin);
      const staffId = String(body.staffId || '');
      const staff = await activeStaffRecord(env, app, staffId);
      if (!staff) return json({ ok: false, error: '복귀 수업을 담당할 재직 선생님을 선택해 주세요' }, 400, origin);
      let selectedSubjects;
      try { selectedSubjects = subjects(body.subjects, 'subjects'); }
      catch (error) { return json({ ok: false, error: String(error && error.message || error) }, 400, origin); }
      if (!selectedSubjects.length) return json({ ok: false, error: '복귀 수업 과목을 한 개 이상 선택해 주세요' }, 400, origin);
      if (!String(student.grade || '').trim()) return json({ ok: false, error: '복귀 전에 원생 기본 정보에서 학년을 입력해 주세요' }, 409, origin);
      const activeLesson = await env.DB.prepare(
        "SELECT id FROM tasks WHERE app=? AND json_valid(data) AND json_extract(data,'$.studentId')=? " +
        "AND COALESCE(json_extract(data,'$.deleted'),0)=0 LIMIT 1"
      ).bind(app, studentId).first();
      if (activeLesson) return json({ ok: false, error: '이미 활성 수업이 있습니다. 수업 정보를 확인한 뒤 다시 처리해 주세요' }, 409, origin);
      let lesson;
      try {
        lesson = await buildLessonTask({
          studentId: student.id, studentName: student.name, grade: student.grade,
          subject: selectedSubjects.join('·'), className: '', lessonRole: selectedSubjects.join('·'),
          scheduleText: '', scheduleSlots: body.scheduleSlots, start: effectiveDate,
          materials: '없음', onlineProgram: '없음', homework: '없음', studentTraits: '없음',
          goal: '없음', parentRequest: '없음', scheduleReviewReason: ''
        }, staff.id, actorRole, now);
      } catch (error) {
        return json({ ok: false, error: String(error && error.message || error) }, Number(error && error.status) || 400, origin);
      }
      const oldTask = await env.DB.prepare('SELECT data,updated_at FROM tasks WHERE app=? AND id=? LIMIT 1')
        .bind(app, lesson.id).first();
      if (oldTask) {
        let oldData;
        try { oldData = JSON.parse(oldTask.data || '{}'); } catch (error) { oldData = null; }
        if (!oldData || !oldData.deleted) return json({ ok: false, error: '같은 복귀 수업이 이미 등록되어 있습니다' }, 409, origin);
        lesson.createdAt = Number(oldData.createdAt) || now;
        lesson.updatedAt = Math.max(now, Number(oldTask.updated_at || 0) + 1);
        requiredIndexes.push(statements.length);
        statements.push(env.DB.prepare(
          'UPDATE tasks SET owner=?,data=?,updated_at=?,srv_at=? WHERE app=? AND id=? AND updated_at=?'
        ).bind(staff.id, JSON.stringify(lesson), lesson.updatedAt, lesson.updatedAt, app, lesson.id, oldTask.updated_at));
      } else {
        requiredIndexes.push(statements.length);
        statements.push(env.DB.prepare(
          'INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)'
        ).bind(app, lesson.id, staff.id, JSON.stringify(lesson), lesson.updatedAt, lesson.updatedAt));
      }
      student.end = '';
      student.reason = '';
      student.teacherIds = [staff.id];
      student.teacher = staff.name;
      student.subjects = selectedSubjects;
      student.subject = selectedSubjects.join('·');
      document.bookStudents.forEach(assignment => {
        if (assignment.studentId !== studentId) return;
        assignment.teacherIds = [staff.id];
        assignment.teacher = staff.name;
      });
      audienceStaffIds.push(staff.id);
      eventType = 'student_information';
      changedFields = ['end', 'reason', 'teacherIds', 'subject', 'subjects', 'scheduleSlots'];
      details = {
        operation: 'return', effectiveDate, label: '복귀', afterStaffName: staff.name,
        subjects: selectedSubjects, scheduleText: lesson.scheduleText, direct: true,
        beforeStatus: currentTransition.operation
      };
      responseTask = lesson;
    }

    document.roster.updated = new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    try { document = validateRosterDocument(document); }
    catch (error) { return json({ ok: false, error: String(error && error.message || error) }, 409, origin); }
    const inactiveIds = await inactiveTeacherIds(env, app, document);
    if (inactiveIds.length) return json({ ok: false, error: '재직 중인 담당 선생님만 선택해 주세요' }, 400, origin);
    const boardedConflicts = await boardedStudentConflicts(env, app, document);
    if (boardedConflicts.length) return json({ ok: false, code: 'BOARDING_LOCK', error: '탑승 후 미하차 상태인 학생은 지금 변경할 수 없습니다' }, 409, origin);
    const issueConflicts = await activeBookIssueConflicts(env, app, document);
    if (issueConflicts.length) return json({ ok: false, code: 'ACTIVE_BOOK_ISSUE_CONFLICT', error: '출고 진행 중인 교재가 있어 지금 변경할 수 없습니다' }, 409, origin);
    const orderConflicts = await activeBookOrderConflicts(env, app, document);
    if (orderConflicts.length) return json({ ok: false, code: 'ACTIVE_BOOK_ORDER_CONFLICT', error: '미완료 교재 주문이 있어 지금 변경할 수 없습니다' }, 409, origin);
    const rosterUpdatedAt = Math.max(now, Number(row.updated_at || 0) + 1);
    requiredIndexes.push(statements.length);
    statements.push(env.DB.prepare(
      'UPDATE private_rosters SET data=?,updated_at=? WHERE app=? AND updated_at=?'
    ).bind(JSON.stringify(document), rosterUpdatedAt, app, row.updated_at));
    const eventId = await studentChangeEventId('roster-transition\n' + studentId + '\n' + operation + '\n' + expectedUpdatedAt + '\n' + rosterUpdatedAt);
    statements.push(studentChangeEventStatement(env, app, {
      eventId, studentId, taskId: responseTask && responseTask.id || null, eventType, changedFields, details,
      audienceStaffIds, effectiveDate, requiresAck: true, changedAt: rosterUpdatedAt,
      changedBy: studentChangeActorKey(auth)
    }));
    let applied;
    try { applied = await env.DB.batch(statements); }
    catch (error) {
      if (isBoardingLockError(error)) return json({ ok: false, code: 'BOARDING_LOCK', error: '탑승 후 미하차 상태인 학생은 지금 변경할 수 없습니다' }, 409, origin);
      if (isActiveBookOrderConflictError(error)) return json({ ok: false, code: 'ACTIVE_BOOK_ORDER_CONFLICT', error: '미완료 교재 주문이 있어 지금 변경할 수 없습니다' }, 409, origin);
      throw error;
    }
    if (!requiredIndexes.every(index => Number(applied[index] && applied[index].meta && applied[index].meta.changes || 0) === 1)) {
      return json({ ok: false, code: 'ROSTER_REVISION_CONFLICT', error: '다른 변경이 먼저 저장되었습니다. 새로고침 후 다시 처리해 주세요' }, 409, origin);
    }
    return json({ ok: true, updatedAt: rosterUpdatedAt, student: withoutTeacherIds(student), task: responseTask }, 200, origin);
  }

  if (action === 'student_create' || action === 'student_update') {
    if (auth.scope !== 'all') return json({ ok: false, error: '원생 기본 정보는 원장만 수정할 수 있습니다' }, 403, origin);
    const expectedUpdatedAt = Number(body.expectedUpdatedAt);
    if (!Number.isInteger(expectedUpdatedAt) || expectedUpdatedAt < 1) {
      return json({ ok: false, error: '원생 명단을 새로고침한 뒤 다시 저장해 주세요' }, 400, origin);
    }
    const row = await env.DB.prepare('SELECT data,updated_at FROM private_rosters WHERE app=? LIMIT 1').bind(app).first();
    if (!row) return json({ ok: false, error: '원생 명단이 아직 준비되지 않았습니다' }, 409, origin);
    if (Number(row.updated_at) !== expectedUpdatedAt) {
      return json({ ok: false, code: 'ROSTER_REVISION_CONFLICT', error: '원생 명단이 다른 기기에서 변경되었습니다. 새로고침 후 다시 저장해 주세요' }, 409, origin);
    }
    let document;
    try { document = validateRosterDocument(JSON.parse(row.data)); }
    catch (error) { return json({ ok: false, error: '저장된 원생 데이터 형식이 올바르지 않습니다' }, 500, origin); }
    let nextStudent;
    try {
      const input = action === 'student_create'
        ? { ...record(body.student, 'document.roster.students[0]'),
          id: allocateNewStudentId(new Set(document.roster.students.map(item => item.id))) }
        : body.student;
      nextStudent = rosterStudent(input, 0);
    } catch (error) {
      const message = String(error && error.message || error);
      if (message === 'STUDENT_ID_GENERATION_FAILED') {
        return json({ ok: false, code: message, error: '새 원생 ID를 발급하지 못했습니다. 잠시 후 다시 시도해 주세요' }, 503, origin);
      }
      return json({ ok: false, error: message }, 400, origin);
    }
    const index = document.roster.students.findIndex(item => item.id === nextStudent.id);
    const previousStudent = index >= 0 ? { ...document.roster.students[index], teacherIds: document.roster.students[index].teacherIds.slice() } : null;
    const nextIdentityKey = studentRegistrationIdentityKey(nextStudent);
    const same = document.roster.students.find(item => item.id !== nextStudent.id &&
      studentRegistrationIdentityKey(item) === nextIdentityKey);
    if (same) return json({ ok: false, code: 'STUDENT_ALREADY_EXISTS',
      error: '같은 이름·학교·학년·보호자 연락처의 원생이 이미 있습니다. 기존 원생을 선택해 주세요', studentId: same.id }, 409, origin);
    if (action === 'student_create') {
      if (index >= 0) return json({ ok: false, code: 'STUDENT_ID_EXISTS', error: '이미 등록된 원생 ID입니다. 명단을 새로고침해 주세요' }, 409, origin);
      document.roster.students.push(nextStudent);
    } else {
      if (index < 0) return json({ ok: false, error: '수정할 원생을 현재 명단에서 찾을 수 없습니다' }, 404, origin);
      const oldName = document.roster.students[index].name;
      document.roster.students[index] = nextStudent;
      if (oldName !== nextStudent.name) {
        document.bookStudents.forEach(item => { if (item.studentId === nextStudent.id) item.name = nextStudent.name; });
      }
    }
    document.roster.updated = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    try { document = validateRosterDocument(document); }
    catch (error) { return json({ ok: false, error: String(error && error.message || error) }, 400, origin); }
    const inactiveIds = await inactiveTeacherIds(env, app, document);
    if (inactiveIds.length) return json({ ok: false, error: '재직 중인 담당 선생님만 선택해 주세요' }, 400, origin);
    const boardedConflicts = await boardedStudentConflicts(env, app, document);
    if (boardedConflicts.length) return json({ ok: false, code: 'BOARDING_LOCK', error: '탑승 후 미하차 상태인 학생 정보는 지금 변경할 수 없습니다' }, 409, origin);
    const issueConflicts = await activeBookIssueConflicts(env, app, document);
    if (issueConflicts.length) return json({ ok: false, code: 'ACTIVE_BOOK_ISSUE_CONFLICT', error: '출고 진행 중인 교재가 있어 이름 또는 배정 정보를 지금 변경할 수 없습니다' }, 409, origin);
    const orderConflicts = await activeBookOrderConflicts(env, app, document);
    if (orderConflicts.length) return json({ ok: false, code: 'ACTIVE_BOOK_ORDER_CONFLICT',
      error: '미완료 교재 주문이 있어 학생 이름이나 재원 상태를 지금 변경할 수 없습니다' }, 409, origin);
    const updatedAt = Date.now();
    let changed;
    try {
      changed = await env.DB.prepare('UPDATE private_rosters SET data=?,updated_at=? WHERE app=? AND updated_at=?')
        .bind(JSON.stringify(document), updatedAt, app, expectedUpdatedAt).run();
    } catch (error) {
      if (isActiveBookOrderConflictError(error)) {
        return json({ ok: false, code: 'ACTIVE_BOOK_ORDER_CONFLICT',
          error: '미완료 교재 주문이 있어 학생 이름이나 재원 상태를 지금 변경할 수 없습니다' }, 409, origin);
      }
      throw error;
    }
    if (Number(changed.meta && changed.meta.changes || 0) !== 1) {
      return json({ ok: false, code: 'ROSTER_REVISION_CONFLICT', error: '원생 명단이 다른 기기에서 변경되었습니다. 새로고침 후 다시 저장해 주세요' }, 409, origin);
    }
    if (action === 'student_update' && previousStudent) {
      const fields = ['name', 'school', 'grade', 'phoneSelf', 'phoneFather', 'phoneMother',
        'registrationDate', 'firstClassDate', 'subject', 'subjects', 'teacherIds', 'start', 'end', 'reason', 'memo'];
      const changedFields = fields.filter(key => JSON.stringify(previousStudent[key] || '') !== JSON.stringify(nextStudent[key] || ''));
      if (changedFields.length) {
        const eventId = await studentChangeEventId('roster\n' + nextStudent.id + '\n' + expectedUpdatedAt + '\n' + updatedAt);
        const audienceStaffIds = [...new Set([...(previousStudent.teacherIds || []), ...(nextStudent.teacherIds || [])])];
        await studentChangeEventStatement(env, app, {
          eventId, studentId: nextStudent.id, eventType: 'student_information', changedFields,
          details: {
            before: Object.fromEntries(changedFields.map(key => [key, previousStudent[key] == null ? '' : previousStudent[key]])),
            after: Object.fromEntries(changedFields.map(key => [key, nextStudent[key] == null ? '' : nextStudent[key]]))
          },
          audienceStaffIds, requiresAck: true, changedAt: updatedAt,
          changedBy: studentChangeActorKey(auth)
        }).run();
      }
    }
    return json({ ok: true, updatedAt, student: withoutTeacherIds(nextStudent) }, 200, origin);
  }

  if (action === 'replace') {
    if (auth.scope !== 'all') return json({ ok: false, error: '원생 데이터는 원장만 교체할 수 있습니다' }, 403, origin);
    let document;
    try { document = validateRosterDocument(body.document); }
    catch (error) { return json({ ok: false, error: String(error && error.message || error) }, 400, origin); }
    const inactiveIds = await inactiveTeacherIds(env, app, document);
    if (inactiveIds.length) {
      return json({ ok: false, error: 'teacherIds에는 활성 직원 ID만 사용할 수 있습니다: ' + inactiveIds.join(', ') }, 400, origin);
    }
    const boardedConflicts = await boardedStudentConflicts(env, app, document);
    if (boardedConflicts.length) {
      return json({
        ok: false,
        code: 'BOARDING_LOCK',
        error: '탑승 후 미하차 상태인 학생은 명단에서 제거하거나 해당 운행월에 비활성화할 수 없습니다. 차량 화면에서 하차·인계 또는 사유 있는 상태 초기화를 먼저 완료해 주세요'
      }, 409, origin);
    }
    const issueConflicts = await activeBookIssueConflicts(env, app, document);
    if (issueConflicts.length) {
      return json({
        ok: false,
        code: 'ACTIVE_BOOK_ISSUE_CONFLICT',
        error: '출고 진행 중인 교재 배정은 삭제하거나 학생·교재 정체성을 바꿀 수 없습니다',
        conflicts: issueConflicts
      }, 409, origin);
    }
    const orderConflicts = await activeBookOrderConflicts(env, app, document);
    if (orderConflicts.length) {
      return json({ ok: false, code: 'ACTIVE_BOOK_ORDER_CONFLICT',
        error: '미완료 교재 주문의 학생은 명단에서 삭제·비활성화하거나 이름을 바꿀 수 없습니다',
        conflicts: orderConflicts
      }, 409, origin);
    }
    const updatedAt = Date.now();
    try {
      await env.DB.prepare(
        'INSERT INTO private_rosters (app,data,updated_at) VALUES (?,?,?) ' +
        'ON CONFLICT(app) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at'
      ).bind(app, JSON.stringify(document), updatedAt).run();
    } catch (error) {
      if (isBoardingLockError(error)) {
        return json({
          ok: false,
          code: 'BOARDING_LOCK',
          error: '탑승 후 미하차 상태인 학생은 명단에서 제거하거나 해당 운행월에 비활성화할 수 없습니다. 차량 화면에서 하차·인계 또는 사유 있는 상태 초기화를 먼저 완료해 주세요'
        }, 409, origin);
      }
      if (isActiveBookOrderConflictError(error)) {
        return json({ ok: false, code: 'ACTIVE_BOOK_ORDER_CONFLICT',
          error: '미완료 교재 주문의 학생은 명단에서 삭제·비활성화하거나 이름을 바꿀 수 없습니다' }, 409, origin);
      }
      throw error;
    }
    return json({
      ok: true,
      updatedAt,
      rosterCount: document.roster.students.length,
      bookStudentCount: document.bookStudents.length
    }, 200, origin);
  }

  const row = await env.DB.prepare('SELECT data,updated_at FROM private_rosters WHERE app=? LIMIT 1').bind(app).first();
  if (!row) return json({ ok: false, error: '원생 데이터가 아직 등록되지 않았습니다' }, 404, origin);
  let document;
  try { document = validateRosterDocument(JSON.parse(row.data)); }
  catch (error) { return json({ ok: false, error: '저장된 원생 데이터 형식이 올바르지 않습니다' }, 500, origin); }
  return json({ ok: true, updatedAt: Number(row.updated_at), ...responseDocument(document, auth) }, 200, origin);
}
