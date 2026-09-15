import { validateRosterDocument } from './roster.js';
import { studentChangeActorKey, studentChangeEventId, studentChangeEventStatement } from './student-change.js';
import { isTaskWriteCasConflict, taskWriteCasGuardStatement } from './task-write-cas.js';
import {
  readStudentScheduleRevisionSnapshot,
  studentScheduleRevisionCasStatements
} from './student-schedule-revision.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const FIELDS = new Set(['app', 'auth', 'taskId', 'studentId', 'staffId', 'expectedUpdatedAt']);
const ACTIVE_MAKEUPS_SQL = "SELECT count(*) AS count FROM makeup_cases WHERE app=? AND source_task_id=? " +
  "AND status IN ('review_pending','reviewed','awaiting_parent','confirmed')";

async function linkedActiveMakeupCount(env, app, taskId) {
  const row = await env.DB.prepare(ACTIVE_MAKEUPS_SQL).bind(app, taskId).first();
  return Number(row && row.count || 0);
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (error) { return null; }
}

function regularLesson(task) {
  return !!(task && (task.taskKind === 'lesson_instruction' || task.lessonFormVersion || task.intakeVersion) &&
    String(task.lessonInstanceType || '') !== 'makeup' && !String(task.makeupCaseId || '').trim());
}

/**
 * 지시 목록의 중단은 일정 변경이므로 generic sync 대신 학생 일정 잠금 안에서 처리한다.
 * 원 수업은 tombstone으로 남겨 이전 기기의 사본보다 최신 정본을 내려주고 출결·메모를 보존한다.
 * 연결 보강의 원 수업 정체성을 깨지 않도록 활성 보강이 남아 있으면 먼저 보강에서 처리하게 한다.
 */
