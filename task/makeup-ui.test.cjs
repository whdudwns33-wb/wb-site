const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function block(from, to) {
  const start = html.indexOf(from);
  const end = html.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `${from} 블록을 찾을 수 없습니다`);
  return html.slice(start, end);
}

test('admin and personal staff keep a dedicated makeup route', () => {
  const render = block('function render() {', 'function renderTabs()');
  const tabs = block('function renderTabs()', '/* ── 링크로 들어온 지시서 확인');

  assert.match(render, /allowed\.push\('makeup'\)/);
  assert.match(render, /makeup: viewMakeups/);
  assert.match(render, /route === 'makeup'[\s\S]{0,100}restoreMakeupFocus/);
  assert.equal((tabs.match(/\['makeup', '보강', makeupAttentionCount\(\)\]/g) || []).length, 2);
});

test('today absence still creates one stable case after sync and today loads makeup state', () => {
  const todayView = block('function viewToday()', 'function taskRow(');
  const panel = block('function taskPanel(t, date, c, editable)', '/** 수업 출결 표시용 */');
  const request = block('function makeupRequestHtml(task, date, check)', 'function makeupIsDelayed');
  const create = block('async function createMakeupFromAbsence', 'function makeupCanComplete');
  const click = block("case 'latt':", "case 'fbtext':");

  assert.match(todayView, /!makeupLoaded && !makeupLoading/);
  assert.match(todayView, /loadMakeups\(false\)/);
  assert.match(panel, /isScheduledMakeupTask\(t\) \? '' : makeupRequestHtml\(t, date, c\)/);
  assert.match(request, /check\.att !== 'A'/);
  assert.match(request, /makeupCaseForSource\(task\.id, date\)/);
  assert.ok(create.indexOf('await settleSync()') < create.indexOf("sync.post('/makeup'"));
  assert.match(create, /action: 'create_from_absence', sourceTaskId: taskId, sourceDate: date/);
  assert.match(click, /next === 'A' && date === today\(\)/);
  assert.match(click, /automatic: true, expectedUpdatedAt: savedCheck\.updatedAt/);
});

test('generated makeup lessons are never allowed to recursively create another makeup', () => {
  const helpers = block("const isLesson =", '/** 수업 지시서 제목');
  const panel = block('function taskPanel(t, date, c, editable)', '/** 수업 출결 표시용 */');
  const click = block("case 'latt':", "case 'fbtext':");

  assert.match(helpers, /const isScheduledMakeupTask =/);
  for (const marker of ['lessonInstanceType', 'makeupCaseId', 'makeupSourceTaskId']) {
    assert.match(helpers, new RegExp(marker));
  }
  assert.match(helpers, /&& !isScheduledMakeupTask\(t\)/);
  assert.match(panel, /isScheduledMakeupTask\(t\) \? ''/);
  assert.match(click, /next === 'A' && isScheduledMakeupTask\(t\)/);
  assert.match(click, /추가 보강은 자동 생성하지 않습니다/);
});

test('makeup auto-create never posts after sync failure and preserves retry state', async () => {
  const request = block('function makeupRequestHtml(task, date, check)', 'function makeupIsDelayed');
  const create = block('async function createMakeupFromAbsence', 'function makeupCanComplete');

  assert.match(create, /error\.makeupSyncFailed = true/);
  assert.match(create, /status: error\.makeupSyncFailed \? 'sync_failed' : 'create_failed'/);
  assert.match(request, /creating\.status === 'sync_failed'/);
  assert.match(request, /creating\.status === 'create_failed'/);

  let postCalls = 0;
  const createStates = new Map();
  const attendance = { att: 'A', updatedAt: 10 };
  const runCreate = new Function('state', 'getCheck', 'sync', 'isMakeupLessonTask', 'toast', 'makeupCreateStates',
    'makeupCreateKey', 'uid', 'settleSync', 'replaceMakeup', 'renderAfterSync', 'refreshMakeupsAfterConflict',
    `let makeupLiveMessage = '';\n${create}\nreturn createMakeupFromAbsence;`)(
      { tasks: [{ id: 'lesson-1', studentId: 'student-1' }] },
      () => attendance,
      { auth: () => ({ mode: 'person' }), post: async () => { postCalls++; return {}; } },
      () => true, () => {}, createStates, (taskId, date) => taskId + '|' + date, () => 'operation-1',
      async () => { throw new Error('SYNC_FAILED'); }, () => {}, () => {}, async () => {}
    );
  const result = await runCreate('lesson-1', '2026-08-12', null, { automatic: true, expectedUpdatedAt: 10 });
  assert.equal(result, false);
  assert.equal(postCalls, 0);
  assert.equal(createStates.get('lesson-1|2026-08-12').status, 'sync_failed');
});

