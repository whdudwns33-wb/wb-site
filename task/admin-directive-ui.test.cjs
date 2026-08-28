const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

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

test('관리자는 전체·일부 선생님 실시간 관리자 요청을 작성·수정·종료하고 확인 현황을 본다', () => {
  assert.match(source, /📣 실시간 관리자 요청/);
  assert.match(source, /새 실시간 관리자 요청 작성/);
  assert.match(source, /data-act="adminDirectiveAdd"/);
  assert.match(source, /data-admin-directive-staff/);
  assert.match(source, /모든 선생님/);
  assert.match(source, /일부 선생님 중복 선택/);
  assert.match(source, /선생님별 확인 현황/);
  for (const action of ['adminDirectiveAdd', 'adminDirectiveEdit', 'adminDirectiveSave', 'adminDirectiveEnd']) {
    assert.match(source, new RegExp("case '" + action + "'"));
  }
});

test('학생정보 업무지시 안에서 수업 요청과 실시간 관리자 요청의 현재값·최근 3개 기록을 분리한다', () => {
  const start = source.indexOf('function lessonAdminRequestsHtml(');
  const end = source.indexOf('function adminDirectiveSoundKey(', start);
  const block = source.slice(start, end);
  assert.match(block, /현재 수업 요청/);
  assert.match(block, /지난 수업 요청 보기 · 최신 3개/);
  assert.match(block, /현재 실시간 관리자 요청/);
  assert.match(block, /지난 실시간 관리자 요청 보기 · 최신 3개/);
  assert.match(source, /function pastAdminDirectiveRows[\s\S]*?slice\(0, 3\)/);
});

test('개인 링크는 새 revision을 주기 조회하고 팝업·알림음·확인 이벤트를 사용한다', () => {
  assert.match(source, /setInterval\(\(\) => \{[\s\S]*?loadAdminDirectives\(true, true\)[\s\S]*?\}, 15000\)/);
  assert.match(source, /modal\('실시간 관리자 요청'/);
  assert.match(source, /playAdminDirectiveSound\(\)/);
  assert.match(source, /action: 'opened'/);
  assert.match(source, /action: 'acknowledge'/);
  assert.match(source, /item\.isCurrent && item\.displayStatus === 'active' && !item\.acknowledgedAt/);
});

test('교사 오늘 화면의 받은 관리자 요청은 최신순 최대 5개를 접힌 상태로 표시한다', () => {
  const start = source.indexOf('function teacherReceivedAdminDirectiveRows(');
  const end = source.indexOf('function currentAdminDirectiveRows(', start);
  const block = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(block, /adminDirectiveRowsForStaff\(staffId\)\.slice\(0, 5\)/);
  assert.match(block, /data-persist-key="today-admin-directive-received/);
  assert.match(block, /<details/);
  assert.doesNotMatch(block, /<details[^>]*\sopen(?:\s|>)/);
  assert.match(block, /adminDirectiveLessonCard/);
  assert.match(block, /row\.isCurrent && row\.displayStatus === 'active'/);
  assert.match(block, /최신순으로 최대 5개/);
  assert.match(block, /불러오는 중/);
  assert.match(block, /불러오지 못했습니다/);
});

test('실시간 관리자 요청은 예약 날짜를 받지 않고 서버 전송 일시만 표시한다', () => {
  const editor = functionBlock('adminDirectiveEditorModal');
  const save = functionBlock('saveAdminDirective');
  const lessonCard = functionBlock('adminDirectiveLessonCard');
  const manageCard = functionBlock('adminDirectiveManageCard');
  const timestamp = functionBlock('liveRequestSentAtText');

  assert.doesNotMatch(editor, /adStarts|adExpires|전달 시작일|종료일/);
  assert.doesNotMatch(save, /adStarts|adExpires|startsDate|expiresDate/);
  for (const card of [lessonCard, manageCard]) {
    assert.match(card, /전송 일시/);
    assert.match(card, /liveRequestSentAtText\(row\.createdAt\)/);
    assert.match(card, /adminDirectiveLegacyStatusText\(row\)/);
  }
  assert.match(timestamp, /timeZone:\s*'Asia\/Seoul'/);
  assert.match(timestamp, /second:\s*'2-digit'/);
  assert.match(timestamp, /hourCycle:\s*'h23'/);
  assert.match(timestamp, /return '확인 필요'/);
  assert.doesNotMatch(timestamp, /return '전송 일시 확인 필요'/);
});

test('관리자 개인 태블릿의 오늘 화면은 두 실시간 요청 영역만 숨기고 팝업 알림음 설정은 유지한다', () => {
  const today = block('function viewToday()', 'function taskRow');
  const received = functionBlock('teacherReceivedAdminDirectiveHtml');
  const composer = functionBlock('teacherLiveRequestComposerHtml');
  const soundPrompt = functionBlock('adminDirectiveSoundPromptHtml');

  assert.match(today, /session\.isStaffLink && !session\.isAdmin && me\.id === session\.staffId && cursor === today\(\)/);
  for (const guarded of [received, composer]) assert.match(guarded, /session\.isAdmin/);
  assert.match(today, /session\.isStaffLink && me\.id === session\.staffId\) h \+= adminDirectiveSoundPromptHtml\(\)/);
  assert.doesNotMatch(soundPrompt, /session\.isAdmin/);
});

test('기존 예약·종료 이력은 전송 일시와 함께 상태를 오해 없이 표시한다', () => {
  const statusText = functionBlock('adminDirectiveLegacyStatusText');
  for (const status of ['scheduled', 'ended', 'expired', 'superseded']) assert.match(statusText, new RegExp(status));
  assert.match(statusText, /전달 예정/);
  assert.match(statusText, /기간 만료/);
});

test('관리자 현황판은 실시간 관리자 요청과 학생정보·업무지시의 미확인을 함께 집계한다', () => {
  assert.match(source, /실시간 관리자 요청 미확인/);
  assert.match(source, /학생정보 미확인/);
  assert.match(source, /업무지시 미확인/);
  assert.match(source, /studentChangeAcknowledgementStatusHtml/);
  assert.match(source, /audienceStatus/);
});
