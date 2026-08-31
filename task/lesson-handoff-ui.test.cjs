const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { webcrypto } = require('node:crypto');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
function block(from, to) {
  const start = html.indexOf(from), end = html.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `${from}..${to}`);
  return html.slice(start, end);
}
function fn(name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(html);
  assert.ok(match, name);
  const tail = html.slice(match.index + match[0].length);
  const next = /\n(?:async\s+)?function\s+[A-Za-z0-9_$]+\s*\(/.exec(tail);
  return html.slice(match.index, next ? match.index + match[0].length + next.index : html.length);
}
const handoffId = 'lh_' + 'a'.repeat(32);
const escapeHtml = value => String(value == null ? '' : value).replace(/[&<>"']/g,
  value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]);
function lesson(overrides = {}) {
  return Object.assign({ id: 'lesson-a', studentId: 'student-a', staffId: 'teacher-a', taskKind: 'lesson_instruction',
    studentName: '홍테스트', subject: '수학', title: '[수업] 홍테스트 — 수학', lessonHours: '9T',
    scheduleSlots: [{ slotId: 'slot-sat', days: [6], startTime: '13:00', endTime: '14:20', lessonHours: '2T' }],
    mockRecordDate: '2026-08-30' }, overrides);
}
function handoff(overrides = {}) {
  return Object.assign({ handoffId, lessonTaskId: 'lesson-a', studentId: 'student-a', sourceDate: '2026-08-29', recordDate: '2026-08-30',
    slotId: 'slot-sat', sourceStaffId: 'teacher-a', recipientStaffId: 'teacher-b', startTime: '15:00',
    totalHours: '2T', completedHours: '1T', remainingHours: '1T', note: '다음 문제부터 이어 주세요', status: 'pending', revision: 1,
    sourceMemo: { contentProgress: '앞의 1T 분수 학습', homework: '2쪽', comment: '기존 코멘트', otherNotes: '집중함' },
    memo: {}, student: { id: 'student-a', name: '홍테스트', school: '테스트초', grade: '초5' },
    lesson: { title: '[수업] 홍테스트 — 수학', subject: '수학' }, attendance: { att: 'L' }, visit: {
      visitId: 'wv_exact', lessonTaskId: 'lesson-a', studentId: 'student-a', sourceDate: '2026-08-29', visitDate: '2026-08-30', status: 'active', revision: 4
    } }, overrides);
}
function harness() {
  const nodes = new Map([['#modalHost', { hidden: true }]]);
  const storage = new Map();
  const env = {
    state: { settings: { dataGeneration: 3 }, tasks: [lesson()], checks: {} },
    session: { isStaffLink: true, isAdmin: false, staffId: 'teacher-a' },
    auth: { mode: 'person', id: 'teacher-a', token: 'synthetic-a' },
    clock: { date: '2026-08-30', minute: 16 * 60, label: '16:00' },
    calls: [], toasts: [], modals: [], sourceFields: [], typing: false, done: true,
    responder: null, failSync: false, rendered: 0,
  };
  env.state.checks['lesson-a|2026-08-30'] = { taskId: 'lesson-a', date: '2026-08-30', att: 'L', note: '기존 원 수업 메모', updatedAt: 1 };
  env.sync = {
    auth: () => env.auth,
    async run() { env.calls.push({ type: 'sync.run' }); return true; },
    async post(endpoint, body) {
      env.calls.push({ endpoint, body });
      if (env.responder) return env.responder(endpoint, body);
      return { ok: true, dataGeneration: env.state.settings.dataGeneration, handoffs: [],
        recipients: [{ staffId: 'teacher-a', name: '원담당' }, { staffId: 'teacher-b', name: '수신선생님' }, { staffId: 'teacher-c', name: '다른선생님' }] };
    }
  };
  const setup = `
    const { state, session, sync } = env;
    const document = { querySelectorAll: () => env.sourceFields };
    const crypto = env.crypto;
    const $ = selector => env.nodes.get(selector) || null;
    const SYNC_APP = 'task';
    const esc = env.esc;
    const label = String;
    const seoulNowParts = () => env.clock;
    const dowOf = value => new Date(value + 'T00:00:00Z').getUTCDay();
    const staffById = id => ({ 'teacher-a': { name: '원담당' }, 'teacher-b': { name: '수신선생님' }, 'teacher-c': { name: '다른선생님' } })[id];
    const isSessionLessonTask = task => !!task && task.taskKind === 'lesson_instruction';
    const isLesson = isSessionLessonTask;
    const studentOf = task => task.studentName;
    const lessonRecordContext = (task, sourceDate) => ({ sourceDate, recordDate: task.mockRecordDate || sourceDate, inputEnabled: !task.inputDisabled });
    const getCheck = (id, date) => state.checks[id + '|' + date];
    const setCheck = (id, date, patch) => {
      env.calls.push({ type: 'setCheck', id, date, patch });
      state.checks[id + '|' + date] = Object.assign({}, getCheck(id, date), patch);
    };
    const settleSync = async () => { env.calls.push({ type: 'settleSync' }); if (env.failSync) throw new Error('SYNC_FAILED'); };
    const renderAfterSync = () => env.rendered++;
    const toast = text => env.toasts.push(text);
    const modal = (title, body, foot) => { env.nodes.get('#modalHost').hidden = false; env.modals.push({ title, body, foot }); };
    const closeModal = () => { env.nodes.get('#modalHost').hidden = true; };
    const playAdminDirectiveSound = () => env.calls.push({ type: 'sound' });
    const isTaskEditorActive = () => env.typing;
    const sessionStorage = { getItem: key => env.storage.get(key), setItem: (key, value) => env.storage.set(key, value) };
    const confirm = text => { env.calls.push({ type: 'confirm', text }); return true; };
    const refreshVisibleWeekendVisitScopes = () => env.calls.push({ type: 'refreshVisits' });
    const go = value => { route = value; };
    const ATT_LABEL = { P: ['출석', 'ok'], L: ['지각', 'high'], A: ['결석', 'blk'], E: ['조퇴', 'doing'] };
    const isDone = () => env.done;
    const taskProgress = () => ({ done: 5, total: 5 });
    const tasksFor = () => state.tasks;
    let route = 'today', cursor = '2026-08-30', cursorPinned = false;
  `;
  env.crypto = webcrypto; env.nodes = nodes; env.storage = storage; env.esc = escapeHtml;
  const source = block('const LESSON_HANDOFF_TTL_MS', 'function go(') + '\n' +
    block('const LESSON_MEMO_FIELDS', 'function taskMemoEditorHtml(') + '\n' +
    block('function resetLessonHandoffs(', '/* 오늘 수업 화면 */') + '\n' + fn('statusOf') + fn('progress');
  env.api = new Function('env', setup + source + `
    return { loadLessonHandoffs, lessonHandoffContext, resetLessonHandoffs, lessonHandoffRows, lessonHandoffForTask,
      lessonHandoffOutstanding, lessonHandoffById, lessonHandoffCardHtml, lessonHandoffTeacherHtml, lessonHandoffManagerHtml,
      lessonHandoffSourcePanelHtml, lessonHandoffSlots, lessonHandoffHoursUnits, lessonHandoffHoursText, newLessonHandoffId,
      lessonHandoffCanAct, lessonHandoffCanCheckOut, openLessonHandoff, validateLessonHandoffDraft, previewLessonHandoff,
      createLessonHandoff, rememberLessonHandoffMutation, submitLessonHandoffAction, openLessonHandoffCancel, checkOutLessonHandoff,
      showPendingLessonHandoffPopup, captureLessonHandoffInput, lessonHandoffSourceMemoValues, statusOf, progress,
      get scopes() { return lessonHandoffScopes; }, get loads() { return lessonHandoffLoads; }, get memoDrafts() { return lessonHandoffMemoDrafts; },
      get sourceDrafts() { return lessonHandoffSourceDrafts; }, get draft() { return lessonHandoffDraft; },
      set draft(value) { lessonHandoffDraft = value; }, get errors() { return lessonHandoffErrors; }
    };
  `)(env);
  env.recipients = [{ staffId: 'teacher-a', name: '원담당' }, { staffId: 'teacher-b', name: '수신선생님' }];
  env.respondList = rows => ({ ok: true, dataGeneration: env.state.settings.dataGeneration, handoffs: rows, recipients: env.recipients });
  env.seed = rows => {
    env.api.lessonHandoffContext();
    for (const date of [...new Set(rows.map(row => row.recordDate))]) env.api.scopes.set(date, {
      rows: rows.filter(row => row.recordDate === date), recipients: env.recipients, fetchedAt: Date.now(), error: ''
    });
  };
  env.asRecipient = () => { env.auth = { mode: 'person', id: 'teacher-b', token: 'synthetic-b' }; env.session.staffId = 'teacher-b'; };
  return env;
}

function input(dataset, value, selector) {
  const element = { dataset, value, closest: value => value === selector ? element : null };
  return element;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('handoffs use their dedicated API and do not synthesize recipient task, check, or session-pack records', () => {
  const helpers = block('function resetLessonHandoffs(', '/* 오늘 수업 화면 */');
  assert.doesNotMatch(helpers, /state\.tasks\.(?:push|splice)|\.staffId\s*=(?!=)|session-pack|action:\s*'check_in'/);
  for (const name of ['submitLessonHandoffAction', 'checkOutLessonHandoff']) assert.doesNotMatch(fn(name), /setCheck\(|queueSync\(|state\.checks/);
  assert.match(fn('createLessonHandoff'), /await settleSync\(\);[\s\S]*sync\.post\('\/lesson-handoff'/);
  assert.match(fn('createLessonHandoff'), /note: lessonMemoText\(draft\.sourceMemo\) \|\| String\(check\.note \|\| ''\)/);
  assert.match(fn('loadLessonHandoffs'), /dataGeneration: context\.generation/);
});

test('T totals use original independently entered slot hours, with exact half-T arithmetic and source-day selection', () => {
  const { api } = harness();
  assert.equal(api.lessonHandoffHoursUnits('0.5T'), 1);
  assert.equal(api.lessonHandoffHoursUnits('.5'), 1);
  assert.equal(api.lessonHandoffHoursUnits('1T'), 2);
  assert.equal(api.lessonHandoffHoursUnits('1.5'), 3);
  assert.equal(api.lessonHandoffHoursText(5), '2.5T');
  for (const value of ['', '0', '0.25T', '-1T', 'NaN', '1e2', '7T', '90분']) assert.equal(api.lessonHandoffHoursUnits(value), 0, value);
  const task = lesson({ scheduleSlots: [
    { slotId: 'sat', days: [6], startTime: '13:00', endTime: '13:20', lessonHours: '2T' },
    { slotId: 'sun', days: [0], startTime: '13:00', endTime: '17:00', lessonHours: '1T' },
    { slotId: 'future', days: [6], validFrom: '2026-09-01', lessonHours: '3T' }
  ] });
  const slots = api.lessonHandoffSlots(task, '2026-08-29');
  assert.equal(slots.length, 1);
  assert.equal(slots[0].slotId, 'sat');
  assert.equal(api.lessonHandoffHoursUnits(slots[0].lessonHours), 4, '20 minutes still uses the entered 2T, not elapsed-time conversion');
  assert.match(api.newLessonHandoffId(), /^lh_[0-9a-f]{32}$/);
});

test('cross-day original panel loads actual recordDate and keeps sourceDate as stable linkage', () => {
  const env = harness(), row = handoff();
  env.seed([row]);
  const markup = env.api.lessonHandoffSourcePanelHtml(env.state.tasks[0], row.recordDate, { att: 'L' }, true,
    { sourceDate: row.sourceDate, recordDate: row.recordDate, inputEnabled: true });
  assert.match(markup, /진행 1T \+ 남은 1T · 인계 대기/);
  assert.match(markup, /원담당의 인계 당시 메모/);
  assert.match(markup, /수신선생님의 인계 수업 메모/);
  assert.equal(env.api.lessonHandoffForTask(env.state.tasks[0], row.sourceDate, row.recordDate).length, 1);
  assert.equal(env.api.lessonHandoffForTask(env.state.tasks[0], row.recordDate, row.recordDate).length, 0);
  assert.ok(!env.api.scopes.has(row.sourceDate));
});

test('source create button requires original P/L and is restricted to current own/admin record', () => {
  const env = harness();
  env.api.lessonHandoffContext();
  env.api.scopes.set('2026-08-30', { rows: [], recipients: env.recipients, fetchedAt: Date.now(), error: '' });
  const context = { sourceDate: '2026-08-29', recordDate: '2026-08-30', inputEnabled: true };
  const panel = att => env.api.lessonHandoffSourcePanelHtml(env.state.tasks[0], '2026-08-30', { att }, true, context);
  assert.match(panel('L'), /data-act="lessonHandoffOpen"[^>]*data-source-date="2026-08-29"[^>]*>남은 수업 인계/);
  assert.match(panel('A'), /data-act="lessonHandoffOpen"[^>]* disabled/);
  env.clock.minute = 23 * 60 + 50;
  assert.doesNotMatch(panel('L'), /data-act="lessonHandoffOpen"/);
  env.clock.minute = 16 * 60;
  env.session.staffId = 'teacher-c';
  assert.doesNotMatch(panel('P'), /data-act="lessonHandoffOpen"/);
});

test('pending and accepted handoff keep source status in progress without altering its canonical five-stage completion', () => {
  const env = harness();
  for (const status of ['pending', 'accepted']) {
    env.seed([handoff({ status })]);
    assert.equal(env.api.statusOf(env.state.tasks[0], '2026-08-30'), 'doing');
    assert.equal(env.api.progress('teacher-a', '2026-08-30').done, 0);
    assert.equal(env.done, true);
  }
  for (const status of ['completed', 'cancelled']) {
    env.seed([handoff({ status })]);
    assert.equal(env.api.statusOf(env.state.tasks[0], '2026-08-30'), 'done');
  }
  assert.equal(env.api.lessonHandoffOutstanding(lesson({ id: 'different-task' }), '2026-08-30'), false);
});

test('recipient card only renders the minimal student identity, escaped notes, and read-only canonical attendance', () => {
  const env = harness(); env.asRecipient();
  const row = handoff({ student: { name: '<script>학생</script>', school: '학교', grade: '초5', phoneMother: '010-PRIVATE' },
    note: '<img src=x onerror=alert(1)>', sourceMemo: { contentProgress: '<b>원 메모</b>' } });
  env.seed([row]);
  const markup = env.api.lessonHandoffCardHtml(row, 'recipient');
  assert.match(markup, /인계받은 수업 · 1T/);
  assert.match(markup, /학교 · 초5/);
  assert.match(markup, /&lt;script&gt;/);
  assert.match(markup, /&lt;img/);
  assert.match(markup, /원 수업 출결: <b>지각<\/b> \(읽기 전용\)/);
  assert.doesNotMatch(markup, /010-PRIVATE|<script>|data-act="latt"|data-act="step"|check_in/);
});

test('creating a handoff saves typed original memo, settles sync, then submits stable date-only sidecar linkage', async () => {
  const env = harness();
  env.sourceFields = [input({ id: 'lesson-a', date: '2026-08-30', lessonMemoField: 'homework' }, '2쪽 과제', '[data-lesson-memo-field]')];
  await env.api.openLessonHandoff('lesson-a', '2026-08-29');
  assert.ok(env.api.draft);
  assert.match(env.modals.at(-1).body, /인계 시작 시간/);
  Object.assign(env.api.draft, { recipientStaffId: 'teacher-b', completedHours: '1', remainingHours: '1', startTime: '15:00', note: '나머지 1T 요청', confirmed: true });
  const sentId = env.api.draft.handoffId;
  env.responder = (endpoint, body) => body.action === 'create'
    ? { ok: true, dataGeneration: 3, handoff: handoff({ handoffId: body.handoffId }) }
    : env.respondList([handoff({ handoffId: sentId })]);
  await env.api.createLessonHandoff();
  const setAt = env.calls.findIndex(call => call.type === 'setCheck');
  const syncAt = env.calls.findIndex(call => call.type === 'settleSync');
  const createAt = env.calls.findIndex(call => call.body && call.body.action === 'create');
  assert.ok(setAt >= 0 && setAt < syncAt && syncAt < createAt);
  assert.equal(env.calls[setAt].patch.lessonMemo.contentProgress, '기존 원 수업 메모');
  assert.equal(env.calls[setAt].patch.lessonMemo.homework, '2쪽 과제');
  const body = env.calls[createAt].body;
  assert.equal(body.sourceDate, '2026-08-29');
  assert.equal(body.recordDate, '2026-08-30');
  assert.equal(body.lessonTaskId, 'lesson-a');
  assert.equal(body.slotId, 'slot-sat');
  assert.equal(body.completedHours, '1T');
  assert.equal(body.remainingHours, '1T');
  assert.equal(body.dataGeneration, 3);
  assert.ok(!Object.hasOwn(body, 'totalHours'));
  assert.equal(env.state.tasks[0].staffId, 'teacher-a');
  assert.equal(env.state.tasks.length, 1);
  assert.equal(env.api.draft, null);
});

test('failed source sync leaves draft and original memo intact and never creates a handoff', async () => {
  const env = harness();
  await env.api.openLessonHandoff('lesson-a', '2026-08-29');
  Object.assign(env.api.draft, { recipientStaffId: 'teacher-b', completedHours: '1', remainingHours: '1', confirmed: true });
  env.failSync = true;
  await env.api.createLessonHandoff();
  assert.ok(env.api.draft);
  assert.equal(env.state.checks['lesson-a|2026-08-30'].note, '기존 원 수업 메모');
  assert.ok(!env.calls.some(call => call.body && call.body.action === 'create'));
  assert.ok(!env.calls.some(call => call.type === 'setCheck'), 'an unchanged source memo produces no generic write');
});

test('creation validates half-T totals and ambiguous slot ids before persisting source memo', async () => {
  const env = harness();
  await env.api.openLessonHandoff('lesson-a', '2026-08-29');
  Object.assign(env.api.draft, { recipientStaffId: 'teacher-b', completedHours: '1.5', remainingHours: '1', confirmed: true });
  assert.throws(() => env.api.validateLessonHandoffDraft(), /합을 맞춰/);
  env.api.draft.completedHours = '1';
  env.state.tasks[0].scheduleSlots.push({ days: [6], startTime: '16:00', endTime: '16:40', lessonHours: '2T' });
  env.api.draft.slotIndex = '1';
  assert.throws(() => env.api.validateLessonHandoffDraft(), /시간대/);
  env.api.draft.slotIndex = '0';
  assert.equal(env.api.validateLessonHandoffDraft().slot.slotId, 'slot-sat');
  env.api.draft.startTime = '23:50';
  assert.throws(() => env.api.validateLessonHandoffDraft(), /23:50/);
  assert.ok(!env.calls.some(call => call.type === 'setCheck'));
});

test('completed handoff notes stay editable only for recipient/admin in the current-day window', () => {
  const env = harness(); env.asRecipient();
  const row = handoff({ status: 'completed', revision: 4 }); env.seed([row]);
  assert.equal(env.api.lessonHandoffCanAct(row, 'save'), true);
  assert.equal(env.api.lessonHandoffCanAct(row, 'complete'), false);
  assert.match(env.api.lessonHandoffCardHtml(row, 'recipient'), /data-lesson-handoff-memo="contentProgress"/);
  assert.equal(env.api.lessonHandoffCanAct(Object.assign({}, row, { editable: { save: false } }), 'save'), false);
  env.clock.date = '2026-08-31';
  assert.equal(env.api.lessonHandoffCanAct(row, 'save'), false);
  assert.doesNotMatch(env.api.lessonHandoffCardHtml(row, 'recipient'), /data-lesson-handoff-memo=/);
});

test('admin recovery cancellation honors server permission for accepted/completed historic rows while teacher limits remain', async () => {
  const env = harness();
  env.session.isAdmin = true;
  const row = handoff({ status: 'completed', revision: 7, sourceDate: '2026-08-22', recordDate: '2026-08-23', editable: { cancel: true } });
  env.seed([row]);
  assert.equal(env.api.lessonHandoffCanAct(row, 'cancel'), true);
  assert.equal(env.api.lessonHandoffCanAct(Object.assign({}, row, { status: 'accepted' }), 'cancel'), true);
  assert.equal(env.api.lessonHandoffCanAct(Object.assign({}, row, { editable: { cancel: false } }), 'cancel'), false);
  assert.equal(env.api.lessonHandoffCanAct(Object.assign({}, row, { status: 'cancelled' }), 'cancel'), false);
  assert.equal(env.api.lessonHandoffCanAct(row, 'save'), false, 'admin recovery does not reopen historic memo editing');
  const markup = env.api.lessonHandoffCardHtml(row, 'manager');
  assert.match(markup, /data-act="lessonHandoffCancel"/);
  assert.match(markup, /관리자 인계 취소는 사유와 함께 이력에 남습니다/);
  env.api.openLessonHandoffCancel(handoffId);
  env.api.captureLessonHandoffInput(input({}, '수업 시간대 변경에 따른 관리자 정정', '[data-lesson-handoff-cancel-reason]'));
  env.responder = (_, body) => body.action === 'cancel'
    ? { ok: true, dataGeneration: 3, handoff: Object.assign({}, row, { status: 'cancelled', revision: 8, cancelReason: body.reason }) }
    : env.respondList([Object.assign({}, row, { status: 'cancelled', revision: 8 })]);
  await env.api.submitLessonHandoffAction('cancel', handoffId, { dataset: { rev: '7' } }, false);
  const sent = env.calls.find(call => call.body && call.body.action === 'cancel');
  assert.equal(sent.body.revision, 7);
  assert.equal(sent.body.reason, '수업 시간대 변경에 따른 관리자 정정');
  assert.equal(sent.body.dataGeneration, 3);
  assert.ok(!env.calls.some(call => call.type === 'setCheck'));
  env.session.isAdmin = false;
  const pending = handoff({ editable: { cancel: true } });
  assert.equal(env.api.lessonHandoffCanAct(pending, 'cancel'), true);
  assert.equal(env.api.lessonHandoffCanAct(Object.assign({}, pending, { status: 'accepted' }), 'cancel'), false);
  assert.equal(env.api.lessonHandoffCanAct(Object.assign({}, pending, { recordDate: '2026-08-23' }), 'cancel'), false);
  env.clock.minute = 23 * 60 + 50;
  assert.equal(env.api.lessonHandoffCanAct(pending, 'cancel'), false);
  env.clock.minute = 16 * 60; env.session.staffId = 'teacher-b';
  assert.equal(env.api.lessonHandoffCanAct(pending, 'cancel'), false);
});

test('loader deduplicates same-date refreshes and discards old-account responses and finalizers', async () => {
  const env = harness(), first = deferred(), second = deferred();
  let index = 0;
  env.responder = () => (++index === 1 ? first.promise : second.promise);
  const oldLoad = env.api.loadLessonHandoffs('2026-08-30', true, false);
  const duplicate = env.api.loadLessonHandoffs('2026-08-30', true, false);
  assert.equal(index, 1);
  env.api.sourceDrafts.set('test', { memo: { contentProgress: 'old account' } });
  env.asRecipient();
  const newLoad = env.api.loadLessonHandoffs('2026-08-30', true, false);
  assert.equal(index, 2);
  const currentRequest = env.api.loads.get('2026-08-30');
  first.resolve(env.respondList([handoff({ note: 'stale source snapshot' })]));
  await Promise.all([oldLoad, duplicate]);
  assert.equal(env.api.loads.get('2026-08-30'), currentRequest);
  assert.equal(env.api.sourceDrafts.size, 0);
  second.resolve(env.respondList([handoff({ note: 'recipient snapshot' })]));
  await newLoad;
  assert.equal(env.api.scopes.get('2026-08-30').rows[0].note, 'recipient snapshot');
  assert.equal(env.api.loads.size, 0);
});

test('generation changes clear drafts and cache, and mutations invalidate pending older list responses', async () => {
  const env = harness(); env.seed([handoff()]);
  env.api.memoDrafts.set(handoffId, { dirty: true, memo: { contentProgress: 'old generation' } });
  env.state.settings.dataGeneration = 4;
  env.api.lessonHandoffContext();
  assert.equal(env.api.scopes.size, 0);
  assert.equal(env.api.memoDrafts.size, 0);
  env.seed([handoff()]);
  const stale = deferred(); env.responder = () => stale.promise;
  const loading = env.api.loadLessonHandoffs('2026-08-30', true, false);
  env.api.rememberLessonHandoffMutation(handoff({ status: 'accepted', revision: 2 }), env.api.lessonHandoffContext());
  stale.resolve(env.respondList([handoff({ status: 'pending', revision: 1 })]));
  await loading;
  assert.equal(env.api.scopes.get('2026-08-30').rows[0].revision, 2);
  assert.equal(env.api.scopes.get('2026-08-30').rows[0].status, 'accepted');
});

test('typing survives refreshes, separate memo revisions detect conflicts, and source drafts survive redraw', async () => {
  const env = harness(); env.asRecipient();
  const row = handoff({ status: 'accepted', revision: 2, memo: { contentProgress: 'server value', comment: 'keep hidden comment' } });
  env.seed([row]); env.api.lessonHandoffCardHtml(row, 'recipient');
  const editor = input({ handoff: handoffId, lessonHandoffMemo: 'contentProgress' }, 'typing is preserved', '[data-lesson-handoff-memo]');
  env.api.captureLessonHandoffInput(editor);
  env.responder = () => env.respondList([handoff({ status: 'accepted', revision: 3, memo: { contentProgress: 'remote edit' } })]);
  await env.api.loadLessonHandoffs('2026-08-30', true, false);
  const markup = env.api.lessonHandoffCardHtml(env.api.lessonHandoffById(handoffId), 'recipient');
  assert.match(markup, /typing is preserved/);
  assert.match(markup, /작성 중인 메모는 보존했습니다/);
  assert.match(markup, /data-act="lessonHandoffSave"[^>]* disabled/);
  assert.equal(env.api.memoDrafts.get(handoffId).memo.comment, 'keep hidden comment');
  const original = input({ id: 'lesson-a', date: '2026-08-30', lessonMemoField: 'homework' }, 'source unsaved homework', '[data-lesson-memo-field]');
  env.api.captureLessonHandoffInput(original);
  assert.equal(env.api.lessonHandoffSourceMemoValues('lesson-a', '2026-08-30', {}).homework, 'source unsaved homework');
  assert.ok(!env.calls.some(call => call.type === 'setCheck'));
});

test('recipient save writes only sidecar memo and keeps new input made during an in-flight save', async () => {
  const env = harness(); env.asRecipient();
  const row = handoff({ status: 'accepted', revision: 2, memo: { comment: 'legacy comment' } });
  env.seed([row]); env.api.lessonHandoffCardHtml(row, 'recipient');
  const field = input({ handoff: handoffId, lessonHandoffMemo: 'contentProgress' }, 'first typed value', '[data-lesson-handoff-memo]');
  env.api.captureLessonHandoffInput(field);
  const pending = deferred();
  env.responder = (_, body) => body.action === 'save' ? pending.promise : env.respondList([handoff({ status: 'accepted', revision: 3, memo: { contentProgress: 'first typed value', comment: 'legacy comment' } })]);
  const saving = env.api.submitLessonHandoffAction('save', handoffId, { dataset: { rev: '2' } }, false);
  field.value = 'new value while saving'; env.api.captureLessonHandoffInput(field);
  pending.resolve({ ok: true, dataGeneration: 3, handoff: handoff({ status: 'accepted', revision: 3 }) });
  await saving;
  const saveCall = env.calls.find(call => call.body && call.body.action === 'save');
  assert.equal(saveCall.endpoint, '/lesson-handoff');
  assert.equal(saveCall.body.revision, 2);
  assert.equal(saveCall.body.memo.contentProgress, 'first typed value');
  assert.equal(saveCall.body.memo.comment, 'legacy comment');
  assert.equal(env.api.memoDrafts.get(handoffId).memo.contentProgress, 'new value while saving');
  assert.equal(env.api.memoDrafts.get(handoffId).baseRevision, 3);
  assert.ok(!env.calls.some(call => call.type === 'setCheck' || call.type === 'settleSync'));
});

test('completion cutoff and exact-visit final checkout are separate; teacher switching never creates a visit', async () => {
  const env = harness(); env.asRecipient();
  const row = handoff({ status: 'accepted', revision: 2 }); env.seed([row]);
  env.clock.label = '14:59';
  assert.equal(env.api.lessonHandoffCanAct(row, 'complete'), false);
  assert.equal(env.api.lessonHandoffCanCheckOut(row), false);
  assert.doesNotMatch(env.api.lessonHandoffCardHtml(row, 'recipient'), /data-act="lessonHandoffCheckOut"/);
  env.clock.label = '23:51'; env.clock.minute = 23 * 60 + 51;
  assert.equal(env.api.lessonHandoffCanAct(row, 'save'), false);
  assert.equal(env.api.lessonHandoffCanCheckOut(row), true);
  assert.equal(env.api.lessonHandoffCanCheckOut(handoff({ status: 'pending' })), false);
  assert.equal(env.api.lessonHandoffCanCheckOut(handoff({ status: 'accepted', visit: Object.assign({}, row.visit, { sourceDate: '2026-08-30' }) })), false);
  env.responder = (endpoint) => endpoint === '/weekend-visit' ? { ok: true } : env.respondList([handoff({ status: 'accepted', visit: Object.assign({}, row.visit, { status: 'completed' }) })]);
  await env.api.checkOutLessonHandoff(handoffId, {});
  const call = env.calls.find(call => call.endpoint === '/weekend-visit');
  assert.equal(call.body.action, 'check_out');
  assert.equal(call.body.visitId, 'wv_exact');
  assert.equal(call.body.revision, 4);
  assert.equal(call.body.dataGeneration, 3);
  assert.ok(!env.calls.some(call => call.body && call.body.action === 'check_in'));
});

test('server-bound legacy null sourceDate permits exact-row checkout after start until midnight without date guessing', async () => {
  const env = harness(); env.asRecipient();
  const row = handoff({ status: 'accepted', revision: 2 });
  row.visit = Object.assign({}, row.visit, { sourceDate: null });
  env.responder = endpoint => endpoint === '/weekend-visit' ? { ok: true } : env.respondList([row]);
  await env.api.loadLessonHandoffs(row.recordDate, true, false);
  const bound = env.api.lessonHandoffById(handoffId);
  assert.equal(bound.visit.sourceDate, null);
  assert.equal(env.api.lessonHandoffCanCheckOut(bound), true);
  for (const patch of [{ lessonTaskId: 'other-task' }, { studentId: 'other-student' }, { visitDate: '2026-08-29' },
    { sourceDate: '2026-08-30' }, { sourceDate: '' }, { sourceDate: undefined }, { visitId: '' }, { revision: 0 }]) {
    assert.equal(env.api.lessonHandoffCanCheckOut(Object.assign({}, bound, { visit: Object.assign({}, bound.visit, patch) })), false,
      JSON.stringify(patch));
  }
  env.clock.label = '14:59';
  assert.equal(env.api.lessonHandoffCanCheckOut(bound), false);
  env.clock.label = '15:00';
  assert.equal(env.api.lessonHandoffCanCheckOut(bound), true);
  env.clock.label = '23:59'; env.clock.minute = 23 * 60 + 59;
  assert.equal(env.api.lessonHandoffCanCheckOut(bound), true);
  await env.api.checkOutLessonHandoff(handoffId, {});
  const sent = env.calls.find(call => call.endpoint === '/weekend-visit');
  assert.equal(sent.body.visitId, 'wv_exact');
  assert.equal(sent.body.revision, 4);
  assert.ok(!Object.hasOwn(sent.body, 'sourceDate'), 'the frontend never invents a legacy source date');
  env.clock.date = '2026-08-31'; env.clock.label = '00:00'; env.clock.minute = 0;
  assert.equal(env.api.lessonHandoffCanCheckOut(bound), false);
});

test('only the assigned recipient gets a popup, with existing modal and typing guards and shared audio', () => {
  const env = harness(); env.seed([handoff()]);
  env.api.showPendingLessonHandoffPopup();
  assert.equal(env.modals.length, 0, 'source teacher is not a recipient');
  env.asRecipient(); env.seed([handoff()]);
  env.typing = true; env.api.showPendingLessonHandoffPopup();
  assert.equal(env.modals.length, 0);
  env.typing = false; env.nodes.get('#modalHost').hidden = false; env.api.showPendingLessonHandoffPopup();
  assert.equal(env.modals.length, 0);
  env.nodes.get('#modalHost').hidden = true; env.api.showPendingLessonHandoffPopup();
  assert.equal(env.modals.length, 1);
  assert.match(env.modals[0].body, /data-act="lessonHandoffAccept"/);
  assert.equal(env.calls.filter(call => call.type === 'sound').length, 1);
  env.nodes.get('#modalHost').hidden = true; env.api.showPendingLessonHandoffPopup();
  assert.equal(env.modals.length, 1, 'same pending handoff does not repeatedly interrupt');
  env.session.isAdmin = true; env.session.isStaffLink = false; env.session.staffId = '';
  env.auth = { mode: 'admin', secret: 'synthetic-admin' }; env.seed([handoff()]);
  env.api.showPendingLessonHandoffPopup();
  assert.equal(env.modals.length, 1, 'admin observer receives no new handoff popup');
  assert.ok([...env.storage.keys()].every(key => !/synthetic|token|secret/.test(key)));
});

test('UI hooks poll every 15 seconds, preserve details and drafts, and show manager history with date navigation', () => {
  const polling = block('setInterval(() => {', '/* ── 새 버전 감지 ──');
  assert.match(polling, /refreshVisibleLessonHandoffs\(true, true\)/);
  assert.match(fn('refreshVisibleLessonHandoffs'), /loadLessonHandoffs\(date, !!force, !!allowPopup && date === handoffToday\)/);
  assert.match(polling, /}, 15000\)/);
  assert.match(fn('loadLessonHandoffs'), /renderAfterSync\(\)/);
  assert.match(fn('lessonHandoffCardHtml'), /data-persist-key="lesson-handoff\|/);
  assert.match(fn('viewSchedule'), /lessonHandoffManagerHtml\(cursor\)/);
  assert.match(fn('viewBoard'), /lessonHandoffManagerHtml\(cursor\)/);
  assert.match(fn('viewToday'), /lessonHandoffTeacherHtml\(me\.id, cursor\)/);
  assert.match(fn('viewToday'), /displayTotal = p\.total \+ receivedHandoffs\.length/);
  assert.match(fn('viewToday'), /receivedSummary \|\| '지시된 업무가 없습니다'/);
  assert.match(fn('viewToday'), /if \(!carry\.length && !receivedHandoffs\.length\)/);
  assert.match(fn('taskPanel'), /lessonHandoffSourcePanelHtml\(t, date, c, editable, recordContext\)/);
  assert.match(fn('resetPersonCache'), /resetLessonHandoffs\(\)/);
  assert.match(html, /case 'notesave':[\s\S]{0,1100}lessonHandoffSourceDrafts\.delete/);
  const releaseVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'version.json'), 'utf8')).v;
  assert.equal(html.match(/const APP_VER = '([^']+)'/)[1], releaseVersion);
});
