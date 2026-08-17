/** 학생 웹앱 — 보호자 계정과 분리된 한 학생 읽기 전용 세션. */
import {
  guardianIdentityReady,
  publicLessonPublications,
  publicSchedule,
  publicToday,
  rosterStudent
} from './parent-portal.js';
import { readPublicBookStatus } from './public-book-status.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_OPAQUE = /^[a-f0-9]{48}$/i;
const HASH_PREFIX = 'sha256:';
const CODE_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_ACTIVE_SESSIONS = 3;
const SESSION_COOKIE = '__Host-wb_student_session';
const LEGACY_SCOPE_VERSION = 1;
const REQUIRED_SCOPE_VERSION = 2;

function changes(result) {
  return Number(result && result.meta && result.meta.changes || 0);
}

function allowedKeys(body, allowed) {
  const keys = new Set(['app', 'action'].concat(allowed));
  return Object.keys(body || {}).every(key => keys.has(key));
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value || '')));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function storedHash(value) {
  return HASH_PREFIX + await sha256Hex(value);
}

function randomOpaque() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function kstMonth(now) {
  return new Date(Number(now) + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

function activeInMonth(student, month) {
  return student && SAFE_ID.test(String(student.id || '')) &&
    (!student.start || String(student.start) <= month) &&
    (!student.end || String(student.end) > month);
}

async function studentIdentityHash(student) {
  return sha256Hex(String(student.id) + '\n' + String(student.name || '').normalize('NFKC').trim());
}

async function currentStudent(env, studentId, now) {
  if (!SAFE_ID.test(String(studentId || ''))) {
    return { error: '학생을 확인해 주세요', code: 'STUDENT_INVALID' };
  }
  const found = await rosterStudent(env, studentId, now);
  if (found.error || !activeInMonth(found.student, kstMonth(now))) return found;
  const student = found.student;
  return { student, identityHash: await studentIdentityHash(student) };
}

async function currentIdentities(env, studentId, now) {
  const current = await currentStudent(env, studentId, now);
  if (current.error) return current;
  const guardian = await guardianIdentityReady(env, current.student);
  if (guardian.error) return guardian;
  return { ...current, guardianIdentityHash: guardian.identityHash };
}

async function revokeCredentials(env, studentId) {
  await env.DB.batch([
    env.DB.prepare('UPDATE student_portal_codes SET revoked=1 WHERE app=? AND student_id=? AND revoked=0')
      .bind('task', studentId),
    env.DB.prepare('UPDATE student_portal_sessions SET revoked=1 WHERE app=? AND student_id=? AND revoked=0')
      .bind('task', studentId)
  ]);
}

function validScopeVersion(value) {
  const scopeVersion = Number(value);
  return scopeVersion === LEGACY_SCOPE_VERSION || scopeVersion === REQUIRED_SCOPE_VERSION;
}

async function currentAccess(env, studentId, identityHash, guardianIdentityHash, minimumScopeVersion = 1) {
  const row = await env.DB.prepare(
    'SELECT enabled,student_identity_hash,guardian_identity_hash,scope_version,effective_scope_version,' +
    'scope_confirmed_at,accepted_at,updated_at ' +
    'FROM student_portal_access ' +
    'WHERE app=? AND student_id=? LIMIT 1'
  ).bind('task', studentId).first();
  if (!row || Number(row.enabled) !== 1 || row.accepted_at == null) {
    return { error: '학생 앱 이용을 먼저 허용해 주세요', code: 'STUDENT_ACCESS_MISSING' };
  }
  const scopeVersion = Number(row.effective_scope_version);
  if (Number(row.scope_version) !== LEGACY_SCOPE_VERSION || !validScopeVersion(scopeVersion) ||
      String(row.student_identity_hash || '') !== String(identityHash || '') ||
      String(row.guardian_identity_hash || '') !== String(guardianIdentityHash || '')) {
    await revokeCredentials(env, studentId);
    return { error: '학생 정보가 변경되어 새 연결이 필요합니다', code: 'STUDENT_IDENTITY_CHANGED' };
  }
  const scopeConfirmed = scopeVersion === LEGACY_SCOPE_VERSION ||
    (row.scope_confirmed_at != null && Number(row.scope_confirmed_at) === Number(row.updated_at));
  if (!scopeConfirmed) await revokeCredentials(env, studentId);
  if (scopeVersion < minimumScopeVersion || !scopeConfirmed) {
    return { error: '학생 앱 공개 범위 v2 동의를 다시 확인해 주세요', code: 'STUDENT_SCOPE_RECONSENT_REQUIRED' };
  }
  return { row, updatedAt: Number(row.updated_at), scopeVersion };
}

function cookieToken(request) {
  const source = String(request && request.headers.get('Cookie') || '');
  for (const part of source.split(';')) {
    const equal = part.indexOf('=');
    if (equal >= 0 && part.slice(0, equal).trim() === SESSION_COOKIE) {
      const token = part.slice(equal + 1).trim();
      return SAFE_OPAQUE.test(token) ? token : '';
    }
  }
  return '';
}

function cookieResponse(payload, status, origin, cookie) {
  const headers = new Headers({
    'Content-Type': 'application/json;charset=utf-8',
    'Access-Control-Allow-Origin': origin || 'null',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Set-Cookie': cookie
  });
  return new Response(JSON.stringify(payload), { status: status || 200, headers });
}

function sessionCookie(token) {
  return SESSION_COOKIE + '=' + token + '; Path=/; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000) +
    '; HttpOnly; Secure; SameSite=Strict';
}

function clearSessionCookie() {
  return SESSION_COOKIE + '=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ' +
    'HttpOnly; Secure; SameSite=Strict';
}

function studentPortalBaseUrl(env) {
  try {
    const url = new URL(String(env.WB_STUDENT_PORTAL_BASE_URL || ''));
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      return '';
    }
    return url.origin + '/';
  } catch (error) {
    return '';
  }
}

async function studentPortalReady(env) {
  const result = await env.DB.prepare(
    "SELECT type,name,sql FROM sqlite_master WHERE " +
    "(type='table' AND name IN ('student_portal_access','student_portal_codes','student_portal_sessions'," +
    "'guardian_lesson_publications','guardian_lesson_publication_events')) OR " +
    "(type='trigger' AND name IN ('trg_student_portal_access_revoke','trg_student_portal_code_scope_insert'," +
    "'trg_student_portal_session_scope_insert','trg_student_portal_access_disable_scope'," +
    "'trg_student_portal_access_scope_mismatch'))"
  ).all();
  const rows = result.results || [];
  const tables = new Map(rows.filter(row => row.type === 'table')
    .map(row => [String(row.name), String(row.sql || '')]));
  const triggers = new Map(rows.filter(row => row.type === 'trigger')
    .map(row => [String(row.name), String(row.sql || '')]));
  return tables.size === 5 && /guardian_identity_hash/.test(tables.get('student_portal_access') || '') &&
    /effective_scope_version/.test(tables.get('student_portal_access') || '') &&
    /scope_confirmed_at/.test(tables.get('student_portal_access') || '') &&
    /accepted_at/.test(tables.get('student_portal_access') || '') &&
    /guardian_identity_hash/.test(tables.get('student_portal_codes') || '') &&
    /effective_scope_version/.test(tables.get('student_portal_codes') || '') &&
    /guardian_identity_hash/.test(tables.get('student_portal_sessions') || '') &&
    /effective_scope_version/.test(tables.get('student_portal_sessions') || '') &&
    /student_visible/.test(tables.get('guardian_lesson_publications') || '') &&
    /student_visible/.test(tables.get('guardian_lesson_publication_events') || '') &&
    /effective_scope_version/.test(triggers.get('trg_student_portal_access_revoke') || '') &&
    /scope_confirmed_at/.test(triggers.get('trg_student_portal_access_revoke') || '') &&
    /scope_confirmed_at/.test(triggers.get('trg_student_portal_code_scope_insert') || '') &&
    /scope_confirmed_at/.test(triggers.get('trg_student_portal_session_scope_insert') || '') &&
    /scope_confirmed_at/.test(triggers.get('trg_student_portal_access_disable_scope') || '') &&
    /scope_confirmed_at/.test(triggers.get('trg_student_portal_access_scope_mismatch') || '');
}

async function portalSession(env, request, now) {
  const token = cookieToken(request);
  if (!token) return null;
  const tokenHash = await storedHash(token);
  const row = await env.DB.prepare(
    'SELECT student_id,student_identity_hash,guardian_identity_hash,scope_version,effective_scope_version,' +
    'access_updated_at,expires_at,last_seen_at ' +
    'FROM student_portal_sessions WHERE app=? AND token_hash=? AND revoked=0 AND expires_at>=? LIMIT 1'
  ).bind('task', tokenHash, now).first();
  if (!row) return null;
  const current = await currentIdentities(env, String(row.student_id || ''), now);
  if (current.error || current.identityHash !== String(row.student_identity_hash || '') ||
      current.guardianIdentityHash !== String(row.guardian_identity_hash || '') ||
      Number(row.scope_version) !== LEGACY_SCOPE_VERSION || !validScopeVersion(row.effective_scope_version)) {
    await revokeCredentials(env, String(row.student_id || ''));
    return null;
  }
  const access = await currentAccess(env, current.student.id, current.identityHash, current.guardianIdentityHash);
  if (access.error || access.updatedAt !== Number(row.access_updated_at) ||
      access.scopeVersion !== Number(row.effective_scope_version)) {
    await env.DB.prepare('UPDATE student_portal_sessions SET revoked=1 WHERE app=? AND token_hash=?')
      .bind('task', tokenHash).run();
    return null;
  }
  if (now - Number(row.last_seen_at || 0) >= 24 * 60 * 60 * 1000) {
    await env.DB.prepare(
      'UPDATE student_portal_sessions SET last_seen_at=? WHERE app=? AND token_hash=? AND revoked=0'
    ).bind(now, 'task', tokenHash).run();
  }
  return { student: current.student, tokenHash, scopeVersion: access.scopeVersion };
}

async function accessList(env, body, auth, origin, json) {
  if (!auth || auth.scope !== 'all') return json({ ok: false, error: '원장·관리 담당만 볼 수 있습니다' }, 403, origin);
  if (!allowedKeys(body, ['auth'])) return json({ ok: false, error: '허용되지 않은 입력이 있습니다' }, 400, origin);
  const result = await env.DB.prepare(
    'SELECT student_id,enabled,student_identity_hash,guardian_identity_hash,scope_version,' +
    'effective_scope_version,scope_confirmed_at,accepted_at,updated_at ' +
    'FROM student_portal_access ' +
    'WHERE app=? ORDER BY student_id'
  ).bind('task').all();
  const access = [];
  for (const row of result.results || []) {
    const studentId = String(row.student_id || '');
    const current = await currentIdentities(env, studentId, Date.now());
    const scopeVersion = Number(row.effective_scope_version);
    const identityChanged = !current.error && (
      String(row.student_identity_hash || '') !== current.identityHash ||
      String(row.guardian_identity_hash || '') !== current.guardianIdentityHash ||
      Number(row.scope_version) !== LEGACY_SCOPE_VERSION || !validScopeVersion(scopeVersion)
    );
    const unavailable = !!current.error;
    const scopeSealInvalid = scopeVersion === REQUIRED_SCOPE_VERSION &&
      (row.scope_confirmed_at == null || Number(row.scope_confirmed_at) !== Number(row.updated_at));
    if (Number(row.enabled) === 1 && (identityChanged || unavailable || scopeSealInvalid)) {
      await revokeCredentials(env, studentId);
    }
    const needsScopeReconsent = Number(row.enabled) === 1 && !identityChanged && !unavailable &&
      (scopeVersion < REQUIRED_SCOPE_VERSION || scopeSealInvalid);
    access.push({
      studentId,
      enabled: Number(row.enabled) === 1 && !identityChanged && !unavailable && !needsScopeReconsent,
      needsReconnect: Number(row.enabled) === 1 && (identityChanged || unavailable),
      needsScopeReconsent,
      scopeVersion: validScopeVersion(scopeVersion) ? scopeVersion : LEGACY_SCOPE_VERSION,
      acceptedAt: row.accepted_at == null ? null : Number(row.accepted_at),
      updatedAt: Number(row.updated_at)
    });
  }
  return json({ ok: true, requiredScopeVersion: REQUIRED_SCOPE_VERSION, access }, 200, origin);
}

async function accessSet(env, body, auth, origin, json) {
  if (!auth || auth.scope !== 'all') return json({ ok: false, error: '원장·관리 담당만 설정할 수 있습니다' }, 403, origin);
  if (!allowedKeys(body, ['auth', 'studentId', 'enabled', 'consentConfirmed', 'scopeVersion', 'expectedUpdatedAt'])) {
    return json({ ok: false, error: '허용되지 않은 입력이 있습니다' }, 400, origin);
  }
  const studentId = String(body.studentId || '');
  const expectedUpdatedAt = Number(body.expectedUpdatedAt);
  if (!SAFE_ID.test(studentId) || typeof body.enabled !== 'boolean' ||
      !Number.isInteger(expectedUpdatedAt) || expectedUpdatedAt < 0) {
    return json({ ok: false, error: '학생과 이용 상태를 확인해 주세요' }, 400, origin);
  }
  if (body.enabled && body.scopeVersion !== REQUIRED_SCOPE_VERSION) {
    return json({ ok: false, code: 'SCOPE_VERSION_REQUIRED',
      error: '학생 앱 공개 범위 v2를 확인해 주세요' }, 409, origin);
  }
  if (body.enabled && body.consentConfirmed !== true) {
    return json({ ok: false, code: 'CONSENT_REQUIRED',
      error: '보호자에게 학생 앱 공개 범위를 확인해 주세요' }, 409, origin);
  }
  const before = await env.DB.prepare(
    'SELECT enabled,student_identity_hash,guardian_identity_hash,scope_version,effective_scope_version,' +
    'scope_confirmed_at,accepted_at,updated_at ' +
    'FROM student_portal_access ' +
    'WHERE app=? AND student_id=? LIMIT 1'
  ).bind('task', studentId).first();
  if ((!before && expectedUpdatedAt !== 0) || (before && Number(before.updated_at) !== expectedUpdatedAt)) {
    return json({ ok: false, code: 'ACCESS_REVISION_CONFLICT', error: '학생 앱 설정이 변경되었습니다. 새로고침해 주세요' }, 409, origin);
  }
  let identityHash = null;
  let guardianIdentityHash = null;
  if (body.enabled) {
    const current = await currentIdentities(env, studentId, Date.now());
    if (current.error) return json({ ok: false, code: current.code, error: current.error }, 409, origin);
    identityHash = current.identityHash;
    guardianIdentityHash = current.guardianIdentityHash;
  }
  if (before && (Number(before.enabled) === 1) === body.enabled &&
      (!body.enabled || (String(before.student_identity_hash || '') === identityHash &&
        String(before.guardian_identity_hash || '') === guardianIdentityHash &&
        Number(before.scope_version) === LEGACY_SCOPE_VERSION &&
        Number(before.effective_scope_version) === REQUIRED_SCOPE_VERSION &&
        Number(before.scope_confirmed_at) === Number(before.updated_at)))) {
    return json({ ok: true, idempotent: true, access: {
      studentId, enabled: body.enabled, needsReconnect: false, needsScopeReconsent: false,
      scopeVersion: Number(before.effective_scope_version || LEGACY_SCOPE_VERSION),
      acceptedAt: before.accepted_at == null ? null : Number(before.accepted_at), updatedAt: Number(before.updated_at)
    } }, 200, origin);
  }
  const now = Math.max(Date.now(), expectedUpdatedAt + 1);
  const updatedBy = auth.role === 'manager' && SAFE_ID.test(String(auth.id || '')) ? String(auth.id) : 'director';
  const scopeVersion = body.enabled ? REQUIRED_SCOPE_VERSION : LEGACY_SCOPE_VERSION;
  const saved = await env.DB.prepare(
    'INSERT INTO student_portal_access(app,student_id,enabled,student_identity_hash,guardian_identity_hash,' +
    'scope_version,accepted_at,updated_at,updated_by,effective_scope_version,scope_confirmed_at) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,?,?) ' +
    'ON CONFLICT(app,student_id) DO UPDATE SET enabled=excluded.enabled,' +
    'student_identity_hash=excluded.student_identity_hash,guardian_identity_hash=excluded.guardian_identity_hash,' +
    'scope_version=excluded.scope_version,effective_scope_version=excluded.effective_scope_version,' +
    'scope_confirmed_at=excluded.scope_confirmed_at,' +
    'accepted_at=excluded.accepted_at,' +
    'updated_at=excluded.updated_at,updated_by=excluded.updated_by WHERE student_portal_access.updated_at=?'
  ).bind('task', studentId, body.enabled ? 1 : 0, identityHash, guardianIdentityHash, LEGACY_SCOPE_VERSION,
    body.enabled ? now : null, now, updatedBy, scopeVersion, body.enabled ? now : null, expectedUpdatedAt).run();
  if (changes(saved) !== 1) {
    return json({ ok: false, code: 'ACCESS_REVISION_CONFLICT', error: '학생 앱 설정이 변경되었습니다. 새로고침해 주세요' }, 409, origin);
  }
  return json({ ok: true, access: {
    studentId, enabled: body.enabled, needsReconnect: false, needsScopeReconsent: false,
    scopeVersion, acceptedAt: body.enabled ? now : null, updatedAt: now
  } }, 200, origin);
}

async function issueInvite(env, body, auth, origin, json) {
  if (!auth || auth.scope !== 'all') return json({ ok: false, error: '원장·관리 담당만 발급할 수 있습니다' }, 403, origin);
  if (!allowedKeys(body, ['auth', 'studentId'])) return json({ ok: false, error: '허용되지 않은 입력이 있습니다' }, 400, origin);
  const studentId = String(body.studentId || '');
  const now = Date.now();
  const baseUrl = studentPortalBaseUrl(env);
  if (!baseUrl) {
    return json({ ok: false, code: 'STUDENT_PORTAL_NOT_CONFIGURED',
      error: '학생 앱 주소를 먼저 설정해 주세요' }, 503, origin);
  }
  const current = await currentIdentities(env, studentId, now);
  if (current.error) return json({ ok: false, code: current.code, error: current.error }, 409, origin);
  const access = await currentAccess(env, studentId, current.identityHash, current.guardianIdentityHash,
    REQUIRED_SCOPE_VERSION);
  if (access.error) return json({ ok: false, code: access.code, error: access.error }, 409, origin);
  const code = randomOpaque();
  const codeHash = await storedHash(code);
  const expiresAt = now + CODE_TTL_MS;
  const issuedBy = auth.role === 'manager' && SAFE_ID.test(String(auth.id || '')) ? String(auth.id) : 'director';
  const results = await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO student_portal_codes(app,code_hash,student_id,student_identity_hash,guardian_identity_hash,' +
      'scope_version,access_updated_at,created_at,expires_at,consumed_at,revoked,issued_by,claim_id,effective_scope_version) ' +
      'SELECT ?,?,?,?,?,1,?,?,?,NULL,0,?,NULL,? FROM student_portal_access access ' +
      'WHERE access.app=? AND access.student_id=? AND access.enabled=1 AND access.updated_at=? ' +
      'AND access.student_identity_hash=? AND access.guardian_identity_hash=? ' +
      'AND access.scope_version=1 AND access.effective_scope_version=? ' +
      'AND access.scope_confirmed_at=access.updated_at'
    ).bind('task', codeHash, studentId, current.identityHash, current.guardianIdentityHash,
      access.updatedAt, now, expiresAt, issuedBy, access.scopeVersion,
      'task', studentId, access.updatedAt, current.identityHash, current.guardianIdentityHash, access.scopeVersion),
    env.DB.prepare(
      'UPDATE student_portal_codes SET revoked=1 WHERE app=? AND student_id=? AND code_hash<>? ' +
      'AND consumed_at IS NULL AND revoked=0 AND EXISTS (' +
      'SELECT 1 FROM student_portal_codes fresh WHERE fresh.app=? AND fresh.code_hash=?)'
    ).bind('task', studentId, codeHash, 'task', codeHash)
  ]);
  if (changes(results[0]) !== 1) {
    return json({ ok: false, code: 'ACCESS_CHANGED', error: '학생 앱 설정이 변경되었습니다. 다시 확인해 주세요' }, 409, origin);
  }
  return json({ ok: true, code, expiresAt, baseUrl }, 200, origin);
}

