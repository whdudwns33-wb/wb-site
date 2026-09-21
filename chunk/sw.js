'use strict';
/* WB 청크브레인 서비스 워커 — 앱 셸 캐시 (오프라인 연습). VERSION 은 build-dist 가 내용 해시로 스탬프한다. */
const VERSION = 'wbc-shell-dev';
/* 알림을 눌렀을 때 열 주소(가족 링크)를 적어 두는 자리 — 껍데기 캐시가 갈려도 남아야 해서 이름을 따로 둔다 */
const META = 'wbc-meta';
const SHELL = ['./', './index.html', './print.html', './class.html', './voice.js', './rules.js', './sched.js', './lessons.js', './passages.js', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== META).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* 가족 알림 — 페이로드 없는 푸시(브레인레터·워드브레인과 같은 배선). 아이 이름은 담지 않는다 */
self.addEventListener('push', (e) => {
  e.waitUntil(self.registration.showNotification('WB 청크브레인', {
    body: '오늘 복습할 글이 있어요. 아이와 5분만 함께 읽어 볼까요?',
    icon: './icon.svg',
    badge: './icon.svg',
    tag: 'wb-chunk-due',
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  /* 가족 링크는 토큰이 있어야 열린다 — 구독할 때 적어 둔 주소로 간다 */
  e.waitUntil(caches.open(META).then((c) => c.match('./famlink')).then((r) => (r ? r.text() : './')).catch(() => './').then((target) =>
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
      for (const c of cs) if (c.url.includes('/chunk') && 'focus' in c) { if ('navigate' in c && target !== './') c.navigate(target); return c.focus(); }
      return self.clients.openWindow(target);
    })));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  /* API 응답은 절대 캐시하지 않는다 — 기록이 옛 값으로 굳는다 */
  if (url.pathname.startsWith('/api/')) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((r) => { const cp = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, cp)); return r; })
        .catch(() => caches.match(e.request).then((m) => m || caches.match('./index.html')))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then((m) => m || fetch(e.request).then((r) => {
      const cp = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, cp)); return r;
    }))
  );
});
