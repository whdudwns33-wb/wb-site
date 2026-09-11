'use strict';
/* WB 내신브레인 서비스 워커 — 앱 셸 캐시 (태블릿 학습존·오프라인 훈련)
   VERSION 은 build-dist.mjs 가 셸 파일 내용 해시로 스탬프한다 — 손으로 올리지 않는다. */
const VERSION = 'wbn-shell-dev';
const SHELL = ['./', './index.html', './engine.js', './grade.js', './gen.js', './pack-sample.json', './voice.js', './manifest.webmanifest', './icon.svg'];

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

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;

  /* API·팩 데이터는 절대 캐시하지 않는다 — 구매 콘텐츠는 no-store(기획서 §10),
     학습 기록은 캐시되면 오래된 값으로 굳는다. */
  if (url.pathname.startsWith('/api/')) return;

  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((r) => { const cp = r.clone(); caches.open(VERSION).then((c) => c.put('./index.html', cp)); return r; })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((m) => m || fetch(e.request).then((r) => {
      const cp = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, cp)); return r;
    }))
  );
});
