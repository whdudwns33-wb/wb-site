import lessonProgress from '../task/lesson-progress-core.js';
import { digest } from './task-director.js';
import { CHECKER_ID } from './task-checker.js';
import { countCenterUnread } from './center-chat.js';
import { countMakeupNeeded } from './makeup.js';
import { hasWeekendActualVisit } from './weekend-flex.js';

const KEY_PATTERN = /^wbt_ct_[A-Za-z0-9_-]{43}$/;
const KST_OFFSET = 9 * 60 * 60 * 1000;
const kstTimestamp = now => new Date(now + KST_OFFSET).toISOString().replace('Z', '+09:00');
function reply(body, status = 200) {
  return new Response(JSON.stringify(body), {status, headers: {
    'Content-Type':'application/json;charset=utf-8', 'Cache-Control':'no-store, private',
    'X-Content-Type-Options':'nosniff', 'X-Robots-Tag':'noindex, nofollow',
    ...(status === 401 ? {'WWW-Authenticate':'Bearer realm="wb-task-tower"'} : {})
  }});
}
function object(value) {
  const result = JSON.parse(value);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('invalid data');
  return result;
}

// task/index.html의 occursOn: 유효 시간표·비정기 예약/실제 방문을 포함한다.
async function occursOn(env, task, date) {
  if (task.deleted || (task.start && date < task.start) || (task.end && date > task.end)) return false;
  const day = new Date(date + 'T00:00:00Z').getUTCDay();
  if (task.weekendAttendanceMode === 'flexible' && /^\d{4}-\d{2}-\d{2}$/.test(task.weekendFlexibleFrom || '') && date >= task.weekendFlexibleFrom) {
    if (![0,6].includes(day)) return false;
    const planned = Array.isArray(task.weekendAllowedDays) && task.weekendAllowedDays.map(Number).includes(day) &&
      (task.weekendPlans || []).some(plan => plan.date === date);
    return planned || await hasWeekendActualVisit(env, 'task', task, date);
  }
  if (task.repeat === 'days' && Array.isArray(task.scheduleSlots) && task.scheduleSlots.length) {
    return task.scheduleSlots.some(slot => slot &&
      (!(slot.validFrom || slot.startDate) || (slot.validFrom || slot.startDate) <= date) &&
      (!(slot.validTo || slot.endDate) || date <= (slot.validTo || slot.endDate)) &&
      Array.isArray(slot.days) && slot.days.map(Number).includes(day));
  }
  switch (task.repeat) {
    case 'once': return date === task.start;
    case 'daily': return true;
    case 'weekday': return day >= 1 && day <= 5;
    case 'days': return (task.days || []).includes(day);
    default: return false;
  }
}
async function countBlocked(env, date) {
  const result = await env.DB.prepare(
    'SELECT t.data task_data,c.data check_data,s.data staff_data FROM tasks t ' +
    'JOIN checks c ON c.app=t.app AND c.k=t.id||\'|\'||? ' +
    "JOIN staff s ON s.app=t.app AND s.id=t.owner WHERE t.app='task' AND s.id NOT IN (?,?)"
  ).bind(date,CHECKER_ID,'wb점검').all();
  let count = 0;
  for (const row of result.results) {
    const task = object(row.task_data), check = object(row.check_data), staff = object(row.staff_data);
    if (!staff.deleted && task.staffId === staff.id && check.blocked &&
      !/^\[주문\]\s*/.test(String(task.title || '')) && await occursOn(env, task, date)) count++;
  }
  return count;
}
async function countOrNull(read) {
  try {
    const value = await read();
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch { return null; }
}
async function rejectTowerRequest(request, env) {
  if (request.method !== 'GET') return reply({error:'GET만 허용'},405);
  const expected = String(env.TASK_TOWER_READ_SECRET || '');
  const token = (request.headers.get('Authorization') || '').match(/^Bearer (\S+)$/)?.[1] || '';
  if (!KEY_PATTERN.test(expected) || !KEY_PATTERN.test(token) ||
      expected === env.TASK_MCP_READ_SECRET || expected === env.TASK_ADMIN_SECRET ||
      await digest(token) !== await digest(expected)) return reply({error:'인증 실패'},401);
  if (request.headers.has('Origin')) return reply({error:'서버 연결 전용'},403);
  if (new URL(request.url).search) return reply({error:'조회 조건은 받지 않습니다'},400);
}
export async function handleTaskTowerSummary(request, env) {
  const rejection = await rejectTowerRequest(request, env);
  if (rejection) return rejection;
  const observed = Date.now(), date = kstTimestamp(observed).slice(0,10);
  const [center_unread, makeup_pending, blocked] = await Promise.all([
    countOrNull(async () => {
      const read = await env.DB.prepare("SELECT read_through_feed_seq FROM center_chat_reads WHERE app='task' AND reader_staff_id='director'").first();
      return countCenterUnread(env, 'task', date, 'director', read?.read_through_feed_seq || 0);
    }),
    countOrNull(() => countMakeupNeeded(env)),
    countOrNull(() => countBlocked(env,date))
  ]);
  return reply({version:1, source:'wb-task', timezone:'Asia/Seoul',
    generatedAt:kstTimestamp(Date.now()), asOf:kstTimestamp(observed),
    counts:{center_unread,makeup_pending,blocked}});
}

const USAGE_ACTIONS = ['lesson_done', 'report_written'];
const LOGIN_PATTERN = /^[A-Za-z0-9가-힣][A-Za-z0-9가-힣_.-]{0,63}$/u;
const isLesson = task => task.taskKind === 'lesson_instruction' || /^\[(수업|컨설팅)\]/.test(task.title || '');

async function taskUsage(env, observed, date, canonicalFeedbackTaskId) {
  const midnight = Date.parse(date + 'T00:00:00+09:00');
  const [staffRows, checkRows, reports, handoffs] = await Promise.all([
    env.DB.prepare("SELECT id,data FROM staff WHERE app='task'").all(),
    env.DB.prepare(
      'SELECT t.id,t.owner,t.data task_data,c.data check_data FROM tasks t ' +
      "JOIN checks c ON c.app=t.app AND c.k=t.id||'|'||? AND c.owner=t.owner WHERE t.app='task'"
    ).bind(date).all(),
    env.DB.prepare(
      'SELECT t.data task_data,f.task_id,f.owner,f.feedback_date,MIN(f.created_at) created_at ' +
      'FROM feedback_requests f JOIN tasks t ON t.app=f.app AND t.id=f.task_id ' +
      "WHERE f.app='task' AND f.feedback_type='class_feedback' AND f.status<>'cancelled' " +
      'AND f.created_at<=? ' +
      'GROUP BY f.task_id,f.owner,f.feedback_date HAVING f.feedback_date=? OR MIN(f.created_at)>=?'
    ).bind(observed,date,midnight).all(),
    env.DB.prepare(
      'SELECT h.lesson_task_id,h.source_staff_id,h.recipient_staff_id,h.status,h.completed_at,t.data task_data,' +
      "json_extract(h.lesson_snapshot_json,'$.simple') simple " +
      'FROM lesson_handoffs h JOIN tasks t ON t.app=h.app AND t.id=h.lesson_task_id AND t.owner=h.source_staff_id ' +
      'JOIN app_data_generations g ON g.app=h.app AND g.generation=h.data_generation ' +
      "WHERE h.app='task' AND h.record_date=? AND h.status<>'cancelled' " +
      "AND json_extract(t.data,'$.studentId')=h.student_id"
    ).bind(date).all()
  ]);

  const staff = new Map();
  for (const row of staffRows.results) {
    if (!object(row.data).deleted && row.id !== 'wb점검' && row.id !== CHECKER_ID && LOGIN_PATTERN.test(row.id)) {
      staff.set(row.id, { login:row.id, lastAt:null, today:{lesson_done:0,report_written:0},
        hours:Array(24).fill(0), signals:{report_today:null} });
    }
  }
  const reported = new Map();
  function record(person, action, at) {
    if (!Number.isSafeInteger(at) || at < midnight || at > observed) return;
    const label = kstTimestamp(at);
    person.today[action]++;
    person.hours[Number(label.slice(11,13))]++;
    if (!person.lastAt || person.lastAt < label) person.lastAt = label;
  }
  for (const row of reports.results) {
    const person = staff.get(row.owner);
    if (!person) continue;
    const task = object(row.task_data);
    if (task.deleted || !isLesson(task)) continue;
    if (row.feedback_date === date) {
      if (!reported.has(row.owner)) reported.set(row.owner, new Set());
      reported.get(row.owner).add(row.task_id);
    }
    record(person, 'report_written', row.created_at);
  }

  async function finish(person, task, id, feedbackOwner, at) {
    if (Number.isSafeInteger(at) && at > observed) return;
    const signal = person.signals.report_today ??= { num:0, den:0 };
    signal.den++;
    const reports = reported.get(feedbackOwner);
    if (reports?.has(await canonicalFeedbackTaskId(env, task, id, feedbackOwner))) signal.num++;
    // 이전 완료 기록에 완료 시각이 없으면 지금 시각을 대신 넣지 않는다.
    if (!Number.isSafeInteger(at) || at <= 0) unknown.add(person);
    else record(person, 'lesson_done', at);
  }
  const unknown = new Set();
  const waiting = new Set();
  for (const handoff of handoffs.results) {
    const task = object(handoff.task_data);
    if (task.deleted || task.staffId !== handoff.source_staff_id || !isLesson(task)) continue;
    if (handoff.status !== 'completed') {
      if (!handoff.simple) waiting.add(handoff.lesson_task_id);
      continue;
    }
    const recipient = staff.get(handoff.recipient_staff_id);
    if (recipient) await finish(recipient, task, handoff.lesson_task_id, handoff.source_staff_id, handoff.completed_at);
  }
  for (const row of checkRows.results) {
    const person = staff.get(row.owner);
    if (!person || waiting.has(row.id)) continue;
    const task = object(row.task_data), check = object(row.check_data);
    if (task.staffId !== row.owner || !isLesson(task) || !lessonProgress.lessonCheckIsDone(task, check) || check.blocked ||
        !await occursOn(env, task, date)) continue;
    await finish(person, task, row.id, row.owner, check.at);
  }
  for (const person of unknown) {
    person.today.lesson_done = null;
    person.hours.fill(null);
    person.lastAt = null;
  }
  return [...staff.values()];
}

export async function handleTaskTowerUsage(request, env, canonicalFeedbackTaskId) {
  const rejection = await rejectTowerRequest(request, env);
  if (rejection) return rejection;
  const observed = Date.now(), generatedAt = kstTimestamp(observed), date = generatedAt.slice(0,10);
  try {
    const people = await taskUsage(env, observed, date, canonicalFeedbackTaskId);
    return reply({version:2, source:'wb-task', timezone:'Asia/Seoul', generatedAt, date,
      actions:USAGE_ACTIONS, people});
  } catch {
    return reply({error:'사용 집계를 읽을 수 없습니다'},503);
  }
}
