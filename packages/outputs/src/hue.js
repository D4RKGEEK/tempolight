// Philips Hue through the bridge's local REST API (basic mode). Pairing: press the round link button on the bridge,
// then add it within 30 seconds. Each Hue light is one "LED" in the room.
// The bridge takes about 10 light commands a second in total, so lights update in turn, only when their colour
// changes, with a short fade. That suits calm effects and slow colour changes, not fast strobes. Hue's fast
// Entertainment streaming needs DTLS, which Node.js doesn't include, so it isn't used.
import http from "node:http";

function req(host, method, path, body, timeout = 4000) {
  return new Promise((res, rej) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body)), [h, p] = String(host).split(":");
    const r = http.request({ host: h, port: Number(p) || 80, method, path, timeout, headers: data ? { "content-type": "application/json", "content-length": data.length } : {} }, resp => {
      const c = []; resp.on("data", d => c.push(d)); resp.on("end", () => { try { res(JSON.parse(Buffer.concat(c).toString() || "null")); } catch { res(null); } }); });
    r.on("timeout", () => r.destroy(new Error("timed out"))); r.on("error", rej); if (data) r.write(data); r.end();
  });
}

/** Get a user name from the bridge. Throws {code: "pair"} until the link button has been pressed. */
export async function huePair(host) {
  const r = await req(host, "POST", "/api", { devicetype: "tempolight#server" }), a = Array.isArray(r) ? r[0] : null;
  if (a?.success?.username) return a.success.username;
  if (a?.error?.type === 101) throw Object.assign(new Error("Press the round link button on the Hue bridge, then press Add again within 30 seconds."), { code: "pair" });
  throw new Error(a?.error?.description || "That doesn't look like a Hue bridge");
}
/** Colour lights on the bridge: [{id, name}] */
export async function hueLights(host, user) {
  const r = await req(host, "GET", `/api/${user}/lights`);
  if (Array.isArray(r) && r[0]?.error) throw new Error(r[0].error.description || "The bridge refused the user name: pair it again");
  return Object.entries(r || {}).filter(([, l]) => l?.state && ("xy" in l.state || "hue" in l.state || "bri" in l.state)).map(([id, l]) => ({ id, name: l.name, color: "xy" in l.state }));
}

/** sRGB 0-255 to Hue's {xy, bri}. */
export function rgbToXy(r, g, b) {
  const lin = v => { v /= 255; return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92; }, R = lin(r), G = lin(g), B = lin(b);
  const X = R * 0.664511 + G * 0.154324 + B * 0.162028, Y = R * 0.283881 + G * 0.668433 + B * 0.047685, Z = R * 0.000088 + G * 0.07231 + B * 0.986039, S = X + Y + Z;
  return { xy: S > 0 ? [Math.round(X / S * 1e4) / 1e4, Math.round(Y / S * 1e4) / 1e4] : [0.3227, 0.329], bri: Math.round(Math.max(r, g, b) / 255 * 254) };
}

// One budget per bridge, shared by every HueSender that talks to it: the bridge's ~10 commands a second are for all its lights.
const bridges = new Map();
const bridgeOf = (host, rate) => { const k = String(host).includes(":") ? String(host) : `${host}:80`; let b = bridges.get(k);
  if (!b) bridges.set(k, b = { last: 0, busy: 0, gap: 1000 / (rate || 10), lastBy: null, waiting: new Map(), queue: [], timer: null }); return b; };
function pump(b) { // queued commands (power off) go out one per gap, ahead of the colour stream
  if (b.timer || !b.queue.length) return;
  const go = () => { b.timer = null; const f = b.queue.shift(); if (f) { b.last = Date.now(); f(); } if (b.queue.length) { b.timer = setTimeout(go, b.gap); b.timer.unref?.(); } };
  const wait = Math.max(0, b.gap - (Date.now() - b.last)); b.timer = setTimeout(go, wait); b.timer.unref?.();
}

export class HueSender {
  /** @param {string} host bridge ip @param {{user:string, lights:string[], color?:boolean[], rate?:number}} o color[i] false: a white-only light (no xy) */
  constructor(host, o) { this.host = host; this.user = o.user; this.lights = o.lights || []; this.color = o.color || []; this.b = bridgeOf(host, o.rate); this.turn = 0; this.prev = new Map(); this.sent = 0; }
  send(rgb) {
    const b = this.b, now = Date.now(); if (!this.lights.length || this.closed) return;
    // the light whose colour is furthest from what it shows now goes next
    let best = -1, bestD = 6; for (let k = 0; k < this.lights.length; k++) { const i = (this.turn + k) % this.lights.length; if (i * 3 + 2 >= rgb.length) continue; // a light with no LEDs in the room
      const p = this.prev.get(i), r = rgb[i * 3], g = rgb[i * 3 + 1], bl = rgb[i * 3 + 2];
      const d = p ? Math.abs(p[0] - r) + Math.abs(p[1] - g) + Math.abs(p[2] - bl) : 999; if (d > bestD) { bestD = d; best = i; } }
    if (best < 0) { b.waiting.delete(this); return; }
    if (now - b.last < b.gap || b.busy > 2 || b.queue.length) { b.waiting.set(this, now); return; }
    if (b.lastBy === this && [...b.waiting].some(([x, t]) => x !== this && now - t < 500)) return; // another device on this bridge is waiting: its turn
    b.last = now; b.lastBy = this; b.waiting.delete(this); this.turn = best + 1;
    const r = rgb[best * 3], g = rgb[best * 3 + 1], bl = rgb[best * 3 + 2], c = rgbToXy(r, g, bl); this.prev.set(best, [r, g, bl]);
    const body = c.bri < 2 ? { on: false, transitiontime: 1 } : this.color[best] === false ? { on: true, bri: c.bri, transitiontime: 1 } : { on: true, bri: c.bri, xy: c.xy, transitiontime: 1 };
    // when the bridge can't be reached, forget what the light shows so it gets its colour again once the bridge is back
    b.busy++; req(this.host, "PUT", `/api/${this.user}/lights/${this.lights[best]}/state`, body, 2000).then(() => this.sent++, () => this.prev.delete(best)).finally(() => b.busy--);
  }
  power(on) {
    this.prev.clear(); if (on) return;
    for (const id of this.lights) this.b.queue.push(() => { this.b.busy++; req(this.host, "PUT", `/api/${this.user}/lights/${id}/state`, { on: false }, 2000).catch(() => {}).finally(() => this.b.busy--); });
    pump(this.b);
  }
  close() { this.closed = true; this.b.waiting.delete(this); if (this.b.lastBy === this) this.b.lastBy = null; }
}
