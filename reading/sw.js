const PREFIX="wbr-shell-";
const VERSION = 'wbr-shell-v20261202';
const V=VERSION;
const ROOT=new URL("./",self.location.href).pathname;
const KEEP=[ROOT+"offline.html",ROOT+"icon-192.png"];
self.addEventListener('install',e=>e.waitUntil(caches.open(V).then(c=>c.addAll(KEEP)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith(PREFIX)&&k!==V).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  if(e.request.mode!=='navigate'||e.request.method!=='GET')return;
  const path=new URL(e.request.url).pathname;
  if(!path.startsWith(ROOT)||!['','index','index.html','parent','parent.html','review','review.html'].includes(path.slice(ROOT.length)))return;
  e.respondWith(fetch(e.request).catch(()=>caches.match(KEEP[0],{cacheName:V})));
});
