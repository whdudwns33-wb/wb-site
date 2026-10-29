import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname, basename, resolve} from 'node:path';
import {randomBytes, createCipheriv} from 'node:crypto';
import {get as httpGet} from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fileURLToPath} from 'node:url';
import {createAccountHost, prepareAccountApp} from './account-host.mjs';
import {createHostStore} from './host-store.mjs';
import {readWorkbenchRelease} from './serve.mjs';

const origin = 'https://workbench.wbcowork.com', initial = 'initial-fixture', next = 'new-fixture-password';
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'wb-account-test-')), key = randomBytes(32);
  const envelope = plain => { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv); return {i: iv.toString('base64'), c: Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]).toString('base64')}; };
  const app = '<title>Synthetic workbench</title><script>let db=load();function save(next=db){try{const text=JSON.stringify(next);localStorage.setItem(LS,text);db=next;_savedDb=text;}catch{}}</script>';
  const payload = {...envelope(app), s: randomBytes(16).toString('base64'), it: 310000};
  writeFileSync(join(root, 'index.html'), '<script>const P=' + JSON.stringify(payload) + ';</script>');
  writeFileSync(join(root, 'bulk.enc.json'), JSON.stringify({...envelope('synthetic compressed data'), v: 1, inner: 'gzip(bulk-data.json)', t: '0123abcd'}));
  const store = createHostStore(join(root, 'test.sqlite'), key);
  let server;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    store.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('wb-account-test-'));
    rmSync(root, {recursive: true});
  });
  await store.bootstrap([{username: 'owner-test', name: '테스트 관리자 A', password: initial}, {username: 'wb테스트', name: '테스트 관리자 B', password: initial}], {students: [{id: 'fake-1', name: 'Synthetic_Private_Student', records: [{text: 'Synthetic_Private_Record'}], consult: {reports: [], jeongsi: {exams: [], plans: [], history: []}}}], meta: {fixture: true}});
  server = createAccountHost({directory: root, appKey: key, store});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (path, {method = 'GET', body, cookie, csrf, bearer, requestOrigin = origin, extra = {}} = {}) => {
    const response = await fetch(base + path, {method, redirect: 'manual', headers: {'Content-Type': 'application/json', ...(requestOrigin ? {Origin: requestOrigin} : {}), ...(cookie ? {Cookie: cookie} : {}), ...(csrf ? {'X-CSRF-Token': csrf} : {}), ...(bearer ? {Authorization: 'Bearer ' + bearer} : {}), ...extra}, body: body === undefined ? undefined : JSON.stringify(body)});
    const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return {status: response.status, headers: response.headers, data};
  };
  const login = async username => { const response = await call('/api/auth/login', {method: 'POST', body: {username, password: initial}}); assert.equal(response.status, 200); return {cookie: response.headers.get('set-cookie').split(';')[0], csrf: response.data.csrf, response}; };
  const change = async auth => { const response = await call('/api/auth/password', {...auth, method: 'POST', body: {currentPassword: initial, nextPassword: next}}); assert.equal(response.status, 200); return {cookie: response.headers.get('set-cookie').split(';')[0], csrf: response.data.csrf}; };
  return {root, key, store, base, call, login, change};
}

