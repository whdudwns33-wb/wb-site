import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,basename,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import vm from 'node:vm';

const here=new URL('.',import.meta.url);
const wrapper=readFileSync(new URL('wrapper-template.html',here),'utf8');
const password=crypto.randomBytes(24).toString('base64');
const config={v:1,salt:crypto.randomBytes(16).toString('base64'),iterations:310000};
const key=crypto.pbkdf2Sync(password,Buffer.from(config.salt,'base64'),config.iterations,32,'sha256');
const raw=key.toString('base64');
function decrypt(p,k=key){
  const c=Buffer.from(p.c,'base64'),d=crypto.createDecipheriv('aes-256-gcm',k,Buffer.from(p.i,'base64'));
  d.setAuthTag(c.subarray(-16));return Buffer.concat([d.update(c.subarray(0,-16)),d.final()]);
}
function payload(text){
  const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);
  return {s:config.salt,it:config.iterations,i:iv.toString('base64'),c:Buffer.concat([c.update(text),c.final(),c.getAuthTag()]).toString('base64')};
}

test('real builds preserve the device key, change every IV, and reject invalid KDF configuration before writing',t=>{
  const dir=mkdtempSync(join(tmpdir(),'wb-remember-test-')),src=join(dir,'src');mkdirSync(src);
  t.after(()=>{assert.equal(dirname(resolve(dir)),resolve(tmpdir()));assert.ok(basename(dir).startsWith('wb-remember-test-'));rmSync(dir,{recursive:true});});
  for(const f of ['build.mjs','wrapper-template.html'])copyFileSync(new URL(f,here),join(src,f));
  writeFileSync(join(src,'encryption-config.json'),JSON.stringify(config));
  writeFileSync(join(src,'app.html'),'<!doctype html><script>const SEED_PRIV={univs:{},profiles:{}}; /*BUILD:PRIVATE_SEED*/\nconst BUILD_TAG="dev"; /*BUILD:TAG*/</script>');
  writeFileSync(join(src,'private-seed.json'),'{"univs":{},"profiles":{}}');
  writeFileSync(join(src,'bulk-data.json'),'{"ip":[],"hs":[],"ach":null}');
  const run=(pw=password)=>spawnSync(process.execPath,[join(src,'build.mjs')],{env:{...process.env,WB_PASSWORD:pw},encoding:'utf8',windowsHide:true});
  const output=()=>({p:JSON.parse(readFileSync(join(dir,'index.html'),'utf8').match(/const P=(\{[^\n]+\});/)[1]),b:JSON.parse(readFileSync(join(dir,'bulk.enc.json'),'utf8'))});
  assert.equal(run().status,0);const a=output();assert.equal(run().status,0);const b=output();
  assert.equal(a.p.s,b.p.s);assert.equal(a.p.it,b.p.it);
  assert.equal(new Set([a.p.i,a.b.i,b.p.i,b.b.i]).size,4);
  for(const x of [a,b]){
    assert.match(decrypt(x.p).toString(),new RegExp(x.b.t));
    assert.equal(gunzipSync(decrypt(x.b)).toString(),'{"ip":[],"hs":[],"ach":null}');
  }
  assert.notEqual(a.b.t,b.b.t);assert.notEqual(a.p.c,b.p.c);
  assert.equal(run(crypto.randomBytes(24).toString('base64')).status,0);assert.throws(()=>decrypt(output().p));
  const before=readFileSync(join(dir,'index.html'));
  for(const invalid of [{...config,salt:'bad'},{...config,salt:config.salt+' '},{...config,iterations:1},{...config,v:2},null]){
    writeFileSync(join(src,'encryption-config.json'),JSON.stringify(invalid));assert.notEqual(run().status,0);
    assert.ok(readFileSync(join(dir,'index.html')).equals(before));
  }
  rmSync(join(src,'encryption-config.json'));assert.notEqual(run().status,0);assert.ok(readFileSync(join(dir,'index.html')).equals(before));
});

