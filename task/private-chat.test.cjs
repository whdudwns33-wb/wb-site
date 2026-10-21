'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {create}=require('./private-chat.js');
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
function fixture(override){
  let auth={mode:'person',id:'A',token:crypto.randomUUID()}, visible=true, allowed=true, failSend=false, next=0;
  const actions=[], sends=[];
  const options={auth:()=>auth,allowed:()=>allowed,visible:()=>visible,requestId:()=>String(++next)+'_synthetic',
    post:async(url,body)=>{
      assert.equal(url,'/private-chat'); actions.push(body.action);
      if(override){const result=await override(body);if(result)return result;}
      if(body.action==='status')return {ok:true,enabled:true,locked:true};
      if(body.action==='confirm')return {ok:true,privateSession:crypto.randomUUID(),actor:{id:'A',name:'가상 A'},expiresAt:Date.now()+8*3600000,idleMs:600000};
      if(body.action==='directory')return {ok:true,directory:[{id:'B',name:'가상 B'},{id:'C',name:'가상 C'}]};
      if(body.action==='rooms')return {ok:true,rooms:[],unreadCount:0};
      if(body.action==='open')return {ok:true,room:{id:'room_'+body.recipientId,peer:{id:body.recipientId,name:'가상 '+body.recipientId}}};
      if(body.action==='messages')return {ok:true,room:{id:body.roomId,peer:{id:body.roomId.slice(-1),name:'가상 상대'}},messages:[{sequence:1,senderId:'B',body:'합성 안내',readByPeer:false}],before:null};
      if(body.action==='send'){sends.push(body.requestId);if(failSend)throw Object.assign(new Error('synthetic failure'),{status:503});}
      return {ok:true};
    }};
  const client=create(options);
  return {client,actions,sends,setAuth:value=>{auth=value;},setAllowed:value=>{allowed=value;},setVisible:value=>{visible=value;},fail:value=>{failSend=value;}};
}
async function unlock(f){await f.client.refreshAccess();f.client.show();await f.client.confirm('3847');}

