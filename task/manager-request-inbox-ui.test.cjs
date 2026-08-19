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
    guardianRequestRows: [],
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

test('퇴원·휴원·수업삭제·담당자 변경 요청은 현황판에서 종류와 적용일이 구분된다', () => {
  const operations = [
    ['withdrawal', '퇴원 요청', '퇴원 승인'],
    ['leave', '휴원 요청', '휴원 승인'],
    ['lesson_delete', '수업삭제 요청', '수업 삭제 승인'],
    ['teacher_assignment', '담당자 변경', '새 담당 선생님 선택']
  ];
  for (const [operation, kind, detail] of operations) {
    const rows = inboxRowsFor({
      lessonAssignmentRequests: [], feedbackQueue: [], bookAddQueue: [], bookEditQueue: [], bookOrderRows: [],
      lessonChangeQueue: [{ status: 'approval_waiting', taskId: 'lesson-a', owner: 'teacher-b', updatedAt: 5,
        changes: { operation, effectiveDate: '2026-08-25' } }]
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, kind);
    assert.match(rows[0].detail, new RegExp(detail));
    assert.match(rows[0].detail, /2026-08-25/);
    assert.equal(rows[0].route, 'lesson');
  }
});

test('통합 요청함은 선생님별 수업 흐름 아래에 있고 필요한 7개 목록만 새로고침한다', () => {
  const schedule = source.slice(source.indexOf('function viewSchedule()'), source.indexOf('/* ── 기기 대장 ──'));
  assert.match(schedule, /scheduleTimelineHtml\(timeline, cursor, nowKst\);\s*return h \+ managerRequestInboxHtml\(\)/);
  assert.doesNotMatch(schedule, /managerRequestInboxHtml\(\) \+ scheduleToolbarHtml\(\)/);
  const loader = source.slice(source.indexOf('async function loadManagerRequestInbox'), source.indexOf('function managerRequestInboxHtml'));
  for (const name of ['loadLessonAssignmentRequests', 'loadLessonChangeQueue', 'loadFeedbackQueue', 'loadBookAddQueue', 'loadBookEditQueue', 'loadBookIssues', 'loadGuardianRequests']) {
    assert.match(loader, new RegExp(name + '\\(force\\)'));
  }
  assert.match(source, /bookAddQueueLoaded && bookEditQueueLoaded && bookIssueLoaded && guardianRequestsLoaded/);
  assert.match(source, /bookIssueError, guardianRequestsError/);
  assert.match(source, /route === 'books' \|\| route === 'schedule'/);
  assert.doesNotMatch(loader, /loadMakeups\(force\)/);
  assert.match(source, /\['schedule', '현황판', managerRequestInboxCount\(\)\]/);
  assert.match(source, /case 'managerinboxrefresh': loadManagerRequestInbox\(true\)/);
  assert.match(source, /기존 검토 화면으로 이동하거나 보호자 요청은 여기서 안전하게 처리합니다\./);
  assert.doesNotMatch(source, /처리는 기존 검토 화면에서 안전하게 진행됩니다\./);
});

test('보호자 요청은 서버 문구 대신 안전한 enum 라벨과 CAS 식별자로 통합 요청함에 들어간다', () => {
  const rows = inboxRowsFor({
    guardianRequestRows: [
      { requestId: 'req-1', studentName: '학생C', grade: '중2', requestType: 'consultation', status: 'open', revision: 3, updatedAt: 9 },
      { requestId: 'req-2', studentName: '학생D', grade: '초5', requestType: 'server_html', requestTypeLabel: '<img src=x>', status: 'open', revision: 1, updatedAt: 8 }
    ]
  });
  const guardian = rows.filter(row => row.kind === '보호자 요청');
  assert.equal(guardian.length, 2);
  assert.equal(guardian[0].title, '학생C · 상담 요청');
  assert.equal(guardian[0].requester, '보호자 앱');
  assert.equal(guardian[0].guardianRequestRevision, 3);
  assert.equal(guardian[1].title, '학생D · 요청 유형 확인 필요');
  assert.doesNotMatch(guardian.map(row => row.title).join(' '), /<img|server_html/);
});
