// Pioneer Pro DJ Link: CDJs and XDJs on the same network announce every beat (UDP port 50001) with the tempo and
// where the beat falls in the bar. Tempolight only listens: it doesn't join the network as a player, so it's safe to
// use at a gig. With DJ Link on, the beat grid comes from the decks (sample-exact, even in breakdowns with no kick).
// Packet layout from Deep Symmetry's "dysentery" notes: beat packets are type 0x28, 0x60 bytes long.
import dgram from "node:dgram";

export const PROLINK_BEAT_PORT = 50001;
export const MIXER = 0x21; // mixers use device number 33; players are 1-6 (rekordbox and others 17-32)
const MAGIC = Buffer.from("Qspt1WmJOL", "ascii");
const isLink = b => b.length >= 0x24 && b.subarray(0, 10).equals(MAGIC);

/** Read a beat packet: {device, name, bpm (after the pitch fader), trackBpm, pitch, beatInBar 1-4 (0: unknown), nextBeatMs} or null. */
export function parseBeat(b) {
  if (!Buffer.isBuffer(b) || b.length < 0x60 || !isLink(b) || b[0x0a] !== 0x28) return null;
  const name = b.toString("ascii", 0x0b, 0x1f).replace(/\0.*$/s, "").trim(), pitchRaw = b.readUIntBE(0x55, 3), trackBpm = b.readUInt16BE(0x5a) / 100;
  if (!(trackBpm > 0) || trackBpm >= 655) return null; // 0xffff: no track loaded
  const pitch = pitchRaw / 0x100000, bpm = Math.round(trackBpm * pitch * 100) / 100;
  if (!(bpm >= 20 && bpm <= 400)) return null; // pitch fader at -100% (or a garbled packet): no usable tempo
  const bib = b[0x5c];
  return { device: b[0x21], name, trackBpm, pitch, bpm, beatInBar: bib >= 1 && bib <= 4 ? bib : 0, nextBeatMs: b.readUInt32BE(0x24) };
}
/** Read the mixer's "channels on air" packet (type 0x03): {device, onAir: {1: true, 2: false, ...}} or null. */
export function parseOnAir(b) {
  if (!Buffer.isBuffer(b) || b.length < 0x28 || !isLink(b) || b[0x0a] !== 0x03) return null;
  const onAir = {}; for (let ch = 1; ch <= 4; ch++) onAir[ch] = b[0x23 + ch] !== 0;
  return { device: b[0x21], onAir };
}
/** Make a beat packet (for tests). */
export function beatPacket({ device = 1, name = "CDJ-3000", bpm = 128, pitch = 1, beatInBar = 1 } = {}) {
  const b = Buffer.alloc(0x60); MAGIC.copy(b); b[0x0a] = 0x28; b.write(name.slice(0, 20), 0x0b, "ascii"); b[0x1f] = 1; b[0x21] = device; b.writeUInt16BE(0x3c, 0x22);
  const ms = pitch > 0 ? Math.round(60000 / (bpm * pitch)) : 0xffffffff; for (let i = 0; i < 6; i++) b.writeUInt32BE(Math.min(0xffffffff, ms * [1, 2, 4, 4, 8, 8][i]), 0x24 + i * 4);
  b.fill(0xff, 0x3c, 0x54); b.writeUIntBE(Math.round(pitch * 0x100000), 0x55, 3); b.writeUInt16BE(Math.round(bpm * 100), 0x5a); b[0x5c] = beatInBar; b[0x5f] = device; return b;
}
/** Make a mixer "channels on air" packet (for tests): onAir is a list of the channels that are up, e.g. [1, 3]. */
export function onAirPacket(onAir = [1]) {
  const b = Buffer.alloc(0x2d); MAGIC.copy(b); b[0x0a] = 0x03; b.write("DJM-900nxs2", 0x0b, "ascii"); b[0x1f] = 1; b[0x21] = MIXER; b.writeUInt16BE(0x11, 0x22);
  for (let ch = 1; ch <= 4; ch++) b[0x23 + ch] = onAir.includes(ch) ? 1 : 0; return b;
}

/** Listen for beats. onBeat({...parseBeat, at: performance.now()}); opts.onAir({device, onAir, at}) for the mixer's
 * on-air channels; opts.onError(message) if the port can't be opened. Which deck leads is decided by runtime.djBeat. */
export function startProLink(onBeat, { port = PROLINK_BEAT_PORT, onAir = null, onError = null } = {}) {
  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  sock.on("error", e => { onError?.(e.code === "EADDRINUSE" ? `UDP port ${port} is in use by another app (rekordbox or another DJ Link tool?) that doesn't share it` : e.message); try { sock.close(); } catch {} });
  sock.on("message", buf => { const at = performance.now(), b = parseBeat(buf); if (b) return onBeat({ ...b, at }); const a = onAir && parseOnAir(buf); if (a) onAir({ ...a, at }); });
  sock.bind(port);
  return { close() { try { sock.close(); } catch {} } };
}
