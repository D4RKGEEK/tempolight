// Pioneer Pro DJ Link: CDJs and XDJs on the same network announce every beat (UDP port 50001) with the tempo and
// where the beat falls in the bar. Tempolight only listens: it doesn't join the network as a player, so it's safe to
// use at a gig. With DJ Link on, the beat grid comes from the decks (sample-exact, even in breakdowns with no kick).
import dgram from "node:dgram";

export const PROLINK_BEAT_PORT = 50001;
const MAGIC = Buffer.from("Qspt1WmJOL", "ascii");

/** Read a beat packet: {device, name, bpm (after the pitch fader), trackBpm, pitch, beatInBar 1-4, nextBeatMs} or null. */
export function parseBeat(b) {
  if (b.length < 0x60 || !b.subarray(0, 10).equals(MAGIC) || b[0x0a] !== 0x28) return null;
  const name = b.toString("ascii", 0x0b, 0x1f).replace(/\0+$/, "").trim(), pitchRaw = b.readUIntBE(0x55, 3), trackBpm = b.readUInt16BE(0x5a) / 100;
  if (!(trackBpm > 0) || trackBpm >= 655) return null; // 0xffff: no track loaded
  const pitch = pitchRaw / 0x100000;
  return { device: b[0x21], name, trackBpm, pitch, bpm: Math.round(trackBpm * pitch * 100) / 100, beatInBar: b[0x5c], nextBeatMs: b.readUInt32BE(0x24) };
}
/** Make a beat packet (for tests and the fake deck in scripts/). */
export function beatPacket({ device = 1, name = "CDJ-3000", bpm = 128, pitch = 1, beatInBar = 1 } = {}) {
  const b = Buffer.alloc(0x60); MAGIC.copy(b); b[0x0a] = 0x28; b.write(name.slice(0, 20), 0x0b, "ascii"); b[0x1f] = 1; b[0x21] = device; b.writeUInt16BE(0x3c, 0x22);
  const ms = Math.round(60000 / (bpm * pitch)); for (let i = 0; i < 6; i++) b.writeUInt32BE(ms * [1, 2, 4, 4, 8, 8][i], 0x24 + i * 4);
  b.writeUIntBE(Math.round(pitch * 0x100000), 0x55, 3); b.writeUInt16BE(Math.round(bpm * 100), 0x5a); b[0x5c] = beatInBar; b[0x5d] = device; return b;
}

/** Listen for beats. onBeat({...parseBeat, at: performance.now()}). The loudest-playing deck isn't known from beats
 * alone, so the deck that sent the most recent beat leads (on a mixer handover the new deck takes over within a beat). */
export function startProLink(onBeat, { port = PROLINK_BEAT_PORT } = {}) {
  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  sock.on("error", () => {});
  sock.on("message", buf => { const b = parseBeat(buf); if (b) onBeat({ ...b, at: performance.now() }); });
  sock.bind(port);
  return { close() { try { sock.close(); } catch {} } };
}
