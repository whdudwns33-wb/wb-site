const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const consultVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8')).v;

test('consult admin account recovery verifies the consult sync secret', () => {
  assert.match(html, /data-act="recoverpin"/);

  const recovery = html.match(/case 'recoverpinsave':[\s\S]*?\n\s*break;/)?.[0] || '';
  assert.match(recovery, /saveAdminAccount\(loginId, pin/);
  assert.match(recovery, /\{ mode: 'admin', secret: secret \}/);
  assert.match(recovery, /state\.settings\.adminToken = d\.token/);
  assert.match(recovery, /state\.settings\.adminLoginId = d\.loginId/);
  assert.match(recovery, /save\(\); session\.unlock\(\)/);
});

test('consult login uses server credentials and stores the returned device token', () => {
  const login = html.match(/case 'login':[\s\S]*?\n\s*break;/)?.[0] || '';
  assert.match(login, /sync\.loginAdmin\(loginId, password\)/);
  assert.match(login, /state\.settings\.adminToken = d\.token/);
  assert.match(login, /state\.settings\.syncSecret = ''/);
  assert.match(html, /MAX|90일간/);
});

test('legacy recovery links cannot overwrite the current local password', () => {
  const absorb = html.match(/function absorbLinkParams\(\)[\s\S]*?\n}/)?.[0] || '';
  assert.doesNotMatch(absorb, /state\.settings\.adminPin = cfg\.p/);
});

test('consult reuses an already saved emergency secret during one-time account migration', () => {
  const modal = html.match(/case 'recoverpin':[\s\S]*?\n\s*break;/)?.[0] || '';
  const recovery = html.match(/case 'recoverpinsave':[\s\S]*?\n\s*break;/)?.[0] || '';
  assert.match(modal, /hasSavedSecret = !!state\.settings\.syncSecret/);
  assert.match(modal, /hasSavedSecret \? '' : .*id="recoverSecret"/);
  assert.match(recovery, /state\.settings\.syncSecret/);
});

test('consult storage and sync identity stay isolated from task', () => {
  assert.match(html, /const LS_KEY = 'wb_consult_v1'/);
  assert.match(html, /const SYNC_APP = 'consult'/);
  assert.doesNotMatch(html, /const LS_KEY = 'wb_taskboard_v1'/);
  assert.ok(html.includes("const APP_VER = '" + consultVersion + "'"));
  assert.match(html, /fetch\('\.\/version\.json\?t='/);
  assert.doesNotMatch(html, /fetch\('\.\.\/version\.json\?t='/);
});
