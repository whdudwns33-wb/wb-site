import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { createLocalAdminCredentials, resetState } from './local-admin-credentials.mjs';

const ID = 'synthetic-review-admin';
const TEMP = '0000';
const NEXT = 'Synthetic-new-password-2026!';
const OTHER = 'Other-synthetic-password-2026!';
const moduleUrl = new URL('./local-admin-credentials.mjs', import.meta.url).href;

function fixture(t, temporary = TEMP) {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naesin-auth-review-')));
  fs.chmodSync(top, 0o700);
  t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  const store = path.join(top, 'store');
  fs.mkdirSync(store, { mode: 0o700 });
  const file = path.join(store, 'credential.json');
  fs.writeFileSync(file, JSON.stringify(resetState(ID, temporary)), { mode: 0o600, flag: 'wx' });
  return { top, store, file, temporary };
}
const read = f => JSON.parse(fs.readFileSync(f.file, 'utf8'));
const login = (api, password = TEMP, ip = 'synthetic-ip') => api.login({ id: ID, password }, ip);
const change = (api, token, password = NEXT) => api.change(token, { password, confirmPassword: password });
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function rotation(api, password = TEMP, ip) {
  const result = login(api, password, ip);
  assert.equal(result.ok, true);
  assert.equal(result.passwordChangeRequired, true);
  assert.equal(typeof result.changeToken, 'string');
  assert.ok(result.changeToken.length >= 32);
  assert.equal(Object.hasOwn(result, 'token'), false);
  return result.changeToken;
}

test('reset uses real salted scrypt and contains no plaintext password', t => {
  const f = fixture(t);
  const first = read(f), second = resetState(ID, TEMP);
  assert.equal(first.id, ID);
  assert.equal(first.mustChange, true);
  for (const key of ['salt', 'hash', 'epoch']) assert.ok(isHash(first[key]));
  assert.ok(first.salt !== second.salt && first.hash !== second.hash && first.epoch !== second.epoch);
  assert.ok(crypto.timingSafeEqual(Buffer.from(first.hash, 'hex'), crypto.scryptSync(TEMP, first.salt, 32)));
  assert.equal(Object.values(first).includes(TEMP), false);
  assert.equal(Object.hasOwn(first, 'password'), false);
  assert.equal(fs.statSync(f.store).mode & 0o777, 0o700);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
});

test('initial login grants only an opaque rotation ticket; PIN and admin access fail', t => {
  const f = fixture(t), api = createLocalAdminCredentials(f.file);
  const ticket = rotation(api);
  assert.equal(api.accepts({ admin: true, adminEpoch: api.epoch() }), false);
  assert.equal(api.accepts({ admin: true }), false);
  assert.equal(api.login({ pin: TEMP }, 'pin-ip').status, 401);
  assert.equal(api.login({ id: 'wrong-synthetic-id', password: TEMP }, 'wrong-id-ip').status, 401);
  assert.equal(api.login({ id: ID, password: 'wrong-synthetic-password' }, 'wrong-pw-ip').status, 401);
  assert.equal(change(api, 'unissued-ticket').status, 401);
  const other = createLocalAdminCredentials(f.file);
  assert.equal(change(other, ticket).status, 401);
});

test('two app instances share committed state; tickets are one-use and old sessions die', t => {
  const f = fixture(t), english = createLocalAdminCredentials(f.file), korean = createLocalAdminCredentials(f.file);
  const initial = read(f), ticketA = rotation(english), ticketB = rotation(korean);
  assert.equal(change(english, ticketA).ok, true);
  const next = read(f);
  assert.equal(next.id, initial.id);
  assert.equal(next.mustChange, false);
  assert.ok(next.epoch !== initial.epoch && next.salt !== initial.salt && next.hash !== initial.hash);
  assert.equal(change(english, ticketA).status, 401);
  assert.equal(change(korean, ticketB).status, 401);
  for (const api of [english, korean]) {
    assert.equal(api.accepts({ admin: true, adminEpoch: initial.epoch }), false);
    assert.equal(api.accepts({ admin: true }), false);
    assert.equal(api.accepts({ admin: true, adminEpoch: next.epoch }), true);
    assert.equal(login(api, TEMP, 'old-password-ip').status, 401);
    const result = login(api, NEXT, 'new-password-ip');
    assert.equal(result.ok, true);
    assert.equal(result.passwordChangeRequired, undefined);
    assert.equal(result.changeToken, undefined);
  }
  const restarted = createLocalAdminCredentials(f.file);
  assert.equal(login(restarted, NEXT).ok, true);
  assert.equal(restarted.epoch(), next.epoch);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.ok(crypto.timingSafeEqual(Buffer.from(next.hash, 'hex'), crypto.scryptSync(NEXT, next.salt, 32)));
  assert.equal(JSON.stringify(next).includes(NEXT), false);
  assert.deepEqual(fs.readdirSync(f.store), ['credential.json']);
});

