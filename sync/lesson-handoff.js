import { isTaskWriteCasConflict, taskWriteCasGuardStatement } from './task-write-cas.js';
import { flexibleWeekendAllowedOn, weekendAttendancePolicyOn } from './weekend-flex.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const HANDOFF_ID = /^lh_[a-f0-9]{32}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MEMO_KEYS = ['contentProgress', 'homework', 'comment', 'otherNotes'];
const CUTOFF_MINUTE = 23 * 60 + 50;

function parseJson(value) {
  try { return JSON.parse(String(value || '')); } catch (error) { return null; }
}

function fail(code, error, status = 409) { return { code, error, status }; }
function own(auth) { return auth && auth.scope === 'own'; }
function admin(auth) { return auth && auth.scope === 'all'; }
function actor(auth) { return String(auth && auth.id || '__admin__'); }
function randomId(prefix) { return prefix + crypto.randomUUID().replace(/-/g, ''); }

function validDate(value) {
  if (!DATE_RE.test(String(value || ''))) return false;
  const date = new Date(String(value) + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function dayOf(date) { return new Date(date + 'T00:00:00Z').getUTCDay(); }
function weekend(date) { return validDate(date) && [0, 6].includes(dayOf(date)); }
function addDays(date, amount) {
  return new Date(Date.parse(date + 'T00:00:00Z') + amount * 86400000).toISOString().slice(0, 10);
}
function pairDates(date) {
  if (!weekend(date)) return [];
  return dayOf(date) === 6 ? [date, addDays(date, 1)] : [addDays(date, -1), date];
}
function kst(now = Date.now()) {
  const value = new Date(now + 9 * 3600000);
  return { date: value.toISOString().slice(0, 10), minute: value.getUTCHours() * 60 + value.getUTCMinutes() };
}
function minute(time) { return CLOCK_RE.test(String(time || '')) ? Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) : null; }
function writeWindow(date, now = Date.now()) {
  const current = kst(now);
  if (date !== current.date) return fail('HANDOFF_DATE_CLOSED', '수업 인계는 실제 수업 당일에만 변경할 수 있습니다');
  if (current.minute >= CUTOFF_MINUTE) return fail('HANDOFF_CUTOFF', '당일 23:50 이후에는 인계 내용을 변경할 수 없습니다');
  return null;
}

function halfUnits(value) {
  if (typeof value !== 'string' || !/^(?:0\.5|[1-6](?:\.5)?)T$/.test(value)) return null;
  const units = Number(value.slice(0, -1)) * 2;
  return Number.isInteger(units) && units >= 1 && units <= 12 ? units : null;
}
function hours(units) { return String(Number(units) / 2) + 'T'; }
function cleanText(value, limit, required = false) {
  if (typeof value !== 'string') return value == null && !required ? '' : null;
  const text = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return text.length <= limit && (!required || text) ? text : null;
}
function emptyMemo() { return Object.fromEntries(MEMO_KEYS.map(key => [key, ''])); }
function inputMemo(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !MEMO_KEYS.includes(key))) return null;
  const memo = emptyMemo();
  for (const key of MEMO_KEYS) {
    memo[key] = cleanText(value[key], 4000);
    if (memo[key] == null) return null;
  }
  return memo;
}
function sourceMemo(check) {
  const stored = check && check.lessonMemo;
  const structured = stored && typeof stored === 'object' && !Array.isArray(stored) &&
    MEMO_KEYS.some(key => Object.prototype.hasOwnProperty.call(stored, key));
  const memo = Object.fromEntries(MEMO_KEYS.map(key => [key, structured ? String(stored[key] || '') : '']));
  if (!structured) memo.contentProgress = String(check && check.note || '');
  return memo;
}
function meaningfulCheck(check) {
  return !!(check && (check.att || check.done || check.blocked || check.at || check.absenceType ||
    Number(check.count || 0) > 0 || String(check.note || '').trim() ||
    (check.steps && Object.values(check.steps).some(Boolean)) ||
    (Array.isArray(check.items) && check.items.some(Boolean)) ||
    (check.lessonMemo && Object.values(check.lessonMemo).some(value => String(value || '').trim()))));
}

