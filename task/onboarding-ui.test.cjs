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

function onboardingCore() {
  const source = block('const ONBOARDING_STAGES = [', 'function onboardingRows()');
  return new Function(`
    const state = { checks: {} };
    const session = { isAdmin: true };
    const onboardingServerConfirmedAt = new Map();
    const save = () => {};
    const queueSync = () => {};
    const now = () => 123;
    const parseYmd = s => { const [y,m,d] = s.split('-').map(Number); return new Date(y,m-1,d); };
    const ymd = d => [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('-');
    const addDays = (s,n) => { const d = parseYmd(s); d.setDate(d.getDate()+n); return ymd(d); };
    const today = () => '2026-08-11';
    ${source}
    return { ONBOARDING_STAGES, ONBOARDING_ITEMS, onboardingTaskId, onboardingKey,
      onboardingAnyRecord, onboardingProgress, onboardingStatus, applyOnboardingRecord, state };
  `)();
}

test('admin navigation exposes a dedicated onboarding route and staff links cannot open it', () => {
  const render = block('function render() {', 'function renderTabs()');
  const tabs = block('function renderTabs()', '/* ── 링크로 들어온 지시서 확인');
  const view = block('function viewOnboarding()', 'function acaflowSpreadsheetName(file)');

  assert.match(render, /const allowed = \['today', 'week', 'lesson', 'feedback', 'books', 'transport', 'roster'\]/);
  assert.doesNotMatch(render.match(/const allowed = \[[^\]]+\]/)[0], /onboarding/);
  assert.match(render, /onboarding: viewOnboarding/);
  assert.match(tabs, /session\.isAdmin[\s\S]{0,240}\['onboarding', '신규 학생', onboardingAttentionCount\(\)\]/);
  assert.match(view, /if \(!session\.isAdmin\) return/);
  assert.match(view, /원장·관리 담당 화면에서만/);
});

test('onboarding records use stable studentId and stay outside every staff owner scope', () => {
  const owner = block('function ownerOfCheck(key)', '/** 권한 근거가 아니라');
  const core = onboardingCore();

  assert.match(owner, /if \(\/\^__onboarding__\/\.test\(tid\)\) return null/);
  assert.ok(owner.indexOf('if (/^__onboarding__/') < owner.indexOf('tid.match(/^__[a-zA-Z]+__'));
  assert.equal(core.onboardingTaskId('student|stable'), '__onboarding__student%7Cstable');
  assert.equal(core.onboardingKey('student|stable'), '__onboarding__student%7Cstable|all');
  const saved = { studentId: 'student-42', taskId: '__onboarding__student-42', date: 'all',
    firstClassDate: '2026-08-15', items: {}, updatedAt: 123, casVersion: 1 };
  assert.equal(core.applyOnboardingRecord('student-42', saved), true);
  assert.equal(saved.studentId, 'student-42');
  assert.equal(saved.taskId, '__onboarding__student-42');
  assert.equal(saved.date, 'all');
  assert.equal(core.state.checks['__onboarding__student-42|all'], saved);
});

