// WB 세일즈데스크 워커 진입점. /api/* 만 코드가 받고 나머지는 전부 정적 자산(dist)이다 — desk/worker.mjs 와 같은 구조.
// scheduled: 자동 모드이면 양방향 동기화, 꺼져 있으면 원장이 승인한 반영 큐만 보낸다(크론은 wrangler.toml [triggers]). 토큰이 없으면 조용히 끝난다.
import { handleApi, runHubspotSync } from './crm-api.mjs';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return handleApi(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    if (!env.HUBSPOT_ACCESS_TOKEN) return;
    ctx.waitUntil(runHubspotSync(env).catch(() => {}));
  }
};
