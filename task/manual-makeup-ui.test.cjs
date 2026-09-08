const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

function block(from, to) {
  const start = html.indexOf(from);
  const end = html.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `${from} 블록을 찾을 수 없습니다`);
  return html.slice(start, end);
}

function manualMakeupSubmitHarness(options = {}) {
  const values = {
    muManualStudent: 'student-8', muManualSourceTask: 'lesson-3', muManualReason: 'manual_exam',
    muManualDate: '2026-08-14', muManualStart: '14:00', muManualEnd: '14:50', muManualStaff: 'staff-1',
    ...options.values
  };
  const calls = [];
  const bindings = {
    $: id => ({ value: values[id.slice(1)] }),
    session: options.session || { isAdmin: false, isStaffLink: true, staffId: 'staff-1' },
    manualMakeupSourceLessons: () => options.lessons || [{ id: 'lesson-3', staffId: 'staff-1' }],
    MANUAL_MAKEUP_REASON_LABELS: { manual_absence: '결석보강', manual_exam: '시험보강', manual_other: '기타보강' },
    MANUAL_MAKEUP_UNRELATED: '__unrelated__',
    manualMakeupRequestId: 'request-8',
    today: () => '2026-09-08',
    showMakeupModalError: error => calls.push({ error }),
    makeupActiveStaff: id => ['staff-1', 'staff-2'].includes(id) ? { id } : null,
    mutateMakeup: async payload => calls.push({ payload })
  };
  const source = block('async function submitManualMakeup(button)', 'function makeupCanComplete');
  const submit = new Function(...Object.keys(bindings), `${source}\nreturn submitManualMakeup;`)(...Object.values(bindings));
  return { submit, calls };
}

test('관리자와 개인 인증 선생님 보강 탭에 수업무관 보강생성 진입점을 표시한다', () => {
  const view = block('function viewMakeups()', 'async function refreshMakeupsAfterConflict');

  assert.match(view, /session\.isAdmin \|\| \(session\.isStaffLink && session\.staffId\)/);
  assert.match(view, /data-act="mumanualopen">보강생성\(수업무관\)<\/button>/);
  assert.match(view, /관리자·선생님이 직접 생성한 보강/);
  assert.match(view, /위 보강생성\(수업무관\) 버튼을 사용하거나 수업 카드에서 결석을 기록해 주세요/);
  assert.match(view, /!rosterDb && !rosterErr && !rosterLoading/);
  assert.match(view, /loadRoster\(\)/);

  const modal = block('function openManualMakeupModal()', 'async function submitManualMakeup');
  assert.match(modal, /if \(!\(session\.isAdmin \|\| \(session\.isStaffLink && session\.staffId\)\)\) return/);
});

