import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const tmp=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(tmp,'wb-pack-store-'));
process.env.DATA_DIR=dir;
const store=await import('./store.mjs'),file=path.join(dir,'db.json'),packs=path.join(dir,'naesin-packs');
const savedFile=id=>path.join(packs,Buffer.from(id).toString('hex')+'.json');
const rec=(id,text)=>({pack:{packId:id,ownText:text},updatedAt:new Date().toISOString()});
const restart=body=>{
  const result=spawnSync(process.execPath,['--input-type=module','-e',`import assert from 'node:assert/strict';import {load} from ${JSON.stringify(new URL('./store.mjs',import.meta.url).href)};${body}`],{env:process.env,windowsHide:true,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
};
try {
  const old=rec('Own-Pack','Own legacy text');
  fs.writeFileSync(file,JSON.stringify({students:{},naesin:{packs:{'Own-Pack':old},packIds:['Own-Pack']}}));
  const db=store.load(),before=fs.readFileSync(file,'utf8');
  const day=new Date(Date.now()+9*3600e3).toISOString().slice(0,10);fs.mkdirSync(path.join(dir,'backups'));fs.writeFileSync(path.join(dir,'backups','db-'+day+'.json'),'{}');
  Object.defineProperty(db,'ownDoNotSerialize',{enumerable:true,configurable:true,get(){throw Error('Pack upload serialized whole DB');}});
  await Promise.all([store.persistNaesinPack('Own-Pack',rec('Own-Pack','Own replacement')),
    store.persistNaesinPack('own-pack',rec('own-pack','Own case distinct ID'))]);
  assert.equal(fs.readFileSync(file,'utf8'),before);
  restart(`const db=load();assert.equal(db.naesin.packs['Own-Pack'].pack.ownText,'Own replacement');assert.equal(db.naesin.packs['own-pack'].pack.ownText,'Own case distinct ID');assert.equal(db.naesin.packIds.length,2);`);
  await Promise.all([store.persistNaesinPack('Own-Pack',rec('Own-Pack','Own first')),
    store.persistNaesinPack('Own-Pack',{deleted:true}),store.persistNaesinPack('Own-Pack',rec('Own-Pack','Own last'))]);
  assert.equal(db.naesin.packs['Own-Pack'].pack.ownText,'Own last');
  assert.equal(db.naesin.packIds.filter(id=>id==='Own-Pack').length,1);
  const saved=fs.readFileSync(savedFile('Own-Pack'),'utf8');
  fs.mkdirSync(savedFile('Own-Pack')+'.tmp');
  await assert.rejects(store.persistNaesinPack('Own-Pack',rec('Own-Pack','Must not commit')),{code:'STORE_WRITE_FAILED'});
  assert.equal(fs.readFileSync(savedFile('Own-Pack'),'utf8'),saved);
  assert.equal(db.naesin.packs['Own-Pack'].pack.ownText,'Own last');fs.rmdirSync(savedFile('Own-Pack')+'.tmp');
  await assert.rejects(store.persistNaesinPack('../bad',rec('../bad','Own')),/Invalid pack/);
  await assert.rejects(store.persistNaesinPack('Own-Pack',rec('Other-ID','Own')),/Invalid pack/);
  await store.persistNaesinPack('Own-Pack',{deleted:true});
  restart(`const db=load();assert.ok(!db.naesin.packs['Own-Pack']);assert.ok(!db.naesin.packIds.includes('Own-Pack'));assert.ok(db.naesin.packs['own-pack']);`);
  delete db.ownDoNotSerialize;await store.persist();
  const id=await store.snapshotNow();
  assert.ok(!JSON.stringify(store.getBackup(id)).includes('Own case distinct ID'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'private-backups','db-'+id+'.json'),'utf8')).naesin.packs['own-pack'].pack.ownText,'Own case distinct ID');
  fs.writeFileSync(savedFile('own-pack'),'{');restart(`assert.throws(load,/naesin-packs/);`);
  assert.equal(fs.readFileSync(savedFile('own-pack'),'utf8'),'{');
  console.log('OK — incremental pack save/delete, case distinct IDs, concurrent writes, legacy restart, failed-write preservation, private backup and corruption stop');
}finally{assert.equal(path.dirname(fs.realpathSync(dir)),tmp);fs.rmSync(dir,{recursive:true,force:true});}
