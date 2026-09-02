const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const TODAY = '2026-09-02';

function functionSource(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, name + ' function must exist');
  const open = html.indexOf('{', start);
  let depth = 0, quote = '', escaped = false;
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

function request(overrides = {}) {
  return {
    id: 'request-a', kind: 'lecture_request', origin: 'staff', staffId: 'student-a',
    site: '메가스터디', instructor: '김강사', courseName: '수학 개념 완성',
    startDate: TODAY, perDay: 2, note: '기초부터 공부하고 싶어요',
    repeat: 'request', source: '', requestRevision: 1, requestedAt: 10,
    createdAt: 10, updatedAt: 10, deleted: false, ...overrides
  };
}

function response(req, overrides = {}) {
  return {
    id: 'lecture-response-' + req.id, kind: 'lecture_response', origin: 'admin',
    staffId: req.staffId, lectureRequestId: req.id, requestRevision: req.requestRevision,
    requestSnapshot: { ...req }, status: 'reviewing', responseNote: '확인 중입니다',
    repeat: 'request', source: '', deleted: false, ...overrides
  };
}

function requestFields(overrides = {}) {
  return {
    lectureRequestId: '', lectureRequestRevision: '', lectureSite: '메가스터디',
    lectureInstructor: '김강사', lectureCourseName: '수학 개념 완성',
    lectureStartDate: TODAY, lecturePerDay: '2', lectureNote: '기초부터 공부하고 싶어요',
    ...overrides
  };
}

function harness({ tasks = [], role = 'student', selected = 'student-a' } = {}) {
  const state = {
    staff: [{ id: 'student-a', name: '가학생' }, { id: 'student-b', name: '나학생' }],
    tasks: structuredClone(tasks), checks: {}, settings: {}
  };
  const session = { isAdmin: role === 'admin', isStaffLink: role !== 'admin', staffId: 'student-a' };
  const effects = { saved: 0, synced: 0, rendered: 0, closed: 0, toasts: [], modals: [] };
  const names = [...html.matchAll(/function ((?:lecture\w+|isLectureRequestTask|buildLectureRequestSummary|setLectureResponse))\(/g)].map(match => match[1]);
  const constants = [...html.matchAll(/const LECTURE_[A-Z_]+\s*=\s*[\s\S]*?;/g)].map(match => match[0]).join('\n');
  const sources = names.map(functionSource).join('\n');
  const actions = ['lecturerequestopen', 'lecturerequestsave', 'lecturerequestcancel',
    'lectureresponseopen', 'lectureresponsesave', 'lecturerequestregister'].map(eventCase).join('\n');
  const env = {
    state, session, effects, role, selected, TODAY,
    isPointTransactionTask: () => false,
    esc: value => String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char])
  };
  return Function(...Object.keys(env), `
    let fieldValues = {}, counter = 100, viewStaff = selected;
    const $ = selector => selector.slice(1) in fieldValues ? { value: fieldValues[selector.slice(1)] } : null;
    const today = () => TODAY;
    const now = () => ++counter;
    const uid = () => 'generated-' + (++counter);
    const isManager = () => role === 'manager';
    const staffById = id => state.staff.find(staff => staff.id === id);
    const currentStaff = () => staffById(selected);
    const teamStaff = () => state.staff.filter(staff => !staff.deleted && !staff.owner);
    const label = value => value;
    const shortDate = value => value;
    const save = () => { effects.saved++; return true; };
    const queueSync = () => { effects.synced++; };
    const render = () => { effects.rendered++; };
    const closeModal = () => { effects.closed++; };
    const toast = value => { effects.toasts.push(value); };
    const modal = (title, body, footer) => { effects.modals.push({ title, body, footer }); };
    const confirm = () => true;
    const ING_PLATFORMS = ['메가스터디', '이투스', '기타'];
    const ingAddModal = req => { effects.registration = { studentId: viewStaff, request: req }; };
    ${functionSource('ymd')}
    ${functionSource('parseYmd')}
    ${constants}
    ${sources}
    ${functionSource('canEditTask')}
    ${functionSource('occursOn')}
    function act(action, fields = {}, dataset = {}) {
      fieldValues = fields;
      const el = { dataset }, id = dataset.id || '';
      switch (action) { ${actions} }
    }
    return { state, session, effects, act, canEditTask, occursOn, ${names.join(', ')} };
  `)(...Object.values(env));
}

