const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.webmanifest'), 'utf8'));
const headers = fs.readFileSync(path.join(__dirname, '_headers'), 'utf8');
const assetsIgnore = fs.readFileSync(path.join(__dirname, '.assetsignore'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

test('학생 앱 inline JavaScript가 파싱된다', () => {
  assert.doesNotThrow(() => new Function(script));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.lang, 'ko-KR');
  assert.match(manifest.description, /학생용/);
});

test('학생 전용 endpoint와 HttpOnly 쿠키 세션만 사용한다', () => {
  assert.match(html, /const API='\/student-portal'/);
  assert.match(html, /credentials:'include'/);
  assert.match(html, /new URLSearchParams\(location\.hash/);
  assert.match(html, /history\.replaceState\(null,'',location\.pathname\+location\.search\);try\{await post\(\{action:'exchange',code\}\)/);
  assert.match(html, /post\(\{action:'view'\}\)/);
  assert.match(html, /post\(\{action:'logout'\}\)/);
  assert.doesNotMatch(html, /localStorage|sessionStorage|document\.cookie|searchParams\.get\('code'\)|sessionToken/);
});

test('기존 학생 세션에서 새 초대를 열면 코드를 메모리에만 보존하고 로그아웃 뒤 교환한다', () => {
  assert.match(script, /failure\.code=String\(data\.code\|\|''\)/);
  assert.match(script, /pendingInviteCode=code;history\.replaceState/);
  assert.match(script, /error\.code==='SESSION_ALREADY_ACTIVE'/);
  assert.match(script, /기존 학생 연결이 있습니다/);
  assert.match(script, /const nextCode=pendingInviteCode;pendingInviteCode=''/);
  assert.match(script, /if\(nextCode\)\{try\{await post\(\{action:'exchange',code:nextCode\}\);await refresh\(true\)/);
  assert.match(script, /fail\('로그아웃했습니다[^']+',true\)/);
  assert.doesNotMatch(script, /localStorage|sessionStorage/);
});

test('학생에게 필요한 읽기 전용 여섯 영역만 보여준다', () => {
  for (const label of ['오늘 수업', '5단계', '숙제·준비물', '오늘 차량', '교재 준비·수령', '주간 시간표']) {
    assert.match(html, new RegExp(label));
  }
  assert.doesNotMatch(script, /data\.feedback|guardianRequests|submit_request|action:'respond'|makeups|sessionPacks|announcements|onboarding/);
  assert.doesNotMatch(html, /<input|<textarea|type="file"|contenteditable|data-response|data-request-type/);
});

test('5단계 진행은 서버 숫자를 0~5로 제한해 표시한다', () => {
  const start = script.indexOf('function count(');
  const end = script.indexOf('function lessonRows', start);
  const progress = new Function(script.slice(start, end) + ';return progress;')();
  const tooMany = progress(100);
  assert.match(tooMany, /5단계 중 5단계 완료/);
  assert.equal((tooMany.match(/class="done"/g) || []).length, 5);
  assert.match(progress(-2), /5단계 중 0단계 완료/);
  assert.match(progress('not-a-number'), /5단계 중 0단계 완료/);
});

test('공개 숙제·준비물은 HTML을 실행하지 않고 빈 공개 기록은 숨긴다', () => {
  const start = script.indexOf('const esc=');
  const end = script.indexOf('function scheduleRows', start);
  const publicLessonRows = new Function(script.slice(start, end) + ';return publicLessonRows;')();
  const attack = '<img src=x onerror=alert(1)>';
  const output = publicLessonRows([
    { subject: attack, teacherName: attack, lessonDate: attack, publicHomework: attack, publicReadiness: '연필 & 지우개' },
    { subject: '빈 수업', publicHomework: ' ', publicReadiness: '' }
  ]).join('');
  assert.doesNotMatch(output, /<img\b/);
  assert.match(output, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(output, /연필 &amp; 지우개/);
  assert.doesNotMatch(output, /빈 수업/);
  assert.match(html, /최근 공개 숙제·준비물/);
  assert.match(html, /최근 14일 공개 기록이 없습니다/);
  assert.match(html, /<span>공개 기록<\/span>/);
});

test('차량에는 안전 상태와 예정 시각만 표시하고 노선·정류장·연락처를 사용하지 않는다', () => {
  const start = script.indexOf('function transportRows');
  const end = script.indexOf('function publicLessonRows', start);
  const transportRows = new Function('RIDE_STATUS', 'rows', 'clock', 'esc', script.slice(start, end) + ';return transportRows;')(
    { scheduled: ['탑승 확인 전', 'muted'], boarded: ['탑승 확인', 'warn'], dropped: ['하차 확인', 'ok'], absent: ['미탑승', 'bad'] },
    value => Array.isArray(value) ? value : [], () => '', value => String(value).replace(/</g, '&lt;')
  );
  const output = transportRows([{ direction: 'pickup', status: 'boarded', scheduledTime: '<10:00>', routeName: '비밀노선', stopName: '비밀정류장', address: '비밀주소', guardianPhone: '비밀번호' }]).join('');
  assert.match(output, /등원 차량/);
  assert.match(output, /탑승 확인/);
  assert.match(output, /&lt;10:00>/);
  assert.doesNotMatch(output, /비밀노선|비밀정류장|비밀주소|비밀번호/);
  assert.doesNotMatch(script, /row\.routeName|row\.stopName|row\.address|row\.guardianPhone/);
});

test('주간 시간표는 월요일부터 시간순으로 정렬한다', () => {
  const start = script.indexOf('function scheduleRows');
  const end = script.indexOf('function bookRows', start);
  const scheduleRows = new Function('DAY_ORDER', 'rows', 'esc', 'teacher', script.slice(start, end) + ';return scheduleRows;')(
    '월화수목금토일', value => Array.isArray(value) ? value : [], String, String
  );
  const output = scheduleRows([
    { dayLabel: '토', subject: '토 수업', timeLabel: '10:00' },
    { dayLabel: '월', subject: '월 오후', timeLabel: '18:00' },
    { dayLabel: '월', subject: '월 오전', timeLabel: '09:00' }
  ]).join('');
  assert.ok(output.indexOf('월 오전') < output.indexOf('월 오후'));
  assert.ok(output.indexOf('월 오후') < output.indexOf('토 수업'));
});

test('교재 상태는 배정 교재만 escape해 표시하고 주문 DTO는 한 번 더 숨긴다', () => {
  const start = script.indexOf('function bookRows');
  const end = script.indexOf('function render', start);
  const bookRows = new Function('rows', 'esc', 'stamp', 'BOOK_CLASS', script.slice(start, end) + ';return bookRows;')(
    value => Array.isArray(value) ? value : [], value => String(value).replace(/</g, '&lt;'), () => '', { handed: 'ok' }
  );
  const output = bookRows([
    { kind: 'distribution', title: '<교재>', stage: 'handed', label: '<전달>', taskId: '비밀작업', bookId: '비밀교재', vendor: '비밀업체' },
    { kind: 'order', title: '보호자 주문', stage: 'ordered', label: '주문됨' }
  ]).join('');
  assert.match(output, /&lt;교재>/);
  assert.match(output, /&lt;전달>/);
  assert.match(output, /배정 교재/);
  assert.doesNotMatch(output, /보호자 주문|주문됨/);
  assert.doesNotMatch(output, /비밀작업|비밀교재|비밀업체/);
  assert.doesNotMatch(script, /row\.taskId|row\.bookId|row\.vendor|row\.provider/);
  assert.doesNotMatch(script, /order_waiting|order_check|order_failed|academy_received/);
});

test('로딩·빈 목록·오류·수동 및 자동 새로고침 상태를 제공한다', () => {
  assert.match(html, /학생 정보를 확인하고 있습니다/);
  assert.match(html, /오늘 예정된 수업이 없습니다/);
  assert.match(html, /최근 14일 공개 기록이 없습니다/);
  assert.match(html, /role="alert" tabindex="-1"/);
  assert.match(html, /인터넷 연결을 확인하고 다시 시도해 주세요/);
  assert.match(html, /refreshButton\.hidden=!!clear;logoutButton\.hidden=!!clear/);
  assert.match(html, /id="liveStatus" class="sr" role="status" aria-live="polite"/);
  assert.match(script, /visibilitychange/);
  assert.match(script, /window\.addEventListener\('focus'/);
  assert.match(script, /refreshButton\.addEventListener\('click',\(\)=>refresh\(true\)\)/);
  assert.match(script, /error\.status===401\|\|error\.status===410/);
});

test('모바일 조작과 긴 공개 문장을 접근 가능하게 표시한다', () => {
  assert.match(html, /name="viewport"/);
  assert.match(html, /\.headbtn\{min-width:44px;min-height:44px/);
  assert.match(html, /\.info summary\{min-height:48px/);
  assert.match(html, /white-space:pre-wrap/);
  assert.match(html, /button:focus-visible,summary:focus-visible/);
  assert.match(html, /aria-busy="true"/);
});

test('학생 전용 정적 origin은 저장·검색·프레임·민감 브라우저 권한을 차단한다', () => {
  assert.match(headers, /Content-Security-Policy:.*frame-ancestors 'none'/);
  assert.match(headers, /X-Frame-Options:\s*DENY/);
  assert.match(headers, /Referrer-Policy:\s*no-referrer/);
  assert.match(headers, /X-Content-Type-Options:\s*nosniff/);
  assert.match(headers, /X-Robots-Tag:\s*noindex, nofollow, noarchive/);
  assert.match(headers, /Cache-Control:\s*no-store/);
  assert.match(headers, /Permissions-Policy:.*camera=\(\).*microphone=\(\).*geolocation=\(\)/);
  assert.match(assetsIgnore, /^\/student-ui\.test\.cjs\s*$/);
});
