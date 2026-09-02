'use strict';
/* WB 진로독서 서비스 워커 — 앱 셸 캐시 + 오프라인 읽기 */
const VERSION = 'wbr-shell-v6';
const SHELL = ['./', './index.html', './voice.js', './manifest.webmanifest', './icon.svg'];

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

  // API 응답은 절대 캐시하지 않는다 — 캐시되면 배정·기록 같은 최신 데이터가 오래된 값으로 굳는다
  if (url.pathname.startsWith('/api/')) return;

  // 페이지 이동: 네트워크 우선, 실패 시 캐시된 앱 셸
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((r) => { const cp = r.clone(); caches.open(VERSION).then((c) => c.put('./index.html', cp)); return r; })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // 버전 파일: 항상 네트워크에서 (작다). 이걸로 아래 데이터 캐시를 무효화한다.
  if (url.pathname.endsWith('version.json')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }

  // 지문 데이터: 네트워크 우선(항상 최신), 오프라인이면 캐시
  if (/articles(-L[1-4])?\.json$|hanja\.json$/.test(url.pathname)) {
    e.respondWith(
      fetch(e.request)
        .then((r) => { const cp = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, cp)); return r; })
        .catch(() => caches.match(e.request))
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
