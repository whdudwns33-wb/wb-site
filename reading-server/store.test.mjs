/* 로컬 운영 데이터 보존·스냅샷·관리 내려받기 — 자체 시험 자료와 임시 폴더만 쓴다. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-store-test-'));
const FILE = path.join(DATA, 'db.json');
const PIN = 'store-test-only-not-a-real-secret';
const PORT = 20000 + process.pid % 10000;
process.env.DATA_DIR = DATA;
const store = await import('./store.mjs');
let passed = 0, srv;
const t = async (name, fn) => { await fn(); passed += 1; console.log('  ✓ ' + name); };
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const record = { state: { testOnly: true }, updatedAt: '2026-10-13T00:00:00Z' };
const fixture = {
  students: {}, states: {},
  naesinKo: { packs: { ko: { body: 'test-only-pack-content' } }, packIds: ['ko'], pendings: { ko: { body: 'test-only-pending-content' } },
    states: { test: record }, summaries: { test: { ready: 1 } }, reviews: { test: [{ verdict: 'pass' }] },
    overlays: { default: { testOnly: true } }, exams: { default: { packIds: ['ko'] } }, tasks: { default: { title: '자체 과제' } } },
  haru: { packs: { haru: { body: 'test-only-pack-content' } }, packIds: ['haru'], paperkeys: { key: { testOnly: true } },
    plans: { default: { testOnly: true } }, states: { test: record }, mocks: { test: { testOnly: true } }, paper: { test: { testOnly: true } }, atoms: { testOnly: true } },
  chunk: { states: { test: record }, summaries: { test: { testOnly: true } }, assigns: { default: { testOnly: true } }, customs: { texts: ['자체 창작 지문'] } },
  letter: { issues: { issue: { issue: { id: 'issue', title: '자체 창작 호' } } }, states: { test: record },
    push: { test: { endpoint: 'https://example.invalid/test' } }, calendar: { testOnly: true }, images: { image: { id: 'image', credit: '자체 제작' } } },
  naesin: { packs: { en: { body: 'test-only-pack-content' } }, packIds: ['en'], states: { test: record } },
  hanja: { books: { book: { body: 'test-only-pack-content' } }, index: [{ id: 'book' }], states: { test: record } }
};

function checkBackup(body) {
  for (const app of ['naesinKo', 'haru', 'chunk', 'letter', 'naesin', 'hanja']) {
    assert.ok(body[app], app + ' 백업이 빠졌다');
    assert.deepEqual(body[app].states.test, record, app + ' 학생 기록이 빠졌다');
  }
  for (const field of ['summaries', 'reviews', 'overlays', 'exams', 'tasks']) assert.deepEqual(body.naesinKo[field], fixture.naesinKo[field]);
  for (const field of ['paperkeys', 'plans', 'mocks', 'paper', 'atoms']) assert.deepEqual(body.haru[field], fixture.haru[field]);
  for (const field of ['summaries', 'assigns', 'customs']) assert.deepEqual(body.chunk[field], fixture.chunk[field]);
  for (const field of ['issues', 'push', 'calendar']) assert.deepEqual(body.letter[field], fixture.letter[field]);
  assert.deepEqual(body.letter.images, Object.values(fixture.letter.images));
  assert.deepEqual(body.naesinKo.packIds, ['ko']);
  assert.deepEqual(body.haru.packIds, ['haru']);
  assert.ok(!JSON.stringify(body).includes('test-only-pack-content'), '구매 팩·단어장 본문이 백업에 실렸다');
  assert.ok(!JSON.stringify(body).includes('test-only-pending-content'), '국어 검수 대기 자료가 백업에 실렸다');
}

try {
  await t('파일 없는 첫 실행은 빈 저장소로 시작한다', () => {
    assert.deepEqual(store.load().students, {});
    assert.ok(!fs.existsSync(FILE));
  });
  await t('손상·잘못된 형식의 기존 파일은 기동을 막고 원본과 메모리를 보존한다', () => {
    const initial = store.getDb();
    for (const raw of ['{"students":', 'null', '[]']) {
      fs.writeFileSync(FILE, raw);
      assert.throws(() => store.load(), /서버를 시작하지 않습니다/);
      assert.equal(fs.readFileSync(FILE, 'utf8'), raw);
      assert.equal(store.getDb(), initial);
    }
  });
  await t('기존 파일 읽기 실패도 빈 저장소로 넘어가지 않는다', () => {
    fs.unlinkSync(FILE);
    fs.mkdirSync(FILE);
    assert.throws(() => store.load(), /서버를 시작하지 않습니다/);
    assert.ok(fs.statSync(FILE).isDirectory());
    fs.rmdirSync(FILE);
  });
  fs.writeFileSync(FILE, JSON.stringify(fixture));
  store.load();
  await t('일일·수동 백업은 모든 앱 기록을 담고 구매 본문을 제외한다', async () => {
    checkBackup(store.snapshotBody());
    checkBackup(store.getBackup(store.snapshotNow()));
    for (const name of fs.readdirSync(path.join(DATA, 'backups'))) fs.unlinkSync(path.join(DATA, 'backups', name));
    store.persist();
    for (let n = 0; n < 100 && !store.listBackups().length; n += 1) await sleep(50);
    assert.equal(store.listBackups().length, 1);
    checkBackup(store.getBackup(store.listBackups()[0]));
    assert.deepEqual(JSON.parse(fs.readFileSync(FILE, 'utf8')).naesinKo.packs, fixture.naesinKo.packs, '실제 저장소에서 팩을 지웠다');
  });
  await t('실제 관리 내려받기와 저장된 스냅샷이 같은 앱 기록을 담는다', async () => {
    srv = spawn(process.execPath, [path.join(DIR, 'server.mjs')], {
      env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, ADMIN_PIN: PIN }, stdio: 'ignore'
    });
    const base = 'http://127.0.0.1:' + PORT;
    for (let i = 0; i < 100; i += 1) {
      try { await fetch(base + '/api/health'); break; } catch { await sleep(50); }
    }
    const login = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: PIN }) });
    assert.equal(login.status, 200);
    const { token } = await login.json();
    assert.ok(token);
    for (const suffix of ['', '?backup=' + store.listBackups()[0]]) {
      const res = await fetch(base + '/api/admin/export' + suffix, { headers: { Authorization: 'Bearer ' + token } });
      assert.equal(res.status, 200);
      checkBackup(await res.json());
    }
  });
  console.log('OK — ' + passed + '개 통과');
} finally {
  if (srv && srv.exitCode === null) { const stopped = once(srv, 'exit'); srv.kill(); await stopped; }
  assert.equal(path.dirname(path.resolve(DATA)), path.resolve(os.tmpdir()));
  fs.rmSync(DATA, { recursive: true, force: true });
}