function isLesson(task) {
  return !!(task && !task.deleted && (task.taskKind === 'lesson_instruction' || task.lessonFormVersion || task.intakeVersion));
}
function activeOn(task, date) {
  return (!task.start || String(task.start) <= date) && (!task.end || String(task.end) >= date);
}
function matchingSlots(task, date) {
  if (!isLesson(task) || !validDate(date) || !activeOn(task, date) || task.scheduleStatus === 'needs_review' ||
      (task.repeat === 'once' && String(task.start || '') !== date)) return [];
  return (Array.isArray(task.scheduleSlots) ? task.scheduleSlots : []).filter(slot => {
    if (!slot || slot.status === 'needs_review' || !Array.isArray(slot.days) || !slot.days.map(Number).includes(dayOf(date))) return false;
    const from = String(slot.validFrom || slot.startDate || ''), to = String(slot.validTo || slot.endDate || '');
    return (!from || (validDate(from) && from <= date)) && (!to || (validDate(to) && to >= date));
  });
}
function selectSlot(task, date, slotId) {
  const slots = matchingSlots(task, date);
  if (!slots.length) return fail('HANDOFF_SOURCE_NOT_SCHEDULED', '원래 수업일의 확정 시간표를 확인해 주세요', 422);
  if (slots.length > 1 && !slotId) return fail('HANDOFF_SLOT_REQUIRED', '같은 날 수업이 여러 개이면 인계할 시간대를 선택해 주세요', 422);
  const matched = slotId ? slots.filter(slot => String(slot.slotId || '') === slotId) : slots;
  if (matched.length !== 1) return fail('HANDOFF_SLOT_INVALID', '선택한 원 수업 시간대를 확인할 수 없습니다', 422);
  const slot = matched[0], totalUnits = halfUnits(slot.lessonHours);
  if (!totalUnits || totalUnits < 2 || minute(slot.startTime) == null || minute(slot.endTime) == null ||
      minute(slot.endTime) <= minute(slot.startTime) || (slot.slotId && !SAFE_ID.test(String(slot.slotId)))) {
    return fail('HANDOFF_HOURS_INVALID', '확정 시간표의 수업시수를 확인해 주세요. 시간으로 시수를 추정하지 않습니다', 422);
  }
  return { slot, slotId: String(slot.slotId || ''), totalUnits };
}
function lessonIdentity(context) {
  const task = context.task, slot = context.slot;
  return {
    subject: String(task.subject || ''), className: String(task.className || ''), lessonRole: String(task.lessonRole || ''),
    lessonAssignmentKey: String(task.lessonAssignmentKey || ''), lessonDedupeKey: String(task.lessonDedupeKey || ''),
    slot: {
      slotId: String(slot.slotId || ''), days: [...new Set(slot.days.map(Number))].sort((left, right) => left - right),
      startTime: String(slot.startTime), endTime: String(slot.endTime), lessonHours: hours(context.totalUnits),
      validFrom: String(slot.validFrom || slot.startDate || ''), validTo: String(slot.validTo || slot.endDate || ''),
      lessonRole: String(slot.lessonRole || ''), status: String(slot.status || 'normal')
    }
  };
}
function sameLessonIdentity(row, context) {
  const snapshot = parseJson(row.lesson_snapshot_json);
  return !!(context && !context.error && snapshot && snapshot.identity &&
    JSON.stringify(snapshot.identity) === JSON.stringify(lessonIdentity(context)));
}
function sameRowContext(row, context) {
  return !!(context && !context.error && context.totalUnits === Number(row.total_half_units) &&
    context.slotId === String(row.slot_id || '') && sameLessonIdentity(row, context) &&
    (!row.visit_id || (context.visit && String(context.visit.visit_id) === String(row.visit_id))));
}
function visitSourceDate(task, row) {
  const pair = pairDates(String(row.visit_date || ''));
  if (!pair.length) return '';
  if (row.source_date != null) {
    const date = String(row.source_date);
    return pair.includes(date) && matchingSlots(task, date).length ? date : '';
  }
  if (matchingSlots(task, String(row.visit_date)).length) return String(row.visit_date);
  const opposite = pair.find(date => date !== String(row.visit_date));
  return opposite && matchingSlots(task, opposite).length ? opposite : '';
}
function visitView(row) {
  return row ? {
    visitId: String(row.visit_id), studentId: String(row.student_id), lessonTaskId: String(row.lesson_task_id),
    staffId: String(row.staff_id), visitDate: String(row.visit_date), sourceDate: row.source_date == null ? null : String(row.source_date),
    visitSequence: Math.max(1, Number(row.visit_sequence) || 1), checkInAt: Number(row.check_in_at),
    checkOutAt: row.check_out_at == null ? null : Number(row.check_out_at), status: String(row.status),
    revision: Number(row.revision), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at)
  } : null;
}

async function generationContext(env, app) {
  try {
    const row = await env.DB.prepare('SELECT generation FROM app_data_generations WHERE app=? LIMIT 1').bind(app).first();
    const generation = Number(row && row.generation);
    if (!row || !Number.isSafeInteger(generation) || generation < 0) throw new Error('LESSON_HANDOFF_GENERATION_INVALID');
    return { generation, hasTable: true };
  } catch (error) {
    // migration 이전의 로컬 fixture만 0세대 호환; 다른 오류는 fail closed.
    if (!/no such table.*app_data_generations/i.test(String(error && error.message || error))) throw error;
    return { generation: 0, hasTable: false };
  }
}
function generationGuard(app, generation) {
  return generation.hasTable ? {
    sql: 'EXISTS (SELECT 1 FROM app_data_generations generation WHERE generation.app=? AND generation.generation=?)',
    args: [app, generation.generation]
  } : { sql: '1=1', args: [] };
}
async function activeStaff(env, app, id) {
  if (!SAFE_ID.test(id)) return null;
  const row = await env.DB.prepare('SELECT id,data FROM staff WHERE app=? AND id=? LIMIT 1').bind(app, id).first();
  const value = row && parseJson(row.data);
  return value && !value.deleted && String(value.id || '') === id ? { id, data: String(row.data), value } : null;
}
async function findHandoff(env, app, id) {
  return await env.DB.prepare('SELECT * FROM lesson_handoffs WHERE app=? AND handoff_id=? LIMIT 1').bind(app, id).first();
}
async function currentTask(env, app, id, studentId, sourceStaffId) {
  const row = await env.DB.prepare('SELECT owner,data FROM tasks WHERE app=? AND id=? LIMIT 1').bind(app, id).first();
  const task = row && parseJson(row.data), owner = String(row && row.owner || '');
  if (!isLesson(task) || String(task.id || '') !== id || String(task.studentId || '') !== studentId ||
      !SAFE_ID.test(owner) || String(task.staffId || '') !== owner || (sourceStaffId && sourceStaffId !== owner)) return null;
  return { task, owner, taskData: String(row.data) };
}

