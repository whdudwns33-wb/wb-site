'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const recoveryCore = fs.readFileSync(path.join(__dirname, 'sync-recovery-core.js'), 'utf8');

function sourceBetween(from, to) {
  const start = html.indexOf(from);
  const end = html.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `${from} must remain extractable`);
  return html.slice(start, end);
}

const syncSource = sourceBetween('const sync = {', 'function queueSync()');
const recoverySource = sourceBetween('function syncRecoveryScope()', 'let syncRenderPending = false');
const referencesSource = sourceBetween('function checkReferencesRevokedTask', 'function clearRevokedTaskEditors');

function initialState(overrides = {}) {
  return {
    version: 2,
    staff: [{ id: 'staff-a', name: '창작 교사', updatedAt: 10 }],
    tasks: [
      { id: 'lesson-a', staffId: 'staff-a', title: '수정 대기 수업', updatedAt: 9000 },
      { id: 'local-only', staffId: 'staff-a', title: '이 기기에만 남은 업무', updatedAt: 9500 }
    ],
    checks: {
      'lesson-a|2026-09-08': { taskId: 'lesson-a', note: '보존할 창작 메모', updatedAt: 200 },
      '__contact__case-a|2026-09-08': { taskId: '__contact__case-a', note: '전용 API 기록', updatedAt: 300 }
    },
    settings: { dataGeneration: 7, taskRevocationCursor: 2, pushAt: 100, pullAt: 500,
      syncSecret: 'test-admin-secret', myToken: 'test-person-token', onboardingCasReconcileVersion: 1 },
    ...overrides
  };
}

function canonicalPage(overrides = {}) {
  return {
    ok: true, dataGeneration: 7, authRole: 'admin', now: 1000, more: false,
    recoveryPull: { snapshotAt: 800, complete: true, cursors: { staff: 'staff-a', tasks: 'lesson-a', checks: '' } },
    taskRevocations: { version: 1, cursor: 4, more: false, rows: [] },
    changes: [
      { table: 'staff', key: 'staff-a', owner: 'staff-a', data: { id: 'staff-a', name: '서버 교사', updatedAt: 10 } },
      { table: 'tasks', key: 'lesson-a', owner: 'staff-a', data: { id: 'lesson-a', staffId: 'staff-a', title: '서버 정본 수업', updatedAt: 50 } }
    ],
    ...overrides
  };
}

function conflict(code = 'LESSON_SCHEDULE_ENDPOINT_REQUIRED') {
  return Object.assign(new Error(code), { code, status: 409 });
}

