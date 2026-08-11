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
    const save = () => {};
    const queueSync = () => {};
    const now = () => 123;
    const parseYmd = s => { const [y,m,d] = s.split('-').map(Number); return new Date(y,m-1,d); };
    const ymd = d => [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('-');
    const addDays = (s,n) => { const d = parseYmd(s); d.setDate(d.getDate()+n); return ymd(d); };
    const today = () => '2026-08-11';
    ${source}
    return { ONBOARDING_STAGES, ONBOARDING_ITEMS, onboardingTaskId, onboardingKey,
      onboardingAnyRecord, onboardingProgress, onboardingStatus, setOnboarding, state };
  `)();
}

test('admin navigation exposes a dedicated onboarding route and staff links cannot open it', () => {
  const render = block('function render() {', 'function renderTabs()');
  const tabs = block('function renderTabs()', '/* ── 링크로 들어온 지시서 확인');
  const view = block('function viewOnboarding()', 'function acaflowCodexPrompt()');

  assert.match(render, /const allowed = \['today', 'week', 'lesson', 'feedback', 'books', 'roster'\]/);
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
  const saved = core.setOnboarding('student-42', { firstClassDate: '2026-08-15', items: {} });
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

test('cancellation is admin-only, cannot overwrite, and restores the existing history', () => {
  const click = block("case 'onbcancel':", "case 'onbcheck':");
  const add = block("case 'onbadd':", "case 'onbfilter':");
  const core = onboardingCore();
  core.setOnboarding('student-7', {
    firstClassDate: '2026-08-20', items: { guardian: 11 }, canceledAt: 22,
    cancelHistory: [22], deleted: true
  });
  const restored = core.setOnboarding('student-7', { deleted: false, restoredAt: 33 });

  assert.match(click, /if \(!session\.isAdmin/);
  assert.match(click, /confirm\(/);
  assert.match(click, /기록은 삭제하지 않고 취소 이력으로 보관/);
  assert.match(click, /cancelHistory\.push\(canceledAt\)/);
  assert.match(click, /case 'onbrestore'/);
  assert.match(click, /setOnboarding\(studentId, \{ deleted: false, restoredAt: now\(\) \}\)/);
  assert.match(add, /if \(onboardingAnyRecord\(studentId\)\) return toast/);
  assert.equal(restored.firstClassDate, '2026-08-20');
  assert.equal(restored.items.guardian, 11);
  assert.equal(restored.canceledAt, 22);
  assert.deepEqual(restored.cancelHistory, [22]);
  assert.equal(restored.deleted, false);
});

test('ended and cancelled rows are history-only and excluded from operational KPIs', () => {
  const filter = block('function onboardingMatchesFilter(row)', 'function onboardingSearchText(student)');
  const view = block('function viewOnboarding()', 'function acaflowCodexPrompt()');
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
  assert.match(click, /rememberOnboardingFocus\(el\)[\s\S]{0,120}setOnboarding[\s\S]{0,80}render\(\)/);
  assert.match(render, /applyOnboardingSearch\(onboardingSearchQuery\);\s*restoreOnboardingFocus\(\)/);
  assert.match(html, /data-onboarding-stage data-stage=/);
});

test('UI is searchable, status-driven, accessible, and never sends parent messages', () => {
  const source = block('/* ── 신규 학생 30일 적응 관리 ──', 'function acaflowCodexPrompt()');
  const view = block('function viewOnboarding()', 'function acaflowCodexPrompt()');
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
