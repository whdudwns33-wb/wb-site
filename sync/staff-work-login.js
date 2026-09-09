import { handleStaffAttendance, staffAttendanceDate, staffAttendanceKey } from './staff-attendance.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PIN_RE = /^\d{4}$/;
const TOKEN_RE = /^[a-f0-9]{64}$/;
const PIN_ITERATIONS = 100000;
const LOCK_MS = 5 * 60 * 1000;
const MANAGER_INSPECTION_TTL_MS = 8 * 60 * 60 * 1000;
const textEncoder = new TextEncoder();

export function staffWorkLoginEnabled(env) {
  return String(env.WB_STAFF_WORK_LOGIN_ENABLED || '').toLowerCase() === 'true';
}

function hex(bytes) { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
function randomHex(size = 32) { return hex(crypto.getRandomValues(new Uint8Array(size))); }
async function hash(value) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', textEncoder.encode(value)))); }
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let delta = 0;
  for (let i = 0; i < a.length; i++) delta |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return delta === 0;
}

/** 운영 seed와 관리자 PIN 재설정은 같은 함수를 사용한다. 원문 PIN과 pepper는 저장/출력하지 않는다. */
export async function deriveStaffPinHash(pin, saltHex, pepper, iterations = PIN_ITERATIONS) {
  if (!PIN_RE.test(String(pin)) || !/^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(saltHex) ||
      typeof pepper !== 'string' || pepper.length < 32 || iterations !== PIN_ITERATIONS) {
    throw new Error('STAFF_PIN_CONFIGURATION_INVALID');
  }
  const key = await crypto.subtle.importKey('raw', textEncoder.encode(String(pin) + ':' + pepper),
    'PBKDF2', false, ['deriveBits']);
  return hex(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256',
    salt: new Uint8Array(saltHex.match(/../g).map(b => parseInt(b, 16))), iterations }, key, 256)));
}

function fail(json, origin, code, error, status = 409, extra = {}) {
  return json({ ok: false, code, error, ...extra }, status, origin);
}
function unavailable(json, origin) {
  return fail(json, origin, 'STAFF_WORK_UNAVAILABLE', '출퇴근 로그인 연결을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요', 503);
}
function parsed(row) { try { return JSON.parse(row.data); } catch { return null; } }
function role(auth) { return auth.scope === 'all' ? (auth.id ? 'manager' : 'admin') : 'teacher'; }
function isRequired(env, auth, profile) {
  return staffWorkLoginEnabled(env) && auth.scope === 'own' && profile && Number(profile.login_enabled) === 1;
}
function configured(profile) { return !!profile && /^[a-f0-9]{64}$/.test(profile.pin_hash) && /^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(profile.pin_salt); }
async function readProfile(env, staffId) {
  return env.DB.prepare('SELECT * FROM staff_private_profiles WHERE app=? AND staff_id=? LIMIT 1').bind('task', staffId).first();
}
async function readGeneration(env) {
  const row = await env.DB.prepare('SELECT generation FROM app_data_generations WHERE app=? LIMIT 1').bind('task').first();
  if (!row || !Number.isSafeInteger(Number(row.generation)) || Number(row.generation) < 0) throw new Error('STAFF_WORK_GENERATION_UNAVAILABLE');
  return Number(row.generation);
}

/** 선생님 링크에서 발급한 관리자 점검 세션을 해석한다. 원문 토큰은 D1에 저장하지 않는다. */
export async function resolveManagerInspectionAuth(env, app, auth, managerIds) {
  if (app !== 'task' || !auth || auth.mode !== 'manager_inspection') return null;
  const token = String(auth.token || ''), managerId = String(auth.managerId || '');
  if (!TOKEN_RE.test(token) || !SAFE_ID.test(managerId) || !managerIds.has(managerId)) return null;
  const tokenHash = await hash(token);
  const row = await env.DB.prepare(
    'SELECT manager_staff_id,source_staff_id,device_hash,expires_at FROM manager_inspection_sessions ' +
    'WHERE app=? AND token_hash=? AND manager_staff_id=? AND revoked=0 AND expires_at>? LIMIT 1'
  ).bind('task', tokenHash, managerId, Date.now()).first();
  if (!row) return null;
  const staff = await env.DB.prepare('SELECT data FROM staff WHERE app=? AND id=? LIMIT 1')
    .bind('task', managerId).first();
  if (!staff) return null;
  let data;
  try { data = JSON.parse(staff.data); } catch (_) { return null; }
  if (!data || data.deleted) return null;
  return { scope: 'all', id: managerId, role: 'manager', inspection: true,
    sourceStaffId: String(row.source_staff_id || ''), expiresAt: Number(row.expires_at) || 0 };
}

