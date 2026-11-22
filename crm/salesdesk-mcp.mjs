import { createMcp } from '../shared/read-mcp.mjs';
import { workerReadMcp } from '../shared/worker-read-mcp.mjs';
import { authorizeMcpRead } from './mcp-keys.mjs';

export const MCP_PREFIX = 'sls_';
export const MCP_OWNER = 'admin';

export async function salesdeskMcp(request, env) {
  let limited = false;
  const result = await workerReadMcp(request, createMcp({
    name: 'salesdesk',
    origins: [new URL(request.url).origin],
    async authenticate(header) {
      const key = await authorizeMcpRead(env.DB, header, MCP_OWNER, MCP_PREFIX);
      limited = key?.limited === true;
      return key;
    },
    tools: [{
      name: 'salesdesk_status',
      description: '영업 고객관리의 등록 고객 건수',
      scope: 'read',
      inputSchema: {type: 'object', properties: {}, additionalProperties: false},
      async run() {
        // /api/docs의 leads와 같은 컬렉션에서 현재 문서 수만 읽는다.
        const row = await env.DB.prepare(
          "SELECT COUNT(*) AS leads_count FROM crm_documents WHERE collection='leads' AND deleted=0"
        ).first();
        return {leads_count: Number(row.leads_count)};
      },
    }],
  }));
  return limited ? Response.json({error: 'rate_limit'}, {
    status: 429, headers: {'Cache-Control': 'no-store', 'Retry-After': '60'},
  }) : result;
}
