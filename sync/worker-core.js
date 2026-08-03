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
 *   POST /revoke    { app, auth(admin), token|staffId } → { ok }
 *   POST /private-asset { app, auth, key }         → { ok, data }    인증 운영 자료
 *   POST /admin-recover  { app, auth(admin) }      → { ok, token }   비상키 1회 입력으로 원장 세션 전환
 *   POST /admin-exchange { app, code }             → { ok, token }   원장 1회 교환
 *   POST /admin-handoff  { app, auth(admin_session) } → { ok, code } 새 브라우저 이동
 *   POST /admin-revoke   { app, auth(admin_session) } → { ok }       현재 원장 세션 해지
 *
 * 인증
 *   auth = { mode:'admin',  secret }            → 전체 접근
 *   auth = { mode:'admin_session', token }      → task 전체 접근(24시간)
 *   auth = { mode:'person', id, token }         → 본인 것만
 */

const APPS = ['task', 'consult'];
const MAX_CHANGES = 500;     // 요청당 상한 — D1 배치 한계와 악의적 대량 전송을 함께 막는다
const MAX_PULL = 2000;       // 응답당 상한. 초과하면 more:true로 알리고 다음 요청에서 이어받는다
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN_HASH_PREFIX = 'sha256:';
const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000;
const HANDOFF_TTL_MS = 10 * 60 * 1000;
const ADMIN_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const ADMIN_BOOTSTRAP_TTL_MS = 10 * 60 * 1000;
const ADMIN_CODE_HASH_PREFIX = 'admin-code-sha256:';
const ADMIN_TOKEN_HASH_PREFIX = 'admin-token-sha256:';
const SAFE_BOOTSTRAP_CODE = /^[a-f0-9]{48}$/i;
const PRIVATE_ASSET_KEYS = ['roster', 'textbooks'];
const SYNC_TABLES = [
  { name: 'staff', rank: 0, key: 'id' },
  { name: 'tasks', rank: 1, key: 'id' },
  { name: 'checks', rank: 2, key: 'k' }
];

/**
 * srv_at 하나만으로 페이지를 넘기면 같은 시각의 행 또는 다른 테이블의 오래된
 * 잔여 행을 건너뛸 수 있다. 모든 동기화 행의 위치를 (srv_at, table_rank, key)
 * 세 값으로 고정해 다음 페이지가 정확히 그 다음 행에서 시작하게 한다.
 *
 * cursor가 없는 구형 클라이언트는 since를 첫 위치로 승격한다. table_rank=-1은
 * 그 시각의 모든 테이블을 다시 포함하므로 배포 전후 경계에서도 누락보다 안전한
 * 중복 수신을 택한다. 클라이언트의 LWW 적용은 같은 행의 중복을 무해하게 처리한다.
 */
