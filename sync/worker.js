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
 *   POST /token   { app, auth(admin), staffId }   → { ok, token }   개인 링크 토큰 발급
 *   POST /revoke  { app, auth(admin), token }     → { ok }
 *
 * 인증
 *   auth = { mode:'admin',  secret }            → 전체 접근
 *   auth = { mode:'person', id, token }         → 본인 것만
 */

const APPS = ['task', 'consult'];
const MAX_CHANGES = 500;     // 요청당 상한 — D1 배치 한계와 악의적 대량 전송을 함께 막는다
const MAX_PULL = 2000;       // 응답당 상한. 초과하면 more:true로 알리고 다음 요청에서 이어받는다

const json = (obj, status, origin) => new Response(JSON.stringify(obj), {
  status: status || 200,
  headers: {
    'Content-Type': 'application/json;charset=utf-8',
    'Access-Control-Allow-Origin': origin || '*',
    'Cache-Control': 'no-store'
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
    if (!id || !token) return null;
    const row = await env.DB.prepare(
      'SELECT staff_id FROM tokens WHERE app=? AND token=? AND revoked=0'
    ).bind(app, token).first();
    if (!row || row.staff_id !== id) return null;
    // 학생 앱(consult)은 서로 보면 안 되므로 자기 것만.
    // 직원 앱(task)은 연락 기록·온라인 프로그램·평가처럼 담당이 아닌 학생 정보도
    // 함께 보고 기록해야 하므로 전체 범위를 준다. 대신 토큰은 언제든 해지할 수 있다.
    return app === 'task' ? { scope: 'all', id: id } : { scope: 'own', id: id };
  }
  return null;
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

  const now = Date.now();
  const since = Number(body.since) || 0;
  const changes = Array.isArray(body.changes) ? body.changes : [];
  if (changes.length > MAX_CHANGES) {
    return json({ ok: false, error: '한 번에 보낼 수 있는 변경은 ' + MAX_CHANGES + '건까지입니다' }, 413, origin);
  }

  // ── 올리기
  const stmts = [];
  for (const c of changes) {
    if (!c || !c.table || !APPS.includes(app)) continue;
    const t = c.table;
    if (t !== 'staff' && t !== 'tasks' && t !== 'checks') continue;
    if (!(t === 'checks' ? c.k : c.id)) continue;
    // 개인 접속은 자기 것만 쓸 수 있다. 남의 owner를 붙여 보내도 서버에서 막는다.
    if (auth.scope === 'own') {
      if (t === 'staff' && c.id !== auth.id) continue;
      if (t !== 'staff' && c.owner !== auth.id) continue;
    }
    stmts.push(upsertStmt(env, t, app, c, now));
  }
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

async function handleRevoke(env, app, body, origin) {
  const auth = await resolveAuth(env, app, body.auth);
  if (!auth || auth.scope !== 'all') return json({ ok: false, error: '원장만 해지할 수 있습니다' }, 401, origin);
  await env.DB.prepare('UPDATE tokens SET revoked=1 WHERE app=? AND token=?')
    .bind(app, String(body.token || '')).run();
  return json({ ok: true }, 200, origin);
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
      if (url.pathname === '/revoke') return await handleRevoke(env, app, body, okOrigin);
      return json({ ok: false, error: '없는 경로' }, 404, okOrigin);
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, 500, okOrigin);
    }
  }
};