test('shared admin and inspection never open, probe or poll a private room',async()=>{
  const f=fixture();
  for(const auth of [null,{mode:'admin',secret:crypto.randomUUID()},{mode:'manager_inspection',id:'A',managerId:'C'}]){
    f.setAuth(auth);await f.client.refreshAccess();f.client.show();await f.client.tick();
    assert.equal(f.client.state.opened,false);assert.equal(f.client.state.available,false);
  }
  assert.equal(f.actions.length,0);
});
test('person switch and lock erase drafts, contents, counts and delayed responses',async()=>{
  const response=deferred(); let delay=false;
  const f=fixture(body=>body.action==='messages'&&delay?response.promise:null);
  await unlock(f);await f.client.open('B');
  f.client.state.draft='합성 초안';f.client.state.unreadCount=7;
  delay=true;const pending=f.client.messages();
  f.setAuth({mode:'person',id:'B',token:crypto.randomUUID()});await f.client.tick();
  response.resolve({ok:true,room:{id:'room_B',peer:{id:'B',name:'가상 B'}},messages:[{sequence:2,body:'늦은 합성 응답'}],before:null});
  await pending;
  assert.equal(f.client.state.locked,true);assert.equal(f.client.state.opened,false);
  assert.equal(f.client.state.messages.length,0);assert.equal(f.client.state.draft,'');assert.equal(f.client.state.unreadCount,0);
});
test('room switch discards delayed old-room messages and its unsent draft',async()=>{
  const response=deferred();let delay=false;
  const f=fixture(body=>body.action==='messages'&&body.roomId==='room_B'&&delay?response.promise:null);
  await unlock(f);await f.client.open('B');f.client.state.draft='다른 방 합성 초안';
  delay=true;const old=f.client.messages();await f.client.open('C');
  response.resolve({ok:true,room:{id:'room_B',peer:{id:'B',name:'가상 B'}},messages:[{sequence:99,body:'늦은 합성 응답'}],before:null});await old;
  assert.equal(f.client.state.room.id,'room_C');assert.equal(f.client.state.messages.some(row=>row.sequence===99),false);assert.equal(f.client.state.draft,'');
});
test('a delayed confirmation cannot unlock a new person',async()=>{
  const response=deferred();const f=fixture(body=>body.action==='confirm'?response.promise:null);
  await f.client.refreshAccess();f.client.show();const confirmation=f.client.confirm('3847');
  f.setAuth({mode:'person',id:'B',token:crypto.randomUUID()});await f.client.tick();
  response.resolve({ok:true,privateSession:crypto.randomUUID(),actor:{id:'A',name:'가상 A'},expiresAt:Date.now()+10000,idleMs:600000});await confirmation;
  assert.equal(f.client.state.locked,true);assert.equal(f.client.state.actor,null);
});
test('failed sends preserve exact request id for retry and never fall back to another channel',async()=>{
  const f=fixture();await unlock(f);await f.client.open('B');f.client.state.draft='합성 https://example.invalid/?a=1&b=2#test';
  f.fail(true);await f.client.send();assert.equal(f.client.state.draft.length>0,true);
  f.fail(false);await f.client.send();assert.equal(f.sends.length,2);assert.equal(f.sends[0]===f.sends[1],true);
  assert.equal(f.client.state.draft,'');assert.equal(f.actions.some(action=>/sms|push|center|invite/i.test(action)),false);
});
test('only opened visible loaded message sequences are acknowledged, never a supplied reader identity',async()=>{
  const read=[];const f=fixture(body=>{if(body.action==='read')read.push(body);return null;});
  await unlock(f);await f.client.open('B');
  await f.client.read([9]);f.setVisible(false);await f.client.read([1]);assert.equal(read.length,0);
  f.setVisible(true);await f.client.read([1]);assert.equal(read.length,1);
  assert.equal('readerId' in read[0],false);assert.equal(read[0].sequences.length,1);
  f.client.close();await f.client.read([1]);assert.equal(read.length,1);
});
test('idle polling cannot extend the ten-minute unlock; hidden state stops private polls',async()=>{
  const original=Date.now;let now=1000000;Date.now=()=>now;
  try{
    const f=fixture();await unlock(f);await f.client.open('B');
    f.setVisible(false);const before=f.actions.length;await f.client.tick();assert.equal(f.actions.length,before+1);
    assert.equal(f.actions.at(-1),'logout');assert.equal(f.client.state.messages.length,0);
    f.setVisible(true);await unlock(f);now+=9*60000;await f.client.tick();assert.equal(f.actions.includes('touch'),false);
    now+=60000;await f.client.tick();assert.equal(f.client.state.locked,true);assert.equal(f.client.state.messages.length,0);
    const after=f.actions.length;await f.client.tick();assert.equal(f.actions.length,after);
  }finally{Date.now=original;}
});
test('the live UI measures visible message rectangles, reuses safe links and keeps secrets out of persistent storage',()=>{
  const ui=fs.readFileSync(path.join(__dirname,'private-chat.js'),'utf8');
  const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
  assert.match(ui,/getBoundingClientRect/);assert.match(ui,/data-private-incoming/);
  assert.match(ui,/options\.bodyHtml\(item\.body\)/);
  assert.doesNotMatch(ui,/localStorage|sessionStorage|console\.|window\.open|fetch\(/);
  assert.match(html,/id="privateChatOpen" hidden/);
  assert.match(html,/bodyHtml: centerChatBodyHtml/);
  assert.match(html,/function resetCenterChatState\(\) \{\s*if \(window\.WBPrivateChat\) window\.WBPrivateChat\.lock\(\)/);
  assert.match(ui,/event\.key==='Escape'/);assert.match(ui,/node\.inert=true/);
});

test('server revocation, feature disablement and lost room membership erase cached private content',async()=>{
  for(const failure of [{status:401},{status:404,code:'PRIVATE_CHAT_DISABLED'},{status:503,code:'PRIVATE_CHAT_NOT_CONFIGURED'},{status:404,code:'PRIVATE_CHAT_NOT_FOUND'}]){
    let revoked=false;
    const f=fixture(body=>{if(revoked&&body.action==='messages')throw Object.assign(new Error('synthetic revocation'),failure);return null;});
    await unlock(f);await f.client.open('B');f.client.state.draft='합성 폐기 초안';
    revoked=true;await f.client.messages();
    assert.equal(f.client.state.locked,true);assert.equal(f.client.state.messages.length,0);assert.equal(f.client.state.draft,'');
  }
});

test('C2 switching during delayed sends restores busy/pending; old success and room errors cannot alter the new room',async()=>{
  for(const failure of [null,{status:404,code:'PRIVATE_CHAT_NOT_FOUND'},{status:403,code:'PRIVATE_CHAT_ROOM_FORBIDDEN'}]){
    const old=deferred();let started=false;
    const f=fixture(async body=>{
      if(body.action==='send'&&body.roomId==='room_B') {started=true;await old.promise;if(failure)throw Object.assign(new Error('synthetic old room failure'),failure);return {ok:true};}
      return null;
    });
    await unlock(f);await f.client.open('B');f.client.state.draft='옛 방 합성 전송';
    const pending=f.client.send();assert.equal(started,true);assert.equal(f.client.state.busy,true);
    const oldRequest=f.client.state.pending.requestId;
    await f.client.open('C');assert.equal(f.client.state.busy,false);assert.equal(f.client.state.pending,null);
    f.client.state.draft='새 방 합성 전송';await f.client.send();
    assert.equal(f.sends.length,1);assert.notEqual(f.sends[0],oldRequest);
    f.client.state.draft='새 방 보존 초안';f.client.state.unreadCount=3;
    const before=JSON.stringify(f.client.state);
    old.resolve();await pending;
    assert.equal(JSON.stringify(f.client.state),before);assert.equal(f.client.state.room.id,'room_C');
  }
});

test('C2 a delayed old-room send still locks on actual current private-session expiry',async()=>{
  const old=deferred();const f=fixture(async body=>{
    if(body.action==='send'&&body.roomId==='room_B'){await old.promise;throw Object.assign(new Error('synthetic expired session'),{status:401,code:'PRIVATE_CHAT_LOCKED'});}
    return null;
  });
  await unlock(f);await f.client.open('B');f.client.state.draft='합성';const pending=f.client.send();
  await f.client.open('C');f.client.state.draft='새 방 초안';old.resolve();await pending;
  assert.equal(f.client.state.locked,true);assert.equal(f.client.state.room,null);assert.equal(f.client.state.draft,'');assert.equal(f.client.state.busy,false);
});

test('C3 only trusted pointer/key/wheel/touch input renews idle, never render/scroll/poll or synthetic events; absolute expiry remains',async()=>{
  const original=Date.now;let now=1000000;Date.now=()=>now;
  try{
    for(const type of ['pointerdown','keydown','wheel','touchstart','touchmove']){
      now=1000000;const f=fixture();await unlock(f);
      now+=9*60000;await f.client.activity({type,isTrusted:true});
      assert.equal(f.actions.filter(x=>x==='touch').length,1);
      now+=2*60000;await f.client.tick();assert.equal(f.client.state.locked,false);
    }
    now=1000000;const f=fixture();await unlock(f);
    now+=9*60000;
    for(const type of ['pointerdown','keydown','wheel','touchstart','touchmove'])await f.client.activity({type,isTrusted:false});
    await f.client.activity({type:'scroll',isTrusted:true});await f.client.activity();await f.client.tick();
    assert.equal(f.actions.includes('touch'),false);
    now+=60000;await f.client.tick();assert.equal(f.client.state.locked,true);
    now=1000000;const g=fixture();await unlock(g);
    for(let i=0;i<95;i++){now+=5*60000;await g.client.activity({type:'wheel',isTrusted:true});assert.equal(g.client.state.locked,false);}
    now+=5*60000;await g.client.activity({type:'touchmove',isTrusted:true});assert.equal(g.client.state.locked,true);
  }finally{Date.now=original;}
});

test('C3 live init listeners pass original trusted/untrusted wheel/touch/key/pointer events to activity with passive listeners',async()=>{
  const vm=require('node:vm'), listeners=new Map();
  const root={hidden:true,querySelector:()=>null,contains:()=>false,addEventListener:(type,fn,options)=>{
    const list=listeners.get(type)||[];list.push({fn,options});listeners.set(type,list);
  }};
  const context=vm.createContext({module:{exports:{}},Set,Map,Promise,setInterval:()=>0,
    window:{addEventListener:()=>{}},document:{createElement:()=>root,body:{appendChild:()=>{},children:[]},addEventListener:()=>{},contains:()=>false}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'private-chat.js'),'utf8'),context);
  const client=context.module.exports.init({auth:()=>null,allowed:()=>false,entry:{style:{},addEventListener:()=>{}},post:async()=>({ok:true})});
  const received=[];client.activity=event=>received.push(event);
  for(const type of ['pointerdown','keydown','wheel','touchstart','touchmove'])for(const isTrusted of [true,false]){
    const event={type,isTrusted};const handler=listeners.get(type)[0];handler.fn(event);
    assert.equal(handler.options.passive,true);assert.equal(received.at(-1),event);
  }
  const before=received.length;listeners.get('scroll')[0].fn({type:'scroll',isTrusted:true});assert.equal(received.length,before);
});

function transportFixture() {
  const vm=require('node:vm'), core=require('./staff-work-session-core.js');
  const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
  const post=html.match(/async post\(path, body, isCurrent\) \{[\s\S]*?\n  \},/)[0];
  const rejection=html.match(/function handlePersonAuthRejection\(error, managerRoleSeen, knownProblem\) \{[\s\S]*?\n}/)[0];
  let auth={mode:'person',id:'A',token:crypto.randomUUID()}, responder;
  const business={cache:'합성 업무 캐시',unsent:'합성 업무 미전송',device:true},stats={worklock:0,reset:0,reload:0};
  const context=vm.createContext({staffWorkCore:core,session:{isStaffLink:true},SYNC_URL:'http://synthetic.invalid',
    shouldGateStaffWork:()=>false,fetch:async()=>responder(),
    lockStaffWork:()=>{stats.worklock++;},resetPersonCache:()=>{stats.reset++;business.cache='';business.unsent='';business.device=false;},
    classifyPersonLinkError:()=>({kind:'auth_required'}),closeModal:()=>{},render:()=>{},location:{reload:()=>{stats.reload++;}},
    personAccessProblem:null,__auth:()=>auth,AbortController,setTimeout,clearTimeout});
  vm.runInContext(rejection+';globalThis.transport={auth:__auth,'+post+'};',context);
  const response=(status,data)=>({status,json:async()=>data});
  return {post:body=>context.transport.post('/private-chat',body),stats,business,auth:()=>auth,
    switch:()=>{auth={mode:'person',id:'B',token:crypto.randomUUID()};},respond:fn=>{responder=fn;},response};
}

test('C1 actual sync.post keeps business auth/cache for private PIN/session/room failures but preserves real parent rejection and work lock',async()=>{
  for(const [status,code] of [[401,'PRIVATE_CHAT_PIN_INCORRECT'],[401,'PRIVATE_CHAT_LOCKED'],[403,'PRIVATE_CHAT_ROOM_FORBIDDEN'],[404,'PRIVATE_CHAT_NOT_FOUND']]){
    const t=transportFixture(),before=JSON.stringify(t.business);
    t.respond(()=>t.response(status,{ok:false,code,authScope:'private_chat'}));
    await assert.rejects(t.post({auth:t.auth(),action:'confirm'}),error=>error.status===status);
    assert.deepEqual(t.stats,{worklock:0,reset:0,reload:0});assert.equal(JSON.stringify(t.business),before);
  }
  for(const data of [{ok:false,code:'PERSON_AUTH_REJECTED'},{ok:false,code:'PRIVATE_CHAT_LOCKED'}]){
    const t=transportFixture();t.respond(()=>t.response(401,data));
    await assert.rejects(t.post({auth:t.auth()}));assert.deepEqual(t.stats,{worklock:0,reset:1,reload:1});assert.equal(t.business.device,false);
  }
  const t=transportFixture();t.respond(()=>t.response(409,{ok:false,code:'STAFF_WORK_LOGIN_REQUIRED'}));
  await assert.rejects(t.post({auth:t.auth()}));assert.deepEqual(t.stats,{worklock:1,reset:0,reload:0});
});

test('C1 actual sync.post discards delayed A rejection before transport cleanup of new B auth/cache',async()=>{
  for(const code of ['PERSON_AUTH_REJECTED','STAFF_WORK_LOGIN_REQUIRED']){
    const t=transportFixture(),late=deferred();t.respond(()=>late.promise);
    const old=t.post({auth:t.auth()});t.switch();const before=JSON.stringify(t.business);
    late.resolve(t.response(code==='PERSON_AUTH_REJECTED'?401:409,{ok:false,code}));
    await assert.rejects(old);assert.deepEqual(t.stats,{worklock:0,reset:0,reload:0});assert.equal(JSON.stringify(t.business),before);assert.equal(t.auth().id,'B');
  }
});


test('v0.2 next poll rejects old role-config session and erases all private cached state without switching work identity',async()=>{
  let removed=false;
  const f=fixture(body=>{if(removed&&body.action==='rooms')throw Object.assign(new Error('synthetic role config changed'),{status:401,code:'PRIVATE_CHAT_LOCKED',authScope:'private_chat'});return null;});
  await unlock(f);await f.client.open('B');f.client.state.draft='합성 옛 역할 초안';f.client.state.unreadCount=9;
  f.client.state.pending={body:'합성',requestId:'synthetic'};removed=true;await f.client.tick();
  assert.equal(f.client.state.locked,true);assert.equal(f.client.state.room,null);assert.equal(f.client.state.actor,null);
  for(const key of ['directory','rooms','messages'])assert.deepEqual(f.client.state[key],[]);
  assert.equal(f.client.state.unreadCount,0);assert.equal(f.client.state.draft,'');assert.equal(f.client.state.pending,null);
  assert.equal(f.client.state.busy,false);assert.equal(f.actions.at(-1),'logout');
});


test('RP-QA-1 same-auth access recovery re-probes status once without restoring private session, draft or work auth',async()=>{
  const requests=[];const f=fixture(body=>{requests.push(body);return null;});
  await unlock(f);await f.client.open('B');f.client.state.draft='합성 복구 전 초안';f.client.state.unreadCount=4;f.client.state.pending={requestId:'synthetic',body:'합성'};
  const originalAuth=JSON.stringify(requests[0].auth);f.setAllowed(false);await f.client.tick();
  assert.equal(f.client.state.available,false);assert.equal(f.client.state.locked,true);
  const afterDenial=f.actions.length;f.setAllowed(true);await f.client.refreshAccess();
  assert.deepEqual(f.actions.slice(afterDenial),['status']);assert.equal(f.client.state.available,true);
  assert.equal(JSON.stringify(requests.at(-1).auth)===originalAuth,true);assert.equal(requests.at(-1).privateSession,'');
  assert.equal(f.client.state.actor,null);assert.equal(f.client.state.room,null);assert.equal(f.client.state.draft,'');assert.equal(f.client.state.pending,null);assert.equal(f.client.state.unreadCount,0);
  for(const key of ['rooms','directory','messages'])assert.deepEqual(f.client.state[key],[]);
  f.client.show();assert.equal(f.client.state.opened,true);assert.equal(f.client.state.locked,true);
  for(let i=0;i<20;i++)await f.client.refreshAccess();assert.deepEqual(f.actions.slice(afterDenial),['status']);
  await f.client.confirm('3847');assert.equal(f.client.state.locked,false);assert.equal(f.actions.filter(x=>x==='confirm').length,2);
});

test('RP-QA-1 denied epoch discards old same-auth confirmation even after access re-probe; explicit confirmation remains required',async()=>{
  const old=deferred();let delay=true;
  const f=fixture(body=>body.action==='confirm'&&delay?old.promise:null);
  await f.client.refreshAccess();f.client.show();const pending=f.client.confirm('3847');
  f.setAllowed(false);await f.client.tick();f.setAllowed(true);await f.client.refreshAccess();
  delay=false;old.resolve({ok:true,privateSession:crypto.randomUUID(),actor:{id:'A',name:'가상 A'},expiresAt:Date.now()+10000,idleMs:600000});await pending;
  assert.equal(f.client.state.available,true);assert.equal(f.client.state.locked,true);assert.equal(f.client.state.actor,null);assert.equal(f.client.state.busy,false);
  assert.equal(f.actions.includes('directory'),false);assert.equal(f.actions.includes('touch'),false);
  f.client.show();await f.client.confirm('3847');assert.equal(f.client.state.locked,false);
});

test('RP-QA-1 failed recovery status remains an error and cannot auto-confirm, retry-storm, touch or restore contents',async()=>{
  let fail=false;const f=fixture(body=>{if(fail&&body.action==='status')throw Object.assign(new Error('synthetic unavailable'),{status:503,code:'PRIVATE_CHAT_UNAVAILABLE',authScope:'private_chat'});return null;});
  await unlock(f);await f.client.open('B');f.setAllowed(false);await f.client.tick();f.setAllowed(true);fail=true;
  const before=f.actions.length;await f.client.refreshAccess();for(let i=0;i<20;i++)await f.client.refreshAccess();
  assert.deepEqual(f.actions.slice(before),['status']);assert.equal(f.client.state.available,false);assert.equal(f.client.state.locked,true);assert.notEqual(f.client.state.error,'');
  assert.equal(f.client.state.room,null);assert.equal(f.client.state.actor,null);assert.equal(f.client.state.draft,'');
});
