const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function functionSource(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' function is present');
  const open = html.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < html.length; index++) {
    if (html[index] === '{') depth++;
    else if (html[index] === '}' && --depth === 0) return html.slice(start, index + 1);
  }
  throw new Error('unterminated function: ' + name);
}

test('관리자 설정에 기존 백업과 별도의 업무지시서 JSON 버튼이 있다', () => {
  const settings = html.slice(html.indexOf('function viewSettings('), html.indexOf('/* ══', html.indexOf('function viewSettings(')));
  assert.match(settings, /data-act="export">내보내기/);
  assert.match(settings, /data-act="import">가져오기/);
  assert.match(settings, /data-act="taskjsonexport">업무지시서 JSON 받기/);
  assert.match(settings, /학생 개인정보가 없는지 전달 전에 확인/);

  const start = html.indexOf("case 'taskjsonexport':");
  const action = html.slice(start, html.indexOf("case 'import':", start));
  assert.match(action, /if \(!session\.isAdmin\) break/);
  assert.match(action, /downloadFile\('wb-업무지시서-외부전달-' \+ today\(\) \+ '\.json'/);
  assert.match(action, /'application\/json'/);
  assert.doesNotMatch(action, /JSON\.stringify\(state/);
});

test('외부 전달 JSON은 일반 업무 필드만 내보내고 비밀값과 학생 데이터를 제외한다', () => {
  const state = {
    settings: { adminPin: 'PIN_SENTINEL', syncSecret: 'SECRET_SENTINEL', myToken: 'TOKEN_SENTINEL' },
    checks: { private: 'CHECK_NOTE_SENTINEL' },
    staff: [{ id: 'staff-a', name: '김담당', phone: 'STAFF_PRIVATE_SENTINEL' }],
    tasks: [
      {
        id: 'task-a', groupId: 'group-a', staffId: 'staff-a', title: '재고 조사', detail: '교구 수량 확인',
        guide: '창고부터 확인', steps: [{ id: 'step-a', label: '수량 세기', private: 'STEP_PRIVATE_SENTINEL' }],
        target: '2', unit: '곳', time: '09:00', priority: 'high', repeat: 'days', days: ['1', 9],
        start: '2026-09-30', end: '2026-10-31', carry: false, origin: 'admin', createdAt: '100', updatedAt: 200,
        studentName: 'TASK_PRIVATE_SENTINEL'
      },
      { id: 'deleted', title: 'DELETED_SENTINEL', deleted: true },
      { id: 'book', title: '[주문] BOOK_SENTINEL' },
      { id: 'lesson', title: '[수업] LESSON_SENTINEL' },
      { id: 'session', title: 'SESSION_SENTINEL', taskKind: 'lesson_instruction' },
      { id: 'makeup', title: 'MAKEUP_SENTINEL', makeupCaseId: 'case-a' }
    ]
  };
  const build = new Function('state', 'staffById', 'isBookOrderWorkTask', 'isLesson',
    'isSessionLessonTask', 'isScheduledMakeupTask',
    functionSource('taskJsonExportPayload') + '; return taskJsonExportPayload("2026-09-30T00:00:00.000Z");');
  const payload = build(
    state,
    id => state.staff.find(staff => staff.id === id),
    task => /^\[주문\]/.test(task.title || ''),
    task => /^\[(수업|컨설팅)\]/.test(task.title || ''),
    task => task.taskKind === 'lesson_instruction',
    task => !!task.makeupCaseId
  );

  assert.deepEqual(Object.keys(payload).sort(), ['app', 'exportedAt', 'items', 'schema']);
  assert.equal(payload.schema, 'wb-task-transfer-v1');
  assert.equal(payload.app, 'task');
  assert.equal(payload.exportedAt, '2026-09-30T00:00:00.000Z');
  assert.equal(payload.items.length, 1);
  assert.deepEqual(Object.keys(payload.items[0]).sort(), [
    'carry', 'createdAt', 'days', 'detail', 'end', 'groupId', 'guide', 'origin', 'priority', 'repeat',
    'staffId', 'staffName', 'start', 'steps', 'target', 'taskId', 'time', 'title', 'unit', 'updatedAt'
  ]);
  assert.deepEqual(payload.items[0].steps, [{ id: 'step-a', label: '수량 세기' }]);
  assert.deepEqual(payload.items[0].days, [1]);

  const json = JSON.stringify(payload);
  for (const forbidden of [
    'PIN_SENTINEL', 'SECRET_SENTINEL', 'TOKEN_SENTINEL', 'CHECK_NOTE_SENTINEL', 'STAFF_PRIVATE_SENTINEL',
    'STEP_PRIVATE_SENTINEL', 'TASK_PRIVATE_SENTINEL', 'DELETED_SENTINEL', 'BOOK_SENTINEL', 'LESSON_SENTINEL',
    'SESSION_SENTINEL', 'MAKEUP_SENTINEL'
  ]) assert.ok(!json.includes(forbidden), forbidden);
});

test('관리자 보강 화면에 반·학생 목록 JSON 버튼과 안전한 다운로드 동작이 있다', () => {
  const makeups = functionSource('viewMakeups');
  assert.match(makeups, /session\.isAdmin[\s\S]*data-act="classrosterjsonexport">반·학생 목록 JSON 받기/);

  const start = html.indexOf("case 'classrosterjsonexport':");
  const action = html.slice(start, html.indexOf("case 'import':", start));
  assert.match(action, /if \(!session\.isAdmin\) break/);
  assert.match(action, /if \(!rosterDb\)/);
  assert.match(action, /rosterErr = ''[\s\S]*loadRoster\(\)/);
  assert.match(action, /classRosterJsonExportPayload\(\)/);
  assert.match(action, /downloadFile\('wb-반별-학생목록-' \+ today\(\) \+ '\.json'/);
  assert.match(action, /'application\/json'/);
  assert.doesNotMatch(action, /JSON\.stringify\(state/);
});

test('반·학생 목록 JSON은 활성 반과 학생 식별값·이름만 내보낸다', () => {
  const reference = '2026-10-01';
  const students = [
    { id: 'student-b', name: '가상학생나', phoneMother: 'PHONE_SENTINEL', memo: 'MEMO_SENTINEL' },
    { id: 'student-a', name: '가상학생가', school: 'SCHOOL_SENTINEL', parentRequest: 'PARENT_SENTINEL' }
  ];
  const tasks = [
    { id: 'lesson-a', studentId: 'student-a', staffId: 'staff-a', subject: '수학', scheduleText: '월·수 16:00', start: '2026-09-01', detail: 'DETAIL_SENTINEL' },
    { id: 'lesson-b', studentId: 'student-b', staffId: 'staff-a', subject: '수학', scheduleText: '월·수 16:00', start: '2026-09-01' },
    { id: 'lesson-duplicate', studentId: 'student-a', staffId: 'staff-a', subject: '수학', scheduleText: '월·수 16:00', start: '2026-09-01' },
    { id: 'future', studentId: 'student-a', staffId: 'staff-a', subject: '영어', scheduleText: '금 17:00', start: '2026-11-01', futureSecret: 'FUTURE_SENTINEL' },
    { id: 'ended', studentId: 'student-a', staffId: 'staff-a', subject: '국어', end: '2026-09-30', endedSecret: 'ENDED_SENTINEL' },
    { id: 'deleted', studentId: 'student-a', staffId: 'staff-a', subject: '과학', deleted: true, deletedSecret: 'DELETED_SENTINEL' },
    { id: 'makeup', studentId: 'student-a', staffId: 'staff-a', subject: '사회', makeupCaseId: 'case-a', makeupSecret: 'MAKEUP_SENTINEL' }
  ];
  const build = new Function('today', 'studentLinkCandidates', 'rosterStudentAssignedLessonTasks',
    'lessonAssignmentScheduleText', 'staffById',
    functionSource('classRosterJsonExportPayload') +
    '; return classRosterJsonExportPayload("2026-10-01T00:00:00.000Z");');
  const payload = build(
    () => reference,
    () => students,
    (studentId, date) => tasks.filter(task => task.studentId === studentId && !task.deleted && !task.makeupCaseId && (!task.end || task.end >= date)),
    () => '',
    id => id === 'staff-a' ? { id, name: '김담당', phone: 'STAFF_PHONE_SENTINEL' } : null
  );

  assert.deepEqual(Object.keys(payload).sort(), ['app', 'asOf', 'classes', 'exportedAt', 'schema']);
  assert.equal(payload.schema, 'wb-class-roster-v1');
  assert.equal(payload.app, 'task');
  assert.equal(payload.asOf, reference);
  assert.equal(payload.exportedAt, '2026-10-01T00:00:00.000Z');
  assert.deepEqual(payload.classes, [{
    className: '수학 · 월·수 16:00 · 김담당 선생님',
    students: [
      { studentId: 'student-a', name: '가상학생가' },
      { studentId: 'student-b', name: '가상학생나' }
    ]
  }]);

  const json = JSON.stringify(payload);
  for (const forbidden of [
    'PHONE_SENTINEL', 'MEMO_SENTINEL', 'SCHOOL_SENTINEL', 'PARENT_SENTINEL', 'DETAIL_SENTINEL',
    'FUTURE_SENTINEL', 'ENDED_SENTINEL', 'DELETED_SENTINEL', 'MAKEUP_SENTINEL', 'STAFF_PHONE_SENTINEL'
  ]) assert.ok(!json.includes(forbidden), forbidden);
});
