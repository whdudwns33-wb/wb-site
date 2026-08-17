const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const studentHtml = fs.readFileSync(path.join(__dirname, '..', 'student', 'index.html'), 'utf8');

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
  assert.match(code, /학생 앱 공개 범위 v2/);
  assert.match(code, /메타수학·클래스카드 공식 외부 화면 이동/);
  assert.match(code, /기기 정보·접속 기록·서비스 쿠키를 처리할 수 있습니다/);
  assert.match(code, /WB는 외부 아이디·비밀번호·학습 결과를 받거나 저장하지 않습니다/);
  assert.match(source, /const STUDENT_PORTAL_SCOPE_VERSION = 2;/);
  assert.match(code, /consentConfirmed: enabled/);
  assert.match(code, /scopeVersion: STUDENT_PORTAL_SCOPE_VERSION/);
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
  assert.match(panel, /학생 앱 이용 동의 v2/);
  assert.match(panel, /메타수학·클래스카드 공식 외부 학습 화면 링크/);
  assert.match(panel, /기기 정보·접속 기록·서비스 쿠키를 처리할 수 있습니다/);
  assert.match(panel, /외부 서비스 이동·처리 내용을 안내해 동의를 확인/);
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
  assert.match(code, /관리자 미리보기 · 학생 공개 v2/);
  assert.match(code, /오늘 수업/);
  assert.match(code, /오늘 차량/);
  assert.match(code, /숙제·준비물/);
  assert.match(code, /최근 공개 숙제·준비물/);
  assert.match(code, /data\.capabilities\.externalLearning === true/);
  assert.match(code, /const studySection = externalLearningEnabled/);
  assert.match(code, /https:\/\/new\.mmath\.co\.kr\/Pages\/student\//);
  assert.match(code, /https:\/\/www\.classcard\.net\/Login/);
  assert.equal((code.match(/target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"/g) || []).length, 2);
  assert.match(code, /외부 아이디·비밀번호·학습 결과를 받거나 저장하지 않습니다/);
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

test('Study 카드는 scope v2 capability에서만 실제 화면과 같은 안전 링크로 보인다', () => {
  const code = slice('function studentPreviewHtml(', 'async function previewStudentPortal(');
  const escapeHtml = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
  const preview = new Function('esc', 'parentPreviewTeacherLabel', 'parentPreviewClock', 'parentPreviewStamp',
    'parentPreviewGroup', 'parentPreviewSection', code + ';return studentPreviewHtml;')(
    escapeHtml, String, () => '', () => '',
    (title, rows, empty) => title + (rows.length ? rows.join('') : empty),
    (kicker, title, rows, empty) => kicker + title + (rows.length ? rows.join('') : empty)
  );
  const payload = { today: { lessons: [], transport: [] }, publicLessons: [], bookStatus: [], schedule: [] };
  const v1 = preview({ ...payload, scopeVersion: 1, capabilities: {} });
  const v2WithoutCapability = preview({ ...payload, scopeVersion: 2, capabilities: {} });
  const hidden = preview({ ...payload, capabilities: { externalLearning: false } });
  const wrongType = preview({ ...payload, capabilities: { externalLearning: 'true' } });
  const visible = preview({ ...payload, scopeVersion: 2, capabilities: { externalLearning: true } });
  assert.doesNotMatch(v1 + v2WithoutCapability + hidden + wrongType, /바로 학습하기|new\.mmath|classcard\.net/);
  assert.match(visible, /바로 학습하기/);
  assert.ok(visible.indexOf('https://new.mmath.co.kr/Pages/student/') < visible.indexOf('https://www.classcard.net/Login'));
  assert.equal((visible.match(/target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"/g) || []).length, 2);
  assert.equal((visible.match(/새 창\/탭에서 열림/g) || []).length, 2);
});

test('학생 미리보기는 동적 값을 escape하고 외부 학습을 iframe이나 fetch로 불러오지 않는다', () => {
  const code = slice('function studentPreviewHtml(', 'async function previewStudentPortal(');
  const escapeHtml = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
  const preview = new Function('esc', 'parentPreviewTeacherLabel', 'parentPreviewClock', 'parentPreviewStamp',
    'parentPreviewGroup', 'parentPreviewSection', code + ';return studentPreviewHtml;')(
    escapeHtml, String, String, String,
    (title, rows, empty) => title + (rows.length ? rows.join('') : empty),
    (kicker, title, rows, empty) => kicker + title + (rows.length ? rows.join('') : empty)
  );
  const attack = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const rendered = preview({
    student: { name: attack, grade: attack }, generatedAt: attack,
    capabilities: { externalLearning: true },
    today: {
      dateLabel: attack,
      lessons: [{ subject: attack, teacherName: attack, timeLabel: attack }],
      transport: [{ scheduledTime: attack, statusAt: attack }]
    },
    publicLessons: [{ subject: attack, lessonDate: attack, teacherName: attack, publicHomework: attack, publicReadiness: attack }],
    bookStatus: [{ kind: 'distribution', title: attack, updatedAt: attack, label: attack }],
    schedule: [{ dayLabel: attack, subject: attack, teacherName: attack, timeLabel: attack }]
  });
  assert.doesNotMatch(rendered, /<img|<script|javascript:/i);
  assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(code, /<iframe\b|\bfetch\s*\(/i);
  assert.equal((rendered.match(/href="https:\/\//g) || []).length, 2);
});

test('실제 화면과 미리보기는 외부 서비스 URL·순서·개인정보 안내가 같다', () => {
  const previewCode = slice('function studentPreviewHtml(', 'async function previewStudentPortal(');
  const notice = '링크를 누르면 새 창/탭에서 외부 서비스로 이동합니다. 해당 서비스가 기기 정보·접속 기록·서비스 쿠키를 처리할 수 있습니다. WB는 외부 아이디·비밀번호·학습 결과를 받거나 저장하지 않습니다.';
  for (const text of [studentHtml, previewCode]) {
    assert.ok(text.indexOf('https://new.mmath.co.kr/Pages/student/') < text.indexOf('https://www.classcard.net/Login'));
    assert.equal((text.match(/target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"/g) || []).length, 2);
    assert.equal((text.match(/새 창\/탭에서 열림/g) || []).length, 2);
    assert.match(text, new RegExp(notice.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(studentHtml, /a:focus-visible/);
  assert.match(studentHtml, /outline:3px solid #087ba6;outline-offset:2px/);
  assert.match(source, /\.student-preview-study-link:focus-visible \{ outline: 3px solid #087BA6; outline-offset: 2px; \}/);
  assert.match(studentHtml, /\.study-link\{display:flex;min-height:72px/);
  assert.match(source, /\.student-preview-study-link \{ display: flex; min-height: 72px/);
});

test('실제 화면과 미리보기의 포커스 표시는 밝은 카드 배경에서 3대1 이상 대비다', () => {
  function luminance(hex) {
    const channels = hex.match(/[\da-f]{2}/gi).map(value => parseInt(value, 16) / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }
  function contrast(left, right) {
    const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
    return (values[0] + 0.05) / (values[1] + 0.05);
  }
  for (const background of ['ffffff', 'f5fbfe']) assert.ok(contrast('087ba6', background) >= 3);
});

test('학생 앱 관리 버튼은 전용 click action에 연결된다', () => {
  assert.match(source, /case 'studentportalrefresh': studentPortalLoaded = false; loadStudentPortalAccess\(true\); break;/);
  assert.match(source, /case 'studentportalaccess': saveStudentPortalAccess\(el\.dataset\.idx, el\); break;/);
  assert.match(source, /case 'studentportalinvite': issueStudentPortalInvite\(el\.dataset\.idx, el\); break;/);
  assert.match(source, /case 'studentportalpreview': previewStudentPortal\(el\.dataset\.idx, el\); break;/);
  assert.match(source, /\.student-portal-settings button, \.student-portal-settings label \{ min-height: 44px; \}/);
  assert.match(source, /\.student-preview-shell \.parent-preview-summary \{ grid-template-columns: repeat\(3,minmax\(0,1fr\)\); \}/);
  assert.match(source, /\.student-preview-study-link \{ display: flex; min-height: 72px;/);
  assert.match(source, /@media\(max-width:350px\) \{[\s\S]*\.student-preview-shell \.parent-preview-summary, \.student-preview-study-grid \{ grid-template-columns: 1fr; \}/);
});

test('인라인 앱 스크립트는 문법 오류 없이 파싱된다', () => {
  const start = source.indexOf('<script>', source.indexOf('acaflow-import-core'));
  const end = source.indexOf('</script>', start);
  assert.ok(start > 0 && end > start);
  assert.doesNotThrow(() => new Function(source.slice(start + '<script>'.length, end)));
});
