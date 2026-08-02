const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const shell = require('./learning-shell.js');
const platform = require('./learning-platform.js');
const persistence = require('./learning-persistence.js');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem(key) { return data.has(String(key)) ? data.get(String(key)) : null; },
    setItem(key, value) { data.set(String(key), String(value)); },
    removeItem(key) { data.delete(String(key)); },
    parsed(key) { const raw = data.get(String(key)); return raw ? JSON.parse(raw) : null; }
  };
}

test('consult legacy secrets move to session once, persistent copies are scrubbed, and bearer stays intact', () => {
  const start = html.indexOf("const CONSULT_ADMIN_SECRET_SESSION_KEY = 'wb_consult_admin_secret_v1';");
  const end = html.indexOf('\nconst uid =', start);
  assert.ok(start >= 0 && end > start);
  const block = html.slice(start, end);
  const context = { sessionStorage: memoryStorage(), console: { warn() {} } };
  vm.createContext(context);
  vm.runInContext(block + '\nthis.__api = { getConsultAdminSecret, setConsultAdminSecret, removeAdminSecretFromState, scrubPersistentAdminSecrets };', context);
  const persistent = memoryStorage({
    scoped: JSON.stringify({ settings: { syncSecret: 'scoped-value', centerName: 'WB' } }),
    legacy: JSON.stringify({ settings: { syncSecret: 'legacy-value' } })
  });
  assert.equal(context.__api.scrubPersistentAdminSecrets(persistent, context.sessionStorage, ['scoped', 'legacy'], true), true);
  assert.equal(context.__api.getConsultAdminSecret(context.sessionStorage), 'scoped-value');
  assert.equal(Object.hasOwn(persistent.parsed('scoped').settings, 'syncSecret'), false);
  assert.equal(Object.hasOwn(persistent.parsed('legacy').settings, 'syncSecret'), false);
  const state = { settings: { syncSecret: 'must-not-persist', myToken: 'personal-bearer' } };
  context.__api.removeAdminSecretFromState(state);
  assert.equal(Object.hasOwn(state.settings, 'syncSecret'), false);
  assert.equal(state.settings.myToken, 'personal-bearer');
  const personalSession = memoryStorage();
  const personal = memoryStorage({ person: JSON.stringify({ settings: { syncSecret: 'legacy-admin', myToken: 'bearer' } }) });
  assert.equal(context.__api.scrubPersistentAdminSecrets(personal, personalSession, ['person'], false), false);
  assert.equal(context.__api.getConsultAdminSecret(personalSession), '');
  assert.equal(personal.parsed('person').settings.myToken, 'bearer');
  assert.equal(Object.hasOwn(personal.parsed('person').settings, 'syncSecret'), false);
});

test('consult backup import and export strip legacy per-staff tokens without touching personal bearer settings', () => {
  const start = html.indexOf('function staffWithoutLegacyTokens');
  const end = html.indexOf('\nfunction migrateLegacyStaffTokens', start);
  assert.ok(start >= 0 && end > start);
  const context = {};
  vm.createContext(context);
  vm.runInContext(html.slice(start, end) + '\nthis.__sanitize = staffWithoutLegacyTokens;', context);
  const staff = [{ id: 'S1', name: '학생', token: 'legacy-link-token' }, { id: 'S2', name: '학생2' }];
  const sanitized = context.__sanitize(staff);
  assert.equal(Object.hasOwn(sanitized[0], 'token'), false);
  assert.equal(sanitized[0].name, '학생');
  assert.equal(staff[0].token, 'legacy-link-token');
  const exported = html.slice(html.indexOf("case 'export':"), html.indexOf("case 'import':"));
  const imported = html.slice(html.indexOf("case 'import':"), html.indexOf("case 'lpinit':"));
  assert.match(exported, /staff: staffWithoutLegacyTokens\(state\.staff\)/);
  assert.match(imported, /staff: staffWithoutLegacyTokens\(p\.staff\)/);
  assert.match(imported, /myToken: state\.settings\.myToken/);
  assert.doesNotMatch(exported, /staff: state\.staff/);
  assert.doesNotMatch(imported, /staff: p\.staff/);
});

