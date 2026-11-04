// TP-Link Kasa smart bulbs (KL/LB series) and light strips (KL400/KL420/KL430) through the legacy local protocol on
// port 9999: JSON, "encrypted" with TP-Link's XOR autokey (key 171, each byte XORed with the previous cipher byte).
// Over TCP each message has a 4-byte big-endian length in front; over UDP it doesn't.
//   {"system":{"get_sysinfo":{}}}                                         discovery (UDP broadcast) and health
//   {"smartlife.iot.smartbulb.lightingservice":{"transition_light_state":{on_off, hue, saturation, brightness, color_temp: 0, transition_period: 0}}}
//   {"smartlife.iot.lightStrip":{"set_light_state":{on_off, hue, saturation, brightness, color_temp: 0, transition: 0}}}  strips
// Strips can take a colour per zone with `groups: [[first, last, hue, saturation, brightness, 0], ...]` in
// set_light_state. That form comes from people reading the Kasa app's traffic and is not documented: it is behind
// the "zones" option (off by default) until someone confirms it on a real KL430.
// Colours go out over UDP at most 10 times a second, only when they change.
// Tapo lights (and Kasa devices on new firmware) use TP-Link's KLAP or "securePassthrough" protocols instead, which
// need the TP-Link cloud account's e-mail and password: those aren't supported.
import net from "node:net";
import dgram from "node:dgram";
import { hostPort, rgbToHsv, zoneColours, sameColours, udpExchange, broadcastTargets } from "./lightutil.js";

export const KASA_PORT = 9999;

export function kasaEncrypt(text) { const p = Buffer.from(text), out = Buffer.alloc(p.length); let k = 171; for (let i = 0; i < p.length; i++) { k ^= p[i]; out[i] = k; } return out; }
export function kasaDecrypt(b) { const out = Buffer.alloc(b.length); let k = 171; for (let i = 0; i < b.length; i++) { out[i] = k ^ b[i]; k = b[i]; } return out.toString(); }
/** TCP framing: the length, then the encrypted JSON */
export const kasaFrame = obj => { const e = kasaEncrypt(JSON.stringify(obj)), h = Buffer.alloc(4); h.writeUInt32BE(e.length); return Buffer.concat([h, e]); };

/** One request over TCP; resolves with the parsed answer. */
export function kasaQuery(host, obj, { timeoutMs = 2500 } = {}) {
  const [ip, port] = hostPort(host, KASA_PORT);
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: ip, port }); let buf = Buffer.alloc(0), done = false;
    const end = (e, v) => { if (done) return; done = true; clearTimeout(t); s.destroy(); e ? reject(e) : resolve(v); };
    const t = setTimeout(() => end(new Error("timed out")), timeoutMs);
    s.on("connect", () => s.write(kasaFrame(obj)));
    s.on("data", d => { buf = Buffer.concat([buf, d]); if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) { try { end(null, JSON.parse(kasaDecrypt(buf.subarray(4, 4 + buf.readUInt32BE(0))))); } catch (e) { end(e); } } });
    s.on("error", e => end(e)); s.on("close", () => end(new Error("closed")));
  });
}

const isLight = si => !!si && (si.light_state || /SMARTBULB/i.test(si.mic_type || si.type || "") || "length" in si);
/** What the device is: {name, model, mac, strip, zones, color}. Throws when it isn't a Kasa light. */
export async function kasaInfo(host, o) {
  const r = await kasaQuery(host, { system: { get_sysinfo: {} } }, o), si = r?.system?.get_sysinfo;
  if (!si) throw new Error("that isn't a Kasa device");
  if (!isLight(si)) throw new Error(`that Kasa device (${si.model || "?"}) isn't a light`);
  const strip = "length" in si || /^KL4/i.test(si.model || "");
  return { name: si.alias || si.dev_name || "Kasa light", model: si.model || "", mac: si.mic_mac || si.mac || "", strip, zones: strip ? Math.max(1, Number(si.length) || 1) : 1, color: si.is_color !== 0, version: si.sw_ver || "" };
}