test('first-login change is mandatory for both equal administrators; sessions, CSRF and token revocation are enforced', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/workbench/')).headers.get('location'), '/login');
  assert.equal((await f.call('/workbench/bulk.enc.json')).status, 404);
  for (const path of ['/api/workspace', '/mcp']) assert.equal((await f.call(path)).status, 401);
  assert.equal((await f.call('/protected/test.sqlite')).status, 404);
  const owner = await f.login('owner-test'), teacher = await f.login('wb테스트');
  assert.equal(owner.response.data.user.role, teacher.response.data.user.role);
  assert.equal(owner.response.data.user.mustChangePassword, true);
  assert.match(owner.response.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Strict/);
  assert.equal((await f.call('/api/workspace', owner)).status, 428);
  assert.equal((await f.call('/api/account/tokens', {...owner, method: 'POST', body: {name: 'blocked'}})).status, 428);
  assert.equal((await f.call('/api/auth/password', {...owner, csrf: 'wrong', method: 'POST', body: {currentPassword: initial, nextPassword: next}})).status, 403);
  assert.equal((await f.call('/api/auth/password', {...owner, method: 'POST', body: {currentPassword: initial, nextPassword: 'short'}})).status, 400);
  const changed = await f.change(owner);
  assert.equal((await f.call('/api/auth/me', owner)).status, 401);
  assert.equal((await f.call('/api/auth/me', changed)).data.user.mustChangePassword, false);
  const html = await f.call('/workbench/', changed);
  assert.equal(html.status, 200); assert.match(html.data, /WB_SHARED/); assert.ok(html.headers.get('cache-control').includes('no-store'));
  assert.equal((await f.call('/api/workspace', {...changed, requestOrigin: 'https://attacker.invalid'})).status, 403);
  const badHost = await new Promise((resolve, reject) => { const request = httpGet(f.base + '/api/workspace', {headers: {Host: 'attacker.invalid'}}, response => { response.resume(); resolve(response.statusCode); }); request.on('error', reject); });
  assert.equal(badHost, 403);
  const issued = await f.call('/api/account/tokens', {...changed, method: 'POST', body: {name: 'test integration'}});
  assert.equal(issued.status, 201);
  assert.equal((await f.call('/api/summary', {bearer: issued.data.token})).status, 200);
  assert.equal((await f.call('/api/admin/users', {bearer: issued.data.token})).status, 403);
  assert.equal((await f.call('/api/account/tokens/' + issued.data.id, {...changed, method: 'DELETE'})).status, 200);
  assert.equal((await f.call('/api/summary', {bearer: issued.data.token})).status, 401);
  const changedTeacher = await f.change(teacher);
  assert.equal((await f.call('/api/admin/users', changedTeacher)).data.items.length, 2);
  const spec = (await f.call('/api/openapi.json', changedTeacher)).data;
  assert.equal(spec.paths['/api/students/{id}'].parameters[0].required, true);
  assert.deepEqual(spec.paths['/api/workspace'].put.requestBody.content['application/json'].schema.required, ['revision', 'data']);
  assert.equal((await f.call('/api/auth/logout', {...changedTeacher, method: 'POST'})).status, 200);
  assert.equal((await f.call('/api/workspace', changedTeacher)).status, 401);
});

test('shared saves preserve original records and reject concurrent overwrites; persisted student data is encrypted', async t => {
  const f = await fixture(t), owner = await f.change(await f.login('owner-test')), teacher = await f.change(await f.login('wb테스트'));
  const before = await f.call('/api/workspace', owner), edited = structuredClone(before.data.data);
  edited.students[0].records.push({text: 'Synthetic_second_record'});
  const saved = await f.call('/api/workspace', {...owner, method: 'PUT', body: {revision: before.data.revision, data: edited}});
  assert.equal(saved.status, 200);
  const conflict = await f.call('/api/workspace', {...teacher, method: 'PUT', body: {revision: before.data.revision, data: before.data.data}});
  assert.equal(conflict.status, 409);
  assert.equal((await f.call('/api/workspace', teacher)).data.data.students[0].records.length, 2);
  assert.equal((await f.call('/api/workspace', {...owner, method: 'PUT', body: {revision: saved.data.revision, data: {students: [{id: 'duplicate', name: 'A'}, {id: 'duplicate', name: 'B'}]}}})).status, 400);
  assert.equal((await f.call('/api/workspace', {...owner, csrf: 'wrong', method: 'PUT', body: {revision: saved.data.revision, data: edited}})).status, 403);
  assert.equal((await f.call('/api/students?limit=101', teacher)).status, 400);
  assert.equal((await f.call('/api/students/fake-1?section=plans', teacher)).status, 200);
  assert.equal((await f.call('/api/students/fake-1', {...teacher, method: 'PUT', body: {revision: saved.data.revision, data: {id: 'fake-1', name: 'Synthetic_Private_Student'}}})).status, 400);
  for (const file of readdirSync(f.root).filter(name => name.startsWith('test.sqlite'))) {
    const bytes = readFileSync(join(f.root, file));
    assert.equal(bytes.includes(Buffer.from('Synthetic_Private_Student')), false);
    assert.equal(bytes.includes(Buffer.from(initial)), false);
  }
  assert.throws(() => prepareAccountApp(readWorkbenchRelease(f.root), randomBytes(32)));
});

