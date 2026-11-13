import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {readQuestionImage} from './naesin-local-materials.mjs';
const temp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'wb-naesin-root-'));
const data=path.join(temp,'internal','naesin-server'), ext=path.join(temp,'external','materials');
const png=Buffer.from('89504e470d0a1a0a','hex'), hash=crypto.createHash('sha256').update(png).digest('hex');
const original=process.env.WB_NAESIN_MATERIALS_DIR;
try {
  fs.mkdirSync(data,{recursive:true});fs.mkdirSync(path.join(ext,'question-images'),{recursive:true});
  const file=path.join(ext,'question-images',hash+'.png');fs.writeFileSync(file,png);
  process.env.WB_NAESIN_MATERIALS_DIR=ext;
  assert.deepEqual(readQuestionImage(data,hash),png);
  assert.throws(()=>readQuestionImage(data,'a'.repeat(64)));
  fs.linkSync(file,path.join(temp,'hard-link'));assert.throws(()=>readQuestionImage(data,hash));fs.unlinkSync(path.join(temp,'hard-link'));
  const link=path.join(temp,'linked-root');fs.symlinkSync(ext,link,'dir');process.env.WB_NAESIN_MATERIALS_DIR=link;
  assert.throws(()=>readQuestionImage(data,hash));
  process.env.WB_NAESIN_MATERIALS_DIR='relative/materials';assert.throws(()=>readQuestionImage(data,hash));
  delete process.env.WB_NAESIN_MATERIALS_DIR;
  const fallback=path.join(temp,'internal','naesin-materials','question-images');fs.mkdirSync(fallback,{recursive:true});fs.writeFileSync(path.join(fallback,hash+'.png'),png);
  assert.deepEqual(readQuestionImage(data,hash),png);
  console.log('외장 자료 경로·기존 기본값·상대경로 거부·심볼릭 링크 거부·다중 링크 거부·해시 검증 통과');
} finally {
  if(original===undefined)delete process.env.WB_NAESIN_MATERIALS_DIR;else process.env.WB_NAESIN_MATERIALS_DIR=original;
  fs.rmSync(temp,{recursive:true,force:true});
}
