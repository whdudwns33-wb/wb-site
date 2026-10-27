import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import {handleCustomerCard,readCustomerSource,CUSTOMER_APPS} from './customer-card.mjs';
import {handleApi} from './crm-api.mjs';

function fixture(){
  const db=new DatabaseSync(':memory:');
  for(let twice=0;twice<2;twice++)for(const file of fs.readdirSync(new URL('./migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())db.exec(fs.readFileSync(new URL('./migrations/'+file,import.meta.url),'utf8'));
  const DB={prepare(sql){return {args:[],bind(...args){this.args=args;return this;},async first(){return db.prepare(sql).get(...this.args)||null;},async all(){return {results:db.prepare(sql).all(...this.args)};},async run(){return {meta:{changes:Number(db.prepare(sql).run(...this.args).changes)}};}};}};
  const lead={name:'가상보호자',hubspot:{contactId:'1234'}};
  for(const id of ['ld_fake_a','ld_fake_b'])db.prepare("INSERT INTO crm_documents(collection,id,data,updated_at,updated_by,deleted) VALUES('leads',?,?,1,'admin',0)").run(id,JSON.stringify(lead));
  const calls=[];let studentName='가상첫째',wrongStudent=false,sourceBroken=false;
  const env={DB,WB_ACADEMY_READ_KEY:'synthetic-academy-token-123456789012345',WB_CS_READ_KEY:'synthetic-cs-token-1234567890123456789',CUSTOMER_FETCH:async(url,init)=>{
    calls.push({url,init});const u=new URL(url);
    assert.equal(init.redirect,'manual');assert.equal('body' in init,false);assert.ok(!init.headers.Cookie);
    if(u.hostname==='cs.wbcowork.com')return Response.json({contractVersion:1,contactId:'1234',readOnly:true,total:1,items:[{id:'ticket_fake',category:'학원',stage:'new',organization:'reading',createdAt:1000,examResult:'must-not-leak'}]});
    if(sourceBroken)return Response.json({private:'must-not-leak'},{status:503});
    const appId=u.pathname.split('/')[3],resource=u.searchParams.get('resource'),id=u.searchParams.get('id')||'event_fake';
    return Response.json({contractVersion:1,readOnly:true,appId,resource,total:1,items:[resource==='students'?{appId,id,name:studentName,grade:'초등',status:'재원',phone:'private-phone',examResult:'must-not-leak'}:{appId,id,studentId:wrongStudent?'another-student':u.searchParams.get('studentId'),status:'출석',date:'2026-10-27',examResult:'must-not-leak',memo:'private-note'}]});
  }};
  const call=async(path,body,role='admin')=>{
    const request=new Request('https://crm.test/api/customer-card'+path,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
    const r=await handleCustomerCard(request,env,{role,staffId:'admin'});return {status:r.status,data:await r.json()};
  };
  return {db,env,calls,call,setName:v=>studentName=v,setWrong:v=>wrongStudent=v,setBroken:v=>sourceBroken=v};
}
test('원장 전용·고정 원본·명시 자녀 연결·CAS·복제 없는 조회·해제·개인정보 투영',async()=>{
  const f=fixture(),{call,db,env,calls}=f;
  const before=db.prepare('SELECT * FROM crm_documents ORDER BY id').all();
  assert.equal((await call('?leadId=ld_fake_a',null,'staff')).status,403);
  assert.equal(calls.length,0);
  const m=await call('/member',{leadId:'ld_fake_a',name:'가상첫째',kind:'child',requestId:'fake-request-one'});
  assert.equal(m.status,200);const memberId=m.data.member.id;
  assert.equal((await call('/member',{leadId:'ld_fake_a',name:'가상첫째',kind:'child',requestId:'fake-request-one'})).data.member.id,memberId);
  assert.equal((await call('/member',{leadId:'ld_fake_a',name:'다른이름',kind:'child',requestId:'fake-request-one'})).status,409);
  for(const appId of Object.keys(CUSTOMER_APPS).filter(id=>id!=='center')){
    const preview=await call('/source?leadId=ld_fake_a&appId='+appId+'&sourceId=student_fake');assert.equal(preview.status,200);
    const body={leadId:'ld_fake_a',memberId,appId,sourceId:'student_fake',expectedUpdatedAt:0,identityConfirmed:true,active:true,identityFingerprint:preview.data.source.identityFingerprint};
    assert.equal((await call('/link',{...body,identityConfirmed:false})).status,400);
    const saved=await call('/link',body);assert.equal(saved.status,200);
    assert.equal((await call('/link',body)).status,409,'응답 유실 뒤 재조회 없이 재연결하지 않는다');
  }
  const card=await call('?leadId=ld_fake_a');assert.equal(card.status,200);assert.equal(card.data.sources.length,5);assert.equal(card.data.cs.scope,'guardian');
  assert.ok(card.data.sources.every(s=>s.student.name==='가상첫째'));
  assert.doesNotMatch(JSON.stringify(card.data),/must-not-leak|private-phone|private-note|examResult/);
  f.setWrong(true);const wrong=await readCustomerSource(env,'reading','student_fake');assert.equal(wrong.records.attendance.status,'unavailable');f.setWrong(false);
  const link=card.data.sources[0];
  assert.equal((await call('/link',{leadId:'ld_fake_a',memberId,appId:link.appId,sourceId:link.sourceId,expectedUpdatedAt:link.updatedAt,identityConfirmed:true,active:false})).status,200);
  assert.equal((await call('?leadId=ld_fake_a')).data.sources.find(s=>s.id===link.id).status,'disconnected');
  const preview=(await call('/source?leadId=ld_fake_a&appId=reading&sourceId=student_new')).data.source;
  f.setName('가상다른아이');assert.equal((await call('/link',{leadId:'ld_fake_a',memberId,appId:'reading',sourceId:'student_new',expectedUpdatedAt:0,active:true,identityConfirmed:true,identityFingerprint:preview.identityFingerprint})).status,409);
  const another=(await call('/member',{leadId:'ld_fake_b',name:'가상둘째',kind:'child',requestId:'fake-request-two'})).data.member.id;
  assert.equal((await call('/link',{leadId:'ld_fake_b',memberId:another,appId:'reading',sourceId:'student_fake',expectedUpdatedAt:0,active:true,identityConfirmed:true,identityFingerprint:preview.identityFingerprint})).status,409);
  assert.deepEqual(db.prepare('SELECT * FROM crm_documents ORDER BY id').all(),before,'원본 고객 문서는 수정하지 않는다');
  assert.equal(db.prepare('SELECT count(*) AS n FROM crm_sync_queue').get().n,0);
  const unauth=await handleApi(new Request('https://crm.test/api/customer-card?leadId=ld_fake_a'),env,{});assert.equal(unauth.status,401);
  db.close();
});
test('미설정·원본 오류·다른 학생 응답·임의 URL은 실패로 구분하고 포털 읽기 키를 재사용한다',async()=>{
  const f=fixture();delete f.env.WB_ACADEMY_READ_KEY;
  assert.equal((await f.call('/source?leadId=ld_fake_a&appId=reading&sourceId=student_fake')).data.code,'NOT_CONFIGURED');
  assert.equal(f.calls.length,0);
  for(const id of ['https://evil.invalid','../secret'])assert.equal((await f.call('/source?leadId=ld_fake_a&appId=reading&sourceId='+encodeURIComponent(id))).status,400);
  assert.equal((await f.call('/source?leadId=ld_fake_a&appId=center&sourceId=100')).data.code,'NOT_CONFIGURED');
  assert.equal((await f.call('/source?leadId=ld_fake_a&appId=__proto__&sourceId=student')).status,400);
  f.env.WB_ACADEMY_READ_KEY='synthetic-academy-token-123456789012345';f.setBroken(true);
  const broken=await f.call('/source?leadId=ld_fake_a&appId=reading&sourceId=student_fake');assert.equal(broken.status,502);assert.doesNotMatch(JSON.stringify(broken),/private/);
  f.db.close();
});
test('센터를 읽기 연결해도 기존 HubSpot 쓰기 소유권·고객·큐는 바뀌지 않고 역방향은 활성 연결만 연다',async()=>{
  const f=fixture();f.env.WB_SALESDESK_READ_KEY='synthetic-portal-read-key-only';
  const summary={schemaVersion:1,familyId:'101',hubspot:{contactId:'1234',appointments:[]},membership:{friend:'active',supporter:'available'},app:{installation:'unknown',launchObserved:true},benefits:{parentAccess:'active',brainAppsEligible:true},cs:{pendingCount:0,nextContactDate:null},brunch:{attendedCount:1},examResult:'must-not-leak'};
  f.env.PORTAL_FETCH=async(url,init)=>{assert.equal(url,'https://portal.wbcowork.com/api/integrations/salesdesk/families/101');assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');return Response.json(summary);};
  const preview=await f.call('/source?leadId=ld_fake_a&appId=center&sourceId=101');assert.equal(preview.status,200);assert.equal(preview.data.source.identityRequiresManualCheck,true);
  const m=(await f.call('/member',{leadId:'ld_fake_a',name:'가상센터자녀',kind:'child',requestId:'center_request'})).data.member;
  const saved=await f.call('/link',{leadId:'ld_fake_a',memberId:m.id,appId:'center',sourceId:'101',expectedUpdatedAt:0,identityConfirmed:true,active:true,identityFingerprint:preview.data.source.identityFingerprint});assert.equal(saved.status,200);
  const resolved=await f.call('/resolve?appId=center&sourceId=101');assert.equal(resolved.data.leadId,'ld_fake_a');
  assert.doesNotMatch(JSON.stringify((await f.call('?leadId=ld_fake_a')).data),/must-not-leak|examResult/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM crm_portal_links').get().n,0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM crm_sync_queue').get().n,0);
  assert.equal((await f.call('/link',{leadId:'ld_fake_a',memberId:m.id,appId:'center',sourceId:'101',expectedUpdatedAt:saved.data.link.updatedAt,identityConfirmed:true,active:false})).status,200);
  assert.equal((await f.call('/resolve?appId=center&sourceId=101')).status,404);
  assert.equal((await f.call('/resolve?appId=center&sourceId=101',null,'staff')).status,403);
  f.db.close();
});
test('응답 크기·리다이렉트·중복 조건·잘못된 입력을 거절한다',async()=>{
  const f=fixture();
  assert.equal((await f.call('/source?leadId=ld_fake_a&appId=reading&sourceId=student_fake&sourceId=other')).status,400);
  assert.equal((await f.call('/member',{leadId:['ld_fake_a'],name:'가상',kind:'child',requestId:'request'})).status,400);
  assert.equal((await f.call('/member?leadId=ld_fake_a')).status,405);
  let requests=0;f.env.CUSTOMER_FETCH=async()=>{requests++;return new Response(null,{status:302,headers:{location:'https://evil.invalid'}});};
  assert.equal((await f.call('/source?leadId=ld_fake_a&appId=reading&sourceId=student_fake')).status,502);assert.equal(requests,1);
  f.env.CUSTOMER_FETCH=async()=>new Response('x'.repeat(262145),{headers:{'content-type':'application/json'}});
  assert.equal((await f.call('/source?leadId=ld_fake_a&appId=reading&sourceId=student_fake')).status,502);
  f.db.close();
});
