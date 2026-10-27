import { haruStore } from './worker.mjs';
import { handleHaru, haruBodyLimit } from './haru-api.mjs';
import { readJsonBody } from './request-body.mjs';
import { safeEqual } from './admin-auth.mjs';
import { allowedStaffRoute } from './haru-staff-routes.mjs';
import atoms from '../haru/atoms.json';

const json = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!env.HARU_STAFF_GATEWAY_SECRET || !await safeEqual(req.headers.get('Authorization') || '', 'Bearer ' + env.HARU_STAFF_GATEWAY_SECRET)) return json(401, { error: '인증이 필요합니다.' });
    if (!allowedStaffRoute(req.method, url.pathname)) return json(403, { error: '대비 앱 관리자 API만 사용할 수 있습니다.' });
    try {
      const out = await handleHaru({
        path: url.pathname, method: req.method, who: { admin: true }, query: url.searchParams,
        getBody: () => readJsonBody(req, haruBodyLimit(url.pathname)), store: haruStore(env),
        atomsFallback: async () => atoms, randomToken: () => crypto.randomUUID().replace(/-/g, ''),
      });
      return json(out.status, out.body);
    } catch (e) {
      return json(e.status === 413 ? 413 : e instanceof SyntaxError ? 400 : 500, { error: e.status === 413 ? '요청이 너무 큽니다.' : '요청을 처리하지 못했습니다.' });
    }
  },
};
