/** consult 보호자 읽기 전용 리포트 포털. task 보호자 포털과 공유하지 않는다. */

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_OPAQUE = /^[a-f0-9]{48}$/i;
const SAFE_REPORT_REF = /^cgr_[a-f0-9]{48}$/i;
const SAFE_RESULT_REF = /^cgs_[a-f0-9]{48}$/i;
const HASH_PREFIX = 'sha256:';
const CODE_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CONSULT_GUARDIAN_SCOPE_VERSION = 2;
const SESSION_COOKIE = '__Host-wb_consult_guardian';
const SUBJECTS = new Set(['korean', 'english', 'math', 'social', 'science', 'other']);
const REPORT_STATUSES = new Set(['done', 'blocked', 'doing', 'todo']);
const SUBJECT_LABELS = Object.freeze({
  korean: '국어', english: '영어', math: '수학', social: '사회', science: '과학', other: '기타'
});

function changes(result) {
  return Number(result && result.meta && result.meta.changes || 0);
}

function allowedKeys(body, allowed) {
  const keys = new Set(['app', 'action'].concat(allowed));
  return Object.keys(body || {}).every(key => keys.has(key));
}

function parseJson(value) {
  try { return JSON.parse(value || '{}'); } catch (error) { return null; }
}

function publicText(value, max = 500) {
  return String(value == null ? '' : value).normalize('NFKC').replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/https?:\/\/\S+|www\.\S+/gi, '').replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

