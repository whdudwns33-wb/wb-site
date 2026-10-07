'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, 'app/app.js'), 'utf8').replace(/\nstartApp\(\);\s*$/, '\n');
const summary = {
  schemaVersion: 1, familyId: '101', hubspot: { contactId: '123456789012', appointments: [{ appointmentId: '201', dealId: '234567890123' }] },
  membership: { friend: 'expired', supporter: 'available' }, app: { installation: 'unknown', launchObserved: true },
  benefits: { parentAccess: 'expired', brainAppsEligible: false }, cs: { pendingCount: 2, nextContactDate: '2026-10-08' }, brunch: { attendedCount: 1 }
};
function harness() {
  const fields = new Map();
  const host = { hidden: true, innerHTML: '', querySelectorAll: () => [...fields.values()], querySelector: () => null, focus() {} };
  const document = { activeElement: null, contains: () => false, querySelector: sel => sel === '#modalHost' ? host : fields.get(sel.slice(1)) || null, addEventListener() {} };
  const context = vm.createContext({ WBCrmCore: require('./crm-core.js'), document, window: { addEventListener() {} }, requestAnimationFrame: fn => fn(), confirm: () => true, setTimeout, clearTimeout, summary });
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  const field = (id, value = '') => { const f = { value, checked: false, disabled: false, hidden: false, textContent: '', focus() {} }; fields.set(id, f); return f; };
  ['portal-family-id', 'portal-confirmed', 'portal-error', 'portal-save', 'portal-reload'].forEach(id => field(id));
  run("session={canApprove:true}; route='lead'; leadId='qa_child'; state.leads=[{id:leadId,name:'가상 보호자',child:{name:'가상 학생'}}]; render=()=>{}; toast=()=>{};");
  return { context, run, field, fields, host };
}
function linked(h) { h.run("ui.portal[leadId]={loaded:true,configured:true,link:{leadId,familyId:'101',updatedAt:10,checkedAt:Date.UTC(2026,9,7),snapshot:summary}};"); }

test('센터 원본은 출처·확인시각·기존 예약별 딜을 표시하고 종료·미설치를 추정하지 않는다', () => {
  const h = harness(); linked(h);
  const html = h.run('portalLinkHtml(leadId)');
  for (const s of ['센터앱에서 확인', '무료 소검사 예약 가능', '미확인', '실행 기록 있음', '예약 201', '234567890123', '2026-10-08', '맘스쿨 기록과 별개']) assert.ok(html.includes(s), s);
  assert.ok(!html.includes('탈퇴') && !html.includes('미설치'));
  h.run('session.canApprove=false');
  assert.ok(!h.run('portalLinkHtml(leadId)').includes('portal-edit'));
});

test('고객을 열면 저장 요약을 읽고 원본을 확인하며 외부 오류에도 이전 상태를 보존한다', async () => {
  const h = harness(); linked(h);
  h.run("calls=[]; api=async(path,body)=>{ calls.push({path,body}); if(body)throw new Error('센터앱 연결 실패'); return {configured:true,link:ui.portal[leadId].link}; };");
  await h.run('loadPortalLink(leadId)');
  assert.equal(h.run('calls.length'), 2);
  assert.equal(h.run('calls[1].body.expectedUpdatedAt'), 10);
  assert.equal(h.run('ui.portal[leadId].link.snapshot.brunch.attendedCount'), 1);
  assert.ok(h.run('portalLinkHtml(leadId)').includes('이전에 확인한 상태'));
  assert.equal(h.run('outbox.size()'), 0);
});

