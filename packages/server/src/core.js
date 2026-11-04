// Tempolight's core: every API call, scenes, schedules, the PIN lock and live updates. No Node.js modules here, so the
// same code runs the server on a PC or Pi (app.js) and the online demo inside a browser (apps/web/demo.js).
import { startScheduler, nextRun } from "./scheduler.js";
import { resolveTime } from "./sun.js";
import { DEFAULTS, merge } from "./defaults.js";
import { ROOM_PRESETS, buildPreset } from "../../engine/src/index.js";

const SHAPE_TYPES = new Set(["line", "pole", "free", "circle", "rect", "hex", "tri", "matrix", "points"]);
export class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

/**
 * @param {{store:{data:object, save():void, flush():void, reset():void, firstRun:boolean}, runtime:object, env:{version:string,
 *   newId(p?:string):string, randomToken():string, hashPin(pin:string):object, checkPin(lock:object, pin:string):boolean,
 *   getInfo:Function, discoverWled:Function, ipOf:Function, listSources():any[], startOsc?:Function, uptime():number,
 *   now?:()=>Date, discover?:boolean}}} o
 */
export function createCore({ store, runtime, env }) {
  const data = () => store.data;
  const tokens = new Map(); // unlock tokens -> expiry
  let osc = null;

  // ---------------------------------------------------------------- helpers
  const locked = () => !!data().lock;
  function authorised(ctx, area) {
    if (!locked()) return true;
    if (area && data().settings.guest[area]) return true;
    const tok = ctx.headers?.["x-tempolight-token"] || ctx.query?.token;
    const exp = tok && tokens.get(tok); return !!exp && exp > Date.now();
  }
  const need = (ctx, area) => { if (!authorised(ctx, area)) throw new HttpError(403, "Settings are locked. Unlock with the PIN in Settings."); };
  const effectIds = () => new Set(runtime.effects.list.map(e => e.id));
  const pub = () => {
    const d = data();
    return { version: env.version, settings: { ...d.settings, mqtt: { ...d.settings.mqtt, password: "", hasPassword: !!d.settings.mqtt?.password } }, show: d.show, devices: d.devices.map(x => safeDev(x)), room: d.room, scenes: d.scenes,
      schedules: d.schedules.map(s => ({ ...s, next: nextRun(s, new Date(), d.settings.location)?.toISOString() || null })), locked: locked(),
      effects: runtime.effects.list, styles: Object.fromEntries(Object.entries(runtime.effects.styles).map(([k, v]) => [k, v.name])),
      palettes: Object.keys(runtime.effects.palettes), presets: Object.values(ROOM_PRESETS), captureSources: env.listSources().map(({ id, label }) => ({ id, label })), firstRun: store.firstRun && !d.devices.length };
  };
  const changeListeners = new Set();
  const changed = (what) => { store.save(); broadcast({ type: "changed", what }); for (const f of changeListeners) { try { f(what); } catch {} } };

  function cleanShape(s, devIds) {
    if (!s || !SHAPE_TYPES.has(s.type)) throw new HttpError(400, `Shape type must be one of: ${[...SHAPE_TYPES].join(", ")}`);
    const o = { type: s.type, name: String(s.name || s.type).slice(0, 60), count: Math.round(Number(s.count) || 0), dev: s.dev, rot: Number(s.rot) || 0, start: Number(s.start) || 0, rev: !!s.rev,
      from: s.from === null || s.from === undefined || s.from === "" ? null : Math.max(0, Math.round(Number(s.from))), zone: s.zone ? String(s.zone).slice(0, 40) : null };
    if (!devIds.has(o.dev)) throw new HttpError(400, `Shape "${o.name}" points at a device that doesn't exist`);
    if (s.type === "matrix") { o.cols = Math.max(1, Math.min(256, Math.round(s.cols || 16))); o.rows = Math.max(1, Math.min(256, Math.round(s.rows || 16))); o.count = o.cols * o.rows; }
    if (!(o.count >= 1 && o.count <= 8192)) throw new HttpError(400, `Shape "${o.name}" needs between 1 and 8192 LEDs`);
    for (const k of ["cx", "cy", "size", "w", "h"]) if (s[k] !== undefined) o[k] = Number(s[k]);
    if (s.type === "points") { if (!Array.isArray(s.pts) || !s.pts.length) throw new HttpError(400, `Shape "${o.name}" needs points`); o.count = Math.min(o.count || s.pts.length, s.pts.length); }
    if (s.pts) { if (!Array.isArray(s.pts) || s.pts.length < (s.type === "points" ? 1 : 2)) throw new HttpError(400, `Shape "${o.name}" needs at least two points`); o.pts = s.pts.map(p => [Number(p[0]), Number(p[1])]); }
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
  async function addDevice({ host, name, ddpPort, leds, force, virtual, kind, goveeMode, index, token }) {
    if (virtual) { // a pretend controller: shows in the preview, sends nothing. For trying the app without hardware.
      const dev = { id: env.newId("d"), name: String(name || "Virtual room").slice(0, 60), host: "virtual", ddpPort: 4048, leds: Number(leds) || 600, enabled: true, virtual: true };
      data().devices.push(dev); if (!data().room.shapes.length) data().room.shapes = buildPreset("living", [dev]); else autoPlace(dev);
      runtime.rebuild(); runtime.checkDevice(dev); runtime.note(`Added ${dev.name} (virtual, ${dev.leds} LEDs)`); changed("devices"); return dev;
    }
    host = String(host || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!host) throw new HttpError(400, "Enter the controller's IP address, for example 192.168.1.42");
    if (kind === "hue") { // Philips Hue bridge: pair with the link button, then each colour light is one LED
      if (!env.huePair) throw new HttpError(400, "Hue needs Tempolight running on your network");
      if (data().devices.find(d => d.kind === "hue" && d.host === host)) throw new HttpError(400, "That Hue bridge is already added");
      let user = token, lights;
      try { user ||= await env.huePair(host); lights = await env.hueLights(host, user); } catch (e) { throw new HttpError(400, e.code === "pair" ? e.message : `Couldn't reach a Hue bridge at ${host} (${e.message})`); }
      if (!lights.length) throw new HttpError(400, "That Hue bridge has no lights");
      const dev = { id: env.newId("d"), name: String(name || "Hue lights").slice(0, 60), host, kind: "hue", hue: { user, lights: lights.map(l => l.id), names: lights.map(l => l.name) }, ddpPort: 80, leds: lights.length, enabled: true };
      data().devices.push(dev);
      const y = 1 + (data().room.shapes.length % 7) * 1.1, n = lights.length, pts = lights.map((_, i) => [Math.round((2 + (n > 1 ? i / (n - 1) : 0.5) * 12) * 100) / 100, y]);
      data().room.shapes.push({ type: "points", name: dev.name, count: n, dev: dev.id, rot: 0, start: 0, rev: false, from: null, pts });
      runtime.rebuild(); runtime.checkDevice(dev); runtime.note(`Added ${dev.name} (Hue, ${n} light${n > 1 ? "s" : ""}). Hue updates about 10 lights a second in total, so it suits calm effects best.`); changed("devices"); return dev;
    }
    if (kind === "nanoleaf") { // pair (the power button must have been held), read the panel layout, place the panels where they really are
      if (!env.nanoleafPair) throw new HttpError(400, "Nanoleaf needs Tempolight running on your network");
      if (data().devices.find(d => d.kind === "nanoleaf" && d.host === host)) throw new HttpError(400, "That Nanoleaf is already added");
      let tok = token, info;
      try { tok ||= await env.nanoleafPair(host); info = await env.nanoleafInfo(host, tok); } catch (e) { throw new HttpError(400, e.code === "pair" ? e.message : `Couldn't reach a Nanoleaf at ${host} (${e.message})`); }
      if (!info.panels.length) throw new HttpError(400, "That Nanoleaf has no light panels connected");
      const dev = { id: env.newId("d"), name: String(name || info.name).slice(0, 60), host, kind: "nanoleaf", nanoleaf: { token: tok, panels: info.panels.map(p => p.id) }, ddpPort: Number(ddpPort) || 60222, leds: info.panels.length, enabled: true };
      data().devices.push(dev);
      const k = data().room.shapes.length, pts = env.panelPoints(info.panels, 8 + ((k % 3) - 1) * 4.5, 4.5, 4);
      data().room.shapes.push({ type: "points", name: dev.name, count: pts.length, dev: dev.id, rot: 0, start: 0, rev: false, from: null, pts });
      runtime.rebuild(); runtime.checkDevice(dev); runtime.note(`Added ${dev.name} (Nanoleaf, ${pts.length} panels)`); changed("devices"); return dev;
    }
    if (kind === "openrgb") { // PC lighting through OpenRGB's SDK server: one OpenRGB device = one Tempolight device
      const idx = Math.max(0, Math.round(Number(index) || 0)), port = Number(ddpPort) || 6742, dup = data().devices.find(d => d.kind === "openrgb" && d.host === host && (d.orgbIndex || 0) === idx); if (dup) return dup;
      let n = Number(leds) || 0, nm = name; if (!n && env.listOpenRGB) { try { const c = (await env.listOpenRGB(env.ipOf(host), port)).find(x => x.index === idx); if (c) { n = c.leds; nm ||= c.name; } } catch (e) { if (!force) throw new HttpError(400, `Couldn't reach OpenRGB at ${host}:${port} (${e.message}). In OpenRGB, open the SDK Server tab and press Start server.`); } }
      const dev = { id: env.newId("d"), name: String(nm || "OpenRGB device").slice(0, 60), host, kind: "openrgb", orgbIndex: idx, ddpPort: port, leds: Math.max(1, Math.min(2000, n || 10)), enabled: true };
      data().devices.push(dev); autoPlace(dev); runtime.rebuild(); runtime.checkDevice(dev); runtime.note(`Added ${dev.name} (OpenRGB, ${dev.leds} LEDs)`); changed("devices"); return dev;
    }
    const dup = data().devices.find(d => d.host === host); if (dup) return dup;
    if (kind === "govee") { // Govee LAN: nothing to ask the light; it's a few "LEDs" in the room that all get the light's colour (or its segments)
      const dev = { id: env.newId("d"), name: String(name || "Govee light").slice(0, 60), host, kind: "govee", goveeMode: goveeMode === "segments" ? "segments" : "color", leds: Math.max(1, Math.min(300, Number(leds) || 20)), ddpPort: 4003, enabled: true };
      data().devices.push(dev); autoPlace(dev); runtime.rebuild(); runtime.checkDevice(dev); runtime.note(`Added ${dev.name} (Govee, ${host})`); changed("devices"); return dev;
    }
    let info = null; try { info = await env.getInfo(host, 2500); } catch (e) { if (!force) throw new HttpError(400, `Couldn't reach a WLED controller at ${host} (${e.message}). Check the address, or add it anyway.`); }
    const dev = { id: env.newId("d"), name: String(name || info?.name || host).slice(0, 60), host, ddpPort: Number(ddpPort) || 4048, leds: Number(leds) || info?.leds || 0, enabled: true };
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
    const s = data().settings, before = JSON.stringify({ fps: s.fps, cap: s.capture, osc: s.osc, djlink: s.djlink });
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
    if (b.location !== undefined) { if (b.location === null) s.location = null; else { const lat = Number(b.location.lat), lon = Number(b.location.lon);
      if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) throw new HttpError(400, "Latitude is -90 to 90 and longitude -180 to 180");
      s.location = { lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4, name: String(b.location.name || "").slice(0, 60) }; } }
    if (b.night) { const okT = t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t) || /^(sunrise|sunset)([+-]\d{1,3})?$/.test(t);
      for (const k of ["from", "to"]) if (b.night[k] !== undefined && !okT(b.night[k])) throw new HttpError(400, "Night mode times look like 23:00 or sunset");
      Object.assign(s.night, { enabled: b.night.enabled ?? s.night.enabled, from: b.night.from ?? s.night.from, to: b.night.to ?? s.night.to,
        maxBrightness: b.night.maxBrightness !== undefined ? num(b.night.maxBrightness, 0.02, 1) : s.night.maxBrightness, warm: b.night.warm ?? s.night.warm }); }
    if (b.songMemory !== undefined) s.songMemory = !!b.songMemory;
    if (b.requests !== undefined) s.requests = !!b.requests;
    if (b.shows !== undefined) s.shows = !!b.shows;
    if (b.djlink) Object.assign(s.djlink, { enabled: b.djlink.enabled ?? s.djlink.enabled, port: b.djlink.port !== undefined ? Math.round(num(b.djlink.port, 1024, 65535)) : s.djlink.port });
    if (b.mqtt) { const m = s.mqtt; for (const k of ["url", "username", "prefix", "base"]) if (b.mqtt[k] !== undefined) m[k] = String(b.mqtt[k]).trim().slice(0, 200);
      if (b.mqtt.password) m.password = String(b.mqtt.password).slice(0, 200); if (b.mqtt.clearPassword) m.password = ""; if (b.mqtt.enabled !== undefined) m.enabled = !!b.mqtt.enabled;
      if (m.enabled && !m.url) throw new HttpError(400, "Enter your MQTT broker's address, for example mqtt://192.168.1.10:1883"); }
    if (b.text) { if (b.text.source !== undefined && !["song", "bpm", "clock", "custom"].includes(b.text.source)) throw new HttpError(400, "Text source is song, bpm, clock or custom");
      Object.assign(s.text, { source: b.text.source ?? s.text.source, custom: b.text.custom !== undefined ? String(b.text.custom).slice(0, 80) : s.text.custom }); }
    const after = JSON.stringify({ fps: s.fps, cap: s.capture, osc: s.osc }), prev = JSON.parse(before);
    if (prev.fps !== s.fps) runtime.startLoop();
    if (JSON.stringify(prev.cap) !== JSON.stringify(s.capture)) { if (s.capture.enabled) runtime.startCaptureSource(); else runtime.stopCaptureSource(); }
    if (JSON.stringify(prev.osc) !== JSON.stringify(s.osc)) restartOsc();
    if (JSON.stringify(prev.djlink) !== JSON.stringify(s.djlink)) restartDjLink();
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
    if (b.layer !== undefined) { if (b.layer && !effectIds().has(b.layer.effect)) throw new HttpError(400, `Unknown effect "${b.layer.effect}"`);
      sh.layer = b.layer ? { effect: b.layer.effect, amount: Math.max(0, Math.min(1.5, Number(b.layer.amount ?? 0.6))) } : null; }
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
  let djlink = null;
  function restartDjLink() { if (djlink) { djlink.close(); djlink = null; } const o = data().settings.djlink; if (o && o.enabled && env.startProLink) { djlink = env.startProLink(b => runtime.djBeat(b), { port: o.port }); runtime.note(`Pro DJ Link: listening for CDJ beats on UDP ${o.port}`); } }
  function restartOsc() { if (osc) { osc.close(); osc = null; } const o = data().settings.osc; if (o.enabled) { if (!env.startOsc) return; osc = env.startOsc(o.port, m => { try { oscMessage(m); } catch {} }); runtime.note(`OSC listening on UDP ${o.port}`); } }

  // ---------------------------------------------------------------- API routes
  const routes = [];
  const route = (method, pattern, area, fn) => routes.push({ method, re: new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), area, fn });
  // area: null = open to everyone, "admin" = needs unlock when a PIN is set, or a guest area name (effects, scenes, pads, brightness)

  route("GET", "/api/state", null, () => pub());
  route("GET", "/api/status", null, () => runtime.status());
  route("GET", "/api/health", null, () => ({ ok: true, version: env.version, uptime: env.uptime(), fps: Math.round(runtime.rt.fps), leds: runtime.layout.N }));
  route("GET", "/api/effects", null, () => runtime.effects.list);
  route("GET", "/api/layout", null, () => runtime.layoutInfo());
  route("GET", "/api/update", "admin", () => env.update ? env.update.check() : { method: "demo", canUpdate: false, message: "The online demo is always the latest version." });
  route("POST", "/api/update", "admin", async () => { if (!env.update) throw new HttpError(400, "Nothing to update in the online demo"); try { const r = await env.update.apply(); runtime.note("Updating Tempolight and restarting…"); return r; } catch (e) { throw new HttpError(400, e.message); } });
  route("GET", "/api/songs", null, () => data().songs.map(e => ({ id: e.id, name: e.name, bpm: e.bpm, dur: e.dur, style: e.style, drops: e.drops.length, at: e.at })));
  const songById = id => { const e = data().songs.find(x => x.id === id); if (!e) throw new HttpError(404, "That song isn't remembered"); return e; };
  route("GET", "/api/songs/:id/show", null, (ctx, p) => { const e = songById(p.id); if (!e.show) { e.show = runtime.planFor(e, e.name); store.save(); } return { id: e.id, name: e.name, dur: e.dur, edited: !!e.showEdited, show: e.show || [] }; });
  route("PUT", "/api/songs/:id/show", "effects", (ctx, p) => { const e = songById(p.id), ids = effectIds(), segs = ctx.body.show;
    if (!Array.isArray(segs) || !segs.length || segs.length > 500) throw new HttpError(400, "show is a list of {t0, t1, effect}");
    const clean = segs.map(x => ({ t0: Number(x.t0), t1: Number(x.t1), part: String(x.part || "calm").slice(0, 10), effect: String(x.effect) })).sort((a, b) => a.t0 - b.t0);
    for (const x of clean) { if (!ids.has(x.effect)) throw new HttpError(400, `Unknown effect "${x.effect}"`); if (!(x.t1 > x.t0 && x.t0 >= 0)) throw new HttpError(400, "Each block needs t0 < t1"); }
    e.show = clean; e.showEdited = true; changed("songs"); return { ok: true, show: e.show }; });
  route("DELETE", "/api/songs/:id/show", "effects", (ctx, p) => { const e = songById(p.id); e.show = runtime.planFor(e); e.showEdited = false; changed("songs"); return { ok: true, show: e.show }; });
  route("DELETE", "/api/songs/:id", "admin", (ctx, p) => { if (!runtime.forget(p.id)) throw new HttpError(404, "That song isn't remembered"); changed("songs"); return { ok: true }; });
  // guest song requests
  const reqList = () => data().requests.filter(r => !r.done).sort((a, b) => b.votes - a.votes || a.at - b.at).map(({ id, title, by, votes, at }) => ({ id, title, by, votes, at }));
  const norm = t => String(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  let reqTimes = [];
  route("GET", "/api/requests", null, () => ({ enabled: !!data().settings.requests, requests: reqList() }));
  route("POST", "/api/requests", null, (ctx) => {
    if (!data().settings.requests) throw new HttpError(403, "Song requests are turned off");
    const title = String(ctx.body.title || "").replace(/\s+/g, " ").trim().slice(0, 120), by = String(ctx.body.by || "").replace(/\s+/g, " ").trim().slice(0, 40);
    if (title.length < 2) throw new HttpError(400, "Type a song, for example: Daft Punk – One More Time");
    const now = Date.now(); reqTimes = reqTimes.filter(x => now - x < 60000); if (reqTimes.length >= 30) throw new HttpError(429, "Lots of requests right now. Try again in a minute.");
    reqTimes.push(now);
    const list = data().requests, same = list.find(r => !r.done && norm(r.title) === norm(title));
    if (same) { same.votes++; changed("requests"); return { ...same, merged: true }; }
    const r = { id: env.newId("r"), title, by, votes: 1, at: now, done: false }; list.push(r);
    while (list.length > 200) list.splice(list.findIndex(x => x.done) >= 0 ? list.findIndex(x => x.done) : 0, 1);
    runtime.note(`Song request: ${title}${by ? ` (from ${by})` : ""}`); changed("requests"); return r;
  });
  route("POST", "/api/requests/:id/vote", null, (ctx, p) => { const r = data().requests.find(x => x.id === p.id && !x.done); if (!r) throw new HttpError(404, "That request is gone"); r.votes++; changed("requests"); return r; });
  route("PATCH", "/api/requests/:id", "admin", (ctx, p) => { const r = data().requests.find(x => x.id === p.id); if (!r) throw new HttpError(404, "No such request"); if (ctx.body.done !== undefined) r.done = !!ctx.body.done; changed("requests"); return r; });
  route("DELETE", "/api/requests/:id", "admin", (ctx, p) => { const l = data().requests, i = l.findIndex(x => x.id === p.id); if (i < 0) throw new HttpError(404, "No such request"); l.splice(i, 1); changed("requests"); return { ok: true }; });
  route("DELETE", "/api/requests", "admin", () => { data().requests = []; changed("requests"); return { ok: true }; });
  route("POST", "/api/map", "admin", (ctx) => { const b = ctx.body; if (b.end) runtime.mapLight(null); else { if (!data().devices.some(d => d.id === b.device)) throw new HttpError(404, "No such device"); runtime.mapLight(b.device, b.led ?? -1, b.level); } return { ok: true }; });
  // your own effects, made from parts
  const PATTERNS = ["wave", "chase", "pulse", "sparkle", "fill", "breathe", "gradient"], AXES = ["along", "x", "y", "around", "centre"], DRIVES = ["beat", "kick", "bass", "loud", "time"];
  function cleanCustom(b, id) {
    const pick = (v, list, def) => list.includes(v) ? v : def, num = (v, lo, hi, def) => v === undefined || v === null || v === "" ? def : Math.max(lo, Math.min(hi, Number(v) || def));
    const hexOk = c => /^#[0-9a-f]{6}$/i.test(c);
    if (!b || !PATTERNS.includes(b.pattern)) throw new HttpError(400, `Pattern is one of: ${PATTERNS.join(", ")}`);
    const colors = Array.isArray(b.colors) ? (b.colors.length === 2 && b.colors.every(hexOk) ? b.colors.map(c => c.toLowerCase()) : (() => { throw new HttpError(400, "Colours are two like #ff0066"); })()) : "palette";
    return { id, name: String(b.name || "My effect").trim().slice(0, 40) || "My effect", tag: pick(b.tag, ["calm", "build", "drop", "home"], "drop"), pattern: b.pattern, axis: pick(b.axis, AXES, "along"),
      drive: pick(b.drive, DRIVES, "beat"), colors, speed: num(b.speed, 0.1, 8, 1), width: num(b.width, 0.01, 1, 0.15), bg: num(b.bg, 0, 0.5, 0.05), cycles: num(b.cycles, 0.25, 8, 1) };
  }
  route("GET", "/api/custom-effects", null, () => data().customEffects);
  route("POST", "/api/custom-effects", "effects", (ctx) => { const l = data().customEffects; if (l.length >= 100) throw new HttpError(400, "That's 100 of your own effects already: delete some first");
    const e = cleanCustom(ctx.body, "u-" + env.newId("")); l.push(e); runtime.rebuild(); runtime.note(`New effect: ${e.name}`); changed("effects"); return e; });
  route("PUT", "/api/custom-effects/:id", "effects", (ctx, p) => { const l = data().customEffects, i = l.findIndex(e => e.id === p.id); if (i < 0) throw new HttpError(404, "No such effect");
    l[i] = cleanCustom(ctx.body, p.id); runtime.rebuild(); changed("effects"); return l[i]; });
  route("DELETE", "/api/custom-effects/:id", "effects", (ctx, p) => { const l = data().customEffects, i = l.findIndex(e => e.id === p.id); if (i < 0) throw new HttpError(404, "No such effect");
    l.splice(i, 1); if (data().show.effect === p.id) { data().show.effect = "shock"; data().show.mode = "auto"; } runtime.rebuild(); changed("effects"); return { ok: true }; });
  route("GET", "/api/network", null, () => ({ addresses: env.lan ? env.lan() : [] })); // for the phone QR code
  route("GET", "/api/log", null, () => runtime.log.slice(-100));

  // like or ban an effect for automatic mode, and its settings: speed, intensity, hue (degrees), saturation, mirror
  route("PATCH", "/api/effects/:id", "effects", async (ctx, p) => {
    if (!effectIds().has(p.id)) throw new HttpError(404, `Unknown effect "${p.id}"`);
    const b = ctx.body, prefs = data().settings.effectPrefs, sh = data().show; sh.params = sh.params || {};
    if (b.pref !== undefined) { const v = Number(b.pref); if (v === 1 || v === -1) prefs[p.id] = v; else delete prefs[p.id]; }
    if (b.params === null) delete sh.params[p.id];
    else if (b.params) { const n = (v, lo, hi, d) => v === undefined ? d : Math.max(lo, Math.min(hi, Number(v)));
      const cur = sh.params[p.id] || {}, q = { speed: n(b.params.speed, 0.1, 4, cur.speed ?? 1), intensity: n(b.params.intensity, 0, 3, cur.intensity ?? 1),
        hue: n(b.params.hue, -180, 180, cur.hue ?? 0), saturation: n(b.params.saturation, 0, 2, cur.saturation ?? 1), mirror: b.params.mirror !== undefined ? !!b.params.mirror : !!cur.mirror };
      if (q.speed === 1 && q.intensity === 1 && q.hue === 0 && q.saturation === 1 && !q.mirror) delete sh.params[p.id]; else sh.params[p.id] = q; }
    runtime.syncDirector(); changed("show"); return { id: p.id, pref: prefs[p.id] || 0, params: sh.params[p.id] || null };
  });
  route("PUT", "/api/zones", "effects", async (ctx) => {
    const list = ctx.body.zones; if (!Array.isArray(list)) throw new HttpError(400, "zones must be a list");
    const zones = list.slice(0, 32).map((z, i) => { const mode = ["follow", "effect", "ambient", "off"].includes(z.mode) ? z.mode : "follow";
      if (mode === "effect" && !effectIds().has(z.effect)) throw new HttpError(400, `Zone "${z.name}": pick an effect`);
      return { id: String(z.id || `z${i + 1}`).slice(0, 40), name: String(z.name || `Zone ${i + 1}`).slice(0, 40), mode, effect: z.effect || null, brightness: Math.max(0, Math.min(1, Number(z.brightness ?? 1))) }; });
    data().room.zones = zones; runtime.syncDirector(); changed("zones"); return zones;
  });
  route("PATCH", "/api/show", "effects", async (ctx) => { applyShow(ctx.body); return data().show; });
  route("POST", "/api/power", "brightness", async (ctx) => { const b = ctx.body; await runtime.setPower(b.on ?? !data().show.power); changed("show"); return data().show; });
  route("POST", "/api/brightness", "brightness", async (ctx) => { const b = ctx.body; applySettings({ brightness: b.value }); return { brightness: data().settings.brightness }; });
  route("POST", "/api/action", "pads", async (ctx) => runtime.action(ctx.body));
  route("PATCH", "/api/settings", "admin", async (ctx) => { applySettings(ctx.body); return pub().settings; });

  // devices
  const safeDev = x => x.nanoleaf ? { ...x, nanoleaf: { panels: x.nanoleaf.panels } } : x.hue ? { ...x, hue: { lights: x.hue.lights, names: x.hue.names } } : x; // Nanoleaf tokens and Hue user names stay on the server
  route("GET", "/api/devices", null, () => data().devices.map(d => ({ ...safeDev(d), health: runtime.health.get(d.id) || null })));
  route("POST", "/api/devices", "admin", async (ctx) => safeDev(await addDevice(ctx.body)));
  route("PATCH", "/api/devices/:id", "admin", async (ctx, p) => {
    const d = data().devices.find(x => x.id === p.id); if (!d) throw new HttpError(404, "No such device"); const b = ctx.body;
    if (b.name !== undefined) d.name = String(b.name).slice(0, 60); if (b.host !== undefined) d.host = String(b.host).trim(); if (b.ddpPort !== undefined) d.ddpPort = Number(b.ddpPort) || 4048;
    if (b.leds !== undefined) d.leds = Math.max(0, Math.round(Number(b.leds))); if (b.enabled !== undefined) d.enabled = !!b.enabled;
    if (b.protocol !== undefined) { if (!["ddp", "e131", "artnet"].includes(b.protocol)) throw new HttpError(400, "Protocol is ddp, e131 or artnet"); d.protocol = b.protocol; }
    if (b.universe !== undefined) d.universe = b.universe === null || b.universe === "" ? undefined : Math.max(0, Math.min(63999, Math.round(Number(b.universe))));
    if (b.goveeMode !== undefined && d.kind === "govee") d.goveeMode = b.goveeMode === "segments" ? "segments" : "color";
    if (b.goveeSegments !== undefined && d.kind === "govee") d.goveeSegments = b.goveeSegments ? Math.max(1, Math.min(60, Math.round(Number(b.goveeSegments)))) : undefined;
    if (b.maxAmps !== undefined) d.maxAmps = Math.max(0, Math.min(500, Number(b.maxAmps) || 0)); if (b.mAperLed !== undefined) d.mAperLed = Math.max(5, Math.min(200, Number(b.mAperLed) || 60));
    runtime.rebuild(); changed("devices"); return d;
  });
  route("DELETE", "/api/devices/:id", "admin", (ctx, p) => {
    const i = data().devices.findIndex(x => x.id === p.id); if (i < 0) throw new HttpError(404, "No such device");
    const [d] = data().devices.splice(i, 1); data().room.shapes = data().room.shapes.filter(s => s.dev !== d.id); runtime.rebuild(); runtime.note(`Removed ${d.name}`); changed("devices"); return { ok: true };
  });
  route("POST", "/api/devices/:id/identify", null, (ctx, p) => { runtime.identify({ device: p.id }); return { ok: true }; });
  route("POST", "/api/devices/:id/segments", "admin", async (ctx, p) => ({ segments: await runtime.syncSegments(p.id) }));
  route("POST", "/api/devices/:id/check", null, async (ctx, p) => { const d = data().devices.find(x => x.id === p.id); if (!d) throw new HttpError(404, "No such device"); return runtime.checkDevice(d); });
  route("POST", "/api/discover", "admin", async (ctx) => {
    const b = ctx.body, [found, govee] = await Promise.all([env.discoverWled({ scan: b.scan !== false, timeoutMs: 2500, extraHosts: (b.hosts || []).map(String) }),
      env.discoverGovee ? env.discoverGovee({ timeoutMs: 2500 }).catch(() => []) : []]);
    let orgb = []; if (env.listOpenRGB) orgb = await Promise.race([env.listOpenRGB("127.0.0.1").catch(() => []), new Promise(r => setTimeout(() => r([]), 1500))]); // OpenRGB on this computer
    const haveOrgb = new Set(data().devices.filter(d => d.kind === "openrgb").map(d => d.orgbIndex || 0));
    const known = new Set(data().devices.map(d => env.ipOf(d.host)));
    return [...found.map(f => ({ ...f, added: known.has(f.ip) })), ...govee.map(g => ({ ...g, ip: g.host, kind: "govee", leds: 0, added: known.has(g.host) })),
      ...orgb.map(c => ({ host: "127.0.0.1", ip: "127.0.0.1", name: c.name, leds: c.leds, kind: "openrgb", index: c.index, added: haveOrgb.has(c.index) }))];
  });

  // room
  route("GET", "/api/room", null, () => data().room);
  route("PUT", "/api/room", "admin", async (ctx) => {
    const b = ctx.body, ids = new Set(data().devices.map(d => d.id));
    if (!Array.isArray(b.shapes)) throw new HttpError(400, "shapes must be a list");
    const shapes = b.shapes.map(s => cleanShape(s, ids));
    data().room = { name: String(b.name || data().room.name || "My room").slice(0, 60), shapes, zones: data().room.zones || [] }; runtime.rebuild(); changed("room"); return data().room;
  });
  route("POST", "/api/room/preset", "admin", async (ctx) => {
    const b = ctx.body; if (!ROOM_PRESETS[b.id]) throw new HttpError(400, `Unknown preset "${b.id}"`);
    if (!data().devices.length) throw new HttpError(400, "Add a WLED controller first, then pick a room layout");
    data().room.shapes = buildPreset(b.id, data().devices.filter(d => d.enabled)); runtime.rebuild(); runtime.note(`Room layout: ${ROOM_PRESETS[b.id].name}`); changed("room"); return data().room;
  });
  route("POST", "/api/room/identify", null, async (ctx) => { const b = ctx.body; runtime.identify({ shape: b.shape }); return { ok: true }; });

  // scenes
  route("GET", "/api/scenes", null, () => data().scenes);
  route("POST", "/api/scenes", "scenes", async (ctx) => {
    const b = ctx.body, sh = data().show;
    const sc = { id: env.newId("s"), name: String(b.name || "New scene").slice(0, 60), show: b.show || { mode: sh.mode, effect: sh.effect, style: sh.style, palette: sh.palette, everyBeats: sh.everyBeats, speed: sh.speed, params: JSON.parse(JSON.stringify(sh.params || {})), layer: sh.layer || null }, brightness: b.brightness ?? data().settings.brightness };
    data().scenes.push(sc); changed("scenes"); return sc;
  });
  route("PUT", "/api/scenes/:id", "scenes", async (ctx, p) => { const sc = data().scenes.find(s => s.id === p.id); if (!sc) throw new HttpError(404, "No such scene"); const b = ctx.body;
    if (b.name !== undefined) sc.name = String(b.name).slice(0, 60); if (b.show) sc.show = b.show; if (b.brightness !== undefined) sc.brightness = Number(b.brightness); changed("scenes"); return sc; });
  route("DELETE", "/api/scenes/:id", "scenes", (ctx, p) => { data().scenes = data().scenes.filter(s => s.id !== p.id); changed("scenes"); return { ok: true }; });
  route("POST", "/api/scenes/:id/apply", "scenes", (ctx, p) => { const sc = data().scenes.find(s => s.id === p.id); if (!sc) throw new HttpError(404, "No such scene"); applyScene(sc); return data().show; });

  // schedules
  const cleanSchedule = (b, old = {}) => {
    const s = { ...old, name: String(b.name ?? old.name ?? "Schedule").slice(0, 60), time: String(b.time ?? old.time ?? "18:00"), days: (b.days ?? old.days ?? [0, 1, 2, 3, 4, 5, 6]).map(Number).filter(d => d >= 0 && d <= 6),
      action: b.action ?? old.action ?? { type: "on" }, enabled: b.enabled ?? old.enabled ?? true };
    const sun = /^(sunrise|sunset)([+-]\d{1,3})?$/.test(s.time);
    if (!sun && !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) throw new HttpError(400, "Time must look like 18:30, sunset or sunrise-15");
    if (sun && !data().settings.location) throw new HttpError(400, "Set your location in Settings first, so Tempolight knows when the sun rises and sets");
    if (!["scene", "on", "off", "brightness"].includes(s.action.type)) throw new HttpError(400, "Action must be scene, on, off or brightness");
    if (s.action.type === "scene" && !data().scenes.some(x => x.id === s.action.scene)) throw new HttpError(400, "Pick a scene for this schedule");
    return s;
  };
  route("GET", "/api/schedules", null, () => pub().schedules);
  route("POST", "/api/schedules", "admin", async (ctx) => { const s = { id: env.newId("t"), ...cleanSchedule(ctx.body) }; data().schedules.push(s); changed("schedules"); return s; });
  route("PUT", "/api/schedules/:id", "admin", async (ctx, p) => { const i = data().schedules.findIndex(s => s.id === p.id); if (i < 0) throw new HttpError(404, "No such schedule"); data().schedules[i] = cleanSchedule(ctx.body, data().schedules[i]); changed("schedules"); return data().schedules[i]; });
  route("DELETE", "/api/schedules/:id", "admin", (ctx, p) => { data().schedules = data().schedules.filter(s => s.id !== p.id); changed("schedules"); return { ok: true }; });
  route("POST", "/api/schedules/:id/run", "admin", (ctx, p) => { const s = data().schedules.find(x => x.id === p.id); if (!s) throw new HttpError(404, "No such schedule"); runSchedule(s); return { ok: true }; });

  // music
  route("POST", "/api/song", null, async (ctx) => { const b = ctx.body; if (!b.analysis || !(b.analysis.bpm > 0)) throw new HttpError(400, "Send the song's analysis"); runtime.setSong(b, b.clientId || null); return { ok: true }; });
  route("POST", "/api/song/clock", null, async (ctx) => { runtime.songClock(ctx.body); return { ok: true }; });
  route("DELETE", "/api/song", null, () => { runtime.clearSong(); return { ok: true }; });
  route("GET", "/api/audio/sources", null, () => env.listSources().map(({ id, label }) => ({ id, label })));

  // lock
  route("POST", "/api/lock", "admin", async (ctx) => { const b = ctx.body; if (!/^\d{4,8}$/.test(String(b.pin || ""))) throw new HttpError(400, "The PIN must be 4 to 8 digits");
    data().lock = env.hashPin(b.pin); tokens.clear(); const tok = env.randomToken(); tokens.set(tok, Date.now() + 12 * 3600_000); runtime.note("Settings locked with a PIN"); changed("lock"); return { locked: true, token: tok }; });
  route("POST", "/api/unlock", null, async (ctx) => { const b = ctx.body; await new Promise(r => setTimeout(r, 300)); // slow down guessing
    if (!env.checkPin(data().lock, b.pin)) throw new HttpError(403, "Wrong PIN"); const tok = env.randomToken(); tokens.set(tok, Date.now() + 12 * 3600_000); return { token: tok }; });
  route("DELETE", "/api/lock", "admin", () => { data().lock = null; tokens.clear(); runtime.note("PIN lock removed"); changed("lock"); return { locked: false }; });
  route("GET", "/api/backup", "admin", () => { const d = JSON.parse(JSON.stringify(data())); delete d.lock; return { tempolight: env.version, savedAt: new Date().toISOString(), data: d }; });
  route("POST", "/api/restore", "admin", (ctx) => {
    const d = ctx.body.data || ctx.body; if (!d || !Array.isArray(d.devices) || !d.room || !Array.isArray(d.room.shapes)) throw new HttpError(400, "That doesn't look like a Tempolight backup");
    const lock = data().lock, fresh = merge(DEFAULTS(), d); fresh.lock = lock; // keep the current PIN
    for (const k of Object.keys(data())) delete data()[k]; Object.assign(data(), fresh);
    runtime.rebuild(); runtime.note(`Restored a backup: ${d.devices.length} devices, ${d.room.shapes.length} shapes, ${(d.scenes || []).length} scenes`); changed("all"); return { ok: true };
  });
  route("POST", "/api/reset", "admin", () => { store.reset(); runtime.rebuild(); changed("all"); return { ok: true }; });

  // ---------------------------------------------------------------- live connections: status, preview, browser audio, song clock
  const clients = new Set();
  /** A browser connected (WebSocket in the app, a pretend socket in the demo). client: {send(string|Uint8Array), sendJSON(o), busy, open, data} */
  function connect(c, query = {}) {
    clients.add(c); c.data.id = env.newId("c"); const tok = query.token;
    c.data.auth = area => !locked() || (area && data().settings.guest[area]) || (tok && tokens.get(tok) > Date.now());
    setTimeout(() => c.open && c.sendJSON({ ...runtime.status(), type: "hello", id: c.data.id }), 10); // not in the same packet as the handshake
    return {
      /** @param {string|Int16Array} msg text, or 16-bit samples */
      message(msg, binary) {
        if (binary) { if (c.data.audio) runtime.pushPcm(msg, "browser", c.data.audio.label, c.data.id, c.data.audio.rate); return; }
        let m; try { m = JSON.parse(msg); } catch { return; }
        if (m.type === "preview") { if (m.on) runtime.previewClients.add(c); else runtime.previewClients.delete(c); }
        else if (m.type === "screen" && typeof m.px === "string") { if (c.data.auth("effects")) { try { const b = atob(m.px), px = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) px[i] = b.charCodeAt(i);
          runtime.setScreen(Number(m.w) | 0, Number(m.h) | 0, px, String(m.label || "").slice(0, 80)); } catch {} } }
        else if (m.type === "map") { if (c.data.auth(null)) runtime.mapLight(m.end ? null : String(m.device), m.led ?? -1, m.level); } // camera mapping (admin)
        else if (m.type === "phone") { if (m.on) { if (!runtime.phones.has(c)) { runtime.phones.add(c); runtime.note(`A phone joined as a light (${runtime.phones.size} now)`); } } else runtime.phones.delete(c); }
        else if (m.type === "audio-start") { c.data.audio = { rate: Number(m.rate) || 22050, label: String(m.label || "Browser audio").slice(0, 80) }; }
        else if (m.type === "audio-stop") { c.data.audio = null; runtime.stopLive(c.data.id); }
        else if (m.type === "clock") runtime.songClock(m, null);
        else if (m.type === "action" && m.action) { if (c.data.auth("pads")) { try { runtime.action(m.action); } catch {} } }
      },
      close() { clients.delete(c); runtime.previewClients.delete(c); runtime.phones.delete(c); runtime.stopLive(c.data.id); runtime.clearSong(c.data.id); },
    };
  }
  function broadcast(o) { const s = JSON.stringify(o); for (const c of clients) if (c.open && !c.busy) c.send(s); }
  const statusTimer = setInterval(() => { if (clients.size) broadcast(runtime.status()); }, 250);
  runtime.listeners.add(e => broadcast({ type: "log", ...e }));

  // ---------------------------------------------------------------- background jobs
  const sched = startScheduler(() => data().schedules, runSchedule, env.now, () => data().settings.location);
  restartOsc(); restartDjLink();
  async function firstRunDiscovery() {
    if (env.discover === false || !data().settings.autoDiscover || data().devices.length) return;
    runtime.note("Looking for WLED controllers on your network…");
    try {
      const found = await env.discoverWled({ scan: true, timeoutMs: 2500 });
      for (const f of found) await addDevice({ host: f.host, name: f.name, leds: f.leds, force: true });
      runtime.note(found.length ? `Found ${found.length} WLED controller${found.length > 1 ? "s" : ""}` : "No WLED controllers found yet. Add one by IP address on the Devices page.");
    } catch (e) { runtime.note(`Discovery failed: ${e.message}`, "warn"); }
  }
  const discovery = firstRunDiscovery();

  /** Run one API call. ctx: {headers, query, body}. Throws HttpError with .code for 4xx answers. */
  async function handle(method, pathname, ctx = {}) {
    for (const r of routes) { if (r.method !== method) continue; const m = r.re.exec(pathname); if (!m) continue;
      if (r.area) need(ctx, r.area === "admin" ? null : r.area);
      return await r.fn({ headers: {}, query: {}, body: {}, ...ctx }, m.groups || {}); }
    throw new HttpError(404, `No API route ${method} ${pathname}`);
  }

  return { handle, connect, broadcast, discovery, onChange: f => changeListeners.add(f), applyScene, applyShow, applySettings, addDevice, pub,
    close() { clearInterval(statusTimer); sched.stop(); osc && osc.close(); djlink && djlink.close(); for (const c of clients) c.close?.(); } };
}
