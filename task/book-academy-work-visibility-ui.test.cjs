const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function workScope(tasks) {
  const start = source.indexOf('function isBookOrderWorkTask(');
  const end = source.indexOf('const ckey =', start);
  assert.ok(start >= 0 && end > start, '오늘·주간 교재 업무 범위 함수를 찾을 수 있어야 한다');
  const factory = new Function('state', 'occursOn',
    source.slice(start, end) + '\nreturn { isBookOrderWorkTask, tasksFor };');
  return factory({ tasks }, () => true);
}

test('교재 주문은 주문대기부터 아카등록까지 모든 일반 업무 화면 범위에서 제외한다', () => {
  const stages = ['order_waiting', 'ordered', 'order_failed', 'teacher_received', 'student_handed'];
  stages.forEach((stage, index) => {
    const order = {
      id: 'order-' + index, staffId: 'teacher-a', title: '[주문] 묶음 교재', deleted: false,
      orderItems: [{ bookId: 'book-a' }], stage
    };
    const scoped = workScope([order]);
    assert.equal(scoped.isBookOrderWorkTask(order), true);
    assert.deepEqual(scoped.tasksFor('teacher-a', '2026-08-27'), []);
  });
});

test('구형 제목 전용 주문도 숨기고 일반 업무는 그대로 표시한다', () => {
  const legacyOrder = { id: 'legacy-order', staffId: 'teacher-a', title: '[주문] 구형 교재', deleted: false };
  const regularTask = { id: 'regular', staffId: 'teacher-a', title: '일반 업무', deleted: false };
  const scoped = workScope([legacyOrder, regularTask]);
  assert.equal(scoped.isBookOrderWorkTask(legacyOrder), true);
  assert.equal(scoped.isBookOrderWorkTask(regularTask), false);
  assert.deepEqual(scoped.tasksFor('teacher-a', '2026-08-27').map(row => row.id), ['regular']);
});

test('아카등록 표시와 완료 버튼은 관리자 교재 탭에 그대로 남는다', () => {
  const start = source.indexOf('function bookOrderActionButtons(');
  const end = source.indexOf('function bookOrderStageHtml(', start);
  const books = source.slice(start, end);
  assert.match(books, /row\.stage === 'student_handed' && session\.isAdmin && !row\.academyRegisteredAt/);
  assert.match(books, /data-next="academy_register"[\s\S]*>아카등록완료<\/button>/);
  assert.match(books, /해야 할 업무 · 아카등록/);

  assert.doesNotMatch(source, /ensureBookOrderWorkScopeData\(\)/);
});

test('모든 교재 주문 업무는 현황판과 직원 지시 관리에서도 숨긴다', () => {
  const staffAdded = source.slice(source.indexOf('function staffAdded('), source.indexOf('function alertsToday('));
  const staffAdmin = source.slice(source.indexOf('function viewStaffAdmin('), source.indexOf('function normalizeGuardianAnnouncement('));
  const manage = source.slice(source.indexOf('function manageTasks('), source.indexOf('/* ── 업무 수정'));
  assert.match(staffAdded, /isBookOrderWorkTask\(t\)/);
  assert.match(staffAdmin, /!isBookOrderWorkTask\(t\)/);
  assert.match(manage, /!isBookOrderWorkTask\(t\)/);
  assert.match(manage, /!isScheduledMakeupTask\(t\)/);
});
