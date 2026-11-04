// LIFX bulbs, strips and beams through the LIFX LAN protocol (UDP 56700, little-endian binary messages).
// Each message is a 36-byte header (frame, frame address, protocol header) and a payload:
//   GetService (2) -> StateService (3)                discovery, broadcast with the "tagged" bit set
//   GetLabel (23) -> StateLabel (25), GetVersion (32) -> StateVersion (33)
//   SetColor (102)                                    one HSBK colour for the whole light
//   SetLightPower (117)                               on / off
//   GetExtendedColorZones (511) -> StateExtendedColorZones (512), SetExtendedColorZones (510)
//                                                     strips and beams: up to 82 zones per message (firmware 2.77+)
// LIFX asks for at most 20 messages a second per device, so lights update 20 times a second (10 for a strip with more
// than 82 zones, which takes two messages). Tiles and candles (the "matrix" messages) get one colour for now.
import dgram from "node:dgram";
import { hostPort, rgbToHsv, zoneColours, sameColours, broadcastTargets } from "./lightutil.js";

export const LIFX_PORT = 56700;
export const LIFX = { GetService: 2, StateService: 3, GetPower: 20, StatePower: 22, GetLabel: 23, StateLabel: 25, GetVersion: 32, StateVersion: 33, Acknowledgement: 45,
  SetColor: 102, SetLightPower: 117, SetExtendedColorZones: 510, GetExtendedColorZones: 511, StateExtendedColorZones: 512 };
export const LIFX_ZONES_PER_MSG = 82;
const KELVIN = 3500;

/**
 * One LIFX message.
 * @param {number} type @param {Buffer} payload @param {{target?:string|null, source?:number, seq?:number, res?:boolean, ack?:boolean}} o
 *   target: the light's MAC ("d073d5001234"); without it the message is "tagged" (for every light that gets it)
 */
export function lifxPacket(type, payload = Buffer.alloc(0), { target = null, source = 0x54454d50, seq = 0, res = false, ack = false } = {}) {
  const b = Buffer.alloc(36 + payload.length);
  b.writeUInt16LE(b.length, 0);
  b.writeUInt16LE(1024 | 0x1000 | (target ? 0 : 0x2000), 2); // protocol 1024, addressable, tagged when there's no target
  b.writeUInt32LE(source >>> 0, 4);
  if (target) Buffer.from(String(target).replace(/[^0-9a-f]/gi, "").padEnd(12, "0").slice(0, 12), "hex").copy(b, 8);
  b[22] = (res ? 1 : 0) | (ack ? 2 : 0); b[23] = seq & 255;
  b.writeUInt16LE(type, 32);
  payload.copy(b, 36);
  return b;
}
/** Parse a message: {type, source, target (MAC hex), seq, payload} or null. */
export function lifxParse(b) {
  if (b.length < 36 || b.readUInt16LE(0) !== b.length || (b.readUInt16LE(2) & 0xfff) !== 1024) return null;
  return { type: b.readUInt16LE(32), source: b.readUInt32LE(4), target: b.subarray(8, 14).toString("hex"), seq: b[23], payload: b.subarray(36) };
}

/** sRGB 0-255 -> LIFX HSBK (each 0-65535, kelvin) */
export function rgbToHsbk(r, g, b) { const c = rgbToHsv(r, g, b); return [Math.round(c.h / 360 * 65535) & 0xffff, Math.round(c.s * 65535), Math.round(c.v * 65535), KELVIN]; }
const writeHsbk = (buf, o, [h, s, v, k]) => { buf.writeUInt16LE(h, o); buf.writeUInt16LE(s, o + 2); buf.writeUInt16LE(v, o + 4); buf.writeUInt16LE(k, o + 6); };

export function setColorPayload(r, g, b, durationMs = 0) { const p = Buffer.alloc(13); writeHsbk(p, 1, rgbToHsbk(r, g, b)); p.writeUInt32LE(durationMs, 9); return p; }
export function setPowerPayload(on, durationMs = 0) { const p = Buffer.alloc(6); p.writeUInt16LE(on ? 65535 : 0, 0); p.writeUInt32LE(durationMs, 2); return p; }
/** SetExtendedColorZones payloads for `rgb` (one colour per zone): one per 82 zones, the last one applies them all. */
export function extendedZonesPayloads(rgb) {
  const n = Math.floor(rgb.length / 3), out = [];
  for (let start = 0; start < n; start += LIFX_ZONES_PER_MSG) {
    const k = Math.min(LIFX_ZONES_PER_MSG, n - start), p = Buffer.alloc(8 + LIFX_ZONES_PER_MSG * 8);
    p.writeUInt32LE(0, 0); p[4] = start + k >= n ? 1 : 0; p.writeUInt16LE(start, 5); p[7] = k; // duration, apply (1 on the last), zone index, colours count
    for (let i = 0; i < k; i++) writeHsbk(p, 8 + i * 8, rgbToHsbk(rgb[(start + i) * 3], rgb[(start + i) * 3 + 1], rgb[(start + i) * 3 + 2]));
    out.push(p);
  }
  return out;
}

/**
 * Ask one light (or, with `broadcast`, every light) some questions and collect the answers by message type.
 * @returns {Promise<Map<string, {ip, port, target, msgs: Map<number, object>}>>} keyed by the light's MAC
 */
