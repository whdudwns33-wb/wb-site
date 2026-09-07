import { taskWriteCasGuardStatement } from './task-write-cas.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_IDS_PER_QUERY = 80;

function problem(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

/**
 * 시간표 잠금은 이름이 아니라 stable studentId만 사용한다. 정렬까지 고정해야
 * 여러 학생을 한 batch에서 갱신할 때 모든 호출 경로가 같은 순서를 사용한다.
 */
export function normalizeStudentScheduleRevisionIds(values) {
  if (!Array.isArray(values)) problem('STUDENT_SCHEDULE_REVISION_IDS_INVALID');
  const ids = [];
  for (const value of values) {
    const id = typeof value === 'string' ? value : '';
    if (!SAFE_ID.test(id)) problem('STUDENT_SCHEDULE_REVISION_ID_INVALID');
    ids.push(id);
  }
  return [...new Set(ids)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function assertContext(env, app) {
  if (app !== 'task' || !env || !env.DB || typeof env.DB.prepare !== 'function') {
    problem('STUDENT_SCHEDULE_REVISION_CONTEXT_INVALID');
  }
}

/**
 * 반드시 실제 수업·보강 snapshot을 읽기 전에 호출한다. 이후의 원자 batch에서
 * 이 revision을 CAS하므로, 읽기 뒤 다른 요청이 일정을 바꿨다면 전체 쓰기가 롤백된다.
 */
export async function readStudentScheduleRevisionSnapshot(env, app, studentIds) {
  assertContext(env, app);
  const ids = normalizeStudentScheduleRevisionIds(studentIds);
  const loaded = new Map();
  for (let offset = 0; offset < ids.length; offset += MAX_IDS_PER_QUERY) {
    const chunk = ids.slice(offset, offset + MAX_IDS_PER_QUERY);
    const placeholders = chunk.map(() => '?').join(',');
    const result = await env.DB.prepare(
      'SELECT student_id,revision FROM student_schedule_revisions ' +
      'WHERE app=? AND student_id IN (' + placeholders + ')'
    ).bind(app, ...chunk).all();
    for (const row of result && result.results || []) {
      const id = String(row && row.student_id || '');
      const revision = Number(row && row.revision);
      if (!chunk.includes(id) || loaded.has(id) || !Number.isSafeInteger(revision) || revision < 0) {
        problem('STUDENT_SCHEDULE_REVISION_SNAPSHOT_INVALID');
      }
      loaded.set(id, revision);
    }
  }
  return {
    app,
    revisions: ids.map(studentId => ({
      studentId,
      revision: loaded.has(studentId) ? loaded.get(studentId) : 0
    }))
  };
}

function normalizedSnapshot(snapshot, app) {
  if (!snapshot || snapshot.app !== app || !Array.isArray(snapshot.revisions)) {
    problem('STUDENT_SCHEDULE_REVISION_SNAPSHOT_INVALID');
  }
  const ids = normalizeStudentScheduleRevisionIds(snapshot.revisions.map(item =>
    item && typeof item.studentId === 'string' ? item.studentId : null));
  if (ids.length !== snapshot.revisions.length ||
      ids.some((id, index) => id !== snapshot.revisions[index].studentId)) {
    problem('STUDENT_SCHEDULE_REVISION_SNAPSHOT_INVALID');
  }
  return snapshot.revisions.map(item => {
    const revision = item.revision;
    if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) {
      problem('STUDENT_SCHEDULE_REVISION_SNAPSHOT_INVALID');
    }
    return { studentId: item.studentId, revision };
  });
}

/**
 * 반환된 문장들을 실제 수업·보강 write보다 앞에 같은 env.DB.batch로 넣는다.
 * UPDATE 바로 다음 guard가 changes()=1을 강제해 stale snapshot이면 batch 전체를 막는다.
 */
export async function studentScheduleRevisionCasStatements(env, app, snapshot, options = {}) {
  assertContext(env, app);
  const revisions = normalizedSnapshot(snapshot, app);
  const operation = String(options.operation || 'student_schedule_revision');
  const source = String(options.source || '');
  const updatedAt = options.updatedAt == null ? Date.now() : Number(options.updatedAt);
  if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0) {
    problem('STUDENT_SCHEDULE_REVISION_TIMESTAMP_INVALID');
  }

  const statements = [];
  for (const item of revisions) {
    statements.push(env.DB.prepare(
      'INSERT OR IGNORE INTO student_schedule_revisions(app,student_id,revision,updated_at) ' +
      'VALUES(?,?,0,?)'
    ).bind(app, item.studentId, updatedAt));
    statements.push(env.DB.prepare(
      'UPDATE student_schedule_revisions SET revision=revision+1,updated_at=? ' +
      'WHERE app=? AND student_id=? AND revision=?'
    ).bind(updatedAt, app, item.studentId, item.revision));
    statements.push(await taskWriteCasGuardStatement(env, app, operation, [
      'student_schedule_revision_v1', source, item.studentId,
      item.revision, item.revision + 1
    ].join('\n'), updatedAt));
  }
  return statements;
}
