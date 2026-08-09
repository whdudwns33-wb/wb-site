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

test('새 주문만 저녁 일괄 발송 대상으로 표시한다', () => {
  const source = block('function createOrderTask(', '/** 일괄 주문용 선택 상태');
  assert.match(source, /orderDelivery: 'scheduled_batch_v1'/);
  assert.match(source, /매일 저녁 8시 출판사별 문자 한 통으로 자동 발송/);
  assert.match(source, /label: '입고 확인'/);
});

test('한 권 주문과 묶음 주문은 즉시 발송하지 않고 동기화 대기한다', () => {
  const single = block("case 'bkorder':", "case 'bkselect':");
  const batch = block("case 'bkbatchsubmit':", "case 'bkcancelopen':");
  for (const source of [single, batch]) {
    assert.match(source, /createOrderTask/);
    assert.match(source, /save\(\); queueSync\(\)/);
    assert.doesNotMatch(source, /book-order-send|sendBookOrder/);
  }
  assert.match(single, /저녁 8시 일괄 발송 대기/);
  assert.match(batch, /저녁 8시 일괄 발송 대기/);
});

test('화면에서 즉시 문자 발송 경로를 노출하지 않는다', () => {
  assert.doesNotMatch(html, /data-act="bossend"|data-act="smsmanual"|function sendBookOrder/);
  assert.match(html, /개별 주문도 매일 저녁 8시에 출판사별 문자 한 통으로 자동 묶입니다/);
});
