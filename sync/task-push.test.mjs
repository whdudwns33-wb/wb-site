import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handleTaskPush, dispatchTaskPush, safeEndpoint, vapid, digest } from './task-push.js';
import worker from './worker-core.js';
const schema=fs.readFileSync(new URL('./schema.sql',import.meta.url),'utf8');
const migration=fs.readFileSync(new URL('./migrations/082_task_live_push.sql',import.meta.url),'utf8');
class DB {
  constructor(){this.sql=new DatabaseSync(':memory:');this.sql.exec(schema);}
  prepare(sql){const q=this.sql.prepare(sql);let args=[];return {
    bind(...v){args=v;return this;}, first(){return q.get(...args)||null;},
    all(){return {results:q.all(...args)};},run(){return {meta:{changes:Number(q.run(...args).changes)}};}
  };}
}
const response=(body,status)=>new Response(JSON.stringify(body),{status});
const endpoint=id=>'https://fcm.googleapis.com/wp/'+id;
const auth=id=>({mode:'person',id,token:'synthetic-token-'+id});
async function env(){
  const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  return {DB:new DB(),TASK_PUSH_PRIVATE_JWK:JSON.stringify(await crypto.subtle.exportKey('jwk',pair.privateKey)),
    TASK_PUSH_PUBLIC_KEY:Buffer.from(await crypto.subtle.exportKey('raw',pair.publicKey)).toString('base64url'),
    TASK_MANAGER_STAFF_IDS_CONFIG:'manager-a,manager-b',TASK_ADMIN_SECRET:'synthetic-secret',key:pair.publicKey};
}
async function subscribe(e,id){
  const now=Date.now(), manager=id.startsWith('manager');
  e.DB.prepare('INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task',id,id,JSON.stringify({id,name:'Synthetic',deleted:false}),now,now).run();
  e.DB.prepare('INSERT INTO tokens(app,token,staff_id,created_at,revoked) VALUES(?,?,?,?,0)')
    .bind('task','sha256:'+await digest(auth(id).token),id,now).run();
  const result=await handleTaskPush(e,'task',{auth:auth(id),action:'subscribe',endpoint:endpoint(id)},'',{id,scope:manager?'all':'own'},response);
  assert.equal(result.status,200,await result.clone().text());
}
function teacherRequest(e,id='tlr_test0001'){
  e.DB.prepare('INSERT INTO teacher_live_requests(app,request_id,lesson_task_id,lesson_date,student_id,sender_staff_id,recipient_admin_id,body,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .bind('task',id,'lesson-test','2026-10-13','synthetic-student','teacher-a','manager-a','synthetic request',Date.now()).run();
}
function adminRequest(e){
  const now=Date.now(), date=new Date(now+32400000).toISOString().slice(0,10);
  e.DB.prepare("INSERT INTO admin_directives(app,directive_id,status,current_revision,created_at,created_by,updated_at,updated_by) VALUES('task','adr_test0001','active',1,?,'director',?,'director')").bind(now,now).run();
  e.DB.prepare("INSERT INTO admin_directive_revisions(app,directive_id,revision,title,body,priority,starts_date,audience_staff_ids,created_at,created_by) VALUES('task','adr_test0001',1,'Synthetic','Synthetic','normal',?,?,?,'director')")
    .bind(date,JSON.stringify(['teacher-a']),now).run();
}
test('migration is additive, idempotent, and schema mirrors it',()=>{
  assert.ok(schema.replace(/\r/g,'').includes(migration.replace(/\r/g,'').trim()));
  assert.doesNotMatch(migration,/DROP|DELETE FROM|UPDATE staff/i);
  const db=new DB();db.sql.exec(migration);db.sql.exec(migration);db.sql.close();
});
test('director account push subscription uses a revocable hashed session without storing its token',async()=>{
  const e=await env(), token='d'.repeat(64), tokenHash=await digest(token);
  e.DB.prepare("INSERT INTO task_director_account(id,login_id,salt,password_hash,must_change) VALUES(1,'synthetic','salt','hash',0)").run();
  e.DB.prepare("INSERT INTO task_director_sessions VALUES(?,'session','synthetic',1,?,0)").bind(tokenHash,Date.now()+60000).run();
  const result=await handleTaskPush(e,'task',{auth:{mode:'task_director',token},action:'subscribe',endpoint:endpoint('director-account')},'',{scope:'all'},response);
  assert.equal(result.status,200);
  const stored=e.DB.prepare('SELECT * FROM task_push_subscriptions WHERE staff_id=?').bind('director').first();
  assert.equal(stored.auth_kind,'admin');assert.equal(stored.auth_hash,'director:'+tokenHash);
  assert.ok(!JSON.stringify(stored).includes(token));
  e.DB.prepare('UPDATE task_director_sessions SET revoked=1').run();
  teacherRequest(e);
  const originalFetch=globalThis.fetch;
  globalThis.fetch=()=>{throw new Error('revoked session must not receive push');};
  try { assert.equal((await dispatchTaskPush(e,Date.now())).accepted,0); }
  finally {globalThis.fetch=originalFetch;}
});
test('push endpoint allows only known HTTPS providers, not redirects or local services',()=>{
  for(const value of ['http://fcm.googleapis.com/wp/a','https://localhost/wp/a','https://fcm.googleapis.com.evil.test/wp/a','https://u:p@fcm.googleapis.com/wp/a','https://fcm.googleapis.com:444/wp/a','https://fcm.googleapis.com/wp/a#x']) assert.equal(safeEndpoint(value),false,value);
  assert.equal(safeEndpoint(endpoint('abc')),true);
});
test('VAPID verifies and contains only push provider origin and short expiry',async()=>{
  const e=await env();const now=Date.now();
  const header=await vapid(e,endpoint('test'),now);
  const jwt=header.slice(8).split(',')[0], [h,p,s]=jwt.split('.');
  assert.equal(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},e.key,Buffer.from(s,'base64url'),new TextEncoder().encode(h+'.'+p)),true);
  const claims=JSON.parse(Buffer.from(p,'base64url'));
  assert.equal(claims.aud,'https://fcm.googleapis.com');
  assert.equal(claims.exp,Math.floor(now/1000)+3600);
  e.DB.sql.close();
});
test('unauthenticated worker cannot subscribe; consult and inspection cannot register',async()=>{
  const e=await env();
  const r=await worker.fetch(new Request('https://example.test/task-push',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({app:'task',action:'subscribe',endpoint:endpoint('x')})}),e,{waitUntil(){}});
  assert.equal(r.status,401);
  const wrong=await handleTaskPush(e,'consult',{auth:auth('a')},'',{id:'a',scope:'own'},response);
  assert.equal(wrong.status,403); e.DB.sql.close();
});
test('requests queue once atomically; teacher requests notify all managers; no personal payload',async()=>{
  const e=await env();
  for(const id of ['teacher-a','teacher-b','manager-a','manager-b']) await subscribe(e,id);
  teacherRequest(e);adminRequest(e);
  assert.equal(e.DB.prepare('SELECT COUNT(*) n FROM task_push_jobs').first().n,3);
  const calls=[];
  const result=await dispatchTaskPush(e,Date.now(),async(url,options)=>{calls.push({url,options});return new Response(null,{status:201});});
  assert.equal(result.accepted,3);
  assert.deepEqual(calls.map(x=>x.url).sort(),['manager-a','manager-b','teacher-a'].map(endpoint).sort());
  for(const c of calls){assert.equal(c.options.body,undefined);assert.equal(c.options.redirect,'error');}
  await dispatchTaskPush(e,Date.now(),()=>assert.fail('no duplicate'));
  e.DB.sql.close();
});
test('revoked sessions, changed manager role and ended requests never receive',async()=>{
  const e=await env();for(const id of ['teacher-a','manager-a','manager-b']) await subscribe(e,id);
  teacherRequest(e);adminRequest(e);
  e.DB.prepare("UPDATE tokens SET revoked=1 WHERE staff_id='manager-a'").run();
  e.TASK_MANAGER_STAFF_IDS_CONFIG='manager-a';
  e.DB.prepare("UPDATE admin_directives SET status='ended',updated_at=updated_at+1,ended_at=updated_at+1,ended_by='director' WHERE directive_id='adr_test0001'").run();
  assert.equal((await dispatchTaskPush(e,Date.now(),()=>assert.fail('not authorized'))).accepted,0);
  e.DB.sql.close();
});
test('provider failures retry at most three times; 410 disables only that endpoint',async()=>{
  const e=await env();await subscribe(e,'manager-a');await subscribe(e,'manager-b');teacherRequest(e);
  let n=0, now=Date.now();
  const f=async url=>{n++;return new Response(null,{status:url.endsWith('manager-a')?503:410});};
  await dispatchTaskPush(e,now,f);
  await dispatchTaskPush(e,now+600001,f);
  await dispatchTaskPush(e,now+1200002,f);
  await dispatchTaskPush(e,now+1800003,f);
  assert.equal(n,4);
  assert.equal(e.DB.prepare("SELECT active FROM task_push_subscriptions WHERE staff_id='manager-b'").first().active,0);
  assert.equal(e.DB.prepare("SELECT COUNT(*) n FROM task_push_jobs WHERE status='failed'").first().n,1);
  e.DB.sql.close();
});
test('same endpoint cannot move owners; subscribing again preserves pending jobs',async()=>{
  const e=await env();await subscribe(e,'manager-a');teacherRequest(e);
  const body={auth:auth('manager-a'),action:'subscribe',endpoint:endpoint('manager-a')};
  const repeated=await handleTaskPush(e,'task',body,'',{id:'manager-a',scope:'all'},response);
  assert.equal(repeated.status,200);
  assert.equal(e.DB.prepare("SELECT COUNT(*) n FROM task_push_jobs WHERE status='pending'").first().n,1);
  const foreign=await handleTaskPush(e,'task',{...body,auth:auth('manager-b')},'',{id:'manager-b',scope:'all'},response);
  assert.equal(foreign.status,409);e.DB.sql.close();
});
test('disabled configuration leaves request storage working and sends nothing',async()=>{
  const e=await env();e.TASK_PUSH_PRIVATE_JWK='';teacherRequest(e);
  assert.deepEqual(await dispatchTaskPush(e),{accepted:0});e.DB.sql.close();
});
test('concurrent dispatchers claim a queued notification only once',async()=>{
  const e=await env();await subscribe(e,'manager-a');teacherRequest(e);
  let calls=0;
  const send=async()=>{calls++;return new Response(null,{status:201});};
  await Promise.all([dispatchTaskPush(e,Date.now(),send),dispatchTaskPush(e,Date.now(),send)]);
  assert.equal(calls,1);
  e.DB.sql.close();
});
