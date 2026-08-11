import { validateRosterDocument } from './roster.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const STATES = new Set(['prepared', 'issued', 'handed', 'cancelled']);
const NEXT = new Set([...STATES, 'reissue']);

function cleanReason(value) {
  const reason = String(value || '').trim();
  if (reason.length > 300 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason)) return null;
  return reason;
}

function normalizedName(value) {
  return String(value || '').normalize('NFKC').trim();
}

async function identityHash(studentId, studentName) {
  const bytes = new TextEncoder().encode(String(studentId) + '\n' + normalizedName(studentName));
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
  const issues = [];
  const warnings = [];

  for (const assignment of document.bookStudents) {
    if (auth.scope === 'own' && !assignment.teacherIds.includes(auth.id)) continue;
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
  return json({ ok: true, issues, warnings }, 200, origin);
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
    return json({ ok: false, error: '담당 학생의 교재만 처리할 수 있습니다' }, 403, origin);
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

  if (!row) {
    const preparedAt = next === 'prepared' || next === 'issued' ? now : null;
    const issuedAt = next === 'issued' ? now : null;
    const inserted = await env.DB.prepare(
      'INSERT INTO book_issues(app,assignment_id,student_id,book_id,student_identity_hash,status,cycle,revision,' +
      'prepared_at,prepared_by,issued_at,issued_by,handed_at,handed_by,cancelled_at,cancelled_by,cancel_reason,reissue_reason,history,created_at,updated_at) ' +
      'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,NULL,?,?,?) ON CONFLICT(app,assignment_id) DO NOTHING'
    ).bind(app, assignmentId, assignment.studentId, assignment.bookId, hash, plan.status, 1, 1,
      preparedAt, actor, issuedAt, issuedAt ? actor : null, JSON.stringify(plan.history), now, now).run();
    if (!inserted.meta || Number(inserted.meta.changes || 0) !== 1) {
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
      'WHERE app=? AND assignment_id=? AND revision=? AND status=? AND student_id=? AND book_id=? AND student_identity_hash=?'
    ).bind(plan.status, plan.cycle, preparedAt, preparedBy, issuedAt, issuedBy, handedAt, handedBy,
      cancelledAt, cancelledBy, cancelReason, reissueReason, JSON.stringify(plan.history), now,
      app, assignmentId, revision, row.status, assignment.studentId, assignment.bookId, hash).run();
    if (!updated.meta || Number(updated.meta.changes || 0) !== 1) {
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

export async function handleBookIssue(env, app, body, origin, auth, json) {
  if (app !== 'task') return json({ ok: false, error: '이 기능은 직원 앱에서만 사용할 수 있습니다' }, 400, origin);
  const action = String(body.action || '');
  if (action === 'list') return listIssues(env, app, auth, json, origin);
  if (action === 'transition') return transition(env, app, body, auth, json, origin);
  return json({ ok: false, error: 'action은 list 또는 transition이어야 합니다' }, 400, origin);
}
