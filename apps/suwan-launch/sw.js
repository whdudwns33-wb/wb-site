'use strict';
/* WB 전략 총괄 보드 서비스 워커 — 앱 셸 캐시 + 오프라인 실행

   이 보드의 데이터는 전부 localStorage 에 있고 서비스 워커는 손대지 않는다.
   캐시하는 건 화면(HTML·아이콘)뿐이다.

   페이지는 네트워크 우선이다. 캐시 우선으로 하면 고쳐서 배포해도 기기에
   옛 화면이 눌러앉는다 — 이 보드는 계속 고쳐 쓰는 도구라 그게 더 나쁘다.
   네트워크가 없을 때만 캐시된 화면으로 연다. */
const VERSION = 'wb-strategy-shell-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  // 하나라도 실패하면 설치 전체가 실패하므로 개별로 담는다(아이콘 한 장 때문에 앱이 안 깔리면 곤란하다).
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
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

  /* 페이지 이동: 네트워크 우선, 실패하면 그 페이지의 캐시본.
     index.html 로 넘기지 않는다 — 같은 폴더의 partner-brief.html 이
     엉뚱하게 보드 화면으로 열리면 안 된다. */
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          const copy = r.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy)).catch(() => {});
          return r;
        })
        .catch(() => caches.match(e.request).then((m) => m || caches.match('./index.html')))
    );
    return;
  }

  // 그 외 정적 자원(아이콘·매니페스트): 캐시 우선
  e.respondWith(
    caches.match(e.request).then((m) => m || fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copy)).catch(() => {});
      return r;
    }))
  );
});

/* 새 버전이 준비되면 화면이 알려 준다 — 사용자가 새로고침을 누를 수 있게. */
self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
