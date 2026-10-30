import { flexibleWeekendAllowedOn } from './weekend-flex.js';
import { assertStudentLessonScheduleAvailable } from './student-schedule-conflict.js';
import { readStudentScheduleRevisionSnapshot, studentScheduleRevisionCasStatements } from './student-schedule-revision.js';
import { taskWriteCasGuardStatement, isTaskWriteCasConflict } from './task-write-cas.js';
import { studentChangeActorKey, studentChangeEventId, studentChangeEventStatement } from './student-change.js';

const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const parse = value => { try { return JSON.parse(value); } catch { return null; } };

// 예약은 실제 등원 원장이나 출석 체크를 만들지 않는다. 원 수업에 날짜별 시간만 보관한다.
export async function handleWeekendPlan(env, app, body, auth, json, origin) {
  const fail = (error, status = 422) => json({ ok: false, error }, status, origin);
  if (!auth || !['all', 'own'].includes(auth.scope)) return fail('로그인을 확인해 주세요', 403);
  const row = await env.DB.prepare('SELECT owner,data,updated_at FROM tasks WHERE app=? AND id=? LIMIT 1')
    .bind(app, String(body.taskId || '')).first();
  const task = row && parse(row.data);
  if (!task || task.deleted || task.makeupCaseId || task.lessonInstanceType === 'makeup' ||
      !(task.taskKind === 'lesson_instruction' || task.lessonFormVersion || task.intakeVersion) ||
      task.staffId !== row.owner || String(task.studentId || '') !== String(body.studentId || '') ||
      (auth.scope === 'own' && row.owner !== auth.id)) return fail('담당 수업과 학생 연결을 확인해 주세요', 403);
  const date = String(body.date || '');
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date(Date.now()));
  if (!flexibleWeekendAllowedOn(task, date) || date < today) return fail('오늘 이후의 허용된 토·일 날짜를 선택해 주세요');
  const startTime = String(body.startTime || ''), endTime = String(body.endTime || '');
  const cancel = body.action === 'plan_cancel';
  if (!cancel && (!clock.test(startTime) || !clock.test(endTime) || startTime >= endTime)) return fail('시작·종료 시간을 확인해 주세요');
  const rosterRow = await env.DB.prepare('SELECT data FROM private_rosters WHERE app=? LIMIT 1').bind(app).first();
  const roster = parse(rosterRow && rosterRow.data);
  if (!(roster?.roster?.students || []).some(s => !s.deleted && s.id === task.studentId)) return fail('현재 원생 명단에서 학생을 확인해 주세요');
  const plans = Array.isArray(task.weekendPlans) ? task.weekendPlans : [];
  const current = plans.find(p => p.date === date);
  if ((!cancel && current && current.startTime === startTime && current.endTime === endTime) || (cancel && !current)) {
    return json({ ok: true, task, idempotent: true }, 200, origin);
  }
  if (Number(body.expectedUpdatedAt) !== Number(row.updated_at)) return fail('수업 정보가 변경되었습니다. 새로고침 후 다시 선택해 주세요', 409);
  const visit = await env.DB.prepare("SELECT visit_id FROM weekend_actual_visits WHERE app=? AND lesson_task_id=? AND visit_date=? AND status<>'cancelled' LIMIT 1")
    .bind(app, task.id, date).first();
  const check = await env.DB.prepare('SELECT k FROM checks WHERE app=? AND k=? LIMIT 1').bind(app, task.id + '|' + date).first();
  if (visit || check) return fail('이미 등원·출결·수업 기록이 있는 날짜의 예약은 변경할 수 없습니다');
  const at = Math.max(Date.now(), Number(row.updated_at) + 1);
  const next = { ...task, weekendPlans: plans.filter(p => p.date !== date), previousUpdatedAt: Number(row.updated_at), updatedAt: at };
  if (!cancel) next.weekendPlans.push({ date, startTime, endTime });
  next.weekendPlans.sort((a, b) => a.date.localeCompare(b.date));
  const snapshot = await readStudentScheduleRevisionSnapshot(env, app, [task.studentId]);
  try {
    if (!cancel) await assertStudentLessonScheduleAvailable(env, app, [next]);
    const guards = await studentScheduleRevisionCasStatements(env, app, snapshot, { operation: 'weekend_plan', source: task.id + ':' + date, updatedAt: at });
    await env.DB.batch([...guards,
      env.DB.prepare('UPDATE tasks SET data=?,updated_at=?,srv_at=? WHERE app=? AND id=? AND updated_at=? AND data=? ' +
        "AND NOT EXISTS (SELECT 1 FROM weekend_actual_visits WHERE app=? AND lesson_task_id=? AND visit_date=? AND status<>'cancelled') " +
        'AND NOT EXISTS (SELECT 1 FROM checks WHERE app=? AND k=?)')
        .bind(JSON.stringify(next), at, at, app, task.id, row.updated_at, row.data, app, task.id, date, app, task.id + '|' + date),
      await taskWriteCasGuardStatement(env, app, 'weekend_plan_task', task.id + ':' + date + ':' + at, at),
      studentChangeEventStatement(env, app, {
        eventId: await studentChangeEventId('weekend-plan:' + task.id + ':' + date + ':' + at),
        studentId: task.studentId, taskId: task.id, eventType: 'work_instruction', changedFields: ['weekendPlans'],
        details: { before: current || null, after: cancel ? null : { date, startTime, endTime } },
        audienceStaffIds: [row.owner], effectiveDate: date, requiresAck: false,
        changedAt: at, changedBy: studentChangeActorKey(auth)
      })
    ]);
  } catch (error) {
    if (isTaskWriteCasConflict(error)) return fail('수업 정보가 변경되었습니다. 새로고침 후 다시 선택해 주세요', 409);
    if (error.status) return fail(error.message, error.status);
    throw error;
  }
  return json({ ok: true, task: next }, 200, origin);
}
