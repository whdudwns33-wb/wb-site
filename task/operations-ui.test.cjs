const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function block(start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing ${start}`);
  assert.ok(to > from, `missing ${end}`);
  return html.slice(from, to);
}

test('student book issue board is derived from stable assignments and uses the transition contract', () => {
  const source = block('function bookIssueViewRows()', 'function bookIssueMatches(');
  const load = block('async function loadBookIssues(', 'function bookIssueMatches(');
  const transition = block('async function transitionBookIssue(', 'function viewBooks(');
  assert.match(source, /privateBookStudents/);
  assert.match(source, /assignment\.id \|\| assignment\.assignmentId/);
  assert.match(source, /studentId: String\(assignment\.studentId/);
  assert.match(load, /sync\.post\('\/book-issue', \{ app: SYNC_APP, auth: auth, action: 'list' \}\)/);
  assert.match(transition, /action: 'transition'/);
  assert.match(transition, /assignmentId: assignmentId/);
  assert.match(transition, /next: next, revision:/);
  assert.match(html, /data-next=\"prepared\"/);
  assert.match(html, /data-next=\"issued\"/);
  assert.match(html, /data-next=\"handed\"/);
  assert.match(html, /data-next=\"cancelled\"/);
  assert.match(html, /data-next=\"reissue\"/);
});

test('book issue risks use a real 24 hours and unmatched active records stay visible to managers', () => {
  const source = block('function bookIssueViewRows()', 'async function loadBookIssues(');
  assert.match(source, /Date\.now\(\) - issuedAt >= 86400000/);
  assert.match(source, /if \(session\.isAdmin\)/);
  assert.match(source, /integrity: 'orphan'/);
  assert.match(source, /integrity: identityMismatch \? 'mismatch'/);
  assert.match(html, /연결 끊김·확인 필요/);
  assert.match(html, /출고 후 실제 24시간 이상/);
  assert.match(html, /출고 후 1일\+ 미수령/);
});

test('legacy book issue UI keeps status and admin-only unassigned KPIs, filters, retry, focus restoration, and no contact fields', () => {
  const view = block('function viewLegacyBookIssues()', 'function bookOrderStageRows(');
  const whole = block('/* ── 학생별 교재 출고·인계 ──', 'function viewBooks()');
  assert.match(view, /미출고/);
  assert.match(view, /출고 후 1일\+ 미수령/);
  assert.match(view, /오늘 출고/);
  assert.match(view, /인계 완료/);
  assert.match(view, /session\.isAdmin \? \(unassigned === null[\s\S]{0,360}교재 미배정 · 확인 필요/);
  assert.match(whole, /<details class="card book-issue-unassigned">/);
  assert.match(whole, /교재는 자동 배정하지 않습니다/);
  assert.match(view, /data-book-issue-search/);
  assert.match(view, /bookissuerefresh/);
  assert.match(whole, /restoreBookIssueFocus/);
  assert.match(whole, /min-height: 44px|ops-actions/);
  assert.doesNotMatch(whole, /type=\"tel\"|data-(?:phone|address)|guardianPhone/);
});

test('unassigned book warning uses stable student ids, current enrollment, and fails closed outside admin roster', () => {
  const source = block('function bookIssueUnassignedStudents()', 'function bookIssueUnassignedHtml(');
  assert.match(source, /if \(!session\.isAdmin\) return \[\]/);
  assert.match(source, /rosterLoading \|\| rosterErr \|\| !rosterDb[\s\S]{0,120}return null/);
  assert.match(source, /assignedStudentIds.*studentId/);
  assert.match(source, /student\.start <= currentMonth/);
  assert.match(source, /!student\.end \|\| student\.end > currentMonth/);
  assert.doesNotMatch(source, /student\.name.*assignedStudentIds|자동.*배정/);

  const run = (session, rosterDb, privateBookStudents, rosterLoading = false, rosterErr = '') => new Function(
    'session', 'rosterDb', 'privateBookStudents', 'rosterLoading', 'rosterErr', 'today',
    source + '; return bookIssueUnassignedStudents();'
  )(session, rosterDb, privateBookStudents, rosterLoading, rosterErr, () => '2026-08-11');
  const roster = { students: [
    { id: 'student-active-missing', name: '미배정학생', grade: '중1', teacher: '담당A', start: '2026-08', end: '' },
    { id: 'student-active-assigned', name: '배정학생', grade: '중2', teacher: '담당B', start: '2026-07', end: '' },
    { id: 'student-ended', name: '종료학생', grade: '중3', teacher: '담당C', start: '2026-01', end: '2026-08' },
    { id: 'student-future', name: '예정학생', grade: '초6', teacher: '담당D', start: '2026-09', end: '' }
  ] };
  const assignments = [{ id: 'assignment-stable', studentId: 'student-active-assigned' }];

  assert.deepEqual(run({ isAdmin: false }, roster, assignments), []);
  assert.equal(run({ isAdmin: true }, null, assignments), null);
  assert.equal(run({ isAdmin: true }, roster, assignments, true, ''), null);
  assert.equal(run({ isAdmin: true }, roster, assignments, false, 'temporary error'), null);
  assert.deepEqual(run({ isAdmin: true }, roster, assignments).map(student => student.id), ['student-active-missing']);
});

test('book issue errors keep roster-derived warnings visible and refresh both sources', () => {
  const view = block('function viewLegacyBookIssues()', 'function bookOrderStageRows(');
  const actions = block("case 'rosterretry':", "case 'onbadd':");
  assert.match(view, /const unassignedHtml = bookIssueUnassignedHtml\(unassigned\)/);
  assert.match(view, /if \(bookIssueError\)[\s\S]{0,420}\+ unassignedHtml/);
  assert.match(view, /unassigned === null[\s\S]{0,160}미배정 확인 불가/);
  assert.match(html, /최신 원생 명단을 확인하지 못해 이전 명단의 숫자를 표시하지 않습니다/);
  assert.match(actions, /case 'bookissuerefresh':[\s\S]{0,180}loadRoster\(\); loadBookIssues\(true\)/);
});

test('order delivery board uses four collapsed quantity stages and stable-student actions', () => {
  const view = block('function bookOrderStageRows(', 'async function transitionBookIssue(');
  const picker = block('function orderStudentCandidates()', 'function batchOrderModal(');
  assert.match(view, /교재 주문 및 배송 현황/);
  assert.match(view, /1단계 · 주문대기/);
  assert.match(view, /2단계 · 주문완료 \/ 주문실패/);
  assert.match(view, /3단계 · 선생님 수령/);
  assert.match(view, /4단계 · 학생배부 완료/);
  assert.match(view, /<details class="book-order-stage"><summary>/);
  assert.match(view, /data-next="receive"[\s\S]{0,160}>수령완료<\/button>/);
  assert.match(view, /data-next="hand"[\s\S]{0,160}>배부완료<\/button>/);
  assert.match(view, /data-next="academy_register"[\s\S]{0,180}>아카등록완료<\/button>/);
  assert.match(view, /data-act="bookorderlinkopen"[\s\S]{0,180}>학생 연결<\/button>/);
  assert.match(view, /data-order-link-student/);
  assert.match(view, /action: 'order_link'/);
  assert.match(view, /studentIds: studentIds/);
  assert.match(view, /expectedUpdatedAt:/);
  assert.match(view, /해야 할 업무 · 아카등록/);
  assert.match(view, /action: 'order_transition'/);
  assert.match(picker, /student\.id/);
  assert.match(picker, /data-order-student/);
  assert.match(picker, /data-order-unit-price/);
  assert.match(html, /studentIds: studentIds/);
  assert.doesNotMatch(picker, /data-order-qty|placeholder="예: 3권"/);
});

test('first-day package uses exact stable studentId schedule and shows every honest missing state', () => {
  const schedule = block('function onboardingFirstWeekSchedule(', 'function firstDayPackageHtml(');
  const packageView = block('const ONBOARDING_PACKAGE_DOCS = [', 'function onboardingCardHtml(');
  assert.match(schedule, /weeklyLessonSchedule\(record\.firstClassDate\)/);
  assert.match(schedule, /String\(entry\.studentId \|\| ''\) === String\(student\.id\)/);
  assert.doesNotMatch(schedule, /studentName|student\.name/);
  assert.match(packageView, /시간표 0건/);
  assert.match(packageView, /교실 미입력/);
  assert.match(packageView, /문서 템플릿 미등록/);
  assert.match(packageView, /등록·수강 신청 서류/);
  assert.match(packageView, /비상 연락망·등하원·귀가 동의/);
  assert.match(packageView, /결제일·환불·보강 안내/);
  assert.match(packageView, /이 화면에서 학부모 알림톡은 자동 발송되지 않습니다/);
});

test('package stores only intermediate timestamps separately and reuses prep item timestamps for final confirmation', () => {
  const state = block('function onboardingPackageState(', 'function onboardingFirstWeekSchedule(');
  const click = block("case 'onbpackage':", '/* 체크 · 단계 · 수량 · 막힘 */');
  assert.match(state, /record\.items && record\.items\[doc\.itemId\]/);
  assert.match(state, /record\.packagePrepared && record\.packagePrepared\[doc\.id\]/);
  assert.match(state, /record\.packageDeliveries && record\.packageDeliveries\[doc\.id\]/);
  assert.match(state, /return 'pending'/);
  assert.match(click, /patchOnboarding\(studentId, 'package', \{ docId: docId, next: next \}/);
  assert.doesNotMatch(click, /items\[doc\.itemId\] = now\(\)|prepared\[doc\.id\] = now\(\)|deliveries\[doc\.id\] = now\(\)/);
  assert.match(html, /\{ id: 'registration', label: '등록·수강 신청 서류 작성과 회수 여부를 확인'/);
  assert.match(html, /\{ id: 'registration', label: '등록·수강 신청 서류', itemId: 'registration' \}/);
});

test('first-day package and classroom restore focus after rerender', () => {
  const restore = block('function restoreOnboardingFocus()', 'function onboardingStageHtml(');
  assert.match(restore, /if \(target\.classroom\)/);
  assert.match(restore, /\[data-onboarding-classroom\]/);
  assert.match(restore, /if \(target\.packageDoc\)/);
  assert.match(restore, /\[data-act=\"onbpackage\"\]/);
  assert.match(restore, /button\.focus\(\{ preventScroll: true \}\)/);
});

test('transport is a separate top-level route for admin and staff, not part of onboarding or books', () => {
  assert.match(html, /\['books', '교재'\], \['transport', '차량'\], \['roster', '원생'\]/);
  assert.match(html, /transport: viewTransport/);
  assert.match(html, /const allowed = \['today', 'week', 'lesson', 'feedback', 'books', 'transport', 'roster'\]/);
  assert.match(html, /function viewTransport\(\)/);
});

test('transport list, student transitions, and all-config replace use the agreed API contract', () => {
  const load = block('async function loadTransport(', 'function transportProjectedRows(');
  const state = block('async function transitionTransportState(', 'function ensureTransportDraft(');
  const replace = block('async function saveTransportConfig(', 'function mutateTransportConfig(');
  assert.match(load, /sync\.post\('\/transport', \{ app: SYNC_APP, auth: auth, action: 'list', date: date \}\)/);
  assert.match(state, /action: 'state', date: stateDate/);
  assert.match(state, /routeId: routeId, studentId: studentId, next: next, revision:/);
  assert.match(replace, /action: 'replace', config: config/);
  assert.match(html, /plate: String\(\(row\.querySelector\('\[data-tc-plate\]'\)/);
  assert.match(html, /const startTime = String\(\(row\.querySelector\('\[data-tc-route-time\]'\)/);
  assert.match(html, /active: !!\(row\.querySelector\('\[data-tc-active\]'\)/);
  assert.match(html, /student\.stop && typeof student\.stop === 'object'/);
  assert.match(html, /driverId=active staffId|기사는 직원으로도 등록|이미 재직 직원/);
  assert.match(html, /data-next=\"boarded\"/);
  assert.match(html, /data-next=\"dropped\"/);
  assert.match(html, /data-next=\"absent\"/);
  assert.match(html, /data-next=\"scheduled\"/);
  assert.doesNotMatch(html, /data-next=\"reset\"/);
  assert.match(html, /else if \(!session\.isAdmin\) action = '<span class=\"small muted\">완료된 운행은 관리자만 되돌릴 수 있습니다/);
});

test('transport separates saved ride state from guardian notification outcome', () => {
  const actions = block('function transportStudentActions(', 'function transportRouteCard(');
  const transition = block('async function transitionTransportState(', 'function transportGuardianModal(');
  const notification = block('const TRANSPORT_NOTIFICATION_STATUS = {', 'function transportGuardianState(');
  const success = block('function transportStateSuccessToast(', 'function transportOwnPhoneTarget(');
  assert.match(actions, />탑승 확인<\/button>/);
  assert.match(actions, />하차 확인<\/button>/);
  assert.match(actions, />미탑승 확인<\/button>/);
  assert.match(transition, /notifyGuardian: stateDate === today\(\) && \(next === 'boarded' \|\| next === 'dropped'\)/);
  assert.match(transition, /rememberTransportNotification\(stateDate, routeId, studentId, next, result\.notification\)/);
  assert.match(transition, /await loadTransport\(transportDate, true, true\)/);
  assert.match(transition, /toast\(transportStateSuccessToast\(next, notification\)\)/);
  assert.match(notification, /accepted: \['카톡 접수'/);
  assert.match(notification, /rejected: \['카톡 거절/);
  assert.match(notification, /unknown: \['카톡 접수 여부 확인 필요/);
  assert.match(notification, /function transportNotificationStatus\(value\)/);
  assert.match(notification, /SEND_DISABLED.*TEMPLATE_NOT_APPROVED/);
  assert.match(notification, /카톡 미발송 · 알림 설정 준비 중/);
  assert.match(notification, /카톡 미발송 · 연락처·동의 필요/);
  assert.match(notification, /카톡 미발송 · 관리자 확인/);
  assert.match(notification, /const status = transportNotificationStatus\(value\)/);
  assert.match(success, /transportNotificationStatus\(notification \|\| \{ status: 'unknown' \}\)/);
  assert.match(notification, /row\.student\.notification/);
});

test('saved transport state is never reported as failed when only refresh fails', async () => {
  const transition = block('async function transitionTransportState(', 'function transportGuardianModal(');
  const posts = [], messages = [];
  const run = new Function(
    'sync', 'toast', 'validYmd', 'today', 'transportStateKey', 'rememberTransportNotification',
    'transportStateSuccessToast', 'loadTransport', 'confirm', 'prompt',
    'const SYNC_APP="task"; let transportDate="2026-08-12", transportRestoreFocus=null; ' + transition +
      '; return transitionTransportState;'
  )(
    { auth: () => ({ mode: 'person' }), post: async (path, payload) => {
      posts.push({ path, payload }); return { notification: { status: 'accepted', event: 'boarded' } };
    } },
    message => messages.push(message), () => false, () => '2026-08-12',
    (routeId, studentId) => routeId + '|' + studentId,
    (date, routeId, studentId, next, notification) => notification,
    () => '탑승 확인 저장 · 카톡 접수', async () => { throw new Error('refresh failed'); },
    () => true, () => ''
  );
  const button = { disabled: false, dataset: { route: 'route-a', student: 'student-a', next: 'boarded', rev: '0' } };
  await run(button);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].payload.notifyGuardian, true);
  assert.deepEqual(messages, [
    '탑승 확인 저장 · 카톡 접수',
    '기록은 저장됨 · 화면 새로고침 필요 — 같은 확인 버튼을 다시 누르지 마세요'
  ]);
  assert.equal(messages.some(message => message.includes('상태 저장 실패')), false);
  assert.equal(button.disabled, true);
});

test('transport notification code families share honest card and toast wording', () => {
  const source = block('const TRANSPORT_NOTIFICATION_STATUS = {', 'function rememberTransportNotification(');
  const status = new Function(source + '; return transportNotificationStatus;')();
  assert.equal(status({ status: 'blocked', code: 'SEND_DISABLED' })[0], '카톡 미발송 · 알림 설정 준비 중');
  assert.equal(status({ status: 'blocked', code: 'TEMPLATE_NOT_APPROVED' })[0], '카톡 미발송 · 알림 설정 준비 중');
  assert.equal(status({ status: 'blocked', code: 'GUARDIAN_PHONE_MISSING' })[0], '카톡 미발송 · 연락처·동의 필요');
  assert.equal(status({ status: 'blocked', code: 'CALL_CONSENT_MISSING' })[0], '카톡 미발송 · 연락처·동의 필요');
  assert.equal(status({ status: 'blocked', code: 'TRANSPORT_RECONSENT_REQUIRED' })[0], '카톡 미발송 · 연락처·동의 필요');
  assert.equal(status({ status: 'blocked', code: 'ROUTE_CHANGED' })[0], '카톡 미발송 · 관리자 확인');
});

test('own driver gets consent-gated tel links and a clear no-show confirmation procedure', () => {
  const source = block('function transportTelHref(', 'function transportGuardianModal(');
  const actions = block('function transportStudentActions(', 'function transportRouteCard(');
  const transition = block('async function transitionTransportState(', 'function transportGuardianModal(');
  assert.match(source, /\^\\\+\?\\d\{8,15\}\$/);
  assert.match(actions, /row\.student\.callReady === true/);
  assert.match(actions, /transportTelHref\(row\.student\.guardianPhone\)/);
  assert.match(actions, /href=\"' \+ esc\(telHref\)/);
  assert.match(actions, />전화<\/a>/);
  assert.match(actions, /data-act=\"transportphone\" data-route=/);
  assert.match(actions, /data-student=\"' \+ esc\(row\.studentId\)/);
  assert.match(actions, />번호 확인<\/button>/);
  assert.doesNotMatch(actions, /data-(?:phone|guardian-phone)/i);
  assert.match(source, /function transportOwnPhoneTarget\(routeId, studentId\)/);
  assert.match(actions, /const ownPersonalRoute = session\.isStaffLink && transportDate === today\(\) && hasVerifiedPersonAuth\(\)/);
  assert.match(actions, /String\(row\.route && \(row\.route\.driverId \|\| row\.route\.driver_id\) \|\| ''\) === session\.staffId/);
  assert.match(source, /!session\.isStaffLink \|\| transportDate !== today\(\) \|\| !hasVerifiedPersonAuth\(\)/);
  assert.match(source, /auth\.mode !== 'person' \|\| auth\.id !== session\.staffId/);
  assert.match(source, /String\(routeRow\.driverId \|\| routeRow\.driver_id \|\| ''\) !== session\.staffId/);
  assert.match(source, /routeRow\.days\.map\(Number\)\.includes\(dowOf\(today\(\)\)\)/);
  assert.match(source, /student\.callReady !== true/);
  assert.match(source, /transportTelHref\(student\.guardianPhone\)/);
  assert.match(source, /function openTransportPhone\(button\)/);
  assert.match(source, /esc\(target\.phone\)/);
  assert.match(source, /href=\"' \+ esc\(target\.href\)/);
  assert.match(html, /case 'transportphone': openTransportPhone\(el\); break/);
  assert.match(transition, /전화 버튼으로 보호자에게 탑승 여부를 먼저 확인했나요/);
  assert.match(transition, /기사 전화 동의 또는 연락처가 없어 전화할 수 없습니다/);
  assert.match(transition, /확인 후 미탑승으로 기록할까요/);

  const renderActions = new Function(
    'session', 'transportDate', 'today', 'hasVerifiedPersonAuth', 'sync', 'transportTelHref', 'esc', 'transportStateKey',
    actions + '; return transportStudentActions;'
  )(
    { isStaffLink: true, isAdmin: true, staffId: 'manager-driver' }, '2026-08-12', () => '2026-08-12',
    () => true, { auth: () => ({ mode: 'person', id: 'manager-driver' }) },
    value => 'tel:' + value, value => String(value), (routeId, studentId) => routeId + '|' + studentId
  );
  const managerDriverHtml = renderActions({
    routeId: 'route-a', studentId: 'student-a', revision: 0, status: 'scheduled',
    route: { driverId: 'manager-driver' }, student: { name: '학생', callReady: true, guardianPhone: '01012345678' }
  });
  assert.match(managerDriverHtml, />전화<\/a>/);
  assert.match(managerDriverHtml, />번호 확인<\/button>/);
});

test('admin lazily manages stable-id transport contact and three separate consents', () => {
  const actions = block('function transportStudentActions(', 'function transportRouteCard(');
  const summary = block('function transportGuardianState(', 'function transportRouteStudents(');
  const open = block('async function openTransportGuardianSettings(', 'async function saveTransportGuardianSettings(');
  const save = block('async function saveTransportGuardianSettings(', 'function ensureTransportDraft(');
  assert.match(actions, /data-act=\"transportguardian\" data-student=/);
  assert.match(actions, /차량 연락·알림 설정/);
  assert.match(summary, /maskedPhone/);
  assert.match(summary, /기사 전화/);
  assert.match(summary, /탑승 알림/);
  assert.match(summary, /하차 알림/);
  assert.match(summary, /재동의 필요/);
  assert.match(open, /action: 'guardian_get', studentId: studentId/);
  assert.match(save, /action: 'guardian_set', studentId: transportGuardianTarget\.studentId/);
  assert.match(save, /callAllowed:/);
  assert.match(save, /boardedConsent:/);
  assert.match(save, /droppedConsent:/);
  assert.match(save, /expectedContactUpdatedAt:/);
  assert.match(save, /expectedConsentUpdatedAt:/);
  assert.match(save, /confirmNewIdentity: confirmNewIdentity/);
  assert.match(save, /phone \|\| transportGuardianTarget\.needsReconsent/);
  assert.match(save, /이 번호의 보호자에게 차량 전화·알림 동의를 직접 확인했는지 체크해 주세요/);
  assert.match(html, /id="transportGuardianNewIdentity"/);
  assert.match(save, /if \(phone\) payload\.phone = phone/);
  assert.doesNotMatch(summary, /guardianPhone|type=\"tel\"|data-(?:phone|guardian-phone)/i);
});

test('transport prioritizes onboarded students and exposes orphan state and capacity errors', () => {
  const view = block('function viewTransport()', '/* ── 원생 현황');
  const validation = block('function transportConfigValidation(', 'function transportConfigRowHtml(');
  assert.match(view, /탑승 중 · 최우선/);
  assert.match(view, /설정 확인 필요/);
  assert.match(view, /과거 탑승 상태와 현재 노선·학생 배정이 연결되지 않습니다/);
  assert.match(view, /확인 후 상태 정리/);
  assert.match(view, /row\.date \|\| transportDate/);
  assert.match(html, /transportData\.unresolved/);
  assert.match(html, /String\(row\.date \|\| ''\) === transportDate && matched\.has\(key\)/);
  assert.match(validation, /차량 정원/);
  assert.match(validation, /초과했습니다/);
  assert.match(html, /transportHasRiders\(\)/);
  assert.match(html, /탑승 중인 학생이 있어 설정을 저장할 수 없습니다/);
  assert.match(html, /Number\(error && error\.status\) === 409/);
  assert.match(html, /student\.start <= currentMonth/);
  assert.match(html, /\.package-states \.btn \{ min-width: 0; min-height: 44px/);
});

test('transport run dashboard derives honest course status without extra PII or storage', () => {
  const source = block('function transportTimeMinutes(', 'function transportUnmatchedStates(');
  const view = block('function viewTransport()', '/* ── 원생 현황');
  const helpers = new Function(source + '; return {status:transportRouteRunStatus,end:transportRouteEndMinutes,' +
    'estimated:transportRouteEndIsEstimated,completion:transportRouteCompletionAt};')();
  const status = helpers.status;
  const route = { startTime: '17:00', stops: [{ time: '17:30' }], plan: { serviceMinutes: 20 } };
  const rows = values => values.map(value => ({ status: value }));

  assert.equal(status(route, [], '2026-08-12', '2026-08-12', '17:10'), 'empty');
  assert.equal(status(route, rows(['dropped', 'absent']), '2026-08-11', '2026-08-12', '18:00'), 'completed');
  assert.equal(status(route, rows(['boarded']), '2026-08-11', '2026-08-12', '18:00'), 'attention');
  assert.equal(status(route, rows(['scheduled']), '2026-08-11', '2026-08-12', '18:00'), 'attention');
  assert.equal(status(route, rows(['scheduled']), '2026-08-13', '2026-08-12', '18:00'), 'upcoming');
  assert.equal(status(route, rows(['dropped']), '2026-08-13', '2026-08-12', '18:00'), 'attention');
  assert.equal(status(route, rows(['scheduled']), '2026-08-12', '2026-08-12', '16:59'), 'upcoming');
  assert.equal(status(route, rows(['boarded']), '2026-08-12', '2026-08-12', '16:59'), 'running');
  assert.equal(status(route, rows(['scheduled']), '2026-08-12', '2026-08-12', '17:10'), 'running');
  assert.equal(status(route, rows(['scheduled']), '2026-08-12', '2026-08-12', '17:46'), 'attention');
  assert.equal(status(route, rows(['boarded']), '2026-08-12', '2026-08-12', '17:46'), 'attention');
  assert.equal(status(route, rows(['dropped', 'scheduled']), '2026-08-12', '2026-08-12', '17:10'), 'running');
  assert.equal(status(route, [], '2026-08-12', '2026-08-12', '17:10', 1), 'attention');
  assert.equal(status(route, [], '2026-08-12', '2026-08-12', '17:10', 0, 2), 'attention');
  assert.equal(status(route, rows(['dropped', 'absent']), '2026-08-12', '2026-08-12', '17:10', 0, 1), 'attention');
  const pickup = { direction: 'pickup', startTime: '17:00', stops: [{ time: '17:30' }] };
  assert.equal(helpers.end(pickup), 17 * 60 + 50);
  assert.equal(helpers.estimated(pickup), true);
  assert.equal(helpers.completion([
    { status: 'dropped', stateRow: { droppedAt: 1000 } },
    { status: 'absent', stateRow: { absentAt: 2000 } }
  ]), 2000);

  assert.match(source, /기사·코스별 운행 현황판/);
  assert.match(source, /마지막 갱신/);
  assert.match(source, /const seoulNow = seoulNowParts\(\)/);
  assert.match(source, /timeZone: 'Asia\/Seoul'/);
  assert.match(source, /data-act="transportrefresh"/);
  assert.match(source, /확인 완료 ' \+ item\.completed \+ '\/' \+ item\.rows\.length \+ '명'/);
  assert.match(source, /예상/);
  assert.match(source, /종료 시각 미기록/);
  assert.match(source, /new Date\(item\.completionAt\)\.toLocaleTimeString/);
  assert.match(source, /연결 확인 ' \+ item\.orphanBoarded \+ '건/);
  assert.match(source, /명단 연결 대기 ' \+ item\.pendingCount \+ '명/);
  assert.match(source, /pendingCount\) return 'attention'/);
  assert.doesNotMatch(source, /guardianPhone|student\.name|\.address/);
  assert.match(view, /orphanBoardedByRoute/);
  assert.match(view, /String\(row\.date \|\| transportDate\) !== transportDate/);
  assert.match(view, /transportRunDashboard\(routes, stateByRoute, orphanBoardedByRoute\)/);
  assert.match(html, /\.transport-run-list \{ display: grid; grid-template-columns: repeat\(2/);
  assert.match(html, /\.transport-run-list \{ grid-template-columns: 1fr; \}/);
});

test('transport keeps unmatched schedule names admin-only until a stable roster student is linked', () => {
  const helpersSource = block('function transportPendingStudentNames(', 'function deepCopy(');
  const admin = new Function('session', helpersSource + '; return {names:transportPendingStudentNames,count:transportRoutePendingCount};')({ isAdmin: true });
  const staff = new Function('session', helpersSource + '; return transportRoutePendingCount;')({ isAdmin: false });
  const stop = { pendingStudentNames: [' 연결대기 ', '', '연결대기', '다른학생'] };
  const route = { stops: [stop], pendingCount: 2 };
  assert.deepEqual(admin.names(stop), ['연결대기', '다른학생']);
  assert.equal(admin.count(route), 2);
  assert.equal(staff(route), 2);

  const capture = block('function transportRosterReady()', 'function transportConfigValidation(');
  const config = block('function transportConfigRowHtml(', 'async function saveTransportConfig(');
  const removal = block('function removeTransportPendingStudent(', 'function mutateTransportConfig(');
  const actions = block("case 'rosterretry':", "case 'onbadd':");
  const routeCard = block('function transportRouteCard(', 'function transportStateSuccessToast(');
  assert.match(capture, /pendingStudentNames: transportDraftPendingStudentNames\(draft, row\.dataset\.id, stop\.dataset\.id\)/);
  assert.match(config, /명단 연결 대기 · ' \+ pendingNames\.length \+ '명/);
  assert.match(config, /data-act="transportpendingremove"/);
  assert.match(removal, /selectedNames\.has\(name\)/);
  assert.match(removal, /실제 탑승 대상이 아니어서 대기 명단에서 제외/);
  assert.match(removal, /stop\.pendingStudentNames = transportPendingStudentNames\(stop\)\.filter/);
  assert.match(actions, /case 'transportpendingremove': removeTransportPendingStudent\(el\); break/);
  assert.match(routeCard, /session\.isAdmin && pendingCount \? '<div class="hint mt8"><b>명단 연결 대기/);
  assert.match(routeCard, /if \(!rows\.length && !pendingCount\)/);
});

test('transport config fails closed until the private roster is available', () => {
  const capture = block('function transportRosterReady()', 'function transportConfigValidation(');
  const config = block('function transportConfigRowHtml(', 'async function saveTransportConfig(');
  const save = block('async function saveTransportConfig(', 'function mutateTransportConfig(');
  const actions = block("case 'rosterretry':", "case 'onbadd':");
  assert.match(capture, /rosterDb && Array\.isArray\(rosterDb\.students\)/);
  assert.match(capture, /transportCapturedStudentIds\(draft, row\.dataset\.id, stop\.dataset\.id/);
  assert.match(config, /saveDisabled = locked \|\| !rosterReady/);
  assert.match(config, /studentDisabled = locked \|\| !rosterReady/);
  assert.match(config, /data-act="transportrosterretry"/);
  assert.match(save, /if \(!transportRosterReady\(\)\)/);
  assert.match(actions, /case 'transportrosterretry': rosterErr = ''; rosterDb = null; loadRoster\(\); render\(\); break/);

  const guard = new Function('rosterDb', 'rosterErr', capture + '; return {' +
    'ready: transportRosterReady(), ids: transportDraftStudentIds({' +
      'routes:[{id:"route-a",stops:[{id:"stop-a",studentIds:["student-a"]}]}]' +
    '}, "route-a", "stop-a")};');
  assert.equal(guard(null, '').ready, false);
  assert.equal(guard({ students: [] }, 'temporary error').ready, false);
  assert.deepEqual(guard({ students: [] }, '').ids, ['student-a']);
});

test('transport keeps draft students missing from a stale roster while honoring visible deselection', () => {
  const source = block('function transportRosterReady()', 'function captureTransportConfig()');
  const run = new Function('rosterDb', 'rosterErr', source + '; return transportCapturedStudentIds;')(
    { students: [{ id: 'known-a' }, { id: 'known-b' }] }, ''
  );
  const draft = { routes: [{ id: 'route-a', stops: [{ id: 'stop-a', studentIds: ['known-a', 'missing-old'] }] }] };
  const select = {
    options: [{ value: 'known-a' }, { value: 'known-b' }],
    selectedOptions: [{ value: 'known-b' }]
  };
  assert.deepEqual(run(draft, 'route-a', 'stop-a', select), ['known-b', 'missing-old']);

  const config = block('function transportConfigRowHtml(', 'async function saveTransportConfig(');
  const actions = block("case 'rosterretry':", "case 'onbadd':");
  assert.match(config, /명단 없음 · 기존 배정 유지/);
  assert.match(config, /학생 명단 새로고침 필요/);
  assert.match(actions, /case 'transportrefresh':[\s\S]{0,360}loadRoster\(\);[\s\S]{0,100}loadTransport\(transportDate, true\)/);
});

test('transport quick driver registration preserves the route draft and uses synced active staff', async () => {
  const configView = block('function transportConfigRowHtml(', 'async function saveTransportConfig(');
  const source = block('async function addTransportDriver(', 'function mutateTransportConfig(');
  const actions = block("case 'rosterretry':", "case 'onbadd':");
  assert.match(configView, /<summary>기사 등록<\/summary>/);
  assert.match(configView, /기존 직원은 각 노선의 기사 선택에서 바로 고르고/);
  assert.match(configView, /data-transport-driver-name/);
  assert.match(configView, /data-act="transportdriveradd"/);
  assert.match(configView, /data-act="transportdriverfocus"/);
  assert.match(configView, /data-tc-driver-id/);
  assert.doesNotMatch(configView, /기사 후보|data-act="transportdriverqr"/);
  assert.doesNotMatch(actions, /case 'transportdriverqr'/);
  assert.match(html, /data-act="qrlink"/);
  assert.match(source, /const config = captureTransportConfig\(\)/);
  assert.match(source, /sameMatches\.length > 1/);
  assert.match(source, /clearTimeout\(sync\.timer\); sync\.timer = null/);
  assert.match(source, /const synced = await sync\.run\(\)/);
  assert.match(source, /action: 'list', date: transportDate/);
  assert.match(source, /config\.drivers = serverDrivers\.map/);
  assert.doesNotMatch(source, /config\.(?:vehicles|routes)\s*=\s*serverConfig/);
  assert.match(source, /latestRevision !== originalRevision/);
  assert.match(source, /transportConfigRevisionConflict = true/);
  assert.match(source, /transportDriverTargetRoute[\s\S]{0,180}target\.driverId = String\(pendingId\)/);

  const run = new Function(
    'session', 'transportHasRiders', 'toast', 'sync', 'document', 'captureTransportConfig', 'liveStaff',
    'confirm', 'uid', 'now', 'state', 'save', 'transportData', 'transportDate', 'transportDriverPending',
    'render', 'route',
    'const SYNC_APP="task"; let transportDriverTargetRoute="route-a", transportConfigDraft=null, transportConfigDirty=false, ' +
      'transportConfigRevisionConflict=false, transportRestoreFocus=null; ' + source +
      '; return { run:addTransportDriver, snapshot:()=>({draft:transportConfigDraft,dirty:transportConfigDirty,' +
      'conflict:transportConfigRevisionConflict,pending:transportDriverPending.size}) };'
  );
  const originalStop = { id: 'stop-a', name: '공동 승차장', address: '공동 지점', time: '16:00', studentIds: ['student-a'] };
  const originalVehicle = { id: 'vehicle-a', name: '1호차', plate: 'test', capacity: 9 };
  const draft = { baseAddress: '학원', vehicles: [originalVehicle], drivers: [],
    routes: [{ id: 'route-a', direction: 'pickup', driverId: '', stops: [originalStop] }] };
  const pending = new Map();
  const state = { staff: [] };
  const api = run(
    { isAdmin: true }, () => false, () => {},
    { timer: null, busy: false, dirty: false, err: '', auth: () => ({ mode: 'admin' }), run: async () => true,
      post: async () => ({ config: { drivers: [{ id: 'staff-new', staffId: 'staff-new', name: '새기사' }] }, revision: 7 }) },
    { querySelector: () => ({ value: '새기사' }) }, () => draft, () => state.staff.filter(row => !row.deleted),
    () => true, () => 'staff-new', () => 1234, state, () => {}, { revision: 7 }, '2026-08-12', pending,
    () => {}, 'transport'
  );
  await api.run({ disabled: false, isConnected: true });
  const snapshot = api.snapshot();
  assert.equal(state.staff[0].id, 'staff-new');
  assert.equal(snapshot.draft.vehicles[0], originalVehicle);
  assert.equal(snapshot.draft.routes[0].stops[0], originalStop);
  assert.deepEqual(snapshot.draft.routes[0].stops[0].studentIds, ['student-a']);
  assert.equal(snapshot.draft.routes[0].driverId, 'staff-new');
  assert.equal(snapshot.dirty, true);
  assert.equal(snapshot.conflict, false);
  assert.equal(snapshot.pending, 0);
});

test('transport route builder, map planner, and unsaved-draft guards expose the safe UI contract', () => {
  const load = block('async function loadTransport(', 'function transportProjectedRows(');
  const capture = block('function captureTransportConfig()', 'function transportConfigValidation(');
  const config = block('function transportConfigRowHtml(', 'async function saveTransportConfig(');
  const planner = block('async function planTransportRoute(', 'function openTransportGoogleMap(');
  const google = block('function transportGoogleDirectionsUrl(', 'function transportRosterReady(');
  const actions = block("case 'rosterretry':", "case 'onbadd':");
  assert.match(capture, /draft\.baseAddress = baseAddress/);
  assert.match(capture, /address: String\(\(stop\.querySelector\('\[data-tc-stop-address\]'\)/);
  assert.match(capture, /routePlanChanged = baseAddressChanged/);
  assert.match(capture, /previousPlan \? previousPlan\.dwellMinutes : 3/);
  assert.match(capture, /stop\.name !== String\(old\.name/);
  assert.match(capture, /stop\.address !== String\(old\.address/);
  assert.match(capture, /stop\.time !== String\(old\.time/);
  assert.match(config, /\+ 등원 노선/);
  assert.match(config, /\+ 하원 노선/);
  assert.match(config, /data-act="transportstopmove"/);
  assert.match(config, /저장되지 않은 변경이 있습니다/);
  assert.match(config, /학생 집주소 대신 건물·상가·아파트 정문/);
  assert.match(config, /네이버 예상시간 설정 필요/);
  assert.match(config, /locked \|\| plannerBusy \|\| !mapsReady/);
  assert.match(config, /Google 지도 모바일에서는 일부 경유지가 생략될 수 있어 경로 순서 확인용/);
  assert.match(planner, /action: 'plan'/);
  assert.match(planner, /capabilities\.mapsPlanning/);
  assert.match(planner, /name: String\(stop\.name \|\| ''\)\.trim\(\), address:/);
  assert.match(planner, /stops\.some\(stop => !stop\.name \|\| !stop\.address\)/);
  assert.match(planner, /baseAddress: baseAddress, direction: routeRow\.direction, startTime: routeRow\.startTime/);
  assert.match(planner, /dwellMinutes: dwellMinutes, stops: stops/);
  assert.match(planner, /result && Array\.isArray\(result\.suggestedStops\)/);
  assert.match(planner, /routeRow\.plan = plan/);
  assert.match(planner, /transportConfigDirty = true/);
  assert.match(google, /https:\/\/www\.google\.com\/maps\/dir\/\?/);
  assert.match(google, /waypoints/);
  assert.match(actions, /transportDiscardDraft\('새로고침하면/);
  assert.match(actions, /transportDiscardDraft\('날짜를 이동하면/);
  assert.match(actions, /transportDiscardDraft\('오늘로 이동하면/);
  assert.match(load, /const draftRevision = Number\(transportData && transportData\.revision\) \|\| 0/);
  assert.match(load, /if \(latestRevision !== draftRevision\) transportConfigRevisionConflict = true/);
  assert.match(html, /\.transport-config \.btn, \.transport-config input, \.transport-config select \{ min-height: 44px/);
});

test('transport UI remains mobile accessible and minimizes guardian PII in the DOM', () => {
  const source = block('/* ── 차량 운행 ──', '/* ── 원생 현황');
  assert.match(html, /\.transport-route-grid \{ grid-template-columns: 1fr; \}/);
  assert.match(html, /\.transport-datebar \.btn \{ min-height: 44px; \}/);
  assert.match(source, /restoreTransportFocus/);
  assert.match(source, /주소는 표시하지 않으며, 연락처는 동의가 확인된 오늘 본인 노선에서만 확인할 수 있습니다/);
  assert.match(source, /명시적 번호 확인 모달과 tel: 링크에서만 일시 표시하며 data\/localStorage\/log에 복제하지 않는다/);
  assert.doesNotMatch(source, /data-(?:phone|guardian-phone)/i);
  assert.doesNotMatch(source, /console\.(?:log|warn|error)\([^\n]*(?:guardianPhone|phoneInput)/);
});
