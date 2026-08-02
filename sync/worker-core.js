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
 *   POST /token   { app, auth(admin), staffId }   → { ok, code }    1회용 링크 코드 발급
 *   POST /exchange { app, staffId, code }           → { ok, token }   1회 교환 후 bearer 발급
 *   POST /revoke  { app, auth(admin), staffId }   → { ok }       대상 bearer·code 일괄 해지
 *
 * 인증
 *   auth = { mode:'admin',  secret }            → 전체 접근
 *   auth = { mode:'person', id, token }         → 본인 것만
 */

const APPS = ['task', 'consult'];
const MAX_CHANGES = 500;     // 요청당 상한 — D1 배치 한계와 악의적 대량 전송을 함께 막는다
const MAX_PULL = 2000;       // 응답당 상한. 초과하면 more:true로 알리고 다음 요청에서 이어받는다
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_CLOCK_SKEW = 5 * 60 * 1000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN_HASH_PREFIX = 'sha256:';
const BARE_SHA256 = /^[a-f0-9]{64}$/i;
const LEARNING_CLAIMABLE_STATUSES = new Set(['planned', 'in_progress', 'check_needed']);
const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000;
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
    'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key, If-Match',
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
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

const CHECK_PREFIXES = Object.freeze({
  consult: new Set(['st', 'stsubj', 'stgoal', 'ing', 'ingp', 'ingset', 'tb', 'rd', 'wn', 'lp', 'lpcore', 'lpplan', 'lpassess', 'lpcampaign', 'lpwrong', 'lpimport', 'lpclaim']),
  task: new Set(['att', 'ct', 'exam', 'op', 'opset'])
});
const TASK_SHARED_CHECKS = new Set(['ct', 'exam', 'op', 'opset']);
const CONSULT_MANAGED_LEARNING_CHECKS = new Set(['lp', 'lpcore', 'lpplan', 'lpassess', 'lpcampaign', 'lpwrong', 'lpimport']);

export async function resolveLegacyAuth(env, app, auth) {
  if (!auth || typeof auth !== 'object') return null;
  if (auth.mode === 'admin') {
    const want = app === 'task' ? env.TASK_ADMIN_SECRET : env.CONSULT_ADMIN_SECRET;
    if (!want || !safeEqual(auth.secret, want)) return null;
    return {
      role: 'admin', id: null, readAll: true, publishForAll: true,
      manageTokens: true, writeStaff: true, writeSharedChecks: true
    };
  }
  if (auth.mode !== 'person') return null;

  const id = String(auth.id || '');
  const token = String(auth.token || '');
  if (!SAFE_ID.test(id) || !isRawBearer(token)) return null;

  const storedHash = tokenStorageValue(await sha256Hex(token));
  const createdAfter = Date.now() - TOKEN_TTL_MS;
  let row = await env.DB.prepare(
    'SELECT token, staff_id FROM tokens WHERE app=? AND token=? AND revoked=0 AND created_at>=? LIMIT 1'
  ).bind(app, storedHash, createdAfter).first();
  let legacyRaw = false;
  if (!row) {
    row = await env.DB.prepare(
      "SELECT token, staff_id FROM tokens WHERE app=? AND token=? AND token NOT LIKE 'sha256:%' " +
      'AND revoked=0 AND created_at>=? LIMIT 1'
    ).bind(app, token, createdAfter).first();
    legacyRaw = Boolean(row);
  }
  if (!row || row.staff_id !== id) return null;

  const staffRow = await env.DB.prepare('SELECT data FROM staff WHERE app=? AND id=? LIMIT 1')
    .bind(app, id).first();
  if (!staffRow) return null;
  let staff = {};
  try { staff = JSON.parse(staffRow.data); } catch (error) { return null; }
  if (staff.deleted) return null;

  // 안전한 구형 평문 토큰만 첫 성공 인증 직후 접두 해시 형식으로 이전한다.
  if (legacyRaw) {
    try {
      const migrated = await env.DB.prepare(
        'UPDATE tokens SET token=? WHERE app=? AND token=? AND staff_id=? AND revoked=0'
      ).bind(storedHash, app, token, id).run();
      if (Number(migrated && migrated.meta && migrated.meta.changes || 0) !== 1) return null;
    } catch (error) {
      const canonical = await env.DB.prepare(
        'SELECT staff_id FROM tokens WHERE app=? AND token=? AND revoked=0 AND created_at>=? LIMIT 1'
      ).bind(app, storedHash, createdAfter).first();
      await env.DB.prepare(
        'UPDATE tokens SET revoked=1 WHERE app=? AND token=? AND staff_id=? AND revoked=0'
      ).bind(app, token, id).run();
      if (!canonical || canonical.staff_id !== id) return null;
    }
  }

  const manager = staff.manager === true;
  return {
    role: manager ? 'manager' : 'person',
    id,
    readAll: manager,
    publishForAll: manager,
    manageTokens: false,
    writeStaff: false,
    writeSharedChecks: app === 'task'
  };
}