test('official MCP client can discover, read and conditionally save; invalid and revoked bearer tokens fail', async t => {
  const f = await fixture(t), owner = await f.change(await f.login('owner-test'));
  const issued = await f.call('/api/account/tokens', {...owner, method: 'POST', body: {name: 'MCP fixture'}});
  const client = new Client({name: 'workbench-qa', version: '1.0.0'});
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(f.base + '/mcp'), {requestInit: {headers: {Authorization: 'Bearer ' + issued.data.token}}}));
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 4);
  const summary = await client.callTool({name: 'workbench_get_summary', arguments: {}});
  assert.equal(summary.structuredContent.students, 1);
  const search = await client.callTool({name: 'workbench_list_students', arguments: {limit: 1}});
  assert.equal(search.structuredContent.items[0].id, 'fake-1');
  const student = await client.callTool({name: 'workbench_get_student', arguments: {student_id: 'fake-1', section: 'all'}});
  student.structuredContent.data.records.push({text: 'MCP synthetic record'});
  const saved = await client.callTool({name: 'workbench_save_student', arguments: {student_id: 'fake-1', expected_revision: student.structuredContent.revision, data: student.structuredContent.data}});
  assert.equal(saved.isError, undefined);
  const conflict = await client.callTool({name: 'workbench_save_student', arguments: {student_id: 'fake-1', expected_revision: student.structuredContent.revision, data: student.structuredContent.data}});
  assert.equal(conflict.isError, true);
  assert.equal((await f.call('/mcp', {method: 'POST', bearer: 'wrong', body: {jsonrpc: '2.0', id: 1, method: 'tools/list'}})).status, 401);
  await f.call('/api/account/tokens/' + issued.data.id, {...owner, method: 'DELETE'});
  assert.equal((await f.call('/mcp', {bearer: issued.data.token})).status, 401);
  await client.close();
  const localToken = await f.call('/api/account/tokens', {...owner, method: 'POST', body: {name: 'stdio fixture'}});
  const localClient = new Client({name: 'workbench-stdio-qa', version: '1.0.0'});
  t.after(() => localClient.close());
  await localClient.connect(new StdioClientTransport({command: process.execPath, args: [fileURLToPath(new URL('host-mcp.mjs', import.meta.url))], env: {...process.env, WB_WORKBENCH_URL: f.base, WB_WORKBENCH_API_TOKEN: localToken.data.token}, stderr: 'pipe'}));
  assert.equal((await localClient.callTool({name: 'workbench_get_summary', arguments: {}})).structuredContent.students, 1);
  await localClient.close();
  await f.call('/api/account/tokens/' + localToken.data.id, {...owner, method: 'DELETE'});
});

test('login failure lockout is persisted and account bootstrap never overwrites existing records', async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.bootstrap([], {students: []}), error => error.status === 409);
  for (let i = 0; i < 5; i++) assert.equal((await f.call('/api/auth/login', {method: 'POST', body: {username: 'owner-test', password: 'incorrect-fixture'}})).status, 401);
  assert.equal((await f.call('/api/auth/login', {method: 'POST', body: {username: 'owner-test', password: initial}})).status, 429);
  assert.equal(f.store.snapshot().data.students.length, 1);
});

