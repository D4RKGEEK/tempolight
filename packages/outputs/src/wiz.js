// Philips WiZ (and other WiZ Connected) lights over their local UDP JSON API on port 38899. No pairing: "Allow local
// communication" must be on in the WiZ app (it is by default). Messages are one JSON object per datagram:
//   {"method":"registration","params":{...,"register":false}}  broadcast discovery; every light answers with its MAC
//   {"method":"getSystemConfig","params":{}}                   module name, firmware, MAC (health check)
//   {"method":"setPilot","params":{"state":true,"r":..,"g":..,"b":..,"dimming":10-100}}  colour
//   {"method":"setPilot","params":{"state":false}}             off
// One colour per light. WiZ lights take about 10 commands a second before they start to lag, so colours go out at
// most 10 times a second, only when they change. Brightness below WiZ's minimum dimming (10 %) is sent as off.
import dgram from "node:dgram";
import { hostPort, udpExchange, broadcastTargets } from "./lightutil.js";

export const WIZ_PORT = 38899;
const msg = (method, params = {}) => Buffer.from(JSON.stringify({ id: 1, method, params }));
const parse = b => { try { return JSON.parse(b.toString()); } catch { return null; } };

/** setPilot params for an sRGB colour: full-scale r, g, b and the brightness as dimming, or off when nearly black. */
export function wizPilot(r, g, b) {
  const mx = Math.max(r, g, b); if (mx < 8) return { state: false };
  const k = 255 / mx; return { state: true, r: Math.round(r * k), g: Math.round(g * k), b: Math.round(b * k), dimming: Math.max(10, Math.min(100, Math.round(mx / 255 * 100))) };
}

/** Ask one light something; resolves with its result object, rejects when it doesn't answer. */
export async function wizCall(host, method, params = {}, { timeoutMs = 1500 } = {}) {
  const [ip, port] = hostPort(host, WIZ_PORT); let res = null;
  await udpExchange({ to: [ip, port], packets: msg(method, params), timeoutMs, repeatMs: 500, onMessage: b => { const j = parse(b); if (j && j.method === method) { res = j; return true; } } });
  if (!res) throw new Error("no WiZ light answered");
  if (res.error) throw new Error(res.error.message || "the light refused the command");
  return res.result || {};
}
/** {mac, module, version, name} */
export async function wizInfo(host, o) { const r = await wizCall(host, "getSystemConfig", {}, o); return { mac: r.mac || "", module: r.moduleName || "", version: r.fwVersion || "", name: `WiZ ${r.moduleName || "light"}`.trim() }; }

/** Find WiZ lights with a registration broadcast. [{host, mac, name}] */
export async function discoverWiz({ timeoutMs = 2000, targets = null } = {}) {
  const to = targets || (await broadcastTargets()).map(ip => [ip, WIZ_PORT]), found = new Map();
  const q = msg("registration", { phoneMac: "AAAAAAAAAAAA", register: false, phoneIp: "1.2.3.4", id: "1" });
  await udpExchange({ to, packets: q, timeoutMs, broadcast: !targets, repeatMs: 700, onMessage: (b, r) => { const j = parse(b);
    const host = r.port !== WIZ_PORT ? `${r.address}:${r.port}` : r.address; if (j && j.method === "registration" && j.result) found.set(host, { host, mac: j.result.mac || "", name: "WiZ light" }); } });
  return [...found.values()];
}

export class WizSender {
  /** @param {string} host ip or ip:port @param {{fps?:number}} o */
  constructor(host, o = {}) {
    [this.ip, this.port] = hostPort(host, WIZ_PORT); this.minGap = 1000 / (o.fps || 10); this.last = 0; this.prev = null; this.sent = 0;
    this.sock = dgram.createSocket("udp4"); this.sock.on("error", () => {}); this.sock.unref?.();
  }
  _send(p) { try { this.sock.send(msg("setPilot", p), this.port, this.ip); this.sent++; } catch {} }
  send(rgb) {
    const now = Date.now(); if (now - this.last < this.minGap || rgb.length < 3) return;
    const n = rgb.length / 3; let r = 0, g = 0, b = 0; for (let i = 0; i < n; i++) { r += rgb[i * 3]; g += rgb[i * 3 + 1]; b += rgb[i * 3 + 2]; }
    const p = wizPilot(r / n, g / n, b / n), key = JSON.stringify(p);
    // nothing changed (or only a little): don't flood the light, but repeat once a second in case a datagram was lost
    if (this.prev && now - this.last < 1000 && (key === this.prev.key || (p.state && this.prev.p.state && ["r", "g", "b"].every(k => Math.abs(p[k] - this.prev.p[k]) < 4) && Math.abs(p.dimming - this.prev.p.dimming) < 3))) return;
    this.prev = { key, p }; this.last = now; this._send(p);
  }
  power(on) { this.prev = null; this._send({ state: !!on }); }
  close() { setTimeout(() => { try { this.sock.close(); } catch {} }, 20); }
}