test('lecture requests preserve consult storage identity and are not planner work', () => {
  assert.match(html, /const LS_KEY = 'wb_consult_v1'/);
  assert.match(html, /const SYNC_APP = 'consult'/);
  const req = request();
  for (const role of ['student', 'manager', 'admin']) {
    const api = harness({ tasks: [req, response(req)], role });
    for (const task of api.state.tasks) {
      assert.equal(api.isLectureRequestTask(task), true);
      assert.equal(api.canEditTask(task), false, role + ': generic task editor must not mutate requests');
      assert.equal(api.occursOn({ ...task, repeat: 'daily' }, TODAY), false);
    }
  }
  assert.match(functionSource('studentUsage'), /isLectureRequestTask/);
});

test('student request lists and trusted responses remain scoped to the request owner', () => {
  const req = request();
  const valid = response(req);
  const api = harness({ tasks: [
    req, request({ id: 'other', staffId: 'student-b' }), request({ id: 'deleted', deleted: true }),
    { ...valid, id: 'student-forged-response', status: 'answered' },
    { ...valid, origin: 'staff', status: 'answered' },
    { ...valid, staffId: 'student-b', status: 'answered' }, valid
  ] });
  assert.deepEqual(api.lectureRequestsFor('student-a').map(row => row.id), ['request-a']);
  assert.equal(api.lectureRequestById('deleted'), null);
  assert.equal(api.lectureResponseFor(req.id).status, 'reviewing');
  assert.equal(api.lectureResponseFor(req.id).staffId, 'student-a');
  assert.equal(api.lectureResponseFor('missing'), null);
});

test('request status follows the current revision and cancellation instead of a stale answer', () => {
  const req = request();
  const api = harness({ tasks: [req] });
  const saved = api.state.tasks[0];
  assert.equal(api.lectureRequestStatus(saved), 'requested');
  assert.equal(api.lectureRequestActive(saved), true);
  api.state.tasks.push(response(saved));
  assert.equal(api.lectureRequestStatus(saved), 'reviewing');
  api.state.tasks[1].status = 'answered';
  assert.equal(api.lectureRequestStatus(saved), 'answered');
  assert.equal(api.lectureRequestActive(saved), false);
  saved.requestRevision++;
  assert.equal(api.lectureRequestStatus(saved), 'changed');
  assert.equal(api.lectureRequestActive(saved), true);
  saved.cancelledAt = 99;
  assert.equal(api.lectureRequestStatus(saved), 'cancelled');
  assert.equal(api.lectureRequestActive(saved), false);
});

test('fingerprint normalizes equivalent requests but retains the owner and schedule', () => {
  const api = harness();
  const req = request();
  assert.equal(api.lectureRequestFingerprint(req), api.lectureRequestFingerprint({
    ...req, site: '  메가스터디 ', courseName: '수학   개념 완성  ', perDay: '2', note: '다른 메모'
  }));
  for (const change of [{ staffId: 'student-b' }, { instructor: '다른강사' },
    { startDate: '2026-09-03' }, { perDay: 3 }, { site: '다른 사이트' }]) {
    assert.notEqual(api.lectureRequestFingerprint(req), api.lectureRequestFingerprint({ ...req, ...change }));
  }
  const summary = api.buildLectureRequestSummary(req);
  for (const value of [req.site, req.instructor, req.courseName, req.startDate, String(req.perDay), req.note]) {
    assert.ok(summary.includes(value), 'summary should contain ' + value);
  }
});

test('saving sends one student-owned request with every field and no course assignment', () => {
  const api = harness();
  api.act('lecturerequestsave', requestFields());
  assert.equal(api.state.tasks.length, 1);
  const req = api.state.tasks[0];
  for (const [key, value] of Object.entries({ kind: 'lecture_request', staffId: 'student-a', origin: 'staff',
    site: '메가스터디', instructor: '김강사', courseName: '수학 개념 완성', startDate: TODAY,
    perDay: 2, repeat: 'request', source: '', requestRevision: 1 })) assert.equal(req[key], value, key);
  assert.equal(api.effects.saved, 1);
  assert.equal(api.effects.synced, 1);
  assert.deepEqual(api.state.checks, {}, 'requesting must not generate an assigned timetable');
  api.act('lecturerequestsave', requestFields({ lectureSite: ' 메가스터디 ', lectureNote: '메모 변경' }));
  assert.equal(api.state.tasks.length, 1, 'same active request must not be sent twice');
  assert.equal(api.effects.synced, 1);
});