export function normalizeSyncCursor(body) {
  const raw = body && body.cursor;
  if (raw === undefined || raw === null) {
    const legacy = Number(body && body.since);
    const srvAt = Number.isSafeInteger(legacy) && legacy >= 0 ? legacy : 0;
    return { srv_at: srvAt, table_rank: -1, key: '' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const srvAt = Number(raw.srv_at);
  const tableRank = Number(raw.table_rank);
  const key = String(raw.key || '');
  if (!Number.isSafeInteger(srvAt) || srvAt < 0 ||
      !Number.isInteger(tableRank) || tableRank < -1 || tableRank >= SYNC_TABLES.length ||
      key.length > 512 || (tableRank === -1 && key !== '')) return null;
  return { srv_at: srvAt, table_rank: tableRank, key };
}

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
function adminCodeStorageValue(digest) {
  return ADMIN_CODE_HASH_PREFIX + String(digest || '').toLowerCase();
}

function adminTokenStorageValue(digest) {
  return ADMIN_TOKEN_HASH_PREFIX + String(digest || '').toLowerCase();
}


function randomOpaqueValue() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function resolveAuth(env, app, auth) {
  if (!auth || typeof auth !== 'object') return null;
  if (auth.mode === 'admin') {
    const want = app === 'task' ? env.TASK_ADMIN_SECRET : env.CONSULT_ADMIN_SECRET;
    if (!want || !safeEqual(auth.secret, want)) return null;
    return { scope: 'all', kind: 'root_secret' };
  }
  if (auth.mode === 'admin_session') {
    if (app !== 'task') return null;
    const token = String(auth.token || '');
    if (!SAFE_BOOTSTRAP_CODE.test(token)) return null;
    const tokenHash = adminTokenStorageValue(await sha256Hex(token));
    const row = await env.DB.prepare(
      'SELECT token_hash FROM admin_sessions WHERE app=? AND token_hash=? AND revoked=0 AND expires_at>=? LIMIT 1'
    ).bind(app, tokenHash, Date.now()).first();
    if (!row) return null;
    return { scope: 'all', kind: 'admin_session' };
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
    if (!row || row.staff_id !== id) return null;
    // 개인 링크는 manager 플래그와 무관하게 항상 본인 범위다. 전체 관리는 원장 로그인만 사용한다.
    return { scope: 'own', id: id, kind: 'person' };
  }
  return null;
}


function normalizePersonName(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function teacherIncludes(raw, staffName) {
  const target = normalizePersonName(staffName);
  return String(raw || '').split(/[·,\/]/).map(normalizePersonName).filter(Boolean).includes(target);
}

export function filterPrivateAsset(key, data, staffName) {
  if (!data || typeof data !== 'object') return null;
  if (!staffName) return data;
  const students = (Array.isArray(data.students) ? data.students : []).filter(student =>
    teacherIncludes(student && student.teacher, staffName));
  if (key === 'roster') {
    return {
      updated: String(data.updated || ''),
      baseline: String(data.baseline || ''),
      note: String(data.note || ''),
      students
    };
  }
  if (key === 'textbooks') {
    return {
      updated: String(data.updated || ''),
      note: String(data.note || ''),
      vendors: Array.isArray(data.vendors) ? data.vendors : [],
      books: Array.isArray(data.books) ? data.books : [],
      students
    };
  }
  return null;
}

async function handlePrivateAsset(env, app, body, origin) {
  const auth = await resolveAuth(env, app, body.auth);
  if (!auth) return json({ ok: false, error: '인증 실패' }, 401, origin);
  if (app !== 'task') return json({ ok: false, error: '직원 앱 전용 자료입니다' }, 404, origin);
  const key = String(body.key || '');
  if (!PRIVATE_ASSET_KEYS.includes(key)) return json({ ok: false, error: '허용되지 않은 자료입니다' }, 400, origin);
  const row = await env.DB.prepare(
    'SELECT data,updated_at,content_hash FROM private_assets WHERE app=? AND asset_key=? LIMIT 1'
  ).bind(app, key).first();
  if (!row) return json({ ok: false, error: '자료가 아직 준비되지 않았습니다' }, 404, origin);
  let data;
  try { data = JSON.parse(row.data); }
  catch (error) { return json({ ok: false, error: '자료 형식이 올바르지 않습니다' }, 500, origin); }
  if (auth.scope === 'own') {
    const staffResult = await env.DB.prepare('SELECT id,data FROM staff WHERE app=?').bind(app).all();
    const active = [];
    for (const row of (staffResult.results || [])) {
      try {
        const parsed = JSON.parse(row.data);
        const name = normalizePersonName(parsed && parsed.name);
        if (parsed && !parsed.deleted && name) active.push({ id: String(row.id), name });
      } catch (error) {
        // 손상된 다른 직원 행은 권한 판정에 사용하지 않는다. 본인 행이면 아래에서 fail-closed 된다.
      }
    }
    const staff = active.find(item => item.id === auth.id);
    if (!staff) {
      return json({ ok: false, error: '담당 직원을 확인할 수 없습니다' }, 403, origin);
    }
    const sameName = active.filter(item => item.name === staff.name);
    if (sameName.length !== 1) {
      return json({ ok: false, error: '동명이인 직원은 고유 ID 연결 후 이용할 수 있습니다' }, 409, origin);
    }
    data = filterPrivateAsset(key, data, staff.name);
    if (!data) return json({ ok: false, error: '자료 형식이 올바르지 않습니다' }, 500, origin);
  }
  return json({ ok: true, key: key, updatedAt: row.updated_at, hash: row.content_hash, data: data }, 200, origin);
}
/** 들어온 변경을 테이블별 upsert 문으로. updated_at이 더 최신일 때만 덮는다 (LWW) */
function upsertStmt(env, table, app, c, now) {
  const idCol = table === 'checks' ? 'k' : 'id';
  const key = table === 'checks' ? c.k : c.id;
  return env.DB.prepare(
    'INSERT INTO ' + table + ' (app, ' + idCol + ', owner, data, updated_at, srv_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(app, ' + idCol + ') DO UPDATE SET ' +
    '  owner=excluded.owner, data=excluded.data, ' +
    '  updated_at=excluded.updated_at, srv_at=excluded.srv_at ' +
    'WHERE excluded.updated_at > ' + table + '.updated_at'
  ).bind(app, key, c.owner || null, JSON.stringify(c.data), Number(c.updated_at) || 0, now);
}

async function handleSync(env, app, body, origin) {
  const auth = await resolveAuth(env, app, body.auth);
  if (!auth) return json({ ok: false, error: '인증 실패' }, 401, origin);

  const cursor = normalizeSyncCursor(body);
  if (!cursor) return json({ ok: false, error: '동기화 커서 형식이 올바르지 않습니다' }, 400, origin);
  const now = Date.now();
  const changes = Array.isArray(body.changes) ? body.changes : [];
  if (changes.length > MAX_CHANGES) {
    return json({ ok: false, error: '한 번에 보낼 수 있는 변경은 ' + MAX_CHANGES + '건까지입니다' }, 413, origin);
  }

  // ── 올리기
  const stmts = [];
  let forbidden = false;
  for (const c of changes) {
    if (!c || !c.table || !APPS.includes(app)) continue;
    const t = c.table;
    if (t !== 'staff' && t !== 'tasks' && t !== 'checks') continue;
    if (!(t === 'checks' ? c.k : c.id)) continue;
    // 개인 접속은 자기 것만 쓸 수 있다. 남의 owner를 붙여 보내도 서버에서 막는다.
    if (auth.scope === 'own') {
      if ((t === 'staff' && c.id !== auth.id) || (t !== 'staff' && c.owner !== auth.id)) {
        forbidden = true;
        break;
      }
    }
    stmts.push(upsertStmt(env, t, app, c, now));
  }
  if (forbidden) return json({ ok: false, error: '개인 링크에서는 본인 업무만 저장할 수 있습니다' }, 403, origin);
  if (stmts.length) await env.DB.batch(stmts);

  // ── 내려받기: 세 테이블을 하나의 정렬된 스트림으로 만든 뒤 응답 전체에
  // MAX_PULL을 적용한다. 테이블마다 LIMIT을 적용한 뒤 전역 since를 올리면 다른
  // 테이블의 오래된 잔여 행이 영구히 누락될 수 있다.
  const params = [];
  const selects = SYNC_TABLES.map(spec => {
    params.push(app);
    if (auth.scope === 'own') params.push(auth.id);
    return "SELECT '" + spec.name + "' AS table_name, " + spec.rank + ' AS table_rank, ' +
      spec.key + ' AS row_key, owner, data, updated_at, srv_at FROM ' + spec.name +
      ' WHERE app=?' + (auth.scope === 'own' ? ' AND owner=?' : '');
  });
  const sql = 'SELECT table_name,table_rank,row_key,owner,data,updated_at,srv_at FROM (' +
    selects.join(' UNION ALL ') + ') AS sync_rows WHERE ' +
    '(srv_at > ? OR (srv_at = ? AND (table_rank > ? OR (table_rank = ? AND row_key > ?)))) ' +
    'ORDER BY srv_at ASC, table_rank ASC, row_key ASC LIMIT ' + (MAX_PULL + 1);
  params.push(cursor.srv_at, cursor.srv_at, cursor.table_rank, cursor.table_rank, cursor.key);
  const result = await env.DB.prepare(sql).bind(...params).all();
  const rows = result.results || [];
  const more = rows.length > MAX_PULL;
  if (more) rows.length = MAX_PULL;
  const out = rows.map(row => ({
    table: row.table_name,
    key: row.row_key,
    owner: row.owner,
    data: JSON.parse(row.data),
    updated_at: row.updated_at,
    srv_at: row.srv_at
  }));
  // 마지막 페이지는 마지막 srv_at 경계를 한 번 겹쳐 읽는다. 다음 요청이 같은
  // 밀리초에 더 작은 table/key를 쓴 경우에도 누락되지 않으며 LWW가 중복을 제거한다.
  // 중간 페이지(more=true)만 정확한 마지막 행 위치를 사용해야 페이지가 전진한다.
  const last = rows.length ? rows[rows.length - 1] : null;
  const nextCursor = last ? {
    srv_at: Number(last.srv_at),
    table_rank: more ? Number(last.table_rank) : -1,
    key: more ? String(last.row_key) : ''
  } : cursor;

  // now은 구형 클라이언트 호환용 숫자다. 새 클라이언트는 반드시 cursor를 쓴다.
  return json({ ok: true, now: nextCursor.srv_at, cursor: nextCursor, more, changes: out }, 200, origin);
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
      'UPDATE bootstrap_codes SET revoked=1 WHERE app=? AND staff_id=? AND revoked=0 AND consumed_at IS NULL'
    ).bind(app, staffId),
    env.DB.prepare(
      'INSERT INTO bootstrap_codes(app,code_hash,staff_id,created_at,expires_at,consumed_at,revoked) ' +
      'VALUES(?,?,?,?,?,NULL,0)'
    ).bind(app, codeHash, staffId, createdAt, expiresAt)
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
    return json({ ok: false, error: '올바른 1회용 코드가 필요합니다' }, 400, origin);
  }
  if (!await activeStaff(env, app, staffId)) return json({ ok: false, error: '접근할 수 없는 대상입니다' }, 401, origin);

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
      'UPDATE tokens SET revoked=1 WHERE app=? AND staff_id=? AND revoked=0 AND EXISTS (' +
      'SELECT 1 FROM bootstrap_codes WHERE app=? AND code_hash=? AND staff_id=? AND consumed_at=?)'
    ).bind(app, staffId, app, codeHash, staffId, consumeMarker),
    env.DB.prepare(
      'INSERT INTO tokens(app,token,staff_id,created_at,revoked) ' +
      'SELECT ?,?,?,?,0 WHERE EXISTS (' +
      'SELECT 1 FROM bootstrap_codes WHERE app=? AND code_hash=? AND staff_id=? AND consumed_at=?)'
    ).bind(app, storedHash, staffId, consumedAt, app, codeHash, staffId, consumeMarker),
    env.DB.prepare(
      'UPDATE bootstrap_codes SET consumed_at=? WHERE app=? AND code_hash=? AND staff_id=? AND consumed_at=?'
    ).bind(consumedAt, app, codeHash, staffId, consumeMarker)
  ]);
  const changed = index => Number(results[index] && results[index].meta && results[index].meta.changes || 0);
  if (changed(0) !== 1 || changed(2) !== 1 || changed(3) !== 1) {
    return json({ ok: false, error: '만료되었거나 이미 사용한 링크입니다' }, 410, origin);
  }
  return json({ ok: true, token, expiresAt: consumedAt + TOKEN_TTL_MS }, 200, origin);
}

