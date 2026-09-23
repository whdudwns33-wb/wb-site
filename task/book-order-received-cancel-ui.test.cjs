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

test('내부·제본교재 3단계 취소는 학생별 선택과 필수 사유를 서버 전용 경로로 보낸다', () => {
  const open = block('function openReceivedBookOrderCancellation(', 'async function saveReceivedBookOrderCancellation(');
  const save = block('async function saveReceivedBookOrderCancellation(', 'function cancelOrderModal(');
  assert.match(open, /row\.stage !== 'teacher_received'/);
  assert.match(open, /bound_print_v1/);
  assert.match(open, /internal_book_v1/);
  assert.match(open, /data-received-order-cancel-student/);
  assert.match(open, /취소 사유 \(필수\)/);
  assert.match(save, /action: 'order_cancel_received_students'/);
  assert.match(save, /studentIds, reason/);
  assert.match(save, /pendingReceivedBookOrderCancellations/);
  assert.doesNotMatch(save, /state\.tasks|queueSync\(\)|save\(\)/);
});

test('3단계에만 주문취소 버튼을 보이고 4단계에는 기존 아카등록 흐름만 유지한다', () => {
  const actions = block('function bookOrderActionButtons(', 'function bookOrderDateText(');
  assert.match(actions, /row\.stage === 'teacher_received'[\s\S]*bookorderreceivedcancelopen/);
  assert.match(actions, /row\.stage === 'student_handed'[\s\S]*bookordertransition/);
  const handed = actions.slice(actions.indexOf("row.stage === 'student_handed'"));
  assert.doesNotMatch(handed, /bookorderreceivedcancelopen/);
});

test('취소된 학생은 진행단계와 분리된 접기식 취소 기록에서 날짜와 사유를 확인한다', () => {
  const history = block('function bookOrderCancellationHistoryHtml(', 'function viewBookIssues(');
  const view = block('function viewBookIssues(', 'function bookOrderLinkBook(');
  assert.match(history, /취소 기록/);
  assert.match(history, /cancelledStudents/);
  assert.match(history, /student\.cancelledAt/);
  assert.match(history, /student\.reason/);
  assert.match(view, /bookOrderCancellationHistoryHtml\(\)/);
});

test('취소 열기와 저장 이벤트를 각각 연결한다', () => {
  const click = block("case 'bookorderlinkopen':", "case 'externalbookorder':");
  assert.match(click, /case 'bookorderreceivedcancelopen': openReceivedBookOrderCancellation\(el\)/);
  assert.match(click, /case 'bookorderreceivedcancelsave': saveReceivedBookOrderCancellation\(el\)/);
});
