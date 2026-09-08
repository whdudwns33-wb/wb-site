const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function between(start, end) {
  const a = html.indexOf(start);
  const b = html.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, 'source block not found: ' + start);
  return html.slice(a, b);
}

test('학생 연락처는 서버에만 두고 준비된 학생은 바로 보내며 미등록 학생만 최초 입력한다', () => {
  const contacts = between('const consultLinkContactsUi =', '\nfunction viewStaffAdmin()');
  const panel = between('function consultLinkStudentPanel(student) {', '\nfunction consultLinkContactModal');
  const access = between('function staffAccessPanels(student) {', '\nfunction viewStaffAdmin()');
  const view = between('function viewStaffAdmin() {', '\n/* ── 설정');
  const state = between('function blankState() {', '\nconst LOCAL_AUTH_SETTINGS');
  const add = between("    case 'addstaff':", "    case 'delstaff':");

  assert.match(contacts, /rows: new Map\(\)/);
  assert.match(contacts, /phoneMasked: String\(row\.phoneMasked \|\| ''\)/);
  assert.match(contacts, /phoneOwner: \['student', 'mother'\]\.includes\(row\.phoneOwner\)/);
  assert.doesNotMatch(contacts, /localStorage|LS_KEY|state\.(?:staff|settings)|\bsave\(/,
    '카카오 연락처 캐시는 wb_consult_v1 또는 동기화 state에 저장하지 않는다');
  assert.doesNotMatch(state + add, /phoneMasked|phone|contact|consent/i);
  assert.match(panel, /student\.owner \|\| student\.manager/);
  assert.match(view, /staffAccessPanels\(s\)/);
  assert.match(access, /if \(student\.owner \|\| student\.manager\)/);
  assert.match(access, /consultLinkStudentPanel\(student\)/);
  assert.match(access, /학생용 앱[\s\S]*시간표·체크·학습시간·마감/);
  assert.match(access, /보호자 열람[\s\S]*읽기 전용/);
  assert.match(view, /학생 번호와 동의는 처음 한 번만 등록합니다/);
  assert.match(view, /보호자 번호는 별도로 관리합니다/);
  assert.match(panel, /학생 연락처 없음 · 처음 한 번만 등록하세요/);
  assert.match(panel, /학생 연락처 수정/);
  assert.match(panel, /학생 번호 등록하고 보내기/);
  assert.match(panel, /카톡으로 학생용 링크 보내기/);
  assert.match(panel, /const sendDisabled = unavailable \|\| anyBusy/);
});

test('학생·엄마 번호를 구분해 동의받아 저장하고 보호자 열람 번호와 분리한다', () => {
  const modal = between('function consultLinkContactModal(staffId', '\nasync function saveConsultLinkContact');
  const save = between('async function saveConsultLinkContact(staffId', '\nfunction consultLinkSendMessage');

  assert.match(modal, /학생 휴대폰이 없으면 엄마 번호로 표시해 등록합니다/);
  assert.match(modal, /consultLinkPhoneOwnerOptions\(contact/);
  assert.match(modal, /현재 ['"] \+ consultLinkPhoneLabel\(contact\)/);
  assert.match(modal, /변경하려면 종류와 전체 번호를 다시 입력/);
  assert.match(modal, /id="consultLinkConsent"/);
  assert.match(modal, /엄마 번호를 선택해도 ‘보호자 공유’의 열람 초대 번호와는 별도로 관리합니다/);
  assert.match(modal, /data-send="1"/);
  assert.match(modal, /동의하고 바로 보내기/);
  assert.match(save, /\^01\[016789\]\\d\{7,8\}\$/);
  assert.match(save, /if \(!clear && !consent\) return toast\('발송 동의를 확인해 주세요'\)/);
  assert.match(modal, /발송 중지·번호 삭제/);
  assert.match(save, /const phone = clear \? ''/);
  assert.match(save, /name="consultLinkPhoneOwner"\]:checked/);
  assert.match(save, /const consent = clear \? false/);
  assert.match(save, /sync\.post\('\/consult-link-send', \{\s*app: SYNC_APP, auth: sync\.auth\(\), action: 'set', staffId: staffId, phone: phone,\s*phoneOwner: phoneOwner, consent: consent, expectedUpdatedAt: Number\(expectedUpdatedAt\) \|\| 0\s*\}\)/);
  assert.match(save, /savedForSend = consultLinkContactReady\(row\)/);
  assert.match(save, /if \(savedForSend && sendAfterSave\) await sendConsultStudentLink\(staffId\)/);
});

test('학생 번호는 본인 토큰으로 필수 등록하고 원문은 브라우저 상태에 남기지 않는다', () => {
  const render = between('function render() {', '\nfunction renderTabs()');
  const contactHelpers = between('function consultLinkContactRow(row)', '\n/* 학생 번호 원문');
  const phone = between('const studentPhoneUi =', '\nasync function loadConsultLinkContacts');
  const ownerHelpers = between('function consultLinkPhoneLabel(contact)', '\nfunction consultLinkPhoneOwnerOptions');
  const reset = between('function resetStudentLinkCache(token) {', '\n\nfunction studentCacheScopedTo');
  const guide = between('function studentPhoneSettingsCard()', '\nfunction studentSetupReminder');
  const actions = between("    case 'studentphoneretry':", "    case 'linkcontactsretry':");

  const pendingAt = render.indexOf('pendingStudentCode || studentConnectError');
  const missingStudentAt = render.indexOf('!staffById(session.staffId)');
  const phoneGateAt = render.indexOf('!studentPhoneReady()');
  const routeAt = render.indexOf('const map =');
  assert.ok(pendingAt >= 0 && pendingAt < missingStudentAt && missingStudentAt < phoneGateAt && phoneGateAt < routeAt);
  assert.match(render, /session\.isStaffLink && !isManager\(\) && !studentPhoneReady\(\)/);
  assert.match(render, /viewStudentPhoneGate\(currentStaff\(\)\)/);
  assert.match(render, /!studentPhoneUi\.loaded && !studentPhoneUi\.loading[\s\S]*loadStudentPhone\(\)/);

  assert.match(phone, /staffId: '', contact: null/);
  assert.match(phone, /contact\.staffId === student\.id/);
  assert.match(contactHelpers, /엄마 번호/);
  assert.match(contactHelpers, /학생 휴대폰이 없는 경우/);
  assert.match(contactHelpers, /phoneOwner === 'mother'/);
  assert.match(contactHelpers, /: 'unknown'/);
  assert.match(phone, /consultLinkContactReady\(contact\)/);
  assert.match(phone, /action: 'self_get'/);
  assert.match(phone, /action: 'self_set'/);
  assert.match(phone, /\^01\[016789\]\\d\{7,8\}\$/);
  assert.match(phone, /if \(!consent\) return toast/);
  assert.match(phone, /번호는 이 기기·플래너 백업에 저장하지 않고 컨설팅 서버에서만 관리/);
  assert.match(phone, /보호자 열람 초대 번호와는 별도로 관리/);
  assert.doesNotMatch(phone, /localStorage|LS_KEY|state\.(?:staff|settings)|\bsave\(/,
    '학생 연락처 원문과 마스킹 상태를 wb_consult_v1 또는 동기화 state에 저장하지 않는다');

  const selfSetAt = phone.indexOf("sync.post('/consult-link-send', {", phone.indexOf('async function saveStudentPhone'));
  const selfSetRequest = phone.slice(selfSetAt, phone.indexOf('});', selfSetAt) + 3);
  assert.match(selfSetRequest, /app: SYNC_APP, auth: auth, action: 'self_set', phone: phone, phoneOwner: phoneOwner, consent: true/);
  assert.doesNotMatch(selfSetRequest, /staffId/);
  assert.match(reset, /clearStudentPhoneUi\(\)/);
  assert.match(guide, /phoneMasked/);
  assert.match(guide, /data-act="studentphoneopen"/);
  assert.match(actions, /studentphoneretry[\s\S]*studentphoneopen[\s\S]*studentphonesave/);

  const ownerApi = new Function(ownerHelpers + ';return {label:consultLinkPhoneLabel,ready:consultLinkContactReady};')();
  assert.equal(ownerApi.label({ phoneOwner: 'mother' }), '엄마 번호');
  assert.equal(ownerApi.label({ phoneOwner: 'unknown' }), '번호 구분 필요');
  assert.equal(ownerApi.ready({ phoneMasked: '010****5678', consent: true, phoneOwner: 'unknown' }), false);
  assert.equal(ownerApi.ready({ phoneMasked: '010****5678', consent: true, phoneOwner: 'mother' }), true);
});

test('개인 링크 발송은 먼저 consult 동기화를 확인하고 수신번호나 문구를 요청에 싣지 않는다', () => {
  const send = between('async function sendConsultStudentLink(staffId) {', '\nfunction viewStaffAdmin()');
  const postAt = send.indexOf("sync.post('/consult-link-send'");
  assert.ok(send.indexOf('await sync.run()') >= 0 && send.indexOf('await sync.run()') < postAt);
  assert.ok(send.indexOf('if (sync.err) throw') < postAt);
  const request = send.slice(postAt, send.indexOf(');', postAt) + 2);
  assert.match(request, /\{\s*app: SYNC_APP, auth: sync\.auth\(\), action: 'send', staffId: staffId\s*\}/);
  assert.doesNotMatch(request, /phone|message|recipient|token/i);
  assert.match(send, /consultLinkContactsUi\.busy = 'send:' \+ staffId/);
  assert.match(send, /finally[\s\S]*consultLinkContactsUi\.busy = ''/);
  assert.match(send, /return consultLinkContactModal\(staffId, true\)/);
  assert.match(send, /!consultLinkContactReady\(contact\)/);
});

test('솔라피 결과는 접수와 완료를 구분하고 모호한 결과의 중복 발송을 경고한다', () => {
  const status = between('function consultLinkSendMessage(data) {', '\nasync function sendConsultStudentLink');
  for (const value of ['accepted', 'idempotent', 'dispatching', 'unknown', 'rejected']) {
    assert.match(status, new RegExp(value));
  }
  assert.match(status, /솔라피에 카카오 알림톡이 접수되었습니다/);
  assert.doesNotMatch(status, /발송 완료|전송 완료|학생에게 도착/);
  assert.match(status, /중복 발송하지 말고 솔라피 발송 내역을 확인/);
  const api = new Function(status + '; return {message:consultLinkSendMessage,error:consultLinkSendError};')();
  assert.equal(api.message({ status: 'accepted' }), '솔라피에 카카오 알림톡이 접수되었습니다');
  assert.match(api.message({ status: 'accepted', idempotent: true }), /중복 발송하지 않았습니다/);
  assert.match(api.error({ remoteStatus: 'unknown' }), /중복 발송하지 말고/);
  assert.match(api.error({ remoteStatus: 'rejected' }), /접수하지 않았습니다/);
});

test('새 학생 링크는 fragment 1회코드를 교환하고 기존 query 토큰은 주소에서 지운다', () => {
  const exchange = between('  async exchangeBootstrap(staffId, code) {', '\n\n  async loginAdmin');
  const absorb = between('function absorbLinkParams() {', '\nasync function connectStudentLink');
  const reset = between('function resetStudentLinkCache(token) {', '\n\n/** 링크에 담겨 온 것들을 흡수한다.');
  const connect = between('async function connectStudentLink(allowEmbeddedExchange) {', '\n/* ══════════════════════════════════════════════════════\n   6. 렌더 헬퍼');

  assert.match(exchange, /this\.post\('\/exchange', \{ app: SYNC_APP, staffId: staffId, code: code \}\)/);
  assert.match(absorb, /q\.get\('t'\)/);
  assert.match(absorb, /q\.delete\('t'\); touched = true/);
  assert.match(absorb, /studentCacheScopedTo\(session\.staffId\)/);
  assert.match(absorb, /resetStudentLinkCache\(tk\)/);
  assert.match(absorb, /const unsent = sync\.collect/);
  assert.match(absorb, /if \(unsent\.length\)[\s\S]*?studentConnectError/);
  assert.match(absorb, /location\.hash\.match\(\/\[#&\]c=/);
  assert.doesNotMatch(absorb, /q\.delete\('c'\)/);
  assert.match(reset, /state = Object\.assign\(blankState\(\), \{ staff: \[\], tasks: \[\], checks: \{\}, settings: settings \}\)/);
  assert.match(reset, /myToken: String\(token \|\| ''\), pullAt: 0, pushAt: 0/);
  assert.match(connect, /const unsent = sync\.collect\(Number\(state\.settings\.pushAt\) \|\| 0\)/);
  assert.match(connect, /if \(unsent\.length\)/);
  assert.match(connect, /await waitForSyncIdle\(\)/);
  assert.match(connect, /sameStudentConnected/);
  assert.match(connect, /isEmbeddedStudentBrowser\(navigator\.userAgent\) && !allowEmbeddedExchange/);
  assert.match(connect, /studentConnectNeedsApproval = true/);
  assert.match(connect, /await sync\.exchangeBootstrap\(staffId, code\)/);
  assert.match(connect, /resetStudentLinkCache\(d\.token\)/);
  assert.match(connect, /clearStudentCodeHash\(\)/);
  assert.match(connect, /const terminal = \[400, 401, 403, 404, 409, 410, 422\]/);
  assert.doesNotMatch(connect, /if \(terminal\) \{[\s\S]*resetStudentLinkCache\(''\)/);
  assert.match(connect, /sessionStorage\.setItem\(STUDENT_LINK_BLOCK_KEY/);
  assert.match(connect, /await sync\.run\(true\)/);
  assert.match(connect, /route = 'today'/);
  assert.doesNotMatch(connect, /go\('guide'\)|pendingStudentWelcome/);
  assert.match(html, /async run\(duringStudentConnect\)[\s\S]*?studentConnectBusy && !duringStudentConnect/);
  assert.match(html, /if \(pendingStudentCode\) \{\s*connectStudentLink\(\);\s*\} else if \(sync\.enabled\(\) && !studentConnectError\)/);
});

test('라우팅은 #/화면만 읽고 #c 1회코드를 화면 이름으로 오인하지 않는다', () => {
  const source = between('function routeFromHash(hash) {', '\nwindow.addEventListener');
  const routeFromHash = new Function(source + '; return routeFromHash;')();
  assert.equal(routeFromHash('#/staff'), 'staff');
  assert.equal(routeFromHash('#c=one-time-code'), '');
  assert.equal(routeFromHash('#/today&c=code'), '');
  assert.match(html, /const h = routeFromHash\(location\.hash\)/);
  assert.match(html, /connectStudentLink\(\);/);
});

test('기존 query 학생 링크는 같은 학생 캐시만 유지하고 다른 학생 데이터는 분리한다', () => {
  const source = between('function studentCacheScopedTo(staffId) {', '\n\n/** 링크에 담겨 온 것들을 흡수한다.');
  const state = {
    staff: [{ id: 'student-a' }],
    tasks: [{ id: 'task-a', staffId: 'student-a' }],
    checks: { '__stgoal__student-a|all': { mins: 120 } }
  };
  const studentCacheScopedTo = new Function('state', 'ownerOfCheck',
    source + '; return studentCacheScopedTo;')(
      state,
      key => key.includes('student-b') ? 'student-b' : 'student-a'
    );

  assert.equal(studentCacheScopedTo('student-a'), true);
  state.staff.push({ id: 'student-b' });
  assert.equal(studentCacheScopedTo('student-a'), false);
  state.staff.pop();
  state.tasks.push({ id: 'task-b', staffId: 'student-b' });
  assert.equal(studentCacheScopedTo('student-a'), false);
  state.tasks.pop();
  state.checks['__stgoal__student-b|all'] = { mins: 60 };
  assert.equal(studentCacheScopedTo('student-a'), false);
});

test('기존 query 학생 링크는 미동기화 기록이 있으면 토큰과 경고를 보존한다', () => {
  const source = between('function absorbLinkParams() {', '\nasync function connectStudentLink');
  function run(unsent) {
    const location = { search: '?u=student-b&t=legacy-token', hash: '', pathname: '/consult/' };
    const historyUrls = [];
    let resetToken = '';
    const result = new Function(
      'location', 'history', 'sync', 'resetStudentLinkCache', 'sessionStorage', 'state', 'session',
      'staffById', 'studentCacheScopedTo', 'save', 'unb64',
      "let studentConnectError='';let pendingAdminCode='';let pendingStudentCode='';" +
      "let studentConnectNeedsApproval=false;let pendingAdd=null;const STUDENT_LINK_BLOCK_KEY='blocked';" +
      source + ';absorbLinkParams();return {error:studentConnectError};'
    )(
      location,
      { replaceState: (_a, _b, url) => historyUrls.push(url) },
      { collect: () => unsent ? [{ id: 'local-change' }] : [] },
      token => { resetToken = token; return true; },
      { removeItem: () => {} },
      { settings: { myToken: 'old-token', pushAt: 10 } },
      { staffId: 'student-b' },
      () => null,
      () => false,
      () => true,
      () => '',
    );
    return { result, historyUrls, resetToken };
  }

  const blocked = run(true);
  assert.match(blocked.result.error, /아직 동기화되지 않은 기록/);
  assert.equal(blocked.resetToken, '');
  assert.deepEqual(blocked.historyUrls, [], '재시도할 legacy token을 URL에서 지우면 안 된다');

  const safe = run(false);
  assert.equal(safe.result.error, '');
  assert.equal(safe.resetToken, 'legacy-token');
  assert.equal(safe.historyUrls.length, 1);
  assert.doesNotMatch(safe.historyUrls[0], /(?:[?&])t=/);
});