test('consult save, learning save, auth, import, export and settings text exclude persistent admin secret', () => {
  const blank = html.slice(html.indexOf('function blankState()'), html.indexOf('\nlet state = blankState()'));
  const save = html.slice(html.indexOf('function save()'), html.indexOf('\nfunction linkCodeFor'));
  const authStart = html.indexOf('  auth() {');
  const auth = html.slice(authStart, html.indexOf('\n  enabled()', authStart));
  const settingsStart = html.indexOf('function viewSettings()');
  const settings = html.slice(settingsStart, html.indexOf('\n/* ═', settingsStart));
  const exported = html.slice(html.indexOf("case 'export':"), html.indexOf("case 'import':"));
  const imported = html.slice(html.indexOf("case 'import':"), html.indexOf("case 'lpinit':"));
  const claimSave = html.slice(html.indexOf('function saveLearningClaim'), html.indexOf('\nfunction clearLearningClaim'));
  const learningSave = html.slice(html.indexOf('function saveLearningState'), html.indexOf('\nfunction viewLearning'));
  assert.doesNotMatch(blank, /syncSecret/);
  assert.match(save, /removeAdminSecretFromState\(state\)/);
  assert.doesNotMatch(auth, /state\.settings\.syncSecret/);
  assert.match(auth, /getConsultAdminSecret\(\)/);
  assert.doesNotMatch(exported, /syncSecret/);
  assert.doesNotMatch(imported, /syncSecret:/);
  assert.match(claimSave, /removeAdminSecretFromState\(candidateState\)/);
  assert.match(learningSave, /removeAdminSecretFromState\(candidateState\)/);
  assert.match(settings, /현재 브라우저 탭 세션에만/);
  assert.match(settings, /탭을 닫거나 화면을 잠그면/);
  assert.doesNotMatch(settings, /저장됨 · 변경할 때만/);
});

function focusNode(document, name) {
  return {
    name, tabIndex: 0,
    focus() { document.activeElement = this; this.focusCount = (this.focusCount || 0) + 1; },
    getAttribute() { return null; }, hasAttribute() { return false; }
  };
}

