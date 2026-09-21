'use strict';
/* WB 브레인레터 서비스 워커 — 앱 껍데기만 캐시한다. 호 본문·기록(/api/*)과 체험 호(*.json)는 캐시하지 않는다 —
   발행·수정이 바로 보여야 하고, 학생 기록은 서버가 원천이다.
   VERSION 은 build-dist.mjs 가 껍데기 파일 내용 해시로 스탬프한다 — 손으로 올리지 않는다. */
const VERSION = 'wbl-shell-dev';
const SHELL = ['./', './index.html', './letter.js', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;                       // 호·기록은 네트워크만
  if (/\.json$/.test(url.pathname)) return;                            // 체험 호도 캐시하지 않는다
  if (e.request.mode === 'navigate') {
    /* 가족 링크(?t=)·미리보기(?id=)는 쿼리만 다른 같은 껍데기 — 오프라인이면 껍데기를 돌려주고 화면이 안내한다 */
    e.respondWith(fetch(e.request).then((r) => { const cp = r.clone(); caches.open(VERSION).then((c) => c.put('./index.html', cp)); return r; }).catch(() => caches.match('./index.html')));
    return;
  }
  e.respondWith(caches.match(e.request).then((m) => m || fetch(e.request).then((r) => { const cp = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, cp)); return r; })));
});