async function verifiedContext(env, app, input) {
  const loaded = await currentTask(env, app, input.lessonTaskId, input.studentId, input.sourceStaffId);
  if (!loaded) return fail('HANDOFF_LESSON_IDENTITY', '원 수업과 학생·담당 교사 연결이 변경되었습니다');
  const { task, owner } = loaded;
  if (!activeOn(task, input.recordDate)) return fail('HANDOFF_SOURCE_NOT_SCHEDULED', '실제 수업일에 활성 상태인 수업이 아닙니다', 422);
  const selected = selectSlot(task, input.sourceDate, input.slotId);
  if (selected.error) return selected;
  const [source, recipient, rosterRow] = await Promise.all([
    activeStaff(env, app, owner), activeStaff(env, app, input.recipientStaffId),
    env.DB.prepare('SELECT data FROM private_rosters WHERE app=? LIMIT 1').bind(app).first()
  ]);
  if (!source || !recipient || source.id === recipient.id) return fail('HANDOFF_STAFF_INVALID', '현재 재직 중인 다른 선생님을 선택해 주세요', 422);
  const roster = rosterRow && parseJson(rosterRow.data);
  const students = roster && roster.roster && Array.isArray(roster.roster.students) ? roster.roster.students : [];
  const matches = students.filter(student => student && !student.deleted && String(student.id || '') === input.studentId);
  if (matches.length !== 1) return fail('HANDOFF_STUDENT_IDENTITY', '현재 원생 명단에서 학생 연결을 확인할 수 없습니다');
  const student = matches[0], month = input.recordDate.slice(0, 7);
  if ((student.start && String(student.start).slice(0, 7) > month) || (student.end && String(student.end).slice(0, 7) <= month)) {
    return fail('HANDOFF_STUDENT_INACTIVE', '실제 수업일에 재원 중인 학생이 아닙니다', 422);
  }
  let visits = [], visit = null, visitPair = [], sourceCheckData;
  if (weekend(input.sourceDate) || weekend(input.recordDate)) {
    visitPair = pairDates(input.recordDate);
    if (!visitPair.includes(input.sourceDate)) return fail('HANDOFF_DATE_MAPPING', '원 수업일과 실제 방문일의 연결이 일치하지 않습니다', 422);
    const policy = weekendAttendancePolicyOn(task, input.recordDate);
    if (policy === 'invalid' || (policy === 'flexible' && !flexibleWeekendAllowedOn(task, input.recordDate))) {
      return fail('HANDOFF_DATE_MAPPING', '현재 토·일 실제 수업일 설정을 확인해 주세요', 422);
    }
    const result = await env.DB.prepare(
      "SELECT * FROM weekend_actual_visits WHERE app=? AND lesson_task_id=? AND student_id=? AND visit_date IN (?,?) " +
      "AND status<>'cancelled' ORDER BY visit_date,visit_sequence,visit_id"
    ).bind(app, input.lessonTaskId, input.studentId, ...visitPair).all();
    visits = result.results || [];
    const mapped = visits.filter(row => visitSourceDate(task, row) === input.sourceDate);
    const dates = [...new Set(mapped.map(row => String(row.visit_date)))];
    if (dates.length > 1 || (dates.length && dates[0] !== input.recordDate) ||
        (!mapped.length && (input.sourceDate !== input.recordDate || policy === 'flexible'))) {
      return fail('HANDOFF_DATE_MAPPING', '원 수업 카드와 실제 방문일을 먼저 확인해 주세요');
    }
    const ordered = mapped.filter(row => String(row.visit_date) === input.recordDate)
      .sort((left, right) => Number(right.visit_sequence || 1) - Number(left.visit_sequence || 1));
    visit = ordered.find(row => row.status === 'active') || ordered[0] || null;
    if (visit && String(visit.staff_id) !== owner) return fail('HANDOFF_VISIT_IDENTITY', '실제 방문 기록의 원 담당 교사 연결을 확인해 주세요');
    if (input.sourceDate !== input.recordDate) {
      const oldCheck = await env.DB.prepare('SELECT data FROM checks WHERE app=? AND k=? LIMIT 1')
        .bind(app, input.lessonTaskId + '|' + input.sourceDate).first();
      if (oldCheck && meaningfulCheck(parseJson(oldCheck.data))) return fail('HANDOFF_DATE_MAPPING', '원 수업일에 기존 기록이 있어 실제 방문일로 자동 전환할 수 없습니다');
      sourceCheckData = oldCheck ? String(oldCheck.data) : null;
    }
  } else if (input.sourceDate !== input.recordDate) {
    return fail('HANDOFF_DATE_MAPPING', '평일 인계는 원 수업일과 같은 날짜에만 가능합니다', 422);
  }
  const checkKey = input.lessonTaskId + '|' + input.recordDate;
  const checkRow = await env.DB.prepare('SELECT owner,data FROM checks WHERE app=? AND k=? LIMIT 1').bind(app, checkKey).first();
  const check = checkRow && parseJson(checkRow.data);
  if (!check || String(checkRow.owner || '') !== owner || String(check.taskId || '') !== input.lessonTaskId ||
      String(check.date || '') !== input.recordDate || !['P', 'L'].includes(check.att)) {
    return fail('HANDOFF_ATTENDANCE_REQUIRED', '원 수업의 출석 또는 지각을 먼저 저장해 주세요', 422);
  }
  return { ...loaded, ...selected, student, source, recipient, rosterData: String(rosterRow.data),
    check, checkKey, checkData: String(checkRow.data), visits, visit, visitPair, sourceCheckData };
}

