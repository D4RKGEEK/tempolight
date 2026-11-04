// OpenRGB: PC lighting (RAM, motherboard, fans, keyboards, mice, GPUs) through the OpenRGB SDK server
// (OpenRGB → SDK Server tab → Start server; TCP port 6742). Tempolight asks for the list of devices, puts the chosen
// one in direct ("custom") mode and streams its LED colours. Uses SDK protocol version 0, which every OpenRGB speaks.
import net from "node:net";

export const OPENRGB_PORT = 6742;
const ID = { COUNT: 0, DATA: 1, NAME: 50, UPDATE: 1050, CUSTOM: 1100 };
function header(dev, id, size) { const h = Buffer.alloc(16); h.write("ORGB", 0, "ascii"); h.writeUInt32LE(dev, 4); h.writeUInt32LE(id, 8); h.writeUInt32LE(size, 12); return h; }
export const orgbPacket = (dev, id, data = Buffer.alloc(0)) => Buffer.concat([header(dev, id, data.length), data]);

/** Parse controller data (protocol 0): {type, name, description, leds, zones: [{name, leds}]}. */
export function parseController(b) {
  let o = 4; const u16 = () => { const v = b.readUInt16LE(o); o += 2; return v; }, u32 = () => { const v = b.readUInt32LE(o); o += 4; return v; };
  const str = () => { const n = u16(), s = b.toString("utf8", o, o + Math.max(0, n - 1)); o += n; return s; };
  const type = b.readInt32LE(o); o += 4; const name = str(), description = str(); str(); str(); str(); // version, serial, location
  const nModes = u16(); o += 4; // active mode
  for (let m = 0; m < nModes; m++) { str(); o += 4 * 9; const nc = u16(); o += nc * 4; }
  const nZones = u16(), zones = [];
  for (let z = 0; z < nZones; z++) { const zn = str(); o += 4 * 3; const count = u32(), ml = u16(); o += ml; zones.push({ name: zn, leds: count }); }
  const nLeds = u16();
  return { type, name, description, leds: nLeds, zones };
}

/** One TCP connection to an OpenRGB server, shared by every device on it. Answers come back in order. */
class Connection {
  constructor(host, port) {
    this.host = host; this.port = port; this.waiting = []; this.buf = Buffer.alloc(0); this.ready = this.open();
  }
  open() {
    return new Promise((res, rej) => {
      const s = this.sock = net.connect(this.port, this.host); s.setNoDelay(true); s.unref(); // never keeps Tempolight (or a test) running by itself
      const fail = e => { this.dead = true; this.deadAt ||= Date.now(); for (const w of this.waiting.splice(0)) { clearTimeout(w.timer); w.rej(e); } rej(e); };
      s.once("connect", () => { this.connected = true; s.write(orgbPacket(0, ID.NAME, Buffer.from("Tempolight\0"))); res(); });
      s.on("error", fail); s.on("close", () => fail(new Error("OpenRGB closed the connection")));
      s.on("data", d => { this.buf = Buffer.concat([this.buf, d]);
        while (this.buf.length >= 16) { const size = this.buf.readUInt32LE(12); if (this.buf.length < 16 + size) break;
          const dev = this.buf.readUInt32LE(4), id = this.buf.readUInt32LE(8), body = this.buf.subarray(16, 16 + size); this.buf = this.buf.subarray(16 + size);
          const i = this.waiting.findIndex(w => w.id === id && (id === ID.COUNT || w.dev === dev)); if (i >= 0) { const w = this.waiting.splice(i, 1)[0]; clearTimeout(w.timer); w.res(body); } } });
      // a computer that's off doesn't refuse the connection, it just never answers: give up after 4 s instead of the OS's minute or two
      s.setTimeout(4000, () => { if (!this.connected) s.destroy(new Error("OpenRGB didn't answer")); });
    });
  }
  async ask(dev, id) { await this.ready; if (this.dead) throw new Error("OpenRGB closed the connection");
    return new Promise((res, rej) => { // the idle timeout can't catch a server that stops answering while LED updates keep the socket busy
      const w = { id, dev, res, rej, timer: setTimeout(() => this.sock.destroy(new Error("OpenRGB didn't answer")), 5000) }; w.timer.unref?.();
      this.waiting.push(w); this.sock.write(orgbPacket(dev, id)); }); }
  async send(dev, id, data) { await this.ready; if (!this.dead) this.sock.write(orgbPacket(dev, id, data)); }
  close() { try { this.sock.destroy(); } catch {} }
}
const pool = new Map();
// reconnect when the connection dropped, but while streaming not more than every 3 s
function conn(host, port = OPENRGB_PORT, retry = true) { const k = `${host}:${port}`; let c = pool.get(k);
  if (!c || (c.dead && (retry || Date.now() - c.deadAt > 3000))) { c = new Connection(host, port); pool.set(k, c); c.ready.catch(() => {}); } return c; }

