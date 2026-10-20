// PC는 화면과 접속만 제공한다. 고객 DB·인증·HubSpot 예약 실행은 기존 Worker 한 곳에 둔다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySecurityHeaders } from '../reading-server/sec-headers.mjs';

const UPSTREAM = 'https://wb-crm.whdudwns33.workers.dev';
const here = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json; charset=utf-8' };
const FILES = new Set(['index.html', 'app.js', 'crm.css', 'crm-core.js', 'icon.svg', 'manifest.webmanifest', 'partner/index.html', 'partner/partner.js']);
const MAX_BODY = 16 * 1024 * 1024;

export function createGateway({ hostname, username, staticDir = path.join(here, 'dist'), fetchImpl = fetch } = {}) {
  if (!/^[a-z0-9.-]+$/.test(hostname || '') || !/^[A-Za-z0-9_-]{3,64}$/.test(username || '')) throw new Error('공개 호스트와 원장 아이디가 필요합니다');
  if (!fs.existsSync(path.join(staticDir, 'index.html'))) throw new Error('먼저 crm/build.mjs를 실행하세요');
  const attempts = new Map();
  function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
  async function handle(req, res) {
    applySecurityHeaders(res);
    res.setHeader('Cache-Control', 'no-store');
    const host = String(req.headers.host || '');
    if (![hostname, '127.0.0.1:' + server.address().port, 'localhost:' + server.address().port].includes(host)) return json(res, 403, { code: 'HOST', error: '허용되지 않은 주소입니다' });
    const url = new URL(req.url, 'http://' + host);
    if (url.origin !== 'http://' + host) return json(res, 400, { code: 'URL' });
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method;
    if (!['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) return json(res, 405, { code: 'METHOD' });
    if (!['GET', 'HEAD'].includes(method) && req.headers.origin && !['https://' + hostname, 'http://' + host].includes(req.headers.origin)) return json(res, 403, { code: 'ORIGIN' });
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      if (Number(req.headers['content-length'] || 0) > MAX_BODY) return json(res, 413, { code: 'TOO_LARGE' });
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) return json(res, 413, { code: 'TOO_LARGE' });
        chunks.push(chunk);
      }
      let body = Buffer.concat(chunks);
      if (url.pathname === '/api/login' && method === 'POST') {
        const now = Date.now();
        for (const [key, item] of attempts) if (item.until <= now) attempts.delete(key);
        const ip = String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress);
        const attempt = attempts.get(ip) || { count: 0, until: now + 5 * 60 * 1000 };
        if (attempt.count >= 10 || (!attempts.has(ip) && attempts.size >= 1000)) return json(res, 429, { code: 'LOGIN_LOCKED', error: '5분 후 다시 시도해 주세요' });
        attempt.count++; attempts.set(ip, attempt);
        let input;
        try { input = JSON.parse(body.toString('utf8')); } catch { return json(res, 400, { code: 'INVALID' }); }
        if (!input || input.username !== username || typeof input.password !== 'string' || input.password.length > 72) return json(res, 401, { code: 'LOGIN_FAILED', error: '아이디 또는 비밀번호가 맞지 않습니다' });
        body = Buffer.from(JSON.stringify({ password: input.password }));
      }
      const headers = new Headers();
      for (const key of ['authorization', 'content-type', 'accept']) if (req.headers[key]) headers.set(key, req.headers[key]);
      // 고정 원본만 호출한다. 리다이렉트나 브라우저 쿠키를 따라 인증정보를 다른 서버에 보내지 않는다.
      const response = await fetchImpl(UPSTREAM + url.pathname + url.search, { method, headers, body: ['GET', 'HEAD'].includes(method) ? undefined : body, redirect: 'error', signal: AbortSignal.timeout(120000) });
      if (url.pathname === '/api/health' && response.ok && method === 'GET') return json(res, 200, { ...await response.json(), usernameRequired: true, hosting: 'pc-gateway' });
      const bytes = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') || 'application/json', 'Content-Length': bytes.length });
      res.end(method === 'HEAD' ? undefined : bytes);
      return;
    }
    if (!['GET', 'HEAD'].includes(method)) return json(res, 405, { code: 'METHOD' });
    if (url.pathname === '/partner' && !req.url.split('?')[0].endsWith('/')) { res.writeHead(301, { Location: '/partner/' + url.search }); res.end(); return; }
    const name = url.pathname === '/' ? 'index.html' : url.pathname === '/partner' ? 'partner/index.html' : url.pathname.slice(1);
    if (!FILES.has(name)) return json(res, 404, { code: 'NOT_FOUND' });
    const bytes = await fs.promises.readFile(path.join(staticDir, name));
    res.writeHead(200, { 'Content-Type': MIME[path.extname(name)] || 'application/octet-stream', 'Content-Length': bytes.length });
    res.end(method === 'HEAD' ? undefined : bytes);
  }
  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (res.headersSent) { res.destroy(); return; }
      json(res, 502, { code: 'UPSTREAM', error: '데이터 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요' });
    });
  });
  server.requestTimeout = 130000;
  server.headersTimeout = 15000;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 18962);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT가 올바르지 않습니다');
  createGateway({ hostname: process.env.CRM_PUBLIC_HOST, username: process.env.CRM_ADMIN_USERNAME }).listen(port, '127.0.0.1', () => console.log('[wb-crm] PC 접속 서버 준비 완료'));
}
