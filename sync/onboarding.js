import { validateRosterDocument } from './roster.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const OPS = new Set(['create', 'item', 'package', 'classroom', 'date', 'cancel', 'restore']);
const ITEMS = new Set([
  'registration', 'guardian', 'schedule', 'arrival', 'emergency', 'system', 'payment', 'materials', 'privacy',
  'attendance', 'orientation', 'teacher', 'first_note',
  'first_feedback', 'next_schedule', 'urgent_adjust',
  'week_attendance', 'week_learning', 'week_parent', 'week_admin',
  'fortnight_fit', 'fortnight_adjust', 'fortnight_parent',
  'month_summary', 'month_report', 'month_decision', 'next_review'
]);
const PACKAGE_ITEMS = new Map([
  ['registration', 'registration'], ['schedule', 'schedule'], ['emergency', 'emergency'], ['privacy', 'privacy'],
  ['payment', 'payment'], ['system', 'system'], ['materials', 'materials']
]);
const PACKAGE_STATES = new Set(['prepared', 'delivered', 'confirmed']);

function fail(message) { throw new Error(message); }

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label + '는 객체여야 합니다');
  return value;
}

function exact(value, keys, label) {
  object(value, label);
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(label + '.' + key + '는 허용되지 않습니다');
  for (const key of keys) if (!Object.prototype.hasOwnProperty.call(value, key)) fail(label + '.' + key + '가 필요합니다');
  return value;
}

function isoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) fail('첫 등원일은 YYYY-MM-DD 형식이어야 합니다');
  const parsed = new Date(value + 'T00:00:00Z');
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('실제 날짜를 입력해 주세요');
  return value;
}

function classroom(value) {
  if (typeof value !== 'string') fail('교실은 문자열이어야 합니다');
  const result = value.trim();
  if (result.length > 80) fail('교실은 80자 이내로 입력해 주세요');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result)) fail('교실에 제어 문자를 사용할 수 없습니다');
  return result;
}

function validatePayload(op, payload) {
  if (op === 'create' || op === 'date') return { firstClassDate: isoDate(exact(payload, ['firstClassDate'], 'payload').firstClassDate) };
  if (op === 'item') {
    const value = exact(payload, ['itemId', 'done'], 'payload');
    if (!ITEMS.has(value.itemId) || typeof value.done !== 'boolean') fail('관리 항목과 완료 상태를 확인해 주세요');
    return { itemId: value.itemId, done: value.done };
  }
  if (op === 'package') {
    const value = exact(payload, ['docId', 'next'], 'payload');
    if (!PACKAGE_ITEMS.has(value.docId) || !PACKAGE_STATES.has(value.next)) fail('첫날 준비 항목과 상태를 확인해 주세요');
    return { docId: value.docId, next: value.next };
  }
  if (op === 'classroom') return { value: classroom(exact(payload, ['value'], 'payload').value) };
  exact(payload, [], 'payload');
  return {};
}

function keyFor(studentId) {
  return '__onboarding__' + encodeURIComponent(studentId) + '|all';
}

function parseRow(row, studentId) {
  if (!row) return null;
  let data;
  try { data = object(JSON.parse(row.data), '저장된 신규 학생 기록'); }
  catch (error) { fail('저장된 신규 학생 기록 형식을 확인해 주세요'); }
  return {
    ...data,
    taskId: '__onboarding__' + encodeURIComponent(studentId),
    date: 'all',
    studentId,
    items: data.items && typeof data.items === 'object' && !Array.isArray(data.items) ? data.items : {},
    updatedAt: Number(row.updated_at) || 0
  };
}

async function currentRoster(env, app) {
  const row = await env.DB.prepare('SELECT data FROM private_rosters WHERE app=? LIMIT 1').bind(app).first();
  if (!row) return null;
  try { return validateRosterDocument(JSON.parse(row.data)); }
  catch (error) { fail('저장된 원생 데이터 형식을 확인해 주세요'); }
}

function kstMonth() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

function validForStudent(student, firstClassDate) {
  const month = firstClassDate.slice(0, 7);
  return (!student.start || student.start <= month) && (!student.end || month < student.end);
}

function conflict(json, origin, current) {
  return json({ ok: false, code: 'ONBOARDING_CONFLICT', error: '다른 기기에서 먼저 수정했습니다', current }, 409, origin);
}

function mergeRecord(current, studentId, op, payload, at, actor) {
  const taskId = '__onboarding__' + encodeURIComponent(studentId);
  const next = current ? { ...current } : { taskId, date: 'all', studentId, firstClassDate: '', items: {} };
  next.taskId = taskId;
  next.date = 'all';
  next.studentId = studentId;
  next.items = { ...(current && current.items || {}) };

  if (op === 'create') {
    next.firstClassDate = payload.firstClassDate;
    next.items = {};
    next.deleted = false;
    next.canceledAt = null;
    next.startedAt = at;
  } else if (op === 'item') {
    next.items[payload.itemId] = payload.done ? at : 0;
  } else if (op === 'package') {
    const itemId = PACKAGE_ITEMS.get(payload.docId);
    next.packagePrepared = { ...(current.packagePrepared || {}) };
    next.packageDeliveries = { ...(current.packageDeliveries || {}) };
    if (payload.next === 'prepared') {
      next.items[itemId] = 0;
      next.packagePrepared[payload.docId] = at;
      next.packageDeliveries[payload.docId] = 0;
    } else if (payload.next === 'delivered') {
      next.items[itemId] = 0;
      if (!next.packagePrepared[payload.docId]) next.packagePrepared[payload.docId] = at;
      next.packageDeliveries[payload.docId] = at;
    } else {
      if (!next.packagePrepared[payload.docId]) next.packagePrepared[payload.docId] = at;
      if (!next.packageDeliveries[payload.docId]) next.packageDeliveries[payload.docId] = at;
      next.items[itemId] = at;
    }
  } else if (op === 'classroom') next.classroom = payload.value;
  else if (op === 'date') next.firstClassDate = payload.firstClassDate;
  else if (op === 'cancel') {
    next.deleted = true;
    next.canceledAt = at;
    next.cancelHistory = (Array.isArray(current.cancelHistory) ? current.cancelHistory : []).slice(-49).concat(at);
  } else if (op === 'restore') {
    next.deleted = false;
    next.restoredAt = at;
  }
  next.updatedAt = at;
  next.updatedBy = actor;
  next.casVersion = 1;
  return next;
}

