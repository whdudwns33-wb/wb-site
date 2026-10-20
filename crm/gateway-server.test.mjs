import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import { createGateway } from './gateway-server.mjs';

test('PC gateway: fixed upstream, username/password, auth forwarding, public boundary', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-gateway-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>가상 앱</h1>');
  const calls = [];
  const server = createGateway({ hostname: 'salesdesk.example.com', username: 'test-owner', staticDir: dir,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/api/health')) return Response.json({ ok: true, setup: true, hubspot: true });
      if (url.endsWith('/api/login')) return Response.json({ code: 'LOGIN_FAILED' }, { status: 401 });
      if (url.endsWith('/api/error')) throw new Error('private upstream information');
      return Response.json({ ok: true });
    } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (name, body, headers = {}) => fetch(base + name, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    const home = await fetch(base);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('x-robots-tag'), /noindex/);
    assert.equal(home.headers.get('x-frame-options'), 'DENY');
    assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal((await (await fetch(base + '/api/health')).json()).usernameRequired, true);
    const before = calls.length;
    assert.equal((await post('/api/login', { password: 'synthetic-only' })).status, 401);
    assert.equal((await post('/api/login', { username: 'wrong', password: 'synthetic-only' })).status, 401);
    assert.equal(calls.length, before, 'wrong usernames do not reach the owner account');
    assert.equal((await post('/api/login///', { password: 'synthetic-only' }, { 'cf-connecting-ip': 'synthetic-alias' })).status, 401);
    assert.equal(calls.length, before, 'trailing slashes cannot bypass the username gate');
    assert.equal((await post('/api/login', { username: 'test-owner', password: 'synthetic-only' })).status, 401, 'upstream password rejection is preserved');
    assert.deepEqual(JSON.parse(calls.at(-1).options.body), { password: 'synthetic-only' });
    await fetch(base + '/api/docs?collection=leads', { headers: { authorization: 'Bearer fake-session', cookie: 'unrelated=private' } });
    assert.equal(calls.at(-1).url, 'https://wb-crm.whdudwns33.workers.dev/api/docs?collection=leads');
    assert.equal(calls.at(-1).options.headers.get('authorization'), 'Bearer fake-session');
    assert.equal(calls.at(-1).options.headers.has('cookie'), false);
    assert.equal(calls.at(-1).options.redirect, 'error');
    assert.equal(await new Promise((resolve, reject) => { http.get(base + '/api/health', { headers: { host: 'untrusted.example.com' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject); }), 403);
    assert.equal((await post('/api/docs', {}, { origin: 'https://untrusted.example.com' })).status, 403);
    assert.equal((await fetch(base + '//untrusted.example.com/api/health')).status, 400);
    for (const name of ['/.env', '/gateway-server.mjs', '/.local/crm.sqlite', '/crm-api.mjs', '/partner/../crm-api.mjs']) assert.equal((await fetch(base + name)).status, 404);
    const error = await fetch(base + '/api/error');
    assert.equal(error.status, 502); assert.doesNotMatch(await error.text(), /private upstream/);
    assert.equal((await post('/api/docs', { text: 'x'.repeat(16 * 1024 * 1024) })).status, 413);
    for (let i = 0; i < 7; i++) await post('/api/login', { username: 'wrong', password: 'synthetic-only' });
    assert.equal((await post('/api/login', { username: 'test-owner', password: 'synthetic-only' })).status, 429);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true }); }
});

test('username field and login payload are conditional; original Worker login is preserved', async () => {
  const source = fs.readFileSync(new URL('./app/app.js', import.meta.url), 'utf8').replace(/\nstartApp\(\);\s*$/, '\n');
  const core = (await import('./crm-core.js')).default;
  const values = { 'f-username': 'test-owner', 'f-pw': 'synthetic-only' }, calls = [];
  const ctx = vm.createContext({ WBCrmCore: core, document: { querySelector: id => ({ value: values[id.slice(1)] || '' }), addEventListener() {} }, window: { addEventListener() {} }, navigator: {}, localStorage: { getItem() { return null; } }, location: { hash: '' }, setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {}, console });
  vm.runInContext(source, ctx);
  ctx.capture = body => calls.push(JSON.parse(JSON.stringify(body)));
  vm.runInContext("api = async (url, body) => { capture(body); throw new Error('synthetic stop'); }; toast = () => {};", ctx);
  vm.runInContext('boot.health = { setup: true, usernameRequired: true };', ctx);
  assert.match(vm.runInContext('viewLogin()', ctx), /autocomplete="username"/);
  await vm.runInContext('doLogin()', ctx);
  assert.equal(calls[0].username, 'test-owner');
  vm.runInContext('boot.health = { setup: true };', ctx);
  assert.doesNotMatch(vm.runInContext('viewLogin()', ctx), /f-username/);
  await vm.runInContext('doLogin()', ctx);
  assert.equal('username' in calls[1], false);
});
