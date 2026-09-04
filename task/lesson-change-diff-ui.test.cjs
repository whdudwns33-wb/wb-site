const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function diffHtml(task, changes) {
  const start = source.indexOf('function lessonChangeDiffHtml(');
  const end = source.indexOf('function ownLessonChangeCard(', start);
  const factory = new Function('DOW', 'LESSON_CHANGE_REPEAT_LABEL', 'daysForDisplay', 'esc',
    source.slice(start, end) + '\nreturn lessonChangeDiffHtml;');
  const esc = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const daysForDisplay = days => (days || []).slice().sort((left, right) => ({ 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 0: 6 })[left] - ({ 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 0: 6 })[right]);
  return factory(['일', '월', '화', '수', '목', '금', '토'], { weekly: '매주' }, daysForDisplay, esc)(task, changes);
}

test('관리자 수업 변경 검토는 요청된 항목만 변경 전과 변경 후로 나란히 표시한다', () => {
  const html = diffHtml(
    { days: [1, 3], time: '16:00', repeat: 'weekly', detail: '기존 진도', guide: '기존 메모' },
    { days: [2, 4], time: '17:00', detail: '새 진도 <확인>' }
  );
  assert.match(html, /요일[\s\S]*변경 전[\s\S]*월·수[\s\S]*변경 후[\s\S]*화·목/);
  assert.match(html, /시간[\s\S]*16:00[\s\S]*17:00/);
  assert.match(html, /교재·진도[\s\S]*기존 진도[\s\S]*새 진도 &lt;확인&gt;/);
  assert.doesNotMatch(html, /수업 메모/);
});

test('변경 전후 값이 같은 요청 항목은 검토 내용에서 숨긴다', () => {
  const html = diffHtml(
    { days: [1, 3], time: '16:00', repeat: 'weekly', detail: '기존 진도', guide: '' },
    { days: [1, 3], time: '17:00', repeat: 'weekly', detail: '기존 진도', guide: '' }
  );
  assert.match(html, /시간[\s\S]*16:00[\s\S]*17:00/);
  assert.doesNotMatch(html, /요일|반복|교재·진도|수업 메모/);
});

test('관리자 변경 요청 카드는 문장 요약 대신 전후 비교 표를 사용한다', () => {
  const start = source.indexOf('function lessonChangeQueueCard(');
  const end = source.indexOf('function viewLessonChangeReview(', start);
  const card = source.slice(start, end);
  assert.match(card, /lessonChangeDiffHtml\(task, item\.changes\)/);
  assert.doesNotMatch(card, /lessonChangeSummary\(item\.changes\)/);
  assert.match(source, /\.lesson-change-after \{ border-color: #B9E3C7; background: #F3FCF6; \}/);
});

test('관리자 변경 검토는 수업 등록 및 변경 탭에 있고 승인 완료 기록은 기본 목록에서 숨긴다', () => {
  const lessonView = source.slice(source.indexOf('function viewLessonEntry()'), source.indexOf('function lessonInputPayload('));
  const feedbackView = source.slice(source.indexOf('function viewFeedbackReview()'), source.indexOf('/* ── 수업 정보 변경 요청'));
  const reviewView = source.slice(source.indexOf('function viewLessonChangeReview()'), source.indexOf('/* ── 변경 요청 작성 모달'));
  const card = source.slice(source.indexOf('function lessonChangeQueueCard('), source.indexOf('function viewLessonChangeReview('));
  assert.match(source, /\['lesson', '수업 등록 및 변경'\]/);
  assert.match(lessonView, /const registration =[\s\S]{0,700}lessonAssignmentReviewHtml\(\)/);
  assert.match(lessonView, /const existingChange =[\s\S]{0,1000}viewLessonChangeReview\(\)/);
  assert.doesNotMatch(feedbackView, /viewLessonChangeReview\(\)/);
  assert.match(reviewView, /lessonChangeQueue\.filter\(item => item\.status !== 'approved'\)/);
  assert.match(card, /<b>요청 사유<\/b><br>/);
});

test('취소된 피드백은 선생님 활성 목록에서 숨기고 관리자 날짜 현황에서는 현재 수업을 미발송으로 복원한다', () => {
  const ownFeedbackView = source.slice(source.indexOf('function viewOwnFeedbackRequests()'), source.indexOf('function feedbackQueueCard('));
  const feedbackView = source.slice(source.indexOf('function viewFeedbackReview()'), source.indexOf('/* ── 수업 정보 변경 요청'));
  const occurrences = source.slice(source.indexOf('function feedbackDateOccurrences('), source.indexOf('function feedbackDateTeacherGroups('));
  assert.match(ownFeedbackView, /ownFeedbackQueue\.filter\(item => item\.status !== 'cancelled'\)/);
  assert.match(ownFeedbackView, /feedbackSortRows\(visibleOwnQueue, false\)\.map\(ownFeedbackCard\)/);
  assert.match(feedbackView, /feedbackDateTeacherGroups\(feedbackDateFilter,\s*visibleQueue\)/);
  assert.match(occurrences, /feedbackDeliveryCategory\(item\) === 'excluded'/,
    '취소 기록 자체는 관리자 날짜 현황의 별도 피드백 행으로 표시하지 않는다');
  assert.match(occurrences, /status:\s*'not_started'/,
    '현재 수업이 남아 있으면 취소 기록 대신 다시 미발송 대상으로 표시한다');
});

test('승인된 담당자 변경·휴원·퇴원·수업삭제는 기존 선생님 로컬 수업에서 제거한다', () => {
  const start = source.indexOf('function reconcileOwnLessonChangeTasks(');
  const end = source.indexOf('/** 승인 대기 중인 제안 내용을', start);
  assert.ok(start >= 0 && end > start);
  const state = { tasks: [{ id: 'lesson-a' }, { id: 'lesson-b' }] };
  let saved = 0;
  const reconcile = new Function('session', 'state', 'save', source.slice(start, end) + '\nreturn reconcileOwnLessonChangeTasks;')(
    { isStaffLink: true, isAdmin: false }, state, () => { saved += 1; }
  );
  assert.equal(reconcile([{ status: 'approved', taskId: 'lesson-a', changes: { operation: 'teacher_assignment' } }]), true);
  assert.deepEqual(state.tasks.map(task => task.id), ['lesson-b']);
  assert.equal(saved, 1);
  assert.match(source, /now\(\) - Number\(ownLessonChangeLastLoadedAt \|\| 0\) >= 30000/);
  assert.match(source, /await loadOwnLessonChangeQueue\(true\)/);
});
