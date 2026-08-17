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

test('새 주문은 학생 정체성을 검증하는 서버 전용 경로로만 등록한다', () => {
  const source = block('async function submitBookOrder(', 'async function cancelSealedBookOrder(');
  assert.match(source, /await sync\.post\('\/book-order', \{/);
  assert.match(source, /action: 'create', taskId: taskId/);
  assert.match(source, /items: items\.map\(item => \(\{[\s\S]*bookId: item\.bookId, title: item\.title, studentIds: item\.studentIds/);
  assert.match(source, /result\.task\.id !== taskId \|\| result\.task\.orderDelivery !== 'scheduled_batch_v1'/);
  assert.match(source, /Number\(result\.task\.orderIdentityVersion\) !== 1/);
  assert.match(source, /applyCreatedLesson\(result\.task\)/);
  assert.doesNotMatch(source, /state\.tasks\.push|queueSync\(\)/);
});

test('한 권 주문과 묶음 주문은 학생 선택을 전용 서버 경로에만 넘긴다', () => {
  const single = block("case 'bkordersubmit':", "case 'bkselect':");
  const batch = block("case 'bkbatchsubmit':", "case 'bkcancelopen':");
  for (const source of [single, batch]) {
    assert.match(source, /submitBookOrder/);
    assert.doesNotMatch(source, /save\(\)|queueSync\(\)|state\.tasks\.push/);
    assert.doesNotMatch(source, /book-order-send|sendBookOrder/);
  }
  assert.match(single, /studentIds: studentIds/);
  assert.match(batch, /studentIds: selectedOrderStudentIds/);
  assert.doesNotMatch(batch, /item\.qty/);
  assert.doesNotMatch(html, /id="bq-|placeholder="예: 3권"/);
});

test('서버 확인 전에는 성공 처리하지 않고 실패 시 같은 주문 ID와 입력을 보존한다', () => {
  const source = block('async function submitBookOrder(', 'async function cancelSealedBookOrder(');
  const awaited = source.indexOf("await sync.post('/book-order'");
  assert.ok(awaited >= 0);
  for (const marker of ['applyCreatedLesson(result.task)', 'batchDraft = null', 'closeModal()', 'toast(totalQty']) {
    assert.ok(source.indexOf(marker) > awaited, marker + '는 서버 응답 뒤에만 실행되어야 합니다');
  }
  const failure = source.slice(source.indexOf('} catch (error) {'));
  assert.match(failure, /button\.isConnected\) button\.disabled = false/);
  assert.doesNotMatch(failure, /batchDraft\s*=\s*null|batchVendorName\s*=\s*''|batchOrderTaskId\s*=\s*''|closeModal\(\)/);
  assert.match(html, /batchOrderTaskId = ''[\s\S]*async function submitBookOrder/);
  assert.match(source, /batchOrderTaskId = 'ord_' \+ uid\(\)/);
});

test('주문처가 없는 단일·묶음 주문은 서버에 보내지 않고 입력을 유지한다', () => {
  const source = block('async function submitBookOrder(', 'async function cancelSealedBookOrder(');
  const guard = source.indexOf("if (!batchVendorName) return toast('교재 정보에서 주문처를 먼저 등록해 주세요')");
  assert.ok(guard >= 0 && guard < source.indexOf("sync.post('/book-order'"));
  const beforeRequest = source.slice(0, source.indexOf("sync.post('/book-order'"));
  assert.doesNotMatch(beforeRequest, /batchDraft\s*=\s*null|batchOrderTaskId\s*=\s*''|closeModal\(\)/);

  const singleModal = block('function singleOrderModal(', 'function batchOrderModal(');
  const batchModal = block('function batchOrderModal(', '/** 새 주문은');
  const singleSubmit = block("case 'bkordersubmit':", "case 'bkselect':");
  const batchSubmit = block("case 'bkbatchsubmit':", "case 'bkcancelopen':");
  assert.match(singleModal, /batchVendorName = book\.vendor \|\| ''/);
  assert.match(batchModal, /batchVendorName = isUnassigned \? '' : vendorKey/);
  assert.match(singleSubmit, /submitBookOrder/);
  assert.match(batchSubmit, /submitBookOrder/);
});

test('온라인 직접 주문은 sealed create와 20시 문자 대상에 절대 넣지 않는다', () => {
  const manual = block('function saveManualOnlineBookOrder(', '/** 새 주문은');
  const submit = block('async function submitBookOrder(', 'async function cancelSealedBookOrder(');
  assert.match(manual, /orderDelivery: 'manual_online_v1'/);
  assert.match(manual, /온라인 직접 주문/);
  assert.match(manual, /문자 자동 발송·보호자 자동 상태 공개 대상이 아닙니다/);
  assert.match(manual, /save\(\); queueSync\(\); closeModal\(\); render\(\)/);
  assert.doesNotMatch(manual, /scheduled_batch_v1|sync\.post\('\/book-order'/);

  const guard = submit.indexOf("if (vendor && vendor.type === 'online') return saveManualOnlineBookOrder(items)");
  const post = submit.indexOf("sync.post('/book-order'");
  assert.ok(guard >= 0 && post > guard, '온라인 분기가 sealed create POST보다 먼저 return해야 합니다');
});

test('봉인된 주문 취소는 서버 확인 후에만 반영하고 과거 주문은 기존 경로를 유지한다', () => {
  const sealed = block('async function cancelSealedBookOrder(', 'function cancelOrderModal(');
  const click = block("case 'bkcancel':", "case 'ordermsg':");
  assert.match(sealed, /action: 'cancel', taskId: task\.id/);
  assert.match(sealed, /expectedUpdatedAt: Number\(task\.updatedAt\) \|\| 0/);
  assert.match(sealed, /!result\.task\.deleted/);
  assert.match(sealed, /Number\.isInteger\(Number\(result\.task\.orderCancelledAt\)\)/);
  assert.match(sealed, /applyCreatedLesson\(result\.task\)/);
  assert.match(sealed, /ORDER_CANCEL_SEND_ACTIVE/);
  assert.doesNotMatch(sealed, /queueSync\(\)|task\.deleted\s*=\s*true/);
  assert.match(click, /Number\(t\.orderIdentityVersion\) === 1[\s\S]*cancelSealedBookOrder\(t, el\)/);
  assert.match(click, /t\.deleted = true; t\.updatedAt = now\(\);[\s\S]*save\(\); queueSync\(\)/);
  assert.ok(click.indexOf('cancelSealedBookOrder(t, el)') < click.indexOf('t.deleted = true'));
});

test('봉인 주문은 해당 교재가 배부되기 전까지 진행 배지와 취소 대상에 남는다', () => {
  const source = block('function bookPendingOrderCount(', '/** 이 주문을 취소할 수 있는가');
  const makePending = (tasks, rows, loaded = true, checks = {}) => new Function(
    'state', 'bookOrderRows', 'bookIssueLoaded', `${source}\nreturn bookPendingOrders;`
  )({ tasks, checks }, rows, loaded);
  const book = { id: 'book-a', title: '교재 A' };
  const order = {
    id: 'ord-a', title: '[주문] 묶음', deleted: false, orderIdentityVersion: 1,
    orderItems: [{ bookId: 'book-a', title: '교재 A' }, { bookId: 'book-b', title: '교재 B' }]
  };

  assert.equal(makePending([order], [{ taskId: 'ord-a', itemIndex: 0, stage: 'order_waiting' }])(book).length, 1);
  assert.equal(makePending([order], [{ taskId: 'ord-a', itemIndex: 0, stage: 'student_handed' }])(book).length, 0);
  assert.equal(makePending([order], [{ taskId: 'ord-a', itemIndex: 0, stage: 'student_handed' }], false)(book).length, 1);
  assert.equal(makePending([{ ...order, deleted: true }], [])(book).length, 0);

  const legacy = { id: 'legacy', title: '[주문] 교재 A', deleted: false };
  assert.equal(makePending([legacy], [], true, { done: { taskId: 'legacy', done: true } })(book).length, 0);
});

test('중복 차단은 교재 전체가 아니라 아직 배부되지 않은 선택 학생만 대상으로 한다', () => {
  const source = block('function bookPendingOrderCount(', '/** 이 주문을 취소할 수 있는가');
  const activeIds = (tasks, rows, loaded = true) => new Function(
    'state', 'bookOrderRows', 'bookIssueLoaded', `${source}\nreturn activeBookOrderStudentIds;`
  )({ tasks, checks: {} }, rows, loaded);
  const order = {
    id: 'ord-a', title: '[주문] 교재 A', deleted: false, orderIdentityVersion: 1,
    orderItems: [{ bookId: 'book-a', title: '교재 A', studentIds: ['student-a'] }]
  };

  assert.deepEqual([...activeIds([order], [{ taskId: 'ord-a', itemIndex: 0, stage: 'ordered' }])('book-a')], ['student-a']);
  assert.equal(activeIds([order], [{ taskId: 'ord-a', itemIndex: 0, stage: 'student_handed' }])('book-a').size, 0);
  assert.deepEqual([...activeIds([order], [{ taskId: 'ord-a', itemIndex: 0, stage: 'student_handed' }], false)('book-a')], ['student-a']);
  assert.equal(activeIds([{ ...order, deleted: true }], [])('book-a').size, 0);
  assert.equal(activeIds([{ ...order, orderIdentityVersion: 0 }], [])('book-a').size, 0);

  const card = block('function bookCard(', '/* ── 새 교재 추가 신청');
  const single = block('function singleOrderModal(', 'function batchOrderModal(');
  const batch = block('function batchOrderModal(', '/** 온라인 직접 주문은');
  const submit = block('async function submitBookOrder(', 'async function cancelSealedBookOrder(');
  const click = block("case 'bkorder':", "case 'bkbatch':");

  assert.doesNotMatch(card, /disabled title="진행 중인 주문/);
  assert.match(card, /data-act="bkorder"[\s\S]*>🛒 주문<\/button>/);
  assert.doesNotMatch(single, /bookPendingOrderCount/);
  assert.doesNotMatch(batch, /!bookPendingOrderCount/);
  const guard = submit.indexOf('const duplicateStudent =');
  assert.ok(guard >= 0 && guard < submit.indexOf("sync.post('/book-order'"));
  assert.match(submit.slice(guard, submit.indexOf("if (!batchVendorName)")), /activeBookOrderStudentIds\(item\.bookId\)[\s\S]*activeIds\.has\(String\(id\)\)/);
  assert.match(submit.slice(guard, submit.indexOf("if (!batchVendorName)")), /return toast\('선택한 학생 중 같은 교재 주문이 이미 진행 중인 학생이 있습니다/);
  assert.doesNotMatch(submit.slice(0, submit.indexOf("if (!batchVendorName)")),
    /batchDraft\s*=\s*null|batchSelection\.delete|closeModal\(\)/);
  assert.doesNotMatch(click, /bookPendingOrderCount/);
  assert.match(click, /batchSelection\.has\(id\) \? batchSelection\.delete\(id\) : batchSelection\.add\(id\)/);
});

test('화면에서 즉시 문자 발송 경로를 노출하지 않는다', () => {
  assert.doesNotMatch(html, /data-act="bossend"|data-act="smsmanual"|function sendBookOrder/);
  assert.match(html, /개별 주문도 매일 저녁 8시에 출판사별 문자 한 통으로 자동 묶입니다/);
});
