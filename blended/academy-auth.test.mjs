import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase,seedDemo} from './local-db.mjs';
import {createApi} from './api.mjs';
import {startHandoff,handoffNonce} from './academy-handoff.mjs';
test('학원 SSO 역할·담당·일회성·만료·브라우저 상태·권한 회수',()=>{
 const db=openDatabase();seedDemo(db);let at=Date.now();const key='c'.repeat(64),state='a'.repeat(64),api=createApi(db,{academyAuthKey:key,authNow:()=>at});
 const mint=(userId='teacher-a',studentId='student-a',role='강사')=>api.academyAuth({action:'ticket',userId,studentId,role,state},key).ticket;
 const denied=fn=>assert.throws(fn,e=>e.status===403);
 try {
  denied(()=>api.academyAuth({action:'accounts'},'d'.repeat(64)));
  denied(()=>createApi(db,{academyBridgeKey:key}).academyAuth({action:'accounts'},key));
  assert.ok(api.academyAuth({action:'accounts'},key).accounts.every(u=>!Object.hasOwn(u,'password')));
  denied(()=>mint('owner','student-a','강사'));denied(()=>mint('teacher-a','student-a','실장'));denied(()=>mint('teacher-a','student-b'));
  const code=mint();denied(()=>api.exchange(code,'b'.repeat(64)));const result=api.exchange(code,state);
  assert.equal(result.studentId,'student-a');assert.equal(api.handle({app:'blended',action:'state'},result.sessionToken).me.id,'teacher-a');denied(()=>api.exchange(code,state));
  const expired=mint();at+=60001;denied(()=>api.exchange(expired,state));
  const revoked=mint();db.prepare("UPDATE assignments SET active=0 WHERE id='assignment-a'").run();denied(()=>api.exchange(revoked,state));
  denied(()=>api.handle({app:'blended',action:'summary',payload:{studentId:'student-a',subject:'수학',start:'2026-10-01',end:'2026-10-31'}},result.sessionToken));
  const admin=api.exchange(mint('admin','student-b','실장'),state);assert.equal(api.handle({app:'blended',action:'state'},admin.sessionToken).me.role,'admin');
  denied(()=>api.handle({app:'blended',action:'teacher_create',payload:{name:'가상',login:'fake-admin',password:'Synthetic-admin-password!',role:'admin'},requestId:'deny-admin'},admin.sessionToken));
  const disabled=mint('owner','student-a','원장급');db.prepare("UPDATE users SET active=0 WHERE id='owner'").run();denied(()=>api.exchange(disabled,state));
  const start=startHandoff(new URL('https://blended.wbcowork.com/blended/academy-start?academyStudent=fake'),'https://blended-academy.wbcowork.com');assert.match(start.location,/^https:\/\/blended-academy.wbcowork.com\/ops\/students\/fake\?tab=planner&plannerState=[a-f0-9]{64}$/);assert.equal(handoffNonce(start.cookie),new URL(start.location).searchParams.get('plannerState'));assert.match(start.cookie,/Secure; HttpOnly; SameSite=Strict/);
  assert.equal(startHandoff(new URL('https://blended.wbcowork.com/?academyStudent=../evil'),'https://blended-academy.wbcowork.com'),null);
 }finally{db.close();}
});
