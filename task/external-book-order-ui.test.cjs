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

const EXPECTED_PUBLISHERS = [
  ['천재교육', '천재출판사'], ['디딤돌', '천재출판사'], ['YBM', '천재출판사'],
  ['길벗스쿨', '천재출판사'], ['와칭국어', '천재출판사'],
  ['미래앤', '동아출판사'], ['동아', '동아출판사'], ['지학사', '동아출판사'],
  ['입시플라이', '동아출판사'], ['능률', '동아출판사'], ['백발백중', '동아출판사'],
  ['개념원리', '동아출판사'], ['RPM', '동아출판사'],
  ['비상', '청암출판사'], ['세듀', '청암출판사'], ['수경', '청암출판사'],
  ['메가스터디', '청암출판사'], ['교학사', '청암출판사'], ['다락원', '청암출판사'],
  ['이투스', '상형출판사'], ['마더텅', '상형출판사']
];

test('21개 출판사는 raw 주문처 key에 정확히 매핑되고 목록에 없음이 가나다 목록 최상단이다', () => {
  const constants = block('const EXTERNAL_BOOK_PUBLISHERS =', 'function emptyExternalBookDraft(');
  const publishers = new Function(`${constants}\nreturn EXTERNAL_BOOK_PUBLISHERS;`)();
  assert.deepEqual(publishers.map(row => [row.publisherName, row.vendorName]), EXPECTED_PUBLISHERS);
  assert.equal(new Set(publishers.map(row => row.publisherName)).size, 21);
  assert.ok(publishers.every(row => ['천재출판사', '동아출판사', '청암출판사', '상형출판사'].includes(row.vendorName)));

  const optionsSource = block('function externalPublisherOptions(', 'function externalCatalogBooks(');
  const optionsFor = new Function('EXTERNAL_BOOK_PUBLISHERS', 'EXTERNAL_PUBLISHER_OTHER', 'EXTERNAL_PUBLISHER_UNLISTED',
    `${optionsSource}\nreturn externalPublisherOptions;`)(publishers, '__unlisted__', '__unlisted__');
  const options = optionsFor();
  assert.deepEqual(options[0], {
    value: '__unlisted__', label: '목록에 없음', publisherName: '', vendorName: '쿠팡'
  });
  assert.deepEqual(options.slice(1).map(row => [row.publisherName, row.vendorName]).sort(), EXPECTED_PUBLISHERS.slice().sort());
  assert.ok(options.slice(1).every((row, index, list) => !index ||
    String(list[index - 1].label).localeCompare(String(row.label), 'ko') <= 0), '알려진 출판사는 가나다순이어야 합니다');
});

test('출판사 선택 전에는 교재DB와 직접입력을 숨기고 선택 뒤 한 경로만 받는다', () => {
  const view = block('function externalBookOrderOptionsHtml(', 'function syncExternalBookOrderUi(');
  assert.match(view, /data-external-publisher/);
  assert.match(view, /externalPublisherOptions\(\)/);
  assert.match(view, /data-external-book/);
  assert.match(view, /EXTERNAL_BOOK_DIRECT/);
  assert.match(view, /교재DB에 없음 · 직접 입력/);
  assert.match(view, /data-external-title/);
  assert.match(view, /data-external-student/);
  assert.match(view, /data-external-unit-price/);
  assert.match(view, /data-act="externalbookorder"/);
  assert.match(view, /disabled/);
  assert.match(view, /externalPublisherChoice\(externalBookDraft\.publisherValue\)/);
  assert.match(view, /externalBookDraft\.bookValue/);
  assert.match(view, /EXTERNAL_BOOK_DIRECT/);
  const publisherGuard = Math.max(view.indexOf('if (selectedPublisher)'), view.indexOf('if (publisher)'));
  assert.ok(publisherGuard >= 0 && publisherGuard < view.indexOf('data-external-book'), '출판사 선택을 먼저 판정해야 합니다');

  const syncUi = block('function syncExternalBookOrderUi(', 'async function submitExternalBookOrder(');
  assert.match(syncUi, /data-external-publisher/);
  assert.match(syncUi, /data-external-book/);
  assert.match(syncUi, /data-external-title/);
  assert.match(syncUi, /data-external-student/);
  assert.match(syncUi, /data-external-unit-price/);
  assert.match(syncUi, /button\.disabled/);
});