test('번호 연결은 원장 확인과 버전을 요구하고 거절 시 입력을 남긴다', async () => {
  const h = harness(); linked(h);
  h.run('openPortalLink(leadId); api=async()=>{throw Object.assign(new Error("연결 충돌"),{code:"STALE"});};');
  h.fields.get('portal-family-id').value = '202';
  await h.run('savePortalLink()');
  assert.ok(h.fields.get('portal-error').textContent.includes('같은 아이'));
  h.fields.get('portal-confirmed').checked = true;
  await h.run('savePortalLink()');
  assert.equal(h.host.hidden, false);
  assert.equal(h.fields.get('portal-family-id').value, '202');
  assert.equal(h.run('portalEdit.expectedUpdatedAt'), 10);
  assert.equal(h.fields.get('portal-reload').hidden, false);
  h.run("api=async()=>({configured:true,link:{familyId:'303',updatedAt:20,snapshot:null}});");
  await h.run('reloadPortalEdit()');
  assert.equal(h.run('portalEdit.expectedUpdatedAt'), 20);
  assert.equal(h.fields.get('portal-family-id').value, '202');
  assert.equal(h.fields.get('portal-confirmed').checked, false);
  assert.ok(h.fields.get('portal-error').textContent.includes('303'));
});

test('저장 중 중복 클릭·닫기를 막고 서버 확인 성공 뒤에 닫는다', async () => {
  const h = harness(); linked(h);
  h.run('openPortalLink(leadId); calls=0; api=async()=>{ calls++; return new Promise(resolve=>{finish=resolve;}); };');
  h.fields.get('portal-family-id').value = '202'; h.fields.get('portal-confirmed').checked = true;
  const saved = h.run('savePortalLink()');
  await h.run('savePortalLink()'); h.run('closeModal()');
  assert.equal(h.run('calls'), 1); assert.equal(h.host.hidden, false);
  h.run("finish({configured:false,link:{familyId:'202',updatedAt:21,checkedAt:0,snapshot:null}})");
  await saved;
  assert.equal(h.host.hidden, true);
  assert.equal(h.run('ui.portal[leadId].link.familyId'), '202');
  assert.equal(h.run('ui.portal[leadId].link.snapshot'), null);
});

test('동시 연결 변경은 최신 번호를 다시 읽고 이전 고객의 요약을 붙이지 않는다', async () => {
  const h = harness(); linked(h);
  h.run("api=async(path,body)=>{ if(body)throw Object.assign(new Error('다른 기기에서 연결 변경'),{code:'STALE'}); return {configured:true,link:{familyId:'202',updatedAt:22,checkedAt:0,snapshot:null}}; };");
  await h.run('refreshPortal(leadId)');
  assert.equal(h.run('ui.portal[leadId].link.familyId'), '202');
  assert.equal(h.run('ui.portal[leadId].link.snapshot'), null);
});

test('로그아웃 후 늦게 도착한 요약을 새 세션에 표시하지 않는다', async () => {
  const h = harness(); linked(h);
  h.run('api=async()=>new Promise(resolve=>{finish=resolve;});');
  const pending = h.run('refreshPortal(leadId)');
  h.run("session=null;ui.portal={};finish({configured:true,link:{familyId:'101',snapshot:summary}});");
  await pending;
  assert.equal(h.run('Object.keys(ui.portal).length'), 0);
});

test('인증 만료는 열려 있는 연결 폼과 고객 표시를 지운다', () => {
  const h = harness(); linked(h);
  h.run('openPortalLink(leadId);setToken=()=>{};stopPolling=()=>{};onAuthLost();');
  assert.equal(h.host.hidden, true);
  assert.equal(h.host.innerHTML, '');
  assert.equal(h.run('portalEdit'), null);
});

test('저장 뒤 요약 갱신을 기다려도 다른 폼의 닫기를 막지 않는다', async () => {
  const h = harness(); linked(h);
  h.run("openPortalLink(leadId); api=async(path)=>path==='/api/portal/link'?{configured:true,link:{familyId:'202',updatedAt:21,checkedAt:0,snapshot:null}}:new Promise(resolve=>{finish=resolve;});");
  h.fields.get('portal-family-id').value = '202'; h.fields.get('portal-confirmed').checked = true;
  const saved = h.run('savePortalLink()');
  await new Promise(resolve => setImmediate(resolve));
  h.run("modal('다른 작업','내용');closeModal();");
  assert.equal(h.host.hidden, true);
  h.run("finish({configured:true,link:{familyId:'202',updatedAt:22,checkedAt:Date.now(),snapshot:summary}});");
  await saved;
});
