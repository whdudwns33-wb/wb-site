import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CANONICAL,normalizeUnit,classify,scan,verify,report,atomicWrite,run} from './acquire.mjs';
const fresh=root=>({version:1,root,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),rows:[]});
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'acquire-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
const pdf=s=>'%PDF-1.4\n% synthetic '+s+'\n%%EOF';

test('bulk scopes seed every unit once without losing nested stages or stable row identities',async t=>{
  const root=await fixture(t);
  for(const unit of ['L1','L2']){
    const dir=path.join(root,'2022-own-m1-'+unit);await fs.mkdir(path.join(dir,'_raw'),{recursive:true});
    await fs.writeFile(path.join(dir,'00_교과서본문.pdf'),pdf(unit+' body'));
    await fs.writeFile(path.join(dir,'_raw','02_본문워크북_stage-1.pdf'),pdf(unit+' stage'));
  }
  const m=fresh(root);await scan(m);assert.equal(m.rows.length,46);assert.equal(report(m).files,4);assert.equal(report(m).canonicalSelected,2);
  assert.equal(m.rows.filter(r=>r.variant==='stage-1'&&r.rawPath).length,2);
  const ids=m.rows.map(r=>r.id);await verify(m);await scan(m);assert.deepEqual(m.rows.map(r=>r.id),ids);assert.equal(report(m).statusCounts.verified,4);
});
test('unit source labels and stage/suffix normalization',()=>{for(const [a,b] of [['Special Lesson','SL'],['Special Lesson1','SL1'],['Special Lesson 2','SL2'],['Special Reading','SR'],['Special Reading1','SR1'],['Special Reading2','SR2'],['L12','L12']])assert.equal(normalizeUnit(a),b);assert.equal(normalizeUnit('L13'),null);assert.equal(classify('02_본문워크북_10단계 (2).pdf').variant,'stage-10');assert.equal(classify('04_예상문제_PRE-STEP_교사용 (1).pdf').variant,'teacher');});
test('13 canonical, 10 stages, dedup, conflicting content, read-only and resume',async t=>{const root=await fixture(t),folder='2022-ne-kimgitaek-m2-L1';await fs.mkdir(path.join(root,folder));const originals=new Map();for(const c of CANONICAL){const name=c.prefix+'_자료'+(c.variant==='teacher'?'_교사용':'')+'.pdf';const p=path.join(root,folder,name);const bytes=pdf(c.material+c.variant);await fs.writeFile(p,bytes);originals.set(p,bytes);}for(let i=1;i<=10;i++)await fs.writeFile(path.join(root,folder,'02_본문워크북_stage-'+i+'.pdf'),pdf('stage'+i));const m=fresh(root);await scan(m);assert.equal(m.rows.length,23);assert.equal(report(m).canonicalSelected,13);assert.equal(report(m).files,23);await verify(m);assert.equal(report(m).statusCounts.verified,23);const ids=m.rows.map(r=>r.id);await scan(m);assert.deepEqual(m.rows.map(r=>r.id),ids);assert.equal(report(m).statusCounts.verified,23);await fs.writeFile(path.join(root,folder,'00_자료 (1).pdf'),pdf('textbookstudent'));await scan(m);assert.equal(report(m).duplicateHashes.length,1);assert.equal(report(m).canonicalSelected,13);await fs.writeFile(path.join(root,folder,'00_자료 (2).pdf'),pdf('different'));await scan(m);assert.equal(report(m).canonicalSelected,12);assert.deepEqual(report(m).units[0].conflicts,['textbook:student']);for(const [p,b]of originals)assert.equal(await fs.readFile(p,'utf8'),b);});
test('partial special lesson, invalid/empty/missing/changed files',async t=>{const root=await fixture(t),folder='2022-ne-kimgitaek-m2-Special Reading2';await fs.mkdir(path.join(root,folder));const p=path.join(root,folder,'00_교과서본문.pdf');await fs.writeFile(p,pdf('a'));await fs.writeFile(path.join(root,folder,'01_내용정리.pdf'),'');const m=fresh(root);await scan(m);assert.equal(m.rows[0].unitRawLabel,'Special Reading2');assert.equal(report(m).units[0].unitCode,'SR2');assert.equal(report(m).errors.length,1);await fs.writeFile(p,pdf('b'));await verify(m);assert.equal(m.rows.find(r=>r.material==='textbook').error,'HASH_CHANGED');await fs.unlink(p);await scan(m);assert.equal(m.rows.find(r=>r.material==='textbook').error,'MISSING_FILE');});
test('atomic backup, validation rollback, init resume, lock, inventory security',async t=>{const root=await fixture(t),file=path.join(root,'_acquisition','manifest.json');await run(['init','--root',root]);const before=await fs.readFile(file,'utf8');await run(['init','--root',root]);assert.equal(JSON.parse(await fs.readFile(file)).createdAt,JSON.parse(before).createdAt);assert.ok((await fs.readdir(path.dirname(file))).some(n=>n.includes('.bak-')));const m=JSON.parse(await fs.readFile(file));m.rows=[{cookie:'no'}];await assert.rejects(atomicWrite(file,m));await fs.writeFile(file+'.lock','test');await assert.rejects(run(['scan','--root',root]),/locked/);await fs.unlink(file+'.lock');const input=path.join(root,'inventory.json');await fs.writeFile(input,JSON.stringify([{id:'future',curriculum:'2015',grade:'m3',publisher:'unknown-publisher',unitRawLabel:'Special Reading',unitCode:'SR',material:'workbook',variant:'stage-1',status:'not_available'}]));await run(['inventory','--root',root,'--input',input]);await run(['scan','--root',root]);const loaded=JSON.parse(await fs.readFile(file));assert.equal(loaded.rows[0].status,'not_available');const snapshot=await fs.readFile(file,'utf8');await fs.writeFile(input,JSON.stringify([{id:'bad',downloadUrl:'https://example.invalid/secret'}]));await assert.rejects(run(['inventory','--root',root,'--input',input]));assert.equal(await fs.readFile(file,'utf8'),snapshot);await run(['report','--root',root]);assert.equal(await fs.readFile(file,'utf8'),snapshot);assert.ok(!(await fs.readdir(path.dirname(file))).some(n=>n.includes('.tmp-')));});
const siteName=n=>'(2022개정)2026년_중2_NE능률(김기택)_1과_본문10단계 워크북 '+n+' '+(n===1?'본문해석지':'본문영작')+'_단계별.pdf';
test('real Korean workbook titles, Unicode spacing, integrated negative and download suffixes',()=>{
  for(const n of [1,10])for(const suffix of ['', ' (1)', ' (2)'])assert.deepEqual(classify(siteName(n).replace('.pdf',suffix+'.pdf')),{material:'workbook',variant:'stage-'+n});
  assert.equal(classify('본문 10 단계 워크북\t10\u3000본문영작_단계별.pdf').variant,'stage-10');
  for(const title of ['본문 10 단계 워크북 통합본(1~10).pdf','본문 10 단계 워크북 11 본문.pdf','본문10단계 워크북 통합본(1~10).pdf','본문10단계 워크북 통합본(1~10) (2).pdf','본문10단계 워크북 11 본문.pdf','본문10단계 워크북 100 English.pdf','본문10단계 워크북 1English.pdf'])assert.equal(classify(title).material,'unclassified');
  assert.equal(classify('02_본문10단계 워크북 통합본(1~10).pdf').variant,'integrated');
});
// 재현 픽스처: available 목록 슬롯 + 이전 스캐너가 만든 verified 미분류 원본 행.
async function migrationFixture(t){
  const root=await fixture(t),folder='2022-ne-kimgitaek-m2-L1',rawPath=folder+'/_raw/'+siteName(1);
  await fs.mkdir(path.join(root,folder,'_raw'),{recursive:true});await fs.writeFile(path.join(root,rawPath),pdf('migration'));
  const m=fresh(root);await scan(m);await verify(m);
  const slot=m.rows.find(r=>r.rawPath),original=structuredClone(slot);
  const legacy={...structuredClone(slot),id:'legacy-unclassified',material:'unclassified',variant:'unknown',pageCount:3};
  Object.assign(slot,{status:'available',rawPath:null,bytes:null,sha256:null,verifiedAt:null,scannedAt:null,attempts:0,source:{listingId:'listing-fixture',title:'단계 목록',catalogLabel:'목록 확인',observedAt:'2026-10-13T00:00:00Z'}});
  m.rows.push(legacy);return {m,slot,legacy,original};
}
test('migration merges existing raw row into seeded inventory without data loss, and resumes',async t=>{
  const {m,slot,legacy,original}=await migrationFixture(t),source=structuredClone(slot.source),id=slot.id;
  await scan(m);assert.equal(m.rows.length,23);assert.equal(m.rows.filter(r=>r.variant==='stage-1').length,1);
  assert.equal(m.rows.includes(legacy),false);assert.equal(slot.id,id);assert.deepEqual(slot.source,source);
  for(const k of ['rawPath','sha256','bytes','verifiedAt'])assert.equal(slot[k],original[k]);
  assert.equal(slot.pageCount,3);assert.equal(slot.status,'verified');assert.equal(report(m).unclassified.length,0);
  assert.equal(report(m).files,1);assert.equal(report(m).errors.length,0);
  const ids=m.rows.map(r=>r.id);await scan(m);await verify(m);assert.deepEqual(m.rows.map(r=>r.id),ids);
  assert.equal(await fs.readFile(path.join(m.root,slot.rawPath),'utf8'),pdf('migration'));
  await atomicWrite(path.join(m.root,'_acquisition','manifest.json'),m);
});
test('migration never overwrites an occupied slot; verify does not hide the conflict',async t=>{
  const {m,slot,legacy}=await migrationFixture(t);
  const other=legacy.rawPath.replace('.pdf',' (2).pdf');await fs.writeFile(path.join(m.root,other),pdf('different file'));
  Object.assign(slot,{rawPath:other,status:'downloaded'});
  await scan(m);assert.equal(legacy.error,'MIGRATION_SLOT_CONFLICT');assert.equal(slot.rawPath,other);
  assert.equal(m.rows.includes(legacy),true);assert.equal(report(m).files,2);
  await verify(m);assert.equal(legacy.error,'MIGRATION_SLOT_CONFLICT');assert.equal(report(m).errors.length,1);
  assert.equal(await fs.readFile(path.join(m.root,legacy.rawPath),'utf8'),pdf('migration'));
  assert.equal(await fs.readFile(path.join(m.root,other),'utf8'),pdf('different file'));
});
test('migration retains both rows when inventory source metadata conflicts',async t=>{
  const {m,slot,legacy}=await migrationFixture(t);legacy.source.title='다른 목록 제목';
  await scan(m);assert.equal(legacy.error,'MIGRATION_METADATA_CONFLICT');assert.equal(slot.rawPath,null);
  assert.equal(legacy.source.title,'다른 목록 제목');assert.equal(slot.source.title,'단계 목록');
});

test('held scopes stay on disk but are excluded from active manifest until released',async t=>{
  const root=await fixture(t),folder='2015-m3-p01-m3-L1',full=path.join(root,folder,'_raw','01_자료.pdf');
  await fs.mkdir(path.dirname(full),{recursive:true});await fs.writeFile(full,pdf('held'));
  await fs.mkdir(path.join(root,'_acquisition'),{recursive:true});
  await fs.writeFile(path.join(root,'_acquisition','holds.json'),JSON.stringify({version:1,folders:[{folderName:folder,reason:'out-of-order'}]}));
  const m=fresh(root);await scan(m);await verify(m);
  assert.equal(report(m).files,0);assert.equal(m.rows.length,0);assert.equal(await fs.readFile(full,'utf8'),pdf('held'));
  await fs.unlink(path.join(root,'_acquisition','holds.json'));await scan(m);await verify(m);
  assert.equal(report(m).files,1);assert.equal(report(m).statusCounts.verified,1);assert.equal(await fs.readFile(full,'utf8'),pdf('held'));
});