/** 개인 링크의 bearer와 관리 담당자 PIN을 함께 확인해 8시간짜리 점검 세션을 만든다. */
export async function handleManagerInspectionSession(env, app, body, origin, auth, json, managerIds) {
  if (app !== 'task') return fail(json, origin, 'MANAGER_INSPECTION_APP_REQUIRED', '업무지시서에서만 사용할 수 있습니다', 400);
  const action = String(body.action || '');
  if (!['login', 'logout'].includes(action)) return fail(json, origin, 'MANAGER_INSPECTION_ACTION_INVALID', '요청 종류를 확인해 주세요', 400);
  try {
    if (action === 'logout') {
      if (!auth || !auth.inspection || auth.scope !== 'all') return fail(json, origin, 'MANAGER_INSPECTION_REQUIRED', '관리자 점검 세션이 필요합니다', 401);
      const token = String(body.auth && body.auth.token || '');
      if (!TOKEN_RE.test(token)) return fail(json, origin, 'MANAGER_INSPECTION_REQUIRED', '관리자 점검 세션이 필요합니다', 401);
      await env.DB.prepare('UPDATE manager_inspection_sessions SET revoked=1 WHERE app=? AND token_hash=?')
        .bind('task', await hash(token)).run();
      return json({ ok: true, active: false }, 200, origin);
    }
    if (!auth || auth.scope !== 'own') return fail(json, origin, 'MANAGER_INSPECTION_SOURCE_REQUIRED', '선생님 개인 링크에서만 관리자 로그인을 시작할 수 있습니다', 403);
    const pin = String(body.pin || '');
    if (!PIN_RE.test(pin)) return fail(json, origin, 'MANAGER_INSPECTION_PIN_INVALID', '관리자 비밀번호 숫자 4자리를 입력해 주세요', 400);
    if (typeof env.WB_STAFF_PIN_PEPPER !== 'string' || env.WB_STAFF_PIN_PEPPER.length < 32) return unavailable(json, origin);
    const sourceToken = String(body.auth && body.auth.token || '');
    if (!sourceToken || sourceToken.length > 256) return fail(json, origin, 'MANAGER_INSPECTION_SOURCE_REQUIRED', '선생님 개인 인증을 다시 확인해 주세요', 401);
    const deviceHash = await hash(sourceToken);
    const now = Date.now();
    await env.DB.prepare('INSERT OR IGNORE INTO manager_inspection_attempts(app,device_hash,updated_at) VALUES(?,?,?)')
      .bind('task', deviceHash, now).run();
    const attempt = await env.DB.prepare('UPDATE manager_inspection_attempts SET ' +
      'failed_attempts=CASE WHEN locked_until>0 AND locked_until<=? THEN 1 ELSE failed_attempts+1 END,' +
      'locked_until=CASE WHEN locked_until>0 AND locked_until<=? THEN 0 WHEN failed_attempts+1>=5 THEN ? ELSE 0 END,' +
      'attempt_revision=attempt_revision+1,updated_at=? WHERE app=? AND device_hash=? AND locked_until<=? ' +
      'AND (failed_attempts<5 OR locked_until>0) RETURNING failed_attempts,locked_until,attempt_revision')
      .bind(now, now, now + LOCK_MS, now, 'task', deviceHash, now).first();
    if (!attempt) return fail(json, origin, 'MANAGER_INSPECTION_PIN_LOCKED', '관리자 비밀번호 입력을 여러 번 시도했습니다. 5분 후 다시 시도해 주세요', 429);

    const ids = [...managerIds].filter(id => SAFE_ID.test(id));
    if (!ids.length) return unavailable(json, origin);
    const placeholders = ids.map(() => '?').join(',');
    const profiles = await env.DB.prepare(
      'SELECT staff_id,phone,pin_salt,pin_hash,pin_iterations FROM staff_private_profiles ' +
      'WHERE app=? AND login_enabled=1 AND staff_id IN (' + placeholders + ')'
    ).bind('task', ...ids).all();
    let matched = null;
    for (const profile of (profiles.results || [])) {
      if (!configured(profile)) continue;
      const candidate = await deriveStaffPinHash(pin, profile.pin_salt, env.WB_STAFF_PIN_PEPPER, Number(profile.pin_iterations));
      if (safeEqual(candidate, profile.pin_hash)) { matched = profile; break; }
    }
    if (!matched) return fail(json, origin,
      Number(attempt.failed_attempts) >= 5 ? 'MANAGER_INSPECTION_PIN_LOCKED' : 'MANAGER_INSPECTION_PIN_INCORRECT',
      Number(attempt.failed_attempts) >= 5 ? '관리자 비밀번호가 일치하지 않습니다. 5분 후 다시 시도해 주세요' : '관리자 비밀번호가 일치하지 않습니다',
      Number(attempt.failed_attempts) >= 5 ? 429 : 400);
    await env.DB.prepare('UPDATE manager_inspection_attempts SET failed_attempts=0,locked_until=0,updated_at=? ' +
      'WHERE app=? AND device_hash=? AND attempt_revision=?')
      .bind(now, 'task', deviceHash, attempt.attempt_revision).run();
    const managerId = String(matched.staff_id);
    const staff = await env.DB.prepare('SELECT data FROM staff WHERE app=? AND id=? LIMIT 1').bind('task', managerId).first();
    let staffData = null;
    try { staffData = staff && JSON.parse(staff.data); } catch (_) { /* 아래에서 미설정으로 처리한다 */ }
    if (!staffData || staffData.deleted) return unavailable(json, origin);
    const token = randomHex();
    const expiresAt = now + MANAGER_INSPECTION_TTL_MS;
    await env.DB.prepare('UPDATE manager_inspection_sessions SET revoked=1 WHERE app=? AND device_hash=? AND revoked=0')
      .bind('task', deviceHash).run();
    await env.DB.prepare('INSERT INTO manager_inspection_sessions(app,token_hash,manager_staff_id,source_staff_id,device_hash,created_at,expires_at,revoked) VALUES(?,?,?,?,?,?,?,0)')
      .bind('task', await hash(token), managerId, auth.id, deviceHash, now, expiresAt).run();
    return json({ ok: true, active: true, managerSession: token, managerId,
      managerName: String(staffData.name || ''), expiresAt }, 200, origin);
  } catch (error) {
    if (/no such table.*manager_inspection/i.test(String(error && error.message || error))) return unavailable(json, origin);
    return unavailable(json, origin);
  }
}
async function readAttendance(env, staffId, date) {
  const key = staffAttendanceKey(staffId, date);
  const row = await env.DB.prepare('SELECT owner,data,updated_at,srv_at FROM checks WHERE app=? AND k=? LIMIT 1').bind('task', key).first();
  if (!row) return null;
  if (row.owner !== staffId) throw new Error('STAFF_WORK_ATTENDANCE_OWNER_MISMATCH');
  const record = parsed(row);
  if (!record) throw new Error('STAFF_WORK_ATTENDANCE_INVALID');
  return { key, owner: staffId, record, updatedAt: Number(row.updated_at) };
}
function clockedOut(attendance) { return !!(attendance && attendance.record.done && Number(attendance.record.out) > 0); }
async function sessionRow(env, body, auth, profile, now, includeRevoked = false) {
  const raw = String(body.auth && body.auth.workSession || '');
  if (!TOKEN_RE.test(raw)) return null;
  const device = String(body.auth && body.auth.token || '');
  if (!device) return null;
  const generation = await readGeneration(env);
  return env.DB.prepare('SELECT * FROM staff_work_sessions WHERE app=? AND token_hash=? AND staff_id=? ' +
    'AND device_hash=? AND work_date=? AND credential_revision=? AND data_generation=? AND expires_at>?' +
    (includeRevoked ? '' : ' AND revoked=0') + ' LIMIT 1')
    .bind('task', await hash(raw), auth.id, await hash(device), staffAttendanceDate(now),
      profile.credential_revision, generation, now).first();
}

