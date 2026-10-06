'use strict';
/* 새 관계관리의 서버 확인 저장과 실제 화면 함수를 실행한다. 실고객·외부 API 없음. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const C = require('./crm-core.js');
const source = fs.readFileSync(path.join(__dirname, 'app/app.js'), 'utf8').replace(/\nstartApp\(\);\s*$/, '\n');

function harness() {
  const handlers = {}, fields = new Map(), surface = {};
  const host = { hidden: true, html: '', querySelectorAll(selector) { return [...fields.values()].filter(x => /button/.test(selector) || x.tagName !== 'BUTTON'); }, querySelector(selector) { return selector === '.modal-box' ? { classList: { add() {} } } : [...fields.values()][0]; } };
  Object.defineProperty(host, 'innerHTML', { get() { return this.html; }, set(v) { this.html = v; } });
  const document = { activeElement: null, contains: () => false, querySelector(selector) { return selector === '#modalHost' ? host : fields.get(selector.slice(1)) || surface[selector] || null; }, addEventListener(name, fn) { handlers[name] = fn; } };
  const context = vm.createContext({ WBCrmCore: C, document, window: { addEventListener(name, fn) { handlers[name] = fn; } }, requestAnimationFrame: fn => fn(), confirm: () => true, setTimeout, clearTimeout });
  vm.runInContext(source, context);
  const run = script => vm.runInContext(script, context);
  const field = (id, value = '', tagName = 'INPUT') => { const item = { id, value, tagName, type: 'text', disabled: false, hidden: false, checked: false, focus() {}, dataset: {}, textContent: '' }; fields.set(id, item); return item; };
  field('r-error', '', 'DIV'); field('r-reload', '', 'BUTTON'); field('r-save', '', 'BUTTON');
  run("session = {canApprove:false,staffId:'qa_staff'}; today = () => '2026-10-06'; render = () => {}; toast = () => {}; ui.relationships.month = '2026-10';");
  return { fields, host, context, handlers, run, field };
}
const lead = { id: 'qa_parent', name: '<가상 보호자>', child: { name: '가상 학생' }, pipeline: 'inspection', stage: 'tested', status: 'open' };
const member = { id: 'qa_parent__supporter', leadId: 'qa_parent', program: 'supporter', startDate: '2026-07-01', owner: 'qa_staff', status: 'active', benefitState: 'unchecked', nextContactDate: '2026-10-06', nextAction: '활동 확인 연락', pauseDate: '', resumeDate: '', note: '' };
function activityForm(h) {
  h.context.seed = { lead, member };
  h.run('state.leads = [seed.lead]; state.memberships = [seed.member];');
  [['r-activity-month', '2026-10'], ['r-activity-date', '2026-10-05'], ['r-activity-kind', 'review'], ['r-activity-status', 'pending'], ['r-evidence', '센터앱 원본 확인 대기'], ['r-note', '입력 보존 검사']].forEach(([id, value]) => h.field(id, value));
  h.run("openProgramActivity('', seed.member.id)");
  return h.run('relationshipEdit.id');
}

test('관계관리 메뉴와 월별 활동 표는 직원에게 열리고 고객·주제를 안전하게 표시한다', () => {
  const h = harness(); h.context.seed = { lead, member };
  h.run("state.leads=[seed.lead]; state.memberships=[seed.member]; ui.relationships.tab='supporter'; state.programActivities=[{membershipId:seed.member.id,month:'2026-09',status:'confirmed'}];");
  const html = h.run('viewRelationships()');
  assert.ok(h.run("TABS.some(t => t[0] === 'relationships') && !C.OWNER_ROUTES.includes('relationships')"));
  assert.ok(html.includes('&lt;가상 보호자&gt;') && !html.includes('<가상 보호자>'));
  assert.ok(html.includes('기록 없음') && html.includes('2026-10-06'));
  assert.ok(html.includes('센터앱에서 확인한 혜택·활동 기록') && html.includes('센터앱 원본 확인'));
  h.run("ui.relationships.month='2026-09';"); assert.ok(h.run('viewRelationships()').includes('확인 완료'));
  h.run("ui.relationships.q='검색 결과 없음';"); assert.ok(h.run('viewRelationships()').includes('조건에 맞는 회원이 없습니다'));
});

test('소검사 완료 기록은 보기만 제공하고 월 활동 수정·회차 추가를 찾을 수 있다', () => {
  const h = harness(); h.context.member = member;
  h.run("state.programActivities=[{id:'qa_activity',membershipId:member.id,month:'2026-10',kind:'review',date:'2026-10-05',status:'supplement',evidence:'원본 <확인>'}]; state.programExams=[{id:'qa_exam',membershipId:member.id,cycleStart:'2026-07-01',cycleEnd:'2026-09-30',dueDate:'2026-10-01',completedDate:'2026-10-01'}];");
  const html = h.run('membershipRecordsHtml(member)');
  assert.ok(html.includes('program-activity-edit') && html.includes('program-exam-new'));
  assert.ok(html.includes('원본 &lt;확인&gt;') && html.includes('완료 2026-10-01'));
  assert.ok(!html.includes('program-exam-edit'));
});

test('맘스쿨 고객 선택은 상담만 한 고객과 미래 검사 예약을 제외한다', () => {
  const h = harness(); h.context.lead = lead;
  h.run("state.leads=[lead,{id:'qa_consult',name:'상담만',pipeline:'inspection',stage:'consulted',consultedAt:'2026-10-01'},{id:'qa_future',name:'미래 예약',inspection:{date:'2026-11-01'}}];");
  const html = h.run("relationshipLeadOptions('', '', true)");
  assert.ok(html.includes('qa_parent') && !html.includes('qa_consult') && !html.includes('qa_future'));
  assert.ok(html.includes('&lt;가상 보호자&gt;'));
});

test('오늘 후속과 고객 상세는 참여·맘스쿨 연락을 원래 기록으로 연결한다', () => {
  const h = harness(); h.context.seed = { lead, member };
  h.run("state.leads=[seed.lead]; state.memberships=[seed.member]; state.gatherings=[{id:'qa_group',topic:'함께 이야기',date:'2026-10-05',status:'completed',participants:[{leadId:seed.lead.id,status:'attended',nextContactDate:'2026-10-06',nextAction:'모임 후 연락'}]}];");
  const html = h.run('relationshipTodayHtml()');
  assert.ok(html.includes('미처리 연락') && html.includes('membership-edit') && html.includes('gathering-edit'));
  assert.ok(h.run("relationshipLeadHtml('qa_parent')").includes('함께 이야기'));
});

test('검증·서버 거절은 폼과 같은 문서 ID를 보존하고 낙관 큐에 넣지 않는다', async () => {
  const h = harness(), id = activityForm(h);
  h.field('r-activity-date', '2026-09-05');
  h.run('postCount=0; api = async () => { postCount++; throw Object.assign(new Error("서버 거절"),{code:"INVALID"}); };');
  await h.run('saveRelationship()');
  assert.equal(h.run('postCount'), 0);
  assert.ok(h.fields.get('r-error').textContent.includes('선택한 월'));
  h.fields.get('r-activity-date').value = '2026-10-05';
  await h.run('saveRelationship()'); await h.run('saveRelationship()');
  assert.equal(h.run('postCount'), 2);
  assert.equal(h.run('relationshipEdit.id'), id);
  assert.equal(h.run('outbox.size()'), 0);
  assert.equal(h.host.hidden, false);
  assert.equal(h.fields.get('r-note').value, '입력 보존 검사');
});

test('저장 중 중복 클릭·닫기를 막고 재조회 실패 후 POST 없이 저장 결과만 재확인한다', async () => {
  const h = harness(), id = activityForm(h);
  h.run('postCount=0; readCount=0; api = async (path, body) => { postCount++; sent=body.changes[0]; return {results:[{c:sent.c,id:sent.id,updatedAt:88}]}; }; loadAll = async () => { readCount++; throw new Error("조회 실패"); };');
  await h.run('saveRelationship()');
  assert.equal(h.run('relationshipEdit.acceptedAt'), 88);
  assert.equal(h.host.hidden, false);
  assert.ok(h.fields.get('r-error').textContent.includes('저장은 접수'));
  assert.equal(h.fields.get('r-note').disabled, true);
  h.run('loadAll = async () => { readCount++; await new Promise(resolve => { finishRead=resolve; }); state.programActivities=[Object.assign({},sent.data,{id:sent.id})]; state.meta[C.docKey(sent.c,sent.id)]=88; }; openMembershipForm = () => {};');
  const saving = h.run('saveRelationship()');
  await h.run('saveRelationship()'); h.run('closeModal()');
  assert.equal(h.host.hidden, false);
  assert.equal(h.run('postCount'), 1);
  assert.equal(h.run('sent.id'), id);
  assert.equal(h.run('sent.expectedUpdatedAt'), 0);
  h.run('finishRead()'); await saving;
  assert.equal(h.run('readCount'), 2);
  assert.equal(h.host.hidden, true);
});

test('STALE은 최신 상태만 읽고 폼 값·원래 버전을 유지해 조용히 덮어쓰지 않는다', async () => {
  const h = harness(); activityForm(h);
  h.run('relationshipEdit.expectedUpdatedAt=7; api=async () => { throw Object.assign(new Error("다른 기기 변경"),{code:"STALE"}); }; loadAll=async () => { state.meta[C.docKey(relationshipEdit.c,relationshipEdit.id)]=99; };');
  await h.run('saveRelationship()');
  assert.equal(h.run('relationshipEdit.expectedUpdatedAt'), 7);
  assert.equal(h.fields.get('r-note').value, '입력 보존 검사');
  assert.equal(h.fields.get('r-reload').hidden, false);
  assert.ok(h.fields.get('r-error').textContent.includes('최신 기록 다시 열기'));
  assert.equal(h.host.hidden, false);
});

test('최신 기록 다시 열기는 재조회 실패 시 입력을 보존하고 성공 뒤 새 버전으로 연다', async () => {
  const h = harness(); activityForm(h);
  h.run('relationshipEdit.expectedUpdatedAt=7; reads=0; reopenedVersion=0; originalEdit=relationshipEdit; loadAll=async () => { reads++; throw new Error("연결 실패"); }; openProgramActivity=() => { reopenedVersion=state.meta[C.docKey(originalEdit.c,originalEdit.id)]; };');
  await h.run('reloadRelationship()');
  assert.equal(h.run('reads'), 1);
  assert.equal(h.run('reopenedVersion'), 0);
  assert.equal(h.run('relationshipEdit.expectedUpdatedAt'), 7);
  assert.equal(h.fields.get('r-note').value, '입력 보존 검사');
  assert.equal(h.fields.get('r-reload').disabled, false);
  assert.ok(h.fields.get('r-error').textContent.includes('입력을 유지'));
  h.run('loadAll=async () => { reads++; state.programActivities=[{id:originalEdit.id}]; state.meta[C.docKey(originalEdit.c,originalEdit.id)]=99; };');
  await h.run('reloadRelationship()');
  assert.equal(h.run('reads'), 2);
  assert.equal(h.run('reopenedVersion'), 99);
});

test('새 활동 생성의 응답 유실 뒤에도 원래 ID와 버전으로만 재시도한다', async () => {
  const h = harness(), id = activityForm(h);
  h.run('sentIds=[]; api=async (_,body) => { sentIds.push(body.changes[0]); throw Object.assign(new Error("응답 유실"),{code:"NETWORK"}); };');
  await h.run('saveRelationship()'); await h.run('saveRelationship()');
  const sent = JSON.parse(h.run('JSON.stringify(sentIds)'));
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map(x => [x.id,x.expectedUpdatedAt]), [[id,0],[id,0]]);
  assert.equal(h.host.hidden, false);
});

test('맘스쿨은 HubSpot 고객 ID를 허용하고 참가자 메모의 개인정보는 계속 차단한다', async () => {
  for (const note of ['센터앱 검사 완료 확인', '010-0000-0000', 'qa@example.invalid', '1234561234567']) {
    const h = harness();
    const participant = { dataset: { lead: 'hs_1234561234567' }, querySelectorAll() {
      return Object.entries({ status: 'invited', nextContactDate: '', nextAction: '', note }).map(([part, value]) => ({ dataset: { part }, value, type: 'text' }))
        .concat({ dataset: { part: 'inspectionConfirmed' }, type: 'checkbox', checked: true });
    } };
    [['r-topic', '가상 모임'], ['r-gathering-date', '2026-10-06'], ['r-time', '10:00'], ['r-place', '센터'], ['r-capacity', '4'], ['r-owner', 'qa_staff'], ['r-gathering-status', 'planned'], ['r-note', '']].forEach(([id, value]) => h.field(id, value));
    h.field('r-participants', '', 'DIV').querySelectorAll = () => [participant];
    h.run("openGatheringForm(''); postCount=0; api=async (_,body) => { postCount++; sent=body.changes[0]; return {results:[{c:sent.c,id:sent.id,updatedAt:90}]}; }; loadAll=async () => { state.gatherings=[Object.assign({},sent.data,{id:sent.id})]; state.meta[C.docKey(sent.c,sent.id)]=90; };");
    await h.run('saveRelationship()');
    const safe = note === '센터앱 검사 완료 확인';
    assert.equal(h.run('postCount'), safe ? 1 : 0, note);
    assert.equal(h.host.hidden, safe, note);
    if (safe) assert.equal(h.run('sent.data.participants[0].leadId'), 'hs_1234561234567');
    else assert.ok(h.fields.get('r-error').textContent.includes('전화번호·이메일·주민번호'));
  }
});
