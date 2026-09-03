import { taskWriteCasGuardStatement } from './task-write-cas.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const SAFE_ACTOR = /^(?:director|(?:manager|staff):[A-Za-z0-9_-]{1,128})$/;
const ACTIVE_STATUSES = new Set(['review_pending', 'reviewed', 'awaiting_parent', 'confirmed']);
const LIFECYCLE_ACTIONS = new Set(['leave', 'withdrawal', 'lesson_delete']);

function lifecycleProblem(message) {
  const error = new Error(message);
  error.code = 'MAKEUP_LIFECYCLE_CONFLICT';
  throw error;
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (error) { return null; }
}

function parseHistory(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch (error) { return null; }
}

function makeupLessonId(caseId) {
  return 'makeup_lesson_' + caseId;
}

function assertCleanupInput(app, options) {
  if (app !== 'task' || !options || typeof options !== 'object' ||
      !LIFECYCLE_ACTIONS.has(String(options.lifecycleAction || '')) ||
      !SAFE_ACTOR.test(String(options.actorId || '')) || !Number.isFinite(Number(options.now)) || Number(options.now) < 1) {
    lifecycleProblem('보강 정리 요청 형식을 확인해 주세요');
  }
  const studentId = String(options.studentId || '');
  const sourceTaskId = String(options.sourceTaskId || '');
  if ((studentId && !SAFE_ID.test(studentId)) || (sourceTaskId && !SAFE_ID.test(sourceTaskId)) ||
      (!studentId && !sourceTaskId) || (studentId && sourceTaskId)) {
    lifecycleProblem('보강 정리 대상을 확인해 주세요');
  }
}

async function taskRowsByIds(env, app, ids) {
  const rows = new Map();
  const unique = [...new Set(ids)].filter(id => SAFE_ID.test(id));
  for (let offset = 0; offset < unique.length; offset += 80) {
    const chunk = unique.slice(offset, offset + 80);
    const result = await env.DB.prepare(
      'SELECT id,owner,data,updated_at FROM tasks WHERE app=? AND id IN (' + chunk.map(() => '?').join(',') + ')'
    ).bind(app, ...chunk).all();
    for (const row of result.results || []) rows.set(String(row.id), row);
  }
  return rows;
}

function validGeneratedTask(row, task, item) {
  return !!(row && task && SAFE_ID.test(String(row.owner || '')) &&
    String(row.id || '') === makeupLessonId(String(item.case_id)) &&
    String(task.id || '') === String(row.id || '') &&
    String(task.staffId || '') === String(row.owner || '') &&
    String(task.studentId || '') === String(item.student_id || '') &&
    String(task.lessonInstanceType || '') === 'makeup' &&
    String(task.makeupCaseId || '') === String(item.case_id || '') &&
    String(task.makeupSourceTaskId || '') === String(item.source_task_id || '') &&
    String(task.makeupSourceDate || '') === String(item.source_date || ''));
}

/**
 * 학생 휴원·퇴원 또는 원수업 삭제와 함께 활성 보강을 원자적으로 닫기 위한 문장 묶음이다.
 * 생성 보강 task는 행과 연결 기록을 지우지 않고 deleted 플래그만 세워 감사 이력을 보존한다.
 */
