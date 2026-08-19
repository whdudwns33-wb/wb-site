const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const taskHtml = fs.readFileSync(path.join(__dirname, '..', 'task', 'index.html'), 'utf8');
const headers = fs.readFileSync(path.join(__dirname, '_headers'), 'utf8');
const wrangler = fs.readFileSync(path.join(__dirname, '..', 'sync', 'wrangler.toml'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.webmanifest'), 'utf8'));

test('보호자 앱은 직원 앱과 분리된 모바일 웹앱이다', () => {
  assert.match(html, /WB 보호자/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /rel="manifest"/);
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.scope, './');
  assert.doesNotMatch(html, /serviceWorker|caches\.open|wb_taskboard/);
});

test('초대 코드는 fragment에서 즉시 지우고 HttpOnly 쿠키 세션만 쓴다', () => {
  assert.match(html, /new URLSearchParams\(location\.hash/);
  assert.match(html, /history\.replaceState\(null,'',location\.pathname\+location\.search\);try\{await post\(\{action:'exchange',code\}\)/);
  assert.match(html, /credentials:'include'/);
  assert.match(html, /const API='\/parent-portal'/);
  assert.doesNotMatch(html, /localStorage|sessionToken|searchParams\.get\('code'\)|studentId,code/);
});

test('보호자에게는 정형 보강 응답만 제공한다', () => {
  assert.match(html, /data-response="accept"/);
  assert.match(html, /data-response="decline"/);
  assert.match(html, /action:'respond'/);
  assert.doesNotMatch(html, /type="tel"|전화번호 입력|상담 메모|studentTraits|parentRequest/);
});

test('오늘 우리 아이는 v2 capability에서만 최소 수업·차량 상태를 읽기 전용 표시한다', () => {
  assert.match(html, /capabilities\.today===true/);
  assert.match(html, /오늘 수업/);
  assert.match(html, /오늘 차량/);
  assert.match(html, /출결 확인 전/);
  assert.match(html, /E:\['조퇴','warn'\]/);
  assert.match(html, /탑승 확인 전/);
  assert.match(html, /하차 확인/);
  assert.doesNotMatch(html, /하차·인계 완료|안전 귀가|실시간 위치/);
  assert.match(html, /timeZone:'Asia\/Seoul'/);
  assert.match(html, /내부 수업 메모, 정류장·주소, 연락처와 주문 업체 정보는 표시하지 않습니다/);
  assert.doesNotMatch(html, /row\.routeName|row\.stopName|row\.address|row\.guardianPhone/);
});

test('공개 숙제와 준비물은 v3 전용 최신 목록 한 곳에만 안전하게 표시된다', () => {
  const escapeHtml = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
  const detailsStart = html.indexOf('function publicLessonDetails');
  const detailsEnd = html.indexOf('function todayLessonRows', detailsStart);
  const lessonDateLabel = value => value === '2026-08-16' ? '8월 16일 안내' : '최근 수업 안내';
  const publicLessonDetails = new Function('esc', 'lessonDateLabel',
    html.slice(detailsStart, detailsEnd) + '; return publicLessonDetails;')(escapeHtml, lessonDateLabel);
  const rowsStart = detailsEnd;
  const rowsEnd = html.indexOf('function todayTransportRows', rowsStart);
  const [todayLessonRows, publicLessonRows] = new Function('ATTENDANCE', 'esc', 'teacherLabel', 'publicLessonDetails', 'lessonDateLabel',
    html.slice(rowsStart, rowsEnd) + '; return [todayLessonRows,publicLessonRows];')(
    { P: ['출석', 'ok'], '': ['출결 확인 전', 'muted'] }, escapeHtml, value => value, publicLessonDetails, lessonDateLabel
  );
  const lessons = [{ lessonRef: 'public-ref-a', subject: '영어', teacherName: '담당', attendance: 'P' }];
  const publications = [
    { lessonRef: 'public-ref-a', lessonDate: '2026-08-16', subject: '영어', teacherName: '담당', publicHomework: '<b>2쪽</b>', publicReadiness: '연필 & 지우개' },
    { lessonRef: 'wrong-ref', lessonDate: '2026-08-17', subject: '수학', teacherName: '다른 담당', publicHomework: '다른 수업 비공개' }
  ];
  const output = todayLessonRows(lessons).join('');
  assert.doesNotMatch(output, /lesson-public|숙제|준비물|2쪽/);
  const latest = publicLessonRows(publications).join('');
  assert.match(latest, /영어/);
  assert.match(latest, /수학/);
  assert.match(latest, /&lt;b&gt;2쪽&lt;\/b&gt;/);
  assert.match(latest, /연필 &amp; 지우개/);
  assert.doesNotMatch(latest, /<b>2쪽<\/b>/);
  assert.match(html, /section\('Learning','숙제·준비물',publicLessonRows\(data\.publicLessons\)/);
  assert.match(html, /capability\(capabilities,'publicLessons'\)/);
});

test('보호자 요청은 scope v3의 guardianRequests capability에서만 세 가지 enum과 처리 이력을 보여준다', () => {
  const start = html.indexOf('function requestRows');
  const end = html.indexOf('function render(data)', start);
  const requestTypes = { consultation: '상담 요청', schedule_check: '일정 확인', info_correction: '정보 수정 요청' };
  const requestStatus = { open: ['처리 중', 'warn'], resolved: ['처리 완료', 'ok'], dismissed: ['확인 종료', 'muted'] };
  const capability = (capabilities, name) => !!capabilities && capabilities[name] === true && Number(capabilities.scopeVersion || 0) >= 3;
  const [requestRows, requestSection] = new Function('REQUEST_TYPES', 'REQUEST_STATUS', 'stamp', 'esc', 'capability',
    html.slice(start, end) + '; return [requestRows,requestSection];')(
    requestTypes, requestStatus, value => String(value || ''), String, capability
  );
  const history = [
    { requestType: 'consultation', status: 'open', createdAt: 1, updatedAt: 1 },
    { requestType: 'schedule_check', status: 'resolved', createdAt: 2, updatedAt: 3 },
    { requestType: 'not_allowed', status: 'open', createdAt: 4, updatedAt: 4 }
  ];
  assert.equal(requestSection({ guardianRequests: true, scopeVersion: 2 }, history), '');
  assert.equal(requestSection({ guardianRequests: false, scopeVersion: 3 }, history), '');
  const output = requestSection({ guardianRequests: true, scopeVersion: 3 }, history);
  assert.match(output, /data-request-type="consultation"/);
  assert.match(output, /data-request-type="schedule_check"/);
  assert.match(output, /data-request-type="info_correction"/);
  assert.match(output, /상담 요청 접수됨/);
  assert.match(output, /처리 중/);
  assert.match(output, /처리 완료/);
  assert.doesNotMatch(output, /not_allowed|<input|<textarea|type="file"|contenteditable/);
  assert.equal(requestRows(history).length, 2);
});

test('보호자 요청 제출은 확인 후 정형 enum과 재사용 가능한 멱등 키만 전송한다', () => {
  const start = html.indexOf('async function submitGuardianRequest');
  const end = html.indexOf('async function boot', start);
  const source = html.slice(start, end);
  assert.match(source, /window\.confirm/);
  assert.match(source, /pendingRequestIds\.get\(requestType\)/);
  assert.match(source, /pendingRequestIds\.set\(requestType,clientRequestId\)/);
  assert.match(source, /post\(\{action:'submit_request',requestType,clientRequestId\}\)/);
  assert.doesNotMatch(source, /studentId|lessonId|freeText|phone|attachment|FormData/);
  assert.match(html, /crypto\.getRandomValues\(new Uint8Array\(16\)\)/);
  assert.match(html, /id="requestMessage"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /setAttribute\('role',isError\?'alert':'status'\)/);
});

test('학원 공지와 교재 상태는 scope v4에서만 안전한 공개 필드로 표시한다', () => {
  assert.match(html, /const PHASE3_SCOPE_VERSION=4/);
  assert.match(html, /capability\(capabilities,'announcements',PHASE3_SCOPE_VERSION\)/);
  assert.match(html, /capability\(capabilities,'bookStatus',PHASE3_SCOPE_VERSION\)/);
  const start = html.indexOf('function announcementRows');
  const end = html.indexOf('function render(data)', start);
  const [announcementRows, bookStatusRows] = new Function('esc', 'stamp',
    html.slice(start, end) + '; return [announcementRows,bookStatusRows];')(
    value => String(value).replace(/</g, '&lt;').replace(/>/g, '&gt;'), value => String(value || '')
  );
  const attack = '<img src=x onerror=alert(1)>';
  const notice = announcementRows([{ title: attack, body: attack, publishDate: '2026-08-17', expiresDate: '2026-08-20' }]).join('');
  const book = bookStatusRows([{ kind: 'distribution', title: attack, stage: 'handed', label: attack, updatedAt: 1 }]).join('');
  assert.doesNotMatch(notice + book, /<img\b/);
  assert.match(notice + book, /&lt;img/);
  assert.doesNotMatch(notice + book, /studentId|bookId|taskId|assignmentId|vendor|provider|updatedBy/);
});

test('보호자 화면은 공지, 오늘, 학습, 교재, 시간표, 응답, 이용 현황, 기록 순서로 읽힌다', () => {
  const start = html.indexOf('function render(data)');
  const end = html.indexOf('function fail(', start);
  const source = html.slice(start, end);
  const assembly = source.slice(source.indexOf('app.innerHTML='));
  const tokens = ['+announcementSection+', '+todaySections+', '+publicLessonSection+', '+bookStatusSection+',
    "section('Schedule','정규 수업 시간표'", "section('Action','확인·응답'", "section('Usage','횟수제 수업'", "section('Record','최근 수업 기록'"];
  tokens.reduce((previous, token) => {
    const current = assembly.indexOf(token);
    assert.ok(current > previous, `${token} 순서`);
    return current;
  }, -1);
  assert.match(html, /class="summary-grid"/);
  assert.match(html, /class="day-badge"/);
  assert.match(html, /class="card info"/);
  assert.match(html, /\.btn\{min-height:48px/);
  assert.match(html, /@media\(max-width:430px\)\{\.summary-grid\{grid-template-columns:repeat\(2/);
});

test('주간 시간표는 서버 배열 순서와 무관하게 월요일부터 정렬한다', () => {
  const start = html.indexOf("const DAY_ORDER='월화수목금토일'");
  const end = html.indexOf('function makeupRows', start);
  const scheduleRows = new Function('esc', html.slice(start, end) + '; return scheduleRows;')(String);
  const output = scheduleRows([
    { dayLabel: '토', subject: '토 수업', timeLabel: '10:00' },
    { dayLabel: '월', subject: '월 수업', timeLabel: '18:00' },
    { dayLabel: '월', subject: '월 오전', timeLabel: '09:00' }
  ]).join('');
  assert.ok(output.indexOf('월 오전') < output.indexOf('월 수업'));
  assert.ok(output.indexOf('월 수업') < output.indexOf('토 수업'));
});

test('담당자 이름에는 선생님 호칭을 한 번만 붙인다', () => {
  const start = html.indexOf('function teacherLabel(value)');
  const end = html.indexOf('function todayLessonRows', start);
  const teacherLabel = new Function(html.slice(start, end) + '; return teacherLabel;')();
  assert.equal(teacherLabel('김동현'), '김동현 선생님');
  assert.equal(teacherLabel('김동현 선생님'), '김동현 선생님');
  assert.equal(teacherLabel(''), '담당 선생님');
});

test('상태 시각이 없는 차량은 자정 epoch 시간을 표시하지 않는다', () => {
  const start = html.indexOf('function clock(value)');
  const end = html.indexOf('function todayLessonRows', start);
  const clock = new Function(html.slice(start, end) + '; return clock;')();
  assert.equal(clock(null), '');
  assert.equal(clock(''), '');
  assert.equal(clock(0), '');
  assert.equal(clock('not-a-time'), '');
  assert.notEqual(clock(Date.now()), '');
});

test('설치된 화면은 복귀·포커스·버튼에서 새로 읽고 마지막 확인 시각을 표시한다', () => {
  assert.match(html, /id="refreshButton"/);
  assert.match(html, /마지막 확인/);
  assert.match(html, /visibilitychange/);
  assert.match(html, /window\.addEventListener\('focus'/);
  assert.match(html, /refreshButton\.addEventListener\('click',\(\)=>refresh\(true\)\)/);
  assert.match(html, /if\(refreshing\|\|\(!force&&Date\.now\(\)-lastRefreshAt<1000\)\)return/);
});

test('새로고침은 화면 전체가 아니라 별도 상태 영역만 알린다', () => {
  assert.doesNotMatch(html, /<main id="app" aria-live=/);
  assert.match(html, /id="liveStatus" class="sr" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(html, /liveStatus\.textContent='보호자 정보 새로고침 완료'/);
});

test('출력은 escape하고 인증 오류 시 보호자 화면을 닫는다', () => {
  assert.match(html, /const esc=/);
  assert.match(html, /error\.status===401\|\|error\.status===410/);
  assert.match(html, /if\(clear\)\{logout\.hidden=true;refreshButton\.hidden=true\}/);
  assert.doesNotMatch(html, /localStorage|sessionStorage/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /\.focus\(\)/);
});

test('직원 앱은 알림톡과 별도 웹앱 동의를 받고 1회 초대 링크만 복사한다', () => {
  assert.match(taskHtml, /action: 'access_set'/);
  assert.match(taskHtml, /웹앱 동의/);
  assert.match(taskHtml, /action: 'invite', studentId: student\.id/);
  assert.doesNotMatch(taskHtml, /state\.settings\.(?:parent|guardian).*code/i);
});

test('보호자 정적 자산은 Worker 별도 origin과 실제 응답 보안 헤더를 사용한다', () => {
  assert.match(wrangler, /\[assets\][\s\S]*directory\s*=\s*"\.\.\/parent"/);
  assert.match(wrangler, /binding\s*=\s*"ASSETS"/);
  assert.match(wrangler, /run_worker_first\s*=\s*true/);
  assert.match(headers, /frame-ancestors 'none'/);
  assert.match(headers, /X-Frame-Options:\s*DENY/);
  assert.match(headers, /Referrer-Policy:\s*no-referrer/);
  assert.match(headers, /X-Content-Type-Options:\s*nosniff/);
  assert.match(headers, /X-Robots-Tag:\s*noindex/);
  assert.match(headers, /Cache-Control:\s*no-store/);
});
