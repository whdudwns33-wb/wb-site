const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('consult admin password recovery verifies the consult sync secret', () => {
  assert.match(html, /data-act="recoverpin"/);

  const recovery = html.match(/case 'recoverpinsave':[\s\S]*?\n\s*break;/)?.[0] || '';
  assert.match(recovery, /sync\.post\('\/sync'/);
  assert.match(recovery, /app: SYNC_APP/);
  assert.match(recovery, /auth: \{ mode: 'admin', secret: secret \}/);
  assert.match(recovery, /state\.settings\.adminPin = pin/);
  assert.match(recovery, /save\(\); session\.unlock\(\)/);
});

test('consult storage and sync identity stay isolated from task', () => {
  assert.match(html, /const LS_KEY = 'wb_consult_v1'/);
  assert.match(html, /const SYNC_APP = 'consult'/);
  assert.doesNotMatch(html, /const LS_KEY = 'wb_taskboard_v1'/);
});
