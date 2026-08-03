import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const consult = fs.readFileSync(path.join(here, '..', 'consult', 'index.html'), 'utf8');
const task = fs.readFileSync(path.join(here, '..', 'task', 'index.html'), 'utf8');
const releaseVersion = JSON.parse(fs.readFileSync(path.join(here, '..', 'version.json'), 'utf8')).v;

test('version.json matches both administrator app bundles', () => {
  for (const source of [consult, task]) {
    const match = source.match(/const APP_VER = '([^']+)'/);
    assert.ok(match);
    assert.equal(match[1], releaseVersion);
  }
});

test('두 관리자 앱은 로그인 성공과 운영 데이터 연결 상태를 구분해 안내한다', () => {
  for (const source of [consult, task]) {
    const status = source.slice(source.indexOf('function paintStatus()'), source.indexOf('function currentStaff()'));
    assert.match(status, /원장 로그인됨/);
    assert.match(status, /로컬 모드/);
    assert.match(status, /관리 비밀번호와 운영 데이터 연결키는 보안상 별개/);
    assert.match(status, /운영 데이터 연결 오류/);
    assert.match(status, /aria-labelledby="adminLocalModeTitle"/);
    assert.doesNotMatch(status, /role="(?:status|alert)"/);
    assert.ok(source.includes('if (syncReady) startSyncSession();'));
    assert.match(source, /paintAdminConnectionNotice/);
    assert.ok(source.includes("case 'syncsettings': go('settings')"));
  }
});

test('두 관리자 앱은 PIN을 PBKDF2로 저장하고 구형 비밀정보 링크를 흡수하지 않는다', () => {
  for (const source of [consult, task]) {
    assert.match(source, /name: 'PBKDF2'/);
    assert.match(source, /iterations: 120000/);
    assert.match(source, /q\.delete\('s'\); touched = true/);
    assert.match(source, /q\.delete\('t'\); touched = true/);
    assert.match(source, /<meta name="referrer" content="no-referrer">/);
    assert.ok(source.includes("this.post('/exchange'"));
    assert.match(source, /'#c=' \+ encodeURIComponent\(code\)/);
    assert.match(source, /const linkCodeVault = new Map\(\)/);
    assert.doesNotMatch(source, /state\.settings\.myToken = tk/);
    assert.doesNotMatch(source, /'&t='/);
    assert.ok(source.indexOf('history.replaceState') < source.indexOf('const exchanged = await sync.exchangeBootstrap'));
    assert.match(source, /data-act="revokeaccess"/);
    assert.match(source, /개인 링크는 발급 후 24시간 안에 한 번 열어야 합니다/);
    assert.doesNotMatch(source, /if \(cfg\.k\) state\.settings\.syncSecret/);
    assert.doesNotMatch(source, /state\.settings\.adminPin = cfg\.p/);
  }
});

test('안전 백업 블록은 비밀키·PIN·개인 토큰을 내보내지 않는다', () => {
  const consultExport = consult.slice(consult.indexOf("case 'export':"), consult.indexOf("case 'import':"));
  const taskExport = task.slice(task.indexOf("case 'export':"), task.indexOf("case 'import':"));
  for (const block of [consultExport, taskExport]) {
    assert.doesNotMatch(block, /syncSecret\s*:/);
    assert.doesNotMatch(block, /adminPin(?:Hash|Salt|Version)?\s*:/);
    assert.doesNotMatch(block, /myToken\s*:/);
  }
});


test('task 저장소는 관리자와 검증된 개인 ID별로 격리하고 legacy는 관리자만 읽는다', () => {
  assert.ok(task.includes("const LEGACY_LS_KEY = 'wb_taskboard_v1'"));
  assert.ok(task.includes('const SAFE_SCOPE_ID = /^[A-Za-z0-9_-]'));
  assert.ok(task.includes("'wb_task_v2_person_' + (SAFE_SCOPE_ID || 'invalid')"));
  assert.ok(task.includes(": 'wb_task_v2_admin'"));
  assert.ok(task.includes("!HAS_PERSON_SCOPE ? localStorage.getItem(LEGACY_LS_KEY) : ''"));
  assert.ok(task.includes('get staffId() { return SAFE_SCOPE_ID; }'));
  assert.ok(task.includes('get isStaffLink() { return HAS_PERSON_SCOPE; }'));
  assert.doesNotMatch(task, /const LS_KEY = 'wb_taskboard_v1'/);
});