test('교재DB는 선택 출판사의 아카등록 완료 교재만 가나다순으로 제공하고 직접입력과 섞지 않는다', () => {
  const source = block('function externalCatalogBooks(', 'function externalBookOrderOptionsHtml(');
  assert.match(source, /completedBookCatalog/);
  assert.match(source, /publisherName/);
  assert.match(source, /localeCompare/);
  assert.match(source, /title/);
  assert.match(source, /bookId/);

  const load = block('async function loadCompletedBookCatalog(', 'function currentBookCatalogOverlays(');
  assert.match(load, /sync\.post\('\/book-catalog', \{/);
  assert.match(load, /action: 'list'/);
  assert.match(load, /const verifiedRows = Array\.isArray\(result\.books\)/);
  assert.match(load, /const reviewRows = Array\.isArray\(result\.reviewCandidates\)/);
  assert.match(load, /completedBookCatalog = verifiedRows\.map\(completedBookCatalogDto\)/);
  assert.match(load, /verificationStatus === 'verified'/);
  assert.match(load, /completedBookCatalogReviewCandidates = reviewRows\.map\(completedBookCatalogDto\)/);
  assert.match(load, /verificationStatus !== 'verified'/);
  assert.match(load, /route === 'books'/);
  assert.match(load, /renderAfterSync\(\)/);
  assert.doesNotMatch(load, /studentIds|studentName|phone|contact/);
});

test('verified 완료 교재는 선택 당시 분류·총판이 아니라 검증 출판사만으로 재주문 그룹을 정한다', () => {
  const dtoSource = block('function completedBookCatalogDto(', 'function mergeCompletedBookCatalog(');
  const dto = new Function(`${dtoSource}\nreturn completedBookCatalogDto;`)();
  assert.equal(dto({ publisherName: '미래엔', selectedPublisherName: '미래앤' }).selectedPublisherName, '미래앤');
  assert.equal(dto({ publisherName: '천재교육' }).selectedPublisherName, '천재교육');
  assert.equal(dto({ publisherName: '검색 확인 출판사', selectedPublisherName: '' }).selectedPublisherName, '');

  const catalogSource = block('const EXTERNAL_PUBLISHER_SAFE_ALIASES =', 'async function stableExternalBookId(');
  const publishers = new Function(`${block('const EXTERNAL_BOOK_PUBLISHERS =', 'function emptyExternalBookDraft(')}\n` +
    'return EXTERNAL_BOOK_PUBLISHERS;')();
  const buildCatalogHelpers = new Function('completedBookCatalog', 'bookDb', 'EXTERNAL_BOOK_PUBLISHERS',
    `${catalogSource}\nreturn { externalCatalogBooks, canonicalExternalPublisherName };`);
  const helpers = buildCatalogHelpers([
    { bookId: 'verified-bisang', title: '확인 비상 교재', publisherName: '비상교육', selectedPublisherName: '미래앤',
      vendorName: '동아출판사', verificationStatus: 'verified' },
    { bookId: 'pending-book', title: '검토 중 수학', publisherName: '미래앤', selectedPublisherName: '미래앤',
      vendorName: '동아출판사', verificationStatus: 'pending' },
    { bookId: 'verified-unlisted', title: '목록 밖 교재', publisherName: '검색 확인 출판사', selectedPublisherName: '비상',
      vendorName: '청암출판사', verificationStatus: 'verified' }
  ], { books: [
    { id: 'static-bisang', title: '비상 별칭', publisherName: '비상교육', vendor: '청암출판사' },
    { id: 'static-mirae', title: '미래 별칭', publisherName: '미래엔', vendor: '동아출판사' },
    { id: 'static-cedu', title: '세듀 별칭', publisherName: '쎄듀', vendor: '청암출판사' },
    { id: 'static-unknown', title: '목록 밖 정적 교재', publisherName: '기타출판', vendor: '쿠팡' }
  ] }, publishers);
  const catalogFor = helpers.externalCatalogBooks;

  assert.deepEqual(catalogFor('미래앤').map(row => row.bookId), ['static-mirae']);
  assert.deepEqual(catalogFor('비상').map(row => row.bookId).sort(), ['static-bisang', 'verified-bisang']);
  assert.deepEqual(catalogFor('세듀').map(row => row.bookId), ['static-cedu']);
  assert.deepEqual(catalogFor('').map(row => row.bookId).sort(), ['static-unknown', 'verified-unlisted']);
  assert.equal(catalogFor('미래엔').length, 0);
  assert.equal(catalogFor('미래앤').some(row => row.bookId === 'verified-bisang'), false,
    'selectedPublisherName은 verified 완료 교재의 그룹을 결정하면 안 됩니다');
  assert.equal(catalogFor('비상').some(row => row.bookId === 'verified-unlisted'), false,
    'selectedPublisherName과 vendorName은 unknown verified 출판사를 목록 출판사로 옮기면 안 됩니다');
  assert.deepEqual(['비상교육', '미래엔', '쎄듀'].map(helpers.canonicalExternalPublisherName), ['비상', '미래앤', '세듀']);
});

test('pending 검토 후보는 ID마다 한 번만 12.5초 뒤 제한 재조회한다', () => {
  const scheduleSource = block('function scheduleCompletedBookCatalogPendingRefresh(', 'async function loadCompletedBookCatalog(');
  const run = new Function('rows', `
    let completedBookCatalogReviewCandidates = rows;
    const completedBookCatalogScheduledPendingIds = new Set();
    let completedBookCatalogPendingRefreshTimer = null;
    const COMPLETED_BOOK_CATALOG_PENDING_REFRESH_MS = 12500;
    let timerCount = 0, delay = 0, callback = null, refreshes = [];
    function setTimeout(next, ms) { timerCount += 1; callback = next; delay = ms; return timerCount; }
    function clearTimeout() {}
    function loadCompletedBookCatalog(force) { refreshes.push(force); }
    ${scheduleSource}
    scheduleCompletedBookCatalogPendingRefresh();
    scheduleCompletedBookCatalogPendingRefresh();
    if (callback) callback();
    return { timerCount, delay, refreshes, scheduled: [...completedBookCatalogScheduledPendingIds] };
  `)([
    { bookId: 'pending-one', verificationStatus: 'pending' },
    { bookId: 'pending-one', verificationStatus: 'pending' },
    { bookId: 'fallback-one', verificationStatus: 'fallback_mismatch' }
  ]);
  assert.deepEqual(run, { timerCount: 1, delay: 12500, refreshes: [true], scheduled: ['pending-one'] });
});

test('외부교재는 학생과 양의 가격이 준비된 뒤 publisherName을 포함해 서버 주문한다', () => {
  const submit = block('async function submitExternalBookOrder(', 'function bookOrderHistoryRows(');
  assert.match(submit, /studentIds/);
  assert.match(submit, /unitPrice/);
  assert.match(submit, /publisherName/);
  assert.match(submit, /vendorName/);
  assert.match(submit, /submitBookOrder/);
  assert.doesNotMatch(submit, /saveManualOnlineBookOrder|state\.tasks\.push|queueSync\(\)/);

  const common = block('async function submitBookOrder(', 'async function cancelSealedBookOrder(');
  assert.match(common, /Object\.prototype\.hasOwnProperty\.call\(item, 'publisherName'\)/);
  assert.match(common, /publisherName: (?:String\(item\.publisherName \|\| ''\)|item\.publisherName)/);
  assert.match(common, /result\.task\.orderDelivery/);
  assert.match(common, /scheduled_batch_v1/);
  assert.match(common, /manual_online_v1/);
  assert.doesNotMatch(common, /vendor\.type === 'online'[\s\S]{0,80}saveManualOnlineBookOrder/);
  assert.match(common, /await loadBookIssues\(true\)/);
});

test('쿠팡 주문도 서버 1단계에 남고 수동 주문완료·실패 결과를 서버에 기록한다', () => {
  const rowAction = block('function bookOrderActionButtons(', 'function bookOrderMoneyHtml(');
  assert.match(rowAction, /row\.orderDelivery === 'manual_online_v1'/);
  assert.match(rowAction, /row\.stage === 'order_waiting'/);
  assert.match(rowAction, /data-act="bookordermanualresult"/);
  assert.match(rowAction, /data-result="completed"/);
  assert.match(rowAction, /data-result="failed"/);

  const transition = block('async function transitionManualOnlineOrder(', 'async function saveLegacyBookOrderPrice(');
  assert.match(transition, /sync\.post\('\/book-issue', \{/);
  assert.match(transition, /action: 'manual_online_result'/);
  assert.match(transition, /taskId:/);
  assert.match(transition, /const result = String\(button\.dataset\.result/);
  assert.match(transition, /result:\s*String\(button\.dataset\.result|[\r\n]\s*result,[\r\n]/);
  assert.match(transition, /revision:/);
  assert.match(transition, /await loadBookIssues\(true\)/);
  assert.doesNotMatch(transition, /queueSync\(\)|state\.tasks/);

  const click = block("case 'bookordermanualresult':", "case 'transportrefresh':");
  assert.match(click, /transitionManualOnlineOrder\(el\)/);
});

test('아카등록 완료 직후 완료 교재 카탈로그를 다시 읽어 재주문 목록에 즉시 반영한다', () => {
  const transition = block('async function transitionBookOrder(', 'async function transitionManualOnlineOrder(');
  assert.match(transition, /await loadBookIssues\(true\);/);
  assert.match(transition, /if \(next === 'academy_register'\) await loadCompletedBookCatalog\(true\);/);
});
