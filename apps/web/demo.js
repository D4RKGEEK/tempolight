// Demo mode: the real Tempolight core and runtime running inside the browser, with pretend WLED controllers instead
// of a network. Used for the online demo (Cloudflare) and for trying the app without installing anything.
// Everything a visitor changes is kept in this browser only (localStorage).
import { createCore, HttpError } from "/packages/server/src/core.js";
import { createRuntime } from "/packages/server/src/runtime.js";
import { DEFAULTS, merge } from "/packages/server/src/defaults.js";

const KEY = "tempolight.demo.v1";
const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

// ---------------------------------------------------------------- pretend WLED controllers on a pretend network
export const FAKE_WLED = {
  "192.168.1.42": { name: "Living room", leds: 300 },
  "192.168.1.43": { name: "Desk", leds: 144 },
  "192.168.1.44": { name: "Ceiling", leds: 240 },
};
for (const d of Object.values(FAKE_WLED)) Object.assign(d, { frames: 0, segments: [], on: true });
const ipOf = host => String(host).replace(/:\d+$/, "");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lookup = async host => { await sleep(120 + Math.random() * 200); const d = FAKE_WLED[ipOf(host)]; if (!d) throw new Error("no answer (this demo only has pretend controllers: " + Object.keys(FAKE_WLED).join(", ") + ")"); return d; };
const io = {
  RATE: 22050,
  DDPSender: class { constructor(ip) { this.ip = ip; this.sent = 0; } send() { this.sent++; const d = FAKE_WLED[this.ip]; if (d) d.frames++; } close() {} },
  AudioSyncSender: class { send() {} close() {} },
  ipOf,
  async getInfo(host) { const d = await lookup(host); return { name: d.name, leds: d.leds, version: "0.15.0", arch: "esp32", rssi: -52, signal: 88, fps: 60, live: true }; },
  async setState(host, st) { const d = await lookup(host); if (st.on !== undefined) d.on = !!st.on; return { success: true }; },
  async setSegments(host, segs) { const d = await lookup(host); d.segments = segs; return { success: true }; },
  async discoverWled() { await sleep(900); return Object.entries(FAKE_WLED).map(([ip, d]) => ({ ip, host: ip, name: d.name, leds: d.leds, version: "0.15.0", via: "mdns" })); },
  listSources: () => [],
  startCapture() { throw new Error("Not available in the demo"); },
  splitCommand: s => String(s).split(/\s+/),
};

// ---------------------------------------------------------------- settings kept in this browser
function createBrowserStore() {
  const saved = safe(() => JSON.parse(localStorage.getItem(KEY) || "null"), null);
  let data = saved ? merge(DEFAULTS(), saved) : DEFAULTS(), timer = null;
  const flush = () => { clearTimeout(timer); timer = null; safe(() => localStorage.setItem(KEY, JSON.stringify(data))); };
  return { get data() { return data; }, firstRun: !saved, save() { if (!timer) timer = setTimeout(flush, 300); }, flush,
    reset() { data = DEFAULTS(); safe(() => localStorage.removeItem(KEY)); } };
}
// a light hash, enough for a demo PIN (the real server uses scrypt)
function hashPin(pin, salt = Math.random().toString(36).slice(2)) { let h = 2166136261; for (const ch of salt + ":" + pin) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return { salt, hash: h.toString(16) }; }
const checkPin = (lock, pin) => !lock || hashPin(String(pin ?? ""), lock.salt).hash === lock.hash;
const randomHex = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, "0")).join("");

const store = createBrowserStore();
const runtime = createRuntime(store, { io, logger: null });
const core = createCore({ store, runtime, env: {
  version: (document.querySelector('meta[name="tempolight-version"]')?.content || "demo"), newId: (p = "") => p + randomHex(4), randomToken: () => randomHex(16),
  hashPin, checkPin, getInfo: io.getInfo, discoverWled: io.discoverWled, ipOf, listSources: io.listSources, uptime: () => performance.now() / 1000, discover: true } });
addEventListener("pagehide", () => store.flush());

// phones as lights in the demo: the phone page, open in another tab of this browser, joins over a BroadcastChannel
if (typeof BroadcastChannel !== "undefined") {
  const ch = new BroadcastChannel("tempolight-phones"), seen = new Map();
  ch.onmessage = e => { const m = e.data || {};
    if (m.type === "join") { let c = seen.get(m.id); if (!c) { c = { open: true, busy: false, send: a => ch.postMessage({ to: m.id, c: [a[1], a[2], a[3]] }) }; seen.set(m.id, c); runtime.phones.add(c); runtime.note("A phone joined as a light"); } c.at = Date.now(); }
    else if (m.type === "leave") { const c = seen.get(m.id); if (c) { runtime.phones.delete(c); seen.delete(m.id); } } };
  setInterval(() => { for (const [id, c] of seen) if (Date.now() - c.at > 6000) { runtime.phones.delete(c); seen.delete(id); } }, 2000);
}

// first visit: the pretend controllers are "found" on the network; lay them out as a living room so there's something to see
export const ready = (async () => {
  await core.discovery;
  if (store.firstRun && store.data.devices.length && !store.data.__demoRoom) {
    try { await core.handle("POST", "/api/room/preset", { body: { id: "living" } }); store.data.__demoRoom = true; store.save(); } catch {}
  }
})();

/** Same contract as fetch()-ing the real server's API. */
export async function api(method, path, body, token) {
  const u = new URL(path, location.origin);
  try {
    const r = await core.handle(method, u.pathname, { headers: token ? { "x-tempolight-token": token } : {}, query: Object.fromEntries(u.searchParams), body: body ?? {} });
    return r === undefined ? r : JSON.parse(JSON.stringify(r));
  } catch (e) { const err = new Error(e.message || String(e)); err.status = e instanceof HttpError ? e.code : 500; throw err; }
}

/** A stand-in for WebSocket that talks to the in-browser core. */
export class FakeSocket {
  constructor(url) {
    this.readyState = 0; this.bufferedAmount = 0; this.binaryType = "arraybuffer";
    const query = Object.fromEntries(new URL(url, location.origin).searchParams), self = this;
    this.client = { open: true, busy: false, data: {},
      send(x) { if (self.readyState !== 1) return; const data = typeof x === "string" ? x : x.slice().buffer; queueMicrotask(() => self.onmessage && self.onmessage({ data })); },
      sendJSON(o) { this.send(JSON.stringify(o)); },
      close() { self.close(); } };
    setTimeout(() => { this.readyState = 1; this.h = core.connect(this.client, query); this.onopen && this.onopen(); }, 0);
  }
  send(d) { if (this.readyState !== 1) return; if (typeof d === "string") this.h.message(d, false); else this.h.message(new Int16Array(d.slice ? d.slice(0) : d), true); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.client.open = false; this.h && this.h.close(); setTimeout(() => this.onclose && this.onclose(), 0); }
}
