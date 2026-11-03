// Finding WLED controllers on the network, two ways:
//  1. mDNS: WLED announces itself as _wled._tcp.local (fast, works on most home networks)
//  2. a scan of the local /24 network for /json/info (slower, but works where multicast is blocked,
//     for example in some Docker setups, guest Wi-Fi or Windows with a strict firewall)
import dgram from "node:dgram";
import os from "node:os";
import { getInfo } from "./wled.js";

export const MDNS_GROUP = "224.0.0.251", MDNS_PORT = 5353;
const T = { A: 1, PTR: 12, TXT: 16, SRV: 33 };

function encName(name) {
  const parts = name.replace(/\.$/, "").split("."), bufs = [];
  for (const p of parts) { const b = Buffer.from(p, "utf8"); bufs.push(Buffer.from([b.length]), b); }
  bufs.push(Buffer.from([0])); return Buffer.concat(bufs);
}

/** A DNS query for PTR records of a service, asking for unicast replies (QU bit). */
export function mdnsQuery(service = "_wled._tcp.local") {
  const h = Buffer.alloc(12); h.writeUInt16BE(1, 4); // one question
  const q = Buffer.alloc(4); q.writeUInt16BE(T.PTR, 0); q.writeUInt16BE(0x8001, 2); // class IN + unicast-response bit
  return Buffer.concat([h, encName(service), q]);
}

function readName(buf, off) {
  const labels = []; let jumped = false, end = off, guard = 0;
  while (guard++ < 128) {
    const len = buf[off];
    if (len === undefined) throw new Error("bad name");
    if ((len & 0xc0) === 0xc0) { const ptr = buf.readUInt16BE(off) & 0x3fff; if (!jumped) end = off + 2; jumped = true; off = ptr; continue; }
    if (len === 0) { if (!jumped) end = off + 1; break; }
    labels.push(buf.toString("utf8", off + 1, off + 1 + len)); off += 1 + len;
  }
  return { name: labels.join("."), end };
}

/** Parse an mDNS/DNS packet into its records. */
export function parseDns(buf) {
  const qd = buf.readUInt16BE(4), an = buf.readUInt16BE(6), ns = buf.readUInt16BE(8), ar = buf.readUInt16BE(10);
  let off = 12;
  for (let i = 0; i < qd; i++) { off = readName(buf, off).end + 4; }
  const records = [];
  for (let i = 0; i < an + ns + ar; i++) {
    const { name, end } = readName(buf, off); off = end;
    const type = buf.readUInt16BE(off), ttl = buf.readUInt32BE(off + 4), len = buf.readUInt16BE(off + 8), d = off + 10;
    let data = null;
    if (type === T.A && len === 4) data = `${buf[d]}.${buf[d + 1]}.${buf[d + 2]}.${buf[d + 3]}`;
    else if (type === T.PTR) data = readName(buf, d).name;
    else if (type === T.SRV) data = { priority: buf.readUInt16BE(d), weight: buf.readUInt16BE(d + 2), port: buf.readUInt16BE(d + 4), target: readName(buf, d + 6).name };
    else if (type === T.TXT) { data = []; for (let p = d; p < d + len;) { const l = buf[p]; data.push(buf.toString("utf8", p + 1, p + 1 + l)); p += 1 + l; } }
    records.push({ name, type, ttl, data }); off = d + len;
  }
  return records;
}

/** Turn the records of one or more replies into devices: {name, ip, port}. */
export function devicesFromRecords(records, service = "_wled._tcp.local") {
  const ptr = records.filter(r => r.type === T.PTR && r.name.toLowerCase() === service.toLowerCase()).map(r => r.data);
  const out = [];
  for (const inst of new Set(ptr)) {
    const srv = records.find(r => r.type === T.SRV && r.name === inst)?.data;
    const target = srv?.target, a = records.find(r => r.type === T.A && (r.name === target || r.name === inst))?.data;
    if (a) out.push({ name: inst.replace("." + service, ""), ip: a, port: srv?.port || 80, hostname: target });
  }
  return out;
}

/** Ask the network for WLED controllers over mDNS. Resolves after `timeoutMs` with whatever answered. */
export async function mdnsDiscover({ timeoutMs = 2500, service = "_wled._tcp.local" } = {}) {
  const records = [];
  // port 5353 is often taken by the OS's own responder; then a random port still works, because the QU bit asks for unicast replies
  const open = port => new Promise(res => {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    sock.once("error", () => { try { sock.close(); } catch {} res(null); });
    sock.bind(port, () => { sock.removeAllListeners("error"); sock.on("error", () => {}); res(sock); });
  });
  const sock = (await open(MDNS_PORT)) || (await open(0));
  if (!sock) return [];
  sock.on("message", msg => { try { records.push(...parseDns(msg)); } catch { /* not a DNS packet */ } });
  try { for (const { address } of localIPv4()) { try { sock.addMembership(MDNS_GROUP, address); } catch {} } sock.setMulticastTTL(255); } catch {}
  const q = mdnsQuery(service), send = () => { try { sock.send(q, MDNS_PORT, MDNS_GROUP, () => {}); } catch {} };
  send(); const t2 = setTimeout(send, 600);
  await new Promise(r => setTimeout(r, timeoutMs)); clearTimeout(t2);
  try { sock.close(); } catch {}
  return devicesFromRecords(records, service);
}

/** IPv4 addresses of this machine's network interfaces (no loopback). */
export function localIPv4() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) if (a.family === "IPv4" && !a.internal) out.push({ name, address: a.address, netmask: a.netmask });
  return out;
}

/** Every address in the /24 around each local IPv4 address. */
export function subnetHosts() {
  const hosts = new Set();
  for (const { address } of localIPv4()) { const p = address.split(".").slice(0, 3).join("."); for (let i = 1; i < 255; i++) { const h = `${p}.${i}`; if (h !== address) hosts.add(h); } }
  return [...hosts];
}

/** Probe hosts for WLED's /json/info. */
export async function scanHosts(hosts, { timeoutMs = 800, concurrency = 48 } = {}) {
  const found = [], queue = hosts.slice();
  async function worker() { while (queue.length) { const h = queue.shift(); try { const info = await getInfo(h, timeoutMs); if (info.version || info.leds) found.push({ ip: h, name: info.name, leds: info.leds, version: info.version }); } catch {} } }
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
  return found;
}

/**
 * Find WLED controllers with mDNS and a network scan at the same time; returns one entry per address with
 * the name, LED count and firmware read from the device itself.
 */
export async function discoverWled({ scan = true, timeoutMs = 2500, extraHosts = [] } = {}) {
  const [m, s] = await Promise.all([mdnsDiscover({ timeoutMs }), scan ? scanHosts(subnetHosts().concat(extraHosts), { timeoutMs: 800 }) : scanHosts(extraHosts)]);
  const byIp = new Map();
  for (const d of s) byIp.set(d.ip, { ...d, via: "scan" });
  for (const d of m) { const host = d.port && d.port !== 80 ? `${d.ip}:${d.port}` : d.ip;
    if (!byIp.has(d.ip)) { try { const info = await getInfo(host, 1500); byIp.set(d.ip, { ip: d.ip, host, name: info.name || d.name, leds: info.leds, version: info.version, via: "mdns" }); } catch { byIp.set(d.ip, { ip: d.ip, host, name: d.name, via: "mdns" }); } }
    else byIp.get(d.ip).via = "mdns"; }
  return [...byIp.values()].map(d => ({ ...d, host: d.host || d.ip }));
}
