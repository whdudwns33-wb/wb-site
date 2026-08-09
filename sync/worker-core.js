/**
 * WB 동기화 워커 (Cloudflare Workers + D1)
 *
 * 왜 만들었나
 *   기존 Apps Script 방식은 동기화 한 번에 전체 상태(모든 학생·업무·체크)를 주고받고,
 *   서버는 시트를 통째로 지운 뒤 다시 썼다. 학생 100명 규모에서는 동시 실행 한계에 걸려
 *   요청이 실패하기 시작한다. 여기서는 두 가지를 바꾼다.
 *     · 델타 — srv_at 이후 바뀐 행만 주고받는다
 *     · 분할 — 개인 링크로 접속하면 자기 데이터만 오간다
 *
 * 엔드포인트
 *   GET  /health
 *   POST /sync    { app, auth, since, changes[] } → { ok, now, changes[] }
 *   POST /token     { app, auth(admin), staffId } → { ok, token }   구형 개인 링크 호환
 *   POST /bootstrap { app, auth(admin), staffId } → { ok, code }    1회용 링크 발급
 *   POST /exchange  { app, staffId, code }        → { ok, token }   1회 교환
 *   POST /handoff   { app, auth(person) }         → { ok, code }    본인 새 브라우저 이동
 *   POST /lesson-create { app, auth, staffId?, lesson } → 수업 9항목 등록
 *   POST /feedback-request { app, auth, ... }     → 직원 문구 요청·수정·취소
 *   POST /feedback-review  { app, auth(admin) }   → 원장 문구 검토("문구 승인"까지만, 발송은 별개)
 *   POST /parent-feedback-send { app, auth(admin), requestKey } → 승인된 문구를 보호자에게 실제 발송
 *   POST /guardian-contact { app, auth(admin), ... } → 원장, 보호자 연락처·발송 동의 등록/조회
 *   POST /lesson-change-request { app, auth, ... } → 직원, 원장이 등록한 지시서에 변경 제안
 *   POST /lesson-change-review  { app, auth(admin) } → 원장, 변경 제안 승인·반려
 *   POST /director-report-send { app, auth, reportDate, staffId? } → 원장 본인 테스트 LMS
 *   POST /book-order-send { app, auth, taskId } → 교재 주문 문자를 거래처에 실제 발송
 *   POST /book-add-request { app, auth, ... }     → 직원, 새 교재를 교재 목록에 추가해 달라고 신청
 *   POST /book-add-review  { app, auth(admin) }   → 원장, 교재 추가 신청 승인·반려
 *   POST /book-edit-request { app, auth, ... }     → 직원, 기존 교재 정보를 고쳐 달라고 신청
 *   POST /book-edit-review  { app, auth(admin) }   → 원장, 교재 수정 신청 승인·반려
 *   POST /revoke    { app, auth(admin), token|staffId } → { ok }
 *
 * 인증
 *   auth = { mode:'admin',  secret }            → 전체 접근
 *   auth = { mode:'person', id, token }         → 본인 것만
 */

import { handleLessonCreate } from './lesson-create.js';
import { handleDirectorReportSend } from './director-report-send.js';
import { handleLessonChangeRequest, handleLessonChangeReview } from './lesson-change-request.js';
import { handleBookOrderSend } from './book-order-send.js';
import { handleBookAddRequest, handleBookAddReview } from './book-add-request.js';
import { handleBookEditRequest, handleBookEditReview } from './book-edit-request.js';
import { handleGuardianContact } from './guardian-contact.js';
import { handleParentFeedbackSend } from './parent-feedback-send.js';

const APPS = ['task', 'consult'];
const MAX_CHANGES = 500;     // 요청당 상한 — D1 배치 한계와 악의적 대량 전송을 함께 막는다
const MAX_PULL = 2000;       // 응답당 상한. 초과하면 more:true로 알리고 다음 요청에서 이어받는다
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN_HASH_PREFIX = 'sha256:';
const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000;
const HANDOFF_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_BOOTSTRAPS = 3;
const MAX_ACTIVE_PERSON_SESSIONS = 3;
const SAFE_BOOTSTRAP_CODE = /^[a-f0-9]{48}$/i;

const json = (obj, status, origin) => new Response(JSON.stringify(obj), {
  status: status || 200,
  headers: {
    'Content-Type': 'application/json;charset=utf-8',
    'Access-Control-Allow-Origin': origin || '*',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  }
});

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

/** 상수 시간 비교 — 비밀키를 한 글자씩 떠보는 공격을 막는다 */
function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function tokenStorageValue(digest) {
  return TOKEN_HASH_PREFIX + String(digest || '').toLowerCase();
}

function randomOpaqueValue() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function resolveAuth(env, app, auth) {
  if (!auth || typeof auth !== 'object') return null;
  if (auth.mode === 'admin') {
    const want = app === 'task' ? env.TASK_ADMIN_SECRET : env.CONSULT_ADMIN_SECRET;
    if (!want || !safeEqual(auth.secret, want)) return null;
    return { scope: 'all' };
  }
  if (auth.mode === 'person') {
    const id = String(auth.id || '');
    const token = String(auth.token || '');
    if (!SAFE_ID.test(id) || !token || token.length > 256 || token.startsWith(TOKEN_HASH_PREFIX)) return null;
    const tokenHash = tokenStorageValue(await sha256Hex(token));
    const createdAfter = Date.now() - TOKEN_TTL_MS;
    const row = await env.DB.prepare(
      'SELECT staff_id FROM tokens WHERE app=? AND token IN (?,?) AND revoked=0 ' +
      'AND (token=? OR created_at>=?) LIMIT 1'
    ).bind(app, tokenHash, token, token, createdAfter).first();
    if (!row || row.staff_id !== id || !await activeStaff(env, app, id)) return null;
    // 개인 링크는 manager 플래그와 무관하게 항상 본인 범위다. 전체 관리는 원장 로그인만 사용한다.
    return { scope: 'own', id: id };
  }
  return null;
}

