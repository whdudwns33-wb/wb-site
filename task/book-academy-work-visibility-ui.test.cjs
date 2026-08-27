const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function workScope(tasks, orderRows, loaded = true) {
  const start = source.indexOf('function isAcademyOnlyBookOrderTask(');
  const end = source.indexOf('const ckey =', start);
  assert.ok(start >= 0 && end > start, '오늘·주간 교재 업무 범위 함수를 찾을 수 있어야 한다');
  const factory = new Function('state', 'bookOrderRows', 'bookIssueLoaded', 'bookIssueLoading', 'occursOn',
    source.slice(start, end) + '\nreturn { isAcademyOnlyBookOrderTask, tasksFor };');
  return factory({ tasks }, orderRows, loaded, false, () => true);
}

test('모든 주문 항목이 학생배부 완료되면 아카등록 대기는 오늘·주간 업무에서 제외한다', () => {
  const order = {
    id: 'order-a', staffId: 'teacher-a', title: '[주문] 묶음 교재', deleted: false,
    orderItems: [{ bookId: 'book-a' }, { bookId: 'book-b' }]
  };
  const rows = [
    { taskId: 'order-a', itemIndex: 0, stage: 'student_handed', academyRegisteredAt: null },
    { taskId: 'order-a', itemIndex: 1, stage: 'student_handed', academyRegisteredAt: 123 }
  ];
  const scoped = workScope([order], rows);
  assert.equal(scoped.isAcademyOnlyBookOrderTask(order), true);
  assert.deepEqual(scoped.tasksFor('teacher-a', '2026-08-27'), []);
});

test('교사 단계가 하나라도 남았거나 정본을 못 읽었으면 주문 업무를 숨기지 않는다', () => {
  const order = {
    id: 'order-a', staffId: 'teacher-a', title: '[주문] 묶음 교재', deleted: false,
    orderItems: [{ bookId: 'book-a' }, { bookId: 'book-b' }]
  };
  const partial = [
    { taskId: 'order-a', itemIndex: 0, stage: 'student_handed' },
    { taskId: 'order-a', itemIndex: 1, stage: 'teacher_received' }
  ];
  assert.deepEqual(workScope([order], partial).tasksFor('teacher-a', '2026-08-27').map(row => row.id), ['order-a']);
  assert.deepEqual(workScope([order], partial.map(row => ({ ...row, stage: 'student_handed' })), false)
    .tasksFor('teacher-a', '2026-08-27').map(row => row.id), ['order-a']);
});

test('아카등록 표시와 완료 버튼은 관리자 교재 탭에 그대로 남는다', () => {
  const start = source.indexOf('function bookOrderActionButtons(');
  const end = source.indexOf('function bookOrderStageHtml(', start);
  const books = source.slice(start, end);
  assert.match(books, /row\.stage === 'student_handed' && session\.isAdmin && !row\.academyRegisteredAt/);
  assert.match(books, /data-next="academy_register"[\s\S]*>아카등록완료<\/button>/);
  assert.match(books, /해야 할 업무 · 아카등록/);

  const workViews = source.slice(source.indexOf('function viewToday()'), source.indexOf('/* ── 지시서 작성 ──'));
  assert.match(workViews, /ensureBookOrderWorkScopeData\(\)/);
  assert.match(source, /\['books', 'schedule', 'today', 'week', 'board', 'staff'\]\.includes\(route\)/);
});

test('아카등록 전용 업무는 현황판과 직원 지시 관리에서도 숨긴다', () => {
  const staffAdded = source.slice(source.indexOf('function staffAdded('), source.indexOf('function alertsToday('));
  const board = source.slice(source.indexOf('function viewBoard('), source.indexOf('function staffCard('));
  const staffAdmin = source.slice(source.indexOf('function viewStaffAdmin('), source.indexOf('function normalizeGuardianAnnouncement('));
  const manage = source.slice(source.indexOf('function manageTasks('), source.indexOf('/* ── 업무 수정'));
  assert.match(staffAdded, /isAcademyOnlyBookOrderTask\(t\)/);
  assert.match(board, /ensureBookOrderWorkScopeData\(\)/);
  assert.match(staffAdmin, /ensureBookOrderWorkScopeData\(\)/);
  assert.match(staffAdmin, /!isAcademyOnlyBookOrderTask\(t\)/);
  assert.match(manage, /!isAcademyOnlyBookOrderTask\(t\)/);
});
