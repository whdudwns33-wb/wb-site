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

test('admin device authentication remains isolated to consult', () => {
  assert.match(html, /const SYNC_APP = 'consult'/);
  assert.match(html, /mode: 'admin_device', token: t/);
  assert.match(html, /app: SYNC_APP, staffId: '__admin__'/);
});
