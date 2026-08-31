const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function functionSource(name) {
  const markers = ['async function ' + name + '(', 'function ' + name + '('];
  let start = -1;
  for (const marker of markers) {
    start = html.indexOf(marker);
    if (start >= 0) break;
  }
  assert.notEqual(start, -1, name + ' function must exist');
  const open = html.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < html.length; index++) {
    const char = html[index];
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return html.slice(start, index + 1);
  }
  assert.fail(name + ' function is incomplete');
}

function eventCase(name) {
  const marker = "case '" + name + "':";
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, name + ' action must be wired');
  const tail = html.slice(start + marker.length);
  const next = tail.match(/\n\s*case '[^']+':/);
  return html.slice(start, next ? start + marker.length + next.index : html.length);
}

function addDays(date, amount) {
  const value = new Date(date + 'T12:00:00Z');
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function dowOf(date) {
  return new Date(date + 'T12:00:00Z').getUTCDay();
}

test('MetaMath keeps the consult identity and adds a worksheet request beside its learning link', () => {
  assert.match(html, /const LS_KEY = 'wb_consult_v1'/);
  assert.match(html, /const SYNC_APP = 'consult'/);
  assert.doesNotMatch(html, /const LS_KEY = 'wb_taskboard_v1'/);

  const card = functionSource('learningSourceCard');
  assert.match(card, /sourceKey === 'metamath'/);
  assert.match(card, /data-act="metamathrequestopen"/);
  assert.match(card, /문제지 요청/);
  assert.match(card, /metamathRequestPanel\(me\)/);
  assert.match(functionSource('metamathRequestPanel'), /metamathRequestCard\(req, false\)/);
});

test('the processing date is the coming Wednesday on Monday or Tuesday and next Wednesday from Wednesday', () => {
  const source = functionSource('nextMetamathRequestWednesday');
  const nextWednesday = Function('addDays', 'dowOf', source + '\nreturn nextMetamathRequestWednesday;')(addDays, dowOf);
  const cases = [
    ['2026-08-31', '2026-09-02'], // Monday
    ['2026-09-01', '2026-09-02'], // Tuesday
    ['2026-09-02', '2026-09-09'], // Wednesday
    ['2026-09-03', '2026-09-09'], // Thursday
    ['2026-09-06', '2026-09-09']  // Sunday
  ];
  for (const [date, expected] of cases) assert.equal(nextWednesday(date), expected, date);
});

test('worksheet requests and director responses are separate student-scoped task rows', () => {
  const requests = functionSource('metamathRequestsFor');
  const response = functionSource('metamathResponseFor');
  const occurs = functionSource('occursOn');
  const save = eventCase('metamathrequestsave');

  assert.match(requests, /state\.tasks\.filter/);
  assert.match(requests, /\.kind === 'metamath_request'/);
  assert.match(requests, /\.staffId === staffId/);
  assert.match(response, /\.kind === 'metamath_response'/);
  assert.match(response, /\.metamathRequestId === requestId/);
  assert.match(occurs, /metamath_request/);
  assert.match(occurs, /metamath_response/);
  assert.match(occurs, /return false/);

  assert.match(save, /kind:\s*'metamath_request'/);
  assert.match(save, /staffId:\s*me\.id/);
  assert.match(save, /origin:\s*'staff'/);
  assert.match(save, /processingDate:\s*nextMetamathRequestWednesday\(today\(\)\)/);
  assert.doesNotMatch(save, /kind:\s*'metamath_response'|origin:\s*'admin'/);
});

test('students manage only their own open request while director-only actions change status and assign', () => {
  const open = eventCase('metamathrequestopen');
  const save = eventCase('metamathrequestsave');
  const cancel = eventCase('metamathrequestcancel');
  const status = eventCase('metamathrequeststatus');
  const assign = eventCase('metamathrequestassign');

  for (const source of [open, save, cancel]) {
    assert.match(source, /session\.isStaffLink/);
    assert.match(source, /isManager\(\)/);
    assert.match(source, /session\.staffId/);
  }
  assert.match(open, /existing\.staffId !== me\.id/);
  assert.match(save, /existing\.staffId !== me\.id/);
  assert.match(cancel, /req\.staffId !== me\.id/);

  for (const source of [status, assign]) {
    assert.match(source, /if \(!session\.isAdmin\) break/);
    assert.doesNotMatch(source, /isManager\(\)/,
      'manager metadata must not grant director worksheet authority');
  }
});

test('the worksheet form requires grade, semester and unit and enforces bounded text fields', () => {
  const modal = functionSource('metamathRequestModal');
  const save = eventCase('metamathrequestsave');

  assert.match(modal, /id="metamathGrade"/);
  assert.match(modal, /id="metamathSemester"/);
  assert.match(modal, /id="metamathUnit"[^>]*maxlength="160"/);
  assert.match(modal, /id="metamathNote"[^>]*maxlength="500"/);
  assert.match(modal, /학년/);
  assert.match(modal, /학기/);
  assert.match(modal, /단원/);
  assert.match(modal, /기타[^<]*(?:메모|선택)/);

  assert.match(save, /!grade\s*\|\|\s*!semester\s*\|\|\s*!unit/);
  assert.match(save, /grade\.length\s*>\s*20/);
  assert.match(save, /semester\.length\s*>\s*20/);
  assert.match(save, /unit\.length\s*>\s*160/);
  assert.match(save, /note\.length\s*>\s*500/);
});

test('equivalent open requests are rejected before a second task is created', () => {
  const fingerprintSource = functionSource('metamathRequestFingerprint');
  const fingerprint = Function(fingerprintSource + '\nreturn metamathRequestFingerprint;')();
  const base = {
    staffId: 'student-a', processingDate: '2026-09-02', grade: '중2', semester: '2학기',
    unit: '3단원 일차함수', note: '기본 문제 위주'
  };
  assert.equal(fingerprint(base), fingerprint({
    ...base, grade: '  중2 ', semester: '2학기  ', unit: '  3단원   일차함수 ', note: '다른 메모'
  }), 'whitespace and memo must not create a duplicate request');
  assert.notEqual(fingerprint(base), fingerprint({ ...base, unit: '4단원 연립방정식' }));
  assert.notEqual(fingerprint(base), fingerprint({ ...base, processingDate: '2026-09-09' }));

  const save = eventCase('metamathrequestsave');
  assert.match(save, /metamathRequestsFor\(me\.id\)\.find/);
  assert.match(save, /metamathRequestFingerprint\(/);
  assert.match(save, /같은[^']*문제지[^']*(?:요청|처리)/);
  assert.ok(save.indexOf('if (duplicate)') < save.indexOf('state.tasks.push'),
    'duplicate validation must run before creating a request task');
});

test('assignment creates one admin MetaMath math response linked to the request', () => {
  const seed = functionSource('ensureMetamathResponse');
  const assign = functionSource('assignMetamathRequest');

  assert.match(assign, /metamathResponseFor\(req\.id\)/);
  assert.match(assign, /ensureMetamathResponse\(req\)/);
  assert.match(seed, /kind:\s*'metamath_response'/);
  assert.match(seed, /metamathRequestId:\s*req\.id/);
  assert.match(seed, /staffId:\s*req\.staffId/);
  assert.match(assign, /source:\s*'metamath'/);
  assert.match(assign, /studySubject:\s*'math'/);
  assert.match(seed, /origin:\s*'admin'/);
  assert.match(assign, /status:\s*'assigned'/);
  assert.match(assign, /repeat:\s*'once'/);
  assert.match(assign, /start:/);
  assert.match(assign, /LEARNING_SOURCES\.metamath\.steps/);
  assert.match(assign, /save\(\);\s*queueSync\(\)/);
  assert.doesNotMatch(assign, /req\.(?:status|source|studySubject|origin)\s*=/,
    'director state must remain in the admin-owned response row');
});

test('only the deterministic admin response is trusted and assignment follows preparing state', () => {
  const response = functionSource('metamathResponseFor');
  const status = functionSource('metamathRequestStatus');
  const occurs = functionSource('occursOn');
  const card = functionSource('metamathRequestCard');
  const modal = functionSource('learningTaskModal');
  const assignAction = eventCase('metamathrequestassign');
  const saveAction = eventCase('learnsave');

  assert.match(response, /task\.id === 'metamath-response-' \+ requestId/);
  assert.match(response, /task\.staffId === request\.staffId/);
  assert.match(response, /task\.origin === 'admin'/);
  assert.match(status, /response\.requestRevision[^\n]*<[^\n]*req\.requestRevision/);
  assert.match(status, /return 'changed'/);
  assert.match(occurs, /metamathResponseFor\(request\.id\) !== task/);
  assert.match(occurs, /task\.requestRevision[^\n]*<[^\n]*request\.requestRevision/);
  assert.match(card, /admin && status === 'preparing'/);
  assert.match(card, /data-act="daypick" data-date=/);
  assert.match(card, /response\.start/);
  assert.match(modal, /metamathRequestStatus\(request\) !== 'preparing'/);
  assert.match(assignAction, /metamathRequestStatus\(req\) !== 'preparing'/);
  assert.match(saveAction, /metamathRequestStatus\(request\) !== 'preparing'/);
});

test('request cards escape student text before inserting it into HTML', () => {
  const card = functionSource('metamathRequestCard');
  for (const field of ['grade', 'semester', 'unit']) {
    assert.match(card, new RegExp('esc\\([^)]*req\\.' + field));
  }
  assert.match(card, /esc\(buildMetamathRequestSummary\(req\)\)/,
    'the summary containing the optional note must be escaped as one string');
  assert.doesNotMatch(card, /innerHTML\s*=\s*req\.|\+\s*req\.(?:grade|semester|unit|note)\s*\+/);
});
