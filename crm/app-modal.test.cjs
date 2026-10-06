'use strict';
/* node crm/app-modal.test.cjs — 실제 app.js의 모달·이벤트를 최소 DOM 대역으로 실행한다. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const C = require('./crm-core.js');
const source = fs.readFileSync(path.join(__dirname, 'app/app.js'), 'utf8').replace(/\nstartApp\(\);\s*$/, '\n');

function harness() {
  const handlers = {}, surfaces = { '.skip-link': {}, '.topbar': {}, '.tabs': {}, '#view': {} };
  const host = { hidden: true, fields: [], html: '', closeButton: { focus() {} }, querySelectorAll() { return this.fields; }, querySelector(selector) {
    if (selector.startsWith('button') || selector === '[data-act="closemodal"]') return this.closeButton;
    return this.fields.find(el => !(selector.includes(':disabled') && el.disabled) && !(selector.includes(':not([hidden])') && el.hidden) && !(selector.includes(':not([type=hidden])') && el.type === 'hidden') && el.type !== 'checkbox') || null;
  }, focus() {} };
  Object.defineProperty(host, 'innerHTML', { get() { return this.html; }, set(value) { this.html = value; if (!value) this.fields = []; } });
  let confirmations = 0, restoredFocus = 0, accept = false;
  const opener = { focus() { restoredFocus++; } };
  const document = {
    activeElement: opener, contains: el => el === opener,
    querySelector: sel => sel === '#modalHost' ? host : surfaces[sel] || host.fields.find(el => '#' + el.id === sel) || null,
    addEventListener: (name, fn) => { handlers[name] = fn; }
  };
  const context = vm.createContext({
    WBCrmCore: C, document, window: { addEventListener: (name, fn) => { handlers[name] = fn; } },
    requestAnimationFrame: fn => fn(), confirm: () => { confirmations++; return accept; }, writes: []
  });
  vm.runInContext(source, context, { filename: 'crm/app/app.js' });
  const run = code => vm.runInContext(code, context);
  return {
    host, handlers, surfaces, context, run,
    open(fields) { host.fields = fields.map(el => Object.assign({ value: '', focus() {} }, el)); run("modal('테스트', '', '')"); },
    click(act) { const el = { dataset: { act }, closest() { return this; } }; return handlers.click({ target: el }); },
    accept(value) { accept = value; },
    get confirmations() { return confirmations; }, get restoredFocus() { return restoredFocus; }
  };
}

test('기존 값은 그대로 닫히고 수정 후 원복하면 확인하지 않는다', () => {
  const h = harness();
  h.open([{ value: '기존 이름' }, { value: 'inspection', type: 'select-one' }, { value: 'on', checked: true }]);
  assert.equal(h.run('modalDirty()'), false);
  h.host.fields[0].value = '수정한 이름';
  assert.equal(h.run('modalDirty()'), true);
  h.host.fields[0].value = '기존 이름';
  h.run('closeModal()');
  assert.equal(h.host.hidden, true);
  assert.equal(h.confirmations, 0);
  assert.equal(h.restoredFocus, 1);
  assert.equal(h.surfaces['#view'].inert, false);
});

test('모달 첫 초점은 비활성·숨긴 입력을 건너뛰고 입력이 없으면 닫기 버튼으로 간다', () => {
  const h = harness();
  let focused = '';
  h.open([
    { disabled: true, focus() { focused = 'disabled'; } },
    { type: 'hidden', focus() { focused = 'hidden-type'; } },
    { hidden: true, focus() { focused = 'hidden'; } },
    { focus() { focused = 'editable'; } }
  ]);
  assert.equal(focused, 'editable');
  h.host.closeButton.focus = () => { focused = 'close'; };
  h.open([{ disabled: true, focus() { focused = 'disabled'; } }]);
  assert.equal(focused, 'close');
});

test('닫기·ESC·배경은 변경 확인을 거치고 취소하면 입력을 보존한다', async () => {
  const h = harness();
  h.open([{ value: '메모' }, { value: 'inspection', type: 'select-one' }, { value: 'on', checked: false }]);
  h.host.fields[0].value = '작성 중인 메모';
  await h.click('closemodal');
  h.handlers.keydown({ key: 'Escape' });
  await h.handlers.click({ target: h.host });
  assert.equal(h.confirmations, 3);
  assert.equal(h.host.hidden, false);
  assert.equal(h.host.fields[0].value, '작성 중인 메모');
  assert.equal(h.surfaces['#view'].inert, true);
  assert.equal(h.surfaces['.skip-link'].inert, true);
  assert.equal(h.restoredFocus, 0);
  h.accept(true);
  await h.click('closemodal');
  assert.equal(h.host.hidden, true);
  assert.equal(h.restoredFocus, 1);
  assert.equal(h.surfaces['.skip-link'].inert, false);
});

test('본문 바로가기는 화면 해시를 바꾸지 않고 본문에 초점을 준다', async () => {
  const h = harness();
  let focused = false, prevented = false;
  h.surfaces['#view'].focus = () => { focused = true; };
  const el = { dataset: { act: 'focus-content' }, closest() { return this; } };
  await h.handlers.click({ target: el, preventDefault() { prevented = true; } });
  assert.ok(focused && prevented);
});

test('체크박스·라디오·선택값도 변경으로 보고 새 창에서는 초기값을 다시 잡는다', () => {
  const h = harness();
  for (const field of [{ type: 'checkbox', checked: false }, { type: 'radio', checked: true }, { type: 'select-one', value: 'inspection' }]) {
    h.open([field]);
    if (field.type === 'select-one') h.host.fields[0].value = 'academy';
    else h.host.fields[0].checked = !field.checked;
    assert.equal(h.run('modalDirty()'), true, field.type);
    h.run('closeModal(true)');
  }
  assert.equal(h.confirmations, 0);
  h.open([{ value: '보기 전용 초안', readOnly: true }]);
  assert.equal(h.run('modalDirty()'), false);
  h.run('closeModal()');
  assert.equal(h.confirmations, 0);
});

test('저장 검증 실패는 입력을 남기고 저장 성공은 추가 확인 없이 닫는다', () => {
  const h = harness();
  h.run('queueChange = (c, id, data) => writes.push({ c, id, data }); render = () => {};');
  h.open([{ id: 'f-pname' }, { id: 'f-pmemo' }]);
  h.host.fields[1].value = '작성 중인 메모';
  h.run("savePartnerForm('')");
  assert.equal(h.host.hidden, false);
  assert.equal(h.host.fields[1].value, '작성 중인 메모');
  assert.equal(h.context.writes.length, 0);
  h.host.fields[0].value = '가상 학원';
  h.run("savePartnerForm('')");
  assert.equal(h.context.writes.length, 1);
  assert.equal(h.host.hidden, true);
  assert.equal(h.confirmations, 0);
});

test('비밀번호 API 실패는 입력을 보존하고 성공 뒤에만 닫는다', async () => {
  const h = harness();
  h.open([{ id: 'f-pw-cur' }, { id: 'f-pw-new' }, { id: 'f-pw-new2' }]);
  h.host.fields.forEach(el => { el.value = 'synthetic-test-value'; });
  h.run("api = async () => { throw new Error('test failure'); };");
  await h.click('pw-save');
  assert.equal(h.host.hidden, false);
  assert.equal(h.host.fields[1].value, 'synthetic-test-value');
  h.run('api = async () => ({});');
  await h.click('pw-save');
  assert.equal(h.host.hidden, true);
  assert.equal(h.confirmations, 0);
});

test('페이지 이탈은 미저장 폼이나 기존 전송 대기열이 있을 때만 막는다', () => {
  const h = harness();
  const blocked = () => {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    h.handlers.beforeunload(event);
    return event.prevented && event.returnValue === '';
  };
  h.open([{ value: '기존 값' }]);
  assert.equal(blocked(), false);
  h.host.fields[0].value = '수정';
  assert.equal(blocked(), true);
  h.run('closeModal(true)');
  assert.equal(blocked(), false);
  h.run("outbox.put('leads', 'test-only', {});");
  assert.equal(blocked(), true);
});

test('고객 목록은 기록·다음 연락을 표시하고 이름과 전화 정보를 안전하게 그린다', () => {
  const h = harness();
  h.context.fixture = [{ id: 'qa_a', name: '<가상 보호자>', phone: '010-0000-0000', child: { name: '가상 학생' }, pipeline: 'inspection', stage: 'interpreted', status: 'open', owner: 'admin', followups: [{ day: 3, due: '2026-10-03', status: 'done' }, { day: 7, due: '2026-10-07', status: 'pending' }]}];
  h.run("session = {canApprove: true}; state.leads = fixture; today = () => '2026-10-06'; state.activities = [{leadId:'qa_a',type:'call',at:'2026-10-04'}, {leadId:'qa_a',type:'note',at:'2026-10-05'}];");
  const html = h.run('viewLeads()');
  assert.ok(html.includes('&lt;가상 보호자&gt;'));
  assert.ok(!html.includes('<가상 보호자>'));
  assert.ok(html.includes(C.maskPhone('010-0000-0000')));
  assert.ok(!html.includes('010-0000-0000'));
  assert.ok(html.includes('2026-10-05'));
  assert.ok(html.includes('2026-10-07'));
  assert.ok(!html.includes('2026-10-03'));
  h.run("ui.q = '해당 없음';");
  assert.ok(h.run('viewLeads()').includes('조건에 맞는 고객이 없습니다'));
});

test('보류·종료 고객의 남은 일정을 연락 대상으로 표시하지 않는다', () => {
  const h = harness();
  h.context.fixture = [
    {id: 'qa_hold', name: '가상 보류', stage: 'interpreted', status: 'hold'},
    {id: 'qa_closed', name: '가상 종료', stage: 'won', status: 'won'}
  ].map(l => ({...l, pipeline: 'inspection', followups: [{day: 3, due: '2026-10-01', status: 'pending'}]}));
  h.run("session = {canApprove: false}; state.leads = fixture; ui.status = 'all';");
  const html = h.run('viewLeads()');
  assert.ok(html.includes('보류 중') && html.includes('종료'));
  assert.ok(!html.includes('2026-10-01'));
  assert.ok(!html.includes('id="f-owner"'));
});
