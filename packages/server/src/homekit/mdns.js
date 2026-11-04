// A small mDNS / DNS-SD responder (RFC 6762, RFC 6763) that advertises one service, so iPhones find Tempolight's
// HomeKit bridge as _hap._tcp.local. It shares UDP 5353 with the computer's own responder (Avahi, mDNSResponder,
// Windows) through reuseAddr, answers questions for the service type, its instance and its host name, and announces
// itself when it starts or its TXT record changes (and says goodbye when it stops).
//
// It doesn't probe for name conflicts (RFC 6762 section 8): the instance and host names carry part of the random
// device ID, so a clash on one network is unlikely.
import dgram from "node:dgram";
import { MDNS_GROUP, MDNS_PORT, localIPv4 } from "../../../outputs/src/discover.js";

export const RR = { A: 1, PTR: 12, TXT: 16, SRV: 33, ANY: 255 };
const FLUSH = 0x8000, IN = 1;

export function encName(name) {
  const bufs = [];
  for (const p of name.replace(/\.$/, "").split(".")) { const b = Buffer.from(p, "utf8"); if (b.length > 63) throw new Error("DNS label too long"); bufs.push(Buffer.from([b.length]), b); }
  bufs.push(Buffer.from([0])); return Buffer.concat(bufs);
}
function readName(buf, off) {
  const labels = []; let jumped = false, end = off;
  for (let guard = 0; guard < 128; guard++) {
    const len = buf[off]; if (len === undefined) throw new Error("bad name");
    if ((len & 0xc0) === 0xc0) { if (!jumped) end = off + 2; jumped = true; off = buf.readUInt16BE(off) & 0x3fff; continue; }
    if (len === 0) { if (!jumped) end = off + 1; return { name: labels.join("."), end }; }
    labels.push(buf.toString("utf8", off + 1, off + 1 + len)); off += 1 + len;
  }
  throw new Error("bad name");
}
/** The header and questions of a DNS packet: {id, response, questions: [{name, type, unicast}]}. */
export function parseQuery(buf) {
  const id = buf.readUInt16BE(0), flags = buf.readUInt16BE(2), qd = buf.readUInt16BE(4), questions = []; let off = 12;
  for (let i = 0; i < qd; i++) { const { name, end } = readName(buf, off); questions.push({ name, type: buf.readUInt16BE(end), unicast: !!(buf.readUInt16BE(end + 2) & 0x8000), raw: buf.subarray(off, end + 4) }); off = end + 4; }
  return { id, response: !!(flags & 0x8000), questions };
}
/** A DNS response: answers and additional records [{name, type, ttl, data: Buffer, unique}]. */
export function encodeResponse({ id = 0, questions = [], answers = [], additional = [] }) {
  const h = Buffer.alloc(12); h.writeUInt16BE(id, 0); h.writeUInt16BE(0x8400, 2); // response, authoritative
  h.writeUInt16BE(questions.length, 4); h.writeUInt16BE(answers.length, 6); h.writeUInt16BE(additional.length, 10);
  const rr = r => { const head = Buffer.alloc(10); head.writeUInt16BE(r.type, 0); head.writeUInt16BE(IN | (r.unique ? FLUSH : 0), 2); head.writeUInt32BE(r.ttl, 4); head.writeUInt16BE(r.data.length, 8); return Buffer.concat([encName(r.name), head, r.data]); };
  return Buffer.concat([h, ...questions.map(q => q.raw), ...answers.map(rr), ...additional.map(rr)]);
}
const txtData = txt => Buffer.concat(Object.entries(txt).map(([k, v]) => { const b = Buffer.from(`${k}=${v}`, "utf8"); return Buffer.concat([Buffer.from([b.length]), b]); }));
const ipData = ip => Buffer.from(ip.split(".").map(Number));
const sameNet = (a, b, mask) => { const n = s => s.split(".").reduce((x, o) => (x << 8) + Number(o), 0) >>> 0; return ((n(a) ^ n(b)) & n(mask)) === 0; };

/**
 * The records of one service. o: {instance ("Tempolight 1A2B"), service ("_hap._tcp.local"), host ("Tempolight-1A2B.local"),
 * port, txt: {k: v}}; addresses: the IPv4 addresses to give.
 */
export function serviceRecords(o, addresses, ttlScale = 1) {
  const full = `${o.instance}.${o.service}`, t = s => Math.round(s * ttlScale);
  const srv = Buffer.alloc(6); srv.writeUInt16BE(0, 0); srv.writeUInt16BE(0, 2); srv.writeUInt16BE(o.port, 4);
  return {
    ptr: { name: o.service, type: RR.PTR, ttl: t(4500), data: encName(full) },
    srv: { name: full, type: RR.SRV, ttl: t(120), data: Buffer.concat([srv, encName(o.host)]), unique: true },
    txt: { name: full, type: RR.TXT, ttl: t(4500), data: txtData(o.txt), unique: true },
    a: addresses.map(ip => ({ name: o.host, type: RR.A, ttl: t(120), data: ipData(ip), unique: true })),
    meta: { name: "_services._dns-sd._udp.local", type: RR.PTR, ttl: t(4500), data: encName(o.service) },
  };
}