test('automatic creation cancels if attendance changes while sync runs', () => {
  const create = block('async function createMakeupFromAbsence', 'function makeupCanComplete');
  assert.match(create, /latestCheck\.att !== 'A'/);
  assert.match(create, /Number\(latestCheck\.updatedAt\) !== expectedUpdatedAt/);
  assert.match(create, /currentState\.operationId === operationId/);
  assert.ok(create.indexOf("latestCheck.att !== 'A'") < create.indexOf("sync.post('/makeup'"));
});

test('only an A-to-P correction syncs attendance first and reconciles its linked makeup case', async () => {
  const reconcile = block('async function reconcileMakeupAfterAttendanceCorrection', 'async function loadMakeups');
  const click = block("case 'latt':", "case 'fbtext':");
  const panel = block('function taskPanel(t, date, c, editable)', '/** 수업 출결 표시용 */');
  assert.match(click, /previousAttendance === 'A' && next === 'P' && isMakeupLessonTask\(t\)/);
  assert.match(click, /reconcileMakeupAfterAttendanceCorrection\(id, date, savedCheck\.updatedAt\)/);
  assert.match(panel, /attendanceReconcileBusy/);
  assert.match(panel, /makeupAttendanceReconcileHintHtml\(t\.id, date\)/);
  assert.ok(reconcile.indexOf('await settleSync()') < reconcile.indexOf("sync.post('/makeup'"));

  const states = new Map();
  const check = { att: 'P', updatedAt: 22 };
  const calls = [];
  let replaced = null, lessonTask = null;
  const api = new Function('makeupCreateKey', 'makeupAttendanceReconcileStates', 'uid', 'settleSync', 'getCheck',
    'renderAfterSync', 'sync', 'replaceMakeup', 'applyMakeupLessonTask', 'toast', 'loadMakeups', 'SYNC_APP',
    `let makeupLiveMessage = ''; let makeupLoaded = true;\n${reconcile}\n` +
    'return { run: reconcileMakeupAfterAttendanceCorrection, live: () => makeupLiveMessage };')(
      (taskId, date) => taskId + '|' + date, states, () => 'op-1',
      async () => { calls.push('settle'); }, () => check, () => { calls.push('render'); },
      { auth: () => ({ mode: 'person' }), post: async (_path, payload) => {
        calls.push('post');
        assert.deepEqual(payload, {
          app: 'task', auth: { mode: 'person' }, action: 'reconcile_attendance',
          sourceTaskId: 'lesson-1', sourceDate: '2026-09-03'
        });
        return {
          case: { caseId: 'mu-1', status: 'cancelled', hiddenByAttendanceCorrection: true },
          lessonTask: { id: 'makeup_lesson_mu-1', deleted: true }
        };
      } },
      row => { replaced = row; }, row => { lessonTask = row; }, message => { calls.push(message); }, async () => {}, 'task'
    );

  assert.equal(await api.run('lesson-1', '2026-09-03', 22), true);
  assert.deepEqual(calls.slice(0, 2), ['settle', 'post']);
  assert.equal(replaced.hiddenByAttendanceCorrection, true);
  assert.equal(lessonTask.deleted, true);
  assert.equal(states.has('lesson-1|2026-09-03'), false);
  assert.equal(api.live(), '출석으로 정정 · 보강건 정리됨');
  assert.ok(calls.includes('출석으로 정정 · 보강건 정리됨'));
});

