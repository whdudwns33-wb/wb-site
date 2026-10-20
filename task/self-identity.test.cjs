'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const moduleUnderTest=require('./self-identity.js');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function fixture(){
  let auth={mode:'person',id:'A',token:crypto.randomUUID()},allowed=true,respond;
  const calls=[];
  const client=moduleUnderTest.create({auth:()=>auth,allowed:()=>allowed,post:async(path,body)=>{calls.push({path,action:body.action});return respond(body);}});
  const response=id=>({ok:true,identity:{status:'person',id,name:'가상 '+id,loginMethod:'personal_device',loginConfigured:false}});
  respond=()=>response(auth.id);
  return {client,calls,response,respond:fn=>{respond=fn;},switch:()=>{auth={mode:'person',id:'B',token:crypto.randomUUID()};},logout:()=>{auth=null;},expire:()=>{allowed=false;}};
}
test('read-only client makes only self query, clears on close/logout/switch/known expiry and rejects extra fields/wrong self',async()=>{
  for(const action of ['clear','logout','switch','expire']) {
    const f=fixture();await f.client.open();assert.equal(f.client.state.identity.id,'A');
    if(action==='clear')f.client.clear();else f[action]();f.client.tick();
    assert.equal(f.client.state.identity,null);assert.equal(f.calls.length,1);assert.equal(f.calls[0].path,'/self-identity');assert.equal(f.calls[0].action,undefined);
  }
  for(const extra of [{phone:'synthetic forbidden'},{id:'B'}]) {
    const f=fixture();f.respond(()=>{const r=f.response('A');Object.assign(r.identity,extra);return r;});await f.client.open();assert.equal(f.client.state.identity,null);assert.equal(!!f.client.state.error,true);
  }
});
test('late A success/error is discarded after B switch or logout; retry failure removes previous information',async()=>{
  for(const failure of [false,true])for(const action of ['switch','logout','clear']) {
    const f=fixture(),d=deferred();f.respond(async()=>{await d.promise;if(failure)throw Error('synthetic delayed');return f.response('A');});
    const old=f.client.open();if(action==='clear')f.client.clear();else f[action]();f.client.tick();d.resolve();await old;assert.equal(f.client.state.identity,null);
  }
  const f=fixture();await f.client.open();f.respond(()=>{throw Error('synthetic unavailable');});await f.client.read();assert.equal(f.client.state.identity,null);assert.equal(!!f.client.state.error,true);
});
test('identity display expires locally without touching or issuing work/private sessions',async()=>{
  const original=Date.now;let time=1000;Date.now=()=>time;
  try{const f=fixture();await f.client.open();time+=60000;f.client.tick();assert.equal(f.client.state.identity,null);assert.equal(f.calls.length,1);}finally{Date.now=original;}
});
test('late A cannot overwrite a fresh successful B result or its error state',async()=>{
  for(const failure of [false,true]) {
    const f=fixture(),d=deferred();f.respond(async()=>{await d.promise;if(failure)throw Error('old A');return f.response('A');});
    const old=f.client.open();f.switch();f.respond(()=>f.response('B'));await f.client.open();
    const before=JSON.stringify(f.client.state);d.resolve();await old;assert.equal(JSON.stringify(f.client.state),before);assert.equal(f.client.state.identity.id,'B');
  }
});
function transport(){
  const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
  const post=html.match(/async post\(path, body, isCurrent\) \{[\s\S]*?\n  \},/)[0];
  const rejection=html.match(/function handlePersonAuthRejection\(error, managerRoleSeen, knownProblem\) \{[\s\S]*?\n}/)[0];
  let auth={mode:'person',id:'A',token:crypto.randomUUID()},respond,allowed=true;
  const stats={reset:0,reload:0,lock:0},business={cache:'합성 미전송 업무',device:true};
  const context=vm.createContext({staffWorkCore:require('./staff-work-session-core.js'),session:{isStaffLink:true},SYNC_URL:'http://synthetic.invalid',
    shouldGateStaffWork:()=>!allowed,fetch:async()=>respond(),AbortController,setTimeout,clearTimeout,
    lockStaffWork:()=>{stats.lock++;},resetPersonCache:()=>{stats.reset++;business.cache='';business.device=false;},classifyPersonLinkError:()=>({kind:'auth_required'}),closeModal:()=>{},render:()=>{},location:{reload:()=>{stats.reload++;}},personAccessProblem:null,__auth:()=>auth});
  vm.runInContext(rejection+';globalThis.transport={auth:__auth,'+post+'};',context);
  return {stats,business,auth:()=>auth,allowed:()=>allowed,expire:()=>{allowed=false;stats.lock++;},switch:()=>{auth={mode:'person',id:'B',token:crypto.randomUUID()};},respond:fn=>{respond=fn;},post:(path='/self-identity',body={app:'task',auth},isCurrent)=>context.transport.post(path,body,isCurrent),response:(status,data)=>({status,json:async()=>data})};
}
test('actual sync.post separates identity-domain failures while retaining current parent rejection and required work lock',async()=>{
  for(const status of [400,401,403,503]) {
    const t=transport();t.respond(()=>t.response(status,{ok:false,authScope:'identity_check',code:'IDENTITY_UNAVAILABLE'}));await assert.rejects(t.post());assert.deepEqual(t.stats,{reset:0,reload:0,lock:0});assert.equal(t.business.device,true);
  }
  for(const status of [401,403]) {
    const t=transport();t.respond(()=>t.response(status,{ok:false,error:'synthetic origin/proxy denial'}));await assert.rejects(t.post());assert.deepEqual(t.stats,{reset:0,reload:0,lock:0});assert.equal(t.business.device,true);
  }
  const current=transport();current.respond(()=>current.response(401,{ok:false,code:'PERSON_AUTH_REJECTED'}));await assert.rejects(current.post());assert.deepEqual(current.stats,{reset:1,reload:1,lock:0});
  const work=transport();work.respond(()=>work.response(409,{ok:false,code:'STAFF_WORK_LOGIN_REQUIRED'}));await assert.rejects(work.post());assert.deepEqual(work.stats,{reset:0,reload:0,lock:1});
});
test('actual sync.post drops late A success/error before B transport side effects',async()=>{
  for(const result of [{status:401,data:{ok:false,code:'PERSON_AUTH_REJECTED'}},{status:409,data:{ok:false,code:'STAFF_WORK_LOGIN_REQUIRED'}},{status:200,data:{ok:true,identity:{id:'A'}}}]) {
    const t=transport(),d=deferred();t.respond(()=>d.promise);const old=t.post();t.switch();d.resolve(t.response(result.status,result.data));await assert.rejects(old);assert.deepEqual(t.stats,{reset:0,reload:0,lock:0});assert.equal(t.business.device,true);
  }
});
test('S3-C1 real sync.post receives the self-view lifetime before global effects, including same-auth close/reopen/expiry',async()=>{
  for(const [status,code] of [[401,'PERSON_AUTH_REJECTED'],[409,'STAFF_WORK_LOGIN_REQUIRED']])for(const transition of ['close','reopen','expiry','switch']){
    const t=transport(),late=deferred();t.respond(()=>late.promise);
    const client=moduleUnderTest.create({auth:t.auth,allowed:t.allowed,post:(path,body,isCurrent)=>t.post(path,body,isCurrent)});
    const old=client.open();
    if(transition==='expiry')t.expire();else if(transition==='switch')t.switch();else client.clear();
    if(transition==='reopen'){
      t.respond(()=>t.response(200,{ok:true,identity:{status:'person',id:'A',name:'가상 A',loginMethod:'personal_device',loginConfigured:true}}));
      await client.open();assert.equal(client.state.identity.id,'A');
    }
    const before=JSON.stringify(t.business),beforeStats={...t.stats};late.resolve(t.response(status,{ok:false,code}));await old;
    assert.deepEqual(t.stats,beforeStats);assert.equal(JSON.stringify(t.business),before);
    if(transition==='reopen'){
      assert.equal(client.state.identity.id,'A');
      t.respond(()=>t.response(status,{ok:false,code}));await client.read();
      assert.deepEqual(t.stats,status===401?{reset:1,reload:1,lock:0}:{reset:0,reload:0,lock:1});
    }else assert.equal(client.state.identity,null);
  }
});
test('S3-C1 real transport discards closed self success, but a lifetime argument cannot suppress another API protection',async()=>{
  const t=transport(),late=deferred();t.respond(()=>late.promise);
  const client=moduleUnderTest.create({auth:t.auth,allowed:t.allowed,post:(...args)=>t.post(...args)});
  const old=client.open();client.clear();late.resolve(t.response(200,{ok:true,identity:{status:'person',id:'A',name:'가상 A',loginMethod:'personal_device',loginConfigured:true}}));await old;
  assert.equal(client.state.identity,null);assert.deepEqual(t.stats,{reset:0,reload:0,lock:0});
  for(const path of ['/private-chat','/staff-profile']){
    const other=transport();other.respond(()=>other.response(401,{ok:false,code:'PERSON_AUTH_REJECTED'}));
    await assert.rejects(other.post(path,{app:'task',auth:other.auth()},()=>false));assert.equal(other.stats.reset,1);assert.equal(other.stats.reload,1);
  }
});
test('inert entry refuses even synthetic click before creating a dialog or self request',()=>{
  let click,created=0,requests=0;
  const context=vm.createContext({module:{exports:{}},setInterval:()=>0,window:{addEventListener:()=>{}},document:{addEventListener:()=>{},createElement:()=>{created++;throw Error('INERT_DIALOG_CREATED');}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'self-identity.js'),'utf8'),context);
  context.module.exports.init({entry:{closest:selector=>selector==='[inert]'?{}:null,addEventListener:(_type,fn)=>{click=fn;}},auth:()=>({mode:'person',id:'A'}),allowed:()=>true,post:()=>{requests++;}});
  click();assert.equal(created,0);assert.equal(requests,0);
});
