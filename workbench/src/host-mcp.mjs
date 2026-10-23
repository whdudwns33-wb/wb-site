import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {pathToFileURL} from 'node:url';

export function createWorkbenchMcp(service) {
  const server = new McpServer({name: 'wb-workbench-mcp-server', version: '1.0.0'});
  const register = (name, description, schema, action, readOnly = true) => server.registerTool(name, {
    title: name, description, inputSchema: schema,
    annotations: {readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: false},
  }, async args => {
    try { const output = await action(args); return {content: [{type: 'text', text: JSON.stringify(output)}], structuredContent: output}; }
    catch (error) { return {isError: true, content: [{type: 'text', text: error.status ? error.message : '워크벤치 요청을 처리하지 못했습니다.'}]}; }
  });
  register('workbench_get_summary', '공용 상담 자료의 버전, 학생·보고서·정시 지원안 건수를 확인합니다.', {}, () => service.summary());
  register('workbench_list_students', '학생을 이름·학교·학년으로 검색합니다. 학생 개인정보는 권한 있는 상담 목적으로만 조회하세요.', {
    query: z.string().max(100).default(''), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(20),
  }, args => service.listStudents(args));
  register('workbench_get_student', '학생의 실제 성적, 수시·정시 지원안과 변경 이력, 통합 보고서를 구분해 조회합니다. 합격을 보장하지 않습니다.', {
    student_id: z.string().min(1).max(100), section: z.enum(['profile', 'scores', 'plans', 'reports', 'all']).default('profile'),
  }, args => service.student(args.student_id, args.section));
  register('workbench_save_student', '명시적으로 수정한 학생 전체 기록을 저장합니다. 먼저 all로 조회한 자료의 미수정 필드를 유지하세요. 현재 버전이 다르면 저장을 거절하고 이전 기록은 보존합니다.', {
    student_id: z.string().min(1).max(100), expected_revision: z.number().int().min(1), data: z.record(z.string(), z.unknown()),
  }, args => service.saveStudent(args.student_id, args.data, args.expected_revision), false);
  return server;
}

export function remoteService(url, apiToken) {
  const parsed = new URL(url);
  if (!apiToken || parsed.username || parsed.password || !['workbench.wbcowork.com', 'localhost', '127.0.0.1'].includes(parsed.hostname) || (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname))) throw Error('An HTTPS workbench URL and API token are required.');
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(new URL(path, parsed), {method, headers: {Authorization: 'Bearer ' + apiToken, 'Content-Type': 'application/json'}, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(30000)});
    const data = await response.json();
    if (!response.ok) { const error = Error(data.error || '워크벤치 API 요청 실패'); error.status = response.status; throw error; }
    return data;
  };
  return {
    summary: () => request('/api/summary'),
    listStudents: args => request('/api/students?' + new URLSearchParams(args)),
    student: (id, section) => request('/api/students/' + encodeURIComponent(id) + '?section=' + section),
    saveStudent: (id, data, revision) => request('/api/students/' + encodeURIComponent(id), 'PUT', {data, revision}),
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const server = createWorkbenchMcp(remoteService(process.env.WB_WORKBENCH_URL || 'https://workbench.wbcowork.com', process.env.WB_WORKBENCH_API_TOKEN));
    await server.connect(new StdioServerTransport());
  } catch { console.error('Set WB_WORKBENCH_API_TOKEN before starting the workbench MCP client.'); process.exitCode = 1; }
}