test('consult dialog runtime executes initial focus, tab trap, Escape close and opener focus return', () => {
  const start = html.indexOf('let modalReturnFocus = null;');
  const end = html.indexOf('\nfunction b64(', start);
  assert.ok(start >= 0 && end > start);
  const block = html.slice(start, end);
  const listeners = new Map();
  const document = {
    activeElement: null,
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type, handler) { if (listeners.get(type) === handler) listeners.delete(type); },
    contains(node) { return Boolean(node && node.connected !== false); }
  };
  const opener = focusNode(document, 'opener');
  const first = focusNode(document, 'first');
  const last = focusNode(document, 'last');
  const box = focusNode(document, 'box');
  box.querySelectorAll = () => [first, last];
  box.querySelector = () => null;
  box.contains = node => node === first || node === last || node === box;
  const host = { innerHTML: '' };
  document.activeElement = opener;
  const context = {
    document, requestAnimationFrame(callback) { callback(); }, esc(value) { return String(value); },
    $: selector => selector === '#modalHost' ? host : (selector === '#modalHost .modal-box' && host.innerHTML ? box : null)
  };
  vm.createContext(context);
  vm.runInContext(block + '\nthis.__modal = { modal, closeModal };', context);
  context.__modal.modal('시험 대화상자', '<input>', '');
  assert.match(host.innerHTML, /role="dialog"/);
  assert.match(host.innerHTML, /aria-modal="true"/);
  assert.match(host.innerHTML, /aria-labelledby="wb-modal-title-1"/);
  assert.equal(document.activeElement, first);
  document.activeElement = last;
  let prevented = false;
  listeners.get('keydown')({ key: 'Tab', shiftKey: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(document.activeElement, first);
  document.activeElement = first;
  listeners.get('keydown')({ key: 'Tab', shiftKey: true, preventDefault() {} });
  assert.equal(document.activeElement, last);
  listeners.get('keydown')({ key: 'Escape', shiftKey: false, preventDefault() {} });
  assert.equal(host.innerHTML, '');
  assert.equal(document.activeElement, opener);
  assert.equal(listeners.has('keydown'), false);
});

function assertAllControlsNamed(markup, label) {
  const controls = markup.match(/<(?:input|select|textarea)\b[^>]*>/g) || [];
  assert.ok(controls.length > 0, label + ' must render controls');
  const unnamed = controls.filter(tag => !/\baria-label="[^"]+"/.test(tag));
  assert.deepEqual(unnamed, [], label + ' has unnamed controls: ' + unnamed.join(' | '));
}

test('all rendered learning management controls and initial/import controls have accessible names', () => {
  let state = shell.createInitialState({ studentCode: 'STU-A11Y', displayName: '접근성', academicStage: 'elementary', grade: 3 });
  assertAllControlsNamed(shell.renderManagementControls(state, { canManage: true, today: '2026-08-03' }), 'base management');
  state = shell.applyCommand(state, { type: 'planner_add', date: '2026-08-03', title: '읽기', minutes: 20 }, {});
  const item = state.plannerItems[0];
  state = shell.applyCompletionClaims(state, [{ itemId: item.itemId, expectedRevision: item.revision, date: item.date, claimedAt: '2026-08-03T09:00:00.000Z' }]);
  assertAllControlsNamed(shell.renderManagementControls(state, { canManage: true, today: '2026-08-03' }), 'planner management');
  state = shell.applyCommand(state, { type: 'campaign_add', campaignType: 'kmt', title: 'KMT', examDate: '2026-10-01' }, {});
  assertAllControlsNamed(shell.renderManagementControls(state, { canManage: true, today: '2026-08-03' }), 'campaign management');
  state = shell.applyCommand(state, { type: 'wrong_add', textbookId: 'BOOK', page: '1', problemNo: '2', skillCode: 'fraction' }, {});
  assertAllControlsNamed(shell.renderManagementControls(state, { canManage: true, today: '2026-08-03' }), 'wrong-answer management');
  const initial = html.slice(html.indexOf('function viewLearning()'), html.indexOf('\nfunction mountLearningView'));
  for (const id of ['lpInitStage', 'lpInitGrade', 'lpInitSchedules']) {
    const tag = initial.match(new RegExp('<(?:input|select)[^>]*id="' + id + '"[^>]*>'));
    assert.ok(tag && /aria-label="[^"]+"/.test(tag[0]), id + ' needs aria-label');
  }
  assert.match(html, /data-lp-import-row[^>]*aria-label=/);
});

test('consult toast, overlay, warning contrast and mobile management wrapping stay present', () => {
  assert.match(html, /id="toast" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(html, /class="modal" data-act="closemodal"/);
  assert.match(html, /ev\.target\.closest\('\.modal-box'\)/);
  assert.match(html, /\.btn-warn \{[^}]*color: #9A3412/);
  assert.match(html, /\.pill\.warn \{[^}]*color: #9A3412/);
  assert.match(html, /@media \(max-width: 520px\)/);
  assert.match(html, /#view \.card \.row, \.modal-box \.row \{ flex-wrap: wrap; \}/);
  assert.match(html, /min-width: 0/);
});


test('one-year 69-item planner saves below 52 KiB and reloads without semantic loss', () => {
  let learning = shell.createInitialState({
    studentCode: 'STU-YEAR', displayName: '연간 일정', academicStage: 'elementary', grade: 3
  });
  learning = shell.addStandardSchedules(learning, { fromDate: '2026-08-03', weekday: 5 });
  assert.equal(learning.plannerItems.length, 69);

  const first = platform.createPlannerItem(Object.assign({}, learning.plannerItems[0], {
    status: 'verification_waiting',
    evidenceRefs: ['claim:reading-log-1'],
    verificationEvidenceRefs: ['teacher-check:1'],
    verificationDecision: 'pending',
    updatedAt: '2026-08-03T10:00:00.000Z',
    updatedBy: 'teacher-1',
    revision: 7,
    history: learning.plannerItems[0].history.concat([{
      action: 'completion_claimed', fromStatus: 'planned', toStatus: 'verification_waiting',
      at: '2026-08-03T10:00:00.000Z', actor: 'student-1', evidenceRef: 'claim:reading-log-1'
    }])
  }));
  first.audit = [{ event: 'manual_review', at: '2026-08-03T10:05:00.000Z', actor: 'teacher-1' }];
  first.latestResult = { score: 9, maxScore: 10, evidenceRef: 'result:1' };
  first.droppedCount = 0;
  learning.plannerItems[0] = first;

  const saveSource = html.slice(html.indexOf('function learningPlanWriteFor'), html.indexOf('\nfunction viewLearning'));
  assert.match(saveSource, /compactPlannerItemsForStorage/);
  const storage = memoryStorage();
  let mutationSequence = 0;
  const context = {
    WBLearningShell: shell,
    WBLearningPersistence: persistence,
    WBLearningPlatform: platform,
    TextEncoder,
    localStorage: storage,
    LS_KEY: 'consult-test',
    state: { checks: {}, settings: { myToken: 'personal-bearer' } },
    lpCanManage() { return true; },
    normalizeLpImportLedger(value) { return value; },
    lpClaimsFor() { return []; },
    lpPartKey(prefix, studentId) { return '__' + prefix + '__' + studentId; },
    ckey(taskId, date) { return taskId + '|' + date; },
    now() { return '2026-08-03T10:10:00.000Z'; },
    removeAdminSecretFromState(candidate) {
      if (candidate.settings) delete candidate.settings.syncSecret;
      return candidate;
    },
    queueSync() {},
    uid() { mutationSequence += 1; return 'mutation-' + mutationSequence; }
  };
  vm.createContext(context);
  vm.runInContext(saveSource + '\nthis.__saveLearningState = saveLearningState;', context);
  context.__saveLearningState(learning.student.studentCode, learning);

  const saved = storage.parsed('consult-test');
  const record = prefix => saved.checks['__' + prefix + '__' + learning.student.studentCode + '|all'];
  const initialPlanRecord = record('lpplan');
  const compactPlan = initialPlanRecord.value;
  assert.match(initialPlanRecord.planMutation.id, /^lpm_/);
  assert.match(initialPlanRecord.planMutation.id, /^[A-Za-z0-9_-]{1,128}$/);
  assert.equal(initialPlanRecord.planMutation.items.length, 69);
  assert.equal(initialPlanRecord.planMutation.items.every(item => item.baseRevision === 0 && item.nextRevision >= 1), true);
  assert.ok(Buffer.byteLength(JSON.stringify(compactPlan), 'utf8') <= 52 * 1024);
  const restoredPlan = persistence.restorePlannerItemsFromStorage(compactPlan, platform.createPlannerItem);
  assert.equal(persistence.plannerItemsSemanticallyEqual(learning.plannerItems, compactPlan, platform.createPlannerItem), true);
  assert.deepEqual(restoredPlan[0].audit, first.audit);
  assert.deepEqual(restoredPlan[0].latestResult, first.latestResult);
  assert.deepEqual(compactPlan[0].evidenceRefs, first.evidenceRefs);
  assert.deepEqual(compactPlan[0].verificationEvidenceRefs, first.verificationEvidenceRefs);
  assert.deepEqual(compactPlan[0].audit, first.audit);
  assert.deepEqual(compactPlan[0].latestResult, first.latestResult);
  assert.equal(compactPlan[0].droppedCount, 0);
  const generated = compactPlan.find(item => item.itemId === learning.plannerItems[1].itemId);
  assert.equal(Object.hasOwn(generated, 'history'), false);
  assert.equal(Object.hasOwn(generated, 'detail'), false);
  assert.equal(Object.hasOwn(generated, 'evidenceRefs'), false);

  const unchangedPlanRecord = JSON.stringify(initialPlanRecord);
  context.__saveLearningState(learning.student.studentCode, learning);
  const unchangedSaved = storage.parsed('consult-test');
  assert.equal(JSON.stringify(unchangedSaved.checks['__lpplan__STU-YEAR|all']), unchangedPlanRecord);

  const changedLearning = JSON.parse(JSON.stringify(learning));
  const changedBefore = changedLearning.plannerItems[1];
  changedLearning.plannerItems[1] = platform.createPlannerItem(Object.assign({}, changedBefore, {
    minutes: changedBefore.minutes + 5,
    revision: changedBefore.revision + 1,
    updatedAt: '2026-08-03T10:20:00.000Z',
    updatedBy: 'teacher-2',
    history: changedBefore.history.concat([{
      action: 'edited', fromStatus: changedBefore.status, toStatus: changedBefore.status,
      at: '2026-08-03T10:20:00.000Z', actor: 'teacher-2', changes: { minutes: true }
    }])
  }));
  context.__saveLearningState(changedLearning.student.studentCode, changedLearning);
  const changedRecord = storage.parsed('consult-test').checks['__lpplan__STU-YEAR|all'];
  assert.deepEqual(changedRecord.planMutation.items, [{
    itemId: changedBefore.itemId,
    baseRevision: changedBefore.revision,
    nextRevision: changedBefore.revision + 1
  }]);
  const deletedLearning = JSON.parse(JSON.stringify(changedLearning));
  deletedLearning.plannerItems.shift();
  assert.throws(
    () => context.__saveLearningState(deletedLearning.student.studentCode, deletedLearning),
    /플래너 항목 삭제는 허용되지 않습니다/
  );

  const inspected = persistence.inspectLearningRecords({
    core: record('lpcore'), plan: record('lpplan'), assessment: record('lpassess'),
    campaign: record('lpcampaign'), wrong: record('lpwrong')
  });
  assert.equal(inspected.kind, 'split');
  const reloaded = shell.normalizeState(inspected.stored, {
    studentCode: learning.student.studentCode, displayName: learning.student.displayName
  });
  const comparable = item => ({
    itemId: item.itemId,
    studentCode: item.studentCode,
    date: item.date,
    title: item.title,
    sourceType: item.sourceType,
    occurrenceId: item.occurrenceId,
    campaignId: item.campaignId,
    status: item.status,
    revision: item.revision,
    evidenceRefs: item.evidenceRefs,
    verificationEvidenceRefs: item.verificationEvidenceRefs,
    verificationDecision: item.verificationDecision,
    history: item.history
  });
  assert.deepEqual(reloaded.plannerItems.map(comparable), learning.plannerItems.map(comparable));
});


test('assessment-linked planner rows expose guidance but no generic edit cancel or carryover controls', () => {
  let learning = shell.createInitialState({
    studentCode: 'STU-ASSESS-UI', displayName: '평가 연결', academicStage: 'elementary', grade: 4
  });
  learning = shell.addStandardSchedules(learning, { fromDate: '2026-08-03', weekday: 5 });
  const linked = learning.plannerItems.slice().sort((left, right) =>
    (left.date + '|' + left.title).localeCompare(right.date + '|' + right.title, 'ko')
  ).at(-1);
  assert.ok(linked.occurrenceId);
  const markup = shell.renderManagementControls(learning, { canManage: true, today: '2026-08-03' });
  assert.match(markup, /role="note" aria-label="평가 연계 플래너 관리 안내">평가 일정에서 관리합니다/);
  assert.doesNotMatch(markup, new RegExp('data-lp-plan-date="' + linked.itemId + '"'));
  ['lpplanedit', 'lpplancancel', 'lpplancarryrequest', 'lpplancarryreview'].forEach(action => {
    assert.doesNotMatch(markup, new RegExp('data-act="' + action + '"[^>]*data-id="' + linked.itemId + '"'));
  });
});

test('learningStateFor rejects foreign student codes before normalization across every learning part', () => {
  const start = html.indexOf('function validateLearningStudentScope');
  const end = html.indexOf('\nfunction learningStateRecoveryCard', start);
  assert.ok(start >= 0 && end > start);
  const block = html.slice(start, end);
  const context = {
    window: { WBLearningShell: {}, WBLearningPersistence: {}, WBLearningPlatform: {} },
    WBLearningPersistence: persistence,
    WBLearningPlatform: platform,
    state: { checks: {} },
    lpLearningStateErrors: new Map(),
    lpClaimsFor() { return []; },
    console: { warn() {} }
  };
  let normalized = false;
  context.WBLearningShell = { normalizeState() { normalized = true; throw new Error('must not normalize'); } };
  context.lpPart = function (prefix, studentId) {
    return context.state.checks['__' + prefix + '__' + studentId + '|all'] || null;
  };
  vm.createContext(context);
  vm.runInContext(block + '\nthis.__scopeApi = { validateLearningStudentScope, learningStateFor };', context);
  const foreignValues = [
    { programStates: [{ history: [{ student_code: 'SCOPE-B' }] }] },
    [{ studentCode: 'SCOPE-A', history: [{ student_code: 'SCOPE-B' }] }],
    { schedules: [], occurrences: [{ studentCode: 'SCOPE-B' }] },
    [{ student_code: 'SCOPE-B' }],
    [{ attempts: [{ studentCode: 'SCOPE-B' }] }],
    { history: [{ student_code: 'SCOPE-B' }], keys: [] }
  ];
  foreignValues.forEach((value, index) => {
    const result = context.__scopeApi.validateLearningStudentScope(value, 'SCOPE-A');
    assert.equal(result.code, 'LP_FOREIGN_STUDENT_DATA', String(index));
  });
  assert.equal(context.__scopeApi.validateLearningStudentScope({ nested: [{ studentCode: 'SCOPE-A' }, {}] }, 'SCOPE-A'), null);

  const learning = shell.createInitialState({
    studentCode: 'SCOPE-A', displayName: '학생', academicStage: 'elementary', grade: 3
  });
  const record = (prefix, value) => ({ taskId: '__' + prefix + '__SCOPE-A', date: 'all', done: true, value, updatedAt: 1 });
  context.state.checks = {
    '__lpcore__SCOPE-A|all': record('lpcore', {
      schemaVersion: learning.schemaVersion,
      student: learning.student,
      settings: learning.settings,
      programStates: [],
      migrationIssues: []
    }),
    '__lpplan__SCOPE-A|all': record('lpplan', []),
    '__lpassess__SCOPE-A|all': record('lpassess', { schedules: [], occurrences: [] }),
    '__lpcampaign__SCOPE-A|all': record('lpcampaign', []),
    '__lpwrong__SCOPE-A|all': record('lpwrong', []),
    '__lpimport__SCOPE-A|all': record('lpimport', { history: [{ student_code: 'SCOPE-B' }], keys: [] })
  };
  assert.equal(context.__scopeApi.learningStateFor({ id: 'SCOPE-A', name: '학생' }), null);
  assert.equal(context.lpLearningStateErrors.get('SCOPE-A').code, 'LP_FOREIGN_STUDENT_DATA');
  assert.equal(normalized, false);
  assert.ok(block.includes("importLedger: lpPart('lpimport', student.id)"));
});