function runtime(options = {}) {
  const storage = options.storage || new Map();
  const writes = [];
  const calls = [];
  const events = new Map();
  const elements = new Map();
  const seed = options.state || initialState();
  const scopeId = options.personId || '';
  const cacheKey = scopeId ? 'wb_taskboard_person_v1_' + scopeId : 'wb_taskboard_v1';
  storage.set(cacheKey, JSON.stringify(seed));
  const context = vm.createContext({
    __initialJSON: JSON.stringify(seed), __scopeId: scopeId, __cacheKey: cacheKey,
    __accessRole: options.accessRole || '', __verified: !!options.verified,
    __getElement(selector) {
      if (!elements.has(selector)) elements.set(selector, { hidden: true, inert: false, innerHTML: '' });
      return elements.get(selector);
    },
    __storage: {
      get length() { return storage.size; },
      key(index) { return [...storage.keys()][index] ?? null; },
      getItem(key) {
        if (options.failRead && options.failRead(key, cacheKey)) throw new Error('StorageReadError');
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        if (options.failWrite && options.failWrite(key, value, cacheKey)) throw new Error('QuotaExceededError');
        storage.set(key, String(value));
        writes.push({ key, value: String(value) });
      },
      removeItem(key) { storage.delete(key); }
    },
    __addListener(name, listener) { events.set(name, listener); },
    __removeListener(name) { events.delete(name); },
    __post: async (url, bodyJSON) => {
      const body = JSON.parse(bodyJSON);
      calls.push({ url, body });
      const response = options.post ? await options.post(body, calls.length, app) : canonicalPage();
      return JSON.stringify(response);
    },
    console: { warn() {} }, setTimeout() { return 1; }, clearTimeout() {},
  });
  vm.runInContext(`
    ${recoveryCore}
    const window = { WBSyncRecoveryCore, addEventListener: __addListener, removeEventListener: __removeListener };
    const localStorage = __storage, LS_KEY = __cacheKey;
    const SYNC_APP = 'task', SYNC_URL = '/test-api';
    let state = JSON.parse(__initialJSON);
    const now = () => 1000;
    const $ = __getElement;
    const esc = value => String(value).replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
    const stats = { renders: 0, reloads: 0, resets: 0, notices: [], authRejections: 0, closedModals: 0 };
    let personAccessProblem = null, ownLessonChangeLastLoadedAt = 1000, bookIssueLoaded = true, route = 'today';
    const onboardingServerConfirmedAt = new Map(), studentChangeMovedCheckKeys = new Set();
    const ownerOfCheck = () => __scopeId || 'staff-a';
    const isContactCheckKey = key => key.startsWith('__contact__');
    const onboardingReconcileChanges = () => [];
    const paintStatus = () => {};
    const isTaskEditorActive = () => false;
    const render = () => { stats.renders++; };
    const renderAfterSync = render;
    const toast = message => stats.notices.push(message);
    const modal = (title, body, footer) => { stats.modal = { title, body, footer }; };
    const closeModal = () => { stats.closedModals++; stats.modal = null; };
    const save = () => localStorage.setItem(LS_KEY, JSON.stringify(state));
    const loadOwnLessonChangeQueue = async () => {};
    const loadBookIssues = async () => {};
    const resetLessonHandoffs = () => {};
    const location = { reload() { stats.reloads++; } };
    const session = {
      get staffId() { return __scopeId; },
      get isStaffLink() { return !!__scopeId; },
      get isManager() { return !!__scopeId && sync.personVerified && sync.accessRole === 'manager'; },
      get isAdmin() { return !__scopeId || this.isManager; }
    };
    const hasSensitiveManagerCache = role => role === 'manager' || state.settings.managerCacheSensitive === true;
    const hasVerifiedPersonAuth = () => session.isStaffLink && sync.personVerified && !!sync.auth();
    const classifyPersonLinkError = error => ({ kind: Number(error.status) === 401 || Number(error.status) === 403 ? 'auth_required' : 'network' });
    const resetPersonCache = token => {
      stats.resets++;
      WBSyncRecoveryCore.clearArchives(localStorage, 'person:' + __scopeId);
      state = { version: 2, staff: [], tasks: [], checks: {}, settings: { myToken: token, dataGeneration: 7 } };
      sync.personVerified = false; sync.accessRole = '';
    };
    const handlePersonAuthRejection = error => { stats.authRejections++; resetPersonCache(''); error.personAuthHandled = true; };
    const applyTaskRevocationPage = page => ({ cursor: page ? page.cursor : 0, removed: 0, more: !!(page && page.more) });
    ${referencesSource}
    ${syncSource}
    ${recoverySource}
    sync.accessRole = __accessRole;
    sync.personVerified = __verified;
    sync.post = async (url, body) => JSON.parse(await __post(url, JSON.stringify(body)));
  `, context);
  const app = {
    calls, writes, storage, elements, cacheKey,
    get(expression) { return vm.runInContext(expression, context); },
    json(expression) { return JSON.parse(vm.runInContext('JSON.stringify(' + expression + ')', context)); },
    set(source) { return vm.runInContext(source, context); },
    run() { return vm.runInContext('sync.run()', context); },
    recover() {
      return vm.runInContext(`recoverSyncConflict(sync.auth(),
        { status: 409, code: 'LESSON_SCHEDULE_ENDPOINT_REQUIRED' }, syncRecoveryLocalChanges())`, context);
    },
    archives(scope = scopeId ? 'person:' + scopeId : 'admin') {
      context.__archiveScope = scope;
      return app.json('WBSyncRecoveryCore.readArchives(localStorage, __archiveScope).records');
    },
    dispatchStorage(key = cacheKey) { events.get('storage')?.({ key }); }
  };
  return app;
}