async function handleHandoff(env, app, body, origin) {
  const auth = await resolveAuth(env, app, body.auth);
  if (!auth || auth.scope !== 'own' || !SAFE_ID.test(auth.id)) {
    return json({ ok: false, error: '개인 인증이 필요합니다' }, 401, origin);
  }
  const issued = await issueBootstrap(env, app, auth.id, HANDOFF_TTL_MS);
  return json({ ok: true, code: issued.code, expiresAt: issued.expiresAt }, 200, origin);
}

async function issueAdminBootstrap(env, app, ttlMs) {
  if (app !== 'task') throw new Error('직원 앱 원장 세션만 지원합니다');
  const code = randomOpaqueValue();
  const codeHash = adminCodeStorageValue(await sha256Hex(code));
  const createdAt = Date.now();
  const expiresAt = createdAt + ttlMs;
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE admin_bootstrap_codes SET revoked=1 WHERE app=? AND revoked=0 AND consumed_at IS NULL'
    ).bind(app),
    env.DB.prepare(
      'INSERT INTO admin_bootstrap_codes(app,code_hash,created_at,expires_at,consumed_at,revoked) ' +
      'VALUES(?,?,?,?,NULL,0)'
    ).bind(app, codeHash, createdAt, expiresAt)
  ]);
  return { code, expiresAt };
}