/**
 * The answer to a query packet, or null when none of its questions is about this service. from: the asker's address,
 * used to pick which of this computer's addresses to give. Returns {packet, unicast}.
 */
export function answer(query, o, { from = null, port = MDNS_PORT, interfaces = localIPv4() } = {}) {
  let q; try { q = parseQuery(query); } catch { return null; }
  if (q.response) return null;
  const near = from ? interfaces.filter(i => sameNet(i.address, from, i.netmask)).map(i => i.address) : [];
  const addrs = near.length ? near : from === "127.0.0.1" ? ["127.0.0.1"] : interfaces.map(i => i.address);
  const legacy = port !== MDNS_PORT; // a plain DNS resolver asking port 5353 directly: echo its ID and questions, short TTLs
  const R = serviceRecords(o, addrs), full = `${o.instance}.${o.service}`.toLowerCase();
  const answers = [], additional = [], add = (list, r) => { if (!list.includes(r)) list.push(r); };
  let unicast = legacy;
  for (const { name, type, unicast: qu } of q.questions) {
    const n = name.toLowerCase(), any = type === RR.ANY; let hit = true;
    if (n === o.service.toLowerCase() && (type === RR.PTR || any)) { add(answers, R.ptr); add(additional, R.srv); add(additional, R.txt); R.a.forEach(a => add(additional, a)); }
    else if (n === "_services._dns-sd._udp.local" && (type === RR.PTR || any)) add(answers, R.meta);
    else if (n === full && (type === RR.SRV || type === RR.TXT || any)) { if (type !== RR.TXT) { add(answers, R.srv); R.a.forEach(a => add(additional, a)); } if (type !== RR.SRV) add(answers, R.txt); }
    else if (n === o.host.toLowerCase() && (type === RR.A || any)) R.a.forEach(a => add(answers, a));
    else hit = false;
    if (hit && qu) unicast = true;
  }
  if (!answers.length) return null;
  const extra = additional.filter(r => !answers.includes(r)), ttl1 = r => legacy ? { ...r, ttl: 10, unique: false } : r;
  return { packet: encodeResponse({ id: legacy ? q.id : 0, questions: legacy ? q.questions : [], answers: answers.map(ttl1), additional: extra.map(ttl1) }), unicast };
}

/**
 * Advertise a service until close(). o: as serviceRecords, txt may change with update(txt). Returns
 * {update(txt), close(), error} (error: why port 5353 couldn't be used, or null).
 */
export async function advertise(o, { onError = () => {} } = {}) {
  let svc = { ...o }, closed = false, sock = null, joined = new Set(), timers = [];
  const ifaces = () => localIPv4();
  function join() { if (!sock) return; for (const { address } of ifaces()) if (!joined.has(address)) { try { sock.addMembership(MDNS_GROUP, address); joined.add(address); } catch {} } }
  function announce(goodbye = false) {
    if (!sock) return;
    for (const i of ifaces()) {
      const R = serviceRecords(svc, [i.address], goodbye ? 0 : 1);
      const pkt = encodeResponse({ answers: [R.ptr, R.srv, R.txt, ...R.a] });
      try { sock.setMulticastInterface(i.address); sock.send(pkt, MDNS_PORT, MDNS_GROUP, () => {}); } catch {}
    }
  }
  const twice = () => { announce(); timers.push(setTimeout(() => announce(), 1000), setTimeout(() => announce(), 3000)); };
  await new Promise(res => {
    const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
    s.once("error", e => { onError(`mDNS port 5353: ${e.message}`); try { s.close(); } catch {} res(); });
    s.bind(MDNS_PORT, () => { s.removeAllListeners("error"); s.on("error", () => {}); sock = s; res(); });
  });
  if (sock) {
    try { sock.setMulticastTTL(255); sock.setMulticastLoopback(true); } catch {}
    join();
    sock.on("message", (msg, rinfo) => {
      if (closed) return;
      const r = answer(msg, svc, { from: rinfo.address, port: rinfo.port }); if (!r) return;
      if (r.unicast) sock.send(r.packet, rinfo.port, rinfo.address, () => {});
      else { const i = ifaces().find(x => sameNet(x.address, rinfo.address, x.netmask)); try { if (i) sock.setMulticastInterface(i.address); } catch {} sock.send(r.packet, MDNS_PORT, MDNS_GROUP, () => {}); }
    });
    twice();
    timers.push(setInterval(join, 30000)); // a network that came up later (Wi-Fi joined after start)
  }
  return {
    error: sock ? null : "port 5353 unavailable",
    update(txt) { svc = { ...svc, ...(txt ? { txt } : {}) }; twice(); },
    close() { if (closed) return; closed = true; timers.forEach(t => { clearTimeout(t); clearInterval(t); }); if (!sock) return; announce(true); const s = sock; sock = null; setTimeout(() => { try { s.close(); } catch {} }, 50); },
  };
}
