// Philips Hue Entertainment: fast streaming (up to 50 updates a second) to the lights of an entertainment area,
// made in the Hue app. It needs:
//   - a client key, which the bridge only gives when pairing with {"generateclientkey": true} (link button again for
//     bridges paired before), used as the DTLS pre-shared key (16 bytes, hex); the identity is the user name
//   - CLIP v2 (HTTPS 443, header hue-application-key): GET /clip/v2/resource/entertainment_configuration lists the
//     areas and their channels; PUT .../entertainment_configuration/<id> {"action": "start"} before streaming,
//     {"action": "stop"} after
//   - DTLS 1.2 PSK (TLS_PSK_WITH_AES_128_GCM_SHA256) to UDP 2100 (see dtls.js), then HueStream v2 messages:
//     "HueStream", version 2.0, sequence, 2 reserved, colour space (0 = RGB), 1 reserved, the area id (36 ASCII
//     characters), then per channel: channel id, R, G, B (16 bits each, big-endian). At most 20 channels.
// The bridge ends streaming after 10 s without messages; lights then go back to what they showed before.
// When streaming can't start (no client key, another app is streaming, DTLS fails), the lights get basic REST updates
// (hue.js) instead, and streaming is tried again every 30 s.
// The DTLS client and this message format are tested against our own test server and OpenSSL, not yet against a
// real bridge.
import http from "node:http";
import https from "node:https";
import { DtlsClient } from "./dtls.js";
import { HueSender } from "./hue.js";
import { hostPort } from "./lightutil.js";

export const HUE_STREAM_PORT = 2100, HUE_CLIP_PORT = 443, HUE_MAX_CHANNELS = 20;

function req(mod, o, body) {
  return new Promise((res, rej) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = mod.request({ ...o, timeout: o.timeout || 4000, headers: { ...(o.headers || {}), ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) } }, resp => {
      const c = []; resp.on("data", d => c.push(d)); resp.on("end", () => { let j = null; try { j = JSON.parse(Buffer.concat(c).toString() || "null"); } catch {} res({ status: resp.statusCode, body: j }); }); });
    r.on("timeout", () => r.destroy(new Error("timed out"))); r.on("error", rej); if (data) r.write(data); r.end();
  });
}

/** Pair and ask for a client key too: {user, clientkey}. Throws {code: "pair"} until the link button has been pressed. */
export async function huePairKey(host) {
  const [h, p] = hostPort(host, 80), r = (await req(http, { host: h, port: p, method: "POST", path: "/api" }, { devicetype: "tempolight#server", generateclientkey: true })).body, a = Array.isArray(r) ? r[0] : null;
  if (a?.success?.username) return { user: a.success.username, clientkey: a.success.clientkey || null };
  if (a?.error?.type === 101) throw Object.assign(new Error("Press the round link button on the Hue bridge, then try again within 30 seconds."), { code: "pair" });
  throw new Error(a?.error?.description || "That doesn't look like a Hue bridge");
}

/** A CLIP v2 call. The bridge's certificate is signed by Philips' own CA for the bridge id, so it isn't checked here (local network). */
export async function hueClip(host, user, method, path, body, { clipPort = HUE_CLIP_PORT } = {}) {
  const [h] = hostPort(host, 80), r = await req(https, { host: h, port: clipPort, method, path, rejectUnauthorized: false, headers: { "hue-application-key": user } }, body);
  if (r.status === 403 || r.status === 401) throw new Error("the bridge refused the user name");
  if (r.status >= 300) throw new Error(r.body?.errors?.[0]?.description || `the bridge answered ${r.status}`);
  return r.body?.data || [];
}

/**
 * The bridge's entertainment areas: [{id, name, status, channels: [{id, light}]}], light: the REST (v1) light id each
 * channel shows (from channel -> entertainment service -> device <- light), or null.
 */
export async function hueEntertainmentAreas(host, user, o) {
  const [areas, ents, lights] = await Promise.all(["entertainment_configuration", "entertainment", "light"].map(t => hueClip(host, user, "GET", `/clip/v2/resource/${t}`, undefined, o).catch(e => { if (t === "entertainment_configuration") throw e; return []; })));
  const ownerOfEnt = new Map(ents.map(e => [e.id, e.owner?.rid])), v1ByDevice = new Map(lights.map(l => [l.owner?.rid, /\/lights\/(\w+)/.exec(l.id_v1 || "")?.[1] || null]));
  return areas.map(a => ({ id: a.id, name: a.metadata?.name || a.name || "Entertainment area", status: a.status || "inactive",
    channels: (a.channels || []).slice(0, HUE_MAX_CHANNELS).map(c => ({ id: c.channel_id, light: v1ByDevice.get(ownerOfEnt.get(c.members?.[0]?.service?.rid)) ?? null })) }));
}
export const hueEntertainmentAction = (host, user, id, action, o) => hueClip(host, user, "PUT", `/clip/v2/resource/entertainment_configuration/${id}`, { action }, o);

