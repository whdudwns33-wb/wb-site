import { createMcp, hashKey } from '../shared/read-mcp.mjs';
import { workerReadMcp } from '../shared/worker-read-mcp.mjs';

const handlers = new WeakMap();

export function serveReadingMcp(request, env, spec) {
  let byApp = handlers.get(env);
  if (!byApp) {
    byApp = new Map();
    handlers.set(env, byApp);
  }
  let handler = byApp.get(spec.app);
  if (!handler) {
    handler = createMcp({
      name:spec.app,
      origins:['https://wb-reading.whdudwns33.workers.dev'],
      async authenticate(header) {
        const key=header.slice(7);
        if (env.READING_MCP_OWNER_READY !== '1' || !env.ADMIN_ID || !env.MCP_KEYS ||
            !key.startsWith(spec.prefix) || key.length !== spec.prefix.length+43) return null;
        const now=new Date().toISOString();
        const row=await env.MCP_KEYS.prepare(
          "UPDATE api_tokens SET last_used=? WHERE app=? AND owner=? AND token_hash=? AND scope='read'" +
          " AND revoked_at IS NULL AND expires_at>? RETURNING owner",
        ).bind(now,spec.app,env.ADMIN_ID,await hashKey(key),now).first();
        return row ? {user:row.owner,scope:'read'} : null;
      },
      tools:[{
        name:spec.tool, description:spec.description, scope:'read',
        inputSchema:{type:'object',properties:{},additionalProperties:false},
        run:args=>Object.keys(args).length ? {status:'invalid_arguments'} : spec.summary(env),
      }],
    });
    byApp.set(spec.app,handler);
  }
  return workerReadMcp(request,handler);
}
