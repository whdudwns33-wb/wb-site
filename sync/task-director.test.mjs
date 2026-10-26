import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleTaskDirector, hashPassword, taskDirectorSession, TASK_ADMIN_PATHS } from './task-director.js';
import worker from './worker.js';
class D1 {
  constructor(){this.db=new DatabaseSync(':memory:');for(const file of ['089_task_director.sql','090_task_manager_accounts.sql'])this.db.exec(readFileSync(new URL('./migrations/'+file,import.meta.url),'utf8'));}
  prepare(sql){const db=this.db; let args=[];return {bind(...values){args=values;return this;},first(){return db.prepare(sql).get(...args)||null;},all(){return {results:db.prepare(sql).all(...args)};},run(){return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}};}};}
}
async function fixture(){const DB=new D1(); DB.db.prepare('INSERT INTO task_director_account(id,login_id,salt,password_hash) VALUES(1,?,?,?)').run('director','salt',await hashPassword('initial-test','salt'));return {DB,ALLOW_ORIGIN:'https://pages.example'};}
async function post(env,body,token='',path='/task-account',origin=''){
  const response=await handleTaskDirector(new Request('https://worker.example'+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token,...(origin?{Origin:origin}:{})},body:JSON.stringify(body)}),env,async request=>new Response(JSON.stringify({ok:true,body:await request.json(),path:new URL(request.url).pathname})));
  return {status:response.status,body:await response.json()};
}
test('initial password gate, password rotation, API keys, revocation, isolation and MCP',async()=>{
  const env=await fixture();
  const login=await post(env,{action:'login',loginId:'director',password:'initial-test'});
  assert.equal(login.body.mustChange,true); const initial=login.body.token;
  assert.equal(await taskDirectorSession(env,initial),null);
  assert.equal((await post(env,{action:'issue_key',label:'test'},initial)).status,403);
  assert.equal((await post(env,{path:'/sync',body:{}},initial,'/task-api')).status,401);
  assert.equal((await post(env,{action:'password',currentPassword:'initial-test',password:'new-test-password'},initial)).status,200);
  assert.equal(await taskDirectorSession(env,initial,true),null);
  assert.equal((await post(env,{action:'login',loginId:'director',password:'initial-test'})).status,401);
  const next=await post(env,{action:'login',loginId:'DIRECTOR',password:'new-test-password'}), token=next.body.token;
  assert.equal(next.body.mustChange,false);
  const issued=await post(env,{action:'issue_key',label:'automation'},token), key=issued.body.token;
  assert.equal((await post(env,{action:'keys'},key)).status,403);
  const forwarded=await post(env,{path:'/sync',body:{app:'consult',auth:{mode:'admin',secret:'bad'},changes:[]}},key,'/task-api');
  assert.equal(forwarded.body.body.app,'task'); assert.equal(forwarded.body.body.auth.mode,'task_director');
  assert.equal((await post(env,{path:'https://evil.example',body:{}},key,'/task-api')).status,400);
  assert.equal((await post(env,{path:'/consult-result',body:{}},key,'/task-api')).status,400);
  assert.equal((await post(env,{action:'keys'},token,'/task-account','https://evil.example')).status,403);
  const tools=await post(env,{jsonrpc:'2.0',id:1,method:'tools/list'},key,'/task-mcp');
  assert.equal(tools.body.result.tools[0].annotations.destructiveHint,true);
  const call=await post(env,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'task_admin_request',arguments:{path:'/sync',body:{}}}},key,'/task-mcp');
  assert.equal(call.body.result.isError,false);
  const list=await post(env,{action:'keys'},token);
  assert.equal(list.body.keys.length,1); assert.ok(!JSON.stringify(list.body).includes(key));
  await post(env,{action:'revoke_key',tokenHash:list.body.keys[0].token_hash},token);
  assert.equal((await post(env,{path:'/sync',body:{}},key,'/task-api')).status,401);
  await post(env,{action:'logout'},token); assert.equal(await taskDirectorSession(env,token),null);
});
test('login throttles each account password; unknown names do not lock another account',async()=>{
  const env=await fixture();
  for(let i=0;i<5;i++) assert.equal((await post(env,{action:'login',loginId:'wrong',password:'initial-test'})).status,401);
  assert.equal((await post(env,{action:'login',loginId:'director',password:'initial-test'})).status,200);
  for(let i=0;i<5;i++) assert.equal((await post(env,{action:'login',loginId:'director',password:'wrong-password'})).status,401);
  assert.equal((await post(env,{action:'login',loginId:'director',password:'initial-test'})).status,429);
  assert.equal(await taskDirectorSession(env,'bad'),null);
  assert.equal((await post(env,[], '', '/task-api')).status,400);
  assert.ok(TASK_ADMIN_PATHS.has('/roster'));
});
test('real Worker routes accept director sessions and keep consult and initial access blocked',async()=>{
  const env=await fixture();
  env.ALLOW_ORIGIN += ',https://worker.example';
  env.DB.db.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
  const token=(await post(env,{action:'login',loginId:'director',password:'initial-test'})).body.token;
  const request=(path,body)=>new Request('https://worker.example'+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://worker.example'},body:JSON.stringify(body)});
  let response=await worker.fetch(request('/sync',{app:'task',auth:{mode:'task_director',token},since:0,changes:[]}),env);
  assert.equal(response.status,401);
  await post(env,{action:'password',currentPassword:'initial-test',password:'new-test-password'},token);
  const next=(await post(env,{action:'login',loginId:'director',password:'new-test-password'})).body.token;
  response=await worker.fetch(request('/sync',{app:'task',auth:{mode:'task_director',token:next},since:0,changes:[]}),env);
  const payload=await response.json();
  assert.equal(response.status,200,JSON.stringify(payload)); assert.equal(payload.authRole,'admin');
  response=await worker.fetch(request('/sync',{app:'consult',auth:{mode:'task_director',token:next},since:0,changes:[]}),env);
  assert.equal(response.status,401);
});
test('task assets allow local scripts while parent asset policy stays unchanged',async()=>{
  const env={ASSETS:{fetch:async()=>new Response('asset',{headers:{'Content-Security-Policy':"default-src 'self'; script-src 'unsafe-inline'"}})}};
  const task=await worker.fetch(new Request('https://worker.example/task/'),env);
  assert.match(task.headers.get('Content-Security-Policy'),/script-src 'self' 'unsafe-inline'/);
  const parent=await worker.fetch(new Request('https://worker.example/'),env);
  assert.equal(parent.headers.get('Content-Security-Policy'),"default-src 'self'; script-src 'unsafe-inline'");
});
test('manager accounts require active configured staff, isolate passwords/keys, and keep API attribution',async()=>{
  const env=await fixture();env.DB.db.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
  env.ALLOW_ORIGIN+=',https://worker.example';env.TASK_MANAGER_STAFF_IDS_CONFIG='manager-a,manager-b';
  for(const id of ['manager-a','manager-b','ordinary']){
    env.DB.db.prepare("INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES('task',?,?,?,?,?)").run(id,id,JSON.stringify({id,owner:id,name:'가상'+id,deleted:false}),1,1);
    env.DB.db.prepare('INSERT INTO task_manager_accounts(staff_id,login_id,salt,password_hash) VALUES(?,?,?,?)').run(id,'wb'+id,'salt',await hashPassword('initial-test','salt'));
  }
  assert.equal((await post(env,{action:'login',loginId:'wbordinary',password:'initial-test'})).status,401);
  async function changeAndLogin(id){const first=await post(env,{action:'login',loginId:'wb'+id,password:'initial-test'});assert.equal(first.body.authRole,'manager');assert.equal(first.body.mustChange,true);assert.equal((await post(env,{action:'issue_key',label:'blocked'},first.body.token)).status,403);await post(env,{action:'password',currentPassword:'initial-test',password:'changed-password'},first.body.token);return (await post(env,{action:'login',loginId:'wb'+id,password:'changed-password'})).body.token;}
  const a=await changeAndLogin('manager-a'),b=await changeAndLogin('manager-b');
  const aKey=(await post(env,{action:'issue_key',label:'A'},a)).body.token;
  const bKey=(await post(env,{action:'issue_key',label:'B'},b)).body.token;
  const aKeys=(await post(env,{action:'keys'},a)).body.keys;
  assert.equal(aKeys.length,1);assert.equal(aKeys[0].label,'A');
  await post(env,{action:'revoke_key',tokenHash:aKeys[0].token_hash},b);
  assert.ok(await taskDirectorSession(env,aKey));
  const response=await worker.fetch(new Request('https://worker.example/task-api',{method:'POST',headers:{Authorization:'Bearer '+aKey,'Content-Type':'application/json'},body:JSON.stringify({path:'/sync',body:{since:0,changes:[]}})}),env);
  const payload=await response.json();assert.equal(response.status,200,JSON.stringify(payload));assert.equal(payload.authRole,'manager');
  const rootInitial=(await post(env,{action:'login',loginId:'director',password:'initial-test'})).body.token;
  await post(env,{action:'password',currentPassword:'initial-test',password:'root-changed-password'},rootInitial);
  assert.ok(await taskDirectorSession(env,aKey));assert.ok(await taskDirectorSession(env,bKey));
  await post(env,{action:'password',currentPassword:'changed-password',password:'rotated-password'},a);
  assert.equal(await taskDirectorSession(env,aKey),null);assert.ok(await taskDirectorSession(env,bKey));
  env.TASK_MANAGER_STAFF_IDS_CONFIG='manager-a';assert.equal(await taskDirectorSession(env,bKey),null);
  env.TASK_MANAGER_STAFF_IDS_CONFIG='manager-a,manager-b';
  env.DB.db.prepare("UPDATE task_manager_accounts SET active=0 WHERE staff_id='manager-b'").run();assert.equal(await taskDirectorSession(env,bKey),null);
  env.DB.db.prepare("UPDATE task_manager_accounts SET active=1 WHERE staff_id='manager-b'").run();
  env.DB.db.prepare("UPDATE staff SET data=? WHERE id='manager-b'").run(JSON.stringify({name:'가상',deleted:true}));
  assert.equal(await taskDirectorSession(env,bKey),null);
});
