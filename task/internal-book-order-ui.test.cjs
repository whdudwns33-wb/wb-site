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

function studentLabelHelperSource() {
  return block('function schoolLevelLabel(school)', 'function taskRosterStudent(t)');
}

const EXPECTED_INTERNAL_BOOKS = [
  ['reading', 'reading_bisang', '비상', 23000, 8],
  ['reading', 'reading_advanced', '심화', 19000, 12],
  ['reading', 'reading_application', '응용', 19000, 12],
  ['reading', 'reading_intro', '입문', 19000, 8],
  ['reading', 'reading_top', '최상', 23000, 8],
  ['reading', 'reading_essential', '필수', 19000, 12],
  ['vocabulary', 'vocab_stage_1', '1단계', 12500, null],
  ['vocabulary', 'vocab_stage_2', '2단계', 12500, null],
  ['vocabulary', 'vocab_stage_3', '3단계', 12500, null],
  ['vocabulary', 'vocab_stage_4', '4단계', 12500, null],
  ['vocabulary', 'vocab_stage_5', '5단계', 12500, null],
  ['vocabulary', 'vocab_stage_6', '6단계', 12500, null],
  ['vocabulary', 'vocab_basic', '기본', 12000, null],
  ['vocabulary', 'vocab_skill', '실력', 13000, null],
  ['vocabulary', 'vocab_middle', '중등', 14500, null],
  ['vocabulary', 'vocab_high', '고등', 16000, null],
  ['vocabulary', 'vocab_hanja_1', '한자1단계', 12000, null],
  ['vocabulary', 'vocab_hanja_2', '한자2단계', 12000, null],
  ['vocabulary', 'vocab_hanja_3', '한자3단계', 12000, null],
  ['vocabulary', 'vocab_hanja_4', '한자4단계', 12000, null],
  ['studyforce', 'studyforce_bound', '제본', 6000, null],
  ['studyforce', 'studyforce_passage_notes', '지문정리노트', 10000, null]
];

test('논리와 상상 추가 후에도 독해창·어휘가 독해다·스터디포스 전 항목과 권 범위는 그대로 유지한다', () => {
  const source = block('const INTERNAL_BOOK_OPTIONS =', 'let internalBookOptionCode');
  const options = new Function(`${source}\nreturn INTERNAL_BOOK_OPTIONS;`)();
  assert.deepEqual(options.filter(option => option.family !== 'logic').map(option => [
    option.family,
    option.productCode,
    option.label,
    option.price,
    Number.isInteger(option.maxVolume) ? option.maxVolume : null
  ]), EXPECTED_INTERNAL_BOOKS);
  assert.equal(new Set(options.map(option => option.productCode)).size, options.length,
    '제품 코드는 서버 주문 정체성에 쓰이므로 중복될 수 없습니다');
});

test('외부교재 선택 화면은 기존 구조를 유지하면서 교재DB 표시명만 외부교재DB로 구분한다', () => {
  const view = block('function externalBookOrderOptionsHtml(', 'function syncExternalBookOrderUi(');
  assert.match(view, /외부교재DB/);
  assert.match(view, /외부교재DB에 없음/);
  assert.doesNotMatch(view, />교재DB에 없음/);
  assert.match(view, /externalCatalogBooks/);
  assert.match(view, /data-external-book/);
});

test('최종 확인 내용은 교재·가격·학생 이름·수량·소계와 전체 합계를 계산해 보여준다', () => {
  const source = block('function bookOrderConfirmationStudentRows(', 'function openBookOrderFinalConfirmation(');
  const render = new Function('orderStudentCandidates', 'esc', 'rosterDb',
    `${studentLabelHelperSource()}\n${source}\nreturn bookOrderFinalConfirmationHtml;`)(
      () => [
        { id: 'student-a', name: '가학생', school: '가초등학교', grade: '4' },
        { id: 'student-b', name: '나학생', school: '나중학교', grade: '1' }
      ],
      value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
      { students: [] }
    );
  const markup = render([
    { title: '어휘가 독해다 1단계', unitPrice: 12500, studentIds: ['student-a', 'student-b'] },
    { title: '스터디포스 제본', unitPrice: 6000, studentIds: ['student-b'] }
  ]);

  for (const text of ['어휘가 독해다 1단계', '스터디포스 제본', '가학생', '나학생',
    '12,500원', '25,000원', '6,000원', '총 3권', '합계 31,000원']) assert.ok(markup.includes(text), text);
  for (const label of ['가학생 초4', '나학생 중1']) assert.ok(markup.includes(label), label);
  assert.match(markup, /2권/);
  assert.doesNotMatch(markup, /student-a|student-b/, 'stable studentId는 확인 화면에 노출하지 않습니다');
});