export async function prepareMakeupLifecycleCleanup(env, app, options) {
  assertCleanupInput(app, options);
  const lifecycleAction = String(options.lifecycleAction);
  const studentId = String(options.studentId || '');
  const sourceTaskId = String(options.sourceTaskId || '');
  const actorId = String(options.actorId);
  const actorRole = String(options.actorRole || 'admin').slice(0, 80) || 'admin';
  const now = Math.floor(Number(options.now));
  const scopeSql = studentId ? 'student_id=?' : 'source_task_id=?';
  const scopeValue = studentId || sourceTaskId;
  const result = await env.DB.prepare(
    "SELECT * FROM makeup_cases WHERE app=? AND " + scopeSql +
    " AND status IN ('review_pending','reviewed','awaiting_parent','confirmed') ORDER BY case_id"
  ).bind(app, scopeValue).all();
  const cases = result.results || [];
  const lessonRows = await taskRowsByIds(env, app, cases.map(item => makeupLessonId(String(item.case_id || ''))));
  const statements = [];
  const requiredIndexes = [];

  for (const item of cases) {
    const caseId = String(item.case_id || '');
    const itemStudentId = String(item.student_id || '');
    const itemSourceTaskId = String(item.source_task_id || '');
    const history = parseHistory(item.history);
    if (!SAFE_ID.test(caseId) || !SAFE_ID.test(itemStudentId) || !SAFE_ID.test(itemSourceTaskId) ||
        !ACTIVE_STATUSES.has(String(item.status || '')) || !history ||
        (studentId && itemStudentId !== studentId) || (sourceTaskId && itemSourceTaskId !== sourceTaskId)) {
      lifecycleProblem('연결된 보강 기록의 식별 정보를 확인해 주세요');
    }
    const taskId = makeupLessonId(caseId);
    const taskRow = lessonRows.get(taskId);
    if (taskRow) {
      const task = parseObject(taskRow.data);
      if (!validGeneratedTask(taskRow, task, item)) {
        lifecycleProblem('연결된 보강 수업의 식별 정보를 확인해 주세요');
      }
      const taskUpdatedAt = Math.max(now, Number(taskRow.updated_at || 0) + 1, Number(task.updatedAt || 0) + 1);
      const nextTask = task.deleted ? task : {
        ...task,
        deleted: true,
        updatedAt: taskUpdatedAt,
        lastEditBy: actorRole,
        makeupCancelledAt: now,
        makeupCancelledReason: lifecycleAction
      };
      requiredIndexes.push(statements.length);
      statements.push(task.deleted
        ? env.DB.prepare(
          "UPDATE tasks SET updated_at=updated_at WHERE app=? AND id=? AND owner=? AND data=? AND updated_at=? " +
          "AND json_valid(data) AND COALESCE(json_extract(data,'$.deleted'),0)=1"
        ).bind(app, taskId, taskRow.owner, taskRow.data, Number(taskRow.updated_at))
        : env.DB.prepare(
          'UPDATE tasks SET data=?,updated_at=?,srv_at=? WHERE app=? AND id=? AND owner=? AND data=? AND updated_at=?'
        ).bind(JSON.stringify(nextTask), taskUpdatedAt, taskUpdatedAt, app, taskId, taskRow.owner,
          taskRow.data, Number(taskRow.updated_at)));
      statements.push(await taskWriteCasGuardStatement(env, app, 'makeup_lifecycle_task',
        [lifecycleAction, scopeValue, caseId, item.revision, taskRow.owner, taskRow.updated_at, now].join('\n'), now));
    } else {
      // 조회 뒤 다른 요청이 보강 task를 만드는 경합도 case 전환 전에 차단한다.
      requiredIndexes.push(statements.length);
      statements.push(env.DB.prepare(
        'UPDATE makeup_cases SET updated_at=updated_at WHERE app=? AND case_id=? AND revision=? AND status=? ' +
        'AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.app=? AND tasks.id=?)'
      ).bind(app, caseId, Number(item.revision), item.status, app, taskId));
      statements.push(await taskWriteCasGuardStatement(env, app, 'makeup_lifecycle_missing_task',
        [lifecycleAction, scopeValue, caseId, item.revision, now].join('\n'), now));
    }

    const caseUpdatedAt = Math.max(now, Number(item.updated_at || 0) + 1);
    const nextRevision = Number(item.revision) + 1;
    const reason = lifecycleAction === 'lesson_delete' ? 'already_resolved' : 'student_inactive';
    const nextHistory = history.concat({
      action: 'cancel_for_source_lifecycle', lifecycleAction, from: String(item.status), to: 'cancelled',
      actorId, reason, notificationNeeded: false, revision: nextRevision, at: caseUpdatedAt
    });
    requiredIndexes.push(statements.length);
    statements.push(env.DB.prepare(
      "UPDATE makeup_cases SET status='cancelled',revision=?,cancelled_at=?,cancelled_by=?,reason=?," +
      'notification_needed=0,notification_event=NULL,notification_event_revision=0,history=?,updated_at=? ' +
      'WHERE app=? AND case_id=? AND revision=? AND status=?'
    ).bind(nextRevision, caseUpdatedAt, actorId, reason, JSON.stringify(nextHistory), caseUpdatedAt,
      app, caseId, Number(item.revision), item.status));
    statements.push(await taskWriteCasGuardStatement(env, app, 'makeup_lifecycle_case',
      [lifecycleAction, scopeValue, caseId, item.revision, nextRevision, now].join('\n'), now));
  }

  // 위 SELECT 뒤, batch가 시작되기 전에 새 보강 case가 생기는 경합도 놓치지 않는다.
  // 앞에서 본 case를 모두 닫은 뒤 같은 scope에 active case가 하나도 없음을 transaction
  // 안에서 확인하고, 0행이면 바로 다음 CAS guard가 batch 전체를 롤백한다.
  requiredIndexes.push(statements.length);
  statements.push(env.DB.prepare(
    'UPDATE private_rosters SET updated_at=updated_at WHERE app=? AND NOT EXISTS (' +
    'SELECT 1 FROM makeup_cases WHERE app=? AND ' + scopeSql +
    " AND status IN ('review_pending','reviewed','awaiting_parent','confirmed'))"
  ).bind(app, app, scopeValue));
  statements.push(await taskWriteCasGuardStatement(env, app, 'makeup_lifecycle_scope_empty',
    [lifecycleAction, scopeValue, now].join('\n'), now));

  return { statements, requiredIndexes, caseCount: cases.length };
}

export function isMakeupLifecycleConflict(error) {
  return /MAKEUP_LIFECYCLE_CONFLICT/.test(String(error && (error.code || error.message) || error || ''));
}