function validDate(value) {
  const raw = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return '';
  const date = new Date(raw + 'T00:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw ? raw : '';
}

function safeInt(value, max = 1_000_000_000) {
  const number = Math.round(Number(value) || 0);
  return Math.max(0, Math.min(max, number));
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
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

function cookieToken(request) {
  const source = String(request && request.headers.get('Cookie') || '');
  for (const part of source.split(';')) {
    const equal = part.indexOf('=');
    if (equal < 0 || part.slice(0, equal).trim() !== SESSION_COOKIE) continue;
    const token = part.slice(equal + 1).trim();
    return SAFE_OPAQUE.test(token) ? token : '';
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
  return SESSION_COOKIE + '=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ' +
    'HttpOnly; Secure; SameSite=Strict';
}

async function activeStudent(env, staffId) {
  if (!SAFE_ID.test(String(staffId || ''))) return null;
  const row = await env.DB.prepare(
    'SELECT id,data,updated_at FROM staff WHERE app=? AND id=? LIMIT 1'
  ).bind('consult', String(staffId)).first();
  const data = row && parseJson(row.data);
  const name = data && publicText(data.name, 100);
  if (!row || !data || data.deleted || data.owner || data.manager || !name ||
      String(data.id || '') !== String(row.id)) return null;
  return {
    id: String(row.id), name,
    identityRevision: await sha256Hex([
      'consult-student-v1', String(row.id), String(data.name || '').normalize('NFKC').trim(),
      data.deleted ? '1' : '0', data.owner ? '1' : '0', data.manager ? '1' : '0'
    ].join('\u001f'))
  };
}

async function accessRow(env, student) {
  const row = await env.DB.prepare(
    'SELECT enabled,identity_revision,scope_version,accepted_at,updated_at FROM consult_guardian_access ' +
    'WHERE app=? AND staff_id=? LIMIT 1'
  ).bind('consult', student.id).first();
  if (!row || Number(row.enabled) !== 1 || Number(row.scope_version) < CONSULT_GUARDIAN_SCOPE_VERSION ||
      String(row.identity_revision || '') !== student.identityRevision) return null;
  return row;
}

async function revokeCredentials(env, staffId) {
  await env.DB.batch([
    env.DB.prepare('UPDATE consult_guardian_codes SET revoked=1 WHERE app=? AND staff_id=? AND revoked=0')
      .bind('consult', staffId),
    env.DB.prepare('UPDATE consult_guardian_sessions SET revoked=1 WHERE app=? AND staff_id=? AND revoked=0')
      .bind('consult', staffId)
  ]);
}

async function accessDto(env, student) {
  const now = Date.now();
  const row = await env.DB.prepare(
    'SELECT enabled,identity_revision,scope_version,updated_at FROM consult_guardian_access WHERE app=? AND staff_id=? LIMIT 1'
  ).bind('consult', student.id).first();
  const effective = !!row && Number(row.enabled) === 1 &&
    Number(row.scope_version) >= CONSULT_GUARDIAN_SCOPE_VERSION &&
    String(row.identity_revision || '') === student.identityRevision;
  const sessions = effective ? await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM consult_guardian_sessions WHERE app=? AND staff_id=? ' +
    'AND revoked=0 AND expires_at>=? AND identity_revision=? AND scope_version>=? AND access_updated_at=?'
  ).bind('consult', student.id, now, student.identityRevision, CONSULT_GUARDIAN_SCOPE_VERSION,
    Number(row.updated_at)).first() : null;
  const ack = await env.DB.prepare(
    'SELECT MAX(acknowledged_at) AS last_ack_at FROM consult_guardian_acknowledgements WHERE app=? AND staff_id=?'
  ).bind('consult', student.id).first();
  return {
    staffId: student.id, enabled: effective,
    updatedAt: row ? Number(row.updated_at) : 0,
    activeSessions: Number(sessions && sessions.count || 0),
    lastAckAt: ack && ack.last_ack_at != null ? Number(ack.last_ack_at) : null
  };
}

function actorId(auth) {
  return auth && auth.role === 'manager' && SAFE_ID.test(String(auth.id || ''))
    ? String(auth.id) : 'director';
}

async function listAccess(env, body, auth, origin, json) {
  if (!auth || auth.scope !== 'all') {
    return json({ ok: false, error: '원장만 보호자 공유를 관리할 수 있습니다' }, 403, origin);
  }
  if (!allowedKeys(body, ['auth'])) {
    return json({ ok: false, error: '허용되지 않은 입력이 있습니다' }, 400, origin);
  }
  const rows = await env.DB.prepare('SELECT id,data,updated_at FROM staff WHERE app=? ORDER BY id')
    .bind('consult').all();
  const students = (rows.results || []).map(row => {
    const data = parseJson(row.data);
    return data && !data.deleted && !data.owner && !data.manager && publicText(data.name, 100) &&
      String(data.id || '') === String(row.id) ? String(row.id) : '';
  }).filter(Boolean);
  const active = (await Promise.all(students.map(staffId => activeStudent(env, staffId)))).filter(Boolean);
  return json({ ok: true, accesses: await Promise.all(active.map(student => accessDto(env, student))) }, 200, origin);
}

async function setAccess(env, body, auth, origin, json) {
  if (!auth || auth.scope !== 'all') {
    return json({ ok: false, error: '원장만 보호자 공유를 설정할 수 있습니다' }, 403, origin);
  }
  if (!allowedKeys(body, ['auth', 'staffId', 'enabled', 'expectedUpdatedAt', 'consentConfirmed']) ||
      typeof body.enabled !== 'boolean' || (body.enabled && body.consentConfirmed !== true)) {
    return json({ ok: false, error: '공유 설정 입력을 확인해 주세요' }, 400, origin);
  }
  const staffId = String(body.staffId || '');
  const expected = Number(body.expectedUpdatedAt);
  if (!SAFE_ID.test(staffId) || !Number.isSafeInteger(expected) || expected < 0) {
    return json({ ok: false, error: '학생과 설정 revision을 확인해 주세요' }, 400, origin);
  }
  const student = await activeStudent(env, staffId);
  if (!student) return json({ ok: false, code: 'STUDENT_INACTIVE', error: '현재 이용 중인 학생을 찾을 수 없습니다' }, 409, origin);
  const current = await env.DB.prepare(
    'SELECT updated_at FROM consult_guardian_access WHERE app=? AND staff_id=? LIMIT 1'
  ).bind('consult', staffId).first();
  if ((!current && expected !== 0) || (current && Number(current.updated_at) !== expected)) {
    return json({ ok: false, code: 'STALE_REVISION', error: '공유 설정이 바뀌었습니다. 새로고침 후 다시 처리해 주세요',
      access: await accessDto(env, student) }, 409, origin);
  }
  const updatedAt = Math.max(Date.now(), current ? Number(current.updated_at) + 1 : 1);
  let result;
  if (current) {
    result = await env.DB.prepare(
      'UPDATE consult_guardian_access SET enabled=?,identity_revision=?,scope_version=?,accepted_at=?,updated_at=?,updated_by=? ' +
      'WHERE app=? AND staff_id=? AND updated_at=?'
    ).bind(body.enabled ? 1 : 0, student.identityRevision, CONSULT_GUARDIAN_SCOPE_VERSION, body.enabled ? updatedAt : null,
      updatedAt, actorId(auth), 'consult', staffId, expected).run();
  } else {
    result = await env.DB.prepare(
      'INSERT OR IGNORE INTO consult_guardian_access ' +
      '(app,staff_id,enabled,identity_revision,scope_version,accepted_at,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?)'
    ).bind('consult', staffId, body.enabled ? 1 : 0, student.identityRevision, CONSULT_GUARDIAN_SCOPE_VERSION,
      body.enabled ? updatedAt : null, updatedAt, actorId(auth)).run();
  }
  if (changes(result) !== 1) {
    return json({ ok: false, code: 'STALE_REVISION', error: '공유 설정이 다른 화면에서 먼저 바뀌었습니다',
      access: await accessDto(env, student) }, 409, origin);
  }
  return json({ ok: true, access: await accessDto(env, student) }, 200, origin);
}

async function issueInvite(env, body, auth, origin, json, request) {
  if (!auth || auth.scope !== 'all') {
    return json({ ok: false, error: '원장만 보호자 초대를 만들 수 있습니다' }, 403, origin);
  }
  if (!allowedKeys(body, ['auth', 'staffId'])) {
    return json({ ok: false, error: '허용되지 않은 입력이 있습니다' }, 400, origin);
  }
  const staffId = String(body.staffId || '');
  const student = await activeStudent(env, staffId);
  if (!student) return json({ ok: false, code: 'STUDENT_INACTIVE', error: '현재 이용 중인 학생을 찾을 수 없습니다' }, 409, origin);
  const access = await accessRow(env, student);
  if (!access) return json({ ok: false, code: 'ACCESS_REQUIRED', error: '보호자 공유 동의를 먼저 확인해 주세요' }, 409, origin);
  const now = Date.now();
  const code = randomOpaque();
  const codeHash = await storedHash(code);
  const expiresAt = now + CODE_TTL_MS;
  const results = await env.DB.batch([
    env.DB.prepare(
      'UPDATE consult_guardian_codes SET revoked=1 WHERE app=? AND staff_id=? AND revoked=0 AND consumed_at IS NULL'
    ).bind('consult', staffId),
    env.DB.prepare(
      'INSERT INTO consult_guardian_codes ' +
      '(app,code_hash,staff_id,identity_revision,scope_version,access_updated_at,created_at,expires_at,consumed_at,revoked,issued_by,claim_id) ' +
      'SELECT ?,?,?,?,?,?,?,?,NULL,0,?,NULL FROM consult_guardian_access access ' +
      'WHERE access.app=? AND access.staff_id=? AND access.enabled=1 AND access.identity_revision=? ' +
      'AND access.scope_version>=? AND access.updated_at=?'
    ).bind('consult', codeHash, staffId, student.identityRevision, CONSULT_GUARDIAN_SCOPE_VERSION,
      Number(access.updated_at), now, expiresAt, actorId(auth), 'consult', staffId, student.identityRevision,
      CONSULT_GUARDIAN_SCOPE_VERSION, Number(access.updated_at))
  ]);
  if (changes(results[1]) !== 1) {
    return json({ ok: false, code: 'ACCESS_CHANGED', error: '보호자 공유 설정이 바뀌었습니다. 다시 확인해 주세요' }, 409, origin);
  }
  const base = new URL(request.url).origin;
  return json({ ok: true, code, expiresAt, link: base + '/consult-guardian/#code=' + code }, 200, origin);
}

function reportIsNewer(candidate, current) {
  if (!current) return true;
  const revision = safeInt(candidate.task.reportRevision);
  const currentRevision = safeInt(current.task.reportRevision);
  if (revision !== currentRevision) return revision > currentRevision;
  if (candidate.updatedAt !== current.updatedAt) return candidate.updatedAt > current.updatedAt;
  return candidate.id > current.id;
}

function safeSummary(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    done: safeInt(source.done), total: safeInt(source.total), pct: safeInt(source.pct, 100),
    blocked: safeInt(source.blocked), studySecs: safeInt(source.studySecs), goalDays: safeInt(source.goalDays, 366)
  };
}

function safeSubjects(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const output = {};
  for (const key of SUBJECTS) {
    const row = source[key] && typeof source[key] === 'object' ? source[key] : {};
    output[key] = {
      label: SUBJECT_LABELS[key], done: safeInt(row.done), total: safeInt(row.total), studySecs: safeInt(row.studySecs)
    };
  }
  return output;
}

function safeSnapshot(snapshot, student, task) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const reportType = task.reportType === 'month' ? 'month' : task.reportType === 'week' ? 'week' : '';
  const periodKey = reportType === 'month'
    ? (/^\d{4}-(0[1-9]|1[0-2])$/.test(String(task.periodKey || '')) ? String(task.periodKey) : '')
    : validDate(task.periodKey);
  if (!reportType || !periodKey) return null;
  const periodStart = validDate(task.periodStart || snapshot.periodStart);
  const periodEnd = validDate(task.periodEnd || snapshot.periodEnd);
  if (!periodStart || !periodEnd || periodStart > periodEnd) return null;
  const rows = (Array.isArray(snapshot.rows) ? snapshot.rows : []).slice(0, 120).map(row => ({
    date: validDate(row && row.date), title: publicText(row && row.title, 200),
    subject: SUBJECTS.has(String(row && row.subject || '')) ? String(row.subject) : 'other',
    status: REPORT_STATUSES.has(String(row && row.status || '')) ? String(row.status) : 'todo'
  })).filter(row => row.date && row.title);
  const days = (Array.isArray(snapshot.days) ? snapshot.days : []).slice(0, 366).map(day => ({
    date: validDate(day && day.date), done: safeInt(day && day.done), total: safeInt(day && day.total),
    studySecs: safeInt(day && day.studySecs)
  })).filter(day => day.date);
  return {
    periodType: reportType, periodKey, periodStart, periodEnd,
    asOf: safeInt(task.asOf || snapshot.asOf, Number.MAX_SAFE_INTEGER),
    isPartial: !!snapshot.isPartial,
    student: { name: student.name },
    summary: safeSummary(snapshot.summary), subjects: safeSubjects(snapshot.subjects), rows, days,
    elapsedDays: safeInt(snapshot.elapsedDays, 366), dailyGoalMin: safeInt(snapshot.dailyGoalMin, 1440),
    reflection: publicText(snapshot.reflection, 2000),
    directorNote: publicText(snapshot.directorNote, 2000),
    nextFocus: publicText(snapshot.nextFocus, 2000)
  };
}

