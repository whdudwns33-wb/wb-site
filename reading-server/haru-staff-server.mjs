import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowedStaffRoute } from './haru-staff-routes.mjs';
import { haruBodyLimit } from './haru-api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = s => createHash('sha256').update(s).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const hashPassword = (password, salt) => scryptSync(password, salt, 32).toString('hex');
const validPassword = p => typeof p === 'string' && p.length >= 8 && Buffer.byteLength(p) <= 256;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const protocols = ['2025-11-25', '2025-06-18', '2025-03-26'];

export async function createStaffServer(config) {
  if (!/^https:\/\/[^/]+$/.test(config.backend) || !config.secret || !/^https:\/\/[^/]+$/.test(config.publicOrigin)) throw new Error('서버 주소·전용 키 설정이 필요합니다.');
  await mkdir(config.privateDir, { recursive: true });
  const db = new DatabaseSync(path.join(config.privateDir, 'accounts.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,salt TEXT NOT NULL,hash TEXT NOT NULL,must_change INTEGER NOT NULL DEFAULT 1,revision INTEGER NOT NULL DEFAULT 1,failures INTEGER NOT NULL DEFAULT 0,locked_until INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS credentials(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,kind TEXT NOT NULL,label TEXT NOT NULL,revision INTEGER NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(time TEXT NOT NULL,user_id TEXT NOT NULL,action TEXT NOT NULL,status INTEGER NOT NULL); `);
  const audit = (id, action, status) => db.prepare('INSERT INTO audit VALUES(?,?,?,?)').run(new Date().toISOString(), id, action, status);
  const seed = (id, name, password) => {
    if (!/^wb[가-힣a-z0-9._-]{1,62}$/u.test(id) || typeof name !== 'string' || !name.trim() || typeof password !== 'string' || password.length > 256) throw new Error('계정 입력을 확인해 주세요.');
    const salt = token();
    db.prepare('INSERT OR IGNORE INTO users(id,name,salt,hash) VALUES(?,?,?,?)').run(id, name, salt, hashPassword(password, salt));
  };
  const issue = (user, kind, label, duration) => {
    const value = token(), expires = Date.now() + duration;
    db.prepare('DELETE FROM credentials WHERE expires<?').run(Date.now());
    db.prepare('INSERT INTO credentials VALUES(?,?,?,?,?,?)').run(digest(value), user.id, kind, label, user.revision, expires);
    return { token: value, expires };
  };
  const identify = req => {
    const value = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1];
    if (!value) fail(401, '로그인이 필요합니다.');
    const row = db.prepare('SELECT c.*,u.name,u.must_change,u.revision AS current_revision FROM credentials c JOIN users u ON u.id=c.user_id WHERE c.hash=? AND c.expires>?').get(digest(value), Date.now());
    if (!row || row.revision !== row.current_revision) fail(401, '로그인이 만료됐습니다.');
    return { ...row, id: row.user_id };
  };
  const localOnly = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) &&
    !['cf-connecting-ip', 'cf-ray', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'].some(h => req.headers[h]) &&
    /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '');
  const body = async (req, limit = 8192) => {
    let bytes = 0; const chunks = [];
    for await (const part of req) { bytes += part.length; if (bytes > limit) fail(413, '요청이 너무 큽니다.'); chunks.push(part); }
    try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'JSON 객체가 필요합니다.'); return value; }
    catch (e) { if (e.status) throw e; fail(400, 'JSON 형식을 확인해 주세요.'); }
  };
  const loginAttempts = new Map();
  const proxy = async (user, method, target, data) => {
    if (!['GET', 'POST', 'DELETE'].includes(method) || (data != null && (typeof data !== 'object' || Array.isArray(data)))) fail(400, '메서드·본문 형식을 확인해 주세요.');
    if (typeof target !== 'string' || !/^\/api\/haru\/admin\/[a-z/]+(?:\?[^#]*)?$/.test(target)) fail(403, '허용되지 않은 API 경로입니다.');
    const url = new URL(target, config.backend);
    if (url.origin !== config.backend || !allowedStaffRoute(method, url.pathname)) fail(403, '대비 앱 관리자 API만 사용할 수 있습니다.');
    const encoded = data == null ? undefined : JSON.stringify(data);
    if (encoded && Buffer.byteLength(encoded) > haruBodyLimit(url.pathname)) fail(413, '요청이 너무 큽니다.');
    const response = await (config.fetch || fetch)(url, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: 'Bearer ' + config.secret, 'Content-Type': 'application/json' }, body: encoded });
    audit(user.id, method + ' ' + url.pathname, response.status);
    return { status: response.status, body: await response.json() };
  };
  const server = http.createServer(async (req, res) => {
    const send = (status, value, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' });
      res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
    };
    try {
      const host = req.headers.host || '';
      if (![new URL(config.publicOrigin).host, '127.0.0.1:' + config.port, 'localhost:' + config.port].includes(host)) fail(403, '등록되지 않은 주소입니다.');
      const url = new URL(req.url, config.publicOrigin), p = url.pathname, m = req.method;
      if (req.headers.origin && ![config.publicOrigin, 'http://127.0.0.1:' + config.port, 'http://localhost:' + config.port].includes(req.headers.origin)) fail(403, '다른 사이트의 요청은 허용하지 않습니다.');
      if (p === '/healthz' && m === 'GET') return send(200, { ok: true, app: 'haru-staff' });
      if (p === '/api/haru/staff/login' && m === 'POST') {
        const b = await body(req);
        if (typeof b.id !== 'string' || b.id.length > 64 || typeof b.password !== 'string' || Buffer.byteLength(b.password) > 256) fail(400, '아이디·비밀번호를 확인해 주세요.');
        const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
        const now = Date.now();
        for (const [key, v] of loginAttempts) if (v.until < now) loginAttempts.delete(key);
        const rate = loginAttempts.get(ip) || { count: 0, until: now + 300000 };
        if (++rate.count > 20 || loginAttempts.size > 10000) fail(429, '잠시 후 다시 시도해 주세요.');
        loginAttempts.set(ip, rate);
        const u = db.prepare('SELECT * FROM users WHERE id=?').get(b.id);
        if (u?.locked_until > now) fail(429, '5분 후 다시 시도해 주세요.');
        const salt = u?.salt || '없는계정비교용고정소금';
        const actual = Buffer.from(hashPassword(b.password, salt), 'hex');
        const match = timingSafeEqual(actual, Buffer.from(u?.hash || '0'.repeat(64), 'hex'));
        if (!u || !match) {
          if (u) db.prepare('UPDATE users SET failures=failures+1,locked_until=CASE WHEN failures>=4 THEN ? ELSE 0 END WHERE id=?').run(now + 300000, u.id);
          audit(b.id, '로그인 실패', 401); fail(401, '아이디·비밀번호가 맞지 않습니다.');
        }
        if (u.must_change && !localOnly(req)) fail(403, '최초 비밀번호 변경은 학원 서버 PC에서 진행해 주세요.');
        db.prepare('UPDATE users SET failures=0,locked_until=0 WHERE id=?').run(u.id);
        audit(u.id, '로그인', 200);
        return send(200, { ...issue(u, 'session', '웹 로그인', 12 * 3600000), mustChange: !!u.must_change, id: u.id, name: u.name, role: 'haru-admin' });
      }
      if (p.startsWith('/api/') || p === '/mcp') {
        const u = identify(req);
        if (u.must_change && (p !== '/api/haru/staff/password' || m !== 'POST' || !localOnly(req))) fail(403, '이 PC에서 먼저 비밀번호를 변경해 주세요.');
        if (p === '/api/haru/staff/password' && m === 'POST') {
          if (u.kind !== 'session') fail(403, '웹 로그인 후 변경해 주세요.');
          const b = await body(req);
          const record = db.prepare('SELECT * FROM users WHERE id=?').get(u.id);
          if (typeof b.currentPassword !== 'string' || Buffer.byteLength(b.currentPassword) > 256 || !validPassword(b.password)) fail(400, '새 비밀번호는 8자 이상 256바이트 이내로 입력해 주세요.');
          if (b.currentPassword === b.password || !timingSafeEqual(Buffer.from(hashPassword(b.currentPassword, record.salt), 'hex'), Buffer.from(record.hash, 'hex'))) fail(400, '현재 비밀번호와 새 비밀번호를 확인해 주세요.');
          const salt = token();
          db.prepare('UPDATE users SET salt=?,hash=?,must_change=0,revision=revision+1 WHERE id=?').run(salt, hashPassword(b.password, salt), u.id);
          db.prepare('DELETE FROM credentials WHERE user_id=?').run(u.id);
          audit(u.id, '비밀번호 변경·모든 키 폐기', 200);
          return send(200, { ok: true, message: '변경했습니다. 새 비밀번호로 다시 로그인해 주세요.' });
        }
        if (p === '/api/haru/staff/logout' && m === 'POST') {
          db.prepare('DELETE FROM credentials WHERE hash=?').run(u.hash); return send(200, { ok: true });
        }
        if (p === '/api/haru/staff/me' && m === 'GET') return send(200, { id: u.id, name: u.name, role: 'haru-admin', kind: u.kind });
        if (p === '/api/haru/staff/keys') {
          if (u.kind !== 'session') fail(403, 'API 키 관리는 웹 로그인이 필요합니다.');
          if (m === 'GET') return send(200, { keys: db.prepare("SELECT hash AS id,label,expires FROM credentials WHERE user_id=? AND kind='api' AND expires>?").all(u.id, Date.now()) });
          const b = await body(req);
          if (m === 'POST') {
            if (typeof b.label !== 'string' || !b.label.trim() || b.label.length > 60) fail(400, '키 이름은 1~60자입니다.');
            if (db.prepare("SELECT count(*) AS n FROM credentials WHERE user_id=? AND kind='api' AND expires>?").get(u.id, Date.now()).n >= 10) fail(400, '사용하지 않는 키를 먼저 폐기해 주세요.');
            audit(u.id, 'API 키 발급', 200); return send(200, issue(u, 'api', b.label.trim(), 90 * 86400000));
          }
          if (m === 'DELETE' && typeof b.id === 'string') {
            db.prepare("DELETE FROM credentials WHERE hash=? AND user_id=? AND kind='api'").run(b.id, u.id);
            audit(u.id, 'API 키 폐기', 200); return send(200, { ok: true });
          }
        }
        if (p === '/mcp') {
          if (m !== 'POST') return send(405, { error: 'MCP는 POST 요청을 사용합니다.' });
          const b = await body(req, 4718592);
          if (b.jsonrpc !== '2.0' || typeof b.method !== 'string' || (b.id != null && !['number', 'string'].includes(typeof b.id))) fail(400, 'JSON-RPC 형식을 확인해 주세요.');
          if (req.headers['mcp-protocol-version'] && !protocols.includes(req.headers['mcp-protocol-version'])) fail(400, '지원하지 않는 MCP 버전입니다.');
          if (b.id == null) { if (b.method !== 'notifications/initialized') fail(400, '지원하지 않는 알림입니다.'); res.writeHead(202); return res.end(); }
          let result;
          if (b.method === 'initialize') result = { protocolVersion: protocols.includes(b.params?.protocolVersion) ? b.params.protocolVersion : protocols[0], capabilities: { tools: {} }, serverInfo: { name: 'wb-haru', version: '1.0.0' } };
          else if (b.method === 'ping') result = {};
          else if (b.method === 'tools/list') result = { tools: [{ name: 'haru_admin_request', description: '삼육중 및 영재원 대비 관리자 API. 조회·등록·자료·플랜·현황·내보내기·파기를 수행합니다. 파기는 사용자가 구체적으로 요청할 때만 실행하세요.', annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, inputSchema: { type: 'object', required: ['method', 'path'], additionalProperties: false, properties: { method: { type: 'string', enum: ['GET', 'POST', 'DELETE'] }, path: { type: 'string', description: '/api/haru/admin/로 시작하는 기존 관리자 경로' }, body: { type: 'object' } } } }] };
          else if (b.method === 'tools/call') {
            if (b.params?.name !== 'haru_admin_request') return send(200, { jsonrpc: '2.0', id: b.id, error: { code: -32602, message: '알 수 없는 도구입니다.' } });
            const a = b.params.arguments || {};
            try { const out = await proxy(u, a.method, a.path, a.body); result = { content: [{ type: 'text', text: JSON.stringify(out.body) }], isError: out.status >= 400 }; }
            catch (e) { result = { content: [{ type: 'text', text: e.status ? e.message : 'API 연결을 확인해 주세요.' }], isError: true }; }
          } else return send(200, { jsonrpc: '2.0', id: b.id, error: { code: -32601, message: '지원하지 않는 메서드입니다.' } });
          return send(200, { jsonrpc: '2.0', id: b.id, result });
        }
        const out = await proxy(u, m, p + url.search, m === 'GET' ? null : await body(req, haruBodyLimit(p)));
        return send(out.status, out.body);
      }
      if (m !== 'GET' && m !== 'HEAD') fail(405, '허용되지 않은 요청입니다.');
      if (p === '/' || p === '/haru/v2') { res.writeHead(302, { Location: '/haru/v2/' }); return res.end(); }
      if (p === '/haru/staff') { res.writeHead(302, { Location: '/haru/staff/' }); return res.end(); }
      let file;
      if (p === '/haru/staff/') file = 'reading-server/haru-staff.html';
      else if (p === '/admin/haru-admin.html') file = 'reading-server/public/haru-admin.html';
      else if (p === '/admin/admin-login.js') file = 'reading-server/public/admin-login.js';
      else if (p === '/haru/plan.js' || p === '/haru/icon.svg') file = p.slice(1);
      else if (p.startsWith('/haru/v2/') && !p.includes('%') && /\.(html|css|js|json|svg|png|jpg)$/.test(p.endsWith('/') ? p + 'index.html' : p)) file = (p.endsWith('/') ? p + 'index.html' : p).slice(1);
      else if (p.startsWith('/haru/')) { res.writeHead(302, { Location: 'https://wb-reading.whdudwns33.workers.dev' + p + url.search }); return res.end(); }
      else fail(404, '없는 주소입니다.');
      const full = path.resolve(ROOT, file);
      if (!full.startsWith(ROOT + path.sep)) fail(403, '허용되지 않은 파일입니다.');
      let content;
      try { content = await readFile(full); } catch { fail(404, '파일이 없습니다.'); }
      if (p === '/admin/haru-admin.html') {
        content = content.toString().replace("function renderLogin(msg){", "function renderLogin(msg){location.replace('/haru/staff/');return;");
        content = content.replace("$('#btnLogout').onclick=()=>{", "$('#btnLogout').onclick=async()=>{await fetch('/api/haru/staff/logout',{method:'POST',headers:{Authorization:'Bearer '+TOKEN}}).catch(()=>{});");
        content = content.replace('<main', '<p style="margin:12px 20px"><a href="/haru/staff/">개인 계정 · API/MCP 설정</a></p><main');
      }
      if (file.startsWith('haru/v2/') && file.endsWith('.html')) content = content.toString().replace('</nav>', '<a href="/haru/staff/">교사·관리자 로그인</a></nav>');
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };
      return send(200, m === 'HEAD' ? '' : content, types[path.extname(file)]);
    } catch (e) { send(e.status || 502, { error: e.status ? e.message : '서버 연결을 확인해 주세요.' }); }
  });
  server.requestTimeout = 35000;
  server.headersTimeout = 10000;
  return { server, db, seed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configPath = process.env.WB_HARU_CONFIG;
  if (!configPath) throw new Error('WB_HARU_CONFIG에 비공개 설정 경로를 지정해 주세요.');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const app = await createStaffServer(config);
  if (process.argv.includes('--seed')) {
    const users = JSON.parse(await readFile(process.env.WB_HARU_SEED, 'utf8'));
    users.forEach(u => app.seed(u.id, u.name, u.password));
    app.db.close(); console.log('개인 계정 준비 완료(기존 계정 유지).');
  } else {
    app.server.listen(config.port, '127.0.0.1', () => console.log('대비 앱 접속 서버 준비: 127.0.0.1:' + config.port));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.server.close(() => { app.db.close(); process.exit(0); }));
  }
}
