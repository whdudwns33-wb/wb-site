import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {NAMES,classifyDownload,stageDownloads,runStage} from './stage-downloads.mjs';
const scope = {curriculum:'2022',grade:'m2',publisher:'ne-kimgitaek',publisherLabel:'NE능률(김기택)',unitRawLabel:'1과',unitCode:'L1',folderName:'2022-ne-kimgitaek-m2-L1'};
const prefix = '(2022개정)2026년_중2_NE능률(김기택)_1과_';
const titles = ['본문','[01]내용정리 플러스','[02]본문10단계 워크북 통합본(1~10)','[03]WORD TEST',
  '[04]예상문제 PRE-STEP','[04]예상문제 PRE-STEP(교사용)','[05]예상문제 1회','[05]예상문제 1회(교사용)',
  '[06]예상문제 2회','[06]예상문제 2회(교사용)','[07]Grammar Build Up 워크북','[08]Grammar Build Up 객관식','[09]Grammar Build Up 주관식'];
const pdf = s => Buffer.from('%PDF-1.4\n% synthetic fixture '+s+'\n%%EOF');
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'stage-downloads-test-'));
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  const sourceRoot = path.join(dir,'Downloads'), root = path.join(dir,'destination');
  await fs.mkdir(sourceRoot);
  const input = {root,scope:{...scope},files:[]};
  async function add(title, body=title, srcName) {
    const suggestedFilename = prefix+title+'.pdf';
    const src = path.join(sourceRoot,srcName || suggestedFilename);
    await fs.writeFile(src,pdf(body));
    const entry = {src,suggestedFilename}; input.files.push(entry); return entry;
  }
  return {dir,root,sourceRoot,input,add,options:{sourceRoot}};
}
async function noWrite(f) {
  await assert.rejects(stageDownloads(f.input,f.options));
  await assert.rejects(fs.stat(f.root),{code:'ENOENT'});
}
test('13 exact canonical names, stage 1/10 and integrated not stage',()=>{
  titles.forEach((title,i)=>assert.equal(classifyDownload(prefix+title+'.pdf').filename,NAMES[i]));
  for(const n of [1,10]) {
    const name=prefix+'본문10단계 워크북 '+n+' 본문영작_단계별.pdf';
    assert.deepEqual(classifyDownload(name),{filename:'_raw/'+name,stage:n});
  }
  assert.equal(classifyDownload(prefix+titles[2]+'.pdf').stage,null);
  for(const title of ['본문10단계 워크북 통합본(1~10)','본문10단계 워크북 11 본문_단계별','본문10단계 워크북 1English_단계별','[02]본문10단계 워크북 통합본(1~10)_단계별','[08]unknown','[01]내용정리 플러스(교사용)']) assert.throws(()=>classifyDownload(prefix+title+'.pdf'));
});