async function visibleReportRecords(env, student) {
  const result = await env.DB.prepare(
    "SELECT id,data,updated_at FROM tasks WHERE app='consult' AND owner=? " +
    "AND json_valid(data) AND json_extract(data,'$.kind')='report_snapshot' " +
    "AND json_extract(data,'$.origin')='admin' AND COALESCE(json_extract(data,'$.deleted'),0)=0 " +
    'ORDER BY updated_at DESC,id DESC LIMIT 500'
  ).bind(student.id).all();
  const latest = new Map();
  for (const row of result.results || []) {
    const task = parseJson(row.data);
    if (!task || String(task.id || '') !== String(row.id) || String(task.staffId || '') !== student.id ||
        !['week', 'month'].includes(String(task.reportType || '')) || !String(task.periodKey || '') ||
        !Number.isInteger(Number(task.reportRevision)) || Number(task.reportRevision) < 1) continue;
    const key = String(task.reportType) + '\u001f' + String(task.periodKey);
    const candidate = { id: String(row.id), task, updatedAt: Number(row.updated_at) || 0 };
    if (reportIsNewer(candidate, latest.get(key))) latest.set(key, candidate);
  }
  const records = [];
  for (const record of latest.values()) {
    if (record.task.reportStatus !== 'published') continue;
    const snapshot = safeSnapshot(record.task.snapshot, student, record.task);
    if (!snapshot) continue;
    const reportRevision = safeInt(record.task.reportRevision);
    const reportRef = 'cgr_' + (await sha256Hex([
      'consult-guardian-report-v1', student.id, record.id, reportRevision
    ].join('\u001f'))).slice(0, 48);
    records.push({ ...record, snapshot, reportRevision, reportRef });
  }
  records.sort((a, b) => (safeInt(b.task.publishedAt || b.task.createdAt, Number.MAX_SAFE_INTEGER) -
    safeInt(a.task.publishedAt || a.task.createdAt, Number.MAX_SAFE_INTEGER)) || b.reportRevision - a.reportRevision);
  return records.slice(0, 36);
}

