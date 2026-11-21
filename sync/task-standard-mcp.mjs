import { createMcp, hashKey } from '../shared/read-mcp.mjs';
import { workerReadMcp } from '../shared/worker-read-mcp.mjs';
import { countWorkOrdersToday } from './task-export.js';

const handlers = new WeakMap();

export function taskStandardMcp(request, env) {
  let handle = handlers.get(env);
  if (!handle) {
    handle = createMcp({
      name: 'task-sheet',
      origins: ['https://wb-sync.whdudwns33.workers.dev'],
      async authenticate(header) {
        const key = header.slice(7);
        const expected = env.TASK_MCP_READ_SECRET;
        if (typeof expected !== 'string' || expected.length < 32 || key.length > 256 ||
            expected === env.TASK_ADMIN_SECRET || expected === env.TASK_TOWER_READ_SECRET) return null;
        return await hashKey(key) === await hashKey(expected) ? {user: 'task-export', scope: 'read'} : null;
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
