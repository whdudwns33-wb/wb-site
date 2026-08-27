const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function block(from, to) {
  const start = html.indexOf(from);
  const end = html.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `${from} 블록을 찾을 수 없습니다`);
  return html.slice(start, end);
}

test('기록 조회는 주문자·교재명 단독 또는 교집합에서 아카완료만 배부 최신순으로 반환한다', () => {
  const source = block('function bookOrderHistorySearchKey(', 'function bookOrderHistoryTeachers(');
  const rowsFor = new Function('bookOrderRows', `${source}\nreturn bookOrderHistoryRows;`)([
    { taskId: 'new-match', owner: 'teacher-a', title: '중학 수학 심화', academyRegisteredAt: 300, studentHandedAt: 500 },
    { taskId: 'old-match', owner: 'teacher-a', title: '수학 기본서', academyRegisteredAt: 500, studentHandedAt: 100 },
    { taskId: 'wrong-title', owner: 'teacher-a', title: '영어 기본서', academyRegisteredAt: 600, studentHandedAt: 600 },
    { taskId: 'wrong-teacher', owner: 'teacher-b', title: '수학 연산', academyRegisteredAt: 700, studentHandedAt: 700 },
    { taskId: 'not-registered', owner: 'teacher-a', title: '수학 미완료', academyRegisteredAt: null, studentHandedAt: 800 }
  ]);

  assert.deepEqual(rowsFor('teacher-a', '수학').map(row => row.taskId), ['new-match', 'old-match']);
  assert.deepEqual(rowsFor('teacher-a', '기본').map(row => row.taskId), ['wrong-title', 'old-match']);
  assert.deepEqual(rowsFor('teacher-a', '').map(row => row.taskId), ['wrong-title', 'new-match', 'old-match']);
  assert.deepEqual(rowsFor('teacher-b', '수학').map(row => row.taskId), ['wrong-teacher']);
  assert.deepEqual(rowsFor('', '수학').map(row => row.taskId), ['wrong-teacher', 'new-match', 'old-match']);
  assert.deepEqual(rowsFor('', '').map(row => row.taskId), ['wrong-teacher', 'wrong-title', 'new-match', 'old-match']);
});

test('교재 주문 기록 조회는 주문자와 교재명을 함께 입력하고 조회 전후 상태를 분리한다', () => {
  const view = block('function viewBookOrderHistory(', 'function viewBookOrderStart(');
  assert.match(view, /교재 주문 기록 조회/);
  assert.match(view, /data-book-order-history-teacher/);
  assert.match(view, /data-book-order-history-title/);
  assert.match(view, /교재명/);
  assert.match(view, /data-act="bookorderhistorysearch"/);
  assert.match(view, /bookOrderHistoryTitleQuery/);
  assert.match(view, /bookOrderHistoryQueriedTitleQuery/);
  assert.match(view, /bookOrderHistoryRows\(bookOrderHistoryQueriedTeacherId, bookOrderHistoryQueriedTitleQuery\)/);
  assert.match(view, /아카등록 완료/);
  assert.match(view, /배부일 최신순/);
  assert.doesNotMatch(view, /bookOrderHistoryTeacherId \? '' : ' disabled'/);

  const click = block("case 'bookorderhistorysearch':", "case 'transportrefresh':");
  assert.match(click, /data-book-order-history-teacher/);
  assert.match(click, /data-book-order-history-title/);
  assert.match(click, /bookOrderHistoryQueriedTeacherId = teacherId/);
  assert.match(click, /bookOrderHistoryQueriedTitleQuery = titleQuery/);
  assert.match(click, /render\(\)/);
});

test('교재명 입력은 조회 초안만 바꾸며 주문자 선택과 완료 행 정렬을 훼손하지 않는다', () => {
  const input = block("document.addEventListener('input', ev => {", "const bookIssueSearch = ev.target.closest('[data-book-issue-search]')");
  assert.match(input, /data-book-order-history-title/);
  assert.match(input, /bookOrderHistoryTitleQuery/);
  assert.doesNotMatch(input, /bookOrderHistoryQueriedTitleQuery\s*=/);

  const change = block("document.addEventListener('change', async ev => {", 'if (syncRenderedLessonScheduleField(ev.target))');
  assert.match(change, /data-book-order-history-teacher/);
  assert.match(change, /bookOrderHistoryTeacherId/);
  assert.doesNotMatch(change, /bookOrderHistoryQueriedTeacherId\s*=/);

  const rows = block('function bookOrderHistoryRows(', 'function bookOrderHistoryTeachers(');
  assert.match(rows, /academyRegisteredAt/);
  assert.match(rows, /row\.owner/);
  assert.match(rows, /row\.title/);
  assert.match(rows, /studentHandedAt/);
  assert.ok(rows.indexOf('studentHandedAt') < rows.lastIndexOf('academyRegisteredAt'),
    '배부날짜가 같을 때만 아카등록 날짜를 보조 정렬로 써야 합니다');
});

test('완료 기록은 서버 검토 후보 교재에만 교재DB 확인 필요 배지를 표시한다', () => {
  const helper = block('function bookOrderCatalogReviewCandidate(', 'function viewBookOrderHistory(');
  const candidateFor = new Function('completedBookCatalogLoaded', 'completedBookCatalogError',
    'completedBookCatalogReviewCandidates', `${helper}\nreturn bookOrderCatalogReviewCandidate;`)(true, '', [
    { bookId: 'pending-book', verificationStatus: 'pending' },
    { bookId: 'verified-book', verificationStatus: 'verified' }
  ]);
  assert.equal(candidateFor({ bookId: 'pending-book', orderDelivery: 'scheduled_batch_v1' }).verificationStatus, 'pending');
  assert.equal(candidateFor({ bookId: 'verified-book', orderDelivery: 'scheduled_batch_v1' }), null);
  assert.equal(candidateFor({ bookId: 'pending-book', orderDelivery: 'bound_print_v1' }), null);

  const view = block('function viewBookOrderHistory(', 'function viewBookOrderStart(');
  assert.match(view, /bookOrderCatalogReviewCandidate\(row, reviewByBookId\)/);
  assert.match(view, /교재DB 확인 필요/);
  assert.match(view, /data-act="bookcatalogrefresh"/);
});
