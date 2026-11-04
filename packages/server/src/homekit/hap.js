// A HomeKit Accessory Protocol (HAP) server over IP, written from the public HAP specification (non-commercial
// version, R2) with HAP-NodeJS and Apple's HomeKitADK as references (no code taken from them):
//
//   Pair Setup   (POST /pair-setup, M1-M6): SRP-6a with the setup code, then both sides swap Ed25519 long-term keys
//                inside a ChaCha20-Poly1305 message. Only one controller pairs this way; it becomes the admin.
//   Pair Verify  (POST /pair-verify, M1-M4): X25519 key agreement signed with the long-term keys, at every connection.
//   Session      after Pair Verify, everything on the TCP connection is in frames: a 2-byte little-endian length (also
//                the AAD), up to 1024 bytes of ChaCha20-Poly1305 ciphertext and a 16-byte tag, with a 64-bit counter
//                nonce for each direction.
//   HTTP         GET /accessories, GET and PUT /characteristics, POST /pairings (add, remove, list), POST /identify,
//                and EVENT/1.0 messages to controllers that asked for events on a characteristic.
//
// What the bridge offers comes from `db()`: [{aid, services: [{iid, type, characteristics: [{iid, type, perms, format,
// get(), set(v, ctx)?, ...meta}]}]}]. The server knows nothing about Tempolight.
import net from "node:net";
import { encode, decode, decodeList, T, ERR, METHOD } from "./tlv.js";
import { srpServer } from "./srp.js";
import { hkdf, nonce, seal, open, edSign, edVerify, xKeyPair, xShared } from "./hapcrypto.js";

export const STATUS = { OK: 0, InsufficientPrivileges: -70401, CommunicationFailure: -70402, Busy: -70403, ReadOnly: -70404, WriteOnly: -70405,
  NotificationNotSupported: -70406, OutOfResources: -70407, Timeout: -70408, NotFound: -70409, InvalidValue: -70410, InsufficientAuthorization: -70411 };
const REASON = { 200: "OK", 204: "No Content", 207: "Multi-Status", 400: "Bad Request", 404: "Not Found", 405: "Method Not Allowed", 422: "Unprocessable Entity", 429: "Too Many Requests", 470: "Connection Authorization Required", 500: "Internal Server Error", 503: "Service Unavailable" };
const MAX_FRAME = 1024, MAX_PAIRINGS = 16, MAX_TRIES = 100;
const META = ["format", "unit", "minValue", "maxValue", "minStep", "maxLen", "validValues"];

/** Make a value fit a characteristic's format and range; undefined when it can't. */
export function coerce(ch, v) {
  switch (ch.format) {
    case "bool": if (v === true || v === 1 || v === "1" || v === "true") return true; if (v === false || v === 0 || v === "0" || v === "false") return false; return undefined;
    case "uint8": case "uint16": case "uint32": case "uint64": case "int": case "float": {
      const n = typeof v === "boolean" ? Number(v) : typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
      if (!Number.isFinite(n)) return undefined;
      let x = ch.format === "float" ? n : Math.round(n);
      if (ch.minValue !== undefined && x < ch.minValue) x = ch.minValue; if (ch.maxValue !== undefined && x > ch.maxValue) x = ch.maxValue;
      if (ch.validValues && !ch.validValues.includes(x)) return undefined;
      return x;
    }
    case "string": return typeof v === "string" ? v.slice(0, ch.maxLen || 64) : undefined;
    default: return v;
  }
}

/**
 * o: {state: {deviceId, seed, pub, pairings: [{id, pub: hex, admin}]}, save(), setupCode, db(), onPairingsChanged?(),
 *     onIdentify?(), log?(msg, level)}
 * Returns {listen(port, host), close(), notify(), connections, port}
 */
