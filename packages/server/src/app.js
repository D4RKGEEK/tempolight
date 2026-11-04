// Tempolight server for a PC or Raspberry Pi: the HTTP API, the web app's files and the WebSocket, around the core
// (core.js), with real network and sound-card access (node-io.js).
import os from "node:os";
import http from "node:http";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore, newId, hashPin, checkPin } from "./store.js";
import { createRuntime } from "./runtime.js";
import { createCore, HttpError } from "./core.js";
import { attachWebSocket, foreignOrigin } from "./ws.js";
import { startOsc } from "./osc.js";
import * as io from "./node-io.js";
import { startHomeAssistant } from "./homeassistant.js";
import { startHomeKit } from "./homekit/index.js";
import { createUpdater } from "./update.js";
import { startProLink } from "./prolink.js";
import { startNowPlaying } from "./nowplaying.js";
import { startHearing } from "./hearing.js";
import { startSpotify } from "./spotify.js";
import { startLink } from "./ableton-link.js";
import { applyEnvSettings } from "./env-settings.js";
import { wifiClient } from "./wifi.js";
import { startIntegrations } from "./integrations/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "../../..");
// the one-file app (scripts/bundle.js, build-sea.js) carries the web app's files inside the executable
const embedded = globalThis.__tempolightAssets;
const readStatic = embedded ? async f => embedded.read(f) : f => readFile(f);
const statStatic = embedded ? async f => embedded.stat(f) : f => stat(f);
const pkg = JSON.parse(String(await readStatic(path.join(ROOT, "package.json"))));
export const VERSION = pkg.version;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".mp3": "audio/mpeg", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

