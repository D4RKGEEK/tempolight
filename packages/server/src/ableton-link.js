// Ableton Link, listen-only: follow a Link session's tempo and beat (Ableton Live, Traktor, Bitwig, phone apps...).
// Tempolight never announces itself and never changes the session; it reads the peers' announcements and asks one of
// them what time it is on the session's clock.
//
// The wire format below is written from memory of Ableton's open-source Link (github.com/Ableton/link:
// include/ableton/discovery/v1/Messages.hpp, link/v1/Messages.hpp, link/Measurement.hpp, link/Timeline.hpp) and
// has not been checked against a real Live session from here. Everything is big-endian.
//
// Discovery: UDP multicast 224.76.78.75 port 20808. A message is "_asdp_v" + version 1, then
//   message type (1 alive, 2 response, 3 bye-bye), ttl in seconds, session group id (uint16, 0), node id (8 bytes),
//   then payload entries: 4-byte key, uint32 size, value. Peers send "alive" about 4 times a second. Entries:
//   'tmln' timeline: tempo as microseconds per beat (int64), beat origin (int64, micro-beats), time origin (int64,
//          microseconds on the session's "ghost" clock): beats(ghost) = beatOrigin + (ghost - timeOrigin) / tempo
//   'sess' session id (8 bytes: the node id of the peer that started the session)
//   'stst' start/stop state: playing (1 byte), beats (int64), time (int64)            (Link 3; may be absent)
//   'mep4' where the peer answers clock measurements: IPv4 address (4 bytes) + port (uint16)
//   Unknown entries are skipped by their size.
// Measurement: unicast UDP to 'mep4'. "_link_v" + version 1, message type (1 ping, 2 pong), payload entries.
//   ping: '__ht' our host time (int64 µs) and, after the first, '_pgt' the ghost time from the previous pong.
//   pong: 'sess' session id, '__gt' the peer's ghost time when it got the ping, then the ping's entries echoed back.
//   Each pong gives ghost - host as  gt - (now + ht) / 2  and, with _pgt,  (gt + pgt) / 2 - ht; the median of about
//   100 of them is the offset from our clock to the session's.
// Not known from the protocol: the quantum (beats per bar) is each app's own setting; Tempolight assumes 4, so the
// bar lines up when Live's quantum is 4 (the default) or 1. IPv6-only peers ('mep6') can't be measured here.
import dgram from "node:dgram";
import os from "node:os";

export const LINK_GROUP = "224.76.78.75", LINK_PORT = 20808;
export const DISCOVERY_HEADER = Buffer.from("_asdp_v\x01", "latin1"), MEASURE_HEADER = Buffer.from("_link_v\x01", "latin1");
export const ALIVE = 1, RESPONSE = 2, BYEBYE = 3, PING = 1, PONG = 2;

const fourcc = s => ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0;
const keyName = k => String.fromCharCode(k >>> 24, (k >>> 16) & 255, (k >>> 8) & 255, k & 255);
const i64 = v => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(Math.round(v))); return b; };
const r64 = (b, o = 0) => Number(b.readBigInt64BE(o));

/** Payload entries from `off` on: Map of key ("tmln") -> value bytes. A truncated entry ends it. */
export function parsePayload(buf, off) {
  const out = new Map();
  while (off + 8 <= buf.length) { const k = buf.readUInt32BE(off), n = buf.readUInt32BE(off + 4); off += 8; if (off + n > buf.length) break; out.set(keyName(k), buf.subarray(off, off + n)); off += n; }
  return out;
}
/** [[key, bytes], ...] -> payload bytes. */
export function payload(entries) {
  return Buffer.concat(entries.map(([k, v]) => { const h = Buffer.alloc(8); h.writeUInt32BE(fourcc(k), 0); h.writeUInt32BE(v.length, 4); return Buffer.concat([h, v]); }));
}
export const encodeTimeline = ({ microsPerBeat, beatOrigin, timeOrigin }) => Buffer.concat([i64(microsPerBeat), i64(beatOrigin), i64(timeOrigin)]);
export const decodeTimeline = b => b && b.length >= 24 ? { microsPerBeat: r64(b, 0), beatOrigin: r64(b, 8), timeOrigin: r64(b, 16) } : null;
const hex8 = b => b && b.length >= 8 ? b.subarray(0, 8).toString("hex") : null;