async function reportDtos(env, student) {
  const records = await visibleReportRecords(env, student);
  const ackRows = await env.DB.prepare(
    'SELECT source_report_id,report_revision,acknowledged_at FROM consult_guardian_acknowledgements ' +
    'WHERE app=? AND staff_id=?'
  ).bind('consult', student.id).all();
  const ackByReport = new Map((ackRows.results || []).map(row => [
    String(row.source_report_id) + '\u001f' + String(row.report_revision), Number(row.acknowledged_at)
  ]));
  return records.map(record => ({
    sourceReportId: record.id,
    dto: {
      id: record.reportRef,
      title: (record.task.reportType === 'month' ? '월간' : '주간') + ' 학습 리포트',
      status: 'published', reportType: record.task.reportType, periodKey: record.task.periodKey,
      periodStart: record.snapshot.periodStart, periodEnd: record.snapshot.periodEnd,
      reportRevision: record.reportRevision,
      publishedAt: safeInt(record.task.publishedAt || record.task.createdAt, Number.MAX_SAFE_INTEGER),
      isPartial: record.snapshot.isPartial, snapshot: record.snapshot,
      acknowledgedAt: ackByReport.get(record.id + '\u001f' + record.reportRevision) || null
    }
  }));
}

async function resultDtos(env, student) {
  const rows = await env.DB.prepare(
    "SELECT result_id,subject,title,result_date,object_key,media_bytes,created_at FROM consult_result_sheets " +
    "WHERE app='consult' AND owner=? AND status='active' ORDER BY result_date DESC,created_at DESC LIMIT 100"
  ).bind(student.id).all();
  return await Promise.all((rows.results || []).map(async row => ({
    sourceResultId: String(row.result_id), objectKey: String(row.object_key),
    dto: {
      id: 'cgs_' + (await sha256Hex([
        'consult-guardian-result-v1', student.id, String(row.result_id)
      ].join('\u001f'))).slice(0, 48),
      subject: row.subject === 'math' ? 'math' : 'english',
      title: publicText(row.title, 200),
      resultDate: validDate(row.result_date),
      mediaBytes: safeInt(row.media_bytes, 10 * 1024 * 1024),
      createdAt: safeInt(row.created_at, Number.MAX_SAFE_INTEGER)
    }
  })));
}

