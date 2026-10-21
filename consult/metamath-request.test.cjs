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

test('the processing date follows the daily 6 PM Korea cutoff including weekends', () => {
  const source = functionSource('metamathRequestProcessingDate');
  const processingDate = Function('addDays', source + '\nreturn metamathRequestProcessingDate;')(addDays);
  const cases = [
    ['2026-10-14T08:59:59.000Z', '2026-10-14'], // 17:59:59 KST
    ['2026-10-14T09:00:00.000Z', '2026-10-15'], // 18:00:00 KST
    ['2026-10-14T14:59:59.000Z', '2026-10-15'], // 23:59:59 KST
    ['2026-10-14T15:00:00.000Z', '2026-10-15'], // next day 00:00 KST
    ['2026-10-16T09:00:00.000Z', '2026-10-17']  // Friday 18:00 KST → Saturday
  ];
  for (const [timestamp, expected] of cases) {
    assert.equal(processingDate(Date.parse(timestamp)), expected, timestamp);
  }
});

test('student and director guidance consistently explains the daily 6 PM request cycle', () => {
  const panel = functionSource('metamathRequestPanel');
  const modal = functionSource('metamathRequestModal');
  const inbox = functionSource('metamathRequestInbox');
  const staleWeeklyCopy = /화요일까지|가까운 수요일|다음 수요일|매주 수요일|수요일 제작 대기|수요일 메타수학|같은 수요일/;

  assert.match(panel, /매일 오후 6시/);
  assert.match(panel, /오후 6시 전에 접수하면 당일/);
  assert.match(panel, /오후 6시부터 접수하면 다음 날/);
  assert.match(modal, /매일 오후 6시/);
  assert.match(inbox, /매일 오후 6시/);
  assert.match(html, /메타수학 문제지 요청은 매일 오후 6시에 확인합니다/);
  assert.doesNotMatch(html, staleWeeklyCopy);
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
  assert.match(save, /const processingDate = metamathRequestProcessingDate\(now\(\)\)/);
  assert.match(save, /processingDate:\s*processingDate/);
  assert.match(save, /start:\s*processingDate/);
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

test('the worksheet form guides grade, semester, unit and difficulty in order and bounds free text', () => {
  const modal = functionSource('metamathRequestModal');
  const save = eventCase('metamathrequestsave');

  assert.match(modal, /id="metamathGrade"/);
  assert.match(modal, /id="metamathSemester"/);
  assert.match(modal, /id="metamathDifficulty"/);
  assert.match(html, /const METAMATH_DIFFICULTIES = Object\.freeze\(\['기본', '발전', '심화'\]\)/);
  assert.match(modal, /<select class="in" id="metamathUnit"/);
  assert.match(modal, /id="metamathCustomUnit"[^>]*maxlength="160"/);
  assert.match(modal, /id="metamathNote"[^>]*maxlength="500"/);
  assert.match(modal, /!req\.grade \? ' disabled'/);
  assert.match(modal, /!req\.grade \|\| !req\.semester \? ' disabled'/);
  assert.match(modal, /목록에 없음 · 직접 입력/);
  assert.match(modal, /for="metamathGrade"/);
  assert.match(modal, /for="metamathSemester"/);
  assert.match(modal, /for="metamathUnit"/);
  assert.match(modal, /학년/);
  assert.match(modal, /학기/);
  assert.match(modal, /난이도/);
  assert.match(modal, /단원/);
  assert.match(modal, /기타[^<]*(?:메모|선택)/);

  assert.match(save, /!grade\s*\|\|\s*!semester\s*\|\|\s*!difficulty\s*\|\|\s*!unitChoice\s*\|\|\s*!unit/);
  assert.match(save, /METAMATH_DIFFICULTIES\.includes\(difficulty\)/);
  assert.match(save, /unitChoice === METAMATH_CUSTOM_UNIT \? customUnit : unitChoice/);
  assert.match(save, /metamathUnitsFor\(grade, semester\)\.includes\(unitChoice\)/);
  assert.match(save, /difficulty:\s*difficulty/);
  assert.match(save, /grade\.length\s*>\s*20/);
  assert.match(save, /semester\.length\s*>\s*20/);
  assert.match(save, /unit\.length\s*>\s*160/);
  assert.match(save, /note\.length\s*>\s*500/);
});

test('the MetaMath curriculum catalog covers every grade and preserves unmatched legacy units', () => {
  const start = html.indexOf('const METAMATH_GRADES =');
  const end = html.indexOf('function metamathRequestProcessingDate', start);
  assert.ok(start >= 0 && end > start, 'MetaMath curriculum helpers must be defined together');
  const catalog = Function('esc', html.slice(start, end) + '\nreturn {' +
    'METAMATH_GRADES, METAMATH_SEMESTERS, METAMATH_CUSTOM_UNIT, metamathUnitsFor, metamathUnitSelection, metamathUnitOptions};')(
    value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
  );

  for (const grade of catalog.METAMATH_GRADES) {
    for (const semester of catalog.METAMATH_SEMESTERS) {
      assert.ok(catalog.metamathUnitsFor(grade, semester).length > 0, grade + ' ' + semester);
    }
  }
  assert.deepEqual(catalog.metamathUnitsFor('중1', '1학기'), [
    '1. 소인수분해', '2. 정수와 유리수', '3. 문자의 사용과 식', '4. 일차방정식', '5. 좌표평면과 그래프'
  ]);
  assert.match(catalog.metamathUnitsFor('고2', '1학기').join('\n'), /대수\(수학Ⅰ\)|미적분Ⅰ\(수학Ⅱ\)|확률과 통계/);
  assert.equal(catalog.metamathUnitSelection('중1', '1학기', '4. 일차방정식'), '4. 일차방정식');
  assert.equal(catalog.metamathUnitSelection('중1', '1학기', '학교별 진도 단원'), catalog.METAMATH_CUSTOM_UNIT);
  assert.match(catalog.metamathUnitOptions('중1', '1학기', '학교별 진도 단원'),
    /value="__custom__" selected>목록에 없음 · 직접 입력/);
});

test('changing grade, semester or unit refreshes the dependent MetaMath fields', () => {
  const firstChange = html.indexOf("document.addEventListener('change', ev => {");
  const secondChange = html.indexOf("document.addEventListener('change', ev => {", firstChange + 1);
  const listener = html.slice(firstChange, secondChange);

  assert.match(listener, /\['metamathGrade', 'metamathSemester', 'metamathUnit'\]\.includes\(ev\.target\.id\)/);
  assert.match(listener, /refreshMetamathCurriculumFields\(ev\.target\.id\)/);
  const refresh = functionSource('refreshMetamathCurriculumFields');
  assert.match(refresh, /changedId === 'metamathGrade'/);
  assert.match(refresh, /semesterEl\.value = ''/);
  assert.match(refresh, /unitEl\.innerHTML = metamathUnitOptions/);
  assert.match(refresh, /semesterEl\.disabled = !gradeEl\.value/);
  assert.match(refresh, /unitEl\.disabled = !gradeEl\.value \|\| !semesterEl\.value/);
  assert.match(refresh, /unitEl\.value === METAMATH_CUSTOM_UNIT/);
  assert.match(refresh, /customField\.hidden = !custom/);
  assert.match(refresh, /customEl\.disabled = !custom/);
});

test('dependent MetaMath fields enable step by step and expose custom input only on request', () => {
  const start = html.indexOf('const METAMATH_GRADES =');
  const end = html.indexOf('function metamathRequestProcessingDate', start);
  const fields = {
    '#metamathGrade': { value: '중1' },
    '#metamathSemester': { value: '2학기', disabled: true },
    '#metamathUnit': { value: '', disabled: true, innerHTML: '' },
    '#metamathCustomUnitField': { hidden: false },
    '#metamathCustomUnit': { value: '이전 입력', disabled: false }
  };
  const api = Function('$', 'esc', html.slice(start, end) + '\nreturn {' +
    'METAMATH_CUSTOM_UNIT, refreshMetamathCurriculumFields};')(
    selector => fields[selector],
    value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
  );

  api.refreshMetamathCurriculumFields('metamathGrade');
  assert.equal(fields['#metamathSemester'].value, '');
  assert.equal(fields['#metamathSemester'].disabled, false);
  assert.equal(fields['#metamathUnit'].disabled, true);
  assert.equal(fields['#metamathCustomUnit'].value, '');
  assert.equal(fields['#metamathCustomUnitField'].hidden, true);

  fields['#metamathSemester'].value = '1학기';
  fields['#metamathUnit'].value = '';
  api.refreshMetamathCurriculumFields('metamathSemester');
  assert.equal(fields['#metamathUnit'].disabled, false);
  assert.match(fields['#metamathUnit'].innerHTML, /1\. 소인수분해/);
  assert.match(fields['#metamathUnit'].innerHTML, /목록에 없음 · 직접 입력/);

  fields['#metamathUnit'].value = api.METAMATH_CUSTOM_UNIT;
  api.refreshMetamathCurriculumFields('metamathUnit');
  assert.equal(fields['#metamathCustomUnitField'].hidden, false);
  assert.equal(fields['#metamathCustomUnit'].disabled, false);
});

test('request summaries show the selected difficulty and keep legacy requests readable', () => {
  const build = Function(functionSource('buildMetamathRequestSummary') + '\nreturn buildMetamathRequestSummary;')();
  assert.match(build({ grade: '중2', semester: '2학기', difficulty: '심화', unit: '일차함수' }), /난이도: 심화/);
  assert.match(build({ grade: '중2', semester: '2학기', unit: '일차함수' }), /난이도: 미지정\(기존 요청\)/);
});

test('equivalent open requests are rejected before a second task is created', () => {
  const fingerprintSource = functionSource('metamathRequestFingerprint');
  const fingerprint = Function(fingerprintSource + '\nreturn metamathRequestFingerprint;')();
  const base = {
    staffId: 'student-a', processingDate: '2026-09-02', grade: '중2', semester: '2학기',
    difficulty: '기본', unit: '3단원 일차함수', note: '기본 문제 위주'
  };
  assert.equal(fingerprint(base), fingerprint({
    ...base, grade: '  중2 ', semester: '2학기  ', unit: '  3단원   일차함수 ', note: '다른 메모'
  }), 'whitespace and memo must not create a duplicate request');
  assert.notEqual(fingerprint(base), fingerprint({ ...base, unit: '4단원 연립방정식' }));
  assert.notEqual(fingerprint(base), fingerprint({ ...base, difficulty: '심화' }));
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
  assert.match(seed, /origin:\s*actor\(\)/);
  assert.match(assign, /status:\s*'assigned'/);
  assert.match(assign, /repeat:\s*'once'/);
  assert.match(assign, /start:/);
  assert.match(assign, /LEARNING_SOURCES\.metamath\.steps/);
  assert.match(assign, /save\(\);\s*queueSync\(\)/);
  assert.match(functionSource('learningTaskModal'), /request\.difficulty/);
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
  assert.match(response, /\['admin', 'manager'\]\.includes\(task\.origin\)/);
  assert.match(status, /response\.requestRevision[^\n]*<[^\n]*req\.requestRevision/);
  assert.match(status, /return 'changed'/);
  assert.match(occurs, /metamathResponseFor\(request\.id\) !== task/);
  assert.match(occurs, /task\.requestRevision[^\n]*<[^\n]*request\.requestRevision/);
  assert.match(card, /canRespond && status === 'preparing'/);
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

test('overdue requests explain the delay and students can pull the latest status', () => {
  const card = functionSource('metamathRequestCard');
  const panel = functionSource('metamathRequestPanel');
  const refresh = eventCase('syncnow');

  assert.match(card, /active\s*&&\s*req\.processingDate\s*&&\s*req\.processingDate\s*<\s*today\(\)/);
  assert.match(card, /제작 예정일이 지나 최신 처리 상태를 확인해 주세요/);
  assert.match(panel, /const canRequest = session\.isStaffLink\s*&&\s*!isManager\(\)\s*&&\s*me\.id === session\.staffId/);
  assert.match(panel, /data-act="syncnow"/);
  assert.match(panel, /최신 상태 확인/);
  assert.match(refresh, /sync\.loud\s*=\s*true/);
  assert.match(refresh, /sync\.run\(\)/);
});

test('the director queue keeps active work prominent and exposes recent assignments', () => {
  const inbox = functionSource('metamathRequestInbox');

  assert.match(inbox, /const requests = allMetamathRequests\(\)/);
  assert.match(inbox, /\['requested', 'changed', 'preparing'\]/);
  assert.match(inbox, /queue\.map\(req => metamathRequestCard\(req, true\)\)/);
  assert.match(inbox, /metamathRequestStatus\(req\) === 'assigned'/);
  assert.match(inbox, /\.slice\(0, 10\)/);
  assert.match(inbox, /최근 배정 완료/);
  assert.match(inbox, /recent\.map\(req => metamathRequestCard\(req, true\)\)/);
  assert.doesNotMatch(inbox, /currentStaff\(|viewStaff/);
});
