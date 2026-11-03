// HTTP + WebSocket app: serves the web UI and the JSON API, and wires the runtime, scheduler, OSC and lock together.
import http from "node:http";
import crypto from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore, newId, hashPin, checkPin } from "./store.js";
import { createRuntime } from "./runtime.js";
import { attachWebSocket } from "./ws.js";
import { startScheduler, nextRun } from "./scheduler.js";
import { startOsc } from "./osc.js";
import { listSources } from "./capture.js";
import { ROOM_PRESETS, buildPreset } from "../../engine/src/index.js";
import { getInfo, discoverWled, ipOf } from "../../outputs/src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "../../..");
const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".mp3": "audio/mpeg", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };
const SHAPE_TYPES = new Set(["line", "pole", "free", "circle", "rect", "hex", "tri", "matrix"]);
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

/**
 * @param {{dataDir:string, logger?:Console|null, discover?:boolean, now?:()=>Date}} opts
 */
export async function createApp(opts) {
  const store = createStore(opts.dataDir), data = () => store.data;
  const runtime = createRuntime(store, { logger: opts.logger === undefined ? console : opts.logger });
  const tokens = new Map(); // unlock tokens -> expiry
  let osc = null;

  // ---------------------------------------------------------------- helpers
  const locked = () => !!data().lock;
  function authorised(req, area) {
    if (!locked()) return true;
    if (area && data().settings.guest[area]) return true;
    const tok = req.headers["x-tempolight-token"] || new URL(req.url, "http://x").searchParams.get("token");
    const exp = tok && tokens.get(tok); return !!exp && exp > Date.now();
  }
  const need = (req, area) => { if (!authorised(req, area)) throw new HttpError(403, "Settings are locked. Unlock with the PIN in Settings."); };
  async function body(req) {
    let n = 0; const chunks = [];
    for await (const c of req) { n += c.length; if (n > 12 * 1024 * 1024) throw new HttpError(413, "Too much data"); chunks.push(c); }
    const s = Buffer.concat(chunks).toString("utf8"); if (!s) return {};
    try { return JSON.parse(s); } catch { throw new HttpError(400, "Body is not valid JSON"); }
  }
  const effectIds = () => new Set(runtime.effects.list.map(e => e.id));
  const pub = () => {
    const d = data();
    return { version: pkg.version, settings: d.settings, show: d.show, devices: d.devices, room: d.room, scenes: d.scenes,
      schedules: d.schedules.map(s => ({ ...s, next: nextRun(s)?.toISOString() || null })), locked: locked(),
      effects: runtime.effects.list, styles: Object.fromEntries(Object.entries(runtime.effects.styles).map(([k, v]) => [k, v.name])),
      palettes: Object.keys(runtime.effects.palettes), presets: Object.values(ROOM_PRESETS), captureSources: listSources().map(({ id, label }) => ({ id, label })), firstRun: store.firstRun && !d.devices.length };
  };
  const changed = (what) => { store.save(); broadcast({ type: "changed", what }); };

  function cleanShape(s, devIds) {
    if (!s || !SHAPE_TYPES.has(s.type)) throw new HttpError(400, `Shape type must be one of: ${[...SHAPE_TYPES].join(", ")}`);
    const o = { type: s.type, name: String(s.name || s.type).slice(0, 60), count: Math.round(Number(s.count) || 0), dev: s.dev, rot: Number(s.rot) || 0, start: Number(s.start) || 0, rev: !!s.rev,
      from: s.from === null || s.from === undefined || s.from === "" ? null : Math.max(0, Math.round(Number(s.from))) };
    if (!devIds.has(o.dev)) throw new HttpError(400, `Shape "${o.name}" points at a device that doesn't exist`);
    if (s.type === "matrix") { o.cols = Math.max(1, Math.min(256, Math.round(s.cols || 16))); o.rows = Math.max(1, Math.min(256, Math.round(s.rows || 16))); o.count = o.cols * o.rows; }
    if (!(o.count >= 1 && o.count <= 8192)) throw new HttpError(400, `Shape "${o.name}" needs between 1 and 8192 LEDs`);
    for (const k of ["cx", "cy", "size", "w", "h"]) if (s[k] !== undefined) o[k] = Number(s[k]);
    if (s.pts) { if (!Array.isArray(s.pts) || s.pts.length < 2) throw new HttpError(400, `Shape "${o.name}" needs at least two points`); o.pts = s.pts.map(p => [Number(p[0]), Number(p[1])]); }
    if (["line", "pole", "free"].includes(o.type) && !o.pts) throw new HttpError(400, `Shape "${o.name}" needs points`);
    if (["circle", "hex", "tri", "rect"].includes(o.type) && !(o.size > 0)) o.size = o.w || 1;
    if (o.type === "rect") { o.w = o.w || o.size; o.h = o.h || o.size; }
    if (o.type === "matrix") { o.w = o.w || 3; o.h = o.h || 3; o.cx = o.cx ?? 8; o.cy = o.cy ?? 4.5; }
    return o;
  }
  function autoPlace(dev) { // put a new controller into the room as a strip, below the others
    const shapes = data().room.shapes; if (shapes.some(s => s.dev === dev.id)) return;
    const y = 1 + (shapes.length % 7) * 1.1;
    shapes.push({ type: "line", name: dev.name, count: dev.leds || 60, dev: dev.id, rot: 0, start: 0, rev: false, from: null, pts: [[1.5, y], [14.5, y]] });
  }
  async function addDevice({ host, name, ddpPort, leds, force, virtual }) {
    if (virtual) { // a pretend controller: shows in the preview, sends nothing. For trying the app without hardware.
      const dev = { id: newId("d"), name: String(name || "Virtual room").slice(0, 60), host: "virtual", ddpPort: 4048, leds: Number(leds) || 600, enabled: true, virtual: true };
      data().devices.push(dev); if (!data().room.shapes.length) data().room.shapes = buildPreset("living", [dev]); else autoPlace(dev);
      runtime.rebuild(); runtime.checkDevice(dev); runtime.note(`Added ${dev.name} (virtual, ${dev.leds} LEDs)`); changed("devices"); return dev;
    }
    host = String(host || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!host) throw new HttpError(400, "Enter the controller's IP address, for example 192.168.1.42");
    const dup = data().devices.find(d => d.host === host); if (dup) return dup;
    let info = null; try { info = await getInfo(host, 2500); } catch (e) { if (!force) throw new HttpError(400, `Couldn't reach a WLED controller at ${host} (${e.message}). Check the address, or add it anyway.`); }
    const dev = { id: newId("d"), name: String(name || info?.name || host).slice(0, 60), host, ddpPort: Number(ddpPort) || 4048, leds: Number(leds) || info?.leds || 0, enabled: true };
    data().devices.push(dev); autoPlace(dev); runtime.rebuild(); runtime.checkDevice(dev); runtime.note(`Added ${dev.name} (${host}, ${dev.leds || "?"} LEDs)`);
    changed("devices"); return dev;
  }
  function applyScene(sc) {
    const wasOff = !data().show.power;
    Object.assign(data().show, sc.show || {});
    if (sc.brightness != null) data().settings.brightness = Number(sc.brightness);
    runtime.syncDirector(); if (wasOff) runtime.setPower(true);
    runtime.note(`Scene: ${sc.name}`); changed("show");
  }
  function runSchedule(s) {
    const a = s.action || {};
    if (a.type === "scene") { const sc = data().scenes.find(x => x.id === a.scene); if (sc) applyScene(sc); else runtime.note(`Schedule "${s.name}": scene is gone`, "warn"); }
    else if (a.type === "off") runtime.setPower(false).then(() => changed("show"));
    else if (a.type === "on") runtime.setPower(true).then(() => changed("show"));
    else if (a.type === "brightness") { data().settings.brightness = Math.max(0, Math.min(1, Number(a.value))); changed("settings"); }
    runtime.note(`Schedule ran: ${s.name}`);
  }
  function applySettings(b) {
    const s = data().settings, before = JSON.stringify({ fps: s.fps, cap: s.capture, osc: s.osc });
    const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v)));
    if (b.brightness !== undefined) s.brightness = num(b.brightness, 0, 1);
    if (b.fps !== undefined) s.fps = Math.round(num(b.fps, 10, 120));
    if (b.syncOffsetMs !== undefined) s.syncOffsetMs = Math.round(num(b.syncOffsetMs, -500, 500));
    if (b.idleBrightness !== undefined) s.idleBrightness = num(b.idleBrightness, 0, 1);
    if (b.idleAfterSec !== undefined) s.idleAfterSec = num(b.idleAfterSec, 1, 600);
    for (const k of ["safe", "predict", "dropFlash", "audioSync", "autoDiscover"]) if (b[k] !== undefined) s[k] = !!b[k];
    if (b.ambient !== undefined) { if (b.ambient !== "off" && !effectIds().has(b.ambient)) throw new HttpError(400, `Unknown effect "${b.ambient}"`); s.ambient = b.ambient; }
    if (b.capture) Object.assign(s.capture, { enabled: b.capture.enabled ?? s.capture.enabled, source: b.capture.source ?? s.capture.source, command: b.capture.command ?? s.capture.command });
    if (b.metronome) Object.assign(s.metronome, { enabled: b.metronome.enabled ?? s.metronome.enabled, bpm: b.metronome.bpm !== undefined ? num(b.metronome.bpm, 40, 220) : s.metronome.bpm });
    if (b.osc) Object.assign(s.osc, { enabled: b.osc.enabled ?? s.osc.enabled, port: b.osc.port !== undefined ? Math.round(num(b.osc.port, 1024, 65535)) : s.osc.port });
    if (b.guest) for (const k of Object.keys(s.guest)) if (b.guest[k] !== undefined) s.guest[k] = !!b.guest[k];
    const after = JSON.stringify({ fps: s.fps, cap: s.capture, osc: s.osc }), prev = JSON.parse(before);
    if (prev.fps !== s.fps) runtime.startLoop();
    if (JSON.stringify(prev.cap) !== JSON.stringify(s.capture)) { if (s.capture.enabled) runtime.startCaptureSource(); else runtime.stopCaptureSource(); }
    if (JSON.stringify(prev.osc) !== JSON.stringify(s.osc)) restartOsc();
    runtime.syncDirector(); changed("settings"); void after;
  }
  function applyShow(b) {
    const sh = data().show;
    if (b.effect !== undefined) { if (!effectIds().has(b.effect)) throw new HttpError(400, `Unknown effect "${b.effect}"`); sh.effect = b.effect; if (b.mode === undefined) sh.mode = "manual"; }
    if (b.mode !== undefined) { if (!["auto", "manual"].includes(b.mode)) throw new HttpError(400, "mode is auto or manual"); sh.mode = b.mode; }
    if (b.style !== undefined) { if (b.style !== "auto" && !runtime.effects.styles[b.style]) throw new HttpError(400, `Unknown style "${b.style}"`); sh.style = b.style; }
    if (b.palette !== undefined) { if (!runtime.effects.palettes[b.palette]) throw new HttpError(400, `Unknown palette "${b.palette}"`); sh.palette = b.palette; }
    if (b.everyBeats !== undefined) sh.everyBeats = Math.max(1, Math.min(64, Math.round(Number(b.everyBeats))));
    if (b.speed !== undefined) sh.speed = Math.max(0.1, Math.min(4, Number(b.speed)));
    runtime.syncDirector(); changed("show");
  }
  function oscMessage({ address, args }) {
    const a = address.replace(/^\/tempolight/, ""), v = args[0];
    if (a === "/effect") applyShow({ effect: String(v) });
    else if (a === "/auto") applyShow({ mode: "auto" });
    else if (a === "/scene") { const sc = data().scenes.find(s => s.id === v || s.name === v); if (sc) applyScene(sc); }
    else if (a === "/brightness") applySettings({ brightness: Number(v) > 1 ? Number(v) / 255 : Number(v) });
    else if (a === "/power") runtime.setPower(v === undefined ? !data().show.power : !!v).then(() => changed("show"));
    else if (a === "/bpm") applySettings({ metronome: { bpm: Number(v) } });
    else runtime.action({ type: a.slice(1), on: v === undefined ? undefined : !!v, color: typeof v === "string" ? v : undefined, value: v });
  }
  function restartOsc() { if (osc) { osc.close(); osc = null; } const o = data().settings.osc; if (o.enabled) { osc = startOsc(o.port, m => { try { oscMessage(m); } catch {} }); runtime.note(`OSC listening on UDP ${o.port}`); } }

  // ---------------------------------------------------------------- API routes
  const routes = [];
  const route = (method, pattern, area, fn) => routes.push({ method, re: new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), area, fn });
  // area: null = open to everyone, "admin" = needs unlock when a PIN is set, or a guest area name (effects, scenes, pads, brightness)

  route("GET", "/api/state", null, () => pub());
  route("GET", "/api/status", null, () => runtime.status());
  route("GET", "/api/health", null, () => ({ ok: true, version: pkg.version, uptime: process.uptime(), fps: Math.round(runtime.rt.fps), leds: runtime.layout.N }));
  route("GET", "/api/effects", null, () => runtime.effects.list);
  route("GET", "/api/layout", null, () => runtime.layoutInfo());
  route("GET", "/api/log", null, () => runtime.log.slice(-100));

  route("PATCH", "/api/show", "effects", async (req) => { applyShow(await body(req)); return data().show; });
  route("POST", "/api/power", "brightness", async (req) => { const b = await body(req); await runtime.setPower(b.on ?? !data().show.power); changed("show"); return data().show; });
  route("POST", "/api/brightness", "brightness", async (req) => { const b = await body(req); applySettings({ brightness: b.value }); return { brightness: data().settings.brightness }; });
  route("POST", "/api/action", "pads", async (req) => runtime.action(await body(req)));
  route("PATCH", "/api/settings", "admin", async (req) => { applySettings(await body(req)); return data().settings; });

  // devices
  route("GET", "/api/devices", null, () => data().devices.map(d => ({ ...d, health: runtime.health.get(d.id) || null })));
  route("POST", "/api/devices", "admin", async (req) => addDevice(await body(req)));
  route("PATCH", "/api/devices/:id", "admin", async (req, p) => {
    const d = data().devices.find(x => x.id === p.id); if (!d) throw new HttpError(404, "No such device"); const b = await body(req);
    if (b.name !== undefined) d.name = String(b.name).slice(0, 60); if (b.host !== undefined) d.host = String(b.host).trim(); if (b.ddpPort !== undefined) d.ddpPort = Number(b.ddpPort) || 4048;
    if (b.leds !== undefined) d.leds = Math.max(0, Math.round(Number(b.leds))); if (b.enabled !== undefined) d.enabled = !!b.enabled;
    runtime.rebuild(); changed("devices"); return d;
  });
  route("DELETE", "/api/devices/:id", "admin", (req, p) => {
    const i = data().devices.findIndex(x => x.id === p.id); if (i < 0) throw new HttpError(404, "No such device");
    const [d] = data().devices.splice(i, 1); data().room.shapes = data().room.shapes.filter(s => s.dev !== d.id); runtime.rebuild(); runtime.note(`Removed ${d.name}`); changed("devices"); return { ok: true };
  });
  route("POST", "/api/devices/:id/identify", null, (req, p) => { runtime.identify({ device: p.id }); return { ok: true }; });
  route("POST", "/api/devices/:id/segments", "admin", async (req, p) => ({ segments: await runtime.syncSegments(p.id) }));
  route("POST", "/api/devices/:id/check", null, async (req, p) => { const d = data().devices.find(x => x.id === p.id); if (!d) throw new HttpError(404, "No such device"); return runtime.checkDevice(d); });
  route("POST", "/api/discover", "admin", async (req) => {
    const b = await body(req), found = await discoverWled({ scan: b.scan !== false, timeoutMs: 2500, extraHosts: (b.hosts || []).map(String) });
    const known = new Set(data().devices.map(d => ipOf(d.host)));
    return found.map(f => ({ ...f, added: known.has(f.ip) }));
  });

  // room
  route("GET", "/api/room", null, () => data().room);
  route("PUT", "/api/room", "admin", async (req) => {
    const b = await body(req), ids = new Set(data().devices.map(d => d.id));
    if (!Array.isArray(b.shapes)) throw new HttpError(400, "shapes must be a list");
    const shapes = b.shapes.map(s => cleanShape(s, ids));
    data().room = { name: String(b.name || data().room.name || "My room").slice(0, 60), shapes }; runtime.rebuild(); changed("room"); return data().room;
  });
  route("POST", "/api/room/preset", "admin", async (req) => {
    const b = await body(req); if (!ROOM_PRESETS[b.id]) throw new HttpError(400, `Unknown preset "${b.id}"`);
    if (!data().devices.length) throw new HttpError(400, "Add a WLED controller first, then pick a room layout");
    data().room.shapes = buildPreset(b.id, data().devices.filter(d => d.enabled)); runtime.rebuild(); runtime.note(`Room layout: ${ROOM_PRESETS[b.id].name}`); changed("room"); return data().room;
  });
  route("POST", "/api/room/identify", null, async (req) => { const b = await body(req); runtime.identify({ shape: b.shape }); return { ok: true }; });

  // scenes
  route("GET", "/api/scenes", null, () => data().scenes);
  route("POST", "/api/scenes", "scenes", async (req) => {
    const b = await body(req), sh = data().show;
    const sc = { id: newId("s"), name: String(b.name || "New scene").slice(0, 60), show: b.show || { mode: sh.mode, effect: sh.effect, style: sh.style, palette: sh.palette, everyBeats: sh.everyBeats, speed: sh.speed }, brightness: b.brightness ?? data().settings.brightness };
    data().scenes.push(sc); changed("scenes"); return sc;
  });
  route("PUT", "/api/scenes/:id", "scenes", async (req, p) => { const sc = data().scenes.find(s => s.id === p.id); if (!sc) throw new HttpError(404, "No such scene"); const b = await body(req);
    if (b.name !== undefined) sc.name = String(b.name).slice(0, 60); if (b.show) sc.show = b.show; if (b.brightness !== undefined) sc.brightness = Number(b.brightness); changed("scenes"); return sc; });
  route("DELETE", "/api/scenes/:id", "scenes", (req, p) => { data().scenes = data().scenes.filter(s => s.id !== p.id); changed("scenes"); return { ok: true }; });
  route("POST", "/api/scenes/:id/apply", "scenes", (req, p) => { const sc = data().scenes.find(s => s.id === p.id); if (!sc) throw new HttpError(404, "No such scene"); applyScene(sc); return data().show; });

  // schedules
  const cleanSchedule = (b, old = {}) => {
    const s = { ...old, name: String(b.name ?? old.name ?? "Schedule").slice(0, 60), time: String(b.time ?? old.time ?? "18:00"), days: (b.days ?? old.days ?? [0, 1, 2, 3, 4, 5, 6]).map(Number).filter(d => d >= 0 && d <= 6),
      action: b.action ?? old.action ?? { type: "on" }, enabled: b.enabled ?? old.enabled ?? true };
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) throw new HttpError(400, "Time must look like 18:30");
    if (!["scene", "on", "off", "brightness"].includes(s.action.type)) throw new HttpError(400, "Action must be scene, on, off or brightness");
    if (s.action.type === "scene" && !data().scenes.some(x => x.id === s.action.scene)) throw new HttpError(400, "Pick a scene for this schedule");
    return s;
  };
  route("GET", "/api/schedules", null, () => pub().schedules);
  route("POST", "/api/schedules", "admin", async (req) => { const s = { id: newId("t"), ...cleanSchedule(await body(req)) }; data().schedules.push(s); changed("schedules"); return s; });
  route("PUT", "/api/schedules/:id", "admin", async (req, p) => { const i = data().schedules.findIndex(s => s.id === p.id); if (i < 0) throw new HttpError(404, "No such schedule"); data().schedules[i] = cleanSchedule(await body(req), data().schedules[i]); changed("schedules"); return data().schedules[i]; });
  route("DELETE", "/api/schedules/:id", "admin", (req, p) => { data().schedules = data().schedules.filter(s => s.id !== p.id); changed("schedules"); return { ok: true }; });
  route("POST", "/api/schedules/:id/run", "admin", (req, p) => { const s = data().schedules.find(x => x.id === p.id); if (!s) throw new HttpError(404, "No such schedule"); runSchedule(s); return { ok: true }; });

  // music
  route("POST", "/api/song", null, async (req) => { const b = await body(req); if (!b.analysis || !(b.analysis.bpm > 0)) throw new HttpError(400, "Send the song's analysis"); runtime.setSong(b, b.clientId || null); return { ok: true }; });
  route("POST", "/api/song/clock", null, async (req) => { runtime.songClock(await body(req)); return { ok: true }; });
  route("DELETE", "/api/song", null, () => { runtime.clearSong(); return { ok: true }; });
  route("GET", "/api/audio/sources", null, () => listSources().map(({ id, label }) => ({ id, label })));

  // lock
  route("POST", "/api/lock", "admin", async (req) => { const b = await body(req); if (!/^\d{4,8}$/.test(String(b.pin || ""))) throw new HttpError(400, "The PIN must be 4 to 8 digits");
    data().lock = hashPin(b.pin); tokens.clear(); const tok = crypto.randomBytes(16).toString("hex"); tokens.set(tok, Date.now() + 12 * 3600_000); runtime.note("Settings locked with a PIN"); changed("lock"); return { locked: true, token: tok }; });
  route("POST", "/api/unlock", null, async (req) => { const b = await body(req); await new Promise(r => setTimeout(r, 300)); // slow down guessing
    if (!checkPin(data().lock, b.pin)) throw new HttpError(403, "Wrong PIN"); const tok = crypto.randomBytes(16).toString("hex"); tokens.set(tok, Date.now() + 12 * 3600_000); return { token: tok }; });
  route("DELETE", "/api/lock", "admin", () => { data().lock = null; tokens.clear(); runtime.note("PIN lock removed"); changed("lock"); return { locked: false }; });
  route("POST", "/api/reset", "admin", () => { store.reset(); runtime.rebuild(); changed("all"); return { ok: true }; });

  // ---------------------------------------------------------------- static files
  const STATIC_DIRS = [["/engine/", path.join(ROOT, "packages/engine/src")], ["/", path.join(ROOT, "apps/web")]];
  const ALIASES = { "/playground": "apps/playground/index.html", "/demo.mp3": "apps/playground/demo.mp3" };
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
        for (const r of routes) { if (r.method !== req.method) continue; const m = r.re.exec(url.pathname); if (!m) continue;
          if (r.area) need(req, r.area === "admin" ? null : r.area);
          return send(200, await r.fn(req, m.groups || {})); }
        return send(404, { error: `No API route ${req.method} ${url.pathname}` });
      }
      if (req.method === "GET" && await serveStatic(req, res, url.pathname)) return;
      send(404, { error: "Not found" });
    } catch (e) { if (!res.headersSent) send(e.code && e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message || String(e) }); }
  });

  // ---------------------------------------------------------------- WebSocket: live status, preview, browser audio, song clock
  const wsClients = attachWebSocket(server, "/ws", (c, req, url) => {
    c.data.id = newId("c"); const tok = url.searchParams.get("token");
    c.data.auth = area => !locked() || (area && data().settings.guest[area]) || (tok && tokens.get(tok) > Date.now());
    setTimeout(() => c.sendJSON({ ...runtime.status(), type: "hello", id: c.data.id }), 10); // not in the same packet as the handshake
    c.onmessage = (msg, binary) => {
      if (binary) { if (c.data.audio) { const n = msg.length >> 1, a = new Int16Array(n); for (let i = 0; i < n; i++) a[i] = msg.readInt16LE(i * 2); runtime.pushPcm(a, "browser", c.data.audio.label, c.data.id, c.data.audio.rate); } return; }
      let m; try { m = JSON.parse(msg); } catch { return; }
      if (m.type === "preview") { if (m.on) runtime.previewClients.add(c); else runtime.previewClients.delete(c); }
      else if (m.type === "audio-start") { c.data.audio = { rate: Number(m.rate) || 22050, label: String(m.label || "Browser audio").slice(0, 80) }; }
      else if (m.type === "audio-stop") { c.data.audio = null; runtime.stopLive(c.data.id); }
      else if (m.type === "clock") runtime.songClock(m, null);
      else if (m.type === "action" && m.action) { if (c.data.auth("pads")) { try { runtime.action(m.action); } catch {} } }
    };
    c.onclose = () => { runtime.previewClients.delete(c); runtime.stopLive(c.data.id); runtime.clearSong(c.data.id); };
  });
  function broadcast(o) { const s = JSON.stringify(o); for (const c of wsClients) if (!c.busy) c.send(s); }
  const statusTimer = setInterval(() => { if (wsClients.size) broadcast(runtime.status()); }, 250);
  runtime.listeners.add(e => broadcast({ type: "log", ...e }));

  // ---------------------------------------------------------------- background jobs
  const sched = startScheduler(() => data().schedules, runSchedule, opts.now);
  restartOsc();
  async function firstRunDiscovery() {
    if (opts.discover === false || !data().settings.autoDiscover || data().devices.length) return;
    runtime.note("Looking for WLED controllers on your network…");
    try {
      const found = await discoverWled({ scan: true, timeoutMs: 2500 });
      for (const f of found) await addDevice({ host: f.host, name: f.name, leds: f.leds, force: true });
      runtime.note(found.length ? `Found ${found.length} WLED controller${found.length > 1 ? "s" : ""}` : "No WLED controllers found yet. Add one by IP address on the Devices page.");
    } catch (e) { runtime.note(`Discovery failed: ${e.message}`, "warn"); }
  }
  const discovery = firstRunDiscovery();

  return {
    server, runtime, store, discovery,
    listen(port, host) { return new Promise((res, rej) => { server.once("error", rej); server.listen(port, host, () => res(server.address().port)); }); },
    async close() { clearInterval(statusTimer); sched.stop(); osc && osc.close(); runtime.close(); for (const c of wsClients) c.close(); store.flush(); const done = new Promise(r => server.close(r)); server.closeAllConnections?.(); await done; },
  };
}