test('request save validates required fields, real dates and integer daily counts', () => {
  const invalid = [
    { lectureSite: '' }, { lectureInstructor: '  ' }, { lectureCourseName: '' },
    { lectureStartDate: '' }, { lectureStartDate: '2026-09-01' },
    { lectureStartDate: '2026-02-30' }, { lectureStartDate: '2026-13-01' },
    { lectureStartDate: '2026-9-3' }, { lecturePerDay: '' }, { lecturePerDay: '0' },
    { lecturePerDay: '21' }, { lecturePerDay: '1.5' }, { lecturePerDay: 'oops' },
    { lectureSite: 'x'.repeat(81) }, { lectureInstructor: 'x'.repeat(81) },
    { lectureCourseName: 'x'.repeat(161) }, { lectureNote: 'x'.repeat(501) }
  ];
  for (const values of invalid) {
    const api = harness();
    api.act('lecturerequestsave', requestFields(values));
    assert.equal(api.state.tasks.length, 0, JSON.stringify(values));
    assert.equal(api.effects.synced, 0);
    assert.ok(api.effects.toasts.length, 'invalid form must explain how to correct it');
  }
  const api = harness();
  api.act('lecturerequestsave', requestFields({ lecturePerDay: '20', lectureNote: '' }));
  assert.equal(api.state.tasks[0].perDay, 20);
});

test('only the student in the current link can open and submit their own request', () => {
  for (const options of [{ role: 'manager' }, { role: 'admin' }, { selected: 'student-b' }]) {
    const api = harness(options);
    api.act('lecturerequestopen');
    api.act('lecturerequestsave', requestFields());
    assert.equal(api.effects.modals.length, 0);
    assert.equal(api.state.tasks.length, 0);
  }
  const api = harness({ tasks: [request({ staffId: 'student-b' })] });
  api.act('lecturerequestopen', {}, { id: 'request-a' });
  api.act('lecturerequestsave', requestFields({ lectureRequestId: 'request-a', lectureRequestRevision: '1' }));
  api.act('lecturerequestcancel', {}, { id: 'request-a', revision: '1' });
  assert.equal(api.effects.modals.length, 0);
  assert.equal(api.effects.synced, 0);
  assert.equal(api.state.tasks[0].cancelledAt, undefined);
});

test('missing and stale edit targets are rejected, while an own current request keeps its identity', () => {
  const api = harness({ tasks: [request()] });
  api.act('lecturerequestsave', requestFields({ lectureRequestId: 'missing', lectureRequestRevision: '1' }));
  api.act('lecturerequestsave', requestFields({ lectureRequestId: 'request-a', lectureRequestRevision: '0' }));
  assert.equal(api.effects.synced, 0);
  assert.equal(api.state.tasks.length, 1);
  api.act('lecturerequestsave', requestFields({ lectureRequestId: 'request-a', lectureRequestRevision: '1', lecturePerDay: '3' }));
  assert.equal(api.state.tasks.length, 1);
  assert.equal(api.state.tasks[0].id, 'request-a');
  assert.equal(api.state.tasks[0].perDay, 3);
  assert.equal(api.state.tasks[0].requestRevision, 2);
  assert.equal(api.effects.synced, 1);
});

test('students cannot change a reviewed or answered request but can cancel an open current one', () => {
  for (const status of ['reviewing', 'answered']) {
    const req = request();
    const api = harness({ tasks: [req, response(req, { status })] });
    api.act('lecturerequestopen', {}, { id: req.id });
    api.act('lecturerequestsave', requestFields({ lectureRequestId: req.id, lectureRequestRevision: '1' }));
    api.act('lecturerequestcancel', {}, { id: req.id, revision: '1' });
    assert.equal(api.effects.modals.length, 0);
    assert.equal(api.effects.synced, 0);
  }
  const api = harness({ tasks: [request()] });
  api.act('lecturerequestcancel', {}, { id: 'request-a', revision: '0' });
  assert.equal(api.effects.synced, 0, 'stale cancel must not destroy the newer request');
  api.act('lecturerequestcancel', {}, { id: 'request-a', revision: '1' });
  assert.equal(api.lectureRequestStatus(api.state.tasks[0]), 'cancelled');
  assert.equal(api.effects.synced, 1);
});

test('director response is separate, deterministic and contains an immutable request snapshot', () => {
  const api = harness({ tasks: [request()], role: 'admin' });
  const req = api.state.tasks[0];
  const before = JSON.stringify(req);
  api.setLectureResponse(req, 'reviewing', '강좌를 확인하고 있어요');
  api.setLectureResponse(req, 'answered', '등록했습니다. 인강 탭에서 확인해 주세요');
  assert.equal(api.state.tasks.length, 2);
  assert.equal(JSON.stringify(req), before, 'director must not rewrite the student-owned row');
  const answer = api.lectureResponseFor(req.id);
  assert.equal(answer.id, 'lecture-response-request-a');
  assert.equal(answer.origin, 'admin');
  assert.equal(answer.staffId, req.staffId);
  assert.equal(answer.lectureRequestId, req.id);
  assert.equal(answer.repeat, 'request');
  assert.equal(answer.source, '');
  assert.equal(answer.status, 'answered');
  assert.equal(answer.requestSnapshot, api.buildLectureRequestSummary(req));
  const snapshot = answer.requestSnapshot;
  req.note = '나중에 수정된 내용';
  assert.equal(answer.requestSnapshot, snapshot);
  assert.notEqual(answer.requestSnapshot, api.buildLectureRequestSummary(req));
});