export async function handleLessonStop(env, app, body, origin, auth, json) {
  if (app !== 'task') return json({ ok: false, error: '직원 앱의 수업만 중단할 수 있습니다' }, 400, origin);
  if (!auth || auth.scope !== 'all') {
    return json({ ok: false, error: '원장·관리 담당만 수업을 중단할 수 있습니다' }, 403, origin);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !FIELDS.has(key))) {
    return json({ ok: false, error: '수업 중단 요청 형식을 확인해 주세요' }, 400, origin);
  }
  const taskId = String(body.taskId || '');
  const studentId = String(body.studentId || '');
  const staffId = String(body.staffId || '');
  const expectedUpdatedAt = body.expectedUpdatedAt;
  if (![taskId, studentId, staffId].every(id => SAFE_ID.test(id)) ||
      !Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt < 1) {
    return json({ ok: false, error: '수업·학생·담당자와 최신 저장 시각을 확인해 주세요' }, 400, origin);
  }
  const conflict = () => json({ ok: false, code: 'REVISION_CONFLICT',
    error: '다른 변경이 먼저 저장되었습니다. 최신 수업을 확인한 뒤 다시 중단해 주세요' }, 409, origin);
  const activeMakeups = count => json({ ok: false, code: 'LESSON_HAS_ACTIVE_MAKEUPS', activeMakeupCount: count,
    error: '연결된 보강을 먼저 완료하거나 보강없음으로 처리해 주세요' }, 409, origin);
  try {
    const scheduleSnapshot = await readStudentScheduleRevisionSnapshot(env, app, [studentId]);
    const row = await env.DB.prepare('SELECT owner,data,updated_at FROM tasks WHERE app=? AND id=? LIMIT 1')
      .bind(app, taskId).first();
    if (!row) return json({ ok: false, error: '수업을 찾을 수 없습니다' }, 404, origin);
    const task = parseObject(row.data);
    if (!regularLesson(task) || String(task.id || '') !== taskId ||
        String(row.owner || '') !== staffId || String(task.staffId || '') !== staffId ||
        String(task.studentId || '') !== studentId) {
      return json({ ok: false, code: 'LESSON_IDENTITY_MISMATCH',
        error: '수업·학생·담당자 정보가 변경되었습니다. 최신 수업을 다시 선택해 주세요' }, 409, origin);
    }
    const scheduleRevision = scheduleSnapshot.revisions[0].revision;
    if (task.deleted) {
      return json({ ok: true, idempotent: true, task,
        studentScheduleRevision: scheduleRevision }, 200, origin);
    }
    if (Number(row.updated_at) !== expectedUpdatedAt) return conflict();
    const rosterRow = await env.DB.prepare('SELECT data FROM private_rosters WHERE app=? LIMIT 1').bind(app).first();
    let roster;
    try { roster = rosterRow && validateRosterDocument(JSON.parse(rosterRow.data)); }
    catch (error) { roster = null; }
    if (!roster || !roster.roster.students.some(student => student.id === studentId)) {
      return json({ ok: false, code: 'STUDENT_MISSING',
        error: '현재 원생 명단에서 수업의 학생을 찾을 수 없습니다' }, 409, origin);
    }
    const activeMakeupCount = await linkedActiveMakeupCount(env, app, taskId);
    if (activeMakeupCount) return activeMakeups(activeMakeupCount);
    const now = Date.now();
    const updatedAt = Math.max(now, Number(row.updated_at) + 1, Number(task.updatedAt || 0) + 1);
    const effectiveDate = new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const actorRole = auth.role === 'manager' ? 'manager' : 'admin';
    const stopped = { ...task, deleted: true, end: effectiveDate, updatedAt, lastEditBy: actorRole,
      lessonRevision: Math.max(1, Number(task.lessonRevision || 0) + 1) };
    const source = [taskId, studentId, staffId, expectedUpdatedAt, updatedAt].join('\n');
    const statements = await studentScheduleRevisionCasStatements(env, app, scheduleSnapshot, {
      operation: 'lesson_stop_schedule', source, updatedAt: now
    });
    const taskIndex = statements.length;
    statements.push(env.DB.prepare(
      'UPDATE tasks SET data=?,updated_at=?,srv_at=? WHERE app=? AND id=? AND owner=? AND data=? AND updated_at=? ' +
      'AND NOT EXISTS (SELECT 1 FROM makeup_cases WHERE app=? AND source_task_id=? ' +
      "AND status IN ('review_pending','reviewed','awaiting_parent','confirmed'))"
    ).bind(JSON.stringify(stopped), updatedAt, now, app, taskId, staffId, row.data, expectedUpdatedAt, app, taskId));
    statements.push(await taskWriteCasGuardStatement(env, app, 'lesson_stop_task', source, now));
    const eventId = await studentChangeEventId('lesson-stop\n' + source);
    const eventIndex = statements.length;
    statements.push(studentChangeEventStatement(env, app, {
      eventId, studentId, taskId, eventType: 'lesson_delete', changedFields: ['deleted', 'end'],
      details: { effectiveDate, source: 'instruction_list_stop', previousEnd: String(task.end || '') },
      audienceStaffIds: [staffId], effectiveDate, requiresAck: false, changedAt: now, changedBy: studentChangeActorKey(auth)
    }));
    statements.push(await taskWriteCasGuardStatement(env, app, 'lesson_stop_event', source, now));
    const results = await env.DB.batch(statements);
    const requiredIndexes = [taskIndex, eventIndex];
    if (!Array.isArray(results) || results.length !== statements.length || requiredIndexes.some(index =>
      Number(results[index] && results[index].meta && results[index].meta.changes || 0) !== 1)) return conflict();
    return json({ ok: true, idempotent: false, task: stopped,
      studentScheduleRevision: scheduleRevision + 1 }, 200, origin);
  } catch (error) {
    if (isTaskWriteCasConflict(error)) {
      const activeMakeupCount = await linkedActiveMakeupCount(env, app, taskId);
      return activeMakeupCount ? activeMakeups(activeMakeupCount) : conflict();
    }
    throw error;
  }
}
