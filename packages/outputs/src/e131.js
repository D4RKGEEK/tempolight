// E1.31 (sACN) and Art-Net output, for WLED set to those protocols, Falcon/FPP pixel controllers and lighting desks.
// One DMX universe carries 170 RGB pixels (510 channels); a frame is split over as many universes as it needs.
import dgram from "node:dgram";
import crypto from "node:crypto";

export const E131_PORT = 5568, ARTNET_PORT = 6454, PIXELS_PER_UNIVERSE = 170;
const CID = crypto.randomBytes(16);

/** E1.31 data packets for one frame. universe: the first universe number (WLED's default is 1). */
export function e131Packets(rgb, universe = 1, seq = 0, sourceName = "Tempolight", priority = 100) {
  const out = [], per = PIXELS_PER_UNIVERSE * 3;
  for (let off = 0, u = universe; off < rgb.length || off === 0; off += per, u++) {
    const ch = Math.min(per, rgb.length - off), len = 126 + ch, p = Buffer.alloc(len);
    p.writeUInt16BE(0x0010, 0); p.writeUInt16BE(0, 2); p.write("ASC-E1.17\0\0\0", 4, "latin1");      // root layer
    p.writeUInt16BE(0x7000 | (len - 16), 16); p.writeUInt32BE(0x00000004, 18); CID.copy(p, 22);
    p.writeUInt16BE(0x7000 | (len - 38), 38); p.writeUInt32BE(0x00000002, 40);                     // framing layer
    p.write(sourceName.slice(0, 63), 44, "utf8"); p[108] = priority; p.writeUInt16BE(0, 109); p[111] = seq & 255; p[112] = 0; p.writeUInt16BE(u, 113);
    p.writeUInt16BE(0x7000 | (len - 115), 115); p[117] = 0x02; p[118] = 0xa1; p.writeUInt16BE(0, 119); p.writeUInt16BE(1, 121); // DMP layer
    p.writeUInt16BE(ch + 1, 123); p[125] = 0; Buffer.from(rgb.buffer, rgb.byteOffset + off, ch).copy(p, 126);
    out.push(p); if (!rgb.length) break;
  }
  return out;
}

/** Art-Net ArtDmx packets for one frame. universe: the first port-address (WLED's default is 0). */
export function artnetPackets(rgb, universe = 0, seq = 0) {
  const out = [], per = PIXELS_PER_UNIVERSE * 3;
  for (let off = 0, u = universe; off < rgb.length || off === 0; off += per, u++) {
    let ch = Math.min(per, rgb.length - off); const len = ch + (ch & 1); // DMX length must be even
    const p = Buffer.alloc(18 + len);
    p.write("Art-Net\0", 0, "latin1"); p.writeUInt16LE(0x5000, 8); p[10] = 0; p[11] = 14; p[12] = (seq % 255) + 1; p[13] = 0;
    p[14] = u & 0xff; p[15] = (u >> 8) & 0x7f; p.writeUInt16BE(len, 16); Buffer.from(rgb.buffer, rgb.byteOffset + off, ch).copy(p, 18);
    out.push(p); if (!rgb.length) break;
  }
  return out;
}

/** A sender with the same shape as DDPSender: new E131Sender(ip, {protocol, universe, port}).send(rgb) */
export class E131Sender {
  constructor(host, { protocol = "e131", universe, port } = {}) {
    this.host = host; this.protocol = protocol; this.universe = universe ?? (protocol === "artnet" ? 0 : 1);
    this.port = port || (protocol === "artnet" ? ARTNET_PORT : E131_PORT); this.seq = 0; this.sent = 0; this.errors = 0;
    this.sock = dgram.createSocket("udp4"); this.sock.on("error", () => { this.errors++; });
  }
  send(rgb) { const seq = this.seq = (this.seq + 1) & 255; this.sent++;
    for (const p of (this.protocol === "artnet" ? artnetPackets : e131Packets)(rgb, this.universe, seq)) this.sock.send(p, this.port, this.host, e => { if (e) this.errors++; }); }
  close() { try { this.sock.close(); } catch {} }
}