test('response actions require director authority, current revision and an answer message', () => {
  const fields = { lectureResponseId: 'request-a', lectureResponseRevision: '1',
    lectureResponseStatus: 'answered', lectureResponseNote: '등록을 완료했어요' };
  for (const role of ['student', 'manager']) {
    const api = harness({ tasks: [request()], role });
    api.act('lectureresponseopen', {}, { id: 'request-a' });
    api.act('lectureresponsesave', fields);
    assert.equal(api.effects.modals.length, 0);
    assert.equal(api.state.tasks.length, 1);
  }
  for (const values of [{ lectureResponseRevision: '0' }, { lectureResponseStatus: 'other' },
    { lectureResponseNote: '' }, { lectureResponseNote: 'x'.repeat(501) }, { lectureResponseId: 'missing' }]) {
    const api = harness({ tasks: [request()], role: 'admin' });
    api.act('lectureresponsesave', { ...fields, ...values });
    assert.equal(api.state.tasks.length, 1, JSON.stringify(values));
    assert.equal(api.effects.synced, 0);
  }
  const api = harness({ tasks: [request()], role: 'admin' });
  api.act('lectureresponsesave', fields);
  assert.equal(api.lectureRequestStatus(api.state.tasks[0]), 'answered');
  assert.equal(api.effects.synced, 1);
  const cancelled = harness({ tasks: [request({ cancelledAt: 88 })], role: 'admin' });
  cancelled.act('lectureresponsesave', fields);
  assert.equal(cancelled.state.tasks.length, 1);
});

test('student request form is available without courses and escapes student and director text', () => {
  const api = harness();
  const panel = api.lectureRequestPanel(api.state.staff[0]);
  assert.match(panel, /data-act="lecturerequestopen"/);
  api.act('lecturerequestopen');
  assert.equal(api.effects.modals.length, 1);
  const form = api.effects.modals[0].body;
  for (const id of Object.keys(requestFields())) assert.ok(form.includes('id="' + id + '"'), id);
  const req = request({ courseName: '<script>alert(1)</script>', instructor: '<img src=x onerror=alert(1)>', note: '<svg onload=alert(1)>' });
  api.state.tasks.push(req, response(req, { responseNote: '<b onclick=alert(1)>답변</b>' }));
  const card = api.lectureRequestCard(req, false);
  assert.doesNotMatch(card, /<script>|<img src=x|<svg onload|<b onclick/);
  assert.match(card, /&lt;script&gt;/);
  assert.match(card, /&lt;b onclick/);
  assert.match(functionSource('viewIngang'), /lectureRequestPanel/);
  assert.match(functionSource('viewIngang'), /lectureRequestInbox/);
});

test('director registration opens the requested student and prefills a course without assigning it', () => {
  const req = request({ staffId: 'student-b' });
  for (const role of ['student', 'manager', 'admin']) {
    const api = harness({ tasks: [req], role });
    api.act('lecturerequestregister', {}, { id: req.id });
    if (role === 'admin') {
      assert.equal(api.effects.registration.studentId, 'student-b');
      assert.equal(api.effects.registration.request.id, req.id);
    } else assert.equal(api.effects.registration, undefined);
    assert.deepEqual(api.state.checks, {});
    assert.equal(api.state.tasks.length, 1);
  }
  const captures = [];
  const open = Function('captures', `
    const ING_PLATFORMS = ['메가스터디', '이투스', '기타'];
    const ING_PROVIDER_URLS = {};
    const esc = value => String(value || '').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    const studySubjectOptions = () => '<option>수학</option>';
    const modal = (title, body, footer) => captures.push({ title, body, footer });
    ${functionSource('buildLectureRequestSummary')}
    ${functionSource('ingAddModal')}
    return ingAddModal;
  `)(captures);
  open(req);
  open();
  assert.match(captures[0].body, /id="ingName" value="수학 개념 완성"/);
  assert.match(captures[0].body, /class="chip on"[^>]*data-v="메가스터디"/);
  assert.match(captures[0].body, /학생 요청/);
  assert.match(captures[1].body, /id="ingName" value=""/);
  assert.doesNotMatch(captures[1].body, /학생 요청/);
});