function isRawBearer(value) {
  const token = String(value || '');
  return Boolean(token) && token.length <= 256 &&
    !BARE_SHA256.test(token) && !token.toLowerCase().startsWith(TOKEN_HASH_PREFIX);
}

function tokenStorageValue(digest) {
  return TOKEN_HASH_PREFIX + String(digest || '').toLowerCase();
}

function randomOpaqueValue() {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

function cleanRecord(input, table) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
    if (table === 'staff' && key.toLowerCase() === 'token') continue;
    out[key] = value;
  }
  try {
    if (new TextEncoder().encode(JSON.stringify(out)).length > MAX_RECORD_BYTES) return null;
  } catch (error) { return null; }
  return out;
}

function parseCheckKey(raw, app) {
  const key = String(raw || '');
  if (!key || key.length > 320) return null;
  const separator = key.lastIndexOf('|');
  if (separator < 1) return null;
  const taskId = key.slice(0, separator);
  const slot = key.slice(separator + 1);
  if (!(SAFE_DATE.test(slot) || slot === 'all')) return null;
  const special = taskId.match(/^__([a-z]+)__(.{1,128})$/u);
  if (special) {
    if (!CHECK_PREFIXES[app] || !CHECK_PREFIXES[app].has(special[1])) return null;
    return { key, taskId, slot, specialKind: special[1], subject: special[2] };
  }
  if (!SAFE_ID.test(taskId) || slot === 'all') return null;
  return { key, taskId, slot, specialKind: '', subject: '' };
}

function normalizeTimestamp(value, now) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.floor(numeric > now ? now : numeric);
}

function validationFailure(code, message) {
  return { ok: false, code, message };
}

function normalizeLearningClaimRecord(data, parsed, planItems, now) {
  const source = data && data.value && Array.isArray(data.value.claims) ? data.value.claims : null;
  if (!source || source.length > 200) return null;
  const currentItems = Array.isArray(planItems) ? planItems : [];
  const seen = new Set();
  const claims = [];
  for (const claim of source) {
    const itemId = String(claim && claim.itemId || '');
    const date = String(claim && claim.date || '');
    const expectedRevision = Number(claim && claim.expectedRevision);
    const claimedAt = String(claim && claim.claimedAt || '');
    const timestamp = Date.parse(claimedAt);
    if (!SAFE_ID.test(itemId) || !SAFE_DATE.test(date) ||
        !Number.isInteger(expectedRevision) || expectedRevision < 1 ||
        !Number.isFinite(timestamp) || timestamp > now + MAX_CLOCK_SKEW) return null;
    const current = currentItems.find(item => item && String(item.itemId || '') === itemId);
    if (!current || String(current.studentCode || '') !== parsed.subject ||
        String(current.date || '') !== date || Number(current.revision) !== expectedRevision ||
        !LEARNING_CLAIMABLE_STATUSES.has(String(current.status || ''))) return null;
    if (seen.has(itemId)) continue;
    seen.add(itemId);
    claims.push({ itemId, date, expectedRevision, claimedAt: new Date(Math.min(timestamp, now)).toISOString() });
  }
  return {
    taskId: parsed.taskId, date: parsed.slot, done: true,
    value: { claims }, updatedAt: data.updatedAt
  };
}