function contextGuard(app, context, generation) {
  const guard = generationGuard(app, generation);
  const clauses = [guard.sql], args = [...guard.args];
  clauses.push('EXISTS (SELECT 1 FROM tasks t WHERE t.app=? AND t.id=? AND t.owner=? AND t.data=?)');
  args.push(app, context.task.id, context.owner, context.taskData);
  clauses.push('EXISTS (SELECT 1 FROM checks c WHERE c.app=? AND c.k=? AND c.owner=? AND c.data=?)');
  args.push(app, context.checkKey, context.owner, context.checkData);
  clauses.push('EXISTS (SELECT 1 FROM private_rosters r WHERE r.app=? AND r.data=?)');
  args.push(app, context.rosterData);
  for (const staff of [context.source, context.recipient]) {
    clauses.push('EXISTS (SELECT 1 FROM staff s WHERE s.app=? AND s.id=? AND s.data=?)');
    args.push(app, staff.id, staff.data);
  }
  if (context.visitPair.length) {
    clauses.push("(SELECT COALESCE(group_concat(visit_id || ':' || revision || ':' || status, '|'),'') FROM " +
      '(SELECT visit_id,revision,status FROM weekend_actual_visits WHERE app=? AND lesson_task_id=? AND student_id=? ' +
      "AND visit_date IN (?,?) AND status<>'cancelled' ORDER BY visit_date,visit_sequence,visit_id))=?");
    args.push(app, context.task.id, context.student.id, ...context.visitPair,
      context.visits.map(row => [row.visit_id, row.revision, row.status].join(':')).join('|'));
    if (context.check.date !== context.inputSourceDate && context.inputSourceDate) {
      // Snapshot even an empty placeholder; every concurrent source-day edit invalidates the mapping.
      if (context.sourceCheckData == null) {
        clauses.push('NOT EXISTS (SELECT 1 FROM checks old_check WHERE old_check.app=? AND old_check.k=?)');
        args.push(app, context.task.id + '|' + context.inputSourceDate);
      } else {
        clauses.push('EXISTS (SELECT 1 FROM checks old_check WHERE old_check.app=? AND old_check.k=? AND old_check.data=?)');
        args.push(app, context.task.id + '|' + context.inputSourceDate, context.sourceCheckData);
      }
    }
  }
  return { sql: clauses.join(' AND '), args };
}

function baseView(row) {
  const student = parseJson(row.student_snapshot_json) || {}, lesson = parseJson(row.lesson_snapshot_json) || {};
  return {
    handoffId: String(row.handoff_id), lessonTaskId: String(row.lesson_task_id), studentId: String(row.student_id),
    sourceDate: String(row.source_date), recordDate: String(row.record_date), slotId: row.slot_id || null,
    sourceStaffId: String(row.source_staff_id), recipientStaffId: String(row.recipient_staff_id), startTime: String(row.start_time),
    totalHours: hours(row.total_half_units), completedHours: hours(row.completed_half_units), remainingHours: hours(row.remaining_half_units),
    note: String(row.note), status: String(row.status), revision: Number(row.revision), createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at), acceptedAt: row.accepted_at == null ? null : Number(row.accepted_at),
    completedAt: row.completed_at == null ? null : Number(row.completed_at), cancelledAt: row.cancelled_at == null ? null : Number(row.cancelled_at),
    cancelReason: String(row.cancel_reason || ''), memo: sourceMemo({ lessonMemo: parseJson(row.memo_json) }),
    sourceMemo: sourceMemo({ lessonMemo: parseJson(row.source_memo_json) }),
    student: { id: String(row.student_id), name: String(student.name || ''), school: String(student.school || ''), grade: String(student.grade || '') },
    lesson: { title: String(lesson.title || ''), subject: String(lesson.subject || '') }
  };
}
async function view(env, app, row, auth) {
  const result = baseView(row), current = kst(), inWindow = !writeWindow(row.record_date);
  const context = await verifiedContext(env, app, rowInput(row));
  const loaded = context.error
    ? await currentTask(env, app, String(row.lesson_task_id), String(row.student_id), String(row.source_staff_id)) : context;
  const checkRow = context.error && loaded ? await env.DB.prepare('SELECT owner,data FROM checks WHERE app=? AND k=? LIMIT 1')
    .bind(app, String(row.lesson_task_id) + '|' + String(row.record_date)).first() : null;
  const check = !context.error ? context.check :
    (checkRow && String(checkRow.owner || '') === String(row.source_staff_id) ? parseJson(checkRow.data) : null);
  result.attendance = { att: check && check.taskId === row.lesson_task_id && check.date === row.record_date &&
    ['P', 'L', 'A', 'E'].includes(check.att) ? check.att : '' };
  result.visit = null;
  if (loaded && row.visit_id) {
    const physical = await env.DB.prepare('SELECT * FROM weekend_actual_visits WHERE app=? AND visit_id=? LIMIT 1')
      .bind(app, String(row.visit_id)).first();
    if (physical && physical.status !== 'cancelled' && String(physical.student_id) === String(row.student_id) &&
        String(physical.lesson_task_id) === String(row.lesson_task_id) && String(physical.staff_id) === String(row.source_staff_id) &&
        String(physical.visit_date) === String(row.record_date) && visitSourceDate(loaded.task, physical) === String(row.source_date)) {
      result.visit = visitView(physical);
    }
  }
  const receiver = admin(auth) || actor(auth) === String(row.recipient_staff_id);
  const ready = sameRowContext(row, context) && ['P', 'L'].includes(result.attendance.att);
  result.editable = {
    accept: ready && receiver && inWindow && row.status === 'pending',
    save: ready && receiver && inWindow && ['accepted', 'completed'].includes(row.status),
    complete: ready && receiver && inWindow && current.minute >= minute(row.start_time) && row.status === 'accepted',
    cancel: row.status !== 'cancelled' && (admin(auth) ||
      (actor(auth) === String(row.source_staff_id) && inWindow && row.status === 'pending'))
  };
  return result;
}

