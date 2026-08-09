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

test('원장 주문은 특정 직원 업무로 배정하지 않는다', () => {
  const source = block('function orderAssignee()', '/** 주문 지시서 하나를 만든다');
  assert.match(source, /session\.isStaffLink \? session\.staffId : null/);
  assert.doesNotMatch(source, /manager|teamStaff/);
});

test('한 권 주문과 묶음 주문 모두 저장 후 출판사 문자 발송을 시작한다', () => {
  const single = block("case 'bkorder':", "case 'bkselect':");
  assert.match(single, /const order = createOrderTask/);
  assert.match(single, /save\(\); queueSync\(\); render\(\);/);
  assert.match(single, /sendBookOrder\(order\)/);

  const batch = block("case 'bkbatchsubmit':", "case 'bkcancelopen':");
  assert.match(batch, /const order = createOrderTask\(batchVendorName, items, sid\)/);
  assert.match(batch, /sendBookOrder\(order\)/);
  assert.match(html, /같은 출판사의 여러 권을 한 주문으로 묶어 문자 한 통으로 보냅니다/);
});

test('자동 발송은 주문 지시서 동기화가 끝난 뒤 기존 보안 발송 API를 재사용한다', () => {
  const source = block('async function sendBookOrder(order, button)', '/** 일괄 주문용 선택 상태');
  assert.match(source, /await settleSync\(\)/);
  assert.match(source, /sync\.post\('\/book-order-send', \{ app: SYNC_APP, auth: auth, taskId: order\.id \}\)/);
  assert.match(source, /res\.send\.status !== 'accepted'/);
});