test('2015 filenames retain their original numbering under raw with all scope and PDF guards',async t=>{
  const f=await fixture(t);
  f.input.scope={curriculum:'2015',grade:'m3',publisher:'own-publisher',publisherLabel:'자체출판(가상)',unitRawLabel:'1과',unitCode:'L1',folderName:'2015-own-publisher-m3-L1'};
  const name='2021년_중3_자체출판(가상)_1과_[09]형성평가 0단계 PRE-STEP 문항_OK.pdf';
  const src=path.join(f.sourceRoot,name);await fs.writeFile(src,pdf('Own legacy fixture'));
  f.input.files=[{src,suggestedFilename:name}];
  const result=await stageDownloads(f.input,f.options);assert.equal(result.status,'complete');
  assert.equal(result.files[0].destination,f.input.scope.folderName+'/_raw/'+name);
  assert.deepEqual(await fs.readFile(path.join(f.root,result.files[0].destination)),await fs.readFile(src));
  f.input.files[0].suggestedFilename=name.replace('중3','중2');await assert.rejects(stageDownloads(f.input,f.options));
  f.input.files[0].suggestedFilename=name.replace(/\.pdf$/,'.hwp');await assert.rejects(stageDownloads(f.input,f.options));
  f.input.files[0].suggestedFilename='../'+name;await assert.rejects(stageDownloads(f.input,f.options));
});
test('duplicate suffixes are comparison only, raw exact name preserved',()=>{
  for(const suffix of [' (1)','(2)']) {
    assert.equal(classifyDownload(prefix+titles[2]+suffix+'.pdf').filename,NAMES[2]);
    assert.equal(classifyDownload(prefix+titles[5]+suffix+'.pdf').filename,NAMES[5]);
    const name=prefix+'본문10단계 워크북 10 본문영작_단계별'+suffix+'.pdf';
    assert.equal(classifyDownload(name).filename,'_raw/'+name);
  }
});
test('synthetic batch copies 13 plus raw, receipt privacy, idempotency, untouched inputs',async t=>{
  const f=await fixture(t);
  for(const title of [...titles,'본문10단계 워크북 1 본문해석지_단계별','본문10단계 워크북 10 본문영작_단계별 (2)'])await f.add(title);
  f.input.source={listingId:'synthetic-list',title:'합성 자료',observedAt:'2026-10-13T00:00:00Z'};
  const before=await Promise.all(f.input.files.map(e=>fs.readFile(e.src)));
  const first=await stageDownloads(f.input,f.options);
  assert.equal(first.status,'complete');assert.equal(first.files.length,15);
  assert.ok(first.files.every(e=>e.outcome==='copied'));
  for(let i=0;i<15;i++) {
    const e=first.files[i];assert.deepEqual(await fs.readFile(path.join(f.root,e.destination)),before[i]);
    assert.deepEqual(await fs.readFile(f.input.files[i].src),before[i]);
    assert.equal(e.sha256,createHash('sha256').update(before[i]).digest('hex'));
    assert.equal(e.bytes,before[i].length);
  }
  const raw=await fs.readFile(path.join(f.root,first.receipt),'utf8');
  assert.ok(!raw.includes(f.sourceRoot));assert.ok(!raw.includes('"src"'));
  const receipt=JSON.parse(raw);assert.deepEqual(receipt.scope,scope);assert.equal(receipt.status,'complete');
  const second=await stageDownloads(f.input,f.options);
  assert.ok(second.files.every(e=>e.outcome==='already_present'));
  assert.notEqual(first.receipt,second.receipt);
  assert.equal((await fs.readdir(path.join(f.root,'_acquisition','receipts'))).length,2);
  assert.equal((await fs.readdir(f.sourceRoot)).length,15);
});
test('Special Lesson/Reading including numbered variants textbook staging',async t=>{
  for(const [unitRawLabel,unitCode] of [['Special Lesson','SL'],['Special Lesson1','SL1'],['Special Reading','SR'],['Special Reading2','SR2']]) {
    const f=await fixture(t);f.input.scope={...scope,unitRawLabel,unitCode,folderName:'2022-ne-kimgitaek-m2-'+unitCode};
    const e=await f.add('본문');const next=e.src.replace('_1과_','_'+unitRawLabel+'_');
    await fs.rename(e.src,next);e.src=next;e.suggestedFilename=path.basename(next);
    const r=await stageDownloads(f.input,f.options);assert.equal(r.status,'complete');
    assert.equal(r.files[0].destination,f.input.scope.folderName+'/'+NAMES[0]);
  }
});
test('same-hash aliases get individual outcomes; different hashes preflight fail',async t=>{
  const f=await fixture(t);await f.add(titles[0],'same');await f.add(titles[0]+' (1)','same');
  const r=await stageDownloads(f.input,f.options);assert.deepEqual(r.files.map(e=>e.outcome),['copied','already_present']);
  const g=await fixture(t);await g.add(titles[0],'a');await g.add(titles[0]+' (2)','b');await noWrite(g);
});
test('raw suffixes stay distinct even if identical content',async t=>{
  const f=await fixture(t);for(const s of ['',' (1)',' (2)'])await f.add('본문10단계 워크북 1 본문_단계별'+s,'same');
  const r=await stageDownloads(f.input,f.options);assert.ok(r.files.every(e=>e.outcome==='copied'));
  assert.equal((await fs.readdir(path.join(f.root,scope.folderName,'_raw'))).length,3);
});
test('existing different PDF never overwritten; no earlier entry copied',async t=>{
  const f=await fixture(t);await f.add(titles[0]);await f.add(titles[1]);
  const dest=path.join(f.root,scope.folderName,NAMES[1]);await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,pdf('existing'));
  await assert.rejects(stageDownloads(f.input,f.options),/conflict/);
  assert.deepEqual(await fs.readFile(dest),pdf('existing'));
  assert.deepEqual(await fs.readdir(path.dirname(dest)),[NAMES[1]]);
  await assert.rejects(fs.stat(path.join(f.root,'_acquisition')),{code:'ENOENT'});
});
test('all preflight safety failures make zero writes',async t=>{
  const variants=[
    async(f,e)=>{e.suggestedFilename='unknown.pdf';},
    async(f,e)=>{e.suggestedFilename='../본문.pdf';},
    async(f,e)=>{e.suggestedFilename='x\\본문.pdf';},
    async(f,e)=>{e.suggestedFilename='https://invalid/본문.pdf';},
    async(f,e)=>{e.suggestedFilename='본문.exe';},
    async(f,e)=>{e.src='relative.pdf';},
    async(f,e)=>{e.src='https://invalid/file.pdf';},
    async(f,e)=>{e.src=path.join(f.dir,'outside.pdf');await fs.writeFile(e.src,pdf('outside'));},
    async(f,e)=>{await fs.unlink(e.src);},
    async(f,e)=>{await fs.writeFile(e.src,'');},
    async(f,e)=>{await fs.writeFile(e.src,'not a PDF');},
    async(f,e)=>{const next=e.src+'.txt';await fs.rename(e.src,next);e.src=next;},
    async(f,e)=>{e.suggestedFilename=e.suggestedFilename.replace('2022개정','2015개정');},
    async(f,e)=>{e.suggestedFilename=e.suggestedFilename.replace('중2','중3');},
    async(f,e)=>{e.suggestedFilename=e.suggestedFilename.replace('_1과_','_2과_');},
    async(f,e)=>{e.suggestedFilename=e.suggestedFilename.replace('NE능률(김기택)','different-slug');},
    async(f,e)=>{e.suggestedFilename=e.suggestedFilename.replace('NE능률(김기택)','미등록출판사');},
    async(f)=>{f.input.scope.folderName='../escape';},
    async(f)=>{f.input.scope.unitCode='L2';},
    async(f)=>{f.input.scope.folderName='2022-other-m2-L1';},
    async(f)=>{f.input.source={cookies:'forbidden'};},
    async(f)=>{f.input.source={title:'https://invalid/private'};},
    async(f)=>{f.input.source={title:'token=forbidden'};},
    async(f)=>{f.input.cookies='forbidden';},
    async(f,e)=>{e.cookie='forbidden';},
    async(f)=>{f.input.files=[];},
    async(f)=>{delete f.input.root;},
    async(f,e)=>{await fs.unlink(e.src);await fs.mkdir(e.src);}
  ];
  for(const mutate of variants){const f=await fixture(t);await f.add(titles[0]);const e=await f.add(titles[1]);await mutate(f,e);await noWrite(f);}
});
test('symlink/junction roots, source ancestors, destination ancestors rejected',async t=>{
  for(const location of ['source','destination','root','receipts']) {
    const f=await fixture(t);await f.add(titles[0]);const actual=path.join(f.dir,'actual');await fs.mkdir(actual);
    if(location==='source') {
      const link=path.join(f.sourceRoot,'linked');await fs.symlink(actual,link,'junction');
      await fs.writeFile(path.join(actual,'input.pdf'),pdf('x'));f.input.files[0].src=path.join(link,'input.pdf');
    } else if(location==='root')await fs.symlink(actual,f.root,'junction');
    else {await fs.mkdir(f.root);await fs.symlink(actual,path.join(f.root,location==='destination'?scope.folderName:'_acquisition'),'junction');}
    await assert.rejects(stageDownloads(f.input,f.options),/Symlink/);
    assert.deepEqual(await fs.readdir(actual),location==='source'?['input.pdf']:[]);
  }
});
test('runtime copy failure reports partial exactly, rerun resumes safely',async t=>{
  const f=await fixture(t);for(const title of titles.slice(0,3))await f.add(title);
  const original=fs.link;let calls=0;fs.link=async(...args)=>{if(++calls===2)throw Error('synthetic failure');return original(...args);};
  let result;try{result=await stageDownloads(f.input,f.options);}finally{fs.link=original;}
  assert.equal(result.status,'partial');assert.deepEqual(result.files.map(e=>e.outcome),['copied','failed','not_attempted']);
  const receipt=JSON.parse(await fs.readFile(path.join(f.root,result.receipt)));assert.equal(receipt.status,'partial');
  const rerun=await stageDownloads(f.input,f.options);assert.deepEqual(rerun.files.map(e=>e.outcome),['already_present','copied','copied']);
});
test('concurrent conflicting creation is not overwritten',async t=>{
  const f=await fixture(t);await f.add(titles[0]);const original=fs.link;
  fs.link=async(src,dest)=>{await fs.writeFile(dest,pdf('racing writer'));return original(src,dest);};
  let result;try{result=await stageDownloads(f.input,f.options);}finally{fs.link=original;}
  assert.equal(result.status,'partial');assert.equal(result.files[0].outcome,'failed');
  assert.deepEqual(await fs.readFile(path.join(f.root,scope.folderName,NAMES[0])),pdf('racing writer'));
});
test('receipt failure still returns exact file outcomes, no false success',async t=>{
  const f=await fixture(t);await f.add(titles[0]);const original=fs.rename;
  fs.rename=async()=>{throw Error('synthetic receipt failure');};
  let result;try{result=await stageDownloads(f.input,f.options);}finally{fs.rename=original;}
  assert.equal(result.status,'receipt_failed');assert.equal(result.receipt,null);assert.equal(result.files[0].outcome,'copied');
});
test('CLI input and root override, no implicit source listing',async t=>{
  const f=await fixture(t);await f.add(titles[0]);await fs.writeFile(path.join(f.sourceRoot,'unlisted.pdf'),'broken');
  const input=path.join(f.dir,'batch.json');await fs.writeFile(input,JSON.stringify({...f.input,root:path.join(f.dir,'unused')}));
  const r=await runStage(['--input',input,'--root',f.root,'--source-root',f.sourceRoot]);assert.equal(r.status,'complete');
  assert.equal(r.files.length,1);await assert.rejects(fs.stat(path.join(f.dir,'unused')),{code:'ENOENT'});
  await assert.rejects(runStage(['--unknown','x']));await assert.rejects(runStage([]));
});