test('short, mismatched, excessive-byte and control-character replacements leave state unchanged', t => {
  const f = fixture(t), api = createLocalAdminCredentials(f.file), ticket = rotation(api);
  const before = fs.readFileSync(f.file);
  const cases = [
    { password: 'short', confirmPassword: 'short' },
    { password: NEXT, confirmPassword: OTHER },
    { password: NEXT + String.fromCharCode(0), confirmPassword: NEXT + String.fromCharCode(0) },
    { password: NEXT + String.fromCharCode(10), confirmPassword: NEXT + String.fromCharCode(10) },
    { password: String.fromCharCode(0xac00).repeat(400), confirmPassword: String.fromCharCode(0xac00).repeat(400) },
  ];
  for (const body of cases) {
    assert.equal(api.change(ticket, body).status, 400);
    assert.ok(fs.readFileSync(f.file).equals(before));
  }
  assert.equal(change(api, ticket).ok, true);
});

test('a long temporary password also cannot be reused as the replacement', t => {
  const initial = 'Synthetic-long-temporary-2026!';
  const f = fixture(t, initial), api = createLocalAdminCredentials(f.file), ticket = rotation(api, initial);
  const before = fs.readFileSync(f.file);
  assert.equal(change(api, ticket, initial).status, 400);
  assert.ok(fs.readFileSync(f.file).equals(before));
  assert.equal(change(api, ticket, NEXT).ok, true);
});

test('rotation tickets expire at five minutes without granting a general session', t => {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const first = fixture(t), a = createLocalAdminCredentials(first.file), ticketA = rotation(a);
  clock += 5 * 60_000 - 1;
  assert.equal(change(a, ticketA).ok, true);
  const second = fixture(t), b = createLocalAdminCredentials(second.file), ticketB = rotation(b);
  const before = fs.readFileSync(second.file);
  clock += 5 * 60_000;
  assert.equal(change(b, ticketB).status, 401);
  assert.ok(fs.readFileSync(second.file).equals(before));
  assert.equal(b.accepts({ admin: true, adminEpoch: b.epoch() }), false);
});

test('an operator reset invalidates all old tickets and sessions across instances', t => {
  const f = fixture(t), a = createLocalAdminCredentials(f.file), b = createLocalAdminCredentials(f.file);
  const outstanding = rotation(b), token = rotation(a);
  assert.equal(change(a, token).ok, true);
  const session = { admin: true, adminEpoch: a.epoch() };
  assert.equal(a.accepts(session), true);
  fs.writeFileSync(f.file, JSON.stringify(resetState(ID, TEMP)), { mode: 0o600 });
  assert.equal(a.accepts(session), false);
  assert.equal(b.accepts(session), false);
  assert.equal(change(b, outstanding).status, 401);
  assert.equal(login(b, NEXT, 'reset-old-password-ip').status, 401);
  rotation(b, TEMP, 'reset-new-ticket-ip');
});

test('real per-IP login limiting blocks even valid credentials until its window expires', t => {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const f = fixture(t), api = createLocalAdminCredentials(f.file);
  for (let i = 0; i < 20; i++) assert.equal(login(api, 'wrong-synthetic-password', 'limited-ip').status, 401);
  assert.equal(login(api, TEMP, 'limited-ip').status, 429);
  rotation(api, TEMP, 'different-ip');
  clock += 15 * 60_000 + 1;
  rotation(api, TEMP, 'limited-ip');
});

test('rotation tickets have a resource bound and expired entries free capacity', t => {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const f = fixture(t), api = createLocalAdminCredentials(f.file);
  let first;
  for (let i = 0; i < 100; i++) {
    const ticket = rotation(api, TEMP, 'capacity-ip-' + i);
    if (i === 0) first = ticket;
  }
  assert.equal(login(api, TEMP, 'capacity-overflow').status, 429);
  clock += 5 * 60_000 + 1;
  rotation(api, TEMP, 'capacity-after-expiry');
  assert.equal(change(api, first).status, 401);
});

test('unsafe file permissions fail closed before and after construction', t => {
  const f = fixture(t), api = createLocalAdminCredentials(f.file);
  for (const mode of [0o644, 0o640, 0o660]) {
    fs.chmodSync(f.file, mode);
    assert.throws(() => createLocalAdminCredentials(f.file));
    assert.throws(() => login(api));
    fs.chmodSync(f.file, 0o600);
  }
});

test('leaf symlinks and hardlinks fail closed for new and existing instances', t => {
  const f = fixture(t), api = createLocalAdminCredentials(f.file);
  const retained = path.join(f.store, 'retained.json');
  fs.renameSync(f.file, retained);
  fs.symlinkSync(retained, f.file);
  assert.throws(() => createLocalAdminCredentials(f.file));
  assert.throws(() => login(api));
  fs.unlinkSync(f.file);
  fs.renameSync(retained, f.file);
  fs.linkSync(f.file, retained);
  assert.throws(() => createLocalAdminCredentials(f.file));
  assert.throws(() => login(api));
});

