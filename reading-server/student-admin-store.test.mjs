import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const tmp=fs.realpathSync(os.tmpdir()),data=fs.mkdtempSync(path.join(tmp,'wb-student-admin-'));
process.env.DATA_DIR=data;
const store=await import('./store.mjs'),file=path.join(data,'student-admin.json');
const check=source=>{
  const r=spawnSync(process.execPath,['--input-type=module','-e',`import assert from 'node:assert/strict';import {load} from ${JSON.stringify(new URL('./store.mjs',import.meta.url).href)};${source}`],{env:process.env,windowsHide:true});
  assert.equal(r.status,0,r.stderr.toString());
};
try {
  const db=store.load();db.students.OWN001={code:'OWN001',name:'Own student',book:{bookId:'own-book',lesson:1}};
  db.naesin={books:{OWN001:'own-textbook'},states:{},packs:{}};
  const day=new Date(Date.now()+9*3600e3).toISOString().slice(0,10);fs.mkdirSync(path.join(data,'backups'));fs.writeFileSync(path.join(data,'backups','db-'+day+'.json'),'{}');
  await store.persist();const before=fs.readFileSync(path.join(data,'db.json'),'utf8');
  Object.defineProperty(db.naesin,'packs',{configurable:true,enumerable:true,get(){throw Error('Student admin touched textbook content');}});
  db.students.OWN002={code:'OWN002',name:'Own new student'};
  db.students.OWN001.book.lesson=2;db.naesin.books.OWN001='own-new-textbook';
  await store.persistStudentAdmin();
  assert.equal(fs.readFileSync(path.join(data,'db.json'),'utf8'),before);
  check(`const db=load();assert.ok(db.students.OWN002);assert.equal(db.students.OWN001.book.lesson,2);assert.equal(db.naesin.books.OWN001,'own-new-textbook');`);
  const saved=fs.readFileSync(file,'utf8');fs.mkdirSync(file+'.tmp');
  await assert.rejects(store.persistStudentAdmin(),{code:'STORE_WRITE_FAILED'});
  assert.equal(fs.readFileSync(file,'utf8'),saved);fs.rmdirSync(file+'.tmp');
  fs.writeFileSync(file,'{"students":');check(`assert.throws(load,/student-admin.json/);`);fs.writeFileSync(file,saved);
  db.naesin.states.OWN002={state:{ownOld:true}};db.haru={states:{OWN002:{ownOld:true}}};
  await store.deleteStudent('OWN002');
  check(`const db=load();assert.ok(!db.students.OWN002);`);
  delete db.naesin.packs;db.naesin.packs={};
  db.students.OWN002={code:'OWN002',name:'Own reused code'};await store.persistStudentAdmin();
  check(`const db=load();assert.equal(db.students.OWN002.name,'Own reused code');assert.ok(!db.naesin.states.OWN002);assert.ok(!db.haru.states.OWN002);`);
  console.log('OK — student registration/textbook changes skip large DB; failures preserve file; restart/deletion/code reuse remain safe');
}finally{
  assert.equal(path.dirname(fs.realpathSync(data)),tmp);fs.rmSync(data,{recursive:true,force:true});
}