/** 들어온 변경을 테이블별 upsert 문으로. updated_at이 더 최신일 때만 덮는다 (LWW) */
function upsertStmt(env, table, app, c, now, ownScope) {
  const idCol = table === 'checks' ? 'k' : 'id';
  const key = table === 'checks' ? c.k : c.id;
  const ownGuard = ownScope
    ? (' AND ' + table + '.owner=excluded.owner' +
      (table === 'tasks' ? " AND json_extract(tasks.data,'$.origin')='staff'" : ''))
    : '';
  return env.DB.prepare(
    'INSERT INTO ' + table + ' (app, ' + idCol + ', owner, data, updated_at, srv_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(app, ' + idCol + ') DO UPDATE SET ' +
    '  owner=excluded.owner, data=excluded.data, ' +
    '  updated_at=excluded.updated_at, srv_at=excluded.srv_at ' +
    'WHERE excluded.updated_at > ' + table + '.updated_at' + ownGuard
  ).bind(app, key, c.owner || null, JSON.stringify(c.data), Number(c.updated_at) || 0, now);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalJson(value[key]);
    return out;
  }
  return value;
}

function sameTaskJson(stored, incoming) {
  try {
    const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
    return JSON.stringify(canonicalJson(parsed)) === JSON.stringify(canonicalJson(incoming));
  } catch (error) {
    return false;
  }
}

async function inspectOwnTaskChanges(env, app, owner, entries) {
  const taskEntries = entries.filter(entry => entry.table === 'tasks');
  if (!taskEntries.length) return { skip: new Set(), newTaskIds: new Set() };
  const ids = [...new Set(taskEntries.map(entry => String(entry.change.id)))];
  const placeholders = ids.map(() => '?').join(',');
  const ownRows = await env.DB.prepare(
    'SELECT id,data FROM tasks WHERE app=? AND owner=? AND id IN (' + placeholders + ')'
  ).bind(app, owner, ...ids).all();
  const allRows = await env.DB.prepare(
    'SELECT id,owner FROM tasks WHERE app=? AND id IN (' + placeholders + ')'
  ).bind(app, ...ids).all();
  const ownById = new Map((ownRows.results || []).map(row => [String(row.id), row]));
  const ownerById = new Map((allRows.results || []).map(row => [String(row.id), String(row.owner || '')]));
  const skip = new Set();
  const newTaskIds = new Set();

  for (const entry of taskEntries) {
    const change = entry.change;
    const id = String(change.id);
    const data = change.data;
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
        String(data.id || '') !== id || String(data.staffId || '') !== owner) {
      return { error: '업무의 id와 담당자 정보가 개인 인증과 일치하지 않습니다' };
    }
    const storedOwner = ownerById.get(id);
    if (storedOwner && storedOwner !== owner) {
      return { error: '다른 담당자의 업무 ID는 사용할 수 없습니다' };
    }
    const current = ownById.get(id);
    if (!current) {
      if (data.origin !== 'staff') {
        return { error: '개인 링크에서는 직원이 직접 만든 업무만 새로 등록할 수 있습니다' };
      }
      newTaskIds.add(id);
      continue;
    }
    let currentData;
    try { currentData = JSON.parse(current.data); } catch (error) { currentData = null; }
    if (!currentData || currentData.origin !== 'staff') {
      if (sameTaskJson(current.data, data)) {
        skip.add(entry);
        continue;
      }
      return { error: '원장이 등록한 업무는 개인 링크에서 수정하거나 삭제할 수 없습니다' };
    }
    if (data.origin !== 'staff') {
      return { error: '직원 업무의 등록 주체를 변경할 수 없습니다' };
    }
  }
  return { skip, newTaskIds };
}

async function inspectOwnCheckChanges(env, app, owner, entries, newTaskIds) {
  const checkEntries = entries.filter(entry => entry.table === 'checks');
  if (!checkEntries.length) return null;
  const generalTaskIds = [];

  for (const entry of checkEntries) {
    const key = String(entry.change.k || '');
    const firstPipe = key.indexOf('|');
    if (firstPipe <= 0 || firstPipe !== key.lastIndexOf('|') || firstPipe === key.length - 1) {
      return '체크 키 형식을 확인해 주세요';
    }
    const keyTaskId = key.slice(0, firstPipe);
    const keyDate = key.slice(firstPipe + 1);
    const data = entry.change.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return '체크 데이터 형식을 확인해 주세요';
    }
    if (Object.prototype.hasOwnProperty.call(data, 'taskId') && String(data.taskId) !== keyTaskId) {
      return '체크 데이터의 taskId가 체크 키와 일치하지 않습니다';
    }
    if (Object.prototype.hasOwnProperty.call(data, 'date') && String(data.date) !== keyDate) {
      return '체크 데이터의 날짜가 체크 키와 일치하지 않습니다';
    }

    const special = keyTaskId.match(/^__[A-Za-z]+__(.+)$/);
    if (special) {
      if (special[1] !== owner) return '다른 담당자의 특수 체크는 저장할 수 없습니다';
    } else {
      generalTaskIds.push(keyTaskId);
    }
  }

  const idsToFind = [...new Set(generalTaskIds.filter(id => !newTaskIds.has(id)))];
  const allowed = new Set(newTaskIds);
  if (idsToFind.length) {
    const placeholders = idsToFind.map(() => '?').join(',');
    const result = await env.DB.prepare(
      'SELECT id FROM tasks WHERE app=? AND owner=? AND id IN (' + placeholders + ')'
    ).bind(app, owner, ...idsToFind).all();
    for (const row of (result.results || [])) allowed.add(String(row.id));
  }
  if (generalTaskIds.some(id => !allowed.has(id))) {
    return '본인에게 배정된 업무의 체크만 저장할 수 있습니다';
  }
  return null;
}

