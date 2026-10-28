'use strict';
/* 합성 고객으로 실제 직원·파트너 입력과 이름 없는 고객의 표시를 검사한다. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const C = require('./crm-core.js');

function harness(partner = false, actualWrites = false) {
  const fields = new Map(), messages = [], writes = [];
  const view = { innerHTML: '' };
  const host = { hidden: true, innerHTML: '', querySelectorAll() { return [...fields.values()]; }, querySelector() { return { focus() {} }; } };
  const context = vm.createContext({
    WBCrmCore: C,
    document: {
      activeElement: null, contains() { return false; }, addEventListener() {}, querySelectorAll() { return []; },
      querySelector(selector) { return selector === '#view' ? view : selector === '#modalHost' ? host : fields.get(selector.slice(1)) || null; }
    },
    window: { addEventListener() {} }, requestAnimationFrame(fn) { fn(); },
    captureMessage(message) { messages.push(message); },
    captureWrite(...args) { writes.push(JSON.parse(JSON.stringify(args))); }
  });
  const file = partner ? 'partner/partner.js' : 'app/app.js';
  const source = fs.readFileSync(path.join(__dirname, file), 'utf8').replace(/\n(?:startApp|start)\(\);\s*$/, '\n');
  const run = code => vm.runInContext(code, context);
  vm.runInContext(source, context, { filename: 'crm/' + file });
  run('toast=captureMessage;');
  if (partner) run("me={partner:{name:'가상 학원'},stats:{}}; load=async()=>{}; api=async(path,body)=>{captureWrite(path,body); return {};};");
  else {
    run("session=makeSession({role:'admin'}); render=()=>{}; go=()=>{}; scheduleFlush=()=>{}; patchSyncBar=()=>{}; today=()=> '2026-10-28';");
    if (!actualWrites) run('queueChange=captureWrite;');
  }
  return {
    run, context, host, view, messages, writes,
    field(id, value = '', checked = false) { const field = { id, value, checked, focus() {}, addEventListener() {} }; fields.set(id, field); return field; }
  };
}

function lead(patch = {}) {
  return { id: 'qa_student', name: '가상 보호자', child: { name: '가상 학생', grade: '초3' }, relation: '모',
    pipeline: 'inspection', stage: 'inquiry', status: 'open', followups: [], interests: [], owner: 'admin',
    channel: '기타', inspection: {}, hubspot: {}, ...patch };
}

function openLead(h, existing) {
  h.context.fixture = existing ? lead() : null;
  h.run('state.leads=fixture?[fixture]:[];');
  h.field('f-name', existing ? '가상 보호자' : '');
  h.field('f-child', existing ? '가상 학생' : '');
  h.field('f-rel', '모'); h.field('f-channel2', '기타');
  h.field('f-source'); h.field('f-memo', '작성 중인 메모');
  h.run(existing ? "openLeadForm('qa_student')" : "openLeadForm('')");
}

test('직원 신규·수정 폼에서 보호자는 선택이고 학생은 필수로 표시한다', () => {
  for (const existing of [false, true]) {
    const h = harness(); openLead(h, existing);
    assert.match(h.host.innerHTML, /for="f-name">보호자 이름 \(선택\)<\/label>/);
    assert.match(h.host.innerHTML, /for="f-child">학생 이름 \*<\/label>/);
    assert.match(h.host.innerHTML, /id="f-child"[^>]*required aria-required="true"/);
  }
});

test('직원 신규·수정 저장은 빈 보호자 이름과 학생 이름을 그대로 저장한다', () => {
  for (const existing of [false, true]) {
    const h = harness(); openLead(h, existing);
    h.field('f-name', '  '); h.field('f-child', '  가상 학생  ');
    h.run(existing ? "saveLeadForm('qa_student')" : "saveLeadForm('')");
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0][0], 'leads');
    assert.equal(h.writes[0][2].name, '');
    assert.equal(h.writes[0][2].child.name, '가상 학생');
    assert.equal(h.host.hidden, true);
  }
});

test('직원 신규·수정 저장은 빈칸·공백 학생 이름을 막고 초안을 남긴다', () => {
  for (const existing of [false, true]) for (const student of ['', '   ']) {
    const h = harness(); openLead(h, existing);
    h.field('f-name', '가상 보호자'); h.field('f-child', student);
    const memo = h.field('f-memo', '작성 중인 메모');
    h.run(existing ? "saveLeadForm('qa_student')" : "saveLeadForm('')");
    assert.equal(h.writes.length, 0);
    assert.equal(h.messages.at(-1), '학생 이름을 입력해 주세요');
    assert.equal(h.host.hidden, false);
    assert.equal(memo.value, '작성 중인 메모');
  }
});

test('보호자가 없으면 고객 목록·상세·카드에 학생을 표시하고 학생 제목에 어머니 호칭을 붙이지 않는다', () => {
  const h = harness(); h.context.fixture = lead({ name: '', child: { name: '<가상 학생>', grade: '초3' } });
  h.run('state.leads=[fixture];');
  const list = h.run('viewLeads()');
  assert.match(list, /href="#\/lead\/qa_student">&lt;가상 학생&gt;<\/a>/);
  const detail = h.run("viewLead('qa_student')");
  assert.match(detail, /<h1 class="page student-name">&lt;가상 학생&gt;<\/h1>/);
  assert.match(detail, /<p class="card-sub student-grade">초3<\/p>/);
  assert.ok(!detail.includes('<가상 학생>'));
  assert.ok(!detail.includes('가상 학생&gt; <span class="muted small">어머니'));
  assert.match(h.run('leadRow(fixture)'), /class="lead-name">&lt;가상 학생&gt;/);
  assert.equal(h.context.fixture.name, '');
});

test('고객 목록·상세는 실제 학생을 먼저 표시하고 보호자·관계·가린 연락처를 분리한다', () => {
  const h = harness();
  h.context.fixture = lead({ name: '<가상 김부모>', child: { name: '<가상 이학생>', grade: '초3' }, phone: '010-0000-0000' });
  h.run('state.leads=[fixture];');
  const before = h.run('JSON.stringify(state.leads[0])');
  const list = h.run('viewLeads()');
  assert.match(list, /<a class="student-name" href="#\/lead\/qa_student">&lt;가상 이학생&gt;<\/a>/);
  assert.match(list, /class="guardian-info">보호자 &lt;가상 김부모&gt; · 어머니 · /);
  assert.match(list, /class="student-grade small muted">초3<\/div>/);
  assert.ok(list.includes(C.maskPhone('010-0000-0000')));
  const detail = h.run("viewLead('qa_student')");
  assert.match(detail, /<h1 class="page student-name">&lt;가상 이학생&gt;<\/h1>/);
  assert.match(detail, /class="guardian-info">보호자 &lt;가상 김부모&gt; · 어머니<\/p>/);
  for (const html of [list, detail]) {
    assert.ok(!html.includes('<가상 이학생>') && !html.includes('<가상 김부모>'));
    assert.ok(!html.includes('010-0000-0000'));
  }
  assert.equal(h.run('JSON.stringify(state.leads[0])'), before, '화면 조회로 원본을 쓰지 않는다');
});

test('학생명+보호자 별칭은 학생으로 표시하고 실제 학생 이름이 있으면 우선하며 일반 보호자를 학생으로 바꾸지 않는다', () => {
  const examples = [
    { name: '가상 한학생 보호자', child: {}, student: '가상 한학생', guardian: '보호자 이름 미입력' },
    { name: '가상 한학생보호자', child: { name: '다른 가상학생' }, student: '다른 가상학생', guardian: '보호자 이름 미입력' },
    { name: '가상 김부모', child: {}, student: '학생 이름 미입력', guardian: '보호자 가상 김부모' }
  ];
  for (const item of examples) {
    const h = harness(); h.context.fixture = lead(item); h.run('state.leads=[fixture];');
    const list = h.run('viewLeads()');
    assert.ok(list.includes('href="#/lead/qa_student">' + item.student + '</a>'));
    assert.ok(list.includes('class="guardian-info">' + item.guardian));
    const detail = h.run("viewLead('qa_student')");
    assert.ok(detail.includes('<h1 class="page student-name">' + item.student + '</h1>'));
    const row = h.run('leadRow(fixture)');
    assert.ok(row.includes('<div class="avatar">' + (item.student === '학생 이름 미입력' ? '?' : item.student.slice(0, 1)) + '</div>'));
    assert.ok(row.includes('<div class="lead-name">' + item.student));
    assert.equal(h.run('outbox.size()'), 0);
  }
});

function formValue(html, id) {
  const match = html.match(new RegExp('id="' + id + '"[^>]*value="([^"]*)"'));
  assert.ok(match, '렌더된 입력 값: ' + id);
  return match[1].replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[entity]));
}

test('별칭 고객 수정 폼은 학생을 먼저 채우고 실제 저장할 때만 학생·보호자 필드를 정리한다', () => {
  for (const child of [{ grade: '초3' }, { name: '가상 이학생', grade: '초3' }]) {
    const h = harness();
    h.context.fixture = lead({ name: '가상 한학생 보호자', child, hubspot: { contactId: 'qa_contact' } });
    h.run("state.leads=[fixture]; openLeadForm('qa_student');");
    const html = h.host.innerHTML;
    assert.ok(html.indexOf('for="f-child"') < html.indexOf('for="f-name"'));
    assert.equal(formValue(html, 'f-child'), child.name || '가상 한학생');
    assert.equal(formValue(html, 'f-name'), '');
    assert.equal(h.run('state.leads[0].name'), '가상 한학생 보호자');
    assert.equal(h.writes.length, 0);
    for (const id of ['f-child', 'f-name', 'f-grade', 'f-phone', 'f-email']) h.field(id, formValue(html, id));
    h.run("saveLeadForm('qa_student')");
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0][2].name, '');
    assert.equal(h.writes[0][2].child.name, child.name || '가상 한학생');
    assert.equal(h.writes[0][2].child.grade, '초3');
    assert.equal(h.writes[0][2].hubspot.contactId, 'qa_contact');
  }
  const h = harness(); h.context.fixture = lead({ name: '가상 김부모', child: {} });
  const html = h.run('leadFormHtml(fixture)');
  assert.equal(formValue(html, 'f-name'), '가상 김부모');
  assert.equal(formValue(html, 'f-child'), '', '일반 보호자 이름에서 학생을 추측하지 않는다');
});

test('학생 이름 없는 기존 HubSpot 고객은 학생을 입력한 뒤에만 수동 수정할 수 있다', () => {
  const h = harness();
  h.context.fixture = lead({ child: {}, hubspot: { contactId: 'qa_contact' } });
  h.run('state.leads=[fixture];');
  h.field('f-name', '가상 보호자'); h.field('f-child', ''); h.field('f-memo', '보존할 메모');
  h.run("openLeadForm('qa_student'); saveLeadForm('qa_student');");
  assert.equal(h.writes.length, 0);
  assert.equal(h.run('outbox.size()'), 0);
  assert.equal(h.messages.at(-1), '학생 이름을 입력해 주세요');
  assert.equal(h.host.hidden, false);
  h.field('f-child', '가상 학생'); h.run("saveLeadForm('qa_student')");
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0][2].child.name, '가상 학생');
  assert.equal(h.writes[0][2].hubspot.contactId, 'qa_contact');
  assert.equal(h.writes[0][2].memo, '보존할 메모');
});

function openActivity(h, patch = {}, followup = false) {
  h.context.fixture = lead({ child: {}, hubspot: { contactId: 'qa_contact' }, ...patch });
  h.run('state.leads=[fixture];');
  h.field('f-atype', followup ? 'msg' : 'consult');
  h.field('f-adate', '2026-10-28');
  h.field('f-aresult', followup ? 'reached' : '');
  const text = h.field('f-atext', '보존할 상담 내용');
  h.field('f-startfu', '', !followup); h.field('f-tointerp', '', !followup);
  h.field('f-fuday', followup ? '3' : '');
  h.run(followup ? "openActivityForm('qa_student', {type:'msg',followupDay:3})" : "openActivityForm('qa_student')");
  return text;
}

test('학생 이름이 없는 상담·팔로업 저장은 관련 이력과 리드를 하나도 쓰지 않고 입력을 남긴다', () => {
  for (const followup of [false, true]) {
    const h = harness(false, true);
    const text = openActivity(h, { followups: C.scheduleFollowups('2026-10-25') }, followup);
    const before = h.run('JSON.stringify(state.leads[0])');
    h.run("saveActivityForm('qa_student')");
    assert.equal(h.run('outbox.size()'), 0);
    assert.equal(h.run('state.activities.length'), 0);
    assert.equal(h.run('JSON.stringify(state.leads[0])'), before);
    assert.equal(h.messages.at(-1), '학생 이름을 입력해 주세요');
    assert.equal(h.host.hidden, false);
    assert.equal(text.value, '보존할 상담 내용');
    h.run("state.leads[0].child.name='가상 학생'; saveActivityForm('qa_student');");
    assert.equal(h.host.hidden, true);
    assert.equal(h.run('outbox.size()'), followup ? 2 : 3);
    assert.equal(h.run('state.activities.length'), followup ? 1 : 2);
    if (followup) assert.equal(h.run('state.leads[0].followups[0].status'), 'done');
    else {
      assert.equal(h.run('state.leads[0].stage'), 'interpreted');
      assert.equal(h.run('state.leads[0].consultedAt'), '2026-10-28');
      assert.equal(h.run('state.leads[0].followups[0].due'), '2026-10-31');
      assert.equal(h.run("state.activities.find(a=>a.type==='stage').from"), 'inquiry');
      assert.equal(h.run("state.activities.find(a=>a.type==='stage').to"), 'interpreted');
    }
  }
});

test('상담 내용 검증이 실패해도 단계·팔로업은 먼저 저장되지 않는다', () => {
  const h = harness(false, true);
  const text = openActivity(h, { child: { name: '가상 학생' } });
  text.value = '';
  h.run("saveActivityForm('qa_student')");
  assert.equal(h.run('outbox.size()'), 0);
  assert.equal(h.run('state.activities.length'), 0);
  assert.equal(h.run('state.leads[0].stage'), 'inquiry');
  assert.equal(h.run('state.leads[0].followups.length'), 0);
  assert.equal(h.messages.at(-1), '기록 내용을 적어 주세요');
  assert.equal(h.host.hidden, false);
});

test('학생 이름이 없는 고객의 단계·판정·보류·팔로업 변경도 연결 기록을 만들지 않는다', () => {
  const actions = ["moveStage('qa_student','interpreted')", "saveOutcome('qa_student','won')", "unhold('qa_student')", "skipFollowup('qa_student',3)"];
  for (const action of actions) {
    const h = harness(false, true);
    h.context.fixture = lead({ child: {}, followups: C.scheduleFollowups('2026-10-25') });
    h.run('state.leads=[fixture];');
    const before = h.run('JSON.stringify(state.leads[0])');
    h.run(action);
    assert.equal(h.run('outbox.size()'), 0, action);
    assert.equal(h.run('state.activities.length'), 0, action);
    assert.equal(h.run('JSON.stringify(state.leads[0])'), before, action);
    assert.equal(h.messages.at(-1), '학생 이름을 입력해 주세요', action);
  }
});

test('파트너 폼은 학생 이름이 없으면 요청하지 않고 보호자 이름 없이 소개할 수 있다', async () => {
  const h = harness(true); h.run('render()');
  assert.match(h.view.innerHTML, /보호자 이름 \(선택\)/);
  assert.match(h.view.innerHTML, /학생 이름 \*/);
  h.field('f-name', ''); h.field('f-child', '   '); h.field('f-phone', '010-0000-0000'); h.field('f-consent', '', true);
  const btn = { disabled: false };
  h.context.button = btn;
  await h.run('send(button)');
  assert.equal(h.writes.length, 0);
  assert.equal(h.messages.at(-1), '학생 이름을 입력해 주세요');
  assert.equal(btn.disabled, false);
  h.field('f-child', '가상 학생');
  await h.run('send(button)');
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0][0], '/api/partner/referrals');
  assert.equal(h.writes[0][1].name, '');
  assert.equal(h.writes[0][1].childName, '가상 학생');
});

test('파트너 소개 목록도 보호자가 없는 학생을 빈 제목이나 중복 이름 없이 표시한다', () => {
  const h = harness(true);
  h.run("tab='inbound'; data.inbound=[{name:'',childName:'<가상 학생>',grade:'초3',stage:'접수',createdAt:'2026-10-28'}]; render();");
  assert.match(h.view.innerHTML, /<b>&lt;가상 학생&gt;<\/b>/);
  assert.equal((h.view.innerHTML.match(/&lt;가상 학생&gt;/g) || []).length, 1);
  assert.ok(!h.view.innerHTML.includes('<가상 학생>'));
});
