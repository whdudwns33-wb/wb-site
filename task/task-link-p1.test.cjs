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

test('personal QR links stay phone-first and expand to a tablet-native grid', () => {
  assert.match(html, /classList\.toggle\('person-mobile', HAS_PERSON_SCOPE\)/);
  assert.match(html, /html\.person-mobile body \{ width: 100%;[^}]*overflow-x: hidden;/);
  assert.match(html, /@media \(max-width: 720px\) \{[\s\S]{0,100}html\.person-mobile body \{ width: min\(100%, 480px\); \}/);
  assert.match(html, /html\.person-mobile \.grid2,[\s\S]{0,320}grid-template-columns: 1fr/);
  assert.match(html, /html\.person-mobile \.schedule-kpis,[\s\S]{0,80}grid-template-columns: repeat\(2,/);
  assert.match(html, /@media \(min-width: 721px\) \{[\s\S]*?html\.person-mobile \.grid2,[\s\S]*?html\.person-mobile \.today-task-grid,[\s\S]*?html\.person-mobile \.makeup-grid \{ grid-template-columns: repeat\(2,/);
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
  assert.match(html, /async function createVerifiedHandoffLink\(asQr\)/);
  assert.match(html, /const verified = await sync\.run\(\)/);
  assert.match(html, /개인 인증이 확인된 브라우저에서만/);
});

test('a stored device connection can be rechecked without consuming another link', () => {
  assert.match(html, /data-act="retryexistingauth">이 기기의 기존 연결 상태 확인/);
  assert.match(html, /data-act="retryexistingauth">이 기기의 기존 연결 다시 확인/);
  assert.match(html, /data-act="retryexistingauth">🔄 이 기기의 기존 연결 상태 확인/);
  assert.match(html, /case 'retryexistingauth': retryExistingPersonAuth\(el\)/);
  const retry = html.match(/async function retryExistingPersonAuth\(button\)[\s\S]*?\n}/)?.[0] || '';
  assert.match(retry, /hasStoredPersonToken\(\)/);
  assert.match(retry, /await sync\.run\(\)/);
  assert.match(retry, /verified && hasVerifiedPersonAuth\(\)/);
  assert.match(retry, /새 QR 또는 링크가 필요합니다/);
  assert.doesNotMatch(retry, /exchangeBootstrap|pendingBootstrapCode|issueBootstrap/, 'a used or revoked one-time link must never be resurrected');
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

test('only authentication failures discard verified access; transient sync failures keep it', () => {
  const run = html.match(/async run\(\) \{[\s\S]*?\n  \},/)?.[0] || '';
  const syncCatch = run.slice(run.indexOf('} catch (e) {'), run.indexOf('} finally {'));
  assert.match(run, /const authRejected = Number\(e && e\.status\) === 401 \|\| Number\(e && e\.status\) === 403/);
  assert.match(run, /if \(authRejected\) \{[\s\S]{0,160}handlePersonAuthRejection\(e, nextAccessRole === 'manager', problem\)/);
  assert.doesNotMatch(run, /catch \(e\) \{\s*console\.warn\('sync', e\);\s*this\.accessRole = ''/);
  assert.ok(syncCatch.indexOf('if (authRejected)') < syncCatch.indexOf('handlePersonAuthRejection'));
  const handoff = html.match(/async function createVerifiedHandoffLink\(asQr\)[\s\S]*?\n}/)?.[0] || '';
  assert.match(handoff, /if \(!verified\)/);
  assert.match(handoff, /동기화 상태를 확인하지 못했습니다 — 잠시 후 다시 시도해 주세요/);
  assert.match(handoff, /authLost/);
});

test('background sync does not redraw while a teacher is editing', () => {
  const run = html.match(/async run\(\) \{[\s\S]*?\n  \},/)?.[0] || '';
  const deferred = html.match(/function renderAfterSync\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(run, /renderAfterSync\(\)/);
  assert.match(deferred, /isTaskEditorActive\(\)/);
  assert.match(deferred, /syncRenderPending = true/);
  assert.match(html, /document\.addEventListener\('focusout',[\s\S]{0,180}renderAfterSync\(\)/);
  assert.match(html, /setCheck\(cntEl\.dataset\.id,[\s\S]{0,220}renderAfterSync\(\)/);
});

test('zero-change background sync does not collapse open dashboard details', () => {
  const run = html.match(/async run\(\) \{[\s\S]*?\n  \},/)?.[0] || '';
  assert.match(run, /let applied = 0/);
  assert.match(run, /applied \+= this\.apply\(d\.changes\)/);
  assert.match(run, /if \(applied \|\| needsAccessRender \|\| accessRoleChanged\) renderAfterSync\(\)/);
});

test('staff deactivation is one authoritative CAS operation with link revocation', () => {
  const block = html.match(/case 'delstaff':[\s\S]*?\n\s*break;/)?.[0] || '';
  assert.ok(block);
  assert.match(block, /개인 링크는 해지됩니다/);
  assert.match(block, /sync\.post\('\/staff-deactivate'/);
  assert.match(block, /expectedUpdatedAt: Number\(s\.updatedAt\) \|\| 0/);
  assert.match(block, /result && result\.staff && result\.staff\.data/);
  assert.match(block, /state\.staff\[index\] = saved/);
  assert.match(block, /clearLinkCode\(id\)/);
  assert.doesNotMatch(block, /s\.deleted\s*=|sync\.run\(\)\.then|sync\.revokeAccess/);
  assert.match(block, /STALE_REVISION/);
  assert.match(block, /BOARDING_LOCK/);
  assert.match(block, /탑승 중·미하차 학생을 모두 정리한 뒤 다시 시도/);
});

test('task managers elevate only from a verified server role', () => {
  const manager = html.match(/get isManager\(\) \{[\s\S]*?\n  }/)?.[0] || '';
  const run = html.match(/async run\(\) \{[\s\S]*?\n  \},/)?.[0] || '';
  assert.match(html, /personVerified: false, accessRole: ''/);
  assert.match(run, /d\.authRole !== 'manager' && d\.authRole !== 'staff'/);
  assert.match(run, /nextAccessRole = responseAccessRole/);
  assert.match(manager, /auth\.mode === 'person'/);
  assert.match(manager, /auth\.id === this\.staffId/);
  assert.match(manager, /sync\.personVerified && sync\.accessRole === 'manager'/);
  assert.doesNotMatch(manager, /staffById|staff\.manager/);
  assert.match(html, /get isAdmin\(\) \{ return this\.isManager \|\|/);
  assert.match(html, /운영 권한은 서버에서 별도 승인/);
  assert.match(html, /운영 권한은 서버 승인 대상에게만 열립니다/);
  assert.doesNotMatch(html, /관리 담당 기본값 · 개인 링크는 본인 범위/);
  const publish = html.match(/case 'wpublish':[\s\S]{0,900}?draft\.forEach/)?.[0] || '';
  assert.match(publish, /if \(!session\.isAdmin\) break/);
  assert.match(html, /origin: actor\(\)/);
  assert.doesNotMatch(html, /origin: session\.isStaffLink \? 'manager'/);
  assert.match(html, /const allowed = \['today', 'week', 'lesson', 'feedback', 'books', 'transport', 'roster'\]/);
  assert.match(html, /개인 링크에서는 담당 학생 명단만 확인할 수 있습니다/);
  for (const action of ['oplog', 'exlog']) {
    const block = html.match(new RegExp(`case '${action}':[\\s\\S]{0,220}?break;`))?.[0] || '';
    assert.match(block, /!session\.isAdmin/, action);
  }
  for (const action of ['exsave', 'opprog', 'opsave']) {
    const block = html.match(new RegExp(`case '${action}':[\\s\\S]{0,120}?break;`))?.[0] || '';
    assert.match(block, /!session\.isAdmin/, action);
  }
  const contactOpen = html.slice(html.indexOf("case 'ctlog':"), html.indexOf("case 'oplog':"));
  const contactSave = html.slice(html.indexOf("case 'ctsave':"), html.indexOf("case 'bkopen':"));
  for (const block of [contactOpen, contactSave]) {
    assert.match(block, /session\.isStaffLink/);
    assert.match(block, /t\.staffId === session\.staffId/);
    assert.match(block, /isLesson\(t\)/);
    assert.match(block, /!session\.isAdmin && !ownLesson/);
  }
});

test('manager downgrade and auth rejection purge the full person cache', () => {
  const run = html.match(/async run\(\) \{[\s\S]*?\n  \},/)?.[0] || '';
  const reset = html.match(/function resetPersonCache\(token\) \{[\s\S]*?\n}/)?.[0] || '';
  const rejection = html.match(/function handlePersonAuthRejection\(error, managerRoleSeen, knownProblem\) \{[\s\S]*?\n}/)?.[0] || '';
  assert.match(run, /const managerCacheDowngraded = responseAccessRole === 'staff'[\s\S]{0,120}hasSensitiveManagerCache\(previousAccessRole\)/);
  assert.match(run, /resetPersonCache\(auth\.token\)[\s\S]{0,80}location\.reload\(\)/);
  assert.ok(run.indexOf('resetPersonCache(auth.token)') < run.indexOf('applied += this.apply(d.changes)'));
  assert.match(run, /let nextAccessRole = '';[\s\S]{0,80}this\.busy = true/);
  assert.match(run, /handlePersonAuthRejection\(e, nextAccessRole === 'manager', problem\)/);
  assert.match(rejection, /resetPersonCache\(''\)/);
  assert.match(run, /state\.settings\.managerCacheSensitive = true/);
  assert.match(reset, /localStorage\.removeItem\(LS_KEY\)/);
  assert.match(reset, /state = blankState\(\)/);
  assert.match(reset, /state\.settings\.myToken = ''/);
  assert.match(reset, /delete state\.settings\.managerCacheSensitive/);
  assert.match(reset, /if \(keepToken\) state\.settings\.myToken = keepToken/);
  assert.match(reset, /if \(keepToken \|\| !removed\) save\(\)/);
  for (const cacheReset of [
    /rosterDb = null; rosterErr = ''; rosterLoading = false; privateBookStudents = \[\]/,
    /bookDb = null; bookDbErr = ''; bookDbLoading = false/,
    /guardianContacts = null; guardianContactsLoaded = false; guardianContactsLoading = false/,
    /feedbackQueue = \[\]; feedbackQueueLoaded = false; feedbackQueueLoading = false/,
    /lessonChangeQueue = \[\]; lessonChangeQueueLoaded = false; lessonChangeQueueLoading = false/,
    /bookAddQueue = \[\]; bookAddQueueLoaded = false; bookAddQueueLoading = false/,
    /bookEditQueue = \[\]; bookEditQueueLoaded = false; bookEditQueueLoading = false/,
    /linkCodeVault\.clear\(\)/
  ]) assert.match(reset, cacheReset);
});

test('direct personal API 401/403 purges sensitive UI once, while sync, root admin, and 5xx keep their paths', () => {
  const post = html.match(/async post\(path, body\) \{[\s\S]*?\n  \},/)?.[0] || '';
  const rejection = html.match(/function handlePersonAuthRejection\(error, managerRoleSeen, knownProblem\) \{[\s\S]*?\n}/)?.[0] || '';
  const handoff = html.match(/async function createVerifiedHandoffLink\(asQr\)[\s\S]*?\n}/)?.[0] || '';
  assert.match(post, /body && body\.auth && body\.auth\.mode === 'person'/);
  assert.match(post, /path !== '\/sync' && session\.isStaffLink && personRequest/);
  assert.match(post, /res\.status === 401 \|\| res\.status === 403/);
  assert.doesNotMatch(post, /res\.status >= 500[\s\S]{0,100}handlePersonAuthRejection/);
  assert.match(rejection, /resetPersonCache\(''\)/);
  assert.doesNotMatch(rejection, /\belse\b/);
  assert.match(rejection, /closeModal\(\);[\s\S]{0,40}render\(\);[\s\S]{0,40}location\.reload\(\)/);
  assert.match(rejection, /error\.personAuthHandled = true/);
  assert.match(handoff, /if \(!error\.personAuthHandled &&/);

  const exercise = new Function('managerRoleSeen', 'sensitive', `
    let personAccessProblem = null;
    const calls = [];
    const state = { settings: { myToken: 'token' } };
    const sync = { accessRole: 'manager', personVerified: true };
    const classifyPersonLinkError = () => ({ kind: 'auth_required' });
    const hasSensitiveManagerCache = () => sensitive;
    const resetPersonCache = () => { calls.push('reset'); sync.accessRole = ''; sync.personVerified = false; state.settings.myToken = ''; };
    const save = () => calls.push('save');
    const closeModal = () => calls.push('close');
    const render = () => calls.push('render');
    const location = { reload: () => calls.push('reload') };
    ${rejection}
    const error = { status: 401 };
    handlePersonAuthRejection(error, managerRoleSeen);
    return { calls, handled: error.personAuthHandled, token: state.settings.myToken,
      accessRole: sync.accessRole, verified: sync.personVerified };
  `);
  assert.deepEqual(exercise(true, false), {
    calls: ['reset', 'close', 'render', 'reload'], handled: true, token: '', accessRole: '', verified: false
  });
  assert.deepEqual(exercise(false, false), {
    calls: ['reset', 'close', 'render', 'reload'], handled: true, token: '', accessRole: '', verified: false
  });
});

test('staff cache is reloaded from zero when the server promotes it to manager', () => {
  const run = html.match(/async run\(\) \{[\s\S]*?\n  \},/)?.[0] || '';
  assert.match(run, /const scopedCacheUpgraded = responseAccessRole === 'manager'/);
  assert.match(run, /!hasSensitiveManagerCache\(previousAccessRole\) && Number\(state\.settings\.pullAt\) > 0/);
  assert.match(run, /managerCacheDowngraded \|\| scopedCacheUpgraded \|\| roleChangedDuringSync/);
  assert.ok(run.indexOf('scopedCacheUpgraded') < run.indexOf('applied += this.apply(d.changes)'));
});

test('reload then 401 purges every person cache, including a persisted manager cache', () => {
  const helper = html.match(/function hasSensitiveManagerCache\(previousRole\) \{[\s\S]*?\n}/)?.[0] || '';
  const detectsPersistedCache = new Function('sync', 'state',
    helper + '; return hasSensitiveManagerCache(\'\');');
  assert.equal(detectsPersistedCache({ accessRole: '' }, {
    settings: { managerCacheSensitive: true }
  }), true);
  const run = html.match(/async run\(\) \{[\s\S]*?\n  \},/)?.[0] || '';
  const rejection = html.match(/function handlePersonAuthRejection\(error, managerRoleSeen, knownProblem\) \{[\s\S]*?\n}/)?.[0] || '';
  assert.match(run, /Number\(e && e\.status\) === 401/);
  assert.match(run, /if \(authRejected\)[\s\S]{0,180}handlePersonAuthRejection/);
  assert.match(rejection, /resetPersonCache\(''\)/);
  const manager = html.match(/get isManager\(\) \{[\s\S]*?\n  }/)?.[0] || '';
  assert.doesNotMatch(manager, /managerCacheSensitive|hasSensitiveManagerCache/);
  const startup = html.match(/async function startSyncSession\(\) \{[\s\S]*?\n}/)?.[0] || '';
  assert.match(startup, /if \(!sync\.enabled\(\)\)[\s\S]{0,140}hasSensitiveManagerCache\(''\)[\s\S]{0,80}resetPersonCache\(''\)/);
});

test('manager lock clears personal auth and cache; root lock keeps its existing session-only behavior', () => {
  const sessionBlock = html.match(/const session = \{[\s\S]*?\n};/)?.[0] || '';
  const logout = html.match(/case 'logout': \{[\s\S]*?\n\s*}/)?.[0] || '';
  assert.match(sessionBlock, /sessionStorage\.removeItem\('wb_admin'\)/);
  assert.match(sessionBlock, /sync\.accessRole = ''/);
  assert.match(sessionBlock, /if \(!this\.isStaffLink\) return false/);
  assert.match(sessionBlock, /resetPersonCache\(''\)/);
  assert.ok(sessionBlock.indexOf('if (!this.isStaffLink) return false') < sessionBlock.indexOf("resetPersonCache('')"));
  assert.match(logout, /const reload = session\.lock\(\)/);
  assert.match(logout, /if \(reload\) location\.reload\(\)/);
  assert.match(html, /잠그면 이 기기의 개인 토큰과 업무 캐시를 모두 지웁니다/);
  assert.match(html, /서버가 확인한 관리 담당 개인 인증/);
});

test('manager authorship stays distinct from root admin and staff edits', () => {
  assert.match(html, /const actor = \(\) => session\.isManager \? 'manager' : session\.isAdmin \? 'admin' : 'staff'/);
  assert.match(html, /t\.lastEditBy = actor\(\)/);
  for (const label of ['관리 담당 발행', '원장 발행', '관리 담당 수정', '원장 수정', '직원 수정']) {
    assert.match(html, new RegExp(label));
  }
});

test('manager deep links survive startup until the server role is known; verified staff remains allowlisted', () => {
  const startupAt = html.indexOf('\nload();\nabsorbLinkParams();');
  const startup = html.slice(startupAt, html.indexOf('let syncLoopStarted', startupAt));
  const renderFn = html.match(/function render\(\) \{[\s\S]*?\n}/)?.[0] || '';
  assert.match(startup, /if \(h && !\/\(\^\|&\)c=\/\.test\(h\)\) route = h/);
  assert.doesNotMatch(startup, /session\.isStaffLink[\s\S]{0,180}route = 'today'/);
  assert.match(renderFn, /if \(shouldGatePersonAccess\(\)\)[\s\S]{0,120}return/);
  assert.match(renderFn, /if \(session\.isStaffLink && !session\.isAdmin\)[\s\S]{0,200}const allowed = \['today', 'week', 'lesson', 'feedback', 'books', 'transport', 'roster'\]/);
  assert.match(renderFn, /if \(!allowed\.includes\(route\)\) route = 'today'/);
  assert.ok(renderFn.indexOf('if (shouldGatePersonAccess())') <
    renderFn.indexOf('if (session.isStaffLink && !session.isAdmin)'));
});

test('a false sync result blocks the director report before its send request', () => {
  const settle = html.match(/async function settleSync\(\) \{[\s\S]*?\n}/)?.[0] || '';
  const submit = html.match(/async function submitDirectorReport\(button\) \{[\s\S]*?\n}/)?.[0] || '';
  assert.match(settle, /const synced = await sync\.run\(\)/);
  assert.match(settle, /if \(!synced\) throw new Error\('SYNC_FAILED'\)/);
  assert.ok(submit.indexOf('await settleSync()') <
    submit.indexOf("sync.post('/director-report-send'"));
});

test('managers remain employees for payroll while owners are excluded', () => {
  assert.match(html, /const teamStaff = \(\) => liveStaff\(\)\.filter\(s => !s\.owner\)/);
  assert.match(html, /const payrollStaff = \(\) => state\.staff\.filter\(s => !s\.owner\)/);
  assert.doesNotMatch(html, /payrollStaff[^\n]*manager/);
});

test('admin screens include staff QR and approval actions', () => {
  assert.match(html, /data-act="qrlink"/);
  assert.match(html, /case 'qrlink'/);
  assert.match(html, /auth\.mode !== 'admin' && !session\.isManager/);
  for (const action of ['fbreviewapprove', 'lcreviewapprove', 'bareviewapprove', 'bereviewapprove']) {
    assert.match(html, new RegExp(`case '${action}'`), action);
  }
});

test('admin recovery URL no longer embeds PIN or secret', () => {
  const block = html.match(/case 'adminlink':[\s\S]*?\n\s*break;/)?.[0] || '';
  assert.ok(block);
  assert.match(block, /copy\(location\.origin \+ location\.pathname,/);
  assert.doesNotMatch(block, /syncSecret|adminPin|\?s=/);
});