test('a sync conflict recovers canonically once and never resends the archived pending changes', async () => {
  const app = runtime({ post(body, call) {
    if (call === 1) throw conflict();
    if (body.recoveryPull) return canonicalPage();
    return { ...canonicalPage(), changes: [], now: 1001 };
  } });
  assert.equal(await app.run(), true);
  assert.equal(app.calls.length, 2);
  assert.ok(app.calls[0].body.changes.some(row => row.id === 'local-only'));
  assert.deepEqual(app.calls[1].body.changes, []);
  assert.equal(app.calls[1].body.since, 0);
  assert.deepEqual(app.json('state.tasks.map(row => [row.id, row.title])'), [['lesson-a', '서버 정본 수업']]);
  assert.equal(app.get('state.settings.pullAt'), 800);
  assert.equal(app.get('sync.busy'), false);
  assert.equal(app.get('sync.recovering'), false);
  assert.equal(app.get('sync.err'), '');
  const archived = app.archives().flatMap(record => record.changes);
  assert.ok(archived.some(row => row.id === 'local-only'));
  assert.ok(archived.some(row => row.k === '__contact__case-a|2026-09-08'), 'the archive also retains checks excluded from generic sync');
  assert.ok(archived.some(row => row.data.note === '보존할 창작 메모'));
  assert.ok(app.writes.findIndex(write => write.key !== app.cacheKey) < app.writes.findIndex(write => write.key === app.cacheKey));
  assert.equal(await app.run(), true);
  assert.deepEqual(app.calls[2].body.changes, []);
  assert.equal(app.archives().length, 1);
});

test('all canonical and revocation pages finish before the active cache is replaced', async () => {
  const original = initialState();
  const app = runtime({ state: original, post(body, call, running) {
    assert.equal(running.storage.get(running.cacheKey), JSON.stringify(original));
    assert.deepEqual(body.changes, []);
    if (call === 1) return canonicalPage({
      recoveryPull: { snapshotAt: 800, complete: false, cursors: { staff: 'staff-a', tasks: 'lesson-a', checks: '' } },
      taskRevocations: { version: 1, cursor: 4, more: true, rows: [] }
    });
    assert.equal(body.taskRevocationCursor, 4);
    assert.equal(body.recoveryPull.snapshotAt, 800);
    return canonicalPage({
      recoveryPull: { snapshotAt: 800, complete: true, cursors: { staff: 'staff-a', tasks: 'lesson-b', checks: 'lesson-b|2026-09-08' } },
      changes: [{ table: 'tasks', key: 'lesson-b', owner: 'staff-a', data: { id: 'lesson-b', staffId: 'staff-a', updatedAt: 60 } }],
      taskRevocations: { version: 1, cursor: 5, more: false,
        rows: [{ taskId: 'lesson-a', formerOwner: 'staff-a', revokedAt: 700 }] }
    });
  } });
  assert.equal(await app.recover(), true);
  assert.equal(app.calls.length, 2);
  assert.deepEqual(app.json('state.tasks.map(row => row.id)'), ['lesson-b']);
  assert.equal(app.get('state.settings.taskRevocationCursor'), 5);
});

test('edits that arrive during the pull are archived before replacement', async () => {
  const app = runtime({ post(body, call, running) {
    running.set(`state.checks['lesson-a|2026-09-08'] = { taskId: 'lesson-a', note: '조회 도중 새로 저장한 메모', updatedAt: 1100 }; save();`);
    return canonicalPage();
  } });
  assert.equal(await app.recover(), true);
  const notes = app.archives().flatMap(record => record.changes.map(row => row.data.note));
  assert.ok(notes.includes('보존할 창작 메모'));
  assert.ok(notes.includes('조회 도중 새로 저장한 메모'));
  assert.ok(!app.json('sync.collect(0)').some(row => row.data.note === '조회 도중 새로 저장한 메모'));
});

test('archive storage failure prevents both the pull and cache replacement', async () => {
  const app = runtime({ failWrite: (key, value, cacheKey) => key !== cacheKey });
  const before = app.storage.get(app.cacheKey);
  await assert.rejects(app.recover(), /보관|보존/);
  assert.equal(app.calls.length, 0);
  assert.equal(app.storage.get(app.cacheKey), before);
  assert.equal(app.get('state.tasks.length'), 2);
  assert.equal(app.get('sync.recovering'), false);
});

test('active-cache storage failure leaves original data and verified archives available', async () => {
  const app = runtime({ failWrite: (key, value, cacheKey) => key === cacheKey });
  const before = app.storage.get(app.cacheKey);
  await assert.rejects(app.recover(), /QuotaExceededError/);
  assert.equal(app.storage.get(app.cacheKey), before);
  assert.equal(app.get('state.tasks.length'), 2);
  assert.ok(app.archives().length > 0);
  assert.equal(app.get('sync.recovering'), false);
  assert.equal(app.elements.get('#view').inert, false);
});

