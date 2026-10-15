import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readSourceLibrary} from './naesin-local-materials.mjs';

const parent=fs.realpathSync(os.tmpdir()),root=fs.mkdtempSync(path.join(parent,'wbn-library-'));
const data=path.join(root,'data'),library=path.join(root,'naesin-materials','library'),pack='own-pack';
const bytes=Buffer.from('%PDF-1.4\nOwn synthetic source only.\n%%EOF');
const sha256=createHash('sha256').update(bytes).digest('hex');
const rights={basis:'self_authored',holder:'Synthetic fixture',evidenceRef:'own fixture',studentUseAllowed:true,derivativeUseAllowed:true,externalAiAllowed:false};
const doc={id:'src-000001',packId:pack,grade:'m1',unit:'1과',title:'자체 창작 원본',file:pack+'/own.pdf',bytes:bytes.length,sha256,pageCount:1};
const index={version:1,rights,documents:[doc]};
fs.mkdirSync(path.join(library,pack),{recursive:true});fs.mkdirSync(data);
const write=value=>fs.writeFileSync(path.join(library,'index.json'),JSON.stringify(value));
try{
  write(index);fs.writeFileSync(path.join(library,doc.file),bytes);
  const listing=readSourceLibrary(data);
  assert.equal(listing.documents.length,1);assert.equal(listing.studentPublished,false);assert.ok(!('file' in listing.documents[0]));
  assert.deepEqual(readSourceLibrary(data,doc.id,sha256).bytes,bytes);
  for(const patch of [{file:pack+'/../outside.pdf'},{file:pack+'/x\\outside.pdf'},{file:'other/own.pdf'},{sha256:'x'},{grade:'m4'},{bytes:0}]){
    write({...index,documents:[{...doc,...patch}]});assert.throws(()=>readSourceLibrary(data));
  }
  write({...index,documents:[doc,doc]});assert.throws(()=>readSourceLibrary(data));
  write({...index,rights:{...rights,externalAiAllowed:true}});assert.throws(()=>readSourceLibrary(data));
  write({...index,rights:{...rights,studentUseAllowed:false}});assert.throws(()=>readSourceLibrary(data));
  write(index);assert.throws(()=>readSourceLibrary(data,doc.id,'0'.repeat(64)),/LOCAL_SOURCE_CHANGED/);
  assert.throws(()=>readSourceLibrary(data,'../index.json',sha256));
  fs.writeFileSync(path.join(library,doc.file),Buffer.from('altered'));
  assert.throws(()=>readSourceLibrary(data,doc.id,sha256),/LOCAL_SOURCE_CHANGED/);
  console.log('source library listing, PDF integrity, rights, duplicate IDs and path boundaries passed');
}finally{
  assert.equal(path.dirname(fs.realpathSync(root)),parent);fs.rmSync(root,{recursive:true,force:true});
}