export async function handleOnboardingPatch(env, app, body, origin, auth, json) {
  if (app !== 'task') return json({ ok: false, error: '이 기능은 직원 앱에서만 사용할 수 있습니다' }, 400, origin);
  if (auth.scope !== 'all') return json({ ok: false, error: '원장·관리 담당만 신규 학생 기록을 수정할 수 있습니다' }, 403, origin);

  const studentId = String(body.studentId || '');
  const op = String(body.op || '');
  const expectedUpdatedAt = Number(body.expectedUpdatedAt);
  if (!SAFE_ID.test(studentId) || !OPS.has(op) || !Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt < 0) {
    return json({ ok: false, error: 'studentId, expectedUpdatedAt, op을 확인해 주세요' }, 400, origin);
  }
  let payload;
  try { payload = validatePayload(op, body.payload); }
  catch (error) { return json({ ok: false, error: String(error && error.message || error) }, 400, origin); }

  let document;
  try { document = await currentRoster(env, app); }
  catch (error) { return json({ ok: false, error: String(error && error.message || error) }, 500, origin); }
  if (!document) return json({ ok: false, error: '원생 데이터가 아직 등록되지 않았습니다' }, 404, origin);
  const student = document.roster.students.find(item => item.id === studentId);
  if (!student) return json({ ok: false, error: '현재 원생 명단에서 학생 ID를 찾을 수 없습니다' }, 404, origin);
  if (student.end && student.end <= kstMonth()) {
    return json({ ok: false, code: 'STUDENT_ENDED', error: '재원이 종료된 학생의 기록은 수정하거나 복원할 수 없습니다' }, 409, origin);
  }
  if ((op === 'create' || op === 'date') && !validForStudent(student, payload.firstClassDate)) {
    return json({ ok: false, error: '첫 등원일은 명단 시작월 이후, 종료월 이전이어야 합니다' }, 400, origin);
  }

  const key = keyFor(studentId);
  const stored = await env.DB.prepare('SELECT data,updated_at FROM checks WHERE app=? AND k=? LIMIT 1').bind(app, key).first();
  const current = stored ? parseRow(stored, studentId) : null;
  if (op === 'create' && current) return conflict(json, origin, current);
  if (op !== 'create' && !current) return json({ ok: false, error: '신규 학생 관리 기록을 찾을 수 없습니다' }, 404, origin);
  if (op !== 'create' && current.deleted && op !== 'restore') {
    return json({ ok: false, code: 'ONBOARDING_CANCELLED', error: '취소된 기록은 먼저 복원해 주세요' }, 409, origin);
  }
  if (op === 'restore' && !current.deleted) {
    return json({ ok: false, code: 'INVALID_STATE', error: '취소된 기록만 복원할 수 있습니다' }, 409, origin);
  }
  if (op === 'restore' && (!ISO_DATE.test(String(current.firstClassDate || '')) ||
      !validForStudent(student, current.firstClassDate))) {
    return json({ ok: false, code: 'FIRST_DATE_OUT_OF_ROSTER',
      error: '기존 첫 등원일이 현재 명단의 재원 기간과 맞지 않아 복원할 수 없습니다' }, 409, origin);
  }
  if (op === 'cancel' && current.deleted) {
    return json({ ok: false, code: 'INVALID_STATE', error: '이미 취소된 기록입니다' }, 409, origin);
  }
  if (current && Number(current.updatedAt) !== expectedUpdatedAt) return conflict(json, origin, current);
  if (!current && expectedUpdatedAt !== 0) return conflict(json, origin, null);

  const at = Math.max(Date.now(), expectedUpdatedAt + 1);
  const actor = auth.id || 'director';
  const next = mergeRecord(current, studentId, op, payload, at, actor);
  let result;
  if (op === 'create') {
    result = await env.DB.prepare(
      'INSERT OR IGNORE INTO checks(app,k,owner,data,updated_at,srv_at) VALUES(?,?,NULL,?,?,?)'
    ).bind(app, key, JSON.stringify(next), at, at).run();
  } else {
    result = await env.DB.prepare(
      'UPDATE checks SET owner=NULL,data=?,updated_at=?,srv_at=? WHERE app=? AND k=? AND updated_at=?'
    ).bind(JSON.stringify(next), at, at, app, key, expectedUpdatedAt).run();
  }
  if (!result || !result.meta || Number(result.meta.changes) !== 1) {
    const latest = await env.DB.prepare('SELECT data,updated_at FROM checks WHERE app=? AND k=? LIMIT 1').bind(app, key).first();
    return conflict(json, origin, latest ? parseRow(latest, studentId) : null);
  }
  return json({ ok: true, record: next }, 200, origin);
}
