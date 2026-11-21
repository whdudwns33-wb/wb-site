import { MAX_BODY_BYTES, methodNotAllowed } from './read-mcp.mjs';

export async function workerReadMcp(request, handle) {
  const send = ({status, headers, body}) => new Response(body, {status, headers});
  const error = (status, code) => Response.json({error: code}, {
    status, headers: {'Cache-Control': 'no-store'},
  });
  if (request.method !== 'POST') return send(methodNotAllowed());
  if (Number(request.headers.get('Content-Length')) > MAX_BODY_BYTES) return error(413, 'body_too_large');

  const deadline = performance.now() + 30_000;
  const reader = request.body?.getReader();
  const chunks = [];
  let length = 0;
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void reader?.cancel().catch(() => {});
  }, 30_000);
  try {
    if (reader) {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_BODY_BYTES) {
          void reader.cancel().catch(() => {});
          return error(413, 'body_too_large');
        }
        chunks.push(value);
      }
    }
  } catch {
    return expired ? error(504, 'timeout') : error(400, 'invalid_request');
  } finally {
    clearTimeout(timer);
  }
  if (expired || performance.now() >= deadline) return error(504, 'timeout');
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return send(await handle({method: request.method, headers: request.headers, body, deadline}));
}