async function handleSync(env, app, body, origin) {
  const auth = await resolveAuth(env, app, body.auth);
  if (!auth) return json({ ok: false, error: '인증 실패' }, 401, origin);

  const now = Date.now();
  const since = Number(body.since) || 0;
  const changes = Array.isArray(body.changes) ? body.changes : [];
  if (changes.length > MAX_CHANGES) {
    return json({ ok: false, error: '한 번에 보낼 수 있는 변경은 ' + MAX_CHANGES + '건까지입니다' }, 413, origin);
  }

  // ── 올리기
  const accepted = [];
  let forbidden = false;
  for (const c of changes) {
    if (!c || !c.table || !APPS.includes(app)) continue;
    const t = c.table;
    if (t !== 'staff' && t !== 'tasks' && t !== 'checks') continue;
    if (!(t === 'checks' ? c.k : c.id)) continue;
    // 개인 접속은 자기 것만 쓸 수 있다. 남의 owner를 붙여 보내도 서버에서 막는다.
    if (auth.scope === 'own') {
      // 직원 명부는 서버/원장 소유다. 구형 개인 UI가 명부 행을 다시 올려도 안전하게 무시한다.
      if (t === 'staff') {
        accepted.push({ table: t, change: c });
        continue;
      }
      if (c.owner !== auth.id) {
        forbidden = true;
        break;
      }
    }
    accepted.push({ table: t, change: c });
  }
  if (forbidden) return json({ ok: false, error: '개인 링크에서는 본인 업무만 저장할 수 있습니다' }, 403, origin);
  let skipped = new Set();
  if (auth.scope === 'own') {
    const inspected = await inspectOwnTaskChanges(env, app, auth.id, accepted);
    if (inspected.error) return json({ ok: false, error: inspected.error }, 403, origin);
    skipped = inspected.skip;
    for (const entry of accepted) {
      if (entry.table === 'staff') skipped.add(entry);
    }
    const checkError = await inspectOwnCheckChanges(env, app, auth.id, accepted, inspected.newTaskIds);
    if (checkError) return json({ ok: false, error: checkError }, 403, origin);
  }
  const stmts = accepted
    .filter(entry => !skipped.has(entry))
    .map(entry => upsertStmt(env, entry.table, app, entry.change, now, auth.scope === 'own'));
  if (stmts.length) await env.DB.batch(stmts);

  // ── 내려받기 (since 이후)
  const out = [];
  let more = false;
  for (const t of ['staff', 'tasks', 'checks']) {
    const idCol = t === 'checks' ? 'k' : 'id';
    const sql = 'SELECT ' + idCol + ' AS key, owner, data, updated_at, srv_at FROM ' + t +
      ' WHERE app=? AND srv_at > ?' + (auth.scope === 'own' ? ' AND owner=?' : '') +
      ' ORDER BY srv_at LIMIT ' + (MAX_PULL + 1);
    const st = auth.scope === 'own'
      ? env.DB.prepare(sql).bind(app, since, auth.id)
      : env.DB.prepare(sql).bind(app, since);
    const res = await st.all();
    const rows = (res.results || []);
    if (rows.length > MAX_PULL) { more = true; rows.length = MAX_PULL; }
    for (const r of rows) {
      out.push({ table: t, key: r.key, owner: r.owner, data: JSON.parse(r.data), updated_at: r.updated_at, srv_at: r.srv_at });
    }
  }

  // more일 때는 받은 것 중 가장 오래된 srv_at까지만 확정해야 빠지는 행이 없다
  const nextSince = more ? Math.max(since, ...out.map(r => r.srv_at)) : now;
  return json({ ok: true, now: nextSince, more: more, changes: out }, 200, origin);
}

async function handleToken(env, app, body, origin) {
  const auth = await resolveAuth(env, app, body.auth);
  if (!auth || auth.scope !== 'all') return json({ ok: false, error: '원장만 발급할 수 있습니다' }, 401, origin);
  const staffId = String(body.staffId || '');
  if (!staffId) return json({ ok: false, error: 'staffId 필요' }, 400, origin);
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  await env.DB.prepare(
    'INSERT INTO tokens (app, token, staff_id, created_at, revoked) VALUES (?,?,?,?,0)'
  ).bind(app, token, staffId, Date.now()).run();
  return json({ ok: true, token: token }, 200, origin);
}

async function activeStaff(env, app, staffId) {
  if (!SAFE_ID.test(staffId)) return false;
  const row = await env.DB.prepare('SELECT data FROM staff WHERE app=? AND id=? LIMIT 1')
    .bind(app, staffId).first();
  if (!row) return false;
  try { return !JSON.parse(row.data).deleted; } catch (error) { return false; }
}

async function issueBootstrap(env, app, staffId, ttlMs) {
  if (!await activeStaff(env, app, staffId)) throw new Error('활성 직원을 찾을 수 없습니다');
  const code = randomOpaqueValue();
  const codeHash = tokenStorageValue(await sha256Hex(code));
  const createdAt = Date.now();
  const expiresAt = createdAt + ttlMs;
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE bootstrap_codes SET revoked=1 ' +
      'WHERE app=? AND staff_id=? AND revoked=0 AND consumed_at IS NULL AND expires_at<?'
    ).bind(app, staffId, createdAt),
    env.DB.prepare(
      'INSERT INTO bootstrap_codes(app,code_hash,staff_id,created_at,expires_at,consumed_at,revoked) ' +
      'VALUES(?,?,?,?,?,NULL,0)'
    ).bind(app, codeHash, staffId, createdAt, expiresAt),
    // 최근 미사용 링크를 소수만 함께 유지한다. 새 링크 하나가 기존 전달분을 즉시 끊지는 않되,
    // 무제한으로 살아 있는 연결 링크가 쌓이는 것도 막는다. 방금 발급한 링크는 항상 보존한다.
    env.DB.prepare(
      'UPDATE bootstrap_codes SET revoked=1 ' +
      'WHERE app=? AND staff_id=? AND revoked=0 AND consumed_at IS NULL AND code_hash<>? ' +
      'AND code_hash NOT IN (' +
      'SELECT code_hash FROM bootstrap_codes ' +
      'WHERE app=? AND staff_id=? AND revoked=0 AND consumed_at IS NULL AND code_hash<>? AND expires_at>=? ' +
      'ORDER BY created_at DESC, code_hash DESC LIMIT ' + (MAX_PENDING_BOOTSTRAPS - 1) + ')'
    ).bind(app, staffId, codeHash, app, staffId, codeHash, createdAt)
  ]);
  return { code, expiresAt };
}

async function handleBootstrap(env, app, body, origin) {
  const auth = await resolveAuth(env, app, body.auth);
  if (!auth || auth.scope !== 'all') return json({ ok: false, error: '원장만 발급할 수 있습니다' }, 401, origin);
  const staffId = String(body.staffId || '');
  if (!SAFE_ID.test(staffId)) return json({ ok: false, error: '올바른 staffId 필요' }, 400, origin);
  try {
    const issued = await issueBootstrap(env, app, staffId, BOOTSTRAP_TTL_MS);
    return json({ ok: true, code: issued.code, expiresAt: issued.expiresAt }, 200, origin);
  } catch (error) {
    return json({ ok: false, error: String(error && error.message || error) }, 409, origin);
  }
}

