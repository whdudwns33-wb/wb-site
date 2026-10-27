'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'app/app.js'),'utf8').replace(/\nstartApp\(\);\s*$/,'\n');
function harness(){
  const fields=new Map(),host={innerHTML:''};
  const document={querySelector:s=>s==='#customer-card'?host:fields.get(s.slice(1))||null,addEventListener(){}};
  const ctx=vm.createContext({WBCrmCore:require('./crm-core.js'),document,window:{addEventListener(){}},confirm:()=>true,location:{hash:'#/lead/ld_fake'},setTimeout,clearTimeout});
  vm.runInContext(source,ctx);const run=s=>vm.runInContext(s,ctx);
  run("session={canApprove:true};route='lead';leadId='ld_fake';render=()=>{};toast=()=>{};");
  const field=(id,value)=>fields.set(id,{value,checked:true});
  const data={checkedAt:1000,members:[{id:'cm_fake',name:'가상<자녀>',kind:'child'}],sources:[{id:'cs_fake',memberId:'cm_fake',appId:'reading',sourceId:'source_fake',active:true,updatedAt:10,status:'unavailable'}],apps:{reading:{name:'독해력 학원',url:'https://academy.wbcowork.com/ops/'}},cs:{status:'not_configured'}};
  ctx.fixture=data;run('ui.customerCards[leadId]={data:fixture};');
  return {run,ctx,field,host};
}
test('조회 실패·미설정·미연결을 0건으로 바꾸지 않고 이름을 escape하며 원본에 쓰지 않는다',async()=>{
  const h=harness(),html=h.run('customerCardHtml(leadId)');
  assert.match(html,/가상&lt;자녀&gt;/);assert.doesNotMatch(html,/가상<자녀>/);assert.match(html,/조회 실패 · 미확인/);assert.match(html,/인증 연결 대기/);
  h.run("calls=[];api=async(path,body)=>{calls.push({path,body});return fixture;};");
  await h.run('loadCustomerCard(leadId)');
  assert.equal(h.run('calls.length'),1);assert.equal(h.run('calls[0].body'),undefined);assert.equal(h.run('outbox.size()'),0);
  h.run('session.canApprove=false;');await h.run('loadCustomerCard(leadId)');assert.equal(h.run('calls.length'),1);
});
test('표시한 원본과 폼이 다르면 연결하지 않고, 확인 체크 뒤 같은 판본만 저장한다',async()=>{
  const h=harness();
  h.run("ui.customerCards[leadId].data.sources=[];ui.customerCards[leadId].preview={memberId:'cm_fake',memberName:'가상자녀',appId:'reading',sourceId:'source_new',source:{identityFingerprint:'a'.repeat(64),url:'https://academy.wbcowork.com/ops/',student:{name:'가상자녀',grade:'초등'}}};calls=[];api=async(path,body)=>{calls.push({path,body});return path.includes('/link')?{ok:true}:fixture;};");
  h.field('cc-member','cm_fake');h.field('cc-app','reading');h.field('cc-source','changed');h.field('cc-confirm','');
  await h.run("customerCardCommand(leadId,'link')");assert.equal(h.run('calls.length'),0);assert.match(h.host.innerHTML,/원본을 다시 조회/);
  h.field('cc-source','source_new');await h.run("customerCardCommand(leadId,'link')");
  assert.equal(h.run('calls[0].path'),'/api/customer-card/link');assert.equal(h.run('calls[0].body.identityConfirmed'),true);assert.equal(h.run('calls[0].body.expectedUpdatedAt'),0);assert.equal(h.run('outbox.size()'),0);
});
test('조회 중 로그아웃하면 늦은 원본 응답이 새 세션에 남지 않는다',async()=>{
  const h=harness();h.run('api=()=>new Promise(resolve=>{finish=resolve;});');
  const task=h.run('loadCustomerCard(leadId)');h.run('session=null;ui.customerCards={};finish(fixture);');await task;
  assert.equal(h.run('Object.keys(ui.customerCards).length'),0);
});
test('앱별 역방향 진입은 고정 앱/ID 조합만 허용한다',()=>{
  const h=harness();
  for(const app of ['manager','blended','thinking','english','reading','center'])assert.equal(h.run(`customerSourceReference('#/source/${app}/source_fake').appId`),app);
  for(const hash of ['#/source/evil/id','#/source/center/../id','#/source/reading/id?token=secret'])assert.equal(h.run(`customerSourceReference(${JSON.stringify(hash)})`),null);
});
test('통합 이력은 날짜 기준·다른 앱 ID를 구분하고 영어의 같은 프론트 이력만 중복 제거한다',()=>{
  const h=harness();
  h.run("fixture.apps.english={name:'영어 학원',url:'https://aca.wbcowork.com/'};fixture.sources=[{status:'connected',appId:'english',memberId:'cm_fake',records:{attendance:{items:[{id:'same',date:'2026-10-26',status:'출석'}]},checkins:{items:[{id:'same',date:'2026-10-26',direction:'in'}]}}},{status:'connected',appId:'reading',memberId:'cm_fake',records:{attendance:{items:[{id:'same',date:'2026-10-27',status:'출석'}]}}}];fixture.cs={items:[{id:'same',createdAt:Date.UTC(2026,9,25),category:'학원',stage:'new'}]};");
  assert.equal(h.run('customerCardEvents(leadId,fixture).length'),3);
  assert.equal(h.run('customerCardEvents(leadId,fixture)[0].source'),'독해력 학원');
  assert.match(h.run('customerCardEvents(leadId,fixture)[0].dateLabel'),/업무일/);
  h.run("fixture.sources[1].records.attendance.items=Array.from({length:110},(_,i)=>({id:'e_'+i,status:'출석'}));");
  assert.equal(h.run('customerCardEvents(leadId,fixture).length'),100);
});
