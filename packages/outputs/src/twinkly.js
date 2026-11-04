// Twinkly lights (strings, curtains, Squares, Flex...) through the "xled" local API: HTTP on port 80 to log in and
// switch modes, then realtime frames over UDP 7777.
//   POST /xled/v1/login {challenge: <32 random bytes, base64>} -> {authentication_token, challenge-response, authentication_token_expires_in}
//   POST /xled/v1/verify {challenge-response} with header X-Auth-Token        (the token works from now on)
//   GET  /xled/v1/gestalt                    number_of_led, led_profile ("RGB" or "RGBW"), device_name (no token needed)
//   GET  /xled/v1/fw/version                 which realtime protocol the firmware speaks
//   GET  /xled/v1/led/layout/full            where each LED is (set with the Twinkly app's camera mapping)
//   POST /xled/v1/led/mode {mode: "rt"}       realtime; {mode: "off"} turns the lights off
// Realtime UDP, protocol 3 (firmware 2.4.14 and later): 0x03, the token (8 bytes, base64-decoded), 0x00 0x00, the
// fragment number, then up to 900 bytes of LED data (R G B per LED, or W R G B on RGBW models). Older firmware gets
// protocol 2: 0x02, token, 0x00, then all the data in one packet. Twinkly lights take about 25 frames a second; the
// token expires after about 4 hours (logged in again before then), and realtime mode is asked for again every
// 30 seconds, since the lights drop it when the Twinkly app takes over or after a while without frames.
// Discovery: "\x01discover" broadcast to UDP 5555; each light answers with its IP (4 bytes, reversed), "OK" and its name.
import http from "node:http";
import dgram from "node:dgram";
import crypto from "node:crypto";
import { hostPort, udpExchange, broadcastTargets } from "./lightutil.js";

export const TWINKLY_PORT = 80, TWINKLY_RT_PORT = 7777, TWINKLY_DISCOVERY_PORT = 5555, TWINKLY_FRAGMENT = 900;

function req(host, method, path, body, token, timeout = 3000) {
  const [h, p] = hostPort(host, TWINKLY_PORT);
  return new Promise((res, rej) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body)), headers = { ...(data ? { "content-type": "application/json", "content-length": data.length } : {}), ...(token ? { "x-auth-token": token } : {}) };
    const r = http.request({ host: h, port: p, method, path, timeout, headers }, resp => { const c = []; resp.on("data", d => c.push(d));
      resp.on("end", () => { let j = null; try { j = JSON.parse(Buffer.concat(c).toString() || "null"); } catch {} if (resp.statusCode === 401) return rej(Object.assign(new Error("Twinkly refused the token"), { code: 401 }));
        if (resp.statusCode >= 300) return rej(new Error(`Twinkly answered ${resp.statusCode}`)); res(j || {}); }); });
    r.on("timeout", () => r.destroy(new Error("timed out"))); r.on("error", rej); if (data) r.write(data); r.end();
  });
}

/** Log in: {token, expiresAt}. The challenge-response isn't checked by us (it's an HMAC with a key from the firmware). */
export async function twinklyLogin(host) {
  const login = await req(host, "POST", "/xled/v1/login", { challenge: crypto.randomBytes(32).toString("base64") });
  if (!login.authentication_token) throw new Error("that doesn't look like a Twinkly");
  await req(host, "POST", "/xled/v1/verify", { "challenge-response": login["challenge-response"] }, login.authentication_token);
  return { token: login.authentication_token, expiresAt: Date.now() + (Number(login.authentication_token_expires_in) || 14400) * 1000 };
}
const fwVer = v => { const [a = 0, b = 0, c = 0] = String(v || "0").split(".").map(x => Number(x) || 0); return a * 1e6 + b * 1e3 + c; };
/** {name, leds, rgbw, product, version, protocol} (no login needed) */
export async function twinklyInfo(host) {
  const g = await req(host, "GET", "/xled/v1/gestalt"); if (!(g.number_of_led > 0)) throw new Error("that doesn't look like a Twinkly");
  let version = g.fw_version || ""; if (!version) try { version = (await req(host, "GET", "/xled/v1/fw/version")).version || ""; } catch {}
  return { name: g.device_name || "Twinkly", leds: g.number_of_led, rgbw: /RGBW/i.test(g.led_profile || "") || g.bytes_per_led === 4, product: g.product_name || g.product_code || "", version, protocol: fwVer(version) >= fwVer("2.4.14") || !version ? 3 : 2 };
}
/** LED positions from the Twinkly app's mapping: {source: "linear"|"2d"|"3d", points: [{x, y}]} (x, y 0-1, y up). */
export async function twinklyLayout(host, token) {
  const l = await req(host, "GET", "/xled/v1/led/layout/full", undefined, token);
  return { source: l.source || "linear", points: (l.coordinates || []).map(c => ({ x: Number(c.x) || 0, y: Number(c.y) || 0 })) };
}
export const twinklyMode = (host, token, mode) => req(host, "POST", "/xled/v1/led/mode", { mode }, token);