async function handleExchange(env, app, body, origin) {
  const staffId = String(body.staffId || '');
  const code = String(body.code || '');
  if (!SAFE_ID.test(staffId) || !SAFE_BOOTSTRAP_CODE.test(code)) {
    return json({ ok: false, code: 'LINK_INVALID', error: '올바른 개인 링크가 필요합니다' }, 400, origin);
  }
  if (!await activeStaff(env, app, staffId)) {
    return json({ ok: false, code: 'LINK_INVALID', error: '접근할 수 없는 개인 링크입니다' }, 401, origin);
  }

  const codeHash = tokenStorageValue(await sha256Hex(code));
  const consumedAt = Date.now();
  const markerBytes = new Uint32Array(1);
  crypto.getRandomValues(markerBytes);
  const consumeMarker = -(consumedAt * 1000 + (markerBytes[0] % 1000));
  const token = randomOpaqueValue();
  const storedHash = tokenStorageValue(await sha256Hex(token));
  const results = await env.DB.batch([
    env.DB.prepare(
      'UPDATE bootstrap_codes SET consumed_at=? ' +
      'WHERE app=? AND code_hash=? AND staff_id=? AND revoked=0 AND consumed_at IS NULL AND expires_at>=?'
    ).bind(consumeMarker, app, codeHash, staffId, consumedAt),
    env.DB.prepare(
      'INSERT INTO tokens(app,token,staff_id,created_at,revoked) ' +
      'SELECT ?,?,?,?,0 WHERE EXISTS (' +
      'SELECT 1 FROM bootstrap_codes WHERE app=? AND code_hash=? AND staff_id=? AND consumed_at=?)'
    ).bind(app, storedHash, staffId, consumedAt, app, codeHash, staffId, consumeMarker),
    env.DB.prepare(
      'UPDATE tokens SET revoked=1 ' +
      'WHERE app=? AND staff_id=? AND revoked=0 AND created_at<? AND EXISTS (' +
      'SELECT 1 FROM bootstrap_codes WHERE app=? AND code_hash=? AND staff_id=? AND consumed_at=?)'
    ).bind(app, staffId, consumedAt - TOKEN_TTL_MS, app, codeHash, staffId, consumeMarker),
    // 새 기기를 포함해 최근 세 세션만 유지한다. 새 연결 자체는 반드시 남기고,
    // 나머지 중 생성 시각이 가장 최근인 두 세션만 보존한다.
    env.DB.prepare(
      'UPDATE tokens SET revoked=1 ' +
      'WHERE app=? AND staff_id=? AND revoked=0 AND token<>? AND token NOT IN (' +
      'SELECT token FROM tokens WHERE app=? AND staff_id=? AND revoked=0 AND token<>? ' +
      'ORDER BY created_at DESC, token DESC LIMIT ' + (MAX_ACTIVE_PERSON_SESSIONS - 1) + ') AND EXISTS (' +
      'SELECT 1 FROM bootstrap_codes WHERE app=? AND code_hash=? AND staff_id=? AND consumed_at=?)'
    ).bind(app, staffId, storedHash, app, staffId, storedHash, app, codeHash, staffId, consumeMarker),
    env.DB.prepare(
      'UPDATE bootstrap_codes SET consumed_at=? WHERE app=? AND code_hash=? AND staff_id=? AND consumed_at=?'
    ).bind(consumedAt, app, codeHash, staffId, consumeMarker)
  ]);
  const changed = index => Number(results[index] && results[index].meta && results[index].meta.changes || 0);
  if (changed(0) !== 1 || changed(1) !== 1 || changed(4) !== 1) {
    const row = await env.DB.prepare(
      'SELECT consumed_at,revoked,expires_at FROM bootstrap_codes ' +
      'WHERE app=? AND code_hash=? AND staff_id=? LIMIT 1'
    ).bind(app, codeHash, staffId).first();
    if (!row) return json({ ok: false, code: 'LINK_INVALID', error: '올바르지 않은 개인 링크입니다' }, 410, origin);
    if (row.consumed_at !== null && row.consumed_at !== undefined) {
      return json({ ok: false, code: 'LINK_USED', error: '이미 사용한 개인 링크입니다' }, 410, origin);
    }
    if (Number(row.expires_at) < consumedAt) {
      return json({ ok: false, code: 'LINK_EXPIRED', error: '사용 시간이 지난 개인 링크입니다' }, 410, origin);
    }
    if (Number(row.revoked)) {
      return json({ ok: false, code: 'LINK_REPLACED', error: '더 최근에 발급된 링크를 사용해 주세요' }, 410, origin);
    }
    return json({ ok: false, code: 'LINK_USED', error: '다른 화면에서 먼저 사용된 개인 링크입니다' }, 409, origin);
  }
  return json({ ok: true, token, expiresAt: consumedAt + TOKEN_TTL_MS,
    activeSessionLimit: MAX_ACTIVE_PERSON_SESSIONS }, 200, origin);
}

async function handleHandoff(env, app, body, origin) {
  const auth = await resolveAuth(env, app, body.auth);
  if (!auth || auth.scope !== 'own' || !SAFE_ID.test(auth.id)) {
    return json({ ok: false, code: 'AUTH_REQUIRED', error: '개인 인증이 필요합니다' }, 401, origin);
  }
  const issued = await issueBootstrap(env, app, auth.id, HANDOFF_TTL_MS);
  return json({ ok: true, code: issued.code, expiresAt: issued.expiresAt }, 200, origin);
}

async function handleRevoke(env, app, body, origin) {
  const auth = await resolveAuth(env, app, body.auth);
  if (!auth || auth.scope !== 'all') return json({ ok: false, error: '원장만 해지할 수 있습니다' }, 401, origin);
  const staffId = String(body.staffId || '');
  if (staffId) {
    if (!SAFE_ID.test(staffId)) return json({ ok: false, error: '올바른 staffId 필요' }, 400, origin);
    await env.DB.batch([
      env.DB.prepare('UPDATE tokens SET revoked=1 WHERE app=? AND staff_id=?').bind(app, staffId),
      env.DB.prepare('UPDATE bootstrap_codes SET revoked=1 WHERE app=? AND staff_id=?').bind(app, staffId)
    ]);
  } else {
    await env.DB.prepare('UPDATE tokens SET revoked=1 WHERE app=? AND token=?')
      .bind(app, String(body.token || '')).run();
  }
  return json({ ok: true }, 200, origin);
}


