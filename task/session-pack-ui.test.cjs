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
  const source = block('async function loadSessionPacks(force)', 'async function createSessionPack');

  assert.match(source, /sync\.post\('\/session-pack', \{ app: SYNC_APP, auth: auth, action: 'list' \}\)/);
  assert.match(source, /지정하지 않은 월제 수업은 아래 목록에 나타나지 않습니다/);
  assert.match(source, /월제 수업은 정상이며 이 목록에 나타나지 않습니다/);
  assert.doesNotMatch(source, /guardian|phone|contact|payment|price|amount|receipt/i);
});

test('admin create is stable student plus lesson opt-in with total and validity, never a student-wide mode', () => {
  const options = block('function sessionPackLessonOptions()', 'function sessionPackKpis(rows)');
  const create = block('async function createSessionPack(button)', 'function sessionPackAdjustmentModal');

  assert.match(options, /task\.studentId/);
  assert.match(options, /isSessionLessonTask\(task\)/);
  for (const field of ['spLesson', 'spTotal', 'spFrom', 'spExpires']) assert.match(options, new RegExp(`id="${field}"`));
  assert.match(create, /action: 'create', studentId: task\.studentId, lessonTaskId: task\.id/);
  assert.match(create, /totalSessions: totalSessions, validFrom: validFrom, expiresOn: expiresOn/);
  assert.match(create, /deductionPolicy: 'recommended_v1'/);
  assert.match(create, /if \(!session\.isAdmin\)/);
});

test('KPI funnel covers remaining 3, 1, 0 and expiry attention', () => {
  const attentionSource = block('function sessionPackIsAttention(pack)', 'function sessionPackAttentionCount()');
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
  assert.match(attentionSource, /remainingSessions\) <= 3/);
});

test('lesson mode badges default to monthly only after the scoped pack list succeeds', () => {
  const source = block('function sessionPackForLessonTask(task)', 'function sessionModeBadgeHtml(task)');
  const make = (loaded, error, packs) => new Function(
    'sessionPackLoaded', 'sessionPackError', 'sessionPackRows', 'sessionModeLessonTask', 'sessionPackDaysLeft',
    `${source}\nreturn sessionModeBadgeDescriptor;`
  )(loaded, error, packs, task => !!task && !task.deleted, expiry => expiry === '2026-08-18' ? 7 : 90);
  const lesson = { id: 'lesson-1' };

  assert.deepEqual(make(false, '', [])(lesson), { text: '수업 형태 확인 중', cls: '' });
  assert.deepEqual(make(true, 'temporary', [])(lesson), { text: '수업 형태 확인 필요', cls: 'is-error' });
  assert.deepEqual(make(true, '', [])(lesson), { text: '월제', cls: 'is-monthly' });
  assert.deepEqual(make(true, '', [
    { status: 'active', lessonTaskId: 'lesson-other', remainingSessions: 8, expiresOn: '2026-12-31' }
  ])(lesson), { text: '월제', cls: 'is-monthly' });

  const sessionMode = make(true, '', [
    { status: 'active', lessonTaskId: 'lesson-1', remainingSessions: 1, expiresOn: '2026-08-18' }
  ])(lesson);
  assert.equal(sessionMode.text, '회차제 · 1회 남음');
  assert.match(sessionMode.cls, /is-session/);
  assert.match(sessionMode.cls, /is-critical/);
  assert.match(sessionMode.title, /보호자 안내 검토/);
});

test('monthly and session badges render for administrators only', () => {
  const source = block('function sessionModeBadgeHtml(task)', 'function sessionModeBadgesHtml(tasks)');
  const make = isAdmin => new Function('session', 'sessionModeBadgeDescriptor', 'esc',
    `${source}\nreturn sessionModeBadgeHtml;`)(
      { isAdmin }, () => ({ text: '월제', cls: 'is-monthly' }), value => String(value || '')
    );
  assert.equal(make(false)({ id: 'lesson-1' }), '');
  assert.match(make(true)({ id: 'lesson-1' }), />월제<\/span>/);
  assert.match(source, /if \(!session\.isAdmin\) return ''/);
});

test('session mode badges apply only to structured session-pack eligible lessons', () => {
  const helpers = block("const isLesson =", '/** 수업 지시서 제목');
  const source = block('function sessionModeLessonTask(task)', 'function sessionPackForLessonTask(task)');
  assert.match(helpers, /const isSessionLessonTask =/);
  assert.match(helpers, /taskKind === 'lesson_instruction'/);
  assert.doesNotMatch(helpers.match(/const isSessionLessonTask[\s\S]*?;\r?\n/)[0], /\[수업\]|컨설팅/);
  assert.match(source, /return isSessionLessonTask\(task\)/);
});

