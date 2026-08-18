const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function slice(startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, `${startText} 구간을 찾을 수 있어야 한다`);
  return source.slice(start, end);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

test('보호자 공개 입력은 개인 링크의 오늘 본인 structured 수업에만 열린다', () => {
  const code = slice('function canEditGuardianPublication(', 'function normalizeGuardianPublication(');
  const permission = session => new Function('today', 'session', 'hasVerifiedPersonAuth', 'rosterDb', 'assignedLessonStudents', 'dowOf',
    `${code}\nreturn canEditGuardianPublication;`)(
      () => '2026-08-17', session, () => session.verified === true, {},
      () => [{ id: 'student-1' }], () => 1
    );
  const own = {
    id: 'lesson-1', studentId: 'student-1', staffId: 'teacher-1', lessonFormVersion: 1,
    taskKind: 'lesson_instruction', scheduleStatus: 'confirmed',
    scheduleSlots: [{ days: [1], startTime: '16:00', endTime: '17:00' }]
  };

  assert.equal(permission({ isStaffLink: true, isAdmin: false, staffId: 'teacher-1', verified: true })(own, '2026-08-17'), true);
  assert.equal(permission({ isStaffLink: true, isAdmin: true, staffId: 'teacher-1', verified: true })(own, '2026-08-17'), true,
    '관리 담당도 개인 링크에서 자기 수업만 입력할 수 있어야 한다');
  assert.equal(permission({ isStaffLink: false, isAdmin: true, staffId: '', verified: false })(own, '2026-08-17'), false);
  assert.equal(permission({ isStaffLink: true, isAdmin: false, staffId: 'teacher-2', verified: true })(own, '2026-08-17'), false);
  assert.equal(permission({ isStaffLink: true, isAdmin: false, staffId: 'teacher-1', verified: true })(own, '2026-08-16'), false);
  assert.equal(permission({ isStaffLink: true, isAdmin: false, staffId: 'teacher-1', verified: false })(own, '2026-08-17'), false);
  assert.equal(permission({ isStaffLink: true, isAdmin: false, staffId: 'teacher-1', verified: true })({ ...own, taskKind: '' }, '2026-08-17'), false);
  assert.equal(permission({ isStaffLink: true, isAdmin: false, staffId: 'teacher-1', verified: true })({ ...own, studentId: '' }, '2026-08-17'), false);
  assert.equal(permission({ isStaffLink: true, isAdmin: false, staffId: 'teacher-1', verified: true })({ ...own, scheduleStatus: 'needs_review' }, '2026-08-17'), false);
  assert.match(code, /task\.staffId !== session\.staffId/);
  assert.match(code, /task\.taskKind !== 'lesson_instruction'/);
  assert.match(code, /task\.scheduleStatus !== 'confirmed'/);
  assert.match(code, /assignedLessonStudents\(\)\.some/);
  assert.match(code, /task\.scheduleSlots\.some/);
});

test('숙제·준비물은 내부 메모 파싱 없이 전용 필드와 CAS API만 사용한다', () => {
  const block = slice('/* 보호자 공개 내용은', 'function acaflowLessonSummary(');
  const save = slice('async function saveGuardianPublication(', 'function acaflowLessonSummary(');
  assert.equal((block.match(/숙제 · 준비물 \(보호자 · 학생 공개\)/g) || []).length, 2);
  assert.doesNotMatch(block, /보호자·학생 공개 숙제·준비물/);
  assert.match(block, /data-public-homework/);
  assert.match(block, /data-public-readiness/);
  assert.match(block, /data-student-visible/);
  assert.match(block, /action: 'publication_list'/);
  assert.match(save, /action: 'publication_set'/);
  assert.match(save, /taskId: taskId, lessonDate: lessonDate/);
  assert.match(save, /publicHomework: homework, publicReadiness: readiness, published: published,[\s\S]*studentVisible: published && studentVisible/);
  assert.match(save, /expectedRevision: Number\(current\.revision\) \|\| 0/);
  assert.match(save, /error\.code === 'STALE_REVISION'/);
  assert.match(save, /guardianPublicationDrafts\.set/);
  assert.doesNotMatch(block, /c\.note|\.note\b|task\.homework|guardianPhone|phone:/);
  assert.match(source, /const GUARDIAN_PORTAL_SCOPE_VERSION = 4/);
});

