const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function feedbackSortHelpers(state = { tasks: [] }) {
  const start = source.indexOf('const FEEDBACK_WEEKDAYS');
  const end = source.indexOf('function feedbackStoredMessageHtml(', start);
  assert.ok(start >= 0 && end > start, 'feedback sort helper block exists');
  const parseYmd = value => {
    const [year, month, day] = String(value || '').split('-').map(Number);
    return new Date(year, month - 1, day);
  };
  const ymd = value => [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'),
    String(value.getDate()).padStart(2, '0')].join('-');
  return Function('state', 'parseYmd', 'ymd', source.slice(start, end) +
    '\nreturn { FEEDBACK_WEEKDAYS, feedbackWeekdayKey, feedbackWeekdaySummary, feedbackFilterByWeekday, ' +
    'feedbackLessonStartMinutes, feedbackSortRows, feedbackTeacherGroups };')(state, parseYmd, ymd);
}

function feedbackStatusHelpers() {
  const start = source.indexOf('const FEEDBACK_STATUS_LABEL =');
  const end = source.indexOf('function feedbackWeekdayKey(', start);
  assert.ok(start >= 0 && end > start, 'feedback status helper block exists');
  return Function(source.slice(start, end) + '\nreturn { feedbackSendState, feedbackIsUnsent };')();
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

test('관리자 피드백은 월요일부터 일요일까지 발송·미발송을 따로 집계한다', () => {
  const { FEEDBACK_WEEKDAYS, feedbackWeekdayKey, feedbackWeekdaySummary } = feedbackSortHelpers();
  assert.deepEqual(FEEDBACK_WEEKDAYS.map(day => day.label),
    ['월요일', '화요일', '수요일', '목요일', '금요일', '토요일', '일요일']);
  const rows = [
    { requestKey: 'mon-sent', feedbackDate: '2026-09-07', status: 'sent' },
    { requestKey: 'mon-unsent', feedbackDate: '2026-09-07', status: 'approval_waiting' },
    { requestKey: 'mon-cancelled', feedbackDate: '2026-09-07', status: 'cancelled' },
    { requestKey: 'tue-sent', feedbackDate: '2026-09-08', status: 'sent' },
    { requestKey: 'sun-unsent', feedbackDate: '2026-09-13', status: 'content_approved_send_blocked' },
    { requestKey: 'invalid-date', feedbackDate: '날짜 없음', status: 'approval_waiting' }
  ];
  const summary = feedbackWeekdaySummary(rows);
  assert.equal(summary.length, 7);
  assert.deepEqual(summary.map(day => day.label),
    ['월요일', '화요일', '수요일', '목요일', '금요일', '토요일', '일요일']);
  const monday = summary.find(day => day.key === feedbackWeekdayKey('2026-09-07'));
  const tuesday = summary.find(day => day.key === feedbackWeekdayKey('2026-09-08'));
  const sunday = summary.find(day => day.key === feedbackWeekdayKey('2026-09-13'));
  assert.deepEqual(
    { sentCount: monday.sentCount, unsentCount: monday.unsentCount, totalCount: monday.totalCount },
    { sentCount: 1, unsentCount: 1, totalCount: 2 },
    '취소된 요청은 요일 집계에 포함하지 않는다'
  );
  assert.deepEqual(
    { sentCount: tuesday.sentCount, unsentCount: tuesday.unsentCount, totalCount: tuesday.totalCount },
    { sentCount: 1, unsentCount: 0, totalCount: 1 }
  );
  assert.deepEqual(
    { sentCount: sunday.sentCount, unsentCount: sunday.unsentCount, totalCount: sunday.totalCount },
    { sentCount: 0, unsentCount: 1, totalCount: 1 }
  );
  assert.equal(feedbackWeekdayKey('잘못된 날짜'), '', '유효하지 않은 날짜를 임의 요일에 넣으면 안 된다');
});

test('선택한 요일만 표시하며 필터는 서버 원본 배열을 변경하지 않는다', () => {
  const { feedbackWeekdayKey, feedbackFilterByWeekday } = feedbackSortHelpers();
  const rows = [
    { requestKey: 'mon-a', feedbackDate: '2026-09-07', status: 'sent' },
    { requestKey: 'tue', feedbackDate: '2026-09-08', status: 'sent' },
    { requestKey: 'mon-b', feedbackDate: '2026-09-14', status: 'approval_waiting' },
    { requestKey: 'sun', feedbackDate: '2026-09-13', status: 'sent' }
  ];
  const originalOrder = rows.map(item => item.requestKey);
  const mondayKey = feedbackWeekdayKey('2026-09-07');
  assert.deepEqual(feedbackFilterByWeekday(rows, mondayKey).map(item => item.requestKey), ['mon-a', 'mon-b']);
  assert.deepEqual(feedbackFilterByWeekday(rows, ''), [], '요일을 고르기 전에는 특정 요일 목록을 만들지 않는다');
  assert.deepEqual(rows.map(item => item.requestKey), originalOrder);
});

test('피드백 수업 시작시간은 해당 수업일에 유효한 슬롯의 가장 이른 시각을 사용한다', () => {
  const { feedbackLessonStartMinutes } = feedbackSortHelpers();
  const mondayFeedback = { feedbackDate: '2026-09-07' };
  const scheduledTask = {
    time: '16:40',
    scheduleSlots: [
      { days: [1], startTime: '07:30', validTo: '2026-09-06' },
      { days: [1], startTime: '10:30', validFrom: '2026-09-01', validTo: '2026-09-30' },
      { days: [1], startTime: '09:15', validFrom: '2026-09-07' },
      { days: [2], startTime: '08:00' }
    ]
  };
  assert.equal(feedbackLessonStartMinutes(mondayFeedback, scheduledTask), 9 * 60 + 15);
  assert.equal(feedbackLessonStartMinutes(mondayFeedback, { time: '14:05', scheduleSlots: [] }), 14 * 60 + 5,
    '해당 날짜 슬롯이 없으면 구형 task.time을 사용한다');
  assert.equal(feedbackLessonStartMinutes(mondayFeedback, {
    time: '14:05', scheduleSlots: [{ days: [2], startTime: '14:05' }]
  }), Number.POSITIVE_INFINITY, '구조화 시간표가 다른 요일만 가리키면 구형 시간으로 추측하지 않는다');
  assert.equal(feedbackLessonStartMinutes(mondayFeedback, {}), Number.POSITIVE_INFINITY,
    '시간이 없는 수업은 정렬의 맨 뒤로 보낸다');
});

test('관리자 피드백은 선생님별로 묶고 내부에서 미발송 우선·수업 시작시간 오름차순으로 정렬한다', () => {
  const state = { tasks: [
    { id: 'a-sent', scheduleSlots: [{ days: [1], startTime: '08:30' }] },
    { id: 'a-old-unsent', scheduleSlots: [{ days: [1], startTime: '18:20' }] },
    { id: 'a-new-unsent', scheduleSlots: [{ days: [1], startTime: '10:10' }] },
    { id: 'b-sent', scheduleSlots: [{ days: [1], startTime: '09:00' }] },
    { id: 'c-unsent', scheduleSlots: [{ days: [1], startTime: '11:00' }] }
  ] };
  const { feedbackSortRows, feedbackTeacherGroups } = feedbackSortHelpers(state);
  const rows = [
    { requestKey: 'a-sent', taskId: 'a-sent', feedbackDate: '2026-09-07', owner: 'a', status: 'sent', updatedAt: 50 },
    { requestKey: 'a-old-unsent', taskId: 'a-old-unsent', feedbackDate: '2026-09-07', owner: 'a', status: 'approval_waiting', updatedAt: 40 },
    { requestKey: 'a-new-unsent', taskId: 'a-new-unsent', feedbackDate: '2026-09-07', owner: 'a', status: 'content_approved_send_blocked', updatedAt: 20 },
    { requestKey: 'b-sent', taskId: 'b-sent', feedbackDate: '2026-09-07', owner: 'b', status: 'sent', updatedAt: 90 },
    { requestKey: 'c-unsent', taskId: 'c-unsent', feedbackDate: '2026-09-07', owner: 'c', status: 'revision_requested', updatedAt: 30 }
  ];
  assert.deepEqual(feedbackSortRows(rows.slice(0, 3), true, true).map(item => item.requestKey),
    ['a-new-unsent', 'a-old-unsent', 'a-sent']);
  const groups = feedbackTeacherGroups(rows, true);
  assert.deepEqual(groups.map(group => group.owner), ['a', 'c', 'b']);
  assert.deepEqual(groups[0].rows.map(item => item.requestKey), ['a-new-unsent', 'a-old-unsent', 'a-sent'],
    '더 최근에 갱신된 18:20 건보다 10:10 수업을 먼저 표시해야 한다');
  assert.equal(groups[0].unsentCount, 2);
});

test('저장된 최종 메시지를 재구성하지 않고 줄바꿈과 함께 안전하게 표시한다', () => {
  const start = source.indexOf('const FEEDBACK_STATUS_LABEL =');
  const end = source.indexOf('function feedbackReasonHtml(', start);
  assert.ok(start >= 0 && end > start, 'stored message renderer exists');
  const esc = value => String(value).replace(/[&<>"']/g, character =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const renderStoredMessage = new Function('esc', source.slice(start, end) +
    '\nreturn feedbackStoredMessageHtml;')(esc);
  const rendered = renderStoredMessage({
    status: 'sent', messageDeliveryState: 'delivered', message: '첫 줄 <확인>\n둘째 줄'
  });
  assert.match(rendered, /첫 줄 &lt;확인&gt;\n둘째 줄/);
  assert.match(rendered, /수신 완료/);
  const pending = renderStoredMessage({
    status: 'sent', messageDeliveryState: 'provider_queued', message: '아직 처리 중'
  });
  assert.doesNotMatch(pending, /수신 완료/, '공급자 접수만 된 메시지를 학부모 수신 완료로 표시하면 안 된다');
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

test('관리자 현황은 요일 선택과 집계를 보여주고 선택 요일의 선생님 그룹만 만든다', () => {
  const groupStart = source.indexOf('function feedbackTeacherGroupHtml(');
  const groupEnd = source.indexOf('function viewFeedbackReview(', groupStart);
  const viewStart = groupEnd;
  const viewEnd = source.indexOf('/* ── 수업 정보 변경 요청', viewStart);
  const group = source.slice(groupStart, groupEnd);
  const view = source.slice(viewStart, viewEnd);
  assert.match(group, /<details class="card feedback-teacher-group"/);
  assert.match(group, /data-persist-key="feedback-teacher\|/);
  assert.doesNotMatch(group, /<details[^>]*\sopen(?:\s|>)/,
    '선생님 details는 관리자가 직접 열기 전에는 접힌 상태여야 한다');
  assert.match(group, /미발송/);
  assert.match(source, /let feedbackWeekdayFilter = ''/);
  assert.match(view, /feedbackWeekdaySummary\(visibleQueue\)/);
  assert.match(source, /function feedbackWeekdaySummary[\s\S]{0,300}FEEDBACK_WEEKDAYS\.map/);
  assert.match(source, /data-act="feedbackweekday"/);
  assert.match(view, /sentCount/);
  assert.match(view, /unsentCount/);
  assert.match(view, /feedbackFilterByWeekday\(visibleQueue, feedbackWeekdayFilter\)/);
  assert.match(group, /function feedbackTeacherGroupHtml\(group,\s*[A-Za-z_$][\w$]*\)/);
  assert.match(view, /feedbackTeacherGroups\(/);
  assert.match(view, /feedbackTeacherGroupHtml\(group, feedbackWeekdayFilter\)/);
});

test('요일 버튼 클릭은 선택 요일을 바꾸고 관리자 피드백 화면을 다시 그린다', () => {
  const start = source.indexOf("case 'feedbackweekday':");
  const end = source.indexOf("case '", start + 10);
  assert.ok(start >= 0 && end > start, 'feedbackweekday click case exists');
  const handler = source.slice(start, end);
  assert.match(handler, /feedbackWeekdayFilter\s*=/);
  assert.match(handler, /el\.dataset\.(?:day|weekday)/);
  assert.match(handler, /FEEDBACK_WEEKDAYS/,
    'DOM에서 받은 임의 값을 그대로 쓰지 말고 허용된 월~일 key인지 확인해야 한다');
  assert.match(handler, /render\(\)/);
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

test('피드백 상태는 원시 코드 대신 서로 다른 안전한 한글 상태로 표시한다', () => {
  const start = source.indexOf('const FEEDBACK_STATUS_LABEL =');
  const end = source.indexOf('function feedbackUpdatedAt(', start);
  const labels = source.slice(start, end);
  const { feedbackSendState } = feedbackStatusHelpers();
  const labelFor = state => feedbackSendState({ status: 'sent', messageDeliveryState: state }).label[0];
  const safeLabels = {
    provider_queued: labelFor('provider_queued'),
    carrier_processing: labelFor('carrier_processing'),
    delivered: labelFor('delivered'),
    failed: labelFor('failed'),
    unknown: labelFor('unknown')
  };
  assert.match(safeLabels.provider_queued, /접수|대기/);
  assert.match(safeLabels.carrier_processing, /통신사|전달 중/);
  assert.match(safeLabels.delivered, /수신 완료/);
  assert.match(safeLabels.failed, /실패|거절/);
  assert.match(safeLabels.unknown, /확인 필요|알 수 없음/);
  assert.equal(new Set(Object.values(safeLabels)).size, 5, '진행·완료·실패 상태를 같은 문구로 합치면 안 된다');
  assert.doesNotMatch(labels, /\b(?:2000|3000|4000)\b/);
  assert.doesNotMatch(labels, /provider(?:Message|Group|Status)Id|providerStatusCode/i);
});

test('기존 접수 성공도 전달 상태가 없으면 수신 완료라고 추측하지 않는다', () => {
  const { feedbackSendState } = feedbackStatusHelpers();
  const legacy = feedbackSendState({ status: 'sent' }).label[0];
  assert.match(legacy, /접수/);
  assert.doesNotMatch(legacy, /수신 완료/);
});

test('수신 완료 전달 상태는 뒤늦은 요청 실패 상태보다 우선하여 완료로 집계한다', () => {
  const { feedbackSendState, feedbackIsUnsent } = feedbackStatusHelpers();
  for (const requestStatus of ['content_approved_send_blocked', 'revision_requested']) {
    const item = { status: requestStatus, messageDeliveryState: 'delivered' };
    assert.match(feedbackSendState(item).label[0], /수신 완료/);
    assert.equal(feedbackIsUnsent(item), false,
      'API가 확정한 delivered를 요청 행의 더 최신 실패 상태 때문에 미발송으로 되돌리면 안 된다');
  }
});
