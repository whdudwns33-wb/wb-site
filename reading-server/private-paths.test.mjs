import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {privatePaths} from './private-paths.mjs';
const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'wb-private-paths-')), data=path.join(dir,'internal','data'), resources=path.join(dir,'external');
fs.mkdirSync(data,{recursive:true});
try {
  assert.deepEqual(privatePaths(data,''),{materials:path.join(dir,'internal','naesin-materials'),audio:path.join(data,'naesin-audio')});
  assert.throws(()=>privatePaths(data,'relative'));
  const materials=path.join(resources,'naesin-materials');
  process.env.DATA_DIR=data;process.env.WB_NAESIN_MATERIALS_DIR=materials;
  assert.equal(privatePaths(data).audio,path.join(resources,'naesin-audio'));
  const store=await import('./store.mjs');store.load();await store.snapshotNow();
  assert.ok(fs.readdirSync(path.join(data,'private-backups')).some(n=>n.endsWith('.json')));
  assert.ok(!fs.existsSync(path.join(resources,'naesin-private-backups')));
  console.log('기존 기본값·외장 음성·내장 비공개 복구점·상대경로 거부 통과. 자체 빈 DB만 사용.');
} finally {fs.rmSync(dir,{recursive:true,force:true});}