test('공개 입력은 로딩·오류·escape 상태와 44px 모바일 조작을 제공한다', () => {
  const code = slice('function guardianPublicationHtml(', 'async function saveGuardianPublication(');
  const build = ({ loaded = false, loading = false, error = '', row = null } = {}) => {
    const loadedDates = new Set(loaded ? ['2026-08-17'] : []);
    const loadingDates = new Set(loading ? ['2026-08-17'] : []);
    const errors = new Map(error ? [['2026-08-17', error]] : []);
    const rows = new Map(row ? [['lesson-1|2026-08-17', row]] : []);
    return new Function('guardianPublicationKey', 'guardianPublicationLoadingDates', 'guardianPublicationLoadedDates',
      'guardianPublicationErrors', 'guardianPublicationDrafts', 'guardianPublicationSaving', 'guardianLessonPublications',
      'setTimeout', 'loadGuardianPublications', 'esc', 'studentSelfCheckReviewHtml', `${code}\nreturn guardianPublicationHtml;`)(
        (taskId, date) => `${taskId}|${date}`, loadingDates, loadedDates, errors, new Map(), new Set(), rows,
        () => {}, () => {}, escapeHtml, () => ''
      )({ id: 'lesson-1' }, '2026-08-17');
  };

  assert.match(build({ loading: true }), /role="status"[\s\S]*불러오는 중/);
  assert.match(build({ error: '실패 <img>' }), /role="alert"[\s\S]*다시 불러오기/);
  const attack = '<img src=x onerror=alert(1)>';
  const html = build({ loaded: true, row: {
    status: 'published', revision: 2, publicHomework: attack, publicReadiness: attack
  } });
  assert.doesNotMatch(html, /<img\b/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(source, /\.guardian-publication \.btn, \.guardian-publication-retry \{ min-height: 44px; \}/);
  assert.match(source, /@media \(max-width: 600px\) \{[\s\S]*\.guardian-publication-head \{ display: block; \}/);
});

test('보호자 요청은 관리자 범위에서 safe enum과 CAS 종료만 제공한다', () => {
  const normalizeCode = slice('const GUARDIAN_REQUEST_TYPE_LABELS', 'async function loadGuardianRequests(');
  const { normalizeGuardianRequest, typeLabels, statusLabels } = new Function(
    `${normalizeCode}\nreturn { normalizeGuardianRequest, typeLabels: GUARDIAN_REQUEST_TYPE_LABELS, statusLabels: GUARDIAN_REQUEST_STATUS_LABELS };`
  )();
  const unknown = normalizeGuardianRequest({ requestId: 'req-1', studentName: '학생', requestType: '<img>', status: 'server_html', revision: 1 });
  assert.equal(unknown.requestType, '');
  assert.equal(unknown.status, '');
  assert.deepEqual(Object.keys(typeLabels), ['consultation', 'schedule_check', 'info_correction']);
  assert.deepEqual(Object.keys(statusLabels), ['open', 'resolved', 'dismissed']);

  const block = slice('async function loadGuardianRequests(', 'function managerRequestInboxRows(');
  assert.match(block, /if \(!session\.isAdmin/);
  assert.match(block, /action: 'request_list'/);
  assert.match(block, /status: 'open'/);
  assert.match(block, /action: 'request_resolve'/);
  assert.match(block, /\['resolved', 'dismissed'\]\.includes\(resolution\)/);
  assert.match(block, /expectedRevision: Number\(expectedRevision\)/);
  assert.match(block, /error\.code === 'STALE_REVISION'/);
  assert.match(block, /보호자에게 필요한 처리를 마쳤으며 이 요청을 처리 완료로 표시할까요\?/);
  assert.match(block, /이 요청을 별도 처리 없이 확인 종료할까요\?/);
  assert.match(block, /if \(!confirm\(confirmation\)\) return;/);
  assert.doesNotMatch(block, /guardianPhone|phone:|rosterDb|parentRequest/);
  assert.match(source, /\.manager-guardian-actions \.btn \{ min-height: 44px; \}/);
  assert.match(source, /@media \(max-width: 600px\) \{[\s\S]*\.manager-guardian-actions \{ display: grid;/);
  assert.match(source, /guardianRequestsError = '보호자 요청을 불러오지 못했습니다\.'/);
  assert.match(source, /esc\(row\.title\)[\s\S]*esc\(row\.requester\)[\s\S]*esc\(row\.detail\)/);
});

test('인라인 앱 스크립트는 문법 오류 없이 파싱된다', () => {
  const start = source.indexOf('<script>', source.indexOf('acaflow-import-core'));
  const end = source.indexOf('</script>', start);
  assert.ok(start > 0 && end > start);
  assert.doesNotThrow(() => new Function(source.slice(start + '<script>'.length, end)));
});
