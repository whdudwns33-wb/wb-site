const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);

test('inline task javascript parses', () => {
  assert.ok(scripts.length > 0);
  scripts.forEach((source, index) => new vm.Script(source, { filename: `task-inline-${index}.js` }));
});

test('admin and person browser storage are isolated', () => {
  assert.match(html, /wb_taskboard_person_v1_/);
  assert.match(html, /HAS_PERSON_SCOPE/);
  assert.match(html, /SAFE_SCOPE_ID/);
});

test('every shared task link requires a one-time code', () => {
  assert.match(html, /async function issueLinkCode/);
  assert.match(html, /await sync\.issueBootstrap/);
  assert.match(html, /#c=/);
  assert.match(html, /case 'orderText':[\s\S]{0,180}issueLinkCode\(id\)/);
  assert.doesNotMatch(html, /case 'orderText': showText/);
  assert.doesNotMatch(html, /function ensureToken/);
});

test('bootstrap is exchanged before first sync and URL code is scrubbed', () => {
  assert.match(html, /pendingBootstrapCode/);
  assert.match(html, /exchangeBootstrap\(session\.staffId, code\)/);
  assert.match(html, /history\.replaceState/);
  assert.match(html, /업무를 안전하게 불러오는 중/);
  assert.match(html, /이 브라우저에는 접속 인증이 없습니다/);
});

test('authenticated staff can create a browser handoff link', () => {
  assert.match(html, /data-act="handoff"/);
  assert.match(html, /async handoff\(\)/);
  assert.match(html, /\/handoff/);
  assert.match(html, /10분 안에 새 브라우저/);
  assert.match(html, /주소창 링크만 복사하면 인증은 옮겨지지 않습니다/);
  assert.match(html, /다른 브라우저에서 열 링크 복사/);
});

test('personal links never unlock manager or student-record write screens', () => {
  assert.match(html, /const isManager = \(\) => false/);
  assert.match(html, /const allowed = \['today', 'week', 'books', 'roster'\]/);
  assert.match(html, /개인 링크에서는 담당 학생 명단만 확인할 수 있습니다/);
  for (const action of ['ctlog', 'oplog', 'exlog']) {
    const block = html.match(new RegExp(`case '${action}':[\\s\\S]{0,220}?break;`))?.[0] || '';
    assert.match(block, /!session\.isAdmin/, action);
  }
  for (const action of ['exsave', 'opprog', 'opsave', 'ctsave']) {
    const block = html.match(new RegExp(`case '${action}':[\\s\\S]{0,120}?break;`))?.[0] || '';
    assert.match(block, /!session\.isAdmin/, action);
  }
});

test('admin recovery URL uses a separate one-time code and no PIN or secret', () => {
  const block = html.match(/case 'adminlink':[\s\S]*?\n\s*break;/)?.[0] || '';
  assert.ok(block);
  assert.match(block, /sync\.adminHandoff\(\)/);
  assert.match(block, /#a=/);
  assert.doesNotMatch(block, /syncSecret|adminPin|\?s=/);
  assert.match(html, /pendingAdminBootstrapCode/);
  assert.match(html, /exchangeAdminBootstrap\(code\)/);
  assert.match(html, /ADMIN_VAULT_KEY/);
  assert.match(html, /AES-GCM/);
});

test('root admin secret is memory-only and exchanged for a short admin session', () => {
  const blank = html.match(/function blankState\(\)[\s\S]*?\n\}/)?.[0] || '';
  const auth = html.match(/const sync = \{[\s\S]*?\n\s*enabled\(\)/)?.[0] || '';
  const settings = html.match(/function viewSettings\(\)[\s\S]*?\n\}/)?.[0] || '';
  const recover = html.match(/async recoverAdmin\(secret\)[\s\S]*?\n\s*\},/)?.[0] || '';

  assert.ok(blank);
  assert.doesNotMatch(blank, /syncSecret/);
  assert.ok(auth);
  assert.doesNotMatch(auth, /syncSecret|mode:\s*'admin'/);
  assert.match(recover, /\/admin-recover/);
  assert.match(recover, /auth:\s*\{\s*mode:\s*'admin',\s*secret:\s*value\s*\}/);
  assert.match(html, /id="adminRecoverySecret"/);
  assert.match(html, /case 'recoveradmin'/);
  assert.match(html, /if \(field\) field\.value = ''/);
  assert.match(html, /purgeLegacyAdminSecret\(\)/);
  assert.match(html, /setAdminSession\(recovered\.token, recovered\.expiresAt\)/);
  assert.doesNotMatch(settings, /cfgSecret|savecfg|syncSecret/);
  assert.doesNotMatch(html, /case 'savecfg'/);
});

test('new PINs use 600k PBKDF2 and ten characters while legacy v1 remains readable', () => {
  assert.match(html, /PIN_KDF_LEGACY_ITERATIONS = 150000/);
  assert.match(html, /PIN_KDF_ITERATIONS = 600000/);
  assert.match(html, /adminPinVersion = 2/);
  assert.match(html, /legacy \? PIN_KDF_LEGACY_ITERATIONS : PIN_KDF_ITERATIONS/);
  assert.match(html, /vault\.version === 1 \? PIN_KDF_LEGACY_ITERATIONS : PIN_KDF_ITERATIONS/);
  assert.match(html, /version: 2, kdfIterations: PIN_KDF_ITERATIONS/);
  assert.match(html, /vault\.version !== 1 && vault\.version !== 2/);
  assert.equal((html.match(/v\.length < 10/g) || []).length, 2);
  assert.match(html, /10자 이상 입력해 주세요/);
});

test('a revoked old tab cannot delete the shared vault created by a new tab', () => {
  const pullOnly = html.match(/async pullOnly\(\)[\s\S]*?\n\s*async run\(\)/)?.[0] || '';
  const run = html.match(/async run\(\)[\s\S]*?\n\s*\/\*\* 장기 bearer/)?.[0] || '';
  const disconnect = html.match(/case 'disconnectadmin':[\s\S]*?\n\s*break;/)?.[0] || '';
  assert.ok(pullOnly);
  assert.ok(run);
  assert.match(pullOnly, /status === 401[\s\S]{0,180}clearAdminSession\(false\)/);
  assert.doesNotMatch(pullOnly, /status === 401[\s\S]{0,180}clearAdminSession\(true\)/);
  assert.match(run, /status === 401[\s\S]{0,180}clearAdminSession\(false\)/);
  assert.doesNotMatch(run, /status === 401[\s\S]{0,180}clearAdminSession\(true\)/);
  assert.match(disconnect, /clearAdminSession\(true\)/);
});
