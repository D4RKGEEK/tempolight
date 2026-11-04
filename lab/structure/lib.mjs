import fs from "node:fs";
export const E = "/home/claude/tempolight/packages/engine/src/index.js";
export const S = "/tmp/claude-0/-home-claude/c3bcbc7c-bc36-559e-b8f4-26c406586551/scratchpad/structure";
export function readWav(p) { const b = fs.readFileSync(p); let o = 12, ch = 2, sr = 44100, data;
  while (o < b.length) { const id = b.toString("ascii", o, o + 4), n = b.readUInt32LE(o + 4); if (id === "fmt ") { ch = b.readUInt16LE(o + 10); sr = b.readUInt32LE(o + 12); } if (id === "data") data = b.subarray(o + 8, o + 8 + n); o += 8 + n; }
  const N = data.length / 2 / ch, x = new Float32Array(Math.floor(N / 2));
  for (let i = 0; i < x.length; i++) { let s = 0; for (let k = 0; k < 2; k++) for (let c = 0; c < ch; c++) s += data.readInt16LE(((2 * i + k) * ch + c) * 2) / 32768; x[i] = s / (2 * ch); }
  return { x, sr: sr / 2 }; }
export function readF32(p, sr = 44100) { const b = fs.readFileSync(p), f = new Float32Array(b.buffer, b.byteOffset, b.length / 4), x = new Float32Array(Math.floor(f.length / 2)); for (let i = 0; i < x.length; i++) x[i] = (f[2 * i] + f[2 * i + 1]) / 2; return { x, sr: sr / 2 }; }