// 모든 파일은 이 테스트의 임시 폴더에 만든 합성 바이트다. 실제 PDF에는 접근하지 않는다.
async function publisherFixture(t, publisherLabel='YBM(김은형)', publisher='ybm-kimeunhyeong') {
  const f=await fixture(t);
  Object.assign(f.input.scope,{publisher,publisherLabel,folderName:'2022-'+publisher+'-m2-L1'});
  for(const title of titles.slice(0,2)) {
    const e=await f.add(title);
    const filename=e.suggestedFilename.replace('NE능률(김기택)',publisherLabel);
    const next=path.join(f.sourceRoot,filename);
    await fs.rename(e.src,next);e.src=next;e.suggestedFilename=filename;
  }
  return f;
}
test('explicit YBM publisher label and caller stable slug succeed without aliases',async t=>{
  const f=await publisherFixture(t);
  const r=await stageDownloads(f.input,f.options);
  assert.equal(r.status,'complete');assert.ok(r.files.every(e=>e.outcome==='copied'));
  assert.equal(r.files[0].destination,'2022-ybm-kimeunhyeong-m2-L1/00_교과서본문.pdf');
  const receipt=JSON.parse(await fs.readFile(path.join(f.root,r.receipt)));
  assert.equal(receipt.scope.publisherLabel,'YBM(김은형)');assert.equal(receipt.scope.publisher,'ybm-kimeunhyeong');
});
test('arbitrary verified publisher is accepted; label matching uses NFC and trim only',async t=>{
  const f=await publisherFixture(t,'검증 출판사(가)','verified-publisher');
  f.input.scope.publisherLabel='  '+f.input.scope.publisherLabel.normalize('NFD')+'  ';
  const r=await stageDownloads(f.input,f.options);assert.equal(r.status,'complete');
  for(const wrong of ['ybm(김은형)','YBM (김은형)','YBM(김은혜)','ybm-kimeunhyeong']) {
    const g=await publisherFixture(t);g.input.scope.publisherLabel=wrong;await noWrite(g);
  }
});
test('publisher label mismatch in any entry and folder slug mismatch preflight with zero writes',async t=>{
  const f=await publisherFixture(t);
  f.input.files[1].suggestedFilename=f.input.files[1].suggestedFilename.replace('YBM(김은형)','NE능률(김기택)');
  await noWrite(f);
  const g=await publisherFixture(t);g.input.scope.folderName=scope.folderName;await noWrite(g);
  const h=await publisherFixture(t);h.input.scope.publisher='different-slug';await noWrite(h);
  const j=await publisherFixture(t);j.input.scope.folderName='2022-YBM(김은형)-m2-L1';await noWrite(j);
  const k=await publisherFixture(t);k.input.files[1].src=path.join(k.sourceRoot,'중2_NE능률(김기택)_1과_본문.pdf');
  await fs.writeFile(k.input.files[1].src,pdf('source mismatch'));await noWrite(k);
});
test('publisherLabel required for every batch; missing suggested publisher cannot bypass check',async t=>{
  for(const invalid of [undefined,null,'','   ',42,'https://invalid/publisher']) {
    const f=await fixture(t);await f.add(titles[0]);
    if(invalid===undefined)delete f.input.scope.publisherLabel;else f.input.scope.publisherLabel=invalid;
    await noWrite(f);
  }
  const f=await fixture(t);await f.add(titles[0]);f.input.files[0].suggestedFilename='본문.pdf';await noWrite(f);
  const g=await fixture(t);await g.add(titles[0]);
  delete g.input.scope.publisherLabel;g.input.scope.sourcePublisherLabel='NE능률(김기택)';await noWrite(g);
});