async function portalPayload(env, student) {
  const [reports, results] = await Promise.all([reportDtos(env, student), resultDtos(env, student)]);
  return {
    ok: true, student: { name: student.name },
    reports: reports.map(record => record.dto), results: results.map(record => record.dto)
  };
}

async function portalSession(env, request, now) {
  const token = cookieToken(request);
  if (!token) return null;
  const tokenHash = await storedHash(token);
  const row = await env.DB.prepare(
    'SELECT staff_id,identity_revision,scope_version,access_updated_at,expires_at,last_seen_at FROM consult_guardian_sessions ' +
    'WHERE app=? AND token_hash=? AND revoked=0 AND expires_at>=? LIMIT 1'
  ).bind('consult', tokenHash, now).first();
  if (!row) return null;
  const student = await activeStudent(env, row.staff_id);
  if (!student || String(row.identity_revision || '') !== student.identityRevision ||
      Number(row.scope_version) < CONSULT_GUARDIAN_SCOPE_VERSION) {
    await revokeCredentials(env, String(row.staff_id || ''));
    return null;
  }
  const access = await accessRow(env, student);
  if (!access || Number(row.scope_version) !== Number(access.scope_version) ||
      Number(row.access_updated_at) !== Number(access.updated_at)) {
    await env.DB.prepare('UPDATE consult_guardian_sessions SET revoked=1 WHERE app=? AND token_hash=?')
      .bind('consult', tokenHash).run();
    return null;
  }
  if (now - Number(row.last_seen_at || 0) > 24 * 60 * 60 * 1000) {
    await env.DB.prepare(
      'UPDATE consult_guardian_sessions SET last_seen_at=? WHERE app=? AND token_hash=? AND revoked=0'
    ).bind(now, 'consult', tokenHash).run();
  }
  return { tokenHash, student, access };
}