function normalizeChange(change, auth, app, taskRows, learningPlanRows, now) {
  if (!change || typeof change !== 'object') return validationFailure('invalid_change', '변경 객체가 필요합니다');
  const table = String(change.table || '');
  if (!['staff', 'tasks', 'checks'].includes(table)) return validationFailure('invalid_table', '허용되지 않은 테이블입니다');
  let data = cleanRecord(change.data, table);
  if (!data) return validationFailure('invalid_record', '레코드가 없거나 너무 큽니다');
  const updatedAt = normalizeTimestamp(change.updated_at, now);
  data.updatedAt = updatedAt;

  if (table === 'staff') {
    const id = String(change.id || '');
    if (!SAFE_ID.test(id) || String(data.id || '') !== id) return validationFailure('invalid_staff_id', '직원 식별자가 일치하지 않습니다');
    if (!auth.writeStaff) return validationFailure('staff_write_forbidden', '개인 링크는 직원 원장을 수정할 수 없습니다');
    return { ok: true, value: { table, id, owner: id, data, updated_at: updatedAt } };
  }

  if (table === 'tasks') {
    const id = String(change.id || '');
    if (!SAFE_ID.test(id) || String(data.id || '') !== id) return validationFailure('invalid_task_id', '업무 식별자가 일치하지 않습니다');
    const owner = String(data.staffId || '');
    if (!SAFE_ID.test(owner)) return validationFailure('invalid_task_owner', '업무 담당자가 올바르지 않습니다');
    const existing = taskRows.get(id);

    if (auth.role === 'admin') {
      return { ok: true, value: { table, id, owner, data, updated_at: updatedAt } };
    }
    if (existing) {
      const ownStaffTask = existing.owner === auth.id && existing.origin === 'staff';
      const managerTask = auth.publishForAll && existing.origin === 'manager';
      if (!ownStaffTask && !managerTask) return validationFailure('task_write_forbidden', '원장 발행 업무는 개인 링크에서 수정할 수 없습니다');
      data.staffId = existing.owner;
      data.origin = existing.origin;
      data.lastEditBy = 'staff';
      return { ok: true, value: { table, id, owner: existing.owner, data, updated_at: updatedAt } };
    }
    if (owner !== auth.id && !auth.publishForAll) return validationFailure('task_publish_forbidden', '다른 사람에게 업무를 발행할 권한이 없습니다');
    data.origin = owner === auth.id && data.origin !== 'manager' ? 'staff' : 'manager';
    data.lastEditBy = 'staff';
    return { ok: true, value: { table, id, owner, data, updated_at: updatedAt } };
  }

  const parsed = parseCheckKey(change.k, app);
  if (!parsed || String(data.taskId || '') !== parsed.taskId || String(data.date || '') !== parsed.slot) {
    return validationFailure('invalid_check_key', '체크 키와 본문이 일치하지 않습니다');
  }

  let owner = '';
  if (parsed.specialKind) {
    owner = parsed.subject;
    if (app === 'consult' && CONSULT_MANAGED_LEARNING_CHECKS.has(parsed.specialKind) && auth.role !== 'admin' && !auth.publishForAll) {
      return validationFailure('learning_state_write_forbidden', '학습 원장 상태는 관리자만 수정할 수 있습니다');
    }
    if (auth.role !== 'admin' && !auth.publishForAll) {
      const ownSpecial = parsed.subject === auth.id;
      const sharedTaskRecord = app === 'task' && auth.writeSharedChecks && TASK_SHARED_CHECKS.has(parsed.specialKind);
      if (!ownSpecial && !sharedTaskRecord) return validationFailure('special_check_forbidden', '다른 사람의 개인 기록은 수정할 수 없습니다');
    }
    if (app === 'consult' && parsed.specialKind === 'lpclaim') {
      data = normalizeLearningClaimRecord(data, parsed, learningPlanRows.get(parsed.subject), now);
      if (!data) return validationFailure('invalid_learning_claim', '완료 요청 형식이 올바르지 않습니다');
    }
  } else {
    const task = taskRows.get(parsed.taskId);
    if (!task) return validationFailure('unknown_check_task', '연결된 업무를 찾을 수 없습니다');
    owner = task.owner;
    if (auth.role !== 'admin' && !auth.publishForAll && owner !== auth.id) {
      return validationFailure('check_write_forbidden', '다른 사람의 업무 체크는 수정할 수 없습니다');
    }
  }
  return { ok: true, value: { table, k: parsed.key, owner, data, updated_at: updatedAt } };
}

