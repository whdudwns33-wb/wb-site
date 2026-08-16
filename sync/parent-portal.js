/**
 * 보호자 웹앱 — 직원 앱과 분리된 한 학생 읽기 전용 세션.
 * 전화번호는 초대 자격 확인에만 쓰고 응답/세션/화면에는 절대 포함하지 않는다.
 */

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_OPAQUE = /^[a-f0-9]{48}$/i;
const HASH_PREFIX = 'sha256:';
const CODE_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_ACTIVE_SESSIONS = 3;
const CURRENT_PORTAL_SCOPE_VERSION = 2;
const DAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];
const LESSON_STEP_LABELS = [
  '지난 숙제·온라인 수행 확인',
  '교재와 오늘 진도 진행',
  '이해도·오답·학생 반응 확인',
  '다음 숙제 안내',
  '실제 진도와 특이사항 기록'
];
const SESSION_COOKIE = '__Host-wb_parent_session';

function text(value) {
  return String(value == null ? '' : value).normalize('NFKC').trim();
}

function identity(value) {
  return text(value).replace(/\s+/g, '').toLocaleLowerCase('ko-KR');
}

function changes(result) {
  return Number(result && result.meta && result.meta.changes || 0);
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function randomOpaque() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function storedHash(value) {
  return HASH_PREFIX + await sha256Hex(value);
}

function kstMonth(now) {
  return new Date(Number(now) + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

function activeInMonth(student, month) {
  return student && SAFE_ID.test(String(student.id || '')) &&
    (!student.start || String(student.start) <= month) &&
    (!student.end || String(student.end) > month);
}

async function rosterStudent(env, studentId, now) {
  const row = await env.DB.prepare('SELECT data FROM private_rosters WHERE app=? LIMIT 1').bind('task').first();
  if (!row) return { error: '원생 명단이 준비되지 않았습니다', code: 'ROSTER_UNAVAILABLE' };
  try {
    const document = JSON.parse(row.data || '{}');
    const students = document && document.roster && document.roster.students;
    const student = Array.isArray(students) ? students.find(item => item && item.id === studentId) : null;
    if (!student || !activeInMonth(student, kstMonth(now))) {
      return { error: '현재 이용할 수 없는 학생입니다', code: 'STUDENT_INACTIVE' };
    }
    return { student };
  } catch (error) {
    return { error: '원생 명단을 확인해 주세요', code: 'ROSTER_INVALID' };
  }
}

async function guardianIdentityReady(env, student) {
  const row = await env.DB.prepare(
    'SELECT student_name,phone,consent FROM guardian_contacts_by_student WHERE app=? AND student_id=? LIMIT 1'
  ).bind('task', student.id).first();
  if (!row || !/^010\d{8}$/.test(String(row.phone || ''))) {
    return { error: '보호자 연락처를 먼저 확인해 주세요', code: 'GUARDIAN_NOT_READY' };
  }
  if (identity(row.student_name) !== identity(student.name)) {
    return { error: '보호자 정보와 현재 원생 명단이 일치하지 않습니다', code: 'GUARDIAN_IDENTITY_MISMATCH' };
  }
  return {
    ok: true,
    identityHash: await sha256Hex([
      String(student.id || ''), identity(student.name), String(row.phone || '')
    ].join('\u001f'))
  };
}

async function revokePortalCredentials(env, studentId) {
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE guardian_portal_codes SET revoked=1 WHERE app=? AND student_id=? AND revoked=0'
    ).bind('task', studentId),
    env.DB.prepare(
      'UPDATE guardian_portal_sessions SET revoked=1 WHERE app=? AND student_id=? AND revoked=0'
    ).bind('task', studentId)
  ]);
}

async function portalAccessReady(env, studentId, currentGuardianIdentityHash, requiredScopeVersion = 1) {
  const row = await env.DB.prepare(
    'SELECT enabled,guardian_identity_hash,scope_version,updated_at FROM guardian_portal_access ' +
    'WHERE app=? AND student_id=? LIMIT 1'
  ).bind('task', studentId).first();
  if (!row || Number(row.enabled) !== 1) {
    return { error: '보호자 웹앱 이용 동의를 먼저 확인해 주세요', code: 'PORTAL_CONSENT_MISSING' };
  }
  if (!currentGuardianIdentityHash ||
      String(row.guardian_identity_hash || '') !== String(currentGuardianIdentityHash)) {
    await revokePortalCredentials(env, studentId);
    return {
      error: '보호자 연락처가 변경되어 웹앱 이용 동의를 다시 받아야 합니다',
      code: 'PORTAL_RECONSENT_REQUIRED', needsReconsent: true, updatedAt: Number(row.updated_at)
    };
  }
  const scopeVersion = Number(row.scope_version || 1);
  if (scopeVersion < Number(requiredScopeVersion || 1)) {
    return {
      error: '보호자 앱의 새 공개 범위 동의를 다시 확인해 주세요',
      code: 'PORTAL_CONSENT_VERSION_REQUIRED', needsScopeReconsent: true,
      updatedAt: Number(row.updated_at), scopeVersion
    };
  }
  return { ok: true, updatedAt: Number(row.updated_at), scopeVersion };
}