export function createHapServer(o) {
  const st = o.state, log = o.log || (() => {}), conns = new Set();
  let setup = null, tries = 0; // the one Pair Setup in progress (its connection), and failed setup codes since start
  const cache = new Map(); // "aid.iid" -> the last value told to controllers
  const paired = () => st.pairings.length > 0;
  const pairingOf = id => st.pairings.find(p => p.id === id);

  // ---------------------------------------------------------------- accessory database
  function index() { const m = new Map(); for (const a of o.db()) for (const s of a.services) for (const c of s.characteristics) m.set(`${a.aid}.${c.iid}`, { a, s, c }); return m; }
  const read = c => { try { return c.get ? c.get() : c.value; } catch { return undefined; } };
  function charJson(aid, c, { meta = true, perms = true, type = true, ev = null } = {}) {
    const j = { aid, iid: c.iid }; if (type) j.type = c.type; if (perms) j.perms = c.perms;
    if (c.perms.includes("pr")) j.value = read(c) ?? null;
    if (meta) for (const k of META) if (c[k] !== undefined) j[k] = c[k];
    if (ev !== null) j.ev = ev;
    return j;
  }
  function accessoriesJson(conn) {
    return { accessories: o.db().map(a => ({ aid: a.aid, services: a.services.map(s => {
      const j = { iid: s.iid, type: s.type, characteristics: s.characteristics.map(c => { const x = charJson(a.aid, c); delete x.aid; if (c.perms.includes("ev")) x.ev = conn.events.has(`${a.aid}.${c.iid}`); return x; }) };
      if (s.primary) j.primary = true; if (s.hidden) j.hidden = true; if (s.linked) j.linked = s.linked; return j; }) })) };
  }

  // ---------------------------------------------------------------- connections, frames and HTTP
  function onConnection(sock) {
    const conn = { sock, ebuf: Buffer.alloc(0), pbuf: Buffer.alloc(0), enc: null, events: new Set(), wrote: new Map(), controller: null, verify: null, queue: Promise.resolve(), addr: sock.remoteAddress };
    conns.add(conn); sock.setNoDelay(true); sock.setKeepAlive(true, 30000);
    sock.setTimeout(10 * 60_000, () => { if (!conn.controller) sock.destroy(); }); // a connection that never verified
    sock.on("data", d => { try { feed(conn, d); } catch (e) { log(`HomeKit: dropped a connection (${e.message})`, "warn"); sock.destroy(); } });
    sock.on("close", () => { conns.delete(conn); if (setup && setup.conn === conn) setup = null; });
    sock.on("error", () => {});
  }
  function feed(conn, d) {
    if (!conn.enc) conn.pbuf = Buffer.concat([conn.pbuf, d]);
    else {
      conn.ebuf = Buffer.concat([conn.ebuf, d]);
      while (conn.ebuf.length >= 2) {
        const len = conn.ebuf.readUInt16LE(0); if (len > MAX_FRAME) throw new Error("frame too long");
        if (conn.ebuf.length < 2 + len + 16) break;
        const aad = conn.ebuf.subarray(0, 2), plain = open(conn.enc.readKey, nonce(conn.enc.rc++), conn.ebuf.subarray(2, 2 + len + 16), aad);
        if (!plain) throw new Error("a frame didn't decrypt");
        conn.pbuf = Buffer.concat([conn.pbuf, plain]); conn.ebuf = conn.ebuf.subarray(2 + len + 16);
      }
    }
    for (;;) {
      const end = conn.pbuf.indexOf("\r\n\r\n"); if (end < 0) { if (conn.pbuf.length > 65536) throw new Error("request too long"); return; }
      const lines = conn.pbuf.toString("latin1", 0, end).split("\r\n"), [method, target] = lines[0].split(" "), headers = {};
      for (const l of lines.slice(1)) { const i = l.indexOf(":"); if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
      const len = Number(headers["content-length"] || 0); if (!(len >= 0 && len < 1 << 20)) throw new Error("bad length");
      if (conn.pbuf.length < end + 4 + len) return;
      const body = conn.pbuf.subarray(end + 4, end + 4 + len); conn.pbuf = conn.pbuf.subarray(end + 4 + len);
      conn.queue = conn.queue.then(() => handle(conn, method, target, headers, Buffer.from(body))).catch(e => { log(`HomeKit: ${e.message}`, "warn"); reply(conn, 500, { status: STATUS.CommunicationFailure }); });
    }
  }
  function send(conn, data) {
    if (conn.sock.destroyed) return;
    if (!conn.enc) { conn.sock.write(data); return; }
    const out = [];
    for (let i = 0; i < data.length; i += MAX_FRAME) {
      const chunk = data.subarray(i, i + MAX_FRAME), aad = Buffer.alloc(2); aad.writeUInt16LE(chunk.length);
      out.push(aad, seal(conn.enc.writeKey, nonce(conn.enc.wc++), chunk, aad));
    }
    conn.sock.write(Buffer.concat(out));
  }
  function reply(conn, code, body, type = "application/hap+json", proto = "HTTP/1.1") {
    const b = body === undefined || code === 204 ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const head = `${proto} ${code} ${REASON[code] || "OK"}\r\n` + (code === 204 ? "" : `Content-Type: ${type}\r\nContent-Length: ${b.length}\r\n`) + "\r\n";
    send(conn, Buffer.concat([Buffer.from(head, "latin1"), b]));
  }
  const tlvReply = (conn, items) => reply(conn, 200, encode(items), "application/pairing+tlv8");

  async function handle(conn, method, target, headers, body) {
    const url = new URL(target || "/", "http://hap"), p = url.pathname;
    if (p === "/pair-setup" && method === "POST") return pairSetup(conn, decode(body));
    if (p === "/pair-verify" && method === "POST") return pairVerify(conn, decode(body));
    if (p === "/identify" && method === "POST") { if (paired()) return reply(conn, 400, { status: STATUS.InsufficientPrivileges }); o.onIdentify?.(); return reply(conn, 204); }
    if (!conn.controller) return reply(conn, 470, { status: STATUS.InsufficientPrivileges });
    if (p === "/accessories" && method === "GET") return reply(conn, 200, accessoriesJson(conn));
    if (p === "/characteristics" && method === "GET") return getChars(conn, url.searchParams);
    if (p === "/characteristics" && method === "PUT") return putChars(conn, body);
    if (p === "/pairings" && method === "POST") return pairings(conn, decode(body));
    if (p === "/prepare" && method === "PUT") return reply(conn, 200, { status: STATUS.OK }); // timed writes: nothing here needs them
    return reply(conn, 404, { status: STATUS.NotFound });
  }

  // ---------------------------------------------------------------- Pair Setup
  function pairSetup(conn, t) {
    const state = t[T.State]?.[0];
    const fail = (s, err) => tlvReply(conn, [[T.State, s], [T.Error, err]]);
    if (state === 1) {
      if (paired()) return fail(2, ERR.Unavailable);
      if (tries >= MAX_TRIES) return fail(2, ERR.MaxTries);
      if (setup && setup.conn !== conn && !setup.conn.sock.destroyed && Date.now() - setup.at < 60_000) return fail(2, ERR.Busy);
      const srp = srpServer({ P: o.setupCode() });
      setup = { conn, srp, at: Date.now(), step: 2 };
      return tlvReply(conn, [[T.State, 2], [T.PublicKey, srp.B], [T.Salt, srp.salt]]);
    }
    if (!setup || setup.conn !== conn) return fail(state === 3 ? 4 : 6, ERR.Unknown);
    if (state === 3 && setup.step === 2) {
      const M2 = t[T.PublicKey] && t[T.Proof] ? setup.srp.check(t[T.PublicKey], t[T.Proof]) : null;
      if (!M2) { tries++; setup = null; log("HomeKit: someone tried to pair with a wrong setup code", "warn"); return fail(4, ERR.Authentication); }
      setup.step = 4; return tlvReply(conn, [[T.State, 4], [T.Proof, M2]]);
    }
    if (state === 5 && setup.step === 4) {
      const K = setup.srp.K, key = hkdf(K, "Pair-Setup-Encrypt-Salt", "Pair-Setup-Encrypt-Info");
      const plain = t[T.EncryptedData] && open(key, nonce("PS-Msg05"), t[T.EncryptedData]);
      if (!plain) { setup = null; return fail(6, ERR.Authentication); }
      const sub = decode(plain), id = sub[T.Identifier], ltpk = sub[T.PublicKey], sig = sub[T.Signature];
      if (!id || !ltpk || !sig) { setup = null; return fail(6, ERR.Unknown); }
      const iosX = hkdf(K, "Pair-Setup-Controller-Sign-Salt", "Pair-Setup-Controller-Sign-Info");
      if (!edVerify(ltpk, Buffer.concat([iosX, id, ltpk]), sig)) { setup = null; return fail(6, ERR.Authentication); }
      st.pairings = [{ id: id.toString("utf8"), pub: ltpk.toString("hex"), admin: true }]; o.save();
      const accX = hkdf(K, "Pair-Setup-Accessory-Sign-Salt", "Pair-Setup-Accessory-Sign-Info"), accId = Buffer.from(st.deviceId, "utf8");
      const accSig = edSign(st, Buffer.concat([accX, accId, st.pub]));
      const enc = seal(key, nonce("PS-Msg06"), encode([[T.Identifier, accId], [T.PublicKey, st.pub], [T.Signature, accSig]]));
      setup = null; tries = 0;
      tlvReply(conn, [[T.State, 6], [T.EncryptedData, enc]]);
      log(`HomeKit: paired with a controller`); o.onPairingsChanged?.(); return;
    }
    setup = null; return fail(state + 1 || 2, ERR.Unknown);
  }

  // ---------------------------------------------------------------- Pair Verify
  function pairVerify(conn, t) {
    const state = t[T.State]?.[0], fail = s => { conn.verify = null; tlvReply(conn, [[T.State, s], [T.Error, ERR.Authentication]]); };
    if (state === 1) {
      const iosPub = t[T.PublicKey]; if (!iosPub || iosPub.length !== 32) return fail(2);
      const kp = xKeyPair(), shared = xShared(kp, iosPub), accId = Buffer.from(st.deviceId, "utf8");
      const sig = edSign(st, Buffer.concat([kp.pub, accId, iosPub])), key = hkdf(shared, "Pair-Verify-Encrypt-Salt", "Pair-Verify-Encrypt-Info");
      conn.verify = { shared, key, iosPub, accPub: kp.pub };
      return tlvReply(conn, [[T.State, 2], [T.PublicKey, kp.pub], [T.EncryptedData, seal(key, nonce("PV-Msg02"), encode([[T.Identifier, accId], [T.Signature, sig]]))]]);
    }
    if (state === 3 && conn.verify) {
      const v = conn.verify, plain = t[T.EncryptedData] && open(v.key, nonce("PV-Msg03"), t[T.EncryptedData]); if (!plain) return fail(4);
      const sub = decode(plain), id = sub[T.Identifier]?.toString("utf8"), sig = sub[T.Signature], p = id && pairingOf(id);
      if (!p || !sig || !edVerify(Buffer.from(p.pub, "hex"), Buffer.concat([v.iosPub, Buffer.from(id, "utf8"), v.accPub]), sig)) return fail(4);
      tlvReply(conn, [[T.State, 4]]); // the last plain message; from here on the connection is encrypted
      conn.enc = { readKey: hkdf(v.shared, "Control-Salt", "Control-Write-Encryption-Key"), writeKey: hkdf(v.shared, "Control-Salt", "Control-Read-Encryption-Key"), rc: 0n, wc: 0n };
      conn.controller = id; conn.verify = null; if (conn.pbuf.length) { const rest = conn.pbuf; conn.pbuf = Buffer.alloc(0); feed(conn, rest); } // bytes that came early were already encrypted
      return;
    }
    return fail((state || 1) + 1);
  }

  // ---------------------------------------------------------------- /pairings: add, remove, list (admins only)
  function pairings(conn, t) {
    const method = t[T.Method]?.[0], fail = err => tlvReply(conn, [[T.State, 2], [T.Error, err]]);
    if (!pairingOf(conn.controller)?.admin) return fail(ERR.Authentication);
    if (method === METHOD.AddPairing) {
      const id = t[T.Identifier]?.toString("utf8"), pub = t[T.PublicKey], admin = (t[T.Permissions]?.[0] || 0) === 1;
      if (!id || !pub || pub.length !== 32) return fail(ERR.Unknown);
      const p = pairingOf(id);
      if (p) { if (p.pub !== pub.toString("hex")) return fail(ERR.Unknown); p.admin = admin; }
      else { if (st.pairings.length >= MAX_PAIRINGS) return fail(ERR.MaxPeers); st.pairings.push({ id, pub: pub.toString("hex"), admin }); }
      o.save(); tlvReply(conn, [[T.State, 2]]); o.onPairingsChanged?.(); return;
    }
    if (method === METHOD.RemovePairing) {
      const id = t[T.Identifier]?.toString("utf8"); if (!id) return fail(ERR.Unknown);
      st.pairings = st.pairings.filter(p => p.id !== id);
      if (!st.pairings.some(p => p.admin)) st.pairings = []; // the last admin gone: the accessory is unpaired again
      o.save(); tlvReply(conn, [[T.State, 2]]);
      setTimeout(() => { for (const c of conns) if (c.controller && !pairingOf(c.controller)) c.sock.destroy(); }, 50); // after the reply went out
      o.onPairingsChanged?.(); return;
    }
    if (method === METHOD.ListPairings) {
      const items = [[T.State, 2]];
      st.pairings.forEach((p, i) => { if (i) items.push([T.Separator, Buffer.alloc(0)]); items.push([T.Identifier, p.id], [T.PublicKey, Buffer.from(p.pub, "hex")], [T.Permissions, p.admin ? 1 : 0]); });
      return tlvReply(conn, items);
    }
    return fail(ERR.Unknown);
  }

  // ---------------------------------------------------------------- characteristics
  function getChars(conn, q) {
    const ids = (q.get("id") || "").split(",").filter(Boolean).map(s => s.split(".").map(Number)), idx = index();
    const flags = { meta: q.get("meta") === "1", perms: q.get("perms") === "1", type: q.get("type") === "1" }, wantEv = q.get("ev") === "1";
    let bad = false;
    const out = ids.map(([aid, iid]) => {
      const e = idx.get(`${aid}.${iid}`); if (!e) { bad = true; return { aid, iid, status: STATUS.NotFound }; }
      if (!e.c.perms.includes("pr")) { bad = true; return { aid, iid, status: STATUS.WriteOnly }; }
      const j = charJson(aid, e.c, { ...flags, ev: wantEv ? conn.events.has(`${aid}.${iid}`) : null });
      if (j.value === null && read(e.c) === undefined) { bad = true; return { aid, iid, status: STATUS.CommunicationFailure }; }
      return j;
    });
    if (bad) out.forEach(j => { if (j.status === undefined) j.status = STATUS.OK; });
    return reply(conn, bad ? 207 : 200, { characteristics: out });
  }
  async function putChars(conn, body) {
    let req; try { req = JSON.parse(body.toString("utf8")); } catch { return reply(conn, 400, { status: STATUS.InvalidValue }); }
    const list = Array.isArray(req?.characteristics) ? req.characteristics : null; if (!list) return reply(conn, 400, { status: STATUS.InvalidValue });
    const idx = index(), results = [];
    for (const w of list) {
      const key = `${w.aid}.${w.iid}`, e = idx.get(key); let status = STATUS.OK;
      if (!e) status = STATUS.NotFound;
      else {
        if (w.ev !== undefined) { if (!e.c.perms.includes("ev")) status = STATUS.NotificationNotSupported; else if (w.ev) { conn.events.add(key); if (!cache.has(key)) cache.set(key, read(e.c)); } else conn.events.delete(key); }
        if (w.value !== undefined && status === STATUS.OK) {
          const v = coerce(e.c, w.value);
          if (!e.c.perms.includes("pw")) status = STATUS.ReadOnly;
          else if (v === undefined) status = STATUS.InvalidValue;
          else { conn.wrote.set(key, v); // the writer isn't told about its own change (the write itself may run notify())
            try { await e.c.set(v, { controller: conn.controller, batch: list }); } catch (err) { status = typeof err?.status === "number" ? err.status : STATUS.CommunicationFailure; } }
        }
      }
      results.push({ aid: w.aid, iid: w.iid, status });
    }
    if (results.every(r => r.status === STATUS.OK)) reply(conn, 204);
    else reply(conn, 207, { characteristics: results });
    setTimeout(() => { notify(); conn.wrote.clear(); }, 0); // and what else the write changed (a scene switch turning another off)
  }
  /** Tell controllers which characteristics they follow changed since last time (not the controller that wrote it). */
  function notify() {
    const idx = index(), changes = [];
    for (const [key, e] of idx) {
      if (!e.c.perms.includes("ev")) continue;
      const v = read(e.c); if (v === undefined) continue;
      if (!cache.has(key)) { cache.set(key, v); continue; }
      if (cache.get(key) !== v) { cache.set(key, v); changes.push({ key, aid: e.a.aid, iid: e.c.iid, value: v }); }
    }
    if (!changes.length) return 0;
    let n = 0;
    for (const c of conns) {
      if (!c.enc) continue;
      const mine = changes.filter(x => c.events.has(x.key) && !(c.wrote.has(x.key) && c.wrote.get(x.key) === x.value)).map(({ aid, iid, value }) => ({ aid, iid, value }));
      for (const x of changes) c.wrote.delete(x.key);
      if (mine.length) { reply(c, 200, { characteristics: mine }, "application/hap+json", "EVENT/1.0"); n++; }
    }
    return n;
  }

  const server = net.createServer(onConnection);
  return {
    server, connections: conns, notify,
    listen(port = 0, host) { return new Promise((res, rej) => { server.once("error", rej); server.listen(port, host, () => { server.removeListener("error", rej); res(server.address().port); }); }); },
    get port() { return server.address()?.port || 0; },
    /** Drop the connections of controllers that are no longer paired (after a reset). */
    dropUnpaired() { for (const c of conns) if (!c.controller || !pairingOf(c.controller)) c.sock.destroy(); },
    close() { return new Promise(r => { for (const c of conns) c.sock.destroy(); server.close(() => r()); }); },
  };
}

export { decodeList };
