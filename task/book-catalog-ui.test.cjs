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

function catalogHelpers() {
  const seriesName = block('function bookSeriesName(', 'function groupBooksBySeries(');
  const groups = block('function groupBooksBySeries(', 'function normalizeBookSearch(');
  return new Function(
    `const OTHER_BOOK_SERIES = '기타·개별 교재';\n${seriesName}\n${groups}\n` +
    'return { bookSeriesName, groupBooksBySeries, OTHER_BOOK_SERIES };'
  )();
}

test('explicit series wins and only conservative title patterns are inferred', () => {
  const { bookSeriesName, OTHER_BOOK_SERIES } = catalogHelpers();
  assert.equal(bookSeriesName({ title: '임의 제목', series: '  수학 탐구  ' }), '수학 탐구');
  assert.equal(bookSeriesName({ title: '팩토사고력 Lv3 B 기본' }), '팩토사고력');
  assert.equal(bookSeriesName({ title: '팩토 사고력 Lv4 C 응용' }), '팩토사고력');
  assert.equal(bookSeriesName({ title: '독해창 비상1' }), '독해창');
  assert.equal(bookSeriesName({ title: '논리와 상상 도약5 (창의)' }), '논리와 상상');
  assert.equal(bookSeriesName({ title: '개념원리 미적분Ⅰ' }), '개념원리');
  assert.equal(bookSeriesName({ title: 'RPM 중학 수학 2-2' }), 'RPM');

  for (const title of ['어휘 3단계', '어휘 5단계', '독해창 비상3', '끊어읽기 365', '의미단위 끊어읽기']) {
    assert.equal(bookSeriesName({ title }), OTHER_BOOK_SERIES, title);
  }
});

test('series grouping preserves existing approved book objects and ids', () => {
  const { groupBooksBySeries, OTHER_BOOK_SERIES } = catalogHelpers();
  const books = [
    { id: 'A', title: '개별 교재' },
    { id: 'B', title: '팩토사고력 Lv3 B 기본' },
    { id: 'C', title: '팩토사고력 Lv3 B 응용' }
  ];
  const before = JSON.stringify(books);
  const grouped = groupBooksBySeries(books);
  assert.equal(JSON.stringify(books), before);
  assert.deepEqual(grouped.map(group => [group.name, group.books.map(book => book.id)]), [
    ['팩토사고력', ['B', 'C']],
    [OTHER_BOOK_SERIES, ['A']]
  ]);
  assert.equal(grouped[0].books[0], books[1]);
});

test('book search is token-based across title, series, subject, level, and vendor', () => {
  const source = block('function normalizeBookSearch(', '/** 검색은 DOM 표시만 바꾼다');
  const seriesName = block('function bookSeriesName(', 'function groupBooksBySeries(');
  const { bookSearchText, bookSearchMatches, booksOutsideSearch } = new Function(
    `const OTHER_BOOK_SERIES = '기타·개별 교재';\n${seriesName}\n${source}\n` +
    'return { bookSearchText, bookSearchMatches, booksOutsideSearch };'
  )();
  const text = bookSearchText(
    { title: '팩토사고력 Lv3 B 기본', subject: '수학 사고력', level: '초3' },
    '천재출판사', '팩토사고력'
  );
  assert.equal(bookSearchMatches(text, '팩토 초3'), true);
  assert.equal(bookSearchMatches(text, '천재 수학'), true);
  assert.equal(bookSearchMatches(text, '팩토 영어'), false);
  assert.equal(bookSearchMatches(text, '  '), true);
  assert.equal(booksOutsideSearch([
    { title: '팩토사고력 Lv3 B 기본', subject: '수학', level: '초3' },
    { title: '개별 독해 교재', subject: '국어', level: '초4' }
  ], '천재출판사', '팩토'), 1);
  assert.equal(booksOutsideSearch([{ title: '아무 교재' }], '천재출판사', ''), 0);
});