async function login(p,stored=new Map(),fail=()=>false){
  const nodes=Object.fromEntries(['f','btn','pw','rm','err'].map(id=>[id,{value:'',checked:true,textContent:'',addEventListener(event,fn){this[event]=fn;}}]));
  const c={crypto:crypto.webcrypto,TextEncoder,TextDecoder,Uint8Array,atob,btoa,window:{},
    localStorage:{getItem(k){if(fail('get',k))throw Error('blocked');return stored.get(k)||null;},setItem(k,v){if(fail('set',k))throw Error('quota');stored.set(k,v);},removeItem(k){if(fail('remove',k))throw Error('blocked');stored.delete(k);}},
    document:{readyState:'complete',getElementById:id=>nodes[id],open(){},write:html=>c.opened=html,close(){}}};
  vm.createContext(c);
  vm.runInContext(wrapper.match(/<script>([\s\S]*?)<\/script>/)[1].replace('__PAYLOAD__',JSON.stringify(p)).replace('tryStored();','globalThis.ready=tryStored();'),c);
  await c.ready;
  return {c,nodes,stored,submit:async(pw=password,remember=true)=>{nodes.pw.value=pw;nodes.rm.checked=remember;await nodes.f.submit({preventDefault(){}});}};
}
test('remembered key opens a new payload without storing the password or changing counseling records',async()=>{
  const stored=new Map([['wb-consulting-v1','synthetic counseling history']]);
  const a=await login(payload('build A'),stored);await a.submit();assert.equal(a.c.opened,'build A');assert.equal(a.nodes.pw.value,'');
  assert.equal(stored.get('wb-wb-key'),raw);assert.ok(![...stored.values()].includes(password));
  const b=await login(payload('build B'),stored);assert.equal(b.c.opened,'build B');assert.equal(b.c.window.__wbKey,raw);
  assert.equal(stored.get('wb-consulting-v1'),'synthetic counseling history');
});
test('wrong passwords and malformed or old keys never replace counseling records',async()=>{
  for(const bad of ['not base64',crypto.randomBytes(32).toString('base64')]){
    const stored=new Map([['wb-wb-key',bad],['wb-consulting-v1','unchanged']]);
    const a=await login(payload('opened'),stored);assert.equal(a.c.opened,undefined);assert.equal(stored.has('wb-wb-key'),false);
    await a.submit('wrong');assert.match(a.nodes.err.textContent,/비밀번호/);assert.equal(stored.has('wb-wb-key'),false);
    assert.equal(stored.get('wb-consulting-v1'),'unchanged');assert.equal(a.nodes.btn.disabled,false);
  }
});
test('unchecking remember removes only the old key and still provides the session key for bulk',async()=>{
  const a=await login(payload('opened'));a.stored.set('wb-wb-key','older key');a.stored.set('wb-consulting-v1','unchanged');
  await a.submit(password,false);assert.equal(a.c.opened,'opened');assert.equal(a.c.window.__wbKey,raw);
  assert.equal(a.stored.has('wb-wb-key'),false);assert.equal(a.stored.get('wb-consulting-v1'),'unchanged');
  assert.equal((await login(payload('next'),a.stored)).c.opened,undefined);
});
test('a failed old-key login cannot remove a newer key saved by another tab',async()=>{
  const stored=new Map([['wb-wb-key','broken key']]);let reads=0;
  const a=await login(payload('opened'),stored,(op,k)=>{
    if(op==='get'&&k==='wb-wb-key'&&++reads===2)stored.set(k,'newer key from another tab');
    return false;
  });
  assert.equal(a.c.opened,undefined);assert.equal(stored.get('wb-wb-key'),'newer key from another tab');
});
test('blocked device storage does not turn a correct password into a password error',async()=>{
  for(const operation of ['get','set','remove']){
    const a=await login(payload('opened'),new Map(),op=>op===operation);await a.submit(password,operation!=='remove');
    assert.equal(a.c.opened,'opened');assert.equal(a.c.window.__wbKey,raw);assert.equal(a.nodes.err.textContent,'');
    if(operation!=='get')assert.match(a.c.window.__wbRememberWarning,/못했습니다/);
  }
});
test('forgetting a device preserves all counseling data and the current session; deletion failures stay visible',()=>{
  const html=readFileSync(new URL('app.html',here),'utf8'),start=html.indexOf('function forgetDevice(){'),end=html.indexOf('function modal(',start);
  const stored=new Map([['wb-wb-key',raw],['wb-consulting-v1','synthetic records']]);
  const c={window:{__wbKey:raw},localStorage:{removeItem:k=>stored.delete(k)},renderSide(){},toast:m=>c.message=m};vm.createContext(c);vm.runInContext(html.slice(start,end),c);
  c.forgetDevice();assert.equal(stored.has('wb-wb-key'),false);assert.equal(stored.get('wb-consulting-v1'),'synthetic records');assert.equal(c.window.__wbKey,raw);
  c.localStorage.removeItem=()=>{throw Error('blocked');};c.forgetDevice();assert.match(c.message,/해제하지 못했습니다/);
});