async function exchange(env, body, origin, json, request) {
  if (!allowedKeys(body, ['code'])) return json({ ok: false, error: '허용되지 않은 입력이 있습니다' }, 400, origin);
  const code = String(body.code || '');
  if (!SAFE_OPAQUE.test(code)) return json({ ok: false, code: 'LINK_INVALID', error: '올바르지 않은 초대 링크입니다' }, 410, origin);
  const now = Date.now();
  const codeHash = await storedHash(code);
  const codeRow = await env.DB.prepare(
    'SELECT staff_id,identity_revision,scope_version,access_updated_at,expires_at,consumed_at,revoked FROM consult_guardian_codes ' +
    'WHERE app=? AND code_hash=? LIMIT 1'
  ).bind('consult', codeHash).first();
  if (!codeRow) return json({ ok: false, code: 'LINK_INVALID', error: '올바르지 않은 초대 링크입니다' }, 410, origin);
  const existing = await portalSession(env, request, now);
  const codeStaffId = String(codeRow.staff_id || '');
  if (existing && existing.student.id !== codeStaffId) {
    return json({ ok: false, code: 'SESSION_CONFLICT', error: '현재 연결을 해제한 뒤 다른 학생의 초대 링크를 사용해 주세요' }, 409, origin);
  }
  // 같은 학생의 유효한 보호자 세션에서 이미 쓴 링크를 다시 열면 새 세션을 만들지 않고 현재 화면을 돌려준다.
  if (existing && codeRow.consumed_at != null) {
    return json(await portalPayload(env, existing.student), 200, origin);
  }
  if (codeRow.consumed_at != null) return json({ ok: false, code: 'LINK_USED', error: '이미 사용한 초대 링크입니다' }, 410, origin);
  if (Number(codeRow.revoked) !== 0) return json({ ok: false, code: 'LINK_REPLACED', error: '더 최근 초대 링크를 사용해 주세요' }, 410, origin);
  if (Number(codeRow.expires_at) < now) return json({ ok: false, code: 'LINK_EXPIRED', error: '초대 링크 사용 시간이 지났습니다' }, 410, origin);
  const student = await activeStudent(env, String(codeRow.staff_id || ''));
  const access = student && await accessRow(env, student);
  if (!student || !access || String(codeRow.identity_revision || '') !== student.identityRevision ||
      Number(codeRow.scope_version) < CONSULT_GUARDIAN_SCOPE_VERSION ||
      Number(codeRow.scope_version) !== Number(access.scope_version) ||
      Number(codeRow.access_updated_at) !== Number(access.updated_at)) {
    if (student) await revokeCredentials(env, student.id);
    return json({ ok: false, code: 'LINK_INVALID', error: '보호자 공유 설정을 다시 확인해 주세요' }, 410, origin);
  }

  if (existing) {
    const consumed = await env.DB.prepare(
      'UPDATE consult_guardian_codes SET consumed_at=? WHERE app=? AND code_hash=? ' +
      'AND consumed_at IS NULL AND revoked=0 AND expires_at>=?'
    ).bind(now, 'consult', codeHash, now).run();
    if (changes(consumed) !== 1) return json({ ok: false, code: 'LINK_USED', error: '이미 사용한 초대 링크입니다' }, 410, origin);
    return json(await portalPayload(env, existing.student), 200, origin);
  }

  const token = randomOpaque();
  const tokenHash = await storedHash(token);
  const claimId = randomOpaque();
  const results = await env.DB.batch([
    env.DB.prepare(
      'UPDATE consult_guardian_codes SET claim_id=? WHERE app=? AND code_hash=? AND claim_id IS NULL ' +
      'AND consumed_at IS NULL AND revoked=0 AND expires_at>=? AND identity_revision=? AND scope_version=? AND access_updated_at=?'
    ).bind(claimId, 'consult', codeHash, now, student.identityRevision,
      CONSULT_GUARDIAN_SCOPE_VERSION, Number(access.updated_at)),
    env.DB.prepare(
      'INSERT INTO consult_guardian_sessions ' +
      '(app,token_hash,staff_id,identity_revision,scope_version,access_updated_at,created_at,expires_at,last_seen_at,revoked) ' +
      'SELECT ?,?,?,?,?,?,?,?,?,0 FROM consult_guardian_codes code WHERE code.app=? AND code.code_hash=? ' +
      'AND code.claim_id=? AND code.consumed_at IS NULL AND code.revoked=0'
    ).bind('consult', tokenHash, student.id, student.identityRevision, CONSULT_GUARDIAN_SCOPE_VERSION,
      Number(access.updated_at),
      now, now + SESSION_TTL_MS, now, 'consult', codeHash, claimId),
    env.DB.prepare(
      'UPDATE consult_guardian_codes SET consumed_at=? WHERE app=? AND code_hash=? AND claim_id=? AND consumed_at IS NULL'
    ).bind(now, 'consult', codeHash, claimId)
  ]);
  if (changes(results[0]) !== 1 || changes(results[1]) !== 1 || changes(results[2]) !== 1) {
    return json({ ok: false, code: 'LINK_USED', error: '이미 사용했거나 교체된 초대 링크입니다' }, 410, origin);
  }
  const checked = await portalSession(env, new Request(request.url, {
    method: 'POST', headers: { Cookie: SESSION_COOKIE + '=' + token }
  }), now);
  if (!checked) return responseWithCookie({ ok: false, code: 'SESSION_INVALID', error: '보호자 연결을 만들지 못했습니다' },
    409, origin, clearSessionCookie());
  return responseWithCookie(await portalPayload(env, checked.student), 200, origin, sessionCookie(token));
}