test('a failed later page cannot replace the original cache with a partial snapshot', async () => {
  const app = runtime({ post(body, call) {
    if (call > 1) throw Object.assign(new Error('network failed'), { code: 'NETWORK_ERROR' });
    return canonicalPage({ recoveryPull: { snapshotAt: 800, complete: false,
      cursors: { staff: 'staff-a', tasks: 'lesson-a', checks: '' } } });
  } });
  const before = app.storage.get(app.cacheKey);
  await assert.rejects(app.recover(), /network failed/);
  assert.equal(app.storage.get(app.cacheKey), before);
  assert.equal(app.get('state.tasks.length'), 2);
  assert.equal(app.elements.get('#tabs').inert, false);
});

test('failure to archive a new edit at the end retains the edited active cache', async () => {
  let archiveWrites = 0;
  const app = runtime({
    failWrite(key, value, cacheKey) { return key !== cacheKey && ++archiveWrites > 1; },
    post(body, call, running) {
      running.set("state.checks['lesson-a|2026-09-08'].note = '늦게 저장한 창작 메모'; state.checks['lesson-a|2026-09-08'].updatedAt = 1100; save();");
      return canonicalPage();
    }
  });
  await assert.rejects(app.recover(), /보관|보존/);
  assert.equal(app.get("state.checks['lesson-a|2026-09-08'].note"), '늦게 저장한 창작 메모');
  assert.equal(JSON.parse(app.storage.get(app.cacheKey)).checks['lesson-a|2026-09-08'].note, '늦게 저장한 창작 메모');
  assert.equal(app.get('state.tasks.length'), 2);
  assert.equal(app.get('sync.recovering'), false);
});

test('revocation pages continue after the canonical tables are complete', async () => {
  const app = runtime({ post(body, call) {
    return canonicalPage({ changes: call === 1 ? canonicalPage().changes : [],
      taskRevocations: { version: 1, cursor: call + 3, more: call === 1, rows: [] } });
  } });
  assert.equal(await app.recover(), true);
  assert.equal(app.calls.length, 2);
  assert.equal(app.calls[1].body.recoveryPull.complete, true);
  assert.equal(app.calls[1].body.taskRevocationCursor, 4);
  assert.equal(app.get('state.settings.taskRevocationCursor'), 5);
});

test('malformed response, stalled cursor, and changed snapshot all fail before replacement', async () => {
  for (const variant of ['invalid', 'stalled', 'snapshot']) {
    const app = runtime({ post(body, call) {
      if (variant === 'invalid') return canonicalPage({ changes: [{ table: 'tasks', key: 'wrong', data: { id: 'different' } }] });
      return canonicalPage({ recoveryPull: {
        snapshotAt: variant === 'snapshot' && call > 1 ? 801 : 800,
        complete: false, cursors: { staff: 'staff-a', tasks: 'lesson-a', checks: '' }
      } });
    } });
    const before = app.storage.get(app.cacheKey);
    await assert.rejects(app.recover(), error => ['SYNC_RECOVERY_INVALID_RESPONSE', 'SYNC_RECOVERY_STALLED'].includes(error.code), variant);
    assert.equal(app.storage.get(app.cacheKey), before, variant);
    assert.ok(app.calls.length <= 2, variant);
  }
});

test('person recovery enforces the current bearer and server owner scope', async () => {
  for (const variant of ['auth', 'owner']) {
    const app = runtime({ personId: 'staff-a', accessRole: 'staff', verified: true,
      post(body, call, running) {
        if (variant === 'auth') running.set("state.settings.myToken = 'changed-token';");
        return canonicalPage({ authRole: 'staff', changes: [
          { table: 'tasks', key: 'lesson-a', owner: variant === 'owner' ? 'staff-b' : 'staff-a',
            data: { id: 'lesson-a', staffId: 'staff-a', updatedAt: 20 } }
        ] });
      }
    });
    const before = app.storage.get(app.cacheKey);
    await assert.rejects(app.recover(), error => ['SYNC_RECOVERY_AUTH_CHANGED', 'SYNC_RECOVERY_INVALID_RESPONSE'].includes(error.code));
    assert.equal(app.storage.get(app.cacheKey), before);
  }
});

