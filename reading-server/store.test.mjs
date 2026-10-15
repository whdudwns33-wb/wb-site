/* PC 정본: 손상 원본 보호·디스크 저장 실패·고유 복구점·본문 없는 export·비공개 전체 복구. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-store-'));
process.env.DATA_DIR = data;
const store = await import('./store.mjs');
const file = path.join(data, 'db.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let server;
const originalWrite = fs.writeFileSync;
const originalOpen = fs.openSync;
const originalRename = fs.renameSync;
const originalNow = Date.now;
try {
  fs.writeFileSync(file, '{"students":');
  assert.throws(() => store.load(), /기동을 중단/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"students":');
  const invalidDb = ['[]', '{"students":null}', '{"naesin":[]}', '{"naesin":null}', '{"naesin":{"packIds":{}}}', '{"naesin":{"aiUse":[]}}'];
  for (const field of ['packs', 'states', 'exams', 'tasks', 'results', 'books', 'reports', 'jobs', 'jobSrc', 'live', 'votes']) {
    invalidDb.push(JSON.stringify({ naesin: { [field]: [] } }), JSON.stringify({ naesin: { [field]: null } }));
  }
  for (const invalid of invalidDb) {
    fs.writeFileSync(file, invalid);
    assert.throws(() => store.load(), /기동을 중단/);
    assert.equal(fs.readFileSync(file, 'utf8'), invalid);
  }
  fs.unlinkSync(file);
  const db = store.load();
  db.students = { SYN001: { code: 'SYN001', name: '저장시험', cls: '시험반' } };
  const first = store.persist();
  assert.equal(first, store.persist(), '300ms 일괄 저장을 재사용해야 한다');
  await first;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    let calls = 0;
    fs.renameSync = (...args) => {
      if (++calls === 1) throw Object.assign(new Error('synthetic short reader lock'), { code: 'EPERM' });
      return originalRename(...args);
    };
    db.students.SYN001.level = 'L1';
    await store.persist();
    assert.equal(calls, 2); assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).students.SYN001.level, 'L1');
    const before = fs.readFileSync(file, 'utf8'); calls = 0;
    fs.renameSync = () => { calls++; throw Object.assign(new Error('synthetic lasting lock'), { code: 'EPERM' }); };
    await assert.rejects(store.persist(), { code: 'STORE_WRITE_FAILED' });
    assert.equal(calls, 5); assert.equal(fs.readFileSync(file, 'utf8'), before, '지속 잠금에도 기존 DB를 보존한다');
  } finally { fs.renameSync = originalRename; Object.defineProperty(process, 'platform', platform); }
  const saved = fs.readFileSync(file, 'utf8');
  assert.equal(JSON.parse(saved).students.SYN001.name, '저장시험');

  fs.writeFileSync = (target, ...args) => {
    if (target === file + '.tmp') throw new Error('synthetic disk failure');
    return originalWrite(target, ...args);
  };
  await assert.rejects(store.persist(), { code: 'STORE_WRITE_FAILED' });
  assert.equal(fs.readFileSync(file, 'utf8'), saved, '실패해도 기존 DB를 지우지 않는다');
  store.persist(); // 기존 다른 앱의 fire-and-forget 호출은 unhandled rejection을 내지 않는다.
  await sleep(400);
  fs.writeFileSync = originalWrite;

  // 공개 파일을 일부 쓴 뒤 실패해도 두 부분 파일을 지우고 같은 날 다음 저장에서 다시 만든다.
  const retryDay = '2099-01-01';
  const retryPublic = path.join(data, 'backups', 'db-' + retryDay + '.json');
  const retryPrivate = path.join(data, 'private-backups', 'db-' + retryDay + '.json');
  Date.now = () => Date.parse(retryDay + 'T00:00:00Z');
  let publicFd;
  fs.openSync = (target, ...args) => {
    const fd = originalOpen(target, ...args);
    if (target === retryPublic) publicFd = fd;
    return fd;
  };
  fs.writeFileSync = (target, ...args) => {
    if (typeof target === 'number' && target === publicFd) {
      originalWrite(target, '{');
      throw new Error('synthetic partial public backup failure');
    }
    return originalWrite(target, ...args);
  };
  await store.persist();
  assert.equal(fs.existsSync(retryPublic), false, '공개 부분 파일이 남으면 안 된다');
  assert.equal(fs.existsSync(retryPrivate), false, '이 호출의 private 부분 파일이 다음 백업을 막으면 안 된다');
  fs.openSync = originalOpen;
  fs.writeFileSync = originalWrite;
  await store.persist();
  assert.ok(store.getBackup(retryDay)?.students.SYN001, '같은 날 공개 백업 재시도가 성공해야 한다');
  assert.ok(JSON.parse(fs.readFileSync(retryPrivate, 'utf8')).students.SYN001);
  const existingDay = '2099-01-02';
  const existingPrivate = path.join(data, 'private-backups', 'db-' + existingDay + '.json');
  fs.writeFileSync(existingPrivate, 'synthetic existing restore point');
  Date.now = () => Date.parse(existingDay + 'T00:00:00Z');
  await store.persist();
  assert.equal(fs.readFileSync(existingPrivate, 'utf8'), 'synthetic existing restore point', '실패 처리에서 기존 복구점을 삭제하지 않는다');
  Date.now = originalNow;

  const body = 'Synthetic private source. No third-party content.';
  db.naesin = {
    packIds: ['synthetic-pack'], packs: { 'synthetic-pack': { pack: { packId: 'synthetic-pack', body } } },
    states: {}, exams: {}, tasks: {}, results: {}, books: { SYN001: 'synthetic-book' }, reports: { 'synthetic-pack': [{ reason: 'answer' }] },
    jobs: { 'job-synthetic': { jobId: 'job-synthetic', packId: 'synthetic-pack', status: 'ready', draft: { words: [{ headword: body }] }, review: { 'words:one': { state: 'fixed', at: '2026-10-12', patch: { headword: body } } } } },
    jobSrc: { 'job-synthetic': { parts: { words: body } } },
    live: { default: { phase: { key: 'words' }, projector: { items: [{ prompt: body }] } } },
    votes: { default: { SYN001: { key: 'a' } } }, aiUse: { count: 1 },
  };
  const id1 = store.snapshotNow();
  db.naesin.books = { SYN001: 'changed-book' };
  const id2 = store.snapshotNow();
  assert.ok(id1 && id2 && id1 !== id2, '같은 날 수동 백업은 고유 복구점이어야 한다');
  assert.ok(store.listBackups().includes(id1) && store.listBackups().includes(id2));
  const snapshot = store.getBackup(id1);
  assert.equal(snapshot.naesin.books.SYN001, 'synthetic-book');
  assert.equal(store.getBackup(id2).naesin.books.SYN001, 'changed-book');
  assert.ok(!JSON.stringify(snapshot).includes(body), '공개 스냅샷에 구매 본문을 싣지 않는다');
  assert.equal(snapshot.naesin.jobs['job-synthetic'].review['words:one'].state, 'fixed');
  assert.equal(snapshot.naesin.jobs['job-synthetic'].review['words:one'].patch, undefined);
  assert.equal(snapshot.naesin.live.default.projector, null);
  assert.equal(store.getBackup('../private-backups/db-' + id1), null);
  const privateFile = path.join(data, 'private-backups', 'db-' + id1 + '.json');
  const full = JSON.parse(fs.readFileSync(privateFile, 'utf8'));
  assert.equal(full.naesin.jobSrc['job-synthetic'].parts.words, body);
  assert.equal(full.naesin.packs['synthetic-pack'].pack.body, body);
  const legacy = '2000-01-02';
  fs.writeFileSync(path.join(data, 'backups', 'db-' + legacy + '.json'), JSON.stringify({ legacy: true }));
  assert.deepEqual(store.getBackup(legacy), { legacy: true });
  assert.ok(store.listBackups().includes(legacy), '옛 일자 ID 조회를 유지한다');

  snapshot.naesin.aiUse = null;
  const imported = await store.importSnapshot(snapshot);
  assert.equal(store.getDb(), db, '서버가 붙든 DB 객체 참조를 유지한다');
  assert.equal(db.naesin.books.SYN001, 'synthetic-book');
  assert.equal(db.naesin.aiUse, null, '명시적 null을 복원한다');
  assert.equal(db.naesin.packs['synthetic-pack'].pack.body, body, '기존 구매 팩 본문을 보존한다');
  assert.equal(db.naesin.jobs['job-synthetic'].draft.words[0].headword, body);
  assert.ok(imported.skipped.some((entry) => entry.section === 'naesin.jobSrc'));
  assert.equal((await store.importSnapshot({ students: {}, naesin: { exams: [] } })).ok, false);
  assert.ok(db.students.SYN001, '잘못된 칸을 발견하기 전에 다른 칸을 덮지 않는다');
  const oldImport = await store.importSnapshot({ naesin: { states: {} }, hanja: { strokes: null } });
  assert.ok(oldImport.absent.includes('naesin.books'), '옛 스냅샷에 없는 칸을 알린다');
  assert.equal(db.hanja.strokes, null);
  delete db.naesin.jobs;
  await store.importSnapshot(snapshot);
  assert.deepEqual(db.naesin.jobs['job-synthetic'].draft, {});
  assert.equal(db.naesin.jobs['job-synthetic'].status, 'draft', '본문 없는 작업을 배포 가능 상태로 되살리지 않는다');
  assert.match(db.naesin.jobs['job-synthetic'].error, /원본 JSON/);

  // 비공개 전체 복원은 서버를 멈춘 상태에서 이 로컬 파일을 db.json으로 복사한다.
  fs.copyFileSync(privateFile, file);
  const restored = store.load();
  assert.equal(restored.naesin.jobSrc['job-synthetic'].parts.words, body);
  assert.equal(restored.naesin.jobs['job-synthetic'].draft.words[0].headword, body);

  // 실제 HTTP에서도 성공 응답 전에 디스크에 저장하며, 디스크 장애는 500으로 알린다.
  const port = 9600 + (process.pid % 80);
  restored.tokens = {
    'synthetic-admin-token': { code: '__admin__', admin: true, exp: Date.now() + 60000 },
    'synthetic-student-token': { code: 'SYN001', admin: false, exp: Date.now() + 60000 },
  };
  await store.persist();
  const env = { ...process.env, PORT: String(port), DATA_DIR: data, ADMIN_PIN: 'synthetic-test-pin' };
  delete env.WB_ADMIN_ONLY;
  server = spawn(process.execPath, [path.join(DIR, 'server.mjs')], { env, stdio: 'ignore' });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 80; i++) {
    try { const response = await fetch(base + '/api/health'); if (response.ok) break; } catch {}
    await sleep(100);
  }
  const request = (url, token, payload, method = 'PUT') => fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(payload),
  });
  let response = await request('/api/naesin/state', 'synthetic-student-token', { state: { owner: 'SYN001', packs: {} } });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).naesin.states.SYN001.state.owner, 'SYN001');
  const beforeFailure = fs.readFileSync(file, 'utf8');
  fs.mkdirSync(file + '.tmp');
  for (const [url, token, payload, method] of [
    ['/api/naesin/state', 'synthetic-student-token', { state: { owner: 'SYN001', packs: {}, marker: 'failed-write' } }, 'PUT'],
    ['/api/state', 'synthetic-student-token', { state: { marker: 'failed-write' } }, 'PUT'],
    ['/api/admin/students', 'synthetic-admin-token', { code: 'SYN002', name: '가상학생' }, 'POST'],
  ]) {
    response = await request(url, token, payload, method);
    assert.equal(response.status, 500, url + '는 디스크 장애를 성공이라고 답하면 안 된다');
    assert.equal((await response.json()).code, 'STORE_WRITE_FAILED');
    assert.equal(fs.readFileSync(file, 'utf8'), beforeFailure);
  }
  const exposed = await fetch(base + '/api/admin/export', { headers: { Authorization: 'Bearer synthetic-admin-token' } });
  assert.ok(!JSON.stringify(await exposed.json()).includes(body), 'HTTP export에도 구매 원문이 없다');
  console.log('OK — 손상 원본 보호·일괄 저장 Promise·실패 전파·HTTP 저장 결과·고유 백업·옛 ID·null/검증·본문 제외·비공개 전체 복구');
} finally {
  fs.writeFileSync = originalWrite;
  fs.openSync = originalOpen;
  Date.now = originalNow;
  if (server) { const exited = new Promise((resolve) => server.once('exit', resolve)); server.kill(); await exited; }
  const resolvedData = fs.realpathSync(data), resolvedTemp = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(resolvedData), resolvedTemp, '삭제 대상은 실제 임시 폴더의 직계 자식이어야 한다');
  assert.ok(path.basename(resolvedData).startsWith('wb-store-'), '삭제 대상은 이 테스트가 만든 폴더여야 한다');
  fs.rmSync(resolvedData, { recursive: true, force: true });
}
