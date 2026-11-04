// Tempolight server for a PC or Raspberry Pi: the HTTP API, the web app's files and the WebSocket, around the core
// (core.js), with real network and sound-card access (node-io.js).
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore, newId, hashPin, checkPin } from "./store.js";
import { createRuntime } from "./runtime.js";
import { createCore, HttpError } from "./core.js";
import { attachWebSocket } from "./ws.js";
import { startOsc } from "./osc.js";
import * as io from "./node-io.js";
import { startHomeAssistant } from "./homeassistant.js";
import { createUpdater } from "./update.js";
import { startProLink } from "./prolink.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "../../..");
const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".mp3": "audio/mpeg", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

async function readBody(req) {
  let n = 0; const chunks = [];
  for await (const c of req) { n += c.length; if (n > 12 * 1024 * 1024) throw new HttpError(413, "Too much data"); chunks.push(c); }
  const s = Buffer.concat(chunks).toString("utf8"); if (!s) return {};
  try { return JSON.parse(s); } catch { throw new HttpError(400, "Body is not valid JSON"); }
}

/**
 * @param {{dataDir:string, logger?:Console|null, discover?:boolean, now?:()=>Date}} opts
 */
export async function createApp(opts) {
  const store = createStore(opts.dataDir);
  let closeApp = async () => {};
  const updater = opts.updater || createUpdater(ROOT, { exit: async code => { try { await closeApp(); } catch {} process.exit(code); } });
  const runtime = createRuntime(store, { io, logger: opts.logger === undefined ? console : opts.logger });
  const core = createCore({ store, runtime, env: {
    version: pkg.version, newId, hashPin, checkPin, randomToken: () => crypto.randomBytes(16).toString("hex"),
    getInfo: io.getInfo, discoverWled: io.discoverWled, discoverGovee: io.discoverGovee, ipOf: io.ipOf, listSources: io.listSources, startOsc,
    uptime: () => process.uptime(), now: opts.now, discover: opts.discover,
    update: updater, startProLink,
    lan: () => Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === "IPv4" && !a.internal).map(a => a.address) } });
  const ha = startHomeAssistant({ core, store, runtime, version: pkg.version });

  // ---------------------------------------------------------------- static files
  // /packages/ serves the engine and the server core to the browser too (the web app and the demo import them)
  const STATIC_DIRS = [["/engine/", path.join(ROOT, "packages/engine/src")], ["/packages/", path.join(ROOT, "packages")], ["/", path.join(ROOT, "apps/web")]];
  const ALIASES = { "/phone": "apps/web/phone.html", "/playground": "apps/playground/index.html", "/demo.mp3": "apps/playground/demo.mp3" };
  async function serveStatic(req, res, pathname) {
    let file = ALIASES[pathname] ? path.join(ROOT, ALIASES[pathname]) : null;
    if (!file) for (const [prefix, dir] of STATIC_DIRS) if (pathname.startsWith(prefix)) {
      const rel = decodeURIComponent(pathname.slice(prefix.length)) || "index.html", f = path.resolve(dir, rel);
      if (!f.startsWith(dir + path.sep) && f !== dir) return false; file = f; break; }
    if (!file) return false;
    try { const st = await stat(file); if (st.isDirectory()) file = path.join(file, "index.html"); } catch { if (!path.extname(pathname)) file = path.join(ROOT, "apps/web/index.html"); else return false; }
    try { const buf = await readFile(file); res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" }); res.end(buf); return true; } catch { return false; }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
    try {
      if (url.pathname.startsWith("/api/")) {
        const body = req.method === "GET" ? {} : await readBody(req);
        return send(200, await core.handle(req.method, url.pathname, { headers: req.headers, query: Object.fromEntries(url.searchParams), body }));
      }
      if (req.method === "GET" && await serveStatic(req, res, url.pathname)) return;
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
    server, runtime, store, core, discovery: core.discovery,
    listen(port, host) { return new Promise((res, rej) => { server.once("error", rej); server.listen(port, host, () => res(server.address().port)); }); },
    async close() { ha.close(); core.close(); runtime.close(); for (const c of wsClients) c.close(); store.flush(); const done = new Promise(r => server.close(r)); server.closeAllConnections?.(); await done; },
  };
  return api;
}
