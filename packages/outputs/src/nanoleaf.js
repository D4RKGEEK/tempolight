// Nanoleaf panels (Shapes, Canvas, Elements, Lines) through their local API. Pairing: hold the controller's power
// button for 5-7 seconds until the lights flash, then ask for a token within 30 seconds. Streaming uses the
// "extControl" v2 mode: one UDP packet per frame on port 60222 with a colour for each panel.
import http from "node:http";
import dgram from "node:dgram";

export const NANOLEAF_PORT = 16021, NANOLEAF_STREAM_PORT = 60222;
// shape types with no light: Rhythm module (1), Shapes controller (12), Lines connector (16), controller cap (19), power connector (20).
// 15 is "Elements Hexagon - Corner", which does light up.
const CONTROLLERS = new Set([1, 12, 16, 19, 20]);

function req(host, port, method, path, body, timeout = 4000) {
  return new Promise((res, rej) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host, port, method, path, timeout, headers: data ? { "content-type": "application/json", "content-length": data.length } : {} }, resp => {
      const chunks = []; resp.on("data", c => chunks.push(c)); resp.on("end", () => { const t = Buffer.concat(chunks).toString(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {} res({ status: resp.statusCode, body: j }); });
    });
    r.on("timeout", () => r.destroy(new Error("timed out"))); r.on("error", rej); if (data) r.write(data); r.end();
  });
}
const split = host => { const [h, p] = String(host).split(":"); return [h, Number(p) || NANOLEAF_PORT]; };

/** Ask for a token. Throws with a helpful message when the power button wasn't held first. */
export async function nanoleafPair(host) {
  const [h, p] = split(host), r = await req(h, p, "POST", "/api/v1/new");
  if (r.status === 200 && r.body?.auth_token) return r.body.auth_token;
  if (r.status === 403) throw Object.assign(new Error("Hold the power button on the Nanoleaf controller for 5-7 seconds until the lights flash, then press Add again within 30 seconds."), { code: "pair" });
  throw new Error(`Nanoleaf answered ${r.status}`);
}
/** Panels and their positions: {name, panels: [{id, x, y}]} (x, y in Nanoleaf units, y up). */
export async function nanoleafInfo(host, token) {
  const [h, p] = split(host), r = await req(h, p, "GET", `/api/v1/${token}`);
  if (r.status === 401) throw new Error("Nanoleaf refused the token: pair it again");
  if (r.status !== 200 || !r.body) throw new Error(`Nanoleaf answered ${r.status}`);
  const pos = r.body.panelLayout?.layout?.positionData || [];
  return { name: r.body.name || "Nanoleaf", model: r.body.model || "", panels: pos.filter(q => !CONTROLLERS.has(q.shapeType) && q.panelId).map(q => ({ id: q.panelId, x: q.x, y: q.y })) };
}
/** Switch the panels to streaming. */
export async function nanoleafStream(host, token) {
  const [h, p] = split(host), r = await req(h, p, "PUT", `/api/v1/${token}/effects`, { write: { command: "display", animType: "extControl", extControlVersion: "v2" } });
  if (r.status >= 300) throw new Error(`Nanoleaf answered ${r.status}`);
}
export async function nanoleafPower(host, token, on) { const [h, p] = split(host); await req(h, p, "PUT", `/api/v1/${token}/state`, { on: { value: !!on } }); }

/** Panel positions as room points: fitted into a box centred on (cx, cy), about `size` wide, y flipped for the wall view. */
export function panelPoints(panels, cx = 8, cy = 4.5, size = 5) {
  if (!panels.length) return [];
  const xs = panels.map(p => p.x), ys = panels.map(p => p.y), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const k = size / Math.max(1, x1 - x0, y1 - y0);
  return panels.map(p => [Math.round((cx + (p.x - (x0 + x1) / 2) * k) * 1000) / 1000, Math.round((cy - (p.y - (y0 + y1) / 2) * k) * 1000) / 1000]);
}

/** v2 frame: number of panels, then for each panel: id (2 bytes), R, G, B, W, transition time (2 bytes, 100 ms units). */
export function nanoleafFrame(ids, rgb) {
  const b = Buffer.alloc(2 + ids.length * 8); b.writeUInt16BE(ids.length, 0);
  ids.forEach((id, i) => { const o = 2 + i * 8; b.writeUInt16BE(id, o); b[o + 2] = rgb[i * 3] || 0; b[o + 3] = rgb[i * 3 + 1] || 0; b[o + 4] = rgb[i * 3 + 2] || 0; b[o + 5] = 0; b.writeUInt16BE(0, o + 6); });
  return b;
}

export class NanoleafSender {
  /** @param {string} host ip or ip:port of the REST API @param {{token:string, panels:number[], port?:number, fps?:number}} o */
  constructor(host, o) {
    this.host = host; this.ip = split(host)[0]; this.token = o.token; this.ids = o.panels || []; this.port = o.port || NANOLEAF_STREAM_PORT;
    this.minGap = 1000 / (o.fps || 30); this.last = 0; this.sent = 0; this.startedAt = 0;
    this.sock = dgram.createSocket("udp4"); this.sock.on("error", () => {}); this.sock.unref?.();
  }
  send(rgb) {
    const now = Date.now(); if (now - this.last < this.minGap || !this.ids.length) return; this.last = now;
    if (now - this.startedAt > 120000) { this.startedAt = now; nanoleafStream(this.host, this.token).catch(() => { this.startedAt = now - 110000; }); } // (re)start streaming every 2 minutes, in case the panels restarted
    try { this.sock.send(nanoleafFrame(this.ids, rgb), this.port, this.ip); this.sent++; } catch {}
  }
  power(on) { if (on) this.startedAt = 0; // panels that were off may have dropped streaming: ask again with the next frame
    return nanoleafPower(this.host, this.token, on).catch(() => {}); }
  close() { setTimeout(() => { try { this.sock.close(); } catch {} }, 20); }
}
