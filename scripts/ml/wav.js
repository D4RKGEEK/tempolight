// A minimal WAV reader (16-bit PCM or float, any channel count, mixed to mono) for the ML scripts.
import { readFileSync } from "node:fs";
export function readWav(file) {
  const b = readFileSync(file); let o = 12, fmt = 0, data = null;
  while (o + 8 <= b.length) { const id = b.toString("ascii", o, o + 4), len = b.readUInt32LE(o + 4); if (id === "fmt ") fmt = o + 8; if (id === "data") { data = { o: o + 8, len: Math.min(len, b.length - o - 8) }; break; } o += 8 + len + (len & 1); }
  const format = b.readUInt16LE(fmt), ch = b.readUInt16LE(fmt + 2), sr = b.readUInt32LE(fmt + 4), bits = b.readUInt16LE(fmt + 14), bps = bits / 8, n = Math.floor(data.len / bps / ch), x = new Float32Array(n);
  const rd = format === 3 ? p => b.readFloatLE(p) : p => b.readInt16LE(p) / 32768;
  for (let i = 0; i < n; i++) { let v = 0; for (let c = 0; c < ch; c++) v += rd(data.o + (i * ch + c) * bps); x[i] = v / ch; }
  return { x, sr };
}
