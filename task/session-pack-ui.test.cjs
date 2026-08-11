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

test('admin and staff both get a dedicated session route without opening other admin routes', () => {
  const render = block('function render() {', 'function renderTabs()');
  const tabs = block('function renderTabs()', '/* ── 링크로 들어온 지시서 확인');

  assert.match(render, /const allowed = \['today', 'week', 'lesson', 'feedback', 'books', 'transport', 'roster'\]/);
  assert.match(render, /allowed\.push\('sessions'\)/);
  assert.match(render, /sessions: viewSessionPacks/);
  assert.match(render, /route === 'sessions'[\s\S]{0,100}restoreSessionPackFocus/);
  assert.equal((tabs.match(/\['sessions', '회차', sessionPackAttentionCount\(\)\]/g) || []).length, 2);
});

test('the list uses only the private session-pack endpoint and explicitly omits monthly lessons', () => {
  const source = block('async function loadSessionPacks(force)', 'async function sessionPackConsumptionGroup');

  assert.match(source, /sync\.post\('\/session-pack', \{ app: SYNC_APP, auth: auth, action: 'list' \}\)/);
  assert.match(source, /지정하지 않은 월제 수업은 아래 목록에 나타나지 않습니다/);
  assert.match(source, /월제 수업은 정상이며 이 목록에 나타나지 않습니다/);
  assert.doesNotMatch(source, /guardian|phone|contact|payment|price|amount|receipt/i);
});

test('admin create is stable student plus lesson opt-in with total and validity, never a student-wide mode', () => {
  const options = block('function sessionPackLessonOptions()', 'function sessionPackKpis(rows)');
  const create = block('async function createSessionPack(button)', 'function sessionPackAdjustmentModal');

  assert.match(options, /task\.studentId/);
  assert.match(options, /taskKind === 'lesson_instruction' \|\| task\.lessonFormVersion \|\| task\.intakeVersion/);
  for (const field of ['spLesson', 'spTotal', 'spFrom', 'spExpires']) assert.match(options, new RegExp(`id="${field}"`));
  assert.match(create, /action: 'create', studentId: task\.studentId, lessonTaskId: task\.id/);
  assert.match(create, /totalSessions: totalSessions, validFrom: validFrom, expiresOn: expiresOn/);
  assert.match(create, /deductionPolicy: 'recommended_v1'/);
  assert.match(create, /if \(!session\.isAdmin\)/);
});

test('KPI funnel covers remaining 3, 1, 0 and expiry attention', () => {
  const source = block('function sessionPackKpis(rows)', 'function sessionPackHistoryHtml');
  const api = new Function('sessionPackDaysLeft', `${source}\nreturn sessionPackKpis;`)(date => ({ far: 90, soon: 7, old: -1 }[date]));
  const output = api([
    { status: 'active', remainingSessions: 3, expiresOn: 'far' },
    { status: 'active', remainingSessions: 1, expiresOn: 'soon' },
    { status: 'active', remainingSessions: 0, expiresOn: 'far' },
    { status: 'active', remainingSessions: 8, expiresOn: 'old', expired: true },
    { status: 'closed', remainingSessions: 0, expiresOn: 'old', expired: true }
  ]);

  assert.match(output, /<b>2<\/b><span>잔여 3회 이하/);
  assert.match(output, /<b>1<\/b><span>잔여 1회 이하/);
  assert.match(output, /<b>1<\/b><span>잔여 0회/);
  assert.match(output, /<b>2<\/b><span>14일 내 만료·경과/);
});

test('own staff record also works for a manager personal link and stays hidden elsewhere', () => {
  const card = block('function sessionPackStaffRecordHtml(pack)', 'function sessionPackCard(pack)');
  const record = block('async function recordTodaySessionPack(packId, button)', '/* ── 주간 플래너');
  const hash = block('async function sessionPackConsumptionGroup(taskId, date)', 'async function createSessionPack');

  assert.match(card, /getCheck\(pack\.lessonTaskId, today\(\)\)/);
  assert.match(card, /if \(!session\.isStaffLink \|\| pack\.teacherId !== session\.staffId/);
  assert.doesNotMatch(card, /session\.isAdmin/);
  for (const type of ['approved_absence', 'same_day', 'no_show', 'academy_cancel']) assert.match(card, new RegExp(type));
  assert.match(record, /if \(!session\.isStaffLink\) return/);
  assert.match(record, /if \(!pack \|\| pack\.teacherId !== session\.staffId\) return/);
  assert.doesNotMatch(record, /session\.isAdmin/);
  assert.match(record, /setCheck\(pack\.lessonTaskId, today\(\), \{ absenceType: absenceType \}\)/);
  assert.ok(record.indexOf('await sync.run()') < record.indexOf("sync.post('/session-pack'"));
  assert.match(record, /action: 'record'.*revision: Number\(pack\.revision\)/s);
  assert.match(record, /sourceType: 'regular'.*sourceKey: pack\.lessonTaskId \+ '\|' \+ today\(\)/s);
  assert.match(hash, /SYNC_APP \+ '\\n' \+ taskId \+ '\\n' \+ date/);
  assert.match(hash, /'mc_' \+ hex\.slice\(0, 48\)/);
});

test('admin adjustment records a reason code, uses CAS, and close preserves history', () => {
  const adjust = block('function sessionPackAdjustmentModal', 'async function closeSessionPack');
  const close = block('async function closeSessionPack', 'async function recordTodaySessionPack');

  assert.match(adjust, /id="spAdjustReason" autofocus/);
  assert.match(adjust, /action: 'adjust'.*revision: revision.*delta: delta/s);
  assert.match(adjust, /sourceKey: 'adj_'/);
  assert.match(adjust, /reasonCode: reasonCode/);
  assert.doesNotMatch(adjust, /textarea|memo|note|금액|결제/i);
  assert.match(close, /사용·조정 내역은 그대로 보관됩니다/);
  assert.match(close, /action: 'close'.*revision: revision/s);
});

test('errors offer retry and focus is restored after async card mutations', () => {
  const source = block('function rememberSessionPackFocus', 'function replaceSessionPack');
  const view = block('function viewSessionPacks()', 'async function sessionPackConsumptionGroup');
  const mutations = block('async function createSessionPack(button)', '/* ── 주간 플래너');

  assert.match(source, /focus\(\{ preventScroll: true \}\)/);
  assert.match(view, /role="alert"/);
  assert.match(view, /data-act="sprefresh" autofocus>다시 시도/);
  assert.match(mutations, /rememberSessionPackFocus/);
  assert.match(mutations, /Number\(error && error\.status\) === 409/);
  assert.match(mutations, /loadSessionPacks\(true\)/);
});

test('mobile and QR layouts are one column with 44px controls', () => {
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));

  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.session-pack-create, \.session-pack-grid \{ grid-template-columns: 1fr; \}/);
  assert.match(css, /\.session-pack-actions \.btn \{ min-height: 44px; \}/);
  assert.match(css, /html\.person-mobile \.session-pack-create,[\s\S]*?html\.person-mobile \.session-pack-grid \{ grid-template-columns: 1fr; \}/);
  assert.match(css, /html\.person-mobile \.btn,[\s\S]*?min-height: 44px/);
});

test('click routing covers refresh, create, adjust, close, and actual attendance record', () => {
  const click = block("case 'sprefresh':", '/* 날짜 */');
  for (const action of ['sprefresh', 'spcreate', 'spadjust', 'spadjustsubmit', 'spclose', 'sprecord']) {
    assert.match(click, new RegExp(`case '${action}'`));
  }
});