async function view(env, body, origin, json, request) {
  if (!allowedKeys(body, [])) return json({ ok: false, error: '허용되지 않은 입력이 있습니다' }, 400, origin);
  const session = await portalSession(env, request, Date.now());
  if (!session) return json({ ok: false, code: 'SESSION_INVALID', error: '보호자 연결이 만료되었습니다. 새 초대 링크를 요청해 주세요' }, 401, origin);
  return json(await portalPayload(env, session.student), 200, origin);
}

async function resultMedia(env, body, origin, json, request) {
  if (!allowedKeys(body, ['resultId'])) return json({ ok: false, error: '허용되지 않은 입력이 있습니다' }, 400, origin);
  const resultId = String(body.resultId || '');
  if (!SAFE_RESULT_REF.test(resultId)) return json({ ok: false, error: '올바른 결과지를 선택해 주세요' }, 400, origin);
  const session = await portalSession(env, request, Date.now());
  if (!session) return json({ ok: false, code: 'SESSION_INVALID', error: '보호자 연결이 만료되었습니다' }, 401, origin);
  const results = await resultDtos(env, session.student);
  const selected = results.find(record => record.dto.id === resultId);
  if (!selected) return json({ ok: false, error: '결과지가 변경되거나 보관되었습니다. 새로고침해 주세요' }, 404, origin);
  if (!env.CONSULT_MEDIA) return json({ ok: false, error: '결과지 저장소를 준비하고 있습니다' }, 503, origin);
  const object = await env.CONSULT_MEDIA.get(selected.objectKey);
  if (!object) return json({ ok: false, error: '결과지 파일을 찾을 수 없습니다' }, 410, origin);
  return new Response(object.body, { status: 200, headers: {
    'Access-Control-Allow-Origin': origin || 'null',
    'Cache-Control': 'private, no-store',
    'Content-Type': 'application/pdf',
    'Content-Disposition': 'inline; filename="result.pdf"',
    'Content-Security-Policy': 'sandbox',
    'Referrer-Policy': 'no-referrer',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff'
  } });
}

async function preview(env, body, auth, origin, json) {
  if (!auth || auth.scope !== 'all') return json({ ok: false, error: '원장만 미리 볼 수 있습니다' }, 403, origin);
  if (!allowedKeys(body, ['auth', 'staffId'])) return json({ ok: false, error: '허용되지 않은 입력이 있습니다' }, 400, origin);
  const student = await activeStudent(env, String(body.staffId || ''));
  if (!student) return json({ ok: false, code: 'STUDENT_INACTIVE', error: '현재 이용 중인 학생을 찾을 수 없습니다' }, 409, origin);
  return json(await portalPayload(env, student), 200, origin);
}

