// Service worker: lets Tempolight be installed as an app (iPhone home screen, Android, desktop) and open without a
// connection. Network first, so a new version shows up straight away; the cached copy is only used when offline.
// API calls and live connections are never cached.
const CACHE = "tempolight-__BUILD__";
const SHELL = ["/", "/index.html", "/style.css", "/app.js", "/room.js", "/audio.js", "/preview.js", "/pcm-worklet.js", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/apple-touch-icon.png"];

self.addEventListener("install", e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {})); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname === "/ws") return;
  e.respondWith(fetch(req).then(res => {
    if (res.ok && res.type === "basic") { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  }).catch(async () => (await caches.match(req, { ignoreSearch: true })) || (req.mode === "navigate" ? caches.match("/index.html") : Response.error())));
});
