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

test('admin and personal staff get a dedicated makeup route without displacing sessions', () => {
  const render = block('function render() {', 'function renderTabs()');
  const tabs = block('function renderTabs()', '/* ── 링크로 들어온 지시서 확인');

  assert.match(render, /allowed\.push\('makeup'\)/);
  assert.match(render, /makeup: viewMakeups/);
  assert.match(render, /route === 'makeup'[\s\S]{0,100}restoreMakeupFocus/);
  assert.match(render, /sessions: viewSessionPacks/);
  assert.equal((tabs.match(/\['makeup', '보강', makeupAttentionCount\(\)\]/g) || []).length, 2);
  assert.equal((tabs.match(/\['sessions', '회차', sessionPackAttentionCount\(\)\]/g) || []).length, 2);
});

test('an A attendance card syncs first and creates one stable source-linked review', () => {
  const panel = block('function taskPanel(t, date, c, editable)', '/** 수업 출결 표시용 */');
  const request = block('function makeupRequestHtml(task, date, check)', 'function makeupIsDelayed');
  const create = block('async function createMakeupFromAbsence', 'function makeupReasonModal');

  assert.match(panel, /makeupRequestHtml\(t, date, c\)/);
  assert.match(request, /check\.att !== 'A'/);
  assert.match(request, /task\.studentId/);
  assert.match(request, /makeupCaseForSource\(task\.id, date\)/);
  assert.match(request, /data-act="mucreate"/);
  assert.ok(create.indexOf('await sync.run()') < create.indexOf("sync.post('/makeup'"));
  assert.match(create, /action: 'create_from_absence', sourceTaskId: taskId, sourceDate: date/);
  assert.match(create, /result\.idempotent/);
});

test('KPI funnel counts review, parent wait, confirmed, today, delayed, and notification states', () => {
  const source = block('function makeupIsDelayed(row, date)', 'function makeupAttentionCount()');
  const api = new Function(`${source}\nreturn { makeupIsDelayed, makeupKpiCounts };`)();
  const rows = [
    { status: 'review_pending', sourceDate: '2026-08-10' },
    { status: 'reviewed', sourceDate: '2026-08-11' },
    { status: 'awaiting_parent', sourceDate: '2026-08-01', proposedDate: '2026-08-10', notificationNeeded: true },
    { status: 'confirmed', sourceDate: '2026-08-01', confirmedDate: '2026-08-11' },
    { status: 'confirmed', sourceDate: '2026-08-01', confirmedDate: '2026-08-09', notificationNeeded: true },
    { status: 'completed', sourceDate: '2026-08-01', confirmedDate: '2026-08-08', notificationNeeded: true }
  ];

  assert.deepEqual(api.makeupKpiCounts(rows, '2026-08-11'), {
    review: 1, awaiting: 1, confirmed: 2, today: 1, overdue: 3, notification: 3
  });
  const output = block('function makeupKpis(rows)', 'function viewMakeups()');
  for (const label of ['검토 대기', '보호자 응답 대기', '일정 확정', '오늘 / 지연', '알림 필요']) {
    assert.match(output, new RegExp(label.replace('/', '\\/')));
  }
});

