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

function functionBlock(name) {
  let start = html.indexOf(`function ${name}(`);
  if (start < 0) start = html.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} 함수를 찾을 수 없습니다`);
  const tail = html.slice(start + 1);
  const next = tail.search(/\n(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/);
  return next < 0 ? html.slice(start) : html.slice(start, start + 1 + next);
}

test('catalog DTO는 review revision을 보존하고 검토 버튼은 관리자 완료 기록에만 렌더링한다', () => {
  const dto = block('function completedBookCatalogDto(', 'function mergeCompletedBookCatalog(');
  assert.match(dto, /revision:[^\n]*Number\(source\.revision\)/);
  assert.match(dto, /reviewMethod:\s*String\(source\.reviewMethod/);
  assert.match(dto, /reviewedAt:\s*(?:source\.reviewedAt == null \? null : )?Number\(source\.reviewedAt/);
  assert.doesNotMatch(dto, /reviewedBy/);

  const view = block('function viewBookOrderHistory(', 'function viewBookOrderStart(');
  const actionIndex = view.indexOf('data-act="bookcatalogreviewopen"');
  const adminIndex = view.lastIndexOf('session.isAdmin', actionIndex);
  assert.ok(actionIndex >= 0, '검토 후보 행에 관리자 승인 버튼이 필요합니다');
  assert.ok(adminIndex >= 0 && actionIndex - adminIndex < 700, '승인 버튼은 session.isAdmin 조건 안에 있어야 합니다');
  assert.match(view, /reviewCandidate/);
  assert.match(view, /catalogSearchPending[\s\S]*교재DB 검색 중[\s\S]*교재DB 확인 필요/);
  assert.match(view, /reviewCandidate && !catalogSearchPending && session\.isAdmin/);
  assert.equal((view.match(/data-act="bookcatalogreviewopen"/g) || []).length, 1);

  const open = functionBlock('openBookCatalogReviewModal');
  assert.match(open, /if \(!session\.isAdmin\) return/);
  assert.match(open, /bookOrderCatalogReviewCandidate|completedBookCatalogReviewCandidates/);
  assert.match(open, /candidate\.verificationStatus === 'pending'[\s\S]*loadCompletedBookCatalog\(true\)[\s\S]*return toast/);
});

test('관리자 검토 모달은 후보의 정확한 교재명·출판사를 입력받고 명시적 승인만 허용한다', () => {
  const open = functionBlock('openBookCatalogReviewModal');
  assert.match(open, /bookCatalogReviewTarget\s*=/);
  assert.match(open, /data-book-catalog-review-title/);
  assert.match(open, /data-book-catalog-review-publisher/);
  assert.match(open, /data-act="bookcatalogreviewapprove"/);
  assert.match(open, /교재명/);
  assert.match(open, /출판사/);
  assert.match(open, /reviewCandidate\.(?:title|publisherName)|candidate\.(?:title|publisherName)/);
  assert.match(open, /modal\(/);

  const click = block("case 'bookcatalogreviewopen':", "case 'transportrefresh':");
  assert.match(click, /openBookCatalogReviewModal\(/);
  assert.match(click, /case 'bookcatalogreviewapprove':[\s\S]*approveBookCatalogReview\(/);
});

test('승인은 exact CAS payload를 한 번만 보내고 성공·409는 재조회하며 일반 실패는 draft를 보존한다', () => {
  const approve = functionBlock('approveBookCatalogReview');
  assert.match(approve, /if \(!session\.isAdmin/);
  assert.match(approve, /bookCatalogReviewSubmitting/);
  assert.match(approve, /data-book-catalog-review-title/);
  assert.match(approve, /data-book-catalog-review-publisher/);
  assert.match(approve, /\.trim\(\)/);
  assert.match(approve, /(?:rawTitle|title)\.length[^\n]*(?:160|MAX)/);
  assert.match(approve, /(?:rawPublisherName|publisherName)\.length[^\n]*(?:100|MAX)/);
  assert.match(approve, /data-book-catalog-review-confirm/);
  assert.match(approve, /confirmInput[^\n]*\.checked/);
  assert.match(approve, /if \(!confirm\(/);
  assert.match(approve, /button\.disabled\s*=\s*true/);
  assert.match(approve, /sync\.post\('\/book-catalog',\s*\{/);
  assert.match(approve, /action:\s*'review_approve'/);
  assert.match(approve, /bookId:\s*(?:bookCatalogReviewTarget|target)\.bookId/);
  assert.match(approve, /expectedRevision:\s*(?:Number\()?((?:bookCatalogReviewTarget|target)\.revision)/);
  assert.match(approve, /title:\s*title/);
  assert.match(approve, /publisherName:\s*publisherName/);
  assert.match(approve, /await loadCompletedBookCatalog\(true\)/);
  assert.match(approve, /await loadBookIssues\(true\)/);

  const requestIndex = approve.indexOf("sync.post('/book-catalog'");
  assert.ok(approve.indexOf('closeModal()', requestIndex) > requestIndex, '성공 응답 전에는 모달을 닫으면 안 됩니다');
  const failure = approve.slice(approve.indexOf('catch'));
  assert.match(failure, /error\.status[^\n]*409[^\n]*error\.status[^\n]*404/);
  assert.match(failure, /await loadCompletedBookCatalog\(true\)[\s\S]*await loadBookIssues\(true\)/);
  const ordinaryFailure = failure.slice(failure.indexOf('} else {'), failure.indexOf('} finally {'));
  assert.doesNotMatch(ordinaryFailure, /bookCatalogReviewTarget\s*=\s*null|closeModal\(\)/);
  assert.match(approve.slice(approve.indexOf('finally')), /bookCatalogReviewSubmitting\s*=\s*false/);
});
