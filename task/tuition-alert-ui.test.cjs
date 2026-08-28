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

test('원생 정보 편집기는 월결제와 4회 회차제 및 회차 시작일을 입력한다', () => {
  const editor = functionBlock('rosterStudentEditorHtml');

  assert.match(editor, /결제 구분/);
  assert.match(editor, /data-rse-billing-mode/);
  assert.match(editor, /value="monthly"/);
  assert.match(editor, />월결제</);
  assert.match(editor, /value="session4"/);
  assert.match(editor, /회차제[^<]*4회/);
  assert.match(editor, /data-rse-session-cycle-start/);
  assert.match(editor, /type="date"/);
  assert.match(editor, /billingMode[^\n]{0,180}monthly/);
});

test('회차 시작일 입력은 회차제에서만 보이고 필수이며 월결제로 바꾸면 비운다', () => {
  const toggle = functionBlock('updateRosterBillingFields');

  assert.match(toggle, /data-rse-billing-mode/);
  assert.match(toggle, /data-rse-session-cycle-start/);
  assert.match(toggle, /session4/);
  assert.match(toggle, /hidden/);
  assert.match(toggle, /required/);
  assert.match(toggle, /value\s*=\s*''/);
  assert.match(source, /data-rse-billing-mode[\s\S]{0,500}(?:change|updateRosterBillingFields)/);
});

test('원생 저장은 결제방식과 회차 시작일을 함께 보내고 잘못된 회차 설정을 차단한다', () => {
  const save = functionBlock('saveRosterStudent');

  assert.match(save, /data-rse-billing-mode/);
  assert.match(save, /data-rse-session-cycle-start/);
  assert.match(save, /billingMode:/);
  assert.match(save, /sessionCycleStartDate:/);
  assert.match(save, /billingMode\s*===\s*'session4'/);
  assert.match(save, /회차 시작일/);
  assert.match(save, /billingMode\s*===\s*'monthly'[\s\S]{0,180}(?:''|sessionCycleStartDate)/);
  assert.match(save, /expectedUpdatedAt:\s*Number\(rosterDb\.updatedAt\)/);
});

test('학생 정보 팝업은 결제 구분과 회차 시작일을 escape해 표시한다', () => {
  const info = functionBlock('rosterStudentInfoHtml');

  assert.match(info, /결제 구분/);
  assert.match(info, /월결제/);
  assert.match(info, /회차제[^<]*4회/);
  assert.match(info, /회차 시작일/);
  assert.match(info, /esc\([^)]*(?:billing|sessionCycleStartDate)[^)]*\)/i);
});

test('관리자 수강료 알림은 서버 목록을 불러와 학생 단위 미확인 건을 표시한다', () => {
  const loader = functionBlock('loadTuitionAlerts');
  const card = functionBlock('tuitionAlertCardHtml');

  assert.match(loader, /session\.isAdmin/);
  assert.match(loader, /sync\.post\('\/tuition-alert'/);
  assert.match(loader, /action:\s*'list'/);
  assert.match(card, /수강료 생성필요/);
  assert.match(card, /data-act="tuitionAlertConfirm"/);
  assert.match(card, /확인/);
  assert.match(card, /esc\([^)]*(?:student|label|school|grade)[^)]*\)/i);
  assert.doesNotMatch(card, /phone|contact|guardian/i);
});

test('관리자 알림은 회차 출결 확정 시각과 3회 기준을 명확히 안내한다', () => {
  const manager = functionBlock('tuitionAlertManagerHtml');

  assert.match(manager, /3회/);
  assert.match(manager, /23:50/);
  assert.match(manager, /수강료 생성필요/);
  assert.match(manager, /session\.isAdmin/);
});

test('수강료 생성필요 영역은 수업 등록 및 기존 수업 변경 뒤 화면 최하단에 배치한다', () => {
  const lesson = functionBlock('viewLessonEntry');
  const registrationStart = lesson.indexOf('const registration =');
  const existingChangeStart = lesson.indexOf('const existingChange =');
  const returnStart = lesson.indexOf('return registration + existingChange + tuitionAlertManagerHtml();');

  assert.ok(registrationStart >= 0);
  assert.ok(existingChangeStart > registrationStart);
  assert.ok(returnStart > existingChangeStart);
  assert.doesNotMatch(lesson.slice(registrationStart, existingChangeStart), /tuitionAlertManagerHtml\(\)/);
});

test('수강료 생성 확인은 stable alertId만 보내고 이름이나 횟수를 믿지 않는다', () => {
  const acknowledge = functionBlock('confirmTuitionAlert');

  assert.match(acknowledge, /sync\.post\('\/tuition-alert'/);
  assert.match(acknowledge, /action:\s*'confirm'/);
  assert.match(acknowledge, /alertId:/);
  assert.doesNotMatch(acknowledge, /revision\s*:|studentName\s*:|studentId\s*:|attendanceCount\s*:|count\s*:|message\s*:/);
  assert.match(acknowledge, /loadTuitionAlerts\(true/);
});

test('수강료 알림 팝업은 내용을 escape하고 확인 버튼을 제공한다', () => {
  const popup = functionBlock('showPendingTuitionAlertPopup');

  assert.match(popup, /modal\('수강료 생성필요'/);
  assert.match(popup, /esc\(/);
  assert.match(popup, /data-act="tuitionAlertConfirm"/);
  assert.match(popup, /확인/);
  assert.match(popup, /sessionStorage/);
  assert.match(popup, /alertId/);
});

test('수강료 알림은 관리자 화면에서 15초마다 갱신되고 교사 화면에서는 조회하지 않는다', () => {
  const polling = block('setInterval(() => {', '/* ── 새 버전 감지 ──');
  const clicks = block("document.addEventListener('click'", "document.addEventListener('input'");

  assert.match(polling, /session\.isAdmin[\s\S]{0,240}loadTuitionAlerts\(true/);
  assert.match(polling, /},\s*15000\);/);
  assert.match(clicks, /case 'tuitionAlertConfirm'/);
});
