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

test('제본교재는 서버 가격표와 같은 다섯 항목 중 하나만 고르게 한다', () => {
  const source = block('const BOUND_BOOK_OPTIONS =', 'let boundBookDraft');
  const options = new Function(`${source}\nreturn BOUND_BOOK_OPTIONS;`)();
  assert.deepEqual(options.map(option => [option.label, option.price]), [
    ['1~30 장 - 4,000원', 4000],
    ['31~60 장 - 7,000원', 7000],
    ['61~90 장 - 9,000원', 9000],
    ['시험대비 (30장 이하) - 9,000원', 9000],
    ['시험대비 (31장 이상) - 15,000원', 15000]
  ]);
  assert.deepEqual(options.map(option => option.productCode), [
    'pages_1_30', 'pages_31_60', 'pages_61_90', 'exam_upto_30', 'exam_over_30'
  ]);

  const view = block('function boundBookOrderOptionsHtml(', 'function openBoundBookStudentModal(');
  assert.match(view, /type="radio"/);
  assert.match(view, /name="bound-book-option"/);
  assert.match(view, /data-bound-book-option/);
  assert.match(view, /data-act="boundbookstudentopen"/);
  assert.match(view, />학생 연결하기<\/button>/);
  assert.match(view, /data-act="boundbookordersubmit"/);
  assert.match(view, />주문하기<\/button>/);
  assert.match(view, /disabled/);
  assert.match(view, /selected && !boundBookSubmitting \? '' : ' disabled'/);
  assert.match(view, /ready && !boundBookSubmitting \? '' : ' disabled'/);
  assert.doesNotMatch(view, /type="checkbox"[^>]*data-bound-book-option/);

  const change = block("document.addEventListener('change', async ev => {", 'if (syncRenderedLessonScheduleField(ev.target))');
  assert.match(change, /data-bound-book-option/);
  assert.match(change, /boundBookOptionCode = nextCode/);
  assert.match(change, /boundBookDraft = null/);
  assert.match(change, /render\(\)/);
});

test('옵션을 고른 뒤 여는 학생 연결 팝업은 교재명과 학생을 받아 연결을 확정한다', () => {
  const modal = block('function openBoundBookStudentModal(', 'function saveBoundBookStudentLink(');
  assert.match(modal, /교재 이름/);
  assert.match(modal, /data-bound-book-title/);
  assert.match(modal, /data-bound-book-student/);
  assert.match(modal, /type="checkbox"/);
  assert.match(modal, /data-act="boundbookstudentlinksave"/);
  assert.match(modal, />학생 연결 완료<\/button>/);
  assert.match(modal, /orderStudentCandidates\(\)/);
  assert.match(modal, /선택/);

  const save = block('function saveBoundBookStudentLink(', 'async function submitBoundBookOrder(');
  assert.match(save, /data-bound-book-title/);
  assert.match(save, /data-bound-book-student/);
  assert.match(save, /boundBookDraft/);
  assert.match(save, /if \(!studentIds\.length\)/);
  assert.match(save, /closeModal\(\)/);

  const click = block("case 'boundbookstudentopen':", "case 'bookorderhistorysearch':");
  assert.match(click, /openBoundBookStudentModal/);
  assert.match(click, /boundbookstudentlinksave/);
  assert.match(click, /submitBoundBookOrder\(el\)/);
});

test('제본 주문은 전용 서버 경로가 확정한 뒤에만 닫고 즉시 주문 현황을 다시 읽는다', () => {
  const source = block('async function submitBoundBookOrder(', 'function bookOrderHistoryRows(');
  assert.match(source, /sync\.post\('\/book-order', \{/);
  assert.match(source, /action: 'create_bound'/);
  for (const field of ['taskId', 'title', 'productCode', 'studentIds']) {
    assert.match(source, new RegExp(`${field}:`), field);
  }
  assert.match(source, /result\.task\.orderDelivery !== 'bound_print_v1'/);
  assert.match(source, /Number\(result\.task\.orderIdentityVersion\) !== 1/);
  assert.match(source, /await loadBookIssues\(true\)/);
  assert.doesNotMatch(source, /book-order-send|queueSync\(\)|state\.tasks\.push/);

  const posted = source.indexOf("await sync.post('/book-order'");
  for (const marker of ['boundBookDraft = null', 'closeModal()', 'await loadBookIssues(true)']) {
    assert.ok(source.indexOf(marker) > posted, `${marker}는 서버 성공 뒤에만 실행해야 합니다`);
  }
  const failure = source.slice(source.indexOf('} catch (error) {'));
  assert.doesNotMatch(failure, /boundBookDraft\s*=\s*null|closeModal\(\)/);
});

test('아카등록 완료 기록은 선택 교사의 행만 완료 최신순으로 파생한다', () => {
  const source = block('function bookOrderHistorySearchKey(', 'function viewBookOrderHistory(');
  const rowsFor = new Function('bookOrderRows', `${source}\nreturn bookOrderHistoryRows;`)([
    { taskId: 'old', owner: 'teacher-a', academyRegisteredAt: 500, studentHandedAt: 90 },
    { taskId: 'waiting', owner: 'teacher-a', academyRegisteredAt: null, studentHandedAt: null },
    { taskId: 'other', owner: 'teacher-b', academyRegisteredAt: 400, studentHandedAt: 450 },
    { taskId: 'new', owner: 'teacher-a', academyRegisteredAt: 100, studentHandedAt: 250 }
  ]);
  assert.deepEqual(rowsFor('teacher-a').map(row => row.taskId), ['new', 'old']);
  assert.deepEqual(rowsFor('teacher-b').map(row => row.taskId), ['other']);
  assert.deepEqual(rowsFor('').map(row => row.taskId), ['other', 'new', 'old']);
});

test('교재 주문 기록 조회는 주문하기 아래에서 교사 조회 후 필수 네 정보를 표시한다', () => {
  const view = block('function viewBookOrderHistory(', 'function viewBookOrderStart(');
  assert.match(view, /<details[^>]*book-order-history/);
  assert.match(view, /교재 주문 기록 조회/);
  assert.match(view, /data-book-order-history-teacher/);
  assert.match(view, /data-act="bookorderhistorysearch"/);
  assert.match(view, />조회<\/button>/);
  for (const label of ['배부날짜', '주문자(선생님)', '학생', '금액']) assert.ok(view.includes(label), label);
  assert.match(view, /studentHandedAt/);
  assert.match(view, /teacherName/);
  assert.match(view, /row\.students/);
  assert.match(view, /unitPrice/);
  assert.match(view, /quantity/);

  const books = block('function viewBooks()', '/* ── 차량 운행');
  assert.match(books, /viewBookIssues\(\) \+ viewBookOrderStart\(\) \+ viewBookOrderHistory\(\)/);
});
