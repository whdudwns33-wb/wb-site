'use strict';
/* WB 워드브레인 서비스 워커 — 앱 셸 캐시 (오프라인 학습) */
const VERSION = 'wbv-shell-v4';
const SHELL = ['./', './index.html', './words.js', './bridge.js', './quiz.js', './srs.js', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* 밤 9시 물주기 알림 — 페이로드 없는 푸시(내용은 항상 동일) */
self.addEventListener('push', (e) => {
  e.waitUntil(self.registration.showNotification('WB 워드브레인', {
    body: '자기 전 3분 물주기 시간이에요 🌱 오늘 심은 단어가 기다려요.',
    icon: './icon.svg',
    badge: './icon.svg',
    tag: 'wb-night-water',
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    for (const c of cs) if (c.url.includes('/vocab') && 'focus' in c) return c.focus();
    return self.clients.openWindow('./');
  }));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;

  // 페이지 이동: 네트워크 우선, 실패 시 캐시된 앱 셸
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((r) => { const cp = r.clone(); caches.open(VERSION).then((c) => c.put('./index.html', cp)); return r; })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // 그 외 정적 자원: 캐시 우선
  e.respondWith(
    caches.match(e.request).then((m) => m || fetch(e.request).then((r) => {
      const cp = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, cp)); return r;
    }))
  );
});
