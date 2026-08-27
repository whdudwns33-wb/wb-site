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
  const view = between('function viewStaffAdmin() {', '\n/* ── 설정');
  const state = between('function blankState() {', '\nconst LOCAL_AUTH_SETTINGS');
  const add = between("    case 'addstaff':", "    case 'delstaff':");

  assert.match(contacts, /rows: new Map\(\)/);
  assert.match(contacts, /phoneMasked: String\(row\.phoneMasked \|\| ''\)/);
  assert.doesNotMatch(contacts, /localStorage|LS_KEY|state\.(?:staff|settings)|\bsave\(/,
    '카카오 연락처 캐시는 wb_consult_v1 또는 동기화 state에 저장하지 않는다');
  assert.doesNotMatch(state + add, /phoneMasked|phone|contact|consent/i);
  assert.match(panel, /student\.owner \|\| student\.manager/);
  assert.match(view, /!s\.owner && !s\.manager \? '<hr class="sep">' \+ consultLinkStudentPanel\(s\) : ''/);
  assert.match(view, /학생 번호와 동의는 처음 한 번만 등록합니다/);
  assert.match(view, /보호자 번호는 별도로 관리합니다/);
  assert.match(panel, /학생 연락처 없음 · 처음 한 번만 등록하세요/);
  assert.match(panel, /학생 연락처 수정/);
  assert.match(panel, /학생 번호 등록하고 보내기/);
  assert.match(panel, /카톡으로 개인 링크 보내기/);
  assert.match(panel, /const sendDisabled = unavailable \|\| anyBusy/);
});

test('학생 번호는 최초 한 번만 동의받아 저장하고 보호자 번호와 분리한다', () => {
  const modal = between('function consultLinkContactModal(staffId', '\nasync function saveConsultLinkContact');
  const save = between('async function saveConsultLinkContact(staffId', '\nfunction consultLinkSendMessage');

  assert.match(modal, /학생 본인의 휴대전화 번호/);
  assert.match(modal, /한 번 등록하면 다음 발송부터 자동으로 사용합니다/);
  assert.match(modal, /phoneMasked[\s\S]*현재 학생 번호:/);
  assert.match(modal, /변경하려면 아래에 전체 번호를 다시 입력/);
  assert.match(modal, /id="consultLinkConsent"/);
  assert.match(modal, /보호자 번호는 ‘보호자 공유’에서 별도로 관리합니다/);
  assert.match(modal, /data-send="1"/);
  assert.match(modal, /동의하고 바로 보내기/);
  assert.match(save, /\^01\[016789\]\\d\{7,8\}\$/);
  assert.match(save, /if \(!clear && !consent\) return toast\('발송 동의를 확인해 주세요'\)/);
  assert.match(modal, /발송 중지·번호 삭제/);
  assert.match(save, /const phone = clear \? ''/);
  assert.match(save, /const consent = clear \? false/);
  assert.match(save, /sync\.post\('\/consult-link-send', \{\s*app: SYNC_APP, auth: sync\.auth\(\), action: 'set', staffId: staffId, phone: phone,\s*consent: consent, expectedUpdatedAt: Number\(expectedUpdatedAt\) \|\| 0\s*\}\)/);
  assert.match(save, /if \(savedForSend && sendAfterSave\) await sendConsultStudentLink\(staffId\)/);
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
  const connect = between('async function connectStudentLink() {', '\n/* ══════════════════════════════════════════════════════\n   6. 렌더 헬퍼');

  assert.match(exchange, /this\.post\('\/exchange', \{ app: SYNC_APP, staffId: staffId, code: code \}\)/);
  assert.match(absorb, /q\.get\('t'\)/);
  assert.match(absorb, /q\.delete\('t'\); touched = true/);
  assert.match(absorb, /location\.hash\.match\(\/\[#&\]c=/);
  assert.doesNotMatch(absorb, /q\.delete\('c'\)/);
  assert.match(reset, /state = Object\.assign\(blankState\(\), \{ staff: \[\], tasks: \[\], checks: \{\}, settings: settings \}\)/);
  assert.match(reset, /myToken: String\(token \|\| ''\), pullAt: 0, pushAt: 0/);
  assert.match(connect, /const unsent = sync\.collect\(Number\(state\.settings\.pushAt\) \|\| 0\)/);
  assert.match(connect, /if \(unsent\.length\)/);
  assert.match(connect, /await sync\.exchangeBootstrap\(staffId, code\)/);
  assert.match(connect, /resetStudentLinkCache\(d\.token\)/);
  assert.match(connect, /clearStudentCodeHash\(\)/);
  assert.match(connect, /const terminal = \[400, 401, 403, 404, 409, 410, 422\]/);
  assert.doesNotMatch(connect, /if \(terminal\) \{[\s\S]*resetStudentLinkCache\(''\)/);
  assert.match(connect, /sessionStorage\.setItem\(STUDENT_LINK_BLOCK_KEY/);
  assert.match(html, /if \(pendingStudentCode\) \{\s*connectStudentLink\(\);\s*\} else if \(sync\.enabled\(\)\)/);
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
