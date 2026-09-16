'use strict';
/* WB 하루브레인 서비스 워커 — 앱 껍데기만 캐시한다. 팩·문항·기록(/api/*)은 절대 캐시하지 않는다(설계안 §7-1).
   VERSION 은 build-dist.mjs 가 껍데기 파일 내용 해시로 스탬프한다 — 손으로 올리지 않는다. */
const VERSION = 'wbh-shell-dev';
const SHELL = ['./', './index.html', './strings.js', './plan.js', './mastery.js', './srs.js', './cause.js', './probe.js', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;                       // 문항·기록은 네트워크만
  if (/\.json$/.test(url.pathname)) return;                            // atoms.json 도 캐시하지 않는다 — 원자 목록이 바뀌면 바로 받아야 한다
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then((r) => { const cp = r.clone(); caches.open(VERSION).then((c) => c.put('./index.html', cp)); return r; }).catch(() => caches.match('./index.html')));
    return;
  }
  e.respondWith(caches.match(e.request).then((m) => m || fetch(e.request).then((r) => { const cp = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, cp)); return r; })));
});
