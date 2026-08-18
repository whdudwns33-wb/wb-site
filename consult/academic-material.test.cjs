const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function section(start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  return from >= 0 && to > from ? html.slice(from, to) : '';
}

function functionSource(name) {
  const marker = 'function ' + name + '(';
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, name + ' function must exist');
  const open = html.indexOf('{', start + marker.length);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = open; i < html.length; i++) {
    const char = html[i];
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  assert.fail(name + ' function is incomplete');
}

function eventCase(name) {
  const marker = "case '" + name + "':";
  const start = html.indexOf(marker);
  if (start < 0) return '';
  const tail = html.slice(start + marker.length);
  const next = tail.match(/\n\s*case '[^']+':/);
  return html.slice(start, next ? start + marker.length + next.index : html.length);
}

test('academic management keeps the existing consult storage and sync identity', () => {
  assert.match(html, /const LS_KEY = 'wb_consult_v1'/);
  assert.match(html, /const SYNC_APP = 'consult'/);

  const types = section('const ACADEMIC_TYPES', 'const ');
  assert.match(types, /exam\s*:\s*\{/);
  assert.match(types, /performance\s*:\s*\{/);
  assert.match(types, /시험/);
  assert.match(types, /수행평가/);

  const tabs = functionSource('renderTabs');
  const render = functionSource('render');
  assert.match(tabs, /\['academic',\s*'학사관리'/);
  assert.match(render, /academic:\s*viewAcademic/);
});

test('academic events and material requests are student-scoped but never counted as daily tasks', () => {
  const list = functionSource('academicItemsFor');
  const occurs = functionSource('occursOn');
  const requestList = functionSource('materialRequestsFor');
  const requestSave = eventCase('matrequestsave');

  assert.match(list, /state\.tasks\.filter/);
  assert.match(list, /t\.staffId === staffId/);
  assert.match(list, /!t\.deleted/);
  assert.match(list, /t\.kind === 'academic_event'/);
  assert.match(occurs, /academic_event/);
  assert.match(occurs, /material_request/);
  assert.match(occurs, /task\.kind === 'material_response'\s*&&\s*task\.status !== 'provided'/);
  assert.match(occurs, /return false/);

  assert.match(requestList, /staffId/);
  assert.match(requestList, /state\.tasks\.filter/);
  assert.match(requestList, /t\.kind === 'material_request'/);
  assert.match(requestList, /t\.staffId === staffId/);
  assert.match(requestSave, /state\.tasks\.push/);
  assert.match(requestSave, /kind:\s*'material_request'/);
  assert.match(requestSave, /origin:\s*'staff'/);
});

test('students can request only for themselves and only the director manages official data', () => {
  const academicSave = eventCase('academicsave');
  const academicDelete = eventCase('academicdelete');
  const requestOpen = eventCase('matrequestopen');
  const requestSave = eventCase('matrequestsave');
  const provide = eventCase('matprovide');
  const status = eventCase('matrequeststatus');

  assert.match(academicSave, /if \(!session\.isAdmin\) break/);
  assert.match(academicDelete, /if \(!session\.isAdmin\) break/);
  assert.match(requestOpen, /session\.isStaffLink/);
  assert.match(requestSave, /if \(!session\.isStaffLink\) break/);
  assert.match(requestSave, /currentStaff\(\)/);
  assert.match(requestSave, /staffId:\s*me\.id/);
  assert.match(provide, /if \(!session\.isAdmin\) break/);
  assert.match(status, /if \(!session\.isAdmin\) break/);
});

test('performance assessment keeps only the essential fields while exam fields stay intact', () => {
  const source = functionSource('academicEventModal');
  const captures = [];
  const open = Function('captures', `
    const session={isAdmin:true};
    const ACADEMIC_TYPES={exam:{icon:'📝',label:'시험'},performance:{icon:'🎯',label:'수행평가'}};
    function currentStaff(){return {id:'student-1',name:'학생'};}
    function toast(){}
    function today(){return '2026-08-18';}
    function addDays(){return '2026-09-01';}
    function studySubjectOptions(){return '<option>수학</option>';}
    function modal(title,body,foot){captures.push({title,body,foot});}
    ${source}
    return academicEventModal;
  `)(captures);

  open('performance');
  open('exam');
  const performance = captures[0].body;
  const exam = captures[1].body;
  for (const id of ['academicGrade', 'academicSemester', 'academicPublisher', 'academicTextbook',
    'academicUnit', 'academicPages', 'academicRange', 'academicMetric', 'academicStart', 'academicSteps']) {
    assert.ok(!performance.includes('id="' + id + '"'), id + ' must be absent from performance');
    assert.ok(exam.includes('id="' + id + '"'), id + ' must remain available for exams');
  }
  for (const id of ['academicSubject', 'academicDate', 'academicTitle', 'academicFormat']) {
    assert.ok(performance.includes('id="' + id + '"'), id + ' must remain in performance');
  }
  assert.match(performance, /평가 안내 및 선생님 지시사항은 학생이 등록/);
  assert.match(performance, /당일에 급하게 준비하기 어렵습니다/);

  const save = eventCase('academicsave');
  assert.match(save, /const isExam = type === 'exam'/);
  assert.match(save, /if \(isExam && \(!grade \|\| !semester \|\| !unit \|\| !range\)\)/);
  assert.match(save, /weight:\s*0/);
  assert.match(save, /steps:\s*steps/);
  assert.match(save, /const steps = isExam[\s\S]*?: \[\]/);
});

test('the generated material request summary contains every concrete lookup field', () => {
  const source = functionSource('buildMaterialRequestSummary');
  const build = Function(source + '\nreturn buildMaterialRequestSummary;')();
  const request = {
    examName: '2학기 중간고사', examDate: '2026-10-13', grade: '중2', semester: '2학기',
    subject: '수학', publisher: '천재교육', textbook: '수학2', unit: '3단원 일차함수',
    pages: '82~105쪽', schoolHandout: '학교 프린트 3~5장',
    materialTypes: ['학교시험형', '서술형'], level: '표준~심화', amount: '20문항',
    explanation: '어려운 문제 상세 해설', weakness: '그래프 해석과 식 세우기',
    neededBy: '2026-09-20', note: '풀이 공간을 넓게'
  };
  const summary = String(build(request));

  [request.examName, request.examDate, request.grade, request.semester, request.subject,
    request.publisher, request.textbook, request.unit, request.pages, request.schoolHandout,
    ...request.materialTypes, request.level, request.amount, request.explanation,
    request.weakness, request.neededBy, request.note]
    .forEach(value => assert.ok(summary.includes(value), 'summary must include ' + value));
});

test('an equivalent open request is rejected before another request row is created', () => {
  const save = eventCase('matrequestsave');

  assert.match(save, /materialRequestFingerprint\(/);
  assert.match(save, /materialRequestsFor\(me\.id\)\.find/);
  assert.match(save, /\['requested',\s*'needs_info',\s*'resubmitted',\s*'preparing'\]/);
  assert.match(save, /같은 범위와 자료 종류로 처리 중인 요청이 있습니다/);
  assert.ok(save.indexOf('if (duplicate)') < save.indexOf('state.tasks.push(req)'),
    'duplicate check must run before creating the request row');
});

test('providing one safe link creates one protected exam-material response without duplicates', () => {
  const provide = functionSource('provideMaterialRequest');
  const event = eventCase('matprovide');

  assert.match(event, /safeHttpsUrl/);
  assert.match(event, /provideMaterialRequest\(/);
  assert.match(provide, /(?:state\.tasks\.(?:find|some)|materialProvidedTask)\(/);
  assert.match(provide, /id:\s*'material-response-'\s*\+\s*req\.id/);
  assert.match(provide, /kind:\s*'material_response'/);
  assert.match(provide, /source:\s*'exam_material'/);
  assert.match(provide, /staffId:\s*req\.staffId/);
  assert.match(provide, /materialRequestId:\s*req\.id/);
  assert.match(provide, /requestSnapshot/);
  assert.match(provide, /resourceUrl:\s*resourceUrl/);
  assert.match(provide, /origin:\s*'admin'/);
  assert.match(provide, /repeat:\s*'once'/);
  assert.match(provide, /LEARNING_SOURCES\.exam_material\.steps/);
  assert.match(provide, /status:\s*'provided'/);
  assert.doesNotMatch(provide, /req\.(?:providedTaskId|resourceUrl|status)\s*=/,
    'director response must not be written into the student-owned request row');
});

test('backup export removes credentials without mutating live state', () => {
  const localAuth = section('const LOCAL_AUTH_SETTINGS', 'function sanitizedBackupState');
  const source = functionSource('sanitizedBackupState');
  const sanitize = Function(localAuth + '\n' + source + '\nreturn sanitizedBackupState;')();
  const live = {
    version: 2,
    staff: [{ id: 'student-1', name: '학생', token: 'student-link-token' }],
    tasks: [{ id: 'task-1' }],
    checks: { 'task-1|2026-08-18': { done: true } },
    settings: {
      centerName: 'WB', syncUrl: 'https://sync.example.com',
      adminPin: '1234', adminLoginId: 'director', syncSecret: 'secret', adminToken: 'device-token'
    }
  };
  const backup = sanitize(live);

  assert.notStrictEqual(backup, live);
  assert.notStrictEqual(backup.settings, live.settings);
  ['adminPin', 'adminLoginId', 'syncSecret', 'adminToken']
    .forEach(key => assert.equal(backup.settings[key], undefined, key + ' must not be exported'));
  assert.deepEqual(backup.staff, [{ id: 'student-1', name: '학생' }]);
  assert.equal(backup.staff[0].token, undefined, 'student bearer tokens must not be exported');
  assert.equal(live.staff[0].token, 'student-link-token', 'export must not alter active student links');
  assert.equal(live.settings.adminToken, 'device-token', 'export must not alter the active login');
});

test('backup import restores data while preserving this device credentials', () => {
  const blank = functionSource('blankState');
  const localAuth = section('const LOCAL_AUTH_SETTINGS', 'function sanitizedBackupState');
  const sanitize = functionSource('sanitizedBackupState');
  const merge = functionSource('mergeImportedState');
  const mergeImportedState = Function(blank + '\n' + localAuth + '\n' + sanitize + '\n' + merge + '\nreturn mergeImportedState;')();
  const current = {
    version: 2, staff: [{ id: 'new', token: 'current-student-token' }], tasks: [], checks: {},
    settings: {
      centerName: '현재 센터', syncUrl: 'https://current.example.com',
      adminPin: 'current-pin', adminLoginId: 'current-id',
      syncSecret: 'current-secret', adminToken: 'current-token'
    }
  };
  const imported = {
    version: 2, staff: [{ id: 'new', token: 'stolen-student-token' }], tasks: [{ id: 'new-task' }], checks: { ok: true },
    settings: {
      centerName: '백업 센터', syncUrl: 'https://backup.example.com',
      adminPin: 'stolen-pin', adminLoginId: 'stolen-id',
      syncSecret: 'stolen-secret', adminToken: 'stolen-token'
    }
  };
  const restored = mergeImportedState(imported, current);

  assert.deepEqual(restored.staff, [{ id: 'new', token: 'current-student-token' }]);
  assert.deepEqual(restored.tasks, imported.tasks);
  assert.deepEqual(restored.checks, imported.checks);
  assert.equal(restored.settings.centerName, '백업 센터');
  ['adminPin', 'adminLoginId', 'syncSecret', 'adminToken']
    .forEach(key => assert.equal(restored.settings[key], current.settings[key], key + ' must stay local'));

  const exportCase = eventCase('export');
  const importCase = eventCase('import');
  assert.match(exportCase, /sanitizedBackupState\(state\)/);
  assert.match(importCase, /mergeImportedState\(p,\s*state\)/);
});