test('a role change between recovery pages cannot publish a mixed-scope cache', async () => {
  const app = runtime({ personId: 'staff-a', accessRole: 'staff', verified: true,
    post(body, call) {
      return canonicalPage({ authRole: call === 1 ? 'staff' : 'manager', recoveryPull: {
        snapshotAt: 800, complete: call > 1, cursors: { staff: 'staff-a', tasks: call === 1 ? 'lesson-a' : 'lesson-b', checks: '' }
      } });
    }
  });
  const before = app.storage.get(app.cacheKey);
  await assert.rejects(app.recover(), error => error.status === 403 && error.code === 'AUTH_REQUIRED');
  assert.equal(app.storage.get(app.cacheKey), before);
  assert.equal(app.get('sync.accessRole'), 'staff');
});

test('authentication rejection during recovery revokes the person connection once and stops retrying', async () => {
  const app = runtime({ personId: 'staff-a', accessRole: 'staff', verified: true,
    post(body, call) {
      if (call === 1) throw conflict();
      throw Object.assign(new Error('AUTH_REQUIRED'), { status: 401, code: 'AUTH_REQUIRED' });
    }
  });
  assert.equal(await app.run(), false);
  assert.equal(app.calls.length, 2);
  assert.equal(app.get('stats.authRejections'), 1);
  assert.equal(app.get('sync.personVerified'), false);
  assert.equal(app.get('state.settings.myToken'), '');
  assert.equal(app.get('sync.busy'), false);
  assert.equal(app.get('sync.recovering'), false);
});

test('a stale response after bearer cleanup cannot recreate an archive or start a recovery request', async () => {
  const app = runtime({ personId: 'staff-a', accessRole: 'staff', verified: true,
    post(body, call, running) {
      running.set("resetPersonCache('');");
      throw conflict();
    }
  });
  assert.equal(await app.run(), false);
  assert.equal(app.calls.length, 1, 'the rejected original request must not trigger another request');
  assert.equal(app.writes.length, 0, 'the old pending rows must not be archived after auth cleanup');
  assert.deepEqual(app.archives(), []);
  assert.equal(app.get('state.tasks.length'), 0);
  assert.equal(app.get('sync.busy'), false);
  assert.equal(app.get('sync.recovering'), false);
  assert.equal(app.get('sync.problem.code'), 'SYNC_RECOVERY_AUTH_CHANGED');
});

test('a data generation change before recovery rejects the old pending context before archiving', async () => {
  const app = runtime({ post(body, call, running) {
    running.set('state.settings.dataGeneration = 8;');
    throw conflict();
  } });
  assert.equal(await app.run(), false);
  assert.equal(app.calls.length, 1);
  assert.equal(app.writes.length, 0);
  assert.deepEqual(app.archives(), []);
  assert.equal(app.get('state.settings.dataGeneration'), 8);
  assert.equal(app.get('state.tasks.length'), 2);
  assert.equal(app.get('sync.problem.code'), 'SYNC_RECOVERY_AUTH_CHANGED');
  assert.equal(app.get('sync.busy'), false);
});

test('a manager context dropped before recovery cannot archive old manager rows with a retained bearer', async () => {
  const app = runtime({ personId: 'staff-a', accessRole: 'manager', verified: true,
    post(body, call, running) {
      running.set("resetPersonCache('test-person-token'); sync.accessRole = 'staff'; sync.personVerified = true;");
      throw conflict();
    }
  });
  assert.equal(await app.run(), false);
  assert.equal(app.calls.length, 1);
  assert.equal(app.writes.length, 0);
  assert.deepEqual(app.archives(), []);
  assert.equal(app.get('state.settings.myToken'), 'test-person-token');
  assert.equal(app.get('sync.accessRole'), 'staff');
  assert.equal(app.get('state.tasks.length'), 0);
  assert.equal(app.get('sync.problem.code'), 'SYNC_RECOVERY_AUTH_CHANGED');
});

test('an active-cache read failure before recovery setup does not latch busy or inert state', async () => {
  const app = runtime({
    failRead: (key, cacheKey) => key === cacheKey,
    post() { throw conflict(); }
  });
  const before = app.storage.get(app.cacheKey);
  assert.equal(await app.run(), false);
  assert.equal(app.calls.length, 1);
  assert.equal(app.storage.get(app.cacheKey), before);
  assert.equal(app.get('state.tasks.length'), 2);
  assert.ok(app.archives().length > 0, 'the verified archive remains available after the later cache read fails');
  assert.equal(app.get('sync.busy'), false);
  assert.equal(app.get('sync.recovering'), false);
  assert.notEqual(app.elements.get('#view')?.inert, true);
  assert.notEqual(app.elements.get('#tabs')?.inert, true);
});