/** A discovery message: {type, ttl, group, nodeId (hex), timeline, sessionId (hex), playing (or null), endpoint} or null. */
export function parseDiscovery(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 20 || !buf.subarray(0, 8).equals(DISCOVERY_HEADER)) return null;
  const p = parsePayload(buf, 20), ss = p.get("stst"), ep = p.get("mep4");
  return { type: buf[8], ttl: buf[9], group: buf.readUInt16BE(10), nodeId: buf.subarray(12, 20).toString("hex"), timeline: decodeTimeline(p.get("tmln")), sessionId: hex8(p.get("sess")),
    playing: ss && ss.length >= 1 ? ss[0] !== 0 : null, endpoint: ep && ep.length >= 6 ? { address: [...ep.subarray(0, 4)].join("."), port: ep.readUInt16BE(4) } : null };
}
/** Make a discovery message (the fake peer in tests uses it; the follower never sends one). */
export function discoveryMessage({ type = ALIVE, ttl = 5, group = 0, nodeId, sessionId, timeline, playing = null, endpoint = null }) {
  const h = Buffer.alloc(20); DISCOVERY_HEADER.copy(h); h[8] = type; h[9] = ttl; h.writeUInt16BE(group, 10); Buffer.from(nodeId, "hex").copy(h, 12);
  if (type === BYEBYE) return h;
  const e = [];
  if (timeline) e.push(["tmln", encodeTimeline(timeline)]);
  if (sessionId) e.push(["sess", Buffer.from(sessionId, "hex")]);
  if (playing != null) e.push(["stst", Buffer.concat([Buffer.from([playing ? 1 : 0]), i64(0), i64(0)])]);
  if (endpoint) { const b = Buffer.alloc(6); endpoint.address.split(".").forEach((x, i) => { b[i] = Number(x); }); b.writeUInt16BE(endpoint.port, 4); e.push(["mep4", b]); }
  return Buffer.concat([h, payload(e)]);
}
/** A ping or pong: {type, hostTime, ghostTime, prevGhostTime, sessionId, payload} (0 for a missing time) or null. */
export function parseMeasurement(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 9 || !buf.subarray(0, 8).equals(MEASURE_HEADER)) return null;
  const p = parsePayload(buf, 9), v = k => { const b = p.get(k); return b && b.length >= 8 ? r64(b) : 0; };
  return { type: buf[8], hostTime: v("__ht"), ghostTime: v("__gt"), prevGhostTime: v("_pgt"), sessionId: hex8(p.get("sess")), payload: buf.subarray(9) };
}
export function pingMessage(hostTime, prevGhostTime = 0) {
  const e = [["__ht", i64(hostTime)]]; if (prevGhostTime) e.push(["_pgt", i64(prevGhostTime)]);
  return Buffer.concat([MEASURE_HEADER, Buffer.from([PING]), payload(e)]);
}
export const pongMessage = (sessionId, ghostTime, pingPayload) => Buffer.concat([MEASURE_HEADER, Buffer.from([PONG]), payload([["sess", Buffer.from(sessionId, "hex")], ["__gt", i64(ghostTime)]]), pingPayload]);
/** The estimates of (ghost - host) one pong gives, received at host time `now` (µs). */
export function pongPoints(m, now) {
  const out = []; if (!m.ghostTime || !m.hostTime) return out;
  out.push(m.ghostTime - (now + m.hostTime) / 2); if (m.prevGhostTime) out.push((m.ghostTime + m.prevGhostTime) / 2 - m.hostTime); return out;
}

/**
 * Follow the Link session on this network. onState({peers, sessions, sessionId, microsPerBeat, beatOrigin, timeOrigin,
 * offset (ghost µs - our µs), measured, playing, at, error}) about 4 times a second; our clock is now() in ms
 * (performance.now()), so the session's beat at our time T ms is beatOrigin/1e6 + (T*1000 + offset - timeOrigin) / microsPerBeat.
 * The session followed is the one with the most peers (the current one is kept while it has any).
 */
