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

test('학생 앱 설정은 관리자 인증과 전용 API에서만 불러온다', () => {
  const code = slice('async function loadStudentPortalAccess(', 'async function loadGuardianContacts(');
  assert.match(code, /if \(!session\.isAdmin/);
  assert.match(code, /sync\.auth\(\)/);
  assert.match(code, /sync\.post\('\/student-portal'/);
  assert.match(code, /action: 'access_list'/);
  assert.match(code, /action: 'access_set'/);
  assert.match(code, /action: 'invite'/);
  assert.doesNotMatch(code, /guardianPhone|phone:|address|localStorage|document\.cookie/);
});

test('학생 앱 활성화는 보호자 연락처와 명시적 공개 동의를 확인한다', () => {
  const code = slice('async function saveStudentPortalAccess(', 'async function issueStudentPortalInvite(');
  assert.match(code, /guardianContacts && guardianContacts\.get\(student\.id\)/);
  assert.match(code, /먼저 위에서 보호자 연락처를 저장해 주세요/);
  assert.match(code, /오늘 수업·출결·5단계·차량, 공개 숙제·준비물, 배정 교재, 주간 시간표/);
  assert.match(code, /consentConfirmed: enabled/);
  assert.match(code, /expectedUpdatedAt: Number\(current\.updatedAt\) \|\| 0/);
  assert.match(code, /ACCESS_REVISION_CONFLICT/);
  assert.match(code, /checkbox\.checked = !!current\.enabled/);
});

test('초대 링크는 서버가 확정한 별도 HTTPS origin의 code fragment만 쓴다', () => {
  const code = slice('async function issueStudentPortalInvite(', 'async function loadGuardianContacts(');
  assert.match(code, /new URL\(String\(result\.baseUrl \|\| ''\)\)/);
  assert.match(code, /baseUrl\.protocol !== 'https:'/);
  assert.match(code, /baseUrl\.pathname !== '\/'/);
  assert.match(code, /baseUrl\.search \|\| baseUrl\.hash \|\| baseUrl\.username \|\| baseUrl\.password/);
  assert.match(code, /baseUrl\.hash = new URLSearchParams\(\{ code: code \}\)\.toString\(\)/);
  assert.match(code, /\^\[a-f0-9\]\{48\}\$/);
  assert.doesNotMatch(code, /searchParams\.set|localStorage|sessionStorage|window\.open/);
});

test('설정 화면은 보호자 앱과 분리된 학생 앱 동의·초대·미리보기를 제공한다', () => {
  const panel = slice('function viewStudentPortalPanel(', '/* ── 설정 ── */');
  assert.match(panel, /학생 앱 이용·초대/);
  assert.match(panel, /학생 앱은 보호자 앱과 분리된 읽기 전용 화면/);
  assert.match(panel, /학생 앱에도 공개/);
  assert.match(panel, /보호자 연락처·주소·정류장·내부 메모·보호자 요청·보강·회차·공지·주문 정보는 표시하지 않습니다/);
  assert.match(panel, /data-act="studentportalaccess"/);
  assert.match(panel, /data-act="studentportalinvite"/);
  assert.match(panel, /data-act="studentportalpreview"/);
  assert.match(panel, /min-height:44px/);
  assert.match(source, /viewGuardianContactPanel\(\) \+ viewStudentPortalPanel\(\)/);
  assert.match(source, /viewGuardianContactPanel\(\) \+[\s\S]*viewStudentPortalPanel\(\);/);
});

test('학생 미리보기는 실제 학생 공개 DTO의 읽기 전용 영역만 escape해 표시한다', () => {
  const code = slice('let studentPreviewRequest = 0', 'async function saveGuardianPortalAccess(');
  assert.match(code, /action: 'preview', studentId: student\.id/);
  assert.match(code, /관리자 미리보기 · 학생 공개 v1/);
  assert.match(code, /오늘 수업/);
  assert.match(code, /오늘 차량/);
  assert.match(code, /숙제·준비물/);
  assert.match(code, /최근 공개 숙제·준비물/);
  assert.match(code, /최근 14일 공개 기록이 없습니다/);
  assert.match(code, /<span>공개 기록<\/span>/);
  assert.match(code, /교재 준비·수령/);
  assert.match(code, /주간 시간표/);
  assert.match(code, /filter\(row => row && row\.kind === 'distribution'\)/);
  assert.match(code, /String\(row\.publicHomework \|\| ''\)/);
  assert.match(code, /String\(row\.publicReadiness \|\| ''\)/);
  assert.match(code, /esc\(homework\)/);
  assert.match(code, /esc\(readiness\)/);
  assert.match(code, /esc\(row\.scheduledTime/);
  assert.match(code, /class="student-preview-steps" aria-label="5단계 중/);
  assert.match(code, /수업 완료' : '진행 중'/);
  assert.match(code, /class="parent-preview-shell student-preview-shell"/);
  assert.doesNotMatch(code, /data-response|submit_request|guardianRequests|makeups|sessionPacks|announcements|feedback|routeName|stopName|guardianPhone|\baddress\b/);
});

test('학생 앱 관리 버튼은 전용 click action에 연결된다', () => {
  assert.match(source, /case 'studentportalrefresh': studentPortalLoaded = false; loadStudentPortalAccess\(true\); break;/);
  assert.match(source, /case 'studentportalaccess': saveStudentPortalAccess\(el\.dataset\.idx, el\); break;/);
  assert.match(source, /case 'studentportalinvite': issueStudentPortalInvite\(el\.dataset\.idx, el\); break;/);
  assert.match(source, /case 'studentportalpreview': previewStudentPortal\(el\.dataset\.idx, el\); break;/);
  assert.match(source, /\.student-portal-settings button, \.student-portal-settings label \{ min-height: 44px; \}/);
  assert.match(source, /\.student-preview-shell \.parent-preview-summary \{ grid-template-columns: repeat\(3,minmax\(0,1fr\)\); \}/);
  assert.match(source, /@media\(max-width:350px\) \{[\s\S]*\.student-preview-shell \.parent-preview-summary \{ grid-template-columns: 1fr; \}/);
});

test('인라인 앱 스크립트는 문법 오류 없이 파싱된다', () => {
  const start = source.indexOf('<script>', source.indexOf('acaflow-import-core'));
  const end = source.indexOf('</script>', start);
  assert.ok(start > 0 && end > start);
  assert.doesNotThrow(() => new Function(source.slice(start + '<script>'.length, end)));
});
