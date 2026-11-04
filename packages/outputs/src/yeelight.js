// Yeelight bulbs and strips through Yeelight's LAN control (turn on "LAN Control" for the light in the Yeelight app).
//   discovery  SSDP-like: "M-SEARCH * HTTP/1.1 ... ST: wifi_bulb" to 239.255.255.250:1982; each light answers with
//              headers (Location: yeelight://ip:55443, id, model, name, support, power, bright, rgb...)
//   commands   TCP 55443, one JSON object per line: {"id":1,"method":"set_scene","params":["color",rgb,bright]}\r\n
//              The light allows about 60 commands a minute on this connection, so it's only used to set up:
//   music mode {"method":"set_music","params":[1, our ip, our port]} makes the light connect back to a TCP server of
//              ours; commands on that connection have no limit and no answers. Colours go out up to 20 times a
//              second, only when they change. If music mode can't start (a firewall blocks the light connecting
//              back), Tempolight falls back to one colour a second on the normal connection and tries again later.
import net from "node:net";
import dgram from "node:dgram";
import { hostPort, localAddressFor, sameColours } from "./lightutil.js";

export const YEELIGHT_PORT = 55443, YEELIGHT_SSDP_PORT = 1982, YEELIGHT_GROUP = "239.255.255.250";
const line = (id, method, params) => JSON.stringify({ id, method, params }) + "\r\n";

/** set_scene / set_power for an sRGB colour (Yeelight: rgb 1-0xFFFFFF at brightness 1-100, so the colour is sent full scale) */
export function yeelightColour(r, g, b) {
  const mx = Math.max(r, g, b); if (mx < 4) return ["set_power", ["off", "sudden", 0]];
  const k = 255 / mx, rgb = (Math.round(r * k) << 16) | (Math.round(g * k) << 8) | Math.round(b * k);
  return ["set_scene", ["color", Math.max(1, rgb), Math.max(1, Math.min(100, Math.round(mx / 255 * 100)))]];
}

