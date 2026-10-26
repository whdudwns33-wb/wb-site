#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
export async function forwardDirectorMcp(message, env=process.env, fetchImpl=fetch) {
  const token=env.WB_TASK_ADMIN_TOKEN || '';
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('WB_TASK_ADMIN_TOKEN에 설정 화면에서 발급한 API 키를 넣어 주세요');
  const response=await fetchImpl('https://wb-sync.whdudwns33.workers.dev/task-mcp',{
    method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'},
    body:JSON.stringify(message),signal:AbortSignal.timeout(60000)
  });
  if (response.status===202 || response.status===204) return null;
  const payload=await response.json();
  if (!response.ok) throw new Error(payload.error || '업무지시서 MCP 연결에 실패했습니다');
  return payload;
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  for await (const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
    if (!line.trim()) continue;
    let message;
    try { message=JSON.parse(line); }
    catch { process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}})+'\n'); continue; }
    try { const result=await forwardDirectorMcp(message); if(result) process.stdout.write(JSON.stringify(result)+'\n'); }
    catch(error) { if(message && Object.hasOwn(message,'id')) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32000,message:error.message}})+'\n'); }
  }
}
