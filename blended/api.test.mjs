import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApi,today } from './api.mjs';
import { openDatabase,seedDemo } from './local-db.mjs';
import http from 'node:http';
import { createLocalServer } from './server.mjs';
import { planDelivery,deliveryTransition } from './delivery-contract.mjs';

function fixture(t) {
  const db=openDatabase(); seedDemo(db); const api=createApi(db), tokens={}; t.after(()=>db.close());
  const call=(who,action,payload={},requestId=randomUUID())=>api.handle({app:'blended',action,payload,requestId},tokens[who]);
  for(const id of ['owner','admin','teacher-a','teacher-b','student-a','student-b','guardian-a','guardian-b']) tokens[id]=call('', 'login',{login:id,password:`Demo-${id}-2026!`}).sessionToken;
  const row=(table,id)=>db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
  return {db,api,tokens,call,row};
}
const rejects=(fn,code)=>assert.throws(fn,e=>e.code===code);
const draft=(subject='수학')=>({studentId:'student-a',subject,heldAt:today()+'T16:00:00+09:00',periodStart:today(),periodEnd:today(),internalNote:'PRIVATE_NOTE_MUST_NOT_LEAK',public:{studentVoice:'가상 학생 의견',facts:'개념 정리를 확인했습니다.',strengths:'질문을 구체적으로 했어요.',guidance:'풀이 과정을 설명해 봅니다.',home:'',nextGoal:'개념을 설명하고 두 문제 풀기',due:today(),nextCheck:today()}});
function publish(f) {
  const id=f.call('teacher-a','consult_save',draft()).id;
  f.call('teacher-a','consult_complete',{id,revision:1});
  f.call('teacher-a','review',{id,revision:2});
  const report=f.call('owner','publish',{id,revision:3,reason:''});
  return {id,report};
}
test('individual login, hashed credentials/sessions, wrong app, expired and logged-out tokens',t=>{
  const f=fixture(t);
  assert.notEqual(f.tokens['teacher-a'],f.tokens['teacher-b']);
  assert.ok(!f.row('users','teacher-a').password.includes('Demo-'));
  assert.ok(!f.db.prepare('SELECT hash FROM sessions').all().some(r=>r.hash===f.tokens.owner));
  rejects(()=>f.api.handle({app:'consult',action:'state'},f.tokens.owner),'APP');
  rejects(()=>f.api.handle({app:'blended',action:'state'},'consult-token'),'AUTH');
  f.call('teacher-a','logout'); rejects(()=>f.call('teacher-a','state'),'AUTH');
  f.db.prepare('UPDATE sessions SET expires=0 WHERE user_id=?').run('teacher-b');
  rejects(()=>f.call('teacher-b','state'),'AUTH');
});
test('teacher A cannot read or modify teacher B student, subject, reports, or private notes',t=>{
  const f=fixture(t),s=f.call('teacher-a','state');
  assert.deepEqual(s.students.map(x=>x.id),['student-a']);
  assert.deepEqual(s.learning.map(x=>x.id),['learning-a']);
  rejects(()=>f.call('teacher-a','check',{id:'learning-b',revision:1,feedback:'invalid'}),'SCOPE');
  rejects(()=>f.call('teacher-a','learning_create',{studentId:'student-b',subject:'영어',title:'test',due:today()}),'SCOPE');
  rejects(()=>f.call('teacher-a','consult_save',draft('영어')),'SCOPE');
  const c=f.call('teacher-b','consult_save',{...draft('영어'),studentId:'student-b'}).id;
  for(const action of ['consult_get','report_get']) rejects(()=>f.call('teacher-a',action,{id:c}),'SCOPE');
  rejects(()=>f.call('teacher-a','summary',{studentId:'student-b',subject:'영어',start:today(),end:today()}),'SCOPE');
  assert.ok(!JSON.stringify(s).includes('PRIVATE_NOTE'));
});
test('admin manages teachers but cannot elevate role, touch owner, or publish',t=>{
  const f=fixture(t);
  const c=f.call('admin','teacher_create',{name:'가상 새 강사',login:'new-teacher',password:'Synthetic-password!',role:'teacher'});
  assert.equal(f.row('users',c.id).role,'teacher');
  const login=f.call('', 'login',{login:'new-teacher',password:'Synthetic-password!'});
  assert.equal(login.me.id,c.id);
  for(const role of ['owner','admin','student']) rejects(()=>f.call('admin','teacher_create',{name:'가상',login:'blocked-account',password:'Synthetic-password!',role}),'ROLE');
  rejects(()=>f.call('admin','teacher_status',{id:'owner',revision:1,active:false}),'ROLE');
  const {id}=publish(f); rejects(()=>f.call('admin','publish',{id,revision:4}),'FORBIDDEN');
});
test('active teacher assignments honor subject, start/end and revocation immediately, preserving authors',t=>{
  const f=fixture(t),{id}=publish(f);
  const request={studentId:'student-a',subject:'수학',title:'가상 추가',due:today()},key=randomUUID();
  f.call('teacher-a','learning_create',request,key);
  f.call('owner','unassign',{id:'assignment-a',revision:1});
  assert.equal(f.call('teacher-a','state').students.length,0);
  rejects(()=>f.call('teacher-a','consult_get',{id}),'SCOPE');
  rejects(()=>f.call('teacher-a','learning_create',request,key),'SCOPE');
  assert.equal(f.row('consultations',id).author,'teacher-a');
  f.call('owner','assign',{teacherId:'teacher-a',studentId:'student-a',subject:'수학',starts:'2099-01-01',ends:'2099-12-31'});
  assert.equal(f.call('teacher-a','state').students.length,0);
  f.call('owner','assign',{teacherId:'teacher-a',studentId:'student-a',subject:'수학',starts:'2020-01-01',ends:'2020-12-31'});
  assert.equal(f.call('teacher-a','state').students.length,0);
  f.call('owner','teacher_status',{id:'teacher-a',revision:1,active:false});
  rejects(()=>f.call('teacher-a','state'),'AUTH');
  rejects(()=>f.call('', 'login',{login:'teacher-a',password:'Demo-teacher-a-2026!'}),'LOGIN');
});
test('student only self-reports; instructor check and external integration remain distinct',t=>{
  const f=fixture(t);
  f.call('student-a','perform',{id:'learning-a',revision:1,done:true,question:'가상 질문'});
  let l=f.row('learning','learning-a'); assert.equal(l.self_done,1);assert.equal(l.checked,0);
  rejects(()=>f.call('student-a','check',{id:l.id,revision:l.revision,feedback:'self'}),'FORBIDDEN');
  rejects(()=>f.call('student-b','perform',{id:l.id,revision:l.revision,done:true}),'SCOPE');
  f.call('teacher-a','check',{id:l.id,revision:l.revision,feedback:'풀이를 확인했습니다.'});
  l=f.row('learning',l.id);assert.equal(l.checked,1);
  f.call('student-a','perform',{id:l.id,revision:l.revision,done:true,question:'추가 질문'});
  assert.equal(f.row('learning',l.id).checked,0);
  const s=f.call('teacher-a','summary',{studentId:'student-a',subject:'수학',start:'2020-01-01',end:'2020-01-02'}).summary;
  assert.equal(s.hasRecords,false);assert.equal(s.external,'미연동');
});
test('complete counseling creates one dated promise atomically, review/publish/send remain separate',t=>{
  const f=fixture(t),id=f.call('teacher-a','consult_save',draft()).id;
  const p={id,revision:1},key=randomUUID(),a=f.call('teacher-a','consult_complete',p,key);
  const b=f.call('teacher-a','consult_complete',p,key),c=f.call('teacher-a','consult_complete',p);
  assert.equal(a.learningId,b.learningId);assert.equal(a.learningId,c.learningId);
  assert.equal(f.db.prepare('SELECT count(*) n FROM learning WHERE source_consultation=?').get(id).n,1);
  assert.equal(f.row('learning',a.learningId).due,today());
  assert.equal(f.db.prepare('SELECT count(*) n FROM report_versions').get().n,0);
  rejects(()=>f.call('owner','publish',{id,revision:2}),'STATE');
  rejects(()=>f.call('owner','send',{id}),'INTEGRATION_PENDING');
});
test('failed completion rolls back promise, status and idempotency receipt, retry can finish',t=>{
  const f=fixture(t),id=f.call('teacher-a','consult_save',draft()).id,key=randomUUID();
  f.db.exec("CREATE TRIGGER fail_complete BEFORE UPDATE ON consultations BEGIN SELECT RAISE(ABORT,'synthetic disk error'); END");
  assert.throws(()=>f.call('teacher-a','consult_complete',{id,revision:1},key));
  assert.equal(f.db.prepare('SELECT count(*) n FROM learning WHERE source_consultation=?').get(id).n,0);
  assert.equal(f.row('consultations',id).status,'draft');
  assert.equal(f.db.prepare('SELECT count(*) n FROM receipts WHERE key=?').get(key).n,0);
  f.db.exec('DROP TRIGGER fail_complete');
  f.call('teacher-a','consult_complete',{id,revision:1},key);
  assert.equal(f.row('consultations',id).status,'complete');
});
test('internal notes are excluded from student/guardian state, report and audit; drafts remain private',t=>{
  const f=fixture(t),id=f.call('teacher-a','consult_save',draft()).id;
  assert.equal(f.call('guardian-a','state').reports.length,0);
  rejects(()=>f.call('student-a','consult_get',{id}),'FORBIDDEN');
  rejects(()=>f.call('guardian-a','consult_get',{id}),'FORBIDDEN');
  f.call('teacher-a','consult_complete',{id,revision:1}); f.call('teacher-a','review',{id,revision:2});
  f.call('owner','publish',{id,revision:3});
  for(const who of ['student-a','guardian-a']) {
    assert.doesNotMatch(JSON.stringify(f.call(who,'state')),/PRIVATE_NOTE|internalNote|internal_notes|password/);
    assert.doesNotMatch(JSON.stringify(f.call(who,'report_get',{id})),/PRIVATE_NOTE|internalNote|internal_notes/);
  }
  assert.match(f.call('teacher-a','consult_get',{id}).internalNote,/PRIVATE_NOTE/);
  assert.doesNotMatch(JSON.stringify(f.db.prepare('SELECT * FROM audit').all()),/PRIVATE_NOTE|개념/);
});
test('publication is immutable, revisions append with reason, withdrawal blocks all historical guardian reads',t=>{
  const f=fixture(t),{id,report}=publish(f),original=f.row('report_versions',report.id).snapshot;
  const payload={...draft(),id,revision:4}; payload.public.facts='수정된 공개 사실';
  f.call('teacher-a','consult_save',payload);
  assert.equal(f.row('report_versions',report.id).snapshot,original);
  assert.equal(f.call('guardian-a','report_get',{id}).reports[0].version,1);
  f.call('teacher-a','review',{id,revision:5});
  rejects(()=>f.call('owner','publish',{id,revision:6}),'REQUIRED');
  const key=randomUUID(),p={id,revision:6,reason:'공개 사실 정정'},r2=f.call('owner','publish',p,key);
  assert.equal(f.call('owner','publish',p,key).id,r2.id);
  rejects(()=>f.call('owner','publish',p),'CONFLICT');
  assert.equal(f.call('guardian-a','report_get',{id}).reports[0].version,2);
  assert.throws(()=>f.db.prepare('UPDATE report_versions SET snapshot=? WHERE id=?').run('{}',report.id),/immutable/);
  assert.throws(()=>f.db.prepare('DELETE FROM report_versions WHERE id=?').run(report.id),/immutable/);
  f.call('owner','withdraw',{id,revision:7,reason:'공개 범위 재검토'});
  assert.deepEqual(f.call('guardian-a','report_get',{id}).reports,[]);
  assert.equal(f.call('owner','report_get',{id}).reports.length,3);
  assert.equal(f.row('report_versions',report.id).snapshot,original);
});
test('guardian child boundary, consent withdrawal and student service end are enforced per request',t=>{
  const f=fixture(t),{id}=publish(f);
  rejects(()=>f.call('guardian-b','report_get',{id}),'SCOPE');
  f.call('owner','guardian_consent',{guardianId:'guardian-a',studentId:'student-a',revision:1,consent:false});
  assert.equal(f.call('guardian-a','state').reports.length,0);
  rejects(()=>f.call('guardian-a','report_get',{id}),'SCOPE');
  f.call('owner','guardian_consent',{guardianId:'guardian-a',studentId:'student-a',revision:2,consent:true});
  f.call('owner','student_status',{id:'student-a',revision:1,active:false});
  for(const who of ['student-a','guardian-a','teacher-a']) rejects(()=>f.call(who,'report_get',{id}),'SCOPE');
  assert.equal(f.row('consultations',id).author,'teacher-a');
});
test('optimistic concurrency and idempotency reject overwrites and mismatched retries',t=>{
  const f=fixture(t),p={id:'learning-a',revision:1,done:true,question:'first'},key=randomUUID();
  f.call('student-a','perform',p,key);
  rejects(()=>f.call('student-a','perform',{...p,question:'stale'}),'CONFLICT');
  rejects(()=>f.call('student-a','perform',{...p,question:'different'},key),'KEY_REUSE');
  assert.equal(f.row('learning','learning-a').question,'first');
  assert.equal(f.call('student-a','perform',p,key).replayed,true);
});
test('validation rejects malformed date, link, long text, privilege injection, invalid flags',t=>{
  const f=fixture(t),p={studentId:'student-a',subject:'수학',title:'가상 학습',due:today()};
  rejects(()=>f.call('teacher-a','learning_create',{...p,due:'2026-02-30'}),'DATE');
  rejects(()=>f.call('teacher-a','learning_create',{...p,linkKey:'javascript:alert(1)'}),'LINK');
  rejects(()=>f.call('teacher-a','learning_create',{...p,title:'x'.repeat(201)}),'INPUT');
  rejects(()=>f.call('owner','teacher_status',{id:'teacher-a',revision:1,active:'false'}),'INPUT');
  rejects(()=>f.call('student-a','teacher_create',{role:'owner'}),'FORBIDDEN');
  rejects(()=>f.call('teacher-a','consult_save',{...draft(),periodStart:'2026-12-31',periodEnd:'2026-01-01'}),'PERIOD');
});
test('login throttles repeated failures without exposing credentials',t=>{
  const f=fixture(t);
  for(let i=0;i<5;i++) rejects(()=>f.call('','login',{login:'teacher-a',password:'wrong-password'}),'LOGIN');
  rejects(()=>f.call('','login',{login:'teacher-a',password:'Demo-teacher-a-2026!'}),'RATE');
});
test('HTTP app/cookie/cache/static isolation, CSRF, failure sanitization',async t=>{
  const f=fixture(t),server=createLocalServer(f.db); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=async(body,cookie='',extra={})=>fetch(base+'/blended/api',{method:'POST',headers:{'Content-Type':'application/json','X-Blended-Request':'1',Cookie:cookie,...extra},body:JSON.stringify(body)});
  const login=await post({app:'blended',action:'login',payload:{login:'owner',password:'Demo-owner-2026!'}});
  const cookie=login.headers.get('set-cookie'); assert.match(cookie,/HttpOnly/);assert.match(cookie,/Path=\/blended\//);assert.match(cookie,/SameSite=Strict/);
  assert.equal((await login.json()).sessionToken,undefined);
  assert.equal(login.headers.get('cache-control'),'no-store');
  const body={app:'blended',action:'state'};
  assert.equal((await post(body,cookie)).status,200);
  assert.equal((await post(body,'consult_session=anything')).status,401);
  assert.equal((await post({...body,app:'consult'},cookie)).status,400);
  assert.equal((await post(body,cookie,{Origin:'https://untrusted.example'})).status,403);
  assert.equal((await post(body,cookie,{'X-Blended-Request':''})).status,403);
  const wrongHost = await new Promise(resolve => { const req=http.request(base+'/blended/',{headers:{Host:'untrusted.example'}},res=>{res.resume();resolve(res.statusCode);});req.end(); });
  assert.equal(wrongHost,403);
  for(const url of ['/consult/','/sync','/parent/consult-guardian/','/blended/schema.sql','/blended/api.mjs','/blended/.local/blended-demo.sqlite','/blended/../.git/config']) assert.equal((await fetch(base+url)).status,404,url);
  const page=await fetch(base+'/blended/'); assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/connect-src 'self'/);
  f.db.exec("CREATE TRIGGER fail_save BEFORE INSERT ON learning BEGIN SELECT RAISE(ABORT,'PRIVATE_NOTE_MUST_NOT_LEAK'); END");
  const failed=await post({app:'blended',action:'learning_create',payload:{studentId:'student-a',subject:'수학',title:'가상',due:today()},requestId:randomUUID()},cookie);
  assert.equal(failed.status,503); assert.doesNotMatch(await failed.text(),/PRIVATE_NOTE/);
});
test('delivery contract requires fresh source consent/contact and current report; unknown never retries automatically',()=>{
  const request={report:{id:'synthetic-report',version:1,status:'published'},currentVersion:1,eligibility:{guardianId:'synthetic-guardian',studentActive:true,relationshipVerified:true,consent:true,blocked:false,contactVerified:true,checkedAt:100000,contactRevision:2},now:100001,actorRole:'owner',academyConnected:true};
  const ready=planDelivery(request);assert.equal(ready.status,'ready');assert.equal(ready.key,planDelivery(request).key);
  assert.equal(planDelivery({...request,academyConnected:false}).reason,'integration_pending');
  assert.equal(planDelivery({...request,actorRole:'teacher'}).reason,'permission');
  assert.equal(planDelivery({...request,currentVersion:2}).reason,'stale_report');
  assert.equal(planDelivery({...request,now:200001}).reason,'recheck_required');
  for(const changed of [{consent:false},{contactVerified:false},{studentActive:false},{relationshipVerified:false},{blocked:true}]) assert.equal(planDelivery({...request,eligibility:{...request.eligibility,...changed}}).reason,'ineligible');
  assert.notEqual(ready.contactRevision,planDelivery({...request,eligibility:{...request.eligibility,contactRevision:3}}).contactRevision);
  assert.equal(deliveryTransition('submitting','accepted'),'accepted');
  assert.equal(deliveryTransition('accepted','timeout'),'unknown');
  assert.equal(deliveryTransition('unknown','submit'),'unknown');
  assert.equal(deliveryTransition('unknown','reconciled_delivered'),'delivered');
  assert.equal(deliveryTransition('delivered','acknowledged'),'acknowledged');
});
test('production starts empty, secret-gated setup is single-use, registration and password changes use individual accounts',t=>{
  const db=openDatabase();t.after(()=>db.close());
  const api=createApi(db,{mode:'production',ownerLogin:'whdudwns33',bootstrapToken:'synthetic-bootstrap'});
  const call=(action,payload={},token='')=>api.handle({app:'blended',action,payload,requestId:randomUUID()},token);
  assert.deepEqual(call('runtime'),{mode:'production',ready:false});
  rejects(()=>call('setup',{token:'wrong',password:'Synthetic-owner-password!'}),'SETUP');
  call('setup',{token:'synthetic-bootstrap',password:'Synthetic-owner-password!'});
  rejects(()=>call('setup',{token:'synthetic-bootstrap',password:'Synthetic-owner-password!'}),'SETUP_DONE');
  let token=call('login',{login:'whdudwns33',password:'Synthetic-owner-password!'}).sessionToken;
  assert.equal(call('state',{},token).students.length,0);
  const student=call('student_create',{login:'new-student',name:'가상 등록 학생',password:'Synthetic-student-password!'},token);
  assert.equal(call('login',{login:'new-student',password:'Synthetic-student-password!'}).me.id,student.id);
  rejects(()=>call('password_change',{currentPassword:'wrong',password:'new-long-password'},token),'PASSWORD');
  call('password_change',{currentPassword:'Synthetic-owner-password!',password:'  password with spaces  '},token);
  rejects(()=>call('state',{},token),'AUTH');
  token=call('login',{login:'whdudwns33',password:'  password with spaces  '}).sessionToken;
  assert.equal(call('state',{},token).me.role,'owner');
  rejects(()=>call('login',{login:'teacher-a',password:'Demo-teacher-a-2026!'}),'LOGIN');
});
