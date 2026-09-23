'use strict';
/* 합성 저장소만: 자동 연결 → 두 앱 기록 → 재시도·권한 경계, Worker/Node 같은 HTTP 계약. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from './worker.mjs';
import { handlePortalFamilyLink } from './portal-family.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SECRET = 'synthetic-portal-service-key-not-a-real-secret';
const PIN = 'synthetic-admin-pin';
const TOKEN = 'a'.repeat(32), OTHER = 'b'.repeat(32), LEGACY = 'c'.repeat(32), COLLISION = 'd'.repeat(32);
const LEGACY_LONG = 'e'.repeat(32);
const CODE = 'portal-' + TOKEN;
const legacyStudent = { code: 'SYNTH01', name: '합성 기존학생', grade: '초3', ptoken: LEGACY };
const conflictingStudent = { code: 'portal-' + COLLISION, name: '합성 이전원장', ptoken: LEGACY_LONG };
const ENDPOINT = '/api/portal/family-link';
const dbSeed = { students: { SYNTH01: legacyStudent, [conflictingStudent.code]: conflictingStudent }, parents: { [LEGACY]: 'SYNTH01', [LEGACY_LONG]: conflictingStudent.code } };

class FakeKV {
  constructor() {
    this.rows = new Map([
      ['student:SYNTH01', JSON.stringify(legacyStudent)], ['parent:' + LEGACY, 'SYNTH01'],
      ['student:' + conflictingStudent.code, JSON.stringify(conflictingStudent)],
      ['parent:' + LEGACY_LONG, conflictingStudent.code],
    ]);
    this.writes = [];
  }
  async get(key, type) { const value = this.rows.get(key); return value == null ? null : type === 'json' ? JSON.parse(value) : value; }
  async put(key, value) { this.writes.push(key); this.rows.set(key, value); }
  async delete(key) { this.rows.delete(key); }
  async list({ prefix = '' } = {}) { return { keys: [...this.rows.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; }
}

async function contract(call, label) {
  const connect = (body, more = {}) => call(ENDPOINT, { method: 'POST', bearer: SECRET, body, ...more });
  assert.equal((await call(ENDPOINT)).status, 405);
  assert.equal((await call(ENDPOINT, { method: 'POST', body: { token: TOKEN, name: '합성' } })).status, 401);
  assert.equal((await connect({ token: TOKEN, name: '합성' }, { bearer: 'wrong' })).status, 401);
  for (const body of [null, [], {}, { token: 'bad', name: '합성' }, { token: TOKEN.toUpperCase(), name: '합성' },
    { token: TOKEN, name: '' }, { token: TOKEN, name: '가'.repeat(81) }, { token: TOKEN, name: '가\n나' }])
    assert.equal((await connect(body)).status, 400, label + ' input validation');
  assert.equal((await connect({}, { raw: '{bad' })).status, 400);
  assert.equal((await connect({}, { raw: ' '.repeat(1025) })).status, 413);
  assert.equal((await connect({}, { raw: ' '.repeat(1025), chunked: true })).status, 413);
  assert.equal((await connect({ token: LEGACY, name: '합성 충돌' })).status, 409);
  assert.equal((await connect({ token: COLLISION, name: '합성 충돌' })).status, 409);
  assert.equal((await call('/api/chunk/parent?t=' + LEGACY)).body.parent.name, legacyStudent.name);
  assert.equal((await call('/api/letter/parent?t=' + LEGACY_LONG)).body.parent.name, conflictingStudent.name);
  assert.equal((await call('/api/letter/parent?t=' + TOKEN)).status, 404);

  assert.deepEqual((await connect({ token: TOKEN, name: '합성 부모앱 아이' })).body, { ok: true, token: TOKEN });
  // 기존 연결의 재시도는 이름·학년 지정·학습 기록을 덮지 않는다.
  assert.equal((await connect({ token: TOKEN, name: '덮어쓰면 안 됨' })).status, 200);
  const repeated = await Promise.all([connect({ token: OTHER, name: '합성 다른아이' }), connect({ token: OTHER, name: '합성 다른아이' })]);
  assert.ok(repeated.every(r => r.status === 200));
  for (const app of ['letter', 'chunk']) {
    const opened = await call('/api/' + app + '/parent?t=' + TOKEN);
    assert.equal(opened.status, 200, label + ' ' + app);
    assert.equal(opened.body.parent.name, '합성 부모앱 아이');
    assert.equal(opened.headers.get('cache-control'), 'no-store');
    assert.ok(!JSON.stringify(opened.body).includes(TOKEN));
    assert.equal((await call('/api/' + app + '/parent?t=' + 'f'.repeat(32))).status, 404);
  }
  const stamp = Date.now();
  assert.equal((await call('/api/letter/parent/state?t=' + TOKEN, { method: 'PUT', body:
    { state: { v: 1, issues: { '2026-W39': { openedAt: stamp, doneAt: stamp, days: { 1: stamp } } } } } })).status, 200);
  assert.ok((await call('/api/letter/parent/state?t=' + TOKEN)).body.state.issues['2026-W39']);
  assert.deepEqual((await call('/api/letter/parent/state?t=' + OTHER)).body.state.issues, {});
  assert.equal((await call('/api/chunk/parent/state?t=' + TOKEN, { method: 'PUT', body:
    { state: { band: 'G3', marker: 'synthetic-family-record' }, baseUpdatedAt: null } })).status, 200);
  assert.equal((await call('/api/chunk/parent/state?t=' + TOKEN)).body.state.marker, 'synthetic-family-record');
  assert.equal((await call('/api/chunk/parent/state?t=' + OTHER)).body.state, null);
  assert.equal((await connect({ token: TOKEN, name: '합성 재시도' })).status, 200);
  assert.equal((await call('/api/chunk/parent/state?t=' + TOKEN)).body.state.marker, 'synthetic-family-record');

  // 가족 토큰·가상 코드는 일반 학생 로그인과 다른 앱의 열쇠가 아니다.
  assert.equal((await call('/api/login', { method: 'POST', body: { code: CODE } })).status, 401);
  assert.equal((await call('/api/parent/summary?t=' + TOKEN)).status, 404);
  assert.equal((await call('/api/haru/parent?t=' + TOKEN)).status, 404);
  for (const p of ['/api/pull', '/api/vocab/pull', '/api/hanja/books', '/api/letter/issues', '/api/chunk/state'])
    assert.equal((await call(p, { bearer: TOKEN })).status, 401, label + ' token boundary');

  const admin = (await call('/api/admin/login', { method: 'POST', body: { pin: PIN } })).body.token;
  assert.ok(admin);
  const students = (await call('/api/letter/admin/students', { bearer: admin })).body.students;
  assert.ok(students.some(s => s.code === CODE && s.name === '합성 부모앱 아이'));
  assert.equal((await call('/api/letter/admin/tier', { method: 'POST', bearer: admin, body: { code: conflictingStudent.code, tier: 'M' } })).status, 200);
  assert.equal((await call('/api/letter/admin/tier', { method: 'POST', bearer: admin, body: { code: CODE, tier: 'K' } })).status, 200);
  assert.equal((await call('/api/letter/parent?t=' + TOKEN)).body.parent.tier, 'K');
  assert.equal((await connect({ token: TOKEN, name: '합성 재연결' })).status, 200);
  assert.equal((await call('/api/letter/parent?t=' + TOKEN)).body.parent.tier, 'K');
  assert.equal((await call('/api/chunk/admin/parentlink/' + CODE, { method: 'POST', bearer: admin, body: {} })).body.ptoken, TOKEN);
  assert.equal((await call('/api/chunk/admin/assign/' + CODE, { method: 'PUT', bearer: admin, body: { band: 'G3' } })).status, 200);
  assert.equal((await call('/api/chunk/admin/student/' + CODE, { bearer: admin })).body.state.marker, 'synthetic-family-record');
  const exported = (await call('/api/admin/export', { bearer: admin })).body;
  assert.equal(exported.portalFamilies[TOKEN].name, '합성 부모앱 아이');
  assert.equal(exported.students[CODE], undefined);
  assert.equal(exported.students[conflictingStudent.code].letterTier, 'M');
  assert.equal((await call('/api/login', { method: 'POST', body: { code: CODE } })).status, 401);
  console.log('OK — ' + label + ' 자동 연결·재시도·가족 격리·권한·기록·관리·백업');
}

function requestOptions(opt) {
  const headers = { 'Content-Type': 'application/json', ...(opt.bearer ? { Authorization: 'Bearer ' + opt.bearer } : {}) };
  let body = opt.raw ?? ('body' in opt ? JSON.stringify(opt.body) : undefined);
  if (opt.chunked) body = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(body)); controller.close();
  } });
  return { method: opt.method || 'GET', headers, body, ...(opt.chunked ? { duplex: 'half' } : {}) };
}
async function decoded(response) { return { status: response.status, headers: response.headers, body: await response.json() }; }

const kv = new FakeKV();
const env = { DB: kv, ADMIN_PIN: PIN, WB_PARENT_PORTAL_LINK_SECRET: SECRET };
const workerCall = async (p, opt = {}, over = {}) => decoded(await worker.fetch(new Request('https://synthetic.invalid' + p, requestOptions(opt)), { ...env, ...over }, {}));
for (const secret of ['', 'short', SECRET + '\n'])
  assert.equal((await workerCall(ENDPOINT, { method: 'POST', bearer: SECRET, body: {} }, { WB_PARENT_PORTAL_LINK_SECRET: secret })).status, 503);
assert.deepEqual(kv.writes, []);
await contract(workerCall, 'Worker');
assert.equal([...kv.rows.keys()].filter(k => k.startsWith('portal-family:')).length, 2);
assert.equal(kv.rows.has('student:' + CODE), false);
assert.equal(kv.rows.has('parent:' + TOKEN), false);
const writes = kv.writes.filter(k => k === 'portal-family:' + TOKEN).length;
assert.equal((await workerCall(ENDPOINT, { method: 'POST', bearer: SECRET, body: { token: TOKEN, name: '합성' } })).status, 200);
assert.equal(kv.writes.filter(k => k === 'portal-family:' + TOKEN).length, writes, '기존 가족 재연결은 KV 쓰기도 없어야 한다');
const unavailable = await handlePortalFamilyLink({ method: 'POST', authorization: 'Bearer ' + SECRET, secret: SECRET,
  getBody: async () => ({ token: TOKEN, name: '합성' }), store: { getParentCode: () => { throw Error(TOKEN + SECRET); } } });
assert.deepEqual(unavailable, { status: 503, body: { error: 'family_link_unavailable' } });

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-portal-family-'));
fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify(dbSeed));
const port = 18000 + process.pid % 10000;
const server = spawn(process.execPath, [path.join(DIR, 'server.mjs')], {
  env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ADMIN_PIN: PIN,
    WB_PARENT_PORTAL_LINK_SECRET: SECRET, VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_JWK: '' },
  windowsHide: true, stdio: 'ignore',
});
const exited = once(server, 'exit');
try {
  let ready = false;
  for (let n = 0; n < 100 && !ready; n++) {
    try { ready = (await fetch('http://127.0.0.1:' + port + '/api/health')).ok; }
    catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  assert.ok(ready, 'local server startup');
  await contract(async (p, opt = {}) => decoded(await fetch('http://127.0.0.1:' + port + p, requestOptions(opt))), 'Node');
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  assert.equal(saved.students[CODE], undefined);
  assert.equal(saved.parents[TOKEN], undefined);
  assert.equal(Object.keys(saved.portalFamilies).length, 2);
} finally {
  server.kill();
  await exited;
  fs.rmSync(dataDir, { recursive: true, force: true });
}
