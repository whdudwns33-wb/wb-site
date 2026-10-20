import { deriveStaffPinHash } from './staff-work-login.js';
import { staffAttendanceDate, staffAttendanceKey, staffAttendanceHasOpenSession } from './staff-attendance.js';

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const PRIVATE_TOKEN = /^[a-f0-9]{64}$/;
const REQUEST_ID = /^pcm_[A-Za-z0-9_-]{4,76}$/;
const IDLE = 10 * 60 * 1000;
const ABSOLUTE = 8 * 60 * 60 * 1000;
const DEVICE_TTL = 90 * 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const digest = async text => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))));
const opaque = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const parse = text => { try { return JSON.parse(text); } catch { return null; } };
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return different === 0;
}
function configured(profile) {
  return profile && /^[a-f0-9]{64}$/.test(profile.pin_hash) &&
    /^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(profile.pin_salt) && profile.pin_iterations === 100000;
}
function deny(status = 401, code = 'PRIVATE_CHAT_LOCKED') {
  throw Object.assign(new Error(code), { privateStatus: status, privateCode: code });
}
function configuration(env) {
  if (String(env.WB_PRIVATE_CHAT_ENABLED || '') !== 'true') deny(404, 'PRIVATE_CHAT_DISABLED');
  const organization = String(env.WB_PRIVATE_CHAT_ORGANIZATION_ID || '');
  const ids = [...new Set(String(env.WB_PRIVATE_CHAT_STAFF_IDS || '').split(',').map(s => s.trim()).filter(Boolean))].sort();
  const adminIds = typeof env.WB_PRIVATE_CHAT_ADMIN_STAFF_IDS === 'string'
    ? env.WB_PRIVATE_CHAT_ADMIN_STAFF_IDS.split(',').map(s => s.trim()).sort() : [];
  if (!ID.test(organization) || !ids.length || ids.some(id => !ID.test(id)) ||
      !adminIds.length || adminIds.some(id => !ID.test(id)) || new Set(adminIds).size !== adminIds.length ||
      typeof env.WB_STAFF_PIN_PEPPER !== 'string' || env.WB_STAFF_PIN_PEPPER.length < 32) deny(503, 'PRIVATE_CHAT_NOT_CONFIGURED');
  return { organization, ids, adminIds };
}
async function member(env, config, id) {
  if (!config.ids.includes(id)) return null;
  const row = await env.DB.prepare('SELECT data FROM staff WHERE app=? AND id=?').bind('task', id).first();
  const staff = row && parse(row.data);
  const profile = await env.DB.prepare('SELECT pin_hash,pin_salt,pin_iterations,credential_revision FROM staff_private_profiles WHERE app=? AND staff_id=?')
    .bind('task', id).first();
  if (!staff || staff.deleted || (staff.id && staff.id !== id) || typeof staff.name !== 'string' ||
      !staff.name.trim() || !configured(profile)) return null;
  return { id, name: staff.name.slice(0, 80), data: row.data, profile };
}
async function pairMember(env, actor, id) {
  // 업무 관리자 권한과 분리하며, 명시 역할도 기존 허용 직원 범위를 넓히지 않는다.
  if (id === actor.id || (!actor.adminIds.includes(actor.id) && !actor.adminIds.includes(id))) return null;
  return member(env, actor, id);
}
async function principal(env, config, body, auth, now) {
  if (body.app !== 'task' || body.auth?.mode !== 'person' || !auth?.id || auth.inspection ||
      !['own', 'all'].includes(auth.scope) || body.auth.id !== auth.id) deny();
  const raw = String(body.auth.token || '');
  if (!raw || raw.length > 256 || raw.startsWith('sha256:')) deny();
  const deviceHash = await digest(raw);
  const token = await env.DB.prepare('SELECT token,staff_id,created_at FROM tokens WHERE app=? AND token IN (?,?) AND revoked=0 AND (token=? OR created_at>=?) LIMIT 1')
    .bind('task', 'sha256:' + deviceHash, raw, raw, now - DEVICE_TTL).first();
  const person = await member(env, config, auth.id);
  const generation = await env.DB.prepare('SELECT generation FROM app_data_generations WHERE app=?').bind('task').first();
  if (!token || token.staff_id !== auth.id) deny(401, 'PERSON_AUTH_REJECTED');
  if (!person || !Number.isSafeInteger(generation?.generation)) deny();
  let ceiling = token.token.startsWith('sha256:') ? Number(token.created_at) + DEVICE_TTL : Infinity;
  const actor = { ...person, ...config, deviceHash, token, ceiling, generation: generation.generation,
    staffHash: await digest(person.data), configHash: await digest(JSON.stringify(config)) };
  actor.workHash = body.auth.workSession ? await digest(String(body.auth.workSession)) : '';
  if (actor.workHash) {
    await parentWork(env, actor, actor.workHash, now);
    actor.ceiling = Math.min(ceiling, Number(actor.work.expires_at));
  }
  return actor;
}
async function parentWork(env, actor, workHash, now) {
  const date = staffAttendanceDate(now);
  const work = await env.DB.prepare('SELECT * FROM staff_work_sessions WHERE app=? AND token_hash=? AND staff_id=? AND device_hash=? AND work_date=? AND credential_revision=? AND data_generation=? AND revoked=0 AND expires_at>?')
    .bind('task', workHash, actor.id, actor.deviceHash, date, actor.profile.credential_revision, actor.generation, now).first();
  const key = staffAttendanceKey(actor.id, date);
  const attendance = work && await env.DB.prepare('SELECT owner,data FROM checks WHERE app=? AND k=?').bind('task', key).first();
  if (!work || attendance?.owner !== actor.id || !staffAttendanceHasOpenSession(parse(attendance.data), date)) deny();
  actor.work = work;
  actor.attendance = { key, data: attendance.data };
}
function guard(actor, now, sessionHash) {
  let sql = 'EXISTS(SELECT 1 FROM staff WHERE app=? AND id=? AND data=?) ' +
    'AND EXISTS(SELECT 1 FROM tokens WHERE app=? AND token=? AND staff_id=? AND created_at=? AND revoked=0) ' +
    'AND EXISTS(SELECT 1 FROM staff_private_profiles WHERE app=? AND staff_id=? AND credential_revision=? AND pin_hash=?) ' +
    'AND EXISTS(SELECT 1 FROM app_data_generations WHERE app=? AND generation=?)';
  const args = ['task', actor.id, actor.data, 'task', actor.token.token, actor.id, actor.token.created_at,
    'task', actor.id, actor.profile.credential_revision, actor.profile.pin_hash, 'task', actor.generation];
  if (actor.workHash) {
    // 발급 당시 원본 S1은 gate가 꺼지거나 요청이 S2로 바뀌어도 쓰기 직전에 다시 검증한다.
    sql += ' AND EXISTS(SELECT 1 FROM staff_work_sessions WHERE app=? AND token_hash=? AND staff_id=? AND device_hash=? AND work_date=? AND credential_revision=? AND data_generation=? AND revoked=0 AND expires_at>?)' +
      ' AND EXISTS(SELECT 1 FROM checks WHERE app=? AND k=? AND owner=? AND data=?)';
    args.push('task', actor.workHash, actor.id, actor.deviceHash, actor.work.work_date, actor.profile.credential_revision, actor.generation, now,
      'task', actor.attendance.key, actor.id, actor.attendance.data);
  }
  if (sessionHash) {
    sql += ' AND EXISTS(SELECT 1 FROM private_chat_sessions WHERE organization_id=? AND token_hash=? AND revoked=0 AND expires_at>? AND last_user_at>?)';
    args.push(actor.organization, sessionHash, now, now - IDLE);
  }
  return { sql, args };
}
async function currentSession(env, actor, body, now) {
  const raw = String(body.privateSession || '');
  if (!PRIVATE_TOKEN.test(raw)) deny();
  const sessionHash = await digest(raw);
  const row = await env.DB.prepare('SELECT * FROM private_chat_sessions WHERE organization_id=? AND token_hash=? AND staff_id=? AND device_hash=? AND staff_hash=? AND credential_revision=? AND data_generation=? AND config_hash=? AND revoked=0 AND expires_at>? AND last_user_at>?')
    .bind(actor.organization, sessionHash, actor.id, actor.deviceHash, actor.staffHash,
      actor.profile.credential_revision, actor.generation, actor.configHash, now, now - IDLE).first();
  if (!row) deny();
  if (row.parent_work_hash) {
    if (actor.workHash !== row.parent_work_hash) deny();
    await parentWork(env, actor, row.parent_work_hash, now);
  }
  return { ...row, sessionHash };
}
async function confirm(env, actor, body, now) {
  if (!/^\d{4}$/.test(String(body.pin || ''))) deny(400, 'PRIVATE_CHAT_PIN_INVALID');
  await env.DB.prepare('INSERT OR IGNORE INTO private_chat_attempts(organization_id,staff_id) VALUES(?,?)')
    .bind(actor.organization, actor.id).run();
  // 개인대화 시도권은 별도 원장에 예약하여 기존 업무 PIN/출근 기록을 바꾸지 않는다.
  const attempt = await env.DB.prepare('UPDATE private_chat_attempts SET failures=CASE WHEN locked_until>0 AND locked_until<=? THEN 1 ELSE failures+1 END, locked_until=CASE WHEN locked_until>0 AND locked_until<=? THEN 0 WHEN failures+1>=5 THEN ? ELSE 0 END, revision=revision+1 WHERE organization_id=? AND staff_id=? AND locked_until<=? AND (failures<5 OR locked_until>0) RETURNING revision')
    .bind(now, now, now + 5 * 60 * 1000, actor.organization, actor.id, now).first();
  if (!attempt) deny(429, 'PRIVATE_CHAT_PIN_LOCKED');
  const candidate = await deriveStaffPinHash(String(body.pin), actor.profile.pin_salt, env.WB_STAFF_PIN_PEPPER, actor.profile.pin_iterations);
  if (!equal(candidate, actor.profile.pin_hash)) deny(401, 'PRIVATE_CHAT_PIN_INCORRECT');
  const token = opaque(), expiresAt = Math.min(now + ABSOLUTE, actor.ceiling);
  const proof = guard(actor, now);
  const inserted = await env.DB.prepare('INSERT INTO private_chat_sessions(organization_id,token_hash,staff_id,device_hash,staff_hash,credential_revision,data_generation,config_hash,parent_work_hash,created_at,last_user_at,expires_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE ' + proof.sql)
    .bind(actor.organization, await digest(token), actor.id, actor.deviceHash, actor.staffHash,
      actor.profile.credential_revision, actor.generation, actor.configHash, actor.workHash, now, now, expiresAt, ...proof.args).run();
  if (!Number(inserted.meta?.changes) || expiresAt <= now) deny();
  await env.DB.prepare('UPDATE private_chat_attempts SET failures=0,locked_until=0 WHERE organization_id=? AND staff_id=? AND revision=?')
    .bind(actor.organization, actor.id, attempt.revision).run();
  return { privateSession: token, expiresAt, idleMs: IDLE, actor: { id: actor.id, name: actor.name } };
}
async function roomAccess(env, actor, roomId) {
  if (!ID.test(String(roomId || ''))) deny(404, 'PRIVATE_CHAT_NOT_FOUND');
  const room = await env.DB.prepare('SELECT * FROM private_chat_rooms WHERE organization_id=? AND id=? AND (participant_low=? OR participant_high=?)')
    .bind(actor.organization, roomId, actor.id, actor.id).first();
  const peer = room && await pairMember(env, actor, room.participant_low === actor.id ? room.participant_high : room.participant_low);
  if (!peer) deny(404, 'PRIVATE_CHAT_NOT_FOUND');
  return { room, peer };
}
async function rooms(env, actor) {
  const rows = await env.DB.prepare('SELECT * FROM private_chat_rooms WHERE organization_id=? AND (participant_low=? OR participant_high=?) ORDER BY created_at DESC,id')
    .bind(actor.organization, actor.id, actor.id).all();
  const items = [];
  for (const row of rows.results || []) {
    const peer = await pairMember(env, actor, row.participant_low === actor.id ? row.participant_high : row.participant_low);
    if (!peer) continue;
    const unread = await env.DB.prepare('SELECT COUNT(*) count FROM private_chat_messages m WHERE organization_id=? AND room_id=? AND sender_id<>? AND NOT EXISTS(SELECT 1 FROM private_chat_reads r WHERE r.organization_id=m.organization_id AND r.room_id=m.room_id AND r.message_sequence=m.sequence AND r.reader_id=?)')
      .bind(actor.organization, row.id, actor.id, actor.id).first();
    items.push({ id: row.id, peer: { id: peer.id, name: peer.name }, unreadCount: Number(unread?.count || 0) });
  }
  return { rooms: items, unreadCount: items.reduce((sum, row) => sum + row.unreadCount, 0) };
}
export async function handlePrivateChat(env, app, body, origin, auth, json) {
  try {
    const config = configuration(env), now = Date.now();
    if (app !== 'task') deny();
    const actor = await principal(env, config, body, auth, now);
    const action = String(body.action || '');
    if (action === 'confirm') {
      const result = await confirm(env, actor, body, now);
      const fresh = await principal(env, config, body, auth, Date.now());
      await currentSession(env, fresh, { privateSession: result.privateSession }, Date.now());
      return json({ ok: true, ...result }, 200, origin);
    }
    if (action === 'status' && !body.privateSession) return json({ ok: true, enabled: true, locked: true }, 200, origin);
    const session = await currentSession(env, actor, body, now);
    const proof = guard(actor, now, session.sessionHash);
    let result;
    if (action === 'logout') {
      await env.DB.prepare('UPDATE private_chat_sessions SET revoked=1 WHERE organization_id=? AND token_hash=?')
        .bind(actor.organization, session.sessionHash).run();
      result = {};
    } else if (action === 'touch') {
      const saved = await env.DB.prepare('UPDATE private_chat_sessions SET last_user_at=MAX(last_user_at,?) WHERE organization_id=? AND token_hash=? AND ' + proof.sql)
        .bind(now, actor.organization, session.sessionHash, ...proof.args).run();
      if (!Number(saved.meta?.changes)) deny();
      result = {};
    } else if (action === 'status') result = { enabled: true, locked: false, expiresAt: session.expires_at };
    else if (action === 'directory') {
      const directory = [];
      for (const id of config.ids) {
        const person = await pairMember(env, actor, id);
        if (person) directory.push({ id: person.id, name: person.name });
      }
      result = { directory };
    } else if (action === 'rooms' || action === 'unread') result = await rooms(env, actor);
    else if (action === 'open') {
      const peer = await pairMember(env, actor, String(body.recipientId || ''));
      if (!peer) deny(404, 'PRIVATE_CHAT_NOT_FOUND');
      const pair = [actor.id, peer.id].sort();
      await env.DB.prepare('INSERT OR IGNORE INTO private_chat_rooms(organization_id,id,participant_low,participant_high,created_at) SELECT ?,?,?,?,? WHERE ' + proof.sql + ' AND EXISTS(SELECT 1 FROM staff WHERE app=? AND id=? AND data=?)')
        .bind(actor.organization, 'pcr_' + crypto.randomUUID(), ...pair, now, ...proof.args, 'task', peer.id, peer.data).run();
      const row = await env.DB.prepare('SELECT id FROM private_chat_rooms WHERE organization_id=? AND participant_low=? AND participant_high=?')
        .bind(actor.organization, ...pair).first();
      if (!row) deny();
      result = { room: { id: row.id, peer: { id: peer.id, name: peer.name } } };
    } else if (['messages', 'send', 'read'].includes(action)) {
      const { room, peer } = await roomAccess(env, actor, body.roomId);
      if (action === 'messages') {
        const before = body.before == null ? Number.MAX_SAFE_INTEGER : Number(body.before);
        if (!Number.isSafeInteger(before) || before < 1) deny(400, 'PRIVATE_CHAT_CURSOR_INVALID');
        const rows = await env.DB.prepare('SELECT m.sequence,m.sender_id,m.body,m.created_at,m.request_id,EXISTS(SELECT 1 FROM private_chat_reads r WHERE r.organization_id=m.organization_id AND r.room_id=m.room_id AND r.reader_id=? AND r.message_sequence=m.sequence) read_by_peer FROM private_chat_messages m WHERE organization_id=? AND room_id=? AND sequence<? ORDER BY sequence DESC LIMIT 50')
          .bind(peer.id, actor.organization, room.id, before).all();
        const messages = (rows.results || []).reverse().map(row => ({ sequence: row.sequence, senderId: row.sender_id,
          body: row.body, createdAt: row.created_at, requestId: row.request_id, readByPeer: !!row.read_by_peer }));
        result = { room: { id: room.id, peer: { id: peer.id, name: peer.name } }, messages,
          before: messages.length === 50 ? messages[0].sequence : null };
      } else if (action === 'send') {
        if (!REQUEST_ID.test(String(body.requestId || '')) || typeof body.body !== 'string' ||
            !body.body.trim() || body.body.length > 1000 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(body.body)) deny(400, 'PRIVATE_CHAT_MESSAGE_INVALID');
        await env.DB.prepare('INSERT OR IGNORE INTO private_chat_messages(organization_id,room_id,sequence,request_id,sender_id,body,created_at) SELECT ?,?,COALESCE((SELECT MAX(sequence) FROM private_chat_messages WHERE organization_id=? AND room_id=?),0)+1,?,?,?,? WHERE ' + proof.sql + ' AND EXISTS(SELECT 1 FROM staff WHERE app=? AND id=? AND data=?)')
          .bind(actor.organization, room.id, actor.organization, room.id, body.requestId, actor.id, body.body, now, ...proof.args, 'task', peer.id, peer.data).run();
        const row = await env.DB.prepare('SELECT room_id,sequence,body FROM private_chat_messages WHERE organization_id=? AND sender_id=? AND request_id=?')
          .bind(actor.organization, actor.id, body.requestId).first();
        if (!row) deny();
        if (row.room_id !== room.id || row.body !== body.body) deny(409, 'PRIVATE_CHAT_REQUEST_CONFLICT');
        result = { sequence: row.sequence, saved: true };
      } else {
        const sequences = body.sequences;
        if (!Array.isArray(sequences) || !sequences.length || sequences.length > 50 || new Set(sequences).size !== sequences.length ||
            sequences.some(seq => !Number.isSafeInteger(seq) || seq < 1) || ('readerId' in body && body.readerId !== actor.id)) deny(400, 'PRIVATE_CHAT_READ_INVALID');
        const placeholders = sequences.map(() => '?').join(',');
        const found = await env.DB.prepare('SELECT sequence FROM private_chat_messages WHERE organization_id=? AND room_id=? AND sequence IN (' + placeholders + ')')
          .bind(actor.organization, room.id, ...sequences).all();
        if (found.results.length !== sequences.length) deny(400, 'PRIVATE_CHAT_READ_INVALID');
        await env.DB.prepare('INSERT OR IGNORE INTO private_chat_reads(organization_id,room_id,reader_id,message_sequence,read_at) SELECT ?,?,?,sequence,? FROM private_chat_messages WHERE organization_id=? AND room_id=? AND sequence IN (' + placeholders + ') AND ' + proof.sql + ' AND EXISTS(SELECT 1 FROM staff WHERE app=? AND id=? AND data=?)')
          .bind(actor.organization, room.id, actor.id, now, actor.organization, room.id, ...sequences, ...proof.args, 'task', peer.id, peer.data).run();
        result = {};
      }
    } else deny(400, 'PRIVATE_CHAT_ACTION_INVALID');
    // 조회 중 인증 폐기·직원 삭제·자격 revision 변경이 확인되면 결과도 반환하지 않는다.
    const refreshedActor = await principal(env, config, body, auth, Date.now());
    if (action !== 'logout') await currentSession(env, refreshedActor, body, Date.now());
    if (action === 'open') await roomAccess(env, refreshedActor, result.room.id);
    if (['messages','send','read'].includes(action)) await roomAccess(env, refreshedActor, body.roomId);
    return json({ ok: true, ...result }, 200, origin);
  } catch (error) {
    const status = error.privateStatus || 503;
    return json({ ok: false, code: error.privateCode || 'PRIVATE_CHAT_UNAVAILABLE',
      ...(error.privateCode === 'PERSON_AUTH_REJECTED' ? {} : { authScope: 'private_chat' }),
      error: status === 401 ? '개인 인증을 확인하고 다시 본인 확인을 해 주세요' : '개인대화 요청을 처리하지 못했습니다' }, status, origin);
  }
}