test('manager downgrade clears the person cache before exposing a staff snapshot', async () => {
  const app = runtime({ personId: 'staff-a', accessRole: 'manager', verified: true,
    post: () => canonicalPage({ authRole: 'staff' }) });
  assert.equal(await app.recover(), false);
  assert.equal(app.get('stats.resets'), 1);
  assert.equal(app.get('stats.reloads'), 1);
  assert.equal(app.get('state.tasks.length'), 0);
  assert.deepEqual(app.archives(), []);
});

test('another tab changing the scoped cache aborts replacement', async () => {
  const app = runtime({ post(body, call, running) {
    running.dispatchStorage();
    return canonicalPage();
  } });
  const before = app.storage.get(app.cacheKey);
  await assert.rejects(app.recover(), error => error.code === 'SYNC_RECOVERY_LOCAL_CHANGED');
  assert.equal(app.storage.get(app.cacheKey), before);
  assert.equal(app.get('state.tasks.length'), 2);
});

test('future canonical timestamps are not reuploaded but later edits become pending again', async () => {
  const app = runtime({ post: () => canonicalPage({ changes: [
    { table: 'tasks', key: 'lesson-a', owner: 'staff-a', data: { id: 'lesson-a', staffId: 'staff-a', title: '서버 미래 시각', updatedAt: 2000 } }
  ] }) });
  assert.equal(await app.recover(), true);
  assert.deepEqual(app.json('sync.collect(state.settings.pushAt)'), []);
  app.set("state.tasks[0].title = '새로 수정'; state.tasks[0].updatedAt = 1001;");
  assert.equal(app.get('sync.collect(state.settings.pushAt).length'), 1);
});

test('archive access stays scoped to the authenticated person and escapes the displayed record', async () => {
  const app = runtime({ personId: 'staff-a', accessRole: 'staff', verified: true,
    post: () => canonicalPage({ authRole: 'staff' }) });
  app.set("state.tasks[0].title = '<img src=x onerror=alert(1)>'; state.tasks[0].secret = 'must-not-archive';");
  assert.equal(await app.recover(), true);
  assert.deepEqual(app.archives('person:staff-b'), []);
  assert.ok(!JSON.stringify(app.archives()).includes('must-not-archive'));
  app.set('showSyncRecoveryArchives();');
  assert.match(app.get('stats.modal.body'), /&lt;img/);
  assert.doesNotMatch(app.get('stats.modal.body'), /<img/);
  app.set('sync.personVerified = false;');
  assert.deepEqual(app.json('visibleSyncRecoveryArchives()'), []);
});

test('confirming recovery hides its notice while preserving archive bytes and a working history entry', async () => {
  const app = runtime();
  assert.equal(await app.recover(), true);
  const archiveKeys = [...app.storage.keys()].filter(key => key.startsWith('wb-task-sync-recovery:v1:'));
  const before = archiveKeys.map(key => app.storage.get(key));
  assert.equal(app.elements.get('#syncRecoveryNotice').hidden, false);
  assert.equal(app.elements.get('#syncRecoveryHistory').hidden, false);
  assert.match(html, /<footer[^>]*id="syncRecoveryHistory"[^>]*>[\s\S]*?data-act="viewsyncrecovery"[\s\S]*?<\/footer>/);
  assert.match(html, /case 'acksyncrecovery': acknowledgeSyncRecoveryArchives\(\); break;/);
  app.set('showSyncRecoveryArchives();');
  assert.match(app.get('stats.modal.footer'), /data-act="acksyncrecovery"[^>]*>확인 완료/);
  assert.match(app.get('stats.modal.body'), /보존할 창작 메모/);
  app.set('acknowledgeSyncRecoveryArchives();');
  assert.equal(app.elements.get('#syncRecoveryNotice').hidden, true);
  assert.equal(app.elements.get('#syncRecoveryNotice').innerHTML, '');
  assert.equal(app.elements.get('#syncRecoveryHistory').hidden, false);
  assert.equal(app.get('stats.modal'), null);
  assert.equal(app.get('syncRecoveryReviewContext'), null);
  assert.deepEqual(archiveKeys.map(key => app.storage.get(key)), before);
  assert.deepEqual(app.json('Array.from(syncRecoveryAcknowledgedIds())'), app.archives().map(record => record.id));
  app.set('showSyncRecoveryArchives();');
  assert.match(app.get('stats.modal.body'), /보존할 창작 메모/);
  assert.match(app.get('stats.modal.body'), /확인 완료/);
  assert.match(app.get('stats.modal.footer'), /모두 확인한 보존 기록/);
  assert.doesNotMatch(app.get('stats.modal.footer'), /data-act="acksyncrecovery"/);
});

