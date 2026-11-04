// A small WebSocket server (RFC 6455) on Node's built-in http and crypto, so the app needs no packages.
// Handles text and binary messages, fragmentation, ping/pong and close. No extensions (no compression).
import crypto from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export class WsClient {
  constructor(socket, req) {
    this.socket = socket; this.req = req; this.open = true; this.buf = Buffer.alloc(0); this.frags = []; this.fragOp = 0;
    this.onmessage = null; this.onclose = null; this.data = {};
    socket.setNoDelay(true);
    socket.on("data", d => this.receive(d));
    socket.on("close", () => this.closed());
    socket.on("error", () => this.closed());
  }
  receive(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      const b = this.buf; if (b.length < 2) return;
      const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80; let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > 16 * 1024 * 1024) return this.close(1009);
      const need = off + (masked ? 4 : 0) + len; if (b.length < need) return;
      let payload = b.subarray(off + (masked ? 4 : 0), need);
      if (masked) { const m = b.subarray(off, off + 4); payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]; }
      this.buf = b.subarray(need);
      if (op === 0x8) { this.close(); return; }
      if (op === 0x9) { this.frame(0xa, payload); continue; }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x2) { if (fin) this.deliver(op, payload); else { this.fragOp = op; this.frags = [payload]; } }
      else if (op === 0x0) { this.frags.push(payload); if (fin) { this.deliver(this.fragOp, Buffer.concat(this.frags)); this.frags = []; } }
    }
  }
  deliver(op, payload) { if (!this.onmessage) return; try { this.onmessage(op === 0x1 ? payload.toString("utf8") : payload, op === 0x2); } catch (e) { console.error("ws message:", e.message); } }
  frame(op, payload) {
    if (!this.open) return;
    const len = payload.length, head = len < 126 ? Buffer.from([0x80 | op, len]) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    if (len >= 126 && len < 65536) { head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
    else if (len >= 65536) { head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    this.socket.write(Buffer.concat([head, payload]));
  }
  /** Is the socket's send buffer backed up? Used to skip preview frames for slow clients. */
  get busy() { return this.socket.writableLength > 256 * 1024; }
  send(data) { if (typeof data === "string") this.frame(0x1, Buffer.from(data)); else this.frame(0x2, Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength)); }
  sendJSON(o) { this.send(JSON.stringify(o)); }
  close(code = 1000) { if (!this.open) return; try { const p = Buffer.alloc(2); p.writeUInt16BE(code); this.frame(0x8, p); this.socket.end(); } catch {} this.closed(); }
  closed() { if (!this.open) return; this.open = false; try { this.socket.destroy(); } catch {} this.onclose && this.onclose(); }
}

/** Is this request from another website? Browsers send Origin on cross-site requests; apps and scripts (curl, Home
 * Assistant) send none. A page somewhere on the internet must not be able to change the lights or settings. */
export function foreignOrigin(req) {
  const o = req.headers.origin; if (!o) return false;
  try { const h = new URL(o).host.toLowerCase(), extra = (process.env.TEMPOLIGHT_ALLOWED_ORIGINS || "").toLowerCase().split(",").map(x => x.trim().replace(/^https?:\/\//, "")).filter(Boolean);
    return h !== String(req.headers.host || "").toLowerCase() && !extra.includes(h); } catch { return true; } // behind a reverse proxy that changes Host: list your address in TEMPOLIGHT_ALLOWED_ORIGINS
}
/** Attach to an http.Server; `onConnect(client, req)` is called for every connection to `path`. */
export function attachWebSocket(server, path, onConnect) {
  const clients = new Set();
  server.on("upgrade", (req, socket) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname !== path || (req.headers.upgrade || "").toLowerCase() !== "websocket") { socket.destroy(); return; }
    const key = req.headers["sec-websocket-key"]; if (!key) { socket.destroy(); return; }
    if (foreignOrigin(req)) { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; } // another website's page
    const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const c = new WsClient(socket, req); clients.add(c);
    const prevClose = () => clients.delete(c); c.onclose = prevClose;
    onConnect(c, req, url);
    const userClose = c.onclose; c.onclose = () => { clients.delete(c); if (userClose !== prevClose) userClose && userClose(); };
  });
  return clients;
}
