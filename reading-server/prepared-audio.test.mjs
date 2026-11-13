import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPreparedAudio, audioKey, packAudioInputs } from './prepared-audio.mjs';
import VOICE from '../shared/voice.js';

const temp = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temp,'wbr-audio-'));
const sample = JSON.parse(await fs.readFile(new URL('../naesin/pack-sample.json',import.meta.url),'utf8'));
const pack = {...sample, sentences:[{en:'Own first English sentence.',chunks:[{en:'Own first English sentence.'}]}],dialogues:[],items:[]};
const wav=Buffer.alloc(48);wav.write('RIFF');wav.writeUInt32LE(40,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);
wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);
wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(4,40);
let calls=0;
const engine={enabled:true,async speak(input){calls++;assert.equal(input.rate,1);return wav;}};
async function idle(audio){for(let i=0;i<200;i++){if(!audio.status().running)return;await new Promise(r=>setTimeout(r,5));}throw Error('Preparation did not finish');}
let audio;
try {
  const texts=VOICE.audioParts(('Own practice sentence with punctuation. ').repeat(80));
  assert.ok(texts.every(t=>t.length<=180)); assert.equal(packAudioInputs(pack).size,1);
  assert.notEqual(audioKey('Own first English sentence.'),audioKey('Own updated sentence.'));
  audio=createPreparedAudio({dir:root,engine});await audio.update([pack]);await idle(audio);
  assert.equal(calls,1);assert.equal(audio.status().ready,1);assert.equal(audio.status().total,1);
  let yielded=false;setImmediate(()=>{yielded=true;});
  await audio.update([pack,pack]);assert.equal(yielded,true,'자료 확인 중에도 다른 요청을 처리한다');await idle(audio);
  const twenty=await Promise.all(Array.from({length:20},()=>audio.read(pack,pack.sentences[0].en)));
  assert.ok(twenty.every(r=>r.bytes.equals(wav)));assert.equal(calls,1,'학생 재생은 생성기를 호출하지 않는다');
  assert.equal((await audio.read(pack,'Not in this pack.')).forbidden,true);
  audio.close();
  audio=createPreparedAudio({dir:root,engine});await audio.update([pack]);await idle(audio);
  assert.equal(audio.status().ready,1);assert.equal(calls,1,'서버 재시작 후 완성 파일 재사용');
  const changed={...pack,sentences:[{en:'Own updated sentence.'}]};await audio.update([changed]);await idle(audio);
  assert.equal(calls,2);assert.equal(audio.status().ready,1);
  await audio.update([{...pack,rights:{...pack.rights,studentUseAllowed:false}}]);await idle(audio);
  assert.equal(audio.status().total,0,'권리 회수 자료는 사전 생성에서 제외');
  audio.close();
  const target=path.join(root,audioKey(pack.sentences[0].en)+'.wav');await fs.writeFile(target,Buffer.from('truncated'));
  audio=createPreparedAudio({dir:root,engine});await audio.update([pack]);await idle(audio);
  assert.equal(calls,3,'손상 파일은 다시 생성');assert.ok((await audio.read(pack,pack.sentences[0].en)).bytes.equals(wav));
  await fs.writeFile(target,Buffer.from('broken again'));
  const before=calls;assert.equal((await audio.read(pack,pack.sentences[0].en)).missing,true);assert.equal(calls,before,'없는 파일을 학생이 요청해도 합성 대기를 만들지 않는다');
  await audio.update([pack]);await idle(audio);assert.equal(calls,4);
  audio.close();
  let resume;
  audio=createPreparedAudio({dir:root,engine:{enabled:true,speak:()=>new Promise(resolve=>{resume=resolve;})}});
  await audio.update([changed]);await idle(audio); // 기존 완성 파일은 엔진이 멈춰 있어도 읽는다.
  assert.ok((await audio.read(changed,changed.sentences[0].en)).bytes);
  const missing={...pack,sentences:[{en:'Own not yet prepared sentence.'}]};await audio.update([missing]);
  for(let i=0;i<30&&!resume;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal((await audio.read(missing,missing.sentences[0].en)).missing,true);
  assert.equal(audio.status().ready,0);resume(wav);await idle(audio);assert.equal(audio.status().ready,1);
  audio.close();
  const failureDir=path.join(root,'disk-failure');await fs.mkdir(failureDir);await fs.writeFile(path.join(failureDir,audioKey(pack.sentences[0].en)+'.wav'),'bad');
  audio=createPreparedAudio({dir:failureDir,engine:{enabled:true,async speak(){throw Error('own synth failure');}}});
  await audio.update([pack]);await idle(audio);assert.equal(audio.status().ready,0);assert.equal(audio.status().failed,1);
  audio.close();
  const blocked=path.join(root,'write-blocked');await fs.mkdir(path.join(blocked,audioKey(pack.sentences[0].en)+'.wav'),{recursive:true});
  audio=createPreparedAudio({dir:blocked,engine});await audio.update([pack]);await idle(audio);
  assert.equal(audio.status().ready,0);assert.equal(audio.status().failed,1,'파일 저장 실패를 준비 완료로 표시하지 않는다');
  assert.ok((await fs.stat(path.join(blocked,audioKey(pack.sentences[0].en)+'.wav'))).isDirectory());
  assert.ok((await fs.readdir(blocked)).every(name=>!name.includes('.wav.')||!name.endsWith('.tmp')));
} finally {
  audio?.close(); await new Promise(r=>setTimeout(r,30));
  assert.equal(path.dirname(await fs.realpath(root)),temp);await fs.rm(root,{recursive:true,force:true});
}
console.log('✓ 사전 생성·영구 파일 재사용·20명 즉시 읽기·변경·권리 회수·손상 복구·생성 실패·미준비 즉시 응답');
