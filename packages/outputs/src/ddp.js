// DDP (Distributed Display Protocol) output, the format WLED streams pixels over.
// Constants match WLED's wled00/src/dependencies/e131/ESPAsyncE131.h.
import dgram from "node:dgram";

export const DDP_PORT = 4048;
export const DDP_FLAGS_VER1 = 0x40;
export const DDP_FLAGS_PUSH = 0x01;
export const DDP_TYPE_RGB24 = 0x0b;
export const DDP_ID_DISPLAY = 1;
export const DDP_MAX_DATA = 1440; // 480 RGB pixels per packet

/**
 * Split one frame of RGB bytes into DDP packets. The last packet carries the PUSH flag,
 * which tells WLED to show the frame.
 * @param {Uint8Array} rgb  R,G,B,R,G,B... for every LED on the controller
 * @param {number} seq      sequence number (only the low 4 bits are sent)
 * @returns {Buffer[]}
 */
export function ddpPackets(rgb, seq = 0) {
  const packets = [];
  for (let off = 0; off < rgb.length || off === 0; off += DDP_MAX_DATA) {
    const len = Math.min(DDP_MAX_DATA, rgb.length - off), last = off + len >= rgb.length;
    const p = Buffer.alloc(10 + len);
    p[0] = DDP_FLAGS_VER1 | (last ? DDP_FLAGS_PUSH : 0);
    p[1] = seq & 0x0f;
    p[2] = DDP_TYPE_RGB24;
    p[3] = DDP_ID_DISPLAY;
    p.writeUInt32BE(off, 4);   // byte offset of this chunk
    p.writeUInt16BE(len, 8);   // data length
    Buffer.from(rgb.buffer, rgb.byteOffset + off, len).copy(p, 10);
    packets.push(p);
    if (rgb.length === 0) break;
  }
  return packets;
}

/** A sender bound to one WLED controller. */
export class DDPSender {
  constructor(host, port = DDP_PORT) { this.host = host; this.port = port; this.seq = 1; this.sent = 0; this.errors = 0; this.sock = dgram.createSocket("udp4"); this.sock.on("error", () => { this.errors++; }); }
  send(rgb) { const seq = this.seq; this.seq = (this.seq % 15) + 1; this.sent++; for (const p of ddpPackets(rgb, seq)) this.sock.send(p, this.port, this.host, e => { if (e) this.errors++; }); }
  close() { try { this.sock.close(); } catch {} }
}