function upsertStmt(env, table, app, change, srvAt) {
  const idCol = table === 'checks' ? 'k' : 'id';
  const key = table === 'checks' ? change.k : change.id;
  return env.DB.prepare(
    'INSERT INTO ' + table + ' (app, ' + idCol + ', owner, data, updated_at, srv_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(app, ' + idCol + ') DO UPDATE SET ' +
    'owner=excluded.owner, data=excluded.data, updated_at=excluded.updated_at, srv_at=excluded.srv_at ' +
    'WHERE excluded.updated_at > ' + table + '.updated_at ' +
    'OR ' + table + '.updated_at > excluded.srv_at + ' + MAX_CLOCK_SKEW
  ).bind(app, key, change.owner || null, JSON.stringify(change.data), change.updated_at, srvAt);
}

async function loadTaskRows(env, app) {
  const result = await env.DB.prepare('SELECT id, owner, data FROM tasks WHERE app=?').bind(app).all();
  const rows = new Map();
  for (const row of (result.results || [])) {
    let data = {};
    try { data = JSON.parse(row.data); } catch (error) {}
    rows.set(row.id, { owner: row.owner, origin: data.origin || '' });
  }
  return rows;
}

async function loadLearningPlanRows(env, app, changes) {
  const rows = new Map();
  if (app !== 'consult') return rows;
  const subjects = new Set();
  for (const change of changes) {
    if (!change || change.table !== 'checks') continue;
    const parsed = parseCheckKey(change.k, app);
    if (parsed && parsed.specialKind === 'lpclaim') subjects.add(parsed.subject);
  }
  for (const subject of subjects) {
    const row = await env.DB.prepare(
      'SELECT data FROM checks WHERE app=? AND k=? LIMIT 1'
    ).bind(app, '__lpplan__' + subject + '|all').first();
    let data = {};
    try { data = row ? JSON.parse(row.data) : {}; } catch (error) {}
    rows.set(subject, data && data.value && Array.isArray(data.value) ? data.value : []);
  }
  return rows;
}

function changeIdentity(change) {
  if (!change || typeof change !== 'object') return '';
  return String(change.table || '') + ':' + String(change.table === 'checks' ? change.k : change.id || '');
}