test('confirmed recovery remains quiet across repeated rendering, another click and a fresh runtime', async () => {
  const app = runtime();
  assert.equal(await app.recover(), true);
  app.set('showSyncRecoveryArchives(); acknowledgeSyncRecoveryArchives();');
  const stored = [...app.storage.entries()];
  const writes = app.writes.length;
  app.set('acknowledgeSyncRecoveryArchives(); renderSyncRecoveryNotice(); renderSyncRecoveryNotice();');
  assert.equal(app.elements.get('#syncRecoveryNotice').hidden, true);
  assert.equal(app.get('stats.closedModals'), 1);
  assert.equal(app.writes.length, writes);
  assert.deepEqual([...app.storage.entries()], stored);
  const reloaded = runtime({ storage: app.storage, state: app.json('state') });
  reloaded.set('renderSyncRecoveryNotice(); showSyncRecoveryArchives();');
  assert.equal(reloaded.elements.get('#syncRecoveryNotice').hidden, true);
  assert.equal(reloaded.elements.get('#syncRecoveryHistory').hidden, false);
  assert.match(reloaded.get('stats.modal.body'), /보존할 창작 메모/);
  assert.match(reloaded.get('stats.modal.footer'), /모두 확인한 보존 기록/);
  assert.deepEqual(reloaded.archives(), app.archives());
});

test('a new archive arriving while the review is open keeps its own notice after confirmation', async () => {
  const app = runtime();
  assert.equal(await app.recover(), true);
  app.set('showSyncRecoveryArchives();');
  const reviewed = app.json('syncRecoveryReviewContext.recordIds');
  const added = app.json(`WBSyncRecoveryCore.saveArchive(localStorage, WBSyncRecoveryCore.buildArchive({
    scopeId: 'admin', accessRole: 'admin', dataGeneration: 7, createdAt: 1800000000000,
    error: { status: 409, code: 'REVISION_CONFLICT' },
    changes: [{ table: 'checks', k: 'lesson-a|2026-09-08', owner: 'staff-a',
      data: { note: '확인 창을 연 뒤 생긴 새 창작 메모', updatedAt: 1100 } }]
  })).record`);
  app.set('renderSyncRecoveryNotice(); acknowledgeSyncRecoveryArchives();');
  assert.deepEqual(app.json('Array.from(syncRecoveryAcknowledgedIds())'), reviewed);
  assert.equal(app.elements.get('#syncRecoveryNotice').hidden, false);
  assert.match(app.elements.get('#syncRecoveryNotice').innerHTML, /보존된 미전송 내용 확인/);
  assert.equal(app.archives().length, 2);
  app.set('showSyncRecoveryArchives();');
  assert.deepEqual(app.json('syncRecoveryReviewContext.recordIds'), [added.id]);
  assert.match(app.get('stats.modal.body'), /확인 창을 연 뒤 생긴 새 창작 메모/);
  assert.match(app.get('stats.modal.body'), /확인 완료/);
  assert.match(app.get('stats.modal.body'), /확인 필요/);
  app.set('acknowledgeSyncRecoveryArchives();');
  assert.equal(app.elements.get('#syncRecoveryNotice').hidden, true);
  assert.equal(app.elements.get('#syncRecoveryHistory').hidden, false);
  assert.equal(app.archives().length, 2);
});