async function handleAdminRecover(env, app, body, origin) {
  if (app !== 'task') return json({ ok: false, error: '직원 앱 원장 세션만 지원합니다' }, 404, origin);
  const auth = await resolveAuth(env, app, body.auth);
  if (!auth || auth.kind !== 'root_secret') {
    return json({ ok: false, error: '원장 비상 복구 키가 올바르지 않습니다' }, 401, origin);
  }
  const createdAt = Date.now();
  const expiresAt = createdAt + ADMIN_SESSION_TTL_MS;
  const token = randomOpaqueValue();
  const tokenHash = adminTokenStorageValue(await sha256Hex(token));
  await env.DB.batch([
    env.DB.prepare('UPDATE admin_bootstrap_codes SET revoked=1 WHERE app=? AND revoked=0 AND consumed_at IS NULL').bind(app),
    env.DB.prepare('UPDATE admin_sessions SET revoked=1 WHERE app=? AND revoked=0').bind(app),
    env.DB.prepare(
      'INSERT INTO admin_sessions(app,token_hash,created_at,expires_at,revoked) VALUES(?,?,?,?,0)'
    ).bind(app, tokenHash, createdAt, expiresAt)
  ]);
  return json({ ok: true, token, expiresAt }, 200, origin);
}

async function handleAdminExchange(env, app, body, origin) {
  if (app !== 'task') return json({ ok: false, error: '직원 앱 원장 세션만 지원합니다' }, 404, origin);
  const code = String(body.code || '');
  if (!SAFE_BOOTSTRAP_CODE.test(code)) {
    return json({ ok: false, error: '올바른 원장 1회용 코드가 필요합니다' }, 400, origin);
  }
  const codeHash = adminCodeStorageValue(await sha256Hex(code));
  const consumedAt = Date.now();
  const markerBytes = new Uint32Array(1);
  crypto.getRandomValues(markerBytes);
  const consumeMarker = -(consumedAt * 1000 + (markerBytes[0] % 1000));
  const token = randomOpaqueValue();
  const tokenHash = adminTokenStorageValue(await sha256Hex(token));
  const expiresAt = consumedAt + ADMIN_SESSION_TTL_MS;
  const results = await env.DB.batch([
    env.DB.prepare(
      'UPDATE admin_bootstrap_codes SET consumed_at=? ' +
      'WHERE app=? AND code_hash=? AND revoked=0 AND consumed_at IS NULL AND expires_at>=?'
    ).bind(consumeMarker, app, codeHash, consumedAt),
    env.DB.prepare(
      'UPDATE admin_sessions SET revoked=1 WHERE app=? AND revoked=0 AND EXISTS (' +
      'SELECT 1 FROM admin_bootstrap_codes WHERE app=? AND code_hash=? AND consumed_at=?)'
    ).bind(app, app, codeHash, consumeMarker),
    env.DB.prepare(
      'INSERT INTO admin_sessions(app,token_hash,created_at,expires_at,revoked) ' +
      'SELECT ?,?,?,?,0 WHERE EXISTS (' +
      'SELECT 1 FROM admin_bootstrap_codes WHERE app=? AND code_hash=? AND consumed_at=?)'
    ).bind(app, tokenHash, consumedAt, expiresAt, app, codeHash, consumeMarker),
    env.DB.prepare(
      'UPDATE admin_bootstrap_codes SET consumed_at=? WHERE app=? AND code_hash=? AND consumed_at=?'
    ).bind(consumedAt, app, codeHash, consumeMarker)
  ]);
  const changed = index => Number(results[index] && results[index].meta && results[index].meta.changes || 0);
  if (changed(0) !== 1 || changed(2) !== 1 || changed(3) !== 1) {
    return json({ ok: false, error: '만료되었거나 이미 사용한 원장 링크입니다' }, 410, origin);
  }
  return json({ ok: true, token, expiresAt }, 200, origin);
}

