const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function block(from, to) {
  const start = html.indexOf(from);
  const end = html.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `${from} 블록을 찾을 수 없습니다`);
  return html.slice(start, end);
}

test('feedback, makeup, session, and portal consents are separate stable-student settings', () => {
  const settings = block('let guardianContacts = null;', '/* ── 설정 ── */');

  assert.match(settings, /let guardianOpsConsents = new Map\(\)/);
  assert.match(settings, /sync\.post\('\/guardian-ops-send', \{ app: SYNC_APP, auth: auth, action: 'consent_list' \}\)/);
  assert.match(settings, /guardianOpsConsents\.get\(s\.id\)/);
  assert.doesNotMatch(settings, /guardianOpsConsents\.get\(s\.name\)/);
  assert.match(settings, /scope별 \{consent,updatedAt,needsReconsent\}/);
  assert.match(settings, /current\[row\.scope\] = normalizeGuardianOpsConsent\(row\)/);
  assert.match(settings, /수업 피드백 알림톡 동의/);
  assert.match(settings, /보강 알림 동의/);
  assert.match(settings, /회차 안내 동의/);
  assert.match(settings, /action: 'consent_set', studentId: student\.id/);
  assert.match(settings, /scope: scope, consent: consent, expectedUpdatedAt: expectedUpdatedAt/);
  assert.match(settings, /data-scope="makeup"/);
  assert.match(settings, /data-scope="session"/);
  assert.match(settings, /if \(!session\.isAdmin \|\| !\['makeup', 'session'\]\.includes\(scope\)\) return/);
});

test('ops consent CAS preserves revision/reconsent state and applies a 409 current response', () => {
  const settings = block('let guardianContacts = null;', '/* ── 설정 ── */');
  const save = block('async function saveGuardianOpsConsent', 'async function issueParentPortalInvite');

  assert.match(settings, /return \{ consent: false, updatedAt: 0, needsReconsent: false \}/);
  assert.match(settings, /updatedAt: Number\(row && row\.updatedAt\) \|\| 0/);
  assert.match(settings, /needsReconsent: !!\(row && row\.needsReconsent\)/);
  assert.match(save, /const expectedUpdatedAt = Number\(before\.updatedAt\) \|\| 0/);
  assert.match(save, /CONSENT_REVISION_CONFLICT/);
  assert.match(save, /scopes\[scope\] = normalizeGuardianOpsConsent\(error\.current\)/);
  assert.match(settings, /보호자 정보 변경 · 보강 알림 재동의 필요/);
  assert.match(settings, /보호자 정보 변경 · 회차 안내 재동의 필요/);
  assert.match(settings, /await refreshGuardianOpsConsents\(auth\)/,
    '보호자 연락처 저장 후 identity-bound 동의 상태를 다시 읽어야 한다');
});