async function exchangeInvite(env, body, origin, json, request) {
  if (!allowedKeys(body, ['code'])) return json({ ok: false, error: '허용되지 않은 입력이 있습니다' }, 400, origin);
  const code = String(body.code || '');
  if (!SAFE_OPAQUE.test(code)) return json({ ok: false, code: 'LINK_INVALID', error: '올바른 학생 초대 링크가 필요합니다' }, 400, origin);
  const now = Date.now();
  if (await portalSession(env, request, now)) {
    return json({ ok: false, code: 'SESSION_ALREADY_ACTIVE',
      error: '현재 학생 연결을 먼저 로그아웃한 뒤 새 링크를 사용해 주세요' }, 409, origin);
  }
  const codeHash = await storedHash(code);
  const codeRow = await env.DB.prepare(
    'SELECT student_id,student_identity_hash,guardian_identity_hash,scope_version,effective_scope_version,access_updated_at,' +
    'consumed_at,expires_at,revoked ' +
    'FROM student_portal_codes WHERE app=? AND code_hash=? LIMIT 1'
  ).bind('task', codeHash).first();
  if (!codeRow || Number(codeRow.revoked) === 1 || codeRow.consumed_at != null || Number(codeRow.expires_at) < now) {
    return json({ ok: false, code: 'LINK_INVALID', error: '사용할 수 없는 학생 초대 링크입니다' }, 410, origin);
  }
  const studentId = String(codeRow.student_id || '');
  const current = await currentIdentities(env, studentId, now);
  if (current.error || current.identityHash !== String(codeRow.student_identity_hash || '') ||
      current.guardianIdentityHash !== String(codeRow.guardian_identity_hash || '') ||
      Number(codeRow.scope_version) !== LEGACY_SCOPE_VERSION || !validScopeVersion(codeRow.effective_scope_version)) {
    await revokeCredentials(env, studentId);
    return json({ ok: false, code: 'LINK_INVALID', error: '사용할 수 없는 학생 초대 링크입니다' }, 410, origin);
  }
  const access = await currentAccess(env, studentId, current.identityHash, current.guardianIdentityHash);
  const codeScopeVersion = Number(codeRow.effective_scope_version);
  if (access.error || access.updatedAt !== Number(codeRow.access_updated_at) ||
      access.scopeVersion !== codeScopeVersion) {
    await env.DB.prepare('UPDATE student_portal_codes SET revoked=1 WHERE app=? AND code_hash=?')
      .bind('task', codeHash).run();
    return json({ ok: false, code: 'LINK_INVALID', error: '사용할 수 없는 학생 초대 링크입니다' }, 410, origin);
  }

  const token = randomOpaque();
  const tokenHash = await storedHash(token);
  const claimId = randomOpaque();
  const results = await env.DB.batch([
    env.DB.prepare(
      'UPDATE student_portal_codes SET claim_id=? WHERE app=? AND code_hash=? AND claim_id IS NULL ' +
      'AND consumed_at IS NULL AND revoked=0 AND expires_at>=? AND student_identity_hash=? ' +
      'AND guardian_identity_hash=? AND scope_version=1 AND effective_scope_version=? ' +
      'AND access_updated_at=? AND EXISTS (SELECT 1 FROM student_portal_access access ' +
      'WHERE access.app=? AND access.student_id=? AND access.enabled=1 AND access.updated_at=? ' +
      'AND access.student_identity_hash=? AND access.guardian_identity_hash=? ' +
      'AND access.scope_version=1 AND access.effective_scope_version=? ' +
      'AND (access.effective_scope_version=1 OR access.scope_confirmed_at=access.updated_at))'
    ).bind(claimId, 'task', codeHash, now, current.identityHash, current.guardianIdentityHash, codeScopeVersion,
      access.updatedAt, 'task', studentId, access.updatedAt, current.identityHash, current.guardianIdentityHash,
      codeScopeVersion),
    env.DB.prepare(
      'INSERT INTO student_portal_sessions(app,token_hash,student_id,student_identity_hash,guardian_identity_hash,' +
      'scope_version,access_updated_at,created_at,expires_at,last_seen_at,revoked,effective_scope_version) ' +
      'SELECT ?,?,?,?,?,1,?,?,?,?,0,? WHERE EXISTS (' +
      'SELECT 1 FROM student_portal_codes WHERE app=? AND code_hash=? AND claim_id=? AND consumed_at IS NULL AND revoked=0)'
    ).bind('task', tokenHash, studentId, current.identityHash, current.guardianIdentityHash,
      access.updatedAt, now, now + SESSION_TTL_MS, now, codeScopeVersion,
      'task', codeHash, claimId),
    env.DB.prepare(
      'UPDATE student_portal_sessions SET revoked=1 WHERE app=? AND student_id=? AND revoked=0 AND token_hash<>? ' +
      'AND token_hash NOT IN (SELECT token_hash FROM student_portal_sessions WHERE app=? AND student_id=? ' +
      'AND revoked=0 AND token_hash<>? ORDER BY created_at DESC,token_hash DESC LIMIT ?) ' +
      'AND EXISTS (SELECT 1 FROM student_portal_codes WHERE app=? AND code_hash=? AND claim_id=? ' +
      'AND consumed_at IS NULL AND revoked=0)'
    ).bind('task', studentId, tokenHash, 'task', studentId, tokenHash, MAX_ACTIVE_SESSIONS - 1,
      'task', codeHash, claimId),
    env.DB.prepare(
      'UPDATE student_portal_codes SET consumed_at=? WHERE app=? AND code_hash=? AND claim_id=? AND consumed_at IS NULL'
    ).bind(now, 'task', codeHash, claimId)
  ]);
  if (changes(results[0]) !== 1 || changes(results[1]) !== 1 || changes(results[3]) !== 1) {
    return json({ ok: false, code: 'LINK_INVALID', error: '사용할 수 없는 학생 초대 링크입니다' }, 410, origin);
  }
  return cookieResponse({ ok: true, expiresAt: now + SESSION_TTL_MS }, 200, origin, sessionCookie(token));
}

