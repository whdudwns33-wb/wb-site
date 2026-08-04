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
  assert.match(html, /새 개인 링크가 필요합니다/);
});

test('authenticated staff can create a browser handoff link', () => {
  assert.match(html, /data-act="handoff"/);
  assert.match(html, /async handoff\(\)/);
  assert.match(html, /\/handoff/);
  assert.match(html, /10분 안에 새 브라우저/);
});

test('personal links never unlock manager or student-record write screens', () => {
  assert.match(html, /const isManager = \(\) => false/);
  assert.match(html, /const allowed = \['today', 'week', 'lesson', 'feedback', 'books', 'roster'\]/);
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

test('admin recovery URL no longer embeds PIN or secret', () => {
  const block = html.match(/case 'adminlink':[\s\S]*?\n\s*break;/)?.[0] || '';
  assert.ok(block);
  assert.match(block, /copy\(location\.origin \+ location\.pathname\)/);
  assert.doesNotMatch(block, /syncSecret|adminPin|\?s=/);
});
