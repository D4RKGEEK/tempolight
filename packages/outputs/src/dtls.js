// A minimal DTLS 1.2 client for one cipher suite, TLS_PSK_WITH_AES_128_GCM_SHA256 (RFC 6347, RFC 5246, RFC 4279,
// RFC 5487), built on node:dgram and node:crypto because Node.js has no DTLS. It's what Philips Hue Entertainment
// streaming needs, and nothing more: no certificates, no renegotiation, no session resumption, no extensions.
//
// The handshake (client flights on the left):
//   ClientHello (no cookie)                ->
//                                          <- HelloVerifyRequest (cookie)          (optional: servers that skip it are fine)
//   ClientHello (with the cookie)          ->
//                                          <- ServerHello, [ServerKeyExchange: PSK identity hint], ServerHelloDone
//   ClientKeyExchange (PSK identity), ChangeCipherSpec, Finished (encrypted) ->
//                                          <- ChangeCipherSpec, Finished (encrypted)
// then application data records (encrypted). Each flight is sent again after 1 s, 2 s, 4 s... without an answer (RFC 6347
// 4.2.4), and again when the server repeats its previous flight (it didn't get ours).
//
// Keys: premaster = len(psk) zeros || psk with 16-bit lengths in front (RFC 4279 2); master = PRF(premaster, "master
// secret", client random + server random); key block = PRF(master, "key expansion", server random + client random)
// = client key (16), server key (16), client IV salt (4), server IV salt (4). PRF is TLS 1.2's P_SHA256.
// Records are AES-128-GCM: nonce = salt (4) + explicit nonce (8, sent first in the record: we use epoch + sequence),
// additional data = epoch + sequence (8) + type + version + plaintext length. The handshake transcript hashes every
// handshake message with its 12-byte DTLS header as if it came in one fragment, except the first ClientHello and the
// HelloVerifyRequest (RFC 6347 4.2.1).
//
// Tested against the small DTLS server in packages/outputs/test/dtls.test.js and against `openssl s_server -dtls1_2`
// when openssl is installed. Not yet tested against a real Hue bridge.
import dgram from "node:dgram";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";

export const DTLS_1_2 = 0xfefd, TLS_PSK_WITH_AES_128_GCM_SHA256 = 0x00a8;
export const CT = { changeCipherSpec: 20, alert: 21, handshake: 22, applicationData: 23 };
export const HT = { clientHello: 1, serverHello: 2, helloVerifyRequest: 3, serverKeyExchange: 12, serverHelloDone: 14, clientKeyExchange: 16, finished: 20 };

/** TLS 1.2 PRF with SHA-256 (RFC 5246 5): P_SHA256(secret, label + seed) cut to `len` bytes. */
export function prf(secret, label, seed, len) {
  const s = Buffer.concat([Buffer.from(label, "latin1"), seed]), out = []; let a = s, n = 0;
  while (n < len) { a = crypto.createHmac("sha256", secret).update(a).digest(); const p = crypto.createHmac("sha256", secret).update(Buffer.concat([a, s])).digest(); out.push(p); n += p.length; }
  return Buffer.concat(out).subarray(0, len);
}
/** RFC 4279: the premaster secret for plain PSK. */
export function pskPremaster(psk) { const n = psk.length, b = Buffer.alloc(4 + 2 * n); b.writeUInt16BE(n, 0); b.writeUInt16BE(n, 2 + n); psk.copy(b, 4 + n); return b; }
/** master secret and the AES-GCM keys for both directions */
export function deriveKeys(psk, clientRandom, serverRandom) {
  const master = prf(pskPremaster(psk), "master secret", Buffer.concat([clientRandom, serverRandom]), 48);
  const kb = prf(master, "key expansion", Buffer.concat([serverRandom, clientRandom]), 40);
  return { master, clientKey: kb.subarray(0, 16), serverKey: kb.subarray(16, 32), clientSalt: kb.subarray(32, 36), serverSalt: kb.subarray(36, 40) };
}

