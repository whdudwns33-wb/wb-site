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
  assert.match(source, /items: items\.map\(item => \(\{/);
  for (const field of ['bookId: item.bookId', 'title: item.title', 'studentIds: item.studentIds',
    'unitPrice: item.unitPrice']) assert.ok(source.includes(field), field);
  assert.match(source, /Object\.prototype\.hasOwnProperty\.call\(item, 'publisherName'\)/);
  assert.match(source, /publisherName: (?:String\(item\.publisherName \|\| ''\)|item\.publisherName)/);
  assert.match(source, /result\.task\.id !== taskId \|\| result\.task\.orderDelivery !== expectedDelivery/);
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
  assert.match(single, /unitPrice: unitPrice/);
  assert.match(batch, /studentIds: selectedOrderStudentIds/);
  assert.match(batch, /unitPrice: selectedOrderUnitPrice/);
  assert.doesNotMatch(batch, /item\.qty/);
  assert.doesNotMatch(html, /id="bq-|placeholder="예: 3권"/);
});

test('학생 선택창 위에서 교재 단가를 받고 주문부터 아카등록까지 금액과 네 단계 날짜를 표시한다', () => {
  const priceInput = block('function orderPriceInput(', 'function selectedOrderStudentIds(');
  const singleModal = block('function singleOrderModal(', 'function batchOrderModal(');
  const batchModal = block('function batchOrderModal(', 'async function submitBookOrder(');
  const dates = block('function bookOrderDateText(', 'function bookOrderRowHtml(');
  const row = block('function bookOrderRowHtml(', 'function bookOrderStageHtml(');

  assert.match(priceInput, /교재 금액 \(1권 기준\)/);
  assert.match(priceInput, /type="number"[\s\S]*data-order-unit-price/);
  assert.ok(singleModal.indexOf('orderPriceInput(batchDraft[0])') < singleModal.indexOf('orderStudentPicker(batchDraft[0])'));
  assert.match(batchModal, /orderPriceInput\(row\) \+ orderStudentPicker\(row\)/);
  assert.match(dates, /권당[\s\S]*합계/);
  for (const field of ['orderRequestedAt', 'orderCompletedAt', 'teacherReceivedAt', 'studentHandedAt']) {
    assert.match(dates, new RegExp('row\\.' + field));
  }
  for (const label of ['주문요청', '주문완료', '수령완료', '배부완료']) assert.match(dates, new RegExp(label));
  assert.match(row, /bookOrderMoneyHtml\(row\) \+ bookOrderPriceEntryHtml\(row\) \+ bookOrderDatesHtml\(row\)/);
  assert.match(row, /row\.stage === 'student_handed'[\s\S]*해야 할 업무 · 아카등록/);
});

test('교재 주문 문자 상태는 숫자 코드 대신 한국어 진행 상태로 표시한다', () => {
  const status = block('function bookOrderMessageStatusLabel(', 'function bookOrderActionButtons(');
  const stageStatus = block('function bookOrderStatusLabel(', 'function bookOrderSecondaryMessageStatusHtml(');
  for (const state of ['phone_ordered', 'provider_queued', 'carrier_processing', 'delivered', 'failed', 'unknown']) {
    assert.match(status, new RegExp("messageDeliveryState === '" + state + "'"), state);
  }
  for (const label of ['전화 주문 완료', '문자 접수 · 발송 대기', '통신사 전달 중', '문자 수신 완료', '문자 발송 실패']) {
    assert.match(status, new RegExp(label));
  }
  assert.doesNotMatch(status, /2000|3000|4000/);
  assert.match(status, /bookOrderSecondaryMessageStatusHtml/);
  assert.match(status, /문자 상태 ·/);
  assert.doesNotMatch(stageStatus, /messageDeliveryState/);
  for (const label of ['선생님 수령', '학생배부 완료', '아카등록 완료']) assert.match(stageStatus, new RegExp(label));
});

test('대상 과거 주문은 1회성 권당 금액 입력칸을 보이고 저장 뒤 서버 목록으로 갱신한다', () => {
  const input = block('function bookOrderPriceEntryHtml(', 'function bookOrderDatesHtml(');
  const save = block('async function saveLegacyBookOrderPrice(', 'async function transitionBookIssue(');
  const click = block("case 'bookorderlinkopen':", "case 'transportrefresh':");

  assert.match(input, /if \(!row\.canSetUnitPrice\) return ''/);
  assert.match(input, /type="number"[\s\S]*data-book-order-price-input/);
  assert.match(input, /1회성 교재 금액 \(1권 기준\)/);
  assert.match(input, /data-act="bookorderpricesave"/);
  assert.match(input, /한 번 저장하면 변경할 수 없습니다/);
  assert.match(save, /action: 'order_price_set'/);
  assert.match(save, /unitPrice: unitPrice/);
  assert.match(save, /저장 후에는 변경할 수 없습니다/);
  assert.match(save, /await loadBookIssues\(true\)/);
  assert.match(click, /case 'bookorderpricesave': saveLegacyBookOrderPrice\(el\)/);
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
  const guard = source.indexOf('if (!batchVendorName)');
  assert.ok(guard >= 0 && guard < source.indexOf("sync.post('/book-order'"));
  const beforeRequest = source.slice(0, source.indexOf("sync.post('/book-order'"));
  assert.doesNotMatch(beforeRequest, /batchDraft\s*=\s*null|batchOrderTaskId\s*=\s*''|closeModal\(\)/);

  const singleModal = block('function singleOrderModal(', 'function batchOrderModal(');
  const batchModal = block('function batchOrderModal(', 'async function submitBookOrder(');
  const singleSubmit = block("case 'bkordersubmit':", "case 'bkselect':");
  const batchSubmit = block("case 'bkbatchsubmit':", "case 'bkcancelopen':");
  assert.match(singleModal, /batchVendorName = book\.vendor \|\| ''/);
  assert.match(batchModal, /batchVendorName = isUnassigned \? '' : vendorKey/);
  assert.match(singleSubmit, /submitBookOrder/);
  assert.match(batchSubmit, /submitBookOrder/);
});

test('온라인 직접 주문도 서버 주문으로 등록하고 manual_online_v1 응답을 1단계에 유지한다', () => {
  const submit = block('async function submitBookOrder(', 'async function cancelSealedBookOrder(');
  assert.match(submit, /await sync\.post\('\/book-order', \{/);
  assert.match(submit, /action: 'create'/);
  assert.match(submit, /publisherName: (?:String\(item\.publisherName \|\| ''\)|item\.publisherName)/);
  assert.match(submit, /scheduled_batch_v1/);
  assert.match(submit, /manual_online_v1/);
  assert.match(submit, /await loadBookIssues\(true\)/);
  assert.doesNotMatch(submit, /saveManualOnlineBookOrder|vendor\.type === 'online'[\s\S]{0,100}return/);
  assert.doesNotMatch(submit, /state\.tasks\.push|queueSync\(\)/);

  const status = block('function viewBookIssues(', 'function bookOrderLinkBook(');
  assert.match(status, /bookOrderStageHtml\('order_waiting', '1단계 · 주문대기'/);
});

test('기존 총판 교재는 publisherName을 생략하고 외부교재만 빈 선택값까지 명시해 전송한다', () => {
  const submit = block('async function submitBookOrder(', 'async function cancelSealedBookOrder(');
  const single = block("case 'bkordersubmit':", "case 'bkselect':");
  const batch = block("case 'bkbatchsubmit':", "case 'bkcancelopen':");
  const external = block('async function submitExternalBookOrder(', 'function bookOrderHistoryRows(');

  assert.match(submit, /Object\.prototype\.hasOwnProperty\.call\(item, 'publisherName'\)/);
  assert.match(submit, /publisherName: (?:String\(item\.publisherName \|\| ''\)|item\.publisherName)/);
  assert.doesNotMatch(single, /publisherName/);
  assert.doesNotMatch(batch, /publisherName/);
  assert.match(external, /publisherName: publisher\.publisherName/);
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

test('1단계 각 교재는 권한 보유자에게만 품목별 주문취소를 제공하고 서버 확인 뒤 갱신한다', () => {
  const actions = block('function bookOrderActionButtons(', 'function bookOrderMoneyHtml(');
  assert.match(actions, /row\.stage === 'order_waiting' && canTeacherAct/);
  assert.match(actions, /data-act="bookordercancel"/);
  assert.match(actions, />주문취소<\/button>/);
  assert.match(actions, />쿠팡 주문완료<\/button>/);
  assert.match(actions, />쿠팡 주문실패<\/button>/);
  assert.ok(actions.indexOf("row.integrity || row.needsStudentLink") < actions.indexOf('const cancelButton'));

  const cancel = block('const pendingBookOrderItemCancellations', 'function cancelOrderModal(');
  assert.match(cancel, /row\.stage !== 'order_waiting'/);
  assert.match(cancel, /action: 'cancel_item'/);
  assert.match(cancel, /taskId,/);
  assert.match(cancel, /itemIndex,/);
  assert.match(cancel, /expectedUpdatedAt: Number\(row\.taskUpdatedAt\) \|\| 0/);
  assert.match(cancel, /Number\(cancellation\.itemIndex\) !== itemIndex/);
  assert.match(cancel, /await loadBookIssues\(true\)/);
  assert.doesNotMatch(cancel, /applyCreatedLesson|queueSync\(\)|\.deleted\s*=\s*true/);
  assert.match(html, /case 'bookordercancel': cancelWaitingBookOrderItem\(el\); break;/);
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
  assert.equal(makePending([order], [{ taskId: 'ord-a', itemIndex: 0, stage: 'cancelled' }])(book).length, 0);
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
  assert.equal(activeIds([order], [{ taskId: 'ord-a', itemIndex: 0, stage: 'cancelled' }])('book-a').size, 0);
  assert.deepEqual([...activeIds([order], [{ taskId: 'ord-a', itemIndex: 0, stage: 'student_handed' }], false)('book-a')], ['student-a']);
  assert.equal(activeIds([{ ...order, deleted: true }], [])('book-a').size, 0);
  assert.equal(activeIds([{ ...order, orderIdentityVersion: 0 }], [])('book-a').size, 0);

  const card = block('function bookCard(', '/* ── 새 교재 추가 신청');
  const single = block('function singleOrderModal(', 'function batchOrderModal(');
  const batch = block('function batchOrderModal(', 'async function submitBookOrder(');
  const submit = block('async function submitBookOrder(', 'async function cancelSealedBookOrder(');
  const click = block("case 'bkorder':", "case 'bkbatch':");

  assert.doesNotMatch(card, /disabled title="진행 중인 주문/);
  assert.match(card, /data-act="bkorder"[\s\S]*>🛒 주문<\/button>/);
  assert.doesNotMatch(single, /bookPendingOrderCount/);
  assert.doesNotMatch(batch, /!bookPendingOrderCount/);
  const guard = submit.indexOf('const duplicateStudent =');
  assert.ok(guard >= 0 && guard < submit.indexOf("sync.post('/book-order'"));
  assert.match(submit.slice(guard, submit.indexOf("if (!batchVendorName)")), /activeBookOrderStudentIds\(item\.bookId\)[\s\S]*activeIds\.has\(String\(id\)\)/);
  assert.match(submit.slice(guard, submit.indexOf("if (!batchVendorName)")), /if \(duplicateStudent\) return toast\('선택한 학생 중 같은 교재 주문이 이미 진행 중인 학생이 있습니다/);
  assert.doesNotMatch(submit.slice(0, submit.indexOf("if (!batchVendorName)")),
    /batchDraft\s*=\s*null|batchSelection\.delete|closeModal\(\)/);
  assert.doesNotMatch(click, /bookPendingOrderCount/);
  assert.match(click, /batchSelection\.has\(id\) \? batchSelection\.delete\(id\) : batchSelection\.add\(id\)/);
});

test('화면에서 즉시 문자 발송 경로를 노출하지 않는다', () => {
  assert.doesNotMatch(html, /data-act="bossend"|data-act="smsmanual"|function sendBookOrder/);
  assert.match(html, /개별 주문도 매일 저녁 8시에 출판사별 문자 한 통으로 자동 묶입니다/);
});

test('교재 배송 현황과 완료 기록은 stable studentId 기반 학교급·학년 표기를 사용한다', () => {
  const row = block('function bookOrderRowHtml(', 'function bookOrderStageHtml(');
  const history = block('function viewBookOrderHistory(', 'function viewBookOrderStart(');
  const link = block('function openBookOrderStudentLink(', 'async function saveBookOrderStudentLink(');
  const bound = block('function boundBookOrderSummaryHtml(', 'function boundBookOrderOptionsHtml(');

  assert.match(row, /staffStudentCompactLabel\(student, '이름 미입력'\)/);
  assert.match(history, /staffStudentCompactLabel\(student, '이름 미입력'\)/);
  assert.match(link, /bookOrderStudentSchoolGradeLabel\(student\)/);
  assert.match(bound, /staffStudentCompactLabel\(student, '이름 미입력'\)/);
  assert.doesNotMatch(row, /student\.name \+ ' ' \+ \(student\.grade/);
});
