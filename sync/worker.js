import curriculumWorker from './curriculum-fix.js';
import { guardWrappedStaffWorkRequest } from './worker-core.js';
import { handleScheduledBookOrders, handleScheduledBookOrderStatusRefresh } from './book-order-send.js';
import { handleScheduledParentFeedbackStatusRefresh } from './parent-feedback-send.js';
import { handleScheduledSessionPackAttendance } from './session-pack.js';
import { handleScheduledTuitionAlerts } from './tuition-alert.js';
import { applyTestStaffNextDayAttendance } from './test-staff-attendance.js';
import { dispatchTaskPush } from './task-push.js';
import { handleTaskDirector } from './task-director.js';

const BOOK_ORDER_CRON = '0 11 * * *';
const BOOK_ORDER_STATUS_CRON = '*/10 * * * *';
const SESSION_PACK_ATTENDANCE_CRON = '50 14 * * *';

export function cleanupCurriculum(text) {
  const kept = String(text || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^\d+강\s+선배\s*추천(?:\s|$)/.test(line));

  return kept.map((line, index) => {
    const body = line.replace(/^\d+강\s+/, '');
    return (index + 1) + '강 ' + body;
  }).join('\n');
}

export default {
  async fetch(request, env, ctx) {
    const director = await handleTaskDirector(request, env, forwarded => curriculumWorker.fetch(forwarded, env, ctx));
    if (director) return director;
    const url = new URL(request.url);
    if (['GET','HEAD'].includes(request.method) && url.pathname.startsWith('/task/') && env.ASSETS) {
      const asset = await env.ASSETS.fetch(request);
      const headers = new Headers(asset.headers);
      // 보호자 전용 CSP는 외부 JS를 막으므로 업무 화면에만 실행 자산·글꼴을 허용한다.
      headers.set('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' https://wb-sync.whdudwns33.workers.dev; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      headers.set('Cache-Control','no-store');
      headers.set('X-Robots-Tag','noindex, nofollow, noarchive');
      return new Response(asset.body,{status:asset.status,headers});
    }
    if (url.pathname === '/search' || url.pathname === '/curriculum') {
      const denied = await guardWrappedStaffWorkRequest(request, env);
      if (denied) return denied;
    }
    const response = await curriculumWorker.fetch(request, env, ctx);
    if (url.pathname !== '/curriculum' || request.method !== 'POST') return response;

    try {
      const data = await response.clone().json();
      if (!data || data.ok !== true || typeof data.text !== 'string' || !data.text) return response;
      data.text = cleanupCurriculum(data.text);
      return new Response(JSON.stringify(data), { status: response.status, headers: response.headers });
    } catch (error) {
      return response;
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(dispatchTaskPush(env, controller.scheduledTime).catch(() => {}));
    if (controller.cron === BOOK_ORDER_STATUS_CRON) {
      ctx.waitUntil(Promise.all([
        handleScheduledBookOrderStatusRefresh(env, controller.scheduledTime),
        handleScheduledParentFeedbackStatusRefresh(env, controller.scheduledTime)
      ]));
      ctx.waitUntil(applyTestStaffNextDayAttendance(env, 'task', controller.scheduledTime));
      return;
    }
    if (controller.cron === SESSION_PACK_ATTENDANCE_CRON) {
      ctx.waitUntil(Promise.all([
        handleScheduledSessionPackAttendance(env, controller.scheduledTime),
        handleScheduledTuitionAlerts(env, controller.scheduledTime)
      ]));
      return;
    }
    if (controller.cron === BOOK_ORDER_CRON) {
      ctx.waitUntil(handleScheduledBookOrders(env, controller.scheduledTime));
    }
  }
};