test('수동 보강은 원생을 먼저 고르고 권한 범위의 현재 정규수업만 고른다', () => {
  const lessonSource = block('function manualMakeupStudents()', 'function manualMakeupSourceLessonLabel');
  const modal = block('function openManualMakeupModal()', 'async function submitManualMakeup');
  const change = block("document.addEventListener('change', ev => {\n  const manualMakeupStudent", "document.addEventListener('toggle'");

  assert.match(lessonSource, /studentLinkCandidates\(today\(\)\.slice\(0, 7\), false\)/);
  assert.match(lessonSource, /filter\(student =>\s*allowedIds\.has\(String\(student\.id \|\| ''\)\)\)/);
  assert.match(lessonSource, /isRegularLessonTask\(task\)/);
  assert.match(lessonSource, /!stableId \|\| String\(task\.studentId \|\| ''\) === stableId/);
  assert.match(lessonSource, /session\.isAdmin \|\| \(session\.isStaffLink && String\(task\.staffId \|\| ''\) === String\(session\.staffId \|\| ''\)\)/);
  assert.match(lessonSource, /String\(task\.start\) <= reference/);
  assert.match(lessonSource, /String\(task\.end\) >= reference/);
  assert.ok(modal.indexOf('id="muManualStudent"') < modal.indexOf('id="muManualSourceTask"'));
  assert.match(modal, /id="muManualSourceTask" data-manual-makeup-source disabled/);
  assert.match(html, /<option value="' \+ MANUAL_MAKEUP_UNRELATED \+ '">수업무관<\/option>/);
  assert.match(change, /updateManualMakeupLessonSelect\(String\(manualMakeupStudent\.value \|\| ''\)\)/);
  assert.match(change, /updateManualMakeupStaffSelect\(String\(manualMakeupSource\.value \|\| ''\)\)/);
  assert.doesNotMatch(change.slice(0, change.indexOf('const teacherLiveRequestLesson')), /render\(/,
    '원생을 고를 때 모달이나 전체 화면을 다시 그리지 않는다');
});

test('관리자는 모든 담당 수업을, 선생님은 자신의 stable staffId 수업만 선택한다', () => {
  const source = block('function manualMakeupSourceLessons(studentId)', 'function manualMakeupSourceLessonLabel');
  const tasks = [
    { id: 'mine', studentId: 'student-1', staffId: 'staff-1', start: '2026-01-01', end: '', subject: '수학' },
    { id: 'other', studentId: 'student-1', staffId: 'staff-2', start: '2026-01-01', end: '', subject: '영어' },
    { id: 'future', studentId: 'student-1', staffId: 'staff-1', start: '2026-10-01', end: '', subject: '과학' }
  ];
  const make = session => new Function('state', 'session', 'today', 'isRegularLessonTask', 'staffById',
    `${source}\nreturn manualMakeupSourceLessons;`)(
      { tasks }, session, () => '2026-09-03', () => true,
      id => ({ id, name: id === 'staff-1' ? '내선생님' : '다른선생님' })
    );

  assert.deepEqual(make({ isAdmin: true, isStaffLink: false })('student-1').map(task => task.id).sort(), ['mine', 'other']);
  assert.deepEqual(make({ isAdmin: false, isStaffLink: true, staffId: 'staff-1' })('student-1').map(task => task.id), ['mine']);
  assert.deepEqual(make({ isAdmin: false, isStaffLink: true, staffId: 'staff-2' })('student-1').map(task => task.id), ['other']);
});

test('관리자는 모든 재원생을, 선생님은 담당 정규수업이 있는 원생만 후보로 본다', () => {
  const source = block('function manualMakeupStudents()', 'function manualMakeupSourceLessons(studentId)');
  const students = session => new Function('manualMakeupSourceLessons', 'studentLinkCandidates', 'today', 'session',
    `${source}\nreturn manualMakeupStudents;`)(
      () => [{ studentId: 'student-1' }],
      () => [{ id: 'student-1', name: '연결원생' }, { id: 'student-2', name: '수업없는원생' }],
      () => '2026-09-03', session
    );

  assert.deepEqual(students({ isAdmin: true })().map(student => student.id), ['student-1', 'student-2']);
  assert.deepEqual(students({ isAdmin: false })().map(student => student.id), ['student-1']);
});

test('수동 보강 모달은 고정 사유와 날짜·시작·종료 입력을 제공한다', () => {
  const reasons = block('const MANUAL_MAKEUP_REASON_OPTIONS', 'function makeupCaseForSource');
  const modal = block('function openManualMakeupModal()', 'async function submitManualMakeup');

  for (const [code, label] of [
    ['manual_absence', '결석보강'], ['manual_exam', '시험보강'], ['manual_other', '기타보강']
  ]) {
    assert.match(reasons, new RegExp(`\\['${code}', '${label}'\\]`));
  }
  assert.match(modal, /id="muManualReason"/);
  assert.match(modal, /manualMakeupStaffFieldHtml\(\)/);
  assert.match(modal, /id="muManualDate" type="date"/);
  assert.doesNotMatch(modal, /id="muManualDate"[^>]*\bmin=/, '지난 달 보강 날짜도 선택할 수 있다');
  assert.match(modal, /id="muManualStart" type="time"/);
  assert.match(modal, /id="muManualEnd" type="time"/);
  assert.match(modal, /원 수업의 출결은 바꾸지 않습니다/);
  assert.match(modal, /결석보강만 회차를 1회 차감/);
  assert.match(modal, /시험보강·기타보강은 회차를 추가 차감하지 않습니다/);
  assert.doesNotMatch(modal, /<textarea|prompt\s*\(/i);
});

test('관리자와 선생님은 지난 8월 날짜로 연결·수업무관 보강 생성 요청을 보낸다', async () => {
  for (const session of [{ isAdmin: true }, { isAdmin: false, isStaffLink: true, staffId: 'staff-1' }]) {
    for (const sourceMode of ['linked', 'unrelated']) {
      const api = manualMakeupSubmitHarness({ session, values: {
        muManualSourceTask: sourceMode === 'linked' ? 'lesson-3' : '__unrelated__'
      } });
      await api.submit({});
      assert.deepEqual(api.calls, [{ payload: {
        action: 'create_manual', studentId: 'student-8', sourceMode,
        ...(sourceMode === 'linked' ? { sourceTaskId: 'lesson-3' } : { requestId: 'request-8' }),
        reason: 'manual_exam', date: '2026-08-14', startTime: '14:00', endTime: '14:50', staffId: 'staff-1'
      } }]);
    }
  }
});

test('지난 날짜 수동 생성도 누락된 일시와 종료가 시작보다 이르거나 같은 시간은 차단한다', async () => {
  for (const values of [
    { muManualDate: '' }, { muManualStart: '' }, { muManualEnd: '' },
    { muManualEnd: '14:00' }, { muManualEnd: '13:50' }
  ]) {
    const api = manualMakeupSubmitHarness({ values });
    await api.submit({});
    assert.deepEqual(api.calls, [{ error: '날짜·시작시간·종료시간을 모두 확인해 주세요' }]);
  }
});

test('지난 날짜 수동 생성도 인증·원 수업·담당자 권한을 유지한다', async () => {
  for (const session of [{}, { isStaffLink: true }, { staffId: 'staff-1' }]) {
    const api = manualMakeupSubmitHarness({ session });
    await api.submit({});
    assert.deepEqual(api.calls, []);
  }
  for (const [options, error] of [
    [{ lessons: [] }, '현재 배정된 원 수업을 선택해 주세요'],
    [{ values: { muManualStaff: 'staff-2' } }, '선생님은 다른 선생님에게 보강을 직접 배정할 수 없습니다'],
    [{ values: { muManualStaff: 'inactive-staff' } }, '활성 보강 담당 선생님을 선택해 주세요']
  ]) {
    const api = manualMakeupSubmitHarness(options);
    await api.submit({});
    assert.deepEqual(api.calls, [{ error }]);
  }
});

test('수업무관 보강은 관리자만 실제 담당을 고르고 선생님은 본인 stable staffId로 고정한다', () => {
  const helper = block('function updateManualMakeupStaffSelect(sourceTaskId)', 'function openManualMakeupModal()');
  assert.match(helper, /if \(!session\.isAdmin\)/);
  assert.match(helper, /field\.value = String\(session\.staffId \|\| ''\)/);
  assert.match(helper, /makeupStaffOptionsHtml\(defaultStaffId\)/);
  assert.match(helper, /실제 보강 담당 선생님/);
  assert.match(helper, /id="muManualStaff" disabled/);
  assert.match(helper, /type="hidden" value="' \+ esc\(session\.staffId \|\| ''\)/);
  assert.match(helper, /다른 선생님 배정은 관리자에게 요청해 주세요/);
});

test('확인은 create_manual의 정확한 식별자·사유·일시만 전송한다', async () => {
  const source = block('async function submitManualMakeup(button)', 'function makeupCanComplete');
  const elements = {
    muManualStudent: { value: 'student-8' }, muManualSourceTask: { value: 'lesson-3' },
    muManualReason: { value: 'manual_exam' }, muManualDate: { value: '2026-09-06' },
    muManualStart: { value: '14:00' }, muManualEnd: { value: '14:50' },
    muManualStaff: { value: 'staff-1' }
  };
  const calls = [];
  const submit = new Function('$', 'session', 'manualMakeupSourceLessons', 'MANUAL_MAKEUP_REASON_LABELS',
    'MANUAL_MAKEUP_UNRELATED',
    'today', 'showMakeupModalError', 'makeupActiveStaff', 'mutateMakeup', `${source}\nreturn submitManualMakeup;`)(
      id => elements[id.slice(1)] || null,
      { isAdmin: false, isStaffLink: true, staffId: 'staff-1' },
      studentId => studentId === 'student-8' ? [{ id: 'lesson-3' }] : [],
      { manual_exam: '시험보강' },
      '__unrelated__',
      () => '2026-09-03',
      message => calls.push({ error: message }),
      staffId => staffId === 'staff-1' ? { id: staffId } : null,
      async (payload, button, successText, focusAct, closeOnSuccess) => {
        calls.push({ payload, button, successText, focusAct, closeOnSuccess });
      }
    );
  const button = { disabled: false };
  await submit(button);

  assert.deepEqual(calls, [{
    payload: {
      action: 'create_manual', studentId: 'student-8', sourceTaskId: 'lesson-3',
      sourceMode: 'linked',
      reason: 'manual_exam', date: '2026-09-06', startTime: '14:00', endTime: '14:50', staffId: 'staff-1'
    },
    button,
    successText: '보강수업을 생성했습니다',
    focusAct: '',
    closeOnSuccess: true
  }]);
});

test('수업무관 선택은 현재 담당 수업을 권한 근거로만 보내고 결석보강은 차단한다', async () => {
  const source = block('async function submitManualMakeup(button)', 'function makeupCanComplete');
  const elements = {
    muManualStudent: { value: 'student-8' }, muManualSourceTask: { value: '__unrelated__' },
    muManualReason: { value: 'manual_exam' }, muManualDate: { value: '2026-09-06' },
    muManualStart: { value: '14:00' }, muManualEnd: { value: '14:50' },
    muManualStaff: { value: 'staff-1' }
  };
  const calls = [];
  const submit = new Function('$', 'session', 'manualMakeupSourceLessons', 'MANUAL_MAKEUP_REASON_LABELS',
    'MANUAL_MAKEUP_UNRELATED', 'manualMakeupRequestId', 'today', 'showMakeupModalError', 'makeupActiveStaff', 'mutateMakeup',
    `${source}\nreturn submitManualMakeup;`)(
      id => elements[id.slice(1)] || null,
      { isAdmin: false, isStaffLink: true, staffId: 'staff-1' },
      () => [{ id: 'lesson-3', staffId: 'staff-1' }],
      { manual_absence: '결석보강', manual_exam: '시험보강' }, '__unrelated__', 'request-8',
      () => '2026-09-03', message => calls.push({ error: message }),
      staffId => staffId === 'staff-1' ? { id: staffId } : null,
      async payload => calls.push({ payload })
    );

  await submit({});
  assert.deepEqual(calls, [{ payload: {
    action: 'create_manual', studentId: 'student-8', sourceMode: 'unrelated', requestId: 'request-8',
    reason: 'manual_exam', date: '2026-09-06', startTime: '14:00', endTime: '14:50', staffId: 'staff-1'
  } }]);

  calls.length = 0;
  elements.muManualReason.value = 'manual_absence';
  await submit({});
  assert.deepEqual(calls, [{ error: '결석보강은 회차 차감의 근거가 되는 원 수업을 선택해 주세요' }]);
});

test('원 수업이 없는 원생도 수업무관 선택지는 활성화된다', () => {
  const optionsSource = block('function manualMakeupLessonOptionsHtml(studentId)', 'function updateManualMakeupLessonSelect');
  const options = new Function('manualMakeupSourceLessons', 'MANUAL_MAKEUP_UNRELATED', 'esc',
    `${optionsSource}\nreturn manualMakeupLessonOptionsHtml;`)(() => [], '__unrelated__', String);
  assert.match(options('student-no-lesson'), /value="__unrelated__">수업무관/);

  const update = block('function updateManualMakeupLessonSelect(studentId)', 'function updateManualMakeupStaffSelect');
  assert.match(update, /select\.disabled = !studentId/);
  assert.doesNotMatch(update, /select\.disabled = !studentId \|\| !lessons\.length/);
});

test('수업무관을 선택하면 결석보강을 즉시 비활성화하고 기존 선택은 시험보강으로 바꾼다', () => {
  const update = block('function updateManualMakeupStaffSelect(sourceTaskId)', 'function manualMakeupStaffFieldHtml');
  assert.match(update, /absenceOption\.disabled = unrelated/);
  assert.match(update, /reasonField\.value === 'manual_absence'/);
  assert.match(update, /reasonField\.value = 'manual_exam'/);
});

test('수동 생성 카드에는 결석 원 수업 표현 대신 생성 사유를 표시한다', () => {
  const card = block('function makeupCard(row)', 'function makeupKpis(rows)');

  assert.match(card, /row\.creationType === 'manual'/);
  assert.match(card, /MANUAL_MAKEUP_REASON_LABELS\[row\.manualReason\]/);
  assert.match(card, /직접 생성 ·/);
  assert.match(card, /: '원 수업 ' \+ esc\(row\.sourceDate\)/);
  assert.match(card, /row\.sourceMode === 'unrelated'/);
  assert.match(card, /원 수업 · 수업무관/);
});

test('수동 보강은 정규수업 결석 카드의 연결·완료 상태를 가로채지 않는다', () => {
  const lookup = block('function makeupCaseForSource(taskId, date)', 'function makeupCompletionTagHtml');
  const findCase = new Function('makeupRows', `${lookup}\nreturn makeupCaseForSource;`)([
    { caseId: 'manual-1', creationType: 'manual', sourceTaskId: 'lesson-1', sourceDate: '2026-09-06', status: 'completed' },
    { caseId: 'absence-1', creationType: 'absence', sourceTaskId: 'lesson-1', sourceDate: '2026-09-06', status: 'review_pending' }
  ]);

  assert.equal(findCase('lesson-1', '2026-09-06').caseId, 'absence-1');
  assert.equal(new Function('makeupRows', `${lookup}\nreturn makeupCaseForSource;`)([
    { caseId: 'manual-only', creationType: 'manual', sourceTaskId: 'lesson-2', sourceDate: '2026-09-06' }
  ])('lesson-2', '2026-09-06'), null);
  assert.equal(new Function('makeupRows', `${lookup}\nreturn makeupCaseForSource;`)([
    { caseId: 'unproven', creationType: 'unknown', sourceTaskId: 'lesson-3', sourceDate: '2026-09-06' }
  ])('lesson-3', '2026-09-06'), null, '출처가 입증되지 않은 레거시 행도 결석 보강으로 추정하지 않는다');
});

test('클릭 라우팅과 서버 정본 수업 즉시 반영에 수동 생성이 연결된다', () => {
  const clicks = block("case 'murefresh':", '/* 날짜 */');
  const mutation = block('async function mutateMakeup', 'async function createMakeupFromAbsence');

  assert.match(clicks, /case 'mumanualopen': openManualMakeupModal\(\)/);
  assert.match(clicks, /case 'mumanualsubmit': submitManualMakeup\(el\)/);
  assert.match(mutation, /result\.lessonTask && result\.lessonTask\.id/);
  assert.match(mutation, /payload\.action === 'create_manual'/);
});