/** The devices an OpenRGB server knows: [{index, name, description, leds, zones}]. Health checks for several devices on one
 * server share one listing (asked at most every 3 s), so they don't fetch every controller's data again and again. */
const lists = new Map();
export function listOpenRGB(host = "127.0.0.1", port = OPENRGB_PORT) {
  const k = `${host}:${port}`, hit = lists.get(k); if (hit && Date.now() - hit.at < 3000) return hit.p;
  const p = (async () => { const c = conn(host, port), n = (await c.ask(0, ID.COUNT)).readUInt32LE(0), out = [];
    for (let i = 0; i < n; i++) out.push({ index: i, ...parseController(await c.ask(i, ID.DATA)) });
    return out; })();
  lists.set(k, { at: Date.now(), p }); p.catch(() => lists.delete(k)); return p;
}

export class OpenRGBSender {
  /** @param {string} host @param {{port?:number, index?:number, leds?:number, fps?:number}} o
   * leds: the device's LED count in OpenRGB, which ignores an update with more colours than the device has, so we send exactly that many. */
  constructor(host, o = {}) { this.host = host; this.port = o.port || OPENRGB_PORT; this.index = o.index || 0; this.leds = o.leds || 0; this.minGap = 1000 / (o.fps || 40); this.last = 0; this.custom = false; this.sent = 0;
    const k = `${host}:${this.port}`; users.set(k, (users.get(k) || 0) + 1); this.key = k; }
  /** @param {Uint8Array} rgb */
  send(rgb) {
    const now = Date.now(); if (now - this.last < this.minGap) return; this.last = now;
    const c = conn(this.host, this.port, false); if (c !== this.c) { this.c = c; this.custom = false; } if (c.dead) return;
    if (!this.custom) { this.custom = true; c.send(this.index, ID.CUSTOM, Buffer.alloc(0)).catch(() => { this.custom = false; }); }
    const n = Math.min(65535, this.leds || rgb.length / 3), d = Buffer.alloc(6 + n * 4); d.writeUInt32LE(d.length, 0); d.writeUInt16LE(n, 4);
    for (let i = 0; i < n && i * 3 < rgb.length; i++) { d[6 + i * 4] = rgb[i * 3]; d[7 + i * 4] = rgb[i * 3 + 1]; d[8 + i * 4] = rgb[i * 3 + 2]; } // missing LEDs stay black
    c.send(this.index, ID.UPDATE, d).then(() => this.sent++).catch(() => {});
  }
  /** The last device on a server closes the shared connection (deleting a device, or the app stopping). */
  close() { if (this.closed) return; this.closed = true; const n = (users.get(this.key) || 1) - 1;
    if (n > 0) users.set(this.key, n); else { users.delete(this.key); pool.get(this.key)?.close(); pool.delete(this.key); } }
}
const users = new Map(); // host:port -> senders using its connection
export function closeOpenRGB() { for (const c of pool.values()) c.close(); pool.clear(); lists.clear(); }