test('admin workflow shows parent responses and uses only restricted operational reasons', () => {
  const source = block('const MAKEUP_STATUS_LABELS', '/* ── 주간 플래너');
  const actions = block('function makeupAdminActions(row)', 'function makeupCard(row)');
  const parent = block('function makeupParentHtml(row)', 'function makeupScheduleHtml(row)');

  for (const reason of ['policy_ineligible', 'already_resolved', 'parent_declined', 'schedule_unavailable', 'student_inactive', 'other']) {
    assert.match(source, new RegExp(reason));
  }
  for (const action of ['mureviewrequired', 'mureviewnot', 'mupropose', 'muconfirm', 'mucancel']) {
    assert.match(actions, new RegExp(`data-act="${action}"`));
  }
  assert.match(parent, /parentResponse === 'accept'/);
  assert.match(parent, /parentResponse === 'decline'/);
  assert.match(source, /질병·가정사 등 민감정보/);
  assert.doesNotMatch(source, /<textarea|prompt\s*\(/i);
});

test('only the assigned personal-link teacher can complete, including a manager link', () => {
  const card = block('function makeupCard(row)', 'function makeupKpis(rows)');
  const click = block("case 'murefresh':", '/* 날짜 */');

  assert.match(card, /const ownComplete = session\.isStaffLink && row\.status === 'confirmed' && row\.confirmedStaffId === session\.staffId/);
  assert.doesNotMatch(card.match(/const ownComplete[^;]+;/)[0], /session\.isAdmin/);
  assert.match(click, /if \(!session\.isStaffLink \|\| !row \|\| row\.status !== 'confirmed' \|\| row\.confirmedStaffId !== session\.staffId\) break/);
  assert.match(click, /action: 'complete'.*revision: Number\(row\.revision\)/s);
});

test('notification marker never claims that KakaoTalk was sent', () => {
  const source = block('function makeupCard(row)', 'function makeupKpis(rows)');

  assert.match(source, /알림톡 발송 필요 · 템플릿 준비 중/);
  assert.doesNotMatch(source, /발송 (완료|성공)|발송됐|전송 완료/);
});

test('list errors retry, announce changes, restore focus, and reload after 409', () => {
  const focus = block('function rememberMakeupFocus', 'function replaceMakeup');
  const view = block('function viewMakeups()', 'async function refreshMakeupsAfterConflict');
  const mutations = block('async function refreshMakeupsAfterConflict', 'function makeupReasonModal');

  assert.match(focus, /focus\(\{ preventScroll: true \}\)/);
  assert.match(view, /role="status" aria-live="polite"/);
  assert.match(view, /role="alert"/);
  assert.match(view, /data-act="murefresh" autofocus>다시 시도/);
  assert.match(mutations, /Number\(error && error\.status\) === 409/);
  assert.match(mutations, /loadMakeups\(true\)/);
  assert.match(mutations, /rememberMakeupFocus/);
});

test('completed makeup refreshes a linked session pack and reports one-time consumption', () => {
  const mutations = block('async function refreshMakeupsAfterConflict', 'function makeupReasonModal');
  assert.match(mutations, /result\.sessionPackImpact/);
  assert.match(mutations, /pack_identity_mismatch/);
  assert.match(mutations, /회차권 배정 변경 확인 필요/);
  assert.match(mutations, /impact && impact\.refreshNeeded/);
  assert.match(mutations, /await loadSessionPacks\(true\)/);
  assert.match(mutations, /Number\(impact\.delta\) === 1/);
  assert.match(mutations, /기존 차감과 중복 없이 회차 반영/);
});

test('mobile and QR layouts are one column with 44px actions', () => {
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));

  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.makeup-grid \{ grid-template-columns: 1fr; \}/);
  assert.match(css, /\.makeup-actions \.btn, \.makeup-request \{ min-height: 44px; \}/);
  assert.match(css, /html\.person-mobile \.makeup-grid \{ grid-template-columns: 1fr; \}/);
  assert.match(css, /html\.person-mobile \.btn,[\s\S]*?min-height: 44px/);
});

test('click routing covers every makeup state transition', () => {
  const click = block("case 'murefresh':", '/* 날짜 */');
  for (const action of ['murefresh', 'mucreate', 'mureviewrequired', 'mureviewnot', 'mureviewnotsubmit',
    'mupropose', 'muproposesubmit', 'muconfirm', 'mucancel', 'mucancelsubmit', 'mucomplete']) {
    assert.match(click, new RegExp(`case '${action}'`));
  }
});

test('makeup UI stores no guardian contact or sensitive free-text fields', () => {
  const source = block('/* ── 보강 —', '/* ── 주간 플래너');

  assert.doesNotMatch(source, /guardianPhone|parentPhone|phone|contact|상담메모|<textarea|prompt\s*\(/i);
  assert.match(source, /정해진 운영 사유만 기록합니다/);
});