test('최종 확인은 현재 재원 stable studentId가 모두 해석될 때만 열 수 있다', () => {
  const source = block('function bookOrderConfirmationStudentRows(', 'function bookOrderFinalConfirmationHtml(');
  const validate = new Function('orderStudentCandidates',
    `${source}\nreturn bookOrderItemsHaveCurrentStudents;`)(
      () => [{ id: 'student-a' }, { id: 'student-b' }]
    );
  assert.equal(validate([{ studentIds: ['student-a', 'student-b'] }]), true);
  assert.equal(validate([{ studentIds: ['student-a', 'deleted-student'] }]), false);
  assert.equal(validate([{ studentIds: [] }]), false);
  assert.equal(validate([]), false);

  const submit = block('async function submitBookOrder(', 'async function cancelSealedBookOrder(');
  assert.ok(submit.indexOf('bookOrderItemsHaveCurrentStudents(items)') < submit.indexOf("sync.post('/book-order'"));
});

test('내부교재는 독해창·논리와 상상·어휘가 독해다·스터디포스를 독립된 접기 영역으로 둔다', () => {
  const familySource = block('function internalBookFamilyDetails(', 'function internalBookSimpleOptionsHtml(');
  const renderFamily = new Function('esc', `${familySource}\nreturn internalBookFamilyDetails;`)(String);
  const view = block('function internalBookOrderOptionsHtml(', 'function syncInternalBookStudentLinkButton(');
  const families = [
    ['reading', '독해창'],
    ['logic', '논리와 상상'],
    ['vocabulary', '어휘가 독해다'],
    ['studyforce', '스터디포스']
  ];

  for (const [key, label] of families) {
    const markup = renderFamily(key, label, '<span>내용</span>');
    assert.match(markup, new RegExp('<details class="internal-book-family" data-persist-key="book-order-internal-' + key + '">'));
    assert.match(markup, new RegExp('<span>' + label + '<\\/span>'));
    assert.doesNotMatch(markup.match(/<details[^>]*>/)[0], /\bopen\b/, `${label}은 처음에는 접혀 있어야 합니다`);
    assert.match(view, new RegExp("internalBookFamilyDetails\\('" + key + "', '" + label + "'"));
  }
  assert.match(view, /internalBookFamilyDetails\('logic', '논리와 상상', internalBookVolumeOptionsHtml\('logic'\)\)/);
  assert.doesNotMatch(view, /준비 중입니다/);
});

test('독해창은 제목과 가격 사이에서 제품별 정확한 권번호만 선택하게 한다', () => {
  const optionsSource = block('const INTERNAL_BOOK_OPTIONS =', 'let internalBookOptionCode');
  const options = new Function(`${optionsSource}\nreturn INTERNAL_BOOK_OPTIONS;`)();
  const helpers = block('function internalBookHasVolume(', 'function internalBookDraftStudents(');
  const source = block('function internalBookVolumeOptionsHtml(', 'function internalBookOrderSummaryHtml(');
  const render = new Function('INTERNAL_BOOK_OPTIONS', 'internalBookOptionCode', 'internalBookVolume',
    'internalBookSubmitting', 'esc', `${helpers}\n${source}\nreturn internalBookVolumeOptionsHtml;`)(
      options, '', '', false, String
    );
  const markup = render('reading');

  for (const option of options.filter(row => row.family === 'reading')) {
    const start = markup.indexOf(`value="${option.productCode}"`);
    const end = markup.indexOf('</div>', start);
    assert.ok(start >= 0 && end > start, option.label);
    const row = markup.slice(start, end);
    const title = row.indexOf(`<span>${option.label}</span>`);
    const dropdown = row.indexOf('<select');
    const price = row.indexOf(`${option.price.toLocaleString('ko-KR')}원`);
    assert.ok(title >= 0 && dropdown > title && price > dropdown, `${option.label} 제목 → 권번호 → 가격 순서`);
    assert.deepEqual([...row.matchAll(/<option value="(\d+)"/g)].map(match => Number(match[1])),
      Array.from({ length: option.maxVolume }, (_, index) => index + 1), `${option.label} 권 범위`);
  }
});