const revisionSuffixes = [
  '_(20260219수정)', '  _ ( 20260219 수정 )  ',
  '_(20260219수정) (1)', '_(20260219수정)(2)',
  ' (1)_(20260219수정)', '(2)  _ (20260219수정)  ',
  '_(260109수정)', '  _ ( 260109 수정 )  ',
  '_(260109수정) (1)', ' (2)_(260109수정)'
];
test('verified revision suffix handles integrated, grammar 07/08, textbook and both duplicate orders',()=>{
  for(const [title,index] of [[titles[2],2],[titles[10],10],[titles[11],11],[titles[0],0]]) {
    for(const suffix of revisionSuffixes) {
      const r=classifyDownload(prefix+title+suffix+'.pdf');
      assert.deepEqual(r,{filename:NAMES[index],stage:null});
    }
  }
  assert.equal(classifyDownload(prefix+titles[10]+'_(20260526수정).pdf').filename,NAMES[10]);
  assert.equal(classifyDownload('(2022개정)2025년_중1_동아(윤정미)_4과_[04]예상문제 PRE-STEP(교사용)_(260109수정).pdf').filename,NAMES[5]);
});
test('revision stage1/10 classification preserves exact raw name with either duplicate order',()=>{
  for(const n of [1,10])for(const suffix of revisionSuffixes) {
    const name=prefix+'본문10단계 워크북 '+n+' 본문영작_단계별'+suffix+'.pdf';
    assert.deepEqual(classifyDownload(name),{filename:'_raw/'+name,stage:n});
  }
});
test('synthetic revision staging keeps suggested names and raw basenames byte-for-byte',async t=>{
  const f=await fixture(t);
  for(const title of [titles[2],titles[10],titles[11],titles[0]])await f.add(title+'_(20260219수정) (1)');
  for(const n of [1,10])for(const suffix of revisionSuffixes)await f.add('본문10단계 워크북 '+n+' 본문영작_단계별'+suffix);
  const originals=await Promise.all(f.input.files.map(e=>fs.readFile(e.src)));
  const result=await stageDownloads(f.input,f.options);
  assert.equal(result.status,'complete');assert.ok(result.files.every(e=>e.outcome==='copied'));
  const receipt=JSON.parse(await fs.readFile(path.join(f.root,result.receipt)));
  for(let i=0;i<f.input.files.length;i++) {
    const source=f.input.files[i],record=receipt.files[i];
    assert.equal(record.suggestedFilename,source.suggestedFilename);
    assert.equal(record.sourceName,path.basename(source.src));
    if(i>=4)assert.equal(record.destination,scope.folderName+'/_raw/'+source.suggestedFilename);
    assert.deepEqual(await fs.readFile(path.join(f.root,record.destination)),originals[i]);
    assert.deepEqual(await fs.readFile(source.src),originals[i]);
  }
  assert.deepEqual((await fs.readdir(path.join(f.root,scope.folderName,'_raw'))).sort(),f.input.files.slice(4).map(e=>e.suggestedFilename).sort());
});
test('malformed revisions and arbitrary parentheses are rejected with zero preflight writes',async t=>{
  const malformed=['_(26010수정)','_(2601090수정)','_(2026021수정)','_(202602190수정)','_(2026A219수정)',
    '_(2026 0219수정)','_(20260219정정)','_(20260219수정본)','_(20260219)',
    '_(수정)','(20260219수정)','_(20260219수정','_(20260219수정) tail',
    '_(20260219수정)_(20260526수정)','_(임의 괄호)'];
  const checkedTitles=[titles[2],titles[10],titles[11],titles[0],'본문10단계 워크북 1 본문_단계별','본문10단계 워크북 10 본문_단계별'];
  for(const suffix of malformed) {
    for(const title of checkedTitles)for(const withDuplicate of [suffix,suffix+' (1)',' (2)'+suffix]) {
      assert.throws(()=>classifyDownload(prefix+title+withDuplicate+'.pdf'),/Unclassified/);
    }
    const f=await fixture(t);await f.add(titles[0]);await f.add(titles[2]+suffix);await noWrite(f);
  }
});