/* ══════════════════════════════════════════════════════
   학부모 피드백 문구 검토 + 실제 발송
   여기서는 직원의 문구 요청과 원장의 문구 승인만 기록한다. "문구 승인"
   (content_approved_send_blocked)과 "실제 발송"(sent)은 항상 별개의 명시적
   동작이다 — 실제 발송은 parent-feedback-send.js가 담당하고, 원장만 누를 수 있다.
   ══════════════════════════════════════════════════════ */
const FEEDBACK_STATUSES = new Set([
  'approval_waiting',
  'content_approved_send_blocked',
  'sent',
  'revision_requested',
  'cancelled'
]);
const SAFE_FEEDBACK_PART = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_FEEDBACK_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_FEEDBACK_BODY = 5000;
const MAX_REVIEW_NOTE = 1000;

function validIsoDate(value) {
  const text = String(value || '');
  if (!SAFE_FEEDBACK_DATE.test(text)) return false;
  const date = new Date(text + 'T00:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function normalizeFeedbackBody(value) {
  return String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim();
}

function feedbackIdentity(body) {
  const taskId = String(body.taskId || '');
  const feedbackDate = String(body.feedbackDate || '');
  const feedbackType = String(body.feedbackType || 'class_feedback');
  const templateVersion = String(body.templateVersion || 'v1');
  if (!SAFE_ID.test(taskId)) return { error: '올바른 taskId가 필요합니다' };
  if (!validIsoDate(feedbackDate)) return { error: 'feedbackDate는 YYYY-MM-DD 형식이어야 합니다' };
  if (!SAFE_FEEDBACK_PART.test(feedbackType)) return { error: '올바른 feedbackType이 필요합니다' };
  if (!SAFE_FEEDBACK_PART.test(templateVersion)) return { error: '올바른 templateVersion이 필요합니다' };
  return { taskId, feedbackDate, feedbackType, templateVersion };
}

async function feedbackRequestKey(identity) {
  const raw = [identity.taskId, identity.feedbackDate, identity.feedbackType, identity.templateVersion].join('\u001f');
  return 'fbr_' + (await sha256Hex(raw)).slice(0, 48);
}

function feedbackView(row) {
  if (!row) return null;
  return {
    requestKey: row.request_key,
    taskId: row.task_id,
    owner: row.owner,
    feedbackDate: row.feedback_date,
    feedbackType: row.feedback_type,
    templateVersion: row.template_version,
    message: row.body,
    bodyHash: row.body_hash,
    revision: Number(row.revision),
    status: row.status,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    reviewedAt: row.reviewed_at == null ? null : Number(row.reviewed_at),
    reviewNote: row.review_note == null ? '' : String(row.review_note)
  };
}

async function taskForFeedback(env, identity, auth, origin) {
  const task = await env.DB.prepare('SELECT owner, data FROM tasks WHERE app=? AND id=? LIMIT 1')
    .bind('task', identity.taskId).first();
  if (!task) return { response: json({ ok: false, error: '업무를 찾을 수 없습니다' }, 404, origin) };
  if (!task.owner || !SAFE_ID.test(String(task.owner))) {
    return { response: json({ ok: false, error: '담당자가 지정된 업무만 요청할 수 있습니다' }, 409, origin) };
  }
  if (auth.scope === 'own' && task.owner !== auth.id) {
    return { response: json({ ok: false, error: '본인 업무의 피드백만 요청할 수 있습니다' }, 403, origin) };
  }
  try {
    if (JSON.parse(task.data || '{}').deleted) {
      return { response: json({ ok: false, error: '삭제된 업무에는 요청할 수 없습니다' }, 409, origin) };
    }
  } catch (error) {
    return { response: json({ ok: false, error: '업무 데이터가 올바르지 않습니다' }, 409, origin) };
  }
  return { task };
}

async function findFeedbackRequest(env, identity) {
  return await env.DB.prepare(
    'SELECT * FROM feedback_requests WHERE app=? AND task_id=? AND feedback_date=? ' +
    'AND feedback_type=? AND template_version=? LIMIT 1'
  ).bind('task', identity.taskId, identity.feedbackDate, identity.feedbackType, identity.templateVersion).first();
}

async function handleFeedbackRequest(env, app, body, origin) {
  if (app !== 'task') return json({ ok: false, error: '학부모 피드백은 task 앱에서만 사용할 수 있습니다' }, 400, origin);
  const auth = await resolveAuth(env, app, body.auth);
  if (!auth) return json({ ok: false, error: '인증 실패' }, 401, origin);

  const action = String(body.action || 'submit');
  if (action !== 'submit' && action !== 'cancel' && action !== 'list') {
    return json({ ok: false, error: 'action은 submit, cancel 또는 list여야 합니다' }, 400, origin);
  }
  if (action === 'list') {
    if (auth.scope !== 'own') {
      return json({ ok: false, error: '직원 본인의 피드백 요청만 확인할 수 있습니다' }, 403, origin);
    }
    const limit = Math.max(1, Math.min(200, Number(body.limit) || 100));
    const result = await env.DB.prepare(
      "SELECT * FROM feedback_requests WHERE app=? AND owner=? ORDER BY CASE status " +
      "WHEN 'revision_requested' THEN 0 WHEN 'approval_waiting' THEN 1 " +
      "WHEN 'content_approved_send_blocked' THEN 2 WHEN 'sent' THEN 3 WHEN 'cancelled' THEN 4 ELSE 5 END, updated_at DESC LIMIT " + limit
    ).bind('task', auth.id).all();
    return json({ ok: true, requests: (result.results || []).map(feedbackView) }, 200, origin);
  }
  const identity = feedbackIdentity(body);
  if (identity.error) return json({ ok: false, error: identity.error }, 400, origin);
  const checked = await taskForFeedback(env, identity, auth, origin);
  if (checked.response) return checked.response;

  const owner = String(checked.task.owner);
  const now = Date.now();
  let current = await findFeedbackRequest(env, identity);

  if (action === 'cancel') {
    if (!current) return json({ ok: false, error: '취소할 피드백 요청을 찾을 수 없습니다' }, 404, origin);
    if (current.status === 'cancelled') {
      return json({ ok: true, idempotent: true, request: feedbackView(current) }, 200, origin);
    }
    const result = await env.DB.prepare(
      "UPDATE feedback_requests SET owner=?, status='cancelled', revision=revision+1, updated_at=?, " +
      'reviewed_at=NULL, reviewed_by=NULL, review_note=NULL WHERE app=? AND request_key=? AND revision=?'
    ).bind(owner, now, 'task', current.request_key, Number(current.revision)).run();
    if (Number(result && result.meta && result.meta.changes || 0) !== 1) {
      return json({ ok: false, error: '다른 변경이 먼저 저장되었습니다. 새로고침 후 다시 시도해 주세요' }, 409, origin);
    }
    current = await env.DB.prepare('SELECT * FROM feedback_requests WHERE app=? AND request_key=? LIMIT 1')
      .bind('task', current.request_key).first();
    return json({ ok: true, idempotent: false, request: feedbackView(current) }, 200, origin);
  }

  const message = normalizeFeedbackBody(body.message);
  if (!message) return json({ ok: false, error: '피드백 문구를 입력해 주세요' }, 400, origin);
  if (message.length > MAX_FEEDBACK_BODY) {
    return json({ ok: false, error: '피드백 문구는 ' + MAX_FEEDBACK_BODY + '자까지 입력할 수 있습니다' }, 413, origin);
  }
  const bodyHash = await sha256Hex(message);
  const requestKey = await feedbackRequestKey(identity);

  if (!current) {
    const insertResult = await env.DB.prepare(
      'INSERT OR IGNORE INTO feedback_requests ' +
      '(app,request_key,task_id,owner,feedback_date,feedback_type,template_version,body,body_hash,revision,status,created_at,updated_at,reviewed_at,reviewed_by,review_note) ' +
      "VALUES (?,?,?,?,?,?,?,?,?,1,'approval_waiting',?,?,NULL,NULL,NULL)"
    ).bind('task', requestKey, identity.taskId, owner, identity.feedbackDate, identity.feedbackType,
      identity.templateVersion, message, bodyHash, now, now).run();
    current = await findFeedbackRequest(env, identity);
    if (!current) return json({ ok: false, error: '피드백 요청을 저장하지 못했습니다' }, 500, origin);
    if (current.body_hash === bodyHash && current.body === message) {
      return json({ ok: true, idempotent: Number(insertResult && insertResult.meta && insertResult.meta.changes || 0) !== 1, request: feedbackView(current) }, 200, origin);
    }
  }

  if (current.body_hash === bodyHash && current.body === message && current.status === 'revision_requested') {
    return json({
      ok: false,
      code: 'REVISION_UNCHANGED',
      error: '수정 요청을 반영해 문구를 변경한 뒤 다시 제출해 주세요',
      request: feedbackView(current)
    }, 409, origin);
  }

  if (current.body_hash === bodyHash && current.body === message && current.status !== 'cancelled') {
    return json({ ok: true, idempotent: true, request: feedbackView(current) }, 200, origin);
  }

  const result = await env.DB.prepare(
    "UPDATE feedback_requests SET owner=?, body=?, body_hash=?, revision=revision+1, status='approval_waiting', " +
    'updated_at=?, reviewed_at=NULL, reviewed_by=NULL, review_note=NULL ' +
    'WHERE app=? AND request_key=? AND revision=?'
  ).bind(owner, message, bodyHash, now, 'task', current.request_key, Number(current.revision)).run();
  if (Number(result && result.meta && result.meta.changes || 0) !== 1) {
    return json({ ok: false, error: '다른 변경이 먼저 저장되었습니다. 새로고침 후 다시 시도해 주세요' }, 409, origin);
  }
  current = await env.DB.prepare('SELECT * FROM feedback_requests WHERE app=? AND request_key=? LIMIT 1')
    .bind('task', current.request_key).first();
  return json({ ok: true, idempotent: false, request: feedbackView(current) }, 200, origin);
}

async function handleFeedbackReview(env, app, body, origin) {
  if (app !== 'task') return json({ ok: false, error: '학부모 피드백은 task 앱에서만 사용할 수 있습니다' }, 400, origin);
  const auth = await resolveAuth(env, app, body.auth);
  if (!auth) return json({ ok: false, error: '인증 실패' }, 401, origin);
  if (auth.scope !== 'all') return json({ ok: false, error: '원장만 피드백 문구를 검토할 수 있습니다' }, 403, origin);

  const action = String(body.action || 'list');
  if (action === 'list') {
    const clauses = ['app=?'];
    const binds = ['task'];
    if (body.status != null && body.status !== '') {
      const status = String(body.status);
      if (!FEEDBACK_STATUSES.has(status)) return json({ ok: false, error: '올바른 status가 필요합니다' }, 400, origin);
      clauses.push('status=?'); binds.push(status);
    }
    if (body.owner != null && body.owner !== '') {
      const owner = String(body.owner);
      if (!SAFE_ID.test(owner)) return json({ ok: false, error: '올바른 owner가 필요합니다' }, 400, origin);
      clauses.push('owner=?'); binds.push(owner);
    }
    if (body.feedbackDate != null && body.feedbackDate !== '') {
      const feedbackDate = String(body.feedbackDate);
      if (!validIsoDate(feedbackDate)) return json({ ok: false, error: 'feedbackDate는 YYYY-MM-DD 형식이어야 합니다' }, 400, origin);
      clauses.push('feedback_date=?'); binds.push(feedbackDate);
    }
    const limit = Math.max(1, Math.min(200, Number(body.limit) || 100));
    const statement = env.DB.prepare(
      'SELECT * FROM feedback_requests WHERE ' + clauses.join(' AND ') +
      " ORDER BY CASE status WHEN 'approval_waiting' THEN 0 WHEN 'revision_requested' THEN 1 " +
      "WHEN 'content_approved_send_blocked' THEN 2 WHEN 'sent' THEN 3 WHEN 'cancelled' THEN 4 ELSE 5 END, updated_at DESC LIMIT " + limit
    ).bind(...binds);
    const result = await statement.all();
    return json({ ok: true, requests: (result.results || []).map(feedbackView) }, 200, origin);
  }

  if (action !== 'approve_content' && action !== 'request_revision') {
    return json({ ok: false, error: 'action은 list, approve_content 또는 request_revision이어야 합니다' }, 400, origin);
  }
  const requestKey = String(body.requestKey || '');
  const expectedRevision = Number(body.revision);
  if (!SAFE_ID.test(requestKey) || !requestKey.startsWith('fbr_')) {
    return json({ ok: false, error: '올바른 requestKey가 필요합니다' }, 400, origin);
  }
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    return json({ ok: false, error: '현재 revision이 필요합니다' }, 400, origin);
  }
  let current = await env.DB.prepare('SELECT * FROM feedback_requests WHERE app=? AND request_key=? LIMIT 1')
    .bind('task', requestKey).first();
  if (!current) return json({ ok: false, error: '피드백 요청을 찾을 수 없습니다' }, 404, origin);
  if (Number(current.revision) !== expectedRevision) {
    return json({ ok: false, error: '문구가 변경되었습니다. 새로고침 후 다시 검토해 주세요' }, 409, origin);
  }
  if (current.status === 'cancelled') return json({ ok: false, error: '취소된 요청은 검토할 수 없습니다' }, 409, origin);

  const now = Date.now();
  if (action === 'approve_content') {
    if (current.status === 'content_approved_send_blocked') {
      return json({ ok: true, idempotent: true, request: feedbackView(current) }, 200, origin);
    }
    if (current.status !== 'approval_waiting') {
      return json({ ok: false, error: '수정된 문구가 다시 제출된 뒤 승인할 수 있습니다' }, 409, origin);
    }
    const result = await env.DB.prepare(
      "UPDATE feedback_requests SET status='content_approved_send_blocked', updated_at=?, reviewed_at=?, " +
      "reviewed_by='director', review_note=NULL WHERE app=? AND request_key=? AND revision=? AND status='approval_waiting'"
    ).bind(now, now, 'task', requestKey, expectedRevision).run();
    if (Number(result && result.meta && result.meta.changes || 0) !== 1) {
      return json({ ok: false, error: '다른 변경이 먼저 저장되었습니다. 새로고침 후 다시 검토해 주세요' }, 409, origin);
    }
  } else {
    const note = normalizeFeedbackBody(body.note);
    if (!note) return json({ ok: false, error: '수정 요청 내용을 입력해 주세요' }, 400, origin);
    if (note.length > MAX_REVIEW_NOTE) return json({ ok: false, error: '수정 요청은 ' + MAX_REVIEW_NOTE + '자까지 입력할 수 있습니다' }, 413, origin);
    if (current.status === 'revision_requested' && String(current.review_note || '') === note) {
      return json({ ok: true, idempotent: true, request: feedbackView(current) }, 200, origin);
    }
    const result = await env.DB.prepare(
      "UPDATE feedback_requests SET status='revision_requested', updated_at=?, reviewed_at=?, " +
      "reviewed_by='director', review_note=? WHERE app=? AND request_key=? AND revision=? AND status<>'cancelled'"
    ).bind(now, now, note, 'task', requestKey, expectedRevision).run();
    if (Number(result && result.meta && result.meta.changes || 0) !== 1) {
      return json({ ok: false, error: '다른 변경이 먼저 저장되었습니다. 새로고침 후 다시 검토해 주세요' }, 409, origin);
    }
  }
  current = await env.DB.prepare('SELECT * FROM feedback_requests WHERE app=? AND request_key=? LIMIT 1')
    .bind('task', requestKey).first();
  return json({ ok: true, idempotent: false, request: feedbackView(current) }, 200, origin);
}


