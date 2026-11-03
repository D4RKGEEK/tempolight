// WLED audio sync ("V2" packet, 44 bytes). Sending this lets WLED's own audio-reactive effects run on the
// controller with almost no Wi-Fi traffic. Layout matches usermods/audioreactive/audio_reactive.cpp (audioSyncPacket).
import dgram from "node:dgram";

export const AUDIOSYNC_PORT = 11988;
export const AUDIOSYNC_GROUP = "239.0.0.1";

/**
 * @param {{sampleRaw:number, sampleSmth:number, peak:boolean, fft:ArrayLike<number>, magnitude:number, majorPeak:number}} a
 *   fft: 16 bands, 0..255. majorPeak: loudest frequency in Hz.
 */
export function audioSyncPacket(a) {
  const p = Buffer.alloc(44);
  p.write("00002", 0, "ascii");          // header, 6 bytes incl. terminating zero
  p.writeFloatLE(a.sampleRaw, 8);
  p.writeFloatLE(a.sampleSmth, 12);
  p[16] = a.peak ? 1 : 0;
  for (let i = 0; i < 16; i++) p[18 + i] = Math.max(0, Math.min(255, Math.round(a.fft[i] || 0)));
  p.writeFloatLE(a.magnitude, 36);
  p.writeFloatLE(a.majorPeak, 40);
  return p;
}

export class AudioSyncSender {
  constructor(group = AUDIOSYNC_GROUP, port = AUDIOSYNC_PORT) { this.group = group; this.port = port; this.sock = dgram.createSocket({ type: "udp4", reuseAddr: true }); this.sock.on("error", () => {}); }
  send(a) { this.sock.send(audioSyncPacket(a), this.port, this.group, () => {}); }
  close() { try { this.sock.close(); } catch {} }
}