test('administrator reset requires reauthentication, revokes only the target and preserves all counseling data', async t => {
  const f = await fixture(t), owner = await f.change(await f.login('owner-test')), teacher = await f.change(await f.login('wb테스트'));
  const users = (await f.call('/api/admin/users', owner)).data.items, target = users.find(u => u.username === 'wb테스트'), actor = users.find(u => u.username === 'owner-test');
  const route = '/api/admin/users/' + target.id + '/reset-password', body = {currentPassword: next, temporaryPassword: 'temp'};
  const before = f.store.snapshot(), targetToken = (await f.call('/api/account/tokens', {...teacher, method: 'POST', body: {name: 'target'}})).data.token;
  const actorToken = (await f.call('/api/account/tokens', {...owner, method: 'POST', body: {name: 'actor'}})).data.token;
  assert.equal((await f.call(route, {method: 'POST', body})).status, 401);
  assert.equal((await f.call(route, {bearer: actorToken, method: 'POST', body})).status, 403);
  assert.equal((await f.call(route, {...owner, csrf: 'wrong', method: 'POST', body})).status, 403);
  assert.equal((await f.call(route, {...owner, requestOrigin: 'https://attacker.invalid', method: 'POST', body})).status, 403);
  assert.equal((await f.call('/api/admin/users/' + actor.id + '/reset-password', {...owner, method: 'POST', body})).status, 400);
  assert.equal((await f.call(route, {...owner, method: 'POST', body: {...body, temporaryPassword: 'abc'}})).status, 400);
  assert.equal((await f.call(route, {...owner, method: 'POST', body: {...body, currentPassword: 'wrong-fixture'}})).status, 401);
  assert.deepEqual(f.store.snapshot(), before);
  const reset = await f.call(route, {...owner, method: 'POST', body});
  assert.equal(reset.status, 200);assert.equal(reset.data.user.mustChangePassword, true);assert.equal(reset.data.temporaryPassword, undefined);
  assert.equal((await f.call('/api/auth/me', teacher)).status, 401);
  assert.equal((await f.call('/api/summary', {bearer: targetToken})).status, 401);
  assert.equal((await f.call('/api/summary', {bearer: actorToken})).status, 200);
  assert.equal((await f.call('/api/auth/login', {method: 'POST', body: {username: target.username, password: next}})).status, 401);
  const login = await f.call('/api/auth/login', {method: 'POST', body: {username: target.username, password: body.temporaryPassword}});
  assert.equal(login.status, 200);assert.equal(login.data.user.mustChangePassword, true);
  const resetAuth = {cookie: login.headers.get('set-cookie').split(';')[0], csrf: login.data.csrf};
  assert.equal((await f.call('/api/workspace', resetAuth)).status, 428);
  assert.equal((await f.call('/api/admin/users/' + actor.id + '/reset-password', {...resetAuth, method: 'POST', body})).status, 428);
  assert.equal((await f.call('/api/auth/password', {...resetAuth, method: 'POST', body: {currentPassword: body.temporaryPassword, nextPassword: 'new-after-reset-fixture'}})).status, 200);
  assert.deepEqual(f.store.snapshot(), before);
});

test('reset password checks persistently lock after repeated failures without changing the target', async t => {
  const f = await fixture(t), owner = await f.change(await f.login('owner-test'));
  const target = (await f.call('/api/admin/users', owner)).data.items.find(u => u.username === 'wb테스트'), route = '/api/admin/users/' + target.id + '/reset-password';
  const before = f.store.snapshot();
  for (let i = 0; i < 5; i++) assert.equal((await f.call(route, {...owner, method: 'POST', body: {currentPassword: 'wrong-fixture', temporaryPassword: 'temp-fixture'}})).status, 401);
  assert.equal((await f.call(route, {...owner, method: 'POST', body: {currentPassword: next, temporaryPassword: 'temp-fixture'}})).status, 429);
  assert.equal((await f.call('/api/auth/login', {method: 'POST', body: {username: target.username, password: initial}})).status, 200);
  assert.deepEqual(f.store.snapshot(), before);
});