test('attendance reconciliation blocks duplicate calls and keeps a precise 409 reason after attendance is saved', async () => {
  const reconcile = block('async function reconcileMakeupAfterAttendanceCorrection', 'async function loadMakeups');
  const makeApi = ({ states, settleSync, post, toast, loadMakeups }) => new Function(
    'makeupCreateKey', 'makeupAttendanceReconcileStates', 'uid', 'settleSync', 'getCheck', 'renderAfterSync',
    'sync', 'replaceMakeup', 'applyMakeupLessonTask', 'toast', 'loadMakeups', 'SYNC_APP',
    `let makeupLiveMessage = ''; let makeupLoaded = true;\n${reconcile}\nreturn reconcileMakeupAfterAttendanceCorrection;`)(
      (taskId, date) => taskId + '|' + date, states, () => 'same-operation', settleSync,
      () => ({ att: 'P', updatedAt: 31 }), () => {},
      { auth: () => ({ mode: 'person' }), post }, () => {}, () => {}, toast, loadMakeups, 'task'
    );

  let release;
  let postCount = 0;
  const racingStates = new Map();
  const racing = makeApi({
    states: racingStates,
    settleSync: () => new Promise(resolve => { release = resolve; }),
    post: async () => { postCount++; return { case: null }; },
    toast: () => {}, loadMakeups: async () => {}
  });
  const first = racing('lesson-1', '2026-09-03', 31);
  assert.equal(await racing('lesson-1', '2026-09-03', 31), false, 'pending source key cannot submit twice');
  release();
  assert.equal(await first, true);
  assert.equal(postCount, 1);

  const blockedStates = new Map();
  const messages = [];
  const conflict = new Error('이미 출결·메모가 있는 보강수업입니다');
  conflict.status = 409;
  conflict.code = 'MAKEUP_LESSON_HAS_RECORDS';
  let reloadCount = 0;
  const blocked = makeApi({
    states: blockedStates, settleSync: async () => {}, post: async () => { throw conflict; },
    toast: message => messages.push(message), loadMakeups: async force => { if (force) reloadCount++; }
  });
  assert.equal(await blocked('lesson-2', '2026-09-03', 31), false);
  const state = blockedStates.get('lesson-2|2026-09-03');
  assert.equal(state.status, 'blocked');
  assert.match(state.message, /출석은 정정됐지만 보강 기록은 자동 삭제할 수 없음/);
  assert.match(state.message, /이미 출결·메모가 있는 보강수업입니다/);
  assert.match(state.message, /보강 탭에서 확인해 주세요/);
  assert.equal(messages.at(-1), state.message);
  assert.equal(reloadCount, 1);

  const view = block('function viewMakeups()', 'async function refreshMakeupsAfterConflict');
  assert.match(view, /filter\(row => row\.hiddenByAttendanceCorrection !== true\)/,
    'attendance-corrected cancellations are hidden from active and archive lists');
  assert.doesNotMatch(view, /row\.reason[^\n]*already_resolved/,
    'manual no-makeup rows must not be inferred from a shared reason value');
});

test('KPI counts only the simplified needed, scheduled, today, delayed, and completed states', () => {
  const source = block('function makeupIsDelayed(row, date)', 'function makeupAttentionCount()');
  const api = new Function(`${source}\nreturn { makeupIsDelayed, makeupKpiCounts };`)();
  const rows = [
    { status: 'review_pending', sourceDate: '2026-08-10' },
    { status: 'reviewed', sourceDate: '2026-08-11' },
    { status: 'awaiting_parent', sourceDate: '2026-08-01', proposedDate: '2026-08-10' },
    { status: 'confirmed', confirmedDate: '2026-08-11' },
    { status: 'confirmed', confirmedDate: '2026-08-09' },
    { status: 'completed', completedDate: '2026-08-08' }
  ];

  assert.deepEqual(api.makeupKpiCounts(rows, '2026-08-11'), {
    needed: 3, scheduled: 2, today: 1, overdue: 1, completed: 1
  });
  const output = block('function makeupKpis(rows)', 'function viewMakeups()');
  for (const label of ['일정 미생성', '보강 예정', '오늘 / 지연', '보강 완료']) {
    assert.match(output, new RegExp(label.replace('/', '\\/')));
  }
  assert.doesNotMatch(output, /보호자 응답 대기|알림 필요/);
});

