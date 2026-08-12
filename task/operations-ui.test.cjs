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

test('book issue UI has status and admin-only unassigned KPIs, filters, retry, focus restoration, and no contact fields', () => {
  const view = block('function viewBookIssues()', 'async function transitionBookIssue(');
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
  const view = block('function viewBookIssues()', 'async function transitionBookIssue(');
  const actions = block("case 'rosterretry':", "case 'onbadd':");
  assert.match(view, /const unassignedHtml = bookIssueUnassignedHtml\(unassigned\)/);
  assert.match(view, /if \(bookIssueError\)[\s\S]{0,420}\+ unassignedHtml/);
  assert.match(view, /unassigned === null[\s\S]{0,160}미배정 확인 불가/);
  assert.match(html, /최신 원생 명단을 확인하지 못해 이전 명단의 숫자를 표시하지 않습니다/);
  assert.match(actions, /case 'bookissuerefresh':[\s\S]{0,180}loadRoster\(\); loadBookIssues\(true\)/);
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
  assert.match(html, /if \(!session\.isAdmin\) return '<span class=\"small muted\">완료된 운행은 관리자만 되돌릴 수 있습니다/);
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
  const source = block('async function addTransportDriver(', 'function mutateTransportConfig(');
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

test('transport UI remains mobile accessible and excludes guardian PII', () => {
  const source = block('/* ── 차량 운행 ──', '/* ── 원생 현황');
  assert.match(html, /\.transport-route-grid \{ grid-template-columns: 1fr; \}/);
  assert.match(html, /\.transport-datebar \.btn \{ min-height: 44px; \}/);
  assert.match(source, /restoreTransportFocus/);
  assert.match(source, /학생 연락처와 주소는 표시하지 않습니다/);
  assert.doesNotMatch(source, /guardian|guardianPhone|보호자 전화|도로명|상세주소/);
});
