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
      if (url.pathname === '/revoke') return await handleRevoke(env, app, body, okOrigin);
      if (url.pathname === '/search') return await handleSearch(env, app, body, okOrigin);
      if (url.pathname === '/curriculum') return await handleCurriculum(env, app, body, okOrigin);
      return json({ ok: false, error: '없는 경로' }, 404, okOrigin);
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, 500, okOrigin);
    }
  }
};
