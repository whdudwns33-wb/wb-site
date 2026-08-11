const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_STUDENTS = 2000;
const MAX_BOOK_STUDENTS = 5000;

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

function teacherIds(value, path) {
  if (!Array.isArray(value) || !value.length || value.length > 20) fail(path, '1~20개의 직원 ID 배열이어야 합니다');
  const result = value.map((item, index) => id(item, path + '[' + index + ']'));
  if (new Set(result).size !== result.length) fail(path, '중복 ID가 있습니다');
  return result;
}

function rosterStudent(value, index) {
  const path = 'document.roster.students[' + index + ']';
  shape(value,
    ['id', 'name', 'grade', 'teacher', 'subject', 'start', 'end', 'reason', 'teacherIds'],
    ['memo'], path);
  const start = month(value.start, path + '.start', false);
  const end = month(value.end, path + '.end', true);
  if (end && end < start) fail(path + '.end', '시작월보다 빠를 수 없습니다');
  const result = {
    id: id(value.id, path + '.id'),
    name: text(value.name, path + '.name', 40, false),
    grade: text(value.grade, path + '.grade', 20, false),
    teacher: text(value.teacher, path + '.teacher', 200, false),
    subject: text(value.subject, path + '.subject', 200, false),
    start,
    end,
    reason: text(value.reason, path + '.reason', 500, true),
    teacherIds: teacherIds(value.teacherIds, path + '.teacherIds')
  };
  if (Object.prototype.hasOwnProperty.call(value, 'memo')) result.memo = text(value.memo, path + '.memo', 1000, true);
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

export async function handleRoster(env, app, body, origin, auth, json) {
  if (app !== 'task') return json({ ok: false, error: '이 기능은 직원 앱에서만 사용할 수 있습니다' }, 400, origin);
  const action = String(body.action || '');
  if (action !== 'get' && action !== 'replace') {
    return json({ ok: false, error: 'action은 get 또는 replace여야 합니다' }, 400, origin);
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
    const issueConflicts = await activeBookIssueConflicts(env, app, document);
    if (issueConflicts.length) {
      return json({
        ok: false,
        code: 'ACTIVE_BOOK_ISSUE_CONFLICT',
        error: '출고 진행 중인 교재 배정은 삭제하거나 학생·교재 정체성을 바꿀 수 없습니다',
        conflicts: issueConflicts
      }, 409, origin);
    }
    const updatedAt = Date.now();
    await env.DB.prepare(
      'INSERT INTO private_rosters (app,data,updated_at) VALUES (?,?,?) ' +
      'ON CONFLICT(app) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at'
    ).bind(app, JSON.stringify(document), updatedAt).run();
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