/* ══════════════════════════════════════════════════════
   인강 커리큘럼 자동 가져오기
   앱은 정적 페이지라 외부 사이트를 직접 못 읽는다(CORS). 워커가 대신 가져와 파싱한다.
   · /search      네이버 검색으로 강좌 페이지 주소를 찾는다
   · /curriculum  그 주소에서 목차(회차·제목·시간)를 뽑는다
   파서는 사이트별 선택자가 아니라 "회차 번호 + 시간 표기" 패턴 기반이라
   사이트가 개편돼도 잘 버틴다. 다만 자바스크립트로 목록을 그리는 페이지는
   여기서도 못 잡으므로, 그 경우 목차 붙여넣기로 안내한다.
   ══════════════════════════════════════════════════════ */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const SEARCH_DOMAINS = {
  '엘리하이': 'mbest.co.kr', '엠베스트': 'mbest.co.kr', '메가스터디': 'megastudy.net',
  '이투스': 'etoos.com', '대성마이맥': 'mimacstudy.com'
};

/** 내부망·로컬 주소로 워커를 대신 찔러보게 하는 것을 막는다 */
function publicUrlOrNull(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return null;
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(h)) {
    const p = h.split('.').map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0 ||
        (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
        (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254)) return null;
  }
  if (h === '[::1]' || h.startsWith('[fc') || h.startsWith('[fd')) return null;
  return u.toString();
}

