/** 학생 앱 전용 Worker — 정적 자산과 학생 세션의 public action만 제공한다. */
import { handleStudentPortal } from './student-portal.js';

const PUBLIC_ACTIONS = new Set(['exchange', 'view', 'logout', 'self_check_set']);

function headers(origin) {
  return {
    'Content-Type': 'application/json;charset=utf-8',
    'Access-Control-Allow-Origin': origin || 'null',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  };
}

function json(payload, status, origin) {
  return new Response(JSON.stringify(payload), { status: status || 200, headers: headers(origin) });
}

function configuredOrigin(env) {
  try {
    const url = new URL(String(env.WB_STUDENT_PORTAL_BASE_URL || ''));
    return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' &&
      !url.search && !url.hash ? url.origin : '';
  } catch (error) {
    return '';
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const expectedOrigin = configuredOrigin(env);
    const sameOrigin = !!expectedOrigin && url.origin === expectedOrigin && origin === expectedOrigin;

    if (url.pathname === '/health' && request.method === 'GET') {
      return json({ ok: true, now: Date.now() }, 200, url.origin);
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      return env.ASSETS ? env.ASSETS.fetch(request) : json({ ok: false, error: '학생 앱 자산이 없습니다' }, 404, url.origin);
    }
    if (url.pathname !== '/student-portal') {
      return json({ ok: false, error: '요청 경로를 찾을 수 없습니다' }, 404, sameOrigin ? origin : 'null');
    }
    if (!sameOrigin) {
      return json({ ok: false, error: '학생 앱과 같은 출처에서만 사용할 수 있습니다' }, 403, 'null');
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: headers(origin) });
    }
    if (request.method !== 'POST') return json({ ok: false, error: 'POST만 허용합니다' }, 405, origin);

    let body;
    try { body = await request.json(); }
    catch (error) { return json({ ok: false, error: '본문을 읽을 수 없습니다' }, 400, origin); }
    if (!body || body.app !== 'task' || !PUBLIC_ACTIONS.has(String(body.action || ''))) {
      return json({ ok: false, error: '허용되지 않은 학생 앱 작업입니다' }, 403, origin);
    }
    try {
      return await handleStudentPortal(env, 'task', body, origin, null, json, request);
    } catch (error) {
      return json({ ok: false, error: '학생 정보를 불러오지 못했습니다' }, 500, origin);
    }
  }
};
