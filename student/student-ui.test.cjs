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

test('학생에게 필요한 공개 영역과 제한된 자기 체크·외부 학습 도구만 보여준다', () => {
  for (const label of ['오늘 수업', '5단계', '숙제·준비물', '오늘 차량', '교재 준비·수령', '주간 시간표', '바로 학습하기']) {
    assert.match(html, new RegExp(label));
  }
  assert.doesNotMatch(script, /data\.feedback|guardianRequests|submit_request|action:'respond'|makeups|sessionPacks|announcements|onboarding/);
  assert.doesNotMatch(html, /<input|<textarea|type="file"|contenteditable|data-response|data-request-type/);
});

test('메타수학과 클래스카드는 공식 화면만 안전하게 새 창으로 연다', () => {
  const start = script.indexOf('function studySection(');
  const end = script.indexOf('function group(', start);
  const studySection = new Function(script.slice(start, end) + ';return studySection;')();
  const legacy = studySection(false), enabled = studySection(true);
  assert.equal(legacy, '');
  assert.match(enabled, /href="https:\/\/new\.mmath\.co\.kr\/Pages\/student\/"/);
  assert.match(enabled, /href="https:\/\/www\.classcard\.net\/Login"/);
  assert.equal((enabled.match(/class="study-link"/g) || []).length, 2);
  assert.equal((enabled.match(/target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"/g) || []).length, 2);
  assert.match(enabled, /새 창\/탭에서 열림/);
  assert.match(enabled, /기기 정보·접속 기록·서비스 쿠키를 처리할 수 있습니다/);
  assert.match(enabled, /외부 아이디·비밀번호·학습 결과를 받거나 저장하지 않습니다/);
  assert.doesNotMatch(enabled, /<iframe|name="(?:id|password)"|autocomplete="(?:username|current-password)"/i);
  assert.doesNotMatch(script, /fetch\(['"]https:\/\/(?:new\.mmath|www\.classcard)/);
  assert.match(script, /studySection\(capabilities\.externalLearning===true\)/);
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
  assert.match(html, /공개 기록/);
});

test('오늘 할 일은 v3 capability와 서버 오늘 날짜가 모두 맞을 때만 두 선택지를 표시한다', () => {
  const start = script.indexOf('function normalizeSelfCheckRow');
  const end = script.indexOf('function publicLessonRows', start);
  const api = new Function('rows', 'esc', 'teacher', script.slice(start, end) +
    ';return {normalizeSelfCheckRow,selfCheckRows};')(
    value => Array.isArray(value) ? value : [],
    value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]), String
  );
  const today = '2026-08-18';
  const row = {
    activityId: 'activity_12345678', publicationRevision: 2, lessonDate: today,
    subject: '<수학>', teacherName: '<선생>', publicHomework: '<img src=x onerror=1>', publicReadiness: '연필 & 지우개',
    selfCheck: { response: 'help_needed', reviewStatus: 'confirmed', revision: 3, updatedAt: 1, confirmedAt: 2, finalCompleted: false }
  };
  assert.equal(api.normalizeSelfCheckRow(row, today, false), null);
  assert.equal(api.normalizeSelfCheckRow(row, '2026-08-17', true), null);
  assert.equal(api.normalizeSelfCheckRow({ ...row, activityId: 'bad!' }, today, true), null);
  assert.equal(api.normalizeSelfCheckRow({ ...row, selfCheck: { ...row.selfCheck, revision: 0 } }, today, true), null);
  assert.equal(api.normalizeSelfCheckRow({ ...row, selfCheck: { ...row.selfCheck, finalCompleted: true } }, today, true), null);
  const item = api.normalizeSelfCheckRow(row, today, true);
  const output = api.selfCheckRows([item]).join('');
  assert.match(output, /오늘 할 일 상태 선택/);
  assert.match(output, /data-self-check-choice="completed"/);
  assert.match(output, /data-self-check-choice="help_needed"/);
  assert.match(output, /도움 필요 · 선생님 확인함/);
  assert.match(output, /도움 필요를 확인받은 뒤에는 완료로 바꿀 수 있습니다/);
  assert.doesNotMatch(output, /<img\b|<input|<textarea|contenteditable/);
  assert.doesNotMatch(output, /data-self-check-choice="(?:completed|help_needed)"[^>]*disabled/);
  assert.match(output, /&lt;img src=x onerror=1&gt;/);
  assert.match(output, /연필 &amp; 지우개/);
  const completed = { ...row, selfCheck: { ...row.selfCheck, response: 'completed', finalCompleted: true } };
  const completedOutput = api.selfCheckRows([api.normalizeSelfCheckRow(completed, today, true)]).join('');
  assert.match(completedOutput, /완료 · 선생님 확인 완료/);
  assert.equal((completedOutput.match(/ disabled/g) || []).length, 2);
  assert.match(completedOutput, /선생님 확인까지 끝나 최종 완료되었습니다/);
});

test('자기 체크 저장은 자유문자 없이 opaque activity와 두 CAS revision만 보낸다', () => {
  const start = script.indexOf('async function submitSelfCheck(');
  const end = script.indexOf('async function boot(', start);
  const code = script.slice(start, end);
  assert.match(script, /selfCheckEnabled=capabilities\.selfCheck===true/);
  assert.match(script, /row\.lessonDate!==todayDate/);
  assert.match(script, /publicLessonRows\(rows\(data\.publicLessons\)\.filter\(row=>!selfCheckIds\.has/);
  assert.match(code, /\['completed','help_needed'\]\.includes\(response\)/);
  assert.match(code, /post\(\{action:'self_check_set',activityId:activityId,publicationRevision:publicationRevision,response:response,expectedRevision:expectedRevision\}\)/);
  assert.match(code, /source\.selfCheck=result\.selfCheck;render\(lastStudentData\)/);
  assert.match(code, /checked\.finalCompleted/);
  assert.match(code, /let saved=false/);
  assert.match(code, /saved=true/);
  assert.match(code, /if\(saved\)\{[\s\S]*choices\.forEach\(item=>item\.disabled=true\)[\s\S]*선택은 저장됨 · 화면 새로고침 필요/);
  assert.match(code, /\['SELF_CHECK_FINALIZED','SELF_CHECK_REVISION_CONFLICT','SELF_CHECK_NOT_AVAILABLE'\]\.includes\(error\.code\)/);
  assert.match(code, /choices\.forEach\(item=>item\.disabled=false\)/);
  assert.doesNotMatch(code, /expectedRevision\s*\+\s*1/);
  const payload = code.match(/post\((\{action:'self_check_set'[^}]+\})\)/)[1];
  assert.doesNotMatch(payload, /freeText|message|memo|note|studentId|taskId|clientRequestId|localStorage|sessionStorage/);
});

test('교사가 먼저 최종 확인한 race와 revision 충돌은 재시도 버튼을 열지 않고 최신 상태를 다시 불러온다', async () => {
  const start = script.indexOf('async function submitSelfCheck(');
  const end = script.indexOf('async function boot(', start);
  const code = script.slice(start, end);
  for (const failureCode of ['SELF_CHECK_FINALIZED', 'SELF_CHECK_REVISION_CONFLICT']) {
    const refreshCalls = [], choices = [{ disabled: false }, { disabled: false }];
    const status = { className: '', textContent: '' };
    const row = {
      dataset: { activity: 'activity_12345678', publicationRevision: '4', revision: '2' },
      querySelectorAll: () => choices,
      querySelector: () => status
    };
    const button = { dataset: { selfCheckChoice: 'help_needed' }, closest: () => row };
    const result = await new Function('post', 'refresh', 'button', `
      let selfCheckEnabled = true;
      const pendingSelfChecks = new Set(), liveStatus = { textContent: '' };
      const source = { activityId: 'activity_12345678', publicationRevision: 4,
        selfCheck: { response: 'completed', reviewStatus: 'pending', revision: 2, finalCompleted: false } };
      const lastStudentData = { today: { date: '2026-08-18' }, publicLessons: [source] };
      const rows = value => Array.isArray(value) ? value : [];
      const normalizeSelfCheckRow = item => item ? {
        publicationRevision: item.publicationRevision,
        revision: item.selfCheck.revision,
        finalCompleted: item.selfCheck.finalCompleted
      } : null;
      const render = () => {};
      ${code}
      return submitSelfCheck(button).then(() => ({ liveStatus, pendingSelfChecks }));
    `)(
      async () => { const error = new Error('stale'); error.code = failureCode; throw error; },
      async force => { refreshCalls.push(force); return true; },
      button
    );
    assert.deepEqual(refreshCalls, [true]);
    assert.deepEqual(choices.map(choice => choice.disabled), [true, true]);
    assert.equal(result.pendingSelfChecks.size, 0);
    assert.match(result.liveStatus.textContent, /최신 선택 상태/);
    assert.notEqual(status.textContent, '저장 실패 · 다시 선택해 주세요');
  }
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
  assert.match(html, /\.study-link\{display:flex;min-height:72px/);
  assert.match(html, /\.info summary\{min-height:48px/);
  assert.match(html, /white-space:pre-wrap/);
  assert.match(html, /button:focus-visible,a:focus-visible,summary:focus-visible/);
  assert.match(html, /outline:3px solid #087ba6/);
  assert.match(html, /\.headbtn:focus-visible\{outline-color:#fff\}/);
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
