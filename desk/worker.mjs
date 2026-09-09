// WB 프로그램데스크 워커 진입점. /api/* 만 코드가 받고 나머지는 전부 정적 자산(dist)이다 —
// 자산은 wrangler [assets] 가 워커보다 먼저 서빙하므로 여기 오는 비-API 요청은 run_worker_first 밖의
// 예외(없는 경로 등)뿐이고, 그것도 자산 바인딩의 404/SPA 규칙에 맡긴다.
import { handleApi } from './desk-api.mjs';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return handleApi(request, env, ctx);
    return env.ASSETS.fetch(request);
  }
};
