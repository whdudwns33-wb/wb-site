'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
function tabs(session, driver = false, gated = false) {
  const element = { innerHTML: '' };
  const source = html.slice(html.indexOf('function renderTabs()'), html.indexOf('/* ── 링크로 들어온 지시서 확인'));
  Function('session', 'alertsToday', 'shouldGatePersonAccess', 'shouldGateStaffWork', 'isDriverFacilityStaff',
    'managerRequestInboxCount', 'onboardingAttentionCount', 'makeupAttentionCount', 'sessionPackAttentionCount',
    'deviceAlertCount', '$', 'route', source + ';renderTabs();')(
    session, () => ({ total: 0 }), () => gated, () => false, () => driver,
    () => 0, () => 0, () => 0, () => 0, () => 0, () => element, 'question_bank');
  return [...element.innerHTML.matchAll(/data-go="([^"]+)"/g)].map(match => match[1]);
}
test('문제은행은 관리자와 선생님의 오늘 바로 다음에 표시된다', () => {
  for (const session of [{ isAdmin: true }, { isStaffLink: true, isAdmin: false }]) {
    const routes = tabs(session);
    assert.equal(routes[routes.indexOf('today') + 1], 'question_bank');
  }
  assert.match(html, /allowed\.push\('question_bank'\)/);
  assert.match(html, /question_bank: viewQuestionBank/);
});
test('운전 직원의 두 탭 및 인증 전 접근 제한은 유지한다', () => {
  assert.deepEqual(tabs({ isStaffLink: true }, true), ['driver_transport', 'facility']);
  assert.deepEqual(tabs({ isStaffLink: true }, false, true), []);
  assert.deepEqual(tabs({}), []);
});
test('계정은 비공개 API에서 읽고 비밀번호는 요청 시만 보여주며 기기에 저장하지 않는다', () => {
  const source = html.slice(html.indexOf('function viewQuestionBank()'), html.indexOf('function viewPendingAdd()'));
  const output = Function(source + ';return viewQuestionBank();')();
  assert.match(output, /문제은행/);
  assert.match(output, /questionBankContent/);
  assert.match(source, /action: 'list'/);
  assert.match(source, /action: 'reveal'/);
  assert.match(source, /target.textContent = result.password/);
  assert.match(source, /JSON.stringify\(sync.auth\(\)\) !== authKey/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|console\.|password.*value=/);
  assert.match(source, /esc\(item.account\)/);
});