test('DOM-only search refreshes the hidden selected-book count immediately', () => {
  const source = block('function updateBookBatchOutsideSearch(', '/** 검색은 DOM 표시만 바꾼다');
  const { updateBookBatchOutsideSearch } = new Function(
    `${source}\nreturn { updateBookBatchOutsideSearch };`
  )();
  const note = { hidden: true, textContent: '' };
  const vendor = {
    querySelectorAll: selector => {
      assert.equal(selector, '[data-book-entry][data-book-selected="true"][hidden]');
      return [{}, {}];
    },
    querySelector: selector => {
      assert.equal(selector, '[data-book-batch-outside]');
      return note;
    }
  };
  assert.equal(updateBookBatchOutsideSearch(vendor, true), 2);
  assert.equal(note.hidden, false);
  assert.equal(note.textContent, ' · 검색 밖 2권 포함');
  assert.equal(updateBookBatchOutsideSearch(vendor, false), 0);
  assert.equal(note.hidden, true);
  assert.equal(note.textContent, '');
});

test('publisher-series-book accordion is searchable and mobile-friendly', () => {
  const view = block('function viewBooks()', '/* ── 원생 현황');
  const card = block('function bookCard(', '/* ── 새 교재 추가 신청');
  const search = block('function applyBookSearch(', 'function vendorTypeBadge(');
  const render = block('function render() {', 'function renderTabs()');
  const input = block("document.addEventListener('input', ev => {", "const scheduleSearch = ev.target.closest('[data-schedule-search]')");

  assert.match(view, /data-book-search-input/);
  assert.match(view, /data-book-search-status role="status" aria-live="polite"/);
  assert.match(view, /data-book-vendor/);
  assert.match(view, /groupBooksBySeries\(sec\.books\)/);
  assert.match(view, /const searching = !!normalizeBookSearch\(bookSearchQuery\)/);
  assert.match(view, /\(searching \? ' disabled' : ''\)/);
  assert.match(view, /selectedHere\.length \? ' <span class="tag">선택 ' \+ selectedHere\.length/);
  assert.match(view, /data-book-series data-expanded/);
  assert.match(view, /data-act="seriestoggle"/);
  assert.match(view, /const closed = vendorClosed\.has\(sec\.key\)/);
  assert.match(view, /seriesExpansion\.has\(seriesKey\)[\s\S]{0,100}\? seriesExpansion\.get\(seriesKey\) : !!\(selected \|\| groupPending\)/);
  assert.match(view, /선택 ' \+ selected/);
  assert.match(view, /주문 ' \+ groupPending/);
  assert.match(view, /data-book-entry data-book-selected/);
  assert.match(view, /data-book-selected="' \+\s*String\(batchSelection\.has\(book\.id\)\)/);
  assert.match(view, /기타·개별 교재/);
  assert.match(card, /aria-label="' \+ esc\(b\.title\) \+ ' 일괄 주문 선택/);
  assert.match(card, /book-card-actions/);
  assert.match(html, /@media \(max-width: 600px\)[\s\S]{0,220}\.book-card-actions \{ width: 100%; \}[\s\S]{0,100}min-height: 44px/);
  assert.match(input, /applyBookSearch\(bookSearch\.value\)/);

  assert.match(search, /const expanded = hasQuery \? count > 0 : series\.dataset\.expanded === 'true'/);
  assert.match(search, /body\.hidden = !expanded/);
  assert.match(search, /toggle\.disabled = hasQuery/g);
  assert.match(search, /updateBookBatchOutsideSearch\(vendor, hasQuery\)/);
  assert.match(search, /검색 중에는 결과를 자동으로 펼칩니다/);
  assert.doesNotMatch(search, /seriesExpansion\.(?:set|delete|clear)|vendorClosed\.(?:add|delete|clear)|batchSelection\.(?:add|delete|clear)/);
  assert.match(render, /applyBookSearch\(bookSearchQuery\);\s*restoreBookToggleFocus\(\)/);
});

test('book accordion restores keyboard focus and uses valid button content', () => {
  const focusSource = block('let bookToggleFocus = null;', '/** 시리즈는 주문 데이터가 아닌 표시용 파생값이다');
  let focusOptions = null;
  const wanted = { dataset: { act: 'seriestoggle', key: 'vendor::series' }, focus: options => { focusOptions = options; } };
  const other = { dataset: { act: 'seriestoggle', key: 'other' }, focus: () => assert.fail('wrong toggle focused') };
  const api = new Function('document', `${focusSource}\nreturn { rememberBookToggleFocus, restoreBookToggleFocus };`)({
    querySelectorAll: selector => {
      assert.equal(selector, '[data-act="seriestoggle"]');
      return [other, wanted];
    }
  });
  api.rememberBookToggleFocus(wanted);
  api.restoreBookToggleFocus();
  assert.deepEqual(focusOptions, { preventScroll: true });

  const view = block('function viewBooks()', '/* ── 원생 현황');
  const vendorButton = block('class="card between book-vendor-toggle"', '</span></button>');
  const seriesButton = block('class="between book-series-toggle"', '</span></button>');
  const click = block("case 'vendortoggle':", "case 'baopen':");
  assert.doesNotMatch(vendorButton, /<div/);
  assert.doesNotMatch(seriesButton, /<div/);
  assert.match(view, /<span class="book-vendor-copy"><span class="card-title">/);
  assert.match(view, /<span class="book-series-title">/);
  assert.match(html, /\.book-vendor-copy[^\{]*\{ display: block; \}/);
  assert.equal((click.match(/rememberBookToggleFocus\(el\)/g) || []).length, 2);
  assert.equal((click.match(/if \(normalizeBookSearch\(bookSearchQuery\)\) break/g) || []).length, 2);
});

test('background book overlays defer render while the search input is active', () => {
  const load = block('function loadBooks()', '/** 목차 텍스트');
  const queues = block('async function loadBookAddQueue(', 'function bookAddSummary(') +
    block('async function loadBookEditQueue(', 'function ownBookEditCard(');
  assert.doesNotMatch(load, /route === 'books'\) render\(\)/);
  assert.doesNotMatch(queues, /route === 'books'\) render\(\)/);
  assert.ok((load.match(/route === 'books'\) renderAfterSync\(\)/g) || []).length >= 4);
  assert.ok((queues.match(/route === 'books'\) renderAfterSync\(\)/g) || []).length >= 8);
  assert.match(html, /function isTaskEditorActive\(\)[\s\S]{0,180}el\.matches\('input, textarea, select/);
});

test('series display never changes publisher batch or outbound order data', () => {
  const batch = block('function batchOrderModal(', 'function cancelOrderModal(');
  const order = block('function createOrderTask(', '/** 일괄 주문용 선택 상태');
  const view = block('function viewBooks()', '/* ── 원생 현황');
  const toggle = block("case 'seriestoggle':", "case 'baopen':");

  assert.match(batch, /b\.vendor === vendorKey/);
  assert.match(batch, /const outsideSearch = booksOutsideSearch\(books, vendorLabel, bookSearchQuery\)/);
  assert.match(batch, /검색 밖 ' \+ outsideSearch \+ '권 포함/);
  assert.match(batch, /batchDraft = books\.map/);
  assert.match(order, /orderVendor: vendorName \|\| '', orderItems: items, orderDelivery: 'scheduled_batch_v1'/);
  assert.doesNotMatch(order, /series/i);
  assert.match(view, /const selectedHere = sec\.books\.filter\(b => batchSelection\.has\(b\.id\)\)/);
  assert.match(view, /data-book-batch-outside/);
  assert.match(view, /검색 밖 ' \+ selectedOutsideSearch \+ '권 포함/);
  assert.doesNotMatch(toggle, /batchSelection/);
});