async function handleSync(env, app, body, origin) {
  const auth = await resolveLegacyAuth(env, app, body.auth);
  if (!auth) return json({ ok: false, error: '인증 실패' }, 401, origin);

  const now = Date.now();
  const requestedSince = Number(body.since) || 0;
  const since = requestedSince > now + MAX_CLOCK_SKEW ? 0 : Math.max(0, requestedSince);
  const changes = Array.isArray(body.changes) ? body.changes : [];
  if (changes.length > MAX_CHANGES) {
    return json({ ok: false, error: '한 번에 보낼 수 있는 변경은 ' + MAX_CHANGES + '건까지입니다' }, 413, origin);
  }

  const duplicateKeys = new Set();
  const seen = new Set();
  changes.forEach(change => {
    const identity = changeIdentity(change);
    if (!identity || seen.has(identity)) duplicateKeys.add(identity || '(unknown)');
    seen.add(identity);
  });
  if (duplicateKeys.size) {
    return json({ ok: false, error: '같은 레코드를 한 배치에 두 번 보낼 수 없습니다', code: 'duplicate_change', keys: [...duplicateKeys] }, 422, origin);
  }

  const taskRows = await loadTaskRows(env, app);
  const learningPlanRows = await loadLearningPlanRows(env, app, changes);
  const normalizedByIndex = new Map();
  const errors = [];

  // 업무를 먼저 검증해 같은 배치의 체크가 업무보다 앞에 있어도 순서에 의존하지 않게 한다.
  changes.forEach((change, index) => {
    if (change && change.table === 'checks') return;
    const result = normalizeChange(change, auth, app, taskRows, learningPlanRows, now);
    if (!result.ok) {
      errors.push({ index, table: change && change.table || '', key: changeIdentity(change), code: result.code, message: result.message });
      return;
    }
    normalizedByIndex.set(index, result.value);
    if (result.value.table === 'tasks') {
      taskRows.set(result.value.id, { owner: result.value.owner, origin: result.value.data.origin || '' });
    }
  });
  changes.forEach((change, index) => {
    if (!change || change.table !== 'checks') return;
    const result = normalizeChange(change, auth, app, taskRows, learningPlanRows, now);
    if (!result.ok) {
      errors.push({ index, table: 'checks', key: changeIdentity(change), code: result.code, message: result.message });
      return;
    }
    normalizedByIndex.set(index, result.value);
  });

  if (errors.length) {
    return json({ ok: false, error: '검증되지 않은 변경이 있어 배치 전체를 저장하지 않았습니다', code: 'change_validation_failed', details: errors }, 422, origin);
  }

  const normalized = [...normalizedByIndex.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1]);
  // 같은 배치에 미래 srv_at을 만들지 않는다. 동일 ms 경계는 정렬 키 재조회로 중복 허용·누락 방지한다.
  const writeBase = Date.now();
  const statements = normalized.map(change => upsertStmt(env, change.table, app, change, writeBase));
  if (statements.length) await env.DB.batch(statements);

  const ownFilter = auth.readAll ? '' : ' AND owner=?';
  // 일반 직원도 운영 UI의 공유 원생 기록 4종은 읽어야 한다. 그 외 staff/tasks/attendance는 owner-only다.
  const sharedTaskCheckRead = !auth.readAll && app === 'task' && auth.writeSharedChecks;
  const checkFilter = auth.readAll ? '' : sharedTaskCheckRead
    ? " AND (owner=? OR k GLOB '__ct__*|*' OR k GLOB '__exam__*|*' " +
      "OR k GLOB '__op__*|*' OR k GLOB '__opset__*|*')"
    : ' AND owner=?';
  const branch = (table, keyColumn, filter) =>
    "SELECT '" + table + "' AS table_name, " + keyColumn + ' AS record_key, owner, data, updated_at, srv_at FROM ' + table +
    ' WHERE app=? AND srv_at>?' + filter;
  const sql = branch('staff', 'id', ownFilter) + ' UNION ALL ' +
    branch('tasks', 'id', ownFilter) + ' UNION ALL ' + branch('checks', 'k', checkFilter) +
    ' ORDER BY srv_at, table_name, record_key LIMIT ?';
  const bindings = [];
  bindings.push(app, since);
  if (!auth.readAll) bindings.push(auth.id);
  bindings.push(app, since);
  if (!auth.readAll) bindings.push(auth.id);
  bindings.push(app, since);
  if (!auth.readAll) bindings.push(auth.id);
  bindings.push(MAX_PULL + 1);
  const pulled = await env.DB.prepare(sql).bind(...bindings).all();
  const rows = pulled.results || [];
  const more = rows.length > MAX_PULL;
  if (more) rows.length = MAX_PULL;
  const out = rows.map(row => {
    let data;
    try { data = JSON.parse(row.data); } catch (error) { data = {}; }
    if (row.table_name === 'staff' && data && typeof data === 'object') delete data.token;
    return {
      table: row.table_name, key: row.record_key, owner: row.owner,
      data, updated_at: row.updated_at, srv_at: row.srv_at
    };
  });
  const lastServerTime = out.length ? Math.max(...out.map(row => Number(row.srv_at) || 0)) : since;
  // 숫자형 구형 커서는 동일 ms 경계를 표현하지 못한다. 반복은 허용하되 누락은 막는다.
  const nextSince = more ? Math.max(since, lastServerTime - 1) : Math.max(since, lastServerTime);
  return json({
    ok: true,
    now: nextSince,
    more,
    changes: out,
    accepted: normalized.length,
    rejected: 0,
    cursor_reset: since !== requestedSince
  }, 200, origin);
}

