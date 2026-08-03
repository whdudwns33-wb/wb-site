import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker-core.js';

function makeEnv() {
  const batches = [];
  const db = {
    prepare(sql) {
      const statement = {
        sql,
        params: [],
        bind(...params) {
          statement.params = params;
          return statement;
        }
      };
      return statement;
    },
    async batch(statements) {
      batches.push(statements);
      return statements.map(() => ({ meta: { changes: 1 } }));
    }
  };
  return {
    env: { DB: db, TASK_ADMIN_SECRET: 'root-test-secret', ALLOW_ORIGIN: '' },
    batches
  };
}

async function recover(env, secret, app = 'task') {
  const response = await worker.fetch(new Request('https://worker.test/admin-recover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app, auth: { mode: 'admin', secret } })
  }), env);
  return { status: response.status, data: await response.json() };
}

test('root recovery issues a 24 hour session and stores only its hash', async () => {
  const { env, batches } = makeEnv();
  const before = Date.now();
  const result = await recover(env, 'root-test-secret');

  assert.equal(result.status, 200);
  assert.match(result.data.token, /^[a-f0-9]{48}$/);
  assert.ok(result.data.expiresAt >= before + 24 * 60 * 60 * 1000);
  assert.ok(result.data.expiresAt <= Date.now() + 24 * 60 * 60 * 1000);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 3);
  assert.match(batches[0][0].sql, /UPDATE admin_bootstrap_codes SET revoked=1/);
  assert.match(batches[0][1].sql, /UPDATE admin_sessions SET revoked=1/);
  assert.match(batches[0][2].sql, /INSERT INTO admin_sessions/);
  assert.match(String(batches[0][2].params[1]), /^admin-token-sha256:[a-f0-9]{64}$/);
  assert.ok(!batches[0].some(statement => statement.params.includes(result.data.token)));
});

test('wrong root secret and consult app cannot create an admin session', async () => {
  const first = makeEnv();
  const invalid = await recover(first.env, 'wrong-secret');
  assert.equal(invalid.status, 401);
  assert.equal(first.batches.length, 0);

  const second = makeEnv();
  const consult = await recover(second.env, 'root-test-secret', 'consult');
  assert.equal(consult.status, 404);
  assert.equal(second.batches.length, 0);
});
