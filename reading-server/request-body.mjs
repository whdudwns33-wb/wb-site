'use strict';
/* Content-Length 없는 요청도 JSON 파싱 전에 실제 바이트로 제한한다. */
export async function readJsonBody(request, limit) {
  const reader = request.body?.getReader();
  const chunks = []; let size = 0;
  if (reader) while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error('body limit'), { status: 413 });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
