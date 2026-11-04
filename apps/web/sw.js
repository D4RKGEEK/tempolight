// Service worker: lets Tempolight be installed as an app (iPhone home screen, Android, desktop) and open without a
// connection. Network first, so a new version shows up straight away; the cached copy is only used when offline.
// API calls and live connections are never cached.
const CACHE = "tempolight-__BUILD__";
const SHELL = ["/", "/index.html", "/style.css", "/app.js", "/audio.js", "/preview.js", "/pcm-worklet.js", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/apple-touch-icon.png",
  "/homestrip.js", "/latency.js", "/setup.css"];
// the pages and parts app.js loads only when they are first shown: kept too, so every page opens offline, not just the
// ones visited before going offline (fetched after the first visit has loaded, in the background)
const LATER = ["/room.js", "/mapper.js", "/mapping.js", "/timeline.js", "/timeline.css", "/homesleep.js", "/dmx.js", "/midiclock.js", "/wizard.js", "/nowplaying.js", "/homekit.js", "/spotify.js",
  "/qr.js", "/calibrate.js", "/screen.js", "/engine/layout.js", "/engine/presets.js",
  "/engine/analysis.js", "/engine/tonal.js"];

// one at a time and each on its own, so a file this server doesn't have can't stop the others being kept
const keep = (c, list) => Promise.all(list.map(u => c.match(u).then(hit => hit || c.add(u)).catch(() => {})));
self.addEventListener("install", e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => keep(c, SHELL)).catch(() => {})); });
self.addEventListener("message", e => { if (e.data === "precache") e.waitUntil(caches.open(CACHE).then(c => keep(c, LATER)).catch(() => {})); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname === "/ws") return;
  e.respondWith(fetch(req).then(res => {
    if (res.ok && res.type === "basic") { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  }).catch(async () => (await caches.match(req, { ignoreSearch: true })) || (req.mode === "navigate" ? caches.match("/index.html") : Response.error())));
});
