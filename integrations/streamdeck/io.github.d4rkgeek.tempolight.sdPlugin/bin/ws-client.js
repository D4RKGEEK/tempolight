// A small WebSocket client (RFC 6455) on node:net, node:tls and node:crypto, for Node 20, where there is no global
// WebSocket yet. openWebSocket() uses Node's own WebSocket (Node 22 and later) when there is one, and this otherwise.
// Both have the same shape: onopen, onmessage({data}), onclose({code, reason}), onerror, send(text), close(), readyState.
// Text messages only arrive as strings; binary ones as a Buffer (this client) or whatever Node's WebSocket gives.
//
// The same file is in the Stream Deck plugin (integrations/streamdeck/.../bin/ws-client.js): keep the two the same
// (a test checks it).
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export class TinyWebSocket {
  /** @param {string} url ws:// or wss:// @param {{headers?:object}} [opts] */
  constructor(url, { headers = {} } = {}) {
    this.url = url; this.readyState = 0; this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
    this.buf = Buffer.alloc(0); this.frags = []; this.fragOp = 0; this.closedOnce = false;
    let u; try { u = new URL(url); } catch { throw new SyntaxError(`Not a WebSocket address: ${url}`); }
    if (u.protocol !== "ws:" && u.protocol !== "wss:") throw new SyntaxError(`Not a WebSocket address: ${url}`);
    const secure = u.protocol === "wss:", port = Number(u.port) || (secure ? 443 : 80), host = u.hostname.replace(/^\[|\]$/g, "");
    this.key = crypto.randomBytes(16).toString("base64");
    const req = [`GET ${u.pathname || "/"}${u.search} HTTP/1.1`, `Host: ${u.host}`, "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Key: ${this.key}`, "Sec-WebSocket-Version: 13",
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", ""].join("\r\n");
    const sock = this.socket = secure ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host }) : net.connect({ host, port });
    sock.setNoDelay?.(true);
    sock.once(secure ? "secureConnect" : "connect", () => sock.write(req));
    let head = Buffer.alloc(0);
    const onData = d => {
      if (this.readyState === 0) {
        head = Buffer.concat([head, d]); const end = head.indexOf("\r\n\r\n"); if (end < 0) { if (head.length > 16384) this.fail(new Error("Bad handshake")); return; }
        const lines = head.subarray(0, end).toString("latin1").split("\r\n"), status = /^HTTP\/1\.1 (\d{3})/.exec(lines[0]);
        const h = Object.fromEntries(lines.slice(1).map(l => { const i = l.indexOf(":"); return [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()]; }));
        const want = crypto.createHash("sha1").update(this.key + GUID).digest("base64");
        if (!status || status[1] !== "101") return this.fail(new Error(`The server answered ${status ? status[1] : "something else"} instead of a WebSocket`));
        if (h["sec-websocket-accept"] !== want) return this.fail(new Error("The server's WebSocket handshake is wrong"));
        this.readyState = 1; const rest = head.subarray(end + 4); head = null;
        try { this.onopen?.({ type: "open" }); } catch {}
        if (rest.length) this.receive(rest);
        return;
      }
      this.receive(d);
    };
    sock.on("data", onData);
    sock.on("error", e => this.fail(e));
    sock.on("close", () => this.finish(1006, ""));
  }
  fail(e) { if (this.readyState < 3) { try { this.onerror?.({ type: "error", error: e, message: e.message }); } catch {} } try { this.socket.destroy(); } catch {} this.finish(1006, e.message); }
  finish(code, reason) { if (this.closedOnce) return; this.closedOnce = true; this.readyState = 3; try { this.onclose?.({ type: "close", code, reason, wasClean: code === 1000 }); } catch {} }
  receive(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      const b = this.buf; if (b.length < 2) return;
      const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80; let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > 32 * 1024 * 1024) { this.close(1009); return; }
      const need = off + (masked ? 4 : 0) + len; if (b.length < need) return;
      let payload = b.subarray(off + (masked ? 4 : 0), need);
      if (masked) { const m = b.subarray(off, off + 4); payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]; }
      this.buf = b.subarray(need);
      if (op === 0x8) { const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005, reason = payload.subarray(2).toString("utf8");
        if (this.readyState === 1) { this.readyState = 2; this.frame(0x8, payload.subarray(0, 2)); } try { this.socket.end(); } catch {} this.finish(code, reason); return; }
      if (op === 0x9) { this.frame(0xa, payload); continue; }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x2) { if (fin) this.deliver(op, payload); else { this.fragOp = op; this.frags = [payload]; } }
      else if (op === 0x0) { this.frags.push(payload); if (fin) { this.deliver(this.fragOp, Buffer.concat(this.frags)); this.frags = []; } }
    }
  }
  deliver(op, payload) { try { this.onmessage?.({ type: "message", data: op === 0x1 ? payload.toString("utf8") : payload }); } catch (e) { console.error("ws message:", e.message); } }
  frame(op, payload) { // client frames are masked
    const len = payload.length, mask = crypto.randomBytes(4);
    const head = len < 126 ? Buffer.from([0x80 | op, 0x80 | len]) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    if (len >= 126 && len < 65536) { head[0] = 0x80 | op; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
    else if (len >= 65536) { head[0] = 0x80 | op; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
    const body = Buffer.from(payload); for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
    try { this.socket.write(Buffer.concat([head, mask, body])); } catch {}
  }
  send(data) { if (this.readyState !== 1) throw new Error("WebSocket is not open"); if (typeof data === "string") this.frame(0x1, Buffer.from(data)); else this.frame(0x2, Buffer.isBuffer(data) ? data : Buffer.from(data.buffer || data, data.byteOffset || 0, data.byteLength)); }
  close(code = 1000, reason = "") {
    if (this.readyState >= 2) return; if (this.readyState === 0) { try { this.socket.destroy(); } catch {} this.finish(code, reason); return; }
    this.readyState = 2; const p = Buffer.alloc(2 + Buffer.byteLength(reason)); p.writeUInt16BE(code); p.write(reason, 2);
    this.frame(0x8, p); setTimeout(() => { try { this.socket.destroy(); } catch {} this.finish(code, reason); }, 1000).unref?.();
  }
}

/** A WebSocket: Node's own when it has one (Node 22+), else TinyWebSocket. tiny: always TinyWebSocket. */
export function openWebSocket(url, { tiny = false } = {}) {
  const W = globalThis.WebSocket;
  if (!tiny && typeof W === "function") { const s = new W(url); try { s.binaryType = "arraybuffer"; } catch {} return s; }
  return new TinyWebSocket(url);
}
