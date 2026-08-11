const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('보호자 초대 링크는 Worker origin의 code-only fragment를 쓴다', () => {
  const start = html.indexOf('async function issueParentPortalInvite');
  const end = html.indexOf('async function saveGuardianPortalAccess', start);
  const source = html.slice(start, end);
  assert.match(source, /new URL\('\/', new URL\(SYNC_URL, location\.href\)\.origin\)/);
  assert.match(source, /link\.hash\s*=\s*new URLSearchParams\(\{ code: code \}\)\.toString\(\)/);
  assert.match(source, /\^\[a-f0-9\]\{48\}\$/);
  assert.doesNotMatch(source, /searchParams\.set\(['"]student/);
  assert.doesNotMatch(source, /searchParams\.set\(['"]code/);
  assert.doesNotMatch(source, /\.\.\/parent/);
});

test('보호자 웹앱 동의는 revision CAS로 저장하고 충돌 정본을 반영한다', () => {
  const start = html.indexOf('async function saveGuardianPortalAccess');
  const end = html.indexOf('function viewGuardianContactPanel', start);
  const source = html.slice(start, end);
  assert.match(source, /const expectedUpdatedAt\s*=\s*Number\(current && current\.updatedAt\) \|\| 0/);
  assert.match(source, /enabled: enabled, expectedUpdatedAt: expectedUpdatedAt/);
  assert.match(source, /ACCESS_REVISION_CONFLICT/);
  assert.match(source, /guardianPortalAccess\.set\(student\.id, error\.current\)/);
});

test('연락처 변경 후 웹앱 동의를 즉시 재검증하고 재동의 전에는 초대를 막는다', () => {
  const saveStart = html.indexOf('async function saveGuardianContact');
  const saveEnd = html.indexOf('async function saveGuardianOpsConsent', saveStart);
  const saveSource = html.slice(saveStart, saveEnd);
  assert.match(saveSource, /refreshGuardianPortalAccess\(auth\)/);

  const inviteStart = html.indexOf('async function issueParentPortalInvite');
  const inviteEnd = html.indexOf('async function saveGuardianPortalAccess', inviteStart);
  const inviteSource = html.slice(inviteStart, inviteEnd);
  assert.match(inviteSource, /access && access\.needsReconsent/);
  assert.match(html, /portal\.needsReconsent/);
  assert.match(html, /웹앱 재동의 필요/);
});
