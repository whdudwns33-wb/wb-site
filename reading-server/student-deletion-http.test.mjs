/* 실제 대용량 DB에서 삭제와 20명의 교재 읽기·기록 저장·듣기를 겹친다. 자료는 전부 자체 시험용. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { audioKey } from './prepared-audio.mjs';

const tmp=await fs.realpath(os.tmpdir()),data=await fs.mkdtemp(path.join(tmp,'wb-delete-http-'));
const sample=JSON.parse(await fs.readFile(new URL('../naesin/pack-sample.json',import.meta.url),'utf8'));
const text=sample.sentences[0].en,pack={...sample};
const upload={...sample,lessonTitle:'Own updated sample',source:'Own load fixture. '+'x'.repeat(3*1024*1024)};
const deleted='REMOVE001',admin=randomUUID(),removedToken=randomUUID(),keys=Array.from({length:20},()=>randomUUID());
const students={[deleted]:{code:deleted,name:'Own removed student',cls:'own'}},tokens={},exp=Date.now()+3600000;
tokens[admin]={code:'__admin__',admin:true,exp};tokens[removedToken]={code:deleted,admin:false,exp};
for(let i=0;i<20;i++){const code='KEEP'+String(i).padStart(3,'0');students[code]={code,name:'Own student',cls:'own'};tokens[keys[i]]={code,admin:false,exp};}
let child,ended,base;const timings={health:[],study:[],save:[],audio:[],registration:[],textbook:[],packWrite:[]};
async function start(){
  let out='';child=spawn(process.execPath,[fileURLToPath(new URL('./server.mjs',import.meta.url))],{windowsHide:true,
    env:{...process.env,PORT:'0',HOST:'127.0.0.1',DATA_DIR:data,ADMIN_PIN:'own-delete-test-pin',ADMIN_ID:'',ADMIN_PASSWORD:'',
      WB_INHOUSE_ONLY:'1',WB_ADMIN_ONLY:'0',WB_INHOUSE_NETWORKS:'198.51.100.1',WB_KOKORO_PYTHON:path.join(data,'no-engine'),WB_KOKORO_HOME:data},stdio:['ignore','pipe','pipe']});
  ended=once(child,'exit');child.stdout.on('data',b=>out+=String(b));child.stderr.resume();
  for(let i=0;i<400;i++){const m=out.match(/localhost:(\d+)/);if(m){base='http://127.0.0.1:'+m[1];return;}await new Promise(r=>setTimeout(r,25));}
  throw Error('Own deletion test server did not start');
}
async function stop(){child.kill();await ended;child=null;}
async function req(url,{token=admin,method='GET',body,label,timeout=3000}={}){
  const t=Date.now(),r=await fetch(base+url,{method,signal:AbortSignal.timeout(timeout),headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},...(body?{body:JSON.stringify(body)}:{})});
  const bytes=await r.arrayBuffer();if(label)timings[label].push(Date.now()-t);return{status:r.status,body:r.headers.get('content-type')?.includes('application/json')?JSON.parse(Buffer.from(bytes).toString()):null,bytes:bytes.byteLength};
}
try{
  const header=JSON.stringify({students,tokens,naesin:{packIds:[pack.packId],packs:{[pack.packId]:{pack}},states:{[deleted]:{state:{owner:deleted,packs:{}}}},exams:{'cls:own':{mode:'practice',packIds:[pack.packId]}}}});
  const h=await fs.open(path.join(data,'db.json'),'w');try{await h.writeFile(header.slice(0,-1)+',"ownLargeFixture":"');for(let i=0;i<64;i++)await h.writeFile('x'.repeat(1024*1024));await h.writeFile('"}');}finally{await h.close();}
  // 실운영처럼 당일 백업이 이미 있는 상태에서 삭제의 저장 경로만 측정한다.
  const day=new Date(Date.now()+9*3600e3).toISOString().slice(0,10);await fs.mkdir(path.join(data,'backups'));await fs.writeFile(path.join(data,'backups','db-'+day+'.json'),'{}');
  await fs.mkdir(path.join(data,'naesin-audio'));const wav=Buffer.alloc(4844);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
  await fs.writeFile(path.join(data,'naesin-audio',audioKey(text)+'.wav'),wav);
  const before=await fs.stat(path.join(data,'db.json'));await start();
  // 삭제 전에 시작했지만 몸통이 늦게 도착하는 저장도, 삭제 후에는 거절해야 한다.
  const slowBody=JSON.stringify({state:{v:1,owner:deleted,savedAt:Date.now(),packs:{[pack.packId]:{savedAt:Date.now(),ownLate:true}}}});
  let slowRequest;const slowResponse=new Promise((resolve,reject)=>{slowRequest=http.request(base+'/api/naesin/state',{method:'PUT',headers:{Authorization:'Bearer '+removedToken,'Content-Type':'application/json','Content-Length':Buffer.byteLength(slowBody)}},r=>{r.resume();r.on('end',()=>resolve(r.statusCode));});slowRequest.on('error',reject);slowRequest.write(slowBody.slice(0,20));});
  await new Promise(r=>setTimeout(r,50));
  let probing=true;const probes=(async()=>{while(probing){assert.equal((await req('/api/health',{label:'health'})).status,200);await new Promise(r=>setTimeout(r,10));}})();
  let deletionMs;
  try{
    await Promise.all([(async()=>{const at=Date.now();assert.equal((await req('/api/admin/students',{method:'DELETE',body:{code:deleted}})).status,200);deletionMs=Date.now()-at;slowRequest.end(slowBody.slice(20));})(),
      ...keys.map(async(token,i)=>{for(let round=1;round<=3;round++){
        const stamp=Date.now()+round,code='KEEP'+String(i).padStart(3,'0');
        const rs=await Promise.all([req('/api/naesin/pack?id='+pack.packId,{token,label:'study'}),
          req('/api/naesin/state',{token,method:'PUT',body:{state:{v:1,owner:code,savedAt:stamp,packs:{[pack.packId]:{savedAt:stamp,ownRound:round}}}},label:'save'}),
          req('/api/naesin/tts',{token,method:'POST',body:{packId:pack.packId,text,rate:1},label:'audio'})]);
        assert.ok(rs.every(r=>r.status===200));assert.equal(rs[2].bytes,wav.length);
      }})]);
    assert.equal(await slowResponse,401,'삭제된 학생의 늦은 저장이 기록을 되살리면 안 된다');
    await new Promise(r=>setTimeout(r,400));
  }finally{probing=false;await probes;slowRequest.destroy();}
  assert.equal((await fs.stat(path.join(data,'db.json'))).mtimeMs,before.mtimeMs,'삭제 때 큰 DB 저장이 예약되면 안 된다');
  assert.ok((await fs.stat(path.join(data,'student-deletions.json'))).size<1000);
  assert.equal((await req('/api/naesin/state',{token:removedToken})).status,401);
  assert.equal((await req('/api/admin/student/'+deleted)).status,404);
  assert.equal((await req('/student-deletions.json')).status,404);
  await fs.mkdir(path.join(data,'student-deletions.json.tmp'));
  const failed=await req('/api/admin/students',{method:'DELETE',body:{code:'KEEP000'}});assert.equal(failed.status,500);assert.equal(failed.body.code,'STORE_WRITE_FAILED');
  assert.equal((await req('/api/naesin/exam',{token:keys[0]})).status,200);await fs.rmdir(path.join(data,'student-deletions.json.tmp'));
  // 학생 등록·교과서 지정·팩 저장도 같은 대용량 DB에서 학습과 겹친다.
  await fs.unlink(path.join(data,'backups','db-'+day+'.json'));
  let saving=true;
  const saveProbes=(async()=>{while(saving){assert.equal((await req('/api/health',{label:'health'})).status,200);await new Promise(r=>setTimeout(r,10));}})();
  try {
    await Promise.all([
      req('/api/admin/students',{method:'POST',timeout:15000,body:{code:'NEW001',name:'Own new student',cls:'own'},label:'registration'}).then(r=>assert.equal(r.status,200)),
      req('/api/naesin/admin/books',{method:'PUT',timeout:15000,body:{books:{KEEP000:'own-textbook'}},label:'textbook'}).then(r=>assert.equal(r.status,200)),
      req('/api/naesin/admin/pack',{method:'POST',timeout:15000,body:{id:sample.packId,pack:upload},label:'packWrite'}).then(r=>assert.equal(r.status,200,JSON.stringify(r.body))),
      ...keys.map(async(token,i)=>{for(let round=4;round<=6;round++){
        await new Promise(r=>setTimeout(r,180));
        const stamp=Date.now()+round,code='KEEP'+String(i).padStart(3,'0');
        const rs=await Promise.all([
          req('/api/naesin/pack?id='+pack.packId,{token,label:'study'}),
          req('/api/naesin/state',{token,method:'PUT',label:'save',body:{state:{v:1,owner:code,savedAt:stamp,packs:{[pack.packId]:{savedAt:stamp,ownRound:round}}}}}),
          req('/api/naesin/tts',{token,method:'POST',label:'audio',body:{packId:pack.packId,text,rate:1}}),
        ]);assert.ok(rs.every(r=>r.status===200));
      }})
    ]);
  } finally {saving=false;await saveProbes;}
  assert.equal((await req('/student-admin.json')).status,404);
  assert.equal((await fs.stat(path.join(data,'db.json'))).mtimeMs,before.mtimeMs,'팩 업로드도 전체 교재 DB를 다시 쓰지 않는다');
  const packFile=path.join(data,'naesin-packs',Buffer.from(sample.packId).toString('hex')+'.json');
  assert.equal((await req('/naesin-packs/'+path.basename(packFile))).status,404);
  await fs.mkdir(packFile+'.tmp');
  const failedUpload=await req('/api/naesin/admin/pack',{method:'POST',body:{id:sample.packId,pack:{...sample,lessonTitle:'Must not commit'}}});
  assert.equal(failedUpload.status,500);assert.equal(failedUpload.body.code,'STORE_WRITE_FAILED');
  assert.equal((await req('/api/naesin/admin/pack?id='+sample.packId)).body.pack.lessonTitle,'Own updated sample');
  await fs.rmdir(packFile+'.tmp');
  assert.ok(JSON.parse(await fs.readFile(path.join(data,'private-backups','db-'+day+'.json'),'utf8')).students.NEW001);
  await stop();await start();assert.equal((await req('/api/naesin/state',{token:removedToken})).status,401);
  for(let i=0;i<20;i++){const saved=await req('/api/naesin/state',{token:keys[i]});assert.equal(saved.status,200);assert.equal(saved.body.state.packs[pack.packId].ownRound,6);}
  assert.equal((await req('/api/admin/student/NEW001')).status,200);
  assert.equal((await req('/api/naesin/admin/books')).body.books.KEEP000,'own-textbook');
  assert.equal((await req('/api/naesin/admin/pack?id='+sample.packId)).body.pack.lessonTitle,'Own updated sample');
  const max=Object.fromEntries(Object.entries(timings).map(([k,v])=>[k,Math.max(...v)]));assert.ok(Object.values(max).every(ms=>ms<1500),'삭제 중 학생 요청이 1.5초 이상 밀리지 않는다');
  assert.ok(max.registration<500&&max.textbook<500,'명부·교과서 변경이 교재 본문 저장을 기다리면 안 된다');
  console.log(JSON.stringify({fixtureMB:64,students:20,rounds:3,deletionMs,maxRequestMs:max,allStateRestored:true,lateRemovedSaveDenied:true}));
}finally{if(child)await stop();assert.equal(path.dirname(await fs.realpath(data)),tmp);await fs.rm(data,{recursive:true,force:true});}