async function handleToken(env, app, body, origin) {
  const auth = await resolveLegacyAuth(env, app, body.auth);
  if (!auth || !auth.manageTokens) return json({ ok: false, error: '원장만 발급할 수 있습니다' }, 401, origin);
  const staffId = String(body.staffId || '');
  if (!SAFE_ID.test(staffId)) return json({ ok: false, error: '올바른 staffId 필요' }, 400, origin);
  const staffRow = await env.DB.prepare('SELECT data FROM staff WHERE app=? AND id=? LIMIT 1')
    .bind(app, staffId).first();
  let staff = null;
  try { staff = staffRow ? JSON.parse(staffRow.data) : null; } catch (error) {}
  if (!staff || staff.deleted) return json({ ok: false, error: '먼저 활성 대상을 동기화해 주세요' }, 409, origin);

  const code = randomOpaqueValue();
  const codeHash = tokenStorageValue(await sha256Hex(code));
  const createdAt = Date.now();
  const expiresAt = createdAt + BOOTSTRAP_TTL_MS;
  await env.DB.batch([
    // 링크 복사만으로 기존 기기를 끊지 않는다. 미사용 code만 회전한다.
    env.DB.prepare(
      'UPDATE bootstrap_codes SET revoked=1 WHERE app=? AND staff_id=? AND revoked=0 AND consumed_at IS NULL'
    ).bind(app, staffId),
    env.DB.prepare(
      'INSERT INTO bootstrap_codes(app,code_hash,staff_id,created_at,expires_at,consumed_at,revoked) ' +
      'VALUES(?,?,?,?,?,NULL,0)'
    ).bind(app, codeHash, staffId, createdAt, expiresAt)
  ]);
  return json({ ok: true, code, expiresAt }, 200, origin);
}

async function handleExchange(env, app, body, origin) {
  const staffId = String(body.staffId || '');
  const code = String(body.code || '');
  if (!SAFE_ID.test(staffId) || !SAFE_BOOTSTRAP_CODE.test(code)) {
    return json({ ok: false, error: '올바른 1회용 코드가 필요합니다' }, 400, origin);
  }
  const staffRow = await env.DB.prepare('SELECT data FROM staff WHERE app=? AND id=? LIMIT 1')
    .bind(app, staffId).first();
  let staff = null;
  try { staff = staffRow ? JSON.parse(staffRow.data) : null; } catch (error) {}
  if (!staff || staff.deleted) return json({ ok: false, error: '접근할 수 없는 대상입니다' }, 401, origin);

  const codeHash = tokenStorageValue(await sha256Hex(code));
  const consumedAt = Date.now();
  const markerBytes = new Uint32Array(1);
  crypto.getRandomValues(markerBytes);
  // 음수 marker는 batch 내부에서만 쓰고 마지막 문장에서 실제 소비 시각으로 바꾼다.
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
      'UPDATE bootstrap_codes SET consumed_at=? ' +
      'WHERE app=? AND code_hash=? AND staff_id=? AND consumed_at=?'
    ).bind(consumedAt, app, codeHash, staffId, consumeMarker)
  ]);
  const changed = index => Number(results[index] && results[index].meta && results[index].meta.changes || 0);
  if (changed(0) !== 1 || changed(2) !== 1 || changed(3) !== 1) {
    return json({ ok: false, error: '만료되었거나 이미 사용한 링크입니다' }, 410, origin);
  }
  return json({ ok: true, token, expiresAt: consumedAt + TOKEN_TTL_MS }, 200, origin);
}

async function handleRevoke(env, app, body, origin) {
  const auth = await resolveLegacyAuth(env, app, body.auth);
  if (!auth || !auth.manageTokens) return json({ ok: false, error: '원장만 해지할 수 있습니다' }, 401, origin);
  const staffId = String(body.staffId || '');
  if (!SAFE_ID.test(staffId)) return json({ ok: false, error: '올바른 staffId 필요' }, 400, origin);
  await env.DB.batch([
    env.DB.prepare('UPDATE tokens SET revoked=1 WHERE app=? AND staff_id=? AND revoked=0')
      .bind(app, staffId),
    env.DB.prepare('UPDATE bootstrap_codes SET revoked=1 WHERE app=? AND staff_id=? AND revoked=0')
      .bind(app, staffId)
  ]);
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
  const auth = await resolveLegacyAuth(env, app, body.auth);
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
  const auth = await resolveLegacyAuth(env, app, body.auth);
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
      if (url.pathname === '/exchange') return await handleExchange(env, app, body, okOrigin);
      if (url.pathname === '/revoke') return await handleRevoke(env, app, body, okOrigin);
      if (url.pathname === '/search') return await handleSearch(env, app, body, okOrigin);
      if (url.pathname === '/curriculum') return await handleCurriculum(env, app, body, okOrigin);
      return json({ ok: false, error: '없는 경로' }, 404, okOrigin);
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, 500, okOrigin);
    }
  }
};
