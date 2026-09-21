'use strict';
/* WB 브레인레터 서비스 워커 — 앱 껍데기만 캐시한다. 호 본문·기록(/api/*)과 체험 호(*.json)는 캐시하지 않는다 —
   발행·수정이 바로 보여야 하고, 학생 기록은 서버가 원천이다.
   VERSION 은 build-dist.mjs 가 껍데기 파일 내용 해시로 스탬프한다 — 손으로 올리지 않는다. */
const VERSION = 'wbl-shell-dev';
const SHELL = ['./', './index.html', './letter.js', './shapes.js', './drills.js', './voice.js', './trace.js', './manifest.webmanifest', './icon.svg'];
const META = 'wbl-meta';   // 알림을 눌렀을 때 열 주소(가족 링크) — 페이지가 구독할 때 적어 둔다. 캐시 이름을 바꿔도 지우지 않는다
const FONTS = 'wbl-fonts'; // 글꼴 조각 — 경로에 판(v39)이 박혀 있어 한 번 받으면 그대로다. 껍데기 캐시가 갈려도 지우지 않는다

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== META && k !== FONTS).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

/* 새 호 도착 알림 — 페이로드 없는 푸시(워드브레인과 같은 배선). 내용은 항상 같고, 호 제목은 열어서 본다 */
self.addEventListener('push', (e) => {
  e.waitUntil(self.registration.showNotification('WB 브레인레터', {
    body: '새 호가 도착했어요. 이번 주 읽을거리와 두뇌 놀이를 열어 보세요.',
    icon: './icon.svg',
    badge: './icon.svg',
    tag: 'wb-letter-issue',
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(caches.open(META).then((c) => c.match('./famlink')).then((r) => (r ? r.text() : './')).catch(() => './').then((target) =>
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
      for (const c of cs) if (c.url.includes('/letter') && 'focus' in c) { if ('navigate' in c && target !== './') c.navigate(target); return c.focus(); }
      return self.clients.openWindow(target);
    })));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;                       // 호·기록·사진은 네트워크만
  if (/\.json$/.test(url.pathname)) return;                            // 체험 호·달력도 캐시하지 않는다
  if (/\/fonts\/.+\.woff2$/.test(url.pathname)) {                        // 글꼴 조각 — 캐시 먼저. 오프라인에서도 같은 글꼴로 보인다
    e.respondWith(caches.open(FONTS).then((c) => c.match(e.request).then((m) => m || fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }))));
    return;
  }
  if (/\/fonts\/fonts\.css$/.test(url.pathname)) {                       // 글꼴 목록은 판이 바뀌면 내용이 바뀐다 — 네트워크 먼저, 오프라인이면 마지막 것
    e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const cp = r.clone(); caches.open(FONTS).then((c) => c.put(e.request, cp)); } return r; }).catch(() => caches.match(e.request)));
    return;
  }
  if (e.request.mode === 'navigate') {
    /* 가족 링크(?t=)·미리보기(?id=)는 쿼리만 다른 같은 껍데기 — 오프라인이면 껍데기를 돌려주고 화면이 안내한다 */
    e.respondWith(fetch(e.request).then((r) => { const cp = r.clone(); caches.open(VERSION).then((c) => c.put('./index.html', cp)); return r; }).catch(() => caches.match('./index.html')));
    return;
  }
  e.respondWith(caches.match(e.request).then((m) => m || fetch(e.request).then((r) => { const cp = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, cp)); return r; })));
});
