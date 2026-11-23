// 업무지시서 앱 표준 읽기 키 발급·폐기(총괄 명령). 키 원문은 표준출력 한 줄로만 내고 DB엔 해시만 둔다.
//   node sync/task-read-key.mjs --remote add-key <대표 계정> <이름> [일수=90] > ~/.config/wb-mcp/task-sheet-read.key
//   node sync/task-read-key.mjs --remote revoke-key <대표 계정> <이름>
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeKey, hashKey } from '../shared/read-mcp.mjs';
import { TASK_READ_PREFIX } from './task-standard-mcp.mjs';

const quote = value => "'" + value.replaceAll("'", "''") + "'";

export async function keyCommand({ args, execute, now = Date.now() }) {
  const [command, owner, name, expiry = '90'] = args;
  if (typeof owner !== 'string' || !/^[a-z0-9_.-]{1,64}$/.test(owner) ||
      typeof name !== 'string' || !name.trim() || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) {
    throw Error('invalid_owner_or_arguments');
  }
  const label = quote(name.trim());
  if (command === 'add-key' && args.length <= 4 && /^\d{1,3}$/.test(expiry) && Number(expiry) >= 1 && Number(expiry) <= 365) {
    const key = makeKey(TASK_READ_PREFIX);
    const expires = new Date(now + Number(expiry) * 86400000).toISOString();
    // 대표 계정이 맞고 처음 암호를 바꾼 뒤에만 행이 들어간다 — 아니면 RETURNING 이 비어 실패한다.
    await execute("INSERT INTO task_read_keys(app,owner,name,token_hash,scope,expires_at) SELECT 'task-sheet',login_id," +
      label + ',' + quote(await hashKey(key)) + ",'read'," + quote(expires) +
      ' FROM task_director_account WHERE id=1 AND must_change=0 AND login_id=' + quote(owner) + ' RETURNING id');
    return key;
  }
  if (command === 'revoke-key' && args.length === 3) {
    await execute("UPDATE task_read_keys SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner=" + quote(owner) +
      ' AND name=' + label + " AND scope='read' AND revoked_at IS NULL RETURNING id");
    return null;
  }
  throw Error('invalid_command');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [mode, ...args] = process.argv.slice(2);
  try {
    if (!['--local', '--remote'].includes(mode)) throw Error('configuration_required');
    const config = fileURLToPath(new URL('./wrangler.toml', import.meta.url));
    const key = await keyCommand({
      args,
      execute(sql) {
        const result = spawnSync('npx', ['wrangler@4', 'd1', 'execute', 'DB', mode, '--config', config, '--json', '--command', sql],
          { encoding: 'utf8', timeout: 60_000 });
        let parsed = null;
        try { parsed = JSON.parse(result.stdout); } catch {}
        if (result.status !== 0 || !parsed?.some?.(item => item.success && item.results?.length)) throw Error('storage_rejected');
      },
    });
    if (key) process.stdout.write(key + '\n');
    else process.stderr.write('읽기 키 폐기 완료\n');
  } catch {
    // 인자·SQL 원문을 되돌리지 않는다(키 해시·이름이 로그에 남지 않게).
    process.stderr.write('키 작업 실패. 대표 계정(처음 암호 변경 완료)·이름·일수(1~365)·wrangler 로그인을 확인하세요.\n');
    process.exitCode = 1;
  }
}
