import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJson } from './json-file.mjs';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-json-')),file=path.join(dir,'own.json');
try {
  const value={long:'x'.repeat(32767)+'😀한글\n"\\\ud800'+'y'.repeat(70000),array:[1,,undefined,NaN,null],
    nested:{map:{one:{quotes:'"\\\n',array:[false,true,null]}}},omitted:undefined,date:new Date(0)};
  await writeJson(file,value);
  assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),JSON.parse(JSON.stringify(value)));
  await assert.rejects(writeJson(file,{circular:(()=>{const c={};c.self=c;return c;})()}),TypeError);
  console.log('OK — chunked JSON preserves Unicode boundaries, escapes, arrays, nulls and rejects cycles');
} finally {
  assert.equal(path.dirname(fs.realpathSync(dir)),fs.realpathSync(os.tmpdir()));
  fs.rmSync(dir,{recursive:true,force:true});
}
