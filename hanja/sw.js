'use strict';
/* WB 어휘브레인 서비스 워커 — 앱 껍데기만 캐시한다. 단어장·기록(/api/*)은 절대 캐시하지 않는다:
   캐시되면 새로 올린 단어장·배정이 오래된 값으로 굳는다. 체험 단어장(book-sample.json)은 껍데기의 일부다.
   VERSION 은 build-dist.mjs 가 껍데기 파일 내용 해시로 스탬프한다 — 손으로 올리지 않는다. */
const VERSION = 'wbhj-shell-dev';
const SHELL = ['./', './index.html', './voice.js', './srs.js', './quiz.js', './trace.js', './book-check.js', './bridge.js', './book-sample.json', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
/* 밤 9시 알림 — 페이로드 없는 푸시(내용은 늘 같다). 첫 복습이 밤 9시라 이 알림이 학생을 다시 앉힌다 */
self.addEventListener('push', (e) => {
  e.waitUntil(self.registration.showNotification('WB 어휘브레인', {
    body: '자기 전 3분 — 오늘 배운 한자·낱말이 기다려요 ✍️',
    icon: './icon.svg', badge: './icon.svg', tag: 'wbhj-night',
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    for (const c of cs) if (c.url.includes('/hanja') && 'focus' in c) return c.focus();
    return self.clients.openWindow('./');
  }));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;                       // 단어장·기록은 네트워크만
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then((r) => { const cp = r.clone(); caches.open(VERSION).then((c) => c.put('./index.html', cp)); return r; }).catch(() => caches.match('./index.html')));
    return;
  }
  e.respondWith(caches.match(e.request).then((m) => m || fetch(e.request).then((r) => { const cp = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, cp)); return r; })));
});