test('allowlisted manager uses the same guarded admin UI, while ordinary personal links cannot operate it', () => {
  const sessionBlock = block('const session = {', 'let route =');
  const send = block('async function requestGuardianOpsSend(target)', '/* ── 회차제 수업');
  const settings = block('async function loadGuardianContacts(force)', 'async function saveGuardianContact');

  assert.match(sessionBlock, /get isAdmin\(\) \{ return this\.isManager \|\|/);
  assert.match(sessionBlock, /sync\.accessRole === 'manager'/);
  assert.match(send, /if \(!session\.isAdmin \|\| !target\) return/);
  assert.match(settings, /if \(!session\.isAdmin \|\| guardianContactsLoading/);
  assert.doesNotMatch(send, /fetch\s*\(/);
});

test('manual delivery always previews, stops on blockers, confirms, and only then requests send', () => {
  const source = block('async function requestGuardianOpsSend(target)', '/* ── 회차제 수업');
  const workflow = block('/* ── 보강·회차 보호자 운영 알림톡', '/* ── 회차제 수업');
  const previewAt = source.indexOf("action: 'preview'");
  const stoppedAt = source.indexOf('const stopped = guardianOpsPreviewState(preview)');
  const confirmAt = source.indexOf('if (!confirm(');
  const sendAt = source.indexOf("action: 'send'");

  assert.ok(previewAt >= 0 && previewAt < stoppedAt && stoppedAt < confirmAt && confirmAt < sendAt);
  assert.match(source, /if \(stopped\) \{[\s\S]*?return;[\s\S]*?\}/);
  assert.match(workflow, /SEND_DISABLED/);
  assert.match(workflow, /TEMPLATE_NOT_APPROVED/);
  assert.match(workflow, /PORTAL_RECONSENT_REQUIRED/);
  assert.match(workflow, /SOURCE_CHANGED_BEFORE_DISPATCH/);
  assert.match(source, /eventType: target\.eventType,[\s\S]*?sourceId: target\.sourceId, revision: Number\(target\.revision\)/);
  assert.doesNotMatch(source, /phone\s*:|recipient\s*:|message\s*:|\bto\s*:/i);
});

test('preview state prevents duplicate or uncertain resend and permits only a ready/rejected retry', () => {
  const source = block('function guardianOpsPreviewState(preview)', 'async function requestGuardianOpsSend');
  const fn = new Function(`${source}\nreturn guardianOpsPreviewState;`)();

  assert.deepEqual(fn({ blocker: 'ALREADY_ACCEPTED', prior: { status: 'accepted' } }), {
    kind: 'accepted', idempotent: true
  });
  assert.deepEqual(fn({ blocker: 'PRIOR_SEND_UNCERTAIN', prior: { status: 'unknown' } }), {
    kind: 'unknown', code: 'PRIOR_SEND_UNCERTAIN'
  });
  assert.deepEqual(fn({ blocker: 'TEMPLATE_NOT_APPROVED', ready: false }), {
    kind: 'blocked', code: 'TEMPLATE_NOT_APPROVED'
  });
  assert.equal(fn({ prior: { status: 'rejected' }, retryAllowed: true, ready: true }), null);
});

test('accepted, rejected, and unknown have exact non-delivery wording', () => {
  const source = block('function guardianOpsStateText(state, emptyText)', 'function guardianOpsButtonHtml');

  assert.match(source, /이미 접수된 동일 이벤트입니다/);
  assert.match(source, /알림톡 요청 접수/);
  assert.match(source, /알림톡 요청 거절 · 다시 확인 필요/);
  assert.match(source, /알림톡 접수 여부 불명 · 확인 전 재요청 금지/);
  assert.doesNotMatch(source, /발송 완료|전송 완료|전달 완료|수신 ?완료|보호자께 보냈/);
});

test('makeup notification-needed cards expose the admin manual status/send action at event revision', () => {
  const target = block('function guardianOpsTargetForMakeup(caseId)', 'function guardianOpsTargetForSession');
  const notification = block('function makeupNotificationHtml(row, initialLabel)', 'function makeupCard(row)');
  const card = block('function makeupCard(row)', 'function makeupKpis(rows)');

  assert.match(target, /row\.notificationNeeded/);
  assert.match(target, /row\.notificationEventRevision/);
  for (const event of ['makeup_proposal', 'makeup_confirmed', 'makeup_cancelled']) {
    assert.match(target, new RegExp(event));
  }
  assert.match(notification, /if \(!row\.notificationNeeded\) return ''/);
  assert.match(notification, /session\.isAdmin && target/);
  assert.match(notification, /알림톡 상태 확인·보내기/);
  assert.match(card, /makeupNotificationHtml\(row/);
});

test('active session cards offer a manual current-balance notice only to admin/manager', () => {
  const source = block('function sessionPackOpsNoticeHtml(pack)', 'function sessionPackStaffRecordHtml(pack)');
  const card = block('function sessionPackCard(pack)', 'function viewSessionPacks()');

  assert.match(source, /if \(!session\.isAdmin \|\| !pack \|\| pack\.status !== 'active'\) return ''/);
  assert.match(source, /opsSessionTarget\(pack\.packId\)/);
  assert.match(source, /현재 회차 보호자 안내/);
  assert.match(source, /자동발송 없음 · 수동 접수 전/);
  assert.match(card, /sessionPackOpsNoticeHtml\(pack\)/);
});

test('send actions are click-only and use the existing authenticated sync error path', () => {
  const click = block("case 'gcsave':", '/* 날짜 */');
  const request = block('async function requestGuardianOpsSend(target)', '/* ── 회차제 수업');

  assert.match(click, /case 'guardianopsmakeup': requestGuardianOpsSend\(guardianOpsTargetForMakeup/);
  assert.match(click, /case 'opssessionnotice': requestGuardianOpsSend\(opsSessionTarget/);
  assert.equal((html.match(/requestGuardianOpsSend\(/g) || []).length, 3, '정의와 두 명시 클릭 외 자동 호출이 없어야 한다');
  assert.match(request, /sync\.post\('\/guardian-ops-send'/);
  assert.match(request, /error && error\.personAuthHandled/);
});

test('operational card responses never render or expand guardian phone data', () => {
  const source = block('/* ── 보강·회차 보호자 운영 알림톡', '/* ── 회차제 수업');

  assert.doesNotMatch(source, /result\.phone|preview\.phone|guardian\.phone|recipientPhone|phoneNumber|\bto\s*:/i);
  assert.doesNotMatch(source, /error\.message[\s\S]{0,80}guardian-ops-status/);
});

test('consent and transient send state are cleared when person/admin cache is reset', () => {
  const reset = block('function resetPersonCache(token)', '/** 개인 bearer가 거절되면');

  assert.match(reset, /guardianOpsConsents = new Map\(\); guardianOpsConsentsError = ''/);
  assert.match(reset, /guardianOpsSendStates = new Map\(\)/);
});

test('mobile controls are 44px, keyboard-focused, and status is announced politely', () => {
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const source = block('function guardianOpsStatusHtml(target, emptyText)', 'function repaintGuardianOpsTarget');

  assert.match(css, /\.guardian-ops-action \.btn, \.ops-notice-action \.btn \{ min-height: 44px; \}/);
  assert.match(css, /\.guardian-ops-consent \{ min-height: 44px/);
  assert.match(css, /\.guardian-ops-save \{ min-height: 44px; \}/);
  assert.match(css, /\.guardian-ops-action \.btn:focus-visible,[\s\S]{0,100}\.guardian-ops-consent:focus-within/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.guardian-ops-action, \.ops-notice-action \{ display: grid; grid-template-columns: 1fr; \}/);
  assert.match(source, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(source, /aria-describedby/);
});
