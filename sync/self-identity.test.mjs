import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import worker from './worker.js';
import { staffAttendanceDate, staffAttendanceKey } from './staff-attendance.js';

const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(organization='synthetic-org-1') {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  const secret = () => randomBytes(32).toString('hex');
  const forbidden = [secret(), secret(), secret()];
  const env = { WB_PRIVATE_CHAT_ORGANIZATION_ID: organization, TASK_ADMIN_SECRET: secret(), TASK_MANAGER_STAFF_IDS_CONFIG: 'C' };
  const auth = {};
  for (const id of ['A','B','C']) {
    const token = secret(); auth[id] = { mode: 'person', id, token };
    db.prepare('INSERT INTO staff VALUES(?,?,?,?,?,?)').run('task', id, id, JSON.stringify({ id, name: '가상 직원 '+id, phone: forbidden[0], email: forbidden[1] }), 1, 1);
    db.prepare('INSERT INTO tokens VALUES(?,?,?,?,0)').run('task', 'sha256:'+hash(token), id, Date.now());
    db.prepare('INSERT INTO staff_private_profiles(app,staff_id,phone,login_enabled,pin_hash,pin_salt,updated_at) VALUES(?,?,?,1,?,?,?)')
      .run('task', id, forbidden[0], forbidden[2], secret(), 1);
  }
  let reads=0, writes=0; const sqlReads=[];
  env.DB = { prepare(sql) {
    if (/^SELECT\b/i.test(sql.trim())) {reads++;sqlReads.push(sql);} else {writes++; throw Error('IDENTITY_WRITE_ATTEMPT');}
    let args=[];
    return { bind(...values){args=values;return this;},first(){return db.prepare(sql).get(...args)||null;},all(){return {results:db.prepare(sql).all(...args)};},run(){writes++;throw Error('IDENTITY_WRITE_ATTEMPT');} };
  }, batch(){writes++;throw Error('IDENTITY_WRITE_ATTEMPT');} };
  function snapshot() {
    const schema=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
    const rows={};for(const row of schema.filter(r=>r.type==='table')) rows[row.name]=db.prepare('SELECT * FROM "'+row.name+'"').all().map(r=>JSON.stringify(r)).sort();
    return hash(JSON.stringify({schema,rows}));
  }
  async function request(body={app:'task',auth:auth.A}, options={}) {
    const before=snapshot(), beforeWrites=writes;
    const originalFetch=globalThis.fetch;let outgoing=0;
    globalThis.fetch=async()=>{outgoing++;throw Error('REMOTE_FORBIDDEN');};
    try {
      const response=await worker.fetch(new Request('http://localhost/self-identity',{method:options.method||'POST',headers:{'content-type':'application/json',Origin:options.origin||'http://localhost'},body:options.method==='GET'?undefined:options.raw||JSON.stringify(body)}),env,{});
      const text=await response.text();
      assert.equal(snapshot()===before,true,'all row/schema hashes must remain unchanged');
      assert.equal(writes===beforeWrites,true,'no attempted write');assert.equal(outgoing,0);
      assert.equal(forbidden.some(value=>text.includes(value)),false,'forbidden sentinel in response');
      return {status:response.status,data:JSON.parse(text)};
    } finally {globalThis.fetch=originalFetch;}
  }
  return {db,env,auth,request,secret,sqlReads,stats:()=>({reads,writes})};
}
const ownKeys=['id','loginConfigured','loginMethod','name','status'];
test('full Worker projects exact verified A/B/manager self keysets with no DB writes or private fields',async()=>{
  const f=fixture();try {
    for(const id of ['A','B','C']) {
      const r=await f.request({app:'task',auth:{...f.auth[id],role:'manager',viewStaff:'B'}});
      assert.equal(r.status,200);assert.deepEqual(Object.keys(r.data).sort(),['identity','ok']);
      assert.deepEqual(Object.keys(r.data.identity).sort(),ownKeys);
      assert.equal(r.data.identity.id===id,true);assert.equal(r.data.identity.name==='가상 직원 '+id,true);
      assert.equal(r.data.identity.loginConfigured,true);
    }
    assert.equal(f.stats().writes,0);assert.equal(f.stats().reads>0,true);
  }finally{f.db.close();}
});
test('target/organization/app/role spoofing cannot select another person; cross-server DB rejects same native ID',async()=>{
  const f=fixture(),other=fixture('synthetic-org-2');try {
    assert.notEqual(f.env.WB_PRIVATE_CHAT_ORGANIZATION_ID,other.env.WB_PRIVATE_CHAT_ORGANIZATION_ID);
    for(const extra of [{targetId:'B'},{staffId:'B'},{organization:'synthetic-org-2'},{role:'admin'}]) {
      const r=await f.request({app:'task',auth:f.auth.A,...extra});assert.equal(r.status,400);assert.equal(!!r.data.identity,false);
    }
    assert.equal((await f.request({app:'consult',auth:f.auth.A})).status,400);
    assert.equal((await f.request({app:'task',auth:{...f.auth.A,id:'B'}})).status,401);
    assert.equal((await other.request({app:'task',auth:f.auth.A})).status,401);
    delete f.env.WB_PRIVATE_CHAT_ORGANIZATION_ID;
    const r=await f.request();assert.equal(r.status,503);assert.equal(r.data.authScope,'identity_check');
  }finally{f.db.close();other.db.close();}
});
test('shared admin and valid inspection have no personal IDs or names',async()=>{
  const f=fixture();try {
    const r=await f.request({app:'task',auth:{mode:'admin',secret:f.env.TASK_ADMIN_SECRET}});
    assert.equal(r.status,200);assert.deepEqual(r.data.identity,{status:'shared_admin',loginMethod:'shared_admin'});
    const token=f.secret();
    f.db.prepare('INSERT INTO manager_inspection_sessions(app,token_hash,manager_staff_id,source_staff_id,device_hash,created_at,expires_at,revoked) VALUES(?,?,?,?,?,?,?,0)')
      .run('task',hash(token),'C','A',hash(f.auth.A.token),Date.now(),Date.now()+60000);
    f.env.WB_STAFF_WORK_LOGIN_ENABLED='true';
    const i=await f.request({app:'task',auth:{mode:'manager_inspection',managerId:'C',token}});
    assert.equal(i.status,200);assert.deepEqual(i.data.identity,{status:'inspection',loginMethod:'inspection'});
    assert.equal((await f.request({app:'task',auth:{mode:'admin',secret:f.secret()}})).status,401);
  }finally{f.db.close();}
});
test('missing profile/config/structures and malformed requests fail without creating or repairing rows/schema',async()=>{
  const f=fixture();try {
    f.db.prepare('DELETE FROM staff_private_profiles WHERE staff_id=?').run('A');assert.equal((await f.request()).status,503);
    f.db.exec('DROP TABLE staff_private_profiles');assert.equal((await f.request()).status,503);
    f.db.exec('DROP TABLE tokens');assert.equal((await f.request()).status,503);
    assert.equal((await f.request(null)).status,400);
    assert.equal((await f.request({}, {raw:'{'})).status,400);
    assert.equal((await f.request({}, {method:'GET'})).status,405);
    f.env.ALLOW_ORIGIN='http://synthetic-allowed.invalid';
    const denied=await f.request();assert.equal(denied.status,403);assert.equal(!!denied.data.identity,false);
  }finally{f.db.close();}
});
test('missing/expired/revoked/deleted person bearer fails closed; login gate remains required',async()=>{
  for(const scenario of ['missing','expired','revoked','deleted','gate','gate_structure']) {
    const f=fixture();try {
      if(scenario==='expired')f.db.prepare('UPDATE tokens SET created_at=0').run();
      if(scenario==='revoked')f.db.prepare('UPDATE tokens SET revoked=1').run();
      if(scenario==='deleted')f.db.prepare('UPDATE staff SET data=? WHERE id=?').run(JSON.stringify({deleted:true}),'A');
      if(scenario.startsWith('gate')) f.env.WB_STAFF_WORK_LOGIN_ENABLED='true';
      let missingWork;
      if(scenario==='gate_structure'){
        const now=Date.now(),date=staffAttendanceDate(now);missingWork=f.secret();
        f.db.prepare('INSERT INTO checks VALUES(?,?,?,?,?,?)').run('task',staffAttendanceKey('A',date),'A',JSON.stringify({done:true,at:now,date,sessions:[{in:now,out:null}]}),now,now);
        f.db.prepare('INSERT INTO staff_work_sessions VALUES(?,?,?,?,?,?,?,?,?,0)').run('task',hash(missingWork),'A',hash(f.auth.A.token),date,1,0,now,now+60000);
        assert.equal((await f.request({app:'task',auth:{...f.auth.A,workSession:missingWork}})).status,200);
        f.db.exec('DROP TABLE staff_work_sessions');
      }
      const sqlStart=f.sqlReads.length;
      const r=await f.request({app:'task',auth:scenario==='missing'?null:{...f.auth.A,...(missingWork?{workSession:missingWork}:{})}});
      assert.equal(!!r.data.identity,false);
      if(scenario==='gate_structure'){
        assert.equal(r.status,503);assert.equal(r.data.code,'STAFF_WORK_UNAVAILABLE');
        assert.equal(f.sqlReads.slice(sqlStart).some(sql=>/SELECT \* FROM staff_work_sessions/.test(sql)),true);
        assert.equal(!!f.db.prepare("SELECT name FROM sqlite_master WHERE name='staff_work_sessions'").get(),false);
      }else if(scenario==='gate')assert.equal(r.data.code,'STAFF_WORK_LOGIN_REQUIRED');
      else assert.equal(r.data.code,'PERSON_AUTH_REJECTED');
    }finally{f.db.close();}
  }
});
test('unconfigured/disabled login and HTML names retain exact minimal projection, without accepting staff payload ID mismatch',async()=>{
  const f=fixture();try {
    f.db.prepare('UPDATE staff_private_profiles SET pin_hash=?,login_enabled=0 WHERE staff_id=?').run('','A');
    const name='<img src=x onerror=alert(1)> 가상';
    f.db.prepare('UPDATE staff SET data=? WHERE id=?').run(JSON.stringify({id:'A',name}),'A');
    const r=await f.request();assert.equal(r.status,200);assert.equal(r.data.identity.name===name,true);assert.equal(r.data.identity.loginConfigured,false);
    f.db.prepare('UPDATE staff SET data=? WHERE id=?').run(JSON.stringify({id:'B',name}),'A');
    assert.equal((await f.request()).status,503);
  }finally{f.db.close();}
});
test('full Worker keeps valid work/attendance rows unchanged and rejects expired/revoked/device-mismatched parent sessions without writes',async()=>{
  const f=fixture();try {
    const now=Date.now(), date=staffAttendanceDate(now), work=f.secret();
    f.env.WB_STAFF_WORK_LOGIN_ENABLED='true';
    f.db.prepare('INSERT INTO checks VALUES(?,?,?,?,?,?)').run('task',staffAttendanceKey('A',date),'A',JSON.stringify({done:true,at:now,date,sessions:[{in:now,out:null}]}),now,now);
    f.db.prepare('INSERT INTO staff_work_sessions VALUES(?,?,?,?,?,?,?,?,?,0)').run('task',hash(work),'A',hash(f.auth.A.token),date,1,0,now,now+60000);
    const body={app:'task',auth:{...f.auth.A,workSession:work}};
    const valid=await f.request(body);assert.equal(valid.status,200);
    assert.equal(valid.data.identity.loginMethod,'personal_device_work_login');
    assert.deepEqual(Object.keys(valid.data.identity).sort(),ownKeys);assert.equal(valid.data.identity.id,'A');
    for(const patch of ['expires_at=0','revoked=1',"device_hash='synthetic-other-device'"]) {
      f.db.prepare('UPDATE staff_work_sessions SET expires_at=?,revoked=0,device_hash=?').run(now+60000,hash(f.auth.A.token));
      f.db.exec('UPDATE staff_work_sessions SET '+patch);
      const r=await f.request(body);assert.equal(r.data.code,'STAFF_WORK_LOGIN_REQUIRED');assert.equal(!!r.data.identity,false);
    }
  }finally{f.db.close();}
});
test('manager work-login method shares the unchanged gate policy for excluded/included managers, with exact self fields and no writes',async()=>{
  const f=fixture();try{
    f.env.WB_STAFF_WORK_LOGIN_ENABLED='true';
    const excluded=await f.request({app:'task',auth:f.auth.C});assert.equal(excluded.status,200);
    assert.equal(excluded.data.identity.loginMethod,'personal_device');assert.equal(excluded.data.identity.loginConfigured,true);
    assert.deepEqual(Object.keys(excluded.data.identity).sort(),ownKeys);assert.equal(excluded.data.identity.id,'C');
    f.env.TASK_WORK_LOGIN_MANAGER_IDS_CONFIG='C';
    const denied=await f.request({app:'task',auth:f.auth.C});assert.equal(denied.data.code,'STAFF_WORK_LOGIN_REQUIRED');
    const now=Date.now(),date=staffAttendanceDate(now),work=f.secret();
    f.db.prepare('INSERT INTO checks VALUES(?,?,?,?,?,?)').run('task',staffAttendanceKey('C',date),'C',JSON.stringify({done:true,at:now,date,sessions:[{in:now,out:null}]}),now,now);
    f.db.prepare('INSERT INTO staff_work_sessions VALUES(?,?,?,?,?,?,?,?,?,0)').run('task',hash(work),'C',hash(f.auth.C.token),date,1,0,now,now+60000);
    const included=await f.request({app:'task',auth:{...f.auth.C,workSession:work}});
    assert.equal(included.status,200);assert.equal(included.data.identity.loginMethod,'personal_device_work_login');
    assert.deepEqual(Object.keys(included.data.identity).sort(),ownKeys);assert.equal(included.data.identity.id,'C');assert.equal(f.stats().writes,0);
  }finally{f.db.close();}
});
