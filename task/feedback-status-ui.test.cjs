const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function feedbackSortHelpers(state = { tasks: [] }, overrides = {}) {
  const start = source.indexOf('const FEEDBACK_WEEKDAYS');
  const end = source.indexOf('function feedbackStoredMessageHtml(', start);
  assert.ok(start >= 0 && end > start, 'feedback sort helper block exists');
  const parseYmd = value => {
    const [year, month, day] = String(value || '').split('-').map(Number);
    return new Date(year, month - 1, day);
  };
  const ymd = value => [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'),
    String(value.getDate()).padStart(2, '0')].join('-');
  const addDays = (value, amount) => {
    const parsed = parseYmd(value);
    parsed.setDate(parsed.getDate() + Number(amount || 0));
    return ymd(parsed);
  };
  const isLesson = overrides.isLesson || (task => !!task && !task.deleted && task.taskKind === 'lesson_instruction');
  const occursOn = overrides.occursOn || ((task, date) =>
    Array.isArray(task && task.occurrenceDates) && task.occurrenceDates.includes(date));
  const teacherTaskCardOccursOn = overrides.teacherTaskCardOccursOn || occursOn;
  const isBookOrderWorkTask = overrides.isBookOrderWorkTask || (() => false);
  return Function('state', 'parseYmd', 'ymd', 'addDays', 'isLesson', 'occursOn', 'teacherTaskCardOccursOn',
    'isBookOrderWorkTask', source.slice(start, end) +
    '\nreturn { FEEDBACK_WEEKDAYS, feedbackWeekdayKey, feedbackDateKey, feedbackShiftDate, ' +
    'feedbackFilterByDate, feedbackDateOccurrences, feedbackDateTeacherGroups, ' +
    'feedbackLessonStartMinutes, feedbackDeliveryCategory, feedbackDeliveryCounts, ' +
    'feedbackSortRows, feedbackTeacherGroups };')(
      state, parseYmd, ymd, addDays, isLesson, occursOn, teacherTaskCardOccursOn, isBookOrderWorkTask
    );
}

