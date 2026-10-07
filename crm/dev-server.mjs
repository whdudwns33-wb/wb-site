// 로컬 실행·E2E 용 서버 — 배포와 무관하다. PORT=8892 node crm/dev-server.mjs
// /api/* 는 워커와 같은 handleApi 로 넘기고(env.DB 는 node:sqlite 파일 DB 위의 D1 대역),
// 정적 파일은 dist 가 있으면 dist, 없으면 app/ + crm-core.js 를 그대로 매핑해 빌드 없이도 화면이 뜨게 한다.
// HubSpot 토큰을 쓰려면 HUBSPOT_ACCESS_TOKEN 환경변수로 넣는다(파일·저장소에 두지 않는다).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { handleApi } from './crm-api.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8892);
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(here, '.local');
const DB_FILE = path.join(DATA_DIR, 'crm.sqlite');

class Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  async first() { return this.database.prepare(this.sql).get(...this.args) || null; }
  async all() { return { results: this.database.prepare(this.sql).all(...this.args) }; }
  async run() { return this.runSync(); }
  runSync() { const r = this.database.prepare(this.sql).run(...this.args); return { meta: { changes: Number(r.changes || 0) } }; }
}
class LocalD1 {
  constructor(database) { this.database = database; }
  prepare(sql) { return new Statement(this.database, sql); }
  async batch(statements) {
    this.database.exec('BEGIN IMMEDIATE');
    try { const r = statements.map(s => s.runSync()); this.database.exec('COMMIT'); return r; }
    catch (e) { this.database.exec('ROLLBACK'); throw e; }
  }
}
function openDatabase() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const database = new DatabaseSync(DB_FILE);
  const dir = path.join(here, 'migrations');
  for (const name of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) database.exec(fs.readFileSync(path.join(dir, name), 'utf8'));
  return database;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8' };
const DIST = path.join(here, 'dist');
const APP = path.join(here, 'app');
const APP_FILES = new Set(['index.html', 'app.js', 'crm.css', 'manifest.webmanifest', 'icon.svg']);

function inside(base, file) { const rel = path.relative(base, file); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); }
function resolveStatic(pathname) {
  let clean;
  try { clean = decodeURIComponent(pathname.split('?')[0]); } catch (e) { return null; }
  if (clean === '/' || clean === '') clean = '/index.html';
  if (clean === '/partner/') clean = '/partner/index.html';
  if (fs.existsSync(path.join(DIST, 'index.html'))) {
    const file = path.join(DIST, clean);
    return inside(DIST, file) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
  }
  const name = clean.slice(1);
  if (APP_FILES.has(name)) return path.join(APP, name);
  if (name === 'crm-core.js') return path.join(here, 'crm-core.js');
  if (name.startsWith('partner/') && /^[A-Za-z0-9_.-]+$/.test(name.slice(8)) && !/\.test\./.test(name)) {
    const file = path.join(here, 'partner', name.slice(8));
    return fs.existsSync(file) ? file : null;
  }
  return null;
}
function serveStatic(pathname, res) {
  const file = resolveStatic(pathname);
  if (!file || !fs.existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  fs.createReadStream(file).pipe(res);
}
function readBody(req) {
  return new Promise((resolve, reject) => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject); });
}
async function proxyApi(req, res, env) {
  const method = String(req.method || 'GET').toUpperCase();
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
  const headers = new Headers();
  for (const key of ['authorization', 'content-type', 'accept']) if (req.headers[key]) headers.set(key, String(req.headers[key]));
  const response = await handleApi(new Request('http://127.0.0.1:' + PORT + req.url, { method, headers, body }), env, {});
  const out = {};
  response.headers.forEach((v, k) => { out[k] = v; });
  const bytes = Buffer.from(await response.arrayBuffer());
  out['content-length'] = String(bytes.length);
  res.writeHead(response.status, out);
  res.end(bytes);
}

const env = { DB: new LocalD1(openDatabase()) };
if (process.env.HUBSPOT_ACCESS_TOKEN) env.HUBSPOT_ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
if (process.env.HUBSPOT_API_BASE) env.HUBSPOT_API_BASE = process.env.HUBSPOT_API_BASE;
if (process.env.WB_SALESDESK_READ_KEY) env.WB_SALESDESK_READ_KEY = process.env.WB_SALESDESK_READ_KEY;
const server = http.createServer((req, res) => {
  const pathname = String(req.url || '/').split('?')[0];
  // /partner 는 /partner/ 로 — 상대 경로(./partner.js)가 /partner.js 로 풀리지 않게(운영 자산 바인딩도 같은 리다이렉트를 한다)
  if (pathname === '/partner') { const q = String(req.url || '').slice(pathname.length); res.writeHead(301, { Location: '/partner/' + q }); res.end(); return; }
  const handler = pathname === '/api' || pathname.startsWith('/api/') ? proxyApi(req, res, env) : Promise.resolve(serveStatic(pathname, res));
  handler.catch(error => {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: false, code: 'SERVER', error: String(error && error.message || error) }));
  });
});
server.listen(PORT, '127.0.0.1', () => {
  const mode = fs.existsSync(path.join(DIST, 'index.html')) ? 'dist/' : 'app/ + crm-core.js (빌드 없음)';
  console.log('[wb-crm dev] http://127.0.0.1:' + PORT + '  static=' + mode + '  db=' + DB_FILE + '  hubspot=' + (env.HUBSPOT_ACCESS_TOKEN ? 'token' : 'none'));
});
