import { validateRosterDocument } from './roster.js';
import { hasFlexibleWeekendVisit, weekendAttendancePolicyOn } from './weekend-flex.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const GROUP_ID = /^mc_[a-f0-9]{48}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const POLICY = 'recommended_v1';
const POLICY_VIEW = Object.freeze({
  present: 1,
  late: 1,
  approvedAbsence: 0,
  sameDayCancellation: 1,
  noShow: 1,
  academyCancellation: 0,
  completedMakeup: 'same-consumption-group-once'
});
const ABSENCE_EVENTS = new Set(['approved_absence', 'same_day', 'no_show', 'academy_cancel']);
const ADJUST_REASONS = new Set(['correction', 'carryover', 'manual_credit', 'manual_charge', 'other']);
const SENSITIVE_KEY = /(phone|contact|address|price|payment|amount|fee|receipt|memo|note)/i;

function reply(json, origin, body, status = 200) {
  return json(body, status, origin);
}

function actor(auth) {
  return auth.id || (auth.role === 'manager' ? 'manager' : 'director');
}

function isDate(value) {
  const text = String(value || '');
  if (!ISO_DATE.test(text)) return false;
  const [year, month, day] = text.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function kstDateAt(value) {
  return new Date(Number(value) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function kstToday() {
  return kstDateAt(Date.now());
}

function containsSensitiveKey(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) return true;
    if (containsSensitiveKey(child, seen)) return true;
  }
  return false;
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function consumptionGroup(app, taskId, date) {
  return 'mc_' + (await sha256(app + '\n' + taskId + '\n' + date)).slice(0, 48);
}

async function studentHash(studentId) {
  return await sha256('student-id\n' + studentId);
}

function assignmentKey(task) {
  return String(task.lessonAssignmentKey || task.lessonDedupeKey || task.id);
}

async function taskHash(task, owner) {
  return await sha256([
    'lesson-task', task.id, owner, task.studentId,
    assignmentKey(task)
  ].join('\n'));
}

function activeOn(student, date) {
  const month = date.slice(0, 7);
  return String(student.start || '') <= month && (!student.end || String(student.end) > month);
}

function occursOn(task, date) {
  if (task.deleted || (task.start && date < task.start) || (task.end && date > task.end)) return false;
  const day = new Date(date + 'T00:00:00Z').getUTCDay();
  if (task.repeat === 'once') return date === task.start;
  if (task.repeat === 'daily') return true;
  if (task.repeat === 'weekday') return day >= 1 && day <= 5;
  return task.repeat === 'days' && Array.isArray(task.days) && task.days.includes(day);
}

async function rosterDocument(env, app) {
  const row = await env.DB.prepare('SELECT data FROM private_rosters WHERE app=? LIMIT 1').bind(app).first();
  if (!row) return { error: '원생 명단이 아직 준비되지 않았습니다', status: 409 };
  try { return { document: validateRosterDocument(JSON.parse(row.data)) }; }
  catch (error) { return { error: '저장된 원생 명단을 확인해 주세요', status: 500 }; }
}

async function taskRow(env, app, taskId) {
  const row = await env.DB.prepare('SELECT owner,data FROM tasks WHERE app=? AND id=? LIMIT 1')
    .bind(app, taskId).first();
  if (!row) return null;
  try { return { owner: String(row.owner || ''), task: JSON.parse(row.data) }; }
  catch (error) { return null; }
}

async function activeStaff(env, app, staffId) {
  const row = await env.DB.prepare('SELECT data FROM staff WHERE app=? AND id=? LIMIT 1')
    .bind(app, staffId).first();
  if (!row) return false;
  try { return !JSON.parse(row.data).deleted; } catch (error) { return false; }
}

async function assignmentContext(env, app, document, studentId, lessonTaskId) {
  const student = document.roster.students.find(item => item.id === studentId);
  if (!student) return { error: '현재 원생 명단에서 학생을 찾을 수 없습니다', code: 'STUDENT_IDENTITY_MISMATCH' };
  const loaded = await taskRow(env, app, lessonTaskId);
  if (!loaded || !loaded.task || loaded.task.id !== lessonTaskId || loaded.task.deleted ||
      loaded.task.studentId !== studentId || loaded.task.staffId !== loaded.owner ||
      !(loaded.task.taskKind === 'lesson_instruction' || loaded.task.lessonFormVersion || loaded.task.intakeVersion)) {
    return { error: '현재 수업과 회차권의 학생·수업 연결이 일치하지 않습니다', code: 'TASK_IDENTITY_MISMATCH' };
  }
  if (!SAFE_ID.test(loaded.owner) || !await activeStaff(env, app, loaded.owner)) {
    return { error: '현재 담당 선생님과 수업 연결을 확인해 주세요', code: 'TASK_ASSIGNMENT_MISMATCH' };
  }
  return { student, task: loaded.task, owner: loaded.owner };
}

export async function verifySessionPackIdentity(env, app, document, pack) {
  const context = await assignmentContext(env, app, document, String(pack.student_id), String(pack.lesson_task_id));
  if (context.error) return context;
  const [currentStudentHash, currentTaskHash] = await Promise.all([
    studentHash(context.student.id), taskHash(context.task, context.owner)
  ]);
  if (currentStudentHash !== String(pack.student_identity_hash) ||
      currentTaskHash !== String(pack.task_identity_hash) || context.owner !== String(pack.task_owner) ||
      assignmentKey(context.task) !== String(pack.lesson_assignment_key)) {
    return { error: '회차권 생성 당시의 학생·수업 정체성과 현재 정보가 다릅니다', code: 'PACK_IDENTITY_MISMATCH' };
  }
  return context;
}

async function loadPack(env, app, packId) {
  return await env.DB.prepare('SELECT * FROM session_packs WHERE app=? AND pack_id=? LIMIT 1')
    .bind(app, packId).first();
}

async function usageRows(env, app, packId) {
  const result = await env.DB.prepare(
    'SELECT entry_id,source_type,source_ref,source_date,attendance_event,delta,consumption_group_id,reason_code,actor_id,created_at ' +
    'FROM session_pack_usage WHERE app=? AND pack_id=? ORDER BY created_at,entry_id'
  ).bind(app, packId).all();
  return result.results || [];
}

function taskLabel(task) {
  return [...new Set([task.subject, task.className, task.lessonRole].map(value => String(value || '').trim()).filter(Boolean))]
    .join(' · ');
}

function entryView(row) {
  return {
    entryId: String(row.entry_id), sourceType: String(row.source_type), sourceKey: String(row.source_ref),
    sourceDate: row.source_date || null, event: String(row.attendance_event), delta: Number(row.delta),
    consumptionGroupId: row.consumption_group_id || null, reasonCode: row.reason_code || null,
    actorId: String(row.actor_id), createdAt: Number(row.created_at)
  };
}

async function packView(env, app, pack, context, integrity) {
  const rows = await usageRows(env, app, String(pack.pack_id));
  const used = rows.reduce((sum, row) => sum + Number(row.delta), 0);
  return {
    packId: String(pack.pack_id), studentId: String(pack.student_id),
    studentName: context ? String(context.student.name || '') : '',
    grade: context ? String(context.student.grade || '') : '',
    lessonTaskId: String(pack.lesson_task_id), lessonLabel: context ? taskLabel(context.task) : '',
    teacherId: String(pack.task_owner), totalSessions: Number(pack.total_sessions), usedSessions: used,
    remainingSessions: Number(pack.total_sessions) - used, validFrom: String(pack.valid_from),
    expiresOn: String(pack.expires_on), expired: kstToday() > String(pack.expires_on),
    deductionPolicy: POLICY, policy: POLICY_VIEW, status: String(pack.status), revision: Number(pack.revision),
    integrity: integrity || 'ok', createdAt: Number(pack.created_at), updatedAt: Number(pack.updated_at),
    usage: rows.map(entryView)
  };
}

function ownAllowed(auth, context) {
  return auth.scope === 'all' || (auth.scope === 'own' && auth.id === context.owner);
}

async function listPacks(env, app, body, auth, document, json, origin) {
  const studentId = body.studentId == null ? '' : String(body.studentId);
  if (studentId && !SAFE_ID.test(studentId)) return reply(json, origin, { ok: false, error: '학생 ID를 확인해 주세요' }, 400);
  const result = await env.DB.prepare(
    'SELECT * FROM session_packs WHERE app=?' + (studentId ? ' AND student_id=?' : '') + ' ORDER BY updated_at DESC'
  ).bind(app, ...(studentId ? [studentId] : [])).all();
  const packs = [];
  for (const row of result.results || []) {
    const context = await verifySessionPackIdentity(env, app, document, row);
    if (context.error) {
      if (auth.scope === 'all') packs.push(await packView(env, app, row, null, context.code));
      continue;
    }
    if (!ownAllowed(auth, context)) continue;
    packs.push(await packView(env, app, row, context));
  }
  return reply(json, origin, { ok: true, packs });
}

async function createPack(env, app, body, auth, document, json, origin) {
  if (auth.scope !== 'all') return reply(json, origin, { ok: false, error: '회차제 지정은 원장·관리 담당만 할 수 있습니다' }, 403);
  const studentId = String(body.studentId || '');
  const lessonTaskId = String(body.lessonTaskId || '');
  const totalSessions = Number(body.totalSessions);
  const validFrom = String(body.validFrom || '');
  const expiresOn = String(body.expiresOn || '');
  if (!SAFE_ID.test(studentId) || !SAFE_ID.test(lessonTaskId) || !Number.isInteger(totalSessions) ||
      totalSessions < 1 || totalSessions > 200 || !isDate(validFrom) || !isDate(expiresOn) || expiresOn < validFrom ||
      String(body.deductionPolicy || POLICY) !== POLICY) {
    return reply(json, origin, { ok: false, error: '학생·수업·총 횟수·유효기간·차감 정책을 확인해 주세요' }, 400);
  }
  const context = await assignmentContext(env, app, document, studentId, lessonTaskId);
  if (context.error) return reply(json, origin, { ok: false, code: context.code, error: context.error }, 409);
  if (!activeOn(context.student, validFrom) || !activeOn(context.student, expiresOn) ||
      (context.task.start && validFrom < context.task.start) || (context.task.end && expiresOn > context.task.end)) {
    return reply(json, origin, { ok: false, error: '학생 재원 기간과 수업 적용 기간 안에서 유효기간을 지정해 주세요' }, 409);
  }
  const now = Date.now();
  const packId = 'sp_' + crypto.randomUUID().replace(/-/g, '');
  const [sHash, tHash] = await Promise.all([studentHash(studentId), taskHash(context.task, context.owner)]);
  try {
    await env.DB.prepare(
      'INSERT INTO session_packs(app,pack_id,student_id,lesson_task_id,task_owner,lesson_assignment_key,' +
      'student_identity_hash,task_identity_hash,total_sessions,valid_from,expires_on,deduction_policy,status,revision,' +
      'created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,' +
      "'active',1,?,?,?,?)"
    ).bind(app, packId, studentId, lessonTaskId, context.owner, assignmentKey(context.task), sHash, tHash,
      totalSessions, validFrom, expiresOn, POLICY, now, actor(auth), now, actor(auth)).run();
  } catch (error) {
    if (/UNIQUE constraint failed/.test(String(error && error.message || error))) {
      return reply(json, origin, { ok: false, code: 'ACTIVE_PACK_EXISTS', error: '이 학생·수업에는 이미 활성 회차권이 있습니다' }, 409);
    }
    throw error;
  }
  const saved = await loadPack(env, app, packId);
  return reply(json, origin, { ok: true, pack: await packView(env, app, saved, context) });
}

async function checkEvidence(env, app, task, owner, key, expectedAttendance) {
  const sourceDate = key.slice(-10);
  const expectedKey = task.id + '|' + sourceDate;
  if (key !== expectedKey || !isDate(sourceDate)) {
    return { error: '원 수업 날짜와 출결 키를 확인해 주세요', code: 'CHECK_IDENTITY_MISMATCH' };
  }
  const weekendPolicy = weekendAttendancePolicyOn(task, sourceDate);
  const occurs = weekendPolicy === 'flexible'
    ? await hasFlexibleWeekendVisit(env, app, task, sourceDate)
    : weekendPolicy === 'fixed' && occursOn(task, sourceDate);
  if (!occurs) return { error: '원 수업 날짜와 출결 키를 확인해 주세요', code: 'CHECK_IDENTITY_MISMATCH' };
  const row = await env.DB.prepare('SELECT owner,data FROM checks WHERE app=? AND k=? LIMIT 1').bind(app, key).first();
  if (!row || String(row.owner || '') !== owner) return { error: '담당 수업의 출결 근거를 찾을 수 없습니다', code: 'CHECK_NOT_FOUND' };
  let check;
  try { check = JSON.parse(row.data); } catch (error) { return { error: '출결 근거 형식을 확인해 주세요', code: 'CHECK_INVALID' }; }
  if (check.taskId !== task.id || check.date !== key.slice(-10) || !['P', 'L', 'A', 'E'].includes(check.att) ||
      (expectedAttendance && check.att !== expectedAttendance)) {
    return { error: '현재 출결과 회차 기록 근거가 일치하지 않습니다', code: 'CHECK_IDENTITY_MISMATCH' };
  }
  return { check, date: check.date };
}

async function existingSource(env, app, sourceType, sourceRef) {
  return await env.DB.prepare('SELECT * FROM session_pack_usage WHERE app=? AND source_type=? AND source_ref=? LIMIT 1')
    .bind(app, sourceType, sourceRef).first();
}

async function positiveConsumption(env, app, packId, groupId) {
  return !!await env.DB.prepare(
    'SELECT entry_id FROM session_pack_usage WHERE app=? AND pack_id=? AND consumption_group_id=? AND delta>0 LIMIT 1'
  ).bind(app, packId, groupId).first();
}

function duplicateMatches(row, packId, event, delta, groupId, reasonCode) {
  return row && String(row.pack_id) === packId && String(row.attendance_event) === event &&
    Number(row.delta) === delta && String(row.consumption_group_id || '') === String(groupId || '') &&
    String(row.reason_code || '') === String(reasonCode || '');
}

function regularAttendanceUsage(check) {
  if (check.att === 'P' || check.att === 'E') {
    return { event: 'present', delta: 1, reasonCode: check.att === 'E' ? 'early_leave' : null };
  }
  if (check.att === 'L') return { event: 'late', delta: 1, reasonCode: null };
  const event = String(check.absenceType || check.absenceReasonCode || '');
  if (!ABSENCE_EVENTS.has(event)) return { error: 'ABSENCE_POLICY_REQUIRED' };
  return { event, delta: event === 'same_day' || event === 'no_show' ? 1 : 0, reasonCode: null };
}

async function insertUsage(env, app, input) {
  const entryId = 'su_' + crypto.randomUUID().replace(/-/g, '');
  await env.DB.prepare(
    'INSERT INTO session_pack_usage(app,entry_id,pack_id,expected_revision,source_type,source_ref,source_date,' +
    'attendance_event,delta,consumption_group_id,reason_code,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).bind(app, entryId, input.packId, input.revision, input.sourceType, input.sourceRef, input.sourceDate,
    input.event, input.delta, input.groupId, input.reasonCode, input.actorId, input.now).run();
}

function usageError(error, json, origin) {
  const message = String(error && error.message || error);
  if (/SESSION_PACK_REVISION_CONFLICT/.test(message)) {
    return reply(json, origin, { ok: false, code: 'REVISION_CONFLICT', error: '다른 기기에서 회차가 먼저 변경되었습니다' }, 409);
  }
  if (/SESSION_PACK_NOT_ACTIVE/.test(message)) {
    return reply(json, origin, { ok: false, code: 'PACK_NOT_ACTIVE', error: '닫힌 회차권에는 기록할 수 없습니다' }, 409);
  }
  if (/SESSION_PACK_DATE_OUT_OF_RANGE/.test(message)) {
    return reply(json, origin, { ok: false, code: 'DATE_OUT_OF_RANGE', error: '회차권 유효기간 밖의 수업입니다' }, 409);
  }
  if (/SESSION_PACK_BALANCE_INVALID/.test(message)) {
    return reply(json, origin, { ok: false, code: 'BALANCE_INVALID', error: '사용 횟수는 0회보다 작거나 총 횟수보다 클 수 없습니다' }, 409);
  }
  if (/SESSION_PACK_IDENTITY_MISMATCH/.test(message)) {
    return reply(json, origin, { ok: false, code: 'PACK_IDENTITY_MISMATCH',
      error: '회차권 생성 당시의 학생·수업 정체성과 현재 정보가 다릅니다' }, 409);
  }
  if (/idx_session_pack_usage_one_consumption|session_pack_usage\.app, session_pack_usage\.pack_id, session_pack_usage\.consumption_group_id/.test(message)) {
    return reply(json, origin, { ok: false, code: 'DUPLICATE_CONSUMPTION', error: '원 수업과 보강은 한 번만 차감할 수 있습니다' }, 409);
  }
  return null;
}

async function recordUsage(env, app, body, auth, document, json, origin) {
  const packId = String(body.packId || '');
  const revision = Number(body.revision);
  const sourceType = String(body.sourceType || '');
  const sourceRef = String(body.sourceKey || body.checkKey || '');
  const suppliedGroup = String(body.consumptionGroupId || '');
  if (!SAFE_ID.test(packId) || !Number.isInteger(revision) || revision < 1 ||
      !['regular', 'makeup'].includes(sourceType) || !sourceRef || sourceRef.length > 200 || !GROUP_ID.test(suppliedGroup) ||
      (body.sourceKey && body.checkKey && body.sourceKey !== body.checkKey && sourceType === 'regular')) {
    return reply(json, origin, { ok: false, error: '회차권·revision·출결 근거·소비 그룹을 확인해 주세요' }, 400);
  }
  const pack = await loadPack(env, app, packId);
  if (!pack) return reply(json, origin, { ok: false, error: '회차권을 찾을 수 없습니다' }, 404);
  const context = await verifySessionPackIdentity(env, app, document, pack);
  if (context.error) return reply(json, origin, { ok: false, code: context.code, error: context.error }, 409);
  if (auth.id !== context.owner || (auth.scope !== 'own' && auth.role !== 'manager')) {
    return reply(json, origin, { ok: false, error: '담당 선생님의 개인 인증으로만 회차를 기록할 수 있습니다' }, 403);
  }
  if (pack.status !== 'active') return reply(json, origin, { ok: false, code: 'PACK_NOT_ACTIVE', error: '닫힌 회차권에는 기록할 수 없습니다' }, 409);

  let sourceDate, event, delta, evidence, reasonCode = null;
  if (sourceType === 'regular') {
    evidence = await checkEvidence(env, app, context.task, context.owner, sourceRef);
    if (evidence.error) return reply(json, origin, { ok: false, code: evidence.code, error: evidence.error }, 409);
    sourceDate = evidence.date;
    const expectedGroup = await consumptionGroup(app, context.task.id, sourceDate);
    if (suppliedGroup !== expectedGroup) return reply(json, origin, { ok: false, code: 'CONSUMPTION_GROUP_MISMATCH', error: '출결 날짜의 소비 그룹이 일치하지 않습니다' }, 409);
    if (!activeOn(context.student, sourceDate)) return reply(json, origin, { ok: false, error: '해당 날짜에 재원 중인 학생이 아닙니다' }, 409);
    const usage = regularAttendanceUsage(evidence.check);
    if (usage.error) {
      return reply(json, origin, { ok: false, code: usage.error, error: '결석 차감 유형을 먼저 확정해 주세요' }, 409);
    }
    event = usage.event; delta = usage.delta; reasonCode = usage.reasonCode;
  } else {
    if (!/^mu_[a-f0-9]{48}$/.test(sourceRef)) return reply(json, origin, { ok: false, error: '보강 건 ID를 확인해 주세요' }, 400);
    const makeup = await env.DB.prepare(
      'SELECT case_id,student_id,source_task_id,source_date,source_teacher_id,consumption_group_id,status,completed_at ' +
      'FROM makeup_cases WHERE app=? AND case_id=? LIMIT 1'
    ).bind(app, sourceRef).first();
    if (!makeup || makeup.status !== 'completed' || !Number(makeup.completed_at) ||
        makeup.student_id !== pack.student_id || makeup.source_task_id !== pack.lesson_task_id ||
        makeup.source_teacher_id !== pack.task_owner || makeup.consumption_group_id !== suppliedGroup) {
      return reply(json, origin, { ok: false, code: 'MAKEUP_EVIDENCE_MISMATCH', error: '완료된 보강과 학생·원 수업 연결을 확인해 주세요' }, 409);
    }
    sourceDate = String(makeup.source_date);
    const expectedGroup = await consumptionGroup(app, context.task.id, sourceDate);
    if (suppliedGroup !== expectedGroup || (body.checkKey && body.checkKey !== context.task.id + '|' + sourceDate)) {
      return reply(json, origin, { ok: false, code: 'CONSUMPTION_GROUP_MISMATCH', error: '원 결석과 보강의 소비 그룹이 일치하지 않습니다' }, 409);
    }
    evidence = await checkEvidence(env, app, context.task, context.owner, context.task.id + '|' + sourceDate, 'A');
    if (evidence.error) return reply(json, origin, { ok: false, code: evidence.code, error: evidence.error }, 409);
    event = 'makeup_completed';
    const duplicate = await existingSource(env, app, sourceType, sourceRef);
    if (duplicate) {
      if (String(duplicate.pack_id) !== packId || duplicate.attendance_event !== event || duplicate.consumption_group_id !== suppliedGroup) {
        return reply(json, origin, { ok: false, code: 'SOURCE_ALREADY_USED', error: '이 보강 근거가 다른 회차 기록에 이미 사용되었습니다' }, 409);
      }
      return reply(json, origin, { ok: true, idempotent: true, pack: await packView(env, app, pack, context) });
    }
    delta = await positiveConsumption(env, app, packId, suppliedGroup) ? 0 : 1;
  }

  const duplicate = await existingSource(env, app, sourceType, sourceRef);
  if (duplicate) {
    if (!duplicateMatches(duplicate, packId, event, delta, suppliedGroup, reasonCode)) {
      return reply(json, origin, { ok: false, code: 'SOURCE_ALREADY_USED', error: '이 출결 근거가 다른 회차 기록에 이미 사용되었습니다' }, 409);
    }
    return reply(json, origin, { ok: true, idempotent: true, pack: await packView(env, app, pack, context) });
  }
  if (sourceDate < pack.valid_from || sourceDate > pack.expires_on) {
    return reply(json, origin, { ok: false, code: 'DATE_OUT_OF_RANGE', error: '회차권 유효기간 밖의 수업입니다' }, 409);
  }
  try {
    await insertUsage(env, app, {
      packId, revision, sourceType, sourceRef, sourceDate, event, delta, groupId: suppliedGroup,
      reasonCode, actorId: actor(auth), now: Date.now()
    });
  } catch (error) {
    const raced = await existingSource(env, app, sourceType, sourceRef);
    if (duplicateMatches(raced, packId, event, delta, suppliedGroup, reasonCode)) {
      const current = await loadPack(env, app, packId);
      return reply(json, origin, { ok: true, idempotent: true, pack: await packView(env, app, current, context) });
    }
    const mapped = usageError(error, json, origin);
    if (mapped) return mapped;
    throw error;
  }
  const current = await loadPack(env, app, packId);
  return reply(json, origin, { ok: true, idempotent: false, pack: await packView(env, app, current, context) });
}

async function adjustPack(env, app, body, auth, document, json, origin) {
  if (auth.scope !== 'all') return reply(json, origin, { ok: false, error: '회차 조정은 원장·관리 담당만 할 수 있습니다' }, 403);
  const packId = String(body.packId || '');
  const revision = Number(body.revision);
  const delta = Number(body.delta);
  const sourceRef = String(body.sourceKey || '');
  const reasonCode = String(body.reasonCode || '');
  if (!SAFE_ID.test(packId) || !Number.isInteger(revision) || revision < 1 || !Number.isInteger(delta) ||
      delta === 0 || Math.abs(delta) > 200 || !SAFE_ID.test(sourceRef) || !ADJUST_REASONS.has(reasonCode)) {
    return reply(json, origin, { ok: false, error: '회차권·revision·조정값·조정 ID·사유 코드를 확인해 주세요' }, 400);
  }
  const pack = await loadPack(env, app, packId);
  if (!pack) return reply(json, origin, { ok: false, error: '회차권을 찾을 수 없습니다' }, 404);
  const context = await verifySessionPackIdentity(env, app, document, pack);
  if (context.error) return reply(json, origin, { ok: false, code: context.code, error: context.error }, 409);
  const duplicate = await existingSource(env, app, 'adjustment', sourceRef);
  if (duplicate) {
    if (!duplicateMatches(duplicate, packId, 'manual_adjustment', delta, null, reasonCode)) {
      return reply(json, origin, { ok: false, code: 'SOURCE_ALREADY_USED', error: '이 조정 ID가 이미 사용되었습니다' }, 409);
    }
    return reply(json, origin, { ok: true, idempotent: true, pack: await packView(env, app, pack, context) });
  }
  try {
    await insertUsage(env, app, {
      packId, revision, sourceType: 'adjustment', sourceRef, sourceDate: null,
      event: 'manual_adjustment', delta, groupId: null, reasonCode, actorId: actor(auth), now: Date.now()
    });
  } catch (error) {
    const raced = await existingSource(env, app, 'adjustment', sourceRef);
    if (duplicateMatches(raced, packId, 'manual_adjustment', delta, null, reasonCode)) {
      const current = await loadPack(env, app, packId);
      return reply(json, origin, { ok: true, idempotent: true, pack: await packView(env, app, current, context) });
    }
    const mapped = usageError(error, json, origin);
    if (mapped) return mapped;
    throw error;
  }
  const current = await loadPack(env, app, packId);
  return reply(json, origin, { ok: true, idempotent: false, pack: await packView(env, app, current, context) });
}

async function closePack(env, app, body, auth, document, json, origin) {
  if (auth.scope !== 'all') return reply(json, origin, { ok: false, error: '회차권 종료는 원장·관리 담당만 할 수 있습니다' }, 403);
  const packId = String(body.packId || '');
  const revision = Number(body.revision);
  if (!SAFE_ID.test(packId) || !Number.isInteger(revision) || revision < 1) {
    return reply(json, origin, { ok: false, error: '회차권과 revision을 확인해 주세요' }, 400);
  }
  const pack = await loadPack(env, app, packId);
  if (!pack) return reply(json, origin, { ok: false, error: '회차권을 찾을 수 없습니다' }, 404);
  const context = await verifySessionPackIdentity(env, app, document, pack);
  const now = Date.now();
  const result = await env.DB.prepare(
    "UPDATE session_packs SET status='closed',revision=revision+1,updated_at=?,updated_by=?,closed_at=?,closed_by=? " +
    "WHERE app=? AND pack_id=? AND revision=? AND status='active'"
  ).bind(now, actor(auth), now, actor(auth), app, packId, revision).run();
  if (!result.meta || Number(result.meta.changes || 0) !== 1) {
    return reply(json, origin, { ok: false, code: 'REVISION_CONFLICT', error: '다른 기기에서 회차권이 먼저 변경되었습니다' }, 409);
  }
  const current = await loadPack(env, app, packId);
  return reply(json, origin, { ok: true, pack: await packView(env, app, current,
    context.error ? null : context, context.error ? context.code : undefined) });
}

/** 매일 23:50 KST에 그날의 최종 출결을 회차 원장에 한 번만 반영한다. */
export async function handleScheduledSessionPackAttendance(env, scheduledTime) {
  const cutoff = Number(scheduledTime) || Date.now();
  const sourceDate = kstDateAt(cutoff);
  const summary = { ok: true, sourceDate, processed: 0, idempotent: 0, skipped: 0, failed: 0 };
  const roster = await rosterDocument(env, 'task');
  if (roster.error) return { ...summary, ok: false, code: 'ROSTER_NOT_READY' };

  let rows;
  try {
    const result = await env.DB.prepare(
      "SELECT * FROM session_packs WHERE app='task' AND status='active' " +
      'AND valid_from<=? AND expires_on>=? ORDER BY pack_id'
    ).bind(sourceDate, sourceDate).all();
    rows = result.results || [];
  } catch (error) {
    return { ...summary, ok: false, code: 'SESSION_PACK_LEDGER_NOT_READY' };
  }

  for (const listed of rows) {
    const context = await verifySessionPackIdentity(env, 'task', roster.document, listed);
    if (context.error || !activeOn(context.student, sourceDate)) {
      summary.skipped++;
      continue;
    }
    const sourceRef = context.task.id + '|' + sourceDate;
    const evidence = await checkEvidence(env, 'task', context.task, context.owner, sourceRef);
    if (evidence.error) {
      summary.skipped++;
      continue;
    }
    const usage = regularAttendanceUsage(evidence.check);
    if (usage.error) {
      summary.skipped++;
      continue;
    }
    const groupId = await consumptionGroup('task', context.task.id, sourceDate);
    const duplicate = await existingSource(env, 'task', 'regular', sourceRef);
    if (duplicate) {
      if (duplicateMatches(duplicate, String(listed.pack_id), usage.event, usage.delta, groupId, usage.reasonCode)) {
        summary.idempotent++;
      } else {
        summary.failed++;
      }
      continue;
    }

    let current = await loadPack(env, 'task', String(listed.pack_id));
    let recorded = false;
    for (let attempt = 0; attempt < 2 && current && current.status === 'active'; attempt++) {
      try {
        await insertUsage(env, 'task', {
          packId: String(current.pack_id), revision: Number(current.revision), sourceType: 'regular',
          sourceRef, sourceDate, event: usage.event, delta: usage.delta, groupId,
          reasonCode: usage.reasonCode, actorId: 'system-session-cutoff', now: cutoff
        });
        summary.processed++;
        recorded = true;
        break;
      } catch (error) {
        const raced = await existingSource(env, 'task', 'regular', sourceRef);
        if (duplicateMatches(raced, String(current.pack_id), usage.event, usage.delta, groupId, usage.reasonCode)) {
          summary.idempotent++;
          recorded = true;
          break;
        }
        if (!/SESSION_PACK_REVISION_CONFLICT/.test(String(error && error.message || error))) break;
        current = await loadPack(env, 'task', String(current.pack_id));
      }
    }
    if (!recorded) summary.failed++;
  }
  return summary;
}

export async function handleSessionPack(env, app, body, origin, auth, json) {
  body = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (app !== 'task') return reply(json, origin, { ok: false, error: '업무지시서에서만 회차를 관리할 수 있습니다' }, 400);
  if (!auth || !['all', 'own'].includes(auth.scope) || (auth.scope === 'own' && !SAFE_ID.test(String(auth.id || '')))) {
    return reply(json, origin, { ok: false, error: '인증이 필요합니다' }, 401);
  }
  if (containsSensitiveKey(body)) {
    return reply(json, origin, { ok: false, code: 'SENSITIVE_FIELD_FORBIDDEN', error: '회차 원장에는 결제·연락처·민감 메모를 저장할 수 없습니다' }, 400);
  }
  const action = String(body.action || 'list');
  if (!['list', 'create', 'record', 'adjust', 'close'].includes(action)) {
    return reply(json, origin, { ok: false, error: '지원하지 않는 회차 작업입니다' }, 400);
  }
  const roster = await rosterDocument(env, app);
  if (roster.error) return reply(json, origin, { ok: false, error: roster.error }, roster.status);
  try {
    if (action === 'list') return await listPacks(env, app, body, auth, roster.document, json, origin);
    if (action === 'create') return await createPack(env, app, body, auth, roster.document, json, origin);
    if (action === 'record') return await recordUsage(env, app, body, auth, roster.document, json, origin);
    if (action === 'adjust') return await adjustPack(env, app, body, auth, roster.document, json, origin);
    return await closePack(env, app, body, auth, roster.document, json, origin);
  } catch (error) {
    console.error('session-pack', error);
    return reply(json, origin, { ok: false, error: '회차 처리 중 오류가 발생했습니다' }, 500);
  }
}
