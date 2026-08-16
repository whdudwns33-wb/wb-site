const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const parentHtml = fs.readFileSync(path.join(__dirname, '..', 'parent', 'index.html'), 'utf8');

test('보호자 초대 링크는 Worker origin의 code-only fragment를 쓴다', () => {
  const start = html.indexOf('async function issueParentPortalInvite');
  const end = html.indexOf('async function saveGuardianPortalAccess', start);
  const source = html.slice(start, end);
  assert.match(source, /new URL\('\/', new URL\(SYNC_URL, location\.href\)\.origin\)/);
  assert.match(source, /link\.hash\s*=\s*new URLSearchParams\(\{ code: code \}\)\.toString\(\)/);
  assert.match(source, /\^\[a-f0-9\]\{48\}\$/);
  assert.doesNotMatch(source, /searchParams\.set\(['"]student/);
  assert.doesNotMatch(source, /searchParams\.set\(['"]code/);
  assert.doesNotMatch(source, /\.\.\/parent/);
});

test('보호자 웹앱 동의는 revision CAS로 저장하고 충돌 정본을 반영한다', () => {
  const start = html.indexOf('async function saveGuardianPortalAccess');
  const end = html.indexOf('function viewGuardianContactPanel', start);
  const source = html.slice(start, end);
  assert.match(source, /const expectedUpdatedAt\s*=\s*Number\(current && current\.updatedAt\) \|\| 0/);
  assert.match(source, /scopeVersion: GUARDIAN_PORTAL_SCOPE_VERSION, expectedUpdatedAt: expectedUpdatedAt/);
  assert.match(source, /ACCESS_REVISION_CONFLICT/);
  assert.match(source, /guardianPortalAccess\.set\(student\.id, error\.current\)/);
});

test('연락처 변경 후 웹앱 동의를 즉시 재검증하고 재동의 전에는 초대를 막는다', () => {
  const saveStart = html.indexOf('async function saveGuardianContact');
  const saveEnd = html.indexOf('async function saveGuardianOpsConsent', saveStart);
  const saveSource = html.slice(saveStart, saveEnd);
  assert.match(saveSource, /refreshGuardianPortalAccess\(auth\)/);

  const inviteStart = html.indexOf('async function issueParentPortalInvite');
  const inviteEnd = html.indexOf('async function saveGuardianPortalAccess', inviteStart);
  const inviteSource = html.slice(inviteStart, inviteEnd);
  assert.match(inviteSource, /access && access\.needsReconsent/);
  assert.match(html, /portal\.needsReconsent/);
  assert.match(html, /웹앱 재동의 필요/);
  assert.match(html, /보호자 앱 공개 동의 v2/);
  assert.match(html, /오늘 출결·수업 진행·차량 상태 공개 재동의 필요/);
});

test('관리자 미리보기는 기존 모달에서 공개 DTO만 읽고 보호자 연결을 만들지 않는다', () => {
  const start = html.indexOf('let parentPreviewRequest = 0');
  const end = html.indexOf('async function saveGuardianPortalAccess', start);
  const source = html.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(source, /if \(!session\.isAdmin\) return/);
  assert.match(source, /sync\.post\('\/parent-portal', \{\s*app: SYNC_APP, auth: auth, action: 'preview', studentId: student\.id\s*\}\)/);
  assert.ok(source.indexOf("modal(student.name + ' 보호자 화면 미리보기'") < source.indexOf("await sync.post('/parent-portal'"));
  assert.match(source, /requestId !== parentPreviewRequest \|\| \$\('#modalHost'\)\.hidden \|\| !\$\('#' \+ loadingId\)/);
  assert.match(source, /role="status"/);
  assert.match(source, /role="alert"/);
  assert.match(source, /실제 보호자 연결·동의·알림 발송은 만들지 않습니다/);
  assert.doesNotMatch(source, /window\.open|<iframe|localStorage|document\.cookie|canRespond|data-response/);
  assert.doesNotMatch(source, /guardianPhone|routeName|stopName|studentTraits|parentRequest|\baddress\b/);
});

test('미리보기 버튼은 연락처·동의와 무관하게 44px로 보이고 전용 동작을 호출한다', () => {
  const button = html.match(/<button[^>]+data-act="gcportalpreview"[^>]*>보호자 화면 미리보기<\/button>/);
  assert.ok(button);
  assert.match(button[0], /min-height:44px/);
  assert.doesNotMatch(button[0], /disabled/);
  assert.match(html, /case 'gcportalpreview': previewParentPortal\(el\.dataset\.idx, el\); break;/);
  assert.match(html, /\.modal-box \[data-act="closemodal"\] \{ min-width: 44px; min-height: 44px; \}/);
  assert.doesNotMatch(html, /<details class="row mt14"><summary><b>' \+ esc\(row\.feedbackDate/);
  assert.match(html, /\.parent-preview-text \{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;[^}]*line-height: 1\.65;/);
  assert.match(html, /class="parent-preview-usage"/);
  assert.match(html, /Number\(row\.total \|\| 0\)[\s\S]*<span>등록<\/span>/);
  assert.match(html, /Number\(summary\.makeupPending \|\| 0\)[\s\S]*<span>보강 확인<\/span>/);
  assert.match(html, /Number\(summary\.sessionRemaining \|\| 0\)[\s\S]*<span>남은 회차<\/span>/);
});

test('관리자 미리보기는 실제 보호자 화면과 같은 정보 순서와 시각 계약을 쓴다', () => {
  const start = html.indexOf('function parentPreviewHtml(data)');
  const end = html.indexOf('async function previewParentPortal', start);
  const source = html.slice(start, end);
  const factoryStart = html.indexOf('let parentPreviewRequest = 0');
  const parentPreviewHtml = new Function('esc', html.slice(factoryStart, end) + '; return parentPreviewHtml;')(String);
  const output = parentPreviewHtml({ capabilities: { today: true }, today: {}, summary: {}, student: {} });
  const labels = ['오늘 현황', '정규 수업 시간표', '확인·응답', '횟수제 수업', '최근 수업 기록'];
  labels.reduce((previous, label) => {
    const current = output.indexOf(label);
    assert.ok(current > previous, `${label} 미리보기 순서`);
    assert.match(parentHtml, new RegExp(label));
    return current;
  }, -1);
  assert.match(html, /\.parent-preview-shell \{ max-width: 560px/);
  assert.match(html, /\.modal:has\(\.parent-preview-shell\) \{ background: rgba\(17,40,61,\.88\); backdrop-filter: blur\(8px\); \}/);
  assert.match(html, /class="parent-preview-summary"/);
  assert.match(html, /class="parent-preview-day"/);
  assert.match(html, /parent-preview-tag ' \+ \(row\.status === 'confirmed' \? 'ok' : 'warn'\)/);
  assert.match(html, /parent-preview-info/);
  assert.match(html, /보호자 공개 v2/);
  assert.doesNotMatch(source, /data-response|참석 가능|일정 재조율/);
});

test('보호자 미리보기의 모든 서버 문자열은 HTML로 이스케이프한다', () => {
  const start = html.indexOf('let parentPreviewRequest = 0');
  const end = html.indexOf('async function saveGuardianPortalAccess', start);
  const source = html.slice(start, end);
  const escapeHtml = value => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const factory = new Function('esc', source + '; return { parentPreviewHtml };');
  const { parentPreviewHtml } = factory(escapeHtml);
  const attack = '<img src=x onerror=alert(1)>';
  const output = parentPreviewHtml({
    generatedAt: Date.now(), student: { name: attack, grade: attack },
    summary: { todayLessons: 1, todayCompleted: 0 },
    capabilities: { today: true },
    today: {
      dateLabel: attack,
      lessons: [{ subject: attack, teacherName: attack, timeLabel: attack, attendance: 'P', completedSteps: 1, totalSteps: 5 }],
      transport: [{ direction: 'pickup', scheduledTime: attack, status: 'scheduled' }]
    },
    schedule: [{ subject: attack, teacherName: attack, dayLabel: attack, timeLabel: attack }],
    makeups: [{ subject: attack, sourceDate: attack, statusLabel: attack }],
    sessionPacks: [{ subject: attack, validUntil: attack, remaining: 2 }],
    feedback: [{ feedbackDate: attack, statusLabel: attack, message: attack, teacherName: attack }]
  });
  assert.doesNotMatch(output, /<img\b/i);
  assert.match(output, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('미리보기의 정규 수업도 월요일부터 시간순으로 표시한다', () => {
  const start = html.indexOf('let parentPreviewRequest = 0');
  const end = html.indexOf('async function saveGuardianPortalAccess', start);
  const { parentPreviewHtml } = new Function('esc', html.slice(start, end) + '; return { parentPreviewHtml };')(String);
  const output = parentPreviewHtml({
    capabilities: { today: true }, today: {}, summary: {}, student: {},
    schedule: [
      { dayLabel: '토', subject: '토 수업', timeLabel: '10:00' },
      { dayLabel: '월', subject: '월 수업', timeLabel: '18:00' },
      { dayLabel: '월', subject: '월 오전', timeLabel: '09:00' }
    ]
  });
  assert.ok(output.indexOf('월 오전') < output.indexOf('월 수업'));
  assert.ok(output.indexOf('월 수업') < output.indexOf('토 수업'));
});

test('미리보기의 담당자 호칭과 모바일 기준은 실제 보호자 화면과 같다', () => {
  const start = html.indexOf('function parentPreviewTeacherLabel(value)');
  const end = html.indexOf('function parentPreviewHtml(data)', start);
  const label = new Function(html.slice(start, end) + '; return parentPreviewTeacherLabel;')();
  assert.equal(label('김동현'), '김동현 선생님');
  assert.equal(label('김동현 선생님'), '김동현 선생님');
  assert.equal(label(''), '담당 선생님');
  assert.match(html, /@media\(max-width:430px\) \{[\s\S]*\.parent-preview-summary/);
  assert.match(parentHtml, /@media\(max-width:430px\)\{\.summary-grid/);
});

test('미리보기의 상태 시각이 없으면 09:00으로 오표시하지 않는다', () => {
  const start = html.indexOf('let parentPreviewRequest = 0');
  const end = html.indexOf('async function saveGuardianPortalAccess', start);
  const factory = new Function('esc', html.slice(start, end) + '; return { parentPreviewClock };');
  const { parentPreviewClock } = factory(value => String(value == null ? '' : value));
  assert.equal(parentPreviewClock(null), '');
  assert.equal(parentPreviewClock(''), '');
  assert.equal(parentPreviewClock(0), '');
  assert.equal(parentPreviewClock('not-a-time'), '');
  assert.notEqual(parentPreviewClock(Date.now()), '');
});