/** One HueStream v2 message. channels: [{id, r, g, b}] with 16-bit colours. */
export function hueStreamMessage(areaId, seq, channels) {
  const n = Math.min(HUE_MAX_CHANNELS, channels.length), b = Buffer.alloc(52 + n * 7);
  b.write("HueStream", 0, "latin1"); b[9] = 2; b[10] = 0; b[11] = seq & 255; b[12] = 0; b[13] = 0; b[14] = 0; b[15] = 0; b.write(String(areaId).padEnd(36, "\0").slice(0, 36), 16, "latin1");
  for (let i = 0; i < n; i++) { const c = channels[i], o = 52 + i * 7; b[o] = c.id; b.writeUInt16BE(c.r, o + 1); b.writeUInt16BE(c.g, o + 3); b.writeUInt16BE(c.b, o + 5); }
  return b;
}

export class HueEntertainmentSender {
  /**
   * @param {string} host the bridge @param {{user:string, clientkey:string, area:{id:string, channels:{id:number, led:number}[]}, lights:string[], color?:boolean[],
   *   clipPort?:number, streamPort?:number, fps?:number, retryMs?:number, onState?:(state:string, error?:string)=>void, api?:{start():Promise, stop():Promise}}} o
   *   channels[].led: which of the device's LEDs (its lights, in order) each channel shows
   */
  constructor(host, o) {
    this.host = host; this.ip = hostPort(host, 80)[0]; this.o = o; this.area = o.area; this.streamPort = o.streamPort || HUE_STREAM_PORT;
    this.minGap = 1000 / Math.min(50, o.fps || 50); this.retryMs = o.retryMs || 30000; this.last = 0; this.seq = 0; this.sent = 0; this.state = "idle"; this.retryAt = 0; this.dtls = null; this.closed = false;
    this.rest = new HueSender(host, { user: o.user, lights: o.lights, color: o.color }); // the fallback, and for turning lights off
    const co = { clipPort: o.clipPort };
    this.api = o.api || { start: () => hueEntertainmentAction(host, o.user, this.area.id, "start", co), stop: () => hueEntertainmentAction(host, o.user, this.area.id, "stop", co) };
  }
  get mode() { return this.state === "streaming" ? "entertainment" : "basic"; }
  _set(state, err) { if (this.state === state) return; this.state = state; this.o.onState?.(state, err); }
  async _start() {
    this._set("starting");
    try {
      if (!this.o.clientkey) throw new Error("pair the bridge again for fast mode (no client key)");
      await this.api.start();
      const c = new DtlsClient({ host: this.ip, port: this.streamPort, identity: this.o.user, psk: Buffer.from(this.o.clientkey, "hex"), timeoutMs: 8000 });
      await c.connect(); if (this.closed || this.state !== "starting") { c.close(); return; }
      c.on("close", () => { if (this.dtls !== c) return; this.dtls = null; this.retryAt = Date.now() + 2000; this._set("fallback", "the stream closed"); });
      this.dtls = c; this._set("streaming");
    } catch (e) { if (this.closed) return; this.retryAt = Date.now() + this.retryMs; this.api.stop().catch(() => {}); this._set("fallback", e.message); }
  }
  send(rgb) {
    if (this.closed || this.off) return; const now = Date.now();
    if (this.state === "idle" || (this.state === "fallback" && now >= this.retryAt)) this._start();
    if (this.state === "fallback") return this.rest.send(rgb);
    if (this.state !== "streaming" || now - this.last < this.minGap) return; this.last = now;
    const ch = this.area.channels.map(c => { const i = c.led * 3; return { id: c.id, r: (rgb[i] || 0) * 257, g: (rgb[i + 1] || 0) * 257, b: (rgb[i + 2] || 0) * 257 }; });
    if (this.dtls.send(hueStreamMessage(this.area.id, this.seq++, ch))) this.sent++;
  }
  _stopStream() { const c = this.dtls; this.dtls = null; if (c) { c.send(hueStreamMessage(this.area.id, this.seq++, this.area.channels.map(x => ({ id: x.id, r: 0, g: 0, b: 0 })))); c.close(); } return this.api.stop().catch(() => {}); }
  async power(on) {
    if (on) { this.off = false; this.retryAt = 0; if (this.state !== "streaming") this._set("idle"); return; }
    this.off = true; const was = this.state; this._set("idle"); // nothing until the lights are turned on again (the frame loop keeps sending black for a moment)
    if (was === "streaming" || was === "starting") await this._stopStream();
    this.rest.power(false);
  }
  close() { this.closed = true; if (this.dtls || this.state === "streaming") this._stopStream(); this.rest.close(); }
}
