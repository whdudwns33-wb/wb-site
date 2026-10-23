import assert from 'node:assert/strict';
import test from 'node:test';

import { handleMcpMessage } from './task-mcp-server.mjs';

const TOKEN = 'test-only-mcp-token-not-a-real-credential-value';

test('initialize와 ping은 요청 id를 보존한다', async () => {
  const initialized = await handleMcpMessage({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18' }
  });
  assert.equal(initialized.id, 0);
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  assert.equal(initialized.result.serverInfo.name, 'wb-task');
  assert.deepEqual(initialized.result.capabilities, { tools: { listChanged: false } });

  const future = await handleMcpMessage({
    jsonrpc: '2.0', id: 'future', method: 'initialize', params: { protocolVersion: '2099-01-01' }
  });
  assert.equal(future.result.protocolVersion, '2025-06-18');

  const ping = await handleMcpMessage({ jsonrpc: '2.0', id: 'ping-a', method: 'ping' });
  assert.equal(ping.id, 'ping-a');
  assert.deepEqual(ping.result, {});
});

test('읽기 전용 업무지시서 도구 하나만 노출한다', async () => {
  const listed = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(listed.result.tools.length, 1);
  const tool = listed.result.tools[0];
  assert.equal(tool.name, 'list_work_orders');
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.equal(tool.annotations.idempotentHint, true);
  assert.equal(tool.annotations.openWorldHint, false);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.doesNotMatch(JSON.stringify(tool), /write|delete|update/i);
});

test('전용 환경변수가 없으면 네트워크 요청 없이 안전하게 실패한다', async () => {
  let called = false;
  const result = await handleMcpMessage({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'list_work_orders', arguments: {} }
  }, {
    env: {},
    fetchImpl: async () => { called = true; throw new Error('should not call'); }
  });
  assert.equal(called, false);
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /WB_TASK_MCP_READ_TOKEN/);
});

test('도구 호출은 고정된 task 읽기 API에만 Bearer 요청을 보낸다', async () => {
  let captured;
  const result = await handleMcpMessage({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: {
      name: 'list_work_orders',
      arguments: { date: '2026-10-23', staffId: 'staff-a', cursor: 'v1.1792713600000.task-a', limit: 25 }
    }
  }, {
    env: { WB_TASK_MCP_READ_TOKEN: TOKEN },
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({
        ok: true,
        data: { schema: 'wb-task-transfer-v1', app: 'task', exportedAt: '2026-10-23T00:00:00.000Z', items: [] },
        page: { cursor: 'v1.1792713600000.task-a', limit: 25, total: 0, nextCursor: null }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  });

  assert.equal(captured.url, 'https://wb-sync.whdudwns33.workers.dev/task-export');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers.Authorization, 'Bearer ' + TOKEN);
  assert.deepEqual(JSON.parse(captured.options.body), {
    app: 'task', action: 'list_work_orders', date: '2026-10-23', staffId: 'staff-a', cursor: 'v1.1792713600000.task-a', limit: 25
  });
  assert.equal(result.result.isError, false);
  assert.equal(result.result.structuredContent.data.app, 'task');
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test('호출 인수로 app과 action을 바꿀 수 없다', async () => {
  let sentBody;
  await handleMcpMessage({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'list_work_orders', arguments: { app: 'consult', action: 'write' } }
  }, {
    env: { WB_TASK_MCP_READ_TOKEN: TOKEN },
    fetchImpl: async (_url, options) => {
      sentBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ ok: true, data: { items: [] }, page: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  });
  assert.equal(sentBody.app, 'task');
  assert.equal(sentBody.action, 'list_work_orders');
});

test('알 수 없는 도구와 메서드는 명시적으로 거절한다', async () => {
  const tool = await handleMcpMessage({
    jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'write_work_orders', arguments: {} }
  });
  assert.equal(tool.error.code, -32602);

  const method = await handleMcpMessage({ jsonrpc: '2.0', id: 6, method: 'resources/list' });
  assert.equal(method.error.code, -32601);
  assert.equal(method.id, 6);
});

test('초기화 알림에는 응답하지 않는다', async () => {
  const response = await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(response, null);

  const unknown = await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/progress', params: {} });
  assert.equal(unknown, null);
});