async function studentPayload(env, student, now, scopeVersion) {
  const [today, schedule, publications, books] = await Promise.all([
    publicToday(env, student, now),
    publicSchedule(env, student, now),
    publicLessonPublications(env, student, now, 'student'),
    readPublicBookStatus(env, student.id, now)
  ]);
  if (publications.error) return publications;
  if (books.error) return books;
  return {
    ok: true,
    generatedAt: now,
    capabilities: { externalLearning: Number(scopeVersion) >= REQUIRED_SCOPE_VERSION },
    student: { name: String(student.name || ''), grade: String(student.grade || '') },
    today: {
      date: today.date,
      dateLabel: today.dateLabel,
      lessons: today.lessons.map(row => ({
        subject: row.subject,
        className: row.className,
        teacherName: row.teacherName,
        timeLabel: row.timeLabel,
        attendance: row.attendance,
        completedSteps: row.completedSteps,
        totalSteps: row.totalSteps,
        completed: row.completed
      })),
      transport: today.transport.map(row => ({
        direction: row.direction,
        scheduledTime: row.scheduledTime,
        status: row.status,
        statusAt: row.statusAt
      }))
    },
    schedule: schedule.map(row => ({
      subject: row.subject,
      className: row.className,
      teacherName: row.teacherName,
      dayLabel: row.dayLabel,
      timeLabel: row.timeLabel
    })),
    publicLessons: publications.rows.map(row => ({
      lessonDate: row.lessonDate,
      subject: row.subject,
      className: row.className,
      teacherName: row.teacherName,
      publicHomework: row.publicHomework,
      publicReadiness: row.publicReadiness,
      updatedAt: row.updatedAt
    })),
    bookStatus: books.rows.filter(row => row.kind === 'distribution').map(row => ({
      kind: row.kind,
      title: row.title,
      stage: row.stage,
      label: row.label,
      updatedAt: row.updatedAt
    }))
  };
}