test('session attention makes 3, 1, 0 and expiry states explicit without auto sending', () => {
  const source = block('function sessionPackAlertInfo(pack)', 'function sessionModeBadgeDescriptor(task)');
  const alert = new Function('sessionPackDaysLeft', `${source}\nreturn sessionPackAlertInfo;`)(
    expiry => ({ '2026-12-31': 90, '2026-08-18': 7, '2026-08-01': -1 }[expiry])
  );

  assert.match(alert({ status: 'active', remainingSessions: 3, expiresOn: '2026-12-31' }).text, /잔여 3회 이하/);
  assert.match(alert({ status: 'active', remainingSessions: 1, expiresOn: '2026-12-31' }).text, /잔여 1회/);
  assert.match(alert({ status: 'active', remainingSessions: 0, expiresOn: '2026-12-31' }).text, /잔여 0회/);
  assert.match(alert({ status: 'active', remainingSessions: 8, expiresOn: '2026-08-01', expired: true }).text, /유효기간 만료/);
  assert.match(alert({ status: 'active', remainingSessions: 8, expiresOn: '2026-08-18' }).text, /만료 7일 전/);

  const notice = block('function sessionPackOpsNoticeHtml(pack)', 'function sessionPackStaffRecordHtml(pack)');
  assert.match(notice, /잔여 회차 보호자 안내 검토/);
  assert.match(notice, /자동발송 없음 · 수동 접수 전/);
  assert.doesNotMatch(notice, /sync\.post|dispatch|send\(/);
});

test('monthly and session counts include only lessons active on the reference date', () => {
  const source = block('function sessionPackModeKpis(rows)', 'function sessionPackHistoryHtml');
  assert.match(source, /const reference = today\(\)/);
  assert.match(source, /!task\.start \|\| task\.start <= reference/);
  assert.match(source, /!task\.end \|\| task\.end >= reference/);
  assert.match(source, /pack\.status === 'active' && lessonIds\.has/);
});

test('today and schedule reuse session-pack badges while the own-roster list stays name-and-grade only', () => {
  const loader = block('const SESSION_MODE_BADGE_ROUTES', 'function rememberSessionPackFocus');
  const today = block('function viewToday()', 'function taskRow');
  const task = block('function taskRow', 'function taskPanel');
  const schedule = block('function scheduleTimelineModal', 'function scheduleWeekCardsHtml');
  const studentCards = block('function scheduleStudentCardsHtml', 'function scheduleIssuesHtml');
  const roster = block('function viewRoster()', '/* ── 직원 관리');

  assert.match(loader, /new Set\(\['today', 'schedule'\]\)/);
  assert.match(loader, /setTimeout\(\(\) => loadSessionPacks\(false\), 0\)/);
  assert.match(today, /ensureSessionModeData\(list\)/);
  assert.match(task, /sessionModeBadgeHtml\(t\)/);
  assert.match(schedule, /sessionModeBadgeHtml\(task\)/);
  assert.match(schedule, /sessionModeBadgesHtml\(tasks\)/);
  assert.match(studentCards, /sessionModeBadgesHtml\(taskSources\.map/);
  assert.doesNotMatch(roster, /sessionModeBadgesForStudent\(s\.id, today\(\)\)/);
  assert.match(roster, /mineActive\.map[\s\S]*esc\(s\.name\)[\s\S]*esc\(s\.grade\)/);
});

test('session attendance stays editable until the 23:50 cutoff and is then locked for automatic recording', () => {
  const card = block('function sessionPackStaffRecordHtml(pack)', 'function sessionPackCard(pack)');
  const cutoff = block('const SESSION_PACK_ATTENDANCE_CUTOFF_MINUTE', 'function sessionPackAlertInfo(pack)');
  const panel = block('function taskPanel(t, date, c, editable)', '/** 수업 출결 표시용 */');
  const changes = block("document.addEventListener('change', async ev =>", "document.addEventListener('toggle'");

  assert.match(card, /getCheck\(pack\.lessonTaskId, today\(\)\)/);
  assert.match(card, /if \(!session\.isStaffLink \|\| pack\.teacherId !== session\.staffId/);
  assert.doesNotMatch(card, /session\.isAdmin/);
  assert.match(card, /sessionPackAttendanceHintHtml/);
  assert.doesNotMatch(card, /sprecord|오늘 출결로 회차 반영|sync\.post/);
  assert.match(cutoff, /23 \* 60 \+ 50/);
  assert.match(cutoff, /row\.sourceType === 'regular' && row\.sourceKey === sourceKey/);
  assert.match(cutoff, /date === current\.date && current\.minute >= SESSION_PACK_ATTENDANCE_CUTOFF_MINUTE/);
  assert.match(cutoff, /당일 23:50 기준 출결이 회차 원장에 반영되어 마감됐습니다/);
  for (const type of ['approved_absence', 'same_day', 'no_show', 'academy_cancel']) assert.match(cutoff, new RegExp(type));
  assert.match(panel, /attendanceLocked \? ' disabled' : ''/);
  assert.match(panel, /sessionPackAttendanceHintHtml\(t, date, c, sessionAttendance\)/);
  assert.match(changes, /data-session-pack-absence/);
  assert.match(changes, /setCheck\(taskId, date, \{ absenceType \}\)/);
  assert.match(changes, /settleSync\(\)\.catch/);
});

test('admin adjustment records a reason code, uses CAS, and close preserves history', () => {
  const adjust = block('function sessionPackAdjustmentModal', 'async function closeSessionPack');
  const close = block('async function closeSessionPack', '/* ── 주간 플래너');

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
  const view = block('function viewSessionPacks()', 'async function createSessionPack');
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

test('click routing covers refresh, create, adjust, and close while regular attendance is automatic', () => {
  const click = block("case 'sprefresh':", '/* 날짜 */');
  for (const action of ['sprefresh', 'spcreate', 'spadjust', 'spadjustsubmit', 'spclose']) {
    assert.match(click, new RegExp(`case '${action}'`));
  }
  assert.doesNotMatch(click, /case 'sprecord'/);
});
