'use strict';
/* 합성 상태로 실제 app.js의 자동 동기화 제어·저장 충돌을 실행한다. 외부 API는 호출하지 않는다. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const C = require('./crm-core.js');
const source = fs.readFileSync(path.join(__dirname, 'app/app.js'), 'utf8').replace(/\nstartApp\(\);\s*$/, '\n');

function harness(canApprove = true) {
  const handlers = {}, fields = new Map(), timers = new Map(), requests = [], messages = [];
  let timerId = 0;
  const host = { hidden: true, innerHTML: '', querySelectorAll() { return [...fields.values()]; }, querySelector() { return { focus() {} }; } };
  const view = { innerHTML: '', contains() { return false; } };
  const document = { hidden: false, activeElement: null, contains() { return false; },
    querySelector(selector) { return selector === '#modalHost' ? host : selector === '#view' ? view : fields.get(selector.slice(1)) || null; },
    querySelectorAll() { return []; },
    addEventListener(name, fn) { handlers[name] = fn; }
  };
  const location = { hash: '#/hubspot' };
  const context = vm.createContext({
    WBCrmCore: C, document, location, history: { replaceState(_state, _title, hash) { location.hash = hash; } },
    window: { addEventListener(name, fn) { handlers[name] = fn; } },
    localStorage: { getItem() { return ''; }, removeItem() {} },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); }, clearInterval() {},
    requestAnimationFrame(fn) { fn(); }, confirm: () => true, canApprove,
    captureRequest(path, body) { requests.push({ path, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)) }); },
    captureMessage(message) { messages.push(message); }
  });
  const run = code => vm.runInContext(code, context);
  vm.runInContext(source, context, { filename: 'crm/app/app.js' });
  run("session=makeSession({role:canApprove?'admin':'staff',staffId:'qa_staff'}); route='hubspot'; render=()=>{}; updateTabs=()=>{}; patchSyncBar=()=>{}; toast=captureMessage; poll=async()=>{}; ui.hs.props={present:[],missing:[]};");
  return { run, context, requests, messages, handlers, fields, host, timers,
    read(code) { return JSON.parse(run('JSON.stringify(' + code + ')')); },
    click(act, data = {}) { const el = { dataset: { act, ...data }, closest() { return this; } }; return handlers.click({ target: el }); },
    field(id, value = '') { const field = { id, value, checked: false, disabled: false, focus() {} }; fields.set(id, field); return field; }
  };
}

test('직원은 허브스팟 관리 경로를 열 수 없다', () => {
  const h = harness(false);
  h.run("applyRoute({route:'hubspot'})");
  assert.equal(h.run('route'), 'today');
});

test('허브스팟 오류 메시지는 HTML로 실행되지 않는다', () => {
  const h = harness();
  h.run("ui.hs.status={connected:false,reason:'error',error:'<img src=x onerror=alert(1)>'};");
  const html = h.run('viewHubspot()');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('<img src=x'));
});

const automation = { enabled: false, intervalMinutes: 15, lastRunAt: 0, lastSuccessAt: 0, lastResult: null, error: '', running: false };
function prepareAutomation(h, overrides = {}) {
  h.context.automationFixture = { ...automation, ...overrides };
  h.run('ui.hs.status={connected:true,automation:automationFixture}; loadHubspotPanel=async()=>{}; loadAll=async()=>{};');
}

test('자동화 설정은 응답 전 상태를 바꾸지 않고 서버가 확정한 설정만 표시한다', async () => {
  const h = harness(); prepareAutomation(h);
  h.run("api=async(path,body)=>{captureRequest(path,body); return new Promise(resolve=>{finishSync=resolve;});};");
  const pending = h.run('setAutoSync(true)');
  assert.equal(h.run('ui.hs.status.automation.enabled'), false);
  assert.equal(h.run('ui.hs.busy'), 'auto-sync');
  assert.deepEqual(h.requests, [{ path: '/api/hubspot/sync', body: { enabled: true } }]);
  h.run('finishSync({ok:true,automation:{...automationFixture,enabled:true,lastRunAt:17}})');
  await pending;
  assert.equal(h.run('ui.hs.status.automation.enabled'), true);
  assert.equal(h.run('ui.hs.status.automation.lastRunAt'), 17);
  assert.equal(h.run('ui.hs.busy'), '');
});

test('설정 변경 실패는 기존 서버 설정을 보존하고 오류를 남긴다', async () => {
  const h = harness(); prepareAutomation(h, { enabled: true, lastSuccessAt: 19 });
  const before = h.read('ui.hs.status.automation');
  h.run("api=async(path,body)=>{captureRequest(path,body); throw new Error('동기화 연결 확인 실패');};");
  await h.run('setAutoSync(false)');
  assert.deepEqual(h.read('ui.hs.status.automation'), before);
  assert.ok(h.run('ui.hs.err').includes('동기화 연결 확인 실패'));
  assert.equal(h.run('ui.hs.busy'), '');
});

test('동기화 실행 중 재실행·설정 변경은 두 번째 요청을 보내지 않는다', async () => {
  const h = harness(); prepareAutomation(h, { enabled: true });
  h.run("api=async(path,body)=>{captureRequest(path,body); return new Promise(resolve=>{finishSync=resolve;});};");
  const pending = h.run('runAutoSync()');
  await h.run('runAutoSync()');
  await h.run('setAutoSync(false)');
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.requests[0], { path: '/api/hubspot/sync', body: { run: true } });
  h.run('finishSync({ok:true,automation:{...automationFixture,lastRunAt:20,lastSuccessAt:21,lastResult:{pull:{created:1,updated:2,conflicts:3},push:{done:4,failed:0}}}})');
  await pending;
  assert.equal(h.run('ui.hs.status.automation.lastSuccessAt'), 21);
  assert.equal(h.run('ui.hs.status.automation.lastResult.push.done'), 4);
  assert.equal(h.run('ui.hs.busy'), '');
});

test('수동 실행 실패도 마지막 성공 결과를 지우지 않는다', async () => {
  const h = harness(); prepareAutomation(h, { enabled: true, lastSuccessAt: 21, lastResult: { pull: { updated: 2 } } });
  const before = h.read('ui.hs.status.automation');
  h.run("api=async()=>{throw Object.assign(new Error('이미 동기화 중입니다'),{code:'SYNC_BUSY'});};");
  await h.run('runAutoSync()');
  assert.deepEqual(h.read('ui.hs.status.automation'), before);
  assert.ok(h.run('ui.hs.err').includes('이미 동기화 중'));
});

test('자동 동기화 제어는 이벤트와 함수 모두 원장 권한을 확인한다', async () => {
  const h = harness(false); prepareAutomation(h);
  h.run('api=async(path,body)=>{captureRequest(path,body); return {ok:true,automation:automationFixture};};');
  await h.run('setAutoSync(true)');
  await h.run('runAutoSync()');
  await h.click('hs-auto-toggle', { enabled: '1' });
  await h.click('hs-auto-run');
  assert.equal(h.requests.length, 0);
  assert.equal(h.run('ui.hs.status.automation.enabled'), false);
});

test('자동화 버튼 이벤트는 선택한 서버 제어로 연결된다', async () => {
  const h = harness(); prepareAutomation(h);
  h.run('api=async(path,body)=>{captureRequest(path,body); return {ok:true,automation:{...automationFixture,enabled:body.enabled===true}};};');
  await h.click('hs-auto-toggle', { enabled: '1' });
  await h.click('hs-auto-toggle', { enabled: '0' });
  await h.click('hs-auto-run');
  assert.deepEqual(h.requests, [
    { path: '/api/hubspot/sync', body: { enabled: true } },
    { path: '/api/hubspot/sync', body: { enabled: false } },
    { path: '/api/hubspot/sync', body: { run: true } }
  ]);
});

test('동기화 응답을 확인하지 못하면 켜짐으로 추정하지 않는다', async () => {
  const h = harness(); prepareAutomation(h);
  h.run('api=async()=>({ok:true});');
  await h.run('setAutoSync(true)');
  assert.equal(h.run('ui.hs.status.automation.enabled'), false);
  assert.ok(h.run('ui.hs.err').includes('응답'));
});

test('로그아웃 뒤 도착한 이전 동기화 응답은 새 세션 상태에 적용하지 않는다', async () => {
  const h = harness(); prepareAutomation(h);
  h.run("loads=0; loadAll=async()=>{loads++;}; api=async()=>new Promise(resolve=>{finishSync=resolve;});");
  const pending = h.run('setAutoSync(true)');
  h.run("onAuthLost(); session=makeSession({role:'staff',staffId:'qa_other'}); ui.hs.status={connected:false}; finishSync({ok:true,automation:{...automationFixture,enabled:true}});");
  await pending;
  assert.equal(h.run('ui.hs.status.automation'), undefined);
  assert.equal(h.run('loads'), 0);
  assert.equal(h.run('ui.hs.busy'), '', '새 로그인에서 이전 세션의 busy가 남아 제어를 막지 않는다');
});

test('동기화 화면은 서버 상태·부분 결과·오류를 표시하고 실행 중 버튼을 잠근다', () => {
  const h = harness(); prepareAutomation(h, { enabled: true, running: true, error: '<가상 오류>', lastRunAt: 1, lastSuccessAt: 2,
    lastResult: { pull: { created: 2, updated: 3, conflicts: 4, invalid: 7, retry: 8, portalSkipped: 9, more: true }, push: { done: 5, failed: 6 } } });
  let html = h.run('viewHubspot()');
  assert.ok(html.includes('자동 양방향 동기화') && html.includes('15분'));
  assert.ok(html.includes('동기화 중') && html.includes('다음 주기'));
  assert.ok(html.includes('신규 2') && html.includes('갱신 3') && html.includes('충돌 4') && html.includes('완료 5') && html.includes('실패 6'));
  assert.ok(html.includes('검증 실패 7') && html.includes('재시도 대기 8') && html.includes('센터앱 관리 9'));
  assert.ok(html.includes('&lt;가상 오류&gt;') && !html.includes('<가상 오류>'));
  const controls = [...html.matchAll(/<button\b[^>]*data-act="hs-auto-(?:toggle|run)"[^>]*>/g)].map(x => x[0]);
  assert.equal(controls.length, 2);
  assert.ok(controls.every(button => /\sdisabled(?:\s|>)/.test(button)));
  h.run('session.canApprove=false;');
  html = h.run('autoSyncHtml(ui.hs.status)');
  assert.ok(!html.includes('data-act="hs-auto-'));
});

test('수동 가져오기는 검증 실패·재시도·센터앱 제외 수를 표시하고 다음 페이지 결과로 갱신한다', async () => {
  const h = harness(); prepareAutomation(h);
  h.run("api=async(path,body)=>{captureRequest(path,body); return body.full ? {created:1,updated:2,conflicts:3,invalid:4,retry:5,portalSkipped:6,more:true} : {created:7,updated:0,conflicts:0,invalid:0,retry:0,portalSkipped:0,more:false};};");
  await h.run("hsAction('pull',true)");
  let html = h.run('viewHubspot()');
  assert.ok(html.includes('새 리드 1') && html.includes('갱신 2') && html.includes('건너뜀(미반영 변경) 3'));
  assert.ok(html.includes('검증 실패 4') && html.includes('재시도 대기 5') && html.includes('센터앱 관리 6') && html.includes('더 있음'));
  await h.run("hsAction('pull',false)");
  html = h.run('viewHubspot()');
  assert.ok(html.includes('새 리드 7') && html.includes('검증 실패 0') && html.includes('재시도 대기 0') && html.includes('센터앱 관리 0'));
  assert.ok(!html.includes('더 있음'));
  assert.deepEqual(h.requests, [{path:'/api/hubspot/pull',body:{full:true}}, {path:'/api/hubspot/pull',body:{full:false}}]);
});

test('센터앱이 맡은 전송 대기는 실제 실패·완료와 별도로 표시한다', () => {
  const h = harness(); prepareAutomation(h, { enabled: true, lastSuccessAt: 21, lastResult: { push: { done: 0, failed: 0, portalHeld: 2 } } });
  let html = h.run('autoSyncHtml(ui.hs.status)');
  assert.ok(html.includes('보내기 완료 0 · 실패 0 · 센터앱 관리 대기 2'));
  h.run('ui.hs.status.automation.lastResult.push={done:1,failed:3,portalHeld:0}');
  html = h.run('autoSyncHtml(ui.hs.status)');
  assert.ok(html.includes('보내기 완료 1 · 실패 3'));
  assert.ok(!html.includes('센터앱 관리 대기'));
});

const lead = { id: 'qa_parent', name: '가상 보호자', phone: '', pipeline: 'inspection', stage: 'inquiry', status: 'open', memo: '기존 메모' };
function prepareLead(h) {
  h.context.leadFixture = lead;
  h.run("applyDocs([{c:'leads',id:leadFixture.id,data:{...leadFixture},updatedAt:12}],12); route='lead'; leadId=leadFixture.id;");
}

test('기존 학원 상태는 상세에서 현재 값만 보존하고 새 영업 단계로 옮겨도 등록 후 상태를 유지한다', () => {
  const h = harness(); prepareLead(h);
  h.run("state.leads[0]={...state.leads[0],pipeline:'academy',stage:'active',stageAt:'2026-09-01'};");
  const before = h.read('state.leads[0]');
  let html = h.run('viewLead(leadFixture.id)');
  let options = html.match(/id="f-stage"[\s\S]*?<\/select>/)[0];
  assert.ok(options.includes('<option value="active" selected>활성 (이전 상태 · 영업 단계 확인 필요)</option>'));
  assert.ok(!options.includes('value="at_risk"') && !options.includes('value="churned"'));
  assert.ok(html.includes('등록 후 관리 상태</dt><dd>재원'));
  assert.deepEqual(h.read('state.leads[0]'), before, '표시는 원본을 쓰지 않는다');
  h.run("moveStage(leadFixture.id,'trial_review')");
  assert.equal(h.run('leadById(leadFixture.id).stage'), 'trial_review');
  assert.equal(h.run('leadById(leadFixture.id).academyStatus'), '재원');
  assert.equal(h.run('leadById(leadFixture.id).outcome'), null);
  html = h.run('viewLead(leadFixture.id)');
  options = html.match(/id="f-stage"[\s\S]*?<\/select>/)[0];
  assert.ok(!options.includes('value="active"') && !options.includes('value="at_risk"') && !options.includes('value="churned"'));
  h.run("moveStage(leadFixture.id,'at_risk')");
  assert.equal(h.run('leadById(leadFixture.id).stage'), 'trial_review', '이전 상태로 새 이동은 거절한다');
});

test('이전 학원 상태는 영업 단계 확인 전 보류·해제를 제안하거나 저장 완료로 처리하지 않는다', () => {
  for (const status of ['open', 'hold']) {
    const h = harness(); prepareLead(h);
    h.context.legacyStatus = status;
    h.run("today=()=> '2026-10-16'; state.leads[0]={...state.leads[0],pipeline:'academy',stage:'active',status:legacyStatus,consultedAt:'2026-09-01',outcome:legacyStatus==='hold'?{status:'hold',at:'2026-09-02'}:null};");
    const before = h.read('state.leads[0]');
    const detail = h.run('viewLead(leadFixture.id)');
    assert.ok(!detail.includes('data-kind="hold"') && !detail.includes('data-act="unhold"'));
    assert.ok(detail.includes('영업 단계를 확인해 선택한 뒤'));
    const todayHtml = h.run('viewToday()');
    assert.ok(!todayHtml.includes('data-kind="hold"'));
    if (status === 'open') assert.ok(todayHtml.includes('영업 단계 확인</button>'));
    h.run("openOutcome(leadFixture.id,'hold'); saveOutcome(leadFixture.id,'hold'); unhold(leadFixture.id);");
    assert.equal(h.host.hidden, true, '처리할 수 없는 보류 폼을 열지 않는다');
    assert.equal(h.run('outbox.size()'), 0, '리드·활동 쓰기를 만들지 않는다');
    assert.deepEqual(h.read('state.leads[0]'), before);
    assert.ok(h.messages.every(message => message === '영업 단계를 먼저 확인해 주세요'));
  }
});

test('등록 후 관리 선택지는 기존 사용자 값을 보존하며 다른 정보 수정으로 지우지 않는다', () => {
  const h = harness(); prepareLead(h);
  h.run("state.leads[0]={...state.leads[0],pipeline:'academy',stage:'won',status:'won',outcome:{status:'won',at:'2026-09-01'},academyStatus:'휴원 상담중'};");
  const html = h.run('leadFormHtml(leadById(leadFixture.id))');
  const option = html.match(/<option value="([^"]+)" selected>휴원 상담중<\/option>/);
  assert.ok(option, '알려지지 않은 기존 값도 선택된 선택지로 남긴다');
  assert.ok(html.includes('<option value="이탈위험">이탈위험</option>'));
  assert.ok(html.includes('등록 후 관리 상태') && html.includes('영업 단계와 별도로 관리'));
  h.field('f-name', lead.name); h.field('f-acad', option[1]); h.field('f-memo', '관계 메모만 수정');
  h.run('openLeadForm(leadFixture.id); saveLeadForm(leadFixture.id);');
  assert.equal(h.run('leadById(leadFixture.id).academyStatus'), '휴원 상담중');
  assert.equal(h.run('leadById(leadFixture.id).stage'), 'won');
  assert.equal(h.run('leadById(leadFixture.id).outcome.at'), '2026-09-01');
  assert.equal(h.run('leadById(leadFixture.id).memo'), '관계 메모만 수정');
});

test('이탈위험 관리 상태를 바꿔도 등록 성사와 판정일은 유지한다', () => {
  const h = harness(); prepareLead(h);
  h.run("state.leads[0]={...state.leads[0],pipeline:'academy',stage:'won',status:'won',outcome:{status:'won',at:'2026-09-01'},academyStatus:'재원'};");
  h.field('f-name', lead.name); h.field('f-acad', '이탈위험');
  h.run('openLeadForm(leadFixture.id); saveLeadForm(leadFixture.id);');
  assert.equal(h.run('leadById(leadFixture.id).academyStatus'), '이탈위험');
  assert.equal(h.run('leadById(leadFixture.id).stage'), 'won');
  assert.equal(h.run('leadById(leadFixture.id).status'), 'won');
  assert.equal(h.run('leadById(leadFixture.id).outcome.at'), '2026-09-01');
});

test('WB 속성이 모두 있어도 선택지 보강을 기존 속성 API로 실행할 수 있다', async () => {
  const h = harness(); prepareAutomation(h);
  assert.match(h.run('viewHubspot()'), /data-act="hs-props-create"[^>]*>속성 선택지 맞추기<\/button>/);
  h.run("api=async(path,body)=>{captureRequest(path,body);return {created:[],updated:['wb_academy_status']};};");
  await h.click('hs-props-create');
  assert.deepEqual(h.requests, [{path:'/api/hubspot/properties',body:{}}, {path:'/api/hubspot/properties',body:undefined}]);
});

test('리드 저장은 최초 편집 버전을 보내고 새 기록은 버전 0을 보낸다', async () => {
  const h = harness(); prepareLead(h);
  h.run("queueChange('leads',leadFixture.id,{...leadFixture,memo:'내 입력'}); state.meta[C.docKey('leads',leadFixture.id)]=99; queueChange('leads','qa_new',{name:'가상 신규'}); api=async(path,body)=>{captureRequest(path,body); return {results:body.changes.map(c=>({c:c.c,id:c.id,updatedAt:100}))};};");
  await h.run('flush()');
  const changes = h.requests[0].body.changes;
  assert.equal(changes[0].expectedUpdatedAt, 12);
  assert.equal(changes[1].expectedUpdatedAt, 0);
  assert.equal(h.run('outbox.size()'), 0);
});

test('저장 중 새 편집은 남기고 앞선 저장 성공 버전으로만 다음 저장을 잇는다', async () => {
  const h = harness(); prepareLead(h);
  h.run("queueChange('leads',leadFixture.id,{...leadFixture,memo:'첫 입력'}); api=async(path,body)=>{captureRequest(path,body); return new Promise(resolve=>{finishWrite=resolve;});};");
  const pending = h.run('flush()');
  h.run("queueChange('leads',leadFixture.id,{...leadFixture,memo:'더 최근 입력'}); finishWrite({results:[{c:'leads',id:leadFixture.id,updatedAt:20}]});");
  await pending;
  assert.equal(h.run('outbox.size()'), 1);
  assert.equal(h.run('outbox.snapshot()[0].data.memo'), '더 최근 입력');
  assert.equal(h.run('outbox.snapshot()[0].expectedUpdatedAt'), 20);
  h.run('api=async(path,body)=>{captureRequest(path,body);return {results:body.changes.map(c=>({c:c.c,id:c.id,updatedAt:21}))};};');
  await h.run('flush()');
  assert.equal(h.requests[1].body.changes[0].expectedUpdatedAt, 20);
  assert.equal(h.requests[1].body.changes[0].data.memo, '더 최근 입력');
  assert.equal(h.run('outbox.size()'), 0);
});

test('충돌은 최신 서버값을 표시하며 입력 초안·원래 기준값을 별도로 보존한다', async () => {
  const h = harness(); prepareLead(h);
  h.run("queueChange('leads',leadFixture.id,{...leadFixture,memo:'보존할 첫 입력'}); api=async(path,body)=>{captureRequest(path,body); return new Promise(resolve=>{finishWrite=resolve;});};");
  const pending = h.run('flush()');
  h.run("queueChange('leads',leadFixture.id,{...leadFixture,memo:'보존할 최신 입력'}); finishWrite({results:[{c:'leads',id:leadFixture.id,code:'STALE',error:'다른 기기 변경',current:{data:{...leadFixture,memo:'HubSpot 최신 내용'},updatedAt:30}}]});");
  await pending;
  assert.equal(h.run('leadById(leadFixture.id).memo'), 'HubSpot 최신 내용');
  const conflict = h.read("ui.leadConflicts[C.docKey('leads',leadFixture.id)]");
  assert.equal(conflict.draft.memo, '보존할 최신 입력');
  assert.equal(conflict.base.memo, '기존 메모');
  assert.equal(h.run('outbox.size()'), 0);
  await h.run('flush()');
  assert.equal(h.requests.length, 1, '충돌 초안을 자동 재전송하지 않는다');
});

test('일시적 서버 작업 충돌과 통신 실패는 입력과 최초 버전을 재시도 큐에 남긴다', async () => {
  for (const code of ['SYNC_BUSY', 'NETWORK']) {
    const h = harness(); prepareLead(h);
    h.context.errorCode = code;
    h.run("queueChange('leads',leadFixture.id,{...leadFixture,memo:'재시도할 입력'}); api=async()=>{if(errorCode==='NETWORK')throw Object.assign(new Error('연결 실패'),{code:errorCode}); return {results:[{c:'leads',id:leadFixture.id,code:errorCode,error:'다른 작업 진행 중'}]};};");
    await h.run('flush()');
    const queued = h.read('outbox.snapshot()');
    assert.equal(queued.length, 1, code);
    assert.equal(queued[0].expectedUpdatedAt, 12, code);
    assert.equal(queued[0].data.memo, '재시도할 입력', code);
    assert.equal(h.run('leadById(leadFixture.id).memo'), '재시도할 입력', code);
  }
});

test('고객 폼을 작성하는 동안 받은 원격 변경을 오래된 폼 값으로 덮지 않는다', () => {
  const h = harness(); prepareLead(h);
  h.field('f-name', lead.name); h.field('f-memo', lead.memo);
  h.run('openLeadForm(leadFixture.id)');
  h.fields.get('f-memo').value = '폼에서 작성한 메모';
  h.run("applyDocs([{c:'leads',id:leadFixture.id,data:{...leadFixture,name:'원격에서 변경한 이름'},updatedAt:30}],30); saveLeadForm(leadFixture.id);");
  const queued = h.read('outbox.snapshot()');
  if (queued.length) {
    assert.equal(queued[0].expectedUpdatedAt, 12, '폼을 열 때 버전으로 충돌을 검사한다');
    assert.equal(queued[0].data.memo, '폼에서 작성한 메모');
  } else {
    const conflict = h.read("ui.leadConflicts[C.docKey('leads',leadFixture.id)]");
    assert.equal(conflict.draft.memo, '폼에서 작성한 메모');
    assert.equal(conflict.base.name, lead.name);
    assert.equal(h.run('leadById(leadFixture.id).name'), '원격에서 변경한 이름');
  }
});

test('충돌 초안만 남아 있어도 새로고침 전에 저장되지 않은 입력을 알린다', () => {
  const h = harness(); prepareLead(h);
  h.run("ui.leadConflicts[C.docKey('leads',leadFixture.id)]={id:leadFixture.id,draft:{...leadFixture,memo:'보관된 입력'},base:leadFixture};");
  let prevented = false;
  const event = { preventDefault() { prevented = true; } };
  h.handlers.beforeunload(event);
  assert.equal(prevented, true);
  assert.equal(event.returnValue, '');
});

function prepareConflict(h, deleted = false) {
  prepareLead(h);
  h.context.remoteDeleted = deleted;
  h.run("ui.leadConflicts[C.docKey('leads',leadFixture.id)]={id:leadFixture.id,draft:{...leadFixture,memo:'내가 작성한 메모'},base:{...leadFixture},deleted:false}; applyDocs([{c:'leads',id:leadFixture.id,data:{...leadFixture,name:'원격의 최신 이름'},updatedAt:30,deleted:remoteDeleted}],30); openLeadConflict(leadFixture.id);");
}

test('충돌 검토 후 내 수정만 저장하면 변경하지 않은 원격 필드는 유지한다', async () => {
  const h = harness(); prepareConflict(h);
  await h.run('resolveLeadConflict(leadFixture.id,true)');
  const queued = h.read('outbox.snapshot()');
  assert.equal(queued.length, 1);
  assert.equal(queued[0].data.name, '원격의 최신 이름');
  assert.equal(queued[0].data.memo, '내가 작성한 메모');
  assert.equal(queued[0].expectedUpdatedAt, 30);
  assert.equal(h.run('Object.keys(ui.leadConflicts).length'), 0);
});

test('최신 서버값을 선택하면 초안만 정리하고 쓰기 요청을 만들지 않는다', async () => {
  const h = harness(); prepareConflict(h);
  await h.run('resolveLeadConflict(leadFixture.id,false)');
  assert.equal(h.run('outbox.size()'), 0);
  assert.equal(h.run('Object.keys(ui.leadConflicts).length'), 0);
  assert.equal(h.run('leadById(leadFixture.id).name'), '원격의 최신 이름');
});

test('충돌 뒤 서버에서 삭제된 고객을 초안 재저장으로 되살리지 않는다', async () => {
  const h = harness(); prepareConflict(h, true);
  await h.run('resolveLeadConflict(leadFixture.id,true)');
  assert.equal(h.run('outbox.size()'), 0);
  assert.equal(h.run('leadById(leadFixture.id)'), null);
  assert.equal(h.run('Object.keys(ui.leadConflicts).length'), 1, '복구할 수 없는 초안도 조용히 버리지 않는다');
});

test('내가 바꾼 자녀 이름만 재적용하고 원격에서 바뀐 학년은 보존한다', async () => {
  const h = harness(); prepareLead(h);
  h.run("baseChild={...leadFixture,child:{name:'기존 가상 학생',grade:'초3',school:'가상 학교'}}; ui.leadConflicts[C.docKey('leads',leadFixture.id)]={id:leadFixture.id,base:baseChild,draft:{...baseChild,child:{...baseChild.child,name:'수정한 가상 학생'}}}; applyDocs([{c:'leads',id:leadFixture.id,data:{...baseChild,child:{...baseChild.child,grade:'초4'}},updatedAt:30}],30); openLeadConflict(leadFixture.id);");
  await h.run('resolveLeadConflict(leadFixture.id,true)');
  const child = h.read('outbox.snapshot()[0].data.child');
  assert.deepEqual(child, { name: '수정한 가상 학생', grade: '초4', school: '가상 학교' });
});

test('충돌 비교창을 연 뒤 서버가 다시 바뀌면 새 비교 확인 전에는 전송하지 않는다', async () => {
  const h = harness(); prepareConflict(h);
  h.run("applyDocs([{c:'leads',id:leadFixture.id,data:{...leadFixture,name:'더 최신인 원격 이름',memo:'그동안 바뀐 메모'},updatedAt:40}],40);");
  await h.run('resolveLeadConflict(leadFixture.id,true)');
  assert.equal(h.run('outbox.size()'), 0);
  assert.equal(h.run('Object.keys(ui.leadConflicts).length'), 1);
  assert.ok(h.host.innerHTML.includes('그동안 바뀐 메모'));
  assert.ok(h.messages.some(message => message.includes('다시 확인')));
  await h.run('resolveLeadConflict(leadFixture.id,true)');
  const entry = h.read('outbox.snapshot()[0]');
  assert.equal(entry.expectedUpdatedAt, 40);
  assert.equal(entry.data.name, '더 최신인 원격 이름');
  assert.equal(entry.data.memo, '내가 작성한 메모');
});

test('STALE current가 null이면 삭제로 처리하고 초안은 보존하되 자동 복원하지 않는다', async () => {
  const h = harness(); prepareLead(h);
  h.run("queueChange('leads',leadFixture.id,{...leadFixture,memo:'삭제 전 내 입력'}); api=async()=>({results:[{c:'leads',id:leadFixture.id,code:'STALE',error:'원본 없음',current:null}]});");
  await h.run('flush()');
  assert.equal(h.run('leadById(leadFixture.id)'), null);
  assert.equal(h.run("ui.leadConflicts[C.docKey('leads',leadFixture.id)].draft.memo"), '삭제 전 내 입력');
  assert.equal(h.run('outbox.size()'), 0);
  h.run('openLeadConflict(leadFixture.id)');
  await h.run('resolveLeadConflict(leadFixture.id,true)');
  assert.equal(h.run('outbox.size()'), 0);
  assert.ok(!h.host.innerHTML.includes('data-act="lead-conflict-save"'));
});

test('결과 미확정 전송은 재시도를 숨기고 일반 실패의 재시도는 남긴다', () => {
  const h = harness(); prepareAutomation(h);
  h.run("ui.hs.filter='failed'; ui.hs.queue=[{id:'qa_uncertain',leadId:'qa_parent',kind:'contact',status:'failed',error:'UNCERTAIN_CONTACT',payload:{fields:[]}},{id:'qa_retry',leadId:'qa_parent',kind:'contact',status:'failed',error:'HTTP 429',payload:{fields:[]}}];");
  const html = h.run('viewHubspot()');
  const buttons = [...html.matchAll(/<button\b[^>]*data-act="hs-q"[^>]*>/g)].map(x => x[0]);
  assert.ok(!buttons.some(button => button.includes('data-id="qa_uncertain"') && button.includes('data-op="retry"')));
  assert.ok(buttons.some(button => button.includes('data-id="qa_retry"') && button.includes('data-op="retry"')));
  assert.equal(buttons.filter(button => button.includes('data-op="reject"')).length, 2);
});

test('실패 전송 취소는 원본 확인을 요청하고 확인했을 때만 reviewed를 보낸다', async () => {
  const h = harness(); prepareAutomation(h);
  h.run("ui.hs.queue=[{id:'qa_uncertain',status:'failed'}]; confirms=[]; confirm=message=>{confirms.push(message);return false;}; api=async(path,body)=>{captureRequest(path,body);return {ok:true};};");
  await h.click('hs-q', { op: 'reject', id: 'qa_uncertain' });
  assert.equal(h.requests.length, 0);
  assert.ok(h.read('confirms')[0].includes('실제 반영 여부'));
  h.run('confirm=()=>true;');
  await h.click('hs-q', { op: 'reject', id: 'qa_uncertain' });
  assert.deepEqual(h.requests, [{ path: '/api/hubspot/queue', body: { op: 'reject', ids: ['qa_uncertain'], reviewed: true } }]);
});
