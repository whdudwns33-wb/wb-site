import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { audioKey } from './prepared-audio.mjs';

const tmp=await fs.realpath(os.tmpdir()),data=await fs.mkdtemp(path.join(tmp,'wbr-audio-http-'));
const sample=JSON.parse(await fs.readFile(new URL('../naesin/pack-sample.json',import.meta.url),'utf8'));
const sentences=Array.from({length:20},(_,i)=>({en:'Own English listening sentence number '+(i+1)+'.'}));
const pack={...sample,sentences,dialogues:[],items:[]},students={},tokens={},keys=[];
const admin=randomUUID(),deny=randomUUID(),exp=Date.now()+3600000;
tokens[admin]={code:'__admin__',admin:true,exp};tokens[deny]={code:'DENIED01',admin:false,exp};
students.DENIED01={code:'DENIED01',name:'자체 시험 제외 학생',cls:'미배정'};
for(let i=0;i<20;i++){const code='AUDIO'+String(i+1).padStart(3,'0'),token=randomUUID();keys.push(token);students[code]={code,name:'자체 시험 학생',cls:'음성 시험반'};tokens[token]={code,admin:false,exp};}
await fs.writeFile(path.join(data,'db.json'),JSON.stringify({students,tokens,naesin:{packs:{[pack.packId]:{pack}},packIds:[pack.packId],
  exams:{'cls:음성 시험반':{mode:'practice',packIds:[pack.packId],examDate:''}}}}));
const dir=path.join(data,'naesin-audio');await fs.mkdir(dir);
const wav=Buffer.alloc(48);wav.write('RIFF');wav.writeUInt32LE(40,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);
wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);
wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(4,40);
for(const s of sentences)await fs.writeFile(path.join(dir,audioKey(s.en)+'.wav'),wav);
let child,exitPromise,base;
async function start(){
  let stdout='';child=spawn(process.execPath,[fileURLToPath(new URL('./server.mjs',import.meta.url))],{
    windowsHide:true,env:{...process.env,PORT:'0',HOST:'127.0.0.1',DATA_DIR:data,ADMIN_PIN:'own-audio-test-pin',ADMIN_ID:'',ADMIN_PASSWORD:'',
      WB_INHOUSE_ONLY:'1',WB_ADMIN_ONLY:'0',WB_INHOUSE_NETWORKS:'198.51.100.1',
      WB_KOKORO_PYTHON:path.join(data,'unavailable-engine'),WB_KOKORO_HOME:data},stdio:['ignore','pipe','pipe']});
  exitPromise=once(child,'exit');child.stdout.on('data',b=>stdout+=String(b));child.stderr.resume();
  for(let i=0;i<200;i++){const m=stdout.match(/localhost:(\d+)/);if(m){base='http://127.0.0.1:'+m[1];return;}await new Promise(r=>setTimeout(r,10));}
  throw Error('Own test server did not start');
}
async function stop(){child.kill();await exitPromise;child=null;}
async function request(text,token=keys[0],extra={}){return fetch(base+'/api/naesin/tts',{method:'POST',signal:AbortSignal.timeout(3000),
  headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...extra},body:JSON.stringify({packId:pack.packId,text,rate:1})});}
try{
  await start();
  const startTime=Date.now();
  let served=0;
  await Promise.all(keys.map(async(token,i)=>{
    for(let part=0;part<4;part+=2)await Promise.all([part,part+1].map(async offset=>{
      const r=await request(sentences[(i+offset)%sentences.length].en,token);assert.equal(r.status,200);
      assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('content-type'),'audio/wav');
      assert.ok(Buffer.from(await r.arrayBuffer()).equals(wav));served++;
    }));
  }));
  assert.equal(served,80);assert.ok(Date.now()-startTime<3000,'20명이 두 요청씩 본문 4조각을 받아도 합성 엔진을 기다리지 않는다');
  assert.equal((await request(sentences[0].en,null)).status,401);assert.equal((await request(sentences[0].en,deny)).status,403);
  assert.equal((await request('Own text outside this pack.')).status,403);
  assert.equal((await request(sentences[0].en,admin,{host:'academy.example','cf-connecting-ip':'203.0.113.99'})).status,403);
  assert.equal((await fetch(base+'/naesin-audio/'+audioKey(sentences[0].en)+'.wav')).status,404);
  await stop();await start();assert.equal((await request(sentences[0].en)).status,200,'재시작·엔진 부재에도 저장 음성 재사용');
  const rec={...pack,rights:{...pack.rights,studentUseAllowed:false}};
  // 운영 DB를 건드리지 않고 시험 서버 중지 후 시험 DB에서만 권리를 회수한다.
  await stop();const db=JSON.parse(await fs.readFile(path.join(data,'db.json'),'utf8'));db.naesin.packs[pack.packId].pack=rec;
  await fs.writeFile(path.join(data,'db.json'),JSON.stringify(db));await start();assert.equal((await request(sentences[0].en)).status,403);
}finally{if(child)await stop();assert.equal(path.dirname(await fs.realpath(data)),tmp);await fs.rm(data,{recursive:true,force:true});}
console.log('✓ 실제 HTTP 20학생·20음성 동시 읽기·합성 엔진 부재·재시작·외부 차단·권리 회수·비공개 파일');