export function startLink({ onState, onError = null, port = LINK_PORT, group = LINK_GROUP, now = () => performance.now(), remeasureMs = 30000 } = {}) {
  const peers = new Map(); let session = null, offset = 0, measured = false, meas = null, nextMeasure = 0, error = null, closed = false;
  const host = () => Math.round(now() * 1000);
  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true }), msock = dgram.createSocket("udp4");
  const fail = e => { error = e.code === "EADDRINUSE" ? `UDP port ${port} is in use by an app that doesn't share it` : e.message; onError?.(error); };
  sock.on("error", e => { fail(e); try { sock.close(); } catch {} }); msock.on("error", fail);

  function update() {
    const t = now(); for (const [id, p] of peers) if (t > p.expires) peers.delete(id);
    const count = new Map(); for (const p of peers.values()) count.set(p.sessionId, (count.get(p.sessionId) || 0) + 1);
    if (!count.has(session)) { const best = [...count].sort((a, b) => b[1] - a[1])[0]; const s = best ? best[0] : null; if (s !== session) { session = s; measured = false; nextMeasure = 0; if (meas) { clearTimeout(meas.timer); meas = null; } } }
    if (session && !meas && t >= nextMeasure) measure();
    const mine = [...peers.values()].filter(p => p.sessionId === session).sort((a, b) => b.at - a.at), p = mine[0];
    onState?.({ peers: mine.length, sessions: count.size, sessionId: session, microsPerBeat: p ? p.timeline.microsPerBeat : 0, beatOrigin: p ? p.timeline.beatOrigin : 0, timeOrigin: p ? p.timeline.timeOrigin : 0,
      offset, measured, playing: p ? p.playing : null, at: p ? p.at : 0, error });
  }
  sock.on("message", (buf, rinfo) => {
    const m = parseDiscovery(buf); if (!m || m.group !== 0) return;
    if (m.type === BYEBYE) { if (peers.delete(m.nodeId)) update(); return; }
    if ((m.type !== ALIVE && m.type !== RESPONSE) || !m.timeline || !m.sessionId || !(m.timeline.microsPerBeat >= 60e6 / 999 && m.timeline.microsPerBeat <= 60e6 / 20)) return;
    const ep = m.endpoint ? { address: m.endpoint.address === "0.0.0.0" ? rinfo.address : m.endpoint.address, port: m.endpoint.port } : null;
    const old = peers.get(m.nodeId), changed = !old || old.timeline.microsPerBeat !== m.timeline.microsPerBeat || old.timeline.timeOrigin !== m.timeline.timeOrigin || old.sessionId !== m.sessionId;
    peers.set(m.nodeId, { ...m, ep, at: now(), expires: now() + Math.max(1, m.ttl || 5) * 1000 });
    if (changed) update();
  });

  // ---- clock measurement with one peer of the session
  function measure() {
    const p = [...peers.values()].filter(x => x.sessionId === session && x.ep).sort((a, b) => b.at - a.at)[0];
    if (!p) { nextMeasure = now() + 2000; if (!measured) error = "The Link peers give no address to measure their clock (IPv6 only?)"; return; }
    meas = { session, ep: p.ep, data: [], sent: 0, misses: 0, timer: null }; ping(host(), 0);
  }
  function ping(ht, pgt) {
    const m = meas; m.sent++; msock.send(pingMessage(ht, pgt), m.ep.port, m.ep.address, () => {});
    clearTimeout(m.timer); m.timer = setTimeout(() => { if (meas !== m) return; if (++m.misses > 5 || m.sent > 150) finish(); else ping(host(), 0); }, 100);
  }
  function finish() {
    const m = meas; if (!m) return; clearTimeout(m.timer); meas = null;
    const d = m.data.sort((a, b) => a - b);
    if (d.length >= 6 && m.session === session) { offset = d.length % 2 ? d[d.length >> 1] : (d[d.length / 2 - 1] + d[d.length / 2]) / 2; measured = true; error = null; nextMeasure = now() + remeasureMs; }
    else { if (!measured) error = "A Link peer didn't answer the clock measurement (a firewall blocking UDP?)"; nextMeasure = now() + 5000; }
    update();
  }
  msock.on("message", buf => {
    const m = parseMeasurement(buf), M = meas; if (!m || m.type !== PONG || !M || m.sessionId !== M.session) return;
    const cur = host(); M.misses = 0; M.data.push(...pongPoints(m, cur));
    if (M.data.length >= 100) finish(); else ping(cur, m.ghostTime);
  });

  sock.bind(port, () => {
    try { sock.setMulticastLoopback(true); } catch {}
    let joined = 0; for (const a of Object.values(os.networkInterfaces()).flat()) if (a && a.family === "IPv4") { try { sock.addMembership(group, a.address); joined++; } catch {} }
    if (!joined) try { sock.addMembership(group); } catch (e) { fail(e); }
  });
  msock.bind(0);
  const timer = setInterval(() => { if (!closed) update(); }, 250);
  return { close() { closed = true; clearInterval(timer); if (meas) clearTimeout(meas.timer); for (const s of [sock, msock]) try { s.close(); } catch {} }, get peers() { return peers.size; } };
}
