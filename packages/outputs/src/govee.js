// Govee lights on the local network (experimental). Turn on "LAN Control" for the light in the Govee Home app first.
// Govee's LAN API: discovery by multicast to 239.255.255.250:4001, answers on port 4002, commands to the light on 4003.
// Two ways to drive a light:
//   "color"    one colour for the whole light, using the documented colorwc command (about 10 updates a second)
//   "segments" one colour per segment, using the "razer" streaming mode that Govee's DreamView/Razer sync uses.
//              Not documented by Govee and not supported by every model; that's why this is experimental.
import dgram from "node:dgram";

export const GOVEE_SCAN_PORT = 4001, GOVEE_LISTEN_PORT = 4002, GOVEE_CMD_PORT = 4003, GOVEE_GROUP = "239.255.255.250";
const msg = (cmd, data) => Buffer.from(JSON.stringify({ msg: { cmd, data } }));

/** A "razer" packet: 0xBB, 0x00, length, 0xB0, 0x01, count, then R G B for each segment, then an XOR checksum. */
export function goveeRazerPacket(colours) {
  const n = colours.length / 3, b = [0xbb, 0x00, n * 3 + 2, 0xb0, 0x01, n, ...colours];
  let x = 0; for (const v of b) x ^= v; b.push(x); return Buffer.from(b).toString("base64");
}
export const goveeRazerOn = on => { const b = [0xbb, 0x00, 0x01, 0xb1, on ? 1 : 0]; let x = 0; for (const v of b) x ^= v; b.push(x); return Buffer.from(b).toString("base64"); };

export class GoveeSender {
  /** @param {string} ip @param {{mode?:"color"|"segments", segments?:number, port?:number, fps?:number}} o */
  constructor(ip, o = {}) {
    this.ip = ip; this.mode = o.mode || "color"; this.segments = Math.max(1, o.segments || 1); this.port = o.port || GOVEE_CMD_PORT;
    this.minGap = 1000 / (o.fps || (this.mode === "segments" ? 25 : 10)); this.last = 0; this.prev = null; this.sent = 0; this.razer = false;
    this.sock = dgram.createSocket("udp4"); this.sock.on("error", () => {}); this.sock.unref?.();
  }
  _send(buf) { try { this.sock.send(buf, this.port, this.ip); this.sent++; } catch {} }
  /** @param {Uint8Array} rgb the device's LEDs, R G B each */
  send(rgb) {
    const now = Date.now(); if (now - this.last < this.minGap) return; const n = rgb.length / 3; if (!n) return;
    const segs = this.mode === "segments" ? this.segments : 1, out = new Array(segs * 3).fill(0);
    for (let s = 0; s < segs; s++) { const a = Math.floor(s * n / segs), b = Math.max(a + 1, Math.floor((s + 1) * n / segs)); let r = 0, g = 0, bl = 0;
      for (let i = a; i < b; i++) { r += rgb[i * 3]; g += rgb[i * 3 + 1]; bl += rgb[i * 3 + 2]; } out[s * 3] = Math.round(r / (b - a)); out[s * 3 + 1] = Math.round(g / (b - a)); out[s * 3 + 2] = Math.round(bl / (b - a)); }
    if (this.prev && out.every((v, i) => Math.abs(v - this.prev[i]) < 3) && now - this.last < 1000) return; // nothing changed: don't flood the light
    this.prev = out; this.last = now;
    if (this.mode === "segments") { if (!this.razer) { this._send(msg("razer", { pt: goveeRazerOn(true) })); this.razer = true; } this._send(msg("razer", { pt: goveeRazerPacket(out) })); }
    else this._send(msg("colorwc", { color: { r: out[0], g: out[1], b: out[2] }, colorTemInKelvin: 0 }));
  }
  power(on) { this._send(msg("turn", { value: on ? 1 : 0 })); }
  close() { if (this.razer) this._send(msg("razer", { pt: goveeRazerOn(false) })); setTimeout(() => { try { this.sock.close(); } catch {} }, 50); }
}

/** Find Govee lights with LAN control turned on. Returns [{host, sku, device, name}]. */
export function discoverGovee({ timeoutMs = 2000, port = GOVEE_LISTEN_PORT, scanPort = GOVEE_SCAN_PORT, group = GOVEE_GROUP } = {}) {
  return new Promise(resolve => {
    const found = new Map(), sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const done = () => { try { sock.close(); } catch {} resolve([...found.values()]); };
    sock.on("error", done);
    sock.on("message", (b, r) => { try { const m = JSON.parse(b.toString()).msg; if (m?.cmd !== "scan") return; const d = m.data || {};
      found.set(d.ip || r.address, { host: d.ip || r.address, sku: d.sku || "", device: d.device || "", name: `Govee ${d.sku || "light"}`.trim() }); } catch {} });
    sock.bind(port, () => { try { sock.setBroadcast(true); sock.setMulticastTTL(2); } catch {}
      const q = msg("scan", { account_topic: "reserve" }); sock.send(q, scanPort, group); setTimeout(() => { try { sock.send(q, scanPort, group); } catch {} }, 600); });
    setTimeout(done, timeoutMs);
  });
}
