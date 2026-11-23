import { programdeskStatus } from './desk-api.mjs';
import { apiKey, authorizeMcpRead } from './mcp-keys.mjs';
import { createMcp, MAX_BODY_BYTES, methodNotAllowed } from './read-mcp.mjs';

const ORIGIN = 'https://wb-desk.whdudwns33.workers.dev';
const TIMEOUT_MS = 30_000;
const failure = (status, error, headers = {}) =>
  Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

async function readBody(request, deadline) {
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) return 413;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  let timer;
  const timedOut = new Promise(resolve => {
    timer = setTimeout(() => resolve(504), Math.max(0, deadline - performance.now()));
  });
  const reading = async () => {
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) return 413;
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    } catch {
      return 400;
    }
  };
  try {
    return await Promise.race([timedOut, reading()]);
  } finally {
    clearTimeout(timer);
    // 요청 스트림을 취소하면 로컬 프록시가 413/504 응답 전에 연결을 닫을 수 있다.
    reader.releaseLock();
  }
}

export async function handleMcp(request, env) {
  if (request.method !== 'POST') {
    const response = methodNotAllowed();
    return new Response(request.method === 'HEAD' ? null : response.body, response);
  }
  const deadline = performance.now() + TIMEOUT_MS;
  const hasKeyShape = apiKey(request.headers.get('authorization'));
  const body = hasKeyShape ? await readBody(request, deadline) : '';
  if (body === 413) return failure(413, 'body_too_large');
  if (body === 400) return failure(400, 'invalid_request');
  const remaining = deadline - performance.now();
  if (body === 504 || remaining <= 0) return failure(504, 'timeout');
  let limited = false;
  const dispatch = createMcp({
    name: 'programdesk',
    origins: [ORIGIN],
    timeoutSeconds: remaining / 1000,
    async authenticate(header) {
      const auth = await authorizeMcpRead(env.DB, header);
      limited = auth?.limited === true;
      return limited ? null : auth;
    },
    tools: [{
      name: 'programdesk_status',
      description: '한국 시간 기준 오늘 기한, 지연 미완료, 오늘 완료 카드 건수',
      scope: 'read',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: (_, { user }) => programdeskStatus(env, user)
    }]
  });
  const response = await dispatch({ method: request.method, headers: request.headers, body });
  if (limited && response.status === 401) return failure(429, 'rate_limit', { 'Retry-After': '60' });
  return new Response(response.body, response);
}