function feedbackStatusHelpers() {
  const start = source.indexOf('const FEEDBACK_STATUS_LABEL =');
  const end = source.indexOf('function feedbackWeekdayKey(', start);
  assert.ok(start >= 0 && end > start, 'feedback status helper block exists');
  return Function(source.slice(start, end) +
    '\nreturn { feedbackSendState, feedbackDeliveryCategory, feedbackDeliveryCounts, feedbackIsUnsent };')();
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

test('피드백 날짜 키와 이동은 정확한 날짜를 보존하고 월·연도 경계를 안전하게 넘긴다', () => {
  const { FEEDBACK_WEEKDAYS, feedbackWeekdayKey, feedbackDateKey, feedbackShiftDate,
    feedbackFilterByDate } = feedbackSortHelpers();
  assert.deepEqual(FEEDBACK_WEEKDAYS.map(day => day.label),
    ['월요일', '화요일', '수요일', '목요일', '금요일', '토요일', '일요일']);
  const rows = [
    { requestKey: 'first-monday', feedbackDate: '2026-09-07' },
    { requestKey: 'next-monday', feedbackDate: '2026-09-14' },
    { requestKey: 'tuesday', feedbackDate: '2026-09-08' },
    { requestKey: 'invalid', feedbackDate: '날짜 없음' }
  ];
  const originalOrder = rows.map(item => item.requestKey);
  assert.equal(feedbackDateKey('2026-09-07'), '2026-09-07');
  assert.equal(feedbackDateKey('2026-02-29'), '', '존재하지 않는 날짜를 자동 보정하면 안 된다');
  assert.equal(feedbackDateKey('2026-9-7'), '', '화면 날짜 키는 YYYY-MM-DD만 허용한다');
  assert.equal(feedbackDateKey('잘못된 날짜'), '');
  assert.equal(feedbackShiftDate('2026-09-30', 1), '2026-10-01');
  assert.equal(feedbackShiftDate('2026-01-01', -1), '2025-12-31');
  assert.equal(feedbackShiftDate('2026-02-28', 1), '2026-03-01');
  assert.equal(feedbackShiftDate('잘못된 날짜', 1), '', '잘못된 기준일을 오늘 등 다른 날짜로 추측하지 않는다');
  assert.deepEqual(feedbackFilterByDate(rows, '2026-09-07').map(item => item.requestKey), ['first-monday']);
  assert.deepEqual(feedbackFilterByDate(rows, '2026-09-14').map(item => item.requestKey), ['next-monday'],
    '같은 요일의 다른 주 피드백을 선택 날짜에 섞으면 안 된다');
  assert.deepEqual(feedbackFilterByDate(rows, ''), [], '날짜가 없으면 임의 날짜 목록을 만들지 않는다');
  assert.deepEqual(rows.map(item => item.requestKey), originalOrder);
  assert.equal(feedbackWeekdayKey('2026-09-07'), '1', '요일 키는 해당 날짜의 수업시간 슬롯 판정에 계속 사용한다');
});

test('선택 날짜의 수업 occurrence와 요청을 taskId 단위로 병합해 미발송까지 빠짐없이 만든다', () => {
  const date = '2026-09-07';
  const lesson = id => ({ id, staffId: 'teacher-a', studentId: 'student-' + id,
    taskKind: 'lesson_instruction', occurrenceDates: [date] });
  const state = { tasks: [
    lesson('delivered'), lesson('provider'), lesson('unknown'), lesson('failed'), lesson('no-request'),
    lesson('waiting'), lesson('revision'), lesson('blocked'), lesson('cancelled-only'),
    { ...lesson('other-date'), occurrenceDates: ['2026-09-14'] },
    { id: 'not-a-lesson', staffId: 'teacher-a', studentId: 'student-x', occurrenceDates: [date] },
    { ...lesson('deleted'), deleted: true }
  ] };
  const queue = [
    { requestKey: 'delivered-new', taskId: 'delivered', owner: 'teacher-a', feedbackDate: date,
      status: 'sent', messageDeliveryState: 'delivered', updatedAt: 10 },
    { requestKey: 'delivered-old-failure', taskId: 'delivered', owner: 'teacher-a', feedbackDate: date,
      status: 'content_approved_send_blocked', messageDeliveryState: 'failed', updatedAt: 20 },
    { requestKey: 'provider', taskId: 'provider', owner: 'teacher-a', feedbackDate: date,
      status: 'sent', messageDeliveryState: 'provider_queued' },
    { requestKey: 'unknown', taskId: 'unknown', owner: 'teacher-a', feedbackDate: date,
      status: 'sent', messageDeliveryState: 'unknown' },
    { requestKey: 'failed', taskId: 'failed', owner: 'teacher-a', feedbackDate: date,
      status: 'content_approved_send_blocked', messageDeliveryState: 'failed' },
    { requestKey: 'waiting', taskId: 'waiting', owner: 'teacher-a', feedbackDate: date,
      status: 'approval_waiting' },
    { requestKey: 'revision', taskId: 'revision', owner: 'teacher-a', feedbackDate: date,
      status: 'revision_requested' },
    { requestKey: 'blocked', taskId: 'blocked', owner: 'teacher-a', feedbackDate: date,
      status: 'content_approved_send_blocked', reviewNote: '연락처 등록 후 다시 시도해 주세요' },
    { requestKey: 'cancelled', taskId: 'cancelled-only', owner: 'teacher-a', feedbackDate: date,
      status: 'cancelled' },
    { requestKey: 'other-week', taskId: 'other-date', owner: 'teacher-a', feedbackDate: '2026-09-14',
      status: 'sent', messageDeliveryState: 'delivered' },
    { requestKey: 'orphan-delivered', taskId: 'missing-task', owner: 'teacher-b', feedbackDate: date,
      status: 'sent', messageDeliveryState: 'delivered' },
    { requestKey: 'orphan-duplicate', taskId: 'missing-task', owner: 'teacher-b', feedbackDate: date,
      status: 'approval_waiting' },
    { requestKey: 'orphan-cancelled', taskId: 'missing-cancelled', owner: 'teacher-b', feedbackDate: date,
      status: 'cancelled' }
  ];
  const { feedbackDateOccurrences, feedbackDateTeacherGroups, feedbackDeliveryCategory } =
    feedbackSortHelpers(state);
  const originalQueueOrder = queue.map(item => item.requestKey);
  const occurrences = feedbackDateOccurrences(date, queue);
  const byTask = new Map(occurrences.map(item => [item.taskId, item]));

  assert.equal(occurrences.length, 10, '선택일 수업 9건과 task가 사라진 보존 요청 1건을 각각 한 번만 센다');
  assert.equal(byTask.get('delivered').requestKey, 'delivered-new',
    '같은 수업일의 복수 요청은 실제 수신 완료를 더 최신 실패 행보다 우선한다');
  assert.equal(feedbackDeliveryCategory(byTask.get('provider')), 'pending');
  assert.equal(feedbackDeliveryCategory(byTask.get('unknown')), 'unknown');
  assert.equal(feedbackDeliveryCategory(byTask.get('failed')), 'failed');
  for (const taskId of ['no-request', 'waiting', 'revision', 'blocked', 'cancelled-only']) {
    assert.equal(feedbackDeliveryCategory(byTask.get(taskId)), 'unsent', `${taskId}는 실제 발송 시도가 없는 미발송이다`);
  }
  assert.equal(byTask.get('no-request').status, 'not_started', '요청 자체가 없는 대상은 합성 미발송 행으로 만든다');
  assert.equal(byTask.has('other-date'), false, '같은 요일의 다른 날짜를 섞지 않는다');
  assert.equal(byTask.has('not-a-lesson'), false);
  assert.equal(byTask.has('deleted'), false);
  assert.equal(byTask.has('missing-cancelled'), false, 'task도 없고 취소된 기록뿐이면 별도 occurrence를 만들지 않는다');

  const groups = feedbackDateTeacherGroups(date, queue);
  const teacherA = groups.find(group => group.owner === 'teacher-a');
  const teacherB = groups.find(group => group.owner === 'teacher-b');
  assert.ok(teacherA && teacherB);
  assert.deepEqual({
    total: teacherA.totalCount,
    delivered: teacherA.deliveredCount,
    inProgress: teacherA.pendingCount + teacherA.unknownCount,
    failed: teacherA.failedCount,
    unsent: teacherA.unsentCount
  }, { total: 9, delivered: 1, inProgress: 2, failed: 1, unsent: 5 });
  assert.equal(teacherA.totalCount,
    teacherA.deliveredCount + teacherA.pendingCount + teacherA.unknownCount +
      teacherA.failedCount + teacherA.unsentCount,
  '오늘 수업 학생 수는 네 가지 접힘 요약 상태의 합과 같아야 한다');
  assert.deepEqual({ total: teacherB.totalCount, delivered: teacherB.deliveredCount }, { total: 1, delivered: 1 });
  assert.deepEqual(queue.map(item => item.requestKey), originalQueueOrder, '병합하면서 서버 요청 배열을 변경하지 않는다');
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
    { requestKey: 'a-sent', taskId: 'a-sent', feedbackDate: '2026-09-07', owner: 'a', status: 'sent', messageDeliveryState: 'delivered', updatedAt: 50 },
    { requestKey: 'a-old-unsent', taskId: 'a-old-unsent', feedbackDate: '2026-09-07', owner: 'a', status: 'approval_waiting', updatedAt: 40 },
    { requestKey: 'a-new-unsent', taskId: 'a-new-unsent', feedbackDate: '2026-09-07', owner: 'a', status: 'content_approved_send_blocked', updatedAt: 20 },
    { requestKey: 'b-sent', taskId: 'b-sent', feedbackDate: '2026-09-07', owner: 'b', status: 'sent', messageDeliveryState: 'delivered', updatedAt: 90 },
    { requestKey: 'c-unsent', taskId: 'c-unsent', feedbackDate: '2026-09-07', owner: 'c', status: 'revision_requested', updatedAt: 30 }
  ];
  assert.deepEqual(feedbackSortRows(rows.slice(0, 3), true, true).map(item => item.requestKey),
    ['a-new-unsent', 'a-old-unsent', 'a-sent']);
  const groups = feedbackTeacherGroups(rows, true);
  assert.deepEqual(groups.map(group => group.owner), ['a', 'c', 'b']);
  assert.deepEqual(groups[0].rows.map(item => item.requestKey), ['a-new-unsent', 'a-old-unsent', 'a-sent'],
    '더 최근에 갱신된 18:20 건보다 10:10 수업을 먼저 표시해야 한다');
  assert.equal(groups[0].unsentCount, 2);
  assert.equal(groups[0].deliveredCount, 1);
});