/** 한국 강의 사이트는 아직 euc-kr을 쓰는 곳이 있어 인코딩을 판별해 읽는다 */
async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ko,en;q=0.8' } });
  if (!res.ok) throw new Error('페이지를 가져오지 못했습니다 (HTTP ' + res.status + ')');
  const buf = await res.arrayBuffer();
  const dec = enc => { try { return new TextDecoder(enc).decode(buf); } catch (e) { return null; } };
  const m = (res.headers.get('content-type') || '').match(/charset=["\']?([\w-]+)/i);
  if (m) { const t = dec(m[1]); if (t) return t; }
  const utf = dec('utf-8') || '';
  if ((utf.match(/\uFFFD/g) || []).length > 5) { const t = dec('euc-kr'); if (t) return t; }
  return utf;
}

const TAGRE = /<[^>]+>/g;
function unesc(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(Number(d)); })
    .replace(/&amp;/g, '&');
}
/** 커리큘럼 행 판별 — "12:34" 같은 시간 표기 또는 "3강"으로 시작하는 줄 */
const LEC_LINE = /\d{1,2}:\d{2}|^\d{1,3}\s*강[\s.]/;

function extractCurriculum(html) {
  html = String(html).replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const lines = [];
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const cells = row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || [];
    let text = cells.map(function (c) { return c.replace(TAGRE, ' '); }).join(' ');
    text = unesc(text.replace(/\s+/g, ' ')).trim();
    if (text && LEC_LINE.test(text)) lines.push(text);
  }
  if (!lines.length) {
    // 표가 아닌 페이지 — 시간 표기가 있는 줄만 건진다
    html.replace(TAGRE, '\n').split('\n').forEach(function (ln) {
      ln = unesc(ln.replace(/\s+/g, ' ')).trim();
      if (ln.length > 6 && /\d{1,2}:\d{2}/.test(ln)) lines.push(ln);
    });
  }
  return lines.join('\n');
}