async function acknowledge(env, body, origin, json, request) {
  if (!allowedKeys(body, ['reportId', 'reportRevision'])) {
    return json({ ok: false, error: '허용되지 않은 입력이 있습니다' }, 400, origin);
  }
  const reportId = String(body.reportId || '');
  const reportRevision = Number(body.reportRevision);
  if (!SAFE_REPORT_REF.test(reportId) || !Number.isSafeInteger(reportRevision) || reportRevision < 1) {
    return json({ ok: false, error: '확인할 리포트와 revision을 확인해 주세요' }, 400, origin);
  }
  const session = await portalSession(env, request, Date.now());
  if (!session) return json({ ok: false, code: 'SESSION_INVALID', error: '보호자 연결이 만료되었습니다' }, 401, origin);
  const reports = await reportDtos(env, session.student);
  const selected = reports.find(record => record.dto.id === reportId && record.dto.reportRevision === reportRevision);
  if (!selected) return json({ ok: false, code: 'STALE_REVISION', error: '리포트가 변경되거나 철회되었습니다. 새로고침해 주세요' }, 409, origin);
  const now = Date.now();
  const ackId = 'cga_' + (await sha256Hex([
    'consult-guardian-ack-v1', session.student.id, selected.sourceReportId, reportRevision
  ].join('\u001f'))).slice(0, 48);
  try {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO consult_guardian_acknowledgements ' +
      '(app,ack_id,report_ref,source_report_id,staff_id,report_revision,acknowledged_at) VALUES (?,?,?,?,?,?,?)'
    ).bind('consult', ackId, reportId, selected.sourceReportId, session.student.id, reportRevision, now).run();
  } catch (error) {
    if (/CONSULT_GUARDIAN_REPORT_STALE/.test(String(error && error.message || error))) {
      return json({ ok: false, code: 'STALE_REVISION', error: '리포트가 변경되거나 철회되었습니다. 새로고침해 주세요' }, 409, origin);
    }
    throw error;
  }
  return json(await portalPayload(env, session.student), 200, origin);
}

async function logout(env, body, origin, json, request) {
  if (!allowedKeys(body, [])) return json({ ok: false, error: '허용되지 않은 입력이 있습니다' }, 400, origin);
  const token = cookieToken(request);
  if (token) {
    await env.DB.prepare('UPDATE consult_guardian_sessions SET revoked=1 WHERE app=? AND token_hash=?')
      .bind('consult', await storedHash(token)).run();
  }
  return responseWithCookie({ ok: true }, 200, origin, clearSessionCookie());
}

export async function handleConsultGuardian(env, app, body, origin, auth, json, request) {
  if (app !== 'consult') return json({ ok: false, error: '컨설팅 앱에서만 사용할 수 있습니다' }, 400, origin);
  try {
    const action = String(body.action || '');
    if (action === 'access_list') return await listAccess(env, body, auth, origin, json);
    if (action === 'access_set') return await setAccess(env, body, auth, origin, json);
    if (action === 'invite') return await issueInvite(env, body, auth, origin, json, request);
    if (action === 'preview') return await preview(env, body, auth, origin, json);
    if (action === 'exchange') return await exchange(env, body, origin, json, request);
    if (action === 'view') return await view(env, body, origin, json, request);
    if (action === 'result_media') return await resultMedia(env, body, origin, json, request);
    if (action === 'ack') return await acknowledge(env, body, origin, json, request);
    if (action === 'logout') return await logout(env, body, origin, json, request);
    return json({ ok: false, error: '지원하지 않는 보호자 공유 작업입니다' }, 400, origin);
  } catch (error) {
    const message = String(error && error.message || error || '');
    if (/no such table.*(?:consult_guardian|consult_result_sheets)/i.test(message)) {
      return json({ ok: false, code: 'CONSULT_GUARDIAN_NOT_READY', error: '보호자 공유 기능을 준비하고 있습니다' }, 503, origin);
    }
    console.error('consult-guardian', error && error.name || 'Error');
    return json({ ok: false, error: '보호자 공유를 처리하지 못했습니다. 잠시 후 다시 시도해 주세요' }, 500, origin);
  }
}