/** Parse a discovery answer's headers: {host, id, model, name, support:[], power, ...} or null */
export function parseYeelightAd(text) {
  const h = {}; for (const l of String(text).split(/\r?\n/)) { const i = l.indexOf(":"); if (i > 0) h[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
  const m = /^yeelight:\/\/([^:/]+):(\d+)/.exec(h.location || ""); if (!m) return null;
  return { host: Number(m[2]) === YEELIGHT_PORT ? m[1] : `${m[1]}:${m[2]}`, id: h.id || "", model: h.model || "", name: h.name ? decodeURIComponent(h.name) : "", support: (h.support || "").split(/\s+/).filter(Boolean), power: h.power, fw: h.fw_ver || "" };
}

/** Find Yeelights. [{host, id, model, name}] */
export function discoverYeelight({ timeoutMs = 2000, target = [YEELIGHT_GROUP, YEELIGHT_SSDP_PORT] } = {}) {
  return new Promise(resolve => {
    const found = new Map(), sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const q = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: ${YEELIGHT_GROUP}:${YEELIGHT_SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nST: wifi_bulb\r\n\r\n`);
    const done = () => { clearInterval(rep); try { sock.close(); } catch {} resolve([...found.values()]); };
    sock.on("error", done);
    sock.on("message", b => { const ad = parseYeelightAd(b.toString()); if (ad) found.set(ad.id || ad.host, { ...ad, name: ad.name || `Yeelight ${ad.model || "light"}`.trim() }); });
    const send = () => { try { sock.send(q, target[1], target[0]); } catch {} }; let rep = null;
    sock.bind(0, () => { try { sock.setMulticastTTL(2); } catch {} send(); rep = setInterval(send, 700); });
    setTimeout(done, timeoutMs);
  });
}

/** One command on a fresh connection: resolves with `result` (the light's answer), rejects on an error or no answer. */
export function yeelightCall(host, method, params = [], { timeoutMs = 2500 } = {}) {
  const [ip, port] = hostPort(host, YEELIGHT_PORT);
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: ip, port }); let buf = "", done = false;
    const end = (e, v) => { if (done) return; done = true; clearTimeout(t); s.destroy(); e ? reject(e) : resolve(v); };
    const t = setTimeout(() => end(new Error("timed out")), timeoutMs);
    s.on("connect", () => s.write(line(1, method, params)));
    s.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); let j; try { j = JSON.parse(l); } catch { continue; }
      if (j.id !== 1) continue; if (j.error) end(new Error(j.error.message || "the light refused the command")); else end(null, j.result); } });
    s.on("error", e => end(e)); s.on("close", () => end(new Error("closed")));
  });
}
/** Health: {power, bright, name, music} */
export async function yeelightInfo(host, o) { const r = await yeelightCall(host, "get_prop", ["power", "bright", "name", "music_on"], o); return { power: r?.[0], bright: Number(r?.[1]) || 0, name: r?.[2] || "", music: r?.[3] === "1" }; }

export class YeelightSender {
  /** @param {string} host ip or ip:port @param {{music?:boolean, fps?:number, retryMs?:number, musicTimeoutMs?:number}} o music: false for the normal, slow connection only */
  constructor(host, o = {}) {
    this.host = host; [this.ip, this.port] = hostPort(host, YEELIGHT_PORT); this.useMusic = o.music !== false;
    this.fastGap = 1000 / (o.fps || 20); this.slowGap = 1000; this.retryMs = o.retryMs || 15000; this.musicTimeoutMs = o.musicTimeoutMs || 3000;
    this.last = 0; this.prev = null; this.sent = 0; this.id = 1; this.ctl = null; this.music = null; this.server = null; this.starting = null; this.nextTry = 0; this.closed = false;
    this.mode = "starting"; // "music" | "slow"
  }
  /** the normal connection (kept open, re-made when it drops) */
  _ctl() {
    if (this.ctl && !this.ctl.destroyed) return this.ctl;
    const s = net.connect({ host: this.ip, port: this.port }); s.on("error", () => {}); s.on("data", () => {}); s.setNoDelay?.(true); s.unref?.(); this.ctl = s; return s;
  }
  /** Open our TCP server, ask the light to connect to it, wait for it. */
  _startMusic() {
    if (this.starting || this.closed) return this.starting;
    this.starting = (async () => {
      const me = await localAddressFor(this.ip); if (!me) throw new Error("no route to the light");
      const server = this.server || (this.server = net.createServer());
      server.unref?.(); server.removeAllListeners("connection");
      await new Promise((res, rej) => { if (server.listening) return res(); server.once("error", rej); server.listen(0, "0.0.0.0", res); });
      const conn = new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("the light didn't connect back")), this.musicTimeoutMs);
        server.once("connection", s => { clearTimeout(t); res(s); }); });
      const ctl = this._ctl(); ctl.write(line(this.id++, "set_music", [1, me, server.address().port]));
      const s = await conn; s.setNoDelay?.(true); s.on("data", () => {}); s.on("error", () => {});
      s.on("close", () => { if (this.music === s) { this.music = null; this.mode = "slow"; this.nextTry = Date.now() + 2000; } }); // the light dropped music mode: try again soon
      this.music = s; this.mode = "music"; this.prev = null; return s;
    })().catch(() => { this.mode = "slow"; this.nextTry = Date.now() + this.retryMs; }).finally(() => { this.starting = null; });
    return this.starting;
  }
  _cmd(method, params) {
    const s = this.music && !this.music.destroyed ? this.music : this._ctl();
    try { s.write(line(this.id++, method, params)); this.sent++; } catch {}
    if (this.id > 1e6) this.id = 1;
  }
  send(rgb) {
    if (this.closed || rgb.length < 3) return; const now = Date.now();
    if (this.useMusic && !this.music && !this.starting && now >= this.nextTry) this._startMusic();
    if (this.starting && this.mode === "starting") return; // the first try: wait for it
    if (now - this.last < (this.music ? this.fastGap : this.slowGap)) return;
    const n = rgb.length / 3; let r = 0, g = 0, b = 0; for (let i = 0; i < n; i++) { r += rgb[i * 3]; g += rgb[i * 3 + 1]; b += rgb[i * 3 + 2]; }
    const c = [r / n, g / n, b / n]; if (sameColours(c, this.prev, 4) && now - this.last < 2000) return;
    this.prev = c; this.last = now; const [m, p] = yeelightColour(...c); this._cmd(m, p);
  }
  power(on) { this.prev = null; this._cmd("set_power", [on ? "on" : "off", "sudden", 0]); }
  close() { this.closed = true; try { this.music?.destroy(); } catch {} try { this.ctl?.end(); } catch {} try { this.server?.close(); } catch {} }
}
