import assert from 'node:assert/strict';
import { forwardDirectorMcp } from './task-director-mcp.mjs';
const token='a'.repeat(64), message={jsonrpc:'2.0',id:1,method:'tools/list'};
assert.deepEqual(await forwardDirectorMcp(message,{WB_TASK_ADMIN_TOKEN:token},async(url,options)=>{
  assert.equal(url,'https://wb-sync.whdudwns33.workers.dev/task-mcp');
  assert.equal(options.headers.Authorization,'Bearer '+token);
  assert.deepEqual(JSON.parse(options.body),message);
  return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{tools:[]}}));
}),{jsonrpc:'2.0',id:1,result:{tools:[]}});
await assert.rejects(forwardDirectorMcp(message,{}),/WB_TASK_ADMIN_TOKEN/);
assert.equal(await forwardDirectorMcp({jsonrpc:'2.0',method:'notifications/initialized'},{WB_TASK_ADMIN_TOKEN:token},async()=>new Response(null,{status:202})),null);
console.log('task director MCP stdio: passed');
