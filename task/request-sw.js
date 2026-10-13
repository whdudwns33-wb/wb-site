'use strict';
// 캐시·토큰을 저장하지 않는 /task/ 전용 알림 워커.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
  event.waitUntil(Promise.all([
    self.registration.showNotification('WB 업무지시서 · 새 실시간 요청', {
      body: '새 요청이 도착했습니다. 업무지시서에 로그인하여 확인해 주세요.',
      tag: 'wb-live-request', renotify: true,
      data: { url: self.registration.scope }
    }),
    self.clients.matchAll({type:'window',includeUncontrolled:true}).then(clients =>
      clients.filter(client => client.url.startsWith(self.registration.scope))
        .forEach(client => client.postMessage({type:'WB_LIVE_REQUEST'})))
  ]));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = self.registration.scope;
    const clients = await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const client = clients.find(item => item.url.startsWith(url));
    if (client) { await client.focus(); client.postMessage({type:'WB_LIVE_REQUEST'}); }
    else await self.clients.openWindow(url);
  })());
});
