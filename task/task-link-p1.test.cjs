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

test('bootstrap is exchanged only by an explicit final-browser connect action', () => {
  const startupStart = html.indexOf('async function startSyncSession()');
  const startupEnd = html.indexOf('startSyncSession();', startupStart);
  const startup = startupStart >= 0 && startupEnd > startupStart ? html.slice(startupStart, startupEnd) : '';
  const connect = html.match(/async function connectPendingDevice\(\)[\s\S]*?\n}/)?.[0] || '';
  const pendingBranch = startup.match(/if \(pendingBootstrapCode\) \{[\s\S]*?\n  \}/)?.[0] || '';
  assert.ok(startup);
  assert.ok(connect);
  assert.ok(pendingBranch);
  assert.doesNotMatch(startup, /exchangeBootstrap/);
  assert.match(connect, /IS_KAKAO_IN_APP/);
  assert.match(connect, /exchangeBootstrap\(session\.staffId, code\)/);
  assert.match(connect, /scrubBootstrapCodeFromAddress\(\)/);
  assert.ok(connect.indexOf('exchangeBootstrap') < connect.indexOf('scrubBootstrapCodeFromAddress'));
  assert.doesNotMatch(pendingBranch, /hasStoredPersonToken|sync\.run/);
});

test('Kakao in-app preserves the original code and guides users to a final browser', () => {
  assert.match(html, /function isKakaoInAppBrowser/);
  assert.match(html, /KAKAOTALK/);
  assert.match(html, /카카오톡 안에서는 아직 연결하지 않습니다/);
  assert.match(html, /data-act="copyentrylink"/);
  assert.match(html, /data-act="shareentrylink"/);
  const absorb = html.match(/function absorbLinkParams\(\)[\s\S]*?\n}/)?.[0] || '';
  assert.match(absorb, /pendingBootstrapCode = decodeURIComponent/);
  assert.doesNotMatch(absorb, /exchangeBootstrap/);
});

test('copy reports the actual result and every admin share action issues a fresh code', () => {
  const copy = html.match(/async function copy\(text, successMessage\)[\s\S]*?\n}/)?.[0] || '';
  assert.match(copy, /document\.execCommand\('copy'\) === true/);
  assert.match(copy, /return copied/);
  assert.doesNotMatch(html, /function ensureLinkCode/);
  assert.match(html, /case 'copylink':[\s\S]{0,180}issueLinkCode\(id\)/);
  assert.match(html, /case 'alllinks':[\s\S]{0,240}issueLinkCode\(s\.id\)/);
  assert.doesNotMatch(html, /case 'copylink':[\s\S]{0,240}finally\(\(\) => clearLinkCode/);
});

test('authenticated staff can create a browser handoff link', () => {
  assert.match(html, /data-act="handoff"/);
  assert.match(html, /async handoff\(\)/);
  assert.match(html, /\/handoff/);
  assert.match(html, /hasVerifiedPersonAuth\(\)/);
  assert.match(html, /async function createVerifiedHandoffLink/);
  assert.match(html, /const verified = await sync\.run\(\)/);
  assert.match(html, /개인 인증이 확인된 브라우저에서만/);
});

test('link and session failures have distinct user guidance', () => {
  for (const code of ['LINK_USED', 'LINK_EXPIRED', 'LINK_REPLACED', 'LINK_INVALID', 'AUTH_REQUIRED']) {
    assert.match(html, new RegExp(code));
  }
  assert.match(html, /storage_split/);
  const classifier = html.match(/function classifyPersonLinkError\(error, phase\)[\s\S]*?\n}/)?.[0] || '';
  assert.match(html, /code_missing/);
  assert.match(html, /카카오톡 화면과 Safari·Chrome은 인증 저장소를 서로 공유하지 않습니다/);
  assert.match(classifier, /phase === 'session' && status === 401/);
  assert.doesNotMatch(classifier, /status === 403/);
});

test('transient sync failures keep a verified bearer and do not demand a replacement link', () => {
  assert.doesNotMatch(html, /if \(session\.isStaffLink\) \{\s*this\.personVerified = false;\s*const problem/);
  assert.match(html, /if \(problem\.kind === 'session_expired'[\s\S]{0,220}this\.personVerified = false/);
  const handoff = html.match(/async function createVerifiedHandoffLink\(\)[\s\S]*?\n}/)?.[0] || '';
  assert.match(handoff, /if \(!verified\)/);
  assert.match(handoff, /동기화 상태를 확인하지 못했습니다 — 잠시 후 다시 시도해 주세요/);
  assert.match(handoff, /authLost/);
});

test('deleting staff also revokes personal links and sessions', () => {
  const block = html.match(/case 'delstaff':[\s\S]*?\n\s*break;/)?.[0] || '';
  assert.ok(block);
  assert.match(block, /sync\.revokeAccess\(id\)/);
  assert.match(block, /개인 링크는 해지됩니다/);
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
  assert.match(block, /copy\(location\.origin \+ location\.pathname,/);
  assert.doesNotMatch(block, /syncSecret|adminPin|\?s=/);
});