/** 모든 업무 데이터 경로 앞에서 검사한다. 만료된 근무 세션은 기존 기기 인증을 해제하지 않는다. */
export async function guardStaffWorkAccess(env, body, auth, pathname, origin, json) {
  if (!staffWorkLoginEnabled(env) || String(body.app || '') !== 'task' || auth.scope !== 'own') return null;
  if (pathname === '/staff-work-session' || pathname === '/staff-profile') return null;
  try {
    const profile = await readProfile(env, auth.id);
    if (!isRequired(env, auth, profile)) return null;
    if (pathname === '/staff-attendance') return fail(json, origin, 'STAFF_WORK_LOGIN_REQUIRED',
      '출퇴근은 출근하고 로그인 / 퇴근하고 로그아웃 버튼으로 기록해 주세요');
    const now = Date.now();
    const session = await sessionRow(env, body, auth, profile, now);
    const attendance = session && await readAttendance(env, auth.id, staffAttendanceDate(now));
    if (!session || !attendance || !attendance.record.done || clockedOut(attendance)) {
      return fail(json, origin, 'STAFF_WORK_LOGIN_REQUIRED', '개인 비밀번호로 출근 로그인을 해 주세요');
    }
    return null;
  } catch { return unavailable(json, origin); }
}

export async function handleStaffWorkSession(env, app, body, origin, auth, json) {
  if (app !== 'task') return fail(json, origin, 'STAFF_WORK_APP_REQUIRED', '업무지시서에서만 사용할 수 있습니다', 400);
  if (!['status', 'login', 'logout'].includes(body.action)) return fail(json, origin, 'STAFF_WORK_ACTION_INVALID', '요청 종류를 확인해 주세요', 400);
  try {
    const now = Date.now();
    const date = staffAttendanceDate(now);
    const staff = auth.id && await env.DB.prepare('SELECT data FROM staff WHERE app=? AND id=? LIMIT 1').bind('task', auth.id).first();
    const staffData = staff ? parsed(staff) : null;
    const base = { ok: true, required: false, authRole: role(auth), staffId: auth.id || '',
      staffName: String(staffData && staffData.name || ''), configured: false, active: false, workDate: date, clockedOut: false };
    if (auth.scope === 'all' || !staffWorkLoginEnabled(env)) return json(base, 200, origin);
    const profile = await readProfile(env, auth.id);
    base.configured = configured(profile);
    base.required = !!isRequired(env, auth, profile);
    if (!base.required) return json(base, 200, origin);
    base.attendance = await readAttendance(env, auth.id, date);
    base.clockedOut = clockedOut(base.attendance);
    const session = await sessionRow(env, body, auth, profile, now);
    base.active = !!session && !!base.attendance && !!base.attendance.record.done && !base.clockedOut;
    if (base.active) base.expiresAt = Number(session.expires_at);
    if (body.action === 'status') return json(base, 200, origin);

    if (body.action === 'logout') {
      // 서버 응답이 유실된 재요청도 같은 퇴근 시각을 돌려준다. 기기 bearer만으로 퇴근을 만들지는 않는다.
      if (!session && !(base.clockedOut && await sessionRow(env, body, auth, profile, now, true))) {
        return fail(json, origin, 'STAFF_WORK_LOGIN_REQUIRED', '출근 로그인 상태를 확인해 주세요');
      }
      const response = await handleStaffAttendance(env, app, { action: 'clock_out' }, origin, auth, json);
      if (!response.ok) return response;
      const attendance = await response.json();
      await env.DB.prepare('UPDATE staff_work_sessions SET revoked=1 WHERE app=? AND staff_id=? AND work_date=?')
        .bind('task', auth.id, date).run();
      return json({ ...base, active: false, clockedOut: true, attendance, workSession: '' }, 200, origin);
    }

    if (base.clockedOut) return fail(json, origin, 'STAFF_WORK_ALREADY_CLOCKED_OUT',
      '오늘 퇴근이 이미 기록되었습니다. 관리자에게 기록 확인을 요청해 주세요');
    if (!base.configured) return fail(json, origin, 'STAFF_WORK_PIN_NOT_CONFIGURED', '개인 비밀번호가 등록되지 않았습니다. 관리자에게 문의해 주세요');
    if (typeof env.WB_STAFF_PIN_PEPPER !== 'string' || env.WB_STAFF_PIN_PEPPER.length < 32) return unavailable(json, origin);
    if (!PIN_RE.test(String(body.pin || ''))) return fail(json, origin, 'STAFF_WORK_PIN_INVALID', '개인 비밀번호 숫자 4자리를 입력해 주세요', 400);

    // 검증 전 시도권을 원자적으로 예약한다. 여러 기기에서 동시에 추측해도 5회를 넘겨 검증할 수 없다.
    const attempt = await env.DB.prepare('UPDATE staff_private_profiles SET ' +
      'failed_attempts=CASE WHEN locked_until>0 AND locked_until<=? THEN 1 ELSE failed_attempts+1 END,' +
      'locked_until=CASE WHEN locked_until>0 AND locked_until<=? THEN 0 WHEN failed_attempts+1>=5 THEN ? ELSE 0 END,' +
      'attempt_revision=attempt_revision+1 WHERE app=? AND staff_id=? AND credential_revision=? AND login_enabled=1 ' +
      'AND locked_until<=? AND (failed_attempts<5 OR locked_until>0) ' +
      'RETURNING failed_attempts,locked_until,attempt_revision')
      .bind(now, now, now + LOCK_MS, 'task', auth.id, profile.credential_revision, now).first();
    if (!attempt) return fail(json, origin, 'STAFF_WORK_PIN_LOCKED', '비밀번호 입력을 여러 번 시도했습니다. 5분 후 다시 시도해 주세요', 429);
    const candidate = await deriveStaffPinHash(String(body.pin), profile.pin_salt, env.WB_STAFF_PIN_PEPPER, Number(profile.pin_iterations));
    if (!safeEqual(candidate, profile.pin_hash)) return fail(json, origin,
      Number(attempt.failed_attempts) >= 5 ? 'STAFF_WORK_PIN_LOCKED' : 'STAFF_WORK_PIN_INCORRECT',
      Number(attempt.failed_attempts) >= 5 ? '비밀번호가 일치하지 않습니다. 5분 후 다시 시도해 주세요' : '비밀번호가 일치하지 않습니다',
      Number(attempt.failed_attempts) >= 5 ? 429 : 400);
    await env.DB.prepare('UPDATE staff_private_profiles SET failed_attempts=0,locked_until=0 ' +
      'WHERE app=? AND staff_id=? AND credential_revision=? AND attempt_revision=? AND login_enabled=1')
      .bind('task', auth.id, profile.credential_revision, attempt.attempt_revision).run();
    const latestProfile = await readProfile(env, auth.id);
    if (!latestProfile || latestProfile.credential_revision !== profile.credential_revision || !latestProfile.login_enabled) {
      return fail(json, origin, 'STAFF_WORK_LOGIN_REQUIRED', '비밀번호 설정이 변경되었습니다. 다시 로그인해 주세요');
    }
    const generation = await readGeneration(env);
    const response = await handleStaffAttendance(env, app, { action: 'clock_in' }, origin, auth, json);
    if (!response.ok) return response;
    const attendance = await response.json();
    if (clockedOut(attendance)) return fail(json, origin, 'STAFF_WORK_ALREADY_CLOCKED_OUT', '오늘 퇴근이 이미 기록되었습니다');
    const token = randomHex();
    const expiresAt = Date.parse(date + 'T00:00:00+09:00') + 24 * 60 * 60 * 1000;
    if (Date.now() >= expiresAt) return fail(json, origin, 'STAFF_WORK_LOGIN_REQUIRED', '날짜가 변경되었습니다. 다시 로그인해 주세요');
    const inserted = await env.DB.prepare('INSERT INTO staff_work_sessions ' +
      '(app,token_hash,staff_id,device_hash,work_date,credential_revision,data_generation,created_at,expires_at,revoked) ' +
      'SELECT ?,?,?,?,?,?,?,?,?,0 WHERE EXISTS (SELECT 1 FROM staff_private_profiles WHERE app=? AND staff_id=? AND credential_revision=? AND login_enabled=1) ' +
      "AND EXISTS (SELECT 1 FROM checks WHERE app=? AND k=? AND owner=? AND json_extract(data,'$.done')=1 AND COALESCE(json_extract(data,'$.out'),0)=0) " +
      'AND EXISTS (SELECT 1 FROM app_data_generations WHERE app=? AND generation=?)')
      .bind('task', await hash(token), auth.id, await hash(String(body.auth.token)), date, profile.credential_revision,
        generation, now, expiresAt, 'task', auth.id, profile.credential_revision, 'task', attendance.key, auth.id, 'task', generation).run();
    if (!Number(inserted.meta && inserted.meta.changes)) return fail(json, origin, 'STAFF_WORK_LOGIN_REQUIRED', '출퇴근 상태가 변경되었습니다. 다시 확인해 주세요');
    return json({ ...base, active: true, attendance, clockedOut: false, workSession: token, expiresAt }, 200, origin);
  } catch { return unavailable(json, origin); }
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/[\s()-]/g, '');
  if (!digits) return '';
  if (!/^01[016789]\d{7,8}$/.test(digits)) return null;
  return digits.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3');
}

