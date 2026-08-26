import { validateRosterDocument } from './roster.js';
import { guardianAnnouncementTargetsAllowed } from './guardian-delivery-policy.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_TITLE = 100;
const MAX_BODY = 2000;
const MAX_TARGETS = 200;

function changes(result) {
  return Number(result && result.meta && result.meta.changes || 0);
}

function allowedKeys(payload, allowed) {
  const keys = new Set(['app', 'action'].concat(allowed));
  return Object.keys(payload || {}).every(key => keys.has(key));
}

function cleanTitle(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned && cleaned.length <= MAX_TITLE ? cleaned : null;
}

function cleanBody(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.normalize('NFKC').replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return cleaned && cleaned.length <= MAX_BODY ? cleaned : null;
}

function validDate(value) {
  const date = String(value || '');
  const millis = Date.parse(date + 'T00:00:00.000Z');
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(millis) &&
    new Date(millis).toISOString().slice(0, 10) === date;
}

function targetInput(payload) {
  const targetType = String(payload.targetType || '');
  if (!['all', 'students'].includes(targetType) || !Array.isArray(payload.studentIds)) return null;
  const studentIds = payload.studentIds.map(value => String(value || ''));
  if (studentIds.some(id => !SAFE_ID.test(id)) || new Set(studentIds).size !== studentIds.length) return null;
  studentIds.sort();
  if ((targetType === 'all' && studentIds.length !== 0) ||
      (targetType === 'students' && (studentIds.length < 1 || studentIds.length > MAX_TARGETS))) return null;
  return { targetType, studentIds };
}

async function tableExists(env) {
  const row = await env.DB.prepare(
    "SELECT 1 present FROM sqlite_master WHERE type='table' AND name='guardian_announcements' LIMIT 1"
  ).first();
  return !!row;
}

function identityName(value) {
  return String(value == null ? '' : value).normalize('NFKC').trim();
}

