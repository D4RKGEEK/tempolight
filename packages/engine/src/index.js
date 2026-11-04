// @tempolight/engine: song analysis, room layout and effects. No I/O, no dependencies:
// the same code runs in the browser playground, in tests and on a PC or Raspberry Pi.
export { preAnalyseCore, lastLE } from "./analysis.js";
export { buildLayout, exampleRoom, segmentRanges, outline, samplePath, STAGE_W, STAGE_H } from "./layout.js";
export { createEffects } from "./effects.js";
export { songView, metronomeView, buildSignals, gridAt } from "./signals.js";
export { LiveAnalyser } from "./live.js";
export { memoryEntry, memoryAnalysis, recognise, matchAt, refineByKicks, fingerprint, FingerprintTap } from "./memory.js";
export { createDirector, idleSignals } from "./director.js";
export { planShow, showAt } from "./show.js";
export { ROOM_PRESETS, buildPreset } from "./presets.js";

/** Convert linear effect output (0..~2) to 8-bit RGB with a soft roll-off and a brightness factor. */
export function toRGB8(col, out, brightness = 1) {
  const n = col.length; out = out || new Uint8Array(n);
  for (let i = 0; i < n; i++) { const v = col[i] * brightness; out[i] = v > 0 ? Math.min(255, Math.round(255 * (1 - Math.exp(-1.6 * v)))) : 0; }
  return out;
}
