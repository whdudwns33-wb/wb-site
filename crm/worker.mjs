// WB 세일즈데스크 워커 진입점. /api/*와 /mcp를 처리한다.
// scheduled: 자동 모드이면 양방향 동기화, 꺼져 있으면 원장이 승인한 반영 큐만 보낸다(크론은 wrangler.toml [triggers]). 토큰이 없으면 조용히 끝난다.
import { salesdeskMcp } from './salesdesk-mcp.mjs';
import { handleApi, runHubspotSync } from './crm-api.mjs';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/mcp') return salesdeskMcp(request, env);
    // Workers Assets의 .html 정규화 리다이렉트 없이 PWA 설치 경로를 제공한다.
    if (url.pathname === '/offline.html') {
      url.pathname = '/offline';
      return env.ASSETS.fetch(new Request(url, request));
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return handleApi(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    if (!env.HUBSPOT_ACCESS_TOKEN) return;
    ctx.waitUntil(runHubspotSync(env).catch(() => {}));
  }
};