test('내부교재 선택 뒤 stable studentId 연결과 주문하기 동작으로 이어진다', () => {
  const view = block('function internalBookOrderOptionsHtml(', 'function syncInternalBookStudentLinkButton(');
  assert.match(view, /data-act="internalbookstudentopen"/);
  assert.match(view, />학생 연결하기<\/button>/);
  assert.match(view, /data-act="internalbookordersubmit"/);
  assert.match(view, />주문하기<\/button>/);
  assert.match(view, /selectionReady && !internalBookSubmitting/);
  assert.match(view, /ready && !internalBookSubmitting/);

  const modal = block('function openInternalBookStudentModal(', 'function saveInternalBookStudentLink(');
  assert.match(modal, /orderStudentCandidates\(\)/);
  assert.match(modal, /type="checkbox" data-internal-book-student/);
  assert.match(modal, /data-act="internalbookstudentlinksave"/);
  assert.match(modal, />학생 연결 완료<\/button>/);

  const save = block('function saveInternalBookStudentLink(', 'async function submitInternalBookOrder(');
  assert.match(save, /data-internal-book-student]:checked/);
  assert.match(save, /internalBookDraft = \{ productCode:/);
  assert.match(save, /studentIds,/);
  assert.match(save, /closeModal\(\)/);

  const click = block("case 'externalbookorder':", "case 'bookorderhistorysearch':");
  assert.match(click, /case 'internalbookstudentopen': openInternalBookStudentModal\(\)/);
  assert.match(click, /case 'internalbookstudentlinksave': saveInternalBookStudentLink\(\)/);
  assert.match(click, /case 'internalbookordersubmit': submitInternalBookOrder\(el\)/);
});

