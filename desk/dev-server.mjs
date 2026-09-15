// 로컬 실행·E2E 용 서버 — 배포와 무관하다. PORT=8891 node desk/dev-server.mjs
// /api/* 는 워커와 같은 handleApi 로 넘기고(env.DB 는 node:sqlite 파일 DB 위의 D1 대역),
// 정적 파일은 dist 가 있으면 dist, 없으면 app/·lib/·../shared 를 그대로 매핑해 빌드 없이도 화면이 뜨게 한다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { handleApi } from './desk-api.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8891);
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(here, '.local');
const DB_FILE = path.join(DATA_DIR, 'desk.sqlite');

/* ── D1 대역 (worker.test.mjs 의 TestD1 과 같은 표면) ───────────────────── */
class Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.args = []; }
  // D1 은 BLOB 에 ArrayBuffer 를 받는다(문서 형식). node:sqlite 는 Uint8Array 만 받으므로 대역이 바꿔 준다.
  bind(...args) { this.args = args.map(a => (a instanceof ArrayBuffer ? new Uint8Array(a) : a)); return this; }
  async first() { return this.database.prepare(this.sql).get(...this.args) || null; }
  async all() { return { results: this.database.prepare(this.sql).all(...this.args) }; }
  async run() {
    const result = this.database.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(result.changes || 0) } };
  }
  runSync() {
    const result = this.database.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(result.changes || 0) } };
  }
}

class LocalD1 {
  constructor(database) { this.database = database; }
  prepare(sql) { return new Statement(this.database, sql); }
  // D1 batch 는 한 트랜잭션 — changes() 가드(요청 원장 이벤트)가 이를 전제한다.
  async batch(statements) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => statement.runSync());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function openDatabase() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const database = new DatabaseSync(DB_FILE);
  // 마이그레이션은 전부 IF NOT EXISTS 라 시작할 때마다 순서대로 다시 적용해도 된다(배포 워크플로우와 같은 방식).
  const dir = path.join(here, 'migrations');
  for (const name of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    database.exec(fs.readFileSync(path.join(dir, name), 'utf8'));
  }
  return database;
}

/* ── 정적 파일 ───────────────────────────────────────────────────────── */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff'
};
const DIST = path.join(here, 'dist');
const APP = path.join(here, 'app');
const LIB = path.join(here, 'lib');
const SHARED = path.join(here, '..', 'shared');
const APP_FILES = new Set(['app.js', 'desk-core.js', 'desk.css', 'manifest.webmanifest', 'icon.svg', 'index.html']);

function inside(base, file) {
  const rel = path.relative(base, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 요청 경로를 실제 파일로. 없으면 null. dist 가 있으면 그것만 본다(빌드 결과 검증용). */
function resolveStatic(pathname) {
  let clean;
  try { clean = decodeURIComponent(pathname.split('?')[0]); } catch (error) { return null; }
  if (clean === '/' || clean === '') clean = '/index.html';
  if (fs.existsSync(path.join(DIST, 'index.html'))) {
    const file = path.join(DIST, clean);
    return inside(DIST, file) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
  }
  const name = clean.slice(1);
  if (APP_FILES.has(name)) return path.join(APP, name);
  // 런북 팩은 runbook-ui 가 문서 기준 './runbook-pack.json' 으로 읽는다(빌드는 dist 루트에도 복사)
  if (name === 'runbook-pack.json') return path.join(LIB, 'runbook-pack.json');
  if (name.startsWith('lib/')) {
    const libName = name.slice(4);
    if (!/^[A-Za-z0-9_.-]+$/.test(libName) || libName.endsWith('.test.cjs')) return null;
    const own = path.join(LIB, libName);
    if (fs.existsSync(own)) return own;
    const shared = path.join(SHARED, libName);
    return libName === 'external-links.js' && fs.existsSync(shared) ? shared : null;
  }
  return null;
}

function serveStatic(pathname, res) {
  const file = resolveStatic(pathname);
  if (!file || !fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex'
  });
  fs.createReadStream(file).pipe(res);
}

/* ── HTTP ───────────────────────────────────────────────────────────── */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function proxyApi(req, res, env) {
  const method = String(req.method || 'GET').toUpperCase();
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
  const headers = new Headers();
  for (const key of ['authorization', 'content-type', 'accept']) {
    if (req.headers[key]) headers.set(key, String(req.headers[key]));
  }
  const request = new Request('http://127.0.0.1:' + PORT + req.url, { method, headers, body });
  const response = await handleApi(request, env, {});
  const out = {};
  response.headers.forEach((value, key) => { out[key] = value; });
  const bytes = Buffer.from(await response.arrayBuffer());
  out['content-length'] = String(bytes.length);
  res.writeHead(response.status, out);
  res.end(bytes);
}

const env = { DB: new LocalD1(openDatabase()) };
const server = http.createServer((req, res) => {
  const pathname = String(req.url || '/').split('?')[0];
  const handler = pathname === '/api' || pathname.startsWith('/api/')
    ? proxyApi(req, res, env)
    : Promise.resolve(serveStatic(pathname, res));
  handler.catch(error => {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: false, code: 'SERVER', error: String(error && error.message || error) }));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const mode = fs.existsSync(path.join(DIST, 'index.html')) ? 'dist/' : 'app/ + lib/ + ../shared (빌드 없음)';
  console.log('[wb-desk dev] http://127.0.0.1:' + PORT + '  static=' + mode + '  db=' + DB_FILE);
});