export async function handleStaffProfile(env, app, body, origin, auth, json) {
  if (app !== 'task' || auth.scope !== 'all') return fail(json, origin, 'STAFF_PROFILE_ADMIN_REQUIRED', '관리자만 직원 연락처와 비밀번호를 관리할 수 있습니다', 403);
  try {
    if (body.action === 'list') {
      const rows = await env.DB.prepare('SELECT s.id,s.data,p.phone,p.login_enabled,p.pin_hash,p.pin_salt,p.credential_revision ' +
        'FROM staff s LEFT JOIN staff_private_profiles p ON p.app=s.app AND p.staff_id=s.id WHERE s.app=?').bind('task').all();
      const profiles = (rows.results || []).filter(r => { const d = parsed(r); return d && !d.deleted; }).map(r => ({
        staffId: r.id, staffName: String(parsed(r).name || ''), phone: r.phone || '', loginEnabled: Number(r.login_enabled) === 1,
        configured: configured(r), revision: Number(r.credential_revision || 0)
      }));
      return json({ ok: true, profiles }, 200, origin);
    }
    if (!['update', 'reset_pin'].includes(body.action) || !SAFE_ID.test(String(body.staffId || ''))) {
      return fail(json, origin, 'STAFF_PROFILE_INVALID', '직원과 요청 종류를 확인해 주세요', 400);
    }
    const staffId = String(body.staffId);
    const staff = await env.DB.prepare('SELECT data FROM staff WHERE app=? AND id=? LIMIT 1').bind('task', staffId).first();
    if (!staff || !parsed(staff) || parsed(staff).deleted) return fail(json, origin, 'STAFF_PROFILE_NOT_FOUND', '현재 직원 정보를 찾을 수 없습니다', 404);
    const current = await readProfile(env, staffId);
    const revision = Number(current && current.credential_revision || 0);
    if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision !== revision) {
      return fail(json, origin, 'STAFF_PROFILE_CONFLICT', '다른 화면에서 직원 정보가 변경되었습니다. 다시 열어 주세요');
    }
    let phone = current && current.phone || '';
    let enabled = Number(current && current.login_enabled || 0);
    let salt = current && current.pin_salt || '';
    let pinHash = current && current.pin_hash || '';
    if (body.action === 'update') {
      phone = normalizePhone(body.phone);
      if (phone === null) return fail(json, origin, 'STAFF_PROFILE_PHONE_INVALID', '올바른 휴대폰 번호를 입력해 주세요', 400);
      if (body.loginEnabled !== undefined) {
        if (typeof body.loginEnabled !== 'boolean') return fail(json, origin, 'STAFF_PROFILE_INVALID', '로그인 설정을 확인해 주세요', 400);
        enabled = body.loginEnabled ? 1 : 0;
      }
    } else {
      if (!PIN_RE.test(String(body.pin || ''))) return fail(json, origin, 'STAFF_PROFILE_PIN_INVALID', '새 비밀번호는 숫자 4자리로 입력해 주세요', 400);
      salt = randomHex(16);
      pinHash = await deriveStaffPinHash(String(body.pin), salt, env.WB_STAFF_PIN_PEPPER);
    }
    const now = Date.now();
    const result = await env.DB.prepare('INSERT INTO staff_private_profiles ' +
      '(app,staff_id,phone,login_enabled,pin_salt,pin_hash,pin_iterations,credential_revision,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ' +
      'ON CONFLICT(app,staff_id) DO UPDATE SET phone=excluded.phone,login_enabled=excluded.login_enabled,pin_salt=excluded.pin_salt,' +
      'pin_hash=excluded.pin_hash,pin_iterations=excluded.pin_iterations,credential_revision=excluded.credential_revision,' +
      'failed_attempts=0,locked_until=0,attempt_revision=staff_private_profiles.attempt_revision+1,updated_at=excluded.updated_at ' +
      'WHERE staff_private_profiles.credential_revision=?')
      .bind('task', staffId, phone, enabled, salt, pinHash, PIN_ITERATIONS, revision + 1, now, revision).run();
    if (!Number(result.meta && result.meta.changes)) return fail(json, origin, 'STAFF_PROFILE_CONFLICT', '다른 화면에서 직원 정보가 변경되었습니다. 다시 열어 주세요');
    return json({ ok: true, staffId, phone, loginEnabled: !!enabled, configured: !!pinHash, revision: revision + 1 }, 200, origin);
  } catch { return unavailable(json, origin); }
}