async function viewPortal(env, body, origin, json, request) {
  if (!allowedKeys(body, [])) return json({ ok: false, error: '허용되지 않은 입력이 있습니다' }, 400, origin);
  const session = await portalSession(env, request, Date.now());
  if (!session) return json({ ok: false, code: 'SESSION_INVALID', error: '학생 연결이 만료되었습니다. 새 링크를 요청해 주세요' }, 401, origin);
  const payload = await studentPayload(env, session.student, Date.now(), session.scopeVersion);
  if (payload.error) return json({ ok: false, code: payload.code, error: payload.error }, 503, origin);
  return json(payload, 200, origin);
}

async function previewPortal(env, body, auth, origin, json) {
  if (!auth || auth.scope !== 'all') return json({ ok: false, error: '원장·관리 담당만 미리 볼 수 있습니다' }, 403, origin);
  if (!allowedKeys(body, ['auth', 'studentId'])) return json({ ok: false, error: '허용되지 않은 입력이 있습니다' }, 400, origin);
  const current = await currentStudent(env, String(body.studentId || ''), Date.now());
  if (current.error) return json({ ok: false, code: current.code, error: current.error }, 409, origin);
  const payload = await studentPayload(env, current.student, Date.now(), REQUIRED_SCOPE_VERSION);
  if (payload.error) return json({ ok: false, code: payload.code, error: payload.error }, 503, origin);
  return json(payload, 200, origin);
}