async function activeRosterStudents(env, now) {
  const row = await env.DB.prepare('SELECT data FROM private_rosters WHERE app=? LIMIT 1').bind('task').first();
  if (!row) return null;
  try {
    const document = validateRosterDocument(JSON.parse(row.data || '{}'));
    const students = document.roster.students;
    const month = new Date(Number(now) + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
    return new Map(students.filter(student => student &&
      (!student.start || String(student.start) <= month) &&
      (!student.end || String(student.end) > month))
      .map(student => [String(student.id || ''), identityName(student.name)])
      .filter(([id, name]) => SAFE_ID.test(id) && name));
  } catch (error) {
    return null;
  }
}

async function targetSnapshot(targets, roster) {
  if (targets.targetType === 'all') return '[]';
  const rows = [];
  for (const id of targets.studentIds) {
    rows.push({ id, identityHash: await sha256Hex(id + '\n' + roster.get(id)) });
  }
  return JSON.stringify(rows);
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function actor(auth) {
  const id = String(auth && auth.id || '');
  return SAFE_ID.test(id) ? id : 'director';
}

function parseTargets(row) {
  try {
    const values = JSON.parse(String(row.target_students || '[]'));
    return Array.isArray(values) ? values.map(value => String(value && value.id || '')).filter(id => SAFE_ID.test(id)) : [];
  } catch (error) {
    return [];
  }
}

function managerView(row) {
  return row ? {
    announcementId: String(row.announcement_id || ''),
    title: String(row.title || ''),
    body: String(row.body || ''),
    publishDate: String(row.publish_date || ''),
    expiresDate: String(row.expires_date || ''),
    targetType: String(row.target_type || ''),
    studentIds: parseTargets(row),
    status: String(row.status || ''),
    revision: Number(row.revision || 0),
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0)
  } : null;
}

function publicView(row) {
  return {
    title: String(row.title || ''),
    body: String(row.body || ''),
    publishDate: String(row.publish_date || ''),
    expiresDate: String(row.expires_date || '')
  };
}

function sameDraft(row, input) {
  return row && String(row.status) === 'draft' && String(row.title) === input.title &&
    String(row.body) === input.body && String(row.publish_date) === input.publishDate &&
    String(row.expires_date) === input.expiresDate && String(row.target_type) === input.targetType &&
    String(row.target_students) === input.targetJson;
}

async function targetSnapshotIsCurrent(env, row, now) {
  if (String(row && row.target_type) === 'all') return true;
  const roster = await activeRosterStudents(env, now);
  let targets;
  try { targets = JSON.parse(String(row && row.target_students || '')); }
  catch (error) { return false; }
  if (!roster || !Array.isArray(targets) || !targets.length) return false;
  for (const target of targets) {
    const id = String(target && target.id || '');
    const name = roster.get(id);
    if (!SAFE_ID.test(id) || !name ||
        String(target && target.identityHash || '') !== await sha256Hex(id + '\n' + name)) return false;
  }
  return true;
}

function conflict(json, origin, current) {
  return json({ ok: false, code: 'STALE_REVISION',
    error: '공지가 다른 화면에서 변경되었습니다. 새로고침 후 다시 확인해 주세요',
    current: managerView(current) }, 409, origin);
}

async function eventStatement(env, row, revision, eventType, now, createdBy) {
  const eventId = 'gae_' + (await sha256Hex([
    row.announcementId, revision, eventType
  ].join('\u001f'))).slice(0, 48);
  return env.DB.prepare(
    'INSERT OR IGNORE INTO guardian_announcement_events(app,event_id,announcement_id,revision,event_type,status,' +
    'title,body,publish_date,expires_date,target_type,target_students,created_at,created_by) ' +
    'SELECT ?,?,?,?,?,status,title,body,publish_date,expires_date,target_type,target_students,?,? ' +
    'FROM guardian_announcements current WHERE current.app=? AND current.announcement_id=? ' +
    'AND current.revision=? AND current.status=?'
  ).bind('task', eventId, row.announcementId, revision, eventType, now, createdBy,
    'task', row.announcementId, revision, row.status);
}

async function announcementList(env, payload, origin, json) {
  if (!allowedKeys(payload, ['auth'])) {
    return json({ ok: false, error: '허용되지 않은 입력이 있습니다' }, 400, origin);
  }
  const result = await env.DB.prepare(
    "SELECT * FROM guardian_announcements WHERE app=? " +
    "ORDER BY CASE status WHEN 'published' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,updated_at DESC LIMIT 200"
  ).bind('task').all();
  return json({ ok: true, announcements: (result.results || []).map(managerView) }, 200, origin);
}

async function announcementSave(env, payload, origin, auth, json) {
  if (!allowedKeys(payload, ['auth', 'announcementId', 'expectedRevision', 'title', 'body',
    'publishDate', 'expiresDate', 'targetType', 'studentIds'])) {
    return json({ ok: false, error: '허용되지 않은 입력이 있습니다' }, 400, origin);
  }
  const announcementId = String(payload.announcementId || '');
  const expectedRevision = Number(payload.expectedRevision);
  const title = cleanTitle(payload.title);
  const body = cleanBody(payload.body);
  const publishDate = String(payload.publishDate || '');
  const expiresDate = String(payload.expiresDate || '');
  const targets = targetInput(payload);
  if (!SAFE_ID.test(announcementId) || !Number.isInteger(expectedRevision) || expectedRevision < 0 ||
      !title || !body || !validDate(publishDate) || !validDate(expiresDate) ||
      expiresDate < publishDate || !targets) {
    return json({ ok: false, error: '공지 제목·본문·게시 기간·대상을 확인해 주세요' }, 400, origin);
  }
  if (!guardianAnnouncementTargetsAllowed(env, targets.targetType, targets.studentIds)) {
    return json({ ok: false, code: 'GUARDIAN_DELIVERY_NOT_ALLOWED',
      error: '보호자 공지는 허용된 테스트 학생에게만 게시할 수 있습니다' }, 403, origin);
  }
  const roster = targets.targetType === 'students' ? await activeRosterStudents(env, Date.now()) : null;
  if (targets.targetType === 'students') {
    if (!roster) return json({ ok: false, code: 'ROSTER_UNAVAILABLE',
      error: '원생 명단이 준비되지 않았습니다' }, 409, origin);
    if (targets.studentIds.some(id => !roster.has(id))) {
      return json({ ok: false, code: 'STUDENT_NOT_FOUND',
        error: '현재 원생 명단에 없는 학생이 포함되어 있습니다' }, 409, origin);
    }
  }
  const targetJson = await targetSnapshot(targets, roster);
  const input = { announcementId, title, body, publishDate, expiresDate, ...targets, targetJson };
  const current = await env.DB.prepare(
    'SELECT * FROM guardian_announcements WHERE app=? AND announcement_id=? LIMIT 1'
  ).bind('task', announcementId).first();
  if (current && sameDraft(current, input) &&
      [expectedRevision, expectedRevision + 1].includes(Number(current.revision))) {
    return json({ ok: true, idempotent: true, announcement: managerView(current) }, 200, origin);
  }
  if ((!current && expectedRevision !== 0) || current &&
      (String(current.status) !== 'draft' || Number(current.revision) !== expectedRevision)) {
    return conflict(json, origin, current);
  }
  const revision = expectedRevision + 1;
  const now = Math.max(Date.now(), Number(current && current.updated_at || 0) + 1);
  const updatedBy = actor(auth);
  const next = { ...input, status: 'draft' };
  const write = current
    ? env.DB.prepare(
      "UPDATE guardian_announcements SET title=?,body=?,publish_date=?,expires_date=?,target_type=?," +
      "target_students=?,revision=?,updated_at=?,updated_by=? WHERE app=? AND announcement_id=? " +
      "AND status='draft' AND revision=?"
    ).bind(title, body, publishDate, expiresDate, targets.targetType, targetJson, revision, now,
      updatedBy, 'task', announcementId, expectedRevision)
    : env.DB.prepare(
      'INSERT OR IGNORE INTO guardian_announcements(app,announcement_id,title,body,publish_date,expires_date,' +
      "target_type,target_students,status,revision,created_at,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,'draft',1,?,?,?)"
    ).bind('task', announcementId, title, body, publishDate, expiresDate, targets.targetType,
      targetJson, now, now, updatedBy);
  const ledger = await eventStatement(env, next, revision, current ? 'updated' : 'created', now, updatedBy);
  const results = await env.DB.batch([write, ledger]);
  const saved = await env.DB.prepare(
    'SELECT * FROM guardian_announcements WHERE app=? AND announcement_id=? LIMIT 1'
  ).bind('task', announcementId).first();
  const event = await env.DB.prepare(
    'SELECT 1 present FROM guardian_announcement_events WHERE app=? AND announcement_id=? AND revision=? LIMIT 1'
  ).bind('task', announcementId, revision).first();
  if (!sameDraft(saved, input) || Number(saved.revision) !== revision || !event) return conflict(json, origin, saved);
  return json({ ok: true, idempotent: changes(results[0]) !== 1,
    announcement: managerView(saved) }, 200, origin);
}

async function announcementTransition(env, payload, origin, auth, json, action) {
  if (!allowedKeys(payload, ['auth', 'announcementId', 'expectedRevision'])) {
    return json({ ok: false, error: '허용되지 않은 입력이 있습니다' }, 400, origin);
  }
  const announcementId = String(payload.announcementId || '');
  const expectedRevision = Number(payload.expectedRevision);
  if (!SAFE_ID.test(announcementId) || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
    return json({ ok: false, error: '공지와 현재 revision을 확인해 주세요' }, 400, origin);
  }
  const destination = action === 'announcement_publish' ? 'published' : 'ended';
  const source = action === 'announcement_publish' ? 'draft' : 'published';
  const current = await env.DB.prepare(
    'SELECT * FROM guardian_announcements WHERE app=? AND announcement_id=? LIMIT 1'
  ).bind('task', announcementId).first();
  if (!current) return json({ ok: false, error: '공지를 찾을 수 없습니다' }, 404, origin);
  if (String(current.status) === destination) {
    return json({ ok: true, idempotent: true, announcement: managerView(current) }, 200, origin);
  }
  if (String(current.status) !== source) {
    return json({ ok: false, code: 'INVALID_STATE',
      error: destination === 'published' ? '작성 중인 공지만 게시할 수 있습니다' : '게시된 공지만 종료할 수 있습니다',
      current: managerView(current) }, 409, origin);
  }
  if (Number(current.revision) !== expectedRevision) return conflict(json, origin, current);
  const now = Math.max(Date.now(), Number(current.updated_at || 0) + 1);
  if (destination === 'published' && !guardianAnnouncementTargetsAllowed(
    env, String(current.target_type || ''), parseTargets(current)
  )) {
    return json({ ok: false, code: 'GUARDIAN_DELIVERY_NOT_ALLOWED',
      error: '보호자 공지는 허용된 테스트 학생에게만 게시할 수 있습니다' }, 403, origin);
  }
  if (destination === 'published' && !await targetSnapshotIsCurrent(env, current, now)) {
    return json({ ok: false, code: 'TARGET_RECONFIRM_REQUIRED',
      error: '대상 학생 정보가 변경되었습니다. 공지를 다시 저장한 뒤 게시해 주세요',
      current: managerView(current) }, 409, origin);
  }
  const revision = expectedRevision + 1;
  const updatedBy = actor(auth);
  const write = env.DB.prepare(
    'UPDATE guardian_announcements SET status=?,revision=?,updated_at=?,updated_by=? ' +
    'WHERE app=? AND announcement_id=? AND status=? AND revision=?'
  ).bind(destination, revision, now, updatedBy, 'task', announcementId, source, expectedRevision);
  const ledger = await eventStatement(env, { announcementId, status: destination }, revision,
    destination, now, updatedBy);
  const results = await env.DB.batch([write, ledger]);
  const saved = await env.DB.prepare(
    'SELECT * FROM guardian_announcements WHERE app=? AND announcement_id=? LIMIT 1'
  ).bind('task', announcementId).first();
  const event = await env.DB.prepare(
    'SELECT 1 present FROM guardian_announcement_events WHERE app=? AND announcement_id=? AND revision=? LIMIT 1'
  ).bind('task', announcementId, revision).first();
  if (String(saved && saved.status) === destination && event) {
    return json({ ok: true, idempotent: changes(results[0]) !== 1,
      announcement: managerView(saved) }, 200, origin);
  }
  return conflict(json, origin, saved);
}

/**
 * 직원용 공지 명령. 호출 측 인증을 신뢰하지 않고 모든 action에서 scope=all을 다시 확인한다.
 */
export async function handleGuardianAnnouncements(env, app, payload, origin, auth, json) {
  if (app !== 'task') return json({ ok: false, error: '보호자 공지는 task에서만 사용할 수 있습니다' }, 400, origin);
  if (!auth || auth.scope !== 'all') {
    return json({ ok: false, error: '원장·관리 담당만 보호자 공지를 관리할 수 있습니다' }, 403, origin);
  }
  if (!await tableExists(env)) {
    return json({ ok: false, code: 'ANNOUNCEMENTS_NOT_READY', error: '보호자 공지 기능을 준비하고 있습니다' }, 503, origin);
  }
  const action = String(payload && payload.action || '');
  if (action === 'announcement_list') return announcementList(env, payload, origin, json);
  if (action === 'announcement_save') return announcementSave(env, payload, origin, auth, json);
  if (action === 'announcement_publish' || action === 'announcement_end') {
    return announcementTransition(env, payload, origin, auth, json, action);
  }
  return json({ ok: false, error: '지원하지 않는 보호자 공지 작업입니다' }, 400, origin);
}

/**
 * 보호자용 읽기 계약. request body의 학생값은 받지 않고, 포털이 검증한 세션 학생 ID만 넘긴다.
 */
export async function listActiveGuardianAnnouncements(env, verifiedStudentId, now = Date.now()) {
  const studentId = String(verifiedStudentId || '');
  if (!SAFE_ID.test(studentId)) {
    return { error: '보호자 세션의 학생을 확인할 수 없습니다', code: 'ANNOUNCEMENT_STUDENT_INVALID' };
  }
  if (!await tableExists(env)) {
    return { error: '보호자 공지 기능을 준비하고 있습니다', code: 'ANNOUNCEMENTS_NOT_READY' };
  }
  const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const roster = await activeRosterStudents(env, timestamp);
  const currentName = roster && roster.get(studentId);
  if (!currentName) {
    return { error: '현재 원생 명단에서 보호자 세션의 학생을 확인할 수 없습니다',
      code: 'ANNOUNCEMENT_STUDENT_INVALID' };
  }
  const identityHash = await sha256Hex(studentId + '\n' + currentName);
  const date = new Date(timestamp + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const result = await env.DB.prepare(
    "SELECT title,body,publish_date,expires_date FROM guardian_announcements " +
    "WHERE app=? AND status='published' AND publish_date<=? AND expires_date>=? AND (target_type='all' OR " +
    "EXISTS (SELECT 1 FROM json_each(target_students) target " +
    "WHERE json_extract(target.value,'$.id')=? AND json_extract(target.value,'$.identityHash')=?)) " +
    'ORDER BY publish_date DESC,updated_at DESC LIMIT 50'
  ).bind('task', date, date, studentId, identityHash).all();
  return { announcements: (result.results || []).map(publicView) };
}
