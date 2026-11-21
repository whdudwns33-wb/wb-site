import assert from 'node:assert/strict';

export async function checkRelay({handle, url, key, tool, expected}) {
  const {createServer} = await import('node:http');
  const {once} = await import('node:events');
  const {mkdtemp, writeFile, rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {spawn} = await import('node:child_process');
  const directory = await mkdtemp(join(tmpdir(),'wb-mcp-relay-'));
  const file = join(directory,'read.key');
  const server = createServer(async (req,res) => {
    const chunks=[];
    for await (const chunk of req) chunks.push(chunk);
    const answer=await handle(new Request(url,{method:'POST',headers:req.headers,body:Buffer.concat(chunks)}));
    res.writeHead(answer.status,Object.fromEntries(answer.headers));
    res.end(Buffer.from(await answer.arrayBuffer()));
  });
  try {
    await writeFile(file,key,{mode:0o600,flag:'wx'});
    server.listen(0,'127.0.0.1');
    await once(server,'listening');
    const relay=spawn('python3',['-IB',process.env.WB_MCP_TEST_RELAY,`http://127.0.0.1:${server.address().port}/mcp`,file],{timeout:15_000});
    let output='';
    relay.stdout.setEncoding('utf8').on('data',chunk=>{output+=chunk;});
    const messages=[
      {id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}},
      {method:'notifications/initialized'}, {id:2,method:'tools/list'},
      {id:3,method:'tools/call',params:{name:tool}},
    ];
    relay.stdin.end(messages.map(msg=>JSON.stringify({jsonrpc:'2.0',...msg})).join('\n')+'\n');
    const [code]=await once(relay,'close');
    assert.equal(code,0);
    const replies=output.trim().split('\n').map(JSON.parse);
    assert.deepEqual(replies.map(reply=>reply.id),[1,2,3]);
    assert.deepEqual(JSON.parse(replies[2].result.content[0].text),expected);
  } finally {
    server.close();
    await rm(directory,{force:true,recursive:true});
  }
}