test('the plan covers pre-class essentials and D0/D1/D7/D14/D30', () => {
  const { ONBOARDING_STAGES } = onboardingCore();
  assert.deepEqual(ONBOARDING_STAGES.map(stage => [stage.key, stage.day]), [
    ['prep', -1], ['d0', 0], ['d1', 1], ['d7', 7], ['d14', 14], ['d30', 30]
  ]);
  const prep = ONBOARDING_STAGES[0].items.map(item => item.label).join(' ');
  for (const required of [
    '보호자 연락처', '시간표·교실·담당', '등원·귀가', '비상 연락망', '지각·결석',
    '앱·시스템·QR', '수강료·결제일', '환불·보강', '교재·준비물', '개인정보·사진'
  ]) assert.match(prep, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(ONBOARDING_STAGES.flatMap(stage => stage.items).some(item => item.notice));
});

test('completion is impossible before D30 even when every item is checked', () => {
  const core = onboardingCore();
  const items = Object.fromEntries(core.ONBOARDING_ITEMS.map(id => [id, 1]));
  const record = { firstClassDate: '2026-08-01', items };

  assert.equal(core.onboardingStatus(record, '2026-08-30').key, 'active');
  assert.equal(core.onboardingStatus(record, '2026-08-31').key, 'done');
  const firstDay = core.onboardingStatus({ firstClassDate: '2026-08-11', items: {} }, '2026-08-11');
  assert.equal(firstDay.key, 'firstday');
  assert.equal(firstDay.overdue, true, '미완료 사전 안내도 첫 등원 강조와 함께 경고해야 한다');
});

test('future-start students are eligible and cards sort by operational urgency', () => {
  const source = block('function onboardingRows()', 'function onboardingAttentionCount()');
  const rosterDb = { students: [
    { id: 'done', name: '라', start: '2026-07', end: '' },
    { id: 'future', name: '다', start: '2026-09', end: '' },
    { id: 'late', name: '나', start: '2026-08', end: '' },
    { id: 'first', name: '가', start: '2026-08', end: '' },
    { id: 'ended', name: '마', start: '2026-07', end: '2026-08' }
  ] };
  const records = new Map([
    ['done', { firstClassDate: '2026-07-01', status: { key: 'done' } }],
    ['future', { firstClassDate: '2026-09-01', status: { key: 'upcoming' } }],
    ['late', { firstClassDate: '2026-08-01', status: { key: 'overdue' } }],
    ['first', { firstClassDate: '2026-08-11', status: { key: 'firstday' } }],
    ['ended', { firstClassDate: '2026-07-01', status: { key: 'overdue' } }]
  ]);
  const api = new Function('rosterDb', 'records', `
    const today = () => '2026-08-11';
    const validYmd = value => /^\\d{4}-\\d{2}-\\d{2}$/.test(value);
    const onboardingAnyRecord = id => records.get(id) || null;
    const onboardingStatus = record => record.status;
    ${source}
    return { onboardingRows, onboardingCandidateStudents, validOnboardingFirstDate };
  `)(rosterDb, records);

  const rows = api.onboardingRows();
  assert.deepEqual(rows.map(row => row.student.id), ['first', 'late', 'future', 'done', 'ended']);
  assert.deepEqual(rows.find(row => row.student.id === 'ended').status,
    { key: 'closed', label: '재원 종료 · 관리 종료', overdue: false, inactive: true });
  records.delete('future');
  assert.deepEqual(api.onboardingCandidateStudents().map(student => student.id), ['future']);
  records.set('future', { firstClassDate: '2026-09-01', deleted: true, status: { key: 'upcoming' } });
  assert.deepEqual(api.onboardingCandidateStudents(), [], '취소 기록이 있는 학생은 신규 후보가 되면 안 된다');
  assert.equal(api.validOnboardingFirstDate(rosterDb.students[1], '2026-08-31'), false);
  assert.equal(api.validOnboardingFirstDate(rosterDb.students[1], '2026-09-01'), true);
});

test('the private roster stays separate until an explicit onboarding record exists', () => {
  const source = block('function onboardingRows()', 'function onboardingAttentionCount()');
  const rosterDb = { students: [
    { id: 'existing', name: '기존', start: '2024-03', end: '' },
    { id: 'started', name: '신규', start: '2026-08', end: '' }
  ] };
  const records = new Map([['started', { firstClassDate: '2026-08-11', status: { key: 'firstday' } }]]);
  const api = new Function('rosterDb', 'records', `
    const today = () => '2026-08-11';
    const validYmd = value => /^\\d{4}-\\d{2}-\\d{2}$/.test(value);
    const onboardingAnyRecord = id => records.get(id) || null;
    const onboardingStatus = record => record.status;
    ${source}
    return { onboardingRows, onboardingCandidateStudents, onboardingCandidateStartIsRecent };
  `)(rosterDb, records);

  assert.deepEqual(api.onboardingRows().map(row => row.student.id), ['started']);
  assert.deepEqual(api.onboardingCandidateStudents().map(row => row.id), ['existing']);
  assert.equal(api.onboardingCandidateStartIsRecent(rosterDb.students[0]), false);
  assert.equal(api.onboardingCandidateStartIsRecent(rosterDb.students[1]), true);
});

test('cancellation is admin-only and uses the server CAS endpoint for cancel and restore', () => {
  const click = block("case 'onbcancel':", "case 'onbcheck':");
  const add = block("case 'onbadd':", "case 'onbfilter':");
  const helper = block('async function patchOnboarding(', 'function onboardingProgress(');

  assert.match(click, /if \(!session\.isAdmin/);
  assert.match(click, /confirm\(/);
  assert.match(click, /기록은 삭제하지 않고 취소 이력으로 보관/);
  assert.match(click, /patchOnboarding\(studentId, 'cancel', \{\}/);
  assert.match(click, /case 'onbrestore'/);
  assert.match(click, /patchOnboarding\(studentId, 'restore', \{\}/);
  assert.match(add, /if \(onboardingAnyRecord\(studentId\)\) return toast/);
  assert.match(helper, /expectedUpdatedAt: Number\(current && current\.updatedAt\) \|\| 0/);
  assert.match(helper, /Number\(error && error\.status\) === 409/);
  assert.match(helper, /applyOnboardingRecord\(studentId, error\.current\)/);
  assert.match(add, /명단 시작월[\s\S]{0,180}신규 판정에 사용하지 않습니다/);
  assert.match(add, /if \(!confirm\(question\)\) return/);
});

test('ended and cancelled rows are history-only and excluded from operational KPIs', () => {
  const filter = block('function onboardingMatchesFilter(row)', 'function onboardingSearchText(student)');
  const view = block('function viewOnboarding()', 'function acaflowSpreadsheetName(file)');
  const api = new Function(`${filter}\nreturn status => { onboardingStatusFilter = status; return onboardingMatchesFilter; };`);
  const getFilter = api();

  assert.equal(getFilter('active')({ status: { key: 'closed' } }), false);
  assert.equal(getFilter('attention')({ status: { key: 'closed' } }), false);
  assert.equal(getFilter('closed')({ status: { key: 'closed' } }), true);
  assert.equal(getFilter('closed')({ status: { key: 'cancelled' } }), true);
  assert.match(view, /const operationalRows = rows\.filter\(row => row\.status\.key !== 'closed' && row\.status\.key !== 'cancelled'\)/);
  assert.match(view, /firstToday = operationalRows\.filter/);
  assert.match(view, /overdue = operationalRows\.filter/);
});

test('checking an item keeps its stage open and restores keyboard focus', () => {
  const helpers = block('function rememberOnboardingFocus(button)', 'function onboardingStageHtml(row, stage, focusKey)');
  const card = block('function onboardingCardHtml(row)', 'function viewOnboarding()');
  const click = block("case 'onbcheck':", '/* 체크 · 단계 · 수량 · 막힘 */');
  const render = block('function render() {', 'function renderTabs()');
  let focusOptions = null;
  const restoredButton = { dataset: { id: 'student-1', item: 'guardian' }, focus: options => { focusOptions = options; } };
  const document = { querySelectorAll: selector => {
    assert.equal(selector, '[data-act="onbcheck"]');
    return [restoredButton];
  } };
  const focusApi = new Function('document', `let onboardingRestoreFocus = null;\n${helpers}\n` +
    'return { rememberOnboardingFocus, restoreOnboardingFocus, current: () => onboardingRestoreFocus };')(document);
  const clicked = {
    dataset: { id: 'student-1', item: 'guardian' },
    closest: selector => {
      assert.equal(selector, '[data-onboarding-stage]');
      return { dataset: { stage: 'prep' } };
    }
  };
  focusApi.rememberOnboardingFocus(clicked);
  assert.deepEqual(focusApi.current(), { studentId: 'student-1', itemId: 'guardian', stageKey: 'prep' });
  assert.equal(focusApi.restoreOnboardingFocus(), true);
  assert.deepEqual(focusOptions, { preventScroll: true });
  assert.equal(focusApi.current(), null);
  assert.match(card, /retainedStage[\s\S]{0,500}focusStageKey/);
  assert.match(card, /onboardingStageHtml\(row, stage, focusStageKey\)/);
  assert.match(click, /rememberOnboardingFocus\(el\)[\s\S]{0,160}patchOnboarding\(studentId, 'item'/);
  assert.match(render, /applyOnboardingSearch\(onboardingSearchQuery\);\s*restoreOnboardingFocus\(\)/);
  assert.match(html, /data-onboarding-stage data-stage=/);
});

test('the latest request applies a lower-timestamp server 409 to repair forged local state', async () => {
  const source = block('function applyOnboardingRecord(studentId, record)', 'function onboardingProgress(record)');
  const post = block('async post(path, body)', 'async run()');
  const latest = { studentId: 'student-1', taskId: '__onboarding__student-1', date: 'all',
    firstClassDate: '2026-08-15', items: { guardian: 321 }, updatedAt: 456, casVersion: 1 };
  const forged = { ...latest, items: { forged: 999 }, updatedAt: 999 };
  const state = { checks: { '__onboarding__student-1|all': forged } };
  let saved = 0, rendered = 0, message = '';
  const api = new Function('state', 'latest', 'hooks', `
    const session = { isAdmin: true, isStaffLink: false };
    const SYNC_APP = 'task';
    const onboardingPatchSequence = new Map();
    const onboardingServerConfirmedAt = new Map();
    const onboardingTaskId = id => '__onboarding__' + encodeURIComponent(id);
    const onboardingKey = id => onboardingTaskId(id) + '|all';
    const onboardingAnyRecord = id => state.checks[onboardingKey(id)] || null;
    const save = () => hooks.save();
    const render = () => hooks.render();
    const toast = value => hooks.toast(value);
    const sync = { auth: () => ({ mode: 'admin', secret: 'x' }), post: async () => {
      const error = new Error('conflict'); error.status = 409; error.current = latest; throw error;
    } };
    ${source}
    return { patchOnboarding };
  `)(state, latest, { save: () => { saved += 1; }, render: () => { rendered += 1; }, toast: value => { message = value; } });

  await api.patchOnboarding('student-1', 'item', { itemId: 'schedule', done: true });
  assert.equal(state.checks['__onboarding__student-1|all'], latest);
  assert.equal(saved, 1);
  assert.equal(rendered, 1);
  assert.match(message, /최신 상태를 반영했으니 다시 시도/);
  assert.match(post, /error\.current = d && d\.current \|\| null/);
});

test('a delayed older 409 cannot overwrite a newer success', async () => {
  const source = block('function applyOnboardingRecord(studentId, record)', 'function onboardingProgress(record)');
  const base = { studentId: 'student-1', taskId: '__onboarding__student-1', date: 'all',
    firstClassDate: '2026-08-15', items: {}, updatedAt: 100, casVersion: 1 };
  const older = { ...base, items: { guardian: 150 }, updatedAt: 150 };
  const newer = { ...base, items: { schedule: 200 }, updatedAt: 200 };
  const state = { checks: { '__onboarding__student-1|all': base } };
  let rejectOlder;
  const pendingOlder = new Promise((resolve, reject) => { rejectOlder = reject; });
  let calls = 0;
  const api = new Function('state', 'pendingOlder', 'newer', 'hooks', `
    const session = { isAdmin: true, isStaffLink: false };
    const SYNC_APP = 'task';
    const onboardingPatchSequence = new Map();
    const onboardingServerConfirmedAt = new Map();
    const onboardingTaskId = id => '__onboarding__' + encodeURIComponent(id);
    const onboardingKey = id => onboardingTaskId(id) + '|all';
    const onboardingAnyRecord = id => state.checks[onboardingKey(id)] || null;
    const save = () => hooks.save(); const render = () => {}; const toast = () => {};
    const sync = { auth: () => ({ mode: 'admin', secret: 'x' }),
      post: async () => hooks.next() === 1 ? pendingOlder : { ok: true, record: newer } };
    ${source}
    return { patchOnboarding };
  `)(state, pendingOlder, newer, { save: () => {}, next: () => ++calls });

  const first = api.patchOnboarding('student-1', 'item', { itemId: 'guardian', done: true });
  await Promise.resolve();
  await api.patchOnboarding('student-1', 'item', { itemId: 'schedule', done: true });
  assert.equal(state.checks['__onboarding__student-1|all'], newer);
  const error = new Error('older conflict'); error.status = 409; error.current = older;
  rejectOlder(error);
  await first;
  assert.equal(state.checks['__onboarding__student-1|all'], newer);
});

test('new Pages reload reconciles forged CAS state even when normal collect and pull cursors skip it', () => {
  const source = block('collect(since) {', 'async post(path, body)');
  const reconcileSource = block('function onboardingReconcileChanges()', '/** 권한 근거가 아니라');
  const run = block('async run() {', '/** 장기 bearer 대신');
  const key = '__onboarding__student-1|all';
  const forged = { studentId: 'student-1', taskId: '__onboarding__student-1', date: 'all',
    classroom: 'FORGED', updatedAt: 999, casVersion: 1 };
  const canonical = { ...forged, classroom: 'B', updatedAt: 100 };
  const state = { checks: { [key]: forged }, staff: [], tasks: [] };
  const api = new Function('state', `
    const ownerOfCheck = () => null;
    const isContactCheckKey = key => String(key || '').split('|')[0].startsWith('__contact__');
    const onboardingServerConfirmedAt = new Map();
    const sync = { ${source} };
    ${reconcileSource}
    return { collect: sync.collect.bind(sync), apply: sync.apply.bind(sync), reconcile: onboardingReconcileChanges,
      confirmed: onboardingServerConfirmedAt };
  `)(state);
  assert.deepEqual(api.collect(10000), [], '기존 pushAt이 높으면 일반 collect는 forged 행을 놓친다');
  assert.deepEqual(api.reconcile(), [{ table: 'checks', k: key, owner: null, reconcile: true }]);
  assert.equal(api.apply([{ table: 'checks', key, data: canonical, authoritative: true }]), 1);
  assert.equal(state.checks[key].classroom, 'B');
  state.checks[key] = forged;
  assert.equal(api.apply([{ table: 'checks', key, data: canonical }]), 0);
  assert.equal(state.checks[key].classroom, 'FORGED');
  const newerServerSuccess = { ...canonical, classroom: 'C', updatedAt: 200 };
  state.checks[key] = newerServerSuccess;
  api.confirmed.set('student-1', 200);
  assert.equal(api.apply([{ table: 'checks', key, data: canonical, authoritative: true }]), 0,
    '이미 확인된 최신 endpoint 응답을 늦은 reconcile 응답으로 되돌리면 안 된다');
  assert.equal(state.checks[key].classroom, 'C');
  assert.match(run, /queueOnboardingReconcile\(auth\.mode === 'admin' \|\| session\.isManager\)/);
  assert.match(run, /state\.settings\.onboardingCasReconcileVersion = 1/);
});

test('UI is searchable, status-driven, accessible, and never sends parent messages', () => {
  const source = block('/* ── 신규 학생 30일 적응 관리 ──', 'function acaflowSpreadsheetName(file)');
  const view = block('function viewOnboarding()', 'function acaflowSpreadsheetName(file)');
  const input = block("document.addEventListener('input', ev => {", '/* 수업 등록 폼은');

  assert.match(view, /data-onboarding-search aria-label="신규 학생 검색"/);
  assert.match(view, /ONBOARDING_FILTERS\.map/);
  assert.match(view, /data-onboarding-search-status role="status" aria-live="polite"/);
  assert.match(source, /role="progressbar"[\s\S]{0,180}aria-valuenow/);
  assert.match(source, /role="checkbox" aria-checked/);
  assert.match(html, /\.onboarding-check[^\{]*\{[^}]*min-height: 44px/);
  assert.match(html, /@media \(max-width: 600px\)[\s\S]{0,500}\.onboarding-enrol/);
  assert.match(html, /\.onboarding-card\.is-first-day/);
  assert.match(input, /applyOnboardingSearch\(onboardingSearch\.value\)/);
  assert.match(view, /알림톡 자동 발송 없음/);
  assert.match(view, /현재 화면에서는 메시지를 보내지 않습니다/);
  assert.doesNotMatch(source, /sync\.post\([^)]*(?:feedback|kakao|message|send)|fetch\(|SOLAPI|sendParent/i);
});

test('the compact dashboard prioritizes active records and exposes day, next action, and missing essentials', () => {
  const helpers = block('function onboardingDday(', 'function onboardingCardHtml(');
  const view = block('function viewOnboarding()', 'function acaflowSpreadsheetName(file)');
  const api = new Function(`
    const parseYmd = value => new Date(value + 'T00:00:00');
    const today = () => '2026-08-11';
    const ymd = date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
    const addDays = (value, days) => { const date = parseYmd(value); date.setDate(date.getDate() + days); return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-'); };
    const ONBOARDING_ITEMS = ['schedule'];
    const ONBOARDING_STAGES = [{ key: 'prep', day: -1, label: '첫 수업 전', items: [{ id: 'schedule', label: '시간표 안내' }] }];
    ${helpers}
    return { onboardingDday, onboardingCompletionDate, onboardingNextAction };
  `)();

  assert.equal(api.onboardingDday('2026-08-11'), 'D-DAY');
  assert.equal(api.onboardingDday('2026-08-13'), 'D-2');
  assert.equal(api.onboardingDday('2026-08-09'), 'D+2');
  assert.deepEqual(api.onboardingNextAction({ record: { firstClassDate: '2026-08-11', items: {} }, status: { key: 'firstday' } }),
    { label: '시간표 안내', stage: '첫 수업 전', due: '2026-08-10' });
  const completedAt = new Date(2026, 8, 2).getTime();
  assert.equal(api.onboardingCompletionDate({ firstClassDate: '2026-08-01', items: { schedule: completedAt }, updatedAt: completedAt + 1000 }), '2026-09-02');
  assert.equal(api.onboardingCompletionDate({ firstClassDate: '2026-08-20', items: { schedule: new Date(2026, 7, 25).getTime() } }), '2026-09-19');
  assert.equal(api.onboardingCompletionDate({ firstClassDate: '2026-08-01', items: { schedule: true }, updatedAt: 0 }), '2026-08-31');
  assert.match(view, /const dashboardRows = operationalRows\.filter\(row => row\.status\.key !== 'done' \|\| onboardingCompletionDate\(row\.record\)\.slice\(0, 7\) === currentMonth\)/);
  assert.match(view, /const overdue = operationalRows\.filter\(row => row\.status\.overdue\)\.length/);
  assert.match(view, /onboardingDashboardHtml\(dashboardRows\)/);
  assert.match(helpers, /시간표 없음/);
  assert.match(helpers, /docsMissing = packageStates\.filter\(value => value === 'pending'\)/);
  assert.match(helpers, /docsPrepared = packageStates\.filter\(value => value === 'prepared'\)/);
  assert.match(helpers, /docsDelivered = packageStates\.filter\(value => value === 'delivered'\)/);
  assert.match(helpers, /전달 대기 ' \+ docsPrepared \+ '건/);
  assert.match(helpers, /확인 대기 ' \+ docsDelivered \+ '건/);
  assert.match(helpers, /row\.status\.key === 'done' \? shortDate\(onboardingCompletionDate\(record\)\) \+ ' 완료'/);
  assert.match(helpers, /role="table"/);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]{0,500}\.onboarding-board-row \{ grid-template-columns: 1fr/);
});

test('starting management is folded away and labels existing roster candidates as manual choices', () => {
  const view = block('function viewOnboarding()', 'function acaflowSpreadsheetName(file)');
  assert.match(view, /<details class="card onboarding-start">/);
  assert.match(view, /기존 원생 명단에서 신규 관리 시작/);
  assert.match(view, /명단 등록 ≠ 신규 학생/);
  assert.match(view, /선택하는 것만으로 신규가 되지 않으며/);
  assert.match(view, /명단 시작월 이번 달·예정 \(참고만\)/);
  assert.match(view, /그 외 재원생 \(수동 선택\)/);
  assert.match(view, /모든 학생은 확인 후에만 수동으로 시작/);
  assert.doesNotMatch(view, /<details class="card onboarding-start" open/);
  assert.ok(view.indexOf('onboardingDashboardHtml(dashboardRows)') < view.indexOf('<details class="card onboarding-start">'));
});