async function handleSearch(env, app, body, origin) {
  const auth = await resolveAuth(env, app, body.auth);
  if (!auth) return json({ ok: false, error: '인증 실패' }, 401, origin);
  if (!env.NAVER_ID || !env.NAVER_SECRET) {
    return json({ ok: false, error: '네이버 검색 키가 설정되지 않았습니다' }, 400, origin);
  }
  const q = String(body.q || '').trim();
  if (!q) return json({ ok: false, error: '검색어를 입력해 주세요' }, 400, origin);
  const platform = String(body.platform || '');
  const dom = SEARCH_DOMAINS[platform];
  const query = (dom ? platform + ' ' : '') + q + ' 강좌';

  const res = await fetch(
    'https://openapi.naver.com/v1/search/webkr.json?display=20&query=' + encodeURIComponent(query),
    { headers: { 'X-Naver-Client-Id': env.NAVER_ID, 'X-Naver-Client-Secret': env.NAVER_SECRET } });
  if (!res.ok) return json({ ok: false, error: '네이버 검색 실패 (HTTP ' + res.status + ')' }, 502, origin);
  const d = await res.json();

  const out = [];
  for (const it of (d.items || [])) {
    const link = it.link || '';
    if (!/^https?:\/\//i.test(link)) continue;
    if (dom && link.indexOf(dom) < 0) continue;      // 고른 플랫폼 도메인만 남긴다
    out.push({
      title: unesc(String(it.title || '').replace(TAGRE, '')).replace(/\s+/g, ' ').trim(),
      url: link,
      desc: unesc(String(it.description || '').replace(TAGRE, '')).replace(/\s+/g, ' ').trim().slice(0, 120)
    });
  }
  // 강좌 상세 페이지일 가능성이 큰 주소를 위로
  out.sort(function (a, b) {
    const A = /detail|chr_cd|lecture/i.test(a.url) ? 0 : 1;
    const B = /detail|chr_cd|lecture/i.test(b.url) ? 0 : 1;
    return A - B;
  });
  return json({ ok: true, items: out.slice(0, 8) }, 200, origin);
}

async function handleCurriculum(env, app, body, origin) {
  const auth = await resolveAuth(env, app, body.auth);
  if (!auth) return json({ ok: false, error: '인증 실패' }, 401, origin);
  const url = publicUrlOrNull(body.url);
  if (!url) return json({ ok: false, error: '주소가 올바르지 않습니다' }, 400, origin);
  let html;
  try { html = await fetchPage(url); }
  catch (e) { return json({ ok: false, error: String(e && e.message || e) }, 502, origin); }
  const text = extractCurriculum(html);
  if (!text) {
    return json({ ok: true, text: '', count: 0,
      hint: '강의 목록을 찾지 못했습니다. 로그인이 필요하거나 자바스크립트로 그려지는 페이지일 수 있어요 — 사이트에서 목차를 복사해 붙여넣어 주세요.' }, 200, origin);
  }
  return json({ ok: true, text: text, count: text.split('\n').length }, 200, origin);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOW_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
    const okOrigin = !allowed.length || allowed.includes(origin) ? (origin || '*') : null;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(okOrigin || 'null') });
    }
    if (url.pathname === '/health') {
      return json({ ok: true, now: Date.now() }, 200, okOrigin);
    }
    if (request.method !== 'POST') return json({ ok: false, error: 'POST만 허용' }, 405, okOrigin);
    if (okOrigin === null) return json({ ok: false, error: '허용되지 않은 출처' }, 403, '*');

    let body;
    try { body = await request.json(); }
    catch (e) { return json({ ok: false, error: '본문을 읽을 수 없습니다' }, 400, okOrigin); }

    const app = String(body.app || '');
    if (!APPS.includes(app)) return json({ ok: false, error: 'app은 task 또는 consult' }, 400, okOrigin);

    try {
      if (url.pathname === '/sync')   return await handleSync(env, app, body, okOrigin);
      if (url.pathname === '/token')  return await handleToken(env, app, body, okOrigin);
      if (url.pathname === '/bootstrap') return await handleBootstrap(env, app, body, okOrigin);
      if (url.pathname === '/exchange') return await handleExchange(env, app, body, okOrigin);
      if (url.pathname === '/handoff') return await handleHandoff(env, app, body, okOrigin);
      if (url.pathname === '/revoke') return await handleRevoke(env, app, body, okOrigin);
      if (url.pathname === '/lesson-create') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleLessonCreate(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/feedback-request') return await handleFeedbackRequest(env, app, body, okOrigin);
      if (url.pathname === '/feedback-review') return await handleFeedbackReview(env, app, body, okOrigin);
      if (url.pathname === '/parent-feedback-send') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleParentFeedbackSend(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/guardian-contact') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleGuardianContact(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/lesson-change-request') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleLessonChangeRequest(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/lesson-change-review') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleLessonChangeReview(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/director-report-send') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleDirectorReportSend(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/book-order-send') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleBookOrderSend(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/book-add-request') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleBookAddRequest(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/book-add-review') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleBookAddReview(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/book-edit-request') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleBookEditRequest(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/book-edit-review') {
        const auth = await resolveAuth(env, app, body.auth);
        if (!auth) return json({ ok: false, error: '인증 실패' }, 401, okOrigin);
        return await handleBookEditReview(env, app, body, okOrigin, auth, json);
      }
      if (url.pathname === '/search') return await handleSearch(env, app, body, okOrigin);
      if (url.pathname === '/curriculum') return await handleCurriculum(env, app, body, okOrigin);
      return json({ ok: false, error: '없는 경로' }, 404, okOrigin);
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, 500, okOrigin);
    }
  }
};