test('내부교재 주문은 서버가 확정한 internal_book_v1을 확인한 뒤 바로 3단계를 다시 읽는다', () => {
  const submit = block('async function submitInternalBookOrder(', 'function boundBookOption(');
  assert.match(submit, /sync\.post\('\/book-order', \{/);
  assert.match(submit, /action: 'create_internal'/);
  for (const field of ['taskId:', 'productCode:', 'volume', 'studentIds:']) assert.match(submit, new RegExp(field), field);
  assert.match(submit, /result\.task\.orderDelivery !== 'internal_book_v1'/);
  assert.match(submit, /Number\(result\.task\.orderIdentityVersion\) !== 1/);
  assert.match(submit, /await loadBookIssues\(true\)/);
  assert.match(submit, /3단계 선생님 수령/);
  assert.doesNotMatch(submit, /state\.tasks\.push|queueSync\(\)|book-order-send/);

  const posted = submit.indexOf("await sync.post('/book-order'");
  for (const marker of ["internalBookOptionCode = ''", 'internalBookDraft = null', 'closeModal()', 'await loadBookIssues(true)']) {
    assert.ok(submit.indexOf(marker) > posted, `${marker}는 서버 성공 뒤에만 실행해야 합니다`);
  }
});

test('다른 기기에서 만든 내부교재 주문도 다음 동기화에서 배송 현황을 즉시 갱신한다', () => {
  const run = block('async run() {', 'async issueBootstrap(');
  const refreshMarkers = [...run.matchAll(/\['scheduled_batch_v1', 'manual_online_v1', 'bound_print_v1', 'internal_book_v1'\]/g)];
  assert.equal(refreshMarkers.length, 2, '보내는 변경과 받는 변경 모두 내부교재를 주문 현황 갱신 대상으로 봐야 합니다');
  assert.match(run, /if \(refreshBookOrders\) \{[\s\S]*bookIssueLoaded = false;[\s\S]*loadBookIssues\(true\)/);
});

test('외부·제본·내부·기존 단권·일괄 주문은 모두 최초 클릭에서 최종 확인을 먼저 연다', () => {
  const common = block('async function submitBookOrder(', 'async function cancelSealedBookOrder(');
  const commonConfirm = common.indexOf("if (!confirmed)");
  const commonPost = common.indexOf("sync.post('/book-order'");
  assert.ok(commonConfirm >= 0 && commonPost > commonConfirm);
  assert.match(common.slice(commonConfirm, commonPost), /openBookOrderFinalConfirmation\('standard', items\)/);

  const external = block('async function submitExternalBookOrder(', 'function internalBookOption(');
  assert.match(external, /if \(!confirmed\)[\s\S]*openBookOrderFinalConfirmation\('external', items\)[\s\S]*return/);
  assert.match(external, /submitBookOrder\(items, button, true\)/);

  const internal = block('async function submitInternalBookOrder(', 'function boundBookOption(');
  const internalConfirm = internal.indexOf('if (!confirmed)');
  const internalPost = internal.indexOf("sync.post('/book-order'");
  assert.ok(internalConfirm >= 0 && internalPost > internalConfirm);
  assert.match(internal.slice(internalConfirm, internalPost), /openBookOrderFinalConfirmation\('internal', \[item\]\)/);

  const bound = block('async function submitBoundBookOrder(', 'async function confirmPendingBookOrder(');
  const boundConfirm = bound.indexOf('if (!confirmed)');
  const boundPost = bound.indexOf("sync.post('/book-order'");
  assert.ok(boundConfirm >= 0 && boundPost > boundConfirm);
  assert.match(bound.slice(boundConfirm, boundPost), /openBookOrderFinalConfirmation\('bound'/);

  const single = block("case 'bkordersubmit':", "case 'bkselect':");
  const batch = block("case 'bkbatchsubmit':", "case 'bkcancelopen':");
  assert.match(single, /submitBookOrder\([^;]+, el\)/);
  assert.match(batch, /submitBookOrder\(items, el\)/);
  assert.doesNotMatch(single, /submitBookOrder\([^;]+, el, true\)/);
  assert.doesNotMatch(batch, /submitBookOrder\(items, el, true\)/);
});

test('실제 주문 함수는 최종 확인 버튼에서만 confirmed=true로 호출한다', () => {
  const open = block('function openBookOrderFinalConfirmation(', 'function cancelBookOrderFinalConfirmation(');
  assert.match(open, /교재 주문 최종 확인/);
  assert.match(open, /data-act="bookorderconfirm"/);
  assert.match(open, />확인 후 주문하기<\/button>/);
  assert.match(open, /data-act="bookorderconfirmcancel"/);

  const confirm = block('async function confirmPendingBookOrder(', 'function bookOrderHistorySearchKey(');
  assert.match(confirm, /pending\.kind === 'standard'[\s\S]*submitBookOrder\(pending\.items, button, true\)/);
  assert.match(confirm, /pending\.kind === 'external'[\s\S]*submitExternalBookOrder\(button, true\)/);
  assert.match(confirm, /pending\.kind === 'bound'[\s\S]*submitBoundBookOrder\(button, true\)/);
  assert.match(confirm, /pending\.kind === 'internal'[\s\S]*submitInternalBookOrder\(button, true\)/);

  const click = block("case 'externalbookorder':", "case 'bookorderhistorysearch':");
  assert.match(click, /case 'externalbookorder': submitExternalBookOrder\(el\)/);
  assert.match(click, /case 'boundbookordersubmit': submitBoundBookOrder\(el\)/);
  assert.match(click, /case 'internalbookordersubmit': submitInternalBookOrder\(el\)/);
  assert.match(click, /case 'bookorderconfirm': confirmPendingBookOrder\(el\)/);
  assert.doesNotMatch(click, /submit(?:External|Bound|Internal)BookOrder\(el, true\)/);
});

test('최초 더블클릭과 전송 중 닫기·취소는 주문 확인 상태를 바꾸지 못한다', () => {
  const open = block('function openBookOrderFinalConfirmation(', 'function setBookOrderConfirmationSubmittingUi(');
  assert.match(open, /confirmReadyAt: Date\.now\(\) \+ 400/);
  assert.match(open, /data-book-order-confirm-submit disabled/);
  assert.match(open, /pendingBookOrderConfirmation !== confirmation \|\| bookOrderConfirmationSubmitting/);

  const controls = block('function setBookOrderConfirmationSubmittingUi(', 'function cancelBookOrderFinalConfirmation(');
  assert.match(controls, /button\[data-act="closemodal"\]/);
  assert.match(controls, /button\[data-act="bookorderconfirmcancel"\]/);
  assert.match(controls, /button\[data-act="bookorderconfirm"\]/);
  assert.match(controls, /control\.disabled = !!submitting/);

  const cancel = block('function cancelBookOrderFinalConfirmation(', '/** 새 주문은 서버가');
  const guard = cancel.indexOf('if (bookOrderConfirmationSubmitting)');
  const clear = cancel.indexOf('pendingBookOrderConfirmation = null');
  assert.ok(guard >= 0 && clear > guard, '전송 중에는 pending 확인 정보를 지우면 안 됩니다');
  assert.match(cancel.slice(guard, clear), /return false/);

  const confirm = block('async function confirmPendingBookOrder(', 'function bookOrderHistorySearchKey(');
  assert.match(confirm, /Date\.now\(\) < Number\(pending\.confirmReadyAt \|\| 0\)/);
  assert.match(confirm, /bookOrderConfirmationSubmitting = true;[\s\S]*setBookOrderConfirmationSubmittingUi\(true\)/);
  assert.match(confirm, /if \(success\) pendingBookOrderConfirmation = null;[\s\S]*else setBookOrderConfirmationSubmittingUi\(false\)/);
});

test('상단 닫기·배경·Escape는 최종 확인 전용 취소 경로를 사용하고 외부 주문 성공값을 반환한다', () => {
  const click = block("case 'closemodal':", 'function captureTransportDraftFromEvent');
  assert.match(click, /pendingBookOrderConfirmation[\s\S]*cancelBookOrderFinalConfirmation\(\)/);

  const keydown = block("document.addEventListener('keydown',", '/* 복귀 시 최신화 */');
  assert.match(keydown, /ev\.key === 'Escape'[\s\S]*pendingBookOrderConfirmation[\s\S]*cancelBookOrderFinalConfirmation\(\)/);

  const external = block('async function submitExternalBookOrder(', 'function internalBookOption(');
  assert.match(external, /const success = await submitBookOrder\(items, button, true\)/);
  assert.match(external, /return success;/);
});
