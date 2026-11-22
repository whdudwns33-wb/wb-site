import assert from 'node:assert/strict';
import {test} from 'node:test';
import worker from './worker.js';

const key = 'standard-local-task-read-secret-00000000';
const url = 'https://wb-sync.whdudwns33.workers.dev/task/mcp';
const env = {
  TASK_MCP_READ_SECRET: key,
  DB: {prepare(sql) {
    assert.match(sql, /tasks/);
    return {bind() { return this; }, async all() {
      return {results:[{id:'one',data:JSON.stringify({id:'one',title:'private fixture', repeat:'daily', staffId:'fixture'})}]};
    }};
  }},
};

function rpc(method, token, params={}, origin) {
  const headers = token ? {Authorization: 'Bearer '+token} : {};
  if (origin) headers.Origin = origin;
  return worker.fetch(new Request(url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0', id:1, method,params})}),env);
}

test('task exposes aggregate MCP only with the existing read secret',async () => {
  const get=await worker.fetch(new Request(url),env);
  assert.equal(get.status,405);
  assert.equal(get.headers.get('Allow'),'POST');
  const missing=await rpc('tools/list');
  assert.equal(missing.status,401);
  assert.equal(missing.headers.get('WWW-Authenticate'),'Bearer realm="task-sheet"');
  assert.equal((await rpc('tools/list', 'wrong')).status,401);
  assert.equal((await rpc('tools/list', key, {}, 'https://invalid.example')).status,403);
  const tools=(await (await rpc('tools/list',key)).json()).result.tools;
  assert.deepEqual(tools.map(t=>t.name),['task_sheet_status']);
  assert.equal(tools[0].annotations.readOnlyHint,true);
  const out=await (await rpc('tools/call',key,{name:'task_sheet_status'})).json();
  await rpc('tools/call', key, {name:'task_sheet_status',arguments:{undeclared:true}}).then(async r => { assert.deepEqual([r.status, (await r.json()).error?.code], [200, -32602]); });
  assert.deepEqual(JSON.parse(out.result.content[0].text),{work_orders_today:1});
  assert.ok((await (await rpc('tools/call', key, {name:'create_task'})).json()).error);
  const oversize=await worker.fetch(new Request(url,{method:'POST',body:' '.repeat(1024*1024+1)}),env);
  assert.equal(oversize.status,413);
});

test('PWA routes serve manifest and install service worker retains notification handlers', async () => {
  const {readFileSync} = await import('node:fs');
  const {runInNewContext} = await import('node:vm');
  const assets = {ASSETS:{fetch(request) {
    const path = new URL(request.url).pathname;
    return new Response(readFileSync(new URL('..'+path,import.meta.url)));
  }}};
  assert.equal((await worker.fetch(new Request('https://wb-sync.whdudwns33.workers.dev/task/manifest.webmanifest'), assets)).headers.get('Content-Type'),'application/manifest+json');
  const sw = readFileSync(new URL('../task/sw.js',import.meta.url),'utf8');
  const events = {};
  const ctx = {
    self:{location:{pathname:'/task/sw.js'},addEventListener(name,fn){events[name]=fn;}},
    URL, fetch:async()=>{throw Error('offline');}, caches:{match:async path=>path},
    importScripts(){runInNewContext(readFileSync(new URL('../task/request-sw.js',import.meta.url),'utf8'),ctx);},
  };
  runInNewContext(sw,ctx);
  assert.ok(events.push && events.notificationclick);
  const request = path => {
    let response;
    events.fetch({request:{url:'https://wb-sync.whdudwns33.workers.dev'+path,method:'GET',mode:'navigate'},
      respondWith: promise=>{response=promise;}});
    return response;
  };
  assert.equal(request('/task/mcp'),undefined);
  assert.equal(request('/api/tower'),undefined);
  assert.equal(await request('/task/'),'/task/offline/');
});

if (process.env.WB_MCP_TEST_RELAY) test('task stdio relay completes all four messages', async () => {
  const {createServer} = await import('node:http');
  const {once} = await import('node:events');
  const {mkdtemp, writeFile, rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {spawn} = await import('node:child_process');
  const directory = await mkdtemp(join(tmpdir(),'wb-task-mcp-'));
  const file = join(directory,'read.key');
  const server = createServer(async (req,res) => {
    const chunks=[];
    for await (const chunk of req) chunks.push(chunk);
    const answer=await worker.fetch(new Request(url,{method:'POST',headers:req.headers,body:Buffer.concat(chunks)}),env);
    res.writeHead(answer.status,Object.fromEntries(answer.headers));
    res.end(Buffer.from(await answer.arrayBuffer()));
  });
  try {
    await writeFile(file,key,{mode:0o600,flag:'wx'});
    server.listen(0,'127.0.0.1');
    await once(server,'listening');
    const relay=spawn('python3',['-IB',process.env.WB_MCP_TEST_RELAY,`http://127.0.0.1:${server.address().port}/task/mcp`,file],{timeout:15_000});
    let output='';
    relay.stdout.setEncoding('utf8').on('data',chunk=>{output+=chunk;});
    const messages=[
      {id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}},
      {method:'notifications/initialized'}, {id:2,method:'tools/list'},
      {id:3,method:'tools/call',params:{name:'task_sheet_status'}},
    ];
    relay.stdin.end(messages.map(msg=>JSON.stringify({jsonrpc:'2.0',...msg})).join('\n')+'\n');
    const [code]=await once(relay,'close');
    assert.equal(code,0);
    const replies=output.trim().split('\n').map(JSON.parse);
    assert.deepEqual(replies.map(reply=>reply.id),[1,2,3]);
    assert.deepEqual(JSON.parse(replies[2].result.content[0].text),{work_orders_today:1});
  } finally {
    server.close();
    await rm(directory,{force:true,recursive:true});
  }
});
