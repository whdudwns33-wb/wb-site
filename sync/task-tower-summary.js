import { digest } from './task-director.js';
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
    "JOIN staff s ON s.app=t.app AND s.id=t.owner WHERE t.app='task'"
  ).bind(date).all();
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
export async function handleTaskTowerSummary(request, env) {
  if (request.method !== 'GET') return reply({error:'GET만 허용'},405);
  const expected = String(env.TASK_TOWER_READ_SECRET || '');
  const token = (request.headers.get('Authorization') || '').match(/^Bearer (\S+)$/)?.[1] || '';
  if (!KEY_PATTERN.test(expected) || !KEY_PATTERN.test(token) ||
      expected === env.TASK_MCP_READ_SECRET || expected === env.TASK_ADMIN_SECRET ||
      await digest(token) !== await digest(expected)) return reply({error:'인증 실패'},401);
  if (request.headers.has('Origin')) return reply({error:'서버 연결 전용'},403);
  if (new URL(request.url).search) return reply({error:'조회 조건은 받지 않습니다'},400);
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