/** Find Kasa lights: get_sysinfo broadcast over UDP. [{host, name, model, strip, zones}] */
export async function discoverKasa({ timeoutMs = 2000, targets = null } = {}) {
  const to = targets || (await broadcastTargets()).map(ip => [ip, KASA_PORT]), found = new Map();
  await udpExchange({ to, packets: kasaEncrypt(JSON.stringify({ system: { get_sysinfo: {} } })), timeoutMs, broadcast: !targets, repeatMs: 700, onMessage: (b, r) => {
    let si; try { si = JSON.parse(kasaDecrypt(b))?.system?.get_sysinfo; } catch { return; } if (!isLight(si)) return;
    const strip = "length" in si || /^KL4/i.test(si.model || "");
    const host = r.port !== KASA_PORT ? `${r.address}:${r.port}` : r.address;
    found.set(host, { host, name: si.alias || "Kasa light", model: si.model || "", strip, zones: strip ? Math.max(1, Number(si.length) || 1) : 1 }); } });
  return [...found.values()];
}

const hsb = (r, g, b) => { const c = rgbToHsv(r, g, b); return { hue: Math.round(c.h) % 360, saturation: Math.round(c.s * 100), brightness: Math.max(1, Math.round(c.v * 100)) }; };
/** The command for one colour (or, for a strip with zones, one colour per zone). */
export function kasaCommand(rgb, { strip = false, zones = 1, color = true } = {}) {
  const n = Math.floor(rgb.length / 3); if (!n) return null;
  if (strip && zones > 1 && n > 1) { // [[first, last, hue, saturation, brightness, colour temperature]], neighbours with the same colour merged
    const groups = []; for (let z = 0; z < n; z++) { const c = hsb(rgb[z * 3], rgb[z * 3 + 1], rgb[z * 3 + 2]); if (Math.max(rgb[z * 3], rgb[z * 3 + 1], rgb[z * 3 + 2]) < 3) c.brightness = 0;
      const g = groups.at(-1); if (g && g[2] === c.hue && g[3] === c.saturation && g[4] === c.brightness) g[1] = z; else groups.push([z, z, c.hue, c.saturation, c.brightness, 0]); }
    return { "smartlife.iot.lightStrip": { set_light_state: { groups, transition: 0 } } };
  }
  let r = 0, g = 0, b = 0; for (let i = 0; i < n; i++) { r += rgb[i * 3]; g += rgb[i * 3 + 1]; b += rgb[i * 3 + 2]; } r /= n; g /= n; b /= n;
  const off = Math.max(r, g, b) < 3, c = hsb(r, g, b), state = off ? { on_off: 0 } : color ? { on_off: 1, ...c, color_temp: 0 } : { on_off: 1, brightness: c.brightness };
  return strip ? { "smartlife.iot.lightStrip": { set_light_state: { ...state, transition: 0 } } }
    : { "smartlife.iot.smartbulb.lightingservice": { transition_light_state: { ignore_default: 1, transition_period: 0, ...state } } };
}

export class KasaSender {
  /** @param {string} host @param {{strip?:boolean, zones?:number, perZone?:boolean, color?:boolean, fps?:number}} o perZone: send one colour per strip zone (experimental) */
  constructor(host, o = {}) {
    [this.ip, this.port] = hostPort(host, KASA_PORT); this.strip = !!o.strip; this.zones = this.strip && o.perZone ? Math.max(1, o.zones || 1) : 1; this.color = o.color !== false;
    this.minGap = 1000 / (o.fps || 10); this.last = 0; this.prev = null; this.sent = 0;
    this.sock = dgram.createSocket("udp4"); this.sock.on("error", () => {}); this.sock.unref?.();
  }
  _send(obj) { try { this.sock.send(kasaEncrypt(JSON.stringify(obj)), this.port, this.ip); this.sent++; } catch {} }
  send(rgb) {
    const now = Date.now(); if (now - this.last < this.minGap || rgb.length < 3) return;
    const c = zoneColours(rgb, this.zones); if (sameColours(c, this.prev, 4) && now - this.last < 1000) return;
    this.prev = c; this.last = now; const cmd = kasaCommand(c, { strip: this.strip, zones: this.zones, color: this.color }); if (cmd) this._send(cmd);
  }
  power(on) { this.prev = null; const s = { on_off: on ? 1 : 0 };
    this._send(this.strip ? { "smartlife.iot.lightStrip": { set_light_state: { ...s, transition: 0 } } } : { "smartlife.iot.smartbulb.lightingservice": { transition_light_state: { ...s, transition_period: 0 } } }); }
  close() { setTimeout(() => { try { this.sock.close(); } catch {} }, 20); }
}