const seq8 = (epoch, seq) => { const b = Buffer.alloc(8); b.writeUInt16BE(epoch, 0); b.writeUIntBE(seq, 2, 6); return b; };
/** One record: type, version, epoch, 48-bit sequence number, length, fragment. */
export function record(type, epoch, seq, fragment, version = DTLS_1_2) {
  const h = Buffer.alloc(13); h[0] = type; h.writeUInt16BE(version, 1); seq8(epoch, seq).copy(h, 3); h.writeUInt16BE(fragment.length, 11); return Buffer.concat([h, fragment]);
}
/** All the records in a datagram. */
export function parseRecords(b) {
  const out = []; let o = 0;
  while (o + 13 <= b.length) { const len = b.readUInt16BE(o + 11); if (o + 13 + len > b.length) break;
    out.push({ type: b[o], version: b.readUInt16BE(o + 1), epoch: b.readUInt16BE(o + 3), seq: b.readUIntBE(o + 5, 6), fragment: b.subarray(o + 13, o + 13 + len) }); o += 13 + len; }
  return out;
}
/** A handshake message, whole (one fragment): type, length, message_seq, fragment_offset 0, fragment_length, body. */
export function handshake(type, msgSeq, body) {
  const h = Buffer.alloc(12); h[0] = type; h.writeUIntBE(body.length, 1, 3); h.writeUInt16BE(msgSeq, 4); h.writeUIntBE(0, 6, 3); h.writeUIntBE(body.length, 9, 3); return Buffer.concat([h, body]);
}
/** The handshake fragments in a record. */
export function parseHandshakes(f) {
  const out = []; let o = 0;
  while (o + 12 <= f.length) { const fl = f.readUIntBE(o + 9, 3); if (o + 12 + fl > f.length) break;
    out.push({ type: f[o], length: f.readUIntBE(o + 1, 3), msgSeq: f.readUInt16BE(o + 4), offset: f.readUIntBE(o + 6, 3), body: f.subarray(o + 12, o + 12 + fl) }); o += 12 + fl; }
  return out;
}
/** AES-128-GCM record protection (RFC 5288 3), with the explicit nonce = epoch + sequence number. */
export function sealRecord(type, epoch, seq, plain, key, salt) {
  const explicit = seq8(epoch, seq), aad = Buffer.alloc(13); explicit.copy(aad, 0); aad[8] = type; aad.writeUInt16BE(DTLS_1_2, 9); aad.writeUInt16BE(plain.length, 11);
  const c = crypto.createCipheriv("aes-128-gcm", key, Buffer.concat([salt, explicit])); c.setAAD(aad);
  return record(type, epoch, seq, Buffer.concat([explicit, c.update(plain), c.final(), c.getAuthTag()]));
}
/** Decrypt a parsed record; throws when it doesn't authenticate. */
export function openRecord(r, key, salt) {
  const f = r.fragment; if (f.length < 24) throw new Error("record too short");
  const explicit = f.subarray(0, 8), ct = f.subarray(8, f.length - 16), tag = f.subarray(f.length - 16), aad = Buffer.alloc(13);
  seq8(r.epoch, r.seq).copy(aad, 0); aad[8] = r.type; aad.writeUInt16BE(r.version, 9); aad.writeUInt16BE(ct.length, 11);
  const d = crypto.createDecipheriv("aes-128-gcm", key, Buffer.concat([salt, explicit])); d.setAAD(aad); d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

export function clientHelloBody(random, cookie = Buffer.alloc(0)) {
  return Buffer.concat([Buffer.from([0xfe, 0xfd]), random, Buffer.from([0]), Buffer.from([cookie.length]), cookie,
    Buffer.from([0, 2, TLS_PSK_WITH_AES_128_GCM_SHA256 >> 8, TLS_PSK_WITH_AES_128_GCM_SHA256 & 255]), Buffer.from([1, 0])]); // no session id; one cipher suite; no compression; no extensions
}
const ALERTS = { 10: "unexpected message", 20: "bad record MAC", 40: "handshake failure", 47: "illegal parameter", 51: "decrypt error", 70: "protocol version", 71: "insufficient security", 80: "internal error", 115: "unknown PSK identity" };

/**
 * A DTLS 1.2 PSK client. connect() resolves when the handshake is done; send() then sends application data.
 * Events: "close" (an alert from the server, an error, or close()), "data" (application data from the server).
 */
export class DtlsClient extends EventEmitter {
  /** @param {{host:string, port:number, identity:string|Buffer, psk:Buffer, timeoutMs?:number, retransmitMs?:number}} o */
  constructor(o) {
    super(); this.host = o.host; this.port = o.port; this.identity = Buffer.from(o.identity); this.psk = Buffer.from(o.psk);
    this.timeoutMs = o.timeoutMs || 10000; this.retransmitMs = o.retransmitMs || 1000; this.sent = 0;
    this.seq = [0, 0]; this.epoch = 0; this.msgSeq = 0; this.recvSeq = 0; this.frags = new Map(); this.transcript = []; this.keys = null; this.state = "new"; this.closed = false;
    this.random = Buffer.concat([Buffer.alloc(4), crypto.randomBytes(28)]); this.random.writeUInt32BE(Math.floor(Date.now() / 1000), 0);
  }
  connect() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      this._resolve = resolve; this._reject = reject;
      const s = this.sock = dgram.createSocket("udp4"); s.on("error", e => this._fail(e)); s.on("message", (m, r) => { if (r.port === this.port) this._onDatagram(m); });
      s.connect(this.port, this.host, () => { this.state = "hello"; this._flight([this._hello(Buffer.alloc(0), true)]); });
      this.deadline = setTimeout(() => this._fail(new Error("DTLS handshake timed out")), this.timeoutMs);
    });
    return this.ready;
  }
  // ---- sending
  _rec(type, body) { const e = this.epoch, s = this.seq[e]++; return e ? sealRecord(type, e, s, body, this.keys.clientKey, this.keys.clientSalt) : record(type, 0, s, body); }
  _hello(cookie, first) { const m = handshake(HT.clientHello, this.msgSeq++, clientHelloBody(this.random, cookie)); this.transcript = [m]; void first; return { type: CT.handshake, epoch: 0, body: m }; }
  /** Send a flight; send it again (new record numbers, same messages) until the server's answer arrives. */
  _flight(items) {
    this.flightItems = items; clearTimeout(this.rtx); let wait = this.retransmitMs;
    const go = () => { if (this.closed || this.flightItems !== items) return;
      const saved = this.epoch, out = items.map(it => { this.epoch = it.epoch; return this._rec(it.type, it.body); }); this.epoch = saved;
      try { this.sock.send(Buffer.concat(out)); } catch {} this.rtx = setTimeout(go, wait); wait = Math.min(wait * 2, 8000); this.rtx.unref?.(); };
    go();
  }
  // ---- receiving
  _onDatagram(m) {
    for (const r of parseRecords(m)) {
      try {
        if (r.type === CT.alert) { const body = r.epoch && this.keys ? openRecord(r, this.keys.serverKey, this.keys.serverSalt) : r.fragment;
          if (body[0] === 2 || body[1] === 0) return this._fail(new Error(`DTLS alert from the server: ${ALERTS[body[1]] || body[1]}`)); continue; }
        if (r.epoch === 1) {
          if (!this.keys) continue; const body = openRecord(r, this.keys.serverKey, this.keys.serverSalt);
          if (r.type === CT.handshake) this._onHandshakeRecord(body, true);
          else if (r.type === CT.applicationData && this.state === "open") this.emit("data", body);
          continue;
        }
        if (r.type === CT.changeCipherSpec) { if (this.state === "finished") this.serverCcs = true; continue; }
        if (r.type === CT.handshake) this._onHandshakeRecord(r.fragment, false);
      } catch (e) { if (this.state !== "open") this._fail(e); } // a record that doesn't decrypt after the handshake is dropped (RFC 6347 4.1.2.7)
    }
  }
  _onHandshakeRecord(f, encrypted) {
    for (const h of parseHandshakes(f)) {
      if (h.type === HT.serverHello && this.state === "hello" && h.msgSeq < this.recvSeq) { this.recvSeq = h.msgSeq; this.frags.clear(); } // a server that numbers ServerHello 0 after the cookie exchange
      if (h.msgSeq < this.recvSeq) { // the server repeats its flight: ours was lost, send it again (once for the whole flight)
        if (this.state === "finished" && !encrypted && this.flightItems && Date.now() - (this.dupAt || 0) > 300) { this.dupAt = Date.now(); this._flight(this.flightItems); } continue; }
      let fr = this.frags.get(h.msgSeq); if (!fr) this.frags.set(h.msgSeq, fr = { type: h.type, body: Buffer.alloc(h.length), have: [] });
      h.body.copy(fr.body, h.offset); fr.have.push([h.offset, h.offset + h.body.length]);
      while (this.frags.has(this.recvSeq)) { const x = this.frags.get(this.recvSeq); if (!covered(x.have, x.body.length)) break;
        this.frags.delete(this.recvSeq); const seq = this.recvSeq++; this._onMessage(x.type, x.body, handshake(x.type, seq, x.body)); }
    }
  }
  _onMessage(type, body, whole) {
    if (type === HT.helloVerifyRequest && this.state === "hello") { // the cookie exchange: start the transcript again with the new ClientHello
      const cookie = body.subarray(3, 3 + body[2]); this._flight([this._hello(cookie, false)]); return; }
    if (type === HT.serverHello && this.state === "hello") {
      const sidLen = body[34], suite = body.readUInt16BE(35 + sidLen);
      if (suite !== TLS_PSK_WITH_AES_128_GCM_SHA256) throw new Error(`the server chose cipher suite 0x${suite.toString(16)}`);
      this.serverRandom = Buffer.from(body.subarray(2, 34)); this.transcript.push(whole); this.state = "server"; clearTimeout(this.rtx); return; }
    if (type === HT.serverKeyExchange && this.state === "server") { this.transcript.push(whole); return; } // a PSK identity hint: not needed
    if (type === HT.serverHelloDone && this.state === "server") {
      this.transcript.push(whole); this.keys = deriveKeys(this.psk, this.random, this.serverRandom);
      const id = Buffer.alloc(2 + this.identity.length); id.writeUInt16BE(this.identity.length, 0); this.identity.copy(id, 2);
      const cke = handshake(HT.clientKeyExchange, this.msgSeq++, id); this.transcript.push(cke);
      const verify = prf(this.keys.master, "client finished", sha256(this.transcript), 12), fin = handshake(HT.finished, this.msgSeq++, verify); this.transcript.push(fin);
      this.state = "finished";
      this._flight([{ type: CT.handshake, epoch: 0, body: cke }, { type: CT.changeCipherSpec, epoch: 0, body: Buffer.from([1]) }, { type: CT.handshake, epoch: 1, body: fin }]);
      this.epoch = 1; return; }
    if (type === HT.finished && this.state === "finished") {
      const want = prf(this.keys.master, "server finished", sha256(this.transcript), 12);
      if (!crypto.timingSafeEqual(want, body.subarray(0, 12))) throw new Error("the server's Finished doesn't match (wrong PSK?)");
      clearTimeout(this.rtx); clearTimeout(this.deadline); this.flightItems = null; this.state = "open"; this._resolve(this); return; }
    throw new Error(`unexpected handshake message ${type} while ${this.state}`);
  }
  /** Send application data (after connect()). */
  send(data) { if (this.state !== "open" || this.closed) return false; try { this.sock.send(this._rec(CT.applicationData, Buffer.from(data))); this.sent++; return true; } catch { return false; } }
  _fail(e) { if (this.closed) return; if (this.state !== "open") this._reject?.(e); this._end(e); }
  _end(e) { this.closed = true; this.state = "closed"; clearTimeout(this.rtx); clearTimeout(this.deadline); try { this.sock?.close(); } catch {} this.emit("close", e || null); }
  /** close_notify, then close the socket */
  close() { if (this.closed) return; if (this.state === "open") try { this.sock.send(this._rec(CT.alert, Buffer.from([1, 0]))); } catch {} this._end(null); }
}
const sha256 = parts => crypto.createHash("sha256").update(Buffer.concat(parts)).digest();
function covered(ranges, len) { const r = [...ranges].sort((a, b) => a[0] - b[0]); let end = 0; for (const [a, b] of r) { if (a > end) return false; end = Math.max(end, b); } return end >= len; }
