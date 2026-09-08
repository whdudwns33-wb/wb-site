'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function block(from, to) {
  const start = html.indexOf(from), end = html.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `${from}..${to}`);
  return html.slice(start, end);
}

function lesson(overrides = {}) {
  return {
    id: 'lesson-starlight', studentId: 'student-starlight', staffId: 'teacher-moon',
    title: '[수업] 별빛연습생 — 창작독해', taskKind: 'lesson_instruction',
    updatedAt: 150, deleted: false, ...overrides
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function harness(options = {}) {
  const task = lesson(options.task);
  const env = {
    task,
    auth: { mode: 'admin', token: 'synthetic-lesson-stop-token' },
    calls: [], effects: [], toasts: [], confirmations: [], confirmResult: true, responder: null,
    button: { disabled: false, textContent: '중단', isConnected: true },
    state: {
      settings: { dataGeneration: 3 },
      tasks: [task, lesson({ id: 'lesson-same-title', studentId: 'student-comet', staffId: 'teacher-sun' })],
      checks: { 'lesson-starlight|2026-09-07': { att: 'P', note: '직접 만든 독해 예문을 읽음', updatedAt: 140 } }
    },
    session: options.session || { isAdmin: true }
  };
  env.tombstone = { ...task, deleted: true, updatedAt: 200, stoppedAt: 200 };
  const context = vm.createContext({
    state: env.state, session: env.session, eForm: { id: task.id }, SYNC_APP: 'task',
    sync: {
      auth: () => env.auth,
      post: async (endpoint, body) => {
        env.calls.push({ endpoint, body: JSON.parse(JSON.stringify(body)) });
        return env.responder ? env.responder(endpoint, body) : { task: env.tombstone };
      }
    },
    toast: message => env.toasts.push(message),
    confirm: message => { env.confirmations.push(message); return env.confirmResult; },
    taskDisplayTitle: task => task.title,
    save: () => env.effects.push('save'), closeModal: () => env.effects.push('closeModal'),
    render: () => env.effects.push('render'), queueSync: () => env.effects.push('queueSync'),
    canEditTask: () => true, now: () => 999
  });
  const source = block('const isLesson =', '/** 수업 지시서 세부 형식 판별 */') + '\n' +
    block('function syncRecoveryAuthMatches(auth)', '/** 인증된 읽기 전용 스냅샷') + '\n' +
    block('const lessonStopSubmitting =', '/* ── 업무 수정 ── */');
  vm.runInContext(source + '\nglobalThis.lessonStopApi = { stop: stopRegularLessonTask, pending: id => lessonStopSubmitting.has(id) };', context);
  env.api = context.lessonStopApi;
  env.context = context;
  return env;
}

function assertActiveAndUnchanged(env) {
  assert.equal(env.state.tasks[0], env.task);
  assert.equal(env.task.deleted, false);
  assert.equal(env.task.updatedAt, 150);
  assert.deepEqual(env.effects, []);
  assert.equal(env.context.eForm.id, env.task.id);
  assert.ok(!env.toasts.some(message => message.includes('서버에 반영되었습니다')));
}

test('regular lesson stop sends exact stable identity and revision, then waits for the server tombstone', async () => {
  const env = harness();
  const wait = deferred();
  env.responder = () => wait.promise;
  const checks = env.state.checks;
  const oldCheck = checks['lesson-starlight|2026-09-07'];
  const other = env.state.tasks[1];
  const pending = env.api.stop(env.task.id, env.button);

  assert.deepEqual(env.calls, [{ endpoint: '/lesson-stop', body: {
    app: 'task', auth: env.auth, taskId: 'lesson-starlight',
    studentId: 'student-starlight', staffId: 'teacher-moon', expectedUpdatedAt: 150
  } }]);
  assertActiveAndUnchanged(env);
  assert.equal(env.button.disabled, true);
  assert.equal(env.api.pending(env.task.id), true);
  assert.match(env.confirmations[0], /기존 출결·메모는 보존됩니다/);

  wait.resolve({ task: env.tombstone });
  await pending;
  assert.equal(env.state.tasks[0], env.tombstone, 'the server object supplies the stopped task');
  assert.equal(env.state.tasks[1], other, 'a same-title lesson has a different stable identity');
  assert.equal(env.state.checks, checks);
  assert.equal(env.state.checks['lesson-starlight|2026-09-07'], oldCheck);
  assert.deepEqual(oldCheck, { att: 'P', note: '직접 만든 독해 예문을 읽음', updatedAt: 140 });
  assert.equal(env.context.eForm, null);
  assert.deepEqual(env.effects, ['save', 'closeModal', 'render', 'queueSync']);
  assert.deepEqual(env.toasts, ['수업 중단이 서버에 반영되었습니다. 기존 출결·메모는 보존됩니다']);
  assert.equal(env.button.disabled, false);
  assert.equal(env.button.textContent, '중단');
  assert.equal(env.api.pending(env.task.id), false);
});

test('HTTP 409 and network failure leave the regular lesson active and permit a later retry', async () => {
  for (const error of [Object.assign(new Error('수업 정보가 변경되었습니다'), { status: 409 }), new Error('Failed to fetch')]) {
    const env = harness();
    env.responder = async () => { throw error; };
    await env.api.stop(env.task.id, env.button);
    assertActiveAndUnchanged(env);
    assert.deepEqual(env.toasts, ['수업 중단 실패 — ' + error.message]);
    assert.equal(env.button.disabled, false);
    assert.equal(env.button.textContent, '중단');
    assert.equal(env.api.pending(env.task.id), false);
    env.responder = null;
    await env.api.stop(env.task.id, env.button);
    assert.equal(env.calls.length, 2);
    assert.equal(env.state.tasks[0].deleted, true);
  }
});

test('malformed server results cannot hide a regular lesson', async () => {
  const invalidPatches = [
    { id: 'different-lesson' }, { studentId: 'different-student' }, { staffId: 'different-teacher' },
    { deleted: false }, { deleted: 'true' }, { updatedAt: undefined }, { updatedAt: 'not-a-time' },
    { updatedAt: null }, { updatedAt: '' }, { updatedAt: false }, { updatedAt: 0 }, { updatedAt: -1 },
    { updatedAt: '200' }, { updatedAt: 200.5 }, { updatedAt: Number.MAX_SAFE_INTEGER + 1 }
  ];
  for (const invalid of [undefined, {}, { task: null }, ...invalidPatches.map(patch => ({
    task: { ...lesson(), deleted: true, updatedAt: 200, ...patch }
  }))]) {
    const env = harness();
    env.responder = async () => invalid;
    await env.api.stop(env.task.id, env.button);
    assertActiveAndUnchanged(env);
    assert.equal(env.toasts.length, 1);
    assert.match(env.toasts[0], /수업 중단 실패/);
    assert.equal(env.button.disabled, false);
    assert.equal(env.api.pending(env.task.id), false);
  }
});

test('an own-lesson teacher still needs an administrator and absent admin auth never posts', async () => {
  for (const session of [{}, { isAdmin: false, isStaffLink: true, staffId: 'teacher-moon' }]) {
    const env = harness({ session });
    await env.api.stop(env.task.id, env.button);
    assertActiveAndUnchanged(env);
    assert.deepEqual(env.calls, []);
    assert.deepEqual(env.confirmations, []);
    assert.deepEqual(env.toasts, ['정규수업 중단은 관리자에게 요청해 주세요']);
  }
  const env = harness();
  env.auth = null;
  await env.api.stop(env.task.id, env.button);
  assertActiveAndUnchanged(env);
  assert.deepEqual(env.calls, []);
  assert.deepEqual(env.confirmations, []);
  assert.deepEqual(env.toasts, ['관리자 연결을 먼저 확인해 주세요']);
});

test('missing, stopped, ordinary, and generated makeup tasks cannot use the regular-stop endpoint', async () => {
  for (const task of [{ deleted: true }, { title: '예문 카드 정리' }, { lessonInstanceType: 'makeup' }, { makeupCaseId: 'makeup-star' }]) {
    const env = harness({ task });
    await env.api.stop(env.task.id, env.button);
    assert.deepEqual(env.calls, []);
    assert.deepEqual(env.effects, []);
    assert.deepEqual(env.toasts, ['중단할 정규수업을 다시 확인해 주세요']);
  }
  const env = harness();
  await env.api.stop('missing-lesson', env.button);
  assert.deepEqual(env.calls, []);
  assert.deepEqual(env.effects, []);
});

test('double clicks produce one confirmation and one request while stop is pending', async () => {
  const env = harness();
  const wait = deferred();
  env.responder = () => wait.promise;
  const pending = env.api.stop(env.task.id, env.button);
  await env.api.stop(env.task.id, { disabled: false, textContent: '다른 중단 버튼', isConnected: true });
  assert.equal(env.calls.length, 1);
  assert.equal(env.confirmations.length, 1);
  assertActiveAndUnchanged(env);
  wait.resolve({ task: env.tombstone });
  await pending;
  assert.equal(env.state.tasks[0].deleted, true);
  assert.equal(env.api.pending(env.task.id), false);
});

test('cancelled confirmation makes no request and keeps the editor and task intact', async () => {
  const env = harness();
  env.confirmResult = false;
  await env.api.stop(env.task.id, env.button);
  assertActiveAndUnchanged(env);
  assert.deepEqual(env.calls, []);
  assert.deepEqual(env.toasts, []);
  assert.equal(env.api.pending(env.task.id), false);
  assert.equal(env.button.disabled, false);
});

test('auth, administrator role, or data generation changes while waiting prevent stale response application', async () => {
  for (const change of [
    env => { env.auth = { mode: 'admin', token: 'new-synthetic-token' }; },
    env => { env.auth = null; },
    env => { env.session.isAdmin = false; env.session.isStaffLink = true; env.session.staffId = 'teacher-sun'; },
    env => { env.state.settings.dataGeneration = 4; }
  ]) {
    const env = harness();
    const wait = deferred();
    env.responder = () => wait.promise;
    const pending = env.api.stop(env.task.id, env.button);
    change(env);
    wait.resolve({ task: env.tombstone });
    await pending;
    assertActiveAndUnchanged(env);
    assert.deepEqual(env.toasts, []);
    assert.equal(env.api.pending(env.task.id), false);
    assert.equal(env.button.disabled, false);
  }
});

test('both delete controls route regular lessons to the server helper before generic local deletion', () => {
  const handlers = block("case 'edelete': {", "case 'erepeat':") + '\n' +
    block("case 'deltask': {", '/* AI 가져오기 */');
  for (const action of ['edelete', 'deltask']) {
    const env = harness();
    const routed = [];
    env.context.stopRegularLessonTask = (id, button) => routed.push({ id, button });
    vm.runInContext(`globalThis.dispatchStop = function(action, el) {
      const id = el.dataset.id;
      const task = () => state.tasks.find(row => row.id === id);
      switch (action) { ${handlers} }
    };`, env.context);
    env.context.dispatchStop(action, { dataset: { id: env.task.id } });
    assert.equal(routed.length, 1);
    assert.equal(routed[0].id, env.task.id);
    assertActiveAndUnchanged(env);
    assert.deepEqual(env.confirmations, [], 'confirmation belongs to the server helper');
    assert.deepEqual(env.calls, []);
  }
});
