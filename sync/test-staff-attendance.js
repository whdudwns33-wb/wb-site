const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TEST_STAFF_NAME = '테스트쌤';
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const MAX_TASKS_PER_RUN = 200;

function parseJson(value, fallback = null) {
  try { return JSON.parse(value); } catch (error) { return fallback; }
}

function kstDateAt(value) {
  const date = new Date(Number(value) + KST_OFFSET_MS);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
}

function previousDate(date) {
  const parsed = new Date(String(date) + 'T00:00:00Z');
  if (!ISO_DATE.test(String(date)) || Number.isNaN(parsed.getTime())) return '';
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}

function weekday(date) {
  return new Date(String(date) + 'T00:00:00Z').getUTCDay();
}

function isLesson(task) {
  return !!task && !task.deleted &&
    (task.taskKind === 'lesson_instruction' || task.lessonFormVersion || task.intakeVersion);
}

function occursOnDate(task, date) {
  if (!isLesson(task) || !ISO_DATE.test(String(date || ''))) return false;
  if (task.start && String(date) < String(task.start)) return false;
  if (task.end && String(date) > String(task.end)) return false;
  if (String(task.lessonInstanceType || '') === 'makeup' || task.makeupCaseId) return false;

  if (Array.isArray(task.scheduleSlots) && task.scheduleSlots.length) {
    const day = weekday(date);
    return task.scheduleSlots.some(slot => {
      if (!slot || !Array.isArray(slot.days) || !slot.days.includes(day)) return false;
      const from = String(slot.validFrom || slot.startDate || '');
      const to = String(slot.validTo || slot.endDate || '');
      return (!from || date >= from) && (!to || date <= to);
    });
  }

  const repeat = String(task.repeat || '');
  if (repeat === 'once') return String(task.start || '') === date;
  if (repeat === 'daily') return true;
  if (repeat === 'weekday') return weekday(date) >= 1 && weekday(date) <= 5;
  if (repeat === 'days') return Array.isArray(task.days) && task.days.includes(weekday(date));
  return false;
}

function configuredStaffIds(env) {
  return String(env && env.TASK_TEST_STAFF_IDS || '').split(',')
    .map(value => value.trim()).filter(value => SAFE_ID.test(value));
}

async function activeStaffRows(env, app) {
  const result = await env.DB.prepare(
    'SELECT id,data FROM staff WHERE app=? ORDER BY id'
  ).bind(app).all();
  return (result.results || []).map(row => ({
    id: String(row.id || ''), data: parseJson(row.data, null)
  })).filter(row => SAFE_ID.test(row.id) && row.data && !row.data.deleted);
}

/**
 * 운영 식별자는 staff.id로만 사용한다. 이름은 관리자가 지정한 테스트 정책을
 * 찾기 위한 단일 설정값일 뿐, 출결·보강 쓰기에는 반환된 stable staffId만 쓴다.
 * 동명이 직원이 생기면 fail-closed로 정책을 적용하지 않는다.
 */
export async function findTestStaffIds(env, app = 'task') {
  if (app !== 'task') return new Set();
  const rows = await activeStaffRows(env, app);
  const configured = new Set(configuredStaffIds(env));
  if (configured.size) return new Set(rows.filter(row => configured.has(row.id)).map(row => row.id));
  const named = rows.filter(row => String(row.data.name || '').trim() === TEST_STAFF_NAME);
  return named.length === 1 ? new Set([named[0].id]) : new Set();
}

export async function isTestStaffId(env, app, staffId) {
  const id = String(staffId || '');
  if (!SAFE_ID.test(id)) return false;
  const ids = await findTestStaffIds(env, app);
  return ids.has(id);
}

function checkDataForPresent(taskId, date, current, now) {
  const data = current && current.data && typeof current.data === 'object' && !Array.isArray(current.data)
    ? { ...current.data } : {};
  return {
    ...data,
    taskId: String(taskId),
    date: String(date),
    att: 'P',
    absenceType: '',
    autoAttendance: 'next_day_test_staff',
    updatedAt: now
  };
}

