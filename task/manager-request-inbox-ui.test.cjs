const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function inboxRowsFor(overrides = {}) {
  const start = source.indexOf('function managerRequestTeacher(');
  const end = source.indexOf('function managerRequestInboxCount(', start);
  assert.ok(start >= 0 && end > start, '통합 요청함 순수 행 생성기를 찾을 수 있어야 한다');
  const names = {
    teacherA: { id: 'teacher-a', name: '염다솜' },
    teacherB: { id: 'teacher-b', name: '김민지' }
  };
  const values = {
    session: { isAdmin: true },
    staffById: id => Object.values(names).find(row => row.id === id),
    lessonAssignmentRequests: [{ status: 'approval_waiting', studentName: '학생A', grade: '초4', staffId: 'teacher-a', updatedAt: 6 }],
    lessonChangeQueue: [{ status: 'approval_waiting', taskId: 'lesson-a', owner: 'teacher-b', updatedAt: 5 }],
    feedbackQueue: [
      { status: 'approval_waiting', taskId: 'lesson-a', studentName: '학생A', owner: 'teacher-a', updatedAt: 4 },
      { status: 'content_approved_send_blocked', taskId: 'lesson-a', studentName: '학생A', owner: 'teacher-a', updatedAt: 3 }
    ],
    makeupRows: [{ status: 'review_pending', studentName: '학생B', sourceTeacherId: 'teacher-b', updatedAt: 3 }],
    bookAddQueue: [{ status: 'approval_waiting', title: '새 교재', owner: 'teacher-a', updatedAt: 2 }],
    bookEditQueue: [{ status: 'approval_waiting', title: '기존 교재', owner: 'teacher-b', updatedAt: 1 }],
    bookOrderRows: [
      { stage: 'student_handed', academyRegisteredAt: null, title: '배부 교재', quantity: 2, owner: 'teacher-a', studentHandedAt: 7 },
      { stage: 'student_handed', academyRegisteredAt: 8, title: '등록 완료 교재', quantity: 1, owner: 'teacher-b', studentHandedAt: 6 }
    ],
    state: { tasks: [{ id: 'lesson-a', studentName: '학생A', title: '수업A' }] },
    ...overrides
  };
  const argNames = Object.keys(values);
  const factory = new Function(...argNames, source.slice(start, end) + '\nreturn managerRequestInboxRows;');
  return factory(...argNames.map(name => values[name]))();
}

test('관리담당 현황판은 실제 승인 대기만 선생님 이름으로 모은다', () => {
  const rows = inboxRowsFor();
  assert.deepEqual(new Set(rows.map(row => row.kind)), new Set([
    '학생 배정', '수업 변경', '피드백 검토', '교재 추가', '교재 수정', '아카등록'
  ]));
  assert.equal(rows.length, 6);
  assert.ok(rows.every(row => row.kind !== '보강'));
  assert.ok(rows.every(row => row.detail !== '알림톡 발송 상태 확인'));
  assert.ok(rows.every(row => / 선생님$/.test(row.requester)));
  assert.ok(rows.every(row => !/teacher-[ab]/.test(row.requester)));
  assert.deepEqual(new Set(rows.map(row => row.route)), new Set(['lesson', 'feedback', 'books']));
  assert.equal(rows.find(row => row.kind === '수업 변경').route, 'lesson');
  const academy = rows.find(row => row.kind === '아카등록');
  assert.equal(academy.route, 'books');
  assert.equal(academy.title, '배부 교재 · 2권');
  assert.equal(academy.detail, '4단계 학생배부 완료 · 아카등록 필요');
});

test('관리담당이 아니면 통합 요청함 데이터를 만들지 않는다', () => {
  assert.deepEqual(inboxRowsFor({ session: { isAdmin: false } }), []);
});

test('통합 요청함은 선생님별 수업 흐름 아래에 있고 필요한 6개 목록만 새로고침한다', () => {
  const schedule = source.slice(source.indexOf('function viewSchedule()'), source.indexOf('/* ── 기기 대장 ──'));
  assert.match(schedule, /scheduleTimelineHtml\(timeline, cursor, nowKst\);\s*return h \+ managerRequestInboxHtml\(\)/);
  assert.doesNotMatch(schedule, /managerRequestInboxHtml\(\) \+ scheduleToolbarHtml\(\)/);
  const loader = source.slice(source.indexOf('async function loadManagerRequestInbox'), source.indexOf('function managerRequestInboxHtml'));
  for (const name of ['loadLessonAssignmentRequests', 'loadLessonChangeQueue', 'loadFeedbackQueue', 'loadBookAddQueue', 'loadBookEditQueue', 'loadBookIssues']) {
    assert.match(loader, new RegExp(name + '\\(force\\)'));
  }
  assert.match(source, /bookAddQueueLoaded && bookEditQueueLoaded && bookIssueLoaded/);
  assert.match(source, /bookEditQueueError, bookIssueError/);
  assert.match(source, /route === 'books' \|\| route === 'schedule'/);
  assert.doesNotMatch(loader, /loadMakeups\(force\)/);
  assert.match(source, /\['schedule', '현황판', managerRequestInboxCount\(\)\]/);
  assert.match(source, /case 'managerinboxrefresh': loadManagerRequestInbox\(true\)/);
});
