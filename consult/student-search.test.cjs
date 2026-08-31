const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function functionSource(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, name + ' function must exist');
  const open = html.indexOf('{', start);
  let depth = 0, quote = '', escaped = false;
  for (let index = open; index < html.length; index++) {
    const char = html[index];
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return html.slice(start, index + 1);
  }
  assert.fail(name + ' function is incomplete');
}

function between(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, startMarker + ' section must exist');
  return html.slice(start, end);
}

test('student search matches partial names while ignoring spaces and letter case', () => {
  const search = Function(
    functionSource('normalizeStudentSearch') + '\n' + functionSource('studentMatchesSearch') +
    '\nreturn { normalizeStudentSearch, studentMatchesSearch };'
  )();
  assert.equal(search.normalizeStudentSearch('  Kim MinJun '), 'kimminjun');
  assert.equal(search.studentMatchesSearch({ name: '김 민준' }, '민 준'), true);
  assert.equal(search.studentMatchesSearch({ name: 'Kim MinJun' }, 'minjun'), true);
  assert.equal(search.studentMatchesSearch({ name: '박서연' }, '민준'), false);
});

test('director student management renders a bounded accessible search without persisting it', () => {
  const view = functionSource('viewStaffAdmin');
  const filter = functionSource('applyStaffSearchFilter');
  assert.match(html, /let staffSearchQuery = ''/);
  assert.match(view, /id="staffSearch" type="search" maxlength="50"/);
  assert.match(view, /placeholder="학생 이름 검색"/);
  assert.match(view, /aria-describedby="staffSearchResult"/);
  assert.match(view, /data-staff-search-name=/);
  assert.match(view, /studentMatchesSearch\(s, normalizedQuery\)/);
  assert.match(view, /검색한 이름과 일치하는 학생이 없습니다/);
  assert.doesNotMatch(filter, /save\(|queueSync\(|localStorage|state\./);
  assert.match(html, /const LS_KEY = 'wb_consult_v1'/);
  assert.match(html, /const SYNC_APP = 'consult'/);
});

test('typing filters existing cards immediately and exposes a no-result state', () => {
  const cards = [
    { dataset: { staffSearchName: '김민준', staffSubscription: '1', staffPaymentAttention: '0' }, hidden: false },
    { dataset: { staffSearchName: '박서연', staffSubscription: '0', staffPaymentAttention: '0' }, hidden: false }
  ];
  const nodes = {
    staffSearchResult: { textContent: '' },
    staffSearchEmpty: { hidden: true },
    staffSearchClear: { hidden: true }
  };
  const apply = Function('$', 'document',
    "let staffSearchQuery = ''; let staffListFilter = 'all';" + functionSource('normalizeStudentSearch') + '\n' +
    functionSource('normalizeStaffListFilter') + '\n' +
    functionSource('applyStaffSearchFilter') + '\nreturn applyStaffSearchFilter;'
  )(id => nodes[id.slice(1)] || null, { querySelectorAll: () => cards });

  apply(' 민 준 ');
  assert.deepEqual(cards.map(card => card.hidden), [false, true]);
  assert.equal(nodes.staffSearchResult.textContent, '1명 표시됨');
  assert.equal(nodes.staffSearchEmpty.hidden, true);
  assert.equal(nodes.staffSearchClear.hidden, false);

  apply('없는학생');
  assert.deepEqual(cards.map(card => card.hidden), [true, true]);
  assert.equal(nodes.staffSearchEmpty.hidden, false);
});

test('search input and clear action stay director-only and do not disturb form state', () => {
  const input = between("document.addEventListener('input', ev => {", "document.addEventListener('change', ev => {");
  const change = between("document.addEventListener('change', ev => {\n  if (ev.target.id === 'staffSearch')", '/* 모달 키보드 이동');
  const clear = between("case 'staffsearchclear':", "case 'linkcontactsretry':");
  assert.match(input, /ev\.target\.id === 'staffSearch'/);
  assert.match(input, /applyStaffSearchFilter\(ev\.target\.value\); return/);
  assert.ok(input.indexOf("ev.target.id === 'staffSearch'") < input.indexOf('viewInputDirty = true'));
  assert.match(change, /if \(ev\.target\.id === 'staffSearch'\) return/);
  assert.match(clear, /!session\.isAdmin \|\| session\.isStaffLink/);
  assert.match(clear, /applyStaffSearchFilter\(''\)/);
  assert.match(clear, /input\.focus\(\)/);
});