async function handleAdminHandoff(env, app, body, origin) {
  const auth = await resolveAuth(env, app, body.auth);
  if (!auth || auth.kind !== 'admin_session') {
    return json({ ok: false, error: '원장 세션 인증이 필요합니다' }, 401, origin);
  }
  const issued = await issueAdminBootstrap(env, app, ADMIN_BOOTSTRAP_TTL_MS);
  return json({ ok: true, code: issued.code, expiresAt: issued.expiresAt }, 200, origin);
}

async function handleAdminRevoke(env, app, body, origin) {
  const auth = await resolveAuth(env, app, body.auth);
  if (!auth || auth.kind !== 'admin_session') {
    return json({ ok: false, error: '원장 세션 인증이 필요합니다' }, 401, origin);
  }
  const token = String(body.auth.token || '');
  const tokenHash = adminTokenStorageValue(await sha256Hex(token));
  await env.DB.prepare('UPDATE admin_sessions SET revoked=1 WHERE app=? AND token_hash=?')
    .bind(app, tokenHash).run();
  return json({ ok: true }, 200, origin);
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
      if (url.pathname === '/admin-recover') return await handleAdminRecover(env, app, body, okOrigin);
      if (url.pathname === '/admin-exchange') return await handleAdminExchange(env, app, body, okOrigin);
      if (url.pathname === '/admin-handoff') return await handleAdminHandoff(env, app, body, okOrigin);
      if (url.pathname === '/admin-revoke') return await handleAdminRevoke(env, app, body, okOrigin);
      if (url.pathname === '/private-asset') return await handlePrivateAsset(env, app, body, okOrigin);
      if (url.pathname === '/search') return await handleSearch(env, app, body, okOrigin);
      if (url.pathname === '/curriculum') return await handleCurriculum(env, app, body, okOrigin);
      return json({ ok: false, error: '없는 경로' }, 404, okOrigin);
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, 500, okOrigin);
    }
  }
};
