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
  const storage = new Map();
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
    const stats = { renders: 0, reloads: 0, resets: 0, notices: [], authRejections: 0 };
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
    const modal = (title, body) => { stats.modal = { title, body }; };
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