async function logoutPortal(env, body, origin, json, request) {
  if (!allowedKeys(body, [])) return json({ ok: false, error: '허용되지 않은 입력이 있습니다' }, 400, origin);
  const token = cookieToken(request);
  if (token) {
    await env.DB.prepare('UPDATE student_portal_sessions SET revoked=1 WHERE app=? AND token_hash=?')
      .bind('task', await storedHash(token)).run();
  }
  return cookieResponse({ ok: true }, 200, origin, clearSessionCookie());
}

export async function handleStudentPortal(env, app, body, origin, auth, json, request) {
  if (app !== 'task') return json({ ok: false, error: '학생 웹앱은 task에서만 사용할 수 있습니다' }, 400, origin);
  body = body && typeof body === 'object' ? body : {};
  const action = String(body.action || '');
  const supported = new Set(['access_list', 'access_set', 'invite', 'preview', 'exchange', 'view', 'logout']);
  if (!supported.has(action)) return json({ ok: false, error: '지원하지 않는 학생 웹앱 작업입니다' }, 400, origin);
  if (action === 'exchange' && (!allowedKeys(body, ['code']) || !SAFE_OPAQUE.test(String(body.code || '')))) {
    return json({ ok: false, code: 'LINK_INVALID', error: '올바른 학생 초대 링크가 필요합니다' }, 400, origin);
  }
  let ready = false;
  try { ready = await studentPortalReady(env); } catch (error) { ready = false; }
  if (!ready) return json({ ok: false, code: 'STUDENT_PORTAL_NOT_READY', error: '학생 웹앱을 준비하고 있습니다' }, 503, origin);
  if (action === 'access_list') return accessList(env, body, auth, origin, json);
  if (action === 'access_set') return accessSet(env, body, auth, origin, json);
  if (action === 'invite') return issueInvite(env, body, auth, origin, json);
  if (action === 'preview') return previewPortal(env, body, auth, origin, json);
  if (action === 'exchange') return exchangeInvite(env, body, origin, json, request);
  if (action === 'view') return viewPortal(env, body, origin, json, request);
  if (action === 'logout') return logoutPortal(env, body, origin, json, request);
}
