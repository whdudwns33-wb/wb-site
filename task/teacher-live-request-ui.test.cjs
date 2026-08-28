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

test('오늘 수업의 각 수업 진행에는 담당 선생님용 실시간 요청 버튼이 있다', () => {
  const panel = block('function taskPanel(t, date, c, editable)', '/** 수업 출결 표시용 */');

  assert.match(panel, /실시간 선생님 요청/);
  assert.match(panel, /data-act="teacherLiveRequestOpen"/);
  assert.match(panel, /data-id=/);
  assert.match(panel, /esc\(t\.id\)/);
  assert.match(panel, /data-date=/);
  assert.match(panel, /esc\(date\)/);
  assert.match(panel, /lesson/);
  assert.match(panel, /editable/);
});

test('요청 버튼은 본문 입력과 관리자 한 명 선택 및 전송을 한 모달에서 제공한다', () => {
  const editor = functionBlock('openTeacherLiveRequestModal');

  assert.match(editor, /modal\('실시간 선생님 요청'/);
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
});

test('관리자 수신자 후보는 서버 정본에서 불러오며 일반 직원 목록으로 추측하지 않는다', () => {
  const loader = functionBlock('loadTeacherLiveRequestRecipients');

  assert.match(loader, /sync\.post\('\/teacher-live-request'/);
  assert.match(loader, /action:\s*'recipients'/);
  assert.match(loader, /result\.recipientAdminIds/);
  assert.doesNotMatch(loader, /liveStaff\(\)|teamStaff\(\)|staffById\([^)]*manager/i);
});

test('전송은 stable taskId와 날짜·서버 발급 대상 ID만 보내고 이름이나 발신자를 위조하지 않는다', () => {
  const submit = functionBlock('submitTeacherLiveRequest');

  assert.match(submit, /sync\.post\('\/teacher-live-request'/);
  assert.match(submit, /action:\s*'send'/);
  assert.match(submit, /requestId:/);
  assert.match(submit, /lessonTaskId:/);
  assert.match(submit, /lessonDate:/);
  assert.match(submit, /recipientAdminId:/);
  assert.match(submit, /body:/);
  assert.match(submit, /if\s*\(![^)]*recipient/);
  assert.match(submit, /if\s*\(![^)]*(?:message|body|content)/);
  assert.doesNotMatch(submit, /senderId\s*:|teacherId\s*:|studentId\s*:|studentName\s*:|teacherName\s*:|audience(?:Ids|ManagerIds|StaffIds)?\s*:/);
});

test('모든 관리자는 지정 수신자와 무관하게 같은 미확인 요청을 팝업으로 받는다', () => {
  const loader = functionBlock('loadTeacherLiveRequests');
  const popup = functionBlock('showPendingTeacherLiveRequestPopup');

  assert.match(loader, /session\.isAdmin/);
  assert.match(loader, /action:\s*'list'/);
  assert.match(popup, /!item\.acknowledgedAt/);
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

test('요청 조회는 15초마다 갱신되고 클릭 라우팅이 열기·전송·확인을 모두 연결한다', () => {
  const polling = block('setInterval(() => {', '/* ── 새 버전 감지 ──');
  const clicks = block("document.addEventListener('click'", "document.addEventListener('input'");

  assert.match(polling, /loadTeacherLiveRequests\(true,\s*true\)/);
  assert.match(polling, /},\s*15000\);/);
  for (const action of ['teacherLiveRequestOpen', 'teacherLiveRequestSend', 'teacherLiveRequestAck']) {
    assert.match(clicks, new RegExp(`case '${action}'`));
  }
});