/**
 * 다음 날이 된 테스트쌤의 정규 수업은 출결을 출석으로 확정한다.
 * 이미 입력된 메모·업무진행 값은 보존하고, 동시에 들어온 수동 출결은
 * updated_at CAS로 덮어쓰지 않는다. 이 함수는 cron과 /sync 양쪽에서
 * 호출해 cron 지연에도 첫 다음 동기화에서 정본을 보정한다.
 */
export async function applyTestStaffNextDayAttendance(env, app = 'task', at = Date.now()) {
  const summary = { ok: true, date: '', staffCount: 0, candidates: 0, inserted: 0, updated: 0, skipped: 0 };
  if (app !== 'task') return summary;
  const date = previousDate(kstDateAt(at));
  if (!date) return { ...summary, ok: false };
  summary.date = date;
  const staffIds = await findTestStaffIds(env, app);
  summary.staffCount = staffIds.size;
  if (!staffIds.size) return summary;

  const ids = [...staffIds];
  const tasks = await env.DB.prepare(
    'SELECT id,owner,data FROM tasks WHERE app=? AND owner IN (' + ids.map(() => '?').join(',') + ') ORDER BY id LIMIT ' + MAX_TASKS_PER_RUN
  ).bind(app, ...ids).all();
  const candidates = [];
  for (const row of tasks.results || []) {
    const task = parseJson(row.data, null);
    if (!SAFE_ID.test(String(row.id || '')) || !isLesson(task) || !occursOnDate(task, date)) continue;
    candidates.push({ id: String(row.id), owner: String(row.owner), task });
  }
  summary.candidates = candidates.length;
  if (!candidates.length) return summary;

  const keys = candidates.map(row => row.id + '|' + date);
  const currentResult = await env.DB.prepare(
    'SELECT k,owner,data,updated_at FROM checks WHERE app=? AND k IN (' + keys.map(() => '?').join(',') + ')'
  ).bind(app, ...keys).all();
  const current = new Map((currentResult.results || []).map(row => [String(row.k), row]));
  const now = Number(at) || Date.now();
  const statements = [];
  const statementMeta = [];
  for (const row of candidates) {
    const key = row.id + '|' + date;
    const existing = current.get(key);
    if (existing && String(existing.owner || '') !== row.owner) {
      summary.skipped++;
      continue;
    }
    const oldData = existing ? parseJson(existing.data, {}) : null;
    const nextData = checkDataForPresent(row.id, date, { data: oldData }, now);
    if (existing) {
      if (oldData && oldData.att === 'P' && oldData.autoAttendance === 'next_day_test_staff') {
        summary.skipped++;
        continue;
      }
      statements.push(env.DB.prepare(
        'UPDATE checks SET data=?,updated_at=?,srv_at=? WHERE app=? AND k=? AND owner=? AND updated_at=?'
      ).bind(JSON.stringify(nextData), now, now, app, key, row.owner, Number(existing.updated_at || 0)));
      statementMeta.push({ kind: 'update' });
    } else {
      statements.push(env.DB.prepare(
        'INSERT OR IGNORE INTO checks(app,k,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)'
      ).bind(app, key, row.owner, JSON.stringify(nextData), now, now));
      statementMeta.push({ kind: 'insert' });
    }
  }
  if (!statements.length) return summary;
  const results = await env.DB.batch(statements);
  results.forEach((result, index) => {
    const changed = Number(result && result.meta && result.meta.changes || 0) === 1;
    if (!changed) { summary.skipped++; return; }
    if (statementMeta[index] && statementMeta[index].kind === 'update') summary.updated++;
    else summary.inserted++;
  });
  return summary;
}

export { TEST_STAFF_NAME, occursOnDate };
