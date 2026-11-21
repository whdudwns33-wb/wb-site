import { spawnSync } from 'node:child_process';
import { makeKey, hashKey } from '../shared/read-mcp.mjs';

const prefixes = new Map([['wb-reading','rdr_'],['naesin-tg','tgr_']]);
const quote = value => "'" + value.replaceAll("'","''") + "'";

export async function keyCommand({args, ownerId, ownerReady, execute}) {
  const [command, app, owner, name, expiry='90'] = args;
  if (!prefixes.has(app) || !ownerId || owner!==ownerId || ownerReady!=='1' ||
      typeof name!=='string' || !name.trim() || name.length>80 || /[\x00-\x1f\x7f]/.test(name)) {
    throw Error('invalid_owner_or_arguments');
  }
  const label=quote(name.trim());
  const subject=[app,owner].map(quote);
  if (command==='add-key' && args.length<=5 && /^\d{1,3}$/.test(expiry) && Number(expiry)>=1 && Number(expiry)<=365) {
    const key=makeKey(prefixes.get(app));
    const expires=new Date(Date.now()+Number(expiry)*86400000).toISOString();
    const values=[...subject,label,quote(await hashKey(key)),"'read'",quote(expires)];
    await execute("INSERT INTO api_tokens(app,owner,name,token_hash,scope,expires_at) VALUES("+values.join(',')+") RETURNING id");
    return key;
  }
  if (command==='revoke-key' && args.length===4) {
    await execute("UPDATE api_tokens SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE app="+subject[0]+
      " AND owner="+subject[1]+" AND name="+label+" AND scope='read' AND revoked_at IS NULL RETURNING id");
    return null;
  }
  throw Error('invalid_command');
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  const [mode,...args]=process.argv.slice(2);
  try {
    if (!['--local','--remote'].includes(mode) || !process.env.READING_MCP_WRANGLER_CONFIG) throw Error('configuration_required');
    const key=await keyCommand({
      args, ownerId:process.env.ADMIN_ID, ownerReady:process.env.READING_MCP_OWNER_READY,
      execute(sql) {
        const result=spawnSync('wrangler',['d1','execute','MCP_KEYS',mode,'--config',
          process.env.READING_MCP_WRANGLER_CONFIG,'--json','--command',sql],{encoding:'utf8',timeout:30_000});
        if (result.status!==0 || !JSON.parse(result.stdout)?.some(item=>item.success && item.results?.length)) {
          throw Error('storage_rejected');
        }
      },
    });
    if (key) process.stdout.write(key+'\n');
    else process.stderr.write('읽기 키 폐기 완료\n');
  } catch {
    process.stderr.write('키 작업 실패. 설정과 명령 인자를 확인하세요.\n');
    process.exitCode=1;
  }
}
