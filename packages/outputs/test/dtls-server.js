// A small DTLS 1.2 PSK server for tests (dtls.test.js, and Hue fast mode in the server tests), written separately from
// the client in src/dtls.js: its own record and handshake code; only the PRF is shared, and that is checked against
// the published test vector in dtls.test.js.
import dgram from "node:dgram";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { prf } from "../src/dtls.js";

function u48(b, o) { return b.readUIntBE(o, 6); }
function rec(type, epoch, seq, frag) { const h = Buffer.alloc(13); h[0] = type; h.writeUInt16BE(0xfefd, 1); h.writeUInt16BE(epoch, 3); h.writeUIntBE(seq, 5, 6); h.writeUInt16BE(frag.length, 11); return Buffer.concat([h, frag]); }
function hsMsg(type, seq, body, off = 0, len = body.length) { const h = Buffer.alloc(12); h[0] = type; h.writeUIntBE(body.length, 1, 3); h.writeUInt16BE(seq, 4); h.writeUIntBE(off, 6, 3); h.writeUIntBE(len, 9, 3); return Buffer.concat([h, body.subarray(off, off + len)]); }
function gcm(enc, key, salt, epoch, seq, type, data) {
  const aad = Buffer.alloc(13); aad.writeUInt16BE(epoch, 0); aad.writeUIntBE(seq, 2, 6); aad[8] = type; aad.writeUInt16BE(0xfefd, 9);
  if (enc) { aad.writeUInt16BE(data.length, 11); const ex = aad.subarray(0, 8), c = crypto.createCipheriv("aes-128-gcm", key, Buffer.concat([salt, ex])); c.setAAD(aad); return Buffer.concat([ex, c.update(data), c.final(), c.getAuthTag()]); }
  const ex = data.subarray(0, 8), ct = data.subarray(8, -16); aad.writeUInt16BE(ct.length, 11); const d = crypto.createDecipheriv("aes-128-gcm", key, Buffer.concat([salt, ex])); d.setAAD(aad); d.setAuthTag(data.subarray(-16)); return Buffer.concat([d.update(ct), d.final()]);
}
export function pskServer({ psk, identity, cookie = true, hint = null, dropClientFlights = 0, fragmentHello = false } = {}) {
  const sock = dgram.createSocket("udp4"), S = { hellos: 0, verifies: 0, app: [], alerts: [], flight3: 0, done: false, errors: [] };
  let c = null; const myCookie = crypto.randomBytes(16);
  const sendRaw = (r, b) => sock.send(b, r.port, r.address);
  sock.on("message", (m, r) => {
    try {
      for (let o = 0; o + 13 <= m.length;) {
        const type = m[o], epoch = m.readUInt16BE(o + 3), seq = u48(m, o + 5), len = m.readUInt16BE(o + 11), frag = m.subarray(o + 13, o + 13 + len); o += 13 + len;
        if (type === 22 && epoch === 0) {
          const t = frag[0], body = frag.subarray(12);
          if (t === 1) { S.hellos++; // ClientHello: version 2, random 32, session id, cookie, suites, compression
            const sid = body[34], ck = body.subarray(36 + sid, 36 + sid + body[35 + sid]), suitesAt = 36 + sid + body[35 + sid], nSuites = body.readUInt16BE(suitesAt);
            const suites = []; for (let i = 0; i < nSuites; i += 2) suites.push(body.readUInt16BE(suitesAt + 2 + i)); assert.ok(suites.includes(0x00a8));
            if (cookie && !ck.equals(myCookie)) { S.verifies++; sendRaw(r, rec(22, 0, 0, hsMsg(3, 0, Buffer.concat([Buffer.from([0xfe, 0xfd, 16]), myCookie])))); continue; }
            const sRandom = crypto.randomBytes(32), seq0 = frag.readUInt16BE(4);
            c = { cRandom: Buffer.from(body.subarray(2, 34)), sRandom, tr: [Buffer.from(frag)], sSeq: [cookie ? 1 : 0, 0], next: seq0 + 1, mseq: cookie ? 1 : 0, ccs: false };
            const sh = Buffer.concat([Buffer.from([0xfe, 0xfd]), sRandom, Buffer.from([0, 0x00, 0xa8, 0])]), msgs = [hsMsg(2, c.mseq++, sh)];
            if (hint !== null) { const h = Buffer.from(hint); msgs.push(hsMsg(12, c.mseq++, Buffer.concat([Buffer.from([h.length >> 8, h.length & 255]), h]))); }
            msgs.push(hsMsg(14, c.mseq++, Buffer.alloc(0)));
            c.tr.push(...msgs); // as if each came in one fragment
            if (fragmentHello) { const shMsg = msgs[0], body2 = shMsg.subarray(12), seqN = shMsg.readUInt16BE(4); // ServerHello in two fragments, the second first, in separate datagrams
              sendRaw(r, rec(22, 0, c.sSeq[0]++, hsMsg(2, seqN, body2, 20, body2.length - 20))); sendRaw(r, rec(22, 0, c.sSeq[0]++, hsMsg(2, seqN, body2, 0, 20)));
              sendRaw(r, Buffer.concat(msgs.slice(1).map(x => rec(22, 0, c.sSeq[0]++, x)))); }
            else sendRaw(r, Buffer.concat(msgs.map(x => rec(22, 0, c.sSeq[0]++, x))));
          } else if (t === 16 && c) { // ClientKeyExchange: the PSK identity
            S.flight3++; if (S.flight3 <= dropClientFlights) return; // pretend the whole datagram was lost
            const id = body.subarray(2, 2 + body.readUInt16BE(0)).toString(); if (id !== identity) { sendRaw(r, rec(21, 0, c.sSeq[0]++, Buffer.from([2, 115]))); return; }
            if (!c.tr.some(x => x[0] === 16)) c.tr.push(Buffer.from(frag));
            const pms = Buffer.alloc(4 + 2 * psk.length); pms.writeUInt16BE(psk.length, 0); pms.writeUInt16BE(psk.length, 2 + psk.length); psk.copy(pms, 4 + psk.length);
            c.ms = prf(pms, "master secret", Buffer.concat([c.cRandom, c.sRandom]), 48); const kb = prf(c.ms, "key expansion", Buffer.concat([c.sRandom, c.cRandom]), 40);
            Object.assign(c, { ck: kb.subarray(0, 16), sk: kb.subarray(16, 32), cs: kb.subarray(32, 36), ss: kb.subarray(36, 40) });
          }
        } else if (type === 20 && epoch === 0) { if (c) c.ccs = true; }
        else if (epoch === 1 && c?.ck) {
          let plain; try { plain = gcm(false, c.ck, c.cs, 1, seq, type, frag); } catch { sendRaw(r, rec(21, 0, c.sSeq[0]++, Buffer.from([2, 51]))); return; } // another key: decrypt_error
          if (type === 22 && plain[0] === 20) { // client Finished
            assert.ok(c.ccs, "ChangeCipherSpec before Finished");
            const want = prf(c.ms, "client finished", crypto.createHash("sha256").update(Buffer.concat(c.tr)).digest(), 12);
            if (!want.equals(plain.subarray(12, 24))) { S.errors.push("client finished"); sendRaw(r, rec(21, 0, c.sSeq[0]++, Buffer.from([2, 51]))); return; }
            c.tr.push(Buffer.from(plain));
            const fin = hsMsg(20, c.mseq++, prf(c.ms, "server finished", crypto.createHash("sha256").update(Buffer.concat(c.tr)).digest(), 12));
            sendRaw(r, Buffer.concat([rec(20, 0, c.sSeq[0]++, Buffer.from([1])), rec(22, 1, c.sSeq[1], gcm(true, c.sk, c.ss, 1, c.sSeq[1]++, 22, fin))])); S.done = true;
          } else if (type === 23) S.app.push(plain); else if (type === 21) S.alerts.push([...plain]);
        }
      }
    } catch (e) { S.errors.push(e.message); }
  });
  return new Promise(res => sock.bind(0, "127.0.0.1", () => res({ port: sock.address().port, S, close: () => sock.close() })));
}