function rowInput(row) {
  return { lessonTaskId: String(row.lesson_task_id), studentId: String(row.student_id),
    sourceStaffId: String(row.source_staff_id), recipientStaffId: String(row.recipient_staff_id),
    sourceDate: String(row.source_date), recordDate: String(row.record_date), slotId: String(row.slot_id || '') };
}
function sameCreation(row, input, context, generation) {
  return !!row && Number(row.data_generation) === generation.generation &&
    ['lessonTaskId', 'studentId', 'sourceDate', 'recordDate', 'recipientStaffId'].every(key => rowInput(row)[key] === input[key]) &&
    String(row.source_staff_id) === context.owner && String(row.slot_id || '') === context.slotId &&
    String(row.start_time) === input.startTime && String(row.note) === input.note &&
    Number(row.total_half_units) === context.totalUnits && Number(row.completed_half_units) === input.completedUnits &&
    Number(row.remaining_half_units) === input.remainingUnits;
}
function eventStatement(env, app, handoffId, revision, type, before, after, auth, at, eventId) {
  return env.DB.prepare('INSERT INTO lesson_handoff_events ' +
    '(app,event_id,handoff_id,revision,event_type,event_data,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .bind(app, eventId, handoffId, revision, type, JSON.stringify({ version: 1, before, after }), actor(auth), at);
}
async function batchWrite(env, app, first, id, revision, type, before, after, auth, at) {
  const eventId = randomId('lhe_');
  const guard = await taskWriteCasGuardStatement(env, app, 'lesson_handoff_' + type, [id, revision, eventId].join('\n'), at);
  await env.DB.batch([first, guard, eventStatement(env, app, id, revision, type, before, after, auth, at, eventId)]);
}

async function list(env, app, body, origin, auth, json, generation) {
  const date = String(body.date || '');
  if (!validDate(date)) return json({ ok: false, code: 'HANDOFF_DATE_INVALID', error: '조회할 날짜를 확인해 주세요' }, 422, origin);
  const result = await env.DB.prepare('SELECT * FROM lesson_handoffs WHERE app=? AND data_generation=? AND record_date=?' +
    (own(auth) ? ' AND (source_staff_id=? OR recipient_staff_id=?)' : '') + ' ORDER BY created_at,handoff_id')
    .bind(app, generation.generation, date, ...(own(auth) ? [actor(auth), actor(auth)] : [])).all();
  const staffResult = await env.DB.prepare('SELECT id,data FROM staff WHERE app=? ORDER BY id').bind(app).all();
  const recipients = [];
  for (const row of staffResult.results || []) {
    const staff = parseJson(row.data);
    if (SAFE_ID.test(String(row.id)) && staff && !staff.deleted && String(staff.id || '') === String(row.id)) {
      recipients.push({ staffId: String(row.id), name: String(staff.name || '').slice(0, 80) });
    }
  }
  const handoffs = [];
  for (const row of result.results || []) handoffs.push(await view(env, app, row, auth));
  return json({ ok: true, handoffs, recipients, dataGeneration: generation.generation }, 200, origin);
}

async function create(env, app, body, origin, auth, json, generation) {
  const input = {
    lessonTaskId: String(body.lessonTaskId || ''), studentId: String(body.studentId || ''),
    sourceDate: String(body.sourceDate || ''), recordDate: String(body.recordDate || ''),
    slotId: String(body.slotId || ''), recipientStaffId: String(body.recipientStaffId || ''),
    startTime: String(body.startTime || ''), completedUnits: halfUnits(body.completedHours),
    remainingUnits: halfUnits(body.remainingHours), note: cleanText(body.note, 2000)
  };
  const id = String(body.handoffId || '');
  if (!HANDOFF_ID.test(id) || !SAFE_ID.test(input.lessonTaskId) || !SAFE_ID.test(input.studentId) ||
      !SAFE_ID.test(input.recipientStaffId) || (input.slotId && !SAFE_ID.test(input.slotId)) ||
      !validDate(input.sourceDate) || !validDate(input.recordDate) || minute(input.startTime) == null ||
      minute(input.startTime) >= CUTOFF_MINUTE || !input.completedUnits || !input.remainingUnits || input.note == null) {
    return json({ ok: false, code: 'HANDOFF_INPUT_INVALID', error: '학생·원 수업·날짜·인계 시간·수업시수를 확인해 주세요' }, 422, origin);
  }
  const now = Date.now(), closed = writeWindow(input.recordDate, now);
  if (closed) return json({ ok: false, code: closed.code, error: closed.error }, closed.status, origin);
  const context = await verifiedContext(env, app, input);
  if (context.error) return json({ ok: false, code: context.code, error: context.error }, context.status, origin);
  if (own(auth) && actor(auth) !== context.owner) return json({ ok: false, code: 'HANDOFF_FORBIDDEN', error: '원 담당 교사만 남은 수업을 인계할 수 있습니다' }, 403, origin);
  if (context.totalUnits !== input.completedUnits + input.remainingUnits) {
    return json({ ok: false, code: 'HANDOFF_HOURS_MISMATCH', error: '완료 시수와 남은 시수의 합이 원 수업의 확정 시수와 같아야 합니다' }, 422, origin);
  }
  if (context.visit && minute(input.startTime) < kst(Number(context.visit.check_in_at)).minute) {
    return json({ ok: false, code: 'HANDOFF_START_BEFORE_ARRIVAL', error: '인계 시작은 실제 등원 이후로 선택해 주세요' }, 422, origin);
  }
  const existing = await findHandoff(env, app, id);
  if (existing) {
    if (!sameCreation(existing, input, context, generation)) return json({ ok: false, code: 'HANDOFF_ID_CONFLICT', error: '같은 인계 ID에 다른 내용이 이미 저장되어 있습니다' }, 409, origin);
    return json({ ok: true, idempotent: true, handoff: await view(env, app, existing, auth), dataGeneration: generation.generation }, 200, origin);
  }
  if (context.visit && context.visit.status !== 'active') {
    return json({ ok: false, code: 'HANDOFF_VISIT_COMPLETED', error: '이미 하원한 기록은 새로 인계할 수 없습니다' }, 409, origin);
  }
  context.inputSourceDate = input.sourceDate;
  const guard = contextGuard(app, context, generation);
  const student = { id: input.studentId, name: String(context.student.name || ''), school: String(context.student.school || ''), grade: String(context.student.grade || '') };
  const lesson = { title: String(context.task.title || ''), subject: String(context.task.subject || ''), identity: lessonIdentity(context) };
  const insert = env.DB.prepare('INSERT INTO lesson_handoffs ' +
    '(app,handoff_id,data_generation,lesson_task_id,student_id,source_date,record_date,slot_id,source_staff_id,recipient_staff_id,visit_id,' +
    'start_time,total_half_units,completed_half_units,remaining_half_units,note,source_memo_json,memo_json,student_snapshot_json,lesson_snapshot_json,' +
    'status,revision,created_at,updated_at,created_by,updated_by) ' +
    "SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',1,?,?,?,? WHERE " + guard.sql)
    .bind(app, id, generation.generation, input.lessonTaskId, input.studentId, input.sourceDate, input.recordDate, context.slotId,
      context.owner, input.recipientStaffId, context.visit ? String(context.visit.visit_id) : null, input.startTime, context.totalUnits,
      input.completedUnits, input.remainingUnits, input.note, JSON.stringify(sourceMemo(context.check)), JSON.stringify(emptyMemo()),
      JSON.stringify(student), JSON.stringify(lesson), now, now, actor(auth), actor(auth), ...guard.args);
  try {
    await batchWrite(env, app, insert, id, 1, 'create', null,
      { status: 'pending', startTime: input.startTime, completedHours: hours(input.completedUnits), remainingHours: hours(input.remainingUnits) }, auth, now);
  } catch (error) {
    const raced = await findHandoff(env, app, id);
    if (sameCreation(raced, input, context, generation)) {
      return json({ ok: true, idempotent: true, handoff: await view(env, app, raced, auth), dataGeneration: generation.generation }, 200, origin);
    }
    if (raced) return json({ ok: false, code: 'HANDOFF_ID_CONFLICT', error: '같은 인계 ID에 다른 내용이 먼저 저장되었습니다' }, 409, origin);
    if (/idx_lesson_handoffs_one_source|lesson_handoffs\.app, lesson_handoffs\.lesson_task_id, lesson_handoffs\.source_date/.test(String(error && error.message || error))) {
      return json({ ok: false, code: 'HANDOFF_ALREADY_EXISTS', error: '이 원 수업일에는 이미 인계 기록이 있습니다. 기존 기록을 확인해 주세요' }, 409, origin);
    }
    throw error;
  }
  return json({ ok: true, handoff: await view(env, app, await findHandoff(env, app, id), auth), dataGeneration: generation.generation }, 200, origin);
}

async function change(env, app, body, origin, auth, json, generation) {
  const id = String(body.handoffId || ''), revision = Number(body.revision), action = String(body.action);
  if (!HANDOFF_ID.test(id) || !Number.isSafeInteger(revision) || revision < 1) {
    return json({ ok: false, code: 'HANDOFF_REVISION_REQUIRED', error: '인계 기록과 저장 버전을 확인해 주세요' }, 422, origin);
  }
  const row = await findHandoff(env, app, id);
  if (!row || (own(auth) && ![row.source_staff_id, row.recipient_staff_id].includes(actor(auth)))) {
    return json({ ok: false, code: 'HANDOFF_NOT_FOUND', error: '인계 기록을 찾을 수 없습니다' }, 404, origin);
  }
  if (Number(row.data_generation) !== generation.generation) return json({ ok: false, code: 'DATA_GENERATION_MISMATCH', dataGeneration: generation.generation, error: '새 운영 데이터로 다시 동기화해 주세요' }, 409, origin);
  if (Number(row.revision) !== revision) return json({ ok: false, code: 'HANDOFF_REVISION_CONFLICT', error: '다른 기기에서 인계 기록이 먼저 변경되었습니다' }, 409, origin);
  const now = Date.now(), closed = action === 'cancel' && admin(auth) ? null : writeWindow(String(row.record_date), now);
  if (closed) return json({ ok: false, code: closed.code, error: closed.error }, closed.status, origin);
  const recipient = admin(auth) || actor(auth) === String(row.recipient_staff_id);
  const source = admin(auth) || actor(auth) === String(row.source_staff_id);
  if ((action === 'cancel' && (!source || (!admin(auth) && row.status !== 'pending'))) ||
      (action !== 'cancel' && !recipient)) return json({ ok: false, code: 'HANDOFF_FORBIDDEN', error: '이 인계 작업을 변경할 권한이 없습니다' }, 403, origin);
  let guard = generationGuard(app, generation);
  if (action !== 'cancel') {
    const input = rowInput(row), context = await verifiedContext(env, app, input);
    if (context.error) return json({ ok: false, code: context.code, error: context.error }, context.status, origin);
    if (!sameRowContext(row, context)) {
      return json({ ok: false, code: 'HANDOFF_CONTEXT_CHANGED', error: '원 수업 또는 실제 방문 연결이 변경되어 인계를 확인해야 합니다' }, 409, origin);
    }
    context.inputSourceDate = input.sourceDate;
    guard = contextGuard(app, context, generation);
  } else if (own(auth)) {
    const current = await currentTask(env, app, String(row.lesson_task_id), String(row.student_id), String(row.source_staff_id));
    if (!current) return json({ ok: false, code: 'HANDOFF_LESSON_IDENTITY', error: '원 수업 담당자가 변경되어 관리자 확인이 필요합니다' }, 409, origin);
    const currentSource = await activeStaff(env, app, actor(auth));
    if (!currentSource) return json({ ok: false, code: 'HANDOFF_STAFF_INVALID', error: '현재 재직 중인 원 담당 교사만 인계를 취소할 수 있습니다' }, 403, origin);
    guard.sql += ' AND EXISTS (SELECT 1 FROM tasks t WHERE t.app=? AND t.id=? AND t.owner=? AND t.data=?)';
    guard.args.push(app, row.lesson_task_id, row.source_staff_id, current.taskData);
    guard.sql += ' AND EXISTS (SELECT 1 FROM staff s WHERE s.app=? AND s.id=? AND s.data=?)';
    guard.args.push(app, currentSource.id, currentSource.data);
  }
  const beforeMemo = sourceMemo({ lessonMemo: parseJson(row.memo_json) });
  let memo = beforeMemo, status = String(row.status), acceptedAt = row.accepted_at, completedAt = row.completed_at,
    cancelledAt = row.cancelled_at, reason = String(row.cancel_reason || '');
  if (action === 'accept') {
    if (status === 'accepted') return json({ ok: true, idempotent: true, handoff: await view(env, app, row, auth), dataGeneration: generation.generation }, 200, origin);
    if (status !== 'pending') return json({ ok: false, code: 'HANDOFF_STATUS_INVALID', error: '대기 중인 인계만 수락할 수 있습니다' }, 409, origin);
    status = 'accepted'; acceptedAt = now;
  } else if (action === 'save' || action === 'complete') {
    if (!['accepted', 'completed'].includes(status)) return json({ ok: false, code: 'HANDOFF_STATUS_INVALID', error: '인계를 수락한 뒤 기록해 주세요' }, 409, origin);
    if (Object.prototype.hasOwnProperty.call(body, 'memo')) memo = inputMemo(body.memo);
    else if (action === 'save') memo = null;
    if (!memo) return json({ ok: false, code: 'HANDOFF_MEMO_INVALID', error: '인계받은 수업 메모는 항목별 4000자 이내로 입력해 주세요' }, 422, origin);
    if (action === 'complete') {
      if (kst(now).minute < minute(row.start_time)) return json({ ok: false, code: 'HANDOFF_NOT_STARTED', error: '인계 시작 시간이 지난 뒤 완료할 수 있습니다' }, 422, origin);
      if (status === 'completed') {
        if (JSON.stringify(memo) !== JSON.stringify(beforeMemo)) return json({ ok: false, code: 'HANDOFF_ALREADY_COMPLETED', error: '완료된 인계는 메모 저장으로 수정해 주세요' }, 409, origin);
        return json({ ok: true, idempotent: true, handoff: await view(env, app, row, auth), dataGeneration: generation.generation }, 200, origin);
      }
      status = 'completed'; completedAt = now;
    } else if (JSON.stringify(memo) === JSON.stringify(beforeMemo)) {
      return json({ ok: true, idempotent: true, handoff: await view(env, app, row, auth), dataGeneration: generation.generation }, 200, origin);
    }
  } else {
    reason = cleanText(body.reason, 500, true);
    if (!reason) return json({ ok: false, code: 'HANDOFF_CANCEL_REASON_REQUIRED', error: '인계 취소 사유를 입력해 주세요' }, 422, origin);
    if (status === 'cancelled') {
      if (reason !== String(row.cancel_reason)) return json({ ok: false, code: 'HANDOFF_STATUS_INVALID', error: '취소한 인계 기록은 변경할 수 없습니다' }, 409, origin);
      return json({ ok: true, idempotent: true, handoff: await view(env, app, row, auth), dataGeneration: generation.generation }, 200, origin);
    }
    status = 'cancelled'; cancelledAt = now;
  }
  const updatedAt = Math.max(now, Number(row.updated_at) + 1);
  const update = env.DB.prepare('UPDATE lesson_handoffs SET status=?,memo_json=?,accepted_at=?,completed_at=?,cancelled_at=?,cancel_reason=?,' +
    'revision=revision+1,updated_at=?,updated_by=? WHERE app=? AND handoff_id=? AND revision=? AND data_generation=? AND ' + guard.sql)
    .bind(status, JSON.stringify(memo), acceptedAt, completedAt, cancelledAt, reason, updatedAt, actor(auth),
      app, id, revision, generation.generation, ...guard.args);
  await batchWrite(env, app, update, id, revision + 1, action,
    { status: row.status, memo: beforeMemo }, { status, memo, reason }, auth, updatedAt);
  return json({ ok: true, handoff: await view(env, app, await findHandoff(env, app, id), auth), dataGeneration: generation.generation }, 200, origin);
}

/** A narrow physical-checkout grant; this never authorizes generic task/check writes. */
export async function lessonHandoffCheckoutGrant(env, app, auth, visitRow) {
  if (app !== 'task' || !own(auth) || !SAFE_ID.test(actor(auth)) || !visitRow ||
      !['active', 'completed'].includes(visitRow.status) || String(visitRow.visit_date || '') !== kst().date) return null;
  try {
    const generation = await generationContext(env, app);
    const rows = await env.DB.prepare('SELECT * FROM lesson_handoffs WHERE app=? AND data_generation=? AND lesson_task_id=? AND student_id=? ' +
      "AND record_date=? AND visit_id=? AND recipient_staff_id=? AND status IN ('accepted','completed')")
      .bind(app, generation.generation, String(visitRow.lesson_task_id), String(visitRow.student_id), String(visitRow.visit_date),
        String(visitRow.visit_id), actor(auth)).all();
    if ((rows.results || []).length !== 1) return null;
    const row = rows.results[0];
    if (kst().minute < minute(row.start_time) || String(visitRow.staff_id) !== String(row.source_staff_id)) return null;
    const loaded = await currentTask(env, app, String(row.lesson_task_id), String(row.student_id), String(row.source_staff_id));
    if (!loaded || visitSourceDate(loaded.task, visitRow) !== String(row.source_date) ||
        !activeOn(loaded.task, String(row.record_date)) || !await activeStaff(env, app, actor(auth))) return null;
    const selected = selectSlot(loaded.task, String(row.source_date), String(row.slot_id || ''));
    if (selected.error || selected.totalUnits !== Number(row.total_half_units) || selected.slotId !== String(row.slot_id || '') ||
        !sameLessonIdentity(row, { ...loaded, ...selected })) return null;
    const physical = await env.DB.prepare('SELECT * FROM weekend_actual_visits WHERE app=? AND visit_id=? LIMIT 1')
      .bind(app, String(visitRow.visit_id)).first();
    if (!physical || !['active', 'completed'].includes(physical.status) ||
        ['student_id', 'lesson_task_id', 'staff_id', 'visit_date'].some(key => String(physical[key]) !== String(visitRow[key])) ||
        physical.source_date !== visitRow.source_date || Number(physical.revision) !== Number(visitRow.revision)) return null;
    return { handoffId: String(row.handoff_id), revision: Number(row.revision), sourceDate: String(row.source_date) };
  } catch (error) {
    if (/no such table.*(?:lesson_handoffs|weekend_actual_visits)/i.test(String(error && error.message || error))) return null;
    throw error;
  }
}

export async function handleLessonHandoff(env, app, body, origin, auth, json) {
  body = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (app !== 'task') return json({ ok: false, error: '직원 앱에서만 수업을 인계할 수 있습니다' }, 400, origin);
  if ((!own(auth) && !admin(auth)) || !SAFE_ID.test(actor(auth)) || (own(auth) && !auth.id)) {
    return json({ ok: false, error: '직원 인증이 필요합니다' }, 401, origin);
  }
  try {
    if (own(auth) && !await activeStaff(env, app, actor(auth))) return json({ ok: false, error: '현재 재직 중인 직원 인증이 필요합니다' }, 403, origin);
    const generation = await generationContext(env, app), requested = body.dataGeneration == null ? 0 : Number(body.dataGeneration);
    if (!Number.isSafeInteger(requested) || requested < 0 || requested !== generation.generation) {
      return json({ ok: false, code: 'DATA_GENERATION_MISMATCH', dataGeneration: generation.generation,
        error: '운영 데이터가 새 세대로 전환되었습니다. 다시 동기화해 주세요' }, 409, origin);
    }
    const action = String(body.action || 'list');
    if (action === 'list') return await list(env, app, body, origin, auth, json, generation);
    if (action === 'create') return await create(env, app, body, origin, auth, json, generation);
    if (['accept', 'save', 'complete', 'cancel'].includes(action)) return await change(env, app, body, origin, auth, json, generation);
    return json({ ok: false, error: '지원하지 않는 수업 인계 작업입니다' }, 400, origin);
  } catch (error) {
    if (/no such table.*(?:lesson_handoffs|lesson_handoff_events|task_write_cas_guards)/i.test(String(error && error.message || error))) {
      return json({ ok: false, code: 'LESSON_HANDOFF_NOT_READY', error: '수업 인계 기능을 준비하고 있습니다' }, 503, origin);
    }
    if (isTaskWriteCasConflict(error)) return json({ ok: false, code: 'HANDOFF_REVISION_CONFLICT', error: '수업 또는 인계 기록이 먼저 변경되었습니다. 새로고침해 주세요' }, 409, origin);
    // Do not include SQL, roster snapshots, or submitted notes in errors/logs.
    return json({ ok: false, code: 'LESSON_HANDOFF_FAILED', error: '수업 인계 처리 중 오류가 발생했습니다' }, 500, origin);
  }
}

export const lessonHandoffInternals = Object.freeze({ validDate, halfUnits, selectSlot, visitSourceDate, kst });
