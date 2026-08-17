const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('consult creates a short-lived admin device link without secrets or passwords', () => {
  const block = html.match(/case 'adminlink':[\s\S]*?\n\s*break;/)?.[0] || '';
  assert.match(block, /issueAdminHandoff\(\)/);
  assert.match(block, /#admin=/);
  assert.doesNotMatch(block, /syncSecret|adminPin|\?s=/);
});

test('new admin device exchanges the code once and stores only its device token', () => {
  const connect = html.match(/async function connectAdminDevice\(\)[\s\S]*?\n}/)?.[0] || '';
  assert.match(connect, /exchangeAdmin\(code\)/);
  assert.match(connect, /state\.settings\.adminToken = d\.token/);
  assert.match(connect, /state\.settings\.syncSecret = ''/);
  assert.match(connect, /state\.settings\.pullAt = 0/);
  assert.match(connect, /state\.settings\.pushAt = 0/);
  assert.match(connect, /session\.unlock\(\)/);
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