test('empty or malformed credential records fail closed without legacy fallback', t => {
  const f = fixture(t), api = createLocalAdminCredentials(f.file);
  for (const value of ['', '{}', '{', JSON.stringify({ version: 2 })]) {
    fs.writeFileSync(f.file, value);
    assert.throws(() => createLocalAdminCredentials(f.file));
    assert.throws(() => login(api));
  }
});

test('unsafe parent permissions fail closed at construction', t => {
  const f = fixture(t);
  fs.chmodSync(f.store, 0o755);
  assert.throws(() => createLocalAdminCredentials(f.file));
});

test('existing instances reject parent permission drift before reading credentials', t => {
  const f = fixture(t), api = createLocalAdminCredentials(f.file);
  fs.chmodSync(f.store, 0o755);
  assert.throws(() => login(api));
  assert.throws(() => api.epoch());
});

test('existing instances reject a parent replaced by a symlink', t => {
  const f = fixture(t), api = createLocalAdminCredentials(f.file);
  const retained = path.join(f.top, 'retained-store');
  fs.renameSync(f.store, retained);
  fs.symlinkSync(retained, f.store, 'dir');
  assert.throws(() => login(api));
  assert.throws(() => api.epoch());
});

test('an existing change lock is preserved, denies the change, and does not consume the ticket', t => {
  const f = fixture(t), api = createLocalAdminCredentials(f.file), ticket = rotation(api);
  const before = fs.readFileSync(f.file), lock = f.file + '.lock';
  fs.writeFileSync(lock, 'synthetic-other-owner', { flag: 'wx', mode: 0o600 });
  assert.equal(change(api, ticket).status, 409);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'synthetic-other-owner');
  assert.ok(fs.readFileSync(f.file).equals(before));
  fs.unlinkSync(lock);
  assert.equal(change(api, ticket).ok, true);
});

const workerSource = `
import { parentPort, workerData } from 'node:worker_threads';
const { createLocalAdminCredentials } = await import(workerData.moduleUrl);
const api = createLocalAdminCredentials(workerData.file);
const login = api.login({ id: workerData.id, password: workerData.initial }, workerData.ip);
if (!login.ok || !login.passwordChangeRequired) throw Error('Synthetic worker could not obtain ticket');
parentPort.postMessage({ type: 'ready' });
parentPort.once('message', () => {
  try {
    const result = api.change(login.changeToken, { password: workerData.next, confirmPassword: workerData.next });
    parentPort.postMessage({ type: 'done', ok: result.ok, status: result.status });
  } catch (error) { parentPort.postMessage({ type: 'done', exceptionType: error.name }); }
  finally { parentPort.close(); }
});
`;

test('concurrent independent instances cannot both commit from the same credential epoch', { timeout: 15_000 }, async t => {
  const f = fixture(t), before = read(f), workers = [], states = [];
  for (const [i, next] of [NEXT, OTHER].entries()) {
    const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(workerSource)), {
      execArgv: [], workerData: { moduleUrl, file: f.file, id: ID, initial: TEMP, ip: 'worker-ip-' + i, next },
    });
    workers.push(worker);
    const state = {};
    state.ready = new Promise((resolve, reject) => {
      worker.on('message', value => { if (value.type === 'ready') resolve(); });
      worker.once('error', reject);
      worker.once('exit', code => { if (code) reject(Error('Synthetic worker exited unsuccessfully')); });
    });
    state.done = new Promise((resolve, reject) => {
      worker.on('message', value => { if (value.type === 'done') resolve(value); });
      worker.once('error', reject);
    });
    states.push(state);
  }
  t.after(async () => { await Promise.all(workers.map(w => w.terminate())); });
  await Promise.all(states.map(s => s.ready));
  workers.forEach(w => w.postMessage('go'));
  const results = await Promise.all(states.map(s => s.done));
  assert.equal(results.filter(r => r.ok === true).length, 1);
  const denied = results.find(r => r.ok !== true);
  assert.equal(denied.exceptionType, undefined);
  assert.ok([401, 409].includes(denied.status));
  const after = read(f), restarted = createLocalAdminCredentials(f.file);
  assert.ok(after.epoch !== before.epoch);
  assert.equal(after.mustChange, false);
  assert.equal(restarted.accepts({ admin: true, adminEpoch: before.epoch }), false);
  assert.equal(restarted.accepts({ admin: true, adminEpoch: after.epoch }), true);
  const accepted = [NEXT, OTHER].filter((password, i) => login(restarted, password, 'winner-check-' + i).ok);
  assert.equal(accepted.length, 1);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(f.store), ['credential.json']);
});
