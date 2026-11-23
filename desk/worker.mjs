// /api/* 와 /mcp 는 워커로, 화면과 설치 자산은 ASSETS 바인딩으로 보낸다.
import { handleApi } from './desk-api.mjs';
import { handleMcp } from './desk-mcp.mjs';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/mcp') return handleMcp(request, env);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return handleApi(request, env, ctx);
    // 기본 HTML 경로 정규화는 유지하고 SW 프리캐시 URL만 직접 200으로 제공한다.
    if (url.pathname === '/offline.html') {
      url.pathname = '/offline';
      return env.ASSETS.fetch(new Request(url, request));
    }
    return env.ASSETS.fetch(request);
  }
};
