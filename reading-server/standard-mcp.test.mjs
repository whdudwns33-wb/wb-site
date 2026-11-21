import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from './worker.mjs';

const origin = 'https://wb-reading.whdudwns33.workers.dev';
const db = new DatabaseSync(':memory:');
const key = 'rdr_' + 'A'.repeat(43);
const env = {
  ADMIN_ID:'synthetic-owner', READING_MCP_OWNER_READY:'1',
  MCP_KEYS:{prepare:sql=>({bind:(...args)=>({first:async()=>db.prepare(sql).get(...args)})})},
  ASSETS:{fetch:async()=>Response.json({articles:[{id:'fixture',title:'fixture title'}]})},
  DB:{get:async name=>name==='naesintg:sheets' ? ['fixture'] : null},
};
const paths = {'wb-reading':'/mcp', 'naesin-tg':'/naesin-tg/mcp'};
const rpc = (app, method, token, params={}) => worker.fetch(new Request(origin+paths[app], {
  method:'POST',headers:token?{Authorization:'Bearer '+token}:{},
  body:JSON.stringify({jsonrpc:'2.0', id:1, method, params}),
}),env);

test('reading accepts only owner read keys and returns the article total', async()=>{
  const missing=await rpc('wb-reading','tools/list');
  assert.equal(missing.status,401);
  assert.equal(missing.headers.get('WWW-Authenticate'),'Bearer realm="wb-reading"');
  assert.equal((await worker.fetch(new Request(origin+paths['wb-reading']),env)).status,405);
  db.exec(readFileSync(new URL('./mcp-keys.sql',import.meta.url),'utf8'));
  const {hashKey}=await import('../shared/read-mcp.mjs');
  db.prepare("INSERT INTO api_tokens(app,owner,name,token_hash,scope,expires_at) VALUES(?,?,?,?,'read',?)")
    .run('wb-reading','synthetic-owner','fixture',await hashKey(key),'2099-01-01T00:00:00.000Z');
  const listed=(await (await rpc('wb-reading','tools/list',key)).json()).result.tools;
  assert.deepEqual(listed.map(t=>t.name),['wb_reading_status']);
  assert.ok(listed[0].annotations.readOnlyHint);
  const r=(await (await rpc('wb-reading','tools/call',key,{name:'wb_reading_status'})).json()).result;
  assert.deepEqual(JSON.parse(r.content[0].text),{articles_count:1});

  const {keyCommand}=await import('./mcp-key.mjs');
  const issue={ownerId:'synthetic-owner',ownerReady:'1',execute:async sql=>db.prepare(sql).get()};
  const temporary=await keyCommand({...issue,args:['add-key','wb-reading','synthetic-owner','relay']});
  assert.match(temporary,/^rdr_[A-Za-z0-9_-]{43}$/);
  for (const [name,count] of [['relay',0],['fixture',1]]) {
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM api_tokens WHERE name=? AND last_used IS NOT NULL").get(name).total,count);
  }
  if (process.env.WB_MCP_TEST_RELAY) {
    const {checkRelay}=await import('./test-relay.mjs');
    await checkRelay({handle:request=>worker.fetch(request,env),url:origin+paths['wb-reading'],
      key:temporary,tool:'wb_reading_status',expected:{articles_count:1}});
  }
  await keyCommand({...issue,args:['revoke-key','wb-reading','synthetic-owner','relay']});
  assert.equal((await rpc('wb-reading','tools/list',temporary)).status,401);
  assert.deepEqual(db.prepare("SELECT kind FROM token_activity ORDER BY id").all().map(row=>row.kind),
    ['token_create','token_create','token_revoke']);
  assert.ok(db.prepare("SELECT last_used FROM api_tokens").get().last_used);
  assert.ok((await (await rpc('wb-reading','tools/call',key,{name:'set_student'})).json()).error);
});
