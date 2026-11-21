import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from './worker.js';
import {keyCommand} from './task-read-key.mjs';

const url = 'https://wb-sync.whdudwns33.workers.dev/task/mcp';
const legacy = 'standard-local-task-read-secret-00000000';
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE task_director_account (id INTEGER PRIMARY KEY, login_id TEXT, must_change INTEGER);
  CREATE TABLE tasks (app TEXT, id TEXT, data TEXT);
  CREATE TABLE staff (app TEXT, id TEXT, data TEXT);`);
db.exec(readFileSync(new URL('./migrations/094_task_read_keys.sql', import.meta.url), 'utf8'));
db.prepare("INSERT INTO task_director_account VALUES (1,'synthetic-owner',1)").run();
db.prepare("INSERT INTO tasks VALUES ('task','one',?)").run(JSON.stringify({id:'one',title:'private fixture',repeat:'daily',staffId:'fixture'}));
// D1 의 prepare/bind/first/all 만 흉내 낸다.
const d1 = {prepare(sql) {
  const statement = db.prepare(sql);
  let args = [];
  return {bind(...values) { args = values; return this; },
    async first() { return statement.get(...args) ?? null; },
    async all() { return {results: statement.all(...args)}; }};
}};
const env = {TASK_MCP_READ_SECRET: legacy, DB: d1};
const issue = {execute: async sql => { if (!db.prepare(sql).get()) throw Error('storage_rejected'); }};
const rpc = (token, method='tools/list', params={}) => worker.fetch(new Request(url, {method:'POST',
  headers: token ? {Authorization:'Bearer '+token} : {}, body: JSON.stringify({jsonrpc:'2.0',id:1,method,params})}), env);

test('legacy read secret with tsk_ prefix still opens both MCP routes and task export', async () => {
  const secret = 'tsk_' + 'L'.repeat(43);
  const localEnv = {...env, TASK_MCP_READ_SECRET: secret};
  const headers = {Authorization: 'Bearer ' + secret};
  for (const path of ['/task/mcp', '/mcp']) {
    const response = await worker.fetch(new Request(new URL(path, url), {
      method: 'POST', headers, body: JSON.stringify({jsonrpc:'2.0', id:1, method:'tools/list'}),
    }), localEnv);
    assert.equal(response.status, 200, path);
    assert.equal((await response.json()).result.tools[0].name, 'task_sheet_status');
  }
  const response = await worker.fetch(new Request(new URL('/task-export', url), {
    method: 'POST', headers, body: JSON.stringify({app:'task', action:'list_work_orders'}),
  }), localEnv);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.items[0].taskId, 'one');
});

test('read keys need the owner account after the first password change', async () => {
  await assert.rejects(keyCommand({...issue, args:['add-key','synthetic-owner','relay']}), /storage_rejected/);
  db.prepare('UPDATE task_director_account SET must_change=0').run();
  await assert.rejects(keyCommand({...issue, args:['add-key','someone-else','relay']}), /storage_rejected/);
  for (const bad of [['add-key','synthetic-owner','relay','0'], ['add-key','synthetic-owner','relay','366'],
    ['add-key','synthetic-owner',''], ['drop','synthetic-owner','relay'], ['add-key',"x'--",'relay']]) {
    await assert.rejects(keyCommand({...issue, args: bad}));
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_read_keys').get().n, 0);
});

test('named read key opens read tools only, then revokes on its own', async () => {
  const key = await keyCommand({...issue, args:['add-key','synthetic-owner','mac-studio-read']});
  const other = await keyCommand({...issue, args:['add-key','synthetic-owner','other','7']});
  assert.match(key, /^tsk_[A-Za-z0-9_-]{43}$/);
  const stored = db.prepare("SELECT token_hash,scope,expires_at FROM task_read_keys WHERE name='mac-studio-read'").get();
  assert.notEqual(stored.token_hash, key);
  assert.equal(stored.scope, 'read');
  const days = (Date.parse(stored.expires_at) - Date.now()) / 86400000;
  assert.ok(days > 89.9 && days <= 90);
  await assert.rejects(keyCommand({...issue, args:['add-key','synthetic-owner','mac-studio-read']}), /active_key_limit_or_name/);

  const tools = (await (await rpc(key)).json()).result.tools;
  assert.deepEqual(tools.map(t => t.name), ['task_sheet_status']);
  const out = (await (await rpc(key, 'tools/call', {name:'task_sheet_status'})).json()).result;
  assert.deepEqual(JSON.parse(out.content[0].text), {work_orders_today: 1});
  assert.ok((await (await rpc(key, 'tools/call', {name:'create_task'})).json()).error);
  assert.ok(db.prepare("SELECT last_used FROM task_read_keys WHERE name='mac-studio-read'").get().last_used);
  assert.equal((await rpc('tsk_' + 'A'.repeat(43))).status, 401);
  assert.equal((await rpc(key.slice(0, -1))).status, 401);

  await keyCommand({...issue, args:['revoke-key','synthetic-owner','mac-studio-read']});
  assert.equal((await rpc(key)).status, 401);
  assert.equal((await rpc(other)).status, 200);
  await assert.rejects(keyCommand({...issue, args:['revoke-key','synthetic-owner','mac-studio-read']}), /storage_rejected/);
  assert.equal((await rpc(legacy)).status, 200, '기존 공용 비밀값 경로 유지');

  db.prepare("UPDATE task_read_keys SET expires_at='2000-01-01T00:00:00.000Z' WHERE name='other'").run();
  assert.equal((await rpc(other)).status, 401);
  assert.deepEqual(db.prepare('SELECT kind FROM task_read_key_activity ORDER BY id').all().map(r => r.kind),
    ['token_create','token_create','token_revoke']);
});

test('owner reset blocks issued keys', async () => {
  const key = await keyCommand({...issue, args:['add-key','synthetic-owner','reset-check']});
  db.prepare('UPDATE task_director_account SET must_change=1').run();
  assert.equal((await rpc(key)).status, 401);
  db.prepare('UPDATE task_director_account SET must_change=0').run();
  assert.equal((await rpc(key)).status, 200);
});
