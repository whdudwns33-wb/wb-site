import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import worker from './worker.js';

test('점검 세션은 업무지시서의 기기 연결·출퇴근과 분리되며 가상 업무 하나만 읽는다', async t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  for (const id of ['synth-staff', 'wbcheck', 'wb점검']) {
    db.prepare("INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES('task',?,?,?,1,1)")
      .run(id, id, JSON.stringify({ id, name: 'synth-private-staff' }));
  }
  db.prepare("INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES('task','synth-private-task','wbcheck',?,1,1)")
    .run(JSON.stringify({ staffId: 'wbcheck', title: 'synth-private-task', repeat: 'daily', start: '2026-01-01' }));
  const date = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  db.prepare("INSERT INTO checks(app,k,owner,data,updated_at,srv_at) VALUES('task',?,'wbcheck',?,1,1)")
    .run('synth-private-task|' + date, JSON.stringify({ blocked: true }));

  const password = randomBytes(32).toString('base64url');
  const prepare = (input, args = []) => spawnSync(process.execPath, ['sync/prepare-checker.mjs', ...args], { input, encoding: 'utf8' });
  for (const invalid of ['', 'a'.repeat(42), 'a'.repeat(101), '+'.repeat(43)]) assert.notEqual(prepare(invalid).status, 0);
  assert.notEqual(prepare(password, ['synth-staff']).status, 0);
  const generated = prepare(password + '\n');
  assert.equal(generated.status, 0);
  assert.ok(!generated.stdout.includes(password));

  const key = 'wbt_ct_' + randomBytes(32).toString('base64url');
  const env = {
    WB_TASK_CHECKER_VERIFIER: generated.stdout.trim(),
    WB_STAFF_WORK_LOGIN_ENABLED: 'true',
    TASK_TOWER_READ_SECRET: key,
    DB: { prepare(sql) {
      const statement = db.prepare(sql);
      let params = [];
      return { bind(...args) { params = args; return this; },
        first() { return statement.get(...params); },
        all() { return { results: statement.all(...params) }; },
        run() { return statement.run(...params); } };
    } },
    ASSETS: { fetch() { assert.fail('점검 요청이 직원 화면으로 넘어갔습니다'); } },
  };
  const call = (method, path, {cookie, body, headers} = {}) => worker.fetch(new Request('https://synth.example' + path, {
    method, headers: { ...(cookie && {Cookie: cookie}), ...(body && {'Content-Type': 'application/json'}), ...headers },
    ...(body && {body: JSON.stringify(body)}),
  }), env, {});
  const beforeLogin = db.prepare('SELECT total_changes() n').get().n;
  assert.match(await (await call('GET', '/task/checker')).text(), /점검 로그인/);
  assert.equal((await call('POST', '/task/checker/login', {body: {username: 'synth-staff', password}})).status, 401);
  assert.equal((await call('POST', '/task/checker/login', {body: {username: 'wbcheck', password},
    headers: {Origin: 'https://synth-other.example'}})).status, 403);
  const response = await call('POST', '/task/checker/login', {body: {username: 'wbcheck', password}});
  assert.equal(response.status, 200);
  const cookieHeader = response.headers.get('set-cookie');
  assert.match(cookieHeader, /HttpOnly; Secure; SameSite=Strict/);
  const cookie = cookieHeader.split(';')[0], options = {cookie};
  assert.equal(db.prepare('SELECT total_changes() n').get().n, beforeLogin + 1);

  const main = await call('GET', '/task/checker', options);
  assert.equal(main.status, 200);
  assert.match(await main.text(), /id="checker-screen">오늘/);
  const me = await (await call('GET', '/task/checker/me', options)).json();
  assert.deepEqual(me.user, {loginId: 'wbcheck', role: 'checker', mustChange: false});
  const today = await (await call('GET', '/task/checker/today', options)).json();
  assert.deepEqual(today.items, [{id: 'synth-checker', title: 'synth-점검 업무', status: '요청'}]);

  const core = readFileSync(new URL('./worker-core.js', import.meta.url), 'utf8');
  const paths = new Set(['/task/', '/task/index.html', '/health', '/future', '/task/checker/today?staff=other',
    ...Array.from(core.matchAll(/url\.pathname === '([^']+)'/g), match => match[1])]);
  let denied = 0;
  for (const path of paths) {
    for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS', 'HEAD']) {
      assert.equal((await call(method, path, options)).status, 403, method + ' ' + path);
      denied++;
    }
  }
  assert.equal((await call('GET', '/task/checker/today', {...options, headers: {Authorization: 'Bearer ' + key}})).status, 403);
  assert.equal(db.prepare('SELECT total_changes() n').get().n, beforeLogin + 1);
  assert.equal(db.prepare('SELECT count(*) n FROM staff_work_sessions').get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM checks WHERE k NOT LIKE 'synth-private-task|%'").get().n, 0);
  t.diagnostic(`403 확인 ${denied + 1}건`);

  const headers = {Authorization: 'Bearer ' + key};
  const usage = await (await call('GET', '/api/tower/usage', {headers})).json();
  assert.deepEqual(usage.people.map(person => person.login), ['synth-staff']);
  const summary = await (await call('GET', '/api/tower/summary', {headers})).json();
  assert.equal(summary.counts.blocked, 0);
  assert.equal((await call('POST', '/task/checker/logout', options)).status, 200);
  assert.equal((await call('GET', '/task/checker/today', options)).status, 401);
  assert.equal(db.prepare('SELECT total_changes() n').get().n, beforeLogin + 2);
});