function lifxAsk(targets, types, { timeoutMs = 1500, broadcast = false, done = () => false, port = 0 } = {}) {
  return new Promise(resolve => {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true }), source = (Math.random() * 0xfffffff0 >>> 0) + 2, lights = new Map();
    let rep = null, timer = null;
    const finish = () => { clearTimeout(timer); clearInterval(rep); try { sock.close(); } catch {} resolve(lights); };
    sock.on("error", finish);
    sock.on("message", (b, r) => { const m = lifxParse(b); if (!m || m.source !== source) return;
      let l = lights.get(m.target); if (!l) lights.set(m.target, l = { ip: r.address, port: r.port, target: m.target, msgs: new Map() });
      if (m.type === LIFX.StateService && m.payload[0] === 1) l.port = m.payload.readUInt32LE(1) || l.port;
      if (!l.msgs.has(m.type)) l.msgs.set(m.type, m.payload);
      if (done(lights)) finish(); });
    const send = () => { for (const [ip, p] of targets) for (const t of types) try { sock.send(lifxPacket(t, Buffer.alloc(0), { source, res: true }), p, ip); } catch {} };
    sock.bind(port, () => { if (broadcast) try { sock.setBroadcast(true); } catch {} send(); rep = setInterval(send, Math.max(250, timeoutMs / 3)); }); // UDP: ask again in case a packet was lost
    timer = setTimeout(finish, timeoutMs);
  });
}
const labelOf = p => p ? p.subarray(0, 32).toString("utf8").replace(/\0.*$/s, "").trim() : "";

/** What a light is: {mac, name, vendor, product, zones (1 for a bulb), extended (multizone messages work)}. Throws when nothing answers. */
export async function lifxInfo(host, { timeoutMs = 1500 } = {}) {
  const [ip, port] = hostPort(host, LIFX_PORT);
  const lights = await lifxAsk([[ip, port]], [LIFX.GetLabel, LIFX.GetVersion, LIFX.GetExtendedColorZones], { timeoutMs,
    done: m => [...m.values()].some(l => l.msgs.has(LIFX.StateLabel) && l.msgs.has(LIFX.StateVersion) && l.msgs.has(LIFX.StateExtendedColorZones)) });
  const l = [...lights.values()].find(x => x.msgs.has(LIFX.StateVersion) || x.msgs.has(LIFX.StateLabel));
  if (!l) throw new Error("no LIFX light answered");
  const v = l.msgs.get(LIFX.StateVersion), z = l.msgs.get(LIFX.StateExtendedColorZones); // a bulb doesn't answer GetExtendedColorZones
  return { mac: l.target, name: labelOf(l.msgs.get(LIFX.StateLabel)) || "LIFX light", vendor: v ? v.readUInt32LE(0) : 0, product: v ? v.readUInt32LE(4) : 0,
    zones: z ? Math.max(1, z.readUInt16LE(0)) : 1, extended: !!z };
}

/** Find LIFX lights: broadcast GetService (and GetLabel for their names). [{host, mac, name}] */
export async function discoverLifx({ timeoutMs = 2000, targets = null } = {}) {
  const to = targets || (await broadcastTargets()).map(ip => [ip, LIFX_PORT]);
  const lights = await lifxAsk(to, [LIFX.GetService, LIFX.GetLabel], { timeoutMs, broadcast: !targets });
  return [...lights.values()].filter(l => l.msgs.has(LIFX.StateService) || l.msgs.has(LIFX.StateLabel))
    .map(l => ({ host: l.port && l.port !== LIFX_PORT ? `${l.ip}:${l.port}` : l.ip, mac: l.target, name: labelOf(l.msgs.get(LIFX.StateLabel)) || "LIFX light" }));
}

export class LifxSender {
  /** @param {string} host ip or ip:port @param {{mac?:string, zones?:number, extended?:boolean, fps?:number}} o */
  constructor(host, o = {}) {
    [this.ip, this.port] = hostPort(host, LIFX_PORT); this.mac = o.mac || null; this.zones = o.extended ? Math.max(1, o.zones || 1) : 1;
    const msgs = Math.ceil(this.zones / LIFX_ZONES_PER_MSG); this.minGap = 1000 / Math.min(o.fps || 20, 20 / msgs); // 20 messages a second per light
    this.last = 0; this.prev = null; this.sent = 0; this.seq = 0; this.source = (Math.random() * 0xfffffff0 >>> 0) + 2;
    this.sock = dgram.createSocket("udp4"); this.sock.on("error", () => {}); this.sock.unref?.();
  }
  _send(type, payload) { try { this.sock.send(lifxPacket(type, payload, { target: this.mac, source: this.source, seq: this.seq = (this.seq + 1) & 255 }), this.port, this.ip); } catch {} }
  send(rgb) {
    const now = Date.now(); if (now - this.last < this.minGap || rgb.length < 3) return;
    const c = zoneColours(rgb, this.zones);
    if (sameColours(c, this.prev) && now - this.last < 1000) return; // the same again: once a second is enough (in case a packet was lost)
    this.prev = c; this.last = now; this.sent++;
    if (this.zones > 1) for (const p of extendedZonesPayloads(c)) this._send(LIFX.SetExtendedColorZones, p);
    else this._send(LIFX.SetColor, setColorPayload(c[0], c[1], c[2]));
  }
  power(on) { this.prev = null; this._send(LIFX.SetLightPower, setPowerPayload(on)); }
  close() { setTimeout(() => { try { this.sock.close(); } catch {} }, 20); }
}
