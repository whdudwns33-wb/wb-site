const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function feedbackSortHelpers() {
  const start = source.indexOf('function feedbackUpdatedAt(');
  const end = source.indexOf('function feedbackStoredMessageHtml(', start);
  assert.ok(start >= 0 && end > start, 'feedback sort helper block exists');
  return Function(source.slice(start, end) +
    '\nreturn { feedbackSortRows, feedbackTeacherGroups };')();
}

test('선생님 피드백 상태는 최신 저장 순으로 정렬한다', () => {
  const { feedbackSortRows } = feedbackSortHelpers();
  const rows = [
    { requestKey: 'old', status: 'sent', updatedAt: 10 },
    { requestKey: 'new', status: 'approval_waiting', updatedAt: 30 },
    { requestKey: 'middle', status: 'content_approved_send_blocked', updatedAt: 20 }
  ];
  assert.deepEqual(feedbackSortRows(rows, false).map(item => item.requestKey), ['new', 'middle', 'old']);
  assert.deepEqual(rows.map(item => item.requestKey), ['old', 'new', 'middle'], '원본 서버 배열은 변경하지 않는다');
});

test('관리자 피드백은 선생님별로 묶고 미전송을 최신순 상단에 둔다', () => {
  const { feedbackTeacherGroups } = feedbackSortHelpers();
  const rows = [
    { requestKey: 'a-sent', owner: 'a', status: 'sent', updatedAt: 50 },
    { requestKey: 'a-old-unsent', owner: 'a', status: 'approval_waiting', updatedAt: 20 },
    { requestKey: 'a-new-unsent', owner: 'a', status: 'content_approved_send_blocked', updatedAt: 40 },
    { requestKey: 'b-sent', owner: 'b', status: 'sent', updatedAt: 90 },
    { requestKey: 'c-unsent', owner: 'c', status: 'revision_requested', updatedAt: 30 }
  ];
  const groups = feedbackTeacherGroups(rows);
  assert.deepEqual(groups.map(group => group.owner), ['a', 'c', 'b']);
  assert.deepEqual(groups[0].rows.map(item => item.requestKey), ['a-new-unsent', 'a-old-unsent', 'a-sent']);
  assert.equal(groups[0].unsentCount, 2);
});

test('저장된 최종 메시지를 재구성하지 않고 줄바꿈과 함께 안전하게 표시한다', () => {
  const start = source.indexOf('function feedbackStoredMessageHtml(');
  const end = source.indexOf('function feedbackReasonHtml(', start);
  assert.ok(start >= 0 && end > start, 'stored message renderer exists');
  const esc = value => String(value).replace(/[&<>"']/g, character =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const renderStoredMessage = new Function('esc', source.slice(start, end) +
    '\nreturn feedbackStoredMessageHtml;')(esc);
  const rendered = renderStoredMessage({ message: '첫 줄 <확인>\n둘째 줄' });
  assert.match(rendered, /첫 줄 &lt;확인&gt;\n둘째 줄/);
  assert.match(source, /\.feedback-message-text[\s\S]{0,400}white-space: pre-wrap/);
});

test('선생님과 관리자 상태 카드는 저장 메시지를 접기·펼치기로 보여준다', () => {
  const ownStart = source.indexOf('function ownFeedbackCard(');
  const ownEnd = source.indexOf('function viewOwnFeedbackRequests(', ownStart);
  const adminStart = source.indexOf('function feedbackQueueCard(');
  const adminEnd = source.indexOf('function feedbackTeacherGroupHtml(', adminStart);
  const ownCard = source.slice(ownStart, ownEnd);
  const adminCard = source.slice(adminStart, adminEnd);
  assert.match(ownCard, /<details class="card feedback-record"/);
  assert.match(ownCard, /data-persist-key="feedback-own\|/);
  assert.match(ownCard, /feedbackStoredMessageHtml\(item\)/);
  assert.doesNotMatch(ownCard, /item\.(contentText|plusText|minusText)/);
  assert.match(adminCard, /<details class="card feedback-record"/);
  assert.match(adminCard, /data-persist-key="feedback-admin\|/);
  assert.match(adminCard, /feedbackStoredMessageHtml\(item\)/);
  assert.doesNotMatch(adminCard, /item\.(contentText|plusText|minusText)/);
});

test('관리자 현황은 선생님별 details 그룹을 사용한다', () => {
  const groupStart = source.indexOf('function feedbackTeacherGroupHtml(');
  const groupEnd = source.indexOf('function viewFeedbackReview(', groupStart);
  const viewStart = groupEnd;
  const viewEnd = source.indexOf('/* ── 수업 정보 변경 요청', viewStart);
  const group = source.slice(groupStart, groupEnd);
  const view = source.slice(viewStart, viewEnd);
  assert.match(group, /<details class="card feedback-teacher-group"/);
  assert.match(group, /data-persist-key="feedback-teacher\|/);
  assert.match(group, /미전송/);
  assert.match(view, /feedbackTeacherGroups\(visibleQueue\)\.map\(feedbackTeacherGroupHtml\)/);
});

test('발송 대기 카드의 재접수 버튼은 항상 보이고 실패 사유가 버튼 아래에 나온다', () => {
  const start = source.indexOf('function feedbackQueueCard(');
  const end = source.indexOf('function feedbackTeacherGroupHtml(', start);
  const card = source.slice(start, end);
  assert.match(card, /item\.status === 'content_approved_send_blocked'[\s\S]{0,260}data-act="fbsend"/);
  assert.doesNotMatch(card, /sendState\.retry|disabled/);
  assert.ok(card.indexOf('다시 솔라피 발송 접수') < card.indexOf('feedbackReasonHtml(item, false)'),
    '실패 사유 영역은 재접수 버튼 아래에 있어야 한다');
  assert.match(source, /id="fbSendResult-/);
});

test('접수 성공 상태는 전달 완료가 아닌 솔라피 발송 접수로 표시한다', () => {
  const start = source.indexOf('const FEEDBACK_STATUS_LABEL =');
  const end = source.indexOf('function feedbackSendState(', start);
  const labels = source.slice(start, end);
  assert.match(labels, /sent: \['솔라피 발송 접수'/);
  assert.doesNotMatch(labels, /전달완료|전달 완료|발송 완료/);
});