function createSyncHarness(source, options = {}) {
  const start = source.indexOf('const SYNC_BATCH_SIZE = ');
  const end = source.indexOf('\nfunction queueSync()', start);
  assert.ok(start >= 0 && end > start, 'inline sync block을 찾지 못했습니다');
  let block = source.slice(start, end);
  if (options.roundLimit !== undefined) {
    block = block.replace(/const MAX_SYNC_ROUNDS = \d+;/, 'const MAX_SYNC_ROUNDS = ' + options.roundLimit + ';');
  }

  const stats = { saves: 0, calls: 0 };
  const context = {
    SYNC_APP: 'test',
    state: {
      staff: [], tasks: [], checks: {},
      settings: { syncCursors: {}, pullAt: 0, pushAt: 0 }
    },
    session: { isStaffLink: false, staffId: '', isAdmin: true },
    now: () => 1_700_000_000_000,
    save: () => { stats.saves += 1; },
    render: () => {},
    paintStatus: () => {},
    toast: () => {},
    console: { warn: () => {} },
    setTimeout,
    clearTimeout
  };
  vm.createContext(context);
  vm.runInContext(block + '\nthis.__sync = sync;', context);
  const sync = context.__sync;
  sync.auth = () => ({ mode: 'admin', secret: 'test-fixture' });
  sync.collect = () => Array.from({ length: options.changeCount || 0 }, (_, index) => index);
  sync.apply = () => {};
  sync.post = async () => {
    stats.calls += 1;
    const more = typeof options.serverMore === 'function'
      ? options.serverMore(stats.calls)
      : Boolean(options.serverMore);
    return { ok: true, changes: [], now: stats.calls, more };
  };
  return { context, sync, stats };
}

function pushedCursor(context) {
  const settings = context.state.settings;
  return settings.syncCursors.admin
    ? Number(settings.syncCursors.admin.pushAt) || 0
    : Number(settings.pushAt) || 0;
}

test('consult와 task는 24,001건을 모두 보낸 뒤에만 push cursor를 전진한다', async () => {
  for (const source of [consult, task]) {
    const batch = Number(source.match(/const SYNC_BATCH_SIZE = (\d+);/)[1]);
    const rounds = Number(source.match(/const MAX_SYNC_ROUNDS = (\d+);/)[1]);
    assert.ok(batch * rounds >= 255_000, '허용 최대 consult import보다 처리 상한이 작습니다');

    const harness = createSyncHarness(source, { changeCount: 24_001 });
    await harness.sync.run();
    assert.equal(harness.stats.calls, Math.ceil(24_001 / batch));
    assert.equal(harness.stats.saves, 1);
    assert.equal(harness.sync.err, '');
    assert.equal(pushedCursor(harness.context), 1_700_000_000_000);
  }
});

test('sync guard 소진 또는 서버 다음 페이지 잔존 시 push cursor를 유지해 재시도한다', async () => {
  for (const source of [consult, task]) {
    const pending = createSyncHarness(source, { roundLimit: 2, changeCount: 801 });
    await pending.sync.run();
    assert.equal(pending.stats.calls, 2);
    assert.equal(pending.stats.saves, 0);
    assert.equal(pushedCursor(pending.context), 0);
    assert.match(pending.sync.err, /동기화 처리 한도 초과.*미전송 1건/);

    await pending.sync.run();
    assert.equal(pending.stats.calls, 4, '같은 cursor에서 다시 수집·재시도해야 합니다');
    assert.equal(pushedCursor(pending.context), 0);

    const server = createSyncHarness(source, {
      roundLimit: 2,
      changeCount: 0,
      serverMore: () => true
    });
    await server.sync.run();
    assert.equal(server.stats.calls, 2);
    assert.equal(server.stats.saves, 0);
    assert.equal(pushedCursor(server.context), 0);
    assert.match(server.sync.err, /동기화 처리 한도 초과.*서버 다음 페이지 남음/);
  }
});
