const PREFIX="wbt-shell-";
const VERSION = 'wbt-shell-dev';
const V=VERSION;const KEEP=["/naesin-tg/offline.html","/naesin-tg/icon-192.png"];
const SCOPE="/naesin-tg/";
self.addEventListener('install',e=>e.waitUntil(caches.open(V).then(c=>c.addAll(KEEP)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith(PREFIX)&&k!==V).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  if(e.request.mode!=='navigate'||e.request.method!=='GET')return;
  const path=new URL(e.request.url).pathname;
  if(!path.startsWith(SCOPE)||path==='/mcp'||path.startsWith('/mcp/')||path.startsWith('/api/')||path==='/api'||
     path===SCOPE+'mcp'||path.startsWith(SCOPE+'mcp/')||path===SCOPE+'api'||path.startsWith(SCOPE+'api/'))return;
  e.respondWith(fetch(e.request).catch(()=>caches.match(KEEP[0],{cacheName:V})));
});
