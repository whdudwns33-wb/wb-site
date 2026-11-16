/* 삭제는 작은 저널만 저장하고, 재시작·다른 앱 기록·같은 코드 재등록을 함께 검증한다. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(tmp,'wb-delete-store-'));
process.env.DATA_DIR=dir;
const store=await import('./store.mjs'),file=path.join(dir,'db.json'),journal=path.join(dir,'student-deletions.json');
const code='REMOVE01',other='KEEP001',ptoken='p'.repeat(32),haruPtoken='h'.repeat(32);
const maps=()=>({[code]:{own:true},[other]:{keep:true}});
function assertGone(d){
  const c='REMOVE01',o='KEEP001';
  assert.equal(d.students[c],undefined);assert.ok(d.students[o]);
  for(const [root,fields] of [[d,['states']],[d.vocab,['states','push']],
    [d.naesin,['states','exams','results','books']],[d.naesinKo,['states','summaries','reviews','exams','overlays']],
    [d.haru,['states','mocks','paper']],[d.hanja,['states','summaries','assigns','push','tasks']],
    [d.chunk,['states','summaries','assigns']],[d.letter,['states']]])
    for(const field of fields){assert.equal(root[field][c],undefined);assert.ok(root[field][o]);}
  assert.equal(d.parents['p'.repeat(32)],undefined);assert.equal(d.haru.parents['h'.repeat(32)],undefined);
  assert.equal(d.chunk.pushes['f:'+'p'.repeat(32)],undefined);
  assert.equal(d.letter.push['s:'+c],undefined);assert.equal(d.letter.push['f:'+'p'.repeat(32)],undefined);
  assert.equal(d.tokens.removed,undefined);assert.ok(d.tokens.kept);assert.equal(d.pending.removed,undefined);
  assert.equal(d.naesin.reports.own[0].code,'');assert.equal(d.naesin.reports.own[1].code,o);
  assert.ok(d.naesin.exams['cls:own']);assert.ok(d.hanja.tasks.default);assert.ok(d.haru.paperkeys.own);
}
function restart(body){const r=spawnSync(process.execPath,['--input-type=module','-e',
  `import assert from 'node:assert/strict';import {load} from ${JSON.stringify(new URL('./store.mjs',import.meta.url).href)};${body}`],
  {env:process.env,windowsHide:true,encoding:'utf8'});assert.equal(r.status,0,r.stderr);}
try{
  const d=store.load();Object.assign(d,{students:{[code]:{code,name:'Own removed',ptoken,haruPtoken},[other]:{code:other,name:'Own kept'}},
    states:maps(),parents:{[ptoken]:code},tokens:{removed:{code},kept:{code:other}},pending:{removed:{code}},
    vocab:{states:maps(),push:maps()},naesin:{states:maps(),exams:{...maps(),'cls:own':{mode:'practice'}},results:maps(),books:{[code]:'own-a',[other]:'own-b'},
      reports:{own:[{code,reason:'own'},{code:other,reason:'own'}]},packs:{own:{pack:{ownText:'Own fixture only.'}}}},
    naesinKo:Object.fromEntries(['states','summaries','reviews','exams','overlays'].map(k=>[k,maps()])),
    haru:{states:maps(),mocks:maps(),paper:maps(),parents:{[haruPtoken]:code},paperkeys:{own:{key:true}}},
    hanja:{...Object.fromEntries(['states','summaries','assigns','push','tasks'].map(k=>[k,maps()]))},
    chunk:{states:maps(),summaries:maps(),assigns:maps(),pushes:{['f:'+ptoken]:{own:true}}},
    letter:{states:maps(),push:{['s:'+code]:{own:true},['f:'+ptoken]:{own:true}}}});
  d.hanja.tasks.default={common:true};await store.persist();
  const before=fs.readFileSync(file,'utf8');
  Object.defineProperty(d.naesin,'packs',{configurable:true,get(){throw Error('Deletion must not serialize textbooks');}});
  const out=await store.deleteStudent(code);assert.equal(out.code,code);assert.equal(out.name,'Own removed');
  assert.ok(out.removed>0);assert.equal(store.getDb(),d);assertGone(d);
  assert.equal(fs.readFileSync(file,'utf8'),before,'큰 DB는 다시 쓰지 않는다');
  assert.ok(fs.statSync(journal).size<1000);assert.equal(await store.deleteStudent(code),null);
  restart(`(${assertGone.toString()})(load());`);
  delete d.naesin.packs;

  const saved=fs.readFileSync(journal,'utf8');fs.mkdirSync(journal+'.tmp');
  await assert.rejects(store.deleteStudent(other),{code:'STORE_WRITE_FAILED'});
  assert.ok(d.students[other]);assert.ok(d.tokens.kept);assert.equal(fs.readFileSync(journal,'utf8'),saved);
  fs.rmdirSync(journal+'.tmp');
  assert.equal(await store.deleteStudent('constructor'),null);
  await assert.rejects(store.deleteStudent('default'),/Invalid student code/);
  for(const invalid of ['[]','{"v":2,"deleted":{}}','{"v":1,"deleted":{"default":{}}}','{"v":1,"deleted":{"../bad":{}}}','{"v":1,"deleted":{"REMOVE01":{"ptoken":7}}}']){
    fs.writeFileSync(journal,invalid);restart(`assert.throws(load,/student-deletions.json/);`);
    assert.equal(fs.readFileSync(journal,'utf8'),invalid);
  }
  fs.writeFileSync(journal,saved);
  d.students[code]={code,name:'Own new student'};await store.persist();
  restart(`const d=load();assert.equal(d.students.REMOVE01.name,'Own new student');assert.equal(d.naesin.states.REMOVE01,undefined);assert.equal(d.tokens.removed,undefined);`);
  await store.deleteStudent(code);await store.persist();restart(`assert.equal(load().students.REMOVE01,undefined);`);
  console.log('✓ 학생 삭제 저널·교재 DB 미접근·재시작 전체 삭제·타 학생/공통 자료 보호·쓰기 실패·손상 차단·동일 코드 재등록');
}finally{assert.equal(path.dirname(fs.realpathSync(dir)),tmp);fs.rmSync(dir,{recursive:true,force:true});}
