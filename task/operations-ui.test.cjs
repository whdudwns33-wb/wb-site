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

test('book issue UI has four KPIs, filters, retry, keyboard focus restoration, and no contact fields', () => {
  const view = block('function viewBookIssues()', 'async function transitionBookIssue(');
  const whole = block('/* ── 학생별 교재 출고·인계 ──', 'function viewBooks()');
  assert.match(view, /미출고/);
  assert.match(view, /출고 후 1일\+ 미수령/);
  assert.match(view, /오늘 출고/);
  assert.match(view, /인계 완료/);
  assert.match(view, /data-book-issue-search/);
  assert.match(view, /bookissuerefresh/);
  assert.match(whole, /restoreBookIssueFocus/);
  assert.match(whole, /min-height: 44px|ops-actions/);
  assert.doesNotMatch(whole, /type=\"tel\"|data-(?:phone|address)|guardianPhone/);
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
  assert.match(html, /startTime: String\(\(row\.querySelector\('\[data-tc-route-time\]'\)/);
  assert.match(html, /active: !!\(row\.querySelector\('\[data-tc-active\]'\)/);
  assert.match(html, /student\.stop && typeof student\.stop === 'object'/);
  assert.match(html, /driverId=active staffId|기사.*현재 직원/);
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

test('transport UI remains mobile accessible and excludes guardian PII', () => {
  const source = block('/* ── 차량 운행 ──', '/* ── 원생 현황');
  assert.match(html, /\.transport-route-grid \{ grid-template-columns: 1fr; \}/);
  assert.match(html, /\.transport-datebar \.btn \{ min-height: 44px; \}/);
  assert.match(source, /restoreTransportFocus/);
  assert.match(source, /학생 연락처와 주소는 표시하지 않습니다/);
  assert.doesNotMatch(source, /guardian|guardianPhone|보호자 전화|도로명|상세주소/);
});