function cookieToken(request) {
  const source = String(request && request.headers.get('Cookie') || '');
  for (const part of source.split(';')) {
    const equal = part.indexOf('=');
    if (equal < 0 || part.slice(0, equal).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(equal + 1).trim();
    return SAFE_OPAQUE.test(value) ? value : '';
  }
  return '';
}

function responseWithCookie(payload, status, origin, cookie) {
  const headers = new Headers({
    'Content-Type': 'application/json;charset=utf-8',
    'Access-Control-Allow-Origin': origin || 'null',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  headers.set('Set-Cookie', cookie);
  return new Response(JSON.stringify(payload), { status: status || 200, headers });
}

function sessionCookie(token) {
  return SESSION_COOKIE + '=' + token + '; Path=/; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000) +
    '; HttpOnly; Secure; SameSite=Strict';
}

function clearSessionCookie() {
  return SESSION_COOKIE + '=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict';
}

function allowedKeys(body, allowed) {
  const base = new Set(['app', 'action'].concat(allowed));
  return Object.keys(body || {}).every(key => base.has(key));
}

/**
 * 보호자 앱에서 한 번만 교환할 24시간 코드를 발급한다.
 * 발송 로직도 직원 초대 API와 동일한 guardian identity/access revision 검증을 사용한다.
 * 반환된 code는 실제 발송 payload 또는 직원에게 즉시 전달하는 경우에만 사용해야 한다.
 */
export async function issueGuardianPortalInvite(env, options = {}) {
  const studentId = String(options.studentId || '');
  if (!SAFE_ID.test(studentId)) {
    return { ok: false, status: 400, errorCode: 'STUDENT_INVALID', error: '학생을 확인해 주세요' };
  }
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const found = await rosterStudent(env, studentId, now);
  if (found.error) return { ok: false, status: 409, errorCode: found.code, error: found.error };
  const guardian = await guardianIdentityReady(env, found.student);
  if (guardian.error) return { ok: false, status: 409, errorCode: guardian.code, error: guardian.error };
  const requiredScopeVersion = Number(options.requiredScopeVersion || CURRENT_PORTAL_SCOPE_VERSION);
  const access = await portalAccessReady(env, studentId, guardian.identityHash, requiredScopeVersion);
  if (access.error) return { ok: false, status: 409, errorCode: access.code, error: access.error };

  const code = randomOpaque();
  const codeHash = await storedHash(code);
  const expiresAt = now + CODE_TTL_MS;
  const issuedBy = SAFE_ID.test(String(options.issuedBy || '')) ? String(options.issuedBy) : 'director';
  const result = await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO guardian_portal_codes(app,code_hash,student_id,guardian_identity_hash,access_updated_at,' +
      'created_at,expires_at,consumed_at,revoked,issued_by,claim_id) ' +
      'SELECT ?,?,?,?,?,?,?,NULL,0,?,NULL FROM guardian_portal_access access ' +
      'WHERE access.app=? AND access.student_id=? AND access.enabled=1 AND access.updated_at=? ' +
      'AND access.guardian_identity_hash=? AND access.scope_version>=?'
    ).bind('task', codeHash, studentId, guardian.identityHash, access.updatedAt, now, expiresAt, issuedBy,
      'task', studentId, access.updatedAt, guardian.identityHash, requiredScopeVersion),
    env.DB.prepare(
      'UPDATE guardian_portal_codes SET revoked=1 WHERE app=? AND student_id=? AND code_hash<>? ' +
      'AND consumed_at IS NULL AND revoked=0 AND EXISTS (' +
      'SELECT 1 FROM guardian_portal_codes fresh WHERE fresh.app=? AND fresh.code_hash=?)'
    ).bind('task', studentId, codeHash, 'task', codeHash)
  ]);
  if (changes(result[0]) !== 1) {
    return { ok: false, status: 409, errorCode: 'PORTAL_CONSENT_CHANGED',
      error: '보호자 웹앱 이용 동의가 변경되었습니다. 새로고침 후 다시 발급해 주세요' };
  }
  return { ok: true, code, expiresAt };
}

async function issueInvite(env, body, auth, origin, json) {
  if (!auth || auth.scope !== 'all') return json({ ok: false, error: '원장·관리 담당만 발급할 수 있습니다' }, 403, origin);
  if (!allowedKeys(body, ['auth', 'studentId'])) return json({ ok: false, error: '허용되지 않은 입력이 있습니다' }, 400, origin);
  const result = await issueGuardianPortalInvite(env, {
    studentId: body.studentId,
    issuedBy: auth.role === 'manager' && SAFE_ID.test(String(auth.id || '')) ? auth.id : 'director'
  });
  if (!result.ok) {
    return json({ ok: false, code: result.errorCode, error: result.error }, result.status, origin);
  }
  return json({ ok: true, code: result.code, expiresAt: result.expiresAt }, 200, origin);
}

async function exchangeInvite(env, body, origin, json, request) {
  if (!allowedKeys(body, ['code'])) return json({ ok: false, error: '허용되지 않은 입력이 있습니다' }, 400, origin);
  const code = String(body.code || '');
  if (!SAFE_OPAQUE.test(code)) {
    return json({ ok: false, code: 'LINK_INVALID', error: '올바른 보호자 초대 링크가 필요합니다' }, 400, origin);
  }
  const now = Date.now();
  const codeHash = await storedHash(code);
  const codeRow = await env.DB.prepare(
    'SELECT student_id,guardian_identity_hash,access_updated_at,consumed_at,expires_at,revoked,claim_id ' +
    'FROM guardian_portal_codes WHERE app=? AND code_hash=? LIMIT 1'
  ).bind('task', codeHash).first();
  if (!codeRow) return json({ ok: false, code: 'LINK_INVALID', error: '올바르지 않은 보호자 초대 링크입니다' }, 410, origin);
  const studentId = String(codeRow.student_id || '');
  const found = await rosterStudent(env, studentId, now);
  if (found.error) {
    await env.DB.prepare('UPDATE guardian_portal_codes SET revoked=1 WHERE app=? AND code_hash=?').bind('task', codeHash).run();
    return json({ ok: false, code: 'LINK_INVALID', error: '사용할 수 없는 보호자 초대 링크입니다' }, 410, origin);
  }
  const guardian = await guardianIdentityReady(env, found.student);
  if (guardian.error || guardian.identityHash !== String(codeRow.guardian_identity_hash || '')) {
    await revokePortalCredentials(env, studentId);
    return json({ ok: false, code: 'LINK_INVALID', error: '보호자 이용 준비 상태를 확인해 주세요' }, 410, origin);
  }
  const access = await portalAccessReady(env, studentId, guardian.identityHash, 1);
  if (access.error || access.updatedAt !== Number(codeRow.access_updated_at)) {
    await env.DB.prepare('UPDATE guardian_portal_codes SET revoked=1 WHERE app=? AND code_hash=?').bind('task', codeHash).run();
    return json({ ok: false, code: 'LINK_INVALID', error: '보호자 이용 동의를 확인해 주세요' }, 410, origin);
  }

  // 이미 같은 학생의 유효한 HttpOnly 세션이 있는 브라우저에서 새 CTA를 누르면
  // code만 한 번 사용 처리하고 기존 세션을 유지한다. 반복 링크가 3개 활성 세션 한도를
  // 밀어내 설치된 Chrome 세션을 끊는 것을 막는다.
  const existingToken = cookieToken(request);
  if (existingToken) {
    const existingSession = await portalSession(env, existingToken, now);
    if (existingSession && existingSession.student.id === studentId) {
      const reuseClaimId = randomOpaque();
      const consumed = await env.DB.prepare(
        'UPDATE guardian_portal_codes SET claim_id=?,consumed_at=? WHERE app=? AND code_hash=? ' +
        'AND claim_id IS NULL AND consumed_at IS NULL AND revoked=0 AND expires_at>=? ' +
        'AND guardian_identity_hash=? AND access_updated_at=? AND EXISTS (' +
        'SELECT 1 FROM guardian_portal_access access WHERE access.app=? AND access.student_id=? ' +
        'AND access.enabled=1 AND access.updated_at=? AND access.guardian_identity_hash=?)'
      ).bind(reuseClaimId, now, 'task', codeHash, now, guardian.identityHash, access.updatedAt,
        'task', studentId, access.updatedAt, guardian.identityHash).run();
      if (changes(consumed) === 1) {
        return json({ ok: true, reusedSession: true }, 200, origin);
      }
      const reusedRow = await env.DB.prepare(
        'SELECT consumed_at,expires_at,revoked FROM guardian_portal_codes WHERE app=? AND code_hash=? LIMIT 1'
      ).bind('task', codeHash).first();
      if (reusedRow && reusedRow.consumed_at != null) {
        return json({ ok: false, code: 'LINK_USED', error: '이미 사용한 보호자 초대 링크입니다' }, 410, origin);
      }
      if (reusedRow && Number(reusedRow.expires_at) < now) {
        return json({ ok: false, code: 'LINK_EXPIRED', error: '사용 시간이 지난 보호자 초대 링크입니다' }, 410, origin);
      }
      return json({ ok: false, code: 'LINK_REPLACED', error: '더 최근에 받은 보호자 초대 링크를 사용해 주세요' }, 410, origin);
    }
  }

  const token = randomOpaque();
  const tokenHash = await storedHash(token);
  const claimId = randomOpaque();
  const results = await env.DB.batch([
    env.DB.prepare(
      'UPDATE guardian_portal_codes SET claim_id=? WHERE app=? AND code_hash=? ' +
      'AND claim_id IS NULL AND consumed_at IS NULL AND revoked=0 AND expires_at>=? ' +
      'AND guardian_identity_hash=? AND access_updated_at=? AND EXISTS (' +
      'SELECT 1 FROM guardian_portal_access access WHERE access.app=? AND access.student_id=? ' +
      'AND access.enabled=1 AND access.updated_at=? AND access.guardian_identity_hash=?)'
    ).bind(claimId, 'task', codeHash, now, guardian.identityHash, access.updatedAt,
      'task', studentId, access.updatedAt, guardian.identityHash),
    env.DB.prepare(
      'INSERT INTO guardian_portal_sessions(app,token_hash,student_id,guardian_identity_hash,access_updated_at,' +
      'created_at,expires_at,last_seen_at,revoked) SELECT ?,?,?,?,?,?,?,?,0 ' +
      'WHERE EXISTS (SELECT 1 FROM guardian_portal_codes WHERE app=? AND code_hash=? AND claim_id=? ' +
      'AND consumed_at IS NULL AND revoked=0)'
    ).bind('task', tokenHash, studentId, guardian.identityHash, access.updatedAt,
      now, now + SESSION_TTL_MS, now, 'task', codeHash, claimId),
    env.DB.prepare(
      'UPDATE guardian_portal_sessions SET revoked=1 WHERE app=? AND student_id=? AND revoked=0 AND token_hash<>? ' +
      'AND token_hash NOT IN (SELECT token_hash FROM guardian_portal_sessions WHERE app=? AND student_id=? ' +
      'AND revoked=0 AND token_hash<>? ORDER BY created_at DESC,token_hash DESC LIMIT ? ) ' +
      'AND EXISTS (SELECT 1 FROM guardian_portal_codes WHERE app=? AND code_hash=? AND claim_id=? ' +
      'AND consumed_at IS NULL AND revoked=0)'
    ).bind('task', studentId, tokenHash, 'task', studentId, tokenHash, MAX_ACTIVE_SESSIONS - 1,
      'task', codeHash, claimId),
    env.DB.prepare(
      'UPDATE guardian_portal_codes SET consumed_at=? WHERE app=? AND code_hash=? AND claim_id=? AND consumed_at IS NULL'
    ).bind(now, 'task', codeHash, claimId)
  ]);
  if (changes(results[0]) !== 1 || changes(results[1]) !== 1 || changes(results[3]) !== 1) {
    const row = await env.DB.prepare(
      'SELECT consumed_at,expires_at,revoked FROM guardian_portal_codes WHERE app=? AND code_hash=? AND student_id=? LIMIT 1'
    ).bind('task', codeHash, studentId).first();
    if (!row) return json({ ok: false, code: 'LINK_INVALID', error: '올바르지 않은 보호자 초대 링크입니다' }, 410, origin);
    if (row.consumed_at != null) return json({ ok: false, code: 'LINK_USED', error: '이미 사용한 보호자 초대 링크입니다' }, 410, origin);
    if (Number(row.expires_at) < now) return json({ ok: false, code: 'LINK_EXPIRED', error: '사용 시간이 지난 보호자 초대 링크입니다' }, 410, origin);
    return json({ ok: false, code: 'LINK_REPLACED', error: '더 최근에 받은 보호자 초대 링크를 사용해 주세요' }, 410, origin);
  }
  return responseWithCookie({ ok: true, expiresAt: now + SESSION_TTL_MS }, 200, origin, sessionCookie(token));
}

async function portalSession(env, rawToken, now) {
  const token = String(rawToken || '');
  if (!SAFE_OPAQUE.test(token)) return null;
  const tokenHash = await storedHash(token);
  const row = await env.DB.prepare(
    'SELECT token_hash,student_id,guardian_identity_hash,access_updated_at,expires_at,last_seen_at FROM guardian_portal_sessions ' +
    'WHERE app=? AND token_hash=? AND revoked=0 AND expires_at>=? LIMIT 1'
  ).bind('task', tokenHash, now).first();
  if (!row) return null;
  const found = await rosterStudent(env, row.student_id, now);
  if (found.error) {
    await env.DB.prepare('UPDATE guardian_portal_sessions SET revoked=1 WHERE app=? AND token_hash=?')
      .bind('task', tokenHash).run();
    return null;
  }
  const guardian = await guardianIdentityReady(env, found.student);
  if (guardian.error || guardian.identityHash !== String(row.guardian_identity_hash || '')) {
    await revokePortalCredentials(env, row.student_id);
    return null;
  }
  const access = await portalAccessReady(env, row.student_id, guardian.identityHash, 1);
  if (access.error || access.updatedAt !== Number(row.access_updated_at)) {
    await env.DB.prepare('UPDATE guardian_portal_sessions SET revoked=1 WHERE app=? AND token_hash=?')
      .bind('task', tokenHash).run();
    return null;
  }
  if (now - Number(row.last_seen_at || 0) > 24 * 60 * 60 * 1000) {
    await env.DB.prepare(
      'UPDATE guardian_portal_sessions SET last_seen_at=? WHERE app=? AND token_hash=? AND revoked=0'
    ).bind(now, 'task', tokenHash).run();
  }
  return { tokenHash, student: found.student, scopeVersion: access.scopeVersion };
}

function parseJson(value) {
  try { return JSON.parse(value || '{}'); } catch (error) { return null; }
}

async function staffNames(env) {
  const result = await env.DB.prepare('SELECT id,data FROM staff WHERE app=?').bind('task').all();
  const names = new Map();
  for (const row of result.results || []) {
    const data = parseJson(row.data);
    if (data && !data.deleted) names.set(String(row.id), text(data.name));
  }
  return names;
}

function kstDate(now) {
  return new Date(Number(now) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function activeTaskOnDate(task, date) {
  return !!task && task.scheduleStatus === 'confirmed' &&
    (!task.start || String(task.start) <= date) && (!task.end || String(task.end) >= date);
}

function activeSlotOnDate(slot, date, weekday) {
  if (!slot || !Array.isArray(slot.days) || !slot.days.map(Number).includes(weekday) ||
      !/^\d{2}:\d{2}$/.test(String(slot.startTime || '')) ||
      !/^\d{2}:\d{2}$/.test(String(slot.endTime || ''))) return false;
  const validFrom = String(slot.validFrom || slot.startDate || '');
  const validTo = String(slot.validTo || slot.endDate || '');
  return (!validFrom || validFrom <= date) && (!validTo || validTo >= date);
}

function lessonStepIds(task, check) {
  const stored = Array.isArray(task.steps) ? task.steps.filter(step => step && step.id) : [];
  const standardStored = stored.length === LESSON_STEP_LABELS.length &&
    stored.every((step, index) => String(step.label || '') === LESSON_STEP_LABELS[index]);
  const legacyProgress = check && check.steps && stored.some(step => check.steps[step.id]);
  if (standardStored || legacyProgress) return stored.map(step => String(step.id));
  return LESSON_STEP_LABELS.map((label, index) => String(task.id) + '-standard-step-' + (index + 1));
}

async function publicTodayLessons(env, student, now) {
  const studentId = String(student && student.id || '');
  const date = kstDate(now);
  const weekday = new Date(Number(now) + 9 * 60 * 60 * 1000).getUTCDay();
  const result = await env.DB.prepare(
    "SELECT id,owner,data FROM tasks WHERE app=? AND json_extract(data,'$.studentId')=? " +
    "AND COALESCE(json_extract(data,'$.deleted'),0)=0 AND json_extract(data,'$.taskKind')='lesson_instruction'"
  ).bind('task', studentId).all();
  const names = await staffNames(env);
  const rows = [];
  for (const row of result.results || []) {
    const task = parseJson(row.data);
    const owner = String(row.owner || '');
    if (!task || (task.id && String(task.id) !== String(row.id)) ||
        String(task.staffId || '') !== owner || !names.has(owner) ||
        !Array.isArray(student.teacherIds) || !student.teacherIds.map(String).includes(owner) ||
        !activeTaskOnDate(task, date) ||
        !Array.isArray(task.scheduleSlots)) continue;
    const slots = task.scheduleSlots.filter(slot => activeSlotOnDate(slot, date, weekday));
    if (!slots.length) continue;
    const checkRow = await env.DB.prepare('SELECT owner,data FROM checks WHERE app=? AND k=? LIMIT 1')
      .bind('task', String(row.id) + '|' + date).first();
    const parsedCheck = checkRow && parseJson(checkRow.data);
    const check = parsedCheck && String(checkRow.owner || '') === owner &&
      String(parsedCheck.taskId || '') === String(row.id) &&
      String(parsedCheck.date || '') === date ? parsedCheck : null;
    const stepIds = lessonStepIds({ ...task, id: String(row.id) }, check);
    const completedSteps = stepIds.filter(id => !!(check && check.steps && check.steps[id])).length;
    const attendance = check && ['P', 'L', 'A'].includes(String(check.att || '')) ? String(check.att) : '';
    for (const slot of slots) rows.push({
      subject: text(task.subject),
      className: text(task.className),
      teacherName: names.get(owner),
      timeLabel: String(slot.startTime) + '–' + String(slot.endTime),
      attendance,
      completedSteps,
      totalSteps: stepIds.length,
      completed: stepIds.length ? completedSteps === stepIds.length : !!(check && check.done)
    });
  }
  return rows.sort((a, b) => a.timeLabel.localeCompare(b.timeLabel, 'ko') ||
    String(a.subject || a.className || '').localeCompare(String(b.subject || b.className || ''), 'ko'));
}

async function publicTodayTransport(env, studentId, now) {
  const date = kstDate(now);
  const weekday = new Date(Number(now) + 9 * 60 * 60 * 1000).getUTCDay();
  const configRow = await env.DB.prepare('SELECT data FROM transport_configs WHERE app=? LIMIT 1').bind('task').first();
  const config = configRow && parseJson(configRow.data);
  if (!config || !Array.isArray(config.routes)) return [];
  const stateResult = await env.DB.prepare(
    'SELECT route_id,status,boarded_at,dropped_at,absent_at FROM transport_states ' +
    'WHERE app=? AND date=? AND student_id=?'
  ).bind('task', date, studentId).all();
  const states = new Map((stateResult.results || []).map(row => [String(row.route_id), row]));
  const rows = [];
  for (const route of config.routes) {
    if (!route || route.active !== true || !Array.isArray(route.days) ||
        !route.days.map(Number).includes(weekday) || !Array.isArray(route.stops)) continue;
    const stop = route.stops.find(item => item && Array.isArray(item.studentIds) &&
      item.studentIds.some(id => String(id) === studentId));
    if (!stop) continue;
    const state = states.get(String(route.id || '')) || null;
    const status = state && ['scheduled', 'boarded', 'dropped', 'absent'].includes(String(state.status || ''))
      ? String(state.status) : 'scheduled';
    const statusAt = status === 'boarded' ? state && state.boarded_at :
      status === 'dropped' ? state && state.dropped_at : status === 'absent' ? state && state.absent_at : null;
    rows.push({
      direction: route.direction === 'dropoff' ? 'dropoff' : 'pickup',
      scheduledTime: /^\d{2}:\d{2}$/.test(String(stop.time || '')) ? String(stop.time) :
        /^\d{2}:\d{2}$/.test(String(route.startTime || '')) ? String(route.startTime) : '',
      status,
      statusAt: statusAt == null ? null : Number(statusAt)
    });
  }
  return rows.sort((a, b) => (a.scheduledTime || '99:99').localeCompare(b.scheduledTime || '99:99'));
}

async function publicToday(env, student, now) {
  const date = kstDate(now);
  const [lessons, transport] = await Promise.all([
    publicTodayLessons(env, student, now),
    publicTodayTransport(env, String(student && student.id || ''), now)
  ]);
  const day = new Date(Number(now) + 9 * 60 * 60 * 1000).getUTCDay();
  return {
    date,
    dateLabel: Number(date.slice(5, 7)) + '월 ' + Number(date.slice(8, 10)) + '일 (' + DAY_LABELS[day] + ')',
    lessons,
    transport
  };
}

async function publicSchedule(env, student, now) {
  const studentId = String(student && student.id || '');
  const today = new Date(Number(now) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const result = await env.DB.prepare(
    "SELECT id,owner,data FROM tasks WHERE app=? AND json_extract(data,'$.studentId')=? " +
    "AND COALESCE(json_extract(data,'$.deleted'),0)=0 AND json_extract(data,'$.taskKind')='lesson_instruction'"
  ).bind('task', studentId).all();
  const names = await staffNames(env);
  const rows = [];
  for (const row of result.results || []) {
    const task = parseJson(row.data);
    const owner = String(row.owner || '');
    if (!task || (task.id && String(task.id) !== String(row.id)) ||
        String(task.staffId || '') !== owner || !names.has(owner) ||
        !Array.isArray(student.teacherIds) || !student.teacherIds.map(String).includes(owner) ||
        !activeTaskOnDate(task, today) || !Array.isArray(task.scheduleSlots)) continue;
    for (const slot of task.scheduleSlots) {
      if (!Array.isArray(slot.days) || !slot.startTime || !slot.endTime) continue;
      const validFrom = String(slot.validFrom || slot.startDate || '');
      const validTo = String(slot.validTo || slot.endDate || '');
      if ((validFrom && validFrom > today) || (validTo && validTo < today)) continue;
      rows.push({
        subject: text(task.subject),
        className: text(task.className),
        teacherName: names.get(owner),
        dayLabel: slot.days.map(day => DAY_LABELS[Number(day)] || '').filter(Boolean).join('·'),
        timeLabel: String(slot.startTime) + '–' + String(slot.endTime)
      });
    }
  }
  return rows.sort((a, b) => a.dayLabel.localeCompare(b.dayLabel, 'ko') || a.timeLabel.localeCompare(b.timeLabel));
}

async function publicFeedback(env, studentId) {
  const result = await env.DB.prepare(
    "SELECT feedback_date,body,teacher_name,status,updated_at FROM feedback_requests " +
    "WHERE app=? AND student_id=? AND status='sent' ORDER BY feedback_date DESC,updated_at DESC LIMIT 20"
  ).bind('task', studentId).all();
  return (result.results || []).map(row => ({
    feedbackDate: String(row.feedback_date || ''),
    message: String(row.body || ''),
    teacherName: String(row.teacher_name || '담당 선생님'),
    status: String(row.status || ''),
    statusLabel: '알림톡 접수'
  }));
}

async function publicOnboarding(env, studentId) {
  const key = '__onboarding__' + encodeURIComponent(studentId) + '|all';
  const row = await env.DB.prepare('SELECT data FROM checks WHERE app=? AND k=? LIMIT 1').bind('task', key).first();
  const record = row && parseJson(row.data);
  if (!record || record.cancelled || record.deleted) return null;
  return {
    firstClassDate: /^\d{4}-\d{2}-\d{2}$/.test(String(record.firstClassDate || '')) ? record.firstClassDate : '',
    classroom: text(record.classroom).slice(0, 80)
  };
}

async function tableExists(env, name) {
  const row = await env.DB.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name=? LIMIT 1").bind(name).first();
  return !!row;
}

// ponytail: 보강·회차 migration이 아직 없는 전환 구간만 빈 배열로 보인다. 배포 후에는 두 table이 항상 존재한다.
async function currentSessionPackTask(env, student, row, activeStaff) {
  const taskRow = await env.DB.prepare('SELECT owner,data FROM tasks WHERE app=? AND id=? LIMIT 1')
    .bind('task', row.lesson_task_id).first();
  const task = taskRow && parseJson(taskRow.data);
  const owner = String(taskRow && taskRow.owner || '');
  if (!task || String(task.id || '') !== String(row.lesson_task_id) || task.deleted ||
      String(task.studentId || '') !== String(student.id) || String(task.staffId || '') !== owner ||
      !SAFE_ID.test(owner) || String(row.task_owner || '') !== owner ||
      !Array.isArray(student.teacherIds) || !student.teacherIds.includes(owner) || !activeStaff.has(owner) ||
      !(task.taskKind === 'lesson_instruction' || task.lessonFormVersion || task.intakeVersion)) {
    return null;
  }
  const [studentIdentityHash, taskIdentityHash] = await Promise.all([
    sha256Hex('student-id\n' + student.id),
    sha256Hex([
      'lesson-task', task.id, owner, task.studentId,
      task.lessonAssignmentKey || task.lessonDedupeKey || task.id
    ].join('\n'))
  ]);
  return studentIdentityHash === String(row.student_identity_hash || '') &&
    taskIdentityHash === String(row.task_identity_hash || '') ? task : null;
}

async function publicOperations(env, student) {
  const studentId = String(student.id || '');
  const output = { makeups: [], sessionPacks: [] };
  if (!await tableExists(env, 'makeup_cases') || !await tableExists(env, 'session_packs') ||
      !await tableExists(env, 'session_pack_usage')) {
    return { error: '보강·회차 정보를 준비하고 있습니다', code: 'OPERATIONS_NOT_READY' };
  }
  {
    const result = await env.DB.prepare(
      'SELECT * FROM makeup_cases WHERE app=? AND student_id=? ORDER BY updated_at DESC LIMIT 50'
    ).bind('task', studentId).all();
    const statusLabels = { review_pending: '검토 중', reviewed: '일정 조율 중', awaiting_parent: '보호자 확인',
      confirmed: '일정 확정', completed: '완료', cancelled: '취소' };
    const names = await staffNames(env);
    for (const row of result.results || []) {
      const taskRow = await env.DB.prepare('SELECT data FROM tasks WHERE app=? AND id=? LIMIT 1')
        .bind('task', row.source_task_id).first();
      const task = taskRow && parseJson(taskRow.data);
      if (!task || String(task.studentId || '') !== studentId) continue;
      const proposed = String(row.proposed_start_at || '');
      const confirmed = String(row.confirmed_start_at || '');
      const shown = confirmed || proposed;
      const staffId = row.confirmed_staff_id || row.proposed_staff_id || '';
      output.makeups.push({
        caseId: String(row.case_id || ''),
        sourceDate: String(row.source_date || ''),
        subject: text(task.subject || task.className || '보강 수업'),
        status: String(row.status || ''),
        statusLabel: statusLabels[String(row.status || '')] || '확인 중',
        confirmedDate: shown ? shown.slice(0, 10) : '',
        confirmedTime: shown ? shown.slice(11, 16) + '–' + String(row.confirmed_end_at || row.proposed_end_at || '').slice(11, 16) : '',
        teacherName: names.get(String(staffId)) || '담당 확인 중',
        revision: Number(row.revision || 0),
        canRespond: String(row.status || '') === 'awaiting_parent'
      });
    }
  }
  {
    const result = await env.DB.prepare(
      'SELECT * FROM session_packs WHERE app=? AND student_id=? AND status=? ORDER BY created_at DESC LIMIT 20'
    ).bind('task', studentId, 'active').all();
    const activeStaff = await staffNames(env);
    for (const row of result.results || []) {
      const task = await currentSessionPackTask(env, student, row, activeStaff);
      if (!task) continue;
      const usedRow = await env.DB.prepare(
        'SELECT COALESCE(SUM(delta),0) used FROM session_pack_usage WHERE app=? AND pack_id=?'
      ).bind('task', row.pack_id).first();
      const used = Number(usedRow && usedRow.used || 0);
      output.sessionPacks.push({
        subject: text(task.subject),
        className: text(task.className),
        total: Number(row.total_sessions || 0),
        used,
        remaining: Math.max(0, Number(row.total_sessions || 0) - used),
        validUntil: String(row.expires_on || '')
      });
    }
  }
  return output;
}

async function viewPortal(env, body, origin, json, request) {
  if (!allowedKeys(body, [])) return json({ ok: false, error: '허용되지 않은 입력이 있습니다' }, 400, origin);
  const now = Date.now();
  const session = await portalSession(env, cookieToken(request), now);
  if (!session) return json({ ok: false, code: 'SESSION_INVALID', error: '보호자 연결이 만료되었습니다. 새 초대 링크를 요청해 주세요' }, 401, origin);
  const operations = await publicOperations(env, session.student);
  if (operations.error) return json({ ok: false, code: operations.code, error: operations.error }, 503, origin);
  const todayEnabled = Number(session.scopeVersion || 1) >= CURRENT_PORTAL_SCOPE_VERSION;
  const [today, schedule, feedback, onboarding] = await Promise.all([
    todayEnabled ? publicToday(env, session.student, now) : Promise.resolve(null),
    publicSchedule(env, session.student, now),
    publicFeedback(env, session.student.id),
    publicOnboarding(env, session.student.id)
  ]);
  const response = {
    ok: true,
    generatedAt: now,
    student: { name: text(session.student.name), grade: text(session.student.grade) },
    capabilities: {
      today: todayEnabled,
      scopeVersion: Number(session.scopeVersion || 1),
      requiredScopeVersion: CURRENT_PORTAL_SCOPE_VERSION
    },
    schedule,
    feedback,
    onboarding,
    makeups: operations.makeups,
    sessionPacks: operations.sessionPacks,
    summary: {
      makeupPending: operations.makeups.filter(row => !['completed', 'cancelled', 'denied'].includes(row.status)).length,
      sessionRemaining: operations.sessionPacks.reduce((sum, row) => sum + row.remaining, 0)
    }
  };
  if (todayEnabled) {
    response.today = today;
    response.summary.todayLessons = today.lessons.length;
    response.summary.todayCompleted = today.lessons.filter(row => row.completed).length;
  }
  return json(response, 200, origin);
}

async function respondPortal(env, body, origin, json, request) {
  if (!allowedKeys(body, ['caseId', 'revision', 'response'])) {
    return json({ ok: false, error: '허용되지 않은 입력이 있습니다' }, 400, origin);
  }
  const session = await portalSession(env, cookieToken(request), Date.now());
  if (!session) return json({ ok: false, code: 'SESSION_INVALID', error: '보호자 연결이 만료되었습니다' }, 401, origin);
  const caseId = String(body.caseId || '');
  const revision = Number(body.revision);
  const response = String(body.response || '');
  if (!SAFE_ID.test(caseId) || !Number.isInteger(revision) || revision < 1 || !['accept', 'decline'].includes(response)) {
    return json({ ok: false, error: '응답 내용을 확인해 주세요' }, 400, origin);
  }
  if (!await tableExists(env, 'makeup_cases')) return json({ ok: false, error: '보강 응답 기능이 아직 준비되지 않았습니다' }, 503, origin);
  const current = await env.DB.prepare(
    'SELECT student_id,status,revision FROM makeup_cases WHERE app=? AND case_id=? LIMIT 1'
  ).bind('task', caseId).first();
  if (!current || current.student_id !== session.student.id) return json({ ok: false, error: '보강 일정을 찾을 수 없습니다' }, 404, origin);
  if (Number(current.revision) !== revision || String(current.status) !== 'awaiting_parent') {
    return json({ ok: false, code: 'STALE_REVISION', error: '보강 일정이 변경되었습니다. 새로고침 후 다시 확인해 주세요' }, 409, origin);
  }
  const now = Date.now();
  const rawId = [caseId, session.student.id, revision, response].join('\u001f');
  const responseId = 'gpr_' + (await sha256Hex(rawId)).slice(0, 48);
  let result;
  try {
    result = await env.DB.prepare(
      'INSERT OR IGNORE INTO guardian_portal_responses ' +
      '(app,response_id,student_id,object_type,object_id,revision,response,created_at) ' +
      "SELECT ?,?,?,?,?,?,?,? FROM makeup_cases WHERE app=? AND case_id=? AND student_id=? " +
      "AND status='awaiting_parent' AND revision=?"
    ).bind('task', responseId, session.student.id, 'makeup', caseId, revision, response, now,
      'task', caseId, session.student.id, revision).run();
  } catch (error) {
    if (/PARENT_RESPONSE_STALE/.test(String(error && error.message || error))) {
      return json({ ok: false, code: 'STALE_REVISION', error: '보강 일정이 변경되었습니다. 새로고침 후 다시 확인해 주세요' }, 409, origin);
    }
    throw error;
  }
  if (changes(result) !== 1) {
    const same = await env.DB.prepare(
      'SELECT response FROM guardian_portal_responses WHERE app=? AND object_type=? AND object_id=? AND student_id=? AND revision=? LIMIT 1'
    ).bind('task', 'makeup', caseId, session.student.id, revision).first();
    if (same && same.response === response) return json({ ok: true, idempotent: true }, 200, origin);
    const fresh = await env.DB.prepare(
      'SELECT status,revision FROM makeup_cases WHERE app=? AND case_id=? AND student_id=? LIMIT 1'
    ).bind('task', caseId, session.student.id).first();
    if (!fresh || String(fresh.status) !== 'awaiting_parent' || Number(fresh.revision) !== revision) {
      return json({ ok: false, code: 'STALE_REVISION', error: '보강 일정이 변경되었습니다. 새로고침 후 다시 확인해 주세요' }, 409, origin);
    }
    return json({ ok: false, code: 'RESPONSE_CONFLICT', error: '이미 다른 응답이 저장되었습니다' }, 409, origin);
  }
  return json({ ok: true, idempotent: false }, 200, origin);
}

async function logoutPortal(env, body, origin, json, request) {
  if (!allowedKeys(body, [])) return json({ ok: false, error: '허용되지 않은 입력이 있습니다' }, 400, origin);
  const token = cookieToken(request);
  if (SAFE_OPAQUE.test(token)) {
    await env.DB.prepare('UPDATE guardian_portal_sessions SET revoked=1 WHERE app=? AND token_hash=?')
      .bind('task', await storedHash(token)).run();
  }
  return responseWithCookie({ ok: true }, 200, origin, clearSessionCookie());
}

async function portalAccess(env, body, auth, origin, json) {
  if (!auth || auth.scope !== 'all') return json({ ok: false, error: '원장·관리 담당만 설정할 수 있습니다' }, 403, origin);
  const action = String(body.action || '');
  if (action === 'access_list') {
    if (!allowedKeys(body, ['auth'])) return json({ ok: false, error: '허용되지 않은 입력이 있습니다' }, 400, origin);
    const result = await env.DB.prepare(
      'SELECT student_id,enabled,guardian_identity_hash,scope_version,accepted_at,updated_at ' +
      'FROM guardian_portal_access WHERE app=? ORDER BY student_id'
    ).bind('task').all();
    const access = [];
    for (const row of result.results || []) {
      const studentId = String(row.student_id);
      const storedEnabled = Number(row.enabled) === 1;
      let enabled = storedEnabled;
      let needsReconsent = false;
      let needsScopeReconsent = false;
      let reconsentReason = '';
      if (storedEnabled) {
        const found = await rosterStudent(env, studentId, Date.now());
        const guardian = found.error ? found : await guardianIdentityReady(env, found.student);
        if (guardian.error ||
            String(row.guardian_identity_hash || '') !== String(guardian.identityHash || '')) {
          enabled = false;
          needsReconsent = true;
          reconsentReason = 'identity';
          await revokePortalCredentials(env, studentId);
        } else if (Number(row.scope_version || 1) < CURRENT_PORTAL_SCOPE_VERSION) {
          enabled = false;
          needsReconsent = true;
          needsScopeReconsent = true;
          reconsentReason = 'scope';
        }
      }
      access.push({
        studentId, enabled, needsReconsent, needsScopeReconsent, reconsentReason,
        scopeVersion: Number(row.scope_version || 1),
        acceptedAt: row.accepted_at == null ? null : Number(row.accepted_at),
        updatedAt: Number(row.updated_at)
      });
    }
    return json({ ok: true, access }, 200, origin);
  }
  if (!allowedKeys(body, ['auth', 'studentId', 'enabled', 'scopeVersion', 'expectedUpdatedAt'])) {
    return json({ ok: false, error: '허용되지 않은 입력이 있습니다' }, 400, origin);
  }
  const studentId = String(body.studentId || '');
  const expectedUpdatedAt = Number(body.expectedUpdatedAt || 0);
  if (!SAFE_ID.test(studentId) || typeof body.enabled !== 'boolean' ||
      !Number.isInteger(expectedUpdatedAt) || expectedUpdatedAt < 0) {
    return json({ ok: false, error: '학생과 이용 동의를 확인해 주세요' }, 400, origin);
  }
  if (body.enabled && Number(body.scopeVersion) !== CURRENT_PORTAL_SCOPE_VERSION) {
    return json({ ok: false, code: 'PORTAL_CONSENT_VERSION_REQUIRED',
      error: '오늘 출결·수업 진행·차량 상태를 포함한 새 공개 범위 동의를 확인해 주세요' }, 409, origin);
  }
  const before = await env.DB.prepare(
    'SELECT enabled,guardian_identity_hash,scope_version,accepted_at,updated_at FROM guardian_portal_access ' +
    'WHERE app=? AND student_id=? LIMIT 1'
  ).bind('task', studentId).first();
  if ((!before && expectedUpdatedAt !== 0) || (before && Number(before.updated_at) !== expectedUpdatedAt)) {
    return json({ ok: false, code: 'ACCESS_REVISION_CONFLICT',
      error: '보호자 웹앱 동의 상태가 다른 화면에서 변경되었습니다. 새로고침 후 다시 확인해 주세요',
      current: before ? { studentId,
        enabled: Number(before.enabled) === 1 && Number(before.scope_version || 1) >= CURRENT_PORTAL_SCOPE_VERSION,
        needsReconsent: Number(before.enabled) === 1 && Number(before.scope_version || 1) < CURRENT_PORTAL_SCOPE_VERSION,
        needsScopeReconsent: Number(before.enabled) === 1 && Number(before.scope_version || 1) < CURRENT_PORTAL_SCOPE_VERSION,
        reconsentReason: Number(before.enabled) === 1 && Number(before.scope_version || 1) < CURRENT_PORTAL_SCOPE_VERSION ? 'scope' : '',
        scopeVersion: Number(before.scope_version || 1),
        acceptedAt: before.accepted_at == null ? null : Number(before.accepted_at),
        updatedAt: Number(before.updated_at) } : null }, 409, origin);
  }
  const beforeAccess = before ? {
    studentId,
    enabled: Number(before.enabled) === 1 && Number(before.scope_version || 1) >= CURRENT_PORTAL_SCOPE_VERSION,
    needsReconsent: Number(before.enabled) === 1 && Number(before.scope_version || 1) < CURRENT_PORTAL_SCOPE_VERSION,
    needsScopeReconsent: Number(before.enabled) === 1 && Number(before.scope_version || 1) < CURRENT_PORTAL_SCOPE_VERSION,
    reconsentReason: Number(before.enabled) === 1 && Number(before.scope_version || 1) < CURRENT_PORTAL_SCOPE_VERSION ? 'scope' : '',
    scopeVersion: Number(before.scope_version || 1),
    acceptedAt: before.accepted_at == null ? null : Number(before.accepted_at),
    updatedAt: Number(before.updated_at)
  } : null;

  const now = Math.max(Date.now(), expectedUpdatedAt + 1);
  // 이용 허용은 현재 학생·보호자 정보가 모두 유효해야 한다. 반면 해제는
  // 명단이나 연락처가 이미 사라졌더라도 stable ID+CAS만으로 항상 성공할 수 있어야 한다.
  let guardianIdentityHash = null;
  if (body.enabled) {
    const found = await rosterStudent(env, studentId, now);
    if (found.error) return json({ ok: false, code: found.code, error: found.error }, 409, origin);
    const guardian = await guardianIdentityReady(env, found.student);
    if (guardian.error) return json({ ok: false, code: guardian.code, error: guardian.error }, 409, origin);
    guardianIdentityHash = guardian.identityHash;
  }
  if (beforeAccess && (Number(before.enabled) === 1) === body.enabled &&
      (!body.enabled || (String(before.guardian_identity_hash || '') === guardianIdentityHash &&
        Number(before.scope_version || 1) === CURRENT_PORTAL_SCOPE_VERSION))) {
    return json({ ok: true, idempotent: true, access: { ...beforeAccess, needsReconsent: false } }, 200, origin);
  }
  const updatedBy = auth.role === 'manager' && SAFE_ID.test(String(auth.id || '')) ? auth.id : 'director';
  const saved = await env.DB.prepare(
    'INSERT INTO guardian_portal_access(app,student_id,enabled,guardian_identity_hash,scope_version,accepted_at,updated_at,updated_by) ' +
    'VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(app,student_id) DO UPDATE SET enabled=excluded.enabled,' +
    'guardian_identity_hash=excluded.guardian_identity_hash,scope_version=excluded.scope_version,accepted_at=excluded.accepted_at,' +
    'updated_at=excluded.updated_at,updated_by=excluded.updated_by ' +
    'WHERE guardian_portal_access.updated_at=?'
  ).bind('task', studentId, body.enabled ? 1 : 0, guardianIdentityHash, CURRENT_PORTAL_SCOPE_VERSION,
    body.enabled ? now : null, now, updatedBy,
    expectedUpdatedAt).run();
  if (changes(saved) !== 1) {
    const current = await env.DB.prepare(
      'SELECT enabled,scope_version,accepted_at,updated_at FROM guardian_portal_access WHERE app=? AND student_id=? LIMIT 1'
    ).bind('task', studentId).first();
    return json({ ok: false, code: 'ACCESS_REVISION_CONFLICT',
      error: '보호자 웹앱 동의 상태가 다른 화면에서 변경되었습니다. 새로고침 후 다시 확인해 주세요',
      current: current ? { studentId,
        enabled: Number(current.enabled) === 1 && Number(current.scope_version || 1) >= CURRENT_PORTAL_SCOPE_VERSION,
        needsReconsent: Number(current.enabled) === 1 && Number(current.scope_version || 1) < CURRENT_PORTAL_SCOPE_VERSION,
        needsScopeReconsent: Number(current.enabled) === 1 && Number(current.scope_version || 1) < CURRENT_PORTAL_SCOPE_VERSION,
        reconsentReason: Number(current.enabled) === 1 && Number(current.scope_version || 1) < CURRENT_PORTAL_SCOPE_VERSION ? 'scope' : '',
        scopeVersion: Number(current.scope_version || 1),
        acceptedAt: current.accepted_at == null ? null : Number(current.accepted_at),
        updatedAt: Number(current.updated_at) } : null }, 409, origin);
  }
  return json({ ok: true, access: {
    studentId, enabled: body.enabled, needsReconsent: false, needsScopeReconsent: false,
    reconsentReason: '', scopeVersion: CURRENT_PORTAL_SCOPE_VERSION,
    acceptedAt: body.enabled ? now : null, updatedAt: now
  } }, 200, origin);
}

export async function handleParentPortal(env, app, body, origin, auth, json, request) {
  if (app !== 'task') return json({ ok: false, error: '보호자 웹앱은 task에서만 사용할 수 있습니다' }, 400, origin);
  body = body && typeof body === 'object' ? body : {};
  const action = String(body.action || 'view');
  if (action === 'access_list' || action === 'access_set') return portalAccess(env, body, auth, origin, json);
  if (action === 'invite') return issueInvite(env, body, auth, origin, json);
  if (action === 'exchange') return exchangeInvite(env, body, origin, json, request);
  if (action === 'view') return viewPortal(env, body, origin, json, request);
  if (action === 'respond') return respondPortal(env, body, origin, json, request);
  if (action === 'logout') return logoutPortal(env, body, origin, json, request);
  return json({ ok: false, error: '지원하지 않는 보호자 웹앱 작업입니다' }, 400, origin);
}
