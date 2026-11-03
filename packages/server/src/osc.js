// OSC (Open Sound Control) over UDP, so lighting desks, TouchOSC, Ableton/Max, Companion or a Stream Deck can
// drive Tempolight. Only the parts of OSC 1.0 we need: messages and bundles with i, f, s, T, F arguments.
import dgram from "node:dgram";

const pad4 = n => (n + 3) & ~3;
function readStr(b, o) { let e = o; while (e < b.length && b[e] !== 0) e++; return { s: b.toString("utf8", o, e), o: pad4(e + 1) }; }

/** Parse a packet into a list of {address, args}. */
export function parseOsc(buf) {
  if (buf.toString("ascii", 0, 7) === "#bundle") {
    const out = []; let o = 16;
    while (o + 4 <= buf.length) { const n = buf.readInt32BE(o); out.push(...parseOsc(buf.subarray(o + 4, o + 4 + n))); o += 4 + n; }
    return out;
  }
  const a = readStr(buf, 0); let o = a.o, tags = ",";
  if (o < buf.length && buf[o] === 0x2c) { const t = readStr(buf, o); tags = t.s; o = t.o; }
  const args = [];
  for (const c of tags.slice(1)) {
    if (c === "i") { args.push(buf.readInt32BE(o)); o += 4; } else if (c === "f") { args.push(buf.readFloatBE(o)); o += 4; }
    else if (c === "s") { const s = readStr(buf, o); args.push(s.s); o = s.o; } else if (c === "T") args.push(true); else if (c === "F") args.push(false);
    else if (c === "d") { args.push(buf.readDoubleBE(o)); o += 8; }
  }
  return [{ address: a.s, args }];
}

/** Build an OSC message (used by tests and the docs examples). */
export function oscMessage(address, ...args) {
  const str = s => { const b = Buffer.from(s + "\0"); const p = Buffer.alloc(pad4(b.length)); b.copy(p); return p; };
  const parts = [str(address)]; let tags = ",";
  const data = args.map(v => { if (typeof v === "string") { tags += "s"; return str(v); } if (Number.isInteger(v)) { tags += "i"; const b = Buffer.alloc(4); b.writeInt32BE(v); return b; } tags += "f"; const b = Buffer.alloc(4); b.writeFloatBE(v); return b; });
  return Buffer.concat([...parts, str(tags), ...data]);
}

export function startOsc(port, onMessage) {
  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  sock.on("message", m => { try { for (const msg of parseOsc(m)) onMessage(msg); } catch {} });
  sock.on("error", e => console.warn(`OSC: ${e.message}`));
  sock.bind(port);
  return { close: () => { try { sock.close(); } catch {} }, port };
}
