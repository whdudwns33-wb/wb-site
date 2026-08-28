const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function block(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0, `${from} 시작 지점이 있어야 한다`);
  assert.ok(end > start, `${to} 종료 지점이 있어야 한다`);
  return source.slice(start, end);
}

function functionBlock(name) {
  const pattern = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = pattern.exec(source);
  assert.ok(match, `${name} 함수가 있어야 한다`);
  const start = match.index;
  const tail = source.slice(start + match[0].length);
  const next = /\n(?:async\s+)?function\s+[A-Za-z0-9_$]+\s*\(/.exec(tail);
  return source.slice(start, next ? start + match[0].length + next.index : source.length);
}

test('교사 오늘 화면은 관리자 요청과 선생님 요청을 주말 등하원 바로 위에 중앙 배치한다', () => {
  const today = block('function viewToday()', 'function taskRow');
  const panel = block('function taskPanel(t, date, c, editable)', '/** 수업 출결 표시용 */');

  assert.match(today, /session\.isStaffLink && !session\.isAdmin && me\.id === session\.staffId && cursor === today\(\)/);
  const receivedAt = today.indexOf('teacherReceivedAdminDirectiveHtml(me.id)');
  const composerAt = today.indexOf('teacherLiveRequestComposerHtml(me, cursor)');
  const weekendAt = today.indexOf('weekendVisitTeacherHtml(me, cursor)');
  assert.ok(receivedAt >= 0 && receivedAt < composerAt && composerAt < weekendAt,
    '관리자 요청 → 선생님 요청 → 주말 실제 등하원 순서여야 한다');
  assert.doesNotMatch(today, /teacherLiveRequestManagerHtml|adminDirectiveManagerHtml/);
  assert.doesNotMatch(panel, /teacherLiveRequestOpen|실시간 선생님 요청/);
});

test('중앙 선생님 요청은 접힌 화면 안에서 오늘 수업·본문·관리자 한 명·전송을 제공한다', () => {
  const editor = functionBlock('teacherLiveRequestComposerHtml');

  assert.match(editor, /session\.isAdmin/);
  assert.match(editor, /<details/);
  assert.match(editor, /data-persist-key="today-teacher-live-request/);
  assert.match(editor, /data-teacher-live-request-lesson/);
  assert.match(editor, /data-teacher-live-request-body/);
  assert.match(editor, /<textarea[^>]*maxlength=/);
  assert.match(editor, /data-teacher-live-request-recipient/);
  assert.match(editor, /<select/);
  assert.match(editor, /(?:수신[^<]*관리자|관리자[^<]*수신)/);
  assert.match(editor, /data-act="teacherLiveRequestSend"/);
  assert.ok(
    editor.indexOf('data-teacher-live-request-recipient') < editor.indexOf('data-act="teacherLiveRequestSend"'),
    '수신자 선택 뒤 전송 버튼이 배치되어야 한다'
  );
  assert.doesNotMatch(editor, /modal\(/);
});

test('중앙 요청 후보는 인증된 선생님의 오늘 구조화 수업 stable taskId만 사용한다', () => {
  const lessons = functionBlock('teacherLiveRequestTodayLessons');
  const label = functionBlock('teacherLiveRequestLessonLabel');

  assert.match(lessons, /tasksFor\(staffId, today\(\)\)/);
  assert.match(lessons, /isSessionLessonTask\(task\)/);
  assert.match(lessons, /task\.staffId/);
  assert.doesNotMatch(lessons, /currentStaff\(|viewStaff|isLesson\(/);
  assert.match(lessons, /session\.isAdmin/);
  assert.match(label, /student/);
  assert.match(label, /subject/);
  assert.match(label, /schedule/);
});

test('관리자 수신자 후보는 서버 정본에서 불러오며 일반 직원 목록으로 추측하지 않는다', () => {
  const loader = functionBlock('loadTeacherLiveRequestRecipients');

  assert.match(loader, /sync\.post\('\/teacher-live-request'/);
  assert.match(loader, /action:\s*'recipients'/);
  assert.match(loader, /result\.recipientAdminIds/);
  assert.doesNotMatch(loader, /liveStaff\(\)|teamStaff\(\)|staffById\([^)]*manager/i);
});

test('전송은 재시도 requestId와 stable taskId·오늘 날짜·서버 발급 대상 ID만 보낸다', () => {
  const submit = functionBlock('submitTeacherLiveRequest');

  assert.match(submit, /sync\.post\('\/teacher-live-request'/);
  assert.match(submit, /action:\s*'send'/);
  assert.match(submit, /requestId:/);
  assert.match(submit, /lessonTaskId:/);
  assert.match(submit, /lessonDate:/);
  assert.match(submit, /recipientAdminId:/);
  assert.match(submit, /body:/);
  assert.match(submit, /teacherLiveRequestDraft\.requestId/);
  assert.match(submit, /teacherLiveRequestTodayLessons\(\)/);
  assert.match(submit, /lessonDate:\s*today\(\)/);
  assert.match(submit, /if\s*\(![^)]*recipient/);
  assert.match(submit, /if\s*\(![^)]*(?:message|body|content)/);
  assert.doesNotMatch(submit, /senderId\s*:|teacherId\s*:|studentId\s*:|studentName\s*:|teacherName\s*:|audience(?:Ids|ManagerIds|StaffIds)?\s*:/);
});

test('모든 관리자는 지정 수신자와 무관하게 같은 미확인 요청을 팝업으로 받는다', () => {
  const loader = functionBlock('loadTeacherLiveRequests');
  const popup = functionBlock('showPendingTeacherLiveRequestPopup');

  assert.match(loader, /session\.isAdmin/);
  assert.match(loader, /action:\s*'list'/);
  assert.match(popup, /!row\.acknowledgedAt/);
  assert.match(popup, /!sessionStorage\.getItem\(key\)/);
  assert.doesNotMatch(popup, /item\.recipientAdminId\s*===|recipientAdminId\s*===\s*(?:session|auth)|includes\([^)]*recipientAdminId/);
  assert.match(popup, /modal\('실시간 선생님 요청'/);
  assert.match(popup, /sessionStorage/);
  assert.match(popup, /requestId/);
  assert.match(popup, /action:\s*'opened'/);
  assert.match(popup, /data-act="teacherLiveRequestAck"/);
  assert.match(popup, /확인했습니다/);
  assert.match(popup, /play(?:TeacherLiveRequest|AdminDirective)Sound\(\)/);
});

test('요청 카드는 사용자 입력과 학생·수업 문맥을 escape하고 지정 수신자를 표시한다', () => {
  const card = functionBlock('teacherLiveRequestCardHtml');

  assert.match(card, /지정 수신자/);
  assert.match(card, /(?:모든|전체) 관리자/);
  assert.match(card, /esc\(row\.body\)/);
  assert.match(card, /esc\([^)]*(?:student|lesson|teacher|recipient)[^)]*\)/i);
  assert.match(card, /전송 일시/);
  assert.match(card, /liveRequestSentAtText\(row\.createdAt\)/);
  assert.doesNotMatch(card, /row\.lessonDate/);
  assert.doesNotMatch(card, /innerHTML\s*=\s*row\.(?:body|studentName|teacherName)/);
});

test('열어봄과 확인은 stable requestId로만 저장하고 관리자별 확인을 독립 처리한다', () => {
  const acknowledge = functionBlock('acknowledgeTeacherLiveRequest');

  assert.match(acknowledge, /sync\.post\('\/teacher-live-request'/);
  assert.match(acknowledge, /action:\s*'acknowledge'/);
  assert.match(acknowledge, /requestId:/);
  assert.doesNotMatch(acknowledge, /studentName\s*:|teacherName\s*:|recipientName\s*:|body\s*:/);
  assert.match(acknowledge, /loadTeacherLiveRequests\(true,\s*false\)/);
});

test('작성 draft는 재렌더링에도 유지하고 성공한 뒤에만 새 requestId로 초기화한다', () => {
  const submit = functionBlock('submitTeacherLiveRequest');
  const composer = functionBlock('teacherLiveRequestComposerHtml');
  const inputs = block("document.addEventListener('input'", "/* 수업 등록 폼은 시간대 버튼으로 다시 그려져도 입력값을 유지한다. */");

  assert.match(composer, /teacherLiveRequestDraft\.body/);
  assert.match(composer, /teacherLiveRequestDraft\.lessonTaskId/);
  assert.match(composer, /teacherLiveRequestDraft\.recipientAdminId/);
  assert.match(inputs, /teacherLiveRequestDraft\.body\s*=/);
  assert.match(inputs, /teacherLiveRequestDraft\.lessonTaskId\s*=/);
  assert.match(inputs, /teacherLiveRequestDraft\.recipientAdminId\s*=/);
  assert.match(submit, /lastAttemptPayloadKey/);
  assert.match(submit, /lastAttemptPayloadKey !== payloadKey[\s\S]*requestId = 'tlr_' \+ uid\(\)/);
  assert.ok(submit.indexOf("sync.post('/teacher-live-request'") < submit.indexOf('teacherLiveRequestDraft = emptyTeacherLiveRequestDraft'),
    '서버 전송 성공 경로 뒤에서만 draft를 초기화해야 한다');
});

test('요청 조회는 15초마다 갱신되고 클릭 라우팅은 중앙 전송과 확인을 연결한다', () => {
  const polling = block('setInterval(() => {', '/* ── 새 버전 감지 ──');
  const clicks = block("document.addEventListener('click'", "document.addEventListener('input'");

  assert.match(polling, /loadTeacherLiveRequests\(true,\s*true\)/);
  assert.match(polling, /},\s*15000\);/);
  for (const action of ['teacherLiveRequestSend', 'teacherLiveRequestAck']) {
    assert.match(clicks, new RegExp(`case '${action}'`));
  }
  assert.doesNotMatch(clicks, /case 'teacherLiveRequestOpen'/);
});

test('관리자 수업 등록 및 변경 화면의 요청 관리와 확인 이력은 기존 위치를 유지한다', () => {
  const lessonEntry = block('function viewLessonEntry()', 'function refreshLessonDirectEntry');
  assert.match(lessonEntry, /teacherLiveRequestManagerHtml\(\) \+ adminDirectiveManagerHtml\(\)/);
  assert.match(functionBlock('teacherLiveRequestManagerHtml'), /최근 확인한 요청/);
});