// ---------------------------------------------------------------- static files, compressed
// Text files are sent compressed (brotli, else gzip, as the browser accepts) from buffers kept in memory, with an ETag
// so a reload costs a 304. Brotli at its best setting is slow (half a second for the whole app on a fast PC, several on
// a Pi Zero), so it is made in the background the first time a file is asked for (zlib's thread pool, not the frame
// loop) and that request gets gzip, which takes milliseconds. URLs with ?v= are versioned: cached for a year.
const COMPRESS = new Set([".html", ".js", ".css", ".json", ".svg", ".webmanifest", ".txt", ".md", ".map"]);
const MAX_CACHED = 4 * 1024 * 1024; // bigger files (the demo song) are read each time, not kept
const files = new Map(); // path -> {mtimeMs, size, raw, tag, gz?, gzP?, br?, brP?}
export function acceptsEncoding(header, name) { // "br;q=1.0, gzip;q=0.5, *;q=0": q=0 means no
  for (const part of String(header || "").toLowerCase().split(",")) { const [n, ...ps] = part.trim().split(";"), q = ps.map(x => x.trim()).find(x => x.startsWith("q="));
    if ((n === name || n === "*") && !(q && Number(q.slice(2)) === 0)) return true; }
  return false;
}
async function cachedFile(file, st) {
  let c = files.get(file); if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c;
  const raw = Buffer.from(await readStatic(file)); c = { mtimeMs: st.mtimeMs, size: st.size ?? raw.length, raw, tag: crypto.createHash("sha1").update(raw).digest("base64url").slice(0, 22) };
  if (c.size <= MAX_CACHED) { if (files.size > 1000) files.clear(); files.set(file, c); } return c;
}
const gzipOf = c => c.gzP || (c.gzP = new Promise(r => zlib.gzip(c.raw, { level: 9 }, (e, b) => r((c.gz = !e && b.length < c.raw.length ? b : null)))));
const brotliOf = (c, quality) => c.brP || (c.brP = new Promise(r => zlib.brotliCompress(c.raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: c.raw.length } }, (e, b) => r((c.br = !e && b.length < c.raw.length ? b : null)))));
/** The representation to send: {body, encoding, etag}. lite: a quicker brotli setting (low-power mode). */
export async function pickBody(c, ext, acceptEncoding, { lite = false } = {}) {
  const id = { body: c.raw, encoding: null, etag: `"${c.tag}"` };
  if (!COMPRESS.has(ext) || c.raw.length < 1024) return id;
  if (acceptsEncoding(acceptEncoding, "br")) { if (c.br) return { body: c.br, encoding: "br", etag: `W/"${c.tag}-br"` }; brotliOf(c, lite ? 9 : 11); } // ready next time
  if (acceptsEncoding(acceptEncoding, "gzip")) { const gz = c.gz || await gzipOf(c); if (gz) return { body: gz, encoding: "gzip", etag: `W/"${c.tag}-gz"` }; }
  return id;
}
const matches = (inm, tag) => !!inm && String(inm).split(",").some(x => { const v = x.trim().replace(/^W\//, "").replace(/^"|"$/g, ""); return v === "*" || v === tag || v === tag + "-br" || v === tag + "-gz"; });

async function readBody(req) {
  let n = 0; const chunks = [];
  for await (const c of req) { n += c.length; if (n > 12 * 1024 * 1024) throw new HttpError(413, "Too much data"); chunks.push(c); }
  const s = Buffer.concat(chunks).toString("utf8"); if (!s) return {};
  try { return JSON.parse(s); } catch { throw new HttpError(400, "Body is not valid JSON"); }
}

/**
 * @param {{dataDir:string, logger?:Console|null, discover?:boolean, now?:()=>Date, envSettings?:object, wifi?:object|null}} opts
 *   envSettings: settings from the environment (env-settings.js) that win over the saved ones
 *   wifi: the Wi-Fi setup service client (Raspberry Pi image); by default from $TEMPOLIGHT_WIFI_SETUP on Linux
 */
export async function createApp(opts) {
  const store = createStore(opts.dataDir);
  if (opts.envSettings) applyEnvSettings(store, opts.envSettings);
  const wifi = opts.wifi !== undefined ? opts.wifi : process.platform === "linux" && process.env.TEMPOLIGHT_WIFI_SETUP ? wifiClient(process.env.TEMPOLIGHT_WIFI_SETUP) : null;
  let closeApp = async () => {};
  const updater = opts.updater || createUpdater(ROOT, { exit: async (code, then) => { try { await closeApp(); } catch {} try { then?.(); } catch {} process.exit(code); } }); // then: after the port is free (start the new copy)
  // pretend sound inputs (tests): opts.hearing.commandFor(id) is the command for a named input (a sine wave instead of
  // BlackHole through ffmpeg; null: the real one, false: none), opts.hearing.listSources the fixed ones
  const cmdFor = opts.hearing?.commandFor, rio = cmdFor || opts.hearing?.listSources ? { ...io, ...(opts.hearing.listSources ? { listSources: opts.hearing.listSources } : {}),
    sourceFor: id => { const cmd = cmdFor?.(id); return cmd ? { id, label: `${String(id).replace(/^\w+:/, "")} (pretend)`, cmd } : cmd === false ? null : io.sourceFor(id); } } : io;
  const runtime = createRuntime(store, { io: rio, logger: opts.logger === undefined ? console : opts.logger, now: opts.now, host: opts.host, cpuUsage: () => process.cpuUsage() }); // opts.host: pretend computer (tests)
  const core = createCore({ store, runtime, env: {
    version: pkg.version, newId, hashPin, checkPin, randomToken: () => crypto.randomBytes(16).toString("hex"),
    getInfo: io.getInfo, discoverWled: io.discoverWled, discoverGovee: io.discoverGovee, listOpenRGB: io.listOpenRGB, nanoleafPair: io.nanoleafPair, nanoleafInfo: io.nanoleafInfo, panelPoints: io.panelPoints, huePair: io.huePair, hueLights: io.hueLights, huePairKey: io.huePairKey, hueAreas: io.hueEntertainmentAreas, lights: io.LIGHT_KINDS, discoverLights: io.discoverLights, ipOf: io.ipOf, listSources: rio.listSources, startOsc,
    uptime: () => process.uptime(), now: opts.now, discover: opts.discover,
    update: updater, startProLink, startLink, wifi,
    quit: embedded?.sea ? async () => { try { await closeApp(); } catch {} process.exit(0); } : null, // the one-file app has no terminal to stop it from
    lan: () => Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === "IPv4" && !a.internal).map(a => a.address) } });
  const ha = startHomeAssistant({ core, store, runtime, version: pkg.version });
  const hk = startHomeKit({ core, store, runtime, version: pkg.version, dataDir: opts.dataDir, ...opts.homekit }); // Apple Home; opts.homekit: {mdns, host, port} (tests)
  const integ = startIntegrations({ core, store, runtime, root: ROOT, ...opts.integrations }); // OBS, games, Twitch, Discord, Stream Deck (opts.integrations: pretend services in tests)
  const np = startNowPlaying({ core, store, runtime, dataDir: opts.dataDir, port: () => server.address()?.port || 8080, ...opts.nowPlaying }); // opts.nowPlaying: test runner/platform
  const hearing = startHearing({ core, store, runtime, ...(opts.hearing || {}) }); // how Tempolight hears music, and the sound output (opts.hearing: pretend computer)
  const spotify = startSpotify({ core, store, runtime, nowPlaying: np, dataDir: opts.dataDir, fetch: opts.nowPlaying?.fetch, ...opts.spotify }); // Sync with Spotify (opts.spotify: test clock)

  // ---------------------------------------------------------------- static files
  // /packages/ serves the engine and the server core to the browser too (the web app and the demo import them)
  const STATIC_DIRS = [["/engine/", path.join(ROOT, "packages/engine/src")], ["/packages/", path.join(ROOT, "packages")], ["/", path.join(ROOT, "apps/web")]];
  const ALIASES = { "/phone": "apps/web/phone.html", "/request": "apps/web/request.html", "/playground": "apps/playground/index.html", "/demo.mp3": "apps/playground/demo.mp3" };
  ALIASES["/obs"] = "apps/web/obs.html"; // the OBS browser source (integrations)
  async function serveStatic(req, res, pathname, search = "") {
    let file = ALIASES[pathname] ? path.join(ROOT, ALIASES[pathname]) : null;
    if (!file) for (const [prefix, dir] of STATIC_DIRS) if (pathname.startsWith(prefix)) {
      const rel = decodeURIComponent(pathname.slice(prefix.length)) || "index.html", f = path.resolve(dir, rel);
      if (!f.startsWith(dir + path.sep) && f !== dir) return false; file = f; break; }
    if (!file) return false;
    try { const st = await statStatic(file); if (st.isDirectory()) file = path.join(file, "index.html"); } catch { if (!path.extname(pathname)) file = path.join(ROOT, "apps/web/index.html"); else return false; }
    try {
      const st = await statStatic(file), c = await cachedFile(file, st), ext = path.extname(file), versioned = /(^|[?&])v=/.test(search);
      const head = { "content-type": MIME[ext] || "application/octet-stream", "cache-control": versioned ? "public, max-age=31536000, immutable" : "no-cache" };
      if (COMPRESS.has(ext)) head.vary = "Accept-Encoding";
      if (matches(req.headers["if-none-match"], c.tag)) { const p = await pickBody(c, ext, req.headers["accept-encoding"], { lite: runtime.perf?.lite }); res.writeHead(304, { ...head, etag: p.etag }); res.end(); return true; }
      const p = await pickBody(c, ext, req.headers["accept-encoding"], { lite: runtime.perf?.lite });
      res.writeHead(200, { ...head, etag: p.etag, "content-length": p.body.length, ...(p.encoding ? { "content-encoding": p.encoding } : {}) }); res.end(p.body); return true;
    } catch { return false; }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
    try {
      if (await np.handleHttp(req, res, url)) return; // Spotify's sign-in redirect (an HTML page)
      if (await integ.handleHttp(req, res, url)) return; // the Stream Deck plugin's download
      if (url.pathname.startsWith("/api/")) {
        // the docs site's "Try it" panel, when an admin allowed it (Integrations → Docs site): CORS for that origin only
        const docs = integ.docsOrigin(req.headers.origin);
        if (docs) { res.setHeader("access-control-allow-origin", req.headers.origin); res.setHeader("vary", "Origin"); }
        if (req.method === "OPTIONS" && docs) { // the browser's preflight
          res.writeHead(204, { "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE", "access-control-allow-headers": "content-type, x-tempolight-token, x-tempolight-key",
            "access-control-max-age": "600", ...(req.headers["access-control-request-private-network"] ? { "access-control-allow-private-network": "true" } : {}) });
          return res.end(); }
        if (req.method !== "GET" && foreignOrigin(req) && !docs) return send(403, { error: "Requests from other websites aren't allowed" }); // stops cross-site requests changing things
        const body = req.method === "GET" ? {} : await readBody(req);
        return send(200, await core.handle(req.method, url.pathname, { headers: req.headers, query: Object.fromEntries(url.searchParams), body }));
      }
      if (req.method === "GET" && await serveStatic(req, res, url.pathname, url.search)) return;
      send(404, { error: "Not found" });
    } catch (e) { if (!res.headersSent) send(e.code && e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message || String(e) }); }
  });

  const wsClients = attachWebSocket(server, "/ws", (c, req, url) => {
    const h = core.connect(c, Object.fromEntries(url.searchParams));
    c.onmessage = (msg, binary) => {
      if (!binary) return h.message(msg, false);
      const n = msg.length >> 1, a = new Int16Array(n); for (let i = 0; i < n; i++) a[i] = msg.readInt16LE(i * 2); h.message(a, true);
    };
    c.onclose = () => h.close();
  });

  closeApp = () => api.close();
  const api = {
    server, runtime, store, core, discovery: core.discovery, nowPlaying: np, hearing, homekit: hk, spotify, integrations: integ,
    listen(port, host) { return new Promise((res, rej) => { server.once("error", rej); server.listen(port, host, () => res(server.address().port)); }); },
    async close() { ha.close(); spotify.close(); np.close(); hearing.close(); await hk.close(); integ.close(); core.close(); runtime.close(); for (const c of wsClients) c.close(); store.flush(); const done = new Promise(r => server.close(r)); server.closeAllConnections?.(); await done; },
  };
  return api;
}