test('confirming preserved records does not hide or clear an active sync problem', async () => {
  const app = runtime();
  assert.equal(await app.recover(), true);
  app.set(`sync.problem = { code: 'NETWORK_ERROR', message: '새로운 연결 문제' };
    sync.err = '새로운 연결 문제'; renderSyncRecoveryNotice();
    showSyncRecoveryArchives(); acknowledgeSyncRecoveryArchives();`);
  assert.equal(app.elements.get('#syncRecoveryNotice').hidden, false);
  assert.match(app.elements.get('#syncRecoveryNotice').innerHTML, /새로운 연결 문제/);
  assert.match(app.elements.get('#syncRecoveryNotice').innerHTML, /data-act="retryauthcheck"/);
  assert.doesNotMatch(app.elements.get('#syncRecoveryNotice').innerHTML, /data-act="viewsyncrecovery"/);
  assert.equal(app.get('sync.problem.code'), 'NETWORK_ERROR');
  assert.equal(app.get('sync.err'), '새로운 연결 문제');
  assert.equal(app.elements.get('#syncRecoveryHistory').hidden, false);
});

test('auth, owner and generation changes cannot confirm a previously opened review', async () => {
  for (const change of ["state.settings.myToken = 'replacement-token';", 'sync.personVerified = false;',
    "__scopeId = 'staff-b';", 'state.settings.dataGeneration = 8;']) {
    const app = runtime({ personId: 'staff-a', accessRole: 'staff', verified: true,
      post: () => canonicalPage({ authRole: 'staff' }) });
    assert.equal(await app.recover(), true);
    app.set('showSyncRecoveryArchives();');
    const before = [...app.storage.entries()];
    app.set(change + ' acknowledgeSyncRecoveryArchives();');
    assert.deepEqual([...app.storage.entries()], before, change);
    assert.equal(app.get('stats.closedModals'), 0, change);
    assert.match(app.get('stats.notices[stats.notices.length - 1]'), /현재 연결에서.*다시 열어/, change);
    assert.deepEqual(app.json("WBSyncRecoveryCore.readAcknowledgements(localStorage, 'person:staff-a').recordIds"), [], change);
  }
});

test('confirmation storage failures retain the notice, modal and original records with an error', async () => {
  for (const mode of ['quota', 'silent', 'readback']) {
    let failAck = false;
    const app = runtime({
      failWrite: key => failAck && mode === 'quota' && key.startsWith('wb-task-sync-recovery-ack:v1:'),
      failRead: key => failAck && mode === 'readback' && key.startsWith('wb-task-sync-recovery-ack:v1:')
    });
    assert.equal(await app.recover(), true);
    app.set('showSyncRecoveryArchives();');
    const archives = app.archives();
    failAck = true;
    if (mode === 'silent') app.set('localStorage.setItem = () => {};');
    app.set('acknowledgeSyncRecoveryArchives();');
    assert.equal(app.elements.get('#syncRecoveryNotice').hidden, false, mode);
    assert.equal(app.get('stats.closedModals'), 0, mode);
    assert.ok(app.get('stats.modal'), mode);
    assert.match(app.elements.get('#syncRecoveryAckError').textContent, /확인 상태를 저장하지 못했습니다/, mode);
    assert.match(app.get('stats.notices[stats.notices.length - 1]'), /안내와 보존 기록은 유지/, mode);
    assert.deepEqual(app.archives(), archives, mode);
    failAck = false;
    assert.deepEqual(app.json('Array.from(syncRecoveryAcknowledgedIds())'), [], mode);
    app.set('renderSyncRecoveryNotice();');
    assert.equal(app.elements.get('#syncRecoveryNotice').hidden, false, mode);
  }
});

test('unreadable or corrupt saved confirmations restore the recovery notice while retaining history', async () => {
  for (const mode of ['read', 'corrupt']) {
    let failAck = false;
    const app = runtime({ failRead: key => failAck && key.startsWith('wb-task-sync-recovery-ack:v1:') });
    assert.equal(await app.recover(), true);
    app.set('showSyncRecoveryArchives(); acknowledgeSyncRecoveryArchives();');
    assert.equal(app.elements.get('#syncRecoveryNotice').hidden, true);
    const archives = app.archives();
    if (mode === 'read') failAck = true;
    else app.storage.set([...app.storage.keys()].find(key => key.startsWith('wb-task-sync-recovery-ack:v1:')), '{broken');
    app.set('renderSyncRecoveryNotice(); showSyncRecoveryArchives();');
    assert.equal(app.elements.get('#syncRecoveryNotice').hidden, false, mode);
    assert.equal(app.elements.get('#syncRecoveryHistory').hidden, false, mode);
    assert.match(app.get('stats.modal.footer'), /data-act="acksyncrecovery"/);
    assert.deepEqual(app.archives(), archives, mode);
  }
});
