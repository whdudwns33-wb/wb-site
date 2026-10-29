import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash, createDecipheriv} from 'node:crypto';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {readWorkbenchRelease, parsePort} from './serve.mjs';
import {createHostStore, HttpError} from './host-store.mjs';
import {loadProtectedAppKey} from './host-crypto.mjs';
import {createWorkbenchMcp} from './host-mcp.mjs';

const here = new URL('.', import.meta.url), cookieName = '__Host-wb_session';
const assets = {account: readFileSync(new URL('account.html', here)), shared: readFileSync(new URL('shared-client.js', here))};
const digest = value => createHash('sha256').update(value).digest('hex');
function decrypt(envelope, key) {
  const bytes = Buffer.from(envelope.c, 'base64'), cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.i, 'base64'));
  cipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([cipher.update(bytes.subarray(0, -16)), cipher.final()]);
}
export function prepareAccountApp(release, key) {
  const payload = JSON.parse(release.index.toString('utf8').match(/const P=(\{[^\r\n]+\});/)[1]);
  let html = decrypt(payload, key).toString('utf8');
  decrypt(release.envelope, key);
  const replacements = [
    ['let db=load();', 'let db=window.WB_SHARED.load();'],
    ['const text=JSON.stringify(next);localStorage.setItem(LS,text);db=next;_savedDb=text;', 'const text=window.WB_SHARED.save(next);db=next;_savedDb=text;'],
  ];
  for (const [from, to] of replacements) {
    if (html.split(from).length !== 2) throw Error('The new workbench build is incompatible with shared record storage.');
    html = html.replace(from, to);
  }
  return Buffer.from('<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script>window.__wbKey=' + JSON.stringify(key.toString('base64')) + ';</script><script src="/workbench/shared-client.js"></script>' + html);
}
async function jsonBody(request) {
  if (!String(request.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'JSON 형식으로 요청하세요.');
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 8 * 1024 * 1024) throw new HttpError(413, '요청 자료가 너무 큽니다.'); chunks.push(chunk); }
  if (size === 0) return {};
  try { const data = JSON.parse(Buffer.concat(chunks).toString('utf8'), (key, value) => { if (['__proto__', 'constructor', 'prototype'].includes(key)) throw Error(); return value; }); if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error(); return data; }
  catch { throw new HttpError(400, 'JSON 자료 형식을 확인하세요.'); }
}
export function createAccountHost({directory, appKey, store, publicOrigin = 'https://workbench.wbcowork.com'}) {
  const origin = new URL(publicOrigin), release = readWorkbenchRelease(directory), app = prepareAccountApp(release, appKey);
  const health = {ok: true, build: release.envelope.t, authentication: 'required', hashes: {'index.html': digest(release.index), 'bulk.enc.json': digest(release.bulk)}};
  const loginAttempts = new Map();
  const server = createServer(async (request, response) => {
    const send = (status, data, type = 'application/json; charset=utf-8', extra = {}) => {
      const body = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
      response.writeHead(status, {'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'private, no-store, no-transform', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'", ...extra});
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    const redirect = path => send(302, '', 'text/plain', {Location: path});
    const setSession = session => response.setHeader('Set-Cookie', cookieName + '=' + session.token + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800');
    try {
      const host = String(request.headers.host || '');
      if (![origin.host, '127.0.0.1:' + request.socket.localPort, 'localhost:' + request.socket.localPort].includes(host)) throw new HttpError(403, '허용하지 않는 접속 주소입니다.');
      const incomingOrigin = request.headers.origin;
      if (incomingOrigin && incomingOrigin !== origin.origin) throw new HttpError(403, '허용하지 않는 요청 출처입니다.');
      if (host === origin.host && request.headers['x-forwarded-proto'] === 'http') return send(308, '', 'text/plain', {Location: origin.origin + request.url});
      const url = new URL(request.url, origin), path = url.pathname, method = request.method;
      if (path === '/healthz' && ['GET', 'HEAD'].includes(method)) return send(200, health);
      if (['/login', '/account'].includes(path) && ['GET', 'HEAD'].includes(method)) return send(200, assets.account, 'text/html; charset=utf-8');
      const bearer = String(request.headers.authorization || '').match(/^Bearer ([A-Za-z0-9_-]{1,100})$/)?.[1];
      const raw = bearer || String(request.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
      const principal = () => {
        const session = store.authenticate(raw, !!bearer);
        if (!session) throw new HttpError(401, '로그인이 필요합니다.');
        return session;
      };
      if (path === '/api/auth/login' && method === 'POST') {
        const ip = String(request.headers['cf-connecting-ip'] || request.socket.remoteAddress), now = Date.now();
        let attempts = loginAttempts.get(ip);
        if (!attempts || now - attempts.start > 900000) { attempts = {start: now, count: 0}; loginAttempts.set(ip, attempts); }
        if (++attempts.count > 20) throw new HttpError(429, '로그인 요청이 많습니다. 15분 후 다시 시도하세요.');
        if (loginAttempts.size > 10000) for (const [key, value] of loginAttempts) if (now - value.start > 900000) loginAttempts.delete(key);
        const body = await jsonBody(request), session = await store.login(body.username, body.password);
        setSession(session); return send(200, {user: session.user, csrf: session.csrf});
      }
      if (path === '/' || path === '/workbench') return redirect('/workbench/');
      let session;
      try { session = principal(); } catch (error) {
        if (path.startsWith('/api/') || path === '/mcp') return send(401, {error: error.message}, undefined, { 'WWW-Authenticate': 'Bearer realm="workbench"' });
        if (['/workbench/', '/workbench/index.html'].includes(path)) return redirect('/login');
        return send(404, {error: '찾을 수 없습니다.'});
      }
      if (path === '/api/auth/me' && method === 'GET') return send(200, {user: session.user, csrf: session.csrf});
      const accountPath = ['/api/auth/password', '/api/auth/logout'].includes(path) || path.startsWith('/api/account/') || path.startsWith('/api/admin/');
      if (accountPath && session.bearer) throw new HttpError(403, '계정 관리는 브라우저 로그인으로 진행하세요.');
      if (path === '/api/auth/logout' && method === 'POST') {
        if (incomingOrigin !== origin.origin || !store.checkCsrf(session, request.headers['x-csrf-token'])) throw new HttpError(403, '요청 확인에 실패했습니다.');
        store.logout(session); response.setHeader('Set-Cookie', cookieName + '=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'); return send(200, {loggedOut: true});
      }
      if (path === '/api/auth/password' && method === 'POST') {
        const body = await jsonBody(request); session = principal();
        if (incomingOrigin !== origin.origin || !store.checkCsrf(session, request.headers['x-csrf-token'])) throw new HttpError(403, '요청 확인에 실패했습니다.');
        const changed = await store.changePassword(session, body.currentPassword, body.nextPassword); setSession(changed); return send(200, {user: changed.user, csrf: changed.csrf});
      }
      if (session.user.mustChangePassword) {
        if (path.startsWith('/workbench')) return redirect('/account?change=1');
        throw new HttpError(428, '임시 비밀번호를 먼저 변경하세요.');
      }
      if (path === '/mcp') {
        if (!bearer) throw new HttpError(401, 'MCP 연결 키가 필요합니다.');
        const body = method === 'POST' ? await jsonBody(request) : undefined;
        const current = () => { const p = principal(); if (p.user.mustChangePassword) throw new HttpError(428, '비밀번호를 변경하세요.'); return p; };
        const mcp = createWorkbenchMcp({summary: () => { current(); return store.summary(); }, listStudents: args => { current(); return store.listStudents(args); }, student: (id, section) => { current(); return store.student(id, section); }, saveStudent: (id, data, revision) => store.saveStudent(id, data, revision, current().user.id)});
        const transport = new StreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true});
        response.setHeader('Cache-Control', 'private, no-store, no-transform');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.on('close', () => { transport.close().catch(() => {}); mcp.close().catch(() => {}); });
        await mcp.connect(transport); await transport.handleRequest(request, response, body); return;
      }
      if (['GET', 'HEAD'].includes(method)) {
        if (['/workbench/', '/workbench/index.html'].includes(path)) return send(200, app, 'text/html; charset=utf-8');
        if (path === '/workbench/bulk.enc.json') return send(200, release.bulk);
        if (path === '/workbench/shared-client.js') return send(200, assets.shared, 'text/javascript; charset=utf-8');
        if (path === '/api/admin/users') return send(200, {items: store.listUsers()});
        if (path === '/api/account/tokens') return send(200, {items: store.listTokens(session)});
        if (path === '/api/workspace') return send(200, store.snapshot());
        if (path === '/api/summary') return send(200, store.summary());
        if (path === '/api/students') return send(200, store.listStudents({query: url.searchParams.get('query') || '', offset: Number(url.searchParams.get('offset') || 0), limit: Number(url.searchParams.get('limit') || 20)}));
        if (path.startsWith('/api/students/')) return send(200, store.student(decodeURIComponent(path.slice('/api/students/'.length)), url.searchParams.get('section') || 'all'));
        if (path === '/api/openapi.json') return send(200, {openapi: '3.1.0', info: {title: 'WB Workbench API', version: '1.0.0'}, servers: [{url: origin.origin}], security: [{bearerAuth: []}], components: {securitySchemes: {bearerAuth: {type: 'http', scheme: 'bearer'}}}, paths: Object.fromEntries(['/api/summary', '/api/students', '/api/workspace', '/api/students/{id}'].map(p => [p, {...(p.includes('{id}') ? {parameters: [{in: 'path', name: 'id', required: true, schema: {type: 'string'}}]} : {}), get: {summary: '권한 있는 공용 상담 자료 조회', responses: {'200': {description: '자료와 현재 revision'}, '401': {description: '인증 필요'}}}, ...(['/api/workspace', '/api/students/{id}'].includes(p) ? {put: {summary: 'revision 조건부 저장', requestBody: {required: true, content: {'application/json': {schema: {type: 'object', required: ['revision', 'data'], properties: {revision: {type: 'integer', minimum: 1}, data: {type: 'object'}}}}}}, responses: {'200': {description: '저장 완료'}, '409': {description: '버전 충돌'}}}} : {})}]))});
        return send(404, {error: '찾을 수 없습니다.'});
      }
      const body = await jsonBody(request); session = principal();
      if (session.user.mustChangePassword) throw new HttpError(428, '임시 비밀번호를 먼저 변경하세요.');
      if (!session.bearer && (incomingOrigin !== origin.origin || !store.checkCsrf(session, request.headers['x-csrf-token']))) throw new HttpError(403, '요청 확인에 실패했습니다.');
      const resetTarget = path.match(/^\/api\/admin\/users\/([a-f0-9-]{36})\/reset-password$/)?.[1];
      if (resetTarget && method === 'POST') return send(200, await store.resetPassword(session, resetTarget, body.currentPassword, body.temporaryPassword));
      if (path === '/api/workspace' && method === 'PUT') return send(200, store.saveSnapshot(body.data, body.revision, session.user.id));
      if (path.startsWith('/api/students/') && method === 'PUT') return send(200, store.saveStudent(decodeURIComponent(path.slice('/api/students/'.length)), body.data, body.revision, session.user.id));
      if (path === '/api/account/tokens' && method === 'POST') return send(201, store.issueToken(session, body.name));
      if (path.startsWith('/api/account/tokens/') && method === 'DELETE') return send(200, store.revokeToken(session, path.slice('/api/account/tokens/'.length)));
      send(405, {error: '허용하지 않는 요청 방식입니다.'});
    } catch (error) {
      if (!response.headersSent) send(error.status || 500, {error: error.status ? error.message : '서버 요청을 처리하지 못했습니다. 저장 자료는 보존됩니다.'});
      else response.end();
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const root = process.env.WB_WORKBENCH_RUNTIME;
    if (!root) throw Error('WB_WORKBENCH_RUNTIME is required.');
    const key = loadProtectedAppKey(join(root, 'protected', 'app-key.dpapi'));
    const store = createHostStore(join(root, 'protected', 'accounts.sqlite'), key);
    if (!store.listUsers().length) throw Error('Initialize administrator accounts before starting.');
    store.snapshot();
    const server = createAccountHost({directory: process.env.WB_WORKBENCH_DIR, appKey: key, store});
    server.on('close', () => store.close());
    server.on('error', () => { console.error('The authenticated workbench host could not start.'); process.exitCode = 1; });
    server.listen(parsePort(process.env.PORT), '127.0.0.1', () => console.log('Authenticated workbench host ready.'));
  } catch { console.error('Authenticated host initialization failed; check protected account and key configuration.'); process.exitCode = 1; }
}