test('관리자 피드백 정렬은 조치 필요 상태, 전달 확인 중, 수신 완료 순서다', () => {
  const { feedbackSortRows, feedbackTeacherGroups } = feedbackSortHelpers();
  const rows = [
    { requestKey: 'delivered', owner: 'teacher', status: 'sent', messageDeliveryState: 'delivered', updatedAt: 90 },
    { requestKey: 'pending', owner: 'teacher', status: 'sent', messageDeliveryState: 'provider_queued', updatedAt: 80 },
    { requestKey: 'unsent', owner: 'teacher', status: 'approval_waiting', updatedAt: 70 },
    { requestKey: 'unknown', owner: 'teacher', status: 'sent', messageDeliveryState: 'unknown', updatedAt: 60 },
    { requestKey: 'failed', owner: 'teacher', status: 'content_approved_send_blocked', messageDeliveryState: 'failed', updatedAt: 50 }
  ];
  assert.deepEqual(feedbackSortRows(rows, true, false).map(item => item.requestKey),
    ['failed', 'unknown', 'unsent', 'pending', 'delivered']);
  const [group] = feedbackTeacherGroups(rows, false);
  assert.deepEqual({
    deliveredCount: group.deliveredCount, pendingCount: group.pendingCount,
    unknownCount: group.unknownCount, failedCount: group.failedCount,
    unsentCount: group.unsentCount, totalCount: group.totalCount, attentionCount: group.attentionCount
  }, {
    deliveredCount: 1, pendingCount: 1, unknownCount: 1,
    failedCount: 1, unsentCount: 1, totalCount: 5, attentionCount: 3
  });
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
  assert.match(pending, /전달 확인 중/);
  assert.match(renderStoredMessage({
    status: 'sent', messageDeliveryState: 'unknown', message: '상태 확인'
  }), /상태 확인 필요/);
  assert.match(renderStoredMessage({
    status: 'content_approved_send_blocked', messageDeliveryState: 'failed', message: '발송 실패'
  }), /발송 실패/);
  assert.match(renderStoredMessage({
    status: 'approval_waiting', message: '아직 안 보냄'
  }), /미발송/);
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

test('관리자 현황은 선택 날짜의 선생님 그룹을 접어 두고 정확한 다섯 항목을 요약한다', () => {
  const groupStart = source.indexOf('function feedbackDeliveryCountsHtml(');
  const groupEnd = source.indexOf('function viewFeedbackReview(', groupStart);
  const viewStart = groupEnd;
  const viewEnd = source.indexOf('/* ── 수업 정보 변경 요청', viewStart);
  const group = source.slice(groupStart, groupEnd);
  const view = source.slice(viewStart, viewEnd);
  assert.match(group, /<details class="card feedback-teacher-group"/);
  assert.match(group, /data-persist-key="feedback-teacher\|/);
  assert.doesNotMatch(group, /<details[^>]*\sopen(?:\s|>)/,
    '선생님 details는 관리자가 직접 열기 전에는 접힌 상태여야 한다');
  for (const label of ['오늘 수업 학생', '수신완료', '발송중', '발송 실패', '미발송']) {
    assert.match(group, new RegExp(label));
  }
  assert.match(group, /totalCount/);
  assert.match(group, /deliveredCount/);
  assert.match(group, /pendingCount[\s\S]{0,100}unknownCount|unknownCount[\s\S]{0,100}pendingCount/,
    '접힌 요약의 발송중은 전달 확인 중과 상태 확인 필요를 한 항목으로 합친다');
  assert.match(group, /failedCount/);
  assert.match(group, /unsentCount/);
  assert.match(source, /let feedbackDateFilter\s*=\s*today\(\)/,
    '피드백 검토를 처음 열면 KST 오늘 날짜를 선택한다');
  assert.match(view, /feedbackDatePickerHtml\(/);
  assert.match(view, /feedbackDateTeacherGroups\(feedbackDateFilter,\s*visibleQueue\)/);
  assert.match(view, /feedbackTeacherGroupHtml\(group,\s*feedbackDateFilter\)/);
  assert.doesNotMatch(view, /feedbackWeekdayButtonsHtml|확인할 요일을 선택/,
    '날짜 대시보드에 예전 요일 단위 진입 화면을 함께 노출하지 않는다');
});

test('날짜 변경 컨트롤은 이전날·날짜 직접 선택·다음날·오늘 이동을 모두 제공한다', () => {
  const pickerStart = source.indexOf('function feedbackDatePickerHtml(');
  const pickerEnd = source.indexOf('function viewFeedbackReview(', pickerStart);
  assert.ok(pickerStart >= 0 && pickerEnd > pickerStart, 'feedback date picker exists');
  const picker = source.slice(pickerStart, pickerEnd);
  assert.match(picker, /type="date"/);
  assert.match(picker, /data-feedback-date/);
  assert.match(picker, /data-act="feedbackdateprev"/);
  assert.match(picker, /data-act="feedbackdatenext"/);
  assert.match(picker, /data-act="feedbackdatetoday"/);
  assert.match(picker, /이전/);
  assert.match(picker, /다음/);
  assert.match(picker, /오늘/);

  for (const action of ['feedbackdateprev', 'feedbackdatenext', 'feedbackdatetoday']) {
    const start = source.indexOf(`case '${action}':`);
    const end = source.indexOf("case '", start + 10);
    assert.ok(start >= 0 && end > start, `${action} click case exists`);
    const handler = source.slice(start, end);
    assert.match(handler, /feedbackDateFilter\s*=/);
    if (action === 'feedbackdatetoday') assert.match(handler, /today\(\)/);
    else assert.match(handler, /feedbackShiftDate\(/);
    assert.match(handler, /render\(\)/);
  }

  const changeStart = source.indexOf("document.addEventListener('change'");
  const changeEnd = source.indexOf("document.addEventListener('toggle'", changeStart);
  assert.ok(changeStart >= 0 && changeEnd > changeStart, 'delegated change handler exists');
  const change = source.slice(changeStart, changeEnd);
  assert.match(change, /\[data-feedback-date\]/);
  assert.match(change, /feedbackDateKey\(/,
    '날짜 input 값은 유효한 YYYY-MM-DD인지 검증한 뒤 상태에 반영한다');
  assert.match(change, /feedbackDateFilter\s*=/);
  assert.match(change, /render\(\)/);
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
  const { feedbackSendState, feedbackDeliveryCategory } = feedbackStatusHelpers();
  const legacy = feedbackSendState({ status: 'sent' }).label[0];
  assert.match(legacy, /접수/);
  assert.doesNotMatch(legacy, /수신 완료/);
  assert.equal(feedbackDeliveryCategory({ status: 'sent' }), 'pending');
});

test('피드백 분류는 미발송·전달 확인 중·상태 확인 필요·발송 실패·수신 완료를 섞지 않는다', () => {
  const { feedbackDeliveryCategory, feedbackIsUnsent } = feedbackStatusHelpers();
  const cases = [
    [{ status: 'sent', messageDeliveryState: 'delivered' }, 'delivered'],
    [{ status: 'sent', messageDeliveryState: 'provider_queued' }, 'pending'],
    [{ status: 'sent', messageDeliveryState: 'carrier_processing' }, 'pending'],
    [{ status: 'sent', messageDeliveryState: 'unknown' }, 'unknown'],
    [{ status: 'content_approved_send_blocked', messageDeliveryState: 'failed' }, 'failed'],
    [{ status: 'approval_waiting' }, 'unsent'],
    [{ status: 'cancelled', messageDeliveryState: 'delivered' }, 'excluded']
  ];
  for (const [item, expected] of cases) {
    assert.equal(feedbackDeliveryCategory(item), expected);
    assert.equal(feedbackIsUnsent(item), expected === 'unsent');
  }
  assert.equal(feedbackDeliveryCategory({
    status: 'content_approved_send_blocked', reviewNote: '접수 여부 확인 필요 — 확인 전 재발송 금지'
  }), 'unknown');
  assert.equal(feedbackDeliveryCategory({
    status: 'content_approved_send_blocked', reviewNote: '카카오 발송 결과가 실패로 확인되었습니다'
  }), 'failed');
});

test('수신 완료 전달 상태는 뒤늦은 요청 실패 상태보다 우선하여 완료로 집계한다', () => {
  const { feedbackSendState, feedbackDeliveryCategory, feedbackIsUnsent } = feedbackStatusHelpers();
  for (const requestStatus of ['content_approved_send_blocked', 'revision_requested']) {
    const item = { status: requestStatus, messageDeliveryState: 'delivered' };
    assert.match(feedbackSendState(item).label[0], /수신 완료/);
    assert.equal(feedbackDeliveryCategory(item), 'delivered');
    assert.equal(feedbackIsUnsent(item), false,
      'API가 확정한 delivered를 요청 행의 더 최신 실패 상태 때문에 미발송으로 되돌리면 안 된다');
  }
});