/** Realtime packets for one frame. data: the LED bytes as the light wants them (RGB or WRGB). */
export function twinklyPackets(token, data, protocol = 3) {
  const tok = Buffer.from(token, "base64").subarray(0, 8), out = [];
  if (protocol === 2) return [Buffer.concat([Buffer.from([2]), tok, Buffer.from([0]), data])];
  for (let f = 0, o = 0; o < data.length || f === 0; f++, o += TWINKLY_FRAGMENT) out.push(Buffer.concat([Buffer.from([3]), tok, Buffer.from([0, 0, f]), data.subarray(o, o + TWINKLY_FRAGMENT)]));
  return out;
}

/** Find Twinklys. [{host, name}] */
export async function discoverTwinkly({ timeoutMs = 2000, targets = null } = {}) {
  const to = targets || (await broadcastTargets()).map(ip => [ip, TWINKLY_DISCOVERY_PORT]), found = new Map();
  await udpExchange({ to, packets: Buffer.from("\x01discover"), timeoutMs, broadcast: !targets, repeatMs: 700, onMessage: (b, r) => {
    if (b.length < 7 || b.toString("latin1", 4, 6) !== "OK") return; const ip = [b[3], b[2], b[1], b[0]].join("."), host = ip === "0.0.0.0" ? r.address : ip;
    found.set(host, { host, name: b.toString("utf8", 6).replace(/\0.*$/s, "") || "Twinkly" }); } });
  return [...found.values()];
}

export class TwinklySender {
  /** @param {string} host @param {{leds:number, rgbw?:boolean, protocol?:number, rtPort?:number, fps?:number}} o */
  constructor(host, o = {}) {
    this.host = host; this.ip = hostPort(host, TWINKLY_PORT)[0]; this.leds = Math.max(1, o.leds || 1); this.rgbw = !!o.rgbw; this.protocol = o.protocol || 3; this.rtPort = o.rtPort || TWINKLY_RT_PORT;
    this.minGap = 1000 / (o.fps || 25); this.last = 0; this.sent = 0; this.auth = null; this.modeAt = 0; this.busy = null; this.retryAt = 0; this.off = false;
    this.sock = dgram.createSocket("udp4"); this.sock.on("error", () => {}); this.sock.unref?.();
  }
  /** log in when needed (and before the token expires), and ask for realtime mode every 30 s */
  _prepare(now) {
    if (this.busy || now < this.retryAt) return;
    const login = !this.auth || now > this.auth.expiresAt - 60000, mode = now - this.modeAt > 30000; if (!login && !mode) return;
    this.busy = (async () => { if (login) this.auth = await twinklyLogin(this.host);
      try { await twinklyMode(this.host, this.auth.token, "rt"); } catch (e) { if (e.code === 401) { this.auth = await twinklyLogin(this.host); await twinklyMode(this.host, this.auth.token, "rt"); } else throw e; }
      this.modeAt = Date.now(); })().catch(() => { this.auth = null; this.retryAt = Date.now() + 5000; }).finally(() => { this.busy = null; });
  }
  send(rgb) {
    const now = Date.now(); if (this.off || now - this.last < this.minGap) return; this._prepare(now); if (!this.auth || !this.modeAt) return; this.last = now;
    const bpl = this.rgbw ? 4 : 3, data = Buffer.alloc(this.leds * bpl);
    for (let i = 0; i < this.leds && i * 3 + 2 < rgb.length; i++) { const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
      if (this.rgbw) { const w = Math.min(r, g, b); data[i * 4] = w; data[i * 4 + 1] = r - w; data[i * 4 + 2] = g - w; data[i * 4 + 3] = b - w; } // the white LED takes the common part
      else { data[i * 3] = r; data[i * 3 + 1] = g; data[i * 3 + 2] = b; } }
    for (const p of twinklyPackets(this.auth.token, data, this.protocol)) try { this.sock.send(p, this.rtPort, this.ip); } catch {}
    this.sent++;
  }
  async power(on) {
    this.off = !on; this.modeAt = 0; if (on) return; // the next frame asks for realtime mode again
    try { if (!this.auth) this.auth = await twinklyLogin(this.host); await twinklyMode(this.host, this.auth.token, "off"); } catch {}
  }
  close() { setTimeout(() => { try { this.sock.close(); } catch {} }, 20); }
}