test('active admin card has three actions and staff can only complete their own case', () => {
  const actions = block('function makeupActions(row)', 'function makeupCard(row)');

  for (const [act, label] of [['muschedule', '보강생성'], ['mucompleteopen', '보강완료'], ['munone', '보강없음']]) {
    assert.match(actions, new RegExp(`data-act="${act}"[\\s\\S]*?>${label}<`));
  }
  assert.match(actions, /row\.status === 'confirmed'[\s\S]*?disabled>생성완료/);
  assert.match(actions, /if \(session\.isAdmin\)/);
  assert.match(actions, /row\.status === 'confirmed' \? row\.confirmedStaffId : \(row\.currentTeacherId \|\| row\.sourceTeacherId\)/);
  const staffBranch = actions.slice(actions.indexOf('const own'));
  assert.match(staffBranch, /data-act="mucompleteopen"/);
  assert.doesNotMatch(staffBranch, /data-act="muschedule"|data-act="munone"/);
  for (const oldAction of ['mureviewrequired', 'mupropose', 'muconfirm', 'mucancel']) {
    assert.doesNotMatch(actions, new RegExp(oldAction));
  }
});

test('schedule, completion, and no-makeup modals use the three-action API contract', () => {
  const source = block('function makeupCanComplete(row)', '/* ── 주간 플래너');

  assert.match(source, /function makeupDateTimeModal\(row, mode\)/);
  assert.match(source, /id="muDate" type="date"/);
  assert.match(source, /id="muStart" type="time"/);
  assert.match(source, /id="muEnd" type="time"/);
  assert.match(source, /원 수업 담당 선생님이 자동 배정됩니다/);
  assert.doesNotMatch(source, /id="muStaff"|담당 선생님<\/label><select/);
  assert.match(source, /scheduled \? row\.confirmedDate/);
  assert.match(source, /실제 보강 일시가 다르면 수정해 주세요/);
  assert.match(source, /action: 'schedule'[\s\S]*?\.\.\.slot/);
  assert.match(source, /action: 'complete'[\s\S]*?\.\.\.slot/);
  assert.match(source, /action: 'no_makeup'[\s\S]*?reason: reason/);
  assert.match(source, /slot\.date < today\(\)/);
  assert.match(source, /endAt > Date\.now\(\)/);
});

test('completed and no-makeup cards leave active grid and remain in a collapsed archive', () => {
  const view = block('function viewMakeups()', 'async function refreshMakeupsAfterConflict');
  const schedule = block('function makeupScheduleHtml(row)', 'function makeupActions(row)');

  assert.match(view, /const active = rows\.filter\(row => !\['completed', 'cancelled'\]\.includes\(row\.status\)\)/);
  assert.match(view, /const archived = rows\.filter\(row => \['completed', 'cancelled'\]\.includes\(row\.status\)\)/);
  assert.match(view, /<details class="card makeup-archive">/);
  assert.match(view, /지난 보강 기록/);
  assert.doesNotMatch(view, /<details class="card makeup-archive" open/);
  assert.match(schedule, /row\.completedDate/);
  assert.match(schedule, /row\.completedStartTime/);
  assert.match(schedule, /row\.completedEndTime/);
  assert.match(schedule, /실제 보강/);
});

test('source absence shows makeup completion and list loads the full server limit', () => {
  const helper = block('function makeupCaseForSource', 'function makeupCreateKey');
  const row = block('function taskRow(', 'const LESSON_MEMO_FIELDS');
  const load = block('async function loadMakeups(force)', 'function makeupReasonSelect');

  assert.match(helper, /check\.att !== 'A'/);
  assert.match(helper, /linked\.status === 'completed'/);
  assert.match(helper, /보강완료/);
  assert.match(row, /makeupCompletionTagHtml\(t, date, c\)/);
  assert.match(load, /action: 'list', limit: 500/);
  assert.match(load, /\['makeup', 'today', 'week', 'schedule'\]\.includes\(route\)/);
});

