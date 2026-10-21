const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('consult creates a short-lived admin device link without secrets or passwords', () => {
  const block = html.match(/case 'adminlink':[\s\S]*?\n\s*break;/)?.[0] || '';
  assert.match(block, /issueAdminHandoff\(\)/);
  assert.match(block, /adminDeviceConnectLink\(d\.code\)/);
  assert.doesNotMatch(block, /syncSecret|adminPin|\?s=/);
});

test('director creates a local one-time QR for a director device', () => {
  const settings = html.match(/function viewSettings\(\)[\s\S]*?\n}/)?.[0] || '';
  const link = html.match(/function adminDeviceConnectLink\(code\)[\s\S]*?\n}/)?.[0] || '';
  const qrModal = html.match(/function adminDeviceQrModal\(link\)[\s\S]*?\n}/)?.[0] || '';
  const action = html.match(/case 'adminqr':[\s\S]*?\n\s*break;/)?.[0] || '';

  assert.match(settings, /data-act="adminqr"[^>]*>원장 기기 QR 만들기<\/button>/);
  assert.match(link, /#admin=/);
  assert.match(html, /DIRECTOR_ONLY_ACTIONS[\s\S]*?'adminqr'/);
  assert.match(action, /issueAdminHandoff\(\)[\s\S]*?adminDeviceQrModal\(adminDeviceConnectLink\(d\.code\)\)/);
  assert.match(qrModal, /WBQR\.svg\(link, \{ size: 280 \}\)/);
  assert.match(qrModal, /원장 전체 권한[\s\S]*?10분 안에 한 기기에서 한 번만[\s\S]*?최대 5대/);
  assert.doesNotMatch(qrModal, /google|qrserver|chart\.api/i);
});

test('new admin device exchanges the code once and stores only its device token', () => {
  const connect = html.match(/async function connectAdminDevice\(\)[\s\S]*?\n}/)?.[0] || '';
  assert.ok(connect.indexOf('if (!save())') < connect.indexOf('await sync.exchangeAdmin(code)'),
    '패드가 저장할 수 있는지 확인한 뒤에만 1회 코드를 소비한다');
  assert.match(connect, /await runAuthSwitch\(async \(\) => \{[\s\S]*await prepareAuthSwitch\(true\)/);
  assert.match(connect, /exchangeAdmin\(code\)/);
  assert.match(connect, /resetAdminDeviceCache\(d\.token\)/);
  assert.match(connect, /session\.unlock\(\)/);
});

test('admin handoff never uploads a previous student cache with admin authority', () => {
  const reset = html.match(/function resetAdminDeviceCache\(token\)[\s\S]*?\n}/)?.[0] || '';
  const connect = html.match(/async function connectAdminDevice\(\)[\s\S]*?\n}/)?.[0] || '';
  const studentReset = html.match(/function resetStudentLinkCache\(token\)[\s\S]*?\n}/)?.[0] || '';
  const run = html.match(/async run\(duringStudentConnect, duringAdminConnect\)[\s\S]*?\n  },/)?.[0] || '';

  assert.match(run, /if \(pendingAdminCode && !duringAdminConnect\) return;[\s\S]*?const auth = this\.auth\(\)/,
    'QR 교환 중에는 기존 관리자 자격으로 일반 동기화를 시작하지 않는다');
  assert.match(connect, /replacingStudentCache[\s\S]*?adminToken = ''[\s\S]*?managerToken = ''[\s\S]*?syncSecret = ''[\s\S]*?session\.lock\(\)/);
  assert.match(connect, /sync\.collect\([\s\S]*?return;[\s\S]*?exchangeAdmin\(code\)/);
  assert.match(connect, /resetAdminDeviceCache\(d\.token\)/);
  assert.ok(connect.indexOf('resetAdminDeviceCache(d.token)') < connect.indexOf('await sync.run()'),
    '학생 캐시를 비운 뒤 첫 관리자 동기화를 시작한다');
  assert.match(reset, /staff: \[\], tasks: \[\], checks: \{\}/);
  assert.match(reset, /myToken: ''/);
  assert.match(reset, /localLearningLogins: \{\}/);
  assert.match(studentReset, /adminToken: '', syncSecret: ''/,
    '학생 전환 시 이전 관리자 자격을 남기지 않는다');
});

test('temporary admin handoff failures keep only a volatile retry code', () => {
  const connect = html.match(/async function connectAdminDevice\(\)[\s\S]*?\n}/)?.[0] || '';
  const lock = html.match(/function viewLock\(\)[\s\S]*?\n}/)?.[0] || '';
  const retry = html.match(/case 'adminretry':[\s\S]*?break;/)?.[0] || '';
  assert.match(connect, /if \(!code \|\| adminConnectBusy\) return/);
  assert.ok(connect.indexOf("pendingAdminCode = ''") > connect.indexOf('await sync.exchangeAdmin(code)'),
    '교환 응답 전에 1회 코드를 버리지 않는다');
  assert.match(connect, /const terminal = \[400, 401, 403, 404, 409, 410, 422\]/);
  assert.match(connect, /if \(terminal\) pendingAdminCode = ''/);
  assert.match(connect, /finally[\s\S]*if \(!session\.isAdmin\) render\(\)/,
    '확정 실패 뒤에는 오래된 재시도 카드를 제거한다');
  assert.match(lock, /data-act="adminretry"/);
  assert.match(retry, /connectAdminDevice\(\)/);
  assert.doesNotMatch(connect, /localStorage|sessionStorage/);
});

test('admin device authentication remains isolated to consult', () => {
  assert.match(html, /const SYNC_APP = 'consult'/);
  assert.match(html, /mode: 'admin_device', token: t/);
  assert.match(html, /app: SYNC_APP, staffId: '__admin__'/);
});
