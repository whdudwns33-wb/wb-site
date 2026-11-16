'use strict';
/* WB 탐구브레인 서비스 워커 — 앱 셸(화면 껍데기)만 캐시한다. 홈 화면에 앱으로 설치되게 하려고 둔다.
   문제지·쪽 그림·정답은 전부 /api/ 로 오고 여기서 절대 캐시하지 않는다 — 구매 지면을 기기에 쌓지 않는다.
   VERSION 은 build-dist.mjs 가 셸 파일 내용 해시로 스탬프한다 — 손으로 올리지 않는다. */
const VERSION = 'wbt-shell-dev';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('wbt-shell-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((r) => { const cp = r.clone(); caches.open(VERSION).then((c) => c.put('./index.html', cp)); return r; })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }
  /* 셸 파일만 캐시에서 꺼낸다 — 그 밖의 것은 망에서 받고 쌓지 않는다 */
  if (!SHELL.some((s) => url.pathname.endsWith(s.slice(1)) && s !== './')) return;
  e.respondWith(caches.match(e.request).then((m) => m || fetch(e.request)));
});