test('schedule response applies the authoritative generated lesson task immediately', () => {
  const mutation = block('async function mutateMakeup', 'async function createMakeupFromAbsence');

  assert.match(mutation, /result\.lessonTask && result\.lessonTask\.id/);
  assert.match(mutation, /state\.tasks\.findIndex/);
  assert.match(mutation, /state\.tasks\.push\(result\.lessonTask\)/);
  assert.match(mutation, /state\.tasks\[taskIndex\] = result\.lessonTask/);
  assert.match(mutation, /payload\.action === 'schedule'/);
  assert.match(mutation, /await sync\.run\(\)/);
});

test('makeup lessons have text and color distinction on teacher cards and every manager schedule view', () => {
  const row = block('function taskRow(', 'const LESSON_MEMO_FIELDS');
  const timeline = block('function scheduleTimelineHtml', 'function scheduleTimelineModal');
  const modal = block('function scheduleTimelineModal', 'function scheduleSimpleRow');
  const simple = block('function scheduleSimpleRow', 'function scheduleRowsHtml');
  const session = block('function scheduleSessionRow', 'function scheduleWeekCardsHtml');
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));

  assert.match(row, /is-makeup-lesson/);
  assert.match(row, /makeup-lesson">보강수업/);
  assert.match(timeline, /schedule-legend-dot makeup/);
  assert.match(timeline, /isScheduledMakeupTask\(entry\.task\)/);
  assert.match(timeline, /'is-makeup'/);
  assert.match(timeline, /보강 ·/);
  assert.match(modal, /makeup-lesson">보강수업/);
  assert.match(simple, /makeup \? ' is-makeup'/);
  assert.match(session, /tasks\.some\(isScheduledMakeupTask\)/);
  assert.match(session, /makeup-lesson">보강/);
  assert.match(css, /\.task\.is-makeup-lesson/);
  assert.match(css, /\.schedule-timeline-block\.is-makeup/);
  assert.match(css, /\.schedule-list-row\.is-makeup/);
});

test('conflicts reload safely and completion refreshes session-pack impact', () => {
  const mutations = block('async function refreshMakeupsAfterConflict', 'async function createMakeupFromAbsence');
  assert.match(mutations, /Number\(error && error\.status\) === 409/);
  assert.match(mutations, /loadMakeups\(true\)/);
  assert.match(mutations, /result\.sessionPackImpact/);
  assert.match(mutations, /pack_identity_mismatch/);
  assert.match(mutations, /await loadSessionPacks\(true\)/);
  assert.match(mutations, /Number\(impact\.delta\) === 1/);
});

test('mobile layouts keep one column and 44px makeup actions', () => {
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.makeup-grid \{ grid-template-columns: 1fr; \}/);
  assert.match(css, /\.makeup-actions \.btn, \.makeup-request \{ min-height: 44px; \}/);
  assert.match(css, /html\.person-mobile \.makeup-grid \{ grid-template-columns: 1fr; \}/);
});

test('click routing covers only the simplified makeup transitions', () => {
  const click = block("case 'murefresh':", '/* 날짜 */');
  for (const action of ['murefresh', 'mucreate', 'muschedule', 'muschedulesubmit', 'mucompleteopen',
    'mucompletesubmit', 'munone', 'munonesubmit']) {
    assert.match(click, new RegExp(`case '${action}'`));
  }
  for (const oldAction of ['mureviewrequired', 'mureviewnot', 'mupropose', 'muconfirm', 'mucancel', 'mucomplete']) {
    assert.doesNotMatch(click, new RegExp(`case '${oldAction}'`));
  }
});

test('makeup UI stores no guardian contact or sensitive free-text fields', () => {
  const source = block('/* ── 보강 —', '/* ── 주간 플래너');
  assert.doesNotMatch(source, /guardianPhone|parentPhone|phone|contact|상담메모|<textarea|prompt\s*\(/i);
  assert.match(source, /정해진 운영 사유만 기록합니다/);
});
