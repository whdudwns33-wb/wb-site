import { createMcp, hashKey } from '../shared/read-mcp.mjs';
import { workerReadMcp } from '../shared/worker-read-mcp.mjs';
import { countWorkOrdersToday } from './task-export.js';

export const TASK_READ_PREFIX = 'tsk_';
const handlers = new WeakMap();

export function taskStandardMcp(request, env) {
  let handle = handlers.get(env);
  if (!handle) {
    handle = createMcp({
      name: 'task-sheet',
      origins: ['https://wb-sync.whdudwns33.workers.dev'],
      async authenticate(header) {
        const key = header.slice(7);
        // 기존 공용 비밀값도 tsk_로 시작할 수 있으므로 먼저 비교한다.
        const expected = env.TASK_MCP_READ_SECRET;
        if (typeof expected === 'string' && expected.length >= 32 && key.length <= 256 &&
            expected !== env.TASK_ADMIN_SECRET && expected !== env.TASK_TOWER_READ_SECRET &&
            await hashKey(key) === await hashKey(expected)) {
          return {user: 'task-export', scope: 'read'};
        }
        if (!key.startsWith(TASK_READ_PREFIX) || key.length !== TASK_READ_PREFIX.length + 43) return null;
        const now = new Date().toISOString();
        // 대표 계정이 처음 암호를 바꾸지 않았으면 개별 키를 막는다(앱 표준).
        const row = await env.DB.prepare(
          "UPDATE task_read_keys SET last_used=? WHERE token_hash=? AND scope='read' AND revoked_at IS NULL AND expires_at>?" +
          ' AND owner=(SELECT login_id FROM task_director_account WHERE id=1 AND must_change=0) RETURNING owner',
        ).bind(now, await hashKey(key), now).first().catch(() => null);
        return row ? {user: row.owner, scope: 'read'} : null;
      },
      tools: [{
        name: 'task_sheet_status',
        description: '오늘 일반 업무지시 건수',
        scope: 'read',
        inputSchema: {type: 'object', properties: {}, additionalProperties: false},
        run: async args => Object.keys(args).length ? {status: 'invalid_arguments'} :
          {work_orders_today: await countWorkOrdersToday(env)},
      }],
    });
    handlers.set(env, handle);
  }
  return workerReadMcp(request, handle);
}
